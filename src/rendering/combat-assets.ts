import { resolveBasicAttack } from '../domain/basic-attack.ts';
import { enemySkills, type BattleCatalog, type BattleClass, type EnemyDefinition, type ResolvedBasicAttack, type SkillAction } from '../domain/battle.ts';
import type { BattleCharacter } from '../domain/character-stats.ts';
import type { ActorDefinition, ClipName } from '../domain/content.ts';
import type { EquipmentSlot, ItemCatalog } from '../domain/items.ts';
import { costumeRecipe, equipmentAttackFor as domainEquipmentAttackFor, type WardrobeCatalog } from '../domain/wardrobe.ts';
import { skillClips, skillEffectNames, skillSummonNames } from '../domain/skill-action.ts';
import {
  basicAttackEffects, characterAssets, characterSceneClips, classEffects, combatFeedbackAssets, combatOutcomeAssets,
  effectAssets, sharedCombatEffectMap, type EffectMap
} from './combat-asset-descriptors.ts';
import type { PendingAsset } from './scene-assets.ts';
import { targetFocusAssets } from './target-focus-assets.ts';

/**
 * 战斗素材只由这里的纯函数决定：正式战斗、进图预取与构建期覆盖校验共用同一份清单，
 * 避免「预取漏了某项、演出结束后重建又要加载」。
 */
export function enemyCombatAssets(catalog: BattleCatalog, definition: EnemyDefinition): PendingAsset[] {
  const effects: EffectMap = {};
  const actors: PendingAsset[] = [];
  const visiting = new Set<string>();
  const visit = (enemy: EnemyDefinition): void => {
    if (visiting.has(enemy.id)) return;
    visiting.add(enemy.id);
    const clips = new Set(characterSceneClips(enemy.actor));
    const actions: SkillAction[] = [];
    const attack = enemy.basicAttack ? resolveBasicAttack(catalog, { actor: enemy.actor, basicAttack: enemy.basicAttack }) : undefined;
    if (attack) {
      Object.assign(effects, basicAttackEffects(catalog, attack));
      for (const name of Object.values(attack.clips)) clips.add(name);
      for (const step of attack.combo ?? []) for (const name of Object.values(step.clips)) clips.add(name);
    }
    for (const skill of [...enemySkills(enemy), ...(enemy.commandAction ? [enemy.commandAction] : [])]) {
      for (const name of Object.values(skill.clips ?? skillClips(skill.id))) clips.add(name);
      actions.push(skill.action);
      if (skill.companionAction) actions.push(skill.companionAction);
    }
    actors.push(...characterAssets(enemy.actor, clips));
    for (const action of actions)
      for (const name of skillEffectNames(action)) if (catalog.attackEffects[name]) effects[name] = catalog.attackEffects[name];
    const summons = new Set<string>();
    for (const action of actions) {
      for (const id of skillSummonNames(action)) summons.add(id);
      for (const unit of action.combatUnits ?? [])
        if (unit.effect === 'summon' && unit.creature) summons.add(unit.creature);
    }
    for (const id of summons) {
      const summoned = catalog.enemies.find(value => value.id === id);
      if (summoned) visit(summoned);
    }
    visiting.delete(enemy.id);
  };
  visit(definition);
  return [...actors, ...effectAssets(effects)];
}

/** 职业可能召唤的敌人 id：技能里的召唤事件与战斗单位里的召唤。传 `learnedSkills` 时只看已学技能。 */
export function classSummonEnemyIds(catalog: BattleCatalog, classId: string, learnedSkills?: ReadonlySet<string>): string[] {
  const character = catalog.classes.find(value => value.id === classId);
  if (!character) return [];
  return [...new Set(character.skills.filter(id => !learnedSkills || learnedSkills.has(id)).flatMap(skillId => {
    const skill = catalog.skills[skillId];
    return [skill?.action, skill?.followUpAction, skill?.companion?.action, skill?.companion?.followUpAction]
      .flatMap(action => action ? [...skillSummonNames(action), ...(action.combatUnits ?? []).flatMap(unit => unit.effect === 'summon' && unit.creature ? [unit.creature] : [])] : []);
  }))];
}

/** 装配后的普攻；装备只通过 hero.bag 读取，不依赖场景。 */
export function equipmentAttackFor(wardrobe: WardrobeCatalog, items: ItemCatalog, hero: BattleCharacter, actor: ActorDefinition, memberId = 'player', step = 0): ResolvedBasicAttack {
  return domainEquipmentAttackFor(wardrobe, items, hero.bag, actor, memberId, step);
}

interface PlayerCombatAssetInput {
  catalog: BattleCatalog;
  wardrobe: WardrobeCatalog;
  items: ItemCatalog;
  hero: BattleCharacter;
  actor: ActorDefinition;
  /** 已学技能 id；省略表示全部技能（构建期/未装备技能配置的调用）。 */
  learnedSkills?: ReadonlySet<string>;
}

/** 保留基础动作，只为已学技能保留对应的四向人物动画。 */
function classCombatClips(actor: ActorDefinition, character: BattleClass, learnedSkills?: ReadonlySet<string>): ClipName[] {
  if (!learnedSkills) return Object.keys(actor.clips) as ClipName[];
  const names = new Set((Object.keys(actor.clips) as ClipName[]).filter(name => !name.startsWith('skill-')));
  for (const id of character.skills) if (learnedSkills.has(id))
    for (const name of Object.values(skillClips(id))) names.add(name);
  return [...names];
}

/** 主角当前职业的战斗素材：角色、职业特效、已学技能姿态、召唤物与技能图标。 */
export function playerCombatAssets({ catalog, wardrobe, items, hero, actor, learnedSkills }: PlayerCombatAssetInput): PendingAsset[] {
  const character = catalog.classes.find(value => value.id === hero.classId);
  if (!character) throw new Error('主角职业缺少战斗定义');
  const effects = classEffects(catalog, character, equipmentAttackFor(wardrobe, items, hero, actor), wardrobe, learnedSkills);
  const recipe = costumeRecipe(wardrobe, items, hero.bag.equipmentItems(), hero.classId, actor.id);
  for (const profile of [recipe.dualWieldAttack, recipe.frenzyAttack])
    if (profile) Object.assign(effects, basicAttackEffects(catalog, profile));
  return [
    ...characterAssets(actor, classCombatClips(actor, character, learnedSkills)),
    ...effectAssets(effects),
    ...classSummonAssets(catalog, hero.classId, '主角召唤物定义缺失', learnedSkills),
    ...character.skills.map(id => ({ kind: 'image' as const, key: catalog.skills[id].icon, file: catalog.skills[id].icon }))
  ];
}

/** 队伍成员的战斗素材；控制权可能切换，所以每个成员的技能图标与召唤物都要提前装好。 */
export function partyMemberCombatAssets(catalog: BattleCatalog, wardrobe: WardrobeCatalog, classId: string, actor: ActorDefinition,
  learnedSkills?: ReadonlySet<string>, loadout?: { items: ItemCatalog; equipment: Partial<Record<EquipmentSlot, string>> }): PendingAsset[] {
  const character: BattleClass | undefined = catalog.classes.find(value => value.id === classId);
  if (!character) return [];
  const effects = classEffects(catalog, character, resolveBasicAttack(catalog, { actor, basicAttack: character.basicAttack }), wardrobe, learnedSkills);
  if (loadout) {
    const recipe = costumeRecipe(wardrobe, loadout.items, loadout.equipment, classId, actor.id);
    for (const profile of [recipe.attack, recipe.dualWieldAttack, recipe.frenzyAttack])
      if (profile) Object.assign(effects, basicAttackEffects(catalog, profile));
  } else {
    for (const profile of Object.values(wardrobe.dualWieldAttacks ?? {})) Object.assign(effects, basicAttackEffects(catalog, profile));
    for (const profile of Object.values(wardrobe.frenzyAttacks ?? {})) Object.assign(effects, basicAttackEffects(catalog, profile));
  }
  return [
    ...characterAssets(actor, classCombatClips(actor, character, learnedSkills)),
    ...effectAssets(effects),
    ...classSummonAssets(catalog, classId, '伙伴召唤物不存在', learnedSkills),
    ...character.skills.map(id => ({ kind: 'image' as const, key: catalog.skills[id].icon, file: catalog.skills[id].icon }))
  ];
}

function classSummonAssets(catalog: BattleCatalog, classId: string, missing: string,
  learnedSkills?: ReadonlySet<string>): PendingAsset[] {
  return classSummonEnemyIds(catalog, classId, learnedSkills).flatMap(id => {
    const definition = catalog.enemies.find(enemy => enemy.id === id);
    if (!definition) throw new Error(`${missing}：${id}`);
    return enemyCombatAssets(catalog, definition);
  });
}

/** 所有地图共用、不随职业/装备变化的战斗素材。 */
export function sharedCombatAssets(catalog: BattleCatalog, wardrobe: WardrobeCatalog): PendingAsset[] {
  return [
    ...combatOutcomeAssets(catalog),
    ...combatFeedbackAssets(catalog),
    ...effectAssets(sharedCombatEffectMap(catalog, wardrobe, false)),
    ...targetFocusAssets
  ];
}
