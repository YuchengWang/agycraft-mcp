import type { UsageRecord } from "../collectors/agy-hook.js";
import type { ModelEntry } from "../types.js";

export type UsageWindow = "5h" | "24h" | "7d";

export interface ModelUsageBreakdown {
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_input_usd: number;
  estimated_output_and_thinking_usd: number;
  estimated_total_usd: number;
  shared_bucket_cost_tier: string;
}

export interface TokenWindowAnalysis {
  window: UsageWindow;
  product_filter: string;
  data_mode: "exact_token_logs" | "hook_events_without_tokens" | "transcript_timestamps_only";
  usage_note?: string;
  record_count: number;
  session_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  error_count: number;
  rate_limit_429_count: number;
  peak_context_used_pct: number | null;
  oldest_event_ms: number | null;
  shared_bucket_risk: "low" | "moderate" | "high" | "critical";
  thinking_cost_estimate: {
    estimated_input_usd: number;
    estimated_output_and_thinking_usd: number;
    estimated_total_usd: number;
    output_cost_share_pct: number;
    note: string;
  };
  implicit_cache_check: {
    threshold_tokens: 4096;
    multi_turn_new_tokens_min: 2050;
    turns_below_threshold: number;
    turns_above_threshold: number;
    below_threshold_pct: number;
    eligible_for_implicit_cache: boolean;
    official_source_url: string;
    guidance: string;
  };
  by_model: ModelUsageBreakdown[];
}

const WINDOW_MS: Record<UsageWindow, number> = {
  "5h": 5 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const DEFAULT_PRICING = {
  input_per_1m_usd: 1.25,
  output_per_1m_usd: 10.0,
};

const IMPLICIT_CACHE_MIN_TOKENS = 4096;

function findModelPricing(
  modelId: string,
  catalog: ModelEntry[],
): { input: number; output: number; tier: string } {
  const lower = modelId.toLowerCase();
  const exact = catalog.find(
    (m) =>
      m.id.toLowerCase() === lower ||
      m.api_model_id.toLowerCase() === lower ||
      m.display_name.toLowerCase() === lower ||
      (m.codename && m.codename.toLowerCase() === lower),
  );
  const partial =
    exact ??
    catalog.find(
      (m) =>
        lower.includes(m.id.toLowerCase()) ||
        m.id.toLowerCase().includes(lower) ||
        lower.includes(m.api_model_id.toLowerCase()) ||
        (m.codename && lower.includes(m.codename.toLowerCase())),
    );

  if (partial?.pricing) {
    return {
      input: partial.pricing.input_per_1m_usd,
      output: partial.pricing.output_per_1m_usd,
      tier: partial.quota_profile?.shared_bucket_cost_tier ?? "medium",
    };
  }
  if (lower.includes("flash-lite") || lower.includes("lite")) {
    return { input: 0.1, output: 0.4, tier: "low" };
  }
  if (lower.includes("flash") || lower.includes("hydrogen")) {
    return { input: 0.3, output: 2.5, tier: "low" };
  }
  if (lower.includes("neon") || lower.includes("pro") || lower.includes("carbon")) {
    return { input: 2.0, output: 12.0, tier: "high" };
  }
  return {
    input: DEFAULT_PRICING.input_per_1m_usd,
    output: DEFAULT_PRICING.output_per_1m_usd,
    tier: "medium",
  };
}

export function analyzeTokenWindow(
  records: UsageRecord[],
  options: {
    window: UsageWindow;
    product?: string;
    models?: ModelEntry[];
    nowMs?: number;
  },
): TokenWindowAnalysis {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - WINDOW_MS[options.window];
  const catalog = options.models ?? [];

  const filtered = records.filter((r) => {
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts) || ts < cutoffMs) {
      return false;
    }
    if (
      options.product &&
      options.product !== "all" &&
      r.product !== options.product
    ) {
      return false;
    }
    return true;
  });

  let totalInput = 0;
  let totalOutput = 0;
  let errorCount = 0;
  let rateLimit429Count = 0;
  let peakCtxPct: number | null = null;
  let oldestMs: number | null = null;
  let belowCacheThreshold = 0;
  let aboveCacheThreshold = 0;

  const sessions = new Set<string>();
  const modelMap = new Map<
    string,
    {
      requests: number;
      input: number;
      output: number;
    }
  >();

  for (const r of filtered) {
    totalInput += r.input_tokens;
    totalOutput += r.output_tokens;
    sessions.add(r.session_hash);

    const ts = Date.parse(r.ts);
    if (!Number.isNaN(ts) && (oldestMs === null || ts < oldestMs)) {
      oldestMs = ts;
    }

    if (r.error_code) {
      errorCount += 1;
      if (r.error_code.includes("429") || r.error_code.includes("RESOURCE_EXHAUSTED")) {
        rateLimit429Count += 1;
      }
    }

    if (r.context_used_pct !== null) {
      peakCtxPct =
        peakCtxPct === null
          ? r.context_used_pct
          : Math.max(peakCtxPct, r.context_used_pct);
    }

    if (r.input_tokens > 0) {
      if (r.input_tokens < IMPLICIT_CACHE_MIN_TOKENS) {
        belowCacheThreshold += 1;
      } else {
        aboveCacheThreshold += 1;
      }
    }

    const agg = modelMap.get(r.model) ?? { requests: 0, input: 0, output: 0 };
    agg.requests += 1;
    agg.input += r.input_tokens;
    agg.output += r.output_tokens;
    modelMap.set(r.model, agg);
  }

  let totalInputUsd = 0;
  let totalOutputUsd = 0;
  const byModel: ModelUsageBreakdown[] = [];

  for (const [model, agg] of modelMap.entries()) {
    const pricing = findModelPricing(model, catalog);
    const inUsd = (agg.input / 1_000_000) * pricing.input;
    const outUsd = (agg.output / 1_000_000) * pricing.output;
    totalInputUsd += inUsd;
    totalOutputUsd += outUsd;

    byModel.push({
      model,
      requests: agg.requests,
      input_tokens: agg.input,
      output_tokens: agg.output,
      total_tokens: agg.input + agg.output,
      estimated_input_usd: round4(inUsd),
      estimated_output_and_thinking_usd: round4(outUsd),
      estimated_total_usd: round4(inUsd + outUsd),
      shared_bucket_cost_tier: pricing.tier,
    });
  }

  byModel.sort((a, b) => b.total_tokens - a.total_tokens);

  const totalTokens = totalInput + totalOutput;
  const dataMode = resolveDataMode(filtered.length, totalTokens);
  const usageNote =
    dataMode === "hook_events_without_tokens"
      ? `Local hook events (${filtered.length} record(s)) were recorded without token or model fields. Refer to the official AGY/CLI quota UI for authoritative remaining %, or enable Gemini CLI OTel for exact local token counts.`
      : undefined;
  const totalUsd = totalInputUsd + totalOutputUsd;
  const outputCostSharePct =
    totalUsd > 0 ? Math.round((totalOutputUsd / totalUsd) * 1000) / 10 : 0;

  const totalTokenTurns = belowCacheThreshold + aboveCacheThreshold;
  const belowPct =
    totalTokenTurns > 0
      ? Math.round((belowCacheThreshold / totalTokenTurns) * 1000) / 10
      : 0;

  const risk = assessSharedBucketRisk(
    options.window,
    totalTokens,
    rateLimit429Count,
    byModel,
  );

  const cacheGuidance =
    filtered.length === 0
      ? "No local usage records in this window yet. Run `npx agycraft-mcp setup` to enable numeric-only local logging. (Gemini 4 implicit cache requires >=4,096 min input tokens + >=2,050 new tokens per turn to cache the full previous request.)"
      : totalTokenTurns === 0
        ? `Local hook events (${filtered.length} record(s)) were recorded without token/model fields, so implicit cache eligibility cannot be measured locally. Refer to the official AGY/CLI quota UI for authoritative remaining %, or enable Gemini CLI OTel for exact local token counts.`
        : belowPct >= 60
          ? `${belowPct}% of turns had <4,096 input tokens and cannot trigger Gemini implicit KV caching. Keep stable system/context prefix >=4,096 tokens (and >=2,050 new tokens per turn for multi-turn full-request caching).`
          : "Most turns exceed the 4,096-token implicit cache floor; for multi-turn sessions, >=2,050 new tokens per turn caches the full previous request — keep prompt prefixes stable.";

  return {
    window: options.window,
    product_filter: options.product ?? "all",
    data_mode: dataMode,
    ...(usageNote ? { usage_note: usageNote } : {}),
    record_count: filtered.length,
    session_count: sessions.size,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_tokens: totalTokens,
    error_count: errorCount,
    rate_limit_429_count: rateLimit429Count,
    peak_context_used_pct: peakCtxPct,
    oldest_event_ms: oldestMs,
    shared_bucket_risk: risk,
    thinking_cost_estimate: {
      estimated_input_usd: round4(totalInputUsd),
      estimated_output_and_thinking_usd: round4(totalOutputUsd),
      estimated_total_usd: round4(totalUsd),
      output_cost_share_pct: outputCostSharePct,
      note: "Thinking tokens are billed at output rates (typically 4x–8x input cost). High output cost share signals a Thinking-budget or model-tier optimization opportunity.",
    },
    implicit_cache_check: {
      threshold_tokens: IMPLICIT_CACHE_MIN_TOKENS,
      multi_turn_new_tokens_min: 2050,
      turns_below_threshold: belowCacheThreshold,
      turns_above_threshold: aboveCacheThreshold,
      below_threshold_pct: belowPct,
      eligible_for_implicit_cache: aboveCacheThreshold > 0,
      official_source_url: "https://aistudio.google.com/docs/caching",
      guidance: cacheGuidance,
    },
    by_model: byModel,
  };
}

export function resolveDataMode(
  recordCount: number,
  totalTokens: number,
): "exact_token_logs" | "hook_events_without_tokens" | "transcript_timestamps_only" {
  if (recordCount === 0) {
    return "transcript_timestamps_only";
  }
  return totalTokens > 0 ? "exact_token_logs" : "hook_events_without_tokens";
}

function assessSharedBucketRisk(
  window: UsageWindow,
  totalTokens: number,
  rateLimit429Count: number,
  byModel: ModelUsageBreakdown[],
): "low" | "moderate" | "high" | "critical" {
  if (rateLimit429Count >= 3) {
    return "critical";
  }
  const heavyTokens = byModel
    .filter(
      (m) =>
        m.shared_bucket_cost_tier === "high" ||
        m.shared_bucket_cost_tier === "very_high",
    )
    .reduce((sum, m) => sum + m.total_tokens, 0);

  const scale = window === "5h" ? 1 : window === "24h" ? 3 : 10;
  if (totalTokens > 8_000_000 * scale || heavyTokens > 4_000_000 * scale) {
    return "critical";
  }
  if (totalTokens > 3_000_000 * scale || heavyTokens > 1_500_000 * scale || rateLimit429Count > 0) {
    return "high";
  }
  if (totalTokens > 1_000_000 * scale) {
    return "moderate";
  }
  return "low";
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
