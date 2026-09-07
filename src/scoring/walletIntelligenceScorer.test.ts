import { test } from "node:test";
import assert from "node:assert/strict";
import { assessWalletIntelligence } from "./walletIntelligenceScorer.js";
import { SMART_SELECTION_V1_CONFIG } from "./smartSelectionConfig.js";
import type { ScoutWalletAssociation, WalletIdentity, WalletQualityFeatures, WalletRelationshipSignal } from "../types/domain.js";

const CHAIN_ID = 4663;

function identity(overrides: Partial<WalletIdentity> = {}): WalletIdentity {
  return {
    chainId: CHAIN_ID,
    discoverySource: "on-chain-swap",
    discoveredAt: new Date().toISOString(),
    confidence: "high",
    sourceReferences: [],
    ...overrides,
  };
}

function association(overrides: Partial<ScoutWalletAssociation> = {}): ScoutWalletAssociation {
  return {
    id: "sig1:0",
    scoutSignalId: "sig1",
    chainId: CHAIN_ID,
    wallet: identity(),
    associationSource: "scout-message:sig1",
    confidence: "high",
    observedAt: new Date().toISOString(),
    rawEvidence: "...",
    ...overrides,
  };
}

function quality(overrides: Partial<WalletQualityFeatures> = {}): WalletQualityFeatures {
  return {
    chainId: CHAIN_ID,
    walletAddress: "0xwallet",
    computedAt: new Date().toISOString(),
    consistencyScore: 0.7,
    profitabilityScore: 0.8,
    earlyEntryScore: null,
    liquidityAwareScore: null,
    sampleSizeConfidence: 0.5,
    recentPerformanceScore: 0.6,
    copyabilityScore: 0.5,
    riskScore: null,
    unavailableFeatures: [],
    ...overrides,
  };
}

test("returns UNAVAILABLE (not zero, not positive) when Scout mentioned no wallets at all", () => {
  const result = assessWalletIntelligence([], new Map(), [], SMART_SELECTION_V1_CONFIG);
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.walletScore, null);
});

test("returns UNRESOLVED — never a fabricated score — when Scout's wallets couldn't be resolved to full addresses", () => {
  const associations = [association({ wallet: identity({ address: undefined, confidence: "unresolved" }), confidence: "unresolved" })];
  const result = assessWalletIntelligence(associations, new Map(), [], SMART_SELECTION_V1_CONFIG);
  assert.equal(result.status, "UNRESOLVED");
  assert.equal(result.walletScore, null);
});

test("returns UNAVAILABLE when wallets are resolved but no quality data has been computed yet", () => {
  const associations = [association({ wallet: identity({ address: "0xwallet" }) })];
  const result = assessWalletIntelligence(associations, new Map(), [], SMART_SELECTION_V1_CONFIG);
  assert.equal(result.status, "UNAVAILABLE");
});

test("returns INSUFFICIENT_SAMPLE when every identified wallet's trade history is too thin to trust", () => {
  const associations = [association({ wallet: identity({ address: "0xwallet" }) })];
  const qualityMap = new Map([["0xwallet", quality({ sampleSizeConfidence: 0.01 })]]);
  const result = assessWalletIntelligence(associations, qualityMap, [], SMART_SELECTION_V1_CONFIG);
  assert.equal(result.status, "INSUFFICIENT_SAMPLE");
  assert.equal(result.walletScore, null);
});

test("returns AVAILABLE with a computed score for a well-identified, sufficiently-sampled high-quality wallet", () => {
  const associations = [association({ wallet: identity({ address: "0xwallet" }) })];
  const qualityMap = new Map([["0xwallet", quality({ profitabilityScore: 0.9, consistencyScore: 0.9, sampleSizeConfidence: 0.8 })]]);
  const result = assessWalletIntelligence(associations, qualityMap, [], SMART_SELECTION_V1_CONFIG);
  assert.equal(result.status, "AVAILABLE");
  assert.ok(result.walletScore! > 70);
});

test("a low-quality identified wallet scores lower than a high-quality one", () => {
  const associations = [association({ wallet: identity({ address: "0xwallet" }) })];
  const goodMap = new Map([["0xwallet", quality({ profitabilityScore: 0.9, consistencyScore: 0.9, recentPerformanceScore: 0.9, sampleSizeConfidence: 0.8 })]]);
  const badMap = new Map([["0xwallet", quality({ profitabilityScore: 0.1, consistencyScore: 0.1, recentPerformanceScore: 0.1, sampleSizeConfidence: 0.8 })]]);
  const good = assessWalletIntelligence(associations, goodMap, [], SMART_SELECTION_V1_CONFIG);
  const bad = assessWalletIntelligence(associations, badMap, [], SMART_SELECTION_V1_CONFIG);
  assert.ok(good.walletScore! > bad.walletScore!);
});

test("discounts possibly-related wallets so a cluster of 3 does not out-contribute 3 truly independent wallets", () => {
  const walletA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const walletB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const walletC = "0xcccccccccccccccccccccccccccccccccccccccc";

  const associations = [
    association({ id: "sig1:0", wallet: identity({ address: walletA }) }),
    association({ id: "sig1:1", wallet: identity({ address: walletB }) }),
    association({ id: "sig1:2", wallet: identity({ address: walletC }) }),
  ];
  const q = quality({ profitabilityScore: 0.9, consistencyScore: 0.9, recentPerformanceScore: 0.9, sampleSizeConfidence: 0.8 });
  const qualityMap = new Map([
    [walletA, { ...q, walletAddress: walletA }],
    [walletB, { ...q, walletAddress: walletB }],
    [walletC, { ...q, walletAddress: walletC }],
  ]);

  const relatedSignal = (a: string, b: string): WalletRelationshipSignal => ({
    chainId: CHAIN_ID,
    walletA: a,
    walletB: b,
    computedAt: new Date().toISOString(),
    commonTokenCount: 3,
    commonTokenOverlapRatio: 1,
    synchronizedBuyCount: 5,
    synchronizedBuyWindowSeconds: 30,
    relationshipScore: 0.9,
    possiblyRelated: true,
    evidence: ["synchronized buys"],
  });

  const allRelated = assessWalletIntelligence(
    associations,
    qualityMap,
    [relatedSignal(walletA, walletB), relatedSignal(walletB, walletC)],
    SMART_SELECTION_V1_CONFIG,
  );
  const allIndependent = assessWalletIntelligence(associations, qualityMap, [], SMART_SELECTION_V1_CONFIG);

  const relatedTotalWeight = allRelated.identifiedWallets.reduce((s, w) => s + w.adjustedWeight, 0);
  const independentTotalWeight = allIndependent.identifiedWallets.reduce((s, w) => s + w.adjustedWeight, 0);
  assert.ok(relatedTotalWeight < independentTotalWeight, "a related cluster's total contribution weight must be discounted below 3 independent wallets");

  // Composite score itself (a weighted AVERAGE) is similar since all wallets have identical quality —
  // the discount shows up in total weight/confidence, not by lowering the average score of identical wallets.
  assert.ok(allRelated.notes.some((n) => n.includes("possibly-related")));
});

test("never claims shared identity — uses only 'possibly-related' language", () => {
  const walletA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const walletB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const associations = [
    association({ id: "sig1:0", wallet: identity({ address: walletA }) }),
    association({ id: "sig1:1", wallet: identity({ address: walletB }) }),
  ];
  const qualityMap = new Map([
    [walletA, quality({ walletAddress: walletA })],
    [walletB, quality({ walletAddress: walletB })],
  ]);
  const result = assessWalletIntelligence(
    associations,
    qualityMap,
    [
      {
        chainId: CHAIN_ID,
        walletA,
        walletB,
        computedAt: new Date().toISOString(),
        commonTokenCount: 1,
        commonTokenOverlapRatio: 1,
        synchronizedBuyCount: 2,
        synchronizedBuyWindowSeconds: 30,
        relationshipScore: 0.8,
        possiblyRelated: true,
        evidence: [],
      },
    ],
    SMART_SELECTION_V1_CONFIG,
  );
  const serialized = JSON.stringify(result).toLowerCase();
  assert.ok(!serialized.includes("same person"));
  assert.ok(!serialized.includes("same entity"));
});

test("is fully deterministic", () => {
  const associations = [association({ wallet: identity({ address: "0xwallet" }) })];
  const qualityMap = new Map([["0xwallet", quality()]]);
  const first = assessWalletIntelligence(associations, qualityMap, [], SMART_SELECTION_V1_CONFIG);
  const second = assessWalletIntelligence(associations, qualityMap, [], SMART_SELECTION_V1_CONFIG);
  assert.deepEqual(first, second);
});
