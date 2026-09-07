// Deployer analysis — reuses RobinhoodChainClient's existing balance
// methods (Phase 2) and whatever SwapRecord[] the caller already fetched
// (Phase 2/3) rather than adding new data-fetching logic. Only ever
// reports "deployer address" and "observable on-chain behavior" — never
// attempts to identify the person behind the address or make an ownership
// claim, per the Phase 4 brief.

import { getAddress, isAddress, type Address } from "viem";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import type { DeployerAnalysis, SwapRecord } from "../types/domain.js";

const FULL_HISTORY_UNAVAILABLE_REASON =
  "No verified wallet-centric transaction-history indexer exists yet — see docs/WALLET_DATA_SOURCES.md §2d. Only activity observable in already-fetched swap data for this token's own pools is reported here.";

export interface DeployerAnalyzerOptions {
  chainClient: RobinhoodChainClient;
}

export class DeployerAnalyzer {
  #chainClient: RobinhoodChainClient;

  constructor(options: DeployerAnalyzerOptions) {
    this.#chainClient = options.chainClient;
  }

  /**
   * `observedSwaps` should be whatever this token's pools' swap records the
   * caller already fetched (e.g. via PoolDataProvider.getRecentSwaps) —
   * this method does not fetch anything beyond the deployer's own balances.
   */
  async analyze(
    contractAddress: Address,
    deployerAddress: string | null,
    totalSupplyRaw: string | null,
    observedSwaps: SwapRecord[] = [],
  ): Promise<DeployerAnalysis> {
    const observedAt = new Date().toISOString();
    const base = {
      chainId: this.#chainClient.chainId,
      contractAddress,
      observedAt,
      deployerFullHistoryAvailable: false as const,
      deployerFullHistoryUnavailableReason: FULL_HISTORY_UNAVAILABLE_REASON,
    };

    if (!deployerAddress || !isAddress(deployerAddress)) {
      return {
        ...base,
        deployerAddress: null,
        deployerNativeBalanceRaw: null,
        deployerTokenBalanceRaw: null,
        deployerTokenBalancePctOfSupply: null,
        observedDeployerSwapCount: null,
        dataQuality: "UNAVAILABLE",
        notes: ["deployer address is not known — see the token's TokenContractInfo.deployerAddress"],
      };
    }

    const notes: string[] = [];
    let deployerNativeBalanceRaw: string | null = null;
    let deployerTokenBalanceRaw: string | null = null;

    try {
      deployerNativeBalanceRaw = (await this.#chainClient.getNativeBalance(deployerAddress)).toString();
    } catch (error) {
      notes.push(`native balance lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      deployerTokenBalanceRaw = (
        await this.#chainClient.getTokenBalance(contractAddress, deployerAddress)
      ).toString();
    } catch (error) {
      notes.push(`token balance lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let deployerTokenBalancePctOfSupply: number | null = null;
    if (deployerTokenBalanceRaw !== null && totalSupplyRaw !== null && BigInt(totalSupplyRaw) > 0n) {
      deployerTokenBalancePctOfSupply =
        (Number(BigInt(deployerTokenBalanceRaw)) / Number(BigInt(totalSupplyRaw))) * 100;
    }

    const target = getAddress(deployerAddress);
    const observedDeployerSwapCount = observedSwaps.filter(
      (swap) => swap.trader && getAddress(swap.trader) === target,
    ).length;

    const knownFields = [deployerNativeBalanceRaw, deployerTokenBalanceRaw].filter((v) => v !== null).length;

    return {
      ...base,
      deployerAddress,
      deployerNativeBalanceRaw,
      deployerTokenBalanceRaw,
      deployerTokenBalancePctOfSupply,
      observedDeployerSwapCount,
      dataQuality: knownFields === 2 ? "KNOWN" : knownFields === 0 ? "UNAVAILABLE" : "PARTIAL",
      notes,
    };
  }
}
