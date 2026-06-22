/**
 * Huddle multiplayer test  —  Phase 2 safety net
 * ----------------------------------------------
 * The smoke test proves the app LOADS. This proves REAL multiplayer works for
 * EVERY game: two independent browser sessions join one room and we verify that
 * realtime sync actually crosses between them (presence + room state).
 *
 * This is the safety net Phase 2 needs — every shared-engine change must keep
 * this green for all four games.
 *
 * ⚠️ It talks to the REAL Supabase backend: per game it creates ONE throwaway
 *    room, then deletes it. Run occasionally, not in a tight loop.
 *    Requires a Supabase session (anonymous sign-ins enabled, or a real login).
 *
 * Run:  npm run mp
 * Exit: 0 = verified, 1 = broken, 2 = skipped (no auth/Supabase).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = __dirname, HOST = '127.0.0.1', PORT = 4188;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.mp3':'audio/mpeg','.svg':'image/svg+xml' };

// Per-game config. `open` is evaluated in-page; `state`/`sid`/`presence` are the
// game's global identifiers (read via direct eval, which resolves the top-level
// lexical bindings). `urlGame` is the ?game= token. `seatMin` is how many
// claimed seats A should see after B joins (0 = don't assert, model differs).
const GAMES = [
  { key:'hotseat',   urlGame:'hotseat',   open:"openLobby('classic')", state:'state',      sid:'hotGetSessionId',   presence:'_hotPresentSessions',   table:'hotseat_rooms',   seatMin:2 },
  { key:'chameleon', urlGame:'chameleon', open:'openChamLobby()',      state:'chamState',  sid:'chamGetSessionId',  presence:'_chamPresentSessions',  table:'chameleon_rooms', seatMin:2 },
  { key:'liar',      urlGame:'liar',      open:'openLiarLobby()',      state:'liarState',  sid:'liarGetSessionId',  presence:'_liarPresentSessions',  table:'liar_rooms',      seatMin:2 },
  { key:'mafia',     urlGame:'mafia',     open:'openMafiaLobby()',     state:'mafiaState', sid:'mafiaGetSessionId', presence:'_mafiaPresentSessions', table:'mafia_rooms',     seatMin:0 },
];

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(d); } });
    });
    server.listen(PORT, HOST, () => resolve(server));
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(page, fn, arg, predicate, timeoutMs = 25000, stepMs = 750) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try { last = await page.evaluate(fn, arg); } catch (e) { last = -99; }
    if (predicate(last)) return { ok: true, value: last };
    await sleep(stepMs);
  }
  return { ok: false, value: last };
}

async function newSession(browser, url) {
  const ctx = await browser.createBrowserContext(); // isolated storage => distinct session
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction('typeof window.goTo === "function"', { timeout: 15000 }).catch(() => {});
  return { ctx, page, errors };
}

async function testGame(browser, base, g, results) {
  // A: create a room
  const A = await newSession(browser, base);
  const a = await A.page.evaluate(async (cfg) => {
    await eval(cfg.open);
    const st = eval(cfg.state);
    return { code: st.code, sid: eval(cfg.sid)(), claims: Object.keys((st && st.claimedBy) || {}).length };
  }, g);
  results.push({ name: `[${g.key}] A creates a room`, ok: !!a.code, detail: `code=${a.code}, seats=${a.claims}` });
  if (!a.code) { await A.ctx.close(); return; }

  // B: join the same room
  await sleep(2000);
  const B = await newSession(browser, base);
  const b = await B.page.evaluate(async (cfg) => {
    history.replaceState({}, '', '/?room=' + encodeURIComponent(cfg.code) + '&game=' + cfg.urlGame);
    await eval(cfg.open);
    const st = eval(cfg.state);
    return { code: st.code, sid: eval(cfg.sid)() };
  }, { ...g, code: a.code });
  results.push({ name: `[${g.key}] B joins the SAME room`, ok: b.code === a.code, detail: `B.code=${b.code} vs ${a.code}` });
  results.push({ name: `[${g.key}] distinct identities`, ok: !!a.sid && !!b.sid && a.sid !== b.sid, detail: `A=${a.sid} B=${b.sid}` });

  // realtime presence: A sees both
  const pres = await until(A.page, (cfg) => { try { return eval(cfg.presence).size; } catch (e) { return -1; } }, g, (n) => n >= 2);
  results.push({ name: `[${g.key}] realtime presence syncs (A sees 2)`, ok: pres.ok, detail: `A presence=${pres.value}` });

  // realtime DB sync (seat claim) — only for games with the claimedBy seat model
  if (g.seatMin > 0) {
    const seat = await until(A.page, (cfg) => { try { return Object.keys((eval(cfg.state).claimedBy) || {}).length; } catch (e) { return -1; } }, g, (n) => n >= g.seatMin);
    results.push({ name: `[${g.key}] realtime DB sync (A sees B's seat)`, ok: seat.ok, detail: `A sees ${seat.value} seats` });
  }

  const allErr = [...A.errors, ...B.errors];
  results.push({ name: `[${g.key}] no fatal JS errors`, ok: allErr.length === 0, detail: allErr.length ? allErr.join(' | ') : 'clean' });

  // cleanup
  try { await A.page.evaluate(async (cfg) => { try { await window.sb.from(cfg.table).delete().eq('code', cfg.code); } catch (e) {} }, { ...g, code: a.code }); } catch (e) {}
  await A.ctx.close(); await B.ctx.close();
}

// Regression guard for the "player left mid-game" notice + graceful end added
// to Hot Seat (parity with Chameleon/Liar). Two players start a game, one
// leaves, and we assert the other is notified and returned to the lobby.
async function testHotSeatLeave(browser, base, results) {
  const A = await newSession(browser, base);
  const a = await A.page.evaluate(async () => { await openLobby('classic'); return { code: state.code }; });
  await sleep(2000);
  const B = await newSession(browser, base);
  await B.page.evaluate(async (c) => { history.replaceState({}, '', '/?room=' + c + '&game=hotseat'); await openLobby('classic'); }, a.code);
  await sleep(3000);
  await A.page.evaluate(() => { try { startGame(); } catch (e) {} });
  await sleep(3000);
  await B.page.evaluate(async () => { try { await window.sb.rpc('huddle_leave_seat', { p_table: 'hotseat_rooms', p_code: state.code }); } catch (e) {} });
  const out = await until(A.page, () => {
    const tEl = document.querySelector('[class*=toast]');
    return { phase: state.phase, seats: Object.keys(state.claimedBy || {}).length, toast: (tEl && tEl.textContent || '').trim() };
  }, null, (v) => v && v.phase === 'lobby', 16000, 1000);
  const v = out.value || {};
  results.push({ name: '[hotseat] mid-game leave returns other player to lobby', ok: v.phase === 'lobby' && v.seats < 2, detail: `phase=${v.phase}, seats=${v.seats}` });
  results.push({ name: '[hotseat] remaining player sees "left" notice', ok: /left the game|back to the lobby/i.test(v.toast || ''), detail: `toast="${v.toast}"` });
  try { await A.page.evaluate(async (c) => { try { await window.sb.from('hotseat_rooms').delete().eq('code', c); } catch (e) {} }, a.code); } catch (e) {}
  await A.ctx.close(); await B.ctx.close();
}

// Chameleon needs 3+ players to start, so we verify the explicit-Leave NOTICE
// in the lobby (the reported bug): two players in a lobby, one leaves, the
// other must be told "{name} left the game" and see the seat free up.
async function testChamLeaveNotice(browser, base, results) {
  const A = await newSession(browser, base);
  const a = await A.page.evaluate(async () => { await openChamLobby(); return { code: chamState.code }; });
  await sleep(2000);
  const B = await newSession(browser, base);
  await B.page.evaluate(async (c) => { history.replaceState({}, '', '/?room=' + c + '&game=chameleon'); await openChamLobby(); }, a.code);
  await sleep(3000);
  await B.page.evaluate(async () => { try { await window.sb.rpc('huddle_leave_seat', { p_table: 'chameleon_rooms', p_code: chamState.code }); } catch (e) {} });
  const out = await until(A.page, () => {
    const tEl = document.querySelector('[class*=toast]');
    return { seats: Object.keys(chamState.claimedBy || {}).length, toast: (tEl && tEl.textContent || '').trim() };
  }, null, (v) => v && /left the game/i.test(v.toast || ''), 16000, 1000);
  const v = out.value || {};
  results.push({ name: '[chameleon] remaining player sees "left" notice on Leave', ok: /left the game/i.test(v.toast || '') && v.seats < 2, detail: `toast="${v.toast}", seats=${v.seats}` });
  try { await A.page.evaluate(async (c) => { try { await window.sb.from('chameleon_rooms').delete().eq('code', c); } catch (e) {} }, a.code); } catch (e) {}
  await A.ctx.close(); await B.ctx.close();
}

async function run() {
  const results = [];
  const server = await startServer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const base = `http://${HOST}:${PORT}/index.html`;
  let skipped = false;

  try {
    // auth gate (once)
    const probe = await newSession(browser, base);
    const auth = await probe.page.evaluate(async () => {
      try { const s = await window.sb.auth.getSession(); if (s.data && s.data.session) return { ok: true }; } catch (e) {}
      try { const a = await window.sb.auth.signInAnonymously(); return { ok: !a.error, err: a.error && a.error.message }; } catch (e) { return { ok: false, err: String(e.message || e) }; }
    });
    await probe.ctx.close();
    if (!auth.ok) { skipped = true; throw new Error(`no Supabase session (anonymous sign-in: ${auth.err || 'unavailable'}). Enable anon sign-ins or provide a real login; until then verify multiplayer manually on two devices.`); }

    for (const g of GAMES) await testGame(browser, base, g, results);
    await testHotSeatLeave(browser, base, results);
    await testChamLeaveNotice(browser, base, results);
  } catch (e) {
    if (skipped) console.log(`\n  SKIPPED: ${e.message}`);
    else results.push({ name: 'harness ran without crashing', ok: false, detail: String(e.message || e) });
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n  Huddle multiplayer test (4 games, 2 sessions each)\n  ' + '-'.repeat(52));
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}\n        ${r.detail}`); }
  console.log('  ' + '-'.repeat(52));
  if (skipped && results.length === 0) { console.log('  result: SKIPPED (no auth)\n'); process.exitCode = 2; return; }
  console.log(`  ${results.length - failed}/${results.length} checks passed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
run().catch((e) => { console.error('Multiplayer test crashed:', e); process.exitCode = 1; });
