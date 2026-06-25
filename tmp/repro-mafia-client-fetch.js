// Verify the role-fetch fix THROUGH the app's huddleCallRPC wrapper (the path
// the real app uses), not raw sb.rpc. Sets up a real 6-user Cards game, then:
//  (a) dumps the huddleCallRPC return SHAPE for the two role reads — proving the
//      old code (result.role / result.roles) read undefined while the fixed code
//      (res.data.role / res.data.roles) reads the value;
//  (b) if the internal fetch fns are reachable, calls them and checks mafiaMe.
// Run:  node tmp/repro-mafia-client-fetch.js
// Throwaway diagnostic. Safe to delete.

const { chromium } = require('@playwright/test');
const URL = 'http://localhost:5173/';
const TABLE = 'mafia_rooms';
function code4(){ const A='ABCDEFGHJKLMNPQRSTUVWXYZ'; let s=''; for(let i=0;i<4;i++) s+=A[Math.floor(Math.random()*A.length)]; return s; }

async function newUser(browser){
  const ctx = await browser.newContext({ viewport:{width:390,height:780} });
  const page = await ctx.newPage();
  await page.goto(URL,{waitUntil:'domcontentloaded',timeout:20000});
  await page.waitForFunction(()=>!!(window.sb&&window.sb.auth&&typeof huddleCallRPC==='function'),null,{timeout:15000});
  const uid = await page.evaluate(async()=>{ let u=await window.sb.auth.getUser(); if(!(u&&u.data&&u.data.user)){ await window.sb.auth.signInAnonymously(); u=await window.sb.auth.getUser(); } return u.data.user.id; });
  return { ctx, page, uid };
}
async function raw(page, fn, args){ return page.evaluate(async([fn,args])=>{ try{ const r=await window.sb.rpc(fn,args); return {data:r.data,errMsg:r.error&&r.error.message}; }catch(e){ return {threw:String(e)}; } },[fn,args]); }

(async()=>{
  const browser = await chromium.launch({ headless:true });
  const users=[];
  try{
    const CODE=code4(); console.log('Room code:',CODE);
    for(let i=0;i<6;i++) users.push(await newUser(browser));
    const host=users[0];
    const initial = await host.page.evaluate((uid)=>({phase:'lobby',hostId:uid,narratorUid:null,claimedBy:{p1:uid},aliveIds:[],deadIds:[],round:0,killTarget:null,saveTarget:null,detectiveTarget:null,voteTally:{},votedBy:{},beatId:null,readyBy:{},winner:null,roleReveal:{},revision:0}),host.uid);
    await raw(host.page,'huddle_create_room',{p_table:TABLE,p_code:CODE,p_initial_state:initial});
    for(let i=1;i<=5;i++){ await raw(users[i].page,'huddle_claim_seat',{p_table:TABLE,p_code:CODE,p_player_id:'p'+(i+1)}); }
    await raw(host.page,'huddle_mafia_set_narrator',{p_code:CODE,p_narrator_seat:'p1'});
    await raw(host.page,'huddle_mafia_start_game',{p_code:CODE,p_include_detective:true,p_include_child:false,p_include_mafia_leader:false,p_variant:'cards'});
    console.log('game set up (phase=rules, roles assigned)\n');

    // (a) SHAPE via the app wrapper huddleCallRPC ----------------------------
    const narWrap = await host.page.evaluate(async(code)=>{ const r=await huddleCallRPC('huddle_mafia_get_narrator_state',{p_code:code}); return { topLevel_roles: r && r.roles, data_roles: r && r.data && r.data.roles, keys:Object.keys(r||{}) }; }, CODE);
    console.log('NARRATOR huddleCallRPC -> keys:',JSON.stringify(narWrap.keys));
    console.log('   r.roles (OLD code read):',JSON.stringify(narWrap.topLevel_roles),' <- undefined = OLD BUG');
    console.log('   r.data.roles (FIXED read):',JSON.stringify(narWrap.data_roles));

    const p2 = users[1];
    const myWrap = await p2.page.evaluate(async(code)=>{ const r=await huddleCallRPC('huddle_mafia_get_my_role',{p_code:code}); return { topLevel_role: r && r.role, data_role: r && r.data && r.data.role, keys:Object.keys(r||{}) }; }, CODE);
    console.log('\nPLAYER p2 huddleCallRPC -> keys:',JSON.stringify(myWrap.keys));
    console.log('   r.role (OLD code read):',JSON.stringify(myWrap.topLevel_role),' <- undefined = OLD BUG');
    console.log('   r.data.role (FIXED read):',JSON.stringify(myWrap.data_role));

    // (b) Exercise the ACTUAL fixed client fns if reachable ------------------
    const narClient = await host.page.evaluate(async(code)=>{
      if (typeof mafiaFetchNarratorState !== 'function') return 'fn-not-global';
      try { mafiaState.code = code; mafiaMe.narratorRoles = null; await mafiaFetchNarratorState(true); return { narratorRoles: mafiaMe.narratorRoles }; } catch(e){ return 'ERR '+String(e); }
    }, CODE);
    console.log('\nFIXED mafiaFetchNarratorState() -> mafiaMe.narratorRoles:',JSON.stringify(narClient));

    const myClient = await p2.page.evaluate(async(code)=>{
      if (typeof mafiaFetchMyRole !== 'function') return 'fn-not-global';
      try { mafiaState.code = code; mafiaMe.myRole = null; await mafiaFetchMyRole(true); return { myRole: mafiaMe.myRole, teammates: mafiaMe.myTeammates }; } catch(e){ return 'ERR '+String(e); }
    }, CODE);
    console.log('FIXED mafiaFetchMyRole() (p2) -> mafiaMe.myRole:',JSON.stringify(myClient));

    console.log('\nVERDICT: fix works if r.data.* has the values AND the FIXED client fns populated mafiaMe.');
  }catch(e){ console.error('FATAL',e); }
  finally{ for(const u of users){ try{await u.ctx.close();}catch(_){} } await browser.close(); }
})();
