import type { ActorDefinition } from '../domain/content.ts';
import {
  skillForGrowth,
  type AttackEffectDefinition,
  type BasicAttackDefinition,
  type BattleCatalog,
  type BattleClass,
  type ResolvedBasicAttack
} from '../domain/battle.ts';
import { buffEffectNames } from '../domain/buff-effects.ts';
import { feedbackEffects } from '../domain/combat-feedback.ts';
import { COMBAT_OUTCOME_EFFECTS } from '../domain/combat-outcomes.ts';
import { skillEffectNames } from '../domain/skill-action.ts';
import { skillReactionEffects } from '../domain/skill-reactions.ts';
import type { WardrobeCatalog } from '../domain/wardrobe.ts';
import type { PendingAsset } from './scene-assets.ts';

/**
 * 战斗素材清单的纯数据层：只读内容目录和领域模型，不接触 Phaser。
 * 运行时预载、常驻包和构建期覆盖校验共用这里的同一套描述符。
 */
export type EffectMap = Record<string, AttackEffectDefinition>;

export function characterAssets(actor: ActorDefinition): PendingAsset[] {
  return Object.values(actor.clips).flatMap(clip => clip ? clip.layers
    // 空文件是运行时由 Wardrobe 生成的动态纹理，不能交给 loader。
    .filter(layer => !!layer.file)
    .map(layer => ({
      kind: 'spritesheet' as const, key: layer.key, file: layer.file,
      config: { frameWidth: clip.frameWidth, frameHeight: clip.frameHeight, endFrame: clip.frames - 1 }
    })) : []);
}

export function effectAssets(effects: Readonly<Record<string, AttackEffectDefinition | undefined>>): PendingAsset[] {
  return Object.values(effects).flatMap(effect => effect ? Object.values(effect.clips).flatMap(clip =>
    clip.layers.map(layer => ({
      kind: 'spritesheet' as const, key: layer.key, file: layer.file,
      config: { frameWidth: clip.frameWidth, frameHeight: clip.frameHeight, endFrame: clip.frames - 1 }
    }))) : []);
}

/** 玩家和怪物共用的普攻资源收集。 */
export function basicAttackEffects(catalog: BattleCatalog, attack: BasicAttackDefinition): EffectMap {
  const names = new Set([...attack.swings, ...attack.impacts, ...(attack.targetEffects ?? []).map(effect => effect.effect)]);
  for (const effect of attack.dispatch?.casterEffects ?? []) names.add(effect.effect);
  if (attack.projectile) names.add(attack.projectile.effect);
  if (attack.transition?.effect) names.add(attack.transition.effect);
  if (attack.transition?.actionEffect) names.add(attack.transition.actionEffect);
  return Object.fromEntries([...names].filter(name => catalog.attackEffects[name]).map(name => [name, catalog.attackEffects[name]]));
}

/**
 * 当前职业可能用到的特效：技能（含私有追击与伙伴成长分支）、反应，以及这个职业的**全部武器姿态**。
 * 姿态按职业而不是按当前操控者收集，队友与主角因此共用同一份集合。
 */
export function classEffects(catalog: BattleCatalog, character: BattleClass, attack: ResolvedBasicAttack,
  wardrobe?: WardrobeCatalog): EffectMap {
  const names = new Set(Object.keys(basicAttackEffects(catalog, attack)));
  if (catalog.attackEffects['life-drain']) names.add('life-drain');
  for (const id of character.skills) {
    const skill = catalog.skills[id];
    for (const profile of [skill, ...(skill.companion ? [skillForGrowth(skill, 'companion')] : [])]) {
      for (const name of skillReactionEffects(profile)) names.add(name);
      if (profile.action) for (const name of skillEffectNames(profile.action)) names.add(name);
      if (profile.followUpAction) for (const name of skillEffectNames(profile.followUpAction)) names.add(name);
    }
  }
  for (const stance of Object.values(wardrobe?.skillStances?.[character.id] ?? {}))
    for (const action of Object.values(stance.actions ?? {})) if (action)
      for (const name of skillEffectNames(action)) names.add(name);
  return Object.fromEntries([...names].filter(name => catalog.attackEffects[name]).map(name => [name, catalog.attackEffects[name]]));
}

/** 所有武器普攻（单手、双持、狂暴）、状态攻击增益会用到的特效。 */
export function sharedCombatEffectMap(catalog: BattleCatalog, wardrobe: WardrobeCatalog): EffectMap {
  const effects: EffectMap = {};
  for (const profile of Object.values(wardrobe.attacks)) Object.assign(effects, basicAttackEffects(catalog, profile));
  for (const profile of Object.values(wardrobe.dualWieldAttacks ?? {})) Object.assign(effects, basicAttackEffects(catalog, profile));
  for (const profile of Object.values(wardrobe.frenzyAttacks ?? {})) Object.assign(effects, basicAttackEffects(catalog, profile));
  for (const value of Object.values(catalog.statusAttackBuffs ?? {}))
    for (const name of buffEffectNames(value))
      if (catalog.attackEffects[name]) effects[name] = catalog.attackEffects[name];
  return effects;
}

export function combatFeedbackAssets(catalog: BattleCatalog): PendingAsset[] {
  const names = feedbackEffects(catalog.feedback);
  return effectAssets(Object.fromEntries(names.map(name => [name, catalog.attackEffects[name]])));
}

export function combatOutcomeAssets(catalog: BattleCatalog): PendingAsset[] {
  return effectAssets(Object.fromEntries(COMBAT_OUTCOME_EFFECTS.map(name => [name, catalog.attackEffects[name]])));
}
