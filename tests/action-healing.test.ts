import assert from 'node:assert/strict';
import test from 'node:test';
import {actionHealing} from '../src/domain/action-healing.ts';
import {actionDamage} from '../src/domain/action-damage.ts';
import {actionDamageSource} from '../src/domain/combat-damage-source.ts';
import type {NumericCombatUnit,SkillAction} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {createCombatTestHarness,createSimpleStatsPort,createTestEnemy,createTestMember,loadBattleCatalog,type TestMemberFixture} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const attributes={physicalAttack:100,magicAttack:50,maxHealth:1000,physicalDamageRate:0,magicDamageRate:0,
  stealthDamageRate:0,primaryAttributes:{strength:3,dexterity:0,vitality:0,intelligence:4,mentality:0}};
const unit:NumericCombatUnit={effect:'heal',source:'physicalAttack',attributeWeights:{strength:7,dexterity:0,vitality:0,intelligence:6,mentality:0},
  ranks:[{fixedAddition:999,operation:{kind:'multiply-thousandth',ratePerThousand:1500}}]};

test('ordinary healing skips a zero clamped caster rate and never enforces minimum healing',()=>{
  assert.equal(actionHealing(101,1500),151);
  assert.equal(actionHealing(101,0),101);assert.equal(actionHealing(101,-100),101);
  assert.equal(actionHealing(1,1),0);assert.equal(actionHealing(0,1500),0);
  assert.equal(actionHealing(-101,500),-50);
});

test('healing sums weighted stats before truncation and ignores the auxiliary fixed addition',()=>{
  const source=actionDamageSource(attributes);
  assert.equal(actionDamage(unit,1,source),156);
  assert.equal(actionHealing(actionDamage(unit,1,source),333),51);
  assert.equal(actionDamage({...unit,effect:'physical'},1,source),1654);
});

function fixture(rate=333){
  const reads:string[]=[],writes:number[]=[];
  const member=(id:string,health:number)=>{
    const m=createTestMember({id,level:1,health,maxHealth:1000,panel:{attributes:attributes.primaryAttributes,maxHealth:1000}});
    const setHealth=m.setHealth.bind(m);
    m.setHealth=(value:number)=>{writes.push(value);setHealth(value);};
    return m;
  };
  const source=member('source',50),target=member('target',100);
  const enemy=createTestEnemy({key:'enemy',definition:catalog.enemies[0],health:100,maxHealth:1000});
  const members=new Map<string,TestMemberFixture>([['source',source],['target',target]]);
  const enemies=new Map([['enemy',enemy]]);
  const harness=createCombatTestHarness({
    battleCatalog:catalog,hero:source,members,enemies,activeParty:()=>['source','target'],withThreat:false,
    settlementOverrides:{
      setEnemyHealth:(_id,health)=>{writes.push(health);enemy.health=Math.max(0,Math.min(enemy.maxHealth,Math.trunc(health)));},
    },
  });
  harness.stats.actorAttribute=(id:string,key:string)=>{
    if(key==='physicalAttack')return attributes.physicalAttack;
    reads.push(`${id}:${key}`);return id==='source'?rate:9000;
  };
  harness.stats.actorAttributes=()=>attributes;
  const heal=(targetId='target')=>harness.settlement.skillUnit(
    {casterId:'source',targetId,cueIndex:0,skill:{id:'healing-test',action:{combatUnits:[unit]} as unknown as SkillAction}});
  return {harness,source,target,enemyState:enemy,reads,writes,heal};
}

test('ordinary healing uses the caster rate for party and enemy recipients, including a full target',()=>{
  for(const targetId of ['target','enemy']){
    const f=fixture();assert.equal(f.heal(targetId),'success');
    assert.equal(targetId==='target'?f.target.player.health:f.enemyState.health,151);
    assert.deepEqual(f.reads,['source:healingPowerRate']);
  }
  const full=fixture(1500);full.target.player.health=1000;
  assert.equal(full.heal(),'success');assert.deepEqual(full.writes,[1000]);assert.equal(full.target.player.health,1000);
  const zero=fixture(0);zero.heal();assert.equal(zero.target.player.health,256);
});

test('ordinary healing rejects zero HP recipients but an active zero HP caster can heal a living ally',()=>{
  for(const targetId of ['target','enemy']){
    const f=fixture();if(targetId==='target')f.target.player.health=0;else f.enemyState.health=0;
    f.harness.hitResolution.run(()=>{
      f.harness.hitResolution.deferDefeat(targetId,()=>{});
      assert.equal(f.heal(targetId),'success');
    });
    assert.equal(f.writes.length,0);assert.equal(f.reads.length,0);
  }
  const f=fixture();f.source.player.health=0;
  f.harness.hitResolution.run(()=>{
    f.harness.hitResolution.deferDefeat('source',()=>{});
    assert.equal(f.heal(),'success');assert.equal(f.target.player.health,151);
  });
  assert.equal(f.source.player.health,0);
});

test('shared actor reads clamp healing power below zero after modifiers for both consumers',t=>{
  let adjustment=-1500;
  const conditions=new CombatConditions();
  t.mock.method(conditions,'attribute',(_id:string,key:string,base:number)=>{
    assert.equal(key,'healingPowerRate');assert.equal(base,1000);return base+adjustment;
  });
  const stats=createSimpleStatsPort({conditions,memberOf:()=>createTestMember({id:'source'}) as never});
  const read=()=>stats.actorAttribute('source','healingPowerRate');
  assert.equal(read(),0);adjustment=100;assert.equal(read(),1100);
});
