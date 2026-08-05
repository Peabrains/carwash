import './style.css';
import { supabase, isConfigured } from './lib/supabase.js';
import * as api from './lib/api.js';

const app = document.getElementById('app');
const state = {
  services: [],
  selectedServiceId: null,
  selectedDate: new Date().toISOString().slice(0, 10),
  selectedSlot: null,
  customer: null, // { id, phone }
};

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return { d: d.toLocaleDateString(undefined, { weekday: 'short' }), n: d.getDate() };
}

function nextNDays(n) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

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
        <div class="item ${navActive==='book'?'active':''}" data-nav="#/services">Book</div>
        <div class="item ${navActive==='history'?'active':''}" data-nav="#/history">History</div>
        <div class="item" data-nav="#/login">Account</div>
      </div>`}
    </div>`;
}

// ── Pages ────────────────────────────────────────────────────────────
async function pageLogin() {
  app.innerHTML = shell('account', false, `
    <div class="eyebrow">Sign in</div>
    <h2>Welcome back</h2>
    <p class="lead">Enter your phone number — we'll text you a 6-digit code.</p>
    <div class="field"><label>Phone number</label><input id="phone" placeholder="+60 12-345 6789"/></div>
    <button class="btn" id="sendOtp">Send code</button>
    <div id="otpBlock" style="display:none">
      <div class="field"><label>Verification code</label><input id="otp" placeholder="123456" maxlength="6"/></div>
      <button class="btn amber" id="verifyOtp">Verify & Continue</button>
    </div>
  `);
  document.getElementById('sendOtp').onclick = async () => {
    const phone = document.getElementById('phone').value.trim();
    if (!phone) return;
    if (isConfigured) {
      const { error } = await supabase.auth.signInWithOtp({ phone });
      if (error) return alert(error.message);
    }
    document.getElementById('otpBlock').style.display = 'block';
  };
  document.getElementById('verifyOtp').onclick = async () => {
    const phone = document.getElementById('phone').value.trim();
    const token = document.getElementById('otp').value.trim();
    if (isConfigured) {
      const { data, error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' });
      if (error) return alert(error.message);
      state.customer = { id: data.user.id, phone };
    } else {
      state.customer = { id: 'mock-customer', phone };
    }
    location.hash = '#/services';
  };
}

async function pageServices() {
  state.services = await api.getServices();
  if (!state.selectedServiceId) state.selectedServiceId = state.services[0]?.id;

  const cards = state.services.map(s => `
    <div class="svc-card ${s.id === state.selectedServiceId ? 'selected' : ''}" data-svc="${s.id}">
      <div class="name">${s.name}</div>
      <div class="meta"><span>${s.duration_minutes} min</span><span>RM ${s.price_myr}</span></div>
    </div>`).join('');

  app.innerHTML = shell('book', window.innerWidth > 900, `
    <div class="eyebrow">Step 1 of 3</div>
    <h2>Choose a wash</h2>
    <p class="lead">Pick a service to see available time slots.</p>
    <div class="service-grid">${cards}</div>
    <button class="btn" id="next">Continue to slot picker</button>
  `);
  document.querySelectorAll('[data-svc]').forEach(el => el.onclick = () => {
    state.selectedServiceId = el.dataset.svc;
    pageServices();
  });
  document.getElementById('next').onclick = () => location.hash = '#/slots';
}

async function pageSlots() {
  const dates = nextNDays(14);
  const dateChips = dates.map(iso => {
    const { d, n } = fmtDate(iso);
    return `<div class="date-chip ${iso === state.selectedDate ? 'selected' : ''}" data-date="${iso}"><div>${d}</div><div>${n}</div></div>`;
  }).join('');

  const slots = await api.getAvailableSlots(state.selectedDate, state.selectedServiceId);
  const slotEls = slots.map(s => `
    <div class="slot ${!s.available ? 'full' : ''} ${state.selectedSlot === s.time ? 'selected' : ''}" data-time="${s.available ? s.time : ''}">${s.time}</div>
  `).join('');

  const service = state.services.find(s => s.id === state.selectedServiceId);

  app.innerHTML = shell('book', window.innerWidth > 900, `
    <div class="eyebrow">Step 2 of 3</div>
    <h2>Pick a time</h2>
    <div class="date-row">${dateChips}</div>
    <p class="lead">${service?.name} · ${service?.duration_minutes} min</p>
    <div class="slot-grid">${slotEls}</div>
    <div class="summary-card">
      <div class="row"><span>Service</span><b>${service?.name ?? '—'}</b></div>
      <div class="row"><span>Date</span><b>${state.selectedDate}</b></div>
      <div class="row"><span>Time</span><b>${state.selectedSlot ?? '—'}</b></div>
      <div class="total"><span>Total</span><span>RM ${service?.price_myr ?? '—'}</span></div>
    </div>
    <button class="btn" id="next" ${state.selectedSlot ? '' : 'disabled'}>Continue</button>
  `);

  document.querySelectorAll('[data-date]').forEach(el => el.onclick = () => {
    state.selectedDate = el.dataset.date; state.selectedSlot = null; pageSlots();
  });
  document.querySelectorAll('[data-time]').forEach(el => el.onclick = () => {
    if (!el.dataset.time) return;
    state.selectedSlot = el.dataset.time; pageSlots();
  });
  document.getElementById('next').onclick = async () => {
    if (!state.customer) { location.hash = '#/login'; return; }
    const scheduledAtISO = `${state.selectedDate}T${state.selectedSlot}:00`;
    const appt = await api.createAppointment({
      customerId: state.customer.id,
      vehicleId: null,
      serviceId: state.selectedServiceId,
      bayId: null,
      scheduledAtISO
    });
    state.lastAppointment = appt;
    location.hash = '#/confirm';
  };
}

function pageConfirm() {
  const service = state.services.find(s => s.id === state.selectedServiceId);
  const ref = state.lastAppointment?.reference ?? '—';
  app.innerHTML = shell('book', false, `
    <h2>Booking confirmed</h2>
    <p class="lead">See you ${state.selectedDate} at ${state.selectedSlot}.</p>
    <div class="summary-card">
      <div class="row"><span>Service</span><b>${service?.name}</b></div>
      <div class="row"><span>When</span><b>${state.selectedDate} · ${state.selectedSlot}</b></div>
      <div class="total"><span>Total</span><span>RM ${service?.price_myr}</span></div>
    </div>
    <p class="lead">Ref: ${ref}</p>
    <button class="btn" id="home">Back to home</button>
  `);
  document.getElementById('home').onclick = () => location.hash = '#/services';
}

async function pageHistory() {
  const list = state.customer ? await api.getMyAppointments(state.customer.id) : [];
  const items = list.map(a => `
    <div class="hist-item">
      <div><div style="font-weight:700">${a.service_name ?? a.services?.name}</div>
        <div class="lead">${new Date(a.scheduled_at).toLocaleDateString()} · ${a.bay_name ?? a.bays?.name ?? ''}</div>
        <span class="status-pill">${a.status}</span></div>
      <div style="font-weight:700">RM ${a.price_myr}</div>
    </div>`).join('') || `<p class="lead">No visits yet — sign in to see your wash history.</p>`;

  app.innerHTML = shell('history', false, `
    <div class="eyebrow">Your account</div>
    <h2>Wash history</h2>
    ${items}
  `);
}

// ── Staff pages ──────────────────────────────────────────────────────
async function pageStaffBoard() {
  const bays = await api.getActiveBays();
  const cols = bays.map(b => `
    <div class="bay-col">
      <div class="head">${b.name} <span class="tag">Open</span></div>
      <div class="bay-slot">No bookings shown in scaffold — wire to appointments table.</div>
      <button class="mini-btn" data-report="${b.id}" style="margin:10px">Report bay down</button>
    </div>`).join('');
  app.innerHTML = shell('', true, `
    <div class="eyebrow">Staff</div>
    <h2>Today's bay board</h2>
    <div class="bay-board">${cols}</div>
  `);
  document.querySelectorAll('[data-report]').forEach(el => el.onclick = async () => {
    const res = await api.reportBayDown(el.dataset.report);
    alert(`Bay marked down. ${res.flagged ?? 0} booking(s) need attention.`);
    pageStaffBoard();
  });
}

async function pageStaffSettings() {
  const s = await api.getBookingSettings();
  app.innerHTML = shell('', true, `
    <div class="eyebrow">Configuration</div>
    <h2>Booking window</h2>
    <div class="settings-block">
      <div class="settings-row"><div>Minimum lead time (minutes)</div>
        <input id="lead" type="number" value="${s.min_lead_minutes}" style="width:80px"/></div>
      <div class="settings-row"><div>Maximum advance booking (days)</div>
        <input id="advance" type="number" value="${s.max_advance_days}" style="width:80px"/></div>
    </div>
    <button class="btn" id="save" style="max-width:220px">Save changes</button>
  `);
  document.getElementById('save').onclick = async () => {
    await api.updateBookingSettings({
      min_lead_minutes: Number(document.getElementById('lead').value),
      max_advance_days: Number(document.getElementById('advance').value)
    });
    alert('Saved.');
  };
}

// ── Router ───────────────────────────────────────────────────────────
const routes = {
  '#/login': pageLogin,
  '#/services': pageServices,
  '#/slots': pageSlots,
  '#/confirm': pageConfirm,
  '#/history': pageHistory,
  '#/staff/board': pageStaffBoard,
  '#/staff/settings': pageStaffSettings,
};

function router() {
  const hash = location.hash || '#/services';
  (routes[hash] ?? pageServices)();
}
window.addEventListener('hashchange', router);
window.addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) location.hash = nav.dataset.nav;
});
router();
