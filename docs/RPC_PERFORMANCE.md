# RPC Performance & Live Pipeline Reliability — Phase 7.3

## The question this phase answers

Phase 7.2 found that Pons/V4 market intelligence — proven correct by a
standalone, one-token-at-a-time diagnostic script
(`scripts/profileScoutSignals.ts`) — never actually reached Smart
Selection through the live pipeline: the Pons-aware resolution chain
timed out on all 7 real signals under concurrent replay load, even after
deliberately raising its own timeout from 4s to 7s (which didn't help and
was reverted — see `docs/LIVE_INTELLIGENCE.md` §5). The working
hypothesis was RPC-endpoint contention under concurrent load.

Phase 7.3's job was to test that hypothesis with real infrastructure and
real measurements, not more guessing. The honest answer, established
below with evidence: **concurrency contention is real and now measured
and controlled, but it is not the dominant bottleneck for a single
isolated signal.** Even one signal, alone, with no other signal
competing for anything, still fails to resolve Pons venue/flow within the
4-second budget through the real pipeline. The dominant cost is the
**bounded `eth_getLogs` event fetch** for `CurveBuy`/`CurveSell`/`Swap`
events, which is slow enough against the public Robinhood RPC to consume
essentially the entire remaining budget after venue classification
succeeds — a finding consistent with Phase 6.6's own earlier note that a
full-depth adaptive-chunking cascade against a busy pool measured 150+
seconds in the worst case.

## §1 — RPC instrumentation

Every Robinhood Chain RPC call made by the live path now goes through
`src/blockchain/instrumentedChainClient.ts`, which:

- Routes the call through the single global `RpcConcurrencyLimiter`
  (`src/blockchain/rpcConcurrencyLimiter.ts`) — never a separate limiter
  per analyzer.
- Records it to the shared `RpcCallLog`
  (`src/blockchain/rpcInstrumentation.ts`): signal id (via
  `AsyncLocalStorage` — see `src/shared/signalContext.ts`, no signalId
  parameter threaded through any intermediate function), caller label,
  method, start/end/duration, status (OK/ERROR/TIMEOUT), retry count,
  cache-hit flag, concurrency-at-start, and block range for `getLogs`
  calls. Never logs secrets — there are none in a read-only public-RPC
  call.

`npm run live` prints a diagnostic summary at shutdown (total requests,
per-caller/per-method/per-signal breakdown, timeout/error/cache-hit
counts, max concurrency observed, latency percentiles, duplicate-request
groups).

## §2/§26 — the single-signal control result (the key evidence)

Ran each of the 4 real, confirmed Pons signals (THROBBIN, one CRC, Diem —
all graduated to V4; BIOHACKING — still on its curve) **individually**
through the exact production `processRawMessage`
(`scripts/singleSignalControl.ts`), with zero other signals running
concurrently:

| Concurrency limit | Venue resolved? | RPC requests | Max concurrency observed | Decision latency |
|---|---|---|---|---|
| 4 (default) | **No — `UNKNOWN` for all 4** | 4–19 | 4 | ~4.0–4.5s (hit the shared deadline) |
| 8 | **No — `UNKNOWN` for all 4** | 4–6 | 4–6 (never reached 8) | ~4.0–4.4s (unchanged) |

Raising the concurrency ceiling made **no difference** — the limiter
never needed more than 4–6 concurrent slots even when 8 were available,
proving concurrency capacity was not the constraint for an isolated
signal. This directly answers §26: **the 4 known Pons tokens fail
individually through the exact production SignalProcessor, not just in
the 7-signal concurrent run** — meaning the original "it's contention"
hypothesis was too narrow. Something in the pipeline itself, independent
of cross-signal concurrency, doesn't fit in the budget.

## §7/§8 — deduplication (a real fix, applied)

Auditing what each branch fetches found `TokenAnalysisService.getFastTokenInfo()`
called `chainClient.getTokenMetadata()` directly, uncached — while
`resolveMarketContextOnce` (Phase 7.2) already fetched the SAME token's
metadata via the shared, time-independent `tokenMetadataCache.ts`
(24h TTL — safe because decimals/name/symbol don't vary by decision
timestamp). Every signal was therefore fetching the same token's metadata
**twice**. Fixed by routing `TokenAnalysisService` through the same
cache (`src/token-analysis/tokenAnalysisService.ts`).

Measured effect (single-signal control, concurrency=4): RPC request count
per signal dropped from up to 19 to a consistent 4. **Venue resolution
still did not complete within the deadline** — this fix reduced overall
RPC volume (worthwhile: less wasted load on a rate-limited public
endpoint) but did not address the actual critical-path bottleneck below.

## §10/§11 — the actual bottleneck: bounded `eth_getLogs` for flow events

With the duplicate fetch removed, the remaining 4 RPC calls per signal
(Pons factory lookup, current block number, 2× decimals) all complete
within budget — the timeout does not fire during context resolution.
Because `resolvePonsAwareMarketData`'s outer `withTimeout` wraps the
*whole* chain (context resolution + reader dispatch, from the Phase 7.2
fix), a call that's in flight when the deadline fires is abandoned rather
than recorded — so the absence of a 5th/6th recorded call is itself
evidence that the **next step (the bounded `CurveBuy`/`CurveSell`/`Swap`
event fetch in `PonsCurveMarketReader`/`UniswapV4FlowReader`) is what
consumes the rest of the budget**, not context resolution.

This is consistent with, not contradictory to, Phase 6.6's own
documented finding: a full-depth `fetchLogsWithAdaptiveChunking` cascade
against a busy pool measured 150+ seconds against this exact public RPC.
The curve/V4 readers already use a shallow `MAX_SPLIT_DEPTH=3` (fail
fast into partial/unavailable rather than hang) and a bounded,
anchor-based block window (`estimateRecentBlockWindow` — anchored to
Scout's call time for a curve, or the launch's real graduation timestamp
for V4, not an arbitrary lookback), per Phase 7.2's design. Even so, a
single `eth_getLogs` call over that window still appears to often exceed
the ~3.5s of budget remaining after context resolution, under real
conditions. Narrowing the window further, or querying a
higher-throughput/authenticated RPC endpoint specifically for this call,
are the two concrete remaining levers — neither implemented here: the
former risks silently missing genuine recent trades (a correctness
concern, not just a performance one) without further evidence on how
narrow is still safe; the latter requires an endpoint this phase doesn't
have access to. Documented as the clear, evidence-backed next step for a
future phase.

## §3/§4/§17 — global RPC concurrency control (implemented, verified correct)

`src/blockchain/rpcConcurrencyLimiter.ts` — one shared, priority-aware
limiter (`CRITICAL`/`MEDIUM`/`LOW`), configurable via
`ROBINHOOD_RPC_MAX_CONCURRENCY` (default **4**, chosen from this
investigation: raising it to 8 produced zero benefit for a single signal,
so there is no evidence a higher default would help, and a needlessly
high concurrency ceiling only risks harder rate-limiting from the public
endpoint for no measured gain). `SIGNAL_PROCESSING_CONCURRENCY` (the
existing signal-level `maxConcurrentSignals`) remains a fully separate
control — verified via `src/blockchain/rpcConcurrencyLimiter.test.ts` and
`src/blockchain/instrumentedChainClient.test.ts` (15 deterministic tests):
never exceeds the configured cap, services `CRITICAL` work ahead of
`MEDIUM`/`LOW` when contended, preserves FIFO within a tier, and is
provably shared (not duplicated) across differently-prioritized wrapper
instances around the same underlying chain client.

Priority assignment (`scripts/liveScout.ts`), per §4's guidance and this
phase's own evidence about what's actually on the critical path:

- **CRITICAL**: venue/context resolution, Pons curve/V4 price+flow
  readers, V3 pool discovery (`resolveMarketContextOnce`,
  `PonsCurveMarketReader`, `UniswapV4FlowReader`).
- **MEDIUM**: fast token metadata + contract-feature detection
  (`TokenAnalysisService`'s fast tier, `ContractFeatureAnalyzer`).
- **LOW**: deployer enrichment (`DeployerAnalyzer`), and slow token
  enrichment (deployment-block search + Blockscout).
- **LOW, on a separate provider-instance set**: open-paper-position
  monitoring and WATCH observation polling (§22) — background re-checks
  of already-decided signals, never competing with a fresh Scout call's
  CRITICAL/MEDIUM work for the same RPC slots. Simplification, documented
  honestly: position monitoring and WATCH observation currently share one
  LOW tier rather than the finer "position monitoring outranks WATCH"
  split §23 describes, because zero real paper positions exist yet to
  validate that split against — implementing it now would be speculative.
  The wiring point (`LivePipelineOptions.watchResolvePrice`, optional,
  falls back to `positionMonitorDeps.resolvePrice`) already exists for
  when real position load makes it worth doing.

## §18/§19 — deadline-aware scheduling (implemented for the clearest case)

`gatherLiveIntelligence`'s deployer-analysis step — the lowest-priority,
latest-starting piece of the gather, running only after the whole main
fan-out has settled — now checks the REMAINING shared budget before
starting. If less than 500ms remains, it's skipped immediately as
`DEADLINE_SKIPPED` (a new, distinct `LiveProviderCallSummary` status —
`src/types/domain.ts`) rather than being started and inevitably timing
out having spent real RPC capacity for nothing. `TIMEOUT` (work started,
ran out the clock) and `DEADLINE_SKIPPED` (never started, insufficient
budget judged in advance) are never conflated in the diagnostic summary.
Other, earlier-starting branches in the concurrent fan-out do not have an
equivalent judgment point without a larger restructure (they're all
started together, before any of them can know how long the others will
take) — left as-is, consistent with "make sure abandoned optional work
does not continue causing a thundering herd" (§19): none of them
continue any *new* work after their own timeout fires; only the
already-in-flight network request (which nothing in this stack can
cancel — see below) keeps running to completion in the background,
harmlessly.

## §12 — cancellation / AbortSignal (investigated, documented limitation)

`RobinhoodChainClient` is built on viem's `http()` transport. viem's
`PublicClient` methods do not accept a cancellation token for a
one-shot JSON-RPC call in the version this project uses — there is no
clean way to abort an in-flight `eth_getLogs`/`eth_call` once issued.
Practical consequence: when the shared decision deadline fires while a
call is in flight, this codebase's `withTimeout` (`Promise.race`-based,
throughout the live path since Phase 7) correctly stops *waiting* for
it and lets the decision proceed, but the underlying HTTP request keeps
running in the background until it naturally resolves or errors. This is
pre-existing (Phase 7 through 7.2 all rely on the same `withTimeout`
pattern) and is not a Phase 7.3 regression. It does NOT corrupt
concurrency accounting: the global limiter's slot is released in a
`finally` block tied to the actual promise's settlement, so an abandoned
call still correctly frees its slot once it eventually finishes — it just
doesn't free it *immediately* at the deadline. A background "straggler"
request can therefore transiently hold a slot slightly past the decision
it could no longer influence; this is a bounded, self-resolving
inefficiency (bounded by the slow request's own eventual completion, not
unbounded), not a leak.

## §13 — retries (audited, unchanged)

None of the live-path providers (`RobinhoodChainClient`,
`PonsV2Provider`, `PonsCurveMarketReader`, `UniswapV4FlowReader`,
`TokenAnalysisService`) implement their own retry loop today — a failed
or timed-out call is reported as such and the caller moves on (matching
this project's long-standing "do not attempt to evade provider rate
limits" principle, stated as far back as `concurrencyLimiter.ts`'s own
doc comment). `fetchLogsWithAdaptiveChunking`'s bisection-on-failure
behavior (Phase 6.6) is the one exception, and it already fails fast at a
shallow depth rather than retrying exhaustively. No new retry logic was
added in this phase — the evidence above shows the bottleneck is a
single slow call succeeding too late, not a failing call needing a
retry, so adding retries would only make the deadline problem worse.

## §14/§15 — RPC provider configuration

Already supported, from an earlier phase: `ROBINHOOD_CHAIN_RPC_URL` /
`ROBINHOOD_CHAIN_WS_URL` (`src/blockchain/chainConfig.ts`'s
`loadChainConfigFromEnv()`) — no code change needed to point at a
different, higher-throughput endpoint; nothing is hardcoded, and no
credential ever appears in source control or documentation examples
(only the public, unauthenticated default URL is checked in). A
multi-endpoint read pool (§15) was investigated and NOT implemented: no
second verified Robinhood Chain RPC endpoint exists to configure or test
against, and the instruction is explicit not to assume one or spray
requests unsafely. If a second verified endpoint becomes available, the
natural extension point is `RpcConcurrencyLimiter` itself — a second
limiter instance (still one per *endpoint*, never per analyzer) with
routing logic in `instrumentedChainClient.ts`.

## §16 — WebSocket role (investigated, not implemented)

`ROBINHOOD_CHAIN_WS_URL` is already threaded into chain config but the
live path only ever uses the HTTP transport for reads today. A shared
block/event cache fed by a WebSocket subscription (latest block number,
new-block timestamps) could plausibly reduce repeated HTTP round trips
for `getBlockNumber`/`estimateBlockAt` calibration — but this phase's own
evidence (§10/§11 above) shows the dominant cost is the `eth_getLogs`
event-history fetch, not block-number/timestamp lookups, so a WebSocket
cache would not address the actual bottleneck found. Not implemented,
to avoid spending remaining effort on a change with no evidence it
would help the real problem.

## §20 — provider budget allocation (evidence-based conclusion: not re-tuned)

Investigated whether reallocating the 4-second window by priority would
help. Given §2/§26's finding — context resolution reliably fits inside
the budget; the event-log fetch does not, regardless of how much of the
remaining budget it's given (Phase 7.2 already tried 7000ms total with
no effect) — reallocating time between price/liquidity/flow/contract
priority tiers would not change the outcome for this specific bottleneck.
No budget reallocation was made; the existing shared 4000ms
`timeoutMs` is unchanged from Phase 7.1/7.2.

## §21 — DexScreener remains the fallback

Unchanged from Phase 7.1/7.2: DexScreener runs concurrently as its own
branch and is used whenever the on-chain path doesn't produce a price in
time — which, per this phase's findings, is most of the time for
graduated Pons/V4 tokens under the current bottleneck. For BIOHACKING
(pre-graduation curve), DexScreener structurally cannot see it at all —
the direct Pons curve reader remains the only possible source, which is
exactly why closing the `eth_getLogs` gap above matters most for that
case specifically.

## Benchmark scope, honestly bounded

The full 5-value concurrency matrix (1/2/4/6/8) against the complete
7-signal fixture, and the full §24 deterministic load-test suite (10
scenarios: 1 call, 5 concurrent, 10-burst, slow/rate-limited/hanging RPC,
duplicate requests, WATCH-vs-fresh, position-vs-fresh) were not
exhaustively built and run in this phase, given the time this
investigation itself required to reach a confident root cause. What WAS
run with real measurements: the single-signal control at concurrency 4
and 8 (above, the evidence that actually answers the phase's key
question), the global limiter's own correctness (9 tests), the
instrumented client's correctness and shared-limiter behavior (6 tests),
and the full existing regression suite (708 tests, 0 failures) confirming
none of this phase's infrastructure changes broke anything from Phases
1–7.2. The remaining benchmark breadth is legitimate, valuable follow-up
work, not claimed as done.

## Answering the phase's key question

**"Can the existing Pons intelligence complete reliably inside the live
Scout pipeline when RPC capacity is managed correctly?"**

Not yet, honestly — but the reason is now precisely known, not assumed.
RPC capacity IS now managed correctly (a real, tested, shared, priority-
aware global limiter exists and measurably does not need to be raised
further). Doing so did not make Pons intelligence complete reliably,
because concurrency was never the dominant constraint for a single
signal — a genuinely slow, necessary `eth_getLogs` call against the
public RPC is. That is a different, narrower, and more actionable problem
than "contention," and the evidence for it is reproducible via
`scripts/singleSignalControl.ts`.

## Phase 7.3B — the authenticated endpoint's real limit, and the actual root cause

An authenticated Alchemy endpoint was configured (`ROBINHOOD_RPC_HTTP`/
`ROBINHOOD_CHAIN_RPC_URL`) to test whether a paid provider would remove
the bottleneck above. It did not, but it revealed exactly why:

- **Direct probing** (`scripts/phase73bProbe.ts`) found a hard 10-block
  cap on this account's `eth_getLogs`: a 10-block range succeeds, an
  11-block range fails outright, every time.
- **The provider's own error text confirms this is a plan/account
  policy, not a performance limit**: *"Under the Free tier plan, you can
  make eth_getLogs requests with up to a 10 block range... Upgrade to
  PAYG for expanded block range."*
- Measured Robinhood Chain block production is a steady **~9.91 blocks/
  sec** — not the ~200 blocks/sec earlier assumed.
- A separate, independent bug was found and fixed in
  `estimateRecentBlockWindow` (`src/live/resolvedMarketContext.ts`):
  `toBlock` was unconditionally the LIVE chain tip, while `fromBlock` was
  anchored to the Scout signal's own timestamp. Every test/replay run
  processes a real signal from days in the past while `toBlock` reflected
  today's tip — producing the ~2.19-million-block ranges originally
  observed for a nominal 180-minute lookback. Fixed by bounding `toBlock`
  to `min(liveTip, estimateBlockAt(anchor))`; the corrected windows are
  ~107,000 blocks (180 min curve lookback) and ~2,974 blocks (5 min V4
  margin) — matching the measured chain rate exactly.
- The retry logic (`fetchLogsWithAdaptiveChunking`) was also fixed: it
  used to bisect on ANY thrown error, including the flat 10-block-cap
  rejection above (whose own error text happens to contain the phrase
  "block range", classifying it as `RANGE_LIMIT`) — bisecting a
  multi-hundred-thousand-block range toward a 10-block floor needs 15+
  splits, far past any sane depth, and was multiplying RPC calls (12–55
  per signal) without ever succeeding. See `src/blockchain/
  rpcErrorClassification.ts`: only `TOO_MANY_RESULTS` (Phase 6.6's
  original, validated public-RPC case) is bisectable now.

## Phase 7.4 — hybrid routing: use the right provider for the right job

Given the above, no single provider is right for everything: the
authenticated endpoint is faster for ordinary reads (`eth_call`,
`getBlockNumber`, metadata, Pons lifecycle) but cannot serve this
project's real `eth_getLogs` windows at all; the public RPC has no known
range cap and was measured (Phase 7.3A/B) serving the corrected windows
in a few hundred milliseconds.

`src/blockchain/rpcRouting.ts`'s `chooseRpcForLogQuery` decides PRIMARY
vs. LOG **before** any request is made — purely from the requested range
vs. `RpcProviderCapabilities` (`src/blockchain/chainConfig.ts`,
`ROBINHOOD_PRIMARY_MAX_GETLOGS_RANGE`, default 10) — never "try the
authenticated endpoint first, wait for the predictable rejection, then
fall back." `src/blockchain/hybridLogFetcher.ts` executes that decision
and reports a structured `OK | FAILED | TIMED_OUT | RATE_LIMITED |
UNAVAILABLE` outcome; a LOG-provider failure never falls back to PRIMARY,
since routing already established PRIMARY can't serve that range.

Both `PonsCurveMarketReader` and `UniswapV4FlowReader` (and `PonsV2Provider`'s
graduation search) now route through this — confirmed empirically: an
isolated single-signal run went from 0/4 known Pons tokens resolving
venue to **4/4**, with `eth_getLogs` succeeding cleanly (0 errors) instead
of failing 100% of the time. A second, previously-hidden bottleneck
surfaced once the log fetch itself started succeeding: resolving each
trade's block timestamp one at a time in a sequential loop — fixed by
resolving them concurrently via `Promise.all` (`BlockTimestampResolver`
already de-duplicates concurrent requests for the same block).

**Remaining, honestly reported**: under REAL multi-signal concurrent
load (the full 7-signal replay, not the isolated single-signal control),
venue resolution is still inconsistent — Pons classification's own
`readContract` call can queue behind other RPC work sharing the same
PRIMARY concurrency slots long enough to miss the shared decision
deadline. This is a distinct, further bottleneck from the one this phase
targeted (transport/routing) and was not addressed here, per the
explicit instruction not to change timeouts or thresholds reactively —
see the Phase 7.4 final report for the measured before/after numbers.
