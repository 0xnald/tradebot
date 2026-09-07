// One-time, interactive helper to obtain a Telegram user-session string.
//
// This is NOT part of the running application and is never invoked
// automatically. Run it manually, once, to log in as a regular Telegram
// user account (the same kind of login as the mobile/desktop app) and print
// a session string you paste into your own local .env as
// TELEGRAM_SESSION_STRING. Nothing here writes any secret to disk — the
// value only ever appears in your terminal.
//
// Prerequisites:
//   1. Get TELEGRAM_API_ID and TELEGRAM_API_HASH from https://my.telegram.org
//      -> "API development tools" (requires a real Telegram account/phone).
//   2. Export them in your shell before running this script:
//        TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npm run telegram:login
//
// Usage: npm run telegram:login

import * as readline from "node:readline/promises";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiId || !apiHash) {
    console.error(
      "Set TELEGRAM_API_ID and TELEGRAM_API_HASH in your environment before running this script.\n" +
        "Get both from https://my.telegram.org -> API development tools.",
    );
    process.exitCode = 1;
    return;
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: () => prompt("Phone number (international format, e.g. +15551234567): "),
    password: () => prompt("2FA password (leave blank if you don't have one): "),
    phoneCode: () => prompt("Login code sent to your Telegram app: "),
    onError: (err) => console.error(err),
  });

  const sessionString = client.session.save() as unknown as string;

  console.log("\nLogin successful.");
  console.log("Add this to your local .env as TELEGRAM_SESSION_STRING — do not commit it:\n");
  console.log(sessionString);
  console.log();

  await client.destroy();
}

main().catch((error) => {
  console.error("Login failed:", error);
  process.exitCode = 1;
});
