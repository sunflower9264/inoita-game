import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {EnemyController,type EnemyPort} from '../src/domain/enemy-ai.ts';
import {enemyAwarenessRangeUnits} from '../src/domain/enemy-engagement.ts';
import {CombatThreatSystem,type CombatThreatActor} from '../src/domain/combat-threat-system.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatRuntime} from '../src/domain/combat-runtime.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {Session} from '../src/domain/session.ts';
import {WorldEnemyRoster} from '../src/domain/world-enemies.ts';
import type {Campaign} from '../src/domain/campaign.ts';
import {prepareCombatRestore,type WorldCombatState} from '../src/domain/combat-snapshot.ts';
import {resolveBasicAttack,targetDistance} from '../src/domain/basic-attack.ts';
import {enemySkills,type BattleCatalog} from '../src/domain/battle.ts';
import {NavigationWorld} from '../src/domain/navigation-world.ts';
import type {Facing,WorldMap} from '../src/domain/content.ts';
import type {Point} from '../src/domain/navigation.ts';
import {createCombatTestHarness,createTestEnemy} from './support/combat-test-harness.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const catalog=read('battle') as BattleCatalog;
const cases=[
  {enemyId:'enemy-starving-boss-wolf-1',map:'training-dungeon-two',entry:{x:40,y:448}},
  {enemyId:'enemy-boss-skeleton-1',map:'shadow-training-dungeon-2-a6b8293b',entry:{x:592,y:312}},
];

function fixture(example=cases[0],ordinary=false,fixed=false){
  const map=read(`maps/${example.map}`) as WorldMap;
  const definition=structuredClone(catalog.enemies.find(enemy=>enemy.id===example.enemyId)!);
  if(ordinary)delete definition.behavior.engagement;
  if(fixed){definition.behavior.canMove=false;definition.behavior.canTurn=false;delete definition.behavior.wander;}
  const spawn=map.enemySpawns!.find(value=>value.enemyId===example.enemyId)!;
  const navigation=new NavigationWorld(map);
  const bounds=definition.actor.collision!;
  const boss:CombatThreatActor={id:'boss',team:'hostile',active:true,level:definition.level??5,tracksThreat:true,role:'enemy',
    sightRangeUnits:enemyAwarenessRangeUnits(definition.behavior,navigation.bounds),bounds,
    position:navigation.nearest({collision:bounds},spawn)};
  const bossBody={shape:()=>({collision:boss.bounds}),position:()=>boss.position,enabled:()=>boss.active};
  navigation.register(bossBody);
  const player:CombatThreatActor={id:'player',team:'party',active:true,level:5,tracksThreat:false,role:'player',sightRangeUnits:8,
    bounds:{x:-8,y:-8,width:16,height:16},position:navigation.nearest({collision:{x:-8,y:-8,width:16,height:16}},example.entry)};
  const actors=[player,boss];
  navigation.register({shape:()=>({collision:player.bounds}),position:()=>player.position,enabled:()=>player.active});
  const resources=new Map([['player',100],['boss',100]]);
  let tick=0,paused=false,blocked=false,queries=0,notices=0,clears=0,heading:Facing='south';
  let following:(()=>Point|undefined)|undefined;
  const plays:{targetId?:string;at:number}[]=[],contacts:string[]=[];
  const runtime=new CombatRuntime(()=>tick),cooldowns=new CombatCooldownStore(()=>tick);
  let ai:EnemyController;
  const threat=new CombatThreatSystem({actor:id=>actors.find(actor=>actor.id===id),actors:()=>actors,
    currentTarget:()=>ai?.combatController?.snapshot().targetId,logicTick:()=>tick,
    generationRate:()=>1000,reductionRate:()=>0,normalDamage:()=>({physical:100,magic:0}),tauntSource:()=>undefined,
    applyTaunt(){},combatStarted:()=>ai?.onThreatAdded()});
  const free=(point:Point)=>!blocked&&navigation.canStand(bossBody,point);
  const port:EnemyPort={cooldowns:cooldowns.forActor('boss'),isPaused:()=>paused,
    actor:id=>actors.find(actor=>actor.id===id&&actor.active&&(resources.get(id)??1)>0),
    candidates:()=>actors.filter(actor=>actor.active&&(resources.get(actor.id)??1)>0),
    isAlive:id=>actors.some(actor=>actor.id===id&&actor.active&&(resources.get(id)??1)>0),
    health:id=>({current:resources.get(id)??100,maximum:100}),home:()=>spawn,navigationBounds:()=>navigation.bounds,
    facing:()=>heading,face:value=>{heading=value;},moveToward:()=>assert.fail('Boss movement must use collision-aware paths'),
    followPath:next=>{following=next;},stop:()=>{following=undefined;},
    canStand:point=>{queries++;return free(point);},relocate:()=>assert.fail('Boss must not teleport'),
    play:(action,frame,complete)=>{
      plays.push({targetId:action.target?.id,at:tick});
      return runtime.play(action,{sourceFrames:definition.actor.clips[action.basicAttack!.clips[action.facing]]!.frames,frameDurationMs:60},frame,complete);
    },frame:(action,index,contact)=>{if(action.basicAttack&&index===action.basicAttack.strikeFrame&&action.target)contact(action.target.id);},
    contact:event=>contacts.push(event.targetId),clearEffects:()=>runtime.cancel('boss'),
    threat:{select:current=>threat.select('boss',current),notice:id=>{notices++;threat.notice('boss',id);},
      has:id=>threat.has('boss',id),clear:()=>{clears++;threat.clearOwner('boss');}},
  };
  ai=new EnemyController('boss',definition.behavior,resolveBasicAttack(catalog,{actor:definition.actor,basicAttack:definition.basicAttack!}),port,enemySkills(definition),()=>.99);
  runtime.registerActor('boss',ai.combatController!);
  function step(move=false){
    if(paused){ai.step();return;}
    tick++;
    if(move){const next=following?.();if(next){
      const dx=next.x-boss.position.x,dy=next.y-boss.position.y,length=Math.hypot(dx,dy),amount=Math.min(length,definition.behavior.moveSpeedPxPerSecond*.06);
      if(length)boss.position={x:boss.position.x+dx/length*amount,y:boss.position.y+dy/length*amount};
    }}
    ai.step();runtime.step(tick);
  }
  const ally=()=>{
    const actor:CombatThreatActor={...player,id:'ally',role:'member',position:navigation.nearest({collision:player.bounds},{x:player.position.x+24,y:player.position.y})};
    actors.splice(1,0,actor);resources.set(actor.id,100);
    navigation.register({shape:()=>({collision:actor.bounds}),position:()=>actor.position,enabled:()=>actor.active});
    return actor;
  };
  const summon=()=>{
    const actor:CombatThreatActor={...player,id:'summon',role:'summon',position:navigation.nearest({collision:player.bounds},{x:player.position.x-16,y:player.position.y})};
    actors.splice(1,0,actor);resources.set(actor.id,100);
    navigation.register({shape:()=>({collision:actor.bounds}),position:()=>actor.position,enabled:()=>actor.active});
    return actor;
  };
  return {ai,port,boss,player,actors,definition,navigation,runtime,threat,resources,plays,contacts,step,ally,summon,
    queries:()=>queries,notices:()=>notices,clears:()=>clears,setBlocked:(value:boolean)=>{blocked=value;},setPaused:(value:boolean)=>{paused=value;runtime.setPaused('control',value);},
    tick:()=>tick};
}

for(const example of cases)test(`${example.enemyId}: a generated Boss engages from the map entrance and reaches attack range`,()=>{
  const run=fixture(example);
  assert.ok(targetDistance(run.boss.position,run.player.position)>run.definition.behavior.awarenessRangeUnits*8);
  run.step();assert.equal(run.ai.snapshot().targetId,'player');assert.equal(run.ai.snapshot().state,'chasing');assert.equal(run.notices(),1);
  for(let index=0;index<500&&run.contacts.length===0;index++)run.step(true);
  assert.ok(run.plays.length>0);assert.ok(run.contacts.includes('player'));assert.equal(run.clears(),0);
});

test('the same ordinary enemy outside its own awareness range does not engage',()=>{
  const run=fixture(cases[0],true);run.step();
  assert.equal(run.ai.snapshot().targetId,undefined);assert.equal(run.notices(),0);assert.equal(run.plays.length,0);
});

test('map-wide threat survives repeated distance decay without repeatedly adding initial threat',()=>{
  const run=fixture();run.step();const score=run.threat.captureState();
  for(let index=0;index<100;index++){run.threat.decay();run.step();}
  assert.deepEqual(run.threat.captureState(),score);assert.equal(run.notices(),1);assert.equal(run.clears(),0);
  assert.equal(run.ai.snapshot().state,'chasing');
});

test('a blocked Boss preserves hate and retries pathfinding at most once per 180 milliseconds',()=>{
  const run=fixture();run.setBlocked(true);run.step();
  const first=run.queries();assert.ok(first>0);assert.equal(run.ai.snapshot().state,'idle');
  run.step();run.step();assert.equal(run.queries(),first);run.step();assert.ok(run.queries()>first);
  assert.equal(run.threat.has('boss','player'),true);assert.equal(run.notices(),1);assert.equal(run.clears(),0);
  run.setBlocked(false);
  for(let index=0;index<500&&run.contacts.length===0;index++)run.step(true);
  assert.ok(run.contacts.length>0);assert.equal(run.clears(),0);
});

test('a departed target does not clear another members hate, and the Boss immediately reacquires',()=>{
  const run=fixture(),ally=run.ally();run.step();run.threat.damage(ally.id,'boss',60);
  run.player.active=false;run.resources.set('player',0);run.step();
  assert.equal(run.ai.snapshot().targetId,ally.id);assert.equal(run.threat.has('boss',ally.id),true);assert.equal(run.clears(),0);
});

test('a summon already on the field is the first target before it deals any damage',()=>{
  const run=fixture(),summon=run.summon();run.step();
  assert.equal(run.ai.snapshot().targetId,summon.id);
  assert.equal(run.threat.has('boss','player'),true);
  assert.equal(run.threat.has('boss',summon.id),true);
});

test('a summon arriving mid-fight is raised above the current highest score',()=>{
  const run=fixture(),position={...run.boss.position};
  run.player.position=run.navigation.nearest({collision:run.player.bounds},{x:position.x-24,y:position.y});
  run.step();assert.equal(run.ai.snapshot().targetId,'player');
  const summon=run.summon();
  for(let index=0;index<200&&run.ai.snapshot().targetId!==summon.id;index++)run.step();
  assert.equal(run.ai.snapshot().targetId,summon.id);
  const entries=run.threat.captureState().entries.filter(entry=>entry.ownerId==='boss');
  const playerScore=entries.find(entry=>entry.sourceId==='player')!.score;
  const summonScore=entries.find(entry=>entry.sourceId===summon.id)!.score;
  assert.ok(summonScore>=Math.ceil(playerScore*1.2),'召唤物登场抬到当前最高的 120%');
});

test('when the summon disappears the Boss falls back to the player',()=>{
  const run=fixture(cases[0],false,true),summon=run.summon();run.step();
  assert.equal(run.ai.snapshot().targetId,summon.id);
  run.resources.set(summon.id,0);summon.active=false;run.step();
  assert.equal(run.ai.snapshot().targetId,'player');
});

test('a mercenary keeps the player as default target until its damage outweighs the threshold',()=>{
  const run=fixture(),position={...run.boss.position};
  run.player.position=run.navigation.nearest({collision:run.player.bounds},{x:position.x-24,y:position.y});
  const ally=run.ally();run.step();
  assert.equal(run.ai.snapshot().targetId,'player');
  run.threat.damage(ally.id,'boss',5);
  for(let index=0;index<20;index++)run.step();
  assert.equal(run.ai.snapshot().targetId,'player');
  run.threat.damage(ally.id,'boss',200);
  for(let index=0;index<200&&run.ai.snapshot().targetId!==ally.id;index++)run.step();
  assert.equal(run.ai.snapshot().targetId,ally.id);
});

test('taunt and higher hate select the next target after the complete current attack',()=>{
  const run=fixture(),ally=run.ally();
  const position={...run.boss.position};
  run.player.position=run.navigation.nearest({collision:run.player.bounds},{x:position.x-24,y:position.y});
  ally.position=run.navigation.nearest({collision:ally.bounds},{x:position.x+24,y:position.y});
  run.step();assert.equal(run.plays[0].targetId,'player');
  run.threat.taunt(ally.id,'boss');run.step();
  assert.equal(run.plays.length,1);assert.equal(run.ai.snapshot().targetId,'player');
  for(let index=0;index<100&&run.plays.length<2;index++)run.step();
  assert.equal(run.plays[1].targetId,ally.id);assert.equal(run.notices(),2,'首次接战对玩家和佣兵各 notice 一次');
});

test('map-wide engagement waits for visible living targets and resumes when one reappears',()=>{
  const run=fixture();run.player.states=['stealthed'];run.step();
  assert.equal(run.notices(),0);assert.equal(run.ai.snapshot().state,'idle');
  run.player.states=[];run.step();assert.equal(run.ai.snapshot().targetId,'player');
  run.player.states=['stealthed'];run.step();assert.equal(run.ai.snapshot().targetId,undefined);
  assert.equal(run.clears(),0);run.player.states=[];run.step();assert.equal(run.ai.snapshot().targetId,'player');
  run.player.active=false;run.step();assert.equal(run.ai.snapshot().targetId,undefined);assert.equal(run.ai.snapshot().state,'idle');
});

test('paused loading, story and menu control do not advance Boss decisions or movement',()=>{
  const run=fixture();run.setPaused(true);
  for(let index=0;index<20;index++)run.ai.update(60);
  run.step();assert.equal(run.ai.captureState().clock,0);assert.equal(run.notices(),0);
  run.setPaused(false);run.step();assert.equal(run.ai.snapshot().state,'chasing');
});

test('a fixed Boss acquires a distant target without expanding its attacks or movement',()=>{
  const run=fixture(cases[0],false,true),position={...run.boss.position};run.step();run.step(true);
  assert.equal(run.plays.length,0);assert.deepEqual(run.boss.position,position);assert.equal(run.threat.has('boss','player'),true);
  run.player.position=run.navigation.nearest({collision:run.player.bounds},{x:position.x-24,y:position.y});
  run.step();assert.equal(run.plays.length,1);assert.deepEqual(run.boss.position,position);
});

test('stationary save restoration reacquires a distant party member without retaining a blocked retry deadline',()=>{
  const run=fixture();run.setBlocked(true);run.step();
  const saved:WorldCombatState={roster:{enemies:[{key:'boss',enemyId:run.definition.id,...run.boss.position,health:37,mana:0}],sequence:0,partySize:1},
    conditions:new CombatConditions().captureState(),threat:run.threat.captureState(),summonGroups:[],
    party:[{id:'player',position:run.player.position,facing:'south',combat:{state:'idle',cooldowns:{}}}],
    enemies:[{id:'boss',facing:'south',ai:{kind:'enemy',state:run.ai.captureState()}}]};
  const restored=prepareCombatRestore(saved,catalog,['player']);
  const next=fixture();next.threat.restoreState(restored.threat);
  assert.equal(restored.enemies[0].ai?.kind,'enemy');
  if(restored.enemies[0].ai?.kind!=='enemy')throw new Error('Missing enemy state');
  next.ai.restoreState(restored.enemies[0].ai.state);next.step();
  assert.equal(next.ai.snapshot().targetId,'player');assert.equal(next.ai.snapshot().state,'chasing');
  assert.equal(next.notices(),0,'读档后已存在的账目不再重复 notice');
  assert.equal(restored.roster.enemies[0].health,37);assert.equal(run.ai.captureState().nextPathAt,240);
});

test('the actual world threat adapter uses the same map-wide range as Boss discovery',()=>{
  const run=fixture();
  const enemy=createTestEnemy({key:'boss',definition:run.definition,level:run.boss.level});
  const harness=createCombatTestHarness({
    battleCatalog:catalog,
    enemies:new Map([['boss',enemy]]),
    combatant:id=>id==='boss'?run.boss:undefined,
    settlementOverrides:{navigationBounds:()=>run.navigation.bounds},
  });
  harness.conditions.setTemporaryAttribute('boss','sightBonusUnits',5);
  const threatActor=()=>harness.settlement.threatActor('boss')!;
  assert.equal(threatActor().sightRangeUnits,enemyAwarenessRangeUnits(run.definition.behavior,run.navigation.bounds,5));
  assert.ok(threatActor().sightRangeUnits>targetDistance(run.boss.position,run.player.position)/8);
  delete run.definition.behavior.engagement;
  assert.equal(threatActor().sightRangeUnits,run.definition.behavior.awarenessRangeUnits+5);
});

test('disposing the map Boss cancels its action and prevents late hits',()=>{
  const run=fixture(),position={...run.boss.position};
  run.player.position=run.navigation.nearest({collision:run.player.bounds},{x:position.x-24,y:position.y});
  run.step();assert.equal(run.plays.length,1);run.ai.dispose();
  const before=run.contacts.length;
  for(let index=0;index<100;index++)run.step(true);
  assert.equal(run.contacts.length,before);assert.equal(run.plays.length,1);assert.equal(run.runtime.idle,true);
});

test('map-wide Bosses remain subject to story availability and defeated spawn records',()=>{
  const campaign=read('campaign') as Campaign;
  for(const example of cases){
    const map=read(`maps/${example.map}`) as WorldMap;
    const disabled=new Session(campaign);
    disabled.applyStoryCommands([{type:'world',command:{kind:'enemy-availability',map:map.id,enemyId:example.enemyId,available:false}}]);
    const inactive=new WorldEnemyRoster(disabled,map,[]);
    assert.equal(inactive.enemies.some(enemy=>enemy.enemyId===example.enemyId),false);
    const session=new Session(campaign),active=new WorldEnemyRoster(session,map,[]);
    const boss=active.enemies.find(enemy=>enemy.enemyId===example.enemyId)!;assert.ok(boss);
    session.enemyDefeated(active.source(boss.key)!);active.refresh();
    assert.equal(active.enemies.some(enemy=>enemy.key===boss.key),false);
    assert.equal(new WorldEnemyRoster(session,map,[]).enemies.some(enemy=>enemy.key===boss.key),false);
  }
});
