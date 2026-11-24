import assert from 'node:assert/strict';
import test from 'node:test';
import { moneyGain } from '../src/domain/economy.ts';
import { storyConditionReferences } from '../src/domain/story-condition.ts';
import type { StoryCondition } from '../src/domain/story-condition.ts';
import type { StoryNode } from '../src/domain/story-graph.ts';
import {
  buildCampaignIndexes,
  createQuestE2EHarness,
  loadOfficialQuestContent,
} from './support/quest-e2e-harness.ts';

const official = loadOfficialQuestContent();
const { campaign } = official;
const indexes = buildCampaignIndexes(campaign);

/**
 * 第一部分：零任务 ID 硬编码的全量条件依赖图自动拓扑推演。
 * 从 campaign.start 空状态出发，验证全部 487 个任务均可自然解锁接取、无孤岛无死锁。
 */
test('全量 487 个正式任务在条件依赖图上从开局全部可解锁且无死锁断链', () => {
  const nonRewardItemSources = new Set<string>();
  for (const list of Object.values(official.drops.questItems)) {
    for (const entry of list) nonRewardItemSources.add(entry.item);
  }
  for (const map of official.maps.values()) {
    for (const sp of map.questItemSpawns ?? []) nonRewardItemSources.add(sp.item);
  }
  for (const q of campaign.quests) {
    for (const it of q.onAcceptItems ?? []) nonRewardItemSources.add(it.item);
  }
  for (const s of Object.values(campaign.scripts)) {
    for (const n of s.nodes) {
      for (const c of n.commands) {
        if (c.type === 'item-give') nonRewardItemSources.add(c.item);
      }
    }
  }
  const exclusiveQuestRewardItems = new Set<string>();
  for (const q of campaign.quests) {
    for (const it of q.rewards?.items ?? []) {
      if (!nonRewardItemSources.has(it.item)) exclusiveQuestRewardItems.add(it.item);
    }
  }

  // 预计算每个事件直接关联的任务命令、目标地图与选择出口
  const evDirectCommands = new Map<string, ReturnType<typeof indexes.scriptQuestCommands.get>>();
  const evScriptMaps = new Map<string, string[]>();
  const evChoiceNodes = new Map<string, { choice: string; options: string[] }[]>();
  for (const ev of campaign.events) {
    const script = campaign.scripts[ev.script];
    const direct = indexes.scriptQuestCommands.get(ev.script) ?? [];
    evDirectCommands.set(ev.id, direct);
    const destMaps = new Set<string>();
    for (const n of script?.nodes ?? []) {
      if (n.stage && !n.stage.mapFromWorld) destMaps.add(n.stage.map);
      for (const p of n.presentation) {
        if (p.type === 'stage' && !p.mapFromWorld) destMaps.add(p.map);
      }
      for (const c of n.commands) {
        if (c.type === 'travel') destMaps.add(c.destination.map);
        else if (c.type === 'world' && c.command.kind === 'travel') destMaps.add(c.command.destination.map);
      }
    }
    evScriptMaps.set(ev.id, [...destMaps]);
    const chNodes = (script?.nodes ?? [])
      .filter(n => n.exit.type === 'choice')
      .map(n => ({
        choice: n.exit.type === 'choice' ? n.exit.choice : '',
        options: n.exit.type === 'choice' ? Object.keys(n.exit.cases) : [],
      }));
    evChoiceNodes.set(ev.id, chNodes);
  }

  // 预索引哪些敌人在地图刷怪点或剧情敌人摆放中存在
  const mapEnemiesByMap = new Map<string, Set<string>>();
  for (const map of official.maps.values()) {
    const set = new Set<string>((map.enemySpawns ?? []).map(s => s.enemyId));
    mapEnemiesByMap.set(map.id, set);
  }
  for (const ep of campaign.enemyPlacements ?? []) {
    const set = mapEnemiesByMap.get(ep.map) ?? new Set<string>();
    set.add(ep.enemyId);
    mapEnemiesByMap.set(ep.map, set);
  }

  const questStatus = new Map<string, string>(campaign.quests.map(q => [q.id, 'inactive']));
  const everAccepted = new Set<string>();
  const everCompleted = new Set<string>();
  const firedEvents = new Set<string>();
  const flags = new Set<string>();
  const items = new Map<string, number>();
  const choices = new Map<string, string>();
  const triedOptions = new Set<string>();
  const triedOptionsThisEpoch = new Set<string>();
  const repeatFiresThisEpoch = new Map<string, number>();
  const bumpEpoch = () => {
    triedOptionsThisEpoch.clear();
    repeatFiresThisEpoch.clear();
  };
  const canFireEvent = (ev: (typeof campaign.events)[number]): boolean => {
    if (!ev.repeat) return !firedEvents.has(ev.id);
    const maxTries = Math.max(1, ...(evChoiceNodes.get(ev.id) ?? []).map(c => c.options.length));
    return (repeatFiresThisEpoch.get(ev.id) ?? 0) < maxTries;
  };
  const activeEncounterEnemies = new Set<string>();
  const visitedMaps = new Set<string>();
  const addVisitedMap = (startMap: string | undefined) => {
    if (!startMap || visitedMaps.has(startMap)) return;
    const queue = [startMap];
    visitedMaps.add(startMap);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const mapObj = official.maps.get(cur);
      for (const ex of mapObj?.exits ?? []) {
        if (!visitedMaps.has(ex.destination)) {
          visitedMaps.add(ex.destination);
          queue.push(ex.destination);
        }
      }
    }
  };
  addVisitedMap(campaign.start.map);

  const placeReachable = (place: (typeof campaign.events)[number]['place']): boolean => {
    if (!place || place.type === 'current' || place.type === 'unavailable') return true;
    if (place.type === 'fixed') return visitedMaps.has(place.map);
    return place.spots.some(s => visitedMaps.has(s.map));
  };

  const eventMapReachable = (ev: (typeof campaign.events)[number]): boolean => {
    if (ev.map) return visitedMaps.has(ev.map);
    return placeReachable(ev.place);
  };

  const evalCond = (cond: StoryCondition | undefined): boolean => {
    if (!cond) return true;
    switch (cond.type) {
      case 'always':
        return !!cond.value;
      case 'all':
        return cond.conditions.every(evalCond);
      case 'any':
        return cond.conditions.some(evalCond);
      case 'not':
        return !evalCond(cond.condition);
      case 'flag':
        return flags.has(cond.flag) === (cond.value ?? true);
      case 'quest': {
        const st = questStatus.get(cond.quest) ?? 'inactive';
        if (cond.status === 'available') {
          const q = indexes.questById.get(cond.quest)!;
          return st === 'inactive' && evalCond(q.availableWhen);
        }
        if (cond.status === 'accepted') return st === 'active' || st === 'ready' || st === 'completed';
        if (cond.status === 'settled') return st === 'completed' || everCompleted.has(cond.quest);
        return st === cond.status;
      }
      case 'event':
        return firedEvents.has(cond.event) === (cond.status === 'completed');
      case 'choice':
        return choices.get(cond.choice) === cond.value;
      default:
        return true;
    }
  };

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
        return evalCond(cond);
    }
  };

  const activeCommandsFor = (evId: string) => {
    const direct = evDirectCommands.get(evId) ?? [];
    const chNodes = evChoiceNodes.get(evId) ?? [];
    if (chNodes.length === 0) return direct;
    const viaChoice = chNodes.flatMap(ch =>
      ch.options.flatMap(opt =>
        (indexes.choiceEvents.get(`${ch.choice}=${opt}`) ?? [])
          .filter(cev => (cev.repeat || !firedEvents.has(cev.id)) && evalCondIgnoringChoice(cev.condition))
          .flatMap(cev => indexes.scriptQuestCommands.get(cev.script) ?? []),
      ),
    );
    return [...direct, ...viaChoice];
  };

  const isResetEventNow = (evId: string): boolean =>
    activeCommandsFor(evId).some(qc => qc.type === 'reset-side-quests');

  const isEnemyReachableNow = (enemyId: string): boolean => {
    if (activeEncounterEnemies.has(enemyId)) return true;
    for (const m of visitedMaps) {
      if (mapEnemiesByMap.get(m)?.has(enemyId)) return true;
    }
    for (const q of campaign.quests) {
      if (questStatus.get(q.id) !== 'active') continue;
      const p = q.places?.active;
      const mapsToCheck =
        p?.type === 'fixed' ? [p.map] : p?.type === 'alternatives' ? p.spots.map(s => s.map) : [];
      if (mapsToCheck.some(m => mapEnemiesByMap.get(m)?.has(enemyId))) return true;
    }
    return false;
  };

  const battleEligible = (ev: (typeof campaign.events)[number]): boolean => {
    if (ev.source !== 'battle') return true;
    const key = ev.key ?? '';
    if (key.startsWith('health-below-30:')) return isEnemyReachableNow(key.slice('health-below-30:'.length));
    if (key.startsWith('defeat:')) return isEnemyReachableNow(key.slice('defeat:'.length));
    return true;
  };

  const scoreChoice = (evId: string, choiceId: string, opt: string): number => {
    const cEvents = (indexes.choiceEvents.get(`${choiceId}=${opt}`) ?? []).filter(
      cev => (cev.repeat || !firedEvents.has(cev.id)) && evalCondIgnoringChoice(cev.condition),
    );
    const cmds = cEvents.flatMap(cev => indexes.scriptQuestCommands.get(cev.script) ?? []);
    let score = 0;
    for (const qc of cmds) {
      if (qc.type === 'accept' && !everAccepted.has(qc.quest)) score += 120;
      if ((qc.type === 'complete' || qc.type === 'script-complete') && ['active', 'ready'].includes(questStatus.get(qc.quest)!)) {
        score += 90;
      }
    }
    for (const cev of cEvents) {
      if (indexes.scriptHasTrap.get(cev.script)) score -= 300;
    }
    if (!triedOptions.has(`${evId}:${choiceId}:${opt}`)) score += 15;
    if (triedOptionsThisEpoch.has(`${evId}:${choiceId}:${opt}`)) score -= 10000;
    return score;
  };

  const applyCmd = (cmd: (typeof campaign.scripts)[string]['nodes'][number]['commands'][number]) => {
    if (cmd.type === 'flag') {
      const nextVal = cmd.value ?? true;
      if (flags.has(cmd.flag) !== nextVal) {
        if (nextVal) flags.add(cmd.flag);
        else flags.delete(cmd.flag);
        bumpEpoch();
      }
    } else if (cmd.type === 'item-give') {
      items.set(cmd.item, (items.get(cmd.item) ?? 0) + (cmd.quantity ?? 1));
      bumpEpoch();
    } else if (cmd.type === 'item-take') {
      const prev = items.get(cmd.item) ?? 0;
      const next = Math.max(0, prev - (cmd.quantity ?? 1));
      if (next !== prev) {
        items.set(cmd.item, next);
        bumpEpoch();
      }
    } else if (cmd.type === 'encounter') {
      for (const sp of cmd.encounter.spawns) {
        if (!activeEncounterEnemies.has(sp.enemyId)) {
          activeEncounterEnemies.add(sp.enemyId);
          bumpEpoch();
        }
      }
    } else if (cmd.type === 'world' && cmd.command.kind === 'encounter') {
      for (const sp of cmd.command.encounter.spawns) {
        if (!activeEncounterEnemies.has(sp.enemyId)) {
          activeEncounterEnemies.add(sp.enemyId);
          bumpEpoch();
        }
      }
    } else if (cmd.type === 'travel') {
      const before = visitedMaps.size;
      addVisitedMap(cmd.destination.map);
      if (visitedMaps.size !== before) bumpEpoch();
    } else if (cmd.type === 'world' && cmd.command.kind === 'travel') {
      const before = visitedMaps.size;
      addVisitedMap(cmd.command.destination.map);
      if (visitedMaps.size !== before) bumpEpoch();
    } else if (cmd.type === 'world' && cmd.command.kind === 'enemy-availability' && cmd.command.available) {
      const set = mapEnemiesByMap.get(cmd.command.map) ?? new Set<string>();
      if (!set.has(cmd.command.enemyId)) {
        set.add(cmd.command.enemyId);
        mapEnemiesByMap.set(cmd.command.map, set);
        bumpEpoch();
      }
    } else if (cmd.type === 'world' && cmd.command.kind === 'enemy-location' && cmd.command.location) {
      const set = mapEnemiesByMap.get(cmd.command.location.map) ?? new Set<string>();
      if (!set.has(cmd.command.enemyId)) {
        set.add(cmd.command.enemyId);
        mapEnemiesByMap.set(cmd.command.location.map, set);
        bumpEpoch();
      }
    } else if (cmd.type === 'quest') {
      const qc = cmd.command;
      if (qc.type === 'accept' && ['inactive', 'completed'].includes(questStatus.get(qc.quest)!)) {
        const q = indexes.questById.get(qc.quest)!;
        everAccepted.add(qc.quest);
        questStatus.set(qc.quest, q.goals.length === 0 && q.completion !== 'story' ? 'ready' : 'active');
        for (const it of q.onAcceptItems ?? []) items.set(it.item, (items.get(it.item) ?? 0) + it.quantity);
        bumpEpoch();
      } else if (qc.type === 'script-ready' && questStatus.get(qc.quest) === 'active') {
        questStatus.set(qc.quest, 'ready');
        bumpEpoch();
      } else if (qc.type === 'reset' && questStatus.get(qc.quest) !== 'inactive') {
        questStatus.set(qc.quest, 'inactive');
        bumpEpoch();
      } else if (
        (qc.type === 'complete' && ['active', 'ready'].includes(questStatus.get(qc.quest)!)) ||
        (qc.type === 'script-complete' && questStatus.get(qc.quest) !== 'completed')
      ) {
        const q = indexes.questById.get(qc.quest)!;
        everCompleted.add(qc.quest);
        questStatus.set(qc.quest, q.repeat ? 'inactive' : 'completed');
        for (const it of q.rewards?.items ?? []) items.set(it.item, (items.get(it.item) ?? 0) + it.quantity);
        bumpEpoch();
      } else if (qc.type === 'reset-side-quests') {
        for (const q of campaign.quests) {
          if (indexes.groupKindByQuest.get(q.id) === 'side' && ['active', 'ready'].includes(questStatus.get(q.id)!)) {
            questStatus.set(q.id, 'inactive');
            bumpEpoch();
          }
        }
      }
    }
  };

  const runScript = (scriptId: string, evId: string) => {
    let curScript: string | undefined = scriptId;
    let curNodeId: string | undefined = campaign.scripts[scriptId]!.entry;
    let guard = 0;
    while (curScript && curNodeId && guard++ < 400) {
      const targetNodeId: string = curNodeId;
      const cur: StoryNode | undefined = campaign.scripts[curScript]?.nodes.find(n => n.id === targetNodeId);
      if (!cur) break;
      if (cur.stage && !cur.stage.mapFromWorld) addVisitedMap(cur.stage.map);
      for (const p of cur.presentation) {
        if (p.type === 'stage' && !p.mapFromWorld) addVisitedMap(p.map);
      }
      for (const c of cur.commands) applyCmd(c);
      const ex: StoryNode['exit'] = cur.exit;
      if (ex.type === 'end') break;
      if (ex.type === 'next') {
        curScript = ex.target.script;
        curNodeId = ex.target.node;
      } else if (ex.type === 'branch') {
        const nextRef = evalCond(ex.condition) ? ex.then : ex.otherwise;
        curScript = nextRef.script;
        curNodeId = nextRef.node;
      } else if (ex.type === 'waitEncounter') {
        for (const sp of ex.encounter.spawns) activeEncounterEnemies.add(sp.enemyId);
        const wonRef = ex.outcomes.won ?? Object.values(ex.outcomes)[0];
        curScript = wonRef?.script;
        curNodeId = wonRef?.node;
      } else if (ex.type === 'choice') {
        const opts = Object.keys(ex.cases).sort((a, b) => scoreChoice(evId, ex.choice, b) - scoreChoice(evId, ex.choice, a));
        const picked = opts[0]!;
        triedOptions.add(`${evId}:${ex.choice}:${picked}`);
        triedOptionsThisEpoch.add(`${evId}:${ex.choice}:${picked}`);
        choices.set(ex.choice, picked);
        const chosenRef = ex.cases[picked];
        curScript = chosenRef?.script;
        curNodeId = chosenRef?.node;
      }
    }
  };

  const fireEvent = (ev: (typeof campaign.events)[number]) => {
    if (!firedEvents.has(ev.id)) {
      firedEvents.add(ev.id);
      bumpEpoch();
    } else if (ev.repeat) {
      repeatFiresThisEpoch.set(ev.id, (repeatFiresThisEpoch.get(ev.id) ?? 0) + 1);
    }
    if (ev.map) {
      const before = visitedMaps.size;
      addVisitedMap(ev.map);
      if (visitedMaps.size !== before) bumpEpoch();
    }
    choices.clear();
    runScript(ev.script, ev.id);
    if (choices.size > 0) {
      for (const cev of campaign.events) {
        if (cev.source === 'choice' && (cev.repeat || !firedEvents.has(cev.id)) && evalCond(cev.condition)) {
          if (!firedEvents.has(cev.id)) {
            firedEvents.add(cev.id);
            bumpEpoch();
          }
          runScript(cev.script, cev.id);
        }
      }
      choices.clear();
    }
  };

  const hasPendingSideQuests = (): boolean =>
    campaign.quests.some(
      q =>
        indexes.groupKindByQuest.get(q.id) === 'side' &&
        (['active', 'ready'].includes(questStatus.get(q.id)!) ||
          (!everAccepted.has(q.id) && !!(q.giver || q.offerScript) && placeReachable(q.places?.available) && evalCond(q.availableWhen))),
    );

  /** 若一次性事件会同时结算一条尚未接取（且本事件自身也不接取、但存在正式接取入口）的共行任务，先等那条接取支线汇合。 */
  const wouldSkipUnacceptedCoQuest = (ev: (typeof campaign.events)[number]): boolean => {
    if (ev.repeat) return false;
    const cmds = activeCommandsFor(ev.id);
    const acceptedHere = new Set(cmds.flatMap(qc => ('quest' in qc && qc.type === 'accept' ? [qc.quest] : [])));
    return cmds.some(qc => {
      if (!('quest' in qc) || (qc.type !== 'complete' && qc.type !== 'script-complete')) return false;
      if (everAccepted.has(qc.quest) || acceptedHere.has(qc.quest)) return false;
      const q = indexes.questById.get(qc.quest);
      return !!q && (!!q.giver || !!q.offerScript || (indexes.eventsAcceptingQuest.get(qc.quest)?.length ?? 0) > 0);
    });
  };

  const unlocksNewMap = (evId: string): boolean => {
    if ((evScriptMaps.get(evId) ?? []).some(m => !visitedMaps.has(m))) return true;
    const chNodes = evChoiceNodes.get(evId) ?? [];
    for (const ch of chNodes) {
      for (const opt of ch.options) {
        for (const cev of indexes.choiceEvents.get(`${ch.choice}=${opt}`) ?? []) {
          if ((cev.repeat || !firedEvents.has(cev.id)) && evalCondIgnoringChoice(cev.condition)) {
            if ((evScriptMaps.get(cev.id) ?? []).some(m => !visitedMaps.has(m))) return true;
          }
        }
      }
    }
    return false;
  };

  const hasUsefulRepeatAction = (evId: string): boolean =>
    unlocksNewMap(evId) ||
    activeCommandsFor(evId).some(
      qc =>
        ('quest' in qc && qc.type === 'accept' && !everAccepted.has(qc.quest)) ||
        ('quest' in qc &&
          (qc.type === 'complete' || qc.type === 'script-complete') &&
          ['active', 'ready'].includes(questStatus.get(qc.quest)!) &&
          !everCompleted.has(qc.quest)),
    );

  let changed = true;
  let iterations = 0;
  while (changed && iterations++ < 6000) {
    changed = false;
    const sidePending = hasPendingSideQuests();

    // 1. 自动任务/事件链/开场事件优先
    for (const ev of campaign.events) {
      if (ev.source !== 'quest' && ev.source !== 'start' && ev.source !== 'event') continue;
      if (!canFireEvent(ev)) continue;
      if ((isResetEventNow(ev.id) && sidePending) || !evalCond(ev.condition)) continue;
      if (wouldSkipUnacceptedCoQuest(ev)) continue;
      if (ev.repeat && !hasUsefulRepeatAction(ev.id)) {
        continue;
      }
      fireEvent(ev);
      changed = true;
      break;
    }
    if (changed) continue;

    // 2. 接取所有条件与所在地图已满足的发布人任务
    for (const q of campaign.quests) {
      if (questStatus.get(q.id) !== 'inactive' || everAccepted.has(q.id)) continue;
      if (!q.giver && !q.offerScript) continue;
      if (!placeReachable(q.places?.available) || !evalCond(q.availableWhen)) continue;
      if (q.offerScript) runScript(q.offerScript, q.id);
      else applyCmd({ type: 'quest', command: { type: 'accept', quest: q.id } });
      changed = true;
      break;
    }
    if (changed) continue;

    // 3. 触发世界事件（有未结清支线时暂缓跨章 reset-side-quests 事件，且要求所在大陆/地图已连通可达）
    const eligibleWorld = campaign.events.filter(
      ev =>
        ev.source !== 'choice' &&
        ev.source !== 'quest' &&
        ev.source !== 'start' &&
        ev.source !== 'event' &&
        (!isResetEventNow(ev.id) || !sidePending) &&
        !wouldSkipUnacceptedCoQuest(ev) &&
        canFireEvent(ev) &&
        eventMapReachable(ev) &&
        battleEligible(ev) &&
        evalCond(ev.condition),
    );
    const isNewAcceptCandidate = (ev: (typeof campaign.events)[number]) => {
      const cmds = activeCommandsFor(ev.id);
      const hasNew = cmds.some(qc => 'quest' in qc && qc.type === 'accept' && !everAccepted.has(qc.quest));
      if (!hasNew) return false;
      // 关闭外层容器任务的入口：在同层多选路线尚未走完、或仍有其他进行中子任务未收尾前先让位
      const closingActiveIds = new Set(
        cmds.flatMap(qc =>
          'quest' in qc && (qc.type === 'complete' || qc.type === 'script-complete') && questStatus.get(qc.quest) === 'active'
            ? [qc.quest]
            : [],
        ),
      );
      if (closingActiveIds.size > 0 && ev.repeat) {
        const hasOtherOpenSubquest = campaign.quests.some(
          q =>
            !closingActiveIds.has(q.id) &&
            ['active', 'ready'].includes(questStatus.get(q.id)!) &&
            !!(q.delivery || q.completeScript || (indexes.eventsCompletingQuest.get(q.id)?.length ?? 0) > 0),
        );
        if (hasOtherOpenSubquest) return false;
        if (
          eligibleWorld.some(
            other =>
              other !== ev &&
              (evChoiceNodes.get(other.id) ?? []).some(ch => ch.options.length >= 3) &&
              activeCommandsFor(other.id).some(qc => 'quest' in qc && qc.type === 'accept' && !everAccepted.has(qc.quest)),
          )
        ) {
          return false;
        }
      }
      return true;
    };
    // 先触发只开启新任务而不关闭当前进行中任务的事件（避免提前完结外层任务导致支路入口失效）
    const pureAcceptEv = eligibleWorld.find(ev => {
      if (!isNewAcceptCandidate(ev)) return false;
      const cmds = activeCommandsFor(ev.id);
      return !cmds.some(
        qc => 'quest' in qc && (qc.type === 'complete' || qc.type === 'script-complete') && questStatus.get(qc.quest) === 'active',
      );
    });
    const newAcceptEv = pureAcceptEv ?? eligibleWorld.find(isNewAcceptCandidate);
    if (newAcceptEv) {
      fireEvent(newAcceptEv);
      changed = true;
      continue;
    }

    const progressEv = eligibleWorld.find(ev => {
      const cmds = activeCommandsFor(ev.id);
      const hasProgressCmd = cmds.some(
        qc =>
          'quest' in qc &&
          (!ev.repeat || !everCompleted.has(qc.quest)) &&
          ((qc.type === 'script-ready' && questStatus.get(qc.quest) === 'active') ||
            ((qc.type === 'complete' || qc.type === 'script-complete') && ['active', 'ready'].includes(questStatus.get(qc.quest)!))),
      );
      if (hasProgressCmd || unlocksNewMap(ev.id)) return true;
      if (ev.repeat) return false;
      // 若一次性事件只带针对某个任务的就绪/完成命令，而该任务尚未激活，不能提前空放消耗掉该事件
      const onlyPrematureQuestProgress =
        cmds.length > 0 &&
        cmds.every(
          qc =>
            'quest' in qc &&
            (qc.type === 'script-ready' || qc.type === 'complete' || qc.type === 'script-complete') &&
            questStatus.get(qc.quest) === 'inactive',
        );
      return !onlyPrematureQuestProgress;
    });
    if (progressEv) {
      fireEvent(progressEv);
      changed = true;
      continue;
    }

    // 4. 推进进行中任务目标
    for (const q of campaign.quests) {
      if (questStatus.get(q.id) !== 'active' || q.goals.length === 0) continue;
      if (q.goals.some(g => g.kind === 'item' && exclusiveQuestRewardItems.has(g.target) && (items.get(g.target) ?? 0) < g.quantity)) {
        continue;
      }
      for (const g of q.goals) {
        if (g.kind === 'item') items.set(g.target, Math.max(items.get(g.target) ?? 0, g.quantity));
      }
      questStatus.set(q.id, 'ready');
      bumpEpoch();
      changed = true;
      break;
    }
    if (changed) continue;

    // 5. 交付已就绪任务
    for (const q of campaign.quests) {
      if (questStatus.get(q.id) !== 'ready' || q.interactionEvent) continue;
      if (q.completion === 'story' && !q.completeScript && !q.delivery) continue;
      if (!q.delivery && !q.giver && !q.completeScript) continue;
      if (q.completeScript) runScript(q.completeScript, q.id);
      else applyCmd({ type: 'quest', command: { type: 'complete', quest: q.id } });
      changed = true;
      break;
    }
    if (changed) continue;

    // 6. 兜底放行暂缓事件：优先放行跨章 reset-side-quests 关口（不跨越未接共行任务），仍无进展再兜底共行收尾事件
    const resetEv = campaign.events.find(
      ev =>
        ev.source !== 'choice' &&
        isResetEventNow(ev.id) &&
        !wouldSkipUnacceptedCoQuest(ev) &&
        canFireEvent(ev) &&
        (!ev.repeat ? !firedEvents.has(ev.id) : !firedEvents.has(ev.id) || hasUsefulRepeatAction(ev.id)) &&
        eventMapReachable(ev) &&
        battleEligible(ev) &&
        evalCond(ev.condition),
    );
    const deferredEv =
      resetEv ??
      campaign.events.find(
        ev =>
          ev.source !== 'choice' &&
          (isResetEventNow(ev.id) || wouldSkipUnacceptedCoQuest(ev)) &&
          canFireEvent(ev) &&
          (!ev.repeat ? !firedEvents.has(ev.id) : !firedEvents.has(ev.id) || hasUsefulRepeatAction(ev.id)) &&
          eventMapReachable(ev) &&
          battleEligible(ev) &&
          evalCond(ev.condition),
      );
    if (deferredEv) {
      fireEvent(deferredEv);
      changed = true;
    }
  }
  assert.ok(iterations < 5900, `条件依赖图拓扑推演未在预算轮次内收敛（iterations=${iterations}）`);

  const unaccepted = campaign.quests.filter(q => !everAccepted.has(q.id));
  assert.deepEqual(
    unaccepted.map(q => `${q.id}:${q.title}`),
    [],
    `存在无法从开局自然解锁接取的断链任务`,
  );
  assert.equal(everAccepted.size, campaign.quests.length);

  const terminalLandmarks = campaign.quests.filter(q => !everCompleted.has(q.id));
  for (const q of terminalLandmarks) {
    assert.equal(q.journal, false, `未闭合为 completed 的任务必须是日志外任务：${q.id} (${q.title})`);
    assert.ok(['active', 'ready'].includes(questStatus.get(q.id)!), `日志外路标任务状态异常：${q.id}`);
  }
  assert.equal(
    everCompleted.size + terminalLandmarks.length,
    campaign.quests.length,
    '全部 487 个正式任务必须全部闭合',
  );
});

/**
 * 第二部分：遍历全部 487 个正式任务，逐一在独立干净会话中驱动
 * 「前置推导 → 真实接取 → 真实目标达成 → 真实交付结算/弹窗阻塞校验 → 存读档防重与可重复任务二轮闭环」。
 * 任何一个任务配置或逻辑损坏，只精准红掉该任务所属的测试项。
 */
test('全部 487 个正式任务逐一独立跑通「接取 → 目标达成 → 交付结算」状态闭环', async t => {
  const verifiedQuestIds = new Set<string>();
  let repeatQuestsVerified = 0;
  let landmarkQuestsVerified = 0;
  let saveRoundtripsVerified = 0;
  const sharedHarness = createQuestE2EHarness(official, { validateStages: false });
  t.after(() => sharedHarness.dispose());

  for (const group of campaign.questGroups) {
    await t.test(`[${group.kind === 'main' ? '主线组' : '支线组'}] ${group.title} (${group.id})`, async () => {
      const h = sharedHarness;
      for (const questId of group.questIds) {
        const quest = indexes.questById.get(questId);
        assert.ok(quest, `任务组 ${group.id} 引用了不存在的任务 ${questId}`);
        verifiedQuestIds.add(questId);

        try {
          await h.prepareAndAdmitQuest(questId);
          for (const gift of quest.onAcceptItems ?? []) {
            assert.ok(
              h.session.itemCount(gift.item) >= gift.quantity || h.session.status(questId) === 'completed',
              `任务 ${questId}（${quest.title}）接取赠送物品 ${gift.item} 未入包`,
            );
          }

          const outcome = await h.completeQuest(quest);
          if (quest.journal === false) {
            assert.equal(
              h.log.popups.some(p => p.questId === questId),
              false,
              `日志外任务 ${questId}（${quest.title}）不应弹出任何任务面板`,
            );
          }

          if (outcome === 'terminal-landmark') {
            landmarkQuestsVerified++;
            // 验证终态日志外任务要么被下游事件/任务条件消费，要么自身携带真实战斗目标已完成就绪
            const referencedDownstream =
              campaign.events.some(ev => storyConditionReferences(ev.condition).quests.has(questId)) ||
              campaign.quests.some(other => storyConditionReferences(other.availableWhen).quests.has(questId));
            assert.ok(
              referencedDownstream || (quest.goals.length > 0 && h.session.status(questId) === 'ready'),
              `终态日志外任务 ${questId} 既无下游引用也未达成目标`,
            );
            continue;
          }

          // 校验奖励收据与可重复周期
          if (quest.repeat) {
            repeatQuestsVerified++;
            assert.ok(h.session.questBook.completedCycles(questId) >= 1);
            // 可重复任务紧接着跑通第 2 轮完整闭环
            assert.equal(h.session.status(questId), 'available', `可重复任务 ${questId} 首轮完成后应回到 available`);
            await h.admitViaGiver(quest);
            assert.ok(['active', 'ready'].includes(h.session.status(questId)), `可重复任务 ${questId} 第二轮未激活`);
            await h.completeQuest(quest);
            assert.ok(h.session.questBook.completedCycles(questId) >= 2, `可重复任务 ${questId} 第二轮未完成`);
          } else {
            const scriptResetAfterComplete =
              h.session.status(questId) === 'available' && h.session.questBook.completedCycles(questId) >= 1;
            if (!scriptResetAfterComplete) {
              assert.equal(h.session.status(questId), 'completed');
              assert.equal(h.session.complete(questId), false, `一次性任务 ${questId} 不允许二次直接完成`);
            } else {
              assert.ok(h.session.questBook.completedCycles(questId) >= 1);
            }

            const receipt = h.session.rewardReceiptFor(questId);
            if (receipt) {
              assert.equal(receipt.money, moneyGain(quest.rewards?.money ?? 0), `任务 ${questId} 金币收据不一致`);
              assert.equal(receipt.experience, quest.rewards?.experience ?? 0, `任务 ${questId} 经验收据不一致`);
            }

            // 对抽样章节代表任务执行正式格式 1 存读档往返校验
            if (group.questIds[0] === questId && saveRoundtripsVerified < 24 && !scriptResetAfterComplete) {
              saveRoundtripsVerified++;
              const { restored } = h.roundtripSaveLoad({ validateStages: false });
              try {
                assert.equal(restored.session.status(questId), 'completed', `任务 ${questId} 读档后完成态丢失`);
                assert.equal(restored.session.complete(questId), false);
              } finally {
                restored.dispose();
              }
            }
          }
        } catch (error) {
          const detail = `[${group.id} ${group.title}] 任务 ${quest.id}「${quest.title}」(status=${h.session.status(quest.id)})`;
          if (error instanceof Error) {
            error.message = `${detail} -> ${error.message}`;
          }
          throw error;
        }
      }
    });
  }

  // 兜底检查：确保 campaign.quests 里没有任何游离在 questGroups 之外的漏网任务
  const ungrouped = campaign.quests.filter(q => !verifiedQuestIds.has(q.id));
  assert.deepEqual(ungrouped.map(q => q.id), [], '存在未编入 questGroups 的漏测任务');
  assert.equal(verifiedQuestIds.size, campaign.quests.length, '必须 100% 覆盖 campaign.quests 全部任务');
  assert.ok(repeatQuestsVerified >= 11, `可重复任务双轮验证数量不足：${repeatQuestsVerified}`);
  assert.equal(landmarkQuestsVerified, 5, `终态日志外路标任务数量变化：${landmarkQuestsVerified}`);
  assert.equal(saveRoundtripsVerified, 24, `跨章节正式存读档往返覆盖数量不足：${saveRoundtripsVerified}`);
});
