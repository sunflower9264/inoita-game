/**
 * 温和保底：连续没有出装备/黄装/紫装时，下一次的概率逐步提高，达到次数后必出。
 * 计数按成员、按存档保存；宝箱只维护装备计数，黄装/紫装保底只按敌人击杀累计。
 */
export interface PityCounters {
  equipmentMisses: number;
  /** 替代旧的 rarePlusMisses：连续没有黄装（unique）的次数。 */
  uniqueMisses: number;
  /** 连续没有紫装（epic）的次数；只在 59 级以上、有候选的合格击杀里累计。 */
  epicMisses: number;
}

export interface LootPityState {
  version: 2;
  members: [string, PityCounters][];
  chests: [string, PityCounters][];
  bossDefeats: string[];
}

/** 掉率/保底加值的单位都是 1/10000；stepPermille 这个名字是历史遗留。 */
export interface PityRate {
  stepPermille: number;
  capPermille: number;
}

export interface LootPityConfig {
  equipment: PityRate;
  unique: PityRate & { guaranteeAfter: number };
  epic: PityRate & { guaranteeAfter: number };
  levelWindow: number;
}

export interface PityEligibility {
  withinWindow: boolean;
  unique: boolean;
  epic: boolean;
}

const EMPTY = (): PityCounters => ({ equipmentMisses: 0, uniqueMisses: 0, epicMisses: 0 });
const clone = (value: PityCounters): PityCounters => ({ ...value });

export class LootPity {
  private readonly members = new Map<string, PityCounters>();
  private readonly chests = new Map<string, PityCounters>();
  private readonly bossDefeats = new Set<string>();

  counters(ownerId: string): PityCounters {
    let value = this.members.get(ownerId);
    if (!value) {
      value = EMPTY();
      this.members.set(ownerId, value);
    }
    return value;
  }

  chestCounters(key: string): PityCounters {
    let value = this.chests.get(key);
    if (!value) {
      value = EMPTY();
      this.chests.set(key, value);
    }
    return value;
  }

  /** 槽位的绝对加值（万分比），只加在对应槽位上。 */
  equipmentBonus(ownerId: string, config: LootPityConfig): number {
    return Math.min(this.counters(ownerId).equipmentMisses * config.equipment.stepPermille, config.equipment.capPermille);
  }

  uniqueBonus(ownerId: string, config: LootPityConfig): number {
    return Math.min(this.counters(ownerId).uniqueMisses * config.unique.stepPermille, config.unique.capPermille);
  }

  epicBonus(ownerId: string, config: LootPityConfig): number {
    return Math.min(this.counters(ownerId).epicMisses * config.epic.stepPermille, config.epic.capPermille);
  }

  /** 下一次合格击杀是否必须出黄装/紫装。 */
  uniqueGuaranteed(ownerId: string, config: LootPityConfig): boolean {
    return this.counters(ownerId).uniqueMisses + 1 >= config.unique.guaranteeAfter;
  }

  epicGuaranteed(ownerId: string, config: LootPityConfig): boolean {
    return this.counters(ownerId).epicMisses + 1 >= config.epic.guaranteeAfter;
  }

  chestEquipmentBonus(key: string, config: LootPityConfig): number {
    return Math.min(this.chestCounters(key).equipmentMisses * config.equipment.stepPermille, config.equipment.capPermille);
  }

  /**
   * 一次怪物结算：装备、黄装、紫装三本账各自累计和清零。
   * 蓝装不再清黄账；固定槽掉出的黄/紫装通过 bestRarity 正常刷新对应计数。
   */
  recordEnemy(ownerId: string, result: { equipment: boolean; bestRarity?: number }, eligibility: PityEligibility): void {
    if (!eligibility.withinWindow) return;
    const counters = this.counters(ownerId);
    if (result.equipment) counters.equipmentMisses = 0;
    else counters.equipmentMisses += 1;
    if ((result.bestRarity ?? 0) >= 3) counters.uniqueMisses = 0;
    else if (eligibility.unique) counters.uniqueMisses += 1;
    if ((result.bestRarity ?? 0) >= 4) counters.epicMisses = 0;
    else if (eligibility.epic) counters.epicMisses += 1;
  }

  recordChest(key: string, result: { equipment: boolean }): void {
    const counters = this.chestCounters(key);
    counters.equipmentMisses = result.equipment ? 0 : counters.equipmentMisses + 1;
  }

  /** 每个存档只对同一 Boss 触发一次首杀保底。 */
  takeBossFirstDefeat(enemyId: string): boolean {
    if (this.bossDefeats.has(enemyId)) return false;
    this.bossDefeats.add(enemyId);
    return true;
  }

  bossDefeated(enemyId: string): boolean {
    return this.bossDefeats.has(enemyId);
  }

  removeMember(ownerId: string): void {
    this.members.delete(ownerId);
  }

  captureState(): LootPityState {
    return {
      version: 2,
      members: [...this.members].map(([id, value]) => [id, clone(value)]),
      chests: [...this.chests].map(([id, value]) => [id, clone(value)]),
      bossDefeats: [...this.bossDefeats].sort(),
    };
  }

  restoreState(state: LootPityState): void {
    if (state?.version !== 2 || !Array.isArray(state.members) || !Array.isArray(state.chests)
      || !Array.isArray(state.bossDefeats)) throw new Error('掉落保底状态无效');
    const valid = (counter: PityCounters) => counter && Number.isSafeInteger(counter.equipmentMisses)
      && counter.equipmentMisses >= 0 && Number.isSafeInteger(counter.uniqueMisses) && counter.uniqueMisses >= 0
      && Number.isSafeInteger(counter.epicMisses) && counter.epicMisses >= 0;
    if (!state.members.every(([, counter]) => valid(counter)) || !state.chests.every(([, counter]) => valid(counter)))
      throw new Error('掉落保底计数无效');
    this.members.clear();
    this.chests.clear();
    this.bossDefeats.clear();
    for (const [id, value] of state.members) this.members.set(id, clone(value));
    for (const [id, value] of state.chests) this.chests.set(id, clone(value));
    for (const id of state.bossDefeats) this.bossDefeats.add(id);
  }
}
