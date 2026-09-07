import { test } from "node:test";
import assert from "node:assert/strict";
import { WalletRelationshipAnalyzer } from "./walletRelationshipAnalyzer.js";
import type { WalletTrade } from "../types/domain.js";

const CHAIN_ID = 4663;

function trade(overrides: Partial<WalletTrade>): WalletTrade {
  return {
    chainId: CHAIN_ID,
    walletAddress: "0xa",
    timestamp: "2026-09-05T00:00:00.000Z",
    blockNumber: 1000,
    transactionHash: "0xtx",
    tokenAddress: "0xtoken",
    poolAddress: "0xpool",
    direction: "BUY",
    tokenAmountRaw: "-1",
    quoteAmountRaw: "1",
    approxUsdValue: null,
    tokenPriceUsdAtTrade: null,
    liquidityUsdAtTrade: null,
    marketCapUsdAtTrade: null,
    source: "test",
    ...overrides,
  };
}

test("two wallets with no common tokens have a relationship score of 0 and are not flagged as related", () => {
  const analyzer = new WalletRelationshipAnalyzer();
  const signal = analyzer.analyzePair(
    CHAIN_ID,
    "0xa",
    [trade({ tokenAddress: "0xtokenA" })],
    "0xb",
    [trade({ tokenAddress: "0xtokenB" })],
  );

  assert.equal(signal.commonTokenCount, 0);
  assert.equal(signal.relationshipScore, 0);
  assert.equal(signal.possiblyRelated, false);
});

test("flags two wallets that buy the same token within the synchronization window as possibly related", () => {
  const analyzer = new WalletRelationshipAnalyzer({ synchronizedBuyWindowSeconds: 30 });
  const signal = analyzer.analyzePair(
    CHAIN_ID,
    "0xa",
    [trade({ tokenAddress: "0xtoken", direction: "BUY", timestamp: "2026-09-05T00:00:00.000Z", transactionHash: "0xa1" })],
    "0xb",
    [trade({ tokenAddress: "0xtoken", direction: "BUY", timestamp: "2026-09-05T00:00:10.000Z", transactionHash: "0xb1" })],
  );

  assert.equal(signal.synchronizedBuyCount, 1);
  assert.ok(signal.relationshipScore > 0);
  assert.ok(signal.evidence.length > 0);
});

test("does NOT count buys on the same token outside the synchronization window", () => {
  const analyzer = new WalletRelationshipAnalyzer({ synchronizedBuyWindowSeconds: 30 });
  const signal = analyzer.analyzePair(
    CHAIN_ID,
    "0xa",
    [trade({ tokenAddress: "0xtoken", direction: "BUY", timestamp: "2026-09-05T00:00:00.000Z" })],
    "0xb",
    [trade({ tokenAddress: "0xtoken", direction: "BUY", timestamp: "2026-09-05T01:00:00.000Z" })],
  );

  assert.equal(signal.synchronizedBuyCount, 0);
});

test("never uses identity-claiming language — only 'possibly related' terminology", () => {
  const analyzer = new WalletRelationshipAnalyzer();
  const signal = analyzer.analyzePair(
    CHAIN_ID,
    "0xa",
    [trade({ tokenAddress: "0xtoken", timestamp: "2026-09-05T00:00:00.000Z" })],
    "0xb",
    [trade({ tokenAddress: "0xtoken", timestamp: "2026-09-05T00:00:05.000Z" })],
  );

  const serialized = JSON.stringify(signal).toLowerCase();
  assert.ok(!serialized.includes("same person"));
  assert.ok(!serialized.includes("same entity"));
  assert.ok(typeof signal.possiblyRelated === "boolean");
});

test("analyzeAllPairs produces one signal per unique wallet pair", () => {
  const analyzer = new WalletRelationshipAnalyzer();
  const walletTrades = new Map<string, WalletTrade[]>([
    ["0xa", [trade({ tokenAddress: "0xtoken" })]],
    ["0xb", [trade({ tokenAddress: "0xtoken" })]],
    ["0xc", [trade({ tokenAddress: "0xother" })]],
  ]);

  const signals = analyzer.analyzeAllPairs(CHAIN_ID, walletTrades);
  assert.equal(signals.length, 3); // 3 choose 2
});
