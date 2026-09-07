// Minimal Uniswap V4 core ABI fragments — just what this project reads.
// Verified verbatim against the official source
// (github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol),
// not guessed — see docs/DATA_SOURCES.md §2. `id` (the PoolId) is a
// bytes32, NOT an address — a graduated Pons V2 pool has no per-pool
// contract address at all, unlike Uniswap V3.

export const UNISWAP_V4_POOL_MANAGER_ABI = [
  {
    type: "event",
    name: "Initialize",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "currency0", type: "address", indexed: true },
      { name: "currency1", type: "address", indexed: true },
      { name: "fee", type: "uint24", indexed: false },
      { name: "tickSpacing", type: "int24", indexed: false },
      { name: "hooks", type: "address", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "tick", type: "int24", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ModifyLiquidity",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "tickUpper", type: "int24", indexed: false },
      { name: "liquidityDelta", type: "int256", indexed: false },
      { name: "salt", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const UNISWAP_V4_INITIALIZE_EVENT = UNISWAP_V4_POOL_MANAGER_ABI[0];
export const UNISWAP_V4_SWAP_EVENT = UNISWAP_V4_POOL_MANAGER_ABI[1];
export const UNISWAP_V4_MODIFY_LIQUIDITY_EVENT = UNISWAP_V4_POOL_MANAGER_ABI[2];
