import { rm } from "node:fs/promises";
import { getCacheDir, getSaltFilePath, getUsageLogPath } from "../paths.js";
import { resetSaltCache } from "../collectors/agy-hook.js";

export interface ClearLocalDataResult {
  removed: string[];
}

/**
 * Safely deletes local usage.jsonl, cache directory, and local salt file.
 */
export async function clearLocalData(options?: {
  usageLogPath?: string;
  cacheDir?: string;
  saltPath?: string;
}): Promise<ClearLocalDataResult> {
  const usageLogPath = options?.usageLogPath ?? getUsageLogPath();
  const cacheDir = options?.cacheDir ?? getCacheDir();
  const saltPath = options?.saltPath ?? getSaltFilePath();

  const removed: string[] = [];

  for (const target of [usageLogPath, saltPath]) {
    try {
      await rm(target, { force: true });
      removed.push(target);
    } catch {
      // ignore if already absent
    }
  }

  try {
    await rm(cacheDir, { recursive: true, force: true });
    removed.push(cacheDir);
  } catch {
    // ignore if already absent
  }

  resetSaltCache();
  return { removed };
}
