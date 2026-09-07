import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseScoutMessage } from "./scoutMessageParser.js";
import type { RawScoutMessage } from "../ingestion/types.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SOURCE = "telegram:scoutrobinhood";

function loadFixture(name: string): RawScoutMessage {
  const contents = readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf8");
  return (JSON.parse(contents) as { message: RawScoutMessage }).message;
}

test("parses a complete real EARLY_CALL message with high confidence", () => {
  const raw = loadFixture("real-early-call");
  const signal = parseScoutMessage(raw, SOURCE);

  assert.equal(signal.id, "telegram:scoutrobinhood:5114");
  assert.equal(signal.messageType, "EARLY_CALL");
  assert.equal(signal.tokenSymbol, "THROBBIN");
  assert.equal(signal.chainRaw, "robinhood");
  assert.equal(signal.contractAddress, "0xeb1898a0d496000506a2799e1b4077776497fd29");
  assert.equal(signal.dexName, "Pons V2");
  assert.equal(signal.calledValueUsd, 57_000);
  assert.equal(signal.marketCapUsd, 50_000);
  assert.equal(signal.liquidityUsd, 18_000);
  assert.equal(signal.liquidityPct, 36.1);
  assert.equal(signal.buyTaxPct, 0);
  assert.equal(signal.sellTaxPct, 0);
  assert.equal(signal.ageRaw, "2m");
  assert.equal(signal.ageSeconds, 120);
  assert.equal(signal.dexSlug, "pons_v2");
  assert.equal(signal.holderCount, 130);
  assert.equal(signal.volume24hUsd, 41_000);
  assert.equal(signal.swapCount5m, 378);
  assert.equal(signal.dexScreenerVerified, false);
  assert.equal(signal.eliteHolderCount, 4);
  assert.equal(signal.goodHolderCount, 3);
  assert.equal(signal.liveBuys?.length, 7);
  assert.deepEqual(signal.liveBuys?.[0], {
    badge: "good",
    amountUsd: 481,
    walletTruncated: "0x3430…c941",
  });
  assert.equal(signal.rawText, raw.text);
  assert.equal(signal.parseConfidence, "high");
  assert.deepEqual(signal.parseWarnings, []);
});

test("parses a complete real PERFORMANCE_UPDATE message with high confidence", () => {
  const raw = loadFixture("real-performance-update");
  const signal = parseScoutMessage(raw, SOURCE);

  assert.equal(signal.messageType, "PERFORMANCE_UPDATE");
  assert.equal(signal.tokenSymbol, "GOLDENCAT");
  assert.equal(signal.multiplier, 5);
  assert.equal(signal.calledValueUsd, 28_000);
  assert.equal(signal.peakValueUsd, 139_000);
  assert.equal(signal.contractAddress, "0x25caf5ea23ce1b6b913761129d93a873205d273a");
  assert.equal(signal.parseConfidence, "high");
});

test("parses a partial EARLY_CALL message, leaving absent fields undefined", () => {
  const raw = loadFixture("synthetic-partial-early-call");
  const signal = parseScoutMessage(raw, SOURCE);

  assert.equal(signal.messageType, "EARLY_CALL");
  assert.equal(signal.tokenSymbol, "TESTCOIN");
  assert.equal(signal.marketCapUsd, 42_000);
  assert.equal(signal.ageRaw, undefined);
  assert.equal(signal.ageSeconds, undefined);
  assert.equal(signal.volume24hUsd, undefined);
  assert.equal(signal.swapCount5m, undefined);
  assert.equal(signal.liveBuys, undefined);
  // Core fields (ticker, contract, mcap, liquidity) are all present, so this
  // still counts as high confidence even though optional fields are missing.
  assert.equal(signal.parseConfidence, "high");
});

test("handles a message with no recoverable contract address", () => {
  const raw = loadFixture("synthetic-missing-contract");
  const signal = parseScoutMessage(raw, SOURCE);

  assert.equal(signal.contractAddress, undefined);
  assert.ok(signal.parseWarnings.includes("no contract address found in message buttons"));
  assert.equal(signal.parseConfidence, "partial");
});

test("handles a message with no market cap", () => {
  const raw = loadFixture("synthetic-missing-marketcap");
  const signal = parseScoutMessage(raw, SOURCE);

  assert.equal(signal.marketCapUsd, undefined);
  assert.ok(signal.parseWarnings.includes("no market cap found"));
  assert.equal(signal.parseConfidence, "partial");
  // What IS present should still be extracted correctly.
  assert.equal(signal.contractAddress, "0x2222222222222222222222222222222222222222");
  assert.equal(signal.liquidityUsd, 10_000);
});

test("tolerates realistic formatting variance (comma-grouped numbers, extra blank lines, decimal age)", () => {
  const raw = loadFixture("synthetic-different-formatting");
  const signal = parseScoutMessage(raw, SOURCE);

  assert.equal(signal.messageType, "EARLY_CALL");
  assert.equal(signal.holderCount, 1980);
  assert.equal(signal.ageRaw, "1.5h");
  assert.equal(signal.ageSeconds, 5400);
  assert.equal(signal.parseConfidence, "high");
});

test("classifies unrecognized text as UNKNOWN without throwing or fabricating fields", () => {
  const raw = loadFixture("synthetic-malformed");
  const signal = parseScoutMessage(raw, SOURCE);

  assert.equal(signal.messageType, "UNKNOWN");
  assert.equal(signal.tokenSymbol, undefined);
  assert.equal(signal.contractAddress, undefined);
  assert.equal(signal.rawText, raw.text);
  assert.equal(signal.parseConfidence, "low");
  assert.ok(signal.parseWarnings.length > 0);
});

test("parsing the same raw message twice produces the same signal id (dedupe key)", () => {
  const raw = loadFixture("real-early-call");
  const first = parseScoutMessage(raw, SOURCE);
  const second = parseScoutMessage(raw, SOURCE);

  assert.equal(first.id, second.id);
});
