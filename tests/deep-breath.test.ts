import assert from 'node:assert/strict';
import test from 'node:test';
import type {BattleBuffEffect} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {createCombatTestHarness,createTestMember,loadBattleCatalog} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const bodhi=[catalog.skills['energy-bodhi'].action!.combatUnits!.find(unit=>unit.effect==='buff')!] as const;
if(bodhi[0].effect!=='buff')throw new Error('missing energy bodhi buff');
const childOf=(rank:number)=>catalog.skills['deep-breath'].reactionsByRank![rank-1]![0] as
  {kind:string;buff:{key:string;rankPriority:number;effect:BattleBuffEffect}};
const increments=[20,30,40,60,60,70,80,80];
const incrementFrames=[30,45,60,90,90,105,120,120];
const childCaps=[90,105,120,135,150,150,165,165];
const evasions=[70,90,110,130,140,150,160,170];

test('eight ranks carry the lifetime increment and the child definitions with their own caps',()=>{
  const passive=catalog.skills['deep-breath'].passiveUnits![0] as {attribute:string;ranks:{kind:string;amount:number}[]};
  assert.equal(passive.attribute,'deepBreathDurationBonus');
  assert.deepEqual(passive.ranks,increments.map(amount=>({kind:'add',amount})));
  childOf(1);
  for(let rank=1;rank<=8;rank++){
    const child=childOf(rank);
    assert.equal(child.kind,'deep-breath');
    assert.equal(child.buff.key,'deep-breath');
    assert.deepEqual(child.buff.effect.modifiers,[{attribute:'evasionBonus',operation:{kind:'add',amount:evasions[rank-1]!}}],`rank ${rank}`);
    assert.deepEqual(child.buff.effect.simulationFrames,{lastActiveFrame:childCaps[rank-1]},`rank ${rank}`);
    assert.equal(child.buff.effect.maxStacks,1);
  }
  // 十五之十换算：属性值是原值，帧是它乘 1.5 截断。
  for(let rank=1;rank<=8;rank++)
    assert.equal(Math.trunc(increments[rank-1]!*15/10),incrementFrames[rank-1],`rank ${rank}`);
});

test('the bodhi declares both accepted actions and keeps its own base cap',()=>{
  const effect=bodhi[0].ranks[0]!.effect;
  assert.deepEqual(effect.durationFramesFromOwner,{attribute:'deepBreathDurationBonus'});
  assert.deepEqual(effect.onAccepted,[{kind:'apply-learned-buff',skill:'deep-breath',target:'target'}]);
  assert.deepEqual(effect.simulationFrames,{lastActiveFrame:120});
});

function fixture(bodhiRank=1,deepRank=8,increment:number|null=null){
  const conditions=new CombatConditions(),log:string[]=[];
  const member=createTestMember({
    id:'player',classId:'assassin',maxHealth:100,maxMana:0,
    skillLevels:deepRank?{'deep-breath':deepRank}:{},
  });
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hero:member,members:new Map([['player',member]]),
    activeParty:()=>['player'],
    settlementOverrides:{onStateConsequences:undefined,onBuffApplication:undefined},
  });
  // 压力取自属性；本用例直接用参数给出，避免依赖面板换算。
  harness.stats.actorAttribute=(_id,key)=>key==='deepBreathDurationBonus'?(increment??increments[deepRank-1]??0):0;
  const baseAccepted=harness.settlement.applyAcceptedEffects.bind(harness.settlement);
  harness.settlement.applyAcceptedEffects=(sourceId,targetId,effect)=>{
    if(effect.onAccepted?.length)log.push('accepted');
    baseAccepted(sourceId,targetId,effect);
  };
  const apply=(targetId:string,effect:BattleBuffEffect=bodhi[0].ranks[bodhiRank-1]!.effect,
    strength=bodhi[0].ranks[bodhiRank-1]!.strength)=>
    harness.settlement.applyActorBuff(targetId,'energy-bodhi',strength,effect,'player');
  const cap=(id:string,key:'energy-bodhi'|'deep-breath')=>conditions.buffLifetimeFrames(id,key);
  return {conditions,log,apply,cap,setIncrement:(value:number)=>{increment=value;}};
}

test('the accepted bodhi extends its own cap and hands the target the child',()=>{
  const self=fixture(1,8);
  assert.equal(self.apply('player'),true);
  // 基础 120 帧 + 八级增量 trunc(80×15/10)=120 → 240。
  assert.equal(self.cap('player','energy-bodhi'),240);
  // 增益挂在施法者自己身上，子增益也落在原目标（也就是他自己），复制到 240。
  assert.equal(self.cap('player','deep-breath'),240);
  assert.equal(self.conditions.attribute('player','evasionBonus',0),170);
  assert.deepEqual(self.log,['accepted']);
  // 打给别人时子增益跟着原目标走，但上限只认施法者自己身上的父增益（他没有，所以用子的公式 165）。
  const other=fixture(1,8);
  assert.equal(other.apply('ally'),true);
  assert.equal(other.cap('ally','energy-bodhi'),240);
  assert.equal(other.cap('ally','deep-breath'),165);
  assert.equal(other.cap('player','deep-breath'),undefined,'子增益不在施法者身上');
});

test('without the passive the bodhi keeps its base cap and no child appears',()=>{
  const run=fixture(1,0,0);
  assert.equal(run.apply('ally'),true);
  assert.equal(run.cap('ally','energy-bodhi'),120);
  assert.equal(run.cap('ally','deep-breath'),undefined);
  assert.equal(run.conditions.attribute('ally','evasionBonus',0),0);
});

test('the child copies the aged parent cap, not what is left of it',()=>{
  const run=fixture(1,8);
  assert.equal(run.apply('player'),true);
  // 父增益老化 100 帧后（上限 240 还剩 140）再刷新一次：上限仍是 240，子增益也复制 240。
  run.conditions.update(100*60);
  assert.equal(run.cap('player','energy-bodhi'),240,'上限不随年龄变小');
  assert.equal(run.apply('player'),true);
  assert.equal(run.cap('player','deep-breath'),240);
});

test('an untouched source keeps the child at its own formula cap',()=>{
  const run=fixture(1,8);
  assert.equal(run.apply('player'),true);
  // 把施法者身上的父增益清掉，再对另一个目标施放：这时没有父上限可复制。
  run.conditions.removeBuff('player','energy-bodhi');
  assert.equal(run.apply('other'),true);
  assert.equal(run.cap('other','deep-breath'),165,'八级子自己的公式上限');
});

test('a lower-rank bodhi is refused and neither extends nor creates anything',()=>{
  const run=fixture(8,8);
  assert.equal(run.apply('player'),true);
  assert.equal(run.cap('player','energy-bodhi'),240);
  assert.deepEqual(run.log,['accepted']);
  assert.equal(run.apply('player',bodhi[0].ranks[0]!.effect,bodhi[0].ranks[0]!.strength),false);
  assert.deepEqual(run.log,['accepted'],'被拒绝时不执行接受钩子');
  assert.equal(run.cap('player','energy-bodhi'),240,'被拒后父增益保持在八级的上限');
});
