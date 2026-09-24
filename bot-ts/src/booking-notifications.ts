import { createHash, timingSafeEqual } from "node:crypto";
import { publicSupabaseClient } from "./supabase-booking.js";

export type BookingNotificationType = "confirmed" | "reminder_24h" | "reminder_2h" | "cancelled" | "rescheduled";

type BookingNotificationDetails = {
  reference: string;
  providerName: string;
  locationName: string;
  serviceName: string;
  scheduledAt: string;
  vehiclePlate: string;
};

type ClaimedNotification = {
  id: string;
  appointment_id: string;
  notification_type: BookingNotificationType;
  recipient_chat_id: string | null;
  attempts: number;
};

export type NotificationRunSummary = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
};

const headings: Record<BookingNotificationType, string> = {
  confirmed: "✅ Booking confirmed",
  reminder_24h: "⏰ Your car wash is tomorrow",
  reminder_2h: "⏰ Your car wash is in about 2 hours",
  cancelled: "❌ Booking cancelled",
  rescheduled: "🔄 Booking rescheduled",
};

function malaysiaDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

export function formatBookingNotification(type: BookingNotificationType, booking: BookingNotificationDetails) {
  return [
    headings[type],
    "",
    `Reference: ${booking.reference}`,
    `Provider: ${booking.providerName}`,
    `Location: ${booking.locationName}`,
    `Service: ${booking.serviceName}`,
    `Date and time: ${malaysiaDateTime(booking.scheduledAt)}`,
    `Vehicle: ${booking.vehiclePlate}`,
  ].join("\n");
}

export function retryDelayMinutes(attempt: number) {
  return [5, 15, 60, 360][Math.min(Math.max(Math.trunc(attempt), 1), 4) - 1];
}

export function isAuthorizedCronRequest(authorization: string | null, expectedSecret: string | undefined) {
  if (!expectedSecret || !authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice(7);
  if (!supplied) return false;
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expectedSecret).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

async function updateNotification(id: string, values: Record<string, unknown>) {
  const { error } = await publicSupabaseClient().from("booking_notifications").update({ ...values, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(`Supabase notification update failed: ${error.message}`);
}

async function loadDetails(appointmentId: string): Promise<BookingNotificationDetails> {
  const db = publicSupabaseClient();
  const { data: appointment, error } = await db.from("appointments").select("reference,provider_id,location_id,service_id,scheduled_at,vehicle_plate").eq("id", appointmentId).single();
  if (error || !appointment) throw new Error(`Unable to load notification appointment: ${error?.message || "not found"}`);
  const [{ data: provider, error: providerError }, { data: location, error: locationError }, { data: service, error: serviceError }] = await Promise.all([
    db.from("providers").select("name").eq("id", appointment.provider_id).single(),
    db.from("locations").select("name").eq("id", appointment.location_id).single(),
    db.from("services").select("name").eq("id", appointment.service_id).single(),
  ]);
  if (providerError || locationError || serviceError) throw new Error("Unable to load provider, location, or service for notification");
  return {
    reference: String(appointment.reference),
    providerName: String(provider?.name || "WashCar"),
    locationName: String(location?.name || "Car wash"),
    serviceName: String(service?.name || "Car wash"),
    scheduledAt: String(appointment.scheduled_at),
    vehiclePlate: String(appointment.vehicle_plate),
  };
}

async function sendTelegram(chatId: string, text: string) {
  const token = process.env.TIER1_TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
  if (!response.ok || result.ok !== true) throw new Error(result.description || `Telegram returned HTTP ${response.status}`);
}

export async function processDueBookingNotifications(limit = 25): Promise<NotificationRunSummary> {
  const db = publicSupabaseClient();
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const { data, error } = await db.rpc("claim_due_booking_notifications", { p_limit: safeLimit });
  if (error) throw new Error(`Supabase notification claim failed: ${error.message}`);
  const claimed = (data || []) as ClaimedNotification[];
  const summary: NotificationRunSummary = { claimed: claimed.length, sent: 0, retried: 0, failed: 0, cancelled: 0 };

  for (const notification of claimed) {
    if (!notification.recipient_chat_id?.trim()) {
      await updateNotification(notification.id, { status: "cancelled", last_error: "Missing Telegram chat ID" });
      summary.cancelled += 1;
      continue;
    }
    try {
      const details = await loadDetails(notification.appointment_id);
      await sendTelegram(notification.recipient_chat_id, formatBookingNotification(notification.notification_type, details));
      await updateNotification(notification.id, { status: "sent", sent_at: new Date().toISOString(), last_error: null });
      summary.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Notification delivery failed";
      const finalAttempt = notification.attempts >= 4;
      await updateNotification(notification.id, finalAttempt
        ? { status: "failed", last_error: message.slice(0, 500) }
        : { status: "pending", scheduled_for: new Date(Date.now() + retryDelayMinutes(notification.attempts) * 60_000).toISOString(), last_error: message.slice(0, 500) });
      console.error("[booking-notifications] delivery_failed", { notificationId: notification.id, attempt: notification.attempts, finalAttempt });
      if (finalAttempt) summary.failed += 1;
      else summary.retried += 1;
    }
  }
  return summary;
}
