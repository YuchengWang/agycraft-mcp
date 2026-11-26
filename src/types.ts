export type SnapshotName =
  | "models"
  | "chronicle"
  | "diagnosis"
  | "quotas"
  | "status"
  | "updates";

export interface ModelSpecs {
  context_window_tokens: number;
  max_output_tokens: number;
  supports_thinking: boolean;
  thinking_levels: string[];
  implicit_cache_min_tokens: number;
  speed_tier: string;
  reasoning_tier: string;
  modalities_in: string[];
  modalities_out: string[];
}

export interface ModelPricing {
  input_per_1m_usd: number;
  output_per_1m_usd: number;
  cached_input_per_1m_usd?: number | null;
  thinking_billed_as_output: boolean;
  currency?: string;
  notes?: string;
}

export interface ModelQuotaProfile {
  shared_bucket_cost_tier: "low" | "medium" | "high" | "very_high" | string;
  relative_weight?: number;
  bucket_name?: string;
  notes?: string;
}

export interface ModelEntry {
  id: string;
  provider: "google" | "antigravity" | string;
  api_model_id: string;
  display_name: string;
  family: string;
  codename?: string | null;
  lifecycle: "active" | "preview" | "deprecated" | "removed" | string;
  deprecated_date?: string | null;
  replacement_model_id?: string | null;
  featured?: boolean;
  summary: string;
  specs: ModelSpecs;
  pricing: ModelPricing;
  quota_profile: ModelQuotaProfile;
  availability?: {
    products: string[];
    plans: string[];
  };
  task_fit?: Record<string, string | number>;
  best_for: string[];
  not_recommended_for: string[];
  orchestrator_pairings?: Array<Record<string, unknown>>;
  history?: Array<Record<string, unknown>>;
  official_source_urls: string[];
  verified_at?: string;
}

export interface ModelsSnapshot {
  schema_version: string;
  generated_at: string;
  providers: string[];
  models: ModelEntry[];
  orchestrator_recipes: Array<Record<string, unknown>>;
}

export interface ChronicleEntry {
  id: string;
  date: string;
  provider: string;
  product?: string;
  entity_ids: string[];
  change_type: "added" | "changed" | "removed" | "deprecated" | "fixed" | string;
  scope: "model" | "feature" | "quota" | "limit" | "diagnosis" | "reset" | string;
  title: string;
  before: string;
  after: string;
  impact: string;
  official_source_url: string;
  trust_level: string;
}

export interface ChronicleSnapshot {
  schema_version: string;
  generated_at: string;
  entries: ChronicleEntry[];
}

export interface DiagnosisCommand {
  label: string;
  os: string;
  command: string;
}

export interface DiagnosisEntry {
  id: string;
  slug: string;
  provider: "google" | "antigravity" | string;
  route_provider?: "google" | "agy" | string;
  domain: "quota" | "auth" | "capacity" | "mcp" | "network" | "protocol" | string;
  title: string;
  severity: string;
  products: string[];
  error_codes: string[];
  error_patterns: string[];
  symptoms?: string[];
  root_cause: string;
  steps: string[];
  commands: DiagnosisCommand[];
  verify_command: string;
  dont_dos: string[];
  verified_at?: string;
  verified_version?: string;
  resolved_in_version?: string | null;
  deep_link: string;
  official_source_url?: string;
  history?: Array<Record<string, unknown>>;
}

export interface DiagnosisSnapshot {
  schema_version: string;
  generated_at: string;
  domains: string[];
  entries: DiagnosisEntry[];
}

export interface QuotaPlanEntry {
  id: string;
  name: string;
  provider?: string;
  product?: string;
  window_5h?: string;
  window_7d?: string;
  pt_midnight_reset?: boolean;
  shared_bucket?: boolean;
  ai_credits?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface QuotasSnapshot {
  schema_version: string;
  generated_at: string;
  reset_rules: {
    pt_midnight_timezone: string;
    rolling_window_hours: number;
    weekly_cap_days: number;
    implicit_cache_min_tokens: number;
    notes?: string;
  };
  plans: QuotaPlanEntry[];
  saving_tips: string[];
  official_source_urls: string[];
}

export interface StatusSurface {
  id: string;
  provider: string;
  name: string;
  status: string;
  summary: string;
  source_url: string;
  trust_level: string;
  updated_at: string;
}

export interface StatusIncident {
  id?: string;
  title: string;
  status: string;
  severity?: string;
  updated_at?: string;
  url?: string;
}

export interface StatusSnapshot {
  schema_version: string;
  generated_at: string;
  overall_status: "operational" | "degraded" | "outage" | "unknown" | string;
  surfaces: StatusSurface[];
  active_incidents: StatusIncident[];
  latest_versions: {
    gemini_cli?: string | Record<string, unknown> | null;
    google_genai_pypi?: string | Record<string, unknown> | null;
    agy_cli_script?: string | Record<string, unknown> | null;
  };
  sources_checked: Array<string | Record<string, unknown>>;
}

export interface UpdateItem {
  id: string;
  provider: string;
  product: string;
  category: string;
  severity: string;
  trust_level: string;
  title: string;
  summary: string;
  url: string;
  published_at: string;
  source: string;
}

export interface UpdatesSnapshot {
  schema_version: string;
  generated_at: string;
  total_count: number;
  items: UpdateItem[];
}

export interface SnapshotMap {
  models: ModelsSnapshot;
  chronicle: ChronicleSnapshot;
  diagnosis: DiagnosisSnapshot;
  quotas: QuotasSnapshot;
  status: StatusSnapshot;
  updates: UpdatesSnapshot;
}
