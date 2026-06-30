// Huddle app-03-profile-auth.js (fragment 3/10, split from app.js).
// All fragments share ONE global scope and MUST load in numeric order — do not reorder.

    // ---------- Twemoji integration ----------
    // After any avatar render, swap native emoji glyphs for Twemoji SVG.
    // No-ops if the Twemoji script hasn't loaded yet — emoji fall back to
    // native text. A DOMContentLoaded handler at the bottom re-parses the
    // whole document once Twemoji is guaranteed to be loaded.
    const TWEMOJI_OPTS = {
      folder: 'svg',
      ext: '.svg',
      base: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/',
    };
    function parseEmoji(el){
      if (!el || !window.twemoji) return;
      try { twemoji.parse(el, TWEMOJI_OPTS); } catch(e){}
    }

    // ---------- Sound effects (Web Audio synth — no asset files) ----------
    // Lightweight SFX engine for the Liar's Cup drinking sequence. Sounds are
    // synthesised on demand so the app stays a single self-contained HTML file.
    // Respects the user's mute preference (localStorage `huddle.sound.muted`)
    // and the OS-level `prefers-reduced-motion` hint (treated as a sound-off
    // signal too, since the people who avoid motion often avoid surprise audio).
    const SOUND_MUTED_KEY = 'huddle.sound.muted';
    let __sfxCtx = null;
    let __sfxSuspenseTimer = null;
    let __sfxRumble = null;   // { src, gain } for the sustained low-rumble pad used during the roulette spin
    function isSoundMuted(){
      try {
        if (localStorage.getItem(SOUND_MUTED_KEY) === '1') return true;
      } catch(e){}
      try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
      } catch(e){}
      return false;
    }
    function setSoundMuted(muted){
      try { localStorage.setItem(SOUND_MUTED_KEY, muted ? '1' : '0'); } catch(e){}
      if (muted) {
        // Stop the sustained loops + suspend the AudioContext so in-flight
        // one-shot oscillators (spillImpact tinkles, reverb tail, etc.) go
        // silent immediately instead of ringing out for up to 1.4s.
        sfxStopSuspense();
        sfxStopRumble();
        if (__sfxCtx && __sfxCtx.state === 'running') {
          try { __sfxCtx.suspend(); } catch(e){}
        }
      } else {
        // Resume so future sounds can play. sfxCtx() also handles this on
        // demand, but doing it eagerly here removes first-sound latency.
        if (__sfxCtx && __sfxCtx.state === 'suspended') {
          try { __sfxCtx.resume(); } catch(e){}
        }
      }
      // Re-render any visible sound toggle buttons so the icon flips.
      document.querySelectorAll('[data-sound-toggle]').forEach(updateSoundToggleIcon);
    }
    function toggleSound(){ setSoundMuted(!isSoundMuted()); }
    function updateSoundToggleIcon(btn){
      const muted = isSoundMuted();
      btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
      btn.setAttribute('aria-label', muted ? t('common.unmute') : t('common.mute'));
      btn.innerHTML = muted
        ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>'
        : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M19 5a8 8 0 0 1 0 14M16 9a4 4 0 0 1 0 6"/></svg>';
    }
    function sfxCtx(){
      if (isSoundMuted()) return null;
      if (!__sfxCtx) {
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          __sfxCtx = new AC();
        } catch(e){ return null; }
      }
      // Autoplay-policy: contexts can start suspended until user gesture.
      if (__sfxCtx.state === 'suspended') {
        try { __sfxCtx.resume(); } catch(e){}
      }
      return __sfxCtx;
    }
    // Internal: schedule a single sine tone with envelope.
    function sfxTone(freq, dur, opts){
      const ctx = sfxCtx(); if (!ctx) return;
      opts = opts || {};
      const t0 = ctx.currentTime + (opts.delay || 0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = opts.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (opts.freqTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqTo), t0 + dur);
      const peak = opts.gain != null ? opts.gain : 0.18;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    }
    // Internal: short burst of filtered white noise (for splash / fizz).
    function sfxNoise(dur, opts){
      const ctx = sfxCtx(); if (!ctx) return;
      opts = opts || {};
      const t0 = ctx.currentTime + (opts.delay || 0);
      const bufSize = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = opts.filterType || 'lowpass';
      filter.frequency.value = opts.filterFreq || 800;
      const gain = ctx.createGain();
      const peak = opts.gain != null ? opts.gain : 0.22;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start(t0); src.stop(t0 + dur + 0.02);
    }
    // Public SFX library — keep names descriptive so call sites read like prose.
    const liarSfx = {
      cardFlip(){ sfxTone(420, 0.06, { type:'triangle', gain:0.12 }); },
      bustedStinger(){
        // Two-note descending stinger: "duh-DUNN"
        sfxTone(330, 0.18, { type:'sawtooth', gain:0.14 });
        sfxTone(220, 0.55, { type:'sawtooth', gain:0.16, delay:0.18, freqTo:170 });
        sfxNoise(0.25, { filterFreq:1400, gain:0.08, delay:0.18 });
      },
      wrongCallStinger(){
        sfxTone(180, 0.22, { type:'square', gain:0.13 });
        sfxTone(130, 0.5, { type:'square', gain:0.14, delay:0.18, freqTo:90 });
      },
      // Suspense heartbeat loop — two thumps every ~700ms, low frequency.
      suspenseStart(){
        sfxStopSuspense();
        if (isSoundMuted()) return;
        const beat = () => {
          sfxTone(85, 0.12, { type:'sine', gain:0.22 });
          sfxTone(75, 0.16, { type:'sine', gain:0.2, delay:0.13 });
        };
        beat();
        __sfxSuspenseTimer = setInterval(beat, 700);
      },
      gulp(){
        // Quick "gulp" — rising blip + small click
        sfxTone(220, 0.13, { type:'sine', gain:0.18, freqTo:540 });
        sfxNoise(0.05, { filterFreq:500, gain:0.06, delay:0.08 });
      },
      safe(){
        // Cinematic safe resolution — opens with a bright 880Hz "ding" then
        // a sustained C5+E5+G5+C6 chord that swells over ~0.9s. Was a quick
        // 3-note arpeggio (~500ms) — felt rushed. Now it breathes.
        sfxTone(880,    0.14, { type:'sine',     gain:0.10 });            // opening chime
        sfxTone(523.25, 0.55, { type:'triangle', gain:0.18 });            // C5 root
        sfxTone(659.25, 0.6,  { type:'triangle', gain:0.16, delay:0.08 });// E5
        sfxTone(783.99, 0.65, { type:'triangle', gain:0.15, delay:0.16 });// G5
        sfxTone(1046.5, 0.55, { type:'triangle', gain:0.11, delay:0.24 });// C6 sparkle
      },
      spill(){
        // Splash: descending sweep + filtered noise + low thud
        sfxTone(380, 0.28, { type:'sawtooth', gain:0.16, freqTo:90 });
        sfxNoise(0.55, { filterFreq:2200, gain:0.18, delay:0.05 });
        sfxTone(60, 0.4, { type:'sine', gain:0.22, delay:0.05 }); // body thud
      },
      // Roulette tick — warm "tock" each time the spotlight crosses a chamber.
      // Triangle wave at 620Hz (was 1180Hz square — too clicky) with a small
      // 190Hz body so it lands like a wooden ball hitting a metal divider.
      // 75ms duration so each tick completes its envelope before the next.
      rouletteTick(){
        sfxTone(620, 0.075, { type:'triangle', gain:0.13 });
        sfxTone(190, 0.05,  { type:'sine',     gain:0.08, delay:0.005 });
      },
      // The ball settles into its pocket — bigger, lower, longer than a tick.
      // Marks the end of the roulette so the silence after it feels intentional.
      rouletteLand(){
        sfxTone(420, 0.20, { type:'triangle', gain:0.20 });
        sfxTone(180, 0.28, { type:'sine',     gain:0.14, delay:0.01 });
        sfxNoise(0.06, { filterFreq:1800, gain:0.06, delay:0.02 });
      },
      // Slow heartbeat thud — used DURING the held pause (silence-except-this).
      // Lower and slower than the suspense loop's twin-thump so it reads as
      // "the room goes quiet, only your pulse remains".
      heartbeatSlow(){
        sfxTone(72, 0.18, { type:'sine', gain:0.26 });
        sfxTone(60, 0.22, { type:'sine', gain:0.20, delay:0.13 });
      },
      // Sustained low rumble — the "danger drone" under the roulette spin. We
      // create a looped noise buffer through a lowpass + slow fade-in. Stored
      // on __sfxRumble so rumbleStop can ramp it down cleanly.
      rumbleStart(){
        const ctx = sfxCtx(); if (!ctx) return;
        sfxStopRumble();
        try {
          const bufLen = Math.floor(ctx.sampleRate * 2);
          const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
          const data = buf.getChannelData(0);
          for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          const filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 130;
          filter.Q.value = 1.4;
          const gain = ctx.createGain();
          const t0 = ctx.currentTime;
          gain.gain.setValueAtTime(0, t0);
          gain.gain.linearRampToValueAtTime(0.085, t0 + 0.8); // slow swell
          src.connect(filter).connect(gain).connect(ctx.destination);
          src.start();
          __sfxRumble = { src, gain };
        } catch(e){}
      },
      // Sharp inhale-style swoosh — single beat right before the gulp.
      whoosh(){
        sfxNoise(0.32, { filterType:'bandpass', filterFreq:1100, gain:0.14 });
        sfxTone(560, 0.18, { type:'sine', gain:0.08, freqTo:1200 });
      },
      // === GLASS SHATTER === Cinematic broken-glass crash. Was a muddy bass-
      // heavy "pop" that read more like a thud than a smash — the user
      // specifically called it out. Rebuilt with the canonical glass-shatter
      // layers (snap → body → smash noise → cascading tinkles → reverb tail):
      //   * SNAP — sharp high-freq transient (the moment glass goes critical)
      //   * BODY THUD — 50Hz sub-bass sine + 38Hz sub, long decay (physical weight)
      //   * SHATTER NOISE — broadband highpass noise burst (the actual smash)
      //   * GLASS TINKLE — 6 quick high-freq sine taps cascading over ~700ms
      //                    (shards landing one after another)
      //   * REVERB TAIL — lowpass noise decay (room ambience after the crash)
      spillImpact(){
        // 1. Snap — the instant the cup breaks
        sfxTone(2800, 0.025, { type:'square', gain:0.16 });
        sfxNoise(0.04, { filterType:'highpass', filterFreq:3200, gain:0.22 });
        // 2. Body thud — sub-bass weight under the smash
        sfxTone(50, 0.85, { type:'sine', gain:0.34 });
        sfxTone(38, 1.0,  { type:'sine', gain:0.20, delay:0.04 });
        // 3. Shatter noise — broadband crash
        sfxNoise(0.5,  { filterType:'highpass', filterFreq:1300, gain:0.32, delay:0.01 });
        sfxNoise(0.75, { filterFreq:3000,                        gain:0.18, delay:0.02 });
        // 4. Glass tinkle — cascading shards landing
        sfxTone(3200, 0.045, { type:'sine', gain:0.13, delay:0.17 });
        sfxTone(2700, 0.05,  { type:'sine', gain:0.12, delay:0.26 });
        sfxTone(3450, 0.04,  { type:'sine', gain:0.11, delay:0.35 });
        sfxTone(2500, 0.04,  { type:'sine', gain:0.10, delay:0.46 });
        sfxTone(2950, 0.035, { type:'sine', gain:0.09, delay:0.58 });
        sfxTone(3100, 0.035, { type:'sine', gain:0.07, delay:0.72 });
        // 5. Reverb tail — low filtered noise decay
        sfxNoise(1.4, { filterFreq:380, gain:0.10, delay:0.10 });
      },
      // Pre-shatter stress crack — fires ~150ms before spillImpact so you
      // HEAR the glass starting to give before it breaks. High descending
      // sweep + tiny noise grit.
      glassCrack(){
        sfxTone(2100, 0.11, { type:'sawtooth', gain:0.11, freqTo:700 });
        sfxNoise(0.10,       { filterType:'highpass', filterFreq:2200, gain:0.10 });
      },
      // Slow droning aftermath — the ominous "you're done" tail under the
      // result card. Very low, very quiet, fades on its own.
      spillAftermath(){
        sfxTone(70, 1.8, { type:'sine', gain:0.12 });
        sfxTone(94, 1.6, { type:'sine', gain:0.07, delay:0.1 });
      },
      // Extended celebration — sustained major chord (C5 + E5 + G5 + C6) so
      // the safe moment breathes. Comes ~0.7s after the initial safe() chord.
      safeCheer(){
        sfxTone(523.25, 0.9, { type:'triangle', gain:0.13 });
        sfxTone(659.25, 0.9, { type:'triangle', gain:0.12, delay:0.05 });
        sfxTone(783.99, 0.9, { type:'triangle', gain:0.11, delay:0.1 });
        sfxTone(1046.5, 0.9, { type:'triangle', gain:0.1,  delay:0.15 });
      },
    };
    function sfxStopSuspense(){
      if (__sfxSuspenseTimer) { clearInterval(__sfxSuspenseTimer); __sfxSuspenseTimer = null; }
    }
    function sfxStopRumble(){
      if (!__sfxRumble) return;
      const ctx = __sfxCtx;
      const { src, gain } = __sfxRumble;
      __sfxRumble = null;
      try {
        if (ctx) gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
      } catch(e){}
      setTimeout(() => { try { src.stop(); } catch(e){} }, 260);
    }

    // ===== Liar's Cup audio lifecycle =====
    // The Liar's Cup mini-game schedules ~25 setTimeouts inside the cup
    // animation that fire SFX (roulette ticks, gulp, shatter, drone, etc.).
    // Without tracking them, navigating away mid-animation OR finishing the
    // game while audio is still scheduled leaves sound playing until the
    // page is refreshed. The tracker + hard-kill below give us cleanup
    // semantics: every scheduled SFX timeout pushes its id; on game-end,
    // leave-room, or page-unload we cancel everything pending AND close the
    // audio context to silence any in-flight Web Audio oscillators.
    let __liarSfxTimeouts = [];
    function liarSchedule(fn, ms){
      const id = setTimeout(() => {
        const i = __liarSfxTimeouts.indexOf(id);
        if (i >= 0) __liarSfxTimeouts.splice(i, 1);
        try { fn(); } catch(e){ console.error('liar sfx step failed', e); }
      }, ms);
      __liarSfxTimeouts.push(id);
      return id;
    }
    function liarCancelScheduledSfx(){
      __liarSfxTimeouts.forEach(id => { try { clearTimeout(id); } catch(e){} });
      __liarSfxTimeouts = [];
    }
    // Complete audio kill switch — clears pending SFX timeouts AND closes the
    // Web Audio context so any already-started oscillators stop immediately.
    // The next sfxCtx() call will create a fresh context on demand (~15ms).
    function liarStopAllSfx(){
      liarCancelScheduledSfx();
      sfxStopSuspense();
      sfxStopRumble();
      if (__sfxCtx) {
        try { __sfxCtx.close(); } catch(e){}
        __sfxCtx = null;
      }
    }
    // Belt-and-braces: kill audio when the page unloads (refresh, navigation,
    // tab close). Without this, an in-flight oscillator can briefly ring on
    // some browsers during the unload race.
    try {
      window.addEventListener('beforeunload', liarStopAllSfx, { capture: true });
      window.addEventListener('pagehide',     liarStopAllSfx, { capture: true });
    } catch(e){}

    // ---------- Profile & Avatar ----------
    // 3-layer avatar: symbol + colour + style. Persisted to localStorage.
    // Other players (Alex, Maria, Kenji) get deterministic avatars derived
    // from their id so the lobby never looks like a row of gray circles.

    const AV_COLOURS = [
      { id:'sage',       hex:'#7DA89E' },
      { id:'dustyblue',  hex:'#7A95C2' },
      { id:'peach',      hex:'#E9A57B' },
      { id:'lavender',   hex:'#A593C7' },
      { id:'rose',       hex:'#D38AA3' },
      { id:'charcoal',   hex:'#4A4B52' },
      { id:'olive',      hex:'#8C9A6F' },
      { id:'terracotta', hex:'#C97A60' },
      { id:'teal',       hex:'#5FA5A0' },
      { id:'mustard',    hex:'#C9A356' },
    ];

    const AV_STYLES = [
      // Calm / static
      { id:'solid',    label:'Solid' },
      { id:'gradient', label:'Gradient' },
      { id:'soft',     label:'Soft' },
      { id:'half',     label:'Half' },
      { id:'ring',     label:'Ring' },
      // Patterned / static
      { id:'dots',     label:'Dots' },
      { id:'stripes',  label:'Stripes' },
      { id:'glow',     label:'Glow' },
      // Animated (motion:true → flagged for reduced-motion fallback)
      { id:'pulse',    label:'Pulse',   motion:true },
      { id:'shimmer',  label:'Shimmer', motion:true },
      { id:'halo',     label:'Halo',    motion:true },
      { id:'float',    label:'Float',   motion:true },
      { id:'ripple',   label:'Ripple',  motion:true },
    ];

    const AV_SYMBOL_CATS = [
      { id:'faces',   label:'Faces',   items:['😀','😎','🥳','🤓','🙂','😴','🤠','🤖'] },
      { id:'animals', label:'Animals', items:['🐼','🦊','🐙','🦄','🐸','🦉','🐢','🐧'] },
      { id:'food',    label:'Food',    items:['🍕','🌮','🍩','🍣','🍔','🥑','🍦','🍇'] },
      { id:'hobbies', label:'Hobbies', items:['🎲','🎸','🎮','⚽','🎨','📚','🎬','🎤'] },
      { id:'things',  label:'Things',  items:['🚀','🌈','⚡','🔥','💎','🎯','🪐','🌵'] },
    ];

    function allSymbols(){
      return AV_SYMBOL_CATS.flatMap(c => c.items);
    }

    // Tiny string hash → stable index, used to give other players a
    // deterministic avatar derived from their id.
    function hashStr(s){
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
      }
      return Math.abs(h);
    }
    function deterministicAvatar(seed){
      const symbols = allSymbols();
      const h = hashStr(seed);
      return {
        symbol: symbols[h % symbols.length],
        colour: AV_COLOURS[(h >> 5) % AV_COLOURS.length].id,
        style:  AV_STYLES[(h >> 10) % AV_STYLES.length].id,
      };
    }
    function randomAvatar(){
      const symbols = allSymbols();
      return {
        symbol: symbols[Math.floor(Math.random() * symbols.length)],
        colour: AV_COLOURS[Math.floor(Math.random() * AV_COLOURS.length)].id,
        style:  AV_STYLES[Math.floor(Math.random() * AV_STYLES.length)].id,
      };
    }
    function colourHex(id){
      const c = AV_COLOURS.find(x => x.id === id);
      return c ? c.hex : AV_COLOURS[0].hex;
    }

    // Renders the avatar component as an HTML string. `size` is px.
    // Pass `online:true` to add the green presence dot.
    function avatarHTML(avatar, size, opts){
      opts = opts || {};
      const bg = colourHex(avatar.colour);
      // Defense-in-depth against stored XSS: a malicious actor with direct
      // Supabase REST access could write an arbitrary string into profiles.avatar.symbol,
      // and this value flows straight into innerHTML below. Restrict to the curated
      // emoji allowlist — anything else falls back to the initial.
      const symbolValid = (typeof allSymbols === 'function' && allSymbols().includes(avatar.symbol));
      const symbol = symbolValid ? avatar.symbol : '';
      const content = symbol
        ? `<span class="av-symbol">${symbol}</span>`
        : `<span class="av-initial">${(opts.fallback || '?').toUpperCase()}</span>`;
      const av = `<div class="av" data-style="${avatar.style}" style="--size:${size}px;--av-bg:${bg}">${content}</div>`;
      // Online → wrap in a non-clipping shell so the presence dot can sit OUTSIDE
      // the avatar's circular clip. Offline → just the .av, no wrapper overhead.
      if (opts.online) {
        return `<span class="av-shell" style="--size:${size}px">${av}<span class="av-presence" aria-hidden="true"></span></span>`;
      }
      return av;
    }

    // ---------- My profile (the logged-in user) ----------
    const PROFILE_KEY = 'huddle.profile';

    function sanitizeStyle(id){
      return AV_STYLES.some(s => s.id === id) ? id : 'solid';
    }
    function sanitizeColour(id){
      return AV_COLOURS.some(c => c.id === id) ? id : AV_COLOURS[0].id;
    }
    // Security fix: only Google-authenticated users have a profile. We do NOT
    // synthesize a "Jordan Lee" placeholder on first visit (prior versions did,
    // and it ended up persisted to localStorage AND seeded into Supabase, so a
    // refresh would auto-log every visitor in as "Jordan Lee"). If there's a
    // legitimate cached profile (set by a previous real sign-in), restore it;
    // otherwise myProfile stays null until huddleAfterSignIn runs.
    function loadProfile(){
      try {
        const raw = localStorage.getItem(PROFILE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          // Guard against the legacy "Jordan Lee" seed lingering in localStorage.
          // If we see that exact shape (no real username was ever set), treat the
          // cache as empty so the user lands on login instead of a fake identity.
          const looksLikeLegacySeed = (!parsed.username || parsed.username === 'jordan')
            && (!parsed.name || parsed.name === 'Jordan Lee');
          if (looksLikeLegacySeed) {
            try { localStorage.removeItem(PROFILE_KEY); } catch(e){}
            return null;
          }
          return {
            name: parsed.name || '',
            username: parsed.username || '',
            avatar: {
              symbol: parsed.avatar && parsed.avatar.symbol || '🙂',
              colour: sanitizeColour(parsed.avatar && parsed.avatar.colour),
              style:  sanitizeStyle(parsed.avatar && parsed.avatar.style),
            },
          };
        }
      } catch(e){}
      return null;
    }
    function saveProfile(profile){
      try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch(e){}
    }
    let myProfile = loadProfile();

    // ---------- Auth (Phase 1A — real login with email/password) ----------
    // Modes: 'signin' (default), 'signup', 'forgot' (request reset email),
    //        'reset' (set new password after clicking the reset email link)
    let huddleAuthMode = 'signin';

    function huddleClearAuthStatus(){
      const el = document.getElementById('login-status');
      if (el) { el.textContent = ''; el.className = 'login-status'; }
    }
    function huddleSetAuthStatus(text, kind){
      const el = document.getElementById('login-status');
      if (!el) return;
      el.textContent = text;
      el.className = 'login-status' + (kind ? ' ' + kind : '');
    }

    // Central UI updater — call after changing huddleAuthMode to refresh all the
    // elements on the login screen. Each mode shows a different subset of fields.
    function huddleApplyAuthModeUI(){
      const mode = huddleAuthMode;
      const isSignin = mode === 'signin';
      const isSignup = mode === 'signup';
      const isForgot = mode === 'forgot';
      const isReset  = mode === 'reset';

      const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
      const show = (id, v) => { const el = document.getElementById(id); if (el) el.style.display = v ? '' : 'none'; };

      // Headline + subtitle
      if (isSignup) { set('login-headline', t('login.createTitle')); set('login-sub', t('login.createSub')); }
      else if (isForgot) { set('login-headline', t('login.forgotTitle')); set('login-sub', t('login.forgotSub')); }
      else if (isReset)  { set('login-headline', t('login.resetTitle'));  set('login-sub', t('login.resetSub')); }
      else { set('login-headline', t('login.welcomeBack')); set('login-sub', t('login.sub')); }

      // Field visibility
      show('login-email-field', !isReset);     // hide email in reset (we have the session already)
      show('login-password-field', !isForgot); // hide password in forgot mode
      show('login-username-field', isSignup);
      show('login-forgot-row', isSignin);      // only sign-in shows "Forgot password?"
      show('login-divider', !isReset);
      show('login-guest-btn', !isReset);
      show('login-footer-row', !isReset);

      // Submit button label
      if (isSignup)      set('login-submit-btn', t('login.createAccountBtn'));
      else if (isForgot) set('login-submit-btn', t('login.sendResetLink'));
      else if (isReset)  set('login-submit-btn', t('login.setNewPassword'));
      else               set('login-submit-btn', t('login.signIn'));

      // Footer toggle
      const togglePrompt = document.getElementById('login-toggle-prompt');
      const toggleLink = document.getElementById('login-toggle-link');
      if (togglePrompt && toggleLink) {
        if (isSignup) {
          togglePrompt.textContent = t('login.haveAccount');
          toggleLink.textContent = t('login.signInLink');
          toggleLink.onclick = () => huddleSetAuthMode('signin');
        } else if (isForgot) {
          togglePrompt.textContent = t('login.rememberPassword');
          toggleLink.textContent = t('login.signInLink');
          toggleLink.onclick = () => huddleSetAuthMode('signin');
        } else {
          togglePrompt.textContent = t('login.newHere');
          toggleLink.textContent = t('login.createAccount');
          toggleLink.onclick = () => huddleSetAuthMode('signup');
        }
      }

      huddleClearAuthStatus();
    }

    function huddleSetAuthMode(mode){
      huddleAuthMode = mode;
      huddleApplyAuthModeUI();
    }

    // Legacy toggle from the original Sign-in <-> Sign-up flip — kept for compatibility
    // with any onclick="huddleToggleAuthMode()" still in HTML, but the actual logic now
    // lives in huddleSetAuthMode.
    function huddleToggleAuthMode(){
      huddleSetAuthMode(huddleAuthMode === 'signin' ? 'signup' : 'signin');
    }

    async function huddleHandleAuthSubmit(){
      if (!window.sb) {
        huddleSetAuthStatus(t('login.supabaseDown'), 'error');
        return;
      }
      // Forgot mode — just need email, send reset link
      if (huddleAuthMode === 'forgot') {
        const email = (document.getElementById('email').value || '').trim();
        if (!email) { huddleSetAuthStatus(t('login.missingEmail'), 'error'); return; }
        await huddleSendPasswordReset(email);
        return;
      }
      // Reset mode — just need new password
      if (huddleAuthMode === 'reset') {
        const password = document.getElementById('password').value || '';
        if (!password) { huddleSetAuthStatus(t('login.missingFields'), 'error'); return; }
        if (password.length < 6) { huddleSetAuthStatus(t('login.passwordTooShort'), 'error'); return; }
        await huddleApplyNewPassword(password);
        return;
      }

      // Signin / signup require email + password
      const email = (document.getElementById('email').value || '').trim();
      const password = document.getElementById('password').value || '';
      if (!email || !password) {
        huddleSetAuthStatus(t('login.missingFields'), 'error');
        return;
      }
      if (huddleAuthMode === 'signup') {
        const username = (document.getElementById('login-username').value || '').trim().toLowerCase();
        if (!username || username.length < 3) {
          huddleSetAuthStatus(t('editProfile.usernameTooShort'), 'error');
          return;
        }
        if (!/^[a-z0-9_]+$/.test(username)) {
          huddleSetAuthStatus(t('editProfile.usernameBadChars'), 'error');
          return;
        }
        await huddleSignUp(email, password, username);
      } else {
        await huddleSignIn(email, password);
      }
    }

    // Send password reset email. Supabase emails the user a link that brings them
    // back to our site with a recovery token — our PASSWORD_RECOVERY listener catches it.
    async function huddleSendPasswordReset(email){
      huddleLockSubmit(true);
      huddleSetAuthStatus(t('login.sendingResetLink'), 'saving');
      try {
        const redirectTo = window.location.origin + '/';
        const { error } = await window.sb.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) {
          huddleSetAuthStatus(huddleAuthErrorText(error), 'error');
          return;
        }
        huddleSetAuthStatus(t('login.resetLinkSent'), 'ok');
      } catch (e) {
        huddleSetAuthStatus(t('login.signInFailed'), 'error');
      } finally {
        huddleLockSubmit(false);
      }
    }

    // Apply the new password (called from 'reset' mode after PASSWORD_RECOVERY event).
    // The user's session has been temporarily authenticated by clicking the email link.
    async function huddleApplyNewPassword(newPassword){
      huddleLockSubmit(true);
      huddleSetAuthStatus(t('login.savingPassword'), 'saving');
      try {
        const { data, error } = await window.sb.auth.updateUser({ password: newPassword });
        if (error) {
          huddleSetAuthStatus(huddleAuthErrorText(error), 'error');
          return;
        }
        // Their session is now active with the new password. Drop into the app.
        cardLobbyMe.sessionId = data.user.id;
        cardLobbyMe.bootstrapped = true;
        await huddleSyncProfileFromSupabase();
        huddleClearAuthStatus();
        document.getElementById('password').value = '';
        // Reset mode → switch back to signin for future use
        huddleSetAuthMode('signin');
        goTo('games');
      } catch (e) {
        huddleSetAuthStatus(t('login.signInFailed'), 'error');
      } finally {
        huddleLockSubmit(false);
      }
    }

    // Sign in to an existing account.
    async function huddleSignIn(email, password){
      huddleLockSubmit(true);
      huddleSetAuthStatus(t('login.signingIn'), 'saving');
      try {
        const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
        if (error) {
          console.error('[Huddle] signIn error:', {
            status: error.status, code: error.code, message: error.message, name: error.name, full: error,
          });
          huddleSetAuthStatus(huddleAuthErrorText(error), 'error');
          return;
        }
        // Update local sessionId to the real auth user
        cardLobbyMe.sessionId = data.user.id;
        cardLobbyMe.bootstrapped = true;
        // Pull profile from server
        await huddleSyncProfileFromSupabase();
        huddleClearAuthStatus();
        // Clear sensitive inputs
        document.getElementById('password').value = '';
        goTo('games');
      } catch (e) {
        huddleSetAuthStatus(t('login.signInFailed'), 'error');
      } finally {
        huddleLockSubmit(false);
      }
    }

    // Sign up a new account. Plain signUp — does NOT try to upgrade the existing
    // anonymous user (that path required Supabase "manual linking" + triggered extra
    // confirmation emails which hit rate limits during testing). Anonymous user data
    // is effectively orphaned, but in practice the user hasn't customised anything
    // yet so this is fine. We can add account-merging in a later phase.
    async function huddleSignUp(email, password, username){
      huddleLockSubmit(true);
      huddleSetAuthStatus(t('login.creatingAccount'), 'saving');
      try {
        // Username uniqueness check FIRST (so we don't burn a signup attempt only to
        // fail on the profile insert step — and so we don't waste an email-rate-limit slot)
        const { data: existing } = await window.sb
          .from('profiles')
          .select('user_id')
          .eq('username', username)
          .maybeSingle();
        if (existing) {
          huddleSetAuthStatus(t('editProfile.usernameTaken'), 'error');
          return;
        }

        // Create the account
        const { data, error } = await window.sb.auth.signUp({ email, password });
        if (error) {
          // Diagnostic: log the full error to the console so the user can paste it
          // when troubleshooting rate limits or other auth issues.
          console.error('[Huddle] signUp error:', {
            status: error.status,
            code: error.code,
            message: error.message,
            name: error.name,
            full: error,
          });
          huddleSetAuthStatus(huddleAuthErrorText(error), 'error');
          return;
        }

        // CRITICAL: with email-confirmation ON, Supabase returns the user but session=null.
        // The user can't authenticate further requests until they confirm via email link.
        // Detect this and tell the user clearly instead of failing on the profile upsert.
        if (!data || !data.session) {
          huddleSetAuthStatus(t('login.confirmEmailFirst'), 'error');
          return;
        }

        const userId = data.user.id;
        cardLobbyMe.sessionId = userId;
        cardLobbyMe.bootstrapped = true;

        // Now safely upsert the profile row — we have a real session, RLS will allow it
        const upsertData = {
          user_id: userId,
          username: username,
          display_name: myProfile.name || username,
          avatar: myProfile.avatar,
        };
        const { error: upsertErr } = await window.sb
          .from('profiles')
          .upsert(upsertData, { onConflict: 'user_id' });
        if (upsertErr) {
          if (upsertErr.code === '23505') {
            huddleSetAuthStatus(t('editProfile.usernameTaken'), 'error');
            return;
          }
          huddleSetAuthStatus(t('editProfile.saveFailed'), 'error');
          return;
        }

        // Update local cache
        myProfile.username = username;
        saveProfile(myProfile);
        huddleClearAuthStatus();
        document.getElementById('password').value = '';
        document.getElementById('login-username').value = '';
        goTo('games');
      } catch (e) {
        huddleSetAuthStatus(t('login.signInFailed'), 'error');
      } finally {
        huddleLockSubmit(false);
      }
    }

    // Disable / re-enable the submit button + Forgot link while a request is in flight.
    // Prevents users from double-tapping during a slow response, which causes extra
    // failed attempts and burns through email rate-limit slots.
    function huddleLockSubmit(locked){
      const btn = document.getElementById('login-submit-btn');
      if (btn) btn.disabled = !!locked;
      const guest = document.getElementById('login-guest-btn');
      if (guest) guest.disabled = !!locked;
    }

    // "Continue with Google" — triggers Supabase OAuth flow with Google.
    // signInWithOAuth performs a full-page redirect to Google's consent screen.
    // Execution halts here; when Google redirects back to roundlly.com, Supabase
    // parses the URL fragment, creates a session, and fires SIGNED_IN on
    // onAuthStateChange. huddleAfterSignIn() handles the rest.
    // NOTE: Phase 1 does not link an existing anon session to the new Google
    // account — the anon row is effectively abandoned. Account merging is a
    // future phase.
    async function huddleSignInWithGoogle(){
      // Local preview bypass: Supabase OAuth requires a publicly-reachable
      // callback URL, which doesn't work from localhost / Claude preview
      // (Supabase blocks the request). On localhost we skip auth entirely
      // and drop the user on the profile screen so the Lab entries (Test
      // Mafia, etc.) are reachable. Production users still go through the
      // real Google flow.
      const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);
      if (isLocal) {
        // Seed a dev profile on first localhost entry so the Profile screen
        // isn't blank. Skipped if a real profile is already cached (so an
        // edited name/avatar survives reloads). Uses a per-tab random tag so
        // multiple preview tabs don't share an identity in multiplayer.
        if (!myProfile) {
          const tag = Math.random().toString(36).slice(2, 6);
          myProfile = {
            name: 'Dev preview',
            username: 'dev-' + tag,
            avatar: randomAvatar(),
          };
          saveProfile(myProfile);
          if (typeof renderProfileScreen === 'function') renderProfileScreen();
        }
        try { goTo('profile'); } catch(e){}
        return;
      }
      if (!window.sb) {
        huddleSetAuthStatus(t('login.googleUnavailable'), 'error');
        return;
      }
      const btn = document.getElementById('login-google-btn');
      if (btn) btn.disabled = true;
      huddleSetAuthStatus(t('login.signingIn'), 'saving');
      try {
        // Preserve ?room=&game= in the redirect so QR-scanning friends land back
        // in the right lobby after the Google bounce — but ONLY if the values pass
        // strict validation. Anything else gets stripped (plan note #M17): the
        // pathname is forced to '/' to prevent open-redirect tricks, and any
        // unrecognised query params are dropped before being bounced through
        // Google's OAuth flow.
        const incomingParams = new URLSearchParams(window.location.search);
        const incomingRoom   = incomingParams.get('room');
        const incomingGame   = incomingParams.get('game');
        const ROOM_CODE_RE   = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
        const ALLOWED_GAMES  = new Set(['liar', 'hotseat', 'chameleon', 'mafia']);
        const safeParams = new URLSearchParams();
        if (incomingRoom && ROOM_CODE_RE.test(incomingRoom)) safeParams.set('room', incomingRoom);
        if (incomingGame && ALLOWED_GAMES.has(incomingGame)) safeParams.set('game', incomingGame);
        const safeQuery = safeParams.toString();
        const redirectTo = window.location.origin + '/' + (safeQuery ? '?' + safeQuery : '');
        const { error } = await window.sb.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo,
            // Force Google's account chooser every time (2026-06-27). Without
            // this, Google silently reuses whatever account is already signed in
            // on the device, so after signing out a user can't switch to a
            // different account — the chooser never appears. `prompt` is a raw
            // Google OAuth param forwarded verbatim; use 'consent select_account'
            // if we ever also want to re-show the permissions screen.
            queryParams: { prompt: 'select_account' },
          },
        });
        if (error) throw error;
        // Full-page redirect to Google is in flight — nothing more to do.
      } catch(e) {
        console.warn('[Huddle] Google sign-in failed:', e);
        huddleSetAuthStatus((e && e.message) || t('login.googleFailed'), 'error');
        if (btn) btn.disabled = false;
      }
    }

    // Only navigate to games if the user is currently on a login-flow screen
    // (login or username-setup). Otherwise the user has already been routed
    // somewhere meaningful (lobby via ?room=, games via boot-screen pre-paint,
    // etc.) and `huddleAfterSignIn` shouldn't yank them to games and override
    // that destination. This fixes the lobby-flash race: openLobby() and
    // huddleAfterSignIn() both ran goTo() unconditionally; whichever finished
    // last won, briefly showing the lobby then snapping to games.
    function huddleNavigateAfterSignInIfNeeded(){
      var active = document.querySelector('.screen.active');
      var id = active ? active.id : '';
      if (!id || id === 'screen-login' || id === 'screen-username-setup') {
        goTo('games');
      }
    }

    // Called after SIGNED_IN fires for a non-anonymous user (Google or password).
    // Routes the user: missing username → username-setup screen, otherwise → games.
    // Tracks the identity huddleAfterSignIn has ALREADY fully set up. Supabase
    // re-fires SIGNED_IN on every tab focus / token refresh — not just real logins
    // — and the boot path calls huddleAfterSignIn too. Without this guard the full
    // setup (which WIPES friendsState/invitesState, rebuilds realtime channels, and
    // refetches profile/friends/invites) ran on EVERY tab-return, emptying the
    // friends list for a moment and flashing "Loading…" in an open invite sheet.
    // Reset to null on a confirmed SIGNED_OUT (app-09) so a re-login still runs.
    let _huddleSignedInUid = null;
    async function huddleAfterSignIn(user){
      if (!user || user.is_anonymous) return;
      // Already fully set up for this exact identity → this is a spurious SIGNED_IN
      // re-fire (tab focus / token refresh) or a duplicate boot call. Do nothing:
      // re-running would wipe the in-memory lists and flicker the UI. The
      // visibilitychange backstop (app-09) already refreshes data silently. A real
      // account switch (different uid) or the first sign-in falls through below.
      if (user.id === _huddleSignedInUid) return;
      _huddleSignedInUid = user.id;
      // Account-switch hygiene (M3, 2026-06-27): wipe any in-memory lists left
      // from a PREVIOUS identity before we load this user's data, so the new
      // account never briefly shows the old account's friends / invites /
      // feedback. The loaders below (and on screen-open) then repopulate for the
      // current user. Safe on a normal same-account sign-in too (they reload).
      try {
        if (typeof friendsState !== 'undefined' && friendsState) {
          friendsState.friends = []; friendsState.incoming = []; friendsState.outgoing = [];
        }
        if (typeof invitesState !== 'undefined' && invitesState) {
          invitesState.incoming = []; invitesState.outgoing = [];
          invitesState.bannerQueue = []; invitesState.bannerActive = null;
        }
        if (typeof feedbackState !== 'undefined' && feedbackState) {
          feedbackState.posts = []; feedbackState.voteCounts = Object.create(null);
          feedbackState.myVotes = new Set(); feedbackState.loaded = false;
        }
      } catch(e){}
      // Capture the previous (anon) session ids BEFORE rebinding, so we can
      // ask the server to migrate any seat claims that are still tied to them.
      // The seat-migration RPC requires both the new auth.uid() (implicit
      // from session) and the previous session id (explicit arg).
      const prevHotSid   = (typeof hotMe   !== 'undefined' && hotMe.sessionId)   ? hotMe.sessionId   : null;
      const prevChamSid  = (typeof chamMe  !== 'undefined' && chamMe.sessionId)  ? chamMe.sessionId  : null;
      const prevLiarSid  = (cardLobbyMe && cardLobbyMe.sessionId) ? cardLobbyMe.sessionId : null;
      const prevMafiaSid = (typeof mafiaMe !== 'undefined' && mafiaMe.sessionId) ? mafiaMe.sessionId : null;
      // Bind the new auth user as the active session for ALL multiplayer subsystems.
      // Critical: without this, hotMe/chamMe keep their old anon session IDs after Google sign-in,
      // which causes host-transfer + "claimed seat" mismatches across the games.
      if (typeof hotMe  !== 'undefined') { hotMe.sessionId  = user.id; hotMe.bootstrapped  = true; }
      if (typeof chamMe !== 'undefined') { chamMe.sessionId = user.id; chamMe.bootstrapped = true; }
      cardLobbyMe.sessionId = user.id;
      cardLobbyMe.bootstrapped = true;
      // Mafia was previously MISSING here — its session id was never rebound to the
      // new Google/password user, so after an anon→account sign-in mid-lobby the
      // client kept the old anon id while the seat migrated to user.id server-side,
      // producing the exact "claimed seat mismatch" the comment above warns about.
      if (typeof mafiaMe !== 'undefined') { mafiaMe.sessionId = user.id; mafiaMe.bootstrapped = true; }
      // Migrate any seat claims still tied to the old anon session over to the
      // new Google user, so the lobby shows them as seated instead of unseated.
      // Lobby-phase only, server-side, atomic. Quiet failure (no toast) — this
      // is a background operation; if the room doesn't exist or the user
      // didn't actually have a seat, the RPC silently no-ops.
      const migrateSeat = async (table, code, fromSid) => {
        if (!code || !fromSid || fromSid === user.id) return;
        try {
          await window.sb.rpc('huddle_migrate_seat', {
            p_table: table,
            p_code: code,
            p_from_session_id: fromSid,
          });
        } catch(e) { /* quiet — best-effort */ }
      };
      try {
        await Promise.all([
          (typeof state      !== 'undefined' && state      && state.code)      ? migrateSeat('hotseat_rooms',   state.code,      prevHotSid)   : null,
          (typeof chamState  !== 'undefined' && chamState  && chamState.code)  ? migrateSeat('chameleon_rooms', chamState.code,  prevChamSid)  : null,
          (typeof cardLobbyState  !== 'undefined' && cardLobbyState  && cardLobbyState.code)  ? migrateSeat('liar_rooms',      cardLobbyState.code,  prevLiarSid)  : null,
          (typeof mafiaState !== 'undefined' && mafiaState && mafiaState.code) ? migrateSeat('mafia_rooms',     mafiaState.code, prevMafiaSid) : null,
        ].filter(Boolean));
      } catch(e) { /* quiet — best-effort */ }
      // If the user was already in a lobby (mid-flow anon → Google sign-in),
      // rebuild the realtime channels so presence is keyed on the new user id
      // instead of the stale anon id. xWireSync no-ops if state.code is empty.
      // (Done AFTER migrate so the rebuilt channel's reconcile-on-subscribe
      // pulls the migrated state.)
      try { if (typeof chamWireSync === 'function') chamWireSync(); } catch(e){}
      try { if (typeof cardLobbyWireSync === 'function') cardLobbyWireSync(); } catch(e){}
      // Mafia was missing here too: rebuild its channel so it re-keys presence
      // on the new user id AND its reconcile-on-subscribe pulls the migrated
      // state (incl. the now-migrated narratorUid from fix/03) — so the host's
      // narrator dashboard recovers after an anon→Google sign-in without a
      // manual refresh. No-op if not in a Mafia room (mafiaWireSync guards on code).
      try { if (typeof mafiaWireSync === 'function') mafiaWireSync(); } catch(e){}
      try {
        const { data, error } = await window.sb
          .from('profiles')
          .select('username, display_name, avatar')
          .eq('user_id', user.id)
          .maybeSingle();
        if (error) {
          console.warn('[Huddle] profile lookup after sign-in failed:', error.message);
          // Fall back to syncing the way email-signin does
          await huddleSyncProfileFromSupabase();
          huddleNavigateAfterSignInIfNeeded();
          return;
        }
        if (data && data.username) {
          // Existing profile with username — sync local cache and drop into the app.
          // myProfile may be null (fresh browser / cache cleared / true first
          // sign-in on this device for a returning account) — fall back to safe
          // defaults so the || chain doesn't dereference null.
          const prevName   = (myProfile && myProfile.name)   || '';
          const prevAvatar = (myProfile && myProfile.avatar) || randomAvatar();
          myProfile = {
            name: data.display_name || prevName,
            username: data.username,
            avatar: data.avatar || prevAvatar,
          };
          saveProfile(myProfile);
          if (typeof renderProfileScreen === 'function') renderProfileScreen();
          if (typeof friendsLoad === 'function') friendsLoad();
          if (typeof invitesLoad === 'function') { invitesLoad().then(() => { if (typeof invitesWireSync === 'function') invitesWireSync(); }); }
          huddleNavigateAfterSignInIfNeeded();
        } else {
          // First sign-in for this Google account — prompt for username.
          // The trigger created the profile row already (display_name may be set
          // from Google's full_name claim); we just need a username.
          // For a true first-time user, myProfile is null (no localStorage cache)
          // — initialize it before assigning so the next two lines don't crash.
          if (!myProfile) {
            myProfile = { name: '', username: '', avatar: randomAvatar() };
          }
          if (data && data.display_name) myProfile.name = data.display_name;
          if (data && data.avatar)       myProfile.avatar = data.avatar;
          saveProfile(myProfile);
          huddleOpenUsernameSetup();
        }
      } catch(e) {
        console.warn('[Huddle] huddleAfterSignIn exception:', e);
        huddleNavigateAfterSignInIfNeeded();
      }
    }

    // ---------- Username setup (first-time after Google sign-in) ----------
    let huddleUsernameDebounce = null;
    let huddleUsernameLastChecked = '';
    let huddleUsernameLastResult = null; // 'available' | 'taken' | null

    function huddleOpenUsernameSetup(){
      const input = document.getElementById('us-username');
      if (input) input.value = '';
      huddleUsernameLastChecked = '';
      huddleUsernameLastResult = null;
      huddleSetUsernameSetupStatus('', '');
      const btn = document.getElementById('us-confirm-btn');
      if (btn) btn.disabled = true;
      goTo('username-setup');
      setTimeout(() => { if (input) input.focus(); }, 50);
    }

    function huddleSetUsernameSetupStatus(text, kind){
      const el = document.getElementById('us-status');
      if (!el) return;
      el.textContent = text;
      el.className = 'ep-username-status' + (kind ? ' ' + kind : '');
    }

    function huddleUsernameSetupCheck(){
      const input = document.getElementById('us-username');
      const btn = document.getElementById('us-confirm-btn');
      if (!input || !btn) return;
      const val = (input.value || '').trim().toLowerCase();
      // Local validation first
      if (val.length === 0) {
        huddleSetUsernameSetupStatus('', '');
        btn.disabled = true;
        huddleUsernameLastResult = null;
        return;
      }
      if (val.length < 3 || val.length > 20 || !/^[a-z0-9_]+$/.test(val)) {
        huddleSetUsernameSetupStatus(t('username.invalid'), 'error');
        btn.disabled = true;
        huddleUsernameLastResult = null;
        return;
      }
      // Debounce remote uniqueness check
      huddleSetUsernameSetupStatus(t('username.checking'), 'saving');
      btn.disabled = true;
      if (huddleUsernameDebounce) clearTimeout(huddleUsernameDebounce);
      huddleUsernameDebounce = setTimeout(() => huddleUsernameSetupRemoteCheck(val), 400);
    }

    async function huddleUsernameSetupRemoteCheck(val){
      if (!window.sb) {
        huddleSetUsernameSetupStatus(t('login.googleUnavailable'), 'error');
        return;
      }
      try {
        const { data, error } = await window.sb
          .from('profiles')
          .select('user_id')
          .eq('username', val)
          .maybeSingle();
        // Bail if the user kept typing while we were waiting
        const current = (document.getElementById('us-username').value || '').trim().toLowerCase();
        if (current !== val) return;
        if (error) {
          huddleSetUsernameSetupStatus(t('username.invalid'), 'error');
          return;
        }
        huddleUsernameLastChecked = val;
        if (data) {
          huddleUsernameLastResult = 'taken';
          huddleSetUsernameSetupStatus(t('username.taken'), 'error');
          document.getElementById('us-confirm-btn').disabled = true;
        } else {
          huddleUsernameLastResult = 'available';
          huddleSetUsernameSetupStatus(t('username.available'), 'ok');
          document.getElementById('us-confirm-btn').disabled = false;
        }
      } catch(e) {
        console.warn('[Huddle] username check failed:', e);
        huddleSetUsernameSetupStatus(t('login.googleFailed'), 'error');
      }
    }

    async function huddleUsernameSetupConfirm(){
      const input = document.getElementById('us-username');
      const btn = document.getElementById('us-confirm-btn');
      if (!input || !btn) return;
      const val = (input.value || '').trim().toLowerCase();
      if (val.length < 3 || !/^[a-z0-9_]+$/.test(val)) {
        huddleSetUsernameSetupStatus(t('username.invalid'), 'error');
        return;
      }
      if (huddleUsernameLastResult !== 'available' || huddleUsernameLastChecked !== val) {
        // Re-check synchronously before save (covers race where user clicks before debounce fires)
        await huddleUsernameSetupRemoteCheck(val);
        if (huddleUsernameLastResult !== 'available') return;
      }
      btn.disabled = true;
      huddleSetUsernameSetupStatus(t('username.saving'), 'saving');
      try {
        const { data: { user } } = await window.sb.auth.getUser();
        if (!user) {
          huddleSetUsernameSetupStatus(t('login.googleFailed'), 'error');
          btn.disabled = false;
          return;
        }
        // Update the existing profile row (trigger created it on signup with NULL username)
        const { error } = await window.sb
          .from('profiles')
          .update({ username: val, display_name: myProfile.name, avatar: myProfile.avatar })
          .eq('user_id', user.id);
        if (error) {
          if (error.code === '23505') {
            huddleSetUsernameSetupStatus(t('username.taken'), 'error');
          } else {
            console.warn('[Huddle] username save failed:', error.message);
            huddleSetUsernameSetupStatus(error.message || t('login.googleFailed'), 'error');
          }
          btn.disabled = false;
          return;
        }
        myProfile.username = val;
        saveProfile(myProfile);
        if (typeof renderProfileScreen === 'function') renderProfileScreen();
        huddleSetUsernameSetupStatus('', '');
        goTo('games');
      } catch(e) {
        console.warn('[Huddle] username confirm exception:', e);
        huddleSetUsernameSetupStatus(t('login.googleFailed'), 'error');
        btn.disabled = false;
      }
    }

    // Translate Supabase auth error codes/messages to friendly strings.
    // Researched 2026-05-15: Supabase's rate-limit error string is
    // "For security purposes, you can only request this after X seconds."
    // and is returned with status 429. Email-confirmation-required is not
    // an error — it just returns user with session=null, handled in caller.
    function huddleAuthErrorText(error){
      const msg = (error && error.message) ? error.message.toLowerCase() : '';
      const status = error && error.status;

      // Rate limit — most common error during testing
      if (status === 429
          || msg.includes('for security purposes')
          || msg.includes('rate limit')
          || msg.includes('too many requests')) {
        const secMatch = (error.message || '').match(/after (\d+) seconds?/i);
        if (secMatch) {
          return t('login.rateLimitedSec').replace('{n}', secMatch[1]);
        }
        return t('login.rateLimited');
      }
      if (msg.includes('invalid login credentials') || msg.includes('invalid_credentials')) {
        return t('login.invalidCredentials');
      }
      if (msg.includes('already registered') || msg.includes('user already') || msg.includes('already exists')) {
        return t('login.alreadyRegistered');
      }
      if (msg.includes('password') && (msg.includes('short') || msg.includes('weak') || msg.includes('characters'))) {
        return t('login.passwordTooShort');
      }
      if (msg.includes('email') && (msg.includes('invalid') || msg.includes('format'))) {
        return t('login.invalidEmail');
      }
      // Last resort — show the raw message so user sees what's wrong, but capitalize first letter
      const raw = (error && error.message) || '';
      if (raw) return raw.charAt(0).toUpperCase() + raw.slice(1);
      return t('login.signInFailed');
    }

    // Sign out — clears Supabase session, drops local profile cache, returns to login.
    async function huddleSignOut(){
      // Release any claimed seats SERVER-SIDE before we tear down local state and
      // sign out, so other players see us leave IMMEDIATELY (the "{name} left"
      // notice fires off the seat-vanish diff) instead of a ghost seat that
      // lingers until the 60s presence grace expires. This makes sign-out behave
      // like an explicit Leave.
      //
      // The room code is read from the durable per-game lastRoom store, NOT live
      // game state: the Sign Out button lives on the Profile screen, so by the
      // time this runs the live <game>State.code is usually already cleared —
      // that's why an earlier live-state-only version silently released nothing.
      // (live state is still tried first for the case where you sign out while
      // sitting in the lobby.)
      //
      // Must run (a) while still authenticated — before auth.signOut() below — so
      // huddle_leave_seat's auth.uid() check passes, and (b) BEFORE the local
      // force-leave helpers / huddleClearLastRoom calls wipe the saved codes.
      // Best-effort + quiet: a failure here must never block sign-out.
      try {
        const _releaseSeat = async (table, liveSt, lastKey) => {
          let code = (liveSt && liveSt.code) ? liveSt.code : null;
          if (!code) {
            try { code = (typeof huddleReadLastRoom === 'function') ? huddleReadLastRoom(lastKey) : null; } catch(e){}
          }
          if (!(window.sb && code)) return;
          try { await window.sb.rpc('huddle_leave_seat', { p_table: table, p_code: code }); }
          catch(e){ /* quiet — best-effort */ }
        };
        await Promise.all([
          _releaseSeat('hotseat_rooms',   (typeof state      !== 'undefined') ? state      : null, 'hotseat'),
          _releaseSeat('chameleon_rooms', (typeof chamState  !== 'undefined') ? chamState  : null, 'cham'),
          _releaseSeat('liar_rooms',      (typeof cardLobbyState  !== 'undefined') ? cardLobbyState  : null, 'liar'),
          _releaseSeat('mafia_rooms',     (typeof mafiaState !== 'undefined') ? mafiaState : null, 'mafia'),
        ]);
      } catch(e){ /* quiet — best-effort */ }
      // Tear down any game-room Realtime channels BEFORE auth cleanup so the
      // old user's channels don't bleed into the next signed-in user's session
      // and write their state into the wrong account. Each helper handles its
      // own channel removal + per-game state reset.
      try {
        if (typeof hotForceLeaveLocal === 'function') hotForceLeaveLocal();
      } catch(e){}
      try {
        if (typeof chamForceLeaveLocal === 'function') chamForceLeaveLocal();
      } catch(e){}
      try {
        if (typeof cardLobbyForceLeaveLocal === 'function') cardLobbyForceLeaveLocal();
      } catch(e){}
      // Mafia: no dedicated forceLeaveLocal helper exists, so tear down its
      // realtime channel + reset its module-level state inline. Without this,
      // the previous user's Mafia channel and seat-id would leak into the next
      // signed-in user's session.
      try {
        if (typeof mafiaSyncChannel !== 'undefined' && mafiaSyncChannel && window.sb) {
          try { mafiaSyncChannel.untrack(); } catch(e){}
          try { window.sb.removeChannel(mafiaSyncChannel); } catch(e){}
          mafiaSyncChannel = null;
          if (typeof _mafiaChannelCode !== 'undefined') _mafiaChannelCode = null;
          if (typeof _mafiaChannelSessionId !== 'undefined') _mafiaChannelSessionId = null;
          if (typeof mafiaResetPresenceState === 'function') mafiaResetPresenceState();
        }
      } catch(e){}
      try {
        if (typeof mafiaMe !== 'undefined') {
          mafiaMe.sessionId = null;
          mafiaMe.myId = null;
          mafiaMe.myRole = null;
          mafiaMe.myTeammates = [];
          mafiaMe.bootstrapped = false;   // lockstep with hot/cham/liar so next sign-in re-bootstraps
        }
      } catch(e){}
      try {
        if (typeof mafiaState !== 'undefined') {
          Object.keys(mafiaState).forEach(k => { delete mafiaState[k]; });
        }
      } catch(e){}
      try {
        if (typeof invitesUnwireSync === 'function') invitesUnwireSync();
      } catch(e){}
      try {
        if (typeof friendsUnwireSync === 'function') friendsUnwireSync();
      } catch(e){}
      try {
        if (typeof feedbackUnwireSync === 'function') feedbackUnwireSync();
      } catch(e){}
      if (typeof friendsState !== 'undefined') {
        friendsState.me = null;
        friendsState.friends = [];
        friendsState.incoming = [];
        friendsState.outgoing = [];
      }
      if (typeof feedbackState !== 'undefined') {
        feedbackState.me = null;
        feedbackState.posts = [];
        feedbackState.voteCounts = Object.create(null);
        feedbackState.myVotes = new Set();
        feedbackState.loaded = false;
      }
      if (typeof invitesState !== 'undefined') {
        invitesState.me = null;
        invitesState.incoming = [];
        invitesState.outgoing = [];
        invitesState.bannerQueue = [];
        invitesState.bannerActive = null;
        invitesState.seenIncomingIds = new Set();
      }
      // Tear down the admin UI immediately (don't wait for the SIGNED_OUT
      // event) so switching from an admin account to a normal one can't briefly
      // show admin controls under the new account.
      try { if (typeof setHuddleAdmin === 'function') setHuddleAdmin(false); } catch(e){}
      try {
        // scope:'local' clears ONLY this device's session. The default ('global')
        // would also sign the previous player out on their OTHER devices —
        // wrong for a shared-phone party game (2026-06-27).
        if (window.sb) await window.sb.auth.signOut({ scope: 'local' });
      } catch(e){}
      // Belt-and-suspenders: if signOut() threw above, the Supabase token could
      // survive and the next boot would silently restore the old account. Remove
      // the token key directly (derived the same way as the index.html boot
      // pre-paint: sb-<project-ref>-auth-token).
      try {
        const _u = window.SUPABASE_URL || '';
        const _ref = ((_u.split('//')[1] || '').split('.')[0]) || '';
        if (_ref) localStorage.removeItem('sb-' + _ref + '-auth-token');
      } catch(e){}
      // Clear local cache so the next user starts cleanly
      try { localStorage.removeItem('huddle.profile'); } catch(e){}
      try { huddleClearLastRoom('hotseat'); } catch(e){}
      try { huddleClearLastRoom('cham'); } catch(e){}
      try { huddleClearLastRoom('liar'); } catch(e){}
      try { huddleClearLastRoom('mafia'); } catch(e){}
      // Clear last-screen so the next user lands on the default boot screen
      // (login) instead of inheriting the previous user's last location
      // (e.g., Profile / Edit Profile / Feedback board).
      try { sessionStorage.removeItem('huddle.lastScreen'); } catch(e){}
      // Reset in-memory state for every game's multiplayer subsystem
      cardLobbyMe.sessionId = null;
      cardLobbyMe.bootstrapped = false;
      if (typeof hotMe !== 'undefined') { hotMe.sessionId = null; hotMe.myId = null; hotMe.bootstrapped = false; }
      if (typeof chamMe !== 'undefined') { chamMe.sessionId = null; chamMe.myId = null; chamMe.bootstrapped = false; }
      // defaultProfile() was removed as part of the "Jordan Lee" auth fix —
      // signed-out state is now represented by a null profile. renderProfileScreen
      // and the lobby renderers are null-safe.
      myProfile = null;
      // Reset login screen back to default sign-in mode (in case user was in forgot/reset)
      huddleSetAuthMode('signin');
      // Clear any stale input values
      try {
        const emailEl = document.getElementById('email');
        const passEl = document.getElementById('password');
        const userEl = document.getElementById('login-username');
        if (emailEl) emailEl.value = '';
        if (passEl) passEl.value = '';
        if (userEl) userEl.value = '';
      } catch(e){}
      goTo('login');
    }

    // ---------- Supabase profile sync (Phase 1A — usernames) ----------
    // Strategy: localStorage stays as cache for fast paint + offline. Supabase is the
    // source of truth for username (so it can be UNIQUE across all users — Phase 1B uses
    // this to find friends by username). On app load we sync from Supabase down to local.
    // On Edit Profile save we sync from local up to Supabase, with uniqueness check.

    function huddleHasSupabaseAuth(){
      return !!(window.sb && cardLobbyMe.sessionId && !cardLobbyMe.sessionId.startsWith('tab_'));
    }

    function huddleClearUsernameStatus(){
      const el = document.getElementById('ep-username-status');
      if (el) { el.textContent = ''; el.className = 'ep-username-status'; }
    }
    function huddleSetUsernameStatus(text, kind){
      const el = document.getElementById('ep-username-status');
      if (!el) return;
      el.textContent = text;
      el.className = 'ep-username-status' + (kind ? ' ' + kind : '');
    }

    // Pull profile from Supabase into local cache. Runs on app load after auth resolves.
    // If no row exists yet, seeds one from the local cache (so any avatar/name the user
    // had in localStorage carries over to the server on first sync).
    async function huddleSyncProfileFromSupabase(){
      if (!huddleHasSupabaseAuth()) return;
      const userId = cardLobbyMe.sessionId;
      try {
        const { data, error } = await window.sb
          .from('profiles')
          .select('username, display_name, avatar')
          .eq('user_id', userId)
          .maybeSingle();
        if (error) { console.warn('[Huddle] profile fetch failed:', error.message); return; }
        if (data) {
          // Server row exists — server wins. Local cache picks up anything set elsewhere.
          myProfile = {
            name: data.display_name || myProfile.name,
            username: data.username || myProfile.username,
            avatar: data.avatar || myProfile.avatar,
          };
          saveProfile(myProfile);
          if (typeof renderProfileScreen === 'function') renderProfileScreen();
        } else {
          // No server row — seed from local cache. Never seed with the legacy
          // "Jordan Lee" placeholder (prior versions defaulted to it before the
          // user had really signed in, which produced the cross-user identity bug).
          if (!myProfile) return;
          const localName = (myProfile.name || '').trim();
          const localUsername = (myProfile.username || '').toLowerCase();
          const looksLikeLegacyName = !localName || localName === 'Jordan Lee';
          if (looksLikeLegacyName) return; // refuse to seed garbage
          const insertData = {
            user_id: userId,
            display_name: localName,
            avatar: myProfile.avatar,
          };
          if (localUsername && localUsername !== 'jordan' && localUsername !== 'you') {
            // Try to claim it. If it's already taken by someone else, fail silently —
            // user will be prompted to pick a different one in Edit Profile.
            insertData.username = localUsername;
          }
          const { error: insErr } = await window.sb
            .from('profiles')
            .insert(insertData);
          if (insErr) {
            // Most common cause: unique-violation on username. That's fine — they'll set
            // a fresh one from Edit Profile. Try again without username field.
            if (insErr.code === '23505' && insertData.username) {
              delete insertData.username;
              await window.sb.from('profiles').insert(insertData);
            } else if (insErr.code !== '23505') {
              console.warn('[Huddle] profile insert failed:', insErr.message);
            }
          }
        }
      } catch(e) {
        console.warn('[Huddle] profile sync exception:', e);
      }
    }

    function avatarForPlayer(player){
      if (player.id === state.meId && myProfile && myProfile.avatar) return myProfile.avatar;
      return deterministicAvatar(player.id);
    }
    function displayName(player){
      if (player.id === state.meId) {
        if (myProfile && myProfile.name) return myProfile.name.split(' ')[0] || 'You';
        return 'You';
      }
      return player.name;
    }

    // ---------- Stats ----------
    const STATS_KEY = 'huddle.stats';
    function loadStats(){
      try {
        const raw = localStorage.getItem(STATS_KEY);
        if (raw) {
          const p = JSON.parse(raw);
          return { games: p.games|0, wins: p.wins|0 };
        }
      } catch(e){}
      return { games: 0, wins: 0 };
    }
    function saveStats(s){
      try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch(e){}
    }
    let myStats = loadStats();
    function bumpGamesPlayed(){
      myStats.games += 1;
      saveStats(myStats);
      renderProfileScreen();
    }
    function bumpWins(){
      myStats.wins += 1;
      saveStats(myStats);
      renderProfileScreen();
    }

    // ---------- Render profile screen ----------
    function renderProfileScreen(){
      const slot = document.getElementById('profile-avatar-slot');
      const nameEl = document.getElementById('profile-name');
      const userEl = document.getElementById('profile-username');
      const authRow = document.getElementById('profile-auth-row');
      const authEmail = document.getElementById('profile-auth-email');
      // No real profile yet (visitor is not Google-signed-in) → blank out the
      // template fields so the screen doesn't flash a stale identity if the user
      // somehow lands here without auth.
      if (!myProfile) {
        if (slot) slot.innerHTML = '';
        if (nameEl) nameEl.textContent = '';
        if (userEl) userEl.textContent = '';
        if (authRow) authRow.hidden = true;
        if (authEmail) authEmail.textContent = '';
        return;
      }
      if (slot) slot.innerHTML = avatarHTML(myProfile.avatar, 96, { fallback: (myProfile.name || '?')[0] });
      if (nameEl) nameEl.textContent = myProfile.name || '';
      if (userEl) userEl.textContent = myProfile.username ? '@' + myProfile.username : '';
      const g = document.getElementById('stat-games');
      if (g) g.textContent = myStats.games;
      const w = document.getElementById('stat-wins');
      if (w) w.textContent = myStats.wins;
      parseEmoji(slot);
      // Show which auth account is signed in (Google email, etc.) above Sign out.
      // Skipped for anonymous sessions — those have no real identity to show.
      //
      // IMPORTANT: only POSITIVE answers (real user found) update the UI.
      // A `null` or anonymous response is treated as "unknown right now" — we
      // leave the previously rendered auth row + admin row alone. Real sign-out
      // is handled by the SIGNED_OUT auth state change listener below, NOT by
      // a transient getUser() blip during a token refresh. Otherwise tapping
      // Admin → Back would tear down the email + admin row mid-token-refresh
      // and the user would look "logged out" even though they're still signed in.
      const adminRow = document.getElementById('profile-admin-row');
      if (authRow && authEmail && window.sb) {
        window.sb.auth.getUser().then(({ data }) => {
          const u = data && data.user;
          if (!u || u.is_anonymous) {
            // Unknown / not-yet-resolved — leave UI as-is. Cached admin flag
            // (from previous successful render or localStorage) keeps the row
            // visible until SIGNED_OUT fires.
            return;
          }
          const email = u.email
            || (u.user_metadata && (u.user_metadata.email || u.user_metadata.preferred_username))
            || '';
          if (email) {
            authEmail.textContent = email;
            authRow.hidden = false;
          }
          // Server is the source of truth — call is_admin() RPC.
          // The email constant below is just a fast no-network early-out for
          // the common case (most users), so we don't ping the RPC for them.
          if (isHuddleAdmin(email)) {
            window.sb.rpc('is_admin').then(({ data: ok }) => {
              if (ok) setHuddleAdmin(true);
              // RPC returned false → DEFINITELY not admin. Otherwise (error /
              // network blip) keep the last known state — don't flicker.
              else if (ok === false) setHuddleAdmin(false);
            }).catch(() => {
              // Network or transient failure — keep last known state.
            });
          } else {
            setHuddleAdmin(false);
          }
        }).catch(() => {
          // Transient getUser failure — leave UI alone.
        });
      }
    }

    // ---------- Admin gate ----------
    // Two-layer gate:
    //   1. Server `public.is_admin()` (RLS-backed) is the AUTHORITATIVE check.
    //      Every admin write goes through Postgres policies that call it.
    //   2. `huddleIsAdmin` is a UI-only mirror — used to show/hide the admin
    //      menu row and bounce non-admins out of admin screens. Set from the
    //      server RPC after sign-in, cached in localStorage so a refresh
    //      stays on the admin screen without flickering through profile.
    //      Even if cached true for a demoted admin, RLS still rejects writes
    //      — the cache is purely a UI hint.
    const HUDDLE_ADMIN_EMAIL = 'saeedabdulaziz132@gmail.com';
    const HUDDLE_ADMIN_CACHE_KEY = 'huddle.isAdmin';
    let huddleIsAdmin = (function(){
      try { return localStorage.getItem(HUDDLE_ADMIN_CACHE_KEY) === '1'; }
      catch(e){ return false; }
    })();
    function isHuddleAdmin(email){
      return (email || '').trim().toLowerCase() === HUDDLE_ADMIN_EMAIL;
    }
    function setHuddleAdmin(on){
      huddleIsAdmin = !!on;
      try {
        if (huddleIsAdmin) localStorage.setItem(HUDDLE_ADMIN_CACHE_KEY, '1');
        else               localStorage.removeItem(HUDDLE_ADMIN_CACHE_KEY);
      } catch(e){}
      const adminRow = document.getElementById('profile-admin-row');
      if (adminRow) adminRow.hidden = !huddleIsAdmin;
      // If we just gained admin rights and we're on the admin panel, refresh
      // the "Feedback NEW count" badge.
      if (huddleIsAdmin && typeof adminRefreshFeedbackBadge === 'function') {
        adminRefreshFeedbackBadge();
      }
    }

    // ---------- Render lobby player tiles (real-multiplayer seat claim) ----------
    function renderLobbyPlayers(){
      const grid = document.getElementById('lobby-players-grid');
      if (!grid) return;
      // Skeleton while the room is hydrating from the server (URL says
      // we're in room X but state.code hasn't caught up). Avoids the
      // "everyone left!" flash that would otherwise show default invite
      // tiles for ~500ms after a hard refresh on a lobby URL.
      if (huddleLobbyHydrating(state.code)) {
        grid.innerHTML = huddleLobbySkeletonHTML(20);
        return;
      }
      const sessionId = hotGetSessionId();
      const claimedCount = hotClaimedCount();
      // Resolve real profiles for any claimed sessions we haven't fetched yet
      const claimedSessionIds = Object.values(state.claimedBy || {});
      ensureClaimantProfiles(claimedSessionIds, renderLobbyPlayers);
      // My display name — prefer @username (globally unique) so two players
      // with the same first name still render distinctly across the table.
      // Falls through to display_name first-word, then to the slot placeholder.
      const myName = (myProfile && myProfile.username)
        ? '@' + myProfile.username
        : ((myProfile && myProfile.name && myProfile.name.trim().split(/\s+/)[0]) || t('lobby.seatYou'));
      const myAvatar = (myProfile && myProfile.avatar) ? myProfile.avatar : null;
      grid.innerHTML = state.players.map((p, i) => {
        const claimedSession = state.claimedBy && state.claimedBy[p.id];
        const claimedByMe = claimedSession === sessionId;
        const claimedByOther = !!claimedSession && !claimedByMe;
        const isHostSeat = !!claimedSession && claimedSession === state.hostId;
        const claimProfile = claimedByOther ? profileForClaim(claimedSession) : null;

        // Empty seat → render an Invite tile (not a claim button). Tapping it
        // opens the shared invite sheet so the user fills the seat with a real
        // friend instead of "claiming" a fake-named slot.
        if (!claimedSession) {
          return `
            <div class="player-tile hot-seat-tile invite-tile" data-action="openLobbyInviteSheet" data-arg="hotseat">
              <span class="invite-plus" aria-hidden="true">+</span>
              <div class="player-tile-name" data-i18n="liar.seatInviteTap">Invite friend</div>
              <div class="player-tile-status" data-i18n="liar.seatEmpty">Empty seat</div>
            </div>
          `;
        }

        // Claimed seat — render with the claimant's REAL identity (no Maria/Kenji).
        let cls = 'player-tile hot-seat-tile';
        let statusText, nameText, avatarData;
        if (claimedByMe) {
          cls += ' claimed-by-me';
          nameText = myName;
          statusText = isHostSeat ? t('lobby.host') : t('lobby.seatYou');
          avatarData = myAvatar || avatarForPlayer(p);
        } else {
          cls += ' claimed-by-other';
          nameText = claimDisplayName(claimProfile, '…');
          statusText = isHostSeat ? t('lobby.host') : t('lobby.seatTaken');
          avatarData = (claimProfile && claimProfile.avatar) ? claimProfile.avatar : avatarForPlayer(p);
        }
        // Presence-driven dot + "Away" label (Batch 2): a claimed seat whose
        // player has backgrounded/locked their phone shows 💤 Away instead of a
        // green dot — so the host can see who to keep waiting for or remove.
        const isPresent = claimedByMe || (typeof hotIsPlayerPresent === 'function' && hotIsPlayerPresent(p.id));
        const avatar = avatarHTML(avatarData, 32, { online: isPresent, fallback: p.initial });
        const kick = (claimedByOther && typeof hotIsHost === 'function' && hotIsHost()) ? huddleKickBtnHTML('hot', p.id) : '';
        return `
          <div class="${cls}">
            ${avatar}
            <div class="player-tile-name">${escapeHTML(nameText)}</div>
            <div class="player-tile-status">${escapeHTML(isPresent ? statusText : t('lobby.away'))}</div>
            ${kick}
          </div>
        `;
      }).join('');
      parseEmoji(grid);
      if (typeof applyLang === 'function') applyLang();
      try { huddleUpdateLockBtn('hot-lock-btn', 'hot', (typeof hotIsHost === 'function' && hotIsHost())); } catch(e){}

      const playersTitle = document.getElementById('lobby-players-title');
      if (playersTitle) playersTitle.textContent = t('lobby.playersCount', { count: claimedCount });

      // Hint + start-button state
      const hint = document.getElementById('hot-seats-hint');
      const startBtn = document.getElementById('hot-start-btn');
      const amHost = hotIsHost();
      if (hint) {
        if (!hotMe.myId) hint.textContent = t('lobby.seatsHintNotPicked');
        else if (claimedCount < 2) hint.textContent = t('lobby.seatsHintNeedMore', { n: 2 - claimedCount });
        else if (!amHost) hint.textContent = t('lobby.seatsHintWaitingHost');
        else hint.textContent = t('lobby.seatsHintReady');
      }
      if (startBtn) {
        const canStart = claimedCount >= 2 && !!hotMe.myId && amHost;
        // aria-disabled (not native disabled) — the button must still fire
        // clicks when "disabled" so we can surface the hint text as a toast.
        // Validation backstop lives inside startGame().
        if (canStart) startBtn.removeAttribute('aria-disabled');
        else          startBtn.setAttribute('aria-disabled', 'true');
      }
      // Leave / Reset moved to top-right of the Players header (no more bottom actions)
      const leaveBtn = document.getElementById('hot-leave-btn');
      const hasSeat = !!hotMe.myId;
      if (leaveBtn) leaveBtn.hidden = !hasSeat;
      // Refresh shared invite sheet if it's open for hotseat
      if (typeof refreshLobbyInviteSheetIfOpen === 'function') refreshLobbyInviteSheetIfOpen('hotseat');
    }

    // ---------- Hot Seat: leave room / reset other players ----------
    async function hotLeaveRoom(){
      return huddleLeaveRoom({
        meObj: hotMe, gameState: state, sidFn: hotGetSessionId,
        table: 'hotseat_rooms', gameToken: 'hotseat', lastRoomKey: 'hotseat',
        teardown: () => {
          state.meId = null;
          if (_hotChannel) {
            try { _hotChannel.untrack(); } catch(e){}
            try { window.sb.removeChannel(_hotChannel); } catch(e){}
            _hotChannel = null; _hotChannelCode = null; _hotChannelSessionId = null;
            hotResetPresenceState();
          }
        },
      });
    }
    // Local-only cleanup — used when (a) host closes the room and we need to
    // bail without writing more state to Supabase, and (b) a non-host receives
    // a "closedByHost" broadcast and auto-leaves. Does NOT persist anything.
    function hotForceLeaveLocal(){
      hotMe.myId = null;
      if (state) {
        state.meId = null;
        state.code = null;
      }
      try { huddleClearLastRoom('hotseat'); } catch(e){}
      if (_hotChannel) {
        try { _hotChannel.untrack(); } catch(e){}
        try { window.sb.removeChannel(_hotChannel); } catch(e){}
        _hotChannel = null; _hotChannelCode = null; _hotChannelSessionId = null;
        hotResetPresenceState();
      }
      try { history.replaceState(history.state, '', '/'); } catch(e){}
      goTo('games');
    }
    // Host taps "Leave" on the game-over screen → close the whole room so
    // every other player auto-leaves too (they see closedByHost via Realtime).
    function hotCloseRoom(){
      if (!hotIsHost()) { hotLeaveGameOver(); return; }
      const closingCode = state.code;
      // Optimistic local change so UI reflects "closed" immediately.
      state.closedByHost = true;
      state.hostId = null;
      // Server-validated close (host-only at DB layer) — C2 turn 4a.
      if (closingCode) {
        huddleCallRPC('huddle_close_room', { p_table: 'hotseat_rooms', p_code: closingCode });
      }
      hotForceLeaveLocal();
    }
    // Host taps "Play again" on the game-over screen → reset round/scores and
    // restart. Other players sync to the new splash phase via Realtime.
    function hotPlayAgain(){
      if (!hotIsHost()) return;
      if (hotClaimedCount() < 2) return;
      state.closedByHost = false;
      startGame();
    }
    // Same cleanup as hotLeaveRoom but skips the confirm dialog — used by the
    // game-over screen so a finished match doesn't trap the player in a stale
    // room (phase='result' would otherwise reload the same end screen next time
    // they open Hot Seat).
    function hotLeaveGameOver(){
      const mySid = hotGetSessionId();
      const myPlayerId = hotMe.myId;
      const leavingCode = state.code;
      // Optimistic local update (C2 turn 4a).
      if (myPlayerId && state.claimedBy && state.claimedBy[myPlayerId] === mySid) {
        delete state.claimedBy[myPlayerId];
      }
      if (state.hostId === mySid) {
        const remaining = Object.entries(state.claimedBy || {})
          .sort((a, b) => a[0].localeCompare(b[0]));
        state.hostId = remaining.length ? remaining[0][1] : null;
      }
      // Server-validated leave (mirrors hotLeaveRoom RPC pattern).
      if (leavingCode) {
        huddleCallRPC('huddle_leave_seat', { p_table: 'hotseat_rooms', p_code: leavingCode });
      }
      hotMe.myId = null;
      state.meId = null;
      state.code = null;
      try { huddleClearLastRoom('hotseat'); } catch(e){}
      if (_hotChannel) {
        try { _hotChannel.untrack(); } catch(e){}
        try { window.sb.removeChannel(_hotChannel); } catch(e){}
        _hotChannel = null; _hotChannelCode = null; _hotChannelSessionId = null;
        hotResetPresenceState();
      }
      try { history.replaceState(history.state, '', '/'); } catch(e){}
      goTo('games');
    }

    // ---------- Custom confirm dialog (replaces native confirm) ----------
    // Promise-based. Usage: const ok = await huddleConfirm({title, body, confirmLabel, cancelLabel, danger});
    let _hcResolver = null;
    function huddleConfirm(opts){
      opts = opts || {};
      const backdrop = document.getElementById('hc-backdrop');
      const titleEl  = document.getElementById('hc-title');
      const bodyEl   = document.getElementById('hc-body');
      const cancelEl = document.getElementById('hc-cancel');
      const confEl   = document.getElementById('hc-confirm');
      if (!backdrop || !titleEl || !bodyEl || !cancelEl || !confEl) {
        return Promise.resolve(window.confirm(opts.body || opts.title || ''));
      }
      titleEl.textContent = opts.title || '';
      bodyEl.textContent  = opts.body  || '';
      cancelEl.textContent = opts.cancelLabel || t('common.cancel') || 'Cancel';
      confEl.textContent   = opts.confirmLabel || t('common.confirm') || 'Confirm';
      confEl.classList.toggle('is-danger', !!opts.danger);
      backdrop.classList.add('active');
      // If a previous dialog is somehow still open, resolve it as cancelled first.
      if (_hcResolver) { try { _hcResolver(false); } catch(e){} _hcResolver = null; }
      return new Promise(resolve => { _hcResolver = resolve; });
    }
    function huddleConfirmResolve(value){
      const backdrop = document.getElementById('hc-backdrop');
      if (backdrop) backdrop.classList.remove('active');
      const r = _hcResolver; _hcResolver = null;
      if (r) r(!!value);
    }
    function huddleConfirmBackdropClick(e){
      if (!e || !e.target) return;
      if (e.target.id === 'hc-backdrop') huddleConfirmResolve(false);
    }
    // ESC key dismisses
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const backdrop = document.getElementById('hc-backdrop');
      if (backdrop && backdrop.classList.contains('active')) huddleConfirmResolve(false);
    });

    // ---------- Claimant profile cache (real-multiplayer seat display) ----------
    // Maps a sessionId (Supabase auth.uid for signed-in users) → profile row
    // (or null while a fetch is in flight). Lobby render fns look up real
    // display_name + avatar so claimed seats stop showing slot placeholders
    // like "Jordan" / "Alex" after a friend joins.
    const claimantProfiles = new Map();
    async function ensureClaimantProfiles(sessionIds, rerenderFn){
      if (!window.sb || !sessionIds || sessionIds.length === 0) return;
      const missing = sessionIds.filter(id => id && !claimantProfiles.has(id) && /^[0-9a-f-]{30,}$/i.test(id));
      if (missing.length === 0) return;
      // Mark them as "loading" with a null placeholder to avoid duplicate fetches
      missing.forEach(id => claimantProfiles.set(id, null));
      try {
        const { data } = await window.sb
          .from('profiles')
          .select('user_id, username, display_name, avatar')
          .in('user_id', missing);
        if (data) data.forEach(p => claimantProfiles.set(p.user_id, p));
        if (typeof rerenderFn === 'function') rerenderFn();
      } catch(e) { console.warn('[Huddle] ensureClaimantProfiles failed:', e); }
    }
    // Resolve a guest's typed name (no-account players who joined via the login
    // screen). It lives in the room state's `guestNames` map keyed by the
    // claimant's auth uid, mirrored on whichever game state is loaded — all four
    // game states are globals, so we scan them and return the first match.
    function huddleGuestNameFor(sessionId){
      if (!sessionId) return null;
      const states = [
        (typeof state !== 'undefined') ? state : null,
        (typeof cardLobbyState !== 'undefined') ? cardLobbyState : null,
        (typeof chamState !== 'undefined') ? chamState : null,
        (typeof mafiaState !== 'undefined') ? mafiaState : null,
      ];
      for (let i = 0; i < states.length; i++){
        const gn = states[i] && states[i].guestNames && states[i].guestNames[sessionId];
        if (gn) return String(gn);
      }
      return null;
    }
    function profileForClaim(sessionId){
      if (!sessionId) return null;
      const real = claimantProfiles.get(sessionId);
      // A real profile only WINS if it actually carries a name. Anonymous
      // players get a blank profile row (display_name '', no username); that
      // must NOT shadow the name they typed on the join screen — otherwise the
      // typed name shows for a moment, then the blank row loads and blanks it.
      const realHasName = !!(real && (real.username || (real.display_name && real.display_name.trim())));
      if (realHasName) return real;
      // Otherwise surface a guest's typed name as a minimal profile, so it flows
      // through the same claimDisplayName / playerDisplayFor path as real names.
      const gn = huddleGuestNameFor(sessionId);
      if (gn) return { display_name: gn, guest: true };
      // No usable name anywhere → hand back the (nameless) real row if present,
      // else null; callers fall back to the neutral "Player" placeholder.
      return real || null;
    }
    function claimDisplayName(profile, slotPlaceholder){
      if (!profile) return slotPlaceholder;
      // Prefer @username over display_name — usernames are globally unique
      // by Supabase constraint, so two players named "Saeed" still render
      // distinctly as "@saeed1" and "@saeed_h". Falls through to display_name
      // (first word only) if no username is set, then to the slot placeholder.
      if (profile.username) return '@' + profile.username;
      if (profile.display_name && profile.display_name.trim()) return profile.display_name.split(' ')[0];
      return slotPlaceholder;
    }
    // Gameplay helper — for a slot `player`, look up the real claimant's
    // display name + avatar. Returns the seat template name ("Jordan", "Maria"…)
    // ONLY for UNCLAIMED seats (lobby state where the template label is meaningful).
    // Claimed seats with no profile loaded (anonymous sessions, post-disconnect
    // stragglers) get a neutral "Player" — never a template name leak.
    // The caller is still responsible for the "if (player.id === meId) show 'You'" branch.
    function playerDisplayFor(player, claimedByMap){
      const sid = claimedByMap && player ? claimedByMap[player.id] : null;
      const profile = sid ? profileForClaim(sid) : null;
      let name;
      if (profile) {
        name = claimDisplayName(profile, player ? player.name : '');
      } else if (sid) {
        // Claimed but no profile in claimantProfiles. Don't leak the template
        // seat name into the UI — show a neutral "Player" instead.
        name = (typeof t === 'function' && t('common.otherPlayer')) || 'Player';
      } else {
        // Truly unclaimed seat — template name is the right label.
        name = player ? player.name : '';
      }
      const avatar = (profile && profile.avatar) ? profile.avatar : (player ? avatarForPlayer(player) : null);
      return { name, avatar, profile, sessionId: sid };
    }

