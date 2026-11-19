'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // ---------- languages ----------
  const STRINGS = {
    en: {
      locale: 'en-US',
      admin: 'Admin',
      enterPin: 'Enter your PIN',
      clear: 'Clear',
      backspace: 'Backspace',
      cancel: 'Cancel',
      done: 'Done',
      regularWeek: 'Regular hrs this week',
      overtimeWeek: 'Overtime hrs this week',
      hi: (name) => `Hi, ${name}`,
      statusIn: 'CLOCKED IN',
      statusOut: 'CLOCKED OUT',
      since: (when) => ` since ${when}`,
      clockIn: 'CLOCK IN',
      clockOut: 'CLOCK OUT',
      doneIn: (name) => `${name}, you're clocked in`,
      doneOut: (name) => `${name}, you're clocked out`,
      greatShift: 'Have a great shift!',
      shiftHours: (h) => `This shift: ${h} hours. See you next time!`,
      returning: (n) => `Returning in ${n}s`,
      title: (company) => `${company} Time Clock`.trim(),
      errors: {
        pin_not_recognized: 'PIN not recognized.',
        locked: (secs) => `Too many wrong PINs. Try again in ${secs} seconds.`,
        already_in: 'You are already clocked in.',
        not_in: 'You are not clocked in.',
        offline: 'Cannot reach the time clock server.',
        generic: 'Something went wrong. Please try again.',
      },
    },
    es: {
      locale: 'es-US',
      admin: 'Admin',
      enterPin: 'Ingrese su PIN',
      clear: 'Borrar',
      backspace: 'Borrar un dígito',
      cancel: 'Cancelar',
      done: 'Listo',
      regularWeek: 'Horas regulares esta semana',
      overtimeWeek: 'Horas extra esta semana',
      hi: (name) => `Hola, ${name}`,
      statusIn: 'EN TURNO',
      statusOut: 'FUERA DE TURNO',
      since: (when) => ` desde ${when}`,
      clockIn: 'MARCAR ENTRADA',
      clockOut: 'MARCAR SALIDA',
      doneIn: (name) => `${name}, marcó su entrada`,
      doneOut: (name) => `${name}, marcó su salida`,
      greatShift: '¡Que tenga un buen turno!',
      shiftHours: (h) => `Este turno: ${h} horas. ¡Hasta la próxima!`,
      returning: (n) => `Regresando en ${n} s`,
      title: (company) => `Reloj checador ${company}`.trim(),
      errors: {
        pin_not_recognized: 'PIN no reconocido.',
        locked: (secs) => `Demasiados PIN incorrectos. Intente de nuevo en ${secs} segundos.`,
        already_in: 'Ya marcó su entrada.',
        not_in: 'No ha marcado su entrada.',
        offline: 'No se puede conectar con el servidor del reloj.',
        generic: 'Algo salió mal. Intente de nuevo.',
      },
    },
  };
  const LANG_KEY = 'timeclock-lang';
  let lang = 'en';
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && STRINGS[saved]) lang = saved;
  } catch { /* storage unavailable: default to English */ }
  const t = () => STRINGS[lang];

  let timeFmt;
  let dateFmt;
  let shortDateTime;
  function makeFormats() {
    const loc = t().locale;
    timeFmt = new Intl.DateTimeFormat(loc, { hour: 'numeric', minute: '2-digit' });
    dateFmt = new Intl.DateTimeFormat(loc, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    shortDateTime = new Intl.DateTimeFormat(loc, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  let pinLength = 4;
  let pin = '';
  let busy = false;
  let currentPin = null; // PIN of the employee shown on the status screen
  let statusTimer = null;
  let doneTimer = null;
  let serverOffset = 0; // server clock - tablet clock
  let companyName = '';
  let lastStatus = null; // re-render the status screen if the language changes
  let lastDone = null;
  let pinError = null; // { code, retry_after } so the message can be re-translated

  class ApiError extends Error {
    constructor(data) {
      super(data.error || 'error');
      this.code = data.code;
      this.retryAfter = data.retry_after;
    }
  }

  function errorText(err) {
    const e = t().errors;
    if (!err) return '';
    if (err.code === 'locked') return e.locked(err.retryAfter);
    return e[err.code] || e.generic;
  }

  async function api(path, body) {
    let res;
    try {
      res = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError({ code: 'offline' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data);
    return data;
  }

  function applyLanguage() {
    const s = t();
    makeFormats();
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = s[el.dataset.i18n];
    for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', s[el.dataset.i18nLabel]);
    for (const b of $('langSwitch').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    if (companyName) document.title = s.title(companyName);
    setMsg(errorText(pinError));
    tick();
    if (!$('statusView').classList.contains('hidden') && lastStatus) renderStatus(lastStatus);
    if (!$('doneView').classList.contains('hidden') && lastDone) renderDone(lastDone);
  }

  function setLanguage(next) {
    if (!STRINGS[next] || next === lang) return;
    lang = next;
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
    applyLanguage();
  }

  $('langSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lang]');
    if (b) setLanguage(b.dataset.lang);
  });

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
      companyName = info.company_name || '';
      $('company').textContent = companyName || 'Time Clock';
      document.title = t().title(companyName);
      if (pinError && pinError.code === 'offline') { pinError = null; setMsg(''); }
      renderDots();
    } catch (e) {
      pinError = e;
      setMsg(errorText(e));
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
    pinError = null;
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
      pinError = e;
      setMsg(errorText(e));
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

  function renderStatus(data) {
    const s = t();
    $('stName').textContent = s.hi(data.name);
    const line = $('stLine');
    line.innerHTML = '';
    const badge = document.createElement('span');
    badge.className = 'badge ' + (data.clocked_in ? 'in' : 'out');
    badge.textContent = data.clocked_in ? s.statusIn : s.statusOut;
    line.appendChild(badge);
    if (data.clocked_in) {
      line.appendChild(document.createTextNode(s.since(shortDateTime.format(new Date(data.clocked_in_at)))));
    }
    $('stReg').textContent = fmtHours(data.week.regular);
    $('stOt').textContent = fmtHours(data.week.overtime);
    const btn = $('punchBtn');
    btn.className = 'big-btn ' + (data.clocked_in ? 'out' : 'in');
    btn.textContent = data.clocked_in ? s.clockOut : s.clockIn;
    btn.dataset.action = data.clocked_in ? 'out' : 'in';
    const err = $('stMsg').dataset.err;
    $('stMsg').textContent = err ? errorText(JSON.parse(err)) : '';
  }

  function showStatus(data) {
    lastStatus = data;
    $('stMsg').dataset.err = '';
    $('punchBtn').disabled = false;
    renderStatus(data);
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
      $('stMsg').dataset.err = JSON.stringify({ code: e.code, retryAfter: e.retryAfter });
      $('stMsg').textContent = errorText(e);
      btn.disabled = false;
    }
  });

  $('cancelBtn').addEventListener('click', resetToPin);
  $('doneBtn').addEventListener('click', resetToPin);

  // ---------- confirmation ----------
  let countdown = 0;
  function renderDone(data) {
    const s = t();
    const isIn = data.action === 'in';
    $('dnIcon').className = 'confirm-icon ' + (isIn ? 'in' : 'out');
    $('dnIcon').innerHTML = isIn
      ? '<span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>'
      : '<span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 17l5-5-5-5M21 12H9M12 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/></svg></span>';
    $('dnTitle').textContent = isIn ? s.doneIn(data.name) : s.doneOut(data.name);
    $('dnTime').textContent = timeFmt.format(new Date(data.at));
    $('dnDetail').textContent = isIn ? s.greatShift : s.shiftHours(fmtHours(data.shift_hours));
    $('dnReg').textContent = fmtHours(data.week.regular);
    $('dnOt').textContent = fmtHours(data.week.overtime);
    $('dnCount').textContent = s.returning(countdown);
  }

  function showDone(data) {
    clearTimeout(statusTimer);
    currentPin = null;
    lastStatus = null;
    lastDone = data;
    $('statusView').classList.add('hidden');
    countdown = 6;
    renderDone(data);
    $('doneView').classList.remove('hidden');
    const step = () => {
      $('dnCount').textContent = t().returning(countdown);
      if (countdown-- <= 0) resetToPin();
      else doneTimer = setTimeout(step, 1000);
    };
    clearTimeout(doneTimer);
    step();
  }

  function resetToPin() {
    clearTimeout(statusTimer);
    clearTimeout(doneTimer);
    currentPin = null;
    lastStatus = null;
    lastDone = null;
    pin = '';
    pinError = null;
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

  applyLanguage();
  renderDots();
  setInterval(tick, 1000);
  loadInfo();
  setInterval(loadInfo, 10 * 60 * 1000);
  keepAwake();
})();
