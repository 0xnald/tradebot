import { test } from "node:test";
import assert from "node:assert/strict";
import { OnChainUniswapV4PriceProvider } from "./onChainUniswapV4PriceProvider.js";
import { BlockTimestampResolver } from "../blockchain/blockTimestampResolver.js";
import { BlockTimeEstimator } from "../blockchain/blockTimeEstimator.js";
import { ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS } from "../blockchain/chainConfig.js";

const USDG = ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.USDG.address;
const WETH = ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.WETH.address;
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const POOL_ID = "0x29a9f241f8299f80d4fc533fee32e97a10b4b5d39d52f6b6376e1b596ab2cad3";
const CHAIN_ID = 4663;
const BEFORE = "2026-09-04T20:10:00.000Z";

// A real swap observed on THROBBIN's graduated pool (currency0=USDG dec 6, currency1=THROBBIN dec 18).
const REAL_SQRT_PRICE_X96 = 13065528427335018722415878759662841542n;

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
  return { blockNumber, args: { id: POOL_ID, sender: "0xa", amount0: 0n, amount1: 0n, sqrtPriceX96, liquidity: 0n, tick: 0, fee: 0 } };
}

function calibration(currentBlock: bigint, currentTs: string) {
  return { "0": "2026-09-04T00:00:00.000Z", [currentBlock.toString()]: currentTs };
}

function makeProvider(chainClient: any, quoteTokenAddress: string = USDG, tokenIsCurrency0 = false) {
  return new OnChainUniswapV4PriceProvider({
    chainClient,
    blockTimestampResolver: new BlockTimestampResolver(chainClient),
    blockTimeEstimator: new BlockTimeEstimator(chainClient),
    poolManagerAddress: POOL_MANAGER,
    poolId: POOL_ID,
    quoteTokenAddress,
    tokenIsCurrency0,
    currency0Decimals: 6,
    currency1Decimals: 18,
  });
}

test("reconstructs a plausible real price from a real observed V4 Swap event", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [swapLog(eventBlock, REAL_SQRT_PRICE_X96)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });

  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL_ID, BEFORE, "minute", 1, 60);

  assert.equal(result.status, "ok");
  assert.ok(result.data![0].closeUsd > 0.00001 && result.data![0].closeUsd < 0.0001);
});

test("excludes a swap observed after beforeTimestamp — never lookahead", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [swapLog(eventBlock, REAL_SQRT_PRICE_X96)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:20:00.000Z" },
  });

  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL_ID, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable");
});

test("returns 'unavailable' for a non-USD-stable quote asset", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [swapLog(eventBlock, REAL_SQRT_PRICE_X96)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const provider = makeProvider(chainClient, WETH);
  const result = await provider.getCandles(CHAIN_ID, POOL_ID, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable");
});

test("orients price correctly when the token is currency0 instead of currency1", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [swapLog(eventBlock, REAL_SQRT_PRICE_X96)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const asCurrency1 = await makeProvider(chainClient, USDG, false).getCandles(CHAIN_ID, POOL_ID, BEFORE, "minute", 1, 60);
  const asCurrency0 = await makeProvider(chainClient, USDG, true).getCandles(CHAIN_ID, POOL_ID, BEFORE, "minute", 1, 60);
  // reciprocal orientations should multiply to ~1
  assert.ok(Math.abs(asCurrency1.data![0].closeUsd * asCurrency0.data![0].closeUsd - 1) < 1e-6);
});

test("returns 'unavailable' when there are no swap events", async () => {
  const currentBlock = 1_000_000n;
  const chainClient = fakeChainClient({ currentBlock, blockTimestamps: calibration(currentBlock, "2026-09-05T00:00:00.000Z") });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL_ID, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable");
});

test("returns a structured error on RPC failure", async () => {
  const currentBlock = 1_000_000n;
  const chainClient = fakeChainClient({ currentBlock, throwOnLogs: true, blockTimestamps: calibration(currentBlock, "2026-09-05T00:00:00.000Z") });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL_ID, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "error");
});

test("skips a malformed log missing sqrtPriceX96 rather than crashing or fabricating a price", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [{ blockNumber: eventBlock, args: { id: POOL_ID } }], // missing sqrtPriceX96 entirely
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL_ID, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable");
});

test("handles duplicate identical Swap events without crashing", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [swapLog(eventBlock, REAL_SQRT_PRICE_X96), swapLog(eventBlock, REAL_SQRT_PRICE_X96)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL_ID, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 1);
});

test("never treats the PoolId as an address — it's passed through as an opaque bytes32 identifier", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    swapLogs: [swapLog(eventBlock, REAL_SQRT_PRICE_X96)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  // POOL_ID is 64 hex chars (32 bytes) — not a valid 20-byte address — and the provider must not reject or mis-handle it.
  assert.equal(POOL_ID.length, 66);
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, POOL_ID, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "ok");
});
