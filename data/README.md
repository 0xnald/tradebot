# data

Local runtime data: persisted signal records, paper-trading ledgers,
backtest outputs. Contents are gitignored (see `.gitignore`) — this
directory holds a schema/format description once persistence is
implemented, not the data itself.

- `signals.ndjson` — persisted `ScoutSignal` records (Phase 1).
- `backtests/runs.ndjson` — persisted `BacktestRun` records, one per
  `npm run backtest` invocation (Phase 6, append-only, never rewritten).
  Shape: `src/types/domain.ts`'s `BacktestRun`. See `docs/BACKTESTING.md`.
- `backtests/latest-report.txt` — the human-readable report from the most
  recent `npm run backtest` run (overwritten each run).
- `live/signal-records.ndjson` — persisted `LiveSignalRecord`s from
  `npm run live` (Phase 7, upsert — rewritten as a signal moves through
  its lifecycle). Seeds dedup state on restart. See `docs/LIVE_PIPELINE.md`.
- `live/paper-positions.ndjson` — persisted `LivePaperPosition`s (Phase 7,
  upsert — rewritten on every snapshot/close). Seeds open-position
  recovery on restart.
- `live/watch-observations.ndjson` — persisted `WatchObservation`s (Phase
  7.2, append-only — every poll of a WATCHed signal is a new, distinct
  record, never overwritten). Purely analytical: records what a WATCH
  decision's market looked like afterward, never a trade, never fed back
  into a decision. Optional — only written when `LivePipeline` is
  configured with a `watchObservationRepository`. See
  `docs/LIVE_PIPELINE.md`'s Phase 7.2 section.

Status: signals, backtests, and the live pipeline's paper-trading ledger
are all implemented.
