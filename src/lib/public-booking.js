const API = import.meta.env.VITE_PUBLIC_BOOKING_API_URL || 'https://carwash-bot.vercel.app/api/public';

async function request(path, options) {
  const response = await fetch(`${API}${path}`, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The booking service is unavailable.');
  return body;
}

export const loadCatalogue = () => request('/catalog');
export const searchAvailability = ({ date, time = '' }) => request(`/search?date=${encodeURIComponent(date)}&time=${encodeURIComponent(time)}`);
export const loadSlots = ({ providerId, locationId, serviceId, date }) => request(`/slots?provider_id=${encodeURIComponent(providerId)}&location_id=${encodeURIComponent(locationId)}&service_id=${encodeURIComponent(serviceId)}&date=${encodeURIComponent(date)}`);
export const createBooking = details => request('/book', { method: 'POST', body: JSON.stringify(details) });
export const manageBooking = details => request('/manage', { method: 'POST', body: JSON.stringify(details) });
