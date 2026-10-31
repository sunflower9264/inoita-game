import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';

const battle=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
type Unit={effect:string;attribute?:string;buff?:string;state?:string;
  ranks?:{kind:string;amount?:number;effect?:{modifiers?:{attribute:string}[]}}[]};
const unitsOf=(skill:string)=>battle.skills[skill]!.action!.combatUnits as unknown as Unit[];

test('assassin sword guarantees a poison proc and never installs stun',()=>{
  const units=unitsOf('assassin-s-sword');
  assert.deepEqual(units.map(unit=>unit.effect),['set-attribute','set-attribute','physical','clear-attribute','clear-attribute']);
  assert.equal(units[0]!.attribute,'poisonStrikeChance');
  assert.ok(units[0]!.ranks!.every(rank=>rank.kind==='add'&&rank.amount===1000),'暗杀之剑把毒概率加满');
  assert.equal(units[1]!.attribute,'assassinSwordHitAdjustment');
  assert.ok(units[1]!.ranks!.every(rank=>rank.kind==='subtract'&&rank.amount===400));
  assert.ok(units.every(unit=>unit.buff!=='attack-stun'&&unit.state!=='stun'),'属性27不施加眩晕');
  assert.ok(!JSON.stringify(units).includes('"stun"'));
});

test('poison touch only raises the poison strike chance',()=>{
  const units=unitsOf('poison-touch');
  assert.deepEqual(units.map(unit=>unit.effect),['buff']);
  assert.equal(units[0]!.buff,'poison-touch');
  for(const rank of units[0]!.ranks??[])
    assert.deepEqual(rank.effect?.modifiers?.map(modifier=>modifier.attribute),['poisonStrikeChance']);
});

test('poisoned is a ten-stack damage-over-time with the native cadence',()=>{
  const poisoned=battle.statusAttackBuffs!.poisoned!;
  assert.equal(poisoned.durationMs,9060);
  assert.equal(poisoned.simulationFrames?.lastActiveFrame,150);
  assert.equal(poisoned.simulationFrames?.pulseIntervalFrames,30);
  assert.equal(poisoned.maxStacks,10);
  assert.deepEqual(poisoned.periodic.map(pulse=>pulse.kind),['normal-damage']);
  const pulse=poisoned.periodic[0] as unknown as {kind:string;operation:unknown};
  assert.deepEqual(pulse.operation,{kind:'multiply-thousandth',ratePerThousand:140});
});
