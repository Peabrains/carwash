import "./env.js";
import { Chat, type Thread } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createSupabaseState } from "./supabase-state.js";
import { handleTier1Action, handleTier1Text, startTier1, startTier1Channel } from "./tier1-flow.js";

const token = process.env.TIER1_TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TIER1_TELEGRAM_BOT_TOKEN is required");

const telegram = createTelegramAdapter({ botToken: token, secretToken: process.env.TIER1_TELEGRAM_WEBHOOK_SECRET_TOKEN });
export const tier1Bot = new Chat({
  userName: "washpoint_tier1",
  adapters: { telegram },
  state: createSupabaseState(),
  onLockConflict: "drop",
});

tier1Bot.onDirectMessage(async (thread, message) => {
  if (message.attachments?.some(attachment => attachment.type === "audio")) {
    await thread.post("This booking bot uses fixed menus. Please type your request or use /start.");
    return;
  }
  await handleTier1Text(thread, message.text.trim());
});
tier1Bot.onSlashCommand("/start", async event => { await startTier1Channel(event.channel); });
tier1Bot.onAction(async event => { if (event.thread) await handleTier1Action(event.thread as Thread<Record<string, unknown>, unknown>, event.actionId, event.value); });
