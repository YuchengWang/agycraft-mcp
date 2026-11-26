import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotClient } from "../src/remote/snapshot-client.js";
import type { SnapshotName } from "../src/types.js";

describe("SnapshotClient", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "agycraft-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("loads all 6 bundled offline fallback snapshots cleanly", async () => {
    const client = new SnapshotClient({ cacheDir, offlineOnly: true });
    const names: SnapshotName[] = [
      "models",
      "chronicle",
      "diagnosis",
      "quotas",
      "status",
      "updates",
    ];

    for (const name of names) {
      const res = await client.get(name);
      expect(res.source).toBe("bundled_fallback");
      expect(res.data.schema_version).toBe("1.0.0");
    }
  });

  it("performs strictly one-way GET with zero user headers and respects ETag cache", async () => {
    const requests: Array<{ url: string; method?: string; headers?: HeadersInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, method: init?.method, headers: init?.headers });
      return new Response(
        JSON.stringify({
          schema_version: "1.0.0",
          generated_at: "2026-11-26T00:00:00Z",
          overall_status: "operational",
          surfaces: [],
          active_incidents: [],
          latest_versions: {},
          sources_checked: [],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: '"v1-abc"',
          },
        },
      );
    };

    const client = new SnapshotClient({
      baseUrl: "https://modelcraft.dev/data/v1",
      cacheDir,
      fetchFn: mockFetch,
    });

    const first = await client.get("status");
    expect(first.source).toBe("remote");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe("https://modelcraft.dev/data/v1/status.json");
    // No query params, no Authorization header
    expect(requests[0]?.url).not.toContain("?");
    expect(JSON.stringify(requests[0]?.headers)).not.toContain("Authorization");

    // Second call within TTL hits local cache without another network call
    const second = await client.get("status");
    expect(second.source).toBe("cache");
    expect(requests).toHaveLength(1);
  });

  it("falls back to bundled snapshots when network fails", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("ENOTFOUND offline");
    };
    const client = new SnapshotClient({
      cacheDir,
      fetchFn: failingFetch,
    });

    const res = await client.get("diagnosis");
    expect(res.source).toBe("bundled_fallback");
    expect(res.data.entries.length).toBeGreaterThanOrEqual(5);
  });
});
