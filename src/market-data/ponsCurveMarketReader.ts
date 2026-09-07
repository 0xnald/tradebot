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

import { fetchLogsWithAdaptiveChunking } from "../blockchain/logRangeChunking.js";
import { convertToUsd } from "../backtesting/quoteAssetUsdPricing.js";
import { PONS_V2_CURVE_ABI } from "./ponsV2Abi.js";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import type { BlockTimestampResolver } from "../blockchain/blockTimestampResolver.js";
import type { DataQualityState, MarketFlowAnalysis, SwapRecord } from "../types/domain.js";
import { MarketFlowAnalyzer } from "./marketFlowAnalyzer.js";

const MAX_SPLIT_DEPTH = 3;

export interface PonsCurveMarketReaderOptions {
  chainClient: RobinhoodChainClient;
  blockTimestampResolver: BlockTimestampResolver;
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
  notes: string[];
}

/** Fetches CurveBuy+CurveSell once for [fromBlock, toBlock] — shared by price/liquidity-adjacent/flow so no caller pays for the same event scan twice. */
async function fetchCurveTrades(
  chainClient: RobinhoodChainClient,
  curveAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ trades: PonsCurveTrade[]; notes: string[] }> {
  const notes: string[] = [];
  try {
    const [buyLogs, sellLogs] = await Promise.all([
      fetchLogsWithAdaptiveChunking(
        (from, to) => chainClient.getLogs({ address: curveAddress as `0x${string}`, event: PONS_V2_CURVE_ABI[0], fromBlock: from, toBlock: to }),
        fromBlock,
        toBlock,
        MAX_SPLIT_DEPTH,
      ),
      fetchLogsWithAdaptiveChunking(
        (from, to) => chainClient.getLogs({ address: curveAddress as `0x${string}`, event: PONS_V2_CURVE_ABI[1], fromBlock: from, toBlock: to }),
        fromBlock,
        toBlock,
        MAX_SPLIT_DEPTH,
      ),
    ]);

    const trades: PonsCurveTrade[] = [];
    for (const log of buyLogs as any[]) {
      const quoteIn = log.args?.quoteIn as bigint | undefined;
      const tokensOut = log.args?.tokensOut as bigint | undefined;
      if (quoteIn === undefined || tokensOut === undefined || tokensOut <= 0n) continue; // malformed/zero -> excluded, never guessed
      trades.push({ blockNumber: Number(log.blockNumber), transactionHash: log.transactionHash, side: "BUY", quoteAmountRaw: quoteIn, tokenAmountRaw: tokensOut, buyerOrSeller: (log.args?.buyer as string) ?? null });
    }
    for (const log of sellLogs as any[]) {
      const tokensIn = log.args?.tokensIn as bigint | undefined;
      const quoteOut = log.args?.quoteOut as bigint | undefined;
      if (tokensIn === undefined || quoteOut === undefined || tokensIn <= 0n) continue;
      trades.push({ blockNumber: Number(log.blockNumber), transactionHash: log.transactionHash, side: "SELL", quoteAmountRaw: quoteOut, tokenAmountRaw: tokensIn, buyerOrSeller: (log.args?.seller as string) ?? null });
    }
    trades.sort((a, b) => a.blockNumber - b.blockNumber);
    return { trades, notes };
  } catch (error) {
    notes.push(`curve event fetch failed within the requested bounded window: ${error instanceof Error ? error.message : String(error)}`);
    return { trades: [], notes };
  }
}

function tradePriceInQuote(trade: PonsCurveTrade, tokenDecimals: number, quoteDecimals: number): number {
  const tokenAmount = Number(trade.tokenAmountRaw) / 10 ** tokenDecimals;
  const quoteAmount = Number(trade.quoteAmountRaw) / 10 ** quoteDecimals;
  return quoteAmount / tokenAmount;
}

export class PonsCurveMarketReader {
  #chainClient: RobinhoodChainClient;
  #blockTimestampResolver: BlockTimestampResolver;

  constructor(options: PonsCurveMarketReaderOptions) {
    this.#chainClient = options.chainClient;
    this.#blockTimestampResolver = options.blockTimestampResolver;
  }

  /** Current price = the most recent trade's implied price within the bounded window. Never a guess when the window has no trades. */
  async getCurrentPrice(curveAddress: string, quoteTokenAddress: string, tokenDecimals: number, quoteDecimals: number, fromBlock: bigint, toBlock: bigint): Promise<PonsCurvePriceResult> {
    const { trades, notes } = await fetchCurveTrades(this.#chainClient, curveAddress, fromBlock, toBlock);
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
    const { trades, notes } = await fetchCurveTrades(this.#chainClient, curveAddress, fromBlock, toBlock);
    if (trades.length === 0) {
      return { marketFlow: null, swaps: [], priceObservations: [], dataQuality: "UNAVAILABLE", notes: [...notes, "no CurveBuy/CurveSell events found within the bounded window"] };
    }

    const swaps: SwapRecord[] = [];
    const priceObservations: { blockNumber: number; timestamp: string | undefined; priceInQuote: number }[] = [];
    for (const trade of trades) {
      let timestamp: string | undefined;
      try {
        timestamp = await this.#blockTimestampResolver.resolve(BigInt(trade.blockNumber));
      } catch {
        timestamp = undefined; // timestamp genuinely unavailable — the swap record still carries everything else known
      }
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
    }

    const analyzer = new MarketFlowAnalyzer();
    const marketFlow = analyzer.analyze(chainId, curveAddress, swaps, quoteDecimals, now);
    return { marketFlow, swaps, priceObservations, dataQuality: "KNOWN", notes };
  }
}
