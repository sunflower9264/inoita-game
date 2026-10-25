import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {Combatant} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {PendingEnemyDefeats} from '../src/domain/combat-outcomes.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const actor=(id:string,x:number,team='enemy'):Combatant=>({id,team,position:{x,y:0},facing:'east',bounds:{x:-8,y:-8,width:16,height:16}});
function fixture(count=1){
  const conditions=new CombatConditions(),order:string[]=[];
  const actors=[actor('player',0,'party'),...Array.from({length:count},(_,i)=>actor(`enemy-${i}`,8+i))];
  const equipment={numbers:{modifiers:[] as {stat:string;value:number}[],gemModifiers:[]}};
  const hero={classId:'dark-knight',level:1,bag:{equipmentFor:()=>({'main-hand':'weapon'}),get:()=>equipment},
    panel:{physicalAttack:101,magicAttack:30},player:{health:1000,maxHealth:1000}};
  const states=new Map(actors.slice(1).map(value=>[value.id,{health:10000,maxHealth:10000,level:1}]));
  const enemies=actors.slice(1).map(value=>({key:value.id,definition:{acceptsBuffs:true},visual:{container:{active:true}}}));
  let current:string|undefined='enemy-0';
  const host=Object.setPrototypeOf({hero,conditions,arena:enemies,app:{battleCatalog:catalog,session:{}},
    pendingDefeats:new PendingEnemyDefeats(),hitResolution:new CombatHitResolution(),
    partyControllers:new Map([['player',{snapshot:()=>({targetId:current}),selectedTargetId:()=>current,
      actionState:()=> 'idle',setReactionTarget:(id:string)=>{current=id;}}]]),
    memberOf:(id:string)=>id==='player'?hero:undefined,partyPassives:()=>[],partyFighter:()=>({}),partyAttackProc:()=>{},
    applyStateConsequences:()=>{},syncCombatResourceLimits:()=>{},
    actorAttributes:()=>({physicalAttack:hero.panel.physicalAttack,magicAttack:hero.panel.magicAttack,physicalDamageRate:0,magicDamageRate:0,
      stealthDamageRate:0,primaryAttributes:primary,maxHealth:1000}),
    combatant:(id:string)=>actors.find(value=>value.id===id),combatants:()=>actors,
    roster:{enemySnapshot:(id:string)=>states.get(id),setEnemyHealth:(id:string,health:number)=>{states.get(id)!.health=health;}},
    threat:{damage:(_source:string,id:string,damage:number)=>order.push(`hate:${id}:${damage}`)},
    showHit:(event:{targetId:string},hit:{damage:number})=>order.push(`damage:${event.targetId}:${hit.damage}`),
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>Reflect.get(WorldCombat.prototype,name).call(host,...args);
  const proc=()=>host.hitResolution.run(()=>call('attackProc',{casterId:'player',targetId:'enemy-0'},{kind:'hit',damage:100},hero));
  const chance=(key:Parameters<CombatConditions['setTemporaryAttribute']>[1],value:number)=>conditions.setTemporaryAttribute('player',key,value);
  return {host,hero,conditions,order,actors,states,equipment,call,proc,chance,select:(id:string|undefined)=>{current=id;}};
}

test('actual temporary skill units cache equipment plus buffs and clear to the latest normal sources',()=>{
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'fire',value:100}];
  f.conditions.applyBuff('player','molten-armor',1,{durationMs:1000,tickMs:0,states:[],periodic:[],
    modifiers:[{attribute:'fireSplashChance',operation:{kind:'add',amount:56}}]});
  const event={casterId:'player',targetId:'player',cueIndex:0,skill:{id:'firestorm',level:1,action:catalog.skills.firestorm.action!}};
  assert.equal(f.call('skillUnit',event),'success');assert.equal(f.call('actorAttribute','player','fireSplashChance'),212);
  f.equipment.numbers.modifiers[0].value=200;
  assert.equal(f.call('actorAttribute','player','fireSplashChance'),212);
  assert.equal(f.call('skillUnit',{...event,cueIndex:2}),'success');
  assert.equal(f.call('actorAttribute','player','fireSplashChance'),256);
});

test('actual poison proc has no immediate damage and uses dynamic source damage on periodic ticks',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.chance('poisonStrikeChance',1000);f.proc();f.proc();f.proc();
  assert.equal(f.states.get('enemy-0')!.health,10000);assert.deepEqual(f.order,[]);
  assert.equal(f.conditions.snapshot('enemy-0')[0].stackCount,3);
  f.hero.panel.physicalAttack=201;
  f.conditions.update(60,tick=>f.call('periodicTick',tick));
  assert.equal(f.states.get('enemy-0')!.health,9916);
  assert.deepEqual(f.order,['hate:enemy-0:84','damage:enemy-0:84']);
});

test('zero direct elemental damage still installs its child, and immunity only rejects direct damage',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.hero.panel.physicalAttack=0;f.chance('frostStrikeChance',1000);f.proc();
  assert.ok(f.conditions.hasBuff('enemy-0','attack-slow'));assert.deepEqual(f.order,[]);
  f.hero.panel.physicalAttack=101;f.conditions.applyState('enemy-0','damage-immune',1000);
  f.chance('darknessStrikeChance',1000);f.proc();
  assert.ok(f.conditions.hasBuff('enemy-0','darkness-strike-impact'));assert.deepEqual(f.order,[]);
  f.host.arena[0].definition.acceptsBuffs=false;f.conditions.removeBuff('enemy-0','attack-slow');f.proc();
  assert.equal(f.conditions.hasBuff('enemy-0','attack-slow'),false);
});

test('fire uses the live selected target, includes the primary and counts immune entries toward its sixteen slots',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture(17);f.chance('fireSplashChance',1000);f.chance('poisonStrikeChance',1000);
  f.conditions.applyState('enemy-0','damage-immune',1000);f.select('enemy-8');f.proc();
  assert.equal(f.states.get('enemy-0')!.health,10000);
  for(let i=1;i<16;i++)assert.equal(f.states.get(`enemy-${i}`)!.health,9950);
  assert.equal(f.states.get('enemy-16')!.health,10000);
  assert.equal(f.conditions.hasBuff('enemy-0','poisoned'),false);
});

test('reachable empty fire splash retries the probability and then continues without hanging',t=>{
  const dice=[0,.999],calls:number[]=[];t.mock.method(Math,'random',()=>{const value=dice.shift();assert.notEqual(value,undefined);calls.push(value!);return value!;});
  const f=fixture();f.actors[1].position.x=32;f.chance('fireSplashChance',56);f.proc();
  assert.deepEqual(calls,[0,.999]);assert.deepEqual(f.order,[]);
});


test('shared feedback rolls occur before the visual availability gate, with periodic impact excluded',t=>{
  let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return .5;});
  const f=fixture();Reflect.set(f.host,'visualOf',()=>undefined);
  const event={casterId:'player',targetId:'enemy-0'},hit={kind:'hit',damage:1};
  f.call('showHit',event,hit,{});assert.equal(rolls,2);
  f.call('showHit',event,hit,{periodic:true});assert.equal(rolls,3);
});

test('equipment and buffs combine before the native probability threshold is clamped',()=>{
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'fire',value:-100}];
  assert.equal(f.call('actorAttribute','player','fireSplashChance'),0);
  const event={casterId:'player',targetId:'player',cueIndex:0,skill:{id:'firestorm',level:1,action:catalog.skills.firestorm.action!}};
  f.call('skillUnit',event);assert.equal(f.call('actorAttribute','player','fireSplashChance'),56);
});


test('cached negative thresholds bypass normal clamping and consecutive writes read that exact value',()=>{
  const f=fixture();f.conditions.setTemporaryAttribute('player','fireSplashChance',-100);
  assert.equal(f.call('actorAttribute','player','fireSplashChance'),-100);
  const event={casterId:'player',targetId:'player',cueIndex:0,skill:{id:'firestorm',level:1,action:catalog.skills.firestorm.action!}};
  f.call('skillUnit',event);assert.equal(f.call('actorAttribute','player','fireSplashChance'),-44);
  f.call('skillUnit',{...event,cueIndex:2});assert.equal(f.call('actorAttribute','player','fireSplashChance'),0);
});
