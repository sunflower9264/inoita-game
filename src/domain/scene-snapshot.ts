import type {ActorDefinition, ClipName, EntityPlacement, Facing} from './content.ts';
import type {EnemyRoster} from './enemy-roster.ts';
import {assertUniqueActorInstances} from './actor-census.ts';

/** 一次地图访问里实际存在的对象；演员名只是脚本对这些对象的引用。 */
export interface SceneActorState {
  id: string;
  actor: string;
  characterId?: string;
  worldEntityId?: string;
  memberId?: string;
  enemyKey?: string;
  enemyId?: string;
  summonedBy?: string;
  x: number;
  y: number;
  facing: Facing;
  visible: boolean;
  /** 舞台为防重复而临时隐藏；把舞台位置采纳回正式世界时必须跳过。 */
  stageHidden?: boolean;
  /** 队伍跟随者：主角不可见时默认一并隐藏；被剧情显式显隐后不再跟随。 */
  followsPlayer?: boolean;
  /** 主角隐藏期间暂存的自身可见性，主角重新出现时恢复（阵亡队员仍是不可见）。 */
  followVisibility?: boolean;
  removed?: boolean;
  flip?: boolean;
  appearance?: ActorDefinition;
  clip?: ClipName;
  animationProgress?: number;
  animationPlaying?: boolean;
  unpositioned?: boolean;
  alpha?: number;
}

export interface PreparedSceneVisit {
  generatedEntities: EntityPlacement[];
  roster: ReturnType<EnemyRoster['captureState']>;
  breakableRolls: [string,string][];
}

export interface SceneSnapshot {map: string; actors: SceneActorState[]; visit?: PreparedSceneVisit}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 存档只接收可以重新构建人物和纹理的完整场景数据。 */
export function validateSceneSnapshot(value: unknown): asserts value is SceneSnapshot {
  const fail = (detail?: string): never => {throw new Error(detail ? `剧情场景快照格式无效：${detail}` : '剧情场景快照格式无效');};
  if (!record(value) || !nonempty(value.map) || !Array.isArray(value.actors)) fail('缺少地图或对象列表');
  const snapshot = value as Record<string, unknown>;
  if (snapshot.visit !== undefined) validatePreparedSceneVisit(snapshot.visit);
  const ids = new Set<string>();
  for (const [index, entry] of (snapshot.actors as unknown[]).entries()) {
    const at = (field: string): never => fail(`actors[${index}].${field}`);
    if (!record(entry)) at('不是对象');
    const actor = entry as Record<string, unknown>;
    if (!nonempty(actor.id)) at('id 必须是非空字符串');
    if (ids.has(actor.id as string)) at(`id 重复：${String(actor.id)}`);
    if (!nonempty(actor.actor)) at('actor 必须是非空字符串');
    if (!finite(actor.x) || !finite(actor.y)) at('x/y 必须是有限数字');
    if (!['north','south','east','west'].includes(actor.facing as string)) at('facing 无效');
    if (typeof actor.visible !== 'boolean') at('visible 必须是布尔值');
    ids.add(actor.id as string);
    for (const key of ['characterId','worldEntityId','memberId','enemyKey','enemyId','summonedBy'])
      if (actor[key] !== undefined && !nonempty(actor[key])) at(`${key} 必须是非空字符串`);
    for (const key of ['flip','unpositioned','removed','animationPlaying','stageHidden'])
      if (actor[key] !== undefined && typeof actor[key] !== 'boolean') at(`${key} 必须是布尔值`);
    if (actor.alpha !== undefined && (!finite(actor.alpha) || actor.alpha < 0 || actor.alpha > 1)) at('alpha 必须在 0..1');
    if (actor.animationProgress !== undefined && (!finite(actor.animationProgress) || actor.animationProgress < 0 || actor.animationProgress > 1)) at(`animationProgress 必须在 0..1（当前 ${String(actor.animationProgress)}）`);
    if (actor.clip !== undefined && (!nonempty(actor.clip) || !/-(north|south|east|west)$/.test(actor.clip))) at(`clip 必须以朝向结尾（当前 ${String(actor.clip)}）`);
    if (actor.appearance === undefined) continue;
    const appearance = actor.appearance;
    if (!record(appearance) || !nonempty(appearance.id) || typeof appearance.name !== 'string' ||
      typeof appearance.description !== 'string' || !(appearance.portrait === null || typeof appearance.portrait === 'string') ||
      !record(appearance.clips)) at('appearance 结构无效');
    const definition = appearance as Record<string, unknown>;
    for (const [name, value] of Object.entries(definition.clips as Record<string, unknown>)) {
      const clipAt = (field: string): never => at(`appearance.clips.${name}.${field}`);
      if (!record(value)) clipAt('不是对象');
      const clip = value as Record<string, unknown>;
      for (const key of ['frameWidth','frameHeight','frames','originX','originY','frameRate'])
        if (!finite(clip[key])) clipAt(`${key} 必须是有限数字`);
      if ((clip.frameWidth as number) <= 0 || (clip.frameHeight as number) <= 0 ||
        !Number.isInteger(clip.frames) || (clip.frames as number) < 1 || (clip.frameRate as number) <= 0 ||
        typeof clip.mirrorX !== 'boolean' || !Array.isArray(clip.layers)) clipAt('帧尺寸、帧数或镜像标记无效');
      for (const layer of clip.layers as unknown[]) if (!record(layer) || !nonempty(layer.key) ||
        typeof layer.file !== 'string' || !['normal','add','multiply','screen','color-dodge'].includes(layer.blend as string)) clipAt('图层无效');
    }
    for (const key of ['effectAnchor','headAnchor','collision']) {
      if (definition[key] === undefined) continue;
      const shape = definition[key];
      if (!record(shape) || !finite(shape.x) || !finite(shape.y)) at(`appearance.${key} 无效`);
      if (key === 'collision' && (!finite((shape as Record<string, unknown>).width) || !finite((shape as Record<string, unknown>).height))) at(`appearance.${key} 无效`);
    }
  }
  assertUniqueActorInstances(snapshot.actors as SceneActorState[], '剧情场景快照');
}

export function validatePreparedSceneVisit(value: unknown): asserts value is PreparedSceneVisit {
  const fail = (): never => {throw new Error('剧情地图访问快照格式无效');};
  if (!record(value)) fail();
  const visit = value as Record<string, unknown>;
  if (!Array.isArray(visit.generatedEntities) || !Array.isArray(visit.breakableRolls) || !record(visit.roster)) fail();
  const entities = new Set<string>();
  for (const entry of visit.generatedEntities as unknown[]) {
    if (!record(entry) || !nonempty(entry.id) || entities.has(entry.id) || !nonempty(entry.actor) ||
      !finite(entry.x) || !finite(entry.y)) fail();
    entities.add((entry as {id:string}).id);
  }
  const rolls = new Set<string>();
  for (const entry of visit.breakableRolls as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || !nonempty(entry[0]) || !nonempty(entry[1]) || rolls.has(entry[0])) fail();
    rolls.add((entry as string[])[0]!);
  }
  const roster=visit.roster as Record<string,unknown>;
  if (!Array.isArray(roster.enemies) || !Number.isSafeInteger(roster.sequence) || (roster.sequence as number)<0 ||
    !Number.isSafeInteger(roster.partySize) || (roster.partySize as number)<1) fail();
  const enemies = new Set<string>();
  for (const entry of roster.enemies as unknown[]) {
    if (!record(entry) || !nonempty(entry.key) || enemies.has(entry.key) || !nonempty(entry.enemyId) ||
      !finite(entry.x) || !finite(entry.y)) fail();
    const enemy = entry as Record<string,unknown>;
    enemies.add(enemy.key as string);
    for (const field of ['health','mana','level','summonTauntChance'])
      if (enemy[field] !== undefined && (!finite(enemy[field]) || (enemy[field] as number)<0)) fail();
    for (const field of ['summonedBy','summonedBySkill']) if (enemy[field] !== undefined && !nonempty(enemy[field])) fail();
    if (enemy.elite !== undefined && typeof enemy.elite !== 'boolean') fail();
  }
}
