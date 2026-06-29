// Huddle app-05-settings-feedback-admin.js (fragment 5/10, split from app.js).
// All fragments share ONE global scope and MUST load in numeric order — do not reorder.

    // ---------- Edit Profile ----------
    let editDraft = null;        // working copy until Save
    let activeEpTab = 'symbol';
    let activeSymbolCat = AV_SYMBOL_CATS[0].id;

    // Auto-save draft to sessionStorage so an accidental refresh or
    // navigate-away during edit doesn't wipe unsaved customisation.
    // sessionStorage (not localStorage) so closing the tab still
    // discards the draft — matches the session-state pattern we use
    // for lastScreen / lastRoom.
    const EP_DRAFT_KEY = 'huddle.editProfile.draft';
    function huddleSaveEpDraft(){
      if (!editDraft) return;
      try {
        // Capture the latest name/username from the inputs in case the user
        // typed but the change handler hasn't bubbled into editDraft yet.
        const nameEl = document.getElementById('ep-name');
        const userEl = document.getElementById('ep-username');
        if (nameEl) editDraft.name = nameEl.value;
        if (userEl) editDraft.username = userEl.value;
        const payload = {
          draft: editDraft,
          // Signature so we don't load User A's draft over User B's profile
          // after a sign-out / sign-in in the same tab.
          signature: (myProfile && (myProfile.username || myProfile.name)) || '__anon__',
          savedAt: Date.now()
        };
        sessionStorage.setItem(EP_DRAFT_KEY, JSON.stringify(payload));
      } catch(e) {}
    }
    function huddleClearEpDraft(){
      try { sessionStorage.removeItem(EP_DRAFT_KEY); } catch(e) {}
    }
    function huddleLoadEpDraft(){
      try {
        const raw = sessionStorage.getItem(EP_DRAFT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.draft) return null;
        // Discard if the draft was saved for a different account in this tab.
        const sig = (myProfile && (myProfile.username || myProfile.name)) || '__anon__';
        if (parsed.signature !== sig) { huddleClearEpDraft(); return null; }
        return parsed.draft;
      } catch(e) { return null; }
    }

    // Initialize the editDraft working copy and populate the form fields +
    // avatar preview. Called by openEditProfile (entry point) AND by goTo
    // when the user lands on Edit Profile via refresh-restore — without this
    // the form would be empty (placeholders showing) and the avatar slot
    // wouldn't render until the user manually navigated back and in again.
    function setupEditProfileForm(){
      // Prefer a previously-saved draft (from a same-tab refresh) over a
      // fresh clone — preserves any unsaved customisation the user made.
      const saved = huddleLoadEpDraft();
      editDraft = saved ? JSON.parse(JSON.stringify(saved))
                        : JSON.parse(JSON.stringify(myProfile));
      // Backfill any fields the saved draft might be missing (defensive
      // against schema changes between sessions).
      if (!editDraft.avatar && myProfile && myProfile.avatar) {
        editDraft.avatar = JSON.parse(JSON.stringify(myProfile.avatar));
      }
      document.getElementById('ep-name').value = editDraft.name || '';
      document.getElementById('ep-username').value = editDraft.username || '';
      activeEpTab = 'symbol';
      activeSymbolCat = AV_SYMBOL_CATS[0].id;
      renderEditProfile();
      switchEpTab('symbol');
    }

    function openEditProfile(){
      // Fresh entry from Profile = clear any stale draft first so the
      // user starts from their current profile, not an old draft they
      // forgot about. Refresh-restore path (via goTo) skips this and
      // honours the saved draft instead.
      huddleClearEpDraft();
      setupEditProfileForm();
      goTo('edit-profile');
    }
    function cancelEditProfile(){
      editDraft = null;
      huddleClearEpDraft();
      goTo('profile');
    }
    async function saveEditProfile(){
      const nameInput = document.getElementById('ep-name').value.trim();
      const userInput = document.getElementById('ep-username').value.trim().toLowerCase();

      // Username validation — only if user typed something
      if (userInput) {
        if (userInput.length < 3) {
          huddleSetUsernameStatus(t('editProfile.usernameTooShort'), 'error');
          return;
        }
        if (!/^[a-z0-9_]+$/.test(userInput)) {
          huddleSetUsernameStatus(t('editProfile.usernameBadChars'), 'error');
          return;
        }
      }

      // Make sure auth is ready before talking to Supabase
      if (typeof liarBootstrap === 'function') {
        try { await liarBootstrap(); } catch(e){}
      }

      // If we have Supabase, push to server with uniqueness check
      if (huddleHasSupabaseAuth()) {
        const userId = liarMe.sessionId;
        // Uniqueness check only if username changed
        if (userInput && userInput !== (myProfile.username || '').toLowerCase()) {
          huddleSetUsernameStatus(t('editProfile.checkingUsername'), 'saving');
          try {
            const { data: existing, error: checkErr } = await window.sb
              .from('profiles')
              .select('user_id')
              .eq('username', userInput)
              .maybeSingle();
            if (checkErr) {
              huddleSetUsernameStatus(t('editProfile.saveFailed'), 'error');
              return;
            }
            if (existing && existing.user_id !== userId) {
              huddleSetUsernameStatus(t('editProfile.usernameTaken'), 'error');
              return;
            }
          } catch(e) {
            huddleSetUsernameStatus(t('editProfile.saveFailed'), 'error');
            return;
          }
        }

        // Upsert profile
        huddleSetUsernameStatus(t('editProfile.savingProfile'), 'saving');
        const upsertData = {
          user_id: userId,
          display_name: nameInput || 'You',
          avatar: editDraft.avatar,
        };
        if (userInput) upsertData.username = userInput;
        try {
          const { error: upsertErr } = await window.sb
            .from('profiles')
            .upsert(upsertData, { onConflict: 'user_id' });
          if (upsertErr) {
            // Race condition: someone claimed the username between our check and write
            if (upsertErr.code === '23505') {
              huddleSetUsernameStatus(t('editProfile.usernameTaken'), 'error');
            } else {
              huddleSetUsernameStatus(t('editProfile.saveFailed'), 'error');
            }
            return;
          }
        } catch(e) {
          huddleSetUsernameStatus(t('editProfile.saveFailed'), 'error');
          return;
        }
      }

      // Save succeeded (or Supabase unavailable — fall through to local-only). Commit locally.
      editDraft.name = nameInput || 'You';
      editDraft.username = userInput || '';
      myProfile = editDraft;
      saveProfile(myProfile);
      editDraft = null;
      huddleClearEpDraft();
      huddleClearUsernameStatus();
      renderProfileScreen();
      renderFriends();
      goTo('profile');
    }
    function switchEpTab(tab){
      activeEpTab = tab;
      document.querySelectorAll('.edit-profile-tabs .tab').forEach(t => {
        t.classList.toggle('active', t.dataset.epTab === tab);
      });
      document.getElementById('ep-pane-symbol').style.display = (tab === 'symbol') ? '' : 'none';
      document.getElementById('ep-pane-colour').style.display = (tab === 'colour') ? '' : 'none';
      document.getElementById('ep-pane-style').style.display  = (tab === 'style')  ? '' : 'none';
      renderEditProfile();
    }
    function setEpDraftSymbol(symbol){
      editDraft.avatar.symbol = symbol;
      huddleSaveEpDraft();
      renderEditProfile();
    }
    function setEpDraftColour(colourId){
      editDraft.avatar.colour = colourId;
      huddleSaveEpDraft();
      renderEditProfile();
    }
    function setEpDraftStyle(styleId){
      editDraft.avatar.style = styleId;
      huddleSaveEpDraft();
      renderEditProfile();
    }
    function setSymbolCat(catId){
      activeSymbolCat = catId;
      renderEditProfile();
    }
    function randomizeDraft(){
      if (!editDraft) return;
      editDraft.avatar = randomAvatar();
      renderEditProfile();
    }
    function renderEditProfile(){
      if (!editDraft) return;
      // Preview
      const slot = document.getElementById('edit-avatar-slot');
      slot.innerHTML = avatarHTML(editDraft.avatar, 96, { fallback: editDraft.name[0] });

      // Symbol category chips
      const cats = document.getElementById('ep-symbol-cats');
      cats.innerHTML = AV_SYMBOL_CATS.map(c =>
        `<button class="chip ${c.id === activeSymbolCat ? 'active' : ''}" onclick="setSymbolCat('${c.id}')">${t('symbolCat.' + c.id)}</button>`
      ).join('');

      // Symbol grid (current category only)
      const grid = document.getElementById('ep-symbol-grid');
      const cat = AV_SYMBOL_CATS.find(c => c.id === activeSymbolCat) || AV_SYMBOL_CATS[0];
      grid.innerHTML = cat.items.map(sym =>
        `<button class="ep-cell ep-symbol-cell ${sym === editDraft.avatar.symbol ? 'active' : ''}" onclick="setEpDraftSymbol('${sym}')">${sym}</button>`
      ).join('');

      // Colour grid — each cell shows a tiny avatar in that colour
      const cg = document.getElementById('ep-colour-grid');
      cg.innerHTML = AV_COLOURS.map(c => {
        const preview = avatarHTML({ symbol: editDraft.avatar.symbol, colour: c.id, style: editDraft.avatar.style }, 44, {});
        return `<button class="ep-cell ${c.id === editDraft.avatar.colour ? 'active' : ''}" onclick="setEpDraftColour('${c.id}')" aria-label="${c.id}">${preview}</button>`;
      }).join('');

      // Style grid — each cell shows the current avatar with that style
      const sg = document.getElementById('ep-style-grid');
      sg.innerHTML = AV_STYLES.map(s => {
        const preview = avatarHTML({ symbol: editDraft.avatar.symbol, colour: editDraft.avatar.colour, style: s.id }, 36, {});
        return `<button class="ep-cell ep-style-cell ${s.id === editDraft.avatar.style ? 'active' : ''}" onclick="setEpDraftStyle('${s.id}')">
          ${preview}
          <div class="ep-style-cell-label">${t('style.' + s.id)}</div>
        </button>`;
      }).join('');
      parseEmoji(slot);
      parseEmoji(grid);
      parseEmoji(cg);
      parseEmoji(sg);
    }

    // ---------- About sheet ----------
    function openAbout(){
      document.getElementById('about-backdrop').classList.add('active');
    }
    function closeAboutSheet(ev){
      if (ev && ev.target && ev.target.id && ev.target.id !== 'about-backdrop') return;
      document.getElementById('about-backdrop').classList.remove('active');
    }

    // ---------- Theme ----------
    const THEME_KEY = 'huddle.theme';
    const THEME_LABEL = { system:'System', light:'Light', dark:'Dark' };

    function getThemePref(){
      try { return localStorage.getItem(THEME_KEY) || 'system'; } catch(e){ return 'system'; }
    }
    function resolveTheme(pref){
      if (pref === 'dark' || pref === 'light') return pref;
      try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch(e) { return 'light'; }
    }
    function applyTheme(pref){
      const resolved = resolveTheme(pref);
      document.documentElement.setAttribute('data-theme', resolved);
      document.documentElement.setAttribute('data-theme-pref', pref);
      const meta = document.getElementById('meta-theme-color');
      if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0e0e10' : '#ffffff');
      const label = document.getElementById('theme-value-label');
      if (label) label.textContent = THEME_LABEL[pref] || 'System';
      document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.themePref === pref);
      });
    }
    function setTheme(pref){
      try { localStorage.setItem(THEME_KEY, pref); } catch(e){}
      applyTheme(pref);
    }
    function openThemeSheet(){
      applyTheme(getThemePref());
      document.getElementById('theme-backdrop').classList.add('active');
    }
    function closeThemeSheet(ev){
      // Backdrop click: only close when the click target is the backdrop itself
      // (clicks inside the sheet stop propagation, so we won't get them here).
      // The close button calls closeThemeSheet() with no argument — always close.
      if (ev && ev.target && ev.target.id && ev.target.id !== 'theme-backdrop') return;
      document.getElementById('theme-backdrop').classList.remove('active');
    }
    function pickTheme(pref){
      setTheme(pref);
      setTimeout(() => document.getElementById('theme-backdrop').classList.remove('active'), 140);
    }

    // Track system theme changes when user is on 'system' preference
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => { if (getThemePref() === 'system') applyTheme('system'); };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else if (mq.addListener) mq.addListener(handler);
    } catch(e){}

    // ---------- Language picker (mirrors theme picker UX) ----------
    function openLangSheet(){
      applyLang();
      document.getElementById('lang-backdrop').classList.add('active');
    }
    function closeLangSheet(ev){
      if (ev && ev.target && ev.target.id && ev.target.id !== 'lang-backdrop') return;
      document.getElementById('lang-backdrop').classList.remove('active');
    }
    function pickLang(lang){
      setLang(lang);
      setTimeout(() => document.getElementById('lang-backdrop').classList.remove('active'), 140);
    }

    // ---------- Category picker (mirrors lang picker UX) ----------
    function renderCategoryOptions(){
      const wrap = document.getElementById('category-options');
      if (!wrap) return;
      const cats = ['mixed','animals','food','movies','famous','sports','objects','places','activities','music'];
      wrap.innerHTML = cats.map(c => `
        <button class="theme-option${state.category === c ? ' active' : ''}" onclick="pickCategory('${c}')">
          <span class="theme-option-text">
            <span class="theme-option-title">${t('cat.' + c)}</span>
          </span>
          <svg class="theme-option-check" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
        </button>
      `).join('');
    }
    function openCategorySheet(){
      renderCategoryOptions();
      document.getElementById('category-backdrop').classList.add('active');
    }
    function closeCategorySheet(ev){
      if (ev && ev.target && ev.target.id && ev.target.id !== 'category-backdrop') return;
      document.getElementById('category-backdrop').classList.remove('active');
    }
    function pickCategory(cat){
      setCategory(cat);
      setTimeout(() => document.getElementById('category-backdrop').classList.remove('active'), 140);
    }

    // ---------- Feedback ----------
    // Opens a bottom sheet with 4 categories. Tapping one opens the user's
    // email app via mailto: with a pre-filled subject and body template.
    // The body also auto-appends technical context (screen, language, theme,
    // viewport, user agent) so the user doesn't need to type any of that.
    const FEEDBACK_EMAIL = 'saeedabdulaziz132@gmail.com';

    function currentScreenName(){
      const active = document.querySelector('.screen.active');
      return active ? active.id.replace(/^screen-/, '') : 'unknown';
    }
    function feedbackContext(){
      const themePref = (typeof getThemePref === 'function') ? getThemePref() : 'unknown';
      const resolvedTheme = (typeof resolveTheme === 'function') ? resolveTheme(themePref) : '';
      const themeStr = resolvedTheme && resolvedTheme !== themePref
        ? (themePref + ' (' + resolvedTheme + ')')
        : themePref;
      return '\n\n'
        + t('feedback.contextHeader') + '\n'
        + 'Screen: ' + currentScreenName() + '\n'
        + 'Language: ' + getLang() + '\n'
        + 'Theme: ' + themeStr + '\n'
        + 'Viewport: ' + window.innerWidth + 'x' + window.innerHeight + '\n'
        + 'Browser: ' + (navigator.userAgent || 'unknown');
    }

    function openFeedbackSheet(){
      document.getElementById('feedback-backdrop').classList.add('active');
    }
    function closeFeedbackSheet(ev){
      if (ev && ev.target && ev.target.id && ev.target.id !== 'feedback-backdrop') return;
      document.getElementById('feedback-backdrop').classList.remove('active');
    }
    // sendFeedback() is the entry point wired to the 4 category buttons in the
    // category-picker sheet. It now opens the compose popup instead of mailto.
    // Kept the same name so the existing onclick handlers in HTML keep working.
    function sendFeedback(category){
      openComposeFeedback(category);
    }

    // ---------- Feedback compose + board (Supabase-backed) ----------
    // Posts and votes live in public.feedback_posts / public.feedback_votes.
    // See supabase-feedback.sql for the schema, RLS policies, and realtime setup.
    let composeCategory = 'bug';
    let composeEditingId = null;     // set when the compose sheet is in "edit" mode
    let feedbackMenuPostId = null;   // tracks which post the Edit/Delete sheet refers to
    let feedbackBoardTab = 'bug';
    const FB_CATS = ['bug','idea','word','other'];

    // Single source of truth for board state. Refreshed by feedbackLoad() and
    // kept in sync by the realtime channel — no other code path should mutate it.
    const feedbackState = {
      me: null,                // current auth.user.id, or null when signed-out
      posts: [],               // array of { id, user_id, category, text, lang, edited, created_at }
      voteCounts: Object.create(null), // post_id -> integer heart count
      myVotes: new Set(),      // post_ids the current user has hearted
      loaded: false,
      loading: false,
      error: null,             // last error message (shown in the empty state on failure)
    };
    let _feedbackChannel = null;
    let _feedbackChannelUserId = null;

    // SVGs used in every post card — hoisted so we don't re-allocate per render.
    const FB_HEART_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
    const FB_DOTS_ICON  = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

    // ---------- Post-body translation (MyMemory free API) ----------
    // Cache lives in localStorage keyed by "<postId>|<targetLang>" so translations
    // survive reloads. Loading + failed sets are in-memory only (per session).
    const FB_TRANSLATIONS_KEY = 'huddle.fbTranslations';
    const fbTranslationLoading = new Set();
    const fbTranslationFailed  = new Set();
    const fbShowOriginal       = new Set();

    function fbTranslationKey(id, targetLang){ return id + '|' + targetLang; }

    // Detect whether typed text is English or Turkish. We can't tag posts with
    // the UI language because users routinely type in the *other* language
    // (e.g., filing an English bug while their app is in Turkish). Without an
    // accurate tag the translation feature can't decide when to translate.
    //
    // Heuristic for en-vs-tr only (the languages this app supports):
    //   1. Any Turkish-specific character (ğ ı ş İ ç ö ü) → Turkish.
    //   2. Otherwise score common-word matches (English vs Turkish).
    //   3. If both score zero — short or ambiguous text — fall back to UI lang.
    const FB_TR_WORDS = new Set([
      'bir','ve','icin','ile','bu','su','ben','sen','biz','siz','onlar','var','yok',
      'cok','az','ama','fakat','eger','cunku','gibi','kadar','daha','boyle','soyle',
      'evet','hayir','nasil','nerede','neden','sadece','degil','her','hep','hic',
      'merhaba','selam','tesekkurler','lutfen','olmaz','olur','bence','aslinda',
      'sonra','simdi','bugun','iyi','kotu','guzel','calisiyor','calismiyor','hata',
    ]);
    const FB_EN_WORDS = new Set([
      'the','and','is','of','to','a','in','that','it','he','she','we','you','they',
      'are','was','were','have','has','had','do','does','did','will','would','can',
      'could','should','this','these','those','what','when','where','who','why','how',
      'from','with','for','about','as','at','by','on','but','or','if','so','than',
      'then','because','my','your','our','their','also','very','more','most','some',
      'any','no','not','just','only','please','thanks','bug','feature','app',
    ]);
    function fbDetectLang(text){
      if (!text) return getLang();
      if (/[çğışöüÇĞİŞÖÜ]/.test(text)) return 'tr';
      const words = (text.toLowerCase().match(/[a-z]+/g) || []);
      if (words.length === 0) return getLang();
      let tr = 0, en = 0;
      for (const w of words){
        if (FB_TR_WORDS.has(w)) tr++;
        else if (FB_EN_WORDS.has(w)) en++;
      }
      if (tr === 0 && en === 0) return getLang();
      return tr > en ? 'tr' : 'en';
    }
    function loadFbTranslations(){
      try { return JSON.parse(localStorage.getItem(FB_TRANSLATIONS_KEY) || '{}') || {}; }
      catch(e){ return {}; }
    }
    function saveFbTranslations(map){
      try { localStorage.setItem(FB_TRANSLATIONS_KEY, JSON.stringify(map)); } catch(e){}
    }
    function clearTranslationsForPost(id){
      const cache = loadFbTranslations();
      let changed = false;
      Object.keys(cache).forEach(k => { if (k.startsWith(id + '|')) { delete cache[k]; changed = true; } });
      if (changed) saveFbTranslations(cache);
      // Drop in-memory failure markers too so a fresh edit can retry.
      Array.from(fbTranslationFailed).forEach(k => { if (k.startsWith(id + '|')) fbTranslationFailed.delete(k); });
    }

    async function ensureTranslation(post, targetLang){
      const key = fbTranslationKey(post.id, targetLang);
      if (fbTranslationLoading.has(key) || fbTranslationFailed.has(key)) return;
      const cache = loadFbTranslations();
      if (cache[key]) return;
      fbTranslationLoading.add(key);
      try {
        const url = 'https://api.mymemory.translated.net/get'
          + '?q=' + encodeURIComponent(post.text)
          + '&langpair=' + encodeURIComponent(post.lang) + '|' + encodeURIComponent(targetLang);
        const res = await fetch(url);
        if (!res.ok) throw new Error('http ' + res.status);
        const data = await res.json();
        const translated = data && data.responseData && data.responseData.translatedText;
        if (!translated || typeof translated !== 'string') throw new Error('empty');
        const fresh = loadFbTranslations();
        fresh[key] = translated;
        saveFbTranslations(fresh);
      } catch (e) {
        fbTranslationFailed.add(key);
      } finally {
        fbTranslationLoading.delete(key);
        renderFeedbackBoard();
      }
    }

    function fbToggleOriginal(id){
      if (fbShowOriginal.has(id)) fbShowOriginal.delete(id);
      else fbShowOriginal.add(id);
      renderFeedbackBoard();
    }

    function fbRetryTranslation(id){
      const post = feedbackState.posts.find(p => p.id === id);
      if (!post) return;
      const key = fbTranslationKey(id, getLang());
      fbTranslationFailed.delete(key);
      renderFeedbackBoard();
      ensureTranslation(post, getLang());
    }

    // Resolves what to show for one post: the body text + which inline action,
    // if any, to render under it. Kicks off a fetch when needed (non-blocking).
    function fbResolveBodyView(p, currentLang, cache){
      if (p.lang === currentLang) return { text: p.text, action: null };
      const key = fbTranslationKey(p.id, currentLang);
      const translated = cache[key];
      if (fbShowOriginal.has(p.id)) {
        return { text: p.text, action: translated ? { kind:'showTranslation' } : null };
      }
      if (translated)                       return { text: translated, action: { kind:'showOriginal' } };
      if (fbTranslationLoading.has(key))    return { text: p.text,    action: { kind:'loading' } };
      if (fbTranslationFailed.has(key))     return { text: p.text,    action: { kind:'error' } };
      ensureTranslation(p, currentLang);
      return { text: p.text, action: { kind:'loading' } };
    }

    // Resolves the current user, signing in anonymously if needed. Feedback is
    // a low-friction surface — we never want a sign-in wall before viewing or
    // posting. Matches the auto-anon pattern used by the rooms code.
    async function feedbackEnsureUser(){
      if (!window.sb) return null;
      let { data: { user } } = await window.sb.auth.getUser();
      // Login is REQUIRED now (no anonymous play) and the feedback board sits
      // behind the signed-in app, so a real user is expected. Don't mint an
      // anonymous identity in production; callers already handle a null return.
      // (Localhost/preview keeps anon so the board still works without real OAuth.)
      if (!user){
        const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);
        if (isLocal){
          const res = await window.sb.auth.signInAnonymously();
          user = res && res.data && res.data.user;
        }
      }
      return user || null;
    }

    // One-shot read of the board. Pulls posts + votes in parallel, derives
    // counts + "did I vote on this" locally. Realtime keeps it fresh after.
    async function feedbackLoad(){
      if (!window.sb) return;
      feedbackState.loading = true;
      try {
        const user = await feedbackEnsureUser();
        feedbackState.me = user ? user.id : null;
        if (!feedbackState.me){
          feedbackState.posts = [];
          feedbackState.voteCounts = Object.create(null);
          feedbackState.myVotes = new Set();
          feedbackState.error = null;
          return;
        }
        const [postsRes, votesRes] = await Promise.all([
          window.sb.from('feedback_posts')
            .select('id, user_id, category, text, lang, edited, created_at')
            .order('created_at', { ascending: false }),
          window.sb.from('feedback_votes').select('post_id, user_id'),
        ]);
        if (postsRes.error){ feedbackState.error = postsRes.error.message; return; }
        if (votesRes.error){ feedbackState.error = votesRes.error.message; return; }
        feedbackState.posts = postsRes.data || [];
        const counts = Object.create(null);
        const mine = new Set();
        (votesRes.data || []).forEach(v => {
          counts[v.post_id] = (counts[v.post_id] || 0) + 1;
          if (v.user_id === feedbackState.me) mine.add(v.post_id);
        });
        feedbackState.voteCounts = counts;
        feedbackState.myVotes = mine;
        feedbackState.error = null;
        feedbackState.loaded = true;
      } catch (e) {
        feedbackState.error = (e && e.message) || String(e);
        console.warn('[Huddle] feedbackLoad failed:', e);
      } finally {
        feedbackState.loading = false;
        renderFeedbackBoard();
        // After a successful load we know the user id — wire realtime here so
        // it only ever runs once auth is settled.
        if (feedbackState.me) feedbackWireSync();
      }
    }

    function feedbackUnwireSync(){
      try { if (_feedbackChannel && window.sb) window.sb.removeChannel(_feedbackChannel); } catch(e){}
      _feedbackChannel = null;
      _feedbackChannelUserId = null;
    }

    // Subscribe to INSERT/UPDATE/DELETE on both tables. Any change triggers a
    // reload — simpler than diff-applying events and the dataset is small.
    function feedbackWireSync(){
      if (!window.sb || !feedbackState.me) return;
      if (_feedbackChannel && _feedbackChannelUserId === feedbackState.me) return;
      if (_feedbackChannel){
        try { window.sb.removeChannel(_feedbackChannel); } catch(e){}
        _feedbackChannel = null;
      }
      try {
        _feedbackChannel = window.sb
          .channel('feedback_board_' + feedbackState.me)
          .on('postgres_changes', { event:'*', schema:'public', table:'feedback_posts' }, () => feedbackLoad())
          .on('postgres_changes', { event:'*', schema:'public', table:'feedback_votes' }, () => feedbackLoad())
          .subscribe();
        _feedbackChannelUserId = feedbackState.me;
      } catch(e) {
        console.warn('[Huddle] feedbackWireSync failed:', e);
      }
    }

    function fbIcon(cat){
      switch(cat){
        case 'bug':   return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3 3 0 0 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9"></path></svg>';
        case 'idea':  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.7.6 1 1.4 1 2.3h6c0-.9.3-1.7 1-2.3A7 7 0 0 0 12 2z"></path></svg>';
        case 'word':  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
        case 'other': return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>';
      }
      return '';
    }
    function fbEmoji(cat){
      return cat === 'bug' ? '🐛' : cat === 'idea' ? '💡' : cat === 'word' ? '🗣️' : '📝';
    }
    // Thin alias for the canonical huddleEscape (app-01). Kept so the ~60 existing
    // escapeHTML() call sites stay untouched (low blast radius) — single implementation now.
    function escapeHTML(s){
      return huddleEscape(s);
    }
    function formatRelativeTime(ms){
      const diff = Date.now() - ms;
      if (diff < 60000) return t('time.justNow');
      if (diff < 3600000) return t('time.minutesAgo', { n: Math.floor(diff/60000) });
      if (diff < 86400000) return t('time.hoursAgo', { n: Math.floor(diff/3600000) });
      if (diff < 604800000) return t('time.daysAgo', { n: Math.floor(diff/86400000) });
      try { return new Date(ms).toLocaleDateString(getLang() === 'tr' ? 'tr-TR' : 'en-US', { month:'short', day:'numeric' }); }
      catch(e){ return new Date(ms).toLocaleDateString(); }
    }

    function openComposeFeedback(category, editPost){
      composeCategory = category;
      composeEditingId = editPost ? editPost.id : null;
      // Close the category picker if it's open (we're moving to stage 2).
      document.getElementById('feedback-backdrop').classList.remove('active');
      const titleEl = document.getElementById('compose-feedback-title');
      const subEl = document.getElementById('compose-feedback-sub');
      const submitBtn = document.getElementById('compose-feedback-submit');
      titleEl.textContent = editPost
        ? t('feedback.compose.editTitle')
        : t('feedback.compose.title_' + category);
      subEl.textContent = editPost
        ? t('feedback.compose.editSub')
        : t('feedback.compose.sub_' + category);
      if (submitBtn) submitBtn.textContent = t(editPost ? 'feedback.compose.save' : 'feedback.compose.post');
      const input = document.getElementById('compose-feedback-input');
      input.value = editPost ? (editPost.text || '') : '';
      input.setAttribute('placeholder', t('feedback.compose.placeholder_' + category));
      document.getElementById('compose-feedback-count').textContent = input.value.length;
      document.getElementById('compose-feedback-backdrop').classList.add('active');
      setTimeout(() => { input.focus(); try { input.setSelectionRange(input.value.length, input.value.length); } catch(_){} }, 200);
    }
    function closeComposeFeedback(ev){
      if (ev && ev.target && ev.target.id && ev.target.id !== 'compose-feedback-backdrop') return;
      document.getElementById('compose-feedback-backdrop').classList.remove('active');
      // Clear edit state on close so a future open via any path starts fresh,
      // even if the user dismissed without submitting.
      composeEditingId = null;
    }
    function updateComposeCounter(){
      const input = document.getElementById('compose-feedback-input');
      const count = document.getElementById('compose-feedback-count');
      if (input && count) count.textContent = input.value.length;
    }
    async function submitComposeFeedback(){
      const input = document.getElementById('compose-feedback-input');
      const submitBtn = document.getElementById('compose-feedback-submit');
      const text = (input.value || '').trim();
      if (!text) { input.focus(); return; }
      if (!window.sb) return;
      if (submitBtn) submitBtn.disabled = true;
      try {
        const user = await feedbackEnsureUser();
        if (!user) throw new Error('not signed in');
        // Detect the language of what was typed, not the UI language — the two
        // routinely differ (e.g., English bug report typed while UI is Turkish).
        const detectedLang = fbDetectLang(text);
        if (composeEditingId){
          // RLS will reject this if the post isn't ours, so the .eq filter is
          // belt-and-braces against a stale composeEditingId.
          const { error } = await window.sb.from('feedback_posts')
            .update({ text, lang: detectedLang, edited: true })
            .eq('id', composeEditingId)
            .eq('user_id', user.id);
          if (error) throw error;
          clearTranslationsForPost(composeEditingId);
          fbShowOriginal.delete(composeEditingId);
          composeEditingId = null;
        } else {
          const { error } = await window.sb.from('feedback_posts').insert({
            user_id: user.id,
            category: composeCategory,
            text,
            lang: detectedLang,
          });
          if (error) throw error;
          feedbackBoardTab = composeCategory;
        }
        document.getElementById('compose-feedback-backdrop').classList.remove('active');
        goTo('feedback-board');
        feedbackLoad();
      } catch (e) {
        console.warn('[Huddle] submitComposeFeedback failed:', e);
        alert(t('feedback.board.saveError'));
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    // ---------- Vote / Edit / Delete ----------
    async function toggleFeedbackVote(id){
      if (!window.sb) return;
      const user = await feedbackEnsureUser();
      if (!user) return;
      const wasVoted = feedbackState.myVotes.has(id);
      // Optimistic UI — flip locally first so the heart responds instantly.
      if (wasVoted){
        feedbackState.myVotes.delete(id);
        feedbackState.voteCounts[id] = Math.max(0, (feedbackState.voteCounts[id] || 0) - 1);
      } else {
        feedbackState.myVotes.add(id);
        feedbackState.voteCounts[id] = (feedbackState.voteCounts[id] || 0) + 1;
      }
      renderFeedbackBoard();
      try {
        const res = wasVoted
          ? await window.sb.from('feedback_votes').delete().eq('post_id', id).eq('user_id', user.id)
          : await window.sb.from('feedback_votes').insert({ post_id: id, user_id: user.id });
        if (res.error) throw res.error;
      } catch (e) {
        console.warn('[Huddle] toggleFeedbackVote failed:', e);
        // Reload from source of truth to undo the optimistic change.
        feedbackLoad();
      }
    }

    function openFeedbackPostMenu(id){
      feedbackMenuPostId = id;
      document.getElementById('fb-action-backdrop').classList.add('active');
    }

    // Friend kebab menu — same backdrop pattern as feedback. State lives in
    // friendMenuTarget so the destructive action below knows which friend to act on.
    let friendMenuTarget = null; // { id, name }
    function openFriendMenu(id, name){
      friendMenuTarget = { id, name };
      const header = document.getElementById('friend-menu-header');
      if (header) {
        const entry = friendsState.friends.find(e => e.otherId === id);
        const handle = entry && entry.profile && entry.profile.username ? '@' + entry.profile.username : '';
        header.innerHTML = `
          <div class="friend-menu-info">
            <div class="friend-menu-name">${friendsEscape(name || t('friends.thisFriend') || '')}</div>
            ${handle ? `<div class="friend-menu-handle">${friendsEscape(handle)}</div>` : ''}
          </div>
        `;
      }
      const bd = document.getElementById('friend-menu-backdrop');
      if (bd) bd.classList.add('active');
    }
    function dismissFriendMenu(){
      const bd = document.getElementById('friend-menu-backdrop');
      if (bd) bd.classList.remove('active');
      const target = friendMenuTarget;
      friendMenuTarget = null;
      return target;
    }
    function closeFriendMenu(ev){
      if (ev && ev.target && ev.target.id && ev.target.id !== 'friend-menu-backdrop') return;
      dismissFriendMenu();
    }
    function removeFriendFromMenu(){
      const target = dismissFriendMenu();
      if (!target) return;
      // friendRemove already shows its own huddleConfirm — that's the safety net for
      // a destructive action, so we don't double-confirm here. Sheet → confirm → done.
      friendRemove(target.id, target.name);
    }
    // Dismiss the action sheet and return the id it referred to. All exits
    // (backdrop tap, Edit, Delete) flow through here so the id never lingers.
    function dismissFeedbackPostMenu(){
      const id = feedbackMenuPostId;
      document.getElementById('fb-action-backdrop').classList.remove('active');
      feedbackMenuPostId = null;
      return id;
    }
    function closeFeedbackPostMenu(ev){
      if (ev && ev.target && ev.target.id && ev.target.id !== 'fb-action-backdrop') return;
      dismissFeedbackPostMenu();
    }
    function editFeedbackPostFromMenu(){
      const id = dismissFeedbackPostMenu();
      if (!id) return;
      const p = feedbackState.posts.find(x => x.id === id);
      if (!p) return;
      openComposeFeedback(p.category, p);
    }
    async function deleteFeedbackPostFromMenu(){
      const id = dismissFeedbackPostMenu();
      if (!id) return;
      const ok = await huddleConfirm({
        title: t('feedback.board.deleteTitle'),
        body: t('feedback.board.deleteBody'),
        confirmLabel: t('feedback.board.delete'),
        cancelLabel: t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      try {
        const { error } = await window.sb.from('feedback_posts').delete().eq('id', id);
        if (error) throw error;
        clearTranslationsForPost(id);
        fbShowOriginal.delete(id);
        feedbackLoad();
      } catch (e) {
        console.warn('[Huddle] deleteFeedbackPostFromMenu failed:', e);
        alert(t('feedback.board.saveError'));
      }
    }

    function renderFeedbackBoard(){
      const tabsEl = document.getElementById('feedback-tabs');
      const listEl = document.getElementById('feedback-list');
      if (!tabsEl || !listEl) return;

      const posts = feedbackState.posts;
      const counts = FB_CATS.reduce((acc,c) => (acc[c] = posts.filter(p => p.category === c).length, acc), {});

      tabsEl.innerHTML = FB_CATS.map(c => `
        <button class="feedback-tab${feedbackBoardTab === c ? ' active' : ''}" onclick="setFeedbackTab('${c}')">
          ${fbIcon(c)}
          <span>${t('feedback.board.tab.' + c)}</span>
          ${counts[c] > 0 ? `<span class="count">${counts[c]}</span>` : ''}
        </button>
      `).join('');

      // Persistent description below the tabs — so users always know what
      // each category is for, not just when the section is empty.
      const descEl = document.getElementById('feedback-board-desc');
      if (descEl) descEl.textContent = t('feedback.board.desc_' + feedbackBoardTab);

      // Loading state on first fetch only — subsequent realtime refreshes are
      // silent so the UI doesn't flicker every time someone votes.
      if (feedbackState.loading && !feedbackState.loaded){
        listEl.innerHTML = `
          <div class="feedback-empty">
            <div class="fb-translate-hint"><span class="fb-translate-dot"></span>${t('feedback.board.loading')}</div>
          </div>`;
        return;
      }

      if (feedbackState.error){
        listEl.innerHTML = `
          <div class="feedback-empty">
            <div class="feedback-empty-emoji">⚠️</div>
            <div class="feedback-empty-title">${t('feedback.board.errorTitle')}</div>
            <div style="font-size:13px;margin-bottom:14px">${escapeHTML(feedbackState.error)}</div>
            <button class="btn btn-outline btn-sm" onclick="feedbackLoad()">${t('feedback.board.retry')}</button>
          </div>`;
        return;
      }

      const voteCount = (id) => feedbackState.voteCounts[id] || 0;
      const iVoted    = (id) => feedbackState.myVotes.has(id);

      // Most-hearted first; created_at is the recency tiebreaker so newest
      // posts at the same vote count win.
      const filtered = posts
        .filter(p => p.category === feedbackBoardTab)
        .slice()
        .sort((a, b) => {
          const dv = voteCount(b.id) - voteCount(a.id);
          if (dv !== 0) return dv;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });

      if (filtered.length === 0) {
        listEl.innerHTML = `
          <div class="feedback-empty">
            <div class="feedback-empty-emoji">${fbEmoji(feedbackBoardTab)}</div>
            <div class="feedback-empty-title">${t('feedback.board.empty_' + feedbackBoardTab)}</div>
            <div style="font-size:13px;margin-bottom:14px">${t('feedback.board.emptySub')}</div>
            <button class="btn btn-outline btn-sm" onclick="openComposeFeedback('${feedbackBoardTab}')">${t('feedback.board.firstPost')}</button>
          </div>
        `;
        return;
      }

      const topVotes = voteCount(filtered[0].id);
      const currentLang = getLang();
      const tCache = loadFbTranslations();

      listEl.innerHTML = filtered.map(p => {
        const votes = voteCount(p.id);
        const voted = iVoted(p.id);
        const isTop = votes > 0 && votes === topVotes;
        const isMine = p.user_id === feedbackState.me;
        const likeAria = t(voted ? 'feedback.board.unlikeAria' : 'feedback.board.likeAria');
        const view = fbResolveBodyView(p, currentLang, tCache);
        let translateRow = '';
        if (view.action){
          if (view.action.kind === 'loading'){
            translateRow = `<div class="fb-translate-row"><span class="fb-translate-hint"><span class="fb-translate-dot"></span>${t('feedback.board.translating')}</span></div>`;
          } else if (view.action.kind === 'error'){
            translateRow = `<div class="fb-translate-row"><span class="fb-translate-hint fb-error">${t('feedback.board.translateError')}</span><button class="fb-translate-link" onclick="fbRetryTranslation('${p.id}')">${t('feedback.board.translateRetry')}</button></div>`;
          } else {
            const labelKey = view.action.kind === 'showOriginal' ? 'feedback.board.showOriginal' : 'feedback.board.showTranslation';
            translateRow = `<div class="fb-translate-row"><button class="fb-translate-link" onclick="fbToggleOriginal('${p.id}')">${t(labelKey)}</button></div>`;
          }
        }
        const overflowBtn = isMine
          ? `<button class="fb-overflow" onclick="openFeedbackPostMenu('${p.id}')" aria-label="${t('feedback.board.moreAria')}">${FB_DOTS_ICON}</button>`
          : '';
        const created = new Date(p.created_at).getTime();
        return `
        <div class="feedback-post${isTop ? ' is-top' : ''}">
          <div class="feedback-post-text">${escapeHTML(view.text)}</div>
          ${translateRow}
          <div class="feedback-post-footer">
            <div class="feedback-post-meta">
              <span>${formatRelativeTime(created)}</span>
              <span class="dot"></span>
              <span class="lang-tag">${(p.lang || 'en').toUpperCase()}</span>
              ${p.edited ? `<span class="dot"></span><span class="edited-tag">${t('feedback.board.edited')}</span>` : ''}
            </div>
            <div class="feedback-post-actions">
              <button class="fb-vote${voted ? ' voted' : ''}" onclick="toggleFeedbackVote('${p.id}')" aria-label="${likeAria}" aria-pressed="${voted ? 'true' : 'false'}">
                ${FB_HEART_ICON}<span>${votes}</span>
              </button>
              ${overflowBtn}
            </div>
          </div>
        </div>`;
      }).join('');
    }

    function setFeedbackTab(tab){
      feedbackBoardTab = tab;
      renderFeedbackBoard();
    }

    // ============================================================
    // ADMIN — Feedback moderation
    // ============================================================
    // Separate state object from feedbackState — public board and admin view
    // intentionally don't share state so neither can corrupt the other. Reads
    // and writes go through Supabase RLS: every UPDATE/DELETE here is allowed
    // only because is_admin() returns true for the current user (see
    // huddle_c2_feedback_admin.sql). If a non-admin somehow calls these
    // functions, Postgres rejects the write — the UI flag is just for UX.

    const adminFeedbackState = {
      posts: [],
      profilesById: Object.create(null),
      voteCounts: Object.create(null),
      counts: { all: 0, new: 0, done: 0 },
      loading: false,
      loaded: false,
      error: null,
      filter: 'new',   // 'new' | 'all' | 'done'
      sort: 'newest',  // 'newest' | 'top'
    };
    let adminFbMenuPostId = null;
    let _adminFbChannel = null;

    // ---------- Badge on the admin → Feedback tile ----------
    // Cheap count query (HEAD + count:exact). Refreshed on profile open,
    // on admin panel open, and after any mutation.
    async function adminRefreshFeedbackBadge(){
      const el = document.getElementById('admin-tile-feedback-badge');
      if (!el) return;
      if (!huddleIsAdmin || !window.sb){ el.hidden = true; el.removeAttribute('aria-busy'); return; }
      // Signal "fetching" to screen readers (and any future automated tests)
      // via aria-busy. We intentionally do NOT show a "…" or spinner — best
      // practice for a tiny aggregate-count badge is silent update so the
      // user never sees a misleading 0 or transient placeholder. The badge
      // stays hidden until real data lands; if count is zero it stays hidden.
      el.setAttribute('aria-busy', 'true');
      try{
        const { count, error } = await window.sb
          .from('feedback_posts')
          .select('id', { count:'exact', head:true })
          .eq('status','new');
        if (error) throw error;
        if (count && count > 0){
          el.textContent = count + ' ' + t('adminFb.badgeNew');
          el.hidden = false;
        } else {
          el.hidden = true;
        }
      } catch(e){
        // Silent: badge is optional. Real errors surface in adminFeedbackLoad.
        el.hidden = true;
      } finally {
        el.removeAttribute('aria-busy');
      }
    }

    // ---------- Load posts + author profiles + vote counts ----------
    async function adminFeedbackLoad(forceSpin){
      if (!window.sb) return;
      if (!huddleIsAdmin){
        adminFeedbackState.error = 'Not authorised';
        renderAdminFeedback();
        return;
      }
      adminFeedbackState.loading = true;
      if (forceSpin) renderAdminFeedback();
      try{
        const [postsRes, votesRes] = await Promise.all([
          window.sb.from('feedback_posts')
            .select('id, user_id, category, text, lang, edited, status, admin_actioned_at, created_at')
            .order('created_at', { ascending: false }),
          window.sb.from('feedback_votes').select('post_id'),
        ]);
        if (postsRes.error) throw postsRes.error;
        if (votesRes.error) throw votesRes.error;
        const posts = postsRes.data || [];
        adminFeedbackState.posts = posts;

        // Vote counts (post_id -> integer)
        const vc = Object.create(null);
        (votesRes.data || []).forEach(v => { vc[v.post_id] = (vc[v.post_id] || 0) + 1; });
        adminFeedbackState.voteCounts = vc;

        // Author profiles — single batch lookup. Anonymous posters won't have
        // a profile row; the render falls back to "Guest <id-prefix>".
        const ids = Array.from(new Set(posts.map(p => p.user_id))).filter(Boolean);
        if (ids.length){
          const { data: profs, error: prErr } = await window.sb
            .from('profiles')
            .select('user_id, username, display_name, avatar')
            .in('user_id', ids);
          if (prErr) throw prErr;
          const map = Object.create(null);
          (profs || []).forEach(p => { map[p.user_id] = p; });
          adminFeedbackState.profilesById = map;
        } else {
          adminFeedbackState.profilesById = Object.create(null);
        }

        adminFbRecomputeCounts();
        adminFeedbackState.error = null;
        adminFeedbackState.loaded = true;
      } catch(e){
        adminFeedbackState.error = (e && e.message) || String(e);
        console.warn('[Huddle] adminFeedbackLoad failed:', e);
      } finally {
        adminFeedbackState.loading = false;
        renderAdminFeedback();
        adminRefreshFeedbackBadge();
        adminFbWireSync();
      }
    }

    function adminFbRecomputeCounts(){
      const posts = adminFeedbackState.posts;
      adminFeedbackState.counts = {
        all: posts.length,
        new: posts.filter(p => p.status === 'new').length,
        done: posts.filter(p => p.status === 'done').length,
      };
    }

    // ---------- Mutations (RLS enforces is_admin() server-side) ----------
    async function adminFbSetStatus(id, status){
      if (!huddleIsAdmin || !window.sb) return;
      // Optimistic update so the UI snaps. On failure we reload truth.
      const post = adminFeedbackState.posts.find(p => p.id === id);
      const previous = post ? post.status : null;
      if (post) post.status = status;
      adminFbRecomputeCounts();
      renderAdminFeedback();
      adminRefreshFeedbackBadge();
      try{
        const update = {
          status,
          admin_actioned_at: status === 'done' ? new Date().toISOString() : null,
        };
        const { error } = await window.sb.from('feedback_posts').update(update).eq('id', id);
        if (error) throw error;
      } catch(e){
        console.warn('[Huddle] adminFbSetStatus failed:', e);
        // Roll back optimistic change
        if (post && previous != null) post.status = previous;
        adminFbRecomputeCounts();
        renderAdminFeedback();
        alert(t('adminFb.actionError'));
      }
    }

    async function adminFbDelete(id){
      if (!huddleIsAdmin || !window.sb) return;
      const ok = await huddleConfirm({
        title: t('adminFb.deleteTitle'),
        body: t('adminFb.deleteBody'),
        confirmLabel: t('feedback.board.delete'),
        cancelLabel: t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      try{
        const { error } = await window.sb.from('feedback_posts').delete().eq('id', id);
        if (error) throw error;
        adminFeedbackState.posts = adminFeedbackState.posts.filter(p => p.id !== id);
        delete adminFeedbackState.voteCounts[id];
        adminFbRecomputeCounts();
        renderAdminFeedback();
        adminRefreshFeedbackBadge();
      } catch(e){
        console.warn('[Huddle] adminFbDelete failed:', e);
        alert(t('adminFb.actionError'));
      }
    }

    // ---------- Overflow menu (mirrors public board's openFeedbackPostMenu) ----------
    function openAdminFbMenu(id){
      adminFbMenuPostId = id;
      const post = adminFeedbackState.posts.find(p => p.id === id);
      const lbl = document.getElementById('admin-fb-menu-toggle-label');
      if (lbl && post){
        lbl.textContent = post.status === 'done'
          ? t('adminFb.menuMarkNew')
          : t('adminFb.menuMarkDone');
      }
      const bd = document.getElementById('admin-fb-menu-backdrop');
      if (bd) bd.classList.add('active');
    }
    function dismissAdminFbMenu(){
      const bd = document.getElementById('admin-fb-menu-backdrop');
      if (bd) bd.classList.remove('active');
      const id = adminFbMenuPostId;
      adminFbMenuPostId = null;
      return id;
    }
    function closeAdminFbMenu(ev){
      if (ev && ev.target && ev.target.id && ev.target.id !== 'admin-fb-menu-backdrop') return;
      dismissAdminFbMenu();
    }
    function adminFbToggleStatusFromMenu(){
      const id = dismissAdminFbMenu();
      if (!id) return;
      const post = adminFeedbackState.posts.find(p => p.id === id);
      if (!post) return;
      adminFbSetStatus(id, post.status === 'done' ? 'new' : 'done');
    }
    function adminFbDeleteFromMenu(){
      const id = dismissAdminFbMenu();
      if (!id) return;
      adminFbDelete(id);
    }

    // ---------- Filter + sort ----------
    function adminFbSetFilter(f){
      if (f !== 'all' && f !== 'new' && f !== 'done') return;
      adminFeedbackState.filter = f;
      renderAdminFeedback();
    }
    function adminFbToggleSort(){
      adminFeedbackState.sort = adminFeedbackState.sort === 'newest' ? 'top' : 'newest';
      renderAdminFeedback();
    }

    // Phase 3: zero-arg wrappers so the header/retry "refresh" buttons can use
    // data-action delegation (which passes no runtime args). They preserve the
    // exact original calls: adminFeedbackLoad(true) and adminStatsLoad(period, true).
    function adminFeedbackRefresh(){ adminFeedbackLoad(true); }
    function adminStatsRefresh(){ adminStatsLoad(adminStatsState.period, true); }

    // ---------- Realtime — any change to feedback_posts reloads truth ----------
    function adminFbUnwireSync(){
      try { if (_adminFbChannel && window.sb) window.sb.removeChannel(_adminFbChannel); } catch(e){}
      _adminFbChannel = null;
    }
    function adminFbWireSync(){
      if (!huddleIsAdmin || !window.sb) return;
      if (_adminFbChannel) return;
      try{
        _adminFbChannel = window.sb
          .channel('admin_feedback_board')
          .on('postgres_changes', { event:'*', schema:'public', table:'feedback_posts' }, () => adminFeedbackLoad())
          .on('postgres_changes', { event:'*', schema:'public', table:'feedback_votes' }, () => adminFeedbackLoad())
          .subscribe();
      } catch(e){
        console.warn('[Huddle] adminFbWireSync failed:', e);
      }
    }

    // ---------- Render ----------
    function renderAdminFeedback(){
      const chipsEl = document.getElementById('admin-fb-chips');
      const listEl = document.getElementById('admin-fb-list');
      const sortLbl = document.getElementById('admin-fb-sort-label');
      if (!chipsEl || !listEl) return;

      if (sortLbl){
        sortLbl.textContent = t(adminFeedbackState.sort === 'newest' ? 'adminFb.sortNewest' : 'adminFb.sortTop');
      }

      const c = adminFeedbackState.counts;
      const filter = adminFeedbackState.filter;
      const filters = [
        { key:'new',  label:t('adminFb.filterNew'),  count:c.new  },
        { key:'all',  label:t('adminFb.filterAll'),  count:c.all  },
        { key:'done', label:t('adminFb.filterDone'), count:c.done },
      ];
      chipsEl.innerHTML = filters.map(f => `
        <button class="admin-fb-chip${filter === f.key ? ' active' : ''}" data-action="adminFbSetFilter" data-arg="${f.key}">
          <span>${escapeHTML(f.label)}</span>
          ${f.count > 0 ? `<span class="count">${f.count}</span>` : ''}
        </button>
      `).join('');

      if (adminFeedbackState.loading && !adminFeedbackState.loaded){
        listEl.innerHTML = `
          <div class="admin-fb-empty">
            <div class="fb-translate-hint"><span class="fb-translate-dot"></span>${t('feedback.board.loading')}</div>
          </div>`;
        return;
      }
      if (adminFeedbackState.error){
        listEl.innerHTML = `
          <div class="admin-fb-empty">
            <div class="admin-fb-empty-emoji">⚠️</div>
            <div class="admin-fb-empty-title">${t('feedback.board.errorTitle')}</div>
            <div style="font-size:13px;margin-bottom:14px">${escapeHTML(adminFeedbackState.error)}</div>
            <button class="btn btn-outline btn-sm" data-action="adminFeedbackRefresh">${t('feedback.board.retry')}</button>
          </div>`;
        return;
      }

      let posts = adminFeedbackState.posts;
      if (filter === 'new')  posts = posts.filter(p => p.status === 'new');
      if (filter === 'done') posts = posts.filter(p => p.status === 'done');

      if (adminFeedbackState.sort === 'top'){
        posts = posts.slice().sort((a,b) => {
          const dv = (adminFeedbackState.voteCounts[b.id]||0) - (adminFeedbackState.voteCounts[a.id]||0);
          if (dv !== 0) return dv;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
      }
      // 'newest' uses the SQL ORDER BY (already created_at desc).

      if (!posts.length){
        listEl.innerHTML = `
          <div class="admin-fb-empty">
            <div class="admin-fb-empty-emoji">${filter === 'done' ? '✓' : (filter === 'new' ? '📭' : '🗂️')}</div>
            <div class="admin-fb-empty-title">${t('adminFb.empty_' + filter)}</div>
          </div>`;
        return;
      }

      listEl.innerHTML = posts.map(p => {
        const prof = adminFeedbackState.profilesById[p.user_id];
        const hasProf = !!prof;
        const name = hasProf
          ? (prof.display_name || prof.username || t('adminFb.unknownUser'))
          : (t('adminFb.guest') + ' ' + (p.user_id || '').slice(0, 4));
        const handle = (hasProf && prof.username) ? '@' + prof.username : '';
        const avatar = (hasProf && prof.avatar)
          ? avatarHTML(prof.avatar, 32, { fallback: (name || '?')[0] })
          : `<div class="admin-fb-avatar">${escapeHTML((name || '?').slice(0,1).toUpperCase())}</div>`;
        const cat = (p.category || '').toUpperCase();
        const status = p.status === 'done' ? 'done' : 'new';
        const created = new Date(p.created_at).getTime();
        const votes = adminFeedbackState.voteCounts[p.id] || 0;
        return `
          <div class="admin-fb-row${status === 'done' ? ' is-done' : ''}">
            <div class="admin-fb-row-top">
              <div class="admin-fb-author">
                ${avatar}
                <div style="min-width:0;flex:1">
                  <div class="admin-fb-author-name">${escapeHTML(name)}</div>
                  ${handle ? `<div class="admin-fb-author-handle">${escapeHTML(handle)}</div>` : ''}
                </div>
              </div>
              <div class="admin-fb-row-meta">
                <span class="admin-fb-cat">${fbIcon(p.category)}<span>${escapeHTML(cat)}</span></span>
              </div>
            </div>
            <div class="admin-fb-text">${escapeHTML(p.text)}</div>
            <div class="admin-fb-row-footer">
              <div class="admin-fb-footer-left">
                <span>♥ ${votes}</span>
                <span class="dot"></span>
                <span>${formatRelativeTime(created)}</span>
                <span class="dot"></span>
                <span>${escapeHTML((p.lang || 'en').toUpperCase())}</span>
                ${p.edited ? `<span class="dot"></span><span>${t('feedback.board.edited')}</span>` : ''}
                <span class="dot"></span>
                <span class="admin-fb-status admin-fb-status-${status}">${t('adminFb.status_' + status)}</span>
              </div>
              <button class="admin-fb-overflow" data-action="openAdminFbMenu" data-arg="${p.id}" aria-label="${t('feedback.board.moreAria')}">${FB_DOTS_ICON}</button>
            </div>
          </div>
        `;
      }).join('');
      parseEmoji(listEl);
    }

    // ============================================================
    // ADMIN — Stats dashboard
    // ============================================================
    // Single RPC `public.admin_stats(p_period)` returns JSONB with current,
    // previous, and 7-point trend for every metric. The function gates on
    // is_admin() server-side — non-admins get a SQL error before any
    // computation. Period selector swaps the RPC arg; everything re-renders.

    const adminStatsState = {
      period: '7d',        // '24h' | '7d' | '30d'
      data: null,          // last successful RPC payload
      loading: false,
      error: null,
    };

    async function adminStatsLoad(period, forceSpin){
      if (!window.sb) return;
      if (!huddleIsAdmin){
        adminStatsState.error = 'Not authorised';
        renderAdminStats();
        return;
      }
      adminStatsState.period = period || adminStatsState.period;
      adminStatsState.loading = true;
      if (forceSpin) renderAdminStats();
      try{
        const { data, error } = await window.sb.rpc('admin_stats', { p_period: adminStatsState.period });
        if (error) throw error;
        adminStatsState.data = data;
        adminStatsState.error = null;
      } catch(e){
        adminStatsState.error = (e && e.message) || String(e);
        console.warn('[Huddle] adminStatsLoad failed:', e);
      } finally {
        adminStatsState.loading = false;
        renderAdminStats();
      }
    }

    function adminStatsSetPeriod(period){
      if (period !== '24h' && period !== '7d' && period !== '30d' && period !== 'all') return;
      if (adminStatsState.period === period) return;
      adminStatsState.period = period;
      adminStatsLoad(period, true);
    }

    // ---------- Delta formatting ----------
    // Returns { label, dirClass } based on current vs previous.
    // For period='all' there is no previous — show "All time" instead of
    // a meaningless 100%+ delta.
    function adminStatsDelta(current, previous){
      if (adminStatsState.period === 'all') {
        return { label: t('adminStats.deltaAllTime'), dirClass: 'admin-stats-delta-flat' };
      }
      const cur = Number(current) || 0;
      const prev = Number(previous) || 0;
      if (prev === 0 && cur === 0) return { label: t('adminStats.deltaNoChange'), dirClass: 'admin-stats-delta-flat' };
      if (prev === 0)              return { label: '+' + cur + ' ' + t('adminStats.deltaVsPrev'), dirClass: 'admin-stats-delta-up' };
      const pct = Math.round(((cur - prev) / prev) * 100);
      if (pct === 0)  return { label: t('adminStats.deltaNoChange'), dirClass: 'admin-stats-delta-flat' };
      const sign = pct > 0 ? '+' : '';
      const dir  = pct > 0 ? 'admin-stats-delta-up' : 'admin-stats-delta-down';
      return { label: sign + pct + '% ' + t('adminStats.deltaVsPrev'), dirClass: dir };
    }

    // ---------- Inline SVG sparkline (DOM-friendly, no library) ----------
    // Direction-only, no axes/labels — its only job is "line going up/down".
    // Uses a virtual coordinate space (100×H) + preserveAspectRatio="none" so
    // the SVG stretches to whatever width its container is; vector-effect=
    // "non-scaling-stroke" keeps the line crisp at 1.25px regardless of scale.
    function adminStatsSparkline(trendArr, h){
      h = h || 24;
      const W = 100;
      const arr = (Array.isArray(trendArr) && trendArr.length) ? trendArr : [0];
      const max = Math.max(...arr, 1);
      const min = Math.min(...arr, 0);
      const range = (max - min) || 1;
      const padY = 2;                                          // breathing room
      const usableH = h - padY * 2;
      const stepX = arr.length > 1 ? W / (arr.length - 1) : 0;
      const points = arr.map((v, i) => {
        const x = i * stepX;
        const y = padY + (usableH - ((v - min) / range) * usableH);
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      return `<svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="${points}" vector-effect="non-scaling-stroke"/></svg>`;
    }

    // ---------- Relative time for "Updated 5 min ago" footer ----------
    function adminStatsRelTime(iso){
      if (!iso) return '';
      const then = new Date(iso).getTime();
      const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
      if (sec < 60)      return t('adminStats.justNow');
      if (sec < 3600)    return Math.floor(sec / 60) + 'm ' + t('adminStats.ago');
      if (sec < 86400)   return Math.floor(sec / 3600) + 'h ' + t('adminStats.ago');
      return Math.floor(sec / 86400) + 'd ' + t('adminStats.ago');
    }

    // ---------- Game labels ----------
    const ADMIN_STATS_GAMES = ['hotseat','chameleon','liar','mafia'];
    function adminStatsGameLabel(key){
      switch(key){
        case 'hotseat':   return t('adminStats.game.hotseat');
        case 'chameleon': return t('adminStats.game.chameleon');
        case 'liar':      return t('adminStats.game.liar');
        case 'mafia':     return t('adminStats.game.mafia');
        default: return key;
      }
    }

    // ---------- Render ----------
    function renderAdminStats(){
      const heroEl  = document.getElementById('admin-stats-hero');
      const gridEl  = document.getElementById('admin-stats-grid');
      const bdEl    = document.getElementById('admin-stats-breakdown');
      const footEl  = document.getElementById('admin-stats-footer');
      if (!heroEl || !gridEl || !bdEl || !footEl) return;

      // Period selector active state
      document.querySelectorAll('.admin-stats-period-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === adminStatsState.period);
      });

      // Loading
      if (adminStatsState.loading && !adminStatsState.data){
        heroEl.innerHTML = `<div class="admin-stats-loading">${escapeHTML(t('adminStats.loading'))}</div>`;
        gridEl.innerHTML = '';
        bdEl.innerHTML = '';
        footEl.innerHTML = '';
        return;
      }

      // Error
      if (adminStatsState.error && !adminStatsState.data){
        heroEl.innerHTML = `
          <div class="admin-stats-error">
            <div style="font-weight:700;margin-bottom:6px">${escapeHTML(t('adminStats.errorTitle'))}</div>
            <div>${escapeHTML(adminStatsState.error)}</div>
          </div>
          <button class="btn btn-outline btn-sm" data-action="adminStatsRefresh">${escapeHTML(t('feedback.board.retry'))}</button>
        `;
        gridEl.innerHTML = '';
        bdEl.innerHTML = '';
        footEl.innerHTML = '';
        return;
      }

      const d = adminStatsState.data;
      if (!d) return;

      // Hero — Active players
      const heroDelta = adminStatsDelta(d.active_players.current, d.active_players.previous);
      heroEl.setAttribute('role', 'button');
      heroEl.setAttribute('tabindex', '0');
      heroEl.onclick = () => openAdminStatsDetail('active_players');
      heroEl.innerHTML = `
        <div class="admin-stats-hero-body">
          <div class="admin-stats-hero-label">${escapeHTML(t('adminStats.heroLabel'))}</div>
          <div class="admin-stats-hero-value">${d.active_players.current}</div>
          <div class="admin-stats-hero-delta ${heroDelta.dirClass}">${escapeHTML(heroDelta.label)}</div>
        </div>
        <div class="admin-stats-hero-sparkline">${adminStatsSparkline(d.active_players.trend, 48)}</div>
      `;

      // 4 secondary cards
      const cards = [
        { key:'signups',      data: d.signups,      label: t('adminStats.signups'),     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>' },
        { key:'lobbies',      data: d.lobbies,      label: t('adminStats.lobbies'),     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9 12 2l9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
        { key:'games_played', data: d.games_played, label: t('adminStats.gamesPlayed'), icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>' },
        { key:'feedback',     data: d.feedback,     label: t('adminStats.feedback'),    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
      ];
      gridEl.innerHTML = cards.map(c => {
        const dlt = adminStatsDelta(c.data.current, c.data.previous);
        return `
          <div class="admin-stats-card" role="button" tabindex="0" data-action="openAdminStatsDetail" data-arg="${c.key}">
            <div class="admin-stats-card-body">
              <div class="admin-stats-card-top">${c.icon}<span>${escapeHTML(c.label)}</span></div>
              <div class="admin-stats-card-value">${c.data.current}</div>
              <div class="admin-stats-card-delta ${dlt.dirClass}">${escapeHTML(dlt.label)}</div>
            </div>
            <div class="admin-stats-card-spark">${adminStatsSparkline(c.data.trend, 28)}</div>
          </div>
        `;
      }).join('');

      // By-game breakdown (share-of-total bars)
      const byGame = d.by_game || {};
      const total = ADMIN_STATS_GAMES.reduce((sum,k) => sum + (Number(byGame[k]) || 0), 0);
      const rows = ADMIN_STATS_GAMES.map(k => {
        const count = Number(byGame[k]) || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return `
          <div class="admin-stats-bd-row">
            <div class="admin-stats-bd-name">${escapeHTML(adminStatsGameLabel(k))}</div>
            <div class="admin-stats-bd-bar"><div class="admin-stats-bd-bar-fill" style="width:${pct}%"></div></div>
            <div class="admin-stats-bd-count">${count}</div>
          </div>
        `;
      }).join('');
      bdEl.innerHTML = `
        <div class="admin-stats-breakdown-title">${escapeHTML(t('adminStats.byGameTitle'))}</div>
        ${rows}
        ${total === 0 ? `<div style="font-size:12.5px;color:var(--text-tertiary);text-align:center;padding:8px 0 4px">${escapeHTML(t('adminStats.byGameEmpty'))}</div>` : ''}
      `;

      // Footer
      footEl.innerHTML = `${escapeHTML(t('adminStats.updated'))} ${escapeHTML(adminStatsRelTime(d.generated_at))}`;
    }

    // ---------- Detail sheet (tap a card → expanded chart) ----------
    // State lives in adminStatsDetailKey; the sheet shows the metric matching
    // that key, sourced from adminStatsState.data (no extra RPC needed).
    let adminStatsDetailKey = null;

    // Resolves the metric label for the detail sheet header.
    function adminStatsMetricLabel(key){
      switch(key){
        case 'active_players': return t('adminStats.heroLabel');
        case 'signups':        return t('adminStats.signups');
        case 'lobbies':        return t('adminStats.lobbies');
        case 'games_played':   return t('adminStats.gamesPlayed');
        case 'feedback':       return t('adminStats.feedback');
        default: return key;
      }
    }

    // Computes 3 X-axis labels (start / middle / now) given the active
    // period. For 'all' it falls back to "earliest" / "midpoint" / "now"
    // since the data span varies.
    function adminStatsAxisLabels(period){
      const now = t('adminStats.axisNow');
      switch(period){
        case '24h': return [ '24h ' + t('adminStats.ago'), '12h ' + t('adminStats.ago'), now ];
        case '7d':  return [ '7d ' + t('adminStats.ago'),  '3d ' + t('adminStats.ago'),  now ];
        case '30d': return [ '30d ' + t('adminStats.ago'), '15d ' + t('adminStats.ago'), now ];
        case 'all': return [ t('adminStats.axisEarliest'), t('adminStats.axisMid'), now ];
        default:    return [ '', '', now ];
      }
    }

    // Big inline-SVG chart — uses the same trend array as the sparkline but
    // adds area fill, 3 gridlines (0 / mid / max), Y-axis labels rendered
    // inside the SVG as proper <text> elements, and dots at each data point.
    //
    // Coordinate system is REAL (360 × 240 px) with `preserveAspectRatio`
    // defaulting to `xMidYMid meet` — the SVG scales proportionally to its
    // container without distorting circles or stretching text. This fixes
    // the ellipsoid-dots bug from the earlier `preserveAspectRatio="none"`.
    function adminStatsBigChart(trendArr){
      const arr = (Array.isArray(trendArr) && trendArr.length) ? trendArr : [0];
      const W = 360, H = 240;
      const padL = 40;   // left padding for Y-axis labels
      const padR = 12;
      const padT = 18;
      const padB = 18;
      const innerW = W - padL - padR;
      const innerH = H - padT - padB;

      const max = Math.max(...arr, 1);
      const min = 0;                         // always anchor at zero — accurate read
      const range = (max - min) || 1;
      const midVal = Math.round(max / 2);
      const stepX = arr.length > 1 ? innerW / (arr.length - 1) : 0;

      const yFor = v => padT + (innerH - ((v - min) / range) * innerH);
      const points = arr.map((v, i) => ({
        x: padL + i * stepX,
        y: yFor(v),
        v
      }));

      // Line path
      const lineD = points.map((p, i) =>
        (i === 0 ? 'M' : 'L') + p.x.toFixed(2) + ',' + p.y.toFixed(2)
      ).join(' ');
      // Area path = line, then drop to baseline, then close
      const baseline = padT + innerH;
      const areaD = lineD
        + ' L' + points[points.length - 1].x.toFixed(2) + ',' + baseline
        + ' L' + points[0].x.toFixed(2) + ',' + baseline + ' Z';

      // Three gridlines: 0, mid, max
      const gridYs = [
        { y: yFor(max),   label: String(max)   },
        { y: yFor(midVal), label: String(midVal) },
        { y: yFor(0),     label: '0'           }
      ];
      const grid = gridYs.map(g =>
        `<line class="grid-line" x1="${padL}" y1="${g.y.toFixed(2)}" x2="${W - padR}" y2="${g.y.toFixed(2)}"/>`
      ).join('');
      const yLabels = gridYs.map(g =>
        `<text class="y-label" x="${padL - 8}" y="${g.y.toFixed(2)}" text-anchor="end" dominant-baseline="middle">${g.label}</text>`
      ).join('');

      // Dots — donut style (surface fill + accent stroke)
      const dots = points.map(p =>
        `<circle class="dot" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="3.5"/>`
      ).join('');

      return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">
        ${grid}
        ${yLabels}
        <path class="area" d="${areaD}"/>
        <path class="line" d="${lineD}"/>
        ${dots}
      </svg>`;
    }

    // ---------- Summary stats (avg / peak / low) ----------
    function adminStatsSummary(trendArr){
      const arr = (Array.isArray(trendArr) && trendArr.length) ? trendArr : [0];
      const sum = arr.reduce((s, v) => s + (Number(v) || 0), 0);
      const avg = arr.length ? sum / arr.length : 0;
      return {
        avg:  Math.round(avg * 10) / 10,
        peak: Math.max(...arr, 0),
        low:  Math.min(...arr, 0),
      };
    }

    function openAdminStatsDetail(key){
      if (!adminStatsState.data) return;
      const metric = adminStatsState.data[key];
      if (!metric) return;
      adminStatsDetailKey = key;

      const labelEl   = document.getElementById('admin-stats-detail-label');
      const valEl     = document.getElementById('admin-stats-detail-value');
      const deltaEl   = document.getElementById('admin-stats-detail-delta');
      const chartEl   = document.getElementById('admin-stats-detail-chart');
      const axisEl    = document.getElementById('admin-stats-detail-axis');
      const summaryEl = document.getElementById('admin-stats-detail-summary');

      const dlt = adminStatsDelta(metric.current, metric.previous);
      if (labelEl) labelEl.textContent = adminStatsMetricLabel(key);
      if (valEl)   valEl.textContent   = metric.current;
      if (deltaEl) {
        deltaEl.className = 'admin-stats-detail-delta ' + dlt.dirClass;
        deltaEl.textContent = dlt.label;
      }
      if (chartEl) chartEl.innerHTML = adminStatsBigChart(metric.trend);
      if (axisEl){
        const labels = adminStatsAxisLabels(adminStatsState.period);
        axisEl.innerHTML = labels.map(l => `<span>${escapeHTML(l)}</span>`).join('');
      }
      if (summaryEl){
        const s = adminStatsSummary(metric.trend);
        summaryEl.innerHTML = `
          <div class="admin-stats-detail-summary-cell">
            <div class="admin-stats-detail-summary-label">${escapeHTML(t('adminStats.summaryAvg'))}</div>
            <div class="admin-stats-detail-summary-value">${s.avg}</div>
          </div>
          <div class="admin-stats-detail-summary-cell">
            <div class="admin-stats-detail-summary-label">${escapeHTML(t('adminStats.summaryPeak'))}</div>
            <div class="admin-stats-detail-summary-value">${s.peak}</div>
          </div>
          <div class="admin-stats-detail-summary-cell">
            <div class="admin-stats-detail-summary-label">${escapeHTML(t('adminStats.summaryLow'))}</div>
            <div class="admin-stats-detail-summary-value">${s.low}</div>
          </div>
        `;
      }
      const bd = document.getElementById('admin-stats-detail-backdrop');
      if (bd) bd.classList.add('active');
    }

    function closeAdminStatsDetail(ev){
      if (ev && ev.target && ev.target.id && ev.target.id !== 'admin-stats-detail-backdrop') return;
      const bd = document.getElementById('admin-stats-detail-backdrop');
      if (bd) bd.classList.remove('active');
      adminStatsDetailKey = null;
    }

    // ESC closes the sheet
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && adminStatsDetailKey !== null) closeAdminStatsDetail();
    });

