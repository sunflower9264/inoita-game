import assert from 'node:assert/strict';
import test from 'node:test';
import type {BattleBuffEffect,SkillVisualEffect} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import type {AttackContact} from '../src/domain/combat.ts';
import {resolveSkillReactions} from '../src/domain/skill-reactions.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import {
  createCombatTestHarness,
  createTestMember,
  loadBattleCatalog,
  ZERO_PRIMARY_ATTRIBUTES,
} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const generalChances=[21,28,35,41,45,48,51,55],offhandChances=[65,85,105,125,135,145,155,165];

test('flare exports both threshold ladders and an unlearned stealth fallback that is not Whist rank one',()=>{
  const ranks=catalog.skills['flare'].reactionsByRank!;
  assert.equal(ranks.length,8);
  ranks.forEach((rank,index)=>{
    const reaction=rank[0];
    assert.equal(reaction.kind,'flare');
    assert.equal(reaction.chanceThreshold,generalChances[index]);
    assert.equal(reaction.offhandChanceThreshold,offhandChances[index]);
  });
  const fallback=ranks[0][0];
  assert.ok('unlearnedStealth' in fallback);
  const stealth=fallback.unlearnedStealth;
  assert.equal(stealth.key,'whist');
  assert.equal(stealth.rankPriority,1,'any learned level must refresh over the fallback');
  assert.deepEqual(stealth.effect.simulationFrames,{lastActiveFrame:90});
  const rate=stealth.effect.modifiers.find(value=>value.attribute==='stealthDamageRate');
  assert.ok(rate&&'operation' in rate&&rate.operation.kind==='add');
  assert.equal(rate.operation.amount,733,'the fallback differs from Whist rank one, which is 736');
  assert.deepEqual(stealth.effect.states,['stealthed']);
});

const base={level:10,physicalAttack:100,magicAttack:0,baseDefense:0,defense:0,defenseRate:0,
  maxHealth:1000,maxMana:100,hitBase:100,hitBonus:0,evasionBase:0,evasionBonus:0,
  criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,
  physicalResistance:0,physicalResistanceBonus:0,magicResistance:0,baseMagicResistance:0,attributes:ZERO_PRIMARY_ATTRIBUTES};

function fixture(flareRank:number,whistRank:number){
  const makeMember=(id:string)=>createTestMember({
    id,classId:'assassin',level:10,health:1000,maxHealth:1000,mana:50,maxMana:100,
    panel:structuredClone(base),
    skillLevels:{flare:flareRank,whist:whistRank},
  });
  const members=new Map([['player',makeMember('player')],['ally',makeMember('ally')]]);
  const conditions=new CombatConditions();
  const applied:{targetId:string;key:string;sourceId:string;priority:number;effect:BattleBuffEffect}[]=[];
  const effects:{targetId:string;effects:readonly SkillVisualEffect[]}[]=[];
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hitResolution:new CombatHitResolution(),
    hero:members.get('player'),members,
    activeParty:()=>['player','ally'],
    withThreat:false,
    settlementOverrides:{
      onShowEffects:(_actorId,id,value)=>{effects.push({targetId:id,effects:value});},
    },
  });
  harness.settlement.applyActorBuff=(targetId,key,priority,effect,sourceId)=>{
    applied.push({targetId,key,sourceId,priority,effect});
    return true;
  };
  const contact:AttackContact={casterId:'player',targetId:'ally'} as AttackContact;
  const strike=(kind:PhysicalHit['kind'],damageKind:'physical'|'magic'='physical',hand?:'main-hand'|'offhand')=>
    harness.settlement.resolveHitReactions({...contact,hand},{kind,damage:0} as PhysicalHit,damageKind,'probe');
  return {applied,effects,strike,rates:(effect:BattleBuffEffect)=>effect.modifiers.flatMap(m=>
    m.attribute==='stealthDamageRate'&&'operation' in m&&m.operation.kind==='add'?[m.operation.amount]:[])};
}

test('a main-hand success uses the general threshold and applies the learned stealth definition',t=>{
  const f=fixture(1,1);
  t.mock.method(Math,'random',()=>(generalChances[0]-1-.5)/999);
  f.strike('hit','physical','main-hand');
  assert.equal(f.applied.length,1);
  assert.equal(f.applied[0].key,'whist');
  assert.equal(f.applied[0].targetId,'player');
  assert.ok(f.applied[0].priority>0,'the learned level carries its own priority');
  assert.deepEqual(f.rates(f.applied[0].effect),[736],'the learned definition is Whist rank one, not the fallback');
  assert.equal(f.effects.length,1,'the smoke follows the attempted stealth application');
});

test('an offhand success draws the extra threshold first and short-circuits on success',t=>{
  const f=fixture(1,0);
  let draws=0;
  t.mock.method(Math,'random',()=>{draws+=1;return 0;});
  f.strike('hit','physical','offhand');
  assert.equal(draws,1,'a successful extra roll must not draw the general threshold');
  assert.equal(f.applied[0].priority,1,'without the learned skill the fallback applies');
  assert.deepEqual(f.rates(f.applied[0].effect),[733],'the fallback keeps its own rate');

  draws=0;
  t.mock.method(Math,'random',()=>{draws+=1;return draws===1?(offhandChances[0]-.5)/999:0;});
  f.applied.length=0;
  f.strike('hit','physical','offhand');
  assert.equal(draws,2,'a failed extra roll falls through to the general threshold');
  assert.equal(f.applied.length,1);
});

test('misses and magic neither draw nor apply',t=>{
  const f=fixture(1,1);
  let draws=0;
  t.mock.method(Math,'random',()=>{draws+=1;return 0;});
  f.strike('miss','physical','main-hand');
  f.strike('hit','magic','main-hand');
  assert.equal(draws,0);
  assert.equal(f.applied.length,0);
  assert.equal(f.effects.length,0);
});

test('a zero threshold still draws, because the native roll is unconditional',t=>{
  const reaction={kind:'flare' as const,chanceThreshold:0,offhandChanceThreshold:0,stealthFromLearnedSkill:'whist' as const,
    effect:'smoke-puff',unlearnedStealth:{key:'whist' as const,rankPriority:0,
      effect:{durationMs:5460,tickMs:0,simulationFrames:{lastActiveFrame:90},maxStacks:1,states:['stealthed' as const],modifiers:[],periodic:[]}}};
  for(const hand of ['main-hand','offhand'] as const){
    let draws=0;
    t.mock.method(Math,'random',()=>{draws+=1;return 0;});
    const commands=resolveSkillReactions([reaction],{kind:'physical-flare',ownerId:'player',opponentId:'ally',damageKind:'physical',outcome:'hit',hand},
      {random:Math.random,learnedBuff:()=>undefined});
    assert.equal(draws,hand==='offhand'?2:1,`${hand} draws without a positive threshold`);
    assert.equal(commands.length,0,'zero thresholds cannot gain stealth');
    t.mock.restoreAll();
  }
});
