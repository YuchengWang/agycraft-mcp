import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgycraftServer } from "../src/server.js";
import { SnapshotClient } from "../src/remote/snapshot-client.js";
import { appendUsageRecord, resetSaltCache } from "../src/collectors/agy-hook.js";

describe("MCP Server (5 tools end-to-end)", () => {
  let tempDir: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agycraft-server-"));
    resetSaltCache();

    const usageLogPath = join(tempDir, "usage.jsonl");
    const saltPath = join(tempDir, ".salt");
    await appendUsageRecord(
      {
        ts: new Date().toISOString(),
        product: "agy",
        model: "gemini-4-neon",
        input_tokens: 15000,
        output_tokens: 3000,
        context_used_pct: 40,
        tool_calls: 2,
        turn_index: 6,
      },
      { logPath: usageLogPath, saltPath },
    );

    const server = createAgycraftServer({
      snapshotClient: new SnapshotClient({
        cacheDir: join(tempDir, "cache"),
        offlineOnly: true,
      }),
      usageLogPath,
      geminiOtelPath: join(tempDir, "nonexistent-otel.jsonl"),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("registers exactly 5 MCP tools", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "analyze_token_usage",
      "diagnose_error",
      "get_ecosystem_status",
      "get_saving_recommendations",
      "lookup_model_guide",
    ]);
  });

  it("executes all 5 tools and returns structured JSON responses", async () => {
    const usage = await client.callTool({
      name: "analyze_token_usage",
      arguments: { window: "5h", product: "all" },
    });
    const usageJson = JSON.parse((usage.content as Array<{ text: string }>)[0]!.text);
    expect(usageJson.record_count).toBe(1);
    expect(usageJson.total_input_tokens).toBe(15000);

    const recs = await client.callTool({
      name: "get_saving_recommendations",
      arguments: { window: "24h" },
    });
    const recsJson = JSON.parse((recs.content as Array<{ text: string }>)[0]!.text);
    expect(recsJson.window).toBe("24h");

    const diag = await client.callTool({
      name: "diagnose_error",
      arguments: { error_text: "429 RESOURCE_EXHAUSTED limit: 0", product: "agy" },
    });
    const diagJson = JSON.parse((diag.content as Array<{ text: string }>)[0]!.text);
    expect(diagJson.domain).toBe("quota");
    expect(diagJson.deep_link).toContain("modelcraft.dev/fix/");
    expect(diagJson.official_source_url).toMatch(/^https:\/\//);

    const guide = await client.callTool({
      name: "lookup_model_guide",
      arguments: { model_id: "argon", include_history: true },
    });
    const guideJson = JSON.parse((guide.content as Array<{ text: string }>)[0]!.text);
    expect(guideJson.deprecation_warnings).toHaveLength(1);
    expect(guideJson.chronicle_history.length).toBeGreaterThanOrEqual(1);
    expect(guideJson.official_source_urls.length).toBeGreaterThanOrEqual(1);

    const status = await client.callTool({
      name: "get_ecosystem_status",
      arguments: { plan: "pro", timezone: "Asia/Shanghai" },
    });
    const statusJson = JSON.parse((status.content as Array<{ text: string }>)[0]!.text);
    expect(statusJson.overall_status).toBe("operational");
    expect(statusJson.countdown.timezone).toBe("Asia/Shanghai");
    expect(statusJson.official_source_urls.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to transcript_activity_fallback when usage.jsonl & telemetry_stats.jsonl have 0 records", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "agycraft-fallback-"));
    try {
      const brainDir = join(emptyDir, "brain");
      const logsDir = join(brainDir, "session-uuid-hidden", ".system_generated", "logs");
      await mkdir(logsDir, { recursive: true });
      const recentIso = new Date(Date.now() - 3600 * 1000).toISOString();
      await writeFile(
        join(logsDir, "transcript.jsonl"),
        JSON.stringify({
          step_index: 1,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          created_at: recentIso,
          content: "CONFIDENTIAL_PROMPT_TEXT",
        }),
        "utf8",
      );

      const fallbackServer = createAgycraftServer({
        snapshotClient: new SnapshotClient({
          cacheDir: join(emptyDir, "cache"),
          offlineOnly: true,
        }),
        usageLogPath: join(emptyDir, "missing-usage.jsonl"),
        geminiOtelPath: join(emptyDir, "missing-otel.jsonl"),
        brainDir,
      });

      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "fallback-test-client", version: "0.1.0" });
      await Promise.all([fallbackServer.connect(st), c.connect(ct)]);

      const usage = await c.callTool({
        name: "analyze_token_usage",
        arguments: { window: "5h", product: "all" },
      });
      const usageJson = JSON.parse((usage.content as Array<{ text: string }>)[0]!.text);
      expect(usageJson.record_count).toBe(0);
      expect(usageJson.data_mode).toBe("transcript_timestamps_only");
      expect(usageJson.session_count).toBe(1);
      expect(usageJson.activity_summary).toContain("1 active AGY session(s)");
      expect(usageJson.transcript_activity_fallback.source).toBe("transcript_timestamps");
      expect(usageJson.transcript_activity_fallback.window_5h.turn_count).toBe(1);
      expect(usageJson.transcript_activity_fallback.window_5h.estimated_5h_reset_at).toBeTruthy();

      const status = await c.callTool({
        name: "get_ecosystem_status",
        arguments: { timezone: "Asia/Shanghai" },
      });
      const statusJson = JSON.parse((status.content as Array<{ text: string }>)[0]!.text);
      expect(statusJson.data_mode).toBe("transcript_timestamps_only");
      expect(statusJson.session_count).toBe(1);
      expect(statusJson.activity_summary).toContain("1 active AGY session(s)");
      expect(statusJson.transcript_activity_fallback.source).toBe("transcript_timestamps");
      expect(statusJson.countdown.rolling_5h.estimated_relief_iso).toBeTruthy();
      expect(statusJson.countdown.rolling_5h.estimated_relief_local).toBeTruthy();
      expect(JSON.stringify(statusJson)).not.toContain("CONFIDENTIAL_PROMPT_TEXT");
      expect(JSON.stringify(statusJson)).not.toContain("session-uuid-hidden");

      await c.close();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("reports hook_events_without_tokens when usage.jsonl has records without token counts", async () => {
    const hookOnlyDir = await mkdtemp(join(tmpdir(), "agycraft-hook-only-"));
    try {
      const usageLogPath = join(hookOnlyDir, "usage.jsonl");
      const saltPath = join(hookOnlyDir, ".salt");
      await appendUsageRecord(
        {
          ts: new Date().toISOString(),
          product: "agy",
          model: "unknown",
          input_tokens: 0,
          output_tokens: 0,
        },
        { logPath: usageLogPath, saltPath },
      );

      const hookServer = createAgycraftServer({
        snapshotClient: new SnapshotClient({
          cacheDir: join(hookOnlyDir, "cache"),
          offlineOnly: true,
        }),
        usageLogPath,
        geminiOtelPath: join(hookOnlyDir, "missing-otel.jsonl"),
      });

      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "hook-only-test-client", version: "0.1.0" });
      await Promise.all([hookServer.connect(st), c.connect(ct)]);

      const usage = await c.callTool({
        name: "analyze_token_usage",
        arguments: { window: "5h", product: "all" },
      });
      const usageJson = JSON.parse((usage.content as Array<{ text: string }>)[0]!.text);
      expect(usageJson.record_count).toBe(1);
      expect(usageJson.total_tokens).toBe(0);
      expect(usageJson.data_mode).toBe("hook_events_without_tokens");
      expect(usageJson.usage_note).toContain("without token or model fields");

      const status = await c.callTool({
        name: "get_ecosystem_status",
        arguments: { timezone: "UTC" },
      });
      const statusJson = JSON.parse((status.content as Array<{ text: string }>)[0]!.text);
      expect(statusJson.data_mode).toBe("hook_events_without_tokens");
      expect(statusJson.usage_note).toContain("without token or model fields");
      expect(statusJson.countdown.rolling_5h.is_local_estimate).toBe(true);
      expect(statusJson.countdown.rolling_5h.estimate_note).toContain("earliest local event timestamp");
      expect(statusJson.countdown.rolling_7d.is_local_estimate).toBe(true);

      await c.close();
    } finally {
      await rm(hookOnlyDir, { recursive: true, force: true });
    }
  });
});
