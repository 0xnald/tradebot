// Orchestrates a chain client + a holder data provider into a normalized
// TokenContractInfo. This is the module boundary other code should use —
// callers shouldn't need to know that name/symbol/decimals/totalSupply/
// deployment info come from the chain directly while holder data comes
// from an indexer; that split is exactly what docs/DATA_SOURCES.md §5
// documents and this service exists to hide.

import { isAddress, type Address } from "viem";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import { getCachedTokenMetadata } from "../shared/tokenMetadataCache.js";
import type { ProviderResult, TokenContractInfo } from "../types/domain.js";
import type { HolderDataProvider } from "./holderDataProvider.js";

export interface TokenAnalysisServiceOptions {
  chainClient: RobinhoodChainClient;
  holderProvider: HolderDataProvider;
}

/** Structural interface so callers (and tests) can supply a fake without constructing a real `TokenAnalysisService`. */
export interface TokenIntelligenceProvider {
  getTokenIntelligence(contractAddress: string): Promise<ProviderResult<TokenContractInfo>>;
  /**
   * Phase 7.1 §8/§9: chain metadata ONLY — 4 batched, parallel ERC-20
   * reads (name/symbol/decimals/totalSupply). Consistently fast (a single
   * RPC round-trip batch), because it needs no search over chain history.
   * Callers on a tight live-decision budget should call this instead of
   * `getTokenIntelligence` and treat deployment/holder fields as a
   * separate, optional, slower enrichment (see `getSlowTokenInfo`).
   */
  getFastTokenInfo(contractAddress: string): Promise<ProviderResult<TokenContractInfo>>;
  /**
   * Phase 7.1 §8/§9: the slow half — deployment info (binary-searches
   * `eth_getCode` across chain history to find the deployment block, then
   * fetches that block with its transactions and scans for the matching
   * creation receipt — O(log(current block height)) sequential RPC round
   * trips, confirmed via investigation to be the actual timeout cause
   * observed in Phase 7's live verification, not a bug in the search
   * itself) and holder distribution (Blockscout — separately documented
   * as unreliable/bot-gated in docs/DATA_SOURCES.md). Both run
   * concurrently with each other here; callers must bound this with their
   * own timeout and must NOT let it block a live decision — see
   * docs/LIVE_INTELLIGENCE.md.
   */
  getSlowTokenInfo(contractAddress: string): Promise<Pick<TokenContractInfo, "deployedAt" | "deploymentBlock" | "deployerAddress" | "holderCount" | "topHolderConcentrationPct">>;
}

const FAST_FIELDS = ["name", "symbol", "decimals", "totalSupplyRaw"];
const ALL_FIELDS = [...FAST_FIELDS, "deployedAt", "deploymentBlock", "deployerAddress", "holderCount", "topHolderConcentrationPct"];

export class TokenAnalysisService implements TokenIntelligenceProvider {
  #chainClient: RobinhoodChainClient;
  #holderProvider: HolderDataProvider;

  constructor(options: TokenAnalysisServiceOptions) {
    this.#chainClient = options.chainClient;
    this.#holderProvider = options.holderProvider;
  }

  /**
   * Phase 7.1 §8/§9: a single batched `Promise.all` of 4 ERC-20 reads —
   * one RPC round-trip's worth of latency (confirmed via
   * getTokenMetadata's existing implementation, unchanged here), never
   * dependent on chain-history search. Safe to call on every live signal
   * with a short timeout.
   */
  async getFastTokenInfo(contractAddress: string): Promise<ProviderResult<TokenContractInfo>> {
    if (!isAddress(contractAddress)) {
      return {
        status: "error",
        data: null,
        unavailable: FAST_FIELDS,
        errors: [{ message: `invalid contract address: ${contractAddress}` }],
      };
    }

    const address = contractAddress as Address;
    // Phase 7.3 §7/§8 — routes through the SAME shared, time-independent cache
    // `resolveMarketContextOnce` already uses for decimals lookups. Before this fix, the live
    // gatherer's concurrent fan-out fetched the SAME token's metadata TWICE for every signal (once
    // here, once in resolveMarketContextOnce) — a real, measured duplicate RPC round trip eliminated
    // by sharing one cache instead of each caller fetching independently.
    const metadata = await getCachedTokenMetadata(this.#chainClient, address);
    const unavailable: string[] = [];
    if (metadata.name === null) unavailable.push("name");
    if (metadata.symbol === null) unavailable.push("symbol");
    if (metadata.decimals === null) unavailable.push("decimals");
    if (metadata.totalSupplyRaw === null) unavailable.push("totalSupplyRaw");

    const data: TokenContractInfo = {
      chainId: this.#chainClient.chainId,
      contractAddress,
      name: metadata.name ?? undefined,
      symbol: metadata.symbol ?? undefined,
      decimals: metadata.decimals ?? undefined,
      totalSupplyRaw: metadata.totalSupplyRaw ?? undefined,
    };

    const allUnavailable = unavailable.length >= FAST_FIELDS.length;
    return {
      status: allUnavailable ? "unavailable" : unavailable.length > 0 ? "partial" : "ok",
      data: allUnavailable ? null : data,
      unavailable,
      errors: [],
    };
  }

  /**
   * Phase 7.1 §8/§9: the slow half, isolated so a caller can bound it with
   * its own (larger, still-bounded) timeout and never let it block a live
   * decision. Deployment-info lookup (`getContractCreationInfo`) and
   * holder-distribution lookup (Blockscout) are independent data sources —
   * neither actually depends on the other's result in the fields
   * `TokenContractInfo` surfaces (holder distribution's optional
   * deployer-address hint only annotates an internal `deployerHolding`
   * field that isn't part of `TokenContractInfo` — see
   * blockscoutHolderDataProvider.ts) — so they run concurrently here
   * rather than sequentially, which was the actual timeout root cause:
   * see docs/LIVE_INTELLIGENCE.md's TokenAnalysisService latency
   * investigation. Deployment-info's own latency is inherent to the
   * public (non-archive) RPC's binary-search-based deployment-block
   * finder — genuinely slow, not a bug — so this method's contract is
   * "best effort within your timeout," never "fast."
   */
  async getSlowTokenInfo(
    contractAddress: string,
  ): Promise<Pick<TokenContractInfo, "deployedAt" | "deploymentBlock" | "deployerAddress" | "holderCount" | "topHolderConcentrationPct">> {
    if (!isAddress(contractAddress)) return {};
    const address = contractAddress as Address;

    const [deploymentSettled, holderSettled] = await Promise.allSettled([
      this.#chainClient.getContractCreationInfo(address),
      this.#holderProvider.getHolderDistribution(this.#chainClient.chainId, contractAddress, {}),
    ]);

    const result: Pick<TokenContractInfo, "deployedAt" | "deploymentBlock" | "deployerAddress" | "holderCount" | "topHolderConcentrationPct"> = {};

    if (deploymentSettled.status === "fulfilled" && deploymentSettled.value) {
      result.deploymentBlock = deploymentSettled.value.deploymentBlock;
      result.deployedAt = deploymentSettled.value.deploymentTimestamp;
      result.deployerAddress = deploymentSettled.value.deployerAddress ?? undefined;
    }

    if (holderSettled.status === "fulfilled" && (holderSettled.value.status === "ok" || holderSettled.value.status === "partial")) {
      result.holderCount = holderSettled.value.data?.totalHolders ?? undefined;
      result.topHolderConcentrationPct = holderSettled.value.data?.topHolderConcentrationPct ?? undefined;
    }

    return result;
  }

  /**
   * The original, pre-Phase-7.1 one-shot method — preserved with its
   * exact prior output shape/semantics (including passing the resolved
   * deployerAddress into the holder lookup as a hint) for callers not on
   * a tight live-decision latency budget. Runs fast-metadata and
   * deployment-info concurrently (an easy, safe latency win — they're
   * independent), but keeps holder-distribution sequenced after
   * deployment-info like before, since this method's contract is "wait
   * for everything," not "bounded." The live path
   * (src/live/liveIntelligenceGatherer.ts) does NOT call this — it calls
   * `getFastTokenInfo` and `getSlowTokenInfo` directly with independent
   * timeouts (see `getSlowTokenInfo`'s doc comment for why running
   * deployment+holder concurrently there is safe), so a slow lookup can
   * never block the fast metadata a live decision needs.
   */
  async getTokenIntelligence(contractAddress: string): Promise<ProviderResult<TokenContractInfo>> {
    if (!isAddress(contractAddress)) {
      return {
        status: "error",
        data: null,
        unavailable: ALL_FIELDS,
        errors: [{ message: `invalid contract address: ${contractAddress}` }],
      };
    }

    const errors: { message: string; provider?: string }[] = [];
    const unavailable: string[] = [];

    const [fastResult, slowSettled] = await Promise.all([
      this.getFastTokenInfo(contractAddress),
      this.#chainClient
        .getContractCreationInfo(contractAddress as Address)
        .then((creationInfo) => ({ status: "fulfilled" as const, creationInfo }))
        .catch((error: unknown) => ({ status: "rejected" as const, error })),
    ]);

    unavailable.push(...fastResult.unavailable);
    errors.push(...fastResult.errors);

    let deploymentBlock: number | undefined;
    let deployedAt: string | undefined;
    let deployerAddress: string | undefined;
    if (slowSettled.status === "fulfilled") {
      if (slowSettled.creationInfo) {
        deploymentBlock = slowSettled.creationInfo.deploymentBlock;
        deployedAt = slowSettled.creationInfo.deploymentTimestamp;
        deployerAddress = slowSettled.creationInfo.deployerAddress ?? undefined;
        if (!slowSettled.creationInfo.deployerAddress) unavailable.push("deployerAddress");
      } else {
        unavailable.push("deploymentBlock", "deployedAt", "deployerAddress");
      }
    } else {
      errors.push({
        message: `deployment lookup failed: ${slowSettled.error instanceof Error ? slowSettled.error.message : String(slowSettled.error)}`,
        provider: "robinhood-chain-client",
      });
      unavailable.push("deploymentBlock", "deployedAt", "deployerAddress");
    }

    const holderResult = await this.#holderProvider.getHolderDistribution(this.#chainClient.chainId, contractAddress, {
      deployerAddress,
    });
    if (holderResult.status === "error" || holderResult.status === "unavailable") {
      unavailable.push("holderCount", "topHolderConcentrationPct");
      errors.push(...holderResult.errors);
    } else {
      if (holderResult.data?.totalHolders == null) unavailable.push("holderCount");
      if (holderResult.data?.topHolderConcentrationPct == null) unavailable.push("topHolderConcentrationPct");
      errors.push(...holderResult.errors);
    }

    const data: TokenContractInfo = {
      chainId: this.#chainClient.chainId,
      contractAddress,
      name: fastResult.data?.name,
      symbol: fastResult.data?.symbol,
      decimals: fastResult.data?.decimals,
      totalSupplyRaw: fastResult.data?.totalSupplyRaw,
      deployedAt,
      deploymentBlock,
      deployerAddress,
      holderCount: holderResult.data?.totalHolders ?? undefined,
      topHolderConcentrationPct: holderResult.data?.topHolderConcentrationPct ?? undefined,
    };

    const allUnavailable = unavailable.length >= ALL_FIELDS.length;
    return {
      status: allUnavailable ? "unavailable" : unavailable.length > 0 || errors.length > 0 ? "partial" : "ok",
      data: allUnavailable ? null : data,
      unavailable,
      errors,
    };
  }
}
