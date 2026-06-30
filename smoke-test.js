/**
 * Huddle smoke test  —  Phase 0 safety net
 * ----------------------------------------
 * A fast, network-light check that catches the MOST COMMON breakage from
 * refactoring the single-file app:
 *
 *   1. The page loads with no fatal (uncaught) JavaScript error.
 *   2. Every critical global function the UI buttons depend on still exists.
 *      (269 inline onclick="..." handlers call these by name — if a refactor
 *       renames or removes one, the button silently dies. This catches that.)
 *   3. The screen dispatcher (goTo) can switch to key screens and they render.
 *
 * It does NOT test live multiplayer / Supabase rooms — that's a deeper e2e for
 * later. This is the cheap alarm bell: run it after any change to confirm you
 * didn't break the basics.
 *
 * Run:  npm run smoke
 * Exit: 0 = all checks passed, 1 = something broke.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = __dirname;
const HOST = '127.0.0.1'; // localhost host => app's dev login bypass kicks in
const PORT = 4178;

// --- Critical globals the UI relies on, spanning every region of app.js -----
// (Verified present in the working build. If a future split drops or
//  mis-orders a file, the missing region's functions show up here.)
const REQUIRED_GLOBALS = [
  // core / i18n / dispatcher
  't', 'setLang', 'applyLang', 'loadProfile', 'saveProfile', 'loadStats',
  'goTo', 'goToSlide', 'nextSlide',
  // hot seat
  'startGame', 'openLobby', 'renderLobbyPlayers', 'hotWireSync', 'hotClaimSeat',
  // chameleon
  'openChamLobby', 'chamStartGame', 'chamWireSync', 'renderChamLobbyPlayers',
  // liar
  'openLiarLobby', 'liarStartGame', 'cardLobbyWireSync',
  // mafia
  'openMafiaLobby', 'openMafiaCardsLobby', 'mafiaStartGame', 'mafiaWireSync',
  // friends / invites / feedback
  'renderFriends', 'friendsLoad', 'renderLobbyInvites', 'renderFeedbackBoard', 'feedbackLoad',
  // admin
  'renderAdminStats', 'renderAdminFeedback', 'adminStatsLoad', 'adminFeedbackLoad',
  // profile / settings
  'renderProfileScreen', 'renderEditProfile', 'renderSettings',
  // late region (end of app.js) — confirms the whole file executed
  'wheelTestRun', 'wheelTestReset', 'wheelTestPaintWheel',
];

// --- Screens that render via goTo() without live-server side effects --------
// Includes all four game lobbies (these only paint local seat state; real
// room creation happens in the open*Lobby openers, which we do NOT trigger).
const NAV_SCREENS = ['games', 'profile', 'login', 'lobby', 'cham-lobby', 'liar-lobby', 'mafia-lobby'];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, HOST, () => resolve(server));
  });
}

async function run() {
  const results = []; // { name, ok, detail }
  const pageErrors = [];
  const server = await startServer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));

    await page.goto(`http://${HOST}:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });

    // Wait for the main script to have defined the dispatcher.
    await page.waitForFunction('typeof window.goTo === "function"', { timeout: 15000 })
      .catch(() => {});

    // Check 1 — no fatal uncaught errors during load.
    results.push({
      name: 'Page loads with no fatal JS error',
      ok: pageErrors.length === 0,
      detail: pageErrors.length ? pageErrors.join(' | ') : 'clean load',
    });

    // Check 2 — every critical global function exists.
    const globalsState = await page.evaluate((names) => {
      return names.map((n) => ({ n, ok: typeof window[n] === 'function' }));
    }, REQUIRED_GLOBALS);
    const missing = globalsState.filter((g) => !g.ok).map((g) => g.n);
    results.push({
      name: `Critical button functions exist (${REQUIRED_GLOBALS.length} checked)`,
      ok: missing.length === 0,
      detail: missing.length ? `MISSING: ${missing.join(', ')}` : 'all present',
    });

    // Check 3 — goTo() navigates to key screens and they become active.
    for (const screen of NAV_SCREENS) {
      const ok = await page.evaluate((s) => {
        try { window.goTo(s); } catch (e) { return false; }
        const el = document.getElementById('screen-' + s);
        return !!(el && el.classList.contains('active'));
      }, screen).catch(() => false);
      results.push({ name: `goTo('${screen}') renders #screen-${screen}`, ok, detail: ok ? 'active' : 'did not activate' });
    }
  } finally {
    await browser.close();
    server.close();
  }

  // --- Report ---------------------------------------------------------------
  console.log('\n  Huddle smoke test\n  ' + '-'.repeat(40));
  let failed = 0;
  for (const r of results) {
    const tag = r.ok ? '  PASS' : '  FAIL';
    if (!r.ok) failed++;
    console.log(`${tag}  ${r.name}\n        ${r.detail}`);
  }
  console.log('  ' + '-'.repeat(40));
  console.log(`  ${results.length - failed}/${results.length} checks passed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((e) => { console.error('Smoke test crashed:', e); process.exitCode = 1; });
