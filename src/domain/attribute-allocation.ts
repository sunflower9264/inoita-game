import { PRIMARY_STATS, type BattleCharacter, type PrimaryAttributes, type PrimaryStat } from './character-stats.ts';

const empty = (): PrimaryAttributes => ({ strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 });

/** Only this visit's additions can be undone; committed points belong to the character. */
export class AttributeAllocation {
  private readonly hero: BattleCharacter;
  private additions = empty();

  constructor(hero: BattleCharacter) { this.hero = hero; }

  get pending(): PrimaryAttributes { return { ...this.additions }; }
  get hasChanges(): boolean { return PRIMARY_STATS.some(stat => this.additions[stat] > 0); }
  get remainingPoints(): number {
    return this.hero.statPoints - PRIMARY_STATS.reduce((sum, stat) => sum + this.additions[stat], 0);
  }
  get attributes(): PrimaryAttributes {
    // 面板是角色的派生数据，预览只能改副本；不能把本轮加点写回角色缓存。
    const values = { ...this.hero.panel.attributes };
    for (const stat of PRIMARY_STATS) values[stat] += this.additions[stat];
    return values;
  }

  change(stat: PrimaryStat, delta: 1 | -1): void {
    if (!PRIMARY_STATS.includes(stat) || (delta !== 1 && delta !== -1)) throw new Error('属性操作无效');
    if (delta === 1 && this.remainingPoints < 1) throw new Error('没有可分配的能力点');
    if (delta === -1 && this.additions[stat] < 1) throw new Error('该属性没有待确认的点数');
    this.additions[stat] += delta;
  }

  commit(): void {
    const delta = this.additions;
    this.additions = empty();
    try { this.hero.commitAllocation(delta); }
    catch (error) { this.additions = delta; throw error; }
  }

  cancel(): void { this.additions = empty(); }
}
