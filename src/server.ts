import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readUsageRecords, type UsageRecord } from "./collectors/agy-hook.js";
import { readGeminiOtelRecords } from "./collectors/gemini-otel.js";
import {
  analyzeTranscriptStructure,
  scanTranscriptActivity,
  type TranscriptActivityFallback,
} from "./collectors/transcript-meta.js";
import { analyzeTokenWindow, resolveDataMode } from "./analyzers/token-window.js";
import { analyzeAntipatterns } from "./analyzers/antipatterns.js";
import { diagnoseError } from "./analyzers/error-diagnoser.js";
import { computeResetCountdown } from "./analyzers/countdown.js";
import { SnapshotClient } from "./remote/snapshot-client.js";

export interface ServerDependencies {
  snapshotClient?: SnapshotClient;
  usageLogPath?: string;
  geminiOtelPath?: string;
  brainDir?: string;
}

async function loadCombinedLocalRecords(
  deps: ServerDependencies,
  sinceMs?: number,
): Promise<UsageRecord[]> {
  const [agyRecords, otelRecords] = await Promise.all([
    readUsageRecords({ logPath: deps.usageLogPath, sinceMs }),
    readGeminiOtelRecords({ otelPath: deps.geminiOtelPath, sinceMs }),
  ]);
  return [...agyRecords, ...otelRecords];
}

function buildActivitySummary(
  fallback: TranscriptActivityFallback,
  windowLabel: "5h" | "7d",
): string | undefined {
  const stats = windowLabel === "5h" ? fallback.window_5h : fallback.window_7d;
  if (stats.session_count === 0 && stats.turn_count === 0) {
    return undefined;
  }
  const resetPart = fallback.window_5h.estimated_5h_reset_local
    ? `; estimated 5h rolling reset at ${fallback.window_5h.estimated_5h_reset_local}`
    : "";
  return `${stats.session_count} active AGY session(s) (${stats.turn_count.toLocaleString()} turns) in last ${windowLabel} window${resetPart} (exact token counts require running agycraft-mcp setup).`;
}

export function createAgycraftServer(deps: ServerDependencies = {}): McpServer {
  const client = deps.snapshotClient ?? new SnapshotClient();

  const server = new McpServer({
    name: "agycraft-mcp",
    version: "0.1.0",
  });

  // 1. analyze_token_usage
  server.tool(
    "analyze_token_usage",
    "Analyze local 5h/24h/7d token usage, shared-bucket exhaustion risk, Thinking output cost share, and <4,096 implicit KV cache threshold. 100% local numeric metadata only.",
    {
      window: z.enum(["5h", "24h", "7d"]).default("5h"),
      product: z.enum(["agy", "gemini-cli", "all"]).default("all"),
    },
    async ({ window, product }) => {
      const [records, modelsSnap] = await Promise.all([
        loadCombinedLocalRecords(deps),
        client.get("models"),
      ]);

      const analysis = analyzeTokenWindow(records, {
        window,
        product,
        models: modelsSnap.data.models,
      });

      const transcriptFallback =
        analysis.record_count === 0
          ? await scanTranscriptActivity({ brainDir: deps.brainDir })
          : undefined;

      const summaryWindow = window === "5h" ? "5h" : "7d";
      const activitySummary = transcriptFallback
        ? buildActivitySummary(transcriptFallback, summaryWindow)
        : undefined;
      const effectiveSessionCount =
        analysis.record_count > 0
          ? analysis.session_count
          : summaryWindow === "5h"
            ? (transcriptFallback?.window_5h.session_count ?? 0)
            : (transcriptFallback?.window_7d.session_count ?? 0);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...(activitySummary ? { activity_summary: activitySummary } : {}),
                ...analysis,
                session_count: effectiveSessionCount,
                ...(transcriptFallback
                  ? { transcript_activity_fallback: transcriptFallback }
                  : {}),
                models_snapshot_source: modelsSnap.source,
                privacy_note: "100% local numeric aggregation; zero user data uploaded.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 2. get_saving_recommendations
  server.tool(
    "get_saving_recommendations",
    "Detect quota-burning antipatterns (long-session snowball, heavy model mismatch, Thinking downgrade opportunity, <4,096 cache misses, and autonomous failure loops) from local numeric usage and optional structural transcript metadata.",
    {
      window: z.enum(["24h", "7d"]).default("24h"),
      transcript_path: z
        .string()
        .optional()
        .describe("Optional local transcript.jsonl path for structural step/loop counting only (never reads prompt/content)."),
    },
    async ({ window, transcript_path }) => {
      const [records, transcriptMeta] = await Promise.all([
        loadCombinedLocalRecords(deps),
        transcript_path ? analyzeTranscriptStructure(transcript_path) : Promise.resolve(null),
      ]);

      const report = analyzeAntipatterns(records, {
        window,
        transcriptMeta,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...report,
                transcript_structure: transcriptMeta,
                more_tips_url: "https://modelcraft.dev/quotas",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 3. diagnose_error
  server.tool(
    "diagnose_error",
    "Diagnose AGY / Gemini CLI / API errors across 5 fault domains (quota, auth, capacity, mcp, network) plus Structured Output & Function Calling protocol issues. Cross-references local usage & upstream status to provide root cause, copyable fix commands, verify command, don't-dos, and a modelcraft.dev Deep Link.",
    {
      error_text: z.string().min(1).describe("Raw error message or JSON snippet."),
      product: z.enum(["agy", "cli", "api", "web"]).optional(),
      doctor_summary: z.string().optional(),
    },
    async ({ error_text, product }) => {
      const [records, statusSnap, diagnosisSnap] = await Promise.all([
        loadCombinedLocalRecords(deps),
        client.get("status"),
        client.get("diagnosis"),
      ]);

      const result = diagnoseError({
        errorText: error_text,
        product,
        localRecords: records,
        statusSnapshot: statusSnap.data,
        diagnosisEntries: diagnosisSnap.data.entries,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...result,
                data_sources: {
                  status: statusSnap.source,
                  diagnosis: diagnosisSnap.source,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 4. lookup_model_guide
  server.tool(
    "lookup_model_guide",
    "Recommend the right Gemini / Antigravity model or Orchestrator pairing for a task, check deprecation status & shared-bucket cost tier, and optionally inspect official before->after chronicle history.",
    {
      task: z.string().optional().describe("Task description (e.g. 'architecture', 'multi-file refactor', 'quick qa', 'batch')."),
      model_id: z.string().optional().describe("Specific model id, api_model_id, or codename (e.g. 'neon', 'hydrogen', 'argon', 'gemini-3.8-flash')."),
      provider: z.enum(["google", "antigravity", "all"]).default("all"),
      include_history: z.boolean().default(false),
    },
    async ({ task, model_id, provider, include_history }) => {
      const [modelsSnap, chronicleSnap] = await Promise.all([
        client.get("models"),
        include_history ? client.get("chronicle") : Promise.resolve(null),
      ]);

      let models = modelsSnap.data.models;
      if (provider !== "all") {
        models = models.filter((m) => m.provider === provider);
      }

      let matched = models;
      if (model_id) {
        const needle = model_id.toLowerCase();
        matched = models.filter(
          (m) =>
            m.id.toLowerCase().includes(needle) ||
            m.api_model_id.toLowerCase().includes(needle) ||
            m.display_name.toLowerCase().includes(needle) ||
            (m.codename && m.codename.toLowerCase().includes(needle)),
        );
      } else if (task) {
        const needle = task.toLowerCase();
        const scored = models
          .filter((m) => m.lifecycle !== "deprecated" && m.lifecycle !== "removed")
          .map((m) => {
            let score = 0;
            if (m.best_for.some((b) => b.toLowerCase().includes(needle) || needle.includes(b.toLowerCase()))) {
              score += 3;
            }
            if (m.summary.toLowerCase().includes(needle)) {
              score += 2;
            }
            if (needle.includes("plan") || needle.includes("architect") || needle.includes("debug")) {
              if (m.specs.reasoning_tier === "flagship" || m.id.includes("neon")) score += 4;
            }
            if (needle.includes("fast") || needle.includes("cheap") || needle.includes("edit") || needle.includes("test") || needle.includes("refactor")) {
              if (m.quota_profile.shared_bucket_cost_tier === "low" || m.id.includes("hydrogen") || m.id.includes("flash")) score += 4;
            }
            if (needle.includes("batch") || needle.includes("bulk") || needle.includes("high-volume")) {
              if (m.id.includes("flash-lite") || m.id.includes("flash")) score += 4;
            }
            return { model: m, score };
          })
          .sort((a, b) => b.score - a.score);
        matched = scored.slice(0, 3).map((s) => s.model);
      }

      const history =
        include_history && chronicleSnap
          ? chronicleSnap.data.entries.filter((e) => {
              if (!model_id) return true;
              const needle = model_id.toLowerCase();
              return (
                e.entity_ids.some((id) => id.toLowerCase().includes(needle)) ||
                e.title.toLowerCase().includes(needle)
              );
            })
          : undefined;

      const deprecationWarnings = matched
        .filter((m) => m.lifecycle === "deprecated" || m.lifecycle === "removed")
        .map((m) => ({
          model: m.id,
          lifecycle: m.lifecycle,
          deprecated_date: m.deprecated_date,
          replacement_model_id: m.replacement_model_id,
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                models: matched,
                orchestrator_recipes: modelsSnap.data.orchestrator_recipes,
                deprecation_warnings: deprecationWarnings,
                chronicle_history: history,
                guide_url: "https://modelcraft.dev/models",
                official_source_urls: [
                  ...new Set(matched.flatMap((m) => m.official_source_urls ?? [])),
                ],
                snapshot_source: modelsSnap.source,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 5. get_ecosystem_status
  server.tool(
    "get_ecosystem_status",
    "Get live Gemini & Antigravity upstream status, latest CLI/SDK versions, recent official updates, quota rules, and local PT midnight + 5h/7d rolling reset countdowns.",
    {
      plan: z.enum(["free", "pro", "ultra"]).optional(),
      product: z.enum(["agy", "cli", "api", "web"]).optional(),
      timezone: z.string().optional().describe("IANA timezone (e.g. 'Asia/Shanghai', 'America/Los_Angeles')."),
    },
    async ({ plan, product, timezone }) => {
      const nowMs = Date.now();
      const [records, statusSnap, quotasSnap, updatesSnap] = await Promise.all([
        loadCombinedLocalRecords(deps, nowMs - 7 * 86400 * 1000),
        client.get("status"),
        client.get("quotas"),
        client.get("updates"),
      ]);

      const fiveHoursAgo = nowMs - 5 * 3600 * 1000;
      const in5h = records
        .map((r) => Date.parse(r.ts))
        .filter((t) => !Number.isNaN(t) && t >= fiveHoursAgo);
      const in7d = records
        .map((r) => Date.parse(r.ts))
        .filter((t) => !Number.isNaN(t));

      const transcriptFallback =
        records.length === 0
          ? await scanTranscriptActivity({
              brainDir: deps.brainDir,
              nowMs,
              timezone,
            })
          : undefined;

      const countdown = computeResetCountdown({
        now: new Date(nowMs),
        timezone,
        oldestEventIn5hMs:
          in5h.length > 0
            ? Math.min(...in5h)
            : transcriptFallback?.earliest_turn_5h_ms ?? null,
        oldestEventIn7dMs:
          in7d.length > 0
            ? Math.min(...in7d)
            : transcriptFallback?.earliest_turn_7d_ms ?? null,
      });

      const filteredPlans = plan
        ? quotasSnap.data.plans.filter(
            (p) =>
              p.id.toLowerCase().includes(plan) ||
              p.name.toLowerCase().includes(plan),
          )
        : quotasSnap.data.plans;

      const filteredUpdates = product
        ? updatesSnap.data.items.filter(
            (u) => u.product === product || u.product === "all",
          )
        : updatesSnap.data.items;

      const statusActivitySummary = transcriptFallback
        ? buildActivitySummary(transcriptFallback, "5h")
        : undefined;

      const totalTokens7d = records.reduce(
        (sum, r) => sum + r.input_tokens + r.output_tokens,
        0,
      );
      const statusDataMode = resolveDataMode(records.length, totalTokens7d);
      const statusUsageNote =
        statusDataMode === "hook_events_without_tokens"
          ? `Local hook events (${records.length} record(s)) were recorded without token or model fields. Refer to the official AGY/CLI quota UI for authoritative remaining %, or enable Gemini CLI OTel for exact local token counts.`
          : undefined;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...(statusActivitySummary
                  ? { activity_summary: statusActivitySummary }
                  : {}),
                data_mode: statusDataMode,
                ...(statusUsageNote ? { usage_note: statusUsageNote } : {}),
                session_count:
                  records.length > 0
                    ? new Set(records.map((r) => r.session_hash)).size
                    : (transcriptFallback?.window_5h.session_count ?? 0),
                overall_status: statusSnap.data.overall_status,
                surfaces: statusSnap.data.surfaces,
                active_incidents: statusSnap.data.active_incidents,
                latest_versions: statusSnap.data.latest_versions,
                countdown,
                ...(transcriptFallback
                  ? { transcript_activity_fallback: transcriptFallback }
                  : {}),
                quota_rules: quotasSnap.data.reset_rules,
                plans: filteredPlans,
                recent_updates: filteredUpdates.slice(0, 8),
                dashboard_url: "https://modelcraft.dev",
                official_source_urls: quotasSnap.data.official_source_urls ?? [],
                snapshot_sources: {
                  status: statusSnap.source,
                  quotas: quotasSnap.source,
                  updates: updatesSnap.source,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}

export async function startStdioServer(deps: ServerDependencies = {}): Promise<void> {
  const server = createAgycraftServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
