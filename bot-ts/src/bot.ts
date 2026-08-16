import "./env.js";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createPostgresState } from "@chat-adapter/state-pg";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { respondToCustomer, type SafeBookingState } from "./booking-agent.js";

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

const telegram = createTelegramAdapter({
  botToken: token,
  secretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
});

export const bot = new Chat({
  userName: "washpoint",
  adapters: { telegram },
  state: process.env.POSTGRES_URL
    ? createPostgresState({ url: process.env.POSTGRES_URL })
    : createMemoryState(),
  onLockConflict: "drop",
});

bot.onDirectMessage(async (thread, message) => {
  const state = (await thread.state) as SafeBookingState | null;
  const response = await respondToCustomer(message.text, state, thread.id);
  await thread.setState(response.state);
  await thread.post(response.text);
});
