// Café rota — a small web app for planning shifts.
// No dependencies beyond Node.js 22.5+ (uses the built-in node:sqlite).
// Run with:  node server.js   then open http://localhost:3000

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'rota.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;

// ---------------------------------------------------------------- database

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('manager','staff')),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS weeks (
    week_start TEXT PRIMARY KEY,          -- Monday, YYYY-MM-DD
    published_at TEXT                     -- NULL = draft
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY,
    week_start TEXT NOT NULL,
    day TEXT NOT NULL,                    -- YYYY-MM-DD
    start_time TEXT NOT NULL,             -- HH:MM
    end_time TEXT NOT NULL,               -- HH:MM
    user_id INTEGER REFERENCES users(id), -- NULL = unassigned (e.g. person left)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS shifts_week ON shifts(week_start);
  CREATE INDEX IF NOT EXISTS shifts_user ON shifts(user_id, day);

  CREATE TABLE IF NOT EXISTS swaps (
    id INTEGER PRIMARY KEY,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    from_user_id INTEGER NOT NULL REFERENCES users(id),
    to_user_id INTEGER NOT NULL REFERENCES users(id),
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','approved','declined','cancelled')),
    reason TEXT,                          -- why it was cancelled, if it was
    -- snapshot of the shift, so history still reads well if the shift changes
    shift_day TEXT, shift_start TEXT, shift_end TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT
  );
`);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
function validPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw bad('Passwords need at least 8 characters.');
  return pw;
}
function validEmail(email) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Please enter a valid email address.');
  return email;
}
function validName(name) {
  name = String(name || '').trim();
  if (!name) throw bad('Please enter a name.');
  if (name.length > 80) throw bad('That name is too long.');
  return name;
}

// Dates are plain YYYY-MM-DD strings in the café's local time.
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return ymd(dt) === s ? dt : null;
}
function today() { return ymd(new Date()); }
function nowHM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function mondayOf(s) {
  const d = parseYmd(s);
  if (!d) throw bad('That is not a valid date.');
  const offset = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - offset);
  return ymd(d);
}
function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function validTime(t, label) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t))) throw bad(`Please choose a ${label}.`);
  return t;
}

// Has this shift already started? (Past shifts can't be swapped.)
function shiftStarted(s) {
  const t = today();
  return s.day < t || (s.day === t && s.start_time <= nowHM());
}

function overlapping(userId, day, start, end, ignoreShiftId) {
  return db.prepare(`
    SELECT id, start_time, end_time FROM shifts
    WHERE user_id = ? AND day = ? AND id != ? AND start_time < ? AND end_time > ?
  `).get(userId, day, ignoreShiftId || 0, end, start);
}

function cancelPendingSwapsForShift(shiftId, reason) {
  db.prepare(`UPDATE swaps SET status='cancelled', reason=?, decided_at=datetime('now')
              WHERE shift_id=? AND status='pending'`).run(reason, shiftId);
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, mustChangePassword: !!u.must_change_password };
}

// ---------------------------------------------------------------- sessions

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, userId, expires.toISOString());
  res.setHeader('Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1
  `).get(token, new Date().toISOString());
  return row || null;
}

// Simple brute-force protection for sign-in.
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 15 * 60e3);
  if (a.length >= 10) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
  a.push(now); attempts.set(key, a);
}

// ---------------------------------------------------------------- routes

const routes = [];
function route(method, pattern, opts, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, opts, handler });
}

// --- auth

route('GET', '/api/setup', { auth: false }, () => ({
  needsSetup: !db.prepare("SELECT 1 FROM users WHERE role='manager'").get(),
}));

// First run only: create the manager account.
route('POST', '/api/setup', { auth: false }, ({ body, res }) => {
  return tx(() => {
    if (db.prepare("SELECT 1 FROM users WHERE role='manager'").get())
      throw bad('The café is already set up. Please sign in.');
    const name = validName(body.name), email = validEmail(body.email), pw = validPassword(body.password);
    const r = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'manager')")
      .run(name, email, hashPassword(pw));
    createSession(res, r.lastInsertRowid);
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid)) };
  });
});

route('POST', '/api/login', { auth: false }, ({ body, res, req }) => {
  const email = String(body.email || '').trim().toLowerCase();
  throttle(email + '|' + req.socket.remoteAddress);
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
  if (!u || !checkPassword(String(body.password || ''), u.password_hash))
    throw new HttpError(401, 'That email and password do not match.');
  createSession(res, u.id);
  return { user: publicUser(u) };
});

route('POST', '/api/logout', { auth: false }, ({ req, res }) => {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/me', { auth: false }, ({ user }) => ({ user: user ? publicUser(user) : null }));

route('POST', '/api/change-password', { allowMustChange: true }, ({ user, body }) => {
  if (!checkPassword(String(body.currentPassword || ''), user.password_hash))
    throw bad('Your current password is not right.');
  const pw = validPassword(body.newPassword);
  if (pw === body.currentPassword) throw bad('Please choose a new password, different from the current one.');
  db.prepare('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?').run(hashPassword(pw), user.id);
  return { user: publicUser({ ...user, must_change_password: 0 }) };
});

// --- staff (manager)

route('GET', '/api/staff', { role: 'manager' }, () => ({
  staff: db.prepare(`SELECT id,name,email,must_change_password FROM users
                     WHERE role='staff' AND active=1 ORDER BY name COLLATE NOCASE`).all()
    .map((s) => ({ id: s.id, name: s.name, email: s.email, mustChangePassword: !!s.must_change_password })),
}));

route('POST', '/api/staff', { role: 'manager' }, ({ body }) => {
  const name = validName(body.name), email = validEmail(body.email), pw = validPassword(body.password);
  return tx(() => {
    const existing = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (existing && existing.active) throw bad('Someone with that email already has an account.');
    if (existing && existing.role === 'manager') throw bad('That email belongs to the manager account.');
    if (existing) {
      // Someone who left is coming back: reactivate them with the new starting password.
      db.prepare('UPDATE users SET name=?, password_hash=?, must_change_password=1, active=1 WHERE id=?')
        .run(name, hashPassword(pw), existing.id);
      return { id: existing.id };
    }
    const r = db.prepare("INSERT INTO users (name,email,password_hash,role,must_change_password) VALUES (?,?,?,'staff',1)")
      .run(name, email, hashPassword(pw));
    return { id: Number(r.lastInsertRowid) };
  });
});

// Reset a forgotten password: manager sets a new starting password.
route('POST', '/api/staff/:id/reset-password', { role: 'manager' }, ({ params, body }) => {
  const pw = validPassword(body.password);
  const s = db.prepare("SELECT id FROM users WHERE id=? AND role='staff' AND active=1").get(params.id);
  if (!s) throw new HttpError(404, 'Staff member not found.');
  tx(() => {
    db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').run(hashPassword(pw), s.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(s.id);
  });
  return { ok: true };
});

// Remove someone who has left. Their account is closed (history is kept),
// their shifts from today onwards become "unassigned" so the gaps are visible,
// and any open swap requests involving them are cancelled.
route('DELETE', '/api/staff/:id', { role: 'manager' }, ({ params }) => {
  const s = db.prepare("SELECT * FROM users WHERE id=? AND role='staff' AND active=1").get(params.id);
  if (!s) throw new HttpError(404, 'Staff member not found.');
  return tx(() => {
    db.prepare('UPDATE users SET active=0 WHERE id=?').run(s.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(s.id);
    const freed = db.prepare('UPDATE shifts SET user_id=NULL WHERE user_id=? AND day>=?').run(s.id, today()).changes;
    db.prepare(`UPDATE swaps SET status='cancelled', reason=?, decided_at=datetime('now')
                WHERE status='pending' AND (from_user_id=? OR to_user_id=?)`)
      .run(`${s.name} was removed from the staff list`, s.id, s.id);
    return { ok: true, unassignedShifts: freed };
  });
});

// --- weeks & shifts (manager)

function weekPayload(weekStart) {
  const w = db.prepare('SELECT * FROM weeks WHERE week_start=?').get(weekStart);
  const shifts = db.prepare(`
    SELECT s.id, s.day, s.start_time AS start, s.end_time AS end, s.user_id AS userId,
           u.name AS userName,
           (SELECT COUNT(*) FROM swaps w WHERE w.shift_id = s.id AND w.status='pending') AS pendingSwaps
    FROM shifts s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.week_start = ?
    ORDER BY s.day, s.start_time, s.end_time, u.name
  `).all(weekStart);
  return { weekStart, publishedAt: w ? w.published_at : null, shifts };
}

route('GET', '/api/weeks/:weekStart', { role: 'manager' }, ({ params }) => weekPayload(mondayOf(params.weekStart)));

function shiftInput(body, weekStart) {
  const day = String(body.day || '');
  if (!parseYmd(day) || mondayOf(day) !== weekStart) throw bad('Please choose a day in this week.');
  const start = validTime(body.start, 'start time'), end = validTime(body.end, 'finish time');
  if (end <= start) throw bad('The finish time must be after the start time.');
  let userId = body.userId === null || body.userId === '' || body.userId === undefined ? null : Number(body.userId);
  if (userId !== null) {
    const u = db.prepare("SELECT id,name FROM users WHERE id=? AND role='staff' AND active=1").get(userId);
    if (!u) throw bad('Please choose who is working.');
    const clash = overlapping(userId, day, start, end, body._ignore);
    if (clash) throw bad(`${u.name} already has a shift ${clash.start_time}–${clash.end_time} that day.`);
  }
  return { day, start, end, userId };
}

route('POST', '/api/weeks/:weekStart/shifts', { role: 'manager' }, ({ params, body }) => {
  const weekStart = mondayOf(params.weekStart);
  return tx(() => {
    const s = shiftInput(body, weekStart);
    db.prepare('INSERT INTO shifts (week_start,day,start_time,end_time,user_id) VALUES (?,?,?,?,?)')
      .run(weekStart, s.day, s.start, s.end, s.userId);
    return weekPayload(weekStart);
  });
});

route('PUT', '/api/shifts/:id', { role: 'manager' }, ({ params, body }) => {
  return tx(() => {
    const cur = db.prepare('SELECT * FROM shifts WHERE id=?').get(params.id);
    if (!cur) throw new HttpError(404, 'That shift no longer exists.');
    const s = shiftInput({ ...body, _ignore: cur.id }, cur.week_start);
    db.prepare('UPDATE shifts SET day=?, start_time=?, end_time=?, user_id=? WHERE id=?')
      .run(s.day, s.start, s.end, s.userId, cur.id);
    if (s.userId !== cur.user_id || s.day !== cur.day || s.start !== cur.start_time || s.end !== cur.end_time)
      cancelPendingSwapsForShift(cur.id, 'The manager changed this shift');
    return weekPayload(cur.week_start);
  });
});

route('DELETE', '/api/shifts/:id', { role: 'manager' }, ({ params }) => {
  return tx(() => {
    const cur = db.prepare('SELECT * FROM shifts WHERE id=?').get(params.id);
    if (!cur) throw new HttpError(404, 'That shift no longer exists.');
    cancelPendingSwapsForShift(cur.id, 'The manager removed this shift');
    db.prepare('DELETE FROM shifts WHERE id=?').run(cur.id);
    return weekPayload(cur.week_start);
  });
});

// Copy last week's shifts into an empty week — saves retyping a similar rota.
route('POST', '/api/weeks/:weekStart/copy-previous', { role: 'manager' }, ({ params }) => {
  const weekStart = mondayOf(params.weekStart);
  const prev = addDays(weekStart, -7);
  return tx(() => {
    if (db.prepare('SELECT 1 FROM shifts WHERE week_start=?').get(weekStart))
      throw bad('This week already has shifts. Copying only works into an empty week.');
    const rows = db.prepare(`SELECT s.day, s.start_time, s.end_time, s.user_id, u.active
                             FROM shifts s LEFT JOIN users u ON u.id=s.user_id WHERE s.week_start=?`).all(prev);
    if (!rows.length) throw bad('The previous week has no shifts to copy.');
    const ins = db.prepare('INSERT INTO shifts (week_start,day,start_time,end_time,user_id) VALUES (?,?,?,?,?)');
    for (const r of rows) ins.run(weekStart, addDays(r.day, 7), r.start_time, r.end_time, r.active ? r.user_id : null);
    return weekPayload(weekStart);
  });
});

route('POST', '/api/weeks/:weekStart/publish', { role: 'manager' }, ({ params }) => {
  const weekStart = mondayOf(params.weekStart);
  db.prepare(`INSERT INTO weeks (week_start, published_at) VALUES (?, datetime('now'))
              ON CONFLICT(week_start) DO UPDATE SET published_at=excluded.published_at`).run(weekStart);
  return weekPayload(weekStart);
});

route('POST', '/api/weeks/:weekStart/unpublish', { role: 'manager' }, ({ params }) => {
  const weekStart = mondayOf(params.weekStart);
  db.prepare('UPDATE weeks SET published_at=NULL WHERE week_start=?').run(weekStart);
  return weekPayload(weekStart);
});

// --- my shifts (staff)

route('GET', '/api/my-shifts', { role: 'staff' }, ({ user }) => {
  const t = today();
  const shifts = db.prepare(`
    SELECT s.id, s.day, s.start_time AS start, s.end_time AS end,
      (SELECT json_object('id', w.id, 'toName', u2.name) FROM swaps w JOIN users u2 ON u2.id=w.to_user_id
         WHERE w.shift_id=s.id AND w.status='pending' AND w.from_user_id=s.user_id) AS pendingSwap
    FROM shifts s JOIN weeks wk ON wk.week_start = s.week_start AND wk.published_at IS NOT NULL
    WHERE s.user_id = ? AND s.day >= ?
    ORDER BY s.day, s.start_time
  `).all(user.id, t).map((s) => ({ ...s, pendingSwap: s.pendingSwap ? JSON.parse(s.pendingSwap) : null,
    started: shiftStarted({ day: s.day, start_time: s.start }) }));
  const colleagues = db.prepare(`SELECT id, name FROM users WHERE role='staff' AND active=1 AND id != ?
                                 ORDER BY name COLLATE NOCASE`).all(user.id);
  const requests = db.prepare(`
    SELECT w.id, w.status, w.reason, w.shift_day AS day, w.shift_start AS start, w.shift_end AS end,
           w.created_at AS createdAt, w.decided_at AS decidedAt, u.name AS toName
    FROM swaps w JOIN users u ON u.id = w.to_user_id
    WHERE w.from_user_id = ? ORDER BY w.created_at DESC, w.id DESC LIMIT 20
  `).all(user.id);
  return { shifts, colleagues, requests };
});

route('POST', '/api/swaps', { role: 'staff' }, ({ user, body }) => {
  return tx(() => {
    const s = db.prepare(`SELECT s.* FROM shifts s JOIN weeks wk ON wk.week_start=s.week_start AND wk.published_at IS NOT NULL
                          WHERE s.id=? AND s.user_id=?`).get(body.shiftId, user.id);
    if (!s) throw bad('That is not one of your shifts.');
    if (shiftStarted(s)) throw bad('That shift has already started.');
    const to = db.prepare("SELECT id,name FROM users WHERE id=? AND role='staff' AND active=1").get(body.toUserId);
    if (!to || to.id === user.id) throw bad('Please choose a colleague to take the shift.');
    if (db.prepare("SELECT 1 FROM swaps WHERE shift_id=? AND status='pending'").get(s.id))
      throw bad('You have already asked to swap this shift.');
    const note = String(body.note || '').trim().slice(0, 300) || null;
    db.prepare(`INSERT INTO swaps (shift_id,from_user_id,to_user_id,note,shift_day,shift_start,shift_end)
                VALUES (?,?,?,?,?,?,?)`).run(s.id, user.id, to.id, note, s.day, s.start_time, s.end_time);
    return { ok: true };
  });
});

route('POST', '/api/swaps/:id/cancel', { role: 'staff' }, ({ user, params }) => {
  const r = db.prepare(`UPDATE swaps SET status='cancelled', reason='You withdrew the request', decided_at=datetime('now')
                        WHERE id=? AND from_user_id=? AND status='pending'`).run(params.id, user.id);
  if (!r.changes) throw bad('That request is no longer waiting.');
  return { ok: true };
});

// --- swap requests (manager)

route('GET', '/api/swaps', { role: 'manager' }, () => {
  const rows = db.prepare(`
    SELECT w.id, w.status, w.note, w.reason, w.created_at AS createdAt, w.decided_at AS decidedAt,
           w.shift_day AS day, w.shift_start AS start, w.shift_end AS end,
           f.name AS fromName, t.name AS toName, w.to_user_id AS toUserId
    FROM swaps w JOIN users f ON f.id=w.from_user_id JOIN users t ON t.id=w.to_user_id
    ORDER BY CASE w.status WHEN 'pending' THEN 0 ELSE 1 END,
             CASE w.status WHEN 'pending' THEN w.shift_day END ASC,
             w.decided_at DESC, w.id DESC
    LIMIT 100
  `).all();
  // Warn the manager if approving would double-book the colleague.
  for (const r of rows) {
    if (r.status !== 'pending') continue;
    const c = overlapping(r.toUserId, r.day, r.start, r.end, 0);
    r.clash = c ? `${r.toName} already works ${c.start_time}–${c.end_time} that day.` : null;
  }
  return { swaps: rows };
});

route('POST', '/api/swaps/:id/approve', { role: 'manager' }, ({ params }) => {
  return tx(() => {
    const w = db.prepare("SELECT * FROM swaps WHERE id=? AND status='pending'").get(params.id);
    if (!w) throw bad('That request is no longer waiting.');
    const s = db.prepare('SELECT * FROM shifts WHERE id=?').get(w.shift_id);
    if (!s || s.user_id !== w.from_user_id) throw bad('The shift has changed since this request was made.');
    const to = db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(w.to_user_id);
    if (!to) throw bad('That colleague is no longer on the staff list.');
    const clash = overlapping(to.id, s.day, s.start_time, s.end_time, s.id);
    if (clash) throw bad(`${to.name} already works ${clash.start_time}–${clash.end_time} that day.`);
    db.prepare('UPDATE shifts SET user_id=? WHERE id=?').run(to.id, s.id);
    db.prepare("UPDATE swaps SET status='approved', decided_at=datetime('now') WHERE id=?").run(w.id);
    return { ok: true };
  });
});

route('POST', '/api/swaps/:id/decline', { role: 'manager' }, ({ params }) => {
  const r = db.prepare("UPDATE swaps SET status='declined', decided_at=datetime('now') WHERE id=? AND status='pending'")
    .run(params.id);
  if (!r.changes) throw bad('That request is no longer waiting.');
  return { ok: true };
});

route('GET', '/api/summary', { role: 'manager' }, () => ({
  pendingSwaps: db.prepare("SELECT COUNT(*) AS n FROM swaps WHERE status='pending'").get().n,
}));

// ---------------------------------------------------------------- server

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function serveStatic(req, res, urlPath) {
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(urlPath)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) { reject(bad('Request too large.')); req.destroy(); } });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(bad('Invalid request.')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    const r = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Not found.');
    // Only accept JSON for writes (blocks cross-site form posts).
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json'))
      throw bad('Invalid request.');
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const user = currentUser(req);
    if (r.opts.auth !== false) {
      if (!user) throw new HttpError(401, 'Please sign in.');
      if (user.must_change_password && !r.opts.allowMustChange)
        throw new HttpError(403, 'Please choose a new password first.');
      if (r.opts.role && user.role !== r.opts.role) throw new HttpError(403, 'You do not have access to that.');
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    const result = await r.handler({ req, res, params, body, user, query: url.searchParams });
    send(res, 200, result);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong. Please try again.' });
  }
});

// Tidy expired sessions now and then.
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());

server.listen(PORT, () => {
  console.log(`Café rota is running: open http://localhost:${PORT}`);
  console.log(`Data is saved in ${DB_FILE}`);
});
