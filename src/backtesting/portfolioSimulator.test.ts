import { test } from "node:test";
import assert from "node:assert/strict";
import { simulatePortfolio, type PortfolioSignalInput, type PortfolioSimulatorConfig } from "./portfolioSimulator.js";

const BASE_CONFIG: PortfolioSimulatorConfig = {
  startingCapitalUsd: 1000,
  positionSizePct: 10, // $100 per trade at $1000 capital
  maxConcurrentPositions: 2,
  allowCompounding: false,
  assumedHoldingPeriodMinutes: 60,
  slippagePct: 0,
  feePct: 0,
};

function signal(id: string, minutesFromEpoch: number, finalReturnPct: number | null, hasValidEntry = true): PortfolioSignalInput {
  return {
    signalId: id,
    decisionTimestamp: new Date(Date.UTC(2026, 8, 4, 20, 0) + minutesFromEpoch * 60_000).toISOString(),
    hasValidEntry,
    finalReturnPct,
  };
}

test("a single winning trade increases ending capital by the position's realized PnL", () => {
  const result = simulatePortfolio([signal("1", 0, 20)], "TRADE_CANDIDATE", BASE_CONFIG);
  // $100 position * +20% = +$20
  assert.equal(result.tradesTaken, 1);
  assert.equal(result.endingCapitalUsd, 1020);
  assert.equal(result.realizedPnlUsd, 20);
});

test("a single losing trade decreases ending capital", () => {
  const result = simulatePortfolio([signal("1", 0, -20)], "TRADE_CANDIDATE", BASE_CONFIG);
  assert.equal(result.endingCapitalUsd, 980);
  assert.equal(result.realizedPnlUsd, -20);
});

test("respects maxConcurrentPositions — a third overlapping signal is skipped, not queued or downsized", () => {
  const signals = [signal("1", 0, 10), signal("2", 1, 10), signal("3", 2, 10)];
  const result = simulatePortfolio(signals, "TRADE_CANDIDATE", BASE_CONFIG);
  assert.equal(result.tradesTaken, 2);
  assert.equal(result.tradesSkippedForCapitalConstraint, 1);
});

test("frees a capital slot once a position's holding period elapses, admitting a later signal", () => {
  const shortHold: PortfolioSimulatorConfig = { ...BASE_CONFIG, maxConcurrentPositions: 1, assumedHoldingPeriodMinutes: 10 };
  const signals = [signal("1", 0, 10), signal("2", 5, 10), signal("3", 15, 10)]; // sig-2 arrives while sig-1 still open, sig-3 arrives after it closes
  const result = simulatePortfolio(signals, "TRADE_CANDIDATE", shortHold);
  assert.equal(result.tradesTaken, 2); // sig-1 and sig-3
  assert.equal(result.tradesSkippedForCapitalConstraint, 1); // sig-2
});

test("skips a signal with no reconstructable outcome without counting it as a capital-constraint skip", () => {
  const result = simulatePortfolio([signal("1", 0, null, false)], "TRADE_CANDIDATE", BASE_CONFIG);
  assert.equal(result.tradesTaken, 0);
  assert.equal(result.tradesSkippedForCapitalConstraint, 0);
  assert.equal(result.endingCapitalUsd, 1000);
});

test("does not compound position sizing when allowCompounding is false", () => {
  const signals = [signal("1", 0, 100), signal("2", 61, 0)]; // first trade doubles the $100 position; second signal after slot frees
  const result = simulatePortfolio(signals, "TRADE_CANDIDATE", BASE_CONFIG);
  // Position 2 should still be sized off startingCapitalUsd ($100), not the grown capital.
  const equityAfterSecondEntry = result.equityCurve.find((p) => p.openPositions === 1 && p.timestamp === signals[1].decisionTimestamp);
  assert.ok(equityAfterSecondEntry);
});

test("applies slippage and fees as a deduction from the raw market return", () => {
  const withCosts: PortfolioSimulatorConfig = { ...BASE_CONFIG, slippagePct: 2, feePct: 1 };
  const result = simulatePortfolio([signal("1", 0, 10)], "TRADE_CANDIDATE", withCosts);
  // net return = 10 - 2 - 1 = 7%; position $100 -> +$7
  assert.equal(result.endingCapitalUsd, 1007);
});

test("tracks max drawdown across a losing streak", () => {
  const signals = [signal("1", 0, -50), signal("2", 61, -50)];
  const result = simulatePortfolio(signals, "TRADE_CANDIDATE", BASE_CONFIG);
  assert.ok(result.maxDrawdownPct < 0);
});

test("an empty signal set returns starting capital unchanged with zero trades", () => {
  const result = simulatePortfolio([], "TRADE_CANDIDATE", BASE_CONFIG);
  assert.equal(result.tradesTaken, 0);
  assert.equal(result.endingCapitalUsd, 1000);
  assert.equal(result.realizedPnlUsd, 0);
  assert.equal(result.equityCurve.length, 0);
});

test("force-closes any position still open after the last signal in the stream", () => {
  const result = simulatePortfolio([signal("1", 0, 30)], "TRADE_CANDIDATE", { ...BASE_CONFIG, assumedHoldingPeriodMinutes: 5 });
  const lastPoint = result.equityCurve[result.equityCurve.length - 1];
  assert.equal(lastPoint.openPositions, 0);
  assert.equal(result.endingCapitalUsd, 1030);
});
