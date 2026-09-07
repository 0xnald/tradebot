# storage

Persistence for captured signals, behind the `SignalRepository` interface
so the implementation can change without touching ingestion or parsing.

- **Input:** `ScoutSignal` records.
- **Output:** durable storage + lookup/listing.
- **Must NOT:** leak into `signal-parsing` (the parser has no idea storage
  exists) or perform any interpretation of a signal's content.

## `FileSignalRepository`

The Phase 1 development implementation: an append-only NDJSON file (one
JSON object per line), loaded into an in-memory map on first use. Chosen
over introducing Postgres because Phase 1's volume and requirements
(inspectability, simple dedupe) don't need a database server — see
`PROJECT_PLAN.md`'s "Open decisions" for when that might change.

Deduplication relies on `ScoutSignal.id`, which is deterministic
(`${source}:${sourceMessageId}`) — re-parsing and re-saving the same
Telegram message, even after a process restart, resolves to the same id and
`saveSignal` is a no-op for an id that's already stored.

Default path: `data/signals.ndjson` (gitignored — see the repo root
`.gitignore`).

Status: implemented (`fileSignalRepository.ts`), tested
(`fileSignalRepository.test.ts`).

## Generic `createFileRepository()` (Phase 3)

Phase 3 needed four more repositories (wallet identity, activity,
performance, Scout-wallet association). Rather than hand-roll the same
NDJSON load/save/dedupe logic four more times, `fileRepository.ts` factors
it into a generic `createFileRepository<T>({filePath, getId, mode})`.
Phase 1's `FileSignalRepository` is left as-is (already implemented and
tested) rather than retroactively refactored onto this — not asked for,
and not worth the churn to already-verified code.

Two modes:

- **`"append"`** — an event log; `save()` is a no-op for an id that
  already exists. Used for `WalletActivityRepository` (a trade either
  happened or it didn't) and `ScoutWalletAssociationRepository` (preserve
  every observed association).
- **`"upsert"`** — latest-state-per-id; `save()` overwrites and rewrites
  the whole file. Used for `WalletIdentityRepository` (an identity's
  confidence can improve as new evidence arrives) and
  `WalletPerformanceRepository` (a recomputed summary replaces the old
  one — this phase only keeps the latest snapshot per wallet, not a
  history of them).

Each of the four wrapper files (`wallet*Repository.ts`) just supplies the
right `getId` function — see their doc comments for the exact key shape.

## Phase 4 additions

Two more repositories, same generic factory, both `"append"` mode:

- **`liquiditySnapshotRepository.ts`** — keyed by `chainId:poolAddress:observedAt`; every reading is a distinct historical data point, never overwritten. `getRecentLiquiditySnapshots()` returns the N most recent for a pool, newest first — the shape `LiquidityAnalyzer` expects for its `previous`/`priorToPrevious` arguments.
- **`signalMarketSnapshotRepository.ts`** — keyed by `signalId`; the first snapshot recorded for a signal is preserved as "the initial market state" forever (a later save for the same id is a no-op), matching the Phase 4 brief's "do not overwrite the original ScoutSignal" extended to its market snapshot.

## Phase 5 addition

- **`smartSelectionRepository.ts`** — same generic factory, `"append"` mode, keyed by each `SmartSelectionResult`'s own unique `id`. A re-evaluation of the same signal creates a brand-new record rather than overwriting the previous one — `listEvaluationsForSignal()` returns every evaluation for a signal, oldest first, so later backtesting can see how the assessment evolved as market conditions changed after the original Scout call.
