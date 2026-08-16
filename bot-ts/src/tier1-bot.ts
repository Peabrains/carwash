import "./env.js";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createPostgresState } from "@chat-adapter/state-pg";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { handleTier1Action, handleTier1Text, startTier1 } from "./tier1-flow.js";

const token = process.env.TIER1_TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TIER1_TELEGRAM_BOT_TOKEN is required");

const telegram = createTelegramAdapter({ botToken: token, secretToken: process.env.TIER1_TELEGRAM_WEBHOOK_SECRET_TOKEN });
export const tier1Bot = new Chat({
  userName: "washpoint_tier1",
  adapters: { telegram },
  state: (process.env.TIER1_POSTGRES_URL || process.env.POSTGRES_URL) ? createPostgresState({ url: process.env.TIER1_POSTGRES_URL || process.env.POSTGRES_URL, keyPrefix: "washpoint-tier1" }) : createMemoryState(),
  onLockConflict: "drop",
});

tier1Bot.onDirectMessage(async (thread, message) => {
  if (message.attachments?.some(attachment => attachment.type === "audio")) return thread.post("This booking bot uses fixed menus. Please type your request or use /start.");
  await handleTier1Text(thread, message.text.trim());
});
tier1Bot.onAction(async event => { if (event.thread) await handleTier1Action(event.thread, event.actionId, event.value); });
