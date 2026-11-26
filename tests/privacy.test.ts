import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageRecord,
  USAGE_RECORD_WHITELIST_KEYS,
  resetSaltCache,
} from "../src/collectors/agy-hook.js";
import { readGeminiOtelRecords } from "../src/collectors/gemini-otel.js";
import {
  analyzeTranscriptStructure,
  scanTranscriptActivity,
} from "../src/collectors/transcript-meta.js";
import { runDoctor, formatDoctorReport } from "../src/cli/doctor.js";

describe("Privacy & Compliance Red Lines", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agycraft-privacy-"));
    resetSaltCache();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("strips prompts, code, file paths, project names, emails, and secrets before writing usage.jsonl", async () => {
    const logPath = join(tempDir, "usage.jsonl");
    const saltPath = join(tempDir, ".salt");

    const poisonedPayload = {
      ts: "2026-11-26T02:30:00.000Z",
      provider: "antigravity",
      product: "agy",
      session_id: "/Users/alice/secret-project/session-99",
      model: "gemini-4-neon",
      input_tokens: 12000,
      output_tokens: 1500,
      context_used_pct: 42.5,
      tool_calls: 3,
      turn_index: 7,
      error_code: null,
      // Poisoned sensitive fields that MUST NEVER be written
      prompt: "SUPER_SECRET_USER_PROMPT_DO_NOT_LOG",
      response: "CONFIDENTIAL_ASSISTANT_REPLY",
      code: "const apiKey = 'AIzaSySecretKey123456789';",
      file_path: "/home/alice/private-repo/src/secret.ts",
      project_name: "top-secret-merger-project",
      email: "alice@secret-corp.com",
      oauth_token: "ya29.a0AfH6SMB_SECRET_OAUTH_TOKEN",
    };

    const record = await appendUsageRecord(poisonedPayload, { logPath, saltPath });
    const rawWritten = await readFile(logPath, "utf8");
    const parsed = JSON.parse(rawWritten.trim()) as Record<string, unknown>;

    // Exact whitelist keys only
    expect(Object.keys(parsed).sort()).toEqual([...USAGE_RECORD_WHITELIST_KEYS].sort());
    expect(record.session_hash).toMatch(/^[a-f0-9]{12}$/);

    // Assert zero sensitive strings appear anywhere in the file
    const forbidden = [
      "SUPER_SECRET_USER_PROMPT",
      "CONFIDENTIAL_ASSISTANT_REPLY",
      "AIzaSySecretKey",
      "private-repo",
      "top-secret-merger",
      "alice@secret-corp.com",
      "ya29.a0AfH6SMB",
      "/Users/alice",
    ];
    for (const secret of forbidden) {
      expect(rawWritten).not.toContain(secret);
    }
  });

  it("rejects file paths or emails smuggled inside model or error_code fields", async () => {
    const logPath = join(tempDir, "usage.jsonl");
    const saltPath = join(tempDir, ".salt");

    const record = await appendUsageRecord(
      {
        model: "/home/alice/secret-model.bin",
        error_code: "Failed for alice@corp.com at /var/secret/key.pem (429)",
      },
      { logPath, saltPath },
    );

    expect(record.model).toBe("unknown");
    expect(record.error_code).toBe("429");
    const raw = await readFile(logPath, "utf8");
    expect(raw).not.toContain("alice");
    expect(raw).not.toContain("secret");
  });

  it("never retains prompts or secrets from Gemini CLI telemetry_stats.jsonl", async () => {
    const otelPath = join(tempDir, "telemetry_stats.jsonl");
    const line = JSON.stringify({
      timestamp: "2026-11-26T02:00:00.000Z",
      attributes: {
        "gen_ai.request.model": "gemini-3.8-flash",
        "gen_ai.usage.input_tokens": 5200,
        "gen_ai.usage.output_tokens": 600,
        "gen_ai.prompt": "SECRET_OTEL_PROMPT_CONTENT",
        "gen_ai.completion": "SECRET_OTEL_COMPLETION",
        "user.email": "bob@private.io",
        "session.id": "bob-private-session-id",
      },
    });
    await writeFile(otelPath, `${line}\n`, "utf8");

    const records = await readGeminiOtelRecords({ otelPath });
    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("SECRET_OTEL_PROMPT");
    expect(serialized).not.toContain("SECRET_OTEL_COMPLETION");
    expect(serialized).not.toContain("bob@private.io");
    expect(serialized).not.toContain("bob-private-session-id");
  });

  it("never retains prompt text, tool args, or file paths from transcript.jsonl", async () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    const lines = [
      JSON.stringify({
        role: "user",
        content: "PRIVATE_PROMPT_WITH_PASSWORD_XYZ",
        file_path: "/home/user/secret-app/main.ts",
      }),
      JSON.stringify({
        role: "tool",
        tool_name: "run_command",
        arguments: { cmd: "cat /etc/shadow && echo SECRET_ARG" },
        output: "SECRET_TOOL_OUTPUT_DATA",
        is_error: true,
      }),
    ];
    await writeFile(transcriptPath, lines.join("\n"), "utf8");

    const meta = await analyzeTranscriptStructure(transcriptPath);
    const serialized = JSON.stringify(meta);
    expect(meta.total_steps).toBe(2);
    expect(meta.tool_error_count).toBe(1);
    expect(serialized).not.toContain("PRIVATE_PROMPT");
    expect(serialized).not.toContain("secret-app");
    expect(serialized).not.toContain("SECRET_ARG");
    expect(serialized).not.toContain("SECRET_TOOL_OUTPUT");
  });

  it("doctor NEVER reads or prints secret/token/key/proxy-password values", async () => {
    const mcpPath = join(tempDir, "mcp_config.json");
    await writeFile(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          myserver: {
            command: "npx",
            args: ["-y", "example-mcp"],
            env: {
              GITHUB_TOKEN: "ghp_SUPER_SECRET_MCP_TOKEN_99999",
              OPENAI_API_KEY: "sk-SUPER_SECRET_API_KEY_88888",
            },
          },
        },
      }),
      "utf8",
    );

    const report = await runDoctor({
      cwd: tempDir,
      homeDir: tempDir,
      mcpConfigPaths: [mcpPath],
      settingsJsonPaths: [],
      skipBinaryChecks: true,
      env: {
        GEMINI_API_KEY: "AIzaSy_SUPER_SECRET_GEMINI_KEY_77777",
        MY_PRIVATE_SECRET: "TOP_SECRET_ENV_VALUE_66666",
        HTTPS_PROXY: "http://alice:PROXY_PASSWORD_55555@proxy.corp:8080",
      },
    });

    const formatted = formatDoctorReport(report);
    const jsonDump = JSON.stringify(report);

    for (const secret of [
      "ghp_SUPER_SECRET_MCP_TOKEN_99999",
      "sk-SUPER_SECRET_API_KEY_88888",
      "AIzaSy_SUPER_SECRET_GEMINI_KEY_77777",
      "TOP_SECRET_ENV_VALUE_66666",
      "PROXY_PASSWORD_55555",
    ]) {
      expect(formatted).not.toContain(secret);
      expect(jsonDump).not.toContain(secret);
    }
  });

  it("source code contains ZERO undocumented Google/AGY internal endpoints or credential file reads", async () => {
    const srcRoot = new URL("../src", import.meta.url).pathname;
    const files: string[] = [];

    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.name.endsWith(".ts")) {
          files.push(full);
        }
      }
    }

    await walk(srcRoot);
    expect(files.length).toBeGreaterThan(5);

    const forbiddenPatterns = [
      "daily-cloudcode-pa.googleapis.com",
      "cloudcode-pa.googleapis.com",
      "application_default_credentials.json",
      "oauth_creds.json",
    ];

    for (const f of files) {
      const content = await readFile(f, "utf8");
      for (const pattern of forbiddenPatterns) {
        expect(content, `Forbidden reference "${pattern}" in ${f}`).not.toContain(pattern);
      }
    }
  });

  it("scanTranscriptActivity NEVER leaks prompt text, model responses, code diffs, file paths, or session UUIDs", async () => {
    const brainDir = join(tempDir, "brain");
    const secretUuid = "deadbeef-1234-5678-90ab-secretuuid99";
    const logsDir = join(brainDir, secretUuid, ".system_generated", "logs");
    await mkdir(logsDir, { recursive: true });

    const nowMs = Date.parse("2026-11-26T10:00:00.000Z");
    await writeFile(
      join(logsDir, "transcript.jsonl"),
      JSON.stringify({
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T09:00:00.000Z",
        content: "SECRET_USER_PROMPT_SHOULD_NEVER_LEAK",
        thinking: "SECRET_MODEL_THINKING_TEXT",
        diff: "--- a/secret_file.ts\n+++ b/secret_file.ts",
        file_path: "/home/alice/top-secret-repo/credentials.ts",
      }),
      "utf8",
    );

    const activity = await scanTranscriptActivity({ brainDir, nowMs });
    const serialized = JSON.stringify(activity);

    expect(activity.window_5h.turn_count).toBe(1);
    for (const forbidden of [
      secretUuid,
      "SECRET_USER_PROMPT",
      "SECRET_MODEL_THINKING",
      "secret_file.ts",
      "/home/alice/top-secret-repo",
      "credentials.ts",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
