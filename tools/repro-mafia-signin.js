// Diagnostic repro: host changes identity mid-lobby (the anon -> Google sign-in
// flow) and we check whether the narrator can still load roles afterwards.
// Simulates the identity change with a SECOND anonymous sign-in (new auth.uid)
// + the same huddle_migrate_seat call the app makes on sign-in.
// Run:  node tools/repro-mafia-signin.js
// Throwaway diagnostic. Safe to delete.

const { chromium } = require('@playwright/test');
const URL = 'http://localhost:5173/';
const TABLE = 'mafia_rooms';

function code4(){ const A='ABCDEFGHJKLMNPQRSTUVWXYZ'; let s=''; for(let i=0;i<4;i++) s+=A[Math.floor(Math.random()*A.length)]; return s; }

async function newUser(browser){
  const ctx = await browser.newContext({ viewport:{width:390,height:780} });
  const page = await ctx.newPage();
  await page.goto(URL,{waitUntil:'domcontentloaded',timeout:20000});
  await page.waitForFunction(()=>!!(window.sb&&window.sb.auth),null,{timeout:15000});
  const uid = await page.evaluate(async()=>{ let u=await window.sb.auth.getUser(); if(!(u&&u.data&&u.data.user)){ await window.sb.auth.signInAnonymously(); u=await window.sb.auth.getUser(); } return u.data.user.id; });
  return { ctx, page, uid };
}
async function rpc(page, fn, args){
  return page.evaluate(async([fn,args])=>{ try{ const r=await window.sb.rpc(fn,args); return {data:r.data,errMsg:r.error&&r.error.message,errCode:r.error&&r.error.code}; }catch(e){ return {threw:String(e)}; } },[fn,args]);
}

(async()=>{
  const browser = await chromium.launch({ headless:true });
  const users=[];
  try{
    const CODE=code4(); console.log('Room code:',CODE);
    for(let i=0;i<6;i++) users.push(await newUser(browser));
    const host=users[0];
    const A1=host.uid; console.log('host anon id A1 =',A1);

    const initial = await host.page.evaluate((uid)=>({phase:'lobby',hostId:uid,narratorUid:null,claimedBy:{p1:uid},aliveIds:[],deadIds:[],round:0,killTarget:null,saveTarget:null,detectiveTarget:null,voteTally:{},votedBy:{},beatId:null,readyBy:{},winner:null,roleReveal:{},revision:0}),A1);
    console.log('create_room:',JSON.stringify((await rpc(host.page,'huddle_create_room',{p_table:TABLE,p_code:CODE,p_initial_state:initial})).errMsg||'ok'));
    for(let i=1;i<=5;i++){ await rpc(users[i].page,'huddle_claim_seat',{p_table:TABLE,p_code:CODE,p_player_id:'p'+(i+1)}); }
    console.log('set_narrator(p1):',JSON.stringify((await rpc(host.page,'huddle_mafia_set_narrator',{p_code:CODE,p_narrator_seat:'p1'})).data||'?'));

    // === Host "signs in" → new auth.uid (A2). The app then calls migrate_seat(from=A1). ===
    const A2 = await host.page.evaluate(async()=>{ await window.sb.auth.signInAnonymously(); const u=await window.sb.auth.getUser(); return u.data.user.id; });
    console.log('host NEW id A2 =',A2,'(changed:',A1!==A2,')');
    const mig = await rpc(host.page,'huddle_migrate_seat',{p_table:TABLE,p_code:CODE,p_from_session_id:A1});
    console.log('migrate_seat -> hostId=',mig.data&&mig.data.hostId,' narratorUid=',mig.data&&mig.data.narratorUid,' claimedBy.p1=',mig.data&&mig.data.claimedBy&&mig.data.claimedBy.p1);
    console.log('   (BUG if narratorUid still == A1 while p1/hostId == A2)');

    console.log('start_game:',JSON.stringify((await rpc(host.page,'huddle_mafia_start_game',{p_code:CODE,p_include_detective:true,p_include_child:false,p_include_mafia_leader:false,p_variant:'cards'})).errMsg||'ok'));

    const nar = await rpc(host.page,'huddle_mafia_get_narrator_state',{p_code:CODE});
    console.log('\n>>> get_narrator_state as host(A2):', JSON.stringify(nar.errMsg?('ERROR '+nar.errCode+' '+nar.errMsg):nar.data));
    console.log('    EXPECTED-IF-BUG: error not_authorized/not_narrator (narratorUid=A1 != A2) => empty "Loading roles" dashboard');
  }catch(e){ console.error('FATAL',e); }
  finally{ for(const u of users){ try{await u.ctx.close();}catch(_){} } await browser.close(); }
})();
