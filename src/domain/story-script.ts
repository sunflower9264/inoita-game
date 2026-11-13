import type { StoryEvent, StoryNode, StoryNodeRef, StoryScript } from './story-graph.ts';
import { storyExitTargets } from './story-graph.ts';

/** 收集可达地图时最多遍历的脚本节点数，防止脚本出口成环时无限展开。 */
const MAX_TRAVERSED_NODES = 4000;

/** Includes branches once; intended for resource collection and authored-action validation. */
export function storyActions(campaign: Pick<CampaignScripts, 'scripts'>): StoryNode['presentation'] {
  return Object.values(campaign.scripts).flatMap(script => script.nodes.flatMap(node => node.presentation));
}

/**
 * 从这些剧情脚本出发，收集控制流上可能切换到的地图。演出中途到达新地图会触发它的进入事件，
 * 所以进入事件的脚本继续展开——走到哪个分支都能算出后面可能用到的地图。
 * 分支与选择按所有出口展开；只读脚本，不执行剧情。
 */
export function storyReachableMaps(
  campaign: Pick<CampaignScripts, 'scripts'> & { events: readonly StoryEvent[] },
  scripts: Iterable<string>, limit = 6,
): string[] {
  const maps = new Map<string, true>();
  const visited = new Set<string>();
  const queue: StoryNodeRef[] = [];
  const enqueueScript = (name: string) => {
    const script = campaign.scripts[name];
    if (script) queue.push({ script: name, node: script.entry });
  };
  const addMap = (map: string) => {
    if (maps.has(map) || maps.size >= limit) return;
    maps.set(map, true);
    for (const event of campaign.events)
      if (event.source === 'map-entry' && (event.key === undefined || event.key === map)
        && (event.map === undefined || event.map === map)) enqueueScript(event.script);
  };
  const addAction = (action: StoryNode['presentation'][number]): void => {
    if (action.type === 'stage') { if (!action.mapFromWorld) addMap(action.map); }
    else if (action.type === 'parallel') action.actions.forEach(addAction);
  };
  for (const name of scripts) enqueueScript(name);
  while (queue.length) {
    const reference = queue.pop()!;
    const key = JSON.stringify(reference);
    if (visited.has(key) || visited.size >= MAX_TRAVERSED_NODES) continue;
    visited.add(key);
    const node = campaign.scripts[reference.script]?.nodes.find(candidate => candidate.id === reference.node);
    if (!node) continue;
    if (node.stage && !node.stage.mapFromWorld) addMap(node.stage.map);
    for (const action of node.presentation) addAction(action);
    for (const command of node.commands) {
      if (command.type === 'travel') addMap(command.destination.map);
      else if (command.type === 'world' && command.command.kind === 'travel') addMap(command.command.destination.map);
    }
    for (const target of storyExitTargets(node.exit)) queue.push(target);
  }
  return [...maps.keys()];
}

interface CampaignScripts { scripts: Record<string, StoryScript> }
