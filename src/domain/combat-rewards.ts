import type { EnemyDefinition } from './battle.ts';
import type { CharacterStatsCatalog } from './character-stats.ts';
import { calculateEnemy } from './enemy-stats.ts';
import type { DropCatalog, DropModifiers, DropReward, PityConfig, QuestDropRequirement } from './drops.ts';
import { breakableKindOf, firstBossGuarantee, rollBreakableLoot, rollEnemyLoot, rollQuestDrops, rollReservedDrops, specialDropEligibility } from './drops.ts';
import type { LootPityConfig, PityEligibility } from './loot-pity.ts';

/**
 * 结算需要的保底状态。`LootPity` 直接满足这份接口；测试可以传只读替身。
 * 首杀记录由这里推进，因为它决定本次掉落是否必中。
 */
interface CombatRewardPity {
  takeBossFirstDefeat(enemyId: string): boolean;
  equipmentBonus(ownerId: string, config: LootPityConfig): number;
  uniqueBonus(ownerId: string, config: LootPityConfig): number;
  epicBonus(ownerId: string, config: LootPityConfig): number;
  uniqueGuaranteed(ownerId: string, config: LootPityConfig, points?: number): boolean;
  epicGuaranteed(ownerId: string, config: LootPityConfig, points?: number): boolean;
}

/** 存活上阵成员；等级用于个人掉落与经验分配。 */
interface CombatRewardMember {
  id: string;
  level: number;
}

interface CombatRewardInput {
  /** 被击杀的敌人定义；经验按定义里的基础数值计算。 */
  enemy: EnemyDefinition;
  /** 是否有地图生成点。没有生成点时仍可给经验，但不写击杀记录、不掷掉落。 */
  hasSpawn: boolean;
  /** 挑战模式的临时怪没有地图生成点，但仍按普通击杀结算掉落。 */
  pressureMode?: boolean;
  oneTime?: boolean;
  enemyLevel: number;
  elite: boolean;
  heroLevel: number;
  map: string;
  x: number;
  y: number;
  /** 地图掉落等级；0 或缺省表示沿用规则等级/玩家等级。 */
  lootLevel?: number;
  partySize: number;
  /** 击杀者属于队伍或友方召唤物。 */
  earnsExperience: boolean;
  party: readonly CombatRewardMember[];
  modifiers?: DropModifiers;
  itemChance?: number;
  drops: DropCatalog;
  stats: CharacterStatsCatalog;
  random: () => number;
  questRequirements: readonly (readonly QuestDropRequirement[])[];
  pity: CombatRewardPity;
  reserved: {
    misses: number;
    claimed: ReadonlySet<string>;
    pending: ReadonlySet<string>;
  };
}

/** 一名成员的普通掉落。落点偏移由场景按 `slot` 决定。 */
interface CombatRewardOwnerGroup {
  ownerId: string;
  slot: number;
  rewards: DropReward[];
}

interface CombatRewardBreakable {
  rewards: DropReward[];
  enemies: string[];
}

interface CombatRewardPityRecord {
  ownerId: string;
  equipment: boolean;
  bestRarity: number;
  eligibility: PityEligibility;
  points: number;
}

interface CombatRewardSettlement {
  /** 本次击杀应发放的经验；景物怪、非队伍击杀和 0 经验敌人返回 0。 */
  experience: number;
  isBreakable: boolean;
  /** 景物怪的石块/木箱掉落；普通敌人为 undefined。 */
  breakable?: CombatRewardBreakable;
  /** 普通掉落，按上阵成员顺序排列。 */
  owners: CombatRewardOwnerGroup[];
  /** 付费道具独立通道的掉落。 */
  reserved: DropReward[];
  /** 任务掉落；每次击杀最多一件，不随队伍人数翻倍。 */
  quest: DropReward[];
  /** 结算出的保底记录，由调用方写回 LootPity。 */
  pityRecords: CombatRewardPityRecord[];
  /** 推进后的付费道具解锁保底计数；调用方写回会话。 */
  reservedUnlockMisses: number;
  /** 击杀音效提示；场景决定播放哪个音效。 */
  killSound: boolean;
}

/**
 * 击杀奖励结算：只算“掉什么、给谁、记什么账”，不碰场景、掉落落点和表现。
 * 随机源由调用方传入，纯 Node 下可用固定值复现。
 */
export function settleCombatRewards(input: CombatRewardInput): CombatRewardSettlement {
  const { enemy, drops, stats, random, pity } = input;
  const breakable = breakableKindOf(enemy.id);
  const rule = drops.enemies[enemy.id];
  const settlement: CombatRewardSettlement = {
    experience: breakable || !input.earnsExperience ? 0 : calculateEnemy(enemy, {
      level: input.enemyLevel, elite: input.elite,
      partySize: Math.max(1, input.partySize), playerLevel: input.heroLevel,
    }).experience,
    isBreakable: !!breakable,
    owners: [], reserved: [], quest: [], pityRecords: [],
    reservedUnlockMisses: input.reserved.misses,
    killSound: true,
  };
  if (!input.hasSpawn && !input.pressureMode) return settlement;

  const lootLevel = input.lootLevel ?? 0;
  if (breakable) {
    // 景物怪只掷一次：地图等级优先，地图没有有效等级时沿用玩家等级。
    const level = lootLevel > 0 ? lootLevel : input.heroLevel;
    const rolled = rollBreakableLoot(drops, stats, breakable, level, input.heroLevel, random, input.modifiers ?? {});
    settlement.breakable = { rewards: rolled.rewards, enemies: rolled.enemies };
  } else if (rule && !rule.noNormalDrops) {
    // 没有掉落规则或原版标记「无普通掉落」的敌人不掷骰，也不消耗首杀/保底计数。
    const chapterLevel = input.enemyLevel;
    const threat = rule.threat === 'boss' ? 'boss' : rule.threat === 'elite' || rule.paidDropEligible ? 'elite' : 'normal';
    const points = threat === 'boss' ? 2 : threat === 'elite' ? 1 : 0;
    const firstBoss = (rule.threat === 'boss' || (threat === 'elite' && input.oneTime)) ? pity.takeBossFirstDefeat(enemy.id) : false;
    const pityConfig: PityConfig | undefined = drops.pity;
    input.party.forEach((member, slot) => {
      const eligibility = specialDropEligibility(drops, input.heroLevel, input.enemyLevel, chapterLevel);
      const guarantee = firstBossGuarantee(pityConfig, firstBoss);
      const equipmentBonus = slot === 0 ? guarantee.equipmentBonus || (pityConfig ? pity.equipmentBonus('player',pityConfig) : 0) : 0;
      const uniqueBonus = slot === 0 && points && eligibility.withinWindow && eligibility.unique && pityConfig ? pity.uniqueBonus('player', pityConfig) : 0;
      const epicBonus = slot === 0 && points && eligibility.withinWindow && eligibility.epic && pityConfig ? pity.epicBonus('player', pityConfig) : 0;
      const uniqueGuarantee = slot === 0 && eligibility.unique && (firstBoss || !!(points && eligibility.withinWindow && pityConfig && pity.uniqueGuaranteed('player', pityConfig, points)));
      const epicGuarantee = slot === 0 && !!(points && eligibility.withinWindow && eligibility.epic && pityConfig && pity.epicGuaranteed('player', pityConfig, points));
      const rolled = rollEnemyLoot(drops, stats, enemy.id, member.level, chapterLevel, random,
        input.modifiers ?? {}, {
          equipmentBonus, uniqueBonus, uniqueGuarantee, epicBonus, epicGuarantee,
          minRarity: threat === 'boss' ? 2 : guarantee.minRarity, itemChance: input.itemChance, sourceLevel: input.enemyLevel, firstDefeat:slot===0&&firstBoss,
        });
      if(slot>0)rolled.rewards=rolled.rewards.filter(reward=>reward.kind!=='item'||!reward.roll);
      const equipment = rolled.rewards.filter(reward => reward.kind === 'item' && !!reward.roll);
      const bestRarity = equipment.reduce((best, reward) =>
        Math.max(best, reward.kind === 'item' && reward.roll ? reward.roll.rarity : 0), 0);
      settlement.owners.push({ ownerId: member.id, slot, rewards: rolled.rewards });
      if(slot===0)settlement.pityRecords.push({
        ownerId: 'player', equipment: equipment.length > 0, bestRarity, eligibility, points,
      });
    });
    const reservedSource = rule.threat === 'boss' ? 'boss'
      : rule.threat === 'elite' || rule.paidDropEligible ? 'elite' : undefined;
    if (reservedSource && drops.reservedDrops) {
      const reserved = rollReservedDrops(drops, stats, {
        source: reservedSource, heroLevel: input.heroLevel, sourceLevel: input.enemyLevel,
        pending: input.reserved.pending, claimed: input.reserved.claimed,
        unlockMisses: input.reserved.misses, random,
      });
      settlement.reserved = reserved.rewards;
      settlement.reservedUnlockMisses = reserved.unlockMisses;
    }
  }
  // 任务掉落保持共享：每次击杀最多一件，不随队伍人数翻倍。
  settlement.quest = rollQuestDrops(drops, enemy.id, input.questRequirements, random);
  return settlement;
}
