# position-management

Manages open positions (paper or live): take-profit, stop-loss, and
trailing-exit logic, and triggers position close.

- **Input:** open `LivePaperPosition` records, live current-price observations.
- **Output:** closed positions with a recorded `ExitReason`.
- **Must NOT:** open new positions — this module only manages existing
  ones.

Status: implemented as `src/live/paperPositionManager.ts` (Phase 7) rather
than here, for the same reason noted in `src/paper-trading/README.md`.
Supports take-profit, stop-loss, max-holding-time, and a liquidity
emergency exit; never acts on a stale or missing price. See
`docs/LIVE_PIPELINE.md`.
