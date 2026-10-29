import type { PrimaryAttributes } from './character-stats.ts';
import type { EnemyAttributes } from './enemy-stats.ts';
import type { StateApplicationRules } from './state-application.ts';
import type { ActorDefinition, ClipName, EffectClip, Facing } from './content.ts';
import type { BattleBuffKey, BattleStateKey, BattleStatKey } from './battle-semantics.ts';
import type { SkillReaction } from './skill-reactions.ts';
import type { BuffReaction } from './buff-reactions.ts';
import type { CombatFeedbackDefinition, HitEffectStyle } from './combat-feedback.ts';

/**
 * 一份普攻规则：武器动作、时序、距离与特效。多个角色可以引用同一份规则，
 * 各自的图片和周期由绑定与装配决定。
 */
export interface BasicAttackDefinition {
  /** 命中时读取攻击者属性；普攻只有一份等级公式。 */
  damage:NumericCombatUnit & {effect:'physical'|'magic'};
  dispatch?:ActionDispatchDefinition;
  hitEffectStyle?:HitEffectStyle;
  manaGemDrop?:'skill'|'weapon';
  /** 固定动画按完整素材帧播放；省略时由当前攻速决定周期。 */
  timing?:'fixed-animation';
  /** 出手时以自身为中心收集一批敌人，在一次派发内依次结算。 */
  targeting?:{target:'area';targetRangePx:number;targetRangeMetric:'octagonal-grid'};
  /** 一个逻辑帧的时长。逻辑帧是动作推进的一步，屏幕刷新率可以更高。 */
  frameDurationMs: number;
  /** 一次普攻占用的逻辑帧数，含挥动和末帧停留。 */
  cycleFrames: number;
  /** 八像素量化的接近距离，含近身余量。 */
  approachDistanceUnits: number;
  searchRadiusPx: number;
  /** 出手帧：挥击或发射投射物的逻辑帧。 */
  strikeFrame: number;
  /** 每击各自派发；动作周期可以在后续击之前结束。 */
  strikes?:{frame:number;hand:'main-hand'|'offhand'}[];
  /** 挥击特效帧；`null` 表示这个动作没有挥击。 */
  swingFrame: number | null;
  /** 同帧挥击特效在整次命中派发及其收尾之后播放。 */
  swingOrder?:'after-strike';
  projectilePlacement?: 'world' | 'above-characters';
  swingPlacement?: 'world' | 'above-characters';
  impactPlacement?: 'world' | 'attached';
  swings: string[];
  impacts: string[];
  /** 每次接触全部播放的目标效果；impacts 仍为随机命中池。 */
  targetEffects?: SkillVisualEffect[];
  transition?: SkillTransition;
  projectile: { effect: string; stepDistancePx: number; stepDurationMs: number; offsetX: number; offsetY: number } | null;
}
/** 角色对普攻规则的引用：用哪份规则，四方向分别播哪个角色动画。 */
export interface BasicAttackBinding {
  profileId: string;
  clips: Record<Facing, ClipName>;
}
/** 装配时解析出的普攻：规则、角色动画和按方向展开的逻辑帧序列。 */
export interface ResolvedBasicAttack extends BasicAttackDefinition {
  /** 有效周期帧数，不小于配置周期，且一定覆盖出手帧。 */
  readonly effectiveCycleFrames: number;
  readonly durationMs: number;
  readonly clips: Record<Facing, ClipName>;
  /** 每个方向的逻辑帧序列，条目是素材帧号，长度等于有效周期。 */
  readonly sequence: Record<Facing, number[]>;
}

/** 已选中替换动作但该装备组合没有人物动画时，仅等待动作结束。 */
export interface BasicAttackWait {kind:'animation-unavailable';durationFrames:number}
export type BasicAttackSelection=ResolvedBasicAttack|BasicAttackWait;
export interface AttackEffectDefinition {
  clips:Record<string,EffectClip>;
  attachmentPoint?:'feet'|'effect-anchor';
  attachedLifetime?:'action'|'character';
}

/** 技能的目标选择方式：自己、沿用当前目标、范围内多目标、队友或最优敌人。 */
type SkillTargetMode = 'current' | 'self' | 'area' | 'target-area' | 'ally-heal' | 'ally' | 'party' | 'party-ally' | 'enemy' | 'none';
/**
 * 特效画在哪一层。`attached` 挂在人物身上并跟随；`ground` 是地面层，在人物之下；
 * `above-characters` 是世界顶层，在人物之上。原版按效果记录里的层值区分后两者。
 */
export type EffectPlacement = 'attached' | 'ground' | 'above-characters';
/** 普攻摆放多一个 `world`：画在世界坐标、用默认深度。 */
export type AttackPlacement = EffectPlacement | 'world';
/** 特效作用对象与空间位置，独立于目标选择规则。 */
export interface SkillVisualEffect {
  effect: string;
  recipient: 'caster' | 'target';
  placement: EffectPlacement;
}
/** 一个特效触发项：定义作用范围和有序的视觉效果。 */
export interface SkillEffectCue {
  target: SkillTargetMode;
  targetRangePx: number;
  /** Adjacent units may share the immediately preceding target search. */
  targetSelection?: 'search' | 'reuse-previous';
  unitFeedbackPolicy?: 'always';
  sound?: string;
  /** 八方向近似距离按八像素取整；省略时使用圆形范围。 */
  targetRangeMetric?: 'octagonal-grid';
  effects: SkillVisualEffect[];
}
/** 一次动作派发的收尾；入口记录隐身，完成直接单元或发射过渡后按序执行。 */
export interface ActionDispatchDefinition {
  breaksStealth:boolean;
  casterEffects?:SkillVisualEffect[];
  shake?:boolean;
  vibrationMs?:number;
  sound?:string;
}
/** 在时间轴指定位置播放动作反馈，音效只由当前操控的施法者触发。 */
export interface SkillFeedbackEvent {
  kind:'feedback';
  frame:number;
  shake?:boolean;
  vibrationMs?:number;
  sound?:string;
}
/**
 * 技能动作里的一个执行事件。同一帧可以有多项，列表顺序就是原版的执行顺序。
 *
 * - `cast`：帧 0 的动作特效，挂在施法者身上；
 * - `units`：执行动作单元，按触发项选目标并放出它们的视觉效果；
 * - `caster`：动作单元之后附着到施法者自己的动作级特效；
 * - `swing`：四个挥击槽，按朝向预烘焙的那一版；
 * - `impact`：逐目标特效，画在每个候选目标的当前位置；
 * - `spawn`：从 `frame` 起每个逻辑帧到 `until` 为止，在施法者周围的随机位置生成一个特效；
 * - `screen`：把全屏填充色的透明度改成 `fillTransparency`（100 是全透明）。
 *
 * `spawn` 与 `screen` 来自专有处理器，动作表里没有对应的列。
 */
export type SkillEvent =
  | SkillFeedbackEvent
  | { kind: 'capture-targets'; frame: number; target: SkillTargetMode; targetRangePx: number; limit: number }
  | { kind: 'captured-effect'; frame: number; effect: string; placement: EffectPlacement }
  | { kind: 'summon'; frame: number; creatures: { enemyId: string }[]; placement: SummonPlacement; effect: string; dispatch?:ActionDispatchDefinition }
  | { kind: 'cast'; frame: number; effect: SkillVisualEffect }
  | { kind: 'units'; frame: number; cues: SkillEffectCue[]; dispatch?:ActionDispatchDefinition }
  | { kind: 'caster'; frame: number; effects: SkillVisualEffect[] }
  | { kind: 'swing'; frame: number; effects: SkillVisualEffect[] }
  | { kind: 'impact'; frame: number; target: SkillTargetMode; effect: SkillVisualEffect }
  | { kind: 'spawn'; frame: number; until: number; effect: string; placement: EffectPlacement; marginPx: number }
  | { kind: 'screen'; frame: number; fillTransparency: number };
/** 动作过渡：命中后由过渡对象放出的效果。 */
export interface SkillTransition {
  directional?: boolean;
  missEffects?: SkillVisualEffect[];
  /** 施法者自身的逐帧雷击：从施放帧起每逻辑帧在施法者实时位置加一个偏移生成一次。 */
  casterStrikes?: { effect: string; offsets: { x: number; y: number }[] };
  /** 过渡落点跟随哪个角色，省略表示跟随选中的敌人。 */
  anchor?: 'target' | 'caster';
  kind: 'stationary' | 'trace' | 'position';
  effect: string | null;
  actionEffect: string | null;
  switchFrame: number;
  stepDistancePx: number;
  offsetX: number;
  offsetY: number;
}

/** 召唤物先在施法者身边寻找落点，再按招式配置加偏移。单位均为世界像素。 */
export interface SummonPlacement {
  searchGapPx: number;
  searchExtentPx: number;
  offsetChoices: { x: number; y: number }[];
  jitterPx: number;
}

/** 突进在指定帧抵达预定落点；贴身时只做短促的顶身动作。 */
export interface SkillCharge {
  arrivalFrame: number;
  closeDistanceUnits: number;
  lungeDistancePx: number;
  stoppingDistanceUnits: number;
  gridSizePx: number;
}

export interface SkillAfterimages {
  frame: number;
  opacity: number;
  distancesPx: number[];
}

/** 每种运算只携带实际使用的参数。 */
export type CombatOperation =
  | {kind:'keep'}
  | {kind:'set'|'add'|'subtract';amount:number}
  | {kind:'multiply';factor:number}
  | {kind:'divide';divisor:number}
  | {kind:'multiply-thousandth'|'increase-thousandth'|'decrease-thousandth';ratePerThousand:number};
/** 各种目标持续规则下预先算好的状态最后有效逻辑步。 */
export interface StateDurationProfile {
  normal:{lastActiveFrame:number};
  targetShortened?:{lastActiveFrame:number};
  buffShortened?:{lastActiveFrame:number};
  buffAndTargetShortened?:{lastActiveFrame:number};
}
/** 召唤物按主人等级派生的属性；未列出的属性沿用召唤物自身的数据。 */
export interface SummonOwnerDerivation {
  /** 攻击 = trunc((每级×主人等级＋基础) × 本等级倍率/1000)。 */
  attack:{attribute:'physicalAttack'|'magicAttack';perLevel:number;flat:number};
  /** 生命上限 = 每级×主人等级＋基础。 */
  health:{perLevel:number;flat:number};
  physicalResistanceBonus:number;
  magicResistance:number;
}

/**
 * 由已学等级提供子增益的那几个被动；与 `domain/skill-reactions` 的名单一一对应。
 * 写成 `as const` 数组是为了让类型与 `content-validation` 的校验共用同一份，不会各改各的。
 */
export const LEARNED_REACTION_SKILLS = ['bard-of-destruction','deep-breath','sniping','blood-revenge'] as const;
export type LearnedReactionSkillId = typeof LEARNED_REACTION_SKILLS[number];
/**
 * 其中会被增益的 `onAccepted` 引用的三个。血之复仇不在这条路上——它走自伤单元的
 * `alsoAppliesLearnedBuff`，所以两张名单本来就不该一样大。
 */
export const ACCEPTED_LEARNED_BUFF_SKILLS =
  ['bard-of-destruction','deep-breath','sniping'] as const satisfies readonly LearnedReactionSkillId[];
type AcceptedLearnedBuffSkillId = typeof ACCEPTED_LEARNED_BUFF_SKILLS[number];

export interface BattleBuffEffect {
  durationMs:number;tickMs:number;appearanceColors?:{red:number;green:number;blue:number}[];
  /** 按 60ms 战斗逻辑步计龄；首步为零，超过最后有效步时移除。 */
  simulationFrames?:{lastActiveFrame:number;pulseIntervalFrames?:number;/** 存活检查与计龄之后触发周期效果。 */pulseAfterAgeIncrement?:boolean};
  applicationEffect?:string;
  /** 挂载初始化入口先保存生命上限，按运算结果与该快照的差额恢复生命。 */
  onApply?:({kind:'restore-health-from-max-health';operation:CombatOperation}
    /** 立即给当前 MP 加这份定值；弱拒绝时不会执行。 */
    |{kind:'add-mana';value:number})[];
  /** 本条增益被接受之后才执行的动作；被拒绝时（例如更低等级）什么都不做。 */
  onAccepted?:{kind:'apply-learned-buff';skill:AcceptedLearnedBuffSkillId;target:'source'|'target'}[];
  loopEffects?:{effect:string;firstFrameAge:number}[];
  reactions?:BuffReaction[];
  maxStacks?:number;
  modifiers:{attribute:BattleStatKey;operation:CombatOperation}[];
  invalidatesAttributes?:BattleStatKey[];
  /** 每过若干逻辑帧把同一次运算再叠一份；原版用于逐段恢复这类斜坡。 */
  attributeRamps?:{attribute:BattleStatKey;operation:CombatOperation;intervalFrames:number}[];
  /** 寿命上限按施法者的这一属性放大：上限帧 ×(1000+属性值)/1000 后截断（亲和精灵对自然之精灵）。 */
  durationRateFromOwner?:{attribute:BattleStatKey;baseFrames:number};
  /** 施放时把施法者这一属性按原版 15/10 换算成帧后加进寿命上限（深呼吸对隐之觉醒）。 */
  durationFramesFromOwner?:{attribute:BattleStatKey};
  states:BattleStateKey[];
  stateDurationProfiles?:Partial<Record<BattleStateKey,StateDurationProfile>>;
  periodic:(
    | {kind:'fixed-damage';amount:number}
    | {kind:'magic-curse';ratePerThousand:number;/** 每脉冲给恢复到的角色播的表现（AddLife 自带的吸血效果）。 */healEffect?:string}
    | {kind:'normal-damage';operation:CombatOperation}
    | {kind:'attack-damage';source:'physical'|'magic';operation:CombatOperation}
    | {kind:'healing';attribute:BattleStatKey;operation:CombatOperation}
    | {kind:'attribute-damage';attribute:BattleStatKey;operation:CombatOperation}
    | {kind:'visual';effect:string}
  )[];
}
export type NumericCombatUnit = {
  effect:'physical'|'magic'|'heal'|'drain'|'self-damage';
  source:'physicalAttack'|'magicAttack'|'maxHealth'|'bestNormalDamage'|'none';
  /** 五维各项先乘十分比权重，合计后除十并截断。 */
  attributeWeights:PrimaryAttributes;
  ranks:{fixedAddition:number;operation:CombatOperation}[];
  /** 召唤物的私有命令动作：五维与原魔攻读主人，命中归属仍是召唤物自己。 */
  ownerValues?:boolean;
  /** 只对自伤单元有意义：扣完血之后再给施法者自己叠一层这份已学被动。 */
  alsoAppliesLearnedBuff?:LearnedReactionSkillId;
};
export type CombatUnit =
  | NumericCombatUnit
  | {effect:'state';state:BattleStateKey;ranks:{chanceThreshold:number;durationMs:number;stateDurationProfile?:StateDurationProfile}[]}
  | {effect:'buff';buff:BattleBuffKey;ranks:{strength:number;chanceThreshold:number;effect:BattleBuffEffect}[]}
  | {effect:'summon';creature:string;
      ranks:{durationMs:number;simulationFrames?:{lastActiveFrame:number};attackRatePerThousand?:number;
             healthRatePerThousand?:number;tauntChanceThreshold?:number}[];
      /** 原版 CHAR_GetAttrFromSummonMonster：召唤物按主人等级派生这几项。 */
      ownerDerived?:SummonOwnerDerivation;
      /** 原版 CHAR_Act_Summon：寿命输入 = trunc((主人属性×每点＋基础)/1000)，再按 15/10 换算成帧。 */
      lifetimeFromOwner?:{attribute:BattleStatKey;perPoint:number;base:number};
      appearanceEffects?:SkillVisualEffect[]}
  | {effect:'set-attribute';attribute:BattleStatKey;ranks:CombatOperation[]}
  | {effect:'clear-attribute';attribute:BattleStatKey}
  | {effect:'action'|'taunt'|'visual'};

/** 技能动作的时间轴：素材动画和按逻辑帧排列的执行事件。 */
export interface SkillAction {
  /** 玩家和 AI 选择技能时检查；已经选定的动作沿用起手资格。 */
  requiredOffhand?:'shield';
  hitEffectStyle?:HitEffectStyle;
  manaGemDrop?:'skill'|'weapon';
  combatUnits?:CombatUnit[];
  usesSkillDamageBuff?:boolean;
  /** 发射帧归零重播；次数按技能等级（下标为等级减一）取值。 */
  repeat?: { restartAfterFrame: number; countByLevel: number[]; requiresLivingTarget?: boolean;
    endsWithoutTarget?: boolean; facesTargetOnRelease?: boolean };
  charge?: SkillCharge;
  /**
   * 起手要求施法者至少有一个自己的活动召唤。原版是动作行 `+6` 的值为 37 时启用，
   * 见 `work/findings/monster-s-scream-2026-10-11.md`。
   */
  requiresActiveSummon?:boolean;
  /** 在动作执行帧瞬移到目标背后；落点按目标朝向和场地通行性搜索。 */
  rearTeleport?: { frame: number };
  afterimages?: SkillAfterimages;
  /** 是否需要先锁定敌人；与释放后影响哪些目标分别配置。 */
  requiresTarget?: boolean;
  /** 起手门槛：当前生命必须严格高于最大生命的这一千分率（痛苦吟唱为 5%，等于 5% 不可起手）。 */
  minHealthRatePerThousand?: number;
  /** 按逻辑帧升序排列；同一帧内的先后就是原版执行顺序。 */
  events: SkillEvent[];
  /** 动作冷却的逻辑帧数，与技能等级无关；显示毫秒在快照边界换算。 */
  cooldownFrames: number;
  /** 八像素量化的接近距离，含近身余量。 */
  approachDistanceUnits: number;
  searchRadiusPx: number;
  transition: SkillTransition | null;
  /** 构建期派生的运行时 IR；源 JSON 缺失时运行时回退计算。 */
  effectNames?: string[];
  soundNames?: string[];
  summonNames?: string[];
  /** 非 repeat 动作：逻辑帧号 -> events 下标（spawn 事件按 [frame, until) 展开）。 */
  eventFrames?: Record<string, number[]>;
}

export type SkillGrowthProfile = 'hero' | 'companion';

/** 队伍成员的成长身份保持不变，切换操控只改变输入归属。 */
export function memberSkillGrowth(memberId:string):SkillGrowthProfile {
  return memberId==='player'?'hero':'companion';
}

export interface SkillDetail {
  label: string;
  value: string;
  kind?: 'mana' | 'cooldown' | 'effect';
  effectIndex?: number;
  valueSpacing?: boolean;
  zeroValue?: string;
  valueParts?: import('./description-text.ts').DescriptionTextPart[];
}

/** 构建期把技能详情编译成“模板 + 每级数值”后的运行时行。 */
export interface SkillDisplayRow {
  label: string;
  kind?: 'mana' | 'cooldown' | 'effect';
  effectIndex?: number;
  valueSpacing?: boolean;
  /** 例："{v}秒"、"+{v}%"、"-{v}%"、"‘+{v}秒" */
  template: string;
  decimals: number;
  /** 原 valueParts 是否存在；存在时整段值使用 #00b4ff。 */
  highlight: boolean;
  /** 原 detail.zeroValue ?? '0'；保持预览页的旧口径。 */
  zeroText: string;
}

export interface SkillRank {
  level: number;
  manaCost: number;
  requiredCharacterLevel: number;
  pointCost: number;
  investedSkillPoints?: number;
  /** 作者态详情；构建产物里会被 display/displayValues 取代。 */
  details?: SkillDetail[];
  /** 编译产物：与 display 一一对应的每级数值。 */
  displayValues?: number[];
}

interface SkillGrowthDefinition {
  requiredInvestedSkillPoints?: number;
  ranks: SkillRank[];
  /** 编译产物：技能级详情模板；每个 rank 用 displayValues 提供数值。 */
  display?: SkillDisplayRow[];
  action: SkillAction | null;
  /** 被动直接执行的私有动作：按当前目标结算一次，不进动作播放，也没有冷却与搜寻。 */
  followUpAction?: SkillAction;
  reactionsByRank?: SkillReaction[][];
  passiveUnits?: {attribute:BattleStatKey;
    condition:'always'|'weapon-two-handed'|'weapon-short-or-long-sword'|'weapon-mace'|'stealthed';ranks:CombatOperation[]}[];
}

export interface SkillDefinition extends SkillGrowthDefinition {
  id: string;
  name: string;
  kind: 'active' | 'passive';
  icon: string;
  description: string;
  descriptionParts?: import('./description-text.ts').DescriptionTextPart[];
  normalMaxLevel: number;
  companion?: SkillGrowthDefinition;
}

export function skillForGrowth(skill:SkillDefinition,growth:SkillGrowthProfile):SkillDefinition {
  if(growth==='hero')return skill;
  if(!skill.companion)throw new Error(`技能缺少伙伴成长配置：${skill.id}`);
  return {...skill,followUpAction:undefined,passiveUnits:undefined,reactionsByRank:undefined,...skill.companion};
}

export function skillForMember(catalog:BattleCatalog,memberId:string,skillId:string):SkillDefinition|undefined {
  const skill=catalog.skills[skillId];
  return skill?skillForGrowth(skill,memberSkillGrowth(memberId)):undefined;
}
export function skillManaCost(skill:SkillDefinition|undefined,level:number|undefined):number|undefined {
  return level===undefined?undefined:skill?.ranks.find(rank=>rank.level===level)?.manaCost;
}
export interface BattleClass {
  id: string;
  name: string;
  description: string;
  preview: string;
  actor: ActorDefinition;
  attributes: { name: string; value: number }[];
  skills: string[];
  basicAttack: BasicAttackBinding;
}
export interface BattleCatalog {
  statusAttackBuffs?:Partial<Record<BattleBuffKey,BattleBuffEffect>>;
  feedback:CombatFeedbackDefinition;
  classes: BattleClass[];
  skills: Record<string, SkillDefinition>;
  /** 普攻规则字典，按武器动作命名；职业用 `basicAttack` 引用其中一份。 */
  basicAttacks: Record<string, BasicAttackDefinition>;
  enemies: EnemyDefinition[];
  attackEffects: Record<string, AttackEffectDefinition>;
}
export interface EnemyBehavior {
  aggression: 'active' | 'passive' | 'none';
  /** 同地图内立即参战；省略时按自身警戒范围发现敌人。 */
  engagement?:'map-wide';
  /** 原版八像素量化的感知距离。 */
  awarenessRangeUnits: number;
  moveSpeedPxPerSecond: number;
  canMove: boolean;
  canTurn: boolean;
  /** 每次闲逛决策前的待机时间，单位为毫秒；未配置的角色保持原有行为。 */
  wander?: { idleDurationMs: number };
}
export interface EnemyDefinition {
  stateRules?:StateApplicationRules;
  acceptsBuffs?:boolean;
  /** 原版怪物记录的涉水豁免位：飞行、浮空等单位进水不减速。 */
  waterImmune?:boolean;
  defeatPresentation?: 'vanish';
  /** 空值表示采用场景等级。 */
  level:number|null;
  maxHealth:number;
  attributes:EnemyAttributes;
  skills?: EnemySkill[];
  commandAction?:EnemyPlayableSkill;
  behavior: EnemyBehavior;
  basicAttack: BasicAttackBinding | null;
  displayOnlyReason?: string;
  id: string;
  name: string;
  variant: string;
  actor: ActorDefinition;
}
/** 同一技能按怪物自身动画绑定出手帧；缺失的原版映射保留原因供配置页展示。 */
type EnemySkill = EnemyPlayableSkill | { id: string; name: string; unavailableReason: string };
/** 原版释放条件：MONSKILLBASE 第 1 字节索引 MONAIINFOBASE，语义见 findings/91。 */
export type EnemyReleaseCondition = 'hp-below-30' | 'hp-below-70' | 'hp-below-50' | 'hp-below-95' | 'always';

export interface EnemyPlayableSkill {
  previewNote?: string;
  level?:number;manaCost?:number;frequency?:number;
  releaseCondition?: EnemyReleaseCondition;
  /**
   * 每场战斗只释放一次。原版 `MONSKILLBASE` 第 4 字节控制每场释放次数，
   * 见 `work/findings/60_monster_skills.md`。
   */
  once?: boolean;
  id: string;
  name: string;
  action: SkillAction;
  companionAction?: SkillAction;
  clips: Record<Facing, ClipName>;
}
export function enemySkills(enemy: Pick<EnemyDefinition, 'skills'>): EnemyPlayableSkill[] {
  return (enemy.skills ?? []).filter((skill): skill is EnemyPlayableSkill => 'action' in skill);
}
/**
 * 一个逻辑帧的毫秒数，原版固定 60。
 *
 * 技能动作的时长由素材帧数加末帧停留决定，不单独配置，所以技能投射物每前进
 * `stepDistancePx`、静止过渡每等待一步都用这个值；普攻另由规则里的
 * `frameDurationMs` 提供。
 */
export const LOGIC_FRAME_MS = 60;

/** 技能等级表。快捷栏不在这里：它每组六格、技能与物品共用，见 `shortcut-bar.ts`。 */
export interface SkillLoadout {
  levels: Record<string, number>;
}

/** 地图敌人的实例标识、种类、脚底坐标与当前资源。 */
export interface PlacedEnemy { key: string; enemyId: string; x: number; y: number; health?:number; mana?:number; level?:number; elite?:boolean;summonedBy?:string;
  /** 召唤物按主人等级派生的属性；快照在计算后覆盖这几项。 */
  summonedStats?:{maxHealth:number;physicalAttack?:number;magicAttack?:number;physicalResistanceBonus:number;magicResistance:number};
  /** 召唤物命中后按主人的嘲讽机会尝试拉走目标。 */
  summonTauntChance?:number;/** 召唤它的技能，用来在命中时按主人当前等级重读嘲讽阈值。 */
  summonedBySkill?:string }
