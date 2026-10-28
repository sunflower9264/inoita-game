import type { Facing, StoryPose, TravelDestination } from './content.ts';
import type { StoryWorldCommand } from './story-world.ts';
import { validateSceneSnapshot, type SceneSnapshot } from './scene-snapshot.ts';

export interface StoryCurtain { opacity: number; color: number }

export interface StoryCastMember {
  id: string;
  actor: string;
  worldEntityId?: string;
  characterId?: string;
  enemyId?: string;
  memberId?: string;
  /** 原版对象引用；声明只登记脚本别名，位置和显隐取完整场景。 */
  binding?: 'world';
  inheritPosition?: boolean;
  /** 尚未获得场内位置；保留离场坐标，走位不能凭空把它带入场内。 */
  unpositioned?: boolean;
  x: number;
  y: number;
  facing: Facing;
  visible: boolean;
}

export interface StoryStage extends TravelDestination {
  type: 'stage';
  /** 未声明切图时沿用触发现场；map 仅供内容预览和资源检查。 */
  mapFromWorld?: boolean;
  /** 原版切图重新加载本图角色，继承来源改用到达地图的世界投影。 */
  resetActors?: boolean;
  playerVisible: boolean;
  retainPlayerPosition?: boolean;
  cast: StoryCastMember[];
  /** 检查点镜头中心，单位为地图像素。 */
  camera?: { x: number; y: number };
  curtain?: StoryCurtain;
  audio?: { music: string | null; ambience: string | null };
}

/** 已解析的完整场景；声明中的演员名单不是场景快照。 */
export interface StoryStageSnapshot extends StoryStage {
  scene: SceneSnapshot;
  /** 同一演出已准备的其他地图，恢复时复用其随机物件与实际位置。 */
  scenes?: SceneSnapshot[];
  bindings: [string, string][];
}

export type StoryObjectCommand = Extract<StoryWorldCommand, { kind: 'place' | 'remove-character' | 'remove' | 'show' | 'hide' }>;

export type PerformanceAction =
  | StoryStage
  | { type: 'appear'; target: string; x: number; y: number; facing: Facing; mode?: 'reuse' | 'create'; worldEntityId?:string }
  | { type: 'world-object'; command: StoryObjectCommand; target?: string; mode?: 'reuse' | 'create' }
  /** 原地显形：不改变位置，只让已经站在台上但不可见的角色出现。 */
  | { type: 'show'; target: string }
  | { type: 'leave'; target: string }
  | { type: 'walk'; target: string; x: number; y: number; speedPxPerSecond: number; followCamera?: boolean; ensure?: boolean }
  | { type: 'face'; target: string; facing: Facing; ensure?: boolean }
  /** `hold` 表示动作播完停在末帧不回待机；原版按 `ACTDATABASE +4` 决定（见 findings 183）。 */
  | { type: 'pose'; target: string; pose: 'idle' | 'attack' | StoryPose; durationMs: number; hold?: boolean }
  | { type: 'effect'; target: string; effect: string }
  | { type: 'sound'; sound: string }
  | { type: 'instant-message'; text: string }
  | { type: 'refresh-appearance' }
  | { type: 'stop-audio' }
  | { type: 'music'; sound: string | null }
  | { type: 'camera'; target: string; motion: 'cut' | 'pan' }
  | { type: 'camera-point'; x: number; y: number; motion: 'cut' | 'pan' }
  | { type: 'fade'; opacity: number; color: number; durationMs: number }
  /** 地点特效：在地图像素坐标放一次效果，不绑定演员（原版命令 `0x4b`）。 */
  | { type: 'location-effect'; effect: string; x: number; y: number }
  /** 地图效果开关：开关世界层的褪色色调（原版命令 `0x32`／`0x33`）。 */
  | { type: 'map-effect'; enabled: boolean }
  | { type: 'wait'; durationMs: number }
  | { type: 'parallel'; actions: PerformanceAction[] };

/** 跳过仅结束表现等待；取消终止整段播放。 */
export interface PerformancePlayback {
  signal: AbortSignal;
  skipSignal: AbortSignal;
}

export interface StoryPresentationPort {
  /** `deferFirstStage`：首幕舞台动作由随后的 `execute` 画出，避免同一张舞台图建两次。 */
  begin(signal?: AbortSignal, stage?: StoryStage | StoryStageSnapshot, initialCurtain?: StoryCurtain, deferFirstStage?: boolean): void | Promise<void>;
  prefetchMap?(map: string): void;
  execute(action: Exclude<PerformanceAction, { type: 'parallel' }>, playback: PerformancePlayback): Promise<void>;
  parallel?(actions: PerformanceAction[], playback: PerformancePlayback): Promise<void>;
  finish(completed: boolean, signal?: AbortSignal): Promise<void>;
  getStageState?(): StoryStageSnapshot | undefined;
  getWorldChanges?(): readonly import('./story-world.ts').StoryEntityState[];
  committed?(): void;
  restoreStage?(stage: StoryStageSnapshot, signal: AbortSignal): Promise<void>;
  release?(): void | Promise<void>;
}

export function performanceTargets(action: PerformanceAction): string[] {
  if (action.type === 'parallel') return action.actions.flatMap(performanceTargets);
  if (action.type === 'world-object') {
    const command = action.command;
    if (command.kind === 'place') return [action.mode === 'create' ? `entity:${command.entity.id}`
      : action.target ?? `character:${command.entity.characterId ?? command.entity.id}`];
    if (command.kind === 'remove-character') return [`character:${command.characterId}`];
    return [`entity:${command.id}`];
  }
  if (action.type === 'camera' || action.type === 'camera-point') return ['camera'];
  if (action.type === 'fade') return ['fade'];
  if (action.type === 'music') return ['music'];
  if (action.type === 'walk' && action.followCamera) return [action.target, 'camera'];
  if ('target' in action && action.type !== 'effect') return [action.target];
  return [];
}

/**
 * 剧情命令 `0x32` 打开的地图效果：原版 `MAP_SetEffect(1)` 写 `MAP_nBaseEffect=1`，此后每帧
 * 把世界层包进 `GRP_AddColorTone(2,0)`——按 BT.601 亮度重新着色（见 findings 181 的 F-04）。
 * 4×5 行主序，Phaser 的 `ColorMatrix` 直接读它；系数据原版逐像素式
 * `L = (77R + 151G + 28B) >> 8`、`R' = B' = 230L >> 8`、`G' = 220L >> 8` 展开。
 */
export const mapEffectTone: number[] = [
  17710 / 65536, 34730 / 65536, 6440 / 65536, 0, 0,
  16940 / 65536, 33220 / 65536, 6160 / 65536, 0, 0,
  17710 / 65536, 34730 / 65536, 6440 / 65536, 0, 0,
  0, 0, 0, 1, 0,
];

/** 原版短距离每逻辑帧移动 12 像素，长距离按距离的十分之一移动。 */
export function cameraDuration(distance: number): number {
  if (distance < .01) return 0;
  const step = distance > 120 ? Math.floor(distance / 10) : 12;
  return Math.ceil(distance / step) * 60;
}


/** 存档和恢复只接收含完整场景的检查点。 */
export function validateStoryStageSnapshot(value: unknown): asserts value is StoryStageSnapshot {
  if (!value || typeof value !== 'object') throw new Error('剧情检查点舞台无效');
  const stage = value as StoryStageSnapshot;
  if (stage.type !== 'stage' || typeof stage.map !== 'string' || !stage.map || !Number.isFinite(stage.x) || !Number.isFinite(stage.y)
    || !['north', 'south', 'east', 'west'].includes(stage.facing) || typeof stage.playerVisible !== 'boolean'
    || !Array.isArray(stage.cast) || stage.cast.some(member => !member || typeof member.id !== 'string' || !member.id
      || typeof member.actor !== 'string' || !member.actor || !Number.isFinite(member.x) || !Number.isFinite(member.y)
      || typeof member.visible !== 'boolean' || !['north', 'south', 'east', 'west'].includes(member.facing)
      || member.unpositioned !== undefined && typeof member.unpositioned !== 'boolean')
    || new Set(stage.cast.map(member => member.id)).size !== stage.cast.length) throw new Error('剧情检查点舞台无效');
  validateSceneSnapshot(stage.scene);
  if (stage.scene.map !== stage.map) throw new Error('剧情检查点场景与舞台地图不一致');
  if (stage.scenes !== undefined) {
    if (!Array.isArray(stage.scenes)) throw new Error('剧情检查点已准备地图无效');
    const maps = new Set([stage.map]);
    for (const scene of stage.scenes) {
      validateSceneSnapshot(scene);
      if (maps.has(scene.map) || !scene.actors.some(actor => actor.id === 'player')) throw new Error('剧情检查点已准备地图重复或缺少玩家');
      maps.add(scene.map);
    }
  }
  if (!Array.isArray(stage.bindings) || stage.bindings.some(pair => !Array.isArray(pair) || pair.length !== 2
    || pair.some(id => typeof id !== 'string' || !id))) throw new Error('剧情检查点演员绑定无效');
  const bindings = new Map(stage.bindings), actors = new Map(stage.scene.actors.map(actor => [actor.id, actor]));
  const aliases = new Set(['player', ...stage.cast.map(member => member.id)]);
  if (bindings.get('player') !== 'player' || bindings.size !== stage.bindings.length || bindings.size !== aliases.size
    || new Set(bindings.values()).size !== bindings.size
    || [...bindings].some(([alias, id]) => !aliases.has(alias) || !actors.has(id))) throw new Error('剧情检查点演员绑定缺失或重复');
  const player = actors.get('player')!;
  if (player.x !== stage.x || player.y !== stage.y || player.facing !== stage.facing || player.visible !== stage.playerVisible)
    throw new Error('剧情检查点主角状态与场景不一致');
  for (const member of stage.cast) {
    const actor = actors.get(bindings.get(member.id)!)!;
    if (member.actor !== actor.actor || member.x !== actor.x || member.y !== actor.y || member.facing !== actor.facing
      || member.visible !== actor.visible || !!member.unpositioned !== !!actor.unpositioned
      || member.characterId !== undefined && actor.characterId !== member.characterId
      || member.worldEntityId !== undefined && actor.worldEntityId !== member.worldEntityId
      || member.memberId !== undefined && actor.memberId !== member.memberId
      || member.enemyId !== undefined && actor.enemyId !== member.enemyId)
      throw new Error('剧情检查点演员身份不一致：' + member.id);
  }
  if (stage.camera && (!Number.isFinite(stage.camera.x) || !Number.isFinite(stage.camera.y))
    || stage.curtain && (!Number.isFinite(stage.curtain.opacity) || stage.curtain.opacity < 0 || stage.curtain.opacity > 1
      || !Number.isSafeInteger(stage.curtain.color) || stage.curtain.color < 0 || stage.curtain.color > 0xffffff)
    || stage.audio && [stage.audio.music, stage.audio.ambience].some(id => id !== null && (typeof id !== 'string' || !id)))
    throw new Error('剧情检查点镜头或音频无效');
}
