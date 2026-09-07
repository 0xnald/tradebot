// Robinhood Chain network configuration.
//
// Defaults below are sourced from Robinhood's own documentation
// (robinhood.com/us/en/support/articles/robinhood-chain-mainnet/ and
// docs.robinhood.com/chain/connecting) and Uniswap's official deployment
// docs (developers.uniswap.org) — see docs/DATA_SOURCES.md for exactly
// what was verified and how. Every value here can be overridden via env
// var for a paid RPC provider or the testnet, per .env.example.

import { defineChain } from "viem";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

const DEFAULT_MAINNET_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const DEFAULT_MAINNET_WS_URL = "wss://feed.mainnet.chain.robinhood.com";

/**
 * Canonical Uniswap V3 contract addresses on Robinhood Chain, per
 * developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments.
 * Uniswap V4 is ALSO deployed on this chain (see `UNISWAP_V4_ADDRESSES`
 * below) — an earlier claim here that it wasn't was wrong, corrected in
 * Phase 6.6; see docs/DATA_SOURCES.md §2.
 */
export const UNISWAP_V3_ADDRESSES = {
  factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  nonfungiblePositionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
  multicall: "0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const;

/** Standard Uniswap V3 fee tiers, in the pool's native units (hundredths of a bip). */
export const UNISWAP_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/**
 * Official Uniswap V4 deployment on Robinhood Chain, per
 * developers.uniswap.org/docs/protocols/v4/deployments — confirmed live
 * (2026-09-05) that PoolManager has real bytecode and emits real
 * Initialize/Swap events for a known graduated Pons V2 pool. See
 * docs/DATA_SOURCES.md §2.
 */
export const UNISWAP_V4_ADDRESSES = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  positionDescriptor: "0x9639443158e8c5efa35bd45287bf2effd3d8dc06",
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
} as const;

/**
 * Pons Family launchpad — verified against docs.ponsfamily.com and
 * github.com/ponsdotdev/ponsfamily, with on-chain bytecode confirmation.
 * See docs/DATA_SOURCES.md §7 for the full verification record, including
 * why the V2 factory address here differs from one supplied by an outside
 * source (that string was not even a valid address).
 */
export const PONS_ADDRESSES = {
  v1Factory: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB",
  v2Factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  /** The singleton Uniswap V4 hook every graduated Pons V2 launch uses — needed to compute a graduated pool's PoolId. */
  v2MemeHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
} as const;

/**
 * Robinhood Chain's own canonical tokens, per
 * docs.robinhood.com/chain/contracts. Used as the "known quote token" list
 * for on-chain pool discovery (see src/market-data/uniswapV3PoolProvider.ts).
 */
export const ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS = {
  WETH: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH" },
  USDG: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG" },
} as const;

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  wsUrl?: string;
}

/**
 * Phase 7.3A §1 — `ROBINHOOD_RPC_HTTP`/`ROBINHOOD_RPC_WS` are the
 * preferred names (matching a production-grade authenticated provider
 * configured for this benchmark) and win when set; `ROBINHOOD_CHAIN_RPC_URL`/
 * `ROBINHOOD_CHAIN_WS_URL` (the original Phase 2 names, still documented
 * in .env.example) remain supported for backward compatibility. Falls
 * back to the documented public default when neither is set.
 */
export function loadChainConfigFromEnv(): ChainConfig {
  return {
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    rpcUrl: process.env.ROBINHOOD_RPC_HTTP || process.env.ROBINHOOD_CHAIN_RPC_URL || DEFAULT_MAINNET_RPC_URL,
    wsUrl: process.env.ROBINHOOD_RPC_WS || process.env.ROBINHOOD_CHAIN_WS_URL || DEFAULT_MAINNET_WS_URL,
  };
}

/**
 * Phase 7.4 §2 — the PUBLIC LOG RPC role: a second, independently-configured
 * endpoint used only for bounded `eth_getLogs` event-history queries whose
 * range exceeds what the PRIMARY/authenticated provider can serve (see
 * `RpcProviderCapabilities` below and docs/RPC_PERFORMANCE.md for why this
 * exists — the authenticated endpoint's Free-tier plan caps `eth_getLogs`
 * at a flat 10 blocks, confirmed both by direct probing and by the
 * provider's own error text). Defaults to the same documented public
 * endpoint PRIMARY falls back to when unconfigured, since that endpoint has
 * no known range cap and was verified (Phase 7.3B) to serve the corrected
 * ~107,000/~2,974-block windows this project actually needs in the
 * hundreds of milliseconds.
 */
export function loadLogChainConfigFromEnv(): ChainConfig {
  return {
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    rpcUrl: process.env.ROBINHOOD_CHAIN_LOG_RPC_URL || DEFAULT_MAINNET_RPC_URL,
  };
}

/**
 * Phase 7.4 §5 — describes what a provider CAN do, rather than hardcoding
 * "Alchemy always means 10 blocks" into the routing logic itself. The
 * PRIMARY provider's cap is read from `ROBINHOOD_PRIMARY_MAX_GETLOGS_RANGE`
 * (defaulting to 10 — the CURRENT measured Alchemy Free-tier limit, Phase
 * 7.3B) so upgrading the account's plan later only requires raising this
 * env var, never a code change. Setting it to the literal string
 * "unlimited" (case-insensitive) or "0" declares no known cap.
 */
export interface RpcProviderCapabilities {
  /** Maximum `eth_getLogs` block-range (inclusive) this provider is known to accept in one request. `undefined` means no known cap. */
  maxGetLogsBlockRange?: number;
  supportsLargeGetLogs: boolean;
}

const DEFAULT_PRIMARY_MAX_GETLOGS_RANGE = 10;

export function loadPrimaryRpcCapabilities(): RpcProviderCapabilities {
  const raw = process.env.ROBINHOOD_PRIMARY_MAX_GETLOGS_RANGE;
  if (raw === undefined || raw === "") return { maxGetLogsBlockRange: DEFAULT_PRIMARY_MAX_GETLOGS_RANGE, supportsLargeGetLogs: false };
  if (raw.trim().toLowerCase() === "unlimited" || raw.trim() === "0") return { maxGetLogsBlockRange: undefined, supportsLargeGetLogs: true };
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return { maxGetLogsBlockRange: Math.floor(parsed), supportsLargeGetLogs: false };
  return { maxGetLogsBlockRange: DEFAULT_PRIMARY_MAX_GETLOGS_RANGE, supportsLargeGetLogs: false };
}

/** The PUBLIC LOG provider has no known range cap — verified (Phase 7.3B) up to ~2.19M blocks against the documented public endpoint. */
export function logProviderCapabilities(): RpcProviderCapabilities {
  return { maxGetLogsBlockRange: undefined, supportsLargeGetLogs: true };
}

/**
 * Phase 7.3A §1 — a SAFE description of which RPC endpoint is active, for
 * logging. Never returns the configured URL itself (which may embed an
 * API key as a path segment or query parameter) — only whether it's the
 * documented public default or a different, configured endpoint, plus
 * the hostname alone (a hostname is not a secret; a path/query string
 * might be, so those are deliberately never included).
 */
export function describeRpcEndpointSafely(rpcUrl: string): string {
  if (rpcUrl === DEFAULT_MAINNET_RPC_URL) return "public Robinhood RPC (documented default)";
  try {
    const host = new URL(rpcUrl).hostname;
    // Some providers embed a credential as the leftmost subdomain label (e.g. "<key>.provider.com").
    // A long, high-entropy-looking first label is treated as potentially secret and dropped; the
    // remaining, clearly-public domain is still useful for identifying WHICH provider is in use.
    const labels = host.split(".");
    const firstLabelLooksLikeASecret = labels.length > 2 && /^[a-zA-Z0-9_-]{20,}$/.test(labels[0]);
    const safeHost = firstLabelLooksLikeASecret ? `<redacted>.${labels.slice(1).join(".")}` : host;
    return `configured authenticated endpoint (host: ${safeHost})`;
  } catch {
    return "configured authenticated endpoint (unparseable URL — redacted)";
  }
}

export function defineRobinhoodChain(config: ChainConfig) {
  return defineChain({
    id: config.chainId,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: {
        http: [config.rpcUrl],
        ...(config.wsUrl ? { webSocket: [config.wsUrl] } : {}),
      },
    },
    blockExplorers: {
      default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
    },
  });
}
