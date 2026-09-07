// Phase 7 §8 — simulates a paper entry when Smart Selection produces
// TRADE_CANDIDATE. This NEVER touches a real wallet: no signature request,
// no private key, no transaction. Every "amount" here is a simulated
// number computed from the current price + configured slippage/fees.

import type { PaperPortfolio, PositionRejectionReason } from "./paperPortfolio.js";
import type { CurrentPriceResult } from "./currentPriceResolver.js";
import type { LivePaperPosition, PaperTradeExecution } from "../types/domain.js";

export interface PaperTradingEngineDeps {
  portfolio: PaperPortfolio;
  generatePositionId: () => string;
  now?: () => Date;
}

export interface OpenPaperPositionInput {
  signalId: string;
  contractAddress: string;
  chainId: number;
  tokenSymbol: string | null;
  currentPrice: CurrentPriceResult;
}

export type OpenPaperPositionResult =
  | { status: "OPENED"; position: LivePaperPosition }
  | { status: "REJECTED"; reason: PositionRejectionReason | "PRICE_UNAVAILABLE" };

export function openPaperPosition(input: OpenPaperPositionInput, deps: PaperTradingEngineDeps): OpenPaperPositionResult {
  if (input.currentPrice.priceUsd === null) {
    return { status: "REJECTED", reason: "PRICE_UNAVAILABLE" };
  }

  const sizeUsd = deps.portfolio.computePositionSizeUsd();
  const admission = deps.portfolio.canOpenPosition(sizeUsd);
  if (!admission.allowed) {
    return { status: "REJECTED", reason: admission.reason! };
  }

  deps.portfolio.openPosition(sizeUsd);

  const config = deps.portfolio.config;
  const feesUsd = sizeUsd * (config.feePct / 100);
  // Slippage makes the effective entry price worse (higher) than the observed price — the honest cost of actually executing a buy.
  const effectiveEntryPriceUsd = input.currentPrice.priceUsd * (1 + config.slippagePct / 100);
  const tokenAmount = (sizeUsd - feesUsd) / effectiveEntryPriceUsd;
  const positionId = deps.generatePositionId();
  const entryTimestamp = (deps.now?.() ?? new Date()).toISOString();

  const execution: PaperTradeExecution = {
    positionId,
    signalId: input.signalId,
    contractAddress: input.contractAddress,
    chainId: input.chainId,
    entryTimestamp,
    entryPriceUsd: input.currentPrice.priceUsd,
    entryPriceSource: input.currentPrice.source ?? "unknown",
    entryDataQuality: input.currentPrice.dataQuality,
    positionSizeUsd: sizeUsd,
    slippagePct: config.slippagePct,
    feePct: config.feePct,
    feesUsd,
    tokenAmount,
    quoteAmountUsd: sizeUsd,
  };

  const position: LivePaperPosition = {
    id: positionId,
    signalId: input.signalId,
    contractAddress: input.contractAddress,
    chainId: input.chainId,
    tokenSymbol: input.tokenSymbol,
    execution,
    status: "OPEN",
    takeProfitPct: config.takeProfitPct,
    stopLossPct: config.stopLossPct,
    maxHoldingMinutes: config.maxHoldingMinutes,
    latestSnapshot: null,
    closedAt: null,
    exitPriceUsd: null,
    exitReason: null,
    realizedPnlUsd: null,
    realizedReturnPct: null,
  };

  return { status: "OPENED", position };
}
