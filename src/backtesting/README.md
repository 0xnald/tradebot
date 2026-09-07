# backtesting

Replays historical Scout signals through the real, unmodified Phase 5
`SmartSelectionEngine` and simulates entry/exit against real historical
price data, to answer one question: does Smart Selection beat taking every
raw Scout call? Full methodology, real run results, and honest limitations:
`docs/BACKTESTING.md`.

- **Input:** historical `ScoutSignal` records, reconstructed
  `SmartSelectionInputs` (see `signalReconstructor.ts`), and historical
  OHLCV candles (`geckoTerminalHistoricalPriceProvider.ts`).
- **Output:** a persisted `BacktestRun` (`src/storage/backtestRunRepository.ts`)
  and a human-readable report (`reportFormatter.ts`).
- **Must NOT:** use data that wouldn't have been available at decision time
  (enforced by `lookaheadGuard.ts`, not just documented); reimplement Smart
  Selection's scoring; tune Smart Selection's weights/thresholds to improve
  results.

Run: `npm run backtest` (real network calls, read-only) /
`npm run backtest:report` (reprints the latest saved report, no network).

Status: implemented. Real run against the 2026-09-04 fixture found a
significant on-chain pool-discovery coverage gap — see
`docs/BACKTESTING.md`.
