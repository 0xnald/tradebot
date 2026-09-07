import { test } from "node:test";
import assert from "node:assert/strict";
import { PaperPortfolio } from "./paperPortfolio.js";
import type { PaperPortfolioConfig } from "../types/domain.js";

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
  liquidityEmergencyExitUsd: 1000,
  maxSignalAgeSecondsForEntry: 120,
  priceStalenessSeconds: 60,
};

test("computes position size as a percentage of current cash", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  assert.equal(portfolio.computePositionSizeUsd(), 100); // 10% of 1000
});

test("caps position size at the configured maximum", () => {
  const portfolio = new PaperPortfolio({ ...CONFIG, positionSizePct: 50 }); // 50% of 1000 = 500, capped at 200
  assert.equal(portfolio.computePositionSizeUsd(), 200);
});

test("allows opening a position within capital and concurrency limits", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  assert.equal(portfolio.canOpenPosition(100).allowed, true);
});

test("rejects a position exceeding available cash — no borrowing", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  const admission = portfolio.canOpenPosition(2000);
  assert.equal(admission.allowed, false);
  assert.equal(admission.reason, "INSUFFICIENT_CAPITAL");
});

test("rejects a position once maxConcurrentPositions is reached", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  portfolio.openPosition(100);
  portfolio.openPosition(100);
  portfolio.openPosition(100);
  const admission = portfolio.canOpenPosition(50);
  assert.equal(admission.allowed, false);
  assert.equal(admission.reason, "MAX_CONCURRENT_POSITIONS");
});

test("openPosition deducts cash and increments the open count", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  portfolio.openPosition(100);
  assert.equal(portfolio.cashUsd, 900);
  assert.equal(portfolio.openPositionCount, 1);
  assert.equal(portfolio.equityUsd, 1000); // cost-basis equity unchanged by opening
});

test("closePosition returns cash plus realized PnL and decrements the open count", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  portfolio.openPosition(100);
  portfolio.closePosition(100, 25); // +$25 profit
  assert.equal(portfolio.cashUsd, 1025);
  assert.equal(portfolio.openPositionCount, 0);
});

test("closePosition correctly applies a loss", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  portfolio.openPosition(100);
  portfolio.closePosition(100, -40);
  assert.equal(portfolio.cashUsd, 960);
});

test("position sizing shrinks after a loss (no leverage effect) — sized off current cash, not starting capital", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  portfolio.openPosition(100);
  portfolio.closePosition(100, -500); // big loss, cash now 500
  assert.equal(portfolio.computePositionSizeUsd(), 50); // 10% of 500
});

test("rejects a zero-dollar position size (fully depleted cash) as insufficient capital, never a no-op trade", () => {
  const portfolio = new PaperPortfolio({ ...CONFIG, startingCapitalUsd: 0 });
  assert.equal(portfolio.computePositionSizeUsd(), 0);
  const admission = portfolio.canOpenPosition(portfolio.computePositionSizeUsd());
  assert.equal(admission.allowed, false);
  assert.equal(admission.reason, "INSUFFICIENT_CAPITAL");
});

test("supports multiple simultaneous open positions up to the concurrency limit", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  portfolio.openPosition(100);
  portfolio.openPosition(100);
  assert.equal(portfolio.openPositionCount, 2);
  assert.equal(portfolio.cashUsd, 800);
});
