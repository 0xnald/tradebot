// Phase 6.6 — which quote assets can be converted to USD without a second
// historical price lookup. USDG ("Global Dollar") is a USD-pegged
// stablecoin — treating 1 USDG = $1 is a documented, disclosed
// approximation, not a fabrication (GeckoTerminal's own historical
// USD-denominated quotes for these exact pools reflect the same
// assumption — see docs/DATA_SOURCES.md).
//
// Everything else — WETH (its own USD price moves and would need a
// separate historical WETH/USD reconstruction), and the Robinhood
// tokenized-equity quote tokens Pons V2 launches turned out to also use
// (AMZN/META/LLY-style tokens — see docs/BACKTESTING.md's Phase 6.6
// finding) — is intentionally NOT converted to USD here. A raw,
// quote-denominated price is still reconstructed and returned; only the
// USD figure is withheld, honestly, rather than compounding a second
// unverified price hop into a single number.

import { getAddress, isAddress } from "viem";
import { ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS } from "../blockchain/chainConfig.js";

const USD_STABLE_QUOTE_TOKENS = new Set<string>([getAddress(ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.USDG.address)]);

export function isUsdStableQuoteToken(quoteTokenAddress: string): boolean {
  if (!isAddress(quoteTokenAddress)) return false;
  return USD_STABLE_QUOTE_TOKENS.has(getAddress(quoteTokenAddress));
}

/** Converts a quote-denominated price to USD only for a recognized USD-stable quote asset; null (never a guess) otherwise. */
export function convertToUsd(priceInQuote: number | null, quoteTokenAddress: string | null): number | null {
  if (priceInQuote === null || !quoteTokenAddress) return null;
  return isUsdStableQuoteToken(quoteTokenAddress) ? priceInQuote : null;
}
