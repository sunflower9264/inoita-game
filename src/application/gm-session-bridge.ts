import type { Campaign } from '../domain/campaign.ts';
import type { TravelDestination } from '../domain/content.ts';
import type { Session } from '../domain/session.ts';
import type { CheckpointSnapshot, SessionCheckpoint } from '../domain/session-checkpoint.ts';
import type { StoryDirector } from '../domain/story-director.ts';
import type { StoryStageSnapshot } from '../domain/story-performance.ts';
import type { QuestAcceptCandidate } from '../debug/quest-jump.ts';
import {
  createGmActions,
  type GmActions,
  type GmStoryJumpPort,
  type GmStoryJumpSnapshot,
} from '../debug/gm-actions.ts';

type GmResult = { ok: boolean; reason?: string };
import type { StoryWorldViewSnapshot } from './world-snapshot.ts';

declare global {
  /** GM 打开时才挂上的调试动作层，agent 经 CDP 驱动它（与游戏内面板同一份实现）。 */
  var gm: GmActions | undefined;
}

const STORY_JUMP_SETTLE_POLL_MS = 200;

/** GM 与剧情跳转访问正式世界场景时的最小能力接口；与 Phaser 场景实现解耦。 */
export interface GmWorldScenePort {
  readonly map?: { readonly id: string };
  worldReady(): boolean;
  captureStoryWorld(includeEnemyAppearance?: boolean): StoryWorldViewSnapshot;
  projectStoryWorld(
    stage: StoryStageSnapshot | undefined,
    signal: AbortSignal,
    restoredLocation?: TravelDestination,
  ): Promise<void>;
  restoreStoryWorld(snapshot: unknown, signal: AbortSignal): Promise<void>;
  checkpointStoryWorld(): void;
  rescuePlayer(): { ok: boolean; reason?: string; from?: unknown; to?: unknown; moved?: boolean };
  setNoclip(enabled: boolean): GmResult;
  setSpeedMultiplier(multiplier: number): GmResult;
  setInvincible(actorId: string, enabled: boolean): GmResult;
  setInfiniteMana(actorId: string, enabled: boolean): GmResult;
  setOneHitKill(actorId: string, enabled: boolean): GmResult;
  reviveMember(id: string): GmResult;
}

export interface GmSessionBridgeApp {
  readonly session: Session;
  readonly director: StoryDirector;
  readonly checkpoint: SessionCheckpoint<StoryWorldViewSnapshot>;
  readonly storyUI?: {
    close(): void;
    diagnosticState(): unknown;
  };
  gm?: GmActions;
  gmNoclip: boolean;
  gmSpeedMultiplier: number;
  storyJumpActive: boolean;
  autoSave?: () => void;
}

export interface GmSessionBridgeInput {
  readonly app: GmSessionBridgeApp;
  readonly session: Session;
  readonly campaign: Campaign;
  readonly director: StoryDirector;
  readonly signal: AbortSignal;
  readonly gmOn: () => boolean;
  readonly worldScene: () => GmWorldScenePort | undefined;
  readonly runtimeDiagnostics: () => Record<string, unknown>;
}

/** 摘除当前挂在应用与全局调试钩子上的 GM 动作层。 */
export function detachGmSessionBridge(app: { gm?: GmActions }): void {
  app.gm?.dispose();
  app.gm = undefined;
  delete globalThis.gm;
}

/**
 * 为已装配好的会话绑定 GM 动作层和剧情跳转通道；
 * 调试开关关闭时显式保持 `app.gm` 与 `globalThis.gm` 为空。
 */
export function attachGmSessionBridge(input: GmSessionBridgeInput): GmActions | undefined {
  const { app, session, campaign, director, signal, gmOn, worldScene, runtimeDiagnostics } = input;
  const activeSession = (): boolean => app.session === session && !signal.aborted && app.director === director;

  const storyJump: GmStoryJumpPort = {
    ready: () => !!worldScene()?.worldReady(),
    capture: (): GmStoryJumpSnapshot => {
      const scene = worldScene();
      if (!scene?.worldReady()) throw new Error('正式地图尚未就绪');
      return { session: session.captureState(), world: scene.captureStoryWorld(), checkpoint: app.checkpoint.peek() };
    },
    begin: () => {
      director.holdTriggers();
      app.storyJumpActive = true;
    },
    releaseTriggers: () => {
      director.releaseTriggers();
    },
    closeMenu: () => {
      app.storyUI?.close();
    },
    travel: async destination => {
      if (!activeSession()) throw new Error('会话已经关闭');
      const scene = worldScene();
      if (!scene) throw new Error('不在游戏场景里');
      if (destination.map === session.storyWorld.currentLocation?.map) session.movePlayer(destination);
      else session.applyStoryCommands([{ type: 'travel', destination }]);
      await scene.projectStoryWorld(undefined, signal, destination);
      if (!activeSession()) throw new Error('会话已经关闭');
      if (!scene.worldReady() || scene.map?.id !== destination.map) throw new Error('所选阶段的地图尚未就绪');
    },
    play: async (accept: QuestAcceptCandidate) => {
      app.storyUI?.close();
      if (!activeSession()) return false;
      if (accept.eventId) return director.trigger({ id: accept.eventId, script: accept.script });
      return director.script(accept.script);
    },
    settled: async (accept: QuestAcceptCandidate) => {
      // `play` 在遇到剧情战斗等待时会先返回；等这条 run 真正结束再交接，
      // 避免在战斗前就清掉强制状态或提前恢复自动存档。
      while (activeSession()) {
        const active = director.runtime.snapshot().runs.some(run =>
          (run.status === 'running' || run.status === 'waiting') &&
          (accept.eventId ? run.eventId === accept.eventId
            : run.script === accept.script || run.cursor.script === accept.script));
        if (!active) return;
        await new Promise<void>(resolve => setTimeout(resolve, STORY_JUMP_SETTLE_POLL_MS));
      }
    },
    restore: async (snapshot: GmStoryJumpSnapshot) => {
      const scene = worldScene();
      if (!scene) throw new Error('不在游戏场景里');
      // 恢复期间任务簿会变化，不能让它顺手触发剧情。
      director.holdTriggers();
      try {
        session.restoreState(snapshot.session);
        await scene.restoreStoryWorld(snapshot.world, signal);
        // await 期间可能已经回标题/读档；身份不对时不能再写全局检查点。
        if (!activeSession()) throw new Error('会话已经关闭');
        app.checkpoint.install(snapshot.checkpoint as CheckpointSnapshot<StoryWorldViewSnapshot> | undefined);
        app.storyJumpActive = false;
      } finally {
        director.releaseTriggers();
      }
    },
    checkpoint: () => {
      worldScene()?.checkpointStoryWorld();
    },
    finish: () => {
      app.storyJumpActive = false;
      director.releaseTriggers();
    },
    dispose: () => {
      session.questBook.clearDebugOverrides();
      app.storyJumpActive = false;
      director.releaseTriggers();
    },
  };

  // GM 动作层在会话装配好之后才建（它要 session 与 director）；开关关闭时**不建也不挂**，
  // 这样「默认关闭」是结构上的保证，而不是靠调用方自觉。
  app.gm = gmOn() ? createGmActions({
    session,
    campaign,
    director,
    storyJump,
    requestAutoSave: () => app.autoSave?.(),
    status: () => runtimeDiagnostics(),
    rescue: () => {
      const scene = worldScene();
      if (!scene) return { ok: false, reason: '不在游戏场景里' };
      return scene.rescuePlayer();
    },
    setNoclip: enabled => {
      signal.throwIfAborted();
      app.gmNoclip = enabled;
      const scene = worldScene();
      if (scene) scene.setNoclip(enabled);
      return { ok: true };
    },
    isNoclip: () => app.gmNoclip,
    setSpeedMultiplier: multiplier => {
      signal.throwIfAborted();
      app.gmSpeedMultiplier = multiplier;
      const scene = worldScene();
      if (scene) scene.setSpeedMultiplier(multiplier);
      return { ok: true };
    },
    getSpeedMultiplier: () => app.gmSpeedMultiplier ?? 1,
    ui: () => app.storyUI?.diagnosticState(),
    combat: {
      setInvincible: (id, enabled) => {
        const scene = worldScene();
        return scene ? scene.setInvincible(id, enabled) : { ok: false, reason: '不在游戏场景里' };
      },
      // 开关存在会话上，换图重建战斗后仍然有效，所以读取不必经过场景。
      isInvincible: id => session.isInvincible(id),
      setInfiniteMana: (id, enabled) => {
        const scene = worldScene();
        return scene ? scene.setInfiniteMana(id, enabled) : { ok: false, reason: '不在游戏场景里' };
      },
      isInfiniteMana: id => session.isInfiniteMana(id),
      setOneHitKill: (id, enabled) => {
        const scene = worldScene();
        return scene ? scene.setOneHitKill(id, enabled) : { ok: false, reason: '不在游戏场景里' };
      },
      isOneHitKill: id => session.isOneHitKill(id),
      revive: id => {
        const scene = worldScene();
        return scene ? scene.reviveMember(id) : { ok: false, reason: '不在游戏场景里' };
      },
    },
  }) : undefined;

  if (app.gm) globalThis.gm = app.gm;
  else delete globalThis.gm;
  return app.gm;
}
