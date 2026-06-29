// Huddle app-10-boot.js (fragment 10/10, split from app.js).
// All fragments share ONE global scope and MUST load in numeric order — do not reorder.

    // -------------------------------------------------------------------
    // Resume an in-progress game room after the app returns to the foreground,
    // the network comes back, or the page is restored from BFCache. On mobile
    // the realtime WebSocket is silently killed while the tab is backgrounded
    // (phone lock, app-switch), so re-pulling state is NOT enough — we also
    // FORCE a channel rebuild (force=true) which re-subscribes and re-announces
    // our presence. Re-announcing within the 5-minute leave-grace window is what
    // makes the other players' clients cancel our pending "disconnect", so our
    // seat is held and we drop straight back into the live game. Mafia's
    // wireSync always rebuilds, so it takes no force flag. Shared by the
    // pageshow (BFCache), online, and visibilitychange handlers.
    // -------------------------------------------------------------------
    async function huddleResumeActiveRoom(){
      try {
        // A long-backgrounded phone returns with a possibly-expired auth token
        // and a dead socket; refresh the session BEFORE we re-subscribe, or the
        // forced channel rebuild can silently fail to authenticate. getSession()
        // refreshes when needed and is a cheap no-op when the token is valid.
        if (window.sb && window.sb.auth) { try { await window.sb.auth.getSession(); } catch(e){} }
        const active = document.querySelector('.screen.active');
        const id = active ? active.id : '';
        if ((id === 'screen-lobby' || id === 'screen-splash' || id === 'screen-play' || id === 'screen-result')
            && typeof hotLoadRoom === 'function' && typeof state !== 'undefined' && state && state.code) {
          hotLoadRoom(state.code).then(ok => { if (ok) { try { hotWireSync(true); } catch(e){} try { hotRerender(); } catch(e){} } });
        } else if (id.startsWith('screen-cham')
            && typeof chamLoadRoom === 'function' && typeof chamState !== 'undefined' && chamState && chamState.code) {
          chamLoadRoom(chamState.code).then(ok => { if (ok) { try { chamWireSync(true); } catch(e){} try { chamRerender(); } catch(e){} } });
        } else if (id.startsWith('screen-liar')
            && typeof liarLoadRoom === 'function' && typeof liarState !== 'undefined' && liarState && liarState.code) {
          liarLoadRoom(liarState.code).then(ok => { if (ok) { try { liarWireSync(true); } catch(e){} try { liarRerender(); } catch(e){} } });
        } else if (id.startsWith('screen-mafia')
            && typeof mafiaLoadRoom === 'function' && typeof mafiaState !== 'undefined' && mafiaState && mafiaState.code) {
          mafiaLoadRoom(mafiaState.code).then(ok => { if (ok) { try { mafiaWireSync(); } catch(e){} try { mafiaRerender(); } catch(e){} } });
        }
      } catch(e){}
    }

    // -------------------------------------------------------------------
    // BFCache rehydration — per web.dev/bfcache. When the page is restored
    // from the back/forward cache, JS state IS preserved but realtime
    // WebSocket connections were closed when the page went into the frozen
    // state. Without this handler, a user who hits browser-back to leave
    // Huddle, then forward to return, sees the UI in its prior frame but
    // their game-room state is stale (no live updates) until they refresh.
    //
    // event.persisted === true means BFCache restore. On that path we
    // re-pull friends + invites + active game-room state. Realtime channels
    // typically reconnect on their own — we just kick-start the data so the
    // first repaint is correct, not after a 2-3s reconnect delay.
    // -------------------------------------------------------------------
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return; // normal fresh load — boot already handled it
      try { if (typeof friendsState !== 'undefined' && friendsState.me && typeof friendsLoad === 'function') friendsLoad(); } catch(e){}
      try { if (typeof invitesState !== 'undefined' && invitesState.me && typeof invitesLoad === 'function') invitesLoad(); } catch(e){}
      // Re-pull + re-subscribe (force channel rebuild) the active game room.
      huddleResumeActiveRoom();
    });

    // -------------------------------------------------------------------
    // Online / Offline UX — per MDN + Slack/Discord patterns
    //   offline → show subtle "Reconnecting…" banner
    //   online  → hide banner, fire brief "Back online" toast, re-pull
    //             friends/invites + any active room state so the UI is fresh
    //
    // navigator.onLine === true is "best effort" (could mean local network
    // but no internet) — we trust it as a hint, not the truth. The real
    // proof is the next successful Supabase RPC, which is auto-retried by
    // huddleCallRPC.
    // -------------------------------------------------------------------
    function huddleSetOfflineBanner(visible){
      const el = document.getElementById('huddle-offline-banner');
      if (!el) return;
      el.hidden = !visible;
    }
    // Initial sync — if the page boots while already offline, show the
    // banner immediately. (Otherwise users on plane wifi etc. see nothing
    // until they try to act.)
    try { if (typeof navigator !== 'undefined' && navigator.onLine === false) huddleSetOfflineBanner(true); } catch(e){}
    window.addEventListener('offline', () => {
      huddleSetOfflineBanner(true);
    });
    window.addEventListener('online', () => {
      huddleSetOfflineBanner(false);
      try {
        if (typeof showLobbyToast === 'function') showLobbyToast(t('net.backOnline'), 2200);
      } catch(e){}
      // Recovery refresh — same backstop the visibilitychange handler runs
      // for the same reason: realtime sockets may have died while offline.
      try { if (typeof friendsState !== 'undefined' && friendsState.me && typeof friendsLoad === 'function') friendsLoad(); } catch(e){}
      try { if (typeof invitesState !== 'undefined' && invitesState.me && typeof invitesLoad === 'function') invitesLoad(); } catch(e){}
      // Re-pull + re-subscribe (force channel rebuild) the active game room.
      huddleResumeActiveRoom();
    });

    /* ===== WHEEL TEST DEMO — Lab-only =====
       Drives the wheel animation with mock parameters. Reuses the LIVE wheel
       CSS (.liar-wheel-*) so what you see here is what the real game plays.
       Schedules its own timeline mirroring liarRunCupAnimation. */

    const WHEEL_TEST_SCENARIOS = {
      'lied-safe' : { lied:true,  outcome:'safe'    },
      'lied-out'  : { lied:true,  outcome:'spilled' },
      'wrong-safe': { lied:false, outcome:'safe'    },
      'wrong-out' : { lied:false, outcome:'spilled' },
    };
    let wheelTestScenario = 'lied-safe';
    let wheelTestSpills   = 1;
    let wheelTestRunning  = false;
    let wheelTestTimers   = [];

    function wheelTestClearTimers(){
      wheelTestTimers.forEach(t => clearTimeout(t));
      wheelTestTimers = [];
    }
    function wheelTestAfter(ms, fn){
      const id = setTimeout(()=>{
        wheelTestTimers = wheelTestTimers.filter(t => t !== id);
        fn();
      }, ms);
      wheelTestTimers.push(id);
    }

    function openWheelTestPicker(){
      document.getElementById('wheel-test-picker-backdrop').classList.add('active');
    }
    function closeWheelTestPicker(){
      document.getElementById('wheel-test-picker-backdrop').classList.remove('active');
    }
    function openWheelTest(){
      closeWheelTestPicker();
      goTo('wheel-test');
      wheelTestReset();
    }
    function closeWheelTest(){
      wheelTestClearTimers();
      goTo('profile');
    }

    function wheelTestSetScenario(scn){
      wheelTestScenario = scn;
      document.querySelectorAll('#wheel-test-toggle .wheel-test-chip').forEach(c => {
        const active = c.dataset.scenario === scn;
        c.classList.toggle('active', active);
        c.style.background = active ? 'var(--text)' : 'transparent';
        c.style.color = active ? 'var(--bg)' : 'var(--text-secondary)';
        c.style.fontWeight = active ? '700' : '600';
      });
      wheelTestReset();
    }
    function wheelTestSetSpills(n){
      wheelTestSpills = n;
      document.querySelectorAll('.wheel-test-spill-btn').forEach((b, i) => {
        const active = (i + 1) === n;
        b.style.background = active ? 'var(--text)' : 'transparent';
        b.style.color = active ? 'var(--bg)' : 'var(--text)';
      });
      wheelTestReset();
    }

    function wheelTestPaintWheel(spills, chamberIdx){
      const wheel = document.getElementById('wheel-test-wheel');
      if (!wheel) return;
      // Build spill chamber pattern with the chamberIdx slot reflecting outcome.
      // For predictability: red wedges = first N (matches the simple fallback).
      const chambers = new Array(6).fill(false);
      for (let i = 0; i < Math.min(spills, 6); i++) chambers[i] = true;
      // Polished palette + sheen overlay (matches live liarRenderCupInline)
      let bg = 'conic-gradient(';
      for (let i = 0; i < 6; i++) {
        const start = i * 60, end = (i + 1) * 60;
        const color = chambers[i] ? '#b91c1c' : (i % 2 === 0 ? '#16a34a' : '#15803d');
        bg += `${color} ${start}deg ${end}deg${i < 5 ? ',' : ''}`;
      }
      bg += ')';
      const sheen = 'radial-gradient(circle at 50% 22%, rgba(255,255,255,.22) 0%, rgba(255,255,255,0) 42%), radial-gradient(circle at 50% 88%, rgba(0,0,0,.25) 0%, rgba(0,0,0,0) 58%)';
      wheel.style.background = `${sheen}, ${bg}`;
      return chambers;
    }

    function wheelTestReset(){
      wheelTestClearTimers();
      wheelTestRunning = false;
      const btn = document.getElementById('wheel-test-run-btn');
      if (btn) btn.disabled = false;
      const wheel = document.getElementById('wheel-test-wheel');
      const stage = document.getElementById('wheel-test-stage');
      const stamp = document.getElementById('wheel-test-stamp');
      const spotwedge = document.getElementById('wheel-test-spotwedge');
      const result = document.getElementById('wheel-test-result');
      const particles = document.getElementById('wheel-test-particles');
      if (wheel) {
        wheel.className = 'liar-wheel';
        wheel.style.removeProperty('--liar-wheel-target');
      }
      if (stage) stage.className = 'liar-cup-stage liar-wheel-stage';
      if (stamp) { stamp.className = 'liar-wheel-stamp'; stamp.textContent = ''; }
      if (spotwedge) spotwedge.className = 'liar-wheel-spotwedge';
      if (result) result.style.display = 'none';
      if (particles) particles.innerHTML = '';
      wheelTestPaintWheel(wheelTestSpills, 0);
    }

    function wheelTestRun(){
      if (wheelTestRunning) return;
      wheelTestRunning = true;
      const btn = document.getElementById('wheel-test-run-btn');
      if (btn) btn.disabled = true;
      wheelTestClearTimers();
      wheelTestReset();

      const scn = WHEEL_TEST_SCENARIOS[wheelTestScenario];
      const spills = wheelTestSpills;
      // Pick a chamber matching the outcome
      const safeIdx = Math.min(5, Math.max(spills, 1));     // first green wedge
      const spillIdx = Math.min(spills - 1, 5);             // last red wedge
      const finalIdx = scn.outcome === 'safe' ? safeIdx : spillIdx;
      wheelTestPaintWheel(spills, finalIdx);

      // Compute target rotation (same math as live game)
      const wedgeMidAngle = 60 * finalIdx + 30;
      const baseRotation = ((360 - wedgeMidAngle) % 360 + 360) % 360;
      const targetRotation = (6 * 360) + baseRotation;

      const wheel = document.getElementById('wheel-test-wheel');
      const stage = document.getElementById('wheel-test-stage');
      const stamp = document.getElementById('wheel-test-stamp');
      const spotwedge = document.getElementById('wheel-test-spotwedge');
      const particles = document.getElementById('wheel-test-particles');
      const result = document.getElementById('wheel-test-result');

      wheel.classList.remove('spinning');
      void wheel.offsetWidth;
      wheel.style.setProperty('--liar-wheel-target', targetRotation + 'deg');

      // Streamlined: spin + stamp + result. No sounds, no particles, no
      // spotwedge glow, no body shake, no vignette, no fullscreen flash.
      // Matches the streamlined live liarRunCupAnimation.
      wheelTestAfter(100, () => { wheel.classList.add('spinning'); });

      // Stamp slams in shortly after the wheel lands
      wheelTestAfter(6500, () => {
        if (stamp) {
          stamp.textContent = scn.outcome === 'spilled' ? 'OUT' : 'SAFE';
          stamp.className = 'liar-wheel-stamp ' + (scn.outcome === 'spilled' ? 'out' : 'safe') + ' show hold';
        }
      });

      // Result card removed per user request — just keep it hidden and
      // reset the run state after the stamp settles.
      if (result) result.style.display = 'none';
      wheelTestAfter(7500, () => {
        wheelTestRunning = false;
        if (btn) btn.disabled = false;
      });
    }

    /* ===== END WHEEL TEST DEMO ===== */

