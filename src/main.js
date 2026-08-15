import './style.css';
import * as api from './lib/api.js';

const app = document.getElementById('app');
const state = { staff: null };

// ── Shell ────────────────────────────────────────────────────────────
function shell(navActive, wide, innerHTML) {
  return `
    <div class="app-shell ${wide ? 'wide' : ''}">
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
  app.innerHTML = shell('', false, `
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
      location.hash = '#/staff/board';
      router();
    } catch (e) {
      errEl.textContent = e?.message || 'Could not sign in. Check your email and password.';
      errEl.style.display = 'block';
    }
  };
}

// Gate: resolve current staff member. No session at all -> straight to
// login. Signed in but not on the staff list -> distinct "ask the owner"
// screen, since redirecting back to login there would just loop forever.
async function requireStaff() {
  const user = await api.getAuthUser();
  if (!user) {
    location.hash = '#/staff/login';
    return null;
  }

  const staff = await api.getCurrentStaff();
  state.staff = staff;
  if (!staff) {
    app.innerHTML = shell('', false, `
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
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function shiftDate(dateISO, days) {
  const d = new Date(dateISO + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function pageStaffBoard(dateISO) {
  const staff = await requireStaff();
  if (!staff) return;
  const date = dateISO || new Date().toISOString().slice(0, 10);

  const bays = await api.getActiveBays();
  const appts = await api.getAppointmentsForDate(date);
  const byBay = {};
  for (const a of appts) (byBay[a.bay_id] ??= []).push(a);

  const cols = bays.map(b => {
    const rows = (byBay[b.id] || []).map(a => `
      <div class="bay-slot ${a.status === 'in_progress' ? 'progress' : a.status === 'completed' ? 'done' : a.needs_attention ? 'attention' : ''}">
        <div style="font-weight:700">${fmtTime(a.scheduled_at)} — ${a.services?.name ?? 'Wash'}</div>
        <div>${a.customer_name || a.customer_chat_id} · ${a.channel}${a.needs_attention ? ' · needs attention' : ''}</div>
      </div>`).join('') || `<div class="bay-slot">No bookings this day.</div>`;
    return `
      <div class="bay-col">
        <div class="head">${b.name} <span class="tag">Open</span></div>
        ${rows}
        ${staff.role === 'owner' ? `<button class="mini-btn" data-report="${b.id}" style="margin:10px">Report bay down</button>` : ''}
      </div>`;
  }).join('');

  const isToday = date === new Date().toISOString().slice(0, 10);
  app.innerHTML = shell('board', true, `
    <div class="eyebrow">Staff</div>
    <h2>Bay board</h2>
    <div class="date-row">
      <div class="date-chip" data-date="${shiftDate(date, -1)}">&larr; Prev</div>
      <div class="date-chip selected">${date}${isToday ? ' (today)' : ''}</div>
      <div class="date-chip" data-date="${shiftDate(date, 1)}">Next &rarr;</div>
    </div>
    <div class="bay-board">${cols}</div>
  `);
  document.querySelectorAll('[data-date]').forEach(el => el.onclick = () => pageStaffBoard(el.dataset.date));
  document.querySelectorAll('[data-report]').forEach(el => el.onclick = async () => {
    const res = await api.reportBayDown(el.dataset.report);
    alert(`Bay marked down. ${res.flagged ?? 0} booking(s) need attention.`);
    pageStaffBoard(date);
  });
  wireSignOut();
}

async function pageStaffSettings() {
  const staff = await requireStaff();
  if (!staff) return;
  if (staff.role !== 'owner') {
    app.innerHTML = shell('settings', true, `<div class="eyebrow">Configuration</div><h2>Owner only</h2><p class="lead">Ask the owner to change booking settings.</p>`);
    wireSignOut();
    return;
  }

  const s = await api.getBookingSettings();
  const bays = await api.getActiveBays();
  const breaks = await api.getCrewBreaks();

  const bayOptions = bays.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  const breakRows = breaks.map(b => `
    <div class="settings-row">
      <div>${b.bays?.name ?? b.bay_id} — ${b.start_time} for ${b.duration_minutes} min</div>
      <button class="mini-btn" data-remove-break="${b.id}">Remove</button>
    </div>`).join('') || '<p class="lead">No crew breaks scheduled yet.</p>';

  app.innerHTML = shell('settings', true, `
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
    alert('Saved.');
  };
  document.getElementById('addBreak').onclick = async () => {
    await api.setCrewBreak({
      bayId: document.getElementById('breakBay').value,
      startTime: document.getElementById('breakStart').value,
      durationMinutes: Number(document.getElementById('breakDuration').value)
    });
    pageStaffSettings();
  };
  document.querySelectorAll('[data-remove-break]').forEach(el => el.onclick = async () => {
    await api.removeCrewBreak(el.dataset.removeBreak);
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
