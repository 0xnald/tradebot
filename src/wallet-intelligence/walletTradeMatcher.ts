// Turns a flat list of normalized trades into round trips with an explicit
// entry and exit — see the TradeOutcomeStatus doc comment in
// src/types/domain.ts for the WIN/LOSS/OPEN/UNKNOWN definitions this
// implements. Matching method: simple FIFO per (wallet, token) — the
// oldest open BUY is closed by the next SELL. This is a defined,
// documented methodology, not an arbitrary guess, and deliberately not
// more sophisticated than that (no partial-fill lot splitting) per the
// "do not over-engineer" guidance.

import type { TradeOutcomeStatus, WalletRoundTrip, WalletTrade } from "../types/domain.js";

function computeHoldingSeconds(entry: WalletTrade, exit: WalletTrade): number | null {
  if (!entry.timestamp || !exit.timestamp) return null;
  const seconds = (new Date(exit.timestamp).getTime() - new Date(entry.timestamp).getTime()) / 1000;
  return seconds >= 0 ? seconds : null; // a negative duration would indicate bad/out-of-order data — don't fabricate a number for it
}

function buildRoundTrip(
  chainId: number,
  walletAddress: string,
  tokenAddress: string,
  entry: WalletTrade | undefined,
  exit: WalletTrade | undefined,
): WalletRoundTrip {
  // A trade whose own direction couldn't be classified never opens or
  // closes a position — it's recorded so it isn't silently dropped, but
  // its outcome is always UNKNOWN.
  if (entry?.direction === "UNKNOWN" && !exit) {
    return {
      chainId,
      walletAddress,
      tokenAddress,
      entryTrade: entry,
      entryUsdValue: entry.approxUsdValue,
      exitUsdValue: null,
      pnlUsd: null,
      roiPct: null,
      holdingSeconds: null,
      status: "UNKNOWN",
    };
  }

  if (entry && !exit) {
    return {
      chainId,
      walletAddress,
      tokenAddress,
      entryTrade: entry,
      entryUsdValue: entry.approxUsdValue,
      exitUsdValue: null,
      pnlUsd: null,
      roiPct: null,
      holdingSeconds: null,
      status: "OPEN", // may still be held — never treated as a loss or a win
    };
  }

  if (!entry && exit) {
    return {
      chainId,
      walletAddress,
      tokenAddress,
      exitTrade: exit,
      entryUsdValue: null,
      exitUsdValue: exit.approxUsdValue,
      pnlUsd: null,
      roiPct: null,
      holdingSeconds: null,
      status: "UNKNOWN", // an exit with no known entry — PnL genuinely cannot be established
    };
  }

  // entry && exit
  const e = entry as WalletTrade;
  const x = exit as WalletTrade;
  const holdingSeconds = computeHoldingSeconds(e, x);

  if (e.direction === "UNKNOWN" || x.direction === "UNKNOWN") {
    return {
      chainId,
      walletAddress,
      tokenAddress,
      entryTrade: e,
      exitTrade: x,
      entryUsdValue: e.approxUsdValue,
      exitUsdValue: x.approxUsdValue,
      pnlUsd: null,
      roiPct: null,
      holdingSeconds,
      status: "UNKNOWN",
    };
  }

  const entryUsd = e.approxUsdValue;
  const exitUsd = x.approxUsdValue;

  if (entryUsd === null || exitUsd === null) {
    return {
      chainId,
      walletAddress,
      tokenAddress,
      entryTrade: e,
      exitTrade: x,
      entryUsdValue: entryUsd,
      exitUsdValue: exitUsd,
      pnlUsd: null,
      roiPct: null,
      holdingSeconds,
      status: "UNKNOWN", // matched, but a required USD value is missing — cannot compute PnL, so not WIN/LOSS
    };
  }

  const pnlUsd = exitUsd - entryUsd;
  const roiPct = entryUsd !== 0 ? (pnlUsd / entryUsd) * 100 : null;
  // WIN: pnlUsd > 0. LOSS: pnlUsd <= 0 — breakeven counts as a loss by
  // definition (it did not produce a profit). Documented, not silent.
  const status: TradeOutcomeStatus = pnlUsd > 0 ? "WIN" : "LOSS";

  return {
    chainId,
    walletAddress,
    tokenAddress,
    entryTrade: e,
    exitTrade: x,
    entryUsdValue: entryUsd,
    exitUsdValue: exitUsd,
    pnlUsd,
    roiPct,
    holdingSeconds,
    status,
  };
}

/**
 * Groups trades by token, sorts each group chronologically by block
 * number, and FIFO-matches BUYs to SELLs. Any BUY left unmatched at the
 * end becomes OPEN; any SELL with no preceding open BUY becomes an
 * UNKNOWN-outcome round trip (see buildRoundTrip). UNKNOWN-direction
 * trades neither open nor close a position but are still represented.
 */
export function matchRoundTrips(chainId: number, walletAddress: string, trades: WalletTrade[]): WalletRoundTrip[] {
  const byToken = new Map<string, WalletTrade[]>();
  for (const trade of trades) {
    const group = byToken.get(trade.tokenAddress) ?? [];
    group.push(trade);
    byToken.set(trade.tokenAddress, group);
  }

  const roundTrips: WalletRoundTrip[] = [];

  for (const [tokenAddress, tokenTrades] of byToken) {
    const sorted = [...tokenTrades].sort((a, b) => a.blockNumber - b.blockNumber);
    const openBuys: WalletTrade[] = [];

    for (const trade of sorted) {
      if (trade.direction === "BUY") {
        openBuys.push(trade);
      } else if (trade.direction === "SELL") {
        const entry = openBuys.shift();
        roundTrips.push(buildRoundTrip(chainId, walletAddress, tokenAddress, entry, trade));
      } else {
        roundTrips.push(buildRoundTrip(chainId, walletAddress, tokenAddress, trade, undefined));
      }
    }

    for (const openBuy of openBuys) {
      roundTrips.push(buildRoundTrip(chainId, walletAddress, tokenAddress, openBuy, undefined));
    }
  }

  return roundTrips;
}
