import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inventoryView, organizedInventory, INVENTORY_LABELS, INVENTORY_POUCHES, INVENTORY_SIDE_FILTERS, pouchFor, type InventoryPouch, type InventoryView } from '../src/domain/inventory.ts';
import { ITEM_CATEGORIES, type StoryItem } from '../src/domain/story-interface.ts';
import type { EquipmentSlot, ItemCatalog, ItemDefinition } from '../src/domain/items.ts';
import { Session } from '../src/domain/session.ts';
import { parseCampaign, parseItemCatalog } from '../src/application/content-validation.ts';

const read = (name: string) => JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('campaign'));
const item = (name: string, category: StoryItem['category']): StoryItem => ({name, category, icon:'assets/ui/items/hd_item5-48.png', description:''});
/** 带分类的最小物品定义：会话要靠它认出每件物品属于哪个背包袋。 */
const definition = (name: string, category: StoryItem['category'], slot?: EquipmentSlot): ItemDefinition => ({
  name, description:'', category, icon:'assets/ui/items/hd_item5-48.png',
  groundSprite:{file:'', width:1, height:1, anchorX:0, anchorY:0},
  kind:'test', typeName:'测试', stackable:true, discardable:false, shortcut:false, level:1, basePrice:1, storeListed:false,
  ...(slot ? {equipment:{slot, classes:[], twoHanded:false, dualWield:false, locked:false, socketCapacity:0, enchantable:false}} : {}),
});
const catalogOf = (items: Record<string, ItemDefinition>): ItemCatalog => ({ items, startingEquipment:{}, startingInventory:[],
  startingShortcut:'', dualWieldClasses:[], merchantItems:[], classSkills:{}, recipes:{} });
const noLayouts = (): Record<InventoryView, { item: string }[]> =>
  ({ all: [], weapon: [], armor: [], consumable: [], material: [], quest: [] });

test('side filters split equipment into weapons and armour without overlap', () => {
  // 侧边六格的数量与次序对齐原版按钮列：一个汇总视图加五个分类背包。
  assert.deepEqual([...INVENTORY_SIDE_FILTERS], ['all', 'weapon', 'armor', 'consumable', 'material', 'quest']);
  assert.equal(INVENTORY_SIDE_FILTERS.length, 6);
  assert.deepEqual(INVENTORY_SIDE_FILTERS.map(filter=>INVENTORY_LABELS[filter]),
    ['全部', '武器', '防具', '消耗', '材料', '任务']);
  const catalog = parseItemCatalog(read('items'));
  const entries = Object.entries(catalog.items).filter(([,definition])=>!definition.pickup);
  // 武器与防具必须不重不漏地覆盖装备类：原版按左右手位置分，主手与副手归武器。
  const weapons = entries.filter(([,definition])=>pouchFor(definition)==='weapon').map(([id])=>id);
  const armour = entries.filter(([,definition])=>pouchFor(definition)==='armor').map(([id])=>id);
  const equipment = entries.filter(([,definition])=>definition.category==='equipment').map(([id])=>id);
  assert.deepEqual([...weapons, ...armour].sort(), [...equipment].sort());
  assert.equal(new Set([...weapons, ...armour]).size, equipment.length);
  assert.ok(weapons.length > 0 && armour.length > 0);
});

test('catalogue pouches are complete, disjoint and keep crafting and equipment materials', () => {
  const catalog = parseItemCatalog(read('items'));
  const craftingMaterials = ['mithril', 'chaos-scale', 'leather', 'bloody-fur', 'dust-of-death',
    'spell-crystal', 'palpitant-crystal', 'sharp-claw', 'magic-cloth', 'leaf-of-life',
    'fruit-of-cause', 'root-of-soul', 'magic-branch', 'transcendent-flower'];
  const equipmentMaterials = ['novice-jewel', 'standard-jewel', 'advanced-jewel', 'supreme-jewel', 'chaos-jewel',
    'jewel-of-catharsis', 'novice-weapon-scroll', 'standard-weapon-scroll', 'advance-weapon-scroll',
    'supreme-weapon-scroll', 'chaos-weapon-scroll', 'sp-weapon-enhance-scroll',
    'novice-armor-scroll', 'standard-armor-scroll', 'advanced-armor-scroll',
    'supreme-armor-scroll', 'chaos-armor-scroll', 'sp-armor-enhance-scroll'];
  const entries = Object.entries(catalog.items).filter(([,definition])=>!definition.pickup).map(([id])=>id);
  const inPouch = (pouch: InventoryPouch) => entries.filter(id=>pouchFor(catalog.items[id])===pouch);
  assert.deepEqual(inPouch('material').sort(), [...craftingMaterials, ...equipmentMaterials].sort());
  assert.deepEqual([...catalog.merchantItems].sort(), [...craftingMaterials].sort());
  const consumables = new Set(inPouch('consumable'));
  for (const item of ['resurrection-scroll', 'improved-resurrection-scroll', 'potential-boost-scroll', 'exp-amplification-scroll']) {
    assert.ok(consumables.has(item), item);
  }
  const sizes = Object.fromEntries(INVENTORY_POUCHES.map(pouch=>[pouch, inPouch(pouch).length])) as Record<InventoryPouch, number>;
  assert.equal(sizes.weapon + sizes.armor, 662, '武器与防具合起来正好是装备类');
  assert.equal(sizes.consumable, 111);
  assert.equal(sizes.material, 32);
  assert.equal(sizes.quest, 192);
  // 每个物品只属于一个袋：五个袋必须不重不漏地覆盖整个目录。
  const placed = INVENTORY_POUCHES.flatMap(inPouch);
  assert.equal(entries.length, 997);
  assert.equal(placed.length, entries.length);
  assert.equal(new Set(placed).size, entries.length);
});

test('inventory views grow with their contents and retain an empty row', () => {
  const normal=Array.from({length:24},(_,index)=>({item:`normal-${index}`,quantity:1}));
  const quests=Array.from({length:20},(_,index)=>({item:`quest-${index}`,quantity:1}));
  const layouts={...noLayouts(),all:[...normal,...quests],material:normal,quest:quests};
  const all=inventoryView(layouts,'all');
  assert.equal(all.slotCount,48);
  assert.equal(all.slots.filter(slot=>slot.kind==='item').length,44);
  assert.deepEqual(all.slots[43],{kind:'item',entry:quests[19],view:'all',cell:43});
  assert.deepEqual(all.slots.at(-1),{kind:'cell',view:'all',cell:47});
  assert.equal(inventoryView(layouts,'material').slotCount,28);
  assert.equal(inventoryView(layouts,'quest').slotCount,24);
  const empty=inventoryView(noLayouts(),'all');
  assert.equal(empty.slotCount,16);
  assert.deepEqual(new Set(empty.slots.map(slot=>slot.kind)),new Set(['cell']));
});

test('a category view only draws its own pouch and keeps the gaps inside it', () => {
  const layouts: Record<InventoryView, ({item:string} | undefined)[]> =
    { all:[{item:'potion'},{item:'ore'},{item:'gem'}], weapon: [], armor: [], consumable: [{item:'potion'}],
      material: [undefined, {item:'ore'}, undefined, undefined, {item:'gem'}], quest: [] };
  const material = inventoryView(layouts, 'material');
  assert.equal(material.slots[0]!.kind, 'cell', '袋内空位照画');
  assert.deepEqual(material.slots[1], {kind:'item', entry:{item:'ore'}, view:'material', cell:1});
  assert.deepEqual(material.slots[4], {kind:'item', entry:{item:'gem'}, view:'material', cell:4}, '物品留在它自己的格位号上');
  assert.equal(material.slotCount, 16, '补齐整行并多留一行空格');
  assert.equal(inventoryView(layouts, 'quest').slots.some(slot=>slot.kind==='item'), false, '别的袋里的物品不出现在这里');
  const all = inventoryView(layouts, 'all');
  assert.equal(all.slotCount, 16);
  assert.deepEqual(all.slots[0], {kind:'item', entry:{item:'potion'}, view:'all', cell:0});
  assert.deepEqual(all.slots[1], {kind:'item', entry:{item:'ore'}, view:'all', cell:1});
  assert.deepEqual(all.slots[2], {kind:'item', entry:{item:'gem'}, view:'all', cell:2},'分类的空位不进入全部页面');
  assert.deepEqual(all.slots[15], {kind:'cell', view:'all', cell:15}, '末尾空格属于全部页面，可以落格');
});

test('organize orders categories, natural names, and duplicate names without mutating inventory', () => {
  const items = { quest:item('任务','quest'), material:item('材料','material'),
    potion:item('药水','consumable'), sword10:item('剑10','equipment'), sword2:item('剑2','equipment'),
    b:item('剑1','equipment'), a:item('剑1','equipment') };
  const inventory = new Map(Object.keys(items).map((id, index): [string, number] => [id, index + 1]));
  const before = [...inventory], sorted = organizedInventory(inventory, items);
  assert.deepEqual(sorted.map(([id]) => id), ['a','b','sword2','sword10','potion','material','quest']);
  assert.deepEqual([...inventory], before);
  for (const [id, count] of sorted) assert.equal(count, inventory.get(id));
  assert.deepEqual(organizedInventory(new Map(sorted), items), sorted);
});

test('session keeps organized order across pickups and hand-in without changing quest state or counts', () => {
  const items = { material:item('材料','material'), sword:item('剑','equipment'), quest:item('任务','quest'), potion:item('药水','consumable') };
  const definitions = catalogOf({ material:definition('材料','material'), sword:definition('剑','equipment','main-hand'),
    quest:definition('任务','quest'), potion:definition('药水','consumable') });
  const source = campaign.quests.find(quest => quest.id === 'knight-uniform')!;
  const fixture = {...campaign, quests:Object.keys(items).map(id => ({...source, id,availableWhen:undefined,goals:[{id:'item',kind:'item' as const,target:id,quantity:2,label:id}],handoverItems:[{item:id,quantity:2}]}))};
  const session = new Session(fixture, undefined, undefined, definitions);
  for (const id of Object.keys(items)) session.accept(id);
  for(const id of ['material','quest','sword'])session.applyStoryCommands([{type:'item-give',item:id,quantity:1}]);
  session.applyStoryCommands([{type:'item-give',item:'quest',quantity:1}]);
  const quests = session.quests, counts = session.bag.counts, flags = session.flags;
  let updates = 0; session.subscribe(() => updates++);
  session.bag.organize(items);
  // 背包按五个袋分组：剑在防具袋，药水在消耗袋，材料袋在它之后。
  assert.deepEqual([...session.bag.counts.keys()], ['sword','material','quest']);
  assert.deepEqual(session.quests, quests); assert.deepEqual(session.flags, flags);
  for (const [id, count] of counts) assert.equal(session.itemCount(id), count);
  assert.equal(updates, 1,'全部页面的分类顺序改变，只通知一次');
  assert.deepEqual(session.bag.allCells.map(entry=>entry!.item),['sword','material','quest']);
  session.bag.organize(items); assert.equal(updates, 1,'再次整理没有变化');
  session.applyStoryCommands([{type:'item-give',item:'potion',quantity:1}]);
  assert.deepEqual([...session.bag.counts.keys()], ['sword','potion','material','quest']);
  session.applyStoryCommands([{type:'item-give',item:'material',quantity:1}]);
  assert.equal(session.itemCount('material'), 2);
  assert.deepEqual([...session.bag.counts.keys()], ['sword','potion','material','quest']);
  assert.equal(session.complete('quest'), true); assert.equal(session.itemCount('quest'), 0);
  assert.equal(session.complete('quest'), false);
  assert.equal(inventoryView({all:session.bag.allCells,...session.bag.pouchCells}, 'quest').slots.some(slot=>slot.kind==='item'), false);
  assert.deepEqual([...session.bag.counts.keys()], ['sword','potion','material']);
  assert.equal(new Session(fixture).bag.counts.size, 0);
});

test('item categories are validated consistently when loading content', () => {
  const content = read('items');
  for (const category of ITEM_CATEGORIES.filter(category=>category!=='equipment')) {
    content.items.ectoplasm.category = category;
    assert.equal(parseItemCatalog(content).items.ectoplasm.category, category);
  }
  content.items.ectoplasm.category = 'unknown';
  assert.throws(() => parseItemCatalog(content), /category/);
});

test('starting inventory and shortcut reference usable catalogue items', () => {
  const content=read('items');
  content.startingInventory[0].item='missing-item';
  assert.throws(()=>parseItemCatalog(content),/初始物品不存在/);
  content.startingInventory[0].item='healing-potion-s';
  content.startingInventory[0].quantity=0;
  assert.throws(()=>parseItemCatalog(content),/正整数/);
  content.startingInventory[0].quantity=5;
  content.startingShortcut='novice-jewel';
  assert.throws(()=>parseItemCatalog(content),/初始快捷物品/);
});
