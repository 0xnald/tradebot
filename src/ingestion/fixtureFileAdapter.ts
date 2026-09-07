import { readFile } from "node:fs/promises";
import type { RawScoutMessage, ScoutIngestionAdapter } from "./types.js";

export interface FixtureFileAdapterOptions {
  /** Path to a JSON file containing an array of RawScoutMessage objects. */
  filePath: string;
  /** Optional delay between replayed messages, in ms. Defaults to 0. */
  delayMs?: number;
}

/**
 * Replays a fixed set of previously captured raw messages from a local JSON
 * file. This exists so the rest of the ingestion → parsing → storage
 * pipeline can be exercised in full without live Telegram credentials — see
 * `npm run ingest:dev`.
 */
export class FixtureFileAdapter implements ScoutIngestionAdapter {
  readonly name = "fixture-file";
  #options: FixtureFileAdapterOptions;
  #stopped = false;

  constructor(options: FixtureFileAdapterOptions) {
    this.#options = options;
  }

  async start(onMessage: (message: RawScoutMessage) => void | Promise<void>): Promise<void> {
    const contents = await readFile(this.#options.filePath, "utf8");
    const messages = JSON.parse(contents) as RawScoutMessage[];

    for (const message of messages) {
      if (this.#stopped) break;
      await onMessage(message);
      if (this.#options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.#options.delayMs));
      }
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
  }
}
