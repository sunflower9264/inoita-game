import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { StoryDirector, type StoryUI, type StoryWorldPort, type StorySkipPhase } from '../src/domain/story-director.ts';
import type { StoryPresentationPort } from '../src/domain/story-performance.ts';
import { Session } from '../src/domain/session.ts';
import { compileScript } from './support/story-fixtures.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { StoryScript } from '../src/domain/story-graph.ts';
import type { ChoiceOption } from '../src/domain/content.ts';
import { parseCampaign, parseControlSkin } from '../src/application/content-validation.ts';

const campaign = parseCampaign(JSON.parse(fs.readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8')));
function harness(content: Campaign = campaign, overrides: Partial<StoryUI> = {}, world?: StoryWorldPort,
  presentation: Partial<StoryPresentationPort> = {}) {
  const session = new Session(content), lines: string[] = [], locks: boolean[] = [];
  let finish: (() => void) | undefined, choose: ((option: ChoiceOption) => void) | undefined;
  let cancel: (() => void) | undefined, flushes = 0;
  const ui: StoryUI = {
    dialogue: (line, signal) => new Promise<void>((resolve, reject) => {
      lines.push(line.text);
      const abort = () => { clean(); reject(new DOMException('cancelled', 'AbortError')); };
      const clean = () => { signal?.removeEventListener('abort', abort); finish = undefined; cancel = undefined; };
      finish = () => { clean(); resolve(); }; cancel = abort;
      signal?.addEventListener('abort', abort, { once: true });
    }),
    choice: () => new Promise(resolve => { choose = resolve; }),
    async questPopup() {},
    skipDialogue: () => finish?.(), closeDialogue: () => cancel?.(), ...overrides
  };
  const backdrops: boolean[] = [];
  const director = new StoryDirector(content, session, ui, value => locks.push(value), { begin() {}, async execute() {}, async finish() {},
    async flushStage() { flushes++; }, setBackdrop(covered: boolean) { backdrops.push(covered); }, ...presentation }, world);
  return { director, session, lines, locks, backdrops: () => backdrops, flushes: () => flushes,
    finish: () => finish?.(), choose: (option: ChoiceOption) => choose!(option) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('skip stops at choices, resumes selected lines normally and preserves completion flags', async () => {
  const option = { label: '继续', value: 'go', lines: [{ speaker: '', actor: null, text: '选项后的对白' }] };
  const h = harness({ ...campaign, scripts: { ...campaign.scripts, demo: compileScript('demo', [
    { type: 'dialogue', speaker: '', actor: null, text: '第一句' }, { type: 'dialogue', speaker: '', actor: null, text: '第二句' },
    { type: 'choice', prompt: '选择', options: [option] }, { type: 'dialogue', speaker: '', actor: null, text: '最后一句' }
  ]) } });
  const result = h.director.trigger({ id: 'demo-trigger', script: 'demo', map: 'shadow-camp', x: 0, y: 0, width: 10, height: 10 });
  await tick();
  h.director.skip(); await tick();
  assert.deepEqual(h.lines, ['第一句']); assert.equal(h.director.busy, true);
  assert.equal(h.flushes(), 1, '选择框出现前先把逻辑舞台补画一次');
  assert.deepEqual(h.backdrops(), [true, false], '补画期间用黑底遮住，补完露出画面再弹选择框');
  h.director.skip(); h.choose(option); await tick();
  assert.deepEqual(h.lines, ['第一句', '选项后的对白']);
  h.director.skip(); assert.equal(await result, true);
  assert.equal(h.session.flags.has('choice:demo:go'), true);
  assert.equal(h.session.flags.has('demo-trigger'), true);
  assert.deepEqual(h.locks, [true, false]);
  const replay = h.director.run(() => h.director.script('demo'));
  await tick();
  assert.equal(h.lines.at(-1), '第一句'); h.director.cancel(); assert.equal(await replay, false);
});
test('跳过补画前先收掉旧对白框再盖黑底', async () => {
  const option = { label: '继续', value: 'go', lines: [] };
  const events: string[] = [];
  const h = harness({ ...campaign, scripts: { ...campaign.scripts, demo: compileScript('demo', [
    { type: 'dialogue', speaker: '', actor: null, text: '一句' },
    { type: 'choice', prompt: '选择', options: [option] }
  ]) } }, { closeDialogue: () => { events.push('close-dialogue'); } }, undefined, {
    async flushStage() { events.push('flush'); },
    setBackdrop(covered: boolean) { events.push(covered ? 'backdrop-on' : 'backdrop-off'); }
  });
  const playing = h.director.trigger({ id: 'close-before-backdrop', script: 'demo', map: 'shadow-camp', x: 0, y: 0, width: 10, height: 10 });
  await tick(); h.director.skip(); await tick();
  const on = events.indexOf('backdrop-on'), flush = events.indexOf('flush'), off = events.indexOf('backdrop-off');
  assert(on >= 0 && flush > on && off > flush, `补画在黑底内完成：${events.join(',')}`);
  assert(events.slice(0, on).includes('close-dialogue'), '盖黑底前先收掉对白框');
  h.choose(option);
  await playing.catch(() => {});
});

test('补画失败时跳过黑底仍会关闭', async () => {
  const option = { label: '继续', value: 'go', lines: [] };
  const h = harness({ ...campaign, scripts: { ...campaign.scripts, demo: compileScript('demo', [
    { type: 'dialogue', speaker: '', actor: null, text: '一句' },
    { type: 'choice', prompt: '选择', options: [option] }
  ]) } }, {}, undefined, { async flushStage() { throw new Error('补画失败'); } });
  const playing = h.director.trigger({ id: 'flush-fails', script: 'demo', map: 'shadow-camp', x: 0, y: 0, width: 10, height: 10 });
  await tick(); h.director.skip();
  await playing.catch(() => {});
  assert.deepEqual(h.backdrops(), [true, false], '补画失败也要撤掉黑底');
});

test('正常播放到选项时不打开跳过黑底', async () => {
  const option = { label: '继续', value: 'go', lines: [] };
  const h = harness({ ...campaign, scripts: { ...campaign.scripts, demo: compileScript('demo', [
    { type: 'choice', prompt: '选择', options: [option] }
  ]) } });
  const playing = h.director.trigger({ id: 'no-skip', script: 'demo', map: 'shadow-camp', x: 0, y: 0, width: 10, height: 10 });
  await tick();
  assert.deepEqual(h.backdrops(), []);
  h.choose(option);
  await playing.catch(() => {});
  assert.deepEqual(h.backdrops(), [], '正常播放不盖黑底');
});

test('cancelling playback does not mark a skipped trigger complete or carry skip into the next run', async () => {
  const h = harness({ ...campaign, scripts: { ...campaign.scripts, demo: compileScript('demo', [{ type: 'dialogue', speaker: '', actor: null, text: '一句' }, { type: 'dialogue', speaker: '', actor: null, text: '两句' }]) } });
  const trigger = { id: 'cancelled', script: 'demo', map: 'shadow-camp', x: 0, y: 0, width: 10, height: 10 };
  const first = h.director.trigger(trigger); await tick(); h.director.skip(); h.director.cancel();
  assert.equal(await first, false); assert.equal(h.session.flags.has(trigger.id), false);
  const second = h.director.trigger(trigger); await tick(); assert.deepEqual(h.lines, ['一句', '一句']);
  h.finish(); await tick(); assert.equal(h.lines.at(-1), '两句'); h.finish(); assert.equal(await second, true);
});
test('shared control skin rejects missing or external images', () => {
  const skin = JSON.parse(fs.readFileSync(new URL('../public/content/control-skin.json', import.meta.url), 'utf8'));
  parseControlSkin(skin); delete skin['skip-pressed']; assert.throws(() => parseControlSkin(skin), /skip-pressed/);
  skin['skip-pressed'] = 'https://example.com/icon.png'; assert.throws(() => parseControlSkin(skin), /内部资源/);
});

test('跳过落在界面建立对白等待之前时，导演仍会结束这一句并解锁', async () => {
  const h = harness({ ...campaign, scripts: { ...campaign.scripts, demo: compileScript('demo', [
    { type: 'dialogue', speaker: '', actor: null, text: '一句' },
    { type: 'dialogue', speaker: '', actor: null, text: '两句' }
  ]) } }, {
    // 模拟按钮按下时界面还在准备立绘：等待尚未建立，skipDialogue 结束时无处可放。
    dialogue: (_line, signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }),
    skipDialogue: () => {}
  });
  const playing = h.director.trigger({ id: 'skip-before-pending', script: 'demo' });
  await tick(); h.director.skip();
  assert.equal(await playing, true);
  assert.deepEqual(h.locks, [true, false]);
});

test('跳过时仍发起后续节点的世界预取，但不等待加载完成', async () => {
  const script: StoryScript = { entry: 'one', nodes: [
    { id: 'one', presentation: [{ type: 'dialogue', speaker: '', actor: null, text: '一句' }], commands: [],
      exit: { type: 'next', target: { script: 'demo', node: 'two' } } },
    { id: 'two', presentation: [{ type: 'dialogue', speaker: '', actor: null, text: '两句' }], commands: [],
      exit: { type: 'end' } }
  ] };
  let preparations = 0, finishSecond!: () => void;
  const h = harness({ ...campaign, scripts: { ...campaign.scripts, demo: script } }, {}, {
    capture: () => undefined, restore: async () => {}, project: async () => {}, checkpoint: () => {},
    normalize: async () => {}, settle: async () => {}, prefetch: async () => {},
    prepare: () => {
      preparations++;
      return preparations === 1 ? Promise.resolve() : new Promise<void>(resolve => { finishSecond = resolve; });
    }
  });
  const playing = h.director.trigger({ id: 'skip-prepare', script: 'demo' });
  await tick(); h.director.skip();
  assert.equal(await playing, true);
  assert.equal(preparations, 2, '跳过后的节点仍发起预取');
  finishSecond();
  assert.deepEqual(h.locks, [true, false]);
});

test('早按和晚按跳过都等正式世界结算，只结束对素材的等待', async () => {
  for (const when of ['结算期间','预取期间']) {
    let finishSettlement!:()=>void, finishAssets!:()=>void;
    const script:StoryScript={entry:'end',nodes:[{id:'end',presentation:[],commands:[],exit:{type:'end'}}]};
    const h=harness({...campaign,scripts:{...campaign.scripts,demo:script}}, {}, {
      capture(){},async restore(){},async project(){},checkpoint(){},
      normalize:()=>new Promise<void>(resolve=>{finishSettlement=resolve;}),
      prepare:()=>new Promise<void>(resolve=>{finishAssets=resolve;}),
    });
    try {
      const playing=h.director.trigger({id:'skip-prepare',script:'demo'});
      await tick();
      if(when==='结算期间')h.director.skip();
      assert.equal(finishAssets,undefined);
      assert.deepEqual(h.locks,[true]);
      finishSettlement();
      await tick();
      if(when==='预取期间')h.director.skip();
      assert.equal(await playing,true);
      assert.deepEqual(h.locks,[true,false]);
    } finally { finishAssets?.();h.director.dispose(); }
  }
});

test('跳过不等卡住的立绘预取，剧情仍会结束并解锁', async () => {
  const h = harness({ ...campaign, scripts: { ...campaign.scripts, demo: compileScript('demo', [
    { type: 'dialogue', speaker: '', actor: null, text: '一句' }
  ]) } }, {}, {
    capture: () => undefined, restore: async () => {}, project: async () => {}, checkpoint: () => {},
    normalize: async () => {}, settle: async () => {},
    // 模拟一直加载不完的立绘/音效：跳过只结束等待，不取消后台准备。
    prefetch: () => new Promise<void>(() => {})
  });
  const playing = h.director.trigger({ id: 'skip-prefetch', script: 'demo' });
  await tick(); h.director.skip();
  assert.equal(await playing, true);
  assert.deepEqual(h.locks, [true, false]);
});

test('跳过后同一脚本复用仍在加载的立绘准备', async () => {
  const script: StoryScript = {entry:'one',nodes:[
    {id:'one',presentation:[],commands:[],exit:{type:'next',target:{script:'demo',node:'two'}}},
    {id:'two',presentation:[],commands:[],exit:{type:'end'}}
  ]};
  let calls=0;
  const h=harness({...campaign,scripts:{...campaign.scripts,demo:script}}, {}, {
    capture:()=>undefined,restore:async()=>{},project:async()=>{},checkpoint:()=>{},
    prefetch:()=>{calls++;return new Promise<void>(()=>{});}
  });
  const playing=h.director.trigger({id:'skip-prefetch-once',script:'demo'});
  await tick();h.director.skip();
  assert.equal(await playing,true);
  assert.equal(calls,1);
});

test('skip progress marks the final commit and actual input unlock in order', async () => {
  const h = harness({ ...campaign, scripts: { ...campaign.scripts, demo: compileScript('demo', [
    { type: 'dialogue', speaker: '', actor: null, text: '先等玩家点击跳过' }
  ]) } });
  const phases: StorySkipPhase[] = [];
  h.director.onSkipProgress = phase => {
    phases.push(phase);
    if (phase === 'released') assert.equal(h.director.busy, false);
  };
  const playing = h.director.trigger({ id: 'fixture-skip-timing', script: 'demo' });
  await tick(); h.director.skip(); h.director.skip(); await playing;
  assert.equal(phases.filter(phase => phase === 'requested').length, 1);
  assert.deepEqual(phases.slice(-3), ['logic-complete', 'world-ready', 'released']);
});
