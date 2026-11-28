import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {Campaign} from '../src/domain/campaign.ts';
import {BattleCharacter} from '../src/domain/character-stats.ts';
import {CombatController} from '../src/domain/combat.ts';
import {CombatSettlementEngine} from '../src/domain/combat-settlement.ts';
import type {ActorDefinition,WorldMap} from '../src/domain/content.ts';
import {EnemyController} from '../src/domain/enemy-ai.ts';
import {PartyController} from '../src/domain/party-ai.ts';
import {Session} from '../src/domain/session.ts';
import {SummonCombatAwareness} from '../src/domain/summon-tactics.ts';
import {WorldEnemyRoster} from '../src/domain/world-enemies.ts';
import {CHARACTER_ATLAS_ALIASES} from '../tools/character-atlas-aliases.ts';
import {loadBattleCatalog,loadCharacterStatsCatalog,loadCompanionCatalog,loadItemCatalog} from './support/combat-test-harness.ts';
import {createFakePhaserScene,createTestWorldCombat} from './support/world-combat-fixture.ts';

const campaign=JSON.parse(readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8')) as Campaign;

function normalizeActorClips(actor:ActorDefinition):void{
  for(const clip of Object.values(actor.clips)){
    for(const layer of clip?.layers??[]){
      if(layer.file)layer.file=CHARACTER_ATLAS_ALIASES[layer.file]??layer.file;
    }
  }
}

function normalizeBattleCatalog(raw:BattleCatalog):BattleCatalog{
  const copy=structuredClone(raw);
  for(const cls of copy.classes)normalizeActorClips(cls.actor);
  for(const enemy of copy.enemies)normalizeActorClips(enemy.actor);
  return copy;
}

function fullPhaserScene(overrides:Record<string,unknown>={}){
  return createFakePhaserScene({
    cameras:{main:{width:640,height:360,zoomX:1,zoomY:1,worldView:undefined,followOffset:{x:0,y:0},setFollowOffset(){}}},
    tweens:{add:()=>({stop(){},pause(){},resume(){}}),getTweensOf:()=>[],killTweensOf:()=>{}},
    ...overrides,
  });
}

async function clockFixture(){
  const baseCatalog=normalizeBattleCatalog(loadBattleCatalog()),items=loadItemCatalog(),statsCatalog=loadCharacterStatsCatalog(),companions=loadCompanionCatalog();
  const baseWolf=baseCatalog.enemies.find(enemy=>enemy.id==='enemy-wolf-1')!;
  const probeEnemy={...structuredClone(baseWolf),id:'clock-probe',behavior:{...baseWolf.behavior,engagement:'map-wide' as const,canMove:false}};
  const battleCatalog:BattleCatalog={...baseCatalog,enemies:[...baseCatalog.enemies,probeEnemy]};
  const hero=new BattleCharacter('dark-knight',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog,statsCatalog,companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  session.party!.deployFirstAvailable(ally.id);
  const actor=battleCatalog.classes.find(entry=>entry.id===ally.classId)!.actor;
  const map:WorldMap={
    id:'clock-test-map',name:'clock-test-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[
      {id:'enemy-a',enemyId:'clock-probe',x:260,y:260},
      {id:'enemy-b',enemyId:'clock-probe',x:280,y:260},
    ],
  };
  const shown:unknown[]=[];
  const world=await createTestWorldCombat({
    hero,session,map,battleCatalog,phaserScene:fullPhaserScene(),
    appOverrides:{world:{actors:{[ally.definition.actor]:actor,[actor.id]:actor}} as never},
    sceneOverrides:{refreshCombatHud:(value:unknown)=>shown.push(value)},
  });
  await world.combat.start();
  return {world,session,shown};
}

test('the actual scene advances every actor once on the shared frame and recovers resources after them',async t=>{
  let currentEvents:string[]=[];
  let currentSession!:Session;
  let aiDepth=0;
  const enemyNames=new WeakMap<EnemyController,string>();
  let enemyIndex=0;
  const record=(kind:string)=>currentEvents.push(`${currentSession.combatTick}:${kind}`);

  const origCombatUpdate=CombatController.prototype.update;
  t.mock.method(CombatController.prototype,'update',function(this:CombatController){
    if(aiDepth===0)record('player');
    return origCombatUpdate.call(this);
  });
  const origPartyStep=PartyController.prototype.step;
  t.mock.method(PartyController.prototype,'step',function(this:PartyController){
    record('ally');
    aiDepth++;
    try{return origPartyStep.call(this);}
    finally{aiDepth--;}
  });
  const origEnemyStep=EnemyController.prototype.step;
  t.mock.method(EnemyController.prototype,'step',function(this:EnemyController,nowMs?:number){
    let name=enemyNames.get(this);
    if(!name){name=enemyIndex++%2===0?'enemy-a':'enemy-b';enemyNames.set(this,name);}
    record(name);
    aiDepth++;
    try{return origEnemyStep.call(this,nowMs);}
    finally{aiDepth--;}
  });
  const origObserve=SummonCombatAwareness.prototype.observe;
  t.mock.method(SummonCombatAwareness.prototype,'observe',function(this:SummonCombatAwareness,...args:Parameters<SummonCombatAwareness['observe']>){
    record('summon-awareness');
    return origObserve.apply(this,args);
  });
  const origRecover=CombatSettlementEngine.prototype.recoverResources;
  t.mock.method(CombatSettlementEngine.prototype,'recoverResources',function(this:CombatSettlementEngine){
    record('recovery');
    return origRecover.call(this);
  });

  const long=await clockFixture();
  const longEvents:string[]=[];
  currentEvents=longEvents;currentSession=long.session;
  long.world.combat.update(960,true);

  enemyIndex=0;
  const split=await clockFixture();
  const splitEvents:string[]=[];
  currentEvents=splitEvents;currentSession=split.session;
  // 长帧和碎帧必须落在同一批逻辑帧上；兜底观察名单每 16 逻辑帧扫一次。
  for(const delta of [59,1,60,119,120,121,120,120,120,120])split.world.combat.update(delta,true);

  const expected=Array.from({length:16},(_,index)=>index+1).flatMap(frame=>
    ['player','ally','enemy-a','enemy-b',...(frame%16===0?['summon-awareness']:[]),'recovery']
      .map(kind=>`${frame}:${kind}`));
  assert.deepEqual(longEvents,expected);
  assert.deepEqual(splitEvents,expected);
  assert.deepEqual(long.session.captureState().combatClock,split.session.captureState().combatClock);
  const before=long.session.captureState().combatClock;
  currentEvents=longEvents;currentSession=long.session;
  long.world.combat.update(600,false);
  assert.deepEqual(long.session.captureState().combatClock,before);
  assert.deepEqual(longEvents,expected);
  long.world.combat.destroy();
  split.world.combat.destroy();
});

test('world combat advances the clock without painting the shortcut HUD itself',async()=>{
  const run=await clockFixture();
  run.shown.length=0;
  run.session.cooldowns.forActor('player').start('probe',2);
  run.world.combat.update(60,true);run.world.combat.update(60,true);
  assert.equal(run.session.combatTick,2);
  assert.deepEqual(run.session.cooldowns.forActor('player').snapshot(),{},'冷却到点后由场景的统一刷新读取最新快照');
  assert.deepEqual(run.shown,[],'WorldCombat 只推进逻辑帧，快捷栏绘制交给 WorldScene');
  run.world.combat.destroy();
});

test('scene respawn uses main-camera map coordinates and stops both deadlines while paused',async()=>{
  const map={
    id:'respawn-clock-test',name:'respawn-clock-test',width:1400,height:1400,tileSize:16,columns:88,rows:88,
    blocked:Array<boolean>(88*88).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'resident',enemyId:'enemy-bat-1',x:100,y:100}],
  } as WorldMap;
  const items=loadItemCatalog(),statsCatalog=loadCharacterStatsCatalog(),battleCatalog=normalizeBattleCatalog(loadBattleCatalog());
  for(const sampling of [1,2,3]){
    const hero=new BattleCharacter('dark-knight',statsCatalog,items);
    const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog);
    const roster=new WorldEnemyRoster(session,map,[]),spawn=roster.spawns[0]!;
    // 画布尺寸随采样变化；名册必须收到主镜头已经换算好的地图范围。
    const phaserScene=fullPhaserScene({
      scale:{width:200*sampling,height:200*sampling},
      cameras:{main:{width:640,height:360,zoomX:1,zoomY:1,worldView:{x:1000,y:1000,width:200,height:200},followOffset:{x:0,y:0},setFollowOffset(){}}},
    });
    const world=await createTestWorldCombat({hero,session,map,roster,battleCatalog,phaserScene});
    await world.combat.start();
    session.enemyDefeated(spawn);world.combat.syncChestEnemies();session.advanceGameTime(19_940);
    world.combat.update(60_000,false);
    assert.equal(session.nowMs,19_940);assert.equal(roster.enemies.length,0);
    world.combat.update(60,true);
    assert.equal(roster.isPresent(spawn.id),true);
    world.combat.destroy();
  }
});

test('scene removal clears enemy cooldowns while checkpoint visual replacement preserves restored records',async()=>{
  const items=loadItemCatalog(),statsCatalog=loadCharacterStatsCatalog(),battleCatalog=normalizeBattleCatalog(loadBattleCatalog());
  const hero=new BattleCharacter('dark-knight',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog);
  const map:WorldMap={
    id:'cooldown-preserve-map',name:'cooldown-preserve-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'enemy',enemyId:'enemy-bat-1',x:100,y:100}],
  };
  const world=await createTestWorldCombat({hero,session,map,battleCatalog,phaserScene:fullPhaserScene()});
  await world.combat.start();
  const port=session.cooldowns.forActor('enemy');
  const snapshot=world.combat.captureState();
  port.start('probe',20);
  await world.combat.restoreState(snapshot);
  assert.equal(port.isReady('probe'),false);
  world.combat.removeEnemy('enemy');
  assert.equal(port.isReady('probe'),true);
  world.combat.destroy();
});

test('reviving an undeployed member still clears its cooldown and resets the shared recovery deadline',async()=>{
  const items=loadItemCatalog(),statsCatalog=loadCharacterStatsCatalog(),battleCatalog=normalizeBattleCatalog(loadBattleCatalog()),companions=loadCompanionCatalog();
  const hero=new BattleCharacter('dark-knight',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog,statsCatalog,companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  const world=await createTestWorldCombat({hero,session,battleCatalog,phaserScene:fullPhaserScene()});
  await world.combat.start();
  const port=session.cooldowns.forActor(ally.id);
  port.start('probe',100);session.advanceCombatFrames(1200,()=>session.recoverCombatResources([]));
  world.combat.reviveMember(ally.id,{x:0,y:0});
  assert.equal(port.isReady('probe'),true);assert.equal(session.combatTick,20);
  assert.equal(session.resourceRecoveryDelayMs,1860);
  world.combat.destroy();
});
