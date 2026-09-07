import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { createLogger } from "../shared/logger.js";
import type { RawScoutMessage, ScoutIngestionAdapter, ScoutMessageButton } from "./types.js";

const logger = createLogger("ingestion:telegram-mtproto");

export interface TelegramMtprotoAdapterOptions {
  apiId: number;
  apiHash: string;
  sessionString: string;
  /** Channel username without the "@"/"t.me/" prefix, e.g. "scoutrobinhood". */
  channelUsername: string;
}

/**
 * Reads live posts from a public Telegram channel using a user-mode MTProto
 * client (GramJS — see package.json for why this dependency was chosen).
 *
 * This approach is necessary, not just convenient: Telegram's Bot API can
 * only receive channel posts for a channel where a bot has been added as an
 * admin by that channel's own owner. We do not control Scout's channel, so
 * a bot cannot subscribe to it. A user-mode client reads a public channel
 * the same way a person using the Telegram app does — this is Telegram's
 * own documented mechanism for user applications (api_id/api_hash issued at
 * https://my.telegram.org), not a workaround or reverse-engineered access
 * path.
 *
 * IMPORTANT — verification status: this class has been written against
 * GramJS's documented API but has NOT been exercised against the live
 * network in this environment, because no Telegram credentials exist here.
 * Treat it as reviewed-but-unverified until it's run once against a real
 * account and channel.
 */
export class TelegramMtprotoAdapter implements ScoutIngestionAdapter {
  readonly name = "telegram-mtproto";
  #options: TelegramMtprotoAdapterOptions;
  #client?: TelegramClient;
  #handler?: (event: NewMessageEvent) => Promise<void>;

  constructor(options: TelegramMtprotoAdapterOptions) {
    this.#options = options;
  }

  async start(onMessage: (message: RawScoutMessage) => void | Promise<void>): Promise<void> {
    const session = new StringSession(this.#options.sessionString);
    const client = new TelegramClient(session, this.#options.apiId, this.#options.apiHash, {
      connectionRetries: 5,
    });

    await client.connect();
    this.#client = client;

    const channel = await client.getEntity(this.#options.channelUsername);

    this.#handler = async (event: NewMessageEvent) => {
      try {
        const raw = toRawScoutMessage(event.message, this.#options.channelUsername);
        await onMessage(raw);
      } catch (error) {
        logger.error("failed to handle incoming Telegram message", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    client.addEventHandler(this.#handler, new NewMessage({ chats: [channel] }));

    logger.info("connected to Telegram channel", {
      channel: this.#options.channelUsername,
    });
  }

  async stop(): Promise<void> {
    if (this.#client && this.#handler) {
      this.#client.removeEventHandler(this.#handler, new NewMessage({}));
    }
    await this.#client?.destroy();
  }
}

/**
 * GramJS's message/update types are large generated classes; rather than
 * import and pin to their exact shape here (and risk silently breaking on a
 * GramJS upgrade), this reads the small set of fields it needs defensively.
 * Tighten this once the adapter has actually been run against live
 * traffic and the real shape has been observed directly.
 */
function toRawScoutMessage(message: any, channelUsername: string): RawScoutMessage {
  const buttons: ScoutMessageButton[] = [];
  const rows = message?.replyMarkup?.rows ?? [];
  for (const row of rows) {
    for (const button of row?.buttons ?? []) {
      if (typeof button?.url === "string") {
        buttons.push({ text: String(button.text ?? ""), url: button.url });
      }
    }
  }

  const messageId = String(message?.id ?? "");

  return {
    id: messageId,
    channel: channelUsername,
    postedAt: message?.date ? new Date(message.date * 1000).toISOString() : null,
    text: String(message?.message ?? ""),
    messageUrl: messageId ? `https://t.me/${channelUsername}/${messageId}` : undefined,
    buttons,
    mediaType: message?.media?.className,
    isForwarded: Boolean(message?.fwdFrom),
  };
}
