import type { StoryGraph, StoryNodeRef } from './story-graph.ts';

export interface StoryPreparationCursor { node: StoryNodeRef; stack: readonly StoryNodeRef[] }

/** 只沿确定路径查找下一个地图，不执行命令或猜测玩家选择。 */
export function nextStoryMap(graph: StoryGraph, cursor: StoryPreparationCursor, currentMap: string): string | undefined {
  let ref = cursor.node;
  const stack = [...cursor.stack];
  const visited = new Set<string>();
  for (let count = 0; count < 1000; count++) {
    const key = JSON.stringify([ref, stack]);
    if (visited.has(key)) return;
    visited.add(key);
    const node = graph.scripts[ref.script]?.nodes.find(node => node.id === ref.node);
    if (!node) return;
    if (node.stage && !node.stage.mapFromWorld && node.stage.map !== currentMap) return node.stage.map;
    for (const action of node.presentation) {
      if (action.type === 'choice' || action.type === 'quest-popup') return;
      if (action.type === 'stage' && !action.mapFromWorld && action.map !== currentMap) return action.map;
    }
    for (const command of node.commands) {
      const destination = command.type === 'travel' ? command.destination
        : command.type === 'world' && command.command.kind === 'travel' ? command.command.destination : undefined;
      if (destination && destination.map !== currentMap) return destination.map;
    }
    switch (node.exit.type) {
      case 'next': ref = node.exit.target; break;
      case 'call': if (stack.length >= 32) return; stack.push(node.exit.then); ref = node.exit.target; break;
      case 'end': { const next = stack.pop(); if (!next) return; ref = next; break; }
      default: return;
    }
  }
}
