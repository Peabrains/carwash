# Provider Self-Onboarding Design

## Goal

Allow a car-wash provider to register, configure one outlet, select a free pilot plan, and begin operating Docket without platform-owner intervention. Marketplace discovery remains gated by a separate SSM verification and manual approval process.

## Product Principles

- Provider registration and operational access are self-service.
- Operational access and marketplace visibility are independent.
- An unverified provider may run its business and accept real bookings through staff entry or a private booking link.
- Only marketplace-approved providers appear in public discovery and Telegram provider selection.
- Initial onboarding creates exactly one outlet. Additional outlets are managed later and constrained by the selected plan.
- All plans cost RM0 during the pilot, while plan limits and lifecycle behavior remain real.
- Payments, personal identity documents, and bank verification are deferred. Business SSM evidence and a storefront photo are collected only for marketplace review.

## Implemented State (September 2026)

- Supabase provides production authentication, database, row-level security, and storage.
- The staff application already supports provider profiles, locations, operating hours, booking rules, bays, services, staff invitations, plans, and platform administration.
- Providers can register, verify email, create their own workspace, and resume the setup wizard without platform intervention.
- Provider owners can select and change free-pilot plans; outlet, staff, invitation, and booking limits are enforced in the database.
- Staff can create walk-in, phone, WhatsApp, and other manual bookings through the same atomic availability rules used by customer channels.
- Public web and Telegram discovery share the approved-provider filter. Operational unapproved providers remain available through private provider links.
- Provider owners can submit private SSM/storefront evidence. Platform owners can approve, request changes, reject, apply marketplace-only suspension, or suspend all operations.
- Submission snapshots are immutable, stale versions cannot be approved, and verification decisions do not alter subscriptions.

## Account and Workspace Creation

The public website exposes a **Register your car wash** entry point. A provider owner creates an account with email and password and must verify the email before creating a business workspace.

A single secure Supabase operation creates:

- the provider;
- the authenticated user's active `owner` staff membership;
- one default outlet;
- default booking settings for that outlet;
- a provider-onboarding record;
- a selected free pilot subscription when plan selection is reached.

The operation validates the authenticated user, rejects an existing provider ownership, prevents duplicate SSM numbers, and commits all related rows together. A failure leaves no ownerless or partially created provider.

The provider begins as operationally private. Workspace access does not depend on SSM approval.

## Resumable Onboarding Wizard

Each completed step saves immediately. The onboarding record stores the current step and completion state so the owner can leave, use the dashboard, and resume later.

### Step 1: Business

- trading name;
- legal business name;
- SSM registration number;
- public description;
- business phone number.

The SSM number is required before marketplace review, but missing verification documents do not prevent private operation.

### Step 2: First outlet

- outlet name;
- full address;
- state;
- city;
- postcode;
- timezone, defaulting to `Asia/Kuala_Lumpur`.

Onboarding creates one outlet only.

### Step 3: Operating hours and rules

- opening and closing time for each day;
- closed-day support;
- minimum booking lead time;
- maximum advance-booking window;
- customer cancellation/rescheduling notice;
- bay buffer time.

### Step 4: Bays

At least one active bay is required for operational readiness.

### Step 5: Services

At least one active service with a name, positive duration, and non-negative price is required for operational readiness.

### Step 6: Plan

The provider selects an active plan. Every plan is labelled **Free during pilot** and has a monthly price of RM0, while outlet, staff, and monthly-booking limits are displayed and enforced.

### Step 7: Review

The final screen shows:

- operational-readiness checklist;
- outstanding marketplace-verification requirements;
- selected plan and usage limits;
- private booking link;
- **Enter dashboard** action;
- **Submit for marketplace review** action when eligible.

Providers may enter the dashboard before completing every step. Incomplete requirements remain visible and link back to the relevant wizard step.

## Operational Readiness

A provider is operationally ready when it has:

- a provider profile and business phone;
- one configured outlet and address;
- valid operating hours and booking rules;
- at least one active bay;
- at least one active service;
- an active pilot plan.

Operational readiness enables staff-created bookings and the private booking link. It does not enable marketplace discovery.

## Manual Provider Bookings

The staff dashboard gains a **New booking** action for walk-ins and offline requests. Owners, managers, and staff with booking permission can enter:

- customer name;
- phone number;
- optional customer email;
- number plate;
- make and model;
- service;
- date and time;
- optional bay selection, otherwise automatic assignment;
- source: `walk_in`, `phone`, `whatsapp`, or `other`;
- optional internal notes.

Manual bookings use the same server-side availability and atomic bay-allocation rules as web and Telegram bookings. They occupy capacity, appear on the bay board and history, contribute to analytics and plan usage, and cannot overlap another appointment.

When a signed-in customer identity or verified email can be matched safely, the booking may appear in that customer's account. Notification delivery occurs only when the booking contains a supported destination and the customer has consented to that channel.

## Private Booking Links

Every operationally ready provider receives an unlisted provider-specific booking URL. The provider may share it with real customers before marketplace approval.

The link exposes only that provider and its active locations/services. It does not imply Docket marketplace verification. The page displays a neutral notice that the provider is not yet marketplace verified.

A marketplace-only suspension removes public discovery but leaves private booking operational. A full operational suspension disables both private booking and marketplace discovery. A pending, rejected, or unsubmitted marketplace review does not disable private booking.

## Marketplace Verification

Marketplace verification requires:

- legal business name;
- unique SSM registration number;
- SSM document upload;
- storefront photo showing the business;
- operational readiness;
- acceptance of provider terms.

Verification statuses are:

- `not_submitted`;
- `pending_review`;
- `changes_requested`;
- `approved`;
- `rejected`;
- `suspended`.

The provider can submit once all requirements are present. Submission records the exact profile and document versions reviewed.

The platform-owner review screen shows the provider, owner email, outlet and contact details, services, hours, readiness checklist, SSM number, SSM document, storefront photo, submission time, and previous decisions. The platform owner can approve, request changes with a reason, reject with a reason, or suspend an approved provider.

Only `approved` providers are returned by public marketplace catalogue and Telegram provider-discovery queries. Approval does not alter plan access. Suspension removes marketplace visibility immediately and may separately disable operations when the platform owner chooses a full suspension.

## Verification Document Security

SSM documents and storefront verification photos are stored in a private Supabase Storage bucket.

- Provider owners may upload, replace, and read files for their own provider.
- Platform owners may read submitted files for review.
- Managers, workers, customers, anonymous users, and other providers receive no access.
- Signed URLs are short-lived and generated only after authorization.
- Replaced documents retain audit metadata but are not publicly addressable.
- IC/passport images and bank statements are not collected in this release.

## Pilot Plan Lifecycle

All active plans have RM0 pilot pricing. Plans still define:

- maximum active outlets;
- maximum active staff plus pending invitations;
- maximum bookings created during a subscription period.

Provider owners may change only their own subscription through a narrowly scoped server-side function.

- Upgrades take effect immediately and begin a new subscription period.
- Downgrades are scheduled for the next renewal date.
- Pending downgrades are visible and cancellable.
- A downgrade cannot take effect while current outlet or staff usage exceeds the destination plan.
- Every plan change is written to an immutable audit history.

The frontend may explain limits, but Supabase is the enforcement boundary. Adding an outlet, inviting staff, and creating a booking must validate the provider's active entitlement server-side.

Bookings are counted by creation time within the subscription period, regardless of appointment date or channel. Cancelled bookings continue to count. Records explicitly marked as platform test data do not count.

## Future Paid Billing Compatibility

The pilot models the future lifecycle without charging money. When paid billing is introduced:

- an upgrade activates only after successful payment;
- upgrading starts a new billing period using the checkout amount shown before confirmation;
- a downgrade remains pending until renewal;
- cancellation retains access until the paid period ends;
- failed payments leave the current entitlement unchanged;
- the provider can see current plan, usage, renewal date, pending changes, and invoices.

Payment-provider events and immutable invoice records will become the accounting source of truth. Historical invoice amounts will not change when catalogue prices are edited. Payment gateway selection and implementation are outside this release.

## Authorization and Data Boundaries

- Only an authenticated, email-verified user without an existing provider ownership may self-create a provider workspace.
- Provider owners can update their own onboarding, subscription selection, and verification submission.
- Managers and permitted workers can create manual bookings but cannot alter ownership, plans, or verification.
- Provider users cannot read or modify another provider's rows or documents.
- Platform owners can review and administer all provider verification states.
- Public and Telegram discovery use an approved-marketplace view or function rather than reading raw providers directly.
- User-editable authentication metadata is never used for authorization.
- Privileged setup and plan-change functions validate `auth.uid()` internally, revoke default `PUBLIC` execution, and grant only the required authenticated role.

## Failure Handling

- Workspace creation is atomic and safe to retry.
- Wizard steps retain previous successful saves after a later failure.
- Duplicate SSM numbers return a clear correction path without revealing another provider's private data.
- Upload failures do not submit an incomplete verification request.
- Concurrent manual and customer bookings cannot double-book a bay.
- Plan changes do not activate when validation or future payment fails.
- Marketplace approval cannot occur when required data was removed or changed after submission; the provider must resubmit the updated version.

## Existing Provider Compatibility

WashPoint and other existing providers retain their current staff access and operational data. A migration creates compatible onboarding, subscription, and verification records without changing marketplace visibility unexpectedly. Existing approved production providers are explicitly marked approved during migration; test providers remain private unless deliberately approved.

Existing management screens remain available after onboarding. The wizard writes through the same domain operations instead of maintaining a separate copy of provider configuration.

## Testing and Acceptance

### Signup and onboarding

- A new email-verified user can create exactly one provider workspace and become its owner.
- Retrying workspace creation does not duplicate providers, outlets, settings, or memberships.
- An existing provider owner cannot create an unrelated second provider through signup.
- Every wizard step saves and resumes correctly.
- A provider can enter the dashboard before marketplace verification.
- Existing provider accounts continue to work without re-registering.

### Security

- Provider A cannot read or mutate Provider B's business, subscription, verification, or storage objects.
- Anonymous and customer accounts cannot invoke provider setup functions.
- Managers and workers cannot change plan or verification state.
- Verification files cannot be fetched with permanent public URLs.
- Supabase security and performance advisors are run after migrations, with every new warning fixed before deployment.

### Plans and limits

- Owners can select and change only their own active pilot plan.
- Immediate upgrades, pending downgrades, downgrade cancellation, and renewal application behave deterministically.
- Outlet, staff/invitation, and booking limits are enforced server-side under concurrent requests.
- Downgrades below current usage do not activate.
- Pilot plan changes create no payment charge.

### Operations

- Manual bookings support every approved source value and appear on the bay board, history, and analytics.
- Automatic and selected bay assignment reject unavailable slots atomically.
- The private booking link accepts real bookings for an operationally ready, unapproved provider.
- A suspended provider cannot receive bookings when operations are suspended.

### Marketplace

- Unapproved providers never appear in public web or Telegram discovery.
- Incomplete providers cannot submit for review.
- Updating reviewed details invalidates the old submission where appropriate.
- Approval exposes the provider without changing its subscription.
- Changes requested, rejection, and suspension remove or preserve visibility according to their defined states.

### Experience

- The onboarding wizard works on mobile and desktop layouts.
- Every incomplete requirement links to the correct step.
- Plan cards clearly say **Free during pilot** and do not imply permanent free pricing.
- The provider always sees whether it is operationally ready, privately bookable, and marketplace approved as three separate states.

## Rollout

1. Add schema, private storage, authorization functions, and compatibility records without changing existing discovery behavior.
2. Deploy self-registration and the resumable wizard behind a feature flag.
3. Deploy manual bookings and private provider links.
4. Switch public web and Telegram discovery to the approved-provider query.
5. Verify existing WashPoint visibility and full booking flows.
6. Enable provider self-registration publicly.
7. Monitor signup failures, onboarding completion, manual-booking failures, document access denials, and approval-state changes.

## Out of Scope

- Real payment collection, refunds, taxes, or gateway integration;
- automated SSM registry verification;
- automatic marketplace approval;
- IC/passport, beneficial-owner, or bank-account verification;
- multiple outlets during initial onboarding;
- usage-based overage charges;
- WhatsApp notification delivery;
- production catalogue cleanup and the final WashPoint pilot.
