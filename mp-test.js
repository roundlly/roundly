/**
 * Huddle multiplayer test  —  Phase 2 safety net
 * ----------------------------------------------
 * The smoke test proves the app LOADS. This proves REAL multiplayer works:
 * two independent browser sessions join one Hot Seat room and we verify that
 * realtime sync actually crosses between them (presence + seat claims).
 *
 * This is the safety net Phase 2 needs — every shared-engine change must keep
 * this green.
 *
 * ⚠️ It talks to the REAL Supabase backend: it creates ONE throwaway room,
 *    claims 2 seats, then deletes the room. Run occasionally, not in a tight loop.
 *
 * Run:  npm run mp
 * Exit: 0 = multiplayer verified, 1 = broken, 2 = skipped (no Supabase reachable).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = __dirname, HOST = '127.0.0.1', PORT = 4188;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.mp3':'audio/mpeg','.svg':'image/svg+xml' };

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

// Poll an in-page evaluate() until predicate(value) is true or timeout.
async function until(page, fn, predicate, timeoutMs = 25000, stepMs = 750) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try { last = await page.evaluate(fn); } catch (e) { last = { _err: String(e.message || e) }; }
    if (predicate(last)) return { ok: true, value: last };
    await sleep(stepMs);
  }
  return { ok: false, value: last };
}

async function newSession(browser, url) {
  const ctx = await browser.createBrowserContext(); // isolated storage => distinct session id
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction('typeof window.goTo === "function"', { timeout: 15000 }).catch(() => {});
  return { ctx, page, errors };
}

async function run() {
  const results = [];
  const server = await startServer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  let skipped = false, roomCode = null;
  const base = `http://${HOST}:${PORT}/index.html`;

  try {
    // --- Session A: create a room -------------------------------------------
    const A = await newSession(browser, base);
    const hasSb = await A.page.evaluate(() => !!window.sb);
    if (!hasSb) { skipped = true; throw new Error('Supabase client (window.sb) not available — skipping multiplayer test'); }

    // Auth gate: room reads/writes are RLS-protected and need a real session.
    // From headless/localhost we have none (Google login is bypassed here, and
    // anonymous sign-ins may be disabled). Detect that and SKIP with a clear
    // reason rather than emit confusing RLS failures.
    const auth = await A.page.evaluate(async () => {
      const r = {};
      try { const s = await window.sb.auth.getSession(); r.session = !!(s.data && s.data.session); } catch (e) { r.session = false; }
      if (!r.session) { try { const a = await window.sb.auth.signInAnonymously(); r.anonErr = a.error ? (a.error.message || 'error') : null; r.session = !a.error; } catch (e) { r.anonErr = String(e.message || e); } }
      return r;
    });
    if (!auth.session) {
      skipped = true;
      throw new Error(`no authenticated Supabase session available (anonymous sign-in: ${auth.anonErr || 'unavailable'}). ` +
        `Room reads/writes are RLS-protected, so multiplayer cannot be exercised from headless/localhost. ` +
        `To enable this test: provide a real test login, or enable anonymous sign-ins in Supabase. ` +
        `Until then, verify multiplayer manually on two real devices.`);
    }

    const a = await A.page.evaluate(async () => {
      await openLobby('classic');
      return { code: state.code, sid: hotGetSessionId(), claims: Object.keys(state.claimedBy || {}).length };
    });
    roomCode = a.code;
    results.push({ name: 'Session A creates a Hot Seat room', ok: !!a.code && a.claims >= 1, detail: `code=${a.code}, seats claimed=${a.claims}` });

    // --- Session B: join the same room --------------------------------------
    // Boot B on the BASE url (no room param) to avoid racing the app's own
    // boot-time room routing, then set the join URL and call openLobby once.
    // Wait first so the freshly-created room has replicated to B's client.
    await sleep(2500);
    const B = await newSession(browser, base);
    const b = await B.page.evaluate(async (code) => {
      history.replaceState({}, '', '/?room=' + encodeURIComponent(code) + '&game=hotseat');
      const directLoad = await hotLoadRoom(code);   // diagnostic: can B read A's row at all?
      await openLobby('classic');
      return { code: state.code, sid: hotGetSessionId(), directLoad, search: location.search };
    }, roomCode);
    console.log(`  (B diagnostics: directLoad=${b.directLoad}, search="${b.search}")`);
    results.push({ name: 'Session B joins the SAME room (not a fresh one)', ok: b.code === roomCode, detail: `B.code=${b.code} vs room=${roomCode}` });
    results.push({ name: 'Two sessions have distinct identities', ok: !!a.sid && !!b.sid && a.sid !== b.sid, detail: `A=${a.sid}  B=${b.sid}` });

    // --- Realtime presence: A should see BOTH sessions present --------------
    const presence = await until(A.page,
      () => (typeof _hotPresentSessions !== 'undefined' ? _hotPresentSessions.size : -1),
      (n) => n >= 2);
    results.push({ name: 'Realtime presence syncs (A sees 2 live sessions)', ok: presence.ok, detail: `A presence count=${presence.value}` });

    // --- Realtime seat sync: A should see B's seat claim via realtime -------
    const seatSync = await until(A.page,
      () => Object.keys((typeof state !== 'undefined' && state.claimedBy) || {}).length,
      (n) => n >= 2);
    results.push({ name: "Realtime DB sync (A sees B's seat claim)", ok: seatSync.ok, detail: `A sees ${seatSync.value} claimed seats` });

    // --- No fatal errors in either session ----------------------------------
    const allErr = [...A.errors, ...B.errors];
    results.push({ name: 'No fatal JS errors in either session', ok: allErr.length === 0, detail: allErr.length ? allErr.join(' | ') : 'clean' });

    // --- Cleanup: delete the throwaway room --------------------------------
    try {
      const del = await A.page.evaluate(async (code) => {
        try { const { error } = await window.sb.from('hotseat_rooms').delete().eq('code', code); return error ? ('delete error: ' + error.message) : 'deleted'; }
        catch (e) { return 'delete threw: ' + (e.message || e); }
      }, roomCode);
      console.log(`  (cleanup: ${del})`);
    } catch (e) {}
  } catch (e) {
    if (skipped) console.log(`\n  SKIPPED: ${e.message}`);
    else results.push({ name: 'Test harness ran without crashing', ok: false, detail: String(e.message || e) });
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n  Huddle multiplayer test (Hot Seat, 2 sessions)\n  ' + '-'.repeat(48));
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}\n        ${r.detail}`); }
  console.log('  ' + '-'.repeat(48));
  if (skipped && results.length === 0) { console.log('  result: SKIPPED (no Supabase)\n'); process.exitCode = 2; return; }
  console.log(`  ${results.length - failed}/${results.length} checks passed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((e) => { console.error('Multiplayer test crashed:', e); process.exitCode = 1; });
