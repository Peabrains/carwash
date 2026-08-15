import './style.css';
import * as api from './lib/api.js';

// The generated registerSW.js only calls navigator.serviceWorker.register()
// with no update-detection at all, so a new deploy's service worker sits
// "waiting" indefinitely and open/revisited tabs keep serving old cached
// content — registerType: 'autoUpdate' in vite.config.js does nothing on
// its own without this. This forces an update check and reloads once a
// new version is actually found, so every deploy takes effect on next
// visit instead of requiring a manual cache clear.
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}

const app = document.getElementById('app');
const state = { staff: null };

// Every navigation (route change, date click, settings save, etc.) bumps
// this. Async page renders check it before touching the DOM, so a slow
// in-flight render from a previous click can never clobber a newer one —
// this was the actual cause of "clicking Settings/Prev/Next does nothing":
// pageStaffBoard did two sequential awaits before rendering, and whichever
// render finished LAST used to win, not whichever was clicked last.
let renderGen = 0;

// ── Shell ────────────────────────────────────────────────────────────
function shell(navActive, innerHTML) {
  return `
    <div class="app-shell">
      <div class="topbar">
        <div class="brand"><div class="drop"></div>Wash Point</div>
      </div>
      <div class="screen">${innerHTML}</div>
      ${navActive ? `
      <div class="navbar">
        <div class="item ${navActive==='board'?'active':''}" data-nav="#/staff/board">Board</div>
        <div class="item ${navActive==='settings'?'active':''}" data-nav="#/staff/settings">Settings</div>
        <div class="item" data-signout="1">Sign out</div>
      </div>` : ''}
    </div>`;
}

// ── Staff auth ───────────────────────────────────────────────────────
async function pageStaffLogin() {
  const myGen = ++renderGen;
  app.innerHTML = shell('', `
    <div class="eyebrow">Staff sign in</div>
    <h2>Wash Point staff</h2>
    <div class="field"><label>Email</label><input id="email" placeholder="you@example.com"/></div>
    <div class="field"><label>Password</label><input id="password" type="password"/></div>
    <button class="btn" id="doSignIn">Sign in</button>
    <p class="lead" id="errMsg" style="display:none;color:#b3261e"></p>
  `);
  document.getElementById('doSignIn').onclick = async () => {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (!email || !password) return;
    const errEl = document.getElementById('errMsg');
    errEl.style.display = 'none';
    try {
      await api.signInStaff(email, password);
      if (myGen !== renderGen) return;
      location.hash = '#/staff/board';
      router();
    } catch (e) {
      if (myGen !== renderGen) return;
      errEl.textContent = e?.message || 'Could not sign in. Check your email and password.';
      errEl.style.display = 'block';
    }
  };
}

// Gate: resolve current staff member. No session at all -> straight to
// login. Signed in but not on the staff list -> distinct "ask the owner"
// screen, since redirecting back to login there would just loop forever.
// Takes the caller's render token and checks it after every await, so a
// stale call (superseded by a newer click) never renders over fresher UI.
async function requireStaff(myGen) {
  const user = await api.getAuthUser();
  if (myGen !== renderGen) return null;
  if (!user) {
    location.hash = '#/staff/login';
    return null;
  }

  const staff = await api.getCurrentStaff();
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
  return staff;
}

// ── Staff pages ──────────────────────────────────────────────────────
function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

// customer_chat_id is only a real phone number for WhatsApp bookings —
// Telegram's chat id is an opaque numeric id, not a phone number. There is
// no email field anywhere in the schema; the booking flow never collects
// one, so it can't be shown here without adding a capture step to the bot.
function showApptModal(a) {
  const idLabel = a.channel === 'whatsapp' ? 'Phone' : 'Telegram ID';
  const rows = [
    ['Customer', a.customer_name || '—'],
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
      <button class="btn" id="closeModal">Close</button>
    </div>`;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  document.getElementById('closeModal').onclick = () => overlay.remove();
}

async function pageStaffBoard(dateISO) {
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  const date = dateISO || localDateISO(new Date());
  const isToday = date === localDateISO(new Date());

  const [bays, appts, settings] = await Promise.all([
    api.getActiveBays(),
    api.getAppointmentsForDate(date),
    isToday ? api.getBookingSettings() : Promise.resolve(null),
  ]);
  if (myGen !== renderGen) return;

  const byBay = {};
  for (const a of appts) (byBay[a.bay_id] ??= []).push(a);
  const now = new Date();

  const cols = bays.map(b => {
    const bookings = byBay[b.id] || [];
    const rows = bookings.map(a => `
      <div class="bay-slot ${a.status === 'in_progress' ? 'progress' : a.status === 'completed' ? 'done' : a.needs_attention ? 'attention' : ''}" data-appt="${a.id}">
        <div style="font-weight:700">${fmtTime(new Date(a.scheduled_at))} — ${a.services?.name ?? 'Wash'}</div>
        <div>${a.customer_name || a.customer_chat_id} · ${a.channel}${a.needs_attention ? ' · needs attention' : ''}</div>
      </div>`).join('') || `<div class="bay-slot">No bookings this day.</div>`;

    let tag = 'Open';
    let tagClass = '';
    if (isToday && settings) {
      const avail = bayAvailability(bookings, settings.buffer_minutes, now);
      if (avail.free) {
        tag = avail.until ? `Free until ${fmtTime(avail.until)}` : 'Free all day';
      } else {
        tag = `Busy until ${fmtTime(avail.until)}`;
        tagClass = 'busy';
      }
    }

    return `
      <div class="bay-col">
        <div class="head"><span>${b.name}</span><span class="tag ${tagClass}">${tag}</span></div>
        ${rows}
        ${staff.role === 'owner' ? `<button class="mini-btn" data-report="${b.id}" style="margin:10px">Report bay down</button>` : ''}
      </div>`;
  }).join('');

  app.innerHTML = shell('board', `
    <div class="eyebrow">Staff</div>
    <h2>Bay board</h2>
    <div class="date-nav">
      <button data-date="${shiftDate(date, -1)}">&larr; Prev</button>
      <div class="current">${fmtDateLabel(date, isToday)}</div>
      <button data-date="${shiftDate(date, 1)}">Next &rarr;</button>
    </div>
    ${isToday ? '<p class="lead">Tags show real-time walk-in availability, factoring in the rest buffer between washes.</p>' : ''}
    <div class="bay-board">${cols}</div>
  `);
  document.querySelectorAll('[data-date]').forEach(el => el.onclick = () => pageStaffBoard(el.dataset.date));
  document.querySelectorAll('[data-appt]').forEach(el => el.onclick = () => {
    const a = appts.find(x => x.id === el.dataset.appt);
    if (a) showApptModal(a);
  });
  document.querySelectorAll('[data-report]').forEach(el => el.onclick = async () => {
    const res = await api.reportBayDown(el.dataset.report);
    if (myGen !== renderGen) return;
    alert(`Bay marked down. ${res.flagged ?? 0} booking(s) need attention.`);
    pageStaffBoard(date);
  });
  wireSignOut();
}

async function pageStaffSettings() {
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  if (staff.role !== 'owner') {
    app.innerHTML = shell('settings', `<div class="eyebrow">Configuration</div><h2>Owner only</h2><p class="lead">Ask the owner to change booking settings.</p>`);
    wireSignOut();
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
    <div class="eyebrow">Configuration</div>
    <h2>Booking window</h2>
    <div class="settings-block">
      <div class="settings-row"><div>Minimum lead time (minutes)</div>
        <input id="lead" type="number" value="${s.min_lead_minutes}" style="width:80px"/></div>
      <div class="settings-row"><div>Maximum advance booking (days)</div>
        <input id="advance" type="number" value="${s.max_advance_days}" style="width:80px"/></div>
      <div class="settings-row"><div>Buffer / rest time after each wash (minutes)</div>
        <input id="buffer" type="number" value="${s.buffer_minutes}" style="width:80px"/></div>
    </div>
    <button class="btn" id="save" style="max-width:220px">Save changes</button>

    <h2 style="margin-top:32px">Crew breaks</h2>
    <p class="lead">Staggered per bay, kept outside your peak hours so bays don't all go down at once. Applies every day.</p>
    <div class="settings-block">${breakRows}</div>
    <div class="settings-row">
      <select id="breakBay">${bayOptions}</select>
      <input id="breakStart" type="time" value="14:30"/>
      <input id="breakDuration" type="number" value="30" style="width:70px" title="minutes"/>
      <button class="mini-btn" id="addBreak">Add</button>
    </div>
  `);

  document.getElementById('save').onclick = async () => {
    await api.updateBookingSettings({
      min_lead_minutes: Number(document.getElementById('lead').value),
      max_advance_days: Number(document.getElementById('advance').value),
      buffer_minutes: Number(document.getElementById('buffer').value)
    });
    if (myGen !== renderGen) return;
    alert('Saved.');
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
  wireSignOut();
}

function wireSignOut() {
  document.querySelectorAll('[data-signout]').forEach(el => el.onclick = async () => {
    await api.signOutStaff();
    location.hash = '#/staff/login';
  });
}

// ── Router ───────────────────────────────────────────────────────────
const routes = {
  '#/staff/login': pageStaffLogin,
  '#/staff/board': pageStaffBoard,
  '#/staff/settings': pageStaffSettings,
};

function router() {
  const hash = location.hash || '#/staff/board';
  (routes[hash] ?? pageStaffBoard)();
}
window.addEventListener('hashchange', router);
window.addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) location.hash = nav.dataset.nav;
});
router();
