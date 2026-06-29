// Huddle app-07-liar.js (fragment 7/10, split from app.js).
// All fragments share ONE global scope and MUST load in numeric order — do not reorder.

    // ============ LIAR'S CUP ============
    // Bluffing card game inspired by Liar's Bar / Liar's Deck.
    // Adaptation: replaced Russian Roulette with an "unlucky cup" (cocktail glass)
    // that fits Huddle's cafe vibe. Mechanic is identical — 6 chambers, X are "spill",
    // X starts at 1 and increases by 1 each time someone survives a sip.
    // Single-device pass-the-phone — each player's hand is hidden when passed.
    //
    // Deck: 6 Aces + 6 Kings + 6 Queens + 2 Jokers = 20 cards.
    // Jokers count as ANY rank (always truthful).
    // Hand size: scales with player count so the 20-card deck always covers the table.

    // Card data — each card is { rank: 'A'|'K'|'Q'|'J', id: unique }
    // Liar's Bar canonical 20-card deck: 6 Aces, 6 Kings, 6 Queens, 2 Jokers.
    // Jokers are wild — count as any rank during a LIAR reveal. Same composition as
    // the source video game by Curve Animation (Steam, 2024).
    const LIAR_DECK_SPEC = { A: 6, K: 6, Q: 6, J: 2 };
    // Build the deck, scaling with player count so larger groups have enough cards.
    // multiplier = ceil(playerCount / 4): every block of up to 4 players adds one
    // 20-card unit, keeping the same A:K:Q:J ratio. So 2-4 → 20, 5-8 → 40,
    // 9-12 → 60, 13-16 → 80, 17-20 → 100 cards. Every player always gets 5 cards,
    // and the deck always holds at least playerCount × 5. MUST match the SQL
    // multiplier in 06_liar_rpcs.sql (CEIL(alive / 4.0)).
    function liarBuildDeck(playerCount){
      const multiplier = Math.max(1, Math.ceil((playerCount || 0) / 4));
      const deck = [];
      let n = 0;
      for (let i = 0; i < LIAR_DECK_SPEC.A * multiplier; i++) deck.push({ rank: 'A', id: 'a' + (++n) });
      for (let i = 0; i < LIAR_DECK_SPEC.K * multiplier; i++) deck.push({ rank: 'K', id: 'k' + (++n) });
      for (let i = 0; i < LIAR_DECK_SPEC.Q * multiplier; i++) deck.push({ rank: 'Q', id: 'q' + (++n) });
      for (let i = 0; i < LIAR_DECK_SPEC.J * multiplier; i++) deck.push({ rank: 'J', id: 'j' + (++n) });
      // Sanity: must have at least playerCount × handSize cards.
      const expectedMin = (playerCount || 4) * 5;
      if (deck.length < expectedMin) {
        console.error('liarBuildDeck: not enough cards', { count: deck.length, expectedMin });
      }
      return deck;
    }

    // ===========================================================================
    // ⚠  SHARED "CARD-LOBBY ENGINE" — used by LIAR'S CUP *and* MAFIA.
    //
    //    Despite the `liar*` names, the room / seat / sync machinery below is NOT
    //    Liar-only. MAFIA has no state object of its own — it reuses `liarState`,
    //    `liarMe`, and the `liar*` lobby/sync functions wholesale (see
    //    `openLiarLobby` in app-08-mafia.js). So editing `liarState`, `liarMe`, or
    //    any `liar*` lobby/room/seat/sync function can break the MAFIA lobby too —
    //    even though nothing here mentions "mafia".
    //
    //    The `liar` name is historical (Liar's Cup was the first game built on this
    //    engine). Genuinely Liar-only logic — card scoring, cup, reveal — rightly
    //    stays `liar*`. Only the lobby/room/seat/sync parts are the shared engine.
    //    (Someday this should be renamed `cardLobby*`; until then, tread carefully.)
    // ===========================================================================

    // liarState is the SYNCED ROOM STATE — same shape on every connected device.
    // Today: persisted to localStorage, broadcast across browser tabs via 'storage' events.
    // Tomorrow: persisted to Supabase (Postgres row), broadcast via Supabase Realtime.
    // The transport changes; the state shape stays identical.
    const liarState = {
      code: null,              // room code — also the localStorage key suffix
      phase: 'lobby',          // 'lobby' | 'tablecard' | 'play' | 'reveal' | 'cup' | 'result'
      hostId: null,            // playerId who created the room
      claimedBy: {},           // playerId → sessionId (which device claimed this seat)
      players: [],             // all original players (deep copy of PLAYERS)
      alivePlayers: [],        // playerIds still in the game (in turn order)
      hands: {},               // playerId → array of card objects (each device renders only ITS own)
      pile: [],                // array of all played cards across the round
      lastPlay: null,          // {count, cards, byPlayerId, claimedRank}
      recentPlays: {},         // playerId → {count, claimedRank, turnIndex} — most recent play this round, per seat
      tableCard: 'K',          // 'A' | 'K' | 'Q'
      currentPlayerIdx: 0,     // index into alivePlayers
      nextRoundStartIdx: null, // who starts the next round (source-game rule:
                               // the loser of the previous LIAR call). Set by
                               // liarAfterSip, consumed server-side when the next
                               // round is dealt.
      cupSpills: 1,            // # of "spill" chambers (1..6)
      pendingLoserId: null,    // who's going to the cup
      pendingLoserCause: null, // 'lied' | 'wrongAccuse'
      sipOutcome: null,        // null | 'safe' | 'spilled'
      sipChamberIdx: null,     // 0..5 — which chamber the cup landed on
      sipChamberIsSpill: [],   // boolean[6] — pattern for this sip
      sipTaken: false,         // becomes true once the loser tapped (gates animation on other tabs)
      wins: {},                // playerId → wins across games
      winnerId: null,
      roundCount: 0,
      revision: 0,             // increments on every persist — helps debugging
    };

    // liarMe is the LOCAL PER-DEVICE state. Never synced. Lives only on this device.
    // The `sessionId` is the Supabase auth user ID (stable across page reloads).
    // If Supabase is unavailable, we fall back to a random per-tab id (no cross-reload stability).
    const liarMe = {
      sessionId: null,         // Supabase user ID OR fallback random — set by liarBootstrap()
      myId: null,              // playerId this device claimed
      selectedCardIds: [],     // local UI selection — not synced
      bootstrapped: false,     // becomes true once auth has resolved
    };

    // Bootstrap: ensure we have a stable per-device identity via Supabase Anonymous Auth.
    // First load: signs in anonymously, gets a uuid that persists in localStorage.
    // Subsequent loads on same device: restores the same uuid.
    // Failure: falls back to a random per-tab id (game still works, just less stable).
    async function liarBootstrap(){ return huddleBootstrap(liarMe, "Liar's Cup"); }
    function cardLobbyGetSessionId(){ return huddleGetSessionId(liarMe); }

    // ---------- Sync transport (Supabase Realtime + Postgres) ----------
    // Each game room is one row in the `liar_rooms` table with a JSONB `state` column.
    // - Persist: upsert the row.
    // - Load:    select the row by code.
    // - Sync:    subscribe to postgres_changes on the row via Supabase Realtime channel.
    //
    // Race model: last-writer-wins. Turn-based gameplay serializes naturally, so
    // simultaneous writes are rare. Revision number defends against out-of-order delivery.

    function liarPersist(){
      // C2 lockdown: direct client writes to `liar_rooms` are now blocked at
      // the RLS layer. All Liar's Cup state mutations go through server RPCs
      // (huddle_liar_*). This function is kept as a defensive no-op so any
      // stray future caller fails loudly in the console instead of silently
      // attempting a write that would be rejected anyway. Lab mode is a no-op
      // too, matching the prior behavior so the lab harness keeps working.
      if (liarState.labMode) return;
      console.warn('[Huddle] liarPersist() called but is a no-op — route this write through a huddle_liar_* RPC instead.');
    }

    async function liarLoadRoom(code){
      const incoming = await huddleFetchRoomState('liar_rooms', code);
      if (!incoming) return false;
      if (incoming.closedByHost) return false;
      Object.keys(liarState).forEach(k => delete liarState[k]);
      Object.assign(liarState, incoming);
      return true;
    }

    // Active Realtime channel — re-subscribed when the room code changes.
    // ===== Liar's Cup multiplayer presence =====
    // Supabase Presence tracks every device subscribed to the room channel.
    // We use it to detect when an "expected actor" (the loser of a LIAR call,
    // whose device drives subsequent state transitions) has actually left, so
    // another connected peer can take over and the game doesn't stall.
    //
    // Reliability beats browser events: `beforeunload`/`pagehide` don't fire on
    // mobile when the OS kills the browser, but the WebSocket eventually drops
    // and Supabase emits a `presence.leave` event (~1-2s for clean closes,
    // ~30-60s for unclean drops like wifi loss). 60-second grace timer covers
    // legitimate refreshes (auth user ID is stable across reload).
    let _liarPresentSessions = new Set(); // sessionIds currently connected
    let _liarLeaveGraceTimers = new Map(); // sessionId → grace timer id
    // 5-min grace (2026-06-27, RECONNECTION_PLAN.md Phase 1) — see
    // CHAM_LEAVE_GRACE_MS for the reasoning.
    const LIAR_LEAVE_GRACE_MS = 300000;

    // Is the player at seat `playerId` actually connected right now?
    function liarIsPlayerPresent(playerId){
      if (!playerId) return false;
      const sid = liarState.claimedBy && liarState.claimedBy[playerId];
      return sid ? _liarPresentSessions.has(sid) : false;
    }
    // Lowest seat in turn order whose claimant is currently connected.
    // Deterministic: every device computes the same answer for the same state,
    // so the "who takes over" choice is consistent across peers without a
    // coordinator. Returns null if nobody is present.
    function liarLowestSeatConnectedPlayer(){
      const alive = liarState.alivePlayers || [];
      const claimedBy = liarState.claimedBy || {};
      for (const pid of alive) {
        const sid = claimedBy[pid];
        if (sid && _liarPresentSessions.has(sid)) return pid;
      }
      return null;
    }
    // Should THIS device fire the next state transition for `expectedActorId`?
    // Yes if I'm the expected actor OR the expected actor is gone and I'm
    // the lowest-seat-connected fallback. Re-checked at every scheduled
    // fire-time so a mid-flight disconnect can hand the baton over cleanly.
    function liarShouldITakeAction(expectedActorId){
      if (!expectedActorId || !liarMe.myId) return false;
      // Lab mode: a single device runs all 3 players, so every gated action
      // (auto-advance reveal→cup, take-sip, after-sip, etc.) must fire locally
      // regardless of which perspective is currently active.
      if (liarState && liarState.labMode) return true;
      if (expectedActorId === liarMe.myId) return true;
      // Graceful degradation: if presence isn't initialized yet (channel
      // hasn't sync'd, or our own session is missing from the set), fall
      // back to "only the expected actor fires". Avoids the worst case of
      // stalling the game before presence handlers wire up.
      const presenceReady = liarMe.sessionId && _liarPresentSessions.has(liarMe.sessionId);
      if (!presenceReady) return false;
      if (liarIsPlayerPresent(expectedActorId)) return false;
      return liarLowestSeatConnectedPlayer() === liarMe.myId;
    }
    // After the 60s grace expires without a rejoin, treat the session as gone.
    // Only the lowest-connected peer fires the cleanup mutation — everyone
    // updates their _liarPresentSessions set, but only one peer writes to
    // Supabase so we avoid a thundering-herd on liarPersist().
    function liarConfirmUserGone(sessionId){
      return huddleConfirmUserGone(sessionId, {
        presentSessions: _liarPresentSessions, graceTimers: _liarLeaveGraceTimers,
        gameState: liarState, rerender: liarRerender, lowestConnected: liarLowestSeatConnectedPlayer,
        meObj: liarMe, rpcName: 'huddle_liar_handle_disconnect',
      });
    }
    function liarStartLeaveGrace(sessionId){ huddleStartLeaveGrace(_liarLeaveGraceTimers, sessionId, LIAR_LEAVE_GRACE_MS, liarConfirmUserGone); }
    function liarCancelLeaveGrace(sessionId){ huddleCancelLeaveGrace(_liarLeaveGraceTimers, sessionId); }
    function liarResetPresenceState(){ huddleResetPresenceState(_liarLeaveGraceTimers, _liarPresentSessions); }

    let _liarChannel = null;
    let _liarChannelCode = null;
    let _liarChannelSessionId = null;
    function liarWireSync(force){
      huddleWireSync({
        force: force,
        gameState: liarState, meObj: liarMe, getSessionId: cardLobbyGetSessionId,
        channelName: 'liar_room:', table: 'liar_rooms',
        presenceKey: liarMe.sessionId, getTrackUserId: () => liarMe.sessionId,
        toastLeftKey: 'liar.toastPlayerLeft', restoreMeId: false,
        rerender: liarRerender, loadRoom: liarLoadRoom, forceLeaveLocal: liarForceLeaveLocal,
        resetPresenceState: liarResetPresenceState,
        graceTimers: _liarLeaveGraceTimers, cancelGrace: liarCancelLeaveGrace, startGrace: liarStartLeaveGrace,
        // claimedBy only changes on a real leave (elimination uses alivePlayers),
        // so the "{name} left" notice never mis-fires on a knockout. Sole-survivor
        // logic handles end-of-game, so there's no graceful return-to-lobby here.
        isOnGameScreen: (id) => id.startsWith('liar-'),
        refs: {
          getChannel: () => _liarChannel, setChannel: (c) => { _liarChannel = c; },
          getChannelCode: () => _liarChannelCode, setChannelCode: (c) => { _liarChannelCode = c; },
          getChannelSessionId: () => _liarChannelSessionId, setChannelSessionId: (s) => { _liarChannelSessionId = s; },
          getPresent: () => _liarPresentSessions, setPresent: (s) => { _liarPresentSessions = s; },
        },
      });
    }
    // Best-effort fast-leave when the page is hiding/closing. The server emits
    // the `leave` event faster when we untrack explicitly than when waiting
    // for the heartbeat to time out. Doesn't help on mobile-OS-kills (no
    // event fires there) — that case still relies on the heartbeat timeout.
    try {
      const fastUntrack = () => {
        if (_liarChannel) {
          try { _liarChannel.untrack(); } catch(e){}
        }
      };
      window.addEventListener('pagehide', fastUntrack, { capture: true });
      window.addEventListener('beforeunload', fastUntrack, { capture: true });
    } catch(e){}

    // Re-render whatever screen matches the current phase. Navigates if phase changed.
    // All in-game phases (tablecard/play/reveal/cup/result) now live on one screen
    // (#screen-liar-play); a `data-stage` attribute drives which .liar-stage is visible.
    // Only lobby is a separate screen.
    //
    // liarRerender is a thin wrapper around liarRerenderInner. The wrapper enforces
    // the cross-device sync model: if liarSyncDelayMs() > 0, the new phase is in
    // the future (writer just stamped phaseStartAt = now + 700ms), so we show the
    // waiting overlay over the CURRENT content and defer the real render until
    // the planned moment. Result: writer and watchers display the new phase at
    // the same wall-clock time, independent of network latency.
    const __liarRerenderPending = { timer: null };
    function liarRerender(){
      huddleSyncGateRerender(liarState, liarRerenderInner, __liarRerenderPending);
    }

    function liarRerenderInner(){
      // Reveal + cup phases stay on the play stage — the reveal overlay (inside
      // the felt) handles the cards-flip + verdict + wheel without a stage swap,
      // so the felt + seats + ACE-pill position stay continuous across phases.
      const phaseToStage = {
        tablecard: 'tablecard',
        play: 'play',
        reveal: 'play',
        cup: 'play',
        result: 'result',
      };
      const stage = phaseToStage[liarState.phase];
      const targetScreen = stage ? 'liar-play' : 'liar-lobby';
      const activeId = document.querySelector('.screen.active');
      const currentId = activeId ? activeId.id.replace('screen-', '') : null;
      if (currentId !== targetScreen) {
        goTo(targetScreen);
      }
      if (stage) {
        const screenEl = document.getElementById('screen-liar-play');
        if (screenEl) screenEl.setAttribute('data-stage', stage);
      }
      // Toggle reveal-mode on the SCREEN (not the felt). The overlay lives as a
      // direct child of the screen so its centre = screen centre. cup-mode is
      // managed by liarEnterCupMode / liarExitCupMode below.
      const screenEl2 = document.getElementById('screen-liar-play');
      if (screenEl2) {
        const inReveal = liarState.phase === 'reveal' || liarState.phase === 'cup';
        screenEl2.classList.toggle('reveal-mode', inReveal);
        if (!inReveal) screenEl2.classList.remove('cup-mode');
      }
      // The invite-a-friend sheet is a lobby-only affordance. If a player has
      // it open when the host starts the game, the sheet would otherwise stay
      // covering the play screen until they tap the X — leaving them confused
      // about a hand they can't see. Auto-close on any non-lobby phase.
      if (liarState.phase !== 'lobby') {
        const bd = document.getElementById('lobby-invite-backdrop');
        if (bd && bd.classList.contains('active') && typeof closeLobbyInviteSheet === 'function') {
          closeLobbyInviteSheet();
        }
      }
      // Always re-render content
      if (liarState.phase === 'lobby') { liarRenderSeats(); if (typeof renderLobbyInvites === 'function') renderLobbyInvites('liar'); }
      else if (liarState.phase === 'tablecard') { liarSetHeaderForStage('tablecard'); liarRenderTableCardSplash(); }
      else if (liarState.phase === 'play') liarRenderPlayScreen();
      else if (liarState.phase === 'reveal') { liarExitCupMode(); liarRenderRevealContent(); }
      else if (liarState.phase === 'cup') { liarRenderRevealContent(); liarEnterCupMode(); liarRenderCupInline(); }
      else if (liarState.phase === 'result') { liarSetHeaderForStage('result'); liarExitCupMode(); liarRenderResultContent(); }
      // Keep lab perspective bar in sync (visibility + current-turn dot + active chip)
      if (typeof liarLabRenderBar === 'function') liarLabRenderBar();
      // Start / stop the sole-survivor polling fallback based on phase. See
      // liarStartSoloPoll for why this exists.
      if (liarState.phase === 'play' || liarState.phase === 'reveal' || liarState.phase === 'cup') {
        liarStartSoloPoll();
      } else {
        liarStopSoloPoll();
      }
    }

    // ===== Sole-survivor polling fallback =====
    // Supabase Realtime presence is the PRIMARY mechanism for detecting that a
    // player left the game (via the leave event → grace timer → liarConfirmUserGone).
    // But abrupt disconnects (mobile tab killed, network drop, browser crash)
    // sometimes don't fire `leave`. If the gone player happened to be the
    // current turn-holder, the remaining players see "Waiting for X" forever.
    //
    // This poll is a SAFETY NET on top of presence. Every 4 seconds (after a
    // 12s grace so presence has time to settle on join), check: of all alive
    // seats in the game, how many have a session currently in _liarPresentSessions?
    // If only one and it's me, I'm the sole survivor → declare myself winner.
    //
    // Conservative gates ensure no false positives:
    //   - 12s grace prevents firing during the moment after I join when
    //     presence hasn't synced yet.
    //   - Requires my own session to be in _liarPresentSessions (channel
    //     properly subscribed, not in a broken state).
    //   - Requires alive seats > 1 (already-solo rooms don't need detection).
    //   - Requires lowestSeatConnectedPlayer === me (only one peer writes).
    let _liarSoloPollTimer = null;
    let _liarSoloPollStartedAt = 0;
    // 5-min (2026-06-27): raised from 8s to match LIAR_LEAVE_GRACE_MS. The
    // sole-survivor poll declares a winner when only ONE player is present in
    // the realtime channel — but a briefly-locked phone is absent from presence
    // while its seat is still intact, so the old 8s could crown a "winner" ~11s
    // after two players locked their phones, ending the game out from under a
    // table that's still sitting there. Deferring to the seat-removal path
    // (which only fires after the full grace) makes this a harmless backstop.
    const LIAR_SOLO_POLL_GRACE_MS = 300000;
    const LIAR_SOLO_POLL_INTERVAL = 3000;   // check every 3s after grace
    function liarStartSoloPoll(){
      if (_liarSoloPollTimer) return;
      _liarSoloPollStartedAt = Date.now();
      _liarSoloPollTimer = setInterval(liarCheckIfSoleSurvivor, LIAR_SOLO_POLL_INTERVAL);
    }
    function liarStopSoloPoll(){
      if (_liarSoloPollTimer) {
        clearInterval(_liarSoloPollTimer);
        _liarSoloPollTimer = null;
      }
    }
    function liarCheckIfSoleSurvivor(){
      if (!liarState.code || !liarMe.myId) { liarStopSoloPoll(); return; }
      const phase = liarState.phase;
      if (phase === 'lobby' || phase === 'result') { liarStopSoloPoll(); return; }
      if (Date.now() - _liarSoloPollStartedAt < LIAR_SOLO_POLL_GRACE_MS) return;
      if (!liarMe.sessionId || !_liarPresentSessions.has(liarMe.sessionId)) return;
      const alive = liarState.alivePlayers || [];
      if (alive.length <= 1) return;
      const claimedBy = liarState.claimedBy || {};
      const presentAlive = alive.filter(pid => {
        const sid = claimedBy[pid];
        return sid && _liarPresentSessions.has(sid);
      });
      if (presentAlive.length !== 1) return;
      if (presentAlive[0] !== liarMe.myId) return;
      // Only the lowest-seat-connected peer writes, defensive against races.
      if (typeof liarLowestSeatConnectedPlayer === 'function'
          && liarLowestSeatConnectedPlayer() !== liarMe.myId) return;
      // I'm provably the only player still here. Declare sole-survivor win
      // via RPC (C2 turn 3c). Server validates caller is a claimant + alive,
      // bumps wins[], and sets phase='result'. Realtime echo updates local.
      liarStopSoloPoll();
      liarClearAllAutoAdvance && liarClearAllAutoAdvance();
      huddleCallRPC('huddle_liar_finish_solo', { p_code: liarState.code });
    }

    // Sets the shared header title for non-play stages. The 'play' stage's title
    // is dynamic ("Your turn" / "Alex's turn") and managed by liarRenderPlayScreen.
    function liarSetHeaderForStage(stage){
      const titleEl = document.getElementById('liar-play-header');
      if (!titleEl) return;
      if (stage === 'tablecard') titleEl.textContent = "Liar's Cup";
      else if (stage === 'reveal') titleEl.textContent = t('liar.revealHeader') || 'The truth';
      else if (stage === 'result') titleEl.textContent = t('liar.resultHeader') || 'Game over';
    }

    // Header leave button — phase-aware. Lab mode short-circuits to a local exit
    // (no Supabase round-trip, no confirm dialog). During result we exit the
    // game-over flow; any other in-game phase exits a mid-round room.
    function liarHeaderLeave(){
      if (liarState && liarState.labMode) return liarLabExit();
      if (liarState && liarState.phase === 'result') return liarLeaveGameOver();
      return liarLeaveRoom('midround');
    }

    // ===== LAB MODE — single-device 3-player test harness =====
    // Spins up a fully-populated liarState with 3 fake players (Jordan/Alex/Maria)
    // and lets the tester flip "acting as" perspective between them via the lab bar.
    // labMode=true makes liarPersist() a no-op so we don't pollute the real
    // liar_rooms table. The real game render/action functions are used unchanged.
    const LIAR_LAB_PLAYERS = [
      { id:'jordan', name:'Jordan', initial:'J' },
      { id:'alex',   name:'Alex',   initial:'A' },
      { id:'maria',  name:'Maria',  initial:'M' },
    ];

    function liarLabResetState(extra){
      Object.keys(liarState).forEach(k => delete liarState[k]);
      Object.assign(liarState, {
        code: null,
        phase: 'lobby',
        hostId: null,
        claimedBy: {},
        players: [],
        alivePlayers: [],
        hands: {},
        pile: [],
        lastPlay: null,
        recentPlays: {},
        tableCard: 'K',
        currentPlayerIdx: 0,
        nextRoundStartIdx: null,
        cupSpills: 1,
        pendingLoserId: null,
        pendingLoserCause: null,
        sipOutcome: null,
        sipChamberIdx: null,
        sipChamberIsSpill: [],
        sipTaken: false,
        wins: {},
        winnerId: null,
        roundCount: 0,
        revision: 0,
      }, extra || {});
    }

    function liarLabStart(){
      liarLabResetState({
        code: 'LAB123',
        hostId: 'lab_jordan',
        players: LIAR_LAB_PLAYERS.map(p => ({ ...p, wins:0, bestTimeMs:null })),
        wins: { jordan:0, alex:0, maria:0 },
        labMode: true,
      });
      LIAR_LAB_PLAYERS.forEach(p => { liarState.claimedBy[p.id] = 'lab_' + p.id; });
      // Start as Jordan; tester can flip perspective via the lab bar.
      liarMe.myId = 'jordan';
      liarMe.sessionId = 'lab_jordan';
      liarMe.bootstrapped = true;
      liarMe.selectedCardIds = [];
      // Jump straight into the game (skip lobby).
      liarStartGame();
      liarLabRenderBar();
    }

    function liarLabSetPerspective(playerId){
      if (!liarState.labMode) return;
      liarMe.myId = playerId;
      liarMe.sessionId = 'lab_' + playerId;
      liarMe.selectedCardIds = []; // hand changes — drop any old selection
      liarLabRenderBar();
      liarRerender();
    }

    function liarLabExit(){
      liarClearAllAutoAdvance && liarClearAllAutoAdvance();
      liarStopAllSfx && liarStopAllSfx();
      liarLabResetState();
      liarMe.myId = null;
      liarMe.selectedCardIds = [];
      const bar = document.getElementById('liar-lab-bar');
      if (bar) bar.setAttribute('hidden', '');
      goTo('profile');
    }

    // Card style switcher — applies one of 5 visual styles to ALL Liar's Cup
    // cards (hand cards + reveal flip cards). Pass a name from CARD_STYLES, or
    // null/undefined to clear and use the built-in default. Persisted in
    // localStorage so a chosen style sticks across reloads.
    const CARD_STYLES = [
      { id:'classic', label:'Classic'  },
      { id:'onyx',    label:'Onyx'     },
      { id:'minimal', label:'Minimal'  },
      { id:'aurora',  label:'Aurora'   },
      { id:'mono',    label:'Mono'     },
    ];
    function liarSetCardStyle(name){
      CARD_STYLES.forEach(s => document.body.classList.remove('card-style-' + s.id));
      if (name && CARD_STYLES.some(s => s.id === name)) {
        document.body.classList.add('card-style-' + name);
        try { localStorage.setItem('huddle.liar.cardStyle', name); } catch(e){}
      } else {
        try { localStorage.removeItem('huddle.liar.cardStyle'); } catch(e){}
      }
      // Refresh the lab style-chip row so the active chip highlight updates.
      if (typeof liarLabRenderStyleChips === 'function') liarLabRenderStyleChips();
    }
    // Boot: restore last-picked style, defaulting to 'classic' so first-time
    // players land on the chosen-as-default front design.
    (function(){
      try {
        const saved = localStorage.getItem('huddle.liar.cardStyle');
        liarSetCardStyle(saved || 'classic');
      } catch(e){ liarSetCardStyle('classic'); }
    })();

    // Card BACK switcher — independent of front style. Controls how the back of
    // a card looks (the side shown during the flip animation before each reveal
    // card turns face-up, AND face-down hand cards). All 5 backs use cream-gold
    // tones to pair cleanly with the Classic front.
    const CARD_BACKS = [
      { id:'pinstripe', label:'Pinstripe' },
      { id:'royal',     label:'Royal'     },
      { id:'lattice',   label:'Lattice'   },
      { id:'sunburst',  label:'Sunburst'  },
      { id:'bordered',  label:'Bordered'  },
    ];
    function liarSetCardBack(name){
      CARD_BACKS.forEach(b => document.body.classList.remove('card-back-' + b.id));
      if (name && CARD_BACKS.some(b => b.id === name)) {
        document.body.classList.add('card-back-' + name);
        try { localStorage.setItem('huddle.liar.cardBack', name); } catch(e){}
      } else {
        try { localStorage.removeItem('huddle.liar.cardBack'); } catch(e){}
      }
      if (typeof liarLabRenderBackChips === 'function') liarLabRenderBackChips();
    }
    // Boot: restore last-picked back, defaulting to Royal so first-time players
    // land on the chosen-as-default back design.
    (function(){
      try {
        const saved = localStorage.getItem('huddle.liar.cardBack');
        liarSetCardBack(saved || 'royal');
      } catch(e){ liarSetCardBack('royal'); }
    })();

    // Wheel style switcher — changes the wheel's border, hub, and pointer.
    // Wedge colours (red/green) stay intact so safe/poison semantics are unchanged.
    const WHEEL_STYLES = [
      { id:'emerald',  label:'Wood'     },
      { id:'mint',     label:'Mint'     },
      { id:'roulette', label:'Roulette' },
      { id:'lime',     label:'Lime'     },
      { id:'forest',   label:'Forest'   },
      { id:'casino',   label:'Casino'   },
      { id:'royal',    label:'Royal'    },
      { id:'neon',     label:'Neon'     },
      { id:'vintage',  label:'Vintage'  },
      { id:'minimal',  label:'Minimal'  },
    ];
    function liarSetWheelStyle(name){
      WHEEL_STYLES.forEach(w => document.body.classList.remove('wheel-style-' + w.id));
      if (name && WHEEL_STYLES.some(w => w.id === name)) {
        document.body.classList.add('wheel-style-' + name);
        try { localStorage.setItem('huddle.liar.wheelStyle', name); } catch(e){}
      } else {
        try { localStorage.removeItem('huddle.liar.wheelStyle'); } catch(e){}
      }
      if (typeof liarLabRenderWheelChips === 'function') liarLabRenderWheelChips();
    }
    (function(){
      try {
        let saved = localStorage.getItem('huddle.liar.wheelStyle');
        // One-time migration: users on the old default ('vintage') get
        // upgraded to the new default ('emerald'). Users who explicitly
        // picked any other style keep their pick.
        if (saved === 'vintage') saved = null;
        liarSetWheelStyle(saved || 'emerald');
      } catch(e){ liarSetWheelStyle('emerald'); }
    })();

    function liarLabRenderWheelChips(){
      const chips = document.getElementById('liar-lab-wheel-chips');
      if (!chips) return;
      const active = (() => {
        for (const w of WHEEL_STYLES) if (document.body.classList.contains('wheel-style-' + w.id)) return w.id;
        return null;
      })();
      chips.innerHTML = WHEEL_STYLES.map(w => {
        const isActive = active === w.id;
        return '<button class="liar-lab-bar-chip ' + (isActive?'active':'') + '" type="button" onclick="liarSetWheelStyle(\'' + w.id + '\')">' + w.label + '</button>';
      }).join('');
    }

    // ============================================================
    // Cross-device sync — phaseStartAt + 6 waiting-animation styles
    // ============================================================
    // Problem this fixes: when one phone writes a phase change (e.g. accuser
    // taps "Liar!"), the writer's device re-renders synchronously while peers
    // wait on the Supabase Realtime broadcast (~200-800ms on phones). All
    // subsequent setTimeout-driven animations (card flips, reveal dwell, cup
    // brace) start on each device's local clock from receipt — so the writer
    // is consistently ahead.
    //
    // Fix: every phase mutation calls liarMarkPhaseStart() which writes
    // phaseStartAt = Date.now() + LIAR_SYNC_BUFFER_MS into state. liarRerender
    // (wrapped further down) defers actual rendering until that wall-clock
    // moment. The buffer is wide enough that the broadcast lands on slow peers
    // BEFORE phaseStartAt, so every device renders the new phase together.
    //
    // The waiting overlay is what fills that ~700ms gap. Six styles are
    // available, picked in the lab bar; the choice is persisted to
    // localStorage so the production game uses whatever the owner selected.
    // Sync buffer choice — research-grounded (see /docs lookup 2026-05).
    //   • Supabase Broadcast P95 = 28–49 ms in their own k6 benchmarks
    //     (https://supabase.com/docs/guides/realtime/benchmarks)
    //   • postgres_changes adds ~100–200 ms (Postgres write + logical
    //     replication + RLS check per subscriber)
    //   • Mobile carrier hop adds ~50–150 ms typical
    //   • Realistic end-to-end P95 on phones ≈ 250–400 ms
    //   • Doherty Threshold (IBM 1982): 400 ms = perceived-instant ceiling for
    //     UI actions, above which users feel lag
    //   • Turn-based multiplayer guidance (ACM Comp Surveys 2022): buffer just
    //     needs to exceed slowest-likely receiver lag — no need for headroom
    //     beyond p95 since p99 stragglers degrade gracefully (render
    //     immediately, no error).
    //
    // 450 ms is the sweet spot: covers ~p95 mobile, sits just above the
    // Doherty ceiling (combined with the button shimmer affordance the
    // perceived feel is "snappy + acknowledged"), and is 36% faster than
    // the earlier conservative 700 ms.
    //
    // Configurable from the lab if testing across slower networks.
    const LIAR_SYNC_BUFFER_CHOICES = [
      { id: 'snappy',  ms: 250, label: '250ms' }, // aggressive — works only on fast LAN/WiFi
      { id: 'default', ms: 450, label: '450ms' }, // RECOMMENDED — covers p95 mobile
      { id: 'safe',    ms: 700, label: '700ms' }, // conservative — slow networks / cross-region
    ];
    function liarSyncBufferMs(){
      try {
        const saved = localStorage.getItem('huddle.liar.syncBuffer');
        const hit = LIAR_SYNC_BUFFER_CHOICES.find(c => c.id === saved);
        if (hit) return hit.ms;
      } catch(e){}
      return 450;
    }
    function liarSetSyncBuffer(id){
      const valid = LIAR_SYNC_BUFFER_CHOICES.find(c => c.id === id);
      try {
        if (valid) localStorage.setItem('huddle.liar.syncBuffer', id);
        else localStorage.removeItem('huddle.liar.syncBuffer');
      } catch(e){}
      if (typeof liarLabRenderSyncBufferChips === 'function') liarLabRenderSyncBufferChips();
    }
    // ============================================================
    // GENERIC CROSS-DEVICE SYNC — works for ANY game with a state row
    // ============================================================
    // To add sync to a NEW game (e.g. a future "Werewolf" mode):
    //   1. Before every persist() at a phase boundary, call:
    //        huddleSyncMarkPhaseStart(yourState, optionalTappedButton)
    //   2. Make your rerender a 3-line wrapper:
    //        const _wPending = {timer:null};
    //        function yourRerender(){
    //          huddleSyncGateRerender(yourState, yourRerenderInner, _wPending);
    //        }
    //   3. That's it. The buffer (450ms default), lab style picker, button
    //      shimmer, migration, and silent overlay all work automatically.
    //
    // The "huddle" prefix marks these as shared across all Huddle games
    // (the app name) — they live above any per-game code.
    function huddleSyncMarkPhaseStart(state, tapTargetEl){
      if (!state) return;
      const bufferMs = liarSyncBufferMs();
      state.phaseStartAt = Date.now() + bufferMs;
      if (tapTargetEl && tapTargetEl.classList) {
        tapTargetEl.classList.add('is-syncing');
        setTimeout(() => { try { tapTargetEl.classList.remove('is-syncing'); } catch(e){} }, bufferMs + 80);
      }
    }
    function huddleSyncDelayMs(state){
      const target = state && state.phaseStartAt;
      if (!target) return 0;
      return Math.max(0, target - Date.now());
    }
    function huddleSyncGateRerender(state, rerenderInnerFn, pendingHolder){
      const delay = huddleSyncDelayMs(state);
      if (delay > 0) {
        liarSyncShow(); // global overlay, no-op when style=silent (the default)
        if (pendingHolder.timer) clearTimeout(pendingHolder.timer);
        pendingHolder.timer = setTimeout(() => {
          pendingHolder.timer = null;
          liarSyncHide();
          rerenderInnerFn();
        }, delay);
        return true;
      }
      if (pendingHolder.timer) { clearTimeout(pendingHolder.timer); pendingHolder.timer = null; }
      liarSyncHide();
      rerenderInnerFn();
      return false;
    }
    // PRODUCTION DEFAULT IS 'silent' — no overlay shown during the 450ms buffer.
    // The previous screen stays visible (Linear/Notion/Instagram pattern: never
    // show a full-screen loading state for an action the user initiated when
    // there's already context on screen). The tapped button gets a press+pulse
    // affordance instead (see .liar-btn-syncing below).
    //
    // The 6 visible animations are kept for the lab so the owner can preview
    // them, but production stays invisible. Devices still sync via the same
    // phaseStartAt mechanism — that math is independent of the visual choice.
    const LIAR_SYNC_STYLES = [
      { id:'silent',  label:'Silent'  }, // DEFAULT — no overlay, button-only feedback
      { id:'dots',    label:'Dots'    }, // iMessage-style triad
      { id:'cards',   label:'Cards'   }, // settling deck — on-theme
      { id:'cup',     label:'Cup'     }, // micro Liar's Cup + sweat drop
      { id:'ring',    label:'Ring'    }, // sonar pulse
      { id:'bar',     label:'Bar'     }, // Material 3 indeterminate bar
      { id:'shuffle', label:'Shuffle' }, // rotating card-fan
    ];

    function liarSetSyncStyle(name){
      LIAR_SYNC_STYLES.forEach(s => document.body.classList.remove('sync-style-' + s.id));
      const valid = LIAR_SYNC_STYLES.some(s => s.id === name);
      const id = valid ? name : 'silent';
      document.body.classList.add('sync-style-' + id);
      try { localStorage.setItem('huddle.liar.syncStyle', id); } catch(e){}
      if (typeof liarLabRenderSyncChips === 'function') liarLabRenderSyncChips();
    }
    // One-shot migration — earlier iterations of this code shipped with a
    // visible default (`dots`) AND the boot IIFE saved that default to
    // localStorage on every load. So every browser that loaded those earlier
    // builds has `huddle.liar.syncStyle = "dots"` cached, and the new
    // `silent` default never takes effect for them.
    //
    // This block clears any stored sync-style preference ONCE per browser,
    // gated by a version key. After the migration runs, the user can pick
    // any style in the lab and it persists normally — the migration won't
    // re-fire.
    (function liarMigrateSyncDefaults(){
      const CURRENT_MIGRATION = '2026-05-silent-default';
      try {
        const seen = localStorage.getItem('huddle.liar.syncStyleMigration');
        if (seen !== CURRENT_MIGRATION) {
          localStorage.removeItem('huddle.liar.syncStyle');
          localStorage.setItem('huddle.liar.syncStyleMigration', CURRENT_MIGRATION);
        }
      } catch(e){}
    })();

    (function(){
      try {
        const saved = localStorage.getItem('huddle.liar.syncStyle');
        liarSetSyncStyle(saved || 'silent');
      } catch(e){ liarSetSyncStyle('silent'); }
    })();

    function liarLabRenderSyncChips(){
      const chips = document.getElementById('liar-lab-sync-chips');
      if (!chips) return;
      const active = (() => {
        for (const s of LIAR_SYNC_STYLES) if (document.body.classList.contains('sync-style-' + s.id)) return s.id;
        return 'silent';
      })();
      chips.innerHTML = LIAR_SYNC_STYLES.map(s => {
        const isActive = active === s.id;
        return '<button class="liar-lab-bar-chip ' + (isActive?'active':'') + '" type="button" onclick="liarSetSyncStyle(\'' + s.id + '\')">' + s.label + '</button>';
      }).join('');
    }

    // Lab control for the cross-device buffer length. Default = 450ms (covers
    // p95 mobile per Supabase Realtime benchmarks). Drop to 250ms on fast
    // LAN/WiFi for max snappiness; raise to 700ms if testing across regions
    // or on poor cell coverage.
    function liarLabRenderSyncBufferChips(){
      const chips = document.getElementById('liar-lab-sync-buffer-chips');
      if (!chips) return;
      let activeId = 'default';
      try {
        const saved = localStorage.getItem('huddle.liar.syncBuffer');
        if (LIAR_SYNC_BUFFER_CHOICES.find(c => c.id === saved)) activeId = saved;
      } catch(e){}
      chips.innerHTML = LIAR_SYNC_BUFFER_CHOICES.map(c => {
        const isActive = activeId === c.id;
        const tag = c.id === 'default' ? ' ✓' : '';
        return '<button class="liar-lab-bar-chip ' + (isActive?'active':'') + '" type="button" onclick="liarSetSyncBuffer(\'' + c.id + '\')">' + c.label + tag + '</button>';
      }).join('');
    }

    // Per-style inner markup for the animation stage. Each one fits inside a
    // 120×80 box so the surrounding card sizing is identical across styles.
    function liarSyncAnimMarkup(){
      const map = {
        dots:    '<span class="liar-sync-dot"></span>',
        cards:   '<div class="liar-sync-card-mini"></div><div class="liar-sync-card-mini"></div><div class="liar-sync-card-mini"></div>',
        cup:     '<div class="liar-sync-cup"><div class="liar-sync-cup-body"></div><div class="liar-sync-cup-fill"></div><div class="liar-sync-cup-drop"></div></div>',
        ring:    '<div class="liar-sync-ring-wave"></div><div class="liar-sync-ring-wave"></div><div class="liar-sync-ring-core"></div>',
        bar:     '<div class="liar-sync-bar-track"><div class="liar-sync-bar-fill"></div></div>',
        shuffle: '<div class="liar-sync-fan"><div class="liar-sync-fan-card"></div><div class="liar-sync-fan-card"></div><div class="liar-sync-fan-card"></div></div>',
      };
      const active = (() => {
        for (const s of LIAR_SYNC_STYLES) if (document.body.classList.contains('sync-style-' + s.id)) return s.id;
        return 'dots';
      })();
      return map[active] || map.dots;
    }

    // Short, phase-aware label so the overlay doesn't feel like a generic
    // spinner. Falls back to a neutral "Syncing players…" if phase is unknown.
    function liarSyncLabelText(){
      if (!liarState) return 'Syncing players…';
      if (liarState.phase === 'cup' && liarState.sipTaken) return 'Spinning the wheel…';
      const map = {
        tablecard: 'Dealing the round…',
        play:      'Starting the round…',
        reveal:    'Revealing the cards…',
        cup:       'Heading to the cup…',
        result:    'Tallying the round…',
      };
      return map[liarState.phase] || 'Syncing players…';
    }

    // Lazily-created overlay container. We don't pre-render it in HTML because
    // (a) it lives at body level so it stacks above everything, and (b) the
    // animation markup is style-dependent and rebuilt on each show.
    function liarSyncEnsureNode(){
      let el = document.getElementById('liar-sync-overlay');
      if (!el) {
        el = document.createElement('div');
        el.id = 'liar-sync-overlay';
        el.className = 'liar-sync-overlay';
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
      }
      return el;
    }
    function liarSyncShow(labelOverride){
      // Silent style: skip the overlay entirely. This is the production default —
      // the user keeps seeing the previous phase's UI while phaseStartAt approaches,
      // exactly like Linear/Notion/Instagram. Sync still happens; nothing flashes.
      if (document.body.classList.contains('sync-style-silent')) return;
      const el = liarSyncEnsureNode();
      const label = labelOverride || liarSyncLabelText();
      el.innerHTML =
        '<div class="liar-sync-card">' +
          '<div class="liar-sync-anim">' + liarSyncAnimMarkup() + '</div>' +
          '<div class="liar-sync-label">' + escapeHTML(label) + '</div>' +
        '</div>';
      el.classList.add('active');
    }
    function liarSyncHide(){
      const el = document.getElementById('liar-sync-overlay');
      if (el) el.classList.remove('active');
    }

    // Lab: preview the currently-selected style for 1.6s so the owner can
    // eyeball it without entering a real game. For 'silent', show a brief
    // confirmation toast-style message instead of nothing (so it's clear the
    // preview button worked, just that the production behaviour is invisible).
    function liarSyncPreview(){
      if (document.body.classList.contains('sync-style-silent')) {
        const el = liarSyncEnsureNode();
        el.innerHTML =
          '<div class="liar-sync-card" style="padding:14px 22px">' +
            '<div class="liar-sync-label" style="margin:0;font-size:13px">' +
              'Silent — no overlay shown in production.<br>' +
              '<span style="opacity:.65;font-weight:500">Devices still sync invisibly.</span>' +
            '</div>' +
          '</div>';
        el.classList.add('active');
        setTimeout(liarSyncHide, 1800);
        return;
      }
      liarSyncShow('Preview — ' + (function(){
        for (const s of LIAR_SYNC_STYLES) if (document.body.classList.contains('sync-style-' + s.id)) return s.label;
        return 'Dots';
      })());
      setTimeout(liarSyncHide, 1600);
    }

    // Called at every phase-boundary mutation, JUST BEFORE liarPersist().
    // Writer sets phaseStartAt = now + buffer; every device (writer + peers)
    // gates their rerender on it, so the new phase lands at the same wall-
    // clock moment everywhere. Phone clock skew (~50ms via NTP) is the only
    // residual drift; well below human-perceptible.
    //
    // Optional `tapTargetEl` — the DOM element the user just tapped to cause
    // this transition. We mark it with .is-syncing so it visibly stays pressed
    // through the silent buffer. Provides button-level feedback in lieu of the
    // (now-suppressed) full-screen overlay.
    // Liar's Cup thin wrappers — delegate to the generic huddleSync* helpers.
    // Kept as-is so existing call sites don't need to be touched.
    function liarMarkPhaseStart(tapTargetEl){
      huddleSyncMarkPhaseStart(liarState, tapTargetEl);
    }
    function liarSyncDelayMs(){
      return huddleSyncDelayMs(liarState);
    }

    function liarLabRenderBackChips(){
      const chips = document.getElementById('liar-lab-back-chips');
      if (!chips) return;
      const active = (() => {
        for (const b of CARD_BACKS) if (document.body.classList.contains('card-back-' + b.id)) return b.id;
        return null;
      })();
      chips.innerHTML = CARD_BACKS.map(b => {
        const isActive = active === b.id;
        return '<button class="liar-lab-bar-chip ' + (isActive?'active':'') + '" type="button" onclick="liarSetCardBack(\'' + b.id + '\')">' + b.label + '</button>';
      }).join('');
    }

    function liarLabRenderStyleChips(){
      const chips = document.getElementById('liar-lab-style-chips');
      if (!chips) return;
      const active = (() => {
        for (const s of CARD_STYLES) if (document.body.classList.contains('card-style-' + s.id)) return s.id;
        return null;
      })();
      chips.innerHTML = CARD_STYLES.map(s => {
        const isActive = active === s.id;
        return '<button class="liar-lab-bar-chip ' + (isActive?'active':'') + '" type="button" onclick="liarSetCardStyle(\'' + s.id + '\')">' + s.label + '</button>';
      }).join('');
    }

    function liarLabRenderBar(){
      const bar = document.getElementById('liar-lab-bar');
      if (!bar) return;
      if (!liarState.labMode) { bar.setAttribute('hidden', ''); return; }
      bar.removeAttribute('hidden');
      const chips = document.getElementById('liar-lab-bar-chips');
      if (chips) {
        const currentTurnPid = liarState.alivePlayers && liarState.alivePlayers[liarState.currentPlayerIdx];
        chips.innerHTML = LIAR_LAB_PLAYERS.map(p => {
          const isMe = liarMe.myId === p.id;
          const isCurrent = currentTurnPid === p.id;
          return '<button class="liar-lab-bar-chip ' + (isMe?'active':'') + ' ' + (isCurrent?'current':'') + '" type="button" onclick="liarLabSetPerspective(\'' + p.id + '\')">' + p.name + '</button>';
        }).join('');
      }
      // Render the wheel-style + sync-style + sync-buffer chip rows.
      liarLabRenderWheelChips();
      liarLabRenderSyncChips();
      liarLabRenderSyncBufferChips();
    }

    // Toggle the screen into "cup mode" — overlay reveal content fades, wheel
    // scales in. Idempotent so calling it on every rerender is safe.
    function liarEnterCupMode(){
      const screen = document.getElementById('screen-liar-play');
      if (screen) screen.classList.add('cup-mode');
      const waiting = document.getElementById('liar-reveal-waiting');
      if (waiting) waiting.style.display = 'none';
      const section = document.getElementById('liar-cup-section');
      if (section) {
        section.setAttribute('aria-hidden', 'false');
        // Force reflow before adding .entering so the transition fires
        // even when the section is freshly visible in the DOM tree.
        if (!section.classList.contains('entering')) {
          void section.offsetWidth;
          section.classList.add('entering');
        }
      }
    }
    function liarExitCupMode(){
      const screen = document.getElementById('screen-liar-play');
      if (screen) screen.classList.remove('cup-mode');
      const section = document.getElementById('liar-cup-section');
      if (section) {
        section.classList.remove('entering');
        section.setAttribute('aria-hidden', 'true');
      }
    }

    // Defensive scrub of all cup-phase visual state. Called by goTo() when
    // the user navigates AWAY from the liar-play screen mid-spin — without
    // this, the wheel's .spinning class + the cached __liarLastAnimatedSipKey
    // can leave a returning user looking at a half-spun wheel that won't
    // re-animate because the renderer skips work when the sip key matches.
    // Re-entering the screen calls liarRerender → liarRenderCupInline, which
    // rebuilds the correct visuals from server truth. Safe to call from any
    // phase: every reset is a no-op if the targeted element doesn't exist
    // or is already in its baseline state.
    function liarResetCupVisuals(){
      try {
        if (typeof liarCancelScheduledSfx === 'function') liarCancelScheduledSfx();
        if (typeof liarClearAutoSip === 'function') liarClearAutoSip();
      } catch(e) {}
      try { __liarLastAnimatedSipKey = null; } catch(e) {}
      const screen = document.getElementById('screen-liar-play');
      if (screen) screen.classList.remove('cup-mode', 'reveal-mode');
      const wheelEl = document.getElementById('liar-wheel');
      if (wheelEl) {
        wheelEl.classList.remove('spinning');
        wheelEl.style.removeProperty('--liar-wheel-target');
      }
      const stamp = document.getElementById('liar-wheel-stamp');
      if (stamp) { stamp.className = 'liar-wheel-stamp'; stamp.textContent = ''; }
      const spotwedge = document.getElementById('liar-wheel-spotwedge');
      if (spotwedge) spotwedge.className = 'liar-wheel-spotwedge';
      const resultEl = document.getElementById('liar-cup-result');
      if (resultEl) resultEl.style.display = 'none';
      const stage = document.getElementById('liar-cup-stage');
      if (stage) stage.className = 'liar-cup-stage liar-wheel-stage';
    }

    // ---------- Lobby ----------
    // Entry paths:
    //   1) First device this session — generates a code, creates the row in Supabase.
    //   2) Same browser, returning visit — uses cached code from localStorage and tries to
    //      load the room from Supabase. If the row was deleted, creates a new room.
    //   3) Different device joining the same room — (future: via URL with ?room=CODE).
    //      For now, the host shares the code/QR verbally and the other device generates
    //      their own — same code only if they share localStorage. Tomorrow: URL-based joins.
    // Builds the public URL that, when opened, drops the visitor straight into this room.
    // Used for the QR code in the lobby and the "share" button.
    function liarJoinUrl(code){
      // Use generic joinUrl so the QR carries ?game=liar — autoOpen IIFE routes off it.
      if (typeof joinUrl === 'function') return joinUrl(code, 'liar');
      const origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
      return origin + '/?room=' + encodeURIComponent(code);
    }

    // Reads ?room=CODE from the URL bar. Used on lobby open so a phone scanning
    // the QR (or pasting the link) joins the SAME room as the host.
    function liarReadUrlRoom(){ return huddleReadUrlRoom('liar'); }

    // Update the browser URL bar so the current room is shareable / bookmarkable.
    // Uses replaceState so we don't create a history entry.
    function liarSyncUrlToRoom(code){ huddleSyncUrlToRoom(code, 'liar'); }

    // ============================================================
