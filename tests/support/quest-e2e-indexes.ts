import { readFileSync } from 'node:fs';
import {
  parseBattle,
  parseCampaign,
  parseCharacterStats,
  parseCompanions,
  parseItemCatalog,
  parseShops,
  parseStoryClasses,
  parseWorld,
} from '../../src/application/content-validation.ts';
import type { BattleCatalog } from '../../src/domain/battle.ts';
import type { Campaign, CampaignQuest } from '../../src/domain/campaign.ts';
import type { CharacterStatsCatalog } from '../../src/domain/character-stats.ts';
import type { MapExit, QuestItemSpawn, WorldIndex, WorldMap } from '../../src/domain/content.ts';
import { parseDrops, type DropCatalog } from '../../src/domain/drops.ts';
import type { ItemCatalog } from '../../src/domain/items.ts';
import type { Point } from '../../src/domain/navigation.ts';
import type { CompanionCatalog } from '../../src/domain/party.ts';
import type { ShopCatalog } from '../../src/domain/shop.ts';
import { parseSprings, type SpringCatalog } from '../../src/domain/springs.ts';
import type { StoryClassCatalog } from '../../src/domain/story-class.ts';
import type { StoryCondition } from '../../src/domain/story-condition.ts';
import type { StoryCommand, StoryEvent } from '../../src/domain/story-graph.ts';

export interface QuestHarnessContent {
  campaign: Campaign;
  world: WorldIndex;
  maps: ReadonlyMap<string, WorldMap>;
  items: ItemCatalog;
  stats: CharacterStatsCatalog;
  battle: BattleCatalog;
  storyClasses: StoryClassCatalog;
  companions: CompanionCatalog;
  drops: DropCatalog;
  springs: SpringCatalog;
  shops?: ShopCatalog;
  shopActors?: ReadonlySet<string>;
}

let cachedOfficialContent: QuestHarnessContent | undefined;

/** 读取并校验一次正式内容，供全量 487 任务测试共享只读副本。 */
export function loadOfficialQuestContent(): QuestHarnessContent {
  if (cachedOfficialContent) return cachedOfficialContent;
  const read = (name: string) =>
    JSON.parse(readFileSync(new URL(`../../public/content/${name}.json`, import.meta.url), 'utf8'));
  const campaign = parseCampaign(read('campaign'));
  const world = parseWorld(read('world'));
  const items = parseItemCatalog(read('items'));
  const stats = parseCharacterStats(read('character-stats'));
  const battle = parseBattle(read('battle'));
  const storyClasses = parseStoryClasses(read('story-classes'));
  const companions = parseCompanions(read('companions'));
  const drops = parseDrops(read('drops'), items, battle.enemies.map(enemy => enemy.id));
  const springs = parseSprings(read('springs'));
  const shops = parseShops(read('shops'));
  const shopActors = new Set(Object.keys(shops.shops));
  const maps = new Map<string, WorldMap>(world.maps.map(ref => [ref.id, read(`maps/${ref.id}`) as WorldMap]));
  cachedOfficialContent = { campaign, world, maps, items, stats, battle, storyClasses, companions, drops, springs, shops, shopActors };
  return cachedOfficialContent;
}

export interface CampaignIndexes {
  questById: Map<string, CampaignQuest>;
  groupKindByQuest: Map<string, 'main' | 'side'>;
  choiceEvents: Map<string, StoryEvent[]>;
  scriptQuestCommands: Map<string, Extract<StoryCommand, { type: 'quest' }>['command'][]>;
  scriptHasTrap: Map<string, boolean>;
  eventsCompletingQuest: Map<string, StoryEvent[]>;
  eventsReadyingQuest: Map<string, StoryEvent[]>;
  eventsAcceptingQuest: Map<string, StoryEvent[]>;
}

const indexCache = new WeakMap<Campaign, CampaignIndexes>();

/** 递归遍历 StoryCondition 语法树（不依赖 JSON 字符串正则）。 */
export function walkStoryCondition(
  cond: StoryCondition | undefined,
  visit: (node: StoryCondition, negated: boolean) => void,
  negated = false,
): void {
  if (!cond) return;
  visit(cond, negated);
  switch (cond.type) {
    case 'all':
    case 'any':
      for (const child of cond.conditions) walkStoryCondition(child, visit, negated);
      break;
    case 'not':
      walkStoryCondition(cond.condition, visit, !negated);
      break;
    default:
      break;
  }
}

export function extractChoiceCondition(cond: StoryCondition | undefined): { choice: string; value: string } | undefined {
  let found: { choice: string; value: string } | undefined;
  walkStoryCondition(cond, (node, negated) => {
    if (!found && !negated && node.type === 'choice') {
      found = { choice: node.choice, value: node.value };
    }
  });
  return found;
}

export function extractFlagExpectations(cond: StoryCondition | undefined): Map<string, boolean> {
  const result = new Map<string, boolean>();
  walkStoryCondition(cond, (node, negated) => {
    if (node.type === 'flag') {
      const wanted = (node.value ?? true) !== negated;
      if (!result.has(node.flag)) result.set(node.flag, wanted);
    }
  });
  return result;
}

export function extractQuestStatuses(cond: StoryCondition | undefined): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  walkStoryCondition(cond, (node, negated) => {
    if (!negated && node.type === 'quest') {
      let set = result.get(node.quest);
      if (!set) {
        set = new Set();
        result.set(node.quest, set);
      }
      set.add(node.status);
    }
  });
  return result;
}

export function buildCampaignIndexes(campaign: Campaign): CampaignIndexes {
  const existing = indexCache.get(campaign);
  if (existing) return existing;
  const questById = new Map(campaign.quests.map(q => [q.id, q]));
  const groupKindByQuest = new Map<string, 'main' | 'side'>();
  for (const g of campaign.questGroups) {
    for (const qid of g.questIds) groupKindByQuest.set(qid, g.kind);
  }
  const choiceEvents = new Map<string, StoryEvent[]>();
  for (const ev of campaign.events) {
    if (ev.source !== 'choice') continue;
    const picked = extractChoiceCondition(ev.condition);
    if (picked) {
      const key = `${picked.choice}=${picked.value}`;
      const list = choiceEvents.get(key) ?? [];
      list.push(ev);
      choiceEvents.set(key, list);
    }
  }
  const scriptQuestCommands = new Map<string, Extract<StoryCommand, { type: 'quest' }>['command'][]>();
  const scriptHasTrap = new Map<string, boolean>();
  for (const [sid, script] of Object.entries(campaign.scripts)) {
    const qcmds: Extract<StoryCommand, { type: 'quest' }>['command'][] = [];
    let trap = false;
    for (const node of script.nodes) {
      for (const cmd of node.commands) {
        if (cmd.type === 'quest') qcmds.push(cmd.command);
        if (cmd.type === 'world' && cmd.command.kind === 'party-buff' && cmd.command.buff === 'story-trap') trap = true;
      }
    }
    scriptQuestCommands.set(sid, qcmds);
    scriptHasTrap.set(sid, trap);
  }
  const eventsCompletingQuest = new Map<string, StoryEvent[]>();
  const eventsReadyingQuest = new Map<string, StoryEvent[]>();
  const eventsAcceptingQuest = new Map<string, StoryEvent[]>();
  const push = (map: Map<string, StoryEvent[]>, qid: string, ev: StoryEvent) => {
    const list = map.get(qid) ?? [];
    if (!list.includes(ev)) list.push(ev);
    map.set(qid, list);
  };
  for (const ev of campaign.events) {
    const direct = scriptQuestCommands.get(ev.script) ?? [];
    const viaChoice: Extract<StoryCommand, { type: 'quest' }>['command'][] = [];
    for (const node of campaign.scripts[ev.script]?.nodes ?? []) {
      if (node.exit.type === 'choice') {
        for (const opt of Object.keys(node.exit.cases)) {
          for (const cev of choiceEvents.get(`${node.exit.choice}=${opt}`) ?? []) {
            viaChoice.push(...(scriptQuestCommands.get(cev.script) ?? []));
          }
        }
      }
    }
    for (const qc of [...direct, ...viaChoice]) {
      if ('quest' in qc) {
        if (qc.type === 'complete' || qc.type === 'script-complete') push(eventsCompletingQuest, qc.quest, ev);
        else if (qc.type === 'script-ready') push(eventsReadyingQuest, qc.quest, ev);
        else if (qc.type === 'accept') push(eventsAcceptingQuest, qc.quest, ev);
      }
    }
  }
  const built: CampaignIndexes = {
    questById,
    groupKindByQuest,
    choiceEvents,
    scriptQuestCommands,
    scriptHasTrap,
    eventsCompletingQuest,
    eventsReadyingQuest,
    eventsAcceptingQuest,
  };
  indexCache.set(campaign, built);
  return built;
}

export interface IncomingMapEntrance {
  fromMap: string;
  exit: MapExit;
  point: Point;
}

export interface StoryEntryLanding {
  eventId: string;
  point: Point;
}

export interface ContentSourceIndexes {
  mapEntrances: Map<string, Point[]>;
  mapIncomingExits: Map<string, IncomingMapEntrance[]>;
  exitRuleByKey: Map<string, StoryCondition>;
  /** 忽略出口锁后，每张地图沿静态出口有向可达的全部地图集合（用于区分“同岛出口上锁”与“真跨岛”）。 */
  staticReachableByMap: Map<string, ReadonlySet<string>>;
  /** 存在正式剧情 stage / travel 切图入口可达的地图集合（用于核验跨岛目标岛确有正式剧情桥接）。 */
  storyBridgeMaps: ReadonlySet<string>;
  /** 正式剧情事件终态把主角落点放到某地图的坐标清单（仅限非 mapFromWorld 的正式剧情切图/传送，供已完成剧情桥接地图作为合法入口）。 */
  storyEntryLandingsByMap: Map<string, StoryEntryLanding[]>;
  mapsByEnemy: Map<string, string[]>;
  mapsByQuestItemKey: Map<string, { mapId: string; spawn: QuestItemSpawn }[]>;
  mapsByItemSpawn: Map<string, { mapId: string; spawn: QuestItemSpawn }[]>;
  mapsByChar: Map<string, string[]>;
  mapsByActor: Map<string, string[]>;
  droppersByQuestItem: Map<string, string[]>;
  eventsGivingItem: Map<string, StoryEvent[]>;
  questsRewardingItem: Map<string, CampaignQuest[]>;
  eventsSettingFlag: Map<string, StoryEvent[]>;
  choiceParentEvents: Map<string, StoryEvent[]>;
  eventsSpawningEnemy: Map<string, StoryEvent[]>;
  eventsPlacingChar: Map<string, StoryEvent[]>;
  eventsHidingActorOnMap: Map<string, StoryEvent[]>;
  bfsCache: Map<string, Point[]>;
}

const sourceIndexCache = new WeakMap<QuestHarnessContent, ContentSourceIndexes>();

export function buildContentSourceIndexes(content: QuestHarnessContent): ContentSourceIndexes {
  const existing = sourceIndexCache.get(content);
  if (existing) return existing;

  const pushUnique = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key) ?? [];
    if (!list.includes(value)) list.push(value);
    map.set(key, list);
  };

  const mapEntrances = new Map<string, Point[]>();
  const mapIncomingExits = new Map<string, IncomingMapEntrance[]>();
  for (const m of content.maps.values()) {
    mapEntrances.set(m.id, []);
    mapIncomingExits.set(m.id, []);
  }
  mapEntrances.get(content.campaign.start.map)?.push({ x: content.campaign.start.x, y: content.campaign.start.y });
  for (const src of content.maps.values()) {
    for (const ex of src.exits) {
      const point = { x: ex.spawn.x, y: ex.spawn.y };
      mapEntrances.get(ex.destination)?.push(point);
      mapIncomingExits.get(ex.destination)?.push({ fromMap: src.id, exit: ex, point });
    }
  }

  const exitRuleByKey = new Map<string, StoryCondition>();
  for (const rule of content.campaign.exitRules ?? []) {
    exitRuleByKey.set(`${rule.map}\0${rule.id}`, rule.condition);
  }

  const staticAdj = new Map<string, string[]>();
  for (const m of content.maps.values()) {
    const dests: string[] = [];
    for (const ex of m.exits) {
      if (content.maps.has(ex.destination) && !dests.includes(ex.destination)) dests.push(ex.destination);
    }
    staticAdj.set(m.id, dests);
  }
  const staticReachableByMap = new Map<string, ReadonlySet<string>>();
  for (const startId of content.maps.keys()) {
    const seen = new Set<string>([startId]);
    const queue = [startId];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]!;
      for (const nxt of staticAdj.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          queue.push(nxt);
        }
      }
    }
    staticReachableByMap.set(startId, seen);
  }

  const storyBridgeMaps = new Set<string>([content.campaign.start.map]);
  for (const script of Object.values(content.campaign.scripts)) {
    for (const node of script.nodes) {
      if (node.stage && !node.stage.mapFromWorld && content.maps.has(node.stage.map)) {
        storyBridgeMaps.add(node.stage.map);
      }
      for (const act of node.presentation) {
        if (act.type === 'stage' && !act.mapFromWorld && content.maps.has(act.map)) {
          storyBridgeMaps.add(act.map);
        }
      }
      for (const cmd of node.commands) {
        if (cmd.type === 'travel' && content.maps.has(cmd.destination.map)) {
          storyBridgeMaps.add(cmd.destination.map);
        } else if (cmd.type === 'world' && cmd.command.kind === 'travel' && content.maps.has(cmd.command.destination.map)) {
          storyBridgeMaps.add(cmd.command.destination.map);
        }
      }
    }
  }

  const storyEntryLandingsByMap = new Map<string, StoryEntryLanding[]>();
  const recordStoryLanding = (mapId: string, eventId: string, point: Point) => {
    const list = storyEntryLandingsByMap.get(mapId) ?? [];
    if (!list.some(entry => entry.eventId === eventId && entry.point.x === point.x && entry.point.y === point.y)) {
      list.push({ eventId, point });
      storyEntryLandingsByMap.set(mapId, list);
    }
  };
  for (const ev of content.campaign.events) {
    const startScript = content.campaign.scripts[ev.script];
    if (!startScript) continue;
    type Landing = { map: string; x: number; y: number } | undefined;
    const seen = new Set<string>();
    const stack: { scriptId: string; nodeId: string; landing: Landing; returnTo?: { script: string; node: string } }[] = [
      { scriptId: ev.script, nodeId: startScript.entry, landing: undefined },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const landingKey = frame.landing ? `${frame.landing.map}@${frame.landing.x},${frame.landing.y}` : '';
      const returnKey = frame.returnTo ? `${frame.returnTo.script}#${frame.returnTo.node}` : '';
      const stateKey = `${frame.scriptId}#${frame.nodeId}|${landingKey}|${returnKey}`;
      if (seen.has(stateKey)) continue;
      seen.add(stateKey);
      const script = content.campaign.scripts[frame.scriptId];
      const node = script?.nodes.find(n => n.id === frame.nodeId);
      if (!node) continue;
      let landing: Landing = frame.landing;
      if (node.stage && !node.stage.mapFromWorld && content.maps.has(node.stage.map)) {
        landing = { map: node.stage.map, x: node.stage.x, y: node.stage.y };
      }
      for (const act of node.presentation) {
        if (act.type === 'stage' && !act.mapFromWorld && content.maps.has(act.map)) {
          landing = { map: act.map, x: act.x, y: act.y };
        } else if (act.type === 'walk' && act.target === 'player' && landing) {
          landing = { map: landing.map, x: act.x, y: act.y };
        }
      }
      for (const cmd of node.commands) {
        if (cmd.type === 'travel' && content.maps.has(cmd.destination.map)) {
          landing = { map: cmd.destination.map, x: cmd.destination.x, y: cmd.destination.y };
        } else if (cmd.type === 'world' && cmd.command.kind === 'travel' && content.maps.has(cmd.command.destination.map)) {
          landing = { map: cmd.command.destination.map, x: cmd.command.destination.x, y: cmd.command.destination.y };
        }
      }
      const ex = node.exit;
      if (ex.type === 'next') {
        stack.push({ scriptId: ex.target.script, nodeId: ex.target.node, landing, returnTo: frame.returnTo });
      } else if (ex.type === 'branch') {
        stack.push({ scriptId: ex.then.script, nodeId: ex.then.node, landing, returnTo: frame.returnTo });
        stack.push({ scriptId: ex.otherwise.script, nodeId: ex.otherwise.node, landing, returnTo: frame.returnTo });
      } else if (ex.type === 'choice') {
        for (const target of Object.values(ex.cases)) {
          stack.push({ scriptId: target.script, nodeId: target.node, landing, returnTo: frame.returnTo });
        }
      } else if (ex.type === 'call') {
        stack.push({ scriptId: ex.target.script, nodeId: ex.target.node, landing, returnTo: ex.then });
      } else if (ex.type === 'end' || ex.type === 'defer') {
        if (ex.type === 'end' && frame.returnTo) {
          stack.push({ scriptId: frame.returnTo.script, nodeId: frame.returnTo.node, landing });
        } else if (landing) {
          recordStoryLanding(landing.map, ev.id, { x: landing.x, y: landing.y });
        }
      }
    }
  }

  const mapsByEnemy = new Map<string, string[]>();
  const mapsByQuestItemKey = new Map<string, { mapId: string; spawn: QuestItemSpawn }[]>();
  const mapsByItemSpawn = new Map<string, { mapId: string; spawn: QuestItemSpawn }[]>();
  const mapsByChar = new Map<string, string[]>();
  const mapsByActor = new Map<string, string[]>();

  for (const m of content.maps.values()) {
    for (const sp of m.enemySpawns ?? []) pushUnique(mapsByEnemy, sp.enemyId, m.id);
    for (const qis of m.questItemSpawns ?? []) {
      const entry = { mapId: m.id, spawn: qis };
      const qKey = `${qis.quest}\0${qis.item}`;
      const qList = mapsByQuestItemKey.get(qKey) ?? [];
      qList.push(entry);
      mapsByQuestItemKey.set(qKey, qList);
      const iList = mapsByItemSpawn.get(qis.item) ?? [];
      iList.push(entry);
      mapsByItemSpawn.set(qis.item, iList);
    }
    for (const e of m.entities) {
      if (e.characterId) pushUnique(mapsByChar, e.characterId, m.id);
      pushUnique(mapsByActor, e.actor, m.id);
      if (e.objective) pushUnique(mapsByActor, e.objective, m.id);
    }
  }
  for (const ep of content.campaign.enemyPlacements ?? []) pushUnique(mapsByEnemy, ep.enemyId, ep.map);
  for (const p of [...content.campaign.placements, ...(content.campaign.mapEntryPlacements ?? [])]) {
    if (p.characterId) pushUnique(mapsByChar, p.characterId, p.map);
    pushUnique(mapsByActor, p.actor, p.map);
    if (p.objective) pushUnique(mapsByActor, p.objective, p.map);
  }

  const droppersByQuestItem = new Map<string, string[]>();
  for (const [enemyId, rules] of Object.entries(content.drops.questItems)) {
    for (const rule of rules) pushUnique(droppersByQuestItem, rule.item, enemyId);
  }

  const eventsGivingItem = new Map<string, StoryEvent[]>();
  const eventsSettingFlag = new Map<string, StoryEvent[]>();
  const choiceParentEvents = new Map<string, StoryEvent[]>();
  const eventsSpawningEnemy = new Map<string, StoryEvent[]>();
  const eventsPlacingChar = new Map<string, StoryEvent[]>();
  const eventsHidingActorOnMap = new Map<string, StoryEvent[]>();
  for (const ev of content.campaign.events) {
    const script = content.campaign.scripts[ev.script];
    for (const node of script?.nodes ?? []) {
      if (node.exit.type === 'choice') pushUnique(choiceParentEvents, node.exit.choice, ev);
      if (node.exit.type === 'waitEncounter') {
        for (const sp of node.exit.encounter.spawns) pushUnique(eventsSpawningEnemy, sp.enemyId, ev);
      }
      for (const cmd of node.commands) {
        if (cmd.type === 'item-give' || cmd.type === 'item-drop') pushUnique(eventsGivingItem, cmd.item, ev);
        if (cmd.type === 'flag') {
          pushUnique(eventsSettingFlag, `${cmd.flag}=${cmd.value ?? true}`, ev);
          const locMatch = /^quest-npc-located-(npc-\d+)$/.exec(cmd.flag);
          if (locMatch && (cmd.value ?? true)) pushUnique(eventsPlacingChar, locMatch[1]!, ev);
        }
        if (cmd.type === 'world' && cmd.command.kind === 'flag') {
          pushUnique(eventsSettingFlag, `${cmd.command.id}=${cmd.command.value}`, ev);
          const locMatch = /^quest-npc-located-(npc-\d+)$/.exec(cmd.command.id);
          if (locMatch && cmd.command.value) pushUnique(eventsPlacingChar, locMatch[1]!, ev);
        }
        if (cmd.type === 'encounter') {
          for (const sp of cmd.encounter.spawns) pushUnique(eventsSpawningEnemy, sp.enemyId, ev);
        }
        if (cmd.type === 'world' && cmd.command.kind === 'place') {
          const ent = cmd.command.entity;
          if (ent.characterId) {
            pushUnique(mapsByChar, ent.characterId, ent.map);
            if (cmd.command.scope !== 'visit') pushUnique(eventsPlacingChar, ent.characterId, ev);
          }
          if (ent.actor) pushUnique(mapsByActor, ent.actor, ent.map);
        }
        if (cmd.type === 'world' && cmd.command.kind === 'enemy-location' && cmd.command.location) {
          pushUnique(mapsByEnemy, cmd.command.enemyId, cmd.command.location.map);
          pushUnique(eventsSpawningEnemy, cmd.command.enemyId, ev);
        }
        if (cmd.type === 'world' && cmd.command.kind === 'enemy-availability' && cmd.command.available) {
          pushUnique(eventsSpawningEnemy, cmd.command.enemyId, ev);
        }
        if (cmd.type === 'world' && cmd.command.kind === 'actor-visibility' && !cmd.command.visible) {
          pushUnique(eventsHidingActorOnMap, `${cmd.command.map}\0${cmd.command.characterId ?? cmd.command.actor}`, ev);
        }
      }
    }
  }

  const questsRewardingItem = new Map<string, CampaignQuest[]>();
  for (const q of content.campaign.quests) {
    for (const reward of q.rewards?.items ?? []) pushUnique(questsRewardingItem, reward.item, q);
  }

  const built: ContentSourceIndexes = {
    mapEntrances,
    mapIncomingExits,
    exitRuleByKey,
    staticReachableByMap,
    storyBridgeMaps,
    storyEntryLandingsByMap,
    mapsByEnemy,
    mapsByQuestItemKey,
    mapsByItemSpawn,
    mapsByChar,
    mapsByActor,
    droppersByQuestItem,
    eventsGivingItem,
    questsRewardingItem,
    eventsSettingFlag,
    choiceParentEvents,
    eventsSpawningEnemy,
    eventsPlacingChar,
    eventsHidingActorOnMap,
    bfsCache: new Map(),
  };
  sourceIndexCache.set(content, built);
  return built;
}
