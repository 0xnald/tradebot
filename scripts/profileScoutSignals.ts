// Phase 7.2 §2 — a one-off diagnostic script (NOT part of the production
// pipeline) to establish ground truth for the 7 real eligible Scout
// signals BEFORE implementing anything new. Runs each real network call
// with a generous, separately-measured timeout (not the live pipeline's
// bounded 4000ms budget) specifically so we can see what's actually true
// about these tokens' venues, not just what the bounded live path
// currently manages to learn in time.
//
// Read-only. Makes no trading decisions. Not wired into any script.json entry.

import { RobinhoodChainClient } from "../src/blockchain/robinhoodChainClient.js";
import { PonsV2Provider } from "../src/market-data/ponsV2Provider.js";
import { UniswapV3PoolProvider } from "../src/market-data/uniswapV3PoolProvider.js";
import { DexScreenerMarketDataProvider } from "../src/market-data/dexScreenerMarketDataProvider.js";

const TOKENS = [
  { symbol: "THROBBIN", address: "0xeb1898a0d496000506a2799e1b4077776497fd29" },
  { symbol: "BUFO", address: "0x1bccd714b4cf60f6649312f0ce5c4a316f7d1c3f" },
  { symbol: "BABA", address: "0xad25ac6c84d497db898fa1e8387bf6af3532a1c4" },
  { symbol: "CRC-1", address: "0x446adb118f5f15f2a749e38288d4025b55f3e095" },
  { symbol: "CRC-2", address: "0x78adeb8dddecb0fda01d8811dd614ff66e131e18" },
  { symbol: "Diem", address: "0xf6657666d84f8232b18db21c3d9ba7d7faae7f11" },
  { symbol: "BIOHACKING", address: "0x7a00542943fdabab95c82b9fa93c9699227c9319" },
];

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; ms: number; result: T | null; error: string | null }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { label, ms: Date.now() - start, result, error: null };
  } catch (error) {
    return { label, ms: Date.now() - start, result: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const chainClient = new RobinhoodChainClient();
  const ponsV2Provider = new PonsV2Provider({ chainClient });
  const v3PoolProvider = new UniswapV3PoolProvider({ chainClient });
  const dexScreener = new DexScreenerMarketDataProvider();

  for (const { symbol, address } of TOKENS) {
    console.log(`\n=== ${symbol} (${address}) ===`);

    const pons = await timed("ponsV2Provider.getLaunchInfo", () => ponsV2Provider.getLaunchInfo(address));
    console.log(`  Pons lookup: ${pons.ms}ms, error=${pons.error ?? "none"}`);
    if (pons.result && pons.result.status === "ok" && pons.result.data) {
      const info = pons.result.data;
      console.log(`  -> IS a Pons V2 launch. phase=${info.phase} priceIdentifierKind=${info.priceIdentifierKind} graduationTimestamp=${info.graduationTimestamp}`);
      console.log(`  -> curve=${info.curve} pairToken=${info.pairToken} priceIdentifier=${info.priceIdentifier}`);
    } else {
      console.log(`  -> NOT a Pons V2 launch (or lookup failed): status=${pons.result?.status}`);
    }

    const v3 = await timed("v3PoolProvider.discoverPools", () => v3PoolProvider.discoverPools(address));
    console.log(`  V3 discovery: ${v3.ms}ms, error=${v3.error ?? "none"}, pools=${v3.result?.status === "ok" ? v3.result.data?.length : "n/a"}`);

    const dex = await timed("dexScreener.getMarketData", () => dexScreener.getMarketData(chainClient.chainId, address));
    console.log(`  DexScreener: ${dex.ms}ms, error=${dex.error ?? "none"}, priceUsd=${dex.result?.status === "ok" ? dex.result.data?.priceUsd : "n/a"}, liquidityUsd=${dex.result?.status === "ok" ? dex.result.data?.liquidityUsd : "n/a"}`);
  }
}

main().catch((error) => {
  console.error("profiling script failed", error);
  process.exitCode = 1;
});
