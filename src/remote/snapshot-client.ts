import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCacheDir, getSnapshotsDir } from "../paths.js";
import type { SnapshotMap, SnapshotName } from "../types.js";

const DEFAULT_DATA_URL = "https://modelcraft.dev/data/v1";

const TTL_MS: Record<SnapshotName, number> = {
  status: 5 * 60 * 1000,
  updates: 15 * 60 * 1000,
  models: 6 * 60 * 60 * 1000,
  chronicle: 6 * 60 * 60 * 1000,
  diagnosis: 6 * 60 * 60 * 1000,
  quotas: 6 * 60 * 60 * 1000,
};

interface CacheMeta {
  etag: string | null;
  fetched_at_ms: number;
}

export interface SnapshotFetchResult<T> {
  data: T;
  source: "remote" | "cache" | "bundled_fallback";
}

export interface SnapshotClientOptions {
  baseUrl?: string;
  cacheDir?: string;
  snapshotsDir?: string;
  fetchFn?: typeof fetch;
  offlineOnly?: boolean;
  timeoutMs?: number;
}

/**
 * One-way read-only snapshot client.
 * PRIVACY RED LINE:
 * - Only performs GET requests to public static JSON at MODELCRAFT_DATA_URL (default https://modelcraft.dev/data/v1).
 * - NEVER sends user identifiers, telemetry, query params, cookies, or authorization headers.
 * - NEVER contacts Google/AGY internal endpoints.
 */
export class SnapshotClient {
  private readonly baseUrl: string;
  private readonly cacheDir: string;
  private readonly snapshotsDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly offlineOnly: boolean;
  private readonly timeoutMs: number;

  constructor(options?: SnapshotClientOptions) {
    const envUrl = process.env.MODELCRAFT_DATA_URL?.trim();
    this.baseUrl = (options?.baseUrl || envUrl || DEFAULT_DATA_URL).replace(
      /\/+$/,
      "",
    );
    this.cacheDir = options?.cacheDir ?? getCacheDir();
    this.snapshotsDir = options?.snapshotsDir ?? getSnapshotsDir();
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.offlineOnly =
      options?.offlineOnly ?? process.env.AGYCRAFT_OFFLINE === "1";
    this.timeoutMs = options?.timeoutMs ?? 4000;
  }

  async get<K extends SnapshotName>(
    name: K,
  ): Promise<SnapshotFetchResult<SnapshotMap[K]>> {
    const cacheFile = join(this.cacheDir, `${name}.json`);
    const metaFile = join(this.cacheDir, `${name}.meta.json`);
    const ttl = TTL_MS[name];

    const cached = await this.readCache<SnapshotMap[K]>(cacheFile, metaFile);
    const now = Date.now();

    if (cached && now - cached.meta.fetched_at_ms < ttl) {
      return { data: cached.data, source: "cache" };
    }

    if (!this.offlineOnly) {
      const remoteResult = await this.fetchRemote<SnapshotMap[K]>(
        name,
        cached?.meta.etag ?? null,
        cacheFile,
        metaFile,
        cached?.data ?? null,
      );
      if (remoteResult) {
        return remoteResult;
      }
    }

    if (cached) {
      return { data: cached.data, source: "cache" };
    }

    const fallback = await this.readBundledFallback<SnapshotMap[K]>(name);
    return { data: fallback, source: "bundled_fallback" };
  }

  private async readCache<T>(
    cacheFile: string,
    metaFile: string,
  ): Promise<{ data: T; meta: CacheMeta } | null> {
    try {
      const [rawJson, rawMeta] = await Promise.all([
        readFile(cacheFile, "utf8"),
        readFile(metaFile, "utf8"),
      ]);
      const data = JSON.parse(rawJson) as T;
      const meta = JSON.parse(rawMeta) as CacheMeta;
      return { data, meta };
    } catch {
      return null;
    }
  }

  private async writeCache<T>(
    cacheFile: string,
    metaFile: string,
    data: T,
    etag: string | null,
  ): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const meta: CacheMeta = { etag, fetched_at_ms: Date.now() };
      await Promise.all([
        writeFile(cacheFile, JSON.stringify(data), "utf8"),
        writeFile(metaFile, JSON.stringify(meta), "utf8"),
      ]);
    } catch {
      // Cache write failure is non-fatal
    }
  }

  private async fetchRemote<T>(
    name: SnapshotName,
    etag: string | null,
    cacheFile: string,
    metaFile: string,
    cachedData: T | null,
  ): Promise<SnapshotFetchResult<T> | null> {
    const url = `${this.baseUrl}/${name}.json`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (etag) {
      headers["If-None-Match"] = etag;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await this.fetchFn(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (resp.status === 304 && cachedData !== null) {
        await this.writeCache(cacheFile, metaFile, cachedData, etag);
        return { data: cachedData, source: "cache" };
      }

      if (!resp.ok) {
        return null;
      }

      const data = (await resp.json()) as T;
      const newEtag = resp.headers.get("etag");
      await this.writeCache(cacheFile, metaFile, data, newEtag);
      return { data, source: "remote" };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBundledFallback<T>(name: SnapshotName): Promise<T> {
    const filePath = join(this.snapshotsDir, `${name}.json`);
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  }
}
