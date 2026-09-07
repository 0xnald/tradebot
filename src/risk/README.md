# risk

The risk engine. Takes a `ScoreBreakdown` and produces a `RiskDecision` and
ultimately the `TradeDecision` action (`BUY` / `WAIT` / `IGNORE`) plus
position sizing.

- **Input:** `ScoreBreakdown`, account/portfolio state, configured risk
  limits.
- **Output:** `RiskDecision`, `TradeDecision`.
- **Authority:** can veto any trade regardless of score, for any configured
  reason (exposure limits, daily loss limits, data quality, etc.).
- **Must NOT:** be bypassed by any other module, including the LLM — this
  is the single point of trade-approval authority in the system.

Status: not implemented.
