'use strict';
process.env.TZ = 'America/Chicago';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../server/hours');

const at = (s) => H.parseDateTime(s);
const day = (s) => H.parseDate(s);
const hrs = (ms) => ms / H.HOUR;
const WEEKLY = { weeklyOtHours: 40, dailyOtHours: 0, weekStartDay: 0 };

// 2026-11-15 is a Sunday.
function shifts(list) {
  return list.map(([a, b]) => ({ clock_in: at(a), clock_out: b ? at(b) : null }));
}

test('no overtime under 40 hours', () => {
  const p = shifts([['2026-11-16T08:00', '2026-11-16T16:00'], ['2026-11-17T08:00', '2026-11-17T16:00']]);
  const r = H.calculateHours(p, WEEKLY, day('2026-11-15'), day('2026-11-22'), Date.now());
  assert.equal(hrs(r.regularMs), 16);
  assert.equal(r.overtimeMs, 0);
});

test('weekly overtime after 40 hours', () => {
  // Mon-Fri 10 hours each = 50 hours -> 40 reg, 10 OT (OT on Thu 0h? no: Mon-Thu = 40, Fri = 10 OT)
  const p = shifts(['16', '17', '18', '19', '20'].map((d) => [`2026-11-${d}T07:00`, `2026-11-${d}T17:00`]));
  const r = H.calculateHours(p, WEEKLY, day('2026-11-15'), day('2026-11-22'), Date.now());
  assert.equal(hrs(r.regularMs), 40);
  assert.equal(hrs(r.overtimeMs), 10);
  assert.equal(hrs(r.days['2026-11-20'].overtimeMs), 10);
  assert.equal(r.days['2026-11-19'].overtimeMs, 0);
});

test('report range starting mid-week still counts earlier hours toward overtime', () => {
  const p = shifts(['16', '17', '18', '19', '20'].map((d) => [`2026-11-${d}T07:00`, `2026-11-${d}T17:00`]));
  const r = H.calculateHours(p, WEEKLY, day('2026-11-20'), day('2026-11-21'), Date.now());
  assert.equal(r.regularMs, 0);
  assert.equal(hrs(r.overtimeMs), 10);
});

test('overtime resets each workweek', () => {
  const p = shifts([
    ...['16', '17', '18', '19', '20'].map((d) => [`2026-11-${d}T07:00`, `2026-11-${d}T17:00`]),
    ['2026-11-23T07:00', '2026-11-23T17:00'],
  ]);
  const r = H.calculateHours(p, WEEKLY, day('2026-11-15'), day('2026-11-29'), Date.now());
  assert.equal(hrs(r.regularMs), 50);
  assert.equal(hrs(r.overtimeMs), 10);
});

test('shift crossing midnight is split across days', () => {
  const p = shifts([['2026-11-16T22:00', '2026-11-17T06:00']]);
  const r = H.calculateHours(p, WEEKLY, day('2026-11-15'), day('2026-11-22'), Date.now());
  assert.equal(hrs(r.days['2026-11-16'].regularMs), 2);
  assert.equal(hrs(r.days['2026-11-17'].regularMs), 6);
});

test('shift crossing the week boundary counts toward the right week', () => {
  // 40 hours Sun-Fri, then Sat 20:00 -> Sun 04:00 (new week starts Sunday)
  const p = shifts([
    ...['15', '16', '17', '18', '19'].map((d) => [`2026-11-${d}T08:00`, `2026-11-${d}T16:00`]),
    ['2026-11-21T20:00', '2026-11-22T04:00'],
  ]);
  const r = H.calculateHours(p, WEEKLY, day('2026-11-15'), day('2026-11-29'), Date.now());
  assert.equal(hrs(r.days['2026-11-21'].overtimeMs), 4);
  assert.equal(hrs(r.days['2026-11-22'].regularMs), 4);
});

test('daily overtime when enabled, without double counting toward weekly', () => {
  const rules = { weeklyOtHours: 40, dailyOtHours: 8, weekStartDay: 0 };
  // 5 x 10h: daily OT 2h each = 10 OT, 40 reg (weekly never exceeded by regular hours)
  const p = shifts(['16', '17', '18', '19', '20'].map((d) => [`2026-11-${d}T07:00`, `2026-11-${d}T17:00`]));
  const r = H.calculateHours(p, rules, day('2026-11-15'), day('2026-11-22'), Date.now());
  assert.equal(hrs(r.regularMs), 40);
  assert.equal(hrs(r.overtimeMs), 10);
  // A 6th day of 8h pushes weekly regular over 40 -> all OT
  const p2 = [...p, ...shifts([['2026-11-21T08:00', '2026-11-21T16:00']])];
  const r2 = H.calculateHours(p2, rules, day('2026-11-15'), day('2026-11-22'), Date.now());
  assert.equal(hrs(r2.regularMs), 40);
  assert.equal(hrs(r2.overtimeMs), 18);
});

test('open punch counts up to now', () => {
  const p = shifts([['2026-11-16T08:00', null]]);
  const r = H.calculateHours(p, WEEKLY, day('2026-11-15'), day('2026-11-22'), at('2026-11-16T11:30'));
  assert.equal(hrs(r.regularMs), 3.5);
  assert.equal(r.open, true);
});

test('Monday week start', () => {
  const rules = { weeklyOtHours: 40, dailyOtHours: 0, weekStartDay: 1 };
  assert.equal(H.startOfWeek(at('2026-11-15T12:00'), 1), day('2026-11-09'));
  assert.equal(H.startOfWeek(at('2026-11-16T12:00'), 1), day('2026-11-16'));
  const p = shifts([['2026-11-15T00:00', '2026-11-15T23:00'], ['2026-11-16T00:00', '2026-11-16T23:00']]);
  const r = H.calculateHours(p, rules, day('2026-11-15'), day('2026-11-17'), Date.now());
  assert.equal(r.overtimeMs, 0);
});

test('daylight saving day is handled', () => {
  // US DST ends 2026-11-01 (an extra hour). 00:00 -> 06:00 wall clock = 7 real hours.
  const p = shifts([['2026-11-01T00:00', '2026-11-01T06:00']]);
  const r = H.calculateHours(p, WEEKLY, day('2026-11-01'), day('2026-11-02'), Date.now());
  assert.equal(hrs(r.regularMs), 7);
});
