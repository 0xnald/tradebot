// Phase 7.3 §26 — single-signal control: runs each of the 4 known Pons
// tokens (from the real captured fixture) individually through the EXACT
// production `processRawMessage` (signalProcessor.ts) — not the
// standalone diagnostic script (scripts/profileScoutSignals.ts), and not
// the full 7-signal concurrent replay. If a token resolves correctly here
// but not in the full concurrent replay, that is strong evidence of
// contention; if it ALSO fails here, the pipeline itself needs
// investigation, not just concurrency.
//
// Read-only + paper-simulation only. Not wired into package.json — run
// directly with `npx tsx scripts/singleSignalControl.ts`.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processRawMessage } from "../src/live/signalProcessor.js";
import { runWithSignalContext } from "../src/shared/signalContext.js";
import { resetGlobalRpcLimiter, getGlobalRpcLimiter } from "../src/blockchain/rpcConcurrencyLimiter.js";
import { getGlobalRpcCallLog, resetGlobalRpcCallLog } from "../src/blockchain/rpcInstrumentation.js";
import { RobinhoodChainClient } from "../src/blockchain/robinhoodChainClient.js";
import { BlockTimestampResolver } from "../src/blockchain/blockTimestampResolver.js";
import { BlockTimeEstimator } from "../src/blockchain/blockTimeEstimator.js";
import { wrapChainClientWithRpcControl } from "../src/blockchain/instrumentedChainClient.js";
import { UniswapV3PoolProvider } from "../src/market-data/uniswapV3PoolProvider.js";
import { PonsV2Provider } from "../src/market-data/ponsV2Provider.js";
import { CachingPonsV2Provider } from "../src/market-data/cachingPonsV2Provider.js";
import { DexScreenerMarketDataProvider } from "../src/market-data/dexScreenerMarketDataProvider.js";
import { GeckoTerminalHistoricalPriceProvider } from "../src/backtesting/geckoTerminalHistoricalPriceProvider.js";
import { BlockscoutHolderDataProvider } from "../src/token-analysis/blockscoutHolderDataProvider.js";
import { TokenAnalysisService } from "../src/token-analysis/tokenAnalysisService.js";
import { SmartSelectionEngine } from "../src/scoring/smartSelectionEngine.js";
import { SMART_SELECTION_V1_CONFIG } from "../src/scoring/smartSelectionConfig.js";
import { PaperPortfolio } from "../src/live/paperPortfolio.js";
import type { RawScoutMessage } from "../src/ingestion/types.js";

const SOURCE = "telegram:scoutrobinhood";
const PROVIDER_TIMEOUT_MS = 4000;

// The 4 real tokens confirmed Pons V2 by scripts/profileScoutSignals.ts.
const PONS_TOKEN_ADDRESSES = new Set([
  "0xeb1898a0d496000506a2799e1b4077776497fd29", // THROBBIN — graduated (V4)
  "0x446adb118f5f15f2a749e38288d4025b55f3e095", // CRC-1 — graduated (V4)
  "0xf6657666d84f8232b18db21c3d9ba7d7faae7f11", // Diem — graduated (V4)
  "0x7a00542943fdabab95c82b9fa93c9699227c9319", // BIOHACKING — NOT graduated (curve)
]);

function extractContractAddress(raw: RawScoutMessage): string | null {
  for (const button of raw.buttons ?? []) {
    const match = button.url.match(/0x[a-fA-F0-9]{40}/);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

async function main(): Promise<void> {
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "ingestion", "fixtures", "scoutrobinhood-2026-09-04.raw.json");
  const raw = JSON.parse(await fs.readFile(fixturePath, "utf8")) as RawScoutMessage[];
  const targets = raw.filter((m) => {
    const addr = extractContractAddress(m);
    return addr && PONS_TOKEN_ADDRESSES.has(addr);
  });
  console.log(`Found ${targets.length} of ${PONS_TOKEN_ADDRESSES.size} known Pons signals in the fixture.\n`);

  for (const message of targets) {
    resetGlobalRpcLimiter();
    resetGlobalRpcCallLog();

    const chainClient = new RobinhoodChainClient();
    const criticalChainClient = wrapChainClientWithRpcControl(chainClient, { caller: "single-signal-control", priority: "CRITICAL" }) as unknown as RobinhoodChainClient;
    const poolDataProvider = new UniswapV3PoolProvider({ chainClient: criticalChainClient });
    const ponsV2Provider = new CachingPonsV2Provider(new PonsV2Provider({ chainClient: criticalChainClient }));
    const geckoTerminalProvider = new GeckoTerminalHistoricalPriceProvider();
    const marketDataProvider = new DexScreenerMarketDataProvider();
    const tokenAnalysisService = new TokenAnalysisService({ chainClient: criticalChainClient, holderProvider: new BlockscoutHolderDataProvider() });
    const onChain = { chainClient: criticalChainClient, blockTimestampResolver: new BlockTimestampResolver(criticalChainClient), blockTimeEstimator: new BlockTimeEstimator(criticalChainClient) };

    const portfolio = new PaperPortfolio({
      startingCapitalUsd: 1000, positionSizePct: 10, maxPositionSizeUsd: 200, maxConcurrentPositions: 5,
      slippagePct: 1, feePct: 0.5, takeProfitPct: 50, stopLossPct: 20, maxHoldingMinutes: 240,
      liquidityEmergencyExitUsd: 500, maxSignalAgeSecondsForEntry: 120, priceStalenessSeconds: 60,
    });

    const startedAt = Date.now();
    const record = await runWithSignalContext(`${SOURCE}:${message.id}`, () =>
      processRawMessage(message, {
        source: SOURCE,
        intelligenceDeps: { poolDataProvider, ponsV2Provider, geckoTerminalProvider, onChain, marketDataProvider, tokenAnalysisService, chainId: chainClient.chainId, timeoutMs: PROVIDER_TIMEOUT_MS },
        smartSelectionEngine: new SmartSelectionEngine(SMART_SELECTION_V1_CONFIG),
        portfolio,
        generatePositionId: () => crypto.randomUUID(),
        isDuplicate: async () => false,
        markProcessed: async () => {},
        maxSignalAgeSecondsForEntry: 120,
      }),
    );
    const elapsedMs = Date.now() - startedAt;

    const rpcSummary = getGlobalRpcCallLog().summarize();
    console.log(`=== ${message.text.split("\n")[0]} (message ${message.id}) ===`);
    console.log(`  venue: ${record.venueType}  decision: ${record.decision}  score: ${record.overallScore?.toFixed(1) ?? "n/a"}  confidence: ${record.confidence ?? "n/a"}`);
    console.log(`  total decision latency: ${elapsedMs}ms`);
    console.log(`  RPC requests: ${rpcSummary.totalRequests}, max concurrency: ${rpcSummary.maxConcurrencyObserved}, timeouts: ${rpcSummary.timeoutCount}, errors: ${rpcSummary.errorCount}`);
    console.log(`  by method: ${JSON.stringify(rpcSummary.requestsByMethod)}`);
    console.log(`  by caller: ${JSON.stringify(rpcSummary.requestsByCaller)}`);
    console.log(`  dataQuality: ${JSON.stringify(record.dataQuality.fields.filter((f) => ["liquidity", "marketFlow", "momentum"].includes(f.field)))}`);
    console.log("");
  }
}

main().catch((error) => {
  console.error("single-signal control script failed", error);
  process.exitCode = 1;
});
