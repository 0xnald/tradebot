// Group I: Market Conditions (Phase 5 §I). An interface stub, not a
// model — "For now it may return UNKNOWN until sufficient data exists. We
// will improve this later." Configured group weight is 0 in
// smartSelectionConfig.ts, so this genuinely has no influence on the score
// yet; it exists so the rest of the engine has a stable place to plug a
// real regime model into later without changing every call site.

import type { MarketRegimeAssessment } from "../types/domain.js";

export interface MarketRegimeProvider {
  assess(): MarketRegimeAssessment;
}

export class UnknownMarketRegimeProvider implements MarketRegimeProvider {
  assess(): MarketRegimeAssessment {
    return {
      regime: "UNKNOWN",
      notes: ["no market-regime model implemented yet — Phase 5 scope is limited to this interface stub, see docs/SMART_SELECTION.md §I"],
    };
  }
}
