# signal-parsing

Converts a `RawScoutMessage` (from `src/ingestion`) into a normalized
`ScoutSignal` (`src/types/domain.ts`).

- **Input:** `RawScoutMessage`.
- **Output:** `ScoutSignal`, with every field left `undefined` unless it
  was actually present in the message.
- **Must NOT:** fetch external data or make any trading decision — parsing
  only.

Status: implemented for the two message templates documented below.

## Observed Scout message schema

This was derived from 20 real messages captured verbatim from the public,
no-login `https://t.me/s/scoutrobinhood` preview on 2026-09-04 — see
`src/ingestion/fixtures/README.md` for exactly how. It reflects what was
observed, not an assumption; a template not present in that sample (or a
future change to Scout's format) could fall outside it, which is exactly
what `messageType: "UNKNOWN"` and `parseConfidence` are for.

Two message templates were observed:

### 1. `EARLY_CALL`

```
🚨 EARLY CALL — $TICKER · CHAIN
💰 called at $VALUE

📊 Pool Info
🏛 DEX: DEX_NAME
📈 Mcap: $VALUE
💧 Liq: $VALUE | PCT%
🧾 Tax: B PCT% | S PCT%

🪙 Token Info
⏱ Age: AGE · 🚀 DEX_SLUG        (optional line)
👥 Holders: N
📊 Vol 24h: $VALUE
🔥 N swaps (5m)
💳 DexS: profile ✓              (optional line)

🔎 Proof: N elite + M good holding — validated on-chain

📹 Live buys (💎 elite · ✅ good)
[💎|✅] $AMOUNT · 0xXXXX…XXXX    (repeated, one per buy)

⚠️ dyor, nfa
```

### 2. `PERFORMANCE_UPDATE`

A short follow-up to an earlier `EARLY_CALL`, tied to it via the **same
contract address** in its buttons (there is no other reliable link — the
ticker alone repeats and isn't unique, and there is no explicit
"replying to message N" reference in the text):

```
[🔥|⚡|🚀] $TICKER hit NX
called $VALUE → $VALUE
peak since the call · dyor
```

### Where the contract address actually comes from

**Important finding:** in every message observed (both templates), the
visible text never contains a contract address. It only appears inside the
message's linked inline-keyboard buttons — BasedBot deep-link, GMGN,
DexScreener, GeckoTerminal, and an X/Twitter search link — each encoding
the *same* address in a different URL shape, e.g.:

```
https://dexscreener.com/robinhood/0xeb1898a0d496000506a2799e1b4077776497fd29
https://gmgn.ai/robinhood/token/scout_0xeb1898a0d496000506a2799e1b4077776497fd29
https://t.me/based_eth_bot?start=r_scout_b_0xeb1898a0d496000506a2799e1b4077776497fd29
```

So `RawScoutMessage.buttons` must be captured by the ingestion layer (it's
part of Telegram's own message data — the inline keyboard / reply markup —
not something scraped from rendered HTML in production), and
`contractAddress` is recovered by scanning all button URLs for a
`0x[0-9a-f]{40}` pattern. If buttons disagree on the address, or none are
present, `contractAddress` is left `undefined` with a warning — never
guessed.

### What Scout does NOT provide (left undefined on purpose)

- **A full token name** — only a `$TICKER`-style symbol is ever shown.
- **A per-unit token price** — only market cap ("Mcap"), not price;
  deriving price would need total supply, which Scout doesn't publish.
- **Full wallet addresses** — the "Live buys" section shows only a
  truncated form (`0x3430…c941`). This is what Scout's own message text
  contains; it is not sufficient for on-chain wallet lookups. Deriving real
  wallet identity/quality is `src/wallet-intelligence`'s job, later, using
  full addresses from the chain — not something this module can produce
  from the message text alone.
- **A chain id** — Scout writes the chain name as plain text ("robinhood").
  This is captured verbatim as `chainRaw`; no chain-name-to-id mapping is
  applied here (`chainId` is reserved for a later module).
- **A "which earlier call does this update refer to" reference** — inferred
  downstream (if needed) by matching `contractAddress`, not stored as a
  field on the signal itself.

## Number formats handled (`numberFormats.ts`)

- Compact USD: `$57k` → 57000, `$3.60M` → 3600000, `$1,132` → 1132.
- Percent: `36.1%` → 36.1.
- Age: `2m` → 120s, `6.9h` → 24840s (only `m`/`h` observed; `s`/`d` also
  supported defensively).

## Parse confidence

`parseConfidence` is `"high"` when the core fields for the message's type
are all present (ticker + contract + mcap + liquidity for `EARLY_CALL`;
ticker + multiplier + called/peak values for `PERFORMANCE_UPDATE`),
`"partial"` when the ticker was found but some core fields weren't, and
`"low"` otherwise (including all `UNKNOWN` messages). `parseWarnings` lists
specifically what was missing or ambiguous — always readable, never used to
fabricate a value.

## Fixtures

See `fixtures/README.md` — real captured messages plus clearly labeled
synthetic edge cases (partial message, missing contract, missing market
cap, differently formatted, malformed/unrecognized).
