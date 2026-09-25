# Provider Self-Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a provider securely self-register, configure one outlet, operate privately, select a free pilot plan, create manual bookings, and submit SSM evidence for marketplace approval.

**Architecture:** Supabase owns provider creation, tenant authorization, onboarding progress, plan entitlements, verification records, and private document access. The Vite frontend adds focused provider-registration, onboarding, plan, manual-booking, and platform-review routes while reusing existing management operations. Vercel public APIs and Telegram query only marketplace-approved providers, while provider-specific private links use a separate operational-readiness check.

**Tech Stack:** Vite 5, JavaScript ES modules, Node test runner, Supabase Auth/Postgres/RLS/Storage, TypeScript Vercel APIs, Telegram bot, GitHub Pages, Vercel.

**Spec:** `docs/superpowers/specs/2026-09-25-provider-self-onboarding-design.md`

## Global Constraints

- Provider registration and operational access are self-service; marketplace visibility is separately approved.
- Initial onboarding creates exactly one outlet.
- Unapproved operational providers may accept real manual and private-link bookings but never appear in public marketplace or Telegram discovery.
- Every active pilot plan costs RM0 and must be labelled **Free during pilot**.
- Supabase, not frontend visibility, enforces provider ownership and plan limits.
- SSM documents and storefront verification photos remain private.
- Do not collect IC/passport or bank-statement documents.
- Do not implement a real payment gateway.
- Existing WashPoint access, visibility, bookings, and staff flows must remain unchanged.
- Create every migration with `npx supabase migration new <name>` through the Account B workspace wrapper before editing the generated file.

## Review Focus

- A verified user double-submits workspace creation: exactly one provider, owner membership, outlet, settings row, and onboarding row must exist.
- Two providers choose names that normalize to the same slug: creation must return a recoverable conflict without exposing the other provider.
- A provider changes reviewed business data after submitting verification: the previous submission must no longer be approvable.
- A pending staff invitation plus active staff reaches the plan limit: another invitation must fail server-side.
- A provider reaches its monthly booking limit through simultaneous public and manual requests: only requests within the entitlement may commit.

---

## File Structure

- `src/lib/provider-onboarding.js`: pure onboarding readiness, step order, plan-change, and display helpers.
- `src/lib/api-supabase.js`: browser calls to authenticated onboarding, plan, verification, and staff manual-booking database/API boundaries.
- `src/lib/supabase.js`: provider-owner signup helpers and session handling.
- `src/main.js`: provider registration, onboarding wizard, manual-booking modal, private-link route, and platform review UI wiring.
- `src/style.css`: responsive onboarding, readiness, plan, manual-booking, and review presentation.
- `bot-ts/src/provider-catalog.ts`: one shared marketplace-provider query contract for Telegram.
- `bot-ts/src/public-provider-access.ts`: marketplace and private-link visibility decisions for public APIs.
- `bot-ts/api/public/catalog.ts`, `search.ts`, `slots.ts`, `book.ts`: approved marketplace and private-provider request enforcement.
- `bot-ts/api/appointments.ts`: authenticated manual-booking endpoint reusing atomic reservation.
- Generated Supabase migration `*_provider_self_onboarding.sql`: schema, storage bucket, RLS, RPCs, triggers, compatibility backfill, and grants.
- `supabase/tests/provider_self_onboarding.sql`: database authorization, idempotency, visibility, plan-limit, and storage-policy assertions.
- `test/provider-onboarding.test.js`: frontend domain-helper tests.
- `bot-ts/test/provider-onboarding.test.ts`: API catalogue/private-link/manual-booking tests.

---

### Task 1: Onboarding domain model and readiness helpers

**Files:**
- Create: `src/lib/provider-onboarding.js`
- Create: `test/provider-onboarding.test.js`

**Interfaces:**
- Produces: `ONBOARDING_STEPS`, `deriveProviderReadiness(input)`, `nextOnboardingStep(progress)`, `canApplyPlanChange(input)`, and `formatPlanPrice(plan)`.
- `deriveProviderReadiness` returns `{ operationalReady, marketplaceReady, missing: string[] }`.
- `canApplyPlanChange` returns `{ allowed, reason, effective: 'immediate'|'renewal' }`.

- [ ] **Step 1: Write failing helper tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProviderReadiness, canApplyPlanChange, formatPlanPrice } from '../src/lib/provider-onboarding.js';

test('operational readiness does not require marketplace approval', () => {
  const result = deriveProviderReadiness({
    profile: { business_phone: '0123456789' }, outlet: { address: 'Miri' },
    hoursComplete: true, bookingRulesComplete: true, activeBays: 1,
    activeServices: 1, plan: { id: 'starter' }, verification: { status: 'not_submitted' },
  });
  assert.equal(result.operationalReady, true);
  assert.equal(result.marketplaceReady, false);
});

test('pending staff invitations count against a downgrade', () => {
  assert.deepEqual(canApplyPlanChange({ currentRank: 2, targetRank: 1, activeOutlets: 1, activeStaff: 2, pendingInvites: 1, target: { max_locations: 1, max_staff: 2 } }), {
    allowed: false, reason: 'Remove staff or cancel pending invitations before choosing this plan.', effective: 'renewal',
  });
});

test('pilot plans are never presented as permanently free', () => {
  assert.equal(formatPlanPrice({ monthly_price_myr: 0, pilot_free: true }), 'Free during pilot');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/provider-onboarding.test.js`

Expected: FAIL because `src/lib/provider-onboarding.js` does not exist.

- [ ] **Step 3: Implement the pure helpers**

Use literal required keys and deterministic plan-change rules. Do not read the DOM, Supabase, or current time from this module.

- [ ] **Step 4: Run the focused and complete frontend suites**

Run: `node --test test/provider-onboarding.test.js && node --test test/*.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/provider-onboarding.js test/provider-onboarding.test.js
git commit -m "test: define provider onboarding rules"
```

---

### Task 2: Secure Supabase schema and atomic workspace creation

**Files:**
- Create through CLI, then modify: `supabase/migrations/*_provider_self_onboarding.sql`
- Create: `supabase/tests/provider_self_onboarding.sql`
- Modify: `supabase/platform-admin.sql`
- Modify: `supabase/provider-operations.sql`

**Interfaces:**
- Produces RPC `public.create_provider_workspace(p_trading_name text, p_legal_name text, p_ssm_number text, p_business_phone text)` returning `provider_id`, `location_id`, and `onboarding_status`.
- Produces RPC `public.get_provider_onboarding()` returning the signed-in owner's provider, outlet, progress, subscription, usage, and verification summary.
- Produces tables/columns for legal profile, onboarding progress, verification submissions, and plan-change audit.

- [ ] **Step 1: Create the migration with the configured Account B wrapper**

Run:

```bash
node /Users/qingdekueh/github/.tools/supabase-workspace/supabase-workspace.mjs run carwash -- npx supabase migration new provider_self_onboarding
```

Expected: Supabase prints the generated migration path. Use that exact file for every SQL change in this task.

- [ ] **Step 2: Write failing pgTAP coverage first**

Add tests proving:

```sql
select has_function('public', 'create_provider_workspace', array['text','text','text','text']);
select has_table('public', 'provider_verifications');
select has_table('public', 'provider_plan_changes');
select col_is_unique('public', 'provider_profiles', 'ssm_number');
select policies_are('public', 'provider_verifications', array[
  'provider_verifications_owner_select',
  'provider_verifications_owner_insert',
  'provider_verifications_platform_update'
]);
```

Include transaction tests that set JWT claims for: anonymous, a new verified user, the resulting owner, a second provider owner, a manager, and the platform owner. Assert the five Review Focus cases owned by the database.

- [ ] **Step 3: Run database tests and verify RED**

Run the project workspace database test command used by the existing Supabase test suite against Account B.

Expected: FAIL on missing tables/functions/policies, not connection or syntax errors.

- [ ] **Step 4: Add schema and constraints**

Create or extend:

```sql
create table public.provider_profiles (
  provider_id text primary key references public.providers(id) on delete cascade,
  legal_name text not null,
  ssm_number text not null unique,
  business_phone text not null,
  marketplace_status text not null default 'not_submitted'
    check (marketplace_status in ('not_submitted','pending_review','changes_requested','approved','rejected','suspended')),
  operations_suspended boolean not null default false,
  reviewed_version integer,
  updated_at timestamptz not null default now()
);

alter table public.provider_onboarding
  add column if not exists current_step text not null default 'business',
  add column if not exists completed_steps text[] not null default '{}',
  add column if not exists completed_at timestamptz;

alter table public.subscription_plans
  add column if not exists pilot_free boolean not null default true,
  add column if not exists display_rank integer not null default 0;

alter table public.provider_subscriptions
  add column if not exists pending_plan_id text references public.subscription_plans(id),
  add column if not exists pending_effective_at timestamptz,
  add column if not exists payment_provider text not null default 'pilot_free';
```

Create `provider_verifications` with immutable submission version, document paths, submitted snapshot, decision, reason, submitter/reviewer IDs, and timestamps. Create `provider_plan_changes` with old/new plan, effective timing, status, actor, and created/applied timestamps.

- [ ] **Step 5: Implement atomic workspace creation**

Use `SECURITY DEFINER`, `SET search_path = ''`, fully qualified names, and internal `auth.uid()`/email-verification checks. Generate collision-resistant provider/location IDs, insert all rows in one transaction, and return the existing workspace on an idempotent retry by the same user. Reject duplicate normalized SSM numbers without returning the conflicting provider ID.

Revoke execution from `PUBLIC` and `anon`; grant only to `authenticated`.

- [ ] **Step 6: Add tenant RLS and private Storage policies**

Create private bucket `provider-verification`. Store objects under `<provider_id>/<verification_id>/<kind>`. Policies must derive provider ownership from `staff.id = auth.uid()` and platform access from the `platform_owner` role; never trust object metadata or `user_metadata` for authorization.

- [ ] **Step 7: Backfill existing providers explicitly**

Create onboarding/subscription/profile rows for existing providers. Preserve WashPoint's current public visibility by setting its marketplace state to `approved`; leave known test providers `not_submitted`. The migration must not infer approval from every `providers.status = 'active'` row.

- [ ] **Step 8: Run SQL tests and advisors**

Run the Supabase SQL suite, then security and performance advisors. Expected: tests PASS and no new warning attributable to this migration.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations supabase/tests/provider_self_onboarding.sql supabase/platform-admin.sql supabase/provider-operations.sql
git commit -m "feat: add secure provider onboarding schema"
```

---

### Task 3: Provider registration and resumable onboarding API

**Files:**
- Modify: `src/lib/supabase.js`
- Modify: `src/lib/api-supabase.js`
- Modify: `test/provider-onboarding.test.js`

**Interfaces:**
- Produces `signUpProviderOwner({ email, password })`.
- Produces `createProviderWorkspace({ tradingName, legalName, ssmNumber, businessPhone })`.
- Produces `getProviderOnboarding()`, `saveProviderOnboardingStep(step, values)`, and `completeProviderOnboarding()`.
- Consumes Task 2 RPCs and Task 1 readiness helpers.

- [ ] **Step 1: Add failing validation and payload tests**

Test normalized email, required verified session, SSM format preservation, one-outlet payload, and that step saves accept only the fields owned by that step. A test must prove a provider cannot pass `provider_id` to change the target tenant.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/provider-onboarding.test.js`

Expected: FAIL on missing exported functions.

- [ ] **Step 3: Implement registration and RPC wrappers**

Use Supabase Auth email signup with redirect back to `#/provider/onboarding`. After verification, obtain the current user from Supabase, then invoke workspace creation. Never create provider/staff/location rows directly from browser inserts.

- [ ] **Step 4: Implement allow-listed step saves**

Map each step to explicit fields. Reject unknown step names and omit `provider_id`, role, marketplace state, subscription status, and reviewer fields from browser-controlled payloads.

- [ ] **Step 5: Run frontend tests and build**

Run: `node --test test/*.test.js && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/supabase.js src/lib/api-supabase.js test/provider-onboarding.test.js
git commit -m "feat: add provider onboarding client API"
```

---

### Task 4: Registration and mobile onboarding wizard UI

**Files:**
- Modify: `src/main.js`
- Modify: `src/style.css`
- Modify: `test/provider-onboarding.test.js`

**Interfaces:**
- Produces routes `#/provider/register` and `#/provider/onboarding`.
- Consumes Task 3 API and Task 1 helpers.

- [ ] **Step 1: Add failing presentation-model tests**

Test that an incomplete provider receives the first missing step, marketplace approval is absent from operational readiness, and every plan with `pilot_free` displays `Free during pilot`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/provider-onboarding.test.js`

- [ ] **Step 3: Add public registration entry and email verification state**

Add **Register your car wash** to the public landing page. The registration screen must explain that email verification is required, payments are not collected during the pilot, and marketplace listing requires later SSM review.

- [ ] **Step 4: Build the seven-step wizard**

Render Business, First outlet, Hours and rules, Bays, Services, Plan, and Review. Each Next action saves only the current step. Include Back, Save and leave, completion indicator, retry state, and links from missing review items to their owning step.

- [ ] **Step 5: Add dashboard readiness banner**

Show three independent states: operational readiness, private booking availability, and marketplace approval. Do not force completed providers back into the wizard.

- [ ] **Step 6: Add responsive styles**

At widths below 720px, use one-column fields, sticky primary action, full-width plan cards, and readable progress labels. Avoid horizontal scrolling at 360px.

- [ ] **Step 7: Verify locally**

Run: `node --test test/*.test.js && npm run build`

Manually inspect 360×800 and desktop layouts. Verify refresh resumes the saved step and existing WashPoint login still opens its board.

- [ ] **Step 8: Commit**

```bash
git add src/main.js src/style.css test/provider-onboarding.test.js
git commit -m "feat: add provider onboarding wizard"
```

---

### Task 5: Free pilot plan switching and server-side entitlements

**Files:**
- Create through CLI, then modify: `supabase/migrations/*_provider_plan_entitlements.sql`
- Modify: `supabase/tests/provider_self_onboarding.sql`
- Modify: `src/lib/api-supabase.js`
- Modify: `src/main.js`

**Interfaces:**
- Produces RPC `public.change_provider_plan(p_plan_id text)` returning current plan, pending plan, effective date, and usage.
- Produces private entitlement checks used by location creation, staff invitation, and booking reservation.
- Produces `changeProviderPlan(planId)` in the browser API.

- [ ] **Step 1: Create the migration through the Account B wrapper**

Run the same wrapper with `npx supabase migration new provider_plan_entitlements` and edit only the generated file.

- [ ] **Step 2: Add failing SQL tests**

Cover immediate upgrade, scheduled downgrade, cancellation of pending downgrade, another-provider denial, inactive-plan denial, outlet limit, active-plus-pending staff limit, monthly booking boundary, and two concurrent final-slot booking attempts.

- [ ] **Step 3: Run SQL tests and verify RED**

Expected: missing RPC/check failures.

- [ ] **Step 4: Implement secure plan changes**

Order plans by `display_rank`, not price. Upgrades set the new plan and reset `current_period_start/current_period_end`; downgrades populate pending fields. RM0 pilot changes create audit rows with amount zero and no mock checkout/payment event.

- [ ] **Step 5: Enforce limits at write boundaries**

Call entitlement checks inside the same transaction as outlet creation, staff invitation, and atomic booking reservation. Count pending invitations. Count appointments by `created_at` inside the subscription period and exclude only `is_test = true` records created by a platform owner.

- [ ] **Step 6: Replace mock checkout UI with pilot plan management**

Show current usage, limits, renewal date, pending downgrade, change confirmation, and cancel-pending action. Keep platform plan editing restricted to the platform owner.

- [ ] **Step 7: Run tests, build, and advisors**

Run frontend tests, bot tests, build, SQL tests, and Supabase advisors. Expected: PASS with no new advisor findings.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations supabase/tests/provider_self_onboarding.sql src/lib/api-supabase.js src/main.js
git commit -m "feat: enforce free pilot plan limits"
```

---

### Task 6: Atomic manual bookings from the staff dashboard

**Files:**
- Create: `bot-ts/src/manual-booking.ts`
- Modify: `bot-ts/api/appointments.ts`
- Create: `bot-ts/test/manual-booking.test.ts`
- Modify: `src/lib/api-supabase.js`
- Modify: `src/main.js`
- Modify: `src/style.css`

**Interfaces:**
- Produces `createManualBooking(input, actor)` with source union `walk_in|phone|whatsapp|other`.
- Consumes existing `reserve_appointment_atomic` and Task 5 booking entitlement check.
- Produces browser API `createStaffBooking(details)`.

- [ ] **Step 1: Write failing API tests**

Test required customer/vehicle/service/date/time fields, allowed sources, unauthorized role, cross-provider IDs, automatic bay assignment, requested unavailable bay, duplicate request ID, and monthly-limit rejection.

- [ ] **Step 2: Run bot test and verify RED**

Run: `npm --prefix bot-ts test -- manual-booking.test.ts`

- [ ] **Step 3: Implement the manual-booking service**

Resolve the actor from the authenticated token, ignore client-supplied provider ownership, validate location/service/bay against the actor's tenant, generate an idempotent request ID and reference, then call the existing atomic reservation function with the selected source and notes.

- [ ] **Step 4: Add the authenticated endpoint**

Return `201` with booking/reference on success, `409` for an unavailable slot or limit, `403` for role/tenant violations, and `422` for validation failures. Do not log full phone numbers.

- [ ] **Step 5: Add the dashboard form**

Add **New booking** to the bay board. Load active services, available slots, and bays; default to automatic bay assignment. After success, close the form, refresh the board, and show the reference.

- [ ] **Step 6: Run all tests and build**

Run: `npm --prefix bot-ts test && npm --prefix bot-ts run typecheck && node --test test/*.test.js && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bot-ts/src/manual-booking.ts bot-ts/api/appointments.ts bot-ts/test/manual-booking.test.ts src/lib/api-supabase.js src/main.js src/style.css
git commit -m "feat: add staff manual bookings"
```

---

### Task 7: Separate marketplace discovery from private provider booking

**Files:**
- Create: `bot-ts/src/public-provider-access.ts`
- Modify: `bot-ts/src/tier1-flow.ts`
- Modify: `bot-ts/api/public/catalog.ts`
- Modify: `bot-ts/api/public/search.ts`
- Modify: `bot-ts/api/public/slots.ts`
- Modify: `bot-ts/api/public/book.ts`
- Modify: `bot-ts/test/provider-catalog.test.ts`
- Create: `bot-ts/test/public-provider-access.test.ts`
- Modify: `src/lib/public-booking.js`
- Modify: `src/main.js`

**Interfaces:**
- Produces `listMarketplaceProviders(db)` and `assertPrivateProviderBookable(db, providerId)`.
- Produces private route `#/book/:providerId` and public API query/header `provider=<id>&access=private` without exposing a reusable secret.

- [ ] **Step 1: Write failing discovery/access tests**

Test that approved providers appear publicly, pending/rejected/suspended providers do not, operational unapproved providers work through their private link, operations-suspended providers fail closed, and Telegram uses the same approved set as web discovery.

- [ ] **Step 2: Run focused bot tests and verify RED**

Run: `npm --prefix bot-ts test -- provider-catalog.test.ts public-provider-access.test.ts`

- [ ] **Step 3: Implement shared provider-access queries**

Marketplace access requires active provider, approved marketplace status, operational readiness, and no operational suspension. Private access requires active provider, operational readiness, and no operational suspension but not marketplace approval.

- [ ] **Step 4: Update all public endpoints**

Catalogue/search without a provider scope return approved marketplace records only. Provider-scoped slots/book validate private access. Booking revalidates access server-side immediately before atomic reservation.

- [ ] **Step 5: Update Telegram**

Replace direct `providers.status = 'active'` reads with `listMarketplaceProviders`. Preserve the current provider-selection conversation and test ordering.

- [ ] **Step 6: Add the private booking page**

The provider-specific route displays only that provider, includes a neutral **Not yet marketplace verified** notice when applicable, and never offers navigation into general marketplace results using unapproved catalogue data.

- [ ] **Step 7: Run all tests and build**

Run: `npm --prefix bot-ts test && npm --prefix bot-ts run typecheck && node --test test/*.test.js && npm run build`

- [ ] **Step 8: Commit**

```bash
git add bot-ts/src/public-provider-access.ts bot-ts/src/tier1-flow.ts bot-ts/api/public bot-ts/test src/lib/public-booking.js src/main.js
git commit -m "feat: gate marketplace provider discovery"
```

---

### Task 8: Verification submission and platform review

**Files:**
- Modify: `src/lib/api-supabase.js`
- Modify: `src/main.js`
- Modify: `src/style.css`
- Modify: `test/provider-onboarding.test.js`
- Modify: `supabase/tests/provider_self_onboarding.sql`

**Interfaces:**
- Produces `uploadProviderVerificationFile(kind, file)`, `submitProviderVerification()`, `getProviderVerification()`, and platform-only `decideProviderVerification({ verificationId, decision, reason, suspendOperations })`.
- Consumes Task 2 private bucket and verification tables.

- [ ] **Step 1: Add failing state-transition tests**

Test incomplete submission rejection, owner-only upload, platform-only decision, required reason for changes/rejection, immutable submitted snapshot, stale-version approval rejection, approval visibility, marketplace-only suspension, and full operational suspension.

- [ ] **Step 2: Run frontend and SQL tests and verify RED**

Expected: missing transition/API behavior.

- [ ] **Step 3: Implement signed upload and submission APIs**

Allow PDF/JPEG/PNG only, enforce a documented size limit, generate server-owned storage paths, and save document metadata after successful upload. Submission must atomically snapshot the reviewed profile/configuration version.

- [ ] **Step 4: Add provider verification UI**

Show requirements, uploads, current status, submitted date, decision reason, and resubmit action. Do not expose raw storage paths.

- [ ] **Step 5: Extend platform administration**

Add a review queue and detail screen with time-limited document links, readiness data, previous decisions, and approve/request changes/reject/suspend actions. Require a typed reason for every non-approval decision.

- [ ] **Step 6: Verify state-driven discovery**

Use SQL/API tests to prove approval adds the provider to web/Telegram discovery and changes/rejection/suspension removes it without altering the subscription.

- [ ] **Step 7: Run tests, build, and advisors**

Run all frontend, bot, SQL, typecheck, build, and Supabase advisor gates.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api-supabase.js src/main.js src/style.css test/provider-onboarding.test.js supabase/tests/provider_self_onboarding.sql
git commit -m "feat: add provider marketplace verification"
```

---

### Task 9: Production migration, end-to-end verification, and documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-25-provider-self-onboarding-design.md` only if implementation discoveries require a clarified factual note

**Interfaces:**
- Consumes all earlier tasks.
- Produces a verified production release and an operator checklist for reviewing providers.

- [ ] **Step 1: Run the complete local gate**

Run:

```bash
node --test test/*.test.js
npm --prefix bot-ts test
npm --prefix bot-ts run typecheck
npm run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Apply migrations to Account B**

Use the Supabase workspace wrapper for the `carwash` profile. Confirm the project reference before pushing migrations. Verify migration history afterward.

- [ ] **Step 3: Run database proof and advisors against production**

Run `supabase/tests/provider_self_onboarding.sql`, security advisor, and performance advisor. Fix every new finding before continuing.

- [ ] **Step 4: Execute a fresh-provider production smoke test**

Use a dedicated test email and mark the resulting provider/test appointments as test data. Verify signup, email verification, interrupted wizard resume, plan selection, manual booking, private booking, and cross-provider denial. Do not approve it yet.

- [ ] **Step 5: Verify marketplace isolation**

Confirm the test provider is absent from public web and Telegram discovery, then submit evidence, approve it as platform owner, and confirm it appears in both. Suspend marketplace visibility and confirm it disappears while the private link remains operational. Finally apply full operational suspension and confirm booking is rejected.

- [ ] **Step 6: Verify WashPoint compatibility**

Confirm WashPoint remains discoverable, web and Telegram bookings load, the staff board opens, and existing staff permissions remain intact.

- [ ] **Step 7: Document operator workflow**

Add concise README sections for provider registration, marketplace review criteria, marketplace-only suspension versus full suspension, free pilot plans, and later payment integration boundary.

- [ ] **Step 8: Commit and push**

```bash
git add README.md docs/superpowers/specs/2026-09-25-provider-self-onboarding-design.md
git commit -m "docs: add provider onboarding operations guide"
git push origin master
```

- [ ] **Step 9: Verify deployments**

Wait for GitHub Pages and Vercel deployments. Re-run the public health check, one marketplace catalogue request, one private-provider catalogue request, Telegram `/start`, and browser console-error inspection.

Expected: production reflects the committed build, health is green, and no new browser/server errors appear.
