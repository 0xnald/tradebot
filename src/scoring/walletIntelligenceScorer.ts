// Group H: Wallet Intelligence (Phase 5 §10-11). The most stateful scorer
// here — it must distinguish four genuinely different situations
// (UNAVAILABLE / UNRESOLVED / INSUFFICIENT_SAMPLE / AVAILABLE) rather than
// collapsing them into a single "no wallet data" case, and it must
// discount — never zero out, never claim shared identity — clusters of
// possibly-related wallets so they don't count as N independent opinions.
//
// CRITICAL (Phase 5 brief, verbatim): if Scout's wallet mentions are
// unresolved, wallet intelligence = unavailable, NOT zero, NOT positive.
// This scorer never substitutes Scout's own "elite"/"good" labels for
// actual computed WalletQualityFeatures evidence.

import { weightedAverage } from "./normalization.js";
import type {
  DataQualityState,
  FeatureContribution,
  FeatureGroupScore,
  IdentifiedWalletContribution,
  ScoutWalletAssociation,
  SmartSelectionConfig,
  WalletQualityFeatures,
  WalletRelationshipSignal,
  WalletSignalAssessment,
} from "../types/domain.js";

/** Union-find over `possiblyRelated` edges — groups wallets into clusters, case-insensitively. */
function buildClusters(addresses: string[], relationships: WalletRelationshipSignal[]): string[][] {
  const parent = new Map<string, string>();
  const key = (a: string) => a.toLowerCase();
  const find = (x: string): string => {
    const k = key(x);
    const p = parent.get(k);
    if (p === undefined) return k;
    if (p === k) return k;
    const root = find(p);
    parent.set(k, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const addr of addresses) parent.set(key(addr), key(addr));
  const addressSet = new Set(addresses.map(key));

  for (const rel of relationships) {
    if (!rel.possiblyRelated) continue;
    if (addressSet.has(key(rel.walletA)) && addressSet.has(key(rel.walletB))) {
      union(rel.walletA, rel.walletB);
    }
  }

  const clusters = new Map<string, string[]>();
  for (const addr of addresses) {
    const root = find(addr);
    const list = clusters.get(root) ?? [];
    list.push(addr);
    clusters.set(root, list);
  }
  return [...clusters.values()];
}

function compositeQualityScore(q: WalletQualityFeatures): number | null {
  const avg = weightedAverage([
    { value: q.profitabilityScore, weight: 1 },
    { value: q.consistencyScore, weight: 1 },
    { value: q.recentPerformanceScore, weight: 1 },
    { value: q.copyabilityScore, weight: 0.5 },
  ]);
  return avg !== null ? avg * 100 : null;
}

export function assessWalletIntelligence(
  associations: ScoutWalletAssociation[],
  walletQualityByAddress: Map<string, WalletQualityFeatures>,
  relationships: WalletRelationshipSignal[],
  config: SmartSelectionConfig,
): WalletSignalAssessment {
  if (associations.length === 0) {
    return {
      status: "UNAVAILABLE",
      identifiedWallets: [],
      relationshipSignals: [],
      walletScore: null,
      notes: ["no wallets were mentioned in this signal"],
    };
  }

  // Only a resolved full address counts as "identified" — never a truncated string or Scout's own label.
  const resolved = associations.filter((a) => a.wallet.address && (a.confidence === "high" || a.confidence === "medium"));
  if (resolved.length === 0) {
    return {
      status: "UNRESOLVED",
      identifiedWallets: [],
      relationshipSignals: [],
      walletScore: null,
      notes: [
        `Scout mentioned ${associations.length} wallet(s) but none could be resolved to a full address — see docs/WALLET_DATA_SOURCES.md §1`,
      ],
    };
  }

  const withQuality = resolved
    .map((a) => ({ address: a.wallet.address!, quality: walletQualityByAddress.get(a.wallet.address!.toLowerCase()) }))
    .filter((w): w is { address: string; quality: WalletQualityFeatures } => Boolean(w.quality));

  if (withQuality.length === 0) {
    return {
      status: "UNAVAILABLE",
      identifiedWallets: [],
      relationshipSignals: [],
      walletScore: null,
      notes: ["wallet address(es) resolved, but no performance/quality data has been computed for them yet"],
    };
  }

  const sufficientSample = withQuality.filter((w) => w.quality.sampleSizeConfidence >= config.walletMinimumSampleSizeConfidence);
  if (sufficientSample.length === 0) {
    return {
      status: "INSUFFICIENT_SAMPLE",
      identifiedWallets: [],
      relationshipSignals: relationships,
      walletScore: null,
      notes: [
        `all ${withQuality.length} identified wallet(s) have sample-size confidence below the minimum (${config.walletMinimumSampleSizeConfidence}) — too little trade history to trust`,
      ],
    };
  }

  const contributions: IdentifiedWalletContribution[] = sufficientSample.map(({ address, quality }) => ({
    walletAddress: address,
    qualityFeatures: quality,
    baseWeight: quality.sampleSizeConfidence,
    adjustedWeight: quality.sampleSizeConfidence,
    compositeQualityScore: compositeQualityScore(quality),
  }));

  // Correlated-wallet penalty: within each cluster of possibly-related
  // wallets, only the single best-quality member keeps full weight; every
  // other member's weight is discounted by walletRelationshipIndependenceFactor
  // (default 0.3) — never claims shared identity, just avoids counting a
  // cluster as N independent opinions. See docs/SMART_SELECTION.md §11.
  const clusters = buildClusters(contributions.map((c) => c.walletAddress), relationships);
  const relatedClusterCount = clusters.filter((c) => c.length > 1).length;

  for (const cluster of clusters) {
    if (cluster.length <= 1) continue;
    const members = contributions.filter((c) => cluster.some((addr) => addr.toLowerCase() === c.walletAddress.toLowerCase()));
    const best = members.reduce((a, b) => ((b.compositeQualityScore ?? -1) > (a.compositeQualityScore ?? -1) ? b : a));
    for (const member of members) {
      if (member !== best) member.adjustedWeight = member.baseWeight * config.walletRelationshipIndependenceFactor;
    }
  }

  const walletScore = weightedAverage(contributions.map((c) => ({ value: c.compositeQualityScore, weight: c.adjustedWeight })));

  const notes: string[] = [];
  if (sufficientSample.length < withQuality.length) {
    notes.push(`${withQuality.length - sufficientSample.length} wallet(s) excluded from scoring for insufficient sample size`);
  }
  if (relatedClusterCount > 0) {
    notes.push(
      `${relatedClusterCount} cluster(s) of possibly-related wallets detected — discounted to avoid counting correlated wallets as independent signals (not a claim of shared identity)`,
    );
  }

  return { status: "AVAILABLE", identifiedWallets: contributions, relationshipSignals: relationships, walletScore, notes };
}

const STATUS_TO_GROUP_QUALITY: Record<WalletSignalAssessment["status"], DataQualityState> = {
  UNAVAILABLE: "UNAVAILABLE",
  UNRESOLVED: "UNAVAILABLE", // per the Phase 5 brief: unresolved wallet identity = unavailable, never zero/positive
  INSUFFICIENT_SAMPLE: "PARTIAL", // something is known (resolved wallets exist) but not enough to trust
  AVAILABLE: "KNOWN",
};

/** Wraps a WalletSignalAssessment into the same FeatureGroupScore shape every other group uses, for a uniform scoreBreakdown. */
export function buildWalletIntelligenceGroupScore(assessment: WalletSignalAssessment, groupWeight: number): FeatureGroupScore {
  if (assessment.status !== "AVAILABLE") {
    const reasonByStatus: Record<WalletSignalAssessment["status"], string> = {
      UNAVAILABLE: "no wallets mentioned or no quality data computed",
      UNRESOLVED: "Scout's wallet mentions could not be resolved to full addresses",
      INSUFFICIENT_SAMPLE: "identified wallet(s) have too little trade history to trust",
      AVAILABLE: "",
    };
    const features: FeatureContribution[] = [
      {
        name: "walletIntelligence",
        rawValue: assessment.status,
        normalizedValue: null,
        weight: 0,
        contribution: null,
        reason: reasonByStatus[assessment.status],
        dataQuality: STATUS_TO_GROUP_QUALITY[assessment.status],
      },
    ];
    return { group: "walletIntelligence", features, groupScore: null, groupWeight, dataQuality: STATUS_TO_GROUP_QUALITY[assessment.status] };
  }

  const features: FeatureContribution[] = assessment.identifiedWallets.map((w) => {
    const normalizedValue = w.compositeQualityScore !== null ? w.compositeQualityScore / 100 : null;
    return {
      name: `wallet:${w.walletAddress}`,
      rawValue: w.compositeQualityScore,
      normalizedValue,
      weight: w.adjustedWeight,
      contribution: normalizedValue !== null ? normalizedValue * w.adjustedWeight : null,
      reason: `identified wallet ${w.walletAddress} — composite quality ${w.compositeQualityScore?.toFixed(0) ?? "unknown"}, sample-size confidence ${(w.qualityFeatures.sampleSizeConfidence * 100).toFixed(0)}%${w.adjustedWeight < w.baseWeight ? " (weight discounted — possibly related to another identified wallet)" : ""}`,
      dataQuality: (w.compositeQualityScore !== null ? "KNOWN" : "UNKNOWN") as DataQualityState,
    };
  });

  return { group: "walletIntelligence", features, groupScore: assessment.walletScore, groupWeight, dataQuality: "KNOWN" };
}
