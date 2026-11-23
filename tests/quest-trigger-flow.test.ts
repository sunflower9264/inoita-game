import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuestRewardReceipt } from '../src/domain/content.ts';
import { moneyGain } from '../src/domain/economy.ts';
import type { SessionState } from '../src/domain/session.ts';
import { questScenario } from './support/quest-scenario.ts';

test('a region event accepts the hunt, two kills make it ready, and one NPC interaction settles the reward', async () => {
  const h = questScenario();
  try {
    assert.equal(h.session.status('hunt'), 'available');

    assert.equal(await h.region('accept-event'), true);
    assert.equal(h.session.status('hunt'), 'active');
    assert.deepEqual(h.popups, ['start:hunt']);
    assert.equal(h.director.runtime.eventStatus('accept-event'), 'completed');

    // 同一次区域事件只播一次；再走一遍不会重新接取或重复弹窗。
    assert.equal(await h.region('accept-event'), false);
    assert.equal(h.session.status('hunt'), 'active');
    assert.deepEqual(h.popups, ['start:hunt']);

    await h.kill();
    assert.equal(h.session.quests.get('hunt')!.goals.objective, 1);
    assert.equal(h.session.status('hunt'), 'active');
    await h.kill();
    assert.equal(h.session.quests.get('hunt')!.goals.objective, 2);
    assert.equal(h.session.status('hunt'), 'ready');
    // 击杀事件只由第一只野猪触发一次。
    assert.equal(h.director.runtime.eventStatus('boar-down'), 'completed');
    assert.equal(h.lines.filter(line => line.includes('野猪少了一头')).length, 1);

    const money = h.session.money;
    assert.equal(await h.interact(), true);
    assert.equal(h.session.status('hunt'), 'completed');
    assert.deepEqual(h.session.rewardReceiptFor('hunt'),
      { experience: 120, money: moneyGain(30), items: [] });
    assert.equal(h.session.money, money + moneyGain(30));
    assert.deepEqual(h.popups, ['start:hunt', 'complete:hunt']);

    // 已交付的任务再交互不会新增回执，也不能被普通完成入口结算第二次。
    const receipts = h.session.captureState().receipts;
    await h.interact();
    assert.deepEqual(h.session.captureState().receipts, receipts);
    assert.equal(h.session.complete('hunt'), false);
    assert.equal(h.session.money, money + moneyGain(30));
  } finally {
    h.dispose();
  }
});

test('a quest with interactionEvent rejects ordinary completion and settles through the near story event', async () => {
  const h = questScenario();
  try {
    h.session.applyStoryCommands([{ type: 'flag', flag: 'gate-open' }]);
    assert.equal(h.session.accept('gated'), true);
    h.session.applyStoryCommands([{ type: 'quest', command: { type: 'script-ready', quest: 'gated' } }]);
    assert.equal(h.session.status('gated'), 'ready');

    // interactionEvent 保护普通交付入口，只能由剧情脚本结算。
    assert.equal(h.session.complete('gated'), false);
    assert.equal(h.session.status('gated'), 'ready');

    assert.equal(await h.interact(), true);
    assert.equal(h.session.status('gated'), 'completed');
    assert.equal(h.director.runtime.eventStatus('gate-event'), 'completed');
    assert.deepEqual(h.popups, ['complete:gated']);
    assert.deepEqual(h.session.rewardReceiptFor('gated'),
      { experience: 0, money: moneyGain(5), items: [] });
  } finally {
    h.dispose();
  }
});

test('capturing and restoring the session keeps quest progress and does not replay settled triggers', async () => {
  const accepted = questScenario();
  let afterAccept!: SessionState;
  try {
    await accepted.region('accept-event');
    afterAccept = accepted.session.capturePersistentState();
  } finally {
    accepted.dispose();
  }

  const restored = questScenario(afterAccept);
  let ready!: SessionState;
  try {
    assert.equal(restored.session.status('hunt'), 'active');
    // 已完成的一次性区域事件不会因为读档重播。
    assert.equal(await restored.region('accept-event'), false);
    assert.deepEqual(restored.popups, []);

    await restored.kill();
    await restored.kill();
    assert.equal(restored.session.status('hunt'), 'ready');
    assert.equal(restored.session.quests.get('hunt')!.goals.objective, 2);
    ready = restored.session.capturePersistentState();
  } finally {
    restored.dispose();
  }

  const delivered = questScenario(ready);
  let final!: SessionState, receipt: QuestRewardReceipt | undefined;
  const money = delivered.session.money;
  try {
    assert.equal(delivered.session.status('hunt'), 'ready');
    assert.deepEqual(delivered.session.quests.get('hunt')!.goals, { objective: 2 });
    await delivered.interact();
    assert.equal(delivered.session.status('hunt'), 'completed');
    receipt = delivered.session.rewardReceiptFor('hunt');
    assert.deepEqual(receipt, { experience: 120, money: moneyGain(30), items: [] });
    final = delivered.session.capturePersistentState();
  } finally {
    delivered.dispose();
  }

  const reloaded = questScenario(final);
  try {
    assert.equal(reloaded.session.status('hunt'), 'completed');
    assert.deepEqual(reloaded.session.rewardReceiptFor('hunt'), receipt);
    assert.equal(reloaded.session.money, money + moneyGain(30));
    assert.equal(reloaded.session.complete('hunt'), false);
  } finally {
    reloaded.dispose();
  }
});
