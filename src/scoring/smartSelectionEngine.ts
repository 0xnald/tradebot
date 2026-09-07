// The Smart Selection Engine — orchestrates every Phase 5 component into
// one SmartSelectionResult. Pure computation over already-fetched
// intelligence: makes ZERO network/provider calls itself (see the Phase 5
// "avoid unnecessary provider calls... should not directly call random
// external APIs" requirement), calls no LLM, and uses no randomness — the
// same SmartSelectionInputs always produce the identical result.

import { buildDataQualitySummary } from "../shared/dataQuality.js";
import { safeAgeSeconds, weightedAverage } from "./normalization.js";
import { SMART_SELECTION_V1_CONFIG } from "./smartSelectionConfig.js";
import { EntryChaseDetector } from "./entryChaseDetector.js";
import { HardBlockerEngine } from "./hardBlockerEngine.js";
import { ConfidenceEngine } from "./confidenceEngine.js";
import { ExpectedValueEstimator } from "./expectedValueEstimator.js";
import { UnknownMarketRegimeProvider, type MarketRegimeProvider } from "./marketRegimeProvider.js";
import { buildExplanation } from "./explainability.js";
import { assessWalletIntelligence, buildWalletIntelligenceGroupScore } from "./walletIntelligenceScorer.js";
import {
  scoreSignalQuality,
  scoreTokenQuality,
  scoreLiquidity,
  scoreMarketFlow,
  scoreMomentum,
  scoreEntryQuality,
  scoreHolderStructure,
  scoreMarketConditions,
} from "./featureGroupScorers.js";
import type {
  ContractFeatureDetection,
  DataQualityState,
  DeployerAnalysis,
  EntryQualityFeatures,
  FeatureGroupScore,
  HolderConcentrationBreakdown,
  LiquidityAnalysis,
  MarketAnomalyFindings,
  MarketFlowAnalysis,
  MarketRegimeAssessment,
  MomentumAnalysis,
  PoolQualityAssessment,
  ScoutSignal,
  ScoutWalletAssociation,
  SignalMarketSnapshot,
  SmartSelectionConfig,
  SmartSelectionDecision,
  SmartSelectionResult,
  TokenAge,
  TokenContractInfo,
  WalletQualityFeatures,
  WalletRelationshipSignal,
} from "../types/domain.js";

export interface SmartSelectionInputs {
  scoutSignal: ScoutSignal;
  marketSnapshot: SignalMarketSnapshot | null;
  tokenContractInfo: TokenContractInfo | null;
  contractFeatures: ContractFeatureDetection | null;
  tokenAge: TokenAge | null;
  liquidityAnalysis: LiquidityAnalysis | null;
  marketFlow: MarketFlowAnalysis | null;
  momentum: MomentumAnalysis | null;
  entryQuality: EntryQualityFeatures | null;
  anomalyFindings: MarketAnomalyFindings | null;
  holderConcentration: HolderConcentrationBreakdown | null;
  deployerAnalysis: DeployerAnalysis | null;
  poolQuality: PoolQualityAssessment[];
  walletAssociations: ScoutWalletAssociation[];
  walletQualityByAddress: Map<string, WalletQualityFeatures>;
  walletRelationships: WalletRelationshipSignal[];
  marketRegime?: MarketRegimeAssessment;
}

const DATA_QUALITY_RANK: Record<DataQualityState, number> = { UNAVAILABLE: 0, UNKNOWN: 0, PARTIAL: 1, STALE: 2, KNOWN: 3 };
const DECISION_RANK: Record<SmartSelectionDecision, number> = { IGNORE: 0, WATCH: 1, TRADE_CANDIDATE: 2 };

function meetsMinimumDataQuality(actual: DataQualityState, minimum: DataQualityState): boolean {
  return DATA_QUALITY_RANK[actual] >= DATA_QUALITY_RANK[minimum];
}

let evaluationCounter = 0;

export class SmartSelectionEngine {
  #config: SmartSelectionConfig;
  #chaseDetector = new EntryChaseDetector();
  #hardBlockerEngine: HardBlockerEngine;
  #confidenceEngine: ConfidenceEngine;
  #evEstimator: ExpectedValueEstimator;
  #regimeProvider: MarketRegimeProvider;

  constructor(config: SmartSelectionConfig = SMART_SELECTION_V1_CONFIG, regimeProvider: MarketRegimeProvider = new UnknownMarketRegimeProvider()) {
    this.#config = config;
    this.#hardBlockerEngine = new HardBlockerEngine(config);
    this.#confidenceEngine = new ConfidenceEngine(config);
    this.#evEstimator = new ExpectedValueEstimator(config);
    this.#regimeProvider = regimeProvider;
  }

  evaluate(inputs: SmartSelectionInputs, now: Date = new Date()): SmartSelectionResult {
    const marketRegime = inputs.marketRegime ?? this.#regimeProvider.assess();

    const chaseAssessment = this.#chaseDetector.classify(inputs.entryQuality, inputs.liquidityAnalysis);

    const walletAssessment = assessWalletIntelligence(
      inputs.walletAssociations,
      inputs.walletQualityByAddress,
      inputs.walletRelationships,
      this.#config,
    );

    const groupScores: FeatureGroupScore[] = [
      scoreSignalQuality(inputs.scoutSignal, this.#config.groupWeights.signalQuality, now),
      scoreTokenQuality(
        inputs.tokenContractInfo,
        inputs.tokenAge,
        inputs.contractFeatures,
        inputs.deployerAnalysis,
        this.#config.groupWeights.tokenQuality,
      ),
      scoreLiquidity(inputs.liquidityAnalysis, inputs.poolQuality, this.#config.groupWeights.liquidity),
      scoreMarketFlow(inputs.marketFlow, this.#config.groupWeights.marketFlow),
      scoreMomentum(inputs.momentum, this.#config.groupWeights.momentum),
      scoreEntryQuality(inputs.entryQuality, this.#config.groupWeights.entryQuality),
      scoreHolderStructure(inputs.holderConcentration, this.#config.groupWeights.holderStructure),
      buildWalletIntelligenceGroupScore(walletAssessment, this.#config.groupWeights.walletIntelligence),
      scoreMarketConditions(marketRegime, this.#config.groupWeights.marketConditions),
    ];

    // Missing data reduces CONFIDENCE, not the score: overallScore is a
    // weighted average of only the groups that actually produced a score.
    const overallScore = weightedAverage(groupScores.map((g) => ({ value: g.groupScore, weight: g.groupWeight }))) ?? 0;

    const dataQuality = buildDataQualitySummary(
      groupScores.map((g) => ({ field: g.group, state: g.dataQuality })),
      now,
    );

    const currentLiquidityUsd = inputs.liquidityAnalysis?.currentLiquidityUsd ?? inputs.marketSnapshot?.liquidityUsd ?? null;
    const priceUsd = inputs.marketSnapshot?.priceUsd ?? null;
    const marketDataObservedAt = inputs.marketSnapshot?.capturedAt ?? null;

    const hardBlockers = this.#hardBlockerEngine.evaluate(
      {
        tokenContractInfo: inputs.tokenContractInfo,
        contractFeatures: inputs.contractFeatures,
        deployerAnalysis: inputs.deployerAnalysis,
        liquidityAnalysis: inputs.liquidityAnalysis,
        currentLiquidityUsd,
        priceUsd,
        marketDataObservedAt,
        overallDataQuality: dataQuality.overall,
        chaseAssessment,
        entryQuality: inputs.entryQuality,
      },
      now,
    );

    const marketDataAgeSeconds = safeAgeSeconds(marketDataObservedAt, now);
    const confidenceBreakdown = this.#confidenceEngine.compute({
      groupScores,
      criticalFeaturesAvailable: {
        liquidity: currentLiquidityUsd !== null,
        contractFeatures: inputs.contractFeatures !== null,
        holderData: inputs.holderConcentration !== null && inputs.holderConcentration.dataQuality !== "UNAVAILABLE",
      },
      walletAssessment,
      marketDataAgeSeconds,
    });

    const expectedValue = this.#evEstimator.estimate({
      overallScore,
      confidence: confidenceBreakdown.overallConfidence,
      chaseAssessment,
      hardBlocked: hardBlockers.blocked,
    });

    let decision: SmartSelectionDecision;
    if (hardBlockers.blocked) {
      decision = "IGNORE";
    } else if (
      overallScore >= this.#config.thresholds.tradeCandidate &&
      confidenceBreakdown.overallConfidence >= this.#config.minimumConfidenceForTradeCandidate &&
      meetsMinimumDataQuality(dataQuality.overall, this.#config.minimumDataQualityForTradeCandidate)
    ) {
      decision = "TRADE_CANDIDATE";
    } else if (overallScore >= this.#config.thresholds.watch) {
      decision = "WATCH";
    } else {
      decision = "IGNORE";
    }

    // Anti-chase cap: HIGH_CHASE_RISK can only ever downgrade a decision, never upgrade one.
    if (!hardBlockers.blocked && chaseAssessment.level === "HIGH_CHASE_RISK") {
      const cap = this.#config.highChaseRiskCapsDecisionAt;
      if (DECISION_RANK[decision] > DECISION_RANK[cap]) decision = cap;
    }

    const { positiveFactors, negativeFactors, blockingFactors } = buildExplanation(groupScores, hardBlockers);

    evaluationCounter += 1;
    const computedAt = now.toISOString();

    return {
      id: `${inputs.scoutSignal.id}:${computedAt}:${evaluationCounter}`,
      signalId: inputs.scoutSignal.id,
      chainId: inputs.tokenContractInfo?.chainId ?? inputs.marketSnapshot?.chainId ?? inputs.scoutSignal.chainId ?? 0,
      contractAddress: inputs.tokenContractInfo?.contractAddress ?? inputs.marketSnapshot?.contractAddress ?? inputs.scoutSignal.contractAddress ?? "",
      computedAt,
      decision,
      overallScore,
      confidence: confidenceBreakdown.overallConfidence,
      confidenceBreakdown,
      expectedValue,
      chaseAssessment,
      scoreBreakdown: groupScores,
      positiveFactors,
      negativeFactors,
      blockingFactors,
      hardBlockers,
      dataQuality,
      featureSnapshot: {
        scoutSignal: inputs.scoutSignal,
        marketSnapshot: inputs.marketSnapshot,
        tokenContractInfo: inputs.tokenContractInfo,
        contractFeatures: inputs.contractFeatures,
        tokenAge: inputs.tokenAge,
        liquidityAnalysis: inputs.liquidityAnalysis,
        marketFlow: inputs.marketFlow,
        momentum: inputs.momentum,
        entryQuality: inputs.entryQuality,
        anomalyFindings: inputs.anomalyFindings,
        holderConcentration: inputs.holderConcentration,
        deployerAnalysis: inputs.deployerAnalysis,
        poolQuality: inputs.poolQuality,
        walletAssessment,
        marketRegime,
        configVersion: this.#config.modelVersion,
      },
      modelVersion: this.#config.modelVersion,
    };
  }
}
