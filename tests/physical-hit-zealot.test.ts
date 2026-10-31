import assert from 'node:assert/strict';
import test from 'node:test';
import {rollMagicHit,rollPhysicalHit,type PhysicalFighter} from '../src/domain/physical-hit.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';

const fighter=(overrides:Partial<PhysicalFighter>={}):PhysicalFighter=>({
  level:10,physicalAttack:1000,defense:0,defenseRate:0,physicalResistanceBonus:0,magicAttack:0,maxHealth:1000,
  hitBase:100,hitBonus:0,evasionBase:100,evasionBonus:0,criticalRate:0,criticalResistance:0,
  criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,...overrides,
});
const middle=()=>0.5;

test('zealot raises physical damage on the attacker side and leaves magic unchanged',()=>{
  const normal=rollPhysicalHit(fighter(),fighter(),middle,1000);
  const zealot=rollPhysicalHit(fighter({zealotRate:200}),fighter(),middle,1000);
  assert.equal(normal.kind,'hit');
  assert.equal(normal.damage,1000);
  assert.equal(zealot.damage,1200);
  assert.equal(rollMagicHit(fighter({zealotRate:200}),fighter(),1000,middle).damage,
    rollMagicHit(fighter(),fighter(),1000,middle).damage);
});

test('zealot lowers the wearer physical resistance by its own proportion',()=>{
  const conditions=new CombatConditions();
  const base=fighter({defense:500,defenseRate:0});
  const without=conditions.fighter('plain',base);
  const withZealot=conditions.fighter('zealot',{...base,zealotRate:200});
  // 1000*500/(500+20*(10+3)) = 657；657 - trunc(657*200/1000) = 526。
  assert.equal(without.physicalResistance,657);
  assert.equal(withZealot.physicalResistance,526);
  assert.equal(withZealot.zealotRate,200);
  // 防御侧生效后，同一次攻击对装备者造成更多伤害。
  const plainDamage=rollPhysicalHit(fighter(),without,middle,1000).damage;
  const zealotDamage=rollPhysicalHit(fighter(),withZealot,middle,1000).damage;
  assert.ok(zealotDamage>plainDamage);
});

test('negative zealot rate is clamped to zero',()=>{
  const conditions=new CombatConditions();
  const base=fighter({defense:500,defenseRate:0});
  const plain=conditions.fighter('plain',base);
  const negative=conditions.fighter('negative',{...base,zealotRate:-200});
  assert.equal(negative.zealotRate,0);
  assert.equal(negative.physicalResistance,plain.physicalResistance);
});
