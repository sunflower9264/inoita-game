import assert from 'node:assert/strict';
import test from 'node:test';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveSkillUnitSequence} from '../src/domain/skill-unit-sequence.ts';
import type {PhysicalFighter,PhysicalHit} from '../src/domain/physical-hit.ts';
import {createCombatTestHarness,createTestEnemy,createTestMember,loadBattleCatalog,ZERO_PRIMARY_ATTRIBUTES} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const skill=catalog.skills['dark-strike'],units=skill.action!.combatUnits!;
const buff=units.find(unit=>unit.effect==='buff')!;
assert.equal(buff.effect,'buff');if(buff.effect!=='buff')throw new Error('Dark Strike buff missing');
const ranks=buff.ranks;

test('all dark strike ranks use one layer, the native buff age and ordered independent loop effects',()=>{
  const expected=[210,230,260,300,310,320,330,340];
  for(const [index,rank]of ranks.entries()){
    assert.equal(rank.effect.durationMs,4560);assert.equal(rank.effect.maxStacks,1);
    assert.deepEqual(rank.effect.simulationFrames,{lastActiveFrame:75});
    assert.deepEqual(rank.effect.modifiers,[{attribute:'skillDamageBonus',operation:{kind:'add',amount:expected[index]}}]);
    assert.deepEqual(rank.effect.loopEffects,[{effect:'soul-sword-magic',firstFrameAge:1},{effect:'soul-sword',firstFrameAge:1}]);
    const conditions=new CombatConditions();conditions.applyBuff('actor','dark-strike',rank.strength,rank.effect);
    assert.deepEqual(conditions.buffLoopFrames('actor'),[]);
    conditions.update(60);assert.deepEqual(conditions.buffLoopFrames('actor').map(frame=>frame.frameAge),[1,1]);
    conditions.update(75*60);assert.equal(conditions.hasBuff('actor','dark-strike'),true);
    assert.deepEqual(conditions.buffLoopFrames('actor').map(frame=>frame.frameAge),[76,76]);
    conditions.update(60);assert.deepEqual(conditions.buffLoopFrames('actor'),[]);
  }
});

test('rejected weaker refresh preserves loop age and source, accepted refresh restarts both layers',()=>{
  const conditions=new CombatConditions();conditions.applyBuff('actor','dark-strike',ranks[7].strength,ranks[7].effect,'strong');
  conditions.update(420);assert.equal(conditions.buffLoopFrames('actor')[0].frameAge,7);
  assert.equal(conditions.applyBuff('actor','dark-strike',ranks[0].strength,ranks[0].effect,'weak'),false);
  assert.equal(conditions.buffLoopFrames('actor')[0].frameAge,7);assert.equal(conditions.snapshot('actor')[0].sourceId,'strong');
  assert.equal(conditions.applyBuff('actor','dark-strike',ranks[7].strength,ranks[7].effect,'new'),true);
  assert.deepEqual(conditions.buffLoopFrames('actor'),[]);conditions.update(60);
  assert.equal(conditions.buffLoopFrames('actor')[0].frameAge,1);assert.equal(conditions.snapshot('actor')[0].sourceId,'new');
  const resumed=new CombatConditions();resumed.restoreState(conditions.captureState());
  assert.deepEqual(resumed.buffLoopFrames('actor'),conditions.buffLoopFrames('actor'));
});

function fixture(){
  const fighter:PhysicalFighter={level:1,physicalAttack:100,hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,
    criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0};
  const target={...fighter},conditions=new CombatConditions(),hits:PhysicalHit[]=[];
  const member=createTestMember({id:'actor',level:1,health:100,maxHealth:100,mana:100,maxMana:100,
    panel:{attributes:ZERO_PRIMARY_ATTRIBUTES,maxHealth:100,maxMana:100}});
  const enemies=new Map([['enemy',createTestEnemy({key:'enemy',definition:catalog.enemies[0],health:1000,maxHealth:1000})]]);
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hero:member,members:new Map([['actor',member]]),enemies,
    activeParty:()=>['actor'],
    withThreat:false,
    settlementOverrides:{onDropMana:()=>{}},
  });
  harness.stats.partyFighter=()=>fighter;
  harness.stats.enemyFighter=()=>target;
  harness.stats.actorAttributes=()=>({physicalAttack:100,magicAttack:0,maxHealth:100,physicalDamageRate:0,magicDamageRate:0,
    stealthDamageRate:0,primaryAttributes:ZERO_PRIMARY_ATTRIBUTES});
  harness.settlement.resolveHitReactions=()=>{};
  harness.settlement.settleHit=(_event,hit)=>hits.push(hit);
  const unit=(cueIndex:number,targetId:string,usesSkillDamageBuff=true)=>harness.settlement.skillUnit(
    {casterId:'actor',targetId,cueIndex,skill:{...skill,level:1,action:{...skill.action!,usesSkillDamageBuff}}});
  return {fighter,target,conditions,hits,unit};
}

test('skill bonus survives misses and ordinary attacks, is consumed by a non-miss zero hit, and only boosts the first area hit',t=>{
  t.mock.method(Math,'random',()=>0.1);
  const f=fixture(),apply=()=>f.conditions.applyBuff('actor','dark-strike',ranks[0].strength,ranks[0].effect);
  apply();f.unit(0,'enemy',false);assert.equal(f.conditions.hasBuff('actor','dark-strike'),true);
  f.fighter.hitBase=0;f.fighter.hitBonus=0;f.target.evasionBonus=750;
  f.unit(0,'enemy');assert.equal(f.hits.at(-1)!.kind,'miss');assert.equal(f.conditions.hasBuff('actor','dark-strike'),true);
  f.fighter.hitBase=100;f.fighter.hitBonus=1000;f.target.evasionBonus=0;f.target.physicalResistance=1000;
  f.unit(0,'enemy');assert.equal(f.hits.at(-1)!.damage,0);assert.equal(f.conditions.hasBuff('actor','dark-strike'),false);
  f.target.physicalResistance=0;apply();f.unit(0,'enemy');f.unit(0,'enemy');
  assert.deepEqual(f.hits.slice(-2).map(hit=>hit.damage),[254,210]);
});

test('an enemy failed hit does not block the final self buff in the same ordered action',t=>{
  t.mock.method(Math,'random',()=>0.1);
  const f=fixture();f.fighter.hitBase=0;f.fighter.hitBonus=0;f.target.evasionBonus=750;
  const results=resolveSkillUnitSequence(units,{targets:index=>[index===2?'actor':'enemy'],unit:f.unit});
  assert.deepEqual(results.map(result=>result.outcome),['failure','skipped','success']);
  assert.equal(f.conditions.hasBuff('actor','dark-strike'),true);
});
