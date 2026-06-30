// Huddle app-09-shared-sheets-liar-cup.js (fragment 9/10, split from app.js).
// All fragments share ONE global scope and MUST load in numeric order — do not reorder.

    // ---------- Lobby invite sheet (shared across all 3 game lobbies) ----------
    // Opened when a player taps an empty seat tile in any lobby. Surfaces the
    // friends list (with per-friend Invite buttons), or a graceful fallback
    // when the user has no friends yet (room code + go-to-friends CTA), or a
    // sign-in nudge for anonymous users.
    let lobbyInviteSheetGameKey = null;
    function openLobbyInviteSheet(gameKey){
      const bd = document.getElementById('lobby-invite-backdrop');
      if (!bd) return;
      lobbyInviteSheetGameKey = gameKey;
      // Fresh search state on every open — stale filter from a previous session would
      // surprise the user ("why don't I see anyone?").
      lobbyInviteSearchQuery = '';
      lobbyInviteSearchFocused = false;
      renderLobbyInviteSheetContent(gameKey);
      bd.classList.add('active');
    }
    function closeLobbyInviteSheet(event){
      if (event && event.currentTarget !== event.target) return;
      const bd = document.getElementById('lobby-invite-backdrop');
      if (bd) bd.classList.remove('active');
      lobbyInviteSheetGameKey = null;
      lobbyInviteSearchQuery = '';
      lobbyInviteSearchFocused = false;
    }
    function refreshLobbyInviteSheetIfOpen(gameKey){
      const bd = document.getElementById('lobby-invite-backdrop');
      if (!bd || !bd.classList.contains('active')) return;
      // If a specific game asked to refresh, only do so when that's the open one.
      if (gameKey && gameKey !== lobbyInviteSheetGameKey) return;
      renderLobbyInviteSheetContent(lobbyInviteSheetGameKey);
    }
    function renderLobbyInviteSheetContent(gameKey){
      const wrap = document.getElementById('lobby-invite-sheet-content');
      if (!wrap) return;
      const ctx = (typeof inviteLobbyContextForGame === 'function') ? inviteLobbyContextForGame(gameKey) : null;
      const code = (ctx && ctx.code) ? ctx.code : '';

      // Anonymous user — friend invites need a real account, so nudge sign-in.
      if (typeof friendsState === 'undefined' || !friendsState.me) {
        wrap.innerHTML = `
          <div style="padding:8px 0 4px">
            <div style="font-size:14px;color:var(--text-secondary);line-height:1.5;margin-bottom:14px">${friendsEscape(t('lobby.inviteSignInPrompt'))}</div>
            <button class="btn btn-primary" style="width:100%" onclick="closeLobbyInviteSheet();goTo('login')">${friendsEscape(t('login.signIn'))}</button>
            ${code ? `<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary);text-align:center;line-height:1.5">${friendsEscape(t('lobby.inviteShareInstead'))}<br><strong style="color:var(--text);font-size:16px;letter-spacing:.05em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${friendsEscape(code)}</strong></div>` : ''}
          </div>`;
        return;
      }

      // Signed in but no friends yet — point at the Friends tab.
      if (!friendsState.friends || friendsState.friends.length === 0) {
        wrap.innerHTML = `
          <div style="padding:8px 0 4px">
            <div style="font-size:14px;color:var(--text-secondary);line-height:1.5;margin-bottom:14px">${friendsEscape(t('lobby.inviteNoFriendsYet'))}</div>
            <button class="btn btn-primary" style="width:100%" onclick="closeLobbyInviteSheet();goTo('friends')">${friendsEscape(t('friends.addFriend'))}</button>
            ${code ? `<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary);text-align:center;line-height:1.5">${friendsEscape(t('lobby.inviteShareInstead'))}<br><strong style="color:var(--text);font-size:16px;letter-spacing:.05em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${friendsEscape(code)}</strong></div>` : ''}
          </div>`;
        return;
      }

      // Real friends list — per-friend tile with Invite/Invited/Joined action.
      // Search threshold: hide the input below 5 friends (scanning is faster than typing
      // at that point); show it once the list crosses the scan-friction line.
      const SEARCH_THRESHOLD = 5;
      const showSearch = friendsState.friends.length >= SEARCH_THRESHOLD;
      const query = (lobbyInviteSearchQuery || '').trim().toLowerCase();
      const claimedSessions = Object.values((ctx && ctx.claimedBy) || {});

      const visible = !query ? friendsState.friends : friendsState.friends.filter(entry => {
        const p = entry.profile;
        const name = (friendsDisplayName(p) || '').toLowerCase();
        const uname = (p.username || '').toLowerCase();
        return name.indexOf(query) !== -1 || uname.indexOf(query) !== -1;
      });

      // Sort into Online / Offline buckets using the existing friendsPresence Set populated
      // by friendsWirePresence(). Online friends bubble to the top so the host can invite
      // people who can actually join in real time. Each bucket sorted by display name.
      const presence = (typeof friendsPresence !== 'undefined') ? friendsPresence : new Set();
      const byName = (a, b) => friendsDisplayName(a.profile).localeCompare(friendsDisplayName(b.profile), undefined, { sensitivity: 'base' });
      const onlineEntries = visible.filter(e => presence.has(e.otherId)).slice().sort(byName);
      const offlineEntries = visible.filter(e => !presence.has(e.otherId)).slice().sort(byName);

      const renderRow = (entry) => {
        const p = entry.profile;
        const name = friendsDisplayName(p);
        const handle = p.username ? '@' + p.username : '';
        const avatar = p.avatar || deterministicAvatar(entry.otherId);
        const isOnline = presence.has(entry.otherId);
        const outgoing = invitesState.outgoing.find(o =>
          o.row.to_user_id === entry.otherId && o.row.room_code === code && o.row.game === gameKey
        );
        const isJoined = claimedSessions.indexOf(entry.otherId) !== -1;
        let actionHtml;
        if (isJoined) {
          actionHtml = `<span class="lobby-invite-btn joined" aria-disabled="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            ${friendsEscape(t('invite.joined'))}
          </span>`;
        } else if (outgoing) {
          // Suppress the Cancel button while the entry is still optimistic
          // (no server-issued id yet — Cancel would error). Cancel re-appears
          // a tick later when invitesLoad() replaces this with the canonical
          // row. Practically invisible to the user — the optimistic window
          // is ~200-500ms.
          const showCancel = !(outgoing.row && outgoing.row._optimistic);
          actionHtml = `
            <span class="lobby-invite-btn invited" aria-disabled="true">${friendsEscape(t('invite.invited'))}</span>
            ${showCancel ? `<button class="lobby-invite-cancel" onclick="inviteCancel('${friendsEscape(outgoing.row.id)}', event)">${friendsEscape(t('invite.cancel'))}</button>` : ''}
          `;
        } else {
          actionHtml = `<button class="lobby-invite-btn" onclick="inviteSend('${friendsEscape(entry.otherId)}', '${friendsEscape(code)}', '${friendsEscape(gameKey)}', event)">${friendsEscape(t('invite.invite'))}</button>`;
        }
        return `
          <div class="lobby-invite-tile ${isOnline ? 'is-online' : 'is-offline'}">
            ${avatarHTML(avatar, 36, { fallback: (name[0] || '?').toUpperCase(), online: isOnline })}
            <div class="friend-info">
              <div class="friend-name">${friendsEscape(name)}</div>
              <div class="friend-status">${friendsEscape(handle)}</div>
            </div>
            <div class="lobby-invite-actions">${actionHtml}</div>
          </div>
        `;
      };

      // Only show section headers when both buckets have entries — saves vertical space
      // when everyone happens to be online or everyone is offline.
      const showHeaders = onlineEntries.length > 0 && offlineEntries.length > 0;
      let rows = '';
      if (onlineEntries.length) {
        if (showHeaders) {
          rows += `<div class="lobby-invite-section">${friendsEscape(t('lobby.inviteOnline'))} <span class="lobby-invite-section-count">· ${onlineEntries.length}</span></div>`;
        }
        rows += onlineEntries.map(renderRow).join('');
      }
      if (offlineEntries.length) {
        if (showHeaders) {
          rows += `<div class="lobby-invite-section">${friendsEscape(t('lobby.inviteOffline'))} <span class="lobby-invite-section-count">· ${offlineEntries.length}</span></div>`;
        }
        rows += offlineEntries.map(renderRow).join('');
      }

      const searchHtml = showSearch ? `
        <div class="lobby-invite-search-wrap">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="text" class="lobby-invite-search" id="lobby-invite-search-input"
                 placeholder="${friendsEscape(t('lobby.inviteSearchPlaceholder'))}"
                 value="${friendsEscape(lobbyInviteSearchQuery || '')}"
                 oninput="lobbyInviteOnSearchInput(this.value)" autocomplete="off" />
        </div>
      ` : '';

      const listHtml = visible.length === 0
        ? `<div class="lobby-invite-no-match">${friendsEscape(t('lobby.inviteNoMatch', { q: lobbyInviteSearchQuery || '' }))}</div>`
        : `<div class="lobby-invite-list">${rows}</div>`;

      wrap.innerHTML = searchHtml + listHtml;
      parseEmoji(wrap);

      // Restore caret to end of search input after re-render so typing isn't interrupted.
      if (showSearch) {
        const input = document.getElementById('lobby-invite-search-input');
        if (input && document.activeElement !== input && lobbyInviteSearchFocused) {
          input.focus();
          const v = input.value; input.value = ''; input.value = v;
        }
      }
    }

    // Search state lives outside the render function so it survives re-renders triggered
    // by invite-state updates (e.g. when an outgoing invite resolves). Without this, typing
    // would be lost the moment another player joined the room.
    let lobbyInviteSearchQuery = '';
    let lobbyInviteSearchFocused = false;
    function lobbyInviteOnSearchInput(v){
      lobbyInviteSearchQuery = v;
      lobbyInviteSearchFocused = true;
      renderLobbyInviteSheetContent(lobbyInviteSheetGameKey);
    }

    async function liarLeaveRoom(context){
      return huddleLeaveRoom({
        meObj: liarMe, gameState: liarState, sidFn: cardLobbyGetSessionId,
        table: 'liar_rooms', gameToken: 'liar', lastRoomKey: 'liar', context,
        // Cancel pending auto-advance timers + kill queued/in-flight SFX so
        // leaving mid-animation doesn't push state into a room we left or leave
        // the cup ticking/draining in the background.
        preLeave: () => { liarClearAllAutoAdvance(); liarStopAllSfx(); },
        teardown: () => {
          if (_cardLobbyChannel) {
            try { _cardLobbyChannel.untrack(); } catch(e){}
            try { window.sb.removeChannel(_cardLobbyChannel); } catch(e){}
            _cardLobbyChannel = null; _cardLobbyChannelCode = null; _cardLobbyChannelSessionId = null;
            cardLobbyResetPresenceState();
          }
        },
      });
    }
    // Local-only cleanup (no Supabase write). Used when host closes the room
    // and when a non-host receives the "closedByHost" broadcast.
    function cardLobbyForceLeaveLocal(){
      liarClearAllAutoAdvance();
      liarStopAllSfx();
      liarMe.myId = null;
      if (liarState) liarState.code = null;
      try { huddleClearLastRoom('liar'); } catch(e){}
      if (_cardLobbyChannel) {
        try { _cardLobbyChannel.untrack(); } catch(e){}
        try { window.sb.removeChannel(_cardLobbyChannel); } catch(e){}
        _cardLobbyChannel = null; _cardLobbyChannelCode = null; _cardLobbyChannelSessionId = null;
        cardLobbyResetPresenceState();
      }
      try { history.replaceState(history.state, '', '/'); } catch(e){}
      goTo('games');
    }
    // Host taps "Leave" on the game-over screen → close the whole room so
    // every other player auto-leaves too via Realtime.
    function liarCloseRoom(){
      const amHost = cardLobbyGetSessionId() === liarState.hostId;
      if (!amHost) { liarLeaveGameOver(); return; }
      const closingCode = liarState.code;
      // Optimistic local change so the UI reflects "closed" immediately.
      liarState.closedByHost = true;
      liarState.hostId = null;
      // Server-validated close (host-only; other claimants reject) — C2 turn 2.
      if (closingCode) {
        huddleCallRPC('huddle_close_room', { p_table: 'liar_rooms', p_code: closingCode });
      }
      cardLobbyForceLeaveLocal();
    }
    // No-confirm leave for the game-over screen (mirror of liarLeaveRoom).
    function liarLeaveGameOver(){
      liarClearAllAutoAdvance();
      liarStopAllSfx();
      const mySid = cardLobbyGetSessionId();
      const myPlayerId = liarMe.myId;
      const leavingCode = liarState.code;
      // Optimistic local update before the RPC (mirrors liarLeaveRoom path).
      if (myPlayerId && liarState.claimedBy && liarState.claimedBy[myPlayerId] === mySid) {
        delete liarState.claimedBy[myPlayerId];
      }
      if (liarState.hostId === mySid) {
        const remaining = Object.entries(liarState.claimedBy || {})
          .sort((a, b) => a[0].localeCompare(b[0]));
        liarState.hostId = remaining.length ? remaining[0][1] : null;
      }
      // Server-validated leave (C2 turn 2).
      if (leavingCode) {
        huddleCallRPC('huddle_leave_seat', { p_table: 'liar_rooms', p_code: leavingCode });
      }
      liarMe.myId = null;
      liarState.code = null;
      try { huddleClearLastRoom('liar'); } catch(e){}
      if (_cardLobbyChannel) {
        try { _cardLobbyChannel.untrack(); } catch(e){}
        try { window.sb.removeChannel(_cardLobbyChannel); } catch(e){}
        _cardLobbyChannel = null; _cardLobbyChannelCode = null; _cardLobbyChannelSessionId = null;
        cardLobbyResetPresenceState();
      }
      try { history.replaceState(history.state, '', '/'); } catch(e){}
      goTo('games');
    }

    // Handler for the "Join with code" input — replaces our current room with the friend's.
    // ---------- Lobby toast (silent-loss notice + similar transient messages) ----------
    // Shown when a user clicks a game card / refreshes / scans an old QR for a
    // room that no longer exists in Supabase — openX silently creates a fresh
    // room, but without this toast the user thinks they're back with their
    // friends and can't tell why they're suddenly alone.
    let _lobbyToastTimer = null;
    let _lobbyToastQueue = [];
    let _lobbyToastActive = null;
    let _lobbyToastVisibilityBound = false;
    // Back arrow on any game lobby. We strip the ?room= URL param before
    // navigating — otherwise a stale URL would let the user re-enter the game
    // tile from the games screen and auto-claim a seat WITHOUT an invite (the
    // urlRoom check in openLobby treats a URL as "intentional join"). The user
    // still has localStorage if they're a returning seated player, so legit
    // refresh-to-resume keeps working.
    function backFromGameLobby(target){
      try { history.replaceState(history.state, '', '/'); } catch(e){}
      goTo(target || 'games');
    }
    function showLobbyToast(text, durationMs){
      if (!text) return;
      const duration = durationMs || 6000;
      // If a toast is already on screen, queue this one instead of
      // clobbering — back-to-back events (e.g. two Liar players quitting
      // seconds apart) would otherwise lose the first message.
      // De-dupe identical consecutive messages so a chatty broadcast
      // doesn't pile up the same line.
      if (_lobbyToastActive) {
        const last = _lobbyToastQueue[_lobbyToastQueue.length - 1] || _lobbyToastActive;
        if (last && last.text === text) return;
        _lobbyToastQueue.push({ text: text, durationMs: duration });
        return;
      }
      _lobbyToastRender({ text: text, durationMs: duration });
    }
    function _lobbyToastRender(entry){
      let el = document.getElementById('lobby-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'lobby-toast';
        el.className = 'lobby-toast';
        el.setAttribute('role', 'status');
        el.onclick = function(){ hideLobbyToast(); };
        document.body.appendChild(el);
      }
      el.textContent = entry.text;
      void el.offsetWidth;
      el.classList.add('active');
      _lobbyToastActive = {
        text: entry.text,
        durationMs: entry.durationMs,
        remainingMs: entry.durationMs,
        startedAt: Date.now()
      };
      _lobbyToastStartTimer();
      _lobbyToastBindVisibility();
    }
    function _lobbyToastStartTimer(){
      if (_lobbyToastTimer) { clearTimeout(_lobbyToastTimer); _lobbyToastTimer = null; }
      if (!_lobbyToastActive) return;
      _lobbyToastActive.startedAt = Date.now();
      _lobbyToastTimer = setTimeout(hideLobbyToast, _lobbyToastActive.remainingMs);
    }
    function _lobbyToastPause(){
      if (!_lobbyToastActive || !_lobbyToastTimer) return;
      clearTimeout(_lobbyToastTimer);
      _lobbyToastTimer = null;
      const elapsed = Date.now() - _lobbyToastActive.startedAt;
      _lobbyToastActive.remainingMs = Math.max(0, _lobbyToastActive.remainingMs - elapsed);
    }
    function _lobbyToastBindVisibility(){
      if (_lobbyToastVisibilityBound) return;
      _lobbyToastVisibilityBound = true;
      document.addEventListener('visibilitychange', function(){
        if (document.hidden) {
          _lobbyToastPause();
        } else if (_lobbyToastActive) {
          _lobbyToastStartTimer();
        }
      });
    }
    function hideLobbyToast(){
      const el = document.getElementById('lobby-toast');
      if (el) el.classList.remove('active');
      if (_lobbyToastTimer) { clearTimeout(_lobbyToastTimer); _lobbyToastTimer = null; }
      _lobbyToastActive = null;
      // Wait out the 250ms fade-out before showing the next queued toast
      // so the two don't visually collide / swap mid-animation.
      if (_lobbyToastQueue.length) {
        setTimeout(function(){
          if (_lobbyToastActive) return;
          const next = _lobbyToastQueue.shift();
          if (next) _lobbyToastRender(next);
        }, 300);
      }
    }

    // ===== Host controls: Kick + Lobby Lock (Batch 2, 2026-06-27) =====
    // Shared by all 4 games' lobbies. Server-enforced in db/fix/06
    // (huddle_<game>_kick / huddle_set_room_lock); these confirm + call the RPC,
    // then the realtime echo re-renders. gameToken in {hot, cham, liar, mafia}.
    const HUDDLE_ROOM_TABLES = { hot:'hotseat_rooms', cham:'chameleon_rooms', liar:'liar_rooms', mafia:'mafia_rooms' };
    function huddleGameStateFor(gameToken){
      if (gameToken === 'hot')   return (typeof state      !== 'undefined') ? state      : null;
      if (gameToken === 'cham')  return (typeof chamState  !== 'undefined') ? chamState  : null;
      if (gameToken === 'liar')  return (typeof liarState  !== 'undefined') ? liarState  : null;
      if (gameToken === 'mafia') return (typeof mafiaState !== 'undefined') ? mafiaState : null;
      return null;
    }
    function huddleSeatDisplayName(gameToken, playerId){
      const st = huddleGameStateFor(gameToken);
      if (!st) return '';
      try {
        const sid = st.claimedBy && st.claimedBy[playerId];
        if (sid && typeof profileForClaim === 'function') {
          const prof = profileForClaim(sid);
          if (prof && typeof claimDisplayName === 'function') { const n = claimDisplayName(prof, ''); if (n) return n; }
        }
      } catch(e){}
      try { const p = (st.players || []).find(x => x.id === playerId); if (p && p.name) return p.name; } catch(e){}
      return '';
    }
    // Host removes a seated player. Confirms, then calls the per-game kick RPC.
    async function huddleHostKick(gameToken, playerId){
      const st = huddleGameStateFor(gameToken);
      if (!st || !st.code || !playerId) return;
      const name = huddleSeatDisplayName(gameToken, playerId) || (t('common.otherPlayer') || 'this player');
      const ok = await huddleConfirm({
        title: t('lobby.kickTitle', { name: name }),
        body: t('lobby.kickBody'),
        confirmLabel: t('lobby.kickConfirm'),
        cancelLabel: t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      const res = await huddleCallRPC('huddle_' + gameToken + '_kick', { p_code: st.code, p_player_id: playerId });
      if (res && res.error) {
        console.warn('[Huddle] kick failed:', res.error.message || res.error);
        try { showLobbyToast(t('common.syncFailed'), 3000); } catch(e){}
      }
    }
    // Host toggles whether new players can join the room.
    async function huddleToggleLock(gameToken){
      const st = huddleGameStateFor(gameToken);
      if (!st || !st.code) return;
      const table = HUDDLE_ROOM_TABLES[gameToken];
      if (!table) return;
      const res = await huddleCallRPC('huddle_set_room_lock', { p_table: table, p_code: st.code, p_locked: !st.locked });
      if (res && res.error) {
        console.warn('[Huddle] lock toggle failed:', res.error.message || res.error);
        try { showLobbyToast(t('common.syncFailed'), 3000); } catch(e){}
      }
    }
    // Each game's lobby render calls this to refresh its lock button (host-only;
    // label reflects state.locked). btnId is the per-game button element id.
    function huddleUpdateLockBtn(btnId, gameToken, amHost){
      const btn = document.getElementById(btnId);
      if (!btn) return;
      const st = huddleGameStateFor(gameToken);
      if (!amHost || !st || !st.code) { btn.style.display = 'none'; return; }
      btn.style.display = '';
      btn.textContent = st.locked ? t('lobby.unlockRoom') : t('lobby.lockRoom');
      btn.classList.toggle('is-locked', !!st.locked);
    }
    // Kick "×" button HTML for a claimed-by-other seat. The host-only caller
    // decides whether to include it. playerId is a safe slot id ('p3'); the
    // gameToken is a literal — no user input in the onclick, so no XSS risk.
    function huddleKickBtnHTML(gameToken, playerId){
      return '<button class="lobby-kick-btn" type="button" aria-label="' + escapeHTML(t('lobby.kick')) +
             '" title="' + escapeHTML(t('lobby.kick')) + '" onclick="event.stopPropagation(); huddleHostKick(\'' +
             gameToken + '\',\'' + playerId + '\')">×</button>';
    }

    // ---------- Global "Join with code" sheet (Games tab) ----------
    // Opened from the prominent tile at the top of the Games tab. Probes all
    // three game tables in parallel, finds the match, and routes the user into
    // the matching lobby — no need for the user to know which game their
    // friend is playing.
    function openJoinCodeSheet(){
      const bd = document.getElementById('join-code-backdrop');
      if (!bd) return;
      bd.classList.add('active');
      setJoinCodeStatus('', '');
      const input = document.getElementById('join-code-input');
      if (input) {
        input.value = '';
        setTimeout(() => { try { input.focus(); } catch(e){} }, 80);
      }
    }
    function closeJoinCodeSheet(event){
      if (event && event.currentTarget !== event.target) return;
      const bd = document.getElementById('join-code-backdrop');
      if (bd) bd.classList.remove('active');
    }
    function setJoinCodeStatus(text, kind){
      const el = document.getElementById('join-code-status');
      if (!el) return;
      el.textContent = text || '';
      el.className = 'join-code-status' + (kind ? ' ' + kind : '');
    }
    // Shared core for join-by-code, used by the Games-tab join sheet
    // (attemptJoinByCode). Probes all four game tables in parallel — first match
    // wins — then routes into the matching lobby.
    // opts: { setStatus(text,kind), btn, onEmpty(), onMatch(game,code) }
    async function huddleJoinByCodeCore(rawCode, opts){
      opts = opts || {};
      const setStatus = opts.setStatus || function(){};
      const btn = opts.btn || null;
      let code = (rawCode || '').toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
      // Auto-insert dash if user typed 8 alphanumerics in a row
      if (code.length === 8 && !code.includes('-')) {
        code = code.slice(0, 4) + '-' + code.slice(4);
      }
      // Empty-input hint — distinct copy so the Join button doesn't feel broken
      // when tapped without a code.
      if (!code) {
        setStatus(t('joinCode.enterCode'), 'error');
        if (opts.onEmpty) opts.onEmpty();
        return;
      }
      if (!window.sb) {
        setStatus(t('joinCode.networkError'), 'error');
        return;
      }
      // Disable the button while the probe runs so tapping it repeatedly
      // doesn't fire parallel queries against Supabase.
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy','true'); }
      setStatus(t('joinCode.checking'), 'searching');
      // Hard 6s timeout — prevents getting stuck on "Looking for the room…"
      // forever when the network is dead.
      const timeoutMs = 6000;
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('__timeout__')), timeoutMs));
      try {
        // Probe all four game tables in parallel — first match wins.
        const probe = Promise.all([
          window.sb.from('liar_rooms').select('code').eq('code', code).maybeSingle(),
          window.sb.from('hotseat_rooms').select('code').eq('code', code).maybeSingle(),
          window.sb.from('chameleon_rooms').select('code').eq('code', code).maybeSingle(),
          window.sb.from('mafia_rooms').select('code').eq('code', code).maybeSingle(),
        ]);
        const [liar, hot, cham, mafia] = await Promise.race([probe, timeout]);
        // A server-side error (not a null row — those are fine) means network
        // trouble, so the user knows to retry vs re-check the code.
        const probeErr = (liar && liar.error) || (hot && hot.error)
          || (cham && cham.error) || (mafia && mafia.error);
        if (probeErr) {
          console.warn('[Huddle] join-by-code probe error:', probeErr);
          setStatus(t('joinCode.networkError'), 'error');
          return;
        }
        let game = null;
        if (liar.data && liar.data.code === code) game = 'liar';
        else if (hot.data && hot.data.code === code) game = 'hotseat';
        else if (cham.data && cham.data.code === code) game = 'chameleon';
        else if (mafia.data && mafia.data.code === code) game = 'mafia';
        if (!game) {
          setStatus(t('joinCode.notFound'), 'error');
          return;
        }
        // Cache the code so the matching lobby's auto-load path picks it up
        try {
          if (game === 'liar')          huddlePersistLastRoom('liar',code);
          else if (game === 'hotseat')  huddlePersistLastRoom('hotseat',code);
          else if (game === 'chameleon') huddlePersistLastRoom('cham',code);
          else if (game === 'mafia')    huddlePersistLastRoom('mafia',code);
        } catch(e){}
        // Set URL BEFORE opening the lobby so the lobby's URL reader picks up
        // THIS code (not a stale one from a previous session).
        try {
          const url = '/?room=' + encodeURIComponent(code) + '&game=' + encodeURIComponent(game);
          history.replaceState(history.state || {}, '', url);
        } catch(e){}
        // Step 2: persist the guest's typed name into THIS room (stored server-side
        // keyed by the caller's own uid) so every player sees it on the guest's
        // seat. Also enforces no-duplicate names — on a clash the server returns
        // 'name_taken' and we make the user pick another instead of joining.
        const gname = (sessionStorage.getItem('huddle.guestName') || '').trim();
        if (gname) {
          const tableForGame = { liar:'liar_rooms', hotseat:'hotseat_rooms', chameleon:'chameleon_rooms', mafia:'mafia_rooms' };
          const nameRes = await huddleCallRPC('huddle_set_guest_name', { p_table: tableForGame[game], p_code: code, p_name: gname.slice(0, 24) });
          const nameErr = nameRes && nameRes.error;
          if (nameErr && /name_taken/.test(String((nameErr.message) || '') + String((nameErr.code) || ''))) {
            setStatus(t('login.nameTaken'), 'error');
            const nm = document.getElementById('login-guest-name');
            if (nm) { try { nm.focus(); if (nm.select) nm.select(); } catch(_){} }
            return; // abort the join — they need a different name
          }
          // Other (transient) errors don't block joining — they'd just be
          // nameless, which is recoverable; log and continue.
          if (nameErr) console.warn('[Huddle] set guest name failed:', nameErr);
        }
        if (opts.onMatch) opts.onMatch(game, code);
        if (game === 'liar')          openLiarLobby();
        else if (game === 'hotseat')  openLobby();
        else if (game === 'chameleon') openChamLobby();
        else if (game === 'mafia')    openMafiaLobby();
      } catch(e) {
        console.warn('[Huddle] join-by-code probe failed:', e);
        setStatus(t('joinCode.networkError'), 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
      }
    }

    // Games-tab sheet entry point — same behaviour as before, now delegating to
    // the shared core so the login screen can reuse the exact same routing.
    async function attemptJoinByCode(){
      const input = document.getElementById('join-code-input');
      if (!input) return;
      const btn = document.querySelector('#join-code-backdrop .btn-primary');
      await huddleJoinByCodeCore(input.value, {
        setStatus: setJoinCodeStatus,
        btn: btn,
        onEmpty: function(){ try { input.focus(); } catch(_){} },
        onMatch: function(){ closeJoinCodeSheet(); },
      });
    }

    function handleLiarQrError(){
      const img = document.getElementById('liar-room-qr');
      const fb = document.getElementById('liar-room-qr-fallback');
      if (img) img.style.display = 'none';
      if (fb) fb.classList.add('show');
    }

    // (Old single-device liarRenderPlayers removed — superseded by cardLobbyRenderSeats.)

    // ---------- How-to-play (4-slide animated modal, mirrors Hot Seat) ----------
    const LIAR_HOWTO_KEY = 'huddle.liarhowto.seen';
    const LIAR_HOWTO_TOTAL = 4;
    let liarHowtoCurrent = 1;
    let liarHowtoTimer = null;
    function liarUpdateHowToTrigger(){
      try {
        const seen = !!localStorage.getItem(LIAR_HOWTO_KEY);
        document.querySelectorAll('#liar-howto-trigger').forEach(el => el.classList.toggle('pulse', !seen));
      } catch(e){}
    }
    function openLiarHowTo(){
      document.getElementById('liar-howto-modal').classList.add('active');
      document.body.style.overflow = 'hidden';
      try { localStorage.setItem(LIAR_HOWTO_KEY, '1'); } catch(e){}
      document.querySelectorAll('#liar-howto-trigger').forEach(el => el.classList.remove('pulse'));
      liarGoToSlide(1);
    }
    function closeLiarHowTo(){
      document.getElementById('liar-howto-modal').classList.remove('active');
      document.body.style.overflow = '';
      liarStopAuto();
    }
    function liarGoToSlide(n){
      if (n < 1) n = 1;
      if (n > LIAR_HOWTO_TOTAL) { closeLiarHowTo(); return; }
      liarHowtoCurrent = n;
      const root = document.getElementById('liar-howto-modal');
      root.querySelectorAll('.howto-slide').forEach(s => {
        s.classList.toggle('active', parseInt(s.dataset.slide) === n);
      });
      root.querySelectorAll('.howto-dot').forEach((d, i) => {
        d.classList.toggle('active', i + 1 === n);
      });
      const btn = document.getElementById('liar-howto-next-btn');
      if (btn) btn.textContent = (n === LIAR_HOWTO_TOTAL) ? t('howTo.startPlaying') : t('common.next');
      liarStartAuto();
    }
    function liarNextSlide(){ liarGoToSlide(liarHowtoCurrent + 1); }
    function liarStartAuto(){
      liarStopAuto();
      liarHowtoTimer = setTimeout(() => liarGoToSlide(liarHowtoCurrent + 1), HOWTO_DURATION);
    }
    function liarStopAuto(){
      if (liarHowtoTimer) { clearTimeout(liarHowtoTimer); liarHowtoTimer = null; }
    }

    // ---------- Game flow ----------
    async function liarStartGame(ev){
      // Gate: aria-disabled means a Start condition isn't met. Surface the
      // hint as a toast instead of silently doing nothing.
      const _gateBtn = document.getElementById('liar-start-btn');
      if (_gateBtn && _gateBtn.getAttribute('aria-disabled') === 'true') {
        const _hintEl = document.getElementById('liar-seats-hint');
        const _msg = _hintEl && _hintEl.textContent && _hintEl.textContent.trim();
        if (_msg && typeof showLobbyToast === 'function') showLobbyToast(_msg);
        return;
      }
      // Local guard: only host with enough claimants can start.
      const claimedCount = Object.keys(liarState.claimedBy || {}).length;
      if (claimedCount < 2 || !liarMe.myId) return;
      if (cardLobbyGetSessionId() !== liarState.hostId) return;
      // Disable the start button while the RPC is in flight so a frustrated
      // double-tap doesn't try to start the game twice.
      const btn = (ev && ev.currentTarget) || document.getElementById('liar-start-btn');
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy','true'); }
      // Server-authoritative: deal hands, pick tableCard, set phase. The
      // realtime echo will deliver the canonical state to all devices —
      // including this one — so no optimistic local mutation here. (C2 turn 3)
      const res = await huddleCallRPC('huddle_liar_start_game', { p_code: liarState.code });
      // On error, re-enable so retry works. On success, the realtime echo
      // navigates everyone to the next phase and the button leaves the DOM.
      if (res && res.error && btn && document.body.contains(btn)) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    }

    function liarRenderTableCardSplash(){
      const iconEl = document.getElementById('liar-tablecard-icon');
      const nameEl = document.getElementById('liar-tablecard-name');
      if (iconEl) iconEl.textContent = liarRankEmoji(liarState.tableCard);
      if (nameEl) nameEl.textContent = t('liar.rank.' + liarState.tableCard);
      if (iconEl) parseEmoji(iconEl);
    }

    function liarRankEmoji(rank){
      if (rank === 'A') return '🅰️';
      if (rank === 'K') return '👑';
      if (rank === 'Q') return '👸';
      return '🃏';
    }

    function liarRankLabel(rank){
      return t('liar.rank.' + rank);
    }

    // Tap "Deal the cards" on the table-card splash → transitions everyone to play phase
    function liarStartFirstTurn(){
      if (liarState.phase !== 'tablecard') return; // prevent double-tap re-firing
      if (!liarMe.myId) return; // must be a claimant
      // Server-validated phase transition (C2 turn 3). Echo updates local state.
      huddleCallRPC('huddle_liar_start_first_turn', { p_code: liarState.code });
    }

    // Renders the play screen from THIS device's perspective.
    // Each device sees only its own hand. Action buttons gate on whose turn it is.
    // Production play screen — Design A "round-table" layout.
    // All seated players sit evenly spaced around a circular felt; ME at 6
    // o'clock, opponents fill the rest at 360°/N intervals. Glow ring follows
    // currentPlayerIdx so whoever's actually-on-turn lights up. Centre shows
    // the round's rank as a big white button. Multi-device sync is automatic
    // via the shared liarState (this fn just reads from it).
    function liarRenderPlayScreen(){
      const currentPid = liarState.alivePlayers[liarState.currentPlayerIdx];
      const currentPlayer = liarState.players.find(p => p.id === currentPid);
      const isMyTurn = currentPid === liarMe.myId;

      ensureClaimantProfiles(Object.values(liarState.claimedBy || {}), liarRenderPlayScreen);
      const currentDisplay = playerDisplayFor(currentPlayer, liarState.claimedBy);

      // Is the current turn-holder actually online? If they've disconnected, the
      // sole-survivor polling will end the game in ~8-11 seconds — but in the
      // meantime show the user a clear "other player left" message instead of
      // pretending they're about to act.
      const currentSid = liarState.claimedBy && currentPid ? liarState.claimedBy[currentPid] : null;
      const currentPresent = !!currentSid && _cardLobbyPresentSessions && _cardLobbyPresentSessions.has(currentSid);
      const showOtherLeftUi = !isMyTurn && !!currentSid && !currentPresent;

      // Header
      const headerEl = document.getElementById('liar-play-header');
      if (headerEl) {
        if (isMyTurn) {
          headerEl.textContent = t('liar.playHeader');
        } else if (showOtherLeftUi) {
          headerEl.textContent = t('liar.otherPlayerLeft');
        } else {
          headerEl.textContent = t('liar.waitingFor', { name: currentDisplay.name });
        }
      }

      // Centre rank button — the localized rank word in uppercase.
      const rankWordEl = document.getElementById('liar-play-rank-word');
      if (rankWordEl) rankWordEl.textContent = liarRankLabel(liarState.tableCard);

      liarRenderTable();
      liarRenderHand();
      liarUpdateActionStatus();
    }

    // Plural-aware sentence-case rank word for claim pills like "3 Queens".
    // English pluralizes; Turkish uses the singular form (Turkish typically
    // doesn't pluralize a noun after a numeral).
    function liarRankWord(rank, count){
      const lang = (typeof getLang === 'function') ? getLang() : 'en';
      if (lang === 'en') {
        const singular = { A:'Ace', K:'King', Q:'Queen' };
        const plural   = { A:'Aces', K:'Kings', Q:'Queens' };
        return (count === 1 ? singular[rank] : plural[rank]) || rank;
      }
      // Fallback: take the localized (uppercase) label and title-case it.
      const w = liarRankLabel(rank);
      return w.charAt(0) + w.slice(1).toLowerCase();
    }

    // Position each seated player around the felt rim. ME locks at 6 o'clock;
    // opponents fill the rest at 360°/N intervals (perfectly even spacing).
    // Glow ring (.current) lands on whichever seat matches currentPlayerIdx.
    function liarRenderTable(){
      const felt = document.getElementById('liar-play-felt');
      if (!felt) return;

      const currentPid = liarState.alivePlayers[liarState.currentPlayerIdx];
      const isMyTurn   = currentPid === liarMe.myId;
      const recent     = liarState.recentPlays || {};
      const claimedBy  = liarState.claimedBy || {};

      // Build the seated lists. ME always sits at 6 o'clock; opponents fill
      // the remaining rim. Keep opponent order stable across renders so
      // chairs don't jump as state mutates.
      const seatedPlayers = liarState.players.filter(p => claimedBy[p.id]);
      const opponents     = seatedPlayers.filter(p => p.id !== liarMe.myId);
      const totalPlayers  = seatedPlayers.length;

      // Circle math: ME at angle 180°, others at +360/N intervals.
      const R         = 38; // placement radius (% from felt centre)
      const meAngle   = 180;
      const angleStep = totalPlayers > 1 ? 360 / totalPlayers : 0;

      // Reset all 7 opponent slot elements (supports up to 8-player games:
      // 7 opponents around the rim + me at 6 o'clock).
      for (let i = 0; i < 7; i++) {
        const el = document.getElementById('liar-play-slot-' + i);
        if (!el) continue;
        el.classList.remove('active', 'current', 'eliminated');
        el.innerHTML = '';
        el.style.top = '';
        el.style.left = '';
      }

      // Fill each opponent's slot.
      opponents.forEach((p, idx) => {
        const el = document.getElementById('liar-play-slot-' + idx);
        if (!el) return;
        const angle = (meAngle + (idx + 1) * angleStep) % 360;
        const rad   = angle * Math.PI / 180;
        const x     = 50 + R * Math.sin(rad);
        const y     = 50 - R * Math.cos(rad);
        el.style.left = x.toFixed(2) + '%';
        el.style.top  = y.toFixed(2) + '%';
        el.classList.add('active');
        const isAlive   = liarState.alivePlayers.includes(p.id);
        const isCurrent = p.id === currentPid && isAlive;
        if (isCurrent) el.classList.add('current');
        if (!isAlive)  el.classList.add('eliminated');
        el.innerHTML = liarPlaySeatHTML(p, recent, /*isMe*/false, isMyTurn);
      });

      // ME at 6 o'clock — only render if I'm actually seated.
      const meEl = document.getElementById('liar-play-me');
      if (meEl) {
        const mePlayer = liarMe.myId && liarState.players.find(p => p.id === liarMe.myId);
        const showMe   = !!(mePlayer && claimedBy[mePlayer.id]);
        if (showMe) {
          const isAlive = liarState.alivePlayers.includes(liarMe.myId);
          meEl.classList.toggle('current', isMyTurn && isAlive);
          meEl.classList.toggle('eliminated', !isAlive);
          meEl.innerHTML = liarPlaySeatHTML(mePlayer, recent, /*isMe*/true, isMyTurn);
          meEl.style.display = '';
        } else {
          meEl.style.display = 'none';
          meEl.innerHTML = '';
          meEl.classList.remove('current', 'eliminated');
        }
      }

      parseEmoji(felt);
    }

    // Render one seat's contents — avatar + name + (optional) claim pill.
    // Used for both opponent slots and the ME seat. The claim pill shows:
    //   - Their actual played count if they've already played this round
    //   - MY pending count + table-card rank if I have cards selected (me only)
    //   - Nothing if neither
    function liarPlaySeatHTML(player, recent, isMe, isMyTurn){
      const isAlive   = liarState.alivePlayers.includes(player.id);
      const handCount = isAlive ? (liarState.hands[player.id] || []).length : 0;
      const display   = playerDisplayFor(player, liarState.claimedBy);
      // ME uses 44px avatar + own profile name; opponents use 36px + claimant profile.
      const avSize    = isMe ? 44 : 36;
      const meName    = (isMe && myProfile && myProfile.username) ? '@' + myProfile.username : null;
      const name      = meName || display.name || (player ? player.name : '');
      const avatar    = (isMe && myProfile && myProfile.avatar) ? myProfile.avatar : display.avatar;
      const avHtml    = avatarHTML(avatar, avSize, { fallback: player.initial });

      let badge = '';
      if (!isAlive) {
        badge = `<div class="liar-play-out-tag">${t('liar.statusOut')}</div>`;
      } else {
        const played = recent[player.id];
        if (played && played.count) {
          // Actual played stack — sits as a white pill under the avatar+name.
          badge = `<div class="liar-play-claim">${played.count} ${escapeHTML(liarRankWord(played.claimedRank, played.count))}</div>`;
        } else if (isMe && isMyTurn && liarMe.selectedCardIds && liarMe.selectedCardIds.length > 0) {
          // Pending claim: show MY selection count + the round's table card.
          const cnt = liarMe.selectedCardIds.length;
          badge = `<div class="liar-play-claim">${cnt} ${escapeHTML(liarRankWord(liarState.tableCard, cnt))}</div>`;
        }
      }

      return `
        <div class="liar-play-seat-avatar">
          ${avHtml}
        </div>
        <div class="liar-play-seat-name">${escapeHTML(name)}</div>
        ${badge}
      `;
    }

    // Renders THIS device's hand only — based on liarMe.myId, not the current player.
    // Other players' hands are never sent to other devices in the tomorrow-Supabase
    // architecture; today, they're in localStorage but the render layer hides them.
    function liarRenderHand(){
      const hand = document.getElementById('liar-hand');
      if (!hand) return;
      if (!liarMe.myId || !liarState.alivePlayers.includes(liarMe.myId)) {
        // I'm not playing this round (eliminated OR no seat claimed). Show empty state.
        hand.classList.add('empty');
        hand.innerHTML = `<div>${liarMe.myId ? t('liar.youAreOut') : t('liar.noSeatClaimed')}</div>`;
        return;
      }
      const cards = liarState.hands[liarMe.myId] || [];
      if (cards.length === 0) {
        hand.classList.add('empty');
        hand.innerHTML = `<div>${t('liar.handEmpty')}</div>`;
        return;
      }
      hand.classList.remove('empty');
      hand.innerHTML = cards.map(card => {
        const selected = liarMe.selectedCardIds.includes(card.id);
        return liarCardHTML(card, { selected, faceDown: false, onclick: `liarToggleCard('${card.id}')` });
      }).join('');
      parseEmoji(hand);
    }

    // 3-D flip card used only inside the reveal overlay. Two faces with
    // backface-visibility:hidden so we get a real card-flip — back (red) showing
    // first, then the rank reveals as the inner container rotates 180° → 0°.
    // CSS handles the stagger via the --i custom property.
    function liarFlipCardHTML(card, opts){
      opts = opts || {};
      const i = typeof opts.index === 'number' ? opts.index : 0;
      const isJoker = card.rank === 'J';
      const rankText = isJoker ? '🃏' : card.rank;
      const frontExtra = (opts.revealed === 'truth' ? ' revealed-truth' : '') + (opts.revealed === 'lie' ? ' revealed-lie' : '');
      const jokerCls = isJoker ? ' joker' : '';
      const frontInner = isJoker
        ? '<div class="liar-card-rank">🃏</div>'
        : '<div class="liar-card-suit">' + rankText + '</div>'
        + '<div class="liar-card-rank">' + rankText + '</div>'
        + '<div class="liar-card-suit-br">' + rankText + '</div>';
      return '<div class="liar-flip-card" style="--i: ' + i + '">'
        + '<div class="liar-flip-face liar-flip-back"></div>'
        + '<div class="liar-flip-face liar-flip-front' + frontExtra + jokerCls + '">' + frontInner + '</div>'
        + '</div>';
    }

    function liarCardHTML(card, opts){
      opts = opts || {};
      if (opts.faceDown) {
        return `<div class="liar-card face-down"></div>`;
      }
      const isJoker = card.rank === 'J';
      const rankText = isJoker ? '🃏' : card.rank;
      const onclick = opts.onclick ? ` onclick="${opts.onclick}"` : '';
      const extra = (opts.selected ? ' selected' : '') + (opts.revealed === 'truth' ? ' revealed-truth' : '') + (opts.revealed === 'lie' ? ' revealed-lie' : '');
      const jokerCls = isJoker ? ' joker' : '';
      if (isJoker) {
        return `<div class="liar-card${jokerCls}${extra}"${onclick}>
          <div class="liar-card-rank">🃏</div>
        </div>`;
      }
      return `<div class="liar-card${extra}"${onclick}>
        <div class="liar-card-suit">${rankText}</div>
        <div class="liar-card-rank">${rankText}</div>
        <div class="liar-card-suit-br">${rankText}</div>
      </div>`;
    }

    function liarToggleCard(cardId){
      // Only allow card selection on MY turn — others can look but can't tap
      const currentPid = liarState.alivePlayers[liarState.currentPlayerIdx];
      if (currentPid !== liarMe.myId) return;
      const idx = liarMe.selectedCardIds.indexOf(cardId);
      if (idx >= 0) {
        liarMe.selectedCardIds.splice(idx, 1);
      } else {
        if (liarMe.selectedCardIds.length >= 3) {
          liarMe.selectedCardIds.shift();
        }
        liarMe.selectedCardIds.push(cardId);
      }
      // Local-only state change — no persist needed
      liarRenderHand();
      liarUpdateActionStatus();
      // Refresh the me-seat so its brown "pending claim" badge tracks the
      // selected count in real time as the user taps cards.
      liarRenderTable();
    }

    function liarUpdateActionStatus(){
      const statusEl = document.getElementById('liar-play-status');
      const playBtn  = document.getElementById('liar-play-btn');
      const callBtn  = document.getElementById('liar-call-btn');
      if (!statusEl || !playBtn || !callBtn) return;

      const currentPid    = liarState.alivePlayers[liarState.currentPlayerIdx];
      const currentPlayer = liarState.players.find(p => p.id === currentPid);
      const isMyTurn      = currentPid === liarMe.myId;
      const myCards       = liarState.hands[liarMe.myId] || [];
      const sel           = liarMe.selectedCardIds.length;
      const isFirst       = !liarState.lastPlay;
      const hasCards      = myCards.length > 0;
      const imAlive       = liarMe.myId && liarState.alivePlayers.includes(liarMe.myId);
      // Anyone-can-call rule: any alive player except the one who just played
      // may call LIAR. First valid call wins (server serializes).
      const accusedId     = liarState.lastPlay && liarState.lastPlay.byPlayerId;
      const canCallLiar   = !isFirst && imAlive && accusedId !== liarMe.myId;

      // NOT my turn — passive waiting status, BUT Liar button stays available
      // to any alive non-accused watcher so they can challenge the last play.
      if (!isMyTurn) {
        const curSid = liarState.claimedBy && currentPid ? liarState.claimedBy[currentPid] : null;
        const curPresent = !!curSid && _cardLobbyPresentSessions && _cardLobbyPresentSessions.has(curSid);
        if (curSid && !curPresent) {
          statusEl.innerHTML = t('liar.otherPlayerLeftStatus');
        } else {
          const curDisplay = playerDisplayFor(currentPlayer, liarState.claimedBy);
          statusEl.innerHTML = t('liar.waitingForToAct', {
            name: '<strong>' + escapeHTML(curDisplay.name) + '</strong>'
          });
        }
        playBtn.disabled = true;
        callBtn.disabled = !canCallLiar;
        return;
      }

      // It IS my turn. Play button is mine; Liar button follows the same
      // anyone-can-call gate (current player can also call).
      callBtn.disabled = !canCallLiar;
      playBtn.disabled = sel < 1 || sel > 3 || !imAlive;

      if (!hasCards) {
        statusEl.innerHTML = t('liar.statusYouEmpty');
      } else if (sel === 0) {
        if (isFirst) {
          statusEl.innerHTML = t('liar.statusFirstTurn', { tableCard: escapeHTML(liarRankLabel(liarState.tableCard)) });
        } else {
          const lastPlayer = liarState.players.find(p => p.id === liarState.lastPlay.byPlayerId);
          const lastDisp   = playerDisplayFor(lastPlayer, liarState.claimedBy);
          statusEl.innerHTML = t('liar.statusFollow', {
            name: escapeHTML(lastPlayer.id === liarMe.myId ? t('picker.you') : lastDisp.name),
            count: escapeHTML(String(liarState.lastPlay.count)),
          });
        }
      } else {
        // 1+ cards selected — the pending claim pill under MY avatar shows
        // the info, so the body status text is redundant. Clear it.
        statusEl.innerHTML = '';
      }
    }

    function liarPlaySelectedCards(){
      if (liarState.phase !== 'play') return; // ignore if phase moved (rare double-tap)
      // Local guard: only the current player can play
      const currentPid = liarState.alivePlayers[liarState.currentPlayerIdx];
      if (currentPid !== liarMe.myId) return;
      const cards = liarState.hands[liarMe.myId] || [];
      const selected = liarMe.selectedCardIds
        .map(id => cards.find(c => c.id === id))
        .filter(c => c);
      if (selected.length < 1 || selected.length > 3) return;
      const cardIds = selected.map(c => c.id);
      // Clear local selection immediately so the UI deselects (UX); the
      // actual hand mutation happens server-side and arrives via echo.
      liarMe.selectedCardIds = [];
      // Server-validated play (C2 turn 3) — server confirms caller's identity,
      // turn order, and CARD OWNERSHIP. A malicious client cannot inject
      // cards they don't hold, even via direct REST.
      huddleCallRPC('huddle_liar_play_cards', {
        p_code: liarState.code,
        p_card_ids: cardIds,
      });
      // Re-render so the deselect lands visually without waiting for echo.
      cardLobbyRerender();
    }

    function liarAdvanceTurn(){
      const n = liarState.alivePlayers.length;
      liarState.currentPlayerIdx = (liarState.currentPlayerIdx + 1) % n;
    }

    function liarCallLiar(){
      if (liarState.phase !== 'play') return; // double-tap safety
      if (!liarState.lastPlay) return;
      // Local guard (UX only — server enforces the same rules):
      //   • Caller must be alive in this round
      //   • Caller must NOT be the player who just played (the accused)
      // First valid call wins; subsequent calls fail with 'wrong_phase'.
      if (!liarMe.myId) return;
      if (!liarState.alivePlayers || !liarState.alivePlayers.includes(liarMe.myId)) return;
      if (liarState.lastPlay.byPlayerId === liarMe.myId) return;
      // Server determines pendingLoser & phase='reveal' (C2 turn 3). The
      // truth-vs-lie computation is done server-side against the canonical
      // lastPlay so the client cannot lie about the verdict.
      // Mark the call button as syncing so the press-pulse affordance fires
      // even though we no longer set phase locally.
      try { liarMarkPhaseStart(document.getElementById('liar-call-btn')); } catch(e){}
      huddleCallRPC('huddle_liar_call_liar', { p_code: liarState.code });
    }

    function liarRenderRevealContent(){
      const accusedId = liarState.lastPlay.byPlayerId;
      const accused = liarState.players.find(p => p.id === accusedId);
      // Under the "anyone can call" rule, the accuser is whoever clicked
      // "Liar!" — the server records this in pendingAccuserId. Fall back to
      // the old currentPlayerIdx-derived value only for legacy states
      // written before the rule change.
      const accuserId = liarState.pendingAccuserId
        || liarState.alivePlayers[liarState.currentPlayerIdx];
      const accuser = liarState.players.find(p => p.id === accuserId);
      const rankLabel = liarRankLabel(liarState.tableCard);
      const count = liarState.lastPlay.count;
      const sCount = count > 1 ? 's' : '';

      ensureClaimantProfiles(Object.values(liarState.claimedBy || {}), liarRenderRevealContent);
      const accusedDisplay = playerDisplayFor(accused, liarState.claimedBy);
      const accuserDisplay = playerDisplayFor(accuser, liarState.claimedBy);
      const accusedName = accused && accused.id === liarMe.myId ? t('picker.you') : accusedDisplay.name;
      const accuserName = accuser && accuser.id === liarMe.myId ? t('picker.you') : accuserDisplay.name;

      document.getElementById('liar-reveal-label').innerHTML = t('liar.revealLabel', {
        name: escapeHTML(accusedName),
        count: escapeHTML(String(count)),
        tableCard: escapeHTML(rankLabel),
        s: sCount,
      });
      document.getElementById('liar-reveal-title').textContent = t('liar.revealTitle');

      // Render the revealed cards as 3-D flip cards. Each one starts face-down
      // and animates face-up on a stagger driven by --i (CSS animation-delay).
      const cardsEl = document.getElementById('liar-reveal-cards');
      cardsEl.innerHTML = liarState.lastPlay.cards.map((c, i) => {
        const isValid = c.rank === liarState.tableCard || c.rank === 'J';
        return liarFlipCardHTML(c, { revealed: isValid ? 'truth' : 'lie', index: i });
      }).join('');
      parseEmoji(cardsEl);

      // Verdict — slam-in animation + a big stamp ("BUSTED!" or "WRONG CALL!")
      // for emotional punch. Animation only fires once per unique reveal
      // (keyed by accused/cause) so re-renders during the reveal don't restart it.
      const verdictEl = document.getElementById('liar-verdict');
      const verdictEmoji = document.getElementById('liar-verdict-emoji');
      const verdictText = document.getElementById('liar-verdict-text');
      verdictEl.className = 'liar-verdict ' + liarState.pendingLoserCause;
      // Compact verdict: only the first sentence (e.g. "Jordan was LYING.")
      // The full explanation lived on the old separate reveal page; in the
      // single-page overlay we want a small one-line pill so the BUSTED stamp
      // and the cards are the focus.
      const firstSentence = (full) => {
        // Stop at the first .!? that's followed by whitespace, a tag, or end.
        // The translations wrap key phrases in <strong> so the period often
        // sits before a closing tag rather than a space.
        const m = full.match(/^[\s\S]*?[.!?](?=\s|<|$)/);
        return m ? m[0] : full;
      };
      let stampHtml = '';
      if (liarState.pendingLoserCause === 'lied') {
        verdictEmoji.textContent = '🤥';
        const fullText = t('liar.verdictLied', { name: '<strong>' + escapeHTML(accusedName) + '</strong>', tableCard: rankLabel });
        verdictText.innerHTML = firstSentence(fullText);
        stampHtml = '<div class="liar-stamp">' + escapeHTML(t('liar.stampBusted')) + '</div>';
      } else {
        verdictEmoji.textContent = '😬';
        const fullText = t('liar.verdictWrongAccuse', {
          accuser: '<strong>' + escapeHTML(accuserName) + '</strong>',
          name: escapeHTML(accusedName),
        });
        verdictText.innerHTML = firstSentence(fullText);
        stampHtml = '<div class="liar-stamp wrong-stamp">' + escapeHTML(t('liar.stampWrongCall')) + '</div>';
      }
      parseEmoji(verdictEl);

      const stampHost = document.getElementById('liar-reveal-stamp');
      const revealKey = (liarState.pendingLoserId || '') + ':' + (liarState.pendingLoserCause || '');
      const isFreshReveal = __liarLastRevealKey !== revealKey;
      if (isFreshReveal) {
        __liarLastRevealKey = revealKey;
        // Card-flip sounds — staggered to match the new CSS animation-delays
        // (calc(.3s + var(--i) * .6s) — i.e. card1@300ms, card2@900ms, card3@1500ms).
        liarState.lastPlay.cards.forEach((_, idx) => {
          liarSchedule(() => liarSfx.cardFlip(), 300 + idx * 600);
        });
        // Mount the stamp + verdict dramatize + stinger + screen flash AFTER all
        // cards have flipped face-up (~2050ms for 3 cards). Defer to liarSchedule
        // so the moment lands AFTER the visual flips, not before them.
        const allCardsLandedMs = 300 + (liarState.lastPlay.cards.length - 1) * 600 + 550; // last delay + flip duration
        liarSchedule(() => {
          if (stampHost) stampHost.innerHTML = stampHtml;
          verdictEl.classList.add('dramatize');
          const flashKind = liarState.pendingLoserCause === 'lied' ? 'busted' : 'wrong';
          liarFullScreenFlash(flashKind);
          if (liarState.pendingLoserCause === 'lied') liarSfx.bustedStinger();
          else                                       liarSfx.wrongCallStinger();
        }, allCardsLandedMs);
      } else if (stampHost) {
        // Subsequent renders of the same reveal — keep the stamp visible but skip animation
        stampHost.innerHTML = stampHtml;
        const stampEl = stampHost.querySelector('.liar-stamp');
        if (stampEl) stampEl.style.animation = 'none';
      }

      // Truth page auto-rolls into the cup phase after a 3s dwell so people
      // read the verdict + see the stamp, then the cup section slides in below
      // (combined page — no screen swap). The pulsing dwell hint underneath
      // is everyone's visual cue that we're advancing on our own.
      //
      // Every device schedules the auto-advance, but the firing callback gates
      // on cardLobbyShouldITakeAction so only ONE peer actually pushes state — the
      // loser by default, or (if they've disconnected mid-dwell) the lowest-
      // seat-connected peer as fallback. The mutator (liarStartSip) re-checks
      // the same guard so a takeover that races a return-from-grace no-ops.
      const isLoser = liarState.pendingLoserId === liarMe.myId;
      liarScheduleRevealAdvance(revealKey, () => {
        if (liarState.phase !== 'reveal') return;
        if (!cardLobbyShouldITakeAction(liarState.pendingLoserId)) return;
        liarStartSip();
      }, 4500);
      // Dwell hint — shown to EVERYONE so they know the cup screen is coming.
      // Adds a small pulsing dot for liveness; copy varies by perspective so the
      // loser sees "Heading to the cup…" and watchers see "Maria's heading to the cup…".
      const waitingNote = document.getElementById('liar-reveal-waiting');
      if (waitingNote) {
        waitingNote.style.display = '';
        const loser = liarState.players.find(p => p.id === liarState.pendingLoserId);
        const loserDisp = playerDisplayFor(loser, liarState.claimedBy);
        const hintText = isLoser
          ? t('liar.autoNextTruthYou')
          : t('liar.autoNextTruthOther', { name: '<strong>' + escapeHTML(loserDisp.name) + '</strong>' });
        waitingNote.innerHTML = '<span class="liar-auto-dot"></span> ' + hintText;
      }
    }

    // ---------- The Cup ----------
    // Tap "to the cup" (loser only) → transitions phase. Chamber pattern is generated
    // ONCE by the loser's tap so all tabs see the same pattern. Sub-actions on the cup
    // screen (tap-to-drink) are gated to the loser only.
    function liarStartSip(){
      if (liarState.phase !== 'reveal') return; // double-tap safety
      // Only the pending loser can advance to the cup. (Was: also lowest-
      // connected fallback; that case currently degrades to "game stalls
      // until loser returns" — to be re-added via presence-aware policy.)
      if (!cardLobbyShouldITakeAction(liarState.pendingLoserId)) return;
      // Server builds the chamber pattern with server-side randomness (C2
      // turn 3b). A cheating client cannot preview spill positions.
      huddleCallRPC('huddle_liar_start_sip', { p_code: liarState.code });
    }

    // Per-device animation ledgers — keyed so we only play each dramatic moment
    // ONCE per state transition. Re-renders during the animation must not re-fire.
    let __liarLastAnimatedSipKey = null;
    let __liarLastRevealKey = null;

    // Auto-advance plumbing. The Truth page and Cup result both transition on a
    // timer so players don't have to keep tapping. Only the loser's device fires
    // the state mutation (otherwise multiple devices would race to push the same
    // transition). Watchers see the resulting state change via Supabase Realtime.
    // Timers are keyed so re-renders during the dwell don't restart them, and
    // we clear them when the player leaves or the phase moves on.
    const __liarAutoAdvance = { revealKey:null, revealTimer:null, cupKey:null, cupTimer:null };
    function liarScheduleRevealAdvance(key, fn, ms){
      if (__liarAutoAdvance.revealKey === key) return; // already scheduled for this reveal
      liarClearRevealAdvance();
      __liarAutoAdvance.revealKey = key;
      __liarAutoAdvance.revealTimer = setTimeout(() => {
        __liarAutoAdvance.revealTimer = null;
        try { fn(); } catch(e){ console.error('reveal auto-advance failed', e); }
      }, ms);
    }
    function liarClearRevealAdvance(){
      if (__liarAutoAdvance.revealTimer) {
        clearTimeout(__liarAutoAdvance.revealTimer);
        __liarAutoAdvance.revealTimer = null;
      }
      __liarAutoAdvance.revealKey = null;
    }
    function liarScheduleCupAdvance(key, fn, ms){
      if (__liarAutoAdvance.cupKey === key) return;
      liarClearCupAdvance();
      __liarAutoAdvance.cupKey = key;
      __liarAutoAdvance.cupTimer = setTimeout(() => {
        __liarAutoAdvance.cupTimer = null;
        try { fn(); } catch(e){ console.error('cup auto-advance failed', e); }
      }, ms);
    }
    function liarClearCupAdvance(){
      if (__liarAutoAdvance.cupTimer) {
        clearTimeout(__liarAutoAdvance.cupTimer);
        __liarAutoAdvance.cupTimer = null;
      }
      __liarAutoAdvance.cupKey = null;
    }
    function liarClearAllAutoAdvance(){
      liarClearRevealAdvance();
      liarClearCupAdvance();
      // liarClearAutoSip is declared further down; guard for hoist order.
      if (typeof liarClearAutoSip === 'function') liarClearAutoSip();
      // Cancel any pending SFX timeouts too — they're part of the same
      // "stop the game's queued work" semantic. (Doesn't close the audio
      // context — that's reserved for liarStopAllSfx so callers can
      // distinguish "stop scheduling" from "kill all audio NOW".)
      if (typeof liarCancelScheduledSfx === 'function') liarCancelScheduledSfx();
    }

    // Render the inline cup section (now lives inside the reveal screen).
    // No more "Tap to drink" button — the cup flows automatically. The loser's
    // device schedules `liarTakeSip` after a ~1.1s brace beat so the player
    // has a moment to look at their phone and read the chamber count before
    // the spin starts. All other devices wait for the resulting `sipTaken=true`
    // state push via Supabase Realtime and animate from there.
    // THE VERDICT — Wheel-of-fate render. Replaces the old cup/chambers visual.
    // The state plumbing is untouched: sipChamberIsSpill still says which chambers
    // are poison, sipChamberIdx still picks the landing chamber, sipOutcome still
    // resolves safe/spilled. We just render those as a spinning wheel.
    function liarRenderCupInline(){
      const spills = liarState.cupSpills || 1;
      const wheelEl = document.getElementById('liar-wheel');
      const stage = document.getElementById('liar-cup-stage');
      const stamp = document.getElementById('liar-wheel-stamp');
      const spotwedge = document.getElementById('liar-wheel-spotwedge');
      const resultEl = document.getElementById('liar-cup-result');
      if (!wheelEl) return;

      // Color the wheel — match wedges to sipChamberIsSpill (so all devices
      // see the same red/green layout) or fall back to first-N-are-red.
      const chambers = (liarState.sipChamberIsSpill && liarState.sipChamberIsSpill.length === 6)
        ? liarState.sipChamberIsSpill
        : (() => {
            const arr = new Array(6).fill(false);
            for (let i = 0; i < Math.min(spills, 6); i++) arr[i] = true;
            return arr;
          })();
      // Polished palette: deep casino-felt red + alternating emerald greens
      let bg = 'conic-gradient(';
      for (let i = 0; i < 6; i++) {
        const start = i * 60, end = (i + 1) * 60;
        const color = chambers[i] ? '#b91c1c' : (i % 2 === 0 ? '#16a34a' : '#15803d');
        bg += `${color} ${start}deg ${end}deg${i < 5 ? ',' : ''}`;
      }
      bg += ')';
      // Glossy top highlight + soft bottom vignette over the wedges — turns
      // the flat-painted look into a polished domed surface.
      const sheen = 'radial-gradient(circle at 50% 22%, rgba(255,255,255,.22) 0%, rgba(255,255,255,0) 42%), radial-gradient(circle at 50% 88%, rgba(0,0,0,.25) 0%, rgba(0,0,0,0) 58%)';
      wheelEl.style.background = `${sheen}, ${bg}`;

      if (!liarState.sipTaken) {
        // Pre-spin — wheel rendered colored, not spinning yet. The 1.1s brace
        // beat lets the loser see how many red wedges they're up against.
        __liarLastAnimatedSipKey = null;
        sfxStopSuspense();
        sfxStopRumble();
        if (resultEl) resultEl.style.display = 'none';
        if (stage) stage.className = 'liar-cup-stage liar-wheel-stage';
        if (stamp) { stamp.className = 'liar-wheel-stamp'; stamp.textContent = ''; }
        if (spotwedge) spotwedge.className = 'liar-wheel-spotwedge';
        wheelEl.className = 'liar-wheel';
        wheelEl.style.removeProperty('--liar-wheel-target');
        // Auto-fire liarTakeSip after the brace beat; gated by cardLobbyShouldITakeAction
        // so only the loser (or the lowest-seat-connected fallback) writes state.
        liarScheduleAutoSip();
      } else {
        if (resultEl) resultEl.style.display = 'none';
        const sipKey = String(liarState.sipChamberIdx) + ':' + liarState.sipOutcome;
        if (__liarLastAnimatedSipKey !== sipKey) {
          __liarLastAnimatedSipKey = sipKey;
          liarRunCupAnimation();
        }
      }
    }

    // Auto-fire the sip after a brace beat. Guarded by liarAutoSipTimer +
    // liarAutoSipKey so multiple rerenders don't schedule duplicates.
    let __liarAutoSipTimer = null;
    let __liarAutoSipKey = null;
    function liarScheduleAutoSip(){
      // Key by pendingLoserId — one auto-fire per loser, per cup phase entry.
      const key = String(liarState.pendingLoserId || '') + ':' + (liarState.cupSpills || 0);
      if (__liarAutoSipKey === key) return; // already scheduled for this sip
      liarClearAutoSip();
      __liarAutoSipKey = key;
      __liarAutoSipTimer = setTimeout(() => {
        __liarAutoSipTimer = null;
        try {
          // Re-check ownership at fire time. cardLobbyShouldITakeAction returns
          // true for the loser when present, OR for the lowest-seat-connected
          // peer when the loser has disconnected past the grace window.
          if (liarState.phase !== 'cup' || liarState.sipTaken) return;
          if (!cardLobbyShouldITakeAction(liarState.pendingLoserId)) return;
          // Haptic only on the actual loser's device (not the takeover peer —
          // they didn't "lose" anything).
          if (liarState.pendingLoserId === liarMe.myId) {
            try { if (navigator.vibrate) navigator.vibrate(60); } catch(e){}
          }
          liarTakeSip();
        } catch(e){ console.error('auto-sip failed', e); }
      }, 1100);
    }
    function liarClearAutoSip(){
      if (__liarAutoSipTimer) {
        clearTimeout(__liarAutoSipTimer);
        __liarAutoSipTimer = null;
      }
      __liarAutoSipKey = null;
    }

    // Plays the dramatic drinking sequence end-to-end on the current device.
    // Same timeline on every device because the state push happens once when
    // the loser taps; everyone else sees sipTaken=true and runs this same fn.
    //
    // Timeline (ms after start, branches at the reveal):
    //   0–400     lift + heartbeat begins, low rumble swells in
    //   400–3700  ★ roulette spin — 16 ticks, convex easing (t^1.4),
    //             gaps grow ~100→340ms (real slot-machine deceleration).
    //             Heartbeat + rumble underneath. DOM nodes are stable;
    //             only the `.rolling` class moves between chambers, so the
    //             .14s CSS transition fires for a smooth baton-pass feel.
    //   3700      rouletteLand SFX — bigger lower thud as the ball settles;
    //             final chamber gets the `.settle` pulse class
    //   3700–4200 ★ HELD PAUSE — the "pause that pays". Rumble + suspense
    //             stop. Only a single slow heartbeat thud at 3850 (~150ms
    //             after silence falls). 500ms of dread per slot-UX research.
    //   4200      sharp whoosh, anticipation class removed
    //   4400–4900 drink tilt + gulp SFX (cup tips to mouth)
    //   4900      ★ REVEAL — flash + impact + chamber colour morph
    //     SAFE:   bright chord + opening ding + confetti + cup bounce
    //             → safe-celebrate linger at 5800 + safeCheer chord at 5900
    //             → result card pops in at 6300
    //             → auto-advance at 8800ms total
    //     SPILL:  layered impact (anticipation drop + body thud + slam sweep
    //             + crash + reverb tail), heavy 760ms camera shake
    //             → secondary aftershock at 5700
    //             → 2nd droplet wave at 6000
    //             → spill-aftermath state + drone at 6100
    //             → result card slams in at 6800
    //             → auto-advance at 10000ms total
    // THE VERDICT — wheel-spin animation. Replaces the old cup-tilt + chamber-row
    // visual with a gilded conic-gradient wheel. State plumbing is preserved:
    // existing sipChamberIdx / sipOutcome / cupSpills drive what the wheel shows.
    //
    // Timeline (ms after start):
    //   0–400     anticipation: rumble + suspense, wheel pre-render visible
    //   400–6500  WHEEL SPINS — 6.1s cubic-bezier deceleration ending on the
    //             chamber matching sipChamberIdx. Slow-mo final 600ms baked in.
    //   6300      stop suspense/rumble, brief silence
    //   6500      spotwedge flares on the landed wedge (gold for safe, red for out)
    //   6800      REVEAL — full-screen flash + SAFE/OUT stamp slams in
    //             + confetti (safe) or shards/droplets/vignette/shake (spill)
    //   7600+     aftermath: secondary shake + droplets (spill) or celebration
    //             linger (safe)
    //   8300/8800 result card slides in
    //   10700/11900 auto-advance to next round / winner screen
    function liarRunCupAnimation(){
      // Streamlined per user request: keep only spin + spotwedge landing flare
      // + OUT/SAFE stamp + result card. No sounds, no confetti, no shards, no
      // droplets, no body shake, no vignette, no fullscreen flash, no
      // anticipation phase. Total runtime ~7.5s (was ~12s).
      const stage = document.getElementById('liar-cup-stage');
      const wheelEl = document.getElementById('liar-wheel');
      const spotwedge = document.getElementById('liar-wheel-spotwedge');
      const stamp = document.getElementById('liar-wheel-stamp');
      const particles = document.getElementById('liar-cup-particles');
      const resultEl = document.getElementById('liar-cup-result');
      const outcome = liarState.sipOutcome;
      const finalIdx = liarState.sipChamberIdx;
      if (!stage || !wheelEl) return;

      // Reset visuals
      stage.className = 'liar-cup-stage liar-wheel-stage';
      if (particles) particles.innerHTML = '';
      if (resultEl) resultEl.style.display = 'none';
      if (stamp) { stamp.className = 'liar-wheel-stamp'; stamp.textContent = ''; }
      if (spotwedge) spotwedge.className = 'liar-wheel-spotwedge';

      // Compute target rotation so the pointer (12 o'clock) lands on
      // wedge `finalIdx`. R = 330 - 60*finalIdx mod 360, plus 6 full turns
      // for drama.
      const wedgeMidAngle = 60 * finalIdx + 30;
      const baseRotation = ((360 - wedgeMidAngle) % 360 + 360) % 360;
      const targetRotation = (6 * 360) + baseRotation;
      wheelEl.classList.remove('spinning');
      void wheelEl.offsetWidth; // reflow so .spinning restarts the keyframe
      wheelEl.style.setProperty('--liar-wheel-target', targetRotation + 'deg');

      // Spin begins
      liarSchedule(() => {
        wheelEl.classList.add('spinning');
      }, 100);

      // Stamp slams in 300ms after landing (no spotwedge glow per user request)
      liarSchedule(() => {
        if (stamp) {
          stamp.textContent = outcome === 'spilled' ? 'OUT' : 'SAFE';
          stamp.className = 'liar-wheel-stamp ' + (outcome === 'spilled' ? 'out' : 'safe') + ' show hold';
        }
      }, 6500);

      // Result card slides in
      liarSchedule(() => {
        liarShowSipResult();
        const card = document.getElementById('liar-cup-result');
        if (card) {
          card.classList.remove('dramatize');
          void card.offsetWidth;
          card.classList.add('dramatize');
        }
      }, 7000);

      // Auto-advance to next round
      const cupKey = String(liarState.sipChamberIdx) + ':' + liarState.sipOutcome + ':post';
      liarScheduleCupAdvance(cupKey, () => {
        if (liarState.phase !== 'cup' || !liarState.sipTaken) return;
        if (!cardLobbyShouldITakeAction(liarState.pendingLoserId)) return;
        liarAfterSip();
      }, 8500);
    }

    // Roulette spin — cycle the chamber highlight through positions with
    // decelerating intervals (slot-machine style). The final tick lands on the
    // actual picked chamber index. Each tick fires a tick SFX in sync.
    //
    // Math note: tick i fires at `startDelay + duration * (i / (N-1)) ^ k` with
    // k > 1, which is a CONVEX position curve over time — meaning the spin
    // covers less distance per unit time as it progresses → tick GAPS GROW
    // (decelerating). The previous version used `1 - (1-t)^k` (CONCAVE), which
    // made gaps SHRINK to ~2ms at the end — a slot machine that accelerated
    // into a blur. With k=1.4 and N=16 over 3300ms, gaps grow ~100→340ms.
    // Each tick comfortably above the eye/ear threshold for distinct events.
    //
    // The final tick fires `rouletteLand` (bigger thud) instead of the normal
    // tick, and the chamber gets a `.settle` class so it pulses to mark the
    // landing point. The 500ms held-pause after the final tick lets that
    // pulse and silence breathe.
    //
    // Under reduced-motion we snap straight to the final position without
    // any of this, after a short delay.
    function liarRunChamberSpin(startDelay, endDelay, finalIdx, reducedMotion){
      if (reducedMotion) {
        liarSchedule(() => liarRenderCupChambersSpinning(finalIdx, true), startDelay);
        return;
      }
      const totalDuration = endDelay - startDelay;
      const tickCount = 16;
      const easingPower = 1.4;
      // Cursor moves forward through chambers; the final tick lands on finalIdx.
      // Starting offset is randomised so the spin doesn't always begin at chamber 0.
      const cursor = Math.floor(Math.random() * 6);
      for (let i = 0; i < tickCount; i++) {
        const t = i / (tickCount - 1);
        const eased = Math.pow(t, easingPower);  // CONVEX → growing gaps → decelerating
        const at = startDelay + totalDuration * eased;
        const isLast = i === tickCount - 1;
        // Avoid the second-to-last index matching finalIdx (would look like
        // the highlight froze on the last tick). Offset by 1 if it would.
        let idx;
        if (isLast) {
          idx = finalIdx;
        } else {
          idx = (cursor + i) % 6;
          if (i === tickCount - 2 && idx === finalIdx) idx = (finalIdx + 3) % 6;
        }
        liarSchedule(() => {
          liarRenderCupChambersSpinning(idx, isLast);
          if (isLast) liarSfx.rouletteLand();
          else        liarSfx.rouletteTick();
        }, at);
      }
    }

    // Render the chambers in "spinning" mode — all show `?`, one optionally
    // highlighted as the roulette spotlight (no safe/spill colour reveal yet).
    //
    // CRITICAL: we TOGGLE classes on existing nodes — NEVER rebuild innerHTML.
    // The previous implementation replaced wrap.innerHTML on every tick, which
    // destroyed and recreated each <div>. New elements start at their target
    // CSS state with no transition — so the highlight just SNAPPED between
    // chambers, which is what made the spin feel "instant" and glitchy.
    // With class toggles on stable DOM nodes, the .14s CSS transition on the
    // .rolling state actually fires, producing smooth baton-pass animation.
    //
    // `landed`: if true, the highlighted chamber also gets `.settle` for the
    // bigger "ball lands in pocket" pulse animation.
    function liarRenderCupChambersSpinning(highlightIdx, landed){
      const wrap = document.getElementById('liar-cup-chambers');
      if (!wrap) return;
      const pattern = liarState.sipChamberIsSpill || [];
      if (!pattern.length) return;
      // Build skeleton once (or rebuild if chamber count changed).
      let chambers = wrap.querySelectorAll('.liar-cup-chamber');
      if (chambers.length !== pattern.length) {
        wrap.innerHTML = pattern.map(() => '<div class="liar-cup-chamber">?</div>').join('');
        chambers = wrap.querySelectorAll('.liar-cup-chamber');
      }
      chambers.forEach((el, i) => {
        const shouldRoll = i === highlightIdx;
        if (el.classList.contains('rolling') !== shouldRoll) {
          el.classList.toggle('rolling', shouldRoll);
        }
        // `.settle` only on the final landed chamber. Remove from all others
        // to avoid stale pulse states if the function is called repeatedly.
        const shouldSettle = shouldRoll && landed;
        if (el.classList.contains('settle') !== shouldSettle) {
          el.classList.toggle('settle', shouldSettle);
        }
        // Clear any leftover reveal-state classes from a prior sip — we're
        // pre-reveal so chambers should all read as `?` with neutral styling.
        if (el.classList.contains('spill') || el.classList.contains('safe') || el.classList.contains('revealed')) {
          el.classList.remove('spill','safe','revealed');
        }
        if (el.textContent !== '?') el.textContent = '?';
      });
    }

    // Inject confetti spans with randomised CSS vars (direction/rotation) for the
    // safe-drink celebration. The CSS animation reads --fly-x / --fly-y / --fly-rot.
    function liarSpawnConfetti(host){
      const colors = ['#3ec56a','#f5c451','#7fb3ff','#ff6b54','#b9b1ff'];
      const pieces = 14;
      let html = '';
      for (let i = 0; i < pieces; i++) {
        const angle = (i / pieces) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
        const dist  = 70 + Math.random() * 50;
        const fx = Math.cos(angle) * dist;
        const fy = Math.sin(angle) * dist - 30; // bias up
        const rot = 180 + Math.random() * 360;
        const color = colors[i % colors.length];
        html += `<span class="liar-confetti-piece" style="--fly-x:${fx.toFixed(0)}px;--fly-y:${fy.toFixed(0)}px;--fly-rot:${rot.toFixed(0)}deg;--confetti-color:${color};animation-delay:${(i * 12)}ms"></span>`;
      }
      host.innerHTML = html;
    }
    // Droplet spans that fall from the tilted cup on spill.
    function liarSpawnDroplets(host){
      const drops = 8;
      let html = '';
      for (let i = 0; i < drops; i++) {
        const dx = -40 + Math.random() * 80;
        const dy = Math.random() * 30;
        const rot = (Math.random() - 0.5) * 30;
        html += `<span class="liar-droplet" style="--drop-x:${dx.toFixed(0)}px;--drop-y:${dy.toFixed(0)}px;--drop-rot:${rot.toFixed(0)}deg;animation-delay:${(i * 25)}ms">💧</span>`;
      }
      // Append rather than overwrite — shards may have been spawned first
      // and we don't want to wipe them.
      host.insertAdjacentHTML('beforeend', html);
    }
    // Glass shards — explode outward from the cup's centre in a starburst.
    // 12 shards spread evenly around a circle (~120-180px radius) with random
    // rotation. The `--shard-x/y/rot` CSS vars feed the liarShardFly keyframe.
    function liarSpawnShards(host){
      const shards = 12;
      let html = '';
      for (let i = 0; i < shards; i++) {
        const angle = (i / shards) * Math.PI * 2 + (Math.random() - 0.5) * 0.55;
        const dist  = 95 + Math.random() * 85;
        const sx = Math.cos(angle) * dist;
        const sy = Math.sin(angle) * dist - 12; // slight upward bias for a burst feel
        const rot = (Math.random() - 0.5) * 1440; // up to ±720deg spin
        const delay = i * 8;
        html += `<span class="liar-shard" style="--shard-x:${sx.toFixed(0)}px;--shard-y:${sy.toFixed(0)}px;--shard-rot:${rot.toFixed(0)}deg;animation-delay:${delay}ms"></span>`;
      }
      host.insertAdjacentHTML('beforeend', html);
    }
    // Full-screen vignette — appended to <body> during shatter, removed after
    // the 2.4s keyframe completes. Kept defensively self-cleaning in case
    // the user navigates away mid-animation.
    function liarShowVignette(){
      const v = document.createElement('div');
      v.className = 'liar-vignette show';
      document.body.appendChild(v);
      setTimeout(() => { try { document.body.removeChild(v); } catch(e){} }, 2500);
    }
    function liarFullScreenFlash(kind){
      const flash = document.createElement('div');
      flash.className = 'liar-flash ' + kind;
      document.body.appendChild(flash);
      // Remove after the animation finishes so nothing sticky lingers
      setTimeout(() => { try { document.body.removeChild(flash); } catch(e){} }, 600);
    }
    function liarBodyShake(intensity){
      // No-op: the user asked for the wheel/cup to stop shaking. Kept as a
      // function so the 4 call sites (cup cinematic + wheel-test demo) don't
      // need to change. Original implementation:
      //   added `.liar-shake` (+ `heavy`|`soft`) to <body>, removed after
      //   460–760ms. The CSS keyframes still exist for future use.
      return;
    }

    // Render the chambers — pre-reveal (just `?` markers) or post-reveal (real
    // safe/spill colours). Like liarRenderCupChambersSpinning, this TOGGLES
    // classes on stable DOM nodes when possible so the transition from
    // "spinning highlight" → "revealed colours" animates smoothly via the
    // chamber's .16s base transition. If chamber count changed, falls back
    // to a one-time innerHTML rebuild.
    function liarRenderCupChambers(showResult){
      const wrap = document.getElementById('liar-cup-chambers');
      if (!wrap) return;
      const pattern = liarState.sipChamberIsSpill || [];
      if (!pattern.length) return;
      let chambers = wrap.querySelectorAll('.liar-cup-chamber');
      if (chambers.length !== pattern.length) {
        wrap.innerHTML = pattern.map(() => '<div class="liar-cup-chamber">?</div>').join('');
        chambers = wrap.querySelectorAll('.liar-cup-chamber');
      }
      pattern.forEach((isSpill, i) => {
        const el = chambers[i];
        if (!el) return;
        const isPicked = i === liarState.sipChamberIdx;
        // Strip transient classes from the spin phase so the chamber settles
        // into its real post-reveal state cleanly. CSS transitions on
        // background/border carry the colour morph (gold → red/green).
        el.classList.remove('rolling','settle');
        const wantSpill    = showResult && isSpill;
        const wantSafe     = showResult && !isSpill;
        const wantRevealed = isPicked && (showResult || true);
        if (el.classList.contains('spill') !== wantSpill) el.classList.toggle('spill', wantSpill);
        if (el.classList.contains('safe')  !== wantSafe)  el.classList.toggle('safe',  wantSafe);
        if (el.classList.contains('revealed') !== wantRevealed) el.classList.toggle('revealed', wantRevealed);
        const text = showResult ? (isSpill ? '💧' : '·') : '?';
        if (el.textContent !== text) el.textContent = text;
      });
      parseEmoji(wrap);
    }

    function liarTakeSip(){
      if (liarState.phase !== 'cup' || liarState.sipTaken) return; // double-fire safety
      // Only the loser's device fires this. (See note in liarStartSip about
      // the removed lowest-connected fallback.)
      if (!cardLobbyShouldITakeAction(liarState.pendingLoserId)) return;
      liarClearAutoSip();
      // Server picks the chamber + resolves outcome (C2 turn 3b). A cheating
      // client cannot rig their own cup outcome.
      huddleCallRPC('huddle_liar_take_sip', { p_code: liarState.code });
    }

    // Pure content render — called by the cup animation after sipTaken=true
    // to slide in the result panel. No button-state side effects.
    function liarShowSipResult(){
      const loser = liarState.players.find(p => p.id === liarState.pendingLoserId);
      const loserDisp = playerDisplayFor(loser, liarState.claimedBy);
      const resultEl = document.getElementById('liar-cup-result');
      const resultEmoji = document.getElementById('liar-cup-result-emoji');
      const resultTitle = document.getElementById('liar-cup-result-title');
      const resultText = document.getElementById('liar-cup-result-text');
      if (!resultEl) return;

      // Decide the auto-advance hint copy. If the spill eliminates the loser AND
      // only one player remains, the next step is the WINNER screen, not another
      // round — so the hint should say "Crowning the winner…" instead.
      let nextHintKey = 'liar.autoNextRound';
      if (liarState.sipOutcome === 'spilled') {
        const survivorsAfter = liarState.alivePlayers.filter(id => id !== liarState.pendingLoserId);
        if (survivorsAfter.length <= 1) nextHintKey = 'liar.autoNextWinner';
      }
      const hint = '<div class="liar-cup-autohint"><span class="liar-auto-dot"></span> ' + escapeHTML(t(nextHintKey)) + '</div>';

      if (liarState.sipOutcome === 'safe') {
        resultEl.className = 'liar-cup-result safe';
        if (resultEmoji) { resultEmoji.style.display = ''; resultEmoji.textContent = '😅'; }
        if (resultTitle) resultTitle.textContent = t('liar.cupSafeTitle');
        if (resultText) resultText.innerHTML = t('liar.cupSafeText', { nextSpills: Math.min(6, liarState.cupSpills + 1) }) + hint;
      } else {
        // SPILL: hide the small 💧 emoji and replace it with the big OUT
        // stamp. The loser's name in the body text gets a draw-on strikethrough
        // to drive home "you're eliminated".
        resultEl.className = 'liar-cup-result spilled';
        if (resultEmoji) { resultEmoji.style.display = 'none'; resultEmoji.textContent = ''; }
        if (resultTitle) {
          // Prepend the OUT stamp — wrap title to render the stamp above the
          // "You SPILLED!" text. Set via innerHTML so the keyframe-driven span
          // animates on insert.
          resultTitle.innerHTML = '<div class="liar-out-stamp">OUT</div>'
            + escapeHTML(t('liar.cupSpilledTitle'));
        }
        if (resultText) {
          const struckName = '<strong><span class="liar-name-strike">'
            + escapeHTML(loserDisp.name)
            + '</span></strong>';
          resultText.innerHTML = t('liar.cupSpilledText', { name: struckName }) + hint;
        }
      }
      parseEmoji(resultEl);
      resultEl.style.display = '';
    }

    function liarAfterSip(){
      if (liarState.phase !== 'cup' || !liarState.sipTaken) return; // double-tap safety
      // Only the loser's device fires this. (See note in liarStartSip about
      // the removed lowest-connected fallback.)
      if (!cardLobbyShouldITakeAction(liarState.pendingLoserId)) return;
      // Server handles: elimination/survival, win detection, next-round deal
      // (winner-of-call leads), or game-end if 1 survivor remains (C2 turn 3b).
      // All the round-starter rule logic and the cascade into the next round
      // are folded into the single huddle_liar_after_sip RPC.
      huddleCallRPC('huddle_liar_after_sip', { p_code: liarState.code });
    }

    // ---------- Result ----------
    function liarRenderResultContent(){
      const winnerId = liarState.winnerId;
      const winner = winnerId ? liarState.players.find(p => p.id === winnerId) : null;
      ensureClaimantProfiles(Object.values(liarState.claimedBy || {}), liarRenderResultContent);
      const winnerDisplay = winner ? playerDisplayFor(winner, liarState.claimedBy) : null;
      const winnerName = winner && winner.id === liarMe.myId ? t('picker.you') : (winnerDisplay ? winnerDisplay.name : '');
      const winTitleEl = document.getElementById('liar-win-title');
      if (winTitleEl) winTitleEl.textContent = winner
        ? t('liar.winTitle', { name: winnerName })
        : t('liar.resultHeader');

      const lb = document.getElementById('liar-leaderboard');
      if (!lb) return;
      // Only show CLAIMED seats — empty seats shouldn't appear on the leaderboard.
      const claimedSet = new Set(Object.keys(liarState.claimedBy || {}));
      const sorted = liarState.players.filter(p => claimedSet.has(p.id)).sort((a, b) => {
        const wa = liarState.wins[a.id] || 0;
        const wb = liarState.wins[b.id] || 0;
        if (wb !== wa) return wb - wa;
        return a.name.localeCompare(b.name);
      });
      lb.innerHTML = sorted.map((p, i) => {
        const wins = liarState.wins[p.id] || 0;
        const isWinner = p.id === winnerId;
        const isMe = p.id === liarMe.myId;
        const winsKey = wins === 1 ? 'cham.scoreWinsOne' : 'cham.scoreWins';
        const rowDisplay = playerDisplayFor(p, liarState.claimedBy);
        return `
          <div class="lb-row ${isWinner ? 'winner' : ''}">
            <div class="lb-rank">${i+1}</div>
            ${avatarHTML(rowDisplay.avatar, 44, { fallback: p.initial })}
            <div class="lb-name">${isMe ? t('picker.you') : escapeHTML(rowDisplay.name)}</div>
            <div class="lb-score">${t(winsKey, { n: wins })}</div>
          </div>
        `;
      }).join('');
      parseEmoji(lb);

      // Configure the Play again / Leave buttons by role:
      //   • Host  → "Play again" (primary, enabled) + "Leave" (outline, closes room for everyone)
      //   • Other → "Waiting for host to start new game…" (primary, disabled) + "Leave" (outline, just me)
      const amHostResult = cardLobbyGetSessionId() === liarState.hostId;
      const playAgainBtn = document.getElementById('liar-result-playagain-btn');
      const leaveResultBtn = document.getElementById('liar-result-leave-btn');
      if (playAgainBtn) {
        if (amHostResult) {
          playAgainBtn.textContent = t('liar.playAgain');
          playAgainBtn.onclick = liarPlayAgain;
          playAgainBtn.disabled = false;
        } else {
          playAgainBtn.textContent = t('result.waitingForHostNewGame');
          playAgainBtn.onclick = null;
          playAgainBtn.disabled = true;
        }
      }
      if (leaveResultBtn) {
        leaveResultBtn.textContent = t('result.leaveGame');
        leaveResultBtn.onclick = amHostResult ? liarCloseRoom : liarLeaveGameOver;
      }
    }

    function liarPlayAgain(){
      if (liarState.phase !== 'result') return; // double-tap safety
      // Host-only — non-host sees "Waiting for host…" on the disabled button.
      const amHost = cardLobbyGetSessionId() === liarState.hostId;
      if (!amHost) return;
      // Server-validated reset (C2 turn 3). Server returns to phase='lobby'
      // with wins preserved; the realtime echo updates this device.
      huddleCallRPC('huddle_liar_play_again', { p_code: liarState.code });
    }

    // Sync the pre-paint screen override (set by the bootstrap script in
    // <head>) into the .active-class system, then clear the override so
    // JS-driven goTo() works normally from here on. Without this, removing
    // the attribute would un-hide login (since login still has .active in
    // the source HTML).
    (function syncBootScreen(){
      var bootScreen = document.documentElement.getAttribute('data-boot-screen');
      if (bootScreen) {
        document.documentElement.removeAttribute('data-boot-screen');
        // Route through goTo() so bottom-nav visibility, active-tab highlight,
        // and screen render fns (friendsLoad / renderProfileScreen / etc.) all
        // fire correctly. Suppress history push so we don't add a duplicate
        // entry for the initial paint.
        try {
          _huddleSuppressHistory = true;
          goTo(bootScreen);
        } catch(e) {
          // Fallback: at minimum, toggle the .active class so something shows
          document.querySelectorAll('.screen').forEach(function(el){
            el.classList.toggle('active', el.id === 'screen-' + bootScreen);
          });
        } finally {
          _huddleSuppressHistory = false;
        }
      }
    })();

    // Initialize on load (label + active state). The data-theme attribute itself
    // was already set pre-paint by the bootstrap script in <head>.
    applyTheme(getThemePref());

    // First render so screens are ready before the user visits them.
    renderProfileScreen();
    friendsLoad();
    renderGamesStep();

    // Translate everything to the saved language. Runs after renders so it
    // also catches text that render fns just inserted (those use t() but we
    // still call applyLang to refresh active states on theme/lang options).
    applyLang();

    // Auth bootstrap — Google-only.
    // Prior versions of this app auto-signed-in every visitor anonymously AND
    // seeded a "Jordan Lee" profile row into Supabase. The result was that any
    // visitor — including a friend opening the site on a different device — got
    // auto-"logged in" as Jordan Lee on refresh. The fix here:
    //   1. Only restore a session if it's a real (non-anonymous) Google user.
    //   2. If a stale anonymous session is found, sign it out so the user lands
    //      on the login screen instead of being silently identified as someone.
    //   3. Do NOT pre-warm anonymous auth on page boot. Anon sign-in still
    //      happens lazily when a multiplayer lobby is actually opened (lobby
    //      bootstrap calls it), but a visitor sitting on the login page no
    //      longer becomes a real Supabase user just by loading the page.
    if (window.sb) {
      (async () => {
        // If the user arrived via a shared lobby URL (?room=ABCD), the lobby
        // bootstrap will need their existing anon Supabase session to keep
        // their seat claim consistent across refreshes. Skip the anon signOut
        // in that flow.
        let inLobbyFlow = false;
        try {
          inLobbyFlow = !!new URLSearchParams(window.location.search).get('room');
        } catch(e){}

        try {
          const { data: { session } } = await window.sb.auth.getSession();
          const user = session && session.user;
          if (user && !user.is_anonymous) {
            await huddleAfterSignIn(user);
            return;
          }
          // Defense-in-depth: an anonymous session left over from prior buggy
          // builds is what powered the "logged in as Jordan Lee" effect on
          // refresh. Sign it out unless the user is mid-lobby-flow.
          if (user && user.is_anonymous && !inLobbyFlow) {
            try { await window.sb.auth.signOut(); } catch(e){}
          }
        } catch(e) { /* fall through — treat as signed-out */ }

        // No real Google session. Clear any leftover profile cached by older
        // builds so the Profile screen doesn't render a stale identity, and
        // route the visitor back to the login screen if the saved-lastScreen
        // logic dropped them inside an authed area (Games / Profile / Friends /
        // Edit Profile / Feedback). Lobby-link flows (?room=) are left alone so
        // a shared invite still opens the lobby and lobby code can prompt for
        // sign-in if it needs to.
        // Localhost preview is exempt — Google OAuth can't reach localhost so
        // there will NEVER be a real session, and wiping would nuke the dev
        // profile seeded by the localhost sign-in bypass on every reload.
        const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);
        if (!isLocalHost) {
          try { localStorage.removeItem(PROFILE_KEY); } catch(e){}
          myProfile = null;
          if (typeof renderProfileScreen === 'function') renderProfileScreen();
        }
        // Same localhost exemption — on dev preview, don't kick the user back
        // to login just because Google OAuth never happened. The dev profile
        // (seeded by the sign-in bypass) is "good enough" for previewing.
        if (!isLocalHost) {
          try {
            const authedScreens = { 'games':1, 'profile':1, 'friends':1, 'edit-profile':1, 'feedback-board':1 };
            const current = document.querySelector('.screen.active');
            const id = current && current.id ? current.id.replace(/^screen-/, '') : '';
            if (authedScreens[id]) {
              // Also drop the stale last-screen marker so a subsequent refresh
              // doesn't yank them back into an authed area.
              try { sessionStorage.removeItem('huddle.lastScreen'); } catch(e){}
              if (typeof goTo === 'function') goTo('login');
            }
          } catch(e){}
        }
      })();

      // Auth state changes:
      //  - PASSWORD_RECOVERY: user clicked the email-reset link → "set new password" form
      //  - SIGNED_IN: Google OAuth bounced back (or email login on another tab)
      //    Only handle non-anonymous sign-ins here — the anon path is wired
      //    elsewhere and we don't want to redirect on every guest pre-warm.
      window.sb.auth.onAuthStateChange((event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
          huddleSetAuthMode('reset');
          goTo('login');
          return;
        }
        if (event === 'SIGNED_IN' && session && session.user && !session.user.is_anonymous) {
          huddleAfterSignIn(session.user);
        }
        // Real sign-out — tear down auth-aware UI (admin row, email row).
        // renderProfileScreen no longer does this on a getUser() blip, so
        // SIGNED_OUT is the single source of truth for "tear down".
        if (event === 'SIGNED_OUT') {
          try { setHuddleAdmin(false); } catch(e){}
          const authRow = document.getElementById('profile-auth-row');
          const authEmail = document.getElementById('profile-auth-email');
          if (authRow) authRow.hidden = true;
          if (authEmail) authEmail.textContent = '';
          // M2 (2026-06-27): full local teardown so a SIGNED_OUT fired by ANOTHER
          // tab (or a server-side session end) doesn't leave THIS tab still
          // showing the old account. Guard against a TRANSIENT SIGNED_OUT (e.g. a
          // token-refresh blip): confirm there's really no session before the
          // disruptive part (clearing profile + routing to login), so we never
          // eject a still-valid user. Idempotent with huddleSignOut.
          (async () => {
            try {
              if (window.sb && window.sb.auth) {
                const { data } = await window.sb.auth.getSession();
                if (data && data.session && data.session.user) return; // false alarm — still signed in
              }
              myProfile = null;
              if (typeof renderProfileScreen === 'function') renderProfileScreen();
              const _cur = document.querySelector('.screen.active');
              const _id = _cur && _cur.id ? _cur.id.replace(/^screen-/, '') : '';
              const _authed = { 'games':1,'profile':1,'friends':1,'edit-profile':1,'feedback-board':1,'admin':1,'admin-feedback':1,'admin-stats':1 };
              if (_authed[_id] && typeof goTo === 'function') goTo('login');
            } catch(e){}
          })();
        }
      });
    }

    // If the URL contains ?room=CODE — typically because the user scanned a friend's
    // QR or opened a shared link — skip the login screen and jump directly into the
    // Liar's Cup lobby for that specific room.
    (function autoOpenFromRoomUrl(){
      let params;
      try { params = new URLSearchParams(window.location.search); } catch(e){ return; }
      const code = params.get('room');
      const game = params.get('game');
      if (!code) return;
      // Returns the open promise so callers can await routing before revealing.
      const openFn = () => {
        if (game === 'hotseat')        return openLobby();
        else if (game === 'chameleon') return openChamLobby();
        else if (game === 'mafia')     return openMafiaLobby();
        else                           return openLiarLobby(); // backwards compat: missing/liar game param
      };
      // Drop the boot reconnect veil (see index.html). Idempotent.
      const hideVeil = () => { try { document.documentElement.removeAttribute('data-reconnecting'); } catch(e){} };
      const tableForGame = { hotseat:'hotseat_rooms', chameleon:'chameleon_rooms', mafia:'mafia_rooms', liar:'liar_rooms' };
      setTimeout(async () => {
        try {
          const tbl = tableForGame[game] || 'liar_rooms';
          const upperCode = String(code).toUpperCase();
          let user = null;
          try { if (window.sb) { const r = await window.sb.auth.getUser(); user = r && r.data && r.data.user; } } catch(e){}
          // Signed-in users already have a name → straight in. (await so the veil
          // only lifts once we've routed to the right screen — no lobby flash.)
          if (user && !user.is_anonymous) { await openFn(); return; }
          // RECONNECT: an anonymous user who ALREADY holds a seat in this room is
          // RETURNING (refresh / phone lock / reopen mid-game), not joining fresh.
          // Send them straight back into their seat — do NOT re-prompt for a name
          // (that name sheet was blocking every Mafia reconnect). Only a truly new
          // guest (no seat yet) gets the name-required + no-duplicate prompt.
          try {
            if (user && user.id && window.sb) {
              const { data: row } = await window.sb.from(tbl).select('state').eq('code', upperCode).maybeSingle();
              const cb = row && row.state && row.state.claimedBy;
              if (cb && Object.values(cb).indexOf(user.id) !== -1) { await openFn(); return; }
            }
          } catch(e){}
          // Login required (2026-06-27): a visitor who isn't signed in can no
          // longer join as a guest. Drop the veil and send them to sign in. The
          // ?room=&game= params stay in the URL, so after Google sign-in the
          // OAuth redirect brings them back here and the signed-in branch above
          // joins them straight into the room.
          hideVeil();
          if (typeof goTo === 'function') goTo('login');
        } catch(e){ try { await openFn(); } catch(_){} }
        finally { hideVeil(); }
      }, 0);
    })();

    // Twemoji is loaded with `defer` so it executes AFTER this inline script.
    // Re-parse the whole document once DOMContentLoaded fires to convert any
    // initially-rendered native emoji glyphs into centered SVG twemoji.
    document.addEventListener('DOMContentLoaded', () => {
      parseEmoji(document.body);
    });

    // Backstop refresh — when the tab regains focus after being hidden, re-pull
    // friend + invite data. Realtime channels handle live updates while the tab
    // is open; this catches anything missed while the device was asleep or the
    // tab was backgrounded (mobile browsers throttle/disconnect sockets).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      try {
        if (typeof friendsState !== 'undefined' && friendsState.me &&
            typeof friendsLoad === 'function') friendsLoad();
      } catch(e){}
      try {
        if (typeof invitesState !== 'undefined' && invitesState.me &&
            typeof invitesLoad === 'function') invitesLoad();
      } catch(e){}
      // Phone-lock / app-switch reconnect: while the tab was hidden the realtime
      // socket was likely killed by the OS. Re-pull + force-rebuild the active
      // game room's channel so we re-announce presence (which holds our seat
      // within the 60s grace) and resume live updates. No-op outside a game room.
      try { if (typeof huddleResumeActiveRoom === 'function') huddleResumeActiveRoom(); } catch(e){}
    });

