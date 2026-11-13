import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCampaign } from '../src/application/content-validation.ts';
import type { StoryStage } from '../src/domain/story-performance.ts';

const read = (file: string) => JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('content/campaign.json'));

const stagesOf = (name: string) => campaign.scripts[name].nodes
  .map(node => ({ node, stage: node.presentation.find(action => action.type === 'stage') as StoryStage | undefined }))
  .filter((entry): entry is { node: (typeof campaign.scripts)[string]['nodes'][number]; stage: StoryStage } => !!entry.stage);
const appearsIn = (name: string, nodeId: string) => campaign.scripts[name].nodes
  .find(node => node.id === nodeId)!.presentation
  .some(action => action.type === 'appear' && action.target === 'player');

test('a scene the native script never places the player in keeps them off stage', () => {
  // 事件 2（圣女与鑫迪躲进洞里）：原版先把主角移出场，切到洞穴之后整段都没有再放置他，
  // 一直到切回丛林才 `0x00` 放人。复刻照这个走，洞穴那段主角不在台上。
  assert.deepEqual(stagesOf('event-2').map(entry => [entry.stage.map, entry.stage.playerVisible]), [
    ['silent-cave-depths', false], ['shadow-forest-east', false],
  ]);
  const back = stagesOf('event-2').at(-1)!;
  assert.ok(appearsIn('event-2', back.node.id), '回到丛林那一段应当由放置命令把主角请回来');
});

test('a lead-in that only fades out before a map change is not generated', () => {
  // 进图或走到触发点的演出不再先演一段「淡出当前画面」的空场景；素材在入口计划里加载，
  // 加载完直接从正式演出的第一幕开始，玩家不会先看到空舞台或黑幕。
  assert.equal(stagesOf('event-2')[0]!.stage.map, 'silent-cave-depths');
  assert.equal(stagesOf('event-3')[0]!.stage.map, 'silent-cave-entrance');
  assert.equal(stagesOf('event-7')[0]!.stage.map, 'sanctus-church');
  const opening = campaign.scripts['event-1'];
  assert.deepEqual(opening.nodes[0]!.presentation, [], '开场过渡节点不再画舞台');
  assert.equal(stagesOf('event-1')[0]!.stage.map, 'shadow-forest-west', '开场直接从正式演出第一幕开始');
});

test('a scene that only walks the player in keeps him hidden until the first camera or walk', () => {
  // 事件 4 开场只有伯爵一行；原版整段没有放置主角，只有后面的走位（0x47 → CHARSYSTEM_Revive）。
  const first = stagesOf('event-4')[0]!;
  assert.equal(first.stage.playerVisible, false);
  const actions = first.node.presentation;
  const show = actions.findIndex(action => action.type === 'show' && action.target === 'player');
  const entrance = actions.findIndex(action => (action.type === 'camera' || action.type === 'walk') && action.target === 'player');
  assert.ok(show >= 0 && show < entrance, '主角要在第一次被镜头对准或走位之前显形');
});

test('player entrances that begin on stage remain visible before show', () => {
  for (const name of ['event-54', 'event-60', 'event-72', 'event-74', 'event-85', 'event-352',
    'event-392', 'event-393', 'event-394', 'event-395']) {
    const entry = stagesOf(name).find(value => value.node.id === 'scene-1')!;
    assert.equal(entry.stage.playerVisible, true, `${name} 的主角应当开场可见`);
    assert.ok(entry.node.presentation.some(action => action.type === 'show' && action.target === 'player'), name);
  }
});

test('a scene the native script does place the player in still shows them', () => {
  // 事件 3（伯爵在洞口布阵）切到洞口时原版自己就放了主角，所以这一段要留着主角。
  const cave = stagesOf('event-3').find(entry => entry.stage.map === 'silent-cave-entrance')!;
  assert.equal(cave.stage.playerVisible, true);
  assert.ok(appearsIn('event-3', cave.node.id));
});

test('a scene that starts without placing the player keeps them off stage', () => {
  // 这些事件切到另一张图后先演别人的戏，原版要到后面的放置命令才把主角摆上来。
  const scenes = [
    ['event-233', 'scene-2'], ['event-330', 'scene-2'], ['event-355', 'scene-2'],
    ['event-255', 'scene-2'], ['event-305', 'scene-2'], ['event-0', 'scene-2'],
  ] as const;
  for (const [name, nodeId] of scenes) {
    const stage = stagesOf(name).find(entry => entry.node.id === nodeId)!.stage;
    assert.equal(stage.playerVisible, false, `${name}/${nodeId} 的主角开场不该显示`);
  }
  for (const [name, nodeId] of scenes.slice(0, 3))
    assert.ok(appearsIn(name, nodeId), `${name}/${nodeId} 应当由后续放置命令让主角入场`);
});

test('the player never speaks while hidden', () => {
  for (const [name, script] of Object.entries(campaign.scripts)) for (const node of script.nodes) {
    const stage = node.presentation.find(action => action.type === 'stage') as StoryStage | undefined;
    if (!stage || stage.playerVisible) continue;
    const speech = node.presentation.findIndex(action => action.type === 'dialogue' && action.actor === campaign.start.actor);
    if (speech < 0) continue;
    const appearance = node.presentation.findIndex(action =>
      (action.type === 'appear' || action.type === 'show') && action.target === 'player');
    assert.ok(appearance >= 0 && appearance < speech, `${name}/${node.id} 的主角在显形前说话`);
  }
});
