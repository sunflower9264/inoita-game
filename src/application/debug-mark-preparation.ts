import { DEBUG_MARK_VERSION, type DebugMark } from '../debug/debug-marks.ts';
import { newStorySession } from '../domain/story-class.ts';
import type { SavedGameContent } from './saved-game.ts';
import { prepareDebugWorld } from './debug-world.ts';

/** 隔离校验正文及任务返回点；异常不触发当前会话订阅，也不取消当前剧情。 */
export function prepareDebugMark(value: DebugMark, content: SavedGameContent): DebugMark {
  const mark = structuredClone(value);
  const selected = content.storyClasses.classes.find(entry => entry.id === mark.session?.classId);
  if (mark.version !== DEBUG_MARK_VERSION || !selected || !mark.summary?.name || mark.summary.classId !== selected.id)
    throw new Error('调试标记角色或摘要无效');
  const candidate = newStorySession(content.campaign, content.world.actors[content.campaign.start.actor], selected,
    content.items, content.characterStats, content.battleCatalog, content.companions);
  if (mark.taskReturn) {
    if (!content.campaign.quests.some(quest => quest.id === mark.taskReturn!.quest)) throw new Error('调试标记任务返回点无效');
    candidate.restoreState(mark.taskReturn.session);
    if (mark.taskReturn.world !== undefined)
      mark.taskReturn.world = prepareDebugWorld(mark.taskReturn.world, { ...content, session: candidate });
  }
  candidate.restoreState(mark.session);
  mark.session = candidate.captureState();
  if (mark.world !== undefined) mark.world = prepareDebugWorld(mark.world, { ...content, session: candidate });
  return mark;
}
