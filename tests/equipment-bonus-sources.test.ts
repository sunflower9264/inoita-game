import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BattleCharacter, equipmentPower } from '../src/domain/character-stats.ts';
import type { CharacterPanel, CharacterStatsCatalog, Modifier, ModifierRange } from '../src/domain/character-stats.ts';
import type { EquipmentSlot, ItemCatalog, ItemDefinition, ItemInstance } from '../src/domain/items.ts';
import type { BattleStateKey } from '../src/domain/battle-semantics.ts';
import type { ItemNotice } from '../src/domain/item-application.ts';
import { ItemApplicationError, ITEM_NOTICE_TEXT } from '../src/domain/item-application.ts';
import { BATTLE_STATE_KEYS } from '../src/domain/battle-semantics.ts';
import { equipmentLevel } from '../src/domain/chaos-equipment.ts';
import { equipmentAttackProcs } from '../src/domain/equipment-attack-procs.ts';
import { equipmentCombatProcs } from '../src/domain/equipment-combat-procs.ts';
import { equipmentRecoveryModifiers } from '../src/domain/equipment-recovery.ts';
import { equipmentStateImmunity } from '../src/domain/equipment-state-immunity.ts';
import { equipmentThreatReduction } from '../src/domain/equipment-threat.ts';
import { enhancementOdds } from '../src/domain/enhancement.ts';
import { parseCharacterStats, parseItemCatalog } from '../src/application/content-validation.ts';

const read = (name: string): unknown => JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const catalog = parseCharacterStats(read('character-stats'));
const items = parseItemCatalog(read('items'));

const CLASS_IDS = Object.keys(items.startingEquipment);
const EQUIPMENT_IDS = Object.keys(catalog.equipment);
const GEM_IDS = Object.keys(catalog.gems);
const SCROLL_IDS = Object.keys(catalog.enchantments);
const ATTRIBUTE_IDS = Object.keys(catalog.modifiers);
const MAX_LEVEL = 105;

const heroAt = (classId: string, level = 1): BattleCharacter => {
  const hero = new BattleCharacter(classId, catalog, items);
  if (level > 1) hero.addExperience(Number.MAX_SAFE_INTEGER);
  return hero;
};

const lastEntry = (hero: BattleCharacter, item: string): ItemInstance => {
  const entries = hero.bag.entries.filter(entry => entry.item === item);
  assert.ok(entries.length > 0, `背包里应该有 ${item}`);
  return entries[entries.length - 1]!;
};

const patchInstance = (hero: BattleCharacter, id: string, change: (entry: ItemInstance) => void): void => {
  const state = hero.bag.captureState();
  const entry = state.instances.find(candidate => candidate.id === id);
  assert.ok(entry, `实例 ${id} 应该在背包状态里`);
  change(entry);
  hero.bag.restoreState(state);
};

const ensureScroll = (hero: BattleCharacter, item: string): string => {
  if (hero.bag.count(item) === 0) hero.bag.add(item);
  return lastEntry(hero, item).id;
};

const sequence = (...values: number[]): (() => number) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
};

const rejectsWithNotice = (notice: ItemNotice) => (error: unknown): boolean =>
  error instanceof ItemApplicationError && error.notice === notice;

const allowedClass = (definition: ItemDefinition): string => {
  const rule = definition.equipment!;
  const classId = rule.classes.find(id => CLASS_IDS.includes(id));
  assert.ok(classId, `${definition.name} 应该有可用职业`);
  return classId;
};

const expectedSlots = (definition: ItemDefinition, classId: string): EquipmentSlot[] => {
  const rule = definition.equipment!;
  if (rule.locked || !rule.classes.includes(classId)) return [];
  const slots: EquipmentSlot[] = [rule.slot];
  if (rule.dualWield && items.dualWieldClasses.includes(classId)) slots.push('off-hand');
  if (rule.slot === 'ring') slots.push('accessory');
  return slots;
};

const emptyNumbers = (): NonNullable<ItemInstance['numbers']> => ({
  modifiers: [], gemModifiers: [], magicPercent: 0, sockets: 0, enhancementUses: 0,
});

const instanceWith = (id: string, normal: Modifier[], gems: Modifier[], item = 'probe'): ItemInstance => ({
  id, item, quantity: 1, enhancement: 0, gems: [],
  numbers: { ...emptyNumbers(), modifiers: normal, gemModifiers: gems },
});

const ATTACK_PROC_FIELDS: Readonly<Record<string, string>> = {
  fire: 'fireSplashChance', wind: 'windStrikeChance', freeze: 'frostStrikeChance',
  divine: 'divineStrikeChance', darkness: 'darknessStrikeChance', poison: 'poisonStrikeChance',
};
const COMBAT_PROC_FIELDS: Readonly<Record<string, string>> = {
  pendulum: 'pendulumStunChance', frost: 'frostRetaliationChance', healingEnergy: 'healingEnergyChance',
  zealot: 'zealotRate', instantRecovery: 'instantRecoveryPerThousand',
};
const RECOVERY_FIELDS: Readonly<Record<string, string>> = {
  lifeSteal: 'lifeDrainPerThousand', manaRegen: 'manaRecoveryPerPulse', spellExpert: 'manaCostReductionRate',
};
const IMMUNITY_FIELDS: Readonly<Record<string, string>> = { sleep: 'sleepResistance', stun: 'stunResistance' };

const CONTENT_STATS = new Set(ATTRIBUTE_IDS);
const UNKNOWN_STATS = ['not-a-content-attribute', 'toString', 'constructor', '__proto__', 'hasOwnProperty'];

const sumMapped = (field: string, normal: readonly Modifier[], gems: readonly Modifier[], fields: Readonly<Record<string, string>>): number => {
  let sum = 0;
  for (const modifier of [...normal, ...gems]) if (fields[modifier.stat] === field) sum += modifier.value;
  return sum;
};

const panelFields: Readonly<Record<string, keyof CharacterPanel | 'attribute'>> = {
  strength: 'attribute', dexterity: 'attribute', vitality: 'attribute', intelligence: 'attribute', mentality: 'attribute',
  criticalRate: 'criticalRate', hitBonus: 'hitBonus', criticalDamageResistance: 'criticalDamageResistance',
  magicResistance: 'baseMagicResistance', evasionBonus: 'evasionBonus', shieldBlock: 'shieldBlock',
  weaponBlock: 'weaponBlock', maxMana: 'maxMana', criticalResistance: 'criticalResistance',
  criticalDamage: 'criticalDamage',
};
const NON_PANEL_STATS = new Set(['lifeSteal', 'manaRegen']);

const panelValue = (panel: CharacterPanel, stat: string): number => {
  const field = panelFields[stat];
  assert.ok(field, `没有为 ${stat} 定义面板字段`);
  if (field === 'attribute') return panel.attributes[stat as keyof CharacterPanel['attributes']];
  return panel[field] as number;
};

test('content exposes the complete equipment, gem, scroll and modifier tables', () => {
  assert.equal(EQUIPMENT_IDS.length, 662, '装备数量');
  assert.equal(GEM_IDS.length, 5, '宝石种类');
  assert.equal(SCROLL_IDS.length, 12, '强化卷轴数量');
  assert.equal(ATTRIBUTE_IDS.length, 36, '词条属性名数量');
  assert.equal(CLASS_IDS.length, 6, '职业数量');

  for (const id of EQUIPMENT_IDS) {
    const definition = items.items[id]!;
    assert.ok(definition.equipment, `${id} 应该有装备规则`);
    assert.equal(definition.stackable, false, `${id} 不应该叠加`);
    assert.ok(catalog.equipment[id], `${id} 应该有装备数值`);
  }
  for (const id of GEM_IDS) assert.equal(items.items[id]!.use?.kind, 'socket', `${id} 的用途`);
  for (const id of SCROLL_IDS) assert.equal(items.items[id]!.use?.kind, 'enchant', `${id} 的用途`);
  for (const [id, rules] of Object.entries(catalog.enchantments)) {
    const use = items.items[id]!.use!;
    assert.ok(use.target, `${id} 应该声明强化目标类别`);
    assert.ok(Object.keys(rules).length > 0, `${id} 应该有装备类别规则`);
    const wantsWeapon = use.target === 'weapon';
    const enchantableKinds = new Set(Object.keys(items.items).filter(itemId => {
      const definition = items.items[itemId]!;
      const equipment = definition.equipment;
      return !!equipment?.enchantable && (definition.priceKind === 'weapon' || equipment.slot === 'main-hand') === wantsWeapon;
    }).map(itemId => items.items[itemId]!.kind));
    for (const kind of enchantableKinds) assert.ok(rules[kind], `${id} 缺少 ${kind} 规则`);
    for (const rule of Object.values(rules)) {
      assert.equal(rule.threshold, 10, `${id} 的阈值`);
      assert.ok(rule.step > 0 && rule.extra >= 0, `${id} 的强化增量`);
      assert.equal(rule.bonusChance ?? 0, id.startsWith('sp-') ? 300 : 0, `${id} 的第二次判定加成`);
    }
  }
  for (const id of EQUIPMENT_IDS) {
    const numbers = catalog.equipment[id]!;
    for (const range of [...numbers.fixedOptions, ...numbers.randomOptions]) assert.ok(CONTENT_STATS.has(range.stat), `${id} 的词条 ${range.stat}`);
  }
  for (const [gem, tiers] of Object.entries(catalog.gems)) {
    for (const tier of tiers) for (const option of tier) assert.ok(CONTENT_STATS.has(option.stat), `${gem} 的词条 ${option.stat}`);
  }
});

test('all 662 equipment entries expose their class, slot and dual-wield rules', () => {
  const hero = heroAt('dark-knight', MAX_LEVEL);
  for (const id of EQUIPMENT_IDS) hero.bag.add(id);
  const instanceIds = new Map(hero.bag.entries.map(entry => [entry.item, entry.id]));
  let checks = 0;
  for (const id of EQUIPMENT_IDS) {
    const definition = items.items[id]!;
    const rule = definition.equipment!;
    const entryId = instanceIds.get(id)!;
    for (const classId of CLASS_IDS) {
      const expected = expectedSlots(definition, classId);
      assert.deepEqual(hero.bag.slotsFor(entryId, classId), expected, `${id} / ${classId}`);
      if (!expected.includes(rule.slot)) {
        assert.throws(() => hero.bag.equip(entryId, rule.slot, 'player', classId), /不能装备在此位置/, `${id} / ${classId}`);
      }
      checks++;
    }
  }
  assert.equal(checks, 662 * 6);
});

test('all 662 equipment entries honor the level gate resolved from item level and chaos offset', () => {
  const heroes = new Map(CLASS_IDS.map(classId => [classId, heroAt(classId, 1)]));
  for (const id of EQUIPMENT_IDS) {
    const definition = items.items[id]!;
    if (definition.equipment!.locked) continue;
    heroes.get(allowedClass(definition))!.bag.add(id);
  }
  const instances = new Map<string, ItemInstance>();
  for (const hero of heroes.values()) for (const entry of hero.bag.entries) instances.set(entry.item, entry);
  let blocked = 0;
  let allowed = 0;
  for (const id of EQUIPMENT_IDS) {
    const definition = items.items[id]!;
    const rule = definition.equipment!;
    if (rule.locked) continue;
    const hero = heroes.get(allowedClass(definition))!;
    const entry = instances.get(id)!;
    const entryId = entry.id;
    const requiredLevel = equipmentLevel(definition, entry);
    if (requiredLevel > 1) {
      assert.throws(() => hero.bag.equip(entryId, rule.slot), /需要等级/, `${id} 需要 ${requiredLevel} 级`);
      blocked++;
    } else {
      hero.bag.equip(entryId, rule.slot);
      assert.equal(hero.bag.equipment[rule.slot], entryId, id);
      hero.bag.unequip(rule.slot);
      allowed++;
    }
  }
  assert.equal(blocked + allowed, 662 - 26);
  assert.ok(blocked > 0 && allowed > 0);
});

test('all 636 player-equippable equipment pieces keep every rolled value across equip and unequip', () => {
  const heroes = new Map(CLASS_IDS.map(classId => [classId, heroAt(classId, MAX_LEVEL)]));
  for (const id of EQUIPMENT_IDS) {
    const definition = items.items[id]!;
    if (definition.equipment!.locked) continue;
    heroes.get(allowedClass(definition))!.bag.add(id);
  }
  const entries = new Map<string, ItemInstance>();
  for (const hero of heroes.values()) for (const entry of hero.bag.entries) entries.set(entry.item, entry);
  let checked = 0;
  for (const id of EQUIPMENT_IDS) {
    const definition = items.items[id]!;
    const rule = definition.equipment!;
    if (rule.locked) continue;
    const hero = heroes.get(allowedClass(definition))!;
    const entry = entries.get(id)!;
    const original = structuredClone(entry);
    assert.ok(entry.numbers, `${id} 应该有随机数值`);
    hero.bag.equip(entry.id, rule.slot);
    assert.equal(hero.bag.equipment[rule.slot], entry.id, id);
    const worn = hero.bag.get(entry.id);
    assert.ok(worn);
    hero.bag.unequip(rule.slot);
    assert.equal(hero.bag.equipment[rule.slot], undefined, id);
    assert.deepEqual(hero.bag.get(entry.id), worn, `${id} 卸下后数值不应变化`);
    assert.deepEqual(hero.bag.get(entry.id), original, `${id} 穿戴不应改动实例`);
    assert.deepEqual(equipmentPower(catalog.equipment[id]!, worn), equipmentPower(catalog.equipment[id]!, original));
    checked++;
  }
  assert.equal(checked, 662 - 26);
});

test('locked equipment cannot be player-equipped but a forced wear keeps its rolls', () => {
  const locked = EQUIPMENT_IDS.filter(id => items.items[id]!.equipment!.locked);
  assert.equal(locked.length, 26);
  const hero = heroAt('dark-knight', MAX_LEVEL);
  for (const id of locked) {
    const rule = items.items[id]!.equipment!;
    hero.bag.add(id);
    const loose = lastEntry(hero, id);
    assert.deepEqual(hero.bag.slotsFor(loose.id, hero.classId), [], id);
    assert.throws(() => hero.bag.equip(loose.id, rule.slot), /不能装备在此位置/, id);
    hero.bag.remove(id, 1);
    const wornId = hero.bag.addEquipped(id, rule.slot, 'player', hero.classId, MAX_LEVEL);
    const before = hero.bag.get(wornId);
    assert.ok(before?.numbers, `${id} 应该有随机数值`);
    hero.bag.unequip(rule.slot);
    assert.deepEqual(hero.bag.get(wornId), before, `${id} 卸下后数值不应变化`);
  }
});

test('equipmentLevel applies signed chaos offsets and clamps at the 100 and 105 ceilings', () => {
  const withOffset = (levelOffset: number): ItemInstance => ({
    id: 'probe', item: 'probe', quantity: 1, enhancement: 0, gems: [],
    numbers: { ...emptyNumbers(), chaos: { tier: 'chaos', valuePercent: 100, levelOffset } },
  });
  const cases: [number, number, number][] = [
    [100, 0, 100], [100, 10, 100], [100, -10, 90], [100, -200, 0],
    [101, 0, 101], [101, 10, 105], [101, -10, 91],
    [120, 0, 105], [120, 10, 105], [120, -10, 105], [120, -20, 100], [120, -200, 0],
    [99, 10, 100], [99, -10, 89], [105, 0, 105], [105, 5, 105], [105, -10, 95], [105, -200, 0],
  ];
  for (const [itemLevel, levelOffset, expected] of cases) {
    assert.equal(equipmentLevel({ level: itemLevel }, withOffset(levelOffset)), expected,
      `item.level=${itemLevel} offset=${levelOffset}`);
  }
});

test('equipment never merges by item id and stackable items merge only while they hold no instance state', () => {
  const hero = heroAt('dark-knight', 1);
  for (const id of EQUIPMENT_IDS) {
    hero.bag.add(id);
    hero.bag.add(id);
  }
  const copiesByItem = new Map<string, ItemInstance[]>();
  for (const entry of hero.bag.entries) copiesByItem.set(entry.item, [...(copiesByItem.get(entry.item) ?? []), entry]);
  for (const id of EQUIPMENT_IDS) {
    const copies = copiesByItem.get(id)!;
    assert.equal(copies.length, 2, `${id} 的两份实例应该分开`);
    assert.notEqual(copies[0]!.id, copies[1]!.id, id);
    assert.ok(copies.every(entry => entry.quantity === 1), id);
  }
  const mergeHero = heroAt('assassin', 1);
  mergeHero.bag.add('novice-weapon-scroll');
  mergeHero.bag.add('novice-weapon-scroll');
  let scrolls = mergeHero.bag.entries.filter(entry => entry.item === 'novice-weapon-scroll');
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0]!.quantity, 2);
  mergeHero.bag.add('novice-weapon-scroll');
  scrolls = mergeHero.bag.entries.filter(entry => entry.item === 'novice-weapon-scroll');
  assert.equal(scrolls[0]!.quantity, 3);
  patchInstance(mergeHero, scrolls[0]!.id, entry => { entry.numbers = emptyNumbers(); });
  mergeHero.bag.add('novice-weapon-scroll');
  scrolls = mergeHero.bag.entries.filter(entry => entry.item === 'novice-weapon-scroll');
  assert.equal(scrolls.length, 2, '带实例状态的同 id 物品不再合并');
  assert.equal(scrolls.filter(entry => entry.numbers === undefined).length, 1);
  assert.equal(scrolls.find(entry => entry.numbers === undefined)!.quantity, 1);
});

test('all five gem families generate exactly one modifier taken from their tier and option tables', () => {
  const hero = heroAt('dark-knight', 1);
  for (const gemId of GEM_IDS) {
    const definition = items.items[gemId]!;
    assert.equal(definition.use?.kind, 'socket');
    const rangesByStat = new Map<string, ModifierRange[]>();
    for (const tier of catalog.gems[gemId]!) for (const option of tier) {
      rangesByStat.set(option.stat, [...(rangesByStat.get(option.stat) ?? []), option]);
    }
    for (let sample = 0; sample < 120; sample++) {
      const gem = hero.bag.prepareDrop(gemId);
      const numbers = gem.numbers;
      assert.ok(numbers, `${gemId} 应该生成宝石数值`);
      assert.equal(numbers.modifiers.length, 1, `${gemId} 每次只生成一条词条`);
      const modifier = numbers.modifiers[0]!;
      const ranges = rangesByStat.get(modifier.stat);
      assert.ok(ranges, `${gemId} 生成了不存在的词条 ${modifier.stat}`);
      assert.ok(ranges.some(range => modifier.value >= range.min && modifier.value <= range.max),
        `${gemId} 的 ${modifier.stat}=${modifier.value} 不在内容范围内`);
      assert.deepEqual(numbers.gemModifiers, []);
      assert.equal(numbers.magicPercent, 0);
      assert.equal(numbers.sockets, 0);
      assert.equal(numbers.enhancementUses, 0);
    }
  }
});

test('every gem tier and option in content can be produced by gem initialization', () => {
  const syntheticItems: Record<string, ItemDefinition> = {};
  const syntheticGems: Record<string, ModifierRange[][]> = {};
  let tiers = 0;
  let options = 0;
  for (const gemId of GEM_IDS) {
    catalog.gems[gemId]!.forEach((tier, tierIndex) => {
      tiers++;
      tier.forEach((option, optionIndex) => {
        options++;
        const key = `synthetic:${gemId}:${tierIndex}:${optionIndex}`;
        syntheticItems[key] = { ...items.items[gemId]!, name: key };
        syntheticGems[key] = [[{ ...option }]];
      });
    });
  }
  assert.equal(tiers, 204);
  assert.equal(options, 3024);
  const rowCount = Math.max(...GEM_IDS.map(gemId => catalog.gems[gemId]!.length));
  assert.equal(rowCount, 51);
  const rowProbe = 'synthetic:row-probe';
  syntheticItems[rowProbe] = { ...items.items[GEM_IDS[0]!]!, name: rowProbe };
  syntheticGems[rowProbe] = Array.from({ length: rowCount }, (_, index) => [{ stat: 'strength', min: index, max: index }]);
  const syntheticCatalog: CharacterStatsCatalog = {
    maxLevel: 1, statPointsPerLevel: 0, skillPointsPerLevel: 0, experience: [null],
    classes: { probe: { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 } },
    modifiers: catalog.modifiers, equipment: {}, gems: syntheticGems, enchantments: {},
  };
  const syntheticItemCatalog: ItemCatalog = {
    ...items, items: syntheticItems, startingEquipment: { probe: {} }, startingInventory: [],
    startingShortcut: '', dualWieldClasses: [], merchantItems: [], classSkills: { probe: [] }, recipes: {},
  };
  const hero = new BattleCharacter('probe', syntheticCatalog, syntheticItemCatalog);
  for (const [key, table] of Object.entries(syntheticGems)) {
    if (key === rowProbe) continue;
    const expected = table[0]![0]!;
    const numbers = hero.bag.prepareDrop(key).numbers;
    assert.ok(numbers, key);
    assert.equal(numbers.modifiers.length, 1, key);
    const modifier = numbers.modifiers[0]!;
    assert.equal(modifier.stat, expected.stat, key);
    assert.ok(modifier.value >= expected.min && modifier.value <= expected.max, `${key}: ${modifier.value}`);
  }
  const seenRows = new Set<number>();
  for (let sample = 0; sample < 1000; sample++) {
    const numbers = hero.bag.prepareDrop(rowProbe).numbers;
    assert.ok(numbers);
    assert.equal(numbers.modifiers.length, 1);
    seenRows.add(numbers.modifiers[0]!.value);
  }
  assert.deepEqual([...seenRows].sort((left, right) => left - right), Array.from({ length: rowCount }, (_, index) => index));
});

test('socketing copies the stored gem modifier once and enforces zero and full socket limits', () => {
  for (const gemId of GEM_IDS) {
    const hero = heroAt('dark-knight', 1);
    const bag = hero.bag;
    const weaponId = bag.equipment['main-hand']!;
    patchInstance(hero, weaponId, entry => { entry.numbers!.sockets = 1; entry.numbers!.gemModifiers = []; entry.gems = []; });
    bag.add(gemId);
    const gem = lastEntry(hero, gemId);
    const modifier = gem.numbers!.modifiers[0]!;
    bag.use(gem.id, weaponId);
    const target = bag.get(weaponId)!;
    assert.deepEqual(target.gems, [gemId]);
    assert.equal(target.numbers!.gemModifiers.length, 1);
    assert.deepEqual(target.numbers!.gemModifiers[0], modifier);
    assert.equal(bag.count(gemId), 0, '镶嵌后宝石离开背包');

    bag.add(gemId);
    const fullGem = lastEntry(hero, gemId);
    assert.equal(bag.targetProblem(fullGem.id, weaponId), ITEM_NOTICE_TEXT['socket-full']);
    assert.throws(() => bag.use(fullGem.id, weaponId), rejectsWithNotice('socket-full'));
    assert.equal(bag.count(gemId), 1, '失败不消耗宝石');

    patchInstance(hero, weaponId, entry => { entry.numbers!.sockets = 0; entry.numbers!.gemModifiers = []; entry.gems = []; });
    bag.add(gemId);
    const zeroGem = lastEntry(hero, gemId);
    assert.throws(() => bag.use(zeroGem.id, weaponId), rejectsWithNotice('socket-full'));
    assert.equal(bag.count(gemId), 2, '0 孔时失败也不消耗宝石');
  }
});

test('unsocket and swapGem return the original gems with the modifiers they carried', () => {
  GEM_IDS.forEach((gemId, index) => {
    const replacementId = GEM_IDS[(index + 1) % GEM_IDS.length]!;
    const hero = heroAt('dark-knight', 1);
    const bag = hero.bag;
    const weaponId = bag.equipment['main-hand']!;
    patchInstance(hero, weaponId, entry => { entry.numbers!.sockets = 4; entry.numbers!.gemModifiers = []; entry.gems = []; });
    bag.add(gemId);
    bag.use(lastEntry(hero, gemId).id, weaponId);
    const storedModifier = structuredClone(bag.get(weaponId)!.numbers!.gemModifiers[0]!);
    const removed = bag.unsocket(weaponId, 0);
    const restored = bag.get(removed.gemId)!;
    assert.equal(restored.item, gemId);
    assert.deepEqual(restored.numbers!.modifiers, [storedModifier]);
    assert.deepEqual(bag.get(weaponId)!.gems, []);
    assert.deepEqual(bag.get(weaponId)!.numbers!.gemModifiers, []);

    bag.add(gemId);
    bag.use(lastEntry(hero, gemId).id, weaponId);
    const oldModifier = structuredClone(bag.get(weaponId)!.numbers!.gemModifiers[0]!);
    bag.add(replacementId);
    const source = lastEntry(hero, replacementId);
    const sourceModifier = structuredClone(source.numbers!.modifiers[0]!);
    const swapped = bag.swapGem(weaponId, 0, source.id);
    const target = bag.get(weaponId)!;
    assert.deepEqual(target.gems, [replacementId]);
    assert.deepEqual(target.numbers!.gemModifiers, [sourceModifier]);
    const old = bag.get(swapped.removedId)!;
    assert.equal(old.item, gemId);
    assert.deepEqual(old.numbers!.modifiers, [oldModifier]);
    assert.equal(bag.get(source.id), undefined, '替换用的宝石已经消耗');
  });
});

test('previewGemChange replaces the target gem modifiers for every gem family', () => {
  for (const gemId of GEM_IDS) {
    const hero = heroAt('dark-knight', 1);
    const bag = hero.bag;
    const weaponId = bag.equipment['main-hand']!;
    patchInstance(hero, weaponId, entry => { entry.numbers!.gemModifiers = []; entry.gems = []; });
    assert.equal(hero.panel.offhandShield, true, '基础盾牌让盾牌格挡进入面板');
    const modifier = hero.bag.prepareDrop(gemId).numbers!.modifiers[0]!;
    const before = hero.panel;
    const preview = hero.previewGemChange(weaponId, [{ ...modifier }]);
    assert.ok(preview, `${gemId} 的预览应该返回面板`);
    if (NON_PANEL_STATS.has(modifier.stat)) {
      assert.deepEqual(preview, before, `${gemId} 的 ${modifier.stat} 不进面板`);
    } else {
      assert.equal(panelValue(preview, modifier.stat), panelValue(before, modifier.stat) + modifier.value,
        `${gemId} 的 ${modifier.stat} 应增加 ${modifier.value}`);
    }
  }
});

test('previewGemChange applies every gem attribute with an exact panel delta', () => {
  const gemStats = [...new Set(Object.values(catalog.gems).flatMap(tiers => tiers.flatMap(tier => tier.map(option => option.stat))))].sort();
  assert.equal(gemStats.length, 17, '宝石可选属性数量');
  assert.ok(gemStats.every(stat => CONTENT_STATS.has(stat)), '宝石属性都应在 catalog.modifiers 中');
  const hero = heroAt('dark-knight', 1);
  const bag = hero.bag;
  const weaponId = bag.equipment['main-hand']!;
  patchInstance(hero, weaponId, entry => { entry.numbers!.gemModifiers = []; entry.gems = []; });
  assert.equal(hero.panel.offhandShield, true, '基础盾牌让盾牌格挡进入面板');
  const before = hero.panel;
  gemStats.forEach((stat, index) => {
    const value = index + 1;
    const preview = hero.previewGemChange(weaponId, [{ stat, value }]);
    assert.ok(preview, `${stat} 的预览应该返回面板`);
    if (NON_PANEL_STATS.has(stat)) {
      assert.deepEqual(preview, before, `${stat} 不应改变面板`);
    } else {
      assert.equal(panelValue(preview, stat), panelValue(before, stat) + value, `${stat} 的增量应为 ${value}`);
    }
  });
});

test('socket operations reject incomplete gem data without consuming the gem or changing the target', () => {
  const hero = heroAt('dark-knight', 1);
  const bag = hero.bag;
  const weaponId = bag.equipment['main-hand']!;
  patchInstance(hero, weaponId, entry => { entry.numbers!.sockets = 4; entry.numbers!.gemModifiers = []; entry.gems = []; });
  bag.add('novice-jewel');
  const gem = lastEntry(hero, 'novice-jewel');

  patchInstance(hero, weaponId, entry => { entry.gems = ['novice-jewel']; entry.numbers!.gemModifiers = []; });
  let before = structuredClone(bag.get(weaponId));
  assert.throws(() => bag.use(gem.id, weaponId), /宝石数据不完整/);
  assert.deepEqual(bag.get(weaponId), before);
  assert.ok(bag.get(gem.id), '拒绝时不消耗宝石');

  patchInstance(hero, weaponId, entry => { entry.gems = []; entry.numbers!.gemModifiers = []; });
  const weakGem = lastEntry(hero, 'novice-jewel');
  patchInstance(hero, weakGem.id, entry => { entry.numbers!.modifiers = []; });
  before = structuredClone(bag.get(weaponId));
  assert.throws(() => bag.use(weakGem.id, weaponId), /宝石数据不完整/);
  assert.deepEqual(bag.get(weaponId), before);
  assert.ok(bag.get(weakGem.id), '拒绝时不消耗宝石');

  patchInstance(hero, weaponId, entry => { entry.gems = ['novice-jewel']; entry.numbers!.gemModifiers = []; });
  assert.throws(() => bag.unsocket(weaponId, 0), /数据不完整，无法取出/);

  bag.add('standard-jewel');
  const source = lastEntry(hero, 'standard-jewel');
  assert.throws(() => bag.swapGem(weaponId, 0, source.id), /数据不完整，无法替换/);
  assert.ok(bag.get(source.id), '拒绝时不消耗替换宝石');

  patchInstance(hero, weaponId, entry => { entry.gems = []; entry.numbers = undefined; });
  assert.throws(() => bag.use(bag.entries.find(entry => entry.id === gem.id)!.id, weaponId),
    rejectsWithNotice('socket-incompatible'));
});

test('all twelve scrolls advertise the same odds that Bag.use follows', () => {
  const targetFor = (scrollId: string): string => items.items[scrollId]!.use!.target === 'weapon' ? 'basic-longsword' : 'robe';
  for (const scrollId of SCROLL_IDS) {
    const use = items.items[scrollId]!.use!;
    const requiresEnhanced = !!use.requiresEnhanced;
    const targetItem = targetFor(scrollId);
    const rule = catalog.enchantments[scrollId]![items.items[targetItem]!.kind]!;
    const bonusChance = rule.bonusChance ?? 0;
    const hero = heroAt('dark-knight', 1);
    const bag = hero.bag;
    bag.add(targetItem);
    const targetId = lastEntry(hero, targetItem).id;
    const levels = requiresEnhanced ? [1, 10, 20, 28] : [0, 1, 10, 28];
    for (const level of levels) {
      const uses = requiresEnhanced ? 0 : 5;
      const reset = (): void => patchInstance(hero, targetId, entry => {
        entry.enhancement = level;
        entry.numbers!.enhancementUses = uses;
        entry.numbers!.enhancementScroll = undefined;
        entry.numbers!.enhancementRule = undefined;
      });
      reset();
      const odds = bag.applicationOdds(ensureScroll(hero, scrollId), targetId);
      assert.ok(odds, `${scrollId} +${level} 应该有概率`);
      assert.deepEqual(odds, enhancementOdds(level, requiresEnhanced, bonusChance), `${scrollId} +${level}`);
      assert.ok(odds.double > 0 && odds.double < 1, `${scrollId} +${level} 的 +2 概率`);

      reset();
      bag.use(ensureScroll(hero, scrollId), targetId, undefined, sequence(0, 0));
      let entry = bag.get(targetId)!;
      assert.equal(entry.enhancement, level + 2, `${scrollId} +${level} 双升`);
      if (!requiresEnhanced) assert.equal(entry.numbers!.enhancementUses, uses - 1, `${scrollId} 消耗一次耐久`);

      reset();
      bag.use(ensureScroll(hero, scrollId), targetId, undefined,
        requiresEnhanced ? sequence(0, 0.999999) : () => 0.999999);
      entry = bag.get(targetId)!;
      assert.equal(entry.enhancement, level + 1, `${scrollId} +${level} 单升`);
      if (!requiresEnhanced) assert.equal(entry.numbers!.enhancementUses, uses - 1, `${scrollId} 消耗一次耐久`);

      reset();
      bag.use(ensureScroll(hero, scrollId), targetId, undefined, () => 0.999999);
      entry = bag.get(targetId)!;
      if (requiresEnhanced && odds.failure > 0) {
        assert.equal(entry.enhancement, level - 1, `${scrollId} +${level} 失败降级`);
      } else {
        assert.equal(entry.enhancement, level + 1, `${scrollId} +${level} 不会失败`);
      }
      assert.equal(entry.numbers!.enhancementUses, requiresEnhanced ? uses : uses - 1,
        `${scrollId} 混沌卷轴不动耐久或普通卷轴只扣一次`);
    }
  }
});

test('ordinary scrolls always add at least one level and the second roll can add another', () => {
  const ordinary = SCROLL_IDS.filter(id => !items.items[id]!.use!.requiresEnhanced);
  assert.equal(ordinary.length, 10);
  for (const scrollId of ordinary) {
    const targetItem = items.items[scrollId]!.use!.target === 'weapon' ? 'basic-longsword' : 'robe';
    const hero = heroAt('dark-knight', 1);
    const bag = hero.bag;
    bag.add(targetItem);
    const targetId = lastEntry(hero, targetItem).id;
    for (const level of [0, 1, 10, 28]) {
      patchInstance(hero, targetId, entry => {
        entry.enhancement = level;
        entry.numbers!.enhancementUses = 3;
        entry.numbers!.enhancementScroll = undefined;
        entry.numbers!.enhancementRule = undefined;
      });
      bag.use(ensureScroll(hero, scrollId), targetId, undefined, () => 0.999999);
      assert.equal(bag.get(targetId)!.enhancement, level + 1, `${scrollId} +${level} 至少 +1`);
      patchInstance(hero, targetId, entry => {
        entry.enhancement = level;
        entry.numbers!.enhancementUses = 3;
        entry.numbers!.enhancementScroll = undefined;
        entry.numbers!.enhancementRule = undefined;
      });
      bag.use(ensureScroll(hero, scrollId), targetId, undefined, () => 0);
      assert.equal(bag.get(targetId)!.enhancement, level + 2, `${scrollId} +${level} 可 +2`);
    }
  }
});

test('chaos scrolls fail down one level, never below zero, and leave durability untouched', () => {
  const chaos = SCROLL_IDS.filter(id => items.items[id]!.use!.requiresEnhanced);
  assert.equal(chaos.length, 2);
  for (const scrollId of chaos) {
    const targetItem = items.items[scrollId]!.use!.target === 'weapon' ? 'basic-longsword' : 'robe';
    const hero = heroAt('dark-knight', 1);
    const bag = hero.bag;
    bag.add(targetItem);
    const targetId = lastEntry(hero, targetItem).id;
    const reset = (level: number): void => patchInstance(hero, targetId, entry => {
      entry.enhancement = level;
      entry.numbers!.enhancementUses = 0;
      entry.numbers!.enhancementScroll = undefined;
      entry.numbers!.enhancementRule = undefined;
    });
    const rule = catalog.enchantments[scrollId]![items.items[targetItem]!.kind]!;
    reset(10);
    bag.use(ensureScroll(hero, scrollId), targetId, undefined, () => 0.999999);
    let target = bag.get(targetId)!;
    assert.equal(target.enhancement, 9, `${scrollId} 失败降一级`);
    assert.equal(target.numbers!.enhancementUses, 0, `${scrollId} 不消耗耐久`);
    assert.deepEqual(target.numbers!.enhancementRule, rule, `${scrollId} 首次写入规则`);
    assert.equal(target.numbers!.enhancementScroll, undefined, `${scrollId} 不写卷轴来源`);

    patchInstance(hero, targetId, entry => { entry.numbers!.enhancementUses = 5; });
    const ordinary = SCROLL_IDS.find(id =>
      !items.items[id]!.use!.requiresEnhanced && items.items[id]!.use!.target === items.items[scrollId]!.use!.target)!;
    const ordinaryId = ensureScroll(hero, ordinary);
    assert.equal(bag.targetProblem(ordinaryId, targetId), ITEM_NOTICE_TEXT['enchant-rule'],
      '混沌卷轴写入的规则也会参与后续校验');

    reset(20);
    bag.use(ensureScroll(hero, scrollId), targetId, undefined, sequence(0, 0.999999));
    assert.equal(bag.get(targetId)!.enhancement, 21, `${scrollId} 成功未双升`);
    assert.equal(bag.get(targetId)!.numbers!.enhancementUses, 0, `${scrollId} 不消耗耐久`);

    reset(0);
    const scrollIdInBag = ensureScroll(hero, scrollId);
    const scrollCount = bag.count(scrollId);
    assert.equal(bag.applicationProblem(scrollIdInBag, targetId), 'enchant-first');
    assert.equal(bag.applicationOdds(scrollIdInBag, targetId), undefined);
    assert.throws(() => bag.use(scrollIdInBag, targetId, undefined, () => 0.999999), rejectsWithNotice('enchant-first'));
    assert.equal(bag.get(targetId)!.enhancement, 0, `${scrollId} 0 级不会降到负数`);
    assert.equal(bag.count(scrollId), scrollCount, '拒绝时不消耗卷轴');
  }
});

test('every scroll rule entry enchants its real equipment kind with the right odds and durability', () => {
  const enchantableCatalogCache = new Map<string, ItemCatalog>();
  const catalogForItem = (itemId: string): ItemCatalog => {
    if (items.items[itemId]!.equipment!.enchantable) return items;
    const cached = enchantableCatalogCache.get(itemId);
    if (cached) return cached;
    const definition = items.items[itemId]!;
    const withEnchantable: ItemCatalog = {
      ...items,
      items: { ...items.items, [itemId]: { ...definition, equipment: { ...definition.equipment!, enchantable: true } } },
    };
    enchantableCatalogCache.set(itemId, withEnchantable);
    return withEnchantable;
  };
  const targetForRule = (scrollId: string, kind: string): { itemId: string; realEnchantable: boolean } => {
    const use = items.items[scrollId]!.use!;
    const wantsWeapon = use.target === 'weapon';
    const candidates = Object.keys(items.items).filter(itemId => {
      const definition = items.items[itemId]!;
      const equipment = definition.equipment;
      if (!equipment || definition.kind !== kind) return false;
      if ((definition.priceKind === 'weapon' || equipment.slot === 'main-hand') !== wantsWeapon) return false;
      return !use.maxLevel || definition.level <= use.maxLevel;
    });
    assert.ok(candidates.length, `${scrollId} / ${kind} 应该有真实物品`);
    candidates.sort((left, right) => {
      const enchantableRank = Number(items.items[right]!.equipment!.enchantable) - Number(items.items[left]!.equipment!.enchantable);
      return enchantableRank || items.items[left]!.level - items.items[right]!.level;
    });
    const itemId = candidates[0]!;
    return { itemId, realEnchantable: items.items[itemId]!.equipment!.enchantable };
  };

  let combos = 0;
  let clonedCatalogCombos = 0;
  const kinds = new Set<string>();
  const clonedKinds = new Set<string>();
  for (const [scrollId, rules] of Object.entries(catalog.enchantments)) {
    const use = items.items[scrollId]!.use!;
    const requiresEnhanced = !!use.requiresEnhanced;
    for (const [kind, rule] of Object.entries(rules)) {
      const { itemId, realEnchantable } = targetForRule(scrollId, kind);
      const hero = new BattleCharacter('dark-knight', catalog, catalogForItem(itemId));
      const bag = hero.bag;
      bag.add(itemId);
      const target = lastEntry(hero, itemId);
      patchInstance(hero, target.id, entry => {
        entry.enhancement = 1;
        entry.numbers!.enhancementUses = requiresEnhanced ? 0 : 5;
        entry.numbers!.enhancementScroll = undefined;
        entry.numbers!.enhancementRule = undefined;
      });
      const scrollInstance = ensureScroll(hero, scrollId);
      assert.equal(bag.canApply(scrollInstance, target.id), true, `${scrollId} / ${kind} 可应用`);
      assert.equal(bag.applicationProblem(scrollInstance, target.id), undefined, `${scrollId} / ${kind} 无规则问题`);
      assert.deepEqual(bag.applicationOdds(scrollInstance, target.id),
        enhancementOdds(1, requiresEnhanced, rule.bonusChance ?? 0), `${scrollId} / ${kind} 概率与加成`);
      const scrollCount = bag.count(scrollId);
      bag.use(scrollInstance, target.id, undefined, () => 0);
      const used = bag.get(target.id)!;
      assert.equal(used.enhancement, 3, `${scrollId} / ${kind} 固定随机双升`);
      assert.equal(used.numbers!.enhancementUses, requiresEnhanced ? 0 : 4, `${scrollId} / ${kind} 耐久`);
      assert.equal(bag.count(scrollId), scrollCount - 1, `${scrollId} / ${kind} 消耗卷轴`);
      assert.deepEqual(used.numbers!.enhancementRule, rule, `${scrollId} / ${kind} 规则查找`);
      assert.equal(used.numbers!.enhancementScroll, requiresEnhanced ? undefined : scrollId, `${scrollId} / ${kind} 卷轴来源`);
      combos++;
      kinds.add(kind);
      if (!realEnchantable) {
        clonedCatalogCombos++;
        clonedKinds.add(kind);
      }
    }
  }
  assert.equal(combos, 132, '6 张武器卷轴 × 9 类 + 6 张防具卷轴 × 13 类');
  assert.equal(kinds.size, 22, '9 种武器 + 13 种防具');
  assert.deepEqual([...clonedKinds].sort(), ['cloak', 'necklace', 'ring'],
    '披风、项链、戒指没有可强化的真实装备');
  assert.equal(clonedCatalogCombos, 18,
    '这 3 类 × 6 张防具卷轴用测试内临时打开 enchantable 的真实物品覆盖规则');
});

test('scroll category, max level, durability, cap and exhaustion rules reject before consuming', () => {
  const hero = heroAt('dark-knight', MAX_LEVEL);
  const bag = hero.bag;
  bag.add('basic-longsword');
  bag.add('robe');
  const weaponId = lastEntry(hero, 'basic-longsword').id;
  const armorId = lastEntry(hero, 'robe').id;

  for (const scrollId of SCROLL_IDS) {
    const use = items.items[scrollId]!.use!;
    const wrongTargetId = use.target === 'weapon' ? armorId : weaponId;
    const scrollInstance = ensureScroll(hero, scrollId);
    const scrollCount = bag.count(scrollId);
    const targetBefore = structuredClone(bag.get(wrongTargetId));
    assert.equal(bag.targetProblem(scrollInstance, wrongTargetId), '请选择可应用的装备', `${scrollId} 类别不匹配`);
    assert.throws(() => bag.use(scrollInstance, wrongTargetId), /请选择可应用的装备/, scrollId);
    assert.equal(bag.count(scrollId), scrollCount, `${scrollId} 类别不匹配不消耗卷轴`);
    assert.deepEqual(bag.get(wrongTargetId), targetBefore, `${scrollId} 类别不匹配不改目标`);

    if (use.maxLevel) {
      const wantsWeapon = use.target === 'weapon';
      const highItem = Object.keys(items.items).find(id => {
        const definition = items.items[id]!;
        const equipment = definition.equipment;
        if (!equipment?.enchantable || definition.level <= use.maxLevel!) return false;
        const weaponLike = definition.priceKind === 'weapon' || equipment.slot === 'main-hand';
        return weaponLike === wantsWeapon;
      });
      assert.ok(highItem, `${scrollId} 应该有超等级目标`);
      bag.add(highItem);
      const high = lastEntry(hero, highItem);
      const highScroll = ensureScroll(hero, scrollId);
      assert.equal(bag.targetProblem(highScroll, high.id), ITEM_NOTICE_TEXT['enchant-level'], `${scrollId} 等级限制`);
      const highCount = bag.count(scrollId);
      assert.throws(() => bag.use(highScroll, high.id), rejectsWithNotice('enchant-level'), scrollId);
      assert.equal(bag.count(scrollId), highCount, '等级不够时不消耗卷轴');
    }
  }

  for (const scrollId of SCROLL_IDS) {
    const requiresEnhanced = !!items.items[scrollId]!.use!.requiresEnhanced;
    const targetId = items.items[scrollId]!.use!.target === 'weapon' ? weaponId : armorId;
    patchInstance(hero, targetId, entry => {
      entry.enhancement = 10;
      entry.numbers!.enhancementUses = requiresEnhanced ? 1 : 0;
      entry.numbers!.enhancementScroll = undefined;
      entry.numbers!.enhancementRule = undefined;
    });
    const expected = requiresEnhanced ? 'enchant-chaos-durability' : 'enchant-durability';
    const scrollInstance = ensureScroll(hero, scrollId);
    assert.equal(bag.applicationProblem(scrollInstance, targetId), expected, scrollId);
    assert.throws(() => bag.use(scrollInstance, targetId), rejectsWithNotice(expected), scrollId);
    assert.equal(bag.get(targetId)!.enhancement, 10, '拒绝时装备不变');
  }

  for (const scrollId of SCROLL_IDS) {
    const requiresEnhanced = !!items.items[scrollId]!.use!.requiresEnhanced;
    const targetId = items.items[scrollId]!.use!.target === 'weapon' ? weaponId : armorId;
    patchInstance(hero, targetId, entry => {
      entry.enhancement = 30;
      entry.numbers!.enhancementUses = requiresEnhanced ? 0 : 5;
      entry.numbers!.enhancementScroll = undefined;
      entry.numbers!.enhancementRule = undefined;
    });
    const scrollInstance = ensureScroll(hero, scrollId);
    assert.equal(bag.applicationProblem(scrollInstance, targetId), 'enchant-max', scrollId);
    const count = bag.count(scrollId);
    assert.throws(() => bag.use(scrollInstance, targetId), rejectsWithNotice('enchant-max'), scrollId);
    assert.equal(bag.count(scrollId), count, '上限拒绝时不消耗卷轴');
    assert.equal(bag.get(targetId)!.enhancement, 30);
  }

  const exhaustHero = heroAt('priest', 1);
  exhaustHero.bag.add('robe');
  const exhaustTarget = lastEntry(exhaustHero, 'robe').id;
  patchInstance(exhaustHero, exhaustTarget, entry => { entry.enhancement = 0; entry.numbers!.enhancementUses = 2; });
  exhaustHero.bag.add('novice-armor-scroll');
  const onlyScroll = lastEntry(exhaustHero, 'novice-armor-scroll').id;
  exhaustHero.bag.use(onlyScroll, exhaustTarget, undefined, () => 0.999999);
  assert.throws(() => exhaustHero.bag.use(onlyScroll, exhaustTarget), /物品已不在背包中/);
});

test('a capped scroll accepts an item exactly at its max level', () => {
  const cases = [['standard-weapon-scroll', 'vengence'], ['advanced-armor-scroll', 'ancient-armor']] as const;
  for (const [scrollId, itemId] of cases) {
    const use = items.items[scrollId]!.use!;
    assert.equal(items.items[itemId]!.level, use.maxLevel, `${scrollId} / ${itemId}`);
    const hero = heroAt('dark-knight', 1);
    const bag = hero.bag;
    bag.add(itemId);
    const target = lastEntry(hero, itemId);
    patchInstance(hero, target.id, entry => {
      entry.enhancement = 1;
      entry.numbers!.enhancementUses = 3;
      entry.numbers!.enhancementScroll = undefined;
      entry.numbers!.enhancementRule = undefined;
    });
    assert.equal(bag.applicationProblem(ensureScroll(hero, scrollId), target.id), undefined, `${scrollId} / ${itemId}`);
  }
});

test('scrolls without maxLevel accept any item level', () => {
  const uncapped = SCROLL_IDS.filter(id => !items.items[id]!.use!.maxLevel);
  assert.equal(uncapped.length, 6);
  const highestTarget = (wantsWeapon: boolean): string => {
    const ids = Object.keys(items.items).filter(id => {
      const definition = items.items[id]!;
      const equipment = definition.equipment;
      if (!equipment?.enchantable) return false;
      return (definition.priceKind === 'weapon' || equipment.slot === 'main-hand') === wantsWeapon;
    });
    ids.sort((left, right) => items.items[right]!.level - items.items[left]!.level);
    assert.ok(ids.length, '应该有可强化目标');
    return ids[0]!;
  };
  const weaponTarget = highestTarget(true);
  const armorTarget = highestTarget(false);
  assert.ok(items.items[weaponTarget]!.level > 99);
  assert.ok(items.items[armorTarget]!.level > 99);
  for (const scrollId of uncapped) {
    const use = items.items[scrollId]!.use!;
    const hero = heroAt('dark-knight', 1);
    const bag = hero.bag;
    const targetItem = use.target === 'weapon' ? weaponTarget : armorTarget;
    bag.add(targetItem);
    const targetId = lastEntry(hero, targetItem).id;
    patchInstance(hero, targetId, entry => {
      entry.enhancement = 10;
      entry.numbers!.enhancementUses = use.requiresEnhanced ? 0 : 5;
      entry.numbers!.enhancementScroll = undefined;
      entry.numbers!.enhancementRule = undefined;
    });
    const source = ensureScroll(hero, scrollId);
    assert.equal(bag.canApply(source, targetId), true, `${scrollId} / ${targetItem}`);
    assert.equal(bag.applicationProblem(source, targetId), undefined, `${scrollId} / ${targetItem}`);
  }
});

test('a scroll writes its rule once and later applications must match it', () => {
  const hero = heroAt('dark-knight', 1);
  const bag = hero.bag;
  bag.add('basic-longsword');
  const targetId = lastEntry(hero, 'basic-longsword').id;
  patchInstance(hero, targetId, entry => {
    entry.enhancement = 1;
    entry.numbers!.enhancementUses = 5;
    entry.numbers!.enhancementScroll = undefined;
    entry.numbers!.enhancementRule = undefined;
  });

  bag.use(ensureScroll(hero, 'supreme-weapon-scroll'), targetId, undefined, () => 0.999999);
  let target = bag.get(targetId)!;
  const supremeRule = catalog.enchantments['supreme-weapon-scroll']!['longsword']!;
  assert.deepEqual(target.numbers!.enhancementRule, supremeRule);
  assert.equal(target.numbers!.enhancementScroll, 'supreme-weapon-scroll');
  assert.equal(target.enhancement, 2);
  assert.equal(target.numbers!.enhancementUses, 4);

  assert.equal(bag.targetProblem(ensureScroll(hero, 'sp-weapon-enhance-scroll'), targetId), undefined, '顶级与特级可互换');
  bag.use(ensureScroll(hero, 'sp-weapon-enhance-scroll'), targetId, undefined, () => 0.999999);
  target = bag.get(targetId)!;
  assert.deepEqual(target.numbers!.enhancementRule, supremeRule, '后续卷轴不覆盖第一次写入的规则');
  assert.equal(target.numbers!.enhancementScroll, 'supreme-weapon-scroll');
  assert.equal(target.enhancement, 3);
  assert.equal(target.numbers!.enhancementUses, 3);

  const noviceId = ensureScroll(hero, 'novice-weapon-scroll');
  assert.equal(bag.targetProblem(noviceId, targetId), ITEM_NOTICE_TEXT['enchant-rule'], '不同档卷轴不能混用');
  const count = bag.count('novice-weapon-scroll');
  assert.throws(() => bag.use(noviceId, targetId), rejectsWithNotice('enchant-rule'));
  assert.equal(bag.count('novice-weapon-scroll'), count, '拒绝时不消耗卷轴');

  patchInstance(hero, targetId, entry => { entry.numbers!.enhancementRule = { ...supremeRule, step: 99 }; });
  const spId = ensureScroll(hero, 'sp-weapon-enhance-scroll');
  assert.equal(bag.targetProblem(spId, targetId), ITEM_NOTICE_TEXT['enchant-rule'], '规则字段不一致');
  assert.throws(() => bag.use(spId, targetId), rejectsWithNotice('enchant-rule'));

  patchInstance(hero, targetId, entry => { entry.numbers!.enhancementRule = { ...supremeRule }; });
  bag.use(ensureScroll(hero, 'supreme-weapon-scroll'), targetId, undefined, () => 0.999999);
  assert.equal(bag.get(targetId)!.enhancement, 4, '同一张卷轴可以继续强化');
});

test('every equipment attribute maps to at most one non-panel bonus field exactly once', () => {
  const aggregateExpectation = (normal: readonly Modifier[], gems: readonly Modifier[]) => {
    const attack = { fireSplashChance: 0, windStrikeChance: 0, frostStrikeChance: 0, divineStrikeChance: 0, darknessStrikeChance: 0, poisonStrikeChance: 0 };
    const combat = { pendulumStunChance: 0, frostRetaliationChance: 0, healingEnergyChance: 0, zealotRate: 0, instantRecoveryPerThousand: 0 };
    for (const stat of ATTRIBUTE_IDS) {
      const attackField = ATTACK_PROC_FIELDS[stat];
      if (attackField) attack[attackField as keyof typeof attack] += [...normal, ...gems]
        .filter(modifier => modifier.stat === stat).reduce((sum, modifier) => sum + modifier.value, 0);
      const combatField = COMBAT_PROC_FIELDS[stat];
      if (combatField) combat[combatField as keyof typeof combat] += [...normal, ...gems]
        .filter(modifier => modifier.stat === stat).reduce((sum, modifier) => sum + modifier.value, 0);
    }
    const recovery = {
      lifeDrainPerThousand: Math.max(0, sumMapped('lifeDrainPerThousand', normal, gems, RECOVERY_FIELDS)),
      manaRecoveryPerPulse: sumMapped('manaRecoveryPerPulse', normal, gems, RECOVERY_FIELDS),
      manaCostReductionRate: Math.max(0, sumMapped('manaCostReductionRate', normal, gems, RECOVERY_FIELDS)),
    };
    const threat = sumMapped('aggroReduction', normal, gems, { aggroReduction: 'aggroReduction' });
    const immunity = new Map<BattleStateKey, number>();
    for (const state of BATTLE_STATE_KEYS) {
      const stat = IMMUNITY_FIELDS[state];
      immunity.set(state, stat
        ? [...normal, ...gems].filter(modifier => modifier.stat === stat).reduce((sum, modifier) => sum + modifier.value, 0)
        : 0);
    }
    return { attack, combat, recovery, threat, immunity };
  };

  EQUIPMENT_IDS.forEach((id, itemIndex) => {
    // 每件装备用自己的数值偏移，避免同一组输入和同一份期望重复 662 次。
    const normal = ATTRIBUTE_IDS.map((stat, index) => ({ stat, value: 1 + itemIndex * 37 + index }));
    const gems = ATTRIBUTE_IDS.map((stat, index) => ({ stat, value: 1000 + itemIndex * 53 + index }));
    normal.push(...UNKNOWN_STATS.map((stat, index) => ({ stat, value: 1_000_000 + itemIndex * 10 + index })));
    gems.push(...UNKNOWN_STATS.map((stat, index) => ({ stat, value: 2_000_000 + itemIndex * 10 + index })));
    const expected = aggregateExpectation(normal, gems);
    const entry = instanceWith(`probe-${id}`, normal, gems, id);
    const before = structuredClone(entry);
    assert.deepEqual(equipmentAttackProcs([entry]), expected.attack, `${id} 的攻击触发`);
    assert.deepEqual(equipmentCombatProcs([entry]), expected.combat, `${id} 的战斗触发`);
    assert.deepEqual(equipmentRecoveryModifiers([entry]), expected.recovery, `${id} 的恢复词条`);
    assert.equal(equipmentThreatReduction([entry]), expected.threat, `${id} 的减敌意`);
    for (const state of BATTLE_STATE_KEYS) {
      assert.equal(equipmentStateImmunity([entry], state), expected.immunity.get(state), `${id} / ${state}`);
    }
    assert.deepEqual(entry, before, `${id} 的输入实例不应被修改`);
  });

  const bothSources = instanceWith('both-sources',
    [{ stat: 'fire', value: 2 }, { stat: 'lifeSteal', value: 4 }],
    [{ stat: 'fire', value: 3 }, { stat: 'lifeSteal', value: 1 }]);
  assert.equal(equipmentAttackProcs([bothSources]).fireSplashChance, 5, '普通词条和宝石词条的同一属性各累加一次');
  assert.equal(equipmentRecoveryModifiers([bothSources]).lifeDrainPerThousand, 5);
  const duplicated = instanceWith('duplicated',
    [{ stat: 'fire', value: 2 }, { stat: 'fire', value: 3 }],
    [{ stat: 'fire', value: 4 }]);
  assert.equal(equipmentAttackProcs([duplicated]).fireSplashChance, 9, '同属性出现多次时每次都累加');
});

test('bonus aggregators clamp recovery, keep signed triggers, ignore unknown attributes and empty input', () => {
  const empty = instanceWith('empty', [], []);
  const bare: ItemInstance = { id: 'bare', item: 'probe', quantity: 1, enhancement: 0, gems: [] };
  for (const entry of [empty, bare]) {
    assert.deepEqual(equipmentAttackProcs([entry]), { fireSplashChance: 0, windStrikeChance: 0, frostStrikeChance: 0, divineStrikeChance: 0, darknessStrikeChance: 0, poisonStrikeChance: 0 });
    assert.deepEqual(equipmentCombatProcs([entry]), { pendulumStunChance: 0, frostRetaliationChance: 0, healingEnergyChance: 0, zealotRate: 0, instantRecoveryPerThousand: 0 });
    assert.deepEqual(equipmentRecoveryModifiers([entry]), { lifeDrainPerThousand: 0, manaRecoveryPerPulse: 0, manaCostReductionRate: 0 });
    assert.equal(equipmentThreatReduction([entry]), 0);
    for (const state of BATTLE_STATE_KEYS) assert.equal(equipmentStateImmunity([entry], state), 0);
  }

  const unknown = instanceWith('unknown', UNKNOWN_STATS.map(stat => ({ stat, value: 50 })), UNKNOWN_STATS.map(stat => ({ stat, value: -20 })));
  assert.deepEqual(equipmentAttackProcs([unknown]), { fireSplashChance: 0, windStrikeChance: 0, frostStrikeChance: 0, divineStrikeChance: 0, darknessStrikeChance: 0, poisonStrikeChance: 0 });
  assert.deepEqual(equipmentCombatProcs([unknown]), { pendulumStunChance: 0, frostRetaliationChance: 0, healingEnergyChance: 0, zealotRate: 0, instantRecoveryPerThousand: 0 });
  assert.deepEqual(equipmentRecoveryModifiers([unknown]), { lifeDrainPerThousand: 0, manaRecoveryPerPulse: 0, manaCostReductionRate: 0 });
  assert.equal(equipmentThreatReduction([unknown]), 0);
  for (const state of BATTLE_STATE_KEYS) assert.equal(equipmentStateImmunity([unknown], state), 0);

  const negative = instanceWith('negative',
    [{ stat: 'lifeSteal', value: -30 }, { stat: 'manaRegen', value: -4 }, { stat: 'spellExpert', value: -20 },
      { stat: 'aggroReduction', value: -15 }, { stat: 'fire', value: -7 }, { stat: 'pendulum', value: -3 },
      { stat: 'sleepResistance', value: -2 }, { stat: 'stunResistance', value: -9 }],
    [{ stat: 'lifeSteal', value: -5 }, { stat: 'spellExpert', value: -1 }, { stat: 'manaRegen', value: -2 }]);
  assert.deepEqual(equipmentRecoveryModifiers([negative]), { lifeDrainPerThousand: 0, manaRecoveryPerPulse: -6, manaCostReductionRate: 0 });
  assert.equal(equipmentThreatReduction([negative]), -15);
  assert.equal(equipmentAttackProcs([negative]).fireSplashChance, -7);
  assert.equal(equipmentCombatProcs([negative]).pendulumStunChance, -3);
  assert.equal(equipmentStateImmunity([negative], 'sleep'), -2);
  assert.equal(equipmentStateImmunity([negative], 'stun'), -9);
});

test('multiple gems on one item and multiple items with the same trigger all stack once', () => {
  const hero = heroAt('dark-knight', 1);
  const bag = hero.bag;
  const weaponId = bag.equipment['main-hand']!;
  patchInstance(hero, weaponId, entry => { entry.numbers!.sockets = 4; entry.numbers!.gemModifiers = []; entry.gems = []; });
  const socketed = GEM_IDS.slice(0, 4);
  const modifiers: Modifier[] = [];
  for (const gemId of socketed) {
    bag.add(gemId);
    const gem = lastEntry(hero, gemId);
    modifiers.push(structuredClone(gem.numbers!.modifiers[0]!));
    bag.use(gem.id, weaponId);
  }
  const target = bag.get(weaponId)!;
  assert.deepEqual(target.gems, socketed);
  assert.deepEqual(target.numbers!.gemModifiers, modifiers);
  assert.equal(target.numbers!.gemModifiers.length, 4);
  const collected = [...target.numbers!.modifiers, ...target.numbers!.gemModifiers];
  const expectedAttack = { fireSplashChance: 0, windStrikeChance: 0, frostStrikeChance: 0, divineStrikeChance: 0, darknessStrikeChance: 0, poisonStrikeChance: 0 };
  const expectedCombat = { pendulumStunChance: 0, frostRetaliationChance: 0, healingEnergyChance: 0, zealotRate: 0, instantRecoveryPerThousand: 0 };
  for (const modifier of collected) {
    const attackField = ATTACK_PROC_FIELDS[modifier.stat];
    if (attackField) expectedAttack[attackField as keyof typeof expectedAttack] += modifier.value;
    const combatField = COMBAT_PROC_FIELDS[modifier.stat];
    if (combatField) expectedCombat[combatField as keyof typeof expectedCombat] += modifier.value;
  }
  assert.deepEqual(equipmentAttackProcs([target]), expectedAttack);
  assert.deepEqual(equipmentCombatProcs([target]), expectedCombat);
  assert.deepEqual(equipmentRecoveryModifiers([target]), {
    lifeDrainPerThousand: Math.max(0, sumMapped('lifeDrainPerThousand', collected, [], RECOVERY_FIELDS)),
    manaRecoveryPerPulse: sumMapped('manaRecoveryPerPulse', collected, [], RECOVERY_FIELDS),
    manaCostReductionRate: Math.max(0, sumMapped('manaCostReductionRate', collected, [], RECOVERY_FIELDS)),
  });
  assert.equal(equipmentThreatReduction([target]), sumMapped('aggroReduction', collected, [], { aggroReduction: 'aggroReduction' }));
  for (const state of BATTLE_STATE_KEYS) {
    const stat = IMMUNITY_FIELDS[state];
    const expected = stat ? collected.filter(modifier => modifier.stat === stat).reduce((sum, modifier) => sum + modifier.value, 0) : 0;
    assert.equal(equipmentStateImmunity([target], state), expected, `${socketed.join(',')} / ${state}`);
  }

  bag.add(GEM_IDS[4]!);
  const fifth = lastEntry(hero, GEM_IDS[4]!);
  assert.equal(bag.targetProblem(fifth.id, weaponId), ITEM_NOTICE_TEXT['socket-full'], '四个孔满了');
  assert.throws(() => bag.use(fifth.id, weaponId), rejectsWithNotice('socket-full'));
  assert.equal(bag.count(GEM_IDS[4]!), 1, '满孔失败不消耗宝石');

  const gemsBeforeRemoval = [...target.gems];
  const modifiersBeforeRemoval = target.numbers!.gemModifiers.map(modifier => ({ ...modifier }));
  const removed = bag.unsocket(weaponId, 2);
  const afterRemoval = bag.get(weaponId)!;
  assert.deepEqual(afterRemoval.gems, [...gemsBeforeRemoval.slice(0, 2), ...gemsBeforeRemoval.slice(3)]);
  assert.deepEqual(afterRemoval.numbers!.gemModifiers, [...modifiersBeforeRemoval.slice(0, 2), ...modifiersBeforeRemoval.slice(3)]);
  const removedGem = bag.get(removed.gemId)!;
  assert.equal(removedGem.item, gemsBeforeRemoval[2]);
  assert.deepEqual(removedGem.numbers!.modifiers, [modifiersBeforeRemoval[2]]);

  const source = lastEntry(hero, GEM_IDS[4]!);
  const sourceModifier = structuredClone(source.numbers!.modifiers[0]!);
  const swapped = bag.swapGem(weaponId, 1, source.id);
  const afterSwap = bag.get(weaponId)!;
  assert.deepEqual(afterSwap.gems, [gemsBeforeRemoval[0], GEM_IDS[4], gemsBeforeRemoval[3]]);
  assert.deepEqual(afterSwap.numbers!.gemModifiers, [
    modifiersBeforeRemoval[0], sourceModifier, modifiersBeforeRemoval[3],
  ]);
  const oldGem = bag.get(swapped.removedId)!;
  assert.equal(oldGem.item, gemsBeforeRemoval[1]);
  assert.deepEqual(oldGem.numbers!.modifiers, [modifiersBeforeRemoval[1]]);

  const stacked = [
    instanceWith('a', [{ stat: 'fire', value: 10 }, { stat: 'lifeSteal', value: 4 }, { stat: 'aggroReduction', value: -5 }, { stat: 'sleepResistance', value: 2 }],
      [{ stat: 'fire', value: 1 }]),
    instanceWith('b', [{ stat: 'fire', value: 15 }, { stat: 'wind', value: 2 }, { stat: 'aggroReduction', value: 3 }],
      [{ stat: 'lifeSteal', value: 6 }]),
    instanceWith('c', [{ stat: 'fire', value: -4 }, { stat: 'sleepResistance', value: 4 }, { stat: 'stunResistance', value: -1 }],
      [{ stat: 'pendulum', value: 8 }]),
  ];
  assert.equal(equipmentAttackProcs(stacked).fireSplashChance, 22);
  assert.equal(equipmentAttackProcs(stacked).windStrikeChance, 2);
  assert.equal(equipmentCombatProcs(stacked).pendulumStunChance, 8);
  assert.equal(equipmentRecoveryModifiers(stacked).lifeDrainPerThousand, 10);
  assert.equal(equipmentThreatReduction(stacked), -2);
  assert.equal(equipmentStateImmunity(stacked, 'sleep'), 6);
  assert.equal(equipmentStateImmunity(stacked, 'stun'), -1);
});

test('a +29 double success must not push enhancement above the +30 cap', () => {
  const hero = heroAt('dark-knight', 1);
  const bag = hero.bag;
  bag.add('basic-longsword');
  const targetId = lastEntry(hero, 'basic-longsword').id;
  patchInstance(hero, targetId, entry => { entry.enhancement = 29; entry.numbers!.enhancementUses = 5; });
  bag.use(ensureScroll(hero, 'novice-weapon-scroll'), targetId, undefined, () => 0);
  assert.equal(bag.get(targetId)!.enhancement, 30, '+29 二段大成功后等级不得超过 +30');
});
