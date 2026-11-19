'use strict';

// Builds a self-contained demo of the time clock as one HTML file.
//
// The demo uses the real kiosk and admin pages, styles and scripts from
// public/, plus a stand-in for the server (demo/mock.js) that runs in the
// browser and keeps data in localStorage. No server is needed, so the output
// can be hosted anywhere static, such as GitHub Pages.
//
//   node demo/build.js                       -> docs/index.html (full page)
//   node demo/build.js --fragment out.html   -> page body only (for embedding)

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function sub(s, oldStr, newStr, label) {
  const n = s.split(oldStr).length - 1;
  if (n !== 1) throw new Error(`demo build: "${label}" expected 1 match, found ${n}. Did the page change?`);
  return s.replace(oldStr, () => newStr);
}
function subRe(s, re, newStr, label) {
  if (!re.test(s)) throw new Error(`demo build: "${label}" not found. Did the page change?`);
  return s.replace(re, () => newStr);
}
function bodyOf(html) {
  const m = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
  return m[1].replace(/<script[^>]*><\/script>/g, '');
}

function build() {
  const css = rd('public/css/style.css') + '\n' + rd('demo/demo.css');

  // ----- kiosk page -----
  let kioskHtml = bodyOf(rd('public/index.html'));
  kioskHtml = sub(kioskHtml,
    '<a class="admin-link" href="/admin" data-i18n="admin">Admin</a>',
    '<button type="button" class="admin-link" data-go="admin" data-i18n="admin">Admin</button>', 'admin link');
  kioskHtml = sub(kioskHtml, '      <div class="header-actions">',
    '      <button type="button" class="demo-pill" id="demoPill">Demo<span class="pill-long"> &middot; test PINs</span></button>\n      <div class="header-actions">', 'demo pill');

  // ----- admin page -----
  let adminHtml = bodyOf(rd('public/admin.html'));
  adminHtml = sub(adminHtml, '<a class="nav-link" href="/" id="toKiosk"', '<a class="nav-link" href="#" data-go="kiosk" id="toKiosk"', 'time clock link');
  adminHtml = sub(adminHtml, '<a href="/" class="btn ghost" id="loginBack">', '<a href="#" data-go="kiosk" class="btn ghost" id="loginBack">', 'back link');
  adminHtml = subRe(adminHtml, /\s*<button type="button" class="btn" id="tsPrint">[\s\S]*?<\/button>/, '', 'print button');
  const i = adminHtml.indexOf('<div class="panel" id="backupPanel">');
  const j = adminHtml.indexOf('<div class="save-bar">');
  if (i < 0 || j < 0) throw new Error('demo build: backup panel not found');
  adminHtml = adminHtml.slice(0, i) + `<div class="panel">
                <div class="panel-head"><div><h2>Demo data</h2><p class="sub">The real app has a Download backup button here.</p></div></div>
                <div class="panel-body form-grid">
                  <p class="hint">Wipe your test changes and start over with the sample employees and hours.</p>
                  <div><button type="button" class="btn danger" id="demoReset2">Reset demo data</button></div>
                </div>
              </div>
            </div>
            ` + adminHtml.slice(j);

  // ----- scripts -----
  let kioskJs = rd('public/js/kiosk.js');
  kioskJs = sub(kioskJs, "  document.addEventListener('keydown', (e) => {\n",
    "  document.addEventListener('keydown', (e) => {\n    if ($('kioskApp').hidden) return;\n", 'keydown guard');
  kioskJs = sub(kioskJs, '  applyLanguage();\n  renderDots();',
    '  window.__kiosk = { reset: resetToPin, reload: loadInfo };\n  applyLanguage();\n  renderDots();', 'expose kiosk');

  let adminJs = rd('public/js/admin.js');
  adminJs = sub(adminJs, 'if (!confirm(`Clock out ${e.name} now?`)) return;',
    "if (!(await window.ask(`Clock out ${e.name} now?`, { ok: 'Clock out' }))) return;", 'confirm');
  adminJs = sub(adminJs, "const reason = prompt('Delete this punch? Enter a reason (optional):', '');",
    "const reason = await window.ask('Delete this punch? This cannot be undone.', { input: true, placeholder: 'Reason (optional)', ok: 'Delete punch', danger: true });", 'prompt');
  adminJs = sub(adminJs,
    "    $('tsCsv').dataset.href = `/api/admin/report.csv?${q}`;\n    $('tsCsvDaily').dataset.href = `/api/admin/report.csv?${q}&detail=1`;\n",
    '    window.__csvQuery = q;\n', 'csv links');
  adminJs = subRe(adminJs, /  for \(const id of \['tsCsv', 'tsCsvDaily'\]\) \{[\s\S]*?\n  \}\n  \$\('tsPrint'\)[\s\S]*?\n  \}\);\n/, '', 'csv/print handlers');
  adminJs = subRe(adminJs, /  init\(\)\.catch\(\(e\) => \{\n[\s\S]*?\n  \}\);\n/,
    '  window.__adminInit = () => init().catch((e) => toast(e.message));\n', 'admin init');
  adminJs = sub(adminJs,
    "    $('loginHint').textContent = setup\n      ? 'First-time setup: choose an admin PIN (4-8 digits). You will use it to manage employees and hours.'\n      : 'Enter the admin PIN.';\n",
    "    if (setup) $('loginHint').textContent = 'First-time setup: choose an admin PIN (4-8 digits).';\n", 'login hint');

  const hoursJs = 'window.__hours = (function () { const module = { exports: {} };\n' + rd('server/hours.js') + '\nreturn module.exports; })();';

  const body = `<div id="kioskApp">
${kioskHtml}
</div>
<div id="adminApp" hidden>
${adminHtml}
</div>
${rd('demo/demo.html')}
<script>
${hoursJs}
</script>
<script>
${rd('demo/mock.js')}
</script>
<script>
${kioskJs}
</script>
<script>
${adminJs}
</script>
<script>
${rd('demo/glue.js')}
</script>
`;
  const fonts = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">`;
  const icon = 'data:image/svg+xml,' + encodeURIComponent(rd('public/icon.svg').trim());

  const fragment = `<title>Kuipers Time Clock</title>
${fonts}
<style>
${css}
</style>
${body}`;

  const full = `<!doctype html>
<!-- Generated by demo/build.js from public/ and demo/. Do not edit by hand: run "npm run build:demo". -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1220">
<meta name="description" content="Try the Kuipers Time Clock: employees clock in with a PIN, and admins track regular and overtime hours.">
<title>Kuipers Time Clock Demo</title>
<link rel="icon" href="${icon}">
${fonts}
<style>
${css}
</style>
</head>
<body class="theme-kiosk">
${body}</body>
</html>
`;
  return { full, fragment };
}

module.exports = { build };

if (require.main === module) {
  const { full, fragment } = build();
  const fi = process.argv.indexOf('--fragment');
  if (fi > 0) {
    fs.writeFileSync(process.argv[fi + 1], fragment);
    console.log(`Wrote ${process.argv[fi + 1]}`);
  } else {
    const out = path.join(ROOT, 'docs', 'index.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, full);
    fs.writeFileSync(path.join(ROOT, 'docs', '.nojekyll'), '');
    console.log(`Wrote ${path.relative(ROOT, out)} (${Math.round(full.length / 1024)} KB)`);
  }
}
