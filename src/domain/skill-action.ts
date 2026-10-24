import {buffEffectNames} from './buff-effects.ts';
import type { SkillAction, SkillEvent } from './battle.ts';

/** 选敌方式里对敌的那几种；其余是自己、队友或治疗目标。 */
const ENEMY_TARGETS: readonly string[] = ['current', 'enemy', 'area', 'target-area'];

/** 动作里所有「执行动作单元」的事件携带的触发项。 */
export function actionCues(action: SkillAction) {
  return action.events.flatMap(event => event.kind === 'units' ? event.cues : []);
}

/** 这个动作引用到的全部特效名，收集资源和校验都用同一份遍历。 */
export function skillEffectNames(action: SkillAction): string[] {
  const names = new Set<string>();
  for (const event of action.events) {
    if (event.kind === 'units') {
      for (const cue of event.cues) for (const visual of cue.effects) names.add(visual.effect);
      for (const visual of event.dispatch?.casterEffects??[]) names.add(visual.effect);
    }
    else if (event.kind === 'screen'||event.kind==='capture-targets'||event.kind==='feedback') continue;
    else if (event.kind === 'summon') {
      names.add(event.effect);
      for(const visual of event.dispatch?.casterEffects??[])names.add(visual.effect);
    }
    else if (event.kind === 'spawn'||event.kind==='captured-effect') names.add(event.effect);
    else if ('effects' in event) for (const visual of event.effects) names.add(visual.effect);
    else names.add(event.effect.effect);
  }
  for(const visual of action.transition?.missEffects??[])names.add(visual.effect);
  for(const unit of action.combatUnits??[]){
    for(const visual of unit.effect==='summon'?unit.appearanceEffects??[]:[])names.add(visual.effect);
    if(unit.effect==='buff')for(const rank of unit.ranks){
      for(const name of buffEffectNames(rank.effect))names.add(name);
    }
  }
  if (action.transition?.casterStrikes?.effect) names.add(action.transition.casterStrikes.effect);
  if (action.transition?.actionEffect) names.add(action.transition.actionEffect);
  if (action.transition?.effect) names.add(action.transition.effect);
  return [...names];
}

/**
 * 这个动作会触发的全部音效名，对应运行时的三个触发点：
 * 动作单元的触发项音效、派发收尾音效、时间轴反馈音效。
 *
 * 三者都只由当前操控的施法者触发，所以预加载只需覆盖玩家能操控的角色。
 */
export function skillSoundNames(action: SkillAction): string[] {
  const names = new Set<string>();
  for (const event of action.events) {
    if (event.kind === 'units') {
      for (const cue of event.cues) if (cue.sound) names.add(cue.sound);
      if (event.dispatch?.sound) names.add(event.dispatch.sound);
    }
    else if (event.kind === 'summon') { if (event.dispatch?.sound) names.add(event.dispatch.sound); }
    else if (event.kind === 'feedback') { if (event.sound) names.add(event.sound); }
  }
  return [...names];
}

/** 召唤只收集外观资源，不递归加载召唤物自身的战斗能力。 */
export function skillSummonNames(action:SkillAction):string[]{
  return [...new Set(action.events.flatMap(event=>event.kind==='summon'?event.creatures.map(creature=>creature.enemyId):[]))];
}

/**
 * 技能是否需要敌人站位。
 *
 * 优先读取独立的施放条件；省略时按具有正数范围的对敌触发项推断。
 * 纯自身强化的技能（例如黑暗契约）可以在没有敌人时施放。
 */
export function needsTarget(action: SkillAction): boolean {
  if(action.requiresTarget!==undefined)return action.requiresTarget;
  return actionCues(action).some(cue => ENEMY_TARGETS.includes(cue.target) && cue.targetRangePx > 0);
}

/**
 * 这一逻辑帧要执行的事件，按原版顺序排列。
 *
 * 事件按帧号去重由战斗控制器负责：它从上一个已执行帧往后逐帧补发，
 * 同一帧只通知一次，所以动画回调跳帧也不会把事件放两遍。
 */
export function skillEvents(action: SkillAction, frame: number): SkillEvent[] {
  return action.events.filter(event => event.kind==='spawn' ? frame>=event.frame&&frame<event.until : event.frame===frame);
}

/** 把原版发射后的帧号归零展开为连续序列；最后一次归零后完整播放收尾。 */
export function skillSequence(action: SkillAction, level: number, clipFrames: number): number[] {
  const repeat = action.repeat;
  const repeatedFrames = repeat ? repeat.restartAfterFrame * repeatCount(action, level) : 0;
  return Array.from({ length: repeatedFrames + clipFrames }, (_, frame) =>
    frame < repeatedFrames ? frame % repeat!.restartAfterFrame : frame - repeatedFrames);
}

/** 本次连续施放在哪一击停止归零；动画从该击所在片段的当前帧继续收尾。 */
export interface SkillRepeatState { stoppedAtFrame?: number }

export function settleSkillRepeat(action: SkillAction, frame: number, level: number,
  targetAlive: boolean, state: SkillRepeatState): void {
  const repeat = action.repeat;
  if (!repeat?.requiresLivingTarget || state.stoppedAtFrame !== undefined || targetAlive) return;
  if (frame > 0 && frame % repeat.restartAfterFrame === 0 && frame <= repeat.restartAfterFrame * repeatCount(action, level))
    state.stoppedAtFrame = frame;
}

/** 从预展开的最长序列跳到当前片段收尾时，应略过的动画条目数。 */
export function skillRepeatSkippedFrames(action: SkillAction, level: number, state?: SkillRepeatState): number {
  if (state?.stoppedAtFrame === undefined || !action.repeat) return 0;
  return action.repeat.restartAfterFrame * (repeatCount(action, level) + 1) - state.stoppedAtFrame;
}

/** 以整次施放的递增帧号取事件，动画回到起手姿势时也不会重复或漏发。 */
export function skillPlaybackEvents(action: SkillAction, frame: number, level = 1, state?: SkillRepeatState): SkillEvent[] {
  const repeat = action.repeat;
  if (!repeat) return skillEvents(action, frame);
  if (state?.stoppedAtFrame !== undefined) {
    const localFrame = frame - state.stoppedAtFrame + repeat.restartAfterFrame;
    return action.events.filter(event => event.kind === 'units' ? frame === state.stoppedAtFrame :
      event.kind === 'spawn' ? localFrame >= event.frame && localFrame < event.until : event.frame === localFrame);
  }
  const count = repeatCount(action, level);
  const events = action.events.filter(event => {
    if (repeat.requiresLivingTarget && event.frame === 0 && frame === count * repeat.restartAfterFrame) return true;
    if (event.frame > repeat.restartAfterFrame) return frame === count * repeat.restartAfterFrame + event.frame;
    const elapsed = frame - event.frame;
    return elapsed >= 0 && elapsed % repeat.restartAfterFrame === 0 && elapsed / repeat.restartAfterFrame < count;
  });
  return repeat.requiresLivingTarget ? events.sort((a, b) => Number(b.kind === 'units') - Number(a.kind === 'units')) : events;
}

function repeatCount(action: SkillAction, level: number): number {
  const count = action.repeat?.countByLevel[level - 1];
  if (!Number.isInteger(level) || count === undefined) throw new Error(`技能重播缺少等级 ${level} 的次数`);
  return count;
}
