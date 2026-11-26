/**
 * Pure local reset countdown calculator for Gemini API / AI Studio PT midnight
 * and AGY 5-hour / 7-day rolling shared quota windows.
 */
export interface ResetCountdown {
  timezone: string;
  now_iso: string;
  pt_midnight: {
    next_reset_iso: string;
    next_reset_local: string;
    remaining_seconds: number;
    remaining_human: string;
  };
  rolling_5h: {
    window_hours: 5;
    is_local_estimate: true;
    estimate_note: string;
    oldest_active_event_iso: string | null;
    estimated_relief_iso: string | null;
    estimated_relief_local: string | null;
    remaining_seconds: number | null;
    remaining_human: string;
  };
  rolling_7d: {
    window_days: 7;
    is_local_estimate: true;
    estimate_note: string;
    oldest_active_event_iso: string | null;
    estimated_relief_iso: string | null;
    estimated_relief_local: string | null;
    remaining_seconds: number | null;
    remaining_human: string;
  };
}

const ROLLING_ESTIMATE_NOTE =
  "Approximated solely from the earliest local event timestamp in this window; does not reflect server-side multi-device usage or official remaining quota percentages.";

export function formatDuration(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const days = Math.floor(clamped / 86400);
  const hours = Math.floor((clamped % 86400) / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

function validateTimezone(tz?: string): string {
  if (!tz) {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function getPtDateParts(now: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === 24 ? 0 : get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Computes the exact next midnight in America/Los_Angeles (handles PST/PDT transitions).
 */
export function computeNextPtMidnight(now: Date): Date {
  const pt = getPtDateParts(now);
  const remainingTodaySec =
    (23 - pt.hour) * 3600 + (59 - pt.minute) * 60 + (60 - pt.second);
  // Step forward to approximate next PT midnight, then refine to exact 00:00:00 PT
  let candidate = new Date(now.getTime() + remainingTodaySec * 1000);
  // Adjust by up to +/-1h if DST switched overnight
  for (let i = 0; i < 3; i++) {
    const check = getPtDateParts(candidate);
    if (check.hour === 0 && check.minute === 0 && check.second === 0) {
      break;
    }
    if (check.hour >= 22) {
      candidate = new Date(
        candidate.getTime() + ((24 - check.hour) * 3600 - check.minute * 60 - check.second) * 1000,
      );
    } else if (check.hour <= 2) {
      candidate = new Date(
        candidate.getTime() - (check.hour * 3600 + check.minute * 60 + check.second) * 1000,
      );
    }
  }
  return candidate;
}

export function computeResetCountdown(options?: {
  now?: Date;
  timezone?: string;
  oldestEventIn5hMs?: number | null;
  oldestEventIn7dMs?: number | null;
}): ResetCountdown {
  const now = options?.now ?? new Date();
  const tz = validateTimezone(options?.timezone);

  const nextPt = computeNextPtMidnight(now);
  const ptRemainingSec = Math.max(
    0,
    Math.floor((nextPt.getTime() - now.getTime()) / 1000),
  );
  const nextPtLocal = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(nextPt);

  const fiveHoursMs = 5 * 3600 * 1000;
  const sevenDaysMs = 7 * 86400 * 1000;

  let relief5hIso: string | null = null;
  let relief5hLocal: string | null = null;
  let relief5hSec: number | null = null;
  if (options?.oldestEventIn5hMs) {
    const reliefMs = options.oldestEventIn5hMs + fiveHoursMs;
    relief5hIso = new Date(reliefMs).toISOString();
    relief5hLocal = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(reliefMs));
    relief5hSec = Math.max(0, Math.floor((reliefMs - now.getTime()) / 1000));
  }

  let relief7dIso: string | null = null;
  let relief7dLocal: string | null = null;
  let relief7dSec: number | null = null;
  if (options?.oldestEventIn7dMs) {
    const reliefMs = options.oldestEventIn7dMs + sevenDaysMs;
    relief7dIso = new Date(reliefMs).toISOString();
    relief7dLocal = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(reliefMs));
    relief7dSec = Math.max(0, Math.floor((reliefMs - now.getTime()) / 1000));
  }

  return {
    timezone: tz,
    now_iso: now.toISOString(),
    pt_midnight: {
      next_reset_iso: nextPt.toISOString(),
      next_reset_local: nextPtLocal,
      remaining_seconds: ptRemainingSec,
      remaining_human: formatDuration(ptRemainingSec),
    },
    rolling_5h: {
      window_hours: 5,
      is_local_estimate: true,
      estimate_note: ROLLING_ESTIMATE_NOTE,
      oldest_active_event_iso: options?.oldestEventIn5hMs
        ? new Date(options.oldestEventIn5hMs).toISOString()
        : null,
      estimated_relief_iso: relief5hIso,
      estimated_relief_local: relief5hLocal,
      remaining_seconds: relief5hSec,
      remaining_human:
        relief5hSec !== null
          ? formatDuration(relief5hSec)
          : "No active usage recorded in last 5h",
    },
    rolling_7d: {
      window_days: 7,
      is_local_estimate: true,
      estimate_note: ROLLING_ESTIMATE_NOTE,
      oldest_active_event_iso: options?.oldestEventIn7dMs
        ? new Date(options.oldestEventIn7dMs).toISOString()
        : null,
      estimated_relief_iso: relief7dIso,
      estimated_relief_local: relief7dLocal,
      remaining_seconds: relief7dSec,
      remaining_human:
        relief7dSec !== null
          ? formatDuration(relief7dSec)
          : "No active usage recorded in last 7d",
    },
  };
}
