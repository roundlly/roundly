// Huddle app-04-friends-invites.js (fragment 4/10, split from app.js).
// All fragments share ONE global scope and MUST load in numeric order — do not reorder.

    // ---------- Friends (Supabase-backed) ----------
    // Real friends + friend-request system. Reads from public.friendships
    // joined with public.profiles. See Phase 2 SQL in the project docs.
    const friendsState = {
      me: null,
      friends: [],       // accepted, joined with other party's profile
      incoming: [],      // pending where addressee_id = me
      outgoing: [],      // pending where requester_id = me
      searchResults: [], // profile rows matching current query (minus self+related)
      searchQuery: '',
      searchStatus: '',  // 'min' | 'searching' | 'empty' | 'ok'
      activeTab: 'all',
      loading: false,
      // True once a friends fetch has completed at least once (success OR a
      // signed-out resolution). Lets the lobby invite sheet tell "still loading,
      // don't flash 'No friends yet'" apart from "loaded, genuinely 0 friends".
      loadedOnce: false,
    };
    let friendsSearchTimer = null;

    // Thin alias for the canonical huddleEscape (app-01). Kept so the ~40 existing
    // friendsEscape() call sites stay untouched (low blast radius) — single implementation now.
    function friendsEscape(s){
      return huddleEscape(s);
    }

    function friendsDisplayName(p){
      if (!p) return '';
      return p.display_name || p.username || 'Player';
    }

    async function friendsLoad(){
      const container = document.getElementById('friends-list-container');
      if (!container) return;
      if (!window.sb) {
        friendsState.me = null;
        friendsState.friends = [];
        friendsState.incoming = [];
        friendsState.outgoing = [];
        renderFriends();
        return;
      }
      try {
        friendsState.loading = true;
        const { data: { user } } = await window.sb.auth.getUser();
        if (!user || user.is_anonymous) {
          // A BACKSTOP refresh (tab-return / online / pageshow / BFCache) can hit
          // this momentarily while the JWT is mid-refresh — getUser briefly returns
          // no user even though we are still signed in. If we ALREADY established a
          // real signed-in user this session, treat it as a transient blip and KEEP
          // the last-known-good lists instead of wiping them to the signed-out
          // empty state — wiping is exactly what made the open invite sheet flash
          // "No friends yet" / the sign-in nudge after switching tabs and back. A
          // genuine sign-out is handled by the explicit SIGNED_OUT teardown (app-09),
          // and the next successful friendsLoad reconciles anyway.
          if (friendsState.loadedOnce && friendsState.me) {
            friendsState.loading = false;
            if (typeof refreshLobbyInviteSheetIfOpen === 'function') refreshLobbyInviteSheetIfOpen();
            return;
          }
          friendsState.me = null;
          friendsState.friends = [];
          friendsState.incoming = [];
          friendsState.outgoing = [];
          friendsState.loading = false;
          renderFriends();
          return;
        }
        friendsState.me = user.id;

        const { data: rows, error } = await window.sb
          .from('friendships')
          .select('id, requester_id, addressee_id, status, created_at, updated_at')
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);
        if (error) {
          console.warn('[Huddle] friendsLoad query failed:', error.message);
          friendsState.loading = false;
          renderFriends();
          return;
        }

        // Collect "other party" ids and batch-fetch profiles.
        const otherIds = new Set();
        (rows || []).forEach(r => {
          const other = r.requester_id === user.id ? r.addressee_id : r.requester_id;
          if (other) otherIds.add(other);
        });
        const profilesById = {};
        if (otherIds.size > 0) {
          const ids = Array.from(otherIds);
          const { data: profs, error: pErr } = await window.sb
            .from('profiles')
            .select('user_id, username, display_name, avatar')
            .in('user_id', ids);
          if (pErr) {
            console.warn('[Huddle] friends profile lookup failed:', pErr.message);
          } else {
            (profs || []).forEach(p => { profilesById[p.user_id] = p; });
          }
        }

        const friends = [];
        const incoming = [];
        const outgoing = [];
        (rows || []).forEach(r => {
          const otherId = r.requester_id === user.id ? r.addressee_id : r.requester_id;
          const profile = profilesById[otherId] || { user_id: otherId, username: '', display_name: '', avatar: null };
          const entry = { row: r, otherId, profile };
          if (r.status === 'accepted') friends.push(entry);
          else if (r.status === 'pending' && r.addressee_id === user.id) incoming.push(entry);
          else if (r.status === 'pending' && r.requester_id === user.id) outgoing.push(entry);
        });

        friendsState.friends = friends;
        friendsState.incoming = incoming;
        friendsState.outgoing = outgoing;
        friendsState.loading = false;
        friendsState.loadedOnce = true;
        renderFriends();
        // If a lobby invite sheet is open, flip it from the loading placeholder to
        // the real friends list the instant the data lands — without waiting for a
        // presence-sync event (the old path), which was the source of the 1-2s
        // "No friends yet" flash the host saw.
        if (typeof refreshLobbyInviteSheetIfOpen === 'function') refreshLobbyInviteSheetIfOpen();
        // Keep the open search panel in sync — e.g. if a request gets cancelled
        // (locally or via realtime), the row should switch from "Request sent"
        // back to the "Add" button without the user having to retype.
        if (typeof renderFriendsSearchResults === 'function') renderFriendsSearchResults();
        // Realtime: subscribe to my friendships rows + the profiles of my friends
        // so add/accept/decline/remove and friend name/avatar edits propagate live.
        try { if (typeof friendsWireSync === 'function') friendsWireSync(); } catch(e){}
        try { if (typeof friendsWireProfileWatch === 'function') friendsWireProfileWatch(); } catch(e){}
        try { if (typeof friendsWirePresence === 'function') friendsWirePresence(); } catch(e){}
        // Phase 4 — kick off invites load/wire on first friends load (post-sign-in).
        if (typeof invitesLoad === 'function' && (!invitesState.me || invitesState.me !== user.id)) {
          invitesLoad().then(() => { if (typeof invitesWireSync === 'function') invitesWireSync(); });
        } else if (typeof renderLobbyInvitesAll === 'function') {
          renderLobbyInvitesAll();
        }
      } catch(e) {
        console.warn('[Huddle] friendsLoad exception:', e);
        friendsState.loading = false;
        renderFriends();
      }
    }

    // ---------- Friends realtime sync ----------
    // Mirrors the invitesWireSync pattern (see Phase 4 below): one channel per
    // user, multiple .on() handlers for the rows that touch this user. Any
    // INSERT / UPDATE / DELETE just retriggers friendsLoad() — re-fetching is
    // cheap and keeps a single source of truth instead of patching local state.
    let _friendsChannel = null;
    let _friendsChannelUserId = null;
    let _friendsProfilesChannel = null;
    let _friendsProfilesIds = '';

    // Presence — Supabase Realtime Presence. One global channel; every signed-in
    // user tracks themselves, clients see the union via presenceState(). On tab
    // close Supabase auto-fires "leave" so no server-side cleanup needed.
    const friendsPresence = new Set();   // user_ids currently online (peers + self)
    let _friendsPresenceChannel = null;
    let _friendsPresenceUserId = null;

    function friendsRebuildPresence(){
      if (!_friendsPresenceChannel) { friendsPresence.clear(); return; }
      try {
        const state = _friendsPresenceChannel.presenceState();
        friendsPresence.clear();
        Object.keys(state).forEach(key => friendsPresence.add(key));
      } catch(e) {
        console.warn('[Huddle] friendsRebuildPresence failed:', e);
      }
    }

    function friendsWirePresence(){
      if (!window.sb || !friendsState.me) return;
      if (_friendsPresenceChannel && _friendsPresenceUserId === friendsState.me) return;
      if (_friendsPresenceChannel) {
        try { window.sb.removeChannel(_friendsPresenceChannel); } catch(e){}
        _friendsPresenceChannel = null;
        _friendsPresenceUserId = null;
      }
      try {
        const me = friendsState.me;
        const ch = window.sb.channel('friends_presence_global', {
          config: { presence: { key: me } }
        });
        // Each presence event re-renders the Friends screen AND any open Lobby Invite sheet
        // so the online/offline grouping there updates in real time as people join/leave.
        const onPresenceChange = () => {
          friendsRebuildPresence();
          if (typeof renderFriends === 'function') renderFriends();
          if (typeof refreshLobbyInviteSheetIfOpen === 'function') refreshLobbyInviteSheetIfOpen();
        };
        ch.on('presence', { event: 'sync' }, onPresenceChange)
        .on('presence', { event: 'join' }, onPresenceChange)
        .on('presence', { event: 'leave' }, onPresenceChange)
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            try { await ch.track({ online_at: new Date().toISOString() }); } catch(e){}
          }
        });
        _friendsPresenceChannel = ch;
        _friendsPresenceUserId = me;
      } catch(e) {
        console.warn('[Huddle] friendsWirePresence failed:', e);
        _friendsPresenceChannel = null;
        _friendsPresenceUserId = null;
      }
    }

    function friendsUnwirePresence(){
      try {
        if (_friendsPresenceChannel && window.sb) {
          try { _friendsPresenceChannel.untrack(); } catch(e){}
          window.sb.removeChannel(_friendsPresenceChannel);
        }
      } catch(e){}
      _friendsPresenceChannel = null;
      _friendsPresenceUserId = null;
      friendsPresence.clear();
    }

    function friendsWireSync(){
      if (!window.sb || !friendsState.me) return;
      if (_friendsChannel && _friendsChannelUserId === friendsState.me) return; // already wired for this user
      // User changed (without going through sign-out) — tear down the stale channel first
      if (_friendsChannel) {
        try { window.sb.removeChannel(_friendsChannel); } catch(e){}
        _friendsChannel = null;
        _friendsChannelUserId = null;
      }
      try {
        const me = friendsState.me;
        _friendsChannel = window.sb
          .channel('friendships_' + me)
          .on('postgres_changes',
              { event: '*', schema: 'public', table: 'friendships', filter: 'requester_id=eq.' + me },
              () => { friendsLoad(); })
          .on('postgres_changes',
              { event: '*', schema: 'public', table: 'friendships', filter: 'addressee_id=eq.' + me },
              () => { friendsLoad(); })
          .subscribe();
        _friendsChannelUserId = me;
      } catch(e) {
        console.warn('[Huddle] friendsWireSync failed:', e);
        _friendsChannel = null;
        _friendsChannelUserId = null;
      }
    }

    function friendsUnwireSync(){
      try { if (_friendsChannel && window.sb) window.sb.removeChannel(_friendsChannel); } catch(e){}
      _friendsChannel = null;
      _friendsChannelUserId = null;
      try { if (_friendsProfilesChannel && window.sb) window.sb.removeChannel(_friendsProfilesChannel); } catch(e){}
      _friendsProfilesChannel = null;
      _friendsProfilesIds = '';
      friendsUnwirePresence();
    }

    // Live-update friend profile cards (name/avatar) by subscribing to UPDATEs
    // on the profiles rows of the current friend set. Re-wires when the set
    // changes (someone added/removed) so the IN filter stays accurate.
    function friendsWireProfileWatch(){
      if (!window.sb || !friendsState.me) return;
      const ids = friendsState.friends.map(f => f.otherId).filter(Boolean).sort();
      const key = ids.join(',');
      if (key === _friendsProfilesIds && _friendsProfilesChannel) return;
      try { if (_friendsProfilesChannel) window.sb.removeChannel(_friendsProfilesChannel); } catch(e){}
      _friendsProfilesChannel = null;
      _friendsProfilesIds = key;
      if (ids.length === 0) return;
      try {
        _friendsProfilesChannel = window.sb
          .channel('friend_profiles_' + friendsState.me)
          .on('postgres_changes',
              { event: 'UPDATE', schema: 'public', table: 'profiles', filter: 'user_id=in.(' + ids.join(',') + ')' },
              () => { friendsLoad(); })
          .subscribe();
      } catch(e) {
        console.warn('[Huddle] friendsWireProfileWatch failed:', e);
      }
    }

    function friendsRelationship(otherId){
      if (!otherId) return 'none';
      if (friendsState.friends.some(f => f.otherId === otherId)) return 'friends';
      if (friendsState.outgoing.some(f => f.otherId === otherId)) return 'sent';
      if (friendsState.incoming.some(f => f.otherId === otherId)) return 'incoming';
      return 'none';
    }

    function friendsSetTab(name){
      friendsState.activeTab = name;
      const map = { all: 'friends-tab-all', requests: 'friends-tab-requests' };
      Object.keys(map).forEach(k => {
        const el = document.getElementById(map[k]);
        if (el) el.classList.toggle('active', k === name);
      });
      renderFriends();
    }

    function friendsRenderRowAccepted(entry){
      const p = entry.profile;
      const name = friendsDisplayName(p);
      const handle = p.username ? '@' + p.username : '';
      const avatar = p.avatar || deterministicAvatar(entry.otherId);
      const isOnline = friendsPresence.has(entry.otherId);
      return `
        <div class="friend-row ${isOnline ? 'is-online' : 'is-offline'}">
          ${avatarHTML(avatar, 44, { fallback: (name[0] || '?').toUpperCase(), online: isOnline })}
          <div class="friend-info">
            <div class="friend-name">${friendsEscape(name)}</div>
            <div class="friend-status">${friendsEscape(handle)}</div>
          </div>
          <div class="friend-row-actions">
            <button class="friend-overflow" onclick="openFriendMenu('${friendsEscape(entry.otherId)}', '${friendsEscape(name)}')" aria-label="${friendsEscape(t('friends.actionRemove'))}">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </button>
          </div>
        </div>
      `;
    }

    function friendsRenderRowIncoming(entry){
      const p = entry.profile;
      const name = friendsDisplayName(p);
      const handle = p.username ? '@' + p.username : '';
      const avatar = p.avatar || deterministicAvatar(entry.otherId);
      return `
        <div class="friend-row">
          ${avatarHTML(avatar, 44, { fallback: (name[0] || '?').toUpperCase() })}
          <div class="friend-info">
            <div class="friend-name">${friendsEscape(name)}</div>
            <div class="friend-status">${friendsEscape(handle)}</div>
          </div>
          <div class="friend-row-actions">
            <button class="btn btn-primary btn-sm" onclick="friendRequestAccept('${friendsEscape(entry.otherId)}')">${t('friends.actionAccept')}</button>
            <button class="friend-remove-btn" onclick="friendRequestDecline('${friendsEscape(entry.otherId)}')">${t('friends.actionDecline')}</button>
          </div>
        </div>
      `;
    }

    // Phase 4 — row renderer for incoming game invites on the Requests tab
    function friendsRenderRowGameInvite(invite){
      const p = invite.sender || {};
      const name = friendsDisplayName(p) || 'A friend';
      const gameName = inviteGameLabel(invite.row.game);
      const avatar = p.avatar || deterministicAvatar(p.user_id);
      const escId = friendsEscape(invite.row.id);
      return `
        <div class="friend-row">
          ${avatarHTML(avatar, 44, { fallback: (name[0] || '?').toUpperCase() })}
          <div class="friend-info">
            <div class="friend-name">${friendsEscape(name)}</div>
            <div class="friend-status">${friendsEscape(gameName)}</div>
          </div>
          <div class="friend-row-actions">
            <button class="btn btn-primary btn-sm" onclick="inviteAcceptById('${escId}')">${friendsEscape(t('invite.join'))}</button>
            <button class="friend-remove-btn" onclick="inviteDeclineById('${escId}')">${friendsEscape(t('invite.decline'))}</button>
          </div>
        </div>
      `;
    }

    // Helpers used by inline onclick handlers — look up invite by id then call accept/decline
    function inviteAcceptById(id){
      const inv = (invitesState.incoming || []).find(i => i.row.id === id);
      if (inv) inviteAccept(inv);
    }
    function inviteDeclineById(id){
      const inv = (invitesState.incoming || []).find(i => i.row.id === id);
      if (inv) inviteDecline(inv);
    }

    function friendsRenderRowOutgoing(entry){
      const p = entry.profile;
      const name = friendsDisplayName(p);
      const handle = p.username ? '@' + p.username : '';
      const avatar = p.avatar || deterministicAvatar(entry.otherId);
      // "Request sent" pending pill + Cancel (LinkedIn "Pending / Withdraw"
      // pattern). The pill makes the waiting state explicit — important now that
      // sent requests also surface at the top of the All tab, where a lone
      // Cancel button gave no hint that we're waiting on the other person.
      return `
        <div class="friend-row">
          ${avatarHTML(avatar, 44, { fallback: (name[0] || '?').toUpperCase() })}
          <div class="friend-info">
            <div class="friend-name">${friendsEscape(name)}</div>
            <div class="friend-status">${friendsEscape(handle)}</div>
          </div>
          <div class="friend-row-actions">
            <span class="friend-status-pill" style="color:var(--text-secondary)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></svg>${t('friends.requestSent')}</span>
            <button class="friend-remove-btn" onclick="friendRequestCancel('${friendsEscape(entry.otherId)}')">${t('friends.actionCancel')}</button>
          </div>
        </div>
      `;
    }

    function renderFriends(){
      const container = document.getElementById('friends-list-container');
      if (!container) return;

      // Stat counter on profile
      const fr = document.getElementById('stat-friends');
      if (fr) fr.textContent = friendsState.friends.length;

      // Requests badge — combines pending friend requests + pending game invites
      const badge = document.getElementById('friends-requests-badge');
      if (badge) {
        const gameInviteCount = (typeof invitesState !== 'undefined' && invitesState.incoming) ? invitesState.incoming.length : 0;
        const total = friendsState.incoming.length + gameInviteCount;
        if (total > 0) {
          badge.textContent = total;
          badge.hidden = false;
        } else {
          badge.hidden = true;
          badge.textContent = '';
        }
      }

      // Sign-in prompt (no auth user)
      if (!friendsState.me) {
        container.innerHTML = `<div class="friend-empty">${t('friends.signInPrompt')}</div>`;
        renderFriendsSearchResults();
        return;
      }

      let html = '';
      const tab = friendsState.activeTab;
      let glowSearch = false; // true → pulse the search bar to draw a new user's eye
      // Skeleton on first fetch — without it the "all" tab briefly flashes
      // the "no friends yet" hero for users who DO have friends, and the
      // "requests" tab flashes "no requests". Show 4 placeholder rows while
      // the fetch is in flight (covers both tabs).
      const _friendsFirstFetch = friendsState.loading
        && friendsState.friends.length === 0
        && friendsState.incoming.length === 0
        && friendsState.outgoing.length === 0;
      if (_friendsFirstFetch) {
        container.innerHTML =
          '<div class="huddle-skeleton-list" aria-busy="true" aria-live="polite">' +
          Array(4).fill(
            '<div class="huddle-skeleton-row">' +
              '<div class="huddle-skeleton-circle"></div>' +
              '<div class="huddle-skeleton-stack">' +
                '<div class="huddle-skeleton-bar short"></div>' +
                '<div class="huddle-skeleton-bar tiny"></div>' +
              '</div>' +
            '</div>'
          ).join('') +
          '</div>';
        renderFriendsSearchResults();
        return;
      }
      if (tab === 'requests') {
        const gameInvites = (typeof invitesState !== 'undefined' && invitesState.incoming) ? invitesState.incoming : [];
        if (friendsState.incoming.length === 0 && friendsState.outgoing.length === 0 && gameInvites.length === 0) {
          html = `<div class="friend-empty">${t('friends.emptyRequests')}</div>`;
        } else {
          // Phase 4 — game invites surface here too, on top
          if (gameInvites.length > 0) {
            html += `<div class="section-title">${t('invite.sectionTitle')} · ${gameInvites.length}</div>`;
            html += gameInvites.map(friendsRenderRowGameInvite).join('');
          }
          if (friendsState.incoming.length > 0) {
            html += `<div class="section-title">${t('friends.sectionIncoming')} · ${friendsState.incoming.length}</div>`;
            html += friendsState.incoming.map(friendsRenderRowIncoming).join('');
          }
          if (friendsState.outgoing.length > 0) {
            html += `<div class="section-title">${t('friends.sectionSent')} · ${friendsState.outgoing.length}</div>`;
            html += friendsState.outgoing.map(friendsRenderRowOutgoing).join('');
          }
        }
      } else {
        // 'all' tab
        // Pending friend requests now surface at the TOP of "All" too — not just
        // on the Requests tab. Why: after you add someone you land back here and
        // see "Request sent · pending" right at the top (no more "what now?"
        // dead-end), and someone who RECEIVED a request can Accept it from either
        // place. The Requests tab keeps showing them as well (nothing removed).
        // Game invites stay Requests-only — this block is friend requests only.
        if (friendsState.incoming.length > 0) {
          html += `<div class="section-title">${t('friends.sectionIncoming')} · ${friendsState.incoming.length}</div>`;
          html += friendsState.incoming.map(friendsRenderRowIncoming).join('');
        }
        if (friendsState.outgoing.length > 0) {
          html += `<div class="section-title">${t('friends.sectionSent')} · ${friendsState.outgoing.length}</div>`;
          html += friendsState.outgoing.map(friendsRenderRowOutgoing).join('');
        }

        if (friendsState.friends.length === 0) {
          // Only show the rich empty-state hero (and glow the search bar) when
          // there's genuinely nothing — no friends AND no pending requests. If
          // pending rows are present above, they fill the screen and the hero
          // would wrongly read as "you have no one".
          if (friendsState.incoming.length === 0 && friendsState.outgoing.length === 0) {
            glowSearch = true;
            html += `
              <div class="friends-empty-hero">
                <div class="friends-empty-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="9" cy="8" r="4"></circle>
                    <path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"></path>
                    <path d="M19 8v6M22 11h-6"></path>
                  </svg>
                </div>
                <div class="friends-empty-title">${t('friends.heroTitle')}</div>
                <div class="friends-empty-sub">${t('friends.heroSub')}</div>
              </div>`;
          }
        } else {
          // Split accepted friends by presence — online first (Discord/Instagram
          // pattern). Sort alphabetically within each group for a stable order.
          const byName = (a, b) => friendsDisplayName(a.profile).localeCompare(friendsDisplayName(b.profile), undefined, { sensitivity: 'base' });
          const online = friendsState.friends.filter(e => friendsPresence.has(e.otherId)).sort(byName);
          const offline = friendsState.friends.filter(e => !friendsPresence.has(e.otherId)).sort(byName);
          if (online.length > 0) {
            html += `<div class="section-title">${t('friends.online')} · ${online.length}</div>`;
            html += online.map(friendsRenderRowAccepted).join('');
          }
          if (offline.length > 0) {
            html += `<div class="section-title">${t('friends.offline')} · ${offline.length}</div>`;
            html += offline.map(friendsRenderRowAccepted).join('');
          }
        }
      }

      container.innerHTML = html;
      parseEmoji(container);
      renderFriendsSearchResults();
      // Toggle the search-bar glow so new users see where to look.
      const searchWrap = document.querySelector('#screen-friends .search');
      if (searchWrap) searchWrap.classList.toggle('search-glow', glowSearch);
    }

    function renderFriendsSearchResults(){
      const el = document.getElementById('friends-search-results');
      if (!el) return;
      const q = (friendsState.searchQuery || '').trim();
      if (!q) {
        el.innerHTML = '';
        return;
      }
      if (friendsState.searchStatus === 'min') {
        el.innerHTML = `<div class="friends-search-msg">${t('friends.searchMinChars')}</div>`;
        return;
      }
      if (friendsState.searchStatus === 'searching') {
        // Keep last results visible silently; render nothing extra to avoid flicker.
        if (!friendsState.searchResults.length) { el.innerHTML = ''; return; }
      }
      if (!friendsState.searchResults.length && friendsState.searchStatus === 'ok') {
        el.innerHTML = `<div class="friends-search-msg">${t('friends.searchNoResults', { q: friendsEscape(q) })}</div>`;
        return;
      }
      const rows = friendsState.searchResults.map(p => {
        const rel = friendsRelationship(p.user_id);
        const name = friendsDisplayName(p);
        const handle = p.username ? '@' + p.username : '';
        const avatar = p.avatar || deterministicAvatar(p.user_id);
        let actions = '';
        if (rel === 'friends') {
          actions = `<span class="friend-status-pill"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>${t('friends.actionFriends')}</span>`;
        } else if (rel === 'sent') {
          // Single subtle status indicator (Instagram / LinkedIn pattern). Cancel
          // lives in the Requests tab where users expect it — avoids the
          // confusing "Sent | Cancel" double affordance.
          actions = `<span class="friend-status-pill" style="color:var(--text-secondary)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>${t('friends.requestSent')}</span>`;
        } else if (rel === 'incoming') {
          actions = `<button class="btn btn-primary btn-sm" onclick="friendRequestAccept('${friendsEscape(p.user_id)}')">${t('friends.actionAccept')}</button>`;
        } else {
          actions = `<button class="btn btn-outline btn-sm" onclick="friendRequestSend('${friendsEscape(p.user_id)}')">${t('friends.actionAdd')}</button>`;
        }
        return `
          <div class="friend-row">
            ${avatarHTML(avatar, 40, { fallback: (name[0] || '?').toUpperCase() })}
            <div class="friend-info">
              <div class="friend-name">${friendsEscape(name)}</div>
              <div class="friend-status">${friendsEscape(handle)}</div>
            </div>
            <div class="friend-row-actions">${actions}</div>
          </div>`;
      }).join('');
      el.innerHTML = rows;
      parseEmoji(el);
    }

    // Header "add friend" icon → focus the search input, select any existing
    // text, scroll it into view, and play a one-shot glow so the user's eye
    // lands on the right spot. Single, honest action — no extra screen.
    function friendsFocusSearch(){
      const input = document.getElementById('friends-search-input');
      if (!input) return;
      const wrap = input.closest('.search');
      try { wrap && wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(_){}
      // Defer focus a beat so the smooth-scroll can start before the keyboard
      // pops on mobile (prevents the layout from jumping mid-scroll).
      setTimeout(() => {
        input.focus({ preventScroll: true });
        try { input.select(); } catch(_){}
        if (wrap) {
          wrap.classList.remove('search-tap-pulse');
          // Force reflow so the animation restarts on repeat taps.
          void wrap.offsetWidth;
          wrap.classList.add('search-tap-pulse');
          wrap.addEventListener('animationend', () => {
            wrap.classList.remove('search-tap-pulse');
          }, { once: true });
        }
      }, 120);
    }

    function friendsHandleSearch(value){
      const q = (value || '').trim();
      friendsState.searchQuery = q;
      if (friendsSearchTimer) { clearTimeout(friendsSearchTimer); friendsSearchTimer = null; }
      if (!q) {
        friendsState.searchResults = [];
        friendsState.searchStatus = '';
        renderFriendsSearchResults();
        return;
      }
      if (q.length < 2) {
        friendsState.searchResults = [];
        friendsState.searchStatus = 'min';
        renderFriendsSearchResults();
        return;
      }
      friendsState.searchStatus = 'searching';
      friendsSearchTimer = setTimeout(() => { friendsRunSearch(q); }, 350);
    }

    // Search BOTH the @username AND the display name (nickname) — people
    // naturally type a friend's NAME, not their handle, so username-only search
    // left them stuck. Implemented as two parallel ilike "contains" queries (one
    // per column) merged client-side: this reuses the proven .ilike() escaping
    // instead of hand-building a fragile PostgREST .or() filter string, and needs
    // NO database changes. Results are then ranked (exact handle > handle-prefix
    // > name-prefix > match-anywhere) so the most relevant person is on top, and
    // trimmed to 8.
    async function friendsRunSearch(q){
      if (!window.sb || !friendsState.me) {
        friendsState.searchResults = [];
        friendsState.searchStatus = 'ok';
        renderFriendsSearchResults();
        return;
      }
      try {
        // Escape LIKE wildcards so a typed % or _ matches literally — usernames
        // legitimately contain underscores. Backslash is Postgres' default LIKE
        // escape char, so \_ and \% match a literal _ and %.
        const safe = q.replace(/[\\%_]/g, m => '\\' + m);
        const pat = '%' + safe + '%';
        const cols = 'user_id, username, display_name, avatar';
        // Fetch a few more than we display (per column) so client-side ranking
        // picks the best 8 rather than being cut off by an arbitrary server slice.
        const [byHandle, byName] = await Promise.all([
          window.sb.from('profiles').select(cols)
            .ilike('username', pat).neq('user_id', friendsState.me).limit(20),
          window.sb.from('profiles').select(cols)
            .ilike('display_name', pat).neq('user_id', friendsState.me).limit(20),
        ]);
        if (byHandle.error || byName.error) {
          console.warn('[Huddle] friends search failed:', (byHandle.error || byName.error).message);
          friendsState.searchResults = [];
          friendsState.searchStatus = 'ok';
          renderFriendsSearchResults();
          return;
        }
        // Merge + dedupe (someone matching on both columns must appear once).
        const byId = new Map();
        [...(byHandle.data || []), ...(byName.data || [])].forEach(p => {
          if (p && p.user_id && !byId.has(p.user_id)) byId.set(p.user_id, p);
        });
        // Rank: exact handle → handle-prefix → name-prefix → match-anywhere.
        const ql = q.trim().toLowerCase();
        const rankOf = (p) => {
          const u = (p.username || '').toLowerCase();
          const d = (p.display_name || '').toLowerCase();
          if (u === ql) return 0;
          if (u.startsWith(ql)) return 1;
          if (d.startsWith(ql)) return 2;
          if (u.includes(ql)) return 3;
          if (d.includes(ql)) return 4;
          return 5;
        };
        const ranked = Array.from(byId.values()).sort((a, b) => {
          const ra = rankOf(a), rb = rankOf(b);
          if (ra !== rb) return ra - rb;
          return friendsDisplayName(a).localeCompare(friendsDisplayName(b), undefined, { sensitivity: 'base' });
        }).slice(0, 8);
        friendsState.searchResults = ranked;
        friendsState.searchStatus = 'ok';
        renderFriendsSearchResults();
      } catch(e) {
        console.warn('[Huddle] friends search exception:', e);
        friendsState.searchResults = [];
        friendsState.searchStatus = 'ok';
        renderFriendsSearchResults();
      }
    }

    async function friendRequestSend(otherUserId){
      if (!window.sb || !friendsState.me || !otherUserId) return;
      try {
        const { error } = await window.sb
          .from('friendships')
          .insert({ requester_id: friendsState.me, addressee_id: otherUserId, status: 'pending' });
        if (error) {
          // 23505 unique violation = already exists
          if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
            console.warn('[Huddle] friend request already exists');
          } else {
            console.warn('[Huddle] friendRequestSend failed:', error.message);
            alert(error.message || 'Could not send request');
            return;
          }
        }
        await friendsLoad();
        // Clear search + land on the All tab. The request the user just sent now
        // sits at the TOP of All as a "Request sent · pending" row, so they see
        // exactly what happened without hunting through tabs. It also still
        // appears under Requests → Sent (kept intentionally, nothing removed).
        if (friendsSearchTimer) { clearTimeout(friendsSearchTimer); friendsSearchTimer = null; }
        const input = document.getElementById('friends-search-input');
        if (input) input.value = '';
        friendsState.searchQuery = '';
        friendsState.searchResults = [];
        friendsState.searchStatus = '';
        renderFriendsSearchResults();
        friendsSetTab('all');
      } catch(e) {
        console.warn('[Huddle] friendRequestSend exception:', e);
      }
    }

    async function friendRequestAccept(otherUserId){
      if (!window.sb || !friendsState.me || !otherUserId) return;
      try {
        const { error } = await window.sb
          .from('friendships')
          .update({ status: 'accepted' })
          .eq('addressee_id', friendsState.me)
          .eq('requester_id', otherUserId)
          .eq('status', 'pending');
        if (error) console.warn('[Huddle] friendRequestAccept failed:', error.message);
        await friendsLoad();
      } catch(e) {
        console.warn('[Huddle] friendRequestAccept exception:', e);
      }
    }

    async function friendRequestDecline(otherUserId){
      if (!window.sb || !friendsState.me || !otherUserId) return;
      try {
        const { error } = await window.sb
          .from('friendships')
          .delete()
          .eq('addressee_id', friendsState.me)
          .eq('requester_id', otherUserId)
          .eq('status', 'pending');
        if (error) console.warn('[Huddle] friendRequestDecline failed:', error.message);
        await friendsLoad();
      } catch(e) {
        console.warn('[Huddle] friendRequestDecline exception:', e);
      }
    }

    async function friendRequestCancel(otherUserId){
      if (!window.sb || !friendsState.me || !otherUserId) return;
      try {
        const { error } = await window.sb
          .from('friendships')
          .delete()
          .eq('requester_id', friendsState.me)
          .eq('addressee_id', otherUserId)
          .eq('status', 'pending');
        if (error) console.warn('[Huddle] friendRequestCancel failed:', error.message);
        await friendsLoad();
      } catch(e) {
        console.warn('[Huddle] friendRequestCancel exception:', e);
      }
    }

    async function friendRemove(otherUserId, name){
      if (!window.sb || !friendsState.me || !otherUserId) return;
      const friendName = name || t('friends.thisFriend') || 'this friend';
      const ok = await huddleConfirm({
        title: t('friends.removeTitle', { name: friendName }),
        body: t('friends.removeBody'),
        confirmLabel: t('friends.actionRemove'),
        cancelLabel: t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      try {
        // Either direction: row may have me as requester or addressee
        const me = friendsState.me;
        const { error } = await window.sb
          .from('friendships')
          .delete()
          .or(`and(requester_id.eq.${me},addressee_id.eq.${otherUserId}),and(requester_id.eq.${otherUserId},addressee_id.eq.${me})`)
          .eq('status', 'accepted');
        if (error) console.warn('[Huddle] friendRemove failed:', error.message);
        await friendsLoad();
      } catch(e) {
        console.warn('[Huddle] friendRemove exception:', e);
      }
    }

    // =====================================================================
    // PHASE 4 — Room invites (invite friends from inside a lobby)
    // =====================================================================
    // Friends already in your "friends" list can be tapped on the lobby screen
    // to receive an in-app banner that brings them into your room with one tap.
    // Backed by public.room_invites in Supabase.
    // =====================================================================
    const invitesState = {
      me: null,
      loading: false,
      incoming: [],   // pending invites where to_user_id = me; each: { row, sender }
      outgoing: [],   // pending invites where from_user_id = me; each: { row, receiver }
      bannerQueue: [],
      bannerActive: null,
      bannerDismissTimer: null,
      seenIncomingIds: new Set(),
    };
    let _invitesChannel = null;

    function inviteGameLabel(gameKey){
      if (gameKey === 'hotseat')   return t('game.hotseat');
      if (gameKey === 'chameleon') return t('game.chameleon');
      if (gameKey === 'liar')      return t('game.liar');
      if (gameKey === 'mafia')     return t('game.mafia');
      return gameKey || '';
    }

    function inviteCurrentLobbyContext(){
      // Returns { gameKey, code, claimedBy } describing the lobby we're currently in,
      // or null if not on a lobby screen.
      const active = document.querySelector('.screen.active');
      const id = active ? active.id : '';
      if (id === 'screen-lobby' && typeof state !== 'undefined' && state.code) {
        return { gameKey: 'hotseat', code: state.code, claimedBy: state.claimedBy || {} };
      }
      if (id === 'screen-cham-lobby' && typeof chamState !== 'undefined' && chamState.code) {
        return { gameKey: 'chameleon', code: chamState.code, claimedBy: chamState.claimedBy || {} };
      }
      if (id === 'screen-liar-lobby' && typeof cardLobbyState !== 'undefined' && cardLobbyState.code) {
        return { gameKey: 'liar', code: cardLobbyState.code, claimedBy: cardLobbyState.claimedBy || {} };
      }
      if (id === 'screen-mafia-lobby' && typeof mafiaState !== 'undefined' && mafiaState.code) {
        return { gameKey: 'mafia', code: mafiaState.code, claimedBy: mafiaState.claimedBy || {} };
      }
      return null;
    }

    async function invitesLoad(){
      if (!window.sb) return;
      try {
        invitesState.loading = true;
        const { data: { user } } = await window.sb.auth.getUser();
        if (!user || user.is_anonymous) {
          invitesState.me = null;
          invitesState.incoming = [];
          invitesState.outgoing = [];
          invitesState.loading = false;
          renderLobbyInvitesAll();
          renderFriends();
          return;
        }
        invitesState.me = user.id;
        const nowIso = new Date().toISOString();
        const { data: rows, error } = await window.sb
          .from('room_invites')
          .select('id, from_user_id, to_user_id, room_code, game, status, created_at, expires_at')
          .or(`from_user_id.eq.${user.id},to_user_id.eq.${user.id}`)
          .eq('status', 'pending')
          .gt('expires_at', nowIso)
          .order('created_at', { ascending: false });
        if (error) {
          console.warn('[Huddle] invitesLoad query failed:', error.message);
          invitesState.loading = false;
          return;
        }
        const otherIds = new Set();
        (rows || []).forEach(r => {
          const other = r.from_user_id === user.id ? r.to_user_id : r.from_user_id;
          if (other) otherIds.add(other);
        });
        const profilesById = {};
        if (otherIds.size > 0) {
          const { data: profs, error: pErr } = await window.sb
            .from('profiles')
            .select('user_id, username, display_name, avatar')
            .in('user_id', Array.from(otherIds));
          if (pErr) console.warn('[Huddle] invitesLoad profile lookup failed:', pErr.message);
          else (profs || []).forEach(p => { profilesById[p.user_id] = p; });
        }
        const incoming = [];
        const outgoing = [];
        (rows || []).forEach(r => {
          if (r.to_user_id === user.id) {
            const sender = profilesById[r.from_user_id] || { user_id: r.from_user_id };
            incoming.push({ row: r, sender });
          } else {
            const receiver = profilesById[r.to_user_id] || { user_id: r.to_user_id };
            outgoing.push({ row: r, receiver });
          }
        });
        invitesState.incoming = incoming;
        invitesState.outgoing = outgoing;
        invitesState.loading = false;

        renderLobbyInvitesAll();
        renderFriends();
        // Surface any incoming invites we haven't shown the banner for yet
        incoming.forEach(inv => {
          if (!invitesState.seenIncomingIds.has(inv.row.id)) {
            invitesState.seenIncomingIds.add(inv.row.id);
            inviteEnqueueBanner(inv);
          }
        });
      } catch(e) {
        console.warn('[Huddle] invitesLoad exception:', e);
        invitesState.loading = false;
      }
    }

    function invitesWireSync(){
      if (!window.sb || !invitesState.me) return;
      // Tear down any prior channel
      invitesUnwireSync();
      try {
        const me = invitesState.me;
        _invitesChannel = window.sb
          .channel('room_invites_' + me)
          .on('postgres_changes',
              { event: 'INSERT', schema: 'public', table: 'room_invites', filter: `to_user_id=eq.${me}` },
              () => { invitesLoad(); })
          .on('postgres_changes',
              { event: 'UPDATE', schema: 'public', table: 'room_invites', filter: `to_user_id=eq.${me}` },
              () => { invitesLoad(); })
          .on('postgres_changes',
              { event: 'UPDATE', schema: 'public', table: 'room_invites', filter: `from_user_id=eq.${me}` },
              () => { invitesLoad(); })
          .subscribe();
      } catch(e) {
        console.warn('[Huddle] invitesWireSync failed:', e);
      }
    }

    function invitesUnwireSync(){
      try {
        if (_invitesChannel && window.sb) {
          window.sb.removeChannel(_invitesChannel);
        }
      } catch(e){}
      _invitesChannel = null;
    }

    async function inviteSend(toUserId, roomCode, gameKey, ev){
      if (!window.sb || !invitesState.me) return;
      if (!toUserId || !roomCode || !gameKey) return;
      if (toUserId === invitesState.me) return;
      // Must be friends
      const isFriend = friendsState.friends.some(f => f.otherId === toUserId);
      if (!isFriend) return;
      // Dedupe: if we already have a pending outgoing invite for the same room/friend, no-op
      const existing = invitesState.outgoing.find(o =>
        o.row.to_user_id === toUserId && o.row.room_code === roomCode && o.row.game === gameKey
      );
      if (existing) {
        renderLobbyInvitesAll();
        return;
      }
      // Defence against tap-spam — the optimistic UI change makes a second
      // tap impossible anyway (the button becomes "Invited"), but we disable
      // immediately too in case the re-render is somehow delayed a frame.
      const btn = ev && ev.currentTarget;
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy','true'); }
      // Optimistic UI — without this the button stays "Invite" until BOTH the
      // INSERT and the follow-up invitesLoad() round-trip resolve (300-1000ms
      // on real wifi). Push a placeholder outgoing entry with _optimistic:true
      // so the next render shows "Invited" instantly. invitesLoad() later
      // replaces this with the canonical row from the server.
      const optimistic = {
        row: {
          id: '__optimistic_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
          from_user_id: invitesState.me,
          to_user_id: toUserId,
          room_code: roomCode,
          game: gameKey,
          status: 'pending',
          _optimistic: true,
        },
        receiver: { user_id: toUserId },
      };
      invitesState.outgoing.push(optimistic);
      try { renderLobbyInvitesAll(); } catch(e){}
      try { renderFriends(); } catch(e){}
      try {
        const { error } = await window.sb
          .from('room_invites')
          .insert({
            from_user_id: invitesState.me,
            to_user_id: toUserId,
            room_code: roomCode,
            game: gameKey,
            status: 'pending',
          });
        if (error) {
          // Roll back the optimistic entry so the button flips back to
          // "Invite" — the user can retry. Toast surfaces the failure.
          console.warn('[Huddle] inviteSend failed:', error.message);
          const idx = invitesState.outgoing.indexOf(optimistic);
          if (idx >= 0) invitesState.outgoing.splice(idx, 1);
          try { if (typeof showLobbyToast === 'function') showLobbyToast(t('common.syncFailed'), 3500); } catch(e){}
          try { renderLobbyInvitesAll(); } catch(e){}
          try { renderFriends(); } catch(e){}
          if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
          return;
        }
        // Canonical refresh — replaces the optimistic entry with the real
        // row (carrying the server-issued id needed for Cancel to work).
        // No await on the UI: the button is already showing "Invited", so
        // this happens silently in the background.
        invitesLoad();
      } catch(e) {
        console.warn('[Huddle] inviteSend exception:', e);
        const idx = invitesState.outgoing.indexOf(optimistic);
        if (idx >= 0) invitesState.outgoing.splice(idx, 1);
        try { if (typeof showLobbyToast === 'function') showLobbyToast(t('common.syncFailed'), 3500); } catch(e){}
        try { renderLobbyInvitesAll(); } catch(e){}
        try { renderFriends(); } catch(e){}
        if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
      }
    }

    async function inviteCancel(inviteId, ev){
      if (!window.sb || !invitesState.me || !inviteId) return;
      // Optimistic UI — same logic as inviteSend. Remove the outgoing entry
      // immediately so the button flips back to "Invite". Roll back on error.
      const btn = ev && ev.currentTarget;
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy','true'); }
      const idx = invitesState.outgoing.findIndex(o => o.row && o.row.id === inviteId);
      const removed = (idx >= 0) ? invitesState.outgoing.splice(idx, 1)[0] : null;
      const removedIdx = idx;
      try { renderLobbyInvitesAll(); } catch(e){}
      try { renderFriends(); } catch(e){}
      // Optimistic entries don't have a real server id yet (the INSERT is
      // still in flight). Skip the UPDATE — the canonical invitesLoad() that
      // chains off inviteSend will replace the optimistic row anyway, and a
      // tap-cancel on an optimistic entry is a race we can ignore.
      if (typeof inviteId === 'string' && inviteId.startsWith('__optimistic_')) {
        return;
      }
      try {
        const { error } = await window.sb
          .from('room_invites')
          .update({ status: 'cancelled' })
          .eq('id', inviteId)
          .eq('from_user_id', invitesState.me)
          .eq('status', 'pending');
        if (error) {
          console.warn('[Huddle] inviteCancel failed:', error.message);
          // Roll back: restore the entry at its original position.
          if (removed) invitesState.outgoing.splice(Math.max(0, removedIdx), 0, removed);
          try { if (typeof showLobbyToast === 'function') showLobbyToast(t('common.syncFailed'), 3500); } catch(e){}
          try { renderLobbyInvitesAll(); } catch(e){}
          try { renderFriends(); } catch(e){}
          if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
          return;
        }
        // Background canonical refresh.
        invitesLoad();
      } catch(e) {
        console.warn('[Huddle] inviteCancel exception:', e);
        if (removed) invitesState.outgoing.splice(Math.max(0, removedIdx), 0, removed);
        try { if (typeof showLobbyToast === 'function') showLobbyToast(t('common.syncFailed'), 3500); } catch(e){}
        try { renderLobbyInvitesAll(); } catch(e){}
        try { renderFriends(); } catch(e){}
        if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
      }
    }

    // Cancel ALL my pending invites for a given room. Called when I leave a
    // room so a friend tapping "Join" later doesn't land in a room I'm no
    // longer in (ghost-room avoidance).
    async function inviteCancelMineForRoom(roomCode, gameKey){
      if (!window.sb || !invitesState.me || !roomCode) return;
      try {
        const { error } = await window.sb
          .from('room_invites')
          .update({ status: 'cancelled' })
          .eq('from_user_id', invitesState.me)
          .eq('room_code', roomCode)
          .eq('game', gameKey)
          .eq('status', 'pending');
        if (error) console.warn('[Huddle] inviteCancelMineForRoom failed:', error.message);
        await invitesLoad();
      } catch(e) {
        console.warn('[Huddle] inviteCancelMineForRoom exception:', e);
      }
    }

    async function inviteAccept(invite){
      if (!window.sb || !invite || !invite.row) return;
      try {
        const { error } = await window.sb
          .from('room_invites')
          .update({ status: 'accepted' })
          .eq('id', invite.row.id)
          .eq('to_user_id', invitesState.me)
          .eq('status', 'pending');
        if (error) console.warn('[Huddle] inviteAccept failed:', error.message);
      } catch(e) {
        console.warn('[Huddle] inviteAccept exception:', e);
      }
      // Route the user into the room. Update URL search so the lobby openers find the code.
      try {
        const params = new URLSearchParams(window.location.search);
        params.set('room', invite.row.room_code);
        params.set('game', invite.row.game);
        const newSearch = '?' + params.toString();
        history.replaceState(history.state || {}, '', newSearch);
      } catch(e){}
      inviteOpenLobby(invite.row.game);
      // Drop the banner we just acted on
      inviteBannerHide();
      await invitesLoad();
    }

    async function inviteDecline(invite){
      if (!window.sb || !invite || !invite.row) return;
      try {
        const { error } = await window.sb
          .from('room_invites')
          .update({ status: 'declined' })
          .eq('id', invite.row.id)
          .eq('to_user_id', invitesState.me)
          .eq('status', 'pending');
        if (error) console.warn('[Huddle] inviteDecline failed:', error.message);
      } catch(e) {
        console.warn('[Huddle] inviteDecline exception:', e);
      }
      inviteBannerHide();
      await invitesLoad();
    }

    function inviteOpenLobby(gameKey){
      if (gameKey === 'hotseat')        openLobby();
      else if (gameKey === 'chameleon') openChamLobby();
      else if (gameKey === 'liar')      openLiarLobby();
      else if (gameKey === 'mafia')     openMafiaLobby();
    }

    // ---------- Lobby "Invite friends" section rendering ----------
    function renderLobbyInvitesAll(){
      renderLobbyInvites('hotseat');
      renderLobbyInvites('chameleon');
      renderLobbyInvites('liar');
      renderLobbyInvites('mafia');
    }

    // All three game lobbies now use the shared bottom-sheet invite picker
    // (opened from empty-seat tiles). The old bottom invite sections were
    // removed — this function just refreshes the open sheet if it matches.
    function renderLobbyInvites(gameKey){
      if (typeof refreshLobbyInviteSheetIfOpen === 'function') refreshLobbyInviteSheetIfOpen(gameKey);
    }

    function inviteLobbyContextForGame(gameKey){
      if (gameKey === 'hotseat' && typeof state !== 'undefined') {
        return { code: state.code, claimedBy: state.claimedBy || {} };
      }
      if (gameKey === 'chameleon' && typeof chamState !== 'undefined') {
        return { code: chamState.code, claimedBy: chamState.claimedBy || {} };
      }
      if (gameKey === 'liar' && typeof cardLobbyState !== 'undefined') {
        return { code: cardLobbyState.code, claimedBy: cardLobbyState.claimedBy || {} };
      }
      if (gameKey === 'mafia' && typeof mafiaState !== 'undefined') {
        return { code: mafiaState.code, claimedBy: mafiaState.claimedBy || {} };
      }
      return null;
    }

    // ---------- Incoming invite banner ----------
    function inviteEnqueueBanner(invite){
      // Suppress banner on the login screen
      const active = document.querySelector('.screen.active');
      if (active && active.id === 'screen-login') return;
      // If we're already in this exact room, no banner
      const ctx = inviteCurrentLobbyContext();
      if (ctx && ctx.code === invite.row.room_code && ctx.gameKey === invite.row.game) return;

      if (invitesState.bannerActive) {
        invitesState.bannerQueue.push(invite);
        return;
      }
      inviteBannerShow(invite);
    }

    function inviteBannerShow(invite){
      const banner = document.getElementById('invite-banner');
      const textEl = document.getElementById('invite-banner-text');
      const avatarEl = document.getElementById('invite-banner-avatar');
      const joinBtn = document.getElementById('invite-banner-join');
      const declineBtn = document.getElementById('invite-banner-decline');
      if (!banner || !textEl || !joinBtn || !declineBtn) return;

      invitesState.bannerActive = invite;
      const senderName = friendsDisplayName(invite.sender) || 'A friend';
      const gameName = inviteGameLabel(invite.row.game);
      // Build banner text with bolded {name} and {game}
      const tmpl = t('invite.banner', { name: '__N__', game: '__G__' });
      const html = friendsEscape(tmpl)
        .replace('__N__', '<strong>' + friendsEscape(senderName) + '</strong>')
        .replace('__G__', '<strong>' + friendsEscape(gameName) + '</strong>');
      textEl.innerHTML = html;

      // Avatar — swap inner HTML rather than replacing the node so the id is preserved
      const avatar = invite.sender.avatar || deterministicAvatar(invite.sender.user_id);
      if (avatarEl) {
        avatarEl.outerHTML = `<div id="invite-banner-avatar" style="flex-shrink:0">${avatarHTML(avatar, 40, { fallback: (senderName[0] || '?').toUpperCase() })}</div>`;
      }

      joinBtn.textContent = t('invite.join');
      declineBtn.textContent = t('invite.decline');

      banner.classList.add('show');
      parseEmoji(banner);

      // Auto-dismiss after 30s — equivalent to a silent decline (don't update DB, just hide)
      clearTimeout(invitesState.bannerDismissTimer);
      invitesState.bannerDismissTimer = setTimeout(() => {
        inviteBannerHide();
      }, 30000);
    }

    function inviteBannerHide(){
      const banner = document.getElementById('invite-banner');
      if (banner) banner.classList.remove('show');
      clearTimeout(invitesState.bannerDismissTimer);
      invitesState.bannerDismissTimer = null;
      invitesState.bannerActive = null;
      // Show next queued banner if any
      if (invitesState.bannerQueue.length > 0) {
        const next = invitesState.bannerQueue.shift();
        setTimeout(() => inviteBannerShow(next), 350);
      }
    }

    function inviteBannerJoin(){
      const inv = invitesState.bannerActive;
      if (!inv) { inviteBannerHide(); return; }
      inviteAccept(inv);
    }

    function inviteBannerDecline(){
      const inv = invitesState.bannerActive;
      if (!inv) { inviteBannerHide(); return; }
      inviteDecline(inv);
    }

    // avatarHTML supports an `id` opt — fall through ok for older callers; we patch the call
    // above by reading the produced HTML. As a fallback for environments where avatarHTML
    // ignores id, restore the avatar id after innerHTML swap:
    // (no-op here — id propagation is handled by passing through opts)

    // =====================================================================
    // END Phase 4 invites
    // =====================================================================

