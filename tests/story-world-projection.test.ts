import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {stageSnapshot} from './helpers/story-stage.ts';
import type {SceneOptions} from '../src/scenes/world-scene.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'?{url:'data:text/javascript,export default {Scene:class{},Physics:{Arcade:{Body:class{}}},BlendModes:{NORMAL:0,ADD:1,MULTIPLY:2,SCREEN:3}}',shortCircuit:true}:next(specifier,context);}});
const {WorldScene}=await import('../src/scenes/world-scene.ts');
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
hook.deregister();

function fixture(){
  let location:undefined|{map:string;x:number;y:number;facing:'south'};
  let stageActive=true;let worldCovered=true;let projected:unknown[]=[];let lastRestart:SceneOptions|undefined;
  const assetLoads:unknown[][]=[],coverCalls:boolean[]=[];
  const player={container:{active:true,x:10,y:20},entity:{id:'player'}};
  const positions:unknown[]=[],adopted:unknown[][]=[];let restarts=0,stops=0,regroups=0;
  const state={map:{id:'home',name:'Home'},player,baseEntities:[],characters:[] as unknown[],entities:[],storyEntityAssets:[],projectedActorIds:new Set(),destroyed:false,
    app:{campaign:{placements:[]},session:{storyWorld:{get currentLocation(){return location;},projectEntities:()=>projected,actorAppearance:(actor:string)=>actor,entity:()=>undefined},visible:()=>true},world:{actors:{} as Record<string,unknown>},ui:{setWorldRebuildCover:(covered:boolean)=>{coverCalls.push(covered);}}},
    movement:{placeAll:(values:{position:{x:number;y:number}}[])=>{positions.push(values);for(const value of values){player.container.x=value.position.x;player.container.y=value.position.y;}}},
    combat:{regroupPartyAroundHero(){regroups++;},async projectStoryEnemies(){},async restoreState(){},adoptStoryPositions(actors:unknown[]){adopted.push(actors);}},
    loadAssets:async(...args:unknown[])=>{assetLoads.push(args);return {release(){}};},refreshState(){},syncHud(){},setClip(){},syncControlledCharacter(){},
    entryPrefetches:new Map(),prefetchStoryEntry:async()=>{},
    scene:{isActive(){return stageActive;},get(){return {worldCovered};},restart(options:SceneOptions){restarts++;lastRestart=options;options.onReady?.();},stop(){stops++;}}
  };
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  return {scene,state,positions,adopted,location:(value:typeof location)=>{location=value;},stageActive:(value:boolean)=>{stageActive=value;},covered:(value:boolean)=>{worldCovered=value;},coverCalls:()=>coverCalls,projected:(value:unknown[])=>{projected=value;},restarts:()=>restarts,stops:()=>stops,regroups:()=>regroups,lastRestart:()=>lastRestart,assetLoads};
}

test('a cinematic stage cannot travel the formal map or adopt uncommitted player positions',async()=>{
  const f=fixture();
  await f.scene.projectStoryWorld(stageSnapshot({type:'stage',map:'movie-map',x:200,y:300,facing:'south',playerVisible:true,cast:[]}),new AbortController().signal);
  assert.equal(f.restarts(),0);assert.deepEqual([f.state.player.container.x,f.state.player.container.y],[10,20]);
});

test('same-map projection adopts surviving combat actors after ordinary world projection',async()=>{
  const f=fixture(),performed=stageSnapshot({type:'stage',map:'home',x:10,y:20,facing:'south',playerVisible:true,cast:[]});
  performed.scene.actors.push({id:'member:ally',actor:'ally',memberId:'ally',x:50,y:60,facing:'east',visible:true});
  await f.scene.projectStoryWorld(performed,new AbortController().signal);
  assert.deepEqual(f.adopted,[performed.scene.actors]);
});

test('a committed travel position projects once and subsequent nodes retain ordinary movement',async()=>{
  const f=fixture();f.location({map:'home',x:80,y:90,facing:'south'});
  await f.scene.projectStoryWorld(undefined,new AbortController().signal);
  assert.deepEqual([f.state.player.container.x,f.state.player.container.y],[80,90]);
  f.state.player.container.x=100;
  await f.scene.projectStoryWorld(undefined,new AbortController().signal);
  assert.equal(f.state.player.container.x,100);
});

test('a committed travel regroups the party once around the new hero position',async()=>{
  const f=fixture();f.location({map:'home',x:80,y:90,facing:'south'});
  await f.scene.projectStoryWorld(undefined,new AbortController().signal);
  assert.equal(f.regroups(),1);
  await f.scene.projectStoryWorld(undefined,new AbortController().signal);
  assert.equal(f.regroups(),1,'同一落点不重复收拢');
});

test('rollback and cross-map projection leave regrouping to the authoritative restore or the new scene',async()=>{
  const f=fixture();
  await f.scene.projectStoryWorld(undefined,new AbortController().signal,{map:'home',x:80,y:90,facing:'south'});
  assert.equal(f.regroups(),0,'回滚随后由 restoreState 逐名恢复位置');
  f.location({map:'destination',x:80,y:90,facing:'south'});
  await f.scene.projectStoryWorld(undefined,new AbortController().signal);
  assert.equal(f.regroups(),0,'跨图由新场景的上阵生成按主角落点');
});

test('cancellation before a queued formal restart starts rejects loading and prevents opening the old request',async()=>{
  const f=fixture();const controller=new AbortController();let queued:SceneOptions|undefined;
  f.state.scene.restart=(options:SceneOptions)=>{queued=options;};f.location({map:'destination',x:80,y:90,facing:'south'});
  const load=f.scene.projectStoryWorld(undefined,controller.signal);
  // 预取屏障先让出一帧，restart 才会排队；之后再模拟“已排队但新场景还没打开”的取消。
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(queued,'restart 已排队');
  controller.abort(new DOMException('cancelled','AbortError'));
  await assert.rejects(load,{name:'AbortError'});
  f.scene.options=queued;f.scene.create();assert.equal(f.stops(),1);
});

test('story takeover settles confirmed deaths after stopping actions and invalidates their later callbacks',async()=>{
  const calls:string[]=[];
  const combat=Object.setPrototypeOf({suspendPartyActions(){calls.push('party');},arena:[{visual:{},controller:{combatController:{cancel(){calls.push('enemy');}},targetRemoved(){}}}],
    movement:{stop(){calls.push('movement');}},app:{session:{party:{controlledId:'player'}}},
    pendingAllies:new Set(),pendingDefeats:{flush(){calls.push('settle');}}},WorldCombat.prototype) as unknown as InstanceType<typeof WorldCombat>;
  await combat.normalizeForStory(new AbortController().signal);assert.deepEqual(calls,['party','enemy','movement','settle']);
});

test('story takeover waits for in-flight companion preparation and its signal can cancel the barrier',async()=>{
  for(const abort of [false,true]){
    const pending=new Set(['companion']),waiters=new Set<()=>void>();let suspends=0;
    const combat=Object.setPrototypeOf({runtime:{reset:()=>{}},pendingAllies:pending,allyWaiters:waiters,closed:false,arena:[],
      suspendPartyActions(){suspends++;},pendingDefeats:{flush(){}}},WorldCombat.prototype) as unknown as InstanceType<typeof WorldCombat>;
    const controller=new AbortController();let finished=false;
    const work=combat.normalizeForStory(controller.signal).then(()=>{finished=true;});
    await Promise.resolve();assert.equal(finished,false);assert.equal(waiters.size,1);
    if(abort){controller.abort(new DOMException('cancelled','AbortError'));await assert.rejects(work,{name:'AbortError'});assert.equal(suspends,1);}
    else{pending.clear();for(const notify of [...waiters])notify();await work;assert.equal(suspends,2);}
    assert.equal(waiters.size,0);
  }
});

test('same-map rollback retains generated objects and restores recorded audio without a scene restart',async()=>{
  const f=fixture();const calls:unknown[]=[];
  const state=f.state as unknown as {app:{audio?:{restoreStoryAudio(value:unknown):void}}};
  state.app.audio={restoreStoryAudio(value){calls.push(value);}};
  const snapshot={location:{map:'home',x:10,y:20,facing:'south'},generatedEntities:[],audio:{music:'story-theme',ambience:null}};
  await f.scene.restoreStoryWorld(snapshot,new AbortController().signal);
  assert.equal(f.restarts(),0);assert.deepEqual(calls,[snapshot.audio]);
});

test('a same-map projection keeps a drunk spring as the waterless well',async()=>{
  const f=fixture();
  const springEntity={id:'well-1',actor:'clear-springs-f6f095b4',spring:true,x:8,y:40};
  const springActor={id:'clear-springs-f6f095b4',clips:{}};
  const wellActor={id:'well-7abb1f76',clips:{}};
  const old={entity:{...springEntity},actor:wellActor,container:{destroy(){}},layers:[]};
  const created={entity:{...springEntity},actor:springActor,container:{destroy(){}},layers:[]};
  const state=f.state as typeof f.state & {
    springCatalog?:{empty:string};
    createActor?:(entity:unknown)=>typeof created;
    drainSpring?:(character:{actor:{id:string}})=>void;
  };
  state.characters=[old];(state as {baseEntities:unknown[]}).baseEntities=[springEntity];state.springCatalog={empty:'well-7abb1f76'};
  state.app.world.actors={'clear-springs-f6f095b4':springActor,'well-7abb1f76':wellActor};
  (state.movement as {remove?:()=>void}).remove=()=>{};
  (state.app.session as {springs?:{isEmpty:()=>boolean}}).springs={isEmpty:()=>true};
  (state.app.session.storyWorld as {projectEntities?:()=>unknown[]}).projectEntities=()=>[springEntity];
  state.createActor=()=>created;
  let drains=0;state.drainSpring=character=>{drains++;character.actor=wellActor;};
  await f.scene.projectStoryWorld(undefined,new AbortController().signal);
  assert.equal(drains,1,'投影重建后重新套用喝空外观');
  assert.equal(created.actor.id,'well-7abb1f76');
});

test('defeat checkpoint restores complete world state and closes its panel before resuming the stable story cursor',async()=>{
  const calls:string[]=[];let restore:undefined|(()=>Promise<void>);
  const world={location:{map:'home',x:10,y:20,facing:'south'},generatedEntities:[],audio:{music:'story-theme',ambience:null}};
  const state={map:{id:'home'},destroyed:false,resetInput(){calls.push('input');},
    async restoreStoryWorld(value:unknown){assert.equal(value,world);calls.push('world');},
    app:{storySignal:new AbortController().signal,checkpoint:{peek:()=>({session:{},world})},
      session:{bag:{entries:[]},restoreState(){calls.push('session');}},
      director:{runtime:{snapshot:()=>({runs:[]})},cancel(){calls.push('cancel');},async retry(){calls.push('retry');return false;}},
      ui:{showDefeat(actions:{restore():Promise<void>}){restore=actions.restore;},closeDefeat(){calls.push('close');}}}
  };
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  scene.handleCombatDefeat();assert.ok(restore);await restore();
  assert.deepEqual(calls,['input','cancel','session','world','close','retry']);
});

test('a failed lost-outcome preview still opens the defeat panel',async t=>{
  t.mock.method(console,'error',()=>{});
  const messages:string[]=[];let shown=0;
  const state={map:{id:'home'},destroyed:false,encounterResults:new Set<string>(),
    app:{session:{storyWorld:{encounter:()=>({map:'home'})},party:{livingIds:[]},bag:{entries:[]}},
      director:{runtime:{snapshot:()=>({runs:[{status:'waiting',waiting:{outcomes:{lost:true},encounter:'enc-1'}}]})},
        async encounterResult(){throw new Error('拾取者不能行动');}},
      ui:{showDefeat(){shown++;},closeDefeat(){},toast(message:string){messages.push(message);}}}};
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  scene.handleCombatDefeat();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(shown,1,'剧情准备失败也必须给玩家阵亡界面');
  assert.deepEqual(messages,['拾取者不能行动']);
  assert.equal(state.encounterResults.has('enc-1'),false,'失败后允许下一次阵亡重试结算');
});

test('story settlement only regroups friendly units while the formal game world is active',()=>{
  const f=fixture();let settles=0;
  const app=f.state.app as unknown as {ui:{mode:string;setWorldRebuildCover(covered:boolean):void};suspended?:boolean};
  Object.assign(app.ui,{mode:'game'});app.suspended=false;
  (f.state.combat as typeof f.state.combat & {settleFriendlyUnitsAroundHero():void}).settleFriendlyUnitsAroundHero=()=>{settles++;};
  f.scene.settleStoryPlayback();assert.equal(settles,1);
  app.ui.mode='menu';f.scene.settleStoryPlayback();assert.equal(settles,1,'菜单界面不能移动主角');
  app.ui.mode='game';app.suspended=true;f.scene.settleStoryPlayback();assert.equal(settles,1,'后台挂起时不移动');
  app.suspended=false;(app as typeof app & {director?:{busy:boolean}}).director={busy:true};
  f.scene.settleStoryPlayback();assert.equal(settles,1,'下一段演出已经接管时不抢着移动');
});

test('cross-map story projection rebuilds the world without covering the stage with loading',async()=>{
  const f=fixture();f.location({map:'destination',x:80,y:90,facing:'south'});
  await f.scene.projectStoryWorld(undefined,new AbortController().signal);
  assert.equal(f.restarts(),1);assert.equal(f.lastRestart()?.silentEntry,true);
  assert.deepEqual(f.coverCalls(),[],'舞台已经遮住世界，不再加 UI 黑幕');
});

test('a cross-map projection waits for the destination entry prefetch before rebuilding',async()=>{
  const f=fixture();f.location({map:'destination',x:80,y:90,facing:'south'});
  let release!:()=>void,requested='';
  const gate=new Promise<void>(resolve=>{release=resolve;});
  Object.assign(f.state,{prefetchStoryEntry:(mapId:string)=>{requested=mapId;return gate;}});
  const load=f.scene.projectStoryWorld(undefined,new AbortController().signal);
  await Promise.resolve();
  assert.equal(requested,'destination');
  assert.equal(f.restarts(),0,'预取完成前不重建');
  release();
  await load;
  assert.equal(f.restarts(),1);
});

test('a map change without a covering stage uses the UI backdrop',async()=>{
  const f=fixture();f.covered(false);f.stageActive(false);f.location({map:'destination',x:80,y:90,facing:'south'});
  await f.scene.projectStoryWorld(undefined,new AbortController().signal);
  assert.equal(f.restarts(),1);assert.equal(f.lastRestart()?.silentEntry,true,'剧情跨图一律静默');
  assert.deepEqual(f.coverCalls(),[true]);
});

test('an active but transparent stage also uses the UI backdrop',async()=>{
  const f=fixture();f.covered(false);f.stageActive(true);f.location({map:'destination',x:80,y:90,facing:'south'});
  await f.scene.projectStoryWorld(undefined,new AbortController().signal);
  assert.equal(f.restarts(),1);assert.equal(f.lastRestart()?.silentEntry,true);
  assert.deepEqual(f.coverCalls(),[true]);
});

test('a failed silent rebuild clears the UI backdrop',async()=>{
  const f=fixture();f.covered(false);f.location({map:'destination',x:80,y:90,facing:'south'});
  f.state.scene.restart=(options:SceneOptions)=>{options.onError?.(new Error('boom'));};
  await assert.rejects(f.scene.projectStoryWorld(undefined,new AbortController().signal),/boom/);
  assert.deepEqual(f.coverCalls(),[true,false]);
});

test('a timed-out silent rebuild aborts the in-flight scene',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  try{
    const f=fixture();f.covered(false);f.location({map:'destination',x:80,y:90,facing:'south'});
    let queued:SceneOptions|undefined;
    f.state.scene.restart=(options:SceneOptions)=>{queued=options;};
    const load=f.scene.projectStoryWorld(undefined,new AbortController().signal);
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(queued,'restart 已排队');
    t.mock.timers.tick(30000);
    await assert.rejects(load,/剧情世界切换超时/);
    assert.equal(queued!.signal?.aborted,true,'超时要中止新场景加载');
    assert.deepEqual(f.coverCalls(),[true,false]);
  }finally{t.mock.timers.reset();}
});

test('same-map appearance loading stays silent during a performance',async()=>{
  const f=fixture();f.location({map:'home',x:80,y:90,facing:'south'});
  const extraActor={id:'extra-actor',clips:{'idle-south':{layers:[{key:'extra',file:'extra.png'}],frameWidth:8,frameHeight:8,frames:1}}};
  f.state.app.world.actors['extra-actor']=extraActor;
  f.state.characters=[{entity:{id:'extra',actor:'extra-actor',x:1,y:2},actor:extraActor,container:{active:true,x:1,y:2},clipName:'idle-south'}];
  f.projected([{id:'extra',actor:'extra-actor',x:1,y:2}]);
  await f.scene.projectStoryWorld(undefined,new AbortController().signal);
  assert.equal(f.restarts(),0);assert.equal(f.assetLoads.length,1);assert.equal(f.assetLoads[0][3],true);
});

test('defeat checkpoint recovery keeps the ordinary loading screen',async()=>{
  const f=fixture();f.location({map:'home',x:10,y:20,facing:'south'});
  await f.scene.restoreStoryWorld({location:{map:'destination',x:1,y:2,facing:'south'},generatedEntities:[]},new AbortController().signal);
  assert.equal(f.restarts(),1);assert.notEqual(f.lastRestart()?.silentEntry,true);
  assert.deepEqual(f.coverCalls(),[],'读档恢复不走剧情黑幕');
});
