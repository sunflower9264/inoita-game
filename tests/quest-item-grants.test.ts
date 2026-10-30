import assert from 'node:assert/strict';
import test from 'node:test';
import { questItemOverflows, storyItemNetGrants, type QuestGrantSource } from '../src/application/quest-item-grants.ts';

const quest = (id: string, accept: number, required: number, item = 'stone') => ({
  id,
  onAcceptItems: accept ? Array.from({ length: accept }, () => ({ item, quantity: 1 })) : undefined,
  handoverItems: required ? [{ item, quantity: required }] : undefined,
});
const script = (gives: { item: string; quantity: number }[]) => ({
  nodes: [{ commands: gives.map(give => ({ type: 'item-give' as const, ...give })) }],
});

test('剧情已经发过的道具不再重复接取发放', () => {
  const campaign: QuestGrantSource = { quests: [quest('quest-1', 1, 1)], scripts: { event: script([{ item: 'stone', quantity: 1 }]) } };
  assert.deepEqual(questItemOverflows(campaign), [{ quest: 'quest-1', item: 'stone', granted: 2, required: 1 }]);
});

test('接取发放写了两条同样的记录算超发', () => {
  const campaign: QuestGrantSource = { quests: [quest('quest-1', 2, 1)], scripts: {} };
  assert.deepEqual(questItemOverflows(campaign), [{ quest: 'quest-1', item: 'stone', granted: 2, required: 1 }]);
});

test('发够交付量就不报', () => {
  const campaign: QuestGrantSource = { quests: [quest('quest-1', 1, 1)], scripts: {} };
  assert.deepEqual(questItemOverflows(campaign), []);
});

test('靠打怪或采集凑的道具没有发放记录，也不算超发', () => {
  const campaign: QuestGrantSource = { quests: [quest('quest-1', 0, 3)], scripts: {} };
  assert.deepEqual(questItemOverflows(campaign), []);
});

test('剧情净发放按物品累计', () => {
  const campaign: QuestGrantSource = {
    quests: [],
    scripts: { a: script([{ item: 'stone', quantity: 1 }]), b: script([{ item: 'stone', quantity: 2 }, { item: 'key', quantity: 1 }]) },
  };
  assert.deepEqual([...storyItemNetGrants(campaign)], [['stone', 3], ['key', 1]]);
});

test('递交演出先给一件再收回一件，净额是零', () => {
  const campaign: QuestGrantSource = {
    quests: [quest('quest-1', 0, 1)],
    scripts: { a: { nodes: [{ commands: [{ type: 'item-take', item: 'stone', quantity: 1 }, { type: 'item-give', item: 'stone', quantity: 1 }] }] } },
  };
  assert.deepEqual(questItemOverflows(campaign), []);
});

test('收回去的只在净额里抵扣，不会把接取发放挤掉', () => {
  const campaign: QuestGrantSource = {
    quests: [quest('quest-1', 1, 1)],
    scripts: { a: { nodes: [{ commands: [{ type: 'item-take', item: 'stone', quantity: 1 }] }] } },
  };
  assert.deepEqual(questItemOverflows(campaign), []);
});
