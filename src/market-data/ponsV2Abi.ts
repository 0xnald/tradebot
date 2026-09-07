// Pons V2 launch factory + bonding curve ABI fragments — just what this
// project reads. Hand-written from the verified source at
// github.com/ponsdotdev/ponsfamily (contractsV2/src/v2/PonsV2LaunchFactory.sol,
// PonsV2BondingCurve.sol, interfaces/ILaunchpadV2.sol) and confirmed live
// on-chain (getLaunchedToken()'s return shape decoded correctly against a
// real launched token) — see docs/DATA_SOURCES.md §7.

export const PONS_V2_FACTORY_ABI = [
  {
    type: "function",
    name: "getLaunchedToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "curve", type: "address" },
          { name: "deployer", type: "address" },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "pairToken", type: "address" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "phase", type: "uint8" },
          { name: "sweptQuote", type: "uint256" },
          { name: "sweptTokens", type: "uint256" },
          { name: "sweptAt", type: "uint256" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const;

export const PONS_V2_CURVE_ABI = [
  {
    type: "event",
    name: "CurveBuy",
    inputs: [
      { name: "buyer", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "quoteIn", type: "uint256", indexed: false },
      { name: "tokensOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "tax", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CurveSell",
    inputs: [
      { name: "seller", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "tokensIn", type: "uint256", indexed: false },
      { name: "quoteOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "tax", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CurveCompleted",
    inputs: [
      { name: "recipient", type: "address", indexed: false },
      { name: "quoteOut", type: "uint256", indexed: false },
      { name: "tokenOut", type: "uint256", indexed: false },
    ],
  },
] as const;

/** `LaunchedToken.phase` — see `ILaunchpadV2.sol`'s `GraduationPhase` enum. Order is load-bearing: it matches the on-chain uint8. */
export const PONS_V2_GRADUATION_PHASES = ["NOT_GRADUATED", "SWEPT", "POOL_CREATED", "RESCUED"] as const;
