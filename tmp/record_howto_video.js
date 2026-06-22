// Records a REAL screen-capture video of the Mafia how-to walkthrough.
//
// Pipeline:
//   1. Puppeteer launches a headless Chromium at iPhone-X dimensions
//   2. App is loaded, lab state is seeded, dark theme forced, lab bar hidden
//   3. A "fake cursor" + tap-ripple are injected so the viewer can see WHERE
//      we're tapping (otherwise the auto-navigation looks ghostly)
//   4. Page screencast begins (WebM, 30 fps)
//   5. An action timeline runs — each entry { at: seconds, do: fn } fires at
//      the matching moment in George's voiceover, so the visuals stay synced
//      to the audio without any frame-level alignment math
//   6. Recording stops at 58.7s (audio length)
//   7. ffmpeg muxes the WebM video + the existing mafia-en.mp3 → final MP4
//
// Output: assets/howto/mafia-en-walkthrough.mp4
//
// Run: node tmp/record_howto_video.js

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');
const { execFileSync, spawnSync } = require('child_process');

const URL = 'http://localhost:55368/';
const AUDIO_PATH = path.join(__dirname, '..', 'assets', 'howto', 'mafia-en.mp3');
const OUT_DIR = path.join(__dirname, '..', 'assets', 'howto');
fs.mkdirSync(OUT_DIR, { recursive: true });
const WEBM_PATH = path.join(OUT_DIR, '_mafia-en-walkthrough.webm');
const MP4_PATH  = path.join(OUT_DIR, 'mafia-en-walkthrough.mp4');

// Action timeline. Each entry fires at `at` seconds into the recording. The
// `do` function runs in the BROWSER via page.evaluate. Times are matched to
// George's per-scene cues from assets/howto/mafia-en.alignment.json:
//   Scene 1 starts 0.00s   Scene 4 starts 37.04s
//   Scene 2 starts 8.86s   Scene 5 starts 43.34s
//   Scene 3 starts 20.48s  Scene 6 starts 50.77s
// We INSET each action ~0.5s after the scene cue so the visual change lands
// AFTER George finishes the previous sentence, not on top of it.
const TIMELINE = [
  { at: 0.0,  label: 'Scene 1 — show lobby (already loaded)' },

  // ---- Scene 2: roles dealt → show role card hidden → tap reveal → show Mafia
  { at: 9.5,  label: 'Scene 2 — navigate to role card (hidden state)',
    do: () => {
      // mafiaLab.roles already populated by start_game in setup. Switch to a
      // Mafia seat so the reveal shows the most "dramatic" role for the demo.
      const mafiaSeat = Object.entries(mafiaLab.roles).find(([s, r]) => r === 'mafia')?.[0]
        || Object.keys(mafiaLab.roles)[0];
      if (typeof mafiaLabSwitch === 'function') mafiaLabSwitch(mafiaSeat);
      mafiaMe.myRole = 'mafia';
      mafiaState.phase = 'cards-role';
      goTo('mafia-cards-role');
      if (typeof mafiaCardsRenderRole === 'function') mafiaCardsRenderRole();
      window.__hideLabBar?.();
    }
  },
  { at: 15.0, label: 'Scene 2 — fake-tap "Reveal Role" + reveal',
    do: () => {
      const btn = document.querySelector('#mafia-cards-role-reveal-btn, [onclick*="ToggleRoleReveal"], #screen-mafia-cards-role button');
      window.__tapAt?.(btn);
      setTimeout(() => {
        if (typeof mafiaCardsToggleRoleReveal === 'function') mafiaCardsToggleRoleReveal();
      }, 350);
    }
  },

  // ---- Scene 3: night → narrator dashboard with cheat sheet
  { at: 21.0, label: 'Scene 3 — switch to narrator + show roster',
    do: async () => {
      const narratorSeat = Object.entries(mafiaState.claimedBy)
        .find(([s, uid]) => uid === mafiaState.narratorUid)?.[0];
      if (typeof mafiaLabSwitch === 'function') mafiaLabSwitch(narratorSeat);
      mafiaState.phase = 'night-mafia';
      goTo('mafia-cards-game');
      try { await mafiaFetchNarratorState(true); } catch(e){}
      mafiaMe.narratorRoles = { ...mafiaLab.roles };
      if (typeof mafiaRerender === 'function') mafiaRerender();
      if (typeof mafiaCardsRenderNarrator === 'function') mafiaCardsRenderNarrator();
      // Open Players accordion so the cheat sheet is visible.
      const detailsList = document.querySelectorAll('#screen-mafia-cards-game details');
      detailsList.forEach(d => d.removeAttribute('open'));
      if (detailsList[0]) detailsList[0].setAttribute('open', '');
      window.__hideLabBar?.();
    }
  },
  { at: 28.0, label: 'Scene 3 — scroll down to script accordion',
    do: () => {
      const main = document.querySelector('#screen-mafia-cards-game main, #screen-mafia-cards-game') || document.documentElement;
      main.scrollTo({ top: 280, behavior: 'smooth' });
    }
  },
  { at: 32.0, label: 'Scene 3 — open "What do I say?" panel',
    do: () => {
      const detailsList = document.querySelectorAll('#screen-mafia-cards-game details');
      let scriptPanel = null;
      detailsList.forEach(d => {
        const sum = (d.querySelector('summary')?.textContent || '').toLowerCase();
        if (sum.includes('what do i say') || sum.includes('say?')) scriptPanel = d;
      });
      if (scriptPanel) {
        scriptPanel.setAttribute('open', '');
        window.__tapAt?.(scriptPanel.querySelector('summary'));
        const sect = scriptPanel.querySelector('.mafia-cards-script-section, details');
        if (sect) sect.setAttribute('open', '');
        sect?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  },

  // ---- Scene 4: morning — scroll up, tap a player to mark dead
  { at: 37.5, label: 'Scene 4 — scroll back to roster',
    do: () => {
      const main = document.querySelector('#screen-mafia-cards-game main, #screen-mafia-cards-game') || document.documentElement;
      main.scrollTo({ top: 0, behavior: 'smooth' });
      // Close script, re-open Players.
      const detailsList = document.querySelectorAll('#screen-mafia-cards-game details');
      detailsList.forEach(d => d.removeAttribute('open'));
      if (detailsList[0]) detailsList[0].setAttribute('open', '');
    }
  },
  { at: 40.0, label: 'Scene 4 — tap Player 6 (mark dead)',
    do: () => {
      const rows = document.querySelectorAll('#screen-mafia-cards-game .mafia-cards-narrator-row');
      const row = rows[rows.length - 1];  // last player
      if (row) {
        window.__tapAt?.(row);
        setTimeout(() => row.click(), 350);
      }
    }
  },

  // ---- Scene 5: vote — tap another player
  { at: 45.5, label: 'Scene 5 — tap Player 4 (vote elimination)',
    do: () => {
      const rows = document.querySelectorAll('#screen-mafia-cards-game .mafia-cards-narrator-row');
      const row = rows[3];  // Player 4
      if (row) {
        window.__tapAt?.(row);
        setTimeout(() => row.click(), 350);
      }
    }
  },

  // ---- Scene 6: win — pull back to show the full state, fade out
  { at: 51.5, label: 'Scene 6 — final state showing eliminations',
    do: () => {
      const main = document.querySelector('#screen-mafia-cards-game main, #screen-mafia-cards-game') || document.documentElement;
      main.scrollTo({ top: 0, behavior: 'smooth' });
    }
  },
];

const DURATION_SEC = 59.0;  // a touch longer than audio so we get the tail

async function setup(page) {
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('huddle.theme', 'dark'); } catch(e){}
  });
  await page.evaluate(async () => {
    if (!window.myProfile) await huddleSignInWithGoogle();
  });
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(async () => {
    if (typeof closeMafiaHowTo === 'function') closeMafiaHowTo();
    if (typeof mafiaLabStart === 'function') await mafiaLabStart();
  });
  await new Promise(r => setTimeout(r, 500));
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
    // Reset to lobby so the first scene shows the lobby view.
    mafiaState.phase = 'lobby';
    goTo('mafia-lobby');
  });
  await new Promise(r => setTimeout(r, 400));

  // Inject helpers: lab-bar hider + fake cursor with tap ripple
  await page.evaluate(() => {
    const css = document.createElement('style');
    css.textContent = `
      .mafia-lab-bar { display: none !important; }
      .__rec-cursor {
        position: fixed; left: 0; top: 0; pointer-events: none; z-index: 100000;
        width: 22px; height: 22px; border-radius: 50%;
        background: rgba(255,255,255,.18);
        border: 1.5px solid rgba(255,255,255,.65);
        transform: translate(-50%,-50%) scale(0); opacity: 0;
        transition: opacity .25s ease, transform .25s cubic-bezier(.34,1.56,.64,1);
        will-change: transform, opacity;
      }
      .__rec-cursor.is-tapping {
        opacity: 1; transform: translate(-50%,-50%) scale(1);
        animation: __rec-pulse .55s ease-out;
      }
      @keyframes __rec-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(251,191,36,.7); }
        100% { box-shadow: 0 0 0 32px rgba(251,191,36,0); }
      }
    `;
    document.head.appendChild(css);
    const cursor = document.createElement('div');
    cursor.className = '__rec-cursor';
    document.body.appendChild(cursor);
    window.__hideLabBar = () => {
      document.querySelectorAll('.mafia-lab-bar').forEach(el => el.style.display = 'none');
    };
    window.__tapAt = (target) => {
      if (!target) return;
      const r = target.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      cursor.style.left = cx + 'px';
      cursor.style.top = cy + 'px';
      cursor.classList.remove('is-tapping');
      // Force reflow so the animation restarts
      void cursor.offsetWidth;
      cursor.classList.add('is-tapping');
      setTimeout(() => cursor.classList.remove('is-tapping'), 600);
    };
    window.__hideLabBar();
  });
}

(async () => {
  console.log('Launching Puppeteer at 375x812 (iPhone X)…');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

    console.log('Loading app…');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1200));

    console.log('Seeding state…');
    await setup(page);

    console.log(`\nStarting screencast → ${path.basename(WEBM_PATH)}`);
    if (fs.existsSync(WEBM_PATH)) fs.unlinkSync(WEBM_PATH);
    // Puppeteer's ScreenRecorder shells out to ffmpeg. By default it looks
    // in PATH; we point it at the portable binary from ffmpeg-static so the
    // user doesn't need a system install.
    const recorder = await page.screencast({ path: WEBM_PATH, ffmpegPath });
    const t0 = Date.now();

    console.log('Running action timeline:');
    for (const step of TIMELINE) {
      const elapsed = (Date.now() - t0) / 1000;
      const waitFor = Math.max(0, step.at - elapsed);
      if (waitFor > 0) await new Promise(r => setTimeout(r, waitFor * 1000));
      console.log(`  [${step.at.toFixed(1)}s] ${step.label}`);
      if (step.do) {
        try { await page.evaluate(step.do); }
        catch(e) { console.warn('    (step failed):', e.message); }
      }
    }

    // Wait for remaining audio time
    const elapsed = (Date.now() - t0) / 1000;
    const remaining = Math.max(0, DURATION_SEC - elapsed);
    if (remaining > 0) {
      console.log(`  [waiting ${remaining.toFixed(1)}s for audio tail]`);
      await new Promise(r => setTimeout(r, remaining * 1000));
    }

    console.log('Stopping screencast…');
    await recorder.stop();
    console.log(`  webm size: ${Math.round(fs.statSync(WEBM_PATH).size / 1024)}KB`);
  } finally {
    await browser.close();
  }

  console.log(`\nMuxing audio + converting to MP4 → ${path.basename(MP4_PATH)}`);
  if (fs.existsSync(MP4_PATH)) fs.unlinkSync(MP4_PATH);
  const result = spawnSync(ffmpegPath, [
    '-y',
    '-i', WEBM_PATH,
    '-i', AUDIO_PATH,
    // libx264 requires both dimensions to be even. Our viewport is 375x812
    // (odd width). Pad up to the nearest even number so encoding succeeds.
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',     // wide compatibility (Safari etc.)
    '-crf', '23',
    '-preset', 'fast',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    '-movflags', '+faststart',  // browser can start playing while downloading
    MP4_PATH,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    console.error('ffmpeg stderr:', result.stderr.toString().slice(-600));
    process.exit(1);
  }
  console.log(`  mp4 size:  ${Math.round(fs.statSync(MP4_PATH).size / 1024)}KB`);
  console.log('\nDone. Open it: assets/howto/mafia-en-walkthrough.mp4');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
