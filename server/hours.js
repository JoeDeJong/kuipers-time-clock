'use strict';

// Hours / overtime calculation.
//
// All timestamps are epoch milliseconds. Day and week boundaries are
// computed in the server's local time zone (set TZ to override).
//
// Overtime rules (configurable):
//   - weeklyOtHours: hours worked in a workweek beyond this are overtime
//     (US federal rule: 40). 0 disables weekly overtime.
//   - dailyOtHours: hours worked in a single day beyond this are overtime
//     (e.g. 8 in some states). 0 disables daily overtime.
//   - weekStartDay: 0 = Sunday ... 6 = Saturday.
// When both are enabled, hours that are already daily overtime do not count
// toward the weekly regular-hours threshold (no double counting).

const HOUR = 3600 * 1000;

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function nextDayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

function startOfWeek(ms, weekStartDay) {
  const d = new Date(startOfDay(ms));
  const diff = (d.getDay() - weekStartDay + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Parse 'YYYY-MM-DD' as local midnight.
function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getMonth() !== Number(m[2]) - 1) return null;
  return d.getTime();
}

// Parse 'YYYY-MM-DDTHH:MM' (datetime-local input) as local time.
function parseDateTime(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(str || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function addDays(ms, days) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * Calculate regular and overtime hours for ONE employee.
 *
 * @param {Array<{clock_in:number, clock_out:number|null}>} punches
 *        All of the employee's punches that may overlap [startOfWeek(from), to).
 * @param {{weeklyOtHours:number, dailyOtHours:number, weekStartDay:number}} rules
 * @param {number} from  inclusive range start (ms)
 * @param {number} to    exclusive range end (ms)
 * @param {number} now   used as the end of any still-open punch
 * @returns {{regularMs:number, overtimeMs:number, totalMs:number,
 *            days: Object<string,{regularMs:number, overtimeMs:number}>, open:boolean}}
 */
function calculateHours(punches, rules, from, to, now) {
  const weeklyLimit = rules.weeklyOtHours > 0 ? rules.weeklyOtHours * HOUR : Infinity;
  const dailyLimit = rules.dailyOtHours > 0 ? rules.dailyOtHours * HOUR : Infinity;
  const weekStartDay = rules.weekStartDay || 0;

  // Start accumulating at the beginning of the workweek containing `from`
  // so that overtime for a partial week is computed correctly.
  const calcStart = startOfWeek(from, weekStartDay);

  const intervals = [];
  let open = false;
  for (const p of punches) {
    let start = p.clock_in;
    let end = p.clock_out == null ? now : p.clock_out;
    if (p.clock_out == null && p.clock_in < to) open = true;
    if (start < calcStart) start = calcStart;
    if (end > to) end = to;
    if (end > start) intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);

  const weekRegular = new Map(); // weekStart -> regular ms accumulated
  const dayWorked = new Map(); // dateKey -> total ms worked that day
  const days = {};
  let regularMs = 0;
  let overtimeMs = 0;

  for (const [iStart, iEnd] of intervals) {
    let segStart = iStart;
    while (segStart < iEnd) {
      const segEnd = Math.min(iEnd, nextDayStart(segStart));
      const dur = segEnd - segStart;
      const wk = startOfWeek(segStart, weekStartDay);
      const dk = dateKey(segStart);

      const wkReg = weekRegular.get(wk) || 0;
      const dWorked = dayWorked.get(dk) || 0;
      const dailyLeft = Math.max(0, dailyLimit - dWorked);
      const weeklyLeft = Math.max(0, weeklyLimit - wkReg);
      const reg = Math.min(dur, dailyLeft, weeklyLeft);
      const ot = dur - reg;

      weekRegular.set(wk, wkReg + reg);
      dayWorked.set(dk, dWorked + dur);

      if (segStart >= from) {
        regularMs += reg;
        overtimeMs += ot;
        if (!days[dk]) days[dk] = { regularMs: 0, overtimeMs: 0 };
        days[dk].regularMs += reg;
        days[dk].overtimeMs += ot;
      }
      segStart = segEnd;
    }
  }

  return { regularMs, overtimeMs, totalMs: regularMs + overtimeMs, days, open };
}

function msToHours(ms) {
  return Math.round((ms / HOUR) * 100) / 100;
}

module.exports = {
  HOUR,
  startOfDay,
  nextDayStart,
  startOfWeek,
  dateKey,
  parseDate,
  parseDateTime,
  addDays,
  calculateHours,
  msToHours,
};
