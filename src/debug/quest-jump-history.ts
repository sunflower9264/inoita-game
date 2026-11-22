import type { Campaign } from '../domain/campaign.ts';
import type { TravelDestination } from '../domain/content.ts';
import { deriveQuestJumpHistory, type DerivedHistory, type QuestJumpMode } from './quest-jump-derivation.ts';

/**
 * 调试跳转需要的历史现场。
 *
 * 不再维护第二份游玩顺序：每次按目标任务回溯因果需要的事件、任务交接和世界命令。
 * 与目标无关的区域/进图/近身事件保持未发生，这是调试跳转与完整跑图的有意差异。
 */
export function questJumpHistory(campaign: Campaign, id: string, mode: QuestJumpMode): DerivedHistory {
  return deriveQuestJumpHistory(campaign, id, mode);
}

/** 接取演出可能先把镜头切到另一张图。按那一幕的出场名单找角色在该图的正式摆放。 */
export function prepareIntakeCast(campaign: Campaign, script: string, destination: TravelDestination | undefined,
  history: DerivedHistory): void {
  const sources = [...history.world, ...history.intakeCommands].reverse();
  const placed = new Set<string>();
  for (const node of campaign.scripts[script].nodes) {
    const stages = node.presentation.filter(action => action.type === 'stage');
    if (node.stage) stages.unshift(node.stage);
    for (const stage of stages) for (const actor of stage.cast) {
      if (actor.memberId || actor.enemyId) continue;
      const map = stage.mapFromWorld ? destination?.map : stage.map;
      const source = sources.find(action => action.type === 'world' && action.command.kind === 'place'
        && action.command.entity.map === map && (actor.worldEntityId ? action.command.entity.id === actor.worldEntityId
          : actor.characterId && action.command.entity.characterId === actor.characterId));
      if (source?.type !== 'world' || source.command.kind !== 'place') continue;
      const entity = source.command.entity;
      if (placed.has(entity.id)) continue;
      placed.add(entity.id);
      history.world.push(source);
      const flag = sources.find(action => action.type === 'flag' && action.flag === entity.id);
      if (flag?.type === 'flag' && flag.value !== false) history.world.push(flag);
    }
  }
}

export type { DerivedHistory, QuestJumpMode, ReplayedPlacement } from './quest-jump-derivation.ts';
