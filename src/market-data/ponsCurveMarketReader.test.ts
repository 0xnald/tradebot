import { test } from "node:test";
import assert from "node:assert/strict";
import { PonsCurveMarketReader } from "./ponsCurveMarketReader.js";

const CHAIN_ID = 4663;
const CURVE = "0xcurve0000000000000000000000000000000001";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // recognized USD-stable — see chainConfig.ts
const NON_STABLE_QUOTE = "0x1234567890123456789012345678901234567890"; // a tokenized-equity-style quote, not USD-stable

function fakeChainClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return {
    chainId: CHAIN_ID,
    getLogs: overrides.getLogs ?? (async () => []),
    getTokenBalance: overrides.getTokenBalance ?? (async () => 5_000_000000000000000000n),
  } as any;
}

function fakeBlockTimestampResolver(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return { resolve: overrides.resolve ?? (async (block: bigint) => new Date(1_700_000_000_000 + Number(block) * 1000).toISOString()) } as any;
}

function buyLog(overrides: Partial<{ blockNumber: bigint; quoteIn: bigint; tokensOut: bigint; buyer: string }> = {}) {
  return {
    blockNumber: overrides.blockNumber ?? 100n,
    transactionHash: "0xtx1",
    args: { buyer: overrides.buyer ?? "0xbuyer0000000000000000000000000000000001", quoteIn: overrides.quoteIn ?? 1_000000000000000000n, tokensOut: overrides.tokensOut ?? 100_000000000000000000n },
  };
}

function sellLog(overrides: Partial<{ blockNumber: bigint; quoteOut: bigint; tokensIn: bigint; seller: string }> = {}) {
  return {
    blockNumber: overrides.blockNumber ?? 101n,
    transactionHash: "0xtx2",
    args: { seller: overrides.seller ?? "0xseller000000000000000000000000000000001", tokensIn: overrides.tokensIn ?? 50_000000000000000000n, quoteOut: overrides.quoteOut ?? 400000000000000000n },
  };
}

test("getCurrentPrice returns the most recent trade's implied price, quote-denominated", async () => {
  const chainClient = fakeChainClient({
    getLogs: async ({ event }: any) => (event.name === "CurveBuy" ? [buyLog({ blockNumber: 100n })] : [sellLog({ blockNumber: 101n })]),
  });
  const reader = new PonsCurveMarketReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getCurrentPrice(CURVE, NON_STABLE_QUOTE, 18, 18, 0n, 1000n);
  assert.equal(result.dataQuality, "KNOWN");
  // Most recent trade (higher block) is the sell: 0.4 quote / 50 tokens = 0.008
  assert.equal(result.priceInQuote, 0.008);
  assert.equal(result.priceUsd, null); // non-USD-stable quote — never fabricated
});

test("getCurrentPrice converts to USD only for a recognized USD-stable quote token", async () => {
  const chainClient = fakeChainClient({
    getLogs: async ({ event }: any) => (event.name === "CurveBuy" ? [buyLog()] : []),
  });
  const reader = new PonsCurveMarketReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getCurrentPrice(CURVE, USDG, 18, 18, 0n, 1000n);
  assert.equal(result.priceInQuote, 0.01); // 1 quote / 100 tokens
  assert.equal(result.priceUsd, 0.01); // USDG treated as USD
});

test("getCurrentPrice is honestly UNAVAILABLE (not fabricated) when no trades exist in the window", async () => {
  const chainClient = fakeChainClient({ getLogs: async () => [] });
  const reader = new PonsCurveMarketReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getCurrentPrice(CURVE, NON_STABLE_QUOTE, 18, 18, 0n, 1000n);
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.equal(result.priceInQuote, null);
});

test("a malformed CurveBuy event (missing tokensOut) is excluded, never guessed", async () => {
  const malformed = { blockNumber: 100n, transactionHash: "0xbad", args: { buyer: "0xbuyer", quoteIn: 1_000000000000000000n } }; // tokensOut missing
  const chainClient = fakeChainClient({ getLogs: async ({ event }: any) => (event.name === "CurveBuy" ? [malformed] : []) });
  const reader = new PonsCurveMarketReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getCurrentPrice(CURVE, NON_STABLE_QUOTE, 18, 18, 0n, 1000n);
  assert.equal(result.dataQuality, "UNAVAILABLE"); // the malformed log contributed nothing, not a fabricated price
});

test("a zero-tokensOut CurveBuy event is excluded (would divide by zero)", async () => {
  const zeroLog = buyLog({ tokensOut: 0n });
  const chainClient = fakeChainClient({ getLogs: async ({ event }: any) => (event.name === "CurveBuy" ? [zeroLog] : []) });
  const reader = new PonsCurveMarketReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getCurrentPrice(CURVE, NON_STABLE_QUOTE, 18, 18, 0n, 1000n);
  assert.equal(result.dataQuality, "UNAVAILABLE");
});

test("getReserveLiquidity reads the curve's own quote-token balance directly, no event scan", async () => {
  let getLogsCalls = 0;
  const chainClient = fakeChainClient({
    getLogs: async () => {
      getLogsCalls += 1;
      return [];
    },
    getTokenBalance: async () => 2_500_000000000000000000n,
  });
  const reader = new PonsCurveMarketReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getReserveLiquidity(CURVE, USDG, 18);
  assert.equal(result.quoteReserveInQuote, 2500);
  assert.equal(result.liquidityUsd, 2500); // USDG converts
  assert.equal(getLogsCalls, 0); // confirms no event scan was needed for liquidity
});

test("getReserveLiquidity stays quote-denominated (never fabricated USD) for a non-stable quote", async () => {
  const chainClient = fakeChainClient({ getTokenBalance: async () => 1_000000000000000000n });
  const reader = new PonsCurveMarketReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getReserveLiquidity(CURVE, NON_STABLE_QUOTE, 18);
  assert.equal(result.quoteReserveInQuote, 1);
  assert.equal(result.liquidityUsd, null);
});

test("getReserveLiquidity degrades to UNAVAILABLE (not a crash) when the balance read fails", async () => {
  const chainClient = fakeChainClient({
    getTokenBalance: async () => {
      throw new Error("rpc exploded");
    },
  });
  const reader = new PonsCurveMarketReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getReserveLiquidity(CURVE, USDG, 18);
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.equal(result.liquidityUsd, null);
});

test("getRecentFlow feeds real BUY/SELL observations into the existing, unmodified MarketFlowAnalyzer", async () => {
  const chainClient = fakeChainClient({
    getLogs: async ({ event }: any) => (event.name === "CurveBuy" ? [buyLog({ blockNumber: 100n }), buyLog({ blockNumber: 102n })] : [sellLog({ blockNumber: 101n })]),
  });
  const reader = new PonsCurveMarketReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, CURVE, NON_STABLE_QUOTE, 18, 18, 0n, 1000n, new Date("2026-09-06T12:00:00.000Z"));
  assert.equal(result.dataQuality, "KNOWN");
  assert.equal(result.swaps.length, 3);
  assert.equal(result.marketFlow?.buyCount, 2);
  assert.equal(result.marketFlow?.sellCount, 1);
  assert.equal(result.priceObservations.length, 3);
  // Observations carry real per-trade timestamps, not all the same "now" — critical for momentum (§18).
  const timestamps = new Set(result.priceObservations.map((o) => o.timestamp));
  assert.equal(timestamps.size, 3);
});

test("getRecentFlow is honestly UNAVAILABLE when the bounded window has no trades", async () => {
  const chainClient = fakeChainClient({ getLogs: async () => [] });
  const reader = new PonsCurveMarketReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, CURVE, NON_STABLE_QUOTE, 18, 18, 0n, 1000n);
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.equal(result.marketFlow, null);
  assert.deepEqual(result.swaps, []);
});

test("getRecentFlow degrades gracefully (no crash) when the underlying event fetch throws", async () => {
  const chainClient = fakeChainClient({
    getLogs: async () => {
      throw new Error("RPC too many results");
    },
  });
  const reader = new PonsCurveMarketReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, CURVE, NON_STABLE_QUOTE, 18, 18, 0n, 1000n);
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.ok(result.notes.some((n) => n.includes("failed")));
});
