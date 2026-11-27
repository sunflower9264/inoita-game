import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { BattleCatalog, EnemyDefinition } from '../src/domain/battle.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import { CombatRuntime } from '../src/domain/combat-runtime.ts';
import { CombatSettlementEngine } from '../src/domain/combat-settlement.ts';
import type { ActorDefinition, WorldMap } from '../src/domain/content.ts';
import { EnemyRoster } from '../src/domain/enemy-roster.ts';
import { Session } from '../src/domain/session.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
import { CHARACTER_ATLAS_ALIASES } from '../tools/character-atlas-aliases.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import {
  createFakeContainer,
  createFakePhaserScene,
  createTestWorldCombat,
  installPhaserStubHooks,
} from './support/world-combat-fixture.ts';

const hook=installPhaserStubHooks();
const {CombatOutcomes}=await import('../src/rendering/combat-outcomes.ts');
const {WorldScene}=await import('../src/scenes/world-scene.ts');
hook.deregister();

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

const battle=normalizeBattleCatalog(JSON.parse(fs.readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog);
const wolf=battle.enemies.find((enemy)=>enemy.id==='enemy-wolf-1') as EnemyDefinition;

function fullPhaserScene(){
  const scene=createFakePhaserScene({
    cameras:{main:{width:640,height:360,zoomX:1,zoomY:1,worldView:undefined,followOffset:{x:0,y:0},setFollowOffset(){}}},
    tweens:{add:()=>({stop(){},pause(){},resume(){}}),getTweensOf:()=>[],killTweensOf:()=>{}},
  });
  const origSprite=scene.add.sprite.bind(scene.add) as unknown as (...args:unknown[])=>{scene:unknown;anims:Record<string,unknown>};
  scene.add.sprite=((...args:unknown[])=>{
    const sprite=origSprite(...args);
    sprite.scene=scene;
    sprite.anims={...sprite.anims,create:()=>({destroy(){}}),remove:()=>{}};
    return sprite as never;
  }) as never;
  return scene;
}

function ticketMap(id:string,spawns:WorldMap['enemySpawns']):WorldMap{
  return {
    id,name:id,width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:spawns,
  };
}

test('roster reports a zero only after an explicit zero write',()=>{
  const roster=new EnemyRoster();
  const placed=roster.placeEnemy(wolf.id,0,0);
  assert.equal(roster.hasZeroHealth(placed.key),false,'未写入过血量按满血处理');
  roster.setEnemyHealth(placed.key,0,wolf);
  assert.equal(roster.hasZeroHealth(placed.key),true);
  roster.setEnemyHealth(placed.key,1,wolf);
  assert.equal(roster.hasZeroHealth(placed.key),false);
});

test('restore and spawn boundaries open a ticket only for zero-health enemies',async t=>{
  const map=ticketMap('ticket-boundary-map',[
    {id:'zero',enemyId:'enemy-wolf-1',x:180,y:180,respawn:false},
    {id:'live',enemyId:'enemy-wolf-1',x:220,y:220,respawn:false},
  ]);
  const world=await createTestWorldCombat({map,battleCatalog:battle,phaserScene:fullPhaserScene()});
  await world.combat.start();
  const settled:string[]=[];
  const origSettle=world.session.settleEnemyDefeat.bind(world.session);
  t.mock.method(world.session,'settleEnemyDefeat',(req:Parameters<Session['settleEnemyDefeat']>[0])=>{
    settled.push(req.key);
    return origSettle(req);
  });
  const snapshot=world.combat.captureState();
  snapshot.roster.enemies.find(entry=>entry.key==='zero')!.health=0;
  await world.combat.restoreState(snapshot);
  assert.deepEqual(settled,['zero']);
  assert.equal(world.roster.isPresent('live'),true);
  assert.equal(world.roster.isPresent('zero'),false);
  world.combat.destroy();

  const items=loadItemCatalog(),statsCatalog=loadCharacterStatsCatalog(),campaign=loadCampaignCatalog(),battleCatalog=normalizeBattleCatalog(loadBattleCatalog());
  const hero2=new BattleCharacter('dark-knight',statsCatalog,items);
  const session2=new Session(campaign,undefined,undefined,items,hero2,battleCatalog);
  session2.applyStoryCommands([{type:'world',command:{kind:'hide',id:'zero'}}]);
  const world2=await createTestWorldCombat({hero:hero2,session:session2,map,battleCatalog,phaserScene:fullPhaserScene()});
  await world2.combat.start();
  const settled2:string[]=[];
  const origSettle2=session2.settleEnemyDefeat.bind(session2);
  t.mock.method(session2,'settleEnemyDefeat',(req:Parameters<Session['settleEnemyDefeat']>[0])=>{
    settled2.push(req.key);
    return origSettle2(req);
  });
  session2.setEnemyVitals('zero',0,0);
  session2.applyStoryCommands([{type:'world',command:{kind:'show',id:'zero'}}]);
  world2.combat.syncChestEnemies();
  assert.deepEqual(settled2,['zero']);
  assert.equal(world2.roster.isPresent('live'),true);
  assert.equal(world2.roster.isPresent('zero'),false);
  world2.combat.destroy();
});

test('zero-health and awaiting-defeat enemies stay out of the combatant list',async t=>{
  t.mock.method(Math,'random',()=>0.5);
  const map=ticketMap('combatant-filter-map',[{id:'zero',enemyId:'enemy-wolf-1',x:72,y:64}]);
  const world=await createTestWorldCombat({map,battleCatalog:battle,phaserScene:fullPhaserScene()});
  await world.combat.start();
  assert.equal(world.combat.hasHostileTarget(),true,'正常敌人照常返回');

  const awaitingMock=t.mock.method(CombatHitResolution.prototype,'isAwaitingDefeat',(id:string)=>id==='zero');
  world.combat.update(60,true);
  assert.equal(world.combat.hasHostileTarget(),false,'同串命中里等待死亡结算的敌人也不能进入候选名单');
  awaitingMock.mock.restore();

  world.roster.setEnemyHealth('zero',0,wolf);
  assert.equal(world.combat.hasHostileTarget(),false,'0 血敌人不能进入候选名单');

  world.roster.setEnemyHealth('zero',1,wolf);
  const threatActors:Array<{id:string;active:boolean}|undefined>=[];
  const origThreatActor=CombatSettlementEngine.prototype.threatActor;
  t.mock.method(CombatSettlementEngine.prototype,'threatActor',function(this:CombatSettlementEngine,id:string){
    const result=origThreatActor.call(this,id);
    if(id==='zero'&&world.roster.hasZeroHealth('zero'))threatActors.push(result?{id:result.id,active:result.active}:undefined);
    return result;
  });
  world.combat.selectEnemy('zero');
  world.combat.attack();
  for(let step=0;step<20&&!threatActors.length;step++)world.combat.update(60,true);
  assert.ok(threatActors.some(entry=>entry?.id==='zero'&&entry.active),'单点查询不按血量过滤，保留反伤与友方救援语义');
  world.combat.destroy();
});

test('a lethal hit opens one defeat ticket through the shared entry',()=>{
  const hero=createTestMember({level:3});
  const target=createTestEnemy({key:'wolf',definition:wolf,health:10,maxHealth:10,level:3,elite:false});
  let invalidated=0;
  const harness=createCombatTestHarness({
    hero,
    members:new Map([['player',hero]]),
    enemies:new Map([['wolf',target]]),
    settlementOverrides:{onInvalidateCombatants:()=>{invalidated++;}},
  });
  harness.hitResolution.run(()=>harness.settlement.settleHit({casterId:'player',targetId:'wolf'},{kind:'hit',damage:10},target));
  assert.equal(harness.log.zeroHealthEnemies.length,1,'致死命中只开一张死亡单');
  assert.equal(invalidated,1,'致死命中立刻让候选名单缓存失效');
  assert.equal(harness.log.zeroHealthEnemies[0]!.key,'wolf');
  assert.equal(harness.log.zeroHealthEnemies[0]!.casterId,'player');
  assert.equal(harness.log.zeroHealthEnemies[0]!.before.health,10);
  assert.equal(harness.log.zeroHealthEnemies[0]!.before.maxHealth,10);
  assert.equal(harness.log.zeroHealthEnemies[0]!.before.level,3);
  assert.equal(harness.log.zeroHealthEnemies[0]!.before.elite,false);
  harness.hitResolution.run(()=>harness.settlement.settleHit({casterId:'player',targetId:'wolf'},{kind:'hit',damage:10},target));
  assert.equal(harness.log.zeroHealthEnemies.length,1,'已经 0 血的敌人不会重复开单');
});

test('save settlement flushes the queue before capturing',async t=>{
  t.mock.method(Math,'random',()=>0.5);
  const map=ticketMap('save-flush-map',[{id:'wolf',enemyId:'enemy-wolf-1',x:72,y:64}]);
  const world=await createTestWorldCombat({map,battleCatalog:battle,phaserScene:fullPhaserScene()});
  await world.combat.start();
  world.roster.setEnemyHealth('wolf',1,wolf);
  world.combat.selectEnemy('wolf');
  world.combat.attack();
  for(let step=0;step<20&&world.roster.enemySnapshot('wolf',wolf,world.hero.level)!.health>0;step++)world.combat.update(60,true);
  assert.equal(world.roster.enemySnapshot('wolf',wolf,world.hero.level)!.health,0);
  assert.equal(world.session.enemyVitals('wolf').deadUntil,undefined);
  world.combat.settleForSave();
  assert.notEqual(world.session.enemyVitals('wolf').deadUntil,undefined);
  world.combat.destroy();
});

test('rollback discards pending defeats without settling them',async t=>{
  t.mock.method(Math,'random',()=>0.5);
  const map=ticketMap('rollback-discard-map',[{id:'wolf',enemyId:'enemy-wolf-1',x:72,y:64}]);
  let defeats=0;
  const world=await createTestWorldCombat({
    map,battleCatalog:battle,phaserScene:fullPhaserScene(),
    sceneOverrides:{handleCombatDefeat:()=>{defeats++;}},
  });
  await world.combat.start();
  let settled=0;
  const origSettle=world.session.settleEnemyDefeat.bind(world.session);
  t.mock.method(world.session,'settleEnemyDefeat',(req:Parameters<Session['settleEnemyDefeat']>[0])=>{
    settled++;
    return origSettle(req);
  });
  const cancelled:string[]=[],runtimeCancelled:string[]=[];
  const origCancelDeath=CombatOutcomes.prototype.cancelDeath;
  t.mock.method(CombatOutcomes.prototype,'cancelDeath',function(this:InstanceType<typeof CombatOutcomes>,key:string){
    cancelled.push(key);
    return origCancelDeath.call(this,key);
  });
  const origRuntimeCancel=CombatRuntime.prototype.cancel;
  t.mock.method(CombatRuntime.prototype,'cancel',function(this:CombatRuntime,owner:string){
    runtimeCancelled.push(owner);
    return origRuntimeCancel.call(this,owner);
  });

  world.roster.setEnemyHealth('wolf',1,wolf);
  world.combat.selectEnemy('wolf');
  world.combat.attack();
  for(let step=0;step<20&&world.roster.enemySnapshot('wolf',wolf,world.hero.level)!.health>0;step++)world.combat.update(60,true);
  assert.equal(settled,0);
  world.hero.setHealth(0);
  cancelled.length=0;runtimeCancelled.length=0;

  world.combat.discardPendingDefeats();
  assert.deepEqual(cancelled,['wolf'],'取消消散表现');
  assert.deepEqual(runtimeCancelled,['defeat:wolf'],'取消排定的结算');
  assert.equal(world.combat.hasHostileTarget(),false);
  world.hero.setHealth(world.hero.player.maxHealth);
  world.combat.update(5000,true);
  assert.equal(world.session.enemyVitals('wolf').deadUntil,undefined);
  assert.equal(settled,0,'不执行死亡结算');
  assert.equal(defeats,0,'不执行队伍倒下收尾');
  world.combat.destroy();
});

test('checkpoints settle pending defeats before capturing session and world',()=>{
  let flushed=0,captured=0;
  const host=Object.setPrototypeOf({
    app:{pressureMode:false,session:{hasWaitingStoryRun:false,hasLivingMember:true},
      gm:undefined,checkpoint:{available:false,capture:()=>{captured++;return true;}}},
    combat:{settleForSnapshot:()=>{flushed++;}},
    worldReady:()=>true,map:{id:'camp'},movement:{position:()=>({x:0,y:0})},player:{},
    captureStoryWorld:()=>({location:{map:'camp'},generatedEntities:[]}),
    checkpointWaitLogged:false,checkpointPending:true
  },WorldScene.prototype);
  assert.equal(Reflect.get(WorldScene.prototype,'captureCheckpoint').call(host),true);
  assert.equal(flushed,1,'捕获检查点前先结算死亡单');
  assert.equal(captured,1);
});


test('normal map travel settles confirmed defeats before changing the session location',()=>{
  const calls:string[]=[];
  const host=Object.setPrototypeOf({loadingWorld:false,exitAvailable:()=>true,
    combat:{settleForSave(){calls.push('settle');},finishMapVisit(){calls.push('finish');}},
    app:{session:{applyStoryCommands(){calls.push('travel');}},ui:{loading(){}}},
    beginWorldSwitch(){calls.push('switch');},scene:{restart(){calls.push('restart');}}
  },WorldScene.prototype);
  host.changeMap({destination:'next',spawn:{x:1,y:2},facing:'south'});
  assert.deepEqual(calls,['settle','finish','travel','switch','restart']);
});

test('world restore cancels old defeat work before projecting a different map',async()=>{
  const calls:string[]=[];
  const host=Object.setPrototypeOf({map:{id:'old'},encounterResults:new Map(),app:{},
    combat:{discardPendingDefeats(){calls.push('discard');}},
    restartStoryWorld:async()=>{calls.push('restore');}
  },WorldScene.prototype);
  await host.restoreStoryWorld({location:{map:'new'},generatedEntities:[]},new AbortController().signal);
  assert.deepEqual(calls,['discard','restore']);
});

test('combat destruction releases pending defeats without applying rewards',async t=>{
  t.mock.method(Math,'random',()=>0.5);
  let rewards=0,destroyed=0;
  const map=ticketMap('destroy-pending-map',[{id:'wolf',enemyId:'enemy-wolf-1',x:72,y:64}]);
  const world=await createTestWorldCombat({map,battleCatalog:battle,phaserScene:fullPhaserScene()});
  await world.combat.start();
  const origSettle=world.session.settleEnemyDefeat.bind(world.session);
  t.mock.method(world.session,'settleEnemyDefeat',(req:Parameters<Session['settleEnemyDefeat']>[0])=>{
    rewards++;
    return origSettle(req);
  });
  const origDestroy=CombatOutcomes.prototype.destroy;
  t.mock.method(CombatOutcomes.prototype,'destroy',function(this:InstanceType<typeof CombatOutcomes>){
    destroyed++;
    return origDestroy.call(this);
  });
  world.roster.setEnemyHealth('wolf',1,wolf);
  world.combat.selectEnemy('wolf');
  world.combat.attack();
  for(let step=0;step<20&&world.roster.enemySnapshot('wolf',wolf,world.hero.level)!.health>0;step++)world.combat.update(60,true);
  assert.equal(rewards,0);
  world.combat.destroy();world.combat.destroy();
  world.combat.settleForSave();
  assert.equal(rewards,0,'释放旧世界不能推进任务或发奖励');
  assert.equal(destroyed,1,'重复销毁只释放一次');
});


test('disposing an old enemy visual preserves restored session vitals and cooldowns',async()=>{
  const map=ticketMap('dispose-preserve-map',[{id:'wolf',enemyId:'enemy-wolf-1',x:180,y:180}]);
  const world=await createTestWorldCombat({map,battleCatalog:battle,phaserScene:fullPhaserScene()});
  await world.combat.start();
  world.session.setEnemyVitals('wolf',40,7);
  world.session.cooldowns.forActor('wolf').start('probe',20);
  world.combat.destroy();
  assert.deepEqual(world.session.enemyVitals('wolf'),{health:40,mana:7});
  assert.equal(world.session.cooldowns.forActor('wolf').isReady('probe'),false);
});

test('a failed death settlement keeps the one-time encounter winnable after saving and restoring', async t => {
  const { headlessContent, playthrough } = await import('./helpers/story-playthrough.ts');
  const map = headlessContent.maps.get('werewolf-lair-43f5b4c5')!;
  const h = playthrough();
  let restored: ReturnType<typeof playthrough> | undefined;
  let world: Awaited<ReturnType<typeof createTestWorldCombat>> | undefined;
  try {
    assert.equal(h.session.accept('quest-46'), true);
    h.session.applyStoryCommands([{type:'travel',destination:{map:map.id,x:300,y:152,facing:'east'}}]);
    await h.region('event-60');
    const roster = new WorldEnemyRoster(h.session, map, [], h.session.hero!.level);
    const spawn = roster.spawns.find(spawn => spawn.enemyId === 'enemy-head-werewolf-1')!;
    const definition = headlessContent.battle.enemies.find(enemy => enemy.id === spawn.enemyId)!;
    assert.equal(spawn.respawn, false);
    const storyBattle = normalizeBattleCatalog(headlessContent.battle);
    const heroActor = storyBattle.classes.find(c => c.id === h.session.hero!.classId)!.actor;
    world = await createTestWorldCombat({
      hero: h.session.hero!,
      session: h.session,
      map,
      roster,
      battleCatalog: storyBattle,
      phaserScene: fullPhaserScene(),
      playerVisual: {
        entity: { id: 'player', actor: heroActor.id, x: 300, y: 152, flip: false },
        actor: heroActor,
        layers: [],
        container: createFakeContainer(300, 152),
      } as never,
    });
    await world.combat.start();
    t.mock.method(h.session, 'settleEnemyDefeat', () => { throw new Error('settlement failed'); });
    roster.setEnemyHealth(spawn.id, 0, definition);
    world.combat.settleForSnapshot();

    assert.equal(roster.isPresent(spawn.id), false);
    assert.equal(roster.completedEncounters().length, 0);
    assert.equal(h.session.enemyVitals(spawn.id).deadUntil, undefined);
    restored = playthrough(JSON.parse(JSON.stringify(h.session.captureState())));
    assert.ok((restored.session.enemyVitals(spawn.id).health ?? 0) > 0);
    const restoredRoster = await restored.defeat(definition.id);
    await restored.updateWorld(restoredRoster);
    assert.equal(restored.session.status('quest-47'), 'ready');
    assert.equal(restored.session.captureState().receipts.filter(receipt => receipt.quest === 'quest-46').length, 1);
  } finally {
    world?.combat.destroy();
    restored?.director.dispose();
    h.director.dispose();
  }
});
