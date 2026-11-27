import assert from 'node:assert/strict';
import test from 'node:test';
import type {CombatThreatSystem} from '../src/domain/combat-threat-system.ts';
import {resolveSkillReactions,type SkillReaction} from '../src/domain/skill-reactions.ts';
import {createCombatTestHarness,createTestEnemy,createTestMember,loadBattleCatalog} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const skill=catalog.skills['clever-fellow'];
const thresholds=[30,50,80,120,130,140,150,160];
const noBuff={random:()=>0,learnedBuff:()=>undefined};

test('eight ranks carry only the cooldown reset chance',()=>{
  assert.deepEqual(skill.passiveUnits,[]);
  skill.reactionsByRank!.forEach((rank,index)=>
    assert.deepEqual(rank,[{kind:'clever-fellow',chanceThreshold:thresholds[index]}],`rank ${index+1}`));
});

test('only a successful physical summon hit draws the chance and resets the owner cooldowns',()=>{
  const reactions=skill.reactionsByRank![0] as readonly SkillReaction[];
  const event={kind:'summon-physical-success',ownerId:'player',opponentId:'enemy',damageKind:'physical',outcome:'hit'} as const;
  assert.deepEqual(resolveSkillReactions(reactions,event,{random:()=>0,learnedBuff:()=>undefined}),
    [{kind:'reset-skill-cooldowns',targetId:'player'}]);
  // 阈值相等失败：抽到 30 时 30 不通过。
  assert.deepEqual(resolveSkillReactions(reactions,event,{random:()=>29/999,learnedBuff:()=>undefined}),[]);
  assert.deepEqual(resolveSkillReactions(reactions,{...event,outcome:'miss'},noBuff),[]);
  assert.deepEqual(resolveSkillReactions(reactions,{...event,damageKind:'magic' as const},noBuff),[]);
  assert.deepEqual(resolveSkillReactions([{kind:'clever-fellow',chanceThreshold:0}],event,noBuff),[]);
});

test('the owner reaction runs after the summon taunt and uses the owners learned rank',t=>{
  t.mock.method(Math,'random',()=>0);
  const order:string[]=[];
  let version=0,draft:()=>{levels:Record<string,number>}=()=>({levels:{'clever-fellow':1}});
  const skills={get version(){return version;},resetVersion:0,draft:()=>draft()};
  const player=createTestMember({id:'player',classId:'ranger'});
  const beast=createTestEnemy({key:'beast',definition:catalog.enemies[0],summonedBy:'player',summonTauntChance:1000});
  const harness=createCombatTestHarness({
    battleCatalog:catalog,
    members:new Map([['player',player]]),
    enemies:new Map([['beast',beast]]),
    sessionSkills:()=>skills as never,
    withThreat:false,
    settlementOverrides:{
      threat:{taunt:(source:string,target:string)=>order.push(`taunt:${source}->${target}`)} as unknown as CombatThreatSystem,
      enemyTarget:()=>'ally',
      resetActorCooldowns:(id:string)=>order.push(`cooldowns:${id}`),
    },
  });
  harness.settlement.summonOwnerReactions({casterId:'beast',targetId:'enemy'},{kind:'hit',damage:5},'physical');
  assert.deepEqual(order,['taunt:beast->enemy','cooldowns:player']);

  order.length=0;
  draft=()=>({levels:{}});version++;
  harness.settlement.summonOwnerReactions({casterId:'beast',targetId:'enemy'},{kind:'hit',damage:5},'physical');
  assert.deepEqual(order,['taunt:beast->enemy'],'没学就不清冷却');
});
