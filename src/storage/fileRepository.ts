// Generic NDJSON-backed repository, factored out of Phase 1's
// FileSignalRepository so Phase 3's four new repositories (wallet
// identity/activity/performance, Scout-wallet association) don't each
// hand-roll the same load/save/dedupe logic. Phase 1's FileSignalRepository
// itself is left untouched (already implemented and tested) — this is used
// only for the new Phase 3 stores.
//
// Two modes:
// - "append": an event log. `save()` is a no-op if the id already exists
//   (matches Phase 1's dedupe-on-restart behavior) — used for wallet
//   activity (a trade either happened or it didn't; never rewritten).
// - "upsert": latest-state-per-id. `save()` always overwrites and rewrites
//   the whole file from the in-memory map. Fine for this phase's expected
//   record counts (see the module doc in each repository) — used for
//   wallet identity and performance snapshots, which are recomputed and
//   replaced, not appended to forever.

import { mkdir, readFile, appendFile, writeFile, access } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileRepository<T> {
  save(item: T): Promise<void>;
  get(id: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  exists(id: string): Promise<boolean>;
}

export interface FileRepositoryOptions<T> {
  filePath: string;
  getId: (item: T) => string;
  mode?: "append" | "upsert";
}

export function createFileRepository<T>(options: FileRepositoryOptions<T>): FileRepository<T> {
  const mode = options.mode ?? "append";
  let cache: Map<string, T> | undefined;

  async function load(): Promise<Map<string, T>> {
    if (cache) return cache;
    const loaded = new Map<string, T>();
    try {
      await access(options.filePath);
      const contents = await readFile(options.filePath, "utf8");
      for (const line of contents.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const item = JSON.parse(trimmed) as T;
        loaded.set(options.getId(item), item);
      }
    } catch {
      // No file yet — start empty.
    }
    cache = loaded;
    return cache;
  }

  async function rewriteAll(map: Map<string, T>): Promise<void> {
    await mkdir(dirname(options.filePath), { recursive: true });
    const lines = [...map.values()].map((item) => JSON.stringify(item)).join("\n");
    await writeFile(options.filePath, lines.length > 0 ? lines + "\n" : "", "utf8");
  }

  return {
    async save(item: T): Promise<void> {
      const map = await load();
      const id = options.getId(item);

      if (mode === "append") {
        if (map.has(id)) return; // dedupe — never overwrite/duplicate an event
        map.set(id, item);
        await mkdir(dirname(options.filePath), { recursive: true });
        await appendFile(options.filePath, JSON.stringify(item) + "\n", "utf8");
        return;
      }

      // upsert
      map.set(id, item);
      await rewriteAll(map);
    },

    async get(id: string): Promise<T | undefined> {
      const map = await load();
      return map.get(id);
    },

    async list(): Promise<T[]> {
      const map = await load();
      return [...map.values()];
    },

    async exists(id: string): Promise<boolean> {
      const map = await load();
      return map.has(id);
    },
  };
}
