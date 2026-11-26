import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, formatDoctorReport } from "../src/cli/doctor.js";
import { buildSetupInstructions } from "../src/cli/setup.js";
import { clearLocalData } from "../src/cli/clear-local-data.js";

describe("CLI commands (doctor, setup, clear-local-data)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agycraft-cli-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("doctor detects url vs httpUrl mismatch, dual auth env, proxy without CA, missing .geminiignore, and rule bloat", async () => {
    const mcpPath = join(tempDir, "mcp_config.json");
    await writeFile(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          badTransport: {
            url: "https://example.com/mcp",
          },
          conflictTransport: {
            url: "https://example.com/sse",
            httpUrl: "https://example.com/mcp",
          },
        },
      }),
      "utf8",
    );

    // Create a large GEMINI.md (>12KB -> >3000 estimated tokens)
    await writeFile(join(tempDir, "GEMINI.md"), "a".repeat(14_000), "utf8");

    const report = await runDoctor({
      cwd: tempDir,
      homeDir: tempDir,
      mcpConfigPaths: [mcpPath],
      settingsJsonPaths: [],
      skipBinaryChecks: true,
      env: {
        GEMINI_API_KEY: "dummy-set",
        GOOGLE_CLOUD_PROJECT: "my-project",
        HTTPS_PROXY: "http://proxy.local:8080",
      },
    });

    const ids = report.checks.map((c) => c.id);
    expect(ids).toContain("mcp_url_mismatch_badTransport");
    expect(ids).toContain("mcp_transport_conflict_conflictTransport");
    expect(ids).toContain("auth_env_dual_set");
    expect(ids).toContain("proxy_without_ca_certs");
    expect(ids).toContain("geminiignore_check");
    expect(ids).toContain("global_rules_bloat");

    const output = formatDoctorReport(report);
    expect(output).toContain("Git Safety Guardrail");
    expect(output).toContain(".geminiignore");
  });

  it("setup returns non-destructive opt-in instructions with logPrompts: false", () => {
    const text = buildSetupInstructions();
    expect(text).toContain("agycraft-mcp");
    expect(text).toContain("agy mcp add agycraft npx -y agycraft-mcp");
    expect(text).toContain("~/.gemini/config/hooks.json");
    expect(text).toContain('"PostInvocation"');
    expect(text).toContain('"logPrompts": false');
    expect(text).toContain("No files have been modified automatically");
  });

  it("clear-local-data safely removes usage.jsonl, salt, and cache directory", async () => {
    const usageLogPath = join(tempDir, "usage.jsonl");
    const saltPath = join(tempDir, ".salt");
    const cacheDir = join(tempDir, "cache");
    await writeFile(usageLogPath, "{}\n", "utf8");
    await writeFile(saltPath, "1234567890abcdef", "utf8");

    await clearLocalData({ usageLogPath, saltPath, cacheDir });

    await expect(access(usageLogPath)).rejects.toThrow();
    await expect(access(saltPath)).rejects.toThrow();
  });
});
