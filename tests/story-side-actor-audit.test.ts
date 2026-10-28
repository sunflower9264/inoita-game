import assert from 'node:assert/strict';
import test from 'node:test';
import {HeadlessStory} from '../src/debug/headless-story.ts';
import {prepareTaskStart} from '../src/debug/story-jump.ts';
import {newStorySession} from '../src/domain/story-class.ts';
import {headlessContent} from './helpers/story-playthrough.ts';

type DebugChoice = {choice: string; value: string; basis: string};
type DebugBattle = {encounter: string; script: string; node: string; result: string; basis: string};
type DebugTask = {
  quest: string;
  play?: {script: string; node?: string; event?: string};
  basis?: {choices?: DebugChoice[]; battles?: DebugBattle[]};
};

test('side and hidden task opening performances resolve a unique actor set', async () => {
  const {campaign,world,items,characterStats,classes,companions,battle} = {
    ...headlessContent,
    characterStats: headlessContent.stats,
    classes: headlessContent.storyClasses,
    battle: headlessContent.battle,
  };
  const groupKind = new Map<string,string>();
  for (const group of campaign.questGroups) for (const id of group.questIds) groupKind.set(id,group.kind);
  const hidden = new Set(campaign.quests.filter(quest => quest.hidden).map(quest => quest.id));
  const isSide = (quest: string) => hidden.has(quest) || groupKind.get(quest) === 'side';
  const tasks = (campaign.debugStory?.tasks ?? []) as DebugTask[];
  const performances = tasks.filter(task => task.play && isSide(task.quest));
  assert.ok(performances.length >= 100, `支线/隐藏开幕演出只有 ${performances.length} 条，审计覆盖不足`);

  const session = newStorySession(campaign,world.actors[campaign.start.actor],classes.classes[0]!,items,
    characterStats,battle,companions);
  const base = session.captureState();
  const story = new HeadlessStory(headlessContent);
  const failures: string[] = [];
  let replayed = 0;
  for (const task of performances) {
    const play = task.play!;
    try {
      session.restoreState(base);
      story.restore(await prepareTaskStart(session,{quest:task.quest}));
      const policies = {forced:{} as Record<string,string>,evidence:{} as Record<string,string>,converged:{} as Record<string,string>};
      for (const choice of task.basis?.choices ?? []) {
        const bucket = choice.basis === 'forced' ? policies.forced
          : choice.basis === 'evidence' ? policies.evidence : policies.converged;
        bucket[choice.choice] = choice.value;
      }
      const battles = task.basis?.battles ?? [];
      const battleDecision = (info: {encounter:string;script:string;node:string}) => {
        const known = battles.find(entry => entry.encounter === info.encounter
          || entry.script === info.script && entry.node === info.node);
        return {result: known?.result ?? 'won', basis: known?.basis ?? 'actor-audit'};
      };
      await story.replayScript(play.script,{node:play.node,eventId:play.event,choices:policies,battle:battleDecision});
      replayed++;
    } catch (error) {
      failures.push(`${task.quest}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failures,[],`支线/隐藏演出回放失败；已回放 ${replayed} 条`);
  assert.equal(replayed,performances.length,`应回放全部 ${performances.length} 条支线/隐藏演出`);
});
