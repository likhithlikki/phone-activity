import { FIREBASE_CONFIG, BACKEND_URL, SCHEMA } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, query, where, orderBy, limit, onSnapshot, getDocs, getDoc, updateDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const $ = s => document.querySelector(s);
const K = { sel: 'at_sel', auto: 'at_auto', seen: 'at_notif_seen' };
const COLORS = ['#3b6df0', '#1fa98f', '#f0a020', '#e5484d', '#8e5bf0', '#8a94a6'];
const CATS = ['All', 'Birthdays', 'Holidays', 'Festivals', 'Meetings', 'Reminders', 'Other'];

/* ---------- state ---------- */
let fbApp = null, auth = null, db = null, user = null;
let devices = {};            // deviceId -> device document (live)
let sel = 'all';             // 'all' or a deviceId
let store = {};              // deviceId -> { usage, screen, hourly, samples, rollup, hourlyDays }
let data = { appUsage: [], screen: [], device: [], calendar: [], summary: [], hourly: [] };
let cal = null, days = 7, tab = 'overview', charts = [];
let calCat = 'All', calQ = '', calLimit = 150;
let notes = null, notesAt = 0, nMode = 'day', nDate = '', nApp = '', nSort = 'time_desc', nQ = '', nLimit = 200;
let devRange = '24h', devBucket = 'auto';
let atRes = 'hour', atRange = '24h', atApp = '';
let ctl = '';                 // device the Remote tab controls
let liveNotes = {}, unsubs = [], deviceUnsubs = {}, auditUnsub = null;

/* ---------- helpers ---------- */
const z2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}`;
const today = () => ymd(new Date());
const cutoff = () => { const d = new Date(); d.setDate(d.getDate() - (days - 1)); return ymd(d); };
const inRange = r => r.date >= cutoff() && r.date <= today();
const n = v => Number(v) || 0;
const sum = (a, f) => a.reduce((t, r) => t + f(r), 0);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMin = m => { m = Math.round(m); return m >= 60 ? `${Math.floor(m / 60)}h ${z2(m % 60)}m` : `${m}m`; };
const fmtSec = s => fmtMin(s / 60);
const gb = mb => (n(mb) / 1024).toFixed(1) + ' GB';
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const ts = r => n(r.timestamp);
const stamp = t => { const d = new Date(Number(t)); return `${z2(d.getMonth() + 1)}-${z2(d.getDate())} ${z2(d.getHours())}:${z2(d.getMinutes())}`; };
const clock = (t, secs) => { const d = new Date(Number(t)); return `${z2(d.getHours())}:${z2(d.getMinutes())}${secs ? ':' + z2(d.getSeconds()) : ''}`; };
const msg = t => { $('#msg').textContent = t || ''; };
/** Calls the free Apps Script server (push, pairing, alerts). It verifies your Google sign-in token on every call. */
async function api(action, payload = {}) {
  if (String(BACKEND_URL).startsWith('PASTE')) throw new Error('Set BACKEND_URL in website/config.js (see SETUP.md).');
  const r = await fetch(BACKEND_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ ...payload, action, idToken: await user.getIdToken() }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error === 'unauthorized' ? 'Not authorised: sign out and in again, and check WEB_API_KEY in the script.' : (j.error || 'request failed'));
  return j;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store_ = {
  get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} }
};
const ago = t => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const devName = id => (devices[id] && devices[id].name) || 'Phone';
const multi = () => Object.keys(devices).length > 1;
const scope = () => (sel === 'all' ? Object.keys(devices) : (devices[sel] ? [sel] : []));
const primary = () => (sel !== 'all' && devices[sel] ? sel : Object.keys(devices)[0]);
const isFrozen = d => !!d && d.state === 'frozen' && (!d.frozenUntil || d.frozenUntil > Date.now());
function devStatus(d) {
  if (isFrozen(d)) return { k: 'frozen', t: d.frozenUntil ? 'Frozen until ' + new Date(d.frozenUntil).toLocaleString() : 'Frozen until resumed in the app' };
  const age = Date.now() - (d.lastSeen || 0);
  if (!d.lastSeen) return { k: 'off', t: 'No data yet' };
  if (age < 150000) return { k: 'live', t: 'Live' };
  if (age < 25 * 60000) return { k: 'on', t: 'Online · ' + ago(d.lastSeen) };
  return { k: 'off', t: 'Offline · last seen ' + ago(d.lastSeen) };
}

const card = (l, v, s = '') => `<div class="card"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const panel = h => `<div class="panel">${h}</div>`;
const box = (id, title) => panel(`<h3>${title}</h3><div class="chartbox"><canvas id="${id}"></canvas></div>`);
const table = (head, rows) => rows.length
  ? `<div class="tw"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : '<p class="empty">No data for this period.</p>';
const empty = t => panel(`<p class="empty">${t}</p>`);
const sel_ = (id, opts, cur) => `<select id="${id}">` + opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('') + '</select>';

function chart(id, type, labels, datasets, options = {}) {
  const el = $('#' + id);
  if (!el || !window.Chart) return;
  charts.push(new Chart(el, { type, data: { labels, datasets }, options: { responsive: true, maintainAspectRatio: false, ...options } }));
}
function setView(html) { charts.forEach(c => c.destroy()); charts = []; $('#view').innerHTML = html; }

/* rows of the device (battery) samples for one phone, oldest first */
const devRows = id => data.device.filter(r => r.deviceId === (id || primary())).sort((a, b) => ts(a) - ts(b));
const latestDevice = () => { const id = primary(); const d = devices[id]; const rows = devRows(id); const r = rows[rows.length - 1]; return r || (d && d.last ? { ...d.last, deviceId: id } : null); };
/* ---------- charge / discharge rate ---------- */
// Prefers the phone's live current (mA); falls back to the % trend over the current charging state.
function rateInfo() {
  const rows = devRows();
  if (!rows.length) return null;
  const last = rows[rows.length - 1], chg = n(last.charging) === 1, lvl = n(last.batteryPct);
  if (chg && lvl >= 100) return { label: 'Full', text: 'Fully charged' };
  const run = [];
  for (let i = rows.length - 1; i >= 0 && (n(rows[i].charging) === 1) === chg; i--) run.unshift(rows[i]);
  let pph = null;                                   // percent per hour
  const dh = (ts(run[run.length - 1]) - ts(run[0])) / 3.6e6;
  if (run.length > 1 && dh >= 0.05) pph = Math.abs(lvl - n(run[0].batteryPct)) / dh;
  const ma = n(last.currentMa);
  let label;
  if (ma > 0) label = chg ? (ma < 1000 ? 'Slow' : ma < 2500 ? 'Medium' : 'Fast') : (ma < 300 ? 'Slow' : ma < 800 ? 'Medium' : 'Fast');
  else if (pph !== null) label = chg ? (pph < 15 ? 'Slow' : pph < 40 ? 'Medium' : 'Fast') : (pph < 5 ? 'Slow' : pph < 12 ? 'Medium' : 'Fast');
  else return { label: '—', text: 'Collecting data…' };
  const hrs = pph > 0 ? (chg ? (100 - lvl) / pph : lvl / pph) : null;
  const eta = hrs === null ? '' : ` · ${chg ? 'full' : 'empty'} in ~${fmtMin(hrs * 60)}`;
  const detail = [ma > 0 ? ma + ' mA' : '', pph !== null ? pph.toFixed(1) + ' %/h' : ''].filter(Boolean).join(' · ');
  return { label: (chg ? 'Charging: ' : 'Discharging: ') + label, text: detail + eta };
}
const rateCard = () => { const ri = rateInfo(); return card('Power rate', ri ? ri.label : '—', ri ? ri.text : ''); };


/* ---------- views ---------- */
function appsView() {
  const rows = data.appUsage.filter(inRange);
  if (!rows.length) return setView(empty('No app usage yet. In the Android app, grant usage access and tap Sync now.'));
  const agg = {};
  rows.forEach(r => {
    const a = agg[r.package] ||= { name: r.appName || r.package, sec: 0, launches: 0 };
    a.sec += n(r.usageSec); a.launches += n(r.launches);
  });
  const list = Object.entries(agg).map(([p, a]) => ({ p, ...a })).sort((a, b) => b.sec - a.sec);
  const total = sum(list, a => a.sec), top = list.slice(0, 10), top5 = list.slice(0, 5);
  const dates = [...new Set(rows.map(r => r.date))].sort();
  const tot = dates.map(d => sum(rows.filter(r => r.date === d), r => n(r.usageSec)));
  const dayRows = dates.map((d, i) => {
    const delta = i ? tot[i] - tot[i - 1] : null;
    return [d, fmtSec(tot[i]), delta === null ? '—' : (delta >= 0 ? '+' : '−') + fmtSec(Math.abs(delta))];
  }).reverse();

  setView(
    '<div id="attl"></div>' + box('c1', 'Top apps (minutes)') +
    box('c2', 'Daily comparison, top 5 apps (minutes)') +
    panel('<h3>Daily totals</h3>' + table(['Date', 'Total usage', 'Change vs previous day'], dayRows)) +
    panel('<h3>All apps</h3>' + table(['App', 'Usage time', 'Launches', 'Share'],
      list.map(a => [esc(a.name), fmtSec(a.sec), a.launches, (a.sec / total * 100).toFixed(1) + '%']))));
  chart('c1', 'bar', top.map(a => a.name), [{ label: 'Minutes', data: top.map(a => Math.round(a.sec / 60)), backgroundColor: COLORS[0] }],
    { indexAxis: 'y', plugins: { legend: { display: false } } });
  chart('c2', 'bar', dates, top5.map((a, i) => ({
    label: a.name, backgroundColor: COLORS[i],
    data: dates.map(d => Math.round(sum(rows.filter(r => r.date === d && r.package === a.p), r => n(r.usageSec)) / 60))
  })), { scales: { x: { stacked: true }, y: { stacked: true } } });
  drawTimeline();
}

function screenView() {
  const rows = data.screen.filter(inRange).sort(byDate);
  if (!rows.length) return setView(empty('No screen data yet. In the Android app, grant usage access and tap Sync now.'));
  setView(
    box('c1', 'Screen time (minutes) and unlocks') +
    panel('<h3>Daily detail</h3>' + table(
      ['Date', 'Screen time', 'Unlocks', 'First activity', 'Last activity', 'Overnight inactive gap'],
      rows.slice().reverse().map(r => [r.date, fmtSec(n(r.screenSec)), n(r.unlocks), r.firstActivity || '—', r.lastActivity || '—',
        n(r.sleepGapMin) > 0 ? `${String(r.sleepGapStart).slice(11)} to ${String(r.sleepGapEnd).slice(11)} (${fmtMin(n(r.sleepGapMin))})` : '—']))) );
  chart('c1', 'bar', rows.map(r => r.date), [
    { label: 'Screen time (min)', data: rows.map(r => Math.round(n(r.screenSec) / 60)), backgroundColor: COLORS[0], yAxisID: 'y' },
    { type: 'line', label: 'Unlocks', data: rows.map(r => n(r.unlocks)), borderColor: COLORS[2], backgroundColor: COLORS[2], yAxisID: 'y1' }],
    { scales: { y: { beginAtZero: true }, y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } } } });
}


/* ---------- calendar: tabs per category, search, month grouping ---------- */
async function loadCal() {
  try {
    const seen = new Set(); cal = [];
    for (const id of scope()) {
      const s = await getDocs(collection(db, 'devices', id, 'calendar'));
      s.forEach(d => { const e = d.data(), k = [e.title, e.date, e.startTime, e.endTime, e.calendar].join('|'); if (!seen.has(k)) { seen.add(k); cal.push({ ...e, deviceId: id }); } });
    }
  } catch (e) { msg('Could not load calendar: ' + e.message); cal = cal || []; }
}
function calView() {
  if (!cal) { setView(empty('Loading calendar…')); loadCal().then(() => { if (tab === 'calendar') render(); }); return; }
  setView(panel('<div class="subtabs" id="ctabs"></div>' +
    `<input id="csearch" type="search" placeholder="Search title, place, calendar, notes" value="${esc(calQ)}">`) + '<div id="clist"></div>');
  drawCal();
  $('#csearch').addEventListener('input', e => { calQ = e.target.value; calLimit = 150; drawCal(); });
  $('#ctabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    calCat = b.dataset.c; calLimit = 150; drawCal();
  });
  $('#clist').addEventListener('click', e => { if (e.target.id === 'more') { calLimit += 150; drawCal(); } });
}
function drawCal() {
  const counts = {};
  cal.forEach(e => { counts[e.category] = (counts[e.category] || 0) + 1; });
  $('#ctabs').innerHTML = CATS.map(c =>
    `<button data-c="${c}" class="${c === calCat ? 'on' : ''}">${c}<span class="badge"> ${c === 'All' ? cal.length : (counts[c] || 0)}</span></button>`).join('');
  const q = calQ.trim().toLowerCase(), t0 = today();
  const key = e => e.date + (n(e.allDay) ? '00:00' : e.startTime);
  const list = cal.filter(e => (calCat === 'All' || e.category === calCat) &&
    (!q || (e.title + ' ' + e.location + ' ' + e.calendar + ' ' + e.description).toLowerCase().includes(q)));
  const up = list.filter(e => e.date >= t0).sort((a, b) => key(a).localeCompare(key(b)));
  const past = list.filter(e => e.date < t0).sort((a, b) => key(b).localeCompare(key(a)));
  const ordered = up.concat(past);
  if (!ordered.length) { $('#clist').innerHTML = empty('No events here. (Calendar access must be granted in the Android app.)'); return; }

  let html = '', lastMonth = '', lastGroup = '';
  ordered.slice(0, calLimit).forEach(e => {
    const grp = e.date >= t0 ? 'Upcoming' : 'Past', month = e.date.slice(0, 7);
    if (grp !== lastGroup) { html += `<div class="group">${grp}</div>`; lastGroup = grp; lastMonth = ''; }
    if (month !== lastMonth) {
      html += `<div class="month">${new Date(month + '-01T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>`;
      lastMonth = month;
    }
    const dt = new Date(e.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const multi = e.endDate && e.endDate > e.date ? ' → ' + e.endDate.slice(5) : '';
    const meta = [n(e.allDay) ? 'All day' : `${e.startTime}–${e.endTime}`, e.location, e.calendar,
      n(e.attendees) > 1 ? n(e.attendees) + ' attendees' : '', e.recurring ? 'repeats' : ''].filter(Boolean).map(esc).join(' · ');
    const more = [e.description && 'Notes: ' + e.description, e.organizer && 'Organizer: ' + e.organizer,
      e.status && 'Status: ' + e.status, e.availability && 'Shown as: ' + e.availability, e.account && 'Account: ' + e.account]
      .filter(Boolean).map(esc).join('<br>');
    html += `<div class="ev"><div class="d">${esc(dt + multi)}</div><div><div class="t">${esc(e.title)}` +
      `<span class="chip c-${esc(e.category)}">${esc(e.category)}</span></div><div class="m">${meta}</div>` +
      (more ? `<details><summary>Details</summary>${more}</details>` : '') + `</div></div>`;
  });
  if (ordered.length > calLimit) html += `<button id="more" class="more">Show more (${ordered.length - calLimit} left)</button>`;
  $('#clist').innerHTML = panel(html);
}


/* ---------- notifications: by day or last 7 days, sort by time / date / app, filter by app ---------- */
async function loadNotes() {
  try {
    const out = [], from = Date.now() - 7 * 864e5;
    for (const id of scope()) {
      const s = await getDocs(query(collection(db, 'devices', id, 'notifications'), where('timestamp', '>=', from), orderBy('timestamp', 'desc'), limit(2000)));
      s.forEach(d => out.push({ ...d.data(), deviceId: id }));
    }
    notes = out; notesAt = Date.now();
  } catch (e) { msg('Could not load notifications: ' + e.message); notes = notes || []; }
}
function shiftDay(s, k) { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + k); return ymd(d); }
function notesView() {
  if (!nDate) nDate = today();
  if (!notes) { setView(empty('Loading notifications…')); loadNotes().then(() => { if (tab === 'notifications') render(); }); return; }
  const sel = (id, opts, cur) => `<select id="${id}">` + opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('') + '</select>';
  setView(panel('<div class="nbar">' +
    sel('nmode', [['day', 'One day'], ['week', 'Last 7 days']], nMode) +
    '<button id="nprev" title="Previous day">‹</button>' +
    `<input type="date" id="ndate" value="${nDate}" max="${today()}">` +
    '<button id="nnext" title="Next day">›</button><button id="ntoday">Today</button>' +
    sel('nsort', [['time_desc', 'Sort: newest first'], ['time_asc', 'Sort: oldest first'], ['date', 'Sort: date, then time'],
      ['app', 'Sort: app name A–Z'], ['appcount', 'Sort: busiest app first']], nSort) +
    '<select id="napp"></select></div>' +
    `<input id="nsearch" type="search" placeholder="Search title or text" value="${esc(nQ)}">` +
    '<div class="subtabs" id="nchips"></div>') + '<div id="nlist"></div>');
  const redraw = () => { nLimit = 200; drawNotes(); };
  $('#nmode').onchange = e => { nMode = e.target.value; redraw(); };
  $('#ndate').onchange = e => { nDate = e.target.value || today(); nMode = 'day'; $('#nmode').value = 'day'; redraw(); };
  $('#nprev').onclick = () => { nDate = shiftDay(nDate, -1); nMode = 'day'; $('#nmode').value = 'day'; $('#ndate').value = nDate; redraw(); };
  $('#nnext').onclick = () => { if (nDate < today()) nDate = shiftDay(nDate, 1); nMode = 'day'; $('#nmode').value = 'day'; $('#ndate').value = nDate; redraw(); };
  $('#ntoday').onclick = () => { nDate = today(); nMode = 'day'; $('#nmode').value = 'day'; $('#ndate').value = nDate; redraw(); };
  $('#nsort').onchange = e => { nSort = e.target.value; redraw(); };
  $('#napp').onchange = e => { nApp = e.target.value; redraw(); };
  $('#nsearch').oninput = e => { nQ = e.target.value; redraw(); };
  $('#nchips').onclick = e => { const b = e.target.closest('button'); if (b) { nApp = b.dataset.a; redraw(); } };
  $('#nlist').onclick = e => { if (e.target.id === 'nmore') { nLimit += 200; drawNotes(); } };
  drawNotes();
  if (Date.now() - notesAt > 30000) loadNotes().then(() => { if (tab === 'notifications' && $('#nlist')) drawNotes(); });
}
function drawNotes() {
  const t0 = today(), from = shiftDay(t0, -6);
  const inScope = notes.filter(r => nMode === 'day' ? r.date === nDate : (r.date >= from && r.date <= t0));
  const counts = {};
  inScope.forEach(r => { const k = r.appName || r.package; counts[k] = (counts[k] || 0) + 1; });
  if (nApp && !counts[nApp]) nApp = '';
  const apps = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  $('#napp').innerHTML = `<option value="">All apps (${inScope.length})</option>` +
    apps.slice().sort((a, b) => a.localeCompare(b)).map(a => `<option value="${esc(a)}"${a === nApp ? ' selected' : ''}>${esc(a)} (${counts[a]})</option>`).join('');
  $('#nchips').innerHTML = `<button data-a=""${nApp === '' ? ' class="on"' : ''}>All <span class="badge">${inScope.length}</span></button>` +
    apps.slice(0, 12).map(a => `<button data-a="${esc(a)}"${a === nApp ? ' class="on"' : ''}>${esc(a)} <span class="badge">${counts[a]}</span></button>`).join('');

  const q = nQ.trim().toLowerCase();
  const list = inScope.filter(r => (!nApp || (r.appName || r.package) === nApp) &&
    (!q || (String(r.title) + ' ' + String(r.text)).toLowerCase().includes(q)));
  const tsv = r => n(r.timestamp), app = r => r.appName || r.package;
  list.sort({
    time_desc: (a, b) => tsv(b) - tsv(a),
    time_asc: (a, b) => tsv(a) - tsv(b),
    date: (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : tsv(a) - tsv(b)),
    app: (a, b) => app(a).localeCompare(app(b)) || tsv(b) - tsv(a),
    appcount: (a, b) => counts[app(b)] - counts[app(a)] || app(a).localeCompare(app(b)) || tsv(b) - tsv(a)
  }[nSort]);
  if (!list.length) { $('#nlist').innerHTML = empty('No notifications for this selection. Notification access must be granted in the phone app (Settings screen), and the phone must have synced.'); return; }

  let html = '', lastHead = '';
  list.slice(0, nLimit).forEach(r => {
    let head = '';
    if (nSort === 'app' || nSort === 'appcount') head = `${app(r)} (${counts[app(r)]})`;
    else if (nMode === 'week' || nSort === 'date') head = new Date(r.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
    else head = String(r.time).slice(0, 2) + ':00';
    if (head !== lastHead) { html += `<div class="month">${esc(head)}</div>`; lastHead = head; }
    const when = String(r.time).slice(0, 5) + (nMode === 'week' && nSort.indexOf('app') === 0 ? ' · ' + String(r.date).slice(5) : '');
    html += `<div class="nrow"><div class="d">${esc(when)}</div><div><div class="a">${esc(app(r))}` +
      (r.category ? `<span class="chip">${esc(r.category)}</span>` : '') + (multi() ? `<span class="chip">${esc(devName(r.deviceId))}</span>` : '') + '</div>' +
      (r.title ? `<div>${esc(r.title)}</div>` : '') + (r.text ? `<div class="m x">${esc(r.text)}</div>` : '') + '</div></div>';
  });
  if (list.length > nLimit) html += `<button id="nmore" class="more">Show more (${list.length - nLimit} left)</button>`;
  $('#nlist').innerHTML = panel(html);
}


/* ---------- insights: battery thresholds, charge/discharge time, top apps over the selected range ---------- */
function insightsView() {
  const rows = devRows().filter(inRange);
  if (rows.length < 2) { setView(empty('Not enough battery history yet for this range. Try a longer range or wait for more syncs.')); return; }
  const thresholds = [10, 5, 1];
  const below = {}; thresholds.forEach(t => below[t] = { crossings: 0, ms: 0 });
  let above90 = 0, chargeSessions = 0, dischargeSessions = 0, chargeMs = 0, dischargeMs = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i], dt = ts(b) - ts(a);
    if (dt <= 0 || dt > 3_600_000) continue;                 // ignore gaps over an hour (phone was off/offline)
    const pa = n(a.batteryPct), pb = n(b.batteryPct);
    thresholds.forEach(t => { if (pa >= t && pb < t) below[t].crossings++; if (pb < t) below[t].ms += dt; });
    if (pa < 90 && pb >= 90) above90++;
    const ca = n(a.charging) === 1, cb = n(b.charging) === 1;
    if (cb) chargeMs += dt; else dischargeMs += dt;
    if (!ca && cb) chargeSessions++;
    if (ca && !cb) dischargeSessions++;
  }
  const apps1 = data.appUsage.filter(inRange);
  const byApp = {};
  apps1.forEach(r => { const k = r.appName || r.package; byApp[k] = (byApp[k] || 0) + n(r.usageSec); });
  const topApps = Object.entries(byApp).sort((a, b) => b[1] - a[1]).slice(0, 8);

  setView(
    `<div class="cards">${rateCard()}` +
    card('Charging time', fmtMin(chargeMs / 60000), `${chargeSessions} session${chargeSessions === 1 ? '' : 's'}`) +
    card('Discharging time', fmtMin(dischargeMs / 60000), `${dischargeSessions} session${dischargeSessions === 1 ? '' : 's'}`) +
    thresholds.map(t => card(`Below ${t}%`, below[t].crossings + ' time' + (below[t].crossings === 1 ? '' : 's'), fmtMin(below[t].ms / 60000) + ' total')).join('') +
    card('Reached 90%+', above90 + ' time' + (above90 === 1 ? '' : 's')) +
    `</div>` +
    box('c1', 'Battery % over time (crossings marked)') +
    panel('<h3>Most-used apps in this range</h3>' + (topApps.length
      ? topApps.map(([name, sec]) => `<div class="kv"><span>${esc(name)}</span><b>${fmtSec(sec)}</b></div>`).join('')
      : '<p class="empty">No app-usage data in this range.</p>')) +
    panel('<h3>About battery-per-app</h3><p class="hint">Android does not let regular apps read how many mAh each app actually drew — that number is only available to the system. ' +
      'This page instead shows how long each app was on screen (above) and your phone\'s overall charge/discharge pattern. If you want true per-app battery stats, some advanced users grant the ' +
      '<code>android.permission.BATTERY_STATS</code> permission once over USB with <code>adb shell pm grant com.example.activitytracker android.permission.BATTERY_STATS</code>, then read it from ' +
      '<code>dumpsys batterystats</code> on the phone — this is not wired into the app yet and behaves inconsistently across phone brands.</p>'));
  const labels = rows.map(r => stamp(ts(r)));
  chart('c1', 'line', labels, [{ label: 'Battery %', data: rows.map(r => n(r.batteryPct)), borderColor: COLORS[1], pointRadius: 2, tension: .2 }],
    { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100 } } });
}


const noPhones = () => panel('<h3>No phones yet</h3><p class="hint">Open the Android app, tap <b>Pair with website (QR)</b>, then tap <b>Add phone</b> above and scan the code.</p>');

function renderBanner() {
  const el = $('#banner'); if (!el) return;
  const frozen = scope().map(id => devices[id]).filter(isFrozen);
  el.innerHTML = frozen.map(d => `<div class="note frozen">❄ <b>${esc(d.name)}</b> is frozen. ${esc(devStatus(d).t)}. Nothing new is collected and remote control is off until it is resumed in the phone app` +
    (d.frozenUntil ? ' (or the timer ends).' : '.') + ' When it resumes, usage from the frozen period is filled in automatically.</div>').join('');
}

/* ---------- overview ---------- */
function overview() {
  if (!Object.keys(devices).length) return setView(noPhones());
  const apps = data.appUsage.filter(inRange), scr = data.screen.filter(inRange);
  const sm = data.summary.filter(inRange).sort(byDate);
  const dev = latestDevice();
  const events = data.calendar.filter(inRange).length;
  const phones = sel === 'all' && multi()
    ? `<div class="cards">${scope().map(id => { const d = devices[id], st = devStatus(d), l = d.last || {};
        return card(`<span class="dot dot-${st.k}"></span> ${esc(d.name)}`, l.batteryPct !== undefined ? n(l.batteryPct) + '%' : '—', esc(st.t) + (l.charging ? ' · charging' : '')); }).join('')}</div>`
    : '';
  const single = !(sel === 'all' && multi());
  setView(
    phones + `<div class="cards">` +
    card('App usage', apps.length ? fmtSec(sum(apps, r => n(r.usageSec))) : '—') +
    card('Screen time', scr.length ? fmtSec(sum(scr, r => n(r.screenSec))) : '—') +
    card('Unlocks', scr.length ? sum(scr, r => n(r.unlocks)) : '—') +
    (single ? card('Battery', dev ? n(dev.batteryPct) + '%' : '—', dev ? (n(dev.charging) ? 'Charging' : 'Not charging') : '') +
      card('Free storage', dev ? gb(dev.freeStorageMB) : '—', dev ? 'of ' + gb(dev.totalStorageMB) : '') + rateCard() : '') +
    card('Calendar events', cal ? events : '—', cal ? '' : 'open the Calendar tab to load') +
    `</div>` +
    box('c1', 'Daily app usage and screen time (minutes)') +
    panel('<h3>Daily summary</h3>' + table(
      ['Date', 'App usage', 'Screen time', 'Unlocks', 'Top app', 'Events'],
      sm.slice().reverse().map(r => [r.date, fmtMin(n(r.totalAppUsageMin)), fmtMin(n(r.totalScreenMin)), n(r.unlocks),
        esc(r.topApp) || '—', n(r.calendarEvents)]))));
  chart('c1', 'bar', sm.map(r => r.date), [
    { label: 'App usage', data: sm.map(r => Math.round(n(r.totalAppUsageMin))), backgroundColor: COLORS[0] },
    { label: 'Screen time', data: sm.map(r => Math.round(n(r.totalScreenMin))), backgroundColor: COLORS[1] }]);
}

/* ---------- device tab: pick a time range and how finely to slice it ---------- */
const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 864e5, '3d': 3 * 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };
const BUCKETS = { sec: 1000, min: 60e3, hour: 3600e3, day: 864e5 };
const autoBucket = span => (span <= 2 * 3600e3 ? 'sec' : span <= 12 * 3600e3 ? 'min' : span <= 7 * 864e5 ? 'hour' : 'day');
function bucketize(rows, b) {
  if (b === 'sec') return rows;
  const ms = BUCKETS[b], g = new Map();
  rows.forEach(r => { const k = Math.floor(ts(r) / ms) * ms; if (!g.has(k)) g.set(k, []); g.get(k).push(r); });
  return [...g.entries()].sort((a, b2) => a[0] - b2[0]).map(([k, rs]) => {
    const avg = f => rs.reduce((t, r) => t + n(r[f]), 0) / rs.length, last = rs[rs.length - 1];
    return { timestamp: k, date: last.date, batteryPct: +avg('batteryPct').toFixed(1), charging: last.charging, currentMa: Math.round(avg('currentMa')),
      tempC: +avg('tempC').toFixed(1), freeStorageMB: last.freeStorageMB, totalStorageMB: last.totalStorageMB, network: last.network };
  });
}
function deviceView() {
  const ids = scope(); if (!ids.length) return setView(noPhones());
  const span = RANGES[devRange], bucket = devBucket === 'auto' ? autoBucket(span) : devBucket, from = Date.now() - span;
  const hoursNeeded = Math.min(72, Math.ceil(span / 3.6e6));
  if (ids.some(id => (store[id] || {}).rawHours < hoursNeeded)) { Promise.all(ids.map(id => loadRaw(id, hoursNeeded))).then(() => { rebuild(); if (tab === 'device') deviceView(); }); }
  const series = ids.map(id => ({ id, rows: bucketize(devRows(id).filter(r => ts(r) >= from), bucket) }));
  const dev = latestDevice(), allRows = devRows(primary()).filter(inRange);
  const sessions = sum(data.summary.filter(inRange), r => n(r.chargingSessions));
  const note = [bucket === 'sec' || bucket === 'min' ? 'Samples arrive every 15 s while a dashboard is open (Live) and about every 15 minutes otherwise, so quiet periods show as gaps.' : '',
    (bucket === 'sec' || bucket === 'min') && span > 72 * 3600e3 ? 'Per-second and per-minute detail is kept for 72 hours; older history is hourly.' : ''].filter(Boolean).join(' ');
  setView(
    panel('<div class="nbar"><b>Show</b>' +
      sel_('drange', [['1h', 'Last hour'], ['6h', 'Last 6 hours'], ['24h', 'Last 24 hours'], ['3d', 'Last 3 days'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']], devRange) +
      '<b>One point per</b>' + sel_('dbucket', [['auto', 'Automatic'], ['sec', 'Sample (seconds)'], ['min', 'Minute'], ['hour', 'Hour'], ['day', 'Day']], devBucket) +
      `<span class="hint">${esc(bucket === 'sec' ? 'raw samples' : '1 ' + bucket)} · ${series.reduce((t, s) => t + s.rows.length, 0)} points</span></div>` + (note ? `<p class="hint">${esc(note)}</p>` : '')) +
    `<div class="cards">` +
    card('Battery', dev ? n(dev.batteryPct) + '%' : '—', dev ? 'as of ' + stamp(ts(dev)) : '') +
    card('Charging', dev ? (n(dev.charging) ? 'Yes' : 'No') : '—', `${sessions} session${sessions === 1 ? '' : 's'} in range (estimated)`) +
    rateCard() +
    card('Temperature', dev && dev.tempC !== undefined && dev.tempC !== '' ? n(dev.tempC).toFixed(1) + ' °C' : '—') +
    card('Free storage', dev ? gb(dev.freeStorageMB) : '—', dev ? 'of ' + gb(dev.totalStorageMB) : '') +
    card('Network', dev ? esc(dev.network) : '—') +
    `</div>` +
    `<div class="two">${box('c1', 'Battery history (%)')}${box('c2', 'Free storage (GB)')}</div>` +
    panel('<h3>Recent status snapshots</h3>' + table(['Time', 'Battery', 'Charging', 'Current', 'Network', 'Free storage'],
      allRows.slice(-12).reverse().map(r => [stamp(ts(r)), n(r.batteryPct) + '%', n(r.charging) ? 'Yes' : 'No',
        n(r.currentMa) ? n(r.currentMa) + ' mA' : '—', esc(r.network), gb(r.freeStorageMB)]))));
  $('#drange').onchange = e => { devRange = e.target.value; deviceView(); };
  $('#dbucket').onchange = e => { devBucket = e.target.value; deviceView(); };
  const gap = Math.max(BUCKETS[bucket] * 4, 40 * 60e3), fine = span <= 36 * 3600e3;
  const axis = { type: 'linear', min: from, max: Date.now(), ticks: { maxTicksLimit: 8, callback: v => (fine ? clock(v, bucket === 'sec') : stamp(v)) } };
  const opts = (extra = {}) => ({ parsing: false, animation: false, scales: { x: axis, ...(extra.scales || {}) },
    plugins: { legend: { display: ids.length > 1 }, tooltip: { callbacks: { title: it => new Date(it[0].parsed.x).toLocaleString() } } } });
  const ds = (f, fn = v => n(v)) => series.map((s, i) => ({ label: devName(s.id), data: s.rows.map(r => ({ x: ts(r), y: fn(r[f]) })),
    borderColor: COLORS[i % COLORS.length], backgroundColor: COLORS[i % COLORS.length], pointRadius: s.rows.length > 300 ? 0 : 2, tension: .2, spanGaps: gap }));
  chart('c1', 'line', undefined, ds('batteryPct'), opts({ scales: { y: { min: 0, max: 100 } } }));
  chart('c2', 'line', undefined, ds('freeStorageMB', v => +(n(v) / 1024).toFixed(1)), opts());
}

/* ---------- app usage over time: minute / hour / day ---------- */
const AT_RANGES = { minute: [['1h', 'Last hour'], ['3h', 'Last 3 hours'], ['6h', 'Last 6 hours']],
  hour: [['12h', 'Last 12 hours'], ['24h', 'Last 24 hours'], ['48h', 'Last 48 hours'], ['7d', 'Last 7 days']] };
const AT_MS = { '1h': 3600e3, '3h': 3 * 3600e3, '6h': 6 * 3600e3, '12h': 12 * 3600e3, '24h': 864e5, '48h': 2 * 864e5, '7d': 7 * 864e5 };
function drawTimeline() {
  const host = $('#attl'); if (!host) return;
  if (!AT_RANGES[atRes] && atRes !== 'day') atRes = 'hour';
  if (atRes !== 'day' && !AT_RANGES[atRes].some(r => r[0] === atRange)) atRange = atRes === 'minute' ? '3h' : '24h';
  const needDays = atRes === 'hour' && atRange === '7d' ? 7 : 2;
  if (scope().some(id => (store[id] || {}).hourlyDays < needDays)) Promise.all(scope().map(id => loadHourly(id, needDays))).then(() => { rebuild(); drawTimeline(); });
  const size = atRes === 'minute' ? 60e3 : atRes === 'hour' ? 3600e3 : 864e5;
  const from = atRes === 'day' ? new Date(cutoff() + 'T00:00:00').getTime() : Date.now() - AT_MS[atRange];
  let items = [];
  if (atRes === 'minute') data.hourly.forEach(r => (r.min || []).forEach((s, i) => { const t = n(r.timestamp) + i * 60e3; if (s > 0 && t >= from) items.push({ t, pkg: r.package, name: r.appName || r.package, sec: n(s) }); }));
  else if (atRes === 'hour') data.hourly.forEach(r => { if (n(r.timestamp) + 3600e3 > from) items.push({ t: n(r.timestamp), pkg: r.package, name: r.appName || r.package, sec: n(r.usageSec) }); });
  else data.appUsage.filter(inRange).forEach(r => items.push({ t: new Date(r.date + 'T00:00:00').getTime(), pkg: r.package, name: r.appName || r.package, sec: n(r.usageSec) }));
  const names = {}; items.forEach(i => { names[i.pkg] = i.name; });
  if (atApp && !names[atApp]) atApp = '';
  const all = items; if (atApp) items = items.filter(i => i.pkg === atApp);
  const tot = {}; items.forEach(i => { tot[i.pkg] = (tot[i.pkg] || 0) + i.sec; });
  const top = Object.keys(tot).sort((a, b) => tot[b] - tot[a]).slice(0, atApp ? 1 : 5);
  const start = Math.floor(from / size) * size, labels = [], idx = {};
  for (let t = start; t <= Date.now(); t += size) { idx[t] = labels.length; labels.push(t); }
  const unit = atRes === 'minute' ? 1 : 60;                                   // minute view: seconds; others: minutes
  const rows = top.map(p => ({ p, name: names[p], d: new Array(labels.length).fill(0) })).concat(atApp ? [] : [{ p: '', name: 'Other', d: new Array(labels.length).fill(0) }]);
  items.forEach(i => { const k = idx[Math.floor(i.t / size) * size]; if (k === undefined) return; const r = rows.find(x => x.p === i.pkg) || rows[rows.length - 1]; r.d[k] += i.sec / unit; });
  const lab = t => atRes === 'minute' ? clock(t) : atRes === 'hour' ? (AT_MS[atRange] > 2 * 864e5 ? stamp(t).slice(0, 8) + ':00' : clock(t)) : ymd(new Date(t));
  host.innerHTML = panel('<h3>App usage over time</h3><div class="nbar">' +
    sel_('atres', [['minute', 'Per minute'], ['hour', 'Per hour'], ['day', 'Per day']], atRes) +
    (atRes === 'day' ? '<span class="hint">uses the 1 / 7 / 30 day buttons at the top</span>' : sel_('atrange', AT_RANGES[atRes], atRange)) +
    sel_('atapp', [['', 'All apps'], ...Object.keys(names).sort((a, b) => names[a].localeCompare(names[b])).map(p => [p, names[p]])], atApp) +
    '</div>' + (atRes === 'minute' ? '<p class="hint">Bars show seconds of use in each minute. Android does not record app use below one second.</p>' : '') +
    '<div class="chartbox"><canvas id="atc"></canvas></div>' +
    (top.length ? '<div class="kvs">' + top.map(p => `<div class="kv"><span>${esc(names[p])}</span><b>${fmtSec(tot[p])}</b></div>`).join('') + '</div>' : '<p class="empty">No app usage in this period yet.</p>'));
  $('#atres').onchange = e => { atRes = e.target.value; drawTimeline(); };
  if ($('#atrange')) $('#atrange').onchange = e => { atRange = e.target.value; drawTimeline(); };
  $('#atapp').onchange = e => { atApp = e.target.value; drawTimeline(); };
  const el = $('#atc');
  if (el && window.Chart) charts.push(new Chart(el, { type: 'bar', data: { labels: labels.map(lab), datasets: rows.map((r, i) => ({ label: r.name, data: r.d.map(v => +v.toFixed(1)), backgroundColor: COLORS[i % COLORS.length] })) },
    options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { x: { stacked: true, ticks: { maxTicksLimit: 12 } }, y: { stacked: true, title: { display: true, text: atRes === 'minute' ? 'seconds' : 'minutes' } } } } }));
}

/* ---------- remote control ---------- */
const STATUS_CLS = { done: 'st-done', failed: 'st-failed', pending: 'st-pending', expired: 'st-failed' };
function cstat(t, cls) {
  const el = $('#cstatus'); if (!el) { msg(t); return; }
  el.innerHTML = cls ? `<span class="pill pill-${cls}">${esc(t)}</span>` : esc(t);
}
function drawAudit(list) {
  const el = $('#audit'); if (!el) return;
  el.innerHTML = table(['Time', 'Command', 'Details', 'Status', 'Result'], (list || []).map(c => [
    stamp(c.createdAt), esc(c.type), esc(String(c.params || '').replace(/[{}"]/g, '')),
    `<span class="${STATUS_CLS[c.status] || ''}">${esc(c.status)}</span>`,
    /^shot:/.test(c.result || '') ? `<a href="#" data-shot="${esc(c.result.slice(5))}">View screenshot</a>` : esc(c.result)]));
}
function stopAudit() { if (auditUnsub) { auditUnsub(); auditUnsub = null; } }
function startAudit() {
  stopAudit(); if (!ctl) return;
  auditUnsub = onSnapshot(query(collection(db, 'devices', ctl, 'commands'), orderBy('createdAt', 'desc'), limit(30)), s => drawAudit(s.docs.map(d => ({ id: d.id, ...d.data() }))));
}
/** Runs a command: Cloud Function validates and pushes it, then we watch the command document until the phone reports back. */
async function sendCmd(type, params, label, btn) {
  const d = devices[ctl];
  if (!d) { cstat('Choose a phone first.', 'bad'); return null; }
  if (isFrozen(d)) { cstat(`${label}: this phone is frozen. Resume it in the phone app first.`, 'bad'); return null; }
  if (btn) btn.disabled = true;
  cstat(`Running “${label}”…`, 'run');
  let r;
  try { r = await api('command', { deviceId: ctl, type, params: params || {} }); }
  catch (e) { cstat(`${label}: ${e.message}`, 'bad'); if (btn) btn.disabled = false; return null; }
  cstat(`${label}: ${r.pushed ? 'sent, waiting for the phone…' : 'push not delivered, waiting for the phone’s next sync…'}`, 'run');
  const id = ctl;
  return await new Promise(resolve => {
    let finished = false, stop = null, timer = null;
    const end = (text, ok, c) => { if (finished) return; finished = true; if (stop) stop(); clearTimeout(timer); cstat(text, ok ? 'ok' : 'bad'); if (btn) btn.disabled = false; resolve(c); };
    stop = onSnapshot(doc(db, 'devices', id, 'commands', r.id), snap => {
      const c = snap.data(); if (!c || c.status === 'pending') return;
      end(`${label}: ${c.status}${c.result ? ' — ' + (/^shot:/.test(c.result) ? 'saved, see the audit trail below' : c.result) : ''}`, c.status === 'done', c);
    });
    timer = setTimeout(() => end(`${label}: no reply yet (commands expire after 2 minutes)`, false, null), 130000);
  });
}

function remoteView() {
  const ids = Object.keys(devices); if (!ids.length) return setView(noPhones());
  if (!devices[ctl]) ctl = primary();
  const d = devices[ctl], frozen = isFrozen(d);
  const btn = (id, label) => `<button data-cmd="${id}"${frozen ? ' disabled' : ''}>${label}</button>`;
  setView(
    panel('<h3>Phone</h3>' + sel_('ctlsel', ids.map(id => [id, devices[id].name]), ctl) +
      `<p class="hint">${esc(devStatus(d).t)}</p>` + (frozen ? '<p class="warn">❄ Frozen: every command is blocked until the phone is resumed in its app.</p>' : '')) +
    panel('<h3>Remote control</h3><p id="cstatus" class="statline"></p><div class="btns">' +
      `<button id="refreshPhone" class="primary"${frozen ? ' disabled' : ''}>Refresh phone</button>` +
      btn('ring', 'Ring') + btn('ring_stop', 'Stop ring') + btn('flashlight_on', 'Flashlight on') + btn('flashlight_off', 'Flashlight off') +
      btn('dnd_on', 'Do Not Disturb on') + btn('dnd_off', 'Do Not Disturb off') + btn('lock_screen', 'Lock screen') +
      btn('bluetooth_on', 'Bluetooth on') + btn('bluetooth_off', 'Bluetooth off') + btn('screenshot', 'Screenshot') +
      '</div><p class="hint" style="margin-top:10px">Each command can be switched off in the phone’s settings and expires after 2 minutes. ' +
      'Bluetooth and Screenshot always show Android’s own confirmation on the phone — no app can skip that.</p>') +
    panel('<h3>Open app</h3><p class="hint">Opens directly if the phone is locked. If it is unlocked and in use, Android requires one tap on the notification — no app can skip that either.</p>' +
      '<select id="pkg"></select><button id="openApp"' + (frozen ? ' disabled' : '') + '>Open</button>') +
    panel('<h3>Send SMS</h3><p class="warn">Needs SMS enabled and a PIN set on the phone. The PIN is checked on the phone and is never stored.</p>' +
      '<input id="smsTo" type="text" placeholder="number, e.g. +919876543210"><input id="smsText" type="text" placeholder="message (max 320 characters)">' +
      '<input id="smsPin" type="password" autocomplete="off" placeholder="phone SMS PIN"><button id="sendSms"' + (frozen ? ' disabled' : '') + '>Send SMS</button>') +
    panel('<h3>Audit trail</h3><div id="audit"></div>'));
  $('#ctlsel').onchange = e => { ctl = e.target.value; remoteView(); };
  $('#refreshPhone').onclick = async e => { const c = await sendCmd('sync_now', {}, 'Refresh phone', e.target); if (c && c.status === 'done') { await load(true); cstat('Refresh phone: done, data reloaded ' + new Date().toLocaleTimeString(), 'ok'); } };
  $('#openApp').onclick = e => { const v = $('#pkg').value; if (v) sendCmd('open_app', { package: v }, 'Open app', e.target); };
  $('#sendSms').onclick = async e => {
    const pin = $('#smsPin').value; $('#smsPin').value = '';
    await sendCmd('send_sms', { to: $('#smsTo').value.trim(), text: $('#smsText').value, pin }, 'Send SMS', e.target);
  };
  $('#view').querySelectorAll('[data-cmd]').forEach(b => b.onclick = e => {
    const c = b.dataset.cmd;
    if (c === 'dnd_on' || c === 'dnd_off') sendCmd('dnd_mode', { on: c === 'dnd_on' }, b.textContent, e.target);
    else sendCmd(c, {}, b.textContent, e.target);
  });
  $('#audit').onclick = async e => {
    const a = e.target.closest('[data-shot]'); if (!a) return; e.preventDefault();
    try {
      const sh = await getDoc(doc(db, 'devices', ctl, 'screenshots', a.dataset.shot));
      if (!sh.exists()) throw new Error('it was already deleted (screenshots are kept 3 days)');
      $('#shotimg').src = 'data:image/jpeg;base64,' + sh.data().b64; $('#shotdlg').showModal();
    } catch (err) { cstat('Could not open the screenshot: ' + err.message, 'bad'); }
  };
  const apps = (d.installedApps || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  $('#pkg').innerHTML = apps.length ? '<option value="">Choose an app…</option>' + apps.map(a => `<option value="${esc(a.package)}">${esc(a.name)}</option>`).join('')
    : '<option value="">No app list yet — open the Android app once and sync</option>';
  startAudit();
}

/* ---------- phones & alerts ---------- */
async function phonesView() {
  const ids = Object.keys(devices);
  const cards = ids.map(id => {
    const d = devices[id], st = devStatus(d), a = Object.assign({ lowBattery: 20, offlineMin: 90 }, d.alerts || {});
    return panel(`<h3><span class="dot dot-${st.k}"></span> ${esc(d.name)} <span class="hint">${esc(d.model || '')}</span></h3>` +
      `<p class="hint">${esc(st.t)} · app ${esc(d.appVersion || '?')} · data schema v${esc(d.schemaVersion ?? '?')}${d.pairedAt ? ' · paired ' + new Date(d.pairedAt).toLocaleDateString() : ''}</p>` +
      `<div class="nbar"><input type="text" data-name="${id}" value="${esc(d.name)}" maxlength="40" aria-label="Phone name"><button data-savename="${id}">Rename</button></div>` +
      `<div class="nbar"><label class="inl">E-mail me when battery ≤ <input type="number" min="0" max="90" data-low="${id}" value="${a.lowBattery}"> % (0 = off)</label>` +
      `<label class="inl">…or no data for <input type="number" min="0" max="1440" data-off="${id}" value="${a.offlineMin}"> min (0 = off)</label>` +
      `<button data-savealerts="${id}">Save alerts</button></div>` +
      `<button data-remove="${id}" class="danger">Remove this phone from my account</button>`);
  }).join('') || noPhones();
  setView(cards + panel('<h3>Gmail alerts</h3><p class="hint">Alerts are sent from your project’s Gmail sender to the address below.</p>' +
    '<label class="sw"><input type="checkbox" id="alertson"><span class="knob"></span><span>Send alert e-mails</span></label>' +
    `<input type="text" id="alertmail" placeholder="${esc(user.email || '')}" aria-label="Alert e-mail address">` +
    '<div class="nbar"><button id="savemail">Save</button><button id="testmail">Send test e-mail</button><span id="mailst" class="hint"></span></div>'));
  try {
    const u = await getDoc(doc(db, 'users', user.uid));
    if ($('#alertson')) { $('#alertson').checked = !(u.exists() && u.data().alertsEnabled === false); $('#alertmail').value = (u.exists() && u.data().alertEmail) || ''; }
  } catch (e) { /* defaults shown */ }
  $('#savemail').onclick = async () => {
    try { await setDoc(doc(db, 'users', user.uid), { alertsEnabled: $('#alertson').checked, alertEmail: $('#alertmail').value.trim(), updatedAt: Date.now() }, { merge: true }); $('#mailst').textContent = 'Saved.'; }
    catch (e) { $('#mailst').textContent = 'Could not save: ' + e.message; }
  };
  $('#testmail').onclick = async () => {
    $('#mailst').textContent = 'Sending…';
    try { const r = await api('testAlert'); $('#mailst').textContent = 'Sent to ' + r.to; } catch (e) { $('#mailst').textContent = e.message; }
  };
  $('#view').onclick = async e => {
    const t = e.target.closest('button'); if (!t) return;
    const v = sel => $(`[${sel}="${t.dataset[sel.replace('data-', '')]}"]`);
    try {
      if (t.dataset.savename) { const nm = v('data-name').value.trim(); if (nm) await updateDoc(doc(db, 'devices', t.dataset.savename), { name: nm }); msg('Renamed. The phone adopts the new name on its next sync.'); }
      else if (t.dataset.savealerts) { const id = t.dataset.savealerts; await updateDoc(doc(db, 'devices', id), { alerts: { lowBattery: Math.max(0, +document.querySelector(`[data-low="${id}"]`).value || 0), offlineMin: Math.max(0, +document.querySelector(`[data-off="${id}"]`).value || 0) } }); msg('Alert settings saved.'); }
      else if (t.dataset.remove && confirm('Remove this phone from your account? Its data stays on the phone side but you will no longer see it. You can pair it again later.'))
        { await updateDoc(doc(db, 'devices', t.dataset.remove), { ownerUid: null, ownerEmail: '' }); msg('Phone removed.'); }
    } catch (err) { msg('Could not save: ' + err.message); }
  };
}

/* ---------- live notifications drawer ---------- */
function renderDrawer() {
  const list = Object.values(liveNotes).flat().sort((a, b) => n(b.timestamp) - n(a.timestamp)).slice(0, 100);
  const seen = n(store_.get(K.seen)), open = !$('#drawer').hidden;
  const unread = list.filter(r => n(r.timestamp) > seen).length;
  const b = $('#bellbadge'); b.textContent = unread > 99 ? '99+' : unread; b.hidden = open || !unread;
  if (open && list.length) store_.set(K.seen, String(n(list[0].timestamp)));
  $('#drawerlist').innerHTML = list.length ? list.map(r => `<div class="nrow"><div class="d">${esc(String(r.time || '').slice(0, 5))}<br><span class="hint">${esc(String(r.date || '').slice(5))}</span></div><div><div class="a">${esc(r.appName || r.package)}` +
    (multi() ? `<span class="chip">${esc(devName(r.deviceId))}</span>` : '') + '</div>' + (r.title ? `<div>${esc(r.title)}</div>` : '') + (r.text ? `<div class="m x">${esc(r.text)}</div>` : '') + '</div></div>').join('')
    : '<p class="empty">No notifications yet. Grant notification access in the phone app’s Settings screen.</p>';
}

/* ---------- loading ---------- */
const ymdAgo = k => { const d = new Date(); d.setDate(d.getDate() - k); return ymd(d); };
async function loadRaw(id, hours) {
  const s = (store[id] ||= {}); s.rawHours = Math.max(s.rawHours || 0, hours);
  const snap = await getDocs(query(collection(db, 'devices', id, 'samples'), where('timestamp', '>=', Date.now() - s.rawHours * 3.6e6), orderBy('timestamp', 'desc'), limit(s.rawHours > 24 ? 20000 : 6000)));
  s.samples = snap.docs.map(d => d.data()).reverse();
}
async function loadHourly(id, daysBack) {
  const s = (store[id] ||= {}); s.hourlyDays = Math.max(s.hourlyDays || 0, daysBack);
  const snap = await getDocs(query(collection(db, 'devices', id, 'usage_hourly'), where('timestamp', '>=', Date.now() - s.hourlyDays * 864e5)));
  s.hourly = snap.docs.map(d => d.data());
}
async function loadDevice(id) {
  const s = (store[id] ||= {}), dref = doc(db, 'devices', id), cut = ymdAgo(30);
  s.rawHours = Math.max(24, s.rawHours || 0); s.hourlyDays = Math.max(2, s.hourlyDays || 0);
  const [u, sc, r] = await Promise.all([
    getDocs(query(collection(dref, 'usage'), where('date', '>=', cut))),
    getDocs(query(collection(dref, 'screen'), where('date', '>=', cut))),
    getDocs(query(collection(dref, 'rollup_hour'), where('timestamp', '>=', Date.now() - 30 * 864e5)))]);
  s.usage = u.docs.map(d => d.data()); s.screen = sc.docs.map(d => d.data()); s.rollup = r.docs.map(d => d.data());
  await Promise.all([loadRaw(id, s.rawHours), loadHourly(id, s.hourlyDays)]);
}
function rebuild() {
  const out = { appUsage: [], screen: [], device: [], hourly: [] };
  scope().forEach(id => {
    const s = store[id]; if (!s) return;
    (s.usage || []).forEach(r => out.appUsage.push({ ...r, deviceId: id }));
    (s.screen || []).forEach(r => out.screen.push({ ...r, deviceId: id }));
    (s.hourly || []).forEach(r => out.hourly.push({ ...r, deviceId: id }));
    const raw = s.samples || [], rawStart = raw.length ? ts(raw[0]) : Infinity;
    (s.rollup || []).filter(r => ts(r) < rawStart).forEach(r => out.device.push({ ...r, deviceId: id }));   // hourly averages where raw samples are gone
    raw.forEach(r => out.device.push({ ...r, deviceId: id }));
  });
  const by = {}, mk = d => (by[d] ||= { date: d, totalAppUsageMin: 0, totalScreenMin: 0, unlocks: 0, apps: {}, calendarEvents: 0, chargingSessions: 0 });
  out.appUsage.forEach(r => { const x = mk(r.date); x.totalAppUsageMin += n(r.usageSec) / 60; const k = r.appName || r.package; x.apps[k] = (x.apps[k] || 0) + n(r.usageSec); });
  out.screen.forEach(r => { const x = mk(r.date); x.totalScreenMin += n(r.screenSec) / 60; x.unlocks += n(r.unlocks); });
  (cal || []).forEach(e => { if (by[e.date]) by[e.date].calendarEvents++; });
  scope().forEach(id => { let prev = null; out.device.filter(r => r.deviceId === id).sort((a, b) => ts(a) - ts(b)).forEach(r => { if (prev !== null && !prev && n(r.charging) === 1) mk(r.date).chargingSessions++; prev = n(r.charging) === 1; }); });
  out.summary = Object.values(by).map(x => ({ ...x, topApp: Object.entries(x.apps).sort((a, b) => b[1] - a[1]).map(e => e[0])[0] || '' }));
  out.calendar = cal || [];
  data = out;
}

/* ---------- views / render ---------- */
const views = { overview, apps: appsView, screen: screenView, device: deviceView, calendar: calView, notifications: notesView, insights: insightsView, remote: remoteView, phones: phonesView };
function render() {
  if (tab !== 'remote') stopAudit();
  renderBanner();
  if (!user) return;
  (views[tab] || overview)();
}
let renderTimer = 0;
function softRender() {            // live data arrived: redraw the data tabs, but never while someone is using a drop-down
  if (!['overview', 'device', 'insights'].includes(tab)) return;
  if (document.activeElement && document.activeElement.tagName === 'SELECT') return;
  clearTimeout(renderTimer); renderTimer = setTimeout(() => { rebuild(); render(); msg('Live · ' + new Date().toLocaleTimeString()); }, 400);
}
async function load(quiet) {
  if (!user) return;
  if (!quiet) { msg('Loading…'); cal = null; notes = null; }
  try {
    await Promise.all(scope().map(loadDevice));
    rebuild();
    msg('Updated ' + new Date().toLocaleString());
    if (!(quiet && tab === 'remote')) render();
  } catch (e) { msg('Could not load data: ' + e.message); }
}

/* ---------- realtime listeners ---------- */
function attachDevice(id) {
  if (deviceUnsubs[id]) return;
  const dref = doc(db, 'devices', id);
  const u1 = onSnapshot(query(collection(dref, 'samples'), orderBy('timestamp', 'desc'), limit(10)), snap => {     // newest battery samples, instantly
    const s = (store[id] ||= {}); s.samples = s.samples || [];
    const lastTs = s.samples.length ? ts(s.samples[s.samples.length - 1]) : 0;
    const fresh = snap.docs.map(d => d.data()).filter(r => ts(r) > lastTs).reverse();
    if (fresh.length) { s.samples.push(...fresh); softRender(); }
  }, () => {});
  const u2 = onSnapshot(query(collection(dref, 'notifications'), orderBy('timestamp', 'desc'), limit(40)), snap => {
    liveNotes[id] = snap.docs.map(d => ({ ...d.data(), deviceId: id })); renderDrawer();
    if (tab === 'notifications' && notes && document.activeElement && document.activeElement.tagName !== 'SELECT') loadNotes().then(() => { if (tab === 'notifications' && $('#nlist')) drawNotes(); });
  }, () => {});
  deviceUnsubs[id] = [u1, u2];
}
function detachDevice(id) { (deviceUnsubs[id] || []).forEach(f => f()); delete deviceUnsubs[id]; delete liveNotes[id]; delete store[id]; }

const dot = d => ({ live: '🟢', on: '🟡', off: '⚪', frozen: '❄️' }[devStatus(d).k]);
function fillSelect() {
  const ids = Object.keys(devices);
  if (sel !== 'all' && !devices[sel]) sel = ids.length > 1 ? 'all' : (ids[0] || 'all');
  const opts = (ids.length > 1 ? [['all', 'All phones']] : []).concat(ids.map(id => [id, `${dot(devices[id])} ${devices[id].name}`]));
  const el = $('#device');
  el.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('') || '<option value="">No phones yet</option>';
  el.value = sel;
  if (el.value !== sel && opts.length) { sel = opts[0][0]; el.value = sel; }
}
function startDevices() {
  unsubs.push(onSnapshot(query(collection(db, 'devices'), where('ownerUid', '==', user.uid)), async snap => {
    const prev = new Set(Object.keys(devices)), now = {};
    snap.docs.forEach(d => { now[d.id] = d.data(); });
    devices = now;
    const added = Object.keys(now).filter(id => !prev.has(id)), gone = [...prev].filter(id => !now[id]);
    gone.forEach(detachDevice);
    const saved = store_.get(K.sel); if (!prev.size && saved && (saved === 'all' || now[saved])) sel = saved;
    fillSelect(); renderBanner();
    if (added.length || gone.length) {
      added.forEach(id => attachDevice(id));
      cal = null; notes = null;
      await load(true); heartbeat();
      if (!Object.keys(now).length) { rebuild(); render(); msg(''); }
    } else if (tab === 'phones' && !(document.activeElement && document.activeElement.tagName === 'INPUT')) { /* keep the form as is */ }
  }, e => msg('Could not read your phones: ' + e.message)));
}

/* ---------- live mode: while this page is open, ask each phone to report every 15 s ---------- */
async function heartbeat() {
  if (document.hidden || !$('#auto').checked || !user) return;
  for (const id of scope()) { if (isFrozen(devices[id])) continue; try { await api('heartbeat', { deviceId: id }); } catch (e) { /* phone may be offline */ } }
}
setInterval(heartbeat, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) heartbeat(); });

/* ---------- QR pairing (camera) ---------- */
let stream = null, scanning = false;
async function openScan() {
  $('#scan').showModal(); $('#scanmsg').textContent = 'Starting camera…';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    const v = $('#vid'); v.srcObject = stream; await v.play();
    scanning = true; $('#scanmsg').textContent = 'Point the camera at the QR code on the phone.'; scanLoop();
  } catch (e) { $('#scanmsg').textContent = 'Camera not available (' + e.message + '). Choose a photo of the QR code below instead.'; }
}
function stopScan() { scanning = false; if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } $('#vid').srcObject = null; }
async function scanLoop() {
  const v = $('#vid'), c = $('#qrcanvas'), g = c.getContext('2d', { willReadFrequently: true });
  let det = null;
  if ('BarcodeDetector' in window) { try { det = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { det = null; } }
  while (scanning) {
    if (v.readyState >= 2) {
      let text = '';
      try {
        if (det) { const r = await det.detect(v); if (r.length) text = r[0].rawValue; }
        else if (window.jsQR) { c.width = v.videoWidth; c.height = v.videoHeight; g.drawImage(v, 0, 0); const im = g.getImageData(0, 0, c.width, c.height); const q = jsQR(im.data, c.width, c.height); if (q) text = q.data; }
      } catch (e) { /* try again */ }
      if (text && await handleQr(text)) return;
    }
    await sleep(det ? 150 : 250);
  }
}
async function handleQr(text) {
  let o; try { o = JSON.parse(text); } catch (e) { return false; }
  if (!o || o.v !== 1 || !o.d || !o.c) return false;
  stopScan(); $('#scanmsg').textContent = 'Pairing…';
  try {
    const r = await api('pair', { deviceId: o.d, code: o.c });
    $('#scanmsg').textContent = `Paired “${r.name}” ✓ It will appear in the phone list now.`;
    store_.set(K.sel, o.d); sel = o.d;
    setTimeout(() => { $('#scan').close(); }, 1500);
  } catch (e) { $('#scanmsg').textContent = 'Pairing failed: ' + e.message + ' — close this and try again.'; }
  return true;
}
$('#qrfile').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image(); img.onload = async () => {
    const c = $('#qrcanvas'), g = c.getContext('2d'); c.width = img.width; c.height = img.height; g.drawImage(img, 0, 0);
    const q = window.jsQR && jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    if (!q || !(await handleQr(q.data))) $('#scanmsg').textContent = 'No pairing QR code found in that photo.';
  };
  img.src = URL.createObjectURL(f); e.target.value = '';
});
$('#scan').addEventListener('close', stopScan);
$('#scancancel').addEventListener('click', () => $('#scan').close());
$('#shotclose').addEventListener('click', () => $('#shotdlg').close());
$('#addphone').addEventListener('click', openScan);

/* ---------- auth ---------- */
function showLogin(t) { $('#login').hidden = false; $('#app').hidden = true; $('#loginmsg').textContent = t || ''; }
function stopAll() { unsubs.forEach(f => f()); unsubs = []; Object.keys(deviceUnsubs).forEach(detachDevice); stopAudit(); devices = {}; store = {}; liveNotes = {}; cal = null; notes = null; }
async function boot() {
  $('#login').hidden = true; $('#app').hidden = false;
  $('#who').textContent = (user.email || '').split('@')[0];
  try {
    await api('bootstrap');                                           // runs any pending data-schema migrations for this account
    const m = await getDoc(doc(db, 'meta', 'schema'));
    if (m.exists() && m.data().version > SCHEMA) $('#banner').innerHTML = '<div class="note">A newer version of this website is available. <button onclick="location.reload()">Reload</button></div>';
  } catch (e) { /* server not set up yet: the rest still works */ }
  startDevices();
}
function startFirebase() {
  if (String(FIREBASE_CONFIG.apiKey).startsWith('PASTE')) { showLogin('Fill in website/config.js first (see SETUP.md, step 4).'); $('#signin').disabled = true; return; }
  fbApp = initializeApp(FIREBASE_CONFIG); auth = getAuth(fbApp); db = getFirestore(fbApp); 
  onAuthStateChanged(auth, async u => {
    user = u;
    if (!u) { stopAll(); showLogin(''); return; }
    await boot();
  });
}
$('#signin').addEventListener('click', async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') signInWithRedirect(auth, new GoogleAuthProvider());
    else if (e.code !== 'auth/popup-closed-by-user') $('#loginmsg').textContent = 'Sign-in failed: ' + e.message;
  }
});
$('#signout').addEventListener('click', () => signOut(auth));

/* ---------- events ---------- */
$('#range').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  days = +b.dataset.d;
  document.querySelectorAll('#range button').forEach(x => x.classList.toggle('on', x === b));
  render();
});
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  tab = b.dataset.t;
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  $('#view').onclick = null;
  render();
});
$('#refresh').addEventListener('click', () => load());
$('#device').addEventListener('change', async e => {
  sel = e.target.value; store_.set(K.sel, sel); cal = null; notes = null; ctl = sel === 'all' ? ctl : sel;
  await load(true); render(); heartbeat();
});
$('#auto').checked = store_.get(K.auto) !== '0';
$('#auto').addEventListener('change', () => { store_.set(K.auto, $('#auto').checked ? '1' : '0'); heartbeat(); });
$('#bell').addEventListener('click', () => { const d = $('#drawer'); d.hidden = !d.hidden; renderDrawer(); });
$('#drawerclose').addEventListener('click', () => { $('#drawer').hidden = true; renderDrawer(); });

/* ---------- installable app (PWA) ---------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#install').hidden = false; });
$('#install').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#install').hidden = true; });
window.addEventListener('appinstalled', () => { $('#install').hidden = true; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

if (window.Chart) {
  const css = getComputedStyle(document.documentElement);
  Chart.defaults.color = css.getPropertyValue('--mute').trim();
  Chart.defaults.borderColor = css.getPropertyValue('--line').trim();
}
startFirebase();
