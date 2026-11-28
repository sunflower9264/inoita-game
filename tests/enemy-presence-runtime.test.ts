import {groundLootFor} from '../src/domain/ground-loot.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Session,DEFAULT_ENEMY_RESPAWN_MS} from '../src/domain/session.ts';
import {WorldEnemyRoster,applyStoryEnemyRemovals,encounterSpawnId} from '../src/domain/world-enemies.ts';
import {QuestEnemyWatch} from '../src/domain/quest-enemies.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {PendingEnemyDefeats} from '../src/domain/combat-outcomes.ts';
import type {Combatant} from '../src/domain/combatant.ts';
import {parseDrops} from '../src/domain/drops.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {Campaign} from '../src/domain/campaign.ts';
import type {WorldMap} from '../src/domain/content.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import {createCombatTestHarness} from './support/combat-test-harness.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const campaign=read<Campaign>('campaign'),battle=read<BattleCatalog>('battle');
const items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
const drops=parseDrops(read('drops'),items,battle.enemies.map(enemy=>enemy.id));
const map=read<WorldMap>('maps/piolren-meadows-7-4c61d9fe');
const turtleId='enemy-meadow-turtle-1';
const makeSession=(content=campaign)=>{
  const hero=new BattleCharacter('warrior',stats,items);
  hero.restoreState({...hero.captureState(),level:52});
  return new Session(content,undefined,undefined,items,hero,battle,stats);
};
function clearByStory(session:Session,next:WorldMap,enemyId:string){
  session.applyStoryCommands([{type:'world',command:{kind:'remove-enemy',enemyId,map:next.id,all:true}}]);
  const previous=new WorldEnemyRoster(session,next,[]);
  applyStoryEnemyRemovals(session,next.id,previous.enemies,key=>previous.removeEnemy(key));
}
function restoredTurtles(){
  const original=makeSession();clearByStory(original,map,turtleId);
  assert.equal(original.accept('quest-357'),true);
  // 玩家旧档保留剧情移除和进行中的任务，读回后由当前规则重新决定在场状态。
  const session=makeSession();session.restoreState(JSON.parse(JSON.stringify(original.captureState())));
  const roster=new WorldEnemyRoster(session,map,[],new QuestEnemyWatch(session,drops.questItems));
  return {session,roster};
}
function combat(session:Session,roster:WorldEnemyRoster,enemyId=turtleId,next=map,key?:string){
  const placed=roster.enemies.find(enemy=>enemy.enemyId===enemyId&&(key===undefined||enemy.key===key))!;
  assert.ok(placed);
  const definition=battle.enemies.find(enemy=>enemy.id===enemyId)!;
  const enemy={key:placed.key,definition};
  let arena=[enemy];
  const pendingDefeats=new PendingEnemyDefeats();
  const hitResolution=new CombatHitResolution();
  const conditions=new CombatConditions();
  const director:{healthChanged?:(id:string,before:number,after:number,max:number,source:{id:string;map:string;x:number;y:number})=>boolean}={};
  const lootStart=groundLootFor(session).dropsOnMap(next.id).length;
  const loot=()=>groundLootFor(session).dropsOnMap(next.id).slice(lootStart).map(drop=>drop.reward);
  const fighter={level:52,physicalAttack:400,magicAttack:400,hitBase:10000,hitBonus:1000,
    evasionBase:100,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:1000,
    criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
  const combatants=():Combatant[]=>[
    {id:'player',team:'party',position:{x:placed.x,y:placed.y},bounds:definition.actor.collision!,states:conditions.activeStates('player'),facing:'east'},
    ...arena
      .filter(entry=>roster.isPresent(entry.key,entry.definition.id)&&!pendingDefeats.has(entry.key)&&!hitResolution.isAwaitingDefeat(entry.key)&&!roster.hasZeroHealth(entry.key))
      .map(entry=>({id:entry.key,team:'hostile' as const,position:{x:placed.x,y:placed.y},bounds:entry.definition.actor.collision!,states:conditions.activeStates(entry.key),facing:'south' as const})),
  ];
  const removeEnemy=(id:string)=>{
    roster.removeEnemy(id);
    arena=arena.filter(entry=>entry.key!==id);
  };
  const harness=createCombatTestHarness({
    battleCatalog:battle,characterStats:stats,items,hero:session.hero,
    members:new Map([['player',session.hero!]]),
    conditions,hitResolution,
    sessionSkills:()=>session.skills,
    activeParty:()=>['player'],
    combatants,
    combatant:id=>combatants().find(actor=>actor.id===id),
    withThreat:false,
    statsOverrides:{
      enemyOf:id=>arena.find(entry=>entry.key===id),
      enemySnapshot:(id,def,lvl)=>roster.enemySnapshot(id,def,lvl),
      isEnemyPresent:(id,enemyDefId)=>roster.isPresent(id,enemyDefId),
      isPendingDefeat:id=>pendingDefeats.has(id),
    },
    settlementOverrides:{
      enemyOf:id=>arena.find(entry=>entry.key===id),
      allEnemies:()=>arena,
      enemySnapshot:(id,def,lvl)=>roster.enemySnapshot(id,def,lvl),
      setEnemyHealth:(id,health,def)=>roster.setEnemyHealth(id,health,def),
      setEnemyMana:(id,mana,def)=>roster.setEnemyMana(id,mana,def),
      isEnemyPresent:(id,enemyDefId)=>roster.isPresent(id,enemyDefId),
      isPendingDefeat:id=>pendingDefeats.has(id),
      removeEnemy,
      onEnemyDamaged:(targetEnemy,before,proposed)=>{
        const interrupted=director.healthChanged?.(targetEnemy.definition.id,before.health,proposed,before.maxHealth,{
          id:targetEnemy.key,map:next.id,x:placed.x,y:placed.y,
        })??false;
        return {interrupted:!!interrupted,captured:!!interrupted&&!!session.enemyVitals(targetEnemy.key).capture};
      },
      onEnemyZeroHealth:(targetEnemy,before,casterId)=>{
        let result:ReturnType<Session['settleEnemyDefeat']>|undefined;
        pendingDefeats.add(targetEnemy.key,()=>{
          result=session.settleEnemyDefeat({
            key:targetEnemy.key,spawn:roster.source(targetEnemy.key),enemy:targetEnemy.definition,
            map:next.id,x:placed.x,y:placed.y,enemyLevel:before.level,elite:before.elite,
            earnsExperience:casterId==='player',pressureMode:false,drops,stats,
            random:Math.random,landing:(lx,ly)=>({x:lx,y:ly}),
          });
        },()=>{
          result?.notify();
          removeEnemy(targetEnemy.key);
        });
      },
      onShowHit:undefined,
      onDropMana:undefined,
    },
  });
  harness.stats.partyFighter=()=>fighter;
  harness.stats.actorAttributes=()=>({...fighter,maxHealth:10000,physicalDamageRate:0,magicDamageRate:0,stealthDamageRate:0,zealotRate:0,primaryAttributes:session.hero!.panel.attributes});
  harness.stats.actorAttribute=(_id,key)=>key==='physicalAttack'||key==='magicAttack'?400:0;
  harness.settlement.resolveHitReactions=()=>{};
  const event={casterId:'player',targetId:enemy.key};
  const health=()=>roster.enemySnapshot(enemy.key,definition,52)?.health;
  const strike=(damage:number)=>hitResolution.run(()=>harness.settlement.settleHit(event,{kind:'hit',damage},enemy));
  const skill=battle.skills['dark-strike'];
  const skillEvent={...event,skill:{...skill,level:1,action:skill.action!},cueIndex:skill.action!.combatUnits!.findIndex(unit=>unit.effect==='physical')};
  return {harness,pendingDefeats,combatants,director,enemy,health,strike,loot,event,skillEvent};
}

test('story-removed quest turtles can be selected, hit by basics and skills, and killed once with their task drop',t=>{
  t.mock.method(Math,'random',()=>0.5);
  const {session,roster}=restoredTurtles();
  const {harness,pendingDefeats,combatants,enemy,health,strike,loot,event,skillEvent}=combat(session,roster);
  assert.equal(session.storyWorld.visible(enemy.key),false);
  assert.equal(session.canRespawnEnemy(roster.source(enemy.key)!),true,'死亡刷新资格与剧情原始显隐分开');
  assert.equal(roster.isPresent(enemy.key),true);
  assert.equal(harness.settlement.isActorPresent(enemy.key),true);
  assert.ok(combatants().some(actor=>actor.id===enemy.key));
  const before=health()!;
  const basicDefinition=Object.values(battle.basicAttacks)[0]!;
  const basicAttack={...basicDefinition,profileId:Object.keys(battle.basicAttacks)[0]!,step:0,stepCount:1,effectiveCycleFrames:basicDefinition.cycleFrames,clips:battle.classes[0]!.basicAttack!.clips,sequence:{north:[],south:[],east:[],west:[]}};
  harness.settlement.attackContact({...event,basicAttack});
  assert.ok(health()!<before,'普通攻击实际扣血');
  const afterBasic=health()!;
  assert.equal(harness.settlement.skillUnit(skillEvent),'success');
  assert.ok(health()!<afterBasic,'技能实际扣血');
  strike(100000);strike(100000);
  assert.equal(pendingDefeats.keys().length,1,'多段致死伤害只开一张死亡单');
  // 固定掉落骰子，走正式死亡与奖励结算。
  t.mock.method(Math,'random',()=>0);
  pendingDefeats.complete(enemy.key,false);
  const shells=loot().filter(reward=>reward.kind==='item'&&reward.item==='meadow-turtle-s-shell');
  assert.equal(shells.length,1,'正式奖励结算产出任务龟壳');
  assert.equal(session.questBook.factSequence('combat'),1);
  assert.equal(roster.isPresent(enemy.key),false);
  pendingDefeats.complete(enemy.key,false);
  assert.equal(loot().filter(reward=>reward.kind==='item'&&reward.item==='meadow-turtle-s-shell').length,1);
  roster.refresh();assert.equal(roster.isPresent(enemy.key),false,'死亡计时到期前保持退场');
  session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS);roster.refresh();
  assert.equal(roster.isPresent(enemy.key),true,'刷新入口重新生成任务怪');
});

test('quest completion invalidates same-frame candidates and delayed hits while repeat acceptance restores presence',()=>{
  const {session,roster}=restoredTurtles();
  const {harness,combatants,enemy,health,strike,skillEvent}=combat(session,roster);
  const before=health();
  assert.ok(combatants().some(actor=>actor.id===enemy.key));
  session.bag.add('meadow-turtle-s-shell',3);session.bag.add('canyon-bear-s-gallbladder',3);session.refresh();
  assert.equal(session.status('quest-357'),'ready');
  assert.equal(roster.isPresent(enemy.key),false);
  assert.equal(combatants().some(actor=>actor.id===enemy.key),false);
  strike(100);assert.equal(health(),before,'还未清理画面时，迟到伤害也不再结算');
  assert.equal(harness.settlement.skillUnit(skillEvent),'skipped');
  roster.refresh();assert.equal(roster.enemy(enemy.key),undefined);
  session.complete('quest-357');assert.equal(session.accept('quest-357'),true);roster.refresh();
  assert.equal(roster.isPresent(enemy.key),true);
  assert.equal(session.storyWorld.visible(enemy.key),false,'任务没有改写剧情原始状态');
  session.enterMap('other-map');
  const returning=new WorldEnemyRoster(session,map,[],new QuestEnemyWatch(session,drops.questItems));
  assert.equal(returning.isPresent(enemy.key),true,'换图回来仍按有效任务生成');
});

test('quest-restored enemies accelerated outside view can be hit and settle each new life exactly once',t=>{
  t.mock.method(Math,'random',()=>0);
  const {session,roster}=restoredTurtles();
  const first=combat(session,roster),key=first.enemy.key;
  first.strike(100000);first.pendingDefeats.complete(key,false);roster.refresh();
  session.advanceGameTime(20_000);
  assert.ok(roster.refresh({x:-10000,y:-10000,width:100,height:100}).added.some(enemy=>enemy.key===key));
  const second=combat(session,roster,turtleId,map,key),before=second.health()!;
  second.strike(100);assert.equal(second.health(),before-100);
  second.strike(100000);second.strike(100000);
  second.pendingDefeats.complete(key,false);second.pendingDefeats.complete(key,false);
  assert.equal(second.loot().filter(reward=>reward.kind==='item'&&reward.item==='meadow-turtle-s-shell').length,1);
  assert.equal(session.questBook.factSequence('combat'),2);
});

test('presence queries leave expired deaths intact until the roster refresh consumes them',()=>{
  const {session,roster}=restoredTurtles(),key=roster.enemies.find(enemy=>enemy.enemyId===turtleId)!.key;
  const spawn=roster.source(key)!;
  session.enemyDefeated(spawn,1);session.advanceGameTime(1);
  const before=session.captureState();
  assert.equal(roster.isPresent(key),false);
  assert.equal(roster.isPresent(key),false);
  assert.deepEqual(session.captureState(),before);
  roster.refresh();assert.equal(roster.isPresent(key),true);
  assert.equal(session.enemyVitals(key).deadUntil,undefined);
  const ordinary={id:'ordinary',enemyId:turtleId,x:0,y:0};
  session.enemyDefeated(ordinary,1);session.advanceGameTime(1);
  const expired=session.captureState();
  assert.equal(session.canRespawnEnemy(ordinary),true);
  assert.deepEqual(session.captureState(),expired,'死亡刷新资格查询同样保持只读');
});

test('presence queries use only already chosen breakable identities and do not prepare new random spawns',()=>{
  const session=makeSession();
  const next={id:'random-presence',breakableSpawn:'jar',enemySpawns:[
    {id:'first',enemyId:turtleId,x:32,y:32,breakableEligible:true},
    {id:'later',enemyId:turtleId,x:64,y:32,breakableEligible:true},
  ]} as unknown as WorldMap;
  session.storyWorld.apply({kind:'hide',id:'later'});
  let rolls=0;
  const roster=new WorldEnemyRoster(session,next,[],undefined,()=>{rolls++;return 0;});
  const firstIdentity=roster.enemy('first')!.enemyId,baseline=rolls;
  session.storyWorld.apply({kind:'show',id:'later'});
  const before=session.captureState();
  assert.equal(roster.isPresent('first',firstIdentity),true);
  assert.equal(roster.isPresent('later'),false);
  assert.equal(rolls,baseline,'读取资格不抽取新槽位的随机替换');
  assert.deepEqual(session.captureState(),before);
  roster.refresh();assert.ok(rolls>baseline,'实际刷新时才准备新槽位');
});

test('an explicit story encounter remains removed even when an active quest needs the same enemy',()=>{
  const {session}=restoredTurtles();
  session.storyWorld.apply({kind:'encounter',encounter:{id:'turtles',map:map.id,status:'active',spawns:[{id:'one',enemyId:turtleId,x:32,y:32}]}});
  const roster=new WorldEnemyRoster(session,map,[],new QuestEnemyWatch(session,drops.questItems));
  const key=encounterSpawnId('turtles','one');
  assert.equal(roster.isPresent(key),true);
  session.removeStoryEnemy(key);
  assert.equal(roster.isPresent(key),false);
  roster.refresh();assert.equal(roster.enemy(key),undefined);
});

test('an encounter result immediately excludes its old instance and blocks late damage before projection catches up',()=>{
  const {session}=restoredTurtles();
  session.storyWorld.apply({kind:'encounter',encounter:{id:'finished-turtles',map:map.id,status:'active',spawns:[{id:'one',enemyId:turtleId,x:32,y:32}]}});
  const roster=new WorldEnemyRoster(session,map,[],new QuestEnemyWatch(session,drops.questItems));
  const key=encounterSpawnId('finished-turtles','one');
  const definition=battle.enemies.find(enemy=>enemy.id===turtleId)!;
  const {harness}=combat(session,roster);
  const before=roster.enemySnapshot(key,definition,52)!.health;
  const target={key,definition};
  assert.equal(roster.isPresent(key),true);
  session.storyWorld.apply({kind:'encounter-result',id:'finished-turtles',result:'won'});
  assert.equal(roster.isPresent(key),false,'遭遇结束后原来源已不在当前生成投影');
  assert.equal(harness.settlement.isActorPresent(key),false);
  harness.settlement.settleHit({casterId:'player',targetId:key},{kind:'hit',damage:100},target);
  assert.equal(roster.enemySnapshot(key,definition,52)!.health,before);
});

test('a quest-restored capture target converts once without rechecking raw story visibility',()=>{
  const captureQuest=campaign.quests.find(quest=>quest.id==='quest-248')!;
  const content={...campaign,quests:[captureQuest],questGroups:[],events:[]};
  const session=makeSession(content),next=read<WorldMap>('maps/eternal-winter-swamps-40e6e0d1');
  const enemyId='enemy-jagged-teeth-rats-1';
  session.applyStoryCommands([{type:'travel',destination:{map:next.id,x:32,y:32,facing:'south'}}]);
  clearByStory(session,next,enemyId);session.accept(captureQuest.id);
  const roster=new WorldEnemyRoster(session,next,[],new QuestEnemyWatch(session,drops.questItems));
  const {harness,pendingDefeats,director,enemy,strike,skillEvent}=combat(session,roster,enemyId,next);
  director.healthChanged=(id:string,_before:number,_after:number,_max:number,source:{id:string;map:string;x:number;y:number})=>session.weakenQuestTarget(id,source);
  strike(100000);strike(100000);
  assert.ok(session.enemyVitals(enemy.key).capture);
  assert.equal(roster.isPresent(enemy.key),false);
  assert.equal(session.storyWorld.projectEntities(next.id,[]).filter(entity=>entity.id==='quest-target:'+enemy.key).length,1);
  assert.equal(pendingDefeats.keys().length,0,'捕捉不进入死亡奖励流程');
  assert.equal(harness.settlement.skillUnit(skillEvent),'skipped');
  roster.refresh();assert.equal(roster.enemy(enemy.key),undefined);
});
