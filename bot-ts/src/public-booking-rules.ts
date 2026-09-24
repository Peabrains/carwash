type BookingIdentity = {
  reference?: unknown;
  customer_phone?: unknown;
  customer_name?: unknown;
  vehicle_plate?: unknown;
};

type SuppliedIdentity = {
  reference: string;
  phone: string;
  name: string;
  vehiclePlate: string;
};

function normalizedPhone(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.startsWith("60") ? `0${digits.slice(2)}` : digits;
}

function normalizedText(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase();
}

function normalizedPlate(value: unknown) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLocaleUpperCase();
}

export function customerIdentityMatches(booking: BookingIdentity, supplied: SuppliedIdentity) {
  if (!normalizedPhone(supplied.phone) || normalizedPhone(booking.customer_phone) !== normalizedPhone(supplied.phone)) return false;
  if (supplied.reference.trim()) return String(booking.reference || "").trim() === supplied.reference.trim();
  return Boolean(
    normalizedText(supplied.name)
    && normalizedPlate(supplied.vehiclePlate)
    && normalizedText(booking.customer_name) === normalizedText(supplied.name)
    && normalizedPlate(booking.vehicle_plate) === normalizedPlate(supplied.vehiclePlate),
  );
}

export function canCustomerChangeBooking(
  booking: { status: string; scheduledAt: string; noticeMinutes: number },
  now = new Date(),
) {
  if (["cancelled", "completed", "no_show"].includes(booking.status)) {
    return { allowed: false, reason: "This booking can no longer be changed." };
  }
  const scheduledAt = new Date(booking.scheduledAt).getTime();
  const cutoff = now.getTime() + Math.max(0, booking.noticeMinutes) * 60_000;
  if (!Number.isFinite(scheduledAt) || scheduledAt <= cutoff) {
    return { allowed: false, reason: "This booking is too close to its appointment time to change online." };
  }
  return { allowed: true, reason: "" };
}
