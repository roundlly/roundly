// Huddle app-08-mafia.js (fragment 8/10, split from app.js).
// All fragments share ONE global scope and MUST load in numeric order — do not reorder.

    // ===================== MAFIA (Game #4) ======================
    // ============================================================
    // The cafe-Mafia game with a dedicated narrator.
    // Architecture mirrors Liar's Cup (Supabase Realtime, server-validated
    // RPCs) but with stricter privacy: roles never enter public state.
    // See `huddle_c2_mafia.sql` for the schema + RPC contracts.
    //
    // State naming convention:
    //   • mafiaState — PUBLIC synced state from mafia_rooms.state. Same on
    //     every connected device. NEVER contains roles.
    //   • mafiaMe   — per-device private. sessionId, myId (seat id), myRole
    //     (fetched via RPC after game starts).

    const mafiaState = {
      code: null,
      phase: 'lobby',
      hostId: null,
      narratorUid: null,
      claimedBy: {},
      aliveIds: [],
      deadIds: [],
      round: 0,
      revision: 0,
      closedByHost: false,
      // ephemeral fields populated in later phases (kill/save/vote/etc.) —
      // present here for completeness but not used in Phase 3.
      killTarget: null, saveTarget: null, detectiveTarget: null,
      voteTally: {}, votedBy: {}, beatId: 'lobby',
      winner: null, roleReveal: {},
    };

    const mafiaMe = {
      sessionId: null,
      myId: null,
      myRole: null,
      myTeammates: [],
      bootstrapped: false,   // Phase 2: now uses the shared huddleBootstrap guard
    };

    // ----- Mafia Cards variant flag (Phase 2 stub) -----
    // When true, the lobby is showing the "Mafia Cards" variant — same
    // lobby UI as classic, but the title swaps and Start Game routes to
    // the card-style game placeholder (which Phases 3+ will fill in).
    // Reset to false whenever the classic Mafia tile is opened so the
    // flag doesn't leak across tile entries.
    let mafiaCardsMode = false;

    async function openMafiaCardsLobby(){
      // Reuse the entire classic Mafia lobby plumbing (seat-claim, narrator
      // pick, role-mix, optional roles toggles). Only differences are the
      // header title (dynamic, see mafiaUpdateLobbyTitle) and what happens
      // when the host taps Start Game (see mafiaStartGame branch).
      await openMafiaLobby('cards');
    }

    // Updates the lobby header title between "Mafia" and "Mafia Cards"
    // based on the current variant. Called whenever the lobby renders.
    function mafiaUpdateLobbyTitle(){
      const titleEls = document.querySelectorAll('#screen-mafia-lobby .header-title');
      const key = mafiaCardsMode ? 'games.mafiaCards' : 'games.mafia';
      titleEls.forEach(el => {
        el.setAttribute('data-i18n', key);
        el.textContent = t(key);
      });
    }

    // ----- Session / auth bootstrap -----
    // Anonymous Supabase auth gives us a stable uuid across reloads so the
    // user's seat survives refresh. If Supabase fails to load (offline / CDN
    // blocked), fall back to a per-tab random id — local-only mode.
    function mafiaGetSessionId(){ return huddleGetSessionId(mafiaMe); }
    async function mafiaBootstrap(){ return huddleBootstrap(mafiaMe, 'Mafia'); }

    // ----- Transport: load room state by code -----
    // Timestamp of the most recent successful mafiaLoadRoom. Used by the
    // realtime SUBSCRIBED callback to skip the reconcile-snapshot fetch
    // when the snapshot we already have is fresh — the original code path
    // unconditionally fired a second mafiaLoadRoom ~300-500ms after entry,
    // costing an extra round-trip per Mafia lobby open. The debounce
    // window (1500ms) is wide enough to cover the typical subscribe
    // round-trip but tight enough that any genuinely-needed reconcile
    // (e.g. user backgrounded the tab for a while) still runs.
    let __mafiaLastLoadTs = 0;
    async function mafiaLoadRoom(code){
      if (!code) return false;
      if (!(window.sb && window.sb.from)) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { data, error } = await window.sb
            .from('mafia_rooms').select('state').eq('code', code).maybeSingle();
          if (error) {
            console.warn('[Mafia] mafiaLoadRoom error (attempt ' + (attempt+1) + '):', error.message || error);
            if (attempt < 1) { await new Promise(r => setTimeout(r, 400)); continue; }
            return false;
          }
          if (!data || !data.state) return false;
          Object.assign(mafiaState, data.state);
          __mafiaLastLoadTs = Date.now();
          return true;
        } catch(e){
          console.warn('[Mafia] mafiaLoadRoom exception:', e);
          if (attempt < 1) { await new Promise(r => setTimeout(r, 400)); continue; }
          return false;
        }
      }
      return false;
    }

    // ----- Transport: subscribe to room updates via Realtime -----
    // ───── Presence tracking (Phase 2b) ─────────────────────────────────
    // Same pattern as Chameleon/Hot Seat — 60s grace timer covers refresh
    // and brief app-switches; after grace, the NARRATOR fires the cleanup
    // RPC (huddle_mafia_handle_disconnect requires narrator-or-self authz).
    // The function expects the gone player's SEAT KEY (e.g. 'p3'), not a
    // session UUID, so we look it up from claimedBy before the call.
    let _mafiaPresentSessions = new Set();
    let _mafiaLeaveGraceTimers = new Map();
    const MAFIA_LEAVE_GRACE_MS = 60000;

    function mafiaIsSessionPresent(sid){
      return !!(sid && _mafiaPresentSessions.has(sid));
    }
    function mafiaConfirmUserGone(sessionId){
      _mafiaPresentSessions.delete(sessionId);
      _mafiaLeaveGraceTimers.delete(sessionId);

      // Find the seat key occupied by the gone session (if any — narrator
      // may not be in claimedBy).
      let goneSeatId = null;
      Object.keys(mafiaState.claimedBy || {}).forEach(pid => {
        if (mafiaState.claimedBy[pid] === sessionId) goneSeatId = pid;
      });

      // No seat AND not narrator → nothing to clean up server-side, just refresh.
      const wasNarrator = mafiaState.narratorUid === sessionId;
      if (!goneSeatId && !wasNarrator) {
        if (typeof mafiaRerender === 'function') mafiaRerender();
        return;
      }

      // Only the narrator's client can fire the cleanup RPC (the server-side
      // function's authz rejects everyone else). If I'm not the narrator,
      // just refresh local view; the actual seat removal happens when the
      // narrator's client confirms the disconnect on their end.
      const mySid = mafiaGetSessionId();
      const iAmNarrator = !!(mySid && mafiaState.narratorUid === mySid);
      if (!iAmNarrator) {
        if (typeof mafiaRerender === 'function') mafiaRerender();
        return;
      }

      // Narrator firing cleanup. Only seats (not narrator itself) can be
      // removed via this RPC — the narrator slot has separate handling.
      if (!goneSeatId) {
        if (typeof mafiaRerender === 'function') mafiaRerender();
        return;
      }
      // Mid-game we NEVER auto-eliminate a dropped player. The narrator is the
      // source of truth at the table and decides whether to wait for them or
      // mark them out by hand. A disconnect mid-game just surfaces as an "away"
      // badge on the narrator dashboard (derived from presence in
      // mafiaCardsRenderNarrator). Only in the LOBBY do we free the seat via
      // the RPC so it reopens for someone else. (db/fix/02 also hardens the
      // server so the RPC can't end a game on disconnect even if it is called.)
      const inLobby = !mafiaState.phase || mafiaState.phase === 'lobby';
      if (!inLobby) {
        if (typeof mafiaRerender === 'function') mafiaRerender();
        return;
      }
      Promise.resolve(huddleCallRPC('huddle_mafia_handle_disconnect', {
        p_code: mafiaState.code,
        p_player_id: goneSeatId,
      })).catch(e => console.warn('[Mafia] handle_disconnect failed:', e && e.message));
    }
    function mafiaStartLeaveGrace(sessionId){ huddleStartLeaveGrace(_mafiaLeaveGraceTimers, sessionId, MAFIA_LEAVE_GRACE_MS, mafiaConfirmUserGone); }
    function mafiaCancelLeaveGrace(sessionId){ huddleCancelLeaveGrace(_mafiaLeaveGraceTimers, sessionId); }
    function mafiaResetPresenceState(){ huddleResetPresenceState(_mafiaLeaveGraceTimers, _mafiaPresentSessions); }

    let mafiaSyncChannel = null;
    let _mafiaChannelCode = null;
    let _mafiaChannelSessionId = null;
    function mafiaWireSync(){
      if (!mafiaState.code) return;
      if (!(window.sb && window.sb.channel)) return;
      const mySid = mafiaGetSessionId();
      // Tear down any prior subscription before re-wiring.
      if (mafiaSyncChannel) {
        try { mafiaSyncChannel.untrack(); } catch(e){}
        try { window.sb.removeChannel(mafiaSyncChannel); } catch(e){}
        mafiaSyncChannel = null;
        _mafiaChannelCode = null;
        _mafiaChannelSessionId = null;
        mafiaResetPresenceState();
      }
      const code = mafiaState.code;

      // Presence-event handlers (mirror Chameleon's). Key = session UUID so
      // refresh-rejoin appears as the same key and naturally cancels grace.
      const onPresenceSync = () => {
        const presState = mafiaSyncChannel.presenceState();
        const fresh = new Set(Object.keys(presState || {}));
        fresh.forEach(sid => {
          if (_mafiaLeaveGraceTimers.has(sid)) mafiaCancelLeaveGrace(sid);
        });
        _mafiaPresentSessions = fresh;
        if (typeof mafiaRerender === 'function') mafiaRerender();
      };
      const onPresenceJoin = ({ key }) => {
        if (!key) return;
        _mafiaPresentSessions.add(key);
        mafiaCancelLeaveGrace(key);
      };
      const onPresenceLeave = ({ key }) => {
        if (!key) return;
        mafiaStartLeaveGrace(key);
      };

      _mafiaChannelCode = code;
      _mafiaChannelSessionId = mySid;
      mafiaSyncChannel = window.sb
        .channel('mafia_room:' + code, { config: { presence: { key: mySid || ('tab_' + Math.random()) } } })
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'mafia_rooms',
          filter: 'code=eq.' + code,
        }, (payload) => {
          if (payload && payload.new && payload.new.state) {
            const incomingRev = payload.new.state.revision || 0;
            if (incomingRev >= (mafiaState.revision || 0)) {
              // Detect a player leaving (explicit Leave or disconnect) so the
              // narrator/players get a "{name} left" notice — parity with the
              // other games. Narrator-driven flow, so no auto-return-to-lobby.
              const _prevClaimedBy = Object.assign({}, mafiaState.claimedBy || {});
              const _mySidNow = mafiaGetSessionId();
              Object.assign(mafiaState, payload.new.state);
              try {
                if (mafiaMe.myId) {
                  const _newClaimedBy = mafiaState.claimedBy || {};
                  const _goneSeats = Object.keys(_prevClaimedBy).filter(pid =>
                    _prevClaimedBy[pid] && !_newClaimedBy[pid] && _prevClaimedBy[pid] !== _mySidNow);
                  if (_goneSeats.length && typeof showLobbyToast === 'function') {
                    // Resolve the leaver's name from their session id via the
                    // claimant-profile cache (how Mafia shows names everywhere).
                    const _goneSid = _prevClaimedBy[_goneSeats[0]];
                    let nm; try { const _prof = (typeof profileForClaim === 'function') ? profileForClaim(_goneSid) : null; if (_prof && typeof claimDisplayName === 'function') nm = claimDisplayName(_prof, ''); } catch(e){}
                    showLobbyToast(t('mafia.toastPlayerLeft', { name: nm || ((typeof t === 'function' && t('common.otherPlayer')) || 'Player') }), 3500);
                  }
                }
              } catch(e){}
              mafiaRerender();
            }
          }
        })
        .on('presence', { event: 'sync'  }, onPresenceSync)
        .on('presence', { event: 'join'  }, onPresenceJoin)
        .on('presence', { event: 'leave' }, onPresenceLeave)
        .subscribe(async (status) => {
          if (status !== 'SUBSCRIBED' || _mafiaChannelCode !== code) return;
          // Announce our presence the moment we're subscribed
          try {
            await mafiaSyncChannel.track({
              user_id: mySid,
              joined_at: Date.now(),
            });
          } catch(e){}
          // Reconcile after SUBSCRIBED to catch updates that landed during the
          // gap between initial fetch and subscription becoming live.
          // DEBOUNCED — if mafiaLoadRoom just ran (<1.5s ago) the snapshot
          // is already fresh and the realtime channel will deliver anything
          // newer than that. Skipping the redundant fetch saves a full
          // network round-trip on every Mafia lobby entry.
          if (mafiaState.code) {
            const sinceLastLoad = Date.now() - __mafiaLastLoadTs;
            if (sinceLastLoad < 1500) return;
            mafiaLoadRoom(mafiaState.code).then(loaded => { if (loaded) mafiaRerender(); });
          }
        });
    }

    // ----- Create fresh room (via universal RPC) -----
    async function mafiaStateReset(code){
      const sid = mafiaGetSessionId();
      // First-claimant key: 'p1'. Other seats fill as 'p2'…'p8'.
      const firstSeat = 'p1';
      Object.keys(mafiaState).forEach(k => delete mafiaState[k]);
      Object.assign(mafiaState, {
        code: code,
        phase: 'lobby',
        hostId: sid,
        narratorUid: null,
        claimedBy: { [firstSeat]: sid },
        aliveIds: [],
        deadIds: [],
        round: 0,
        killTarget: null, saveTarget: null, detectiveTarget: null,
        voteTally: {}, votedBy: {},
        beatId: 'lobby',
        winner: null, roleReveal: {},
        closedByHost: false,
        revision: 1,
      });
      mafiaMe.myId = firstSeat;
      const snapshot = JSON.parse(JSON.stringify(mafiaState));
      try {
        await huddleCallRPC('huddle_create_room', {
          p_table: 'mafia_rooms',
          p_code: code,
          p_initial_state: snapshot,
        });
      } catch(e){
        console.warn('[Mafia] create_room RPC failed:', e && e.message);
      }
      try { huddlePersistLastRoom('mafia',code); } catch(e){}
    }

    // ----- URL helpers -----
    function mafiaJoinUrl(code){
      if (typeof joinUrl === 'function') return joinUrl(code, 'mafia');
      const origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
      return origin + '/?room=' + encodeURIComponent(code) + '&game=mafia';
    }
    function mafiaReadUrlRoom(){ return huddleReadUrlRoom('mafia'); }
    function mafiaSyncUrlToRoom(code){ huddleSyncUrlToRoom(code, 'mafia'); }
    function mafiaFindRecentRoomCode(){
      try { return huddleReadLastRoom('mafia'); }
      catch(e){ return null; }
    }
    function handleMafiaQrError(){
      const fb = document.getElementById('mafia-room-qr-fallback');
      if (fb) fb.classList.add('show');
    }

    // ----- Role mix lookup (must match huddle_mafia_start_game in SQL) -----
    // Detective reinstated; minimum lowered from 6 → 5. Mirror of the SQL table
    // in huddle_c2_mafia_detective_return.sql.
    // The optional flags are consulted by Mafia Cards mode — when the host
    // toggles any of them, the role queue is adjusted slot-for-slot so the
    // total still equals player_count. Classic Mafia passes only includeDetective.
    //   includeDetective: OFF → Detective slot becomes an extra Villager.
    //   includeChild:     ON  → steals ONE Villager slot (Child plays as Villager
    //                           but takes one player with them when they die).
    //   includeLeader:    ON  → steals ONE Mafia slot (Godfather — appears
    //                           innocent to the Detective; still on Mafia team).
    // Mirror of the SQL in huddle_c2_mafia_optional_roles_v2.sql — keep these
    // two formulas identical or the server will reject with role_count_mismatch.
    function mafiaRoleMixFor(playerCount, includeDetective, includeChild, includeLeader){
      if (includeDetective === undefined) includeDetective = true;
      includeChild  = !!includeChild;
      includeLeader = !!includeLeader;
      const det = includeDetective ? 1 : 0;
      let mafia, villager;
      if      (playerCount === 5) { mafia = 1; villager = 2; }
      else if (playerCount === 6) { mafia = 1; villager = 3; }
      else if (playerCount === 7) { mafia = 2; villager = 3; }
      else if (playerCount === 8) { mafia = 2; villager = 4; }
      else return null;
      if (!includeDetective) villager += 1;
      const leader = (includeLeader && mafia > 0) ? 1 : 0;
      if (leader) mafia -= 1;
      const child = (includeChild && villager > 0) ? 1 : 0;
      if (child) villager -= 1;
      return { mafia, mafia_leader: leader, detective: det, doctor: 1, child, villager };
    }

    // ----- Computed helpers -----
    function mafiaPlayerSeats(){
      // Player seats = claimedBy keys whose value !== narratorUid.
      const narr = mafiaState.narratorUid;
      const out = [];
      Object.entries(mafiaState.claimedBy || {}).forEach(([seatId, uid]) => {
        if (!narr || uid !== narr) out.push(seatId);
      });
      // Stable order: by seat id (p1, p2, ...).
      out.sort();
      return out;
    }
    function mafiaSeatNameFor(seatId){
      // Try the real claimant's profile first. The profile cache is fed
      // by ensureClaimantProfiles() — see mafiaPrimeClaimantProfiles().
      const uid = mafiaState.claimedBy && mafiaState.claimedBy[seatId];
      if (uid) {
        const profile = profileForClaim(uid);
        if (profile) {
          const name = claimDisplayName(profile, null);
          if (name) return name;
        }
      }
      // Fallback: "Player N" — used in the test lab (where seat UIDs are
      // synthetic 'lab_p1' strings, not real auth.uid values) and during
      // the brief window before the profiles cache lands for a real room.
      const n = parseInt(seatId.replace(/^p/, ''), 10);
      return t('mafia.playerN', { n: isNaN(n) ? '?' : n });
    }

    // Kick a profile fetch for every claimant in the current room. Called
    // from the narrator dashboard + role card renders so the cache is
    // populated quickly; ensureClaimantProfiles re-renders when data lands.
    function mafiaPrimeClaimantProfiles(){
      if (typeof ensureClaimantProfiles !== 'function') return;
      const uids = mafiaState.claimedBy ? Object.values(mafiaState.claimedBy) : [];
      ensureClaimantProfiles(uids, mafiaRerender);
    }

    async function openMafiaLobby(variant){
      // Drop any seat we still hold in OTHER game lobbies before claiming
      // one here — invariant: one user, one seat across all games.
      try { huddleLeaveOtherGameSeats('mafia'); } catch(e){}
      // Mafia is now Cards-only (the classic server-driven flow was removed).
      // The variant argument is kept for backwards compat with old callers,
      // but mafiaCardsMode is FORCED true regardless so no caller (URL room,
      // realtime sync, etc.) can accidentally route to the deleted classic
      // game screens.
      mafiaCardsMode = true;
      // Priority: ?room= in URL → cached lastRoom → fresh room.
      const urlRoom = mafiaReadUrlRoom();
      const existingCode = urlRoom || mafiaFindRecentRoomCode();

      const authPromise = mafiaBootstrap();
      const loadPromise = existingCode ? mafiaLoadRoom(existingCode) : Promise.resolve(false);
      await authPromise;
      const sessionId = mafiaGetSessionId();
      const loaded = await loadPromise;

      if (urlRoom && !loaded) {
        try { history.replaceState(history.state, '', '/'); } catch(e){}
        if (typeof showLobbyToast === 'function') {
          try { showLobbyToast(t('lobby.joinFailed')); } catch(e){}
        }
        goTo('games');
        return;
      }

      let cachedRoomGone = !!existingCode && !loaded;

      if (loaded) {
        const claimed = Object.entries(mafiaState.claimedBy || {}).find(([pid, sid]) => sid === sessionId);
        mafiaMe.myId = claimed ? claimed[0] : null;
        if (mafiaMe.myId) {
          try { huddlePersistLastRoom('mafia',existingCode); } catch(e){}
        } else if (urlRoom) {
          try { huddlePersistLastRoom('mafia',existingCode); } catch(e){}
        } else {
          try { huddleClearLastRoom('mafia'); } catch(e){}
          await mafiaStateReset(generateCode());
          cachedRoomGone = true;
        }
        // Reconnect-stale check: if mid-game and we have no seat, bounce.
        const inGamePhase = mafiaState.phase && mafiaState.phase !== 'lobby' && mafiaState.phase !== 'end';
        if (inGamePhase && !mafiaMe.myId && mafiaState.narratorUid !== sessionId) {
          if (typeof showLobbyToast === 'function') {
            try { showLobbyToast(t('mafia.toastReconnectStale'), 4500); } catch(e){}
          }
          goTo('games');
          return;
        }
      } else {
        await mafiaStateReset(generateCode());
      }

      mafiaWireSync();
      await mafiaAutoClaimIfNeeded();
      mafiaSyncUrlToRoom(mafiaState.code);

      // Pre-prime claimant profiles BEFORE the screen flips, not after the
      // first render. The previous flow called mafiaPrimeClaimantProfiles
      // from inside mafiaRenderLobby() (the very first render), which meant
      // the user saw "Player 1 / Player 2" placeholders for 100-400ms while
      // the profile batch fetch was in flight, then a re-render with real
      // names. Kicking the fetch off here moves that latency in parallel
      // with the screen paint — by the time mafiaRerender() runs below,
      // profiles are often already cached and the first render shows real
      // names. If they're not cached, the in-flight promise resolves moments
      // later and triggers the same re-render (no regression). Fire-and-
      // forget — don't await, we don't want to block the screen flip.
      mafiaPrimeClaimantProfiles();

      goTo('mafia-lobby');
      document.getElementById('mafia-room-code').textContent = mafiaState.code;
      const fb = document.getElementById('mafia-room-qr-fallback');
      if (fb) fb.classList.remove('show');
      if (typeof setRoomQrSrc === 'function' && typeof qrUrl === 'function') {
        setRoomQrSrc(document.getElementById('mafia-room-qr'), qrUrl(mafiaJoinUrl(mafiaState.code)));
      }

      mafiaUpdateHowToTrigger();
      mafiaRerender();

      if (cachedRoomGone && typeof showLobbyToast === 'function') {
        try { showLobbyToast(t('lobby.previousRoomGone')); } catch(e){}
      }
    }

    async function mafiaAutoClaimIfNeeded(){
      const sid = mafiaGetSessionId();
      if (!sid) return;
      // Already claimed? Done.
      const existingSeat = Object.entries(mafiaState.claimedBy || {}).find(([pid, s]) => s === sid);
      if (existingSeat) {
        mafiaMe.myId = existingSeat[0];
        return;
      }
      // Find lowest free seat id from p1..p8.
      for (let n = 1; n <= 8; n++) {
        const seatId = 'p' + n;
        if (!mafiaState.claimedBy[seatId]) {
          try {
            const newState = await huddleCallRPC('huddle_claim_seat', {
              p_table: 'mafia_rooms',
              p_code: mafiaState.code,
              p_player_id: seatId,
            });
            if (newState) {
              Object.assign(mafiaState, newState);
              mafiaMe.myId = seatId;
            }
          } catch(e){
            console.warn('[Mafia] auto-claim failed:', e && e.message);
          }
          return;
        }
      }
    }

    // ----- Render dispatcher -----
    // Decides which screen to be on based on (phase, my-role, alive/dead),
    // navigates if needed, then re-renders that screen's content. Called on
    // every Realtime state change AND when the user takes a local action.
    function mafiaCurrentScreen(){
      const s = document.querySelector('.screen.active');
      if (!s) return null;
      const id = s.id || '';
      if (!id.startsWith('screen-mafia-')) return null;
      return id.replace('screen-', '');
    }
    function mafiaIsOnMafiaScreen(){ return !!mafiaCurrentScreen(); }

    function mafiaRerender(){
      // Only dispatch while a Mafia screen is active — otherwise the user
      // navigated away (e.g. tapped back) and we shouldn't re-route them.
      if (!mafiaIsOnMafiaScreen()) return;
      // Track lobby → active transitions so the narrator dashboard knows
      // whether this tab was present when the game started. If we missed
      // the transition (tab closed/refreshed mid-game), the narrator-side
      // local dashboard state is lost and the renderer shows a clear
      // "Game ended" overlay instead of a misleading empty dashboard.
      mafiaCardsTrackPhase();
      // Sync the local Cards-mode flag from room state. The host sets it
      // when they tap the Mafia Cards tile (local true), AND the server
      // writes state.variant='cards' on start_game (so friends sync it
      // via realtime). Once either signal is true for this room, every
      // render here picks it up. Reset on lobby return (variant absent).
      // Mafia is Cards-only — force the flag regardless of stored state.
      mafiaCardsMode = true;

      const sid = mafiaGetSessionId();
      const isNarrator = !!(mafiaState.narratorUid && mafiaState.narratorUid === sid);
      const phase = mafiaState.phase || 'lobby';

      // Mafia is Cards-only. Three routes:
      //   lobby phase   → shared mafia-lobby screen
      //   narrator      → narrator dashboard (cheat sheet + script)
      //   other players → secret role card
      if (phase === 'lobby') {
        if (mafiaCurrentScreen() !== 'mafia-lobby') goTo('mafia-lobby');
        mafiaRenderLobby();
        return;
      }
      if (isNarrator) {
        if (mafiaCurrentScreen() !== 'mafia-cards-game') goTo('mafia-cards-game');
        if (!mafiaMe.narratorRoles) mafiaFetchNarratorState();
        mafiaCardsRenderNarrator();
        return;
      }
      if (mafiaCurrentScreen() !== 'mafia-cards-role') goTo('mafia-cards-role');
      mafiaCardsRenderRole();
    }


    // ----- Fetch & cache my role -----
    // Called once after game starts (mafiaCardsRenderRole schedules it on
    // first paint if mafiaMe.myRole is null). Survives refresh because the
    // RPC re-derives from the server-side roles table.
    let _mafiaRoleFetchPromise = null;
    async function mafiaFetchMyRole(force){
      if (mafiaMe.myRole && !force) return mafiaMe.myRole;
      if (_mafiaRoleFetchPromise) return _mafiaRoleFetchPromise;
      _mafiaRoleFetchPromise = (async () => {
        try {
          const result = await huddleCallRPC('huddle_mafia_get_my_role', {
            p_code: mafiaState.code,
          });
          // RPC contract (from huddle_c2_mafia.sql):
          //   { role: 'mafia'|'detective'|'doctor'|'villager',
          //     teammates: ['p3','p7'] }   // only populated for mafia
          if (result && result.role) {
            mafiaMe.myRole = result.role;
            mafiaMe.myTeammates = Array.isArray(result.teammates) ? result.teammates : [];
            // Re-dispatch through mafiaRerender so the dispatcher routes
            // to mafiaCardsRenderRole with the freshly-cached role.
            mafiaRerender();
          } else {
            // No role for this caller — likely they're the narrator or not seated.
            mafiaMe.myRole = null;
          }
        } catch(e){
          console.warn('[Mafia] get_my_role failed:', e && e.message);
        } finally {
          _mafiaRoleFetchPromise = null;
        }
        return mafiaMe.myRole;
      })();
      return _mafiaRoleFetchPromise;
    }

    // ----- Render: role card (Phase 4 primary screen for non-narrator players) -----
    let _mafiaRoleHidden = false;
    // ===== Mafia Cards — narrator dashboard (Phase 4) ====================
    // Local-only state. Reset when a new Mafia Cards game starts (see
    // mafiaStartGame). Never written to SQL — the narrator IS the source
    // of truth at the table.
    let mafiaCardsLocalPhase = 'night';            // 'night' | 'day'
    const mafiaCardsDeadPlayers = new Set();       // seatIds marked dead by narrator

    // True once THIS tab observed the game transition from lobby → active
    // (either because the user started the game here, or because realtime
    // delivered the transition while the tab was open). If a narrator
    // closes the tab and reopens — or refreshes mid-game — we miss the
    // transition, flag stays false, and the "Game ended" overlay surfaces
    // instead of a lying empty-dashboard. The local dashboard state (phase
    // pill, dead set) is in-memory only by design, per owner direction.
    let _mafiaCardsGameOwnedInThisTab = false;
    let _mafiaCardsPrevPhase = null;
    function mafiaCardsTrackPhase(){
      const cur = (typeof mafiaState !== 'undefined' && mafiaState && mafiaState.phase) ? mafiaState.phase : 'lobby';
      // Observed transition out of lobby → we are present for this game.
      if (_mafiaCardsPrevPhase === 'lobby' && cur !== 'lobby') {
        _mafiaCardsGameOwnedInThisTab = true;
      }
      // Back to lobby (new round or End game) → clear so the next round
      // starts fresh without a stale "ended" overlay if narrator refreshes
      // before tapping Start.
      if (cur === 'lobby') _mafiaCardsGameOwnedInThisTab = false;
      _mafiaCardsPrevPhase = cur;
    }

    function mafiaCardsResetNarratorLocalState(){
      mafiaCardsLocalPhase = 'night';
      mafiaCardsDeadPlayers.clear();
      // Reset every player's local reveal state too — a new game means
      // their role is hidden again until they tap Reveal Role.
      mafiaCardsRoleRevealed = false;
      // Reset round-progress signal so the script panel defaults back to
      // "opening expanded, every-round collapsed" for the new game.
      mafiaCardsHasSeenDay = false;
    }

    function mafiaCardsTogglePhase(){
      mafiaCardsLocalPhase = (mafiaCardsLocalPhase === 'night') ? 'day' : 'night';
      // The first time the narrator flips to Day, we know the opening
      // night is done. Used by the script render to auto-collapse the
      // "READ ONCE" section and auto-expand the "EVERY ROUND" sections.
      if (mafiaCardsLocalPhase === 'day') mafiaCardsHasSeenDay = true;
      mafiaCardsRenderNarrator();
    }

    function mafiaCardsToggleDead(seatId){
      if (!seatId) return;
      if (mafiaCardsDeadPlayers.has(seatId)) {
        mafiaCardsDeadPlayers.delete(seatId);
      } else {
        mafiaCardsDeadPlayers.add(seatId);
      }
      mafiaCardsRenderNarrator();
    }

    async function mafiaCardsEndGame(){
      if (!confirm(t('mafiaCards.narrator.endGameConfirm'))) return;
      // Reset the narrator's local dashboard state immediately (phase pill,
      // dead set, round progress). These are client-only so we can do them
      // before/regardless of the server call.
      mafiaCardsResetNarratorLocalState();
      // Clear the narrator's role-map cache so the next start_game re-fetches.
      mafiaMe.narratorRoles = null;
      mafiaMe.myRole = null;
      mafiaMe.myTeammates = [];
      // Call the server reset so every connected phone (players + narrator)
      // hears about the lobby reset via realtime and routes back together.
      try {
        const newState = await huddleCallRPC('huddle_mafia_reset_to_lobby', {
          p_code: mafiaState.code,
        });
        if (newState) Object.assign(mafiaState, newState);
      } catch(e){
        // If the RPC fails we still want the narrator to leave the dashboard.
        // Log and fall through — local state is already reset.
        console.warn('[Mafia] reset_to_lobby failed:', e && e.message);
      }
      mafiaRerender();
    }

    // Reference-script content. Each section is a NESTED collapsible inside
    // the "What do I say?" panel, with a "kind" label (READ ONCE / EVERY
    // ROUND / ENDGAME) prominently displayed so the narrator can see at a
    // glance which lines are one-time vs repeating. Defaults to open in
    // round 1 (opening) or after round 1 (every-round + endgame) — see
    // mafiaCardsHasSeenDay for the round-progress signal.
    const MAFIA_CARDS_SCRIPT = [
      {
        id: 'opening',
        titleKey: 'mafiaCards.script.openingTitle',
        kindKey: 'mafiaCards.script.kindOnce',
        defaultOpenWhen: 'round1',
        lines: [
          { key: 'mafia.script.opening.night1Open.text' },
          { key: 'mafia.script.opening.night1MafiaMeet.text' },
          { key: 'mafia.script.opening.night1MafiaSleep.text' },
          { key: 'mafia.script.opening.day0Morning.text' },
        ],
      },
      {
        id: 'round-loop',
        titleKey: 'mafiaCards.script.roundLoopTitle',
        kindKey: 'mafiaCards.script.kindEveryRound',
        defaultOpenWhen: 'afterRound1',
        lines: [
          { type: 'subheading', textKey: 'mafiaCards.script.subNight' },
          { key: 'mafia.script.middle.nightOpen.text' },
          { key: 'mafia.script.middle.mafiaWake.text' },
          { key: 'mafia.script.middle.mafiaSleep.text' },
          { key: 'mafia.script.middle.detectiveWake.text', hintKey: 'mafiaCards.script.detectiveHint', requiresRole: 'detective' },
          { key: 'mafia.script.middle.leaderHint.text',     requiresRole: 'mafiaLeader' },
          { key: 'mafia.script.middle.detectiveSleep.text', requiresRole: 'detective' },
          { key: 'mafia.script.middle.doctorWake.text' },
          { key: 'mafia.script.middle.doctorSleep.text' },
          { key: 'mafia.script.middle.childNightDeath.text', requiresRole: 'child' },
          { type: 'subheading', textKey: 'mafiaCards.script.subDay' },
          { key: 'mafia.script.middle.dayReveal.text', hintKey: 'mafiaCards.script.dayRevealHint' },
          { key: 'mafia.script.middle.dayDiscuss.text' },
          { key: 'mafiaCards.script.voteCardsLine' },
          { key: 'mafia.script.middle.childVoteDeath.text', requiresRole: 'child' },
        ],
      },
      {
        id: 'endgame',
        titleKey: 'mafiaCards.script.endgameTitle',
        kindKey: 'mafiaCards.script.kindEndgame',
        defaultOpenWhen: 'never',
        lines: [
          { key: 'mafiaCards.script.endgameTownWins' },
          { key: 'mafiaCards.script.endgameMafiaWins' },
        ],
      },
    ];

    // Narrator-only rules — three focused rules with detailed explanations.
    // bodyKey can include <strong> tags for emphasis on key phrases.
    const MAFIA_CARDS_NARRATOR_RULES = [
      { titleKey: 'mafiaCards.rules.r1.title', bodyKey: 'mafiaCards.rules.r1.body' },
      { titleKey: 'mafiaCards.rules.r2.title', bodyKey: 'mafiaCards.rules.r2.body' },
      { titleKey: 'mafiaCards.rules.r3.title', bodyKey: 'mafiaCards.rules.r3.body' },
    ];

    // Tracks whether the narrator has flipped to Day at least once. Used to
    // decide default open/closed state for script subsections: round 1 →
    // opening expanded; round 2+ → every-round sections expanded, opening
    // collapsed. Reset on every new game start.
    let mafiaCardsHasSeenDay = false;

    function mafiaCardsRenderRules(){
      const list = document.getElementById('mafia-cards-rules-list');
      if (!list) return;
      list.innerHTML = MAFIA_CARDS_NARRATOR_RULES.map(r =>
        '<li class="mafia-cards-rules-item">'
          + '<div class="mafia-cards-rules-item-title">' + t(r.titleKey) + '</div>'
          + '<div class="mafia-cards-rules-item-body">' + t(r.bodyKey) + '</div>'
        + '</li>'
      ).join('');
    }

    function mafiaCardsRenderScript(){
      const body = document.getElementById('mafia-cards-script-body');
      if (!body) return;
      const detectiveActive = mafiaIsDetectiveActive();
      const childActive     = mafiaIsChildActive();
      const leaderActive    = mafiaIsLeaderActive();
      // Subheading lines always pass; cue lines are filtered by requiresRole.
      const lineActive = (line) => {
        if (line.type === 'subheading') return true;
        if (line.requiresRole === 'detective')  return detectiveActive;
        if (line.requiresRole === 'child')      return childActive;
        if (line.requiresRole === 'mafiaLeader')return leaderActive;
        return true;
      };
      // Decide default open state: opening is auto-collapsed once Day has
      // been triggered at least once; every-round sections auto-open at
      // that point. Narrator can manually override either way.
      const inRound1 = !mafiaCardsHasSeenDay;
      const shouldOpen = (section) => {
        if (section.defaultOpenWhen === 'round1') return inRound1;
        if (section.defaultOpenWhen === 'afterRound1') return !inRound1;
        return false; // 'never' = always collapsed by default
      };
      const renderLine = (line) => {
        if (line.type === 'subheading') {
          return '<div class="mafia-cards-script-subheading">' + t(line.textKey) + '</div>';
        }
        return '<div class="mafia-cards-script-line">'
          + t(line.key)
          + (line.hintKey ? '<em>' + t(line.hintKey) + '</em>' : '')
        + '</div>';
      };
      body.innerHTML = MAFIA_CARDS_SCRIPT.map(section => {
        const activeLines = section.lines.filter(lineActive);
        // If everything left is just subheadings (no real cues), skip the
        // section entirely. Otherwise render.
        const hasRealCues = activeLines.some(l => l.type !== 'subheading');
        if (!hasRealCues) return '';
        const openAttr = shouldOpen(section) ? ' open' : '';
        return '<details class="mafia-cards-script-section"' + openAttr + '>'
          + '<summary class="mafia-cards-script-section-summary">'
          +   '<span class="mafia-cards-script-section-kind">' + t(section.kindKey) + '</span>'
          +   '<span class="mafia-cards-script-section-title">' + t(section.titleKey) + '</span>'
          +   '<span class="mafia-cards-script-section-chevron" aria-hidden="true">▾</span>'
          + '</summary>'
          + '<div class="mafia-cards-script-section-lines">'
          +   activeLines.map(renderLine).join('')
          + '</div>'
        + '</details>';
      }).join('');
    }

    function mafiaCardsRenderNarrator(){
      // "Game ended" guard — if this tab missed the lobby → active
      // transition, the in-memory dashboard state (phase pill, dead set,
      // round progress) is gone. Show the ended overlay and hide the
      // dashboard panels so the narrator doesn't act on stale defaults.
      // The End game button stays visible — it's the only way out.
      const endedOverlay = document.getElementById('mafia-cards-ended-overlay');
      const _isLost = !_mafiaCardsGameOwnedInThisTab
                      && (mafiaState && mafiaState.phase && mafiaState.phase !== 'lobby');
      if (endedOverlay) endedOverlay.hidden = !_isLost;
      ['mafia-cards-narrator-phase',
       'mafia-cards-players-panel',
       'mafia-cards-rules-panel',
       'mafia-cards-script-details'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = _isLost ? 'none' : '';
      });
      if (_isLost) return; // skip dashboard work — overlay is the whole UI

      // Phase pill
      const phaseEmoji = document.getElementById('mafia-cards-narrator-phase-emoji');
      const phaseLabel = document.getElementById('mafia-cards-narrator-phase-label');
      if (phaseEmoji && phaseLabel) {
        const isNight = mafiaCardsLocalPhase === 'night';
        phaseEmoji.textContent = isNight ? '🌙' : '☀️';
        phaseLabel.textContent = t(isNight ? 'mafiaCards.narrator.phaseNight' : 'mafiaCards.narrator.phaseDay');
        phaseLabel.setAttribute('data-i18n', isNight ? 'mafiaCards.narrator.phaseNight' : 'mafiaCards.narrator.phaseDay');
      }

      // Alive/out stats chip — uses the local dead set + the narrator's
      // role map total to compute live counts. Hidden until roles load
      // (no point showing "0 alive" during the brief fetch window).
      const statsEl = document.getElementById('mafia-cards-narrator-stats');
      if (statsEl) {
        const allSeats = mafiaMe.narratorRoles ? Object.keys(mafiaMe.narratorRoles) : [];
        if (allSeats.length === 0) {
          statsEl.textContent = '';
        } else {
          const dead = allSeats.filter(s => mafiaCardsDeadPlayers.has(s)).length;
          const alive = allSeats.length - dead;
          statsEl.innerHTML = t('mafiaCards.narrator.statsAliveOut', {
            alive: '<b>' + alive + '</b>',
            out:   '<b>' + dead + '</b>',
          });
        }
      }

      // Roster
      const roster = document.getElementById('mafia-cards-narrator-roster');
      if (!roster) return;
      const roleMap = mafiaMe.narratorRoles;
      if (!roleMap) {
        // Not loaded yet — show loading state and trigger a fetch.
        roster.innerHTML = '<div class="mafia-cards-narrator-loading">' + t('mafiaCards.narrator.loadingRoles') + '</div>';
        mafiaFetchNarratorState();
        return;
      }
      // Cheat-sheet labels. Mafia Leader uses its OWN name so the narrator
      // can spot them at a glance — critical for the Godfather behavior
      // (narrator must give thumbs-DOWN when the Detective investigates them).
      const ROLE_META = {
        mafia:        { emoji:'🔪',  nameKey:'mafia.rules.role.mafia.name' },
        mafia_leader: { emoji:'🎩',  nameKey:'mafia.cheatSheet.mafiaLeader' },
        doctor:       { emoji:'🩺',  nameKey:'mafia.rules.role.doctor.name' },
        detective:    { emoji:'🕵️', nameKey:'mafia.rules.role.detective.name' },
        child:        { emoji:'👶',  nameKey:'mafia.rules.role.child.name' },
        villager:     { emoji:'👤',  nameKey:'mafia.rules.role.villager.name' },
      };
      const seats = Object.keys(roleMap).sort(); // p1, p2, ... — stable order
      const _claimedBy = mafiaState.claimedBy || {};
      const rows = seats.map(seatId => {
        const role = roleMap[seatId];
        const meta = ROLE_META[role] || ROLE_META.villager;
        const isDead = mafiaCardsDeadPlayers.has(seatId);
        // "Away": this seat's phone is currently disconnected (its session is
        // not in our live presence set). We never auto-eliminate on a drop —
        // we just flag it so the narrator can choose to wait or mark them out
        // by hand. Skipped once the narrator has already marked them out.
        const seatSid = _claimedBy[seatId];
        const isAway = !isDead && !!seatSid && !mafiaIsSessionPresent(seatSid);
        const name = mafiaSeatNameFor(seatId);
        return '<button type="button" class="mafia-cards-narrator-row' + (isDead ? ' is-dead' : '') + (isAway ? ' is-away' : '') + '" onclick="mafiaCardsToggleDead(\'' + seatId + '\')"'
          + (isAway ? ' title="' + huddleEscape(t('mafiaCards.narrator.awayHint')) + '"' : '') + '>'
          + '<span class="mafia-cards-narrator-row-name">' + huddleEscape(name) + '</span>'
          + (isAway ? '<span class="mafia-cards-narrator-row-away">' + t('mafiaCards.narrator.away') + '</span>' : '')
          + '<span class="mafia-cards-narrator-row-emoji">' + meta.emoji + '</span>'
          + '<span class="mafia-cards-narrator-row-role">' + t(meta.nameKey) + '</span>'
          + '<span class="mafia-cards-narrator-row-mark" aria-hidden="true">✗</span>'
        + '</button>';
      }).join('');
      roster.innerHTML = rows || '<div class="mafia-cards-narrator-loading">' + t('mafiaCards.narrator.loadingRoles') + '</div>';

      // Narrator rules + reference script panels. Both render even when
      // collapsed so the content is ready the moment the narrator opens
      // the <details>.
      mafiaCardsRenderRules();
      mafiaCardsRenderScript();
      // Prime the profiles cache so the cheat sheet shows real names
      // ("Ahmed") instead of "Player 3". No-op in lab mode (synthetic UIDs).
      mafiaPrimeClaimantProfiles();
    }

    // ===== Mafia Cards — player role screen (full-screen reveal) =========
    // Default: HIDDEN. Player taps "Reveal Role" to see their role + power
    // (mirrors classic Mafia layout). Toggle again with "Hide Role". Local
    // reveal state is reset when a new game starts.
    let mafiaCardsRoleRevealed = false;

    function mafiaCardsToggleRoleReveal(){
      // Don't toggle into the revealed state until the role data is loaded.
      if (!mafiaCardsRoleRevealed && !mafiaMe.myRole) {
        mafiaFetchMyRole();
        return;
      }
      mafiaCardsRoleRevealed = !mafiaCardsRoleRevealed;
      mafiaCardsRenderRole();
    }

    function mafiaCardsRenderRole(){
      const role = mafiaMe.myRole;
      if (!role) {
        // Role not loaded yet — kick a fetch; render again when it lands
        // (mafiaFetchMyRole calls mafiaRerender on success).
        mafiaFetchMyRole();
        return;
      }
      // Role-specific copy. Reuses the classic Mafia roleCard i18n keys so
      // the wording stays identical to the classic role screen.
      const ROLE_INFO = {
        mafia:        { emoji:'🔪',  titleKey:'mafia.roleCard.mafia.title',        descKey:'mafia.roleCard.mafia.desc' },
        mafia_leader: { emoji:'🎩',  titleKey:'mafia.roleCard.mafiaLeader.title',  descKey:'mafia.roleCard.mafiaLeader.desc' },
        doctor:       { emoji:'🩺',  titleKey:'mafia.roleCard.doctor.title',       descKey:'mafia.roleCard.doctor.desc' },
        detective:    { emoji:'🕵️', titleKey:'mafia.roleCard.detective.title',    descKey:'mafia.roleCard.detective.desc' },
        child:        { emoji:'👶',  titleKey:'mafia.roleCard.child.title',        descKey:'mafia.roleCard.child.desc' },
        villager:     { emoji:'👤',  titleKey:'mafia.roleCard.villager.title',     descKey:'mafia.roleCard.villager.desc' },
      };
      const info = ROLE_INFO[role] || ROLE_INFO.villager;

      // Populate the shown-state content (emoji, title, description, teammates).
      const emojiEl = document.getElementById('mafia-cards-role-emoji');
      const titleEl = document.getElementById('mafia-cards-role-title');
      const descEl  = document.getElementById('mafia-cards-role-desc');
      const teammatesEl = document.getElementById('mafia-cards-role-teammates');
      if (emojiEl) emojiEl.textContent = info.emoji;
      if (titleEl) titleEl.textContent = t(info.titleKey);
      if (descEl)  descEl.textContent  = t(info.descKey);
      if (teammatesEl) {
        // Mafia Leader is on the Mafia team — they see (and are seen as) a
        // teammate by regular Mafia. Server populates teammates for both roles.
        const isMafiaTeam = (role === 'mafia' || role === 'mafia_leader');
        if (isMafiaTeam && Array.isArray(mafiaMe.myTeammates) && mafiaMe.myTeammates.length > 0) {
          const names = mafiaMe.myTeammates.map(seatId => huddleEscape(mafiaSeatNameFor(seatId))).join(' · ');
          teammatesEl.innerHTML =
            '<span class="mafia-cards-role-teammates-label">' + t('mafia.roleCard.teammatesLabel') + '</span>' + names;
          teammatesEl.hidden = false;
        } else {
          teammatesEl.hidden = true;
        }
      }

      // Toggle visibility of hidden vs shown state.
      const hiddenState = document.getElementById('mafia-cards-role-hidden-state');
      const shownState  = document.getElementById('mafia-cards-role-shown-state');
      if (hiddenState) hiddenState.hidden = mafiaCardsRoleRevealed;
      if (shownState)  shownState.hidden  = !mafiaCardsRoleRevealed;

      // Toggle button label.
      const labelEl = document.getElementById('mafia-cards-role-toggle-label');
      if (labelEl) {
        const key = mafiaCardsRoleRevealed ? 'mafiaCards.role.hideBtn' : 'mafiaCards.role.revealBtn';
        labelEl.textContent = t(key);
        labelEl.setAttribute('data-i18n', key);
      }
    }



    // ----- Narrator role cache -----
    // The narrator needs to know roles for the day-reveal copy ("X was killed,
    // they were a Y") and for the end-game role reveal. Fetched once via
    // huddle_mafia_get_narrator_state and cached in mafiaMe.narratorRoles.
    // Players never call this — RPC rejects them with not_narrator.
    // De-duped in-flight promise so rapid rerenders only spawn one fetch.
    // Captures the room code at fetch-time and only commits the cache if
    // we're still in the same room when the promise resolves (prevents an
    // old-room fetch from contaminating a new room after a regenerate/replay).
    let _mafiaNarratorStateFetch = null;
    async function mafiaFetchNarratorState(force){
      if (!force && mafiaMe.narratorRoles) return mafiaMe.narratorRoles;
      if (_mafiaNarratorStateFetch) return _mafiaNarratorStateFetch;
      const fetchForCode = mafiaState.code;
      _mafiaNarratorStateFetch = (async () => {
        try {
          const result = await huddleCallRPC('huddle_mafia_get_narrator_state', {
            p_code: fetchForCode,
          });
          // Stale guard: only commit the cache if the room code hasn't changed.
          if (result && result.roles && mafiaState.code === fetchForCode) {
            mafiaMe.narratorRoles = result.roles;
            // Re-render now that we have role data — day-reveal copy and
            // end-game reveal both depend on this map.
            mafiaRerender();
            return result.roles;
          }
        } catch(e){
          console.warn('[Mafia] get_narrator_state failed:', e && e.message);
        } finally {
          _mafiaNarratorStateFetch = null;
        }
        return null;
      })();
      return _mafiaNarratorStateFetch;
    }


    function mafiaRenderLobby(){
      mafiaUpdateLobbyTitle();
      mafiaRenderNarratorCard();
      mafiaRenderSeats();
      mafiaRenderRoleMix();
      mafiaRenderOptionalRoles();
      mafiaRenderStartButton();
      mafiaRenderHeaderActions();
      // Prime profile names so seat tiles show real names rather than "Player N".
      mafiaPrimeClaimantProfiles();
    }

    function mafiaRenderNarratorCard(){
      const card = document.getElementById('mafia-narrator-card');
      const titleEl = document.getElementById('mafia-narrator-title');
      const subEl = document.getElementById('mafia-narrator-sub');
      const statusEl = document.getElementById('mafia-narrator-status');
      if (!card) return;
      const sid = mafiaGetSessionId();
      const isHost = mafiaState.hostId === sid;
      const narratorUid = mafiaState.narratorUid;
      card.classList.remove('claimed', 'claimed-by-me');

      // "Needs attention" pulse — when the lobby has enough players to start
      // (5-8) AND the host hasn't picked a narrator yet, the narrator card
      // is the ONLY thing blocking Start. Without this nudge users scroll
      // past the picker, tap a dim Start button, and have no idea why it
      // does nothing. Only pulse for the host (guests can't pick anyway).
      const _playerCount = (typeof mafiaPlayerSeats === 'function') ? mafiaPlayerSeats().length : 0;
      const _narratorIsBlocker = !narratorUid && isHost && _playerCount >= 5 && _playerCount <= 8;
      card.classList.toggle('needs-attention', _narratorIsBlocker);

      if (!narratorUid) {
        // Unfilled
        titleEl.textContent = isHost
          ? t('mafia.narratorNotSet')
          : t('mafia.narratorNotSetGuest');
        subEl.textContent = t('mafia.narratorSub');
        statusEl.textContent = '';
        card.disabled = !isHost;
      } else {
        // Find which seat the narrator owns to display their seat name.
        const narratorSeat = Object.entries(mafiaState.claimedBy || {})
          .find(([pid, uid]) => uid === narratorUid);
        const narratorName = narratorSeat ? mafiaSeatNameFor(narratorSeat[0]) : t('mafia.unknownPlayer');
        titleEl.textContent = narratorName;
        subEl.textContent = t('mafia.narratorAssignedSub');
        statusEl.textContent = (narratorUid === sid)
          ? t('mafia.narratorIsYou')
          : t('mafia.narratorTagline');
        card.classList.add('claimed');
        if (narratorUid === sid) card.classList.add('claimed-by-me');
        card.disabled = !isHost; // host can re-pick
      }
    }

    function mafiaRenderSeats(){
      const grid = document.getElementById('mafia-seats');
      const hint = document.getElementById('mafia-seats-hint');
      if (grid && huddleLobbyHydrating(mafiaState && mafiaState.code)) {
        grid.innerHTML = huddleLobbySkeletonHTML(8);
        return;
      }
      if (!grid) return;
      const sid = mafiaGetSessionId();
      const narratorUid = mafiaState.narratorUid;

      // Render 8 slots (max supported player count). Each slot shows either
      // a claim/invite tile or a claimed player.
      const html = [];
      for (let n = 1; n <= 8; n++) {
        const seatId = 'p' + n;
        const uid = mafiaState.claimedBy[seatId];
        const isNarrator = uid && narratorUid && uid === narratorUid;
        const isMe = uid && uid === sid;
        if (!uid) {
          // Empty seat → render an Invite tile (not a claim button). The host
          // is auto-claimed on entry, so tapping an empty seat used to *switch*
          // their seat instead of doing anything useful. Now it opens the
          // shared lobby invite sheet so the seat gets filled by a real friend.
          html.push(
            `<button class="mafia-seat mafia-seat-invite" type="button" data-action="openLobbyInviteSheet" data-arg="mafia" data-empty="1">
               <div class="mafia-seat-invite-icon">+</div>
               <div class="mafia-seat-info">
                 <div class="mafia-seat-name">${t('mafia.inviteFriend')}</div>
                 <div class="mafia-seat-status">${t('mafia.emptySeat')}</div>
               </div>
             </button>`
          );
        } else {
          const cls = ['mafia-seat'];
          if (isMe) cls.push('claimed-by-me');
          if (isNarrator) cls.push('is-narrator');
          // Resolve avatar from the claimant's profile (same pattern as
          // Hot Seat / Chameleon / Liar's Cup lobbies) so joined players
          // are visually identified by their chosen symbol + colour, not
          // just by name. Falls back to deterministicAvatar(uid) so the
          // tile shows SOMETHING even before the profile cache lands.
          let avatarData;
          if (isMe && myProfile && myProfile.avatar) {
            avatarData = myProfile.avatar;
          } else {
            const profile = (typeof profileForClaim === 'function') ? profileForClaim(uid) : null;
            avatarData = (profile && profile.avatar) ? profile.avatar : deterministicAvatar(uid);
          }
          const avatar = avatarHTML(avatarData, 32, { fallback: String(n) });
          html.push(
            `<button class="${cls.join(' ')}" type="button" disabled>
               ${avatar}
               <div class="mafia-seat-info">
                 <div class="mafia-seat-name">${huddleEscape(mafiaSeatNameFor(seatId))}</div>
                 <div class="mafia-seat-status">${
                   isNarrator ? t('mafia.statusNarrator')
                     : (isMe ? t('mafia.statusYou') : t('mafia.statusClaimed'))
                 }</div>
               </div>
             </button>`
          );
        }
      }
      grid.innerHTML = html.join('');
      // Re-parse the freshly-rendered avatar symbols so twemoji swaps them
      // into centered SVGs (matches the Hot Seat / Liar / Chameleon lobbies).
      // No-op when the twemoji CDN is unreachable — native glyphs stay.
      if (typeof parseEmoji === 'function') parseEmoji(grid);

      // Hint text below the grid
      const playerCount = mafiaPlayerSeats().length;
      const narratorSet = !!narratorUid;
      let hintText = '';
      if (playerCount < 5) {
        const needed = 5 - playerCount;
        hintText = t('mafia.hintNeedMorePlayers', { n: needed });
      } else if (!narratorSet) {
        hintText = t('mafia.hintNeedNarrator');
      } else if (playerCount > 8) {
        // Shouldn't happen (only 8 seats) but defensive.
        hintText = t('mafia.hintTooMany');
      } else {
        hintText = t('mafia.hintReady', { n: playerCount });
      }
      if (hint) hint.textContent = hintText;

      // Keep the shared invite sheet fresh if it's open (a friend may have
      // just joined, so their tile should flip to "Joined").
      if (typeof refreshLobbyInviteSheetIfOpen === 'function') refreshLobbyInviteSheetIfOpen('mafia');
    }

    function mafiaRenderRoleMix(){
      const row = document.getElementById('mafia-rolemix-row');
      if (!row) return;
      const count = mafiaPlayerSeats().length;
      const opt = mafiaGetOptionalRoles();
      const includeDetective = mafiaIsDetectiveActive();
      const mix = mafiaRoleMixFor(count, includeDetective, opt.child, opt.mafiaLeader);
      if (!mix) {
        row.innerHTML = `<div class="mafia-rolemix-empty">${t('mafia.rolemixWaiting')}</div>`;
        return;
      }
      // Only render pills whose count > 0 so the row stays compact when
      // optional roles are off. Order: Mafia, Mafia Leader, Detective, Doctor,
      // Child, Villager — keeps team groupings adjacent.
      const allPills = [
        ['mafia.role.mafia',        mix.mafia,        '🔪'],
        ['mafia.role.mafiaLeader',  mix.mafia_leader, '🎩'],
        ['mafia.role.detective',    mix.detective,    '🕵️'],
        ['mafia.role.doctor',       mix.doctor,       '🩺'],
        ['mafia.role.child',        mix.child,        '👶'],
        ['mafia.role.villager',     mix.villager,     '👤'],
      ];
      row.innerHTML = allPills
        .filter(([, n]) => n > 0)
        .map(([key, n, emoji]) =>
          `<span class="mafia-rolemix-pill"><span class="count">${n}</span> ${emoji} ${t(key)}</span>`
        ).join('');
    }

    // ===== Optional roles (UI-only — no game logic yet) ====================
    // Toggles persist host-side in localStorage. They do NOT sync to other
    // phones and they do NOT affect role assignment yet. When we wire the
    // gameplay phase, this state will move to room state (synced via SQL).
    const MAFIA_OPTIONAL_KEY = 'huddle.mafia.optionalRoles';
    const MAFIA_OPTIONAL_ROLES = [
      // Detective is OFF by default in Mafia Cards (host opts in). When on:
      // role is dealt + narrator script includes Detective cues. Only shown
      // in Cards mode — classic Mafia keeps Detective as a standard role.
      { id: 'detective',   emoji: '🕵️', nameKey: 'mafia.optional.detective.name',   descKey: 'mafia.optional.detective.desc', cardsOnly: true },
      // Child + Leader powers are Cards-mode-only because they need a narrator
      // to enforce them (Child's "take someone with me" is verbal; Leader's
      // "appears innocent" is the narrator lying to the Detective). Classic
      // Mafia has a server-driven game loop and would need significant
      // additional logic to support them.
      { id: 'child',       emoji: '👶', nameKey: 'mafia.optional.child.name',       descKey: 'mafia.optional.child.desc',       cardsOnly: true },
      { id: 'mafiaLeader', emoji: '🎩', nameKey: 'mafia.optional.mafiaLeader.name', descKey: 'mafia.optional.mafiaLeader.desc', cardsOnly: true },
    ];
    function mafiaGetOptionalRoles(){
      try {
        const raw = localStorage.getItem(MAFIA_OPTIONAL_KEY);
        if (!raw) return { child: false, mafiaLeader: false, detective: false };
        const obj = JSON.parse(raw);
        return {
          child: !!(obj && obj.child),
          mafiaLeader: !!(obj && obj.mafiaLeader),
          detective: !!(obj && obj.detective),
        };
      } catch(e) {
        return { child: false, mafiaLeader: false, detective: false };
      }
    }

    // Resolves whether Detective is active in the CURRENT game. Outside Cards
    // mode (classic Mafia), Detective is always a standard role. In Cards
    // mode, the host's lobby toggle controls it (default OFF).
    function mafiaIsDetectiveActive(){
      if (!mafiaCardsMode) return true;
      return !!mafiaGetOptionalRoles().detective;
    }
    // Child + Leader are Cards-mode-only — never active in classic Mafia.
    function mafiaIsChildActive(){
      if (!mafiaCardsMode) return false;
      return !!mafiaGetOptionalRoles().child;
    }
    function mafiaIsLeaderActive(){
      if (!mafiaCardsMode) return false;
      return !!mafiaGetOptionalRoles().mafiaLeader;
    }
    function mafiaSetOptionalRole(id, value){
      const current = mafiaGetOptionalRoles();
      current[id] = !!value;
      try { localStorage.setItem(MAFIA_OPTIONAL_KEY, JSON.stringify(current)); } catch(e){}
    }
    function mafiaToggleOptionalRole(id){
      const sid = mafiaGetSessionId();
      // Defensive — only the host should ever be able to fire this (the card
      // is hidden for non-hosts), but double-check before mutating storage.
      if (mafiaState.hostId !== sid) return;
      const current = mafiaGetOptionalRoles();
      mafiaSetOptionalRole(id, !current[id]);
      mafiaRenderOptionalRoles();
      // All three optional toggles now change the role-mix count, so any of
      // them needs to refresh the pills below. (Previously only Detective
      // changed the count — Child + Leader were UI stubs.)
      mafiaRenderRoleMix();
    }
    function mafiaRenderOptionalRoles(){
      const card = document.getElementById('mafia-optional-card');
      const rows = document.getElementById('mafia-optional-rows');
      if (!card || !rows) return;
      const sid = mafiaGetSessionId();
      const isHost = mafiaState.hostId === sid;
      // Hide entirely for non-hosts. Also hide once the game has left lobby
      // (toggles are a pre-game decision; no point showing them mid-night).
      const inLobby = (mafiaState.phase || 'lobby') === 'lobby';
      card.hidden = !(isHost && inLobby);
      if (card.hidden) return;
      const state = mafiaGetOptionalRoles();
      // cardsOnly entries are filtered out when classic Mafia opened the
      // lobby — they belong to the Cards variant only.
      const visibleRoles = MAFIA_OPTIONAL_ROLES.filter(r => !r.cardsOnly || mafiaCardsMode);
      rows.innerHTML = visibleRoles.map(r => {
        const on = !!state[r.id];
        return `<button type="button" class="mafia-optional-row" aria-pressed="${on}" data-action="mafiaToggleOptionalRole" data-arg="${r.id}">`
          + `<span class="mafia-optional-row-emoji">${r.emoji}</span>`
          + `<span class="mafia-optional-row-text">`
          +   `<span class="mafia-optional-row-name">${t(r.nameKey)}</span>`
          +   `<span class="mafia-optional-row-desc">${t(r.descKey)}</span>`
          + `</span>`
          + `<span class="mafia-optional-row-mark" aria-hidden="true">✓</span>`
        + `</button>`;
      }).join('');
    }

    function mafiaRenderStartButton(){
      const btn = document.getElementById('mafia-start-btn');
      if (!btn) return;
      const sid = mafiaGetSessionId();
      const isHost = mafiaState.hostId === sid;
      const playerCount = mafiaPlayerSeats().length;
      const narratorSet = !!mafiaState.narratorUid;
      const meIsInRoom = !!mafiaMe.myId || mafiaState.narratorUid === sid;
      const ready = isHost && playerCount >= 5 && playerCount <= 8 && narratorSet && meIsInRoom;
      if (ready) btn.removeAttribute('aria-disabled');
      else       btn.setAttribute('aria-disabled', 'true');
      // Subtle hint on the button text when host but not ready (helps host
      // see what's still missing — non-host just sees the default label).
      if (!isHost) {
        btn.textContent = t('mafia.startWaitingHost');
      } else {
        btn.textContent = t('lobby.startGame');
      }
    }

    function mafiaRenderHeaderActions(){
      const sid = mafiaGetSessionId();
      const isHost = mafiaState.hostId === sid;
      const meIsInRoom = !!mafiaMe.myId || mafiaState.narratorUid === sid;
      const leaveBtn = document.getElementById('mafia-leave-btn');
      if (leaveBtn) leaveBtn.hidden = !meIsInRoom;
    }

    // ----- Actions -----

    function mafiaOpenNarratorPicker(){
      const sid = mafiaGetSessionId();
      if (mafiaState.hostId !== sid) return;
      const list = document.getElementById('mafia-narrator-picker-list');
      if (!list) return;
      // Show all current claimants (including self) as picker options.
      const items = Object.entries(mafiaState.claimedBy || {})
        .sort(([a],[b]) => a.localeCompare(b))
        .map(([seatId, uid]) => {
          const isYou = uid === sid;
          const isCurrent = uid === mafiaState.narratorUid;
          const cls = ['mafia-narrator-picker-item'];
          if (isCurrent) cls.push('is-current');
          return `<button class="theme-option ${isCurrent ? 'active' : ''}" type="button" onclick="mafiaPickNarrator('${seatId}')">
            <div class="theme-option-icon">🎙️</div>
            <div class="theme-option-content">
              <div class="theme-option-title">${huddleEscape(mafiaSeatNameFor(seatId))}${isYou ? ' · ' + t('mafia.you') : ''}</div>
              <div class="theme-option-sub">${isCurrent ? t('mafia.narratorCurrent') : t('mafia.narratorPickThis')}</div>
            </div>
            ${isCurrent ? '<svg class="theme-option-check" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
          </button>`;
        });
      if (items.length === 0) {
        list.innerHTML = `<div class="mafia-rolemix-empty" style="padding:14px;text-align:center">${t('mafia.narratorPickerEmpty')}</div>`;
      } else {
        list.innerHTML = items.join('');
      }
      const bd = document.getElementById('mafia-narrator-picker-backdrop');
      if (bd) bd.classList.add('active');
    }
    function mafiaCloseNarratorPicker(event){
      if (event && event.target !== event.currentTarget) return;
      const bd = document.getElementById('mafia-narrator-picker-backdrop');
      if (bd) bd.classList.remove('active');
    }
    async function mafiaPickNarrator(seatId){
      try {
        const newState = await huddleCallRPC('huddle_mafia_set_narrator', {
          p_code: mafiaState.code,
          p_narrator_seat: seatId,
        });
        if (newState) {
          Object.assign(mafiaState, newState);
          mafiaRerender();
        }
      } catch(e){
        console.warn('[Mafia] setNarrator failed:', e && e.message);
      }
      mafiaCloseNarratorPicker();
    }

    function mafiaLeaveRoom(){
      // Optimistic leave: flip the screen + tear down local state IMMEDIATELY
      // so the user doesn't sit on the lobby for 200-500ms waiting on the
      // round-trip. The seat-release RPC runs in the background and the
      // server-side validation (huddle_leave_seat enforces session ownership)
      // is the actual security boundary — the optimistic client state is
      // just UX. On RPC failure, other players' realtime channels will see
      // the stale seat until the next state push reconciles it; logging
      // the failure here is enough for now.
      const codeAtLeave = mafiaState.code;
      mafiaMe.myId = null;
      try { huddleClearLastRoom('mafia'); } catch(e){}
      if (mafiaSyncChannel) {
        try { mafiaSyncChannel.untrack(); } catch(e){}
        try { window.sb.removeChannel(mafiaSyncChannel); } catch(e){}
        mafiaSyncChannel = null;
        _mafiaChannelCode = null;
        _mafiaChannelSessionId = null;
        if (typeof mafiaResetPresenceState === 'function') mafiaResetPresenceState();
      }
      goTo('games');
      if (codeAtLeave) {
        // Fire-and-forget — captured code so a fast subsequent action that
        // mutates mafiaState.code can't poison the release request.
        Promise.resolve(huddleCallRPC('huddle_leave_seat', {
          p_table: 'mafia_rooms',
          p_code: codeAtLeave,
        })).catch(e => console.warn('[Mafia] leave failed:', e && e.message));
      }
    }
    async function regenerateMafiaRoom(){
      if (!mafiaState.code) return;
      const newCode = generateCode();
      try {
        const newState = await huddleCallRPC('huddle_mafia_regenerate_room', {
          p_old_code: mafiaState.code,
          p_new_code: newCode,
        });
        if (newState) {
          Object.assign(mafiaState, newState);
          mafiaState.code = newCode;
          try { huddlePersistLastRoom('mafia',newCode); } catch(e){}
          mafiaSyncUrlToRoom(newCode);
          // Re-wire realtime to the new code
          mafiaWireSync();
          document.getElementById('mafia-room-code').textContent = newCode;
          if (typeof setRoomQrSrc === 'function' && typeof qrUrl === 'function') {
            setRoomQrSrc(document.getElementById('mafia-room-qr'), qrUrl(mafiaJoinUrl(newCode)));
          }
          mafiaRerender();
        }
      } catch(e){
        console.warn('[Mafia] regenerate failed:', e && e.message);
      }
    }

    async function mafiaStartGame(){
      // Gate: aria-disabled means a Start condition isn't met (e.g. no
      // narrator picked, not enough players). Surface the hint as a toast.
      // Bonus for Mafia: if the narrator-not-picked branch is the blocker
      // AND the narrator card is off-screen, scroll to it so the pulse
      // animation we added is visible.
      const _gateBtn = document.getElementById('mafia-start-btn');
      if (_gateBtn && _gateBtn.getAttribute('aria-disabled') === 'true') {
        const _hintEl = document.getElementById('mafia-seats-hint');
        const _msg = _hintEl && _hintEl.textContent && _hintEl.textContent.trim();
        if (_msg && typeof showLobbyToast === 'function') showLobbyToast(_msg);
        const _playerCount = (typeof mafiaPlayerSeats === 'function') ? mafiaPlayerSeats().length : 0;
        if (!mafiaState.narratorUid && _playerCount >= 5 && _playerCount <= 8) {
          const _card = document.getElementById('mafia-narrator-card');
          if (_card) { try { _card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(_){} }
        }
        return;
      }
      const sid = mafiaGetSessionId();
      if (mafiaState.hostId !== sid) return;
      const btn = document.getElementById('mafia-start-btn');
      if (btn) { btn.disabled = true; btn.textContent = t('mafia.starting'); }
      try {
        // Cards mode passes BOTH the host's Detective lobby toggle AND the
        // variant ('cards') to SQL. The variant is written into the room
        // state — friends' phones realtime-sync and read state.variant to
        // know they're in a Cards game (vs the host's local flag, which
        // never reached them before).
        const rpcArgs = { p_code: mafiaState.code };
        if (mafiaCardsMode) {
          rpcArgs.p_include_detective    = mafiaIsDetectiveActive();
          rpcArgs.p_include_child        = mafiaIsChildActive();
          rpcArgs.p_include_mafia_leader = mafiaIsLeaderActive();
          rpcArgs.p_variant              = 'cards';
        }
        const newState = await huddleCallRPC('huddle_mafia_start_game', rpcArgs);
        if (newState) {
          Object.assign(mafiaState, newState);
          // Reset cached role on host's device so we refetch (we never had one).
          mafiaMe.myRole = null;
          mafiaMe.myTeammates = [];
          mafiaMe.narratorRoles = null; // clear narrator-side cache too
          _mafiaRoleHidden = false;
          // Mafia Cards mode: bypass the rules-gate dispatcher and route
          // straight into the card-style screens. Also reset the narrator's
          // local dashboard state (phase pill back to Night, dead set cleared)
          // so a new game starts fresh even if the host launches twice.
          if (mafiaCardsMode) {
            mafiaCardsResetNarratorLocalState();
            mafiaRerender();
            return;
          }
          // Classic Mafia: dispatcher routes to role card / narrator stub
          // based on who I am and what phase the server set. Other devices
          // get there via Realtime.
          mafiaRerender();
        }
      } catch(e){
        const msg = (e && e.message) || String(e);
        alert(t('mafia.startFailed', { msg }));
        if (btn) { btn.disabled = false; btn.textContent = t('lobby.startGame'); }
      }
    }

    // ===== How To Play — animated video player with ElevenLabs voiceover ====
    // The 6 scenes are sequenced by audio.currentTime. Each entry's startSec
    // matches the per-scene cue exported from generate_howto_voiceover.js
    // (see assets/howto/mafia-en.alignment.json). End card fires after the
    // last scene finishes — that's the natural "outro" before the user closes.
    const MAFIA_HOWTO_SCENE_CUES = [
      { scene: '1', startSec: 0     },
      { scene: '2', startSec: 8.86  },
      { scene: '3', startSec: 20.48 },
      { scene: '4', startSec: 37.04 },
      { scene: '5', startSec: 43.34 },
      { scene: '6', startSec: 50.77 },
      { scene: 'end', startSec: 58.7 },
    ];
    const MAFIA_HOWTO_AUDIO_SRC = 'assets/howto/mafia-en.mp3';
    let mafiaHowToReturnScreen = 'mafia-lobby';
    let mafiaHowToRafId = null;

    // Languages we have a finished how-to video for. When the active language
    // isn't in this set, the "How to play" trigger is hidden entirely so we
    // don't promise something we can't deliver. (Turkish video pending — needs
    // Creator-tier ElevenLabs for the native Doga voice.)
    const MAFIA_HOWTO_LANGS = new Set(['en']);

    function mafiaUpdateHowToTrigger(){
      const trig = document.getElementById('mafia-howto-trigger');
      if (!trig) return;
      const lang = (typeof getLang === 'function') ? getLang() : 'en';
      if (!MAFIA_HOWTO_LANGS.has(lang)) {
        trig.hidden = true;
        return;
      }
      trig.hidden = false;
      let seen = false;
      try { seen = localStorage.getItem('huddle.mafiahowto.seen') === '1'; } catch(e){}
      trig.classList.toggle('pulse', !seen);
    }

    function openMafiaHowTo(){
      // Belt-and-braces: even if the trigger somehow fires for an unsupported
      // language, refuse to open rather than play the English audio with no
      // matching captions. Returns silently — user just sees the button do
      // nothing instead of getting a broken experience.
      const lang = (typeof getLang === 'function') ? getLang() : 'en';
      if (!MAFIA_HOWTO_LANGS.has(lang)) {
        console.info('[Mafia HowTo] suppressed — no video for language:', lang);
        return;
      }

      // Remember where the user came from so we can route back on close. If
      // they're already on the lobby (the only place with the trigger button
      // today), this just falls through to mafia-lobby — but a future entry
      // point (e.g. games tile preview) would set its own return screen.
      try {
        const active = document.querySelector('.screen.active');
        if (active && active.id && active.id !== 'screen-mafia-howto') {
          mafiaHowToReturnScreen = active.id.replace(/^screen-/, '');
        }
      } catch(e) {}

      try { localStorage.setItem('huddle.mafiahowto.seen', '1'); } catch(e){}
      mafiaUpdateHowToTrigger();

      const audio = document.getElementById('mh-audio');
      if (audio) {
        if (audio.src !== window.location.origin + '/' + MAFIA_HOWTO_AUDIO_SRC && !audio.src.endsWith(MAFIA_HOWTO_AUDIO_SRC)) {
          audio.src = MAFIA_HOWTO_AUDIO_SRC;
        }
        audio.currentTime = 0;
      }
      goTo('mafia-howto');
      // Reset visual state — kill any leftover .is-active so the first scene
      // animates in cleanly on every open.
      document.querySelectorAll('#screen-mafia-howto .mh-scene').forEach(el => el.classList.remove('is-active'));
      // Activate scene 1 immediately so the user sees something before the
      // audio's first frame loads.
      const s1 = document.querySelector('#screen-mafia-howto .mh-scene[data-scene="1"]');
      if (s1) s1.classList.add('is-active');

      const btn = document.getElementById('mh-play-pause');
      if (btn) btn.classList.remove('is-paused');

      if (audio) {
        const p = audio.play();
        if (p && typeof p.catch === 'function') p.catch(err => {
          // Mobile autoplay block — surface a paused state so the user can tap play.
          console.warn('[Mafia HowTo] autoplay blocked:', err && err.message);
          if (btn) btn.classList.add('is-paused');
        });
      }
      // Wire scrub handlers (idempotent — guarded by data-wired on the bar).
      mafiaHowToWireScrubber();
      mafiaHowToStartTicker();
    }

    function closeMafiaHowTo(){
      mafiaHowToStopTicker();
      const audio = document.getElementById('mh-audio');
      if (audio) { audio.pause(); audio.currentTime = 0; }
      goTo(mafiaHowToReturnScreen || 'mafia-lobby');
    }

    function toggleMafiaHowToPlay(){
      const audio = document.getElementById('mh-audio');
      const btn   = document.getElementById('mh-play-pause');
      if (!audio || !btn) return;
      if (audio.paused) {
        audio.play();
        btn.classList.remove('is-paused');
      } else {
        audio.pause();
        btn.classList.add('is-paused');
      }
    }

    function replayMafiaHowTo(){
      const audio = document.getElementById('mh-audio');
      if (audio) { audio.currentTime = 0; audio.play(); }
      document.querySelectorAll('#screen-mafia-howto .mh-scene').forEach(el => el.classList.remove('is-active'));
      const s1 = document.querySelector('#screen-mafia-howto .mh-scene[data-scene="1"]');
      if (s1) s1.classList.add('is-active');
      const btn = document.getElementById('mh-play-pause');
      if (btn) btn.classList.remove('is-paused');
    }

    function mafiaHowToFormatTime(sec){
      if (!isFinite(sec) || sec < 0) sec = 0;
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' + s : s);
    }

    function mafiaHowToTick(){
      const audio = document.getElementById('mh-audio');
      if (!audio) { mafiaHowToStopTicker(); return; }
      const t = audio.currentTime || 0;
      const dur = audio.duration || 58.7;

      // Decide which scene should be active based on currentTime.
      let activeSceneId = MAFIA_HOWTO_SCENE_CUES[0].scene;
      for (const cue of MAFIA_HOWTO_SCENE_CUES) {
        if (t >= cue.startSec - 0.05) activeSceneId = cue.scene;
      }
      const currentlyActive = document.querySelector('#screen-mafia-howto .mh-scene.is-active');
      const shouldBeActive  = document.querySelector(`#screen-mafia-howto .mh-scene[data-scene="${activeSceneId}"]`);
      if (currentlyActive !== shouldBeActive) {
        if (currentlyActive) currentlyActive.classList.remove('is-active');
        if (shouldBeActive)  shouldBeActive.classList.add('is-active');
      }

      // Update progress bar + time label. The knob rides the fill edge so
      // its center sits exactly at the playhead — same X position as the
      // right edge of the gold fill.
      const pct = Math.min(100, Math.max(0, (t / dur) * 100));
      const fill = document.getElementById('mh-progress-fill');
      if (fill) fill.style.width = pct + '%';
      const knob = document.getElementById('mh-progress-knob');
      if (knob) knob.style.left = pct + '%';
      const bar = document.getElementById('mh-progress');
      if (bar) bar.setAttribute('aria-valuenow', Math.round(pct));
      const time = document.getElementById('mh-time');
      if (time) time.textContent = mafiaHowToFormatTime(t);

      // When audio ends, pin the end card.
      if (audio.ended) {
        const btn = document.getElementById('mh-play-pause');
        if (btn) btn.classList.add('is-paused');
        // Stay on end scene — don't tick further until user replays/closes.
        mafiaHowToStopTicker();
        return;
      }
      mafiaHowToRafId = requestAnimationFrame(mafiaHowToTick);
    }
    function mafiaHowToStartTicker(){
      mafiaHowToStopTicker();
      mafiaHowToRafId = requestAnimationFrame(mafiaHowToTick);
    }
    function mafiaHowToStopTicker(){
      if (mafiaHowToRafId) { cancelAnimationFrame(mafiaHowToRafId); mafiaHowToRafId = null; }
    }

    // ----- Progress-bar scrubbing (click to seek, drag to scrub) -----
    // Pointer Events are used so the same code path covers mouse, touch, and
    // pen. Browsers without PointerEvent (very old) get nothing — graceful
    // degradation back to a non-scrubbable bar, same as before this change.
    //
    // While scrubbing, the audio is paused (regardless of prior state) so the
    // user can drag without stutter. On release, playback resumes ONLY if it
    // was playing before the scrub started. This matches YouTube / native
    // <video> scrub behavior.
    let _mhScrubbing = false;
    let _mhResumePlaying = false;

    function mafiaHowToWireScrubber(){
      const bar = document.getElementById('mh-progress');
      const audio = document.getElementById('mh-audio');
      if (!bar || !audio || bar.dataset.wired === '1') return;
      bar.dataset.wired = '1';

      if (!('PointerEvent' in window)) return;  // unsupported — leave the bar inert

      const seekFromEvent = (ev) => {
        const rect = bar.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const pct = Math.min(1, Math.max(0, x / rect.width));
        const dur = audio.duration || 58.7;
        audio.currentTime = pct * dur;
        // Force an immediate visual sync — scene + fill + label all update
        // without waiting for the next rAF tick.
        if (typeof mafiaHowToTick === 'function') {
          // tick() reschedules itself; only do that if the audio is playing
          // (otherwise we'd start a runaway loop while paused). Call the
          // body inline via a one-shot frame.
          requestAnimationFrame(mafiaHowToTick);
        }
      };

      bar.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        _mhScrubbing = true;
        _mhResumePlaying = !audio.paused;
        audio.pause();
        bar.classList.add('is-scrubbing');
        bar.setPointerCapture(ev.pointerId);  // pointermove keeps firing even if user drags off the bar
        seekFromEvent(ev);
      });

      bar.addEventListener('pointermove', (ev) => {
        if (!_mhScrubbing) return;
        seekFromEvent(ev);
      });

      const endScrub = (ev) => {
        if (!_mhScrubbing) return;
        _mhScrubbing = false;
        bar.classList.remove('is-scrubbing');
        try { bar.releasePointerCapture(ev.pointerId); } catch(e){}
        // If audio ended exactly at the scrub target, leave the end card
        // showing rather than auto-replaying.
        if (_mhResumePlaying && audio.currentTime < (audio.duration || 0) - 0.1) {
          audio.play().catch(()=>{});
          const btn = document.getElementById('mh-play-pause');
          if (btn) btn.classList.remove('is-paused');
          mafiaHowToStartTicker();
        } else {
          // Paused state — re-sync visuals once and stop the ticker.
          if (typeof mafiaHowToTick === 'function') requestAnimationFrame(mafiaHowToTick);
          if (audio.paused) {
            const btn = document.getElementById('mh-play-pause');
            if (btn) btn.classList.add('is-paused');
          }
        }
      };
      bar.addEventListener('pointerup', endScrub);
      bar.addEventListener('pointercancel', endScrub);

      // Keyboard accessibility — left/right arrows skip ±5s.
      bar.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        const delta = ev.key === 'ArrowRight' ? 5 : -5;
        const dur = audio.duration || 58.7;
        audio.currentTime = Math.min(dur, Math.max(0, audio.currentTime + delta));
        if (typeof mafiaHowToTick === 'function') requestAnimationFrame(mafiaHowToTick);
      });
    }

    async function openLiarLobby(){
      // Drop any seat we still hold in OTHER game lobbies before claiming
      // one here — invariant: one user, one seat across all games.
      try { huddleLeaveOtherGameSeats('liar'); } catch(e){}
      liarMe.selectedCardIds = [];

      // Priority order for which room to load:
      //   1) ?room=CODE in the URL bar (QR scan / shared link)
      //   2) most-recent room from localStorage (returning visit on same device)
      //   3) fall through → create a fresh room
      const urlRoom = liarReadUrlRoom();
      const existingCode = urlRoom || liarFindRecentRoomCode();

      // Fire auth + room-load IN PARALLEL. RLS is open on liar_rooms (prototype),
      // so the SELECT doesn't actually need auth to complete — we can overlap them.
      // This roughly halves the perceived load time on first visit.
      const authPromise = liarBootstrap();
      const loadPromise = existingCode ? liarLoadRoom(existingCode) : Promise.resolve(false);
      await authPromise;
      const sessionId = liarGetSessionId();
      const loaded = await loadPromise;

      // Invitee arrived via URL but the room load failed — surface it and
      // route to Games instead of silently creating a fresh room.
      if (urlRoom && !loaded) {
        try { history.replaceState(history.state, '', '/'); } catch(e){}
        if (typeof showLobbyToast === 'function') {
          try { showLobbyToast(t('lobby.joinFailed')); } catch(e){}
        }
        goTo('games');
        return;
      }

      let cachedRoomGone = !!existingCode && !loaded;

      if (loaded) {
        const claimed = Object.entries(liarState.claimedBy || {}).find(([pid, sid]) => sid === sessionId);
        liarMe.myId = claimed ? claimed[0] : null;
        if (liarMe.myId) {
          // Returning to a room we already own a seat in (refresh / re-open).
          try { huddlePersistLastRoom('liar',existingCode); } catch(e){}
        } else if (urlRoom) {
          // Intentional join via URL/invite — keep the cached code.
          try { huddlePersistLastRoom('liar',existingCode); } catch(e){}
        } else {
          // Cached room but we have no claim and no invite — don't barge in.
          try { huddleClearLastRoom('liar'); } catch(e){}
          await liarStateReset(generateCode());
          cachedRoomGone = true;
        }

        // === Reconnect protection ===
        // If we returned to a room that's already mid-game (play / reveal / cup)
        // but we no longer own a seat, don't strand the user on a "Waiting for X"
        // screen they can't act on. This happens when:
        //   (a) Supabase anonymous auth is disabled / failing → sessionId is
        //       random per tab → no claim ever matches across reloads.
        //   (b) Another peer's presence cleanup freed our claim while we were
        //       offline, then everyone else also left, so nothing reaped the
        //       remaining claims (peer-driven cleanup needs at least one online
        //       peer — see liarHandleConfirmedDisconnect's `isMyJobToWrite`).
        // Either way the user can't participate. Bounce to Games with a toast
        // so they see "game is over" instead of phantom players.
        const inGamePhase = liarState.phase
          && liarState.phase !== 'lobby'
          && liarState.phase !== 'result';
        if (inGamePhase && !liarMe.myId) {
          if (typeof showLobbyToast === 'function') {
            try { showLobbyToast(t('liar.toastReconnectStale'), 4500); } catch(e){}
          }
          liarForceLeaveLocal();
          return;
        }
      } else {
        const code = generateCode();
        await liarStateReset(code);
      }

      // Subscribe to Realtime for THIS room (idempotent — no-op if already subscribed).
      liarWireSync();

      // Auto-claim first empty seat so the user doesn't have to tap a tile.
      // Awaited so the seat commits before render — see hotAutoClaimIfNeeded
      // for the "joiner had to refresh" race this fixes.
      await liarAutoClaimIfNeeded();

      // Sync the URL bar so the host can share their browser URL directly.
      liarSyncUrlToRoom(liarState.code);

      // Update lobby DOM
      document.getElementById('liar-room-code').textContent = liarState.code;
      const fb = document.getElementById('liar-room-qr-fallback');
      if (fb) fb.classList.remove('show');
      // QR encodes the full join URL so scanning it on a phone opens
      // roundlly.com/?room=CODE and auto-joins this exact room.
      setRoomQrSrc(document.getElementById('liar-room-qr'), qrUrl(liarJoinUrl(liarState.code)));

      liarUpdateHowToTrigger();
      // Phase may have been advanced by another device — render whatever is current
      liarRerender();

      if (cachedRoomGone && typeof showLobbyToast === 'function') {
        showLobbyToast(t('lobby.previousRoomGone'));
      }
    }

    async function liarStateReset(code){
      // Wipe and seed a fresh room. Called when no existing room is found, or when
      // "Regenerate room code" is tapped. The creator owns host AND seat 0
      // immediately so the first persist is a single atomic write — an invitee
      // can never load a partial state and grab the host role or seat 0.
      const playersCopy = JSON.parse(JSON.stringify(PLAYERS));
      const sid = liarGetSessionId();
      const firstSeat = playersCopy[0] && playersCopy[0].id;
      Object.keys(liarState).forEach(k => delete liarState[k]);
      Object.assign(liarState, {
        code: code,
        phase: 'lobby',
        hostId: sid,
        claimedBy: firstSeat ? { [firstSeat]: sid } : {},
        players: playersCopy,
        alivePlayers: playersCopy.map(p => p.id),
        hands: {},
        pile: [],
        lastPlay: null,
        tableCard: 'K',
        currentPlayerIdx: 0,
        cupSpills: 1,
        pendingLoserId: null,
        pendingLoserCause: null,
        sipOutcome: null,
        sipChamberIdx: null,
        sipChamberIsSpill: [],
        sipTaken: false,
        wins: Object.fromEntries(playersCopy.map(p => [p.id, 0])),
        winnerId: null,
        roundCount: 0,
        revision: 0,
      });
      liarMe.myId = firstSeat || null;
      // Server-validated room creation (C2: closes direct-write hole). The
      // server inserts the row with this initial state under SECURITY DEFINER;
      // the realtime echo delivers canonical state back to this device.
      if (!liarState.labMode) {
        const snapshot = JSON.parse(JSON.stringify(liarState));
        huddleCallRPC('huddle_create_room', {
          p_table: 'liar_rooms',
          p_code: code,
          p_initial_state: snapshot,
        });
      }
      // Cache "last room I was in" for the next visit on this device
      try { huddlePersistLastRoom('liar',code); } catch(e){}
    }

    function liarFindRecentRoomCode(){
      try {
        return huddleReadLastRoom('liar');
      } catch(e){ return null; }
    }

    // Generate a fresh room code (anyone can tap; resets the room for everyone)
    async function regenerateLiarRoom_v2(){
      const code = generateCode();
      await liarStateReset(code);
      // Resubscribe to the NEW room code's Realtime channel
      liarWireSync();
      liarSyncUrlToRoom(code);
      document.getElementById('liar-room-code').textContent = code;
      const fb = document.getElementById('liar-room-qr-fallback');
      if (fb) fb.classList.remove('show');
      setRoomQrSrc(document.getElementById('liar-room-qr'), qrUrl(liarJoinUrl(code)));
      const btn = document.querySelector('#screen-liar-lobby .room-code-action button[data-action*="regenerateLiarRoom"]');
      if (btn) {
        btn.classList.remove('spinning');
        void btn.offsetWidth;
        btn.classList.add('spinning');
        setTimeout(() => btn.classList.remove('spinning'), 520);
      }
      liarRerender();
    }

    async function liarClaimSeat(playerId){
      const sessionId = liarGetSessionId();
      const currentClaim = liarState.claimedBy[playerId];
      // If someone else holds this seat, ignore
      if (currentClaim && currentClaim !== sessionId) return;
      // Optimistic local update for snappy UI — if the RPC rejects, the next
      // realtime echo will overwrite this with the canonical server state.
      if (liarMe.myId && liarState.claimedBy[liarMe.myId] === sessionId) {
        delete liarState.claimedBy[liarMe.myId];
      }
      liarState.claimedBy[playerId] = sessionId;
      if (!liarState.hostId) liarState.hostId = sessionId;
      liarMe.myId = playerId;
      liarRenderSeats();
      // Server-validated claim. RPC handles seat-switching (releases old seat
      // held by caller) and rejects seat-stealing attempts at the database
      // layer (C2 turn 2).
      await huddleCallRPC('huddle_claim_seat', {
        p_table: 'liar_rooms',
        p_code: liarState.code,
        p_player_id: playerId,
      });
    }

    async function liarAutoClaimIfNeeded(){
      return huddleAutoClaimIfNeeded(liarMe, liarState, liarClaimSeat);
    }

    function liarRenderSeats(){
      const el = document.getElementById('liar-seats');
      if (el && huddleLobbyHydrating(liarState && liarState.code)) {
        el.innerHTML = huddleLobbySkeletonHTML(6);
        return;
      }
      if (!el) return;
      const sessionId = liarGetSessionId();
      const claimedCount = Object.keys(liarState.claimedBy || {}).length;
      const claimedSessionIds = Object.values(liarState.claimedBy || {});
      ensureClaimantProfiles(claimedSessionIds, liarRenderSeats);
      // Prefer @username (globally unique) over display_name first-word so
      // two players with the same first name render distinctly. See
      // claimDisplayName for the matching rule on OTHER players' tiles.
      const myName = (myProfile && myProfile.username)
        ? '@' + myProfile.username
        : ((myProfile && myProfile.name && myProfile.name.trim().split(/\s+/)[0]) || 'You');
      const myAvatar = (myProfile && myProfile.avatar) ? myProfile.avatar : null;
      el.innerHTML = liarState.players.map(p => {
        const claimedSession = liarState.claimedBy[p.id];
        const claimedByMe = claimedSession === sessionId;
        const claimedByOther = !!claimedSession && !claimedByMe;
        const claimProfile = claimedByOther ? profileForClaim(claimedSession) : null;

        // Empty seat → render an Invite tile (not a claim button). Tapping it
        // opens the invite sheet so the user fills the seat with a real friend
        // instead of "claiming" a fake-named slot.
        if (!claimedSession) {
          return `
            <button class="liar-seat liar-seat-invite" type="button" data-action="openLobbyInviteSheet" data-arg="liar" data-empty="1">
              <span class="liar-seat-invite-icon" aria-hidden="true">+</span>
              <div class="liar-seat-info">
                <div class="liar-seat-name" data-i18n="liar.seatInviteTap">Invite friend</div>
                <div class="liar-seat-status" data-i18n="liar.seatEmpty">Empty seat</div>
              </div>
            </button>
          `;
        }

        // Claimed seat — render with the claimant's REAL identity (no Maria/Kenji).
        let cls = 'liar-seat';
        let status, nameText, avatarData;
        if (claimedByMe) {
          cls += ' claimed-by-me';
          status = t('liar.seatYou');
          nameText = myName;
          avatarData = myAvatar || avatarForPlayer(p);
        } else {
          cls += ' claimed-by-other';
          status = t('liar.seatTaken');
          nameText = claimDisplayName(claimProfile, '…');
          avatarData = (claimProfile && claimProfile.avatar) ? claimProfile.avatar : avatarForPlayer(p);
        }
        return `
          <div class="${cls}" data-seat-id="${p.id}">
            ${avatarHTML(avatarData, 32, { fallback: p.initial })}
            <div class="liar-seat-info">
              <div class="liar-seat-name">${escapeHTML(nameText)}</div>
              <div class="liar-seat-status">${status}</div>
            </div>
            ${claimedByMe ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--success);flex-shrink:0"><path d="M20 6 9 17l-5-5"></path></svg>' : ''}
          </div>
        `;
      }).join('');
      parseEmoji(el);
      // Apply translations to any new data-i18n nodes inside the freshly-rendered seats
      if (typeof applyLang === 'function') applyLang(el);

      // Update start-button state — need at least 2 seats claimed AND I have a seat
      const startBtn = document.getElementById('liar-start-btn');
      if (startBtn) {
        const canStart = claimedCount >= 2 && !!liarMe.myId;
        if (canStart) startBtn.removeAttribute('aria-disabled');
        else          startBtn.setAttribute('aria-disabled', 'true');
      }
      // Update the seats-status hint
      const hint = document.getElementById('liar-seats-hint');
      if (hint) {
        if (!liarMe.myId) hint.textContent = t('liar.seatsHintNotPicked');
        else if (claimedCount < 2) hint.textContent = t('liar.seatsHintNeedMore', { n: 2 - claimedCount });
        else hint.textContent = t('liar.seatsHintReady');
      }
      // Leave / Reset visibility — now in the top-right of the Players header
      const leaveBtn = document.getElementById('liar-leave-btn');
      const hasSeat = !!liarMe.myId;
      if (leaveBtn) leaveBtn.hidden = !hasSeat;
      // Keep the invite sheet content fresh if it's open (e.g. a friend just
      // joined / accepted / cancelled). Cheap if sheet is closed.
      if (typeof refreshLobbyInviteSheetIfOpen === 'function') refreshLobbyInviteSheetIfOpen('liar');
    }

