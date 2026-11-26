import type { UsageRecord } from "../collectors/agy-hook.js";
import type {
  DiagnosisCommand,
  DiagnosisEntry,
  StatusSnapshot,
} from "../types.js";

export interface DiagnosisResult {
  matched: boolean;
  domain: string;
  diagnosis_id: string;
  title: string;
  confidence: "high" | "medium" | "low";
  attribution: string;
  root_cause: string;
  steps: string[];
  commands: DiagnosisCommand[];
  verify_command: string;
  dont_dos: string[];
  deep_link: string;
  official_source_url: string | null;
  upstream_status: string;
  extracted_signals: {
    http_status: string | null;
    retry_delay: string | null;
    quota_metric: string | null;
  };
}

interface PatternRule {
  id: string;
  domain: string;
  regex: RegExp;
  fallback: DiagnosisEntry;
}

const BUILTIN_RULES: PatternRule[] = [
  {
    id: "weekly-cap",
    domain: "quota",
    regex:
      /weekly\s*(?:cap|limit)|WEEKLY_LIMIT_EXCEEDED|5-?hour|rolling\s*(?:5h|7d)|reached\s+your\s+usage\s+limit/i,
    fallback: {
      id: "weekly-cap",
      slug: "weekly-cap",
      provider: "antigravity",
      route_provider: "agy",
      domain: "quota",
      title: "Shared 5h / 7d Weekly Quota Cap Reached",
      severity: "high",
      products: ["agy", "cli", "web"],
      error_codes: ["429", "WEEKLY_LIMIT_EXCEEDED", "RATE_LIMIT_EXCEEDED"],
      error_patterns: ["weekly limit", "5-hour", "Try again later", "reached your usage limit"],
      root_cause:
        "You have exhausted the shared 5-hour or 7-day rolling quota bucket across Antigravity / Gemini CLI.",
      steps: [
        "Check `get_ecosystem_status` for local 5h/7d rolling window estimates and the official AGY/CLI quota UI for authoritative remaining %.",
        "Switch to a lighter model (Gemini 4 Hydrogen or Gemini 3.8 Flash) or run `/compact` to reduce per-turn token burn.",
      ],
      commands: [
        { label: "Switch Gemini CLI to Flash", os: "all", command: "gemini --model gemini-3.8-flash" },
      ],
      verify_command: "gemini --version && npx agycraft-mcp doctor",
      dont_dos: [
        "Do NOT hammer retry in a tight loop while capped.",
      ],
      deep_link: "https://modelcraft.dev/fix/quota/weekly-cap",
    },
  },
  {
    id: "429-desync",
    domain: "quota",
    regex: /\b429\b|RESOURCE_EXHAUSTED|quotaMetric|limit:\s*0|rate\s*limit/i,
    fallback: {
      id: "429-desync",
      slug: "429-desync",
      provider: "antigravity",
      route_provider: "agy",
      domain: "quota",
      title: "429 RESOURCE_EXHAUSTED / Quota Desync or Shared Bucket Cap",
      severity: "high",
      products: ["agy", "cli", "api"],
      error_codes: ["429", "RESOURCE_EXHAUSTED"],
      error_patterns: ["429", "RESOURCE_EXHAUSTED", "limit: 0"],
      root_cause:
        "Either the shared 5h/7d quota bucket is exhausted, or local account/billing state is desynced (showing high remaining % while returning 429 or limit: 0).",
      steps: [
        "Compare local 5h token consumption against the error to separate real cap vs entitlement/billing desync.",
        "If desynced: run Reset Onboarding in Antigravity or verify Google Cloud Billing / AI Pro subscription binding.",
        "If real cap: switch to Gemini 4 Hydrogen or Gemini 3.8 Flash, run `/compact`, and wait for the rolling 5h window relief.",
      ],
      commands: [
        { label: "Run local preflight doctor", os: "all", command: "npx agycraft-mcp doctor" },
        { label: "Switch Gemini CLI to lighter Flash model", os: "all", command: "gemini --model gemini-3.8-flash" },
      ],
      verify_command: "gemini --version && npx agycraft-mcp doctor",
      dont_dos: [
        "Do NOT hammer retry in a tight loop — repeated 429 bursts can trigger automated abuse cooldowns.",
        "Do NOT rotate multiple personal API keys to bypass free-tier limits.",
      ],
      deep_link: "https://modelcraft.dev/fix/quota/429-desync",
    },
  },
  {
    id: "403-auth-mismatch",
    domain: "auth",
    regex:
      /\b401\b|\b403\b|UNAUTHENTICATED|Permission\s*Denied|cloudaicompanion.*denied|ACCESS_TOKEN_TYPE_UNSUPPORTED|API_KEY_INVALID/i,
    fallback: {
      id: "403-auth-mismatch",
      slug: "403-auth-mismatch",
      provider: "google",
      route_provider: "google",
      domain: "auth",
      title: "401/403 Auth & Entitlement Mismatch",
      severity: "high",
      products: ["agy", "cli", "api"],
      error_codes: ["401", "403", "UNAUTHENTICATED", "PERMISSION_DENIED"],
      error_patterns: ["401", "403", "UNAUTHENTICATED", "ACCESS_TOKEN_TYPE_UNSUPPORTED"],
      root_cause:
        "Mixed authentication state (e.g., GEMINI_API_KEY colliding with GOOGLE_CLOUD_PROJECT OAuth) or stale local OAuth consent/ADC cache.",
      steps: [
        "Unset conflicting env vars so only ONE auth mode (API Key OR Google Cloud OAuth) is active.",
        "Revoke stale third-party authorization at https://myaccount.google.com/connections if OAuth is stuck.",
        "Clear local auth cache and re-authenticate cleanly.",
      ],
      commands: [
        { label: "Unset conflicting API key vars", os: "unix", command: "unset GEMINI_API_KEY GOOGLE_API_KEY" },
        { label: "Set GCP project for OAuth/Vertex", os: "unix", command: "export GOOGLE_CLOUD_PROJECT=your-gcp-project-id" },
        { label: "Refresh Application Default Credentials", os: "all", command: "gcloud auth application-default login" },
      ],
      verify_command: "gcloud auth application-default print-access-token >/dev/null && echo OK",
      dont_dos: [
        "Do NOT paste OAuth tokens or API keys into public issue trackers or MCP logs.",
        "Do NOT mix Vertex AI GOOGLE_CLOUD_PROJECT with AI Studio GEMINI_API_KEY in the same shell.",
      ],
      deep_link: "https://modelcraft.dev/fix/auth/403-auth-mismatch",
    },
  },
  {
    id: "503-504-stall",
    domain: "capacity",
    regex:
      /\b503\b|\b504\b|No\s*capacity|DEADLINE_EXCEEDED|UNAVAILABLE|antigravity-unleash\.goog|overloaded/i,
    fallback: {
      id: "503-504-stall",
      slug: "503-504-stall",
      provider: "google",
      route_provider: "google",
      domain: "capacity",
      title: "503 No Capacity / 504 DEADLINE_EXCEEDED / Stall",
      severity: "high",
      products: ["agy", "cli", "api"],
      error_codes: ["503", "504", "UNAVAILABLE", "DEADLINE_EXCEEDED"],
      error_patterns: ["503", "504", "DEADLINE_EXCEEDED", "No capacity"],
      root_cause:
        "Upstream model capacity saturation (503) or oversized uncompacted prompt context exceeding backend deadline (504).",
      steps: [
        "Check ModelCraft live upstream status to confirm whether a global 503 wave is active.",
        "If upstream is healthy and you hit 504: add a `.geminiignore` file, run `/compact`, and split the task.",
        "Temporarily switch from flagship Neon to Hydrogen or Flash until capacity recovers.",
      ],
      commands: [
        { label: "Check context hygiene & .geminiignore", os: "all", command: "npx agycraft-mcp doctor" },
      ],
      verify_command: "curl -sI https://modelcraft.dev/data/v1/status.json | head -n 1",
      dont_dos: [
        "Do NOT keep retrying massive 500k+ token prompts on 504 without compacting context first.",
      ],
      deep_link: "https://modelcraft.dev/fix/capacity/503-504-stall",
    },
  },
  {
    id: "mcp-disconnected",
    domain: "mcp",
    regex:
      /MCP.*Disconnected|EADDRINUSE|httpUrl|streamable.*http|gemini\s+trust|transport.*closed|ENOENT.*npx/i,
    fallback: {
      id: "mcp-disconnected",
      slug: "mcp-disconnected",
      provider: "antigravity",
      route_provider: "agy",
      domain: "mcp",
      title: "MCP Disconnected / Transport Mismatch / Env Stripped",
      severity: "high",
      products: ["agy", "cli"],
      error_codes: ["EADDRINUSE", "MCP_DISCONNECTED"],
      error_patterns: ["MCP Disconnected", "EADDRINUSE", "httpUrl"],
      root_cause:
        "Untrusted workspace directory, `url` (SSE) vs `httpUrl` (Streamable HTTP) key mismatch, port conflict (EADDRINUSE), or `*TOKEN*`/`*KEY*`/`*SECRET*` env vars stripped from MCP child process.",
      steps: [
        "Trust the workspace directory with `gemini trust`.",
        "Run `npx agycraft-mcp doctor` to check JSON syntax, `url` vs `httpUrl`, and env key stripping.",
        "Pass required credentials explicitly inside the server's `env` block in mcp_config.json / settings.json.",
      ],
      commands: [
        { label: "Trust workspace", os: "all", command: "gemini trust" },
        { label: "Run offline config doctor", os: "all", command: "npx agycraft-mcp doctor" },
        { label: "List active MCP servers", os: "all", command: "gemini mcp list" },
      ],
      verify_command: "gemini mcp list",
      dont_dos: [
        "Do NOT log debug text to stdout in stdio MCP servers — stdout is reserved for JSON-RPC frames.",
        "Do NOT set both `url` and `httpUrl` on the same MCP server entry.",
      ],
      deep_link: "https://modelcraft.dev/fix/mcp/mcp-disconnected",
    },
  },
  {
    id: "ssl-proxy",
    domain: "network",
    regex:
      /UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i,
    fallback: {
      id: "ssl-proxy",
      slug: "ssl-proxy",
      provider: "google",
      route_provider: "google",
      domain: "network",
      title: "Corporate Proxy / SSL Certificate Verification Failure",
      severity: "medium",
      products: ["agy", "cli", "api"],
      error_codes: ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN"],
      error_patterns: ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN"],
      root_cause:
        "Node.js does not automatically trust corporate TLS-inspecting proxy root certificates unless NODE_EXTRA_CA_CERTS is configured.",
      steps: [
        "Export your corporate root CA bundle in PEM format.",
        "Set `NODE_EXTRA_CA_CERTS` in your shell profile and verify the file is readable.",
        "Verify `HTTP_PROXY` / `HTTPS_PROXY` URLs are reachable.",
      ],
      commands: [
        { label: "Configure Node extra CA bundle", os: "unix", command: "export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem" },
        { label: "Verify SSL & proxy setup", os: "all", command: "npx agycraft-mcp doctor" },
      ],
      verify_command: "node -e \"fetch('https://modelcraft.dev/data/v1/status.json').then(r => console.log(r.status))\"",
      dont_dos: [
        "Do NOT permanently set `NODE_TLS_REJECT_UNAUTHORIZED=0` — it disables all TLS verification.",
      ],
      deep_link: "https://modelcraft.dev/fix/network/ssl-proxy",
    },
  },
  {
    id: "function-calling-state",
    domain: "protocol",
    regex:
      /thought_signature|function_call|function_response|FunctionCall|MALFORMED_FUNCTION_CALL|INVALID_ARGUMENT.*turn|tool_call_id/i,
    fallback: {
      id: "function-calling-state",
      slug: "function-calling-state",
      provider: "google",
      route_provider: "google",
      domain: "protocol",
      title: "Function Calling Turn Alignment / Missing thought_signature",
      severity: "medium",
      products: ["api", "cli", "agy"],
      error_codes: ["INVALID_ARGUMENT"],
      error_patterns: ["thought_signature", "function_call", "function_response"],
      root_cause:
        "Tool call/response turn sequence is misaligned, or Thinking-model `thought_signature` was stripped when replaying assistant tool calls.",
      steps: [
        "Preserve the exact `thought_signature` field on model `functionCall` parts when sending back `functionResponse` turns.",
        "Ensure every `functionCall` turn is immediately followed by matching `functionResponse` parts in the next user/tool turn.",
        "Upgrade `@google/genai` or `@google/gemini-cli` to the latest release.",
      ],
      commands: [
        { label: "Check latest Gemini CLI version", os: "all", command: "npm view @google/gemini-cli version" },
      ],
      verify_command: "Replay a single 2-turn tool call with unmodified model parts including thought_signature.",
      dont_dos: [
        "Do NOT manually reconstruct or strip unknown fields from model `parts` during multi-turn tool calling.",
      ],
      deep_link: "https://modelcraft.dev/fix/protocol/function-calling-state",
    },
  },
  {
    id: "structured-output-schema",
    domain: "protocol",
    regex:
      /response_schema|responseJsonSchema|nesting\s*depth|too\s*many\s*states|additionalProperties|INVALID_ARGUMENT.*schema/i,
    fallback: {
      id: "structured-output-schema",
      slug: "structured-output-schema",
      provider: "google",
      route_provider: "google",
      domain: "protocol",
      title: "Structured Output JSON Schema Too Deep or Unsupported Keyword",
      severity: "medium",
      products: ["api", "cli"],
      error_codes: ["INVALID_ARGUMENT"],
      error_patterns: ["response_schema", "nesting depth", "too many states"],
      root_cause:
        "Gemini constrained decoding rejects deeply nested schemas, recursive `$ref` cycles, or excessive union branches ('too many states').",
      steps: [
        "Flatten nested objects to <= 4 levels and remove recursive `$ref` definitions.",
        "Replace large `oneOf`/`anyOf` unions with a flat discriminator string enum + optional fields.",
        "Keep property descriptions concise so grammar compilation stays within state limits.",
      ],
      commands: [
        { label: "Run doctor preflight", os: "all", command: "npx agycraft-mcp doctor" },
      ],
      verify_command: "Re-run the API call with flattened JSON schema (depth <= 4, no recursive $ref).",
      dont_dos: [
        "Do NOT pass unconstrained TypeScript ASTs or OpenAPI specs directly as `response_schema`.",
      ],
      deep_link: "https://modelcraft.dev/fix/protocol/structured-output-schema",
    },
  },
];

function extractSignals(errorText: string): {
  http_status: string | null;
  retry_delay: string | null;
  quota_metric: string | null;
} {
  const httpMatch = errorText.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/);
  const retryMatch = errorText.match(/retryDelay["']?\s*[:=]\s*["']?([0-9.]+s?)/i);
  const metricMatch = errorText.match(/quotaMetric["']?\s*[:=]\s*["']?([a-zA-Z0-9._/-]+)/i);

  return {
    http_status: httpMatch?.[1] ?? null,
    retry_delay: retryMatch?.[1] ?? null,
    quota_metric: metricMatch?.[1] ?? null,
  };
}

export function diagnoseError(options: {
  errorText: string;
  product?: string;
  localRecords?: UsageRecord[];
  statusSnapshot?: StatusSnapshot | null;
  diagnosisEntries?: DiagnosisEntry[];
  nowMs?: number;
}): DiagnosisResult {
  const text = options.errorText;
  const lowerText = text.toLowerCase();
  const signals = extractSignals(text);
  const nowMs = options.nowMs ?? Date.now();
  const upstreamStatus = options.statusSnapshot?.overall_status ?? "unknown";
  const hasActiveIncident =
    upstreamStatus === "degraded" ||
    upstreamStatus === "outage" ||
    (options.statusSnapshot?.active_incidents?.some(
      (i) => i.status !== "resolved",
    ) ??
      false);

  // Match against built-in regex rules first for precision, then enrich from remote diagnosis entries
  let matchedRule: PatternRule | null = null;
  for (const rule of BUILTIN_RULES) {
    if (rule.regex.test(text)) {
      matchedRule = rule;
      break;
    }
  }

  let remoteMatch: DiagnosisEntry | null = null;
  let bestScore = 0;
  for (const entry of options.diagnosisEntries ?? []) {
    let score = 0;
    const codeSet = new Set((entry.error_codes ?? []).map((c) => c.toLowerCase()));
    for (const p of entry.error_patterns ?? []) {
      const lp = p.toLowerCase();
      if (lowerText.includes(lp)) {
        score += codeSet.has(lp) ? 2 : 10;
      }
    }
    for (const c of entry.error_codes ?? []) {
      if (lowerText.includes(c.toLowerCase())) {
        score += 2;
      }
    }
    if (matchedRule && (entry.id === matchedRule.id || entry.slug === matchedRule.id)) {
      score += 25;
    }
    if (score > bestScore) {
      bestScore = score;
      remoteMatch = entry;
    }
  }

  const chosen = remoteMatch ?? matchedRule?.fallback ?? null;

  if (!chosen) {
    return {
      matched: false,
      domain: "unknown",
      diagnosis_id: "unclassified",
      title: "Unclassified Error",
      confidence: "low",
      attribution: hasActiveIncident
        ? `Upstream status is currently "${upstreamStatus}" — this may be related to an active provider incident.`
        : "No known fault signature matched. Run `npx agycraft-mcp doctor` to check local environment hygiene.",
      root_cause:
        "Error text did not match the 5 primary fault domains (quota, auth, capacity, mcp, network) or protocol signatures.",
      steps: [
        "Run `npx agycraft-mcp doctor` to inspect local config syntax, auth env booleans, and proxy settings.",
        "Check https://modelcraft.dev/fix for the latest community-verified troubleshooting guides.",
      ],
      commands: [
        { label: "Run local preflight doctor", os: "all", command: "npx agycraft-mcp doctor" },
      ],
      verify_command: "npx agycraft-mcp doctor",
      dont_dos: [
        "Do NOT paste raw API keys, OAuth tokens, or private code when asking for help.",
      ],
      deep_link: "https://modelcraft.dev/fix",
      official_source_url: "https://aistudio.google.com/docs/troubleshooting",
      upstream_status: upstreamStatus,
      extracted_signals: signals,
    };
  }

  // Cross-correlate local 5h usage & upstream status for attribution
  let attribution = `Matched fault domain: ${chosen.domain}.`;
  if (chosen.domain === "quota") {
    const fiveHoursAgo = nowMs - 5 * 3600 * 1000;
    const recentRecords = (options.localRecords ?? []).filter(
      (r) => Date.parse(r.ts) >= fiveHoursAgo,
    );
    const recentTokens = recentRecords.reduce(
      (sum, r) => sum + r.input_tokens + r.output_tokens,
      0,
    );
    if (lowerText.includes("limit: 0") || (recentRecords.length > 0 && recentTokens < 50_000)) {
      attribution =
        "LIKELY FALSE EXHAUSTION / ENTITLEMENT DESYNC: Local 5h usage is very low (<50k tokens) or `limit: 0` was returned. Check billing/account sync or Reset Onboarding before waiting.";
    } else if (recentTokens >= 500_000) {
      attribution = `REAL QUOTA CAP: Local 5h usage is high (${recentTokens.toLocaleString()} tokens across ${recentRecords.length} turns). Switch to a lighter model (Hydrogen/Flash) and wait for rolling 5h relief.`;
    } else if (hasActiveIncident) {
      attribution = `POSSIBLE UPSTREAM INCIDENT: Upstream status is "${upstreamStatus}" — 429s may be caused by upstream throttling.`;
    } else {
      attribution =
        "QUOTA / RATE LIMIT HIT: Enable local numeric usage logging (`npx agycraft-mcp setup`) to distinguish real 5h/7d exhaustion from entitlement desync.";
    }
  } else if (chosen.domain === "capacity") {
    attribution = hasActiveIncident
      ? `UPSTREAM OUTAGE/DEGRADATION CONFIRMED (${upstreamStatus}): Not a local machine issue. Wait for recovery or temporarily switch to Flash/Hydrogen.`
      : "LOCAL CONTEXT OR TRANSIENT CAPACITY SPIKE: Upstream status appears operational; check for oversized context (>200k tokens) and add `.geminiignore`.";
  }

  return {
    matched: true,
    domain: chosen.domain,
    diagnosis_id: chosen.id,
    title: chosen.title,
    confidence: "high",
    attribution,
    root_cause: chosen.root_cause,
    steps: chosen.steps,
    commands: chosen.commands,
    verify_command: chosen.verify_command,
    dont_dos: chosen.dont_dos,
    deep_link: chosen.deep_link.startsWith("/")
      ? `https://modelcraft.dev${chosen.deep_link}`
      : chosen.deep_link,
    official_source_url: chosen.official_source_url ?? null,
    upstream_status: upstreamStatus,
    extracted_signals: signals,
  };
}
