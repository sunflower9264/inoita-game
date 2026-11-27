import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { StoryContext } from '../src/application/ports.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { CombatController } from '../src/domain/combat.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import type { ActorDefinition, AnimationClip, WorldMap } from '../src/domain/content.ts';
import { Session } from '../src/domain/session.ts';
import { targetsEnemies } from '../src/domain/skill-action.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import { createFakePhaserScene, createTestWorldCombat, installPhaserStubHooks } from './support/world-combat-fixture.ts';

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

// These tests execute the scene adapters' coordination logic without a browser renderer.
const phaser = installPhaserStubHooks();
const { CombatPresenter } = await import('../src/rendering/combat-presenter.ts');
const { StoryPresenter } = await import('../src/rendering/story-presenter.ts');
const { WorldScene } = await import('../src/scenes/world-scene.ts');
phaser.deregister();
const rawBattle=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const stripActorFiles=(actor:ActorDefinition):ActorDefinition=>{
  const clips:ActorDefinition['clips']={};
  for(const [name,clip] of Object.entries(actor.clips) as [keyof ActorDefinition['clips'],AnimationClip|undefined][]){
    if(!clip)continue;
    clips[name]={...clip,layers:clip.layers.map(layer=>({...layer,file:''}))};
  }
  return {...actor,clips};
};
const battle:BattleCatalog={
  ...rawBattle,
  classes:rawBattle.classes.map(entry=>({...entry,actor:stripActorFiles(entry.actor)})),
  enemies:rawBattle.enemies.map(entry=>({...entry,actor:stripActorFiles(entry.actor)})),
};

test('world entry captures a fallback checkpoint once unless that capture fails',()=>{
  const host:any=Object.assign(Object.create(WorldScene.prototype),{checkpointPending:false,captureCheckpoint:()=>true});
  host.captureEntryCheckpoint();
  assert.equal(host.checkpointPending,false,'立即兜底成功后不再排第二次完整快照');
  host.captureCheckpoint=()=>false;
  host.captureEntryCheckpoint();
  assert.equal(host.checkpointPending,true,'立即兜底失败保留重试标记');
});

test('redeploying a removed ally while paused requests a fresh party sync',async()=>{
  const items=loadItemCatalog(),stats=loadCharacterStatsCatalog(),campaign=loadCampaignCatalog(),companions=loadCompanionCatalog();
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats,companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  session.party!.deployFirstAvailable(ally.id);
  const dkActor=battle.classes.find(entry=>entry.id==='dark-knight')!.actor;
  const world=await createTestWorldCombat({
    phaserScene:completePhaserScene(),
    hero,session,battleCatalog:battle,items,characterStats:stats,
    appOverrides:{world:{actors:{[ally.definition.actor]:dkActor,[dkActor.id]:dkActor}} as never},
  });
  await world.combat.start();
  world.combat.update(16,false);
  assert.equal(world.combat.paused,true);

  session.party!.reserve(ally.id);
  session.party!.deployFirstAvailable(ally.id);
  assert.equal(world.combat.captureState().party.some(member=>member.id===ally.id),false,'暂停期间离队会立刻撤销旧控制器');

  world.combat.update(16,true);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(world.combat.captureState().party.some(member=>member.id===ally.id),true,'恢复推进后重新同步上阵成员');
  world.combat.destroy();
});

test('party revision changes trigger ally sync while failure retries stay pending',async()=>{
  const items=loadItemCatalog(),stats=loadCharacterStatsCatalog(),campaign=loadCampaignCatalog(),companions=loadCompanionCatalog();
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats,companions);
  session.bag.add('mercenary-emblem-black-knight',2);
  const recruit=()=>session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  const first=recruit(),second=recruit();
  session.party!.deployFirstAvailable(first.id);
  const dkActor=battle.classes.find(entry=>entry.id==='dark-knight')!.actor;
  let prepareCalls=0,shouldFail=false;
  const world=await createTestWorldCombat({
    phaserScene:completePhaserScene(),
    hero,session,battleCatalog:battle,items,characterStats:stats,
    sceneOverrides:{preparePartyMember:async id=>{if(id!==second.id)return;prepareCalls++;if(shouldFail)throw new Error('sync failed');}},
    appOverrides:{ui:{showInstant(){},toast(){}} as never,world:{actors:{[first.definition.actor]:dkActor,[second.definition.actor]:dkActor,[dkActor.id]:dkActor}} as never},
  });
  await world.combat.start();
  prepareCalls=0;

  world.combat.update(16,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prepareCalls,0,'版本未变时不重新同步');

  shouldFail=true;
  (world.phaserScene.time as {now:number}).now=0;
  session.party!.deployFirstAvailable(second.id);
  world.combat.update(16,true);
  await new Promise(resolve=>setTimeout(resolve,10));
  const afterRevision=prepareCalls;
  assert.ok(afterRevision>=1,'上阵顺序变化触发同步');
  assert.equal(world.combat.captureState().party.some(member=>member.id===second.id),false);

  (world.phaserScene.time as {now:number}).now=500;
  world.combat.update(16,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prepareCalls,afterRevision,'失败后的重试窗口内不重复同步');

  shouldFail=false;
  (world.phaserScene.time as {now:number}).now=1000;
  world.combat.update(16,true);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(prepareCalls>afterRevision,'窗口结束后保留重试');
  const afterRecovery=prepareCalls;
  assert.equal(world.combat.captureState().party.some(member=>member.id===second.id),true);

  world.combat.update(16,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prepareCalls,afterRecovery,'同步完成后版本未变不再重复触发');

  session.party!.reserve(second.id);
  session.party!.deployFirstAvailable(second.id);
  world.combat.update(16,true);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(prepareCalls>afterRecovery,'同步后队伍又变化时再次触发');
  world.combat.destroy();
});

test('combat candidates reflect stealth applied during the same frame',async()=>{
  const items=loadItemCatalog(),stats=loadCharacterStatsCatalog(),campaign=loadCampaignCatalog();
  const hero=new BattleCharacter('assassin',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats);
  session.skills.maxAll();
  session.skills.bar().assign(0,1,{kind:'skill',id:'whist'});
  const map:WorldMap={id:'stealth-map',name:'stealth-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'slot',enemyId:'enemy-snake-1',x:80,y:64}]};
  const world=await createTestWorldCombat({phaserScene:completePhaserScene(),map,hero,session,battleCatalog:battle,items,characterStats:stats});
  await world.combat.start();
  for(let i=0;i<5;i++)world.combat.update(60,true);
  assert.notEqual(world.combat.diagnostics().enemies?.[0]?.state,'idle');

  world.combat.attack('whist');
  for(let i=0;i<6;i++){
    world.combat.update(60,true);
    if(world.combat.stealthed('player'))break;
  }
  assert.equal(world.combat.stealthed('player'),true);
  assert.equal(world.combat.diagnostics().enemies?.[0]?.state,'idle','同帧施加潜行后敌人立即在候选中丢失目标');
  world.combat.destroy();

  const harness=createCombatTestHarness({battleCatalog:battle,items,characterStats:stats,hero,members:new Map([['player',hero]]),activeParty:()=>['player']});
  assert.deepEqual(harness.settlement.partyBuffSlots()[0]?.actor.states,[]);
  harness.conditions.applyStateFrames('player','stealthed',10);
  assert.deepEqual(harness.settlement.partyBuffSlots()[0]?.actor.states,['stealthed']);
});

test('removing an enemy invalidates the same-frame combatant snapshot',async()=>{
  const items=loadItemCatalog(),stats=loadCharacterStatsCatalog(),campaign=loadCampaignCatalog();
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats);
  const map:WorldMap={id:'remove-map',name:'remove-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'slot',enemyId:'enemy-snake-1',x:80,y:64}]};
  const world=await createTestWorldCombat({map,hero,session,battleCatalog:battle,items,characterStats:stats});
  await world.combat.start();
  assert.equal(world.combat.hasHostileTarget(),true);
  world.combat.removeEnemy('slot');
  assert.equal(world.combat.hasHostileTarget(),false);
  assert.deepEqual(world.combat.captureState().enemies,[]);
  world.combat.destroy();
});

test('a restored enemy returns to its spawn rather than its saved combat position',async()=>{
  const items=loadItemCatalog(),stats=loadCharacterStatsCatalog(),campaign=loadCampaignCatalog();
  const hero=new BattleCharacter('assassin',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats);
  session.skills.maxAll();
  session.skills.bar().assign(0,1,{kind:'skill',id:'whist'});
  const map:WorldMap={id:'home-map',name:'home-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'map-enemy',enemyId:'enemy-snake-1',x:32,y:32}]};
  const world=await createTestWorldCombat({phaserScene:completePhaserScene(),map,hero,session,battleCatalog:battle,items,characterStats:stats});
  await world.combat.start();
  const saved=world.combat.captureState();
  saved.party[0]!.position={x:208,y:32};
  saved.roster.sequence=2;
  saved.roster.enemies=[
    {key:'map-enemy',enemyId:'enemy-snake-1',x:240,y:32,health:10,mana:0},
    {key:'summon',enemyId:'enemy-snake-1',x:224,y:64,health:10,mana:0},
  ];
  const idleAi={kind:'enemy' as const,state:{state:'idle' as const,pendingReturn:false,accumulator:0,clock:0,nextPathAt:0,path:[],lastProgressAt:0,idleElapsed:0}};
  saved.enemies=[{id:'map-enemy',facing:'south',ai:structuredClone(idleAi)},{id:'summon',facing:'south',ai:structuredClone(idleAi)}];
  await world.combat.restoreState(saved);

  for(let i=0;i<5;i++)world.combat.update(60,true);
  world.combat.attack('whist');
  for(let i=0;i<6;i++)world.combat.update(60,true);

  const after=world.combat.captureState().enemies;
  const mapEnemy=after.find(enemy=>enemy.id==='map-enemy')?.ai;
  const summon=after.find(enemy=>enemy.id==='summon')?.ai;
  assert.equal(mapEnemy?.kind,'enemy');
  assert.equal(mapEnemy.state.state,'returning');
  assert.deepEqual({x:mapEnemy.state.destination?.x,y:mapEnemy.state.destination?.y},{x:32,y:32},'地图怪回到出生点而非读档时的战斗坐标');
  assert.equal(summon?.kind,'enemy');
  assert.equal(summon.state.state,'idle','无名册来源的敌人以读档坐标为归宿');
  world.combat.destroy();
});

test('combat entry creates enemies once when loading a checkpoint',async t=>{
  const items=loadItemCatalog(),stats=loadCharacterStatsCatalog(),campaign=loadCampaignCatalog(),companions=loadCompanionCatalog();
  const dkActor=battle.classes.find(entry=>entry.id==='dark-knight')!.actor;
  const map:WorldMap={id:'checkpoint-map',name:'checkpoint-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'one',enemyId:'enemy-snake-1',x:160,y:80},{id:'two',enemyId:'enemy-snake-1',x:208,y:80}]};
  for(const restore of [false,true]){
    const hero=new BattleCharacter('dark-knight',stats,items);
    const session=new Session(campaign,undefined,undefined,items,hero,battle,stats,companions);
    session.bag.add('mercenary-emblem-black-knight',2);
    const recruit=()=>session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
    const ally1=recruit(),ally2=recruit();
    session.party!.deployFirstAvailable(ally1.id);
    session.party!.deployFirstAvailable(ally2.id);
    let prepareCalls=0;
    const world=await createTestWorldCombat({
      phaserScene:completePhaserScene(),
      map,hero,session,battleCatalog:battle,items,characterStats:stats,
      sceneOverrides:{preparePartyMember:async()=>{prepareCalls++;}},
      appOverrides:{world:{actors:{[ally1.definition.actor]:dkActor,[ally2.definition.actor]:dkActor,[dkActor.id]:dkActor}} as never},
    });
    const created:string[]=[];
    const movement=world.scene.movement!;
    const origRegister=movement.register.bind(movement);
    t.mock.method(movement,'register',(...args:Parameters<typeof movement.register>)=>{
      const visual=args[0];
      if(!['player',ally1.id,ally2.id].includes(visual.entity.id))created.push(visual.entity.id);
      return origRegister(...args);
    });
    await world.combat.start({restore});
    assert.deepEqual(created,restore?[]:['one','two']);
    if(restore){
      const id=battle.enemies[0]!.id;
      const saved={roster:{sequence:2,partySize:1,enemies:[
        {key:'one',enemyId:id,x:96,y:112,health:1},
        {key:'two',enemyId:id,x:144,y:112,summonedBy:'one',health:1}]},
        conditions:{buffs:[],states:[],temporary:[]},threat:{entries:[]},party:[],
        enemies:[{id:'one',facing:'south' as const},{id:'two',facing:'north' as const}],summonGroups:[['one',['two']]] as [string,string[]][]};
      await world.combat.restoreState(saved);
      prepareCalls=0;
      const restored=world.combat.captureState();
      assert.equal(restored.roster.partySize,3,'读档后按当前上阵人数校正名册');
      world.combat.update(16,true);
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(prepareCalls,0,'读档后按当前队伍版本标记已同步');
      assert.deepEqual(restored.roster.enemies,saved.roster.enemies,'恢复保存的敌人位置、血量和召唤关系');
      assert.deepEqual(restored.summonGroups,saved.summonGroups);
    }
    world.combat.destroy();
  }
});

test('same-map rollback restores combat without rebuilding the scene',async()=>{
  const calls:string[]=[];
  const host:any=Object.assign(Object.create(WorldScene.prototype),{
    map:{id:'home'},loadingWorld:false,encounterResults:new Map(),app:{},
    projectStoryWorld:async()=>{calls.push('project');},
    combat:{discardPendingDefeats(){calls.push('discard');},restoreState:async()=>{calls.push('combat');}},
    restoreScenePositions:()=>{calls.push('positions');},syncControlledCharacter:()=>{calls.push('controlled');},
    restartStoryWorld:()=>{throw new Error('same-map rollback must not restart');}
  });
  await host.restoreStoryWorld({location:{map:'home'},generatedEntities:[],world:{},scene:{}},new AbortController().signal);
  assert.deepEqual(calls,['discard','project','combat','positions','controlled']);
});

test('manual hostile skills continue into basic attack only on completion and for the same controlled member',async()=>{
  for(const id of ['dark-strike','dark-attack','blood-curse','celestial-lightning'])assert.equal(targetsEnemies(battle.skills[id].action!),true,id);
  for(const id of ['demon-s-shield','guardian-of-darkness','hell-s-pawn','prayer-of-recovery'])assert.equal(targetsEnemies(battle.skills[id].action!),false,id);
  const items=loadItemCatalog(),stats=loadCharacterStatsCatalog(),campaign=loadCampaignCatalog(),companions=loadCompanionCatalog();
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats,companions);
  session.skills.maxAll();
  session.skills.bar().assign(0,1,{kind:'skill',id:'demon-s-shield'});
  session.bag.add('mercenary-emblem-black-knight');
  const ally=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  session.party!.deployFirstAvailable(ally.id);
  const dkActor=battle.classes.find(entry=>entry.id==='dark-knight')!.actor;
  const map:WorldMap={id:'offensive-map',name:'offensive-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'slot',enemyId:'enemy-scorpion-1',x:80,y:64}]};
  const calls:string[]=[];
  const world=await createTestWorldCombat({
    phaserScene:completePhaserScene(),
    map,hero,session,battleCatalog:battle,items,characterStats:stats,
    sceneOverrides:{offensiveSkillCompleted:id=>calls.push(id)},
    appOverrides:{world:{actors:{[ally.definition.actor]:dkActor,[dkActor.id]:dkActor}} as never},
  });
  await world.combat.start();
  const stepUntilIdle=()=>{
    for(let i=0;i<60;i++){
      world.combat.update(60,true);
      if(!world.combat.castingSkill)break;
    }
  };
  const start=(id:string)=>{
    world.session.cooldowns.resetActor('player');
    hero.setMana(hero.player.maxMana);
    if(targetsEnemies(battle.skills[id].action!))world.combat.selectEnemy('slot');
    world.combat.attack(id);
    world.combat.update(60,true);
  };

  start('dark-strike');
  assert.deepEqual(calls,[],'未结束不触发普攻');
  stepUntilIdle();
  assert.deepEqual(calls,['player']);

  calls.length=0;start('demon-s-shield');stepUntilIdle();
  assert.deepEqual(calls,[],'辅助技能不触发普攻');

  calls.length=0;start('dark-strike');
  world.combat.switchControl(ally.id);world.combat.switchControl('player');
  stepUntilIdle();
  assert.deepEqual(calls,[],'切人后即使切回原角色也不自动接普攻');

  calls.length=0;start('dark-strike');
  world.combat.switchControl(ally.id);
  stepUntilIdle();
  assert.deepEqual(calls,[],'技能完成时由其他成员操控则不接普攻');
  world.combat.switchControl('player');

  calls.length=0;start('dark-strike');
  world.combat.followControlled();
  for(let i=0;i<30;i++)world.combat.update(60,true);
  assert.deepEqual(calls,[],'取消动作不会触发结束后的普攻');
  world.combat.destroy();
});

async function pauseWorld(t:test.TestContext) {
  const items=loadItemCatalog(),stats=loadCharacterStatsCatalog(),campaign=loadCampaignCatalog(),companions=loadCompanionCatalog();
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats,companions);
  session.skills.maxAll();
  session.bag.add('mercenary-emblem-black-knight');
  const ally=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  session.party!.deployFirstAvailable(ally.id);
  ally.skills.maxAll(battle,ally.classId);
  const dkActor=battle.classes.find(entry=>entry.id==='dark-knight')!.actor;
  const map:WorldMap={id:'pause-map',name:'pause-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'slot',enemyId:'enemy-scorpion-1',x:80,y:64}]};
  const paused:boolean[]=[],stopped:string[]=[],temporary:string[]=[],cancelled:string[]=[];
  const origSetPaused=CombatPresenter.prototype.setPaused;
  t.mock.method(CombatPresenter.prototype,'setPaused',function(this:InstanceType<typeof CombatPresenter>,value:boolean){
    paused.push(value);
    return origSetPaused.call(this,value);
  });
  const origCancel=CombatController.prototype.cancel;
  t.mock.method(CombatController.prototype,'cancel',function(this:CombatController,...args:Parameters<CombatController['cancel']>){
    cancelled.push((this as unknown as {casterId:string}).casterId);
    return origCancel.apply(this,args);
  });
  const origClearTemp=CombatConditions.prototype.clearTemporary;
  t.mock.method(CombatConditions.prototype,'clearTemporary',function(this:CombatConditions,id:string){
    temporary.push(id);
    return origClearTemp.call(this,id);
  });
  const world=await createTestWorldCombat({
    phaserScene:completePhaserScene(),
    map,hero,session,battleCatalog:battle,items,characterStats:stats,
    appOverrides:{world:{actors:{[ally.definition.actor]:dkActor,[dkActor.id]:dkActor}} as never},
  });
  const movement=world.scene.movement!;
  const origStop=movement.stop.bind(movement);
  t.mock.method(movement,'stop',(visual:Parameters<typeof movement.stop>[0])=>{
    stopped.push(visual.entity.id);
    return origStop(visual);
  });
  await world.combat.start();
  const beginBoth=()=>{
    world.session.cooldowns.resetActor('player');
    world.session.cooldowns.resetActor(ally.id);
    hero.setMana(hero.player.maxMana);
    ally.setMana(ally.player.maxMana);
    world.combat.selectEnemy('slot');
    world.combat.attack('dark-strike');
    for(let i=0;i<3;i++)world.combat.update(60,true);
  };
  return {world,ally,paused,stopped,temporary,cancelled,beginBoth};
}

test('a menu pause preserves party actions and cooldowns until control resumes',async t=>{
  const f=await pauseWorld(t);
  f.beginBoth();
  const initialRemaining=f.world.combat.cooldowns['dark-strike']!.remainingMs;
  assert.ok(initialRemaining>0);
  f.paused.length=0;f.cancelled.length=0;
  f.world.combat.setPaused(true);
  assert.equal(f.world.combat.paused,true);
  f.world.combat.update(60,false);
  assert.equal(f.world.combat.attackState,'attacking');
  assert.equal(f.cancelled.length,0);
  assert.equal(f.world.combat.cooldowns['dark-strike']!.remainingMs,initialRemaining);
  f.world.combat.setPaused(false);
  assert.equal(f.world.combat.paused,false);
  assert.equal(f.paused.includes(true),true);
  assert.equal(f.paused.includes(false),true);
  f.world.combat.destroy();
});

test('resetting skills during a menu cancels the hero delayed work while preserving paid cooldowns',async t=>{
  const f=await pauseWorld(t);
  f.beginBoth();
  const remaining=f.world.combat.cooldowns['dark-strike']!.remainingMs;
  f.world.combat.setPaused(true);
  f.cancelled.length=0;
  f.world.session.skills.reset();
  assert.equal(f.cancelled.includes('player'),true);
  assert.equal(f.cancelled.includes(f.ally.id),false);
  assert.equal(f.world.combat.attackState,'idle');
  assert.equal(f.world.combat.cooldowns['dark-strike']!.remainingMs,remaining);
  const allyPartyState=f.world.combat.captureState().party.find(member=>member.id===f.ally.id);
  assert.notEqual(allyPartyState?.combat.state,'idle');
  f.world.combat.destroy();
});

test('cinematic takeover cancels every party action and old callbacks once, keeping cooldowns',async t=>{
  const f=await pauseWorld(t);
  f.beginBoth();
  const remaining=f.world.combat.cooldowns['dark-strike']!.remainingMs;
  f.stopped.length=0;f.temporary.length=0;f.cancelled.length=0;
  f.world.combat.suspendPartyActions();
  const once={stopped:[...f.stopped],temporary:[...f.temporary],cancelled:[...f.cancelled]};
  f.world.combat.suspendPartyActions();
  assert.deepEqual({stopped:f.stopped,temporary:f.temporary,cancelled:f.cancelled},once);
  assert.equal(once.cancelled.includes('player'),true);
  assert.equal(once.cancelled.includes(f.ally.id),true);
  assert.equal(once.stopped.includes('player'),true);
  assert.equal(once.stopped.includes(f.ally.id),true);
  assert.equal(once.temporary.includes('player'),true);
  assert.equal(once.temporary.includes(f.ally.id),true);
  assert.equal(f.world.combat.attackState,'idle');
  assert.equal(f.world.combat.cooldowns['dark-strike']!.remainingMs,remaining);
  f.world.combat.update(60,true);
  assert.ok(f.world.combat.cooldowns['dark-strike']!.remainingMs<remaining);
  f.world.combat.destroy();
});

test('a second dialogue input lock does not cancel or stop combat again',async t=>{
  const f=await pauseWorld(t);
  f.beginBoth();
  f.cancelled.length=0;f.stopped.length=0;
  f.world.combat.suspendPartyActions();
  assert.equal(f.cancelled.includes('player'),true);
  assert.equal(f.cancelled.includes(f.ally.id),true);
  f.stopped.length=0;f.cancelled.length=0;
  f.world.combat.suspendPartyActions();
  assert.deepEqual(f.stopped,[]);
  assert.deepEqual(f.cancelled,[]);
  f.world.combat.destroy();
});

test('finishing cinematic presentation leaves formal player and companion camera unchanged',async()=>{
  const companion={container:{x:80,y:32}},player={container:{x:32,y:32}};
  const camera={follow:companion.container};
  const world={player,map:{id:'test'},cameras:{main:camera},
    movement:{place(){throw new Error('presentation cannot move formal player');}},
    syncControlledCharacter(){throw new Error('runtime projects after the node commits');}
  } as unknown as InstanceType<typeof WorldScene>;
  const stage={map:undefined};
  const presenter=new StoryPresenter({} as StoryContext,()=>world,()=>stage as unknown as import('../src/scenes/story-stage-scene.ts').StoryStageScene);
  await presenter.finish(true,new AbortController().signal);
  assert.equal(camera.follow,companion.container);
  assert.deepEqual(player.container,{x:32,y:32});
});

test('a controlled companion already inside an exit must leave it before the performance can trigger travel again',()=>{
  const exit={x:64,y:0,width:32,height:64,destination:'next-map',spawn:{x:8,y:8},facing:'east' as const};
  const companion={container:{active:true,x:80,y:32}};
  const state={app:{gmNoclip:false},player:{container:{active:true,x:32,y:32}},combat:{controlledVisual:companion},map:{exits:[exit]},
    movement:{position:()=>({x:80,y:32})},cameras:{main:{startFollow(){}}},refreshLoadout(){},refreshCombatTarget(){},syncHud(){}};
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  scene.syncControlledCharacter(true);
  assert.equal(scene.exitTrigger!.update({x:82,y:32},true),null);
  assert.equal(scene.exitTrigger!.update({x:40,y:32},true),null);
  assert.equal(scene.exitTrigger!.update({x:80,y:32},true),exit);
});

test('a companion warlock commands only its own soldier, and an untargeted summon fires in place',()=>{
  const casterId='companion-warlock',calls:{summon:string;target:string|undefined;level:number}[]=[];
  const pawnDef=battle.enemies.find(enemy=>enemy.id==='enemy-hell-s-pawn-1')!;
  const wolfDef=battle.enemies.find(enemy=>enemy.id==='enemy-snake-1')!;
  const member=createTestMember({id:casterId,classId:'warlock',level:40,panel:{attributes:{strength:3,dexterity:4,vitality:5,intelligence:6,mentality:7}}});
  const enemies=new Map([
    ['own',createTestEnemy({key:'own',definition:pawnDef,summonedBy:casterId})],
    ['hero-summon',createTestEnemy({key:'hero-summon',definition:pawnDef,summonedBy:'player'})],
    ['other',createTestEnemy({key:'other',definition:pawnDef,summonedBy:'companion-ranger'})],
    ['hostile',createTestEnemy({key:'hostile',definition:wolfDef})],
  ]);
  const harness=createCombatTestHarness({
    battleCatalog:battle,
    members:new Map([[casterId,member]]),
    enemies,
    activeParty:()=>[casterId],
    settlementOverrides:{
      commandSummon:(summonKey,_command,targetKey,level)=>calls.push({summon:summonKey,target:targetKey,level}),
    },
  });
  const action=battle.skills['monster-s-scream'].action!;
  const cueIndex=action.combatUnits!.findIndex(unit=>unit.effect==='action');
  harness.settlement.skillUnit({casterId,targetId:casterId,cueIndex,skill:{id:'monster-s-scream',action,level:3}});
  assert.deepEqual(calls,[{summon:'own',target:undefined,level:3}]);
});

test('the scream fails, and spends nothing, when the caster owns no summon',()=>{
  const casterId='companion-warlock',calls:unknown[]=[];
  const wolfDef=battle.enemies.find(enemy=>enemy.id==='enemy-snake-1')!;
  const member=createTestMember({id:casterId,classId:'warlock',level:40,panel:{attributes:{strength:0,dexterity:0,vitality:0,intelligence:9,mentality:0}}});
  const harness=createCombatTestHarness({
    battleCatalog:battle,
    members:new Map([[casterId,member]]),
    enemies:new Map([['hostile',createTestEnemy({key:'hostile',definition:wolfDef})]]),
    activeParty:()=>[casterId],
    settlementOverrides:{
      commandSummon:(summonKey,_command,targetKey,level)=>calls.push({summonKey,targetKey,level}),
    },
  });
  const action=battle.skills['monster-s-scream'].action!;
  const cueIndex=action.combatUnits!.findIndex(unit=>unit.effect==='action');
  const outcome=harness.settlement.skillUnit({casterId,targetId:casterId,cueIndex,skill:{id:'monster-s-scream',action,level:1}});
  assert.equal(outcome,'failure','没有召唤就不算成功，也就不会耗资源');
  assert.deepEqual(calls,[]);
});

test('every active summon of the caster is commanded, and it follows the summon current target',()=>{
  const casterId='companion-warlock',calls:{summon:string;target:string|undefined}[]=[];
  const pawnDef=battle.enemies.find(enemy=>enemy.id==='enemy-hell-s-pawn-1')!;
  const wolfDef=battle.enemies.find(enemy=>enemy.id==='enemy-snake-1')!;
  const member=createTestMember({id:casterId,classId:'warlock',level:40,panel:{attributes:{strength:0,dexterity:0,vitality:0,intelligence:9,mentality:0}}});
  const enemies=new Map([
    ['far',createTestEnemy({key:'far',definition:pawnDef,summonedBy:casterId,targetId:'other'})],
    ['near',createTestEnemy({key:'near',definition:pawnDef,summonedBy:casterId,targetId:'hostile'})],
    ['hostile',createTestEnemy({key:'hostile',definition:wolfDef})],
    ['other',createTestEnemy({key:'other',definition:wolfDef})],
  ]);
  const positions:Record<string,{x:number;y:number}>={
    [casterId]:{x:0,y:0},far:{x:900,y:0},near:{x:10,y:0},hostile:{x:12,y:0},other:{x:950,y:0},
  };
  const harness=createCombatTestHarness({
    battleCatalog:battle,
    members:new Map([[casterId,member]]),
    enemies,
    activeParty:()=>[casterId],
    combatant:id=>({id,team:id==='hostile'||id==='other'?'hostile':'party',position:positions[id]??{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}}),
    settlementOverrides:{
      commandSummon:(summonKey,_command,targetKey)=>calls.push({summon:summonKey,target:targetKey}),
    },
  });
  const action=battle.skills['monster-s-scream'].action!;
  const cueIndex=action.combatUnits!.findIndex(unit=>unit.effect==='action');
  const outcome=harness.settlement.skillUnit({casterId,targetId:casterId,cueIndex,skill:{id:'monster-s-scream',action,level:1}});
  assert.equal(outcome,'success');
  assert.deepEqual(calls,[{summon:'far',target:'other'},{summon:'near',target:'hostile'}]);
});

test('a spring that has already been drunk is no longer an interaction target',()=>{
  const spring={container:{visible:true,x:8,y:0},actor:{},entity:{id:'well-1',actor:'clear-springs-f6f095b4',x:8,y:0,spring:true}};
  // 任务查询自己负责刷新投影；场景层不再每帧强制刷新整份任务状态。
  let refreshed=0;
  const state=(empty:boolean)=>({player:{container:{visible:true,x:0,y:0}},characters:[spring],combat:{controlledVisual:undefined},map:{id:'forest'},
    app:{session:{refresh:()=>{refreshed++;},springs:{isEmpty:()=>empty},chests:{isOpened:()=>false},
      // 交互判定会先看任务槽、任务目标标记和可交互声明；泉水用例只关心泉水本身。
      npcQuestSlot:()=>undefined,canInteract:()=>false,status:()=>'locked',markerActor:()=>undefined},
    campaign:{quests:[]}}});
  const scene=Object.setPrototypeOf(state(true),WorldScene.prototype) as unknown as {near:unknown;updateInteractionTarget():void};
  scene.updateInteractionTarget();
  assert.equal(scene.near,null,'喝空的泉水不再靠近可交互');
  const full=Object.setPrototypeOf(state(false),WorldScene.prototype) as unknown as {near:unknown;updateInteractionTarget():void};
  full.updateInteractionTarget();
  assert.equal(full.near,spring,'满水的泉水照常可选');
  assert.equal(refreshed,0,'交互判定不再每帧强制刷新任务投影');
});

test('drinking replaces the spring visuals with the waterless well',()=>{
  const clip=(key:string)=>({frameWidth:43,frameHeight:34,frames:1,originX:.5,originY:1,frameRate:10,mirrorX:false,layers:[{key,file:'',blend:'normal'}]});
  const world={actors:{'clear-springs-f6f095b4':{clips:{'idle-south':clip('clear-springs-f6f095b4-idle-south-normal')}},
    'well-7abb1f76':{clips:{'idle-south':clip('well-7abb1f76-idle-south-normal')}}}};
  const drawn:string[]=[];
  const sprite=(key:string)=>({key,alpha:1,setOrigin(){return this;},setBlendMode(){return this;},setTexture(){return this;},setVisible(){return this;},setScale(){return this;},setAlpha(){return this;},destroy(){},play(){},anims:{}});
  // drainSpring 把场景本身当作 Phaser scene 用，所以贴图工厂与动画表挂在 state 上。
  const character={entity:{id:'well-1',actor:'clear-springs-f6f095b4',x:0,y:0},actor:world.actors['clear-springs-f6f095b4'],container:{addAt(){}},layers:[],clipName:'idle-south' as const};
  const state={springCatalog:{empty:'well-7abb1f76'},app:{world},
    anims:{exists:()=>true,create(){},generateFrameNumbers:()=>[]},
    add:{sprite:(_x:number,_y:number,key:string)=>{drawn.push(key);return sprite(key);}}};
  const runtime=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as {drainSpring(character:unknown):void};
  runtime.drainSpring(character);
  assert.equal(character.actor,world.actors['well-7abb1f76'],'换成没有液体的水井外观');
  assert.deepEqual(drawn,['well-7abb1f76-idle-south-normal'],'图层按新外观重建，而不是沿用旧贴图');
});

test('party death finishes on logical time even when no Tween completion arrives',async()=>{
  const items=loadItemCatalog(),stats=loadCharacterStatsCatalog(),campaign=loadCampaignCatalog(),companions=loadCompanionCatalog();
  let defeats=0,stopped=0;
  const makePhaser=()=>({
    ...({} as object),
    tweens:{add:(options:object)=>{assert.equal('onComplete' in options,false);return {stop:()=>{stopped++;},pause(){},resume(){}};}} as never,
  });
  const soloHero=new BattleCharacter('dark-knight',stats,items);
  const soloSession=new Session(campaign,undefined,undefined,items,soloHero,battle,stats,companions);
  const soloWorld=await createTestWorldCombat({
    hero:soloHero,session:soloSession,battleCatalog:battle,items,characterStats:stats,
    phaserScene:Object.assign((await import('./support/world-combat-fixture.ts')).createFakePhaserScene(),makePhaser()),
    sceneOverrides:{handleCombatDefeat:()=>{defeats++;}},
  });
  await soloWorld.combat.start();
  soloHero.setHealth(0);
  assert.equal(defeats,0);
  for(let i=0;i<9;i++)soloWorld.combat.update(60,true);
  assert.equal(defeats,0);
  assert.equal(soloWorld.playerVisual.container.visible,true);
  soloWorld.combat.update(60,true);
  assert.equal(defeats,1);
  assert.equal(soloWorld.playerVisual.container.visible,false);
  assert.equal(stopped,1);
  soloWorld.combat.destroy();

  // 有存活队友时暂停推进，已倒下主角的 10 帧退场计时不会走动
  stopped=0;
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats,companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  session.party!.deployFirstAvailable(ally.id);
  const dkActor=battle.classes.find(entry=>entry.id==='dark-knight')!.actor;
  const partyWorld=await createTestWorldCombat({
    hero,session,battleCatalog:battle,items,characterStats:stats,
    phaserScene:Object.assign((await import('./support/world-combat-fixture.ts')).createFakePhaserScene(),makePhaser()),
    appOverrides:{world:{actors:{[ally.definition.actor]:dkActor,[dkActor.id]:dkActor}} as never},
  });
  await partyWorld.combat.start();
  hero.setHealth(0);
  partyWorld.combat.update(60,false);
  partyWorld.combat.update(60,false);
  assert.equal(partyWorld.playerVisual.container.visible,true);
  assert.equal(stopped,0);
  for(let i=0;i<9;i++)partyWorld.combat.update(60,true);
  assert.equal(partyWorld.playerVisual.container.visible,true);
  partyWorld.combat.update(60,true);
  assert.equal(partyWorld.playerVisual.container.visible,false);
  assert.equal(stopped,1);
  partyWorld.combat.destroy();
});

test('exit prefetch switches direction and retries a failed target after a delay', async () => {
  const requests:string[]=[], retained:string[]=[];
  let resolveFirst!: (value: unknown) => void;
  let failB = true;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const host:any = Object.assign(Object.create(WorldScene.prototype), {
    map:{id:'current',exits:[
      {destination:'a',x:100,y:0,width:2,height:2},
      {destination:'b',x:-100,y:0,width:2,height:2}
    ]},
    request:new AbortController(),loadingWorld:false,destroyed:false,time:{now:0},
    cameras:{main:{worldView:{contains:()=>true}}},exitAvailable:()=>true,
    textures:{exists:()=>true,get:()=>({has:()=>true}),on:()=>{},remove:()=>{}},
    anims:{exists:()=>false,remove:()=>{}},events:{off:()=>{},once:()=>{}},
    app:{world:{maps:[{id:'a',file:'a'},{id:'b',file:'b'}]},
      content:{map:(file:string)=>{requests.push(file);if(file==='a')return first;
        if(failB){failB=false;return Promise.reject(new Error('offline'));}
        return Promise.resolve({id:'b',ground:'b-ground',canopy:'b-canopy'});}},
      retainMapPrefetch:()=>retained.push('b')}
  });
  host.prefetchVisibleExit({x:0,y:0},{x:-1,y:0});
  host.prefetchVisibleExit({x:0,y:0},{x:1,y:0});
  assert.deepEqual(requests,['a','b'],'新方向立即开始预取，不等待旧目标');
  resolveFirst({id:'a',ground:'a-ground',canopy:'a-canopy'});
  await host.prefetchTask;
  assert.deepEqual(requests,['a','b']);
  assert.equal(host.prefetchTarget,undefined);
  host.prefetchVisibleExit({x:0,y:0},{x:1,y:0});
  assert.deepEqual(requests,['a','b']);
  host.time.now=1000;
  host.prefetchVisibleExit({x:0,y:0},{x:1,y:0});
  await host.prefetchTask;
  assert.deepEqual(requests,['a','b','b']);
  assert.deepEqual(retained,['b']);
});
