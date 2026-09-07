import { test } from "node:test";
import assert from "node:assert/strict";
import { priceOfCurrency0InCurrency1, priceOfTokenInQuote } from "./sqrtPriceX96.js";

// A real swap observed on THROBBIN's graduated Uniswap V4 pool on Robinhood
// Chain (currency0=USDG, decimals 6; currency1=THROBBIN, decimals 18).
// Verified live during Phase 6.6 investigation — see docs/DATA_SOURCES.md.
const REAL_SQRT_PRICE_X96 = 13065528427335018722415878759662841542n;
const USDG_DECIMALS = 6;
const THROBBIN_DECIMALS = 18;

test("converts a real observed sqrtPriceX96 to a plausible THROBBIN/USDG price", () => {
  // currency0 = USDG, currency1 = THROBBIN -> token (THROBBIN) is currency1
  const priceInUsdg = priceOfTokenInQuote(REAL_SQRT_PRICE_X96, false, USDG_DECIMALS, THROBBIN_DECIMALS);
  // Real GeckoTerminal candles around this period showed THROBBIN in the ~$0.00002-$0.00006 range.
  assert.ok(priceInUsdg > 0.00001 && priceInUsdg < 0.0001, `expected a plausible THROBBIN price, got ${priceInUsdg}`);
});

test("priceOfCurrency0InCurrency1 and priceOfTokenInQuote(currency1) are reciprocals", () => {
  const priceOf0In1 = priceOfCurrency0InCurrency1(REAL_SQRT_PRICE_X96, USDG_DECIMALS, THROBBIN_DECIMALS);
  const priceOfTokenAsCurrency1 = priceOfTokenInQuote(REAL_SQRT_PRICE_X96, false, USDG_DECIMALS, THROBBIN_DECIMALS);
  assert.ok(Math.abs(priceOf0In1 * priceOfTokenAsCurrency1 - 1) < 1e-9);
});

test("priceOfTokenInQuote returns the direct value when the token is currency0", () => {
  const priceOf0In1 = priceOfCurrency0InCurrency1(REAL_SQRT_PRICE_X96, USDG_DECIMALS, THROBBIN_DECIMALS);
  const priceOfTokenAsCurrency0 = priceOfTokenInQuote(REAL_SQRT_PRICE_X96, true, USDG_DECIMALS, THROBBIN_DECIMALS);
  assert.equal(priceOfTokenAsCurrency0, priceOf0In1);
});

test("equal decimals and sqrtPriceX96 = Q96 (price ratio 1) yields price 1", () => {
  const Q96 = 2n ** 96n;
  assert.equal(priceOfCurrency0InCurrency1(Q96, 18, 18), 1);
});

test("decimal adjustment scales correctly for a simple round-number case", () => {
  // sqrtPrice ratio of 2 (price ratio of 4) with a 2-decimal difference
  const Q96 = 2n ** 96n;
  const sqrtPriceX96 = Q96 * 2n; // ratio=2 -> raw price=4
  const price = priceOfCurrency0InCurrency1(sqrtPriceX96, 8, 6); // decimals0 - decimals1 = 2
  assert.ok(Math.abs(price - 4 * 100) < 1e-6);
});
