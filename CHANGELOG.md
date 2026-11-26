# Changelog

All notable changes to `agycraft-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-26

### Added

- **5 MCP Tools** via Stdio MCP server:
  - `analyze_token_usage`: Inspect 5h / 24h / 7d shared-bucket consumption, Thinking output cost share, and `<4,096` implicit KV cache misses, with `hook_events_without_tokens` mode when hook events record turns without token counts.
  - `get_saving_recommendations`: Detect long-session snowballs, heavy model mismatches, Thinking downgrade opportunities, and autonomous agent failure loops, including a `long_session_snowball` false-positive fix.
  - `diagnose_error`: 8-domain `error-diagnoser` with priority scoring covering Quota/429 desync, Auth/403 mismatch, Capacity/503-504, MCP transport, Network/SSL, Structured Output, Function Calling, and Context/Token limits.
  - `lookup_model_guide`: Model selection, Orchestrator pairings, and deprecation warnings backed by versioned snapshots.
  - `get_ecosystem_status`: Upstream status summary, PT midnight reset countdown, and rolling 5h/7d reset countdowns with explicit `is_local_estimate` disclaimer.
- **CLI Subcommands**:
  - `doctor [--json]`: Offline preflight and context hygiene checks for Antigravity (`mcp_config.json`) and Gemini CLI (`settings.json`).
  - `setup`: Non-destructive opt-in AGY Hook and Gemini CLI OTel (`logPrompts: false`) configuration snippets.
  - `record`: Append strictly whitelisted numeric hook payloads from stdin to `~/.config/agycraft/usage.jsonl`.
  - `clear-local-data`: Delete local usage logs and cached snapshots.
- **Privacy-First Architecture**:
  - Strict numeric/metadata whitelist (`v`, `ts`, `provider`, `product`, `session_hash`, `model`, `input_tokens`, `output_tokens`, `context_used_pct`, `tool_calls`, `turn_index`, `error_code`) — prompts, responses, source code, file paths, project names, and emails are never written or logged.
  - Zero native dependencies (pure TypeScript/JavaScript for Node 22+) and bundled offline fallback snapshots in `snapshots/`.
