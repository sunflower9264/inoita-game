import assert from 'node:assert/strict';
import test from 'node:test';
import type {CombatUnit} from '../src/domain/battle.ts';
import type {CombatThreatSystem} from '../src/domain/combat-threat-system.ts';
import type {PhysicalFighter} from '../src/domain/physical-hit.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveSkillReactions,type SkillReaction} from '../src/domain/skill-reactions.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
  ZERO_PRIMARY_ATTRIBUTES,
} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const skill=catalog.skills['mage-s-claw'];
const amounts=[1,2,3,4,4,5,5,5];
const noBuff={random:()=>0,learnedBuff:()=>undefined};

test('eight ranks carry the fixed mana amount and no passive modifier',()=>{
  assert.deepEqual(skill.passiveUnits,[]);
  skill.reactionsByRank!.forEach((rank,index)=>assert.deepEqual(rank,
    [{kind:'owner-mana-restore',effect:'mana-recovery',amount:amounts[index]}],`rank ${index+1}`));
});

test('physical and magic summon successes restore a fixed amount, blocked and missed ones do not',()=>{
  const rank=(index:number)=>skill.reactionsByRank![index] as readonly SkillReaction[];
  const event={kind:'summon-attack-success',ownerId:'warlock',opponentId:'enemy',outcome:'hit'} as const;
  for(const damageKind of ['physical','magic'] as const)
    assert.deepEqual(resolveSkillReactions(rank(7),{...event,damageKind},noBuff),
      [{kind:'restore-mana',targetId:'warlock',amount:5},
       {kind:'play-effect',targetId:'warlock',effect:'mana-recovery'}],damageKind);
  // 物理武器格挡算成功（与共用成功判定一致），魔法盾挡和落空都不算。
  assert.equal(resolveSkillReactions(rank(0),{...event,damageKind:'physical',outcome:'weapon-block'},noBuff).length,2);
  assert.deepEqual(resolveSkillReactions(rank(0),{...event,damageKind:'magic',outcome:'shield-block'},noBuff),[]);
  assert.deepEqual(resolveSkillReactions(rank(0),{...event,damageKind:'physical',outcome:'miss'},noBuff),[]);
  // 零值不执行。
  assert.deepEqual(resolveSkillReactions([{kind:'owner-mana-restore',effect:'mana-recovery',amount:0}],
    {...event,damageKind:'physical'},noBuff),[]);
  // 计算后 0 伤仍算成功，回魔不看伤害。
  assert.equal(resolveSkillReactions(rank(0),{...event,damageKind:'physical'},noBuff).length,2);
});

test('a summon that lands a magic skill hit reaches the same owner reaction',()=>{
  const order:string[]=[];
  const fighter:PhysicalFighter={level:10,physicalAttack:100,magicAttack:100,defense:0,defenseRate:0,
    maxHealth:1000,hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,
    criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
  const unit:CombatUnit={effect:'magic',source:'magicAttack',attributeWeights:ZERO_PRIMARY_ATTRIBUTES,
    ranks:[{fixedAddition:0,operation:{kind:'keep'}}]};
  const hero=createTestMember({id:'player',classId:'warlock',level:10,skillLevels:{'mage-s-claw':8}});
  const warlock=createTestMember({id:'warlock',classId:'warlock',level:10,skillLevels:{'mage-s-claw':8}});
  const members=new Map([['warlock',warlock],['player',hero]]);
  const enemies=new Map([['pawn',createTestEnemy({key:'pawn',definition:catalog.enemies[0],summonedBy:'warlock'})]]);
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions:new CombatConditions(),hero,members,enemies,
    activeParty:()=>['warlock','player'],
    combatant:id=>({id,team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}}),
    withThreat:false,
    settlementOverrides:{
      isEnemyPresent:()=>true,
      onShowEffects:()=>order.push('effect'),
      onShowHit:undefined,
      onDropMana:undefined,
    },
  });
  harness.stats.partyFighter=()=>fighter;
  harness.stats.enemyFighter=()=>fighter;
  harness.stats.actorAttributes=()=>({physicalAttack:100,magicAttack:100,maxHealth:1000,physicalDamageRate:0,magicDamageRate:0,
    stealthDamageRate:0,primaryAttributes:ZERO_PRIMARY_ATTRIBUTES});
  harness.stats.actorAttribute=()=>100;
  // 主人链现在归成功链管：这里按生产接线调用同一个方法。
  harness.settlement.resolveHitReactions=(event,hit,damageKind)=>
    harness.settlement.summonOwnerReactions(event,hit,damageKind);
  harness.settlement.settleHit=()=>{};
  harness.settlement.restoreMana=(id,amount)=>order.push(`mana:${id}+${amount}`);
  const outcome=harness.settlement.skillUnit({casterId:'pawn',targetId:'player',cueIndex:0,
    skill:{id:'monster-hell-scream',level:1,action:{cooldownFrames:0,approachDistanceUnits:1,searchRadiusPx:0,transition:null,events:[],combatUnits:[unit]}}});
  assert.equal(outcome,'success');
  assert.deepEqual(order,['mana:warlock+5','effect']);
});

test('the owner gets the mana before the taunt, and each summon answers to its own owner',t=>{
  t.mock.method(Math,'random',()=>0);
  // 吸血脚爪是黑魔导的、完美配合是暗影猎手的，出厂内容里同一个主人不会同时有两条；
  // 这里给暗影猎手也挂上吸血脚爪，只为观察两者的先后。
  const data=structuredClone(catalog);
  data.classes.find(character=>character.id==='ranger')!.skills.push('mage-s-claw');
  const order:string[]=[];
  const warlock=createTestMember({id:'warlock',classId:'warlock',skillLevels:{'mage-s-claw':8}});
  const ranger=createTestMember({id:'ranger',classId:'ranger',skillLevels:{'mage-s-claw':1,'clever-fellow':1}});
  const members=new Map([['warlock',warlock],['ranger',ranger]]);
  const enemies=new Map([
    ['pawn',createTestEnemy({key:'pawn',definition:catalog.enemies[0],summonedBy:'warlock',summonTauntChance:1000})],
    ['beast',createTestEnemy({key:'beast',definition:catalog.enemies[0],summonedBy:'ranger',summonTauntChance:0})],
  ]);
  const harness=createCombatTestHarness({
    battleCatalog:data,members,enemies,
    withThreat:false,
    settlementOverrides:{
      threat:{taunt:(source:string)=>order.push(`taunt:${source}`)} as unknown as CombatThreatSystem,
      enemyTarget:()=>'ally',
      resetActorCooldowns:id=>order.push(`cooldowns:${id}`),
      onShowEffects:()=>order.push('effect'),
    },
  });
  harness.settlement.restoreMana=(id,amount)=>order.push(`mana:${id}+${amount}`);
  harness.settlement.summonOwnerReactions({casterId:'pawn',targetId:'enemy'},{kind:'hit',damage:9},'magic');
  // 黑魔导没学完美配合，所以只到回魔、表现、嘲讽三步。
  assert.deepEqual(order,['mana:warlock+5','effect','taunt:pawn']);
  order.length=0;
  // 暗影猎手的召唤物：回魔按自己的一级（+1），完美配合按自己的已学等级清自己的冷却。
  harness.settlement.summonOwnerReactions({casterId:'beast',targetId:'enemy'},{kind:'hit',damage:9},'physical');
  assert.deepEqual(order,['mana:ranger+1','effect','cooldowns:ranger']);
});

test('召唤物命中的嘲讽阈值按主人当前等级重读，不冻结创建时的快照',t=>{
  const order:string[]=[];
  const levels:Record<string,number>={'beast-companion':8};
  const ranger=createTestMember({id:'ranger',classId:'ranger'});
  ranger.skills={version:1,resetVersion:0,draft:()=>({levels:{...levels}})};
  const enemies=new Map([
    // 创建时快照是 0（一级之外没记），主人现在是八级，原表阈值 170。
    ['beast',createTestEnemy({key:'beast',definition:catalog.enemies[0],summonedBy:'ranger',summonTauntChance:0,summonedBySkill:'beast-companion'})],
  ]);
  const harness=createCombatTestHarness({
    battleCatalog:catalog,members:new Map([['ranger',ranger]]),enemies,
    withThreat:false,
    settlementOverrides:{
      threat:{taunt:(source:string)=>order.push(`taunt:${source}`)} as unknown as CombatThreatSystem,
      enemyTarget:()=>'ally',
      resetActorCooldowns:()=>{},
    },
  });
  harness.settlement.restoreMana=()=>{};
  const roll=(point:number)=>t.mock.method(Math,'random',()=>(point-0.5)/999);
  roll(99);
  harness.settlement.summonOwnerReactions({casterId:'beast',targetId:'enemy'},{kind:'hit',damage:9},'physical');
  assert.deepEqual(order,['taunt:beast'],'99 低于八级阈值 170，应当嘲讽');
  order.length=0;
  levels['beast-companion']=1;
  roll(99);
  harness.settlement.summonOwnerReactions({casterId:'beast',targetId:'enemy'},{kind:'hit',damage:9},'physical');
  assert.equal(order.length,0,'降回一级后阈值 40，99 不再触发');
  delete levels['beast-companion'];
  roll(1);
  harness.settlement.summonOwnerReactions({casterId:'beast',targetId:'enemy'},{kind:'hit',damage:9},'physical');
  assert.equal(order.length,0,'主人忘掉技能后不再嘲讽');
});
