import type { SceneActorState, SceneSnapshot } from './scene-snapshot.ts';
import type { PerformanceAction, StoryCastMember, StoryStage, StoryStageSnapshot } from './story-performance.ts';
import {faceTarget} from './basic-attack.ts';
import {assertUniqueActorInstances} from './actor-census.ts';

/**
 * 先按实例找人，再按人物/队员/怪物身份查找。外观只能用于没有身份的手写演员。
 *
 * 人物编号不是实例编号：同一张图上可能有多名同编号士兵、几扇同形石门。只有一个候选时
 * 可以直接绑定；多个候选时用舞台声明的落点找最近的一个，距离并列或根本没有落点时
 * 说明内容写得不唯一，必须让内容补 `worldEntityId`，不能静默拿第一个。
 */
export function findSceneActor(scene: SceneSnapshot, member: StoryCastMember): SceneActorState | undefined {
  if (member.worldEntityId) return scene.actors.find(actor => !actor.removed && actor.worldEntityId === member.worldEntityId);
  const matches = scene.actors.filter(actor => !actor.removed && (member.memberId ? actor.memberId === member.memberId
    : member.characterId ? actor.characterId === member.characterId
    : member.enemyId ? actor.enemyId === member.enemyId : actor.actor === member.actor));
  const positioned = matches.filter(actor => !actor.unpositioned);
  const candidates = positioned.length ? positioned : matches;
  if (candidates.length <= 1) return candidates[0];
  // 原版位置登记（quest-npc-located-*）是该角色在这张图上的正式副本；
  // 旧过场或静态地图里留下的同名副本应让位，不能和登记副本同时出现。
  const registered = candidates.filter(actor => actor.worldEntityId?.startsWith('quest-npc-located-'));
  if (registered.length === 1) return registered[0];
  const hasDeclarationPosition = !member.unpositioned && Number.isFinite(member.x) && Number.isFinite(member.y)
    && !(member.x === 2048 && member.y === 2048);
  if (hasDeclarationPosition) {
    const ranked = candidates.map(actor => ({actor, distance: Math.hypot(actor.x - member.x, actor.y - member.y)}))
      .sort((left, right) => left.distance - right.distance);
    if (ranked[1].distance - ranked[0].distance > 1e-6) return ranked[0].actor;
  }
  // 敌人编号是刷新类型，不是单只实例：同一张图上可以同时有几只同种怪物。
  // 没有位置可区分时沿用原版的第一只；有位置时上面的最近距离优先。
  // 人物编号不同，它可能对应多个同名 NPC，不能用同样办法静默取第一只。
  if (member.enemyId) return candidates[0];
  // 未落位、不可见的世界演员是“等待脚本创建”的模板（例如一群路障共用一个别名）。
  // 这时不抢现有副本，先建一个离场占位；后续 appear/create 会再绑定真正实例。
  if (member.unpositioned && !member.visible && !member.memberId) return undefined;
  const selector = member.characterId ? `characterId=${member.characterId}` : member.memberId ? `memberId=${member.memberId}`
    : `actor=${member.actor}`;
  throw new Error(`剧情演员来源不唯一：${member.id}（${selector}）候选 ${candidates.map(actor => `${actor.id}@${actor.x},${actor.y}`).join('、')}；请补 worldEntityId`);
}

/**
 * 舞台只负责本幕 cast 点名的战斗演员；正式世界里的其它敌人/召唤物继续由战斗层绘制。
 * 不删除它们，只把快照里的显示关掉——舞台释放后战斗仍按原状态继续。
 */
export function hideUnboundCombatActors(snapshot: StoryStageSnapshot): StoryStageSnapshot {
  const bound = new Set(snapshot.bindings.map(([, id]) => id));
  // 友方召唤物属于队伍画面，即使本幕没有点名也继续显示；敌对/中立战斗演员必须点名。
  const partyOwners = new Set(['player', ...snapshot.scene.actors.flatMap(actor => actor.memberId ? [actor.memberId] : [])]);
  for (const actor of snapshot.scene.actors){
    if (!(actor.enemyKey || actor.enemyId)) continue;
    actor.stageHidden = !bound.has(actor.id) && !(actor.summonedBy && partyOwners.has(actor.summonedBy));
    if (actor.stageHidden) actor.visible = false;
  }
  return snapshot;
}

function newId(scene: SceneSnapshot, alias: string): string {
  const base = `story:${alias}`;
  let id = base, index = 1;
  while (scene.actors.some(actor => actor.id === id)) id = `${base}:${index++}`;
  return id;
}

function actorFrom(member: StoryCastMember, id: string): SceneActorState {
  return { id, actor: member.actor, characterId: member.characterId, worldEntityId: member.worldEntityId,
    memberId: member.memberId, enemyId: member.enemyId, x: member.x, y: member.y, facing: member.facing,
    visible: member.visible, unpositioned: member.unpositioned };
}

/**
 * 队员默认跟随主角的显隐。原版的队伍跟随逻辑以主角为锚点：主角被移出/
 * 隐藏时，队员不会单独留在画面上；主角重新出现时，队员恢复各自的可见性
 * （阵亡队员仍然不可见）。
 *
 * 剧情显式 `appear`／`leave`／`show` 过的队员会先关掉 `followsPlayer`，
 * 之后的显隐由脚本负责，不再被这层联动覆盖。
 */
function syncPartyFollowers(snapshot: StoryStageSnapshot, player: SceneActorState): void {
  for (const actor of snapshot.scene.actors) {
    if (!actor.followsPlayer || actor.removed) continue;
    if (player.visible) {
      if (actor.followVisibility === undefined) continue;
      actor.visible = actor.followVisibility;
      delete actor.followVisibility;
    } else if (actor.visible) {
      actor.followVisibility = actor.visible;
      actor.visible = false;
    }
  }
}

/** 剧情点名控制这名队员的显隐后，把它从「跟随主角」的默认规则里摘出去。 */
function controlIndependently(actor: SceneActorState): void {
  if (!actor.memberId || actor.memberId === 'player') return;
  actor.followsPlayer = false;
  delete actor.followVisibility;
}

/** 把别名的读回值和玩家落点同步到完整场景；场景对象本身只存一份。 */
export function syncStoryScene(snapshot: StoryStageSnapshot): StoryStageSnapshot {
  const bindings = new Map(snapshot.bindings);
  const player = snapshot.scene.actors.find(actor => actor.id === bindings.get('player'));
  if (!player) throw new Error('剧情场景缺少主角');
  snapshot.x = player.x; snapshot.y = player.y; snapshot.facing = player.facing; snapshot.playerVisible = player.visible;
  syncPartyFollowers(snapshot, player);
  snapshot.cast = snapshot.cast.map(member => {
    const actor = snapshot.scene.actors.find(actor => actor.id === bindings.get(member.id));
    if (!actor) throw new Error(`剧情演员绑定失效：${member.id}`);
    return { ...member, actor: actor.actor, worldEntityId: actor.worldEntityId, characterId: actor.characterId,
      memberId: actor.memberId, enemyId: actor.enemyId, x: actor.x, y: actor.y, facing: actor.facing,
      visible: actor.visible, unpositioned: actor.unpositioned };
  });
  assertUniqueActorInstances(snapshot.scene.actors, '剧情舞台');
  return snapshot;
}

/** 接管整张场景。演员声明只覆盖明确的手写摆位，不会删除未被脚本引用的对象。 */
export function resolveStoryScene(declaration: StoryStage, source: SceneSnapshot): StoryStageSnapshot {
  const scene = structuredClone(source);
  const player = scene.actors.find(actor => actor.id === 'player');
  if (!player) throw new Error('演出接管时缺少主角');
  if (!declaration.retainPlayerPosition) {
    player.x = declaration.x; player.y = declaration.y; player.facing = declaration.facing;
    player.clip=`idle-${player.facing}`;player.animationProgress=0;player.animationPlaying=true;
  }
  player.visible = declaration.playerVisible;
  const bindings: [string, string][] = [['player', player.id]];
  for (const member of declaration.cast) {
    const referencesWorld=member.binding==='world'||member.inheritPosition||member.worldEntityId||member.characterId||member.memberId||member.enemyId;
    let actor = referencesWorld?findSceneActor(scene, member):undefined;
    if (!actor) {
      actor = actorFrom(member, newId(scene, member.id));
      if (member.binding === 'world' || member.inheritPosition) {
        actor.x = 2048; actor.y = 2048; actor.visible = false; actor.unpositioned = true;
      }
      scene.actors.push(actor);
    } else if (member.binding !== 'world' && !member.inheritPosition) {
      Object.assign(actor, { x: member.x, y: member.y, facing: member.facing, visible: member.visible,
        unpositioned: member.unpositioned,clip:`idle-${member.facing}`,animationProgress:0,animationPlaying:true });
    }
    if (actor.memberId && actor.memberId !== 'player') {
      // 舞台点名了这名队员：初始显隐按声明来，之后由脚本动作负责。
      controlIndependently(actor);
      actor.visible = member.visible;
    }
    const owner = bindings.find(([, id]) => id === actor.id);
    if (owner) throw new Error(`剧情演员重复绑定：${member.id} 与 ${owner[0]} 指向 ${actor.id}`);
    bindings.push([member.id, actor.id]);
  }
  // 同一角色可能同时以“地图人物”“队伍成员”或“位置登记副本”几份状态存在：
  // 刚入队时世界摆放还没被移除，或旧过场/静态地图里留下了同名副本。本幕点名了
  // 权威来源后，其余未绑定的同名副本只在本幕临时隐藏，不写回正式世界。
  const boundIds = new Set(bindings.map(([, id]) => id));
  for (const member of declaration.cast) {
    const boundId = bindings.find(([alias]) => alias === member.id)?.[1];
    const actor = boundId ? scene.actors.find(candidate => candidate.id === boundId) : undefined;
    const registered = !!actor?.worldEntityId?.startsWith('quest-npc-located-');
    // 只有真正的队伍实例（member: 前缀）才盖过地图副本；尚未入队时创建的是
    // story: 占位演员，此时地图上的 NPC 仍然应该按剧情正常显示。
    if (!actor || (!registered && (!actor.id.startsWith('member:') || actor.memberId === 'player'))) continue;
    for (const other of scene.actors) {
      if (other === actor || boundIds.has(other.id) || !other.worldEntityId || other.removed) continue;
      const sameCharacter = member.characterId ? other.characterId === member.characterId : other.actor === member.actor;
      if (!sameCharacter) continue;
      other.visible = false;
      other.stageHidden = true;
    }
  }
  const { mapFromWorld: _dynamic, resetActors: _reset, ...stage } = declaration;
  return syncStoryScene({ ...stage, map: scene.map, scene, bindings });
}

export function boundSceneActor(snapshot: StoryStageSnapshot, target: string): SceneActorState | undefined {
  const id = snapshot.bindings.find(([alias]) => alias === target)?.[1];
  return snapshot.scene.actors.find(actor => actor.id === id);
}

function bind(snapshot: StoryStageSnapshot, alias: string, actor: SceneActorState): void {
  snapshot.bindings = snapshot.bindings.filter(([name]) => name !== alias);
  const owner = snapshot.bindings.find(([, id]) => id === actor.id);
  if (owner) throw new Error(`剧情演员重复绑定：${alias} 与 ${owner[0]} 指向 ${actor.id}`);
  snapshot.bindings.push([alias, actor.id]);
}

/** 普通播放与跳过共用动作结束状态；时间、动画和寻路由 Phaser 表现层负责。 */
export function applyStorySceneAction(previous: StoryStageSnapshot, action: PerformanceAction): StoryStageSnapshot {
  if (action.type === 'stage') throw new Error('切换舞台需要先准备目标地图');
  const state = structuredClone(previous);
  if (action.type === 'parallel') {
    return action.actions.reduce<StoryStageSnapshot>((snapshot, child) => applyStorySceneAction(snapshot, child), state);
  }
  if (action.type === 'world-object') {
    const command = action.command;
    if (command.kind === 'place') {
      const entity = command.entity;
      const map = command.mapFromStage ? state.map : entity.map;
      if (map !== state.map) return state;
      const member = action.target ? state.cast.find(member => member.id === action.target) : undefined;
      let actor = state.scene.actors.find(actor => actor.worldEntityId === entity.id)
        ?? (action.mode !== 'create' && member ? findSceneActor(state.scene, member) : undefined);
      if (!actor) {
        actor = { id: `entity:${entity.id}`, actor: entity.actor!, worldEntityId: entity.id,
          characterId: entity.characterId, x: entity.x!, y: entity.y!, facing: entity.facing ?? 'south', visible: true };
        if (state.scene.actors.some(other => other.id === actor!.id)) actor.id = newId(state.scene, entity.id);
        state.scene.actors.push(actor);
      }
      const appearanceChanged=actor.actor!==entity.actor;
      Object.assign(actor, { actor: entity.actor!, worldEntityId:entity.id, characterId: entity.characterId, x: entity.x!, y: entity.y!,
        facing: entity.facing ?? actor.facing, visible: entity.visible !== false, unpositioned: false, removed:false });
      actor.clip=`idle-${actor.facing}`;actor.animationProgress=0;actor.animationPlaying=true;
      if(appearanceChanged)delete actor.appearance;
      controlIndependently(actor);
      if (action.target) bind(state, action.target, actor);
    } else if (command.kind === 'remove-character') {
      if ((command.mapFromStage ? state.map : command.map) !== state.map) return state;
      const matches = state.scene.actors.filter(actor => actor.characterId === command.characterId && !actor.unpositioned && !actor.removed);
      for (const actor of command.all ? matches : matches.slice(0, 1)) {
        controlIndependently(actor);actor.visible = false;actor.removed=true;
      }
    } else {
      for (const actor of state.scene.actors) if (actor.worldEntityId === command.id) {
        controlIndependently(actor);
        actor.visible = command.kind === 'show';actor.removed=command.kind==='remove';
      }
    }
    return syncStoryScene(state);
  }
  if (!('target' in action)) return state;
  let actor = boundSceneActor(state, action.target);
  if (!actor) throw new Error(`剧情没有声明对象：${action.target}`);
  if (action.type === 'appear') {
    if (action.mode === 'create' && action.target !== 'player') {
      const member = state.cast.find(member => member.id === action.target)!;
      actor = action.worldEntityId?state.scene.actors.find(actor=>actor.worldEntityId===action.worldEntityId):undefined;
      if(!actor){
        actor = actorFrom(member, newId(state.scene, action.target));
        delete actor.worldEntityId; delete actor.memberId; delete actor.enemyKey;
        state.scene.actors.push(actor);
      }
      bind(state, action.target, actor);
    }
    if(action.worldEntityId)actor.worldEntityId=action.worldEntityId;
    Object.assign(actor, { x: action.x, y: action.y, facing: action.facing, visible: true, unpositioned: false, removed:false });
    actor.clip=`idle-${actor.facing}`;actor.animationProgress=0;actor.animationPlaying=true;
    controlIndependently(actor);
  } else if (action.type === 'leave') {
    controlIndependently(actor);
    actor.visible = false;
  } else if (action.type === 'show') {
    if (!actor.unpositioned && !actor.removed) { controlIndependently(actor); actor.visible = true; }
  }
  else if (action.type === 'face' && !actor.removed) {
    actor.facing = action.facing;actor.clip=`idle-${actor.facing}`;actor.animationProgress=0;actor.animationPlaying=true;
  }
  else if (action.type === 'pose' && !actor.unpositioned && !actor.removed) {
    actor.clip=`${action.hold?action.pose:'idle'}-${actor.facing}`;
    actor.animationProgress=action.hold?1:0;
    actor.animationPlaying=!action.hold;
  }
  else if (action.type === 'walk' && !actor.unpositioned && !actor.removed) {
    if(actor.x!==action.x||actor.y!==action.y)actor.facing=faceTarget(actor,action);
    actor.x = action.x; actor.y = action.y;
    actor.clip=`idle-${actor.facing}`;actor.animationProgress=0;actor.animationPlaying=true;
  }
  return syncStoryScene(state);
}
