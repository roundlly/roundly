// Diagnostic: what happens when a Mafia player / narrator RELOADS mid-game
// (phone closed / refresh). Sets up a real game, then reloads each role's page
// with ?room= in the URL (the real reconnect entry) and reports the screen +
// whether the guest-name sheet or "Game ended" overlay blocks them.
// Run:  node tmp/repro-mafia-reconnect.js
// Throwaway diagnostic.

const { chromium } = require('@playwright/test');
const URL = 'http://localhost:5173/';
const TABLE = 'mafia_rooms';
function code4(){ const A='ABCDEFGHJKLMNPQRSTUVWXYZ'; let s=''; for(let i=0;i<4;i++) s+=A[Math.floor(Math.random()*A.length)]; return s; }
async function newUser(browser){
  const ctx = await browser.newContext({ viewport:{width:390,height:780} });
  const page = await ctx.newPage();
  await page.goto(URL,{waitUntil:'domcontentloaded',timeout:20000});
  await page.waitForFunction(()=>!!(window.sb&&window.sb.auth&&typeof huddleCallRPC==='function'),null,{timeout:15000});
  const uid = await page.evaluate(async()=>{
    for (let i=0;i<12;i++){
      let u = await window.sb.auth.getUser();
      if (u && u.data && u.data.user) return u.data.user.id;
      const s = await window.sb.auth.signInAnonymously();
      if (s && s.data && s.data.user) return s.data.user.id;
      await new Promise(r=>setTimeout(r,300));
    }
    return null;
  });
  return { ctx, page, uid };
}
async function raw(page, fn, args){ return page.evaluate(async([fn,args])=>{ try{ const r=await window.sb.rpc(fn,args); return {data:r.data,errMsg:r.error&&r.error.message}; }catch(e){ return {threw:String(e)}; } },[fn,args]); }
async function snapshot(page){
  return page.evaluate(()=>{
    const active = document.querySelector('.screen.active');
    const nameBd = document.getElementById('guest-name-backdrop');
    const ended = document.getElementById('mafia-cards-ended-overlay');
    const roster = document.getElementById('mafia-cards-narrator-roster');
    return {
      screen: active ? active.id : 'none',
      guestNamePromptVisible: !!(nameBd && (nameBd.classList.contains('active') || nameBd.classList.contains('show') || (!nameBd.hidden && getComputedStyle(nameBd).display!=='none'))),
      endedOverlayVisible: !!(ended && !ended.hidden),
      rosterText: roster ? roster.textContent.trim().slice(0,40) : null,
      myId: (typeof mafiaMe!=='undefined') ? mafiaMe.myId : '?',
      phase: (typeof mafiaState!=='undefined') ? mafiaState.phase : '?',
    };
  });
}

(async()=>{
  const browser = await chromium.launch({ headless:true });
  const users=[];
  try{
    const CODE=code4(); console.log('Room code:',CODE);
    for(let i=0;i<6;i++) users.push(await newUser(browser));
    const host=users[0];
    const initial = await host.page.evaluate(([uid,code])=>({code:code,phase:'lobby',hostId:uid,narratorUid:null,claimedBy:{p1:uid},aliveIds:[],deadIds:[],round:0,killTarget:null,saveTarget:null,detectiveTarget:null,voteTally:{},votedBy:{},beatId:null,readyBy:{},winner:null,roleReveal:{},revision:0}),[host.uid,CODE]);
    await raw(host.page,'huddle_create_room',{p_table:TABLE,p_code:CODE,p_initial_state:initial});
    for(let i=1;i<=5;i++){ await raw(users[i].page,'huddle_claim_seat',{p_table:TABLE,p_code:CODE,p_player_id:'p'+(i+1)}); }
    await raw(host.page,'huddle_mafia_set_narrator',{p_code:CODE,p_narrator_seat:'p1'});
    await raw(host.page,'huddle_mafia_start_game',{p_code:CODE,p_include_detective:true,p_include_child:false,p_include_mafia_leader:false,p_variant:'cards'});
    console.log('game set up (phase=rules, narrator=p1=host)\n');

    const roomUrl = URL + '?room=' + CODE + '&game=mafia';

    // NARRATOR enters mid-game with NO persisted state yet → expected: overlay
    // (this is the pre-fix behavior for a tab that didn't start the game).
    console.log('--- NARRATOR first entry (no persisted state) ---');
    await host.page.goto(roomUrl, { waitUntil:'domcontentloaded' });
    await host.page.waitForTimeout(3000);
    console.log('  ', JSON.stringify(await snapshot(host.page)));

    // Validate the PERSIST half: the real persist fn writes this room's state.
    const wrote = await host.page.evaluate((c)=>{
      mafiaState.code = c;
      mafiaCardsDeadPlayers.clear(); mafiaCardsDeadPlayers.add('p3');
      mafiaCardsLocalPhase = 'day'; mafiaCardsHasSeenDay = true;
      mafiaCardsPersistNarratorLocalState();
      return localStorage.getItem('huddle.mafia.narr.'+c);
    }, CODE);
    console.log('  PERSIST wrote:', wrote);

    // RELOAD → the RESTORE half should resume the dashboard (no overlay) with the
    // dead set + Night/Day intact.
    console.log('--- NARRATOR reload (refresh / phone reopen) ---');
    await host.page.goto(roomUrl, { waitUntil:'domcontentloaded' });
    await host.page.waitForTimeout(3500);
    const narReload = await snapshot(host.page);
    const restored = await host.page.evaluate(()=>{ try{ return { dead:Array.from(mafiaCardsDeadPlayers), phase:mafiaCardsLocalPhase }; }catch(e){ return '?'; } });
    console.log('  ', JSON.stringify(narReload), 'restored=', JSON.stringify(restored));
    const diag = await host.page.evaluate((c)=>{
      const r = {};
      try {
        r.ls = localStorage.getItem('huddle.mafia.narr.'+c);
        r.codeNow = (typeof mafiaState!=='undefined') ? mafiaState.code : '?';
        r.restoreFnType = typeof mafiaCardsRestoreNarratorLocalState;
        r.keyFnType = typeof mafiaCardsNarratorStateKey;
        r.keyFn = (typeof mafiaCardsNarratorStateKey==='function') ? mafiaCardsNarratorStateKey() : '?';
        if (typeof mafiaCardsRestoreNarratorLocalState==='function') {
          r.manualRestoreRet = mafiaCardsRestoreNarratorLocalState();
          r.deadAfterManual = Array.from(mafiaCardsDeadPlayers);
        }
      } catch(e){ r.err = String(e); }
      return r;
    }, CODE);
    console.log('  DIAG:', JSON.stringify(diag));

    // PLAYER p2 reloads into the game URL (simulates refresh / reopen).
    console.log('\n--- PLAYER p2 reload into game URL ---');
    await users[1].page.goto(roomUrl, { waitUntil:'domcontentloaded' });
    await users[1].page.waitForTimeout(3500);
    console.log(JSON.stringify(await snapshot(users[1].page), null, 0));

    console.log('\nINTERPRET: guestNamePromptVisible=true => re-prompted for name on reconnect (BUG).');
    console.log('           endedOverlayVisible=true on narrator => "Game ended" blocks narrator reconnect (BUG).');
    console.log('           screen=screen-login/games => bounced out, cannot return (BUG).');
  }catch(e){ console.error('FATAL',e); }
  finally{ for(const u of users){ try{await u.ctx.close();}catch(_){} } await browser.close(); }
})();
