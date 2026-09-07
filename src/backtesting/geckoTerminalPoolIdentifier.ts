// GeckoTerminal's pool-address URL parameter transparently accepts either
// a normal 20-byte contract address (a regular DEX pool, or — for Pons V2 —
// the bonding curve contract it indexes as a pool) or a 32-byte Uniswap V4
// PoolId (a graduated Pons V2 launch has no per-pool contract address at
// all). Verified live: a computed V4 PoolId fetched real OHLCV data with
// meta.base/meta.quote matching the expected token — see
// docs/DATA_SOURCES.md §7.

import { isAddress } from "viem";

const V4_POOL_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function isGeckoTerminalPoolIdentifier(value: string): boolean {
  return isAddress(value) || V4_POOL_ID_PATTERN.test(value);
}
