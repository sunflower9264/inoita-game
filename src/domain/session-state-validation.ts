import { verifyBagState, type BagState } from './bag.ts';
import type { BattleCatalog } from './battle.ts';
import type { Campaign, CampaignQuest } from './campaign.ts';
import type { BattleCharacterState, CharacterStatsCatalog } from './character-stats.ts';
import { CompanionSkillProgression } from './companion-progression.ts';
import type { ItemCatalog } from './items.ts';
import type { CompanionCatalog, PartyRoster } from './party.ts';
import type { QuestBookState, QuestSettlement } from './quest-book.ts';
import type { SkillConfigurationState } from './skill-configuration.ts';
import type { EnemyState } from './session-enemies.ts';
import type { StoryRuntimeSnapshot } from './story-runtime.ts';
import type { StoryWorldSnapshot } from './story-world.ts';

interface InventoryValidationState {
  bag: BagState;
  party?: { members: { id: string }[] };
  legendaryWeapons?: { used: string[] };
}

interface SkillValidationState {
  skills: SkillConfigurationState;
  hero?: BattleCharacterState;
  party?: ReturnType<PartyRoster['captureState']>;
}

interface RestoreScalarValidationState {
  questBook: QuestBookState;
  trackedQuest?: string;
  receipts: QuestSettlement[];
  money: number;
  gameTimeMs: number;
  resourceRecovery: { elapsedMs: number; deadlineTick: number };
  enemies: [string, EnemyState][];
  storyWorld: StoryWorldSnapshot;
}

/**
 * 背包自身的不变量交给 `verifyBagState`；这里只补它判不了的两条——装备与快捷栏的拥有者
 * 必须是真实队员（要队伍名单），快捷栏引用的技能必须存在（要战斗技能表）。
 */
export function validateSessionInventoryState(
  state: InventoryValidationState,
  catalog: ItemCatalog,
  battle?: BattleCatalog,
): void {
  const bag = state.bag;
  verifyBagState(bag, catalog);
  const knownItems = Object.keys(catalog.items).length > 0;
  const owners = new Set(['player', ...(state.party?.members.map(member => member.id) ?? [])]);
  for (const [owner] of bag.companionEquipment) {
    if (!owners.has(owner)) throw new Error('背包装备的拥有者不存在');
  }
  for (const [owner, row] of bag.shortcuts) {
    if (!owners.has(owner)) throw new Error('快捷栏的拥有者不存在');
    for (const slot of row) {
      if (!slot) continue;
      if ((slot.kind === 'item' && knownItems && !catalog.items[slot.id]) || (slot.kind === 'skill' && battle && !battle.skills[slot.id])) {
        throw new Error('快捷栏引用不存在');
      }
    }
  }
  if (state.legendaryWeapons && (!Array.isArray(state.legendaryWeapons.used) || state.legendaryWeapons.used.some(key => typeof key !== 'string' || !key.includes(':')))) {
    throw new Error('已拔古剑记录无效');
  }
}

export function validateSessionSkillState(
  state: SkillValidationState,
  deps: {
    catalog: ItemCatalog;
    battle?: BattleCatalog;
    stats?: CharacterStatsCatalog;
    companions?: CompanionCatalog;
    partyDefinitions?: CompanionCatalog['definitions'];
  },
): void {
  const { catalog, battle, stats, companions, partyDefinitions } = deps;
  const validate = (skills: SkillConfigurationState) => {
    if (new Set(skills.loadouts.map(([id]) => id)).size !== skills.loadouts.length || new Set(skills.pages.map(([id]) => id)).size !== skills.pages.length) {
      throw new Error('检查点技能配置重复');
    }
    for (const [classId, loadout] of skills.loadouts) {
      const character = battle?.classes.find(value => value.id === classId);
      if (battle && !character) throw new Error('检查点技能职业不存在');
      for (const [id, level] of Object.entries(loadout.levels)) {
        const skill = battle?.skills[id];
        if (!Number.isSafeInteger(level) || level < 0 || (character && !character.skills.includes(id))
          || (battle && (!skill || (level > 0 && ![...skill.ranks, ...(skill.companion?.ranks ?? [])].some(rank => rank.level === level))))) {
          throw new Error('检查点技能引用或等级无效');
        }
      }
    }
    for (const [classId, page] of skills.pages) {
      if (!Number.isSafeInteger(page) || page < 0 || page > 1 || (battle && !battle.classes.some(value => value.id === classId))) {
        throw new Error('检查点技能组页码无效');
      }
    }
  };
  validate(state.skills);
  if (state.hero && stats && (!Number.isSafeInteger(state.hero.level) || state.hero.level < 1 || state.hero.level > stats.maxLevel)) {
    throw new Error('检查点角色等级无效');
  }
  if (state.party) {
    const shared = state.party.sharedUnlockedSkills;
    if (!Array.isArray(shared) || new Set(shared).size !== shared.length || shared.some(id =>
      typeof id !== 'string' || !Object.values(catalog.classSkills).some(skills => skills.includes(id)) || (battle && !battle.skills[id]))) {
      throw new Error('共享解锁技能记录无效');
    }
    const ids = new Set<string>();
    const definitions = partyDefinitions ?? companions?.definitions;
    for (const member of state.party.members) {
      if (!member.id || ids.has(member.id) || !definitions?.[member.definitionId]) throw new Error('检查点伙伴引用无效');
      ids.add(member.id);
      validate(member.skills);
      if (!['story', 'mercenary'].includes(member.source) || !Number.isSafeInteger(member.level) || member.level < 1 || (stats && member.level > stats.maxLevel)) {
        throw new Error('检查点伙伴等级或来源无效');
      }
      if (member.source === 'mercenary' && companions && stats) {
        const definition = companions.definitions[member.definitionId];
        const progression = new CompanionSkillProgression(member.generated.skillCaps, companions.generation.training, {
          classId: definition.classId, catalog: battle, pointsPerLevel: stats.skillPointsPerLevel, changed: () => {}, clearShortcuts: () => {},
        });
        progression.restoreBooks(member.skillBookLevels ?? {}, member.level);
        progression.restoreUnlocked(member.unlockedSkills ?? {});
        progression.restorePoints(member.skillPoints);
      }
    }
    for (const id of [...state.party.slots, ...state.party.rosterSlots]) {
      if (id && !ids.has(id)) throw new Error('检查点队伍格位引用无效');
    }
    if (state.party.selected !== 'player' && !ids.has(state.party.selected)) throw new Error('检查点操控伙伴不存在');
  }
}

export function validateSessionStoryLinks(campaign: Campaign, world: StoryWorldSnapshot, runtime: StoryRuntimeSnapshot): void {
  const encounters = new Map(world.encounters.map(encounter => [encounter.id, encounter]));
  const waiting = new Set<string>();
  for (const run of runtime.runs) {
    if (!run.waiting) continue;
    const encounter = encounters.get(run.waiting.encounter);
    if (!encounter || encounter.status !== 'active') throw new Error('检查点等待遭遇不存在或未处于战斗中');
    if (waiting.has(encounter.id)) throw new Error('检查点重复等待同一遭遇');
    waiting.add(encounter.id);
    const node = campaign.scripts[run.cursor.script]?.nodes.find(value => value.id === run.cursor.node);
    if (node?.exit.type !== 'waitEncounter' || encounter.id !== `${run.id}:${node.id}:${node.exit.encounter.id}`) {
      throw new Error('检查点等待遭遇与剧情节点不一致');
    }
    const declared = node.exit.outcomes;
    if (
      Object.keys(declared).length !== Object.keys(run.waiting.outcomes).length
      || Object.entries(declared).some(([key, ref]) => {
        const saved = run.waiting!.outcomes[key];
        return !saved || saved.script !== ref.script || saved.node !== ref.node;
      })
    ) {
      throw new Error('检查点遭遇结果与剧情出口不一致');
    }
  }
}

export function validateSessionRestoreScalars(
  restored: RestoreScalarValidationState,
  deps: { definition: (id: string) => CampaignQuest | undefined; catalog: ItemCatalog },
): void {
  if (restored.trackedQuest && !deps.definition(restored.trackedQuest)) throw new Error('检查点追踪未知任务');
  const rewardKeys = new Set<string>();
  const questProgress = new Map(restored.questBook.quests);
  const catalogItems = deps.catalog.items;
  const hasCatalogItems = Object.keys(catalogItems).length > 0;
  for (const receipt of restored.receipts) {
    const key = receipt.quest;
    if (!deps.definition(receipt.quest) || rewardKeys.has(key) || !Number.isSafeInteger(receipt.cycle) || receipt.cycle < 0) {
      throw new Error('检查点奖励记录无效');
    }
    const progress = questProgress.get(receipt.quest);
    if (!progress || !progress.completedCycles || receipt.cycle > progress.cycle) throw new Error('检查点奖励与任务周期不一致');
    if (
      !Number.isSafeInteger(receipt.reward.money) || receipt.reward.money < 0
      || !Number.isSafeInteger(receipt.reward.experience) || receipt.reward.experience < 0
      || receipt.reward.items.some(item => !item.item || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || (hasCatalogItems && !catalogItems[item.item]))
    ) {
      throw new Error('检查点奖励内容无效');
    }
    rewardKeys.add(key);
  }
  if (!Number.isSafeInteger(restored.money) || restored.money < 0 || !Number.isFinite(restored.gameTimeMs) || restored.gameTimeMs < 0) {
    throw new Error('检查点金币或时间无效');
  }
  if (!Number.isFinite(restored.resourceRecovery.elapsedMs) || restored.resourceRecovery.elapsedMs < 0 || !Number.isSafeInteger(restored.resourceRecovery.deadlineTick) || restored.resourceRecovery.deadlineTick < 0) {
    throw new Error('检查点恢复时钟无效');
  }
  if (
    new Set(restored.enemies.map(([id]) => id)).size !== restored.enemies.length
    || restored.enemies.some(([id, enemy]) =>
      !id
      || [enemy.health, enemy.mana].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))
      || (enemy.deadUntil !== undefined && enemy.deadUntil !== 'permanent' && (!Number.isFinite(enemy.deadUntil) || enemy.deadUntil < 0)))
  ) {
    throw new Error('检查点敌人状态无效');
  }
  if (
    restored.enemies.some(([, enemy]) =>
      enemy.offscreenRespawnAt !== undefined
      && (!Number.isFinite(enemy.offscreenRespawnAt) || enemy.offscreenRespawnAt < 0 || typeof enemy.deadUntil !== 'number' || enemy.offscreenRespawnAt > enemy.deadUntil || !!enemy.capture))
  ) {
    throw new Error('检查点敌人刷新时间无效');
  }
  if (
    restored.enemies.some(([, enemy]) =>
      enemy.capture !== undefined
      && (!enemy.capture || typeof enemy.capture.map !== 'string' || !enemy.capture.map
        || !Number.isSafeInteger(enemy.capture.visit) || enemy.capture.visit < 0
        || enemy.capture.visit > restored.storyWorld.mapVisit || enemy.deadUntil !== 'permanent'))
  ) {
    throw new Error('检查点捕捉来源无效');
  }
}
