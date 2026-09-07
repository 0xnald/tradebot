# signal-parsing fixtures

Each file is `{ "_provenance": string, "message": RawScoutMessage }`.

- **REAL** fixtures were captured verbatim from the public
  `https://t.me/s/scoutrobinhood` preview on 2026-09-04. They are the
  ground truth the parser was written against.
- **SYNTHETIC** fixtures are hand-constructed variants (built by modifying
  the real template) used to exercise edge cases that either don't appear
  in the ~20-message sample we could capture, or that specifically test
  parser robustness. They are clearly labeled as synthetic in their
  `_provenance` field and must never be mistaken for real Scout output.

| File | Real/synthetic | Exercises |
|---|---|---|
| `real-early-call.json` | REAL | complete EARLY_CALL message |
| `real-performance-update.json` | REAL | complete PERFORMANCE_UPDATE message |
| `synthetic-partial-early-call.json` | SYNTHETIC | several optional fields missing (age, volume, swaps, live buys) |
| `synthetic-missing-contract.json` | SYNTHETIC | no buttons at all → no contract address recoverable |
| `synthetic-missing-marketcap.json` | SYNTHETIC | `Mcap:` line absent, everything else present |
| `synthetic-different-formatting.json` | SYNTHETIC | comma-grouped numbers, extra blank lines, decimal age |
| `synthetic-malformed.json` | SYNTHETIC | text matching neither template → `UNKNOWN` |

Duplicate-message behavior is not a fixture concern — it's tested directly
in `src/storage/fileSignalRepository.test.ts` by parsing the same raw
message twice and asserting the repository stores it once.
