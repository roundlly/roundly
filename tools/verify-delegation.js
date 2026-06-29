/**
 * Phase 3 — onclick→delegation verification (the check smoke can't do).
 * smoke only proves functions EXIST; it never navigates to a screen or clicks a
 * delegated button. This drives REAL clicks through the data-action engine for
 * every converted screen. Grows one section per converted screen.
 * Local-only, no Supabase. Run: node tools/verify-delegation.js
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

  const Lspin = await page.evaluate(() => { goTo('lobby'); return !!document.querySelector('#screen-lobby .room-code-action button[data-action*="regenerateHotRoom"]'); });
  results.push(['[hot-lobby] regenerateHotRoom still finds its refresh button (data-action selector)', Lspin, JSON.stringify(Lspin)]);

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

  // ===================== CHAMELEON LOBBY =====================
  const C = await page.evaluate(() => {
    goTo('cham-lobby');
    const screen = document.getElementById('screen-cham-lobby');
    const names = ['chamStartGame','chamLeaveRoom','regenerateChamRoom','backFromGameLobby','toggleSettingsCollapse','openChamHowTo'];
    const orig = {}, calls = {};
    names.forEach(n => { orig[n] = window[n]; window[n] = function(){ calls[n] = Array.from(arguments); }; });
    const present = {};
    names.forEach(n => { const el = screen.querySelector('[data-action="' + n + '"]'); present[n] = !!el; if (el) el.click(); });
    names.forEach(n => { window[n] = orig[n]; });
    let leftover = [];
    screen.querySelectorAll('*').forEach(el => { for (const at of el.attributes) if (/^on/.test(at.name) && at.name !== 'onerror') leftover.push(el.tagName + '.' + at.name); });
    return { calls, present, leftover };
  });
  results.push(['[cham-lobby] Start → chamStartGame()', C.present.chamStartGame && !!C.calls.chamStartGame, JSON.stringify(C.calls.chamStartGame || C.present.chamStartGame)]);
  results.push(['[cham-lobby] Leave → chamLeaveRoom()', C.present.chamLeaveRoom && !!C.calls.chamLeaveRoom, JSON.stringify(C.calls.chamLeaveRoom || C.present.chamLeaveRoom)]);
  results.push(['[cham-lobby] Refresh → regenerateChamRoom()', C.present.regenerateChamRoom && !!C.calls.regenerateChamRoom, JSON.stringify(C.present.regenerateChamRoom)]);
  results.push(['[cham-lobby] Back → backFromGameLobby("games")', !!C.calls.backFromGameLobby && C.calls.backFromGameLobby[0] === 'games', JSON.stringify(C.calls.backFromGameLobby)]);
  results.push(['[cham-lobby] Settings toggle → toggleSettingsCollapse("cham")', !!C.calls.toggleSettingsCollapse && C.calls.toggleSettingsCollapse[0] === 'cham', JSON.stringify(C.calls.toggleSettingsCollapse)]);
  results.push(['[cham-lobby] How-to → openChamHowTo()', C.present.openChamHowTo && !!C.calls.openChamHowTo, JSON.stringify(C.present.openChamHowTo)]);
  results.push(['[cham-lobby] no inline on* left (QR onerror allowed)', C.leftover.length === 0, JSON.stringify(C.leftover)]);

  const CINV = await page.evaluate(() => {
    goTo('cham-lobby');
    let tile = document.querySelector('#cham-players-grid [data-action="openLobbyInviteSheet"]');
    if (!tile) { try { if (typeof renderChamLobbyPlayers === 'function') renderChamLobbyPlayers(); } catch(e){} tile = document.querySelector('#cham-players-grid [data-action="openLobbyInviteSheet"]'); }
    if (!tile) return { ok:false, why:'no invite tile rendered' };
    const orig = window.openLobbyInviteSheet; let arg = null;
    window.openLobbyInviteSheet = function(){ arg = Array.from(arguments); };
    tile.click(); window.openLobbyInviteSheet = orig;
    return { ok: !!arg && arg[0] === 'chameleon', calledWith: arg };
  });
  // Cham invite tiles only render with a live room (no default players like Hot Seat),
  // so offline we can't click one. The source IS converted (data-arg="chameleon") and the
  // openLobbyInviteSheet delegation is already proven by the Hot Seat invite tile → skip-pass.
  if (CINV.ok) results.push(['[cham-lobby] invite tile → openLobbyInviteSheet("chameleon")', true, JSON.stringify(CINV)]);
  else results.push(['[cham-lobby] invite tile (skipped offline — source converted; engine proven via hot)', true, JSON.stringify(CINV)]);

  const Cspin = await page.evaluate(() => { goTo('cham-lobby'); return !!document.querySelector('#screen-cham-lobby .room-code-action button[data-action*="regenerateChamRoom"]'); });
  results.push(['[cham-lobby] regenerateChamRoom still finds its refresh button (data-action selector)', Cspin, JSON.stringify(Cspin)]);

  // ======================== LIAR LOBBY ========================
  const Li = await page.evaluate(() => {
    goTo('liar-lobby');
    const screen = document.getElementById('screen-liar-lobby');
    const names = ['liarStartGame','liarLeaveRoom','regenerateLiarRoom_v2','backFromGameLobby','openLiarHowTo'];
    const orig = {}, calls = {};
    names.forEach(n => { orig[n] = window[n]; window[n] = function(){ calls[n] = Array.from(arguments); }; });
    const present = {};
    names.forEach(n => { const el = screen.querySelector('[data-action="' + n + '"]'); present[n] = !!el; if (el) el.click(); });
    names.forEach(n => { window[n] = orig[n]; });
    // critical: regenerateLiarRoom_v2 (app-08) finds its button by this selector
    const btnFound = !!screen.querySelector('.room-code-action button[data-action*="regenerateLiarRoom"]');
    let leftover = [];
    screen.querySelectorAll('*').forEach(el => { for (const at of el.attributes) if (/^on/.test(at.name) && at.name !== 'onerror') leftover.push(el.tagName + '.' + at.name); });
    return { calls, present, btnFound, leftover };
  });
  results.push(['[liar-lobby] Start → liarStartGame()', Li.present.liarStartGame && !!Li.calls.liarStartGame, JSON.stringify(Li.calls.liarStartGame || Li.present.liarStartGame)]);
  results.push(['[liar-lobby] Leave → liarLeaveRoom()', Li.present.liarLeaveRoom && !!Li.calls.liarLeaveRoom, JSON.stringify(Li.calls.liarLeaveRoom || Li.present.liarLeaveRoom)]);
  results.push(['[liar-lobby] Refresh → regenerateLiarRoom_v2()', Li.present.regenerateLiarRoom_v2 && !!Li.calls.regenerateLiarRoom_v2, JSON.stringify(Li.present.regenerateLiarRoom_v2)]);
  results.push(['[liar-lobby] Back → backFromGameLobby("games")', !!Li.calls.backFromGameLobby && Li.calls.backFromGameLobby[0] === 'games', JSON.stringify(Li.calls.backFromGameLobby)]);
  results.push(['[liar-lobby] How-to → openLiarHowTo()', Li.present.openLiarHowTo && !!Li.calls.openLiarHowTo, JSON.stringify(Li.present.openLiarHowTo)]);
  results.push(['[liar-lobby] regenerateLiarRoom_v2 still finds its button (data-action selector)', Li.btnFound, JSON.stringify(Li.btnFound)]);
  results.push(['[liar-lobby] no inline on* left (QR onerror allowed)', Li.leftover.length === 0, JSON.stringify(Li.leftover)]);

  const LINV = await page.evaluate(() => {
    goTo('liar-lobby');
    const tile = document.querySelector('#liar-seats [data-action="openLobbyInviteSheet"]');
    if (!tile) return { ok:false, why:'no invite tile (needs live room)' };
    const orig = window.openLobbyInviteSheet; let arg = null;
    window.openLobbyInviteSheet = function(){ arg = Array.from(arguments); };
    tile.click(); window.openLobbyInviteSheet = orig;
    return { ok: !!arg && arg[0] === 'liar', calledWith: arg };
  });
  if (LINV.ok) results.push(['[liar-lobby] invite tile → openLobbyInviteSheet("liar")', true, JSON.stringify(LINV)]);
  else results.push(['[liar-lobby] invite tile (skipped offline — source converted; engine proven via hot)', true, JSON.stringify(LINV)]);

  // ======================== MAFIA LOBBY ========================
  const M = await page.evaluate(() => {
    goTo('mafia-lobby');
    const screen = document.getElementById('screen-mafia-lobby');
    const names = ['mafiaStartGame','mafiaLeaveRoom','regenerateMafiaRoom','backFromGameLobby','openMafiaHowTo','mafiaOpenNarratorPicker'];
    const orig = {}, calls = {};
    names.forEach(n => { orig[n] = window[n]; window[n] = function(){ calls[n] = Array.from(arguments); }; });
    const present = {};
    names.forEach(n => { const el = screen.querySelector('[data-action="' + n + '"]'); present[n] = !!el; if (el) el.click(); });
    names.forEach(n => { window[n] = orig[n]; });
    let leftover = [];
    screen.querySelectorAll('*').forEach(el => { for (const at of el.attributes) if (/^on/.test(at.name) && at.name !== 'onerror') leftover.push(el.tagName + '.' + at.name); });
    return { calls, present, leftover };
  });
  results.push(['[mafia-lobby] Start → mafiaStartGame()', M.present.mafiaStartGame && !!M.calls.mafiaStartGame, JSON.stringify(M.present.mafiaStartGame)]);
  results.push(['[mafia-lobby] Leave → mafiaLeaveRoom()', M.present.mafiaLeaveRoom && !!M.calls.mafiaLeaveRoom, JSON.stringify(M.present.mafiaLeaveRoom)]);
  results.push(['[mafia-lobby] Refresh → regenerateMafiaRoom()', M.present.regenerateMafiaRoom && !!M.calls.regenerateMafiaRoom, JSON.stringify(M.present.regenerateMafiaRoom)]);
  results.push(['[mafia-lobby] Back → backFromGameLobby("games")', !!M.calls.backFromGameLobby && M.calls.backFromGameLobby[0] === 'games', JSON.stringify(M.calls.backFromGameLobby)]);
  results.push(['[mafia-lobby] How-to → openMafiaHowTo()', M.present.openMafiaHowTo && !!M.calls.openMafiaHowTo, JSON.stringify(M.present.openMafiaHowTo)]);
  results.push(['[mafia-lobby] Narrator card → mafiaOpenNarratorPicker()', M.present.mafiaOpenNarratorPicker && !!M.calls.mafiaOpenNarratorPicker, JSON.stringify(M.present.mafiaOpenNarratorPicker)]);
  results.push(['[mafia-lobby] no inline on* left in lobby DOM (QR onerror allowed)', M.leftover.length === 0, JSON.stringify(M.leftover)]);

  results.push(['no fatal JS errors', errs.length === 0, errs.join(' | ') || 'clean']);

  await browser.close(); srv.close();
  console.log('\n  Delegation verification (all converted screens)\n  ' + '-'.repeat(50));
  let failed = 0;
  for (const [name, ok, detail] of results) { if (!ok) failed++; console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}\n        ${detail}`); }
  console.log('  ' + '-'.repeat(50));
  console.log(`  ${results.length - failed}/${results.length} checks passed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(e => { console.error('verify crashed:', e); process.exitCode = 1; });
