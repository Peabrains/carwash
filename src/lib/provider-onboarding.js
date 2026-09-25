export const ONBOARDING_STEPS = Object.freeze([
  'business',
  'outlet',
  'hours',
  'bays',
  'services',
  'plan',
  'review',
]);

export function deriveProviderReadiness(input = {}) {
  const missing = [];
  if (!input.profile?.business_phone?.trim()) missing.push('business phone');
  if (!input.outlet?.address?.trim()) missing.push('outlet address');
  if (!input.hoursComplete) missing.push('operating hours');
  if (!input.bookingRulesComplete) missing.push('booking rules');
  if (Number(input.activeBays || 0) < 1) missing.push('active bay');
  if (Number(input.activeServices || 0) < 1) missing.push('active service');
  if (!input.plan?.id) missing.push('plan');

  const operationalReady = missing.length === 0;
  const marketplaceApproved = input.verification?.status === 'approved';
  if (!marketplaceApproved) missing.push('marketplace verification');

  return {
    operationalReady,
    marketplaceReady: operationalReady && marketplaceApproved,
    missing,
  };
}

export function nextOnboardingStep(progress = {}) {
  const completed = new Set(progress.completedSteps || []);
  return ONBOARDING_STEPS.find(step => step === 'review' || !completed.has(step)) || 'review';
}

export function canApplyPlanChange(input) {
  const effective = Number(input.targetRank) > Number(input.currentRank) ? 'immediate' : 'renewal';
  if (input.target.max_locations != null && Number(input.activeOutlets || 0) > Number(input.target.max_locations)) {
    return { allowed: false, reason: 'Remove outlets before choosing this plan.', effective };
  }
  if (input.target.max_staff != null && Number(input.activeStaff || 0) + Number(input.pendingInvites || 0) > Number(input.target.max_staff)) {
    return { allowed: false, reason: 'Remove staff or cancel pending invitations before choosing this plan.', effective };
  }
  if (input.target.max_monthly_bookings != null && Number(input.monthlyBookings || 0) > Number(input.target.max_monthly_bookings)) {
    return { allowed: false, reason: 'Your current billing-period bookings exceed this plan limit.', effective };
  }
  return { allowed: true, reason: '', effective };
}

export function formatPlanPrice(plan = {}) {
  if (plan.pilot_free) return 'Free during pilot';
  return `RM ${Number(plan.monthly_price_myr || 0).toFixed(2)}/month`;
}

export function buildOnboardingPresentation(input = {}) {
  const readiness = deriveProviderReadiness(input);
  return {
    currentStep: nextOnboardingStep({ completedSteps: input.onboarding?.completed_steps || [] }),
    readiness,
    plans: (input.plans || []).map(plan => ({ ...plan, priceLabel: formatPlanPrice(plan) })),
  };
}
