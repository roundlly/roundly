// Huddle app-01-core-hotseat.js (fragment 1/10, split from app.js).
// All fragments share ONE global scope and MUST load in numeric order — do not reorder.

    // ---------- Demo data ----------
    // 20 default seat identities (shared by Hot Seat, Chameleon, Liar's Cup).
    // Real players override the name via their profile/guest name; these are the
    // fallback labels. Count = the max players per room. All ids/initials unique.
    const PLAYERS = [
      { id:'jordan', name:'Jordan', initial:'J', wins:0, bestTimeMs:null },
      { id:'alex',   name:'Alex',   initial:'A', wins:0, bestTimeMs:null },
      { id:'maria',  name:'Maria',  initial:'M', wins:0, bestTimeMs:null },
      { id:'kenji',  name:'Kenji',  initial:'K', wins:0, bestTimeMs:null },
      { id:'sam',    name:'Sam',    initial:'S', wins:0, bestTimeMs:null },
      { id:'lily',   name:'Lily',   initial:'L', wins:0, bestTimeMs:null },
      { id:'theo',   name:'Theo',   initial:'T', wins:0, bestTimeMs:null },
      { id:'nina',   name:'Nina',   initial:'N', wins:0, bestTimeMs:null },
      { id:'olivia', name:'Olivia', initial:'O', wins:0, bestTimeMs:null },
      { id:'ravi',   name:'Ravi',   initial:'R', wins:0, bestTimeMs:null },
      { id:'priya',  name:'Priya',  initial:'P', wins:0, bestTimeMs:null },
      { id:'diego',  name:'Diego',  initial:'D', wins:0, bestTimeMs:null },
      { id:'emma',   name:'Emma',   initial:'E', wins:0, bestTimeMs:null },
      { id:'felix',  name:'Felix',  initial:'F', wins:0, bestTimeMs:null },
      { id:'grace',  name:'Grace',  initial:'G', wins:0, bestTimeMs:null },
      { id:'hana',   name:'Hana',   initial:'H', wins:0, bestTimeMs:null },
      { id:'ivan',   name:'Ivan',   initial:'I', wins:0, bestTimeMs:null },
      { id:'bella',  name:'Bella',  initial:'B', wins:0, bestTimeMs:null },
      { id:'chloe',  name:'Chloe',  initial:'C', wins:0, bestTimeMs:null },
      { id:'quinn',  name:'Quinn',  initial:'Q', wins:0, bestTimeMs:null },
    ];

    // Word pools for Hot Seat. Each list is curated to be globally recognizable,
    // safe for any group, and easy to describe without saying the word itself.
    // pickWord() filters by state.usedWords so a single game never repeats a
    // word (until the category is exhausted, then the used set wipes).
    const WORDS = {
      animals: [
        'elephant','kangaroo','penguin','dolphin','octopus','giraffe','panda','flamingo','crocodile','squirrel',
        'lion','tiger','bear','zebra','monkey','gorilla','koala','sloth','owl','eagle',
        'parrot','peacock','butterfly','dragonfly','spider','snake','lizard','frog','turtle','shark',
        'whale','jellyfish','starfish','lobster','crab','seahorse','hedgehog','raccoon','fox','wolf',
        'rabbit','hamster','bat','bee','cheetah','leopard','hippo','rhino','camel','llama',
        'horse','cow','pig','goat','sheep','chicken','duck','goose','swan','ostrich',
        'dog','cat','deer','moose','otter','walrus','platypus','chameleon','scorpion','ant'
      ],
      food: [
        'pizza','spaghetti','coffee','pancake','sushi','burger','watermelon','chocolate','popcorn','noodles',
        'taco','burrito','sandwich','hot dog','fries','salad','soup','ice cream','cake','cookie',
        'donut','cupcake','brownie','pie','pretzel','bagel','croissant','waffle','omelette','bacon',
        'eggs','cereal','oatmeal','yogurt','cheese','butter','bread','toast','rice','pasta',
        'lasagna','ramen','dumplings','curry','pad thai','kebab','falafel','hummus','salmon','steak',
        'chicken wings','meatballs','ribs','shrimp','lemonade','milkshake','smoothie','tea','juice','soda',
        'banana','apple','strawberry','mango','pineapple','grapes','avocado','orange','peach','blueberry'
      ],
      movies: [
        'titanic','avatar','frozen','jaws','rocky','inception','gladiator','toy story','jurassic park','the matrix',
        'star wars','harry potter','lord of the rings','indiana jones','batman','superman','spider-man','iron man','the godfather','pulp fiction',
        'forrest gump','the lion king','shrek','finding nemo','monsters inc','up','wall-e','ratatouille','the incredibles','cars',
        'aladdin','mulan','beauty and the beast','cinderella','snow white','the little mermaid','tangled','moana','encanto','coco',
        'soul','inside out','brave','zootopia','the avengers','black panther','wonder woman','the dark knight','interstellar','the shining',
        'ghostbusters','back to the future','the wizard of oz','e.t.','home alone','la la land','pirates of the caribbean','mission impossible','james bond','the hunger games',
        'breaking bad','game of thrones','friends','the office','stranger things','squid game','sherlock','peaky blinders','money heist','the simpsons'
      ],
      famous: [
        'einstein','beyoncé','messi','mozart','shakespeare','oprah','elon musk','taylor swift','obama','da vinci',
        'michael jackson','elvis presley','madonna','lady gaga','drake','rihanna','ed sheeran','justin bieber','eminem','kanye west',
        'bruno mars','ariana grande','beethoven','picasso','van gogh','monet','frida kahlo','marie curie','isaac newton','charles darwin',
        'stephen hawking','nikola tesla','thomas edison','steve jobs','bill gates','jeff bezos','walt disney','abraham lincoln','martin luther king','nelson mandela',
        'gandhi','queen elizabeth','princess diana','cristiano ronaldo','lebron james','michael jordan','serena williams','roger federer','usain bolt','muhammad ali',
        'tom cruise','brad pitt','angelina jolie','leonardo dicaprio','will smith','jennifer aniston','dwayne johnson','robert downey jr','tom hanks','morgan freeman',
        'meryl streep','denzel washington','keanu reeves','scarlett johansson','emma watson','adele','shakira','jennifer lopez','snoop dogg','jay-z'
      ],
      sports: [
        'football','basketball','baseball','tennis','soccer','golf','hockey','volleyball','swimming','running',
        'cycling','boxing','wrestling','karate','judo','taekwondo','surfing','skateboarding','skiing','snowboarding',
        'ice skating','gymnastics','ballet','yoga','pilates','weightlifting','rowing','sailing','kayaking','fishing',
        'archery','fencing','badminton','table tennis','cricket','rugby','lacrosse','polo','sumo','marathon',
        'triathlon','javelin','discus','shot put','high jump','long jump','hurdles','pole vault','bowling','billiards',
        'darts','chess','horse racing','formula 1','rock climbing'
      ],
      objects: [
        'chair','table','lamp','refrigerator','microwave','oven','dishwasher','washing machine','toaster','blender',
        'kettle','computer','laptop','keyboard','mouse','monitor','printer','phone','tablet','headphones',
        'speaker','television','remote','camera','watch','clock','mirror','vase','candle','blanket',
        'pillow','mattress','sofa','bookshelf','desk','closet','hanger','broom','vacuum','bucket',
        'sponge','soap','shampoo','toothbrush','towel','hairdryer','comb','scissors','razor','umbrella',
        'sunglasses','backpack','suitcase','wallet','purse','key','glasses','pencil','pen','eraser',
        'notebook','calculator','stapler','flashlight','battery','charger','hammer','screwdriver','rope','ladder'
      ],
      places: [
        'paris','london','new york','tokyo','rome','sydney','dubai','moscow','beijing','mumbai',
        'cairo','rio de janeiro','los angeles','las vegas','hollywood','hawaii','alaska','miami','chicago','san francisco',
        'eiffel tower','statue of liberty','big ben','taj mahal','great wall of china','pyramids','colosseum','leaning tower of pisa','mount everest','niagara falls',
        'grand canyon','amazon rainforest','sahara desert','swiss alps','mount fuji','antarctica','the moon','mars','beach','mountain',
        'jungle','desert','volcano','ocean','river','lake','forest','island','cave','castle',
        'palace','temple','church','mosque','museum','zoo','airport','library','stadium','aquarium'
      ],
      activities: [
        'running','swimming','dancing','singing','cooking','baking','gardening','painting','drawing','knitting',
        'sewing','reading','writing','hiking','camping','fishing','surfing','juggling','snoring','sneezing',
        'yawning','stretching','jumping','climbing','skating','biking','driving','flying','diving','meditating',
        'praying','shopping','traveling','studying','exercising','snorkeling','parachuting','bungee jumping','rock climbing','water skiing',
        'horseback riding','sledding','bird watching','stargazing','sleeping','laughing','crying','whistling','clapping','sneaking'
      ],
      music: [
        'guitar','piano','drums','violin','flute','trumpet','saxophone','harmonica','accordion','banjo',
        'harp','cello','clarinet','trombone','bass','keyboard','microphone','headphones','rock','pop',
        'jazz','classical','hip hop','country','blues','reggae','electronic','metal','punk','rap',
        'opera','choir','orchestra','band','concert','festival','album','lyrics','melody','rhythm',
        'karaoke','dj','beatbox','musical','symphony'
      ],
      // 'mixed' is a hand-picked, globally-recognizable grab-bag drawn from every
      // other category. Kept separate from the union so it's curated, not noisy.
      mixed: [
        'elephant','pizza','rainbow','sunglasses','bicycle','guitar','umbrella','spaghetti','lightning','panda',
        'skateboard','kangaroo','coffee','mountain','volcano','astronaut','dinosaur','keyboard','telescope','helicopter',
        'lion','tiger','penguin','dolphin','octopus','butterfly','snake','shark','whale','turtle',
        'fox','rabbit','owl','eagle','parrot','sushi','tacos','ice cream','cake','donut',
        'popcorn','cookie','cheese','bread','watermelon','banana','apple','pineapple','mango','strawberry',
        'titanic','frozen','batman','superman','spider-man','star wars','harry potter','the lion king','shrek','toy story',
        'finding nemo','jaws','inception','the matrix','beethoven','mozart','picasso','einstein','messi','ronaldo',
        'michael jordan','lebron james','tom cruise','brad pitt','leonardo dicaprio','taylor swift','beyoncé','oprah','obama','elon musk',
        'steve jobs','walt disney','soccer','basketball','tennis','swimming','surfing','skiing','yoga','boxing',
        'gymnastics','marathon','chair','table','lamp','computer','phone','camera','mirror','candle',
        'pillow','sofa','vacuum','scissors','backpack','suitcase','paris','london','new york','tokyo',
        'hawaii','eiffel tower','statue of liberty','taj mahal','pyramids','mount everest','niagara falls','beach','jungle','desert',
        'ocean','castle','museum','dancing','singing','cooking','baking','painting','drawing','reading',
        'writing','hiking','camping','fishing','skating','juggling','sneezing','yawning','climbing','traveling',
        'piano','drums','violin','saxophone','microphone','jazz','rock','hip hop','orchestra','concert'
      ],
    };

    // ---------- State ----------
    const state = {
      mode: null,
      meId: 'jordan',             // who I am on this device (real multiplayer = logged-in user)
      category: 'mixed',
      rounds: 1,
      order: 'rotating',          // 'rotating' | 'random' | 'host'
      currentRound: 1,
      currentPlayerIdx: 0,
      playersUsedThisRound: [],   // array (was Set) so it survives JSON round-trip via Supabase
      players: JSON.parse(JSON.stringify(PLAYERS)),
      view: 'hotseat',
      currentWord: '',
      roundOutcome: null,         // 'won' | 'forfeit'
      turnStartTime: 0,           // ms timestamp when current turn began
      lastTurnDuration: 0,        // ms elapsed on last completed turn
      // Multiplayer additions (mirror liarState)
      code: null,
      phase: 'lobby',             // 'lobby' | 'splash' | 'play' | 'result'
      hostId: null,
      claimedBy: {},              // playerId → sessionId
      revision: 0,
    };

    // Local per-device identity for Hot Seat (mirrors liarMe)
    const hotMe = { sessionId: null, myId: null, bootstrapped: false };
    // Dedup key for the render-side bumpWins() in showResult — prevents the
    // re-renders that fire for the same turn (ensureClaimantProfiles callback,
    // realtime sync echo, language/theme switch) from each bumping the local
    // lifetime "wins" stat. Format: room-code:round:currentPlayerIdx.
    let _hotWinsBumpedKey = null;

    // ---------- Shared HTML escaping (Phase 3: one canonical escaper for all user text) ----------
    // Route ALL user-supplied text (display names, usernames, chat/feedback, typed room
    // codes, search queries) through this before placing it in innerHTML. Same 5-char map as
    // the existing escapeHTML (app-05) / friendsEscape (app-04), which are kept for now and
    // will be consolidated onto this in a later step. IMPORTANT: t() does NOT escape its
    // {param} substitutions, so pre-escape user values BEFORE passing them to t():
    //   t('key', { name: huddleEscape(userName) })   — not   t('key', { name: userName }).
    function huddleEscape(s){
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // ---------- Shared per-device identity (Phase 2: GetSessionId/Bootstrap merge) ----------
    // ONE implementation for all 4 games (Hot Seat, Chameleon, Liar, Mafia). Each game
    // passes its own `me` object ({ sessionId, bootstrapped, ... }); we pass the object
    // rather than share it because each game keeps extra per-game fields on it
    // (liarMe.selectedCardIds, mafiaMe.myRole/myTeammates, …).
    //
    // Behavior is the historic hot/cham/liar behavior, preserved intentionally:
    //   - bootstrap: reuse an existing auth user, else sign in anonymously.
    //   - on no-Supabase OR sign-in failure (offline / CDN-blocked / 429 anon
    //     rate-limit) → fall back to a random per-tab id so the game still works
    //     locally. This fallback is a deliberate safety net, NOT dead code.
    //   - getSessionId: lazily mint a tab_ id if bootstrap hasn't completed yet.
    function huddleNewTabId(){ return 'tab_' + Math.random().toString(36).slice(2, 10); }

    async function huddleBootstrap(me, logLabel){
      if (me.bootstrapped) return;
      me.bootstrapped = true;
      if (!(window.sb && window.sb.auth)) {
        me.sessionId = huddleNewTabId();
        if (logLabel) console.warn('[Huddle] Supabase unavailable — ' + logLabel + ' will not sync across devices.');
        return;
      }
      try {
        const { data: { user } } = await window.sb.auth.getUser();
        if (user && user.id) { me.sessionId = user.id; return; }
        const { data, error } = await window.sb.auth.signInAnonymously();
        if (error) throw error;
        me.sessionId = data.user.id;
      } catch(e) {
        if (logLabel) console.warn('[Huddle] Anonymous sign-in failed — using random session id.', e);
        me.sessionId = huddleNewTabId();
      }
    }

    function huddleGetSessionId(me){
      if (!me.sessionId) me.sessionId = huddleNewTabId();
      return me.sessionId;
    }

    // ---------- Shared "Leave room" (Phase 2: LeaveRoom merge, 3 of 4) ----------
    // Hot/Cham/Liar share this skeleton: confirm → optimistic seat removal →
    // host transfer → server-validated leave RPC → cancel my pending invites →
    // clear local state + lastRoom → tear down the channel → navigate home.
    // Mafia is NOT included (narrator model: no confirm / no host transfer /
    // fire-and-forget — see mafiaLeaveRoom). Per-game differences are passed in:
    //   context   : 'midround' swaps the confirm copy (Cham/Liar); omit for Hot.
    //   preLeave  : optional pre-leave cleanup (Liar stops timers/SFX).
    //   teardown  : per-game channel teardown (Cham intentionally skips untrack;
    //               Hot also nulls state.meId) — keeps each game's exact behavior.
    async function huddleLeaveRoom(opts){
      const me = opts.meObj, gs = opts.gameState;
      if (!me.myId) return;
      const midRound = opts.context === 'midround';
      const ok = await huddleConfirm({
        title: t(midRound ? 'common.leaveMidRoundTitle' : 'lobby.leaveTitle'),
        body:  t(midRound ? 'common.leaveMidRoundBody'  : 'lobby.leaveBody'),
        confirmLabel: t('lobby.leaveConfirm'),
        danger: true,
      });
      if (!ok) return;
      if (typeof opts.preLeave === 'function') opts.preLeave();
      const mySid = opts.sidFn();
      const myPlayerId = me.myId;
      const leavingCode = gs.code;
      // Optimistic local update; server-validated via the universal RPC below.
      if (gs.claimedBy && gs.claimedBy[myPlayerId] === mySid) {
        delete gs.claimedBy[myPlayerId];
      }
      if (gs.hostId === mySid) {
        const remaining = Object.entries(gs.claimedBy || {}).sort((a, b) => a[0].localeCompare(b[0]));
        gs.hostId = remaining.length ? remaining[0][1] : null;
      }
      // Server-validated leave (universal RPC handles host transfer too).
      if (leavingCode) {
        huddleCallRPC('huddle_leave_seat', { p_table: opts.table, p_code: leavingCode });
      }
      // Cancel any pending invites I sent for this room — a friend tapping Join
      // after I've left would otherwise land in a room without me.
      if (typeof inviteCancelMineForRoom === 'function' && leavingCode) {
        try { inviteCancelMineForRoom(leavingCode, opts.gameToken); } catch(e){}
      }
      me.myId = null;
      gs.code = null;
      try { huddleClearLastRoom(opts.lastRoomKey); } catch(e){}
      if (typeof opts.teardown === 'function') opts.teardown();
      try { history.replaceState(history.state, '', '/'); } catch(e){}
      goTo('games');
    }

    async function hotBootstrap(){ return huddleBootstrap(hotMe); }
    function hotGetSessionId(){ return huddleGetSessionId(hotMe); }
    function hotIsHost(){ return hotGetSessionId() === state.hostId; }
    function hotUsedHas(idx){ return (state.playersUsedThisRound || []).indexOf(idx) !== -1; }
    function hotUsedAdd(idx){
      if (!state.playersUsedThisRound) state.playersUsedThisRound = [];
      if (state.playersUsedThisRound.indexOf(idx) === -1) state.playersUsedThisRound.push(idx);
    }

    // ---------- C2: server-side RPC helper (per-action security) ----------
    // huddleCallRPC wraps window.sb.rpc(...) with consistent error handling.
    // On any failure (network or RLS/permission), it toasts the sync-failed
    // message and resolves with { error } so callers can branch without
    // try/catch noise. The next realtime echo from the server will overwrite
    // any optimistic local mutation that didn't make it through.
    // Returns true when the URL points at a room code that hasn't been
    // loaded into this game's state yet. Used by each lobby render fn to
    // swap in a skeleton grid instead of flashing the default "empty seats"
    // tiles between the initial paint and the first xxxLoadRoom() resolve
    // (typically 200-800ms on cold refresh).
    function huddleLobbyHydrating(loadedCode){
      try {
        const urlCode = new URLSearchParams(window.location.search).get('room');
        return !!urlCode && urlCode !== loadedCode;
      } catch(e) { return false; }
    }
    function huddleLobbySkeletonHTML(count){
      const n = count || 6;
      const tile =
        '<div class="player-tile" aria-busy="true" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:14px 10px;background:var(--bg-subtle);border:1px solid var(--border);border-radius:14px;min-height:120px">' +
          '<div class="huddle-skeleton-circle" style="width:48px;height:48px"></div>' +
          '<div class="huddle-skeleton-bar short" style="width:60%"></div>' +
          '<div class="huddle-skeleton-bar tiny" style="width:40%"></div>' +
        '</div>';
      return Array(n).fill(tile).join('');
    }

    // Distinguish transient errors (worth one retry — server hiccup, wifi
    // blip, exception thrown before reaching the server) from terminal errors
    // (4xx, RLS denial, gone room — retrying just produces the same answer).
    // Per the refresh-best-practices research: auto-retry once on transient,
    // route-with-toast on terminal. Never retry forever.
    function _huddleIsTransientRpcError(err){
      if (!err) return false;
      // Thrown exceptions (fetch/network failures, CORS hiccups) are always
      // transient — they didn't even reach the server, so retrying makes sense.
      if (err._thrown) return true;
      // PostgREST error codes that ARE transient: 5-digit pg codes starting
      // with 08 (connection), 53 (insufficient resources), 57 (operator
      // intervention), 58 (system error). Everything else (P0001 raised by
      // SQL fn, 23505 unique violation, 42501 RLS, PGRST116 not found) is
      // terminal — retrying just gets the same answer.
      if (err.code && typeof err.code === 'string') {
        return /^(08|53|57|58)/.test(err.code);
      }
      // No code, no _thrown flag — probably a partial error object. Be
      // conservative: don't retry. (Better to surface to the user than to
      // double-retry a request that we can't reason about.)
      return false;
    }
    async function huddleCallRPC(name, args){
      if (!window.sb) return { error: { code: 'no_supabase', message: 'Supabase unavailable' } };
      const _attempt = async () => {
        try {
          const { data, error } = await window.sb.rpc(name, args);
          if (error) return { error: error };
          return { data: data };
        } catch (err) {
          // No code → exception → caller treats as transient.
          return { error: { code: 'exception', message: String(err && err.message || err), _thrown: true } };
        }
      };
      let res = await _attempt();
      // Auto-retry exactly once for transient errors with 1s backoff. The
      // delay gives a wifi blip room to recover; longer waits feel laggy and
      // shorter waits often hit the same broken connection.
      if (res.error && _huddleIsTransientRpcError(res.error)) {
        await new Promise(r => setTimeout(r, 1000));
        const retry = await _attempt();
        if (!retry.error) return retry;
        res = retry; // fall through to the failure path with the retry's error
      }
      if (res.error) {
        console.warn('[Huddle] RPC ' + name + (res.error._thrown ? ' threw:' : ' failed:'),
                     res.error.message || res.error);
        try { if (typeof showLobbyToast === 'function') showLobbyToast(t('common.syncFailed'), 3500); } catch(e){}
      }
      return res;
    }

    // ---------- Hot Seat sync transport (mirrors liarPersist/liarLoadRoom/liarWireSync) ----------
    function hotPersist(){
      if (!state.code) return;
      state.revision = (state.revision || 0) + 1;
      if (!window.sb) return;
      const snapshot = JSON.parse(JSON.stringify(state));
      window.sb
        .from('hotseat_rooms')
        .upsert({ code: snapshot.code, state: snapshot })
        .then(({ error }) => {
          if (error) {
            console.warn('[Huddle] hot persist failed:', error.message || error);
            try { if (typeof showLobbyToast === 'function') showLobbyToast(t('common.syncFailed'), 3500); } catch(e){}
          }
        }, (err) => {
          console.warn('[Huddle] hot persist network error:', err && err.message || err);
          try { if (typeof showLobbyToast === 'function') showLobbyToast(t('common.syncFailed'), 3500); } catch(e){}
        });
    }
    async function hotLoadRoom(code){
      const incoming = await huddleFetchRoomState('hotseat_rooms', code);
      if (!incoming) return false;
      if (incoming.closedByHost) return false;
      if (!Array.isArray(incoming.playersUsedThisRound)) incoming.playersUsedThisRound = [];
      Object.keys(state).forEach(k => { delete state[k]; });
      Object.assign(state, incoming);
      return true;
    }
    // ───── Presence tracking (Phase 2b) ─────────────────────────────────
    // Mirrors Chameleon's pattern. When a tab dies (OS kill, wifi drop, app
    // switch-away), the WebSocket eventually drops and Supabase emits a
    // `presence.leave` event for that session. A 60-second grace timer
    // covers legitimate refreshes (Supabase anon UID is stable across
    // reload), then the lowest-connected peer fires the server cleanup
    // (huddle_hot_handle_disconnect) which removes the seat and transfers
    // host if needed. All other connected clients pick up the change via
    // the postgres_changes broadcast.
    let _hotPresentSessions = new Set();
    let _hotLeaveGraceTimers = new Map();
    const HOT_LEAVE_GRACE_MS = 60000;

    function hotIsPlayerPresent(playerId){
      if (!playerId) return false;
      const sid = state.claimedBy && state.claimedBy[playerId];
      return sid ? _hotPresentSessions.has(sid) : false;
    }
    function hotLowestSeatConnectedPlayer(){
      const claimedBy = state.claimedBy || {};
      const seats = Object.keys(claimedBy).sort();
      for (const pid of seats) {
        const sid = claimedBy[pid];
        if (sid && _hotPresentSessions.has(sid)) return pid;
      }
      return null;
    }
    // ---------- Shared "confirmed user gone" disconnect handler (Phase 2, 3 of 4) ----------
    // When a player's leave-grace expires: drop them from presence, find the seat
    // they held, and — if WE are the deterministically-elected writer (lowest
    // connected peer) — fire the server's disconnect-cleanup RPC. Hot/Cham/Liar
    // share this exactly; only the presence set, grace map, state, rerender,
    // election fn, me object, and RPC name differ. Mafia is NOT included (narrator-
    // based election + it passes a seat id, not a session id — see
    // mafiaConfirmUserGone). The "{name} left" toast is emitted by the realtime
    // sync handler (seat-vanish detection, covers Leave + disconnect), so it is
    // intentionally NOT shown here (would double-toast). Fire-and-forget: the
    // server's postgres_changes echo reconciles every client's view (~300ms).
    function huddleConfirmUserGone(sessionId, opts){
      opts.presentSessions.delete(sessionId);
      opts.graceTimers.delete(sessionId);
      const gs = opts.gameState;
      const rerender = () => { if (typeof opts.rerender === 'function') opts.rerender(); };
      let goneSeatId = null;
      Object.keys(gs.claimedBy || {}).forEach(pid => {
        if (gs.claimedBy[pid] === sessionId) goneSeatId = pid;
      });
      if (!goneSeatId) { rerender(); return; }
      if (opts.lowestConnected() !== opts.meObj.myId) { rerender(); return; }
      Promise.resolve(huddleCallRPC(opts.rpcName, {
        p_code: gs.code,
        p_gone_session_id: sessionId,
      })).catch(e => console.warn('[Huddle] handle_disconnect failed:', e && e.message));
    }
    function hotConfirmUserGone(sessionId){
      return huddleConfirmUserGone(sessionId, {
        presentSessions: _hotPresentSessions, graceTimers: _hotLeaveGraceTimers,
        gameState: state, rerender: hotRerender, lowestConnected: hotLowestSeatConnectedPlayer,
        meObj: hotMe, rpcName: 'huddle_hot_handle_disconnect',
      });
    }
    function hotStartLeaveGrace(sessionId){ huddleStartLeaveGrace(_hotLeaveGraceTimers, sessionId, HOT_LEAVE_GRACE_MS, hotConfirmUserGone); }
    // Shared leave-grace cancel — logic is identical across all 4 games; only
    // the per-game timer map differs. Phase 2: one implementation, four thin
    // callers (kept so existing call sites are untouched).
    function huddleCancelLeaveGrace(timers, sessionId){
      if (timers.has(sessionId)) {
        clearTimeout(timers.get(sessionId));
        timers.delete(sessionId);
      }
    }
    // Shared leave-grace start — identical logic across all 4 games; the per-game
    // timer map, grace duration, and "user gone" callback are passed in. Phase 2 #2.
    function huddleStartLeaveGrace(timers, sessionId, graceMs, onConfirm){
      if (timers.has(sessionId)) {
        clearTimeout(timers.get(sessionId));
      }
      const tid = setTimeout(() => onConfirm(sessionId), graceMs);
      timers.set(sessionId, tid);
    }
    // ---- More shared room helpers (Phase 2). Each was duplicated 4× and is
    // identical across games except a game token or which presence collections
    // it touches. ----
    function huddleReadUrlRoom(gameToken){
      try {
        const params = new URLSearchParams(window.location.search);
        const code = params.get('room');
        const game = params.get('game');
        if (!code) return null;
        if (game && game !== gameToken) return null;   // wrong game's code → ignore
        return code.toUpperCase().trim();
      } catch(e){ return null; }
    }
    function huddleSyncUrlToRoom(code, gameToken){
      if (!code) return;
      try {
        history.replaceState(history.state, '', '/?room=' + encodeURIComponent(code) + '&game=' + gameToken);
      } catch(e){}
    }
    function huddleResetPresenceState(timers, sessions){
      timers.forEach(tid => { try { clearTimeout(tid); } catch(e){} });
      timers.clear();
      sessions.clear();
    }
    // Shared room-state fetch with one retry (covers Supabase replication lag
    // when an invitee taps Join before the host's row has propagated). Returns
    // the room's `state` object, or null if not found / errored. Each game keeps
    // its own tiny apply step (closedByHost handling, state merge). Hot/Cham/Liar
    // share this; Mafia's load has different control flow and stays separate.
    async function huddleFetchRoomState(table, code){
      if (!(window.sb && window.sb.from) || !code) return null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { data, error } = await window.sb.from(table).select('state').eq('code', code).maybeSingle();
          if (error) {
            console.warn('[Huddle] load ' + table + ' error (attempt ' + (attempt+1) + '):', error.message || error);
          } else if (data && data.state) {
            return data.state;
          }
        } catch(e) {
          console.warn('[Huddle] load ' + table + ' exception (attempt ' + (attempt+1) + '):', e);
        }
        if (attempt === 0) await new Promise(r => setTimeout(r, 500));
      }
      return null;
    }
    function hotCancelLeaveGrace(sessionId){ huddleCancelLeaveGrace(_hotLeaveGraceTimers, sessionId); }
    function hotResetPresenceState(){ huddleResetPresenceState(_hotLeaveGraceTimers, _hotPresentSessions); }

    // ---------------------------------------------------------------------------
    // Shared realtime engine for Hot Seat / Chameleon / Liar's Cup.
    //
    // Opens the live Supabase channel, tracks presence (keyed on the session id
    // so a refresh-rejoin looks like the same key and cancels the leave-grace
    // timer), listens for room UPDATE/INSERT, and surfaces the "{name} left"
    // seat-vanish toast. One engine so a fix lands in all three at once.
    //
    // Mafia keeps its own bespoke mafiaWireSync (narrator model: a single
    // event:'*' handler, merge-assign without clearing keys, no closedByHost,
    // profile-based name resolution, debounced reconcile).
    //
    // The per-game channel/presence module `let`s are read/written through the
    // `refs` accessor closures — they're also touched by sign-out/auth teardown
    // (app-03), leave/force-leave (app-06/app-09), presence queries
    // (app-07/app-09) and the mp-test harness (by name), so they must stay
    // exactly where and what they are. Per-game behavioural quirks ride in as
    // hooks: normalizeIncoming / restoreMeId / gracefulEnd / afterApply.
    function huddleWireSync(opts){
      if (!window.sb) return;
      const gameState = opts.gameState;
      if (!gameState.code) return;
      const sid = opts.getSessionId();
      // Already subscribed to this code AND this session id — no-op. Session id
      // is part of the key because presence is captured at channel-creation time,
      // so an identity change (anon → Google) needs a rebuild or our presence
      // keeps echoing the stale anon id.
      if (opts.refs.getChannel() && opts.refs.getChannelCode() === gameState.code && opts.refs.getChannelSessionId() === sid) return;
      if (opts.refs.getChannel()) {
        try { window.sb.removeChannel(opts.refs.getChannel()); } catch(e){}
        opts.refs.setChannel(null); opts.refs.setChannelCode(null); opts.refs.setChannelSessionId(null);
        opts.resetPresenceState();
      }
      const code = gameState.code;
      const handler = (payload) => {
        const newState = payload && payload.new && payload.new.state;
        if (!newState) return;
        if (typeof newState.revision === 'number' && newState.revision <= (gameState.revision || 0)) return;
        // Host closed the room — auto-leave for every other player still seated.
        if (newState.closedByHost && opts.meObj.myId) {
          if (typeof showLobbyToast === 'function') {
            try { showLobbyToast(t('lobby.hostClosedRoom'), 3500); } catch(e){}
          }
          opts.forceLeaveLocal();
          return;
        }
        if (opts.normalizeIncoming) opts.normalizeIncoming(newState);
        // Capture who was seated BEFORE applying the update so we can detect a
        // player leaving — explicit Leave AND disconnect both surface here as a
        // seat that vanished from claimedBy → the "{name} left" notice.
        const _prevClaimedBy = Object.assign({}, gameState.claimedBy || {});
        const _prevPhase = gameState.phase;
        const _mySidNow = opts.getSessionId();
        Object.keys(gameState).forEach(k => { delete gameState[k]; });
        Object.assign(gameState, newState);
        // Restore meId from claim so role/seat lookups keep working locally.
        if (opts.restoreMeId) {
          const claimed = Object.entries(gameState.claimedBy || {}).find(([pid, s]) => s === _mySidNow);
          if (claimed) { opts.meObj.myId = claimed[0]; state.meId = claimed[0]; }
        }
        // ----- Player-left notice (+ optional graceful end) -----
        try {
          if (opts.meObj.myId) {  // only notify players still seated in this room
            const _newClaimedBy = gameState.claimedBy || {};
            const _goneSeats = Object.keys(_prevClaimedBy).filter(pid =>
              _prevClaimedBy[pid] && !_newClaimedBy[pid] && _prevClaimedBy[pid] !== _mySidNow);
            if (_goneSeats.length && typeof showLobbyToast === 'function') {
              const p = (gameState.players || []).find(x => x.id === _goneSeats[0]);
              let nm; try { nm = (p && typeof playerDisplayFor === 'function') ? playerDisplayFor(p, _prevClaimedBy).name : (p && p.name); } catch(e){}
              showLobbyToast(t(opts.toastLeftKey, { name: nm || (p && p.name) || '?' }), 3500);
            }
            if (opts.gracefulEnd) opts.gracefulEnd({ prevClaimedBy: _prevClaimedBy, newClaimedBy: _newClaimedBy, prevPhase: _prevPhase });
          }
        } catch(e){}
        if (opts.afterApply) opts.afterApply();
        const activeId = document.querySelector('.screen.active');
        const currentId = activeId ? activeId.id.replace('screen-', '') : null;
        if (currentId && opts.isOnGameScreen(currentId)) opts.rerender();
      };
      // Presence handlers — key is the session id so refresh-rejoin looks like
      // the same key, naturally cancelling the grace timer.
      const onPresenceSync = () => {
        const presState = opts.refs.getChannel().presenceState();
        const fresh = new Set(Object.keys(presState || {}));
        fresh.forEach(s => { if (opts.graceTimers.has(s)) opts.cancelGrace(s); });
        opts.refs.setPresent(fresh);
        if (typeof opts.rerender === 'function') opts.rerender();
      };
      const onPresenceJoin = ({ key }) => {
        if (!key) return;
        opts.refs.getPresent().add(key);
        opts.cancelGrace(key);
      };
      const onPresenceLeave = ({ key }) => {
        if (!key) return;
        // DON'T delete immediately — start a grace timer so a quick
        // refresh-rejoin doesn't trigger the "gone" flow.
        opts.startGrace(key);
      };
      opts.refs.setChannelCode(code);
      opts.refs.setChannelSessionId(sid);
      const channel = window.sb
        .channel(opts.channelName + code, { config: { presence: { key: opts.presenceKey || ('tab_' + Math.random()) } } })
        .on('postgres_changes', { event:'UPDATE', schema:'public', table:opts.table, filter:'code=eq.' + code }, handler)
        .on('postgres_changes', { event:'INSERT', schema:'public', table:opts.table, filter:'code=eq.' + code }, handler)
        .on('presence', { event: 'sync'  }, onPresenceSync)
        .on('presence', { event: 'join'  }, onPresenceJoin)
        .on('presence', { event: 'leave' }, onPresenceLeave)
        .subscribe(async (status) => {
          if (status !== 'SUBSCRIBED') return;
          if (opts.refs.getChannelCode() !== code) return;
          // Announce our presence the moment we're subscribed.
          try {
            await opts.refs.getChannel().track({ user_id: opts.getTrackUserId(), joined_at: Date.now() });
          } catch(e){}
          // Reconcile the gap between the initial load and the live subscription:
          // other devices may have written updates the channel wasn't yet live to
          // deliver. Re-fetch once, then re-render.
          try {
            const ok = await opts.loadRoom(code);
            if (ok) {
              if (opts.restoreMeId) {
                const claimed = Object.entries(gameState.claimedBy || {}).find(([pid, s]) => s === opts.getSessionId());
                if (claimed) { opts.meObj.myId = claimed[0]; state.meId = claimed[0]; }
              }
              const activeId = document.querySelector('.screen.active');
              const currentId = activeId ? activeId.id.replace('screen-', '') : null;
              if (currentId && opts.isOnGameScreen(currentId)) opts.rerender();
            }
          } catch(e){}
        });
      opts.refs.setChannel(channel);
    }

    let _hotChannel = null;
    let _hotChannelCode = null;
    let _hotChannelSessionId = null;
    function hotWireSync(){
      const mySid = hotGetSessionId();
      huddleWireSync({
        gameState: state, meObj: hotMe, getSessionId: hotGetSessionId,
        channelName: 'hotseat_room:', table: 'hotseat_rooms',
        presenceKey: mySid, getTrackUserId: () => mySid,
        toastLeftKey: 'hot.toastPlayerLeft', restoreMeId: true,
        rerender: hotRerender, loadRoom: hotLoadRoom, forceLeaveLocal: hotForceLeaveLocal,
        resetPresenceState: hotResetPresenceState,
        graceTimers: _hotLeaveGraceTimers, cancelGrace: hotCancelLeaveGrace, startGrace: hotStartLeaveGrace,
        isOnGameScreen: (id) => ['lobby','splash','play','result'].indexOf(id) !== -1,
        normalizeIncoming: (ns) => { if (!Array.isArray(ns.playersUsedThisRound)) ns.playersUsedThisRound = []; },
        // A game in progress that drops below 2 players ends gracefully back to
        // the lobby. The remaining player became host via the leave RPC, so only
        // they write the reset (revision bump prevents re-trigger).
        gracefulEnd: ({ newClaimedBy, prevPhase }) => {
          const _wasMid = prevPhase && prevPhase !== 'lobby' && prevPhase !== 'result';
          const _stillMid = state.phase && state.phase !== 'lobby' && state.phase !== 'result';
          if (_wasMid && _stillMid && Object.keys(newClaimedBy).length < 2 && hotIsHost()) {
            try { if (typeof showLobbyToast === 'function') showLobbyToast(t('hot.otherPlayerLeft'), 3500); } catch(e){}
            state.phase = 'lobby';
            state.playersUsedThisRound = [];
            hotPersist();
          }
        },
        refs: {
          getChannel: () => _hotChannel, setChannel: (c) => { _hotChannel = c; },
          getChannelCode: () => _hotChannelCode, setChannelCode: (c) => { _hotChannelCode = c; },
          getChannelSessionId: () => _hotChannelSessionId, setChannelSessionId: (s) => { _hotChannelSessionId = s; },
          getPresent: () => _hotPresentSessions, setPresent: (s) => { _hotPresentSessions = s; },
        },
      });
    }
    // Hot Seat rerender — wrapped through the generic sync gate so cross-device
    // dramatic moments land at the same wall-clock instant. See the
    // huddleSync* block for the mechanism.
    function hotRerenderInner(){
      const phaseToScreen = { lobby:'lobby', splash:'splash', play:'play', result:'result' };
      const target = phaseToScreen[state.phase] || 'lobby';
      const activeId = document.querySelector('.screen.active');
      const currentId = activeId ? activeId.id.replace('screen-', '') : null;
      if (currentId !== target) goTo(target);
      // Lobby-only invite sheet — auto-close if game starts while it's open.
      if (state.phase !== 'lobby') {
        const bd = document.getElementById('lobby-invite-backdrop');
        if (bd && bd.classList.contains('active') && typeof closeLobbyInviteSheet === 'function') {
          closeLobbyInviteSheet();
        }
      }
      if (state.phase === 'lobby') { renderLobbyPlayers(); renderSettings(); updateHowToTrigger(); if (typeof renderLobbyInvites === 'function') renderLobbyInvites('hotseat'); }
      else if (state.phase === 'splash') applySplashContent();
      else if (state.phase === 'play') applyPlayContent();
      else if (state.phase === 'result') applyResultContent();
    }
    const __hotRerenderPending = { timer: null };
    function hotRerender(){
      huddleSyncGateRerender(state, hotRerenderInner, __hotRerenderPending);
    }

    // Generic join URL — works for both Liar's Cup and Hot Seat
    function joinUrl(code, game){
      const origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
      return origin + '/?room=' + encodeURIComponent(code) + '&game=' + game;
    }
    function hotJoinUrl(code){ return joinUrl(code, 'hotseat'); }
    function hotReadUrlRoom(){ return huddleReadUrlRoom('hotseat'); }
    function hotSyncUrlToRoom(code){ huddleSyncUrlToRoom(code, 'hotseat'); }
    function hotFindRecentRoomCode(){
      try { return huddleReadLastRoom('hotseat'); } catch(e){ return null; }
    }
    async function hotStateReset(code){
      const playersCopy = JSON.parse(JSON.stringify(PLAYERS));
      const sid = hotGetSessionId();
      const firstSeat = playersCopy[0] && playersCopy[0].id;
      Object.keys(state).forEach(k => { delete state[k]; });
      Object.assign(state, {
        mode: 'classic',
        // Pre-claim seat 0 for the creator so the FIRST persist already
        // contains both hostId and the host's claim. Without this, a friend
        // accepting an invite very fast could read the room between this
        // persist and the follow-up hotAutoClaimIfNeeded persist and either
        // grab the host role or steal seat 0 (last-write-wins on Supabase).
        meId: firstSeat || null,
        category: 'mixed',
        rounds: 1,
        order: 'rotating',
        currentRound: 1,
        currentPlayerIdx: 0,
        playersUsedThisRound: [],
        players: playersCopy,
        view: 'hotseat',
        currentWord: '',
        roundOutcome: null,
        turnStartTime: 0,
        lastTurnDuration: 0,
        code: code,
        phase: 'lobby',
        hostId: sid,
        claimedBy: firstSeat ? { [firstSeat]: sid } : {},
        // Words consumed during the current game; pickWord filters them out so
        // a single match never repeats a word.
        usedWords: [],
        revision: 0,
      });
      hotMe.myId = firstSeat || null;
      hotPersist();
      try { huddlePersistLastRoom('hotseat',code); } catch(e){}
    }
    async function hotClaimSeat(playerId){
      const sessionId = hotGetSessionId();
      const currentClaim = state.claimedBy[playerId];
      if (currentClaim && currentClaim !== sessionId) return;
      // Optimistic local update — echo will overwrite if RPC rejects.
      if (hotMe.myId && state.claimedBy[hotMe.myId] === sessionId) {
        delete state.claimedBy[hotMe.myId];
      }
      state.claimedBy[playerId] = sessionId;
      if (!state.hostId) state.hostId = sessionId;
      hotMe.myId = playerId;
      state.meId = playerId;
      renderLobbyPlayers();
      renderSettings();
      // Server-validated claim (C2 turn 4a). Universal RPC handles seat
      // switching and rejects seat-stealing at the DB layer.
      await huddleCallRPC('huddle_claim_seat', {
        p_table: 'hotseat_rooms',
        p_code: state.code,
        p_player_id: playerId,
      });
    }
    async function regenerateHotRoom(){
      const code = generateCode();
      await hotStateReset(code);
      hotWireSync();
      hotSyncUrlToRoom(code);
      document.getElementById('room-code').textContent = code;
      resetQrSlot();
      setRoomQrSrc(document.getElementById('room-qr'), qrUrl(hotJoinUrl(code)));
      const btn = document.querySelector('#screen-lobby .room-code-action button[data-action*="regenerateHotRoom"], #screen-lobby .room-code-action button[data-action*="regenerateRoom"]');
      if (btn) {
        btn.classList.remove('spinning');
        void btn.offsetWidth;
        btn.classList.add('spinning');
        setTimeout(() => btn.classList.remove('spinning'), 520);
      }
      hotRerender();
    }

    function formatDuration(ms) {
      if (!ms || ms < 0) return '0s';
      const sec = Math.round(ms / 1000);
      if (sec < 60) return `${sec}s`;
      const min = Math.floor(sec / 60);
      const rem = sec % 60;
      return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
    }

    function getMyRole() {
      const hotSeatPlayer = state.players[state.currentPlayerIdx];
      return hotSeatPlayer && hotSeatPlayer.id === state.meId ? 'hotseat' : 'helper';
    }
    function getMe() {
      const id = (hotMe && hotMe.myId) || state.meId;
      const found = state.players.find(p => p.id === id);
      if (found) return found;
      // Fallback to a no-op object so callers can read .wins without crashing
      return { wins: 0, bestTimeMs: null, name: '', initial: '?', id: null };
    }

    // ---------- Info content ----------
    // Each entry maps to a pair of i18n keys (title + body). The body may
    // contain HTML markup which is inserted via innerHTML.
    const INFO = {
      rounds:        { titleKey:'info.roundsTitle',   bodyKey:'info.roundsBody' },
      order:         { titleKey:'info.orderTitle',    bodyKey:'info.orderBody' },
      'role-hotseat':{ titleKey:'info.hotSeatTitle',  bodyKey:'info.hotSeatBody' },
      'role-helper': { titleKey:'info.helperTitle',   bodyKey:'info.helperBody' },
      // Mode-specific variants. Titles stay the same ("🔥 You're in the hot seat" / "👂 You're
      // a helper"); only the body copy diverges so it doesn't contradict the in-play mode pill.
      'role-hotseat-silent': { titleKey:'info.hotSeatTitle', bodyKey:'info.hotSeatBody_silent' },
      'role-helper-silent':  { titleKey:'info.helperTitle',  bodyKey:'info.helperBody_silent' },
      // Liar's Cup — single role for all players (no team/role variants). Used by the
      // help button in liar-play / liar-reveal / liar-cup screen headers.
      'liar-howplay':        { titleKey:'liar.help.title',   bodyKey:'liar.help.body' },
      // Mafia — same modal system as Liar. Title + body live in i18n
      // (mafia.help.*) so they translate; opened from the Rules pill on
      // each in-game mafia screen header.
      'mafia-howplay':       { titleKey:'mafia.help.title',  bodyKey:'mafia.help.body' },
    };

    function showInfo(key) {
      const info = INFO[key];
      if (!info) return;
      document.getElementById('info-title').textContent = t(info.titleKey);
      document.getElementById('info-body').innerHTML = t(info.bodyKey);
      document.getElementById('info-backdrop').classList.add('active');
    }
    function hideInfo(e) {
      if (e && e.target && e.target.id !== 'info-backdrop' && !e.target.classList.contains('btn')) return;
      document.getElementById('info-backdrop').classList.remove('active');
    }

    function showRoleInfo() {
      const role = state.view === 'hotseat' ? 'role-hotseat' : 'role-helper';
      const mode = state.mode || 'classic';
      // Use the mode-specific variant if it exists in INFO, otherwise fall back to the
      // base role key. Classic always uses the base key.
      const key = (mode !== 'classic' && INFO[role + '-' + mode]) ? (role + '-' + mode) : role;
      showInfo(key);
    }

    // ---------- How to play modal ----------
    const HOWTO_TOTAL = 4;
    const HOWTO_DURATION = 5200;
    let howtoCurrent = 1;
    let howtoTimer = null;

    // Per-mode "seen" flags. A user who's seen the Classic rules but switches to Silent for
    // the first time should still see the pulse — they haven't seen *those* rules yet.
    // Migrate any legacy single-flag value to the classic key once, so existing users don't
    // suddenly see the pulse return for Classic.
    try {
      const legacy = localStorage.getItem('huddle.howto.seen');
      if (legacy && !localStorage.getItem('huddle.howto.seen.classic')) {
        localStorage.setItem('huddle.howto.seen.classic', '1');
        localStorage.removeItem('huddle.howto.seen');
      }
    } catch(e){}

    function howToSeenKey(){ return 'huddle.howto.seen.' + (state.mode || 'classic'); }
    function hasSeenHowTo(){
      try { return !!localStorage.getItem(howToSeenKey()); } catch(e){ return false; }
    }
    function markHowToSeen(){
      try { localStorage.setItem(howToSeenKey(), '1'); } catch(e){}
    }

    // Per-mode title/sub i18n keys. For slides where a mode doesn't override (e.g. Silent
    // slide 1 = Classic slide 1), the helper falls back to the classic key.
    const HOWTO_MODE_OVERRIDES = {
      silent: { 2: ['Title','Sub'] },
    };
    function howToText(slideN, field){
      const mode = state.mode || 'classic';
      const overrides = HOWTO_MODE_OVERRIDES[mode];
      if (overrides && overrides[slideN] && overrides[slideN].indexOf(field) !== -1) {
        return t('howTo.' + mode + '.slide' + slideN + field);
      }
      return t('howTo.slide' + slideN + field);
    }

    // Populate slide titles/subs + toggle slide-4 board variant based on state.mode.
    // Called from openHowTo before activating the modal so the right content is visible
    // the instant the modal animates in.
    function applyHowToContent(){
      const slides = [
        { n: 1, field: 'Sub'     },
        { n: 2, field: 'Sub'     },
        { n: 3, field: 'SubHtml' },
        { n: 4, field: 'SubHtml' },
      ];
      slides.forEach(({n, field}) => {
        const root = document.querySelector('.howto-slide[data-slide="' + n + '"] .howto-text');
        if (!root) return;
        const titleEl = root.querySelector('h2');
        const subEl = root.querySelector('p');
        if (titleEl) titleEl.textContent = howToText(n, 'Title');
        if (subEl) {
          if (field === 'SubHtml') subEl.innerHTML = howToText(n, 'SubHtml');
          else subEl.textContent = howToText(n, 'Sub');
        }
      });
    }

    // Update the lobby's how-to-play trigger sub-text + pulse state to reflect state.mode.
    // Called whenever mode changes (setMode / applyRecommended), the lobby reopens, or the
    // language switches (applyLang would otherwise leave the sub stale).
    function updateHowToTrigger(){
      const subEl = document.getElementById('howto-trigger-sub');
      if (subEl) {
        const mode = state.mode || 'classic';
        const subKey = (mode === 'classic') ? 'lobby.howToSub' : ('lobby.howToSub_' + mode);
        subEl.textContent = t(subKey);
      }
      maybePulseHowTo();
    }

    function openHowTo() {
      applyHowToContent();
      document.getElementById('howto-modal').classList.add('active');
      document.body.style.overflow = 'hidden';
      markHowToSeen();
      document.querySelectorAll('.howto-trigger').forEach(t => t.classList.remove('pulse'));
      goToSlide(1);
    }
    function closeHowTo() {
      document.getElementById('howto-modal').classList.remove('active');
      document.body.style.overflow = '';
      stopAutoAdvance();
    }
    function goToSlide(n) {
      if (n < 1) n = 1;
      if (n > HOWTO_TOTAL) { closeHowTo(); return; }
      howtoCurrent = n;
      document.querySelectorAll('.howto-slide').forEach(s => {
        s.classList.toggle('active', parseInt(s.dataset.slide) === n);
      });
      document.querySelectorAll('.howto-dot').forEach((d, i) => {
        d.classList.toggle('active', i + 1 === n);
      });
      const nextBtn = document.getElementById('howto-next-btn');
      nextBtn.textContent = (n === HOWTO_TOTAL) ? t('howTo.startPlaying') : t('common.next');
      startAutoAdvance();
    }
    function nextSlide() { goToSlide(howtoCurrent + 1); }
    function startAutoAdvance() {
      stopAutoAdvance();
      howtoTimer = setTimeout(() => goToSlide(howtoCurrent + 1), HOWTO_DURATION);
    }
    function stopAutoAdvance() {
      if (howtoTimer) { clearTimeout(howtoTimer); howtoTimer = null; }
    }
    function maybePulseHowTo() {
      const seen = hasSeenHowTo();
      document.querySelectorAll('.howto-trigger').forEach(t => {
        t.classList.toggle('pulse', !seen);
      });
    }

    // ---------- Games page ----------
    function renderGamesStep() {
      const gamesStep = document.getElementById('games-step');
      if (!gamesStep) return;

      const gamesList = document.getElementById('games-list');

      {
        // The Cards (freeform) variant is now the ONE Mafia game on the list —
        // classic mode code stays in the file but its tile is hidden so users
        // only ever pick the freeform variant. Set showMafia = true to bring
        // the classic tile back if needed.
        const showMafia = false;
        gamesList.innerHTML = `
          <div class="hotseat-card" onclick="openLobby('classic')">
            <div class="hotseat-thumb classic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 4 H10"></path>
                <path d="M8 4 V13"></path>
                <path d="M6 13 H18"></path>
                <path d="M7 13 V20"></path>
                <path d="M17 13 V20"></path>
              </svg>
            </div>
            <div class="hotseat-info">
              <div class="hotseat-title-row">
                <div class="hotseat-title">${t('games.classic')}</div>
                <span class="badge">${t('games.fastestWins')}</span>
              </div>
              <div class="hotseat-desc">${t('games.classicDesc')}</div>
              <div class="hotseat-meta">${t('games.classicMeta')}</div>
            </div>
          </div>
          <div class="hotseat-card" onclick="openChamLobby()">
            <div class="hotseat-thumb chameleon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 10c0-1.6 1.3-2.8 3-2.8h12c1.7 0 3 1.2 3 2.8v1.5c0 2.6-2.1 4.7-4.7 4.7-1.8 0-3-1-3.6-2.4h-1.4C10.7 15.2 9.5 16.2 7.7 16.2 5.1 16.2 3 14.1 3 11.5V10z"/>
                <circle cx="8" cy="11.2" r="1.3" fill="currentColor"/>
                <circle cx="16" cy="11.2" r="1.3" fill="currentColor"/>
              </svg>
            </div>
            <div class="hotseat-info">
              <div class="hotseat-title-row">
                <div class="hotseat-title">${t('games.chameleon')}</div>
                <span class="badge">${t('games.bluff')}</span>
              </div>
              <div class="hotseat-desc">${t('games.chameleonDesc')}</div>
              <div class="hotseat-meta">${t('games.chameleonMeta')}</div>
            </div>
          </div>
          <div class="hotseat-card" onclick="openLiarLobby()">
            <div class="hotseat-thumb liar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 4h16l-8 9-8-9z"/>
                <path d="M12 13v6"/>
                <path d="M8 20h8"/>
              </svg>
            </div>
            <div class="hotseat-info">
              <div class="hotseat-title-row">
                <div class="hotseat-title">${t('games.liar')}</div>
                <span class="badge">${t('games.bluff')}</span>
              </div>
              <div class="hotseat-desc">${t('games.liarDesc')}</div>
              <div class="hotseat-meta">${t('games.liarMeta')}</div>
            </div>
          </div>
          ${showMafia ? `
            <div class="hotseat-card" onclick="openMafiaLobby()">
              <div class="hotseat-thumb mafia">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  <circle cx="6" cy="6.5" r="0.6" fill="currentColor"/>
                  <circle cx="17.5" cy="4.5" r="0.6" fill="currentColor"/>
                </svg>
              </div>
              <div class="hotseat-info">
                <div class="hotseat-title-row">
                  <div class="hotseat-title">${t('games.mafia')}</div>
                  <span class="badge">${t('games.mafiaBadge')}</span>
                </div>
                <div class="hotseat-desc">${t('games.mafiaDesc')}</div>
                <div class="hotseat-meta">${t('games.mafiaMeta')}</div>
              </div>
            </div>
          ` : ''}
          <div class="hotseat-card" onclick="openMafiaCardsLobby()">
            <div class="hotseat-thumb mafia">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="6" width="13" height="15" rx="2"/>
                <rect x="8" y="3" width="13" height="15" rx="2"/>
              </svg>
            </div>
            <div class="hotseat-info">
              <div class="hotseat-title-row">
                <div class="hotseat-title">${t('games.mafiaCards')}</div>
                <span class="badge">${t('games.mafiaCardsBadge')}</span>
              </div>
              <div class="hotseat-desc">${t('games.mafiaCardsDesc')}</div>
              <div class="hotseat-meta">${t('games.mafiaCardsMeta')}</div>
            </div>
          </div>
          <div class="section-title">${t('games.moreSoon')}</div>
          <div class="empty">
            <div class="empty-emoji">🎲</div>
            <div>${t('games.moreSoonSub')}<br>${t('games.tellUsNext')}</div>
          </div>
        `;
      }
    }

    // ---------- Screen routing + browser-history integration ----------
    // Suppression flag — set by the popstate handler so we don't push history
    // when we're navigating because the user already pressed Back.
    let _huddleSuppressHistory = false;
    // Tracks the very first screen the app rendered (the one already 'active' in HTML).
    // Used as the fallback target when popstate fires with no state (root of history).
    const _huddleInitialScreen = (() => {
      const active = document.querySelector('.screen.active');
      return active ? active.id.replace('screen-', '') : 'login';
    })();

    // Screens whose refresh behavior we restore from localStorage. Must stay
    // in lockstep with the pre-paint `safe` whitelist in <head> (see Step 2).
    //   - Lobbies are excluded: they restore via URL `?room=&game=`, not from
    //     localStorage. Booting to a lobby with no room data would show an
    //     empty broken screen.
    //   - login is excluded: it's the HTML default, no need to save it.
    //   - Game-phase screens (splash/play/result/etc.) are excluded: those
    //     restore via their lobby's URL → hotRerender routes to the phase.
    const HUDDLE_SAFE_SCREENS = {
      'games':1, 'friends':1, 'profile':1,
      'edit-profile':1, 'feedback-board':1,
      'admin':1, 'admin-feedback':1, 'admin-stats':1,
    };
    // Screens that LEGITIMATELY belong to a lobby/game in progress, so the
    // URL `?room=&game=` should be kept across navigation here. Any screen
    // NOT in this set will have those params stripped from the URL when
    // navigated to, so a later refresh on (say) Friends doesn't auto-route
    // back into the abandoned lobby.
    const HUDDLE_KEEP_ROOM_URL = {
      'lobby':1, 'cham-lobby':1, 'liar-lobby':1,
      'splash':1, 'play':1, 'result':1,
      'cham-splash':1, 'cham-play':1, 'cham-vote':1, 'cham-result':1,
      'liar-play':1,
      // Mafia (Cards mode) screens that carry ?room=&game= so a refresh / phone
      // reopen RESTORES the game instead of dropping the user on the Games tab.
      // mafia-cards-game = narrator dashboard, mafia-cards-role = player card.
      'mafia-lobby':1, 'mafia-cards-game':1, 'mafia-cards-role':1,
      // Legacy classic-mode screens (engine removed; kept harmless in case any
      // stale path still routes to them).
      'mafia-role':1, 'mafia-narrator':1, 'mafia-vote':1, 'mafia-out':1, 'mafia-result':1,
    };

    function goTo(screen) {
      // Admin gate: anyone calling goTo('admin*') without admin flag bounces
      // to profile. UI-level guard only — server checks (is_admin() RLS) are
      // the real defence for any admin action.
      if (screen.startsWith('admin') && !huddleIsAdmin) screen = 'profile';

      // Tear down realtime subscriptions tied to the screen we're leaving so
      // a Supabase channel doesn't stay open while the user is elsewhere.
      // Cheap to re-establish on re-entry; saves a websocket subscription per
      // long-lived session and avoids any cross-user channel-staleness edge
      // case (e.g. sign out → sign in as someone else without a full reload).
      try {
        var _leavingEl = document.querySelector('.screen.active');
        var _leavingId = (_leavingEl && _leavingEl.id) ? _leavingEl.id.replace(/^screen-/, '') : '';
        if (_leavingId === 'feedback-board' && screen !== 'feedback-board' &&
            typeof feedbackUnwireSync === 'function') feedbackUnwireSync();
        if (_leavingId === 'admin-feedback' && screen !== 'admin-feedback' &&
            typeof adminFbUnwireSync === 'function') adminFbUnwireSync();
        // Liar's Cup: if user navigates away mid-cup-spin, scrub the wheel
        // animation state so coming back doesn't show a half-spun wheel or
        // stale OUT/SAFE stamp. The renderer re-paints from server truth
        // on re-entry — this is a safety net for cached visual classes.
        if (_leavingId === 'liar-play' && screen !== 'liar-play' &&
            typeof liarResetCupVisuals === 'function') liarResetCupVisuals();
      } catch(e) {}

      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      const el = document.getElementById('screen-' + screen);
      if (el) el.classList.add('active');

      const nav = document.getElementById('bottom-nav');
      const showNav = ['games','friends','profile'].includes(screen);
      nav.style.display = showNav ? 'flex' : 'none';

      document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.toggle('active', n.dataset.go === screen);
      });

      if (screen === 'games')  renderGamesStep();
      if (screen === 'profile') renderProfileScreen();
      if (screen === 'feedback-board') {
        // Render synchronously with whatever state we have (instant tab paint),
        // then kick off the load — feedbackLoad() re-renders when data lands.
        renderFeedbackBoard();
        if (typeof feedbackLoad === 'function') feedbackLoad();
      }
      if (screen === 'admin') {
        // Refresh the "Feedback NEW count" badge whenever the admin panel
        // opens — keeps it accurate without a heavy reload.
        if (typeof adminRefreshFeedbackBadge === 'function') adminRefreshFeedbackBadge();
      }
      if (screen === 'admin-feedback') {
        if (typeof renderAdminFeedback === 'function') renderAdminFeedback();
        if (typeof adminFeedbackLoad === 'function') adminFeedbackLoad(true);
      }
      if (screen === 'admin-stats') {
        if (typeof renderAdminStats === 'function') renderAdminStats();
        if (typeof adminStatsLoad === 'function') adminStatsLoad(adminStatsState.period, true);
      }
      if (screen === 'friends') friendsLoad();
      if (screen === 'lobby')   renderLobbyPlayers();
      // SETTINGS dropdown: always start collapsed on lobby entry (host or guest,
      // fresh open or re-entry). Auto-expand intentionally NOT done per design.
      if (screen === 'lobby') {
        const el = document.getElementById('hot-settings-collapse');
        if (el) { el.classList.remove('expanded'); const btn = el.querySelector('.settings-collapse-header'); if (btn) btn.setAttribute('aria-expanded','false'); }
      }
      if (screen === 'cham-lobby') {
        const el = document.getElementById('cham-settings-collapse');
        if (el) { el.classList.remove('expanded'); const btn = el.querySelector('.settings-collapse-header'); if (btn) btn.setAttribute('aria-expanded','false'); }
      }
      // Refresh any sound-toggle icons that are now in the visible header.
      document.querySelectorAll('[data-sound-toggle]').forEach(updateSoundToggleIcon);
      // Refresh-restore: if booted directly to Edit Profile, the form fields
      // and avatar preview need populating (editDraft is null on fresh load).
      if (screen === 'edit-profile' && typeof editDraft !== 'undefined' && !editDraft &&
          typeof setupEditProfileForm === 'function') {
        setupEditProfileForm();
      }
      window.scrollTo(0,0);

      // Persist last screen so a refresh on a tab (Friends/Profile/Games/etc.)
      // restores the correct tab instead of falling back to the default.
      if (HUDDLE_SAFE_SCREENS[screen]) {
        try { sessionStorage.setItem('huddle.lastScreen', screen); } catch(e){}
      }

      // Strip ?room=&game= when navigating to a non-room screen so refresh on
      // a tab doesn't auto-route back into a lobby the user has left behind.
      // Lobbies + game-phase screens keep the URL so refresh restores the room.
      if (!HUDDLE_KEEP_ROOM_URL[screen]) {
        try {
          const params = new URLSearchParams(window.location.search);
          if (params.has('room') || params.has('game')) {
            params.delete('room'); params.delete('game');
            const qs = params.toString();
            const newUrl = window.location.pathname + (qs ? '?' + qs : '');
            history.replaceState(history.state, '', newUrl);
          }
        } catch(e){}
      }

      // Push a new history entry for this navigation. Browser back will then
      // pop screens within the app instead of leaving the site. The suppress
      // flag skips this push when we're navigating because of a popstate.
      if (!_huddleSuppressHistory) {
        try {
          // Preserve query string (so ?room=CODE survives forward navigation)
          history.pushState({ huddleScreen: screen }, '', window.location.search || '');
        } catch(e){}
      }
    }

    // Browser back / forward → re-navigate within the app.
    window.addEventListener('popstate', (e) => {
      const target = (e.state && e.state.huddleScreen) || _huddleInitialScreen;
      _huddleSuppressHistory = true;
      goTo(target);
      _huddleSuppressHistory = false;
    });

    document.addEventListener('click', (e) => {
      // Phase 3 DOM decoupling: generic action delegation. Replaces inline
      // onclick="fn('arg')" with data-action="fn" [data-arg="..."]. This ONE
      // listener covers current AND dynamically-rendered elements, and coexists
      // with not-yet-converted inline onclick during the migration. The named fn
      // must be a global; it receives data-arg (a single string) or no argument.
      // data-action-self fires ONLY when the click lands directly on the element
      // (sheet backdrops — replaces the old inner onclick="event.stopPropagation()").
      const actionEl = e.target.closest('[data-action]');
      if (actionEl && !(actionEl.hasAttribute('data-action-self') && e.target !== actionEl)) {
        const fn = window[actionEl.getAttribute('data-action')];
        if (typeof fn === 'function') {
          if (actionEl.hasAttribute('data-arg')) fn(actionEl.getAttribute('data-arg'));
          else fn();
        }
      }
      const navBtn = e.target.closest('.nav-item');
      if (navBtn && navBtn.dataset.go) { goTo(navBtn.dataset.go); return; }
      const chip = e.target.closest('.player-picker .chip');
      if (chip) {
        chip.parentElement.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
      }
      const tab = e.target.closest('.tabs .tab');
      if (tab) {
        tab.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
      }
    });

    // ---------- Lobby ----------
    async function openLobby(_legacyMode) {
      document.getElementById('lobby-title').textContent = t('lobby.title');
      // Drop any seat we still hold in OTHER game lobbies before claiming
      // one here — invariant: one user, one seat across all games.
      try { huddleLeaveOtherGameSeats('hotseat'); } catch(e){}

      const urlRoom = hotReadUrlRoom();
      const existingCode = urlRoom || hotFindRecentRoomCode();

      const authPromise = hotBootstrap();
      const loadPromise = existingCode ? hotLoadRoom(existingCode) : Promise.resolve(false);
      await authPromise;
      const sessionId = hotGetSessionId();
      const loaded = await loadPromise;

      // Invitee arrived via a URL/invite but the room couldn't be loaded —
      // DON'T silently drop them into a fresh room (they'd think they joined
      // their friend but be alone). Surface the failure and route to Games.
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
        const claimed = Object.entries(state.claimedBy || {}).find(([pid, sid]) => sid === sessionId);
        hotMe.myId = claimed ? claimed[0] : null;
        if (hotMe.myId) {
          // Returning to a room we already own a seat in (refresh / re-open).
          state.meId = hotMe.myId;
          try { huddlePersistLastRoom('hotseat',existingCode); } catch(e){}
        } else if (urlRoom) {
          // Came in via a URL — treat as an intentional join (invite or shared link).
          try { huddlePersistLastRoom('hotseat',existingCode); } catch(e){}
        } else {
          // Cached localStorage room but we have no claim and no invite — don't
          // barge into someone else's lobby. Start a fresh room of our own.
          try { huddleClearLastRoom('hotseat'); } catch(e){}
          await hotStateReset(generateCode());
          cachedRoomGone = true;
        }

        // === Reconnect protection (mirrors openLiarLobby) ===
        // If we returned to a room that's mid-game (splash / play) but we no
        // longer own a seat, bounce to Games instead of stranding the user on
        // a screen they can't act on. See openLiarLobby for the full rationale.
        const inGamePhase = state.phase
          && state.phase !== 'lobby'
          && state.phase !== 'result';
        if (inGamePhase && !hotMe.myId) {
          if (typeof showLobbyToast === 'function') {
            try { showLobbyToast(t('liar.toastReconnectStale'), 4500); } catch(e){}
          }
          hotForceLeaveLocal();
          return;
        }
      } else {
        await hotStateReset(generateCode());
      }

      hotWireSync();
      hotSyncUrlToRoom(state.code);

      // Auto-claim the first empty seat so the user doesn't have to tap.
      // Skips if they already hold a seat (returning visitor / refresh) or if the room is full.
      // Awaited so the seat is committed before render — without await, joiners
      // saw their seat as unclaimed for ~200-800ms until the realtime echo
      // landed, and often refreshed to fix it.
      await hotAutoClaimIfNeeded();

      document.getElementById('room-code').textContent = state.code;
      resetQrSlot();
      setRoomQrSrc(document.getElementById('room-qr'), qrUrl(hotJoinUrl(state.code)));
      updateHowToTrigger();
      hotRerender();

      if (cachedRoomGone && typeof showLobbyToast === 'function') {
        showLobbyToast(t('lobby.previousRoomGone'));
      }
    }

    // Auto-assign this device to the first unclaimed seat on lobby entry.
    // Mirrors what would happen if the user immediately tapped an empty tile.
    // Async so callers can await — without awaiting, the lobby renders before
    // the claim RPC commits and joining players see their seat as unclaimed
    // until the next realtime echo lands, forcing them to refresh. See
    // mafiaAutoClaimIfNeeded for the pattern this matches.
    // ---------- Shared lobby auto-claim (Phase 2, 3 of 4) ----------
    // On lobby entry, take the first free seat — unless already seated or the
    // game is past the lobby. Hot/Cham/Liar are identical; only the me object,
    // state, and claim fn differ. Mafia is separate (session-keyed, p1..p8 ids,
    // claims via huddle_claim_seat inline — see mafiaAutoClaimIfNeeded).
    async function huddleAutoClaimIfNeeded(meObj, gameState, claimSeat){
      if (meObj.myId) return;                                       // already seated
      if (gameState.phase && gameState.phase !== 'lobby') return;   // game in progress — sit out
      const empty = (gameState.players || []).find(p => !gameState.claimedBy || !gameState.claimedBy[p.id]);
      if (!empty) return;                                           // room full
      await claimSeat(empty.id);
    }
    async function hotAutoClaimIfNeeded(){
      return huddleAutoClaimIfNeeded(hotMe, state, hotClaimSeat);
    }

    function qrUrl(code) {
      return 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=' + encodeURIComponent(code);
    }

    // Set the QR <img> src AND clear the data-loading="1" flag (which controls
    // the pulsing-gray skeleton CSS). Use this helper everywhere we set a real
    // QR src so the loading shimmer always stops the moment the QR is available.
    function setRoomQrSrc(el, url) {
      if (!el) return;
      el.src = url;
      el.style.display = '';
      el.removeAttribute('data-loading');
    }

    function generateCode() {
      const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let out = '';
      for (let i=0;i<8;i++){ if (i===4) out += '-'; out += c[Math.floor(Math.random()*c.length)] }
      return out;
    }

    // Hides the QR fallback and shows the img element. Called when (re)loading the QR
    // so a previously-failed slot resets and tries again with the new URL.
    function resetQrSlot(){
      const img = document.getElementById('room-qr');
      const fallback = document.getElementById('room-qr-fallback');
      if (img) img.style.display = '';
      if (fallback) fallback.classList.remove('show');
    }

    // Fired by the QR <img>'s onerror handler. Hide the broken img, show the fallback
    // message in the same slot so layout doesn't shift. User can tap regenerate to retry.
    function handleQrError(){
      const img = document.getElementById('room-qr');
      const fallback = document.getElementById('room-qr-fallback');
      if (img) img.style.display = 'none';
      if (fallback) fallback.classList.add('show');
    }

    // Tap the refresh icon → new code + new QR. Brief spin on the icon for tactile feedback.
    // Also resets the QR slot so a previously-failed load gets another attempt with the new URL.
    function regenerateRoom(){
      const code = generateCode();
      const codeEl = document.getElementById('room-code');
      if (codeEl) codeEl.textContent = code;
      resetQrSlot();
      setRoomQrSrc(document.getElementById('room-qr'), qrUrl(code));
      // One-shot spin animation on the refresh button.
      const btn = document.querySelector('.room-code-action button[data-action*="regenerateRoom"]');
      if (btn) {
        btn.classList.remove('spinning');
        // Force reflow so removing + re-adding the class re-triggers the animation.
        void btn.offsetWidth;
        btn.classList.add('spinning');
        setTimeout(() => btn.classList.remove('spinning'), 520);
      }
    }

    function infoIcon(key){
      return `<button class="info-btn" data-action="showInfo" data-arg="${key}" aria-label="What's this?">i</button>`;
    }

    // Shared between Hot Seat ('hot') and Chameleon ('cham') lobbies. Flips
    // the .expanded class on the wrapper; goTo() resets to closed on lobby entry.
    function toggleSettingsCollapse(which){
      const id = which === 'cham' ? 'cham-settings-collapse' : 'hot-settings-collapse';
      const el = document.getElementById(id);
      if (!el) return;
      const expanded = el.classList.toggle('expanded');
      const btn = el.querySelector('.settings-collapse-header');
      if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    function renderSettings() {
      const list = document.getElementById('settings-list');
      const recWrap = document.getElementById('btn-recommended-wrap');

      const roundsSeg = [1,2,3,5].map(r =>
        `<button data-action="setRounds" data-arg="${r}" class="${state.rounds===r?'active':''}">${r}</button>`
      ).join('');

      const orderSeg = [
        {v:'rotating',k:'order.rotating'},
        {v:'random',k:'order.random'},
        {v:'host',k:'order.host'},
      ].map(o =>
        `<button data-action="setOrder" data-arg="${o.v}" class="${state.order===o.v?'active':''}">${t(o.k)}</button>`
      ).join('');

      const recActive = state.mode === 'classic' && state.category === 'mixed' && state.rounds === 1 && state.order === 'rotating';

      // Inline mode hint — only shown for Silent mode, explains the rule twist right beneath
      // the Mode row so the user doesn't have to leave the lobby to learn.
      const modeHintHTML = state.mode === 'silent' ? `
        <div class="mode-hint">
          <div class="mode-hint-icon">🤫</div>
          <div>${t('mode.hint_silent')}</div>
        </div>
      ` : '';

      recWrap.innerHTML = `
        <button class="btn-recommended${recActive ? ' applied' : ''}" id="btn-recommended" data-action="applyRecommended">
          <div class="btn-recommended-icon">✨</div>
          <div class="btn-recommended-text">
            <div class="btn-recommended-title">${t('lobby.useRecommended')}</div>
            <div class="btn-recommended-sub">${t('lobby.useRecommendedSub')}</div>
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.5"><path d="m9 18 6-6-6-6"></path></svg>
        </button>
      `;

      list.innerHTML = `
        <div class="setting-row" data-action="openModeSheet" style="cursor:pointer">
          <div class="setting-row-label">${t('lobby.mode')}</div>
          <div style="display:flex;align-items:center;gap:6px;color:var(--text-secondary);font-size:14px">
            <span>${t('mode.' + state.mode)}</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-tertiary)"><path d="m9 18 6-6-6-6"></path></svg>
          </div>
        </div>
        <div class="setting-row" data-action="openCategorySheet" style="cursor:pointer">
          <div class="setting-row-label">${t('lobby.category')}</div>
          <div style="display:flex;align-items:center;gap:6px;color:var(--text-secondary);font-size:14px">
            <span>${t('cat.' + state.category)}</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-tertiary)"><path d="m9 18 6-6-6-6"></path></svg>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-row-label">${t('lobby.rounds')} ${infoIcon('rounds')}</div>
          <div class="seg">${roundsSeg}</div>
        </div>
        <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="setting-row-label">${t('lobby.order')} ${infoIcon('order')}</div>
          <div class="seg full">${orderSeg}</div>
        </div>
      `;

      const hintSlot = document.getElementById('mode-hint-slot');
      if (hintSlot) hintSlot.innerHTML = modeHintHTML;
    }

    // "Selected" indicator is derived in renderSettings() from state matching the recommended preset.
    // No manual class flips, no setTimeout flash — change a setting, the border disappears automatically.
    function applyRecommended() {
      if (state.code && !hotIsHost()) return;
      // Optimistic local update; server-validated via RPC.
      state.mode = 'classic';
      state.category = 'mixed';
      state.rounds = 1;
      state.order = 'rotating';
      if (state.code) huddleCallRPC('huddle_hot_apply_recommended', { p_code: state.code });
      renderSettings();
      if (typeof updateHowToTrigger === 'function') updateHowToTrigger();
    }
    function setMode(m){
      if (state.code && !hotIsHost()) return;
      state.mode = m;
      if (state.code) {
        huddleCallRPC('huddle_hot_set_setting', { p_code: state.code, p_field: 'mode', p_value: m });
      }
      renderSettings();
      if (typeof updateHowToTrigger === 'function') updateHowToTrigger();
    }

    // ---------- Mode picker (mirrors category picker UX) ----------
    function renderModeOptions(){
      const wrap = document.getElementById('mode-options');
      if (!wrap) return;
      const modes = [
        { id: 'classic', emoji: '💬' },
        { id: 'silent',  emoji: '🤫' },
      ];
      wrap.innerHTML = modes.map(m => `
        <button class="theme-option${state.mode === m.id ? ' active' : ''}" onclick="pickMode('${m.id}')">
          <span class="theme-option-icon" style="background:var(--bg-subtle)">${m.emoji}</span>
          <span class="theme-option-text">
            <span class="theme-option-title">${t('mode.' + m.id)}</span>
            <span class="theme-option-sub">${t('mode.sub_' + m.id)}</span>
          </span>
          <svg class="theme-option-check" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
        </button>
      `).join('');
      parseEmoji(wrap);
    }
    function openModeSheet(){
      renderModeOptions();
      document.getElementById('mode-backdrop').classList.add('active');
    }
    function closeModeSheet(ev){
      if (ev && ev.target && ev.target.id && ev.target.id !== 'mode-backdrop') return;
      document.getElementById('mode-backdrop').classList.remove('active');
    }
    function pickMode(m){
      setMode(m);
      setTimeout(() => document.getElementById('mode-backdrop').classList.remove('active'), 140);
    }
    function setCategory(c){ if (state.code && !hotIsHost()) return; state.category = c; if (state.code) huddleCallRPC('huddle_hot_set_setting', { p_code: state.code, p_field: 'category', p_value: c }); renderSettings(); }
    function setRounds(r){ r = Number(r); if (state.code && !hotIsHost()) return; state.rounds = r; if (state.code) huddleCallRPC('huddle_hot_set_setting', { p_code: state.code, p_field: 'rounds', p_value: r }); renderSettings(); }
    function setOrder(o){ if (state.code && !hotIsHost()) return; state.order = o; if (state.code) huddleCallRPC('huddle_hot_set_setting', { p_code: state.code, p_field: 'order', p_value: o }); renderSettings(); }

    // ---------- Gameplay ----------
    // Helper: which player indices have claimed a seat
    function hotClaimedIndices(){
      return state.players
        .map((p, i) => state.claimedBy && state.claimedBy[p.id] ? i : -1)
        .filter(i => i !== -1);
    }
    function hotClaimedCount(){
      return Object.keys(state.claimedBy || {}).length;
    }

    function startGame() {
      // If the button is gated (aria-disabled), surface the live hint text
      // as a toast so the user understands WHY tap did nothing instead of
      // staring at a dead button. Existing validation guards stay below as
      // a backstop in case the gate state is stale.
      const _gateBtn = document.getElementById('hot-start-btn');
      if (_gateBtn && _gateBtn.getAttribute('aria-disabled') === 'true') {
        const _hintEl = document.getElementById('hot-seats-hint');
        const _msg = _hintEl && _hintEl.textContent && _hintEl.textContent.trim();
        if (_msg && typeof showLobbyToast === 'function') showLobbyToast(_msg);
        return;
      }
      if (!hotIsHost()) return;
      if (hotClaimedCount() < 2 || !hotMe.myId) return;
      // For 'host' picker order, show the picker first — hostPicked will
      // call the RPC once a player is chosen. For auto-orders (rotating /
      // random), pick locally and call huddle_hot_play_again directly.
      if (state.order === 'host') {
        const claimed = hotClaimedIndices();
        const remaining = claimed.filter(i => !hotUsedHas(i));
        if (remaining.length === 0) return;
        showPicker(remaining);
        return;
      }
      // Pick the first player + word locally, server validates and resets
      // game state atomically (C2 turn 4b).
      const claimed = hotClaimedIndices();
      const idx = (state.order === 'random')
        ? claimed[Math.floor(Math.random() * claimed.length)]
        : claimed[0];
      const word = pickWord();
      huddleCallRPC('huddle_hot_play_again', {
        p_code: state.code,
        p_player_idx: idx,
        p_word: word,
      });
    }

    function pickNextPlayer(isFirst) {
      // C2 turn 4b: now only used by nextTurn (auto-orders). Host-picker
      // path goes through hostPicked directly. Fresh-game start lives in
      // startGame above. Server-validated via huddle_hot_next_turn.
      if (!hotIsHost()) return;
      const claimed = hotClaimedIndices();
      const remaining = claimed.filter(i => !hotUsedHas(i));
      if (remaining.length === 0) return;

      if (state.order === 'host') {
        showPicker(remaining);
        return;
      }
      const idx = (state.order === 'random')
        ? remaining[Math.floor(Math.random() * remaining.length)]
        : remaining[0];
      const word = pickWord();
      huddleCallRPC('huddle_hot_next_turn', {
        p_code: state.code,
        p_player_idx: idx,
        p_word: word,
      });
    }

    function showPicker(remaining) {
      const grid = document.getElementById('pick-grid');
      const claimed = new Set(hotClaimedIndices());
      ensureClaimantProfiles(Object.values(state.claimedBy || {}), () => showPicker(remaining));
      grid.innerHTML = state.players.map((p,i) => {
        const isClaimed = claimed.has(i);
        const done = hotUsedHas(i);
        const isMe = p.id === state.meId;
        const clickable = isClaimed && !done;
        const tileDisplay = playerDisplayFor(p, state.claimedBy);
        return `<div class="pick-tile ${done?'done':''} ${!isClaimed?'unclaimed':''}" ${clickable?`onclick="hostPicked(${i})"`:''} ${!isClaimed?'style="opacity:.4"':''}>
          ${avatarHTML(tileDisplay.avatar, 44, { fallback: p.initial })}
          <div class="pick-tile-name">${isMe ? 'You' : escapeHTML(tileDisplay.name)}</div>
        </div>`;
      }).join('');
      parseEmoji(grid);
      document.getElementById('pick-backdrop').classList.add('active');
    }

    function hostPicked(idx) {
      if (!hotIsHost()) return;
      document.getElementById('pick-backdrop').classList.remove('active');
      const word = pickWord();
      // Context-aware RPC routing (C2 turn 4b):
      //   • phase='lobby'  → fresh game start (uses play_again RPC which
      //                       also resets wins/round/etc. for the fresh game)
      //   • phase='result' → mid-game host advancing to next turn
      //   • phase='splash' → host re-picking after a cancel; treat as next_turn
      if (state.phase === 'lobby') {
        huddleCallRPC('huddle_hot_play_again', {
          p_code: state.code,
          p_player_idx: idx,
          p_word: word,
        });
      } else {
        huddleCallRPC('huddle_hot_next_turn', {
          p_code: state.code,
          p_player_idx: idx,
          p_word: word,
        });
      }
    }

    function cancelPicker(e) {
      // Only close on backdrop or X click — not when clicking inside the sheet itself
      if (e && e.target && e.target.id !== 'pick-backdrop' && !e.target.closest('.icon-btn')) return;
      document.getElementById('pick-backdrop').classList.remove('active');
      // User stays on whatever screen they came from (lobby or result).
      // They can re-tap "Start game" or "Next turn" to reopen the picker.
    }

    function applySplashContent(){
      const player = state.players[state.currentPlayerIdx];
      if (!player) return;
      const meIsHotSeat = player.id === hotMe.myId;
      const claimedTotal = hotClaimedCount();
      const totalTurns = claimedTotal * state.rounds;
      const turnNumber = (state.currentRound - 1) * claimedTotal + (state.playersUsedThisRound || []).length + 1;

      // Kick off profile fetch + re-render when it arrives so "Jordan" → real display_name
      ensureClaimantProfiles(Object.values(state.claimedBy || {}), applySplashContent);
      const display = playerDisplayFor(player, state.claimedBy);

      document.getElementById('splash-emoji').textContent = meIsHotSeat ? '🔥' : '👂';
      document.getElementById('splash-label').textContent =
        state.rounds === 1
          ? t('splash.turnOf', { n: turnNumber, total: totalTurns })
          : t('splash.roundTurn', { round: state.currentRound, rounds: state.rounds, n: turnNumber, total: totalTurns });
      document.getElementById('splash-name').textContent =
        meIsHotSeat ? t('splash.yourTurn') : t('splash.namesTurn', { name: display.name });
      document.getElementById('splash-role').textContent =
        meIsHotSeat ? t('splash.youAreHotSeat') : t('splash.youAreHelper');
      document.getElementById('splash-context').textContent =
        meIsHotSeat
          ? t('splash.hotSeatContext')
          : t('splash.helperContext', { name: display.name });

      const splashSection = document.getElementById('screen-splash');
      const splashEl = splashSection && splashSection.querySelector('.splash');
      if (splashEl) {
        splashEl.style.animation = 'none';
        void splashEl.offsetWidth;
        splashEl.style.animation = '';
      }
    }
    function showSplash() {
      applySplashContent();
      goTo('splash');
    }

    function dismissSplash() {
      // Any claimant can advance. Server records used-this-round + sets
      // turnStartTime + phase='play' (C2 turn 4b). Echo updates local.
      huddleCallRPC('huddle_hot_dismiss_splash', { p_code: state.code });
    }

    function applyPlayContent(){
      state.view = getMyRole();
      const player = state.players[state.currentPlayerIdx];
      if (!player) return;
      const meIsHotSeat = state.view === 'hotseat';
      ensureClaimantProfiles(Object.values(state.claimedBy || {}), applyPlayContent);
      const display = playerDisplayFor(player, state.claimedBy);
      document.getElementById('play-round').textContent =
        t('play.round', { current: state.currentRound, total: state.rounds });
      document.getElementById('play-role-label').textContent =
        meIsHotSeat ? t('play.yourTurnFire') : t('play.helpName', { name: display.name });
      document.getElementById('play-wins').textContent = (getMe() && getMe().wins) || 0;
      renderPlay();
    }
    function startTurn() {
      // Legacy entry — keep for safety; just re-apply content if we're in play phase.
      applyPlayContent();
      goTo('play');
    }

    function pickWord() {
      const list = WORDS[state.category] || WORDS.mixed;
      // Track used words for THIS game so the same word never repeats in a
      // single match. The list is reset on startGame / hotPlayAgain. If a long
      // game somehow exhausts the category, wipe and reuse so we never stall.
      if (!Array.isArray(state.usedWords)) state.usedWords = [];
      const remaining = list.filter(w => state.usedWords.indexOf(w) === -1);
      const pool = remaining.length > 0 ? remaining : list;
      if (remaining.length === 0) state.usedWords = [];
      const word = pool[Math.floor(Math.random() * pool.length)];
      state.usedWords.push(word);
      return word;
    }

    function renderPlay() {
      const card = document.getElementById('play-content');
      const actions = document.getElementById('play-actions');
      const player = state.players[state.currentPlayerIdx];
      ensureClaimantProfiles(Object.values(state.claimedBy || {}), renderPlay);
      const playerDisplay = playerDisplayFor(player, state.claimedBy);
      const helpButton = `
        <button class="role-hero-help" onclick="showRoleInfo()">
          ${t('play.howDoesThis')}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg>
        </button>
      `;
      // Mode reminder pill — sits inside the role-hero so it's visible the whole turn.
      // Tells the helper "act it out, no talking" in Silent. Empty for Classic.
      let modePill = '';
      if (state.mode === 'silent') {
        modePill = `<div class="play-mode-pill"><span class="mp-icon">🤫</span>${t('play.modePill.silent')}</div>`;
      }

      if (state.view === 'hotseat') {
        card.innerHTML = `
          <div class="role-hero">
            <div class="role-hero-emoji">🔥</div>
            <div class="role-hero-title">${t('play.youreInHotSeat')}</div>
            <div class="role-hero-sub">${t('play.hotSeatSub')}</div>
            ${modePill}
            ${helpButton}
          </div>
        `;
        actions.innerHTML = `
          <button class="btn btn-give-up" onclick="endRound('forfeit', event)">
            ${t('play.iGiveUp')}
          </button>
        `;
      } else {
        card.innerHTML = `
          <div class="role-hero">
            <div class="role-hero-emoji">👂</div>
            <div class="word-label-big">${t('play.giveCluesFor')}</div>
            <div class="word-text-big">${state.currentWord}</div>
            <div class="role-hero-sub">${t('play.describeIt', { name: huddleEscape(playerDisplay.name) })}</div>
            ${modePill}
            ${helpButton}
          </div>
        `;
        actions.innerHTML = `
          <button class="btn btn-got-it" onclick="endRound('won', event)">
            ${t('play.hotSeatGotIt')}
          </button>
        `;
      }
    }

    async function endRound(outcome, ev) {
      // Local action-gate (UX) — server enforces same rule against canonical
      // claimedBy + currentPlayerIdx, so a tampered client cannot bypass it.
      const player = state.players[state.currentPlayerIdx];
      if (!player) return;
      const meIsHotSeat = player.id === hotMe.myId;
      if (outcome === 'forfeit' && !meIsHotSeat) return;
      if (outcome === 'won' && meIsHotSeat) return;
      // Disable the button while the RPC is in flight so a frustrated tap-spam
      // doesn't fire 5 simultaneous requests. On success, the realtime push
      // re-renders the screen and removes the button anyway; on failure, we
      // re-enable so the user can retry (huddleCallRPC already shows a toast).
      const btn = ev && ev.currentTarget;
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy','true'); }
      // Lifetime "wins" stat is bumped render-side in showResult — see the
      // _hotWinsBumpedKey block there. Bumping HERE would never fire on the
      // winner's device in multi-device mode: this handler runs on the helper
      // (the hot seat can't tap "won" themselves), so player.id === hotMe.myId
      // is always false by this line.
      // Server validates role, records outcome/duration/wins/bestTimeMs (C2 turn 4b).
      const res = await huddleCallRPC('huddle_hot_end_round', {
        p_code: state.code,
        p_outcome: outcome,
      });
      // Re-enable on error so retry works. Success path: realtime push has
      // already (or will shortly) swap screens; if the button is still in the
      // DOM after a brief grace window, re-enable defensively.
      const restore = () => {
        if (btn && document.body.contains(btn)) {
          btn.disabled = false;
          btn.removeAttribute('aria-busy');
        }
      };
      if (res && res.error) restore();
      else setTimeout(restore, 2000);
    }

    function quitGame() {
      // Real leave — release seat, transfer host, clear room reference so the
      // user (and remaining players) aren't pulled back into a stale match.
      // Has its own confirm dialog because they're mid-game.
      hotLeaveRoom();
    }

    function applyResultContent(){
      showResult();
    }
    function showResult() {
      const player = state.players[state.currentPlayerIdx];
      const claimedTotal = hotClaimedCount();
      const usedCount = (state.playersUsedThisRound || []).length;
      const roundOver = usedCount === claimedTotal;
      const isLastTurn = roundOver && state.currentRound === state.rounds;
      const won = state.roundOutcome === 'won';

      ensureClaimantProfiles(Object.values(state.claimedBy || {}), showResult);
      const display = playerDisplayFor(player, state.claimedBy);
      const isMeHotSeat = player && player.id === state.meId;
      const hotSeatName = isMeHotSeat ? t('picker.you') : display.name;

      document.getElementById('result-header').textContent =
        isLastTurn ? t('result.gameOver') : t('result.namesTurn', { name: hotSeatName });
      document.getElementById('result-emoji').textContent = won ? '🎉' : '🏳️';
      document.getElementById('result-title').textContent = won
        ? t('result.gotIt', { name: hotSeatName })
        : t('result.gaveUp', { name: hotSeatName });
      document.getElementById('result-sub').textContent = won
        ? t('result.wordWasWin', { word: state.currentWord.toUpperCase() })
        : t('result.wordWasLose', { word: state.currentWord.toUpperCase() });

      const timeText = formatDuration(state.lastTurnDuration);
      document.getElementById('result-time').textContent =
        won ? t('result.guessedIn', { time: timeText }) : t('result.lastedFor', { time: timeText });

      const lb = document.getElementById('leaderboard');
      // Sort by fastest best time. Players with no wins go last.
      // If two players have the same best time, more wins = higher rank (consistency tiebreaker).
      // Only show players who actually claimed a seat — empty seats don't appear on the leaderboard.
      const claimedSet = new Set(Object.keys(state.claimedBy || {}));
      const sorted = state.players.filter(p => claimedSet.has(p.id)).sort((a,b) => {
        const aTime = (a.bestTimeMs != null) ? a.bestTimeMs : Infinity;
        const bTime = (b.bestTimeMs != null) ? b.bestTimeMs : Infinity;
        if (aTime !== bTime) return aTime - bTime;
        return (b.wins || 0) - (a.wins || 0);
      });
      lb.innerHTML = sorted.map((p,i) => {
        const timeText = (p.bestTimeMs != null) ? `⏱ ${formatDuration(p.bestTimeMs)}` : '—';
        const isCrowned = i === 0 && isLastTurn && p.bestTimeMs != null;
        const isMe = p.id === state.meId;
        const rowDisplay = playerDisplayFor(p, state.claimedBy);
        return `
          <div class="lb-row ${isCrowned ? 'winner' : ''}">
            <div class="lb-rank">${i+1}</div>
            ${avatarHTML(rowDisplay.avatar, 44, { fallback: p.initial })}
            <div class="lb-name">${isMe ? t('picker.you') : escapeHTML(rowDisplay.name)}</div>
            <div class="lb-score">${timeText}</div>
          </div>
        `;
      }).join('');
      parseEmoji(lb);

      const nextBtn = document.getElementById('next-btn');
      const leaveBtn = document.getElementById('leave-btn');
      const amHost = hotIsHost();
      // Primary button (nextBtn) and secondary leave button vary by phase + role:
      //   • Game over + host  → "Play again" + "Leave" (host-leave closes the room for everyone)
      //   • Game over + other → "Waiting for host to start new game…" + "Leave" (just me)
      //   • Mid-round + host  → "Next turn" + "Leave" (just me; transfers host)
      //   • Mid-round + other → "Waiting for host…" + "Leave" (just me)
      if (isLastTurn) {
        if (amHost) {
          nextBtn.textContent = t('result.playAgain');
          nextBtn.onclick = hotPlayAgain;
          nextBtn.disabled = false;
          leaveBtn.textContent = t('result.leaveGame');
          leaveBtn.onclick = hotCloseRoom;
        } else {
          nextBtn.textContent = t('result.waitingForHostNewGame');
          nextBtn.onclick = null;
          nextBtn.disabled = true;
          leaveBtn.textContent = t('result.leaveGame');
          leaveBtn.onclick = hotLeaveGameOver;
        }
      } else if (amHost) {
        nextBtn.textContent = t('result.nextTurn');
        nextBtn.onclick = nextTurn;
        nextBtn.disabled = false;
        leaveBtn.textContent = t('result.leaveGame');
        leaveBtn.onclick = hotLeaveGameOver;
      } else {
        nextBtn.textContent = t('lobby.seatsHintWaitingHost');
        nextBtn.onclick = null;
        nextBtn.disabled = true;
        leaveBtn.textContent = t('result.leaveGame');
        leaveBtn.onclick = hotLeaveGameOver;
      }

      // Count a completed game once, when reaching the last turn's result.
      // Flag rides on synced state so no device double-bumps via re-render
      // (ensureClaimantProfiles callback @7105, realtime sync, language/theme switch).
      // Persist immediately so the realtime echo of endRound's persist doesn't
      // wipe this local flag (wipe-and-replace at line 5985 would otherwise
      // restore the pre-bump snapshot and re-trigger the bump).
      if (isLastTurn && !state._gamesPlayedCounted) {
        bumpGamesPlayed();
        state._gamesPlayedCounted = true;
        // Persist the flag server-side via RPC (C2 turn 4b) so the realtime
        // echo of endRound's persist doesn't wipe it.
        huddleCallRPC('huddle_hot_mark_game_counted', { p_code: state.code });
      }

      // Lifetime "wins" stat — render-side hook so every device evaluates
      // "did MY player just win?" locally. This is what makes the bump fire
      // on the winner's device in multi-device mode; bumping inside endRound
      // would only ever run on the helper's device (see comment there).
      // Per-turn dedup key prevents re-renders from double-bumping.
      if (won && player && player.id === hotMe.myId) {
        // Include lastTurnDuration so the key stays unique across hotPlayAgain
        // (same code+round+idx could otherwise repeat in 1-round replays).
        const winKey = (state.code || '') + ':' + (state.currentRound || 0) + ':' + (state.currentPlayerIdx == null ? -1 : state.currentPlayerIdx) + ':' + (state.lastTurnDuration == null ? 0 : state.lastTurnDuration);
        if (_hotWinsBumpedKey !== winKey) {
          _hotWinsBumpedKey = winKey;
          bumpWins();
        }
      }
    }

    function nextTurn() {
      // Server handles round-rollover + next-turn pick atomically via
      // huddle_hot_next_turn (C2 turn 4b). Client picks the player + word
      // locally and passes them to the RPC. pickNextPlayer still handles
      // the host-picker branch by showing the UI; hostPicked routes that
      // case to the RPC.
      pickNextPlayer(false);
    }

