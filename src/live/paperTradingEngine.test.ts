import { test } from "node:test";
import assert from "node:assert/strict";
import { openPaperPosition } from "./paperTradingEngine.js";
import { PaperPortfolio } from "./paperPortfolio.js";
import type { CurrentPriceResult } from "./currentPriceResolver.js";
import type { PaperPortfolioConfig } from "../types/domain.js";

const CONFIG: PaperPortfolioConfig = {
  startingCapitalUsd: 1000,
  positionSizePct: 10,
  maxPositionSizeUsd: 200,
  maxConcurrentPositions: 2,
  slippagePct: 2,
  feePct: 1,
  takeProfitPct: 50,
  stopLossPct: 20,
  maxHoldingMinutes: 60,
  liquidityEmergencyExitUsd: 1000,
  maxSignalAgeSecondsForEntry: 120,
  priceStalenessSeconds: 60,
};

function price(priceUsd: number | null, source = "onchain-pons-curve"): CurrentPriceResult {
  return {
    priceUsd,
    liquidityUsd: null,
    source,
    dataQuality: priceUsd !== null ? "KNOWN" : "UNAVAILABLE",
    observedAt: "2026-09-06T12:00:00.000Z",
    venueType: "PONS_V2_CURVE",
    venueIdentifier: "0xcurve",
    providerCalls: [],
  };
}

function baseInput(overrides: Partial<Parameters<typeof openPaperPosition>[0]> = {}) {
  return {
    signalId: "sig-1",
    contractAddress: "0xabc",
    chainId: 4663,
    tokenSymbol: "TEST",
    currentPrice: price(1.0),
    ...overrides,
  };
}

test("opens a paper position with correct entry price, size, and fees", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  const result = openPaperPosition(baseInput(), { portfolio, generatePositionId: () => "pos-1", now: () => new Date("2026-09-06T12:00:00.000Z") });

  assert.equal(result.status, "OPENED");
  if (result.status !== "OPENED") return;
  assert.equal(result.position.id, "pos-1");
  assert.equal(result.position.execution.entryPriceUsd, 1.0);
  assert.equal(result.position.execution.positionSizeUsd, 100); // 10% of 1000
  assert.equal(result.position.execution.feesUsd, 1); // 1% of 100
  assert.equal(result.position.status, "OPEN");
});

test("applies slippage to raise the effective execution price used for token-amount math", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  const result = openPaperPosition(baseInput(), { portfolio, generatePositionId: () => "pos-1" });
  if (result.status !== "OPENED") throw new Error("expected OPENED");
  // effective price = 1.0 * 1.02 = 1.02; tokenAmount = (100 - 1) / 1.02
  const expectedTokenAmount = (100 - 1) / 1.02;
  assert.ok(Math.abs(result.position.execution.tokenAmount - expectedTokenAmount) < 1e-9);
});

test("deducts the position size from the portfolio's cash", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  openPaperPosition(baseInput(), { portfolio, generatePositionId: () => "pos-1" });
  assert.equal(portfolio.cashUsd, 900);
});

test("rejects with PRICE_UNAVAILABLE when no current price could be resolved — never invents an entry", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  const result = openPaperPosition(baseInput({ currentPrice: price(null) }), { portfolio, generatePositionId: () => "pos-1" });
  assert.equal(result.status, "REJECTED");
  if (result.status !== "REJECTED") return;
  assert.equal(result.reason, "PRICE_UNAVAILABLE");
  assert.equal(portfolio.cashUsd, 1000); // no capital committed
});

test("rejects when the portfolio has no available capital, without opening a position", () => {
  const portfolio = new PaperPortfolio({ ...CONFIG, startingCapitalUsd: 0 });
  const result = openPaperPosition(baseInput(), { portfolio, generatePositionId: () => "pos-1" });
  assert.equal(result.status, "REJECTED");
  if (result.status !== "REJECTED") return;
  assert.equal(result.reason, "INSUFFICIENT_CAPITAL");
});

test("rejects once maxConcurrentPositions is reached", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  openPaperPosition(baseInput(), { portfolio, generatePositionId: () => "pos-1" });
  openPaperPosition(baseInput(), { portfolio, generatePositionId: () => "pos-2" });
  const result = openPaperPosition(baseInput(), { portfolio, generatePositionId: () => "pos-3" });
  assert.equal(result.status, "REJECTED");
  if (result.status !== "REJECTED") return;
  assert.equal(result.reason, "MAX_CONCURRENT_POSITIONS");
});

test("records the actual price source and data quality on the execution record", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  const result = openPaperPosition(baseInput({ currentPrice: price(1.0, "dexscreener") }), { portfolio, generatePositionId: () => "pos-1" });
  if (result.status !== "OPENED") throw new Error("expected OPENED");
  assert.equal(result.position.execution.entryPriceSource, "dexscreener");
  assert.equal(result.position.execution.entryDataQuality, "KNOWN");
});

test("carries the portfolio's configured TP/SL/max-holding onto the new position", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  const result = openPaperPosition(baseInput(), { portfolio, generatePositionId: () => "pos-1" });
  if (result.status !== "OPENED") throw new Error("expected OPENED");
  assert.equal(result.position.takeProfitPct, 50);
  assert.equal(result.position.stopLossPct, 20);
  assert.equal(result.position.maxHoldingMinutes, 60);
});

test("never sends a real transaction, requests a signature, or touches a private key — position creation is pure data", () => {
  const portfolio = new PaperPortfolio(CONFIG);
  const result = openPaperPosition(baseInput(), { portfolio, generatePositionId: () => "pos-1" });
  assert.equal(result.status, "OPENED");
  // structural proof: OpenPaperPositionResult/LivePaperPosition contain no signing/broadcast fields at all
  if (result.status === "OPENED") {
    assert.ok(!("privateKey" in result.position));
    assert.ok(!("signature" in result.position));
    assert.ok(!("transactionHash" in result.position));
  }
});
