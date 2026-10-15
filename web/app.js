/* FinDash — dashboard behaviour. Reads the inert JSON that dashboard.py embeds
   (#fd-data, #fd-meta) and renders only the page on screen.

   Every metric is computed by summarize(), which mirrors analysis.summarize in
   Python line for line (tests/test_app.js cross-checks them on the same data).
   Definitions (also shown in the ⓘ tooltips):
     money in / out   all credits / debits in the current View (failed+reversed pairs excluded)
     earned income    salary, interest, freelance, stipend, dividend — never refunds/transfers
     spending         expense debits; "net" = minus refunds
     savings          earned income − net spending (investments count as saved, not spent)
     savings rate     savings ÷ earned income, only when there is earned income */
'use strict';

/* ======================================================================= *
 * Data + small utilities
 * ======================================================================= */
let TX = [], META = {};
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = x => Math.round(x * 100) / 100;
function inr(x, paise) {
  if (x == null || isNaN(x)) return '—';
  const v = paise ? Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(Math.abs(x)).toLocaleString('en-IN');
  return (x < 0 && Math.round(Math.abs(x) * (paise ? 100 : 1)) ? '−' : '') + '₹' + v;
}
const signedInr = (x, paise) => (x > 0 ? '+' : x < 0 ? '−' : '') + inr(Math.abs(x), paise);
function inrShort(x) {
  const a = Math.abs(x), s = x < 0 ? '−' : '';
  if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(a >= 1e8 ? 0 : 1) + 'Cr';
  if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(a >= 1e6 ? 0 : 1) + 'L';
  if (a >= 1e3) return s + '₹' + (a / 1e3).toFixed(0) + 'k';
  return s + '₹' + Math.round(a);
}
const pct = (x, d = 0) => x == null || !isFinite(x) ? '—' : (x).toFixed(d) + '%';
const fmtDate = iso => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return +d + ' ' + MON[+m - 1] + ' ' + y; };
const fmtDay = iso => { const [, m, d] = iso.split('-'); return +d + ' ' + MON[+m - 1]; };
const fmtMonth = ym => { const [y, m] = ym.split('-'); return MON[+m - 1] + ' ' + y; };
const fmtMonthShort = ym => { const [y, m] = ym.split('-'); return MON[+m - 1] + ' ' + y.slice(2); };
const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
const sum = (rows, f) => rows.reduce((a, t) => a + (f ? f(t) : t), 0);
const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '';

// ISO date arithmetic (UTC, so no DST surprises)
const D = iso => new Date(iso + 'T00:00:00Z');
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 86400000);   // b - a
const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return iso(new Date(Date.UTC(y, m, 0))); };
function addMonths(s, n) {   // same day-of-month, clamped to month end
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return iso(t);
}
const prevMonth = ym => addMonths(ym + '-01', -1).slice(0, 7);
/** Shift a period END by n months; a month's last day maps to the target month's last day (30 Jun -> 31 May). */
const shiftEnd = (s, n) => s === monthEnd(s.slice(0, 7)) ? monthEnd(addMonths(s.slice(0, 7) + '-01', n).slice(0, 7)) : addMonths(s, n);
function monthsIn(from, to) { const out = []; let m = from.slice(0, 7); while (m <= to.slice(0, 7)) { out.push(m); m = addMonths(m + '-01', 1).slice(0, 7); } return out; }

// storage is a per-viewer convenience only — must never break the page
const store = {
  get(k, dflt) { try { const v = localStorage.getItem(k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode etc. */ } },
  sget(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
  sset(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};

/* ---------- labels ---------- */
const catLabel = k => (META.categories && META.categories[k] && META.categories[k].label) || cap(k);
const natureOf = k => (META.categories && META.categories[k] && META.categories[k].nature) || 'mixed';
const acctLabel = a => (META.accountLabels && META.accountLabels[a]) || a;
const KIND_LABEL = { income: 'Income', refund: 'Refund', expense: 'Expense', investment: 'Investment', transfer: 'Own transfer', p2p: 'People (P2P)', reversed: 'Failed / reversed' };
const KIND_HELP = {
  income: 'Earned income (salary, interest, freelance…). Counts toward your savings rate.',
  refund: 'Money back (refunds, reversals, cashback, tax refunds). Reduces spending; never counted as income.',
  expense: 'Money spent.',
  investment: 'Money put into (or taken out of) investments such as SIPs or FDs. Counted as saved, not spent.',
  transfer: 'Moved between your own accounts — not income or spending.',
  p2p: 'Sent to / received from a person. Kept out of income and spending (lending, splitting, family).',
  reversed: 'A failed payment and its reversal (same UPI reference). Nothing actually moved.',
};
const confLabel = c => c >= 0.99 ? ['You set this', 'info'] : c >= 0.85 ? ['High', 'pos'] : c >= 0.5 ? ['Medium', 'warn'] : ['Low', 'neg'];

/* ---------- privacy: long numbers (account / reference) are masked by default ---------- */
let REVEAL = false;
const mask = s => REVEAL ? String(s || '') : String(s || '').replace(/\d{11,}/g, m => '••••' + m.slice(-4));

/* ======================================================================= *
 * State, period + scope
 * ======================================================================= */
const S = {
  account: 'All', period: 'all', month: 'All', day: 'All', from: '', to: '', view: 'norm', route: 'overview',
  tx: { q: '', kind: 'All', dir: 'All', cat: 'All', merchant: '', min: '', max: '', flag: 'All', chip: 'All', sort: 'date', desc: true, page: 0 },
  cp: '', cpq: '', cpNum: '', showDismissed: false,
  cmp: { preset: 'mom', aFrom: '', aTo: '', bFrom: '', bTo: '', norm: true },
  h2h: { type: 'category', a: '', b: '' },
};
let DATA_START = '', DATA_END = '';
let COVER = {};   // account -> {from, to}

const inAccount = t => S.account === 'All' || t.acct === S.account;
function inView(t, view) {
  const v = view || S.view;
  if (v === 'all') return true;
  if (v === 'ppl') return t.kind === 'p2p';
  return t.kind !== 'transfer' && t.kind !== 'p2p' && t.kind !== 'reversed';
}
const cover = () => COVER[S.account] || { from: DATA_START, to: DATA_END };

/** The selected period as an inclusive ISO range, plus how to describe and compare it. */
function range() {
  const c = cover(), p = S.period;
  if (p === 'custom' && S.from && S.to) return { from: S.from <= S.to ? S.from : S.to, to: S.from <= S.to ? S.to : S.from, kind: 'custom', label: fmtDate(S.from) + ' – ' + fmtDate(S.to) };
  if (p.startsWith('year:')) {
    const y = p.slice(5);
    if (S.day !== 'All') return { from: S.day, to: S.day, kind: 'day', label: fmtDate(S.day) };
    if (S.month !== 'All') return { from: S.month + '-01', to: monthEnd(S.month), kind: 'month', label: fmtMonth(S.month) };
    return { from: y + '-01-01', to: y + '-12-31', kind: 'year', label: y };
  }
  const rel = { last30: [-29, 'd', 'Last 30 days'], last3m: [-3, 'm', 'Last 3 months'], last6m: [-6, 'm', 'Last 6 months'], last12m: [-12, 'm', 'Last 12 months'] }[p];
  if (rel) {
    const from = rel[1] === 'd' ? addDays(c.to, rel[0]) : addDays(addMonths(c.to, rel[0]), 1);
    return { from, to: c.to, kind: 'rel', label: rel[2] + ' (to ' + fmtDate(c.to) + ')' };
  }
  return { from: c.from, to: c.to, kind: 'all', label: 'All time' };
}
/** The part of a range we actually have statements for. */
function effective(r) {
  const c = cover();
  const from = r.from > c.from ? r.from : c.from, to = r.to < c.to ? r.to : c.to;
  return from <= to ? { ...r, from, to, days: daysBetween(from, to) + 1, partial: from !== r.from || to !== r.to } : null;
}
/** Previous equivalent period for comparisons — or null when we don't have the
 *  history to compare fairly (no misleading "vs nothing" numbers). */
function prevRange(eff) {
  if (!eff || eff.kind === 'all') return null;
  let from, to, label;
  if (eff.kind === 'year') { from = addMonths(eff.from, -12); to = shiftEnd(eff.to, -12); label = eff.partial ? fmtDay(from) + '–' + fmtDate(to) : from.slice(0, 4); }
  else if (eff.kind === 'month') { from = addMonths(eff.from, -1); to = shiftEnd(eff.to, -1); label = eff.partial ? fmtDay(from) + '–' + fmtDate(to) : fmtMonth(from.slice(0, 7)); }
  else { to = addDays(eff.from, -1); from = addDays(to, -(eff.days - 1)); label = fmtDate(from) + ' – ' + fmtDate(to); }
  const c = cover();
  if (from < c.from) return null;
  return { from, to, label, days: daysBetween(from, to) + 1 };
}
const inRange = (t, r) => r && t.date >= r.from && t.date <= r.to;
/** Rows for the current account + range (+ View unless ignoreView). */
const rowsIn = (r, ignoreView) => r ? TX.filter(t => inAccount(t) && inRange(t, r) && (ignoreView || inView(t))) : [];

/* ======================================================================= *
 * The one definition of every headline number (mirrors analysis.summarize)
 * ======================================================================= */
let OBL = new Set();
function summarize(rows) {
  const s = { money_in: 0, money_out: 0, income: 0, refunds: 0, spending: 0, essential: 0, discretionary: 0, mixed: 0, obligations: 0, invested: 0, transfer_in: 0, transfer_out: 0, p2p_in: 0, p2p_out: 0, n: 0 };
  for (const t of rows) {
    const k = t.kind, a = t.amt, cr = t.dir === 'credit';
    if (k === 'reversed') continue;
    s.n++;
    if (cr) s.money_in += a; else s.money_out += a;
    if (k === 'income') s.income += a;
    else if (k === 'refund') s.refunds += a;
    else if (k === 'expense' && !cr) {
      s.spending += a;
      const nat = natureOf(t.cat);
      s[nat === 'essential' || nat === 'discretionary' ? nat : 'mixed'] += a;
      if (OBL.has(t.cat)) s.obligations += a;
    } else if (k === 'investment') s.invested += cr ? -a : a;
    else if (k === 'transfer') s[cr ? 'transfer_in' : 'transfer_out'] += a;
    else if (k === 'p2p') s[cr ? 'p2p_in' : 'p2p_out'] += a;
  }
  for (const k in s) if (k !== 'n') s[k] = round2(s[k]);
  s.net_flow = round2(s.money_in - s.money_out);
  s.net_spending = round2(s.spending - s.refunds);
  s.savings = round2(s.income - s.net_spending);
  s.savings_rate = s.income > 0 ? Math.round(s.savings / s.income * 1000) / 10 : null;
  return s;
}
function byMonth(rows) { const m = {}; for (const t of rows) (m[t.ym] = m[t.ym] || []).push(t); return m; }
/** A month is complete if our data runs past its last day (or it ends exactly there). */
const isCompleteMonth = ym => monthEnd(ym) <= cover().to && (ym + '-01') >= cover().from.slice(0, 8) + '01';

/* ---------- balances (from the reconciled running-balance chain) ---------- */
function balAt(acct, day) {
  const s = (META.balanceDaily || {})[acct];
  if (!s || !s.length) return null;
  if (day < s[0][0]) return day >= addDays(s[0][0], -1) ? (META.reconcile[acct] || {}).opening : null;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid][0] <= day) lo = mid; else hi = mid - 1; }
  return s[lo][1];
}
const accountsInScope = () => Object.keys(META.balanceDaily || {}).filter(a => S.account === 'All' || a === S.account).sort();
function totalBalAt(day) {
  let tot = 0, known = 0, missing = [];
  for (const a of accountsInScope()) { const b = balAt(a, day); if (b == null) missing.push(a); else { tot += b; known++; } }
  return known ? { total: round2(tot), missing } : null;
}

/* ======================================================================= *
 * Icons (Tabler, MIT) — inline SVG, no font download
 * ======================================================================= */
const P = {
  bell: '<path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6"/><path d="M9 17v1a3 3 0 0 0 6 0v-1"/>',
  theme: '<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"/>',
  download: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/>',
  upload: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 9l5 -5l5 5"/><path d="M12 4l0 12"/>',
  refresh: '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
  x: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>',
  home: '<path d="M5 12l-2 0l9 -9l9 9l-2 0"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"/>',
  list: '<path d="M9 6l11 0"/><path d="M9 12l11 0"/><path d="M9 18l11 0"/><path d="M5 6l0 .01"/><path d="M5 12l0 .01"/><path d="M5 18l0 .01"/>',
  flow: '<path d="M3 17l6 -6l4 4l8 -8"/><path d="M14 7l7 0l0 7"/>',
  income: '<path d="M12 3v12"/><path d="M8 11l4 4l4 -4"/><path d="M4 19h16"/>',
  spend: '<path d="M12 21v-12"/><path d="M8 13l4 -4l4 4"/><path d="M4 5h16"/>',
  repeat: '<path d="M4 12v-3a3 3 0 0 1 3 -3h13m-3 -3l3 3l-3 3"/><path d="M20 12v3a3 3 0 0 1 -3 3h-13m3 3l-3 -3l3 -3"/>',
  spark: '<path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3l5.8 1.9l-5.8 1.9a2 2 0 0 0 -1.3 1.3l-1.9 5.8l-1.9 -5.8a2 2 0 0 0 -1.3 -1.3l-5.8 -1.9l5.8 -1.9a2 2 0 0 0 1.3 -1.3z"/>',
  compare: '<path d="M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M18 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M11 6h5a2 2 0 0 1 2 2v8"/><path d="M14 9l-3 -3l3 -3"/><path d="M13 18h-5a2 2 0 0 1 -2 -2v-8"/><path d="M10 15l3 3l-3 3"/>',
  users: '<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>',
  wallet: '<path d="M17 8v-3a1 1 0 0 0 -1 -1h-10a2 2 0 0 0 0 4h12a1 1 0 0 1 1 1v3m0 4v3a1 1 0 0 1 -1 1h-12a2 2 0 0 1 -2 -2v-12"/><path d="M20 12v4h-4a2 2 0 0 1 0 -4h4"/>',
  target: '<path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0 -10 0"/><path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/>',
  chat: '<path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/>',
  gear: '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
};
const icon = (n, cls) => '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[n] || '') + '</svg>';

/* ======================================================================= *
 * Charts — colours come from the CSS tokens so light/dark both work
 * ======================================================================= */
const charts = {};
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const palette = () => ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'].map(css);
function chartEmpty(id, msg) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  const cv = document.getElementById(id); if (!cv) return;
  cv.hidden = true;
  let e = cv.parentElement.querySelector('.empty');
  if (!e) { e = document.createElement('div'); e.className = 'empty'; cv.parentElement.appendChild(e); }
  e.textContent = msg || 'No data for this view.';
}
function chart(id, cfg) {
  const cv = document.getElementById(id); if (!cv) return null;
  if (charts[id]) charts[id].destroy();
  const e = cv.parentElement.querySelector('.empty'); if (e) e.remove();
  cv.hidden = false;
  if (typeof Chart === 'undefined') { chartEmpty(id, 'Charts unavailable (vendor/chart.umd.js missing).'); return null; }
  const text = css('--text-3'), grid = css('--grid');
  const o = cfg.options = cfg.options || {};
  o.responsive = true; o.maintainAspectRatio = false;
  o.animation = { duration: 200 };
  o.plugins = Object.assign({ legend: { display: false, labels: { color: text, boxWidth: 10, font: { size: 11 } } } }, o.plugins || {});
  if (o.plugins.legend.display) o.plugins.legend.labels = Object.assign({ color: text, boxWidth: 10, font: { size: 11 } }, o.plugins.legend.labels || {});
  for (const ax of Object.values(o.scales || {})) {
    ax.ticks = Object.assign({ color: text, font: { size: 11 } }, ax.ticks || {});
    ax.grid = Object.assign({ color: grid }, ax.grid || {});
    ax.border = { display: false };
  }
  if (cfg.onPick) {
    o.onClick = (ev, els) => { if (els.length) cfg.onPick(els[0].index, els[0].datasetIndex); };
    o.onHover = (ev, els) => { ev.native.target.style.cursor = els.length ? 'pointer' : 'default'; };
  }
  charts[id] = new Chart(cv, cfg);
  return charts[id];
}
const moneyTicks = { callback: v => inrShort(v) };
const tipMoney = { callbacks: { label: c => ' ' + (c.dataset.label ? c.dataset.label + ': ' : '') + inr(c.chart.options.indexAxis === 'y' ? c.parsed.x : c.parsed.y) } };

function sparkline(vals, color) {
  const v = vals.map(x => x == null ? null : +x), ok = v.filter(x => x != null);
  if (ok.length < 2) return '';
  const min = Math.min(...ok), max = Math.max(...ok), W = 100, H = 26, n = v.length;
  const y = x => H - 3 - (max === min ? (H - 6) / 2 : (x - min) / (max - min) * (H - 6));
  let d = '', pen = false;
  v.forEach((x, i) => { if (x == null) { pen = false; return; } d += (pen ? 'L' : 'M') + (i / (n - 1) * W).toFixed(1) + ' ' + y(x).toFixed(1) + ' '; pen = true; });
  return '<svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>';
}

/* ---------- small renderers ---------- */
const empty = msg => '<div class="empty">' + esc(msg) + '</div>';
const statBox = (l, v, s, cls) => '<div class="stat"><div class="l">' + l + '</div><div class="v ' + (cls || '') + '">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
const badge = (txt, cls) => '<span class="badge ' + (cls || '') + '">' + esc(txt) + '</span>';
function changeText(cur, prev, opts) {
  // ↑/↓ arrow + words carry the meaning; colour only reinforces it
  opts = opts || {};
  if (prev == null || cur == null) return '<span class="muted">' + (opts.noPrev || 'No comparable earlier data') + '</span>';
  const d = cur - prev;
  if (Math.abs(d) < (opts.pts ? 0.05 : 0.5)) return '<span class="muted">No change vs ' + esc(opts.vs) + '</span>';
  const good = opts.goodUp === undefined ? null : (d > 0) === opts.goodUp;
  const cls = good == null ? '' : good ? 'pos' : 'neg';
  const p = !opts.pts && prev > 0 && cur >= 0 ? ' (' + (d > 0 ? '+' : '−') + Math.abs(d / prev * 100).toFixed(0) + '%)' : '';
  const abs = opts.pts ? Math.abs(d).toFixed(1) + ' pts' : inr(Math.abs(d));
  return '<span class="' + cls + '">' + (d > 0 ? '↑ ' : '↓ ') + abs + p + '</span> <span class="muted">vs ' + esc(opts.vs) + '</span>';
}
function infoTip(id, text) {
  return '<button class="info" type="button" aria-label="How this is calculated" aria-expanded="false" data-tip="' + id + '">i</button><div class="tip" id="tip-' + id + '" role="tooltip">' + text + '</div>';
}
function txLine(t, right) {
  const sign = t.dir === 'credit' ? '+' : '−';
  return '<div class="click" data-id="' + esc(t.id) + '"><div class="k"><div class="t">' + esc(t.merchant) + '</div><div class="d">' + fmtDate(t.date) + ' · ' + esc(catLabel(t.cat)) + (S.account === 'All' ? ' · ' + esc(acctLabel(t.acct)) : '') + '</div></div>'
    + '<div class="v ' + (t.dir === 'credit' ? 'pos' : '') + '">' + (right || sign + inr(t.amt)) + '</div></div>';
}

/* ======================================================================= *
 * Insights — only generated when the data supports them. Each one says what
 * changed, by how much, over which period, why it matters, and what to do.
 * ======================================================================= */
function catSpend(rows) {   // category -> {spent, refunds, n}
  const g = {};
  for (const t of rows) {
    if (t.kind === 'expense' && t.dir === 'debit') { const c = g[t.cat] = g[t.cat] || { spent: 0, refunds: 0, n: 0 }; c.spent += t.amt; c.n++; }
    else if (t.kind === 'refund') { const c = g[t.cat] = g[t.cat] || { spent: 0, refunds: 0, n: 0 }; c.refunds += t.amt; }
  }
  return g;
}
function insights() {
  const r = effective(range()); if (!r) return [];
  const rows = rowsIn(r, true), s = summarize(rows), pr = prevRange(r);
  const prows = pr ? rowsIn(pr, true) : [], ps = pr ? summarize(prows) : null;
  const out = [], per = r.label + (r.partial ? ' (data ' + fmtDay(r.from) + '–' + fmtDate(r.to) + ')' : '');
  const add = (sev, score, title, why, next, link) => out.push({ sev, score, title, why, next, link, period: per });

  // savings rate
  if (s.income > 0) {
    const rate = s.savings_rate, sev = rate >= 20 ? 'pos' : rate >= 0 ? 'warn' : 'neg';
    const vs = ps && ps.savings_rate != null ? ` (${(rate - ps.savings_rate >= 0 ? '+' : '−') + Math.abs(rate - ps.savings_rate).toFixed(1)} pts vs ${pr.label})` : '';
    add(sev, sev === 'neg' ? 90 : 60, `You saved ${pct(rate, 1)} of earned income: ${inr(s.savings)} of ${inr(s.income)}${vs}`,
      'Savings = earned income − spending net of refunds. Investments count as saved.',
      rate < 0 ? 'Spending exceeded income. The category table on Spending shows where.' : rate < 20 ? 'A common benchmark is 20%+. The biggest discretionary categories are the easiest lever.' : '',
      rate < 20 ? { route: 'spending' } : null);
  }
  // negative months
  const months = monthsIn(r.from, r.to).filter(isCompleteMonth);
  if (months.length >= 3) {
    const bm = byMonth(rows), neg = months.filter(m => { const x = summarize(bm[m] || []); return x.income - x.net_spending < 0; });
    if (neg.length) add(neg.length / months.length > .34 ? 'neg' : 'warn', 70 + neg.length,
      `Spending exceeded earned income in ${neg.length} of ${months.length} complete months`,
      'Those months were funded from savings or transfers: ' + neg.slice(-4).map(fmtMonthShort).join(', ') + (neg.length > 4 ? '…' : '') + '.',
      'Open Cash flow to see each month\'s in/out.', { route: 'cashflow' });
  }
  // category movers vs previous period
  if (pr) {
    const a = catSpend(rows), b = catSpend(prows), f = pr.days ? r.days / pr.days : 1;
    const moves = Object.keys({ ...a, ...b }).map(c => {
      const cur = (a[c] ? a[c].spent - a[c].refunds : 0), prev = (b[c] ? b[c].spent - b[c].refunds : 0) * f;
      return { c, cur, prev, d: cur - prev };
    }).filter(m => Math.abs(m.d) >= 2000 && m.prev > 0 && Math.abs(m.d / m.prev) >= .2).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    const up = moves.find(m => m.d > 0), down = moves.find(m => m.d < 0);
    if (up) add('warn', 65 + Math.min(20, up.d / 1000), `Spending on ${catLabel(up.c)} up ${pct(up.d / up.prev * 100)}: ${inr(up.prev)} → ${inr(up.cur)} vs ${pr.label}`,
      'Your largest category increase' + (f !== 1 ? ' (previous period scaled to the same number of days)' : '') + '.',
      'Review the transactions behind it.', { route: 'transactions', tx: { cat: up.c } });
    if (down) add('pos', 40, `Spending on ${catLabel(down.c)} down ${pct(-down.d / down.prev * 100)}: ${inr(down.prev)} → ${inr(down.cur)} vs ${pr.label}`,
      'Your largest category decrease.', '', { route: 'transactions', tx: { cat: down.c } });
    if (ps && ps.net_spending > 0 && s.net_spending > 0) {
      const ch = (s.net_spending - ps.net_spending * f) / (ps.net_spending * f) * 100;
      if (Math.abs(ch) >= 15) add(ch > 0 ? 'warn' : 'pos', 50, `Total spending ${ch > 0 ? 'up' : 'down'} ${pct(Math.abs(ch))} vs ${pr.label} (${inr(ps.net_spending * f)} → ${inr(s.net_spending)})`,
        'Net of refunds; transfers and P2P excluded.', '', { route: 'compare' });
    }
  }
  // concentration
  const cs = catSpend(rows), cats = Object.entries(cs).map(([c, v]) => [c, v.spent]).sort((x, y) => y[1] - x[1]);
  if (cats.length && s.spending > 0) {
    const [c, v] = cats[0], share = v / s.spending * 100;
    if (share >= 25) add('info', 45, `${catLabel(c)} is ${pct(share)} of your spending (${inr(v)})`,
      c === 'credit_card_payment' ? 'Card bills hide what you actually bought on the card.' : 'Your single largest category.',
      c === 'credit_card_payment' ? 'Importing card statements would break this down; until then it counts as one category.' : '', { route: 'transactions', tx: { cat: c } });
  }
  // uncategorised merchants
  const unk = (cs.other_merchant ? cs.other_merchant.spent : 0) + (cs.uncategorized ? cs.uncategorized.spent : 0);
  if (unk >= 2000 && s.spending > 0) add('info', 35, `${inr(unk)} (${pct(unk / s.spending * 100)}) of spending went to shops without a category`,
    'They are counted as spending but not in any category.', 'Open one and pick a category; "all from this merchant" fixes the rest.', { route: 'transactions', tx: { cat: 'other_merchant' } });
  // cash
  const cash = cs.cash_withdrawal;
  if (cash && cash.spent >= 5000) add('info', 30, `${inr(cash.spent)} withdrawn as cash (${cash.n} withdrawals)`,
    'Cash spending can\'t be broken down from a bank statement.', '', { route: 'transactions', tx: { cat: 'cash_withdrawal' } });
  // recurring
  const act = recurringSeries().filter(x => x.active);
  if (act.length) {
    const mo = sum(act, x => x.monthly_cost), subs = act.filter(x => x.category === 'subscriptions');
    add('info', 40, `${act.length} active recurring payments total about ${inr(mo)}/month (${inr(mo * 12)}/year)`,
      subs.length ? 'Subscriptions among them: ' + subs.map(x => x.merchant + ' ' + inr(x.typical)).join(', ') + '.' : 'Bills, insurance, SIPs and regular transfers.',
      'Cancel any you no longer use.', { route: 'recurring' });
  }
  // unusual
  const an = rows.filter(t => t.anom && !t.dis);
  if (an.length) {
    const top = an.slice().sort((x, y) => y.amt - x.amt)[0];
    add(an.some(t => t.anom.severity === 'high') ? 'warn' : 'info', 55, `${an.length} unusual transaction${an.length > 1 ? 's' : ''} to review (largest: ${inr(top.amt)} to ${top.merchant})`,
      top.anom.reasons[0].reason + '.', 'Check each one and mark it reviewed.', { route: 'insights' });
  }
  // P2P net
  if (s.p2p_out - s.p2p_in >= 10000) add('info', 25, `You sent ${inr(s.p2p_out - s.p2p_in)} more to people than you got back (${inr(s.p2p_out)} out, ${inr(s.p2p_in)} in)`,
    'Person-to-person money isn\'t counted as spending.', 'Counterparties shows the net per person.', { route: 'counterparties' });
  // refunds
  if (s.refunds >= 1000) add('info', 20, `${inr(s.refunds)} came back as refunds or cashback`,
    'Refunds reduce spending; they are never counted as income.', '', { route: 'transactions', tx: { kind: 'refund' } });
  // salary change
  const sal = rows.filter(t => t.cat === 'salary' && t.kind === 'income').sort((x, y) => x.date < y.date ? -1 : 1);
  const allSal = TX.filter(t => inAccount(t) && t.cat === 'salary' && t.kind === 'income' && t.date <= r.to).sort((x, y) => x.date < y.date ? -1 : 1);
  if (sal.length && allSal.length >= 4) {
    const last = sal[sal.length - 1], hist = allSal.filter(t => t.date < last.date).slice(-6).map(t => t.amt), avg = sum(hist) / hist.length;
    const ch = (last.amt - avg) / avg * 100;
    if (hist.length >= 3 && Math.abs(ch) >= 5) add(ch > 0 ? 'pos' : 'warn', 58, `Latest salary ${inr(last.amt)} (${fmtDate(last.date)}) is ${pct(Math.abs(ch))} ${ch > 0 ? 'above' : 'below'} your previous ${hist.length}-month average (${inr(avg)})`,
      'One-off bonuses or deductions show up here.', '', { route: 'income' });
  }
  // stale data
  for (const [a, b] of Object.entries(META.balances || {})) {
    if (S.account !== 'All' && a !== S.account) continue;
    const age = daysSince(b.asof);
    if (age > STALE_DAYS) add('warn', 80, `${acctLabel(a)} data ends ${fmtDate(b.asof)} (${age} days ago)`, 'Recent transactions are missing from every number here.', 'Add a newer statement.', null);
  }
  const rank = { neg: 4, warn: 3, pos: 2, info: 1 };
  return out.sort((x, y) => rank[y.sev] - rank[x.sev] || y.score - x.score);
}
const STALE_DAYS = 10;
const daysSince = isoDay => META.demo ? 0 : Math.max(0, Math.floor((Date.now() - D(isoDay)) / 86400000));
function renderInsightList(list, max) {
  if (!list.length) return empty('Not enough data in this view for evidence-based insights.');
  const sym = { pos: '↑', neg: '!', warn: '!', info: 'i' };
  return list.slice(0, max || 99).map((x, i) => '<div class="insight"><div class="ic ' + x.sev + '" aria-hidden="true">' + sym[x.sev] + '</div><div>'
    + '<div class="ttl">' + esc(x.title) + '</div><div class="why">' + esc(x.why) + '</div>'
    + (x.next ? '<div class="next">' + esc(x.next) + (x.link ? ' <button class="btn link" type="button" data-ins="' + i + '">Open →</button>' : '') + '</div>'
      : x.link ? '<div class="next"><button class="btn link" type="button" data-ins="' + i + '">Open →</button></div>' : '')
    + '<div class="meta">Period: ' + esc(x.period) + '</div></div></div>').join('');
}
let INS_CACHE = [];
function followLink(l) {
  if (!l) return;
  if (l.tx) { resetTx(); Object.assign(S.tx, l.tx); }
  go(l.route);
}

/* ======================================================================= *
 * Page: Overview
 * ======================================================================= */
function kpiCard(id, label, value, cmp, note, spark, tip, naText) {
  return '<div class="card kpi"><div class="kpi-label">' + label + infoTip(id, tip) + '</div>'
    + (value == null ? '<div class="kpi-value na">' + esc(naText || 'Not available') + '</div>' : '<div class="kpi-value">' + value + '</div>')
    + '<div class="kpi-cmp">' + cmp + '</div>' + (note ? '<div class="small muted">' + note + '</div>' : '')
    + '<div class="kpi-spark">' + (spark || '') + '</div></div>';
}
function monthlySeries(endIso, n, f) {   // last n months ending at endIso: values of f(summary, ym)
  const ms = []; let m = endIso.slice(0, 7);
  for (let i = 0; i < n; i++) { ms.unshift(m); m = prevMonth(m); }
  const rows = TX.filter(t => inAccount(t) && inView(t) && t.ym >= ms[0] && t.ym <= ms[ms.length - 1]);
  const bm = byMonth(rows);
  return ms.map(ym => ym < cover().from.slice(0, 7) ? null : f(summarize(bm[ym] || []), ym));
}
function renderOverview() {
  const r = effective(range());
  if (!r) { $('#kpis').innerHTML = '<div class="card" style="grid-column:1/-1">' + empty('No statements cover this period for the selected account.') + '</div>'; return; }
  const rows = rowsIn(r), s = summarize(rows), pr = prevRange(r), ps = pr ? summarize(rowsIn(pr)) : null;
  const vs = pr ? pr.label : '', months = r.days / 30.4375;
  const C = { pos: css('--chart-pos'), neg: css('--chart-neg'), acc: css('--chart-accent') };
  const close = totalBalAt(r.to), open = totalBalAt(addDays(r.from, -1));
  const prClose = pr ? totalBalAt(pr.to) : null;
  const avgSp = s.net_spending / months, prAvg = ps ? ps.net_spending / (pr.days / 30.4375) : null;
  const end = r.to;
  const viewNote = S.view === 'norm' ? 'Transfers between your accounts, P2P and failed payments are left out (View filter).' : S.view === 'ppl' ? 'Only person-to-person money (View filter).' : 'Everything on the statement, including transfers and P2P.';
  $('#kpis').innerHTML = [
    kpiCard('in', 'Money in', inr(s.money_in), changeText(s.money_in, ps && ps.money_in, { vs, goodUp: true }),
      inr(s.income) + ' earned · ' + inr(s.refunds) + ' refunds', sparkline(monthlySeries(end, 12, x => x.money_in), C.pos),
      'Sum of all credits in this period. ' + viewNote + ' Earned income excludes refunds, transfers and P2P.'),
    kpiCard('out', 'Money out', inr(s.money_out), changeText(s.money_out, ps && ps.money_out, { vs, goodUp: false }),
      inr(s.spending) + ' spent · ' + inr(Math.max(0, s.invested)) + ' invested', sparkline(monthlySeries(end, 12, x => x.money_out), C.neg),
      'Sum of all debits in this period. ' + viewNote),
    kpiCard('net', 'Net cash flow', '<span class="' + (s.net_flow >= 0 ? 'pos' : 'neg') + '">' + signedInr(s.net_flow) + '</span>',
      changeText(s.net_flow, ps && ps.net_flow, { vs, goodUp: true }), 'money in − money out', sparkline(monthlySeries(end, 12, x => x.net_flow), C.acc),
      'Money in − money out for the current View. Under "Everything on the statement" this equals the change in your bank balance; under the default View it differs by your own-account transfers and P2P money.'),
    kpiCard('bal', 'Closing balance', close ? inr(close.total) : null,
      close && open ? '<span class="' + (close.total - open.total >= 0 ? 'pos' : 'neg') + '">' + (close.total - open.total >= 0 ? '↑ ' : '↓ ') + inr(Math.abs(close.total - open.total)) + '</span> <span class="muted">since ' + fmtDate(r.from) + '</span>' : '<span class="muted">No opening balance</span>',
      close ? 'on ' + fmtDate(r.to) + (close.missing.length ? ' · excl. ' + close.missing.map(acctLabel).join(', ') : '') : '',
      sparkline(monthlySeries(end, 12, (x, ym) => { const b = totalBalAt(monthEnd(ym) < end ? monthEnd(ym) : end); return b ? b.total : null; }), C.acc),
      'Your bank\'s own running balance at the end of the period, summed across the selected accounts. These balances are checked day by day against the transactions (Settings → Data quality).', 'No balance data'),
    kpiCard('avg', 'Avg monthly spending', inr(avgSp), changeText(avgSp, prAvg, { vs, goodUp: false }),
      'net of refunds · ' + (months < 1 ? r.days + ' days' : months.toFixed(1) + ' months'), sparkline(monthlySeries(end, 12, x => x.net_spending), C.neg),
      'Spending net of refunds ÷ months covered (days ÷ 30.44). Investments, transfers and P2P are not spending.'),
    kpiCard('rate', 'Savings rate', s.savings_rate == null ? null : '<span class="' + (s.savings_rate >= 0 ? '' : 'neg') + '">' + pct(s.savings_rate, 1) + '</span>',
      s.savings_rate == null ? '' : changeText(s.savings_rate, ps && ps.savings_rate, { vs, goodUp: true, pts: true }),
      s.savings_rate == null ? '' : 'saved ' + inr(s.savings) + ' of ' + inr(s.income), sparkline(monthlySeries(end, 12, x => x.savings_rate), C.pos),
      '(Earned income − net spending) ÷ earned income × 100. Investments count as saved. Not shown when no earned income was identified in the period.',
      'No earned income identified'),
  ].join('');

  // income vs spending by month
  const ms = monthsIn(r.from, r.to), bm = byMonth(rowsIn(r, true)), last = ms.slice(-24);
  $('#ovTrendSub').textContent = last.length < ms.length ? 'Last 24 months of the period · click a month to drill in' : 'Click a month to drill in';
  const inc = last.map(m => summarize(bm[m] || []).income), sp = last.map(m => summarize(bm[m] || []).net_spending);
  if (!inc.some(Boolean) && !sp.some(Boolean)) chartEmpty('ovTrend', 'No income or spending in this period.');
  else chart('ovTrend', {
    type: 'bar', data: { labels: last.map(fmtMonthShort), datasets: [
      { label: 'Earned income', data: inc, backgroundColor: C.pos, borderRadius: 3 },
      { label: 'Spending (net)', data: sp, backgroundColor: C.neg, borderRadius: 3 }] },
    options: { plugins: { legend: { display: true }, tooltip: tipMoney }, scales: { x: { grid: { display: false } }, y: { ticks: moneyTicks } } },
    onPick: i => drillMonth(last[i]),
  });

  // spending by category
  const cs = Object.entries(catSpend(rowsIn(r, true))).map(([c, v]) => [c, v.spent]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  $('#ovCatSub').textContent = cs.length ? 'Top ' + cs.length + ' · gross, before refunds · click to filter' : '';
  if (!cs.length) chartEmpty('ovCat', 'No spending in this period.');
  else chart('ovCat', { type: 'bar', data: { labels: cs.map(x => catLabel(x[0])), datasets: [{ data: cs.map(x => x[1]), backgroundColor: palette()[0], borderRadius: 3 }] },
    options: { indexAxis: 'y', plugins: { tooltip: tipMoney }, scales: { x: { ticks: moneyTicks }, y: { grid: { display: false } } } },
    onPick: i => { resetTx(); S.tx.cat = cs[i][0]; go('transactions'); } });

  renderBalanceChart('ovBal', r, $('#ovBalSub'));
  $('#ovHealth').innerHTML = healthHtml(r, s);
  const big = rows.filter(t => t.dir === 'debit' && t.kind !== 'reversed').sort((a, b) => b.amt - a.amt).slice(0, 6);
  $('#ovLargest').innerHTML = big.length ? big.map(t => txLine(t)).join('') : empty('Nothing in this view.');
  const recent = rows.slice().sort((a, b) => b.date < a.date ? -1 : b.date > a.date ? 1 : b.seq - a.seq).slice(0, 7);
  $('#ovRecentSub').textContent = recent.length ? 'Latest in this view' : '';
  $('#ovRecent').innerHTML = recent.length ? recent.map(t => txLine(t)).join('') : empty('Nothing in this view.');
  INS_CACHE = insights();
  $('#ovInsights').innerHTML = renderInsightList(INS_CACHE, 4);
}
function drillMonth(ym) {
  S.period = 'year:' + ym.slice(0, 4); S.month = ym; S.day = 'All';
  syncPeriodControls(); resetTx(); go('transactions');
}
function renderBalanceChart(id, r, subEl) {
  const accts = accountsInScope(), ms = monthsIn(r.from, r.to);
  if (!accts.length || !ms.length) { chartEmpty(id, 'No balance data for this view.'); if (subEl) subEl.textContent = ''; return; }
  const pal = palette(), ds = accts.map((a, i) => ({ label: acctLabel(a), data: ms.map(m => balAt(a, monthEnd(m) < r.to ? monthEnd(m) : r.to)), borderColor: pal[i % pal.length], backgroundColor: 'transparent', tension: .25, pointRadius: ms.length > 30 ? 0 : 2, borderWidth: 2, spanGaps: true }));
  if (accts.length > 1) ds.push({ label: 'Total', data: ms.map(m => { const b = totalBalAt(monthEnd(m) < r.to ? monthEnd(m) : r.to); return b ? b.total : null; }), borderColor: css('--text-2'), borderDash: [4, 3], backgroundColor: 'transparent', tension: .25, pointRadius: 0, borderWidth: 1.5, spanGaps: true });
  const breaks = accts.reduce((a, x) => a + ((META.reconcile[x] || {}).breaks || []).length, 0);
  if (subEl) subEl.textContent = 'Month-end, from your bank\'s running balance · ' + (breaks ? breaks + ' reconciliation break(s): see Settings' : 'reconciled ✓');
  chart(id, { type: 'line', data: { labels: ms.map(fmtMonthShort), datasets: ds },
    options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: ds.length > 1 }, tooltip: tipMoney }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0 } }, y: { ticks: moneyTicks } } } });
}
function healthHtml(r, s) {
  // Each ratio states its formula. No single "score": one statement can't tell
  // the whole story, and a made-up number would look more certain than it is.
  const rows = [];
  const months = r.days / 30.4375;
  const add = (label, val, hint, cls, formula) => rows.push('<div><div class="k"><div class="t">' + label + '</div><div class="d">' + formula + '</div></div><div class="v"><div class="' + (cls || '') + '" style="font-weight:700">' + val + '</div><div class="small muted">' + hint + '</div></div></div>');
  if (s.income > 0) {
    add('Savings rate', pct(s.savings_rate, 1), s.savings_rate >= 20 ? 'healthy' : s.savings_rate >= 0 ? 'could improve' : 'deficit', s.savings_rate >= 20 ? 'pos' : s.savings_rate >= 0 ? 'warn' : 'neg', '(income − net spending) ÷ income');
    add('Income ÷ spending', s.net_spending > 0 ? (s.income / s.net_spending).toFixed(2) + '×' : '—', s.net_spending > 0 ? (s.income >= s.net_spending ? 'income covers spending' : 'spending exceeds income') : '', s.income >= s.net_spending ? 'pos' : 'neg', 'earned income ÷ net spending');
    add('Fixed obligations', pct(s.obligations / s.income * 100), s.obligations / s.income <= .3 ? 'comfortable' : s.obligations / s.income <= .5 ? 'watch' : 'high', s.obligations / s.income <= .3 ? 'pos' : s.obligations / s.income <= .5 ? 'warn' : 'neg', 'rent + EMIs + insurance + bills ÷ income');
  } else add('Savings rate', 'Not available', 'no earned income identified', 'muted', 'needs identified income');
  if (s.spending > 0) {
    add('Essential share', pct(s.essential / s.spending * 100), 'of spending', '', 'needs: rent, groceries, bills, transport, health…');
    add('Discretionary share', pct(s.discretionary / s.spending * 100), 'of spending', '', 'wants: dining, shopping, travel, subscriptions');
    if (s.mixed / s.spending > .05) add('Not classifiable', pct(s.mixed / s.spending * 100), 'card bills, cash, unknown shops', 'muted', 'can\'t be split from a bank statement');
  }
  const bal = totalBalAt(r.to);
  const recent = monthsIn(addMonths(r.to, -6), r.to).filter(isCompleteMonth).slice(-6);
  if (bal && recent.length >= 3) {
    const sp = summarize(TX.filter(t => inAccount(t) && recent.includes(t.ym))).net_spending / recent.length;
    if (sp > 0) { const m = bal.total / sp; add('Cash buffer (estimate)', m.toFixed(1) + ' months', m >= 6 ? 'strong' : m >= 3 ? 'adequate' : 'thin', m >= 6 ? 'pos' : m >= 3 ? 'warn' : 'neg', 'closing balance ÷ avg monthly spending, last ' + recent.length + ' full months'); }
  }
  return rows.length ? '<div class="row-list">' + rows.join('') + '</div><div class="note">Indicators only, from bank data alone. Not a credit score; other accounts, loans and investments aren\'t visible here.</div>' : empty('No data in this view.');
}

/* ======================================================================= *
 * Page: Transactions (explorer)
 * ======================================================================= */
const PAGE_SIZE = 50;
const CHIPS = [
  ['All', null], ['Income', t => t.kind === 'income'], ['Refunds', t => t.kind === 'refund'],
  ['Essentials', t => t.kind === 'expense' && natureOf(t.cat) === 'essential'], ['Lifestyle', t => t.kind === 'expense' && natureOf(t.cat) === 'discretionary'],
  ['EMI / Loans', t => t.cat === 'loan_emi'], ['SIP / Invest', t => t.kind === 'investment'], ['Insurance', t => t.cat === 'insurance'],
  ['Credit card', t => t.cat === 'credit_card_payment'], ['People (P2P)', t => t.kind === 'p2p'], ['Health', t => t.cat === 'health'],
  ['Recurring', t => !!t.rec], ['Unusual', t => !!t.anom && !t.dis],
];
function resetTx() { S.tx = { q: '', kind: 'All', dir: 'All', cat: 'All', merchant: '', min: '', max: '', flag: 'All', chip: 'All', sort: 'date', desc: true, page: 0 }; }
function txFiltered() {
  const r = effective(range()), f = S.tx, q = f.q.trim().toLowerCase();
  const chip = (CHIPS.find(c => c[0] === f.chip) || [])[1];
  const min = parseFloat(f.min), max = parseFloat(f.max), merch = f.merchant.trim().toLowerCase();
  // An explicit Type / chip choice overrides the View filter (asking for P2P should show P2P).
  const ignoreView = f.kind !== 'All' || ['People (P2P)', 'Refunds'].includes(f.chip);
  const rows = r ? TX.filter(t => inAccount(t) && inRange(t, r) && (ignoreView || inView(t))
    && (f.kind === 'All' || t.kind === f.kind) && (f.dir === 'All' || t.dir === f.dir) && (f.cat === 'All' || t.cat === f.cat)
    && (!merch || t.merchant.toLowerCase().includes(merch))
    && (isNaN(min) || t.amt >= min) && (isNaN(max) || t.amt <= max)
    && (f.flag === 'All' || (f.flag === 'rec' ? !!t.rec : f.flag === 'anom' ? !!t.anom && !t.dis : f.flag === 'ovr' ? !!t.ovr : f.flag === 'low' ? t.conf < 0.5 : true))
    && (!chip || chip(t))
    && (!q || (t.merchant + ' ' + t.desc + ' ' + catLabel(t.cat) + ' ' + t.amt).toLowerCase().includes(q))) : [];
  const k = f.sort, dir = f.desc ? -1 : 1;
  const key = { date: t => t.date + String(t.seq).padStart(6, '0'), amt: t => t.amt, merchant: t => t.merchant.toLowerCase(), cat: t => catLabel(t.cat) }[k] || (t => t.date);
  return rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
}
function renderTxFilters() {
  const cats = [...new Set(TX.map(t => t.cat))].sort((a, b) => catLabel(a) < catLabel(b) ? -1 : 1);
  const kinds = Object.keys(KIND_LABEL);
  const sel = (id, label, opts, val) => '<label>' + label + '<select class="sel" id="' + id + '">' + opts.map(o => '<option value="' + esc(o[0]) + '"' + (o[0] === val ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select></label>';
  $('#txFilters').innerHTML =
    '<label>Search<input class="inp" id="txq" type="search" placeholder="merchant, narration, amount…" value="' + esc(S.tx.q) + '"></label>'
    + sel('txkind', 'Type', [['All', 'All types']].concat(kinds.map(k => [k, KIND_LABEL[k]])), S.tx.kind)
    + sel('txdir', 'Direction', [['All', 'In and out'], ['credit', 'Money in'], ['debit', 'Money out']], S.tx.dir)
    + sel('txcat', 'Category', [['All', 'All categories']].concat(cats.map(c => [c, catLabel(c)])), S.tx.cat)
    + '<label>Merchant / person<input class="inp" id="txmerch" list="merchList" value="' + esc(S.tx.merchant) + '"></label>'
    + '<label>Min ₹<input class="inp" id="txmin" type="number" min="0" inputmode="decimal" value="' + esc(S.tx.min) + '"></label>'
    + '<label>Max ₹<input class="inp" id="txmax" type="number" min="0" inputmode="decimal" value="' + esc(S.tx.max) + '"></label>'
    + sel('txflag', 'Flags', [['All', 'Any'], ['rec', 'Recurring'], ['anom', 'Unusual'], ['ovr', 'Categorised by you'], ['low', 'Low confidence']], S.tx.flag)
    + '<datalist id="merchList">' + [...new Set(TX.map(t => t.merchant))].sort().slice(0, 3000).map(m => '<option value="' + esc(m) + '">').join('') + '</datalist>';
  $('#txChips').innerHTML = CHIPS.map(c => '<button type="button" class="chip" aria-pressed="' + (S.tx.chip === c[0]) + '" data-chip="' + esc(c[0]) + '">' + esc(c[0]) + '</button>').join('');
  const upd = (k, v) => { S.tx[k] = v; S.tx.page = 0; renderTxTable(); };
  $('#txq').oninput = debounce(e => upd('q', e.target.value), 150);
  $('#txmerch').oninput = debounce(e => upd('merchant', e.target.value), 200);
  $('#txmin').oninput = debounce(e => upd('min', e.target.value), 250);
  $('#txmax').oninput = debounce(e => upd('max', e.target.value), 250);
  for (const [id, k] of [['txkind', 'kind'], ['txdir', 'dir'], ['txcat', 'cat'], ['txflag', 'flag']]) $('#' + id).onchange = e => upd(k, e.target.value);
}
function renderTransactions() { renderTxFilters(); renderTxTable(); }
function renderTxTable() {
  const rows = txFiltered(), pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  S.tx.page = Math.min(S.tx.page, pages - 1);
  const pg = rows.slice(S.tx.page * PAGE_SIZE, (S.tx.page + 1) * PAGE_SIZE);
  const tin = sum(rows.filter(t => t.dir === 'credit'), t => t.amt), tout = sum(rows.filter(t => t.dir === 'debit'), t => t.amt);
  $('#txCount').textContent = rows.length.toLocaleString('en-IN') + ' transactions · in ' + inr(tin) + ' · out ' + inr(tout);
  $$('#txChips .chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.chip === S.tx.chip)));
  const th = (k, l, cls) => '<th class="' + (cls || '') + '"' + (S.tx.sort === k ? ' aria-sort="' + (S.tx.desc ? 'descending' : 'ascending') + '"' : '') + '>' + (k ? '<button type="button" class="sort" data-sort="' + k + '">' + l + (S.tx.sort === k ? (S.tx.desc ? ' ↓' : ' ↑') : '') + '</button>' : l) + '</th>';
  $('#txTable thead').innerHTML = '<tr>' + th('date', 'Date') + th('merchant', 'Description') + th('cat', 'Category') + th('', 'Type') + th('amt', 'Money out', 'r') + th('', 'Money in', 'r') + th('', 'Balance', 'r') + '</tr>';
  $('#txTable tbody').innerHTML = pg.length ? pg.map(t => {
    const [cl, cc] = confLabel(t.conf);
    const flags = (t.rec ? ' <span title="Recurring" aria-label="Recurring">⟳</span>' : '') + (t.anom && !t.dis ? ' <span class="warn" title="Unusual — see details" aria-label="Unusual">⚠</span>' : '');
    return '<tr class="click" data-id="' + esc(t.id) + '" tabindex="0"><td style="white-space:nowrap">' + fmtDate(t.date) + (S.account === 'All' ? '<div class="d">' + esc(acctLabel(t.acct)) + '</div>' : '') + '</td>'
      + '<td><div class="t">' + esc(t.merchant) + flags + '</div><div class="d" title="' + esc(mask(t.desc)) + '">' + esc(mask(t.desc)) + '</div></td>'
      + '<td>' + badge(catLabel(t.cat)) + '<div class="d">' + (t.ovr ? 'set by you' : cl + ' confidence') + '</div></td>'
      + '<td class="small">' + esc(KIND_LABEL[t.kind] || t.kind) + '</td>'
      + '<td class="r">' + (t.dir === 'debit' ? '−' + inr(t.amt, true) : '') + '</td>'
      + '<td class="r pos">' + (t.dir === 'credit' ? '+' + inr(t.amt, true) : '') + '</td>'
      + '<td class="r muted">' + (t.bal == null ? '—' : inr(t.bal, true)) + '</td></tr>';
  }).join('') : '<tr><td colspan="7">' + empty(S.view !== 'all' && S.tx.kind === 'All' ? 'No matches. The View filter at the top hides transfers and P2P; switch it to "Everything" or pick a Type.' : 'No matching transactions.') + '</td></tr>';
  $('#txPager').innerHTML = '<span>Page ' + (S.tx.page + 1) + ' of ' + pages + '</span><span style="display:flex;gap:6px">'
    + '<button class="btn ghost sm" type="button" data-pg="-1"' + (S.tx.page ? '' : ' disabled') + '>← Previous</button>'
    + '<button class="btn ghost sm" type="button" data-pg="1"' + (S.tx.page < pages - 1 ? '' : ' disabled') + '>Next →</button></span>';
}

/* ---------- CSV export (Excel-friendly: UTF-8 BOM) ---------- */
function exportCsv(rows, name) {
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const lines = ['date,account,merchant,category,type,money_out,money_in,balance,confidence,description'];
  rows.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq).forEach(t => lines.push([
    t.date, q(acctLabel(t.acct)), q(t.merchant), q(catLabel(t.cat)), q(KIND_LABEL[t.kind] || t.kind),
    t.dir === 'debit' ? t.amt.toFixed(2) : '', t.dir === 'credit' ? t.amt.toFixed(2) : '', t.bal == null ? '' : t.bal.toFixed(2),
    t.conf, q(t.desc)].join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('Exported ' + rows.length.toLocaleString('en-IN') + ' transactions');
}

/* ======================================================================= *
 * Transaction drawer (details + fix category + review alert)
 * ======================================================================= */
const BY_ID = new Map();
const SERVED = () => !META.demo && (location.protocol === 'http:' || location.protocol === 'https:');
function openDrawer(id) {
  const t = BY_ID.get(id); if (!t) return;
  const [cl] = confLabel(t.conf);
  const series = t.rec ? (META.recurring || []).find(x => x.id === t.rec) : null;
  const same = TX.filter(x => x.merchant === t.merchant && x.id !== t.id).sort((a, b) => a.date < b.date ? 1 : -1);
  const cats = Object.keys(META.categories || {}).sort((a, b) => catLabel(a) < catLabel(b) ? -1 : 1);
  $('#drawerTitle').textContent = t.merchant;
  $('#drawerBody').innerHTML =
    '<div style="font-size:24px;font-weight:700" class="' + (t.dir === 'credit' ? 'pos' : '') + '">' + (t.dir === 'credit' ? '+' : '−') + inr(t.amt, true) + '</div>'
    + '<div class="muted" style="margin-bottom:12px">' + fmtDate(t.date) + ' · ' + esc(acctLabel(t.acct)) + '</div>'
    + (t.anom ? '<div class="callout ' + (t.dis ? '' : 'warn') + '" style="margin-bottom:12px"><b>' + (t.dis ? 'Reviewed — marked as fine' : 'Unusual (' + esc(t.anom.severity) + ')') + '</b>'
      + t.anom.reasons.map(x => '<div>' + esc(x.reason) + (x.baseline ? ' <span class="muted">· ' + esc(x.baseline) + '</span>' : '') + '</div>').join('')
      + (SERVED() ? '<div style="margin-top:6px"><button class="btn sm ' + (t.dis ? 'ghost' : '') + '" type="button" id="dzDismiss">' + (t.dis ? 'Undo review' : 'Mark as reviewed / legitimate') + '</button></div>' : '') + '</div>' : '')
    + '<dl class="kv">'
    + '<dt>Type</dt><dd>' + esc(KIND_LABEL[t.kind]) + '<div class="small muted">' + esc(KIND_HELP[t.kind] || '') + '</div></dd>'
    + '<dt>Category</dt><dd>' + esc(catLabel(t.cat)) + ' <span class="small muted">(' + (t.ovr ? 'set by you' : cl + ' confidence') + ')</span></dd>'
    + '<dt>Narration</dt><dd style="font-family:ui-monospace,Menlo,monospace;font-size:12px">' + esc(mask(t.desc)) + '</dd>'
    + '<dt>Balance after</dt><dd>' + (t.bal == null ? '—' : inr(t.bal, true)) + '</dd>'
    + (series ? '<dt>Recurring</dt><dd>' + esc(cap(series.frequency)) + ' · usually ' + inr(series.typical) + ' · next around ' + fmtDate(series.next_estimate) + ' <span class="small muted">(estimate)</span></dd>' : '')
    + '</dl>'
    + '<h3 class="card-t" style="margin:16px 0 6px">Change category</h3>'
    + (SERVED() ? '<div style="display:flex;flex-direction:column;gap:8px"><select class="sel" id="dzCat">' + cats.map(c => '<option value="' + c + '"' + (c === t.cat ? ' selected' : '') + '>' + esc(catLabel(c)) + '</option>').join('') + '</select>'
      + '<label class="small"><input type="radio" name="dzScope" value="txn" checked> Just this transaction</label>'
      + '<label class="small"><input type="radio" name="dzScope" value="merchant"> Everything from ' + esc(t.merchant) + ' (' + (same.length + 1) + ' transactions)</label>'
      + '<div style="display:flex;gap:8px"><button class="btn" type="button" id="dzSave">Save</button>' + (t.ovr ? '<button class="btn ghost" type="button" id="dzReset">Undo my change</button>' : '') + '</div>'
      + '<div class="small muted">Saved to overrides.json. Your fixes survive re-imports and beat the rules in rules.py.</div></div>'
      : '<div class="small muted">' + (META.demo ? 'Read-only demo: in the real app you can change the category here, for one transaction or everything from this merchant.' : 'Open the dashboard through <code>python3 serve.py</code> to save changes.') + '</div>')
    + '<h3 class="card-t" style="margin:16px 0 6px">Other transactions with ' + esc(t.merchant) + '</h3>'
    + (same.length ? '<div class="row-list">' + same.slice(0, 5).map(x => txLine(x)).join('') + '</div><div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap"><button class="btn link" type="button" id="dzAll">See all ' + (same.length + 1) + ' →</button><button class="btn link" type="button" id="dzCp">Open in Counterparties →</button></div>' : '<div class="muted small">None.</div>');
  $('#drawer').classList.add('on'); $('#scrim').classList.add('on'); $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawerClose').focus();
  const dz = $('#drawerBody');
  dz.onclick = ev => { const row = ev.target.closest('[data-id]'); if (row) openDrawer(row.dataset.id); };
  if ($('#dzAll')) $('#dzAll').onclick = () => { closeDrawer(); resetTx(); S.tx.merchant = t.merchant; go('transactions'); };
  if ($('#dzCp')) $('#dzCp').onclick = () => { closeDrawer(); S.cp = t.merchant; go('counterparties'); };
  if ($('#dzSave')) $('#dzSave').onclick = () => saveCategory(t, $('#dzCat').value, ($('input[name=dzScope]:checked') || {}).value || 'txn');
  if ($('#dzReset')) $('#dzReset').onclick = () => saveCategory(t, '', 'txn');
  if ($('#dzDismiss')) $('#dzDismiss').onclick = () => setDismissed(t, !t.dis);
}
function closeDrawer() { $('#drawer').classList.remove('on'); $('#scrim').classList.remove('on'); $('#drawer').setAttribute('aria-hidden', 'true'); }

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' });
  let j = {}; try { j = await r.json(); } catch (e) { /* non-JSON error page */ }
  if (!r.ok || !j.ok) { const err = new Error(j.error || ('Server error ' + r.status)); err.data = j; throw err; }
  return j;
}
function saveState() { store.sset('fd-state', { account: S.account, period: S.period, month: S.month, day: S.day, from: S.from, to: S.to, view: S.view, tx: S.tx, cp: S.cp }); }
async function saveCategory(t, cat, scope) {
  const btn = $('#dzSave'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await api('/api/category', { id: t.id, category: cat, scope });
    saveState(); store.sset('fd-reopen', t.id);
    toast('Saved. Recalculating…'); setTimeout(() => location.reload(), 300);
  } catch (e) { toast('Couldn\'t save: ' + e.message); if (btn) { btn.disabled = false; btn.textContent = 'Save'; } }
}
async function setDismissed(t, dis) {
  try { await api('/api/dismiss', { id: t.id, dismissed: dis }); t.dis = dis; toast(dis ? 'Marked as reviewed' : 'Review undone'); openDrawer(t.id); renderActive(); }
  catch (e) { toast('Couldn\'t save: ' + e.message); }
}

/* ======================================================================= *
 * Page: Cash flow
 * ======================================================================= */
function renderCashflow() {
  const r = effective(range());
  if (!r) { $('#cfStats').innerHTML = empty('No statements cover this period.'); return; }
  const rows = rowsIn(r), s = summarize(rows), bm = byMonth(rows), ms = monthsIn(r.from, r.to);
  const nets = ms.map(m => summarize(bm[m] || []).net_flow), full = ms.filter(isCompleteMonth);
  const fullNets = full.map(m => summarize(bm[m] || []).net_flow);
  const pos = fullNets.filter(x => x >= 0).length, neg = fullNets.length - pos;
  const mean = fullNets.length ? sum(fullNets) / fullNets.length : null;
  const sd = fullNets.length > 1 ? Math.sqrt(sum(fullNets.map(x => (x - mean) ** 2)) / (fullNets.length - 1)) : null;
  const last3 = full.slice(-3).map(m => summarize(bm[m] || []));
  $('#cfStats').innerHTML = '<div class="stats">'
    + statBox('Money in', inr(s.money_in), '', 'pos') + statBox('Money out', inr(s.money_out), '', 'neg')
    + statBox('Net cash flow', signedInr(s.net_flow), r.days + ' days', s.net_flow >= 0 ? 'pos' : 'neg')
    + statBox('Avg monthly net', mean == null ? '—' : signedInr(mean), fullNets.length + ' complete months', mean >= 0 ? 'pos' : 'neg')
    + statBox('Positive / negative months', fullNets.length ? pos + ' / ' + neg : '—', 'complete months only')
    + statBox('Volatility', sd == null ? '—' : '±' + inr(sd), 'std. dev. of monthly net')
    + statBox('Typical month (estimate)', last3.length >= 2 ? inr(median(last3.map(x => x.money_in))) + ' in' : '—', last3.length >= 2 ? inr(median(last3.map(x => x.money_out))) + ' out · median of last ' + last3.length + ' full months' : 'needs 2+ full months')
    + '</div>';
  const C = { pos: css('--chart-pos'), neg: css('--chart-neg') }, view = ms.slice(-36), vn = nets.slice(-36);
  if (!ms.length) chartEmpty('cfNet');
  else chart('cfNet', { type: 'bar', data: { labels: view.map(fmtMonthShort), datasets: [{ label: 'Net', data: vn, backgroundColor: vn.map(x => x >= 0 ? C.pos : C.neg), borderRadius: 3 }] },
    options: { plugins: { tooltip: { callbacks: { label: c => { const x = summarize(bm[view[c.dataIndex]] || []); return [' Net ' + signedInr(x.net_flow), ' In ' + inr(x.money_in), ' Out ' + inr(x.money_out)]; } } } }, scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } }, y: { ticks: moneyTicks } } },
    onPick: i => drillMonth(view[i]) });
  renderBalanceChart('cfBal', r, $('#cfBalSub'));

  // Bank view: EVERY row on the statement (incl. transfers, P2P, reversals), so
  // opening + in − out must equal closing. Then the default-View figures beside it.
  const all = byMonth(TX.filter(t => inAccount(t) && inRange(t, r))), realBm = byMonth(rowsIn(r, true));
  const head = '<thead><tr><th>Month</th><th class="r">Opening</th><th class="r">Money in</th><th class="r">Money out</th><th class="r">Closing</th><th>Ties out?</th><th class="r">Earned income</th><th class="r">Net spending</th><th class="r">Transfers + P2P (net)</th></tr></thead>';
  let ok = 0, checked = 0;
  const body = ms.slice().reverse().map(m => {
    const from = m + '-01' < r.from ? r.from : m + '-01', to = monthEnd(m) > r.to ? r.to : monthEnd(m);
    // tie out over the accounts that have statement balances for this month
    // (an account opened later simply isn't part of the check yet)
    const scope = accountsInScope(), accts = scope.filter(ac => balAt(ac, addDays(from, -1)) != null && balAt(ac, to) != null);
    const rows = (all[m] || []).filter(t => accts.includes(t.acct));
    const o = accts.length ? round2(sum(accts, ac => balAt(ac, addDays(from, -1)))) : null, c = accts.length ? round2(sum(accts, ac => balAt(ac, to))) : null;
    const tin = sum(rows.filter(t => t.dir === 'credit'), t => t.amt), tout = sum(rows.filter(t => t.dir === 'debit'), t => t.amt);
    const x = summarize(realBm[m] || []), tp = sum(rows.filter(t => t.kind === 'transfer' || t.kind === 'p2p'), t => t.dir === 'credit' ? t.amt : -t.amt);
    let tie = '<span class="muted">—</span>';
    if (accts.length) {
      checked++;
      const diff = round2(o + tin - tout - c);
      if (Math.abs(diff) < 0.01) { ok++; tie = '<span class="pos">✓ yes</span>'; } else tie = '<span class="neg">✗ off by ' + inr(diff, true) + '</span>';
      if (accts.length < scope.length) tie += ' <span class="small muted">(' + accts.map(acctLabel).join(', ') + ' only)</span>';
    }
    return '<tr><td>' + fmtMonth(m) + (to !== monthEnd(m) || from !== m + '-01' ? ' <span class="small muted">(part)</span>' : '') + '</td><td class="r">' + (o == null ? '—' : inr(o)) + '</td><td class="r pos">' + inr(tin) + '</td><td class="r">' + inr(tout) + '</td><td class="r">' + (c == null ? '—' : inr(c)) + '</td><td>' + tie + '</td>'
      + '<td class="r">' + inr(x.income) + '</td><td class="r">' + inr(x.net_spending) + '</td><td class="r">' + signedInr(tp) + '</td></tr>';
  }).join('');
  $('#cfTable').innerHTML = head + '<tbody>' + body + '</tbody>';
  $('#cfNote').innerHTML = (checked ? '<b>' + ok + ' of ' + checked + '</b> months tie out exactly: opening balance + money in − money out = closing balance. ' : '')
    + 'Your balance changes by <i>all</i> money in minus <i>all</i> money out, including transfers between your own accounts and money to/from people. '
    + 'Earned income and spending leave those out, so "income − spending" won\'t equal the balance change; the last column is the difference.';

  const days = {};
  for (const t of rows) { const d = days[t.date] = days[t.date] || { i: 0, o: 0 }; if (t.dir === 'credit') d.i += t.amt; else d.o += t.amt; }
  const dl = Object.entries(days);
  const line = (d, v, cls) => '<div><div class="k"><div class="t">' + fmtDate(d) + '</div><div class="d">' + DOW[(D(d).getUTCDay() + 6) % 7] + '</div></div><div class="v ' + cls + '">' + inr(v) + '</div></div>';
  $('#cfInDays').innerHTML = dl.filter(x => x[1].i).sort((a, b) => b[1].i - a[1].i).slice(0, 5).map(x => line(x[0], x[1].i, 'pos')).join('') || empty('No money in.');
  $('#cfOutDays').innerHTML = dl.filter(x => x[1].o).sort((a, b) => b[1].o - a[1].o).slice(0, 5).map(x => line(x[0], x[1].o, 'neg')).join('') || empty('No money out.');
}

/* ======================================================================= *
 * Page: Income
 * ======================================================================= */
function renderIncome() {
  const r = effective(range());
  if (!r) { $('#incStats').innerHTML = empty('No statements cover this period.'); return; }
  const rows = rowsIn(r, true).filter(t => t.dir === 'credit' && t.kind !== 'reversed'), s = summarize(rows);
  const sal = rows.filter(t => t.cat === 'salary' && t.kind === 'income');
  const salTot = sum(sal, t => t.amt), other = s.income - salTot;
  $('#incStats').innerHTML = '<div class="stats">'
    + statBox('All money in', inr(s.money_in), rows.length + ' credits')
    + statBox('Earned income', inr(s.income), 'counts toward savings', 'pos')
    + statBox('Salary', inr(salTot), sal.length + ' credits')
    + statBox('Other earned', inr(other), 'interest, freelance…')
    + statBox('Refunds & cashback', inr(s.refunds), 'not income')
    + statBox('From own accounts', inr(s.transfer_in), 'not income')
    + statBox('From people (P2P)', inr(s.p2p_in), 'not income')
    + '</div>';
  const ms = monthsIn(r.from, r.to).slice(-24), bm = byMonth(rows), pal = palette();
  const series = [['Salary', t => t.cat === 'salary' && t.kind === 'income', pal[1]], ['Other earned', t => t.kind === 'income' && t.cat !== 'salary', pal[0]],
    ['Refunds', t => t.kind === 'refund', pal[2]], ['Own accounts', t => t.kind === 'transfer', pal[7]], ['People (P2P)', t => t.kind === 'p2p', pal[3]], ['Investments back', t => t.kind === 'investment', pal[5]]];
  if (!rows.length) chartEmpty('incChart', 'No money in during this period.');
  else chart('incChart', { type: 'bar', data: { labels: ms.map(fmtMonthShort), datasets: series.map(([l, f, c]) => ({ label: l, data: ms.map(m => sum((bm[m] || []).filter(f), t => t.amt)), backgroundColor: c, stack: 's', borderRadius: 2 })).filter(d => d.data.some(Boolean)) },
    options: { plugins: { legend: { display: true }, tooltip: tipMoney }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: moneyTicks } } }, onPick: i => drillMonth(ms[i]) });

  // salary block
  const allSal = TX.filter(t => inAccount(t) && t.cat === 'salary' && t.kind === 'income' && t.date <= r.to).sort((a, b) => a.date < b.date ? -1 : 1);
  if (!sal.length) $('#incSalary').innerHTML = empty('No salary credits identified in this period.') + '<div class="note">Salary is identified from your employer\'s name (rules.py) and words like "SAL"/"SALARY" in the narration.</div>';
  else {
    const byM = {}; sal.forEach(t => byM[t.ym] = (byM[t.ym] || 0) + t.amt);
    const vals = Object.values(byM), avg = sum(vals) / vals.length;
    const cv = vals.length > 1 ? Math.sqrt(sum(vals.map(v => (v - avg) ** 2)) / (vals.length - 1)) / avg : null;
    const last = sal[sal.length - 1], prev6 = allSal.filter(t => t.date < last.date).slice(-6), p6 = prev6.length ? sum(prev6, t => t.amt) / prev6.length : null;
    const hi = sal.filter(t => t.conf >= 0.95).length;
    $('#incSalary').innerHTML = '<div class="row-list">'
      + '<div><div class="k"><div class="t">Latest</div><div class="d">' + fmtDate(last.date) + ' · ' + esc(last.merchant) + '</div></div><div class="v"><b>' + inr(last.amt) + '</b>' + (p6 ? '<div class="small ' + (last.amt >= p6 ? 'pos' : 'neg') + '">' + (last.amt >= p6 ? '↑ ' : '↓ ') + pct(Math.abs(last.amt - p6) / p6 * 100) + ' vs prior ' + prev6.length + '-mo avg</div>' : '') + '</div></div>'
      + '<div><div class="k"><div class="t">Average per salary month</div><div class="d">' + vals.length + ' months with salary</div></div><div class="v">' + inr(avg) + '</div></div>'
      + '<div><div class="k"><div class="t">Consistency</div><div class="d">variation between months</div></div><div class="v">' + (cv == null ? '—' : cv < .1 ? badge('Very steady', 'pos') : cv < .25 ? badge('Fairly steady', 'warn') : badge('Varies a lot', 'neg')) + '</div></div>'
      + '<div><div class="k"><div class="t">Confidence</div><div class="d">' + hi + ' of ' + sal.length + ' say "SAL/SALARY"; the rest match your employer\'s name</div></div><div class="v">' + badge(hi === sal.length ? 'High' : 'High / medium', hi === sal.length ? 'pos' : 'warn') + '</div></div>'
      + '</div>';
  }
  // sources table
  const src = {};
  for (const t of rows.filter(t => t.kind === 'income' || t.kind === 'refund')) {
    const x = src[t.merchant + '|' + t.kind] = src[t.merchant + '|' + t.kind] || { m: t.merchant, kind: t.kind, cat: t.cat, tot: 0, n: 0, months: new Set(), last: '', conf: [] };
    x.tot += t.amt; x.n++; x.months.add(t.ym); x.last = t.date > x.last ? t.date : x.last; x.conf.push(t.conf);
  }
  const list = Object.values(src).sort((a, b) => b.tot - a.tot).slice(0, 25);
  $('#incTable').innerHTML = '<thead><tr><th>Source</th><th>Type</th><th class="r">Total</th><th class="r">Count</th><th>How often</th><th class="r">Average</th><th>Last</th><th>Confidence</th></tr></thead><tbody>'
    + (list.length ? list.map(x => { const c = confLabel(median(x.conf));
      return '<tr class="click" data-merchant="' + esc(x.m) + '"><td class="t">' + esc(x.m) + '</td><td>' + badge(x.kind === 'income' ? catLabel(x.cat) : 'Refund · ' + catLabel(x.cat), x.kind === 'income' ? 'pos' : '') + '</td><td class="r">' + inr(x.tot) + '</td><td class="r">' + x.n + '</td><td class="small">' + (x.months.size >= 3 ? 'in ' + x.months.size + ' months' : x.n > 1 ? 'occasional' : 'once') + '</td><td class="r">' + inr(x.tot / x.n) + '</td><td>' + fmtDate(x.last) + '</td><td>' + badge(c[0], c[1]) + '</td></tr>'; }).join('')
      : '<tr><td colspan="8">' + empty('No income or refunds in this period.') + '</td></tr>') + '</tbody>';
  // regular credits that rules didn't call income (people paying you monthly etc.)
  const reg = {};
  for (const t of TX.filter(t => inAccount(t) && inRange(t, r) && t.dir === 'credit' && t.kind === 'p2p' && t.amt >= 10000)) (reg[t.merchant] = reg[t.merchant] || []).push(t);
  const regular = Object.entries(reg).filter(([, a]) => new Set(a.map(t => t.ym)).size >= 3).map(([m, a]) => [m, a.length, sum(a, t => t.amt)]).sort((a, b) => b[2] - a[2]).slice(0, 5);
  $('#incNote').innerHTML = 'Refunds and money from your own accounts or people are never counted as earned income.'
    + (regular.length ? ' <b>Regular credits from people (≥ ₹10,000 in 3+ months), not counted as income:</b> ' + regular.map(x => esc(x[0]) + ' (' + x[1] + '×, ' + inr(x[2]) + ')').join(', ') + '. If any of these is really income (rent received, freelance), open one and change its category.' : '');
}

/* ======================================================================= *
 * Page: Spending
 * ======================================================================= */
function renderSpending() {
  const r = effective(range());
  if (!r) { $('#spStats').innerHTML = empty('No statements cover this period.'); return; }
  const rows = rowsIn(r, true), s = summarize(rows), months = r.days / 30.4375;
  const pr = prevRange(r), prows = pr ? rowsIn(pr, true) : [], f = pr ? r.days / pr.days : 1;
  $('#spStats').innerHTML = '<div class="stats">'
    + statBox('Spending (gross)', inr(s.spending), rows.filter(t => t.kind === 'expense').length + ' payments', 'neg')
    + statBox('Refunds', inr(s.refunds), 'money back') + statBox('Net spending', inr(s.net_spending), 'gross − refunds')
    + statBox('Per month', inr(s.net_spending / months), 'net, avg') + statBox('Essential', s.spending ? pct(s.essential / s.spending * 100) : '—', inr(s.essential))
    + statBox('Discretionary', s.spending ? pct(s.discretionary / s.spending * 100) : '—', inr(s.discretionary))
    + statBox('Not classifiable', s.spending ? pct(s.mixed / s.spending * 100) : '—', 'card bills, cash, unknown shops')
    + statBox('Invested (not spending)', inr(s.invested), 'SIPs, FDs, stocks') + '</div>';
  const cs = catSpend(rows), pcs = catSpend(prows);
  const cats = Object.entries(cs).filter(([, v]) => v.spent > 0).sort((a, b) => b[1].spent - a[1].spent);
  const pal = palette();
  if (!cats.length) chartEmpty('spCat', 'No spending in this period.');
  else chart('spCat', { type: 'bar', data: { labels: cats.slice(0, 12).map(c => catLabel(c[0])), datasets: [{ data: cats.slice(0, 12).map(c => c[1].spent), backgroundColor: cats.slice(0, 12).map(c => natureOf(c[0]) === 'essential' ? pal[0] : natureOf(c[0]) === 'discretionary' ? pal[3] : pal[7]), borderRadius: 3 }] },
    options: { indexAxis: 'y', plugins: { tooltip: tipMoney }, scales: { x: { ticks: moneyTicks }, y: { grid: { display: false } } } },
    onPick: i => { resetTx(); S.tx.cat = cats[i][0]; go('transactions'); } });
  const mer = {};
  rows.filter(t => t.kind === 'expense' && t.dir === 'debit').forEach(t => { const x = mer[t.merchant] = mer[t.merchant] || { v: 0, n: 0 }; x.v += t.amt; x.n++; });
  const topM = Object.entries(mer).sort((a, b) => b[1].v - a[1].v).slice(0, 10);
  if (!topM.length) chartEmpty('spMerch', 'No spending in this period.');
  else chart('spMerch', { type: 'bar', data: { labels: topM.map(m => m[0]), datasets: [{ data: topM.map(m => m[1].v), backgroundColor: pal[5], borderRadius: 3 }] },
    options: { indexAxis: 'y', plugins: { tooltip: tipMoney }, scales: { x: { ticks: moneyTicks }, y: { grid: { display: false } } } },
    onPick: i => { resetTx(); S.tx.merchant = topM[i][0]; go('transactions'); } });
  $('#spTableSub').textContent = pr ? 'Change compares with ' + pr.label + (f !== 1 ? ' (scaled to the same number of days)' : '') : 'No earlier period to compare with';
  $('#spTable').innerHTML = '<thead><tr><th>Category</th><th>Type</th><th class="r">Spent</th><th class="r">Refunds</th><th class="r">Net</th><th class="r">Share</th><th class="r">Payments</th><th class="r">Avg payment</th><th class="r">vs previous</th></tr></thead><tbody>'
    + (cats.length ? cats.map(([c, v]) => {
      const net = v.spent - v.refunds, p = pcs[c] ? (pcs[c].spent - pcs[c].refunds) * f : null, d = p == null ? null : net - p;
      return '<tr class="click" data-cat="' + esc(c) + '"><td class="t">' + esc(catLabel(c)) + '</td><td class="small">' + esc(natureOf(c)) + '</td><td class="r">' + inr(v.spent) + '</td><td class="r muted">' + (v.refunds ? inr(v.refunds) : '—') + '</td><td class="r"><b>' + inr(net) + '</b></td>'
        + '<td class="r">' + pct(v.spent / s.spending * 100, 1) + '<div class="bar"><span style="width:' + Math.min(100, v.spent / cats[0][1].spent * 100).toFixed(1) + '%"></span></div></td><td class="r">' + v.n + '</td><td class="r">' + inr(v.spent / v.n) + '</td>'
        + '<td class="r">' + (d == null ? '<span class="muted">new</span>' : Math.abs(d) < 1 ? '<span class="muted">same</span>' : '<span class="' + (d > 0 ? 'neg' : 'pos') + '">' + (d > 0 ? '↑ ' : '↓ ') + inr(Math.abs(d)) + (p > 0 ? ' (' + pct(Math.abs(d / p * 100)) + ')' : '') + '</span>') + '</td></tr>';
    }).join('') : '<tr><td colspan="9">' + empty('No spending in this period.') + '</td></tr>') + '</tbody>';

  // monthly heatmap: top categories × last 12 months
  const ms = monthsIn(r.from, r.to).slice(-12), bm = byMonth(rows.filter(t => t.kind === 'expense' && t.dir === 'debit'));
  const topC = cats.slice(0, 10).map(c => c[0]);
  const cell = {}; let max = 0;
  for (const m of ms) for (const t of bm[m] || []) { if (!topC.includes(t.cat)) continue; const k = t.cat + m; cell[k] = (cell[k] || 0) + t.amt; max = Math.max(max, cell[k]); }
  $('#spHeat').innerHTML = topC.length ? '<thead><tr><th>Category</th>' + ms.map(m => '<th class="r">' + fmtMonthShort(m) + '</th>').join('') + '</tr></thead><tbody>'
    + topC.map(c => '<tr><td class="t" style="text-align:left">' + esc(catLabel(c)) + '</td>' + ms.map(m => { const v = cell[c + m] || 0; return '<td title="' + esc(catLabel(c) + ', ' + fmtMonth(m) + ': ' + inr(v)) + '" style="background:color-mix(in srgb, var(--chart-accent) ' + (v ? Math.round(8 + 62 * v / max) : 0) + '%, transparent)">' + (v ? inrShort(v) : '<span class="muted">·</span>') + '</td>'; }).join('') + '</tr>').join('') + '</tbody>'
    : '<tbody><tr><td>' + empty('No spending in this period.') + '</td></tr></tbody>';

  // day of week (average per occurrence of that weekday in the period)
  const dowTot = [0, 0, 0, 0, 0, 0, 0], dowN = [0, 0, 0, 0, 0, 0, 0];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) dowN[(D(d).getUTCDay() + 6) % 7]++;
  rows.filter(t => t.kind === 'expense' && t.dir === 'debit').forEach(t => dowTot[(D(t.date).getUTCDay() + 6) % 7] += t.amt);
  const avg = dowTot.map((v, i) => dowN[i] ? v / dowN[i] : 0);
  const wd = sum(dowTot.slice(0, 5)) / Math.max(1, sum(dowN.slice(0, 5))), we = sum(dowTot.slice(5)) / Math.max(1, sum(dowN.slice(5)));
  $('#spDowSub').textContent = 'Avg per day · weekdays ' + inr(wd) + ' vs weekends ' + inr(we);
  if (!s.spending) chartEmpty('spDow');
  else chart('spDow', { type: 'bar', data: { labels: DOW, datasets: [{ data: avg, backgroundColor: DOW.map((_, i) => i >= 5 ? pal[3] : pal[0]), borderRadius: 3 }] },
    options: { plugins: { tooltip: { callbacks: { label: c => ' ' + inr(c.parsed.y) + ' per ' + DOW[c.dataIndex] } } }, scales: { x: { grid: { display: false } }, y: { ticks: moneyTicks } } } });
  const freq = Object.entries(mer).sort((a, b) => b[1].n - a[1].n).slice(0, 7);
  $('#spFreq').innerHTML = freq.map(([m, v]) => '<div class="click" data-merchant="' + esc(m) + '"><div class="k"><div class="t">' + esc(m) + '</div><div class="d">' + v.n + ' payments · avg ' + inr(v.v / v.n) + '</div></div><div class="v">' + inr(v.v) + '</div></div>').join('') || empty('No spending.');
  const moves = Object.keys({ ...cs, ...pcs }).map(c => { const cur = cs[c] ? cs[c].spent - cs[c].refunds : 0, prev = pcs[c] ? (pcs[c].spent - pcs[c].refunds) * f : 0; return { c, cur, prev, d: cur - prev }; })
    .filter(x => Math.abs(x.d) >= 500).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 7);
  $('#spMoversSub').textContent = pr ? 'vs ' + pr.label : 'Needs an earlier period with data';
  $('#spMovers').innerHTML = pr ? (moves.map(x => '<div class="click" data-cat="' + esc(x.c) + '"><div class="k"><div class="t">' + esc(catLabel(x.c)) + '</div><div class="d">' + inr(x.prev) + ' → ' + inr(x.cur) + '</div></div><div class="v ' + (x.d > 0 ? 'neg' : 'pos') + '">' + (x.d > 0 ? '↑ ' : '↓ ') + inr(Math.abs(x.d)) + '</div></div>').join('') || empty('No change of ₹500+ in any category.')) : empty('No earlier period to compare.');
}

/* ======================================================================= *
 * Page: Recurring & bills
 * ======================================================================= */
const recurringSeries = () => (META.recurring || []).filter(x => S.account === 'All' || (x.accounts || []).includes(S.account));
function recTable(list) {
  if (!list.length) return '<tbody><tr><td>' + empty('None found.') + '</td></tr></tbody>';
  return '<thead><tr><th>Payee</th><th>Category</th><th>How often</th><th class="r">Typical</th><th>Last</th><th>Next (estimate)</th><th class="r">Per month</th><th class="r">Per year</th><th>Status</th></tr></thead><tbody>'
    + list.map(x => '<tr class="click" data-merchant="' + esc(x.merchant) + '"><td class="t">' + esc(x.merchant) + (x.kind === 'p2p' ? ' <span class="small muted">(person)</span>' : '') + '</td><td>' + esc(catLabel(x.category)) + '</td><td>' + esc(cap(x.frequency)) + ' <span class="small muted">×' + x.count + '</span></td><td class="r">' + inr(x.typical) + (Math.abs(x.last_amount - x.typical) > .25 * x.typical ? '<div class="small warn">last ' + inr(x.last_amount) + '</div>' : '') + '</td>'
      + '<td>' + fmtDate(x.last) + '</td><td>' + (x.active ? '~' + fmtDate(x.next_estimate) : '<span class="muted">—</span>') + '</td><td class="r">' + inr(x.monthly_cost) + '</td><td class="r">' + inr(x.annual_cost) + '</td><td>' + (x.active ? badge('Active', 'pos') : badge('Stopped?', '')) + '</td></tr>').join('') + '</tbody>';
}
function renderRecurring() {
  const all = recurringSeries(), act = all.filter(x => x.active);
  const mo = sum(act, x => x.monthly_cost), hi = all.filter(x => x.confidence === 'high'), md = all.filter(x => x.confidence !== 'high');
  // obligations: average of the last 3 complete months (rent, EMIs, insurance, bills) + card bills
  const full = monthsIn(addMonths(cover().to, -4), cover().to).filter(isCompleteMonth).slice(-3);
  const rows = TX.filter(t => inAccount(t) && full.includes(t.ym)), n = Math.max(1, full.length);
  const bucket = {}; rows.filter(t => t.kind === 'expense' && t.dir === 'debit').forEach(t => bucket[t.cat] = (bucket[t.cat] || 0) + t.amt);
  const inc = summarize(rows).income / n;
  const oblCats = (META.obligationCategories || []).concat(['credit_card_payment']);
  const obl = oblCats.map(c => [c, (bucket[c] || 0) / n]).filter(x => x[1] > 0);
  const fixed = sum(obl.filter(x => x[0] !== 'credit_card_payment'), x => x[1]);
  $('#recStats').innerHTML = '<div class="stats">'
    + statBox('Active recurring', act.length, all.length + ' found in total') + statBox('Recurring cost', inr(mo) + '/mo', inr(mo * 12) + ' a year')
    + statBox('Fixed obligations', inr(fixed) + '/mo', 'rent, EMIs, insurance, bills') + statBox('Share of income', inc ? pct(fixed / inc * 100) : '—', inc ? 'of ' + inr(inc) + '/mo earned' : 'no income identified') + '</div>';
  $('#recHigh').innerHTML = recTable(hi);
  $('#recMed').innerHTML = recTable(md);
  const top = act.slice().sort((a, b) => b.monthly_cost - a.monthly_cost).slice(0, 12);
  if (!top.length) chartEmpty('recChart', 'No active recurring payments.');
  else chart('recChart', { type: 'bar', data: { labels: top.map(x => x.merchant), datasets: [{ data: top.map(x => x.monthly_cost), backgroundColor: palette()[3], borderRadius: 3 }] },
    options: { indexAxis: 'y', plugins: { tooltip: { callbacks: { label: c => ' ' + inr(c.parsed.x) + '/month (' + top[c.dataIndex].frequency + ')' } } }, scales: { x: { ticks: moneyTicks }, y: { grid: { display: false } } } },
    onPick: i => { resetTx(); S.tx.merchant = top[i].merchant; go('transactions'); } });
  $('#oblSub').textContent = full.length ? 'Average of ' + full.map(fmtMonthShort).join(', ') : 'Needs complete months of data';
  $('#obl').innerHTML = obl.length ? '<div class="row-list">' + obl.sort((a, b) => b[1] - a[1]).map(([c, v]) => '<div class="click" data-cat="' + c + '"><div class="k"><div class="t">' + esc(catLabel(c)) + '</div><div class="d">' + (c === 'credit_card_payment' ? 'varies with card use, not fixed' : 'per month') + '</div></div><div class="v">' + inr(v) + (inc ? '<div class="small muted">' + pct(v / inc * 100) + ' of income</div>' : '') + '</div></div>').join('') + '</div>'
    + '<div class="note">Loan EMIs are shown in full. Bank statements don\'t split principal from interest, so neither does FinDash.</div>' : empty('No obligations in the last complete months.');
}

/* ======================================================================= *
 * Page: Insights & alerts
 * ======================================================================= */
function renderInsightsPage() {
  INS_CACHE = insights();
  const r = effective(range());
  $('#insSub').textContent = r ? r.label + ' · ' + (S.account === 'All' ? 'all accounts' : acctLabel(S.account)) : '';
  $('#insList').innerHTML = renderInsightList(INS_CACHE);
  const rows = r ? TX.filter(t => inAccount(t) && inRange(t, r) && t.anom && (S.showDismissed || !t.dis)) : [];
  const rank = { high: 3, medium: 2, low: 1 };
  rows.sort((a, b) => rank[b.anom.severity] - rank[a.anom.severity] || b.amt - a.amt);
  const live = r ? TX.filter(t => inAccount(t) && inRange(t, r) && t.anom && !t.dis) : [];
  const cnt = ['high', 'medium', 'low'].map(k => live.filter(t => t.anom.severity === k).length);
  $('#anSub').textContent = live.length + ' to review' + (r ? ' · ' + r.label : '');
  if (!live.length) chartEmpty('anChart', 'Nothing unusual to review.');
  else chart('anChart', { type: 'bar', data: { labels: ['High', 'Medium', 'Low'], datasets: [{ data: cnt, backgroundColor: [css('--chart-neg'), css('--c3'), css('--chart-muted')], borderRadius: 3 }] },
    options: { indexAxis: 'y', plugins: { tooltip: { callbacks: { label: c => ' ' + c.parsed.x + ' transactions' } } }, scales: { x: { ticks: { precision: 0 } }, y: { grid: { display: false } } } } });
  const sev = { high: 'neg', medium: 'warn', low: '' };
  $('#anTable').innerHTML = rows.length ? '<thead><tr><th>Date</th><th>Payee</th><th class="r">Amount</th><th>Why it was flagged</th><th>Severity</th><th></th></tr></thead><tbody>'
    + rows.slice(0, 200).map(t => '<tr class="click" data-id="' + esc(t.id) + '"><td style="white-space:nowrap">' + fmtDate(t.date) + '</td><td class="t">' + esc(t.merchant) + '</td><td class="r">' + inr(t.amt) + '</td>'
      + '<td class="small">' + t.anom.reasons.map(x => esc(x.reason) + (x.baseline ? '<div class="muted">' + esc(x.baseline) + '</div>' : '')).join('') + '</td>'
      + '<td>' + badge(cap(t.anom.severity), sev[t.anom.severity]) + (t.dis ? ' ' + badge('Reviewed', 'pos') : '') + '</td>'
      + '<td>' + (SERVED() ? '<button class="btn ghost sm" type="button" data-dismiss="' + esc(t.id) + '">' + (t.dis ? 'Undo' : 'Looks fine') + '</button>' : '') + '</td></tr>').join('') + '</tbody>'
    : '<tbody><tr><td>' + empty('Nothing unusual in this period.') + '</td></tr></tbody>';
}

/* ======================================================================= *
 * Page: Compare
 * ======================================================================= */
function cmpPresetRanges(p) {
  const end = cover().to, lastFull = isCompleteMonth(end.slice(0, 7)) ? end.slice(0, 7) : prevMonth(end.slice(0, 7));
  const M = ym => [ym + '-01', monthEnd(ym)];
  if (p === 'mom') { const a = end.slice(0, 7); return [[a + '-01', end], [prevMonth(a) + '-01', shiftEnd(end, -1)]]; }
  if (p === 'lastfull') return [M(lastFull), M(prevMonth(lastFull))];
  if (p === 'yoy') return [M(lastFull), M(addMonths(lastFull + '-01', -12).slice(0, 7))];
  if (p === 'q') { const a0 = addMonths(lastFull + '-01', -2); return [[a0, monthEnd(lastFull)], [addMonths(a0, -3), addDays(a0, -1)]]; }
  if (p === 'ytd') { const y = end.slice(0, 4); return [[y + '-01-01', end], [(+y - 1) + '-01-01', shiftEnd(end, -12)]]; }
  return [[S.cmp.aFrom, S.cmp.aTo], [S.cmp.bFrom, S.cmp.bTo]];
}
function coverage(a, b) { const c = cover(); const f = a > c.from ? a : c.from, t = b < c.to ? b : c.to; return f <= t ? daysBetween(f, t) + 1 : 0; }
function renderCompare() {
  if (S.cmp.preset !== 'custom') { const [A, B] = cmpPresetRanges(S.cmp.preset); [S.cmp.aFrom, S.cmp.aTo, S.cmp.bFrom, S.cmp.bTo] = [A[0], A[1], B[0], B[1]]; }
  const c = S.cmp, opt = (v, l) => '<option value="' + v + '"' + (c.preset === v ? ' selected' : '') + '>' + l + '</option>';
  $('#cmpControls').innerHTML = '<label>Compare<select class="sel" id="cmpPreset">' + opt('mom', 'Latest month vs previous (same days)') + opt('lastfull', 'Last full month vs the one before') + opt('yoy', 'Last full month vs same month last year') + opt('q', 'Last 3 full months vs previous 3') + opt('ytd', 'This year so far vs same period last year') + opt('custom', 'Custom…') + '</select></label>'
    + '<label>Period A from<input class="inp" type="date" id="cmpAF" value="' + c.aFrom + '"></label><label>Period A to<input class="inp" type="date" id="cmpAT" value="' + c.aTo + '"></label>'
    + '<label>Period B from<input class="inp" type="date" id="cmpBF" value="' + c.bFrom + '"></label><label>Period B to<input class="inp" type="date" id="cmpBT" value="' + c.bTo + '"></label>'
    + '<label>Scale<select class="sel" id="cmpNorm"><option value="1"' + (c.norm ? ' selected' : '') + '>Per 30 days (fair when lengths differ)</option><option value="0"' + (c.norm ? '' : ' selected') + '>Actual totals</option></select></label>';
  $('#cmpPreset').onchange = e => { c.preset = e.target.value; renderCompare(); };
  for (const [id, k] of [['cmpAF', 'aFrom'], ['cmpAT', 'aTo'], ['cmpBF', 'bFrom'], ['cmpBT', 'bTo']]) $('#' + id).onchange = e => { c[k] = e.target.value; c.preset = 'custom'; renderCompare(); };
  $('#cmpNorm').onchange = e => { c.norm = e.target.value === '1'; renderCompare(); };
  if (!(c.aFrom && c.aTo && c.bFrom && c.bTo)) { $('#cmpSummary').innerHTML = '<tbody><tr><td>' + empty('Pick both periods.') + '</td></tr></tbody>'; return; }
  const A = { from: c.aFrom <= c.aTo ? c.aFrom : c.aTo, to: c.aFrom <= c.aTo ? c.aTo : c.aFrom }, B = { from: c.bFrom <= c.bTo ? c.bFrom : c.bTo, to: c.bFrom <= c.bTo ? c.bTo : c.bFrom };
  const dA = daysBetween(A.from, A.to) + 1, dB = daysBetween(B.from, B.to) + 1, cA = coverage(A.from, A.to), cB = coverage(B.from, B.to);
  const covA = Math.min(cA, dA), covB = Math.min(cB, dB);
  const warn = [];
  if (covA < dA) warn.push('Period A only has statement data for ' + covA + ' of ' + dA + ' days.');
  if (covB < dB) warn.push('Period B only has statement data for ' + covB + ' of ' + dB + ' days.');
  $('#cmpCoverage').innerHTML = warn.length ? '<div class="callout warn">' + warn.join(' ') + (c.norm ? ' Figures are scaled per 30 days of data to keep it fair.' : ' Switch Scale to "Per 30 days" for a fair comparison.') + '</div>' : '';
  const rA = TX.filter(t => inAccount(t) && inRange(t, A)), rB = TX.filter(t => inAccount(t) && inRange(t, B));
  const sA = summarize(rA), sB = summarize(rB), fA = c.norm && covA ? 30 / covA : 1, fB = c.norm && covB ? 30 / covB : 1;
  $('#cmpSub').textContent = 'A: ' + fmtDate(A.from) + ' – ' + fmtDate(A.to) + ' · B: ' + fmtDate(B.from) + ' – ' + fmtDate(B.to) + (c.norm ? ' · per 30 days' : '');
  const row = (l, a, b, goodUp, isPct) => {
    const d = a == null || b == null ? null : a - b;
    const p = d != null && !isPct && b > 0 && a >= 0 ? (d / b * 100) : null;
    const cls = d == null || Math.abs(d) < .5 || goodUp == null ? '' : (d > 0) === goodUp ? 'pos' : 'neg';
    const fmt = v => v == null ? '—' : isPct ? pct(v, 1) : inr(v);
    return '<tr><td>' + l + '</td><td class="r">' + fmt(a) + '</td><td class="r">' + fmt(b) + '</td><td class="r ' + cls + '">' + (d == null ? '—' : (d > 0 ? '↑ ' : d < 0 ? '↓ ' : '') + (isPct ? Math.abs(d).toFixed(1) + ' pts' : inr(Math.abs(d)))) + '</td><td class="r ' + cls + '">' + (p == null ? '—' : pct(Math.abs(p))) + '</td></tr>';
  };
  $('#cmpSummary').innerHTML = '<thead><tr><th>Metric</th><th class="r">Period A</th><th class="r">Period B</th><th class="r">Change</th><th class="r">%</th></tr></thead><tbody>'
    + row('Money in', sA.money_in * fA, sB.money_in * fB, true) + row('Earned income', sA.income * fA, sB.income * fB, true)
    + row('Spending (net)', sA.net_spending * fA, sB.net_spending * fB, false) + row('Invested', sA.invested * fA, sB.invested * fB, null)
    + row('Savings', sA.savings * fA, sB.savings * fB, true) + row('Savings rate', sA.savings_rate, sB.savings_rate, true, true)
    + row('Spending per day', covA ? sA.net_spending / covA : null, covB ? sB.net_spending / covB : null, false)
    + '<tr><td>Transactions</td><td class="r">' + sA.n + '</td><td class="r">' + sB.n + '</td><td class="r">—</td><td class="r">—</td></tr></tbody>';
  const ca = catSpend(rA), cb = catSpend(rB);
  const cats = Object.keys({ ...ca, ...cb }).map(k => ({ k, a: (ca[k] ? ca[k].spent - ca[k].refunds : 0) * fA, b: (cb[k] ? cb[k].spent - cb[k].refunds : 0) * fB })).filter(x => x.a || x.b).sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b));
  $('#cmpCats').innerHTML = cats.length ? '<thead><tr><th>Category</th><th class="r">Period A</th><th class="r">Period B</th><th class="r">Change</th><th class="r">%</th></tr></thead><tbody>' + cats.map(x => row(esc(catLabel(x.k)), x.a, x.b, false)).join('') + '</tbody>' : '<tbody><tr><td>' + empty('No spending in either period.') + '</td></tr></tbody>';
  // weekday vs weekend for period A
  let wdN = 0, weN = 0; for (let d = A.from; d <= A.to; d = addDays(d, 1)) { if (d < cover().from || d > cover().to) continue; ((D(d).getUTCDay() + 6) % 7 >= 5) ? weN++ : wdN++; }
  const sp = rA.filter(t => t.kind === 'expense' && t.dir === 'debit'), we = sum(sp.filter(t => (D(t.date).getUTCDay() + 6) % 7 >= 5), t => t.amt), wd = sum(sp, t => t.amt) - we;
  const wdA = wdN ? wd / wdN : 0, weA = weN ? we / weN : 0;
  $('#cmpWeek').innerHTML = (wdN + weN) ? '<div class="stats">' + statBox('Weekday', inr(wdA) + '/day', wdN + ' days') + statBox('Weekend', inr(weA) + '/day', weN + ' days') + statBox('Difference', wdA ? (weA >= wdA ? '↑ ' : '↓ ') + pct(Math.abs(weA - wdA) / wdA * 100) : '—', 'weekend vs weekday') + '</div><div class="note">Period A, spending only.</div>' : empty('No data in period A.');
  renderH2H();
}
function renderH2H() {
  const h = S.h2h, isCat = h.type === 'category';
  const sp = TX.filter(t => inAccount(t) && t.kind === 'expense' && t.dir === 'debit');
  const tot = {}; sp.forEach(t => { const k = isCat ? t.cat : t.merchant; tot[k] = (tot[k] || 0) + t.amt; });
  const opts = Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 60).map(x => x[0]);
  if (!opts.includes(h.a)) h.a = opts[0] || ''; if (!opts.includes(h.b) || h.b === h.a) h.b = opts.find(o => o !== h.a) || '';
  const sel = (id, v) => '<select class="sel" id="' + id + '">' + opts.map(o => '<option value="' + esc(o) + '"' + (o === v ? ' selected' : '') + '>' + esc(isCat ? catLabel(o) : o) + '</option>').join('') + '</select>';
  $('#h2hControls').innerHTML = '<label>Compare<select class="sel" id="h2hType"><option value="category"' + (isCat ? ' selected' : '') + '>Categories</option><option value="merchant"' + (isCat ? '' : ' selected') + '>Merchants</option></select></label><label>First' + sel('h2hA', h.a) + '</label><label>Second' + sel('h2hB', h.b) + '</label>';
  $('#h2hType').onchange = e => { h.type = e.target.value; h.a = h.b = ''; renderH2H(); };
  $('#h2hA').onchange = e => { h.a = e.target.value; renderH2H(); };
  $('#h2hB').onchange = e => { h.b = e.target.value; renderH2H(); };
  const r = effective(range()); if (!r || !h.a) { chartEmpty('h2hChart'); return; }
  const ms = monthsIn(r.from, r.to).slice(-24), bm = byMonth(sp.filter(t => inRange(t, r)));
  const val = (m, k) => sum((bm[m] || []).filter(t => (isCat ? t.cat : t.merchant) === k), t => t.amt);
  const pal = palette();
  chart('h2hChart', { type: 'line', data: { labels: ms.map(fmtMonthShort), datasets: [h.a, h.b].filter(Boolean).map((k, i) => ({ label: isCat ? catLabel(k) : k, data: ms.map(m => val(m, k)), borderColor: pal[i ? 3 : 0], backgroundColor: 'transparent', tension: .25, borderWidth: 2, pointRadius: 2 })) },
    options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: true }, tooltip: tipMoney }, scales: { x: { grid: { display: false } }, y: { ticks: moneyTicks } } } });
}

/* ======================================================================= *
 * Page: Counterparties (two searches: by name, and by phone / UPI handle)
 * ======================================================================= */
function renderCounterparties() {
  const r = effective(range());
  const rows = r ? TX.filter(t => inAccount(t) && inRange(t, r) && inView(t) && t.kind !== 'reversed') : [];
  const g = {};
  for (const t of rows) { const x = g[t.merchant] = g[t.merchant] || { o: 0, i: 0, n: 0, raw: '' }; x[t.dir === 'credit' ? 'i' : 'o'] += t.amt; x.n++; x.raw += ' ' + t.desc; }
  const q = S.cpq.trim().toLowerCase(), qn = S.cpNum.trim().toLowerCase();
  const list = Object.entries(g).filter(([k, v]) => (!q || k.toLowerCase().includes(q)) && (!qn || v.raw.toLowerCase().includes(qn)))
    .sort((a, b) => (b[1].o + b[1].i) - (a[1].o + a[1].i)).slice(0, 24);
  $('#cpSub').textContent = Object.keys(g).length.toLocaleString('en-IN') + ' people & merchants in this view' + (q || qn ? ' · ' + list.length + ' shown' : ' · top 24 by money moved') + ' · click one for details'
    + (qn && !list.length ? '. Tip: own-account transfers are hidden by the View filter, and the period may exclude older payments.' : '');
  $('#cpGrid').innerHTML = list.map(([k, v]) => {
    const net = v.i - v.o;
    return '<button type="button" class="cp-tile" aria-pressed="' + (S.cp === k) + '" data-cp="' + esc(k) + '"><div class="n" title="' + esc(k) + '">' + esc(k) + '</div><div class="v ' + (net >= 0 ? 'pos' : 'neg') + '">' + signedInr(net) + ' net</div><div class="s">in ' + inr(v.i) + ' · out ' + inr(v.o) + ' · ' + v.n + ' txns</div></button>';
  }).join('') || '<div style="grid-column:1/-1">' + empty('No matches.') + '</div>';
  renderDrill(r);
}
function renderDrill(r) {
  const d = $('#drill');
  if (!S.cp) { d.hidden = true; return; }
  d.hidden = false;
  const rows = TX.filter(t => t.merchant === S.cp && inAccount(t) && (!r || inRange(t, r)) && t.kind !== 'reversed');
  const inn = sum(rows.filter(t => t.dir === 'credit'), t => t.amt), out = sum(rows.filter(t => t.dir === 'debit'), t => t.amt);
  $('#drillTitle').textContent = S.cp + ' · ' + rows.length + ' transactions';
  $('#drillStats').innerHTML = statBox('They paid you', inr(inn), '', inn ? 'pos' : '') + statBox('You paid them', inr(out), '', out ? 'neg' : '') + statBox('Net', signedInr(inn - out), '', inn - out >= 0 ? 'pos' : 'neg') + statBox('Average', inr((inn + out) / Math.max(1, rows.length)), 'per transaction')
    + '<div class="stat"><div class="l">Transactions</div><button class="btn link" type="button" id="drillTx">View all →</button></div>';
  $('#drillTx').onclick = () => { resetTx(); S.tx.merchant = S.cp; S.tx.kind = rows.length && rows[0].kind === 'p2p' ? 'p2p' : 'All'; go('transactions'); };
  const bm = byMonth(rows), ms = Object.keys(bm).sort();
  chart('drillChart', { type: 'bar', data: { labels: ms.map(fmtMonthShort), datasets: [
    { label: 'In', data: ms.map(m => sum(bm[m].filter(t => t.dir === 'credit'), t => t.amt)), backgroundColor: css('--chart-pos'), stack: 's', borderRadius: 2 },
    { label: 'Out', data: ms.map(m => -sum(bm[m].filter(t => t.dir === 'debit'), t => t.amt)), backgroundColor: css('--chart-neg'), stack: 's', borderRadius: 2 }] },
    options: { plugins: { legend: { display: true }, tooltip: { callbacks: { label: c => ' ' + c.dataset.label + ': ' + inr(Math.abs(c.parsed.y)) } } }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: v => inrShort(Math.abs(v)) } } } } });
}

/* ======================================================================= *
 * Pages: Budget + Goals (values come from rules.py)
 * ======================================================================= */
function renderBudget() {
  const B = META.budgets || {}, cats = Object.keys(B), r = effective(range());
  const ex = META.budgetsAreExamples ? ' <span class="example-tag">Example values</span>' : '';
  if (!cats.length || !r) { $('#budget').innerHTML = empty('Set BUDGETS in rules.py, then Re-import.'); return; }
  const months = Math.max(1, r.days / 30.4375), single = r.kind === 'month';
  const act = catSpend(rowsIn(r, true));
  $('#budgetSub').innerHTML = (single ? fmtMonth(r.from.slice(0, 7)) : 'Average per month over ' + months.toFixed(1) + ' months') + ex;
  $('#budget').innerHTML = (META.budgetsAreExamples ? '<div class="callout warn" style="margin-bottom:10px">These budgets are placeholder examples. Set your own in rules.py (BUDGETS) and change BUDGETS_ARE_EXAMPLES to False.</div>' : '')
    + '<div class="row-list">' + cats.map(c => {
      const a = act[c] ? (act[c].spent - act[c].refunds) / (single ? 1 : months) : 0, b = B[c], over = a > b;
      return '<div><div class="k" style="flex:1"><div class="t">' + esc(catLabel(c)) + '</div><div class="bar"><span style="width:' + Math.min(100, b ? a / b * 100 : 0).toFixed(1) + '%;background:' + (over ? 'var(--chart-neg)' : 'var(--chart-pos)') + '"></span></div></div><div class="v"><b class="' + (over ? 'neg' : '') + '">' + inr(a) + '</b> <span class="muted">/ ' + inr(b) + '</span><div class="small ' + (over ? 'neg' : 'muted') + '">' + (over ? 'over by ' + inr(a - b) : inr(b - a) + ' left') + '</div></div></div>';
    }).join('') + '</div>';
}
function renderGoals() {
  const G = META.goals || [];
  $('#goalsSub').innerHTML = 'Progress you entered in rules.py (GOALS)' + (META.goalsAreExamples ? ' <span class="example-tag">Example values</span>' : '');
  if (!G.length) { $('#goals').innerHTML = empty('Set GOALS in rules.py, then Re-import.'); return; }
  $('#goals').innerHTML = (META.goalsAreExamples ? '<div class="callout warn" style="margin-bottom:10px">These goals are placeholder examples, not your data. Edit GOALS in rules.py and set GOALS_ARE_EXAMPLES = False.</div>' : '')
    + '<div class="row-list">' + G.map(g => {
      const p = g.target ? Math.min(100, g.saved / g.target * 100) : 0, left = g.monthly ? Math.max(0, Math.ceil((g.target - g.saved) / g.monthly)) : null;
      return '<div><div class="k" style="flex:1"><div class="t">' + esc(g.name) + '</div><div class="bar"><span style="width:' + p.toFixed(1) + '%"></span></div><div class="d">' + inr(g.saved) + ' of ' + inr(g.target) + ' · ' + pct(p) + (left != null ? ' · about ' + left + ' months at ' + inr(g.monthly) + '/mo' : '') + '</div></div></div>';
    }).join('') + '</div>';
}

/* ======================================================================= *
 * Page: Ask — deterministic answers from your data. The optional AI step only
 * rephrases/explains the SAME computed summary, after explicit consent.
 * ======================================================================= */
const CAT_WORDS = [
  [/food deliver|takeaway|swiggy|zomato|restaurant|dining|eat(ing)? out/, ['dining']], [/grocer|blinkit|zepto|dmart/, ['groceries']],
  [/\bfood\b/, ['dining', 'groceries']], [/travel|train|flight|irctc|hotel/, ['travel']], [/\brent\b|housing/, ['rent']],
  [/shopping|amazon|flipkart|cloth/, ['shopping']], [/fuel|petrol|diesel/, ['fuel']], [/cab|taxi|uber|ola|metro|transport|commute/, ['transport']],
  [/bill|utilit|electric/, ['utilities', 'phone_internet']], [/phone|mobile|recharge|internet|broadband/, ['phone_internet']],
  [/subscription|netflix|spotify|ott/, ['subscriptions']], [/insurance|premium/, ['insurance']], [/\bemi\b|loan/, ['loan_emi']],
  [/credit card|card bill|\bcred\b/, ['credit_card_payment']], [/\bcash\b|atm/, ['cash_withdrawal']], [/health|medic|pharma|doctor|hospital/, ['health']],
  [/movie|entertain/, ['entertainment']], [/educat|course|exam|fee/, ['education']], [/invest|\bsip\b|mutual fund|stock/, ['investment_sip', 'investment', 'fixed_deposit']],
  [/tax/, ['taxes']], [/charges|bank fee/, ['bank_charges']],
];
const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12 };
function askPeriod(q) {
  const end = cover().to, y = end.slice(0, 4), cm = end.slice(0, 7);
  const lastFull = isCompleteMonth(cm) ? cm : prevMonth(cm);
  let m;
  if (/this month/.test(q)) return { from: cm + '-01', to: end, label: fmtMonth(cm) + (isCompleteMonth(cm) ? '' : ' (to ' + fmtDate(end) + ')') };
  if (/last month|previous month/.test(q)) { const p = prevMonth(cm); return { from: p + '-01', to: monthEnd(p), label: fmtMonth(p) }; }
  if ((m = q.match(/last (\d+|one|two|three|four|five|six|twelve) months?/))) {
    const n = NUMW[m[1]] || +m[1], from = addMonths(lastFull + '-01', -(n - 1));
    return { from, to: monthEnd(lastFull), label: 'the last ' + n + ' full months (' + fmtMonthShort(from.slice(0, 7)) + '–' + fmtMonthShort(lastFull) + ')', months: n };
  }
  if (/this year/.test(q)) return { from: y + '-01-01', to: end, label: y + ' so far' };
  if (/last year/.test(q)) return { from: (+y - 1) + '-01-01', to: (+y - 1) + '-12-31', label: String(+y - 1) };
  const mi = MON.findIndex(n => new RegExp('\\b' + n.toLowerCase() + '[a-z]*\\b').test(q));
  const yr = (q.match(/\b(20\d\d)\b/) || [])[1];
  if (mi >= 0) { let yy = yr || y; let ym = yy + '-' + String(mi + 1).padStart(2, '0'); if (!yr && ym > cm) ym = (+y - 1) + ym.slice(4); return { from: ym + '-01', to: monthEnd(ym), label: fmtMonth(ym) }; }
  if (yr) return { from: yr + '-01-01', to: yr + '-12-31', label: yr };
  const r = effective(range());
  return r ? { from: r.from, to: r.to, label: r.label } : null;
}
function answer(qRaw) {
  const q = qRaw.toLowerCase().replace(/[₹,]/g, ''), per = askPeriod(q);
  if (!per) return { text: 'There is no data for the selected account and period.' };
  const rows = TX.filter(t => inAccount(t) && inRange(t, per)), s = summarize(rows);
  const res = { period: per.label, text: '', rows: [], ctx: { period: per.label, account: S.account === 'All' ? 'all accounts' : acctLabel(S.account) } };
  const table = list => list.slice(0, 10);
  let m;
  if (/compare/.test(q)) {
    const n = per.months || 3, ms = monthsIn(per.from, per.to).slice(-n), bm = byMonth(rows);
    const lines = ms.map(x => { const y = summarize(bm[x] || []); return { m: fmtMonth(x), income: y.income, spending: y.net_spending, saved: y.savings, rate: y.savings_rate }; });
    res.html = '<table><thead><tr><th>Month</th><th class="r">Earned income</th><th class="r">Spending (net)</th><th class="r">Saved</th><th class="r">Rate</th></tr></thead><tbody>' + lines.map(l => '<tr><td>' + l.m + '</td><td class="r">' + inr(l.income) + '</td><td class="r">' + inr(l.spending) + '</td><td class="r ' + (l.saved >= 0 ? 'pos' : 'neg') + '">' + signedInr(l.saved) + '</td><td class="r">' + pct(l.rate, 1) + '</td></tr>').join('') + '</tbody></table>';
    res.text = 'Month by month. Saved = earned income − spending net of refunds.'; res.ctx.months = lines; return res;
  }
  if (/why/.test(q) && /(spend|expens|cost)/.test(q)) {
    const cur = monthsIn(per.from, per.to), curM = cur[cur.length - 1], pM = prevMonth(curM);
    const a = catSpend(TX.filter(t => inAccount(t) && t.ym === curM)), b = catSpend(TX.filter(t => inAccount(t) && t.ym === pM));
    const mv = Object.keys({ ...a, ...b }).map(c => ({ c, d: (a[c] ? a[c].spent - a[c].refunds : 0) - (b[c] ? b[c].spent - b[c].refunds : 0) })).sort((x, y) => y.d - x.d).filter(x => x.d > 0).slice(0, 5);
    const ta = summarize(TX.filter(t => inAccount(t) && t.ym === curM)).net_spending, tb = summarize(TX.filter(t => inAccount(t) && t.ym === pM)).net_spending;
    res.period = fmtMonth(curM) + ' vs ' + fmtMonth(pM);
    res.text = 'Spending was ' + inr(ta) + ' in ' + fmtMonth(curM) + ' vs ' + inr(tb) + ' in ' + fmtMonth(pM) + ' (' + signedInr(ta - tb) + ').' + (mv.length ? ' The biggest increases:' : ' No category went up.');
    res.html = mv.length ? '<div class="row-list">' + mv.map(x => '<div><div class="k"><div class="t">' + esc(catLabel(x.c)) + '</div></div><div class="v neg">↑ ' + inr(x.d) + '</div></div>').join('') + '</div>' : '';
    res.ctx.change = { current: ta, previous: tb, increases: mv.map(x => ({ category: catLabel(x.c), increase: round2(x.d) })) };
    if (!isCompleteMonth(curM)) res.text += ' Note: ' + fmtMonth(curM) + ' is not complete yet.';
    return res;
  }
  if ((m = q.match(/(above|over|more than|greater than|exceeding|bigger than|>)\s*(\d+(?:\.\d+)?)\s*(k|thousand|lakh|lac|l)?\b/))) {
    const n = +m[2] * ({ k: 1e3, thousand: 1e3, lakh: 1e5, lac: 1e5, l: 1e5 }[m[3]] || 1);
    const wantIn = /income|credit|received|got|in\b/.test(q) && !/spent|paid|expens/.test(q);
    const list = rows.filter(t => t.amt > n && t.kind !== 'reversed' && (wantIn ? t.dir === 'credit' : t.dir === 'debit')).sort((a, b) => b.amt - a.amt);
    res.text = list.length + ' transaction' + (list.length === 1 ? '' : 's') + (wantIn ? ' in' : ' out') + ' above ' + inr(n) + ', totalling ' + inr(sum(list, t => t.amt)) + '.';
    res.rows = table(list); res.more = list.length > 10 ? { tx: { min: String(n), dir: wantIn ? 'credit' : 'debit' } } : null; res.ctx.matches = list.length; return res;
  }
  if (/subscription|recurring|repeat|standing/.test(q)) {
    const act = recurringSeries().filter(x => x.active), subs = /subscription/.test(q) ? act.filter(x => ['subscriptions', 'phone_internet', 'utilities'].includes(x.category)) : act;
    const list = subs.length ? subs : act;
    res.period = 'detected across all your data';
    res.text = list.length ? list.length + ' active ' + (subs.length && /subscription/.test(q) ? 'subscriptions/bills' : 'recurring payments') + ', about ' + inr(sum(list, x => x.monthly_cost)) + ' a month (' + inr(sum(list, x => x.annual_cost)) + ' a year). Next dates are estimates.' : 'No active recurring payments detected.';
    res.html = list.length ? '<div class="row-list">' + list.map(x => '<div><div class="k"><div class="t">' + esc(x.merchant) + '</div><div class="d">' + esc(catLabel(x.category)) + ' · ' + x.frequency + ' · next ~' + fmtDate(x.next_estimate) + '</div></div><div class="v">' + inr(x.typical) + '</div></div>').join('') + '</div>' : '';
    res.ctx.recurring = list.map(x => ({ payee: x.merchant, category: catLabel(x.category), frequency: x.frequency, amount: x.typical, monthly: x.monthly_cost }));
    return res;
  }
  if (/unusual|anomal|suspicious|strange|odd|flagged/.test(q)) {
    const rank = { high: 3, medium: 2, low: 1 }, list = rows.filter(t => t.anom && !t.dis).sort((a, b) => rank[b.anom.severity] - rank[a.anom.severity] || b.amt - a.amt);
    res.text = list.length ? list.length + ' unreviewed unusual transactions. Largest first, with the reason each was flagged:' : 'Nothing unusual flagged in this period.';
    res.html = list.length ? '<div class="row-list">' + list.slice(0, 8).map(t => '<div class="click" data-id="' + esc(t.id) + '"><div class="k"><div class="t">' + esc(t.merchant) + ' · ' + fmtDate(t.date) + '</div><div class="d">' + esc(t.anom.reasons[0].reason) + '</div></div><div class="v">' + inr(t.amt) + '</div></div>').join('') + '</div>' : '';
    res.ctx.unusual = list.slice(0, 10).map(t => ({ date: t.date, payee: t.merchant, amount: t.amt, reason: t.anom.reasons[0].reason }));
    return res;
  }
  if (/sav(e|ed|ing)/.test(q)) {
    res.text = s.income > 0 ? 'You saved ' + inr(s.savings) + ': earned income ' + inr(s.income) + ' − spending ' + inr(s.net_spending) + ' (net of ' + inr(s.refunds) + ' refunds). Savings rate ' + pct(s.savings_rate, 1) + '.' + (s.invested > 0 ? ' Of that, ' + inr(s.invested) + ' went into investments.' : '')
      : 'No earned income was identified in this period, so a savings figure would be misleading. Spending was ' + inr(s.net_spending) + '.';
    res.ctx.summary = { income: s.income, spending: s.net_spending, refunds: s.refunds, savings: s.savings, savings_rate: s.savings_rate, invested: s.invested };
    return res;
  }
  if (/where .*(money|go)|what did i spend|top categor|biggest categor|breakdown/.test(q)) {
    const cs = Object.entries(catSpend(rows)).map(([c, v]) => [c, v.spent - v.refunds]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
    const tot = sum(cs, x => x[1]);
    res.text = cs.length ? 'You spent ' + inr(tot) + ' (net of refunds). Most of it went to ' + cs.slice(0, 3).map(x => catLabel(x[0]) + ' (' + pct(x[1] / tot * 100) + ')').join(', ') + '.' : 'No spending in this period.';
    res.html = cs.length ? '<div class="row-list">' + cs.slice(0, 8).map(x => '<div class="click" data-cat="' + esc(x[0]) + '"><div class="k" style="flex:1"><div class="t">' + esc(catLabel(x[0])) + '</div><div class="bar"><span style="width:' + (x[1] / cs[0][1] * 100).toFixed(1) + '%"></span></div></div><div class="v">' + inr(x[1]) + '<div class="small muted">' + pct(x[1] / tot * 100) + '</div></div></div>').join('') + '</div>' : '';
    res.ctx.categories = cs.slice(0, 10).map(x => ({ category: catLabel(x[0]), net_spent: round2(x[1]) }));
    return res;
  }
  if (/salary|income|earn/.test(q)) {
    const sal = rows.filter(t => t.cat === 'salary' && t.kind === 'income');
    res.text = 'Earned income ' + inr(s.income) + ', of which salary ' + inr(sum(sal, t => t.amt)) + ' (' + sal.length + ' credits). Refunds (' + inr(s.refunds) + '), transfers from your own accounts and money from people are not counted as income.';
    res.rows = table(sal.sort((a, b) => b.date < a.date ? -1 : 1)); res.ctx.summary = { income: s.income, salary: sum(sal, t => t.amt), refunds: s.refunds };
    return res;
  }
  if (/largest|biggest|top \d*\s*(transaction|expense|payment|spend)/.test(q)) {
    const list = rows.filter(t => t.dir === 'debit' && t.kind !== 'reversed').sort((a, b) => b.amt - a.amt);
    res.text = 'Your largest payments out.'; res.rows = table(list); res.ctx.largest = list.slice(0, 10).map(t => ({ date: t.date, payee: t.merchant, amount: t.amt, category: catLabel(t.cat) }));
    return res;
  }
  if (/balance/.test(q)) {
    const b = totalBalAt(per.to);
    res.text = b ? 'Balance on ' + fmtDate(per.to) + ': ' + inr(b.total) + ' (' + accountsInScope().map(a => acctLabel(a) + ' ' + inr(balAt(a, per.to))).join(', ') + '), from your statements\' running balance.' : 'No balance data for that date.';
    return res;
  }
  if ((m = q.match(/(?:spen[dt]|pay|paid|cost|expense[sd]?)\b.*?\b(?:on|for|at|to)\s+(.+?)(?:\s+(?:this|last|in|during|for)\b.*)?$/)) || (m = q.match(/how much .*?\b(?:on|for|at)\s+(.+?)(?:\s+(?:this|last|in|during)\b.*)?$/))) {
    const what = m[1].trim().replace(/[?.!]+$/, '');
    const hit = CAT_WORDS.find(([re]) => re.test(what));
    let list, label;
    if (hit) { list = rows.filter(t => hit[1].includes(t.cat) && (t.kind === 'expense' || t.kind === 'refund' || t.kind === 'investment')); label = hit[1].map(catLabel).join(' + '); }
    else { list = rows.filter(t => t.merchant.toLowerCase().includes(what) && t.kind !== 'reversed'); label = '"' + what + '"'; }
    const out = sum(list.filter(t => t.dir === 'debit'), t => t.amt), back = sum(list.filter(t => t.dir === 'credit'), t => t.amt);
    res.text = list.length ? 'You spent ' + inr(out) + ' on ' + label + ' in ' + list.filter(t => t.dir === 'debit').length + ' payments' + (back ? ', with ' + inr(back) + ' back as refunds (net ' + inr(out - back) + ')' : '') + '.' : 'No payments matching ' + label + ' in this period.';
    res.rows = table(list.filter(t => t.dir === 'debit').sort((a, b) => b.amt - a.amt));
    res.more = list.length > 10 ? { tx: hit ? (hit[1].length === 1 ? { cat: hit[1][0] } : {}) : { merchant: what } } : null;
    res.ctx.match = { what: label, spent: round2(out), refunds: round2(back), payments: list.length };
    return res;
  }
  res.text = 'I can answer questions like the examples below, using only your transactions. Try naming a category, a merchant, an amount or a period.';
  res.help = true;
  return res;
}
const ASK_EXAMPLES = ['Where did most of my money go this month?', 'Why did my expenses increase?', 'Show all transactions above 10000', 'How much did I spend on food delivery last month?', 'Which subscriptions can I review?', 'Compare my last three months', 'What were my largest unusual transactions?', 'How much money did I save this month?'];
let AI = { on: false, model: '' };
function renderAsk() {
  $('#askSugg').innerHTML = ASK_EXAMPLES.map(x => '<button class="chip" type="button" data-q="' + esc(x) + '">' + esc(x) + '</button>').join('');
}
function runAsk(q) {
  const a = answer(q);
  $('#askInput').value = q;
  $('#askOut').innerHTML = '<div class="q">' + esc(q) + '</div><div>' + esc(a.text) + '</div>' + (a.html || '')
    + (a.rows && a.rows.length ? '<div class="row-list" style="margin-top:8px">' + a.rows.map(t => txLine(t)).join('') + '</div>' : '')
    + (a.more ? '<div style="margin-top:6px"><button class="btn link" type="button" id="askMore">See all in Transactions →</button></div>' : '')
    + (a.period ? '<div class="note">Period: ' + esc(a.period) + ' · ' + esc(S.account === 'All' ? 'all accounts' : acctLabel(S.account)) + ' · computed directly from your transactions</div>' : '');
  if ($('#askMore')) $('#askMore').onclick = () => { resetTx(); Object.assign(S.tx, a.more.tx); go('transactions'); };
  const box = $('#aiBox');
  if (!AI.on || a.help) { box.hidden = !SERVED(); box.innerHTML = SERVED() ? '<span class="muted small">AI explanations are off. They need an API key configured on the Mac running serve.py (see README). The answers above don\'t use AI.</span>' : ''; return; }
  box.hidden = false;
  box.innerHTML = '<label class="small"><input type="checkbox" id="aiConsent"> Send this question and the summary figures above (no account numbers, no raw statements) to Anthropic (' + esc(AI.model) + ') for a plain-language explanation.</label><div style="margin-top:8px"><button class="btn ghost sm" type="button" id="aiGo" disabled>Explain with AI</button></div><div id="aiAns" style="margin-top:8px"></div>';
  $('#aiConsent').onchange = e => { $('#aiGo').disabled = !e.target.checked; };
  $('#aiGo').onclick = async () => {
    $('#aiGo').disabled = true; $('#aiAns').innerHTML = '<span class="muted">Asking…</span>';
    const ctx = Object.assign({}, a.ctx, { answer: a.text, rows: (a.rows || []).map(t => ({ date: t.date, payee: t.merchant, amount: t.amt, direction: t.dir, category: catLabel(t.cat) })) });
    try { const j = await api('/api/ask', { question: q, context: ctx, consent: true }); $('#aiAns').innerHTML = '<div style="white-space:pre-wrap">' + esc(j.answer) + '</div><div class="note">AI-generated from the summary above. Check it against the computed figures.</div>'; }
    catch (e) { $('#aiAns').innerHTML = '<span class="neg">' + esc(e.message) + '</span>'; }
    $('#aiGo').disabled = false;
  };
}

/* ======================================================================= *
 * Page: Settings & data
 * ======================================================================= */
function renderSettings() {
  const b = META.balances || {};
  const kv = (k, v) => '<div><div class="k"><div class="t">' + k + '</div></div><div class="v">' + v + '</div></div>';
  $('#setData').innerHTML = kv('Data period', esc(fmtDate(META.dataStart) + ' – ' + fmtDate(META.dataEnd)))
    + kv('Transactions', (META.total || 0).toLocaleString('en-IN'))
    + kv('Rows read from files', (META.parsedRows || 0).toLocaleString('en-IN') + ' <span class="small muted">(' + (META.duplicatesRemoved || 0) + ' duplicates removed)</span>')
    + kv('Failed payments excluded', (META.reversalPairs || 0) + ' pairs')
    + kv('Your category fixes', (META.overridden || 0) + ' transactions')
    + kv('Last rebuilt', esc(META.generated || '—'))
    + Object.keys(b).sort().map(a => kv(esc(acctLabel(a)), inr(b[a].balance, true) + '<div class="small muted">on ' + fmtDate(b[a].asof) + '</div>')).join('');
  const rc = META.reconcile || {};
  $('#setQuality').innerHTML = Object.keys(rc).sort().map(a => {
    const x = rc[a], br = x.breaks || [];
    return '<div class="callout ' + (br.length ? 'neg' : 'pos') + '" style="margin-bottom:8px"><b>' + esc(acctLabel(a)) + '</b>: ' + (br.length ? br.length + ' day(s) where the transactions don\'t match the bank\'s balance, so a row may be missing or duplicated: ' + br.slice(0, 5).map(z => fmtDate(z.date) + ' (expected ' + inr(z.expected, true) + ', bank says ' + z.printed.map(p => inr(p, true)).join(' / ') + ')').join('; ')
      : 'balances reconcile on all ' + x.days.toLocaleString('en-IN') + ' days (' + fmtDate(x.from) + ' – ' + fmtDate(x.to) + '). No missing or duplicate transactions.') + (x.rows_without_balance ? ' ' + x.rows_without_balance + ' rows have no balance column.' : '') + '</div>';
  }).join('') + ((META.files || []).some(f => f.skipped) ? '<div class="callout warn">Some rows couldn\'t be read: ' + META.files.filter(f => f.skipped).map(f => esc(f.name) + ' (' + f.skipped + ')').join(', ') + '. Details in the table below.</div>' : '') || empty('No balance data.');
  const files = META.files || [];
  $('#setFiles').innerHTML = '<thead><tr><th>File</th><th>Account</th><th>Period</th><th class="r">Rows</th><th>Unreadable rows</th><th></th></tr></thead><tbody>' + files.map(f =>
    '<tr><td class="t" style="word-break:break-all">' + esc(f.name) + '</td><td>' + esc((f.accounts || []).map(acctLabel).join(', ')) + '</td><td style="white-space:nowrap">' + (f.from ? fmtDate(f.from) + ' – ' + fmtDate(f.to) : '—') + '</td><td class="r">' + f.rows + '</td>'
    + '<td class="small">' + (f.skipped ? '<span class="warn">' + f.skipped + '</span> ' + esc((f.examples || []).join('; ')) : '<span class="muted">none</span>') + '</td>'
    + '<td>' + (f.deletable && SERVED() ? '<button class="btn ghost sm" type="button" data-del="' + esc(f.name) + '">Delete</button>' : '') + '</td></tr>').join('') + '</tbody>';
  const th = store.get('fd-theme', 'system');
  $('#setPrivacy').innerHTML = '<div class="row-list">'
    + '<div><div class="k"><div class="t">Show full account & reference numbers</div><div class="d">Off: long numbers show only their last 4 digits (••••1234). Search still works either way.</div></div><div class="v"><input type="checkbox" id="setReveal"' + (REVEAL ? ' checked' : '') + ' aria-label="Show full numbers"></div></div>'
    + '<div><div class="k"><div class="t">Theme</div></div><div class="v"><select class="sel" id="setTheme"><option value="system"' + (th === 'system' ? ' selected' : '') + '>Match system</option><option value="light"' + (th === 'light' ? ' selected' : '') + '>Light</option><option value="dark"' + (th === 'dark' ? ' selected' : '') + '>Dark</option></select></div></div>'
    + '<div><div class="k"><div class="t">AI explanations</div><div class="d">Optional. Off unless an API key is set on the Mac, and each question asks for consent.</div></div><div class="v">' + (SERVED() ? (AI.on ? badge('Available', 'pos') : badge('Off')) : badge('Server only')) + '</div></div>'
    + '<div><div class="k"><div class="t">Where your data lives</div><div class="d">finance.db and dashboard.html on this Mac. Uploaded statements are converted once; the password is never stored.</div></div></div>'
    + '</div>';
  const B = META.budgets || {};
  $('#setConfig').innerHTML = kv('Budget categories', Object.keys(B).length + (META.budgetsAreExamples ? ' <span class="example-tag">examples</span>' : ''))
    + kv('Goals', (META.goals || []).length + (META.goalsAreExamples ? ' <span class="example-tag">examples</span>' : ''))
    + kv('Card bills counted as', META.trackCardsSeparately ? 'transfers (card statements imported)' : 'spending (card line items not imported)')
    + kv('Account names', Object.entries(META.accountLabels || {}).map(([k, v]) => esc(v) + ' <span class="muted small">' + esc(k) + '</span>').join('<br>') || '—');
}

/* ======================================================================= *
 * Upload, toast, modal
 * ======================================================================= */
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3200); }
function modal(title, body, buttons) {
  $('#modalTitle').textContent = title; $('#modalBody').innerHTML = body;
  $('#modalFoot').innerHTML = (buttons || []).map((b, i) => '<button type="button" class="btn ' + (b.ghost ? 'ghost' : '') + '" data-mb="' + i + '">' + esc(b.label) + '</button>').join('');
  $$('#modalFoot [data-mb]').forEach(el => el.onclick = () => buttons[+el.dataset.mb].on());
  $('#modal').classList.add('on'); $('#scrim').classList.add('on');
  const first = $('#modalBody input') || $('#modalFoot .btn'); if (first) first.focus();
}
function closeModal() { $('#modal').classList.remove('on'); if (!$('#drawer').classList.contains('on')) $('#scrim').classList.remove('on'); }
let PENDING = null;
function pickFile() {
  if (META.demo) { modal('Demo mode', '<p>This is a read-only demo with made-up data. In the real app, this button uploads a bank statement (CSV, XLS or PDF), removes duplicates and checks the balances.</p>', [{ label: 'OK', on: closeModal }]); return; }
  if (!SERVED()) { modal('Add a statement', '<p>Uploading works when the dashboard runs through the local server:</p><p><code>cd ~/Downloads/finance-app && python3 serve.py</code></p>', [{ label: 'OK', on: closeModal }]); return; }
  $('#fileInput').value = ''; $('#fileInput').click();
}
async function onFile(f) {
  const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!['.csv', '.pdf', '.xls'].includes(ext)) { modal('Unsupported file', '<p>Please choose a <b>.csv</b>, <b>.pdf</b> or <b>.xls</b> bank statement.</p>', [{ label: 'OK', on: closeModal }]); return; }
  if (!f.size) { modal('Empty file', '<p>' + esc(f.name) + ' is empty.</p>', [{ label: 'OK', on: closeModal }]); return; }
  if (f.size > 18 * 1024 * 1024) { modal('File too large', '<p>Statements up to 18 MB are supported.</p>', [{ label: 'OK', on: closeModal }]); return; }
  const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(f); });
  PENDING = { name: f.name, data };
  if (ext === '.pdf') askPassword('');
  else sendUpload('');
}
function askPassword(err) {
  modal('PDF password', (err ? '<div class="callout neg">' + esc(err) + '</div>' : '') + '<label class="small">Password for ' + esc(PENDING.name) + ' (leave blank if it has none)<input class="inp" id="pdfPwd" type="password" autocomplete="off" style="width:100%;margin-top:4px"></label><div class="small muted">Used once to read the file, then discarded. Never stored or logged.</div>',
    [{ label: 'Cancel', ghost: true, on: () => { PENDING = null; closeModal(); } }, { label: 'Upload', on: () => sendUpload($('#pdfPwd').value) }]);
  $('#pdfPwd').onkeydown = e => { if (e.key === 'Enter') sendUpload(e.target.value); };
}
async function sendUpload(password) {
  modal('Adding statement', '<p>Reading ' + esc(PENDING.name) + ', checking for duplicates and reconciling balances…</p>', []);
  try {
    const j = await api('/api/upload', { name: PENDING.name, data: PENDING.data, password });
    PENDING = null;
    const brk = j.breaks ? Object.entries(j.breaks).filter(([, n]) => n) : [];
    modal(j.new ? 'Statement added' : 'Nothing new',
      '<p>' + (j.new ? '<b>' + j.new.toLocaleString('en-IN') + ' new transactions</b> added' : esc(j.message || 'No new transactions.')) + '</p>'
      + '<dl class="kv"><dt>Account</dt><dd>' + esc(j.accounts.map(acctLabel).join(', ')) + '</dd><dt>Period</dt><dd>' + fmtDate(j.from) + ' – ' + fmtDate(j.to) + '</dd><dt>Read</dt><dd>' + j.parsed + ' transactions</dd><dt>Already imported</dt><dd>' + j.duplicates + ' (skipped, not double-counted)</dd>'
      + (j.skipped ? '<dt>Unreadable rows</dt><dd class="warn">' + j.skipped + ' — ' + esc((j.skippedExamples || []).join('; ')) + '</dd>' : '') + '</dl>'
      + (j.new ? (brk.length ? '<div class="callout warn">Balance check: ' + brk.map(([a, n]) => esc(acctLabel(a)) + ' has ' + n + ' day(s) that don\'t reconcile').join(', ') + '. See Settings → Data quality.</div>' : '<div class="callout pos">Balance check passed: the transactions match the bank\'s running balance.</div>') : ''),
      [{ label: j.new ? 'Show updated dashboard' : 'OK', on: () => { closeModal(); if (j.new) { saveState(); location.reload(); } } }]);
  } catch (e) {
    if (e.data && e.data.needPassword) askPassword(e.message);
    else modal('Couldn\'t add this statement', '<div class="callout neg">' + esc(e.message) + '</div>', [{ label: 'OK', on: () => { PENDING = null; closeModal(); } }]);
  }
}

/* ======================================================================= *
 * Router + controls
 * ======================================================================= */
const NAV = [
  [null, [['overview', 'Overview', 'home'], ['transactions', 'Transactions', 'list']]],
  ['Analyse', [['cashflow', 'Cash flow', 'flow'], ['income', 'Income', 'income'], ['spending', 'Spending', 'spend'], ['recurring', 'Recurring & bills', 'repeat'], ['insights', 'Insights & alerts', 'spark'], ['compare', 'Compare', 'compare']]],
  ['People', [['counterparties', 'Counterparties', 'users']]],
  ['Plan', [['budget', 'Budget', 'wallet'], ['goals', 'Goals', 'target']]],
  ['Tools', [['ask', 'Ask', 'chat'], ['settings', 'Settings & data', 'gear']]],
];
const ROUTES = Object.fromEntries(NAV.flatMap(g => g[1]).map(r => [r[0], r[1]]));
const ALIASES = { analytics: 'spending' };   // old bookmarks
const PAGES = {
  overview: renderOverview, transactions: renderTransactions, cashflow: renderCashflow, income: renderIncome, spending: renderSpending,
  recurring: renderRecurring, insights: renderInsightsPage, compare: renderCompare, counterparties: renderCounterparties,
  budget: renderBudget, goals: renderGoals, ask: renderAsk, settings: renderSettings,
};
function go(route) {
  route = ALIASES[route] || route;
  if (!ROUTES[route]) route = 'overview';
  S.route = route;
  closeDrawer(); closeModal();
  if (location.hash !== '#/' + route) history.replaceState(null, '', '#/' + route);
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + route));   // visible BEFORE charts size themselves
  $$('#nav a').forEach(a => { const on = a.dataset.r === route; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#mobileNav').value = route;
  $('#pageTitle').textContent = ROUTES[route];
  document.title = ROUTES[route] + ' · FinDash';
  renderActive();
  window.scrollTo(0, 0);
}
function renderActive() {
  const r = effective(range());
  $('#pageSub').textContent = (r ? r.label : 'No data for this selection') + ' · ' + (S.account === 'All' ? 'All accounts' : acctLabel(S.account))
    + ' · ' + ({ norm: 'real income & spending', ppl: 'people (P2P) only', all: 'everything on the statement' })[S.view] + ' · data to ' + fmtDate(META.dataEnd);
  try { PAGES[S.route](); } catch (e) { console.error(e); const pg = $('#page-' + S.route); if (pg) pg.insertAdjacentHTML('afterbegin', '<div class="callout neg" style="margin-bottom:12px">Part of this page failed to render: ' + esc(e.message) + '</div>'); }
  renderAlerts();
  saveState();
}
function renderAlerts() {
  const r = effective(range());
  const n = r ? TX.filter(t => inAccount(t) && inRange(t, r) && t.anom && !t.dis && t.anom.severity !== 'low').length : 0;
  const dot = $('#alertsDot'); dot.hidden = !n; dot.textContent = n > 99 ? '99+' : n;
  $('#alertsBtn').setAttribute('aria-label', n + ' unusual transactions to review');
}
function renderStatus() {
  const b = META.balances || {}, accts = Object.keys(b).sort();
  if (!accts.length) { $('#statusStrip').innerHTML = ''; return; }
  const tot = sum(accts, a => b[a].balance || 0), newest = accts.reduce((m, a) => b[a].asof > m ? b[a].asof : m, '');
  $('#statusStrip').innerHTML = '<div class="bal total"><div class="l">Total balance</div><div class="v">' + inr(tot) + '</div><div class="s"><span class="fresh-dot"></span>as of ' + fmtDate(newest) + '</div></div>'
    + accts.map(a => { const age = daysSince(b[a].asof), stale = age > STALE_DAYS;
      return '<div class="bal"><div class="l">' + esc(acctLabel(a)) + '</div><div class="v">' + inr(b[a].balance) + '</div><div class="s' + (stale ? ' stale' : '') + '"><span class="fresh-dot"></span>Data to ' + fmtDate(b[a].asof) + ' · ' + (age <= 0 ? 'today' : age === 1 ? 'yesterday' : age + ' days ago') + (stale ? ' · add a statement' : '') + '</div></div>'; }).join('');
}
function syncPeriodControls() {
  const p = S.period, years = [...new Set(TX.filter(inAccount).map(t => t.y))].sort().reverse();
  const opts = [['all', 'All time'], ['last30', 'Last 30 days'], ['last3m', 'Last 3 months'], ['last6m', 'Last 6 months'], ['last12m', 'Last 12 months']]
    .concat(years.map(y => ['year:' + y, y])).concat([['custom', 'Custom range…']]);
  $('#f-period').innerHTML = opts.map(o => '<option value="' + o[0] + '"' + (o[0] === p ? ' selected' : '') + '>' + o[1] + '</option>').join('');
  const isYear = p.startsWith('year:'), y = p.slice(5);
  const months = isYear ? [...new Set(TX.filter(t => inAccount(t) && t.y === y).map(t => t.ym))].sort() : [];
  $('#f-month').innerHTML = '<option value="All">All months</option>' + months.map(m => '<option value="' + m + '"' + (m === S.month ? ' selected' : '') + '>' + fmtMonth(m) + '</option>').join('');
  $('#f-month').disabled = !isYear; $('#f-month').hidden = !isYear;
  const days = isYear && S.month !== 'All' ? [...new Set(TX.filter(t => inAccount(t) && t.ym === S.month).map(t => t.date))].sort() : [];
  $('#f-day').innerHTML = '<option value="All">All days</option>' + days.map(d => '<option value="' + d + '"' + (d === S.day ? ' selected' : '') + '>' + fmtDay(d) + '</option>').join('');
  $('#f-day').disabled = !days.length; $('#f-day').hidden = !isYear || S.month === 'All';
  $('#customRange').hidden = p !== 'custom';
  $('#f-from').value = S.from; $('#f-to').value = S.to;
  $('#f-view').value = S.view; $('#f-account').value = S.account;
}
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
}

/* ======================================================================= *
 * Boot
 * ======================================================================= */
function prepare(tx, meta) {
  TX = tx; META = meta || {};
  OBL = new Set(META.obligationCategories || []);
  const dismissed = META.dismissed || {};
  for (const t of TX) { t.ym = t.date.slice(0, 7); t.y = t.date.slice(0, 4); if (dismissed[t.id]) t.dis = true; BY_ID.set(t.id, t); }
  DATA_START = META.dataStart || TX.reduce((a, t) => !a || t.date < a ? t.date : a, '');
  DATA_END = META.dataEnd || TX.reduce((a, t) => t.date > a ? t.date : a, '');
  COVER = { All: { from: DATA_START, to: DATA_END } };
  for (const t of TX) { const c = COVER[t.acct] = COVER[t.acct] || { from: t.date, to: t.date }; if (t.date < c.from) c.from = t.date; if (t.date > c.to) c.to = t.date; }
}
function init() {
  prepare(JSON.parse($('#fd-data').textContent), JSON.parse($('#fd-meta').textContent));
  REVEAL = !!store.get('fd-reveal', false);
  applyTheme(store.get('fd-theme', 'system'));
  $$('[data-icon]').forEach(el => { el.outerHTML = icon(el.dataset.icon); });
  $('#nav').innerHTML = NAV.map(([g, items]) => (g ? '<div class="nav-group">' + g + '</div>' : '') + items.map(([r, l, ic]) => '<a href="#/' + r + '" data-r="' + r + '">' + icon(ic) + '<span>' + l + '</span></a>').join('')).join('');
  $('#mobileNav').innerHTML = NAV.flatMap(g => g[1]).map(r => '<option value="' + r[0] + '">' + r[1] + '</option>').join('');
  $('#sideFoot').innerHTML = (META.total || TX.length).toLocaleString('en-IN') + ' transactions<br>Rebuilt ' + esc(META.generated || '');
  const accts = [...new Set(TX.map(t => t.acct))].sort();
  $('#f-account').innerHTML = '<option value="All">All accounts</option>' + accts.map(a => '<option value="' + esc(a) + '">' + esc(acctLabel(a)) + '</option>').join('');
  // defaults: latest year (as before); restore the last session's filters if any
  S.period = 'year:' + DATA_END.slice(0, 4);
  const saved = store.sget('fd-state');
  if (saved) { Object.assign(S, saved, { tx: Object.assign(S.tx, saved.tx || {}) }); if (S.account !== 'All' && !accts.includes(S.account)) S.account = 'All'; }
  syncPeriodControls();
  renderStatus();

  $('#f-account').onchange = e => { S.account = e.target.value; syncPeriodControls(); renderActive(); };
  $('#f-period').onchange = e => {
    S.period = e.target.value; S.month = 'All'; S.day = 'All';
    if (S.period === 'custom' && !S.from) { S.to = cover().to; S.from = addMonths(S.to, -1); }
    syncPeriodControls(); renderActive();
  };
  $('#f-month').onchange = e => { S.month = e.target.value; S.day = 'All'; syncPeriodControls(); renderActive(); };
  $('#f-day').onchange = e => { S.day = e.target.value; renderActive(); };
  $('#f-from').onchange = e => { S.from = e.target.value; renderActive(); };
  $('#f-to').onchange = e => { S.to = e.target.value; renderActive(); };
  $('#f-view').onchange = e => { S.view = e.target.value; renderActive(); };
  $('#mobileNav').onchange = e => go(e.target.value);
  window.addEventListener('hashchange', () => { const r = location.hash.slice(2); if (r !== S.route) go(r); });
  $('#alertsBtn').onclick = () => go('insights');
  $('#themeBtn').onclick = () => { const order = ['system', 'light', 'dark'], cur = store.get('fd-theme', 'system'), nx = order[(order.indexOf(cur) + 1) % 3]; store.set('fd-theme', nx); applyTheme(nx); toast('Theme: ' + (nx === 'system' ? 'match system' : nx)); renderActive(); };
  $('#exportBtn').onclick = () => { const r = effective(range()); exportCsv(r ? rowsIn(r) : [], 'findash-' + (r ? r.from + '_' + r.to : 'empty') + '.csv'); };
  $('#txExport').onclick = () => exportCsv(txFiltered(), 'findash-filtered.csv');
  $('#refreshBtn').onclick = async () => {
    if (!SERVED()) { toast(META.demo ? 'Demo mode: re-import is disabled' : 'Re-import works when running python3 serve.py'); return; }
    const b = $('#refreshBtn'); b.disabled = true;
    try { const j = await api('/api/refresh'); saveState(); toast('Rebuilt: ' + (j.unique || 0).toLocaleString('en-IN') + ' transactions'); setTimeout(() => location.reload(), 500); }
    catch (e) { toast('Re-import failed: ' + e.message); b.disabled = false; }
  };
  $('#uploadBtn').onclick = pickFile;
  $('#fileInput').onchange = e => { const f = e.target.files[0]; if (f) onFile(f); };
  $('#drawerClose').onclick = closeDrawer;
  $('#modalX').onclick = () => { PENDING = null; closeModal(); };
  $('#scrim').onclick = () => { closeDrawer(); closeModal(); };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDrawer(); closeModal(); $$('.tip.on').forEach(t => t.classList.remove('on')); }
    if (e.key === 'Enter' && e.target.matches && e.target.matches('tr.click')) openDrawer(e.target.dataset.id);
  });
  // One delegated click handler for everything rendered into pages.
  $('#main').addEventListener('click', ev => {
    const el = ev.target.closest('[data-tip],[data-sort],[data-pg],[data-chip],[data-ins],[data-dismiss],[data-del],[data-q],[data-cp],[data-cat],[data-merchant],[data-id]');
    if (!el || !$('#main').contains(el)) { $$('.tip.on').forEach(t => t.classList.remove('on')); return; }
    const d = el.dataset;
    if (d.tip) { const t = $('#tip-' + d.tip); const on = !t.classList.contains('on'); $$('.tip.on').forEach(x => x.classList.remove('on')); t.classList.toggle('on', on); el.setAttribute('aria-expanded', String(on)); return; }
    if (d.sort) { S.tx.desc = S.tx.sort === d.sort ? !S.tx.desc : d.sort !== 'merchant' && d.sort !== 'cat'; S.tx.sort = d.sort; renderTxTable(); return; }
    if (d.pg) { S.tx.page += +d.pg; renderTxTable(); $('#txTable').closest('.table-wrap').scrollTop = 0; return; }
    if (d.chip) { S.tx.chip = d.chip; S.tx.page = 0; renderTxTable(); return; }
    if (d.ins) { followLink((INS_CACHE[+d.ins] || {}).link); return; }
    if (d.dismiss) { ev.stopPropagation(); const t = BY_ID.get(d.dismiss); if (t) setDismissed(t, !t.dis); return; }
    if (d.del) { if (confirm('Delete ' + d.del + ' and remove its transactions from FinDash? This cannot be undone.')) api('/api/delete-file', { name: d.del }).then(() => { saveState(); toast('Deleted. Rebuilding…'); setTimeout(() => location.reload(), 400); }).catch(e => toast('Couldn\'t delete: ' + e.message)); return; }
    if (d.q) { runAsk(d.q); return; }
    if (d.cp) { S.cp = S.cp === d.cp ? '' : d.cp; renderCounterparties(); if (S.cp) $('#drill').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
    if (d.id) { openDrawer(d.id); return; }
    if (d.cat) { resetTx(); S.tx.cat = d.cat; go('transactions'); return; }
    if (d.merchant) { resetTx(); S.tx.merchant = d.merchant; go('transactions'); }
  });
  $('#drillClose').onclick = () => { S.cp = ''; renderCounterparties(); };
  $('#cp-search').oninput = debounce(e => { S.cpq = e.target.value; renderCounterparties(); }, 150);
  $('#cp-search-num').oninput = debounce(e => { S.cpNum = e.target.value; renderCounterparties(); }, 150);
  $('#anShowDismissed').onchange = e => { S.showDismissed = e.target.checked; renderInsightsPage(); };
  $('#askForm').onsubmit = e => { e.preventDefault(); const q = $('#askInput').value.trim(); if (q) runAsk(q); };
  // settings controls live inside #main; bind on change via delegation
  $('#main').addEventListener('change', e => {
    if (e.target.id === 'setReveal') { REVEAL = e.target.checked; store.set('fd-reveal', REVEAL); toast(REVEAL ? 'Showing full numbers' : 'Long numbers masked'); }
    if (e.target.id === 'setTheme') { store.set('fd-theme', e.target.value); applyTheme(e.target.value); renderActive(); }
  });
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderActive());
  if (typeof Chart !== 'undefined') { Chart.defaults.font.family = css('--font') || 'system-ui'; }

  go(location.hash.slice(2) || S.route || 'overview');
  const reopen = store.sget('fd-reopen'); if (reopen) { store.sset('fd-reopen', null); if (BY_ID.has(reopen)) openDrawer(reopen); }
  if (SERVED()) fetch('/api/status', { credentials: 'same-origin' }).then(r => r.json()).then(j => { AI = { on: !!j.ai, model: j.model || '' }; if (S.route === 'settings') renderSettings(); }).catch(() => { });
}

if (typeof document !== 'undefined' && document.getElementById('fd-data')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}
if (typeof module !== 'undefined') module.exports = { prepare, summarize, answer, insights, range, effective, prevRange, S, inr, inrShort, addMonths, monthsIn, balAt, totalBalAt, txFiltered, resetTx, get TX() { return TX; } };
