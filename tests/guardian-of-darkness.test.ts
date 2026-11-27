import {dispatchFrame} from './support/combat-driver.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {SkillEffectCue} from '../src/domain/battle.ts';
import {CombatController,type Combatant,type CombatPort,type SkillUnitHit} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {passiveModifiers,type PassiveModifier} from '../src/domain/passive-skills.ts';
import {calculateEffectiveDefense,type PhysicalFighter} from '../src/domain/physical-hit.ts';
import type {SkillUnitOutcome} from '../src/domain/skill-unit-sequence.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const action=catalog.skills['guardian-of-darkness'].action!;
const unit=action.combatUnits![0];
assert.equal(unit.effect,'buff');if(unit.effect!=='buff')throw new Error('Guardian must apply a buff');
const ranks=unit.ranks;

function fixture(){
  const conditions=new CombatConditions(),hitResolution=new CombatHitResolution();
  const collision={x:-4,y:-4,width:8,height:8};
  const panel={baseDefense:100,defenseRate:500,physicalAttack:100,magicAttack:0,maxHealth:100,
    hitBase:100,hitBonus:0,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,
    criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
  const activeIds=['player','caster','third'];
  const members=new Map(activeIds.map(id=>[id,createTestMember({
    id,level:10,health:100,maxHealth:100,panel,
  })]));
  const visuals=new Map(['player','caster','third','summon'].map(id=>[id,{
    container:{active:true,x:0,y:0,setVisible:()=>{}},actor:{collision,clips:{}},layers:[],
  }]));
  const enemies=new Map([['summon',createTestEnemy({
    key:'summon',definition:{...catalog.enemies[0],id:'summon'},summonedBy:'player',
  })]]);
  const order:string[]=[],attempts:SkillUnitHit[]=[];let passives:PassiveModifier[]=[];
  const actor=(id:string):Combatant|undefined=>{
    if(enemies.get(id)?.pendingDefeat||(members.has(id)&&!activeIds.includes(id)))return undefined;
    const visual=visuals.get(id);
    if(!visual?.container.active||!visual.actor.collision)return undefined;
    const member=members.get(id);
    if(member&&!member.player.health&&!hitResolution.isAwaitingDefeat(id))return undefined;
    const enemy=enemies.get(id);
    return {
      id,
      team:member||(enemy?.summonedBy&&members.has(enemy.summonedBy))?'party':'hostile',
      position:{x:visual.container.x,y:visual.container.y},
      bounds:visual.actor.collision,
      states:conditions.activeStates(id),
      facing:'east',
    };
  };
  const candidates=():Combatant[]=>[...activeIds,...enemies.keys()]
    .flatMap(id=>{const entry=actor(id);return entry?[entry]:[];});
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hitResolution,hero:members.get('player'),members,enemies,
    activeParty:()=>activeIds,
    combatant:actor,
    combatants:candidates,
    withThreat:false,
    settlementOverrides:{
      hasDisplay:id=>!!visuals.get(id)?.container.active,
      onStateConsequences:undefined,
      onBuffApplication:()=>assert.fail('Guardian has no per-recipient application visual'),
    },
  });
  harness.stats.partyPassives=()=>passives;
  const slots=()=>harness.settlement.partyBuffSlots();
  const presenter={
    pose:()=>{},candidates,visual:(id:string)=>visuals.get(id),
    visualEffect:(effect:{effect:string},_variant:string,target:Combatant)=>order.push(`fx:${effect.effect}:${target.id}`),
    showUnitFeedback(hit:SkillUnitHit,outcome:SkillUnitOutcome,cue:SkillEffectCue){
      if(outcome==='skipped'||outcome==='failure'&&cue.unitFeedbackPolicy!=='always')return;
      const list=candidates();
      for(const visual of cue.effects){
        const id=visual.recipient==='caster'?hit.casterId:hit.targetId;
        const target=list.find(candidate=>candidate.id===id);
        if(target)this.visualEffect(visual,visual.variant??'default',target);
      }
    },
  };
  const begin=(level=1,casterId='caster')=>{
    let frame:(index:number)=>void=()=>{};
    const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor(casterId),actor,candidates,partySlots:slots,facing:()=> 'east',moveToward:()=>{},stop:()=>{},
      canStand:()=>true,relocate:()=>{},clearEffects:()=>{},
      play:(_action,onFrame)=>{frame=onFrame;return ()=>{};},
      frame:(current,index,contact,ready)=>dispatchFrame(presenter,current,index,contact,ready),
      unit:hit=>{attempts.push(hit);order.push(`buff:${hit.targetId}`);return harness.settlement.skillUnit(hit);},
      runUnitSequence:work=>hitResolution.run(work),
      unitFeedback:(hit,outcome,cue)=>presenter.showUnitFeedback(hit,outcome,cue),
      contact:()=>assert.fail('Party buffs cannot create an enemy contact'),
    };
    const controller=new CombatController(casterId,null,port);
    assert.equal(controller.request({id:'guardian-of-darkness',action,level}),'started');
    return {frame:(index:number)=>frame(index),controller};
  };
  return {harness,members,visuals,conditions,hitResolution,order,attempts,actor,candidates,slots,begin,
    cast:(level=1,casterId='caster')=>begin(level,casterId).frame(7),
    fighter:(id='player')=>harness.stats.partyFighter(id) as PhysicalFighter,
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
      if(f.members.get('third')!.player.health===0){
        f.harness.fallen.add('third');
        f.conditions.remove('third');
        f.members.get('third')!.clearCombatResourceLimits();
      }
    });
    assert.ok(f.actor('third'));
    f.cast();
    assert.deepEqual(f.attempts.map(hit=>hit.targetId),['player','caster','third']);
    assert.equal(f.conditions.hasBuff('third','guardian-of-darkness'),true);
    assert.equal(f.members.get('third')!.player.health,0);
    assert.equal(f.harness.fallen.has('third'),false);
  });
  assert.equal(f.harness.fallen.has('third'),true);
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
  assert.equal(f.harness.stats.actorAttribute('player','defense'),174);
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
