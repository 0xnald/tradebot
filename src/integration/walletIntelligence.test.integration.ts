// Optional, live integration test for the wallet-intelligence pipeline.
// Not part of `npm test` — run manually with `npm run test:integration`.
//
// There is no pre-known "test wallet" hardcoded here: instead, this
// discovers a REAL pool (WETH/USDG, already confirmed live in Phase 2),
// pulls REAL recent swaps from it, picks whichever real trader address
// actually appears, and re-queries that exact wallet's activity through
// the full wallet-intelligence pipeline (activity → round-trip matching →
// performance → quality features). This proves the pipeline works against
// live chain data without needing to know a wallet address in advance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import { UniswapV3PoolProvider } from "../market-data/uniswapV3PoolProvider.js";
import { OnChainWalletActivityProvider } from "../wallet-intelligence/onChainWalletActivityProvider.js";
import { matchRoundTrips } from "../wallet-intelligence/walletTradeMatcher.js";
import { WalletPerformanceAnalyzer } from "../wallet-intelligence/walletPerformanceAnalyzer.js";
import { WalletQualityAnalyzer } from "../wallet-intelligence/walletQualityAnalyzer.js";
import { ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS, ROBINHOOD_MAINNET_CHAIN_ID } from "../blockchain/chainConfig.js";

const WETH = ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.WETH.address;

test("[integration] discovers a real wallet from live swap data and runs the full performance pipeline on it", async (t) => {
  const chainClient = new RobinhoodChainClient();
  const poolProvider = new UniswapV3PoolProvider({ chainClient });

  const poolsResult = await poolProvider.discoverPools(WETH);
  assert.equal(poolsResult.status, "ok");
  assert.ok((poolsResult.data?.length ?? 0) > 0, "expected at least one real WETH pool");
  const pool = poolsResult.data![0];

  // Explicitly bounded to a small range: a live check found this pool
  // averaging over 1 swap per block, and each swap costs sequential RPC
  // round-trips to enrich (see docs/WALLET_DATA_SOURCES.md §3a) — a wide
  // range here would make this test slow. 30 blocks is enough to reliably
  // find at least one real trade without the risk of a long-running test.
  const toBlock = await chainClient.getBlockNumber();
  const fromBlock = toBlock - 30n;

  const swapsResult = await poolProvider.getRecentSwaps(pool, { fromBlock, toBlock });
  if (swapsResult.status !== "ok" || !swapsResult.data || swapsResult.data.length === 0) {
    t.diagnostic("no recent swaps found in the default lookback window — nothing to test against right now, skipping");
    return;
  }

  const realTrader = swapsResult.data.find((s) => s.trader)?.trader;
  if (!realTrader) {
    t.diagnostic("no swap in range had an observable trader — skipping");
    return;
  }

  const activityProvider = new OnChainWalletActivityProvider({ poolProvider });
  const tradesResult = await activityProvider.getWalletTrades(ROBINHOOD_MAINNET_CHAIN_ID, realTrader, {
    pools: [pool],
    fromBlock,
    toBlock,
  });

  assert.notEqual(tradesResult.status, "error");
  const trades = tradesResult.data ?? [];
  assert.ok(trades.length > 0, `expected at least one trade for real trader ${realTrader}`);
  assert.ok(trades.every((tr) => tr.approxUsdValue === null), "on-chain-only trades should never have a fabricated USD value");

  const roundTrips = matchRoundTrips(ROBINHOOD_MAINNET_CHAIN_ID, realTrader, trades);
  const performance = new WalletPerformanceAnalyzer().computeSummary(ROBINHOOD_MAINNET_CHAIN_ID, realTrader, roundTrips);
  const quality = new WalletQualityAnalyzer().computeFeatures(performance);

  // Since no historical price provider exists (docs/WALLET_DATA_SOURCES.md §3),
  // real trades from this provider have no USD values, so round trips
  // should be OPEN/UNKNOWN, never a fabricated WIN/LOSS.
  assert.ok(roundTrips.every((rt) => rt.status !== "WIN" && rt.status !== "LOSS"));
  assert.ok(quality.unavailableFeatures.length > 0, "expected some quality features to be honestly unavailable given real data limitations");

  t.diagnostic(
    `real wallet ${realTrader}: ${trades.length} trade(s) found, ${roundTrips.length} round trip(s), sampleSizeConfidence=${performance.sampleSizeConfidence}`,
  );
});
