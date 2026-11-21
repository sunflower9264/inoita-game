import {dispatchFrame} from './support/combat-driver.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatController,type Combatant,type CombatPort,type SkillUnitHit} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {passiveModifiers,type PassiveModifier} from '../src/domain/passive-skills.ts';
import {calculateEffectiveDefense,type PhysicalFighter} from '../src/domain/physical-hit.ts';
import type {PartyBuffSlot} from '../src/domain/party-buff-targets.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const action=catalog.skills['guardian-of-darkness'].action!;
const unit=action.combatUnits![0];
assert.equal(unit.effect,'buff');if(unit.effect!=='buff')throw new Error('Guardian must apply a buff');
const ranks=unit.ranks;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

function fixture(){
  const conditions=new CombatConditions(),hitResolution=new CombatHitResolution();
  const collision={x:-4,y:-4,width:8,height:8};
  const panel={baseDefense:100,defenseRate:500,physicalAttack:100,magicAttack:0,maxHealth:100,
    hitBase:100,hitBonus:0,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,
    criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
  const members=new Map(['player','caster','third'].map(id=>[id,{level:10,player:{health:100},panel,
    bag:{revision:0,equipmentFor:()=>({}),get:()=>undefined},clearCombatResourceLimits:()=>{}}]));
  const visuals=new Map(['player','caster','third','summon'].map(id=>[id,{
    container:{active:true,x:0,y:0,setVisible:()=>{}},actor:{collision,clips:{}},layers:[],
  }]));
  const party={activeIds:['player','caster','third'],get:(id:string)=>members.get(id)};
  const order:string[]=[],attempts:SkillUnitHit[]=[];let passives:PassiveModifier[]=[];
  const host=Object.setPrototypeOf({app:{session:{party,combatTick:0}},hero:members.get('player'),conditions,hitResolution,
    roster:{presenceRevision:0,isPresent:()=>true},
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    scene:{facing:'east',tweens:{add:()=>({})}},pendingDefeats:new Set(),fallen:new Set(),
    partyControllers:new Map(),deathTweens:new Map(),
    allies:[{id:'caster',facing:'east',ai:{disable:()=>{}}},{id:'third',facing:'east',ai:{disable:()=>{}}}],
    arena:[{key:'summon',definition:{id:'summon'},summonedBy:'player',facing:'east'}],
    visualOf:(id:string)=>visuals.get(id),partyPassives:()=>passives,
    movement:{position:(visual:{container:{x:number;y:number}})=>({x:visual.container.x,y:visual.container.y}),
      actor:()=>({shape:()=>({collision})}),stop:()=>{},setEnabled:()=>{}},
    syncCombatResourceLimits:()=>{},applyStateConsequences:()=>{},
    showBuffApplication:()=>assert.fail('Guardian has no per-recipient application visual'),
  },WorldCombat.prototype);
  const actor=(id:string)=>method('combatant').call(host,id) as Combatant|undefined;
  const candidates=()=>method('combatants').call(host) as Combatant[];
  const slots=()=>method('partyBuffSlots').call(host) as readonly (PartyBuffSlot<Combatant>|undefined)[];
  const presenter=Object.setPrototypeOf({pose:()=>{},candidates,visual:(id:string)=>visuals.get(id),
    visualEffect:(effect:{effect:string},_variant:string,target:Combatant)=>order.push(`fx:${effect.effect}:${target.id}`),
  },CombatPresenter.prototype) as InstanceType<typeof CombatPresenter>;
  const begin=(level=1,casterId='caster')=>{
    let frame:(index:number)=>void=()=>{};
    const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor(casterId),actor,candidates,partySlots:slots,facing:()=> 'east',moveToward:()=>{},stop:()=>{},
      canStand:()=>true,relocate:()=>{},clearEffects:()=>{},
      play:(_action,onFrame)=>{frame=onFrame;return ()=>{};},
      frame:(current,index,contact,ready)=>dispatchFrame(presenter,current,index,contact,ready),
      unit:hit=>{attempts.push(hit);order.push(`buff:${hit.targetId}`);return method('skillUnit').call(host,hit);},
      runUnitSequence:work=>hitResolution.run(work),
      unitFeedback:(hit,outcome,cue)=>presenter.showUnitFeedback(hit,outcome,cue),
      contact:()=>assert.fail('Party buffs cannot create an enemy contact'),
    };
    const controller=new CombatController(casterId,null,port);
    assert.equal(controller.request({id:'guardian-of-darkness',action,level}),'started');
    return {frame:(index:number)=>frame(index),controller};
  };
  return {host,members,visuals,party,conditions,hitResolution,order,attempts,actor,candidates,slots,begin,
    cast:(level=1,casterId='caster')=>begin(level,casterId).frame(7),
    fighter:(id='player')=>method('partyFighter').call(host,id) as PhysicalFighter,
    setPassives:(value:PassiveModifier[])=>passives=value};
}

test('guardian applies all eight researched ranks immediately and expires after the last active age',()=>{
  const defense=[650,750,850,1000,1050,1100,1150,1200],block=[130,150,170,200,210,220,230,240];
  const ages=[60,75,90,105,120,120,135,135];
  for(let rank=1;rank<=8;rank++){
    const f=fixture();f.cast(rank);
    assert.deepEqual(ranks[rank-1].effect.simulationFrames,{lastActiveFrame:ages[rank-1]});
    assert.equal(ranks[rank-1].effect.durationMs,(ages[rank-1]+1)*60);
    assert.equal(ranks[rank-1].effect.maxStacks,1);
    assert.equal(f.conditions.attribute('player','defense',1000),1000+defense[rank-1]);
    assert.equal(f.fighter().weaponBlock,block[rank-1]);assert.equal(f.fighter().shieldBlock,0);
    f.conditions.update((ages[rank-1]+1)*60);
    assert.equal(f.conditions.hasBuff('player','guardian-of-darkness'),true);
    f.conditions.update(60);
    assert.equal(f.conditions.hasBuff('player','guardian-of-darkness'),false);
    assert.equal(f.conditions.attribute('player','defense',1000),1000);
    assert.equal(f.fighter().weaponBlock,0);
  }
});

test('guardian searches original party slots at execution time and includes stealth without summons',()=>{
  const f=fixture();f.conditions.applyState('player','stealthed',10000,'player');
  f.visuals.get('player')!.container.x=95;f.visuals.get('third')!.container.x=96;
  assert.equal(f.candidates().find(actor=>actor.id==='summon')?.team,'party');
  const cast=f.begin();f.visuals.get('caster')!.container.x=1;cast.frame(7);
  assert.deepEqual(f.attempts.map(hit=>hit.targetId),['player','caster','third']);
  assert.equal(f.conditions.hasBuff('summon','guardian-of-darkness'),false);
  assert.equal(f.conditions.snapshot('player')[0].sourceId,'caster');
  assert.equal(f.conditions.activeStates('player').includes('stealthed'),true);
});

test('guardian includes an active zero HP member until the direct chain finalizes its defeat',()=>{
  const f=fixture();f.members.get('third')!.player.health=0;
  f.hitResolution.run(()=>{
    f.hitResolution.deferDefeat('third',()=>{
      if(f.members.get('third')!.player.health===0)method('memberDefeated').call(f.host,'third');
    });
    assert.ok(f.actor('third'));
    f.cast();
    assert.deepEqual(f.attempts.map(hit=>hit.targetId),['player','caster','third']);
    assert.equal(f.conditions.hasBuff('third','guardian-of-darkness'),true);
    assert.equal(f.members.get('third')!.player.health,0);
    assert.equal(f.host.fallen.has('third'),false);
  });
  assert.equal(f.host.fallen.has('third'),true);
  assert.equal(f.conditions.hasBuff('third','guardian-of-darkness'),false);
  assert.equal(f.members.get('third')!.player.health,0);
  assert.equal(f.actor('third'),undefined);
  f.attempts.length=0;f.cast();
  assert.deepEqual(f.attempts.map(hit=>hit.targetId),['player','caster']);
});

test('guardian excludes zero HP outside a pending chain, missing displays and inactive displays',()=>{
  for(const exclusion of ['dead','missing','inactive'] as const){
    const f=fixture();
    if(exclusion==='dead')f.members.get('third')!.player.health=0;
    if(exclusion==='missing')f.visuals.delete('third');
    if(exclusion==='inactive')f.visuals.get('third')!.container.active=false;
    f.cast();
    assert.deepEqual(f.attempts.map(hit=>hit.targetId),['player','caster'],exclusion);
    assert.equal(f.conditions.hasBuff('third','guardian-of-darkness'),false);
  }
});

test('guardian keeps a stronger source and age, while equal casts replace source and refresh one layer',()=>{
  const f=fixture();f.cast(2);f.conditions.update(4560);
  const old=f.conditions.snapshot('third');
  f.cast(1,'player');assert.deepEqual(f.conditions.snapshot('third'),old);
  f.conditions.update(60);assert.equal(f.conditions.hasBuff('third','guardian-of-darkness'),false);
  f.cast(1);f.conditions.update(3600);f.cast(1,'player');
  const renewed=f.conditions.snapshot('third')[0];
  assert.equal(renewed.sourceId,'player');assert.equal(renewed.stackCount,1);
  f.conditions.update(3660);assert.equal(f.conditions.hasBuff('third','guardian-of-darkness'),true);
  f.conditions.update(60);assert.equal(f.conditions.hasBuff('third','guardian-of-darkness'),false);
});

test('guardian modifies raw defense after improved defense and before total defense rate',()=>{
  const f=fixture(),passives=passiveModifiers(catalog,'dark-knight',{levels:{'improved-defense':1}},'unarmed');
  f.setPassives(passives);assert.equal(f.fighter().defense,106);
  f.cast(1);const fighter=f.fighter();
  assert.equal(fighter.defense,174);assert.equal(fighter.defenseRate,500);
  assert.equal(calculateEffectiveDefense(fighter.defense!,fighter.defenseRate!),261);
  assert.equal(method('actorAttribute').call(f.host,'player','defense'),174);
});

test('guardian caster visuals keep their timing and still play when every weaker buff is rejected',()=>{
  const f=fixture();f.cast(8);const old=f.conditions.snapshot('player');
  f.order.length=0;f.attempts.length=0;
  const cast=f.begin(1);cast.frame(0);
  assert.deepEqual(f.order,['fx:spell-impact:caster']);cast.frame(7);
  assert.deepEqual(f.order,['fx:spell-impact:caster','buff:player','buff:caster','buff:third',
    'fx:aura-ring:caster','fx:sparkle-dust:caster']);
  assert.deepEqual(f.conditions.snapshot('player'),old);
});
