import test from 'node:test';
import assert from 'node:assert/strict';
import { customerRecoveryRoute, groupCustomerBookings, normalizeCustomerProfile } from '../src/lib/customer-account.js';

test('recovery callback routes to the customer password screen', () => {
  assert.equal(customerRecoveryRoute('https://washcar.my/?customer_reset=1'), '#/account/reset-password');
  assert.equal(customerRecoveryRoute('https://washcar.my/'), '');
});

test('groups future active bookings separately from history', () => {
  const now = new Date('2026-09-25T00:00:00Z');
  const grouped = groupCustomerBookings([
    { id: 'future', status: 'confirmed', scheduled_at: '2026-09-26T00:00:00Z' },
    { id: 'past', status: 'completed', scheduled_at: '2026-09-24T00:00:00Z' },
    { id: 'cancelled', status: 'cancelled', scheduled_at: '2026-09-27T00:00:00Z' },
  ], now);
  assert.deepEqual(grouped.upcoming.map(item => item.id), ['future']);
  assert.deepEqual(grouped.history.map(item => item.id), ['cancelled', 'past']);
});

test('profile defaults safely when no row exists yet', () => {
  assert.deepEqual(normalizeCustomerProfile(null, { id: 'u1', email: 'aina@example.com' }), {
    user_id: 'u1', email: 'aina@example.com', name: '', phone: '', preferences: {},
  });
});
