import { test } from "node:test";
import assert from "node:assert/strict";
import { isUsdStableQuoteToken, convertToUsd } from "./quoteAssetUsdPricing.js";
import { ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS } from "../blockchain/chainConfig.js";

const USDG = ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.USDG.address;
const WETH = ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.WETH.address;
const AMZN_TOKENIZED_STOCK = "0x12f190a9F9d7D37a250758b26824B97CE941bF54"; // real Pons V2 pairToken found for CRC — not USD-stable

test("USDG is recognized as a USD-stable quote asset", () => {
  assert.equal(isUsdStableQuoteToken(USDG), true);
});

test("WETH is NOT treated as USD-stable — its own price moves", () => {
  assert.equal(isUsdStableQuoteToken(WETH), false);
});

test("a tokenized-equity quote asset is NOT treated as USD-stable", () => {
  assert.equal(isUsdStableQuoteToken(AMZN_TOKENIZED_STOCK), false);
});

test("an invalid address is never treated as USD-stable", () => {
  assert.equal(isUsdStableQuoteToken("not-an-address"), false);
});

test("convertToUsd passes through the price unchanged for a USD-stable quote", () => {
  assert.equal(convertToUsd(0.05, USDG), 0.05);
});

test("convertToUsd returns null (never a guess) for a non-USD-stable quote", () => {
  assert.equal(convertToUsd(0.05, WETH), null);
  assert.equal(convertToUsd(0.05, AMZN_TOKENIZED_STOCK), null);
});

test("convertToUsd returns null when the price itself is unknown", () => {
  assert.equal(convertToUsd(null, USDG), null);
});

test("convertToUsd returns null when the quote token is unknown", () => {
  assert.equal(convertToUsd(0.05, null), null);
});
