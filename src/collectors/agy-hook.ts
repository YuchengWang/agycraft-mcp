import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getSaltFilePath, getUsageLogPath } from "../paths.js";

/**
 * Strict numeric/metadata whitelist for local usage telemetry.
 * PRIVACY RED LINE: NEVER add prompts, code, file paths, project names, emails, or account IDs.
 */
export interface UsageRecord {
  v: 1;
  ts: string;
  provider: "google" | "antigravity" | "other";
  product: "agy" | "gemini-cli" | "api" | "web";
  session_hash: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  context_used_pct: number | null;
  tool_calls: number;
  turn_index: number;
  error_code: string | null;
}

export const USAGE_RECORD_WHITELIST_KEYS = [
  "v",
  "ts",
  "provider",
  "product",
  "session_hash",
  "model",
  "input_tokens",
  "output_tokens",
  "context_used_pct",
  "tool_calls",
  "turn_index",
  "error_code",
] as const;

const ALLOWED_PROVIDERS = new Set(["google", "antigravity", "other"]);
const ALLOWED_PRODUCTS = new Set(["agy", "gemini-cli", "api", "web"]);
const SAFE_MODEL_RE = /^[a-zA-Z0-9._:-]{1,64}$/;
const SAFE_ERROR_CODE_RE = /^[A-Z0-9_:-]{1,48}$/;

let cachedSalt: string | null = null;

async function getOrCreateLocalSalt(saltPath = getSaltFilePath()): Promise<string> {
  if (cachedSalt) {
    return cachedSalt;
  }
  try {
    const existing = (await readFile(saltPath, "utf8")).trim();
    if (existing.length >= 16) {
      cachedSalt = existing;
      return existing;
    }
  } catch {
    // Salt file does not exist yet
  }
  const fresh = randomBytes(16).toString("hex");
  await mkdir(dirname(saltPath), { recursive: true });
  await writeFile(saltPath, fresh, { mode: 0o600 });
  cachedSalt = fresh;
  return fresh;
}

export function resetSaltCache(): void {
  cachedSalt = null;
}

export function hashSessionId(rawSessionId: string, salt: string): string {
  return createHash("sha256")
    .update(`${salt}:${rawSessionId}`)
    .digest("hex")
    .slice(0, 12);
}

function clampNonNegativeInt(val: unknown): number {
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.floor(n);
}

function clampPct(val: unknown): number | null {
  if (val === null || val === undefined || val === "") {
    return null;
  }
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
}

function sanitizeModelName(raw: unknown): string {
  if (typeof raw !== "string") {
    return "unknown";
  }
  const trimmed = raw.trim();
  // Reject anything that looks like a file path, email, or prompt text
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("@") ||
    trimmed.includes(" ") ||
    !SAFE_MODEL_RE.test(trimmed)
  ) {
    return "unknown";
  }
  return trimmed;
}

function sanitizeErrorCode(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const str = String(raw).trim().toUpperCase();
  if (SAFE_ERROR_CODE_RE.test(str)) {
    return str;
  }
  // Extract standard HTTP status code if embedded
  const httpMatch = str.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/);
  if (httpMatch?.[1]) {
    return httpMatch[1];
  }
  return "UNKNOWN_ERROR";
}

function sanitizeIsoTimestamp(raw: unknown): string {
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Strictly constructs a whitelisted UsageRecord from an arbitrary AGY hook / statusline payload.
 * Any non-whitelisted field (prompt, response, code, file_path, project, email, api_key, etc.)
 * is silently dropped and never serialized.
 */
export function sanitizeUsagePayload(
  raw: Record<string, unknown>,
  salt: string,
): UsageRecord {
  const ctx =
    raw.context_window && typeof raw.context_window === "object"
      ? (raw.context_window as Record<string, unknown>)
      : {};

  const providerRaw =
    typeof raw.provider === "string" ? raw.provider.toLowerCase() : "antigravity";
  const provider: UsageRecord["provider"] = ALLOWED_PROVIDERS.has(providerRaw)
    ? (providerRaw as UsageRecord["provider"])
    : "antigravity";

  const productRaw =
    typeof raw.product === "string" ? raw.product.toLowerCase() : "agy";
  const product: UsageRecord["product"] = ALLOWED_PRODUCTS.has(productRaw)
    ? (productRaw as UsageRecord["product"])
    : "agy";

  const sessionSource =
    typeof raw.session_hash === "string" && /^[a-f0-9]{8,16}$/.test(raw.session_hash)
      ? raw.session_hash
      : hashSessionId(
          typeof raw.session_id === "string"
            ? raw.session_id
            : typeof raw.conversation_id === "string"
              ? raw.conversation_id
              : "default-session",
          salt,
        );

  const inputTokens = clampNonNegativeInt(
    raw.input_tokens ?? ctx.input_tokens ?? raw.prompt_tokens ?? 0,
  );
  const outputTokens = clampNonNegativeInt(
    raw.output_tokens ?? ctx.output_tokens ?? raw.completion_tokens ?? 0,
  );
  const contextUsedPct = clampPct(
    raw.context_used_pct ?? ctx.used_pct ?? ctx.context_used_pct ?? null,
  );

  // Build strictly whitelisted object with exact keys
  return {
    v: 1,
    ts: sanitizeIsoTimestamp(raw.ts ?? raw.timestamp),
    provider,
    product,
    session_hash: sessionSource,
    model: sanitizeModelName(raw.model ?? ctx.model),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    context_used_pct: contextUsedPct,
    tool_calls: clampNonNegativeInt(raw.tool_calls ?? 0),
    turn_index: clampNonNegativeInt(raw.turn_index ?? 0),
    error_code: sanitizeErrorCode(raw.error_code ?? raw.status_code ?? null),
  };
}

export async function appendUsageRecord(
  rawPayload: Record<string, unknown>,
  options?: { logPath?: string; saltPath?: string },
): Promise<UsageRecord> {
  const logPath = options?.logPath ?? getUsageLogPath();
  const salt = await getOrCreateLocalSalt(options?.saltPath);
  const record = sanitizeUsagePayload(rawPayload, salt);
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return record;
}

export async function readUsageRecords(options?: {
  logPath?: string;
  sinceMs?: number;
  product?: "agy" | "gemini-cli" | "api" | "web" | "all";
}): Promise<UsageRecord[]> {
  const logPath = options?.logPath ?? getUsageLogPath();
  let content: string;
  try {
    content = await readFile(logPath, "utf8");
  } catch {
    return [];
  }

  const records: UsageRecord[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // Re-validate strictly on read as well
      const safe = sanitizeUsagePayload(parsed, "read-fallback-salt");
      if (options?.sinceMs !== undefined && Date.parse(safe.ts) < options.sinceMs) {
        continue;
      }
      if (
        options?.product &&
        options.product !== "all" &&
        safe.product !== options.product
      ) {
        continue;
      }
      records.push(safe);
    } catch {
      // Skip corrupted lines safely
    }
  }
  return records;
}
