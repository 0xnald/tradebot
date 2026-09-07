export interface ScoutMessageButton {
  text: string;
  url: string;
}

/**
 * A message exactly as obtained from its source, before any interpretation.
 * This is intentionally source-agnostic and permissive — different sources
 * (or different message templates from the same source) will populate a
 * different subset of these fields.
 */
export interface RawScoutMessage {
  /** Source-native message id (e.g. a Telegram message id). Unique within `channel`, not globally. */
  id: string;
  /** Source-native channel/chat identifier, e.g. "scoutrobinhood". */
  channel: string;
  /** ISO 8601 timestamp the source reports for the message, if available. */
  postedAt: string | null;
  /** Raw text content, HTML/markup stripped, emoji preserved as-is. */
  text: string;
  messageUrl?: string;
  /** Inline keyboard buttons, flattened across rows (row grouping is discarded — not needed for parsing). */
  buttons: ScoutMessageButton[];
  mediaType?: string;
  mediaCaption?: string;
  isForwarded?: boolean;
  forwardedFromTitle?: string;
}

/**
 * Contract for anything that can supply raw Scout messages. Concrete
 * sources (a live Telegram client, a replayed fixture file, a future
 * different channel/platform) implement this so the rest of the system
 * never depends on how a message was actually obtained.
 */
export interface ScoutIngestionAdapter {
  /** Human-readable name for logging, e.g. "telegram-mtproto" or "fixture-file". */
  readonly name: string;
  /**
   * Start receiving messages, invoking `onMessage` for each one as it
   * arrives (or, for a replay-style adapter, as it's replayed). Resolves
   * once the adapter has finished its work (a live adapter resolves once
   * connected and subscribed; a replay adapter resolves once replay is
   * done).
   */
  start(onMessage: (message: RawScoutMessage) => void | Promise<void>): Promise<void>;
  /** Stop receiving messages and release any resources (connections, timers, etc). */
  stop(): Promise<void>;
}
