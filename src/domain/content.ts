/** 游戏内容契约：素材、世界、人物和剧情都使用稳定的游戏标识。 */

/** 人物朝向，对应素材的四个动作方向。 */
export type Facing = 'north' | 'south' | 'east' | 'west';

/** 出口可以要求人物按某个朝向进入，`any` 表示不限定。 */
export type ExitFacing = Facing | 'any';

/**
 * 剧情姿态名，来自原版 `0x17` 命令指定的 ACTDATABASE 行号（见 `work/findings/183`）。
 * 名字取自 ACTDATABASE 自带的动作名（哭号／巡视／拾取／给予…），没有名字的按画面形态取。
 */
export const STORY_POSE_NAMES = ['stand', 'fall-down', 'heavy-blow', 'recovery', 'lie-down', 'lie-side',
  'sway', 'cry', 'look-around', 'pick-up', 'give', 'demon-lord-attack', 'demon-lord-skill', 'skill-2'] as const;
export type StoryPose = typeof STORY_POSE_NAMES[number];

/** 动作名，形如 `walk-east`、`idle-south`、`cry-west`。 */
export type ClipName = `${'walk' | 'idle' | 'attack' | 'dual-attack' | 'dual-quick-attack' | 'frenzy-blade' | 'frenzy-two-handed' | 'frenzy-dagger' | 'frenzy-staff' | 'die' | StoryPose}-${Facing}` | `skill-${string}-${Facing}`;

/**
 * 混合模式名，来自导出数据。
 * `multiply`/`screen`/`add` 直接对应 Phaser 的混合模式；
 * `color-dodge` 在 WebGL 下没有对应模式，场景用 Blend 滤镜与抓下来的背景合成，见 `world-scene.ts`。
 */
export type BlendName = 'normal' | 'screen' | 'add' | 'multiply' | 'color-dodge';

/**
 * 原版 `SNASYS_ApplyFrameFilter` 的滤镜运算名，与 `work/tools/game_content/blend.py`
 * 的 `OPERATIONS` 一致。名字就是运算本身，不是引擎里的位标志。
 */
export type EffectOperation = 'multiply' | 'add' | 'screen' | 'hard-light' | 'color-dodge' | 'overlay';

/**
 * 一层特效怎么画到场景上：四种能直接混合的方式，加上 `backdrop`——
 * 那些结果依赖背景像素的运算，要边画边读画面。
 */
export type EffectBlend = 'normal' | 'multiply' | 'screen' | 'add' | 'backdrop';

/** 特效的一层：一张图集加它的绘制方式与原版运算。 */
export interface EffectLayer {
  /** 纹理键，同时是 Phaser 动画键。 */
  key: string;
  file: string;
  /** 这一层按什么方式混合；`backdrop` 表示按 `operations` 读背景合成。 */
  blend: EffectBlend;
  /** 原版滤镜链，按作用顺序排列；离线表达不了的组合会原样留在这里。 */
  operations: EffectOperation[];
}

/** 特效片段：图集加按绘制顺序排列的层。 */
export interface EffectClip {
  /** 导出契约版本，导出器、校验器和运行时读同一个数。 */
  version: number;
  frameWidth: number;
  frameHeight: number;
  frames: number;
  originX: number;
  originY: number;
  frameRate: number;
  mirrorX: boolean;
  layers: EffectLayer[];
}

/** 相对脚底锚点的实体范围，用于阻挡。 */
export interface CollisionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 角色资源表里的一条动作。多图层在导出阶段已按统一锚点合成。 */
export interface AnimationClip {
  frameWidth: number;
  frameHeight: number;
  /** 条目数，含重复帧。 */
  frames: number;
  originX: number;
  originY: number;
  /** 每秒推进的条目数。 */
  frameRate: number;
  /** 素材画的是侧面朝西，向东时需要镜像。 */
  mirrorX: boolean;
  layers: AnimationLayer[];
}

interface AnimationLayer {
  /** 纹理键，同时是 Phaser 动画键。 */
  key: string;
  file: string;
  blend: BlendName;
}

export type ChestKind = 'ordinary' | 'improved' | 'boss';

/** 人物提供的固定服务：灵魂治疗师与融合机。 */
type ActorService = 'soul-healer' | 'fusion-machine';

/** 一种人物（同一个编号的所有同名角色共用）。 */
export interface ActorDefinition {
  chest?: ChestKind;
  service?: ActorService;
  id: string;
  name: string;
  /** 没有对白可讲时使用的默认台词。 */
  description: string;
  clips: Partial<Record<ClipName, AnimationClip>>;
  /** 默认立绘键；`null` 表示这个人物没有立绘。 */
  portrait: string | null;
  /** 有实体范围的人物会阻挡移动；桥、出口标记等没有这一项。 */
  collision?: CollisionBox;
  /** 跟随人物的特效锚点，相对脚底的位置。 */
  effectAnchor?: { x: number; y: number };
  /** 人物头部在脚点坐标系中的位置，单位为地图像素。 */
  headAnchor?: { x: number; y: number };
}

interface PortraitDefinition {
  file: string;
  width: number;
  height: number;
}

/** 场景物件（树、招牌、水面等）的资源定义。 */
interface PropDefinition {
  key: string;
  file: string;
}

/** 一张地图的索引项，地图本体另存为 JSON。 */
interface MapReference {
  id: string;
  name: string;
  file: string;
}

/** 地图上的一个贴图，按 y 排序参与遮挡。 */
export interface MapFeature {
  texture: string;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  width: number;
  flip: boolean;
  blend: BlendName;
}

/** 地图上的一个出口，脚底接触即切图。 */
export interface MapExit {
  id?:string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 目标地图 id。 */
  destination: string;
  /** 到达后的落点，在地图坐标里。 */
  spawn: { x: number; y: number };
  /** 进入出口时人物朝向的要求。 */
  exitFacing: ExitFacing;
  /** 到达后人物的朝向。 */
  facing: ExitFacing;
}

/** 在场条件：与任务、事件和出口共同使用语义条件。 */
export interface VisibilityRules {
  /** 永久世界实例标识。 */
  id: string;
  condition?:import('./story-condition.ts').StoryCondition;
}

/** 地图或剧情放下的一个人物。剧情放置的会覆盖地图上同名的静态人物。 */
export interface EntityPlacement extends VisibilityRules {
  actor: string;
  /** 人物身份；多个不同人物可以共用同一套 actor 素材。 */
  characterId?: string;
  x: number;
  y: number;
  /** 摆放朝向：`true` 表示原版这个点朝东（`CHAR_SetDirection(char, 3)`）。
   * 四向动作素材由 clip 的 `mirrorX` 表达朝向，这里只用于单视图素材的左右镜像。 */
  flip?: boolean;
  /** 显示名，覆盖角色资源里的名字。 */
  name?: string;
  /** 没有任务可谈时说的话。 */
  hint?: string;
  /** 交互可以推进的目标 id（对应任务目标里的 `target`）。 */
  objective?: string;
  /** 交互成功后提示「获得了物品」而不是「目标达成」。 */
  collectible?: boolean;
  /** 交互成功后播放的剧情。 */
  afterInteractScript?: string;
  /** 出现判定：每次进图掷原生 1..99，不超过 atMost 才生成。见 `domain/chests.ts` 的 `rollPlacement`。 */
  appear?: { atMost: number };
  /** 出现之后再掷一次原生 1..99，没到 atLeast 就换成 `actor` 指向的对象。 */
  downgrade?: { atLeast: number; actor: string };
  /** 摆放记录里的"水井"其实是泉水生成点，档位由 `domain/springs.ts` 按等级重掷。 */
  spring?: boolean;
}

/** 地图里的一处普通敌人生成点，坐标是脚底世界像素。 */
export interface EnemySpawn {
  /**
   * 一次性敌人的标记：写 `false` 表示被击败后**不再刷新**（`Session.enemyDefeated` 据此把
   * 死亡状态记为 `permanent`，跨图也不复活）。省略表示按常规间隔刷新——地图自带的生成点
   * 就是这样；宝箱怪、泉水怪与任务敌人在生成时都显式写 `false`。
   * 类型上只允许 `false`，因为它是标记而不是开关。
   */
  respawn?: false;
  id: string;
  enemyId: string;
  x: number;
  y: number;
  /** 地图被多个等级阶段复用时，本批敌人的代表等级。 */
  tierLevel?: number;
  /** 原怪类别为 0，允许在激活时被罐子/箱子替换。 */
  breakableEligible?: boolean;
}

/** 剧情指定的敌人。击败奖励只发给这一处实例一次。 */
export interface CampaignEnemyPlacement extends EnemySpawn {
  map: string;
  activeQuest: string;
  rewardItem: string;
  respawn: false;
}

/** 任务进行时出现的地面物品生成点，坐标是世界像素。 */
export interface QuestItemSpawn {
  id: string;
  quest: string;
  item: string;
  x: number;
  y: number;
  /** 从生成到下一次可刷新的间隔，单位是游戏逻辑帧。 */
  respawnFrames: number;
}

/** 一张地图的全部数据：地形阻挡、两层贴图、人物和出口。 */
export interface WorldMap {
  /** 地图宝箱使用的掉落等级，0 保留原版空掉落。 */
  lootLevel?: number;
  /** 体验版宝箱有效等级：原版 lootLevel 为 0 时由导出器沿出口回退。 */
  chestLevel?: number;
  chestLevelSource?: 'native' | 'neighbor' | 'floor' | 'override';
  id: string;
  name: string;
  width: number;
  height: number;
  tileSize: number;
  columns: number;
  rows: number;
  /** 按行存储的地形阻挡，长度是 `columns * rows`。 */
  blocked: boolean[];
  ground: string;
  canopy: string;
  features: MapFeature[];
  entities: EntityPlacement[];
  enemySpawns?: EnemySpawn[];
  /** 地图的生成槽替换分支；缺省表示只生成箱子。 */
  breakableSpawn?: 'bush' | 'jar';
  questItemSpawns?: QuestItemSpawn[];
  exits: MapExit[];
}

/** `content/world.json`：所有地图的索引，加上人物、立绘、物件资源表。 */
export interface WorldIndex {
  /** 剧情特效的层位来自 EFFECTINFOBASE +3：`ground` 画在底图之上，`above-characters` 画在所有角色之上。 */
  storyEffects?: Record<string, { clips: Record<string, EffectClip>; placement?: 'ground' | 'above-characters' }>;
  version: number;
  maps: MapReference[];
  actors: Record<string, ActorDefinition>;
  portraits: Record<string, PortraitDefinition>;
  props: PropDefinition[];
}

/** 一句对白。`portrait` 未指定表示用角色默认立绘，`null` 表示这次不显示立绘。 */
export interface DialogueLine {
  speaker: string;
  text: string;
  actor: string | null;
  portrait?: string | null;
  presentation?: 'screen';
}

export interface DialogueAction extends DialogueLine {
  type: 'dialogue';
}

export interface ChoiceOption {
  label: string;
  value: string;
  /** 选择后追加的对白。 */
  lines?: DialogueLine[];
}

export interface ChoiceAction {
  type: 'choice';
  prompt: string;
  description?: string;
  options: ChoiceOption[];
}

/** 剧情脚本由一个接一个的动作组成。 */
export type ScriptAction = DialogueAction | ChoiceAction | import('./story-performance.ts').PerformanceAction
  | { type: 'party-join'; companion: string } | { type: 'party-leave'; companion: string };

export type QuestStatus = 'locked' | 'available' | 'active' | 'ready' | 'completed';

/**
 * 每种任务状态下给玩家的当前目标提示。
 *
 * `locked` 不需要槽位——未解锁的任务不进日志，也就没有目标可言；
 * 其余四种状态各有一处。`ready` 与 `completed` 是可选的，数据里没写时
 * 走日志的通用文案，不在这里硬编码。
 */
export interface QuestGuidance {
  available: string;
  active: string;
  /** 目标已达成、等玩家回去交付时的提示。 */
  ready?: string;
  /** 已交付、列在已完成分组时的提示。 */
  completed?: string;
  /** 收集或交互目标的显示名称，用于任务日志计数。 */
  counterLabel?: string;
}

export interface TravelDestination {
  map: string;
  x: number;
  y: number;
  facing: Facing;
}

export interface QuestReward {
  experience: number;
  money: number;
  items: { item: string; quantity: number; classIds?: string[] }[];
}

export interface QuestRewardReceipt {
  experience: number;
  money: number;
  items: { item: string; quantity: number }[];
}

/** 走进即触发的剧情区域。 */
export interface StoryTrigger extends VisibilityRules {
  map: string;
  x: number;
  y: number;
  width: number;
  height: number;
  script: string;
}

/** 开场落点。 */
export interface StartPlacement {
  map: string;
  x: number;
  y: number;
  actor: string;
  facing: ExitFacing;
  script: string;
}

/** 剧情放置的人物，带所在地图。 */
export interface Placement extends EntityPlacement {
  map: string;
}

/** 任务日志中共用一条列表项的剧情步骤。 */
export interface QuestGroupDefinition {
  id: string;
  title: string;
  kind: 'main' | 'side';
  /** 从早到晚的任务步骤；日志按倒序展示已经接取的步骤。 */
  questIds: string[];
}

/* 剧情编排的类型（`Campaign`、`CampaignQuest`、`CampaignPlacement`）在 `./campaign.ts`，
   与本文一起构成内容契约。 */
