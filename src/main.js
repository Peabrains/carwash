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
      ${wide ? '' : `
      <div class="navbar">
        <div class="item ${navActive==='board'?'active':''}" data-nav="#/staff/board">Board</div>
        <div class="item ${navActive==='settings'?'active':''}" data-nav="#/staff/settings">Settings</div>
        <div class="item" data-signout="1">Sign out</div>
      </div>`}
    </div>`;
}

// ── Staff auth ───────────────────────────────────────────────────────
async function pageStaffLogin() {
  app.innerHTML = shell('', false, `
    <div class="eyebrow">Staff sign in</div>
    <h2>Wash Point staff</h2>
    <p class="lead">Enter your staff email — we'll send you a sign-in link.</p>
    <div class="field"><label>Email</label><input id="email" placeholder="you@example.com"/></div>
    <button class="btn" id="sendLink">Send sign-in link</button>
    <p class="lead" id="sentMsg" style="display:none">Check your email for the sign-in link.</p>
    <p class="lead" id="errMsg" style="display:none;color:#b3261e"></p>
  `);
  document.getElementById('sendLink').onclick = async () => {
    const email = document.getElementById('email').value.trim();
    if (!email) return;
    const errEl = document.getElementById('errMsg');
    errEl.style.display = 'none';
    try {
      await api.sendStaffMagicLink(email);
      document.getElementById('sentMsg').style.display = 'block';
    } catch (e) {
      const msg = e?.code === 'over_email_send_rate_limit'
        ? "Too many sign-in emails sent recently — wait a bit and try again."
        : (e?.message || 'Could not send sign-in link. Try again.');
      errEl.textContent = msg;
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
async function pageStaffBoard() {
  const staff = await requireStaff();
  if (!staff) return;

  const bays = await api.getActiveBays();
  const cols = bays.map(b => `
    <div class="bay-col">
      <div class="head">${b.name} <span class="tag">Open</span></div>
      <div class="bay-slot">No bookings shown in scaffold — wire to appointments table.</div>
      ${staff.role === 'owner' ? `<button class="mini-btn" data-report="${b.id}" style="margin:10px">Report bay down</button>` : ''}
    </div>`).join('');
  app.innerHTML = shell('board', true, `
    <div class="eyebrow">Staff</div>
    <h2>Today's bay board</h2>
    <div class="bay-board">${cols}</div>
  `);
  document.querySelectorAll('[data-report]').forEach(el => el.onclick = async () => {
    const res = await api.reportBayDown(el.dataset.report);
    alert(`Bay marked down. ${res.flagged ?? 0} booking(s) need attention.`);
    pageStaffBoard();
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
