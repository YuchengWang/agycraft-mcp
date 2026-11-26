# agycraft-mcp

Privacy-first local MCP server & offline CLI doctor for **Antigravity (AGY)** and **Gemini CLI** — part of the [ModelCraft](https://modelcraft.dev) open-source ecosystem.

> **Independent community project. Not affiliated with or endorsed by Google.**

## Why agycraft-mcp?

- **Preflight & Hygiene (`doctor`)**: Catch broken `mcp_config.json`/`settings.json`, `url` vs `httpUrl` mismatches, stripped `*TOKEN*`/`*KEY*`/`*SECRET*` env vars, corporate proxy SSL errors (`NODE_EXTRA_CA_CERTS`), missing `.geminiignore`, and bloated global rules *before* your session stalls.
- **Token & KV Cache Audit (`analyze_token_usage`)**: Inspect 5h / 24h / 7d shared-bucket consumption, Thinking output cost share (billed at output rates), and `<4,096` implicit KV cache misses.
- **Quota-Saving Prescriptions (`get_saving_recommendations`)**: Detect long-session snowballs, heavy model mismatches, Thinking downgrade opportunities, and autonomous agent failure loops.
- **Actionable Error Attribution (`diagnose_error`)**: Diagnose all 5 fault domains (Quota/429 desync, Auth/403 mismatch, Capacity/503-504, MCP transport, Network/SSL) plus Structured Output & Function Calling protocol errors with copyable fix commands, verification steps, don't-dos, and `modelcraft.dev` deep links.
- **Model Selection & Ecosystem Status (`lookup_model_guide`, `get_ecosystem_status`)**: Pick the right model or Orchestrator pairing (e.g. Neon + Hydrogen), check deprecation warnings, view live upstream status, and compute local PT midnight & rolling 5h/7d reset countdowns.

## Privacy & Compliance Architecture (100% Auditable)

1. **Zero User Data Upload**: All token analysis, structural transcript counting, and doctor checks run 100% locally.
2. **Strict Numeric/Metadata Whitelist**: `~/.config/agycraft/usage.jsonl` only records `v`, `ts`, `provider`, `product`, `session_hash` (salted SHA-256), `model`, `input_tokens`, `output_tokens`, `context_used_pct`, `tool_calls`, `turn_index`, and `error_code`. Prompts, responses, source code, file paths, project names, and emails are **never** written or logged.
3. **Zero Credential Inspection**: Never reads OAuth tokens, credential caches, or secret env values; never calls undocumented Google/AGY internal endpoints.
4. **One-Way Read-Only Snapshots**: The only network request is a parameterless `GET` to `https://modelcraft.dev/data/v1/*.json` (configurable via `MODELCRAFT_DATA_URL`) with ETag caching and bundled offline fallback snapshots in `snapshots/`.
5. **Zero Native Dependencies**: Pure TypeScript/JavaScript for Node 22+ — no `better-sqlite3` or C++ build steps.

## Quick Start (30 Seconds)

### 1. Run Offline Preflight Doctor

```bash
npx -y agycraft-mcp doctor
```

### 2. Add to Antigravity CLI (`agy`), Antigravity IDE (`mcp_config.json`), or Gemini CLI (`settings.json`)

**Antigravity CLI (`agy`) one-liner:**

```bash
agy mcp add agycraft npx -y agycraft-mcp
```

*(For local dev testing against a local ModelCraft server: `agy mcp add --env MODELCRAFT_DATA_URL=http://127.0.0.1:4321/data/v1 agycraft agycraft-mcp`)*

**Or JSON config (`~/.gemini/antigravity/mcp_config.json` / `~/.gemini/settings.json`):**

```json
{
  "mcpServers": {
    "agycraft": {
      "command": "npx",
      "args": ["-y", "agycraft-mcp"]
    }
  }
}
```

### 3. Optional: View Non-Destructive Telemetry Setup Snippets

```bash
npx -y agycraft-mcp setup
```

### 4. Clear All Local Data Anytime

```bash
npx -y agycraft-mcp clear-local-data
```

## CLI Subcommands

| Command | Description |
| :--- | :--- |
| `agycraft-mcp` | Start Stdio MCP Server (default) |
| `agycraft-mcp doctor [--json]` | Run offline preflight & context hygiene checks |
| `agycraft-mcp setup` | Print opt-in AGY Hook & Gemini CLI OTel (`logPrompts: false`) snippets |
| `agycraft-mcp record` | Append whitelisted numeric hook payload from stdin |
| `agycraft-mcp clear-local-data` | Delete `~/.config/agycraft/usage.jsonl` and cache |

## Registered MCP Tools

1. `analyze_token_usage`
2. `get_saving_recommendations`
3. `diagnose_error`
4. `lookup_model_guide`
5. `get_ecosystem_status`

## Development

```bash
git clone https://github.com/YuchengWang/agycraft-mcp.git && cd agycraft-mcp && pnpm install && pnpm build && node dist/index.js doctor
```

Run tests and typechecking:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
