import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {memberSkillGrowth,skillForMember,type BattleCatalog} from '../src/domain/battle.ts';
import {passiveModifiers} from '../src/domain/passive-skills.ts';
import {parseBattle} from '../src/application/content-validation.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

test('content loading rejects missing companion data and incomplete companion combat ranks',()=>{
  const missing=structuredClone(catalog);
  delete missing.skills['dark-attack'].companion;
  assert.throws(()=>parseBattle(missing),/companion/);
  const incomplete=structuredClone(catalog);
  const unit=incomplete.skills['dark-attack'].companion!.action!.combatUnits![0];
  assert.ok('ranks' in unit);unit.ranks.pop();
  assert.throws(()=>parseBattle(incomplete),/全部技能等级/);
});

test('all 105 skills provide eight ranks for both stable character identities',()=>{
  assert.equal(Object.keys(catalog.skills).length,105);
  for(const skill of Object.values(catalog.skills)){
    assert.ok(skill.companion,skill.id);
    for(const member of ['player','story-companion','recruited-companion']){
      const selected=skillForMember(catalog,member,skill.id)!;
      assert.deepEqual(selected.ranks.map(rank=>rank.level),[1,2,3,4,5,6,7,8]);
      assert.equal(selected.action===null,skill.kind==='passive');
    }
  }
  assert.equal(memberSkillGrowth('player'),'hero');
  assert.equal(memberSkillGrowth('recruited-companion'),'companion');
});

/**
 * 42 个被动技能的通用形状集中在这里断言。各个技能自己的用例不再重复这几条规则——
 * 从前它们散在 5~7 个文件里各写一遍，规则一变就要改多处，漏掉哪处只会表现为
 * 「部分技能测了新规则、部分没测」，从红绿看不出来。
 *
 * 集合本身靠**数量**钉住，而不是「先按 kind 过滤再断言 kind」——那是重言式。
 */
test('passive skills share the original rank shape and split cleanly on reaction tables',()=>{
  const passives=Object.values(catalog.skills).filter(skill=>skill.kind==='passive');
  assert.equal(passives.length,42);
  for(const skill of passives){
    assert.equal(skill.action,null,skill.id);
    assert.equal(skill.ranks.length,8,skill.id);
    assert.deepEqual(skill.ranks.map(rank=>rank.manaCost),Array(8).fill(0),skill.id);
  }
  // 原版 16 个 + 龙枪 6 个纯数值被动没有逐级反应表，另 20 个有。两侧一起钉死：多一个少一个都报错。
  const withoutReactions=passives.filter(skill=>skill.reactionsByRank===undefined).map(skill=>skill.id).sort();
  assert.deepEqual(withoutReactions,[
    'blade-of-darkness','blood-feast','coiling-dragon-footwork','divine-arms','dragon-spirit',
    'forest-knowledge','fortitude','healing-enhancement','improved-defense','insanity-thrills',
    'piercing-momentum','polearm-reach','rear-penetration','shadow-phantom','shaft-parry',
    'skin-of-steel','soul-s-thirst','spear-mastery','spiritual-affinity','twin-blade',
    'warrior-s-instinct','weapon-specializing',
  ]);
});

test('active damage and repeat counts use the original owner column at every rank',()=>{
  // ACT 35/39/50/96, native training columns +1 (main character) and +3 (companion).
  const expected={
    player:{slash:[701,768,868,1001,1035,1068,1101,1135],raid:[2500,2700,2900,3100,3200,3300,3400,3500],
      agony:[3,4,5,6,6,7,7,7],arrows:[4,5,6,7,8,8,8,9]},
    ally:{slash:[735,801,868,935,968,1001,1035,1068],raid:[2400,2600,2800,3000,3100,3200,3300,3400],
      agony:[3,4,5,5,6,6,6,7],arrows:[5,5,6,7,7,7,8,8]},
  };
  for(const member of ['player','ally'] as const){
    const damage=(id:string)=>{
      const unit=skillForMember(catalog,member,id)!.action!.combatUnits!.find(unit=>unit.effect==='physical');
      assert.ok(unit?.effect==='physical');
      return unit.ranks.map(rank=>{assert.equal(rank.operation.kind,'multiply-thousandth');return 'ratePerThousand' in rank.operation?rank.operation.ratePerThousand:undefined;});
    };
    assert.deepEqual(damage('continuous-slash'),expected[member].slash);
    assert.deepEqual(damage('dark-attack'),expected[member].raid);
    assert.deepEqual(skillForMember(catalog,member,'touch-of-agony')!.action!.repeat!.countByLevel,expected[member].agony);
    assert.deepEqual(skillForMember(catalog,member,'multiple-shot')!.action!.repeat!.countByLevel,expected[member].arrows);
  }
});

test('passive aggregation keeps each character identity when queried in alternating order',()=>{
  const expected={hero:[30,50,80,120,130,140,150,160],companion:[40,60,80,100,110,120,130,140]};
  for(let rank=1;rank<=8;rank++){
    for(const member of ['player','ally','player','ally']){
      const growth=memberSkillGrowth(member);
      const values=passiveModifiers(catalog,'assassin',{levels:{'twin-blade':rank}},'dagger',false,growth);
      assert.deepEqual(values.find(value=>value.attribute==='offhandAttackChance')?.operation,
        {kind:'add',amount:expected[growth][rank-1]},`${member}/${rank}`);
    }
  }
});
