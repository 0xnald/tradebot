import { test } from "node:test";
import assert from "node:assert/strict";
import { OnChainPonsCurvePriceProvider } from "./onChainPonsCurvePriceProvider.js";
import { BlockTimestampResolver } from "../blockchain/blockTimestampResolver.js";
import { BlockTimeEstimator } from "../blockchain/blockTimeEstimator.js";
import { ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS } from "../blockchain/chainConfig.js";

const USDG = ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.USDG.address;
const WETH = ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.WETH.address;
const CURVE = "0x5d9C26776C0c7d9D512f8891F04f0d61aa87f6DE";
const CHAIN_ID = 4663;

function fakeChainClient(opts: {
  currentBlock?: bigint;
  buyLogs?: any[];
  sellLogs?: any[];
  blockTimestamps?: Record<string, string>;
  throwOnLogs?: boolean;
}) {
  const currentBlock = opts.currentBlock ?? 1_000_000n;
  return {
    getBlockNumber: async () => currentBlock,
    getBlockTimestamp: async (blockNumber: bigint) => {
      const ts = opts.blockTimestamps?.[blockNumber.toString()];
      if (!ts) throw new Error(`no fixture timestamp for block ${blockNumber}`);
      return ts;
    },
    getLogs: async ({ event }: any) => {
      if (opts.throwOnLogs) throw new Error("RPC failure");
      return event.name === "CurveBuy" ? opts.buyLogs ?? [] : opts.sellLogs ?? [];
    },
  } as any;
}

function buyLog(blockNumber: bigint, quoteIn: bigint, tokensOut: bigint) {
  return { blockNumber, args: { buyer: "0xa", recipient: "0xa", quoteIn, tokensOut, fee: 0n, tax: 0n } };
}
function sellLog(blockNumber: bigint, tokensIn: bigint, quoteOut: bigint) {
  return { blockNumber, args: { seller: "0xa", recipient: "0xa", tokensIn, quoteOut, fee: 0n, tax: 0n } };
}

const BEFORE = "2026-09-04T20:10:00.000Z";

function makeProvider(chainClient: any, quoteTokenAddress: string = USDG, tokenDecimals = 18, quoteDecimals = 6) {
  return new OnChainPonsCurvePriceProvider({
    chainClient,
    blockTimestampResolver: new BlockTimestampResolver(chainClient),
    blockTimeEstimator: new BlockTimeEstimator(chainClient),
    curveAddress: CURVE,
    quoteTokenAddress,
    tokenDecimals,
    quoteDecimals,
  });
}

// Calibration model needs block 0 and current block timestamps; individual test blocks need their own too.
function calibration(currentBlock: bigint, currentTs: string) {
  return { "0": "2026-09-04T00:00:00.000Z", [currentBlock.toString()]: currentTs };
}

test("reconstructs a real price from a single CurveBuy event", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    buyLogs: [buyLog(eventBlock, 1_000_000n /* 1 USDG (6 dec) */, 20_000_000_000_000_000_000n /* 20 tokens (18 dec) */)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });

  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, CURVE, BEFORE, "minute", 1, 60);

  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 1);
  // price = 1 USDG / 20 tokens = 0.05
  assert.equal(result.data?.[0].closeUsd, 0.05);
});

test("computes price from a CurveSell event using tokensIn/quoteOut", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    sellLogs: [sellLog(eventBlock, 10_000_000_000_000_000_000n /* 10 tokens */, 500_000n /* 0.5 USDG */)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });

  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, CURVE, BEFORE, "minute", 1, 60);

  assert.equal(result.status, "ok");
  assert.equal(result.data?.[0].closeUsd, 0.05); // 0.5 / 10
});

test("excludes an event observed AFTER beforeTimestamp — never lookahead", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    buyLogs: [buyLog(eventBlock, 1_000_000n, 20_000_000_000_000_000_000n)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:20:00.000Z" }, // after BEFORE
  });

  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, CURVE, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable");
});

test("returns 'unavailable' when the quote asset is not USD-stable (e.g. WETH) — never a fabricated USD price", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    buyLogs: [buyLog(eventBlock, 1_000_000n, 20_000_000_000_000_000_000n)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });

  const provider = makeProvider(chainClient, WETH);
  const result = await provider.getCandles(CHAIN_ID, CURVE, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable");
});

test("returns 'unavailable' when there are no events at all", async () => {
  const currentBlock = 1_000_000n;
  const chainClient = fakeChainClient({ currentBlock, blockTimestamps: calibration(currentBlock, "2026-09-05T00:00:00.000Z") });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, CURVE, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable");
});

test("returns a structured error (not a throw) on RPC failure", async () => {
  const currentBlock = 1_000_000n;
  const chainClient = fakeChainClient({ currentBlock, throwOnLogs: true, blockTimestamps: calibration(currentBlock, "2026-09-05T00:00:00.000Z") });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, CURVE, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "error");
});

test("returns a structured error for an invalid beforeTimestamp", async () => {
  const chainClient = fakeChainClient({});
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, CURVE, "not-a-date", "minute", 1, 60);
  assert.equal(result.status, "error");
});

test("buckets multiple events into multiple candles", async () => {
  const currentBlock = 1_000_000n;
  const block1 = 500_000n;
  const block2 = 500_100n;
  const chainClient = fakeChainClient({
    currentBlock,
    buyLogs: [buyLog(block1, 1_000_000n, 20_000_000_000_000_000_000n), buyLog(block2, 2_000_000n, 20_000_000_000_000_000_000n)],
    blockTimestamps: {
      ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"),
      [block1.toString()]: "2026-09-04T20:01:00.000Z",
      [block2.toString()]: "2026-09-04T20:05:00.000Z",
    },
  });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, CURVE, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 2);
  assert.equal(result.data?.[0].closeUsd, 0.05);
  assert.equal(result.data?.[1].closeUsd, 0.1);
});

test("skips a degenerate log with zero tokensOut rather than dividing by zero or crashing", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    buyLogs: [buyLog(eventBlock, 1_000_000n, 0n)], // malformed/degenerate: zero tokens out
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, CURVE, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable"); // no usable price point, not a crash or a fabricated Infinity
});

test("returns a structured error (not a crash) when a log is missing expected fields entirely", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    buyLogs: [{ blockNumber: eventBlock, args: {} }], // malformed: no quoteIn/tokensOut at all
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, CURVE, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "unavailable"); // NaN/undefined amounts are treated as unusable, not as a fabricated price
});

test("handles duplicate identical events without crashing or double-counting incorrectly", async () => {
  const currentBlock = 1_000_000n;
  const eventBlock = 500_000n;
  const chainClient = fakeChainClient({
    currentBlock,
    buyLogs: [buyLog(eventBlock, 1_000_000n, 20_000_000_000_000_000_000n), buyLog(eventBlock, 1_000_000n, 20_000_000_000_000_000_000n)],
    blockTimestamps: { ...calibration(currentBlock, "2026-09-05T00:00:00.000Z"), [eventBlock.toString()]: "2026-09-04T20:05:00.000Z" },
  });
  const provider = makeProvider(chainClient);
  const result = await provider.getCandles(CHAIN_ID, CURVE, BEFORE, "minute", 1, 60);
  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 1); // both duplicates fall in the same minute bucket
  assert.equal(result.data?.[0].closeUsd, 0.05); // identical price either way — duplicates don't distort OHLC here
});
