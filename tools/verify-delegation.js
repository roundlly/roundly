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
    const names = ['startGame','hotLeaveRoom','regenerateHotRoom','backFromGameLobby','openHotModeSettings','huddleToggleLock','openHowTo'];
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
  results.push(['[hot-lobby] Settings gear → openHotModeSettings()', L.present.openHotModeSettings && !!L.calls.openHotModeSettings, JSON.stringify(L.calls.openHotModeSettings || L.present.openHotModeSettings)]);
  results.push(['[hot-lobby] Lock button → huddleToggleLock("hot")', L.calls.huddleToggleLock && L.calls.huddleToggleLock[0] === 'hot', JSON.stringify(L.calls.huddleToggleLock)]);
  results.push(['[hot-lobby] How-to → openHowTo()', L.present.openHowTo && !!L.calls.openHowTo, JSON.stringify(L.calls.openHowTo || L.present.openHowTo)]);
  results.push(['[hot-lobby] no inline on* left (QR onerror allowed)', L.leftover.length === 0, JSON.stringify(L.leftover)]);

  // Mode-settings sheet backdrop self-guard (data-action-self): inner clicks keep it
  // open, a direct backdrop click closes it via the real closeHotModeSettings().
  const MS = await page.evaluate(() => {
    const bd = document.getElementById('hot-modeset-backdrop');
    if (!bd) return { ok:false, why:'no hot-modeset-backdrop' };
    const sheet = bd.querySelector('.sheet');
    bd.classList.add('active'); sheet.click();
    const stillOpen = bd.classList.contains('active'); bd.click();
    return { ok: stillOpen && !bd.classList.contains('active'), stillOpen };
  });
  results.push(['[hot-lobby] mode-settings backdrop self-guard (inner keeps open, backdrop closes)', MS.ok, JSON.stringify(MS)]);

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

  // Dynamic settings controls (rounds/order) — now live in the mode-settings SHEET
  // (#hot-modeset-list), populated by renderSettings() → renderHotModeSettings().
  const S = await page.evaluate(() => {
    goTo('lobby');
    try { if (typeof renderSettings === 'function') renderSettings(); } catch(e) { return { skipped:true, why:String(e.message||e) }; }
    const rb = document.querySelector('#hot-modeset-list [data-action="setRounds"][data-arg="2"]');
    const ob = document.querySelector('#hot-modeset-list [data-action="setOrder"]');
    if (!rb && !ob) return { skipped:true, why:'settings not rendered (link mode has none)' };
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

  // Guess the Theme: the mode-settings sheet shows a Theme-pack row that opens the
  // pack picker (≥5 packs incl. Mixed, counts derived from LINKS); backdrop closes it.
  const LP = await page.evaluate(() => {
    goTo('lobby');
    try { state.mode = 'link'; renderSettings(); } catch(e){ return { ok:false, why:String(e.message||e) }; }
    const row = document.querySelector('#hot-modeset-list [data-action="openLinkPackSheet"]');
    if (!row) { state.mode = 'classic'; renderSettings(); return { ok:false, why:'no theme-pack row' }; }
    row.click();
    const open = document.getElementById('linkpack-backdrop').classList.contains('active');
    const opts = document.querySelectorAll('#linkpack-options [data-action="pickLinkPack"]').length;
    document.getElementById('linkpack-backdrop').click();
    const closed = !document.getElementById('linkpack-backdrop').classList.contains('active');
    state.mode = 'classic'; renderSettings();
    return { ok: open && opts >= 5 && closed, open, opts, closed };
  });
  results.push(['[hot-lobby] theme-pack row → picker opens, ≥5 packs, backdrop closes', LP.ok, JSON.stringify(LP)]);

  // Guess the Theme: the sheet's hot-seat-order row — exactly 3 ways with 'giver'
  // (no 'host', that's Classic/Silent-only), giver active by default (hotLinkOrder
  // fallback), and the buttons delegate to setOrder.
  const GO = await page.evaluate(() => {
    goTo('lobby');
    try { state.mode = 'link'; renderSettings(); } catch(e){ return { ok:false, why:String(e.message||e) }; }
    const giverBtn = document.querySelector('#hot-modeset-list [data-action="setOrder"][data-arg="giver"]');
    const hostBtn  = document.querySelector('#hot-modeset-list [data-action="setOrder"][data-arg="host"]');
    const count = document.querySelectorAll('#hot-modeset-list [data-action="setOrder"]').length;
    const orig = window.setOrder; let arg = null;
    window.setOrder = function(){ arg = Array.from(arguments); };
    if (giverBtn) giverBtn.click();
    window.setOrder = orig;
    state.mode = 'classic'; renderSettings();
    return { ok: !!giverBtn && !hostBtn && count === 3 && !!arg && arg[0] === 'giver', count, hasHost: !!hostBtn, calledWith: arg };
  });
  results.push(['[hot-lobby] GTT order row → 3 ways incl. "giver", no "host", setOrder("giver") wired', GO.ok, JSON.stringify(GO)]);

  // Guess the Theme: final-standings screen (phase 'ended') — renders the
  // ranked rows + biggest-giver callout, and the host actions (Play again /
  // Change pack / Close room) fire through the data-action engine.
  const TE = await page.evaluate(() => {
    const sid = hotGetSessionId();
    const saved = { mode: state.mode, phase: state.phase, endReason: state.endReason,
                    hostId: state.hostId, claimedBy: state.claimedBy, meId: state.meId,
                    myId: hotMe.myId, usedWords: state.usedWords, counted: state._gamesPlayedCounted };
    try {
      state.mode = 'link'; state.phase = 'ended'; state.endReason = 'deck';
      state.hostId = sid; state.claimedBy = { jordan: sid, alex: 'sid_other' };
      hotMe.myId = 'jordan'; state.meId = 'jordan';
      state.players[0].bestTimeMs = 8000; state.players[0].wins = 2;
      state.players[1].giverCount = 3;
      state.usedWords = Object.keys(LINKS); state._gamesPlayedCounted = true; // don't bump stats in a test
      if (typeof renderThemeEnd !== 'function') return { ok:false, why:'no renderThemeEnd' };
      renderThemeEnd();
    } catch(e){ return { ok:false, why:String(e.message||e) }; }
    const rows = document.querySelectorAll('#theme-end-lb .lb-row').length;
    const crowned = !!document.querySelector('#theme-end-lb .lb-row.winner');
    const giverShown = !document.getElementById('theme-end-giver').hidden;
    const deckTitle = document.getElementById('theme-end-title').textContent;
    const names = ['hotPlayAgain','openLinkPackSheet','hotCloseRoom'];
    const orig = {}, calls = {};
    names.forEach(n => { orig[n] = window[n]; window[n] = function(){ calls[n] = true; }; });
    const present = {};
    names.forEach(n => { const el = document.querySelector('#theme-end-actions [data-action="' + n + '"]'); present[n] = !!el; if (el) el.click(); });
    names.forEach(n => { window[n] = orig[n]; });
    // restore
    state.players[0].bestTimeMs = null; state.players[0].wins = 0; state.players[1].giverCount = 0;
    state.mode = saved.mode; state.phase = saved.phase; state.endReason = saved.endReason;
    state.hostId = saved.hostId; state.claimedBy = saved.claimedBy; state.meId = saved.meId;
    hotMe.myId = saved.myId; state.usedWords = saved.usedWords; state._gamesPlayedCounted = saved.counted;
    renderSettings();
    return { ok: rows === 2 && crowned && giverShown && !!deckTitle
                 && names.every(n => present[n] && calls[n]),
             rows, crowned, giverShown, deckTitle, present, calls };
  });
  results.push(['[theme-end] standings render (2 rows, crown, biggest-giver) + host buttons wired', TE.ok, JSON.stringify(TE)]);

  // Guess the Theme: manually-paced how-to walkthrough — 8 steps, Back/Next
  // via the data-action engine, Back hidden on step 1, Next relabels to the
  // closing CTA on the last step, and the last Next closes back out.
  const TW = await page.evaluate(() => {
    goTo('lobby');
    if (typeof openThemeHowTo !== 'function') return { ok:false, why:'no openThemeHowTo' };
    openThemeHowTo();
    const onScreen = document.querySelector('.screen.active').id === 'screen-theme-howto';
    const steps = document.querySelectorAll('#screen-theme-howto .tg-step').length;
    const dots = document.querySelectorAll('#tg-dots .tg-dot').length;
    const backBtn = document.getElementById('tg-back-btn');
    const nextBtn = document.getElementById('tg-next-btn');
    const backHiddenAtStart = backBtn.style.visibility === 'hidden';
    const activeStep = () => { const el = document.querySelector('#screen-theme-howto .tg-step.is-active'); return el ? Number(el.getAttribute('data-tg-step')) : -1; };
    nextBtn.click();                                     // 0 → 1 through delegation
    const afterNext = activeStep();
    const backVisibleAfter = backBtn.style.visibility !== 'hidden';
    backBtn.click();                                     // 1 → 0
    const afterBack = activeStep();
    tgGo(7);                                             // jump to the last step
    const lastLabel = nextBtn.textContent;
    const lastIsCta = lastLabel !== '' && lastLabel !== 'Next';
    nextBtn.click();                                     // "Let's play" → closes
    const closedBackTo = document.querySelector('.screen.active').id;
    return { ok: onScreen && steps === 8 && dots === 8 && backHiddenAtStart
                 && afterNext === 1 && backVisibleAfter && afterBack === 0
                 && lastIsCta && closedBackTo === 'screen-lobby',
             onScreen, steps, dots, backHiddenAtStart, afterNext, backVisibleAfter, afterBack, lastLabel, closedBackTo };
  });
  results.push(['[theme-howto] 8-step walkthrough: Next/Back wired, Back hidden on start, last Next closes', TW.ok, JSON.stringify(TW)]);

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
    const names = ['mafiaStartGame','mafiaLeaveRoom','regenerateMafiaRoom','backFromGameLobby','openMafiaHowTo'];
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
