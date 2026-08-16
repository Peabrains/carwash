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
        <button type="button" class="item ${navActive==='board'?'active':''}" data-nav="#/staff/board">Board</button>
        <button type="button" class="item ${navActive==='settings'?'active':''}" data-nav="#/staff/settings">Settings</button>
        <button type="button" class="item" data-signout="1">Sign out</button>
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
function isWeekend(dateISO) {
  const day = new Date(dateISO + 'T00:00:00').getDay();
  return day === 0 || day === 6;
}
// "08:00:00" (Postgres time) -> minutes since midnight
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
function showApptModal(a) {
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

  const [bays, appts, settings, breaks, closures] = await Promise.all([
    api.getActiveBays(),
    api.getAppointmentsForDate(date),
    api.getBookingSettings(),
    api.getCrewBreaks(),
    api.getBayClosuresForDate(date),
  ]);
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
    <div class="eyebrow">Staff</div>
    <h2>Bay board</h2>
    <div class="date-nav">
      <button data-date="${shiftDate(date, -1)}">&larr; Prev</button>
      <div class="current">${fmtDateLabel(date, isToday)}</div>
      <button data-date="${shiftDate(date, 1)}">Next &rarr;</button>
    </div>
    ${isToday ? '<p class="lead">Tags show real-time walk-in availability. Gray blocks are scheduled crew breaks.</p>' : ''}
    <div class="cal-wrap">
      <div class="cal-grid" style="grid-template-columns:44px repeat(${bays.length},minmax(140px,1fr))">
        <div class="cal-gutter-head"></div>
        ${heads}
        <div class="cal-gutter" style="height:${totalMin}px">${hourLabels.join('')}</div>
        ${tracks}
      </div>
    </div>
    ${staff.role === 'owner' ? `<div class="settings-row" style="margin-top:14px">${bays.map(b => { if (b.status === 'maintenance') return `<button class="mini-btn" data-bring-up="${b.id}">Bring ${b.name} back online</button>`; const outage = (closuresByBay[b.id] || []).find(c => new Date(c.ends_at) > new Date()); return outage ? `<button class="mini-btn" data-clear-closure="${outage.id}">End ${b.name} outage</button>` : `<button class="mini-btn" data-report="${b.id}">Report ${b.name} down</button>`; }).join('')}</div>` : ''}
  `);
  document.querySelectorAll('[data-date]').forEach(el => el.onclick = () => pageStaffBoard(el.dataset.date));
  document.querySelectorAll('[data-appt]').forEach(el => el.onclick = () => {
    const a = appts.find(x => x.id === el.dataset.appt);
    if (a) showApptModal(a);
  });
  document.querySelectorAll('[data-report]').forEach(el => el.onclick = async () => {
    const values = await bayDownDetails(el.dataset.report, date);
    if (!values) return;
    const res = await api.reportBayDown(el.dataset.report, values);
    if (myGen !== renderGen) return;
    alert(`Bay outage recorded. ${res.flagged ?? 0} booking(s) were checked for reassignment.`);
    pageStaffBoard(date);
  });
  document.querySelectorAll('[data-bring-up]').forEach(el => el.onclick = async () => {
    await api.bringBayUp(el.dataset.bringUp);
    if (myGen !== renderGen) return;
    pageStaffBoard(date);
  });
  document.querySelectorAll('[data-closure-edit]').forEach(el => el.onclick = async () => {
    const closure = closures.find(c => c.id === el.dataset.closureEdit);
    if (!closure) return;
    const values = await bayDownDetails(closure.bay_id, date, closure);
    if (!values) return;
    await api.updateBayClosure(closure.id, values);
    if (myGen !== renderGen) return;
    pageStaffBoard(date);
  });
  document.querySelectorAll('[data-clear-closure]').forEach(el => el.onclick = async () => {
    if (!confirm('End this bay outage early?')) return;
    await api.clearBayClosure(el.dataset.clearClosure);
    if (myGen !== renderGen) return;
    pageStaffBoard(date);
  });
  wireNav();
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

async function bayDownDetails(bayId, dateISO, existing = null) {
  const now = new Date();
  const existingStart = existing?.starts_at ? new Date(existing.starts_at) : null;
  const existingEnd = existing?.ends_at ? new Date(existing.ends_at) : null;
  const startDate = existingStart || (dateISO === localDateISO(now) ? new Date(now) : new Date(\`\${dateISO}T08:00\`));
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
          <button class="btn ghost" id="cancelOutage" type="button">Cancel</button>
          <button class="btn amber" id="saveOutage" type="button">${isEditing ? 'Save changes' : 'Save outage'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = value => { overlay.remove(); resolve(value); };
    overlay.onclick = e => { if (e.target === overlay) close(null); };
    overlay.querySelector('#cancelOutage').onclick = () => close(null);
    overlay.querySelector('#saveOutage').onclick = () => {
      const start = new Date(`${overlay.querySelector('#outageStartDate').value}T${overlay.querySelector('#outageStartTime').value}`);
      const end = new Date(`${overlay.querySelector('#outageEndDate').value}T${overlay.querySelector('#outageEndTime').value}`);
      if (!overlay.querySelector('#outageStartDate').value || !overlay.querySelector('#outageEndDate').value || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
        alert('Please choose a valid window with the end after the start.');
        return;
      }
      close({ startsAt: start.toISOString(), endsAt: end.toISOString(), reason: overlay.querySelector('#outageReason').value.trim() });
    };
  });
}
async function pageStaffSettings() {
  const myGen = ++renderGen;
  const staff = await requireStaff(myGen);
  if (!staff) return;
  if (staff.role !== 'owner') {
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

    <h2 style="margin-top:32px">Operating hours</h2>
    <p class="lead">Used by both the bay board and the booking bot to decide what counts as a bookable time.</p>
    <div class="settings-block">
      <div class="settings-row"><div>Weekday open</div><input id="weekdayOpen" type="time" value="${s.weekday_open.slice(0,5)}"/></div>
      <div class="settings-row"><div>Weekday close</div><input id="weekdayClose" type="time" value="${s.weekday_close.slice(0,5)}"/></div>
      <div class="settings-row"><div>Weekend open</div><input id="weekendOpen" type="time" value="${s.weekend_open.slice(0,5)}"/></div>
      <div class="settings-row"><div>Weekend close</div><input id="weekendClose" type="time" value="${s.weekend_close.slice(0,5)}"/></div>
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
      buffer_minutes: Number(document.getElementById('buffer').value),
      weekday_open: document.getElementById('weekdayOpen').value,
      weekday_close: document.getElementById('weekdayClose').value,
      weekend_open: document.getElementById('weekendOpen').value,
      weekend_close: document.getElementById('weekendClose').value,
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
  wireNav();
}

// Direct per-element handlers, not window-level delegation — every other
// interactive element in this app is wired this way already; the nav bar
// was the one exception, and reports of it not responding on mobile are
// exactly the symptom delegation-vs-direct-binding differences can cause.
function wireNav() {
  document.querySelectorAll('[data-nav]').forEach(el => el.onclick = () => { location.hash = el.dataset.nav; });
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
router();
