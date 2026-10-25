import type { SkillAction, SkillEvent } from './battle.ts';
import { needsTarget, skillEffectNames, skillSoundNames, skillSummonNames } from './skill-action.ts';

/**
 * 构建期把技能动作编译成运行时 IR。
 *
 * 不改变 events/combatUnits/transition 的结构，只把运行时每次都要算的东西
 * 预先写进可选字段；源 JSON 没有这些字段时，skill-action.ts 仍走旧计算。
 */
export function compileSkillAction(action: SkillAction): SkillAction {
  const compiled: SkillAction = {
    ...action,
    requiresTarget: action.requiresTarget ?? needsTarget(action),
    effectNames: skillEffectNames(action),
    soundNames: skillSoundNames(action),
    summonNames: skillSummonNames(action)
  };
  if (!action.repeat) compiled.eventFrames = eventFrames(action.events);
  return compiled;
}

/** 非 repeat 动作的帧索引；spawn 事件按 [frame, until) 展开，和 skillEvents 语义一致。 */
export function eventFrames(events: readonly SkillEvent[]): Record<string, number[]> {
  const frames = new Map<number, number[]>();
  events.forEach((event, index) => {
    if (event.kind === 'spawn') {
      for (let frame = event.frame; frame < event.until; frame++) {
        const list = frames.get(frame) ?? [];
        list.push(index);
        frames.set(frame, list);
      }
      return;
    }
    const list = frames.get(event.frame) ?? [];
    list.push(index);
    frames.set(event.frame, list);
  });
  return Object.fromEntries([...frames.entries()].sort((left, right) => left[0] - right[0])
    .map(([frame, indices]) => [String(frame), indices]));
}
