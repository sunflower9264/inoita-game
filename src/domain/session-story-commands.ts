import type { Bag, BagState } from './bag.ts';
import type { BattleCharacter, BattleCharacterState } from './character-stats.ts';
import type { ChestVisitsState } from './chests.ts';
import type { CombatCooldownStore } from './combat-cooldowns.ts';
import type { FrenzyAnimationMemory } from './frenzy-animation.ts';
import type { GroundLootState } from './ground-loot.ts';
import type { EquipmentSlot } from './items.ts';
import type { LootPity, LootPityState } from './loot-pity.ts';
import type { PartyRoster } from './party.ts';
import type { QuestBookCheckpoint, QuestSettlement } from './quest-book.ts';
import type { EnemyState } from './session-enemies.ts';
import type { ShopVisitsState } from './shop.ts';
import type { SkillConfigurationState } from './skill-configuration.ts';
import { boundedHealth } from './status-hud.ts';
import type { StoryCommand } from './story-graph.ts';
import type { StoryPlayerState } from './story-interface.ts';
import type { StoryRuntimeSnapshot } from './story-runtime.ts';
import type { StoryWorldSnapshot } from './story-world.ts';

/** 剧情命令会改到的会话子系统；批次开始时只抓这些的旧值。 */
export type StorySubsystem = 'bag' | 'hero' | 'skills' | 'party' | 'lootPity' | 'storyWorld' | 'enemies' | 'groundLoot'
  | 'questBook' | 'coins' | 'receipts' | 'reservedDrops' | 'playerState' | 'runtimeSnapshot';

/** `atomic` 能回滚的子系统：剧情命令会碰到的全集，再加上商店货架与宝箱。 */
export type AtomicSubsystem = StorySubsystem | 'shops' | 'chests';

/** 一次剧情命令提交的回执：`StoryDirector` 在分支求值失败时用它恢复到提交前。 */
export interface StoryCommitReceipt {
  /** 丢掉旧值；普通调用方在返回前已经调用。 */
  finalize(): void;
  /** 恢复这次碰到的子系统；已 finalize 后为空操作。 */
  rollback(): void;
}

export interface StoryCommandBaseline {
  bag?: BagState;
  hero?: BattleCharacterState;
  skills?: SkillConfigurationState;
  restoreParty?: () => void;
  departures?: Map<string, () => void>;
  quests?: QuestBookCheckpoint;
  world?: StoryWorldSnapshot;
  /** 交付人可见性版本；随世界快照一起回滚，避免失败事务留下领先的投影信号。 */
  visitorReleaseRevision?: number;
  /** 完成遭遇被历史上限裁掉时，同一批次会删除它的一次性敌人状态；回滚必须一起恢复。 */
  enemies?: [string, EnemyState][];
  /** 选择标识的写入次数；和世界快照一起回滚，避免取消演出后留下假的“又选了一次”。 */
  choiceWrites?: [string, number][];
  loot?: GroundLootState;
  coins?: number;
  /** 任务 id → 捕获时的最新一张收据。 */
  receipts?: [string, QuestSettlement][];
  reservedDrops?: { unlockMisses: number; claimed: string[] };
  lootPity?: LootPityState;
  playerState?: Readonly<StoryPlayerState>;
  runtime?: StoryRuntimeSnapshot;
  shops?: ShopVisitsState;
  chests?: ChestVisitsState;
}

export interface AtomicFrame {
  touched: Set<AtomicSubsystem>;
  baseline: StoryCommandBaseline;
  groundMaps?: Map<string, () => void>;
}

/** 命令静态会碰到的子系统；比运行时实际改动多抓是安全的，少抓会漏回滚。 */
export function storyCommandSubsystems(command: StoryCommand): readonly StorySubsystem[] {
  switch (command.type) {
    case 'interaction': case 'talk': return ['questBook'];
    case 'quest': {
      switch (command.command.type) {
        case 'fact': case 'refresh': case 'reset': case 'script-ready':
          return ['questBook'];
        case 'accept': return ['questBook', 'bag', 'reservedDrops'];
        case 'complete': case 'script-complete': return ['questBook', 'bag', 'hero', 'skills', 'coins', 'receipts', 'reservedDrops'];
        case 'reset-side-quests': return ['questBook', 'bag'];
      }
      return ['questBook'];
    }
    case 'item-give': return ['bag', 'reservedDrops'];
    case 'item-take': return ['bag'];
    case 'money-give': case 'money-take': return ['coins'];
    case 'item-drop': return ['groundLoot'];
    case 'flag': case 'choice': case 'travel': case 'encounter': return ['storyWorld'];
    case 'world': return command.command.kind === 'encounter-result' ? ['storyWorld', 'enemies'] : ['storyWorld'];
    case 'party-join': case 'party-leave': return ['party', 'bag', 'lootPity'];
    case 'party-control': return ['party'];
    case 'health': case 'mana': return ['hero', 'party', 'playerState'];
    case 'equip': case 'unequip-destroy': return ['bag'];
  }
}

export interface ActorStoryCommandContext {
  bag: Bag;
  hero?: BattleCharacter;
  party?: PartyRoster;
  fallback?: StoryPlayerState;
  fallbackClassId?: string;
  lootPity: LootPity;
}

export function applyActorStoryCommand(command: StoryCommand, context: ActorStoryCommandContext): void {
  const { bag, hero, party, fallback, fallbackClassId, lootPity } = context;
  if (command.type === 'party-join') {
    if (!party) throw new Error('剧情队伍能力尚未装配');
    party.joinStory(command.companion);
    lootPity.counters(`story-${command.companion}`);
    return;
  }
  if (command.type === 'health' || command.type === 'mana') {
    const actor = command.member === 'player' ? hero : party?.get(command.member);
    const player = actor?.player ?? (command.member === 'player' ? fallback : undefined);
    if (!player) throw new Error('剧情人物状态对象不存在');
    if (command.value !== 'full' && (!Number.isSafeInteger(command.value) || command.value < 0)) throw new Error('剧情人物状态数值无效');
    if (command.type === 'health') {
      const value = command.value === 'full' ? player.maxHealth : command.value;
      if (actor) actor.setHealth(value);
      else fallback!.health = boundedHealth(value, player.maxHealth);
    } else {
      const value = command.value === 'full' ? player.maxMana : command.value;
      if (actor) actor.setMana(value);
      else fallback!.mana = Math.min(value, player.maxMana);
    }
    return;
  }
  if (command.type === 'party-control') {
    if (party) {
      if (!party.switchControl(command.member)) throw new Error('剧情不能切换到未上阵或已倒下的成员');
    } else if (command.member !== 'player' || (hero?.player.health ?? fallback?.health ?? 0) <= 0) {
      throw new Error('剧情操控角色不存在或已倒下');
    }
    return;
  }
  if (command.type === 'unequip-destroy') {
    if (command.member !== 'player' && !party?.get(command.member)) {
      if (command.ifPresent) return;
      throw new Error('剧情装备拥有者不存在');
    }
    // 先记下命中槽位和实例：卸主手会级联卸下双持副手，那一轮槽位已经空了，
    // 但快照里的副手实例仍在背包里，仍要按命令销毁。
    const targets = Object.entries(bag.equipmentItems(bag.equipmentFor(command.member)))
      .filter(([, item]) => item === command.item)
      .map(([slot]) => [slot as EquipmentSlot, bag.equipmentFor(command.member)[slot as EquipmentSlot]] as const);
    for (const [slot, id] of targets) {
      if (!id) continue;
      if (bag.equipmentFor(command.member)[slot] === id) bag.unequipForStory(slot, command.member);
      if (bag.get(id)) bag.take(id, 1);
    }
    return;
  }
  if (command.type === 'equip') {
    if (command.member !== 'player' && !party?.get(command.member) && command.ifPresent) return;
    const actor = command.member === 'player' ? hero : party?.get(command.member);
    const classId = actor?.classId ?? (command.member === 'player' ? fallbackClassId : undefined);
    const level = actor?.player.level ?? fallback?.level;
    if (!classId) throw new Error('剧情装备拥有者不存在');
    if (command.create) {
      if (bag.equipmentFor(command.member)[command.slot]) bag.unequipForStory(command.slot, command.member);
      bag.addEquipped(command.item, command.slot, command.member, classId, level);
      return;
    }
    const entry = bag.entries.find(value => value.item === command.item);
    if (!entry) throw new Error('剧情指定装备不在背包中');
    bag.equipForStory(entry.id, command.slot, command.member, classId, level);
  }
}

export interface LeaveCompanionContext {
  party?: PartyRoster;
  cooldowns: CombatCooldownStore;
  frenzyAnimations: FrenzyAnimationMemory;
  lootPity: LootPity;
  performanceLogging: boolean;
  storyCommandDepth: number;
  performanceBaseline: StoryCommandBaseline;
}

export function leaveStoryCompanionWithBaseline(
  companion: string,
  baseline: StoryCommandBaseline,
  context: LeaveCompanionContext,
): void {
  const { party, cooldowns, frenzyAnimations, lootPity, performanceLogging, storyCommandDepth, performanceBaseline } = context;
  if (!party) throw new Error('剧情队伍能力尚未装配');
  const actorId = `story-${companion}`;
  if (party.get(actorId)) {
    const remember = (state: StoryCommandBaseline) => {
      const departures = state.departures ??= new Map();
      if (departures.has(actorId)) return;
      const cooldownRestore = cooldowns.checkpointActor(actorId);
      const animationRestore = frenzyAnimations.checkpointActor(actorId);
      departures.set(actorId, () => { cooldownRestore(); animationRestore(); });
    };
    remember(baseline);
    if (performanceLogging && !storyCommandDepth) remember(performanceBaseline);
  }
  party.leaveStory(companion);
  lootPity.removeMember(actorId);
}
