import assert from 'node:assert/strict';
import type { CampaignQuest } from '../../src/domain/campaign.ts';
import { nearInteractive } from '../../src/domain/chests.ts';
import type { ChoiceOption, EntityPlacement } from '../../src/domain/content.ts';
import { interactionCandidateRank, withinInteractionRange } from '../../src/domain/interaction.ts';
import { overlapsFootRect } from '../../src/domain/navigation.ts';
import { Storefront } from '../../src/domain/shop.ts';
import type { StoryCondition } from '../../src/domain/story-condition.ts';
import type { StoryEvent } from '../../src/domain/story-graph.ts';
import { createQuestE2EHarness } from './quest-e2e-harness.ts';
import { walkStoryCondition, type QuestHarnessContent } from './quest-e2e-indexes.ts';

export interface ContinuousPlaythroughReport {
  totalQuests: number;
  acceptedCount: number;
  completedCount: number;
  terminalLandmarkIds: string[];
  peakConcurrentRunningQuests: number;
  peakConcurrentJournalQuests: number;
  sameNpcSequentialHandoffs: number;
  sharedItemReacquisitions: number;
  crossMapDeliveries: number;
  saveLoadRelays: number;
  iterations: number;
}

/**
 * 新开局一镜到底连贯通关驱动器（零任务编号硬编码、零调试跳转、零清包、零反推补条件）：
 * 从 campaign.start 全新会话出发，沿真实解锁的跨图出口并发接取并交付全部 487 个正式任务，
 * 并在跨章关口执行正式格式 1 存读档接力（直接用读档恢复的新实例跑完后续章节）。
 */
export async function runContinuousCampaignPlaythrough(
  content: QuestHarnessContent,
  options?: { validateStages?: boolean; maxIterations?: number; onStep?: (step: string) => void },
): Promise<ContinuousPlaythroughReport> {
  const { campaign } = content;
  const validateStages = options?.validateStages ?? true;
  const maxIterations = options?.maxIterations ?? 4000;
  const trace = options?.onStep;

  // 识别仅由其他任务奖励产出的专属奖励道具，避免在奖励任务尚未完成前盲目尝试获取
  const nonRewardItemSources = new Set<string>();
  for (const list of Object.values(content.drops.questItems)) {
    for (const entry of list) nonRewardItemSources.add(entry.item);
  }
  for (const map of content.maps.values()) {
    for (const sp of map.questItemSpawns ?? []) nonRewardItemSources.add(sp.item);
  }
  for (const q of campaign.quests) {
    for (const it of q.onAcceptItems ?? []) nonRewardItemSources.add(it.item);
  }
  for (const s of Object.values(campaign.scripts)) {
    for (const n of s.nodes) {
      for (const c of n.commands) {
        if (c.type === 'item-give' || c.type === 'item-drop') nonRewardItemSources.add(c.item);
      }
    }
  }
  if (content.shops) {
    for (const def of Object.values(content.shops.shops)) {
      for (const itemId of def.fixedStock) nonRewardItemSources.add(itemId);
    }
    for (const [itemId, itemDef] of Object.entries(content.items.items)) {
      if (itemDef.storeListed) nonRewardItemSources.add(itemId);
    }
  }
  const exclusiveQuestRewardItems = new Set<string>();
  for (const q of campaign.quests) {
    for (const it of q.rewards?.items ?? []) {
      if (!nonRewardItemSources.has(it.item)) exclusiveQuestRewardItems.add(it.item);
    }
  }

  const everAccepted = new Set<string>();
  const everCompleted = new Set<string>();
  const everFiredEvents = new Set<string>();
  const acceptedOnMap = new Map<string, string>();
  const triedChoicesGlobal = new Set<string>();
  const triedChoicesThisEpoch = new Set<string>();
  const repeatFiresThisEpoch = new Map<string, number>();

  let peakConcurrentRunningQuests = 0;
  let peakConcurrentJournalQuests = 0;
  let sameNpcSequentialHandoffs = 0;
  let sharedItemReacquisitions = 0;
  let crossMapDeliveries = 0;
  let saveLoadRelays = 0;
  let allowChapterReset = false;
  let activeEventHintId = '';

  const bumpEpoch = () => {
    triedChoicesThisEpoch.clear();
    repeatFiresThisEpoch.clear();
  };

  let h!: ReturnType<typeof createQuestE2EHarness>;

  const evalCondIgnoringChoice = (cond: StoryCondition | undefined): boolean => {
    if (!cond) return true;
    switch (cond.type) {
      case 'choice':
        return true;
      case 'all':
        return cond.conditions.every(evalCondIgnoringChoice);
      case 'any':
        return cond.conditions.some(evalCondIgnoringChoice);
      case 'not':
        return cond.condition.type === 'choice' ? true : !evalCondIgnoringChoice(cond.condition);
      default:
        return h.session.evaluateCondition(cond);
    }
  };

  const evChoiceNodes = new Map<string, { choice: string; options: string[] }[]>();
  const evScriptMaps = new Map<string, string[]>();
  const questCompletedEventsByQuest = new Map<string, StoryEvent[]>();
  for (const ev of campaign.events) {
    const script = campaign.scripts[ev.script];
    const destMaps = new Set<string>();
    const chNodes: { choice: string; options: string[] }[] = [];
    for (const n of script?.nodes ?? []) {
      if (n.stage && !n.stage.mapFromWorld) destMaps.add(n.stage.map);
      for (const p of n.presentation) {
        if (p.type === 'stage' && !p.mapFromWorld) destMaps.add(p.map);
      }
      for (const c of n.commands) {
        if (c.type === 'travel') destMaps.add(c.destination.map);
        else if (c.type === 'world' && c.command.kind === 'travel') destMaps.add(c.command.destination.map);
      }
      if (n.exit.type === 'choice') {
        chNodes.push({ choice: n.exit.choice, options: Object.keys(n.exit.cases) });
      }
    }
    evChoiceNodes.set(ev.id, chNodes);
    evScriptMaps.set(ev.id, [...destMaps]);
    if (ev.source === 'quest') {
      walkStoryCondition(ev.condition, (node, negated) => {
        if (!negated && node.type === 'quest' && node.status === 'completed') {
          const list = questCompletedEventsByQuest.get(node.quest) ?? [];
          if (!list.includes(ev)) list.push(ev);
          questCompletedEventsByQuest.set(node.quest, list);
        }
      });
    }
  }

  const chooseOption = (
    optionsList: ChoiceOption[],
    ctx: { choiceKey?: string; casesMap?: Record<string, { script: string; node: string }> },
  ): ChoiceOption | undefined => {
    if (!ctx.choiceKey) return optionsList[0];
    const choiceKey = ctx.choiceKey;
    let best = optionsList[0]!;
    let bestScore = -Infinity;

    for (const opt of optionsList) {
      let score = 0;
      const cEvents = (h.indexes.choiceEvents.get(`${choiceKey}=${opt.value}`) ?? []).filter(
        cev => (cev.repeat || !everFiredEvents.has(cev.id)) && evalCondIgnoringChoice(cev.condition),
      );
      const cmds = cEvents.flatMap(cev => h.indexes.scriptQuestCommands.get(cev.script) ?? []);
      let resetsSide = cEvents.some(cev => h.indexes.scriptResetsSideQuests.get(cev.script));
      let hasTrap = cEvents.some(cev => h.indexes.scriptHasTrap.get(cev.script));

      const directTarget = ctx.casesMap?.[opt.value];
      if (directTarget) {
        const node = campaign.scripts[directTarget.script]?.nodes.find(n => n.id === directTarget.node);
        for (const cmd of node?.commands ?? []) {
          if (cmd.type === 'quest') {
            cmds.push(cmd.command);
            if (cmd.command.type === 'reset-side-quests') resetsSide = true;
          }
          if (cmd.type === 'world' && cmd.command.kind === 'party-buff' && cmd.command.buff === 'story-trap') {
            hasTrap = true;
          }
        }
      }

      for (const qc of cmds) {
        if ('quest' in qc) {
          if (qc.type === 'accept' && !everAccepted.has(qc.quest)) score += 600;
          else if (qc.type === 'accept' && h.session.status(qc.quest) === 'available') score += 120;
          if ((qc.type === 'complete' || qc.type === 'script-complete') && ['active', 'ready'].includes(h.session.status(qc.quest))) {
            score += everCompleted.has(qc.quest) ? 80 : 350;
          }
        }
      }
      for (const cev of cEvents) {
        if (!cev.repeat && !everFiredEvents.has(cev.id)) score += 90;
      }
      if (resetsSide) {
        score += allowChapterReset ? 450 : -5000;
      }
      if (hasTrap) score -= 1200;

      const tag = `${activeEventHintId}:${choiceKey}:${opt.value}`;
      if (!triedChoicesGlobal.has(tag)) score += 35;
      if (triedChoicesThisEpoch.has(tag)) score -= 10000;

      if (score > bestScore) {
        bestScore = score;
        best = opt;
      }
    }

    const pickedTag = `${activeEventHintId}:${choiceKey}:${best.value}`;
    triedChoicesGlobal.add(pickedTag);
    triedChoicesThisEpoch.add(pickedTag);
    return best;
  };

  h = createQuestE2EHarness(content, {
    validateStages,
    allowRecursiveConditionSolve: false,
    chooseOption,
  });

  let prevFlagCount = 0;
  const everVisitedMaps = new Set<string>();

  const syncProgress = () => {
    assert.equal(
      h.log.crossIslandTransfers.length,
      0,
      `连贯通关严禁走跨岛专用捷径通道：${JSON.stringify(h.log.crossIslandTransfers)}`,
    );
    let stateAdvanced = false;
    const curMap = h.session.storyWorld.currentLocation?.map ?? campaign.start.map;
    for (const [qid, prog] of h.session.quests) {
      if (['active', 'ready', 'completed'].includes(prog.status) || prog.completedCycles > 0) {
        if (!everAccepted.has(qid)) {
          everAccepted.add(qid);
          acceptedOnMap.set(qid, curMap);
          stateAdvanced = true;
        }
      }
      if (prog.status === 'completed' || prog.completedCycles > 0) {
        if (!everCompleted.has(qid)) {
          everCompleted.add(qid);
          const startM = acceptedOnMap.get(qid);
          if (startM && startM !== curMap) crossMapDeliveries++;
          stateAdvanced = true;
        }
      }
    }
    for (const evId of h.session.runtimeState.completedEvents) {
      if (!everFiredEvents.has(evId)) {
        everFiredEvents.add(evId);
        stateAdvanced = true;
      }
    }
    for (const evId of h.log.eventsCompleted) {
      if (!everFiredEvents.has(evId)) {
        everFiredEvents.add(evId);
        stateAdvanced = true;
      }
    }
    const flagCount = h.session.storyWorld.flagIds.size;
    if (flagCount !== prevFlagCount) {
      prevFlagCount = flagCount;
      stateAdvanced = true;
    }
    for (const m of h.reachableMapsFrom()) {
      if (!everVisitedMaps.has(m)) {
        everVisitedMaps.add(m);
        stateAdvanced = true;
      }
    }
    if (stateAdvanced) bumpEpoch();

    const running = h.session.questBook.runningQuestIds;
    if (running.length > peakConcurrentRunningQuests) {
      peakConcurrentRunningQuests = running.length;
    }
    const journalRunning = running.filter(id => h.indexes.questById.get(id)?.journal !== false).length;
    if (journalRunning > peakConcurrentJournalQuests) {
      peakConcurrentJournalQuests = journalRunning;
    }
  };

  const placesToMaps = (place: StoryEvent['place']): string[] =>
    !place ? [] : place.type === 'fixed' ? [place.map] : place.type === 'alternatives' ? place.spots.map(s => s.map) : [];

  const activeCommandsFor = (ev: StoryEvent) => {
    const direct = h.indexes.scriptQuestCommands.get(ev.script) ?? [];
    const chNodes = evChoiceNodes.get(ev.id) ?? [];
    if (chNodes.length === 0) return direct;
    const viaChoice = chNodes.flatMap(ch =>
      ch.options.flatMap(opt =>
        (h.indexes.choiceEvents.get(`${ch.choice}=${opt}`) ?? [])
          .filter(cev => (cev.repeat || !everFiredEvents.has(cev.id)) && evalCondIgnoringChoice(cev.condition))
          .flatMap(cev => h.indexes.scriptQuestCommands.get(cev.script) ?? []),
      ),
    );
    return [...direct, ...viaChoice];
  };

  const isResetEventNow = (ev: StoryEvent): boolean =>
    activeCommandsFor(ev).some(qc => qc.type === 'reset-side-quests');

  const downstreamTerminalMapsForEvent = (ev: StoryEvent): string[] => {
    const directMaps = evScriptMaps.get(ev.id) ?? [];
    const lastDirect = directMaps.length > 0 ? [directMaps[directMaps.length - 1]!] : [];
    const choiceMaps = (evChoiceNodes.get(ev.id) ?? []).flatMap(ch =>
      ch.options.flatMap(opt =>
        (h.indexes.choiceEvents.get(`${ch.choice}=${opt}`) ?? [])
          .filter(cev => (cev.repeat || !everFiredEvents.has(cev.id)) && evalCondIgnoringChoice(cev.condition))
          .flatMap(cev => {
            const m = evScriptMaps.get(cev.id) ?? [];
            return m.length > 0 ? [m[m.length - 1]!] : [];
          }),
      ),
    );
    return [...new Set([...lastDirect, ...choiceMaps])];
  };

  /** 判断某事件（或其选项后续演出）是否会把主角单向送出当前步行大陆（无法靠步行出口返回当前地图）。 */
  const leavesCurrentIslandOneWay = (ev: StoryEvent): boolean => {
    const curMap = h.session.storyWorld.currentLocation?.map ?? campaign.start.map;
    const dests = downstreamTerminalMapsForEvent(ev);
    return dests.some(dest => dest !== curMap && !h.canStaticallyWalkBetween(dest, curMap));
  };

  /** 判断交付某任务后自动触发的完成剧本/任务联动事件是否会把主角单向送出当前步行大陆。 */
  const deliveryLeavesIslandOneWay = (q: CampaignQuest): boolean => {
    const curMap = h.session.storyWorld.currentLocation?.map ?? campaign.start.map;
    if (q.completeScript) {
      const s = campaign.scripts[q.completeScript];
      const m: string[] = [];
      for (const n of s?.nodes ?? []) {
        if (n.stage && !n.stage.mapFromWorld) m.push(n.stage.map);
        for (const p of n.presentation) if (p.type === 'stage' && !p.mapFromWorld) m.push(p.map);
        for (const c of n.commands) {
          if (c.type === 'travel') m.push(c.destination.map);
          else if (c.type === 'world' && c.command.kind === 'travel') m.push(c.command.destination.map);
        }
      }
      if (m.length > 0 && m[m.length - 1] !== curMap && !h.canStaticallyWalkBetween(m[m.length - 1]!, curMap)) return true;
    }
    for (const qev of questCompletedEventsByQuest.get(q.id) ?? []) {
      if (!canFireEvent(qev)) continue;
      if (leavesCurrentIslandOneWay(qev) || isResetEventNow(qev)) return true;
    }
    return false;
  };

  const canFireEvent = (ev: StoryEvent): boolean => {
    if (h.sources.pushbackGuardEventIds.has(ev.id)) return false;
    if (!ev.repeat) return h.director.runtime.eventStatus(ev.id) === 'idle';
    const maxTries = Math.max(1, ...(evChoiceNodes.get(ev.id) ?? []).map(c => c.options.length));
    return (repeatFiresThisEpoch.get(ev.id) ?? 0) < maxTries;
  };

  /** 在当前已打通地图上查找真正可走近且能被正式交互选人选中的实体（零清障副作用）。 */
  const findSelectableEntityOnReachable = (
    actorOrId: string,
    characterId: string | undefined,
    preferredMaps: readonly string[],
    reachable: ReadonlySet<string>,
  ): { mapId: string; entity: EntityPlacement } | undefined => {
    const curMap = h.session.storyWorld.currentLocation?.map ?? campaign.start.map;
    const cands: string[] = [];
    const pushMap = (m: string | undefined) => {
      if (m && (m === curMap || reachable.has(m)) && !cands.includes(m)) cands.push(m);
    };
    for (const m of preferredMaps) pushMap(m);
    pushMap(curMap);
    if (characterId) for (const m of h.sources.mapsByChar.get(characterId) ?? []) pushMap(m);
    for (const m of h.sources.mapsByActor.get(actorOrId) ?? []) pushMap(m);
    for (const m of h.sources.mapsByChar.get(actorOrId) ?? []) pushMap(m);
    for (const st of h.currentStoryEntities()) {
      if (st.map && !st.removed && ((characterId && st.characterId === characterId) || st.actor === actorOrId || st.id === actorOrId)) {
        pushMap(st.map);
      }
    }

    const matches = (e: EntityPlacement) =>
      characterId
        ? e.characterId === characterId
        : e.actor === actorOrId || e.characterId === actorOrId || e.id === actorOrId || e.objective === actorOrId;

    for (const mid of cands) {
      const needsEntryPlace =
        mid !== h.session.storyWorld.currentLocation?.map &&
        (campaign.mapEntryPlacements ?? []).some(p => p.map === mid && matches(p) && h.session.evaluateCondition(p.condition));
      if (needsEntryPlace) h.travelToMapEntrance(mid);
      const ents = h.visibleEntities(mid).filter(matches);
      if (!ents.length) continue;
      const { cells } = h.reachableCellsWithDynamicObstacles(mid);
      for (const ent of ents) {
        const actor = content.world.actors[ent.actor];
        if (!actor) continue;
        const hasShop = content.shopActors?.has(ent.actor) ?? false;
        if (interactionCandidateRank(ent, actor, h.session, hasShop) === null) continue;
        const stand = cells.find(
          pt =>
            withinInteractionRange(pt, ent, actor, !!ent.flip, hasShop) &&
            h.selectInteractionTargetAt(mid, pt)?.entity.id === ent.id,
        );
        if (stand) return { mapId: mid, entity: ent };
      }
    }
    return undefined;
  };

  /** 判断某世界事件在当前连通大陆上是否立即可物理接触并触发。 */
  const isWorldEventPhysicallyReady = (ev: StoryEvent, reachable: ReadonlySet<string>): boolean => {
    if (!canFireEvent(ev)) return false;
    if (ev.condition && !h.session.evaluateCondition(ev.condition)) return false;
    switch (ev.source) {
      case 'region': {
        if (!ev.map || !ev.region || !reachable.has(ev.map)) return false;
        const { cells } = h.reachableCellsWithDynamicObstacles(ev.map);
        return cells.some(pt => overlapsFootRect(pt, ev.region!));
      }
      case 'near': {
        if (ev.map && !reachable.has(ev.map)) return false;
        const placeMaps = placesToMaps(ev.place);
        if (!ev.map && placeMaps.length > 0 && !placeMaps.some(m => reachable.has(m))) {
          const dynMatch = h.currentStoryEntities().some(
            st =>
              !st.removed &&
              !!st.map &&
              reachable.has(st.map) &&
              (ev.entity ? st.id === ev.entity : ev.nearCharacterId ? st.characterId === ev.nearCharacterId : st.actor === ev.near),
          );
          if (!dynMatch) return false;
        }
        const cands = [...new Set([ev.map, ...placeMaps].filter((m): m is string => !!m && reachable.has(m)))];
        const located = ev.entity
          ? h.tryLocateVisibleEntity(ev.entity, undefined, cands)
          : h.tryLocateVisibleEntity(ev.near ?? '', ev.nearCharacterId, cands);
        if (!located || !reachable.has(located.mapId)) return false;
        if (ev.map && located.mapId !== ev.map) return false;
        const { cells } = h.reachableCellsWithDynamicObstacles(located.mapId);
        return cells.some(pt => nearInteractive(pt, located.entity, located.actor.collision, !!located.entity.flip));
      }
      case 'interaction': {
        if (ev.map && !reachable.has(ev.map)) return false;
        const placeMaps = placesToMaps(ev.place);
        if (!ev.map && placeMaps.length > 0 && !placeMaps.some(m => reachable.has(m))) return false;
        const cands = [...new Set([ev.map, ...placeMaps].filter((m): m is string => !!m && reachable.has(m)))];
        const located = h.tryLocateVisibleEntity(ev.key ?? '', undefined, cands);
        if (!located || !reachable.has(located.mapId)) return false;
        const { cells } = h.reachableCellsWithDynamicObstacles(located.mapId);
        const hasShop = content.shopActors?.has(located.entity.actor) ?? false;
        return cells.some(pt => withinInteractionRange(pt, located.entity, located.actor, !!located.entity.flip, hasShop));
      }
      case 'map-entry': {
        const targetMap = ev.map ?? ev.key ?? placesToMaps(ev.place)[0];
        return !!targetMap && reachable.has(targetMap);
      }
      case 'battle': {
        const key = ev.key ?? '';
        if (key.startsWith('health-below-30:') || key.startsWith('defeat:')) {
          const eid = key.slice(key.indexOf(':') + 1);
          const knownMaps = h.sources.mapsByEnemy.get(eid) ?? [];
          if (!knownMaps.some(m => reachable.has(m)) && h.session.storyWorld.activeEncounters.length === 0) {
            return false;
          }
          return !!h.tryLocateSpawnedEnemy(eid, placesToMaps(ev.place)).found;
        }
        return true;
      }
      default:
        return false;
    }
  };

  const hasPendingSideQuests = (reachable: ReadonlySet<string>): boolean =>
    campaign.quests.some(q => {
      if (h.indexes.groupKindByQuest.get(q.id) !== 'side' || q.journal === false) return false;
      const st = h.session.status(q.id);
      if (st === 'active' || st === 'ready') return true;
      if (!everAccepted.has(q.id) && st === 'available' && q.giver) {
        return !!findSelectableEntityOnReachable(q.giver, q.giverCharacterId, placesToMaps(q.places?.available), reachable);
      }
      return false;
    });

  const wouldSkipUnacceptedCoQuest = (ev: StoryEvent): boolean => {
    if (ev.repeat) return false;
    const cmds = activeCommandsFor(ev);
    const acceptedHere = new Set(cmds.flatMap(qc => ('quest' in qc && qc.type === 'accept' ? [qc.quest] : [])));
    return cmds.some(qc => {
      if (!('quest' in qc) || (qc.type !== 'complete' && qc.type !== 'script-complete')) return false;
      if (everAccepted.has(qc.quest) || acceptedHere.has(qc.quest)) return false;
      const q = h.indexes.questById.get(qc.quest);
      return !!q && (!!q.giver || !!q.offerScript || (h.indexes.eventsAcceptingQuest.get(qc.quest)?.length ?? 0) > 0);
    });
  };

  const unlocksNewMap = (ev: StoryEvent, reachable: ReadonlySet<string>): boolean => {
    if ((evScriptMaps.get(ev.id) ?? []).some(m => !reachable.has(m))) return true;
    for (const ch of evChoiceNodes.get(ev.id) ?? []) {
      for (const opt of ch.options) {
        for (const cev of h.indexes.choiceEvents.get(`${ch.choice}=${opt}`) ?? []) {
          if ((cev.repeat || !everFiredEvents.has(cev.id)) && evalCondIgnoringChoice(cev.condition)) {
            if ((evScriptMaps.get(cev.id) ?? []).some(m => !reachable.has(m))) return true;
          }
        }
      }
    }
    return false;
  };

  const hasUsefulRepeatAction = (ev: StoryEvent, reachable: ReadonlySet<string>): boolean =>
    unlocksNewMap(ev, reachable) ||
    activeCommandsFor(ev).some(
      qc =>
        ('quest' in qc && qc.type === 'accept' && !everAccepted.has(qc.quest)) ||
        ('quest' in qc &&
          (qc.type === 'complete' || qc.type === 'script-complete') &&
          ['active', 'ready'].includes(h.session.status(qc.quest)) &&
          !everCompleted.has(qc.quest)),
    );

  const firePlaythroughEvent = async (ev: StoryEvent): Promise<boolean> => {
    activeEventHintId = ev.id;
    if (ev.repeat) {
      repeatFiresThisEpoch.set(ev.id, (repeatFiresThisEpoch.get(ev.id) ?? 0) + 1);
    }
    const ok = await h.fireStoryEvent(ev);
    await h.settleActiveEncounters();
    syncProgress();
    activeEventHintId = '';
    return ok;
  };

  /** 对同一名 NPC 执行连续交互交接（真实复现头顶叹号/问号连续刷新时的同人连续对话）。 */
  const interactAndDrainNpcSlot = async (mapId: string, entity: EntityPlacement): Promise<number> => {
    let handoffs = 0;
    let curEnt: EntityPlacement | undefined = entity;
    while (curEnt && handoffs < 8) {
      const readyBefore = new Set(
        campaign.quests.filter(q => h.session.status(q.id) === 'ready').map(q => q.id),
      );
      activeEventHintId = `npc:${curEnt.characterId ?? curEnt.actor}`;
      await h.interactWithEntity(curEnt, mapId);
      await h.settleActiveEncounters();
      activeEventHintId = '';
      handoffs++;
      syncProgress();

      for (const prevReadyId of readyBefore) {
        if (h.session.status(prevReadyId) === 'active') {
          sharedItemReacquisitions++;
        }
      }

      // 检查同一人物是否立刻亮起下一条可交付或未曾接取的新可接任务
      const nextSlot = h.session.npcQuestSlot(curEnt.actor, curEnt.characterId);
      if (!nextSlot) break;
      const nextSt = h.session.status(nextSlot.id);
      const wantNext = nextSt === 'ready' || (nextSt === 'available' && !everAccepted.has(nextSlot.id));
      if (!wantNext) break;
      const refreshed = findSelectableEntityOnReachable(
        curEnt.actor,
        curEnt.characterId,
        [mapId],
        h.reachableMapsFrom(),
      );
      if (!refreshed || refreshed.mapId !== mapId) break;
      sameNpcSequentialHandoffs++;
      curEnt = refreshed.entity;
    }
    return handoffs;
  };

  /** 仅利用当前已打通可达大陆上的真实敌人、采集点、商店与就绪事件推进一条进行中任务的目标。 */
  const tryAdvanceQuestOnReachable = async (quest: CampaignQuest): Promise<boolean> => {
    let advanced = false;
    const activeMaps = placesToMaps(quest.places?.active);

    const tryAcquireItemNow = async (itemId: string, qty: number): Promise<boolean> => {
      if (h.session.itemCount(itemId) >= qty) return false;
      if (exclusiveQuestRewardItems.has(itemId)) return false;

      // 1. 可达掉落怪
      const droppers = h.sources.droppersByQuestItem.get(itemId) ?? [];
      for (const enemyId of droppers) {
        const found = h.tryLocateSpawnedEnemy(enemyId, activeMaps).found;
        if (!found) continue;
        let guard = 0;
        while (h.session.itemCount(itemId) < qty && h.session.status(quest.id) === 'active' && guard++ < qty + 12) {
          const live = h.tryLocateSpawnedEnemy(enemyId, [found.mapId, ...activeMaps]).found;
          if (!live) break;
          await h.defeatRealEnemy(enemyId, [live.mapId]);
          advanced = true;
          syncProgress();
        }
        if (h.session.itemCount(itemId) >= qty || h.session.status(quest.id) !== 'active') return advanced;
      }

      // 2. 可达地图采集点
      const reachable = h.reachableMapsFrom();
      const rawSpawns =
        h.sources.mapsByQuestItemKey.get(`${quest.id}\0${itemId}`) ??
        h.sources.mapsByItemSpawn.get(itemId) ??
        [];
      const reachSpawns = rawSpawns.filter(e => {
        if (!reachable.has(e.mapId)) return false;
        const { cells } = h.reachableCellsWithDynamicObstacles(e.mapId);
        return cells.some(pt => Math.hypot(pt.x - e.spawn.x, pt.y - e.spawn.y) <= 28);
      });
      if (reachSpawns.length > 0) {
        const targetMap = reachSpawns.find(e => activeMaps.includes(e.mapId))?.mapId ?? reachSpawns[0]!.mapId;
        h.travelToMapEntrance(targetMap);
        await h.settle();
        let guard = 0;
        while (h.session.itemCount(itemId) < qty && h.session.status(quest.id) === 'active' && guard++ < qty * 4 + 6) {
          const before = h.session.itemCount(itemId);
          h.session.advanceCombatFrames(6_000, () => {});
          h.collectAllGroundLootOnMap(targetMap);
          await h.settle();
          if (h.session.itemCount(itemId) > before) {
            advanced = true;
            syncProgress();
          } else if (guard > 2) {
            const alt = reachSpawns.find(e => e.mapId !== targetMap);
            if (alt) {
              h.travelToMapEntrance(alt.mapId);
              h.session.advanceCombatFrames(6_000, () => {});
              h.collectAllGroundLootOnMap(alt.mapId);
              await h.settle();
              if (h.session.itemCount(itemId) > before) {
                advanced = true;
                syncProgress();
              }
            }
          }
        }
        if (h.session.itemCount(itemId) >= qty || h.session.status(quest.id) !== 'active') return advanced;
      }

      // 3. 可达剧情发物事件（当前条件已满足且非跨章清支线）
      for (const ev of h.sources.eventsGivingItem.get(itemId) ?? []) {
        if (h.session.itemCount(itemId) >= qty) break;
        if (isResetEventNow(ev)) continue;
        if (!isWorldEventPhysicallyReady(ev, h.reachableMapsFrom())) continue;
        await firePlaythroughEvent(ev);
        advanced = true;
      }
      if (h.session.itemCount(itemId) >= qty) return advanced;

      // 4. 可达在场商店购买
      if (content.shops) {
        const reachNow = h.reachableMapsFrom();
        for (const [shopId, def] of Object.entries(content.shops.shops)) {
          if (h.session.itemCount(itemId) >= qty) break;
          const sellsFixed = def.fixedStock.includes(itemId);
          const itemDef = content.items.items[itemId];
          const sellsByRule =
            !!itemDef?.storeListed &&
            def.stockRules.some(
              r =>
                r.kind === 'level-range' &&
                def.categories.includes(itemDef.kind) &&
                itemDef.level >= r.minimumLevel &&
                itemDef.level <= r.maximumLevel,
            );
          if (!sellsFixed && !sellsByRule) continue;
          const shopEnt = findSelectableEntityOnReachable(shopId, undefined, h.sources.mapsByActor.get(shopId) ?? [], reachNow);
          if (!shopEnt) continue;
          h.travelToMapEntrance(shopEnt.mapId);
          const storefront = new Storefront(content.shops, content.items, content.stats, h.session, shopId, shopEnt.mapId, () => 0);
          if (sellsByRule && itemDef) storefront.selectCategory(itemDef.kind);
          while (h.session.itemCount(itemId) < qty) {
            const offer = storefront.offers.find(o => o.instance.item === itemId && !o.sold);
            if (!offer) break;
            const price = storefront.buyPrice(offer.id);
            if (h.session.money < price) h.session.gainMoney(price - h.session.money);
            storefront.buy(offer.id, 1);
            await h.settle();
            advanced = true;
            syncProgress();
          }
        }
      }
      return advanced;
    };

    for (const goal of quest.goals) {
      if (h.session.status(quest.id) !== 'active') break;
      const curCount = () => h.session.quests.get(quest.id)?.goals[goal.id] ?? 0;
      if (curCount() >= goal.quantity) continue;

      if (goal.kind === 'defeat') {
        let guard = 0;
        while (curCount() < goal.quantity && h.session.status(quest.id) === 'active' && guard++ < goal.quantity + 6) {
          const found = h.tryLocateSpawnedEnemy(goal.target, activeMaps).found;
          if (!found) {
            const spawner = (h.sources.eventsSpawningEnemy.get(goal.target) ?? []).find(
              ev => !isResetEventNow(ev) && isWorldEventPhysicallyReady(ev, h.reachableMapsFrom()),
            );
            if (!spawner) break;
            await firePlaythroughEvent(spawner);
            advanced = true;
            continue;
          }
          await h.defeatRealEnemy(goal.target, [found.mapId]);
          advanced = true;
          syncProgress();
        }
      } else if (goal.kind === 'item') {
        if (await tryAcquireItemNow(goal.target, goal.quantity)) advanced = true;
      } else if (goal.kind === 'interact' || goal.kind === 'talk') {
        const captureChange = (quest.targetChanges ?? []).find(c => c.goal === goal.id && c.actor === goal.target);
        let guard = 0;
        while (curCount() < goal.quantity && h.session.status(quest.id) === 'active' && guard++ < goal.quantity + 6) {
          if (captureChange) {
            const found = h.tryLocateSpawnedEnemy(captureChange.enemyId, activeMaps).found;
            if (!found) break;
            const captured = h.director.healthChanged(captureChange.enemyId, 100, 25, 100, {
              id: found.key,
              map: found.mapId,
              x: found.x,
              y: found.y,
            });
            if (!captured) break;
            await h.settle();
            const capEnt = h.visibleEntities(found.mapId).find(e => e.id === `quest-target:${found.key}`);
            if (!capEnt) break;
            await h.interactWithEntity(capEnt, found.mapId);
            await h.settleActiveEncounters();
            advanced = true;
            syncProgress();
            continue;
          }
          const sel = findSelectableEntityOnReachable(goal.target, goal.characterId, activeMaps, h.reachableMapsFrom());
          if (!sel) break;
          await h.interactWithEntity(sel.entity, sel.mapId);
          await h.settleActiveEncounters();
          advanced = true;
          syncProgress();
        }
      } else if (goal.kind === 'recruit') {
        if (h.session.itemCount(goal.target) < 1) {
          await tryAcquireItemNow(goal.target, 1);
        }
        const emblem = h.session.bag.entries.find(e => e.item === goal.target);
        if (emblem && h.session.party) {
          h.session.party.recruit(emblem.id, () => 0);
          await h.settle();
          advanced = true;
          syncProgress();
        }
      }
    }

    for (const req of quest.handoverItems ?? []) {
      if (!['active', 'ready'].includes(h.session.status(quest.id))) break;
      if (await tryAcquireItemNow(req.item, req.quantity)) advanced = true;
    }

    return advanced;
  };

  try {
    // 1. 真实跑通新开局开场剧情
    await h.director.start();
    await h.settle();
    await h.settleActiveEncounters();
    syncProgress();

    let iterations = 0;
    let changed = true;
    while (changed && iterations++ < maxIterations) {
      changed = false;
      await h.settleActiveEncounters();
      syncProgress();
      if (trace && iterations % 25 === 0) {
        trace(
          `[iter=${iterations}] accepted=${everAccepted.size} completed=${everCompleted.size} map=${h.session.storyWorld.currentLocation?.map} reach=${h.reachableMapsFrom().size} running=[${h.session.questBook.runningQuestIds.slice(0, 6).join(',')}] lastEv=${[...everFiredEvents].slice(-3).join(',')}`,
        );
      }

      // 第 1 阶段：并发批量接取当前连通大陆上全部可走近的发布人任务（主支线同持）
      let admittedBatch = 0;
      for (const q of campaign.quests) {
        if (everAccepted.has(q.id) || h.session.status(q.id) !== 'available' || !q.giver) continue;
        const reach = h.reachableMapsFrom();
        const giverTarget = findSelectableEntityOnReachable(
          q.giver,
          q.giverCharacterId,
          placesToMaps(q.places?.available),
          reach,
        );
        if (!giverTarget) continue;
        await interactAndDrainNpcSlot(giverTarget.mapId, giverTarget.entity);
        admittedBatch++;
        changed = true;
      }

      // 同时并发接取当前连通大陆上纯开新单（不关闭活跃任务、不清支线、不单向离岛）的世界触发事件
      {
        const reach = h.reachableMapsFrom();
        const sidePending = hasPendingSideQuests(reach);
        const pureAcceptWorld = campaign.events.filter(ev => {
          if (ev.source === 'choice' || ev.source === 'quest' || ev.source === 'start' || ev.source === 'event') return false;
          if ((isResetEventNow(ev) && sidePending) || leavesCurrentIslandOneWay(ev) || wouldSkipUnacceptedCoQuest(ev)) return false;
          if (!isWorldEventPhysicallyReady(ev, reach)) return false;
          const cmds = activeCommandsFor(ev);
          const acceptsNew = cmds.some(qc => 'quest' in qc && qc.type === 'accept' && !everAccepted.has(qc.quest));
          const closesActive = cmds.some(
            qc => 'quest' in qc && (qc.type === 'complete' || qc.type === 'script-complete') && h.session.status(qc.quest) === 'active',
          );
          return acceptsNew && !closesActive;
        });
        for (const ev of pureAcceptWorld) {
          if (!isWorldEventPhysicallyReady(ev, h.reachableMapsFrom())) continue;
          await firePlaythroughEvent(ev);
          admittedBatch++;
          changed = true;
        }
      }
      if (admittedBatch > 0) continue;

      // 第 2 阶段：在多任务并发挂单状态下，利用当前可达大陆合法推进所有进行中任务的目标与交接物品
      let goalsProgressed = false;
      for (const qid of [...h.session.questBook.runningQuestIds]) {
        const q = h.indexes.questById.get(qid);
        if (!q || h.session.status(qid) !== 'active') continue;
        if (await tryAdvanceQuestOnReachable(q)) {
          goalsProgressed = true;
          changed = true;
        }
      }
      if (goalsProgressed) continue;

      const tryDeliverQuest = async (q: CampaignQuest, allowLeavingIsland: boolean): Promise<boolean> => {
        const st = h.session.status(q.id);
        if (st !== 'ready' && !(st === 'active' && q.interactionEvent && q.goals.length === 0)) return false;
        if (!allowLeavingIsland && deliveryLeavesIslandOneWay(q)) return false;
        const reach = h.reachableMapsFrom();
        if (q.interactionEvent) {
          const gateEv = campaign.events.find(e => e.id === q.interactionEvent);
          if (!allowLeavingIsland && gateEv && (isResetEventNow(gateEv) || leavesCurrentIslandOneWay(gateEv))) return false;
          if (q.delivery) {
            const deliv = findSelectableEntityOnReachable(
              q.delivery,
              q.deliveryCharacterId,
              placesToMaps(q.places?.ready),
              reach,
            );
            if (deliv) {
              await interactAndDrainNpcSlot(deliv.mapId, deliv.entity);
              return true;
            }
          } else if (gateEv && (allowLeavingIsland || !isResetEventNow(gateEv) || !hasPendingSideQuests(reach)) && isWorldEventPhysicallyReady(gateEv, reach)) {
            await firePlaythroughEvent(gateEv);
            return true;
          }
          return false;
        }
        if (q.delivery && (q.completion !== 'story' || !!q.completeScript)) {
          const deliv = findSelectableEntityOnReachable(
            q.delivery,
            q.deliveryCharacterId,
            placesToMaps(q.places?.ready),
            reach,
          );
          if (deliv) {
            await interactAndDrainNpcSlot(deliv.mapId, deliv.entity);
            return true;
          }
        }
        return false;
      };

      // 第 3 阶段：批量走近在场交付人结算本岛已就绪任务（含确认门任务与同人连续交接；单向离岛关口留到第 5 阶段）
      let deliveredAny = false;
      for (const q of campaign.quests) {
        if (await tryDeliverQuest(q, false)) {
          deliveredAny = true;
          changed = true;
        }
      }
      if (deliveredAny) continue;

      // 第 4 阶段：触发当前连通大陆上的剧情推进/解锁/接取世界事件（仍保护当章未完结支线与本岛未完结事件）
      {
        const reach = h.reachableMapsFrom();
        const sidePending = hasPendingSideQuests(reach);
        const eligibleWorld = campaign.events.filter(
          ev =>
            ev.source !== 'choice' &&
            ev.source !== 'quest' &&
            ev.source !== 'start' &&
            ev.source !== 'event' &&
            (!isResetEventNow(ev) || !sidePending) &&
            !leavesCurrentIslandOneWay(ev) &&
            !wouldSkipUnacceptedCoQuest(ev) &&
            isWorldEventPhysicallyReady(ev, reach),
        );

        const isNewAcceptCandidate = (ev: StoryEvent): boolean => {
          const cmds = activeCommandsFor(ev);
          if (!cmds.some(qc => 'quest' in qc && qc.type === 'accept' && !everAccepted.has(qc.quest))) return false;
          const closingActiveIds = new Set(
            cmds.flatMap(qc =>
              'quest' in qc && (qc.type === 'complete' || qc.type === 'script-complete') && h.session.status(qc.quest) === 'active'
                ? [qc.quest]
                : [],
            ),
          );
          if (closingActiveIds.size > 0 && ev.repeat) {
            const hasOtherOpenSubquest = campaign.quests.some(
              q =>
                !closingActiveIds.has(q.id) &&
                ['active', 'ready'].includes(h.session.status(q.id)) &&
                !!(q.delivery || q.completeScript || (h.indexes.eventsCompletingQuest.get(q.id)?.length ?? 0) > 0),
            );
            if (hasOtherOpenSubquest) return false;
            if (
              eligibleWorld.some(
                other =>
                  other !== ev &&
                  (evChoiceNodes.get(other.id) ?? []).some(ch => ch.options.length >= 3) &&
                  activeCommandsFor(other).some(qc => 'quest' in qc && qc.type === 'accept' && !everAccepted.has(qc.quest)),
              )
            ) {
              return false;
            }
          }
          return true;
        };

        const acceptEv = eligibleWorld.find(isNewAcceptCandidate);
        if (acceptEv) {
          await firePlaythroughEvent(acceptEv);
          changed = true;
          continue;
        }

        const progressEv = eligibleWorld.find(ev => {
          const cmds = activeCommandsFor(ev);
          const hasProgressCmd = cmds.some(
            qc =>
              'quest' in qc &&
              (!ev.repeat || !everCompleted.has(qc.quest)) &&
              ((qc.type === 'script-ready' && h.session.status(qc.quest) === 'active') ||
                ((qc.type === 'complete' || qc.type === 'script-complete') && ['active', 'ready'].includes(h.session.status(qc.quest)))),
          );
          if (hasProgressCmd || unlocksNewMap(ev, reach)) return true;
          if (ev.repeat) return false;
          const onlyPrematureQuestProgress =
            cmds.length > 0 &&
            cmds.every(
              qc =>
                'quest' in qc &&
                (qc.type === 'script-ready' || qc.type === 'complete' || qc.type === 'script-complete') &&
                !['active', 'ready'].includes(h.session.status(qc.quest)),
            );
          return !onlyPrematureQuestProgress;
        });
        if (progressEv) {
          await firePlaythroughEvent(progressEv);
          changed = true;
          continue;
        }
      }

      // 第 5 阶段：当章/当岛全部可达支线与事件均已结清，放行单向离岛交付或跨章 reset-side-quests 关口，并执行正式格式 1 存读档接力
      {
        let leftIslandByDelivery = false;
        allowChapterReset = true;
        try {
          for (const q of campaign.quests) {
            if (await tryDeliverQuest(q, true)) {
              leftIslandByDelivery = true;
              changed = true;
              break;
            }
          }
        } finally {
          allowChapterReset = false;
        }
        if (leftIslandByDelivery) {
          if (saveLoadRelays < 12 && !h.director.busy && h.session.storyWorld.activeEncounters.length === 0) {
            const locBefore = h.session.storyWorld.currentLocation;
            const { restored } = h.roundtripSaveLoad({
              validateStages,
              allowRecursiveConditionSolve: false,
              chooseOption,
            });
            assert.deepEqual(restored.session.storyWorld.currentLocation, locBefore, '跨章存读档接力后主角坐标不一致');
            h.dispose();
            h = restored;
            saveLoadRelays++;
            syncProgress();
          }
          continue;
        }

        const reach = h.reachableMapsFrom();
        const resetCand =
          campaign.events.find(
            ev =>
              ev.source !== 'choice' &&
              ev.source !== 'quest' &&
              ev.source !== 'start' &&
              ev.source !== 'event' &&
              (isResetEventNow(ev) || leavesCurrentIslandOneWay(ev)) &&
              !wouldSkipUnacceptedCoQuest(ev) &&
              (!ev.repeat || !everFiredEvents.has(ev.id) || hasUsefulRepeatAction(ev, reach)) &&
              isWorldEventPhysicallyReady(ev, reach),
          ) ??
          campaign.events.find(
            ev =>
              ev.source !== 'choice' &&
              ev.source !== 'quest' &&
              ev.source !== 'start' &&
              ev.source !== 'event' &&
              (isResetEventNow(ev) || leavesCurrentIslandOneWay(ev) || wouldSkipUnacceptedCoQuest(ev)) &&
              (!ev.repeat || !everFiredEvents.has(ev.id) || hasUsefulRepeatAction(ev, reach)) &&
              isWorldEventPhysicallyReady(ev, reach),
          );

        if (resetCand) {
          const wasBoundary = isResetEventNow(resetCand) || leavesCurrentIslandOneWay(resetCand);
          allowChapterReset = true;
          try {
            await firePlaythroughEvent(resetCand);
          } finally {
            allowChapterReset = false;
          }
          changed = true;

          // 跨章关口演完静止后，执行正式格式 1 存读档往返并用恢复后的新实例接力后续章节
          if (wasBoundary && saveLoadRelays < 12 && !h.director.busy && h.session.storyWorld.activeEncounters.length === 0) {
            const locBefore = h.session.storyWorld.currentLocation;
            const { restored } = h.roundtripSaveLoad({
              validateStages,
              allowRecursiveConditionSolve: false,
              chooseOption,
            });
            assert.deepEqual(restored.session.storyWorld.currentLocation, locBefore, '跨章存读档接力后主角坐标不一致');
            h.dispose();
            h = restored;
            saveLoadRelays++;
            syncProgress();
          }
        }
      }
    }

    assert.ok(iterations < 3950, `新开局一镜到底连贯通关未在预算轮次内收敛（iterations=${iterations}）`);

    // 最终整局通关态再执行一次正式格式 1 存读档核验
    const { restored: finalRestored } = h.roundtripSaveLoad({
      validateStages,
      allowRecursiveConditionSolve: false,
      chooseOption,
    });
    try {
      for (const q of campaign.quests) {
        assert.equal(
          finalRestored.session.status(q.id),
          h.session.status(q.id),
          `终局存档读回后任务 ${q.id}（${q.title}）状态不一致`,
        );
      }
      saveLoadRelays++;
    } finally {
      finalRestored.dispose();
    }

    const terminalLandmarks = campaign.quests
      .filter(q => !everCompleted.has(q.id))
      .map(q => {
        if (q.journal !== false) {
          trace?.(
            `STALL loc=${JSON.stringify(h.session.storyWorld.currentLocation)} accepted=${everAccepted.size} completed=${everCompleted.size} running=[${h.session.questBook.runningQuestIds.join(',')}] reach=[${[...h.reachableMapsFrom()].join(',')}] fired=[${[...everFiredEvents].slice(-12).join(',')}]`,
          );
        }
        assert.equal(q.journal, false, `连贯通关中未完成的任务必须是终态日志外任务：${q.id}（${q.title}）`);
        assert.ok(['active', 'ready'].includes(h.session.status(q.id)), `终态日志外任务状态异常：${q.id}`);
        return q.id;
      });

    return {
      totalQuests: campaign.quests.length,
      acceptedCount: everAccepted.size,
      completedCount: everCompleted.size,
      terminalLandmarkIds: terminalLandmarks,
      peakConcurrentRunningQuests,
      peakConcurrentJournalQuests,
      sameNpcSequentialHandoffs,
      sharedItemReacquisitions,
      crossMapDeliveries,
      saveLoadRelays,
      iterations,
    };
  } finally {
    h.dispose();
  }
}
