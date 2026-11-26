import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgyBrainDir } from "../paths.js";

/**
 * Pure structural metadata extracted from an AGY transcript.jsonl.
 * PRIVACY RED LINE: NEVER reads, stores, or returns prompt text, assistant text,
 * tool arguments, file paths, or code snippets. Only counts structural events.
 */
export interface TranscriptStructuralMeta {
  total_steps: number;
  user_turns: number;
  assistant_turns: number;
  tool_call_count: number;
  tool_error_count: number;
  max_consecutive_tool_failures: number;
  consecutive_failure_tool_type: string | null;
  has_compact_event: boolean;
  steps_since_last_compact: number;
  loop_detected: boolean;
}

const SAFE_TOOL_NAME_RE = /^[a-zA-Z0-9._-]{1,48}$/;

function sanitizeToolCategory(raw: unknown): string {
  if (typeof raw !== "string") {
    return "unknown_tool";
  }
  const trimmed = raw.trim();
  if (SAFE_TOOL_NAME_RE.test(trimmed)) {
    return trimmed;
  }
  return "unknown_tool";
}

/**
 * Parses a transcript.jsonl file strictly for structural counters.
 * Never accesses or retains message content/text/arguments/paths.
 */
export async function analyzeTranscriptStructure(
  transcriptPath: string,
  loopThreshold = 4,
): Promise<TranscriptStructuralMeta> {
  let rawText: string;
  try {
    rawText = await readFile(transcriptPath, "utf8");
  } catch {
    return emptyTranscriptMeta();
  }
  return parseTranscriptLines(rawText.split("\n"), loopThreshold);
}

export function parseTranscriptLines(
  lines: string[],
  loopThreshold = 4,
): TranscriptStructuralMeta {
  let totalSteps = 0;
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let hasCompactEvent = false;
  let stepsSinceLastCompact = 0;

  let currentStreak = 0;
  let currentStreakTool: string | null = null;
  let maxConsecutiveFailures = 0;
  let maxFailureTool: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    totalSteps += 1;
    stepsSinceLastCompact += 1;

    const role = typeof parsed.role === "string" ? parsed.role.toLowerCase() : "";
    const eventType =
      typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";

    if (eventType === "compact" || eventType === "compaction") {
      hasCompactEvent = true;
      stepsSinceLastCompact = 0;
      continue;
    }

    if (role === "user" || eventType === "user_message") {
      userTurns += 1;
      // Human intervention resets autonomous failure streak
      currentStreak = 0;
      currentStreakTool = null;
    } else if (role === "assistant" || role === "model" || eventType === "assistant_message") {
      assistantTurns += 1;
    }

    const isToolEvent =
      role === "tool" ||
      eventType === "tool_call" ||
      eventType === "tool_result" ||
      Boolean(parsed.tool_name);

    if (isToolEvent) {
      toolCallCount += 1;
      const toolName = sanitizeToolCategory(parsed.tool_name ?? parsed.name);
      const failed =
        parsed.is_error === true ||
        parsed.status === "error" ||
        parsed.status === "failed" ||
        (typeof parsed.exit_code === "number" && parsed.exit_code !== 0);

      if (failed) {
        toolErrorCount += 1;
        if (currentStreakTool === toolName) {
          currentStreak += 1;
        } else {
          currentStreak = 1;
          currentStreakTool = toolName;
        }
        if (currentStreak > maxConsecutiveFailures) {
          maxConsecutiveFailures = currentStreak;
          maxFailureTool = toolName;
        }
      } else {
        currentStreak = 0;
        currentStreakTool = null;
      }
    }
  }

  return {
    total_steps: totalSteps,
    user_turns: userTurns,
    assistant_turns: assistantTurns,
    tool_call_count: toolCallCount,
    tool_error_count: toolErrorCount,
    max_consecutive_tool_failures: maxConsecutiveFailures,
    consecutive_failure_tool_type: maxFailureTool,
    has_compact_event: hasCompactEvent,
    steps_since_last_compact: stepsSinceLastCompact,
    loop_detected: maxConsecutiveFailures >= loopThreshold,
  };
}

export function emptyTranscriptMeta(): TranscriptStructuralMeta {
  return {
    total_steps: 0,
    user_turns: 0,
    assistant_turns: 0,
    tool_call_count: 0,
    tool_error_count: 0,
    max_consecutive_tool_failures: 0,
    consecutive_failure_tool_type: null,
    has_compact_event: false,
    steps_since_last_compact: 0,
    loop_detected: false,
  };
}

export interface TranscriptWindowSummary {
  session_count: number;
  turn_count: number;
  tool_call_count: number;
  earliest_turn_at: string | null;
}

export interface TranscriptActivityFallback {
  source: "transcript_timestamps";
  note: string;
  timezone: string;
  window_5h: TranscriptWindowSummary & {
    estimated_5h_reset_at: string | null;
    estimated_5h_reset_local: string | null;
  };
  window_7d: TranscriptWindowSummary;
  earliest_turn_5h_ms: number | null;
  earliest_turn_7d_ms: number | null;
}

function extractStructuralTimestampMs(parsed: Record<string, unknown>): number | null {
  const raw = parsed.created_at ?? parsed.timestamp ?? parsed.ts;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  return null;
}

function formatLocalIsoish(ms: number, timezone?: string): string {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Scans ~/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl
 * strictly for structural timestamps, step/turn counts, and tool-call indicators.
 * PRIVACY RED LINE: NEVER reads, stores, or returns prompt text, model responses,
 * code diffs, file paths, or session UUIDs.
 */
export async function scanTranscriptActivity(options?: {
  brainDir?: string;
  nowMs?: number;
  timezone?: string;
}): Promise<TranscriptActivityFallback> {
  const brainDir = options?.brainDir ?? getAgyBrainDir();
  const nowMs = options?.nowMs ?? Date.now();
  const tz = options?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const cutoff5h = nowMs - 5 * 3600 * 1000;
  const cutoff7d = nowMs - 7 * 86400 * 1000;

  let sessions5h = 0;
  let turns5h = 0;
  let tools5h = 0;
  let earliest5h: number | null = null;

  let sessions7d = 0;
  let turns7d = 0;
  let tools7d = 0;
  let earliest7d: number | null = null;

  let sessionDirs: string[] = [];
  try {
    const entries = await readdir(brainDir, { withFileTypes: true });
    sessionDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    sessionDirs = [];
  }

  for (const dirName of sessionDirs) {
    const transcriptPath = join(brainDir, dirName, ".system_generated", "logs", "transcript.jsonl");
    let rawText: string;
    try {
      rawText = await readFile(transcriptPath, "utf8");
    } catch {
      continue;
    }

    let seenIn5h = false;
    let seenIn7d = false;

    for (const line of rawText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      const tsMs = extractStructuralTimestampMs(parsed);
      if (tsMs === null || tsMs < cutoff7d || tsMs > nowMs + 60_000) {
        continue;
      }

      const typeStr = typeof parsed.type === "string" ? parsed.type.toUpperCase() : "";
      const sourceStr = typeof parsed.source === "string" ? parsed.source.toUpperCase() : "";
      const roleStr = typeof parsed.role === "string" ? parsed.role.toLowerCase() : "";

      const isTurn =
        typeStr === "USER_INPUT" ||
        typeStr === "PLANNER_RESPONSE" ||
        typeStr === "USER_MESSAGE" ||
        typeStr === "ASSISTANT_MESSAGE" ||
        sourceStr === "USER_EXPLICIT" ||
        sourceStr === "MODEL" ||
        roleStr === "user" ||
        roleStr === "assistant" ||
        roleStr === "model" ||
        typeof parsed.step_index === "number";

      const isTool =
        typeStr === "TOOL_CALL" ||
        typeStr === "TOOL_RESULT" ||
        roleStr === "tool" ||
        Boolean(parsed.tool_name);

      if (tsMs >= cutoff7d) {
        seenIn7d = true;
        if (isTurn) turns7d += 1;
        if (isTool) tools7d += 1;
        if (earliest7d === null || tsMs < earliest7d) {
          earliest7d = tsMs;
        }
      }

      if (tsMs >= cutoff5h) {
        seenIn5h = true;
        if (isTurn) turns5h += 1;
        if (isTool) tools5h += 1;
        if (earliest5h === null || tsMs < earliest5h) {
          earliest5h = tsMs;
        }
      }
    }

    if (seenIn5h) sessions5h += 1;
    if (seenIn7d) sessions7d += 1;
  }

  const reset5hMs = earliest5h !== null ? earliest5h + 5 * 3600 * 1000 : null;

  return {
    source: "transcript_timestamps",
    note: "Estimated from local AGY session timestamps; run agycraft-mcp setup for exact token counts.",
    timezone: tz,
    window_5h: {
      session_count: sessions5h,
      turn_count: turns5h,
      tool_call_count: tools5h,
      earliest_turn_at: earliest5h !== null ? new Date(earliest5h).toISOString() : null,
      estimated_5h_reset_at: reset5hMs !== null ? new Date(reset5hMs).toISOString() : null,
      estimated_5h_reset_local: reset5hMs !== null ? formatLocalIsoish(reset5hMs, tz) : null,
    },
    window_7d: {
      session_count: sessions7d,
      turn_count: turns7d,
      tool_call_count: tools7d,
      earliest_turn_at: earliest7d !== null ? new Date(earliest7d).toISOString() : null,
    },
    earliest_turn_5h_ms: earliest5h,
    earliest_turn_7d_ms: earliest7d,
  };
}
