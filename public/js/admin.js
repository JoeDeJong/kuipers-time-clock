'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const DAY = 86400000;
  let info = null;
  let settings = null;
  let employees = [];
  let auditOffset = 0;

  // ---------- utils ----------
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path.startsWith('/api/admin/') && !/login|setup/.test(path)) {
      showLogin();
      throw new Error('Session expired. Please log in again.');
    }
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return e;
  }

  function toast(msg) {
    const t = el('div', { class: 'toast' }, msg);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dtLocal = (ms) => {
    const d = new Date(ms);
    return `${dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const parseDateStr = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtDayYear = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const fmtFull = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const h2 = (n) => Number(n || 0).toFixed(2);
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function weekStart(d) {
    const ws = settings ? settings.week_start_day : 0;
    const diff = (d.getDay() - ws + 7) % 7;
    return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -diff);
  }

  // ---------- auth ----------
  async function init() {
    info = await api('GET', '/api/info');
    document.title = `${info.company_name} Time Clock Admin`;
    try {
      await api('GET', '/api/admin/me');
      await enterAdmin();
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    $('adminView').classList.add('hidden');
    $('loginView').classList.remove('hidden');
    const setup = !info.admin_pin_set;
    $('loginHint').textContent = setup
      ? 'First-time setup: choose an admin PIN (4-8 digits). You will use it to manage employees and hours.'
      : 'Enter the admin PIN.';
    $('loginConfirmWrap').classList.toggle('hidden', !setup);
    $('loginBtn').textContent = setup ? 'Set admin PIN' : 'Log in';
    $('loginPin').value = '';
    $('loginConfirm').value = '';
    $('loginPin').focus();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    const pin = $('loginPin').value.trim();
    try {
      if (!info.admin_pin_set) {
        if (pin !== $('loginConfirm').value.trim()) throw new Error('PINs do not match.');
        await api('POST', '/api/admin/setup', { pin });
        info.admin_pin_set = true;
      } else {
        await api('POST', '/api/admin/login', { pin });
      }
      await enterAdmin();
    } catch (err) {
      $('loginErr').textContent = err.message;
      $('loginPin').value = '';
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await api('POST', '/api/admin/logout').catch(() => {});
    showLogin();
  });

  async function enterAdmin() {
    settings = await api('GET', '/api/admin/settings');
    $('adminTitle').textContent = settings.company_name;
    $('loginView').classList.add('hidden');
    $('adminView').classList.remove('hidden');
    await loadEmployees();
    initDates();
    showTab(employees.length ? 'dashboard' : 'employees');
  }

  // ---------- tabs ----------
  const loaders = {
    dashboard: loadDashboard,
    timesheets: loadTimesheet,
    punches: loadPunches,
    employees: renderEmployees,
    settings: renderSettings,
    audit: () => { auditOffset = 0; $('auBody').innerHTML = ''; return loadAudit(); },
  };

  function showTab(name) {
    for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === name);
    for (const s of document.querySelectorAll('[data-panel]')) s.classList.toggle('hidden', s.dataset.panel !== name);
    Promise.resolve(loaders[name]()).catch((e) => toast(e.message));
  }

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) showTab(b.dataset.tab);
  });

  // ---------- shared bits ----------
  function initials(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function person(name, meta) {
    return el('div', { class: 'person' },
      el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name)),
      el('div', {}, el('div', { class: 'name' }, name), meta ? el('div', { class: 'meta' }, meta) : ''));
  }
  function stat(label, value, opts = {}) {
    return el('div', { class: 'stat' + (opts.cls ? ` ${opts.cls}` : '') },
      el('div', { class: 'label' }, label),
      el('div', { class: 'value' }, value, opts.unit ? el('small', {}, opts.unit) : ''),
      opts.foot ? el('div', { class: 'foot' }, opts.foot) : '');
  }
  function emptyRow(cols, text) {
    return el('tr', {}, el('td', { colspan: cols, class: 'empty' }, text));
  }
  function duration(ms) {
    const mins = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(mins / 60);
    return h ? `${h}h ${mins % 60}m` : `${mins}m`;
  }
  // Overtime is highlighted only when there is some.
  const otCell = (v) => el('td', { class: Number(v) > 0 ? 'num ot' : 'num muted' }, h2(v));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // ---------- dashboard ----------
  async function loadDashboard() {
    const d = await api('GET', '/api/admin/dashboard');
    $('dashWeek').textContent = `Workweek starting ${fmtDayYear.format(parseDateStr(d.week_from))}. Updates every 30 seconds.`;
    const active = d.employees.filter((e) => e.active);
    const inNow = d.employees.filter((e) => e.clocked_in_at);
    const sum = (k) => d.employees.reduce((t, e) => t + e.week[k], 0);
    const otCount = d.employees.filter((e) => e.week.overtime > 0).length;
    $('dashStats').replaceChildren(
      stat('Clocked in now', String(inNow.length), { cls: 'live', unit: `of ${active.length}` }),
      stat('Regular hours', h2(sum('regular')), { foot: 'This week, everyone' }),
      stat('Overtime hours', h2(sum('overtime')), { cls: sum('overtime') > 0 ? 'ot' : '', foot: otCount ? `${plural(otCount, 'person', 'people')} in overtime` : 'No overtime this week' }),
      stat('Total hours', h2(sum('total')), { foot: 'This week so far' }),
    );
    const body = $('dashBody');
    body.innerHTML = '';
    if (!d.employees.length) {
      body.appendChild(emptyRow(6, 'No employees yet. Add your team on the Employees page.'));
      return;
    }
    const sorted = [...d.employees].sort((a, b) => (!!b.clocked_in_at - !!a.clocked_in_at) || a.name.localeCompare(b.name));
    const now = Date.now();
    for (const e of sorted) {
      body.appendChild(el('tr', {},
        el('td', {}, person(e.name, e.clocked_in_at ? `On the clock for ${duration(now - e.clocked_in_at)}` : null)),
        el('td', {}, e.clocked_in_at
          ? el('span', { class: 'tag in dot' }, `In since ${fmtTime.format(new Date(e.clocked_in_at))}`)
          : el('span', { class: 'tag dot' }, 'Out')),
        el('td', { class: 'num' }, h2(e.week.regular)),
        otCell(e.week.overtime),
        el('td', { class: 'num' }, el('b', {}, h2(e.week.total))),
        el('td', { class: 'actions' }, e.clocked_in_at
          ? el('button', { class: 'btn small', onclick: () => adminClockOut(e) }, 'Clock out')
          : ''),
      ));
    }
  }

  async function adminClockOut(e) {
    if (!confirm(`Clock out ${e.name} now?`)) return;
    try {
      await api('POST', `/api/admin/employees/${e.id}/clock-out`);
      toast(`${e.name} clocked out.`);
      loadDashboard();
    } catch (err) { toast(err.message); }
  }

  // ---------- dates ----------
  function initDates() {
    const today = new Date();
    const ws = weekStart(today);
    $('puFrom').value = dateStr(ws);
    $('puTo').value = dateStr(addDays(ws, 6));
    applyPreset('this_week');
  }

  function applyPreset(p) {
    const today = new Date();
    const ws = weekStart(today);
    let from; let to;
    switch (p) {
      case 'this_week': from = ws; to = addDays(ws, 6); break;
      case 'last_week': from = addDays(ws, -7); to = addDays(ws, -1); break;
      case 'last_2_weeks': from = addDays(ws, -14); to = addDays(ws, -1); break;
      case 'this_month': from = new Date(today.getFullYear(), today.getMonth(), 1); to = new Date(today.getFullYear(), today.getMonth() + 1, 0); break;
      case 'last_month': from = new Date(today.getFullYear(), today.getMonth() - 1, 1); to = new Date(today.getFullYear(), today.getMonth(), 0); break;
      default: return;
    }
    $('tsPreset').value = p;
    $('tsFrom').value = dateStr(from);
    $('tsTo').value = dateStr(to);
  }

  $('tsPreset').addEventListener('change', () => { applyPreset($('tsPreset').value); loadTimesheet(); });
  for (const id of ['tsFrom', 'tsTo']) $(id).addEventListener('change', () => { $('tsPreset').value = 'custom'; });

  // ---------- timesheets ----------
  async function loadTimesheet() {
    const from = $('tsFrom').value;
    const to = $('tsTo').value;
    const q = `from=${from}&to=${to}`;
    $('tsCsv').dataset.href = `/api/admin/report.csv?${q}`;
    $('tsCsvDaily').dataset.href = `/api/admin/report.csv?${q}&detail=1`;
    const r = await api('GET', `/api/admin/report?${q}`);
    $('tsTitle').textContent = `${fmtDayYear.format(parseDateStr(r.from))} to ${fmtDayYear.format(parseDateStr(r.to))}`;
    const rules = [];
    rules.push(r.rules.weeklyOtHours > 0 ? `Overtime after ${r.rules.weeklyOtHours} hours per week` : 'No weekly overtime');
    if (r.rules.dailyOtHours > 0) rules.push(`or ${r.rules.dailyOtHours} hours per day`);
    $('tsRules').textContent = `${rules.join(' ')}. Workweek starts ${DAYS[r.rules.weekStartDay]}. Hours are decimal (7.50 = 7 h 30 m). Click an employee for a daily breakdown.`;

    const worked = r.rows.filter((x) => x.total > 0).length;
    const otCount = r.rows.filter((x) => x.overtime > 0).length;
    $('tsStats').replaceChildren(
      stat('Regular hours', h2(r.totals.regular)),
      stat('Overtime hours', h2(r.totals.overtime), { cls: r.totals.overtime > 0 ? 'ot' : '', foot: otCount ? `${plural(otCount, 'person', 'people')} with overtime` : 'No overtime' }),
      stat('Total hours', h2(r.totals.total)),
      stat('Employees', String(worked), { foot: 'With hours in this period' }),
    );

    const body = $('tsBody');
    body.innerHTML = '';
    if (!r.rows.length) {
      body.appendChild(emptyRow(5, 'No employees yet.'));
      return;
    }
    for (const row of r.rows) {
      const detail = el('tr', { class: 'detail hidden' }, el('td', { colspan: 5 }, dayTable(row)));
      const main = el('tr', {
        class: 'clickable',
        onclick: () => { detail.classList.toggle('hidden'); main.classList.toggle('open'); },
      },
        el('td', {}, el('div', { class: 'person' },
          el('span', { class: 'chev', 'aria-hidden': 'true' }, '›'),
          el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(row.name)),
          el('div', {}, el('div', { class: 'name' }, row.name),
            (row.open || !row.active) ? el('div', { class: 'meta' },
              row.open ? el('span', { class: 'tag in dot' }, 'Clocked in') : '',
              !row.active ? el('span', { class: 'tag inactive' }, 'Inactive') : '') : ''))),
        el('td', { class: 'num' }, h2(row.regular)),
        otCell(row.overtime),
        el('td', { class: 'num' }, el('b', {}, h2(row.total))),
        el('td', { class: 'actions' }, el('button', {
          class: 'btn small',
          onclick: (ev) => { ev.stopPropagation(); openPunchesFor(row.employee_id, from, to); },
        }, 'View punches')),
      );
      body.appendChild(main);
      body.appendChild(detail);
    }
    body.appendChild(el('tr', { class: 'total' },
      el('td', {}, 'Total'),
      el('td', { class: 'num' }, h2(r.totals.regular)),
      otCell(r.totals.overtime),
      el('td', { class: 'num' }, h2(r.totals.total)),
      el('td', {}),
    ));
  }

  function dayTable(row) {
    if (!row.days.length) return el('div', { class: 'muted' }, 'No hours in this period.');
    return el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', { class: 'num' }, 'Regular'), el('th', { class: 'num' }, 'Overtime'), el('th', { class: 'num' }, 'Total'))),
      el('tbody', {}, row.days.map((d) => el('tr', {},
        el('td', {}, fmtDay.format(parseDateStr(d.date))),
        el('td', { class: 'num' }, h2(d.regular)),
        otCell(d.overtime),
        el('td', { class: 'num' }, h2(d.regular + d.overtime)),
      ))),
    );
  }

  $('tsRun').addEventListener('click', () => loadTimesheet().catch((e) => toast(e.message)));
  for (const id of ['tsCsv', 'tsCsvDaily']) {
    $(id).addEventListener('click', () => { if ($(id).dataset.href) window.location.href = $(id).dataset.href; });
  }
  $('tsPrint').addEventListener('click', () => {
    for (const r of document.querySelectorAll('#tsBody tr.detail')) r.classList.remove('hidden');
    window.print();
  });

  function openPunchesFor(empId, from, to) {
    $('puEmp').value = String(empId);
    $('puFrom').value = from;
    $('puTo').value = to;
    showTab('punches');
  }

  // ---------- punches ----------
  function fillEmployeeSelect(sel, includeAll) {
    const cur = sel.value;
    sel.innerHTML = '';
    if (includeAll) sel.appendChild(el('option', { value: '' }, 'All employees'));
    for (const e of employees) {
      sel.appendChild(el('option', { value: e.id }, e.name + (e.active ? '' : ' (inactive)')));
    }
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  async function loadPunches() {
    fillEmployeeSelect($('puEmp'), true);
    const emp = $('puEmp').value;
    const q = `from=${$('puFrom').value}&to=${$('puTo').value}${emp ? `&employee_id=${emp}` : ''}`;
    const list = await api('GET', `/api/admin/punches?${q}`);
    const body = $('puBody');
    body.innerHTML = '';
    if (!list.length) {
      body.appendChild(emptyRow(6, 'No punches in this period.'));
      return;
    }
    let lastDay = null;
    for (const p of list) {
      const day = dateStr(new Date(p.clock_in));
      if (day !== lastDay) {
        body.appendChild(el('tr', { class: 'daybreak' }, el('td', { colspan: 6 }, fmtDayYear.format(new Date(p.clock_in)))));
        lastDay = day;
      }
      const end = p.clock_out || Date.now();
      const sameDay = p.clock_out && dateStr(new Date(p.clock_out)) === day;
      body.appendChild(el('tr', {},
        el('td', {}, person(p.employee_name)),
        el('td', { class: 'tabular' }, fmtTime.format(new Date(p.clock_in))),
        el('td', { class: 'tabular' }, p.clock_out
          ? (sameDay ? fmtTime.format(new Date(p.clock_out)) : fmtFull.format(new Date(p.clock_out)))
          : el('span', { class: 'tag in dot' }, 'Still clocked in')),
        el('td', { class: 'num' }, h2((end - p.clock_in) / 3600000)),
        el('td', {}, p.edited ? el('span', { class: 'tag edited' }, 'Edited') : '', p.note ? ` ${p.note}` : ''),
        el('td', { class: 'actions' }, el('button', { class: 'btn small', onclick: () => openPunchDlg(p) }, 'Edit')),
      ));
    }
  }

  $('puRun').addEventListener('click', () => loadPunches().catch((e) => toast(e.message)));
  $('puAdd').addEventListener('click', () => openPunchDlg(null));

  let editingPunch = null;
  function openPunchDlg(p) {
    editingPunch = p;
    fillEmployeeSelect($('pdEmp'), false);
    $('punchDlgTitle').textContent = p ? 'Edit punch' : 'Add punch';
    $('pdEmp').disabled = !!p;
    if (p) {
      $('pdEmp').value = String(p.employee_id);
      $('pdIn').value = dtLocal(p.clock_in);
      $('pdOut').value = p.clock_out ? dtLocal(p.clock_out) : '';
      $('pdNote').value = p.note || '';
    } else {
      if ($('puEmp').value) $('pdEmp').value = $('puEmp').value;
      const today = new Date();
      $('pdIn').value = `${dateStr(today)}T08:00`;
      $('pdOut').value = `${dateStr(today)}T16:30`;
      $('pdNote').value = '';
    }
    $('pdDelete').classList.toggle('hidden', !p);
    $('pdErr').textContent = '';
    $('punchDlg').showModal();
  }

  $('pdCancel').addEventListener('click', () => $('punchDlg').close());

  $('punchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pdErr').textContent = '';
    const body = { clock_in: $('pdIn').value, clock_out: $('pdOut').value, note: $('pdNote').value };
    try {
      if (editingPunch) {
        await api('PUT', `/api/admin/punches/${editingPunch.id}`, body);
      } else {
        body.employee_id = Number($('pdEmp').value);
        if (!body.employee_id) throw new Error('Choose an employee.');
        await api('POST', '/api/admin/punches', body);
      }
      $('punchDlg').close();
      toast('Saved.');
      loadPunches().catch((err) => toast(err.message));
    } catch (err) {
      $('pdErr').textContent = err.message;
    }
  });

  $('pdDelete').addEventListener('click', async () => {
    if (!editingPunch) return;
    const reason = prompt('Delete this punch? Enter a reason (optional):', '');
    if (reason === null) return;
    try {
      await api('DELETE', `/api/admin/punches/${editingPunch.id}?reason=${encodeURIComponent(reason)}`);
      $('punchDlg').close();
      toast('Punch deleted.');
      loadPunches().catch((err) => toast(err.message));
    } catch (err) {
      $('pdErr').textContent = err.message;
    }
  });

  // ---------- employees ----------
  async function loadEmployees() {
    employees = await api('GET', '/api/admin/employees');
  }

  async function renderEmployees() {
    await loadEmployees();
    const body = $('empBody');
    body.innerHTML = '';
    if (!employees.length) {
      body.appendChild(emptyRow(4, 'No employees yet. Click "Add employee" to get started.'));
      return;
    }
    for (const e of employees) {
      body.appendChild(el('tr', {},
        el('td', {}, person(e.name)),
        el('td', {},
          e.active ? el('span', { class: 'tag dot accent' }, 'Active') : el('span', { class: 'tag inactive' }, 'Inactive'),
          e.clocked_in_at ? [' ', el('span', { class: 'tag in dot' }, 'Clocked in')] : ''),
        el('td', { class: 'muted' }, fmtDayYear.format(new Date(e.created_at))),
        el('td', { class: 'actions' }, el('button', { class: 'btn small', onclick: () => openEmpDlg(e) }, 'Edit')),
      ));
    }
  }

  let editingEmp = null;
  function openEmpDlg(e) {
    editingEmp = e;
    const len = settings.pin_length;
    $('empDlgTitle').textContent = e ? `Edit ${e.name}` : 'Add employee';
    $('edName').value = e ? e.name : '';
    $('edPin').value = '';
    $('edPin').maxLength = len;
    $('edPin').required = !e;
    $('edPinLabel').textContent = e ? 'New PIN' : 'PIN';
    $('edPinHint').textContent = e ? `Leave blank to keep their current PIN. ${len} digits.` : `${len} digits. Each employee needs a different PIN.`;
    $('edActiveWrap').classList.toggle('hidden', !e);
    $('edActive').checked = e ? !!e.active : true;
    $('edErr').textContent = '';
    $('empDlg').showModal();
    $('edName').focus();
  }

  $('empAdd').addEventListener('click', () => openEmpDlg(null));
  $('edCancel').addEventListener('click', () => $('empDlg').close());
  $('edRandom').addEventListener('click', () => {
    const len = settings.pin_length;
    const arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    $('edPin').value = Array.from(arr, (n) => n % 10).join('');
  });

  $('empForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('edErr').textContent = '';
    const body = { name: $('edName').value, pin: $('edPin').value.trim() };
    try {
      if (editingEmp) {
        body.active = $('edActive').checked;
        await api('PUT', `/api/admin/employees/${editingEmp.id}`, body);
      } else {
        await api('POST', '/api/admin/employees', body);
      }
      const pinMsg = body.pin ? ` PIN: ${body.pin}` : '';
      $('empDlg').close();
      toast(`Saved ${body.name.trim()}.${pinMsg}`);
      renderEmployees().catch((err) => toast(err.message));
    } catch (err) {
      $('edErr').textContent = err.message;
    }
  });

  // ---------- settings ----------
  async function renderSettings() {
    settings = await api('GET', '/api/admin/settings');
    $('setCompany').value = settings.company_name;
    $('setPinLen').value = String(settings.pin_length);
    $('setWeekly').value = settings.weekly_ot_hours;
    $('setDaily').value = settings.daily_ot_hours;
    $('setWeekStart').value = String(settings.week_start_day);
    $('setAdminPin').value = '';
    $('setAdminPin2').value = '';
    $('setErr').textContent = '';
  }

  $('setForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('setErr').textContent = '';
    const body = {
      company_name: $('setCompany').value,
      pin_length: Number($('setPinLen').value),
      weekly_ot_hours: Number($('setWeekly').value),
      daily_ot_hours: Number($('setDaily').value),
      week_start_day: Number($('setWeekStart').value),
    };
    const np = $('setAdminPin').value.trim();
    if (np) {
      if (np !== $('setAdminPin2').value.trim()) { $('setErr').textContent = 'Admin PINs do not match.'; return; }
      body.new_admin_pin = np;
    }
    try {
      settings = await api('PUT', '/api/admin/settings', body);
      $('adminTitle').textContent = settings.company_name;
      toast('Settings saved.');
      renderSettings();
    } catch (err) {
      $('setErr').textContent = err.message;
    }
  });

  // ---------- audit ----------
  const ACTIONS = {
    clock_in: 'Clocked in',
    clock_out: 'Clocked out',
    admin_clock_out: 'Clocked out by admin',
    punch_added: 'Punch added',
    punch_edited: 'Punch edited',
    punch_deleted: 'Punch deleted',
    employee_created: 'Employee added',
    employee_updated: 'Employee updated',
    settings_changed: 'Settings changed',
    admin_pin_set: 'Admin PIN set',
  };

  const ACTION_STYLE = {
    clock_in: 'in', clock_out: '', admin_clock_out: 'edited', punch_added: 'edited',
    punch_edited: 'edited', punch_deleted: 'inactive', employee_created: 'accent',
    employee_updated: 'accent', settings_changed: 'accent', admin_pin_set: 'accent',
  };

  async function loadAudit() {
    const rows = await api('GET', `/api/admin/audit?limit=100&offset=${auditOffset}`);
    auditOffset += rows.length;
    $('auMore').classList.toggle('hidden', rows.length < 100);
    const body = $('auBody');
    for (const a of rows) {
      body.appendChild(el('tr', {},
        el('td', { class: 'tabular', style: 'white-space:nowrap' }, fmtFull.format(new Date(a.at))),
        el('td', {}, el('span', { class: `tag ${ACTION_STYLE[a.action] || ''}` }, ACTIONS[a.action] || a.action)),
        el('td', {}, a.employee_name || ''),
        el('td', { class: 'muted' }, a.details),
        el('td', { class: 'muted' }, a.actor === 'kiosk' ? 'Time clock' : 'Admin'),
      ));
    }
    if (!body.children.length) body.appendChild(emptyRow(5, 'Nothing recorded yet.'));
  }
  $('auMore').addEventListener('click', () => loadAudit().catch((e) => toast(e.message)));

  // Refresh "Who's In" periodically while visible.
  setInterval(() => {
    const dash = document.querySelector('[data-panel="dashboard"]');
    if (!$('adminView').classList.contains('hidden') && !dash.classList.contains('hidden')) {
      loadDashboard().catch(() => {});
    }
  }, 30000);

  init().catch((e) => {
    document.body.textContent = `Cannot reach the time clock server: ${e.message}`;
  });
})();
