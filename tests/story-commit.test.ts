import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stageSnapshot } from './helpers/story-stage.ts';
import { storyCommitCommands } from '../src/domain/story-commit.ts';
import { StoryWorldState, type StoryWorldSnapshot } from '../src/domain/story-world.ts';
import type { StoryNodeCommit, StoryRuntimeSnapshot } from '../src/domain/story-runtime.ts';
import type { StoryCommand, StoryScript } from '../src/domain/story-graph.ts';
import { applyStorySceneAction, resolveStoryScene } from '../src/domain/story-scene.ts';
import type { StoryStage } from '../src/domain/story-performance.ts';

/** 演出差量写回与脚本显式落位、移除的提交规则。 */
const runtime: StoryRuntimeSnapshot = { version: 2, sequence: 0, runs: [], completedEvents: [],
  handledOccurrences: [], encounterResults: [], pendingOccurrences: [], occurrenceSequences: [] };
const ENTITY = { id: 'quest-npc-located-npc-121', map: 'castle02', actor: 'barricade-307ed4dd',
  characterId: 'npc-121', x: 568, y: 216, facing: 'south' as const, visible: true };

function world(snapshot: Partial<StoryWorldSnapshot> = {}): StoryWorldState {
  const state = new StoryWorldState();
  state.restoreState({ entities: [ENTITY], exits: [], flags: [], choices: [], encounters: [], mapVisit: 0, ...snapshot });
  return state;
}
function commit(commands: StoryNodeCommit['commands'] = [], stage?: StoryNodeCommit['stage']): StoryNodeCommit {
  return { commands, checkpoint: runtime, node: { script: 'event-57', node: 'done' }, runId: 'run', stage };
}
const placesOf = (commands: readonly StoryCommand[], id = ENTITY.id): number =>
  commands.filter(command => command.type === 'world' && command.command.kind === 'place'
    && command.command.entity.id === id).length;

test('a stage cast that also names a party member removes the map NPC copy', () => {
  const stage = stageSnapshot({type:'stage',map:ENTITY.map,x:1,y:2,facing:'south',playerVisible:true,
    cast:[{id:'olaf',actor:'olaf',characterId:'npc-249',memberId:'story-mercenary-olaf',x:1,y:2,facing:'south',visible:true}]});
  const commands = storyCommitCommands(commit([], stage), world(), []);
  assert.ok(commands.some(command => command.type==='world' && command.command.kind==='remove-character'
    && command.command.characterId==='npc-249' && command.command.map===ENTITY.map && command.command.all));
  const beforeJoin = storyCommitCommands(commit([], stage), world(), [], () => false);
  assert.equal(beforeJoin.some(command => command.type==='world' && command.command.kind==='remove-character'
    && command.command.characterId==='npc-249'), false, '尚未加入队伍时不隐藏地图 NPC');
});

test('implicit stage bindings do not revive an entity the script removed', () => {
  const state = world();
  state.apply({ kind: 'remove', id: ENTITY.id });
  assert.equal(state.entity(ENTITY.id)!.removed, true);
  const commands = storyCommitCommands(commit(), state, [ENTITY]);
  assert.equal(placesOf(commands), 0, '已移除的角色不再被隐式绑定写回');
  for (const command of commands) if (command.type === 'world') state.apply(command.command);
  assert.equal(state.entity(ENTITY.id)!.removed, true, '提交后仍保持移除');
});

test('implicit stage bindings still place actors that are only hidden or moved', () => {
  const state = world();
  state.apply({ kind: 'hide', id: ENTITY.id });
  const commands = storyCommitCommands(commit(), state, [{ ...ENTITY, x: 600, y: 240 }]);
  assert.equal(placesOf(commands), 1, '只是隐藏或换位的角色照常写回');
  for (const command of commands) if (command.type === 'world') state.apply(command.command);
  assert.equal(state.entity(ENTITY.id)!.x, 600);
  assert.equal(state.entity(ENTITY.id)!.visible, true);
});

test('an explicit place or show in the node still revives a removed entity', () => {
  for (const kind of ['place', 'show'] as const) {
    const state = world();
    state.apply({ kind: 'remove', id: ENTITY.id });
    const node = kind === 'place'
      ? { type: 'world' as const, command: { kind, entity: ENTITY } }
      : { type: 'world' as const, command: { kind, id: ENTITY.id } };
    const commands = storyCommitCommands(commit([node]), state, [ENTITY]);
    for (const command of commands) if (command.type === 'world') state.apply(command.command);
    assert.equal(state.entity(ENTITY.id)!.removed, false, `${kind} 是内容明确要求的复活`);
  }
});

test('bindings still skip entities registered on another map', () => {
  const state = world();
  state.apply({ kind: 'place', entity: { ...ENTITY, map: 'castle01' } });
  const commands = storyCommitCommands(commit(), state, [ENTITY]);
  assert.equal(placesOf(commands), 0, '跨图实体不参与本图绑定');
  assert.equal(state.entity(ENTITY.id)!.map, 'castle01');
});

const caveStage = (x: number, y: number, facing: 'south' | 'east' = 'south'): NonNullable<StoryNodeCommit['stage']> => stageSnapshot({
  type: 'stage', map: 'silent-cave-depths', x, y, facing, playerVisible: true,
  retainPlayerPosition: true, cast: []
});
const committedRun = (stage: StoryNodeCommit['stage']): StoryRuntimeSnapshot => ({
  ...runtime, runs: [{ id: 'run', script: 'event-4', occurrence: 'event-4', cursor: { script: 'event-4', node: 'scene-1' },
    status: 'completed', stage }]
});
const atEntrance = () => world({ location: { map: 'silent-cave-depths', x: 40, y: 168, facing: 'east' } });

test('retained player position still writes back where the performance walks him', () => {
  const performed = caveStage(104, 184, 'east');
  const node: StoryNodeCommit = { commands: [], checkpoint: committedRun(performed), node: { script: 'event-4', node: 'scene-1' }, runId: 'run', stage: performed };
  const commands = storyCommitCommands(node, atEntrance(), []);
  const travel = commands.find(command => command.type === 'travel');
  assert.deepEqual(travel && travel.type === 'travel' && travel.destination,
    { map: 'silent-cave-depths', x: 104, y: 184, facing: 'east' },
    '事件 4 的凯恩从洞口走进来后，战斗应当从他停下的位置开始');
});

test('retained player position without a performance frame is not treated as a move', () => {
  const anchor = caveStage(200, 184);
  const node: StoryNodeCommit = { commands: [], checkpoint: committedRun(anchor), node: { script: 'event-4', node: 'scene-1' }, runId: 'run', stage: undefined };
  const commands = storyCommitCommands(node, atEntrance(), []);
  assert.equal(commands.some(command => command.type === 'travel'), false,
    '无表现层时只能拿到脚本兜底锚点，不能把主角传送过去');
});

test('a retained stage that leaves the player standing still does not submit a move', () => {
  const performed = caveStage(40, 168, 'east');
  const node: StoryNodeCommit = { commands: [], checkpoint: committedRun(performed), node: { script: 'event-4', node: 'scene-1' }, runId: 'run', stage: performed };
  const commands = storyCommitCommands(node, atEntrance(), []);
  assert.equal(commands.some(command => command.type === 'travel'), false);
});

test('an explicit reuse replaces the old world binding without duplicating its static instance',()=>{
  const state=world();
  const destination={...ENTITY,id:'new-binding',x:300};
  const performed=stageSnapshot({type:'stage',map:ENTITY.map,x:1,y:2,facing:'south',playerVisible:true,cast:[]});
  performed.scene.actors.push({id:`entity:${ENTITY.id}`,worldEntityId:destination.id,actor:ENTITY.actor,
    characterId:ENTITY.characterId,x:300,y:ENTITY.y,facing:'south',visible:true});
  const commands=storyCommitCommands(commit([{type:'world',command:{kind:'place',entity:destination}}],performed),state,[]);
  assert.deepEqual(commands.slice(0,2),[
    {type:'world',command:{kind:'remove',id:ENTITY.id}},
    {type:'world',command:{kind:'place',entity:destination}}
  ]);
  for(const command of commands)if(command.type==='world')state.apply(command.command);
  assert.equal(state.entity(ENTITY.id)?.removed,true);
  const projected=state.projectEntities(ENTITY.map,[ENTITY]);
  assert.deepEqual(projected.map(entity=>entity.id),[destination.id]);
});

test('explicit create and a re-registered actor on another map preserve unrelated old instances',()=>{
  for(const [canonical,map] of [[`story:new`,ENTITY.map],[`entity:${ENTITY.id}`,'other-map']]){
    const state=world();
    state.apply({kind:'place',entity:{...ENTITY,map}});
    const destination={...ENTITY,id:'new-binding'};
    const performed=stageSnapshot({type:'stage',map:ENTITY.map,x:1,y:2,facing:'south',playerVisible:true,cast:[]});
    performed.scene.actors.push({id:canonical,worldEntityId:destination.id,actor:ENTITY.actor,
      x:ENTITY.x,y:ENTITY.y,facing:'south',visible:true});
    const commands=storyCommitCommands(commit([{type:'world',command:{kind:'place',entity:destination}}],performed),state,[]);
    assert.equal(commands.some(command=>command.type==='world'&&command.command.kind==='remove'),false);
    for(const command of commands)if(command.type==='world')state.apply(command.command);
    assert.equal(state.entity(ENTITY.id)?.removed,false);
  }
});

for (const [scriptId, nodeId, entityId, expected] of [
  ['event-145', 'scene-1', 'story-character-145-8', [488, 328]],
  ['event-141', 'scene-5', 'story-character-npc-69', [136, 296]],
  ['event-141', 'scene-5', 'story-character-npc-70', [168, 296]],
] as const) test(`${scriptId}/${nodeId} commits each instance at its performed final position`, () => {
  const campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8')) as { scripts: Record<string, StoryScript> };
  const script = campaign.scripts[scriptId]!;
  const node = script.nodes.find(node => node.id === nodeId)!;
  let declaration: StoryStage | undefined;
  for (const candidate of script.nodes) {
    for (const action of candidate.presentation) if (action.type === 'stage') declaration = action;
    if (candidate === node) break;
  }
  assert.ok(declaration);
  let stage = resolveStoryScene(declaration, { map: declaration.map, actors: [{ id: 'player', actor: 'kiyan',
    x: declaration.x, y: declaration.y, facing: declaration.facing, visible: true }] });
  for (const action of node.presentation) {
    if (action.type === 'stage') stage = resolveStoryScene(action, stage.scene);
    else if (action.type !== 'dialogue' && action.type !== 'choice' && action.type !== 'quest-popup') stage = applyStorySceneAction(stage, action);
  }
  const finalActor = stage.scene.actors.find(actor => actor.worldEntityId === entityId)!;
  assert.deepEqual([finalActor.x, finalActor.y], expected);
  const changes = stage.scene.actors.filter(actor => actor.worldEntityId && !actor.unpositioned && !actor.removed)
    .map(actor => ({ id: actor.worldEntityId!, actor: actor.actor, characterId: actor.characterId, map: stage.map,
      x: actor.x, y: actor.y, facing: actor.facing, visible: actor.visible }));
  const state = world({ entities: [], location: { map: stage.map, x: stage.x, y: stage.y, facing: stage.facing } });
  const original = structuredClone(node.commands);
  const commands = storyCommitCommands(commit(node.commands, stage), state, changes);
  for (const command of commands) if (command.type === 'world') state.apply(command.command);
  const placed = state.entity(entityId)!;
  assert.deepEqual([placed.x, placed.y], expected, '节点原始 place 不应覆盖独立实例的演出最终站位');
  assert.equal(placed.facing, finalActor.facing);
  assert.equal(placed.visible, finalActor.visible);
  assert.equal(placed.mapVisit, state.visit, '原 place 的 visit 生命周期必须保留');
  assert.deepEqual(node.commands, original, '提交投影不能改写源内容');
});

test('final pose merging preserves the order of subsequent removal and cross-map registration', () => {
  for (const ending of ['remove', 'migrate'] as const) {
    const state = world();
    const final = { ...ENTITY, x: 600, y: 240, facing: 'east' as const, visible: false };
    const stage = stageSnapshot({ type: 'stage', map: ENTITY.map, x: 1, y: 2, facing: 'south', playerVisible: true, cast: [] });
    stage.scene.actors.push({ ...final, id: `entity:${ENTITY.id}`, worldEntityId: ENTITY.id });
    const terminal: StoryCommand = ending === 'remove'
      ? { type: 'world', command: { kind: 'remove', id: ENTITY.id } }
      : { type: 'world', command: { kind: 'place', entity: { ...ENTITY, map: 'castle01', x: 80 } } };
    const source: StoryCommand[] = [
      { type: 'world', command: { kind: 'place', scope: 'visit', entity: ENTITY } },
      { type: 'world', command: { kind: 'place', scope: 'visit', entity: { ...ENTITY, x: 580 } } }, terminal,
    ];
    const commands = storyCommitCommands(commit(source, stage), state, [final]);
    assert.deepEqual(commands.at(-1), terminal, '后续显式删除或跨图注册保持原义');
    assert.deepEqual(commands[1], source[0], '只合并本图最后一次落位');
    assert.deepEqual(commands[2], { type: 'world', command: { kind: 'place', scope: 'visit', entity: final } });
    for (const command of commands) if (command.type === 'world') state.apply(command.command);
    assert.equal(state.entity(ENTITY.id)!.removed, ending === 'remove');
    if (ending === 'migrate') {
      assert.equal(state.entity(ENTITY.id)!.map, 'castle01');
      assert.equal(state.entity(ENTITY.id)!.x, 80);
    }
  }
});
