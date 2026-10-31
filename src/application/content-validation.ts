import { validateStoryDebug } from '../domain/story-debug.ts';
import {ITEM_NOTICES} from '../domain/item-application.ts';
import {buffEffectNames} from '../domain/buff-effects.ts';
import { feedbackEffects, type CombatFeedbackDefinition } from '../domain/combat-feedback.ts';
import { STATUS_PARTS, type HudGauge, type HudInset, type HudRect, type StatusHudSkin } from '../domain/status-hud.ts';
import { CHARACTER_ASSETS, ITEM_ACTION_ASSETS, SKILL_ASSETS, SKILL_AI_ASSETS, QUEST_ASSETS, PARTY_ASSETS, type MenuPanels } from '../domain/menu-panels.ts';
import { CONTROL_PARTS, type ControlSkin } from '../domain/control-skin.ts';
import type { ActorDefinition, WorldIndex, WorldMap, AnimationClip, DialogueAction, EffectClip, EffectLayer } from '../domain/content.ts';
import { STORY_POSE_NAMES } from '../domain/content.ts';
import type { Campaign } from '../domain/campaign.ts';
import type { ActionDispatchDefinition, BasicAttackBinding, BasicAttackDefinition, BattleBuffEffect, BattleCatalog, EffectPlacement, EnemyBehavior, ResolvedBasicAttack, SkillAction, SkillAfterimages, SkillCharge, SkillEffectCue, SkillTransition, SkillVisualEffect, StateDurationProfile } from '../domain/battle.ts';
import { COMBAT_OUTCOME_EFFECTS } from '../domain/combat-outcomes.ts';
import { ACCEPTED_LEARNED_BUFF_SKILLS, LEARNED_REACTION_SKILLS, enemySkills, LOGIC_FRAME_MS } from '../domain/battle.ts';
import { BATTLE_BUFF_KEYS, BATTLE_STATE_KEYS, BATTLE_STAT_KEYS } from '../domain/battle-semantics.ts';
import { MAX_ENEMY_LEVEL, type EnemyAttributes } from '../domain/enemy-stats.ts';
import { resolveBasicAttack } from '../domain/basic-attack.ts';
import { DIRECT_BLENDS, EFFECT_OPERATIONS, effectProblems } from '../rendering/effect-colors.ts';
import { performanceTargets } from '../domain/story-performance.ts';
import type { PerformanceAction, StoryCastMember } from '../domain/story-performance.ts';
import { ITEM_CATEGORIES, MINIMAP_ASSETS, type StoryInterface } from '../domain/story-interface.ts';
import type { StoryClassCatalog } from '../domain/story-class.ts';
import { EQUIPMENT_SLOTS, EQUIPMENT_SLOT_ORDER, ITEM_USES, type ItemCatalog } from '../domain/items.ts';
import type { WardrobeCatalog } from '../domain/wardrobe.ts';
import type { ShopCatalog, WeightedItem } from '../domain/shop.ts';
import { PRIMARY_STATS, type CharacterStatsCatalog, type EnhancementRule, type ModifierRange } from '../domain/character-stats.ts';
import type { CompanionCatalog, CompanionDefinition } from '../domain/party.ts';
import type { CompanionGenerationRules } from '../domain/companion-progression.ts';
import type { QuestFact } from '../domain/quest-book.ts';
import type { StoryEncounter } from '../domain/story-world.ts';
import type { StateApplicationRules } from '../domain/state-application.ts';
import type { BuffReactionBuff } from '../domain/buff-reactions.ts';
import { STORY_TRIGGER_SOURCES, validateStoryGraph, type StoryCommand, type StoryNodeRef } from '../domain/story-graph.ts';
import { storyConditionReferences, type StoryCondition } from '../domain/story-condition.ts';
import { placementAuthority } from '../domain/actor-authority.ts';

type Check = (value: unknown, path: string) => void;
function requireValue(condition: unknown, path: string, message: string): asserts condition {
  if(!condition)throw new Error(`内容无效 ${path}: ${message}`);
}
const text:Check=(v,p)=>requireValue(typeof v==='string',p,'需要文字');
const number:Check=(v,p)=>requireValue(typeof v==='number'&&Number.isFinite(v),p,'需要有限数字');
const positive:Check=(v,p)=>{number(v,p);requireValue((v as number)>0,p,'必须大于零');};
const integer:Check=(v,p)=>{number(v,p);requireValue(Number.isInteger(v)&&(v as number)>=0,p,'需要非负整数');};
const count:Check=(v,p)=>{integer(v,p);requireValue((v as number)>0,p,'必须是正整数');};
const diceFace:Check=(v,p)=>{count(v,p);requireValue((v as number)<=99,p,'骰面不能超过 99');};
const offsetInteger:Check=(v,p)=>{number(v,p);requireValue(Number.isInteger(v),p,'需要整数');};
const boolean:Check=(v,p)=>requireValue(typeof v==='boolean',p,'需要布尔值');
const optional=(check:Check):Check=>(v,p)=>{if(v!==undefined)check(v,p);};
const nullable=(check:Check):Check=>(v,p)=>{if(v!==null)check(v,p);};
const oneOf=(...values:string[]):Check=>(v,p)=>requireValue(typeof v==='string'&&values.includes(v),p,`需要 ${values.join('/')}`);
const variant=(key:string,variants:Record<string,Check>):Check=>(v,p)=>{
  requireValue(v&&typeof v==='object'&&!Array.isArray(v),p,'需要对象');
  const kind=(v as Record<string,unknown>)[key];
  requireValue(typeof kind==='string'&&Object.hasOwn(variants,kind),p,`未知 ${key}: ${String(kind)}`);
  variants[kind](v,p);
};

const array=(check:Check):Check=>(v,p)=>{requireValue(Array.isArray(v),p,'需要数组');v.forEach((item,i)=>check(item,`${p}[${i}]`));};
const record=(check:Check):Check=>(v,p)=>{requireValue(v&&typeof v==='object'&&!Array.isArray(v),p,'需要对象');for(const [key,item]of Object.entries(v))check(item,`${p}.${key}`);};
const object=(fields:Record<string,Check>):Check=>(v,p)=>{
  requireValue(v&&typeof v==='object'&&!Array.isArray(v),p,'需要对象');
  const data=v as Record<string,unknown>;
  for(const key of Object.keys(data))requireValue(key in fields,`${p}.${key}`,'未定义字段');
  for(const [key,check]of Object.entries(fields))check(data[key],`${p}.${key}`);
};
/**
 * 把校验表的键绑到内容类型上：类型加了字段而这里没补，编译期就会报错。
 * `Required<T>` 让可选字段也成为必填键——可选字段在这里写成 `optional(...)`。
 * 运行时与 `object` 完全一致。
 */
const shape=<T>(fields:{[K in keyof Required<T>]:Check}):Check=>object(fields);
const file:Check=(v,p)=>{text(v,p);requireValue(/^(assets|content)\/[a-zA-Z0-9_./-]+$/.test(v as string)&&!(v as string).split('/').includes('..'),p,'需要游戏内部资源路径');};
const strings=array(text),facing=oneOf('north','south','east','west'),exitFacing=oneOf('north','south','east','west','any');
const modifierRange=shape<ModifierRange>({stat:text,min:integer,max:integer});
const descriptionParts=array(object({text,color:optional((v,p)=>{text(v,p);requireValue(/^#[0-9a-f]{6}$/i.test(v as string),p,'需要 RGB 颜色');})}));
const enhancementRule=shape<EnhancementRule>({step:count,threshold:count,extra:integer,bonusChance:optional(count)});
const characterStats=shape<CharacterStatsCatalog>({maxLevel:count,statPointsPerLevel:count,skillPointsPerLevel:count,
  grades:optional(array(object({index:integer,name:text,rarity:integer,weight:integer}))),
  experience:array(nullable(count)),classes:record(object(Object.fromEntries(PRIMARY_STATS.map(key=>[key,integer])))),
  modifiers:record(object({label:text,percent:boolean})),
  equipment:record(object({attack:integer,defense:integer,gradeName:text,defaultGrade:optional(integer),defaultRarity:optional(integer),
    gradeVariants:optional(array(object({attack:integer,defense:integer,name:text,rarity:integer,optionCount:integer,socketLimit:integer}))),magicPercent:array(integer),criticalRate:integer,
    hitBonus:number,magicAttackRate:integer,shieldBlock:integer,fixedOptions:array(modifierRange),randomOptions:array(modifierRange),
    optionCount:integer,socketLimit:integer,enhancementUses:array(count),fixedEnhancementUses:nullable(count)})),
  gems:record(array(array(modifierRange))),enchantments:record(record(enhancementRule))});
export function parseCharacterStats(value:unknown):CharacterStatsCatalog {
  characterStats(value,'characterStats');const result=value as CharacterStatsCatalog;
  requireValue(result.experience.length===result.maxLevel,'characterStats.experience','经验表必须覆盖全部等级');
  requireValue(result.experience.at(-1)===null&&result.experience.slice(0,-1).every(x=>x!==null),'characterStats.experience','仅满级可以没有下一级经验');
  const ranges=(values:{stat:string;min:number;max:number}[])=>{
    for(const range of values)requireValue(result.modifiers[range.stat]&&range.min<=range.max,'characterStats','词条类型或数值范围无效');
  };
  for(const equipment of Object.values(result.equipment)){
    requireValue(equipment.defaultGrade===undefined||(equipment.defaultGrade>=0&&equipment.defaultGrade<15),'characterStats.equipment','装备品级超出范围');
    if(equipment.gradeVariants){
      requireValue(equipment.gradeVariants.length===15,'characterStats.equipment','装备品级档位不完整');
      for(const variant of equipment.gradeVariants)requireValue(variant.rarity>=0&&variant.rarity<=4&&variant.optionCount>=0&&variant.socketLimit<=4,'characterStats.equipment','装备品级档位数值无效');
    }
    requireValue(equipment.defaultRarity===undefined||(equipment.defaultRarity>=0&&equipment.defaultRarity<=4),'characterStats.equipment','装备稀有度超出范围');
    requireValue(equipment.magicPercent.length===2&&equipment.magicPercent[0]<=equipment.magicPercent[1]&&equipment.enhancementUses.length===2&&equipment.enhancementUses[0]<=equipment.enhancementUses[1]&&equipment.socketLimit<=4,'characterStats.equipment','装备生成范围无效');
    ranges(equipment.fixedOptions);ranges(equipment.randomOptions);
  }
  for(const levels of Object.values(result.gems)){requireValue(levels.length>0,'characterStats.gems','宝石需要能力等级');for(const options of levels){requireValue(options.length>0,'characterStats.gems','宝石需要候选词条');ranges(options);}}
  return result;
}
export function validateCharacterStats(stats:CharacterStatsCatalog,items:ItemCatalog,battle:BattleCatalog):void {
  for(const character of battle.classes)requireValue(stats.classes[character.id],'characterStats',`职业缺失 ${character.id}`);
  for(const [id,item] of Object.entries(items.items)){
    if(item.equipment)requireValue(stats.equipment[id],'characterStats',`装备缺失 ${id}`);
    if(item.use?.kind==='socket')requireValue(stats.gems[id],'characterStats',`宝石缺失 ${id}`);
  }
  for(const id of Object.keys(stats.equipment))requireValue(items.items[id]?.equipment,'characterStats',`装备引用无效 ${id}`);
  for(const id of Object.keys(stats.gems))requireValue(items.items[id]?.use?.kind==='socket','characterStats',`宝石引用无效 ${id}`);
  for(const [id,kinds] of Object.entries(stats.enchantments)){
    requireValue(items.items[id]?.use?.kind==='enchant','characterStats',`卷轴引用无效 ${id}`);
    for(const kind of Object.keys(kinds))requireValue(Object.values(items.items).some(item=>item.equipment&&item.kind===kind),'characterStats',`装备类型无效 ${kind}`);
  }
}
const companion=shape<CompanionDefinition>({defaultShield:optional(boolean),id:text,name:text,actor:text,classId:text,elite:boolean,source:optional(oneOf('mercenary','story')),
  quality:optional(integer),recruitable:optional(boolean),fixedSkills:optional(array(text))});
const companionGeneration=shape<CompanionGenerationRules>({
  emblems:record(object({classId:nullable(text),qualityWeights:array(integer),guaranteedRare:boolean})),
  training:record(object({classId:text,position:integer,maxLevel:count,requiredLevels:array(count)})),
  skillChoices:array(array(integer)),skillCountWeights:array(array(array(integer))),
  statDice:record(object({ordinary:array(object({sides:count,count:count})),rare:array(object({sides:count,count:count}))})),
  groupPools:record(array(text)),
});
const companionCatalog=shape<CompanionCatalog>({definitions:record(companion),growth:record(array(object(Object.fromEntries(PRIMARY_STATS.map(key=>[key,integer]))))),
  generation:companionGeneration,groupSkills:record(object({id:text,effect:text,name:text,description:text,icon:text,value:integer,
    unit:oneOf('drop-ten-thousandth','milliseconds','percent','flag','per-thousand')})),
  autoSkills:record(object({kind:oneOf('chance','combat-chance','heal','ally-combat','emergency-heal')}))});
export function parseCompanions(value:unknown):CompanionCatalog{
  companionCatalog(value,'companions');return value as CompanionCatalog;
}
export function validateCompanions(catalog:CompanionCatalog,world:WorldIndex,battle:BattleCatalog,stats:CharacterStatsCatalog,campaign?:Campaign):void{
  for(const [id,definition] of Object.entries(catalog.definitions)){
    requireValue(id===definition.id,id,'伙伴标识不一致');
    requireValue(world.actors[definition.actor]?.collision,id,'伙伴缺少可移动外观');
    const character=battle.classes.find(entry=>entry.id===definition.classId);
    requireValue(character,id,'伙伴职业不存在');
    const actor=world.actors[definition.actor];
    for(const clip of ['idle','walk','attack'] as const)for(const direction of ['north','south','east','west'] as const)
      requireValue(actor.clips[`${clip}-${direction}`],id,`伙伴动作缺失：${clip}-${direction}`);
    for(const skillId of character.skills)if(battle.skills[skillId].action)for(const direction of ['north','south','east','west'] as const)
      requireValue(actor.clips[`skill-${skillId}-${direction}`],id,`伙伴技能动作缺失：${skillId}-${direction}`);
    requireValue(catalog.growth[definition.classId]?.length===stats.maxLevel,id,'伙伴成长等级不完整');
    requireValue(definition.quality===undefined||definition.quality<=3,id,'佣兵品质无效');
    for(const skillId of definition.fixedSkills??[])requireValue(catalog.generation.training[skillId]?.classId===definition.classId,id,'固定技能职业不一致');
  }
  for(const [id,skill] of Object.entries(catalog.generation.training)){
    requireValue(battle.classes.find(entry=>entry.id===skill.classId)?.skills.includes(id),id,'佣兵成长技能不存在');
    requireValue(skill.requiredLevels.length===skill.maxLevel&&skill.maxLevel<=battle.skills[id].normalMaxLevel,id,'佣兵技能成长不完整');
    requireValue(skill.requiredLevels.every((level,index)=>index===0||level>skill.requiredLevels[index-1]),id,'佣兵技能成长等级需要递增');
  }
  for(const [id,emblem] of Object.entries(catalog.generation.emblems))requireValue(emblem.qualityWeights.length===4&&emblem.qualityWeights.reduce((sum,value)=>sum+value,0)===100,id,'徽章品质概率需要合计100');
  for(const [classId,pool] of Object.entries(catalog.generation.groupPools)){
    requireValue(pool.length===4&&pool.every(id=>catalog.groupSkills[id]),classId,'佣兵团技能池不完整');
    requireValue(catalog.generation.statDice[classId]?.ordinary.length===5&&catalog.generation.statDice[classId]?.rare.length===5,classId,'佣兵属性骰子不完整');
  }
  if(campaign)for(const script of Object.values(campaign.scripts))for(const action of script.nodes.flatMap(node=>node.commands))
    if(action.type==='party-join'||action.type==='party-leave')
      requireValue(catalog.definitions[action.companion]?.source==='story',action.companion,'剧情伙伴未定义');
}
const storyInterface=shape<StoryInterface>({assets:record(file),portraits:record(file),
  player:object({level:count,health:integer,maxHealth:count,mana:integer,maxMana:count,experience:integer,nextLevelExperience:count})});
export function parseStoryInterface(value:unknown):StoryInterface {
  storyInterface(value,'storyInterface'); const result=value as StoryInterface;
  for(const key of MINIMAP_ASSETS)requireValue(result.assets[key],'storyInterface',`界面素材缺失 ${key}`);
  for(const key of ['edge-horizontal','edge-vertical','corner-nw','corner-ne','corner-sw','corner-se','tab-status','tab-bag','tab-skills','tab-party','tab-quests','tab-system','slot','close','confirm','back','dialogue-edge','menu','save','save-slot','save-empty','quest-popup-window','quest-popup-rule','money-gold','money-silver','money-copper'])
    requireValue(result.assets[key],'storyInterface',`界面素材缺失 ${key}`);
  const p=result.player;
  requireValue(p.health<=p.maxHealth&&p.mana<=p.maxMana&&p.experience<p.nextLevelExperience,'storyInterface.player','当前状态超过上限');
  return result;
}
export function validateStoryItems(campaign:Campaign, content:ItemCatalog):void {
  for(const quest of campaign.quests){
    for(const goal of quest.goals)if(goal.kind==='item'||goal.kind==='recruit')requireValue(content.items[goal.target],quest.id,'任务目标物品不存在');
    for(const item of [...quest.onAcceptItems??[],...quest.handoverItems??[]])requireValue(content.items[item.item],quest.id,'任务收付物品不存在');
    for(const reward of quest.rewards?.items??[]){
      requireValue(!!content.items[reward.item],quest.id,`奖励物品不存在 ${reward.item}`);
      for(const classId of reward.classIds??[])requireValue(!!content.classSkills[classId],quest.id,`奖励职业不存在 ${classId}`);
    }
  }
  for(const enemy of campaign.enemyPlacements??[])
    requireValue(!!content.items[enemy.rewardItem],enemy.id,'任务敌人的奖励物品不存在');
  for(const script of Object.values(campaign.scripts))for(const node of script.nodes)for(const command of node.commands){
    if(command.type==='item-give'||command.type==='item-take'||command.type==='item-drop'||command.type==='equip'||command.type==='unequip-destroy'){
      requireValue(content.items[command.item],node.id,'剧情命令物品不存在');
      if(command.type==='equip')requireValue(content.items[command.item].equipment,node.id,'剧情穿戴物品需要是装备');
    }
  }
}
// 特效层带原版滤镜链与绘制方式，契约版本由 effect-colors.ts 的检查核对。
/**
 * 运算名与绘制方式都从 `effect-colors` 取，不再手抄一份：那边是原版位序的单一来源，
 * 与导出器 `work/tools/game_content/blend.py` 的 `OPERATIONS` 对应。手抄的第二份漏改时，
 * 合法的新数据会被校验拒掉，而错误信息指向数据而不是这份名单。
 */
const effectLayer=shape<EffectLayer>({key:text,file,operations:array(oneOf(...EFFECT_OPERATIONS)),blend:oneOf(...DIRECT_BLENDS,'backdrop')});
const effectClip=shape<EffectClip>({version:integer,frameWidth:positive,frameHeight:positive,frames:positive,originX:number,originY:number,frameRate:positive,mirrorX:boolean,layers:array(effectLayer)});
const itemCatalog=shape<ItemCatalog>({items:record(object({name:text,description:text,descriptionParts:optional(descriptionParts),category:oneOf(...ITEM_CATEGORIES),icon:file,groundSprite:object({file,width:count,height:count,anchorX:integer,anchorY:integer}),
  pickup:optional(object({kind:oneOf('party-mana'),percentOfCollectorMaxMana:positive,hitDrop:object({rollMaximum:count,skillThreshold:count,weaponThresholds:record(integer),jitterPx:integer,directions:array(object({name:text,x:number,y:number,clip:effectClip}))})})),
  kind:text,typeName:text,stackable:boolean,discardable:boolean,sellable:boolean,priceKind:oneOf('weapon','armor','accessory','fixed'),pricePremium:boolean,shortcut:boolean,level:integer,basePrice:integer,storeListed:boolean,
  equipment:optional(object({slot:oneOf(...EQUIPMENT_SLOTS),classes:strings,twoHanded:boolean,dualWield:boolean,locked:boolean,socketCapacity:integer,enchantable:boolean,
    description:optional(object({showEnhancementUses:boolean,attackSpeed:optional(text),classAttributes:descriptionParts}))})),
  use:optional(object({kind:oneOf(...ITEM_USES),recovery:optional(variant('mode',{amount:object({mode:oneOf('amount'),minHealth:count,maxHealth:count,restoresMana:boolean,cooldownMs:count}),rate:object({mode:oneOf('rate'),ratePercent:count,restoresMana:boolean,cooldownMs:count})})),regenerate:optional(object({durationMs:count,healthRecoveryPerPulse:count,manaRecoveryPerPulse:count})),rewards:optional(array(object({item:text,quantity:count}))),classId:optional(text),elite:optional(boolean),recipes:optional(strings),
    target:optional(oneOf('weapon','armor')),maxLevel:optional(integer),requiresEnhanced:optional(boolean)}))})),
  startingEquipment:record(record(text)),startingInventory:array(object({item:text,quantity:count})),startingShortcut:text,
  dualWieldClasses:strings,merchantItems:strings,classSkills:record(strings),skillDescriptions:optional(record(object({name:text,className:text}))),recipes:record(object({name:text,result:text,materials:array(object({item:text,quantity:count})),cost:count,book:boolean}))});
export function parseItemCatalog(value:unknown):ItemCatalog {
  itemCatalog(value,'items');const result=value as ItemCatalog;
  const classes=Object.keys(result.startingEquipment);
  requireValue(classes.length===6,'items.startingEquipment','需要六个职业');
  for(const [id,item]of Object.entries(result.items)) {
    requireValue(!!item.equipment===(item.category==='equipment'),id,'装备分类与穿戴规则不一致');
    if(item.equipment){requireValue(!item.stackable,id,'装备按实例存放');for(const key of item.equipment.classes)requireValue(classes.includes(key),id,'职业引用不存在');}
    if(item.pickup){
      requireValue(!item.use&&!item.equipment&&!item.shortcut&&!item.discardable&&!item.storeListed,id,'拾取恢复物不进入背包或货架');
      requireValue(item.pickup.hitDrop.directions.length===4,id,'掉落动画需要四个方向');
      for(const direction of item.pickup.hitDrop.directions)requireValue(!effectProblems({drop:{clips:{[direction.name]:direction.clip}}}).length,id,'掉落动画格式无效');
    }
    const use=item.use;
    requireValue((use?.kind==='recover-health')===!!use?.recovery,id,'恢复药水需要回复量与冷却定义');
    requireValue((use?.kind==='regenerate')===!!use?.regenerate,id,'持续回复需要时长与每脉冲回复量定义');
    if(use?.recovery){
      const recovery=use.recovery;
      requireValue(recovery.cooldownMs%60===0,id,'药水冷却不是逻辑帧的整数倍');
      if(recovery.mode==='amount')requireValue(recovery.maxHealth>=recovery.minHealth,id,'药水回复范围无效');
      else requireValue(recovery.ratePercent>0&&recovery.ratePercent<=100,id,'药水回复比例无效');
    }
    if(use?.classId)requireValue(classes.includes(use.classId),id,'使用职业不存在');
    if(use&&['pack','box','unseal'].includes(use.kind))requireValue(use.rewards?.length,id,'缺少物品产物');
    for(const recipe of use?.recipes??[])requireValue(result.recipes[recipe],id,'配方不存在');
    if(use?.kind==='recipe')requireValue(use.recipes?.length,id,'缺少配方候选');
    if(use?.kind==='enchant')requireValue(use.target,id,'缺少强化目标类型');
    for(const reward of use?.rewards??[])requireValue(result.items[reward.item],id,'产物物品不存在');
  }
  for(const [id,slots]of Object.entries(result.startingEquipment))for(const [slot,item]of Object.entries(slots)) {
    requireValue(EQUIPMENT_SLOTS.includes(slot as typeof EQUIPMENT_SLOTS[number]),id,'装备槽不存在');
    const definition=result.items[item!];
    requireValue(definition?.equipment?.slot===slot&&definition.equipment.classes.includes(id),id,'初始装备不符合职业或位置');
  }
  requireValue(result.startingInventory.length>0,'items.startingInventory','需要初始背包物品');
  const starterIds=new Set<string>();
  for(const entry of result.startingInventory){
    requireValue(result.items[entry.item]&&!result.items[entry.item].pickup,'items.startingInventory',`初始物品不存在 ${entry.item}`);
    requireValue(!starterIds.has(entry.item),'items.startingInventory',`初始物品重复 ${entry.item}`);
    starterIds.add(entry.item);
  }
  requireValue(starterIds.has(result.startingShortcut)&&result.items[result.startingShortcut].shortcut,
    'items.startingShortcut','初始快捷物品必须在背包且可用');
  for(const id of classes)requireValue(result.classSkills[id]?.length,id,'缺少职业技能');
  for(const [id,recipe] of Object.entries(result.recipes)){
    requireValue(recipe.cost>0,id,'配方费用必须大于零');
    for(const item of [recipe.result,...recipe.materials.map(m=>m.item)])requireValue(result.items[item],'items.recipes','配方物品不存在');
  }
  for(const id of result.dualWieldClasses)requireValue(classes.includes(id),id,'双持职业不存在');
  for(const id of result.merchantItems)requireValue(result.items[id],id,'商人物品不存在');
  return result;
}
const shopRule:Check=(v,p)=>{
  requireValue(v&&typeof v==='object',p,'需要货架规则');
  const kind=(v as {kind?:string}).kind;
  if(kind==='level-range')object({kind:oneOf('level-range'),minimumLevel:integer,maximumLevel:integer,category:oneOf('weapons','armor')})(v,p);
  else if(kind==='random-stock')object({kind:oneOf('random-stock'),attempts:count,levelRadius:integer,profile:oneOf('black-market','lamp')})(v,p);
  else object({kind:oneOf('rare-equipment'),attempts:count})(v,p);
};
const nullableItem:Check=(v,p)=>{if(v!==null)text(v,p);};
const shopPool=shape<WeightedItem>({weight:integer,item:optional(nullableItem),tiers:optional(array(object({item:nullableItem,level:integer})))});
interface ShopEquipmentDraft {
  defaultGrade:number;randomGrade:boolean;dropLevel:number;randomGroup:'weapon'|'armor'|'accessory'|'none';
  randomListed:boolean;uniqueListed:boolean;
  variants?:{attack:number;defense:number;gradeName:string;optionCount:number;socketLimit:number}[];
  concealedPrices:number[];
}
const shopEquipmentEntry=shape<ShopEquipmentDraft>({defaultGrade:integer,randomGrade:boolean,dropLevel:number,randomGroup:oneOf('weapon','armor','accessory','none'),randomListed:boolean,uniqueListed:boolean,
  variants:optional(array(object({attack:integer,defense:integer,gradeName:text,optionCount:integer,socketLimit:integer}))),concealedPrices:array(integer)});
const shopEquipment=record(shopEquipmentEntry);
const shops=shape<ShopCatalog>({shops:record(object({name:text,priceRatePercent:count,fixedStock:strings,categories:strings,stockRules:array(shopRule)})),
  lampShop:text,mapShopLevels:record(integer),categories:record(object({name:text,group:oneOf('weapons','armor')})),assets:record(file),
  profiles:record(object({pools:record(array(shopPool)),chances:object({generic:integer,equipment:integer,consumable:integer,upgrade:integer,crafting:integer,misc:integer}),uniqueChanceByLevel:array(integer)})),
  equipment:optional(shopEquipment),
  grades:array(object({name:text,armorName:optional(text),rarity:integer,weight:integer})),rarityWeights:object({ordinary:array(integer),rare:array(integer)})});
export function parseShops(value:unknown):ShopCatalog {
  shops(value,'shops');const result=value as ShopCatalog;
  // 生产构建把大型装备表拆到 shops-equipment.json，运行时按需合并；dev 源文件完整。
  result.equipment ??= {};
  requireValue(Object.keys(result.shops).length===18,'shops','需要 18 个商店 NPC');
  requireValue(result.shops[result.lampShop],'shops.lampShop','缺少神灯商人');
  requireValue(result.grades.length===15&&result.rarityWeights.ordinary.length===5&&result.rarityWeights.rare.length===5,'shops','品质规则不完整');
  for(const [id,shop]of Object.entries(result.shops)) {
    requireValue(shop.priceRatePercent>0&&shop.priceRatePercent<=300,id,'商人价格倍率无效');
    for(const category of shop.categories)requireValue(result.categories[category]&&result.assets[category]&&result.assets[`${category}-selected`],id,'分类或分类图片不存在');
    for(const rule of shop.stockRules){
      if(rule.kind==='level-range')requireValue(rule.minimumLevel<=rule.maximumLevel,id,'等级范围无效');
      if(rule.kind==='random-stock')requireValue(result.profiles[rule.profile],id,'随机商品规则不存在');
    }
  }
  for(const [id,equipment]of Object.entries(result.equipment))requireValue(equipment.variants.length===15&&equipment.defaultGrade<15&&equipment.concealedPrices.length===128,id,'装备品质或报价不完整');
  for(const profile of Object.values(result.profiles)){
    requireValue(profile.uniqueChanceByLevel.length===128,'shops.profiles','珍稀物品概率不完整');
    for(const category of ['generic','consumable','upgrade','crafting','misc'])requireValue(profile.pools[category],'shops.profiles','随机物品池缺失');
    for(const pool of Object.values(profile.pools))requireValue(pool.reduce((total,entry)=>total+entry.weight,0)<=10000,'shops.profiles','权重超过概率基数');
  }
  for(const key of ['slot','selection','gold','silver','copper','merchant-title'])requireValue(result.assets[key],'shops.assets',`缺少素材 ${key}`);
  return result;
}
const shopEquipmentFile=shape<{equipment:Record<string,ShopEquipmentDraft>}>({equipment:shopEquipment});
/** 生产内容包把 shops.equipment 拆到独立文件；解析后即可合并回 ShopCatalog。 */
export function parseShopEquipment(value:unknown,stats?:CharacterStatsCatalog):ShopCatalog['equipment'] {
  shopEquipmentFile(value,'shops-equipment');
  const result=value as {equipment:Record<string,ShopEquipmentDraft>};
  for(const [id,equipment]of Object.entries(result.equipment)){
    if(!equipment.variants){
      const variants=stats?.equipment[id]?.gradeVariants;
      requireValue(variants?.length===15,id,'装备品级需要 character-stats 派生');
      equipment.variants=variants.map(variant=>({attack:variant.attack,defense:variant.defense,
        gradeName:variant.name,optionCount:variant.optionCount,socketLimit:variant.socketLimit}));
    }
    requireValue(equipment.variants.length===15&&equipment.defaultGrade<15&&equipment.concealedPrices.length===128,id,'装备品质或报价不完整');
  }
  return result.equipment as ShopCatalog['equipment'];
}

export function validateShops(shops:ShopCatalog, items:ItemCatalog, world:WorldIndex):void {
  for(const [id,shop]of Object.entries(shops.shops)) {
    requireValue(id===shops.lampShop||world.actors[id],id,'商店人物不存在');
    for(const item of shop.fixedStock)requireValue(items.items[item]&&!items.items[item].pickup,id,`固定商品不存在 ${item}`);
  }
  for(const profile of Object.values(shops.profiles))for(const pool of Object.values(profile.pools))for(const choice of pool)
    for(const item of choice.tiers?.map(tier=>tier.item)??[choice.item])if(item)requireValue(items.items[item],'shops.profiles',`随机商品不存在 ${item}`);
  for(const id of Object.keys(shops.equipment))requireValue(items.items[id]?.equipment,id,'随机装备不存在');
  for(const map of world.maps)requireValue(shops.mapShopLevels[map.id]!==undefined,map.id,'地图商品等级不存在');
}
export function validateItemSkills(items:ItemCatalog,battle:BattleCatalog):void {
  requireValue(Object.keys(items.classSkills).length===battle.classes.length,'items.classSkills','职业数量不匹配');
  for(const character of battle.classes)requireValue(JSON.stringify(items.classSkills[character.id])===JSON.stringify(character.skills),character.id,'物品技能候选与职业不匹配');
}
const wardrobe=shape<WardrobeCatalog>({defaultShield:optional(boolean),companions:optional(record(object({variants:record(text),fixedParts:array(text)}))),textures:array(object({key:text,file})),sprites:record(object({texture:text,x:integer,y:integer,width:count,height:count,anchorX:number,anchorY:number})),
  variants:record(array(nullable(text))),defaults:record(text),equipment:record(object({main:record(text),offHand:record(text)})),
  poses:record(object({mirrorX:boolean,frameRate:positive,frames:array(array(object({part:text,piece:integer,x:number,y:number,scaleX:number,scaleY:number,angle:number,alpha:number})))})),
  stances:record(record(text)),skills:record(record(text)),attacks:(value,path)=>record(basicAttack)(value,path),dualWieldAttacks:optional((value,path)=>record(boundBasicAttack)(value,path)),
  frenzyAttacks:optional((value,path)=>record(boundBasicAttack)(value,path)),
  frenzyWaitFrames:optional(record(count)),
  skillStances:(value,path)=>record(record(object({poses:record(text),actions:record(nullable(skillAction))})))(value,path)});
export function parseWardrobe(value:unknown):WardrobeCatalog {
  wardrobe(value,'wardrobe');const result=value as WardrobeCatalog;
  const textures=new Set(result.textures.map(texture=>texture.key));
  for(const sprite of Object.values(result.sprites))requireValue(textures.has(sprite.texture),'wardrobe.sprites','部件纹理不存在');
  for(const pieces of Object.values(result.variants))for(const piece of pieces)if(piece)requireValue(result.sprites[piece],'wardrobe.variants','部件不存在');
  for(const variants of [result.defaults,...Object.values(result.companions??{}).map(companion=>companion.variants),...Object.values(result.equipment).flatMap(entry=>[entry.main,entry.offHand])])
    for(const variant of Object.values(variants))requireValue(result.variants[variant],'wardrobe.equipment','服装样式不存在');
  for(const stance of [...Object.values(result.stances),...Object.values(result.skills)])for(const pose of Object.values(stance))requireValue(result.poses[pose!],'wardrobe.stances','动作不存在');
  for(const id of Object.keys(result.stances))requireValue(result.attacks[id],'wardrobe.attacks','普攻规则缺失');
  for(const [id,attack]of Object.entries(result.dualWieldAttacks??{})){
    requireValue(result.stances[id],'wardrobe.dualWieldAttacks','武器动作不存在');
    requireValue(attack.strikes?.length===2&&attack.strikes[0].hand==='main-hand'&&attack.strikes[1].hand==='offhand'&&attack.strikes[0].frame===attack.strikeFrame&&attack.strikes[1].frame>attack.strikeFrame,'wardrobe.dualWieldAttacks','双持出手顺序无效');
    for(const facing of ['north','south','east','west'] as const)requireValue(result.stances[id][attack.clips[facing]],'wardrobe.dualWieldAttacks','双持人物动作缺失');
  }
  for(const [id,attack]of Object.entries(result.frenzyAttacks??{})){
    requireValue(result.stances[id],'wardrobe.frenzyAttacks','武器动作不存在');
    requireValue(attack.timing==='fixed-animation'&&attack.targeting?.target==='area','wardrobe.frenzyAttacks','范围普攻需要固定动画与范围目标');
    for(const facing of ['north','south','east','west'] as const){
      const poseId=result.stances[id][attack.clips[facing]],pose=poseId?result.poses[poseId]:undefined;
      requireValue(pose?.frames.length===attack.cycleFrames,'wardrobe.frenzyAttacks','范围普攻人物动作缺失或帧数不匹配');
    }
  }
  for(const id of Object.keys(result.frenzyWaitFrames??{})){
    requireValue(result.stances[id],'wardrobe.frenzyWaitFrames','武器动作不存在');
    requireValue(!result.frenzyAttacks?.[id],'wardrobe.frenzyWaitFrames','同一装备组合只能声明范围普攻或无动画等待');
  }
  for(const stances of Object.values(result.skillStances))for(const [id,stance]of Object.entries(stances)){
    requireValue(result.stances[id],'wardrobe.skillStances','武器动作不存在');
    for(const pose of Object.values(stance.poses))requireValue(result.poses[pose!],'wardrobe.skillStances','技能动作不存在');
  }
  for(const pose of Object.values(result.poses)) {
    requireValue(pose.frames.length,'wardrobe.poses','动作不能为空');
    for(const frame of pose.frames)for(const part of frame)requireValue(part.scaleX!==0&&part.scaleY!==0&&part.alpha>=0&&part.alpha<=1,'wardrobe.poses','部件变换无效');
  }
  return result;
}
export function validateWardrobe(wardrobe:WardrobeCatalog,items:ItemCatalog,battle?:BattleCatalog):void {
  for(const [id,item]of Object.entries(items.items))if(item.equipment)requireValue(wardrobe.equipment[id],id,'缺少装备外观');
  const required=new Map<string,number>();
  for(const pose of Object.values(wardrobe.poses))for(const frame of pose.frames)for(const part of frame)
    required.set(part.part,Math.max(required.get(part.part)??0,part.piece+1));
  for(const [id,appearance]of Object.entries(wardrobe.equipment)) {
    requireValue(items.items[id]?.equipment,id,'外观引用的装备不存在');
    for(const [part,variant]of Object.entries({...appearance.main,...appearance.offHand}))
      requireValue(wardrobe.variants[variant].length>=(required.get(part)??0),id,'动作部件超出服装样式');
  }
  if(battle){
    for(const id of Object.keys(wardrobe.skillStances))requireValue(battle.classes.some(c=>c.id===id),'wardrobe.skillStances','职业不存在');
    for(const character of battle.classes)for(const id of character.skills)if(battle.skills[id].action)
      for(const facing of ['north','south','east','west'] as const){
        const key=`skill-${id}-${facing}` as const,pose=wardrobe.skills[character.id]?.[key];
        requireValue(pose&&wardrobe.poses[pose]?.frames.length===character.actor.clips[key]?.frames,'wardrobe.skills',`技能动画缺失或时长不匹配 ${key}`);
      }
    for(const attack of [...Object.values(wardrobe.attacks),...Object.values(wardrobe.dualWieldAttacks??{}),...Object.values(wardrobe.frenzyAttacks??{})])for(const effect of [...attack.swings,...attack.impacts,...attack.projectile?[attack.projectile.effect]:[]])
      requireValue(battle.attackEffects[effect],'wardrobe.attacks',`普攻特效缺失 ${effect}`);
    parseBattle(battle,wardrobe);
  }
}
export function validateStoryPortraits(world:WorldIndex, content:StoryInterface):void {
  for(const key of Object.keys(world.portraits))requireValue(content.portraits[key],`storyInterface.portraits.${key}`,'缺少触屏版立绘');
}
const menuPanels=shape<MenuPanels>({itemMessages:record(text),assets:record(file),equipmentSlots:array(object({id:text,name:text,x:number,y:number,emptyIcon:file})),
  skillPositions:array(object({column:integer,row:integer})),skillColumns:array(object({label:text,image:file})),
  classes:record(object({preview:file})),
  character:object({portraits:record(object({image:file,partyIcon:file})),combatLabels:strings,
    labels:object({statPoints:text,skillPoints:text,health:text,mana:text,experience:text})}),
  skillPanel:object({labels:object({counterattackTitle:text,initialSkillPoints:text,resetButton:text})})});
export function parseMenuPanels(value:unknown):MenuPanels {
  menuPanels(value,'menuPanels'); const result=value as MenuPanels;
  for(const key of [...ITEM_NOTICES,'craft-incompatible','craft-needs-chaos','craft-epic','craft-max','craft-money','craft-materials','craft-target','craft-confirm'])
    requireValue(result.itemMessages[key]?.trim(),'menuPanels.itemMessages',`缺少装备加工提示 ${key}`);
  for(const key of ['edge-horizontal','edge-vertical','corner-nw','corner-ne','corner-sw','corner-se','page-button-frame','page-button-selected','text-plate-left','text-plate-right','inventory-slot','inventory-selected','craft-button','craft-button-pressed','craft-button-disabled','craft-money-gold','craft-money-silver','craft-money-copper','message-edge','message-ok','message-ok-pressed','message-yes','message-yes-pressed','message-no','message-no-pressed','close','confirm','back','menu-back','menu-back-pressed',...CHARACTER_ASSETS,...ITEM_ACTION_ASSETS,...SKILL_ASSETS,...SKILL_AI_ASSETS,...QUEST_ASSETS,...PARTY_ASSETS])
    requireValue(result.assets[key],'menuPanels.assets',`缺少菜单素材 ${key}`);
  requireValue(result.character.portraits.kiyan,'menuPanels.character.portraits','缺少主角属性页立绘');
  requireValue(result.character.combatLabels.length===11&&new Set(result.character.combatLabels).size===11&&result.character.combatLabels.every(label=>label.trim()),
    'menuPanels.character.combatLabels','需要十一个独立战斗属性');
  const slots=new Set(result.equipmentSlots.map(slot=>slot.id));
  requireValue(result.skillColumns.length===3&&new Set(result.skillColumns.map(column=>column.label)).size===3&&result.skillColumns.every(column=>column.label.trim()),
    'menuPanels.skillColumns','需要三个独立技能列标题');
  requireValue(slots.size===10&&result.equipmentSlots.length===10&&EQUIPMENT_SLOTS.every(slot=>slots.has(slot)),'menuPanels.equipmentSlots','需要十个独立装备槽');
  requireValue(result.equipmentSlots.every((slot,index)=>slot.id===EQUIPMENT_SLOT_ORDER[index]),'menuPanels.equipmentSlots','装备槽顺序与界面次序不一致');
  requireValue(result.skillPanel.labels.counterattackTitle.trim()&&result.skillPanel.labels.initialSkillPoints.trim()&&result.skillPanel.labels.resetButton.trim(),
    'menuPanels.skillPanel.labels','需要设置页的自动反击标题、初始技能点与初始化按钮文案');
  requireValue(result.skillPositions.length===15&&new Set(result.skillPositions.map(p=>`${p.column},${p.row}`)).size===15,'menuPanels.skillPositions','需要十五个独立技能位置');
  for(const p of result.skillPositions)requireValue(p.column<3&&p.row<6,'menuPanels.skillPositions','技能位置超出排列范围');
  return result;
}
export function validateMenuClasses(menu:MenuPanels,catalog:BattleCatalog):void {
  requireValue(Object.keys(menu.classes).length===catalog.classes.length,'menuPanels.classes','职业数量不匹配');
  for(const c of catalog.classes)requireValue(menu.classes[c.id]&&c.skills.length===menu.skillPositions.length,c.id,'缺少职业菜单资料或技能排列不匹配');
}
const box={x:number,y:number,width:positive,height:positive};
const clip=shape<AnimationClip>({frameWidth:positive,frameHeight:positive,frames:positive,originX:number,originY:number,frameRate:positive,mirrorX:boolean,layers:array(object({key:text,file,blend:oneOf('normal','screen','add','multiply','color-dodge')}))});
const actor=shape<ActorDefinition>({chest:optional(oneOf('ordinary','improved')),service:optional(oneOf('soul-healer','fusion-machine','legendary-sword','innkeeper')),id:text,name:text,description:text,clips:record(clip),portrait:nullable(text),collision:optional(object(box)),effectAnchor:optional(object({x:number,y:number})),headAnchor:optional(object({x:number,y:number}))});
const storyClasses=shape<StoryClassCatalog>({defaultClass:text,background:file,
  assets:object({selected:file,title:file,start:file,startPressed:file,descriptionTop:file,attributesTop:file,panelLeft:file,panelRight:file}),
  classes:array(object({id:text,name:text,description:text,icon:file,attributes:array(object({name:text,value:integer})),
    previewActor:actor,playerActor:actor,player:object({level:count,health:integer,maxHealth:count,mana:integer,maxMana:count,experience:integer,nextLevelExperience:count})}))});
export function parseStoryClasses(value:unknown):StoryClassCatalog {
  storyClasses(value,'storyClasses'); const result=value as StoryClassCatalog;
  requireValue(result.classes.length===6&&new Set(result.classes.map(c=>c.id)).size===6,'storyClasses','需要六个不同职业');
  requireValue(result.classes.some(c=>c.id===result.defaultClass),'storyClasses.defaultClass','默认职业不存在');
  for(const entry of result.classes){
    requireValue(entry.playerActor.headAnchor,entry.id,'头顶状态条需要人物头部锚点');
    requireValue(entry.previewActor.clips['idle-south'],'storyClasses.'+entry.id,'缺少预览待机动画');
    for(const pose of ['idle','walk','attack'])for(const direction of ['south','west','north','east'])
      requireValue(entry.playerActor.clips[`${pose}-${direction}` as keyof ActorDefinition['clips']],entry.id,`缺少 ${pose}-${direction}`);
    requireValue(entry.attributes.length===5,entry.id,'需要五项基础属性');
    const p=entry.player;
    requireValue(p.health<=p.maxHealth&&p.mana<=p.maxMana&&p.experience<p.nextLevelExperience,entry.id,'当前状态超过上限');
  }
  return result;
}
const storyCondition:Check=(v,p)=>{
  requireValue(v&&typeof v==='object'&&!Array.isArray(v),p,'需要剧情条件');
  const type=(v as {type:string}).type;
  const checks:Record<string,Check>={
    always:object({type:oneOf('always'),value:boolean}),
    all:object({type:oneOf('all'),conditions:array(storyCondition)}),any:object({type:oneOf('any'),conditions:array(storyCondition)}),
    not:object({type:oneOf('not'),condition:storyCondition}),
    quest:object({type:oneOf('quest'),quest:text,status:oneOf('locked','available','active','ready','completed','accepted','settled')}),
    event:object({type:oneOf('event'),event:text,status:oneOf('idle','running','waiting','completed')}),
    choice:object({type:oneOf('choice'),choice:text,value:text}),flag:object({type:oneOf('flag'),flag:text,value:optional(boolean)}),
    world:object({type:oneOf('world'),key:text,value:(value,path)=>requireValue(typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value),path,'世界条件值无效')})
  };
  requireValue(checks[type],p,'未定义剧情条件');checks[type](v,p);
};
const visibility={id:text,condition:optional(storyCondition)};
const entity={...visibility,actor:text,characterId:optional(text),authority:optional(oneOf('registered','npc','story','static')),x:number,y:number,flip:optional(boolean),name:optional(text),hint:optional(text),objective:optional(text),collectible:optional(boolean),afterInteractScript:optional(text),
  appear:optional(object({atMost:diceFace})),downgrade:optional(object({atLeast:diceFace,actor:text})),spring:optional(boolean)};
const enemySpawn={respawn:optional((v,p)=>requireValue(v===false,p,'一次性敌人不可刷新')),id:text,enemyId:text,x:number,y:number,tierLevel:optional(count),breakableEligible:optional(boolean)};
const campaignEnemy={...enemySpawn,map:text,activeQuest:text,rewardItem:text,respawn:(value:unknown,path:string)=>requireValue(value===false,path,'任务敌人不可刷新')};
const world=shape<WorldIndex>({storyEffects:optional(record(object({clips:record(effectClip),placement:optional(oneOf('ground','above-characters'))}))),version:integer,maps:array(object({id:text,name:text,file})),actors:record(actor),portraits:record(object({file,width:positive,height:positive})),props:array(object({key:text,file}))});
const map=shape<WorldMap>({lootLevel:optional(integer),chestLevel:optional(integer),chestLevelSource:optional(oneOf('native','neighbor','floor','override')),id:text,name:text,width:positive,height:positive,tileSize:positive,columns:positive,rows:positive,blocked:array(boolean),water:optional(array(integer)),ground:file,canopy:file,
  features:array(object({texture:text,x:number,y:number,offsetX:number,offsetY:number,width:positive,flip:boolean,blend:oneOf('normal','screen','add','multiply','color-dodge')})),entities:array(object(entity)),enemySpawns:optional(array(object(enemySpawn))),breakableSpawn:optional(oneOf('bush','jar')),
  questItemSpawns:optional(array(object({id:text,quest:text,item:text,x:number,y:number,respawnFrames:count}))),
  exits:array(object({...box,id:optional(text),destination:text,spawn:object({x:number,y:number}),exitFacing,facing:exitFacing}))});
const line={speaker:text,text,actor:nullable(text),portrait:optional(nullable(text)),presentation:optional(oneOf('screen'))};
const dialogue=shape<DialogueAction>({...line,type:oneOf('dialogue')});
const choice:Check=(v,p)=>{object({type:oneOf('choice'),prompt:text,description:optional(text),options:array(object({label:text,value:text,lines:optional(array(object(line)))}))})(v,p);requireValue((v as {options:unknown[]}).options.length,p,'选项不能为空');};
const nonnegative:Check=(v,p)=>{number(v,p);requireValue((v as number)>=0,p,'需要非负数');};
const member=shape<StoryCastMember>({id:text,actor:text,characterId:optional(text),enemyId:optional(text),memberId:optional(text),binding:optional(oneOf('world')),worldEntityId:optional(text),inheritPosition:optional(boolean),unpositioned:optional(boolean),x:number,y:number,facing,visible:boolean});
const performanceChecks:Record<string,Check>={
  'instant-message':object({type:oneOf('instant-message'),text}),
  stage:object({type:oneOf('stage'),mapFromWorld:optional(boolean),resetActors:optional(boolean),map:text,x:number,y:number,facing,playerVisible:boolean,retainPlayerPosition:optional(boolean),cast:array(member),
    camera:optional(object({x:number,y:number})),curtain:optional(object({opacity:(v,p)=>{nonnegative(v,p);requireValue((v as number)<=1,p,'透明度不得大于一');},color:integer})),
    audio:optional(object({music:nullable(text),ambience:nullable(text)}))}),
  appear:object({type:oneOf('appear'),target:text,x:number,y:number,facing,mode:optional(oneOf('reuse','create')),worldEntityId:optional(text)}),
  'world-object':object({type:oneOf('world-object'),target:optional(text),mode:optional(oneOf('reuse','create')),command:(v,p)=>{
    worldCommand(v,p);requireValue(['place','show','hide','remove','remove-character'].includes((v as {kind:string}).kind),p,'需要场景物件命令');
  }}),
  show:object({type:oneOf('show'),target:text}),
  leave:object({type:oneOf('leave'),target:text}),
  walk:object({type:oneOf('walk'),target:text,x:number,y:number,speedPxPerSecond:positive,followCamera:optional(boolean),ensure:optional(boolean)}),
  face:object({type:oneOf('face'),target:text,facing,ensure:optional(boolean)}),
  pose:object({type:oneOf('pose'),target:text,pose:oneOf('idle','attack',...STORY_POSE_NAMES),durationMs:nonnegative,hold:optional(boolean)}),
  effect:object({type:oneOf('effect'),target:text,effect:text}),
  'location-effect':object({type:oneOf('location-effect'),effect:text,x:number,y:number}),
  'map-effect':object({type:oneOf('map-effect'),enabled:boolean}),
  sound:object({type:oneOf('sound'),sound:text}),
  music:object({type:oneOf('music'),sound:nullable(text)}),
  'refresh-appearance':object({type:oneOf('refresh-appearance')}),
  'stop-audio':object({type:oneOf('stop-audio')}),
  camera:object({type:oneOf('camera'),target:text,motion:oneOf('cut','pan')}),
  'camera-point':object({type:oneOf('camera-point'),x:number,y:number,motion:oneOf('cut','pan')}),
  fade:object({type:oneOf('fade'),opacity:(v,p)=>{nonnegative(v,p);requireValue((v as number)<=1,p,'透明度不得大于一');},color:integer,durationMs:nonnegative}),
  wait:object({type:oneOf('wait'),durationMs:nonnegative}),
  parallel:(v,p)=>{
    object({type:oneOf('parallel'),actions:array((child,path)=>{
      performance(child,path);requireValue((child as PerformanceAction).type!=='stage',path,'切图必须串行');
    })})(v,p);
    const targets=performanceTargets(v as PerformanceAction);
    requireValue(targets.length===new Set(targets).size,p,'并行动作重复控制同一个人物或镜头');
  }
};
const performance:Check=(v,p)=>{
  requireValue(v&&typeof v==='object',p,'需要演出动作');const check=performanceChecks[(v as {type:string}).type];
  requireValue(check,p,'未定义演出动作');check(v,p);
};
const partyAction=object({type:oneOf('party-join','party-leave'),companion:text});
const action:Check=(v,p)=>{
  requireValue(v&&typeof v==='object',p,'需要剧情动作');
  const kind=(v as {type:string}).type;
  (kind==='dialogue'?dialogue:kind==='choice'?choice:kind==='party-join'||kind==='party-leave'?partyAction:performance)(v,p);
};
const destination=object({map:text,x:number,y:number,facing});
const questFact=shape<QuestFact>({kind:oneOf('talk','interact','defeat','recruit'),target:text,characterId:optional(text),quantity:optional(count),occurrence:object({source:text,sequence:count})});
const questCommand:Check=(v,p)=>{
  requireValue(v&&typeof v==='object',p,'需要任务命令');const type=(v as {type:string}).type;
  if(type==='refresh')object({type:oneOf('refresh')})(v,p);
  else if(type==='fact')object({type:oneOf('fact'),fact:questFact})(v,p);
  else if(type==='reset-side-quests')object({type:oneOf('reset-side-quests')})(v,p);
  else object({type:oneOf('accept','complete','script-ready','script-complete','reset'),quest:text,cycle:optional(integer),...(type==='accept'?{source:optional(oneOf('interaction','script'))}:{})})(v,p);
};
const encounter=shape<StoryEncounter>({id:text,definitionId:optional(text),map:text,mapFromStage:optional(boolean),status:oneOf('prepared','active','won','lost'),spawns:array(object({id:text,enemyId:text,x:number,y:number}))});
const worldCommand:Check=(v,p)=>{
  requireValue(v&&typeof v==='object',p,'需要世界命令');const kind=(v as {kind:string}).kind;
  const checks:Record<string,Check>={
    place:object({kind:oneOf('place'),scope:optional(oneOf('visit')),mapFromStage:optional(boolean),entity:object({id:text,map:text,actor:text,characterId:optional(text),authority:optional(oneOf('registered','npc','story','static')),x:number,y:number,facing:optional(facing),visible:optional(boolean),removed:optional(boolean),hint:optional(text)})}),
    show:object({kind:oneOf('show'),id:text}),hide:object({kind:oneOf('hide'),id:text}),remove:object({kind:oneOf('remove'),id:text}),
    'remove-character':object({kind:oneOf('remove-character'),characterId:text,map:text,mapFromStage:optional(boolean),all:boolean}),
    'actor-visibility':object({kind:oneOf('actor-visibility'),map:text,actor:text,characterId:optional(text),visible:boolean}),
    'enemy-availability':object({kind:oneOf('enemy-availability'),map:text,enemyId:text,available:boolean}),
    exit:object({kind:oneOf('exit'),id:text,enabled:boolean}),flag:object({kind:oneOf('flag'),id:text,value:boolean}),choice:object({kind:oneOf('choice'),id:text,value:text}),
    'remove-enemy':object({kind:oneOf('remove-enemy'),enemyId:text,map:optional(text),all:boolean}),
    'enemy-location':object({kind:oneOf('enemy-location'),enemyId:text,location:nullable(object({map:text,x:number,y:number})),scope:optional(oneOf('visit')),respawn:optional((value,path)=>requireValue(value===false,path,'剧情敌人不可刷新')),mapFromStage:optional(boolean)}),
    'actor-appearance':object({kind:oneOf('actor-appearance'),actor:text,appearance:text}),
    'party-buff':object({kind:oneOf('party-buff'),buff:oneOf(...BATTLE_BUFF_KEYS),strength:integer}),
    travel:object({kind:oneOf('travel'),destination}),encounter:object({kind:oneOf('encounter'),encounter}),
    'encounter-result':object({kind:oneOf('encounter-result'),id:text,result:oneOf('won','lost')})
  };requireValue(checks[kind],p,'未定义世界命令');checks[kind](v,p);
};
const storyCommand:Check=(v,p)=>{
  requireValue(v&&typeof v==='object',p,'需要游戏命令');const type=(v as {type:string}).type;
  const checks:Record<string,Check>={
    talk:object({type:oneOf('talk'),target:text}),
    interaction:object({type:oneOf('interaction'),target:text,instance:text}),
    quest:object({type:oneOf('quest'),command:questCommand}),
    'item-give':object({type:oneOf('item-give'),item:text,quantity:count}),'item-take':object({type:oneOf('item-take'),item:text,quantity:count,allowPartial:optional(boolean)}),
    'item-drop':object({type:oneOf('item-drop'),item:text,quantity:count,map:optional(text),x:number,y:number}),
    'money-give':object({type:oneOf('money-give'),amount:count}),'money-take':object({type:oneOf('money-take'),amount:count,allowPartial:optional(boolean)}),
    flag:object({type:oneOf('flag'),flag:text,value:optional(boolean)}),choice:object({type:oneOf('choice'),choice:text,value:text}),
    'party-join':partyAction,'party-leave':partyAction,
    health:object({type:oneOf('health'),member:text,value:(v,p)=>{if(v!=='full')integer(v,p);}}),
    mana:object({type:oneOf('mana'),member:text,value:(v,p)=>{if(v!=='full')integer(v,p);}}),
    'party-control':object({type:oneOf('party-control'),member:text}),
    equip:object({type:oneOf('equip'),member:text,item:text,slot:oneOf(...EQUIPMENT_SLOTS),create:optional(boolean),ifPresent:optional(boolean)}),
    'unequip-destroy':object({type:oneOf('unequip-destroy'),member:text,item:text,ifPresent:optional(boolean)}),
    world:object({type:oneOf('world'),command:worldCommand}),travel:object({type:oneOf('travel'),destination}),
    encounter:object({type:oneOf('encounter'),encounter})
  };requireValue(checks[type],p,'未定义游戏命令');checks[type](v,p);
};
const nodeRef=shape<StoryNodeRef>({script:text,node:text});
const nodeExit:Check=(v,p)=>{
  requireValue(v&&typeof v==='object',p,'需要节点出口');const type=(v as {type:string}).type;
  const checks:Record<string,Check>={
    next:object({type:oneOf('next'),target:nodeRef}),branch:object({type:oneOf('branch'),condition:storyCondition,then:nodeRef,otherwise:nodeRef}),
    call:object({type:oneOf('call'),target:nodeRef,then:nodeRef}),
    choice:object({type:oneOf('choice'),choice:text,cases:record(nodeRef),otherwise:optional(nodeRef)}),
    waitEncounter:object({type:oneOf('waitEncounter'),encounter,outcomes:record(nodeRef)}),
    defer:object({type:oneOf('defer')}),end:object({type:oneOf('end')})
  };requireValue(checks[type],p,'未定义节点出口');checks[type](v,p);
};
const presentation:Check=(v,p)=>{
  if((v as {type?:string})?.type==='quest-popup')object({type:oneOf('quest-popup'),kind:oneOf('start','complete'),quest:text})(v,p);
  else{action(v,p);requireValue(!['party-join','party-leave'].includes((v as {type:string}).type),p,'队伍变化通过游戏命令提交');}
};
/** 地点由导出层按原版证据填，运行时只读：结构在这里把关。 */
const storySpot=object({map:text,x:number,y:number,source:text});
const storyPlace=variant('type',{
  fixed:object({type:oneOf('fixed'),map:text,x:number,y:number,source:text}),
  alternatives:object({type:oneOf('alternatives'),spots:array(storySpot)}),
  current:object({type:oneOf('current')}),
  unavailable:object({type:oneOf('unavailable'),reason:text}),
});
const debugPair=(first:Check,second:Check):Check=>(v,p)=>{
  requireValue(Array.isArray(v)&&v.length===2,p,'需要二元组');
  first(v[0],`${p}[0]`);second(v[1],`${p}[1]`);
};
const debugSequence=array(debugPair(text,count));
const debugEntity=object({id:text,map:optional(text),actor:optional(text),characterId:optional(text),authority:optional(oneOf('registered','npc','story','static')),mapVisit:optional(integer),
  x:optional(number),y:optional(number),facing:optional(facing),visible:optional(boolean),removed:optional(boolean),hint:optional(text)});
const debugEncounter=object({id:text,definitionId:optional(text),map:text,mapFromStage:optional(boolean),
  status:oneOf('prepared','active','won','lost'),spawns:array(object({id:text,enemyId:text,x:number,y:number}))});
/** 现场表的世界差量；与 `StoryWorldSnapshot` 同形，另加结构化的缺场登记。 */
const debugWorld=object({
  location:object({map:text,x:number,y:number,facing}),
  entities:optional(array(debugEntity)),
  exits:optional(array(debugPair(text,boolean))),
  flags:optional(strings),
  choices:optional(array(debugPair(text,text))),
  encounters:optional(array(debugEncounter)),
  mapVisit:optional(integer),
  enemyRemovals:optional(array(object({enemyId:text,map:optional(text),all:boolean}))),
  enemyLocations:optional(array(object({id:text,enemyId:text,map:text,x:number,y:number,
    mapVisit:optional(integer),respawn:optional((v,p)=>requireValue(v===false,p,'只能为 false')),mapFromStage:optional(boolean)}))),
  appearances:optional(array(debugPair(text,text))),
  partyBuffs:optional(array(object({buff:text,strength:integer}))),
  absentActors:optional(array(object({map:text,actor:text,characterId:optional(text)}))),
  absentEnemies:optional(array(object({map:text,enemyId:text}))),
});
const debugItem=object({item:text,quantity:count,e:optional(integer)});
const debugStart=object({
  quests:optional(array(object({id:text,status:oneOf('locked','available','active','ready','completed'),
    cycle:optional(integer),completedCycles:optional(integer),goals:optional(record(integer)),e:optional(integer)}))),
  running:optional(strings),
  world:optional(debugWorld),
  items:optional(array(debugItem)),
  itemReset:optional(strings),
  party:optional(object({join:optional(strings),leave:optional(strings),control:optional(text)})),
  completedEvents:optional(array(object({id:text,e:optional(integer)}))),
  occurrenceSequences:optional(debugSequence),
  factSequences:optional(debugSequence),
  requiresProfile:optional(object({items:optional(array(debugItem)),money:optional(integer)})),
});
const debugPlay=object({script:text,node:optional(text),event:optional(text),cut:oneOf('before-opening','after-accept','event-end')});
const debugGap=object({quest:text,title:optional(text),kind:text,detail:text,evidence:optional(text),fixHint:optional(text)});
const debugCoverage=object({eligible:integer,verified:integer,gaps:integer,excludedNoIntake:integer,
  excludedUnreachableEvents:integer,unreachableNodes:integer,byGapKind:record(integer)});
const debugMeta=object({generator:optional(text),interpreterVersion:count,semanticsVersion:count,sourceHash:text,
  generatedAt:text,sources:optional(record(text)),coverage:debugCoverage});
const debugTask=object({
  quest:text,phase:oneOf('available','active'),
  entry:object({type:oneOf('fixed'),map:text,x:number,y:number,source:text}),
  scripts:optional(strings),
  start:optional(debugStart),play:optional(debugPlay),
  sourceHash:optional(text),
  basis:optional((v,p)=>requireValue(!!v&&typeof v==='object'&&!Array.isArray(v),p,'需要对象')),
});
const debugStory=object({schema:optional((v,p)=>requireValue(v===1,p,'需要版本 1')),meta:optional(debugMeta),
  tasks:array(debugTask),gaps:optional(array(debugGap))});
/** 调试现场表是独立产物，只有 GM 模式才加载；形状与旧 `campaign.debugStory` 相同。 */
export function parseStoryDebugCatalog(value:unknown):import('../domain/story-debug.ts').StoryDebugCatalog{
  debugStory(value,'debugStory');return value as import('../domain/story-debug.ts').StoryDebugCatalog;
}
const campaign=shape<Campaign>({debugStory:optional(debugStory),version:(v,p)=>requireValue(v===2,p,'剧情内容需要版本 2'),contentVersion:count,
  start:object({map:text,x:number,y:number,actor:text,facing,script:text}),
  scripts:record(object({entry:text,nodes:array(object({id:text,presentation:array(presentation),commands:array(storyCommand),stage:optional(performanceChecks.stage),exit:nodeExit}))})),
  questGroups:array(object({id:text,title:text,kind:oneOf('main','side'),questIds:strings})),
  quests:array(object({id:text,title:text,description:text,giver:optional(text),giverCharacterId:optional(text),delivery:optional(text),deliveryCharacterId:optional(text),places:optional(object({available:optional(storyPlace),active:optional(storyPlace),ready:optional(storyPlace)})),guidance:object({available:text,active:text,counterLabel:optional(text)}),
    targetChanges:optional(array(object({goal:text,enemyId:text,actor:text,removeAfterInteraction:boolean,changedText:text,interactText:text}))),
    descriptionTargets:optional(array(object({target:text,characterId:optional(text),label:optional(text)}))),
    goals:array(object({id:text,kind:oneOf('talk','item','interact','defeat','recruit'),target:text,characterId:optional(text),quantity:count,label:optional(text)})),
    availableWhen:optional(storyCondition),completion:oneOf('talk','all','story','internal'),hidden:optional(boolean),repeat:optional(boolean),
    onAcceptItems:optional(array(object({item:text,quantity:count}))),handoverItems:optional(array(object({item:text,quantity:count,removal:optional(oneOf('quantity','all-matching'))}))),
    itemCompletion:optional(oneOf('all','equipped-item-shortcut')),acceptance:optional(oneOf('automatic','optional')),
    rewards:optional(object({experience:integer,money:integer,items:array(object({item:text,quantity:count,classIds:optional(strings)}))})),
    offerScript:optional(nullable(text)),completeScript:optional(nullable(text)),progressText:text,completeText:text})),
  placements:array(object({...entity,condition:storyCondition,map:text,facing:optional(facing)})),mapEntryPlacements:optional(array(object({...entity,condition:storyCondition,map:text,facing:optional(facing)}))),enemyPlacements:optional(array(object(campaignEnemy))),
  events:array(object({id:text,source:oneOf(...STORY_TRIGGER_SOURCES),script:text,
    key:optional(text),entity:optional(text),map:optional(text),place:optional(storyPlace),near:optional(text),nearCharacterId:optional(text),region:optional(object(box)),condition:optional(storyCondition),priority:optional(integer),repeat:optional(boolean)})),
  exitRules:optional(array(object({id:text,map:text,condition:storyCondition})))});
const target=oneOf('self','current','area','target-area','ally','ally-heal','party','party-ally','enemy','none');
const transition=shape<SkillTransition>({directional:optional(boolean),missEffects:optional(array(object({effect:text,recipient:oneOf('caster','target'),placement:oneOf('attached','ground','above-characters')}))),casterStrikes:optional(object({effect:text,offsets:array(object({x:offsetInteger,y:offsetInteger}))})),anchor:optional(oneOf('target','caster')),kind:oneOf('stationary','trace','position'),effect:nullable(text),actionEffect:nullable(text),switchFrame:integer,stepDistancePx:number,offsetX:number,offsetY:number});
const visualEffect=shape<SkillVisualEffect>({effect:text,recipient:oneOf('caster','target'),placement:oneOf('attached','ground','above-characters')});
const actionDispatch=shape<ActionDispatchDefinition>({breaksStealth:boolean,casterEffects:optional(array(object({effect:text,recipient:oneOf('caster'),placement:oneOf('attached','ground','above-characters')}))),shake:optional(boolean),vibrationMs:optional(count),sound:optional(text)});
const charge=shape<SkillCharge>({arrivalFrame:integer,closeDistanceUnits:positive,lungeDistancePx:positive,stoppingDistanceUnits:positive,gridSizePx:positive});
const afterimages=shape<SkillAfterimages>({frame:integer,opacity:number,distancesPx:array(positive)});
const cue=shape<SkillEffectCue>({target,targetRangePx:number,targetSelection:optional(oneOf('search','reuse-previous')),unitFeedbackPolicy:optional(oneOf('always')),sound:optional(text),targetRangeMetric:optional(oneOf('octagonal-grid')),effects:array(visualEffect)});
const skillEvent=(v:unknown,p:string)=>{
  requireValue(v&&typeof v==='object',p,'需要技能事件');
  const event=v as {kind?:string};
  const fields:Record<string,Check>={
    feedback:object({kind:oneOf('feedback'),frame:integer,shake:optional(boolean),vibrationMs:optional(count),sound:optional(text)}),
    cast:object({kind:oneOf('cast'),frame:integer,effect:visualEffect}),
    units:object({kind:oneOf('units'),frame:integer,cues:array(cue),dispatch:optional(actionDispatch)}),
    caster:object({kind:oneOf('caster'),frame:integer,effects:array(visualEffect)}),
    swing:object({kind:oneOf('swing'),frame:integer,effects:array(visualEffect)}),
    impact:object({kind:oneOf('impact'),frame:integer,target,effect:visualEffect}),
    spawn:object({kind:oneOf('spawn'),frame:integer,until:integer,effect:text,placement:oneOf('attached','ground','above-characters'),marginPx:integer}),
    'capture-targets':object({kind:oneOf('capture-targets'),frame:integer,target,targetRangePx:number,limit:count}),
    'captured-effect':object({kind:oneOf('captured-effect'),frame:integer,effect:text,placement:oneOf('ground','above-characters')}),
    summon:object({kind:oneOf('summon'),frame:integer,dispatch:optional(actionDispatch),creatures:array(object({enemyId:text})),effect:text,placement:object({searchGapPx:positive,searchExtentPx:positive,offsetChoices:array(object({x:number,y:number})),jitterPx:integer})}),
    screen:object({kind:oneOf('screen'),frame:integer,fillTransparency:integer}),
  };
  const check=fields[event.kind??''];requireValue(check,p,`未知技能事件类型 ${event.kind}`);
  check(v,p);
};
const signedInteger:Check=(v,p)=>{number(v,p);requireValue(Number.isInteger(v),p,'需要整数');};
const combatOperation=variant('kind',{
  keep:object({kind:oneOf('keep')}),
  ...Object.fromEntries(['set','add','subtract'].map(kind=>[kind,object({kind:oneOf(kind),amount:signedInteger})])),
  multiply:object({kind:oneOf('multiply'),factor:signedInteger}),
  divide:object({kind:oneOf('divide'),divisor:signedInteger}),
  ...Object.fromEntries(['multiply-thousandth','increase-thousandth','decrease-thousandth'].map(kind=>[kind,object({kind:oneOf(kind),ratePerThousand:signedInteger})])),
});
const buffPeriodic=variant('kind',{
  'fixed-damage':object({kind:oneOf('fixed-damage'),amount:signedInteger}),
  'magic-curse':object({kind:oneOf('magic-curse'),ratePerThousand:signedInteger,healEffect:optional(text)}),
  'normal-damage':object({kind:oneOf('normal-damage'),operation:combatOperation}),
  'attack-damage':object({kind:oneOf('attack-damage'),source:oneOf('physical','magic'),operation:combatOperation}),
  healing:object({kind:oneOf('healing'),attribute:oneOf(...BATTLE_STAT_KEYS),operation:combatOperation}),
  'attribute-damage':object({kind:oneOf('attribute-damage'),attribute:oneOf(...BATTLE_STAT_KEYS),operation:combatOperation}),
  visual:object({kind:oneOf('visual'),effect:text}),
});
const stateFrameDuration=object({lastActiveFrame:integer});
const stateDurationProfile=shape<StateDurationProfile>({normal:stateFrameDuration,targetShortened:optional(stateFrameDuration),
  buffShortened:optional(stateFrameDuration),buffAndTargetShortened:optional(stateFrameDuration)});
const stateDurationScale:Check=(v,p)=>requireValue(v===1||v===0.5,p,'需要完整或减半的状态持续期');
const stateRules=shape<StateApplicationRules>({immuneToAllStates:optional(boolean),immuneStates:optional(array(oneOf(...BATTLE_STATE_KEYS))),
  durationScale:optional(stateDurationScale),buffDurationScaleByState:optional(object(Object.fromEntries(BATTLE_STATE_KEYS.map(state=>[state,optional(stateDurationScale)])))),
  frameDurationScale:optional(stateDurationScale)});
const buffEffectFields=shape<BattleBuffEffect>({durationMs:integer,tickMs:integer,maxStacks:optional(count),
  applicationEffect:optional(text),
  invalidatesAttributes:optional(array(oneOf(...BATTLE_STAT_KEYS))),
  onApply:optional(array(variant('kind',{['restore-health-from-max-health']:object({kind:oneOf('restore-health-from-max-health'),operation:combatOperation}),['add-mana']:object({kind:oneOf('add-mana'),value:integer})}))),
  onAccepted:optional(array(object({kind:oneOf('apply-learned-buff'),skill:oneOf(...ACCEPTED_LEARNED_BUFF_SKILLS),target:oneOf('source','target')}))),
  loopEffects:optional(array(object({effect:text,firstFrameAge:integer}))),
  stateDurationProfiles:optional(object(Object.fromEntries(BATTLE_STATE_KEYS.map(state=>[state,optional(stateDurationProfile)])))),
  reactions:optional(array((v,p)=>buffReaction(v,p))),
  simulationFrames:optional(object({lastActiveFrame:integer,pulseIntervalFrames:optional(count),pulseAfterAgeIncrement:optional(boolean)})),
  appearanceColors:optional(array(object({red:integer,green:integer,blue:integer}))),
  attributeRamps:optional(array(object({attribute:oneOf(...BATTLE_STAT_KEYS),operation:combatOperation,intervalFrames:count}))),
  durationRateFromOwner:optional(object({attribute:oneOf(...BATTLE_STAT_KEYS),baseFrames:integer})),
  durationFramesFromOwner:optional(object({attribute:oneOf(...BATTLE_STAT_KEYS)})),
  modifiers:array(object({attribute:oneOf(...BATTLE_STAT_KEYS),operation:combatOperation})),states:array(oneOf(...BATTLE_STATE_KEYS)),periodic:array(buffPeriodic)});
const buffEffect:Check=(v,p)=>{
  buffEffectFields(v,p);
  const effect=v as {durationMs:number;tickMs:number;periodic:unknown[];states:string[];attributeRamps?:unknown[];durationRateFromOwner?:unknown;stateDurationProfiles?:Record<string,unknown>;simulationFrames?:{lastActiveFrame:number;pulseIntervalFrames?:number;pulseAfterAgeIncrement?:boolean}};
  if(effect.attributeRamps?.length)requireValue(effect.simulationFrames,`${p}.simulationFrames`,'逐段属性斜坡需要母Buff帧计时');
  if(effect.durationRateFromOwner)requireValue(effect.simulationFrames,`${p}.simulationFrames`,'按主人比例放大的寿命需要母Buff帧计时');
  if(effect.stateDurationProfiles){
    requireValue(effect.simulationFrames,`${p}.simulationFrames`,'独立状态帧龄需要母Buff帧计时');
    for(const state of effect.states)requireValue(effect.stateDurationProfiles[state],`${p}.stateDurationProfiles.${state}`,'需要声明状态的寿命方案');
    for(const state of Object.keys(effect.stateDurationProfiles))requireValue(effect.states.includes(state),`${p}.stateDurationProfiles.${state}`,'寿命方案需要对应声明状态');
  }
  const frames=effect.simulationFrames;if(!frames)return;
  requireValue(effect.durationMs===(frames.lastActiveFrame+1)*LOGIC_FRAME_MS,`${p}.durationMs`,'需要首个逻辑处理到到期之间的时长');
  requireValue(effect.tickMs===(frames.pulseIntervalFrames??0)*LOGIC_FRAME_MS,`${p}.tickMs`,'需要与逻辑脉冲间隔一致');
  if(frames.pulseAfterAgeIncrement)requireValue(frames.pulseIntervalFrames!==undefined,`${p}.simulationFrames.pulseAfterAgeIncrement`,'计龄后脉冲需要逻辑脉冲间隔');
  requireValue(!effect.periodic.length||frames.pulseIntervalFrames!==undefined,`${p}.simulationFrames.pulseIntervalFrames`,'周期效果需要逻辑脉冲间隔');
};
const combatUnit=variant('effect',{
  ...Object.fromEntries(['physical','magic','heal','drain'].map(effect=>[effect,object({effect:oneOf(effect),
    source:oneOf('physicalAttack','magicAttack','maxHealth','bestNormalDamage','none'),
    attributeWeights:object(Object.fromEntries(PRIMARY_STATS.map(stat=>[stat,signedInteger]))),
    ranks:array(object({fixedAddition:signedInteger,operation:combatOperation})),ownerValues:optional(boolean)})])),
  'self-damage':object({effect:oneOf('self-damage'),
    source:oneOf('physicalAttack','magicAttack','maxHealth','bestNormalDamage','none'),
    attributeWeights:object(Object.fromEntries(PRIMARY_STATS.map(stat=>[stat,signedInteger]))),
    ranks:array(object({fixedAddition:signedInteger,operation:combatOperation})),
    alsoAppliesLearnedBuff:optional(oneOf(...LEARNED_REACTION_SKILLS))}),
  state:object({effect:oneOf('state'),state:oneOf(...BATTLE_STATE_KEYS),ranks:array(object({chanceThreshold:integer,durationMs:integer,stateDurationProfile:optional(stateDurationProfile)}))}),
  buff:object({effect:oneOf('buff'),buff:oneOf(...BATTLE_BUFF_KEYS),ranks:array(object({strength:signedInteger,chanceThreshold:integer,effect:buffEffect}))}),
  summon:object({effect:oneOf('summon'),creature:text,
    ranks:array(object({durationMs:count,simulationFrames:optional(object({lastActiveFrame:integer})),
      attackRatePerThousand:optional(integer),healthRatePerThousand:optional(integer),tauntChanceThreshold:optional(integer)})),
    lifetimeFromOwner:optional(object({attribute:oneOf(...BATTLE_STAT_KEYS),perPoint:integer,base:integer})),
    ownerDerived:optional(object({attack:object({attribute:oneOf('physicalAttack','magicAttack'),perLevel:integer,flat:integer}),
      health:object({perLevel:integer,flat:integer}),physicalResistanceBonus:integer,magicResistance:integer})),
    appearanceEffects:optional(array(visualEffect))}),
  'set-attribute':object({effect:oneOf('set-attribute'),attribute:oneOf(...BATTLE_STAT_KEYS),ranks:array(combatOperation)}),
  'clear-attribute':object({effect:oneOf('clear-attribute'),attribute:oneOf(...BATTLE_STAT_KEYS)}),
  ...Object.fromEntries(['action','taunt','visual'].map(effect=>[effect,object({effect:oneOf(effect)})])),
});
const skillAction=shape<SkillAction>({requiredOffhand:optional(oneOf('shield')),requiresActiveSummon:optional(boolean),hitEffectStyle:optional(oneOf('weapon','skill')),manaGemDrop:optional(oneOf('skill','weapon')),combatUnits:optional(array(combatUnit)),usesSkillDamageBuff:optional(boolean),repeat:optional(object({restartAfterFrame:count,countByLevel:array(count),requiresLivingTarget:optional(boolean),endsWithoutTarget:optional(boolean),facesTargetOnRelease:optional(boolean)})),charge:optional(charge),rearTeleport:optional(object({frame:count})),afterimages:optional(afterimages),requiresTarget:optional(boolean),minHealthRatePerThousand:optional(count),events:array(skillEvent),cooldownFrames:integer,approachDistanceUnits:number,searchRadiusPx:positive,transition:nullable(transition),effectNames:optional(strings),soundNames:optional(strings),summonNames:optional(strings),eventFrames:optional(record(array(integer)))});
const passiveUnit=object({attribute:oneOf(...BATTLE_STAT_KEYS),
  condition:oneOf('always','weapon-two-handed','weapon-short-or-long-sword','weapon-mace','stealthed'),ranks:array(combatOperation)});
const reactionBuff=shape<BuffReactionBuff>({key:oneOf(...BATTLE_BUFF_KEYS),rankPriority:count,effect:buffEffect});
const buffReaction=variant('kind',{
  ...Object.fromEntries(['physical-avoidance','physical-success-party'].map(kind=>[kind,object({kind:oneOf(kind),buff:reactionBuff})])),
  'mana-on-physical-success':object({kind:oneOf('mana-on-physical-success'),amount:positive,effect:oneOf('mana-recovery')}),
  'weapon-block-counter':object({kind:oneOf('weapon-block-counter'),buff:reactionBuff}),
  'weapon-block-stun':object({kind:oneOf('weapon-block-stun'),state:oneOf(...BATTLE_STATE_KEYS),durationAttribute:oneOf(...BATTLE_STAT_KEYS)}),
  'physical-success-threat':object({kind:oneOf('physical-success-threat')}),
});
const skillReaction=variant('kind',{
  'flare':object({kind:oneOf('flare'),chanceThreshold:integer,offhandChanceThreshold:integer,stealthFromLearnedSkill:oneOf('whist'),effect:oneOf('smoke-puff'),unlearnedStealth:object({key:oneOf('whist'),rankPriority:integer,effect:buffEffect})}),
  'soul-sword':object({kind:oneOf('soul-sword'),chanceThreshold:integer,buffFromLearnedSkill:oneOf('dark-strike'),physicalEffects:strings,magicEffects:strings}),
  'blood-sword':object({kind:oneOf('blood-sword'),lifeDrainPerThousand:integer}),
  'blood-thirst':object({kind:oneOf('blood-thirst'),lifeEffect:oneOf('life-drain'),manaEffect:oneOf('mana-recovery')}),
  'shield-of-rage':object({kind:oneOf('shield-of-rage'),buff:reactionBuff}),
  'shield-of-trust':object({kind:oneOf('shield-of-trust'),buff:object({key:oneOf('shield-of-trust'),rankPriority:count,effect:buffEffect})}),
  'blood-revenge':object({kind:oneOf('blood-revenge'),buff:object({key:oneOf('blood-revenge'),rankPriority:count,effect:buffEffect})}),
  'bard-of-destruction':object({kind:oneOf('bard-of-destruction'),buff:object({key:oneOf('bard-of-destruction'),rankPriority:count,effect:buffEffect})}),
  'deep-breath':object({kind:oneOf('deep-breath'),buff:object({key:oneOf('deep-breath'),rankPriority:count,effect:buffEffect})}),
  'sniping':object({kind:oneOf('sniping'),buff:object({key:oneOf('sniping'),rankPriority:count,effect:buffEffect})}),
  'ordination-prayer':object({kind:oneOf('ordination-prayer'),chanceThreshold:integer,buff:object({key:oneOf('ordination-prayer'),rankPriority:count,effect:buffEffect})}),
  'magic-insight':object({kind:oneOf('magic-insight'),buff:object({key:oneOf('magic-insight'),rankPriority:count,effect:buffEffect})}),
  'disturbance':object({kind:oneOf('disturbance'),chanceThreshold:integer}),
  'lightning-of-hell':object({kind:oneOf('lightning-of-hell'),chanceThreshold:integer}),
  'god-of-justice':object({kind:oneOf('god-of-justice'),chanceThreshold:integer}),
  'clever-fellow':object({kind:oneOf('clever-fellow'),chanceThreshold:integer}),
  'owner-mana-restore':object({kind:oneOf('owner-mana-restore'),amount:integer,effect:oneOf('mana-recovery')}),
  'dark-sense':object({kind:oneOf('dark-sense'),buff:object({key:oneOf('dark-sense'),rankPriority:count,effect:buffEffect})}),
  'armor-penetration':object({kind:oneOf('armor-penetration'),buff:object({key:oneOf('armor-break'),rankPriority:count,effect:buffEffect})}),
  'revenge-incarnate':object({kind:oneOf('revenge-incarnate'),buff:object({key:oneOf('revenge-incarnate'),rankPriority:count,effect:buffEffect})}),
  ...Object.fromEntries(['flares-of-pain','wrath-of-darkness'].map(kind=>[kind,object({kind:oneOf(kind),chanceThreshold:integer,buff:reactionBuff})])),
});
const basicAttackDamage:Check=(value,path)=>{
  combatUnit(value,path);
  const unit=value as {effect:string;ranks:unknown[]};
  requireValue(unit.effect==='physical'||unit.effect==='magic',path+'.effect','普攻需要物理或魔法伤害');
  requireValue(unit.ranks.length===1,path+'.ranks','普攻需要一份等级公式');
};
const basicAttackFields=shape<BasicAttackDefinition>({damage:basicAttackDamage,dispatch:optional(actionDispatch),hitEffectStyle:optional(oneOf('weapon','skill')),manaGemDrop:optional(oneOf('skill','weapon')),timing:optional(oneOf('fixed-animation')),targeting:optional(object({target:oneOf('area'),targetRangePx:positive,targetRangeMetric:oneOf('octagonal-grid')})),frameDurationMs:positive,cycleFrames:count,approachDistanceUnits:number,searchRadiusPx:positive,strikeFrame:integer,strikes:optional(array(object({frame:integer,hand:oneOf('main-hand','offhand')}))),swingFrame:nullable(integer),swingOrder:optional(oneOf('after-strike')),projectilePlacement:optional(oneOf('world','above-characters')),swingPlacement:optional(oneOf('world','above-characters')),impactPlacement:optional(oneOf('world','attached')),swings:strings,impacts:strings,targetEffects:optional(array(visualEffect)),transition:optional(transition),projectile:nullable(object({effect:text,stepDistancePx:positive,stepDurationMs:positive,offsetX:number,offsetY:number}))});
const basicAttack:Check=(value,path)=>{
  basicAttackFields(value,path);
  const attack=value as BattleCatalog['basicAttacks'][string];
  if(attack.timing==='fixed-animation'){
    requireValue(attack.strikeFrame<attack.cycleFrames,`${path}.strikeFrame`,'固定动画需要包含出手帧');
    requireValue(attack.swingFrame===null||attack.swingFrame<attack.cycleFrames,`${path}.swingFrame`,'固定动画需要包含挥击帧');
  }
  if(attack.targeting)requireValue(!attack.strikes&&!attack.projectile&&!attack.transition,`${path}.targeting`,'范围普攻需要一次直接出手');
};
const boundBasicAttack:Check=(value,path)=>{
  const {clips,...attack}=value as Record<string,unknown>;basicAttack(attack,path);
  object({north:text,south:text,east:text,west:text})(clips,`${path}.clips`);
};
const binding=shape<BasicAttackBinding>({profileId:text,clips:object({north:text,south:text,east:text,west:text})});
const enemyReleaseCondition=oneOf('hp-below-30','hp-below-70','hp-below-50','hp-below-95','always');
const enemySkill:Check=(v,p)=>{
  requireValue(v&&typeof v==='object',p,'需要怪物技能');
  ('unavailableReason' in v
    ?object({id:text,name:text,unavailableReason:text})
    :object({id:text,name:text,previewNote:optional(text),releaseCondition:optional(enemyReleaseCondition),once:optional(boolean),action:skillAction,companionAction:optional(skillAction),clips:object({north:text,south:text,east:text,west:text})}))(v,p);
};
const behavior=shape<EnemyBehavior>({aggression:oneOf('active','passive','none'),engagement:optional(oneOf('map-wide')),awarenessRangeUnits:integer,moveSpeedPxPerSecond:number,canMove:boolean,canTurn:boolean,wander:optional(object({idleDurationMs:positive}))});
const enemyAttributes=shape<EnemyAttributes>({maxMana:integer,physicalAttack:integer,magicAttack:integer,defense:integer,defenseRate:integer,
  physicalResistanceBonus:integer,magicResistance:integer,hitBonus:integer,evasionBonus:integer,
  criticalRate:integer,criticalResistance:integer,criticalDamageResistance:integer,criticalDamage:integer,weaponBlock:integer,shieldBlock:integer});
const feedback=shape<CombatFeedbackDefinition>({digits:object({enemy:strings,enemyCritical:strings,party:strings,partyCritical:strings,miss:strings}),normalImpacts:strings,skillImpact:text,criticalImpact:text,criticalRing:text,criticalBursts:strings,missEffect:text,shakeOffsets:array(object({x:number,y:number}))});
const skillDetail=object({label:text,value:text,kind:optional(oneOf('mana','cooldown','effect')),effectIndex:optional(integer),valueSpacing:optional(boolean),zeroValue:optional(text),valueParts:optional(descriptionParts)});
const skillDisplayRow=object({label:text,kind:optional(oneOf('mana','cooldown','effect')),effectIndex:optional(integer),valueSpacing:optional(boolean),template:text,decimals:integer,highlight:boolean,zeroText:text});
const skillRank=object({level:positive,manaCost:integer,requiredCharacterLevel:positive,pointCost:positive,investedSkillPoints:optional(integer),
  details:optional(array(skillDetail)),displayValues:optional(array(number))});
const skillGrowthFields={requiredInvestedSkillPoints:optional(integer),ranks:array(skillRank),display:optional(array(skillDisplayRow)),
  action:nullable(skillAction),followUpAction:optional(skillAction),passiveUnits:optional(array(passiveUnit)),reactionsByRank:optional(array(array(skillReaction)))};
const battle=shape<BattleCatalog>({statusAttackBuffs:optional(object(Object.fromEntries(BATTLE_BUFF_KEYS.map(key=>[key,optional(buffEffect)])))),feedback,classes:array(object({id:text,name:text,description:text,preview:file,actor,attributes:array(object({name:text,value:number})),skills:strings,basicAttack:binding})),basicAttacks:record(basicAttack),skills:record(object({id:text,name:text,kind:oneOf('active','passive'),icon:file,description:text,descriptionParts:optional(descriptionParts),normalMaxLevel:positive,...skillGrowthFields,companion:object(skillGrowthFields)})),enemies:array(object({stateRules:optional(stateRules),acceptsBuffs:optional(boolean),waterImmune:optional(boolean),skills:optional(array(enemySkill)),commandAction:optional(enemySkill),id:text,name:text,level:nullable(count),maxHealth:count,attributes:enemyAttributes,variant:text,actor,behavior,basicAttack:nullable(binding),displayOnlyReason:optional(text),defeatPresentation:optional(oneOf('vanish'))})),attackEffects:record(object({clips:record(effectClip),attachmentPoint:optional(oneOf('feet','effect-anchor')),attachedLifetime:optional(oneOf('action','character'))}))});

export function parseWorld(value:unknown):WorldIndex{world(value,'world');const result=value as WorldIndex;unique(result.maps.map(m=>m.id),'world.maps');return result;}
export function parseMap(value:unknown):WorldMap{
  map(value,'map');const result=value as WorldMap;
  if(result.lootLevel!==undefined)requireValue(result.lootLevel>=0&&result.lootLevel<=255,'map.lootLevel','掉落等级需要在 0–255 之间');
  if(result.chestLevel!==undefined)requireValue(result.chestLevel>=1&&result.chestLevel<=255,'map.chestLevel','宝箱等级需要在 1–255 之间');
  unique(result.entities.map(entity=>entity.id),`map.${result.id}.entities`);
  requireValue(result.blocked.length===result.columns*result.rows,'map.blocked','格数不匹配');
  if(result.water!==undefined){
    const cells=result.columns*result.rows;
    requireValue(result.water.every((cell,index)=>cell>=0&&cell<cells&&(index===0||cell>result.water![index-1]!)),'map.water','水格索引需要严格递增且不超出地图');
  }
  requireValue(result.width===result.columns*result.tileSize&&result.height===result.rows*result.tileSize,'map','尺寸不匹配');
  unique((result.enemySpawns??[]).map(spawn=>spawn.id),`map.${result.id}.enemySpawns`);
  for(const spawn of result.enemySpawns??[])
    requireValue(spawn.x>=0&&spawn.x<result.width&&spawn.y>=0&&spawn.y<result.height,spawn.id,'敌人站位超出地图');
  unique((result.questItemSpawns??[]).map(spawn=>spawn.id),`map.${result.id}.questItemSpawns`);
  for(const spawn of result.questItemSpawns??[])
    requireValue(spawn.x>=0&&spawn.x<result.width&&spawn.y>=0&&spawn.y<result.height,spawn.id,'任务物品生成点超出地图');
  return result;
}
export function parseCampaign(value:unknown):Campaign {
  campaign(value,'campaign'); const result=structuredClone(value) as Campaign;
  validateStoryGraph(result);
  unique(result.quests.map(q=>q.id),'quests');
  unique(result.questGroups.map(group=>group.id),'campaign.questGroups');
  const groupedQuests=result.questGroups.flatMap(group=>group.questIds);
  unique(groupedQuests,'campaign.questGroups.questIds');
  for(const group of result.questGroups){
    requireValue(group.questIds.length>0,group.id,'任务组需要至少一个任务');
    for(const id of group.questIds)requireValue(result.quests.some(quest=>quest.id===id),group.id,`任务不存在 ${id}`);
  }
  for(const quest of result.quests){
    requireValue(quest.id&&(!quest.hidden&&quest.completion!=='internal'?groupedQuests.includes(quest.id):true),quest.id,'任务缺少标识或所属分组');
    unique(quest.goals.map(goal=>goal.id),quest.id+'.goals');
    if(quest.completion==='all')requireValue(quest.goals.length,quest.id,'任务需要完成目标');
    for(const goal of quest.goals)requireValue(goal.id&&goal.target,quest.id,'任务目标标识为空');
    if(quest.itemCompletion==='equipped-item-shortcut')requireValue(quest.goals.length&&quest.goals.every(goal=>goal.kind==='item'),quest.id,'穿戴例外只用于有序物品目标');
  }
  unique([...result.placements,...result.mapEntryPlacements??[]].map(entity=>entity.id),'campaign.placements');
  unique((result.enemyPlacements??[]).map(enemy=>enemy.id),'campaign.enemyPlacements');
  unique((result.exitRules??[]).map(exit=>exit.id),'campaign.exitRules');
  const questIds=new Set(result.quests.map(q=>q.id)),eventIds=new Set(result.events.map(event=>event.id));
  const choices=new Set<string>(),flags=new Set(eventIds),conditions:{owner:string;value:StoryCondition|undefined}[]=[];
  const commands:StoryCommand[]=[];
  for(const [name,script]of Object.entries(result.scripts))for(const node of script.nodes){
    commands.push(...node.commands);
    if(node.exit.type==='choice')choices.add(node.exit.choice);
    if(node.exit.type==='branch')conditions.push({owner:name+'/'+node.id,value:node.exit.condition});
    for(const action of node.presentation)if(action.type==='quest-popup')requireValue(questIds.has(action.quest),name,'提示任务不存在');
  }
  for(const command of commands){
    if(command.type==='flag')flags.add(command.flag);
    if(command.type==='choice')choices.add(command.choice);
    if(command.type==='world'&&command.command.kind==='flag')flags.add(command.command.id);
    if(command.type==='world'&&command.command.kind==='choice')choices.add(command.command.id);
    if(command.type==='quest'&&'quest'in command.command)requireValue(questIds.has(command.command.quest),'story.command','命令任务不存在');
  }
  for(const quest of result.quests){
    conditions.push({owner:quest.id,value:quest.availableWhen});
    for(const id of [quest.offerScript,quest.completeScript])if(id)requireValue(result.scripts[id],quest.id,`剧情缺失 ${id}`);
  }
  for(const event of result.events){
    conditions.push({owner:event.id,value:event.condition});
    requireValue(event.source!=='region'||event.region&&event.map,event.id,'区域事件缺少地图和矩形');
    if(event.entity)requireValue(result.placements.some(entity=>entity.id===event.entity),event.id,'事件交互对象不存在');
  }
  for(const entity of [...result.placements,...result.mapEntryPlacements??[]]){
    conditions.push({owner:entity.id,value:entity.condition});
    if(entity.afterInteractScript)requireValue(result.scripts[entity.afterInteractScript],entity.id,'交互剧情缺失');
  }
  for(const exit of result.exitRules??[])conditions.push({owner:exit.id,value:exit.condition});
  for(const {owner,value}of conditions){
    const refs=storyConditionReferences(value);
    for(const id of refs.quests)requireValue(questIds.has(id),owner,`条件任务不存在 ${id}`);
    for(const id of refs.events)requireValue(eventIds.has(id),owner,`条件事件不存在 ${id}`);
    for(const id of refs.choices)requireValue(choices.has(id),owner,`条件选择不存在 ${id}`);
    for(const id of refs.flags)requireValue(flags.has(id),owner,`条件标记没有来源 ${id}`);
    for(const key of refs.world)requireValue(['map','near-actor','near-entity','interaction'].includes(key)||key.startsWith('region:')&&eventIds.has(key.slice(7)),owner,`世界条件没有来源 ${key}`);
  }
  const mandatory=(condition:StoryCondition|undefined):Set<string>=>{
    if(!condition)return new Set();
    if(condition.type==='quest'&&['accepted','active','ready','completed','settled'].includes(condition.status))return new Set([condition.quest]);
    if(condition.type==='all')return new Set(condition.conditions.flatMap(value=>[...mandatory(value)]));
    if(condition.type==='any'){
      const values=condition.conditions.map(mandatory);return new Set([...(values[0]??[])].filter(id=>values.every(value=>value.has(id))));
    }
    return new Set();
  };
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(id:string):void=>{
    if(visited.has(id))return;requireValue(!visiting.has(id),id,'任务前置条件形成无入口循环');visiting.add(id);
    const definition=result.quests.find(quest=>quest.id===id)!;
    if(definition.completion!=='internal')for(const dependency of mandatory(definition.availableWhen))visit(dependency);
    visiting.delete(id);visited.add(id);
  };for(const id of questIds)visit(id);
  for(const enemy of result.enemyPlacements??[])
    requireValue(questIds.has(enemy.activeQuest),enemy.id,'任务敌人引用了不存在的任务');
  // 旧内容只有 ID 和可选的位置访问寿命；解析时把对象来源写成字段，运行期不再猜前缀。
  for(const entity of [...result.placements,...result.mapEntryPlacements??[]]) entity.authority??=placementAuthority(entity);
  for(const script of Object.values(result.scripts))for(const node of script.nodes)for(const command of node.commands)
    if(command.type==='world'&&command.command.kind==='place')command.command.entity.authority??=placementAuthority(command.command.entity);
  validateStoryDebug(result);
  return result;
}
function unique(ids:string[],path:string):void{requireValue(new Set(ids).size===ids.length,path,'标识重复');}
export function parseBattle(value:unknown,wardrobe?:WardrobeCatalog):BattleCatalog{
  battle(value,'battle');const result=value as BattleCatalog;
  // 作者态 details 与构建期 display/displayValues 二选一；编译产物允许没有 details。
  const checkDisplay=(id:string,profile:{display?:readonly {template:string}[];ranks:readonly {details?:readonly unknown[];displayValues?:readonly number[]}[]})=>{
    if(profile.display){
      requireValue(profile.display.length>0,id,'技能展示模板不能为空');
      for(const row of profile.display)requireValue(row.template.includes('{v}'),id,'技能展示模板缺少 {v}');
      for(const rank of profile.ranks)
        requireValue(!!rank.displayValues&&rank.displayValues.length===profile.display.length,id,'技能展示数值必须覆盖全部模板行');
      return;
    }
    for(const rank of profile.ranks)requireValue(!!rank.details?.length,id,'技能缺少 details 或 display');
  };
  for(const [id,skill] of Object.entries(result.skills)){
    checkDisplay(id,skill);
    if(skill.companion)checkDisplay(id+'.companion',skill.companion);
  }
  for(const enemy of result.enemies)requireValue(enemy.level===null||enemy.level<=MAX_ENEMY_LEVEL,`${enemy.id}.level`,`怪物等级上限为 ${MAX_ENEMY_LEVEL}`);
  // 正式资源进运行时前的能力检查：缺能力的运算在这里报出来，不静默回退成普通混合。
  for(const problem of effectProblems(result.attackEffects))throw new Error(`内容无效 ${problem}`);
  unique(result.classes.map(c=>c.id),'classes');unique(result.enemies.map(e=>e.id),'enemies');
  const facings=['south','west','north','east'] as const;
  const effect=(name:string|null,variants:readonly string[])=>{if(!name)return;for(const variant of variants)requireValue(result.attackEffects[name]?.clips[variant],`effects.${name}.${variant}`,'特效变体缺失');};
  for(const name of COMBAT_OUTCOME_EFFECTS)effect(name,['default']);
  for(const name of feedbackEffects(result.feedback))requireValue(result.attackEffects[name],`feedback.${name}`,'反馈素材缺失');
  for(const name of [...result.feedback.normalImpacts,...result.feedback.criticalBursts,result.feedback.skillImpact,result.feedback.criticalImpact,result.feedback.criticalRing,result.feedback.missEffect])effect(name,['default']);
  for(const [style,names] of Object.entries(result.feedback.digits)){
    requireValue(names.length>0,`feedback.digits.${style}`,'数字动画不能为空');
    for(const name of names)effect(name,style==='miss'?['10']:Array.from({length:10},(_,i)=>String(i)));
  }
  requireValue(result.feedback.normalImpacts.length>0&&result.feedback.criticalBursts.length>0&&result.feedback.shakeOffsets.length===6,'feedback','命中特效或六步震屏缺失');
  const attachedPlacements:EffectPlacement[]=[];
  const headings=[0,23,45,68,90,112,135,157,180,203,225,248,270,292,315,337].map(angle=>`heading-${angle}`);
  // 普攻用装配时的同一份解析结果校验：规则引用、四向动画和逻辑帧序列都走这里。
  const resolveAttack=(character:{id:string;actor:ActorDefinition;basicAttack:BasicAttackBinding|null}):ResolvedBasicAttack=>{
    try{return resolveBasicAttack(result,character);}
    catch(error){throw new Error(`内容无效 ${character.id}.basicAttack: ${error instanceof Error?error.message:String(error)}`);}
  };
  const checkAttack=(character:{id:string;actor:ActorDefinition;basicAttack:BasicAttackBinding|null})=>{
    const profile=resolveAttack(character),profileId=character.basicAttack!.profileId;
    requireValue(profile.swingFrame===null||profile.swingFrame<profile.effectiveCycleFrames,`basicAttacks.${profileId}.swingFrame`,`挥击帧超出有效周期 ${profile.effectiveCycleFrames}`);
    for(const name of profile.swings)effect(name,facings);for(const name of profile.impacts)effect(name,['default']);
    if(profile.projectile)effect(profile.projectile.effect,headings);
    for(const item of [...profile.targetEffects??[],...profile.dispatch?.casterEffects??[]]){effect(item.effect,['default']);attachedPlacements.push(item.placement);}
    if(profile.transition){effect(profile.transition.actionEffect,['default']);effect(profile.transition.effect,profile.transition.kind==='trace'&&profile.transition.directional!==false?headings:['default']);}
    return profile;
  };
  const checkSkill=(id:string,action:SkillAction,actor:ActorDefinition,clips:Record<typeof facings[number], keyof ActorDefinition['clips']>,ranks:number)=>{
      const unitFrames=action.events.filter(event=>event.kind==='units').map(event=>event.frame);
      for(const event of action.events)if(event.kind==='units'){
        requireValue(event.cues[0]?.targetSelection!=='reuse-previous',id,'首个单元必须建立目标列表');
        for(const cue of event.cues)if(cue.unitFeedbackPolicy)requireValue(action.transition,id,'失败反馈策略需要过渡到达');
      }
      if(action.combatUnits){
        for(const event of action.events)if(event.kind==='units')requireValue(event.cues.length===action.combatUnits.length,id,'结算单元必须与目标项逐一对应');
        for(const unit of action.combatUnits){
          if('ranks' in unit)requireValue(unit.ranks.length===ranks,id,'结算数值必须覆盖全部技能等级');
          if(unit.effect==='summon'&&unit.creature){
            requireValue(result.enemies.some(enemy=>enemy.id===unit.creature),id,'召唤对象缺失');
          }
          for(const visual of unit.effect==='summon'?unit.appearanceEffects??[]:[])effect(visual.effect,['default']);
          if(unit.effect==='buff')for(const rank of unit.ranks){
            for(const name of buffEffectNames(rank.effect))effect(name,['default']);
          }
        }
      }
      requireValue(action.events.some(event=>event.kind!=='capture-targets'),id,'动作至少要有一个执行或表现事件');
      requireValue(action.events.every((event,index)=>index===0||action.events[index-1]!.frame<=event.frame),id,'事件必须按帧号升序排列');
      if(action.repeat){
        requireValue(action.repeat.countByLevel.length===ranks,id,'重播次数必须覆盖全部技能等级');
        requireValue(unitFrames.includes(action.repeat.restartAfterFrame),id,'重播帧必须是动作执行帧');
      }
      if(action.rearTeleport)requireValue(unitFrames.includes(action.rearTeleport.frame),id,'背后瞬移必须与动作执行帧一致');
      const placements:EffectPlacement[]=[];
      for(const facing of facings){
        const animation=actor.clips[clips[facing]];requireValue(animation,id,`动画缺失 ${facing}`);
        const frames=action.events.flatMap(event=>event.kind==='spawn'?[event.frame,event.until-1]:[event.frame]);
        for(const index of [...frames,action.repeat?.restartAfterFrame??null,action.charge?.arrivalFrame??null,action.rearTeleport?.frame??null,action.afterimages?.frame??null])frame(index,animation,id);
      }
      if(action.charge)requireValue(action.charge.arrivalFrame<Math.max(...unitFrames),id,'突进必须先抵达再命中');
      if(action.afterimages)requireValue(action.afterimages.opacity>=0&&action.afterimages.opacity<=1&&action.afterimages.distancesPx.length>0,id,'残影透明度或数量无效');
      for(const event of action.events){
        if(event.kind==='units'){
          for(const item of [...event.cues.flatMap(item=>item.effects),...event.dispatch?.casterEffects??[]]){effect(item.effect,['default']);placements.push(item.placement);}
        }else if(event.kind==='swing'){
          for(const item of event.effects){effect(item.effect,facings);placements.push(item.placement);}
        }else if(event.kind==='spawn'){
          requireValue(event.frame<event.until,id,'逐帧生成事件的结束帧必须晚于开始帧');
          effect(event.effect,['default']);placements.push(event.placement);
        }else if(event.kind==='capture-targets'){
          requireValue(event.targetRangePx>=0,id,'捕获范围必须非负');
        }else if(event.kind==='captured-effect'){
          effect(event.effect,['default']);placements.push(event.placement);
        }else if(event.kind==='summon'){
          for(const item of event.dispatch?.casterEffects??[]){effect(item.effect,['default']);placements.push(item.placement);}
          effect(event.effect,['default']);
          requireValue(event.creatures.length>0&&event.placement.offsetChoices.length>0,id,'召唤需要生物与落点');
          for(const creature of event.creatures)requireValue(result.enemies.some(enemy=>enemy.id===creature.enemyId),id,`召唤对象缺失 ${creature.enemyId}`);
        }else if(event.kind==='screen'){
          requireValue(event.fillTransparency>=0&&event.fillTransparency<=100,id,'全屏填充透明度需要在 0..100');
        }else if(event.kind==='feedback'){
          requireValue(event.shake||!!event.sound||!!event.vibrationMs,id,'动作反馈需要震屏、振动或音效');
        }else if('effects' in event){
          for(const item of event.effects){effect(item.effect,['default']);placements.push(item.placement);}
        }else{
          effect(event.effect.effect,['default']);placements.push(event.effect.placement);
        }
      }
      if(action.transition){for(const visual of action.transition.missEffects??[]){effect(visual.effect,['default']);placements.push(visual.placement);}effect(action.transition.actionEffect,['default']);effect(action.transition.effect,action.transition.kind==='trace'&&action.transition.directional!==false?headings:['default']);}
      attachedPlacements.push(...placements);
  };
  for(const enemy of result.enemies){
    requireValue(enemy.behavior.moveSpeedPxPerSecond>=0,enemy.id,'移动速度不能小于零');
    const skills=enemySkills(enemy);
    if(enemy.behavior.engagement==='map-wide')requireValue(enemy.behavior.aggression==='active'&&!!(enemy.basicAttack||skills.length),enemy.id,'全图参战需要主动型敌人及可用攻击能力');
    unique((enemy.skills??[]).map(skill=>skill.id),`${enemy.id}.skills`);
    for(const skill of skills)checkSkill(`${enemy.id}.${skill.id}`,skill.action,enemy.actor,skill.clips,1);
    if(enemy.commandAction){
      checkSkill(`${enemy.id}.${enemy.commandAction.id}`,enemy.commandAction.action,enemy.actor,enemy.commandAction.clips,8);
      if(enemy.commandAction.companionAction)checkSkill(`${enemy.id}.${enemy.commandAction.id}.companion`,enemy.commandAction.companionAction,enemy.actor,enemy.commandAction.clips,8);
    }
    for(const skill of enemy.skills??[])if('unavailableReason' in skill)requireValue(skill.unavailableReason.trim(),enemy.id,'缺失技能需要说明原因');
    if(!enemy.basicAttack&&!skills.length){
      requireValue(enemy.behavior.aggression==='none',enemy.id,'主动或被动敌人需要普攻或可用技能');
      requireValue(enemy.displayOnlyReason?.trim(),enemy.id,'只有展示用途的敌人需要说明原因');
    }else{
      if(enemy.basicAttack)checkAttack(enemy);
      for(const facing of facings)requireValue(enemy.actor.clips[`idle-${facing}`],enemy.id,`待机动画缺失 ${facing}`);
    }
    if(enemy.behavior.canMove){
      requireValue(enemy.behavior.moveSpeedPxPerSecond>0,enemy.id,'可移动敌人需要正的移动速度');
      for(const facing of facings)requireValue(enemy.actor.clips[`walk-${facing}`],enemy.id,`行走动画缺失 ${facing}`);
    }
    if(enemy.behavior.wander){
      requireValue(enemy.behavior.canMove&&enemy.behavior.canTurn&&enemy.behavior.aggression!=='none',enemy.id,'闲逛需要可移动、可转向的战斗角色');
      requireValue(enemy.behavior.wander.idleDurationMs%60===0,enemy.id,'闲逛待机时间必须为完整逻辑帧');
    }
  }
  for(const character of result.classes){
    requireValue(character.actor.headAnchor,character.id,'头顶状态条需要人物头部锚点');
    const profile=checkAttack(character),profileId=character.basicAttack.profileId;
    requireValue(profile.impacts.length>0,`basicAttacks.${profileId}.impacts`,'命中特效不能为空');
    for(const id of character.skills){
      const definition=result.skills[id];requireValue(definition&&definition.id===id,id,'技能缺失或标识不一致');
      for(const skill of [definition,{...definition,...definition.companion}]){
        requireValue((skill.kind==='active')===(skill.action!==null),id,'技能类型与动作不匹配');
        requireValue(skill.normalMaxLevel<=skill.ranks.length,id,'技能普通等级上限无效');
        for(const [index,rank] of skill.ranks.entries()){
          requireValue(rank.level===index+1,id,'技能等级必须连续');
          requireValue(index===0||rank.requiredCharacterLevel>=skill.ranks[index-1].requiredCharacterLevel,id,'技能角色等级门槛无效');
          if(rank.investedSkillPoints!==undefined)requireValue(rank.investedSkillPoints>=(index?skill.ranks[index-1].investedSkillPoints??0:0),id,'技能累计投入值必须递增');
          for(const detail of rank.details??[]){
            if(detail.effectIndex!==undefined)requireValue(detail.kind==='effect'&&detail.effectIndex<3,id,'技能效果行标识无效');
            if(detail.valueParts)requireValue(detail.valueParts.map(part=>part.text).join('')===detail.value,id,'技能数值片段与显示值不一致');
          }
        }
        if(skill.kind==='passive'){
          for(const unit of skill.passiveUnits??[])requireValue(unit.ranks.length===skill.ranks.length,id,'被动效果必须覆盖全部技能等级');
        }
        if(skill.reactionsByRank){
          requireValue(skill.reactionsByRank.length===skill.ranks.length,id,'触发效果必须覆盖全部技能等级');
          for(const reactions of skill.reactionsByRank)for(const reaction of reactions){
            const effects=reaction.kind==='soul-sword'?[...reaction.physicalEffects,...reaction.magicEffects]:
              reaction.kind==='blood-thirst'?[reaction.lifeEffect,reaction.manaEffect]:
              reaction.kind==='blood-sword'?['life-drain']:'buff' in reaction?buffEffectNames(reaction.buff.effect):[];
            for(const effect of effects)requireValue(result.attackEffects[effect],id,`触发特效 ${effect} 缺失`);
          }
        }
        const action=skill.action;if(!action)continue;
        checkSkill(id,action,character.actor,{north:`skill-${id}-north`,south:`skill-${id}-south`,east:`skill-${id}-east`,west:`skill-${id}-west`},skill.ranks.length);
      }
    }
    if(wardrobe)for(const [stance,changes]of Object.entries(wardrobe.skillStances[character.id]??{}))for(const [id,action]of Object.entries(changes.actions)){
      requireValue(character.skills.includes(id)&&result.skills[id].action,'wardrobe.skillStances','武器分支引用的主动技能不存在');
      if(!action)continue;
      const actor={...character.actor,clips:{...character.actor.clips}};
      for(const facing of facings){
        const key=`skill-${id}-${facing}` as const,pose=changes.poses[key];
        requireValue(pose&&wardrobe.poses[pose],id,'武器分支缺少技能动画');
        actor.clips[key]={...actor.clips[key]!,frames:wardrobe.poses[pose].frames.length};
      }
      checkSkill(`${stance}.${id}`,action,actor,{north:`skill-${id}-north`,south:`skill-${id}-south`,east:`skill-${id}-east`,west:`skill-${id}-west`},result.skills[id].ranks.length);
    }
  }
  const attached=attachedPlacements.includes('attached');
  if(attached)for(const {actor} of [...result.classes,...result.enemies])requireValue(actor.effectAnchor,actor.id,'跟随特效需要人物锚点');
  if(result.classes.some(character=>result.basicAttacks[character.basicAttack.profileId]?.impactPlacement==='attached'))
    for(const {actor} of result.enemies)requireValue(actor.effectAnchor,actor.id,'普攻跟随特效需要敌人锚点');
  return result;
}
function frame(index:number|null,clip:AnimationClip,path:string):void{if(index!==null)requireValue(index>=0&&index<clip.frames,path,`触发帧越界 ${index}`);}

export function parseControlSkin(value: unknown): ControlSkin {
  record(file)(value, 'controlSkin');
  const skin = value as ControlSkin;
  for (const key of CONTROL_PARTS) requireValue(skin[key], 'controlSkin', `操作素材缺失 ${key}`);
  return skin;
}

const hudRect=shape<HudRect>({x:number,y:number,width:positive,height:positive});
const hudInset=shape<HudInset>({left:number,top:number,right:number,bottom:number});
const hudGauge=shape<HudGauge>({x:number,y:number,fillOffset:integer,fillWidth:count,startWidth:count,endWidth:count,height:count});
export function parseStatusHud(value:unknown):StatusHudSkin {
  const color:Check=(v,p)=>{text(v,p);requireValue(/^#[0-9a-f]{6}$/i.test(v as string),p,'需要六位颜色');};
  const gauges=object({health:hudGauge,mana:hudGauge,experience:hudGauge});
  object({assets:record(file),player:object({width:count,height:count,inset:hudInset,portrait:hudRect,level:hudRect,gauges}),
    member:object({slots:array(count),width:count,height:count,inset:hudInset,portrait:hudRect,level:hudRect,gauges}),
    buffIcons:object({size:count,step:count,catalog:record(file)}),
    target:object({width:count,height:count,name:hudRect,gauge:hudGauge}),
    overhead:object({frame:hudRect,leader:hudRect,
      health:object({x:number,y:number,width:count,height:count,color}),mana:object({x:number,y:number,width:count,height:count,color})}),
    levelColors:array(object({minDifference:number,color}))})(value,'statusHud');
  const result=value as StatusHudSkin;
  for(const part of STATUS_PARTS)requireValue(result.assets[part],'statusHud.assets',`状态素材缺失 ${part}`);
  requireValue(result.levelColors.length>0&&result.levelColors.every((entry,i)=>Number.isInteger(entry.minDifference)&&(!i||result.levelColors[i-1].minDifference>entry.minDifference)),
    'statusHud.levelColors','等级阈值必须按降序排列');
  for(const panel of [result.player,result.member]){
    const {left,top,right,bottom}=panel.inset;
    requireValue(left>=0&&top>=0&&right>=0&&bottom>=0&&left+right<panel.width&&top+bottom<panel.height,
      'statusHud.inset','面板透明留白必须非负且小于面板尺寸');
  }
  for(const [size,rects] of [[result.player,[result.player.portrait,result.player.level]], [result.target,[result.target.name]],
    [result.member,[result.member.portrait,result.member.level]]] as const)
    for(const rect of rects)requireValue(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=size.width&&rect.y+rect.height<=size.height,'statusHud','布局超出面板');
  for(const [size,gauges] of [[result.player,Object.values(result.player.gauges)],[result.target,[result.target.gauge]],
    [result.member,Object.values(result.member.gauges)]] as const)
    for(const g of gauges)requireValue(g.x>=0&&g.y>=0&&g.x+g.fillOffset+g.fillWidth+g.endWidth<=size.width&&g.y+g.height<=size.height,'statusHud','血条超出面板');
  requireValue(result.member.slots.length>0&&result.member.slots.every((slot,i)=>slot>=0&&(!i||result.member.slots[i-1]<slot)),
    'statusHud.member.slots','队友面板槽位必须递增');
  requireValue(result.buffIcons.size>0&&result.buffIcons.step>0,'statusHud.buffIcons','状态图标尺寸与间距必须为正');
  for(const [name,file] of Object.entries(result.buffIcons.catalog))requireValue(name.length>0&&!!file,'statusHud.buffIcons.catalog','状态图标条目无效');
  return result;
}
