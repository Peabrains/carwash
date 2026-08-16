import "./env.js";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createPostgresState } from "@chat-adapter/state-pg";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { respondToCustomer, type SafeBookingState } from "./booking-agent.js";
import { transcribeAttachments } from "./transcription.js";

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
  const transcript = await transcribeAttachments(message.attachments);
  const customerMessage = [message.text?.trim(), transcript].filter(Boolean).join("\n").trim();

  if (!customerMessage) {
    console.info("[voice] transcription_unavailable", {
      hasAudio: Boolean(message.attachments?.some((attachment) => attachment.type === "audio")),
    });
    await thread.post("I couldn't understand that voice message. Please resend it a little more clearly, or type your request instead.");
    return;
  }

  const response = await respondToCustomer(customerMessage, state, thread.id);
  await thread.setState(response.state);
  await thread.post(response.text);
});
