# execution

Real execution adapters, planned around Uniswap/UniswapX on Robinhood
Chain. Disabled entirely while `TRADING_MODE=paper`; `TRADING_MODE=live` is
not yet supported anywhere in this system.

- **Input:** `TradeDecision` (action = `BUY`), once live mode is eventually
  enabled.
- **Output:** submitted transaction + receipt.
- **Must NOT:** reverse-engineer BasedBot, automate any Telegram/UI client,
  or invent an undocumented API for any third-party execution venue.
  BasedBot may only be added as an adapter here if/when an official,
  documented programmatic integration exists.

Status: not implemented.
