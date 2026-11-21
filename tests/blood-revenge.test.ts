import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveSkillReactions,type SkillReaction} from '../src/domain/skill-reactions.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
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

function fixture(){
  const conditions=new CombatConditions(),order:string[]=[];
  const member=(rank:number)=>({classId:'warlock',player:{health:100,maxHealth:100,mana:0,maxMana:0},
    bag:{equipmentFor:()=>({}),get:()=>undefined,equipmentItems:()=>({})},
    skills:{draft:()=>({levels:rank?{'blood-revenge':rank}:{}})}});
  const members=new Map([['first',member(1)],['second',member(8)],['idle',member(0)]]);
  const host=Object.setPrototypeOf({app:{battleCatalog:catalog,session:{skills:{draft:()=>({levels:{}})}}},
    conditions,arena:[{key:'pawn',summonedBy:'first'},{key:'enemy'}],activeParty:['first','second','idle','extra'],
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    fallen:new Set(),pendingDefeats:new Set(),
    memberOf:(id:string)=>id==='pawn'?undefined:members.get(id),
    hitResolution:{isAwaitingDefeat:()=>false},
    equipmentRecovery:()=>({lifeDrainPerThousand:0}),actorAttribute:()=>0,attackProc:()=>{},
    syncCombatResourceLimits:()=>{},applyStateConsequences:()=>{},showBuffApplication:()=>{},
    react:(function(this:unknown,...args:unknown[]){
      const [event]=args as [{kind:string;ownerId:string}];
      if(event.kind==='blood-revenge')order.push(`blood-revenge:${event.ownerId}`);
      return Reflect.get(WorldCombat.prototype,'react').apply(this,args);
    } as unknown as (event:unknown)=>void)},
    WorldCombat.prototype);
  const hit=(targetId:string,damageKind:'physical'|'magic',kind:'hit'|'miss'|'shield-block')=>
    Reflect.get(WorldCombat.prototype,'resolveHitReactions').call(host,{casterId:'enemy',targetId},
      {kind,damage:0},damageKind,'basic-attack',{});
  return {conditions,order,hit};
}

test('a hit on a party member or its summon stacks every holder by its own rank',()=>{
  const {conditions,order,hit}=fixture();
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

test('an enemy being hit, a miss and a magic shield block never stack',()=>{
  const {conditions,order,hit}=fixture();
  hit('enemy','physical','hit');
  hit('first','physical','miss');
  hit('first','magic','shield-block');
  assert.deepEqual(order,[]);
  assert.equal(conditions.snapshot('first').length,0);
});

test('ten layers cap and a zero-damage physical success still stacks',()=>{
  const {conditions,hit}=fixture();
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
