import { prepareTaskStart, storyTaskPreview, type StoryDebugPreview } from './story-jump.ts';
import { debugGapFor, debugTask, type StoryDebugAccept, type StoryDebugGap, type StoryDebugPlay, type StoryDebugTarget } from '../domain/story-debug.ts';
/**
 * GM（调试）动作层——**三种消费者共用的唯一实现**：
 *
 * - 游戏内面板（`ui/phaser/gm-panel.ts`）：人用手指点；
 * - `work/tools/gm.mjs`：agent 在没有浏览器的进程里跑真实内容；
 * - `globalThis.gm`：agent 在浏览器里经 CDP 驱动。
 *
 * 三者必须是同一份代码，否则「agent 验过的」与「人点的」不是同一件事，结论不能互信。
 *
 * **硬约束：本文件及其依赖不得出现 Phaser 或 UI 模块。** 一旦有人顺手 import 一个 UI 类型，
 * 无浏览器那条通道就断了（`work/tools/*.mjs` 与 `tests/*.test.ts` 直接 import 本文件）。
 * 需要展示什么由调用方决定，这里只返回数据。
 *
 * 另一个约定：除编程错误外**不抛错**，统一返回 `{ok, reason}`。面板要就地显示原因、agent 要断言、
 * 脚本要继续跑，三种需求都靠这个形状满足。
 */
import type { Campaign } from '../domain/campaign.ts';
import type { Session, SessionState } from '../domain/session.ts';
import type { StoryDirector } from '../domain/story-director.ts';
import type { ItemCategory } from '../domain/story-interface.ts';
import { organizedDebugInventory } from '../domain/inventory.ts';

export interface GmResult { ok: boolean; reason?: string }
export interface GmStoryPreview extends GmResult {
  preview?: StoryDebugPreview;
  /** 准备失败时，导出层的缺口记录（缺哪条证据）。 */
  gap?: StoryDebugGap;
}
export interface GmStoryJumpResult extends GmResult {
  sourceHash?: string;
  accept?: StoryDebugAccept;
  play?: StoryDebugPlay;
  gap?: StoryDebugGap;
}
export interface GmEndDebugResult extends GmResult { focus?: string }
/** 面板据此显示「调试现场：自动存档已暂停」与「结束本次调试」。 */
export interface GmDebugState { focus?: string; autoSavePaused: boolean }
/** 进入调试前的世界视图；动作层不依赖 Phaser，场景快照保持不透明。 */
export interface GmDebugWorldPort {
  capture(): unknown | undefined;
  restore(snapshot: unknown): Promise<GmResult>;
}
/** 脱困结果带前后位置，面板与 agent 都能确认搬到了哪里。 */
export interface GmRescueResult extends GmResult { from?: unknown; to?: unknown; moved?: boolean }

export type GmItemFilter = 'all' | ItemCategory;

/** 人物页一行：面板只显示，不自己推算角色数值。 */
export interface GmCharacterState {
  id: string;
  name: string;
  level: number;
  experience: number;
  nextLevelExperience: number;
  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
  alive: boolean;
  invincible: boolean;
  noCooldown: boolean;
}

/** 道具页一格：只列出能真正进背包的物品。 */
export interface GmItemEntry {
  id: string;
  name: string;
  category: ItemCategory;
  icon: string;
  stackable: boolean;
  level: number;
  owned: number;
}

export interface GmLevelResult extends GmResult { level?: number; gained?: number }
export interface GmGiveResult extends GmResult { item?: string; name?: string; requested?: number; total?: number }
export interface GmMoneyResult extends GmResult { money?: number }

/**
 * 战斗侧能力。headless 没有场景时不注入，相关动作如实返回失败，
 * 不假装成功——agent 与面板看到的是同一份结论。
 */
export interface GmCombatPort {
  setInvincible(actorId: string, enabled: boolean): GmResult;
  isInvincible(actorId: string): boolean;
  /** 把倒下角色救回来并做表现收尾；没有战斗场景时省略。 */
  revive?(actorId: string): GmResult;
}

export interface GmActionLogEntry {
  at: string;
  call: string;
  args: readonly unknown[];
  ok: boolean;
  reason?: string;
}

/**
 * 存档侧的调试开关。`gm-actions` 不认识 AutoSaver 或场景，只调用装配方给的两个动作：
 * 进入调试现场时暂停写入，结束调试时恢复并把当前现场重新记成检查点、请求一次正常存档。
 */
export interface GmPersistencePort {
  suspend(): void;
  resume(): void;
}

export interface GmPorts {
  session: Session;
  campaign: Campaign;
  director?: StoryDirector;
  /** 运行态（模式、锁、就绪…）由装配方提供——动作层不依赖 UI，也不该知道 app 的存在。 */
  status?: () => Record<string, unknown>;
  /** 把当前操控者从墙里/障碍里搬到最近可站点；由装配方注入，动作层不碰 Phaser。 */
  rescue?: () => GmRescueResult;
  /** 无敌、复活这些要落到战斗场景的能力；headless 省略。 */
  combat?: GmCombatPort;
  /** 上报通道。默认走既有的报错收集端点；测试与 Node 里替换掉。 */
  report?: (payload: unknown) => Promise<boolean>;
  onStoryPreparation?: (preparing:boolean)=>void;
  travel?: (map: string, position?: { x: number; y: number }) => Promise<GmResult>;
  /** 调试现场的存档暂停与恢复；没有存档系统时省略。 */
  persistence?: GmPersistencePort;
  /** 进入调试前的世界视图，用于任务完成后恢复正式地图。 */
  debugWorld?: GmDebugWorldPort;
  /** 调试收尾成功后打开设置里的调试剧情页。 */
  onDebugStory?: () => void;
  setNoclip?: (enabled: boolean) => GmResult;
  isNoclip?: () => boolean;
  setSpeedMultiplier?: (multiplier: number) => GmResult;
  getSpeedMultiplier?: () => number;
}

/** 既有报错收集端点（`public/diagnostics.js` 用的同一个）。只在开发服务挂载。 */
const DEFAULT_REPORT_ENDPOINT = '/__diagnostics/report';
/** 离线 APK 由壳在 document-start 注入绝对地址；网页版仍走同源端点。 */
const reportEndpoint = (): string => {
  const injected = (globalThis as { __inoitaDiagnosticsEndpoint?: unknown }).__inoitaDiagnosticsEndpoint;
  return typeof injected === 'string' && injected ? injected : DEFAULT_REPORT_ENDPOINT;
};
/** 端点单条上限 12 KB（`tools/diagnostic-collector.mjs`），留一点余量。 */
const ENTRY_BUDGET = 11000;
/** 操作日志环长度：够看清「刚才做了什么」，又不至于把上报撑爆。 */
const LOG_LIMIT = 40;

export interface GmActions {
  previewStory(target: StoryDebugTarget): Promise<GmStoryPreview>;
  jumpStory(target: StoryDebugTarget): Promise<GmStoryJumpResult>;
  /** 结束调试：恢复进入前状态、恢复自动存档并回到调试剧情页。 */
  endStoryDebug(): Promise<GmEndDebugResult>;
  /** 当前调试现场状态；面板显示存档暂停提示用。 */
  storyDebug(): GmDebugState;
  /** 机器可读的会话摘要。面板、上报、agent 读状态共用这一份。 */
  digest(): Record<string, unknown>;
  /** 把当前操控者搬到最近的可站立点（脱困）。 */
  rescue(): GmRescueResult;
  /** 上阵角色列表：人物页的选择与数值都读这一份。 */
  characters(): readonly GmCharacterState[];
  /** 升一级（只升不降）。 */
  levelUp(id: string): GmLevelResult;
  /** 回满 HP；角色已倒下时走战斗侧复活。 */
  restoreHealth(id: string): GmResult;
  /** 回满 MP。 */
  restoreMana(id: string): GmResult;
  /** 全队回满：存活成员直接回满，倒下成员走战斗侧复活。 */
  recoverParty(): GmResult;
  /** 切换某个角色的无敌开关。 */
  setInvincible(id: string, enabled: boolean): GmResult;
  /** 切换某个角色的技能无冷却。 */
  setNoCooldown(id: string, enabled: boolean): GmResult;
  /** 可发放物品：排除只能地面拾取的物品。 */
  items(filter?: GmItemFilter): readonly GmItemEntry[];
  /** 把指定数量加入背包。 */
  giveItem(item: string, quantity?: number): GmGiveResult;
  /** 增加金币。 */
  gainMoney(amount: number): GmMoneyResult;
  /** 当前持有金币。 */
  money(): number;
  /** 命名状态标记：出事前存一下，之后倒回来做 A/B。 */
  mark(name: string): GmResult;
  recall(name: string): GmResult;
  marks(): string[];
  /** 立刻完成指定或当前追踪/进行中的任务。 */
  completeCurrentQuest(questId?: string): GmResult;
  /** 穿墙（无视地形与单位碰撞）。 */
  setNoclip(enabled: boolean): GmResult;
  isNoclip(): boolean;
  /** 2倍速度开关。 */
  setDoubleSpeed(enabled: boolean): GmResult;
  isDoubleSpeed(): boolean;
  /** 最近做过哪些 GM 操作（含参数），用于复现问题。 */
  actions(): readonly GmActionLogEntry[];
  /** 把摘要（含操作日志）上报到服务器，手机上不用复制一大段文本。 */
  report(): Promise<GmResult>;
}

export function createGmActions(ports: GmPorts): GmActions {
  const { session, campaign, director } = ports;
  const log: GmActionLogEntry[] = [];
  const marks = new Map<string, SessionState>();
  let jumping = false;

  const record = (call: string, args: readonly unknown[], result: GmResult): void => {
    log.push({ at: new Date().toISOString(), call, args, ok: result.ok, ...(result.reason ? { reason: result.reason } : {}) });
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  };
  /** 统一入口：记录日志，并把异常转成 `{ok:false, reason}`；泛型保留附加字段。 */
  const run = <T extends GmResult>(call: string, args: readonly unknown[], work: () => T): T => {
    let result: T;
    try { result = work(); }
    catch (error) { result = { ok: false, reason: error instanceof Error ? error.message : String(error) } as T; }
    record(call, args, result);
    return result;
  };
  const runAsync = async <T extends GmResult>(call: string, args: readonly unknown[], work: () => Promise<T>): Promise<T> => {
    let result: T;
    try { result = await work(); }
    catch (error) { result = { ok: false, reason: error instanceof Error ? error.message : String(error) } as T; }
    record(call, args, result);
    return result;
  };

  interface DebugRun {
    quest: string;
    origin: SessionState;
    world?: unknown;
    baseline: { status: string; cycle: number; completedCycles: number };
    started: boolean;
    pending: boolean;
    unsubscribe?: () => void;
    timer?: ReturnType<typeof setTimeout>;
    finishing?: Promise<GmEndDebugResult>;
  }
  let debugRun: DebugRun | undefined;

  const debugTaskCompleted = (run: DebugRun): boolean => {
    const progress = session.quests.get(run.quest);
    if (!progress) return false;
    if (progress.completedCycles > run.baseline.completedCycles) return true;
    return progress.status === 'completed' && run.baseline.status !== 'completed';
  };

  const runIdle = (): boolean => !session.storyWorld.activeEncounters.length
    && !session.runtimeState.runs.some(run => !!run.waiting);

  const finishDebugRun = async (run: DebugRun, openStory: boolean): Promise<GmEndDebugResult> => {
    if (run.finishing) return run.finishing;
    run.finishing = (async (): Promise<GmEndDebugResult> => {
      run.unsubscribe?.(); run.unsubscribe = undefined;
      if (run.timer) { clearTimeout(run.timer); run.timer = undefined; }
      const debugSession = session.captureState();
      const debugWorld = ports.debugWorld?.capture();
      const restore = async (): Promise<GmEndDebugResult> => {
        session.restoreState(run.origin);
        session.focusDebugQuest(undefined);
        if (ports.debugWorld && run.world !== undefined) {
          const restored = await ports.debugWorld.restore(run.world);
          if (!restored.ok) return { ok: false, reason: restored.reason ?? '恢复调试前地图失败' };
        }
        return { ok: true, focus: run.quest };
      };
      let result: GmEndDebugResult;
      try {
        result = director ? await director.debugJump(restore) : await restore();
      } catch (error) {
        result = { ok: false, reason: `恢复调试前状态失败：${error instanceof Error ? error.message : String(error)}` };
      }
      if (result.ok) {
        debugRun = undefined;
        try {
          ports.persistence?.resume();
          if (openStory) ports.onDebugStory?.();
        } catch (error) {
          return { ok: false, reason: `调试已恢复，但自动存档恢复失败：${error instanceof Error ? error.message : String(error)}` };
        }
        return result;
      }
      // 恢复失败时不要把半恢复的会话留在正常存档里：退回调试现场，继续暂停自动存档。
      try { session.restoreState(debugSession); } catch { /* 保留当前可用的诊断信息 */ }
      try { if (ports.debugWorld && debugWorld !== undefined) await ports.debugWorld.restore(debugWorld); } catch { /* 同上 */ }
      run.finishing = undefined;
      debugRun = run;
      if (!run.unsubscribe) watchDebugRun(run);
      return result;
    })();
    return run.finishing;
  };

  const scheduleDebugFinish = (run: DebugRun): void => {
    if (run.finishing || debugRun !== run) return;
    if (!run.started) { run.pending = true; return; }
    if (!runIdle()) {
      if (!run.timer) run.timer = setTimeout(() => { run.timer = undefined; scheduleDebugFinish(run); }, 250);
      return;
    }
    void finishDebugRun(run, true).then(result => {
      if (!result.ok) record('finishDebugRun', [], result);
    });
  };

  const watchDebugRun = (run: DebugRun): void => {
    run.unsubscribe = session.subscribe(() => {
      if (debugRun !== run || run.finishing || !debugTaskCompleted(run)) return;
      run.pending = true;
      if (run.started) scheduleDebugFinish(run);
    });
  };

  const questDigest = () => {
    const counts: Record<string, number> = {};
    const active: { id: string; title: string }[] = [], ready: { id: string; title: string }[] = [];
    for (const [id, state] of session.quests) {
      counts[state.status] = (counts[state.status] ?? 0) + 1;
      if (state.status === 'active') active.push({ id, title: campaign.quests.find(quest => quest.id === id)?.title ?? id });
      if (state.status === 'ready') ready.push({ id, title: campaign.quests.find(quest => quest.id === id)?.title ?? id });
    }
    // `currentQuest()` 是「正在追踪的，否则第一条可见的进行中任务」——不是单独的追踪字段。
    return { counts, active, ready, current: session.currentQuest()?.id };
  };

  const worldDigest = () => {
    const state = session.storyWorld.captureState();
    return {
      flags: [...session.storyWorld.flagIds].sort(),
      choices: state.choices,
      entities: state.entities.map(entity => ({ id: entity.id, map: entity.map, actor: entity.actor, x: entity.x, y: entity.y })),
      encounters: session.storyWorld.activeEncounters.map(encounter => ({ id: encounter.id, map: encounter.map, status: encounter.status })),
    };
  };

  const storyDigest = () => {
    const snapshot = director?.runtime.snapshot();
    return {
      completedEvents: snapshot?.completedEvents.length ?? 0,
      lastCompleted: snapshot?.completedEvents.slice(-8) ?? [],
      pendingOccurrences: snapshot?.pendingOccurrences.length ?? 0,
      runs: snapshot?.runs.filter(run => run.status !== 'completed').map(run => ({
        id: run.id, event: run.eventId, script: run.cursor.script, node: run.cursor.node,
        source: run.occurrenceSource, status: run.status,
        ...(run.waiting ? { waiting: run.waiting.encounter } : {}),
      })) ?? [],
      busy: director?.busy ?? false,
    };
  };

  const playerDigest = (member: { player: { level: number; health: number; maxHealth: number; mana: number; maxMana: number } } | undefined) =>
    member ? { level: member.player.level, health: member.player.health, maxHealth: member.player.maxHealth,
      mana: member.player.mana, maxMana: member.player.maxMana } : null;

  // 人物页与动作校验共用：只有上阵角色允许改，避免把数值写到不在队伍里的佣兵。
  const memberOf = (id: string) => id === 'player' ? session.hero : session.party?.get(id);
  const activeIds = (): readonly string[] => session.party?.activeIds ?? (session.hero ? ['player'] : []);
  const activeMember = (id: string) => activeIds().includes(id) ? memberOf(id) : undefined;
  const characterOf = (id: string, member: NonNullable<ReturnType<typeof memberOf>>): GmCharacterState => {
    const player = member.player;
    return {
      id, name: id === 'player' ? '主角' : session.party?.get(id)?.definition.name ?? id,
      level: player.level, experience: player.experience, nextLevelExperience: player.nextLevelExperience,
      health: player.health, maxHealth: player.maxHealth, mana: player.mana, maxMana: player.maxMana,
      alive: player.health > 0,
      invincible: ports.combat?.isInvincible(id) ?? false,
      noCooldown: session.cooldowns.isFree(id),
    };
  };

  const digest = (): Record<string, unknown> => {
    const location = session.storyWorld.currentLocation;
    const party = session.party;
    // 主角不在队伍名册里（`owned` 只放佣兵），它的数值要单独从 `session.hero` 取。
    return {
      at: new Date().toISOString(),
      runtime: ports.status?.() ?? {},
      location: location ? { ...location, visit: session.storyWorld.visit } : null,
      player: { classId: session.hero?.classId ?? null, ...playerDigest(session.hero) },
      party: party ? {
        controlled: party.controlledId,
        active: party.activeIds,
        members: party.activeIds.map(id => ({ id, ...playerDigest(memberOf(id)), alive: party.alive(id) })),
      } : null,
      money: session.money,
      quests: questDigest(),
      debug: session.debugFocusQuest ? { focus: session.debugFocusQuest, autoSavePaused: true } : null,
      world: worldDigest(),
      story: storyDigest(),
      gm: { actions: log },
    };
  };

  /** 上报端点单条限 12 KB：逐级丢掉最占体积的列表，保证一定发得出去。 */
  const fitEntry = (entry: Record<string, unknown>): { entry: Record<string, unknown>; trimmed: boolean } => {
    const size = (value: unknown) => JSON.stringify(value).length;
    if (size(entry) <= ENTRY_BUDGET) return { entry, trimmed: false };
    const candidates: Record<string, unknown>[] = [];
    const compact = (digestValue: Record<string, unknown>) => {
      const clone = structuredClone(digestValue) as Record<string, unknown>;
      const gm = clone.gm as { actions: GmActionLogEntry[] };
      const world = clone.world as Record<string, unknown>;
      const quests = clone.quests as Record<string, unknown>;
      const story = clone.story as Record<string, unknown>;
      gm.actions = gm.actions.slice(-8);
      candidates.push(structuredClone(clone));
      world.entities = (world.entities as unknown[]).length;
      candidates.push(structuredClone(clone));
      world.flags = (world.flags as unknown[]).length;
      world.choices = (world.choices as unknown[]).length;
      candidates.push(structuredClone(clone));
      quests.active = (quests.active as unknown[]).length;
      quests.ready = (quests.ready as unknown[]).length;
      candidates.push(structuredClone(clone));
      story.lastCompleted = (story.lastCompleted as unknown[]).length;
      candidates.push(structuredClone(clone));
    };
    compact(entry);
    const fit = candidates.find(candidate => size(candidate) <= ENTRY_BUDGET);
    return fit ? { entry: fit, trimmed: true } : { entry: candidates.at(-1)!, trimmed: true };
  };

  const defaultReport = async (payload: unknown): Promise<boolean> => {
    if (typeof fetch !== 'function') return false;
    try {
      const response = await fetch(reportEndpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      // 离线壳没有注入远程地址时，同源端点只是 asset loader 的 204 占位，不能当成已上报。
      if (response.ok && typeof location !== 'undefined'
        && location.hostname === 'appassets.androidplatform.net'
        && reportEndpoint() === DEFAULT_REPORT_ENDPOINT) return false;
      return response.ok;
    } catch { return false; }
  };

  return {
    previewStory: async target => {
      try {
        const prepared = await prepareTaskStart(session, target);
        return { ok: true, preview: storyTaskPreview(campaign, target, prepared) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const gap = debugGapFor(campaign, target.quest);
        return { ok: false, reason: gap ? `${reason}（缺口：${gap.detail}）` : reason, ...(gap ? { gap } : {}) };
      }
    },
    jumpStory: target => runAsync('jumpStory', [target], async (): Promise<GmStoryJumpResult> => {
      if (!director) return {ok:false,reason:'当前会话还没有装配剧情导演'};
      if (jumping) return {ok:false,reason:'正在准备剧情，请稍候'};
      if (debugRun) return {ok:false,reason:'当前已有调试现场，请先结束本次调试'};
      jumping = true;
      const gaps = () => { const gap = debugGapFor(campaign, target.quest); return gap ? { gap } : {}; };
      let origin: SessionState | undefined;
      let originWorld: unknown;
      let installed = false;
      const restoreOrigin = async (): Promise<void> => {
        if (!origin) return;
        session.restoreState(origin);
        if (ports.debugWorld && originWorld !== undefined) await ports.debugWorld.restore(originWorld);
        ports.persistence?.resume();
      };
      try {
        // 准备、安装与切图都在导演的调试锁里完成；开幕演出等锁放开后再开演，
        // 否则演出里的选项和操作会被同一把锁挡住。
        const result = await director.debugJump(async (): Promise<GmResult> => {
          ports.onStoryPreparation?.(true);
          try {
            const prepared = await prepareTaskStart(session, target);
            origin = session.captureState();
            originWorld = ports.debugWorld?.capture();
            // 调试现场不写玩家存档：先停掉待写与重试，安装时任务变化也不再排队。
            ports.persistence?.suspend();
            session.restoreState(prepared);
            installed = true;
            const location = prepared.storyWorld.location;
            if (ports.travel && location) {
              try {
                const moved = await ports.travel(location.map, location);
                // 切图失败会把会话退回原处（通常就是玩家当前站的地图），原因要如实带出去，
                // 否则表现只是「人还在原地」，看不出是没进成这段剧情。
                if (!moved.ok) {
                  await restoreOrigin();
                  installed = false;
                  return {ok:false, reason:`没能进入剧情所在地图：${moved.reason??'未知原因'}`, ...gaps()};
                }
              } catch (error) {
                await restoreOrigin();
                installed = false;
                throw error;
              }
            }
            return {ok:true};
          } finally { ports.onStoryPreparation?.(false); }
        });
        if (!result.ok) return {ok:false, reason:result.reason, ...gaps()};
        if (!origin) throw new Error('调试现场缺少进入前状态');
        const task = debugTask(campaign, target);
        const progress = session.quests.get(target.quest);
        const run: DebugRun = {
          quest: target.quest, origin, world: originWorld,
          baseline: { status: progress?.status ?? 'locked', cycle: progress?.cycle ?? 0, completedCycles: progress?.completedCycles ?? 0 },
          started: false, pending: false,
        };
        debugRun = run;
        watchDebugRun(run);
        const play = task.play;
        if (play?.script) {
          try { await director.script(play.script, play.node); }
          catch (error) {
            await finishDebugRun(run, false);
            return {ok:false, reason:`开幕演出未能播放：${error instanceof Error ? error.message : String(error)}`, ...gaps()};
          }
        }
        run.started = true;
        if (run.pending) scheduleDebugFinish(run);
        return {ok:true, ...(task.sourceHash ? { sourceHash: task.sourceHash } : {}),
          ...(task.accept ? { accept: task.accept } : {}), ...(play ? { play } : {})};
      } catch (error) {
        if (installed) {
          try { await restoreOrigin(); }
          catch { /* 保留原始失败原因 */ }
        }
        return {ok:false, reason:error instanceof Error ? error.message : String(error), ...gaps()};
      } finally { jumping = false; }
    }),
    endStoryDebug: () => runAsync('endStoryDebug', [], async (): Promise<GmEndDebugResult> => {
      if (debugRun) return finishDebugRun(debugRun, true);
      const focus = session.debugFocusQuest;
      if (!focus) return {ok:false, reason:'当前没有调试现场'};
      // 兼容没有进入前快照的旧调试状态：至少退出调试焦点并恢复自动存档。
      session.focusDebugQuest(undefined);
      try { ports.persistence?.resume(); }
      catch (error) { return {ok:false, reason:`恢复存档失败：${error instanceof Error ? error.message : String(error)}`}; }
      return {ok:true, focus};
    }),
    storyDebug: () => ({ focus: session.debugFocusQuest, autoSavePaused: !!session.debugFocusQuest }),
    digest,
    rescue: () => {
      let result: GmRescueResult;
      try { result = ports.rescue?.() ?? { ok: false, reason: '当前会话不支持脱困' }; }
      catch (error) { result = { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
      record('rescue', [], result);
      return result;
    },
    characters: () => activeIds().flatMap(id => {
      const member = memberOf(id);
      return member ? [characterOf(id, member)] : [];
    }),
    levelUp: id => run('levelUp', [id], () => {
      const member = activeMember(id);
      if (!member) return { ok: false, reason: `没有上阵角色：${id}` };
      const player = member.player;
      if (player.health <= 0) return { ok: false, reason: '角色已倒下，请先回满 HP 复活' };
      if (player.nextLevelExperience <= 0) return { ok: false, reason: '已经满级' };
      // 门槛是「本级升到下一级所需经验」，当前经验是已累计的部分，差值正好升一级。
      const delta = player.nextLevelExperience - player.experience;
      if (delta <= 0) return { ok: false, reason: '经验数据不可用，无法计算到下一级' };
      const gained = member.addExperience(delta);
      if (gained <= 0) return { ok: false, reason: '升级未生效' };
      return { ok: true, level: member.player.level, gained };
    }),
    restoreHealth: id => run('restoreHealth', [id], () => {
      const member = activeMember(id);
      if (!member) return { ok: false, reason: `没有上阵角色：${id}` };
      if (member.player.health > 0) { member.setHealth(member.player.maxHealth); return { ok: true }; }
      const revive = ports.combat?.revive;
      if (!revive) return { ok: false, reason: '角色已倒下，当前会话无法完成复活' };
      return revive(id);
    }),
    restoreMana: id => run('restoreMana', [id], () => {
      const member = activeMember(id);
      if (!member) return { ok: false, reason: `没有上阵角色：${id}` };
      if (member.player.health <= 0) return { ok: false, reason: '角色已倒下，请先回满 HP 复活' };
      member.setMana(member.player.maxMana);
      return { ok: true };
    }),
    recoverParty: () => run('recoverParty', [], () => {
      const ids = activeIds();
      if (!ids.length) return { ok: false, reason: '当前会话没有角色' };
      const revive = ports.combat?.revive;
      let healed = 0, revived = 0, blocked = 0, blockedReason = '';
      for (const id of ids) {
        const member = memberOf(id);
        if (!member) continue;
        if (member.player.health > 0) { member.recover(); healed += 1; continue; }
        if (!revive) { blocked += 1; continue; }
        const result = revive(id);
        if (result.ok) revived += 1; else { blocked += 1; blockedReason ||= result.reason ?? ''; }
      }
      if (!healed && !revived) return { ok: false, reason: blockedReason || '没有可恢复的角色' };
      return { ok: true, ...(blocked ? { reason: `${blocked} 名倒下角色未能复活` } : {}) };
    }),
    setInvincible: (id, enabled) => run('setInvincible', [id, enabled], () => {
      if (!activeMember(id)) return { ok: false, reason: `没有上阵角色：${id}` };
      const combat = ports.combat;
      if (!combat) return { ok: false, reason: '当前会话没有战斗场景，无法切换无敌' };
      return combat.setInvincible(id, enabled);
    }),
    setNoCooldown: (id, enabled) => run('setNoCooldown', [id, enabled], () => {
      if (!activeMember(id)) return { ok: false, reason: `没有上阵角色：${id}` };
      session.cooldowns.setFree(id, enabled);
      return { ok: true };
    }),
    items: (filter = 'all') => {
      const definitions = session.bag.catalog.items;
      const counts = session.bag.counts;
      const eligible = Object.entries(definitions).filter(([, definition]) =>
        !definition.pickup && (filter === 'all' || definition.category === filter));
      // 装备先按种类分组、组内等级升序；其它物品保持「分类 → 中文自然序 → id」。
      return organizedDebugInventory(new Map(eligible.map(([id]) => [id, 1] as const)), definitions)
        .map(([id]) => {
          const definition = definitions[id]!;
          return { id, name: definition.name, category: definition.category, icon: definition.icon,
            stackable: definition.stackable, level: definition.level, owned: counts.get(id) ?? 0 };
        });
    },
    giveItem: (item, quantity = 1) => run('giveItem', [item, quantity], () => {
      const definition = session.bag.catalog.items[item];
      if (!definition) return { ok: false, reason: `未找到物品：${item}` };
      if (definition.pickup) return { ok: false, reason: '该物品只能在地面拾取，不能直接发放' };
      if (!Number.isSafeInteger(quantity) || quantity <= 0) return { ok: false, reason: '数量必须是正整数' };
      if (quantity > 999) return { ok: false, reason: '单次最多发放 999 个' };
      session.bag.add(item, quantity);
      // `Bag.add` 只改内部状态，不通知订阅者；任务计数和菜单要靠这一下刷新。
      session.emit();
      return { ok: true, item, name: definition.name, requested: quantity, total: session.bag.count(item) };
    }),
    gainMoney: amount => run('gainMoney', [amount], () => {
      if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: '金币数量必须是正整数' };
      if (amount > 100_000_000) return { ok: false, reason: '单次最多增加 100,000,000' };
      session.gainMoney(amount);
      return { ok: true, money: session.money };
    }),
    money: () => session.money,
    marks: () => [...marks.keys()],
    mark: name => run('mark', [name], () => {
      if (!name) return { ok: false, reason: '标记需要名字' };
      marks.set(name, session.captureState());
      return { ok: true };
    }),
    recall: name => run('recall', [name], () => {
      const state = marks.get(name);
      if (!state) return { ok: false, reason: `没有名为 ${name} 的标记` };
      session.restoreState(state);
      return { ok: true };
    }),
    completeCurrentQuest: (questId?: string) => run('completeCurrentQuest', [questId], () => {
      const activeList = questDigest().active;
      const targetId = questId ?? session.currentQuest()?.id ?? activeList[0]?.id;
      if (!targetId) return { ok: false, reason: '当前没有进行中的任务' };
      const quest = session.definition(targetId);
      if (!quest) return { ok: false, reason: `未找到任务定义：${targetId}` };
      const status = session.status(targetId);
      if (status === 'completed') return { ok: false, reason: `任务「${quest.title}」已完成` };

      if (status === 'available') {
        session.applyStoryCommands([{ type: 'quest', command: { type: 'accept', quest: targetId, cycle: session.questBook.state(targetId)?.cycle } }]);
      }

      for (const item of quest.handoverItems ?? []) {
        const held = session.bag.count(item.item);
        if (held < item.quantity) {
          session.bag.add(item.item, item.quantity - held);
        }
      }

      if (session.questBook.pinned(targetId)) session.unpinDebugQuest(targetId);

      session.applyStoryCommands([{
        type: 'quest',
        command: { type: 'script-complete', quest: targetId, cycle: session.questBook.state(targetId)?.cycle }
      }]);

      return { ok: true, reason: `已完成任务「${quest.title}」` };
    }),
    setNoclip: enabled => run('setNoclip', [enabled], () => {
      if (ports.setNoclip) return ports.setNoclip(enabled);
      return { ok: true };
    }),
    isNoclip: () => ports.isNoclip?.() ?? false,
    setDoubleSpeed: enabled => run('setDoubleSpeed', [enabled], () => {
      if (ports.setSpeedMultiplier) return ports.setSpeedMultiplier(enabled ? 2 : 1);
      return { ok: true };
    }),
    isDoubleSpeed: () => (ports.getSpeedMultiplier?.() ?? 1) > 1,
    actions: () => [...log],
    report: async () => {
      let result: GmResult;
      try {
        const { entry, trimmed } = fitEntry(digest());
        const payload = { version: 1, entries: [{ id: `gm:${Date.now()}`, kind: 'gm-state', time: new Date().toISOString(), digest: entry }] };
        const sent = await (ports.report ?? defaultReport)(payload);
        result = sent ? { ok: true, ...(trimmed ? { reason: '已裁剪到上报上限' } : {}) } : { ok: false, reason: '上报端点不可用' };
      } catch (error) { result = { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
      record('report', [], result);
      return result;
    },
  };
}
