export function vehicleLabel(appointment = {}) {
  return [appointment.vehicle_plate, appointment.vehicle_make_model]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' · ') || '—';
}
