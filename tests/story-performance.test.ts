import {resolveStoryScene} from '../src/domain/story-scene.ts';
import {stageSnapshot} from './helpers/story-stage.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import { Session } from '../src/domain/session.ts';
import { parseCampaign, parseWorld } from '../src/application/content-validation.ts';
import { validateStoryPerformance } from '../src/application/story-performance-validation.ts';
import { cameraDuration, type PerformancePlayback, type StoryPresentationPort } from '../src/domain/story-performance.ts';
import { compileScript, storyScriptActions } from './support/story-fixtures.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { ChoiceOption, ScriptAction } from '../src/domain/content.ts';

const read = (file: string) => JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('content/campaign.json')), world = parseWorld(read('content/world.json'));
const tick = () => new Promise(resolve => setImmediate(resolve));
test('black-screen narration is marked in both scenes and normal dialogue keeps its frame', () => {
  const screenLines = Object.keys(campaign.scripts).flatMap(name => storyScriptActions(campaign, name)
    .filter(action => action.type === 'dialogue' && action.presentation === 'screen').map(action => ({ name, action })));
  assert.equal(screenLines.filter(entry => entry.name === 'event-0').length,6);
  assert.equal(screenLines.filter(entry => entry.name === 'event-2').length,4);
  // 屏幕文本是旁白与全屏文字这一类：不点角色、不带立绘。批量接入的原版旁白（0x2d）走的也是
  // 这条通道，所以这里不锁总数，只锁这条不变量。
  for (const { name, action } of screenLines) {
    assert.ok(action.type === 'dialogue' && !action.actor, `${name} 的屏幕文本不该点角色`);
    assert.ok(action.type === 'dialogue' && !action.portrait, `${name} 的屏幕文本不该带立绘`);
  }
  const firstCharacterLine = storyScriptActions(campaign, 'event-0').find(action => action.type === 'dialogue' && action.actor === 'kiyan');
  assert.equal(firstCharacterLine?.type === 'dialogue' ? firstCharacterLine.presentation : undefined,undefined);
  const invalid = read('content/campaign.json');
  invalid.scripts['event-0'].nodes.flatMap((node: { presentation: { type: string; presentation?: string }[] }) => node.presentation).find((action: { type: string }) => action.type === 'dialogue').presentation = 'unknown';
  assert.throws(() => parseCampaign(invalid),/presentation/);
});
function harness(actions: ScriptAction[], presentation: StoryPresentationPort) {
  const content: Campaign = { ...campaign, scripts: { ...campaign.scripts, demo: compileScript('demo', actions) } };
  const session = new Session(content), locks: boolean[] = [], popups: string[] = [];
  let choose: ((option: ChoiceOption) => void) | undefined;
  const ui: StoryUI = { async dialogue() {}, choice: () => new Promise(resolve => { choose = resolve; }), async questPopup(kind, quest) { popups.push(`${kind}:${quest.id}`); }, toast() {}, closeDialogue() {}, skipDialogue() {} };
  const director = new StoryDirector(content, session, ui, locked => locks.push(locked), presentation);
  return { director, session, locks, popups, choose: (option: ChoiceOption) => choose!(option) };
}
test('parallel actions finish before the next action; skip settles every active action and stops at a choice', async () => {
  const events: string[] = [], pending: (() => void)[] = [];
  const option = { label: '继续', value: 'go' };
  const h = harness([
    { type: 'parallel', actions: [{ type: 'camera', target: 'earl', motion: 'pan' }, { type: 'walk', target: 'player', x: 8, y: 8, speedPxPerSecond: 100 }] },
    { type: 'choice', prompt: '选择', options: [option] }, { type: 'wait', durationMs: 60 }
  ], { begin() {}, execute: (action, playback) => new Promise(resolve => {
    events.push(action.type); assert.equal(playback.skipSignal.aborted, false);
    const done = () => { events.push('done:' + action.type); resolve(); };
    pending.push(done); playback.skipSignal.addEventListener('abort', done, { once: true });
  }), async finish(completed) { assert.equal(completed, true); events.push('finish'); } });
  const run = h.director.run(() => h.director.script('demo')); await tick();
  assert.deepEqual(events, ['camera', 'walk']);
  h.director.skip(); await tick(); assert.equal(h.director.canSkip, false);
  h.director.skip(); h.choose(option); await tick();
  assert.equal(events.at(-1), 'wait'); pending.at(-1)!();
  assert.equal(await run, true); assert.equal(events.at(-1), 'finish'); assert.deepEqual(h.locks, [true, false]);
});
test('cancellation aborts a pending stage and restores presentation before releasing the input lock', async () => {
  let playback: PerformancePlayback | undefined, finish: (() => void) | undefined;
  const shutdown = new Promise<void>(resolve => { finish = resolve; });
  const h = harness([{ type: 'stage', map: 'shadow-camp', x: 120, y: 312, facing: 'south', playerVisible: true, cast: [] }], {
    begin() {}, execute: (_action, value) => new Promise((_resolve, reject) => {
      playback = value; value.signal.addEventListener('abort', () => reject(value.signal.reason), { once: true });
    }), async finish() {}, release: () => shutdown
  });
  const run = h.director.trigger({ id: 'demo-trigger', script: 'demo', map: 'shadow-camp', x: 0, y: 0, width: 10, height: 10 });
  await tick(); h.director.cancel(); await tick();
  assert.equal(playback!.signal.aborted, true); assert.equal(h.director.busy, true); assert.deepEqual(h.locks, [true]);
  finish!(); assert.equal(await run, false); assert.equal(h.session.flags.has('demo-trigger'), false); assert.deepEqual(h.locks, [true, false]);
});
test('a failed objective performance can be retried without consuming the objective', async () => {
  const quest={...campaign.quests[0],id:'fixture-objective',completion:'all' as const,
    goals:[{id:'objective',kind:'interact' as const,target:'fixture-target',quantity:1}]};
  const content:Campaign={...campaign,quests:[quest],events:[],scripts:{...campaign.scripts,
    objective:compileScript('objective',[{type:'wait',durationMs:60}])}};
  content.scripts.objective.nodes.find(node=>node.exit.type==='end')!.commands.push({type:'quest',command:{type:'fact',fact:{kind:'interact',target:'fixture-target',occurrence:{source:'fixture',sequence:1}}}});
  let fail=true;
  const session=new Session(content),ui:StoryUI={async dialogue(){},async choice(){throw new Error('unused');},async questPopup(){},toast(){},closeDialogue(){},skipDialogue(){}};
  const director=new StoryDirector(content,session,ui,()=>{},{begin(){},async execute(){if(fail)throw new Error('asset failed');},async finish(){}});
  session.accept(quest.id);
  const entity={id:'fixture-entity',actor:'earl-grafton',objective:'fixture-target',afterInteractScript:'objective',x:0,y:0};
  await assert.rejects(director.interact(entity,world.actors[entity.actor]),/asset failed/);
  assert.equal(session.status(quest.id),'active');assert.equal(session.questBook.state(quest.id)!.goals.objective,0);
  fail=false;assert.equal(await director.interact(entity,world.actors[entity.actor]),true);
  assert.equal(session.status(quest.id),'ready');assert.notEqual(session.storyWorld.entity(entity.id)?.removed,true);
});
test('the native forest event grants the assassination after Darius departs', async () => {
  let departures=0;
  const h=harness([],{begin(){},async execute(action){if(action.type==='leave'&&action.target==='darius')departures++;},async finish(){}});
  await h.director.enterRegion('event-1','shadow-camp');
  assert.equal(h.session.status('grafton-mission'),'active');assert.equal(departures,1);
});
test('native reporting defers the next main quest until the tutorial continuation', () => {
  const commands=campaign.scripts['event-6'].nodes.flatMap(node=>node.commands);
  assert.equal(commands.some(command=>command.type==='quest'&&command.command.type==='accept'),false);
  const choice=campaign.scripts['event-6'].nodes.find(node=>node.exit.type==='choice')!.exit;
  assert.ok(choice.type==='choice');assert.equal(choice.choice,'choice-10');
  const continuation=campaign.scripts['event-411'].nodes.flatMap(node=>node.commands);
  assert.ok(continuation.some(command=>command.type==='quest'&&command.command.type==='accept'&&command.command.quest==='cardinal-summons'));
});
test('all authored performances and acceptance continuations resolve actors, animations, effects and walkable routes', () => {
  const maps = new Map(world.maps.map(m => [m.id, read(m.file)]));
  validateStoryPerformance(world, campaign, maps);
  const broken=structuredClone(campaign);
  broken.scripts.demo=compileScript('demo',[
    {type:'stage',map:'shadow-camp',x:120,y:312,facing:'south',playerVisible:true,cast:[]},
    {type:'camera',target:'missing',motion:'pan'}]);
  assert.throws(()=>validateStoryPerformance(world,broken),/人物未出场 missing/);
  broken.scripts.demo=compileScript('demo',[
    {type:'stage',map:'shadow-camp',x:120,y:312,facing:'south',playerVisible:true,cast:[]},
    {type:'walk',target:'player',x:-8,y:-8,speedPxPerSecond:100}]);
  assert.throws(()=>validateStoryPerformance(world,broken,maps),/道路不可达/);
});
test('parallel groups reject conflicting camera control and nested stage replacement', () => {
  const broken = structuredClone(campaign);
  broken.scripts.demo = compileScript('demo', [{ type: 'parallel', actions: [{ type: 'walk', target: 'player', x: 8, y: 8, speedPxPerSecond: 100, followCamera: true }, { type: 'camera', target: 'darius', motion: 'pan' }] }]);
  assert.throws(() => parseCampaign(broken));
  broken.scripts.demo = compileScript('demo', [{ type: 'parallel', actions: [{ type: 'parallel', actions: [{ type: 'stage', map: 'shadow-camp', x: 120, y: 312, facing: 'south', playerVisible: true, cast: [] }] }] }]);
  assert.throws(() => parseCampaign(broken));
  assert.equal(cameraDuration(24), 120); assert.equal(cameraDuration(240), 600);
});
test('performance validation rejects occupied endpoints and checks parallel final positions together', () => {
  const maps = new Map(world.maps.map(m => [m.id, read(m.file)])), content = structuredClone(campaign);
  const stage = { type: 'stage' as const, map: 'shadow-camp', x: 120, y: 312, facing: 'south' as const, playerVisible: true,
    cast: [{ id: 'soldier', actor: 'shadow-soldier', x: 184, y: 312, facing: 'west' as const, visible: true }] };
  content.scripts.demo = compileScript('demo', [stage, { type: 'appear', target: 'soldier', x: 120, y: 312, facing: 'west' }]);
  assert.throws(() => validateStoryPerformance(world, content, maps), /人物落位被地形或其他人物阻挡/);
  content.scripts.demo = compileScript('demo', [stage, { type: 'parallel', actions: [
    { type: 'appear', target: 'player', x: 184, y: 312, facing: 'east' },
    { type: 'appear', target: 'soldier', x: 120, y: 312, facing: 'west' }
  ] }]);
  assert.doesNotThrow(() => validateStoryPerformance(world, content, maps));
});

test('resource validation checks every incoming cast at a branch merge and verifies story audio cues', () => {
  const content = structuredClone(campaign);
  const stage = { type: 'stage' as const, map: 'shadow-camp', x: 120, y: 312, facing: 'south' as const, playerVisible: true, cast: [] };
  content.scripts.demo = { entry: 'entry', nodes: [
    { id: 'entry', presentation: [stage], commands: [], exit: { type: 'branch', condition: { type: 'always', value: true }, then: { script: 'demo', node: 'with-soldier' }, otherwise: { script: 'demo', node: 'merge' } } },
    { id: 'with-soldier', presentation: [{ ...stage, cast: [{ id: 'soldier', actor: 'shadow-soldier', x: 184, y: 312, facing: 'west', visible: true }] }], commands: [], exit: { type: 'next', target: { script: 'demo', node: 'merge' } } },
    { id: 'merge', presentation: [{ type: 'face', target: 'soldier', facing: 'east' }], commands: [], exit: { type: 'end' } }
  ] };
  assert.throws(() => validateStoryPerformance(world, content), /人物未出场 soldier/);
  const audio = read('content/audio.json');
  content.scripts.demo = compileScript('demo', [{ type: 'sound', sound: 'unknown' }]);
  assert.throws(() => validateStoryPerformance(world, content, undefined, audio), /音效缺失 unknown/);
  content.scripts.demo = compileScript('demo', [{ type: 'music', sound: 'unknown' }]);
  assert.throws(() => validateStoryPerformance(world, content, undefined, audio), /音乐缺失 unknown/);
  content.scripts.demo = compileScript('demo', [{ ...stage, audio: { music: null, ambience: 'unknown' } }]);
  assert.throws(() => validateStoryPerformance(world, content, undefined, audio), /环境音缺失 unknown/);
});

test('resource validation returns a called script cast to its caller', () => {
  const content = structuredClone(campaign);
  content.scripts.demo = { entry: 'call', nodes: [
    { id: 'call', presentation: [], commands: [], exit: { type: 'call', target: { script: 'callee', node: 'stage' }, then: { script: 'demo', node: 'return' } } },
    { id: 'return', presentation: [{ type: 'face', target: 'soldier', facing: 'east' }], commands: [], exit: { type: 'end' } }
  ] };
  content.scripts.callee = { entry: 'stage', nodes: [
    { id: 'stage', presentation: [{ type: 'stage', map: 'shadow-camp', x: 120, y: 312, facing: 'south', playerVisible: true,
      cast: [{ id: 'soldier', actor: 'shadow-soldier', x: 184, y: 312, facing: 'west', visible: true }] }], commands: [], exit: { type: 'end' } }
  ] };
  assert.doesNotThrow(() => validateStoryPerformance(world, content));
  const stage = content.scripts.callee.nodes[0].presentation[0];
  if (stage.type === 'stage') stage.cast = [];
  assert.throws(() => validateStoryPerformance(world, content), /人物未出场 soldier/);
});


test('a current-scene declaration resolves to the live map and actor positions before saving',()=>{
  const current={type:'stage' as const,map:'actual-battlefield',x:120,y:88,facing:'east' as const,playerVisible:true,
    cast:[{id:'world-elder',actor:'elder',x:60,y:40,facing:'west' as const,visible:true}]};
  const declaration={type:'stage' as const,map:'preview-only',mapFromWorld:true,x:8,y:8,facing:'south' as const,
    playerVisible:true,retainPlayerPosition:true,cast:[
      {id:'elder',actor:'elder',x:8,y:8,facing:'south' as const,visible:true,inheritPosition:true},
      {id:'absent',actor:'absent',x:8,y:8,facing:'south' as const,visible:true,inheritPosition:true},
      {id:'arrival',actor:'guard',x:200,y:72,facing:'north' as const,visible:true},
    ]};
  const stage=resolveStoryScene(declaration,stageSnapshot(current).scene);
  assert.equal(stage.map,'actual-battlefield');assert.equal(stage.mapFromWorld,undefined);
  assert.deepEqual([stage.x,stage.y,stage.facing],[120,88,'east']);
  assert.deepEqual([stage.cast[0].x,stage.cast[0].y,stage.cast[0].facing],[60,40,'west']);
  assert.equal(stage.cast[1].visible,false);
  assert.deepEqual([stage.cast[2].x,stage.cast[2].y],[200,72]);
  assert.equal(declaration.mapFromWorld,true,'解析不能改变内容声明');
});
