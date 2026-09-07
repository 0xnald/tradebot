import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileSignalRepository } from "./fileSignalRepository.js";
import { parseScoutMessage } from "../signal-parsing/scoutMessageParser.js";
import type { RawScoutMessage } from "../ingestion/types.js";

const SOURCE = "telegram:scoutrobinhood";

const SAMPLE_RAW: RawScoutMessage = {
  id: "5114",
  channel: "scoutrobinhood",
  postedAt: "2026-09-04T19:54:09+00:00",
  text: "🚨 EARLY CALL — $THROBBIN · robinhood\n💰 called at $57k",
  messageUrl: "https://t.me/scoutrobinhood/5114",
  buttons: [
    { text: "🔍 DexS", url: "https://dexscreener.com/robinhood/0xeb1898a0d496000506a2799e1b4077776497fd29" },
  ],
};

async function withTempRepo(fn: (repo: FileSignalRepository, filePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "scout-alpha-signals-"));
  const filePath = path.join(dir, "signals.ndjson");
  try {
    await fn(new FileSignalRepository(filePath), filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("saveSignal + getSignal round-trip", async () => {
  await withTempRepo(async (repo) => {
    const signal = parseScoutMessage(SAMPLE_RAW, SOURCE);
    await repo.saveSignal(signal);

    const fetched = await repo.getSignal(signal.id);
    assert.deepEqual(fetched, signal);
  });
});

test("signalExists reflects saved state", async () => {
  await withTempRepo(async (repo) => {
    const signal = parseScoutMessage(SAMPLE_RAW, SOURCE);
    assert.equal(await repo.signalExists(signal.id), false);

    await repo.saveSignal(signal);
    assert.equal(await repo.signalExists(signal.id), true);
  });
});

test("listSignals returns everything saved", async () => {
  await withTempRepo(async (repo) => {
    const a = parseScoutMessage(SAMPLE_RAW, SOURCE);
    const b = parseScoutMessage({ ...SAMPLE_RAW, id: "5115" }, SOURCE);
    await repo.saveSignal(a);
    await repo.saveSignal(b);

    const all = await repo.listSignals();
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((s) => s.id).sort(),
      [a.id, b.id].sort(),
    );
  });
});

test("saving the same message twice does not duplicate it (dedupe on restart-safe id)", async () => {
  await withTempRepo(async (repo, filePath) => {
    const first = parseScoutMessage(SAMPLE_RAW, SOURCE);
    await repo.saveSignal(first);

    // Simulate the ingestion process restarting and receiving the same
    // Telegram message again: re-parse the identical raw message and save
    // it through a *fresh* repository instance pointed at the same file.
    const second = parseScoutMessage(SAMPLE_RAW, SOURCE);
    assert.equal(first.id, second.id);

    const repoAfterRestart = new FileSignalRepository(filePath);
    await repoAfterRestart.saveSignal(second);

    const all = await repoAfterRestart.listSignals();
    assert.equal(all.length, 1);

    const fileLines = (await readFile(filePath, "utf8")).trim().split("\n");
    assert.equal(fileLines.length, 1);
  });
});
