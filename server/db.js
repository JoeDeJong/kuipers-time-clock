'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
  company_name: 'Kuipers',
  weekly_ot_hours: '40',
  daily_ot_hours: '0',
  week_start_day: '0',
  pin_length: '4',
};

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS employees (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      pin_hash    TEXT NOT NULL UNIQUE,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS punches (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id  INTEGER NOT NULL REFERENCES employees(id),
      clock_in     INTEGER NOT NULL,
      clock_out    INTEGER,
      note         TEXT NOT NULL DEFAULT '',
      edited       INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_punches_emp_in ON punches(employee_id, clock_in);
    CREATE INDEX IF NOT EXISTS idx_punches_open ON punches(employee_id) WHERE clock_out IS NULL;

    CREATE TABLE IF NOT EXISTS audit_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      at           INTEGER NOT NULL,
      actor        TEXT NOT NULL,
      action       TEXT NOT NULL,
      employee_id  INTEGER,
      punch_id     INTEGER,
      details      TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
  `);

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);
  // Per-install secret used to hash PINs (so PINs are never stored in plain text).
  insertSetting.run('pin_secret', crypto.randomBytes(32).toString('hex'));

  return new Store(db);
}

class Store {
  constructor(db) {
    this.db = db;
    this.secret = this.getSetting('pin_secret');
  }

  // ---------- helpers ----------
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  hashPin(pin) {
    return crypto.createHmac('sha256', this.secret).update(String(pin)).digest('hex');
  }

  // ---------- settings ----------
  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  publicSettings() {
    return {
      company_name: this.getSetting('company_name'),
      weekly_ot_hours: Number(this.getSetting('weekly_ot_hours')),
      daily_ot_hours: Number(this.getSetting('daily_ot_hours')),
      week_start_day: Number(this.getSetting('week_start_day')),
      pin_length: Number(this.getSetting('pin_length')),
      admin_pin_set: !!this.getSetting('admin_pin_hash'),
    };
  }

  rules() {
    return {
      weeklyOtHours: Number(this.getSetting('weekly_ot_hours')) || 0,
      dailyOtHours: Number(this.getSetting('daily_ot_hours')) || 0,
      weekStartDay: Number(this.getSetting('week_start_day')) || 0,
    };
  }

  checkAdminPin(pin) {
    const h = this.getSetting('admin_pin_hash');
    if (!h) return false;
    const a = Buffer.from(h, 'hex');
    const b = Buffer.from(this.hashPin('admin:' + pin), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  setAdminPin(pin) {
    this.setSetting('admin_pin_hash', this.hashPin('admin:' + pin));
  }

  // ---------- employees ----------
  listEmployees() {
    return this.db.prepare(`
      SELECT e.id, e.name, e.active, e.created_at,
             (SELECT p.clock_in FROM punches p WHERE p.employee_id = e.id AND p.clock_out IS NULL
              ORDER BY p.clock_in DESC LIMIT 1) AS clocked_in_at
      FROM employees e ORDER BY e.active DESC, e.name COLLATE NOCASE
    `).all().map(plain);
  }

  getEmployee(id) {
    const r = this.db.prepare('SELECT id, name, active, created_at FROM employees WHERE id = ?').get(id);
    return r ? plain(r) : null;
  }

  findEmployeeByPin(pin) {
    const r = this.db.prepare('SELECT id, name, active FROM employees WHERE pin_hash = ?').get(this.hashPin(pin));
    return r ? plain(r) : null;
  }

  pinInUse(pin, exceptId) {
    const r = this.db.prepare('SELECT id FROM employees WHERE pin_hash = ?').get(this.hashPin(pin));
    return !!r && r.id !== exceptId;
  }

  createEmployee(name, pin) {
    const r = this.db.prepare('INSERT INTO employees (name, pin_hash, active, created_at) VALUES (?, ?, 1, ?)')
      .run(name, this.hashPin(pin), Date.now());
    return Number(r.lastInsertRowid);
  }

  updateEmployee(id, { name, pin, active }) {
    if (name != null) this.db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(name, id);
    if (pin != null) this.db.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').run(this.hashPin(pin), id);
    if (active != null) this.db.prepare('UPDATE employees SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  }

  // ---------- punches ----------
  openPunch(employeeId) {
    const r = this.db.prepare('SELECT * FROM punches WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1')
      .get(employeeId);
    return r ? plain(r) : null;
  }

  getPunch(id) {
    const r = this.db.prepare('SELECT * FROM punches WHERE id = ?').get(id);
    return r ? plain(r) : null;
  }

  // Punches overlapping [from, to) for one employee (or all when employeeId is null).
  punchesInRange(employeeId, from, to) {
    const sql = `
      SELECT p.*, e.name AS employee_name FROM punches p JOIN employees e ON e.id = p.employee_id
      WHERE p.clock_in < ? AND (p.clock_out IS NULL OR p.clock_out > ?)
      ${employeeId != null ? 'AND p.employee_id = ?' : ''}
      ORDER BY p.clock_in`;
    const args = employeeId != null ? [to, from, employeeId] : [to, from];
    return this.db.prepare(sql).all(...args).map(plain);
  }

  // Returns a conflicting punch if [clockIn, clockOut) overlaps another punch.
  findOverlap(employeeId, clockIn, clockOut, exceptId) {
    const end = clockOut == null ? Number.MAX_SAFE_INTEGER : clockOut;
    const r = this.db.prepare(`
      SELECT * FROM punches WHERE employee_id = ? AND id != ?
        AND clock_in < ? AND (clock_out IS NULL OR clock_out > ?)
      LIMIT 1`).get(employeeId, exceptId || 0, end, clockIn);
    return r ? plain(r) : null;
  }

  clockIn(employeeId, at) {
    const r = this.db.prepare('INSERT INTO punches (employee_id, clock_in, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(employeeId, at, at, at);
    return Number(r.lastInsertRowid);
  }

  clockOut(punchId, at) {
    this.db.prepare('UPDATE punches SET clock_out = ?, updated_at = ? WHERE id = ?').run(at, at, punchId);
  }

  createPunch(employeeId, clockIn, clockOut, note) {
    const now = Date.now();
    const r = this.db.prepare(`INSERT INTO punches (employee_id, clock_in, clock_out, note, edited, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)`).run(employeeId, clockIn, clockOut, note || '', now, now);
    return Number(r.lastInsertRowid);
  }

  updatePunch(id, clockIn, clockOut, note) {
    this.db.prepare('UPDATE punches SET clock_in = ?, clock_out = ?, note = ?, edited = 1, updated_at = ? WHERE id = ?')
      .run(clockIn, clockOut, note || '', Date.now(), id);
  }

  deletePunch(id) {
    this.db.prepare('DELETE FROM punches WHERE id = ?').run(id);
  }

  // ---------- audit ----------
  audit(actor, action, { employeeId = null, punchId = null, details = '' } = {}) {
    this.db.prepare('INSERT INTO audit_log (at, actor, action, employee_id, punch_id, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), actor, action, employeeId, punchId, details);
  }

  listAudit(limit = 200, offset = 0) {
    return this.db.prepare(`
      SELECT a.*, e.name AS employee_name FROM audit_log a LEFT JOIN employees e ON e.id = a.employee_id
      ORDER BY a.at DESC, a.id DESC LIMIT ? OFFSET ?`).all(limit, offset).map(plain);
  }

  backupTo(file) {
    this.db.prepare('VACUUM INTO ?').run(file);
  }
}

function plain(row) {
  return { ...row };
}

module.exports = { open };
