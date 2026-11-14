import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseItemCatalog, parseShops } from '../src/application/content-validation.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { Bag, mergeStackableInstances } from '../src/domain/bag.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { ItemCatalog, ItemInstance } from '../src/domain/items.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import { captureSaveGame, restoreSaveGame, saveSummary } from '../src/domain/save-game.ts';
import { Session } from '../src/domain/session.ts';
import { Storefront } from '../src/domain/shop.ts';

const read = <T>(name: string): T => JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = read<ItemCatalog>('items');
const catalog = parseItemCatalog(items);
const stats = read<CharacterStatsCatalog>('character-stats');
const battle = read<BattleCatalog>('battle');
const companions = read<CompanionCatalog>('companions');
const campaign = read<Campaign>('campaign');
const shops = parseShops(read('shops'));
const generalStore = 'merchandise-dealer-b09d9585';
/** 与 `story-class.ts` 的 newStorySession 同构：读档时先建同职业的新会话再灌状态。 */
const createSession = () => new Session(campaign, undefined, undefined, items,
  new BattleCharacter('dark-knight', stats, items), battle, stats, companions);
const record = (session: Session) => captureSaveGame(session, { location: { map: campaign.start.map } },
  saveSummary(session, { id: campaign.start.map, name: '黑暗骑士团营地' },
    { name: '黑暗骑士', portrait: 'assets/ui/menus/character-kiyan.png' }));

test('技能书、神灯和礼盒获得两件时只占一格，使用按数量扣减', () => {
  const bag = new Bag(() => {}, catalog, 'dark-knight'), skill = catalog.classSkills['dark-knight']![0]!;
  for (const item of ['skillbook', 'lamp', 'beginner-knight-set']) { bag.add(item); bag.add(item); }
  assert.equal(bag.entries.length, 3, '三件物品各占一格');
  for (const item of ['skillbook', 'lamp', 'beginner-knight-set']) assert.equal(bag.count(item), 2, item);

  const skillbook = bag.entries.find(entry => entry.item === 'skillbook')!;
  assert.equal(bag.use(skillbook.id, undefined, skill).skill, skill);
  assert.equal(bag.count('skillbook'), 1, '技能书只消耗一本');
  const lamp = bag.entries.find(entry => entry.item === 'lamp')!;
  bag.use(lamp.id);
  assert.equal(bag.count('lamp'), 1, '神灯只消耗一盏');
  const pack = bag.entries.find(entry => entry.item === 'beginner-knight-set')!;
  bag.use(pack.id);
  assert.equal(bag.count('beginner-knight-set'), 1, '礼盒只打开一个');
  assert.equal(bag.entries.filter(entry => ['skillbook', 'lamp', 'beginner-knight-set'].includes(entry.item)).length, 3, '用掉一件后仍各占一格');
  bag.verifyConsistency();
});

test('徽章两枚叠成一格，丢弃与出售都按数量结算', () => {
  const session = createSession();
  session.bag.add('mercenary-emblem-warrior', 2);
  assert.equal(session.bag.entries.filter(entry => entry.item === 'mercenary-emblem-warrior').length, 1);
  const entry = session.bag.entries.find(entry => entry.item === 'mercenary-emblem-warrior')!;
  assert.equal(entry.quantity, 2, '两枚叠成一格');
  session.bag.discard(entry.id, 1);
  assert.equal(session.bag.count('mercenary-emblem-warrior'), 1, '丢弃只扣一枚');

  const store = new Storefront(shops, items, stats, session, generalStore, session.shops.mapId ?? 'shadow-camp', () => 0.1);
  assert.ok(store.sellPrice(session.bag.get(entry.id)!) > 0);
  store.sell(entry.id, 1);
  assert.equal(session.bag.count('mercenary-emblem-warrior'), 0, '出售也只扣一枚');
  assert.equal(session.bag.get(entry.id), undefined);
});

test('带词条、强化、宝石的实例不会被并进普通堆叠，绑定同技能的书单独合并', () => {
  const bag = new Bag(() => {}, catalog, 'dark-knight'), item = 'magic-branch';
  const addDrop = (edit: (entry: ItemInstance) => void) => {
    const drop = bag.prepareDrop(item);
    edit(drop);
    bag.receiveDrop(drop);
  };
  addDrop(entry => { entry.numbers = { modifiers: [], gemModifiers: [], magicPercent: 0, sockets: 0, enhancementUses: 0 }; });
  addDrop(entry => { entry.enhancement = 1; });
  addDrop(entry => { entry.gems = ['novice-jewel']; });
  addDrop(entry => { entry.skill = 'dark-strike'; });
  bag.add(item); bag.add(item);

  const entries = bag.entries.filter(entry => entry.item === item);
  assert.equal(bag.count(item), 6);
  assert.equal(entries.length, 5, '四件带状态的实例加一条普通堆叠');
  for (const predicate of [(entry: ItemInstance) => entry.numbers !== undefined, (entry: ItemInstance) => entry.enhancement > 0,
    (entry: ItemInstance) => entry.gems.length > 0, (entry: ItemInstance) => entry.skill !== undefined])
    assert.equal(entries.filter(predicate).length, 1);
  assert.equal(entries.find(entry => !entry.numbers && !entry.enhancement && !entry.gems.length && !entry.skill)!.quantity, 2);
  bag.verifyConsistency();

  // 纯函数也跳过带状态的实例：手工把每条实例复制一份，只有普通那条会合并。
  const state = structuredClone(bag.captureState());
  const plain = state.instances.find(entry => entry.item === item && !entry.numbers && !entry.enhancement && !entry.gems.length && !entry.skill)!;
  for (const source of state.instances.filter(entry => entry.item === item)) {
    state.instances.push({ ...structuredClone(source), id: `${source.id}-legacy` });
  }
  const merged = mergeStackableInstances(state, catalog);
  assert.equal(merged.instances.filter(entry => entry.item === item && !entry.numbers && !entry.enhancement && !entry.gems.length && !entry.skill).length, 1);
  assert.equal(merged.instances.find(entry => entry.id === plain.id)!.quantity, 4);
  const bound = merged.instances.filter(entry => entry.item === item && entry.skill === 'dark-strike');
  assert.equal(bound.length, 1, '绑定同技能的书复制件合并为一条');
  assert.equal(bound[0]!.quantity, 2);
  assert.equal(merged.instances.filter(entry => entry.item === item).length, 8, '三件带状态实例的复制件保留，绑定书合并');
});

test('旧档里分散的两条技能书读档后合并为一条并更新所有格位引用', () => {
  const session = createSession();
  session.bag.add('skillbook', 1);
  const saved = record(session);
  const original = saved.session.bag.instances.find(entry => entry.item === 'skillbook')!;
  const duplicate = { ...structuredClone(original), id: 'owned-legacy-skillbook' };
  saved.session.bag.instances.push(duplicate);
  saved.session.bag.pouches.consumable[5] = duplicate.id;
  saved.session.bag.allCells[6] = duplicate.id;

  const loaded = createSession();
  restoreSaveGame(loaded, saved);
  loaded.bag.verifyConsistency();
  const entries = loaded.bag.entries.filter(entry => entry.item === 'skillbook');
  assert.equal(entries.length, 1, '两条实例收成一条');
  assert.equal(entries[0]!.quantity, 2, '数量相加');
  assert.equal(loaded.bag.count('skillbook'), 2);
  assert.ok(!JSON.stringify(loaded.bag.pouchCells).includes(duplicate.id), '分类袋不再引用被合并的实例');
  assert.ok(!JSON.stringify(loaded.bag.allCells).includes(duplicate.id), '全部页不再引用被合并的实例');
  assert.ok(loaded.bag.allCells.some(entry => entry?.id === entries[0]!.id), '保留的实例仍在全部页');
});

test('旧档里的零数量实例仍按原校验拒绝，不被合并掩盖', () => {
  const session = createSession();
  session.bag.add('skillbook', 1);
  const saved = record(session);
  const original = saved.session.bag.instances.find(entry => entry.item === 'skillbook')!;
  saved.session.bag.instances.push({ ...structuredClone(original), id: 'owned-zero-skillbook', quantity: 0 });
  assert.throws(() => restoreSaveGame(createSession(), saved), /背包物品引用或数量无效/);
});
