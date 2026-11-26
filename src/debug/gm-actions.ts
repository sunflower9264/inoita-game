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
import type { TravelDestination } from '../domain/content.ts';
import type { ItemCategory } from '../domain/story-interface.ts';
import { buildQuestCatalog, projectQuestCatalog, type QuestCatalogGroup } from './quest-catalog.ts';
import { applyQuestStartPlan, planQuestStart, type QuestAcceptCandidate, type QuestStartMode, type QuestStartPlan } from './quest-jump.ts';
import { organizedDebugInventory } from '../domain/inventory.ts';
import { encounterSpawnId } from '../domain/world-enemies.ts';
import { DIAGNOSTICS_REPORT_PATH, diagnosticsReportUrl } from '../application/endpoints.ts';

interface GmResult { ok: boolean; reason?: string }

/** 跳转前快照；world/checkpoint 的字段由装配方解释，动作层不依赖 application。 */
export interface GmStoryJumpSnapshot {
  session: SessionState;
  world: unknown;
  checkpoint?: unknown;
}

/** 场景侧提供的剧情跳转能力；动作层只负责流程和状态，不碰 Phaser。 */
export interface GmStoryJumpPort {
  ready(): boolean;
  capture(): GmStoryJumpSnapshot;
  /** 挡住设置阶段的自动触发，并标记跳转事务进行中（暂停自动存档）。 */
  begin(): void;
  /** 状态设置和传送完成后恢复普通触发，让接取剧情能真正开演。 */
  releaseTriggers(): void;
  closeMenu(): void;
  travel(destination: TravelDestination): Promise<void>;
  /** 播放接取剧情；遇到剧情战斗等待时 Promise 会先 resolve，返回是否真的开始播放。 */
  play(accept: QuestAcceptCandidate): Promise<boolean>;
  /** 等这段接取剧情真正结束（含战斗等待后的续播）；没有这个方法时视为 play 返回即结束。 */
  settled?(accept: QuestAcceptCandidate): Promise<void>;
  restore(snapshot: GmStoryJumpSnapshot): Promise<void>;
  /** 交接后把当前现场记为新的回滚检查点。 */
  checkpoint?(): void;
  /** 结束跳转事务，恢复自动存档与触发。 */
  finish(): void;
  dispose(): void;
}

/** 脱困结果带前后位置，面板与 agent 都能确认搬到了哪里。 */
interface GmRescueResult extends GmResult { from?: unknown; to?: unknown; moved?: boolean }

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
  infiniteMana: boolean;
  oneHitKill: boolean;
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

interface GmLevelResult extends GmResult { level?: number; gained?: number }
interface GmSkillResult extends GmResult { learned?: number; maxed?: number }
interface GmGiveResult extends GmResult { item?: string; name?: string; requested?: number; total?: number }
interface GmMoneyResult extends GmResult { money?: number }

/**
 * 战斗侧能力。headless 没有场景时不注入，相关动作如实返回失败，
 * 不假装成功——agent 与面板看到的是同一份结论。
 */
export interface GmCombatPort {
  setInvincible(actorId: string, enabled: boolean): GmResult;
  isInvincible(actorId: string): boolean;
  setInfiniteMana(actorId: string, enabled: boolean): GmResult;
  isInfiniteMana(actorId: string): boolean;
  setOneHitKill(actorId: string, enabled: boolean): GmResult;
  isOneHitKill(actorId: string): boolean;
  /** 把倒下角色救回来并做表现收尾；没有战斗场景时省略。 */
  revive?(actorId: string): GmResult;
}

interface GmActionLogEntry {
  at: string;
  call: string;
  args: readonly unknown[];
  ok: boolean;
  reason?: string;
}

interface GmPorts {
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
  setNoclip?: (enabled: boolean) => GmResult;
  isNoclip?: () => boolean;
  setSpeedMultiplier?: (multiplier: number) => GmResult;
  getSpeedMultiplier?: () => number;
  /** 菜单显示对象的诊断快照；正式 UI 场景提供，headless 省略。 */
  ui?: () => unknown;
  /** 剧情跳转的场景侧能力；headless/纯 Node 测试可以省略。 */
  storyJump?: GmStoryJumpPort;
  /** 跳转交接后补一次自动存档请求；装配方接现有的 AutoSaver。 */
  requestAutoSave?: () => void;
}

/** 诊断上报地址由 application/endpoints.ts 统一解析；网页无注入时回退同源固定路径。 */
const reportEndpoint = (): string => diagnosticsReportUrl();
/** 端点单条上限 12 KB（`tools/diagnostic-collector.mjs`），留一点余量。 */
const ENTRY_BUDGET = 11000;
/** 操作日志环长度：够看清「刚才做了什么」，又不至于把上报撑爆。 */
const LOG_LIMIT = 40;
/** GM 单次发物品与加钱的上限，防止误操作把存档数值撑爆。 */
const MAX_GM_ITEM_QUANTITY = 999;
const MAX_GM_MONEY_GAIN = 100_000_000;
/** 开启「升级10技能点」后，每次升级获得的技能点数。 */
const GM_LEVEL_UP_SKILL_POINTS = 10;
/** 诊断上报载荷的协议版本；上报端点按它解析条目。 */
const DIAGNOSTIC_PAYLOAD_VERSION = 1;

export interface GmActions {
  /** 机器可读的会话摘要。面板、上报、agent 读状态共用这一份。 */
  digest(): Record<string, unknown>;
  /** 把当前操控者搬到最近的可站立点（脱困）。 */
  rescue(): GmRescueResult;
  /** 上阵角色列表：人物页的选择与数值都读这一份。 */
  characters(): readonly GmCharacterState[];
  /** 升一级（只升不降）。 */
  levelUp(id: string): GmLevelResult;
  /** 一键把某个角色的全部技能拉到最高级，未学的也一并学会。 */
  maxSkills(id: string): GmSkillResult;
  /** 回满 HP；角色已倒下时走战斗侧复活。 */
  restoreHealth(id: string): GmResult;
  /** 回满 MP。 */
  restoreMana(id: string): GmResult;
  /** 全队回满：存活成员直接回满，倒下成员走战斗侧复活。 */
  recoverParty(): GmResult;
  /** 切换某个角色的无敌开关。 */
  setInvincible(id: string, enabled: boolean): GmResult;
  /** 切换某个角色的无限蓝开关（技能不扣 MP 且免疫吸蓝）。 */
  setInfiniteMana(id: string, enabled: boolean): GmResult;
  /** 切换某个角色的一击必杀开关。 */
  setOneHitKill(id: string, enabled: boolean): GmResult;
  /** 切换某个角色的技能无冷却。 */
  setNoCooldown(id: string, enabled: boolean): GmResult;
  /** 切换每次升级获得 10 个技能点（关闭恢复默认 1 个）。 */
  setTenSkillPointsPerLevel(enabled: boolean): GmResult;
  isTenSkillPointsPerLevel(): boolean;
  /** 可发放物品：排除只能地面拾取的物品。 */
  items(filter?: GmItemFilter): readonly GmItemEntry[];
  /** 把指定数量加入背包。 */
  giveItem(item: string, quantity?: number): GmGiveResult;
  /** 增加金币。 */
  gainMoney(amount: number): GmMoneyResult;
  /** 当前持有金币。 */
  money(): number;
  dispose(): void;
  /** 立刻完成指定或当前追踪/进行中的任务。 */
  completeCurrentQuest(questId?: string): GmResult;
  /** 全部任务组，按故事顺序混排主线/支线；任务页左栏使用。 */
  questCatalog(): QuestCatalogGroup[];
  /** 预览一次任务跳转：补哪些前置、接取剧情、目的地和警告。 */
  previewQuestDebug(questId: string, mode?: QuestStartMode): GmResult & { plan?: QuestStartPlan };
  /** 把剧情跳到指定任务的起点，播完接取剧情后按正式流程继续。 */
  startStoryJump(target: string | QuestStartPlan, mode?: QuestStartMode): Promise<GmResult & { plan?: QuestStartPlan }>;
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
  let combatSettlementSerial = 0;
  const questCatalogIndex = buildQuestCatalog(campaign);
  let questCatalogCache: { version: number; value: QuestCatalogGroup[] } | undefined;
  let jumpStarting = false;
  let disposed = false;

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
  /** 异步动作同样只返回结果、不抛错；日志在 await 完成后写。 */
  const runAsync = async <T extends GmResult>(call: string, args: readonly unknown[], work: () => Promise<T>): Promise<T> => {
    let result: T;
    try { result = await work(); }
    catch (error) { result = { ok: false, reason: error instanceof Error ? error.message : String(error) } as T; }
    record(call, args, result);
    return result;
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

  /**
   * 当前任务链里正在等待的剧情战斗。任务进度只记在普通任务上，剧情用遭遇等待结果；
   * 直接改包装任务不会让等待中的剧情继续，后续任务自然也不会出现。
   */
  const waitingStoryCombatState = () => {
    const targets = new Set<string>();
    for (const [id, state] of session.quests) {
      if (state.status !== 'active' && state.status !== 'ready') continue;
      for (const goal of session.definition(id)?.goals ?? []) if (goal.kind === 'defeat') targets.add(goal.target);
    }
    if (!targets.size) return { encounters: [], driven: new Set<string>() };
    const encounters = session.storyWorld.activeEncounters.filter(encounter =>
      encounter.spawns.some(spawn => targets.has(spawn.enemyId)) &&
      session.runtimeState.runs.some(run => run.status === 'waiting' && run.waiting?.encounter === encounter.id));
    const enemyIds = new Set(encounters.flatMap(encounter => encounter.spawns.map(spawn => spawn.enemyId)));
    const driven = new Set<string>();
    for (const [id, state] of session.quests) {
      if (state.status !== 'active' && state.status !== 'ready') continue;
      if ((session.definition(id)?.goals ?? []).some(goal => goal.kind === 'defeat' && enemyIds.has(goal.target))) driven.add(id);
    }
    return { encounters, driven };
  };

  const waitingStoryCombats = (targetId: string) => {
    const { encounters, driven } = waitingStoryCombatState();
    if (!encounters.length) return [];
    const target = session.definition(targetId);
    const wrapper = !!target && (target.completion === 'story' || target.goals.length === 0);
    return wrapper || driven.has(targetId) ? encounters : [];
  };

  /** 按正常打赢结算这些遭遇：先记击败，让目标型战斗任务进入待交付；再让导演继续等待中的剧情。 */
  const settleStoryCombats = (encounters: ReturnType<typeof waitingStoryCombats>) => {
    const storyDirector = director;
    if (!storyDirector) throw new Error('当前环境没有剧情导演，无法结算剧情战斗');
    const enemyIds = new Set(encounters.flatMap(encounter => encounter.spawns.map(spawn => spawn.enemyId)));
    const driven = new Set<string>();
    for (const [id, state] of session.quests) {
      if (state.status !== 'active' && state.status !== 'ready') continue;
      if ((session.definition(id)?.goals ?? []).some(goal => goal.kind === 'defeat' && enemyIds.has(goal.target))) driven.add(id);
    }
    for (const encounter of encounters) {
      for (const spawn of encounter.spawns) {
        session.enemyDefeated({ ...spawn, id: encounterSpawnId(encounter.id, spawn.id), respawn: false });
      }
    }
    // `encounterResult` 走真实导演队列；这里不等待整段后续演出，任务完成后由剧情自己继续。
    for (const encounter of encounters) {
      void storyDirector.encounterResult(encounter.id, 'won', `gm-complete:${++combatSettlementSerial}:${encounter.id}`)
        .catch(error => console.error('GM 剧情战斗结算失败', error));
    }
    return { driven, count: encounters.length };
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
      infiniteMana: ports.combat?.isInfiniteMana(id) ?? false,
      oneHitKill: ports.combat?.isOneHitKill(id) ?? false,
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
      world: worldDigest(),
      story: storyDigest(),
      ui: ports.ui?.() ?? null,
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
        && reportEndpoint() === DIAGNOSTICS_REPORT_PATH) return false;
      return response.ok;
    } catch { return false; }
  };

  const currentQuestCatalog = (): QuestCatalogGroup[] => {
    const version = session.questBook.version;
    if (questCatalogCache?.version === version) return questCatalogCache.value;
    const value = projectQuestCatalog(questCatalogIndex, session.quests);
    questCatalogCache = { version, value };
    return value;
  };

  const previewQuestDebug = (questId: string, mode?: QuestStartMode) => run('previewQuestDebug', [questId, mode], (): GmResult & { plan?: QuestStartPlan } => {
    try { return { ok: true, plan: planQuestStart(campaign, session, questId, mode) }; }
    catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  });

  /** 跳转事务结束后的正式交接：清掉只用于起点的强制状态，恢复自动存档。 */
  const settleJump = (): void => {
    const storyJump = ports.storyJump;
    // override 释放产生的任务变化只更新观察表，不能在过滤器移除后补演正式剧情。
    director?.holdTriggers();
    try {
      session.questBook.clearDebugOverrides();
      session.emit();
      storyJump?.finish();
      storyJump?.checkpoint?.();
      ports.requestAutoSave?.();
    } finally {
      director?.releaseTriggers();
    }
  };

  const startStoryJump = (target: string | QuestStartPlan, mode?: QuestStartMode): Promise<GmResult & { plan?: QuestStartPlan }> => {
    if (jumpStarting) return Promise.resolve({ ok: false, reason: '正在执行剧情跳转' });
    jumpStarting = true;
    const questId = typeof target === 'string' ? target : target.questId;
    return runAsync('startStoryJump', [questId, mode], async (): Promise<GmResult & { plan?: QuestStartPlan }> => {
      const storyJump = ports.storyJump;
      if (!storyJump) return { ok: false, reason: '当前环境没有剧情跳转能力' };
      if (!storyJump.ready()) return { ok: false, reason: '请等待地图加载完成' };
      if (director?.busy) return { ok: false, reason: '剧情正在播放，请先结束当前剧情' };
      let plan: QuestStartPlan;
      try { plan = typeof target === 'string' ? planQuestStart(campaign, session, target, mode) : target; }
      catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
      const unfinished = director?.runtime.snapshot().runs.some(run => {
        if (run.status !== 'waiting') return run.status === 'running';
        // 玩家离开战场后，跳转会一起重建这段剧情与遭遇。仍在当前地图打的战斗先打完。
        const encounter = run.waiting && session.storyWorld.encounter(run.waiting.encounter);
        return !run.eventId || !encounter || encounter.map === session.storyWorld.currentLocation?.map;
      });
      if (unfinished) return { ok: false, reason: '当前有未结束的剧情运行，请先处理', plan };
      if (plan.mode === 'available' && plan.conditionPatch.unsatisfied.length) {
        const fallback = plan.quest.completion === 'talk' ? '从待交付开始' : '从进行中开始';
        return { ok: false, reason: `接取剧情条件无法自动补齐：${plan.conditionPatch.unsatisfied.join('；')}；可改用“${fallback}”`, plan };
      }
      if (!plan.destination) return { ok: false, reason: '找不到所选阶段的地点', plan };
      let before: GmStoryJumpSnapshot;
      try { before = storyJump.capture(); }
      catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error), plan }; }
      const rollback = async (reason: string) => {
        if (disposed) return { ok: false, reason: '会话已经关闭', plan };
        director?.holdTriggers();
        try {
          session.questBook.clearDebugOverrides();
          await storyJump.restore(before);
        } finally { storyJump.finish(); }
        return { ok: false, reason, plan };
      };
      const accept = plan.accept;
      try {
        director?.setAutomaticEventFilter(() => false);
        storyJump.begin();
        applyQuestStartPlan(session, plan);
        director?.runtime.restore(session.runtimeState);
        await storyJump.travel(plan.destination);
        if (session.storyWorld.currentLocation?.map !== plan.destination.map)
          throw new Error('未到达所选阶段的地图');
        const event = accept?.eventId && campaign.events.find(entry => entry.id === accept.eventId);
        if (event && event.condition && !session.evaluateCondition(event.condition))
          throw new Error('到达现场后仍未满足接取剧情的条件');
      } catch (error) {
        return await rollback(error instanceof Error ? error.message : String(error));
      } finally {
        director?.setAutomaticEventFilter(undefined);
      }
      if (disposed) return { ok: false, reason: '会话已经关闭', plan };
      // 释放触发后同步发起播放，避免地图下一帧抢先启动其他演出。
      const cyclesBeforeIntake = session.questBook.completedCycles(questId);
      storyJump.releaseTriggers();
      let playError: string | undefined;
      if (accept) {
        try {
          if (!await storyJump.play(accept)) return rollback('接取剧情未开始');
          await storyJump.settled?.(accept);
          if (accept.eventId && director && director.runtime.eventStatus(accept.eventId) !== 'completed')
            throw new Error('接取剧情未完成');
        } catch (error) {
          playError = error instanceof Error ? error.message : String(error);
          globalThis.storyDiagnostics?.record('story-jump-play-failed', { quest: questId, message: playError }, false);
        }
      } else storyJump.closeMenu();
      if (disposed) return { ok: false, reason: '会话已经关闭', plan };
      settleJump();
      if (playError) return { ok: false, reason: `接取剧情播放失败：${playError}`, plan };
      const status = session.status(questId);
      const reached = accept
        ? status === 'ready' || (status === 'active' && plan.quest.completion !== 'talk')
          || session.questBook.completedCycles(questId) > cyclesBeforeIntake
        : status === plan.mode;
      if (!reached) return { ok: false, reason: `「${plan.quest.title}」未进入所选阶段`, plan };
      return { ok: true, reason: plan.warnings.join('；') || undefined, plan };
    }).finally(() => { jumpStarting = false; });
  };

  return {
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
    maxSkills: id => run('maxSkills', [id], () => {
      if (!activeMember(id)) return { ok: false, reason: `没有上阵角色：${id}` };
      let result: { learned: number; maxed: number };
      if (id === 'player') result = session.skills.maxAll();
      else {
        const companion = session.party?.get(id);
        if (!companion) return { ok: false, reason: `没有该角色：${id}` };
        const catalog = session.battleCatalog;
        if (!catalog) return { ok: false, reason: '当前会话没有战斗目录，无法拉满佣兵技能' };
        result = companion.skills.maxAll(catalog, companion.classId);
      }
      session.emit();
      return { ok: true, ...result };
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
    setInfiniteMana: (id, enabled) => run('setInfiniteMana', [id, enabled], () => {
      if (!activeMember(id)) return { ok: false, reason: `没有上阵角色：${id}` };
      const combat = ports.combat;
      if (!combat) return { ok: false, reason: '当前会话没有战斗场景，无法切换无限蓝' };
      return combat.setInfiniteMana(id, enabled);
    }),
    setOneHitKill: (id, enabled) => run('setOneHitKill', [id, enabled], () => {
      if (!activeMember(id)) return { ok: false, reason: `没有上阵角色：${id}` };
      const combat = ports.combat;
      if (!combat) return { ok: false, reason: '当前会话没有战斗场景，无法切换一击必杀' };
      return combat.setOneHitKill(id, enabled);
    }),
    setNoCooldown: (id, enabled) => run('setNoCooldown', [id, enabled], () => {
      if (!activeMember(id)) return { ok: false, reason: `没有上阵角色：${id}` };
      session.cooldowns.setFree(id, enabled);
      return { ok: true };
    }),
    setTenSkillPointsPerLevel: enabled => run('setTenSkillPointsPerLevel', [enabled], () => {
      session.setLevelUpSkillPoints(enabled ? GM_LEVEL_UP_SKILL_POINTS : undefined);
      return { ok: true };
    }),
    isTenSkillPointsPerLevel: () => session.levelUpSkillPoints === GM_LEVEL_UP_SKILL_POINTS,
    items: (filter = 'all') => {
      const definitions = session.bag.catalog.items;
      const counts = session.bag.counts;
      const eligible = Object.entries(definitions).filter(([, definition]) =>
        !definition.pickup && !definition.equipment?.locked && (filter === 'all' || definition.category === filter));
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
      if (definition.equipment?.locked) return { ok: false, reason: '剧情专属装备不能放入背包' };
      if (!Number.isSafeInteger(quantity) || quantity <= 0) return { ok: false, reason: '数量必须是正整数' };
      if (quantity > MAX_GM_ITEM_QUANTITY) return { ok: false, reason: '单次最多发放 999 个' };
      session.bag.add(item, quantity);
      // `Bag.add` 只改内部状态，不通知订阅者；任务计数和菜单要靠这一下刷新。
      session.emit();
      return { ok: true, item, name: definition.name, requested: quantity, total: session.bag.count(item) };
    }),
    gainMoney: amount => run('gainMoney', [amount], () => {
      if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: '金币数量必须是正整数' };
      if (amount > MAX_GM_MONEY_GAIN) return { ok: false, reason: '单次最多增加 100,000,000' };
      session.gainMoney(amount);
      return { ok: true, money: session.money };
    }),
    money: () => session.money,
    dispose: () => {
      disposed = true;
      session.questBook.clearDebugOverrides();
      director?.setAutomaticEventFilter(undefined);
      ports.storyJump?.dispose();
      log.length = 0;
    },
    completeCurrentQuest: (questId?: string) => run('completeCurrentQuest', [questId], () => {
      const waitingCombats = waitingStoryCombatState();
      const activeList = questDigest().active;
      let targetId = questId ?? session.currentQuest()?.id ?? waitingCombats.driven.values().next().value ?? activeList[0]?.id;
      if (!questId && targetId && waitingCombats.encounters.length) {
        const current = session.definition(targetId);
        const wrapper = !!current && (current.completion === 'story' || current.goals.length === 0);
        // 旧版本可能已经把包装任务点完成，留下无关的正常任务当“当前任务”；
        // 这时等待中的剧情战斗才是真正卡住进度的任务，先完成它。
        if (!wrapper && !waitingCombats.driven.has(targetId)) targetId = waitingCombats.driven.values().next().value ?? targetId;
      }
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


      // 剧情任务的进度在普通任务上，但结算入口是等待中的遭遇。先按正常打赢结算，
      // 让目标型战斗任务进入待交付，剧情事件才会继续结算战斗并接取后续任务。
      const storyCombats = waitingStoryCombats(targetId);
      if (storyCombats.length && !director) return { ok: false, reason: '当前环境没有剧情导演，无法结算剧情战斗' };
      const settled = storyCombats.length ? settleStoryCombats(storyCombats) : { driven: new Set<string>(), count: 0 };
      if (!settled.driven.has(targetId)) {
        session.applyStoryCommands([{
          type: 'quest',
          command: { type: 'script-complete', quest: targetId, cycle: session.questBook.state(targetId)?.cycle }
        }]);
      }

      return { ok: true, reason: settled.driven.has(targetId)
        ? `已结算 ${settled.count} 场剧情战斗，任务「${quest.title}」等待剧情完成`
        : `已完成任务「${quest.title}」${settled.count ? `；已结算 ${settled.count} 场剧情战斗` : ''}` };
    }),
    questCatalog: currentQuestCatalog,
    previewQuestDebug,
    startStoryJump,
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
        const payload = { version: DIAGNOSTIC_PAYLOAD_VERSION, entries: [{ id: `gm:${Date.now()}`, kind: 'gm-state', time: new Date().toISOString(), digest: entry }] };
        const sent = await (ports.report ?? defaultReport)(payload);
        result = sent ? { ok: true, ...(trimmed ? { reason: '已裁剪到上报上限' } : {}) } : { ok: false, reason: '上报端点不可用' };
      } catch (error) { result = { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
      record('report', [], result);
      return result;
    },
  };
}
