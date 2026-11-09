// Café rota — browser side. Plain JavaScript, no build step.
'use strict';

const app = document.getElementById('app');
let me = null;          // signed-in user
let setupNeeded = false;

// ---------------------------------------------------------------- utilities

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && url !== '/api/login') { me = null; go('#/signin'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

// Tiny element builder: h('div', {class:'x', onclick}, child, 'text', ...)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

function render(...nodes) {
  app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
  window.scrollTo(0, 0);
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2800);
}

function errorBox() { const e = h('div', { class: 'error', role: 'alert' }); e.hidden = true; return e; }
function showError(box, err) { box.textContent = err.message || String(err); box.hidden = false; }

// Wrap a form submit: disable button, show errors.
function onSubmit(form, errBox, fn) {
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errBox.hidden = true;
    const btns = form.querySelectorAll('button');
    btns.forEach((b) => { b.disabled = true; });
    try { await fn(new FormData(form)); }
    catch (err) { showError(errBox, err); }
    finally { btns.forEach((b) => { b.disabled = false; }); }
  });
}

// Dates are 'YYYY-MM-DD' strings in local time.
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function mondayOf(s) { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); }
const todayStr = () => ymd(new Date());
const fmt = (s, opts) => parseYmd(s).toLocaleDateString('en-GB', opts);
const fmtLong = (s) => fmt(s, { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = (s) => fmt(s, { weekday: 'short', day: 'numeric', month: 'short' });
function relDay(s) {
  const t = todayStr();
  if (s === t) return 'Today';
  if (s === addDays(t, 1)) return 'Tomorrow';
  return fmt(s, { weekday: 'long' });
}

// ---------------------------------------------------------------- routing

function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
window.addEventListener('hashchange', route);

function homeFor(user) { return user.role === 'manager' ? '#/plan' : '#/my-shifts'; }

async function route() {
  const hash = location.hash || '#/';
  if (!me) {
    if (hash === '#/signin') return setupNeeded ? pageSetup() : pageSignIn();
    return go('#/signin');
  }
  if (me.mustChangePassword) return pageChangePassword(true);
  renderTopbar(hash);
  const pages = me.role === 'manager'
    ? { '#/plan': pagePlan, '#/staff': pageStaff, '#/swaps': pageSwaps, '#/password': () => pageChangePassword(false) }
    : { '#/my-shifts': pageMyShifts, '#/password': () => pageChangePassword(false) };
  const page = pages[hash.split('?')[0]];
  if (!page) return go(homeFor(me));
  try { await page(); }
  catch (err) { render(h('div', { class: 'error' }, err.message)); }
}

function renderTopbar(hash) {
  const bar = document.getElementById('topbar');
  bar.hidden = false;
  document.getElementById('who-name').textContent = me.name;
  const links = me.role === 'manager'
    ? [['#/plan', 'Plan the week'], ['#/staff', 'Staff'], ['#/swaps', 'Swap requests']]
    : [['#/my-shifts', 'My shifts']];
  links.push(['#/password', 'Password']);
  const nav = document.getElementById('nav');
  nav.replaceChildren(...links.map(([href, label]) =>
    h('a', { href, class: hash.startsWith(href) ? 'active' : '', 'data-href': href }, label)));
  if (me.role === 'manager') refreshSwapBadge();
}

async function refreshSwapBadge() {
  try {
    const { pendingSwaps } = await api('GET', '/api/summary');
    const a = document.querySelector('nav a[data-href="#/swaps"]');
    if (a && pendingSwaps) a.append(h('span', { class: 'badge' }, String(pendingSwaps)));
  } catch { /* ignore */ }
}

document.getElementById('signout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  // Reload so nothing from this person's session (chosen week, open forms) carries over to the next.
  history.replaceState(null, '', '/#/signin');
  location.reload();
});

// ---------------------------------------------------------------- sign in / setup

function pageSignIn() {
  document.getElementById('topbar').hidden = true;
  const err = errorBox();
  const form = h('form', { class: 'card narrow' },
    h('h1', {}, '☕ Café rota'),
    h('p', { class: 'muted' }, 'Sign in to see the rota.'),
    h('label', { for: 'email' }, 'Email'),
    h('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'username', required: true }),
    h('label', { for: 'password' }, 'Password'),
    h('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
    h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Sign in')),
    h('p', { class: 'muted small' }, 'Forgotten your password? Ask the manager to set a new starting password for you.'),
    err);
  onSubmit(form, err, async (fd) => {
    const { user } = await api('POST', '/api/login', { email: fd.get('email'), password: fd.get('password') });
    me = user;
    go(homeFor(me));
  });
  render(form);
  form.querySelector('#email').focus();
}

function pageSetup() {
  document.getElementById('topbar').hidden = true;
  const err = errorBox();
  const form = h('form', { class: 'card narrow' },
    h('h1', {}, '☕ Set up your café rota'),
    h('p', { class: 'muted' }, 'First, create the manager account. You will use it to plan the week, add staff and approve swaps.'),
    h('label', { for: 'name' }, 'Your name'),
    h('input', { id: 'name', name: 'name', required: true, autocomplete: 'name' }),
    h('label', { for: 'email' }, 'Your email'),
    h('input', { id: 'email', name: 'email', type: 'email', required: true, autocomplete: 'username' }),
    h('label', { for: 'password' }, 'Choose a password (at least 8 characters)'),
    h('input', { id: 'password', name: 'password', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }),
    h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Create manager account')),
    err);
  onSubmit(form, err, async (fd) => {
    const { user } = await api('POST', '/api/setup',
      { name: fd.get('name'), email: fd.get('email'), password: fd.get('password') });
    me = user; setupNeeded = false;
    toast('Your café is set up. Next, add your staff.');
    go('#/staff');
  });
  render(form);
}

function pageChangePassword(firstTime) {
  if (firstTime) document.getElementById('topbar').hidden = true;
  const err = errorBox();
  const form = h('form', { class: 'card narrow' },
    h('h1', {}, firstTime ? `Welcome, ${me.name}` : 'Change your password'),
    firstTime && h('p', { class: 'muted' },
      'Before you start, please replace the starting password the manager gave you with one only you know.'),
    h('label', { for: 'cur' }, firstTime ? 'Starting password' : 'Current password'),
    h('input', { id: 'cur', name: 'cur', type: 'password', required: true, autocomplete: 'current-password' }),
    h('label', { for: 'new1' }, 'New password (at least 8 characters)'),
    h('input', { id: 'new1', name: 'new1', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }),
    h('label', { for: 'new2' }, 'New password again'),
    h('input', { id: 'new2', name: 'new2', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }),
    h('div', { class: 'actions' },
      h('button', { type: 'submit' }, 'Save new password'),
      firstTime && h('button', { type: 'button', class: 'secondary', onclick: () => document.getElementById('signout').click() }, 'Sign out')),
    err);
  onSubmit(form, err, async (fd) => {
    if (fd.get('new1') !== fd.get('new2')) throw new Error('The two new passwords do not match.');
    const { user } = await api('POST', '/api/change-password',
      { currentPassword: fd.get('cur'), newPassword: fd.get('new1') });
    me = user;
    toast('Password changed.');
    go(homeFor(me));
  });
  render(form);
}

// ---------------------------------------------------------------- manager: staff

async function pageStaff() {
  const { staff } = await api('GET', '/api/staff');
  const err = errorBox();
  const form = h('form', { class: 'card' },
    h('h2', {}, 'Add a staff member'),
    h('div', { class: 'row' },
      h('div', {}, h('label', { for: 'sname' }, 'Name'), h('input', { id: 'sname', name: 'name', required: true })),
      h('div', {}, h('label', { for: 'semail' }, 'Email'), h('input', { id: 'semail', name: 'email', type: 'email', required: true })),
      h('div', {}, h('label', { for: 'spw' }, 'Starting password'),
        h('input', { id: 'spw', name: 'password', required: true, minlength: 8, autocomplete: 'off', value: suggestPassword() }))),
    h('p', { class: 'muted small' },
      'Give them their email and starting password. They will be asked to choose their own password when they first sign in.'),
    h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Add staff member')),
    err);
  onSubmit(form, err, async (fd) => {
    await api('POST', '/api/staff', { name: fd.get('name'), email: fd.get('email'), password: fd.get('password') });
    toast(`${fd.get('name')} added. Starting password: ${fd.get('password')}`);
    pageStaff();
  });

  const list = h('div', { class: 'card' },
    h('h2', {}, `Staff (${staff.length})`),
    staff.length === 0
      ? h('p', { class: 'muted' }, 'No staff yet. Add your first staff member above.')
      : staff.map((s) => h('div', { class: 'list-item' },
        h('div', { class: 'grow' },
          h('div', {}, h('strong', {}, s.name)),
          h('div', { class: 'muted small' }, s.email,
            s.mustChangePassword ? ' · has not signed in yet' : '')),
        h('button', { class: 'secondary small', onclick: () => resetPassword(s) }, 'New password'),
        h('button', { class: 'danger small', onclick: () => removeStaff(s) }, 'Remove'))));

  render(h('h1', {}, 'Staff'), form, list);
}

function suggestPassword() {
  const words = ['latte', 'mocha', 'scone', 'bagel', 'crema', 'toast', 'chai', 'brew', 'bean', 'flat'];
  const a = new Uint32Array(3); crypto.getRandomValues(a);
  return `${words[a[0] % 10]}-${words[a[1] % 10]}-${100 + (a[2] % 900)}`;
}

async function resetPassword(s) {
  const pw = prompt(`Set a new starting password for ${s.name} (at least 8 characters).\nThey will choose their own when they next sign in.`, suggestPassword());
  if (pw == null) return;
  try {
    await api('POST', `/api/staff/${s.id}/reset-password`, { password: pw });
    toast(`New starting password for ${s.name}: ${pw}`);
    pageStaff();
  } catch (err) { alert(err.message); }
}

async function removeStaff(s) {
  if (!confirm(`Remove ${s.name}?\n\nThey will no longer be able to sign in. Any of their shifts from today onwards will be marked "Unassigned" so you can fill them.`)) return;
  try {
    const r = await api('DELETE', `/api/staff/${s.id}`);
    toast(r.unassignedShifts
      ? `${s.name} removed. ${r.unassignedShifts} shift(s) now need someone.`
      : `${s.name} removed.`);
    pageStaff();
  } catch (err) { alert(err.message); }
}

// ---------------------------------------------------------------- manager: plan the week

const planState = { week: null, editingId: null, last: { start: '08:00', end: '14:00' } };

async function pagePlan() {
  if (!planState.week) {
    // Default to next week from Thursday onwards, since that is when people plan ahead.
    const t = todayStr();
    const dow = (parseYmd(t).getDay() + 6) % 7;
    planState.week = dow >= 3 ? addDays(mondayOf(t), 7) : mondayOf(t);
  }
  const [week, { staff }] = await Promise.all([
    api('GET', `/api/weeks/${planState.week}`),
    api('GET', '/api/staff'),
  ]);
  drawPlan(week, staff);
}

function drawPlan(week, staff) {
  const ws = week.weekStart;
  const days = [...Array(7)].map((_, i) => addDays(ws, i));
  const published = !!week.publishedAt;
  const editing = week.shifts.find((s) => s.id === planState.editingId) || null;
  if (!editing) planState.editingId = null;

  const changeWeek = (n) => { planState.week = addDays(ws, 7 * n); planState.editingId = null; pagePlan(); };
  const weekbar = h('div', { class: 'weekbar' },
    h('button', { class: 'secondary', onclick: () => changeWeek(-1), 'aria-label': 'Previous week' }, '‹'),
    h('div', { class: 'title' }, `Week of ${fmt(ws, { day: 'numeric', month: 'long', year: 'numeric' })}`,
      ' ', h('span', { class: 'status ' + (published ? 'published' : 'draft') }, published ? 'Published' : 'Draft')),
    h('button', { class: 'secondary', onclick: () => changeWeek(1), 'aria-label': 'Next week' }, '›'));

  const unassigned = week.shifts.filter((s) => !s.userId).length;
  const pubErr = errorBox();
  const publishCard = h('div', { class: 'card' },
    published
      ? h('p', {}, 'Staff can see this week. Any change you make now shows up for them straight away.')
      : h('p', {}, 'This week is a draft. Staff cannot see it until you publish it.'),
    unassigned ? h('div', { class: 'notice' }, `${unassigned} shift(s) have nobody assigned.`) : null,
    h('div', { class: 'actions' },
      published
        ? h('button', { class: 'secondary', onclick: () => doWeek('unpublish') }, 'Hide from staff (back to draft)')
        : h('button', { class: 'good', disabled: week.shifts.length === 0, onclick: () => doWeek('publish') }, 'Publish this week'),
      week.shifts.length === 0
        ? h('button', { class: 'secondary', onclick: () => doWeek('copy-previous') }, 'Copy last week’s shifts')
        : null),
    pubErr);

  async function doWeek(action) {
    if (action === 'unpublish' && !confirm('Hide this week from staff?')) return;
    try {
      const w = await api('POST', `/api/weeks/${ws}/${action}`);
      toast({ publish: 'Week published. Staff can now see their shifts.', unpublish: 'Week is a draft again.',
        'copy-previous': 'Copied last week. Check it, then publish.' }[action]);
      drawPlan(w, staff);
    } catch (err) { showError(pubErr, err); }
  }

  // Add / edit form
  const err = errorBox();
  const v = editing || { day: days.includes(planState.lastDay) ? planState.lastDay : ws, ...planState.last, userId: '' };
  const form = h('form', { class: 'card' },
    h('h2', {}, editing ? 'Change shift' : 'Add a shift'),
    staff.length === 0 ? h('div', { class: 'notice' }, 'Add your staff on the Staff page first.') : null,
    h('div', { class: 'row' },
      h('div', {}, h('label', { for: 'day' }, 'Day'),
        h('select', { id: 'day', name: 'day' }, days.map((d) => h('option', { value: d, selected: d === v.day }, fmtShort(d))))),
      h('div', {}, h('label', { for: 'start' }, 'Start'), h('input', { id: 'start', name: 'start', type: 'time', required: true, value: v.start })),
      h('div', {}, h('label', { for: 'end' }, 'Finish'), h('input', { id: 'end', name: 'end', type: 'time', required: true, value: v.end })),
      h('div', {}, h('label', { for: 'who' }, 'Who is working'),
        h('select', { id: 'who', name: 'userId', required: !editing },
          h('option', { value: '' }, editing ? 'Nobody (unassigned)' : 'Choose…'),
          staff.map((s) => h('option', { value: String(s.id), selected: s.id === v.userId }, s.name))))),
    h('div', { class: 'actions' },
      h('button', { type: 'submit' }, editing ? 'Save changes' : 'Add shift'),
      editing ? h('button', { type: 'button', class: 'secondary', onclick: () => { planState.editingId = null; drawPlan(week, staff); } }, 'Cancel') : null),
    err);
  onSubmit(form, err, async (fd) => {
    const body = { day: fd.get('day'), start: fd.get('start'), end: fd.get('end'), userId: fd.get('userId') || null };
    let w;
    if (editing) {
      w = await api('PUT', `/api/shifts/${editing.id}`, body);
      planState.editingId = null;
      toast('Shift changed.');
    } else {
      w = await api('POST', `/api/weeks/${ws}/shifts`, body);
      planState.last = { start: body.start, end: body.end };
      planState.lastDay = body.day;
      toast('Shift added.');
    }
    drawPlan(w, staff);
    const who = document.getElementById('who');
    if (who && !editing) who.focus();
  });

  // Days
  const t = todayStr();
  const grid = h('div', { class: 'card' },
    h('h2', {}, `Shifts this week (${week.shifts.length})`),
    days.map((d) => {
      const list = week.shifts.filter((s) => s.day === d);
      return h('div', { class: 'day' + (d === t ? ' today' : '') },
        h('h3', {}, fmtLong(d)),
        list.length === 0 ? h('div', { class: 'empty-day' }, 'No shifts') :
          list.map((s) => h('div', { class: 'shift' + (s.id === planState.editingId ? ' editing' : '') },
            h('span', { class: 'time' }, `${s.start}–${s.end}`),
            h('span', { class: 'name' },
              s.userId ? s.userName : h('span', { class: 'unassigned' }, 'Unassigned'),
              s.pendingSwaps ? h('span', { class: 'status pending', style: 'margin-left:8px' }, 'swap asked') : null),
            h('button', { class: 'secondary small', onclick: () => { planState.editingId = s.id; drawPlan(week, staff); } }, 'Change'),
            h('button', { class: 'danger small', onclick: async () => {
              if (!confirm(`Delete the ${s.start}–${s.end} shift on ${fmtShort(s.day)}${s.userName ? ' (' + s.userName + ')' : ''}?`)) return;
              try { drawPlan(await api('DELETE', `/api/shifts/${s.id}`), staff); toast('Shift deleted.'); }
              catch (e) { alert(e.message); }
            } }, 'Delete'))));
    }));

  render(h('h1', {}, 'Plan the week'), weekbar, publishCard, form, grid);
  if (editing) form.scrollIntoView({ behavior: 'smooth' });
}

// ---------------------------------------------------------------- manager: swap requests

async function pageSwaps() {
  const { swaps } = await api('GET', '/api/swaps');
  const pending = swaps.filter((s) => s.status === 'pending');
  const done = swaps.filter((s) => s.status !== 'pending');
  const err = errorBox();

  async function decide(s, action) {
    err.hidden = true;
    try {
      await api('POST', `/api/swaps/${s.id}/${action}`);
      toast(action === 'approve' ? `Approved. ${s.toName} now has the shift.` : 'Request turned down.');
      pageSwaps();
      renderTopbar(location.hash);
    } catch (e) { showError(err, e); }
  }

  const desc = (s) => `${fmtLong(s.day)}, ${s.start}–${s.end}`;
  render(
    h('h1', {}, 'Swap requests'),
    h('div', { class: 'card' },
      h('h2', {}, `Waiting for you (${pending.length})`),
      err,
      pending.length === 0 ? h('p', { class: 'muted' }, 'No swap requests waiting.') :
        pending.map((s) => h('div', { class: 'list-item' },
          h('div', { class: 'grow' },
            h('div', {}, h('strong', {}, s.fromName), ' wants ', h('strong', {}, s.toName), ' to take their shift'),
            h('div', {}, desc(s)),
            s.note ? h('div', { class: 'muted small' }, `“${s.note}”`) : null,
            s.clash ? h('div', { class: 'notice small', style: 'margin:6px 0 0' }, '⚠ ' + s.clash) : null),
          h('button', { class: 'good', onclick: () => decide(s, 'approve') }, 'Approve'),
          h('button', { class: 'danger', onclick: () => decide(s, 'decline') }, 'Turn down')))),
    h('div', { class: 'card' },
      h('h2', {}, 'Recent decisions'),
      done.length === 0 ? h('p', { class: 'muted' }, 'Nothing yet.') :
        done.map((s) => h('div', { class: 'list-item' },
          h('div', { class: 'grow' },
            h('div', {}, `${s.fromName} → ${s.toName}`),
            h('div', { class: 'muted small' }, desc(s), s.reason ? ` · ${s.reason}` : '')),
          h('span', { class: 'status ' + s.status }, statusLabel(s.status))))));
}

function statusLabel(st) {
  return { pending: 'Waiting', approved: 'Approved', declined: 'Turned down', cancelled: 'Cancelled' }[st];
}

// ---------------------------------------------------------------- staff: my shifts

let openSwapFor = null;

async function pageMyShifts() {
  const { shifts, colleagues, requests } = await api('GET', '/api/my-shifts');
  const err = errorBox();

  const items = shifts.map((s) => {
    const d = parseYmd(s.day);
    const card = h('div', { class: 'card myshift' },
      h('div', { class: 'date' },
        h('div', { class: 'dow' }, d.toLocaleDateString('en-GB', { weekday: 'short' })),
        h('div', { class: 'dnum' }, String(d.getDate())),
        h('div', { class: 'mon' }, d.toLocaleDateString('en-GB', { month: 'short' }))),
      h('div', { class: 'info' },
        h('div', { class: 't' }, `${s.start} – ${s.end}`),
        h('div', { class: 'muted small' }, relDay(s.day)),
        s.pendingSwap ? h('div', { style: 'margin-top:4px' },
          h('span', { class: 'status pending' }, `Swap with ${s.pendingSwap.toName} waiting for the manager`)) : null),
      s.pendingSwap
        ? h('button', { class: 'secondary small', onclick: () => cancelSwap(s.pendingSwap.id) }, 'Withdraw request')
        : s.started ? null
          : h('button', { class: 'secondary', disabled: colleagues.length === 0,
            onclick: () => { openSwapFor = openSwapFor === s.id ? null : s.id; pageMyShifts(); } }, 'Ask for a swap'));
    if (openSwapFor === s.id && !s.pendingSwap) card.append(swapForm(s, colleagues));
    return card;
  });

  async function cancelSwap(id) {
    if (!confirm('Withdraw this swap request?')) return;
    try { await api('POST', `/api/swaps/${id}/cancel`); toast('Request withdrawn.'); pageMyShifts(); }
    catch (e) { showError(err, e); }
  }

  const recent = requests.filter((r) => r.status !== 'pending').slice(0, 8);
  render(
    h('h1', {}, 'My shifts'),
    err,
    shifts.length === 0
      ? h('div', { class: 'card' }, h('p', { class: 'muted' },
        'You have no upcoming shifts on a published rota. The manager will publish the week when it is ready.'))
      : items,
    recent.length ? h('div', { class: 'card' },
      h('h2', {}, 'My recent swap requests'),
      recent.map((r) => h('div', { class: 'list-item' },
        h('div', { class: 'grow' },
          h('div', {}, `${fmtShort(r.day)}, ${r.start}–${r.end} → ${r.toName}`),
          r.reason ? h('div', { class: 'muted small' }, r.reason) : null),
        h('span', { class: 'status ' + r.status }, statusLabel(r.status))))) : null);
}

function swapForm(s, colleagues) {
  const err = errorBox();
  const form = h('form', { class: 'swapform' },
    h('label', { for: 'to' + s.id }, 'Who will take this shift?'),
    h('select', { id: 'to' + s.id, name: 'to', required: true },
      h('option', { value: '' }, 'Choose a colleague…'),
      colleagues.map((c) => h('option', { value: String(c.id) }, c.name))),
    h('label', { for: 'note' + s.id }, 'Note for the manager (optional)'),
    h('input', { id: 'note' + s.id, name: 'note', maxlength: 300, placeholder: 'e.g. Sam has agreed to cover' }),
    h('p', { class: 'muted small' }, 'The shift stays yours until the manager approves.'),
    h('div', { class: 'actions' },
      h('button', { type: 'submit' }, 'Send request'),
      h('button', { type: 'button', class: 'secondary', onclick: () => { openSwapFor = null; pageMyShifts(); } }, 'Cancel')),
    err);
  onSubmit(form, err, async (fd) => {
    await api('POST', '/api/swaps', { shiftId: s.id, toUserId: Number(fd.get('to')), note: fd.get('note') });
    openSwapFor = null;
    toast('Swap request sent to the manager.');
    pageMyShifts();
  });
  return form;
}

// ---------------------------------------------------------------- start

(async function start() {
  try {
    const [{ user }, { needsSetup }] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/setup')]);
    me = user; setupNeeded = needsSetup;
  } catch { /* server unreachable: show sign in */ }
  if (me && (location.hash === '#/signin' || !location.hash)) location.hash = homeFor(me);
  route();
})();
