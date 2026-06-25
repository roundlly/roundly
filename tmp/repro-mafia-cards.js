// Diagnostic repro: full Mafia "Cards" game with 6 REAL anonymous users
// (6 isolated browser contexts → 6 distinct Supabase auth uids).
// Drives the live backend directly via window.sb.rpc (the same calls the app
// makes), then checks that roles load for the narrator and every player.
// Run:  node tmp/repro-mafia-cards.js
// NOT a product feature — a throwaway diagnostic. Safe to delete.

const { chromium } = require('@playwright/test');

const URL = 'http://localhost:5173/';
const TABLE = 'mafia_rooms';

function code4() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// Run an async fn in a fresh page (own context = own anon user). Returns its result.
async function withUser(browser, label, fn) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (!/twemoji|MIME|favicon/.test(t)) console.log(`  [${label} console.err] ${t.slice(0,140)}`); } });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Wait for the Supabase client + anon auth.
  await page.waitForFunction(() => !!(window.sb && window.sb.auth), null, { timeout: 15000 });
  const out = await page.evaluate(async () => {
    const r = {};
    try {
      let u = await window.sb.auth.getUser();
      if (!(u && u.data && u.data.user)) {
        const s = await window.sb.auth.signInAnonymously();
        if (s.error) { r.authErr = s.error.message; return r; }
      }
      u = await window.sb.auth.getUser();
      r.uid = u.data.user.id;
      r.isAnon = u.data.user.is_anonymous;
    } catch (e) { r.authErr = String(e); }
    return r;
  });
  return { ctx, page, ...out };
}

async function rpc(page, fn, args) {
  return page.evaluate(async ([fn, args]) => {
    try {
      const r = await window.sb.rpc(fn, args);
      return { data: r.data, errMsg: r.error && r.error.message, errCode: r.error && r.error.code };
    } catch (e) { return { threw: String(e) }; }
  }, [fn, args]);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const users = [];
  try {
    const CODE = code4();
    console.log('Room code:', CODE);

    // 6 users: u0 = host/narrator (seat p1), u1..u5 = players (p2..p6).
    for (let i = 0; i < 6; i++) users.push(await withUser(browser, 'u' + i, null));
    users.forEach((u, i) => console.log(`  u${i} uid=${u.uid} anon=${u.isAnon}${u.authErr ? ' AUTHERR=' + u.authErr : ''}`));

    const host = users[0];

    // 1) Host creates the room (faithful initial state).
    const initialState = await host.page.evaluate((uid) => ({
      phase: 'lobby', hostId: uid, narratorUid: null,
      claimedBy: { p1: uid }, aliveIds: [], deadIds: [], round: 0,
      killTarget: null, saveTarget: null, detectiveTarget: null,
      voteTally: {}, votedBy: {}, beatId: null, readyBy: {},
      winner: null, roleReveal: {}, revision: 0,
    }), host.uid);
    const created = await rpc(host.page, 'huddle_create_room', { p_table: TABLE, p_code: CODE, p_initial_state: initialState });
    console.log('1) create_room:', JSON.stringify(created.errMsg || 'ok'));

    // 2) Players p2..p6 claim seats.
    for (let i = 1; i <= 5; i++) {
      const seat = 'p' + (i + 1);
      const res = await rpc(users[i].page, 'huddle_claim_seat', { p_table: TABLE, p_code: CODE, p_player_id: seat });
      console.log(`2) ${seat} claim (u${i}):`, JSON.stringify(res.errMsg || 'ok'));
    }

    // 3) Host sets narrator = own seat p1.
    const setNar = await rpc(host.page, 'huddle_mafia_set_narrator', { p_code: CODE, p_narrator_seat: 'p1' });
    console.log('3) set_narrator(p1):', JSON.stringify(setNar.errMsg || 'ok'),
      '-> narratorUid=', setNar.data && setNar.data.narratorUid, '(host uid=', host.uid + ')');

    // 4) Host starts the Cards game.
    const started = await rpc(host.page, 'huddle_mafia_start_game', {
      p_code: CODE, p_include_detective: true, p_include_child: false, p_include_mafia_leader: false, p_variant: 'cards',
    });
    console.log('4) start_game:', JSON.stringify(started.errMsg || 'ok'),
      '-> phase=', started.data && started.data.phase, 'variant=', started.data && started.data.variant,
      'claimedBy=', JSON.stringify(started.data && started.data.claimedBy));

    // 5) Narrator fetches all roles.
    const nar = await rpc(host.page, 'huddle_mafia_get_narrator_state', { p_code: CODE });
    console.log('5) get_narrator_state (narrator):', JSON.stringify(nar.errMsg || nar.data));

    // 6) Each player fetches their own role.
    for (let i = 1; i <= 5; i++) {
      const seat = 'p' + (i + 1);
      const role = await rpc(users[i].page, 'huddle_mafia_get_my_role', { p_code: CODE });
      console.log(`6) get_my_role ${seat} (u${i}):`, JSON.stringify(role.errMsg || role.data));
    }

    // 7) Also: what does the HOST/narrator get from get_my_role (should be {role:null})?
    const hostRole = await rpc(host.page, 'huddle_mafia_get_my_role', { p_code: CODE });
    console.log('7) get_my_role (narrator/host):', JSON.stringify(hostRole.errMsg || hostRole.data));

    console.log('\nVERDICT:');
    const rolesObj = nar.data && nar.data.roles;
    const roleCount = rolesObj ? Object.keys(rolesObj).length : 0;
    console.log('  narrator roles count =', roleCount, '(expected 5)');
  } catch (e) {
    console.error('FATAL', e);
  } finally {
    for (const u of users) { try { await u.ctx.close(); } catch (_) {} }
    await browser.close();
  }
})();
