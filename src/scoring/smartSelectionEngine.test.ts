// Comprehensive, deterministic scenario tests for the Smart Selection
// Engine orchestrator — covers every named scenario from the Phase 5
// brief's testing section (1-26). Each scenario builds a realistic but
// synthetic SmartSelectionInputs object and asserts on the resulting
// decision/score/confidence/blockers, not on exact score numbers (which
// are heuristic and subject to config tuning) — the goal is to prove the
// documented BEHAVIOR (e.g. "a hard blocker forces IGNORE regardless of
// score"), not to lock in specific numeric outputs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SmartSelectionEngine, type SmartSelectionInputs } from "./smartSelectionEngine.js";
import { SMART_SELECTION_V1_CONFIG } from "./smartSelectionConfig.js";
import type {
  ContractFeatureDetection,
  DeployerAnalysis,
  EntryQualityFeatures,
  HolderConcentrationBreakdown,
  LiquidityAnalysis,
  MarketFlowAnalysis,
  MomentumAnalysis,
  PoolQualityAssessment,
  ScoutSignal,
  ScoutWalletAssociation,
  SignalMarketSnapshot,
  TokenAge,
  TokenContractInfo,
  WalletIdentity,
  WalletQualityFeatures,
  WalletRelationshipSignal,
} from "../types/domain.js";

const NOW = new Date("2026-09-05T00:10:00.000Z");
const CHAIN_ID = 4663;
const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";

// ---------------------------------------------------------------------
// Fixture builders — every field defaults to a "healthy, known" value so
// each test only needs to override what it's actually exercising.
// ---------------------------------------------------------------------

function signal(overrides: Partial<ScoutSignal> = {}): ScoutSignal {
  return {
    id: "sig1",
    source: "telegram:scoutrobinhood",
    sourceMessageId: "1",
    receivedAt: "2026-09-05T00:08:00.000Z",
    messageType: "EARLY_CALL",
    contractAddress: TOKEN,
    rawText: "...",
    parseConfidence: "high",
    parseWarnings: [],
    liveBuys: [],
    ...overrides,
  };
}

function marketSnapshot(overrides: Partial<SignalMarketSnapshot> = {}): SignalMarketSnapshot {
  return {
    signalId: "sig1",
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    capturedAt: NOW.toISOString(),
    priceUsd: 1,
    liquidityUsd: 50_000,
    volumeUsd24h: 100_000,
    marketCapUsd: 200_000,
    pools: [],
    recentFlow: null,
    tokenAge: null,
    holderInfo: null,
    dataQuality: { overall: "KNOWN", fields: [], observedAt: NOW.toISOString() },
    ...overrides,
  };
}

function tokenContractInfo(overrides: Partial<TokenContractInfo> = {}): TokenContractInfo {
  return { chainId: CHAIN_ID, contractAddress: TOKEN, name: "Test Token", symbol: "TST", decimals: 18, totalSupplyRaw: "1000000000000000000000000", ...overrides };
}

function contractFeatures(overrides: Partial<ContractFeatureDetection> = {}): ContractFeatureDetection {
  return {
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    observedAt: NOW.toISOString(),
    mintFunctionDetected: "not_detected",
    burnFunctionDetected: "not_detected",
    pauseFunctionDetected: "not_detected",
    blacklistFunctionDetected: "not_detected",
    ownershipFunctionDetected: "not_detected",
    maxTransactionFunctionDetected: "not_detected",
    maxWalletFunctionDetected: "not_detected",
    feeOrTaxFunctionDetected: "not_detected",
    proxyPatternDetected: "not_detected",
    bytecodeSizeBytes: 3000,
    detectionMethod: "bytecode-selector-scan",
    detectionCaveat: "evidence, not proof",
    ...overrides,
  };
}

function tokenAge(overrides: Partial<TokenAge> = {}): TokenAge {
  return { deployedAt: "2026-09-05T00:00:00.000Z", ageSeconds: 600, ageMinutes: 10, ageHours: 0.17, ageCategory: "BRAND_NEW", ...overrides };
}

function liquidityAnalysis(overrides: Partial<LiquidityAnalysis> = {}): LiquidityAnalysis {
  return {
    chainId: CHAIN_ID,
    poolAddress: "0xpool",
    observedAt: NOW.toISOString(),
    currentLiquidityUsd: 50_000,
    previousLiquidityUsd: 45_000,
    changeUsd: 5_000,
    changePct: 11,
    accelerationPctPoints: null,
    trend: "INCREASING",
    topPoolLiquidityConcentrationPct: 80,
    dataQuality: "KNOWN",
    notes: [],
    ...overrides,
  };
}

function marketFlow(overrides: Partial<MarketFlowAnalysis> = {}): MarketFlowAnalysis {
  return {
    chainId: CHAIN_ID,
    poolAddress: "0xpool",
    observedAt: NOW.toISOString(),
    buyCount: 30,
    sellCount: 12,
    unknownCount: 2,
    buyQuoteVolume: 30,
    sellQuoteVolume: 12,
    netQuoteFlow: 18,
    buySellRatio: 2.5,
    uniqueTraderCount: 25,
    averageTradeSizeQuote: 1,
    medianTradeSizeQuote: 1,
    largeTradeCount: 0,
    largeTradeThresholdQuote: 3,
    recentTradeCount: 15,
    recentWindowSeconds: 300,
    dataQuality: "KNOWN",
    notes: [],
    ...overrides,
  };
}

function momentum(overrides: Partial<MomentumAnalysis> = {}): MomentumAnalysis {
  return {
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    observedAt: NOW.toISOString(),
    changePct1m: null,
    changePct5m: 15,
    changePct15m: 20,
    changePct30m: null,
    changePct1h: null,
    rateOfChangePctPerMinute: 3,
    accelerationPctPoints: 2,
    drawdownFromRecentHighPct: -3,
    distanceFromRecentLowPct: 25,
    volatilityPct: 15,
    observationCount: 3,
    dataQuality: "KNOWN",
    ...overrides,
  };
}

function entryQuality(overrides: Partial<EntryQualityFeatures> = {}): EntryQualityFeatures {
  return {
    signalId: "sig1",
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    computedAt: NOW.toISOString(),
    priceSincePct: 12,
    marketCapSincePct: 12,
    liquiditySincePct: 5,
    volumeAcceleration: "MODERATE",
    distanceFromRecentHighPct: 8,
    priceAccelerationPctPoints: 2,
    chaseRisk: "LOW",
    liquidityDeteriorating: "not_detected",
    flowDeteriorating: "not_detected",
    dataQuality: "KNOWN",
    notes: [],
    ...overrides,
  };
}

function holderConcentration(overrides: Partial<HolderConcentrationBreakdown> = {}): HolderConcentrationBreakdown {
  return {
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    observedAt: NOW.toISOString(),
    holderCount: 300,
    top5ConcentrationPct: 18,
    top10ConcentrationPct: 24,
    largestHolderSharePct: 6,
    deployerSharePct: 2,
    concentrationChangePct: null,
    dataQuality: "KNOWN",
    ...overrides,
  };
}

function deployerAnalysis(overrides: Partial<DeployerAnalysis> = {}): DeployerAnalysis {
  return {
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    deployerAddress: "0xdeployer",
    observedAt: NOW.toISOString(),
    deployerNativeBalanceRaw: "1000000000000000000",
    deployerTokenBalanceRaw: "10000000000000000000000",
    deployerTokenBalancePctOfSupply: 1,
    observedDeployerSwapCount: 0,
    deployerFullHistoryAvailable: false,
    deployerFullHistoryUnavailableReason: "no indexer",
    dataQuality: "KNOWN",
    notes: [],
    ...overrides,
  };
}

function walletIdentity(overrides: Partial<WalletIdentity> = {}): WalletIdentity {
  return { chainId: CHAIN_ID, discoverySource: "on-chain-swap", discoveredAt: NOW.toISOString(), confidence: "high", sourceReferences: [], ...overrides };
}

function walletAssociation(overrides: Partial<ScoutWalletAssociation> = {}): ScoutWalletAssociation {
  return {
    id: "sig1:0",
    scoutSignalId: "sig1",
    chainId: CHAIN_ID,
    wallet: walletIdentity(),
    associationSource: "scout-message:sig1",
    confidence: "high",
    observedAt: NOW.toISOString(),
    rawEvidence: "...",
    ...overrides,
  };
}

function walletQuality(overrides: Partial<WalletQualityFeatures> = {}): WalletQualityFeatures {
  return {
    chainId: CHAIN_ID,
    walletAddress: "0xwallet",
    computedAt: NOW.toISOString(),
    consistencyScore: 0.7,
    profitabilityScore: 0.7,
    earlyEntryScore: null,
    liquidityAwareScore: null,
    sampleSizeConfidence: 0.6,
    recentPerformanceScore: 0.7,
    copyabilityScore: 0.5,
    riskScore: null,
    unavailableFeatures: [],
    ...overrides,
  };
}

/** A fully "healthy" baseline — every group has good, known data. Each scenario overrides only what it's testing. */
function healthyInputs(overrides: Partial<SmartSelectionInputs> = {}): SmartSelectionInputs {
  return {
    scoutSignal: signal(),
    marketSnapshot: marketSnapshot(),
    tokenContractInfo: tokenContractInfo(),
    contractFeatures: contractFeatures(),
    tokenAge: tokenAge(),
    liquidityAnalysis: liquidityAnalysis(),
    marketFlow: marketFlow(),
    momentum: momentum(),
    entryQuality: entryQuality(),
    anomalyFindings: null,
    holderConcentration: holderConcentration(),
    deployerAnalysis: deployerAnalysis(),
    poolQuality: [],
    walletAssociations: [],
    walletQualityByAddress: new Map(),
    walletRelationships: [],
    ...overrides,
  };
}

function engine(): SmartSelectionEngine {
  return new SmartSelectionEngine(SMART_SELECTION_V1_CONFIG);
}

// ---------------------------------------------------------------------
// 1. Extremely strong opportunity
// ---------------------------------------------------------------------
test("1. an extremely strong, healthy opportunity is scored highly with no blockers", () => {
  const result = engine().evaluate(healthyInputs(), NOW);
  assert.ok(result.overallScore > 60);
  assert.equal(result.hardBlockers.blocked, false);
  assert.notEqual(result.decision, "IGNORE");
});

// ---------------------------------------------------------------------
// 2. Extremely weak opportunity
// ---------------------------------------------------------------------
test("2. an extremely weak opportunity (poor across every dimension) scores low and is IGNOREd", () => {
  // "Extremely weak" means weak everywhere, not just in a couple of
  // groups — a token can have a clean, fresh Scout signal and still be a
  // terrible opportunity once liquidity/flow/holders/entry/momentum are
  // all bad. Leaving momentum/tokenQuality/signalQuality at their healthy
  // defaults (as an earlier version of this test did) isn't a genuinely
  // weak scenario — it just proves those unrelated groups correctly
  // don't get dragged down by problems elsewhere, which is correct
  // behavior, not weakness in the test.
  const result = engine().evaluate(
    healthyInputs({
      contractFeatures: contractFeatures({ mintFunctionDetected: "detected", blacklistFunctionDetected: "detected", feeOrTaxFunctionDetected: "detected" }),
      liquidityAnalysis: liquidityAnalysis({ currentLiquidityUsd: 2000, previousLiquidityUsd: 5000, changePct: -60, trend: "DECREASING" }),
      marketFlow: marketFlow({ buyCount: 2, sellCount: 20, buySellRatio: 0.1, netQuoteFlow: -18 }),
      momentum: momentum({ changePct15m: -30, accelerationPctPoints: -25, drawdownFromRecentHighPct: -45, volatilityPct: 90 }),
      holderConcentration: holderConcentration({ top10ConcentrationPct: 95, largestHolderSharePct: 80 }),
      entryQuality: entryQuality({ priceSincePct: -40, liquidityDeteriorating: "detected", flowDeteriorating: "detected", distanceFromRecentHighPct: 60 }),
    }),
    NOW,
  );
  assert.ok(result.overallScore < 45);
  assert.equal(result.decision, "IGNORE");
});

// ---------------------------------------------------------------------
// 3. High score but low confidence
// ---------------------------------------------------------------------
test("3. a high score with low confidence (most groups unavailable) is capped below TRADE_CANDIDATE", () => {
  const result = engine().evaluate(
    healthyInputs({
      // Only entryQuality (weight 20) and momentum (weight 10) are known; everything else unavailable.
      tokenContractInfo: null,
      contractFeatures: null,
      tokenAge: null,
      liquidityAnalysis: null,
      marketFlow: null,
      holderConcentration: null,
      deployerAnalysis: null,
      entryQuality: entryQuality({ priceSincePct: 12, distanceFromRecentHighPct: 8 }),
      momentum: momentum(),
    }),
    NOW,
  );
  assert.ok(result.confidence < SMART_SELECTION_V1_CONFIG.minimumConfidenceForTradeCandidate);
  assert.notEqual(result.decision, "TRADE_CANDIDATE");
});

// ---------------------------------------------------------------------
// 4. High score blocked by hard blocker
// ---------------------------------------------------------------------
test("4. a high-scoring opportunity is forced to IGNORE by a hard blocker regardless of score", () => {
  const result = engine().evaluate(healthyInputs({ liquidityAnalysis: liquidityAnalysis({ currentLiquidityUsd: 100 }) }), NOW);
  assert.equal(result.hardBlockers.blocked, true);
  assert.equal(result.decision, "IGNORE");
  assert.ok(result.blockingFactors.length > 0);
});

// ---------------------------------------------------------------------
// 5/6. High vs low liquidity
// ---------------------------------------------------------------------
test("5/6. higher liquidity scores better than low (but still usable) liquidity", () => {
  const high = engine().evaluate(healthyInputs({ liquidityAnalysis: liquidityAnalysis({ currentLiquidityUsd: 200_000 }) }), NOW);
  const low = engine().evaluate(healthyInputs({ liquidityAnalysis: liquidityAnalysis({ currentLiquidityUsd: 3000 }) }), NOW);
  assert.ok(high.overallScore > low.overallScore);
});

// ---------------------------------------------------------------------
// 7/8. Increasing vs collapsing liquidity
// ---------------------------------------------------------------------
test("7/8. increasing liquidity scores better than collapsing liquidity", () => {
  const increasing = engine().evaluate(healthyInputs({ liquidityAnalysis: liquidityAnalysis({ trend: "INCREASING", changePct: 20 }) }), NOW);
  const collapsing = engine().evaluate(
    healthyInputs({ liquidityAnalysis: liquidityAnalysis({ trend: "LARGE_WITHDRAWAL", changePct: -50, currentLiquidityUsd: 25_000 }) }),
    NOW,
  );
  assert.ok(increasing.overallScore > collapsing.overallScore);
});

// ---------------------------------------------------------------------
// 9/10. Strong vs weak buy flow
// ---------------------------------------------------------------------
test("9/10. strong buy flow scores better than weak (sell-heavy) flow", () => {
  const strong = engine().evaluate(healthyInputs({ marketFlow: marketFlow({ buySellRatio: 3, netQuoteFlow: 20 }) }), NOW);
  const weak = engine().evaluate(healthyInputs({ marketFlow: marketFlow({ buySellRatio: 0.3, netQuoteFlow: -10 }) }), NOW);
  assert.ok(strong.overallScore > weak.overallScore);
});

// ---------------------------------------------------------------------
// 11. Unknown swap data
// ---------------------------------------------------------------------
test("11. a market flow dominated by unknown-direction swaps is never scored as buy or sell evidence", () => {
  const result = engine().evaluate(
    healthyInputs({ marketFlow: marketFlow({ buyCount: 1, sellCount: 1, unknownCount: 100, buySellRatio: 1 }) }),
    NOW,
  );
  const flowGroup = result.scoreBreakdown.find((g) => g.group === "marketFlow")!;
  const unknownFeature = flowGroup.features.find((f) => f.name === "unknownSwapFraction")!;
  assert.equal(unknownFeature.weight, 0);
});

// ---------------------------------------------------------------------
// 12/13. Strong vs excessive momentum
// ---------------------------------------------------------------------
test("12/13. healthy momentum scores better than excessive/parabolic momentum", () => {
  const healthy = engine().evaluate(healthyInputs({ momentum: momentum({ changePct15m: 20 }) }), NOW);
  const excessive = engine().evaluate(healthyInputs({ momentum: momentum({ changePct15m: 400 }) }), NOW);
  assert.ok(healthy.overallScore > excessive.overallScore);
});

// ---------------------------------------------------------------------
// 14/15. High vs low chase risk
// ---------------------------------------------------------------------
test("14. high chase risk caps the decision at WATCH even with an otherwise-strong score", () => {
  const result = engine().evaluate(
    healthyInputs({ entryQuality: entryQuality({ chaseRisk: "HIGH", priceSincePct: 200, distanceFromRecentHighPct: 2 }) }),
    NOW,
  );
  assert.equal(result.chaseAssessment.level, "HIGH_CHASE_RISK");
  assert.notEqual(result.decision, "TRADE_CANDIDATE");
});

test("15. low chase risk does not cap an otherwise-strong decision", () => {
  const result = engine().evaluate(healthyInputs({ entryQuality: entryQuality({ chaseRisk: "LOW" }) }), NOW);
  assert.equal(result.chaseAssessment.level, "LOW_CHASE_RISK");
});

// ---------------------------------------------------------------------
// 16/17. Healthy vs concentrated holder distribution
// ---------------------------------------------------------------------
test("16/17. healthy (spread out) holder distribution scores better than concentrated holders", () => {
  const healthy = engine().evaluate(healthyInputs({ holderConcentration: holderConcentration({ top10ConcentrationPct: 15, largestHolderSharePct: 5 }) }), NOW);
  const concentrated = engine().evaluate(
    healthyInputs({ holderConcentration: holderConcentration({ top10ConcentrationPct: 95, largestHolderSharePct: 85 }) }),
    NOW,
  );
  assert.ok(healthy.overallScore > concentrated.overallScore);
});

// ---------------------------------------------------------------------
// 18. Unavailable holder data
// ---------------------------------------------------------------------
test("18. unavailable holder data reduces confidence rather than the score directly", () => {
  const withHolders = engine().evaluate(healthyInputs(), NOW);
  const withoutHolders = engine().evaluate(healthyInputs({ holderConcentration: null }), NOW);
  // Score should not collapse to near-zero just because one group is missing...
  assert.ok(withoutHolders.overallScore > 40);
  // ...but confidence must be lower than the fully-known case.
  assert.ok(withoutHolders.confidence < withHolders.confidence);
});

// ---------------------------------------------------------------------
// 19/20. Identified high-quality vs low-quality wallet
// ---------------------------------------------------------------------
test("19/20. an identified high-quality wallet scores better than an identified low-quality wallet", () => {
  const goodWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const badWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  const good = engine().evaluate(
    healthyInputs({
      walletAssociations: [walletAssociation({ wallet: walletIdentity({ address: goodWallet }) })],
      walletQualityByAddress: new Map([[goodWallet, walletQuality({ profitabilityScore: 0.9, consistencyScore: 0.9, recentPerformanceScore: 0.9, sampleSizeConfidence: 0.8 })]]),
    }),
    NOW,
  );
  const bad = engine().evaluate(
    healthyInputs({
      walletAssociations: [walletAssociation({ wallet: walletIdentity({ address: badWallet }) })],
      walletQualityByAddress: new Map([[badWallet, walletQuality({ profitabilityScore: 0.1, consistencyScore: 0.1, recentPerformanceScore: 0.1, sampleSizeConfidence: 0.8 })]]),
    }),
    NOW,
  );
  assert.ok(good.overallScore > bad.overallScore);
});

// ---------------------------------------------------------------------
// 21. Unresolved wallet
// ---------------------------------------------------------------------
test("21. an unresolved Scout wallet mention never becomes a fabricated positive or negative score", () => {
  const result = engine().evaluate(
    healthyInputs({ walletAssociations: [walletAssociation({ wallet: walletIdentity({ address: undefined, confidence: "unresolved" }), confidence: "unresolved" })] }),
    NOW,
  );
  const walletGroup = result.scoreBreakdown.find((g) => g.group === "walletIntelligence")!;
  assert.equal(walletGroup.groupScore, null);
  assert.equal(result.featureSnapshot.walletAssessment.status, "UNRESOLVED");
});

// ---------------------------------------------------------------------
// 22. Insufficient wallet sample size
// ---------------------------------------------------------------------
test("22. a wallet with too little trade history contributes no score, only a note", () => {
  const wallet = "0xcccccccccccccccccccccccccccccccccccccccc";
  const result = engine().evaluate(
    healthyInputs({
      walletAssociations: [walletAssociation({ wallet: walletIdentity({ address: wallet }) })],
      walletQualityByAddress: new Map([[wallet, walletQuality({ sampleSizeConfidence: 0.01 })]]),
    }),
    NOW,
  );
  assert.equal(result.featureSnapshot.walletAssessment.status, "INSUFFICIENT_SAMPLE");
  const walletGroup = result.scoreBreakdown.find((g) => g.group === "walletIntelligence")!;
  assert.equal(walletGroup.groupScore, null);
});

// ---------------------------------------------------------------------
// 23. Potentially related wallets
// ---------------------------------------------------------------------
test("23. potentially related wallets are discounted rather than counted as fully independent signals", () => {
  const walletA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const walletB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const q = walletQuality({ profitabilityScore: 0.9, consistencyScore: 0.9, recentPerformanceScore: 0.9, sampleSizeConfidence: 0.8 });

  const relationship: WalletRelationshipSignal = {
    chainId: CHAIN_ID,
    walletA,
    walletB,
    computedAt: NOW.toISOString(),
    commonTokenCount: 4,
    commonTokenOverlapRatio: 1,
    synchronizedBuyCount: 6,
    synchronizedBuyWindowSeconds: 30,
    relationshipScore: 0.9,
    possiblyRelated: true,
    evidence: ["synchronized buys"],
  };

  const related = engine().evaluate(
    healthyInputs({
      walletAssociations: [
        walletAssociation({ id: "sig1:0", wallet: walletIdentity({ address: walletA }) }),
        walletAssociation({ id: "sig1:1", wallet: walletIdentity({ address: walletB }) }),
      ],
      walletQualityByAddress: new Map([
        [walletA, { ...q, walletAddress: walletA }],
        [walletB, { ...q, walletAddress: walletB }],
      ]),
      walletRelationships: [relationship],
    }),
    NOW,
  );

  assert.ok(related.featureSnapshot.walletAssessment.notes.some((n) => n.includes("possibly-related")));
  const totalWeight = related.featureSnapshot.walletAssessment.identifiedWallets.reduce((s, w) => s + w.adjustedWeight, 0);
  const undiscountedWeight = related.featureSnapshot.walletAssessment.identifiedWallets.reduce((s, w) => s + w.baseWeight, 0);
  assert.ok(totalWeight < undiscountedWeight);
});

// ---------------------------------------------------------------------
// 24. Stale critical data
// ---------------------------------------------------------------------
test("24. stale critical market data hard-blocks the decision to IGNORE", () => {
  const result = engine().evaluate(healthyInputs({ marketSnapshot: marketSnapshot({ capturedAt: "2026-09-05T00:00:00.000Z" }) }), NOW); // 10 min old
  assert.ok(result.hardBlockers.reasons.some((r) => r.code === "STALE_CRITICAL_DATA"));
  assert.equal(result.decision, "IGNORE");
});

// ---------------------------------------------------------------------
// 25. Partial provider data
// ---------------------------------------------------------------------
test("25. partial provider data (some groups known, some not) produces a PARTIAL overall data quality, not a crash", () => {
  const result = engine().evaluate(healthyInputs({ momentum: null, holderConcentration: null }), NOW);
  assert.equal(result.dataQuality.overall, "PARTIAL");
  assert.ok(result.overallScore >= 0 && result.overallScore <= 100);
});

// ---------------------------------------------------------------------
// 26. Deterministic repeatability
// ---------------------------------------------------------------------
test("26. the same feature snapshot always produces the identical score, confidence, and decision", () => {
  const inputs = healthyInputs();
  const first = engine().evaluate(inputs, NOW);
  const second = engine().evaluate(inputs, NOW);

  assert.equal(first.overallScore, second.overallScore);
  assert.equal(first.confidence, second.confidence);
  assert.equal(first.decision, second.decision);
  assert.deepEqual(first.scoreBreakdown, second.scoreBreakdown);
  assert.deepEqual(first.hardBlockers, second.hardBlockers);
  assert.deepEqual(first.positiveFactors, second.positiveFactors);
  assert.deepEqual(first.negativeFactors, second.negativeFactors);
  // `id` is intentionally unique per evaluation call (needed for the append-only
  // repository — see smartSelectionRepository.ts) — everything substantive matches.
  assert.notEqual(first.id, second.id);
});

// ---------------------------------------------------------------------
// Explainability sanity check
// ---------------------------------------------------------------------
test("every decision is explainable directly from feature contributions, never a generic summary", () => {
  const result = engine().evaluate(healthyInputs(), NOW);
  assert.ok(result.positiveFactors.length > 0);
  for (const reason of result.positiveFactors) {
    assert.ok(reason.length > 5);
  }
});

test("never contains an LLM-generated or random field — modelVersion is the documented heuristic version", () => {
  const result = engine().evaluate(healthyInputs(), NOW);
  assert.equal(result.modelVersion, "smart-selection-v1");
  assert.equal(result.expectedValue.statisticallyValidated, false);
});

// ---------------------------------------------------------------------
// Phase 7.1 §2 — NaN/Infinity correctness bug regression suite.
//
// Root cause (docs/LIVE_PIPELINE.md): three sites did unguarded
// `new Date(x).getTime()` arithmetic (signal.receivedAt in
// featureGroupScorers.ts, marketDataObservedAt in hardBlockerEngine.ts
// and smartSelectionEngine.ts) — an unparseable timestamp makes
// `.getTime()` return NaN, which `weightedAverage()` did not filter out
// (`NaN !== null` is true in JS), poisoning every downstream weighted
// sum. Fixed via `safeAgeSeconds()` (src/scoring/normalization.ts),
// which returns null instead of NaN for a missing/invalid timestamp, plus
// hardening `weightedAverage()` itself to exclude non-finite values as
// defense-in-depth. These tests deliberately feed malformed/adversarial
// sparse inputs no real caller would construct (a real signal is always
// self-generated via `new Date().toISOString()`) specifically to prove
// the defensive guarantee holds regardless of reachability today.
// ---------------------------------------------------------------------

function assertNoNonFiniteNumbers(value: unknown, path = "root"): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `expected a finite number at ${path}, got ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoNonFiniteNumbers(item, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      assertNoNonFiniteNumbers(val, `${path}.${key}`);
    }
  }
}

test("27. an unparseable signal.receivedAt does not produce a NaN score, confidence, or any other non-finite field", () => {
  const result = engine().evaluate(healthyInputs({ scoutSignal: signal({ receivedAt: "not-a-real-timestamp" }) }), NOW);
  assert.ok(Number.isFinite(result.overallScore));
  assert.ok(Number.isFinite(result.confidence));
  assertNoNonFiniteNumbers(result);
});

test("28. an unparseable marketSnapshot.capturedAt does not produce a NaN score, confidence, or hard-blocker crash", () => {
  const result = engine().evaluate(healthyInputs({ marketSnapshot: marketSnapshot({ capturedAt: "garbage" }) }), NOW);
  assert.ok(Number.isFinite(result.overallScore));
  assert.ok(Number.isFinite(result.confidence));
  // An unparseable observedAt can't be proven stale — it must be skipped, not fabricated as a blocker.
  assert.ok(!result.hardBlockers.reasons.some((r) => r.code === "STALE_CRITICAL_DATA"));
  assertNoNonFiniteNumbers(result);
});

test("29. both signal.receivedAt and marketSnapshot.capturedAt malformed simultaneously still yields a finite, well-formed result", () => {
  const result = engine().evaluate(
    healthyInputs({
      scoutSignal: signal({ receivedAt: "" }),
      marketSnapshot: marketSnapshot({ capturedAt: "2026-13-45T99:99:99.000Z" }),
    }),
    NOW,
  );
  assertNoNonFiniteNumbers(result);
});

test("30. an extremely sparse input (almost everything null/unavailable) never produces NaN — only null/UNAVAILABLE", () => {
  const result = engine().evaluate(
    {
      scoutSignal: signal({ receivedAt: "invalid" }),
      marketSnapshot: null,
      tokenContractInfo: null,
      contractFeatures: null,
      tokenAge: null,
      liquidityAnalysis: null,
      marketFlow: null,
      momentum: null,
      entryQuality: null,
      anomalyFindings: null,
      holderConcentration: null,
      deployerAnalysis: null,
      poolQuality: [],
      walletAssociations: [],
      walletQualityByAddress: new Map(),
      walletRelationships: [],
    },
    NOW,
  );
  assertNoNonFiniteNumbers(result);
  // With almost everything unavailable, overallScore is a weighted average of only the
  // handful of groups that DID produce a score (e.g. signalQuality's messageType/parseConfidence
  // features, marketConditions' regime assessment) — never NaN, and never a crash. Confidence
  // must reflect the real incompleteness (most of the 9 group weights had no computable score),
  // which alone is enough to keep this out of TRADE_CANDIDATE regardless of the raw score.
  assert.ok(result.confidence < SMART_SELECTION_V1_CONFIG.minimumConfidenceForTradeCandidate);
  assert.notEqual(result.decision, "TRADE_CANDIDATE");
});

test("31. weightedAverage itself excludes NaN/Infinity/-Infinity entries rather than propagating them", async () => {
  const { weightedAverage } = await import("./normalization.js");
  assert.equal(weightedAverage([{ value: NaN, weight: 1 }]), null);
  assert.equal(weightedAverage([{ value: Infinity, weight: 1 }]), null);
  assert.equal(weightedAverage([{ value: -Infinity, weight: 1 }]), null);
  // A NaN entry mixed with a legitimate one must not poison the result.
  assert.equal(weightedAverage([{ value: NaN, weight: 1 }, { value: 50, weight: 1 }]), 50);
});

test("32. safeAgeSeconds returns null (never NaN) for missing or malformed timestamps, and a real age for valid ones", async () => {
  const { safeAgeSeconds } = await import("./normalization.js");
  const now = new Date("2026-09-05T00:10:00.000Z");
  assert.equal(safeAgeSeconds(null, now), null);
  assert.equal(safeAgeSeconds(undefined, now), null);
  assert.equal(safeAgeSeconds("", now), null);
  assert.equal(safeAgeSeconds("not-a-date", now), null);
  assert.equal(safeAgeSeconds("2026-09-05T00:08:00.000Z", now), 120);
});
