import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseBattle, parseCampaign, parseMenuPanels, validateMenuClasses } from '../src/application/content-validation.ts';
import { CHARACTER_ASSETS, SKILL_ASSETS, SKILL_AI_ASSETS, memberArt } from '../src/domain/menu-panels.ts';
import { Session } from '../src/domain/session.ts';

const read=(file:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${file}.json`,import.meta.url),'utf8'));
const catalog=parseBattle(read('battle')), panels=parseMenuPanels(read('menu-panels'));
const campaign=parseCampaign(read('campaign'));

test('story starts with one equipped active skill and isolates drafts and new sessions',()=>{
  const story=new Session(campaign);
  for(const character of catalog.classes){
    const initial=story.skills.draft(catalog,character.id), draft=story.skills.draft(catalog,character.id);
    const starter=character.skills[0];
    assert.deepEqual(initial.levels,Object.fromEntries(character.skills.map(id=>[id,id===starter?1:0])));
    draft.levels[starter]=9;
    assert.deepEqual(story.skills.draft(catalog,character.id),initial,'editing or cancelling cannot mutate learned levels');
    const skill=catalog.skills[starter];
    story.skills.setShortcutPage(character.id,1);
    assert.equal(story.skills.draft(catalog,character.id).levels[skill.id],1);
    assert.equal(story.skills.shortcutPage(character.id),1);
    assert.deepEqual(new Session(campaign).skills.draft(catalog,character.id),initial);
    assert.throws(()=>story.skills.setShortcutPage(character.id,2),/技能组/);
    assert.throws(()=>story.skills.setShortcutPage(character.id,0.5),/技能组/);
  }
});

test('native menu content checks positions, equipment slots, images and class coverage',()=>{
  validateMenuClasses(panels,catalog);
  const duplicate=structuredClone(panels);duplicate.skillPositions[14]={...duplicate.skillPositions[0]};
  assert.throws(()=>parseMenuPanels(duplicate),/技能位置/);
  const equipment=structuredClone(panels);equipment.equipmentSlots[0].id='missing';
  assert.throws(()=>parseMenuPanels(equipment),/装备槽/);
  const silhouette=structuredClone(panels);silhouette.equipmentSlots[0].emptyIcon='../work/icon.png';
  assert.throws(()=>parseMenuPanels(silhouette),/内部资源路径/);
  const slot=structuredClone(panels);delete slot.assets['inventory-slot'];
  assert.throws(()=>parseMenuPanels(slot),/缺少菜单素材/);
  const image=structuredClone(panels);image.classes['dark-knight'].preview='../work/preview.png';
  assert.throws(()=>parseMenuPanels(image),/内部资源路径/);
  const classes=structuredClone(panels);delete classes.classes['dark-knight'];
  assert.throws(()=>validateMenuClasses(classes,catalog),/职业数量/);
});

test('skill page requires native skins and three distinct local column headings',()=>{
  for(const key of SKILL_ASSETS){
    const missing=structuredClone(panels);delete missing.assets[key];
    assert.throws(()=>parseMenuPanels(missing),/缺少菜单素材/);
  }
  const columns=structuredClone(panels);columns.skillColumns.pop();
  assert.throws(()=>parseMenuPanels(columns),/三个独立技能列标题/);
  const duplicate=structuredClone(panels);duplicate.skillColumns[1].label=duplicate.skillColumns[0].label;
  assert.throws(()=>parseMenuPanels(duplicate),/三个独立技能列标题/);
  const image=structuredClone(panels);image.skillColumns[0].image='../work/heading.png';
  assert.throws(()=>parseMenuPanels(image),/内部资源路径/);
});

test('AI settings and settings tabs require native level art, locked slot and their own captions',()=>{
  for(const key of SKILL_AI_ASSETS){
    const missing=structuredClone(panels);delete missing.assets[key];
    assert.throws(()=>parseMenuPanels(missing),/缺少菜单素材/);
  }
  // 设置页的初始化按钮用通用外框加文案，不再需要带钻石的原版按钮图。
  const blank=structuredClone(panels);blank.skillPanel.labels.counterattackTitle='';
  assert.throws(()=>parseMenuPanels(blank),/自动反击标题、初始技能点与初始化按钮文案/);
  const reset=structuredClone(panels);reset.skillPanel.labels.resetButton='';
  assert.throws(()=>parseMenuPanels(reset),/自动反击标题、初始技能点与初始化按钮文案/);
  const absent=structuredClone(panels);delete (absent.skillPanel as {labels?:unknown}).labels;
  assert.throws(()=>parseMenuPanels(absent),/skillPanel/);
});

test('story members without dedicated portraits fall back to their class art, not the hero portrait',()=>{
  const classArt=panels.assets['party-class-warrior']!;
  assert.deepEqual(memberArt(panels,{portrait:null},'warrior','story'),{image:classArt,partyIcon:classArt});
  assert.deepEqual(memberArt(panels,{portrait:'missing'},'warrior','story'),{image:classArt,partyIcon:classArt});
  assert.deepEqual(memberArt(panels,{portrait:'kiyan'},'warrior','story'),panels.character.portraits.kiyan);
  // 佣兵即使角色定义带立绘，也只用职业默认图。
  assert.deepEqual(memberArt(panels,{portrait:'kiyan'},'warrior','mercenary'),{image:classArt,partyIcon:classArt});
});

test('character page requires status portraits, complete native skin and eleven distinct combat labels',()=>{
  for(const key of CHARACTER_ASSETS){
    const missing=structuredClone(panels);delete missing.assets[key];
    assert.throws(()=>parseMenuPanels(missing),/缺少菜单素材/);
  }
  const portrait=structuredClone(panels);delete portrait.character.portraits.kiyan;
  assert.throws(()=>parseMenuPanels(portrait),/缺少主角属性页立绘/);
  const path=structuredClone(panels);path.character.portraits.kiyan!.image='../work/portrait.png';
  assert.throws(()=>parseMenuPanels(path),/内部资源路径/);
  const labels=structuredClone(panels);labels.character.combatLabels[10]=labels.character.combatLabels[0]!;
  assert.throws(()=>parseMenuPanels(labels),/十一个独立战斗属性/);
  const blank=structuredClone(panels);blank.character.combatLabels[0]='';
  assert.throws(()=>parseMenuPanels(blank),/十一个独立战斗属性/);
});
