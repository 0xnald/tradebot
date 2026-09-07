// Shared Uniswap V3/V4 sqrtPriceX96 -> human price conversion. Both
// protocols use the identical convention (Q96 fixed-point sqrt of the
// raw token1/token0 ratio), so one implementation serves both event-based
// reconstructors. Verified against a real, independently-observed
// Robinhood Chain swap (see docs/DATA_SOURCES.md §2/§7): a real THROBBIN
// swap's sqrtPriceX96 converts to a THROBBIN/USDG price in the same
// order of magnitude GeckoTerminal independently reported for that pool.

const Q96 = 2n ** 96n;

/** Human-readable price of 1 unit of currency0 in units of currency1 (Uniswap's native token1/token0 convention, decimal-adjusted). */
export function priceOfCurrency0InCurrency1(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  const rawPrice1PerUnit0 = ratio * ratio;
  return rawPrice1PerUnit0 * 10 ** (decimals0 - decimals1);
}

/**
 * Orients the price to "1 unit of `token` costs how much `quoteToken`",
 * given which currency slot `token` actually occupies (currency0/1 are
 * sorted numerically by address, not semantically by role — see
 * docs/DATA_SOURCES.md §7).
 */
export function priceOfTokenInQuote(
  sqrtPriceX96: bigint,
  tokenIsCurrency0: boolean,
  decimals0: number,
  decimals1: number,
): number {
  const priceOf0In1 = priceOfCurrency0InCurrency1(sqrtPriceX96, decimals0, decimals1);
  return tokenIsCurrency0 ? priceOf0In1 : 1 / priceOf0In1;
}
