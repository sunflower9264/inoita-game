import assert from 'node:assert/strict';
import test from 'node:test';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {CombatActorAttributes} from '../src/domain/combat-damage-source.ts';
import {resolveSkillReactions} from '../src/domain/skill-reactions.ts';
import {createCombatTestHarness,createTestMember,loadBattleCatalog} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
function reaction(rank:number){
  const value=catalog.skills['flares-of-pain'].reactionsByRank?.[rank-1]?.[0];
  assert.equal(value?.kind,'flares-of-pain');
  if(value?.kind!=='flares-of-pain')throw new Error('missing reviewed flares');
  return value;
}
const attack={kind:'attack-effects',ownerId:'source',opponentId:'target',damageKind:'physical',
  outcome:'hit',actionId:'firestorm',hasMoltenArmor:false} as const;

test('all eight flares ranks preserve their native chance, periodic rate, color and age schedule',()=>{
  const chances=[300,500,700,900,1000,1100,1200,1300],rates=[140,180,220,260,280,300,320,340];
  for(let rank=1;rank<=8;rank++){
    const value=reaction(rank),effect=value.buff.effect;
    assert.equal(value.chanceThreshold,chances[rank-1]);assert.equal(value.buff.rankPriority,[4003,4005,4007,4009,4010,4011,4012,4013][rank-1]);
    assert.equal(effect.maxStacks,1);assert.equal(effect.durationMs,9060);assert.equal(effect.tickMs,1800);
    assert.deepEqual(effect.simulationFrames,{lastActiveFrame:150,pulseIntervalFrames:30});
    assert.ok(effect.appearanceColors?.length);
    assert.deepEqual(effect.periodic,[{kind:'attribute-damage',attribute:'bestNormalDamage',
      operation:{kind:'multiply-thousandth',ratePerThousand:rates[rank-1]}}]);
    const trigger=(roll:number)=>resolveSkillReactions([value],attack,{random:()=> (roll-1)/999,learnedBuff:()=>undefined});
    assert.equal(trigger(Math.min(999,chances[rank-1]-1)).length,1);
    if(chances[rank-1]<=999)assert.equal(trigger(chances[rank-1]).length,0);
  }
});

test('flares pulse six times from the next shared frame and read the source damage anew on every pulse',t=>{
  t.mock.method(Math,'random',()=>assert.fail('periodic damage must not roll a hit or another proc'));
  const conditions=new CombatConditions(),amounts:number[]=[],sources:string[]=[];
  let sourceDamage=100;
  const harness=createCombatTestHarness({battleCatalog:catalog,conditions,withThreat:false});
  harness.stats.actorAttributes=()=>({}) as CombatActorAttributes;
  harness.stats.actorAttribute=(id,key)=>{if(key==='bestNormalDamage'){sources.push(id);return sourceDamage;}return 1000;};
  harness.settlement.settleHit=(event,hit,_enemy,presentation)=>{
    assert.deepEqual(event,{casterId:'owner',targetId:'victim'});assert.equal(presentation?.periodic,true);amounts.push(hit.damage);
  };
  harness.settlement.restoreHealth=()=>assert.fail('burning must not heal');
  // 空的状态表会让 update 提前返回、不推进共享帧余量；放一条长寿增益让时钟保持推进。
  conditions.applyBuff('clock','attack-stun',1,{durationMs:60000,tickMs:0,states:[],modifiers:[],periodic:[]});
  conditions.update(50);
  const buff=reaction(1).buff;
  conditions.applyBuff('victim',buff.key,buff.rankPriority,buff.effect,'owner');
  const advance=(ms:number)=>conditions.update(ms,tick=>harness.settlement.periodicTick(tick));
  advance(9);assert.equal(amounts.length,0);
  advance(1);assert.deepEqual(amounts,[14]);sourceDamage=200;
  advance(9000);assert.deepEqual(amounts,[14,28,28,28,28,28]);
  assert.equal(conditions.hasBuff('victim','flares-of-pain'),true);
  advance(60);assert.equal(conditions.hasBuff('victim','flares-of-pain'),false);
  assert.deepEqual(sources,Array(6).fill('owner'));
});

test('accepted flares refresh source and first pulse while a weaker application leaves the stronger burn intact',()=>{
  const conditions=new CombatConditions(),strong=reaction(8).buff,weak=reaction(1).buff;
  conditions.applyBuff('victim',strong.key,strong.rankPriority,strong.effect,'first');
  conditions.update(1800);
  assert.equal(conditions.applyBuff('victim',weak.key,weak.rankPriority,weak.effect,'weak'),false);
  assert.equal(conditions.snapshot('victim')[0].sourceId,'first');
  assert.equal(conditions.applyBuff('victim',strong.key,strong.rankPriority,strong.effect,'second'),true);
  const ticks:string[]=[];conditions.update(60,tick=>ticks.push(tick.sourceId));
  assert.deepEqual(ticks,['second']);assert.equal(conditions.snapshot('victim')[0].stackCount,1);
});

test('both armored combatants ignite each other through the actual physical hit phases even with zero reflection damage',t=>{
  t.mock.method(Math,'random',()=>0);
  const conditions=new CombatConditions();
  const members=new Map(['attacker','defender'].map(id=>[id,createTestMember({
    id,classId:'dark-knight',skillLevels:{'flares-of-pain':8},
  })]));
  const armor=catalog.skills['molten-armor'].action!.combatUnits!.find(value=>value.effect==='buff')!;
  assert.equal(armor.effect,'buff');if(armor.effect!=='buff')return;
  for(const id of members.keys())conditions.applyBuff(id,armor.buff,armor.ranks[0].strength,armor.ranks[0].effect,id);
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,members,
    activeParty:()=>[...members.keys()],
    combatants:()=>[],
    combatant:()=>undefined,
    withThreat:false,
    settlementOverrides:{onStateConsequences:undefined,onBuffApplication:undefined},
  });
  harness.stats.actorAttribute=(id,key)=>conditions.attribute(id,key,0);
  harness.settlement.attackProc=()=>{};
  harness.settlement.resolveHitReactions({casterId:'attacker',targetId:'defender'},{kind:'shield-block',damage:0},'physical','basic-attack');
  for(const [target,source] of [['attacker','defender'],['defender','attacker']]){
    assert.equal(conditions.snapshot(target).find(value=>value.id==='flares-of-pain')?.sourceId,source);
  }
});
