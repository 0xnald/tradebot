// Phase 7 — the live orchestrator. Two independent responsibilities that
// must never block each other (§12): (A) Scout signal processing — one raw
// message triggers one bounded-concurrency task, so a slow signal never
// delays the next one arriving; (B) open-paper-position monitoring — runs
// on its own timer, completely independent of signal ingestion. One
// broken signal or position never crashes the listener (§18) — every
// per-item failure is caught and logged, never propagated.

import { ConcurrencyLimiter } from "../shared/concurrencyLimiter.js";
import { runWithSignalContext } from "../shared/signalContext.js";
import { createLogger } from "../shared/logger.js";
import { processRawMessage, type SignalProcessorDeps } from "./signalProcessor.js";
import { pollPosition, type PositionMonitorDeps } from "./paperPositionManager.js";
import type { PaperPortfolio } from "./paperPortfolio.js";
import type { LiveSignalRecordRepository } from "../storage/liveSignalRecordRepository.js";
import type { LivePaperPositionRepository } from "../storage/livePaperPositionRepository.js";
import type { WatchObservationRepository } from "../storage/watchObservationRepository.js";
import type { ScoutIngestionAdapter, RawScoutMessage } from "../ingestion/types.js";
import type { LivePaperPosition, LiveSignalRecord, SmartSelectionDecision, WatchObservation } from "../types/domain.js";

const logger = createLogger("live-pipeline");

/** Phase 7.2 §23 — how long to keep polling a WATCHed signal for follow-up observations after the decision was made. A WATCH is analytical, not a trade, so this is deliberately generous (long enough to see whether the setup developed) without polling forever. */
const DEFAULT_WATCH_OBSERVATION_WINDOW_MS = 4 * 60 * 60 * 1000;

export interface LivePipelineStats {
  received: number;
  processed: number;
  ignored: number;
  watch: number;
  tradeCandidates: number;
  paperEntries: number;
  failures: number;
}

interface WatchedSignal {
  contractAddress: string;
  chainId: number;
  tokenSymbol: string | null;
  decidedAt: string;
  decidedScore: number | null;
  decidedConfidence: number | null;
}

export interface LivePipelineOptions {
  adapter: ScoutIngestionAdapter;
  signalProcessorDeps: Omit<SignalProcessorDeps, "isDuplicate" | "markProcessed" | "onPositionOpened">;
  signalRecordRepository: LiveSignalRecordRepository;
  paperPositionRepository: LivePaperPositionRepository;
  /**
   * Phase 7.2 §23 — optional: when supplied, every WATCH decision is polled
   * for follow-up market observations (never a trade, never fed back into
   * a decision) alongside open-position monitoring, on the same interval.
   * Omitted entirely, this feature simply does not run — existing
   * deployments/tests are unaffected.
   */
  watchObservationRepository?: WatchObservationRepository;
  watchObservationWindowMs?: number;
  /**
   * Phase 7.3 §22 — WATCH observation is purely analytical and must never
   * compete with a fresh Scout call's RPC needs. Optional: when supplied,
   * WATCH polling uses THIS price resolver (wired to a LOW-priority RPC
   * client — see instrumentedChainClient.ts) instead of
   * `positionMonitorDeps.resolvePrice` (wired to a higher priority, since
   * an open PAPER POSITION's exit/risk monitoring outranks WATCH
   * observation per §22/§23's explicit ordering: fresh signal > position
   * monitoring > WATCH). Falls back to `positionMonitorDeps.resolvePrice`
   * when not supplied, exactly matching Phase 7.2's behavior.
   */
  watchResolvePrice?: PositionMonitorDeps["resolvePrice"];
  positionMonitorDeps: Omit<PositionMonitorDeps, "portfolio">;
  portfolio: PaperPortfolio;
  maxConcurrentSignals: number;
  positionPollIntervalMs: number;
}

export class LivePipeline {
  #options: LivePipelineOptions;
  #limiter: ConcurrencyLimiter;
  #processedSignalIds = new Set<string>();
  #openPositions = new Map<string, LivePaperPosition>();
  #watchedSignals = new Map<string, WatchedSignal>();
  #positionPollTimer: ReturnType<typeof setInterval> | null = null;
  #stats: LivePipelineStats = { received: 0, processed: 0, ignored: 0, watch: 0, tradeCandidates: 0, paperEntries: 0, failures: 0 };
  #recentRecords: LiveSignalRecord[] = [];
  #maxRecentRecords = 50;
  #pendingTasks = new Set<Promise<void>>();

  constructor(options: LivePipelineOptions) {
    this.#options = options;
    this.#limiter = new ConcurrencyLimiter(options.maxConcurrentSignals);
  }

  get stats(): LivePipelineStats {
    return { ...this.#stats };
  }

  get openPositions(): LivePaperPosition[] {
    return [...this.#openPositions.values()];
  }

  get recentRecords(): LiveSignalRecord[] {
    return [...this.#recentRecords];
  }

  /** How many WATCH signals are currently being observed (§23) — exposed for status views/tests. */
  get watchedSignalCount(): number {
    return this.#watchedSignals.size;
  }

  /** Restart recovery (§19): recovers dedup state and resumes monitoring every position that was still OPEN when the process last stopped. Never duplicates old Scout calls, never silently drops an open position. Also restores in-window WATCH signals (§23) so a restart doesn't silently stop observing them. */
  async recoverFromDisk(): Promise<{ recoveredSignals: number; recoveredOpenPositions: number }> {
    const existingRecords = await this.#options.signalRecordRepository.list();
    const windowMs = this.#options.watchObservationWindowMs ?? DEFAULT_WATCH_OBSERVATION_WINDOW_MS;
    const now = this.#options.positionMonitorDeps.now?.() ?? new Date();
    for (const record of existingRecords) {
      this.#processedSignalIds.add(record.signalId);
      if (record.decision === "WATCH" && record.contractAddress) {
        const decidedAtEvent = record.events.find((e) => e.stage === "PAPER_DECISION");
        const decidedAt = decidedAtEvent?.timestamp ?? record.receivedAt;
        if (now.getTime() - new Date(decidedAt).getTime() < windowMs) {
          this.#watchedSignals.set(record.signalId, {
            contractAddress: record.contractAddress,
            chainId: this.#options.signalProcessorDeps.intelligenceDeps.chainId,
            tokenSymbol: record.tokenSymbol,
            decidedAt,
            decidedScore: record.overallScore,
            decidedConfidence: record.confidence,
          });
        }
      }
    }

    const existingPositions = await this.#options.paperPositionRepository.list();
    let recoveredOpenPositions = 0;
    for (const position of existingPositions) {
      if (position.status === "OPEN") {
        this.#openPositions.set(position.id, position);
        recoveredOpenPositions += 1;
      }
    }

    logger.info("recovered state from disk", { recoveredSignals: existingRecords.length, recoveredOpenPositions, recoveredWatchedSignals: this.#watchedSignals.size });
    return { recoveredSignals: existingRecords.length, recoveredOpenPositions };
  }

  async start(): Promise<void> {
    await this.recoverFromDisk();
    this.#positionPollTimer = setInterval(() => {
      this.#pollAllPositions().catch((error) => logger.error("position poll cycle failed", { error: error instanceof Error ? error.message : String(error) }));
      this.#pollWatchedSignals().catch((error) => logger.error("watch observation poll cycle failed", { error: error instanceof Error ? error.message : String(error) }));
    }, this.#options.positionPollIntervalMs);
    // Phase 7.3B §L — a periodic maintenance poll must never be the reason the process stays alive.
    // Live mode's real keep-alive is the Telegram client's own connection (see scripts/liveScout.ts);
    // this timer being unref'd changes nothing there, but means a test (or replay run) that exits
    // without reaching `stop()` — e.g. a rejected assertion skipping the rest of the test body — no
    // longer leaves the process hanging on this interval alone.
    this.#positionPollTimer.unref?.();

    await this.#options.adapter.start((raw: RawScoutMessage) => {
      this.#stats.received += 1;
      // Fire-and-forget through the bounded-concurrency limiter — this callback returns immediately so
      // the adapter's own message loop (GramJS's event stream, or a fixture replay) is never blocked by
      // one signal's processing time. See Phase 7 §3. Tracked in #pendingTasks so a caller (e.g. a
      // replay run with a natural end) can wait for genuinely in-flight work to finish before reporting
      // final results or exiting — a fast rejection (no I/O) and a slow real-network signal must not be
      // treated as equally "done" just because the adapter's own message loop has moved on.
      const task = this.#limiter.run(() => this.#handleRawMessage(raw));
      this.#pendingTasks.add(task);
      task
        .catch((error) => {
          this.#stats.failures += 1;
          logger.error("signal processing failed", { rawMessageId: raw.id, error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          this.#pendingTasks.delete(task);
        });
    });
  }

  /** Resolves once every signal-processing task handed off so far has settled — for a replay (or any run with a natural end), call this before reading final stats/reporting, since a message being "received" by the adapter does not mean its (possibly slow, real-network) processing has actually finished. Never needed for a live connection, which has no natural end. */
  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.#pendingTasks]);
  }

  /** Runs one position-monitoring cycle immediately — the automatic interval calls this internally; exposed directly so tests (and a manual "poll now" CLI action) don't have to wait on a real timer. */
  async pollPositionsOnce(): Promise<void> {
    return this.#pollAllPositions();
  }

  /** Runs one WATCH-observation cycle immediately (§23) — same reasoning as `pollPositionsOnce`. A no-op when no `watchObservationRepository` was configured. */
  async pollWatchedSignalsOnce(): Promise<void> {
    return this.#pollWatchedSignals();
  }

  async stop(): Promise<void> {
    if (this.#positionPollTimer) {
      clearInterval(this.#positionPollTimer);
      this.#positionPollTimer = null;
    }
    await this.#options.adapter.stop();
  }

  async #handleRawMessage(raw: RawScoutMessage): Promise<void> {
    // Phase 7.3 §1 — makes this signal's id available to every RPC call instrumented underneath,
    // however deep (resolveMarketContextOnce, the Pons/V4 readers, token analysis, ...), without
    // threading a signalId parameter through any of their function signatures. Matches the same
    // provisional id `signalProcessor.ts` computes internally (`${source}:${raw.id}`).
    const provisionalSignalId = `${this.#options.signalProcessorDeps.source}:${raw.id}`;
    const record = await runWithSignalContext(provisionalSignalId, () =>
      processRawMessage(raw, {
        ...this.#options.signalProcessorDeps,
        isDuplicate: async (id: string) => this.#processedSignalIds.has(id),
        markProcessed: async (id: string) => {
          this.#processedSignalIds.add(id);
        },
        onPositionOpened: async (position: LivePaperPosition) => {
          this.#openPositions.set(position.id, position);
          await this.#options.paperPositionRepository.save(position);
          this.#stats.paperEntries += 1;
        },
      }),
    );

    await this.#options.signalRecordRepository.save(record);
    this.#recordProcessed(record);
  }

  #recordProcessed(record: LiveSignalRecord): void {
    this.#stats.processed += 1;
    this.#tallyDecision(record.decision);
    this.#recentRecords.push(record);
    if (this.#recentRecords.length > this.#maxRecentRecords) this.#recentRecords.shift();

    // §23 — a WATCH decision is never re-scored and never becomes a trade; it just starts being
    // observed for follow-up market snapshots. Only recorded here, at the moment of the real decision,
    // never retroactively — see WatchObservation's doc comment.
    if (record.decision === "WATCH" && record.contractAddress && this.#options.watchObservationRepository) {
      const decidedAtEvent = record.events.find((e) => e.stage === "PAPER_DECISION");
      this.#watchedSignals.set(record.signalId, {
        contractAddress: record.contractAddress,
        chainId: this.#options.signalProcessorDeps.intelligenceDeps.chainId,
        tokenSymbol: record.tokenSymbol,
        decidedAt: decidedAtEvent?.timestamp ?? record.receivedAt,
        decidedScore: record.overallScore,
        decidedConfidence: record.confidence,
      });
    }
  }

  #tallyDecision(decision: SmartSelectionDecision | null): void {
    if (decision === "IGNORE") this.#stats.ignored += 1;
    else if (decision === "WATCH") this.#stats.watch += 1;
    else if (decision === "TRADE_CANDIDATE") this.#stats.tradeCandidates += 1;
  }

  async #pollAllPositions(): Promise<void> {
    for (const [id, position] of [...this.#openPositions]) {
      try {
        const result = await pollPosition(position, { ...this.#options.positionMonitorDeps, portfolio: this.#options.portfolio });
        await this.#options.paperPositionRepository.save(result.position);
        if (result.closed) this.#openPositions.delete(id);
        else this.#openPositions.set(id, result.position);
      } catch (error) {
        // One broken position must never stop monitoring the others (§18).
        logger.error("failed to poll position", { positionId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * §23 — WATCH observation: purely analytical, never a trade, never fed
   * back into a decision, never opens a position. Reuses the SAME
   * `resolvePrice` callback position monitoring already has (no new
   * provider wiring needed) and simply persists what the market looked
   * like at this moment for a signal Smart Selection chose to WATCH.
   * A signal stops being polled once it falls outside the configured
   * observation window — not deleted from history, just no longer
   * actively re-observed.
   */
  async #pollWatchedSignals(): Promise<void> {
    const repository = this.#options.watchObservationRepository;
    if (!repository) return;

    const windowMs = this.#options.watchObservationWindowMs ?? DEFAULT_WATCH_OBSERVATION_WINDOW_MS;
    const now = this.#options.positionMonitorDeps.now?.() ?? new Date();

    for (const [signalId, watched] of [...this.#watchedSignals]) {
      if (now.getTime() - new Date(watched.decidedAt).getTime() >= windowMs) {
        this.#watchedSignals.delete(signalId);
        continue;
      }

      try {
        const resolvePrice = this.#options.watchResolvePrice ?? this.#options.positionMonitorDeps.resolvePrice;
        const price = await resolvePrice(watched.contractAddress, watched.chainId);
        const observedAt = now.toISOString();
        const observation: WatchObservation = {
          id: `${signalId}:${observedAt}`,
          signalId,
          contractAddress: watched.contractAddress,
          tokenSymbol: watched.tokenSymbol,
          decidedAt: watched.decidedAt,
          decidedScore: watched.decidedScore,
          decidedConfidence: watched.decidedConfidence,
          observedAt,
          priceUsd: price.priceUsd,
          liquidityUsd: price.liquidityUsd,
          venueType: price.venueType,
          dataQuality: price.dataQuality,
        };
        await repository.save(observation);
      } catch (error) {
        // One broken watch observation must never stop observing the others (§18's principle, applied here too).
        logger.error("failed to poll watched signal", { signalId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
