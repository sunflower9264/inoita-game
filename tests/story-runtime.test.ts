import test from 'node:test';
import { stageSnapshot } from './helpers/story-stage.ts';
import assert from 'node:assert/strict';
import { StoryExecutionBudgetError, StoryRuntime, type StoryRuntimePort, type StoryRuntimeSnapshot, type StoryNodeCommit } from '../src/domain/story-runtime.ts';
import {nextStoryMap} from '../src/domain/story-preparation.ts';
import {validateStoryPerformance} from '../src/application/story-performance-validation.ts';
import type {Campaign} from '../src/domain/campaign.ts';
import type { StoryGraph, StoryNode } from '../src/domain/story-graph.ts';
const node = (id: string, exit: StoryNode['exit'] = { type: 'end' }, money = 0): StoryNode => ({ id, presentation: [], commands: money ? [{ type: 'item-give', item: 'coin', quantity: money }] : [], exit });
const graph = (nodes: StoryNode[]): StoryGraph => ({ version: 2, scripts: { main: { entry: nodes[0].id, nodes } }, events: [{ id: 'intro', source: 'map-entry', map: 'camp', script: 'main' }] });
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('players share immutable story definitions while progress and restoration stay independent', async () => {
  const data = graph([node('first', { type: 'end' }, 3)]);
  const first = harness(data), second = harness(data);
  const prepared: StoryNode[] = [];
  first.port.prepare = second.port.prepare = async value => { prepared.push(value); };
  await first.runtime.dispatch({ id: 'enter', source: 'map-entry', sequence: 1, map: 'camp' });
  assert.equal(first.balance(), 3);
  assert.equal(second.runtime.snapshot().completedEvents.length, 0);
  await second.runtime.dispatch({ id: 'enter', source: 'map-entry', sequence: 1, map: 'camp' });
  assert.equal(second.balance(), 3);
  assert.equal(prepared[0], prepared[1]);
  assert.notEqual(prepared[0], data.scripts.main.nodes[0]);
  assert.equal(Object.isFrozen(prepared[0].commands), true);
  assert.throws(() => { prepared[0].id = 'corrupted'; }, TypeError);
  const validator = harness(data);
  validator.runtime.restore(first.runtime.snapshot());
  assert.deepEqual(validator.runtime.snapshot(), first.runtime.snapshot());
});
function harness(data: StoryGraph) {
  let balance = 0, captured = 0, rolledBack = 0, checkpoint: StoryRuntimeSnapshot | undefined;
  const played: string[] = [], commits: StoryNodeCommit[] = [], locks: boolean[] = [];
  const port: StoryRuntimePort = {
    async prepare() {}, capture() { captured++; return balance; },
    async present(action) { played.push(action.id); return {}; }, async finish() {},
    apply(commit) { for (const command of commit.commands) if (command.type === 'item-give') balance += command.quantity; },
    commit(commit) { checkpoint = structuredClone(commit.checkpoint); commits.push(commit); },
    rollback(snapshot) { rolledBack++; balance = snapshot as number; }, evaluate(condition) { return condition.type === 'always' && condition.value; },
    onBusy(value) { locks.push(value); }
  };
  const runtime = new StoryRuntime(data, port);
  return { runtime, port, played, commits, locks, balance: () => balance, earn: (value: number) => { balance += value; },
    captured: () => captured, rolledBack: () => rolledBack, checkpoint: () => checkpoint };
}
test('failed finish leaves the event incomplete and resumes without rechecking its trigger', async () => {
  const h = harness(graph([node('one', { type: 'end' }, 3)]));
  h.port.finish = async () => { throw new Error('finish failed'); };
  await assert.rejects(h.runtime.dispatch({ id: 'visit:1', sequence: 1, source: 'map-entry', map: 'camp' }), /finish failed/);
  assert.equal(h.balance(), 0); assert.equal(h.runtime.eventStatus('intro'), 'running'); assert.equal(h.rolledBack(), 1);
  h.port.finish = async () => {}; h.port.evaluate = () => false;
  assert.equal(await h.runtime.resume(), true); assert.equal(h.balance(), 3); assert.equal(h.runtime.eventStatus('intro'), 'completed');
});
test('committed rewards survive a failed following popup and are not granted again', async () => {
  const h = harness(graph([node('award', { type: 'next', target: { script: 'main', node: 'popup' } }, 9), node('popup')]));
  h.port.present = async action => { h.played.push(action.id); if (action.id === 'popup') throw new Error('popup failed'); return {}; };
  await assert.rejects(h.runtime.start('main'), /popup failed/); assert.equal(h.balance(), 9);
  assert.equal(h.runtime.snapshot().runs[0].cursor.node, 'popup');
  h.port.present = async () => ({}); await h.runtime.resume(); assert.equal(h.balance(), 9);
});
test('node commit failure rolls back commands and preserves the stable cursor', async () => {
  const h = harness(graph([node('one', { type: 'end' }, 5)]));
  h.port.commit = () => { h.earn(5); throw new Error('commit failed'); };
  await assert.rejects(h.runtime.start('main'), /commit failed/);
  assert.equal(h.balance(), 0); assert.equal(h.runtime.snapshot().runs[0].status, 'running'); assert.equal(h.rolledBack(), 1);
});
test('same-map events drain by priority and re-evaluate conditions after each commit', async () => {
  const data = graph([node('first', { type: 'end' }, 2)]);
  data.scripts.second = { entry: 'second', nodes: [node('second')] };
  data.events = [{ id: 'second', source: 'map-entry', script: 'second', condition: { type: 'always', value: true } }, { id: 'first', source: 'map-entry', script: 'main', priority: 5 }];
  const h = harness(data); h.port.evaluate = () => h.balance() === 2;
  assert.equal(await h.runtime.dispatch({ id: 'visit:1', sequence: 1, source: 'map-entry', map: 'camp' }), true);
  assert.deepEqual(h.played, ['first', 'second']); assert.deepEqual(h.locks, [true, false]);
});
test('defer suppresses one occurrence and a new interaction retries the optional event', async () => {
  const data = graph([node('later', { type: 'defer' })]); data.events[0].source = 'interaction'; delete data.events[0].map;
  const h = harness(data), occurrence = { id: 'touch:1', sequence: 1, source: 'interaction' as const };
  await h.runtime.dispatch(occurrence); assert.equal(h.runtime.eventStatus('intro'), 'idle');
  assert.equal(await h.runtime.dispatch(occurrence), false);
  assert.equal(await h.runtime.dispatch({ ...occurrence, id: 'touch:2', sequence: 2 }), true); assert.equal(h.played.length, 2);
});
test('repeat events cannot settle twice for one occurrence but allow a new occurrence', async () => {
  const data = graph([node('award', { type: 'end' }, 4)]); data.events[0].repeat = true;
  const h = harness(data), occurrence = { id: 'visit:1', sequence: 1, source: 'map-entry' as const, map: 'camp' };
  await h.runtime.dispatch(occurrence); await h.runtime.dispatch(occurrence); assert.equal(h.balance(), 4);
  await h.runtime.dispatch({ ...occurrence, id: 'visit:2', sequence: 2 }); assert.equal(h.balance(), 8);
});
test('waiting encounters release the director and outcome callbacks are deduplicated', async () => {
  const data = graph([node('battle', { type: 'waitEncounter', encounter: { id: 'guards', map: 'castle', status: 'prepared', spawns: [] }, outcomes: { won: { script: 'main', node: 'victory' } } }), node('victory', { type: 'end' }, 7)]);
  const h = harness(data); await h.runtime.start('main', 'intro');
  assert.equal(h.runtime.busy, false); assert.equal(h.runtime.eventStatus('intro'), 'waiting');
  const encounter = h.runtime.snapshot().runs[0].waiting!.encounter;
  const committedEncounter = h.commits[0].commands.find(command => command.type === 'encounter')!;
  assert.equal(committedEncounter.type, 'encounter'); if (committedEncounter.type === 'encounter') assert.equal(committedEncounter.encounter.id, encounter);
  await h.runtime.encounterResult(encounter, 'won', 'death:1'); assert.equal(h.balance(), 7);
  assert.equal(await h.runtime.encounterResult(encounter, 'won', 'death:1'), false); assert.equal(h.balance(), 7);
});
test('battle earnings survive failed continuation and resume from the post-battle node', async () => {
  const h = harness(graph([node('battle', { type: 'waitEncounter', encounter: { id: 'boss', map: 'castle', status: 'prepared', spawns: [] }, outcomes: { won: { script: 'main', node: 'after' } } }), node('after')]));
  await h.runtime.start('main'); h.earn(11);
  h.port.present = async () => { h.earn(100); throw new Error('resource failed'); };
  await assert.rejects(h.runtime.encounterResult(h.runtime.snapshot().runs[0].waiting!.encounter, 'won', 'result:1'), /resource failed/);
  assert.equal(h.balance(), 11); assert.equal(h.runtime.snapshot().runs[0].cursor.node, 'after');
  h.port.present = async () => ({}); await h.runtime.resume(); assert.equal(h.balance(), 11);
});
test('cancel and restore reject late callbacks from an old playback', async () => {
  const h = harness(graph([node('one', { type: 'end' }, 2)]));
  let resolve!: (value: {}) => void;
  h.port.present = () => new Promise(done => { resolve = done; });
  const old = h.runtime.start('main'); await tick(); const stable = h.runtime.snapshot();
  h.runtime.restore(stable); assert.equal(await old, false); assert.equal(h.rolledBack(), 0);
  h.port.present = async () => ({}); await h.runtime.resume(); assert.equal(h.balance(), 2);
  resolve({}); await tick(); assert.equal(h.balance(), 2); assert.equal(h.runtime.busy, false);
});
test('cancelled preparation does not capture or roll back a newer session', async () => {
  const h = harness(graph([node('one', { type: 'end' }, 2)])); let release!: () => void;
  h.port.prepare = () => new Promise(done => { release = done; });
  const old = h.runtime.start('main'); await tick(); h.runtime.cancel(); assert.equal(await old, false);
  h.port.prepare = async () => {}; h.earn(10); await h.runtime.resume(); release(); await tick();
  assert.equal(h.balance(), 12); assert.equal(h.rolledBack(), 0); assert.equal(h.captured(), 1);
});
test('choice exits persist the chosen value and can jump to another script', async () => {
  const data = graph([node('choose', { type: 'choice', choice: 'route', cases: { south: { script: 'south', node: 'go' } } })]);
  data.scripts.main.nodes[0].presentation=[{type:'choice',prompt:'route',options:[{label:'south',value:'south'}]}];
  data.scripts.south = { entry: 'go', nodes: [node('go')] };
  const h = harness(data); h.port.present = async () => ({ choice: 'south' }); await h.runtime.start('main');
  assert.deepEqual(h.commits[0].commands, [{ type: 'choice', choice: 'route', value: 'south' }]);
  assert.equal(h.runtime.snapshot().runs[0].cursor.script, 'south');
});
test('invalid restored references leave current state and playback untouched', async () => {
  const h = harness(graph([node('one')])); await h.runtime.start('main');
  const before = h.runtime.snapshot(), invalid = structuredClone(before); invalid.runs[0].cursor.node = 'missing';
  assert.throws(() => h.runtime.restore(invalid), /不存在/); assert.deepEqual(h.runtime.snapshot(), before);
});
test('playback, prefetch and content validation agree at 32 and 33 nested calls',async()=>{
  const ref=(index:number)=>({script:'main',node:String(index)});
  for(const depth of [32,33]){
    const calls=Array.from({length:depth},(_,i)=>node(String(i),{type:'call',target:ref(i+1),then:{script:'main',node:'end'}}));
    const destination={map:'B',x:1,y:1,facing:'south'} as const;
    const graphData=graph([...calls,{...node(String(depth)),commands:[{type:'travel',destination}]},node('end')]);
    const campaign:Campaign={...graphData,events:[],contentVersion:1,
      start:{...destination,map:'A',actor:'hero',script:'main'},quests:[],placements:[],questGroups:[],
      storyProgression:{steps:[],ongoing:[]}};
    const check=()=>validateStoryPerformance({version:1,maps:[],actors:{},portraits:{},props:[]},campaign);
    assert.equal(nextStoryMap(campaign,{node:ref(0),stack:[]},'A'),depth===32?'B':undefined);
    if(depth===32){check();assert.equal(await harness(campaign).runtime.start('main'),true);}
    else{assert.throws(check,/调用层级/);await assert.rejects(harness(campaign).runtime.start('main'),/调用层级/);}
  }
});

test('shared scripts return through a saved call stack without repeating a committed award',async()=>{
  const data=graph([node('call',{type:'call',target:{script:'shared',node:'award'},then:{script:'main',node:'after'}}),node('after')]);
  data.scripts.shared={entry:'award',nodes:[node('award',{type:'next',target:{script:'shared',node:'return'}},4),node('return')]};
  const h=harness(data);h.port.present=async action=>{h.played.push(action.id);if(action.id==='return')throw new Error('shared finish failed');return {};};
  await assert.rejects(h.runtime.start('main'),/shared finish failed/);assert.equal(h.balance(),4);
  const saved=h.runtime.snapshot();assert.deepEqual(saved.runs[0].stack,[{script:'main',node:'after'}]);
  const restored=harness(data);restored.earn(4);restored.runtime.restore(saved);await restored.runtime.resume();
  assert.equal(restored.balance(),4);assert.deepEqual(restored.played,['return','after']);assert.equal(restored.runtime.snapshot().runs[0].status,'completed');
});

test('region events default to their own identity and do not play other regions on the same map',async()=>{
  const data=graph([node('one')]);data.events=[{id:'north',source:'region',map:'camp',script:'main'},{id:'south',source:'region',map:'camp',script:'main'}];
  const h=harness(data);await h.runtime.dispatch({id:'touch:1',sequence:1,source:'region',key:'north',map:'camp'});
  assert.deepEqual(h.runtime.snapshot().completedEvents,['north']);assert.equal(h.played.length,1);
});

test('a terminal physical projection failure leaves committed state intact for recovery',async()=>{
  const h=harness(graph([node('one',{type:'end'},7)]));h.port.afterCommit=async()=>{throw new Error('projection failed');};
  await assert.rejects(h.runtime.start('main'),/projection failed/);assert.equal(h.balance(),7);assert.equal(h.rolledBack(),0);
  assert.equal(h.runtime.snapshot().runs[0].status,'completed');
  let recovered=0;h.port.recover=async()=>{recovered++;};await h.runtime.resume();assert.equal(recovered,1);assert.equal(h.balance(),7);
});
test('map changes clear queued candidates whose occurrence is no longer valid', async () => {
  const data = graph([node('travel')]); data.scripts.second = { entry: 'unused', nodes: [node('unused')] };
  data.events.push({ id: 'second', source: 'map-entry', script: 'second' });
  const h = harness(data); h.port.validOccurrence = () => h.played.length === 0;
  await h.runtime.dispatch({ id: 'visit:1', sequence: 1, source: 'map-entry', map: 'camp' }); assert.deepEqual(h.played, ['travel']);
});
test('restoring a committed candidate resumes the remaining same-occurrence events', async () => {
  const data = graph([node('one', { type: 'end' }, 2)]);
  data.scripts.second = { entry: 'two', nodes: [node('two', { type: 'end' }, 3)] };
  data.events.push({ id: 'second', source: 'map-entry', script: 'second' });
  const h = harness(data); h.port.present = async action => { if (action.id === 'two') throw new Error('later failure'); return {}; };
  await assert.rejects(h.runtime.dispatch({ id: 'visit:1', sequence: 1, source: 'map-entry', map: 'camp' }), /later failure/);
  const committed = h.commits[0].checkpoint;
  assert.equal(committed.pendingOccurrences[0].nextEventIndex, 1);
  const restored = harness(data); restored.earn(2); restored.runtime.restore(committed);
  await restored.runtime.resume(); assert.equal(restored.balance(), 5); assert.deepEqual(restored.played, ['two']);
  assert.equal(restored.runtime.snapshot().pendingOccurrences.length, 0);
});
test('queued occurrences are preserved and drained after the saved running node', async () => {
  const data = graph([node('one', { type: 'end' }, 1)]); data.events[0].repeat = true;
  const h = harness(data); let release!: (value: {}) => void;
  h.port.present = () => new Promise(done => { release = done; });
  const first = h.runtime.dispatch({ id: 'visit:1', sequence: 1, source: 'map-entry', map: 'camp' }); await tick();
  const second = h.runtime.dispatch({ id: 'visit:2', sequence: 2, source: 'map-entry', map: 'camp' });
  const saved = h.runtime.snapshot(); assert.equal(saved.pendingOccurrences.length, 2);
  h.runtime.cancel(); assert.equal(await first, false); assert.equal(await second, false);
  const restored = harness(data); restored.runtime.restore(saved); await restored.runtime.resume();
  assert.equal(restored.balance(), 2); assert.equal(restored.played.length, 2);
  release({}); await tick(); assert.equal(h.balance(), 0);
});
test('repeated events keep one finished run and one occurrence record per event', async () => {
  const data = graph([node('award', { type: 'end' }, 1)]); data.events[0].repeat = true;
  const h = harness(data);
  for (let visit = 1; visit <= 250; visit++) await h.runtime.dispatch({ id: `visit:${visit}`, sequence: visit, source: 'map-entry', map: 'camp' });
  assert.equal(h.balance(), 250); const state = h.runtime.snapshot();
  assert.equal(state.runs.length, 1); assert.equal(state.handledOccurrences.length, 1); assert.equal(state.completedEvents.length, 1);
});
test('a committed semantic stage is supplied when restoring the following node', async () => {
  const h = harness(graph([node('setup', { type: 'next', target: { script: 'main', node: 'continue' } }), node('continue')]));
  const stage = stageSnapshot({ type: 'stage' as const, map: 'camp', x: 3, y: 4, facing: 'east' as const, playerVisible: true,
    cast: [{ id: 'guard', actor: 'soldier', x: 5, y: 6, facing: 'west' as const, visible: true }] },
    [{ id: 'entity:portal', actor: 'portal', worldEntityId: 'portal', x: 90, y: 20, facing: 'south', visible: true }]);
  h.port.present = async action => { if (action.id === 'continue') throw new Error('continue failed'); return { stage }; };
  await assert.rejects(h.runtime.start('main'), /continue failed/);
  h.port.present = async (_action, context) => { assert.deepEqual(context.stage, stage); return {}; };
  await h.runtime.resume(); assert.deepEqual(h.commits.at(-1)!.stage, stage);
  assert.equal(h.runtime.snapshot().runs[0].stage, undefined);
});
test('repeat events reject late older producer sequences without storing all occurrence IDs', async () => {
  const data = graph([node('award', { type: 'end' }, 4)]); data.events[0].repeat = true;
  const h = harness(data);
  await h.runtime.dispatch({ id: 'visit:first', sequence: 1, source: 'map-entry', map: 'camp' });
  await h.runtime.dispatch({ id: 'visit:second', sequence: 2, source: 'map-entry', map: 'camp' });
  assert.equal(await h.runtime.dispatch({ id: 'visit:late-first', sequence: 1, source: 'map-entry', map: 'camp' }), false);
  assert.equal(h.balance(), 8); assert.equal(h.runtime.snapshot().occurrenceSequences.length, 1);
});
test('start events and entity-specific interactions use the same dispatcher', async () => {
  const data = graph([node('opening')]); data.events = [{ id: 'opening', source: 'start', script: 'main' }, { id: 'npc', source: 'interaction', entity: 'guard:1', script: 'main' }];
  const h = harness(data);
  assert.equal(await h.runtime.dispatch({ id: 'new-session', sequence: 0, source: 'start' }), true);
  assert.equal(await h.runtime.dispatch({ id: 'touch:1', sequence: 1, source: 'interaction', entity: 'guard:2' }), false);
  assert.equal(await h.runtime.dispatch({ id: 'touch:2', sequence: 2, source: 'interaction', entity: 'guard:1' }), true);
});
test('a conditional cycle that never takes its exit stops at the execution budget', async () => {
  const h = harness(graph([node('loop', { type: 'branch', condition: { type: 'always', value: true }, then: { script: 'main', node: 'loop' }, otherwise: { script: 'main', node: 'end' } }), node('end')]));
  h.port.currentMap = () => 'camp';
  h.port.executionContext = () => ({ mapVisit: 7, skipping: true });
  await assert.rejects(h.runtime.start('main'), (error: Error) => {
    assert.match(error.message, /执行预算/);
    assert.ok(error instanceof StoryExecutionBudgetError);
    const details = error.details;
    assert.equal(details.run, h.runtime.snapshot().runs[0].id);
    assert.deepEqual([details.map, details.mapVisit, details.skipping], ['camp', 7, true]);
    assert.equal(details.recent.length, 12);
    assert.deepEqual(details.recent.at(-1), { script: 'main', node: 'loop' });
    assert.deepEqual(details.next, details.recent.at(-1));
    return true;
  });
  assert.equal(h.runtime.busy, false); assert.equal(h.runtime.snapshot().runs[0].status, 'running');
});
test('an event that finishes on the final allowed step completes without a budget error', async () => {
  const loop = node('loop', {
    type: 'branch', condition: { type: 'always', value: true },
    then: { script: 'main', node: 'loop' }, otherwise: { script: 'main', node: 'end' },
  });
  const h = harness(graph([loop, node('end')]));
  let passes = 0;
  h.port.evaluate = () => ++passes < 999;
  assert.equal(await h.runtime.start('main', 'intro'), true);
  assert.equal(h.runtime.eventStatus('intro'), 'completed');
});

test('a branch evaluates the real state after the node commands land', async () => {
  const wrong = node('wrong', { type: 'defer' });
  const data = graph([node('choose', { type: 'branch', condition: { type: 'always', value: true },
    then: { script: 'main', node: 'done' }, otherwise: { script: 'main', node: 'wrong' } }), node('done'), wrong]);
  data.scripts.main.nodes[0].commands = [{ type: 'item-give', item: 'coin', quantity: 4 }];
  const h = harness(data);
  h.port.evaluate = () => h.balance() === 4;
  assert.equal(await h.runtime.start('main'), true);
  assert.equal(h.balance(), 4);
  assert.equal(h.runtime.snapshot().runs[0].status, 'completed', '分支看到同一节点发放的物品后走 then');
});
test('a branch evaluation failure rolls back the applied command batch', async () => {
  const data = graph([node('choose', { type: 'branch', condition: { type: 'always', value: true },
    then: { script: 'main', node: 'done' }, otherwise: { script: 'main', node: 'done' } }), node('done')]);
  data.scripts.main.nodes[0].commands = [{ type: 'item-give', item: 'coin', quantity: 4 }];
  const h = harness(data);
  h.port.evaluate = () => { throw new Error('branch evaluation failed'); };
  await assert.rejects(h.runtime.start('main'), /branch evaluation failed/);
  assert.equal(h.balance(), 0, '已落地的命令要随求值失败一起回滚');
  assert.equal(h.rolledBack(), 1);
  assert.equal(h.runtime.snapshot().runs[0].status, 'running');
});
test('an occurrence that matches nothing never notifies the port', async () => {
  // 队列非空不等于剧情要接管：入队的多数通知筛不到事件。这一条是本次修复的核心判据——
  // 旧实现会在 drain 入口无条件通知端口，跑到这里就是 [true, false]。
  const h = harness(graph([node('one')]));
  assert.equal(await h.runtime.dispatch({ id: 'touch:1', sequence: 1, source: 'interaction' }), false);
  assert.deepEqual(h.locks, []); assert.equal(h.runtime.busy, false);
  assert.equal(h.runtime.snapshot().pendingOccurrences.length, 0);
  // 无匹配的排在一个匹配的前面，也只进出一次（不按 work item 反复闪锁）。
  const idle = h.runtime.dispatch({ id: 'touch:2', sequence: 2, source: 'interaction' });
  const played = h.runtime.dispatch({ id: 'visit:1', sequence: 1, source: 'map-entry', map: 'camp' });
  assert.equal(await idle, false); assert.equal(await played, true);
  assert.deepEqual(h.locks, [true, false]);
});
test('resume without a running node leaves the port idle', async () => {
  // 读档进场这类空恢复不该闪一次锁；只有真的有节点在跑才需要接管。
  const h = harness(graph([node('one')]));
  assert.equal(await h.runtime.start('main'), true);
  h.locks.length = 0;
  assert.equal(await h.runtime.resume(), false);
  assert.deepEqual(h.locks, []); assert.equal(h.runtime.busy, false);
});
test('a cancelled playback clears the port once and the next drain notifies again', async () => {
  const h = harness(graph([node('one')]));
  h.port.present = () => new Promise(() => {});
  const held = h.runtime.start('main'); await tick();
  h.runtime.cancel(); assert.equal(await held, false);
  assert.deepEqual(h.locks, [true, false]);
  // 取消一次纯播放后，下一次真正要播的 drain 仍完整地进出端口一次。
  h.port.present = async () => ({});
  assert.equal(await h.runtime.dispatch({ id: 'visit:1', sequence: 1, source: 'map-entry', map: 'camp' }), true);
  assert.deepEqual(h.locks, [true, false, true, false]);
});

test('authored stage declarations are never persisted as runtime scene checkpoints', async () => {
  const first = node('declaration', { type: 'next', target: { script: 'main', node: 'after' } });
  first.stage = { type: 'stage', map: 'camp', x: 0, y: 0, facing: 'south', playerVisible: true, cast: [] };
  const h = harness(graph([first, node('after')]));
  h.port.prepare = async (action, context) => {
    if (action.id === 'declaration') assert.deepEqual(context.stage, first.stage);
    else assert.equal(context.stage, undefined);
  };
  await h.runtime.start('main');
  assert.equal(h.commits[0].checkpoint.runs[0].stage, undefined);
  assert.equal(h.runtime.snapshot().version, 2);
});

test('invalid complete scene snapshots cannot be committed or restored', async () => {
  const h = harness(graph([node('one', { type: 'end' }, 3)]));
  const valid = stageSnapshot({ type: 'stage', map: 'camp', x: 0, y: 0, facing: 'south', playerVisible: true,
    cast: [{ id: 'guard', actor: 'soldier', x: 8, y: 8, facing: 'south', visible: true }] });
  const invalid = structuredClone(valid); invalid.scene.actors.push(structuredClone(invalid.scene.actors[0]));
  h.port.present = async () => ({ stage: invalid });
  await assert.rejects(h.runtime.start('main'));
  assert.equal(h.balance(), 0); assert.equal(h.rolledBack(), 1);
  for (const corrupt of [
    (stage: typeof valid) => { stage.scene.map = 'elsewhere'; },
    (stage: typeof valid) => { stage.bindings[1][1] = 'absent'; },
    (stage: typeof valid) => { stage.bindings.push(['guard', 'player']); },
    (stage: typeof valid) => { stage.scene.actors[1].x = Number.NaN; },
    (stage: typeof valid) => { stage.x += 8; },
    (stage: typeof valid) => { stage.cast[0].visible = false; },
    (stage: typeof valid) => { delete (stage as Partial<typeof valid>).scene; },
    (stage: typeof valid) => { stage.scenes=[structuredClone(stage.scene)]; },
    (stage: typeof valid) => { const scene={...structuredClone(stage.scene),map:'elsewhere'};stage.scenes=[scene,scene]; },
  ]) {
    const saved = structuredClone(h.runtime.snapshot()); saved.runs[0].stage = structuredClone(valid); corrupt(saved.runs[0].stage);
    assert.throws(() => h.runtime.restore(saved));
    assert.equal(h.runtime.snapshot().runs[0].stage, undefined);
  }
});

test('cancel preserves every background object at the last stable node and ignores late scene results', async () => {
  const h = harness(graph([node('first', { type: 'next', target: { script: 'main', node: 'second' } }), node('second')]));
  const stage = stageSnapshot({ type: 'stage', map: 'camp', x: 3, y: 4, facing: 'east', playerVisible: true, cast: [] }, [
    { id: 'entity:open-chest', actor: 'chest', x: 12, y: 16, facing: 'south', visible: true },
    { id: 'enemy:a', actor: 'enemy', enemyKey: 'a', enemyId: 'wolf', x: 32, y: 48, facing: 'west', visible: true },
    { id: 'enemy:b', actor: 'enemy', enemyKey: 'b', enemyId: 'wolf', x: 64, y: 48, facing: 'east', visible: false },
  ]);
  let release!: (value: { stage: typeof stage }) => void;
  h.port.present = async action => action.id === 'first' ? { stage } : new Promise(done => { release = done; });
  const pending = h.runtime.start('main'); await tick();
  h.runtime.cancel(); assert.equal(await pending, false);
  const checkpoint = h.runtime.snapshot(); assert.deepEqual(checkpoint.runs[0].stage, stage);
  h.port.present = async (_action, context) => { assert.deepEqual(context.stage, stage); return {}; };
  await h.runtime.resume();
  const late = structuredClone(stage); late.scene.actors.splice(1);
  release({ stage: late }); await tick();
  assert.deepEqual(h.commits.at(-1)!.stage, stage);
  assert.equal(h.runtime.snapshot().runs[0].stage, undefined);
});

test('completed and deferred runs release full scene payloads after handing the final frame to commit',async()=>{
  const stage=stageSnapshot({type:'stage',map:'camp',x:3,y:4,facing:'south',playerVisible:true,cast:[]},[
    {id:'entity:gate',actor:'gate',x:80,y:120,facing:'south',visible:true}]);
  for(const type of ['end','defer'] as const){
    const h=harness(graph([node('one',{type})]));
    h.port.present=async()=>({stage});
    for(let count=0;count<10;count++)await h.runtime.start('main');
    assert.equal(h.runtime.snapshot().runs.length,1);
    assert.ok(h.runtime.snapshot().runs.every(run=>run.stage===undefined));
    assert.equal(JSON.stringify(h.runtime.snapshot()).includes('entity:gate'),false);
    assert.ok(h.commits.every(commit=>JSON.stringify(commit.stage)===JSON.stringify(stage)));
  }
});
