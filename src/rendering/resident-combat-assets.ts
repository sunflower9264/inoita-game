import { resolveBasicAttack } from '../domain/basic-attack.ts';
import type { BattleCatalog } from '../domain/battle.ts';
import { feedbackEffects } from '../domain/combat-feedback.ts';
import { COMBAT_OUTCOME_EFFECTS } from '../domain/combat-outcomes.ts';
import type { WorldIndex } from '../domain/content.ts';
import type { CompanionCatalog } from '../domain/party.ts';
import type { WardrobeCatalog } from '../domain/wardrobe.ts';
import { classSummonEnemyIds, enemyCombatAssets } from './combat-assets.ts';
import {
  characterAssets, classEffects, combatFeedbackAssets, combatOutcomeAssets, effectAssets,
  sharedCombatEffectMap, type EffectMap
} from './combat-asset-descriptors.ts';
import type { PendingAsset } from './scene-assets.ts';

export interface ResidentCombatInput {
  battle: BattleCatalog;
  wardrobe: WardrobeCatalog;
  world: WorldIndex;
  companions: CompanionCatalog;
  /**
   * 省略 = 全部职业（构建期全量校验）；运行时只传当前主角职业。
   * 伙伴外观始终全量，保留菜单实时预览。
   */
  classIds?: Iterable<string>;
}

/** 会话常驻的战斗视觉资源：一次加载，切图与战斗结束都不释放。 */
export interface CombatAssetPack {
  assets: PendingAsset[];
  /** 计划覆盖的特效名，构建期用它核对运行时引用。 */
  effectNames: Set<string>;
  actorIds: Set<string>;
}

/**
 * 玩家侧全部战斗视觉资源。职业、佣兵、武器、技能、技能姿态、召唤物和共享表现
 * 都与具体地图无关，因此和佣兵素材一样在首次进入世界时加载并常驻。
 *
 * 敌人素材随地图预取，不在这里。两边的纹理键必须唯一；同一键指向不同帧配置时
 * 直接报错，避免运行时静默用错帧数。
 */
export function residentCombatAssets(input: ResidentCombatInput): CombatAssetPack {
  const { battle, wardrobe, world, companions } = input;
  const assets = new Map<string, PendingAsset>();
  const effectNames = new Set<string>();
  const actorIds = new Set<string>();
  const addAssets = (list: readonly PendingAsset[]): void => {
    for (const asset of list) {
      const previous = assets.get(asset.key);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(asset)) throw new Error(`贴图键指向不同资源：${asset.key}`);
        continue;
      }
      assets.set(asset.key, asset);
    }
  };
  const addEffects = (effects: EffectMap): void => {
    for (const name of Object.keys(effects)) effectNames.add(name);
    addAssets(effectAssets(effects));
  };
  const addClass = (classId: string): void => {
    const character = battle.classes.find(value => value.id === classId);
    if (!character) return;
    actorIds.add(character.actor.id);
    addAssets(characterAssets(character.actor));
    const attack = resolveBasicAttack(battle, { actor: character.actor, basicAttack: character.basicAttack });
    addEffects(classEffects(battle, character, attack, wardrobe));
    for (const id of classSummonEnemyIds(battle, classId)) {
      const definition = battle.enemies.find(enemy => enemy.id === id);
      if (!definition) throw new Error(`召唤物定义缺失：${id}`);
      addAssets(enemyCombatAssets(battle, definition));
    }
    for (const skillId of character.skills) {
      const icon = battle.skills[skillId].icon;
      addAssets([{ kind: 'image', key: icon, file: icon }]);
    }
  };

  const shared = sharedCombatEffectMap(battle, wardrobe);
  addEffects(shared);
  for (const name of feedbackEffects(battle.feedback)) effectNames.add(name);
  for (const name of COMBAT_OUTCOME_EFFECTS) effectNames.add(name);
  addAssets(combatOutcomeAssets(battle));
  addAssets(combatFeedbackAssets(battle));
  const selectedClasses = input.classIds === undefined ? undefined : new Set(input.classIds);
  if (selectedClasses) for (const id of selectedClasses)
    if (!battle.classes.some(character => character.id === id)) throw new Error(`常驻战斗包职业不存在：${id}`);
  for (const character of battle.classes)
    if (!selectedClasses || selectedClasses.has(character.id)) addClass(character.id);
  // 佣兵的基础外观必须在入队前就绪；职业特效与召唤物已由上面的职业循环覆盖。
  for (const definition of Object.values(companions.definitions)) {
    const actor = world.actors[definition.actor];
    if (!actor) continue;
    actorIds.add(actor.id);
    addAssets(characterAssets(actor));
  }
  return { assets: [...assets.values()], effectNames, actorIds };
}
