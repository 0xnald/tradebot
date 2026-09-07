// Builds the market-state snapshot captured at the moment a Scout signal
// is processed — pure composition over already-fetched provider results,
// no fetching of its own (reuse, not duplication). Never mutates the
// original ScoutSignal; a snapshot is its own separate, appended record
// (see src/storage/signalMarketSnapshotRepository.ts).

import { buildDataQualitySummary } from "../shared/dataQuality.js";
import type {
  DataQualityField,
  HolderDistribution,
  MarketFlowAnalysis,
  ProviderResult,
  SignalMarketSnapshot,
  TokenAge,
  TokenMarketData,
} from "../types/domain.js";

export interface BuildSignalMarketSnapshotInputs {
  signalId: string;
  chainId: number;
  contractAddress: string;
  marketData: ProviderResult<TokenMarketData>;
  holderInfo: ProviderResult<HolderDistribution>;
  tokenAge: TokenAge | null;
  recentFlow: MarketFlowAnalysis | null;
}

export function buildSignalMarketSnapshot(inputs: BuildSignalMarketSnapshotInputs, now: Date = new Date()): SignalMarketSnapshot {
  const capturedAt = now.toISOString();
  const market = inputs.marketData.data;
  const holders = inputs.holderInfo.data;

  const fields: DataQualityField[] = [
    { field: "priceUsd", state: market?.priceUsd != null ? "KNOWN" : "UNAVAILABLE" },
    { field: "liquidityUsd", state: market?.liquidityUsd != null ? "KNOWN" : "UNAVAILABLE" },
    { field: "volumeUsd24h", state: market?.volumeUsd24h != null ? "KNOWN" : "UNAVAILABLE" },
    {
      field: "marketCapUsd",
      state: market?.marketCapUsd != null ? "KNOWN" : "UNAVAILABLE",
      reason: market?.marketCapUnavailableReason,
    },
    { field: "tokenAge", state: inputs.tokenAge?.ageSeconds != null ? "KNOWN" : "UNKNOWN" },
    {
      field: "holderInfo",
      state: holders?.totalHolders != null ? "KNOWN" : "UNAVAILABLE",
      reason: holders?.unavailableReason,
    },
    { field: "recentFlow", state: inputs.recentFlow ? "KNOWN" : "UNAVAILABLE" },
  ];

  return {
    signalId: inputs.signalId,
    chainId: inputs.chainId,
    contractAddress: inputs.contractAddress,
    capturedAt,
    priceUsd: market?.priceUsd ?? null,
    liquidityUsd: market?.liquidityUsd ?? null,
    volumeUsd24h: market?.volumeUsd24h ?? null,
    marketCapUsd: market?.marketCapUsd ?? null,
    pools: market?.pools ?? [],
    recentFlow: inputs.recentFlow,
    tokenAge: inputs.tokenAge,
    holderInfo: holders,
    dataQuality: buildDataQualitySummary(fields, now),
  };
}
