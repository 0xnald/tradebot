import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ScoutSignal } from "../types/domain.js";
import type { SignalRepository } from "./signalRepository.js";

/**
 * Development-grade persistence: an append-only newline-delimited JSON
 * file, loaded into memory on first use. Trivial to inspect (open the file,
 * or `cat`/`tail` it) and requires no database. Not designed for
 * concurrent writers or high volume — a Postgres-backed implementation of
 * `SignalRepository` is the intended replacement if/when that's needed.
 */
export class FileSignalRepository implements SignalRepository {
  #filePath: string;
  #cache?: Map<string, ScoutSignal>;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async #load(): Promise<Map<string, ScoutSignal>> {
    if (this.#cache) return this.#cache;

    const cache = new Map<string, ScoutSignal>();
    try {
      await access(this.#filePath);
      const contents = await readFile(this.#filePath, "utf8");
      for (const line of contents.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const signal = JSON.parse(trimmed) as ScoutSignal;
        cache.set(signal.id, signal);
      }
    } catch {
      // No file yet — start with an empty cache.
    }

    this.#cache = cache;
    return cache;
  }

  async saveSignal(signal: ScoutSignal): Promise<void> {
    const cache = await this.#load();
    if (cache.has(signal.id)) return; // dedupe: never overwrite or duplicate

    cache.set(signal.id, signal);
    await mkdir(dirname(this.#filePath), { recursive: true });
    await appendFile(this.#filePath, `${JSON.stringify(signal)}\n`, "utf8");
  }

  async getSignal(id: string): Promise<ScoutSignal | undefined> {
    const cache = await this.#load();
    return cache.get(id);
  }

  async listSignals(): Promise<ScoutSignal[]> {
    const cache = await this.#load();
    return [...cache.values()];
  }

  async signalExists(id: string): Promise<boolean> {
    const cache = await this.#load();
    return cache.has(id);
  }
}
