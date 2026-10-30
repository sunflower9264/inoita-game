import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {enemySkills, type BattleCatalog, type SkillAction} from '../src/domain/battle.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

/** 原版 Buff 记录 +6（施加特效）与 +8（循环表现）解出来的样子：怪物 Buff 同样有值。 */
const expected:Record<string,{applicationEffect:string;loopEffect?:string}> = {
  'monster-landshake-stun':{applicationEffect:'flash-gold'},
  'monster-strong-stun':{applicationEffect:'flash-gold'},
  'monster-hammer-stun':{applicationEffect:'flash-gold'},
  'monster-sleep':{applicationEffect:'monster-sleep-aura'},
  'monster-emergency-recovery':{applicationEffect:'monster-sleep-aura',loopEffect:'monster-poison-aura'},
  'monster-blazing-armor':{applicationEffect:'molten-armor-aura'},
};

type BuffUnit={effect:string;buff?:string;ranks?:{effect?:{applicationEffect?:string;loopEffects?:{effect:string;firstFrameAge:number}[]}}[]};
type Action=Pick<SkillAction,'combatUnits'>;

function buffUnits(action:Action|undefined):BuffUnit[] {
  return (action?.combatUnits??[]).filter(unit=>unit.effect==='buff'&&unit.buff!==undefined) as BuffUnit[];
}

const skills=catalog.enemies.flatMap(enemy=>enemySkills(enemy));

test('monster buffs keep the native application and loop visuals',()=>{
  const seen=new Set<string>();
  for(const skill of skills)for(const unit of buffUnits(skill.action)){
    const want=unit.buff?expected[unit.buff]:undefined;
    if(!want)continue;
    seen.add(unit.buff!);
    assert.ok(unit.ranks?.length,'增益缺少等级数据');
    for(const rank of unit.ranks!)assert.equal(rank.effect?.applicationEffect,want.applicationEffect,
      `${unit.buff} 的命中特效应来自原版 Buff 表`);
  }
  assert.deepEqual([...seen].sort(),Object.keys(expected).sort());
});

test('the sleep recovery buff also keeps its looping aura',()=>{
  for(const skill of skills)for(const unit of buffUnits(skill.action)){
    if(unit.buff!=='monster-emergency-recovery')continue;
    for(const rank of unit.ranks!){
      // 施加特效 monster-sleep-aura 播完 9 帧后接循环表现，所以从第 10 帧开始。
      assert.deepEqual(rank.effect?.loopEffects,[{effect:'monster-poison-aura',firstFrameAge:10}]);
    }
  }
});

test("Kanna's stun strike plays a gold flash on the target",()=>{
  const enemy=catalog.enemies.find(value=>value.id==='enemy-cornette-1');
  assert.ok(enemy,'缺少卡娜的战斗单位');
  const strike=enemySkills(enemy).find(skill=>skill.id==='monster-stunning-strike');
  assert.ok(strike,'卡娜缺少眩晕技能');
  const buff=buffUnits(strike.action).find(unit=>unit.buff==='monster-strong-stun');
  assert.ok(buff,'眩晕技能缺少击晕增益');
  for(const rank of buff.ranks!)assert.equal(rank.effect?.applicationEffect,'flash-gold');
});

test('player crit and blunt stuns flash like the monster ones',()=>{
  // 原版这两条 Buff 的 +6 是 -1；玩家反馈要求统一眩晕提示后补成怪物眩晕同款金光。
  for(const key of ['critical-hit-stun','blunt-hit-stun'] as const){
    assert.equal(catalog.statusAttackBuffs?.[key]?.applicationEffect,'flash-gold',`${key} 缺少命中闪光`);
    assert.equal(catalog.statusAttackBuffs?.[key]?.durationMs,960,`${key} 的时长应保持原版的 15 帧`);
  }
});

test('every buff visual points at a packaged effect',()=>{
  for(const skill of skills)for(const unit of buffUnits(skill.action))for(const rank of unit.ranks??[]){
    const names=[...(rank.effect?.applicationEffect?[rank.effect.applicationEffect]:[]),
      ...(rank.effect?.loopEffects??[]).map(loop=>loop.effect)];
    for(const name of names)assert.ok(catalog.attackEffects[name],`缺少特效素材：${name}`);
  }
});
