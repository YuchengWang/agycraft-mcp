import { readFile } from "node:fs/promises";
import { getDefaultGeminiTelemetryPath } from "../paths.js";
import {
  type UsageRecord,
  hashSessionId,
  sanitizeUsagePayload,
} from "./agy-hook.js";

/**
 * Readonly parser for Gemini CLI OpenTelemetry outfile (~/.gemini/telemetry_stats.jsonl).
 * PRIVACY RED LINE: Only extracts numeric token counts, model name, timestamp, error code,
 * and hashed session ID. Explicitly ignores any prompt/completion body even if present.
 */
export async function readGeminiOtelRecords(options?: {
  otelPath?: string;
  sinceMs?: number;
  salt?: string;
}): Promise<UsageRecord[]> {
  const otelPath = options?.otelPath ?? getDefaultGeminiTelemetryPath();
  const salt = options?.salt ?? "gemini-otel-readonly-salt";

  let content: string;
  try {
    content = await readFile(otelPath, "utf8");
  } catch {
    return [];
  }

  const records: UsageRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      const attrs = extractOtelAttributes(entry);

      const inputTokens = firstNumber(
        attrs["gen_ai.usage.input_tokens"],
        attrs["input_token_count"],
        attrs["prompt_tokens"],
        entry["input_tokens"],
        entry["prompt_tokens"],
      );
      const outputTokens = firstNumber(
        attrs["gen_ai.usage.output_tokens"],
        attrs["output_token_count"],
        attrs["completion_tokens"],
        entry["output_tokens"],
        entry["completion_tokens"],
      );

      // Skip non-LLM spans that have no token usage and no error code
      const errorCode =
        attrs["error.type"] ??
        attrs["http.response.status_code"] ??
        entry["error_code"] ??
        null;
      if (inputTokens === 0 && outputTokens === 0 && !errorCode) {
        continue;
      }

      const rawSession = String(
        attrs["session.id"] ?? entry["session_id"] ?? "gemini-cli-session",
      );

      const record = sanitizeUsagePayload(
        {
          ts: entry["timestamp"] ?? entry["ts"] ?? entry["startTime"],
          provider: "google",
          product: "gemini-cli",
          session_hash: hashSessionId(rawSession, salt),
          model:
            attrs["gen_ai.request.model"] ??
            attrs["gen_ai.response.model"] ??
            attrs["model"] ??
            entry["model"] ??
            "unknown",
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          context_used_pct: attrs["context_used_pct"] ?? null,
          tool_calls: firstNumber(attrs["tool_calls"], entry["tool_calls"]),
          turn_index: firstNumber(attrs["turn_index"], entry["turn_index"]),
          error_code: errorCode,
        },
        salt,
      );

      if (options?.sinceMs !== undefined && Date.parse(record.ts) < options.sinceMs) {
        continue;
      }
      records.push(record);
    } catch {
      // Skip malformed lines safely
    }
  }

  return records;
}

function extractOtelAttributes(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const attrs = entry["attributes"];
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
    return attrs as Record<string, unknown>;
  }
  return {};
}

function firstNumber(...candidates: unknown[]): number {
  for (const val of candidates) {
    if (val === null || val === undefined || val === "") {
      continue;
    }
    const n = typeof val === "number" ? val : Number(val);
    if (Number.isFinite(n) && n >= 0) {
      return Math.floor(n);
    }
  }
  return 0;
}
