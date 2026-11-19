'use strict';
process.env.TZ = 'America/Chicago';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const { createApp } = require('../server/index');

async function setup() {
  const store = db.open(':memory:');
  let clock = new Date(2026, 10, 16, 8, 0).getTime(); // Mon Nov 16 2026 08:00
  const server = createApp(store, { now: () => clock });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  return { server, store, call, setClock: (d) => { clock = d.getTime(); } };
}

test('full flow: setup, employees, punches, overtime, edits', async (t) => {
  const { server, call, setClock } = await setup();
  t.after(() => server.close());

  // Admin endpoints are locked before login
  assert.equal((await call('GET', '/api/admin/employees')).status, 401);

  // First-time admin setup
  assert.equal((await call('POST', '/api/admin/setup', { pin: '9876' })).status, 200);
  assert.equal((await call('POST', '/api/admin/setup', { pin: '1111' })).status, 409);

  // Employees
  const a = await call('POST', '/api/admin/employees', { name: 'Alice', pin: '1234' });
  assert.equal(a.status, 200);
  assert.equal((await call('POST', '/api/admin/employees', { name: 'Bob', pin: '1234' })).status, 409);
  assert.equal((await call('POST', '/api/admin/employees', { name: 'Bob', pin: '12' })).status, 400);
  const b = await call('POST', '/api/admin/employees', { name: 'Bob', pin: '5678' });
  assert.equal(b.status, 200);

  // Kiosk
  const bad = await call('POST', '/api/kiosk/lookup', { pin: '0000' });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.code, 'pin_not_recognized');
  let r = await call('POST', '/api/kiosk/lookup', { pin: '1234' });
  assert.equal(r.data.name, 'Alice');
  assert.equal(r.data.clocked_in, false);
  r = await call('POST', '/api/kiosk/punch', { pin: '1234', action: 'out' });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'not_in');
  r = await call('POST', '/api/kiosk/punch', { pin: '1234', action: 'in' });
  assert.equal(r.data.action, 'in');
  assert.equal((await call('POST', '/api/kiosk/punch', { pin: '1234', action: 'in' })).status, 409);
  setClock(new Date(2026, 10, 16, 16, 30));
  r = await call('POST', '/api/kiosk/punch', { pin: '1234', action: 'out' });
  assert.equal(r.data.shift_hours, 8.5);
  assert.equal(r.data.week.regular, 8.5);

  setClock(new Date(2026, 10, 21, 12, 0));
  assert.equal((await call('GET', '/api/admin/employees')).status, 401); // session expired
  assert.equal((await call('POST', '/api/admin/login', { pin: '9876' })).status, 200);
  // Admin adds the rest of the week for Alice: Tue-Fri 9h each -> 44.5 total
  for (const d of ['17', '18', '19', '20']) {
    const res = await call('POST', '/api/admin/punches', {
      employee_id: a.data.id, clock_in: `2026-11-${d}T07:00`, clock_out: `2026-11-${d}T16:00`, note: 'paper timesheet',
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  }

  // Overlap is rejected
  const ov = await call('POST', '/api/admin/punches', { employee_id: a.data.id, clock_in: '2026-11-20T15:00', clock_out: '2026-11-20T18:00' });
  assert.equal(ov.status, 409);

  let rep = await call('GET', '/api/admin/report?from=2026-11-15&to=2026-11-21');
  let alice = rep.data.rows.find((x) => x.name === 'Alice');
  assert.equal(alice.regular, 40);
  assert.equal(alice.overtime, 4.5);
  assert.equal(alice.total, 44.5);

  // Edit Friday's punch to end an hour earlier -> 3.5 OT
  const punches = await call('GET', `/api/admin/punches?from=2026-11-20&to=2026-11-20&employee_id=${a.data.id}`);
  assert.equal(punches.data.length, 1);
  const ed = await call('PUT', `/api/admin/punches/${punches.data[0].id}`, { clock_in: '2026-11-20T07:00', clock_out: '2026-11-20T15:00', note: 'left early' });
  assert.equal(ed.status, 200);
  assert.equal(ed.data.edited, 1);
  rep = await call('GET', '/api/admin/report?from=2026-11-15&to=2026-11-21');
  alice = rep.data.rows.find((x) => x.name === 'Alice');
  assert.equal(alice.overtime, 3.5);

  // CSV
  const csv = await call('GET', '/api/admin/report.csv?from=2026-11-15&to=2026-11-21');
  assert.match(csv.data, /Alice,2026-11-15,2026-11-21,40\.00,3\.50,43\.50/);

  // Delete a punch
  const del = await call('DELETE', `/api/admin/punches/${punches.data[0].id}?reason=duplicate`);
  assert.equal(del.status, 200);

  // Bob forgets to clock out; admin clocks him out
  await call('POST', '/api/kiosk/punch', { pin: '5678', action: 'in' });
  let dash = await call('GET', '/api/admin/dashboard');
  assert.ok(dash.data.employees.find((x) => x.name === 'Bob').clocked_in_at);
  assert.equal((await call('POST', `/api/admin/employees/${b.data.id}/clock-out`)).status, 200);
  dash = await call('GET', '/api/admin/dashboard');
  assert.equal(dash.data.employees.find((x) => x.name === 'Bob').clocked_in_at, null);

  // Deactivated employees cannot clock in
  await call('PUT', `/api/admin/employees/${b.data.id}`, { active: false });
  assert.equal((await call('POST', '/api/kiosk/lookup', { pin: '5678' })).status, 401);

  // Audit log recorded things
  const audit = await call('GET', '/api/admin/audit');
  const actions = audit.data.map((x) => x.action);
  for (const act of ['clock_in', 'clock_out', 'punch_added', 'punch_edited', 'punch_deleted', 'admin_clock_out', 'employee_updated']) {
    assert.ok(actions.includes(act), act);
  }

  // Settings
  const s = await call('PUT', '/api/admin/settings', { daily_ot_hours: 8 });
  assert.equal(s.data.daily_ot_hours, 8);
  assert.equal((await call('PUT', '/api/admin/settings', { pin_length: 6 })).status, 400);

  // Logout
  await call('POST', '/api/admin/logout');
  assert.equal((await call('GET', '/api/admin/employees')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { pin: '9876' })).status, 200);
});

test('wrong PINs trigger a temporary lockout', async (t) => {
  const { server, call } = await setup();
  t.after(() => server.close());
  for (let i = 0; i < 5; i++) await call('POST', '/api/kiosk/lookup', { pin: '0000' });
  const locked = await call('POST', '/api/kiosk/lookup', { pin: '0000' });
  assert.equal(locked.status, 429);
  assert.equal(locked.data.code, 'locked');
  assert.ok(locked.data.retry_after > 0);
});

test('static files and path traversal', async (t) => {
  const { server, call } = await setup();
  t.after(() => server.close());
  assert.equal((await call('GET', '/')).status, 200);
  assert.equal((await call('GET', '/admin')).status, 200);
  assert.equal((await call('GET', '/../package.json')).status, 404);
  assert.equal((await call('GET', '/%2e%2e/package.json')).status, 404);
});
