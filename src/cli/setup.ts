import { getUsageLogPath } from "../paths.js";

/**
 * Generates non-destructive, opt-in setup instructions & snippets for
 * Antigravity (AGY) and Gemini CLI. Never modifies user files automatically.
 */
export function buildSetupInstructions(): string {
  const usagePath = getUsageLogPath();
  return [
    "agycraft-mcp setup (non-destructive, opt-in instructions)",
    "================================================================",
    "No files have been modified automatically. Copy and paste only what you want.",
    "",
    "1. Register agycraft MCP Server:",
    "",
    "   Option A — Antigravity CLI (`agy`) one-liner:",
    "     agy mcp add agycraft npx -y agycraft-mcp",
    "",
    "   (Local dev testing against a local ModelCraft server):",
    "     agy mcp add --env MODELCRAFT_DATA_URL=http://127.0.0.1:4321/data/v1 agycraft agycraft-mcp",
    "",
    "   Option B — Antigravity IDE (~/.gemini/antigravity/mcp_config.json)",
    "   or Gemini CLI (~/.gemini/settings.json):",
    "",
    JSON.stringify(
      {
        mcpServers: {
          agycraft: {
            command: "npx",
            args: ["-y", "agycraft-mcp"],
          },
        },
      },
      null,
      2,
    ),
    "",
    "2. (Optional) Enable Privacy-Safe Gemini CLI OpenTelemetry outfile (exact token & model metrics)",
    "   Add to ~/.gemini/settings.json (logPrompts MUST remain false):",
    "",
    JSON.stringify(
      {
        telemetry: {
          enabled: true,
          target: "local",
          otlpEndpoint: "",
          logPrompts: false,
          outfile: "~/.gemini/telemetry_stats.jsonl",
        },
      },
      null,
      2,
    ),
    "",
    "3. (Optional) Antigravity CLI Hook Recorder (numeric metadata ONLY)",
    "   Add to ~/.gemini/config/hooks.json (leaves statusLine untouched):",
    "",
    JSON.stringify(
      {
        hooks: {
          PostInvocation: [
            {
              matcher: ".*",
              hooks: [
                {
                  type: "command",
                  command: "npx -y agycraft-mcp record",
                  timeout: 3000,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
    "",
    `   Whitelisted numeric records are stored locally at: ${usagePath}`,
    "   (Strict whitelist: ts, provider, product, session_hash, model, input_tokens,",
    "    output_tokens, context_used_pct, tool_calls, turn_index, error_code.",
    "    Prompts, code, paths, and emails are NEVER written or uploaded.)",
    "   Note: AGY PostInvocation hooks may only capture invocation timestamps/counts",
    "   if token/model fields aren't emitted, whereas Gemini CLI OTel (step 2)",
    "   provides exact token/model metrics.",
    "",
    "4. Verify & Clear Local Data Anytime:",
    "   npx agycraft-mcp doctor",
    "   npx agycraft-mcp clear-local-data",
  ].join("\n");
}
