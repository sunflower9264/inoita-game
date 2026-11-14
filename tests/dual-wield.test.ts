import assert from 'node:assert/strict';
import test from 'node:test';
import {baseOffhandAttackChance,chooseDualWield,offhandPhysicalAttack} from '../src/domain/dual-wield.ts';

const dualWieldClasses=['assassin','warrior'];

test('offhand chance uses the offhand weapon and body armor only for the eligible classes',()=>{
  for(const role of ['assassin','warrior'])for(const [kind,chance] of [['dagger',140],['longsword',100],['axe',90],['mace',90],['shield',0],['staff',0],['empty',0]] as const){
    assert.equal(baseOffhandAttackChance(role,kind,'plate',dualWieldClasses),chance);
    assert.equal(baseOffhandAttackChance(role,kind,'leather',dualWieldClasses),chance+50);
  }
  for(const role of ['priest','warlock','ranger','dark-knight'])assert.equal(baseOffhandAttackChance(role,'dagger','leather',dualWieldClasses),0);
  assert.equal(baseOffhandAttackChance('dark-knight','dagger','leather',['dark-knight']),190);
});

test('dual wield draws once before reading chance and uses the strict native threshold',()=>{
  for(const [chance,roll,expected] of [[0,1,false],[199,199,false],[200,199,true],[1000,999,true],[-1,1,false]] as const){
    const order:string[]=[];
    assert.equal(chooseDualWield('warrior',true,{random:()=>{order.push('roll');return (roll-.5)/999;},chance:()=>{order.push('chance');return chance;}},dualWieldClasses),expected);
    assert.deepEqual(order,['roll','chance']);
  }
  // 注入的随机源可能返回 1；掷点范围必须仍夹在 1..999，不能让必中判定变成失败。
  assert.equal(chooseDualWield('warrior',true,{random:()=>1,chance:()=>1000},dualWieldClasses),true);
  const forbidden=()=>assert.fail('ineligible attacks do not roll or read the offhand chance');
  assert.equal(chooseDualWield('warrior',false,{random:forbidden,chance:forbidden},dualWieldClasses),false);
  assert.equal(chooseDualWield('priest',true,{random:forbidden,chance:forbidden},dualWieldClasses),false);
});

test('offhand power removes main weapon power before halving with negative odd values rounded down',()=>{
  assert.equal(offhandPhysicalAttack(100,60,40),60);
  assert.equal(offhandPhysicalAttack(99,60,40),59);
  assert.equal(offhandPhysicalAttack(59,60,40),39);
  assert.equal(offhandPhysicalAttack(101,0,40),90);
});
