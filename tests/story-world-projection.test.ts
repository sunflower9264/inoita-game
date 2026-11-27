import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {BattleCharacter} from '../src/domain/character-stats.ts';
import {CombatController} from '../src/domain/combat.ts';
import type {ActorDefinition, AnimationClip, WorldMap} from '../src/domain/content.ts';
import {Session} from '../src/domain/session.ts';
import {stageSnapshot} from './helpers/story-stage.ts';
import type {SceneOptions} from '../src/scenes/world-scene.ts';
import {
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import {createFakePhaserScene, createTestWorldCombat, PHASER_STUB_SOURCE} from './support/world-combat-fixture.ts';

function stripActorFiles(actor:ActorDefinition):ActorDefinition{
  const clips:ActorDefinition['clips']={};
  for(const [name,clip] of Object.entries(actor.clips) as [keyof ActorDefinition['clips'],AnimationClip|undefined][]){
    if(!clip)continue;
    clips[name]={...clip,layers:clip.layers.map(layer=>({...layer,file:''}))};
  }
  return {...actor,clips};
}
function localBattleCatalog(base=loadBattleCatalog()):BattleCatalog{
  return {
    ...base,
    classes:base.classes.map(entry=>({...entry,actor:stripActorFiles(entry.actor)})),
    enemies:base.enemies.map(entry=>({...entry,actor:stripActorFiles(entry.actor)})),
  };
}
function completePhaserScene(){
  const base=createFakePhaserScene();
  const baseAdd=base.add as unknown as {sprite:(...args:unknown[])=>Record<string,unknown>};
  const baseTweens=base.tweens as unknown as Record<string,unknown>;
  const scene=createFakePhaserScene({
    tweens:{...baseTweens,killTweensOf:()=>{},getTweensOf:()=>[]},
    add:{
      ...baseAdd,
      sprite:(...args:unknown[])=>{
        const sprite=baseAdd.sprite(...args);
        const anims=sprite.anims as Record<string,unknown>;
        Object.assign(anims,{isPlaying:false,getProgress:()=>0,create:(config:unknown)=>{const anim={...(config as object),destroy:()=>{}};anims.currentAnim=anim;return anim;}});
        return Object.assign(sprite,{scene,texture:sprite.texture??{key:''},setTexture(){return sprite;},play(){anims.isPlaying=true;return sprite;}});
      },
    },
  });
  return scene;
}

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'?{url:`data:text/javascript,${encodeURIComponent(PHASER_STUB_SOURCE)}`,shortCircuit:true}:next(specifier,context);}});
const {WorldScene}=await import('../src/scenes/world-scene.ts');
hook.deregister();

function fixture(){
  let location:undefined|{map:string;x:number;y:number;facing:'south'};
  let stageActive=true;let worldCovered=true;let projected:unknown[]=[];let lastRestart:SceneOptions|undefined;
  const assetLoads:unknown[][]=[],coverCalls:boolean[]=[];
  const player={container:{active:true,x:10,y:20},entity:{id:'player'}};
  const positions:unknown[]=[],adopted:unknown[][]=[];let restarts=0,stops=0,regroups=0;
  const movement={placeAll:(values:{position:{x:number;y:number}}[])=>{positions.push(values);for(const value of values){player.container.x=value.position.x;player.container.y=value.position.y;}}};
  const state={map:{id:'home',name:'Home'},player,baseEntities:[],characters:[] as unknown[],entities:[],storyEntityAssets:[],projectedActorIds:new Set(),occupiedCharacters:new Set<string>(),encounterResults:new Set<string>(),loadingWorld:false,destroyed:false,readyAbort:new AbortController(),
    app:{director:{},campaign:{placements:[]},session:{storyWorld:{get currentLocation(){return location;},projectEntities:()=>projected,actorAppearance:(actor:string)=>actor,entity:()=>undefined},visible:()=>true},world:{actors:{} as Record<string,unknown>},ui:{setWorldRebuildCover:(covered:boolean)=>{coverCalls.push(covered);}}},
    movement,
    combat:{regroupPartyAroundHero(){regroups++;},async projectStoryEnemies(){},async restoreState(){},adoptStoryPositions(actors:unknown[]){adopted.push(actors);},finishMapVisit(){},discardPendingDefeats(){}},
    loadAssets:async(...args:unknown[])=>{assetLoads.push(args);return {release(){}};},refreshState(){},syncHud(){},setClip(){},syncControlledCharacter(){},
    scene:{isActive(){return stageActive;},get(){return {worldCovered};},restart(options:SceneOptions){restarts++;lastRestart=options;options.onReady?.();},stop(){stops++;}}
  };
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  return {scene,state,movement,positions,adopted,location:(value:typeof location)=>{location=value;},stageActive:(value:boolean)=>{stageActive=value;},covered:(value:boolean)=>{worldCovered=value;},coverCalls:()=>coverCalls,projected:(value:unknown[])=>{projected=value;},restarts:()=>restarts,stops:()=>stops,regroups:()=>regroups,lastRestart:()=>lastRestart,assetLoads};
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

test('story takeover settles confirmed deaths after stopping actions and invalidates their later callbacks',async t=>{
  const battleCatalog=localBattleCatalog();
  const items=loadItemCatalog();
  const statsCatalog=loadCharacterStatsCatalog();
  const campaign=loadCampaignCatalog();
  const hero=new BattleCharacter('dark-knight',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog,statsCatalog);
  session.skills.maxAll();
  const map:WorldMap={
    id:'normalize-map',name:'normalize-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[
      {id:'kill-me',enemyId:'enemy-snake-1',x:80,y:64},
      {id:'attacker',enemyId:'enemy-snake-1',x:96,y:64},
    ],
  };
  const world=await createTestWorldCombat({phaserScene:completePhaserScene(),map,hero,session,battleCatalog,items,characterStats:statsCatalog});
  await world.combat.start();
  t.mock.method(Math,'random',()=>0.99);
  world.session.setOneHitKill('player',true);
  world.combat.selectEnemy('kill-me');
  world.combat.attack();
  for(let i=0;i<20;i++){
    world.combat.update(60,true);
    if(world.combat.diagnostics().enemies?.some(enemy=>enemy.id==='kill-me'&&enemy.pendingDefeat))break;
  }
  assert.equal(world.combat.diagnostics().enemies?.some(enemy=>enemy.id==='kill-me'&&enemy.pendingDefeat),true);
  assert.equal(world.session.enemyVitals('kill-me').deadUntil,undefined,'结算前死亡记录尚未落盘');

  world.combat.selectEnemy('attacker');
  world.combat.attack('dark-strike');
  world.combat.update(60,true);

  const calls:string[]=[];
  const origSuspend=world.combat.suspendPartyActions.bind(world.combat);
  t.mock.method(world.combat,'suspendPartyActions',()=>{calls.push('party');return origSuspend();});
  const origCancel=CombatController.prototype.cancel;
  t.mock.method(CombatController.prototype,'cancel',function(this:CombatController,...args:Parameters<CombatController['cancel']>){
    const casterId=(this as unknown as {casterId?:string}).casterId;
    if(casterId&&casterId!=='player'){
      calls.push('enemy');
    }
    return origCancel.apply(this,args);
  });
  const movement=world.scene.movement!;
  const origStop=movement.stop.bind(movement);
  t.mock.method(movement,'stop',(visual:Parameters<typeof movement.stop>[0])=>{
    if(visual.entity.id==='attacker')calls.push('movement');
    return origStop(visual);
  });
  const origSettle=world.session.settleEnemyDefeat.bind(world.session);
  t.mock.method(world.session,'settleEnemyDefeat',(request:Parameters<typeof world.session.settleEnemyDefeat>[0])=>{
    if(request.key==='kill-me')calls.push('settle');
    return origSettle(request);
  });

  await world.combat.normalizeForStory(new AbortController().signal);
  assert.deepEqual([...new Set(calls)],['party','enemy','movement','settle']);
  assert.ok(calls.lastIndexOf('movement')<calls.indexOf('settle'),'停止行动发生在死亡结算之前');
  assert.notEqual(world.session.enemyVitals('kill-me').deadUntil,undefined,'confirmed death is settled');
  assert.equal(world.combat.attackState,'idle');
  world.combat.destroy();
});

test('story takeover waits for in-flight companion preparation and its signal can cancel the barrier',async t=>{
  const battleCatalog=localBattleCatalog();
  const items=loadItemCatalog();
  const statsCatalog=loadCharacterStatsCatalog();
  const campaign=loadCampaignCatalog();
  const companions=loadCompanionCatalog();
  const dkActor=battleCatalog.classes.find(entry=>entry.id==='dark-knight')!.actor;
  for(const abort of [false,true]){
    const hero=new BattleCharacter('dark-knight',statsCatalog,items);
    const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog,statsCatalog,companions);
    session.bag.add('mercenary-emblem-black-knight');
    const ally=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
    const finishers:(()=>void)[]=[];
    const finishAll=()=>{for(const resolve of finishers.splice(0))resolve();};
    const world=await createTestWorldCombat({
      phaserScene:completePhaserScene(),
      hero,session,battleCatalog,items,characterStats:statsCatalog,
      sceneOverrides:{preparePartyMember:()=>new Promise<void>(resolve=>{finishers.push(resolve);})},
      appOverrides:{world:{actors:{[ally.definition.actor]:dkActor,[dkActor.id]:dkActor}} as never},
    });
    await world.combat.start();
    session.party!.deployFirstAvailable(ally.id);
    world.combat.update(16,true);
    while(!finishers.length)await new Promise(resolve=>setImmediate(resolve));

    const suspends=t.mock.method(world.combat,'suspendPartyActions');
    const controller=new AbortController();let finished=false;
    const work=world.combat.normalizeForStory(controller.signal).then(()=>{finished=true;});
    await Promise.resolve();assert.equal(finished,false);assert.equal(suspends.mock.callCount(),1);
    if(abort){
      controller.abort(new DOMException('cancelled','AbortError'));
      await assert.rejects(work,{name:'AbortError'});
      assert.equal(suspends.mock.callCount(),1);
      finishAll();
      await new Promise(resolve=>setImmediate(resolve));
    }else{
      finishAll();
      await work;
      assert.equal(finished,true);
      assert.equal(suspends.mock.callCount(),2);
    }
    world.combat.destroy();
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

test('restoring a save or checkpoint clears the scene outcome guard',async()=>{
  const f=fixture();f.location({map:'home',x:10,y:20,facing:'south'});
  f.state.encounterResults.add('enc-1');
  await f.scene.restoreStoryWorld({location:{map:'home',x:10,y:20,facing:'south'},generatedEntities:[]},new AbortController().signal);
  assert.equal(f.state.encounterResults.size,0,'回滚后同一场遭遇可以重新结算');
});

test('a party wipe opens the defeat panel without settling the waiting encounter as lost',async()=>{
  const outcomes:string[]=[];
  let shown=0;
  const encounter={id:'enc-1',map:'home',status:'active' as const,spawns:[]};
  const state={map:{id:'home'},destroyed:false,encounterResults:new Set<string>(),
    app:{session:{storyWorld:{encounter:()=>encounter},party:{livingIds:[]},bag:{entries:[]}},
      director:{runtime:{snapshot:()=>({runs:[{status:'waiting',waiting:{outcomes:{lost:true},encounter:'enc-1'}}]})},
        async encounterResult(_encounter:string,outcome:string){outcomes.push(outcome);return true;}},
      ui:{showDefeat(){shown++;},closeDefeat(){},toast(){}}}};
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  scene.handleCombatDefeat();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(shown,1,'全队阵亡要立刻给玩家阵亡界面');
  assert.deepEqual(outcomes,[],'阵亡本身不结算剧情遭遇');
  assert.equal(encounter.status,'active','复活或读档后这场遭遇仍可继续');
  assert.equal(state.encounterResults.size,0,'阵亡不占用胜利结算的去重记录');
});

test('a story checkpoint keeps the existing snapshot while a story encounter is waiting',()=>{
  let captures=0;
  const scene=Object.setPrototypeOf({app:{session:{hasWaitingStoryRun:true,hasLivingMember:true},
    checkpoint:{available:true,capture(){captures++;return true;}}}},WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  scene.checkpointStoryWorld();
  assert.equal(captures,0,'等待战斗时不覆盖已有的安全检查点');
});

test('a story checkpoint records a fallback when a story encounter is waiting and none exists',()=>{
  let captures=0;
  const player={},position={x:10,y:20};
  const scene=Object.setPrototypeOf({
    map:{id:'home',name:'Home'},player,movement:{position:()=>position},combat:{settleForSnapshot(){}},
    captureStoryWorld:()=>({location:{map:'home',x:position.x,y:position.y,facing:'south'},generatedEntities:[]}),
    app:{session:{hasWaitingStoryRun:true,hasLivingMember:true},
      checkpoint:{available:false,capture(){captures++;return true;}}},
  },WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  scene.checkpointStoryWorld();
  assert.equal(captures,1,'没有检查点时，读档落入等待战斗也要记下兜底检查点');
});

test('saving refuses a party whose active members are all down',()=>{
  const scene=Object.setPrototypeOf({app:{session:{hasLivingMember:false},ui:{}},map:{id:'home'},player:{},movement:{}},WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  assert.deepEqual(scene.captureSaveWorld(),{ok:false,reason:'no-survivors'});
});

test('a defeat restore refuses a checkpoint whose party has no living member',async()=>{
  let restore:undefined|(()=>Promise<void>);
  const scene=Object.setPrototypeOf({map:{id:'home'},destroyed:false,resetInput(){},async restoreStoryWorld(){},
    app:{storySignal:new AbortController().signal,
      checkpoint:{peek:()=>({session:{hero:{health:0},party:{members:[],slots:['companion-1']}},world:{location:{map:'home'}}})},
      ui:{showDefeat(actions:{restore():Promise<void>}){restore=actions.restore;},closeDefeat(){}}}},
  WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  scene.handleCombatDefeat();assert.ok(restore);
  await assert.rejects(restore!(),/没有可战斗的队员/);
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
  assert.equal(f.restarts(),0);assert.equal(f.assetLoads.length,1);assert.deepEqual(f.coverCalls(),[],'同图演出中的外观加载不覆盖世界');
});

test('defeat checkpoint recovery keeps the ordinary loading screen',async()=>{
  const f=fixture();f.location({map:'home',x:10,y:20,facing:'south'});
  await f.scene.restoreStoryWorld({location:{map:'destination',x:1,y:2,facing:'south'},generatedEntities:[]},new AbortController().signal);
  assert.equal(f.restarts(),1);assert.notEqual(f.lastRestart()?.silentEntry,true);
  assert.deepEqual(f.coverCalls(),[],'读档恢复不走剧情黑幕');
});

test('a same-map projection rebuilds a world that is only half built instead of throwing',async()=>{
  const f=fixture();f.location({map:'home',x:80,y:90,facing:'south'});
  // open 已经赋值地图，但主角/移动层还没创建：这是错误重试时会遇到的半初始化现场。
  const movement=f.movement,restart=f.state.scene.restart;
  delete (f.state as unknown as Record<string,unknown>).movement;
  f.scene.options={map:'home',x:80,y:90,facing:'south'};
  f.state.scene.restart=(options:SceneOptions)=>{f.state.loadingWorld=false;f.state.movement=movement;restart(options);};
  await f.scene.projectStoryWorld(undefined,new AbortController().signal);
  assert.equal(f.restarts(),1,'半初始化的同图现场交给新场景重建');
  assert.deepEqual([f.lastRestart()?.map,f.lastRestart()?.x,f.lastRestart()?.y],[ 'home',80,90 ],'重建沿用目标落点');
});

test('concurrent readiness checks share one rebuild and a cancelled waiter does not cancel the shared work',async()=>{
  const f=fixture();
  f.scene.options={map:'home',x:10,y:20,facing:'south'};
  delete (f.state as unknown as Record<string,unknown>).movement;
  let queued:SceneOptions|undefined,restarts=0;
  f.state.scene.restart=(options:SceneOptions)=>{restarts++;queued=options;};
  const first=new AbortController();
  const a=f.scene.recoverWorld(first.signal);
  const b=f.scene.recoverWorld();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(restarts,1,'并发检查只排一次重建');
  first.abort(new DOMException('cancelled','AbortError'));
  await assert.rejects(a,{name:'AbortError'});
  queued!.onReady?.();
  await b;
});

test('readiness waits for an in-flight open before rebuilding',async()=>{
  const f=fixture();
  f.scene.options={map:'home',x:10,y:20,facing:'south'};
  delete (f.state as unknown as Record<string,unknown>).movement;
  let release!:()=>void,restarts=0;
  (f.state as unknown as {openTask?:Promise<void>}).openTask=new Promise<void>(resolve=>{release=resolve;});
  f.state.scene.restart=(options:SceneOptions)=>{restarts++;options.onReady?.();};
  const ready=f.scene.recoverWorld();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(restarts,0,'在途进图还没结算时不重复重启');
  release();
  await ready;
  assert.equal(restarts,1,'进图结算后世界仍不完整才重建');
});

test('recoverWorld rebuilds a half-built world and is a no-op when ready',async()=>{
  const ready=fixture();
  await ready.scene.recoverWorld();
  assert.equal(ready.restarts(),0,'已经就绪的世界不重启');

  const broken=fixture();
  broken.scene.options={map:'home',x:10,y:20,facing:'south'};
  delete (broken.state as unknown as Record<string,unknown>).movement;
  await broken.scene.recoverWorld();
  assert.equal(broken.restarts(),1,'只建了一半的世界用进图参数重建');
});

test('a closing world refuses to capture a save instead of reading torn-down objects',()=>{
  const f=fixture();f.state.destroyed=true;
  assert.deepEqual(f.scene.captureSaveWorld(),{ok:false,reason:'not-ready'});
});

test('waitWorldReady only waits for an in-flight open and never rebuilds',async()=>{
  const f=fixture();
  delete (f.state as unknown as Record<string,unknown>).movement;
  let restarts=0;
  f.state.scene.restart=()=>{restarts++;};
  await assert.rejects(f.scene.waitWorldReady(),/正式地图尚未就绪/);
  assert.equal(restarts,0,'正常开演前的等待不重建世界');
});

test('a rebuild is not cancelled by the shutdown it triggers',async()=>{
  const f=fixture();
  f.scene.options={map:'home',x:10,y:20,facing:'south'};
  delete (f.state as unknown as Record<string,unknown>).movement;
  f.state.scene.restart=(options:SceneOptions)=>{
    // 真实 Phaser 的 restart 会先 shutdown 旧场景，shutdown 会 abort 这一代的取消源。
    f.state.readyAbort.abort(new Error('正式地图已经关闭'));
    f.state.loadingWorld=false;f.state.movement=f.movement;
    options.onReady?.();
  };
  await f.scene.recoverWorld();
});

test('waitWorldReady surfaces the in-flight open error and recoverWorld then rebuilds',async()=>{
  const f=fixture();
  f.scene.options={map:'home',x:10,y:20,facing:'south'};
  delete (f.state as unknown as Record<string,unknown>).movement;
  let rejectOpen!: (error: Error)=>void;
  (f.state as unknown as {openTask?:Promise<void>}).openTask=new Promise<void>((_,reject)=>{rejectOpen=reject;});
  let restarts=0;
  f.state.scene.restart=(options:SceneOptions)=>{restarts++;options.onReady?.();};
  const waiting=f.scene.waitWorldReady();
  await new Promise(resolve=>setImmediate(resolve));
  rejectOpen(new Error('这片区域的资源尚未准备好'));
  await assert.rejects(waiting,/这片区域的资源尚未准备好/);
  assert.equal(restarts,0,'只等待的入口不重建');
  await f.scene.recoverWorld();
  assert.equal(restarts,1,'错误重试入口重建一次');
});

test('recoverWorld escalates a wait-only task into a rebuild after the open settles',async()=>{
  const f=fixture();
  f.scene.options={map:'home',x:10,y:20,facing:'south'};
  delete (f.state as unknown as Record<string,unknown>).movement;
  let release!:()=>void,restarts=0;
  (f.state as unknown as {openTask?:Promise<void>}).openTask=new Promise<void>(resolve=>{release=resolve;});
  f.state.scene.restart=(options:SceneOptions)=>{restarts++;options.onReady?.();};
  const waiting=f.scene.waitWorldReady();
  const recovering=f.scene.recoverWorld();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(restarts,0,'在途进图还没结束时两个入口都不重建');
  release();
  await assert.rejects(waiting,/正式地图尚未就绪/);
  await recovering;
  assert.equal(restarts,1,'等待型任务结束后重建请求只排一次重建');
});
