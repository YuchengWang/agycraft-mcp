import { access, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CheckSeverity = "ok" | "warn" | "error" | "info";

export interface DoctorCheckItem {
  id: string;
  category:
    | "runtime"
    | "mcp_config"
    | "auth_env"
    | "network_ssl"
    | "context_hygiene"
    | "safety_guardrail";
  severity: CheckSeverity;
  title: string;
  detail: string;
  fix_hint?: string;
}

export interface DoctorReport {
  generated_at: string;
  node_version: string;
  checks: DoctorCheckItem[];
  summary: {
    ok: number;
    warn: number;
    error: number;
    info: number;
  };
  git_safety_guardrail_snippet: string;
  geminiignore_template: string;
}

export interface DoctorOptions {
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  mcpConfigPaths?: string[];
  settingsJsonPaths?: string[];
  skipBinaryChecks?: boolean;
}

const SENSITIVE_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

export const GIT_SAFETY_GUARDRAIL_SNIPPET = `# Git Safety Guardrail (add to AGENTS.md or GEMINI.md)
- NEVER run destructive git commands (\`git push --force\`, \`git reset --hard\`, \`git clean -fd\`, \`git checkout -- .\`) without explicit user confirmation.
- NEVER delete files outside the current workspace or run \`rm -rf\` on broad paths.
- Always run \`git status\` and \`git diff --stat\` before committing or staging changes.`;

export const GEMINIIGNORE_TEMPLATE = `# Recommended .geminiignore to prevent context bloat & 504 timeouts
node_modules/
dist/
build/
.next/
.astro/
coverage/
*.lock
package-lock.json
pnpm-lock.yaml
yarn.lock
*.min.js
*.map
*.parquet
*.sqlite
*.db
.git/
`;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function detectBinaryVersion(
  cmd: string,
  args: string[] = ["--version"],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 2500 });
    const firstLine = stdout.trim().split("\n")[0]?.trim() ?? "";
    return firstLine.slice(0, 64) || null;
  } catch {
    return null;
  }
}

/**
 * Inspects JSON config structure ONLY. Never reads or echoes secret/token/key values.
 */
async function inspectJsonConfig(
  filePath: string,
  kind: "mcp_config" | "settings",
): Promise<DoctorCheckItem[]> {
  const checks: DoctorCheckItem[] = [];
  if (!(await fileExists(filePath))) {
    return checks;
  }

  let parsed: unknown;
  try {
    const raw = await readFile(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid JSON syntax";
    checks.push({
      id: `${kind}_syntax_error`,
      category: "mcp_config",
      severity: "error",
      title: `Invalid JSON syntax in ${kind === "mcp_config" ? "mcp_config.json" : "settings.json"}`,
      detail: `Parse error: ${msg.slice(0, 120)}`,
      fix_hint: "Validate trailing commas, quotes, and braces with `jq . <file>`.",
    });
    return checks;
  }

  checks.push({
    id: `${kind}_syntax_ok`,
    category: "mcp_config",
    severity: "ok",
    title: `${kind === "mcp_config" ? "mcp_config.json" : "settings.json"} JSON syntax valid`,
    detail: "Parsed cleanly.",
  });

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return checks;
  }

  const root = parsed as Record<string, unknown>;
  const serversObj = root["mcpServers"];
  if (serversObj && typeof serversObj === "object" && !Array.isArray(serversObj)) {
    const serverEntries = Object.entries(serversObj as Record<string, unknown>);
    const serverCount = serverEntries.length;

    if (serverCount > 8) {
      checks.push({
        id: "mcp_server_bloat",
        category: "context_hygiene",
        severity: "warn",
        title: `High mounted MCP server count (${serverCount})`,
        detail: `${serverCount} MCP servers inject many tool schemas into every turn, accelerating 5h/7d quota burn.`,
        fix_hint: "Disable unused MCP servers or split specialized workflows into on-demand SKILL.md files.",
      });
    } else {
      checks.push({
        id: "mcp_server_count_ok",
        category: "context_hygiene",
        severity: "ok",
        title: `Mounted MCP server count healthy (${serverCount})`,
        detail: `${serverCount} configured MCP server(s).`,
      });
    }

    for (const [serverName, cfg] of serverEntries) {
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        continue;
      }
      const serverCfg = cfg as Record<string, unknown>;
      const safeName = serverName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32);

      // Check url vs httpUrl mismatch
      const hasUrl = typeof serverCfg["url"] === "string";
      const hasHttpUrl = typeof serverCfg["httpUrl"] === "string";
      if (hasUrl && hasHttpUrl) {
        checks.push({
          id: `mcp_transport_conflict_${safeName}`,
          category: "mcp_config",
          severity: "error",
          title: `MCP server "${safeName}" sets both "url" and "httpUrl"`,
          detail: "Use 'url' for SSE transport OR 'httpUrl' for Streamable HTTP, never both.",
          fix_hint: `Remove one of 'url' or 'httpUrl' in mcpServers.${safeName} and verify with \`gemini mcp list\`.`,
        });
      } else if (hasUrl) {
        const urlStr = String(serverCfg["url"]);
        if (urlStr.includes("/mcp") && !urlStr.includes("/sse")) {
          checks.push({
            id: `mcp_url_mismatch_${safeName}`,
            category: "mcp_config",
            severity: "warn",
            title: `Possible url vs httpUrl mismatch on "${safeName}"`,
            detail: "Endpoint looks like Streamable HTTP (/mcp) but uses legacy SSE key 'url'.",
            fix_hint: `Rename key "url" -> "httpUrl" in mcpServers.${safeName} if the server uses Streamable HTTP.`,
          });
        }
      } else if (hasHttpUrl) {
        const httpUrlStr = String(serverCfg["httpUrl"]);
        if (httpUrlStr.includes("/sse")) {
          checks.push({
            id: `mcp_httpurl_mismatch_${safeName}`,
            category: "mcp_config",
            severity: "warn",
            title: `Possible httpUrl vs url mismatch on "${safeName}"`,
            detail: "Endpoint looks like SSE (/sse) but uses Streamable HTTP key 'httpUrl'.",
            fix_hint: `Rename key "httpUrl" -> "url" in mcpServers.${safeName} if the server uses SSE.`,
          });
        }
      }

      // Check env keys for *TOKEN*/*KEY*/*SECRET* stripping risk (NAMES ONLY, NEVER VALUES)
      const envBlock = serverCfg["env"];
      if (envBlock && typeof envBlock === "object" && !Array.isArray(envBlock)) {
        const sensitiveKeyCount = Object.keys(envBlock as Record<string, unknown>).filter(
          (k) => SENSITIVE_KEY_RE.test(k),
        ).length;
        if (sensitiveKeyCount > 0) {
          checks.push({
            id: `mcp_env_explicit_${safeName}`,
            category: "mcp_config",
            severity: "info",
            title: `MCP server "${safeName}" defines ${sensitiveKeyCount} explicit credential env key(s)`,
            detail: "Explicit env keys are present (values not inspected or logged).",
          });
        }
      }
    }
  }

  return checks;
}

/**
 * Runs offline preflight & hygiene checks.
 * PRIVACY RED LINE: Only inspects boolean existence, structural syntax, and byte counts.
 * NEVER reads, retains, or prints secret/token/key values or credential files.
 */
export async function runDoctor(options?: DoctorOptions): Promise<DoctorReport> {
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.homeDir ?? homedir();
  const env = options?.env ?? process.env;
  const checks: DoctorCheckItem[] = [];

  // 1. Node.js version check
  const nodeVersion = process.version;
  const major = Number(nodeVersion.replace(/^v/, "").split(".")[0] ?? "0");
  checks.push({
    id: "node_version",
    category: "runtime",
    severity: major >= 22 ? "ok" : "warn",
    title: `Node.js ${nodeVersion}`,
    detail:
      major >= 22
        ? "Node 22+ runtime detected."
        : "Node 22+ is recommended for agycraft-mcp and Gemini CLI.",
    fix_hint: major >= 22 ? undefined : "Upgrade Node.js to v22 LTS or newer.",
  });

  // 2. AGY & Gemini CLI binary presence
  if (!options?.skipBinaryChecks) {
    const [geminiVer, agyVer] = await Promise.all([
      detectBinaryVersion("gemini", ["--version"]),
      detectBinaryVersion("agy", ["--version"]),
    ]);
    checks.push({
      id: "gemini_cli_version",
      category: "runtime",
      severity: geminiVer ? "ok" : "info",
      title: geminiVer ? `Gemini CLI detected (${geminiVer})` : "Gemini CLI not found on PATH",
      detail: geminiVer
        ? "Gemini CLI binary is reachable."
        : "Optional: install with `npm i -g @google/gemini-cli` if you use Gemini CLI.",
    });
    checks.push({
      id: "agy_cli_version",
      category: "runtime",
      severity: agyVer ? "ok" : "info",
      title: agyVer ? `Antigravity CLI detected (${agyVer})` : "Antigravity CLI (`agy`) not found on PATH",
      detail: agyVer
        ? "Antigravity CLI binary is reachable."
        : "If using Antigravity IDE only, CLI binary on PATH is optional.",
    });
  }

  // 3. mcp_config.json & settings.json syntax / transport checks
  const mcpPaths = options?.mcpConfigPaths ?? [
    join(home, ".gemini", "antigravity", "mcp_config.json"),
    join(cwd, "mcp_config.json"),
  ];
  const settingsPaths = options?.settingsJsonPaths ?? [
    join(home, ".gemini", "settings.json"),
    join(cwd, ".gemini", "settings.json"),
  ];

  let foundAnyConfig = false;
  for (const p of mcpPaths) {
    const res = await inspectJsonConfig(p, "mcp_config");
    if (res.length > 0) {
      foundAnyConfig = true;
      checks.push(...res);
    }
  }
  for (const p of settingsPaths) {
    const res = await inspectJsonConfig(p, "settings");
    if (res.length > 0) {
      foundAnyConfig = true;
      checks.push(...res);
    }
  }
  if (!foundAnyConfig) {
    checks.push({
      id: "no_mcp_config_found",
      category: "mcp_config",
      severity: "info",
      title: "No local mcp_config.json or settings.json found in default locations",
      detail: "Run `npx agycraft-mcp setup` to view copyable MCP & OTel setup snippets.",
    });
  }

  // 4. Environment variable hygiene (BOOLEAN EXISTENCE ONLY — NEVER READ/PRINT VALUES)
  const hasGeminiApiKey = Boolean(env["GEMINI_API_KEY"] || env["GOOGLE_API_KEY"]);
  const hasGcpProject = Boolean(env["GOOGLE_CLOUD_PROJECT"]);
  if (hasGeminiApiKey && hasGcpProject) {
    checks.push({
      id: "auth_env_dual_set",
      category: "auth_env",
      severity: "warn",
      title: "Both API Key env and GOOGLE_CLOUD_PROJECT are set",
      detail:
        "Mixing API Key auth with Vertex/OAuth project env can trigger 403 Permission Denied or ACCESS_TOKEN_TYPE_UNSUPPORTED.",
      fix_hint:
        "Unset the unused auth method in your shell profile (`unset GEMINI_API_KEY` or `unset GOOGLE_CLOUD_PROJECT`).",
    });
  } else {
    checks.push({
      id: "auth_env_boolean_ok",
      category: "auth_env",
      severity: "ok",
      title: "Auth environment variables checked (boolean presence only)",
      detail: `GEMINI_API_KEY/GOOGLE_API_KEY set: ${hasGeminiApiKey}, GOOGLE_CLOUD_PROJECT set: ${hasGcpProject}.`,
    });
  }

  // Check for *TOKEN*/*KEY*/*SECRET* env stripping warning in CLI subprocesses
  const sensitiveEnvCount = Object.keys(env).filter((k) =>
    SENSITIVE_KEY_RE.test(k),
  ).length;
  if (sensitiveEnvCount > 0) {
    checks.push({
      id: "env_stripping_warning",
      category: "auth_env",
      severity: "info",
      title: `Detected ${sensitiveEnvCount} shell env var(s) matching *TOKEN*/*KEY*/*SECRET*`,
      detail:
        "Gemini CLI & AGY sanitize/strip *TOKEN*/*KEY*/*SECRET* env vars from child MCP servers by default (values not inspected).",
      fix_hint:
        "If an MCP server requires a specific variable, pass it explicitly in that server's `env` block in mcp_config.json / settings.json.",
    });
  }

  // 5. Proxy & NODE_EXTRA_CA_CERTS presence (BOOLEAN & READABILITY ONLY)
  const hasProxy = Boolean(
    env["HTTP_PROXY"] ||
      env["HTTPS_PROXY"] ||
      env["http_proxy"] ||
      env["https_proxy"],
  );
  const caCertPath = env["NODE_EXTRA_CA_CERTS"];
  const hasCaCert = Boolean(caCertPath);

  if (hasProxy && !hasCaCert) {
    checks.push({
      id: "proxy_without_ca_certs",
      category: "network_ssl",
      severity: "warn",
      title: "HTTP(S)_PROXY is set without NODE_EXTRA_CA_CERTS",
      detail:
        "Corporate SSL-inspecting proxies often cause `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` in Node.js.",
      fix_hint:
        "If behind a corporate TLS proxy, export `NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem`.",
    });
  } else if (hasCaCert && caCertPath) {
    const readable = await fileExists(caCertPath);
    checks.push({
      id: "node_extra_ca_certs_check",
      category: "network_ssl",
      severity: readable ? "ok" : "error",
      title: readable
        ? "NODE_EXTRA_CA_CERTS is set and readable"
        : "NODE_EXTRA_CA_CERTS points to an unreadable or missing file",
      detail: readable
        ? "Custom CA bundle is readable by Node.js."
        : "Node.js will ignore or fail TLS verification when NODE_EXTRA_CA_CERTS is unreadable.",
      fix_hint: readable
        ? undefined
        : "Verify the CA certificate path and file permissions (`chmod 644`).",
    });
  } else {
    checks.push({
      id: "network_ssl_ok",
      category: "network_ssl",
      severity: "ok",
      title: "No proxy/SSL misconfiguration detected",
      detail: "Direct HTTPS connection environment.",
    });
  }

  // 6. Context hygiene: .geminiignore check
  const hasGeminiIgnore = await fileExists(join(cwd, ".geminiignore"));
  checks.push({
    id: "geminiignore_check",
    category: "context_hygiene",
    severity: hasGeminiIgnore ? "ok" : "warn",
    title: hasGeminiIgnore
      ? ".geminiignore found in workspace"
      : "Missing .geminiignore in current workspace",
    detail: hasGeminiIgnore
      ? "Workspace ignore rules help prevent lockfile/build-artifact context bloat."
      : "Without .geminiignore, lockfiles and build outputs can bloat context and trigger 504 timeouts or quota burn.",
    fix_hint: hasGeminiIgnore
      ? undefined
      : "Create a `.geminiignore` file using the recommended template below.",
  });

  // 7. Global rules token bloat estimate (byte size -> ~chars/4, never reads/prints contents)
  const ruleCandidates = [
    { label: "~/.gemini/GEMINI.md", path: join(home, ".gemini", "GEMINI.md") },
    { label: "./GEMINI.md", path: join(cwd, "GEMINI.md") },
    { label: "./AGENTS.md", path: join(cwd, "AGENTS.md") },
  ];
  let totalRuleBytes = 0;
  let foundRuleFiles = 0;
  for (const candidate of ruleCandidates) {
    try {
      const s = await stat(candidate.path);
      if (s.isFile()) {
        totalRuleBytes += s.size;
        foundRuleFiles += 1;
      }
    } catch {
      // ignore missing
    }
  }
  const estimatedRuleTokens = Math.ceil(totalRuleBytes / 4);
  if (estimatedRuleTokens > 3000) {
    checks.push({
      id: "global_rules_bloat",
      category: "context_hygiene",
      severity: "warn",
      title: `Global rules token bloat (~${estimatedRuleTokens} tokens across ${foundRuleFiles} file(s))`,
      detail:
        "Large always-loaded rule files are re-sent on every single turn and inflate 5h/7d token consumption.",
      fix_hint:
        "Keep global rules under ~2,000 tokens and move domain-specific instructions into on-demand SKILL.md files.",
    });
  } else {
    checks.push({
      id: "global_rules_ok",
      category: "context_hygiene",
      severity: "ok",
      title: `Global rules size healthy (~${estimatedRuleTokens} tokens across ${foundRuleFiles} file(s))`,
      detail: "Baseline instruction overhead is lean.",
    });
  }

  // 8. Safety guardrail check
  checks.push({
    id: "git_safety_guardrail",
    category: "safety_guardrail",
    severity: "info",
    title: "Git safety guardrail template available",
    detail:
      "Add the non-destructive Git safety snippet below to GEMINI.md / AGENTS.md to prevent accidental force-pushes or hard resets.",
  });

  const summary = {
    ok: checks.filter((c) => c.severity === "ok").length,
    warn: checks.filter((c) => c.severity === "warn").length,
    error: checks.filter((c) => c.severity === "error").length,
    info: checks.filter((c) => c.severity === "info").length,
  };

  return {
    generated_at: new Date().toISOString(),
    node_version: nodeVersion,
    checks,
    summary,
    git_safety_guardrail_snippet: GIT_SAFETY_GUARDRAIL_SNIPPET,
    geminiignore_template: GEMINIIGNORE_TEMPLATE,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<CheckSeverity, string> = {
    ok: "[OK]",
    warn: "[WARN]",
    error: "[ERR]",
    info: "[INFO]",
  };
  const lines: string[] = [
    "agycraft-mcp doctor (100% local, zero secret values inspected)",
    "================================================================",
  ];

  for (const check of report.checks) {
    lines.push(`${icon[check.severity]} ${check.title}`);
    lines.push(`     ${check.detail}`);
    if (check.fix_hint) {
      lines.push(`     Fix: ${check.fix_hint}`);
    }
  }

  lines.push("");
  lines.push(
    `Summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.error} error, ${report.summary.info} info`,
  );
  lines.push("");
  lines.push("--- Recommended Git Safety Guardrail Snippet ---");
  lines.push(report.git_safety_guardrail_snippet);

  const missingIgnore = report.checks.some(
    (c) => c.id === "geminiignore_check" && c.severity === "warn",
  );
  if (missingIgnore) {
    lines.push("");
    lines.push("--- Recommended .geminiignore Template ---");
    lines.push(report.geminiignore_template.trimEnd());
  }

  return lines.join("\n");
}
