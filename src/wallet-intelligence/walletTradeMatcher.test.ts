import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRoundTrips } from "./walletTradeMatcher.js";
import type { WalletTrade } from "../types/domain.js";

const WALLET = "0xwallet";
const CHAIN_ID = 4663;

function trade(overrides: Partial<WalletTrade>): WalletTrade {
  return {
    chainId: CHAIN_ID,
    walletAddress: WALLET,
    timestamp: "2026-09-01T00:00:00.000Z",
    blockNumber: 1000,
    transactionHash: "0xtx",
    tokenAddress: "0xtoken",
    poolAddress: "0xpool",
    direction: "BUY",
    tokenAmountRaw: "-100",
    quoteAmountRaw: "10",
    approxUsdValue: null,
    tokenPriceUsdAtTrade: null,
    liquidityUsdAtTrade: null,
    marketCapUsdAtTrade: null,
    source: "test",
    ...overrides,
  };
}

test("a matched BUY->SELL pair with a profit is a WIN", () => {
  const trades = [
    trade({ direction: "BUY", blockNumber: 1000, transactionHash: "0xbuy", approxUsdValue: 100 }),
    trade({ direction: "SELL", blockNumber: 2000, transactionHash: "0xsell", approxUsdValue: 150 }),
  ];

  const [roundTrip] = matchRoundTrips(CHAIN_ID, WALLET, trades);
  assert.equal(roundTrip.status, "WIN");
  assert.equal(roundTrip.pnlUsd, 50);
  assert.equal(roundTrip.roiPct, 50);
});

test("a matched BUY->SELL pair with a loss is a LOSS", () => {
  const trades = [
    trade({ direction: "BUY", blockNumber: 1000, transactionHash: "0xbuy", approxUsdValue: 100 }),
    trade({ direction: "SELL", blockNumber: 2000, transactionHash: "0xsell", approxUsdValue: 60 }),
  ];

  const [roundTrip] = matchRoundTrips(CHAIN_ID, WALLET, trades);
  assert.equal(roundTrip.status, "LOSS");
  assert.equal(roundTrip.pnlUsd, -40);
});

test("a breakeven exit (pnl exactly 0) counts as a LOSS by this system's documented definition", () => {
  const trades = [
    trade({ direction: "BUY", blockNumber: 1000, transactionHash: "0xbuy", approxUsdValue: 100 }),
    trade({ direction: "SELL", blockNumber: 2000, transactionHash: "0xsell", approxUsdValue: 100 }),
  ];

  const [roundTrip] = matchRoundTrips(CHAIN_ID, WALLET, trades);
  assert.equal(roundTrip.status, "LOSS");
  assert.equal(roundTrip.pnlUsd, 0);
});

test("a BUY with no later SELL is OPEN, never a fabricated win/loss", () => {
  const trades = [trade({ direction: "BUY", blockNumber: 1000, approxUsdValue: 100 })];
  const [roundTrip] = matchRoundTrips(CHAIN_ID, WALLET, trades);
  assert.equal(roundTrip.status, "OPEN");
  assert.equal(roundTrip.pnlUsd, null);
  assert.equal(roundTrip.exitTrade, undefined);
});

test("a matched pair with a missing USD value is UNKNOWN, not a fabricated PnL", () => {
  const trades = [
    trade({ direction: "BUY", blockNumber: 1000, transactionHash: "0xbuy", approxUsdValue: null }),
    trade({ direction: "SELL", blockNumber: 2000, transactionHash: "0xsell", approxUsdValue: 150 }),
  ];

  const [roundTrip] = matchRoundTrips(CHAIN_ID, WALLET, trades);
  assert.equal(roundTrip.status, "UNKNOWN");
  assert.equal(roundTrip.pnlUsd, null);
});

test("a SELL with no preceding open BUY (orphan exit) is UNKNOWN, entry never fabricated", () => {
  const trades = [trade({ direction: "SELL", blockNumber: 1000, approxUsdValue: 150 })];
  const [roundTrip] = matchRoundTrips(CHAIN_ID, WALLET, trades);
  assert.equal(roundTrip.status, "UNKNOWN");
  assert.equal(roundTrip.entryTrade, undefined);
  assert.equal(roundTrip.entryUsdValue, null);
});

test("a trade with UNKNOWN direction is preserved as its own UNKNOWN round trip, never guessed as BUY or SELL", () => {
  const trades = [trade({ direction: "UNKNOWN", blockNumber: 1000 })];
  const [roundTrip] = matchRoundTrips(CHAIN_ID, WALLET, trades);
  assert.equal(roundTrip.status, "UNKNOWN");
  assert.equal(roundTrip.entryTrade?.direction, "UNKNOWN");
});

test("FIFO matches the oldest open BUY to the next SELL, in block order not array order", () => {
  const trades = [
    trade({ direction: "SELL", blockNumber: 3000, transactionHash: "0xsell", approxUsdValue: 200 }),
    trade({ direction: "BUY", blockNumber: 2000, transactionHash: "0xbuy2", approxUsdValue: 120 }),
    trade({ direction: "BUY", blockNumber: 1000, transactionHash: "0xbuy1", approxUsdValue: 100 }),
  ];

  const roundTrips = matchRoundTrips(CHAIN_ID, WALLET, trades);
  assert.equal(roundTrips.length, 2);
  const closed = roundTrips.find((rt) => rt.status !== "OPEN");
  assert.equal(closed?.entryTrade?.transactionHash, "0xbuy1"); // oldest BUY closed first
  const stillOpen = roundTrips.find((rt) => rt.status === "OPEN");
  assert.equal(stillOpen?.entryTrade?.transactionHash, "0xbuy2");
});

test("keeps round trips for different tokens independent", () => {
  const trades = [
    trade({ tokenAddress: "0xtokenA", direction: "BUY", blockNumber: 1000, approxUsdValue: 100 }),
    trade({ tokenAddress: "0xtokenA", direction: "SELL", blockNumber: 2000, approxUsdValue: 200 }),
    trade({ tokenAddress: "0xtokenB", direction: "BUY", blockNumber: 1000, approxUsdValue: 50 }),
  ];

  const roundTrips = matchRoundTrips(CHAIN_ID, WALLET, trades);
  assert.equal(roundTrips.length, 2);
  assert.equal(roundTrips.find((rt) => rt.tokenAddress === "0xtokenA")?.status, "WIN");
  assert.equal(roundTrips.find((rt) => rt.tokenAddress === "0xtokenB")?.status, "OPEN");
});

test("computes holding time in seconds between entry and exit timestamps", () => {
  const trades = [
    trade({ direction: "BUY", blockNumber: 1000, timestamp: "2026-09-01T00:00:00.000Z", approxUsdValue: 100 }),
    trade({ direction: "SELL", blockNumber: 2000, timestamp: "2026-09-01T01:00:00.000Z", approxUsdValue: 150 }),
  ];

  const [roundTrip] = matchRoundTrips(CHAIN_ID, WALLET, trades);
  assert.equal(roundTrip.holdingSeconds, 3600);
});

test("returns null holding time (not fabricated) when a timestamp is missing", () => {
  const trades = [
    trade({ direction: "BUY", blockNumber: 1000, timestamp: null, approxUsdValue: 100 }),
    trade({ direction: "SELL", blockNumber: 2000, timestamp: "2026-09-01T01:00:00.000Z", approxUsdValue: 150 }),
  ];

  const [roundTrip] = matchRoundTrips(CHAIN_ID, WALLET, trades);
  assert.equal(roundTrip.holdingSeconds, null);
});
