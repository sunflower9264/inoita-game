import type { BattleBuffKey, BattleStatKey, BattleStateKey } from './battle-semantics.ts';
import type { CombatOperation } from './combat-operation.ts';
import type { StateDurationProfile } from './state-application.ts';

/**
 * 由已学等级提供子增益的那几个被动；与 `domain/skill-reactions` 的名单一一对应。
 * 写成 `as const` 数组是为了让类型与 `content-validation` 的校验共用同一份，不会各改各的。
 */
export const LEARNED_REACTION_SKILLS = ['bard-of-destruction', 'deep-breath', 'sniping', 'blood-revenge'] as const;
export type LearnedReactionSkillId = typeof LEARNED_REACTION_SKILLS[number];

/**
 * 其中会被增益的 `onAccepted` 引用的三个。血之复仇不在这条路上——它走自伤单元的
 * `alsoAppliesLearnedBuff`，所以两张名单本来就不该一样大。
 */
export const ACCEPTED_LEARNED_BUFF_SKILLS =
  ['bard-of-destruction', 'deep-breath', 'sniping'] as const satisfies readonly LearnedReactionSkillId[];
type AcceptedLearnedBuffSkillId = typeof ACCEPTED_LEARNED_BUFF_SKILLS[number];

export interface BuffReactionBuff {
  key: BattleBuffKey;
  rankPriority: number;
  effect: BattleBuffEffect;
}

/** 当前生效的 Buff 可以创建独立子 Buff、恢复资源，或改变本次命中的仇恨分配。 */
export type BuffReaction =
  | { kind: 'physical-avoidance' | 'physical-success-party'; buff: BuffReactionBuff }
  | { kind: 'mana-on-physical-success'; amount: number; effect: string }
  | { kind: 'weapon-block-counter'; buff: BuffReactionBuff }
  | { kind: 'weapon-block-stun'; state: BattleStateKey; durationAttribute: BattleStatKey }
  | { kind: 'physical-success-threat' };

export interface BattleBuffEffect {
  durationMs: number;
  tickMs: number;
  appearanceColors?: { red: number; green: number; blue: number }[];
  /** 按 60ms 战斗逻辑步计龄；首步为零，超过最后有效步时移除。 */
  simulationFrames?: { lastActiveFrame: number; pulseIntervalFrames?: number; /** 存活检查与计龄之后触发周期效果。 */ pulseAfterAgeIncrement?: boolean };
  applicationEffect?: string;
  /** 挂载初始化入口先保存生命上限，按运算结果与该快照的差额恢复生命。 */
  onApply?: ({ kind: 'restore-health-from-max-health'; operation: CombatOperation }
    /** 立即给当前 MP 加这份定值；弱拒绝时不会执行。 */
    | { kind: 'add-mana'; value: number })[];
  /** 本条增益被接受之后才执行的动作；被拒绝时（例如更低等级）什么都不做。 */
  onAccepted?: { kind: 'apply-learned-buff'; skill: AcceptedLearnedBuffSkillId; target: 'source' | 'target' }[];
  loopEffects?: { effect: string; firstFrameAge: number }[];
  reactions?: BuffReaction[];
  maxStacks?: number;
  modifiers: { attribute: BattleStatKey; operation: CombatOperation }[];
  invalidatesAttributes?: BattleStatKey[];
  /** 每过若干逻辑帧把同一次运算再叠一份；原版用于逐段恢复这类斜坡。 */
  attributeRamps?: { attribute: BattleStatKey; operation: CombatOperation; intervalFrames: number }[];
  /** 寿命上限按施法者的这一属性放大：上限帧 ×(1000+属性值)/1000 后截断（亲和精灵对自然之精灵）。 */
  durationRateFromOwner?: { attribute: BattleStatKey; baseFrames: number };
  /** 施放时把施法者这一属性按原版 15/10 换算成帧后加进寿命上限（深呼吸对隐之觉醒）。 */
  durationFramesFromOwner?: { attribute: BattleStatKey };
  states: BattleStateKey[];
  stateDurationProfiles?: Partial<Record<BattleStateKey, StateDurationProfile>>;
  periodic: (
    | { kind: 'fixed-damage'; amount: number }
    | { kind: 'magic-curse'; ratePerThousand: number; /** 每脉冲给恢复到的角色播的表现（AddLife 自带的吸血效果）。 */ healEffect?: string }
    | { kind: 'normal-damage'; operation: CombatOperation }
    | { kind: 'attack-damage'; source: 'physical' | 'magic'; operation: CombatOperation }
    | { kind: 'healing'; attribute: BattleStatKey; operation: CombatOperation }
    | { kind: 'attribute-damage'; attribute: BattleStatKey; operation: CombatOperation }
    | { kind: 'visual'; effect: string }
  )[];
}

export interface SkillReactionBuff {
  key: BattleBuffKey;
  rankPriority: number;
  effect: BattleBuffEffect;
}

export type SkillReaction =
  | { kind: 'soul-sword'; chanceThreshold: number; buffFromLearnedSkill: 'dark-strike';
      physicalEffects: string[]; magicEffects: string[] }
  | { kind: 'blood-sword'; lifeDrainPerThousand: number }
  | { kind: 'shield-of-rage'; buff: SkillReactionBuff }
  | { kind: 'flares-of-pain'; chanceThreshold: number; buff: SkillReactionBuff }
  | { kind: 'wrath-of-darkness'; chanceThreshold: number; buff: SkillReactionBuff }
  | { kind: 'dark-sense'; buff: SkillReactionBuff }
  | { kind: 'armor-penetration'; buff: SkillReactionBuff }
  | { kind: 'revenge-incarnate'; buff: SkillReactionBuff }
  | { kind: 'blood-thirst'; lifeEffect: 'life-drain'; manaEffect: 'mana-recovery' }
  | { kind: 'flare'; chanceThreshold: number; offhandChanceThreshold: number; stealthFromLearnedSkill: 'whist'; effect: string; unlearnedStealth: SkillReactionBuff }
  | { kind: 'clever-fellow'; chanceThreshold: number }
  | { kind: 'owner-mana-restore'; amount: number; effect: string }
  /** 信念之盾：物理两挡之后给固定三槽各施加一层子增益。 */
  | { kind: 'shield-of-trust'; buff: SkillReactionBuff }
  /** 血之复仇：同阵营挨打后，三个活动队伍槽里学过的人各自给自己叠一层。 */
  | { kind: 'blood-revenge'; buff: SkillReactionBuff }
  /** 破灭之魔甲：只提供子增益本体，什么时候建它由魔甲的接受结果决定。 */
  | { kind: 'bard-of-destruction'; buff: SkillReactionBuff }
  /** 深呼吸：同样只提供子增益本体，由隐之觉醒的接受结果决定何时建它。 */
  | { kind: 'deep-breath'; buff: SkillReactionBuff }
  /** 狙击：同样只提供子增益本体，由埋伏的接受结果决定何时建它。 */
  | { kind: 'sniping'; buff: SkillReactionBuff }
  /** 凝神之咒：直接治疗被接受之后按概率给受术者一层。 */
  | { kind: 'ordination-prayer'; chanceThreshold: number; buff: SkillReactionBuff }
  /** 魔法之眼：技能命中成功后给受击者一层魔抗削减，不抽概率也不看伤害。 */
  | { kind: 'magic-insight'; buff: SkillReactionBuff }
  /** 扰乱：受击方按阈值抽一次，抽中让同阵营里更扛打的人去拉走攻击者。 */
  | { kind: 'disturbance'; chanceThreshold: number }
  /** 地狱之落雷：已学等级提供概率阈值，combat-follow-ups 执行私有追击。 */
  | { kind: 'lightning-of-hell'; chanceThreshold: number }
  /** 神之定义：已学等级提供概率阈值，combat-follow-ups 执行天界之雷。 */
  | { kind: 'god-of-justice'; chanceThreshold: number };

export type SkillGrowthProfile = 'hero' | 'companion';

/** 队伍成员的成长身份保持不变，切换操控只改变输入归属。 */
export function memberSkillGrowth(memberId: string): SkillGrowthProfile {
  return memberId === 'player' ? 'hero' : 'companion';
}

/** 技能等级表。快捷栏不在这里：它每组六格、技能与物品共用，见 `shortcut-bar.ts`。 */
export interface SkillLoadout {
  levels: Record<string, number>;
}
