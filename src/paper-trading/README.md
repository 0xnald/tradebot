# paper-trading

Simulated execution and ledger for `TRADING_MODE=paper` — the only
supported execution path right now.

- **Input:** a `TRADE_CANDIDATE` `SmartSelectionResult` + a current price.
- **Output:** `LivePaperPosition` records against a simulated `PaperPortfolio`.
- **Must NOT:** touch any real wallet or submit any real transaction.

Status: implemented, but living in `src/live/` (`paperTradingEngine.ts`,
`paperPortfolio.ts`, `paperPositionManager.ts`) rather than here — it's
tightly coupled to the live signal pipeline's lifecycle tracking and
bounded-concurrency queue (Phase 7), and splitting it out added indirection
without benefit. See `docs/LIVE_PIPELINE.md`. This directory is kept as a
scaffold placeholder consistent with the original Phase 0 plan; PROJECT_PLAN.md's
"Status" section documents this kind of structural drift generally.
