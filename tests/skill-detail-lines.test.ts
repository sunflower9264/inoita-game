import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { skillForGrowth } from '../src/domain/battle.ts';
import { plainDescription } from '../src/domain/description-text.ts';
import { skillDescriptionParts, skillLearningParts, skillNextLevelPreview } from '../src/ui/skill-detail-lines.ts';

const catalog=JSON.parse(fs.readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

test('native preview retains unchanged mana and effects and excludes cooldown',()=>{
  const skill=catalog.skills['dark-strike'];
  assert.deepEqual(skillNextLevelPreview(skill.ranks,1,'active',skill.normalMaxLevel),[
    {label:'魔法消耗量',from:'40',to:'40',kind:'mana'},
    {label:'（攻击+力量x1.2+智力）x',from:'210.5%',to:'230.5%',kind:'effect'},
    {label:'伤害增加：',from:'+21.0%',to:'+23.0%',kind:'effect'},
    {label:'剑之灵魂持续时间：',from:'5秒',to:'5秒',kind:'effect'},
  ]);
});

test('unlearned preview formats zero with native units and ordinary cap hides the whole preview',()=>{
  const skill=catalog.skills['dark-strike'];
  assert.deepEqual(skillNextLevelPreview(skill.ranks,0,'active',skill.normalMaxLevel).map(row=>row.from),['0','0.0%','+0.0%','0秒']);
  for(const level of [4,5,8])assert.deepEqual(skillNextLevelPreview(skill.ranks,level,'active',skill.normalMaxLevel),[]);
});

test('current description preserves native spaces, blue numeric runs and white base text',()=>{
  const skill=catalog.skills['dark-strike'],parts=skillDescriptionParts(skill,0);
  assert.equal(plainDescription(parts),`${skill.name} (LV 1)\n${skill.description}\n魔法消耗量: 40\n冷却时间: 6秒\n（攻击+力量x1.2+智力）x210.5%\n伤害增加： +21.0%\n剑之灵魂持续时间： 5秒\n`);
  assert(parts.some(part=>part.text==='210.5%'&&part.color==='#00b4ff'));
  assert.equal(parts[0].color,undefined);
  const damage=skill.ranks[0].details![3]!;
  assert.deepEqual([damage.label,damage.value,damage.valueSpacing],['伤害增加：','+21.0%',true]);
  assert(!plainDescription(parts).includes('主动技能'));
});

test('learning condition and point balance have independent native colors',()=>{
  const state={level:0,cost:2,invested:1,requiredInvested:6,atLimit:false,conditionMet:false,pointsAvailable:true};
  let parts=skillLearningParts('幻影之剑',0,state);
  assert.equal(parts[1].text,'条件：投入6技能点\n');assert.equal(parts[1].color,'#ff0000');
  assert.equal(parts[2].text,'需要技能点数： 2');assert.equal(parts[2].color,'#ffffff');
  parts=skillLearningParts('幻影之剑',0,{...state,conditionMet:true,pointsAvailable:false});
  assert.equal(parts[1].color,'#ffffff');assert.equal(parts[2].color,'#ff0000');
});

test('all ninety skills retain both role profiles, effective row identities and every rank preview',()=>{
  let checked=0;
  for(const original of Object.values(catalog.skills))for(const growth of ['hero','companion'] as const){
    const skill=skillForGrowth(original,growth);
    assert.equal(skill.ranks.length,8);
    for(const rank of skill.ranks){
      assert(rank.investedSkillPoints!>=rank.pointCost);
      rank.details!.forEach(detail=>{
        assert(!detail.label.includes('：：')&&!detail.value.includes('：：'));
        if(detail.kind==='effect')assert.equal(plainDescription(detail.valueParts!),detail.value);
      });
    }
    for(let level=0;level<=8;level++){
      const rows=skillNextLevelPreview(skill.ranks,level,skill.kind,skill.normalMaxLevel);
      if(level>=skill.normalMaxLevel)assert.equal(rows.length,0);
      else{
        const next=skill.ranks[level];
        assert.equal(rows.length,next.details!.filter(detail=>detail.kind!=='cooldown').length);
        assert.deepEqual(rows.map(row=>row.to),next.details!.filter(detail=>detail.kind!=='cooldown').map(detail=>detail.value));
      }
      checked++;
    }
  }
  assert.equal(checked,1620);
});

test('effect identity keeps equal or empty labels from merging separate comparison values',()=>{
  const ranks=[{manaCost:0,details:[{label:'',value:'10%',kind:'effect' as const,effectIndex:0},{label:'',value:'20秒',kind:'effect' as const,effectIndex:1}]},
    {manaCost:0,details:[{label:'',value:'15%',kind:'effect' as const,effectIndex:0},{label:'',value:'25秒',kind:'effect' as const,effectIndex:1}]}];
  assert.deepEqual(skillNextLevelPreview(ranks,1,'passive').map(row=>[row.from,row.to]),[['10%','15%'],['20秒','25秒']]);
});
