import { runDoctor, formatDoctorReport } from "./cli/doctor.js";
import { buildSetupInstructions } from "./cli/setup.js";
import { clearLocalData } from "./cli/clear-local-data.js";
import { appendUsageRecord } from "./collectors/agy-hook.js";
import { startStdioServer } from "./server.js";

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function printHelp(): void {
  console.log(
    [
      "agycraft-mcp — Privacy-first local MCP server & CLI doctor for Antigravity (AGY) & Gemini CLI",
      "",
      "Usage:",
      "  agycraft-mcp                   Start Stdio MCP Server (default)",
      "  agycraft-mcp doctor [--json]   Run offline preflight & hygiene check (zero secret values read)",
      "  agycraft-mcp setup             Print non-destructive, opt-in AGY / Gemini CLI setup snippets",
      "  agycraft-mcp record            Read hook JSON from stdin and append strictly whitelisted numeric metrics",
      "  agycraft-mcp clear-local-data  Safely delete ~/.config/agycraft/usage.jsonl and cache",
      "  agycraft-mcp --help            Show this help message",
      "",
      "Independent community project (ModelCraft). Not affiliated with or endorsed by Google.",
    ].join("\n"),
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cmd = argv[0];

  if (!cmd) {
    await startStdioServer();
    return;
  }

  switch (cmd) {
    case "doctor": {
      const asJson = argv.includes("--json");
      const report = await runDoctor();
      if (asJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatDoctorReport(report));
      }
      return;
    }

    case "setup": {
      console.log(buildSetupInstructions());
      return;
    }

    case "clear-local-data": {
      const result = await clearLocalData();
      console.log(
        `Cleared local agycraft data (${result.removed.length} path(s) processed).`,
      );
      return;
    }

    case "record": {
      const raw = (await readStdinText()).trim();
      if (!raw) {
        return;
      }
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        await appendUsageRecord(parsed);
      } catch {
        // Ignore malformed stdin payloads silently so hooks never break AGY turns
      }
      return;
    }

    case "-h":
    case "--help":
    case "help": {
      printHelp();
      return;
    }

    default: {
      console.error(`Unknown subcommand: ${cmd}`);
      printHelp();
      process.exitCode = 1;
    }
  }
}

// Run when invoked directly as CLI binary
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("index.js") ||
    process.argv[1].endsWith("index.ts") ||
    process.argv[1].endsWith("agycraft-mcp"));

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
