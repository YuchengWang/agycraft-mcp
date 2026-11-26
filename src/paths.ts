import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getConfigDir(): string {
  const override = process.env.AGYCRAFT_CONFIG_DIR;
  if (override && override.trim().length > 0) {
    return resolve(override.trim());
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim().length > 0) {
    return join(resolve(xdg.trim()), "agycraft");
  }
  return join(homedir(), ".config", "agycraft");
}

export function getUsageLogPath(): string {
  return join(getConfigDir(), "usage.jsonl");
}

export function getCacheDir(): string {
  return join(getConfigDir(), "cache");
}

export function getSaltFilePath(): string {
  return join(getConfigDir(), ".salt");
}

export function getDefaultGeminiTelemetryPath(): string {
  const override = process.env.AGYCRAFT_GEMINI_OTEL_PATH;
  if (override && override.trim().length > 0) {
    return resolve(override.trim());
  }
  return join(homedir(), ".gemini", "telemetry_stats.jsonl");
}

export function getAgyBrainDir(): string {
  const override = process.env.AGYCRAFT_BRAIN_DIR;
  if (override && override.trim().length > 0) {
    return resolve(override.trim());
  }
  return join(homedir(), ".gemini", "antigravity-cli", "brain");
}

export function getSnapshotsDir(): string {
  const override = process.env.AGYCRAFT_SNAPSHOTS_DIR;
  if (override && override.trim().length > 0) {
    return resolve(override.trim());
  }
  // Works from both src/ (vitest/tsx) and dist/ (built bundle)
  return resolve(new URL("../snapshots", import.meta.url).pathname);
}
