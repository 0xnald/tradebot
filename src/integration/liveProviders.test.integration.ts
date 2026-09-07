// Optional integration tests that hit REAL external services. These are
// NOT part of `npm test` (see the `*.test.integration.ts` naming and the
// separate `npm run test:integration` script) — they're slower, can be
// flaky (see docs/DATA_SOURCES.md §3 on Blockscout's intermittent
// Cloudflare gating), and cost real, if small, request quota against
// third-party APIs. Run manually with:
//
//   npm run test:integration
//
// Every assertion here is deliberately loose (sanity-checking shape, not
// exact values) since live data changes constantly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import { DexScreenerMarketDataProvider } from "../market-data/dexScreenerMarketDataProvider.js";
import { BlockscoutHolderDataProvider } from "../token-analysis/blockscoutHolderDataProvider.js";
import { ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS, ROBINHOOD_MAINNET_CHAIN_ID } from "../blockchain/chainConfig.js";

const WETH = ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS.WETH.address;

test("[integration] RobinhoodChainClient connects to the real public RPC and reads a block number", async () => {
  const client = new RobinhoodChainClient();
  const blockNumber = await client.getBlockNumber();
  assert.ok(blockNumber > 0n, `expected a positive block number, got ${blockNumber}`);
});

test("[integration] RobinhoodChainClient reads real WETH token metadata on-chain", async () => {
  const client = new RobinhoodChainClient();
  const metadata = await client.getTokenMetadata(WETH as `0x${string}`);
  assert.equal(metadata.symbol, "WETH");
  assert.equal(metadata.decimals, 18);
});

test("[integration] DexScreener returns real pool data for WETH on Robinhood Chain", async () => {
  const provider = new DexScreenerMarketDataProvider();
  const result = await provider.getMarketData(ROBINHOOD_MAINNET_CHAIN_ID, WETH);
  assert.equal(result.status, "ok");
  assert.ok((result.data?.pools.length ?? 0) > 0, "expected at least one real pool for WETH");
});

test("[integration] Blockscout holder provider against the real explorer (known to be flaky — see docs/DATA_SOURCES.md)", async (t) => {
  const provider = new BlockscoutHolderDataProvider();
  const result = await provider.getHolderDistribution(ROBINHOOD_MAINNET_CHAIN_ID, WETH);

  if (result.status === "error") {
    t.diagnostic(
      `Blockscout call failed (this is a known, documented flakiness — see docs/DATA_SOURCES.md §3): ${JSON.stringify(result.errors)}`,
    );
    return; // do not fail the run for a documented, external flakiness
  }

  assert.ok(result.data?.totalHolders === null || (result.data?.totalHolders ?? 0) > 0);
});
