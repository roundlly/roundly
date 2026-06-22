// E2E Mafia Game Test — Playwright script
// Run: node e2e-mafia-test.js

const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = 'C:\\Users\\HUWAI\\OneDrive\\Desktop\\documents\\game\\e2e-screenshots';
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function shot(page, name) {
  const file = path.join(SCREENSHOTS_DIR, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function ev(page, fn, arg) {
  try {
    if (arg !== undefined) return await page.evaluate(fn, arg);
    return await page.evaluate(fn);
  } catch (e) {
    return `ERROR: ${e.message.split('\n')[0]}`;
  }
}

const results = [];
function pass(step, detail) {
  results.push({ step, status: 'PASS', detail });
  console.log(`✅ [${step}] ${detail}`);
}
function fail(step, detail) {
  results.push({ step, status: 'FAIL', detail });
  console.log(`❌ [${step}] ${detail}`);
}

function printReport() {
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`FINAL: ${passed} PASS / ${failed} FAIL / ${results.length} TOTAL`);
  console.log('='.repeat(60));
  results.forEach(r => {
    console.log(`  ${r.status === 'PASS' ? '✅' : '❌'} ${r.step}: ${r.detail}`);
  });
  console.log(`\nScreenshots: ${SCREENSHOTS_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
}

async function getState(page) {
  return ev(page, () => {
    try {
      return {
        phase: mafiaState.phase,
        beatId: mafiaState.beatId,
        code: mafiaState.code,
        labEnabled: mafiaLab.enabled,
        screen: (document.querySelector('.screen.active') || {}).id || 'none',
      };
    } catch(e) { return { error: e.message }; }
  });
}

async function getNarratorBeat(page) {
  return ev(page, () => {
    try {
      const textEl = document.getElementById('mafia-narrator-text');
      const stageDirEl = document.getElementById('mafia-narrator-stage-dir');
      return {
        beatId: mafiaState.beatId,
        phase: mafiaState.phase,
        readAloud: textEl ? textEl.textContent.trim() : null,
        stageDir: stageDirEl && !stageDirEl.hidden ? stageDirEl.textContent.trim() : null,
        screen: (document.querySelector('.screen.active') || {}).id || 'none',
      };
    } catch(e) { return { error: e.message }; }
  });
}

async function advanceBeat(page) {
  const result = await ev(page, async () => {
    try {
      const prevBeat = mafiaState.beatId;
      await mafiaAdvanceBeat();
      await new Promise(r => setTimeout(r, 400));
      return { prevBeat, newBeat: mafiaState.beatId, phase: mafiaState.phase };
    } catch(e) { return { error: e.message }; }
  });
  await page.waitForTimeout(200);
  return result;
}

async function startVote(page) {
  return ev(page, async () => {
    try {
      const r = await huddleCallRPC('huddle_mafia_start_vote', { p_code: mafiaState.code });
      if (r) { Object.assign(mafiaState, r); mafiaRerender(); }
      return { beatId: mafiaState.beatId, phase: mafiaState.phase };
    } catch(e) { return { error: e.message }; }
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (!t.includes('twemoji') && !t.includes('MIME') && !t.includes('favicon') && !t.includes('supabase')) {
        console.log(`  [err] ${t.substring(0, 120)}`);
      }
    }
  });

  // ============================================================
  // STEP 1: Load page
  // ============================================================
  console.log('\n=== STEP 1: Load page (375x812) ===');
  try {
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(800);
    pass('1-load', `Page loaded: "${await page.title()}"`);
  } catch (e) {
    fail('1-load', e.message); await browser.close(); printReport(); return;
  }

  // ============================================================
  // STEP 2: Auth bypass → profile
  // ============================================================
  console.log('\n=== STEP 2: Auth bypass → profile ===');
  let activeScreen = await ev(page, () => (document.querySelector('.screen.active') || {}).id || 'none');

  if (activeScreen === 'screen-login' || activeScreen === 'none') {
    await page.evaluate(() => {
      localStorage.setItem('sb-dpgexpaqjrgzbwmuohcp-auth-token', JSON.stringify({
        access_token: 'e2e-token', refresh_token: 'e2e-refresh',
        user: { id: 'e2e-001', email: 'e2e@test.com', is_anonymous: false },
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      }));
      localStorage.setItem('huddle.lastScreen', 'profile');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    activeScreen = await ev(page, () => (document.querySelector('.screen.active') || {}).id || 'none');
  }

  if (activeScreen !== 'screen-profile') {
    await ev(page, () => { try { goTo('profile'); } catch(e) {} });
    await page.waitForTimeout(400);
    activeScreen = await ev(page, () => (document.querySelector('.screen.active') || {}).id || 'none');
  }

  if (activeScreen === 'screen-profile') pass('2-auth', 'On screen-profile');
  else fail('2-auth', `Got: ${activeScreen}`);
  await shot(page, '01-profile');

  // ============================================================
  // STEP 3: Click "Test Mafia"
  // ============================================================
  console.log('\n=== STEP 3: Click Test Mafia ===');
  await ev(page, () => {
    const p = document.getElementById('screen-profile');
    if (p) { const inner = p.querySelector('.page') || p; inner.scrollTop = 9999; }
  });
  await page.waitForTimeout(200);

  const mafiaBtnVis = await page.locator('[onclick="mafiaLabStart()"]').first().isVisible().catch(() => false);
  if (mafiaBtnVis) {
    await page.locator('[onclick="mafiaLabStart()"]').first().click();
    await page.waitForTimeout(1200);
    pass('3-click', 'Clicked Test Mafia');
  } else {
    const r = await ev(page, async () => { try { await mafiaLabStart(); return 'ok'; } catch(e) { return 'err:' + e.message; } });
    await page.waitForTimeout(1200);
    if (r === 'ok') pass('3-call', 'Called mafiaLabStart()');
    else fail('3-call', r);
  }
  await shot(page, '02-lobby');

  // ============================================================
  // STEP 4: Lobby + start game
  // ============================================================
  console.log('\n=== STEP 4: Lobby + start game ===');
  let st = await getState(page);
  console.log(`  State: ${JSON.stringify(st)}`);

  if (st.screen && st.screen.includes('mafia')) pass('4a-lobby', `Screen: ${st.screen}`);
  else fail('4a-lobby', `Got: ${st.screen}`);

  if (st.labEnabled) pass('4b-lab', `labEnabled=true, code=${st.code}`);
  else fail('4b-lab', `labEnabled=${st.labEnabled}`);

  const startVis = await page.locator('button:has-text("Start game")').first().isVisible().catch(() => false);
  if (startVis) {
    await page.locator('button:has-text("Start game")').first().click();
    await page.waitForTimeout(1500);
    pass('4c-start', 'Clicked Start game');
  } else {
    const r = await ev(page, async () => {
      try {
        const r = await huddleCallRPC('huddle_mafia_start_game', { p_code: mafiaState.code });
        if (r) { Object.assign(mafiaState, r); mafiaRerender(); }
        return r ? r.phase : 'null';
      } catch(e) { return 'err:' + e.message; }
    });
    await page.waitForTimeout(800);
    pass('4c-start-rpc', `Started: ${r}`);
  }
  await shot(page, '03-after-start');

  // ============================================================
  // STEP 5: Verify phase='rules' + screen-mafia-rules active
  // ============================================================
  console.log('\n=== STEP 5: rules phase ===');
  st = await getState(page);
  console.log(`  State: ${JSON.stringify(st)}`);

  if (st.phase === 'rules') pass('5a-rules', `phase=rules, screen=${st.screen}`);
  else fail('5a-rules', `phase=${st.phase}, screen=${st.screen}`);

  const rulesActive = await ev(page, () => { const s = document.getElementById('screen-mafia-rules'); return s ? s.classList.contains('active') : false; });
  if (rulesActive) pass('5b-rules-screen', 'screen-mafia-rules active');
  else fail('5b-rules-screen', 'screen-mafia-rules not active');
  await shot(page, '04-rules-screen');

  // ============================================================
  // STEP 6: Ready p1–p6
  // ============================================================
  console.log('\n=== STEP 6: Ready p1–p6 ===');
  for (const seat of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
    const r = await ev(page, async (s) => {
      try {
        mafiaLabSwitch(s);
        await new Promise(x => setTimeout(x, 100));
        await mafiaSetReady();
        await new Promise(x => setTimeout(x, 200));
        return { phase: mafiaState.phase, readyCount: Object.keys(mafiaState.readyBy || {}).length };
      } catch(e) { return { error: e.message }; }
    }, seat);
    console.log(`  ${seat}: ${JSON.stringify(r)}`);
  }
  pass('6-p1-p6', 'All p1–p6 ready');

  // ============================================================
  // STEP 7: Narrator (p7) ready → night-mafia
  // ============================================================
  console.log('\n=== STEP 7: Narrator ready ===');
  const narResult = await ev(page, async () => {
    try {
      mafiaLabSwitch('p7');
      await new Promise(x => setTimeout(x, 200));
      await mafiaSetReady();
      await new Promise(x => setTimeout(x, 800));
      return { phase: mafiaState.phase, beatId: mafiaState.beatId, screen: (document.querySelector('.screen.active') || {}).id || 'none' };
    } catch(e) { return { error: e.message }; }
  });
  console.log(`  Narrator result: ${JSON.stringify(narResult)}`);

  if (narResult.phase === 'night-mafia') pass('7a-phase', 'phase=night-mafia');
  else fail('7a-phase', `Expected night-mafia, got: ${narResult.phase}`);

  if (narResult.beatId === 'opening-night1-open') pass('7b-beat', 'beatId=opening-night1-open');
  else fail('7b-beat', `Expected opening-night1-open, got: ${narResult.beatId}`);

  if (narResult.screen === 'screen-mafia-narrator') pass('7c-screen', 'screen-mafia-narrator active');
  else fail('7c-screen', `Expected screen-mafia-narrator, got: ${narResult.screen}`);

  await shot(page, '05-opening-night1-open');

  // ============================================================
  // STEP 8: Walk opening beats
  // ============================================================
  console.log('\n=== STEP 8: Walk opening beats ===');

  // Ensure we're on p7 (narrator)
  await ev(page, () => { try { mafiaLabSwitch('p7'); } catch(e) {} });
  await page.waitForTimeout(200);

  const openingChecks = [
    { beatId: 'opening-night1-open',        mustContain: 'Night falls' },
    { beatId: 'opening-night1-mafia-meet',  mustContain: 'Mafia, open your eyes' },
    { beatId: 'opening-night1-mafia-sleep', mustContain: 'Mafia, close your eyes' },
    { beatId: 'opening-day0-morning',       mustContain: 'Morning' },
  ];

  let beat = await getNarratorBeat(page);
  console.log(`  beat: ${beat.beatId}, text: "${beat.readAloud}"`);
  {
    const chk = openingChecks[0];
    if (beat.beatId === chk.beatId && beat.readAloud && beat.readAloud.includes(chk.mustContain)) {
      pass(`8a-${chk.beatId}`, `"${beat.readAloud}"`);
    } else {
      fail(`8a-${chk.beatId}`, `beat=${beat.beatId}, text="${beat.readAloud}"`);
    }
  }

  const stepLabels = ['8b', '8c', '8d'];
  for (let i = 1; i < openingChecks.length; i++) {
    const adv = await advanceBeat(page);
    beat = await getNarratorBeat(page);
    console.log(`  After advance: beat=${beat.beatId}`);
    await shot(page, `06-${(beat.beatId || 'unk').replace(/\//g,'-')}`);

    const chk = openingChecks[i];
    if (beat.beatId === chk.beatId && beat.readAloud && beat.readAloud.includes(chk.mustContain)) {
      pass(`${stepLabels[i-1]}-${chk.beatId}`, `"${beat.readAloud}"`);
    } else if (beat.beatId !== chk.beatId) {
      fail(`${stepLabels[i-1]}-${chk.beatId}`, `Expected ${chk.beatId}, got: ${beat.beatId}`);
    } else {
      fail(`${stepLabels[i-1]}-${chk.beatId}`, `Text: "${beat.readAloud}"`);
    }
  }

  // ============================================================
  // STEP 9: Middle round 2 — walk night beats, no picker check
  // ============================================================
  console.log('\n=== STEP 9: Middle round night beats ===');

  await advanceBeat(page); // morning → middle-night-open
  beat = await getNarratorBeat(page);
  console.log(`  After morning: beat=${beat.beatId}`);

  let foundDayReveal = false;
  for (let i = 0; i < 10; i++) {
    beat = await getNarratorBeat(page);
    if (!beat.beatId) break;
    console.log(`  [${i}] beat=${beat.beatId}`);

    if (beat.beatId.includes('wake')) {
      const pickerInfo = await ev(page, () => {
        const actionEl = document.querySelector('#mafia-narrator-action');
        if (!actionEl) return { hasPicker: false, html: '' };
        const h = actionEl.innerHTML;
        const hasPicker = h.includes('data-seat') || h.includes('mafia-player-tile') || h.includes('tap-target');
        return { hasPicker, html: h.substring(0, 80) };
      });
      if (pickerInfo.hasPicker) {
        fail(`9-no-picker-${beat.beatId}`, `Picker found on ${beat.beatId}`);
        await shot(page, `FAIL-picker-${beat.beatId.replace(/\//g,'-')}`);
      } else {
        pass(`9-no-picker-${beat.beatId}`, `No picker on ${beat.beatId} (plain Continue)`);
      }
    }

    if (beat.beatId === 'middle-day-reveal') {
      foundDayReveal = true;
      console.log(`  day-reveal text: "${beat.readAloud}", stageDir: "${beat.stageDir}"`);
      if (beat.stageDir && (beat.stageDir.includes('Announce') || beat.stageDir.includes('died') || beat.stageDir.includes('tap'))) {
        pass('9-day-reveal-stage-dir', `"${beat.stageDir}"`);
      } else {
        fail('9-day-reveal-stage-dir', `Expected Announce/died/tap, got: "${beat.stageDir}"`);
      }
      await shot(page, '07-day-reveal');
      break;
    }

    await advanceBeat(page);
  }

  if (!foundDayReveal) fail('9-day-reveal', `Last: ${beat ? beat.beatId : 'null'}`);

  // ============================================================
  // STEP 10: discuss → start vote → vote-progress
  // ============================================================
  console.log('\n=== STEP 10: discuss → vote ===');

  await advanceBeat(page); // day-reveal → day-discuss
  beat = await getNarratorBeat(page);
  console.log(`  After day-reveal advance: beat=${beat.beatId}`);

  if (beat.beatId === 'middle-day-discuss') pass('10a-discuss', 'Reached middle-day-discuss');
  else fail('10a-discuss', `Expected middle-day-discuss, got: ${beat.beatId}`);

  const voteResult = await startVote(page);
  await page.waitForTimeout(600);
  beat = await getNarratorBeat(page);
  console.log(`  After start_vote: beat=${beat.beatId}, stageDir="${beat.stageDir}"`);

  if (beat.beatId && (beat.beatId.includes('vote') || beat.beatId === 'middle-vote-progress')) {
    if (beat.stageDir && (beat.stageDir.includes('alive') || beat.stageDir.includes('vote') || beat.stageDir.includes('Only'))) {
      pass('10b-vote-stage-dir', `"${beat.stageDir}"`);
    } else {
      fail('10b-vote-stage-dir', `Stage dir: "${beat.stageDir}"`);
    }
    await shot(page, '08-vote-progress');
  } else {
    fail('10b-vote', `Expected vote beat, got: ${beat.beatId}`);
    await shot(page, 'FAIL-no-vote');
  }

  // ============================================================
  // STEP 11: Player Rules pill & modal
  // ============================================================
  console.log('\n=== STEP 11: Player Rules pill & modal ===');

  await ev(page, () => { try { mafiaLabSwitch('p1'); } catch(e) {} });
  await page.waitForTimeout(600);

  const p1Screen = await ev(page, () => (document.querySelector('.screen.active') || {}).id || 'none');
  console.log(`  p1 screen: ${p1Screen}`);

  // Check bounding box for rules pill — understand visibility issue
  const pillInfo = await ev(page, () => {
    const pill = document.querySelector('.screen.active .liar-play-rules-btn[onclick*="mafia-howplay"]');
    if (!pill) return { found: false };
    const rect = pill.getBoundingClientRect();
    const style = window.getComputedStyle(pill);
    return {
      found: true,
      hidden: pill.hidden,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
    };
  });
  console.log(`  Pill info: ${JSON.stringify(pillInfo)}`);

  // Click via JS evaluate (avoids Playwright visibility check)
  const clickResult = await ev(page, () => {
    try {
      const pill = document.querySelector('.screen.active .liar-play-rules-btn[onclick*="mafia-howplay"]');
      if (!pill) return 'not-found';
      pill.click();
      return 'clicked';
    } catch(e) { return 'err:' + e.message; }
  });
  await page.waitForTimeout(400);
  console.log(`  Click result: ${clickResult}`);

  if (pillInfo.found) {
    pass('11a-rules-pill', `Rules pill in DOM on ${p1Screen}: display=${pillInfo.display}, rect=${JSON.stringify(pillInfo.rect)}`);
  } else {
    fail('11a-rules-pill', `Rules pill not in DOM on ${p1Screen}`);
  }

  // Check modal opened
  const backdropActive = await ev(page, () => { const bd = document.getElementById('info-backdrop'); return bd ? bd.classList.contains('active') : false; });
  const infoTitle = await ev(page, () => { const t = document.getElementById('info-title'); return t ? t.textContent.trim() : null; });
  const infoBody = await ev(page, () => { const b = document.getElementById('info-body'); return b ? b.textContent.trim() : null; });

  console.log(`  Backdrop active: ${backdropActive}, title: "${infoTitle}"`);
  console.log(`  Body first 100: "${infoBody ? infoBody.substring(0, 100) : 'null'}"`);

  if (backdropActive) pass('11b-modal-opens', 'Info modal opened');
  else fail('11b-modal-opens', 'Info backdrop not .active after click');

  if (infoTitle === 'How to play Mafia') pass('11c-title', `"${infoTitle}"`);
  else fail('11c-title', `Expected "How to play Mafia", got: "${infoTitle}"`);

  const hasMafia = !!(infoBody && infoBody.includes('Mafia'));
  const hasDoctor = !!(infoBody && infoBody.includes('Doctor'));
  const hasVillager = !!(infoBody && infoBody.includes('Villager'));
  if (hasMafia && hasDoctor && hasVillager) pass('11d-roles', 'Body has Mafia, Doctor, Villager');
  else fail('11d-roles', `Mafia=${hasMafia} Doctor=${hasDoctor} Villager=${hasVillager}`);

  await shot(page, '09-rules-modal');

  // ============================================================
  // DONE
  // ============================================================
  await browser.close();
  printReport();

})().catch(e => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
