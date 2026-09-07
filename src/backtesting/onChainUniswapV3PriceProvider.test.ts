import { test } from "node:test";
import assert from "node:assert/strict";
import { OnChainUniswapV3PriceProvider } from "./onChainUniswapV3PriceProvider.js";
import { BlockTimestampResolver } from "../blockchain/blockTimestampResolver.js";
import { BlockTimeEstimator } from "../blockchain/blockTimeEstimator.js";
import { ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS } from "../blockchain/chainConfig.js";

const USDG = ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.USDG.address;
const WETH = ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.WETH.address;
const POOL = "0x368DDD38861d31435d764fC54Df7D16481E3590b"; // a real BABA/USDG pool found during Phase 6.6
const CHAIN_ID = 4663;
const BEFORE = "2026-09-04T20:10:00.000Z";
const SAMPLE_SQRT_PRICE_X96 = 13065528427335018722415878759662841542n;

function fakeChainClient(opts: { currentBlock?: bigint; swapLogs?: any[]; blockTimestamps?: Record<string, string>; throwOnLogs?: boolean }) {
  const currentBlock = opts.currentBlock ?? 1_000_000n;
  return {
    getBlockNumber: async () => currentBlock,
    getBlockTimestamp: async (blockNumber: bigint) => {
      const ts = opts.blockTimestamps?.[blockNumber.toString()];
      if (!ts) throw new Error(`no fixture timestamp for block ${blockNumber}`);
      return ts;
    },
    getLogs: async () => {
      if (opts.throwOnLogs) throw new Error("RPC failure");
      return opts.swapLogs ?? [];
    },
  } as any;
}

function swapLog(blockNumber: bigint, sqrtPriceX96: bigint) {
  return { blockNumber, args: { sender: "0xa", recipient: "0xa", amount0: 0n, amount1: 0n, sqrtPriceX96, liquidity: 0n, tick: 0 } };
}

function calibration(currentBlock: bigint, currentTs: string) {
  return { "0": "2026-09-04T00:00:00.000Z", [currentBlock.toString()]: currentTs };
}

function makeProvider(chainClient: any, quoteTokenAddress: string = USDG, tokenIsToken0 = false) {
  return new OnChainUniswapV3PriceProvider({
    chainClient,
    blockTimestampResolver: new BlockTimestampResolver(chainClient),
    blockTimeEstimator: new BlockTimeEstimator(chainClient),
    poolAddress: POOL,
    quoteTokenAddress,
    tokenIsToken0,
    token0Decimals: 6,
    token1Decimals: 18,
  });
}

test("reconstructs a price from a real V3 Swap event", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [swapLog(eventBlock, SAMPLE_SQRT_PRICE_X96)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "ok");
  assert.ok(result.data![0].closeUsd > 0);
});

test("excludes a swap observed after beforeTimestamp — never lookahead", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [swapLog(eventBlock, SAMPLE_SQRT_PRICE_X96)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:20:00.000Z" },
  });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable");
});

test("returns 'unavailable' for a non-USD-stable quote asset", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [swapLog(eventBlock, SAMPLE_SQRT_PRICE_X96)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const provider = makeProvider(chainClient, WETH);
  const result = await provider.getCandles(CHAIN_ID, POOL, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable");
});

test("returns 'unavailable' when there are no swap events", async () => {
  const currentBlock = 1_000_000n;
  const chainClient = fakeChainClient({ currentBlock, blockTimestamps: calibration(currentBlock, "2026-09-05T00:00:00.000Z") });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable");
});

test("returns a structured error on RPC failure", async () => {
  const currentBlock = 1_000_000n;
  const chainClient = fakeChainClient({ currentBlock, throwOnLogs: true, blockTimestamps: calibration(currentBlock, "2026-09-05T00:00:00.000Z") });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "error");
});

test("skips a malformed log missing sqrtPriceX96 rather than crashing or fabricating a price", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [{ blockNumber: eventBlock, args: {} }],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable");
});

test("handles duplicate identical Swap events without crashing", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [swapLog(eventBlock, SAMPLE_SQRT_PRICE_X96), swapLog(eventBlock, SAMPLE_SQRT_PRICE_X96)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 1);
});

test("orients price correctly regardless of which slot the token occupies", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [swapLog(eventBlock, SAMPLE_SQRT_PRICE_X96)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const asToken1 = await makeProvider(chainClient, USDG, false).getCandles(CHAIN_ID, POOL, BEFORE, "minute", 1, 60);
  const asToken0 = await makeProvider(chainClient, USDG, true).getCandles(CHAIN_ID, POOL, BEFORE, "minute", 1, 60);
  assert.ok(Math.abs(asToken1.data![0].closeUsd * asToken0.data![0].closeUsd - 1) < 1e-6);
});
