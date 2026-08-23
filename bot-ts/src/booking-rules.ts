export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

export function bookingIntervalsOverlap(
  candidateStart: number,
  candidateEnd: number,
  existingStart: number,
  existingEnd: number,
  bufferMinutes: number,
) {
  const bufferMs = Math.max(0, bufferMinutes) * 60_000;
  return intervalsOverlap(candidateStart, candidateEnd + bufferMs, existingStart, existingEnd + bufferMs);
}

export function isDateBookable(dateIso: string, todayIso: string, maxAdvanceDays: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso) || dateIso < todayIso) return false;
  const latest = new Date(`${todayIso}T12:00:00Z`);
  latest.setUTCDate(latest.getUTCDate() + Math.max(0, maxAdvanceDays));
  return dateIso <= latest.toISOString().slice(0, 10);
}
