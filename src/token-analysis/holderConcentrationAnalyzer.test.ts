import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHolderConcentrationBreakdown } from "./holderConcentrationAnalyzer.js";
import type { HolderDistribution } from "../types/domain.js";

const CHAIN_ID = 4663;
const TOKEN = "0xtoken";

function distribution(overrides: Partial<HolderDistribution> = {}): HolderDistribution {
  return {
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    observedAt: new Date().toISOString(),
    totalHolders: 100,
    topHolders: [
      { address: "0x1", balanceRaw: "500", percentageOfSupply: 20 },
      { address: "0x2", balanceRaw: "400", percentageOfSupply: 15 },
      { address: "0x3", balanceRaw: "300", percentageOfSupply: 10 },
      { address: "0x4", balanceRaw: "200", percentageOfSupply: 5 },
      { address: "0x5", balanceRaw: "100", percentageOfSupply: 3 },
      { address: "0x6", balanceRaw: "90", percentageOfSupply: 2 },
    ],
    topHolderConcentrationPct: 55,
    source: "test",
    ...overrides,
  };
}

test("returns UNAVAILABLE with all-null fields when there's no holder distribution at all", () => {
  const result = computeHolderConcentrationBreakdown(CHAIN_ID, TOKEN, null);
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.equal(result.holderCount, null);
  assert.equal(result.top5ConcentrationPct, null);
});

test("sums the top 5 and top 10 holder percentages independently", () => {
  const result = computeHolderConcentrationBreakdown(CHAIN_ID, TOKEN, distribution());
  assert.equal(result.top5ConcentrationPct, 20 + 15 + 10 + 5 + 3);
  assert.equal(result.top10ConcentrationPct, 20 + 15 + 10 + 5 + 3 + 2); // only 6 holders available
  assert.equal(result.dataQuality, "KNOWN");
});

test("reports the largest single holder's share separately from the aggregate", () => {
  const result = computeHolderConcentrationBreakdown(CHAIN_ID, TOKEN, distribution());
  assert.equal(result.largestHolderSharePct, 20);
});

test("reports the deployer's share only when deployerHolding was actually found", () => {
  const withDeployer = computeHolderConcentrationBreakdown(
    CHAIN_ID,
    TOKEN,
    distribution({ deployerHolding: { address: "0xdeployer", balanceRaw: "50", percentageOfSupply: 1.5 } }),
  );
  assert.equal(withDeployer.deployerSharePct, 1.5);

  const withoutDeployer = computeHolderConcentrationBreakdown(CHAIN_ID, TOKEN, distribution());
  assert.equal(withoutDeployer.deployerSharePct, null);
});

test("computes concentration change only when a previous distribution is supplied", () => {
  const current = distribution();
  const previous = distribution({
    topHolders: current.topHolders.map((h) => ({ ...h, percentageOfSupply: (h.percentageOfSupply ?? 0) - 5 })),
  });

  const withPrevious = computeHolderConcentrationBreakdown(CHAIN_ID, TOKEN, current, previous);
  assert.ok(withPrevious.concentrationChangePct !== null);

  const withoutPrevious = computeHolderConcentrationBreakdown(CHAIN_ID, TOKEN, current);
  assert.equal(withoutPrevious.concentrationChangePct, null);
});

test("does not fabricate a top-N sum when a holder's percentage is unknown", () => {
  const partial = distribution({
    topHolders: [{ address: "0x1", balanceRaw: "500" }], // no percentageOfSupply
  });
  const result = computeHolderConcentrationBreakdown(CHAIN_ID, TOKEN, partial);
  assert.equal(result.top5ConcentrationPct, null);
});

test("reports 'PARTIAL' data quality when only some concentration figures are known", () => {
  const partial = distribution({ totalHolders: null });
  const result = computeHolderConcentrationBreakdown(CHAIN_ID, TOKEN, partial);
  assert.equal(result.dataQuality, "PARTIAL");
});
