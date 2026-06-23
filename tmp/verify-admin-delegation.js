/**
 * Phase 3 — admin onclick→delegation verification (the check smoke can't do).
 * smoke only proves functions EXIST; it never navigates to admin or clicks a
 * delegated button. This drives real clicks through the new data-action engine:
 *   - period button (data-action + data-arg) mutates adminStatsState.period
 *   - back button (data-action=goTo) navigates screens
 *   - sheet backdrops (data-action-self): click INSIDE keeps open, click the
 *     backdrop itself closes — proving the stopPropagation replacement works
 * Local-only, no Supabase. Run: node tmp/verify-admin-delegation.js
 */
const http = require('http'), fs = require('fs'), path = require('path'), puppeteer = require('puppeteer');
const ROOT = path.join(__dirname, '..'), HOST = '127.0.0.1', PORT = 4199;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.mp3':'audio/mpeg','.svg':'image/svg+xml' };
function server(){ return new Promise(r => { const s = http.createServer((req,res)=>{ const p = path.join(ROOT, req.url==='/'?'index.html':decodeURIComponent(req.url.split('?')[0])); if(!p.startsWith(ROOT)){res.writeHead(403);res.end();return;} fs.readFile(p,(e,d)=>{ if(e){res.writeHead(404);res.end();} else {res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(d);} }); }); s.listen(PORT,HOST,()=>r(s)); }); }

(async () => {
  const results = [];
  const srv = await server();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e.message || e)));
  await page.goto(`http://${HOST}:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction('typeof window.goTo === "function"', { timeout: 15000 }).catch(()=>{});

  // 1) period button: data-action="adminStatsSetPeriod" data-arg="7d" → state.period === '7d'
  const t1 = await page.evaluate(() => {
    goTo('admin-stats');
    const btn = document.querySelector('#screen-admin-stats [data-action="adminStatsSetPeriod"][data-arg="7d"]');
    if (!btn) return { ok:false, why:'no 7d button found' };
    const before = (typeof adminStatsState !== 'undefined') ? adminStatsState.period : '??';
    btn.click(); // real bubbling click → delegated listener
    const after = (typeof adminStatsState !== 'undefined') ? adminStatsState.period : '??';
    return { ok: after === '7d', before, after };
  });
  results.push(['period button (data-action + data-arg) sets period → 7d', t1.ok, JSON.stringify(t1)]);

  // 2) back button: data-action="goTo" data-arg="admin" → delegated click calls goTo('admin').
  //    We assert the CALL, not the resulting screen: the admin hub is access-gated and
  //    redirects non-admins, so the final screen depends on auth, not on the wiring.
  const t2 = await page.evaluate(() => {
    const orig = window.goTo; let lastArg = null;
    window.goTo = function(x){ lastArg = x; return orig.apply(this, arguments); };
    goTo('admin-stats');
    const back = document.querySelector('#screen-admin-stats [data-action="goTo"][data-arg="admin"]');
    if (!back) { window.goTo = orig; return { ok:false, why:'no back button' }; }
    lastArg = null;               // ignore the setup goTo above
    back.click();
    window.goTo = orig;
    return { ok: lastArg === 'admin', delegatedCalledGoToWith: lastArg };
  });
  results.push(['back button (data-action=goTo) calls goTo("admin")', t2.ok, JSON.stringify(t2)]);

  // 3) stats-detail backdrop (data-action-self): inner click keeps open, backdrop click closes
  const t3 = await page.evaluate(() => {
    const bd = document.getElementById('admin-stats-detail-backdrop');
    const sheet = bd.querySelector('.admin-stats-detail-sheet');
    bd.classList.add('active');
    sheet.click();                                   // must NOT close
    const stillOpen = bd.classList.contains('active');
    bd.click();                                      // must close
    const closed = !bd.classList.contains('active');
    return { ok: stillOpen && closed, stillOpenAfterInnerClick: stillOpen, closedAfterBackdropClick: closed };
  });
  results.push(['stats-detail backdrop self-guard (inner keeps open, backdrop closes)', t3.ok, JSON.stringify(t3)]);

  // 4) fb-menu backdrop: same data-action-self pattern
  const t4 = await page.evaluate(() => {
    const bd = document.getElementById('admin-fb-menu-backdrop');
    const sheet = bd.querySelector('.fb-action-sheet');
    bd.classList.add('active');
    sheet.click();
    const stillOpen = bd.classList.contains('active');
    bd.click();
    const closed = !bd.classList.contains('active');
    return { ok: stillOpen && closed, stillOpenAfterInnerClick: stillOpen, closedAfterBackdropClick: closed };
  });
  results.push(['fb-menu backdrop self-guard (inner keeps open, backdrop closes)', t4.ok, JSON.stringify(t4)]);

  // 5) no admin onclick left in the static markup (CSP-cleanliness for this cluster)
  const t5 = await page.evaluate(() => {
    const ids = ['screen-admin','screen-admin-feedback','screen-admin-stats','admin-stats-detail-backdrop','admin-fb-menu-backdrop'];
    let leftover = 0; const where = [];
    ids.forEach(id => { const root = document.getElementById(id); if (!root) return; root.querySelectorAll('*').forEach(el => { for (const a of el.attributes) if (/^on/.test(a.name)) { leftover++; where.push(id + ':' + a.name); } }); });
    return { ok: leftover === 0, leftover, where };
  });
  results.push(['no inline on* handlers left in admin DOM', t5.ok, JSON.stringify(t5)]);

  results.push(['no fatal JS errors', errs.length === 0, errs.join(' | ') || 'clean']);

  await browser.close(); srv.close();
  console.log('\n  Admin delegation verification\n  ' + '-'.repeat(46));
  let failed = 0;
  for (const [name, ok, detail] of results) { if (!ok) failed++; console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}\n        ${detail}`); }
  console.log('  ' + '-'.repeat(46));
  console.log(`  ${results.length - failed}/${results.length} checks passed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(e => { console.error('verify crashed:', e); process.exitCode = 1; });
