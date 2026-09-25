import { getSupabaseAccessToken } from './supabase.js';
import { authorizationHeaders } from './auth-flow.js';

const API = import.meta.env.VITE_PUBLIC_BOOKING_API_URL || 'https://carwash-bot.vercel.app/api/public';

async function request(path, options) {
  const accessToken = await getSupabaseAccessToken();
  const response = await fetch(`${API}${path}`, { ...options, headers: authorizationHeaders(accessToken) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The booking service is unavailable.');
  return body;
}

const privateScope = providerId => providerId ? `&provider=${encodeURIComponent(providerId)}&access=private` : '';
export const loadCatalogue = ({ privateProviderId = '' } = {}) => request(`/catalog?${privateProviderId ? `provider=${encodeURIComponent(privateProviderId)}&access=private` : ''}`);
export const searchAvailability = ({ date, time = '', privateProviderId = '' }) => request(`/search?date=${encodeURIComponent(date)}&time=${encodeURIComponent(time)}${privateScope(privateProviderId)}`);
export const loadSlots = ({ providerId, locationId, serviceId, date, privateAccess = false }) => request(`/slots?provider_id=${encodeURIComponent(providerId)}&location_id=${encodeURIComponent(locationId)}&service_id=${encodeURIComponent(serviceId)}&date=${encodeURIComponent(date)}${privateAccess ? '&access=private' : ''}`);
export const createBooking = details => request('/book', { method: 'POST', body: JSON.stringify(details) });
export const manageBooking = details => request('/manage', { method: 'POST', body: JSON.stringify(details) });
