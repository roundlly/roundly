/**
 * Identity-convergence check  —  Phase 2 (GetSessionId/Bootstrap merge)
 * --------------------------------------------------------------------
 * Confirms that after the shared-helper merge, all 4 games resolve to a REAL
 * Supabase auth UUID (not the `tab_xxxx` random fallback) when anon sign-ins
 * are enabled. This is the "identity-convergence" proof the Phase 2 handoff
 * asked for before unifying — and the regression guard after.
 *
 * It calls each game's Bootstrap (the FIRST one performs the single anon
 * sign-in; the other three reuse that same auth user via getUser(), so this
 * costs ~1 anon sign-in total), then reads each GetSessionId().
 *
 *   PASS = every sid is a UUID v4-shaped string.
 *   FAIL = any sid is null / a `tab_…` fallback id  → anon auth NOT resolving.
 *
 * ⚠ LIVE Supabase. Anon sign-ins are rate-limited (HTTP 429). If you've run
 *   `npm run mp` heavily in the last ~hour, wait for the quota to refresh or
 *   this will report tab_ fallbacks (a rate-limit symptom, NOT a code bug).
 *
 * Run:  node tools/check-sessionid.js
 * Exit: 0 = all four are real UUIDs, 1 = something fell back / errored.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = 4179;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bootstrap → GetSessionId pairs, in load order. Order matters: the first
// Bootstrap does the anon sign-in; the rest reuse it via getUser().
const GAMES = [
  { key: 'hotseat',   boot: 'hotBootstrap',   sid: 'hotGetSessionId'   },
  { key: 'chameleon', boot: 'chamBootstrap',  sid: 'chamGetSessionId'  },
  { key: 'liar',      boot: 'cardLobbyBootstrap',  sid: 'cardLobbyGetSessionId'  },
  { key: 'mafia',     boot: 'mafiaBootstrap', sid: 'mafiaGetSessionId' },
];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
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
  const server = await startServer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const results = [];

  try {
    const page = await browser.newPage();
    await page.goto(`http://${HOST}:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('typeof window.goTo === "function"', { timeout: 15000 }).catch(() => {});

    // Confirm Supabase actually loaded — otherwise every game would (correctly)
    // fall back to tab_ and the result would be a false negative.
    const hasSb = await page.evaluate('!!(window.sb && window.sb.auth)');
    if (!hasSb) {
      console.error('\n  Supabase client (window.sb) not present — cannot verify auth UUIDs.\n');
      results.push({ key: '(supabase)', sid: null, ok: false });
    } else {
      for (const g of GAMES) {
        const sid = await page.evaluate(async (boot, sidFn) => {
          try {
            if (typeof window[boot] === 'function') await window[boot]();
            return (typeof window[sidFn] === 'function') ? window[sidFn]() : null;
          } catch (e) { return 'ERR:' + (e && e.message ? e.message : String(e)); }
        }, g.boot, g.sid);
        const ok = typeof sid === 'string' && UUID_RE.test(sid);
        results.push({ key: g.key, sid, ok });
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n  Identity-convergence check (GetSessionId/Bootstrap)\n  ' + '-'.repeat(48));
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    const tag = r.ok ? '  PASS' : '  FAIL';
    const shown = r.sid == null ? '(null)' : r.sid;
    console.log(`${tag}  ${r.key.padEnd(10)} ${shown}`);
  }
  console.log('  ' + '-'.repeat(48));
  console.log(`  ${results.length - failed}/${results.length} games resolve to a real auth UUID\n`);
  if (failed) {
    console.log('  NOTE: tab_ ids or nulls usually mean anon sign-in was rate-limited (429).');
    console.log('        Wait ~1h and re-run before treating it as a code bug.\n');
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((e) => { console.error('check-sessionid crashed:', e); process.exitCode = 1; });
