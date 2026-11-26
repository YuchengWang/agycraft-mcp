import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { UsageRecord } from "../src/collectors/agy-hook.js";
import type { DiagnosisSnapshot } from "../src/types.js";
import { analyzeTokenWindow } from "../src/analyzers/token-window.js";
import { analyzeAntipatterns } from "../src/analyzers/antipatterns.js";
import { diagnoseError } from "../src/analyzers/error-diagnoser.js";
import { computeResetCountdown } from "../src/analyzers/countdown.js";

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    v: 1,
    ts: "2026-11-26T02:00:00.000Z",
    provider: "antigravity",
    product: "agy",
    session_hash: "a1b2c3d4e5f6",
    model: "gemini-4-neon",
    input_tokens: 10000,
    output_tokens: 2000,
    context_used_pct: 30,
    tool_calls: 1,
    turn_index: 5,
    error_code: null,
    ...overrides,
  };
}

describe("Analyzers", () => {
  const nowMs = Date.parse("2026-11-26T03:00:00.000Z");

  it("computes 5h token window stats, Thinking output cost share, and <4,096 cache threshold", () => {
    const records: UsageRecord[] = [
      makeRecord({ input_tokens: 2000, output_tokens: 3000, model: "gemini-4-neon" }),
      makeRecord({ input_tokens: 3000, output_tokens: 2500, model: "gemini-4-neon" }),
      makeRecord({ input_tokens: 10000, output_tokens: 500, model: "gemini-4-hydrogen" }),
    ];

    const res = analyzeTokenWindow(records, { window: "5h", nowMs });
    expect(res.data_mode).toBe("exact_token_logs");
    expect(res.usage_note).toBeUndefined();
    expect(res.record_count).toBe(3);
    expect(res.total_input_tokens).toBe(15000);
    expect(res.total_output_tokens).toBe(6000);
    expect(res.implicit_cache_check.turns_below_threshold).toBe(2);
    expect(res.implicit_cache_check.turns_above_threshold).toBe(1);
    expect(res.implicit_cache_check.multi_turn_new_tokens_min).toBe(2050);
    expect(res.implicit_cache_check.official_source_url).toBe("https://aistudio.google.com/docs/caching");
    expect(res.thinking_cost_estimate.output_cost_share_pct).toBeGreaterThan(50);
  });

  it("reports hook_events_without_tokens and non-misleading guidance when records lack token counts", () => {
    const records: UsageRecord[] = [
      makeRecord({ model: "unknown", input_tokens: 0, output_tokens: 0 }),
      makeRecord({ model: "unknown", input_tokens: 0, output_tokens: 0 }),
    ];

    const res = analyzeTokenWindow(records, { window: "5h", nowMs });
    expect(res.record_count).toBe(2);
    expect(res.total_tokens).toBe(0);
    expect(res.data_mode).toBe("hook_events_without_tokens");
    expect(res.usage_note).toContain("without token or model fields");
    expect(res.implicit_cache_check.guidance).toContain("without token/model fields");
    expect(res.implicit_cache_check.guidance).not.toContain("No local usage records");
  });

  it("detects snowball, heavy model mismatch, Thinking downgrade, cache miss, and infinite loop", () => {
    const records: UsageRecord[] = Array.from({ length: 6 }, (_, i) =>
      makeRecord({
        ts: new Date(nowMs - i * 60_000).toISOString(),
        model: "gemini-4-neon",
        input_tokens: 2500,
        output_tokens: 200,
        tool_calls: 1,
        turn_index: 22 + i,
        context_used_pct: 78,
      }),
    );

    const report = analyzeAntipatterns(records, {
      window: "24h",
      nowMs,
      transcriptMeta: {
        total_steps: 40,
        user_turns: 3,
        assistant_turns: 15,
        tool_call_count: 18,
        tool_error_count: 6,
        max_consecutive_tool_failures: 5,
        consecutive_failure_tool_type: "run_command",
        has_compact_event: false,
        steps_since_last_compact: 40,
        loop_detected: true,
      },
    });

    const categories = report.recommendations.map((r) => r.category);
    expect(categories).toContain("long_session_snowball");
    expect(categories).toContain("heavy_model_mismatch");
    expect(categories).toContain("implicit_cache_miss");
    expect(categories).toContain("infinite_loop_warning");
    expect(report.healthy).toBe(false);
  });

  it("does not emit long_session_snowball for hook events lacking turn/context/token telemetry", () => {
    const records: UsageRecord[] = Array.from({ length: 30 }, (_, i) =>
      makeRecord({
        ts: new Date(nowMs - i * 60_000).toISOString(),
        model: "unknown",
        input_tokens: 0,
        output_tokens: 0,
        turn_index: 0,
        context_used_pct: null,
      }),
    );

    const report = analyzeAntipatterns(records, { window: "24h", nowMs });
    expect(report.analyzed_records).toBe(30);
    expect(report.recommendations.map((r) => r.category)).not.toContain(
      "long_session_snowball",
    );
    expect(report.healthy).toBe(true);
    expect(report.note).toContain("transcript_path");
  });

  it("diagnoses all 5 fault domains plus Structured Output and Function Calling", () => {
    const cases = [
      { text: "HTTP 429 RESOURCE_EXHAUSTED limit: 0", expectedDomain: "quota" },
      { text: "403 Permission Denied ACCESS_TOKEN_TYPE_UNSUPPORTED", expectedDomain: "auth" },
      { text: "503 No capacity DEADLINE_EXCEEDED", expectedDomain: "capacity" },
      { text: "MCP Disconnected EADDRINUSE httpUrl mismatch", expectedDomain: "mcp" },
      { text: "Error: UNABLE_TO_GET_ISSUER_CERT_LOCALLY", expectedDomain: "network" },
      { text: "INVALID_ARGUMENT: response_schema nesting depth too many states", expectedDomain: "protocol" },
      { text: "INVALID_ARGUMENT: missing thought_signature on function_call", expectedDomain: "protocol" },
    ];

    for (const c of cases) {
      const res = diagnoseError({ errorText: c.text, nowMs });
      expect(res.matched).toBe(true);
      expect(res.domain).toBe(c.expectedDomain);
      expect(res.commands.length).toBeGreaterThan(0);
      expect(res.verify_command.length).toBeGreaterThan(0);
      expect(res.dont_dos.length).toBeGreaterThan(0);
      expect(res.deep_link).toMatch(/^https:\/\/modelcraft\.dev\/fix\//);
    }
  });

  it("matches all 8 diagnosis.json rules without priority collisions plus unknown fallback", () => {
    const diagSnap = JSON.parse(
      readFileSync(join(process.cwd(), "snapshots/diagnosis.json"), "utf8"),
    ) as DiagnosisSnapshot;

    const matrix = [
      { text: "HTTP 429 RESOURCE_EXHAUSTED limit: 0", expectedId: "google-429-desync" },
      { text: "weekly cap reached quotaMetric exhausted", expectedId: "google-weekly-cap" },
      { text: "403 Permission Denied ACCESS_TOKEN_TYPE_UNSUPPORTED", expectedId: "google-403-auth-mismatch" },
      { text: "503 No capacity DEADLINE_EXCEEDED", expectedId: "google-503-504-stall" },
      { text: "MCP Disconnected EADDRINUSE httpUrl mismatch", expectedId: "agy-mcp-disconnected" },
      { text: "Error: UNABLE_TO_GET_ISSUER_CERT_LOCALLY", expectedId: "agy-ssl-proxy" },
      { text: "INVALID_ARGUMENT: response_schema nesting depth too many states", expectedId: "google-structured-output-schema" },
      { text: "function_call thought_signature missing INVALID_ARGUMENT", expectedId: "google-function-calling-state" },
    ];

    for (const c of matrix) {
      const res = diagnoseError({
        errorText: c.text,
        diagnosisEntries: diagSnap.entries,
        nowMs,
      });
      expect(res.matched).toBe(true);
      expect(res.diagnosis_id).toBe(c.expectedId);
    }

    const unknown = diagnoseError({
      errorText: "completely unrecognized custom error xyz123",
      diagnosisEntries: diagSnap.entries,
      nowMs,
    });
    expect(unknown.matched).toBe(false);
    expect(unknown.diagnosis_id).toBe("unclassified");
    expect(unknown.domain).toBe("unknown");
  });

  it("distinguishes 429 false exhaustion desync from real cap using local 5h usage", () => {
    const lowUsage = [makeRecord({ input_tokens: 2000, output_tokens: 500 })];
    const desyncRes = diagnoseError({
      errorText: "429 RESOURCE_EXHAUSTED",
      localRecords: lowUsage,
      nowMs,
    });
    expect(desyncRes.attribution).toContain("FALSE EXHAUSTION");

    const highUsage = [makeRecord({ input_tokens: 900_000, output_tokens: 100_000 })];
    const realCapRes = diagnoseError({
      errorText: "429 RESOURCE_EXHAUSTED",
      localRecords: highUsage,
      nowMs,
    });
    expect(realCapRes.attribution).toContain("REAL QUOTA CAP");
  });

  it("computes PT midnight and rolling 5h/7d reset countdowns", () => {
    const now = new Date("2026-11-26T04:00:00.000Z"); // 20:00 PST -> 4h until PT midnight
    const cd = computeResetCountdown({
      now,
      timezone: "UTC",
      oldestEventIn5hMs: now.getTime() - 2 * 3600 * 1000,
      oldestEventIn7dMs: now.getTime() - 24 * 3600 * 1000,
    });

    expect(cd.pt_midnight.remaining_seconds).toBeGreaterThanOrEqual(3 * 3600);
    expect(cd.pt_midnight.remaining_seconds).toBeLessThanOrEqual(5 * 3600);
    expect(cd.rolling_5h.remaining_seconds).toBe(3 * 3600);
    expect(cd.rolling_5h.is_local_estimate).toBe(true);
    expect(cd.rolling_5h.estimate_note).toContain("earliest local event timestamp");
    expect(cd.rolling_7d.remaining_seconds).toBe(6 * 86400);
    expect(cd.rolling_7d.is_local_estimate).toBe(true);
    expect(cd.rolling_7d.estimate_note).toContain("official remaining quota percentages");
  });
});
