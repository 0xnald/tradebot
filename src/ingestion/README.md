# ingestion

Captures raw Scout signals from their source and hands them off as an
opaque, timestamped `RawScoutMessage` (`src/ingestion/types.ts`). Nothing in
this module interprets message content — that's `src/signal-parsing`.

- **Input:** raw messages from a configured signal source.
- **Output:** `RawScoutMessage` records.
- **Must NOT:** interpret, score, or act on signal content.
- **Must NOT:** automate Telegram UI clicks or reverse-engineer any
  third-party bot's private API.

Status: implemented, with two adapters behind the `ScoutIngestionAdapter`
interface.

## Adapters

### `FixtureFileAdapter` (`fixtureFileAdapter.ts`)

Replays a fixed set of previously captured raw messages from a local JSON
file. This is the default adapter for `npm run ingest:dev` when no
Telegram credentials are configured — see `fixtures/README.md` for the
real captured message set it replays.

### `TelegramMtprotoAdapter` (`telegramMtprotoAdapter.ts`)

Reads live posts from a public Telegram channel using a user-mode MTProto
client ([GramJS](https://github.com/gram-js/gramjs), the `telegram` npm
package). This is necessary rather than using Telegram's Bot API, because
the Bot API can only receive channel posts for a channel where a bot has
been added as an admin by that channel's own owner — which isn't possible
for a channel we don't control. A user-mode client reads a public channel
the same way a person using the Telegram app does.

**Verification status: not yet exercised against the live network.** It's
written against GramJS's documented API, but no Telegram credentials exist
in this environment to actually connect and confirm it end-to-end. Review
it carefully — and run it once against a real account — before relying on
it.

## Getting Telegram credentials

1. Go to <https://my.telegram.org>, log in with a real phone number, and
   open "API development tools" to get an `api_id` and `api_hash`. These
   identify the *application*, not a specific login.
2. Put those two values in your local `.env` as `TELEGRAM_API_ID` and
   `TELEGRAM_API_HASH` (never commit `.env`).
3. Run the one-time interactive login helper to obtain a session string for
   *your* account:

   ```bash
   npm run telegram:login
   ```

   This prompts for your phone number, the login code Telegram sends you,
   and your 2FA password if you have one. It prints a session string to
   your terminal — nothing is written to any file automatically. Copy that
   value into your local `.env` as `TELEGRAM_SESSION_STRING`.
4. With all three variables set, `npm run ingest:dev` automatically
   switches from the fixture adapter to the live `TelegramMtprotoAdapter`.

The session string is a credential equivalent to being logged into that
Telegram account — treat it like a password. It is never logged (see
`src/shared/logger.ts`'s redaction) and should stay out of version control.
