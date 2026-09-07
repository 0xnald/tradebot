import { test } from "node:test";
import assert from "node:assert/strict";
import { MarketFlowAnalyzer } from "./marketFlowAnalyzer.js";
import type { SwapRecord } from "../types/domain.js";

const CHAIN_ID = 4663;
const POOL = "0xpool";
const DECIMALS = 18;
const ONE_ETH = (10n ** 18n).toString();

function swap(overrides: Partial<SwapRecord> = {}): SwapRecord {
  return {
    chainId: CHAIN_ID,
    poolAddress: POOL,
    transactionHash: "0xtx",
    blockNumber: 1,
    timestamp: "2026-09-05T00:00:00.000Z",
    trader: "0xtrader",
    tokenAmount: "-1",
    quoteAmount: ONE_ETH,
    side: "BUY",
    source: "test",
    ...overrides,
  };
}

test("counts buys, sells, and unknowns separately — never folds UNKNOWN into buy or sell", () => {
  const analyzer = new MarketFlowAnalyzer();
  const swaps = [swap({ side: "BUY" }), swap({ side: "SELL" }), swap({ side: "UNKNOWN" })];
  const result = analyzer.analyze(CHAIN_ID, POOL, swaps, DECIMALS);
  assert.equal(result.buyCount, 1);
  assert.equal(result.sellCount, 1);
  assert.equal(result.unknownCount, 1);
});

test("computes quote-token volume (not raw counts) for buy/sell sides", () => {
  const analyzer = new MarketFlowAnalyzer();
  const swaps = [
    swap({ side: "BUY", quoteAmount: (2n * 10n ** 18n).toString() }),
    swap({ side: "SELL", quoteAmount: (1n * 10n ** 18n).toString() }),
  ];
  const result = analyzer.analyze(CHAIN_ID, POOL, swaps, DECIMALS);
  assert.equal(result.buyQuoteVolume, 2);
  assert.equal(result.sellQuoteVolume, 1);
  assert.equal(result.netQuoteFlow, 1);
  assert.equal(result.buySellRatio, 2);
});

test("returns 'PARTIAL' with real zero counts but null volume stats for an empty swap set", () => {
  const analyzer = new MarketFlowAnalyzer();
  const result = analyzer.analyze(CHAIN_ID, POOL, [], DECIMALS);
  assert.equal(result.buyCount, 0);
  assert.equal(result.sellCount, 0);
  assert.equal(result.buyQuoteVolume, null);
  assert.equal(result.dataQuality, "PARTIAL");
});

test("computes average and median trade size across all swaps regardless of direction", () => {
  const analyzer = new MarketFlowAnalyzer();
  const swaps = [
    swap({ quoteAmount: (1n * 10n ** 18n).toString() }),
    swap({ quoteAmount: (2n * 10n ** 18n).toString() }),
    swap({ quoteAmount: (3n * 10n ** 18n).toString() }),
  ];
  const result = analyzer.analyze(CHAIN_ID, POOL, swaps, DECIMALS);
  assert.equal(result.averageTradeSizeQuote, 2);
  assert.equal(result.medianTradeSizeQuote, 2);
});

test("flags trades beyond the documented multiple of the median as large", () => {
  const analyzer = new MarketFlowAnalyzer({ largeTradeMultiplier: 3 });
  const swaps = [
    swap({ quoteAmount: (1n * 10n ** 18n).toString() }),
    swap({ quoteAmount: (1n * 10n ** 18n).toString() }),
    swap({ quoteAmount: (10n * 10n ** 18n).toString() }), // >3x median of 1
  ];
  const result = analyzer.analyze(CHAIN_ID, POOL, swaps, DECIMALS);
  assert.equal(result.largeTradeCount, 1);
  assert.equal(result.largeTradeThresholdQuote, 3);
});

test("counts unique traders only from swaps with an observed trader, null when none are observed", () => {
  const analyzer = new MarketFlowAnalyzer();
  const withTraders = analyzer.analyze(CHAIN_ID, POOL, [swap({ trader: "0xa" }), swap({ trader: "0xb" }), swap({ trader: "0xa" })], DECIMALS);
  assert.equal(withTraders.uniqueTraderCount, 2);

  const withoutTraders = analyzer.analyze(CHAIN_ID, POOL, [swap({ trader: undefined })], DECIMALS);
  assert.equal(withoutTraders.uniqueTraderCount, null);
});

test("counts recent activity within the documented window, null when no swap has a timestamp", () => {
  const now = new Date("2026-09-05T00:10:00.000Z");
  const analyzer = new MarketFlowAnalyzer({ recentWindowSeconds: 300 });
  const swaps = [
    swap({ timestamp: "2026-09-05T00:09:00.000Z" }), // within 5 min
    swap({ timestamp: "2026-09-05T00:00:00.000Z" }), // outside 5 min
  ];
  const result = analyzer.analyze(CHAIN_ID, POOL, swaps, DECIMALS, now);
  assert.equal(result.recentTradeCount, 1);

  const untimed = analyzer.analyze(CHAIN_ID, POOL, [swap({ timestamp: undefined })], DECIMALS, now);
  assert.equal(untimed.recentTradeCount, null);
});
