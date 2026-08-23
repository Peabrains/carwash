import "./env.js";
import { Chat } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createFirestoreState } from "./firestore-state.js";
import { respondToCustomer, type SafeBookingState } from "./booking-agent.js";
import { transcribeAttachments } from "./transcription.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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
  state: createFirestoreState(),
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

  const idle = state?.lastActiveAt
    ? Date.now() - new Date(state.lastActiveAt).getTime() >= IDLE_TIMEOUT_MS
    : false;
  const normalized = customerMessage.toLowerCase().replace(/[^a-z\u00C0-\u024F]+/gi, " ").trim();
  const wantsContinue = /^(continue|resume|sambung|teruskan|ya|yes|ok|okay)$/.test(normalized);
  const wantsNewChat = /^(new chat|start new|restart|mula baru|buka baru|new booking)$/.test(normalized);

  if (state && state.status !== "completed" && idle && state.status !== "paused") {
    const pausedState = { ...state, status: "paused" as const };
    await thread.setState(pausedState);
    await thread.post("This booking has been paused because the chat was inactive for 5 minutes. Reply *Continue* to resume it, or *New chat* to start over.");
    return;
  }

  if (state?.status === "paused") {
    if (wantsContinue) {
      const response = await respondToCustomer("Continue the previous booking.", { ...state, status: "collecting" }, thread.id);
      await thread.setState(response.state);
      await thread.post(response.text);
      return;
    }
    if (wantsNewChat) {
      const response = await respondToCustomer("Start a completely new booking conversation.", null, thread.id);
      await thread.setState(response.state);
      await thread.post(response.text);
      return;
    }
    await thread.post("Please reply *Continue* to resume the previous booking, or *New chat* to start over.");
    return;
  }

  const response = await respondToCustomer(customerMessage, state, thread.id);
  await thread.setState(response.state);
  await thread.post(response.text);
});
