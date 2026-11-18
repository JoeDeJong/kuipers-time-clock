'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  let pinLength = 4;
  let pin = '';
  let busy = false;
  let currentPin = null; // PIN of the employee shown on the status screen
  let statusTimer = null;
  let doneTimer = null;
  let serverOffset = 0; // server clock - tablet clock

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const shortDateTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  // ---------- clock ----------
  function tick() {
    const now = new Date(Date.now() + serverOffset);
    $('clockTime').textContent = timeFmt.format(now);
    $('clockDate').textContent = dateFmt.format(now);
  }

  async function loadInfo() {
    try {
      const t0 = Date.now();
      const info = await api('/api/info');
      serverOffset = info.server_time - Math.round((t0 + Date.now()) / 2);
      pinLength = info.pin_length || 4;
      $('company').textContent = info.company_name || 'Time Clock';
      document.title = `${info.company_name || ''} Time Clock`.trim();
      renderDots();
    } catch {
      setMsg('Cannot reach the time clock server.');
    }
  }

  // ---------- PIN pad ----------
  function renderDots() {
    const dots = $('pinDots');
    dots.innerHTML = '';
    for (let i = 0; i < pinLength; i++) {
      const s = document.createElement('span');
      if (i < pin.length) s.className = 'filled';
      dots.appendChild(s);
    }
  }

  function setMsg(text) {
    $('pinMsg').textContent = text || '';
  }

  function press(k) {
    if (busy) return;
    if (k === 'clear') pin = '';
    else if (k === 'back') pin = pin.slice(0, -1);
    else if (pin.length < pinLength) pin += k;
    setMsg('');
    renderDots();
    if (pin.length === pinLength) submitPin();
  }

  async function submitPin() {
    busy = true;
    const entered = pin;
    try {
      const data = await api('/api/kiosk/lookup', { pin: entered });
      currentPin = entered;
      showStatus(data);
    } catch (e) {
      setMsg(e.message);
      const panel = $('pinPanel');
      panel.classList.remove('shake');
      void panel.offsetWidth;
      panel.classList.add('shake');
    } finally {
      pin = '';
      renderDots();
      busy = false;
    }
  }

  $('keypad').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) press(b.dataset.k);
  });

  document.addEventListener('keydown', (e) => {
    if (!$('statusView').classList.contains('hidden') || !$('doneView').classList.contains('hidden')) {
      if (e.key === 'Escape') resetToPin();
      return;
    }
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
    else if (e.key === 'Escape') press('clear');
  });

  // ---------- status screen ----------
  function fmtHours(h) {
    return Number(h || 0).toFixed(2);
  }

  function showStatus(data) {
    $('stName').textContent = `Hi, ${data.name}`;
    const line = $('stLine');
    line.innerHTML = '';
    const badge = document.createElement('span');
    badge.className = 'badge ' + (data.clocked_in ? 'in' : 'out');
    badge.textContent = data.clocked_in ? 'CLOCKED IN' : 'CLOCKED OUT';
    line.appendChild(badge);
    if (data.clocked_in) {
      line.appendChild(document.createTextNode(` since ${shortDateTime.format(new Date(data.clocked_in_at))}`));
    }
    $('stReg').textContent = fmtHours(data.week.regular);
    $('stOt').textContent = fmtHours(data.week.overtime);
    const btn = $('punchBtn');
    btn.className = 'big-btn ' + (data.clocked_in ? 'out' : 'in');
    btn.textContent = data.clocked_in ? 'CLOCK OUT' : 'CLOCK IN';
    btn.dataset.action = data.clocked_in ? 'out' : 'in';
    btn.disabled = false;
    $('stMsg').textContent = '';
    $('statusView').classList.remove('hidden');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(resetToPin, 20000);
  }

  $('punchBtn').addEventListener('click', async () => {
    const btn = $('punchBtn');
    if (btn.disabled || !currentPin) return;
    btn.disabled = true;
    try {
      const data = await api('/api/kiosk/punch', { pin: currentPin, action: btn.dataset.action });
      showDone(data);
    } catch (e) {
      $('stMsg').textContent = e.message;
      btn.disabled = false;
    }
  });

  $('cancelBtn').addEventListener('click', resetToPin);
  $('doneBtn').addEventListener('click', resetToPin);

  // ---------- confirmation ----------
  function showDone(data) {
    clearTimeout(statusTimer);
    currentPin = null;
    $('statusView').classList.add('hidden');
    const isIn = data.action === 'in';
    $('dnIcon').className = 'confirm-icon ' + (isIn ? 'in' : 'out');
    $('dnIcon').textContent = isIn ? '✔' : '⏹';
    $('dnTitle').textContent = isIn ? `${data.name}, you're clocked in` : `${data.name}, you're clocked out`;
    $('dnTime').textContent = timeFmt.format(new Date(data.at));
    $('dnDetail').textContent = isIn ? 'Have a great shift!' : `This shift: ${fmtHours(data.shift_hours)} hours. See you next time!`;
    $('dnReg').textContent = fmtHours(data.week.regular);
    $('dnOt').textContent = fmtHours(data.week.overtime);
    $('doneView').classList.remove('hidden');
    let n = 6;
    const count = () => {
      $('dnCount').textContent = `Returning in ${n}s`;
      if (n-- <= 0) resetToPin();
      else doneTimer = setTimeout(count, 1000);
    };
    clearTimeout(doneTimer);
    count();
  }

  function resetToPin() {
    clearTimeout(statusTimer);
    clearTimeout(doneTimer);
    currentPin = null;
    pin = '';
    renderDots();
    setMsg('');
    $('statusView').classList.add('hidden');
    $('doneView').classList.add('hidden');
  }

  // ---------- keep tablet awake (where supported) ----------
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
    } catch { /* not supported or not allowed; ignore */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { keepAwake(); loadInfo(); }
  });

  renderDots();
  tick();
  setInterval(tick, 1000);
  loadInfo();
  setInterval(loadInfo, 10 * 60 * 1000);
  keepAwake();
})();
