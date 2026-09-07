// Optional, live integration test for Phase 4 analyzers. Not part of
// `npm test` — run manually with `npm run test:integration`. Explicitly
// bounded to a small block range throughout (see
// docs/WALLET_DATA_SOURCES.md §3a — a wide range against a high-volume
// pool is slow and close to hammering the public RPC).

import { test } from "node:test";
import assert from "node:assert/strict";
import { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import { UniswapV3PoolProvider } from "../market-data/uniswapV3PoolProvider.js";
import { ContractFeatureAnalyzer } from "../token-analysis/contractFeatureAnalyzer.js";
import { computeTokenAge } from "../token-analysis/tokenAgeAnalyzer.js";
import { MarketFlowAnalyzer } from "../market-data/marketFlowAnalyzer.js";
import { PoolQualityAnalyzer } from "../market-data/poolQualityAnalyzer.js";
import { ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS, ROBINHOOD_MAINNET_CHAIN_ID } from "../blockchain/chainConfig.js";

const WETH = ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.WETH.address as `0x${string}`;

test("[integration] runs contract feature detection against the real WETH contract", async () => {
  const chainClient = new RobinhoodChainClient();
  const analyzer = new ContractFeatureAnalyzer({ chainClient });
  const result = await analyzer.analyze(WETH);

  assert.equal(result.chainId, ROBINHOOD_MAINNET_CHAIN_ID);
  assert.ok(result.bytecodeSizeBytes !== null && result.bytecodeSizeBytes > 0, "expected real, non-empty WETH bytecode");
  // WETH is a simple, well-known contract — no mint/pause/blacklist expected, but this is
  // evidence, not a safety claim (see the analyzer's own detectionCaveat).
  assert.ok(["detected", "not_detected"].includes(result.mintFunctionDetected));
});

test("[integration] deployment-info lookup for an old contract, and the documented RPC retention limitation", async (t) => {
  const chainClient = new RobinhoodChainClient();

  // KNOWN, LIVE-CONFIRMED LIMITATION (see the doc comment on
  // findContractDeploymentBlock): the public RPC only retains state for
  // roughly the last 6,000-8,000 blocks. WETH was deployed far earlier
  // than that, so this call is EXPECTED to fail here, not expected to
  // succeed — this test documents and confirms that expectation rather
  // than asserting success. A freshly-deployed Scout memecoin (minutes to
  // hours old) would very likely still be within the retained window and
  // succeed — this limitation mainly bites long-lived tokens like WETH.
  try {
    const creationInfo = await chainClient.getContractCreationInfo(WETH);
    // If this RPC's retention window has grown or a different node answered, that's fine too.
    if (creationInfo) {
      const age = computeTokenAge(creationInfo.deploymentTimestamp);
      t.diagnostic(`unexpectedly succeeded — WETH age category: ${age.ageCategory}`);
    }
  } catch (error) {
    t.diagnostic(
      `deployment lookup failed as expected for an old contract on a non-archive RPC: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    assert.match(String(error), /findContractDeploymentBlock/);
  }
});

test("[integration] runs market flow and pool quality analysis on real, bounded swap data", async (t) => {
  const chainClient = new RobinhoodChainClient();
  const poolProvider = new UniswapV3PoolProvider({ chainClient });

  const poolsResult = await poolProvider.discoverPools(WETH);
  assert.equal(poolsResult.status, "ok");
  const pool = poolsResult.data![0];

  const toBlock = await chainClient.getBlockNumber();
  const fromBlock = toBlock - 20n; // small, bounded — see module doc comment
  const swapsResult = await poolProvider.getRecentSwaps(pool, { fromBlock, toBlock });
  assert.notEqual(swapsResult.status, "error");

  const flow = new MarketFlowAnalyzer().analyze(ROBINHOOD_MAINNET_CHAIN_ID, pool.poolAddress, swapsResult.data ?? [], 18);
  assert.ok(flow.buyCount + flow.sellCount + flow.unknownCount === (swapsResult.data ?? []).length);

  // This pool (WETH/USDG) is also old enough to likely fall outside the
  // RPC's retention window (same documented limitation as the deployment
  // lookup test above) — PoolQualityAnalyzer already catches that
  // internally and reports null rather than crashing, so we assert
  // exactly that graceful degradation here, not a specific age value.
  const poolQuality = await new PoolQualityAnalyzer({ chainClient }).assessPool(pool, swapsResult.data ?? []);
  t.diagnostic(`pool age lookup result: ${poolQuality.poolAgeSeconds === null ? "unavailable (expected for an old pool)" : `${poolQuality.poolAgeSeconds}s`}`);
  assert.ok(poolQuality.dataQuality === "KNOWN" || poolQuality.dataQuality === "PARTIAL" || poolQuality.dataQuality === "UNAVAILABLE");
});
