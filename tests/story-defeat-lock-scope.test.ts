import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import type { Campaign } from '../src/domain/campaign.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector } from '../src/domain/story-director.ts';
import { GameUI } from '../src/ui/game-ui.ts';

// 真实 `GameUI` 不依赖 Phaser；`WorldScene` 的两个方法要用到真实原型，所以短路掉 phaser 再动态导入。
const hook = registerHooks({ resolve(specifier, context, next) { return specifier === 'phaser'
  ? { url: 'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}', shortCircuit: true }
  : next(specifier, context); } });
const { WorldScene } = await import('../src/scenes/world-scene.ts'); hook.deregister();

const campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8')) as Campaign;
const presentation = { begin() {}, async execute() {}, async finish() {}, async release() {} };
const spawn = (enemyId: string) => ({ id: 'killed:' + enemyId, enemyId, x: 0, y: 0 });
/** 等导演彻底空闲：drain 收尾之后，放锁还隔着 `release()` 的几段微任务链。 */
async function idle(director: StoryDirector): Promise<void> {
  for (let i = 0; i < 50; i++) { await tick(); if (!director.busy) return; }
  assert.fail('导演没有在有限调度次数内空闲');
}

/**
 * 装配与 `main.ts:282-286` 同一套接线：锁回调调真实 `ui.lock`，显示对象用只记录可见性的替身，
 * `resetInput`/`syncHud` 用真实原型。这样断言的就是玩家看得见的那层效果，而不只是锁数组。
 */
function harness(content: Campaign = campaign) {
  const session = new Session(content), ui = new GameUI(), visible: Record<string, boolean | undefined> = {}, locks: boolean[] = [];
  ui.mode = 'game'; ui.ready = true;
  // 真实对白会等玩家按键，测试里没人按键。只有演出交互让开；锁、输入重置与 HUD 可见性
  // 走的仍是真实 `GameUI` 与真实 `WorldScene` 方法——那才是本次要钉住的那层。
  ui.dialogue = async () => {}; ui.choice = async (_prompt, options) => options[0]; ui.questPopup = async () => {};
  const counters = { resets: 0, stops: 0, idleAssignments: 0, pauses: [] as boolean[] };
  const view = (name: string) => ({ setVisible(value: boolean) { visible[name] = value; }, reset() {}, resetInput() {}, setAttack() {}, sync() {} });
  const host = {
    get canControl() { return !ui.locked; }, get canCombatControl() { return !ui.locked; },
    performing: false, loadingWorld: false, sys: { isActive: () => true }, app: { ui, suspended: false, session },
    player: { container: {} }, movement: { stop() { counters.stops++; } },
    combat: { setPaused(value: boolean) { counters.pauses.push(value); }, hasHostileTarget: () => false },
    chestFades: new Map(), near: null, refreshCombatTarget() {},
    stick: view('stick'), controls: view('controls'), minimap: view('minimap'), statusHud: { ...view('statusHud'), setTarget() {} }, overheadStatus: view('overhead'),
    syncHud() { WorldScene.prototype.syncHud.call(this); },
  };
  ui.onStateChange = () => host.syncHud();
  ui.onResetInput = () => { counters.resets++; WorldScene.prototype.resetInput.call(host); };
  const director = new StoryDirector(content, session, ui, locked => {
    locks.push(locked); ui.lock(locked, 'game'); if (locked) counters.idleAssignments++;
  }, presentation);
  host.syncHud();
  return { session, ui, director, locks, visible, counters };
}

test('a defeat with no matching battle event leaves the input, the pose and the HUD untouched', async () => {
  // 每杀一只普通怪都会报一次 `defeat:`，而内容里只有十几条击败事件。没有匹配就不该接管游戏：
  // 上锁会重置输入、停移动、把主角切回待机并隐藏摇杆与各面板。
  const h = harness();
  assert.deepEqual(campaign.events.filter(event => event.source === 'battle' && event.key === 'defeat:enemy-wolf-1'), []);
  const beforeVisible = { ...h.visible };
  const factBefore = h.session.captureState().factSequences.find(([source]) => source === 'combat')?.[1] ?? 0;

  h.session.enemyDefeated(spawn('enemy-wolf-1'));

  // 同步返回时就该什么都没发生——本次死亡结算发生在场景更新中途，中间状态会被绘制出来。
  assert.deepEqual(h.locks, []); assert.equal(h.ui.locked, false); assert.equal(h.director.busy, false);
  assert.deepEqual(h.visible, beforeVisible);
  await idle(h.director);
  assert.deepEqual(h.locks, []); assert.equal(h.ui.locked, false);
  assert.deepEqual(h.visible, beforeVisible);
  assert.deepEqual(h.counters, { resets: 0, stops: 0, idleAssignments: 0, pauses: [] });
  assert.deepEqual(h.director.runtime.snapshot().runs, []);

  // 反向哨兵：界面不动不等于死亡没被记账，事实序列仍要前进（防止「把通知整个删掉」式假修复）。
  const factAfter = h.session.captureState().factSequences.find(([source]) => source === 'combat')?.[1] ?? 0;
  assert.equal(factAfter, factBefore + 1);
  h.director.dispose();
});

for (const [enemy, event, previous] of [
  ['enemy-head-werewolf-1', 'event-61', 'quest-46'],
  ['enemy-zahad-kuruhatt-1', 'event-112', 'quest-123'],
]) test(`${event} still takes the lock exactly once and plays exactly once`, async () => {
  // 修复只该拦住「没有剧情」的通知；真正要播的击败剧情必须照旧接管一次。
  const trigger = campaign.events.find(candidate => candidate.id === event)!;
  assert.equal(trigger.key, 'defeat:' + enemy);
  const h = harness({ ...campaign, events: [trigger] });
  // 这段戏发生在战斗地图上，运行时给 `mapFromStage` 的物件定位要读「当前地图」（见 story-native-triggers）。
  const battleMap = campaign.scripts[event].nodes.flatMap(node => node.presentation).find(action => action.type === 'stage')!.map;
  h.session.storyWorld.apply({ kind: 'travel', destination: { map: battleMap, x: 0, y: 0, facing: 'south' } });
  h.session.applyStoryCommands([{ type: 'quest', command: { type: 'accept', quest: previous } }]);

  h.session.enemyDefeated(spawn(enemy)); await idle(h.director);
  assert.deepEqual(h.locks, [true, false]);
  assert.equal(h.director.runtime.eventStatus(event), 'completed');
  assert.equal(h.director.busy, false); assert.equal(h.ui.locked, false);

  // 同一只怪再死一次不再产生新的锁对，界面也不再被接管。
  h.session.enemyDefeated(spawn(enemy)); await idle(h.director);
  assert.deepEqual(h.locks, [true, false]);
  h.director.dispose();
});

test('an unmatched defeat cannot release a story run that already holds the lock', async () => {
  // 手动剧情（治疗师、菜单流程走 `StoryDirector.run`）持有锁时，旁边的普通怪死亡不该把它放掉。
  const h = harness();
  let finish!: () => void;
  const running = h.director.run(() => new Promise<void>(resolve => { finish = resolve; }));
  await tick();
  assert.deepEqual(h.locks, [true]);

  h.session.enemyDefeated(spawn('enemy-wolf-1')); await tick(); await tick();
  assert.equal(h.director.busy, true); assert.equal(h.ui.locked, true); assert.deepEqual(h.locks, [true]);

  finish(); await running; await idle(h.director);
  assert.deepEqual(h.locks, [true, false]); assert.equal(h.ui.locked, false);
  h.director.dispose();
});
