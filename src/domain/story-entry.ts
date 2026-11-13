import type { Campaign } from './campaign.ts';
import type { EntityPlacement, WorldMap } from './content.ts';
import type { StoryEvent } from './story-graph.ts';
import { storyExitTargets } from './story-graph.ts';
import type { StoryCondition } from './story-condition.ts';
import { storyReachableMaps } from './story-script.ts';

/** 收集可达脚本时最多遍历的节点数，防止脚本出口成环时无限展开。 */
const MAX_TRAVERSED_NODES = 4000;

/** 条件里引用的任务 id（递归展开 all/any/not）。 */
function conditionQuestIds(condition: StoryCondition | undefined): string[] {
  if (!condition) return [];
  if (condition.type === 'quest') return [condition.quest];
  if (condition.type === 'all' || condition.type === 'any') return condition.conditions.flatMap(conditionQuestIds);
  if (condition.type === 'not') return conditionQuestIds(condition.condition);
  return [];
}

interface LocalStoryScriptsInput {
  campaign: Pick<Campaign, 'events' | 'placements' | 'mapEntryPlacements' | 'quests' | 'scripts'>;
  map: Pick<WorldMap, 'id' | 'entities'>;
  /** 当前地图上已经投影出来的人物；省略时只用静态摆放。 */
  entities?: readonly EntityPlacement[];
  /** 已经完成的剧情事件 id；start 事件全部完成后不再把开场算进本图。 */
  completedEvents?: readonly string[];
  /** 当前会话的任务状态；quest 事件在条件引用的任务已经进行中时可能很快触发。 */
  questStatus?: (id: string) => string;
  /** 本图可能出现的敌人 id，用于归位 battle 事件；不传时不预取 battle 脚本。 */
  enemyIds?: Iterable<string>;
}

/**
 * 这张图上可能触发的剧情脚本。入口加载只阻塞在这里列出的脚本所到达的地图；
 * quest/inventory/choice/event 这类无法静态定位的全局事件由运行时兜底。
 * `quest` 事件在条件引用的任务已经进行中时也算「本图可能出现」：战斗结算把它推进到
 * ready 后就会在这张图上起演，入口加载据此提前备好它的脚本素材。
 */
export function localStoryScripts({ campaign, map, entities = [], completedEvents = [], questStatus, enemyIds }: LocalStoryScriptsInput): string[] {
  const scripts = new Set<string>();
  const local = [
    ...map.entities,
    ...campaign.placements.filter(placement => placement.map === map.id),
    ...(campaign.mapEntryPlacements ?? []).filter(placement => placement.map === map.id),
    ...entities
  ];
  const enemies = new Set(enemyIds ?? []);
  const nearMatches = (event: StoryEvent): boolean => event.near !== undefined && local.some(entity =>
    entity.actor === event.near && (event.nearCharacterId === undefined || (entity.characterId ?? entity.actor) === event.nearCharacterId));
  const actorOnMap = (actor: string | undefined, characterId?: string): boolean => local.some(entity =>
    (actor === undefined || entity.actor === actor) &&
    (characterId === undefined || (entity.characterId ?? entity.actor) === characterId));
  const battleEnemy = (key: string | undefined): string | undefined => {
    if (!key) return undefined;
    if (key.startsWith('defeat:')) return key.slice('defeat:'.length);
    if (key.startsWith('health-below-30:')) return key.slice('health-below-30:'.length);
    return undefined;
  };
  const quests = new Map(campaign.quests.map(quest => [quest.id, quest]));
  const placeHere = (place: { type: string; map?: string; spots?: readonly { map: string }[] } | undefined): boolean =>
    place?.type === 'fixed' ? place.map === map.id
      : place?.type === 'alternatives' ? (place.spots ?? []).some(spot => spot.map === map.id) : false;
  /**
   * 这个任务能不能在这张图上接取、推进或交付。任务事件的条件写的是任务状态，
   * 变化就发生在这里；刷新后事件可能演到别的地图，所以不能只看事件自己到达哪张图。
   */
  const questPlaysHere = (id: string): boolean => {
    const quest = quests.get(id);
    if (!quest) return false;
    if ([quest.places?.available, quest.places?.active, quest.places?.ready].some(placeHere)) return true;
    const giver = (quest.giver !== undefined || quest.giverCharacterId !== undefined) && actorOnMap(quest.giver, quest.giverCharacterId);
    const delivery = (quest.delivery !== undefined || quest.deliveryCharacterId !== undefined) && actorOnMap(quest.delivery, quest.deliveryCharacterId);
    return !!(giver || delivery);
  };

  const completed = new Set(completedEvents);
  for (const event of campaign.events) {
    if (!event.repeat && completed.has(event.id)) continue;
    if (event.source === 'start') {
      scripts.add(event.script);
    } else if (event.source === 'map-entry') {
      if ((event.key === undefined || event.key === map.id) && (event.map === undefined || event.map === map.id)) scripts.add(event.script);
    } else if (event.source === 'region') {
      if (event.map === map.id) scripts.add(event.script);
    } else if (event.source === 'near') {
      if (nearMatches(event)) scripts.add(event.script);
    } else if (event.source === 'interaction') {
      if (event.key === undefined || local.some(entity => entity.actor === event.key)) scripts.add(event.script);
    } else if (event.source === 'battle') {
      const enemy = battleEnemy(event.key);
      if (enemy !== undefined && enemies.has(enemy)) scripts.add(event.script);
    } else if (event.source === 'quest' && questStatus) {
      const ids = conditionQuestIds(event.condition);
      const pending = ids.some(id => {
        const status = questStatus(id);
        return status === 'active' || status === 'ready';
      });
      // 两种都算本图可能出现：剧情会演到这张图；或任务能在这张图上变化（交付/接取/推进），
      // 即使演出会跑到别的地图，也要在进图时把那条链一起装好。
      const reachable = pending && storyReachableMaps(campaign, [event.script]).includes(map.id);
      const relevant = ids.some(id => questStatus(id) !== 'locked' && questPlaysHere(id));
      if (reachable || relevant) scripts.add(event.script);
    }
  }
  for (const entity of local) if (entity.afterInteractScript) scripts.add(entity.afterInteractScript);
  for (const quest of campaign.quests) {
    const giver = (quest.giver !== undefined || quest.giverCharacterId !== undefined) && actorOnMap(quest.giver, quest.giverCharacterId);
    const delivery = (quest.delivery !== undefined || quest.deliveryCharacterId !== undefined) && actorOnMap(quest.delivery, quest.deliveryCharacterId);
    if (!giver && !delivery) continue;
    if (quest.offerScript) scripts.add(quest.offerScript);
    if (quest.completeScript) scripts.add(quest.completeScript);
  }
  return [...scripts];
}

/** 沿 call/分支/选择等控制流展开，返回这些入口会执行到的全部脚本。 */
export function storyReachableScripts(campaign: Pick<Campaign, 'scripts'>, scripts: Iterable<string>): string[] {
  const result = new Set<string>();
  const visited = new Set<string>();
  const queue: { script: string; node: string }[] = [];
  for (const name of scripts) {
    const script = campaign.scripts[name];
    if (script) queue.push({ script: name, node: script.entry });
  }
  while (queue.length) {
    const reference = queue.pop()!;
    const key = `${reference.script}:${reference.node}`;
    if (visited.has(key) || visited.size >= MAX_TRAVERSED_NODES) continue;
    visited.add(key);
    result.add(reference.script);
    const node = campaign.scripts[reference.script]?.nodes.find(candidate => candidate.id === reference.node);
    if (!node) continue;
    for (const target of storyExitTargets(node.exit)) queue.push(target);
  }
  return [...result];
}
