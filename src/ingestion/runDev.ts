// Safe development entrypoint: npm run ingest:dev
//
// Exercises the full ingestion -> parsing -> storage -> logging pipeline.
// It never touches trading, wallets, scoring, or risk, and requires no
// funded wallet — it only reads (or replays) messages, parses them, and
// writes them to a local file.
//
// If TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION_STRING are all
// set, it connects to the real channel via TelegramMtprotoAdapter.
// Otherwise it replays the real captured fixture set via FixtureFileAdapter
// so this command always works out of the box.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { createLogger } from "../shared/logger.js";
import { FileSignalRepository } from "../storage/fileSignalRepository.js";
import { parseScoutMessage } from "../signal-parsing/scoutMessageParser.js";
import { FixtureFileAdapter } from "./fixtureFileAdapter.js";
import { TelegramMtprotoAdapter } from "./telegramMtprotoAdapter.js";
import type { RawScoutMessage, ScoutIngestionAdapter } from "./types.js";

const logger = createLogger("ingestion:dev");
const SOURCE = "telegram:scoutrobinhood";

function resolveAdapter(): ScoutIngestionAdapter {
  const { TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING, SCOUT_TELEGRAM_CHANNEL } = process.env;

  if (TELEGRAM_API_ID && TELEGRAM_API_HASH && TELEGRAM_SESSION_STRING) {
    logger.info("Telegram credentials found — using the live TelegramMtprotoAdapter");
    return new TelegramMtprotoAdapter({
      apiId: Number(TELEGRAM_API_ID),
      apiHash: TELEGRAM_API_HASH,
      sessionString: TELEGRAM_SESSION_STRING,
      channelUsername: SCOUT_TELEGRAM_CHANNEL ?? "scoutrobinhood",
    });
  }

  logger.info("no Telegram credentials configured — replaying captured fixture messages instead");
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "scoutrobinhood-2026-09-04.raw.json",
  );
  return new FixtureFileAdapter({ filePath: fixturePath });
}

async function main(): Promise<void> {
  const storePath =
    process.env.SIGNAL_STORE_PATH ?? path.join(process.cwd(), "data", "signals.ndjson");
  const repository = new FileSignalRepository(storePath);
  const adapter = resolveAdapter();

  let received = 0;
  let saved = 0;
  let duplicates = 0;

  await adapter.start(async (raw: RawScoutMessage) => {
    received += 1;
    const signal = parseScoutMessage(raw, SOURCE);

    if (await repository.signalExists(signal.id)) {
      duplicates += 1;
      logger.info("duplicate signal skipped", { id: signal.id });
      return;
    }

    await repository.saveSignal(signal);
    saved += 1;

    logger.info("signal captured", {
      id: signal.id,
      messageType: signal.messageType,
      tokenSymbol: signal.tokenSymbol,
      contractAddress: signal.contractAddress,
      parseConfidence: signal.parseConfidence,
      parseWarnings: signal.parseWarnings,
    });
  });

  await adapter.stop();

  logger.info("ingestion run complete", { adapter: adapter.name, received, saved, duplicates, storePath });
}

main().catch((error) => {
  logger.error("ingestion run failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
