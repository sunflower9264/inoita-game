import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {ActionDispatchDefinition,BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {CombatController,type Combatant,type CombatPort,type SkillUnitHit} from '../src/domain/combat.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=catalog.skills['swirling-storm'],action=skill.action!;
const enemyDefinition=catalog.enemies.find(enemy=>enemy.acceptsBuffs!==false)!;
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
const actor=(id:string,x=16,y=0,team='enemy'):Combatant=>({id,team,position:{x,y},bounds:{x:-4,y:-4,width:8,height:8}});
const base={level:10,physicalAttack:101,magicAttack:203,baseDefense:0,defense:0,defenseRate:0,
  physicalResistance:0,physicalResistanceBonus:0,magicResistance:0,baseMagicResistance:0,
  maxHealth:10000,maxMana:100,hitBase:100,hitBonus:0,evasionBase:0,evasionBonus:0,
  criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,
  attributes:{strength:11,dexterity:17,vitality:0,intelligence:0,mentality:0}};

function fixture(targets:Combatant[]=[]){
  const caster=actor('player',0,0,'party'),actors=new Map([caster,...targets].map(value=>[value.id,value]));
  const conditions=new CombatConditions(),resolution=new CombatHitResolution(),fallen=new Set<string>();
  const stats=new Map(targets.map(value=>[value.id,{...base,health:10000,mana:100}]));
  const order:string[]=[],attempts:SkillUnitHit[]=[],hits:{event:SkillUnitHit;hit:PhysicalHit}[]=[];
  const member={classId:'warrior',level:10,panel:structuredClone(base),
    skills:{draft:()=>({levels:{}})},bag:{revision:0,equipmentFor:()=>({}),equipmentItems:()=>({}),get:()=>undefined},
    player:{health:10000,maxHealth:10000,mana:100,maxMana:100},
    setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number){this.player[key]=value;},
    setHealth(value:number){this.player.health=Math.max(0,Math.min(this.player.maxHealth,value));}};
  const visuals=new Map([...actors].map(([id,value])=>[id,{container:{active:true,...value.position},
    layers:[{setAlpha:()=>{}}]}]));
  let afterHit:(event:SkillUnitHit,hit:PhysicalHit)=>void=()=>{};
  const host=Object.setPrototypeOf({hero:member,conditions,hitResolution:resolution,fallen,pendingDefeats:new Set<string>(),
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),drops:{enemies:{},questItems:{}},
    arena:targets.filter(value=>value.team==='enemy').map(value=>({key:value.id,definition:enemyDefinition})),
    app:{battleCatalog:catalog,session:{combatTick:0,party:{controlledId:'player'},isOneHitKill:()=>false,questDropRequirements:()=>[]},
      audio:{effect:(name:string)=>order.push(`sound:${name}`)}},
    scene:{events:{emit:()=>{}}},memberOf:(id:string)=>id==='player'?member:undefined,partyPassives:()=>[],
    combatant:(id:string)=>{const value=actors.get(id);return value&&!fallen.has(id)?{...value,states:conditions.activeStates(id)}:undefined;},
    visualOf:(id:string)=>visuals.get(id),
    roster:{isPresent:()=>true,enemySnapshot:(id:string)=>stats.get(id),setEnemyHealth:(id:string,value:number)=>{stats.get(id)!.health=value;}},
    resolveHitReactions:()=>{},dropMana:()=>{},syncCombatResourceLimits:()=>{},applyStateConsequences:()=>{},
    showHit:(event:SkillUnitHit,hit:PhysicalHit)=>{hits.push({event,hit});order.push(`hit:${event.targetId}:${hit.kind}:${hit.damage}`);afterHit(event,hit);},
    feedback:{startShake:()=>order.push('shake')},
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  host.applyActorBuff=(...args:unknown[])=>{const accepted=call('applyActorBuff',...args);if(accepted)order.push(`buff:${args[0]}`);return accepted;};
  const presenter=Object.setPrototypeOf({pose:()=>{},visual:(id:string)=>visuals.get(id),
    candidates:()=>[...actors.keys()].flatMap(id=>{const value=host.combatant(id);return value?[value]:[];}),
    placedEffect:(effect:string,variant:string)=>order.push(`effect:${effect}:${variant}`),scene:host.scene,
  },CombatPresenter.prototype);
  let frame=(_index:number)=>{},spent=0,moves=0;
  const cooldowns=new CombatCooldownStore(()=>0).forActor('player');
  const port:CombatPort={cooldowns,actor:id=>host.combatant(id),candidates:()=>presenter.candidates(),facing:()=> 'east',
    moveToward:()=>{moves++;},stop:()=>{},canStand:()=>true,relocate:()=>{moves++;},clearEffects:()=>{order.push('clear:player');},
    canSpendMana:cost=>member.player.mana>=cost,spendMana:cost=>{spent+=cost;member.player.mana-=cost;return true;},
    play:(_playback,onFrame)=>{frame=onFrame;return ()=>{};},
    frame:(playback,index,contact,ready,area)=>call('presentActionFrame',presenter,playback,index,contact,ready,undefined,
      (definition:ActionDispatchDefinition,work:()=>void,after?:()=>void)=>call('runActionDispatch',playback,definition,work,after),area),
    prepareUnit:event=>call('prepareSkillUnit',event),runUnitSequence:work=>resolution.run(work),
    unit:hit=>{attempts.push(hit);return call('skillUnit',hit);},
    unitFeedback:(hit,outcome,cue)=>presenter.showUnitFeedback(hit,outcome,cue),
  };
  const combat=new CombatController('player',null,port);
  return {caster,actors,conditions,resolution,fallen,stats,order,attempts,hits,member,host,call,combat,
    start:(targetId?:string)=>combat.requestManualSkill({id:skill.id,action,level:1,manaCost:60},targetId),
    frame:(index:number)=>frame(index),counts:()=>({spent,moves}),afterHit:(callback:typeof afterHit)=>{afterHit=callback;}};
}

test('startup needs an enemy but a started storm dispatches all five empty pulses after target loss with one charge',()=>{
  const empty=fixture();assert.equal(empty.start(),'no-target');
  assert.deepEqual(empty.counts(),{spent:0,moves:0});assert.deepEqual(empty.combat.snapshot().cooldowns,{});
  const f=fixture([actor('enemy')]);assert.equal(f.start(),'started');
  assert.equal(f.member.player.mana,40);assert.deepEqual(f.counts(),{spent:60,moves:0});
  assert.deepEqual(f.combat.snapshot().cooldowns[skill.id],{remainingMs:5400,durationMs:5400});
  assert.deepEqual(f.order,['effect:swirl-ring:default']);
  f.actors.delete('enemy');f.combat.targetRemoved('enemy');f.frame(15);f.frame(15);
  assert.deepEqual(f.attempts,[]);
  assert.deepEqual(f.order,['effect:swirl-ring:default',...Array.from({length:5},()=>['shake','sound:Wa_Wheel_Wind']).flat()]);
  assert.equal(f.combat.snapshot().state,'attacking','frame 15 is the last pulse, not the animation end');
  assert.deepEqual(f.counts(),{spent:60,moves:0});
});

test('the real storm area uses integer grid range nine with axis 79/80 and diagonal 57/58 boundaries',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const f=fixture([actor('anchor'),actor('axis-in',79),actor('axis-out',80),actor('diagonal-in',57,57),
    actor('diagonal-out',58,58),actor('ally',16,0,'party'),actor('hidden')]);
  f.conditions.applyState('hidden','stealthed',10000);
  assert.equal(f.start('anchor'),'started');f.frame(3);
  assert.deepEqual(f.hits.map(value=>value.event.targetId),['anchor','axis-in','diagonal-in']);
  assert.deepEqual(f.hits.map(value=>value.hit.damage),[69,69,69]);
  for(const id of ['axis-out','diagonal-out','ally','hidden'])assert.equal(f.stats.get(id)!.health,10000,id);
});

test('each pulse rebuilds its sixteen-slot target group while damage immunity continues to consume a slot',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const targets=Array.from({length:18},(_,index)=>actor(`enemy-${index}`)),f=fixture(targets);
  f.conditions.applyState('enemy-0','damage-immune',10000);
  assert.equal(f.start('enemy-1'),'started');f.frame(3);
  assert.deepEqual(f.attempts.map(hit=>hit.targetId),targets.slice(0,16).map(value=>value.id));
  assert.equal(f.hits[0].hit.damage,0);assert.equal(f.stats.get('enemy-16')!.health,10000);
  f.actors.delete('enemy-1');f.conditions.applyState('enemy-2','stealthed',10000);f.frame(6);
  assert.deepEqual(f.attempts.slice(16).map(hit=>hit.targetId),['enemy-0',...targets.slice(3).map(value=>value.id)]);
  assert.equal(f.hits[16].hit.damage,0);assert.equal(f.stats.get('enemy-16')!.health,9931);assert.equal(f.stats.get('enemy-17')!.health,9931);
});

test('a pulse fixes its primary contribution and target list but reads source attack live, then the next pulse uses the new center and stats',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const f=fixture([actor('first'),actor('second'),actor('next-center',516)]);
  f.afterHit(event=>{if(event.targetId==='first'){
    f.conditions.setTemporaryAttribute('player','physicalAttack',201);f.member.panel.attributes.strength=111;
    f.caster.position={x:500,y:0};f.actors.get('second')!.position.x=1000;
    f.conditions.applyState('second','stealthed',10000);
  }});
  assert.equal(f.start('first'),'started');f.frame(3);
  assert.deepEqual(f.hits.map(value=>[value.event.targetId,value.hit.damage]),[['first',69],['second',122]]);
  f.frame(6);
  assert.deepEqual(f.hits.map(value=>[value.event.targetId,value.hit.damage]),[['first',69],['second',122],['next-center',175]]);
});

test('failed pulses do not poison later Direct calls and the skill damage bonus is consumed by the first non-miss',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const f=fixture([actor('enemy')]),target=f.stats.get('enemy')!;
  // Controlled skill-bonus probe; this does not add Dark Strike to a warrior's learned skills.
  const bonus=catalog.skills['dark-strike'].action!.combatUnits!.find(unit=>unit.effect==='buff')!;assert.equal(bonus.effect,'buff');
  f.call('applyActorBuff','player',bonus.buff,bonus.ranks[0].strength,bonus.ranks[0].effect,'bonus-probe');
  target.evasionBonus=750;assert.equal(f.start('enemy'),'started');f.frame(3);
  assert.equal(f.conditions.hasBuff('player','dark-strike'),true);
  target.evasionBonus=0;f.frame(6);assert.equal(f.conditions.hasBuff('player','dark-strike'),false);
  target.physicalResistanceBonus=1000;f.frame(9);target.physicalResistanceBonus=0;f.frame(15);
  assert.deepEqual(f.hits.map(value=>value.hit),[{kind:'miss',damage:0},{kind:'hit',damage:83},{kind:'hit',damage:0},{kind:'hit',damage:69},{kind:'hit',damage:69}]);
  assert.equal(f.order.filter(value=>value==='sound:Wa_Wheel_Wind').length,5);
  assert.deepEqual(f.attempts.map(value=>value.cueIndex),[0,0,0,0,0]);
});

test('a reflected zero-HP caster completes the current pulse and its feedback before death cancels the remaining pulses',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const f=fixture([actor('first'),actor('second')]);f.member.player.health=30;
  // State-only probe tests dispatch timing, independently of stealth damage modifiers.
  f.conditions.applyState('player','stealthed',10000);
  f.host.resolveHitReactions=(event:SkillUnitHit)=>{if(event.targetId==='first'){
    f.call('settleHit',{casterId:'first',targetId:'player'},{kind:'hit',damage:30},f.member);
    assert.equal(f.resolution.isAwaitingDefeat('player'),true);
  }};
  f.host.memberDefeated=(id:string)=>{f.order.push(`defeat:${id}`);f.fallen.add(id);f.combat.cancel(true);};
  f.host.react=()=>{};
  const remove=f.conditions.removeState.bind(f.conditions);
  f.conditions.removeState=(id,key)=>{if(id==='player'&&key==='stealthed')f.order.push('break-stealth');return remove(id,key);};
  assert.equal(f.start('first'),'started');f.frame(3);
  assert.deepEqual(f.order,['effect:swirl-ring:default','hit:player:hit:30','hit:first:hit:69','hit:second:hit:69',
    'shake','break-stealth','sound:Wa_Wheel_Wind','defeat:player','clear:player']);
  const before=[...f.order];f.frame(15);assert.deepEqual(f.order,before);
  assert.equal(f.attempts.length,2);assert.equal(f.combat.snapshot().state,'idle');
});
