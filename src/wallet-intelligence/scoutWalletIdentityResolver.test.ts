import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWalletFromTruncated, resolveScoutWalletIdentities } from "./scoutWalletIdentityResolver.js";
import type { ScoutSignal } from "../types/domain.js";

const NOW = "2026-09-05T00:00:00.000Z";

test("leaves a truncated wallet unresolved when no linked URL contains a matching address (the real Scout case)", () => {
  const identity = resolveWalletFromTruncated(
    "0x3430…c941",
    [
      "https://dexscreener.com/robinhood/0xeb1898a0d496000506a2799e1b4077776497fd29",
      "https://gmgn.ai/robinhood/token/scout_0xeb1898a0d496000506a2799e1b4077776497fd29",
    ],
    ["telegram:scoutrobinhood:5114"],
    NOW,
  );

  assert.equal(identity.confidence, "unresolved");
  assert.equal(identity.address, undefined);
  assert.equal(identity.truncatedAddress, "0x3430…c941");
});

test("resolves a full address when exactly one linked URL contains a matching wallet address", () => {
  // A full address matching the truncated pattern's prefix (3430) and suffix (c941):
  const validFull = "0x3430" + "1".repeat(32) + "c941";
  const identity = resolveWalletFromTruncated(
    "0x3430…c941",
    [`https://robinhoodchain.blockscout.com/address/${validFull}`],
    ["telegram:scoutrobinhood:9999"],
    NOW,
  );

  assert.equal(identity.confidence, "high");
  assert.equal(identity.address, validFull.toLowerCase());
  assert.equal(identity.discoverySource, "scout-message-buttons");
});

test("stays unresolved (not a guess) when two different candidate addresses both match the truncated pattern", () => {
  const candidateA = "0x3430" + "1".repeat(32) + "c941";
  const candidateB = "0x3430" + "2".repeat(32) + "c941";

  const identity = resolveWalletFromTruncated(
    "0x3430…c941",
    [`https://example.com/${candidateA}`, `https://example.com/${candidateB}`],
    ["telegram:scoutrobinhood:9999"],
    NOW,
  );

  assert.equal(identity.confidence, "low");
  assert.equal(identity.address, undefined);
  assert.match(identity.label ?? "", /ambiguous/);
});

test("handles a malformed truncated string without throwing", () => {
  const identity = resolveWalletFromTruncated("not-a-wallet", [], ["sig"], NOW);
  assert.equal(identity.confidence, "unresolved");
  assert.equal(identity.address, undefined);
});

test("resolveScoutWalletIdentities returns one identity per live buy, in order", () => {
  const signal: ScoutSignal = {
    id: "telegram:scoutrobinhood:5114",
    source: "telegram:scoutrobinhood",
    sourceMessageId: "5114",
    receivedAt: NOW,
    messageType: "EARLY_CALL",
    rawText: "...",
    links: ["https://dexscreener.com/robinhood/0xeb1898a0d496000506a2799e1b4077776497fd29"],
    liveBuys: [
      { walletTruncated: "0x3430…c941", badge: "good", amountUsd: 481 },
      { walletTruncated: "0x09dc…298f", badge: "elite", amountUsd: 241 },
    ],
    parseConfidence: "high",
    parseWarnings: [],
  };

  const identities = resolveScoutWalletIdentities(signal);
  assert.equal(identities.length, 2);
  assert.equal(identities[0].truncatedAddress, "0x3430…c941");
  assert.equal(identities[1].truncatedAddress, "0x09dc…298f");
  assert.ok(identities.every((i) => i.confidence === "unresolved"));
  assert.ok(identities.every((i) => i.chainId === 4663));
});

test("resolveScoutWalletIdentities returns an empty array when the signal has no live buys", () => {
  const signal: ScoutSignal = {
    id: "telegram:scoutrobinhood:5112",
    source: "telegram:scoutrobinhood",
    sourceMessageId: "5112",
    receivedAt: NOW,
    messageType: "PERFORMANCE_UPDATE",
    rawText: "...",
    parseConfidence: "high",
    parseWarnings: [],
  };

  assert.deepEqual(resolveScoutWalletIdentities(signal), []);
});
