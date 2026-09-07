# ingestion fixtures

## `scoutrobinhood-2026-09-04.raw.json`

**REAL, not synthetic.** 20 messages captured verbatim from the public,
no-login-required Telegram preview at `https://t.me/s/scoutrobinhood` on
2026-09-04. Captured by fetching that page's HTML directly and extracting,
per message: id, posted timestamp, message text (HTML/markup stripped,
emoji preserved), and every inline keyboard button (label + URL).

This is the evidence base for the message schema documented in
`src/signal-parsing/README.md` — the parser was written to match this data,
not the other way around.

Used by `npm run ingest:dev` as the default message source when no
Telegram credentials are configured, so the full ingestion → parsing →
storage pipeline can be exercised against real Scout output without any
live connection.

Known limitation: the public preview page only shows a recent window of
messages (20 at the time of capture) and is a static snapshot, not a live
feed — it was sufficient to learn the message format, but is not a
substitute for the live adapter (`telegramMtprotoAdapter.ts`) for ongoing
ingestion.
