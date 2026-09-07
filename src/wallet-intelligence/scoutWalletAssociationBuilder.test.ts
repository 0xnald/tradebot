import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScoutWalletAssociations } from "./scoutWalletAssociationBuilder.js";
import type { ScoutSignal } from "../types/domain.js";

test("builds one association per live buy, preserving Scout's raw claims without verifying them", () => {
  const signal: ScoutSignal = {
    id: "telegram:scoutrobinhood:5114",
    source: "telegram:scoutrobinhood",
    sourceMessageId: "5114",
    receivedAt: "2026-09-05T00:00:00.000Z",
    messageType: "EARLY_CALL",
    rawText: "...",
    links: [],
    liveBuys: [{ walletTruncated: "0x3430…c941", badge: "good", amountUsd: 481 }],
    parseConfidence: "high",
    parseWarnings: [],
  };

  const associations = buildScoutWalletAssociations(signal);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].scoutSignalId, "telegram:scoutrobinhood:5114");
  assert.equal(associations[0].badge, "good");
  assert.equal(associations[0].amountUsdClaimed, 481);
  assert.equal(associations[0].confidence, "unresolved");
  assert.equal(associations[0].wallet.address, undefined);
  assert.match(associations[0].rawEvidence, /0x3430…c941/);
});

test("returns an empty array for a signal with no live buys (e.g. a PERFORMANCE_UPDATE)", () => {
  const signal: ScoutSignal = {
    id: "telegram:scoutrobinhood:5112",
    source: "telegram:scoutrobinhood",
    sourceMessageId: "5112",
    receivedAt: "2026-09-05T00:00:00.000Z",
    messageType: "PERFORMANCE_UPDATE",
    rawText: "...",
    parseConfidence: "high",
    parseWarnings: [],
  };

  assert.deepEqual(buildScoutWalletAssociations(signal), []);
});

test("association ids are stable and unique per live-buy index", () => {
  const signal: ScoutSignal = {
    id: "telegram:scoutrobinhood:5114",
    source: "telegram:scoutrobinhood",
    sourceMessageId: "5114",
    receivedAt: "2026-09-05T00:00:00.000Z",
    messageType: "EARLY_CALL",
    rawText: "...",
    liveBuys: [
      { walletTruncated: "0x3430…c941", badge: "good", amountUsd: 481 },
      { walletTruncated: "0x09dc…298f", badge: "elite", amountUsd: 241 },
    ],
    parseConfidence: "high",
    parseWarnings: [],
  };

  const associations = buildScoutWalletAssociations(signal);
  assert.deepEqual(
    associations.map((a) => a.id),
    ["telegram:scoutrobinhood:5114:0", "telegram:scoutrobinhood:5114:1"],
  );
});
