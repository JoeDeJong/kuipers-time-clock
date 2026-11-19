'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dbmod = require('./db');
const H = require('./hours');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

const ADMIN_SESSION_MS = 12 * 3600 * 1000;
const LOCKOUT_FAILS = 5;
const LOCKOUT_MS = 60 * 1000;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra; // e.g. { code } so the kiosk can show the message in the employee's language
  }
}

function createApp(store, { now = () => Date.now() } = {}) {
  const sessions = new Map(); // token -> expiry
  const failures = new Map(); // ip -> { count, until }

  // ---------- brute force protection ----------
  function checkLock(ip) {
    const f = failures.get(ip);
    if (f && f.until > now()) {
      const secs = Math.ceil((f.until - now()) / 1000);
      throw new HttpError(429, `Too many wrong PINs. Try again in ${secs} seconds.`, { code: 'locked', retry_after: secs });
    }
  }
  function recordFail(ip) {
    const f = failures.get(ip) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= LOCKOUT_FAILS) {
      f.count = 0;
      f.until = now() + LOCKOUT_MS;
    }
    failures.set(ip, f);
  }
  function clearFail(ip) {
    failures.delete(ip);
  }

  // ---------- validation ----------
  function validPin(pin) {
    const len = Number(store.getSetting('pin_length')) || 4;
    return typeof pin === 'string' && new RegExp(`^\\d{${len}}$`).test(pin);
  }
  function requirePin(pin) {
    const len = Number(store.getSetting('pin_length')) || 4;
    if (!validPin(pin)) throw new HttpError(400, `PIN must be exactly ${len} digits.`);
  }
  function requireName(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
      throw new HttpError(400, 'Name is required (max 80 characters).');
    }
    return name.trim();
  }
  function parseRange(q) {
    const from = H.parseDate(q.get('from'));
    const toDay = H.parseDate(q.get('to'));
    if (from == null || toDay == null) throw new HttpError(400, 'from and to dates (YYYY-MM-DD) are required.');
    const to = H.addDays(toDay, 1); // inclusive end date
    if (to <= from) throw new HttpError(400, '"to" must be on or after "from".');
    if (to - from > 400 * 86400000) throw new HttpError(400, 'Date range is too long (max ~13 months).');
    return { from, to };
  }
  function parsePunchBody(body) {
    const clockIn = H.parseDateTime(body.clock_in);
    if (clockIn == null) throw new HttpError(400, 'Clock-in time is required.');
    let clockOut = null;
    if (body.clock_out != null && body.clock_out !== '') {
      clockOut = H.parseDateTime(body.clock_out);
      if (clockOut == null) throw new HttpError(400, 'Clock-out time is invalid.');
      if (clockOut <= clockIn) throw new HttpError(400, 'Clock-out must be after clock-in.');
      if (clockOut - clockIn > 24 * 3600 * 1000) throw new HttpError(400, 'A single shift cannot be longer than 24 hours.');
    }
    if (clockIn > now() + 60000 || (clockOut != null && clockOut > now() + 60000)) {
      throw new HttpError(400, 'Times cannot be in the future.');
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    return { clockIn, clockOut, note };
  }
  function fmt(ms) {
    if (ms == null) return '(open)';
    const d = new Date(ms);
    return `${H.dateKey(ms)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ---------- hours ----------
  function hoursFor(employeeId, from, to) {
    const rules = store.rules();
    const calcStart = H.startOfWeek(from, rules.weekStartDay);
    const punches = store.punchesInRange(employeeId, calcStart, to);
    return H.calculateHours(punches, rules, from, to, now());
  }
  function currentWeek() {
    const rules = store.rules();
    const from = H.startOfWeek(now(), rules.weekStartDay);
    return { from, to: H.addDays(from, 7) };
  }
  function summarize(r) {
    return {
      regular: H.msToHours(r.regularMs),
      overtime: H.msToHours(r.overtimeMs),
      total: H.msToHours(r.regularMs) + H.msToHours(r.overtimeMs),
    };
  }

  function buildReport(from, to) {
    const employees = store.listEmployees();
    const rows = [];
    for (const e of employees) {
      const r = hoursFor(e.id, from, to);
      if (!e.active && r.totalMs === 0) continue;
      const days = Object.entries(r.days).sort().map(([date, d]) => ({
        date,
        regular: H.msToHours(d.regularMs),
        overtime: H.msToHours(d.overtimeMs),
      }));
      rows.push({ employee_id: e.id, name: e.name, active: !!e.active, open: r.open, ...summarize(r), days });
    }
    const totals = rows.reduce((t, r) => ({
      regular: round2(t.regular + r.regular),
      overtime: round2(t.overtime + r.overtime),
      total: round2(t.total + r.total),
    }), { regular: 0, overtime: 0, total: 0 });
    return { from: H.dateKey(from), to: H.dateKey(H.addDays(to, -1)), rules: store.rules(), rows, totals };
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, admin: !!opts.admin });
  };

  // Public: kiosk info
  route('GET', '/api/info', () => {
    const s = store.publicSettings();
    return { company_name: s.company_name, pin_length: s.pin_length, admin_pin_set: s.admin_pin_set, server_time: now() };
  });

  // Kiosk: look up an employee by PIN and return their status.
  route('POST', '/api/kiosk/lookup', ({ body, ip }) => {
    checkLock(ip);
    const emp = validPin(body.pin) ? store.findEmployeeByPin(body.pin) : null;
    if (!emp || !emp.active) {
      recordFail(ip);
      throw new HttpError(401, 'PIN not recognized.', { code: 'pin_not_recognized' });
    }
    clearFail(ip);
    const open = store.openPunch(emp.id);
    const wk = currentWeek();
    return {
      name: emp.name,
      clocked_in: !!open,
      clocked_in_at: open ? open.clock_in : null,
      week: summarize(hoursFor(emp.id, wk.from, wk.to)),
    };
  });

  // Kiosk: clock in or out. `action` must match the employee's current state,
  // which prevents accidental double punches.
  route('POST', '/api/kiosk/punch', ({ body, ip }) => {
    checkLock(ip);
    const emp = validPin(body.pin) ? store.findEmployeeByPin(body.pin) : null;
    if (!emp || !emp.active) {
      recordFail(ip);
      throw new HttpError(401, 'PIN not recognized.', { code: 'pin_not_recognized' });
    }
    clearFail(ip);
    const t = now();
    const result = store.tx(() => {
      const open = store.openPunch(emp.id);
      if (body.action === 'in') {
        if (open) throw new HttpError(409, 'You are already clocked in.', { code: 'already_in' });
        const id = store.clockIn(emp.id, t);
        store.audit('kiosk', 'clock_in', { employeeId: emp.id, punchId: id, details: fmt(t) });
        return { action: 'in', at: t };
      }
      if (body.action === 'out') {
        if (!open) throw new HttpError(409, 'You are not clocked in.', { code: 'not_in' });
        store.clockOut(open.id, t);
        store.audit('kiosk', 'clock_out', { employeeId: emp.id, punchId: open.id, details: fmt(t) });
        return { action: 'out', at: t, shift_hours: H.msToHours(t - open.clock_in) };
      }
      throw new HttpError(400, 'Invalid action.');
    });
    const wk = currentWeek();
    return { name: emp.name, ...result, week: summarize(hoursFor(emp.id, wk.from, wk.to)) };
  });

  // Admin auth
  route('POST', '/api/admin/setup', ({ body }) => {
    if (store.getSetting('admin_pin_hash')) throw new HttpError(409, 'Admin PIN is already set.');
    if (typeof body.pin !== 'string' || !/^\d{4,8}$/.test(body.pin)) throw new HttpError(400, 'Admin PIN must be 4-8 digits.');
    store.setAdminPin(body.pin);
    store.audit('admin', 'admin_pin_set', { details: 'Initial setup' });
    return { ok: true, ...startSession() };
  });

  route('POST', '/api/admin/login', ({ body, ip }) => {
    checkLock(ip);
    if (typeof body.pin !== 'string' || !store.checkAdminPin(body.pin)) {
      recordFail(ip);
      throw new HttpError(401, 'Wrong admin PIN.');
    }
    clearFail(ip);
    return { ok: true, ...startSession() };
  });

  function startSession() {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, now() + ADMIN_SESSION_MS);
    return { _setCookie: token };
  }

  route('POST', '/api/admin/logout', ({ token }) => {
    sessions.delete(token);
    return { ok: true, _clearCookie: true };
  });

  route('GET', '/api/admin/me', () => ({ ok: true }), { admin: true });

  // Who's clocked in right now + this week's totals
  route('GET', '/api/admin/dashboard', () => {
    const wk = currentWeek();
    const employees = store.listEmployees().filter((e) => e.active || e.clocked_in_at);
    return {
      week_from: H.dateKey(wk.from),
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        active: !!e.active,
        clocked_in_at: e.clocked_in_at,
        week: summarize(hoursFor(e.id, wk.from, wk.to)),
      })),
    };
  }, { admin: true });

  // Employees
  route('GET', '/api/admin/employees', () => store.listEmployees(), { admin: true });

  route('POST', '/api/admin/employees', ({ body }) => {
    const name = requireName(body.name);
    requirePin(body.pin);
    if (store.pinInUse(body.pin)) throw new HttpError(409, 'That PIN is already used by another employee.');
    const id = store.createEmployee(name, body.pin);
    store.audit('admin', 'employee_created', { employeeId: id, details: name });
    return store.getEmployee(id);
  }, { admin: true });

  route('PUT', '/api/admin/employees/:id', ({ params, body }) => {
    const id = Number(params.id);
    const emp = store.getEmployee(id);
    if (!emp) throw new HttpError(404, 'Employee not found.');
    const changes = {};
    const notes = [];
    if (body.name != null) {
      changes.name = requireName(body.name);
      if (changes.name !== emp.name) notes.push(`name: "${emp.name}" -> "${changes.name}"`);
    }
    if (body.pin != null && body.pin !== '') {
      requirePin(body.pin);
      if (store.pinInUse(body.pin, id)) throw new HttpError(409, 'That PIN is already used by another employee.');
      changes.pin = body.pin;
      notes.push('PIN changed');
    }
    if (body.active != null) {
      changes.active = !!body.active;
      if (changes.active !== !!emp.active) notes.push(changes.active ? 'reactivated' : 'deactivated');
    }
    store.updateEmployee(id, changes);
    if (notes.length) store.audit('admin', 'employee_updated', { employeeId: id, details: notes.join('; ') });
    return store.getEmployee(id);
  }, { admin: true });

  // Punches
  route('GET', '/api/admin/punches', ({ query }) => {
    const { from, to } = parseRange(query);
    const emp = query.get('employee_id');
    const employeeId = emp ? Number(emp) : null;
    return store.punchesInRange(employeeId, from, to);
  }, { admin: true });

  route('POST', '/api/admin/punches', ({ body }) => {
    const employeeId = Number(body.employee_id);
    if (!store.getEmployee(employeeId)) throw new HttpError(404, 'Employee not found.');
    const { clockIn, clockOut, note } = parsePunchBody(body);
    return store.tx(() => {
      const overlap = store.findOverlap(employeeId, clockIn, clockOut);
      if (overlap) throw new HttpError(409, `Overlaps an existing punch (${fmt(overlap.clock_in)} - ${fmt(overlap.clock_out)}).`);
      const id = store.createPunch(employeeId, clockIn, clockOut, note);
      store.audit('admin', 'punch_added', { employeeId, punchId: id, details: `${fmt(clockIn)} - ${fmt(clockOut)}${note ? ` | ${note}` : ''}` });
      return store.getPunch(id);
    });
  }, { admin: true });

  route('PUT', '/api/admin/punches/:id', ({ params, body }) => {
    const id = Number(params.id);
    const p = store.getPunch(id);
    if (!p) throw new HttpError(404, 'Punch not found.');
    const { clockIn, clockOut, note } = parsePunchBody(body);
    return store.tx(() => {
      const overlap = store.findOverlap(p.employee_id, clockIn, clockOut, id);
      if (overlap) throw new HttpError(409, `Overlaps an existing punch (${fmt(overlap.clock_in)} - ${fmt(overlap.clock_out)}).`);
      store.updatePunch(id, clockIn, clockOut, note);
      store.audit('admin', 'punch_edited', {
        employeeId: p.employee_id,
        punchId: id,
        details: `was ${fmt(p.clock_in)} - ${fmt(p.clock_out)}; now ${fmt(clockIn)} - ${fmt(clockOut)}${note ? ` | ${note}` : ''}`,
      });
      return store.getPunch(id);
    });
  }, { admin: true });

  route('DELETE', '/api/admin/punches/:id', ({ params, query }) => {
    const id = Number(params.id);
    const p = store.getPunch(id);
    if (!p) throw new HttpError(404, 'Punch not found.');
    const reason = (query.get('reason') || '').slice(0, 500);
    store.deletePunch(id);
    store.audit('admin', 'punch_deleted', {
      employeeId: p.employee_id,
      punchId: id,
      details: `${fmt(p.clock_in)} - ${fmt(p.clock_out)}${reason ? ` | ${reason}` : ''}`,
    });
    return { ok: true };
  }, { admin: true });

  // Clock out an employee who forgot (admin)
  route('POST', '/api/admin/employees/:id/clock-out', ({ params }) => {
    const id = Number(params.id);
    const open = store.openPunch(id);
    if (!open) throw new HttpError(409, 'Employee is not clocked in.');
    const t = now();
    store.clockOut(open.id, t);
    store.db.prepare('UPDATE punches SET edited = 1 WHERE id = ?').run(open.id);
    store.audit('admin', 'admin_clock_out', { employeeId: id, punchId: open.id, details: fmt(t) });
    return { ok: true };
  }, { admin: true });

  // Reports
  route('GET', '/api/admin/report', ({ query }) => {
    const { from, to } = parseRange(query);
    return buildReport(from, to);
  }, { admin: true });

  route('GET', '/api/admin/report.csv', ({ query }) => {
    const { from, to } = parseRange(query);
    const rep = buildReport(from, to);
    const detail = query.get('detail') === '1';
    const lines = [];
    if (detail) {
      lines.push(['Employee', 'Date', 'Regular Hours', 'Overtime Hours', 'Total Hours']);
      for (const r of rep.rows) {
        for (const d of r.days) lines.push([r.name, d.date, d.regular.toFixed(2), d.overtime.toFixed(2), (d.regular + d.overtime).toFixed(2)]);
      }
    } else {
      lines.push(['Employee', 'Period Start', 'Period End', 'Regular Hours', 'Overtime Hours', 'Total Hours']);
      for (const r of rep.rows) {
        lines.push([r.name, rep.from, rep.to, r.regular.toFixed(2), r.overtime.toFixed(2), r.total.toFixed(2)]);
      }
    }
    const csv = lines.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    return {
      _raw: csv,
      _type: 'text/csv; charset=utf-8',
      _filename: `timesheet_${rep.from}_to_${rep.to}${detail ? '_daily' : ''}.csv`,
    };
  }, { admin: true });

  // Settings
  route('GET', '/api/admin/settings', () => store.publicSettings(), { admin: true });

  route('PUT', '/api/admin/settings', ({ body }) => {
    const notes = [];
    const s = store.publicSettings();
    if (body.company_name != null) {
      const v = String(body.company_name).trim().slice(0, 80);
      if (!v) throw new HttpError(400, 'Company name cannot be empty.');
      if (v !== s.company_name) { store.setSetting('company_name', v); notes.push(`company name: ${v}`); }
    }
    const num = (key, min, max, label) => {
      if (body[key] == null) return;
      const v = Number(body[key]);
      if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
      if (v !== s[key]) { store.setSetting(key, v); notes.push(`${label}: ${v}`); }
    };
    num('weekly_ot_hours', 0, 168, 'Weekly overtime threshold');
    num('daily_ot_hours', 0, 24, 'Daily overtime threshold');
    num('week_start_day', 0, 6, 'Week start day');
    if (body.pin_length != null && Number(body.pin_length) !== s.pin_length) {
      const v = Number(body.pin_length);
      if (![4, 5, 6].includes(v)) throw new HttpError(400, 'PIN length must be 4, 5 or 6.');
      if (store.listEmployees().length > 0) {
        throw new HttpError(400, 'PIN length can only be changed before any employees are added.');
      }
      store.setSetting('pin_length', v);
      notes.push(`PIN length: ${v}`);
    }
    if (body.new_admin_pin) {
      if (!/^\d{4,8}$/.test(body.new_admin_pin)) throw new HttpError(400, 'Admin PIN must be 4-8 digits.');
      store.setAdminPin(body.new_admin_pin);
      notes.push('admin PIN changed');
    }
    if (notes.length) store.audit('admin', 'settings_changed', { details: notes.join('; ') });
    return store.publicSettings();
  }, { admin: true });

  route('GET', '/api/admin/audit', ({ query }) => {
    const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 200));
    const offset = Math.max(0, Number(query.get('offset')) || 0);
    return store.listAudit(limit, offset);
  }, { admin: true });

  route('GET', '/api/admin/backup', () => {
    const tmp = path.join(os.tmpdir(), `timeclock-backup-${crypto.randomBytes(6).toString('hex')}.db`);
    store.backupTo(tmp);
    const data = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return { _raw: data, _type: 'application/octet-stream', _filename: `timeclock-backup-${H.dateKey(now())}.db` };
  }, { admin: true });

  // ---------- request handling ----------
  function getCookie(req, name) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
    return m ? m[1] : null;
  }

  function isAdmin(token) {
    if (!token) return false;
    const exp = sessions.get(token);
    if (!exp || exp < now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  async function readBody(req) {
    if (req.method === 'GET' || req.method === 'DELETE') return {};
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new HttpError(413, 'Request too large.');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return b && typeof b === 'object' ? b : {};
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
  }

  function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/admin') pathname = '/admin.html';
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(404).end('Not found');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      serveStatic(req, res, pathname);
      return;
    }

    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(obj));
    };

    try {
      let match = null;
      let methodMismatch = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.method !== req.method) { methodMismatch = true; continue; }
        match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) };
        break;
      }
      if (!match) throw new HttpError(methodMismatch ? 405 : 404, 'Not found.');

      const token = getCookie(req, 'tc_admin');
      if (match.r.admin && !isAdmin(token)) throw new HttpError(401, 'Admin login required.');

      const body = await readBody(req);
      const ip = req.socket.remoteAddress || 'unknown';
      const out = await match.r.handler({ req, body, params: match.params, query: url.searchParams, ip, token });

      if (out && out._raw != null) {
        res.writeHead(200, {
          'Content-Type': out._type,
          'Content-Disposition': `attachment; filename="${out._filename}"`,
          'Cache-Control': 'no-store',
        });
        res.end(out._raw);
        return;
      }
      const headers = {};
      if (out && out._setCookie) {
        headers['Set-Cookie'] = `tc_admin=${out._setCookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_MS / 1000}`;
        delete out._setCookie;
      }
      if (out && out._clearCookie) {
        headers['Set-Cookie'] = 'tc_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
        delete out._clearCookie;
      }
      send(200, out, headers);
    } catch (e) {
      if (e instanceof HttpError) {
        send(e.status, { error: e.message, ...e.extra });
      } else {
        console.error(e);
        send(500, { error: 'Server error.' });
      }
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
}

function csvCell(v) {
  const s = String(v);
  // Neutralize spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { createApp };

if (require.main === module) {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'timeclock.db');
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const store = dbmod.open(dbPath);
  const server = createApp(store);
  server.listen(port, host, () => {
    console.log(`Time clock running.`);
    console.log(`  Database: ${dbPath}`);
    const addrs = Object.values(os.networkInterfaces()).flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
    console.log(`  Kiosk:    http://localhost:${port}/`);
    for (const a of addrs) console.log(`  Tablet:   http://${a}:${port}/   (admin: http://${a}:${port}/admin)`);
  });
}
