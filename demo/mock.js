// In-browser stand-in for the time clock server, so the real kiosk and admin
// screens can run inside a single page. Data is kept in this browser only.
(function () {
  const H = window.__hours;
  const KEY = 'kuipers-timeclock-demo-v1';
  const DEMO_ADMIN_PIN = '9999';
  const DEMO_PINS = [['Maria Lopez', '1111'], ['Dave Kuipers', '2222'], ['Sam Chen', '3333']];
  window.__demo = { adminPin: DEMO_ADMIN_PIN, pins: DEMO_PINS };

  let state = null;
  let adminSession = false;
  const failures = { count: 0, until: 0 };

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: keep in memory */ }
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && s.v === 1) return s;
    } catch { /* ignore */ }
    return null;
  }

  // ---------- seed ----------
  function seed() {
    const now = Date.now();
    state = {
      v: 1,
      settings: { company_name: 'Kuipers', weekly_ot_hours: 40, daily_ot_hours: 0, week_start_day: 0, pin_length: 4, admin_pin: DEMO_ADMIN_PIN },
      employees: [],
      punches: [],
      audit: [],
      ids: { e: 0, p: 0, a: 0 },
    };
    const weekAgo = H.addDays(H.startOfDay(now), -21);
    for (const [name, pin] of DEMO_PINS) {
      state.employees.push({ id: ++state.ids.e, name, pin, active: 1, created_at: weekAgo });
    }
    const at = (day, h, m) => { const d = new Date(day); d.setHours(h, m || 0, 0, 0); return d.getTime(); };
    const add = (empId, cin, cout, note, edited) => {
      const id = ++state.ids.p;
      state.punches.push({ id, employee_id: empId, clock_in: cin, clock_out: cout, note: note || '', edited: edited ? 1 : 0, created_at: cin, updated_at: cout || cin });
      if (edited) {
        audit('admin', 'punch_edited', empId, id, `was ${fmt(cin)} - (open); now ${fmt(cin)} - ${fmt(cout)} | ${note}`, cout + 3600000 * 15);
      } else {
        audit('kiosk', 'clock_in', empId, id, fmt(cin), cin);
        if (cout) audit('kiosk', 'clock_out', empId, id, fmt(cout), cout);
      }
    };
    const thisWeek = H.startOfWeek(now, 0);
    const today = H.startOfDay(now);
    for (let day = H.addDays(thisWeek, -7); day < today; day = H.addDays(day, 1)) {
      const dow = new Date(day).getDay();
      if (dow === 0 || dow === 6) continue;
      add(1, at(day, 6), at(day, 17)); // Maria: 11 h days -> overtime
      add(2, at(day, 8), at(day, 16, 30)); // Dave: 8.5 h days
      if (dow % 2 === 1) {
        const forgot = dow === 3 && day < thisWeek;
        add(3, at(day, 9), at(day, 15), forgot ? 'Forgot to clock out, fixed by admin' : '', forgot);
      }
    }
    // Dave is clocked in right now.
    const start = now >= at(today, 8) ? at(today, 8) : now - 45 * 60000;
    add(2, start, null);
    state.audit.sort((a, b) => a.at - b.at);
    save();
  }

  state = load();
  if (!state) seed();
  window.__demo.reset = () => { localStorage.removeItem(KEY); seed(); adminSession = false; };

  // ---------- helpers ----------
  class HttpError extends Error { constructor(status, msg, extra = {}) { super(msg); this.status = status; this.extra = extra; } }
  const now = () => Date.now();
  function fmt(ms) {
    if (ms == null) return '(open)';
    const d = new Date(ms);
    return `${H.dateKey(ms)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function audit(actor, action, employeeId, punchId, details, when) {
    state.audit.push({ id: ++state.ids.a, at: when || now(), actor, action, employee_id: employeeId, punch_id: punchId, details: details || '' });
  }
  const rules = () => ({ weeklyOtHours: state.settings.weekly_ot_hours, dailyOtHours: state.settings.daily_ot_hours, weekStartDay: state.settings.week_start_day });
  const emp = (id) => state.employees.find((e) => e.id === id) || null;
  const byPin = (pin) => state.employees.find((e) => e.pin === pin) || null;
  const openPunch = (id) => state.punches.filter((p) => p.employee_id === id && p.clock_out == null).sort((a, b) => b.clock_in - a.clock_in)[0] || null;
  const publicEmp = (e) => ({ id: e.id, name: e.name, active: e.active, created_at: e.created_at });
  function listEmployees() {
    return [...state.employees]
      .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map((e) => { const o = openPunch(e.id); return { ...publicEmp(e), clocked_in_at: o ? o.clock_in : null }; });
  }
  function punchesInRange(employeeId, from, to) {
    return state.punches
      .filter((p) => p.clock_in < to && (p.clock_out == null || p.clock_out > from) && (employeeId == null || p.employee_id === employeeId))
      .sort((a, b) => a.clock_in - b.clock_in)
      .map((p) => ({ ...p, employee_name: emp(p.employee_id).name }));
  }
  function findOverlap(employeeId, cin, cout, exceptId) {
    const end = cout == null ? Number.MAX_SAFE_INTEGER : cout;
    return state.punches.find((p) => p.employee_id === employeeId && p.id !== exceptId && p.clock_in < end && (p.clock_out == null || p.clock_out > cin)) || null;
  }
  function hoursFor(employeeId, from, to) {
    const r = rules();
    return H.calculateHours(punchesInRange(employeeId, H.startOfWeek(from, r.weekStartDay), to), r, from, to, now());
  }
  function currentWeek() {
    const from = H.startOfWeek(now(), state.settings.week_start_day);
    return { from, to: H.addDays(from, 7) };
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  function summarize(r) {
    return { regular: H.msToHours(r.regularMs), overtime: H.msToHours(r.overtimeMs), total: round2(H.msToHours(r.regularMs) + H.msToHours(r.overtimeMs)) };
  }
  function checkLock() {
    if (failures.until > now()) { const secs = Math.ceil((failures.until - now()) / 1000); throw new HttpError(429, `Too many wrong PINs. Try again in ${secs} seconds.`, { code: 'locked', retry_after: secs }); }
  }
  function fail() {
    failures.count += 1;
    if (failures.count >= 5) { failures.count = 0; failures.until = now() + 60000; }
  }
  const validPin = (pin) => typeof pin === 'string' && new RegExp(`^\\d{${state.settings.pin_length}}$`).test(pin);
  function requirePin(pin) { if (!validPin(pin)) throw new HttpError(400, `PIN must be exactly ${state.settings.pin_length} digits.`); }
  function requireName(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new HttpError(400, 'Name is required (max 80 characters).');
    return name.trim();
  }
  const pinInUse = (pin, exceptId) => state.employees.some((e) => e.pin === pin && e.id !== exceptId);
  function parseRange(q) {
    const from = H.parseDate(q.get('from'));
    const toDay = H.parseDate(q.get('to'));
    if (from == null || toDay == null) throw new HttpError(400, 'Pick a From and To date.');
    const to = H.addDays(toDay, 1);
    if (to <= from) throw new HttpError(400, '"To" must be on or after "From".');
    return { from, to };
  }
  function parsePunchBody(b) {
    const cin = H.parseDateTime(b.clock_in);
    if (cin == null) throw new HttpError(400, 'Clock-in time is required.');
    let cout = null;
    if (b.clock_out) {
      cout = H.parseDateTime(b.clock_out);
      if (cout == null) throw new HttpError(400, 'Clock-out time is invalid.');
      if (cout <= cin) throw new HttpError(400, 'Clock-out must be after clock-in.');
      if (cout - cin > 86400000) throw new HttpError(400, 'A single shift cannot be longer than 24 hours.');
    }
    if (cin > now() + 60000 || (cout != null && cout > now() + 60000)) throw new HttpError(400, 'Times cannot be in the future.');
    return { cin, cout, note: typeof b.note === 'string' ? b.note.trim().slice(0, 500) : '' };
  }
  function buildReport(from, to) {
    const rows = [];
    for (const e of listEmployees()) {
      const r = hoursFor(e.id, from, to);
      if (!e.active && r.totalMs === 0) continue;
      const days = Object.entries(r.days).sort().map(([date, d]) => ({ date, regular: H.msToHours(d.regularMs), overtime: H.msToHours(d.overtimeMs) }));
      rows.push({ employee_id: e.id, name: e.name, active: !!e.active, open: r.open, ...summarize(r), days });
    }
    const totals = rows.reduce((t, r) => ({ regular: round2(t.regular + r.regular), overtime: round2(t.overtime + r.overtime), total: round2(t.total + r.total) }), { regular: 0, overtime: 0, total: 0 });
    return { from: H.dateKey(from), to: H.dateKey(H.addDays(to, -1)), rules: rules(), rows, totals };
  }
  function csvCell(v) {
    const s = String(v);
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, admin) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, admin: !!admin });
  };

  route('GET', '/api/info', () => ({ company_name: state.settings.company_name, pin_length: state.settings.pin_length, admin_pin_set: true, server_time: now() }));

  function kioskEmployee(body) {
    checkLock();
    const e = validPin(body.pin) ? byPin(body.pin) : null;
    if (!e || !e.active) { fail(); throw new HttpError(401, 'PIN not recognized.', { code: 'pin_not_recognized' }); }
    failures.count = 0;
    return e;
  }
  route('POST', '/api/kiosk/lookup', ({ body }) => {
    const e = kioskEmployee(body);
    const o = openPunch(e.id);
    const wk = currentWeek();
    return { name: e.name, clocked_in: !!o, clocked_in_at: o ? o.clock_in : null, week: summarize(hoursFor(e.id, wk.from, wk.to)) };
  });
  route('POST', '/api/kiosk/punch', ({ body }) => {
    const e = kioskEmployee(body);
    const t = now();
    const o = openPunch(e.id);
    let result;
    if (body.action === 'in') {
      if (o) throw new HttpError(409, 'You are already clocked in.', { code: 'already_in' });
      const id = ++state.ids.p;
      state.punches.push({ id, employee_id: e.id, clock_in: t, clock_out: null, note: '', edited: 0, created_at: t, updated_at: t });
      audit('kiosk', 'clock_in', e.id, id, fmt(t));
      result = { action: 'in', at: t };
    } else if (body.action === 'out') {
      if (!o) throw new HttpError(409, 'You are not clocked in.', { code: 'not_in' });
      o.clock_out = t; o.updated_at = t;
      audit('kiosk', 'clock_out', e.id, o.id, fmt(t));
      result = { action: 'out', at: t, shift_hours: H.msToHours(t - o.clock_in) };
    } else throw new HttpError(400, 'Invalid action.');
    const wk = currentWeek();
    return { name: e.name, ...result, week: summarize(hoursFor(e.id, wk.from, wk.to)) };
  });

  route('POST', '/api/admin/login', ({ body }) => {
    checkLock();
    if (body.pin !== state.settings.admin_pin) { fail(); throw new HttpError(401, 'Wrong admin PIN.'); }
    failures.count = 0;
    adminSession = true;
    return { ok: true };
  });
  route('POST', '/api/admin/logout', () => { adminSession = false; return { ok: true }; });
  route('GET', '/api/admin/me', () => ({ ok: true }), true);

  route('GET', '/api/admin/dashboard', () => {
    const wk = currentWeek();
    return {
      week_from: H.dateKey(wk.from),
      employees: listEmployees().filter((e) => e.active || e.clocked_in_at).map((e) => ({
        id: e.id, name: e.name, active: !!e.active, clocked_in_at: e.clocked_in_at, week: summarize(hoursFor(e.id, wk.from, wk.to)),
      })),
    };
  }, true);

  route('GET', '/api/admin/employees', () => listEmployees(), true);
  route('POST', '/api/admin/employees', ({ body }) => {
    const name = requireName(body.name);
    requirePin(body.pin);
    if (pinInUse(body.pin)) throw new HttpError(409, 'That PIN is already used by another employee.');
    const e = { id: ++state.ids.e, name, pin: body.pin, active: 1, created_at: now() };
    state.employees.push(e);
    audit('admin', 'employee_created', e.id, null, name);
    return publicEmp(e);
  }, true);
  route('PUT', '/api/admin/employees/:id', ({ params, body }) => {
    const e = emp(Number(params.id));
    if (!e) throw new HttpError(404, 'Employee not found.');
    const notes = [];
    if (body.name != null) {
      const n = requireName(body.name);
      if (n !== e.name) { notes.push(`name: "${e.name}" -> "${n}"`); e.name = n; }
    }
    if (body.pin) {
      requirePin(body.pin);
      if (pinInUse(body.pin, e.id)) throw new HttpError(409, 'That PIN is already used by another employee.');
      e.pin = body.pin; notes.push('PIN changed');
    }
    if (body.active != null && !!body.active !== !!e.active) {
      e.active = body.active ? 1 : 0; notes.push(body.active ? 'reactivated' : 'deactivated');
    }
    if (notes.length) audit('admin', 'employee_updated', e.id, null, notes.join('; '));
    return publicEmp(e);
  }, true);
  route('POST', '/api/admin/employees/:id/clock-out', ({ params }) => {
    const id = Number(params.id);
    const o = openPunch(id);
    if (!o) throw new HttpError(409, 'Employee is not clocked in.');
    const t = now();
    o.clock_out = t; o.updated_at = t; o.edited = 1;
    audit('admin', 'admin_clock_out', id, o.id, fmt(t));
    return { ok: true };
  }, true);

  route('GET', '/api/admin/punches', ({ query }) => {
    const { from, to } = parseRange(query);
    const e = query.get('employee_id');
    return punchesInRange(e ? Number(e) : null, from, to);
  }, true);
  route('POST', '/api/admin/punches', ({ body }) => {
    const employeeId = Number(body.employee_id);
    if (!emp(employeeId)) throw new HttpError(404, 'Employee not found.');
    const { cin, cout, note } = parsePunchBody(body);
    const ov = findOverlap(employeeId, cin, cout);
    if (ov) throw new HttpError(409, `Overlaps an existing punch (${fmt(ov.clock_in)} - ${fmt(ov.clock_out)}).`);
    const t = now();
    const p = { id: ++state.ids.p, employee_id: employeeId, clock_in: cin, clock_out: cout, note, edited: 1, created_at: t, updated_at: t };
    state.punches.push(p);
    audit('admin', 'punch_added', employeeId, p.id, `${fmt(cin)} - ${fmt(cout)}${note ? ` | ${note}` : ''}`);
    return p;
  }, true);
  route('PUT', '/api/admin/punches/:id', ({ params, body }) => {
    const p = state.punches.find((x) => x.id === Number(params.id));
    if (!p) throw new HttpError(404, 'Punch not found.');
    const { cin, cout, note } = parsePunchBody(body);
    const ov = findOverlap(p.employee_id, cin, cout, p.id);
    if (ov) throw new HttpError(409, `Overlaps an existing punch (${fmt(ov.clock_in)} - ${fmt(ov.clock_out)}).`);
    audit('admin', 'punch_edited', p.employee_id, p.id, `was ${fmt(p.clock_in)} - ${fmt(p.clock_out)}; now ${fmt(cin)} - ${fmt(cout)}${note ? ` | ${note}` : ''}`);
    Object.assign(p, { clock_in: cin, clock_out: cout, note, edited: 1, updated_at: now() });
    return p;
  }, true);
  route('DELETE', '/api/admin/punches/:id', ({ params, query }) => {
    const i = state.punches.findIndex((x) => x.id === Number(params.id));
    if (i < 0) throw new HttpError(404, 'Punch not found.');
    const p = state.punches[i];
    const reason = (query.get('reason') || '').slice(0, 500);
    state.punches.splice(i, 1);
    audit('admin', 'punch_deleted', p.employee_id, p.id, `${fmt(p.clock_in)} - ${fmt(p.clock_out)}${reason ? ` | ${reason}` : ''}`);
    return { ok: true };
  }, true);

  route('GET', '/api/admin/report', ({ query }) => { const { from, to } = parseRange(query); return buildReport(from, to); }, true);
  route('GET', '/api/admin/report.csv', ({ query }) => {
    const { from, to } = parseRange(query);
    const rep = buildReport(from, to);
    const detail = query.get('detail') === '1';
    const lines = [];
    if (detail) {
      lines.push(['Employee', 'Date', 'Regular Hours', 'Overtime Hours', 'Total Hours']);
      for (const r of rep.rows) for (const d of r.days) lines.push([r.name, d.date, d.regular.toFixed(2), d.overtime.toFixed(2), (d.regular + d.overtime).toFixed(2)]);
    } else {
      lines.push(['Employee', 'Period Start', 'Period End', 'Regular Hours', 'Overtime Hours', 'Total Hours']);
      for (const r of rep.rows) lines.push([r.name, rep.from, rep.to, r.regular.toFixed(2), r.overtime.toFixed(2), r.total.toFixed(2)]);
    }
    return { _text: lines.map((row) => row.map(csvCell).join(',')).join('\n') };
  }, true);

  const publicSettings = () => {
    const { admin_pin, ...s } = state.settings;
    return { ...s, admin_pin_set: true };
  };
  route('GET', '/api/admin/settings', publicSettings, true);
  route('PUT', '/api/admin/settings', ({ body }) => {
    const s = state.settings;
    const notes = [];
    if (body.company_name != null) {
      const v = String(body.company_name).trim().slice(0, 80);
      if (!v) throw new HttpError(400, 'Company name cannot be empty.');
      if (v !== s.company_name) { s.company_name = v; notes.push(`company name: ${v}`); }
    }
    const num = (key, min, max, label) => {
      if (body[key] == null) return;
      const v = Number(body[key]);
      if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
      if (v !== s[key]) { s[key] = v; notes.push(`${label}: ${v}`); }
    };
    num('weekly_ot_hours', 0, 168, 'Weekly overtime threshold');
    num('daily_ot_hours', 0, 24, 'Daily overtime threshold');
    num('week_start_day', 0, 6, 'Week start day');
    if (body.pin_length != null && Number(body.pin_length) !== s.pin_length) {
      throw new HttpError(400, 'PIN length can only be changed before any employees are added.');
    }
    if (body.new_admin_pin) {
      if (!/^\d{4,8}$/.test(body.new_admin_pin)) throw new HttpError(400, 'Admin PIN must be 4-8 digits.');
      s.admin_pin = body.new_admin_pin; notes.push('admin PIN changed');
    }
    if (notes.length) audit('admin', 'settings_changed', null, null, notes.join('; '));
    return publicSettings();
  }, true);

  route('GET', '/api/admin/audit', ({ query }) => {
    const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 200));
    const offset = Math.max(0, Number(query.get('offset')) || 0);
    return [...state.audit].sort((a, b) => (b.at - a.at) || (b.id - a.id)).slice(offset, offset + limit)
      .map((a) => ({ ...a, employee_name: a.employee_id ? (emp(a.employee_id) || {}).name : null }));
  }, true);

  // ---------- fetch shim ----------
  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async function (input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, 'https://demo.local');
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
    try {
      let match = null;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (m && r.method === method) { match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; }
      }
      if (!match) throw new HttpError(404, 'Not found.');
      if (match.r.admin && !adminSession) throw new HttpError(401, 'Admin login required.');
      const body = init.body ? JSON.parse(init.body) : {};
      const out = match.r.handler({ body, params: match.params, query: url.searchParams });
      if (method !== 'GET') save();
      if (out && out._text != null) return new Response(out._text, { status: 200, headers: { 'Content-Type': 'text/csv' } });
      return json(200, out);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message, ...e.extra });
      console.error(e);
      return json(500, { error: 'Something went wrong in the demo.' });
    }
  };
})();
