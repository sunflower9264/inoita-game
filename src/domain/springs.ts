/**
 * 恢复泉水。原版摆放记录里的"水井"在地图加载时会被换成泉水，玩家喝下后按一张
 * 效果表随机给奖励。规则来自 `CHAR_MakeSpring`（0x18c648）与 `CHAR_DrinkSpring`（0x18c6b4），
 * 内容由 `work/tools/game_content/springs.py` 从 `DROPEVTBASE`（game.dat 表 79）导出。
 */
import { BATTLE_BUFF_KEYS, type BattleBuffKey } from './battle-semantics.ts';

type SpringKind = 'heal' | 'heal-mana' | 'buff' | 'spawn' | 'skill-point';

/** 一档泉水。等级达到 `unlockLevel` 才有机会随机到它，所以等级越高水越杂。 */
interface SpringDefinition { id: string; name: string; unlockLevel: number }

/** 一条效果。同一档内按 `weight` 随机，`text` 是原版喝完那句提示。 */
interface SpringEffect {
  spring: string;
  kind: SpringKind;
  weight: number;
  text: string;
  /** `heal` 的回血百分比。 */
  percent?: number;
  /** `buff` 要施加的状态，取自 `BATTLE_BUFF_KEYS`。 */
  buff?: BattleBuffKey;
  /** `spawn` 要出现的敌人。 */
  enemy?: string;
  /** `skill-point` 加多少点。 */
  points?: number;
}

export interface SpringCatalog {
  version: number;
  /** 喝过之后换成的外观（原版把泉水改写成没有液体的水井，且它没有 NPC 功能）。 */
  empty: string;
  springs: SpringDefinition[];
  effects: SpringEffect[];
}

/** 泉水结算读写一名上阵队员的资源；佣兵没有技能点，所以 `grantSkillPoint` 可选。 */
export interface SpringPartyResources {
  id: string;
  player: { health: number; maxHealth: number; mana: number; maxMana: number };
  setHealth(value: number): void;
  setMana(value: number): void;
  grantSkillPoint?(): void;
}

/** 正面、按全队生效的泉水状态：回血、回蓝、回蓝加速、攻魔提升。 */
export const SPRING_PARTY_WIDE_BUFFS = [
  'spring-mana-recovery', 'spring-health-recovery', 'spring-mana-cost', 'spring-power-up',
] as const satisfies readonly BattleBuffKey[];

/**
 * 负面或攻防混合的泉水状态，只给喝下泉水的人：药水病、药效减半、技能封印，
 * 以及攻击上升但防御下降的疯癫。
 */
export const SPRING_SINGLE_TARGET_BUFFS = [
  'spring-potion-sickness', 'spring-potion-weakened', 'spring-skill-seal', 'spring-frenzy',
] as const satisfies readonly BattleBuffKey[];

export type SpringBuffScope = 'party' | 'single';

/** 未登记的状态按只作用于喝的人处理，避免以后新增的泉水状态误伤全队。 */
export function springBuffScope(key: BattleBuffKey): SpringBuffScope {
  return (SPRING_PARTY_WIDE_BUFFS as readonly BattleBuffKey[]).includes(key) ? 'party' : 'single';
}

/**
 * 按每名上阵队员自己的上限结算回血或回蓝，数值夹在 0 到上限之间。
 * 默认跳过已经倒下的成员，返回这次资源确实增加过的成员 id。
 */
export function applySpringRecovery(effect: { kind: SpringKind; percent?: number }, members: readonly SpringPartyResources[], includeFallen = false): string[] {
  if (effect.kind !== 'heal' && effect.kind !== 'heal-mana') return [];
  const percent = effect.percent ?? 0;
  if (!(percent > 0)) return [];
  const recovered: string[] = [];
  for (const member of members) {
    if (!includeFallen && member.player.health <= 0) continue;
    if (effect.kind === 'heal') {
      const before = member.player.health, max = member.player.maxHealth;
      const target = Math.max(0, Math.min(max, before + Math.round(max * percent / 100)));
      if (target === before) continue;
      member.setHealth(target);
      recovered.push(member.id);
    } else {
      const before = member.player.mana, max = member.player.maxMana;
      const target = Math.max(0, Math.min(max, before + Math.round(max * percent / 100)));
      if (target === before) continue;
      member.setMana(target);
      recovered.push(member.id);
    }
  }
  return recovered;
}

/**
 * 技能点只属于主角：佣兵没有技能点系统，即使传入也不会被加。
 * 返回真正拿到技能点的成员 id。
 */
export function grantSpringSkillPoint(members: readonly SpringPartyResources[]): string[] {
  const granted: string[] = [];
  for (const member of members) {
    if (member.id !== 'player' || member.player.health <= 0 || !member.grantSkillPoint) continue;
    member.grantSkillPoint();
    granted.push(member.id);
  }
  return granted;
}

export function parseSprings(value: unknown): SpringCatalog {
  const catalog = value as SpringCatalog;
  if (catalog?.version !== 1 || !Array.isArray(catalog.springs) || !Array.isArray(catalog.effects))
    throw new Error('泉水内容格式不正确');
  if (!catalog.empty) throw new Error('泉水内容缺少喝空后的外观');
  for (const spring of catalog.springs)
    if (!spring.id || !spring.name || !(spring.unlockLevel > 0)) throw new Error(`泉水档位不正确：${spring.id}`);
  for (const effect of catalog.effects) {
    if (!catalog.springs.some(spring => spring.id === effect.spring)) throw new Error(`泉水效果挂到了不存在的档位：${effect.spring}`);
    if (!(effect.weight > 0) || !effect.text) throw new Error(`泉水效果不完整：${effect.spring}`);
    if (effect.kind === 'buff' && (!effect.buff || !BATTLE_BUFF_KEYS.includes(effect.buff)))
      throw new Error(`泉水效果缺少有效状态：${effect.spring}`);
  }
  return catalog;
}

/** 原版 `CHAR_MakeSpring`：按角色等级决定这次最高能到哪一档，再在最低档到该档之间随机。 */
export function rollSpring(catalog: SpringCatalog, level: number, random: () => number): SpringDefinition {
  const unlocked = catalog.springs.filter(spring => level >= spring.unlockLevel);
  if (!unlocked.length) throw new Error(`没有等级 ${level} 能喝到的泉水`);
  return unlocked[Math.min(unlocked.length - 1, Math.floor(random() * unlocked.length))];
}

/**
 * 原版 `CHAR_DrinkSpring`：在这一档的候选效果里按权重随机一条。
 *
 * 原版掷的是 0..9999 的定值骰，权重之和不足 10000 时会落空并走一条通用提示
 * （清澈、凉爽两档权重正好 10000，越高的档位落空概率越大）。这里按权重归一化，
 * 不做落空分支，差别记在 `work/findings/`。
 */
export function rollSpringEffect(catalog: SpringCatalog, spring: string, random: () => number): SpringEffect {
  const candidates = catalog.effects.filter(effect => effect.spring === spring);
  if (!candidates.length) throw new Error(`泉水 ${spring} 没有可用效果`);
  const total = candidates.reduce((sum, effect) => sum + effect.weight, 0);
  let roll = random() * total;
  for (const effect of candidates) {
    roll -= effect.weight;
    if (roll < 0) return effect;
  }
  return candidates[candidates.length - 1];
}

export interface SpringVisitsState { map?: string; used: string[] }

/**
 * 一次地图访问里喝空过的泉水。原版喝过就把这口泉水改成水井外观，重新进图时地图对象
 * 会重建，所以泉水和宝箱一样按"每次进图重置"记录（见 `work/findings/spring-empty-2026-10-13.md`）。
 */
export class SpringVisits {
  private map?: string;
  private readonly used = new Set<string>();
  get mapId(): string | undefined { return this.map; }
  captureState(): SpringVisitsState { return { map: this.map, used: [...this.used] }; }
  restoreState(state: SpringVisitsState): void { this.map = state.map; this.used.clear(); for (const id of state.used) this.used.add(id); }
  enterMap(map: string): void { if (map === this.map) return; this.map = map; this.used.clear(); }
  isEmpty(map: string, entity: string): boolean { return this.map === map && this.used.has(entity); }
  drain(map: string, entity: string): void { if (map !== this.map) return; this.used.add(entity); }
}
