export const MANUAL_BOOKING_SOURCES = ["walk_in", "phone", "whatsapp", "other"] as const;
export type ManualBookingSource = typeof MANUAL_BOOKING_SOURCES[number];

export type ManualBookingInput = {
  requestId: string;
  providerId: string;
  locationId: string;
  customerName: string;
  customerPhone: string;
  vehiclePlate: string;
  vehicleMakeModel: string;
  serviceId: string;
  dateIso: string;
  time24h: string;
  source: ManualBookingSource;
  requestedBayId?: string;
};

export type ManualBookingActor = {
  id: string;
  role: string;
  providerId: string | null;
  locationId: string | null;
};

type ReservationResult = { status: "created" | "existing" | "unavailable"; reference: string };
type Dependencies = {
  reserve(input: ManualBookingInput): Promise<ReservationResult>;
  canUseRequestedBay(input: ManualBookingInput): Promise<boolean>;
};

export async function createManualBooking(input: ManualBookingInput, actor: ManualBookingActor, dependencies: Dependencies) {
  if (!actor.id || !["owner", "manager", "platform_owner"].includes(actor.role)) throw new Error("You do not have permission to create manual bookings.");
  if (actor.role !== "platform_owner" && actor.providerId !== input.providerId) throw new Error("You can only create bookings for your own provider.");
  if (actor.locationId && actor.locationId !== input.locationId) throw new Error("You can only create bookings for your assigned outlet.");
  if (!input.requestId.trim()) throw new Error("A request ID is required.");
  if (!input.customerName.trim()) throw new Error("Customer name is required.");
  if (!input.customerPhone.trim()) throw new Error("Customer phone is required.");
  if (!input.vehiclePlate.trim()) throw new Error("Vehicle plate is required.");
  if (!input.vehicleMakeModel.trim()) throw new Error("Vehicle make and model are required.");
  if (!input.serviceId || !/^\d{4}-\d{2}-\d{2}$/.test(input.dateIso) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time24h)) throw new Error("Choose a valid service, date and time.");
  if (!MANUAL_BOOKING_SOURCES.includes(input.source)) throw new Error("Choose a valid booking source.");
  if (input.requestedBayId && !await dependencies.canUseRequestedBay(input)) throw new Error("The requested bay is unavailable.");
  return dependencies.reserve(input);
}
