import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ONBOARDING_STEPS,
  deriveProviderReadiness,
  nextOnboardingStep,
  canApplyPlanChange,
  formatPlanPrice,
} from '../src/lib/provider-onboarding.js';

test('operational readiness does not require marketplace approval', () => {
  const result = deriveProviderReadiness({
    profile: { business_phone: '0123456789' },
    outlet: { address: 'Miri' },
    hoursComplete: true,
    bookingRulesComplete: true,
    activeBays: 1,
    activeServices: 1,
    plan: { id: 'starter' },
    verification: { status: 'not_submitted' },
  });

  assert.deepEqual(result, {
    operationalReady: true,
    marketplaceReady: false,
    missing: ['marketplace verification'],
  });
});

test('readiness lists every missing operational requirement', () => {
  assert.deepEqual(deriveProviderReadiness({}), {
    operationalReady: false,
    marketplaceReady: false,
    missing: ['business phone', 'outlet address', 'operating hours', 'booking rules', 'active bay', 'active service', 'plan', 'marketplace verification'],
  });
});

test('onboarding resumes at the first incomplete step', () => {
  assert.deepEqual(ONBOARDING_STEPS, ['business', 'outlet', 'hours', 'bays', 'services', 'plan', 'review']);
  assert.equal(nextOnboardingStep({ completedSteps: ['business', 'outlet'] }), 'hours');
  assert.equal(nextOnboardingStep({ completedSteps: ONBOARDING_STEPS }), 'review');
});

test('pending staff invitations count against a downgrade', () => {
  assert.deepEqual(canApplyPlanChange({
    currentRank: 2,
    targetRank: 1,
    activeOutlets: 1,
    activeStaff: 2,
    pendingInvites: 1,
    monthlyBookings: 0,
    target: { max_locations: 1, max_staff: 2, max_monthly_bookings: 100 },
  }), {
    allowed: false,
    reason: 'Remove staff or cancel pending invitations before choosing this plan.',
    effective: 'renewal',
  });
});

test('upgrades take effect immediately', () => {
  assert.deepEqual(canApplyPlanChange({
    currentRank: 1,
    targetRank: 2,
    activeOutlets: 1,
    activeStaff: 2,
    pendingInvites: 0,
    monthlyBookings: 10,
    target: { max_locations: 5, max_staff: 30, max_monthly_bookings: 2500 },
  }), { allowed: true, reason: '', effective: 'immediate' });
});

test('pilot plans are never presented as permanently free', () => {
  assert.equal(formatPlanPrice({ monthly_price_myr: 0, pilot_free: true }), 'Free during pilot');
  assert.equal(formatPlanPrice({ monthly_price_myr: 49, pilot_free: false }), 'RM 49.00/month');
});
