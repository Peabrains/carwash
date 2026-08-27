import './style.css';
import * as api from './lib/api.js';
import { createBooking, loadCatalogue, loadSlots, manageBooking, searchAvailability } from './lib/public-booking.js';

// The generated registerSW.js only calls navigator.serviceWorker.register()
// with no update-detection at all, so a new deploy's service worker sits
// "waiting" indefinitely and open/revisited tabs keep serving old cached
// content — registerType: 'autoUpdate' in vite.config.js does nothing on
// its own without this. This forces an update check and reloads once a
// new version is actually found, so every deploy takes effect on next
// visit instead of requiring a manual cache clear.
if ('serviceWorker' in navigator) {
  // Remove service workers created by older builds so stale authentication
  // code cannot keep intercepting the login page after a deployment.
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(registration => registration.unregister());
  });
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}

const app = document.getElementById('app');
const state = { staff: null, tenants: { providers: [], locations: [] } };
const h = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const formatRole = role => String(role || 'staff').split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(' ');
const staffInitials = staff => String(staff?.name || staff?.email || 'S').split(/[^a-z0-9]+/i).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || 'S';

// Every navigation (route change, date click, settings save, etc.) bumps
// this. Async page renders check it before touching the DOM, so a slow
// in-flight render from a previous click can never clobber a newer one —
// this was the actual cause of "clicking Settings/Prev/Next does nothing":
// pageStaffBoard did two sequential awaits before rendering, and whichever
// render finished LAST used to win, not whichever was clicked last.
let renderGen = 0;
let boardRefreshTimer = null;
let boardRealtimeCleanup = null;

// ── Shell ────────────────────────────────────────────────────────────
function shell(navActive, innerHTML) {
  const isOwner = ['owner', 'platform_owner'].includes(state.staff?.role);
  const canEditRules = ['owner', 'platform_owner', 'manager'].includes(state.staff?.role);
  const canManage = ['owner', 'platform_owner', 'manager'].includes(state.staff?.role);
  const moreActive = ['overview', 'analytics', 'billing', 'settings', 'organization', 'platform-admin', 'platform-checkout'].includes(navActive);
  const tenant = api.getActiveTenant();
  const locations = state.tenants.locations || [];
  const currentLocation = locations.find(item => item.id === tenant.locationId);
  const currentProvider = state.tenants.providers?.find(item => item.id === tenant.providerId);
  const tenantOptions = locations.map(location => {
    const provider = state.tenants.providers?.find(item => item.id === location.provider_id);
    return `<option value="${h(location.provider_id)}|${h(location.id)}" ${location.id === tenant.locationId ? 'selected' : ''}>${h(location.name)}</option>`;
  }).join('');
  return `
    <div class="app-shell">
      <div class="topbar">
        <div class="brand"><div class="drop"></div>Docket</div>
        ${navActive && tenantOptions ? `<div class="tenant-picker"><span>${h(currentProvider?.name || '')}</span><select id="tenantSelect" aria-label="Active location">${tenantOptions}</select></div>` : ''}
        ${navActive && state.staff ? `<div class="staff-profile"><button type="button" class="profile-trigger" data-profile-toggle aria-expanded="false" aria-controls="staffProfileDrawer" aria-label="Open account menu"><span>${h(staffInitials(state.staff))}</span></button><div class="profile-scrim" data-profile-close></div><aside class="profile-drawer" id="staffProfileDrawer" aria-hidden="true"><div class="profile-drawer-head"><div class="profile-avatar">${h(staffInitials(state.staff))}</div><div><strong>${h(state.staff.name || 'Staff')}</strong><span>${h(state.staff.email || '')}</span><small>${h(formatRole(state.staff.role))}</small></div><button type="button" class="profile-close" data-profile-close aria-label="Close account menu">×</button></div><div class="profile-drawer-section"><span class="profile-label">Active outlet</span><strong>${h(currentProvider?.name || '')}</strong><span>${h(currentLocation?.name || '')}</span></div><div class="profile-drawer-links">${canEditRules ? '<button type="button" data-nav="#/staff/settings">Account settings</button>' : ''}<button type="button" data-focus-tenant data-profile-close>Switch outlet</button><button type="button" class="profile-signout" data-signout="1">Sign out</button></div></aside></div>` : ''}
      </div>
      <div class="screen">${innerHTML}</div>
      ${navActive ? `
      <div class="navbar">
        <button type="button" class="item ${navActive==='board'?'active':''}" data-nav="#/staff/board">Board</button>
        <button type="button" class="item ${navActive==='history'?'active':''}" data-nav="#/staff/history">Bookings</button>
        <div class="nav-more-wrap"><button type="button" class="item ${moreActive?'active':''}" data-menu-toggle aria-expanded="false" aria-controls="navMenu">More <span aria-hidden="true">☰</span></button><div class="nav-menu" id="navMenu" hidden>${canManage || canEditRules ? `<div class="nav-menu-label">Operations</div>${canManage ? '<button type="button" data-nav="#/staff/organization">Manage</button>' : ''}${canEditRules ? '<button type="button" data-nav="#/staff/settings">Settings</button>' : ''}<div class="nav-menu-divider"></div>` : ''}${isOwner ? `<div class="nav-menu-label">Insights</div><button type="button" data-nav="#/staff/overview">Overview</button><button type="button" data-nav="#/staff/analytics">Analytics</button><div class="nav-menu-divider"></div><div class="nav-menu-label">Account</div><button type="button" data-nav="#/staff/billing">Billing & subscription</button><div class="nav-menu-divider"></div>` : ''}${state.staff?.role === 'platform_owner' ? '<div class="nav-menu-label">Docket platform</div><button type="button" data-nav="#/staff/platform-admin">Providers & subscriptions</button><div class="nav-menu-divider"></div>' : ''}</div></div>
      </div>` : ''}
    </div>`;
}

// ── Staff auth ───────────────────────────────────────────────────────
async function pageStaffLogin() {
  const myGen = ++renderGen;
  app.innerHTML = shell('', `
    <div class="eyebrow">Staff sign in</div>
    <h2>Wash Point staff</h2>
    <p class="lead">Use your staff email and password.</p>
    <form id="staffPasswordForm"><div class="field"><label for="staffEmail">Email</label><input id="staffEmail" type="email" autocomplete="email" required></div><div class="field"><label for="staffPassword">Password</label><input id="staffPassword" type="password" autocomplete="current-password" minlength="8" required></div><button class="btn" id="doPasswordSignIn" type="submit">Sign in</button></form>
    <a class="btn secondary" href="#/staff/setup">I have an invitation link</a>
    <button class="btn secondary" id="showStaffReset" type="button">Forgot password?</button>
    <div id="staffResetPanel" hidden><form id="staffResetForm"><div class="field"><label for="resetEmail">Email</label><input id="resetEmail" type="email" autocomplete="email" required></div><button class="btn" type="submit">Send reset email</button></form></div>
    <div class="auth-divider"><span>or</span></div><button class="btn secondary" id="doSignIn">Continue with Google</button>
    <p class="lead" id="errMsg" style="display:none;color:#b3261e"></p>
  `);
  document.getElementById('staffPasswordForm').onsubmit = async event => {
    event.preventDefault();
    const button = document.getElementById('doPasswordSignIn'); button.disabled = true;
    try { const result = await api.signInStaffWithPassword(document.getElementById('staffEmail').value, document.getElementById('staffPassword').value); if (result?.user) { location.hash = '#/staff/board'; router(); } else throw new Error('Sign-in did not create a session.'); } catch (error) { const errEl = document.getElementById('errMsg'); errEl.textContent = error?.message || 'Could not sign in.'; errEl.style.display = 'block'; } finally { button.disabled = false; }
  };
  document.getElementById('showStaffReset').onclick = () => { document.getElementById('staffResetPanel').hidden = !document.getElementById('staffResetPanel').hidden; };
  document.getElementById('staffResetForm').onsubmit = async event => { event.preventDefault(); try { await api.sendStaffPasswordReset(document.getElementById('resetEmail').value); alert('If that email is registered, a password reset link has been sent.'); } catch (error) { alert(error?.message || 'Could not send reset email.'); } };
  // Wire the button before checking for a previous redirect result. The
  // redirect check may wait while Firebase restores persistence; the visible
  // button must remain usable during that time.
  document.getElementById('doSignIn').onclick = async () => {
    const errEl = document.getElementById('errMsg');
    errEl.style.display = 'none';
    try {
      const result = await api.signInStaff();
      if (myGen !== renderGen) return;
      if (result?.user || await api.getAuthUser?.()) {
        location.hash = '#/staff/board';
        router();
        return;
      }
      errEl.textContent = 'Google sign-in completed, but the session was not restored yet. Please refresh once and try again.';
      errEl.style.display = 'block';
    } catch (e) {
      if (myGen !== renderGen) return;
      errEl.textContent = e?.message || 'Could not sign in. Check your Google account and try again.';
      errEl.style.display = 'block';
    }
  };
  try {
    const redirectedUser = await api.finishStaffRedirect?.();
    if (redirectedUser && myGen === renderGen) {
      location.hash = '#/staff/board';
      router();
      return;
    }
  } catch (e) {
    const errEl = document.getElementById('errMsg');
    errEl.textContent = e?.message || 'Google sign-in could not be completed.';
    errEl.style.display = 'block';
  }
}

// Gate: resolve current staff member. No session at all -> straight to
// login. Signed in but not on the staff list -> distinct "ask the owner"
// screen, since redirecting back to login there would just loop forever.
// Takes the caller's render token and checks it after every await, so a
// stale call (superseded by a newer click) never renders over fresher UI.
function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function requireStaff(myGen) {
  if (myGen === renderGen) {
    app.innerHTML = shell('', '<div class="eyebrow">Staff</div><h2>Loading staff access…</h2><p class="lead">Checking your account permissions.</p>');
  }
  let user;
  try {
    user = await withTimeout(api.getAuthUser(), 12000, 'Supabase authentication check timed out. Please retry or reload the page.');
  } catch (error) {
    if (myGen !== renderGen) return null;
    app.innerHTML = shell('', `<div class="eyebrow">Sign-in problem</div><h2>We couldn't check your sign-in</h2><p class="lead">The authentication service did not respond in time. Your account may still be signed in; retry once, then reload if needed.</p><p class="lead" style="color:#b3261e">${h(error?.message || 'Authentication check failed')}</p><button class="btn" id="retryStaff">Try again</button>`);
    document.getElementById('retryStaff').onclick = () => router();
    return null;
  }
  if (myGen !== renderGen) return null;
  if (!user) {
    location.hash = '#/staff/login';
    return null;
  }

  let staff;
  try {
    staff = await withTimeout(api.getCurrentStaff(), 12000, 'Supabase staff permission check timed out. Please retry or reload the page.');
  } catch (error) {
    if (myGen !== renderGen) return null;
    app.innerHTML = shell('', `
      <div class="eyebrow">Sign-in problem</div>
      <h2>We couldn't load your staff access</h2>
      <p class="lead">Your sign-in succeeded, but the staff record could not be read. Please try again or ask the owner to check your staff access.</p>
      <p class="lead" style="color:#b3261e">${h(error?.code || error?.message || 'Firebase access error')}</p>
      <button class="btn" id="retryStaff">Try again</button>
    `);
    document.getElementById('retryStaff').onclick = () => router();
    return null;
  }
  if (myGen !== renderGen) return null;
  state.staff = staff;
  if (!staff) {
    app.innerHTML = shell('', `
      <div class="eyebrow">Access</div>
      <h2>Not on the staff list</h2>
      <p class="lead">You're signed in, but this account hasn't been added as staff yet — ask the owner to add you.</p>
      <button class="btn" id="signout">Sign out</button>
    `);
    document.getElementById('signout').onclick = async () => {
      await api.signOutStaff();
      location.hash = '#/staff/login';
    };
    return null;
  }
  try {
    state.tenants = await api.getAccessibleTenants(staff);
  } catch (error) {
    if (myGen !== renderGen) return null;
    app.innerHTML = shell('', `
      <div class="eyebrow">Dashboard loading problem</div>
      <h2>Your account is signed in</h2>
      <p class="lead">Firebase authentication succeeded, but the staff workspace data could not be loaded.</p>
      <p class="lead" style="color:#b3261e">${h(error?.code || error?.message || 'Firebase data access error')}</p>
      <button class="btn" id="retryWorkspace">Try again</button>
    `);
    document.getElementById('retryWorkspace').onclick = () => router();
    return null;
  }
  if (myGen !== renderGen) return null;
  return staff;
}

async function pageStaffPasswordReset() {
  const myGen = ++renderGen;
  try {
    await api.finishStaffRedirect?.();
    const user = await api.getAuthUser();
    if (!user) { location.hash = '#/staff/login'; return; }
    app.innerHTML = shell('', `<div class="eyebrow">Staff account</div><h2>Choose a new password</h2><p class="lead">Use at least 8 characters. You can then sign in normally.</p><form id="passwordResetForm"><div class="field"><label for="newStaffPassword">New password</label><input id="newStaffPassword" type="password" autocomplete="new-password" minlength="8" required></div><div class="field"><label for="confirmStaffPassword">Confirm password</label><input id="confirmStaffPassword" type="password" autocomplete="new-password" minlength="8" required></div><button class="btn" type="submit">Save new password</button><p id="passwordResetMessage" class="lead" role="status"></p></form>`);
    document.getElementById('passwordResetForm').onsubmit = async event => { event.preventDefault(); const message = document.getElementById('passwordResetMessage'); const password = document.getElementById('newStaffPassword').value; if (password !== document.getElementById('confirmStaffPassword').value) { message.textContent = 'Passwords do not match.'; return; } try { await api.updateStaffPassword(password); message.textContent = 'Password updated. Opening your staff workspace…'; setTimeout(() => { location.hash = '#/staff/board'; router(); }, 500); } catch (error) { message.textContent = error?.message || 'Could not update your password.'; } };
  } catch (error) {
    if (myGen !== renderGen) return;
    app.innerHTML = shell('', `<div class="eyebrow">Staff account</div><h2>Password link expired</h2><p class="lead">Request a new password-reset email and try again.</p><button class="btn" id="backToLogin" type="button">Back to sign in</button>`);
    document.getElementById('backToLogin').onclick = () => { location.hash = '#/staff/login'; router(); };
  }
}

async function pageStaffSetup() {
  const myGen = ++renderGen;
  try {
    await api.finishStaffRedirect?.();
    const user = await api.getAuthUser();
    if (!user) {
      app.innerHTML = shell('', '<div class="eyebrow">Staff account</div><h2>Open your invitation email first</h2><p class="lead">This page is only for the secure link sent by the owner. Open that email, then choose a password or continue with Google.</p><a class="btn" href="#/staff/login">Back to sign in</a>');
      return;
    }
    app.innerHTML = shell('', `<div class="eyebrow">Staff account</div><h2>Finish setting up your access</h2><p class="lead">You are signing in as <strong>${h(user.email)}</strong>. Choose one option below.</p><form id="staffSetupForm"><div class="field"><label for="setupPassword">Create password</label><input id="setupPassword" type="password" autocomplete="new-password" minlength="8" required></div><div class="field"><label for="setupPasswordConfirm">Confirm password</label><input id="setupPasswordConfirm" type="password" autocomplete="new-password" minlength="8" required></div><button class="btn" type="submit">Set password & continue</button><p id="setupMessage" class="lead" role="status"></p></form><div class="auth-divider"><span>or</span></div><button class="btn secondary" id="setupGoogle" type="button">Continue with Google</button><button class="btn ghost" id="setupSignout" type="button">Use a different account</button>`);
    const message = document.getElementById('setupMessage');
    document.getElementById('staffSetupForm').onsubmit = async event => {
      event.preventDefault();
      const password = document.getElementById('setupPassword').value;
      if (password !== document.getElementById('setupPasswordConfirm').value) { message.textContent = 'Passwords do not match.'; return; }
      const button = event.currentTarget.querySelector('button'); button.disabled = true; message.textContent = 'Saving your password…';
      try { await api.updateStaffPassword(password); await api.getCurrentStaff(); message.textContent = 'Access ready. Opening the staff workspace…'; setTimeout(() => { location.hash = '#/staff/board'; router(); }, 300); }
      catch (error) { button.disabled = false; message.textContent = error?.message || 'Could not finish setting up your account.'; }
    };
    document.getElementById('setupGoogle').onclick = async event => {
      event.currentTarget.disabled = true; message.textContent = 'Opening Google…';
      try { await api.linkStaffGoogleIdentity(); } catch (error) { event.currentTarget.disabled = false; message.textContent = error?.message || 'Could not connect Google.'; }
    };
    document.getElementById('setupSignout').onclick = async () => { await api.signOutStaff(); location.hash = '#/staff/login'; router(); };
  } catch (error) {
    if (myGen !== renderGen) return;
    app.innerHTML = shell('', `<div class="eyebrow">Staff account</div><h2>That invitation link is no longer valid</h2><p class="lead" style="color:#b3261e">${h(error?.message || 'Please ask the owner to send a new invitation.')}</p><a class="btn" href="#/staff/login">Back to sign in</a>`);
  }
}

// ── Staff pages ──────────────────────────────────────────────────────
function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDateTime(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return date.toLocaleString('en-MY', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function bookingSource(channel) {
  return ({ web: 'Web', telegram: 'Telegram', whatsapp: 'WhatsApp', staff: 'Staff' })[channel] || (channel ? String(channel) : 'Unknown');
}
function fmtDateLabel(dateISO, isToday) {
  const d = new Date(dateISO + 'T00:00:00');
  const label = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return isToday ? `${label} · Today` : label;
}
// Local YYYY-MM-DD, not toISOString() (which is UTC and can land on the
// wrong calendar day entirely in positive-UTC-offset zones like MYT).
function localDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function shiftDate(dateISO, days) {
  const d = new Date(dateISO + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return localDateISO(d);
}
function isWeekend(dateISO) {
  const day = new Date(dateISO + 'T00:00:00').getDay();
  return day === 0 || day === 6;
}
// "08:00:00" or "08:00" -> minutes since midnight
function timeStrToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function fmtHourLabel(mins) {
  const h = Math.floor(mins / 60);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${suffix}`;
}

// For "today" only: is this bay free right now, and until when? Busy
// window is booking duration + buffer (same rule the booking bot itself
// uses), so this directly answers "can I take a walk-in in this bay".
function bayAvailability(bookings, bufferMinutes, now) {
  const sorted = bookings
    .filter(b => b.status !== 'completed')
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  for (const b of sorted) {
    const start = new Date(b.scheduled_at);
    const end = new Date(start.getTime() + (b.duration_minutes + bufferMinutes) * 60000);
    if (now >= start && now < end) return { free: false, until: end };
  }
  const next = sorted.find(b => new Date(b.scheduled_at) > now);
  return { free: true, until: next ? new Date(next.scheduled_at) : null };
}

// customer_phone is now explicitly collected and validated (Malaysian
// mobile format) by the booking bot before it finalizes a booking, so it's
// real data, not inferred from the channel. customer_chat_id is kept as a
// separate technical reference (which platform/id to message back via) —
// it is NOT a phone number for Telegram, only WhatsApp. There is still no
// email field anywhere in the schema; the booking flow never collects one.
function showApptModal(a, onChanged = () => {}) {
  const idLabel = a.channel === 'whatsapp' ? 'WhatsApp ID' : 'Telegram ID';
  const rows = [
    ['Customer', a.customer_name || '—'],
    ['Phone', a.customer_phone || '— (not collected)'],
    [idLabel, a.customer_chat_id],
    ['Vehicle', a.vehicle_plate || '—'],
    ['Service', a.services?.name ?? 'Wash'],
    ['Bay', a.bays?.name ?? '—'],
    ['Time', fmtTime(new Date(a.scheduled_at))],
    ['Duration', `${a.duration_minutes} min`],
    ['Price', `RM ${a.price_myr}`],
    ['Status', a.status.replace('_', ' ')],
    ['Payment', a.payment_status],
    ['Reference', a.reference],
  ];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>Booking details</h3>
      ${rows.map(([k, v]) => `<div class="modal-row"><span>${k}</span><span>${v}</span></div>`).join('')}
      <div class="confirmation-actions"><button class="btn secondary" id="closeModal">Close</button>${a.status !== 'completed' && a.status !== 'cancelled' ? '<button class="btn" id="moveBooking">Move booking</button><button class="btn" id="completeBooking">Mark completed</button>' : ''}<button class="btn ghost" id="archiveBooking">Remove from calendar</button></div>
    </div>`;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  document.getElementById('closeModal').onclick = () => overlay.remove();
  document.getElementById('moveBooking')?.addEventListener('click', () => { overlay.remove(); showRescheduleModal(a, a.scheduled_date || localDateISO(new Date(a.scheduled_at)), onChanged); });
  document.getElementById('completeBooking')?.addEventListener('click', async () => { try { await api.updateAppointmentStatus(a.id, 'completed', 'Booking marked completed by staff'); overlay.remove(); onChanged(); } catch (error) { alert(`Could not mark booking completed: ${error?.message || 'Unknown error'}`); } });
  document.getElementById('archiveBooking')?.addEventListener('click', async () => { if (!confirm('Remove this booking from the active calendar? It will remain in History.')) return; try { await api.archiveAppointment(a.id, 'Booking removed from the active calendar by staff'); overlay.remove(); onChanged(); } catch (error) { alert(`Could not archive booking: ${error?.message || 'Unknown error'}`); } });
}

async function showRescheduleModal(a, dateISO, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-card"><h3>Move booking</h3><p class="lead">Choose another day and available time for ${h(a.services?.name || 'this booking')}.</p><input id="moveDate" type="date" value="${h(dateISO)}" min="${h(localDateISO(new Date()))}"><p class="lead" id="moveLoading">Loading available times…</p></div>`;
  document.body.appendChild(overlay);
  try {
    const loadForDate = async selectedDate => { const slots = (await api.getAvailableSlots(selectedDate, a.service_id, a.id)).filter(item => item.available); const card = overlay.querySelector('.modal-card'); const bayMap = Object.fromEntries((await api.getActiveBays({ includeInactive: true })).map(item => [item.id, item.name])); card.innerHTML = `<h3>Move booking</h3><p class="lead">Choose another day, time and bay for ${h(a.services?.name || 'this booking')}.</p><input id="moveDate" type="date" value="${h(selectedDate)}" min="${h(localDateISO(new Date()))}"><div class="field"><label>Available time</label><select id="moveTime" class="move-time-select">${slots.length ? slots.map(item => `<option value="${h(item.time)}">${h(item.time)}</option>`).join('') : '<option value="">No available times</option>'}</select></div><div class="field"><label>Bay</label><select id="moveBay" class="move-time-select"></select></div><div class="confirmation-actions"><button class="btn secondary" id="cancelMove" type="button">Cancel</button><button class="btn" id="saveMove" type="button" ${slots.length ? '' : 'disabled'}>Move booking</button></div>`; const refreshBays = () => { const slot = slots.find(item => item.time === card.querySelector('#moveTime').value); card.querySelector('#moveBay').innerHTML = (slot?.bayIds || []).map(id => `<option value="${h(id)}">${h(bayMap[id] || id)}</option>`).join('') || '<option value="">No bay available</option>'; }; card.querySelector('#moveDate').onchange = event => loadForDate(event.target.value); card.querySelector('#moveTime').onchange = refreshBays; card.querySelector('#cancelMove').onclick = () => overlay.remove(); refreshBays(); card.querySelector('#saveMove').onclick = async () => { const button = card.querySelector('#saveMove'); button.disabled = true; try { await api.rescheduleAppointment(a.id, { dateISO: card.querySelector('#moveDate').value, time: card.querySelector('#moveTime').value, bayId: card.querySelector('#moveBay').value }); overlay.remove(); onDone(); } catch (error) { button.disabled = false; alert(`Could not move booking: ${error?.message || 'Unknown error'}`); } }; };
    await loadForDate(dateISO);
  } catch (error) { overlay.querySelector('.modal-card').innerHTML = `<h3>Could not load times</h3><p class="lead" style="color:#b3261e">${h(error?.message || 'Unknown error')}</p><button class="btn" id="closeMove" type="button">Close</button>`; overlay.querySelector('#closeMove').onclick = () => overlay.remove(); }
}

async function pageStaffBoard(dateISO) {
  boardRealtimeCleanup?.();
  boardRealtimeCleanup = null;
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  const date = dateISO || localDateISO(new Date());
  const isToday = date === localDateISO(new Date());

  let bays, appts, settings, breaks, closures;
  try {
    const read = (label, operation) => operation().catch(error => {
      throw new Error(`${label}: ${error?.code || error?.message || 'read failed'}`);
    });
    [bays, appts, settings, breaks, closures] = await Promise.all([
      read('bays', () => api.getActiveBays()),
      read('appointments', () => api.getAppointmentsForDate(date)),
      read('booking settings', () => api.getBookingSettings()),
      read('crew breaks', () => api.getCrewBreaks()),
      read('bay outages', () => api.getBayClosuresForDate(date)),
    ]);
  } catch (error) {
    if (myGen !== renderGen) return;
    app.innerHTML = shell('board', `
      <div class="eyebrow">Board loading problem</div>
      <h2>Staff access is working</h2>
      <p class="lead">The dashboard could not load its booking data.</p>
      <p class="lead" style="color:#b3261e">${h(error?.code || error?.message || 'Firebase data access error')}</p>
      <button class="btn" id="retryBoard">Try again</button>
    `);
    wireNav();
    document.getElementById('retryBoard').onclick = () => router();
    return;
  }
  if (myGen !== renderGen) return;

  const weekend = isWeekend(date);
  const dayStart = timeStrToMinutes(weekend ? settings.weekend_open : settings.weekday_open);
  const dayEnd = timeStrToMinutes(weekend ? settings.weekend_close : settings.weekday_close);
  const totalMin = dayEnd - dayStart;

  const byBay = {};
  for (const a of appts) (byBay[a.bay_id] ??= []).push(a);
  const breaksByBay = {};
  for (const b of breaks) (breaksByBay[b.bay_id] ??= []).push(b);
  const closuresByBay = {};
  for (const c of closures) (closuresByBay[c.bay_id] ??= []).push(c);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  let hourLines = '';
  const hourLabels = [];
  for (let m = Math.ceil(dayStart / 60) * 60; m <= dayEnd; m += 60) {
    const top = m - dayStart;
    hourLines += `<div class="cal-gridline" style="top:${top}px"></div>`;
    hourLabels.push(`<div class="cal-hour-label" style="top:${top}px">${fmtHourLabel(m)}</div>`);
  }
  const nowLine = (isToday && nowMin >= dayStart && nowMin <= dayEnd)
    ? `<div class="cal-now-line" style="top:${nowMin - dayStart}px"></div>` : '';
  const attention = appts.filter(a => a.needs_attention && a.status !== 'cancelled');
  const attentionSection = attention.length ? `<section class="attention-panel"><div class="attention-heading"><span>⚠ Attention required</span><strong>${attention.length}</strong></div><p>These bookings overlap a bay outage and need a staff decision.</p><div class="attention-list">${attention.map(a => `<div class="attention-item"><button class="attention-booking" data-appt="${h(a.id)}" type="button"><strong>${h(a.services?.name || 'Wash')}</strong> · ${h(a.customer_name || a.customer_chat_id || 'Customer')}<small>${h(a.bays?.name || 'Bay')} · ${fmtTime(new Date(a.scheduled_at))}</small></button><span class="attention-actions"><button data-move-attention="${h(a.id)}" type="button">Move</button><button data-clear-attention="${h(a.id)}" type="button">Clear</button><button data-resolve-attention="${h(a.id)}" type="button">Resolve & archive</button></span></div>`).join('')}</div></section>` : '';

  const liveBookings = appts.filter(a => !['cancelled', 'no_show'].includes(a.status));
  const upcomingCount = liveBookings.filter(a => ['pending', 'confirmed'].includes(a.status)).length;
  const inProgressCount = liveBookings.filter(a => a.status === 'in_progress').length;
  const completedCount = liveBookings.filter(a => a.status === 'completed').length;
  const bookedValue = liveBookings.reduce((sum, a) => sum + Number(a.price_myr || 0), 0);

  const heads = bays.map(b => {
    const bookings = byBay[b.id] || [];
    const bayClosures = closuresByBay[b.id] || [];
    let tag = 'Open', tagClass = '';
    if (b.status === 'maintenance') {
      tag = 'Down'; tagClass = 'busy';
    } else if (bayClosures.length) {
      tag = 'Down during outage'; tagClass = 'busy';
    } else if (isToday) {
      const avail = bayAvailability(bookings, settings.buffer_minutes, now);
      if (avail.free) tag = avail.until ? `Free until ${fmtTime(avail.until)}` : 'Free all day';
      else { tag = `Busy until ${fmtTime(avail.until)}`; tagClass = 'busy'; }
    }
    return `<div class="cal-col-head"><span>${b.name}</span><span class="tag ${tagClass}">${tag}</span></div>`;
  }).join('');

  const tracks = bays.map(b => {
    const bookings = byBay[b.id] || [];
    const bayClosures = closuresByBay[b.id] || [];
    const apptBlocks = bookings.map(a => {
      const start = new Date(a.scheduled_at);
      const startMin = start.getHours() * 60 + start.getMinutes();
      const top = startMin - dayStart;
      const height = Math.max(24, a.duration_minutes);
      const cls = a.status === 'in_progress' ? 'progress' : a.status === 'completed' ? 'done' : a.needs_attention ? 'attention' : '';
      return `<div class="cal-block ${cls}" style="top:${top}px;height:${height}px" data-appt="${a.id}">
        <div class="t1">${fmtTime(start)} ${a.services?.name ?? 'Wash'}</div>
        <div class="t2">${a.customer_name || a.customer_chat_id}</div>
      </div>`;
    }).join('');
    const breakBlocks = (breaksByBay[b.id] || []).map(br => {
      const startMin = timeStrToMinutes(br.start_time);
      const top = startMin - dayStart;
      const height = Math.max(18, br.duration_minutes);
      return `<div class="cal-block cal-break" style="top:${top}px;height:${height}px">
        <div class="t1">Crew break</div>
      </div>`;
    }).join('');
    const closureBlocks = bayClosures.map(c => {
      const start = new Date(c.starts_at);
      const end = new Date(c.ends_at);
      const top = Math.max(dayStart, start.getHours() * 60 + start.getMinutes()) - dayStart;
      const bottom = Math.min(dayEnd, end.getHours() * 60 + end.getMinutes()) - dayStart;
      const height = Math.max(24, bottom - top);
      return `<div class="cal-block cal-closure" style="top:${top}px;height:${height}px" data-closure-edit="${c.id}">
        <div class="t1">Bay down</div>
        <div class="t2">${fmtTime(start)}–${fmtTime(end)}${c.reason ? ` · ${c.reason}` : ''}</div>
      </div>`;
    }).join('');
    return `<div class="cal-col-track">${hourLines}${closureBlocks}${breakBlocks}${apptBlocks}${isToday ? nowLine : ''}</div>`;
  }).join('');

  app.innerHTML = shell('board', `
    <header class="board-page-head">
      <div><div class="eyebrow">Daily operations</div><h2>Bay board</h2><p class="lead">Bookings, bay capacity and issues for one working day.</p></div>
      <div class="date-nav">
        <button data-date="${shiftDate(date, -1)}" aria-label="Previous day">&larr; Prev</button>
        <div class="current">${fmtDateLabel(date, isToday)}</div>
        <button data-date="${shiftDate(date, 1)}" aria-label="Next day">Next &rarr;</button>
        <button data-refresh-board type="button">Refresh</button>
      </div>
    </header>
    <section class="board-kpis" aria-label="Daily summary">
      <div><span>Bookings</span><strong>${liveBookings.length}</strong><small>${upcomingCount} upcoming</small></div>
      <div><span>In progress</span><strong>${inProgressCount}</strong><small>${completedCount} completed</small></div>
      <div><span>Outages</span><strong>${closures.length}</strong><small>${attention.length} need attention</small></div>
      <div><span>Booked value</span><strong>RM ${bookedValue.toFixed(0)}</strong><small>Before refunds</small></div>
    </section>
    <div class="board-workspace">
      <main class="board-calendar-panel">
        <div class="calendar-toolbar"><div><strong>Bay schedule</strong><span>${bays.length} active bay${bays.length === 1 ? '' : 's'}${isToday ? ' · live availability' : ''}</span></div>${staff.role === 'owner' ? '<button class="calendar-outage-btn" id="reportBayOutage" type="button">Report outage</button>' : ''}</div>
        <div class="cal-wrap">
          <div class="cal-grid" style="grid-template-columns:44px repeat(${bays.length},minmax(140px,1fr))">
            <div class="cal-gutter-head"></div>
            ${heads}
            <div class="cal-gutter" style="height:${totalMin}px">${hourLabels.join('')}</div>
            ${tracks}
          </div>
        </div>
      </main>
      <aside class="board-side-panel">
        ${attentionSection || '<section class="all-clear-panel"><span>✓</span><div><strong>Nothing needs attention</strong><small>No bookings currently clash with an outage.</small></div></section>'}
        <section class="day-summary-panel"><h3>Today at a glance</h3><dl><div><dt>Opening hours</dt><dd>${h(weekend ? settings.weekend_open : settings.weekday_open).slice(0, 5)}–${h(weekend ? settings.weekend_close : settings.weekday_close).slice(0, 5)}</dd></div><div><dt>Active bays</dt><dd>${bays.length}</dd></div><div><dt>Crew breaks</dt><dd>${breaks.length}</dd></div><div><dt>Buffer</dt><dd>${settings.buffer_minutes} min</dd></div></dl></section>
      </aside>
    </div>
  `);
  document.querySelectorAll('[data-date]').forEach(el => el.onclick = () => pageStaffBoard(el.dataset.date));
  document.querySelector('[data-refresh-board]')?.addEventListener('click', () => pageStaffBoard(date));
  document.querySelectorAll('[data-appt]').forEach(el => el.onclick = () => {
    const a = appts.find(x => x.id === el.dataset.appt);
    if (a) showApptModal(a, () => pageStaffBoard(date));
  });
  document.querySelectorAll('[data-move-attention]').forEach(el => el.onclick = () => {
    const a = appts.find(x => x.id === el.dataset.moveAttention);
    if (a) showRescheduleModal(a, date, () => pageStaffBoard(date));
  });
  document.querySelectorAll('[data-resolve-attention]').forEach(el => el.onclick = async () => {
    const a = appts.find(x => x.id === el.dataset.resolveAttention);
    if (!a || !confirm('Mark this attention item as resolved? Confirm that the customer has been handled.')) return;
    const description = prompt('Describe what was done for this customer. This will be saved in booking history:', 'Customer contacted and booking handled');
    if (description === null) return;
    try { await api.resolveAppointmentAttention(a.id, { description, archive: true }); pageStaffBoard(date); } catch (error) { alert(`Could not resolve attention item: ${error?.message || 'Unknown error'}`); }
  });
  document.querySelectorAll('[data-clear-attention]').forEach(el => el.onclick = async () => {
    const a = appts.find(x => x.id === el.dataset.clearAttention);
    if (!a) return;
    const description = prompt('Why is this no longer a problem? The booking will stay on the calendar:', 'Outage resolved; appointment can proceed as scheduled');
    if (description === null) return;
    try { await api.resolveAppointmentAttention(a.id, { description, archive: false }); pageStaffBoard(date); } catch (error) { alert(`Could not clear attention item: ${error?.message || 'Unknown error'}`); }
  });
  document.getElementById('reportBayOutage')?.addEventListener('click', async () => {
    const values = await bayDownDetails(bays[0]?.id, date, null, bays);
    if (!values) return;
    try {
      const res = await api.reportBayDown(values.bayId, values);
      if (myGen !== renderGen) return;
      alert(`Bay outage recorded. ${res.flagged ?? 0} booking(s) were checked for reassignment.`);
      pageStaffBoard(date);
    } catch (error) { alert(`Could not save bay outage: ${error?.message || 'Unknown error'}`); }
  });
  document.querySelectorAll('[data-closure-edit]').forEach(el => el.onclick = async () => {
    const closure = closures.find(c => c.id === el.dataset.closureEdit);
    if (!closure) return;
    const values = await bayDownDetails(closure.bay_id, date, closure);
    if (!values) return;
    try {
      if (values.delete) {
        await api.clearBayClosure(closure.id);
        if (myGen !== renderGen) return;
        pageStaffBoard(date);
        return;
      }
      const updated = await api.updateBayClosure(closure.id, values);
      if (updated?.flagged) alert(`Outage updated. ${updated.flagged} booking(s) now require attention.`);
      if (myGen !== renderGen) return;
      pageStaffBoard(date);
    } catch (error) { alert(`Could not update bay outage: ${error?.message || 'Unknown error'}`); }
  });
  document.querySelectorAll('[data-clear-closure]').forEach(el => el.onclick = async () => {
    if (!confirm('End this bay outage early?')) return;
    try {
      await api.clearBayClosure(el.dataset.clearClosure);
      if (myGen !== renderGen) return;
      pageStaffBoard(date);
    } catch (error) { alert(`Could not delete bay outage: ${error?.message || 'Unknown error'}`); }
  });
  wireNav();
  clearTimeout(boardRefreshTimer);
  boardRealtimeCleanup = api.watchOperationalChanges(() => { clearTimeout(boardRefreshTimer); boardRefreshTimer = setTimeout(() => pageStaffBoard(date), 250); });
}

function localDateTimeValue(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function timeOptions(selected) {
  let html = '';
  for (let mins = 0; mins < 24 * 60; mins += 15) {
    const h = String(Math.floor(mins / 60)).padStart(2, '0');
    const m = String(mins % 60).padStart(2, '0');
    const value = `${h}:${m}`;
    const label = new Date(`2000-01-01T${value}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    html += `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`;
  }
  return html;
}

async function bayDownDetails(bayId, dateISO, existing = null, selectableBays = []) {
  const now = new Date();
  const existingStart = existing?.starts_at ? new Date(existing.starts_at) : null;
  const existingEnd = existing?.ends_at ? new Date(existing.ends_at) : null;
  const startDate = existingStart || (dateISO === localDateISO(now) ? new Date(now) : new Date(`${dateISO}T08:00`));
  if (!existingStart) startDate.setMinutes(Math.ceil(startDate.getMinutes() / 15) * 15, 0, 0);
  const endDate = existingEnd || new Date(startDate.getTime() + 60 * 60000);
  const isEditing = Boolean(existing);
  const pad = n => String(n).padStart(2, '0');
  const dateValue = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeValue = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card outage-modal">
        <h3>${isEditing ? 'Amend bay outage' : 'Report bay down'}</h3>
        <p class="lead">${isEditing ? 'Update the outage window or reason, then save.' : 'Choose exactly when this bay is unavailable. Existing bookings in this window will be checked.'}</p>
        ${!isEditing && selectableBays.length ? `<div class="field"><label>Bay</label><select id="outageBay">${selectableBays.map(bay => `<option value="${h(bay.id)}" ${bay.id === bayId ? 'selected' : ''}>${h(bay.name)}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label>Starts</label><div class="outage-datetime">
          <input id="outageStartDate" type="date" value="${dateValue(startDate)}">
          <select id="outageStartTime">${timeOptions(timeValue(startDate))}</select>
        </div></div>
        <div class="field"><label>Ends</label><div class="outage-datetime">
          <input id="outageEndDate" type="date" value="${dateValue(endDate)}">
          <select id="outageEndTime">${timeOptions(timeValue(endDate))}</select>
        </div></div>
        <div class="field"><label>Reason <span class="muted">(optional)</span></label>
          <input id="outageReason" value="${existing?.reason || ''}" placeholder="e.g. pressure washer repair">
        </div>
        <div class="settings-row">
          ${isEditing ? '<button class="btn ghost" id="deleteOutage" type="button">Delete outage</button>' : '<button class="btn ghost" id="cancelOutage" type="button">Cancel</button>'}
          <button class="btn amber" id="saveOutage" type="button">${isEditing ? 'Save changes' : 'Save outage'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = value => { overlay.remove(); resolve(value); };
    overlay.onclick = e => { if (e.target === overlay) close(null); };
    overlay.querySelector('#cancelOutage')?.addEventListener('click', () => close(null));
    overlay.querySelector('#deleteOutage')?.addEventListener('click', () => { if (confirm('Delete this bay outage?')) close({ delete: true }); });
    overlay.querySelector('#saveOutage').onclick = () => {
      const start = new Date(`${overlay.querySelector('#outageStartDate').value}T${overlay.querySelector('#outageStartTime').value}`);
      const end = new Date(`${overlay.querySelector('#outageEndDate').value}T${overlay.querySelector('#outageEndTime').value}`);
      if (!overlay.querySelector('#outageStartDate').value || !overlay.querySelector('#outageEndDate').value || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
        alert('Please choose a valid window with the end after the start.');
        return;
      }
      close({ bayId: overlay.querySelector('#outageBay')?.value || bayId, startsAt: start.toISOString(), endsAt: end.toISOString(), reason: overlay.querySelector('#outageReason').value.trim() });
    };
  });
}

async function pageStaffHistory() {
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  try {
    const history = await api.getBookingHistory();
    if (myGen !== renderGen) return;
    app.innerHTML = shell('history', `<div class="eyebrow">Operations</div><h2>Booking history</h2><p class="lead">Completed, moved, cancelled, resolved and archived bookings remain here for reference.</p><div class="history-search"><input id="historySearch" type="search" placeholder="Search reference, customer, phone, service, bay, source or notes" aria-label="Search booking history"></div><div class="history-list">${history.length ? history.map(a => { const source = bookingSource(a.channel); const searchText = [a.reference, a.customer_name, a.customer_phone, a.customer_chat_id, a.vehicle_plate, a.status, source, a.created_at, a.services?.name, a.bays?.name, ...(a.events || []).flatMap(event => [event.event_type, event.description])].filter(Boolean).join(' '); return `<article class="history-card" data-history-search="${h(searchText.toLowerCase())}"><div class="history-card-head"><strong>${h(a.reference || 'No reference')}</strong><span class="history-status">${h(String(a.status || '').replace('_', ' '))}${a.archived_at ? ' · archived' : ''}</span></div><dl class="history-summary"><div><dt>Service</dt><dd>${h(a.services?.name || 'Wash')}</dd></div><div><dt>Customer</dt><dd>${h(a.customer_name || a.customer_chat_id || 'Customer')}${a.customer_phone ? ` · ${h(a.customer_phone)}` : ''}</dd></div><div><dt>Appointment</dt><dd>${h(a.scheduled_date || '')} · ${h(fmtTime(new Date(a.scheduled_at)))}</dd></div><div><dt>Bay</dt><dd>${h(a.bays?.name || 'Bay')}</dd></div><div><dt>Booked on</dt><dd>${h(fmtDateTime(a.created_at))}</dd></div><div><dt>Source</dt><dd><span class="history-source">${h(source)}</span></dd></div></dl><div class="history-events">${(a.events || []).length ? a.events.map(event => `<div class="history-event"><time>${h(fmtDateTime(event.created_at))}</time><span><strong>${h(String(event.event_type).replace('_', ' '))}</strong> — ${h(event.description || '')}</span></div>`).join('') : '<div class="history-event muted">No later changes recorded.</div>'}</div></article>`; }).join('') : '<p class="lead">No bookings in history yet.</p>'}</div>`);
    const search = document.getElementById('historySearch');
    search?.addEventListener('input', () => { const term = search.value.trim().toLowerCase(); document.querySelectorAll('[data-history-search]').forEach(card => { card.hidden = Boolean(term) && !card.dataset.historySearch.includes(term); }); });
    wireNav();
  } catch (error) {
    if (myGen !== renderGen) return;
    app.innerHTML = shell('history', `<div class="eyebrow">Booking history</div><h2>Could not load history</h2><p class="lead" style="color:#b3261e">${h(error?.message || 'Unknown error')}</p><button class="btn" id="retryHistory">Try again</button>`);
    wireNav();
    document.getElementById('retryHistory').onclick = pageStaffHistory;
  }
}

async function pagePlatformAdmin() {
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  if (staff.role !== 'platform_owner') {
    app.innerHTML = shell('platform-admin', '<div class="eyebrow">Docket platform</div><h2>Platform admin access only</h2><p class="lead">This area is restricted to Docket operators.</p>');
    wireNav();
    return;
  }
  try {
    const data = await api.getPlatformAdminData();
    if (myGen !== renderGen) return;
    const subscriptions = Object.fromEntries(data.subscriptions.map(item => [item.provider_id, item]));
    const onboarding = Object.fromEntries(data.onboarding.map(item => [item.provider_id, item]));
    const planNames = Object.fromEntries(data.plans.map(item => [item.id, item.name]));
    const activeProviders = data.providers.filter(item => item.status === 'active').length;
    const liveSubscriptions = data.subscriptions.filter(item => ['trialing', 'active'].includes(item.status)).length;
    const attention = data.providers.filter(item => ['paused', 'archived'].includes(item.status) || ['past_due', 'suspended', 'blocked'].includes(subscriptions[item.id]?.status || onboarding[item.id]?.status));
    const rows = data.providers.map(provider => {
      const subscription = subscriptions[provider.id] || {};
      const setup = onboarding[provider.id] || {};
      const locations = data.locations.filter(item => item.provider_id === provider.id && item.is_active !== false).length;
      const staffCount = data.staff.filter(item => item.provider_id === provider.id && item.is_active !== false).length;
      const planOptions = data.plans.map(plan => `<option value="${h(plan.id)}" ${subscription.plan_id === plan.id ? 'selected' : ''}>${h(plan.name)} · RM ${Number(plan.monthly_price_myr).toFixed(2)}</option>`).join('');
      const nextBilling = subscription.next_billing_at ? `Next billing ${h(new Date(subscription.next_billing_at).toLocaleDateString('en-MY'))}` : 'No billing date yet';
      return `<article class="platform-provider-card"><div class="platform-provider-head"><div><strong>${h(provider.name)}</strong><span>${h(provider.id)}</span></div><span class="history-status ${subscription.status === 'past_due' || subscription.status === 'incomplete' || setup.status === 'blocked' ? 'status-alert' : ''}">${h(subscription.status || setup.status || provider.status || 'not started')}</span></div><dl class="platform-provider-meta"><div><dt>Locations</dt><dd>${locations}</dd></div><div><dt>Staff</dt><dd>${staffCount}</dd></div><div><dt>Onboarding</dt><dd>${h(setup.status || 'Not started')}</dd></div><div><dt>Plan</dt><dd>${h(planNames[subscription.plan_id] || 'Not assigned')}</dd></div></dl><div class="platform-provider-billing"><span>${h(subscription.payment_provider === 'mock' ? 'Test payment' : 'Payment not connected')}</span><span>${nextBilling}</span></div><div class="platform-provider-actions"><label>Choose plan<select data-provider-plan="${h(provider.id)}"><option value="">Select a plan</option>${planOptions}</select></label><button class="btn compact-btn" type="button" data-open-mock-checkout="${h(provider.id)}">Open mock checkout</button></div></article>`;
    }).join('') || '<p class="muted">No providers onboarded yet.</p>';
    const planCards = data.plans.map(plan => `<article class="platform-plan-card"><div><strong>${h(plan.name)}</strong><span>${h(plan.description || 'No description')}</span></div><label>Name<input data-plan-name="${h(plan.id)}" value="${h(plan.name)}"></label><label>Monthly RM<input type="number" min="0" step="0.01" data-plan-price="${h(plan.id)}" value="${Number(plan.monthly_price_myr).toFixed(2)}"></label><label>Locations<input type="number" min="1" data-plan-locations="${h(plan.id)}" value="${plan.max_locations ?? ''}"></label><label>Staff<input type="number" min="1" data-plan-staff="${h(plan.id)}" value="${plan.max_staff ?? ''}"></label><button class="btn compact-btn" type="button" data-save-plan="${h(plan.id)}">Save plan</button></article>`).join('');
    app.innerHTML = shell('platform-admin', `<header class="overview-head"><div><div class="eyebrow">Docket platform</div><h2>Providers & subscriptions</h2><p class="lead">Payments update these statuses automatically. Use mock checkout to test the lifecycle.</p></div><span class="overview-date">Platform admin</span></header><section class="overview-metrics"><article><span>Providers</span><strong>${data.providers.length}</strong><small>${activeProviders} active</small></article><article><span>Live subscriptions</span><strong>${liveSubscriptions}</strong><small>trialing or active</small></article><article><span>Locations</span><strong>${data.locations.filter(item => item.is_active !== false).length}</strong><small>active outlets</small></article><article><span>Attention</span><strong class="${attention.length ? 'metric-alert' : ''}">${attention.length}</strong><small>past due, blocked or paused</small></article></section><section class="overview-panel platform-provider-list"><div class="section-heading"><div><h3>Provider accounts</h3><p>Choose a plan, then test payment. No real money is moved.</p></div><span class="section-count">${data.providers.length}</span></div>${rows}</section><section class="overview-panel platform-plan-list"><div class="section-heading"><div><h3>Manage plans</h3><p>Edit pricing and account limits. These are catalogue settings, not payment status.</p></div><span class="section-count">${data.plans.length}</span></div>${planCards}<div class="platform-new-plan"><input id="newPlanId" placeholder="plan-id"><input id="newPlanName" placeholder="Plan name"><input id="newPlanPrice" type="number" min="0" step="0.01" placeholder="Monthly RM"><button class="btn compact-btn" type="button" id="addPlan">Add plan</button></div></section>`);
    document.querySelectorAll('[data-open-mock-checkout]').forEach(button => button.onclick = () => { const planId = document.querySelector(`[data-provider-plan="${button.dataset.openMockCheckout}"]`).value; if (!planId) return alert('Choose a plan first.'); location.hash = `#/staff/platform-checkout?provider=${encodeURIComponent(button.dataset.openMockCheckout)}&plan=${encodeURIComponent(planId)}`; });
    document.querySelectorAll('[data-save-plan]').forEach(button => button.onclick = async () => { button.disabled = true; const id = button.dataset.savePlan; try { await api.saveSubscriptionPlan({ id, name: document.querySelector(`[data-plan-name="${id}"]`).value, monthlyPriceMyr: document.querySelector(`[data-plan-price="${id}"]`).value, maxLocations: document.querySelector(`[data-plan-locations="${id}"]`).value, maxStaff: document.querySelector(`[data-plan-staff="${id}"]`).value }); await pagePlatformAdmin(); } catch (error) { button.disabled = false; alert(error?.message || 'Could not save plan.'); } });
    document.getElementById('addPlan').onclick = async () => { const button = document.getElementById('addPlan'); button.disabled = true; try { await api.saveSubscriptionPlan({ id: document.getElementById('newPlanId').value, name: document.getElementById('newPlanName').value, monthlyPriceMyr: document.getElementById('newPlanPrice').value }); await pagePlatformAdmin(); } catch (error) { button.disabled = false; alert(error?.message || 'Could not add plan.'); } };
    wireNav();
  } catch (error) {
    if (myGen !== renderGen) return;
    app.innerHTML = shell('platform-admin', `<div class="eyebrow">Docket platform</div><h2>Could not load platform data</h2><p class="lead" style="color:#b3261e">${h(error?.message || 'Unknown error')}</p><button class="btn" id="retryPlatformAdmin">Try again</button>`);
    wireNav();
    document.getElementById('retryPlatformAdmin').onclick = pagePlatformAdmin;
  }
}

async function pagePlatformCheckout() {
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  const isPlatformOwner = staff.role === 'platform_owner';
  const isProviderOwner = staff.role === 'owner';
  if (!isPlatformOwner && !isProviderOwner) {
    app.innerHTML = shell('platform-checkout', '<div class="eyebrow">Docket platform</div><h2>Platform admin access only</h2><p class="lead">This test checkout is for Docket operators.</p>');
    wireNav();
    return;
  }
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  try {
    const data = isPlatformOwner ? await api.getPlatformAdminData() : await api.getProviderBillingData();
    const provider = isPlatformOwner ? data.providers.find(item => item.id === params.get('provider')) : state.tenants.providers.find(item => item.id === api.getActiveTenant().providerId);
    if (isProviderOwner && params.get('provider') !== api.getActiveTenant().providerId) throw new Error('You can only change your own provider subscription.');
    const plan = data.plans.find(item => item.id === params.get('plan'));
    if (!provider || !plan) throw new Error('Provider or plan could not be found.');
    app.innerHTML = shell('platform-checkout', `<div class="platform-checkout"><div class="eyebrow">Test payment</div><h2>Start ${h(plan.name)} for ${h(provider.name)}</h2><p class="lead">This is a simulated checkout. It does not contact TNG, a bank or a payment gateway.</p><section class="platform-checkout-card"><div class="checkout-summary"><span>Plan</span><strong>${h(plan.name)}</strong><small>${h(plan.description || '')}</small></div><div class="checkout-summary"><span>Monthly price</span><strong>RM ${Number(plan.monthly_price_myr).toFixed(2)}</strong><small>Renews monthly from the successful payment date.</small></div><div class="checkout-summary"><span>Included limits</span><strong>${plan.max_locations ?? 'Unlimited'} locations · ${plan.max_staff ?? 'Unlimited'} staff</strong><small>${plan.max_monthly_bookings ?? 'Unlimited'} bookings per month</small></div><div class="mock-payment-badge">MOCK MODE · NO REAL CHARGE</div><div class="confirmation-actions"><button class="btn secondary" id="cancelMockCheckout" type="button">Cancel</button><button class="btn secondary" id="failMockCheckout" type="button">Simulate failed payment</button><button class="btn" id="successMockCheckout" type="button">Simulate successful payment</button></div></section></div>`);
    document.getElementById('cancelMockCheckout').onclick = () => { location.hash = '#/staff/platform-admin'; };
    document.getElementById('successMockCheckout').onclick = async event => { event.currentTarget.disabled = true; try { await api.simulateMockSubscription({ providerId: provider.id, planId: plan.id, outcome: 'success' }); alert('Mock payment succeeded. The subscription is now active and the next billing date was calculated.'); location.hash = '#/staff/platform-admin'; } catch (error) { event.currentTarget.disabled = false; alert(error?.message || 'Could not simulate payment.'); } };
    document.getElementById('failMockCheckout').onclick = async event => { event.currentTarget.disabled = true; try { await api.simulateMockSubscription({ providerId: provider.id, planId: plan.id, outcome: 'failure' }); alert('Mock payment failed. The subscription is now incomplete and requires payment.'); location.hash = '#/staff/platform-admin'; } catch (error) { event.currentTarget.disabled = false; alert(error?.message || 'Could not simulate payment.'); } };
    wireNav();
  } catch (error) {
    if (myGen !== renderGen) return;
    app.innerHTML = shell('platform-checkout', `<div class="eyebrow">Test payment</div><h2>Could not load checkout</h2><p class="lead" style="color:#b3261e">${h(error?.message || 'Unknown error')}</p><button class="btn" id="backToPlatform" type="button">Back to platform admin</button>`);
    wireNav();
    document.getElementById('backToPlatform').onclick = () => { location.hash = '#/staff/platform-admin'; };
  }
}

async function pageStaffBilling() {
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  if (!['owner', 'platform_owner'].includes(staff.role)) {
    app.innerHTML = shell('billing', '<div class="eyebrow">Account</div><h2>Owner access only</h2><p class="lead">Subscription and payment details are visible to the provider owner.</p>');
    wireNav();
    return;
  }
  try {
    const data = await api.getProviderBillingData();
    if (myGen !== renderGen) return;
    const subscription = data.subscription || {};
    const plan = data.plans.find(item => item.id === subscription.plan_id);
    const status = subscription.status || 'not started';
    const nextBilling = subscription.next_billing_at || subscription.current_period_end;
    const planOptions = data.plans.map(item => `<option value="${h(item.id)}" ${item.id === subscription.plan_id ? 'selected' : ''}>${h(item.name)} · RM ${Number(item.monthly_price_myr).toFixed(2)}/month</option>`).join('');
    const eventRows = data.events.map(event => `<div class="billing-event"><div><strong>${h(String(event.event_type || '').replaceAll('_', ' '))}</strong><span>${h(event.status || '')}</span></div><time>${h(fmtDateTime(event.occurred_at || event.created_at))}</time><b>RM ${Number(event.amount_myr || 0).toFixed(2)}</b></div>`).join('') || '<p class="lead">No payment events recorded yet.</p>';
    app.innerHTML = shell('billing', `<header class="settings-page-head"><div><div class="eyebrow">Account</div><h2>Billing & subscription</h2><p class="lead">Your plan, renewal dates, invoices and payment status.</p></div><span class="history-status ${['past_due', 'incomplete', 'unpaid'].includes(status) ? 'status-alert' : ''}">${h(status.replaceAll('_', ' '))}</span></header>${data.schemaReady ? '' : `<div class="billing-notice"><strong>Billing setup is still being connected.</strong><span>${h(data.warning || 'The screen is showing safe mock data until the billing database migration is available.')}</span></div>`}<section class="billing-summary-grid"><article><span>Current plan</span><strong>${h(plan?.name || 'No plan')}</strong><small>${plan ? `RM ${Number(plan.monthly_price_myr).toFixed(2)} per month` : 'Choose a plan to get started'}</small></article><article><span>Started</span><strong>${subscription.started_at ? h(fmtDateTime(subscription.started_at)) : '—'}</strong><small>${subscription.payment_provider === 'mock' ? 'Test payment' : 'Payment record'}</small></article><article><span>Next billing</span><strong>${nextBilling ? h(fmtDateTime(nextBilling)) : '—'}</strong><small>${subscription.cancel_at_period_end ? 'Ends at period end' : 'Renews automatically'}</small></article></section><section class="overview-panel billing-panel"><div class="section-heading"><div><h3>Manage plan</h3><p>Plan changes should be confirmed through checkout. Existing access remains until the change is applied.</p></div></div><div class="billing-plan-actions"><select id="billingPlan" aria-label="Choose a plan">${planOptions || '<option>No plans available</option>'}</select><button class="btn compact" id="changeBillingPlan" type="button">Change plan</button>${subscription.plan_id ? `<button class="btn secondary compact" id="cancelBillingPlan" type="button">${subscription.cancel_at_period_end ? 'Keep plan' : 'End plan at renewal'}</button>` : ''}</div><p id="billingMessage" class="lead" role="status"></p></section><section class="overview-panel billing-panel"><div class="section-heading"><div><h3>Invoices & payment history</h3><p>Every payment attempt is retained for reconciliation.</p></div><span class="section-count">${data.events.length}</span></div><div class="billing-events">${eventRows}</div></section>`);
    document.getElementById('changeBillingPlan')?.addEventListener('click', () => { const planId = document.getElementById('billingPlan').value; if (planId) location.hash = `#/staff/platform-checkout?provider=${encodeURIComponent(api.getActiveTenant().providerId)}&plan=${encodeURIComponent(planId)}`; });
    document.getElementById('cancelBillingPlan')?.addEventListener('click', async event => { event.currentTarget.disabled = true; try { await api.simulateMockSubscription({ providerId: api.getActiveTenant().providerId, planId: subscription.plan_id, outcome: subscription.cancel_at_period_end ? 'success' : 'cancelled' }); alert(subscription.cancel_at_period_end ? 'The plan remains active.' : 'Mock cancellation recorded. A real gateway will cancel at the period end.'); await pageStaffBilling(); } catch (error) { event.currentTarget.disabled = false; alert(error?.message || 'Could not update the plan.'); } });
    wireNav();
  } catch (error) {
    if (myGen !== renderGen) return;
    app.innerHTML = shell('billing', `<div class="eyebrow">Account</div><h2>Could not load billing</h2><p class="lead" style="color:#b3261e">${h(error?.message || 'Unknown error')}</p><button class="btn" id="retryBilling" type="button">Try again</button>`);
    wireNav();
    document.getElementById('retryBilling').onclick = pageStaffBilling;
  }
}

async function pageStaffOverview() {
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  if (!['owner', 'platform_owner'].includes(staff.role)) {
    app.innerHTML = shell('overview', `<div class="eyebrow">Owner view</div><h2>Owner access only</h2><p class="lead">This overview is for provider owners and platform operators.</p>`);
    wireNav();
    return;
  }
  try {
    const [history, bays, closures] = await Promise.all([api.getBookingHistory(), api.getActiveBays({ includeInactive: true }), api.getBayClosuresForDate(localDateISO(new Date()))]);
    if (myGen !== renderGen) return;
    const today = localDateISO(new Date());
    const todayAppointments = history.filter(item => item.scheduled_date === today && item.status !== 'cancelled');
    const upcoming = history.filter(item => item.status !== 'cancelled' && !item.archived_at && new Date(item.scheduled_at) >= new Date()).sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
    const attention = history.filter(item => item.needs_attention && !item.archived_at);
    const completed = todayAppointments.filter(item => item.status === 'completed').length;
    const cancelled = history.filter(item => item.status === 'cancelled').length;
    const bookedValue = todayAppointments.reduce((sum, item) => sum + Number(item.price_myr || 0), 0);
    const bayUsage = bays.map(bay => ({ bay, count: todayAppointments.filter(item => item.bay_id === bay.id).length })).sort((a, b) => b.count - a.count);
    const attentionMarkup = attention.length ? attention.slice(0, 5).map(item => `<div class="overview-attention-row"><div><strong>${h(item.reference || 'Booking')}</strong><span>${h(item.services?.name || 'Wash')} · ${h(item.scheduled_date || '')} ${h(fmtTime(new Date(item.scheduled_at)))}</span></div><a href="#/staff/board">Review</a></div>`).join('') : '<p class="muted">Nothing requires attention right now.</p>';
    const outageMarkup = closures.length ? closures.map(item => `<div class="overview-attention-row outage-row"><div><strong>${h(item.bays?.name || 'Bay')}</strong><span>${h(fmtTime(new Date(item.starts_at)))}–${h(fmtTime(new Date(item.ends_at)))}${item.reason ? ` · ${h(item.reason)}` : ''}</span></div><span class="tag busy">Bay down</span></div>`).join('') : '<p class="muted">No outages active today.</p>';
    const bayMarkup = bayUsage.length ? bayUsage.map(({ bay, count }) => `<div class="overview-bay-row"><div><strong>${h(bay.name)}</strong><span>${h(bay.status === 'maintenance' ? 'Maintenance' : bay.is_active === false ? 'Inactive' : 'Open')}</span></div><strong>${count} wash${count === 1 ? '' : 'es'}</strong></div>`).join('') : '<p class="muted">No bays configured.</p>';
    const upcomingMarkup = upcoming.slice(0, 6).map(item => `<div class="overview-booking-row"><div><strong>${h(item.reference || 'Booking')}</strong><span>${h(item.services?.name || 'Wash')} · ${h(item.bays?.name || 'Bay')}</span></div><time>${h(item.scheduled_date || '')} · ${h(fmtTime(new Date(item.scheduled_at)))}</time></div>`).join('') || '<p class="muted">No upcoming bookings.</p>';
    app.innerHTML = shell('overview', `<header class="overview-head"><div><div class="eyebrow">Owner monitoring</div><h2>How is the wash running?</h2><p class="lead">A quick view of today’s capacity, bookings and exceptions.</p></div><span class="overview-date">${h(today)}</span></header><section class="overview-metrics"><article><span>Today’s bookings</span><strong>${todayAppointments.length}</strong><small>${completed} completed</small></article><article><span>Booked value</span><strong>RM ${bookedValue.toFixed(2)}</strong><small>today’s scheduled washes</small></article><article><span>Needs attention</span><strong class="${attention.length ? 'metric-alert' : ''}">${attention.length}</strong><small>${closures.length} outage${closures.length === 1 ? '' : 's'} today</small></article><article><span>Cancelled total</span><strong>${cancelled}</strong><small>in available history</small></article></section><div class="overview-grid"><section class="overview-panel overview-attention"><div class="section-heading"><div><h3>Things requiring attention</h3><p>Bookings affected by outages or other exceptions.</p></div><span class="section-count">${attention.length}</span></div>${attentionMarkup}</section><section class="overview-panel"><div class="section-heading"><div><h3>Bay usage today</h3><p>Scheduled washes by bay.</p></div><span class="section-count">${bays.filter(item => item.is_active !== false).length} active</span></div>${bayMarkup}</section><section class="overview-panel"><div class="section-heading"><div><h3>Today’s outages</h3><p>Maintenance windows currently affecting capacity.</p></div><span class="section-count">${closures.length}</span></div>${outageMarkup}</section><section class="overview-panel"><div class="section-heading"><div><h3>Upcoming bookings</h3><p>The next appointments on the schedule.</p></div><span class="section-count">${upcoming.length}</span></div>${upcomingMarkup}</section></div>`);
    wireNav();
  } catch (error) {
    if (myGen !== renderGen) return;
    app.innerHTML = shell('overview', `<div class="eyebrow">Owner monitoring</div><h2>Could not load overview</h2><p class="lead" style="color:#b3261e">${h(error?.message || 'Unknown error')}</p><button class="btn" id="retryOverview">Try again</button>`);
    wireNav();
    document.getElementById('retryOverview').onclick = pageStaffOverview;
  }
}

async function pageStaffAnalytics() {
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  if (!['owner', 'platform_owner'].includes(staff.role)) {
    app.innerHTML = shell('analytics', `<div class="eyebrow">Owner analytics</div><h2>Owner access only</h2><p class="lead">This page is for provider owners and platform operators.</p>`);
    wireNav();
    return;
  }
  try {
    const [history, bays, settings] = await Promise.all([api.getBookingHistory(), api.getActiveBays({ includeInactive: true }), api.getBookingSettings()]);
    if (myGen !== renderGen) return;
    const today = localDateISO(new Date());
    const render = (days = 30) => {
      const end = new Date(`${today}T23:59:59+08:00`);
      const start = new Date(end.getTime() - (Number(days) - 1) * 86400000);
      const startISO = localDateISO(start);
      const range = history.filter(item => item.scheduled_date >= startISO && item.scheduled_date <= today);
      const active = range.filter(item => item.status !== 'cancelled');
      const completed = active.filter(item => item.status === 'completed').length;
      const cancelled = range.filter(item => item.status === 'cancelled').length;
      const value = active.reduce((sum, item) => sum + Number(item.price_myr || 0), 0);
      const serviceCounts = Object.values(active.reduce((map, item) => { const name = item.services?.name || 'Other'; map[name] ||= { name, count: 0, value: 0 }; map[name].count += 1; map[name].value += Number(item.price_myr || 0); return map; }, {})).sort((a, b) => b.count - a.count);
      const bayCounts = bays.map(bay => ({ name: bay.name, count: active.filter(item => item.bay_id === bay.id).length })).sort((a, b) => b.count - a.count);
      const bookedMinutes = active.reduce((sum, item) => sum + Number(item.duration_minutes || item.services?.duration_minutes || 0), 0);
      const openMinutes = Math.max(0, Number(settings.weekday_close?.slice(0, 2) || 0) * 60 - Number(settings.weekday_open?.slice(0, 2) || 0) * 60);
      const capacityMinutes = openMinutes * Math.max(1, bays.filter(item => item.is_active !== false && item.status !== 'maintenance').length) * Number(days);
      const utilization = capacityMinutes ? Math.min(100, Math.round(bookedMinutes / capacityMinutes * 100)) : 0;
      const completionRate = active.length ? Math.round(completed / active.length * 100) : 0;
      const cancellationRate = range.length ? Math.round(cancelled / range.length * 100) : 0;
      const topServices = serviceCounts.slice(0, 5).map(item => `<div class="analytics-row"><div><strong>${h(item.name)}</strong><span>${item.count} booking${item.count === 1 ? '' : 's'}</span></div><strong>RM ${item.value.toFixed(2)}</strong></div>`).join('') || '<p class="muted">No bookings in this period.</p>';
      const topBays = bayCounts.slice(0, 5).map(item => `<div class="analytics-row"><div><strong>${h(item.name)}</strong><span>Scheduled washes</span></div><strong>${item.count}</strong></div>`).join('') || '<p class="muted">No bay data in this period.</p>';
      app.innerHTML = shell('analytics', `<header class="overview-head"><div><div class="eyebrow">Owner analytics</div><h2>Know what is driving the wash</h2><p class="lead">Demand, revenue and operating performance for the selected outlet.</p></div><label class="analytics-filter">Period<select id="analyticsRange"><option value="7" ${days === 7 ? 'selected' : ''}>Last 7 days</option><option value="30" ${days === 30 ? 'selected' : ''}>Last 30 days</option><option value="90" ${days === 90 ? 'selected' : ''}>Last 90 days</option></select></label></header><section class="overview-metrics"><article><span>Bookings</span><strong>${range.length}</strong><small>${completed} completed · ${cancelled} cancelled</small></article><article><span>Booked value</span><strong>RM ${value.toFixed(2)}</strong><small>before refunds or fees</small></article><article><span>Completion rate</span><strong>${completionRate}%</strong><small>${active.length ? 'of non-cancelled bookings' : 'No bookings yet'}</small></article><article><span>Bay utilization</span><strong>${utilization}%</strong><small>${bookedMinutes} booked minutes</small></article></section><section class="analytics-summary"><div><span>Cancellation rate</span><strong>${cancellationRate}%</strong><small>includes all cancellations in range</small></div><div><span>Active bays</span><strong>${bays.filter(item => item.is_active !== false && item.status !== 'maintenance').length}</strong><small>excluding maintenance bays</small></div><div><span>Top service</span><strong>${h(serviceCounts[0]?.name || '—')}</strong><small>${serviceCounts[0] ? `${serviceCounts[0].count} bookings` : 'No data yet'}</small></div></section><div class="overview-grid"><section class="overview-panel"><div class="section-heading"><div><h3>Popular services</h3><p>Which services customers are choosing.</p></div></div>${topServices}</section><section class="overview-panel"><div class="section-heading"><div><h3>Bay workload</h3><p>Bookings assigned to each bay.</p></div></div>${topBays}</section></div>`);
      document.getElementById('analyticsRange')?.addEventListener('change', event => render(Number(event.target.value)));
      wireNav();
    };
    render();
  } catch (error) {
    if (myGen !== renderGen) return;
    app.innerHTML = shell('analytics', `<div class="eyebrow">Owner analytics</div><h2>Could not load analytics</h2><p class="lead" style="color:#b3261e">${h(error?.message || 'Unknown error')}</p><button class="btn" id="retryAnalytics">Try again</button>`);
    wireNav();
    document.getElementById('retryAnalytics').onclick = pageStaffAnalytics;
  }
}

async function pageStaffSettings() {
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  if (!['owner', 'platform_owner', 'manager'].includes(staff.role)) {
    app.innerHTML = shell('settings', `<div class="eyebrow">Configuration</div><h2>Owner only</h2><p class="lead">Ask the owner to change booking settings.</p>`);
    wireNav();
    return;
  }

  const [s, bays, breaks] = await Promise.all([
    api.getBookingSettings(),
    api.getActiveBays(),
    api.getCrewBreaks(),
  ]);
  if (myGen !== renderGen) return;

  const bayOptions = bays.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  const breakRows = breaks.map(b => `
    <div class="settings-row">
      <div>${b.bays?.name ?? b.bay_id} — ${b.start_time} for ${b.duration_minutes} min</div>
      <button class="mini-btn" data-remove-break="${b.id}">Remove</button>
    </div>`).join('') || '<p class="lead">No crew breaks scheduled yet.</p>';

  app.innerHTML = shell('settings', `
    <header class="settings-page-head"><div><div class="eyebrow">Configuration</div><h2>Booking settings</h2><p class="lead">Rules shared by customer booking, Telegram and the bay board.</p></div><button class="btn settings-save" id="save">Save changes</button></header>
    <div class="settings-dashboard">
      <section class="settings-block settings-card">
        <div class="section-heading"><div><h3>Booking rules</h3><p>Control how early and how far ahead customers can book.</p></div><span class="section-icon">01</span></div>
        <div class="settings-row"><div><strong>Minimum lead time</strong><small>Notice required before an appointment</small></div><label class="compact-number"><input id="lead" type="text" inputmode="numeric" pattern="[0-9]*" value="${s.min_lead_minutes}"><span>min</span></label></div>
        <div class="settings-row"><div><strong>Advance window</strong><small>Furthest date customers may select</small></div><label class="compact-number"><input id="advance" type="text" inputmode="numeric" pattern="[0-9]*" value="${s.max_advance_days}"><span>days</span></label></div>
        <div class="settings-row"><div><strong>Bay buffer</strong><small>Rest time after every wash</small></div><label class="compact-number"><input id="buffer" type="text" inputmode="numeric" pattern="[0-9]*" value="${s.buffer_minutes}"><span>min</span></label></div>
      </section>

      <section class="settings-block settings-card">
        <div class="section-heading"><div><h3>Operating hours</h3><p>Availability shown to customers and staff.</p></div><span class="section-icon">02</span></div>
        <div class="hours-grid-head" aria-hidden="true"><span></span><span>Opens</span><span>Closes</span></div>
        <div class="hours-row"><strong>Weekdays</strong><label class="hours-control"><span>Opens</span><input id="weekdayOpen" type="time" value="${s.weekday_open.slice(0,5)}"></label><label class="hours-control"><span>Closes</span><input id="weekdayClose" type="time" value="${s.weekday_close.slice(0,5)}"></label></div>
        <div class="hours-row"><strong>Weekends</strong><label class="hours-control"><span>Opens</span><input id="weekendOpen" type="time" value="${s.weekend_open.slice(0,5)}"></label><label class="hours-control"><span>Closes</span><input id="weekendClose" type="time" value="${s.weekend_close.slice(0,5)}"></label></div>
      </section>
    </div>

    <section class="settings-block crew-break-card">
      <div class="section-heading"><div><h3>Crew breaks</h3><p>Recurring daily breaks by bay. Stagger them to preserve capacity.</p></div><span class="section-count">${breaks.length} scheduled</span></div>
      <div class="break-list">${breakRows}</div>
      <div class="crew-break-form">
        <label class="crew-control"><span>Bay</span><select id="breakBay">${bayOptions}</select></label>
        <label class="crew-control"><span>Start</span><input id="breakStart" type="time" value="14:30"></label>
        <label class="crew-control"><span>Duration</span><div class="compact-number"><input id="breakDuration" type="text" inputmode="numeric" pattern="[0-9]*" value="30" title="minutes"><span>min</span></div></label>
        <button class="mini-btn" id="addBreak">Add break</button>
      </div>
    </section>
  `);

  document.getElementById('save').onclick = async () => {
    try {
      await api.updateBookingSettings({
        min_lead_minutes: Number(document.getElementById('lead').value),
        max_advance_days: Number(document.getElementById('advance').value),
        buffer_minutes: Number(document.getElementById('buffer').value),
        weekday_open: document.getElementById('weekdayOpen').value,
        weekday_close: document.getElementById('weekdayClose').value,
        weekend_open: document.getElementById('weekendOpen').value,
        weekend_close: document.getElementById('weekendClose').value,
      });
      if (myGen !== renderGen) return;
      alert('Saved.');
    } catch (error) {
      alert(`Could not save settings: ${error?.message || 'Unknown error'}`);
    }
  };
  document.getElementById('addBreak').onclick = async () => {
    await api.setCrewBreak({
      bayId: document.getElementById('breakBay').value,
      startTime: document.getElementById('breakStart').value,
      durationMinutes: Number(document.getElementById('breakDuration').value)
    });
    if (myGen !== renderGen) return;
    pageStaffSettings();
  };
  document.querySelectorAll('[data-remove-break]').forEach(el => el.onclick = async () => {
    await api.removeCrewBreak(el.dataset.removeBreak);
    if (myGen !== renderGen) return;
    pageStaffSettings();
  });
  wireNav();
}

async function pageStaffOrganization() {
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  if (!['platform_owner', 'owner', 'manager'].includes(staff.role)) {
    app.innerHTML = shell('organization', `<div class="eyebrow">Management</div><h2>Manager access required</h2><p class="lead">Workers can view the board but cannot change the business setup.</p>`);
    wireNav();
    return;
  }
  const tenant = api.getActiveTenant();
  const provider = state.tenants.providers.find(item => item.id === tenant.providerId);
  const location = state.tenants.locations.find(item => item.id === tenant.locationId);
  const [services, bays, staffMembers] = await Promise.all([
    api.getServices({ includeInactive: true }), api.getActiveBays({ includeInactive: true }), api.listStaff(),
  ]);
  if (myGen !== renderGen) return;

  const serviceRows = services.map(service => `<div class="manage-grid manage-service" data-service-row="${h(service.id)}">
    <label class="manage-control"><span>Service</span><input data-field="name" value="${h(service.name)}" aria-label="Service name"></label>
    <label class="manage-control"><span>Dur</span><input data-field="duration" type="number" min="1" value="${Number(service.duration_minutes)}" aria-label="Duration in minutes"></label>
    <label class="manage-control"><span>RM</span><input data-field="price" type="number" min="0" step="0.01" value="${Number(service.price_myr)}" aria-label="Price in ringgit"></label>
    <label class="check service-active"><input data-field="active" type="checkbox" ${service.is_active !== false ? 'checked' : ''}><span>Book</span></label>
    <button class="mini-btn" data-save-service="${h(service.id)}">Save</button>
  </div>`).join('') || '<p class="lead">No services configured for this location.</p>';
  const bayRows = bays.map(bay => `<div class="manage-grid manage-bay" data-bay-row="${h(bay.id)}">
    <label class="manage-control"><span>Bay</span><input data-field="name" value="${h(bay.name)}" aria-label="Bay name"></label>
    <label class="manage-control"><span>Status</span><select data-field="status"><option value="open" ${bay.status !== 'maintenance' ? 'selected' : ''}>Open</option><option value="maintenance" ${bay.status === 'maintenance' ? 'selected' : ''}>Maintenance</option></select></label>
    <label class="check bay-active"><input data-field="active" type="checkbox" ${bay.is_active !== false ? 'checked' : ''}><span>Active</span></label>
    <button class="mini-btn" data-save-bay="${h(bay.id)}">Save</button>
  </div>`).join('') || '<p class="lead">No bays configured for this location.</p>';
  const staffRows = staffMembers.map(member => `<div class="settings-row"><div><strong>${h(member.name || member.email || member.id)}</strong><div class="muted">${h(member.email || member.id)} · ${h(member.role)}</div></div><div class="row-actions"><span class="tag ${member.pending ? 'pending' : member.is_active === false ? 'busy' : ''}">${member.pending ? 'Invitation pending' : member.is_active === false ? 'Inactive' : 'Active'}</span>${member.is_active !== false && member.id !== staff.id ? `<button class="mini-btn danger-outline" data-remove-staff data-staff-id="${member.pending ? '' : h(member.id)}" data-invitation-id="${member.pending ? h(member.id) : ''}">${member.pending ? 'Cancel invitation' : 'Remove access'}</button>` : ''}</div></div>`).join('') || '<p class="lead">No staff assigned to this location.</p>';
  const providerProfileSection = ['platform_owner', 'owner'].includes(staff.role)
    ? `<section class="management-section profile-section"><div class="section-heading"><div><h3>Provider profile</h3><p>Public information shown in the customer catalogue.</p></div><span class="section-icon">01</span></div><div class="manage-form"><div class="field"><label>Provider name</label><input id="providerName" value="${h(provider?.name || '')}"></div><div class="field"><label>Description</label><input id="providerDescription" value="${h(provider?.description || '')}" placeholder="What makes this car wash different?"></div></div><button class="btn compact" id="saveProviderProfile">Save profile</button></section>`
    : `<section class="management-section profile-section"><div class="section-heading"><div><h3>Provider profile</h3><p>Public information shown in the customer catalogue.</p></div></div><p class="lead">${h(provider?.name || tenant.providerId)}${provider?.description ? ` — ${h(provider.description)}` : ''}</p></section>`;

  app.innerHTML = shell('organization', `
    <header class="manage-page-head"><div><div class="eyebrow">Business setup</div><h2>${h(provider?.name || tenant.providerId)}</h2><p class="lead">Configure ${h(location?.name || 'this location')} without affecting other outlets.</p></div><div class="manage-summary"><span><strong>${services.length}</strong> services</span><span><strong>${bays.length}</strong> bays</span><span><strong>${staffMembers.length}</strong> staff</span></div></header>

    <div class="management-top-grid">
      ${providerProfileSection}
      <section class="management-section location-section">
      <div class="section-heading"><div><h3>Location</h3><p>Outlet identity, address and local timezone.</p></div><span class="section-icon">02</span></div>
      <div class="manage-form two-col">
        <div class="field"><label>Location name</label><input id="locationName" value="${h(location?.name || '')}"></div>
        <div class="field"><label>Timezone</label><input id="locationTimezone" value="${h(location?.timezone || 'Asia/Kuala_Lumpur')}"></div>
        <div class="field span-two"><label>Address</label><input id="locationAddress" value="${h(location?.address || '')}"></div>
      </div>
      <button class="btn compact" id="saveLocation">Save location</button>
      </section>
    </div>

    <div class="management-ops-grid">
    <section class="management-section services-section">
      <div class="section-heading"><div><h3>Services</h3><p>Customer-facing wash menu for this location.</p></div><span class="section-count">${services.length} total</span></div>
      <div class="manage-service-head" aria-hidden="true"><span>Name</span><span>Dur</span><span>RM</span><span>Book</span><span>Save</span></div><div class="manage-list">${serviceRows}</div>
      <div class="manage-grid manage-service new-row">
        <label class="manage-control"><span>Service</span><input id="newServiceName" placeholder="New service"></label>
        <label class="manage-control"><span>Dur</span><input id="newServiceDuration" type="number" min="1" value="30" aria-label="Duration"></label>
        <label class="manage-control"><span>RM</span><input id="newServicePrice" type="number" min="0" step="0.01" value="0" aria-label="Price"></label>
        <span></span><button class="mini-btn" id="addService">Add</button>
      </div>
    </section>

    <section class="management-section bays-section">
      <div class="section-heading"><div><h3>Bays</h3><p>Capacity and current operating state.</p></div><span class="section-count">${bays.length} total</span></div>
      <div class="manage-bay-head" aria-hidden="true"><span>Name</span><span>Status</span><span>Active</span><span>Save</span></div><div class="manage-list">${bayRows}</div>
      <div class="manage-grid manage-bay new-row"><label class="manage-control"><span>Bay</span><input id="newBayName" placeholder="New bay"></label><span class="new-bay-status">Open</span><span></span><button class="mini-btn" id="addBay">Add</button></div>
    </section>
    </div>

    <div class="management-admin-grid">
    ${staff.role !== 'manager' ? `<section class="management-section staff-section">
      <div class="section-heading"><div><h3>Staff access</h3><p>Invite a staff member by email. They can create an account after you save the invitation.</p></div><span class="section-count">${staffMembers.length} people</span></div><div class="manage-list staff-list">${staffRows}</div>
      <div class="manage-form three-col">
        <div class="field"><label>Staff email</label><input id="staffEmail" type="email" placeholder="staff@example.com"></div>
        <div class="field"><label>Name</label><input id="staffName" placeholder="Staff name"></div>
        <div class="field"><label>Role</label><select id="staffRole"><option value="worker">Worker</option><option value="manager">Manager</option><option value="owner">Owner</option></select></div>
        </div><p id="staffMessage" class="lead" role="status"></p><button class="btn compact" id="addStaff">Add or update staff</button>
    </section>` : ''}

    ${['platform_owner', 'owner'].includes(staff.role) ? `<section class="management-section locations-section">
      <div class="section-heading"><div><h3>Add an outlet</h3><p>Create another location under this provider.</p></div><span class="section-icon">+</span></div>
      <div class="manage-form two-col">
        <div class="field"><label>New location name</label><input id="newLocationName" placeholder="Outlet name"></div>
        <div class="field"><label>Address</label><input id="newLocationAddress" placeholder="Address"></div>
      </div><button class="btn compact" id="addLocation">Add location to ${h(provider?.name || tenant.providerId)}</button>
    </section>` : ''}
    </div>
    ${staff.role === 'platform_owner' ? `<section class="management-section platform-section">
      <h3>Platform administration</h3>
      <p class="lead">Create another independent car-wash provider.</p>
      <div class="manage-form two-col">
        <div class="field"><label>New provider name</label><input id="newProviderName" placeholder="Provider name"></div>
        <div class="field action-field"><button class="btn compact" id="addProvider">Create provider</button></div>
      </div>
    </section>` : ''}
  `);

  const refresh = () => pageStaffOrganization();
  const showManageError = error => alert(`Could not save this change: ${error?.message || 'Unknown error'}`);
  document.getElementById('saveProviderProfile')?.addEventListener('click', async () => {
    try { await api.updateProvider(tenant.providerId, { name: document.getElementById('providerName').value.trim(), description: document.getElementById('providerDescription').value.trim() }); state.tenants = await api.getAccessibleTenants(staff); refresh(); } catch (error) { showManageError(error); }
  });
  document.getElementById('saveLocation').onclick = async () => {
    try { await api.updateLocation(tenant.locationId, { name: document.getElementById('locationName').value.trim(), address: document.getElementById('locationAddress').value.trim(), timezone: document.getElementById('locationTimezone').value.trim() }); state.tenants = await api.getAccessibleTenants(staff); refresh(); } catch (error) { showManageError(error); }
  };
  document.querySelectorAll('[data-save-service]').forEach(button => button.onclick = async () => {
    try { const row = document.querySelector(`[data-service-row="${CSS.escape(button.dataset.saveService)}"]`); await api.saveService({ id: button.dataset.saveService, name: row.querySelector('[data-field="name"]').value, durationMinutes: row.querySelector('[data-field="duration"]').value, priceMyr: row.querySelector('[data-field="price"]').value, isActive: row.querySelector('[data-field="active"]').checked }); refresh(); } catch (error) { showManageError(error); }
  });
  document.getElementById('addService').onclick = async () => {
    try { const name = document.getElementById('newServiceName').value.trim(); if (!name) return alert('Enter a service name.'); await api.saveService({ name, durationMinutes: document.getElementById('newServiceDuration').value, priceMyr: document.getElementById('newServicePrice').value }); refresh(); } catch (error) { showManageError(error); }
  };
  document.querySelectorAll('[data-save-bay]').forEach(button => button.onclick = async () => {
    try { const row = document.querySelector(`[data-bay-row="${CSS.escape(button.dataset.saveBay)}"]`); await api.saveBay({ id: button.dataset.saveBay, name: row.querySelector('[data-field="name"]').value, status: row.querySelector('[data-field="status"]').value, isActive: row.querySelector('[data-field="active"]').checked }); refresh(); } catch (error) { showManageError(error); }
  });
  document.getElementById('addBay').onclick = async () => {
    try { const name = document.getElementById('newBayName').value.trim(); if (!name) return alert('Enter a bay name.'); await api.saveBay({ name }); refresh(); } catch (error) { showManageError(error); }
  };
  document.getElementById('addStaff')?.addEventListener('click', async event => {
    const email = document.getElementById('staffEmail').value.trim(); if (!email) return alert('Enter the staff email.');
    const button = event.currentTarget; const message = document.getElementById('staffMessage'); button.disabled = true; message.textContent = 'Saving staff access…';
    try { const result = await api.saveStaff({ email, name: document.getElementById('staffName').value, role: document.getElementById('staffRole').value }); message.textContent = result?.emailSent ? 'Invitation sent. Staff should open the email and choose a password or continue with Google.' : (result?.status === 'active' ? 'Staff access saved.' : 'Invitation saved.'); refresh(); } catch (error) { message.textContent = `Could not save staff access: ${error?.message || 'Unknown error'}`; } finally { button.disabled = false; }
  });
  document.querySelectorAll('[data-remove-staff]').forEach(button => button.addEventListener('click', async () => {
    const label = button.dataset.invitationId ? 'cancel this pending invitation' : 'remove this staff member’s access';
    if (!window.confirm(`Are you sure you want to ${label}? Existing bookings and history will be kept.`)) return;
    button.disabled = true;
    try { await api.revokeStaffAccess({ staffId: button.dataset.staffId || null, invitationId: button.dataset.invitationId || null }); refresh(); }
    catch (error) { alert(`Could not remove staff access: ${error?.message || 'Unknown error'}`); button.disabled = false; }
  }));
  document.getElementById('addProvider')?.addEventListener('click', async () => {
    try { const name = document.getElementById('newProviderName').value.trim(); if (!name) return alert('Enter a provider name.'); await api.createProvider({ name }); state.tenants = await api.getAccessibleTenants(staff); refresh(); } catch (error) { showManageError(error); }
  });
  document.getElementById('addLocation')?.addEventListener('click', async () => {
    try { const name = document.getElementById('newLocationName').value.trim(); if (!name) return alert('Enter a location name.'); const created = await api.createLocation({ name, address: document.getElementById('newLocationAddress').value }); api.setActiveTenant(created.provider_id, created.id); state.tenants = await api.getAccessibleTenants(staff); refresh(); } catch (error) { showManageError(error); }
  });
  wireNav();
}

function pageCustomerLanding() {
  app.innerHTML = `<div class="app-shell landing-shell">
    <div class="topbar landing-topbar"><div class="brand"><div class="drop"></div> Docket</div><a class="topbar-link" href="#/staff/login">Provider & staff sign in</a></div>
    <main class="screen landing-screen">
      <section class="landing-hero" aria-labelledby="landing-title">
        <div class="eyebrow">Car wash bookings, made simple</div>
        <h1 id="landing-title">Find a wash that fits your day.</h1>
        <p class="lead">Compare local car wash providers, prices and live availability in one place.</p>
        <div class="landing-actions" aria-label="Booking options">
          <a class="landing-action primary" href="#/book"><span><strong>Book as a guest</strong><small>Fast booking with just your name and mobile number</small></span><span aria-hidden="true">→</span></a>
          <button class="landing-action" type="button" data-customer-login><span><strong>Sign in or create an account</strong><small>Save vehicles, view history and rebook faster</small></span><span aria-hidden="true">→</span></button>
        </div>
        <p class="landing-note" id="customerLoginNote" role="status" hidden>Customer accounts are being prepared. You can book now as a guest without losing your booking reference.</p>
      </section>
      <section class="landing-steps" aria-label="How booking works">
        <div><span class="step-number">1</span><strong>Choose when</strong><small>Search by date and preferred time</small></div>
        <div><span class="step-number">2</span><strong>Compare nearby</strong><small>See providers, services and prices</small></div>
        <div><span class="step-number">3</span><strong>Book a real slot</strong><small>Get a reference instantly</small></div>
      </section>
      <section class="landing-secondary" aria-labelledby="manage-title">
        <div><div class="eyebrow">Already booked?</div><h2 id="manage-title">Manage your appointment</h2><p class="lead">Use your reference number and mobile number to move or cancel a booking.</p></div>
        <a class="btn secondary landing-manage" href="#/book">Find my booking</a>
      </section>
    </main>
  </div>`;
  document.querySelector('[data-customer-login]').onclick = () => {
    const note = document.getElementById('customerLoginNote');
    note.hidden = false;
  };
}

async function pageCustomerBook() {
  app.innerHTML = `<div class="app-shell customer-book-shell"><div class="topbar customer-book-topbar"><div class="brand"><div class="drop"></div>Docket</div><a class="topbar-link" href="#/">Back to home</a></div><div class="screen customer-book-screen"><div class="customer-book-heading"><div><div class="customer-kicker">Car wash booking</div><h1>Find a wash that fits your day.</h1><p class="lead">Choose a time or provider, then pick an available service.</p></div></div><div id="customerBook" class="card">Loading providers…</div></div></div>`;
  const root = document.getElementById('customerBook');
  try {
    const catalogue = await loadCatalogue();
    const providers = catalogue.providers || [];
    const locations = catalogue.locations || [];
    const services = catalogue.services || [];
    if (!providers.length || !locations.length || !services.length) throw new Error('No bookable providers are available yet.');
    const discoveryCards = providers.map(provider => { const providerLocations = locations.filter(location => location.provider_id === provider.id); return `<article class="provider-card" data-provider-search="${h([provider.name, provider.description, ...providerLocations.flatMap(location => [location.name, location.address, ...services.filter(service => service.provider_id === provider.id && service.location_id === location.id).map(service => service.name)])].join(' ').toLowerCase())}"><div class="provider-card-head"><div><h3>${h(provider.name)}</h3><p>${h(provider.description || 'Car wash provider')}</p></div><span class="provider-count">${providerLocations.length} location${providerLocations.length === 1 ? '' : 's'}</span></div>${providerLocations.map(location => { const locationServices = services.filter(service => service.provider_id === provider.id && service.location_id === location.id); return `<div class="location-card"><div class="location-card-head"><div><strong>${h(location.name)}</strong><small>${h(location.address || 'Location details available after selection')}</small></div><button class="mini-btn" data-choose-location="${h(provider.id)}|${h(location.id)}" type="button">View services</button></div><div class="service-chips">${locationServices.length ? locationServices.map(service => `<span>${h(service.name)} · ${service.duration_minutes} min · RM ${Number(service.price_myr).toFixed(2)}</span>`).join('') : '<span>No services listed yet</span>'}</div></div>`; }).join('') || '<p class="lead">No active locations yet.</p>'}</article>`; }).join('');
    root.innerHTML = `<section class="provider-discovery"><div class="booking-search-head"><div><h2>Find an available wash</h2><p class="lead">Search by time, or choose a provider you already know.</p></div></div><form id="availabilitySearch" class="availability-search"><div class="availability-mode" role="group" aria-label="Search booking options"><button class="mode-btn active" type="button" data-search-mode="time">Find a time</button><button class="mode-btn" type="button" data-search-mode="provider">Browse providers</button></div><div class="field"><label for="catalogueDate">Date</label><input id="catalogueDate" type="date" required></div><div class="field"><label for="catalogueTime">Time <span class="muted">(optional)</span></label><input id="catalogueTime" type="time"></div><div class="field provider-filter-field" hidden><label for="catalogueProvider">Provider</label><select id="catalogueProvider"><option value="">All providers</option>${providers.map(provider => `<option value="${h(provider.id)}">${h(provider.name)}</option>`).join('')}</select></div><button class="btn" type="submit">Show available washes</button></form><p id="availabilityMessage" class="lead" role="status"></p><div id="availabilityResults" class="provider-cards" hidden></div></section><section class="customer-manage card"><h3>Manage an existing booking</h3><p class="lead">Use your booking reference and mobile number to view, cancel or move it.</p><form id="manageForm"><div class="field"><label for="manageReference">Booking reference</label><input id="manageReference" placeholder="WP-T1-20260823-ABC123" required></div><div class="field"><label for="managePhone">Phone number</label><input id="managePhone" type="tel" placeholder="012-3456789" required></div><button class="btn find-booking-btn" type="submit">Find my booking</button></form><div id="manageResult" role="status"></div></section>`;
    const searchDateEl = document.getElementById('catalogueDate'); const searchTimeEl = document.getElementById('catalogueTime'); const providerFilterEl = document.getElementById('catalogueProvider'); const providerFilterField = document.querySelector('.provider-filter-field'); const availabilityResults = document.getElementById('availabilityResults'); const availabilityMessage = document.getElementById('availabilityMessage'); let searchMode = 'time';
    document.querySelectorAll('[data-search-mode]').forEach(button => button.onclick = () => { searchMode = button.dataset.searchMode; document.querySelectorAll('[data-search-mode]').forEach(item => item.classList.toggle('active', item === button)); providerFilterField.hidden = searchMode !== 'provider'; document.getElementById('availabilitySearch').querySelector('button[type="submit"]').textContent = searchMode === 'provider' ? 'Show provider availability' : 'Show available washes'; });
    const minDate = localDateISO(new Date()); const maxDate = shiftDate(minDate, 14);
    searchDateEl.min = minDate; searchDateEl.max = maxDate; searchDateEl.value = minDate;
    const openBookingSheet = ({ providerId, locationId, serviceId, date, time }) => {
      const provider = providers.find(item => item.id === providerId); const location = locations.find(item => item.id === locationId); const service = services.find(item => item.id === serviceId);
      const overlay = document.createElement('div'); overlay.className = 'modal-overlay booking-sheet-overlay';
      overlay.innerHTML = `<div class="modal-card booking-sheet" role="dialog" aria-modal="true" aria-labelledby="booking-sheet-title"><button class="modal-close" id="closeBookingSheet" type="button" aria-label="Close booking form">×</button><div class="eyebrow">Ready to book</div><h3 id="booking-sheet-title">${h(service?.name || 'Car wash')}</h3><div class="booking-summary"><strong>${h(provider?.name || '')}</strong><span>${h(location?.name || '')}</span><span>${h(date)} · ${h(time)}</span><span>RM ${Number(service?.price_myr || 0).toFixed(2)} · ${Number(service?.duration_minutes || 0)} min</span></div><form id="bookingSheetForm"><div class="field"><label for="sheetName">Your name</label><input id="sheetName" autocomplete="name" required></div><div class="field"><label for="sheetPhone">Malaysian mobile number</label><input id="sheetPhone" type="tel" placeholder="012-3456789" autocomplete="tel" required></div><p id="sheetMessage" class="lead" role="status"></p><button class="btn" type="submit">Confirm this booking</button></form></div>`;
      document.body.appendChild(overlay); const form = overlay.querySelector('#bookingSheetForm'); const message = overlay.querySelector('#sheetMessage'); const close = () => overlay.remove(); overlay.querySelector('#closeBookingSheet').onclick = close; overlay.onclick = event => { if (event.target === overlay) close(); }; form.onsubmit = async event => { event.preventDefault(); const submit = form.querySelector('button[type="submit"]'); submit.disabled = true; message.textContent = 'Checking the slot…'; try { const result = await createBooking({ provider_id: providerId, location_id: locationId, service_id: serviceId, date, time, name: form.querySelector('#sheetName').value.trim(), phone: form.querySelector('#sheetPhone').value.trim() }); overlay.querySelector('.booking-sheet').innerHTML = `<div class="eyebrow">Booking confirmed</div><h3>Your wash is booked</h3><p class="lead">Keep this reference for your appointment.</p><div class="booking-summary"><strong>${h(result.reference)}</strong><span>${h(service?.name || '')}</span><span>${h(location?.name || '')}</span><span>${h(date)} · ${h(time)}</span><span>RM ${Number(service?.price_myr || result.service?.price_myr || 0).toFixed(2)}</span></div><div class="confirmation-actions"><button class="btn" id="bookAnother" type="button">Book another wash</button><button class="btn secondary" id="closeConfirmation" type="button">Done</button></div>`; overlay.querySelector('#closeConfirmation').onclick = close; overlay.querySelector('#bookAnother').onclick = () => { close(); pageCustomerBook(); }; } catch (error) { submit.disabled = false; message.textContent = error?.message || 'Could not book this slot.'; } };
    };
    const wireChoiceButtons = () => { document.querySelectorAll('[data-choose-location]').forEach(button => button.onclick = () => { button.closest('.location-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }); document.querySelectorAll('[data-choose-slot]').forEach(button => button.onclick = () => { const [providerId, locationId, serviceId, date, time] = button.dataset.chooseSlot.split('|'); openBookingSheet({ providerId, locationId, serviceId, date, time }); }); };
    document.getElementById('availabilitySearch').onsubmit = async event => { event.preventDefault(); const date = searchDateEl.value; const time = searchTimeEl.value; const selectedProviderId = searchMode === 'provider' ? providerFilterEl.value : ''; document.getElementById('providerCards').hidden = true; availabilityResults.hidden = false; availabilityResults.innerHTML = '<div class="card"><p class="lead">Checking live availability…</p></div>'; availabilityMessage.textContent = ''; try { const result = await searchAvailability({ date, time }); const matches = selectedProviderId ? result.matches.filter(match => match.provider.id === selectedProviderId) : result.matches; if (!matches.length) { availabilityResults.innerHTML = `<div class="card"><p class="lead">No available wash${selectedProviderId ? ' for this provider' : 'es'}${time ? ` at ${h(time)}` : ''} on ${h(date)}. Try another time or date.</p></div>`; return; } const groups = new Map(); matches.forEach(match => { const key = `${match.provider.id}|${match.location.id}`; if (!groups.has(key)) groups.set(key, { provider: match.provider, location: match.location, services: [] }); groups.get(key).services.push(match); }); availabilityResults.innerHTML = [...groups.values()].map(group => `<article class="provider-card"><div class="provider-card-head"><div><h3>${h(group.provider.name)}</h3><p>${h(group.location.name)}${group.location.address ? ` · ${h(group.location.address)}` : ''}</p></div><span class="provider-count">${group.services.length} service${group.services.length === 1 ? '' : 's'} available</span></div>${group.services.map(match => `<div class="availability-service"><div><strong>${h(match.service.name)}</strong><small>${match.service.duration_minutes} min · RM ${Number(match.service.price_myr).toFixed(2)}</small></div><div class="availability-slots">${match.slots.map(slot => `<button class="slot-chip" data-choose-slot="${h(group.provider.id)}|${h(group.location.id)}|${h(match.service.id)}|${h(date)}|${h(slot)}" type="button">${h(slot)}</button>`).join('')}</div></div>`).join('')}</article>`).join(''); wireChoiceButtons(); } catch (error) { availabilityResults.innerHTML = `<div class="card"><p class="lead" style="color:#b3261e">${h(error.message)}</p></div>`; } };
    document.getElementById('availabilitySearch').onsubmit = async event => { event.preventDefault(); const date = searchDateEl.value; const time = searchTimeEl.value; const selectedProviderId = searchMode === 'provider' ? providerFilterEl.value : ''; availabilityResults.hidden = false; availabilityResults.innerHTML = '<div class="card"><p class="lead">Checking live availability…</p></div>'; availabilityMessage.textContent = ''; try { const result = await searchAvailability({ date, time }); const matches = selectedProviderId ? result.matches.filter(match => match.provider.id === selectedProviderId) : result.matches; if (!matches.length) { availabilityResults.innerHTML = `<div class="card"><p class="lead">No available wash${selectedProviderId ? ' for this provider' : 'es'}${time ? ` at ${h(time)}` : ''} on ${h(date)}. Try another time or date.</p></div>`; return; } const groups = new Map(); matches.forEach(match => { const key = `${match.provider.id}|${match.location.id}`; if (!groups.has(key)) groups.set(key, { provider: match.provider, location: match.location, services: [] }); groups.get(key).services.push(match); }); availabilityResults.innerHTML = `<div class="results-head"><div><h3>${selectedProviderId ? 'Available at this provider' : 'Available washes'}</h3><p>${time ? `For ${h(time)}` : 'Choose a time below'} · ${matches.length} service${matches.length === 1 ? '' : 's'}</p></div><span class="results-date">${h(date)}</span></div>` + [...groups.values()].map(group => `<article class="provider-card"><div class="provider-card-head"><div><h3>${h(group.provider.name)}</h3><p>${h(group.location.name)}${group.location.address ? ` · ${h(group.location.address)}` : ''}</p></div><span class="provider-count">${group.services.length} service${group.services.length === 1 ? '' : 's'}</span></div>${group.services.map(match => `<div class="availability-service"><div><strong>${h(match.service.name)}</strong><small>${match.service.duration_minutes} min · RM ${Number(match.service.price_myr).toFixed(2)}</small></div><div class="availability-slots">${match.slots.map(slot => `<button class="slot-chip" data-choose-slot="${h(group.provider.id)}|${h(group.location.id)}|${h(match.service.id)}|${h(date)}|${h(slot)}" type="button">${h(slot)}</button>`).join('')}</div></div>`).join('')}</article>`).join(''); wireChoiceButtons(); } catch (error) { availabilityResults.innerHTML = `<div class="card"><p class="lead" style="color:#b3261e">${h(error.message)}</p></div>`; } };
    wireChoiceButtons();
    const manageResult = document.getElementById('manageResult');
    const renderManagedBooking = booking => { const date = booking.scheduled_date || String(booking.scheduled_at || '').slice(0, 10); const time = new Date(booking.scheduled_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }); let cancelArmed = false; manageResult.innerHTML = `<div class="managed-booking"><div class="modal-row"><span>Reference</span><strong>${h(booking.reference)}</strong></div><div class="modal-row"><span>Service</span><span>${h(booking.service?.name || '')}</span></div><div class="modal-row"><span>Date and time</span><span>${h(date)} · ${h(time)}</span></div><div class="modal-row"><span>Location</span><span>${h(booking.location?.name || '')}</span></div><div class="modal-row"><span>Status</span><span>${h(booking.status)}</span></div>${booking.status !== 'cancelled' ? `<div class="confirmation-actions manage-actions"><button class="btn manage-action-btn" id="manageMove" type="button">Move booking</button><button class="btn manage-action-btn cancel-action-btn" id="manageCancel" type="button">Cancel booking</button></div><div id="manageMoveFields" hidden><div class="field"><label for="manageDate">New date</label><input id="manageDate" type="date" value="${h(date)}" min="${h(localDateISO(new Date()))}"></div><div class="field"><label for="manageTime">New available time</label><select id="manageTime"><option value="">Choose a date first</option></select></div><button class="btn" id="saveManagedMove" type="button">Confirm new time</button></div>` : '<p class="lead">This booking is cancelled.</p>'}</div>`; document.getElementById('manageCancel')?.addEventListener('click', async event => { const button = event.currentTarget; if (!cancelArmed) { cancelArmed = true; button.textContent = 'Confirm cancellation'; button.classList.add('cancel-confirm'); return; } button.disabled = true; button.textContent = 'Cancelling…'; try { const result = await manageBooking({ action: 'cancel', reference: booking.reference, phone: document.getElementById('managePhone').value }); renderManagedBooking(result.booking); } catch (error) { cancelArmed = false; button.disabled = false; button.textContent = 'Cancel booking'; button.classList.remove('cancel-confirm'); alert(error.message); } }); document.getElementById('manageMove')?.addEventListener('click', () => { document.getElementById('manageMoveFields').hidden = false; refreshManagedSlots(booking); }); document.getElementById('manageDate')?.addEventListener('change', () => refreshManagedSlots(booking)); document.getElementById('saveManagedMove')?.addEventListener('click', async () => { const button = document.getElementById('saveManagedMove'); button.disabled = true; try { const result = await manageBooking({ action: 'reschedule', reference: booking.reference, phone: document.getElementById('managePhone').value, date: document.getElementById('manageDate').value, time: document.getElementById('manageTime').value }); renderManagedBooking(result.booking); } catch (error) { button.disabled = false; alert(error.message); } }); };
    const refreshManagedSlots = async booking => { const target = document.getElementById('manageTime'); const date = document.getElementById('manageDate')?.value; if (!target || !date) return; target.innerHTML = '<option value="">Loading available times…</option>'; try { const result = await loadSlots({ providerId: booking.provider_id, locationId: booking.location_id, serviceId: booking.service.id, date }); target.innerHTML = result.slots.length ? result.slots.map(time => `<option value="${h(time)}">${h(time)}</option>`).join('') : '<option value="">No available times</option>'; } catch (error) { target.innerHTML = `<option value="">${h(error.message)}</option>`; } };
    document.getElementById('manageForm').onsubmit = async event => { event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; manageResult.textContent = 'Looking up booking…'; try { const result = await manageBooking({ action: 'lookup', reference: document.getElementById('manageReference').value, phone: document.getElementById('managePhone').value }); renderManagedBooking(result.booking); } catch (error) { manageResult.innerHTML = `<p class="lead" style="color:#b3261e">${h(error.message)}</p>`; } finally { button.disabled = false; } };
  } catch (error) { root.innerHTML = `<p class="lead" style="color:#b3261e">${h(error.message)}</p>`; }
}

// Direct per-element handlers, not window-level delegation — every other
// interactive element in this app is wired this way already; the nav bar
// was the one exception, and reports of it not responding on mobile are
// exactly the symptom delegation-vs-direct-binding differences can cause.
function wireNav() {
  document.querySelectorAll('[data-nav]').forEach(el => el.onclick = () => { location.hash = el.dataset.nav; });
  document.querySelectorAll('[data-menu-toggle]').forEach(el => el.onclick = () => {
    const menu = document.getElementById(el.getAttribute('aria-controls'));
    if (!menu) return;
    menu.hidden = !menu.hidden;
    el.setAttribute('aria-expanded', String(!menu.hidden));
  });
  const closeProfile = () => {
    const drawer = document.getElementById('staffProfileDrawer');
    const trigger = document.querySelector('[data-profile-toggle]');
    drawer?.classList.remove('open');
    document.querySelector('.profile-scrim')?.classList.remove('open');
    trigger?.setAttribute('aria-expanded', 'false');
    drawer?.setAttribute('aria-hidden', 'true');
  };
  document.querySelectorAll('[data-profile-toggle]').forEach(el => el.onclick = () => {
    const drawer = document.getElementById(el.getAttribute('aria-controls'));
    const scrim = document.querySelector('.profile-scrim');
    if (!drawer || !scrim) return;
    const open = !drawer.classList.contains('open');
    drawer.classList.toggle('open', open);
    scrim.classList.toggle('open', open);
    el.setAttribute('aria-expanded', String(open));
    drawer.setAttribute('aria-hidden', String(!open));
  });
  document.querySelectorAll('[data-profile-close]').forEach(el => el.onclick = closeProfile);
  document.querySelector('[data-focus-tenant]')?.addEventListener('click', () => {
    setTimeout(() => document.getElementById('tenantSelect')?.focus(), 0);
  });
  const tenantSelect = document.getElementById('tenantSelect');
  if (tenantSelect) tenantSelect.onchange = () => {
    const [providerId, locationId] = tenantSelect.value.split('|');
    api.setActiveTenant(providerId, locationId);
    router();
  };
  document.querySelectorAll('[data-signout]').forEach(el => el.onclick = async () => {
    await api.signOutStaff();
    location.hash = '#/staff/login';
  });
}

// ── Router ───────────────────────────────────────────────────────────
const routes = {
  '#/': pageCustomerLanding,
  '#/book': pageCustomerBook,
  '#/staff/login': pageStaffLogin,
  '#/staff/setup': pageStaffSetup,
  '#/staff/reset-password': pageStaffPasswordReset,
  '#/staff/board': pageStaffBoard,
  '#/staff/overview': pageStaffOverview,
  '#/staff/analytics': pageStaffAnalytics,
  '#/staff/billing': pageStaffBilling,
  '#/staff/history': pageStaffHistory,
  '#/staff/platform-admin': pagePlatformAdmin,
  '#/staff/platform-checkout': pagePlatformCheckout,
  '#/staff/settings': pageStaffSettings,
  '#/staff/organization': pageStaffOrganization,
};

function router() {
  clearTimeout(boardRefreshTimer);
  boardRealtimeCleanup?.();
  boardRealtimeCleanup = null;
  const hash = location.hash || '#/';
  const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
  const isRecoveryCallback = hashParams.has('access_token') && hashParams.get('type') === 'recovery';
  const route = isRecoveryCallback || new URLSearchParams(location.search).has('staff_reset') ? '#/staff/reset-password' : hash.split('?')[0];
  (routes[route] ?? pageStaffBoard)();
}
window.addEventListener('hashchange', router);
router();
