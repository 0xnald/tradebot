// Phase 7.2 §3/§4/§15 — a LIVE-ONLY reader for a confirmed, still-trading
// Pons V2 bonding curve. Deliberately separate from
// src/backtesting/onChainPonsCurvePriceProvider.ts: that provider is
// correctly gated on a recognized USD-stable quote token (appropriate for
// producing comparable historical USD candles), but a live decision must
// NOT lose all price/flow evidence just because a curve's quote asset is
// a tokenized-equity token rather than USDG (Phase 6.6's finding) — see
// docs/DATA_SOURCES.md §7. This reader always returns quote-denominated
// values and layers on a USD figure ONLY when `convertToUsd` (unchanged,
// ungated) actually resolves one — never a fabricated conversion.
//
// One bounded event fetch (CurveBuy + CurveSell in a single recent block
// window) serves BOTH price and flow — no reason to fetch the same
// events twice for two different questions (Phase 7.2 §10/§14).
//
// RPC bounds (§12): the caller supplies `fromBlock`/`toBlock` — this
// module does not decide the window itself, so a caller with a known
// launch block can pass a genuinely small, relevant range. A shallow
// `fetchLogsWithAdaptiveChunking` max-split-depth (matching the
// historical providers' own documented finding: a full-depth cascade
// against a busy curve took 150+ seconds) fails fast into
// partial/unavailable rather than stalling the Scout decision.

import { fetchLogsHybrid } from "../blockchain/hybridLogFetcher.js";
import { convertToUsd } from "../backtesting/quoteAssetUsdPricing.js";
import { PONS_V2_CURVE_ABI } from "./ponsV2Abi.js";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import type { BlockTimestampResolver } from "../blockchain/blockTimestampResolver.js";
import { loadPrimaryRpcCapabilities, type RpcProviderCapabilities } from "../blockchain/chainConfig.js";
import type { RpcProviderRole } from "../blockchain/rpcRouting.js";
import type { DataQualityState, FlowCompleteness, MarketFlowAnalysis, SwapRecord } from "../types/domain.js";
import { MarketFlowAnalyzer } from "./marketFlowAnalyzer.js";

const MAX_SPLIT_DEPTH = 3;

export interface PonsCurveMarketReaderOptions {
  chainClient: RobinhoodChainClient;
  blockTimestampResolver: BlockTimestampResolver;
  /** Phase 7.4 §10 — a separate client used ONLY for the CurveBuy/CurveSell event fetch when the requested range exceeds `primaryCapabilities`'s known cap (routed via `chooseRpcForLogQuery`). Defaults to `chainClient`, so a caller that never sets this up (e.g. an existing test) gets exactly the pre-Phase-7.4 single-provider behavior. */
  logChainClient?: RobinhoodChainClient;
  /** Phase 7.4 §5 — `chainClient`'s known eth_getLogs range cap. Defaults to `loadPrimaryRpcCapabilities()` (the current measured Alchemy Free-tier limit); pass an explicit value in tests rather than relying on env vars. */
  primaryCapabilities?: RpcProviderCapabilities;
}

export interface PonsCurveTrade {
  blockNumber: number;
  transactionHash: string;
  side: "BUY" | "SELL";
  quoteAmountRaw: bigint;
  tokenAmountRaw: bigint;
  buyerOrSeller: string | null;
}

export interface PonsCurvePriceResult {
  priceInQuote: number | null;
  priceUsd: number | null;
  quoteTokenAddress: string;
  observedAtBlock: number | null;
  dataQuality: DataQualityState;
  notes: string[];
}

export interface PonsCurveLiquidityResult {
  quoteReserveRaw: string | null;
  quoteReserveInQuote: number | null;
  liquidityUsd: number | null;
  quoteTokenAddress: string;
  dataQuality: DataQualityState;
  notes: string[];
}

export interface PonsCurveFlowResult {
  marketFlow: MarketFlowAnalysis | null;
  swaps: SwapRecord[];
  priceObservations: { blockNumber: number; timestamp: string | undefined; priceInQuote: number }[];
  dataQuality: DataQualityState;
  /** Phase 7.4 §14 — honest completeness of the underlying event fetch (never "FULL" just because the window happened to contain zero trades from a failed/partial fetch — see `fetchCurveTrades`). */
  flowCompleteness: FlowCompleteness;
  /** Phase 7.4 §9/§10 — which provider role actually served the CurveBuy/CurveSell fetch. */
  providerRole: RpcProviderRole;
  notes: string[];
}

/** Fetches CurveBuy+CurveSell once for [fromBlock, toBlock] — shared by price/liquidity-adjacent/flow so no caller pays for the same event scan twice. Phase 7.4 §10: routes each event fetch to PRIMARY or LOG per `chooseRpcForLogQuery`, deciding BEFORE either request is made — never "try primary first." */
async function fetchCurveTrades(
  chainClient: RobinhoodChainClient,
  logChainClient: RobinhoodChainClient,
  primaryCapabilities: RpcProviderCapabilities,
  curveAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ trades: PonsCurveTrade[]; notes: string[]; completeness: FlowCompleteness; providerRole: RpcProviderRole }> {
  const notes: string[] = [];
  const clients = { primary: chainClient, log: logChainClient };
  const routing = { purpose: "PONS_CURVE_FLOW" as const, primaryCapabilities };

  const [buyOutcome, sellOutcome] = await Promise.all([
    fetchLogsHybrid(clients, { address: curveAddress as `0x${string}`, event: PONS_V2_CURVE_ABI[0], fromBlock, toBlock }, routing, MAX_SPLIT_DEPTH),
    fetchLogsHybrid(clients, { address: curveAddress as `0x${string}`, event: PONS_V2_CURVE_ABI[1], fromBlock, toBlock }, routing, MAX_SPLIT_DEPTH),
  ]);

  const providerRole = buyOutcome.providerRole; // identical for both — same [fromBlock, toBlock], so the same routing decision
  if (buyOutcome.status !== "OK" || sellOutcome.status !== "OK") {
    const failed = buyOutcome.status !== "OK" ? buyOutcome : sellOutcome;
    notes.push(`curve event fetch (${providerRole}) did not complete within the requested bounded window: ${failed.reason ?? failed.status}`);
    const completeness: FlowCompleteness = failed.status === "TIMED_OUT" ? "TIMED_OUT" : failed.status === "UNAVAILABLE" ? "UNAVAILABLE" : "FAILED";
    return { trades: [], notes, completeness, providerRole };
  }

  const trades: PonsCurveTrade[] = [];
  for (const log of buyOutcome.data as any[]) {
    const quoteIn = log.args?.quoteIn as bigint | undefined;
    const tokensOut = log.args?.tokensOut as bigint | undefined;
    if (quoteIn === undefined || tokensOut === undefined || tokensOut <= 0n) continue; // malformed/zero -> excluded, never guessed
    trades.push({ blockNumber: Number(log.blockNumber), transactionHash: log.transactionHash, side: "BUY", quoteAmountRaw: quoteIn, tokenAmountRaw: tokensOut, buyerOrSeller: (log.args?.buyer as string) ?? null });
  }
  for (const log of sellOutcome.data as any[]) {
    const tokensIn = log.args?.tokensIn as bigint | undefined;
    const quoteOut = log.args?.quoteOut as bigint | undefined;
    if (tokensIn === undefined || quoteOut === undefined || tokensIn <= 0n) continue;
    trades.push({ blockNumber: Number(log.blockNumber), transactionHash: log.transactionHash, side: "SELL", quoteAmountRaw: quoteOut, tokenAmountRaw: tokensIn, buyerOrSeller: (log.args?.seller as string) ?? null });
  }
  trades.sort((a, b) => a.blockNumber - b.blockNumber);
  return { trades, notes, completeness: "AVAILABLE_FULL", providerRole };
}

function tradePriceInQuote(trade: PonsCurveTrade, tokenDecimals: number, quoteDecimals: number): number {
  const tokenAmount = Number(trade.tokenAmountRaw) / 10 ** tokenDecimals;
  const quoteAmount = Number(trade.quoteAmountRaw) / 10 ** quoteDecimals;
  return quoteAmount / tokenAmount;
}

export class PonsCurveMarketReader {
  #chainClient: RobinhoodChainClient;
  #logChainClient: RobinhoodChainClient;
  #primaryCapabilities: RpcProviderCapabilities;
  #blockTimestampResolver: BlockTimestampResolver;

  constructor(options: PonsCurveMarketReaderOptions) {
    this.#chainClient = options.chainClient;
    this.#logChainClient = options.logChainClient ?? options.chainClient;
    this.#primaryCapabilities = options.primaryCapabilities ?? loadPrimaryRpcCapabilities();
    this.#blockTimestampResolver = options.blockTimestampResolver;
  }

  /** Current price = the most recent trade's implied price within the bounded window. Never a guess when the window has no trades. */
  async getCurrentPrice(curveAddress: string, quoteTokenAddress: string, tokenDecimals: number, quoteDecimals: number, fromBlock: bigint, toBlock: bigint): Promise<PonsCurvePriceResult> {
    const { trades, notes } = await fetchCurveTrades(this.#chainClient, this.#logChainClient, this.#primaryCapabilities, curveAddress, fromBlock, toBlock);
    if (trades.length === 0) {
      return { priceInQuote: null, priceUsd: null, quoteTokenAddress, observedAtBlock: null, dataQuality: "UNAVAILABLE", notes: [...notes, "no CurveBuy/CurveSell events found within the bounded window"] };
    }
    const latest = trades[trades.length - 1];
    const priceInQuote = tradePriceInQuote(latest, tokenDecimals, quoteDecimals);
    const priceUsd = convertToUsd(priceInQuote, quoteTokenAddress);
    return { priceInQuote, priceUsd, quoteTokenAddress, observedAtBlock: latest.blockNumber, dataQuality: "KNOWN", notes };
  }

  /**
   * Curve "liquidity" during the bonding-curve phase is NOT a Uniswap-style
   * pool liquidity figure — it's the curve contract's own quote-token
   * balance (its reserve), read directly via a single balance call (no
   * event scan needed at all — the fastest possible answer). Per §15:
   * never automatically mapped to USD; only converted when the quote
   * asset is a recognized USD-stable.
   */
  async getReserveLiquidity(curveAddress: string, quoteTokenAddress: string, quoteDecimals: number): Promise<PonsCurveLiquidityResult> {
    try {
      const raw = await this.#chainClient.getTokenBalance(quoteTokenAddress as `0x${string}`, curveAddress as `0x${string}`);
      const inQuote = Number(raw) / 10 ** quoteDecimals;
      const usd = convertToUsd(inQuote, quoteTokenAddress);
      return { quoteReserveRaw: raw.toString(), quoteReserveInQuote: inQuote, liquidityUsd: usd, quoteTokenAddress, dataQuality: "KNOWN", notes: [] };
    } catch (error) {
      return { quoteReserveRaw: null, quoteReserveInQuote: null, liquidityUsd: null, quoteTokenAddress, dataQuality: "UNAVAILABLE", notes: [`curve reserve balance read failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  /**
   * Flow: reuses the SAME event fetch pattern (a fresh fetch — the caller
   * decides whether to share the price call's own fetch when it's cheap
   * to do so; kept as a separate method for a clear, testable contract)
   * and feeds the EXISTING, unmodified `MarketFlowAnalyzer` — this module
   * only supplies observations, never reimplements flow scoring.
   */
  async getRecentFlow(
    chainId: number,
    curveAddress: string,
    quoteTokenAddress: string,
    tokenDecimals: number,
    quoteDecimals: number,
    fromBlock: bigint,
    toBlock: bigint,
    now: Date = new Date(),
  ): Promise<PonsCurveFlowResult> {
    const { trades, notes, completeness, providerRole } = await fetchCurveTrades(this.#chainClient, this.#logChainClient, this.#primaryCapabilities, curveAddress, fromBlock, toBlock);
    if (trades.length === 0) {
      return {
        marketFlow: null,
        swaps: [],
        priceObservations: [],
        dataQuality: "UNAVAILABLE",
        flowCompleteness: completeness === "AVAILABLE_FULL" ? "AVAILABLE_FULL" : completeness, // a genuinely-empty-but-successfully-fetched window is honestly FULL, not a failure
        providerRole,
        notes: [...notes, completeness === "AVAILABLE_FULL" ? "no CurveBuy/CurveSell events found within the bounded window" : "curve event fetch did not complete"],
      };
    }

    // Phase 7.4 §12/§B — resolved CONCURRENTLY, not one-at-a-time: with hybrid routing now actually
    // returning real trade data (previously this never ran, since the getLogs fetch itself always
    // failed first), a busy curve can have dozens of trades, and BlockTimestampResolver already
    // de-duplicates concurrent requests for the SAME block via its own `#pending` map — sequentially
    // awaiting each one was quietly the real latency bottleneck once the fetch itself started
    // succeeding, easily exceeding the whole decision budget on its own. `Promise.all` preserves
    // per-trade order (map order, not resolution order) and produces IDENTICAL values, just faster.
    const resolvedTimestamps = await Promise.all(
      trades.map(async (trade) => {
        try {
          return await this.#blockTimestampResolver.resolve(BigInt(trade.blockNumber));
        } catch {
          return undefined; // timestamp genuinely unavailable — the swap record still carries everything else known
        }
      }),
    );

    const swaps: SwapRecord[] = [];
    const priceObservations: { blockNumber: number; timestamp: string | undefined; priceInQuote: number }[] = [];
    trades.forEach((trade, i) => {
      const timestamp = resolvedTimestamps[i];
      swaps.push({
        chainId,
        poolAddress: curveAddress,
        transactionHash: trade.transactionHash,
        blockNumber: trade.blockNumber,
        timestamp,
        trader: trade.buyerOrSeller ?? undefined,
        tokenAmount: trade.tokenAmountRaw.toString(),
        quoteAmount: trade.quoteAmountRaw.toString(),
        side: trade.side,
        source: "pons-v2-curve",
      });
      priceObservations.push({ blockNumber: trade.blockNumber, timestamp, priceInQuote: tradePriceInQuote(trade, tokenDecimals, quoteDecimals) });
    });

    const analyzer = new MarketFlowAnalyzer();
    const marketFlow = analyzer.analyze(chainId, curveAddress, swaps, quoteDecimals, now);
    return { marketFlow, swaps, priceObservations, dataQuality: "KNOWN", flowCompleteness: "AVAILABLE_FULL", providerRole, notes };
  }
}
