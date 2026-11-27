import assert from 'node:assert/strict';
import test from 'node:test';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveSkillReactions,type SkillReaction} from '../src/domain/skill-reactions.ts';
import {createCombatTestHarness,createTestEnemy,createTestMember,loadBattleCatalog,type TestMemberFixture} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const skill=catalog.skills['blood-revenge'];
const perLayer=[22,32,42,57,62,67,72,77];
const noBuff={random:()=>0,learnedBuff:()=>undefined};

test('eight ranks carry one layer worth of both damage rates and no passive modifier',()=>{
  assert.deepEqual(skill.passiveUnits,[]);
  skill.reactionsByRank!.forEach((rank,index)=>{
    const reaction=rank[0] as Extract<SkillReaction,{kind:'blood-revenge'}>;
    assert.equal(reaction.kind,'blood-revenge');
    assert.equal(reaction.buff.key,'blood-revenge');
    assert.deepEqual(reaction.buff.effect.modifiers,[
      {attribute:'physicalDamageRate',operation:{kind:'add',amount:perLayer[index]}},
      {attribute:'magicDamageRate',operation:{kind:'add',amount:perLayer[index]}}],`rank ${index+1}`);
    assert.equal(reaction.buff.effect.maxStacks,10);
    assert.deepEqual(reaction.buff.effect.simulationFrames,{lastActiveFrame:135});
    assert.equal(reaction.buff.effect.durationMs,136*60);
  });
});

test('a successful hit stacks one layer on the holder itself, without a chance roll',()=>{
  const rank=skill.reactionsByRank![7] as readonly SkillReaction[];
  const reaction=rank[0] as Extract<SkillReaction,{kind:'blood-revenge'}>;
  for(const [damageKind,outcome] of [['physical','hit'],['physical','weapon-block'],['physical','shield-block'],
    ['magic','hit']] as const)
    assert.deepEqual(resolveSkillReactions(rank,{kind:'blood-revenge',ownerId:'ally',opponentId:'enemy',
      damageKind,outcome},noBuff),
      [{kind:'apply-buff',sourceId:'ally',targetId:'ally',buff:reaction.buff}],`${damageKind}/${outcome}`);
  // 落空与魔法盾挡不算成功；概率端口给的是「一抽就中」，仍然不产生额外命令。
  assert.deepEqual(resolveSkillReactions(rank,{kind:'blood-revenge',ownerId:'ally',opponentId:'enemy',
    damageKind:'physical',outcome:'miss'},noBuff),[]);
  assert.deepEqual(resolveSkillReactions(rank,{kind:'blood-revenge',ownerId:'ally',opponentId:'enemy',
    damageKind:'magic',outcome:'shield-block'},noBuff),[]);
  assert.deepEqual(resolveSkillReactions(rank,{kind:'blood-revenge',ownerId:'ally',opponentId:'enemy',
    damageKind:'magic',outcome:'miss'},noBuff),[]);
});

function fixture(t:test.TestContext){
  const conditions=new CombatConditions(),order:string[]=[];
  const member=(id:string,rank:number)=>createTestMember({
    id,classId:'warlock',maxHealth:100,maxMana:0,
    skillLevels:rank?{'blood-revenge':rank}:{},
  });
  const members=new Map([['first',member('first',1)],['second',member('second',8)],['idle',member('idle',0)]]);
  const dummyEnemy=catalog.enemies[0];
  const enemies=new Map([
    ['pawn',createTestEnemy({key:'pawn',definition:dummyEnemy,summonedBy:'first'})],
    ['enemy',createTestEnemy({key:'enemy',definition:dummyEnemy})],
  ]);
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,members,enemies,
    activeParty:()=>['first','second','idle','extra'],
    settlementOverrides:{onEnemyZeroHealth:undefined},
    statsOverrides:{skillConfiguration:(_id,m)=>(m as unknown as TestMemberFixture).skills as never},
  });
  t.mock.method(harness.stats,'equipmentRecovery',()=>({lifeDrainPerThousand:0}));
  t.mock.method(harness.stats,'actorAttribute',()=>0);
  t.mock.method(harness.settlement,'attackProc',()=>{});
  const baseReact=harness.settlement.react.bind(harness.settlement);
  t.mock.method(harness.settlement,'react',(event:{kind:string;ownerId:string})=>{
    if(event.kind==='blood-revenge')order.push(`blood-revenge:${event.ownerId}`);
    return baseReact(event as never);
  });
  const hit=(targetId:string,damageKind:'physical'|'magic',kind:'hit'|'miss'|'shield-block')=>
    harness.settlement.resolveHitReactions({casterId:'enemy',targetId},{kind,damage:0},damageKind,'basic-attack');
  return {conditions,order,hit};
}

test('a hit on a party member or its summon stacks every holder by its own rank',t=>{
  const {conditions,order,hit}=fixture(t);
  hit('first','physical','hit');
  // 三个活动槽各判一次，但只有学过的人给自己叠；第四名成员不在槽位里。
  assert.deepEqual(order,['blood-revenge:first','blood-revenge:second','blood-revenge:idle']);
  // Buff13 原式 trunc((400+(10+20*b)*10)/40)：佣兵 b=2/12 得 22/72。
  assert.equal(conditions.attribute('first','physicalDamageRate',0),22,'一级一层');
  assert.equal(conditions.attribute('second','physicalDamageRate',0),72,'八级一层');
  assert.equal(conditions.snapshot('first')[0]?.sourceId,'first','来源是自己');
  assert.equal(conditions.snapshot('idle').length,0);
  assert.equal(conditions.snapshot('extra').length,0);
  // 同队召唤物挨打同样算同阵营。
  order.length=0;
  hit('pawn','magic','hit');
  assert.deepEqual(order,['blood-revenge:first','blood-revenge:second','blood-revenge:idle']);
  assert.equal(conditions.attribute('first','physicalDamageRate',0),44);
  assert.equal(conditions.attribute('second','physicalDamageRate',0),144);
});

test('an enemy being hit, a miss and a magic shield block never stack',t=>{
  const {conditions,order,hit}=fixture(t);
  hit('enemy','physical','hit');
  hit('first','physical','miss');
  hit('first','magic','shield-block');
  assert.deepEqual(order,[]);
  assert.equal(conditions.snapshot('first').length,0);
});

test('ten layers cap and a zero-damage physical success still stacks',t=>{
  const {conditions,hit}=fixture(t);
  for(let block=1;block<=12;block++){
    hit('first','physical','hit');
    assert.equal(conditions.attribute('first','physicalDamageRate',0),22*Math.min(block,10),`第 ${block} 次`);
  }
  assert.equal(conditions.snapshot('first')[0]?.stackCount,10);
  // 计算后 0 伤（本用例的伤害一直是 0）照样叠，已在上面覆盖。
  conditions.update(135*60);assert.equal(conditions.hasBuff('first','blood-revenge'),true);
  conditions.update(60);assert.equal(conditions.hasBuff('first','blood-revenge'),true);
  conditions.update(60);
  assert.equal(conditions.hasBuff('first','blood-revenge'),false);
  assert.equal(conditions.attribute('first','physicalDamageRate',0),0);
});
