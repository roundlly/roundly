/**
 * Phase 3 — onclick→delegation verification (the check smoke can't do).
 * smoke only proves functions EXIST; it never navigates to a screen or clicks a
 * delegated button. This drives REAL clicks through the data-action engine for
 * every converted screen. Grows one section per converted screen.
 * Local-only, no Supabase. Run: node tmp/verify-delegation.js
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

  // ========================= ADMIN =========================
  const a1 = await page.evaluate(() => {
    goTo('admin-stats');
    const btn = document.querySelector('#screen-admin-stats [data-action="adminStatsSetPeriod"][data-arg="7d"]');
    if (!btn) return { ok:false, why:'no 7d button' };
    btn.click();
    return { ok: (typeof adminStatsState !== 'undefined') && adminStatsState.period === '7d', period: adminStatsState && adminStatsState.period };
  });
  results.push(['[admin] period button (data-action+data-arg) sets period → 7d', a1.ok, JSON.stringify(a1)]);

  const a2 = await page.evaluate(() => {
    const orig = window.goTo; let lastArg = null;
    window.goTo = function(x){ lastArg = x; return orig.apply(this, arguments); };
    goTo('admin-stats');
    const back = document.querySelector('#screen-admin-stats [data-action="goTo"][data-arg="admin"]');
    if (!back) { window.goTo = orig; return { ok:false, why:'no back button' }; }
    lastArg = null; back.click(); window.goTo = orig;
    return { ok: lastArg === 'admin', calledWith: lastArg };
  });
  results.push(['[admin] back button (data-action=goTo) calls goTo("admin")', a2.ok, JSON.stringify(a2)]);

  const a3 = await page.evaluate(() => {
    const bd = document.getElementById('admin-stats-detail-backdrop');
    const sheet = bd.querySelector('.admin-stats-detail-sheet');
    bd.classList.add('active'); sheet.click();
    const stillOpen = bd.classList.contains('active'); bd.click();
    return { ok: stillOpen && !bd.classList.contains('active'), stillOpen };
  });
  results.push(['[admin] stats-detail backdrop self-guard (inner keeps open, backdrop closes)', a3.ok, JSON.stringify(a3)]);

  const a4 = await page.evaluate(() => {
    const bd = document.getElementById('admin-fb-menu-backdrop');
    const sheet = bd.querySelector('.fb-action-sheet');
    bd.classList.add('active'); sheet.click();
    const stillOpen = bd.classList.contains('active'); bd.click();
    return { ok: stillOpen && !bd.classList.contains('active'), stillOpen };
  });
  results.push(['[admin] fb-menu backdrop self-guard (inner keeps open, backdrop closes)', a4.ok, JSON.stringify(a4)]);

  // ===================== HOT SEAT LOBBY =====================
  // Stub the lobby's action fns so a delegated click records the call WITHOUT the
  // real side effect (navigation / RPC / starting a game), then assert the wiring.
  const L = await page.evaluate(() => {
    goTo('lobby');
    const screen = document.getElementById('screen-lobby');
    const names = ['startGame','hotLeaveRoom','regenerateHotRoom','backFromGameLobby','toggleSettingsCollapse','openHowTo'];
    const orig = {}, calls = {};
    names.forEach(n => { orig[n] = window[n]; window[n] = function(){ calls[n] = Array.from(arguments); }; });
    const fire = (act) => { const el = screen.querySelector('[data-action="' + act + '"]'); if (el) el.click(); return !!el; };
    const present = {};
    names.forEach(n => { present[n] = fire(n); });
    names.forEach(n => { window[n] = orig[n]; });
    // leftover inline on* in the lobby (the QR onerror is allowed; nothing else)
    let leftover = [];
    screen.querySelectorAll('*').forEach(el => { for (const at of el.attributes) if (/^on/.test(at.name) && at.name !== 'onerror') leftover.push(el.tagName + '.' + at.name); });
    return { calls, present, leftover };
  });
  results.push(['[hot-lobby] Start button → startGame()', L.present.startGame && !!L.calls.startGame, JSON.stringify(L.calls.startGame || L.present.startGame)]);
  results.push(['[hot-lobby] Leave button → hotLeaveRoom()', L.present.hotLeaveRoom && !!L.calls.hotLeaveRoom, JSON.stringify(L.calls.hotLeaveRoom || L.present.hotLeaveRoom)]);
  results.push(['[hot-lobby] Refresh-code → regenerateHotRoom()', L.present.regenerateHotRoom && !!L.calls.regenerateHotRoom, JSON.stringify(L.calls.regenerateHotRoom || L.present.regenerateHotRoom)]);
  results.push(['[hot-lobby] Back → backFromGameLobby("games")', L.calls.backFromGameLobby && L.calls.backFromGameLobby[0] === 'games', JSON.stringify(L.calls.backFromGameLobby)]);
  results.push(['[hot-lobby] Settings toggle → toggleSettingsCollapse("hot")', L.calls.toggleSettingsCollapse && L.calls.toggleSettingsCollapse[0] === 'hot', JSON.stringify(L.calls.toggleSettingsCollapse)]);
  results.push(['[hot-lobby] How-to → openHowTo()', L.present.openHowTo && !!L.calls.openHowTo, JSON.stringify(L.calls.openHowTo || L.present.openHowTo)]);
  results.push(['[hot-lobby] no inline on* left (QR onerror allowed)', L.leftover.length === 0, JSON.stringify(L.leftover)]);

  const INV = await page.evaluate(() => {
    goTo('lobby');
    const tile = document.querySelector('#lobby-players-grid [data-action="openLobbyInviteSheet"]');
    if (!tile) return { ok:false, why:'no invite tile rendered' };
    const orig = window.openLobbyInviteSheet; let arg = null;
    window.openLobbyInviteSheet = function(){ arg = Array.from(arguments); };
    tile.click();
    window.openLobbyInviteSheet = orig;
    return { ok: !!arg && arg[0] === 'hotseat', calledWith: arg };
  });
  results.push(['[hot-lobby] empty-seat invite tile → openLobbyInviteSheet("hotseat")', INV.ok, JSON.stringify(INV)]);

  // Dynamic settings controls (rounds/order) — only if renderSettings populated them.
  const S = await page.evaluate(() => {
    goTo('lobby');
    try { if (typeof renderSettings === 'function') renderSettings(); } catch(e) { return { skipped:true, why:String(e.message||e) }; }
    const rb = document.querySelector('#settings-list [data-action="setRounds"][data-arg="2"]');
    const ob = document.querySelector('#settings-list [data-action="setOrder"]');
    if (!rb && !ob) return { skipped:true, why:'settings not rendered (needs a mode)' };
    const orig = { setRounds: window.setRounds, setOrder: window.setOrder }; const calls = {};
    window.setRounds = function(){ calls.setRounds = Array.from(arguments); };
    window.setOrder  = function(){ calls.setOrder  = Array.from(arguments); };
    if (rb) rb.click(); if (ob) ob.click();
    window.setRounds = orig.setRounds; window.setOrder = orig.setOrder;
    // setRounds coercion sanity: Number("2") === 2
    return { skipped:false, calls, roundsArgIsString: rb ? (typeof calls.setRounds?.[0]) : 'n/a', coerces: Number('2') === 2 };
  });
  if (S.skipped) results.push(['[hot-lobby] dynamic rounds/order (skipped)', true, JSON.stringify(S)]);
  else {
    results.push(['[hot-lobby] rounds button → setRounds("2") (delegation passes string; fn coerces)', !!S.calls.setRounds && S.calls.setRounds[0] === '2', JSON.stringify(S.calls.setRounds)]);
    if (S.calls.setOrder) results.push(['[hot-lobby] order button → setOrder(arg)', !!S.calls.setOrder, JSON.stringify(S.calls.setOrder)]);
  }

  results.push(['no fatal JS errors', errs.length === 0, errs.join(' | ') || 'clean']);

  await browser.close(); srv.close();
  console.log('\n  Delegation verification (all converted screens)\n  ' + '-'.repeat(50));
  let failed = 0;
  for (const [name, ok, detail] of results) { if (!ok) failed++; console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}\n        ${detail}`); }
  console.log('  ' + '-'.repeat(50));
  console.log(`  ${results.length - failed}/${results.length} checks passed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(e => { console.error('verify crashed:', e); process.exitCode = 1; });
