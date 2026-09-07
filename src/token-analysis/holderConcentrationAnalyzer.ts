// Derives concentration breakdowns directly from a HolderDistribution
// (already fetched via HolderDataProvider — see src/token-analysis/holderDataProvider.ts).
// Does not fetch anything itself, and does not interpret concentration as
// good or bad — see the Phase 4 brief's "Do not interpret concentration as
// automatically good or bad."

import type { HolderConcentrationBreakdown, HolderDistribution } from "../types/domain.js";

function sumTopN(distribution: HolderDistribution, n: number): number | null {
  const slice = distribution.topHolders.slice(0, n);
  if (slice.length === 0) return null;
  const values: number[] = [];
  for (const holder of slice) {
    if (holder.percentageOfSupply === undefined) return null; // can't sum a partial/unknown percentage — don't approximate
    values.push(holder.percentageOfSupply);
  }
  return values.reduce((sum, v) => sum + v, 0);
}

export function computeHolderConcentrationBreakdown(
  chainId: number,
  contractAddress: string,
  distribution: HolderDistribution | null,
  previous?: HolderDistribution | null,
): HolderConcentrationBreakdown {
  const observedAt = new Date().toISOString();

  if (!distribution) {
    return {
      chainId,
      contractAddress,
      observedAt,
      holderCount: null,
      top5ConcentrationPct: null,
      top10ConcentrationPct: null,
      largestHolderSharePct: null,
      deployerSharePct: null,
      concentrationChangePct: null,
      dataQuality: "UNAVAILABLE",
    };
  }

  const top5ConcentrationPct = sumTopN(distribution, 5);
  const top10ConcentrationPct = sumTopN(distribution, 10);
  const largestHolderSharePct = distribution.topHolders[0]?.percentageOfSupply ?? null;
  const deployerSharePct = distribution.deployerHolding?.percentageOfSupply ?? null;

  let concentrationChangePct: number | null = null;
  if (previous) {
    const previousTop10 = sumTopN(previous, 10);
    if (previousTop10 !== null && top10ConcentrationPct !== null) {
      concentrationChangePct = top10ConcentrationPct - previousTop10;
    }
  }

  const knownCount = [distribution.totalHolders, top5ConcentrationPct, top10ConcentrationPct].filter(
    (v) => v !== null,
  ).length;

  return {
    chainId,
    contractAddress,
    observedAt,
    holderCount: distribution.totalHolders,
    top5ConcentrationPct,
    top10ConcentrationPct,
    largestHolderSharePct,
    deployerSharePct,
    concentrationChangePct,
    dataQuality: knownCount === 3 ? "KNOWN" : knownCount === 0 ? "UNAVAILABLE" : "PARTIAL",
  };
}
