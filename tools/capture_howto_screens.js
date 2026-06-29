// Captures the 6 in-game screenshots for the alt how-to video.
//
// Uses Puppeteer at iPhone-X dimensions (375x812 @ 2x DPR) so the saved PNGs
// look crisp in the player's phone-frame mockup. Lab mode is used to seed
// fake state with no real Supabase round-trips. Lab debug bar is hidden
// before each capture so the screenshots feel like production UI.
//
// Run: node tools/capture_howto_screens.js
// Output: assets/howto-screens/*.png

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'assets', 'howto-screens');
fs.mkdirSync(OUT, { recursive: true });

const URL = 'http://localhost:55368/';

async function hideLabBar(page) {
  await page.evaluate(() => {
    const style = document.getElementById('hide-lab-for-shot') || document.createElement('style');
    style.id = 'hide-lab-for-shot';
    style.textContent = `
      .mafia-lab-bar { display: none !important; }
      /* hide preview's webdriver chrome if any */
      [data-testid="webdriver-banner"] { display: none !important; }
    `;
    document.head.appendChild(style);
  });
}

async function ensureSignedIn(page) {
  await page.evaluate(async () => {
    if (!window.myProfile) {
      await window.huddleSignInWithGoogle();
    }
  });
  await page.waitForTimeout?.(300) ?? new Promise(r => setTimeout(r, 300));
}

async function startMafiaLab(page) {
  await page.evaluate(async () => {
    if (typeof closeMafiaHowTo === 'function') closeMafiaHowTo();
    if (typeof mafiaLabStart === 'function') {
      await mafiaLabStart();
    }
  });
  await new Promise(r => setTimeout(r, 600));
}

async function snap(page, file, opts = {}) {
  await hideLabBar(page);
  if (opts.scrollTop) {
    await page.evaluate(() => {
      const main = document.querySelector('.screen.active main') || document.querySelector('.screen.active');
      if (main) main.scrollTo(0, 0);
      window.scrollTo(0, 0);
    });
  }
  await new Promise(r => setTimeout(r, opts.delay || 400));
  const out = path.join(OUT, file);
  await page.screenshot({ path: out, omitBackground: false });
  console.log('  → ' + file);
}

(async () => {
  console.log('Launching Puppeteer (iPhone X dimensions)…');
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

    console.log('Loading app…');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1200)); // let JS init

    // Force dark theme so the screenshots match the rest of the how-to video
    // (which lives on a dark background).
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      try { localStorage.setItem('huddle.theme', 'dark'); } catch(e) {}
    });

    await ensureSignedIn(page);

    // Run all the captures.
    console.log('\nCapturing screens:');

    // 1. LOBBY — seats filled, room code visible
    await startMafiaLab(page);
    // Make sure we're on the lobby (lab does it but doesn't always wait)
    await page.evaluate(() => goTo('mafia-lobby'));
    await snap(page, '01-lobby.png', { scrollTop: true });

    // Lab starts at lobby with no roles dealt. Call the start_game RPC so
    // mafiaLab.roles gets populated — needed for both the role card and the
    // narrator roster captures below.
    await page.evaluate(async () => {
      if (typeof mafiaLabCallRPC === 'function') {
        await mafiaLabCallRPC('huddle_mafia_start_game', {
          p_code: mafiaState.code,
          p_include_detective: true,
          p_include_child: false,
          p_include_mafia_leader: false,
          p_variant: 'cards',
        });
      }
    });
    await new Promise(r => setTimeout(r, 400));

    // 2. ROLE CARD — player sees "You're the Mafia"
    await page.evaluate(() => {
      const mafiaSeat = Object.entries(mafiaLab.roles).find(([s, r]) => r === 'mafia')?.[0]
        || Object.keys(mafiaLab.roles)[0];
      if (typeof mafiaLabSwitch === 'function') mafiaLabSwitch(mafiaSeat);
      mafiaMe.myRole = 'mafia';
      mafiaMe.myTeammates = Object.entries(mafiaLab.roles)
        .filter(([s, r]) => r === 'mafia' || r === 'mafia_leader')
        .map(([s]) => s)
        .filter(s => s !== mafiaSeat);
      mafiaState.phase = 'cards-role';
      mafiaState.variant = 'cards';
      goTo('mafia-cards-role');
      // mafiaCardsRoleRevealed is a closure-scoped let — call the toggle
      // function to flip it through the proper public API instead of mutating it.
      if (typeof mafiaCardsToggleRoleReveal === 'function') mafiaCardsToggleRoleReveal();
      if (typeof mafiaCardsRenderRole === 'function') mafiaCardsRenderRole();
    });
    await snap(page, '02-role-mafia.png', { scrollTop: true, delay: 900 });

    // 3. NARRATOR DASHBOARD — cheat sheet of all roles
    // Two-step to dodge a race: the renderer kicks off an async fetch when
    // narratorRoles is null, which then re-renders and clobbers our prior
    // assignment. So await the fetch explicitly before snapping.
    const dbg = await page.evaluate(async () => {
      const narratorSeat = Object.entries(mafiaState.claimedBy)
        .find(([s, uid]) => uid === mafiaState.narratorUid)?.[0];
      if (typeof mafiaLabSwitch === 'function') mafiaLabSwitch(narratorSeat);
      // Force the phase that the dispatcher uses to route to narrator dashboard.
      mafiaState.phase = 'night-mafia';   // any non-lobby/non-rules phase
      goTo('mafia-cards-game');
      // Force the fetch + direct write (belt-and-braces).
      try { await mafiaFetchNarratorState(true); } catch(e){}
      mafiaMe.narratorRoles = { ...mafiaLab.roles };
      // Run the dispatcher so it actually picks the narrator branch and renders.
      if (typeof mafiaRerender === 'function') mafiaRerender();
      if (typeof mafiaCardsRenderNarrator === 'function') mafiaCardsRenderNarrator();
      const detailsList = document.querySelectorAll('#screen-mafia-cards-game details');
      detailsList.forEach(d => d.removeAttribute('open'));
      if (detailsList[0]) detailsList[0].setAttribute('open', '');
      return {
        sid: mafiaMe.sessionId,
        narratorUid: mafiaState.narratorUid,
        isNarrator: mafiaMe.sessionId === mafiaState.narratorUid,
        phase: mafiaState.phase,
        cardsMode: typeof mafiaCardsMode !== 'undefined' ? mafiaCardsMode : 'undef',
        narratorRolesKeys: Object.keys(mafiaMe.narratorRoles || {}),
        rosterFirstChildHTML: document.getElementById('mafia-cards-narrator-roster')?.firstElementChild?.outerHTML?.slice(0, 200),
        currentScreen: document.querySelector('.screen.active')?.id,
      };
    });
    console.log('  [debug]', JSON.stringify(dbg, null, 2));
    await snap(page, '03-narrator-roster.png', { scrollTop: true, delay: 800 });

    // 4. NARRATOR — one player marked DEAD (morning announcement)
    await page.evaluate(() => {
      // Use one of the Villager seats so the strikethrough makes sense visually.
      const villagerSeat = Object.entries(mafiaLab.roles).find(([s, r]) => r === 'villager')?.[0]
        || Object.keys(mafiaLab.roles).sort()[0];
      if (typeof mafiaCardsDeadPlayers !== 'undefined') {
        mafiaCardsDeadPlayers.clear();
        mafiaCardsDeadPlayers.add(villagerSeat);
      }
      if (typeof mafiaCardsRenderNarrator === 'function') mafiaCardsRenderNarrator();
    });
    await snap(page, '04-narrator-dead.png', { scrollTop: true, delay: 500 });

    // 5. NARRATOR SCRIPT — "What do I say?" panel open
    await page.evaluate(() => {
      const detailsList = document.querySelectorAll('#screen-mafia-cards-game details');
      detailsList.forEach(d => d.removeAttribute('open'));
      // Find the script details by its summary text (rather than nth-of-type
      // which broke last time because Players is also a <details>).
      let scriptPanel = null;
      detailsList.forEach(d => {
        const sum = (d.querySelector('summary')?.textContent || '').toLowerCase();
        if (sum.includes('what do i say') || sum.includes('ne diyeyim') || sum.includes('say?')) scriptPanel = d;
      });
      if (scriptPanel) {
        scriptPanel.setAttribute('open', '');
        // Open the round-loop subsection inside (the always-relevant one).
        const inner = scriptPanel.querySelectorAll('.mafia-cards-script-section, details');
        if (inner[0]) inner[0].setAttribute('open', '');
      }
      const script = document.querySelector('#screen-mafia-cards-game .mafia-cards-script-body');
      if (script) script.scrollIntoView({ block: 'start' });
    });
    await snap(page, '05-narrator-script.png', { delay: 700 });

    // 6. CHEAT-SHEET FOCUS — narrator's roster zoomed, perfect for a closing
    // "the app remembers everything" beat. Just re-renders the roster open.
    await page.evaluate(() => {
      const detailsList = document.querySelectorAll('#screen-mafia-cards-game details');
      detailsList.forEach(d => d.removeAttribute('open'));
      if (detailsList[0]) detailsList[0].setAttribute('open', '');
      if (typeof mafiaCardsRenderNarrator === 'function') mafiaCardsRenderNarrator();
      window.scrollTo(0, 0);
    });
    await snap(page, '06-roster-zoom.png', { scrollTop: true, delay: 600 });

    console.log('\nAll done. Files saved to assets/howto-screens/');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
