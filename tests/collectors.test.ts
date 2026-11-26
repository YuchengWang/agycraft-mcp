import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageRecord,
  readUsageRecords,
  resetSaltCache,
} from "../src/collectors/agy-hook.js";
import { readGeminiOtelRecords } from "../src/collectors/gemini-otel.js";
import {
  parseTranscriptLines,
  scanTranscriptActivity,
} from "../src/collectors/transcript-meta.js";

describe("Collectors", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agycraft-collectors-"));
    resetSaltCache();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes and reads whitelisted AGY usage records with product & time filtering", async () => {
    const logPath = join(tempDir, "usage.jsonl");
    const saltPath = join(tempDir, ".salt");

    await appendUsageRecord(
      {
        ts: "2026-11-25T00:00:00.000Z",
        product: "agy",
        model: "gemini-4-neon",
        input_tokens: 10000,
        output_tokens: 1200,
        context_used_pct: 25.4,
        tool_calls: 2,
        turn_index: 3,
      },
      { logPath, saltPath },
    );
    await appendUsageRecord(
      {
        ts: "2026-11-26T02:00:00.000Z",
        product: "gemini-cli",
        model: "gemini-3.8-flash",
        input_tokens: 3000,
        output_tokens: 500,
      },
      { logPath, saltPath },
    );

    const all = await readUsageRecords({ logPath });
    expect(all).toHaveLength(2);

    const onlyAgy = await readUsageRecords({ logPath, product: "agy" });
    expect(onlyAgy).toHaveLength(1);
    expect(onlyAgy[0]?.model).toBe("gemini-4-neon");

    const recent = await readUsageRecords({
      logPath,
      sinceMs: Date.parse("2026-11-26T00:00:00.000Z"),
    });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.product).toBe("gemini-cli");
  });

  it("parses Gemini CLI OpenTelemetry outfile and skips non-LLM spans", async () => {
    const otelPath = join(tempDir, "telemetry_stats.jsonl");
    const lines = [
      JSON.stringify({ timestamp: "2026-11-26T01:00:00Z", attributes: { span: "startup" } }),
      JSON.stringify({
        timestamp: "2026-11-26T02:00:00Z",
        attributes: {
          "gen_ai.request.model": "gemini-3.8-flash",
          "gen_ai.usage.input_tokens": 8000,
          "gen_ai.usage.output_tokens": 900,
        },
      }),
    ];
    await writeFile(otelPath, lines.join("\n"), "utf8");

    const records = await readGeminiOtelRecords({ otelPath });
    expect(records).toHaveLength(1);
    expect(records[0]?.input_tokens).toBe(8000);
    expect(records[0]?.output_tokens).toBe(900);
    expect(records[0]?.product).toBe("gemini-cli");
  });

  it("detects consecutive tool failure loops and /compact events in transcript.jsonl", () => {
    const lines = [
      JSON.stringify({ role: "user" }),
      JSON.stringify({ type: "compact" }),
      JSON.stringify({ role: "tool", tool_name: "run_command", exit_code: 1 }),
      JSON.stringify({ role: "tool", tool_name: "run_command", exit_code: 1 }),
      JSON.stringify({ role: "tool", tool_name: "run_command", exit_code: 1 }),
      JSON.stringify({ role: "tool", tool_name: "run_command", exit_code: 1 }),
    ];

    const meta = parseTranscriptLines(lines, 4);
    expect(meta.has_compact_event).toBe(true);
    expect(meta.steps_since_last_compact).toBe(4);
    expect(meta.max_consecutive_tool_failures).toBe(4);
    expect(meta.consecutive_failure_tool_type).toBe("run_command");
    expect(meta.loop_detected).toBe(true);
  });

  it("scans AGY brain transcript.jsonl files for 5h/7d structural activity & estimated_5h_reset_at", async () => {
    const brainDir = join(tempDir, "brain");
    const sess1Logs = join(brainDir, "11111111-2222-3333-4444-555555555555", ".system_generated", "logs");
    const sess2Logs = join(brainDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", ".system_generated", "logs");
    await mkdir(sess1Logs, { recursive: true });
    await mkdir(sess2Logs, { recursive: true });

    const nowMs = Date.parse("2026-11-26T10:00:00.000Z");
    await writeFile(
      join(sess1Logs, "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-11-26T08:00:00.000Z" }),
        JSON.stringify({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-26T08:00:10.000Z" }),
        JSON.stringify({ step_index: 3, type: "TOOL_CALL", tool_name: "run_command", created_at: "2026-11-26T08:00:15.000Z" }),
      ].join("\n"),
      "utf8",
    );

    // Older session (2 days ago -> in 7d, outside 5h)
    await writeFile(
      join(sess2Logs, "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-11-24T10:00:00.000Z" }),
      ].join("\n"),
      "utf8",
    );

    const activity = await scanTranscriptActivity({
      brainDir,
      nowMs,
      timezone: "Asia/Shanghai",
    });

    expect(activity.source).toBe("transcript_timestamps");
    expect(activity.window_5h.session_count).toBe(1);
    expect(activity.window_5h.turn_count).toBe(3);
    expect(activity.window_5h.tool_call_count).toBe(1);
    expect(activity.window_5h.earliest_turn_at).toBe("2026-11-26T08:00:00.000Z");
    expect(activity.window_5h.estimated_5h_reset_at).toBe("2026-11-26T13:00:00.000Z");
    expect(activity.window_7d.session_count).toBe(2);
    expect(activity.window_7d.turn_count).toBe(4);
  });
});
