import type { UsageRecord } from "../collectors/agy-hook.js";
import type { TranscriptStructuralMeta } from "../collectors/transcript-meta.js";

export interface SavingRecommendation {
  id: string;
  severity: "high" | "medium" | "low";
  category:
    | "long_session_snowball"
    | "heavy_model_mismatch"
    | "thinking_downgrade"
    | "infinite_loop_warning";
  title: string;
  evidence: string;
  action: string;
  estimated_savings_pct: string;
}

export interface SavingRecommendationsReport {
  window: "24h" | "7d";
  analyzed_records: number;
  recommendations: SavingRecommendation[];
  healthy: boolean;
  note?: string;
}

const HEAVY_MODEL_RE = /(neon|carbon|pro|ultra|opus)/i;

export function analyzeAntipatterns(
  records: UsageRecord[],
  options?: {
    window?: "24h" | "7d";
    transcriptMeta?: TranscriptStructuralMeta | null;
    nowMs?: number;
  },
): SavingRecommendationsReport {
  const window = options?.window ?? "24h";
  const nowMs = options?.nowMs ?? Date.now();
  const cutoffMs = nowMs - (window === "24h" ? 86400_000 : 7 * 86400_000);
  const filtered = records.filter((r) => {
    const ts = Date.parse(r.ts);
    return !Number.isNaN(ts) && ts >= cutoffMs;
  });

  const recs: SavingRecommendation[] = [];

  // 1. Long-session snowball detection
  const longSessions = new Map<
    string,
    { maxTurn: number; maxCtxPct: number; totalInput: number; turns: number }
  >();
  for (const r of filtered) {
    const cur = longSessions.get(r.session_hash) ?? {
      maxTurn: 0,
      maxCtxPct: 0,
      totalInput: 0,
      turns: 0,
    };
    cur.maxTurn = Math.max(cur.maxTurn, r.turn_index);
    cur.maxCtxPct = Math.max(cur.maxCtxPct, r.context_used_pct ?? 0);
    cur.totalInput += r.input_tokens;
    cur.turns += 1;
    longSessions.set(r.session_hash, cur);
  }

  const snowballSessions = [...longSessions.values()].filter(
    (s) =>
      s.maxTurn >= 20 ||
      s.maxCtxPct >= 70 ||
      (s.turns >= 25 && (s.maxTurn > 0 || s.maxCtxPct > 0)),
  );
  const transcriptUncompacted =
    options?.transcriptMeta &&
    options.transcriptMeta.steps_since_last_compact >= 30;

  if (snowballSessions.length > 0 || transcriptUncompacted) {
    const peakCtx = Math.max(0, ...snowballSessions.map((s) => s.maxCtxPct));
    const peakTurn = Math.max(0, ...snowballSessions.map((s) => s.maxTurn));
    recs.push({
      id: "long_session_snowball",
      severity: "high",
      category: "long_session_snowball",
      title: "Long-session context snowball detected",
      evidence:
        snowballSessions.length > 0
          ? `${snowballSessions.length} session(s) reached turn ${peakTurn} / ${peakCtx}% context utilization without compacting.`
          : `Transcript has ${options?.transcriptMeta?.steps_since_last_compact} steps since last /compact.`,
      action:
        "Run `/compact` (or `/compress`) every 12–15 turns or start a fresh thread per subtask. Uncompacted histories re-bill growing prefixes every turn.",
      estimated_savings_pct: "35–60%",
    });
  }

  // 2. Heavy model mismatch (using Neon/Pro/Carbon for tiny low-complexity turns)
  const heavyTurns = filtered.filter((r) => HEAVY_MODEL_RE.test(r.model));
  const lightweightOnHeavy = heavyTurns.filter(
    (r) => r.output_tokens > 0 && r.output_tokens < 350 && r.tool_calls <= 1,
  );
  if (heavyTurns.length >= 4 && lightweightOnHeavy.length / heavyTurns.length >= 0.45) {
    const pct = Math.round((lightweightOnHeavy.length / heavyTurns.length) * 100);
    recs.push({
      id: "heavy_model_mismatch",
      severity: "high",
      category: "heavy_model_mismatch",
      title: "Heavy flagship model used for lightweight turns",
      evidence: `${lightweightOnHeavy.length}/${heavyTurns.length} (${pct}%) heavy-model turns produced <350 output tokens with <=1 tool call.`,
      action:
        "Adopt an Orchestrator workflow: use Gemini 4 Neon for architecture/planning, then route routine edits, tests, and greps to Gemini 4 Hydrogen or Gemini 3.8 Flash.",
      estimated_savings_pct: "50–75%",
    });
  }

  // 3. Thinking downgrade opportunity (high output ratio on heavy models)
  const totalHeavyInput = heavyTurns.reduce((s, r) => s + r.input_tokens, 0);
  const totalHeavyOutput = heavyTurns.reduce((s, r) => s + r.output_tokens, 0);
  if (
    heavyTurns.length >= 3 &&
    totalHeavyOutput > 15_000 &&
    (totalHeavyInput === 0 || totalHeavyOutput / Math.max(1, totalHeavyInput) >= 0.15)
  ) {
    recs.push({
      id: "thinking_downgrade",
      severity: "medium",
      category: "thinking_downgrade",
      title: "High Thinking/output token burn on flagship models",
      evidence: `${totalHeavyOutput.toLocaleString()} output/thinking tokens on heavy models (billed at 4x–8x input rate in shared 5h/7d buckets).`,
      action:
        "Lower Thinking level (e.g. Medium/Low) for boilerplate coding & log parsing, reserving High Thinking strictly for multi-file debugging or architecture.",
      estimated_savings_pct: "25–45%",
    });
  }

  // 4. Agent infinite loop warning (from pure structural transcript metadata)
  if (options?.transcriptMeta?.loop_detected) {
    const tool = options.transcriptMeta.consecutive_failure_tool_type ?? "tool";
    const streak = options.transcriptMeta.max_consecutive_tool_failures;
    recs.push({
      id: "infinite_loop_warning",
      severity: "high",
      category: "infinite_loop_warning",
      title: `Autonomous failure loop detected (${streak} consecutive "${tool}" errors)`,
      evidence: `Transcript recorded ${streak} consecutive failures on "${tool}" (${options.transcriptMeta.tool_error_count} total tool errors).`,
      action:
        "Stop the agent immediately, inspect the failing command manually, fix the root cause or environment, and resume with a concise summary.",
      estimated_savings_pct: "40–80% on runaway turns",
    });
  }

  const hasTelemetry = filtered.some(
    (r) =>
      r.input_tokens > 0 ||
      r.output_tokens > 0 ||
      r.turn_index > 0 ||
      (r.context_used_pct !== null && r.context_used_pct > 0),
  );
  const note =
    filtered.length > 0 && !hasTelemetry && !options?.transcriptMeta
      ? "Local hook events lack token, turn, and context telemetry. Antipattern recommendations require token/turn telemetry (e.g. Gemini CLI OTel) or a local transcript_path."
      : undefined;

  return {
    window,
    analyzed_records: filtered.length,
    recommendations: recs,
    healthy: recs.length === 0,
    ...(note ? { note } : {}),
  };
}
