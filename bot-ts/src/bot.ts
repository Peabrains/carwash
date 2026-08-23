import "./env.js";
import { Chat } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createFirestoreState } from "./firestore-state.js";
import { respondToCustomer, type SafeBookingState } from "./booking-agent.js";
import { transcribeAttachments } from "./transcription.js";
import { managePublicBooking } from "./supabase-booking.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

const telegram = createTelegramAdapter({
  botToken: token,
  secretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
});

function managementHelp() {
  return "Booking management:\n/manage REFERENCE PHONE — view a booking\n/cancel REFERENCE PHONE — cancel it\n/reschedule REFERENCE PHONE YYYY-MM-DD HH:MM — move it\n\nExample: /manage WP-T1-20260823-ABC123 012-3456789";
}

function managementSummary(booking: any) {
  const time = new Date(booking.scheduled_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `Reference: ${booking.reference}\nService: ${booking.service?.name || "Wash"}\nDate and time: ${booking.scheduled_date} at ${time}\nLocation: ${booking.location?.name || "WashPoint"}\nStatus: ${booking.status}`;
}

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

  const management = customerMessage.match(/^\/(manage|cancel|reschedule)\b(?:\s+(.+))?$/i);
  if (management) {
    const action = management[1].toLowerCase() as "lookup" | "cancel" | "reschedule";
    const args = (management[2] || "").trim().split(/\s+/).filter(Boolean);
    if ((action === "lookup" || action === "cancel") && args.length < 2) { await thread.post(managementHelp()); return; }
    if (action === "reschedule" && args.length < 4) { await thread.post(managementHelp()); return; }
    try {
      const result = await managePublicBooking({ reference: args[0], phone: args[1], action, dateIso: action === "reschedule" ? args[2] : undefined, time: action === "reschedule" ? args[3] : undefined });
      await thread.post(`${action === "lookup" ? "Booking found" : action === "cancel" ? "Booking cancelled" : "Booking rescheduled"}\n\n${managementSummary(result)}`);
    } catch (error) {
      await thread.post(error instanceof Error ? error.message : "I couldn't manage that booking. Please check the reference and phone number.");
    }
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
