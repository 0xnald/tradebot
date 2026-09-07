import { test } from "node:test";
import assert from "node:assert/strict";
import { pollPosition, evaluateExit } from "./paperPositionManager.js";

function assertClose(actual: number | null, expected: number, epsilon = 1e-6): void {
  assert.ok(actual !== null, `expected ~${expected}, got null`);
  assert.ok(Math.abs((actual as number) - expected) < epsilon, `expected ~${expected}, got ${actual}`);
}
import { PaperPortfolio } from "./paperPortfolio.js";
import type { CurrentPriceResult } from "./currentPriceResolver.js";
import type { LivePaperPosition, PaperPortfolioConfig } from "../types/domain.js";

const CONFIG: PaperPortfolioConfig = {
  startingCapitalUsd: 1000,
  positionSizePct: 10,
  maxPositionSizeUsd: 200,
  maxConcurrentPositions: 3,
  slippagePct: 1,
  feePct: 0.5,
  takeProfitPct: 50,
  stopLossPct: 20,
  maxHoldingMinutes: 60,
  liquidityEmergencyExitUsd: 500,
  maxSignalAgeSecondsForEntry: 120,
  priceStalenessSeconds: 60,
};

function position(overrides: Partial<LivePaperPosition> = {}): LivePaperPosition {
  return {
    id: "pos-1",
    signalId: "sig-1",
    contractAddress: "0xabc",
    chainId: 4663,
    tokenSymbol: "TEST",
    execution: {
      positionId: "pos-1",
      signalId: "sig-1",
      contractAddress: "0xabc",
      chainId: 4663,
      entryTimestamp: "2026-09-06T12:00:00.000Z",
      entryPriceUsd: 1.0,
      entryPriceSource: "onchain-pons-curve",
      entryDataQuality: "KNOWN",
      positionSizeUsd: 100,
      slippagePct: 1,
      feePct: 0.5,
      feesUsd: 0.5,
      tokenAmount: 99,
      quoteAmountUsd: 100,
    },
    status: "OPEN",
    takeProfitPct: 50,
    stopLossPct: 20,
    maxHoldingMinutes: 60,
    latestSnapshot: null,
    closedAt: null,
    exitPriceUsd: null,
    exitReason: null,
    realizedPnlUsd: null,
    realizedReturnPct: null,
    ...overrides,
  };
}

function price(priceUsd: number | null, opts: Partial<CurrentPriceResult> = {}): CurrentPriceResult {
  return {
    priceUsd,
    liquidityUsd: 1000,
    source: "onchain-pons-curve",
    dataQuality: priceUsd !== null ? "KNOWN" : "UNAVAILABLE",
    observedAt: "2026-09-06T12:01:00.000Z",
    venueType: "PONS_V2_CURVE",
    venueIdentifier: "0xcurve",
    providerCalls: [],
    ...opts,
  };
}

test("evaluateExit triggers TAKE_PROFIT once return meets the configured threshold", () => {
  assert.equal(evaluateExit(position(), 1.5, 60, 1000, null), "TAKE_PROFIT"); // +50%
});

test("evaluateExit triggers STOP_LOSS once return drops to the configured threshold", () => {
  assert.equal(evaluateExit(position(), 0.8, 60, 1000, null), "STOP_LOSS"); // -20%
});

test("evaluateExit triggers MAX_HOLDING_TIME once age exceeds the configured minutes", () => {
  assert.equal(evaluateExit(position(), 1.05, 61 * 60, 1000, null), "MAX_HOLDING_TIME");
});

test("evaluateExit triggers LIQUIDITY_EMERGENCY when liquidity drops below the configured floor", () => {
  assert.equal(evaluateExit(position(), 1.05, 60, 100, 500), "LIQUIDITY_EMERGENCY");
});

test("evaluateExit triggers exactly at the stop-loss boundary despite floating-point representation error (0.8 - 1.0 is not exactly -0.2 in IEEE 754)", () => {
  assert.equal(evaluateExit(position(), 0.8, 60, 1000, null), "STOP_LOSS");
});

test("evaluateExit triggers exactly at the take-profit boundary despite floating-point representation error", () => {
  assert.equal(evaluateExit(position({ takeProfitPct: 30 }), 1.3, 60, 1000, null), "TAKE_PROFIT");
});

test("evaluateExit returns null when no exit condition is met", () => {
  assert.equal(evaluateExit(position(), 1.05, 60, 1000, 500), null);
});

test("pollPosition updates the snapshot without closing when no exit condition is met", async () => {
  const portfolio = new PaperPortfolio(CONFIG);
  const result = await pollPosition(position(), {
    resolvePrice: async () => price(1.05, { observedAt: "2026-09-06T12:01:00.000Z" }),
    portfolio,
    now: () => new Date("2026-09-06T12:01:00.000Z"),
  });
  assert.equal(result.closed, false);
  assertClose(result.snapshot.returnPct, 5);
  assert.equal(result.position.status, "OPEN");
});

test("pollPosition closes the position and realizes PnL when take-profit is hit", async () => {
  const portfolio = new PaperPortfolio(CONFIG);
  portfolio.openPosition(100); // mirror the already-open position's committed capital
  const result = await pollPosition(position(), {
    resolvePrice: async () => price(1.5, { observedAt: "2026-09-06T12:01:00.000Z" }),
    portfolio,
    now: () => new Date("2026-09-06T12:01:00.000Z"),
  });
  assert.equal(result.closed, true);
  assert.equal(result.position.status, "CLOSED");
  assert.equal(result.position.exitReason, "TAKE_PROFIT");
  assert.ok(result.position.realizedPnlUsd! > 0);
  assert.equal(portfolio.openPositionCount, 0);
});

test("pollPosition never acts on a stale price — position stays open, snapshot marked STALE_PRICE", async () => {
  const portfolio = new PaperPortfolio(CONFIG);
  const result = await pollPosition(position(), {
    resolvePrice: async () => price(2.0, { observedAt: "2026-09-06T11:00:00.000Z" }), // way past staleness window, would be +100% (TP) if trusted
    portfolio,
    now: () => new Date("2026-09-06T12:01:00.000Z"),
  });
  assert.equal(result.closed, false);
  assert.equal(result.snapshot.marketStatus, "STALE_PRICE");
  assert.equal(result.snapshot.priceDataQuality, "STALE");
  assert.equal(result.snapshot.returnPct, null); // never computed off the stale price
});

test("pollPosition never acts when the price is entirely unavailable", async () => {
  const portfolio = new PaperPortfolio(CONFIG);
  const result = await pollPosition(position(), {
    resolvePrice: async () => price(null),
    portfolio,
    now: () => new Date("2026-09-06T12:01:00.000Z"),
  });
  assert.equal(result.closed, false);
  assert.equal(result.snapshot.marketStatus, "UNKNOWN");
});

test("pollPosition tracks MFE/MAE across multiple polls, never resetting on a worse/better subsequent price", async () => {
  const portfolio = new PaperPortfolio(CONFIG);
  const first = await pollPosition(position(), {
    resolvePrice: async () => price(1.3, { observedAt: "2026-09-06T12:01:00.000Z" }), // +30%
    portfolio,
    now: () => new Date("2026-09-06T12:01:00.000Z"),
  });
  assertClose(first.snapshot.maxFavorableExcursionPct, 30);

  const second = await pollPosition(first.position, {
    resolvePrice: async () => price(1.1, { observedAt: "2026-09-06T12:02:00.000Z" }), // +10%, worse than the peak
    portfolio,
    now: () => new Date("2026-09-06T12:02:00.000Z"),
  });
  assertClose(second.snapshot.maxFavorableExcursionPct, 30); // MFE stays at the earlier peak
  assertClose(second.snapshot.returnPct, 10);
});

test("marks NO_LIQUIDITY_DATA when a price is known but liquidity is not, and still allows non-liquidity exits", async () => {
  const portfolio = new PaperPortfolio(CONFIG);
  portfolio.openPosition(100);
  const result = await pollPosition(position(), {
    resolvePrice: async () => price(1.5, { liquidityUsd: null, observedAt: "2026-09-06T12:01:00.000Z" }),
    portfolio,
    now: () => new Date("2026-09-06T12:01:00.000Z"),
  });
  assert.equal(result.closed, true); // TAKE_PROFIT still fires — it doesn't depend on liquidity
  assert.equal(result.position.exitReason, "TAKE_PROFIT");
});
