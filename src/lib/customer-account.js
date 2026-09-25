export function customerRecoveryRoute(urlValue) {
  const url = new URL(urlValue, 'https://washcar.my');
  return url.searchParams.has('customer_reset') ? '#/account/reset-password' : '';
}

export function groupCustomerBookings(bookings = [], now = new Date()) {
  const sorted = [...bookings].sort((a, b) => new Date(b.scheduled_at) - new Date(a.scheduled_at));
  const upcoming = sorted
    .filter(item => !['cancelled', 'completed', 'no_show'].includes(item.status) && new Date(item.scheduled_at) >= now)
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  const upcomingIds = new Set(upcoming.map(item => item.id));
  return { upcoming, history: sorted.filter(item => !upcomingIds.has(item.id)) };
}

export function normalizeCustomerProfile(profile, user) {
  return {
    user_id: user?.id || '',
    email: user?.email || '',
    name: profile?.name || '',
    phone: profile?.phone || '',
    preferences: profile?.preferences && typeof profile.preferences === 'object' ? profile.preferences : {},
  };
}
