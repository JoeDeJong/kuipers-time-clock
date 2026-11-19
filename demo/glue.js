// Demo-only: switches between the time clock and admin views, replaces
// browser pop-ups with in-page dialogs, shows CSV exports and the demo info card.
(function () {
  const $ = (id) => document.getElementById(id);

  // Confirmation / reason dialog (the artifact viewer blocks confirm() and prompt()).
  window.ask = function (message, opts = {}) {
    return new Promise((resolve) => {
      const dlg = $('askDlg');
      $('askMsg').textContent = message;
      $('askInputWrap').hidden = !opts.input;
      $('askInput').value = '';
      $('askInput').placeholder = opts.placeholder || '';
      $('askOk').textContent = opts.ok || 'OK';
      $('askOk').className = 'btn ' + (opts.danger ? 'danger' : 'primary');
      const done = (val) => { dlg.close(); $('askOk').onclick = null; $('askCancel').onclick = null; resolve(val); };
      $('askOk').onclick = () => done(opts.input ? $('askInput').value : true);
      $('askCancel').onclick = () => done(opts.input ? null : false);
      dlg.oncancel = (e) => { e.preventDefault(); done(opts.input ? null : false); };
      dlg.showModal();
      if (opts.input) $('askInput').focus();
    });
  };

  // CSV viewer (downloads are blocked in the viewer, so show the text with a Copy button).
  async function showCsv(daily) {
    const q = window.__csvQuery;
    if (!q) return;
    const res = await fetch(`/api/admin/report.csv?${q}${daily ? '&detail=1' : ''}`);
    $('csvText').value = await res.text();
    $('csvTitle').textContent = daily ? 'Daily CSV export' : 'CSV export';
    $('csvCopy').textContent = 'Copy';
    $('csvDlg').showModal();
  }
  $('tsCsv').addEventListener('click', () => showCsv(false));
  $('tsCsvDaily').addEventListener('click', () => showCsv(true));
  $('csvClose').addEventListener('click', () => $('csvDlg').close());
  $('csvCopy').addEventListener('click', () => {
    const ta = $('csvText');
    const fallback = () => { ta.focus(); ta.select(); $('csvCopy').textContent = 'Selected, press Ctrl+C'; };
    try {
      navigator.clipboard.writeText(ta.value).then(() => { $('csvCopy').textContent = 'Copied'; }, fallback);
    } catch { fallback(); }
  });

  // Views
  function go(view) {
    const admin = view === 'admin';
    document.body.className = admin ? 'theme-admin' : 'theme-kiosk';
    $('kioskApp').hidden = admin;
    $('adminApp').hidden = !admin;
    $('demoPill').hidden = admin;
    if (!admin) $('demoCard').hidden = true;
    if (admin) { window.__kiosk.reset(); window.__adminInit(); } else { window.__kiosk.reload(); }
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (b) { e.preventDefault(); go(b.dataset.go); }
  });

  // Demo info card
  const tbody = $('demoPins');
  for (const [name, pin] of window.__demo.pins) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td class="num"><b></b></td>`;
    tr.children[0].textContent = name;
    tr.children[1].firstChild.textContent = pin;
    tbody.appendChild(tr);
  }
  $('demoAdminPin').textContent = window.__demo.adminPin;
  $('loginHint').textContent = `Enter the admin PIN. In this demo it is ${window.__demo.adminPin}.`;
  $('demoPill').addEventListener('click', () => { $('demoCard').hidden = !$('demoCard').hidden; });
  $('demoClose').addEventListener('click', () => { $('demoCard').hidden = true; });
  async function reset() {
    if (!(await window.ask('Erase all changes and reload the sample employees and hours?', { ok: 'Reset demo data', danger: true }))) return;
    window.__demo.reset();
    go('kiosk');
  }
  $('demoReset').addEventListener('click', reset);
  $('demoReset2').addEventListener('click', reset);

  go('kiosk');
  $('demoCard').hidden = false;
})();
