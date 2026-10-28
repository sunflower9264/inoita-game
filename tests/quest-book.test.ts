import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestBook, type QuestCommand, type QuestContext, type QuestRules } from '../src/domain/quest-book.ts';

function rules(id: string, patch: Partial<QuestRules> = {}): QuestRules {
  return { id, completion: 'talk', goals: [], ...patch };
}
function fixture(definitions: QuestRules[], side: string[] = []) {
  const inventory = new Map<string, number>(), equipped = new Map<string, number>();
  const flags = new Set<string>();
  const context: QuestContext = { classId: 'priest', itemCount: id => inventory.get(id) ?? 0,
    equippedItemCount: id => equipped.get(id) ?? 0, questStatus: () => 'locked', eventStatus: () => 'idle',
    choice: () => undefined, flag: id => flags.has(id), world: () => undefined };
  const book = new QuestBook(definitions, () => context, new Set(side));
  const commit = (commands: QuestCommand | readonly QuestCommand[]) => {
    const plan = book.plan(commands);
    // The application preflights capacity and commits these deltas with the book in one synchronous transaction.
    for (const { item, quantity } of plan.itemRemovals) inventory.set(item, inventory.get(item)! - quantity);
    for (const { item, quantity } of plan.itemGrants) inventory.set(item, (inventory.get(item) ?? 0) + quantity);
    book.commit(plan); return plan;
  };
  return { book, commit, inventory, equipped, flags };
}

test('original quest 29 requires both materials and readiness decreases when an item is lost', () => {
  const { book, commit, inventory } = fixture([rules('limestone-food', { completion: 'all', goals: [
    { id: 'maggot-meat', kind: 'item', target: 'limestone-maggot-meat', quantity: 5 },
    { id: 'bat-cartilage', kind: 'item', target: 'vampire-bat-cartilage', quantity: 5 },
  ], handoverItems: [{ item: 'limestone-maggot-meat', quantity: 5 }, { item: 'vampire-bat-cartilage', quantity: 5 }],
  rewards: { experience: 2340, money: 0, items: [{ item: 'healing-potion-small', quantity: 5 }] } })]);
  commit({ type: 'accept', quest: 'limestone-food' });
  inventory.set('limestone-maggot-meat', 5); commit({ type: 'refresh' });
  assert.equal(book.status('limestone-food'), 'active');
  assert.deepEqual(book.state('limestone-food')!.goals, { 'maggot-meat': 5, 'bat-cartilage': 0 });
  inventory.set('vampire-bat-cartilage', 5); commit({ type: 'refresh' });
  assert.equal(book.status('limestone-food'), 'ready');
  inventory.set('vampire-bat-cartilage', 4); commit({ type: 'refresh' });
  assert.equal(book.status('limestone-food'), 'active');
  inventory.set('vampire-bat-cartilage', 5); const settlement = commit({ type: 'complete', quest: 'limestone-food', cycle: 0 });
  assert.equal(book.status('limestone-food'), 'completed');
  assert.equal(inventory.get('limestone-maggot-meat'), 0); assert.equal(inventory.get('vampire-bat-cartilage'), 0);
  assert.deepEqual(settlement.rewards[0].reward, { experience: 2340, money: 0, items: [{ item: 'healing-potion-small', quantity: 5 }] });
});

test('original quest 223 unlocks after accepting both predecessors, without requiring settlement', () => {
  const { book, commit, inventory } = fixture([rules('quest-215', { completion: 'story' }), rules('quest-195', { completion: 'story' }),
    rules('quest-223', { completion: 'all', goals: [{ id: 'possessions', kind: 'item', target: 'hunters-possessions', quantity: 1 }],
      onAcceptItems: [{ item: 'hunters-possessions', quantity: 1 }], handoverItems: [{ item: 'hunters-possessions', quantity: 1 }],
      rewards: { experience: 12540, money: 510, items: [] }, availableWhen: { type: 'all', conditions: [
      { type: 'quest', quest: 'quest-215', status: 'accepted' }, { type: 'quest', quest: 'quest-195', status: 'accepted' },
    ] } })]);
  assert.equal(book.status('quest-223'), 'locked'); commit({ type: 'accept', quest: 'quest-215' });
  assert.equal(book.status('quest-223'), 'locked'); commit({ type: 'accept', quest: 'quest-195' });
  assert.equal(book.status('quest-223'), 'available'); assert.equal(book.status('quest-215'), 'active');
  commit({ type: 'accept', quest: 'quest-223' }); assert.equal(inventory.get('hunters-possessions'), 1);
  assert.equal(book.status('quest-223'), 'ready');
  assert.deepEqual(commit({ type: 'complete', quest: 'quest-223' }).rewards[0].reward, { experience: 12540, money: 5100, items: [] });
});

test('original quest 168 completes only on successful recruitment using the warrior emblem', () => {
  const { book, commit, inventory } = fixture([rules('uniform'), rules('recruit-warrior', { completion: 'all',
    availableWhen: { type: 'quest', quest: 'uniform', status: 'settled' }, onAcceptItems: [{ item: 'order-warrior-emblem', quantity: 1 }],
    rewards: { experience: 1660, money: 0, items: [] }, goals: [
    { id: 'summon', kind: 'recruit', target: 'order-warrior-emblem', quantity: 1 },
  ] })]);
  assert.equal(book.status('recruit-warrior'), 'locked');
  commit([{ type: 'accept', quest: 'uniform' }, { type: 'script-ready', quest: 'uniform' }, { type: 'complete', quest: 'uniform' }]);
  commit({ type: 'accept', quest: 'recruit-warrior' });
  assert.equal(inventory.get('order-warrior-emblem'), 1);
  // Failed recruitment never publishes a recruit fact; neither item use nor another emblem matches this goal.
  assert.equal(book.status('recruit-warrior'), 'active');
  commit({ type: 'fact', fact: { kind: 'recruit', target: 'other-emblem', occurrence: { source: 'recruit', sequence: 1 } } });
  assert.equal(book.status('recruit-warrior'), 'active');
  commit({ type: 'fact', fact: { kind: 'recruit', target: 'order-warrior-emblem', occurrence: { source: 'recruit', sequence: 2 } } });
  assert.equal(book.status('recruit-warrior'), 'ready');
  assert.equal(commit({ type: 'complete', quest: 'recruit-warrior' }).rewards[0].reward.experience, 1660);
});

test('original repeat quest 354 independently tracks cactus juice and palm fruit for each cycle', () => {
  const { book, commit, inventory } = fixture([rules('desert-ingredients', { repeat: true, completion: 'all', goals: [
    { id: 'juice', kind: 'item', target: 'weak-cactus-juice', quantity: 3 },
    { id: 'fruit', kind: 'item', target: 'palm-fruit', quantity: 3 },
  ], handoverItems: [{ item: 'weak-cactus-juice', quantity: 3 }, { item: 'palm-fruit', quantity: 3 }] })]);
  commit({ type: 'accept', quest: 'desert-ingredients', cycle: 0 }); inventory.set('weak-cactus-juice', 3);
  commit({ type: 'refresh' }); assert.equal(book.status('desert-ingredients'), 'active');
  inventory.set('palm-fruit', 3); commit({ type: 'complete', quest: 'desert-ingredients', cycle: 0 });
  assert.equal(inventory.get('weak-cactus-juice'), 0); assert.equal(inventory.get('palm-fruit'), 0);
  commit({ type: 'accept', quest: 'desert-ingredients', cycle: 1 });
  assert.deepEqual(book.state('desert-ingredients')!.goals, { juice: 0, fruit: 0 });
  assert.equal(book.status('desert-ingredients'), 'active');
});

test('repeated multi-goal quests reject old cycles and duplicates, while respawn deaths count again', () => {
  const { book, commit } = fixture([rules('repeat-hunt', { completion: 'all', repeat: true, goals: [
    { id: 'bear', kind: 'defeat', target: 'fierce-bear', quantity: 2 }, { id: 'nest', kind: 'interact', target: 'nest', quantity: 1 },
  ], rewards: { experience: 10, money: 5, items: [] } })]);
  commit({ type: 'accept', quest: 'repeat-hunt', cycle: 0 });
  const death: QuestCommand = { type: 'fact', fact: { kind: 'defeat', target: 'fierce-bear', occurrence: { source: 'combat', sequence: 1 } } };
  commit(death); commit(death);
  assert.equal(book.state('repeat-hunt')!.goals.bear, 1);
  commit({ type: 'fact', fact: { kind: 'defeat', target: 'fierce-bear', occurrence: { source: 'combat', sequence: 2 } } });
  assert.equal(book.status('repeat-hunt'), 'active');
  commit({ type: 'fact', fact: { kind: 'interact', target: 'nest', occurrence: { source: 'interaction', sequence: 1 } } });
  assert.equal(book.status('repeat-hunt'), 'ready');
  const settlement = commit({ type: 'complete', quest: 'repeat-hunt', cycle: 0 });
  assert.deepEqual(settlement.rewards, [{ quest: 'repeat-hunt', cycle: 0, reward: { experience: 10, money: 50, items: [] } }]);
  assert.equal(book.status('repeat-hunt'), 'available');
  assert.equal(book.state('repeat-hunt')!.cycle, 1); assert.equal(book.completedCycles('repeat-hunt'), 1);
  assert.throws(() => book.plan({ type: 'complete', quest: 'repeat-hunt', cycle: 0 }), /周期/);
  commit({ type: 'accept', quest: 'repeat-hunt', cycle: 1 }); commit(death);
  assert.equal(book.state('repeat-hunt')!.goals.bear, 0);
  commit({ type: 'fact', fact: { kind: 'defeat', target: 'fierce-bear', occurrence: { source: 'combat', sequence: 3 } } });
  assert.equal(book.state('repeat-hunt')!.goals.bear, 1);
  assert.deepEqual(book.captureState().factSequences, [['combat', 3], ['interaction', 1]]);
});

test('later quests can interact with the same world object through a new occurrence', () => {
  const target = { id: 'investigate', kind: 'interact' as const, target: 'altar', quantity: 1 };
  const { book, commit } = fixture([rules('first', { completion: 'all', goals: [target] }), rules('second', {
    completion: 'all', goals: [target], availableWhen: { type: 'quest', quest: 'first', status: 'completed' },
  })]);
  commit({ type: 'accept', quest: 'first' });
  commit({ type: 'fact', fact: { kind: 'interact', target: 'altar', occurrence: { source: 'interaction', sequence: 1 } } });
  commit([{ type: 'complete', quest: 'first' }, { type: 'accept', quest: 'second' }]);
  commit({ type: 'fact', fact: { kind: 'interact', target: 'altar', occurrence: { source: 'interaction', sequence: 1 } } });
  assert.equal(book.status('second'), 'active');
  commit({ type: 'fact', fact: { kind: 'interact', target: 'altar', occurrence: { source: 'interaction', sequence: 2 } } });
  assert.equal(book.status('second'), 'ready');
});

test('acceptance delivery items, handover and class-filtered rewards use one net plan', () => {
  const { book, inventory, commit } = fixture([rules('delivery', { completion: 'all', goals: [
    { id: 'letter', kind: 'item', target: 'letter', quantity: 1 },
  ], onAcceptItems: [{ item: 'letter', quantity: 1 }], handoverItems: [{ item: 'letter', quantity: 1 }],
  rewards: { experience: 4, money: 7, items: [{ item: 'staff', quantity: 1, classIds: ['priest'] },
    { item: 'sword', quantity: 1, classIds: ['warrior'] }] } })]);
  const before = book.captureState();
  const plan = book.plan([{ type: 'accept', quest: 'delivery' }, { type: 'complete', quest: 'delivery' }]);
  assert.deepEqual(book.captureState(), before); assert.equal(inventory.size, 0);
  assert.deepEqual(plan.itemRemovals, []); assert.deepEqual(plan.itemGrants, [{ item: 'staff', quantity: 1 }]);
  assert.deepEqual(plan.rewards[0].reward.items, [{ item: 'staff', quantity: 1 }]);
  commit([{ type: 'accept', quest: 'delivery' }, { type: 'complete', quest: 'delivery' }]);
  assert.equal(inventory.get('staff'), 1); assert.equal(book.status('delivery'), 'completed');
});

test('joint handovers reserve shared inventory and fail the entire batch if the sum is unavailable', () => {
  const definition = (id: string) => rules(id, { completion: 'all', goals: [{ id: 'wood', kind: 'item', target: 'wood', quantity: 3 }],
    handoverItems: [{ item: 'wood', quantity: 3 }] });
  const { book, inventory, commit } = fixture([definition('one'), definition('two')]);
  inventory.set('wood', 4); commit([{ type: 'accept', quest: 'one' }, { type: 'accept', quest: 'two' }]);
  const before = book.captureState();
  assert.throws(() => book.plan([{ type: 'complete', quest: 'one' }, { type: 'complete', quest: 'two' }]), /目标尚未达成/);
  assert.deepEqual(book.captureState(), before); assert.equal(inventory.get('wood'), 4);
  inventory.set('wood', 6); const plan = commit([{ type: 'complete', quest: 'one' }, { type: 'complete', quest: 'two' }]);
  assert.deepEqual(plan.itemRemovals, [{ item: 'wood', quantity: 6 }]); assert.equal(inventory.get('wood'), 0);
});

test('all-matching handover removes owned quantity, while exact handovers require the configured quantity', () => {
  const { book, inventory, commit } = fixture([rules('delivery', { handoverItems: [{ item: 'token', quantity: 1, removal: 'all-matching' }] })]);
  inventory.set('token', 4); commit({ type: 'accept', quest: 'delivery' }); commit({ type: 'script-ready', quest: 'delivery' });
  assert.deepEqual(book.plan({ type: 'complete', quest: 'delivery' }).itemRemovals, [{ item: 'token', quantity: 4 }]);
  commit({ type: 'complete', quest: 'delivery' }); assert.equal(inventory.get('token'), 0);
  const strict = fixture([rules('strict', { handoverItems: [{ item: 'token', quantity: 3 }] })]);
  strict.commit({ type: 'accept', quest: 'strict' }); strict.commit({ type: 'script-ready', quest: 'strict' });
  assert.throws(() => strict.book.plan({ type: 'complete', quest: 'strict' }), /交付物品/);
});

test('equipped-item shortcut preserves original ordered success and does not pass an earlier missing goal', () => {
  const definition = rules('equipment-check', { completion: 'all', itemCompletion: 'equipped-item-shortcut', goals: [
    { id: 'first', kind: 'item', target: 'first', quantity: 5 }, { id: 'second', kind: 'item', target: 'second', quantity: 5 },
    { id: 'third', kind: 'item', target: 'third', quantity: 5 },
  ] });
  const { book, commit, inventory, equipped } = fixture([definition]);
  equipped.set('second', 1); commit({ type: 'accept', quest: definition.id });
  assert.equal(book.status(definition.id), 'active');
  inventory.set('first', 5); commit({ type: 'refresh' });
  assert.equal(book.status(definition.id), 'ready'); assert.equal(book.state(definition.id)!.goals.third, 0);
  equipped.clear(); commit({ type: 'refresh' }); assert.equal(book.status(definition.id), 'active');
});

test('hidden, internal and script-controlled quests have distinct admission and completion rules', () => {
  const { book, commit } = fixture([rules('hidden', { hidden: true }), rules('internal', { completion: 'internal' }), rules('story', { completion: 'story' })]);
  assert.equal(book.visible('hidden'), false); assert.equal(book.status('hidden'), 'available');
  assert.equal(book.visible('internal'), false); assert.equal(book.status('internal'), 'locked');
  assert.throws(() => book.plan({ type: 'accept', quest: 'internal' }), /内部任务/);
  commit({ type: 'accept', quest: 'internal', source: 'script' });
  commit({ type: 'script-ready', quest: 'internal' }); assert.equal(book.status('internal'), 'ready');
  commit({ type: 'accept', quest: 'story' }); assert.equal(book.status('story'), 'active');
  commit({ type: 'script-ready', quest: 'story' }); assert.equal(book.status('story'), 'ready');
  commit([{ type: 'script-complete', quest: 'internal' }, { type: 'script-complete', quest: 'story' }]);
  assert.equal(book.status('internal'), 'completed'); assert.equal(book.status('story'), 'completed');
  // 原版 ChangeQuestState 对「已经就是目标状态」直接返回，重复结算不再发奖，也不报错。
  const repeat = commit({ type: 'script-complete', quest: 'story' });
  assert.equal(book.status('story'), 'completed'); assert.equal(repeat.rewards.length, 0);
});

test('a dialogue-free event can settle two quests in one atomic plan', () => {
  const { book, commit } = fixture([rules('thirty', { completion: 'internal' }), rules('thirty-one', { completion: 'story' })]);
  commit({ type: 'accept', quest: 'thirty-one' }); commit({ type: 'script-ready', quest: 'thirty-one' });
  const plan = commit([{ type: 'script-complete', quest: 'thirty' }, { type: 'script-complete', quest: 'thirty-one' }]);
  assert.equal(plan.rewards.length, 2); assert.equal(book.status('thirty'), 'completed'); assert.equal(book.status('thirty-one'), 'completed');
});

test('reset creates a new cycle and settled prerequisites remember repeated history', () => {
  const { book, commit } = fixture([rules('repeat', { repeat: true }), rules('later', { availableWhen: { type: 'quest', quest: 'repeat', status: 'settled' } })]);
  commit([{ type: 'accept', quest: 'repeat' }, { type: 'script-ready', quest: 'repeat' }, { type: 'complete', quest: 'repeat' }]);
  assert.equal(book.status('repeat'), 'available'); assert.equal(book.status('later'), 'available');
  commit({ type: 'reset', quest: 'repeat', cycle: 1 }); assert.equal(book.state('repeat')!.cycle, 2);
  assert.equal(book.completedCycles('repeat'), 1);
  assert.throws(() => book.plan({ type: 'accept', quest: 'repeat', cycle: 1 }), /周期/);
});

test('plans are single-use, book-owned, revision-protected and immutable', () => {
  const { book, commit } = fixture([rules('first'), rules('second')]);
  const plan = book.plan({ type: 'accept', quest: 'first' });
  assert.throws(() => { plan.nextState.quests[0][1].status = 'completed'; }, TypeError);
  assert.throws(() => book.commit({ ...plan }), /失效/);
  commit({ type: 'accept', quest: 'second' }); assert.throws(() => book.commit(plan), /失效/);
  const current = book.plan({ type: 'accept', quest: 'first' }); book.commit(current);
  assert.throws(() => book.commit(current), /失效/);
});

test('restore round-trips progress and facts, adds new quests and refuses unknown references before mutation', () => {
  const { book, commit } = fixture([rules('old', { completion: 'all', goals: [{ id: 'altar', kind: 'interact', target: 'altar', quantity: 2 }] })]);
  commit({ type: 'accept', quest: 'old' });
  commit({ type: 'fact', fact: { kind: 'interact', target: 'altar', occurrence: { source: 'interaction', sequence: 1 } } });
  const capture = book.captureState(); book.restoreState(capture); assert.deepEqual(book.captureState(), capture);
  const expanded = fixture([book.definition('old')!, rules('new')]); expanded.book.restoreState(capture);
  expanded.commit({ type: 'refresh' }); assert.equal(expanded.book.status('new'), 'available');
  assert.equal(expanded.book.state('old')!.goals.altar, 1);
  expanded.commit({ type: 'fact', fact: { kind: 'interact', target: 'altar', occurrence: { source: 'interaction', sequence: 1 } } });
  assert.equal(expanded.book.state('old')!.goals.altar, 1);
  const unknown = structuredClone(capture); unknown.quests[0][0] = 'unknown';
  assert.throws(() => book.restoreState(unknown), /未知任务/); assert.deepEqual(book.captureState(), capture);
  const goal = structuredClone(capture); goal.quests[0][1].goals.unknown = 1;
  assert.throws(() => book.restoreState(goal), /未知目标/); assert.deepEqual(book.captureState(), capture);
});

test('prepared restore is revision-protected and snapshots validate bounded counts and duplicate IDs', () => {
  const { book, commit } = fixture([rules('old')]);
  const state = book.captureState(), prepared = book.prepareRestore(state);
  commit({ type: 'accept', quest: 'old' }); assert.throws(() => book.commitRestore(prepared), /失效/);
  const duplicate = structuredClone(state); duplicate.quests.push(duplicate.quests[0]);
  assert.throws(() => book.prepareRestore(duplicate), /重复/);
  const invalid = structuredClone(state); invalid.quests[0][1].cycle = -1;
  assert.throws(() => book.prepareRestore(invalid), /周期/);
});

test('newly unavailable quests relock before acceptance without undoing accepted quests', () => {
  const { book, commit, flags } = fixture([rules('flagged', { completion: 'story', availableWhen: { type: 'flag', flag: 'door-open' } })]);
  assert.equal(book.status('flagged'), 'locked'); flags.add('door-open'); commit({ type: 'refresh' });
  assert.equal(book.status('flagged'), 'available'); flags.clear(); commit({ type: 'refresh' });
  assert.equal(book.status('flagged'), 'locked'); flags.add('door-open'); commit({ type: 'accept', quest: 'flagged' });
  flags.clear(); commit({ type: 'refresh' }); assert.equal(book.status('flagged'), 'active');
});

test('empty ordinary goals, duplicate stable IDs and unknown predecessor references are rejected', () => {
  assert.throws(() => fixture([rules('empty', { completion: 'all' })]), /缺少完成目标/);
  assert.throws(() => fixture([rules('duplicate'), rules('duplicate')]), /重复/);
  assert.throws(() => fixture([rules('unknown', { availableWhen: { type: 'quest', quest: 'missing', status: 'completed' } })]), /未知任务/);
});

test('resetting side quests takes back their items and leaves the main line running', () => {
  // 原版事件命令 `0x4a`（findings 119）：章节切换时把所有支线任务的收集物收回、状态写回未接取。
  const { book, commit, inventory } = fixture([
    rules('supplies', { completion: 'all', goals: [{ id: 'crate', kind: 'item', target: 'supply-crate', quantity: 5 }],
      onAcceptItems: [{ item: 'supply-crate', quantity: 2 }], handoverItems: [{ item: 'supply-crate', quantity: 5 }] }),
    rules('prologue', { completion: 'all', goals: [{ id: 'sigil', kind: 'item', target: 'main-sigil', quantity: 3 }] }),
  ], ['supplies']);
  commit({ type: 'accept', quest: 'supplies' }); commit({ type: 'accept', quest: 'prologue' });
  assert.equal(inventory.get('supply-crate'), 2);
  commit({ type: 'reset-side-quests' });
  assert.equal(inventory.get('supply-crate'), 0, '支线要收集的物品被收回，手上有多少收多少');
  assert.equal(book.status('supplies'), 'available', '支线回到可接');
  assert.equal(book.state('supplies')!.goals.crate, 0, '支线目标进度清零');
  assert.equal(book.status('prologue'), 'active', '主线不受影响');
});

test('a settled side quest stays outside the chapter reset pool', () => {
  const { book, commit } = fixture([rules('errand')], ['errand']);
  commit({ type: 'accept', quest: 'errand' });
  assert.equal(book.status('errand'), 'ready');
  commit({ type: 'fact', fact: { kind: 'talk', target: 'elder', occurrence: { source: 'test', sequence: 1 } } });
  commit({ type: 'complete', quest: 'errand' });
  assert.equal(book.status('errand'), 'completed');
  commit({ type: 'reset-side-quests' });
  assert.equal(book.status('errand'), 'completed', '已交付支线已经移出原版运行池');
  assert.deepEqual(book.runningQuestIds,[]);
});

test('running quests append on acceptance and remove by replacing the slot with the tail',()=>{
  const h=fixture(['a','b','c','d'].map(id=>rules(id,{completion:'story',repeat:id==='b'})));
  const accept=(id:string)=>h.commit({type:'accept',quest:id});
  accept('c');accept('a');accept('b');accept('d');
  assert.deepEqual(h.book.runningQuestIds,['c','a','b','d']);
  h.commit({type:'script-complete',quest:'a'});
  assert.deepEqual(h.book.runningQuestIds,['c','d','b']);
  h.commit({type:'reset',quest:'c'});
  assert.deepEqual(h.book.runningQuestIds,['b','d']);
  h.commit({type:'script-complete',quest:'b'});accept('b');
  assert.deepEqual(h.book.runningQuestIds,['d','b'],'重复任务再次接取追加到尾部');
  const before=h.book.captureState();
  assert.throws(()=>h.book.plan([{type:'reset',quest:'d'},{type:'complete',quest:'b'}]),/未达成/);
  assert.deepEqual(h.book.captureState(),before,'失败的批次不改变任务池');
});

test('readiness changes keep the running slot and snapshots preserve its order without aliasing',()=>{
  const h=fixture([rules('first',{completion:'all',goals:[{id:'ore',kind:'item',target:'ore',quantity:1}]}),rules('second',{completion:'story'})]);
  h.commit({type:'accept',quest:'second'});h.commit({type:'accept',quest:'first'});
  h.inventory.set('ore',1);h.commit({type:'refresh'});assert.equal(h.book.status('first'),'ready');
  assert.deepEqual(h.book.runningQuestIds,['second','first']);
  h.inventory.set('ore',0);h.commit({type:'refresh'});assert.equal(h.book.status('first'),'active');
  assert.deepEqual(h.book.runningQuestIds,['second','first']);
  const snapshot=h.book.captureState(),restored=fixture([h.book.definition('first')!,h.book.definition('second')!]);
  restored.book.restoreState(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.book.captureState(),snapshot);
  snapshot.runningQuestIds.reverse();
  assert.deepEqual(restored.book.runningQuestIds,['second','first']);
  (restored.book.runningQuestIds as string[]).reverse();
  assert.deepEqual(restored.book.runningQuestIds,['second','first']);
  const before=restored.book.captureState();
  for(const runningQuestIds of [['first'],['first','first'],['unknown'],['second','first','unknown']]){
    assert.throws(()=>restored.book.restoreState({...before,runningQuestIds}),/运行池/);
    assert.deepEqual(restored.book.captureState(),before);
  }
  const completed=structuredClone(before);completed.quests.find(([id])=>id==='first')![1].status='completed';
  assert.throws(()=>restored.book.restoreState(completed),/运行池/);
  assert.deepEqual(restored.book.captureState(),before);
});

test('chapter resets revisit replaced slots and leave the native surviving quest order',()=>{
  const h=fixture(['side-a','main-b','side-c','main-d','main-e'].map(id=>rules(id,{completion:'story'})),['side-a','side-c']);
  for(const id of ['side-a','main-b','side-c','main-d','main-e'])h.commit({type:'accept',quest:id});
  h.commit({type:'reset-side-quests'});
  assert.deepEqual(h.book.runningQuestIds,['main-e','main-b','main-d']);
  assert.equal(h.book.status('side-a'),'available');assert.equal(h.book.status('side-c'),'available');
});

test('the reported change flag always equals a full state comparison', () => {
  // 摘要式变更检测的唯一保险：把「本命令是否真的改了状态」与「全量序列化比较」逐一对照。
  // 判错的后果是 commit 跳过安装，任务进度静默丢失。
  const definitions = [
    rules('talk-one', { completion: 'all', goals: [{ id: 'g', kind: 'talk', target: 'elder', quantity: 1 }] }),
    rules('item-two', { completion: 'all', goals: [{ id: 'i', kind: 'item', target: 'herb', quantity: 2 }],
      handoverItems: [{ item: 'herb', quantity: 2 }], rewards: { experience: 5, money: 3, items: [{ item: 'potion', quantity: 1 }] } }),
    rules('repeat-one', { completion: 'all', goals: [{ id: 'r', kind: 'defeat', target: 'wolf', quantity: 1 }], repeat: true }),
    rules('side-one', { completion: 'all', goals: [{ id: 's', kind: 'item', target: 'ore', quantity: 1 }],
      handoverItems: [{ item: 'ore', quantity: 1 }] }),
    rules('story-one', { completion: 'story' }),
  ];
  const defeatFact: QuestCommand = { type: 'fact', fact: { kind: 'defeat', target: 'wolf', occurrence: { source: 'combat', sequence: 1 } } };
  const talkFact: QuestCommand = { type: 'fact', fact: { kind: 'talk', target: 'elder', occurrence: { source: 'talk', sequence: 1 } } };
  const commands: QuestCommand[] = [
    { type: 'refresh' }, talkFact, defeatFact,
    { type: 'accept', quest: 'talk-one' }, { type: 'accept', quest: 'item-two' }, { type: 'accept', quest: 'repeat-one' },
    { type: 'accept', quest: 'side-one' }, { type: 'complete', quest: 'item-two', cycle: 0 },
    { type: 'complete', quest: 'repeat-one', cycle: 0 }, { type: 'accept', quest: 'repeat-one', cycle: 1 },
    { type: 'reset-side-quests' }, { type: 'script-ready', quest: 'story-one' },
    { type: 'script-complete', quest: 'story-one' }, { type: 'reset', quest: 'talk-one' },
  ];
  const prefixes: QuestCommand[][] = [[], [{ type: 'accept', quest: 'talk-one' }], [{ type: 'accept', quest: 'item-two' }],
    [{ type: 'accept', quest: 'repeat-one' }, defeatFact], [{ type: 'accept', quest: 'side-one' }], [{ type: 'accept', quest: 'item-two' }, { type: 'complete', quest: 'item-two', cycle: 0 }]];
  for (const prefix of prefixes) {
    const { book, inventory } = fixture(definitions, ['side-one']);
    inventory.set('herb', 2); inventory.set('ore', 1);
    for (const command of prefix) book.commit(book.plan(command));
    for (const command of commands) {
      let plan;
      try { plan = book.plan(command); } catch { continue; }   // 这个起始状态下命令不合法
      const expected = JSON.stringify(plan.nextState) !== JSON.stringify(book.captureState());
      assert.equal(plan.changed, expected, `${JSON.stringify(prefix)} → ${JSON.stringify(command)}`);
      // 同一状态下反复询问同一命令，答案必须一致（摘要缓存最容易在这里错位）。
      const repeated = book.plan(command);
      assert.equal(repeated.changed, JSON.stringify(repeated.nextState) !== JSON.stringify(book.captureState()));
      book.commit(plan);
    }
  }
});

test('trusted install accepts only same-definition states and fills missing quests', () => {
  const { book } = fixture([rules('one'), rules('two')]);
  book.installTrustedState({ version: 5, quests: [['one', { status: 'active', cycle: 0, completedCycles: 0, goals: {} }]],
    runningQuestIds: ['one'], factSequences: [['combat', 4]] });
  assert.equal(book.status('one'), 'active'); assert.equal(book.status('two'), 'locked');
  assert.equal(book.factSequence('combat'), 4); assert.equal(book.factSequence('talk'), 0);
  // 引用未知任务或版本不符的状态被拒绝，现有状态不受影响。
  assert.throws(() => book.installTrustedState({ version: 5, quests: [['ghost', { status: 'active', cycle: 0, completedCycles: 0, goals: {} }]],
    runningQuestIds: [], factSequences: [] }), /未知任务/);
  assert.throws(() => book.installTrustedState({ version: 2 as unknown as 5, quests: [], runningQuestIds: [], factSequences: [] }), /版本/);
  assert.equal(book.status('one'), 'active');
});

test('quest definitions are prepared once per content array and stay independent', () => {
  // 505 条定义的克隆与冻结是死亡结算里最贵的一项，按数组身份复用；前提是调用方不原地改这个数组。
  const definitions = [rules('one'), rules('two')];
  const first = fixture(definitions).book, second = fixture(definitions).book;
  assert.equal(first.definition('one'), second.definition('one'));
  assert.ok(Object.isFrozen(first.definition('one')));
  // 内容相同但是另一份数组：走自己的准备流程，不共享。
  assert.notEqual(first.definition('one'), fixture([rules('one'), rules('two')]).book.definition('one'));
  // 校验失败的内容不缓存，重复构造仍会报错。
  const broken = [rules('one', { completion: 'all', goals: [{ id: 'g', kind: 'item', target: 'x', quantity: 0 }] })];
  assert.throws(() => fixture(broken), /目标数量/);
  assert.throws(() => fixture(broken), /目标数量/);
});

test('a no-op plan reports no change after every state-changing path', () => {
  // 摘要必须始终描述当前状态。任何改变状态的路径之后，空计划都不能报告「有改动」——
  // 反过来（拿旧摘要比较）会把真实改动判成没变，commit 跳过安装，任务进度静默丢失。
  const { book } = fixture([rules('one')]);
  const settled = (label: string) => {
    const plan = book.plan({ type: 'refresh' });
    assert.equal(plan.changed, false, label); book.commit(plan);
  };
  settled('构造之后');
  book.installTrustedState({ version: 5, quests: [['one', { status: 'completed', cycle: 1, completedCycles: 1, goals: {} }]],
    runningQuestIds: [], factSequences: [['talk', 2]] });
  assert.equal(book.status('one'), 'completed');
  settled('信任安装之后');
  const installed = book.captureState();
  // 真实改动仍必须被认出来，否则改动会被摘要吞掉。
  const change = book.plan({ type: 'reset', quest: 'one' });
  assert.equal(change.changed, true); book.commit(change);
  assert.equal(book.state('one')!.cycle, 2);   // 安装时是周期 1，reset 推进到 2
  settled('真实改动之后');
  // 恢复到与当前**不同**的状态：摘要必须跟着失效，否则空计划会误报改动。
  book.commitRestore(book.prepareRestore(installed));
  assert.equal(book.state('one')!.cycle, 1);
  settled('恢复之后');
});

test('a plan never touches the live state or the identity of shared entries', () => {
  // 写时复制的前提：预演改的是计划自己那份容器，未触及的条目按身份共享。
  const { book, commit } = fixture([rules('first'), rules('second')]);
  commit({ type: 'accept', quest: 'first' });
  const entry = book.state('first'), other = book.state('second'), snapshot = book.captureState(), version = book.version;
  const preview = book.plan({ type: 'reset', quest: 'first' });
  assert.equal(preview.changed, true);
  assert.equal(book.state('first'), entry, '预演不该换掉任务簿里的条目');
  assert.equal(book.state('second'), other, '没被写的条目在批次之间按身份共享');
  assert.deepEqual(book.captureState(), snapshot);
  assert.equal(book.version, version, '预演不推进版本');
  // 计划自己的快照仍是完整份、且已冻结。
  assert.throws(() => { preview.nextState.quests[0][1].status = 'completed'; }, TypeError);
});

test('the change flag stays a full comparison for whole batches too', () => {
  // 结构式判定要覆盖多命令批次：`plan.changed` 必须仍等于「批后快照 ≠ 当前快照」。
  const definitions = [rules('talk-one', { completion: 'all', goals: [{ id: 'g', kind: 'talk', target: 'elder', quantity: 1 }] }),
    rules('repeat-one', { completion: 'all', goals: [{ id: 'r', kind: 'defeat', target: 'wolf', quantity: 1 }], repeat: true }),
    rules('side-one', { completion: 'all', goals: [{ id: 's', kind: 'item', target: 'ore', quantity: 1 }],
      handoverItems: [{ item: 'ore', quantity: 1 }] })];
  const defeatFact: QuestCommand = { type: 'fact', fact: { kind: 'defeat', target: 'wolf', occurrence: { source: 'combat', sequence: 1 } } };
  const batches: QuestCommand[][] = [
    [{ type: 'refresh' }, { type: 'refresh' }],
    [{ type: 'accept', quest: 'repeat-one' }, defeatFact],
    [{ type: 'accept', quest: 'talk-one' }, { type: 'reset', quest: 'talk-one' }],
    [{ type: 'reset', quest: 'talk-one' }, { type: 'accept', quest: 'talk-one' }],
    [{ type: 'accept', quest: 'side-one' }, { type: 'reset-side-quests' }],
  ];
  for (const prefix of [[], [{ type: 'accept', quest: 'repeat-one' }], [{ type: 'accept', quest: 'talk-one' }]] as QuestCommand[][]) {
    for (const batch of batches) {
      const { book, inventory } = fixture(definitions, ['side-one']);
      inventory.set('ore', 1);
      for (const command of prefix) book.commit(book.plan(command));
      const plan = book.plan(batch);
      assert.equal(plan.changed, JSON.stringify(plan.nextState) !== JSON.stringify(book.captureState()),
        `${JSON.stringify(prefix)} → ${JSON.stringify(batch)}`);
      book.commit(plan);
    }
  }
});

test('a batch checkpoint rolls the book back without moving the revision backwards', () => {
  const { book, commit } = fixture([rules('first'), rules('second')]);
  commit({ type: 'accept', quest: 'first' });
  const before = book.captureState(), checkpoint = book.checkpoint(), version = book.version;
  commit({ type: 'accept', quest: 'second' });
  assert.notDeepEqual(book.captureState(), before);
  book.rollbackTo(checkpoint);
  assert.deepEqual(book.captureState(), before, '检查点换回旧根，值必须逐字段一致');
  assert.ok(book.version > version, '回滚也要推进版本，否则已作废的计划会复活');
  // 版本推进之后，回滚前拿到的计划必须失效。
  const stale = book.plan({ type: 'reset', quest: 'first' });
  book.rollbackTo(book.checkpoint());
  assert.throws(() => book.commit(stale), /失效/);
});

test('talk acceptance checks completion once; a repeated state write preserves active across refresh and restore', () => {
  const { book, commit } = fixture([rules('errand', { onAcceptItems: [{item:'letter',quantity:1}] })]);
  commit({type:'accept',quest:'errand'});
  assert.equal(book.status('errand'),'ready');
  assert.deepEqual(book.state('errand')!.goals,{});
  commit({type:'accept',quest:'errand',source:'script'});
  assert.equal(book.status('errand'),'active');
  commit({type:'refresh'});
  commit({type:'fact',fact:{kind:'talk',target:'elder',occurrence:{source:'talk',sequence:1}}});
  assert.equal(book.status('errand'),'active','说明中的对象不会产生计数或改变显式状态');
  const restored=fixture([book.definition('errand')!]).book;
  restored.restoreState(book.captureState());
  assert.equal(restored.status('errand'),'active');
  commit({type:'script-ready',quest:'errand'});
  commit({type:'complete',quest:'errand'});
  assert.equal(book.status('errand'),'completed');
});

test('talk descriptions cannot enter the objective counter model', () => {
  assert.throws(()=>fixture([rules('errand',{goals:[{id:'ask',kind:'talk',target:'elder',quantity:1}]})]),/descriptionTargets/);
});

test('experimental pins hold completed objectives active and settlement releases them', () => {
  const definition=rules('hunt',{completion:'all',goals:[{id:'kill',kind:'defeat',target:'wolf',quantity:1}]});
  const {book,commit}=fixture([definition]);
  commit({type:'accept',quest:'hunt'});
  commit({type:'fact',fact:{kind:'defeat',target:'wolf',occurrence:{source:'combat',sequence:1}}});
  assert.equal(book.status('hunt'),'ready');
  book.pinDebug('hunt');
  commit({type:'refresh'});
  assert.equal(book.status('hunt'),'active');
  const checkpoint=book.checkpoint(),saved=book.captureState();
  book.unpinDebug('hunt');
  assert.equal(book.status('hunt'),'ready');
  book.rollbackTo(checkpoint);
  assert.equal(book.status('hunt'),'active');
  const restored=fixture([definition]).book;
  restored.restoreState(saved);
  assert.equal(restored.status('hunt'),'active');
  assert.throws(()=>restored.prepareRestore({...saved,debugPins:['ghost']}),/未知任务/);
  commit({type:'complete',quest:'hunt'});
  assert.equal(book.status('hunt'),'completed');
  assert.equal(book.captureState().debugPins,undefined);
  const talk=fixture([rules('talk')]);talk.commit({type:'accept',quest:'talk'});
  assert.throws(()=>talk.book.pinDebug('talk'),/只有目标计数任务/);
});
