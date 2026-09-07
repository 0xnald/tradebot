// Phase 7.3A — A/B benchmark: public Robinhood RPC vs. a configured
// authenticated endpoint (ROBINHOOD_RPC_HTTP / ROBINHOOD_RPC_WS, or the
// original ROBINHOOD_CHAIN_RPC_URL / ROBINHOOD_CHAIN_WS_URL names —
// chainConfig.ts's loadChainConfigFromEnv() reads whichever is set).
//
// Read-only. Never prints the authenticated URL, an API key, or any
// query parameter — see chainConfig.ts's `describeRpcEndpointSafely`.
//
// Uses the EXACT production addresses/ABIs/event definitions and the
// EXACT production block-window logic (`estimateRecentBlockWindow`) —
// never an artificially easier query. Not wired into a hot path; run
// directly with `npm run rpc:benchmark`.

import { RobinhoodChainClient } from "../src/blockchain/robinhoodChainClient.js";
import { BlockTimeEstimator } from "../src/blockchain/blockTimeEstimator.js";
import { loadChainConfigFromEnv, describeRpcEndpointSafely, PONS_ADDRESSES, UNISWAP_V4_ADDRESSES } from "../src/blockchain/chainConfig.js";
import { PONS_V2_FACTORY_ABI, PONS_V2_CURVE_ABI } from "../src/market-data/ponsV2Abi.js";
import { UNISWAP_V4_SWAP_EVENT } from "../src/market-data/uniswapV4Abi.js";
import { estimateRecentBlockWindow, CURVE_LOOKBACK_MINUTES, GRADUATION_MARGIN_MINUTES } from "../src/live/resolvedMarketContext.js";

const PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const ITERATIONS = 5;

// The exact real signals this project already established as ground truth (Phase 7.2/7.3
// profiling) — same addresses/identifiers production actually resolves for these tokens.
const THROBBIN = { address: "0xeb1898a0d496000506a2799e1b4077776497fd29", scoutTime: "2026-09-04T19:54:09.000Z" };
const BIOHACKING = { address: "0x7a00542943fdabab95c82b9fa93c9699227c9319", curve: "0xd89C13518D569c2162722410e0B8A5816B6B1d87", scoutTime: "2026-09-04T20:31:00.000Z" };
// From the earlier standalone profiling run (docs/LIVE_INTELLIGENCE.md §4): THROBBIN's real
// resolved V4 PoolId and graduation timestamp.
const THROBBIN_POOL_ID = "0x29a9f241f8299f80d4fc533fee32e97a10b4b5d39d52f6b6376e1b596ab2cad3";
const THROBBIN_GRADUATED_AT = "2026-09-04T19:52:32.000Z";

interface Measurement {
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  resultSize?: number;
  error?: string;
}

/**
 * §1/§12 — viem's own HTTP-transport error messages sometimes embed the
 * full request URL (e.g. "HTTP request failed. URL: https://host/v2/KEY").
 * `describeRpcEndpointSafely` only protects OUR OWN log lines; error text
 * from the library needs its own scrub before it's ever printed. Replaces
 * every `http(s)://...` occurrence with a redaction marker, UNLESS it's
 * exactly the known-public, non-secret Robinhood endpoint.
 */
function redactUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"')]+/g, (matched) => (matched.startsWith(PUBLIC_RPC_URL) ? matched : "<redacted-url>"));
}

async function measure<T>(fn: () => Promise<T>, timeoutMs: number, resultSize?: (r: T) => number): Promise<Measurement> {
  const startedAt = Date.now();
  try {
    const result = await Promise.race([
      fn().then((r) => ({ kind: "ok" as const, r })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), timeoutMs)),
    ]);
    const durationMs = Date.now() - startedAt;
    if (result.kind === "timeout") return { ok: false, timedOut: true, durationMs };
    return { ok: true, timedOut: false, durationMs, resultSize: resultSize?.(result.r) };
  } catch (error) {
    return { ok: false, timedOut: false, durationMs: Date.now() - startedAt, error: redactUrls(error instanceof Error ? error.message : String(error)) };
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

interface OperationReport {
  name: string;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  note?: string;
  sampleError?: string;
}

function summarize(name: string, measurements: Measurement[], note?: string): OperationReport {
  const successes = measurements.filter((m) => m.ok);
  const durations = successes.map((m) => m.durationMs).sort((a, b) => a - b);
  const firstFailure = measurements.find((m) => !m.ok && !m.timedOut && m.error);
  return {
    name,
    successCount: successes.length,
    failureCount: measurements.filter((m) => !m.ok && !m.timedOut).length,
    timeoutCount: measurements.filter((m) => m.timedOut).length,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length > 0 ? durations[durations.length - 1] : null,
    note,
    // §12 — record the EXACT class of limitation (never worked around here) — a provider's own
    // JSON-RPC error message is not a secret; it never contains the request URL or API key.
    sampleError: firstFailure?.error,
  };
}

function printReport(label: string, reports: OperationReport[]): void {
  console.log(`\n--- ${label} ---`);
  for (const r of reports) {
    console.log(`  ${r.name}: ok=${r.successCount} fail=${r.failureCount} timeout=${r.timeoutCount} median=${r.medianMs ?? "n/a"}ms p95=${r.p95Ms ?? "n/a"}ms max=${r.maxMs ?? "n/a"}ms${r.note ? `  (${r.note})` : ""}`);
    if (r.sampleError) console.log(`      sample error: ${r.sampleError.slice(0, 300)}`);
  }
}

async function benchmarkProvider(label: string, chainClient: RobinhoodChainClient, timeoutMs: number): Promise<OperationReport[]> {
  const reports: OperationReport[] = [];
  const blockTimeEstimator = new BlockTimeEstimator(chainClient);

  // 1. getBlockNumber
  {
    const ms: Measurement[] = [];
    for (let i = 0; i < ITERATIONS; i++) ms.push(await measure(() => chainClient.getBlockNumber(), timeoutMs));
    reports.push(summarize("getBlockNumber", ms));
  }

  // 2. representative eth_call — token metadata (name/symbol/decimals/totalSupply, batched)
  {
    const ms: Measurement[] = [];
    for (let i = 0; i < ITERATIONS; i++) ms.push(await measure(() => chainClient.getTokenMetadata(THROBBIN.address as `0x${string}`), timeoutMs));
    reports.push(summarize("getTokenMetadata (eth_call x4, batched)", ms));
  }

  // 3/4. Pons launch/factory + lifecycle lookup — ONE call in production (getLaunchedToken
  // returns both launch identity AND lifecycle phase together — see ponsV2Provider.ts).
  {
    const ms: Measurement[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      ms.push(
        await measure(
          () =>
            chainClient.readContract({
              address: PONS_ADDRESSES.v2Factory as `0x${string}`,
              abi: PONS_V2_FACTORY_ABI,
              functionName: "getLaunchedToken",
              args: [THROBBIN.address as `0x${string}`],
            }),
          timeoutMs,
        ),
      );
    }
    reports.push(summarize("Pons getLaunchedToken (factory + lifecycle, one call)", ms, "same call serves both §3 items 3 and 4 in this implementation"));
  }

  // 5. Bounded eth_getLogs for Pons curve events — THE flow-query bottleneck identified in Phase 7.3.
  {
    const window = await estimateRecentBlockWindow(blockTimeEstimator, chainClient, BIOHACKING.scoutTime, CURVE_LOOKBACK_MINUTES, new Date());
    const ms: Measurement[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      ms.push(
        await measure(
          () => chainClient.getLogs({ address: BIOHACKING.curve as `0x${string}`, event: PONS_V2_CURVE_ABI[0], fromBlock: window.fromBlock, toBlock: window.toBlock }),
          timeoutMs,
          (logs) => logs.length,
        ),
      );
    }
    reports.push(summarize(`eth_getLogs — Pons curve CurveBuy (BIOHACKING, blocks ${window.fromBlock}-${window.toBlock})`, ms));
  }

  // 6. Bounded eth_getLogs for Uniswap V4 Swap events — the SAME query the V4 flow reader makes.
  {
    const window = await estimateRecentBlockWindow(blockTimeEstimator, chainClient, THROBBIN_GRADUATED_AT, GRADUATION_MARGIN_MINUTES, new Date());
    const ms: Measurement[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      ms.push(
        await measure(
          () =>
            chainClient.getLogs({
              address: UNISWAP_V4_ADDRESSES.poolManager as `0x${string}`,
              event: UNISWAP_V4_SWAP_EVENT,
              args: { id: THROBBIN_POOL_ID as `0x${string}` },
              fromBlock: window.fromBlock,
              toBlock: window.toBlock,
            }),
          timeoutMs,
          (logs) => logs.length,
        ),
      );
    }
    reports.push(summarize(`eth_getLogs — Uniswap V4 Swap (THROBBIN, blocks ${window.fromBlock}-${window.toBlock})`, ms));
  }

  return reports;
}

async function main(): Promise<void> {
  const configured = loadChainConfigFromEnv();
  const usingAuthenticated = configured.rpcUrl !== PUBLIC_RPC_URL;
  console.log(`Authenticated endpoint configured: ${usingAuthenticated ? "yes" : "no"} — ${describeRpcEndpointSafely(configured.rpcUrl)}`);

  const publicClient = new RobinhoodChainClient({ config: { chainId: configured.chainId, rpcUrl: PUBLIC_RPC_URL } });
  const authenticatedClient = usingAuthenticated ? new RobinhoodChainClient({ config: configured }) : null;

  const TIMEOUT_MS = 15_000; // generous for the benchmark itself — NOT the production 4000ms decision budget, deliberately, so we can see real latency beyond it rather than only "timed out at 4s" for both.

  const publicReports = await benchmarkProvider("PUBLIC", publicClient, TIMEOUT_MS);
  printReport("PUBLIC Robinhood RPC (https://rpc.mainnet.chain.robinhood.com)", publicReports);

  if (authenticatedClient) {
    const authReports = await benchmarkProvider("AUTHENTICATED", authenticatedClient, TIMEOUT_MS);
    printReport("AUTHENTICATED configured RPC (host redacted per policy — see above)", authReports);
  } else {
    console.log("\nNo authenticated endpoint configured (ROBINHOOD_RPC_HTTP / ROBINHOOD_CHAIN_RPC_URL unset) — skipping the AUTHENTICATED side of the comparison.");
  }
}

main().catch((error) => {
  console.error("RPC benchmark failed", error);
  process.exitCode = 1;
});
