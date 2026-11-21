import {CombatRuntime} from '../src/domain/combat-runtime.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {Session} from '../src/domain/session.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import {WorldEnemyRoster} from '../src/domain/world-enemies.ts';
import type {WorldMap} from '../src/domain/content.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const campaign=JSON.parse(readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8')) as Campaign;
const invoke=(host:object,name:string,...args:unknown[])=>Reflect.get(WorldCombat.prototype,name).call(host,...args);
function fixture(){
  const session=new Session(campaign),conditions=new CombatConditions(),events:string[]=[],shown:unknown[]=[];
  const record=(kind:string)=>events.push(`${session.combatTick}:${kind}`);
  const visual=()=>({layers:[],container:{active:true,y:0,setDepth:()=>{}}});
  const player=visual(),ally=visual();
  const host={runtime:new CombatRuntime(()=>session.combatTick),setPaused:()=>{},closed:false,defeated:false,player,allies:[{id:'ally',visual:ally,ai:{step:()=>record('ally')}}],
    arena:[{key:'enemy-a',visual:visual(),controller:{needsFrame:()=>true,step:()=>record('enemy-a')}},
      {key:'enemy-b',visual:visual(),controller:{needsFrame:()=>true,step:()=>record('enemy-b')}}],
    app:{session},conditions,deathTweens:new Map(),pendingDefeats:new Set(),fallen:new Set(),
    flowFields:{reset:()=>{}},
    outcomes:{setPaused:()=>{}},feedback:{setPaused:()=>{}},statusColors:{paint:()=>{}},
    scene:{canCombatControl:true,time:{now:0},events:{emit:()=>{}},refreshCombatTarget:()=>{},refreshCombatHud:(value:unknown)=>shown.push(value)},
    get cooldowns(){return session.cooldowns.forActor('player').snapshot();},
    activeParty:['player','ally'],controlledId:'player',syncedControlledId:'player',nextPartySyncAt:Infinity,shouldSyncParty:()=>false,dealtDamage:new Set(),
    roster:{refresh:():ReturnType<WorldEnemyRoster['refresh']>=>({removed:[],added:[]})},
    memberOf:(id:string)=>['player','ally'].includes(id)?{player:{health:1}}:undefined,
    syncCombatResourceLimits:()=>{},syncAiSkills:()=>{},syncBuffLoops:()=>{},syncStateMarkers:()=>{},syncFocusRings:()=>{},
    consumeRosterChanges:()=>{},isPartyWiped:()=>false,suspendPartyActions:()=>{},stopEnemies:()=>{},
    combat:{update:()=>record('player')},
    updateEnemies(enabled:boolean):void{invoke(host,'updateEnemies',enabled);},
    observeSummonCombat:()=>record('summon-awareness'),
    recoverResources:()=>{record('recovery');session.recoverCombatResources([]);},
  };
  return {host,session,events,shown,update:(delta:number,enabled=true)=>invoke(host,'update',delta,enabled)};
}

test('the actual scene advances every actor once on the shared frame and recovers resources after them',()=>{
  const long=fixture(),split=fixture();long.update(960);
  // 长帧和碎帧必须落在同一批逻辑帧上；兜底观察名单每 16 逻辑帧扫一次。
  for(const delta of [59,1,60,119,120,121,120,120,120,120])split.update(delta);
  const expected=Array.from({length:16},(_,index)=>index+1).flatMap(frame=>
    ['player','ally','enemy-a','enemy-b',...(frame%16===0?['summon-awareness']:[]),'recovery']
      .map(kind=>`${frame}:${kind}`));
  assert.deepEqual(long.events,expected);assert.deepEqual(split.events,expected);
  assert.deepEqual(long.session.captureState().combatClock,split.session.captureState().combatClock);
  const before=long.session.captureState().combatClock;long.update(600,false);
  assert.deepEqual(long.session.captureState().combatClock,before);assert.deepEqual(long.events,expected);
});

test('world combat advances the clock without painting the shortcut HUD itself',()=>{
  const run=fixture();run.session.cooldowns.forActor('player').start('probe',2);
  run.update(60);run.update(60);
  assert.equal(run.session.combatTick,2);
  assert.deepEqual(run.session.cooldowns.forActor('player').snapshot(),{},'冷却到点后由场景的统一刷新读取最新快照');
  assert.deepEqual(run.shown,[],'WorldCombat 只推进逻辑帧，快捷栏绘制交给 WorldScene');
});

test('scene respawn uses main-camera map coordinates and stops both deadlines while paused',()=>{
  const map={id:'respawn-clock-test',enemySpawns:[{id:'resident',enemyId:'enemy-cave-bat',x:100,y:100}]} as WorldMap;
  for(const sampling of [1,2,3]){
    const run=fixture(),roster=new WorldEnemyRoster(run.session,map,[],1),spawn=roster.spawns[0]!;
    // 画布尺寸随采样变化；名册必须收到主镜头已经换算好的地图范围。
    Object.assign(run.host.scene,{scale:{width:200*sampling,height:200*sampling},
      cameras:{main:{worldView:{x:1000,y:1000,width:200,height:200}}}});
    run.host.roster=roster;
    run.session.enemyDefeated(spawn);roster.refresh();run.session.advanceGameTime(19_940);
    run.update(60_000,false);
    assert.equal(run.session.nowMs,19_940);assert.equal(roster.enemies.length,0);
    run.update(60);
    assert.equal(roster.isPresent(spawn.id),true);
  }
});

test('scene removal clears enemy cooldowns while checkpoint visual replacement preserves restored records',()=>{
  const session=new Session(campaign),port=session.cooldowns.forActor('enemy');
  const enemy={key:'enemy',controller:{dispose:()=>{},targetRemoved:()=>{}},presenter:{clear:()=>{}},visual:{container:{destroy:()=>{}}}};
  const host=Object.setPrototypeOf({app:{session},arena:[enemy],movement:{remove:()=>{}}},WorldCombat.prototype);
  port.start('probe',20);invoke(host,'destroyEnemy',enemy,true);
  assert.equal(port.isReady('probe'),false);
  invoke(host,'destroyEnemy',enemy);assert.equal(port.isReady('probe'),true);
});

test('reviving an undeployed member still clears its cooldown and resets the shared recovery deadline',()=>{
  const session=new Session(campaign),port=session.cooldowns.forActor('ally');
  port.start('probe',100);session.advanceCombatFrames(1200,()=>session.recoverCombatResources([]));
  const host=Object.setPrototypeOf({app:{session},visualOf:()=>undefined,memberOf:()=>({player:{health:1}})},WorldCombat.prototype);
  invoke(host,'reviveMember','ally',{x:0,y:0});
  assert.equal(port.isReady('probe'),true);assert.equal(session.combatTick,20);
  assert.equal(session.resourceRecoveryDelayMs,1860);
});
