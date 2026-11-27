import assert from 'node:assert/strict';
import test from 'node:test';
import type {SummonOwnerDerivation} from '../src/domain/battle.ts';
import type {CombatThreatSystem} from '../src/domain/combat-threat-system.ts';
import {summonLifetimeFrames,summonOwnerStats} from '../src/domain/summon-stats.ts';
import {createCombatTestHarness,createTestEnemy,loadBattleCatalog} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const unit=catalog.skills['beast-companion'].action!.combatUnits![0] as {
  effect:'summon';creature:string;ownerDerived:SummonOwnerDerivation;
  lifetimeFromOwner:{attribute:string;perPoint:number;base:number};
  ranks:{durationMs:number;simulationFrames?:{lastActiveFrame:number};healthRatePerThousand?:number;tauntChanceThreshold?:number}[]};
const healthRates=[600,800,1100,1500,1600,1700,1800,1900];
const taunts=[40,60,90,130,140,150,160,170];

test('eight ranks keep the health bonus, the taunt chance and the owner-driven lifetime rule',()=>{
  assert.equal(unit.creature,'enemy-beast-companion-1');
  assert.deepEqual(unit.ownerDerived,{attack:{attribute:'physicalAttack',perLevel:3,flat:9},
    health:{perLevel:120,flat:1000},physicalResistanceBonus:250,magicResistance:120});
  assert.deepEqual(unit.lifetimeFromOwner,{attribute:'summonDurationBonus',perPoint:150,base:150000});
  unit.ranks.forEach((rank,index)=>{
    assert.equal(rank.healthRatePerThousand,healthRates[index],`rank ${index+1}`);
    assert.equal(rank.tauntChanceThreshold,taunts[index]);
    assert.equal(rank.simulationFrames?.lastActiveFrame,225);assert.equal(rank.durationMs,226*60);
  });
});

test('the beast derives 3L+9 attack and a bonus-scaled health pool',()=>{
  assert.deepEqual(summonOwnerStats(unit.ownerDerived,unit.ranks[0]!,10),
    {physicalAttack:39,maxHealth:3520,physicalResistanceBonus:250,magicResistance:120});
  assert.equal(summonOwnerStats(unit.ownerDerived,unit.ranks[7]!,10).maxHealth,6380);
  assert.equal(summonOwnerStats(unit.ownerDerived,unit.ranks[0]!,1).physicalAttack,12);
  assert.equal(summonOwnerStats(unit.ownerDerived,unit.ranks[0]!,1).maxHealth,1792);
});

test('the beast lifetime converts the owner bonus before the frame conversion',()=>{
  assert.equal(summonLifetimeFrames(unit.lifetimeFromOwner,0),225);
  assert.equal(summonLifetimeFrames(unit.lifetimeFromOwner,300),292);
  assert.equal(summonLifetimeFrames(unit.lifetimeFromOwner,1300),517);
  assert.equal(summonLifetimeFrames(unit.lifetimeFromOwner,1000),450);
});

test('a beast that hits a target which is not attacking it rolls its owner taunt chance',t=>{
  t.mock.method(Math,'random',()=>0.01);
  const calls:string[]=[];
  let targetOfEnemy='player';
  const beast=createTestEnemy({key:'beast',definition:catalog.enemies[0],summonedBy:'player',summonTauntChance:40});
  const harness=createCombatTestHarness({
    battleCatalog:catalog,enemies:new Map([['beast',beast]]),withThreat:false,
    settlementOverrides:{
      threat:{taunt:(source:string,target:string)=>calls.push(`${source}->${target}`)} as unknown as CombatThreatSystem,
      enemyTarget:()=>targetOfEnemy,
    },
  });
  const event={casterId:'beast',targetId:'enemy'};
  harness.settlement.summonOwnerReactions(event,{kind:'hit',damage:5},'physical');
  assert.deepEqual(calls,['beast->enemy']);
  calls.length=0;
  targetOfEnemy='beast';
  harness.settlement.summonOwnerReactions(event,{kind:'hit',damage:5},'physical');
  assert.equal(calls.length,0,'目标已经在打它就不抽');
  targetOfEnemy='player';
  harness.settlement.summonOwnerReactions(event,{kind:'miss',damage:0},'physical');
  assert.equal(calls.length,0,'落空不抽');
  beast.summonTauntChance=0;
  harness.settlement.summonOwnerReactions(event,{kind:'hit',damage:5},'physical');
  assert.equal(calls.length,0,'机会为 0 不抽');
});
