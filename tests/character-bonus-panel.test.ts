import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BattleCharacter, DEFAULT_EQUIPMENT_GRADE, PRIMARY_STATS, calculateCharacter, enhancementBonus,
  equipmentPower, previewGemPanel, rollEquipmentNumbers,
  type CharacterPanel, type CharacterStatsCatalog, type EquipmentNumbers, type ItemNumbers,
  type Modifier, type ModifierRange, type PrimaryAttributes, type PrimaryStat,
} from '../src/domain/character-stats.ts';
import { AttributeAllocation } from '../src/domain/attribute-allocation.ts';
import type { EquipmentSlot, ItemCatalog, ItemDefinition, ItemInstance } from '../src/domain/items.ts';
import { parseCharacterStats, parseItemCatalog } from '../src/application/content-validation.ts';

/*
 * 这组测试从内容定义和公式说明（`character-stats.ts` 顶部的常量注释）独立算期望值，
 * 不调用被测函数生成期望值。测试只读本仓库的 `src/` 与 `public/content/`。
 */

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const catalog = parseCharacterStats(read('character-stats'));
const items = parseItemCatalog(read('items'));

const ZERO = (): PrimaryAttributes => ({ strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 });
const ZERO_CLASS = 'zero-attribute-fixture';
const ZERO_STATS: CharacterStatsCatalog = {
  ...catalog,
  classes: { ...catalog.classes, [ZERO_CLASS]: ZERO() },
};
const EQUIPMENT_IDS = Object.keys(catalog.equipment);
const CLASS_IDS = Object.keys(catalog.classes).filter(id => id !== ZERO_CLASS);

type Loadout = Partial<Record<EquipmentSlot, ItemInstance>>;

function itemDefinitionOfKind(kind: string): ItemDefinition {
  const definition = Object.values(items.items).find(item => item.kind === kind && item.equipment);
  assert.ok(definition, `content defines a ${kind} item`);
  return definition;
}

type FixtureItemDefinition = ItemDefinition & { id: string };

function fixtureItem(id: string, kind: string, slot: EquipmentSlot): FixtureItemDefinition {
  const base = itemDefinitionOfKind(kind);
  return { ...base, id, kind, equipment: { ...base.equipment!, slot } };
}

function fixtureStats(attributes: PrimaryAttributes, definitions: Record<string, EquipmentNumbers>): CharacterStatsCatalog {
  return {
    ...catalog,
    classes: { ...catalog.classes, 'fixture-hero': attributes },
    equipment: { ...catalog.equipment, ...definitions },
  };
}

function makeFixtureItems(definitions: FixtureItemDefinition[]): ItemCatalog {
  const map = { ...items.items };
  for (const definition of definitions) map[definition.id] = definition;
  return { ...items, items: map };
}

function zeroEquipmentNumbers(overrides: Partial<EquipmentNumbers> = {}): EquipmentNumbers {
  return {
    attack: 0, defense: 0, gradeName: '', magicPercent: [0, 0], criticalRate: 0, hitBonus: 0,
    magicAttackRate: 0, shieldBlock: 0, fixedOptions: [], randomOptions: [], optionCount: 0,
    socketLimit: 0, enhancementUses: [1, 1], fixedEnhancementUses: null,
    ...overrides,
  };
}

function instance(item: string, numbers: Partial<ItemNumbers> = {}, enhancement = 0): ItemInstance {
  return {
    id: `test-${item}`, item, quantity: 1, enhancement, gems: [],
    numbers: { modifiers: [], gemModifiers: [], magicPercent: 0, sockets: 0, enhancementUses: 0, ...numbers },
  };
}

const zeroModifier = (stat: string, value: number): Modifier => ({ stat, value });

/**
 * 期望值公式（千分比）：
 * - 命中显示 = trunc((命中基础×1000 + 20000)/(命中基础 + 等级 + 35)) + max(0,命中加成) + 100
 * - 回避显示 = min(750, 1000 + 回避加成 − trunc((5000×等级 + 1000000)/(5×等级 + 敏捷 + 1200)))
 * - 物减 = trunc(1000×有效防御/(有效防御 + 20×(等级 + 3)))
 * - 有效防御 = trunc(max(0,原始防御)×(1000 + max(0,防御率))/1000)
 */
function expectedEnhancementBonus(entry: ItemInstance): number {
  const rule = entry.numbers?.enhancementRule;
  if (!rule) return 0;
  const extraLevels = Math.max(0, entry.enhancement - rule.threshold + 1);
  return entry.enhancement * rule.step + extraLevels * rule.extra;
}

function expectedPower(definition: EquipmentNumbers, entry: ItemInstance) {
  const bonus = expectedEnhancementBonus(entry);
  const baseAttack = entry.numbers?.baseAttack ?? definition.attack;
  const baseDefense = entry.numbers?.baseDefense ?? definition.defense;
  const rate = entry.numbers?.chaos?.valuePercent ?? 100;
  const attack = baseAttack === 0 ? 0
    : entry.numbers?.chaos
      ? Math.max(1, Math.trunc((baseAttack + bonus) * rate / 100))
      : baseAttack + bonus;
  const defense = baseDefense === 0 ? 0 : Math.trunc((baseDefense + bonus) * rate / 100);
  const magicAttack = Math.trunc(attack * (entry.numbers?.magicPercent ?? 0) / 100);
  return { attack, magicAttack, defense };
}

function expectedPanel(
  stats: CharacterStatsCatalog, itemCatalog: ItemCatalog, classId: string, level: number,
  allocated: PrimaryAttributes, equipped: Loadout,
): CharacterPanel {
  const attributes: PrimaryAttributes = { ...stats.classes[classId] };
  for (const stat of PRIMARY_STATS) attributes[stat] += allocated[stat];

  const tally = new Map<string, number>();
  const add = (stat: string, value: number) => tally.set(stat, (tally.get(stat) ?? 0) + value);
  const bonus = (stat: string) => tally.get(stat) ?? 0;
  let weaponAttack = 0, weaponMagic = 0, gearDefense = 0;

  for (const [slot, entry] of Object.entries(equipped) as [EquipmentSlot, ItemInstance | undefined][]) {
    if (!entry) continue;
    const definition = stats.equipment[entry.item];
    const power = expectedPower(definition, entry);
    if (slot === 'main-hand') { weaponAttack += power.attack; weaponMagic += power.magicAttack; }
    gearDefense += power.defense;
    add('criticalRate', definition.criticalRate);
    add('hitBonus', definition.hitBonus);
    add('magicAttackRate', definition.magicAttackRate);
    add('shieldBlock', definition.shieldBlock);
    for (const modifier of [...(entry.numbers?.modifiers ?? []), ...(entry.numbers?.gemModifiers ?? [])]) {
      if ((PRIMARY_STATS as readonly string[]).includes(modifier.stat)) {
        attributes[modifier.stat as PrimaryStat] += modifier.value;
      } else {
        add(modifier.stat, modifier.value);
      }
    }
  }

  const main = equipped['main-hand'];
  const kind = main ? itemCatalog.items[main.item].kind : 'unarmed';
  const strengthRate = kind === 'two-handed' ? 700 : ['longsword', 'axe', 'mace'].includes(kind) ? 600 : 500;
  const intelligenceRate = kind === 'unarmed' ? 0 : kind === 'staff' ? 600 : kind === 'orb' ? 700 : 1000;
  const mentalityRate = kind === 'unarmed' ? 0 : ['staff', 'orb'].includes(kind) ? 600 : 1000;

  const physicalAttack = Math.max(0, Math.trunc(
    (weaponAttack + Math.trunc(attributes.strength * strengthRate / 1000) + Math.trunc(attributes.dexterity / 2))
    * (1000 + bonus('physicalAttackRate')) / 1000));
  const magicAttack = Math.max(0, Math.trunc(
    (weaponMagic + Math.trunc(attributes.intelligence * intelligenceRate / 1000) + Math.trunc(attributes.mentality * mentalityRate / 1000))
    * (1000 + bonus('magicAttackRate')) / 1000));

  const baseDefense = gearDefense + attributes.vitality;
  const defenseRate = bonus('defenseRate');
  const defense = Math.trunc(Math.max(0, baseDefense) * (1000 + Math.max(0, defenseRate)) / 1000);
  const hitBase = 4 * (attributes.dexterity + attributes.mentality);
  const hitBonus = Math.max(0, bonus('hitBonus'));
  const evasionBonus = Math.max(0, Math.min(750, bonus('evasionBonus')));
  const offhand = equipped['off-hand'];
  const offhandShield = !!offhand && itemCatalog.items[offhand.item]?.kind === 'shield';

  return {
    attributes,
    maxHealth: 640 + 72 * level + 80 * attributes.vitality,
    maxMana: 200 + bonus('maxMana'),
    physicalAttack,
    magicAttack,
    criticalRate: Math.max(0, 30 + bonus('criticalRate')),
    hitRate: Math.trunc((hitBase * 1000 + 20000) / (hitBase + level + 35)) + hitBonus + 100,
    baseDefense,
    baseMagicResistance: bonus('magicResistance'),
    criticalDamage: Math.max(0, 1000 + bonus('criticalDamage')),
    defense,
    defenseRate,
    physicalResistance: Math.trunc(1000 * defense / (defense + 20 * (level + 3))),
    magicResistance: Math.min(750, bonus('magicResistance')),
    evasionRate: Math.min(750, 1000 + evasionBonus
      - Math.trunc((5000 * level + 1000000) / (5 * level + attributes.dexterity + 1200))),
    weaponBlock: Math.max(0, 30 + bonus('weaponBlock')),
    shieldBlock: offhandShield ? Math.max(0, bonus('shieldBlock')) : 0,
    offhandShield,
    hitBase,
    hitBonus,
    evasionBase: attributes.dexterity,
    evasionBonus,
    criticalResistance: Math.max(0, bonus('criticalResistance')),
    criticalDamageResistance: Math.max(0, bonus('criticalDamageResistance')),
  };
}

function expectedLoadout(hero: BattleCharacter): Loadout {
  const loadout: Loadout = {};
  for (const [slot, id] of Object.entries(hero.bag.equipment)) {
    if (id) loadout[slot as EquipmentSlot] = hero.bag.get(id);
  }
  return loadout;
}

function setHeroState(hero: BattleCharacter, level: number, allocation: PrimaryAttributes = ZERO()): void {
  hero.restoreState({
    level, allocation: { ...allocation }, health: 0, mana: 0, resourceLimits: null,
    experience: 0, bonusSkillPoints: 0, spentSkillPoints: 0,
  });
}

function zeroHero(level = 1): BattleCharacter {
  const hero = new BattleCharacter(ZERO_CLASS, ZERO_STATS, items);
  setHeroState(hero, level);
  return hero;
}

function setBagEntry(hero: BattleCharacter, id: string, change: (entry: ItemInstance) => void): void {
  const state = hero.bag.captureState();
  change(state.instances.find(entry => entry.id === id)!);
  hero.bag.restoreState(state);
}

function generatedNumbers(definition: EquipmentNumbers, end: 'min' | 'max'): ItemNumbers {
  const pool = [...definition.randomOptions];
  const selected: ModifierRange[] = [];
  for (let index = 0; index < definition.optionCount && pool.length; index += 1) {
    selected.push(end === 'min' ? pool.shift()! : pool.pop()!);
  }
  return {
    grade: definition.defaultGrade ?? DEFAULT_EQUIPMENT_GRADE,
    gradeName: definition.gradeName,
    magicPercent: end === 'min' ? definition.magicPercent[0] : definition.magicPercent[1],
    enhancementUses: definition.fixedEnhancementUses
      ?? (end === 'min' ? definition.enhancementUses[0] * 2 + 1 : definition.enhancementUses[1] * 2 + 1),
    modifiers: [...definition.fixedOptions, ...selected].map(range => ({
      stat: range.stat, value: end === 'min' ? range.min : range.max,
    })),
    gemModifiers: [], sockets: 0,
  };
}

/* ------------------------------------------------------------------ */
/* calculateCharacter：职业基础、等级与武器系数                        */
/* ------------------------------------------------------------------ */

test('six classes expose the documented base attributes and the native level-1 unarmed panel', () => {
  const expected: Record<string, [number, number, number, number, number]> = {
    'dark-knight': [13, 9, 12, 9, 5],
    assassin: [9, 15, 11, 7, 5],
    warlock: [5, 7, 9, 15, 11],
    priest: [11, 7, 9, 9, 15],
    ranger: [7, 15, 10, 5, 11],
    warrior: [13, 11, 12, 5, 6],
  };
  assert.deepEqual(CLASS_IDS.sort(), Object.keys(expected).sort());
  for (const [classId, values] of Object.entries(expected)) {
    const panel = calculateCharacter(catalog, items, classId, 1, ZERO(), {});
    assert.deepEqual(PRIMARY_STATS.map(stat => panel.attributes[stat]), values, classId);
    assert.deepEqual(panel, expectedPanel(catalog, items, classId, 1, ZERO(), {}), classId);
    assert.equal(panel.maxHealth, 640 + 72 + 80 * values[2], classId);
    assert.equal(panel.maxMana, 200, classId);
    assert.equal(panel.hitBase, 4 * (values[1] + values[4]), classId);
    assert.equal(panel.evasionBase, values[1], classId);
    assert.equal(panel.defense, values[2], classId);
    assert.equal(panel.magicAttack, 0, 'unarmed intelligence and mentality do not feed magic attack');
    assert.equal(panel.weaponBlock, 30, classId);
    assert.equal(panel.shieldBlock, 0, classId);
    assert.equal(panel.offhandShield, false, classId);
  }
});

test('levels 0..105 scale health by 72 and keep the documented hit, evasion and defense rows', () => {
  for (const classId of CLASS_IDS) {
    for (let level = 0; level <= catalog.maxLevel; level += 1) {
      const panel = calculateCharacter(catalog, items, classId, level, ZERO(), {});
      assert.deepEqual(panel, expectedPanel(catalog, items, classId, level, ZERO(), {}), `${classId}@${level}`);
      assert.equal(panel.maxHealth, 640 + 72 * level + 80 * panel.attributes.vitality, `${classId}@${level}`);
      assert.equal(panel.maxMana, 200, `${classId}@${level}: levels do not change base mana`);
    }
  }
});

test('weapon kind selects strength 700/600/500 and staff/orb intelligence-mentality casting rates', () => {
  const kinds = ['dagger', 'longsword', 'axe', 'mace', 'two-handed', 'orb', 'staff', 'bow', 'crossbow'];
  const definitions: Record<string, EquipmentNumbers> = {};
  const itemDefinitions: FixtureItemDefinition[] = [];
  for (const kind of kinds) {
    const id = `rate-fixture-${kind}`;
    definitions[id] = zeroEquipmentNumbers({ attack: 100, magicPercent: [100, 100] });
    itemDefinitions.push(fixtureItem(id, kind, 'main-hand'));
  }
  const fixture = fixtureStats({ strength: 10, dexterity: 7, vitality: 3, intelligence: 10, mentality: 10 }, definitions);
  const fixtureItems = makeFixtureItems(itemDefinitions);
  const rates: Record<string, [number, number, number]> = {
    'two-handed': [700, 1000, 1000],
    longsword: [600, 1000, 1000],
    axe: [600, 1000, 1000],
    mace: [600, 1000, 1000],
    dagger: [500, 1000, 1000],
    bow: [500, 1000, 1000],
    crossbow: [500, 1000, 1000],
    staff: [500, 600, 600],
    orb: [500, 700, 600],
  };
  for (const kind of kinds) {
    const [strengthRate, intelligenceRate, mentalityRate] = rates[kind];
    const entry = instance(`rate-fixture-${kind}`, { magicPercent: 100 });
    const panel = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { 'main-hand': entry });
    assert.deepEqual(panel, expectedPanel(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { 'main-hand': entry }), kind);
    assert.equal(panel.physicalAttack, 100 + Math.trunc(10 * strengthRate / 1000) + Math.trunc(7 / 2), kind);
    assert.equal(panel.magicAttack, 100 + Math.trunc(10 * intelligenceRate / 1000) + Math.trunc(10 * mentalityRate / 1000), kind);
  }

  const unarmed = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), {});
  assert.deepEqual(unarmed, expectedPanel(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), {}));
  assert.equal(unarmed.physicalAttack, Math.trunc(10 * 500 / 1000) + Math.trunc(7 / 2));
  assert.equal(unarmed.magicAttack, 0, 'empty hands zero both casting rates');
});

test('attack rate modifiers multiply the summed attack rows once and truncate per row', () => {
  const definitions: Record<string, EquipmentNumbers> = {
    'rate-weapon': zeroEquipmentNumbers({ attack: 100, magicPercent: [100, 100] }),
    'rate-ring': zeroEquipmentNumbers({}),
  };
  const fixture = fixtureStats({ strength: 10, dexterity: 7, vitality: 0, intelligence: 10, mentality: 10 }, definitions);
  const fixtureItems = makeFixtureItems([
    fixtureItem('rate-weapon', 'longsword', 'main-hand'),
    fixtureItem('rate-ring', 'ring', 'ring'),
  ]);
  const ring = instance('rate-ring', {
    modifiers: [zeroModifier('physicalAttackRate', 500), zeroModifier('magicAttackRate', 250)],
  });
  const panel = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { 'main-hand': instance('rate-weapon', { magicPercent: 100 }), ring });
  const basePhysical = 100 + Math.trunc(10 * 600 / 1000) + Math.trunc(7 / 2);
  const baseMagic = 100 + 10 + 10;
  assert.equal(panel.physicalAttack, Math.trunc(basePhysical * 1500 / 1000));
  assert.equal(panel.magicAttack, Math.trunc(baseMagic * 1250 / 1000));
  assert.deepEqual(panel, expectedPanel(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), {
    'main-hand': instance('rate-weapon', { magicPercent: 100 }), ring,
  }));

  const zero = calculateCharacter(ZERO_STATS, items, ZERO_CLASS, 1, { ...ZERO(), strength: 1 }, {});
  const two = calculateCharacter(ZERO_STATS, items, ZERO_CLASS, 1, { ...ZERO(), strength: 2 }, {});
  assert.equal(zero.physicalAttack, 0, 'trunc(1 × 500 / 1000) = 0');
  assert.equal(two.physicalAttack, 1, 'trunc(2 × 500 / 1000) = 1');
});

/* ------------------------------------------------------------------ */
/* calculateCharacter：命中、回避、暴击、防御、抗性与格挡              */
/* ------------------------------------------------------------------ */

test('hit and evasion rows use hit base, level and the documented clamped bonuses', () => {
  const ringId = 'hit-evasion-ring';
  const fixture = fixtureStats(ZERO(), { [ringId]: zeroEquipmentNumbers({}) });
  const ringItems = makeFixtureItems([fixtureItem(ringId, 'ring', 'ring')]);
  const ring = instance(ringId, {
    modifiers: [
      zeroModifier('dexterity', 20), zeroModifier('mentality', 10),
      zeroModifier('hitBonus', 30), zeroModifier('evasionBonus', 100),
    ],
  });
  const panel = calculateCharacter(fixture, ringItems, 'fixture-hero', 30, ZERO(), { ring });
  assert.equal(panel.hitBase, 120);
  assert.equal(panel.hitRate, Math.trunc((120 * 1000 + 20000) / (120 + 30 + 35)) + 30 + 100);
  assert.equal(panel.evasionBase, 20);
  assert.equal(panel.evasionBonus, 100);
  assert.equal(panel.evasionRate, 1000 + 100 - Math.trunc((5000 * 30 + 1000000) / (5 * 30 + 20 + 1200)));
  assert.deepEqual(panel, expectedPanel(fixture, ringItems, 'fixture-hero', 30, ZERO(), { ring }));

  const negative = instance(ringId, {
    modifiers: [zeroModifier('hitBonus', -50), zeroModifier('evasionBonus', -100)],
  });
  const lowered = calculateCharacter(fixture, ringItems, 'fixture-hero', 30, ZERO(), { ring: negative });
  assert.equal(lowered.hitBonus, 0, 'negative hit bonus is clamped before display');
  assert.equal(lowered.evasionBonus, 0, 'negative evasion bonus is clamped to zero');
  assert.equal(lowered.hitRate, Math.trunc(20000 / (0 + 30 + 35)) + 100);

  const capped = instance(ringId, {
    modifiers: [zeroModifier('evasionBonus', 900)],
  });
  const cappedPanel = calculateCharacter(fixture, ringItems, 'fixture-hero', 1, ZERO(), { ring: capped });
  assert.equal(cappedPanel.evasionBonus, 750);
  assert.equal(cappedPanel.evasionRate, 750, 'evasion display is capped at 750 per mille');
});

test('critical, resistance, block and magic resistance fields clamp in their documented directions', () => {
  const shieldId = 'fixture-shield';
  const definitions: Record<string, EquipmentNumbers> = {
    'fixture-shield': zeroEquipmentNumbers({ defense: 10, shieldBlock: 40 }),
    'fixture-ring': zeroEquipmentNumbers({}),
  };
  const fixture = fixtureStats(ZERO(), definitions);
  const fixtureItems = makeFixtureItems([
    fixtureItem(shieldId, 'shield', 'off-hand'),
    fixtureItem('fixture-ring', 'ring', 'ring'),
  ]);
  const ring = instance('fixture-ring', {
    modifiers: [
      zeroModifier('criticalRate', 50), zeroModifier('criticalDamage', 250),
      zeroModifier('criticalResistance', 40), zeroModifier('criticalDamageResistance', 30),
      zeroModifier('weaponBlock', 20), zeroModifier('magicResistance', 300),
      zeroModifier('shieldBlock', 25), zeroModifier('maxMana', 50),
    ],
  });
  const shield = instance(shieldId);
  const panel = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { 'off-hand': shield, ring });
  assert.equal(panel.criticalRate, 80);
  assert.equal(panel.criticalDamage, 1250);
  assert.equal(panel.criticalResistance, 40);
  assert.equal(panel.criticalDamageResistance, 30);
  assert.equal(panel.weaponBlock, 50);
  assert.equal(panel.magicResistance, 300);
  assert.equal(panel.baseMagicResistance, 300);
  assert.equal(panel.shieldBlock, 65, 'shield definition and gem/modifier shield block both count once');
  assert.equal(panel.offhandShield, true);
  assert.equal(panel.maxMana, 250);

  const withoutShield = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { ring });
  assert.equal(withoutShield.shieldBlock, 0, 'shield block is unavailable without a shield in the off hand');
  assert.equal(withoutShield.offhandShield, false);

  const negative = instance('fixture-ring', {
    modifiers: [
      zeroModifier('criticalRate', -100), zeroModifier('criticalDamage', -2000),
      zeroModifier('criticalResistance', -20), zeroModifier('criticalDamageResistance', -20),
      zeroModifier('weaponBlock', -100), zeroModifier('shieldBlock', -100),
      zeroModifier('magicResistance', -100), zeroModifier('maxMana', -1000),
    ],
  });
  const lowered = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { 'off-hand': shield, ring: negative });
  assert.deepEqual(
    [lowered.criticalRate, lowered.criticalDamage, lowered.criticalResistance, lowered.criticalDamageResistance,
      lowered.weaponBlock, lowered.shieldBlock, lowered.magicResistance, lowered.baseMagicResistance, lowered.maxMana],
    [0, 0, 0, 0, 0, 0, -100, -100, -800],
    'critical-like fields stop at zero; magic resistance keeps negative values; max mana is not clamped',
  );

  const overCap = instance('fixture-ring', { modifiers: [zeroModifier('magicResistance', 900)] });
  assert.equal(calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { ring: overCap }).magicResistance, 750);
});

test('an occupied non-shield off hand keeps shield block inert', () => {
  const offhandId = 'non-shield-offhand';
  const fixture = fixtureStats(ZERO(), {
    [offhandId]: zeroEquipmentNumbers({ defense: 5, shieldBlock: 40 }),
  });
  const loadoutItems = makeFixtureItems([fixtureItem(offhandId, 'dagger', 'off-hand')]);
  const offhand = instance(offhandId, { modifiers: [zeroModifier('shieldBlock', 50)] });
  const equipped: Loadout = { 'off-hand': offhand };
  const panel = calculateCharacter(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), equipped);
  assert.equal(panel.offhandShield, false);
  assert.equal(panel.shieldBlock, 0, 'definition and modifier shield block stay inert without a shield');
  assert.deepEqual(panel, expectedPanel(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), equipped));
});

test('defense adds vitality, applies the raw defense rate, and physical resistance uses effective defense', () => {
  const armorId = 'defense-armor';
  const ringId = 'defense-ring';
  const fixture = fixtureStats(ZERO(), {
    [armorId]: zeroEquipmentNumbers({ defense: 100 }),
    [ringId]: zeroEquipmentNumbers({}),
  });
  const loadoutItems = makeFixtureItems([
    fixtureItem(armorId, 'cloth', 'body'),
    fixtureItem(ringId, 'ring', 'ring'),
  ]);
  const ring = instance(ringId, {
    modifiers: [zeroModifier('vitality', 10), zeroModifier('defenseRate', 200)],
  });
  const equipped = { body: instance(armorId), ring };
  const panel = calculateCharacter(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), equipped);
  assert.equal(panel.attributes.vitality, 10);
  assert.equal(panel.baseDefense, 110, 'gear defense 100 + vitality 10');
  assert.equal(panel.defenseRate, 200);
  assert.equal(panel.defense, Math.trunc(110 * 1200 / 1000));
  assert.equal(panel.physicalResistance, Math.trunc(1000 * panel.defense / (panel.defense + 20 * (1 + 3))));
  assert.equal(panel.maxHealth, 640 + 72 + 80 * 10);

  const negative = instance(ringId, {
    modifiers: [zeroModifier('vitality', -100), zeroModifier('defenseRate', -200)],
  });
  const lowered = calculateCharacter(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), { ring: negative });
  assert.equal(lowered.baseDefense, -100, 'raw defense keeps the signed value');
  assert.equal(lowered.defenseRate, -200, 'raw defense rate keeps the signed value');
  assert.equal(lowered.defense, 0, 'effective defense cannot go below zero');
  assert.equal(lowered.physicalResistance, 0);

  assert.deepEqual(panel, expectedPanel(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), equipped));
});

/* ------------------------------------------------------------------ */
/* 全量 662 件装备定义                                                 */
/* ------------------------------------------------------------------ */

test('content exposes all 662 equipment definitions and every one is an equippable item', () => {
  assert.equal(EQUIPMENT_IDS.length, 662);
  for (const id of EQUIPMENT_IDS) {
    assert.ok(items.items[id]?.equipment, `${id} has an item equipment definition`);
  }
});

test('every equipment definition contributes each scalar field exactly once to the panel', () => {
  let mainHands = 0, offhandShields = 0, negativeHitBonus = 0, magicRateArmor = 0;
  for (const id of EQUIPMENT_IDS) {
    const definition = catalog.equipment[id];
    const item = items.items[id];
    const slot = item.equipment!.slot;
    if (slot === 'main-hand') mainHands += 1;
    if (slot === 'off-hand') offhandShields += 1;
    if (definition.hitBonus < 0) negativeHitBonus += 1;
    if (definition.magicAttackRate !== 0) magicRateArmor += 1;
    const entry = instance(id, { magicPercent: definition.magicPercent[0] });
    const equipped = { [slot]: entry } as Loadout;
    const panel = calculateCharacter(ZERO_STATS, items, ZERO_CLASS, 1, ZERO(), equipped);
    assert.deepEqual(panel, expectedPanel(ZERO_STATS, items, ZERO_CLASS, 1, ZERO(), equipped), id);
    assert.deepEqual(PRIMARY_STATS.map(stat => panel.attributes[stat]), [0, 0, 0, 0, 0], id);
    assert.equal(panel.criticalRate, 30 + definition.criticalRate, id);
    assert.equal(panel.hitBonus, Math.max(0, definition.hitBonus), id);
    assert.equal(panel.hitRate, 655 + Math.max(0, definition.hitBonus), id);
    assert.equal(panel.baseDefense, definition.defense, id);
    assert.equal(panel.defense, definition.defense, id);
    assert.equal(panel.maxHealth, 712, id);
    assert.equal(panel.maxMana, 200, id);
    assert.equal(panel.weaponBlock, 30, id);
    assert.equal(panel.shieldBlock, slot === 'off-hand' ? definition.shieldBlock : 0, id);
    if (slot === 'main-hand') {
      assert.equal(panel.physicalAttack, definition.attack, id);
      assert.equal(panel.magicAttack, Math.trunc(definition.attack * definition.magicPercent[0] / 100), id);
    } else {
      assert.equal(panel.physicalAttack, 0, `${id} is not equipped in the main hand`);
      assert.equal(panel.magicAttack, 0, id);
    }
  }
  assert.equal(mainHands, 272);
  assert.equal(offhandShields, 28);
  assert.equal(negativeHitBonus, 34, 'bows carry the native negative hit bonus');
  assert.equal(magicRateArmor, 36);
});

test('definition scalar fields and same-name modifiers add exactly once', () => {
  const weaponId = 'together-weapon';
  const armorId = 'together-armor';
  const shieldId = 'together-shield';
  const ringId = 'together-ring';
  const fixture = fixtureStats(ZERO(), {
    [weaponId]: zeroEquipmentNumbers({ attack: 100, magicPercent: [100, 100], criticalRate: 20, hitBonus: 15 }),
    [armorId]: zeroEquipmentNumbers({ magicAttackRate: 200 }),
    [shieldId]: zeroEquipmentNumbers({ shieldBlock: 40 }),
    [ringId]: zeroEquipmentNumbers({}),
  });
  const loadoutItems = makeFixtureItems([
    fixtureItem(weaponId, 'longsword', 'main-hand'),
    fixtureItem(armorId, 'cloth', 'body'),
    fixtureItem(shieldId, 'shield', 'off-hand'),
    fixtureItem(ringId, 'ring', 'ring'),
  ]);
  const ring = instance(ringId, {
    modifiers: [
      zeroModifier('criticalRate', 5), zeroModifier('hitBonus', 5),
      zeroModifier('magicAttackRate', 500), zeroModifier('shieldBlock', 5),
    ],
  });
  const equipped: Loadout = {
    'main-hand': instance(weaponId, { magicPercent: 100 }),
    body: instance(armorId),
    'off-hand': instance(shieldId),
    ring,
  };
  const panel = calculateCharacter(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), equipped);
  assert.equal(panel.criticalRate, 30 + 20 + 5, 'definition 20 + modifier 5');
  assert.equal(panel.hitBonus, 15 + 5, 'definition 15 + modifier 5');
  assert.equal(panel.hitRate, 655 + 20);
  assert.equal(panel.magicAttack, Math.trunc(100 * (1000 + 200 + 500) / 1000),
    'armor definition 200 + ring modifier 500 multiply the weapon magic base once');
  assert.equal(panel.shieldBlock, 40 + 5, 'shield definition 40 + modifier 5');
  assert.deepEqual(panel, expectedPanel(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), equipped));
});

test('four equipment pieces add the same definition fields into one absolute sum', () => {
  const weaponId = 'stack-weapon';
  const armorId = 'stack-armor';
  const ringId = 'stack-ring';
  const shieldId = 'stack-shield';
  const fixture = fixtureStats(ZERO(), {
    [weaponId]: zeroEquipmentNumbers({ attack: 100, magicPercent: [100, 100], criticalRate: 10, hitBonus: 5, magicAttackRate: 50 }),
    [armorId]: zeroEquipmentNumbers({ criticalRate: 15, hitBonus: 10, magicAttackRate: 100 }),
    [ringId]: zeroEquipmentNumbers({ criticalRate: 20, hitBonus: 15, magicAttackRate: 200 }),
    [shieldId]: zeroEquipmentNumbers({ criticalRate: 5, hitBonus: 20, magicAttackRate: 25, shieldBlock: 30 }),
  });
  const loadoutItems = makeFixtureItems([
    fixtureItem(weaponId, 'longsword', 'main-hand'),
    fixtureItem(armorId, 'cloth', 'body'),
    fixtureItem(ringId, 'ring', 'ring'),
    fixtureItem(shieldId, 'shield', 'off-hand'),
  ]);
  const ring = instance(ringId, { modifiers: [zeroModifier('criticalRate', 7), zeroModifier('hitBonus', 8)] });
  const equipped: Loadout = {
    'main-hand': instance(weaponId, { magicPercent: 100 }),
    body: instance(armorId),
    ring,
    'off-hand': instance(shieldId),
  };
  const panel = calculateCharacter(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), equipped);
  assert.equal(panel.criticalRate, 30 + 10 + 15 + 20 + 5 + 7);
  assert.equal(panel.hitBonus, 5 + 10 + 15 + 20 + 8);
  assert.equal(panel.hitRate, 655 + 58);
  assert.equal(panel.magicAttack, Math.trunc(100 * (1000 + 50 + 100 + 200 + 25) / 1000));
  assert.equal(panel.shieldBlock, 30);
  assert.equal(panel.offhandShield, true);
  assert.deepEqual(panel, expectedPanel(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), equipped));
});

test('every definition magic attack rate multiplies a weapon magic base exactly once', () => {
  const weaponId = 'magic-rate-weapon';
  const definitions: Record<string, EquipmentNumbers> = {
    [weaponId]: zeroEquipmentNumbers({ attack: 200, magicPercent: [50, 50] }),
  };
  for (const id of EQUIPMENT_IDS) definitions[id] = catalog.equipment[id];
  const fixture = fixtureStats(ZERO(), definitions);
  const fixtureItems = makeFixtureItems([fixtureItem(weaponId, 'longsword', 'main-hand')]);
  const weaponEntry = instance(weaponId, { magicPercent: 50 });
  let checked = 0;
  for (const id of EQUIPMENT_IDS) {
    const definition = catalog.equipment[id];
    if (definition.magicAttackRate === 0) continue;
    checked += 1;
    const slot = items.items[id].equipment!.slot;
    const armorEntry = instance(id, { magicPercent: definition.magicPercent[0] });
    const equipped = { 'main-hand': weaponEntry, [slot]: armorEntry } as Loadout;
    const panel = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), equipped);
    assert.deepEqual(panel, expectedPanel(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), equipped), id);
    const baseMagic = Math.trunc(200 * 50 / 100);
    assert.equal(panel.magicAttack, Math.trunc(baseMagic * (1000 + definition.magicAttackRate) / 1000), id);
  }
  assert.equal(checked, 36);
});

test('all definitions roll every fixed option and exactly optionCount distinct random options', () => {
  for (const id of EQUIPMENT_IDS) {
    const definition = catalog.equipment[id];
    for (const end of ['min', 'max'] as const) {
      const random = (min: number, max: number) => end === 'min' ? min : max;
      const actual = rollEquipmentNumbers(definition, random, false);
      assert.deepEqual(actual, generatedNumbers(definition, end), `${id}:${end}`);
      assert.equal(actual.modifiers.length, definition.fixedOptions.length + definition.optionCount, `${id}:${end}`);
      assert.equal(actual.sockets, 0, `${id}:${end}`);
      assert.equal(actual.enhancementUses, definition.fixedEnhancementUses
        ?? (end === 'min' ? definition.enhancementUses[0] * 2 + 1 : definition.enhancementUses[1] * 2 + 1), `${id}:${end}`);
      const randomStats = actual.modifiers.slice(definition.fixedOptions.length).map(modifier => modifier.stat);
      assert.equal(new Set(randomStats).size, randomStats.length, `${id} random options are distinct`);
    }
  }
});

function scriptedRandom(values: number[]): (min: number, max: number) => number {
  let index = 0;
  return (min, max) => {
    const value = values[index++] ?? 0;
    return min + Math.floor(value * (max - min + 1));
  };
}

test('rollEquipmentNumbers uses grade base stats, option count and socket limit', () => {
  const definition = zeroEquipmentNumbers({
    attack: 1, defense: 2, magicPercent: [0, 0], fixedEnhancementUses: 1,
    fixedOptions: [{ stat: 'strength', min: 1, max: 1 }],
    randomOptions: [{ stat: 'dexterity', min: 2, max: 2 }, { stat: 'vitality', min: 3, max: 3 }],
    optionCount: 0, socketLimit: 0,
  });
  const grade = { grade: 7, gradeName: '测试品级', attack: 70, defense: 80, optionCount: 2, socketLimit: 2 };
  const numbers = rollEquipmentNumbers(definition, (min) => min, false, grade);
  assert.equal(numbers.grade, 7);
  assert.equal(numbers.gradeName, '测试品级');
  assert.equal(numbers.baseAttack, 70, 'grade attack overrides the definition base');
  assert.equal(numbers.baseDefense, 80, 'grade defense overrides the definition base');
  assert.deepEqual(numbers.modifiers, [
    { stat: 'strength', value: 1 },
    { stat: 'dexterity', value: 2 },
    { stat: 'vitality', value: 3 },
  ], 'grade optionCount 2 replaces the definition optionCount 0');
  assert.equal(numbers.sockets, 0);

  const socketLimited = zeroEquipmentNumbers({ magicPercent: [0, 0], fixedEnhancementUses: 1, socketLimit: 0 });
  const withGrade = rollEquipmentNumbers(socketLimited, scriptedRandom([0, 0, 0, 0]), true, grade);
  assert.equal(withGrade.sockets, 1, 'grade socketLimit 2 is used instead of definition socketLimit 0');
  const withoutGrade = rollEquipmentNumbers(socketLimited, scriptedRandom([0, 0, 0, 0]), true);
  assert.equal(withoutGrade.sockets, 0, 'definition socketLimit 0 prevents socket rolls');
});

test('rollEquipmentNumbers socket thresholds follow the 35/30/20/15 weights and 80% gate', () => {
  const definition = zeroEquipmentNumbers({ magicPercent: [0, 0], fixedEnhancementUses: 1, socketLimit: 4 });
  const cases: [number[], number][] = [
    [[0, 0, 0, 0], 1],
    [[0, 0, 0, 0.34], 1],
    [[0, 0, 0, 0.35], 2],
    [[0, 0, 0, 0.65], 3],
    [[0, 0, 0, 0.85], 4],
    [[0, 0, 0.79, 0], 1],
    [[0, 0, 0.8, 0], 0],
    [[0, 0, 0.99, 0], 0],
  ];
  for (const [draws, expected] of cases) {
    const numbers = rollEquipmentNumbers(definition, scriptedRandom(draws), true);
    assert.equal(numbers.sockets, expected, JSON.stringify(draws));
  }
});

test('all generated fixed and random modifiers reach the panel exactly once for every definition', () => {
  for (const id of EQUIPMENT_IDS) {
    const definition = catalog.equipment[id];
    const slot = items.items[id].equipment!.slot;
    for (const end of ['min', 'max'] as const) {
      const numbers = generatedNumbers(definition, end);
      const entry = instance(id, numbers);
      const equipped = { [slot]: entry } as Loadout;
      const panel = calculateCharacter(ZERO_STATS, items, ZERO_CLASS, 1, ZERO(), equipped);
      assert.deepEqual(panel, expectedPanel(ZERO_STATS, items, ZERO_CLASS, 1, ZERO(), equipped), `${id}:${end}`);
      const primarySums = Object.fromEntries(PRIMARY_STATS.map(stat => [
        stat, numbers.modifiers.filter(modifier => modifier.stat === stat).reduce((sum, modifier) => sum + modifier.value, 0),
      ])) as PrimaryAttributes;
      assert.deepEqual(panel.attributes, primarySums, `${id}:${end}`);
    }
  }
});

test('a negative bow hit bonus is applied once before the display clamp', () => {
  const bowId = 'huntsman-bow';
  const definition = catalog.equipment[bowId];
  assert.equal(definition.hitBonus, -20);
  const ringId = 'negative-hit-ring';
  const fixture = fixtureStats(ZERO(), {
    [ringId]: zeroEquipmentNumbers({}),
  });
  const fixtureItems = makeFixtureItems([fixtureItem(ringId, 'ring', 'ring')]);
  const bow = instance(bowId, { magicPercent: definition.magicPercent[0] });
  const ring = instance(ringId, { modifiers: [zeroModifier('hitBonus', 50)] });
  const withBow = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { 'main-hand': bow, ring });
  assert.equal(withBow.hitBonus, 30, '-20 from the bow + 50 from the ring');
  assert.equal(withBow.hitRate, 655 + 30);
  const withoutBow = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { ring });
  assert.equal(withoutBow.hitBonus, 50);
  assert.equal(withBow.hitBonus - withoutBow.hitBonus, -20, 'the negative bow value is neither dropped nor doubled');
});

/* ------------------------------------------------------------------ */
/* equipmentPower 与 enhancementBonus                                  */
/* ------------------------------------------------------------------ */

function canonicalRuleFor(kind: string) {
  for (const rules of Object.values(catalog.enchantments)) {
    if (rules[kind]) return rules[kind];
  }
  throw new Error(`no enhancement rule for ${kind}`);
}

function distinctRules(): { step: number; threshold: number; extra: number; bonusChance?: number }[] {
  const seen = new Map<string, { step: number; threshold: number; extra: number; bonusChance?: number }>();
  for (const rules of Object.values(catalog.enchantments)) {
    for (const rule of Object.values(rules)) {
      const key = JSON.stringify(rule);
      if (!seen.has(key)) seen.set(key, rule);
    }
  }
  return [...seen.values()];
}

test('enhancementBonus adds step per level and starts the extra term at the threshold', () => {
  const rules = distinctRules();
  assert.equal(rules.length, 23);
  for (const rule of rules) {
    for (let level = 0; level <= 30; level += 1) {
      const entry = instance('fixture', { enhancementRule: rule }, level);
      const extraLevels = Math.max(0, level - rule.threshold + 1);
      assert.equal(enhancementBonus(entry), level * rule.step + extraLevels * rule.extra, `${JSON.stringify(rule)}@${level}`);
    }
  }
  const boundaryRule = { step: 10, threshold: 10, extra: 100 };
  const at = (level: number) => enhancementBonus(instance('fixture', { enhancementRule: boundaryRule }, level));
  assert.deepEqual([at(9), at(10), at(11)], [90, 200, 310], 'extra starts after threshold − 1');
  assert.equal(enhancementBonus(instance('fixture', {}, 30)), 0, 'no rule means no enhancement bonus');
  assert.equal(enhancementBonus(instance('fixture', { enhancementRule: { step: 4, threshold: 10, extra: 3 } }, -2)), -8,
    'negative enhancement levels still pay the step term and no extra term');
  assert.equal(enhancementBonus(instance('fixture', { enhancementRule: { step: 4, threshold: 0, extra: 3 } }, 0)), 3,
    'threshold zero pays the first extra term at level zero');
});

test('equipmentPower applies enhancement to every definition base for levels 0..30', () => {
  let checked = 0;
  for (const id of EQUIPMENT_IDS) {
    const definition = catalog.equipment[id];
    const rule = canonicalRuleFor(items.items[id].kind);
    const magicPercent = definition.magicPercent[0];
    for (let level = 0; level <= 30; level += 1) {
      const entry = instance(id, { magicPercent, enhancementRule: rule }, level);
      const bonus = level * rule.step + Math.max(0, level - rule.threshold + 1) * rule.extra;
      const attack = definition.attack === 0 ? 0 : definition.attack + bonus;
      const defense = definition.defense === 0 ? 0 : definition.defense + bonus;
      assert.deepEqual(equipmentPower(definition, entry), {
        attack,
        magicAttack: Math.trunc(attack * magicPercent / 100),
        defense,
      }, `${id}@${level}`);
      checked += 1;
    }
  }
  assert.equal(checked, 662 * 31);
});

test('equipmentPower covers every distinct content enhancement rule at every level', () => {
  const weapon = catalog.equipment[EQUIPMENT_IDS.find(id => items.items[id].equipment!.slot === 'main-hand')!];
  const armor = catalog.equipment[EQUIPMENT_IDS.find(id => catalog.equipment[id].defense > 0)!];
  for (const rule of distinctRules()) {
    for (let level = 0; level <= 30; level += 1) {
      const bonus = level * rule.step + Math.max(0, level - rule.threshold + 1) * rule.extra;
      const weaponEntry = instance('weapon', { magicPercent: weapon.magicPercent[0], enhancementRule: rule }, level);
      assert.deepEqual(equipmentPower(weapon, weaponEntry), {
        attack: weapon.attack + bonus,
        magicAttack: Math.trunc((weapon.attack + bonus) * weapon.magicPercent[0] / 100),
        defense: weapon.defense,
      }, `weapon ${JSON.stringify(rule)}@${level}`);
      const armorEntry = instance('armor', { enhancementRule: rule }, level);
      assert.deepEqual(equipmentPower(armor, armorEntry), {
        attack: armor.attack,
        magicAttack: Math.trunc(armor.attack * 0 / 100),
        defense: armor.defense + bonus,
      }, `armor ${JSON.stringify(rule)}@${level}`);
    }
  }
});

test('equipmentPower honors instance base overrides, magic percent and chaos order', () => {
  const definition = zeroEquipmentNumbers({ attack: 100, defense: 40, magicPercent: [25, 25] });
  const rule = { step: 3, threshold: 10, extra: 7 };
  const plain = instance('gear', { baseAttack: 40, baseDefense: 30, magicPercent: 25, enhancementRule: rule }, 5);
  assert.deepEqual(equipmentPower(definition, plain), { attack: 55, magicAttack: 13, defense: 45 });

  const chaos = instance('gear', {
    baseAttack: 40, baseDefense: 30, magicPercent: 25, enhancementRule: rule,
    chaos: { tier: 'chaos', valuePercent: 150, levelOffset: 0 },
  }, 5);
  assert.deepEqual(equipmentPower(definition, chaos), {
    attack: Math.trunc((40 + 15) * 1.5),
    magicAttack: Math.trunc(Math.trunc((40 + 15) * 1.5) * 25 / 100),
    defense: Math.trunc((30 + 15) * 1.5),
  }, 'enhancement is added before the chaos rate, and magic uses the final attack');

  const zeroRate = instance('gear', {
    baseAttack: 40, baseDefense: 30, magicPercent: 25, enhancementRule: rule,
    chaos: { tier: 'chaos', valuePercent: 0, levelOffset: 0 },
  }, 5);
  assert.deepEqual(equipmentPower(definition, zeroRate), { attack: 1, magicAttack: 0, defense: 0 },
    'attack keeps a floor of 1 under chaos; defense can reach zero');

  assert.deepEqual(equipmentPower(definition, instance('gear', { magicPercent: 25 })), {
    attack: 100, magicAttack: 25, defense: 40,
  }, 'an instance without base overrides falls back to the definition');
  assert.deepEqual(equipmentPower(definition, { id: 'bare', item: 'gear', quantity: 1, enhancement: 30, gems: [] }), {
    attack: 100, magicAttack: 0, defense: 40,
  }, 'missing numbers means no magic percent and no enhancement rule');
  assert.deepEqual(equipmentPower(zeroEquipmentNumbers({}), instance('zero', { magicPercent: 100 })), {
    attack: 0, magicAttack: 0, defense: 0,
  }, 'zero base stats stay zero even with magic percent');
});

/* ------------------------------------------------------------------ */
/* 宝石词条与 previewGemPanel                                          */
/* ------------------------------------------------------------------ */

test('every distinct gem modifier range adds exactly once to attributes and panel fields', () => {
  const shieldId = 'gem-shield';
  const fixture = fixtureStats(ZERO(), { [shieldId]: zeroEquipmentNumbers({ defense: 5 }) });
  const fixtureItems = makeFixtureItems([fixtureItem(shieldId, 'shield', 'off-hand')]);
  const ranges = new Map<string, ModifierRange>();
  for (const levels of Object.values(catalog.gems)) {
    for (const choices of levels) {
      for (const range of choices) ranges.set(`${range.stat}:${range.min}:${range.max}`, range);
    }
  }
  assert.equal(ranges.size, 323);
  for (const range of ranges.values()) {
    for (const value of [range.min, range.max]) {
      const modifier = zeroModifier(range.stat, value);
      const entry = instance(shieldId, { gemModifiers: [modifier] });
      const equipped = { 'off-hand': entry } as Loadout;
      const panel = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), equipped);
      assert.deepEqual(panel, expectedPanel(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), equipped),
        `${range.stat}=${value}`);
      if ((PRIMARY_STATS as readonly string[]).includes(range.stat)) {
        assert.equal(panel.attributes[range.stat as PrimaryStat], value, `${range.stat}=${value}`);
      }
    }
  }
});

test('multiple gem modifiers of the same and different stats each add once; shield block needs a shield', () => {
  const shieldId = 'gem-shield';
  const weaponId = 'gem-weapon';
  const definitions: Record<string, EquipmentNumbers> = {
    [shieldId]: zeroEquipmentNumbers({}),
    [weaponId]: zeroEquipmentNumbers({ attack: 10, magicPercent: [100, 100] }),
  };
  const fixture = fixtureStats(ZERO(), definitions);
  const fixtureItems = makeFixtureItems([
    fixtureItem(shieldId, 'shield', 'off-hand'),
    fixtureItem(weaponId, 'longsword', 'main-hand'),
  ]);
  const modifiers = [
    zeroModifier('strength', 5), zeroModifier('strength', 5),
    zeroModifier('criticalRate', 10), zeroModifier('criticalRate', 10),
    zeroModifier('evasionBonus', 500), zeroModifier('evasionBonus', 500),
    zeroModifier('shieldBlock', 30),
  ];
  const shield = instance(shieldId, { gemModifiers: modifiers });
  const panel = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { 'off-hand': shield });
  assert.equal(panel.attributes.strength, 10);
  assert.equal(panel.criticalRate, 50);
  assert.equal(panel.evasionBonus, 750, 'two halves are added, then capped at 750');
  assert.equal(panel.shieldBlock, 30);
  assert.deepEqual(panel, expectedPanel(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { 'off-hand': shield }));

  const weapon = instance(weaponId, {
    magicPercent: 100,
    gemModifiers: [zeroModifier('shieldBlock', 30), zeroModifier('strength', 5)],
  });
  const weaponPanel = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, ZERO(), { 'main-hand': weapon });
  assert.equal(weaponPanel.shieldBlock, 0, 'shield block from a non-shield slot is inert');
  assert.equal(weaponPanel.attributes.strength, 5);
});

test('normal and gem modifiers of the same stat add before the panel clamps', () => {
  const ringId = 'dual-source-ring';
  const fixture = fixtureStats(ZERO(), { [ringId]: zeroEquipmentNumbers({}) });
  const ringItems = makeFixtureItems([fixtureItem(ringId, 'ring', 'ring')]);
  const ring = instance(ringId, {
    modifiers: [
      zeroModifier('strength', 5), zeroModifier('criticalRate', 5),
      zeroModifier('hitBonus', 5), zeroModifier('evasionBonus', 5),
    ],
    gemModifiers: [
      zeroModifier('strength', 10), zeroModifier('criticalRate', 10),
      zeroModifier('hitBonus', 10), zeroModifier('evasionBonus', 10),
    ],
  });
  const equipped: Loadout = { ring };
  const panel = calculateCharacter(fixture, ringItems, 'fixture-hero', 1, ZERO(), equipped);
  assert.equal(panel.attributes.strength, 15, 'normal strength 5 + gem strength 10');
  assert.equal(panel.criticalRate, 45, 'base 30 + normal 5 + gem 10');
  assert.equal(panel.hitBonus, 15, 'normal 5 + gem 10');
  assert.equal(panel.hitRate, 655 + 15);
  assert.equal(panel.evasionBonus, 15, 'normal 5 + gem 10');
  assert.deepEqual(panel, expectedPanel(fixture, ringItems, 'fixture-hero', 1, ZERO(), equipped));
});

test('all 17 gem stats have exact panel effects and the 750 caps', () => {
  const staffId = 'gem-stat-staff';
  const shieldId = 'gem-stat-shield';
  const fixture = fixtureStats(ZERO(), {
    [staffId]: zeroEquipmentNumbers({ magicPercent: [100, 100] }),
    [shieldId]: zeroEquipmentNumbers({}),
  });
  const loadoutItems = makeFixtureItems([
    fixtureItem(staffId, 'staff', 'main-hand'),
    fixtureItem(shieldId, 'shield', 'off-hand'),
  ]);
  const baseEquipped = (): Loadout => ({
    'main-hand': instance(staffId, { magicPercent: 100 }),
    'off-hand': instance(shieldId),
  });
  const baseline = calculateCharacter(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), baseEquipped());
  const gemStats = new Set<string>();
  for (const levels of Object.values(catalog.gems)) {
    for (const choices of levels) for (const choice of choices) gemStats.add(choice.stat);
  }
  assert.deepEqual([...gemStats].sort(), [
    'criticalDamage', 'criticalDamageResistance', 'criticalRate', 'criticalResistance',
    'dexterity', 'evasionBonus', 'hitBonus', 'intelligence', 'lifeSteal', 'magicResistance',
    'manaRegen', 'maxMana', 'mentality', 'shieldBlock', 'strength', 'vitality', 'weaponBlock',
  ].sort());

  const value = 10;
  for (const stat of gemStats) {
    const equipped = baseEquipped();
    equipped['off-hand'] = instance(shieldId, { gemModifiers: [zeroModifier(stat, value)] });
    const panel = calculateCharacter(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), equipped);
    assert.deepEqual(panel, expectedPanel(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), equipped), stat);
    switch (stat) {
      case 'strength':
        assert.equal(panel.attributes.strength, value);
        assert.equal(panel.physicalAttack, baseline.physicalAttack + 5);
        break;
      case 'dexterity':
        assert.equal(panel.attributes.dexterity, value);
        assert.equal(panel.physicalAttack, baseline.physicalAttack + 5);
        assert.equal(panel.hitBase, baseline.hitBase + 40);
        assert.equal(panel.evasionBase, baseline.evasionBase + 10);
        break;
      case 'vitality':
        assert.equal(panel.attributes.vitality, value);
        assert.equal(panel.maxHealth, baseline.maxHealth + 800);
        assert.equal(panel.baseDefense, baseline.baseDefense + 10);
        assert.equal(panel.defense, baseline.defense + 10);
        break;
      case 'intelligence':
        assert.equal(panel.attributes.intelligence, value);
        assert.equal(panel.magicAttack, baseline.magicAttack + 6, 'staff intelligence rate 600');
        break;
      case 'mentality':
        assert.equal(panel.attributes.mentality, value);
        assert.equal(panel.magicAttack, baseline.magicAttack + 6, 'staff mentality rate 600');
        assert.equal(panel.hitBase, baseline.hitBase + 40);
        break;
      case 'criticalRate':
        assert.equal(panel.criticalRate, baseline.criticalRate + value);
        break;
      case 'evasionBonus':
        assert.equal(panel.evasionBonus, baseline.evasionBonus + value);
        break;
      case 'shieldBlock':
        assert.equal(panel.shieldBlock, baseline.shieldBlock + value, 'the gem sits in the shield');
        break;
      case 'hitBonus':
        assert.equal(panel.hitBonus, baseline.hitBonus + value);
        assert.equal(panel.hitRate, baseline.hitRate + value);
        break;
      case 'weaponBlock':
        assert.equal(panel.weaponBlock, baseline.weaponBlock + value);
        break;
      case 'maxMana':
        assert.equal(panel.maxMana, baseline.maxMana + value);
        break;
      case 'magicResistance':
        assert.equal(panel.magicResistance, baseline.magicResistance + value);
        assert.equal(panel.baseMagicResistance, baseline.baseMagicResistance + value);
        break;
      case 'criticalDamage':
        assert.equal(panel.criticalDamage, baseline.criticalDamage + value);
        break;
      case 'criticalResistance':
        assert.equal(panel.criticalResistance, baseline.criticalResistance + value);
        break;
      case 'criticalDamageResistance':
        assert.equal(panel.criticalDamageResistance, baseline.criticalDamageResistance + value);
        break;
      case 'manaRegen':
      case 'lifeSteal':
        assert.deepEqual(panel, baseline, `${stat} has no panel field`);
        break;
      default:
        assert.fail(`unexpected gem stat ${stat}`);
    }
  }

  const evasionCap = baseEquipped();
  evasionCap['off-hand'] = instance(shieldId, { gemModifiers: [zeroModifier('evasionBonus', 900)] });
  const evasionPanel = calculateCharacter(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), evasionCap);
  assert.equal(evasionPanel.evasionBonus, 750);
  assert.equal(evasionPanel.evasionRate, 750);
  assert.deepEqual(evasionPanel, expectedPanel(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), evasionCap));

  const magicCap = baseEquipped();
  magicCap['off-hand'] = instance(shieldId, { gemModifiers: [zeroModifier('magicResistance', 900)] });
  const magicPanel = calculateCharacter(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), magicCap);
  assert.equal(magicPanel.magicResistance, 750);
  assert.equal(magicPanel.baseMagicResistance, 900, 'the raw resistance stays signed/uncapped for combat');
  assert.deepEqual(magicPanel, expectedPanel(fixture, loadoutItems, 'fixture-hero', 1, ZERO(), magicCap));
});

test('socketing a real gem writes one modifier and the panel counts it once', () => {
  for (const gemId of Object.keys(catalog.gems)) {
    const hero = new BattleCharacter('dark-knight', catalog, items);
    const shield = hero.bag.get(hero.bag.equipment['off-hand']!)!;
    setBagEntry(hero, shield.id, entry => { entry.numbers!.sockets = 3; entry.numbers!.gemModifiers = []; });
    hero.bag.add(gemId);
    const gem = hero.bag.entries.find(entry => entry.item === gemId)!;
    const modifier = gem.numbers!.modifiers[0];
    hero.bag.use(gem.id, shield.id);
    const socketed = hero.bag.get(shield.id)!;
    assert.equal(socketed.gems.length, 1, gemId);
    assert.deepEqual(socketed.numbers!.gemModifiers, [modifier], `${gemId} adds exactly its stored modifier`);
    assert.deepEqual(hero.panel, expectedPanel(catalog, items, hero.classId, hero.level, hero.allocated, expectedLoadout(hero)), gemId);
    const preview = hero.previewGemChange(shield.id, socketed.numbers!.gemModifiers);
    assert.deepEqual(preview, hero.panel, `${gemId} preview equals the real worn panel`);
  }
});

test('previewGemChange replaces gem modifiers for worn and empty-slot targets and never mutates the bag', () => {
  const hero = new BattleCharacter('dark-knight', catalog, items);
  setHeroState(hero, 105);
  const weaponId = hero.bag.equipment['main-hand']!;
  setBagEntry(hero, weaponId, entry => { entry.numbers!.gemModifiers = [zeroModifier('strength', 100)]; });
  const before = hero.bag.get(weaponId)!;
  const panelWithExisting = hero.panel;
  const gems = [zeroModifier('strength', 10), zeroModifier('criticalRate', 20)];
  const preview = hero.previewGemChange(weaponId, gems);
  assert.ok(preview);
  const loadout = expectedLoadout(hero);
  loadout['main-hand'] = { ...before, numbers: { ...before.numbers!, gemModifiers: gems } };
  assert.deepEqual(preview, calculateCharacter(catalog, items, hero.classId, hero.level, hero.allocated, loadout));
  assert.equal(preview.attributes.strength, panelWithExisting.attributes.strength - 100 + 10,
    'preview replaces the existing +100 gem modifier instead of appending');
  assert.deepEqual(hero.bag.get(weaponId), before, 'preview does not write to the bag');
  assert.deepEqual(preview, expectedPanel(catalog, items, hero.classId, hero.level, hero.allocated, loadout));

  const ringId = Object.keys(items.items).find(id => {
    const equipment = items.items[id].equipment;
    return equipment?.slot === 'ring' && equipment.classes.includes('dark-knight') && !equipment.locked && catalog.equipment[id];
  })!;
  hero.bag.add(ringId);
  const spare = hero.bag.entries.find(entry => entry.item === ringId)!;
  const slot = hero.bag.emptyEquipSlot(spare.id, 'player', hero.classId, hero.level)!;
  assert.ok(slot);
  const sparePreview = hero.previewGemChange(spare.id, gems);
  assert.ok(sparePreview);
  const spareLoadout = expectedLoadout(hero);
  spareLoadout[slot] = { ...spare, numbers: { ...spare.numbers!, gemModifiers: gems } };
  assert.deepEqual(sparePreview, calculateCharacter(catalog, items, hero.classId, hero.level, hero.allocated, spareLoadout));
  setBagEntry(hero, spare.id, entry => { entry.numbers!.gemModifiers = gems; });
  hero.bag.equip(spare.id, slot);
  assert.deepEqual(hero.panel, sparePreview, 'preview matches the panel after really equipping the item');

  const potionId = Object.keys(items.items).find(id => items.items[id].category === 'consumable')!;
  hero.bag.add(potionId);
  const potion = hero.bag.entries.find(entry => entry.item === potionId)!;
  assert.equal(hero.previewGemChange(potion.id, gems), undefined, 'non-equipment has no slot');

  const foreignId = Object.keys(items.items).find(id => {
    const equipment = items.items[id].equipment;
    return equipment && !equipment.classes.includes('dark-knight') && !equipment.locked && catalog.equipment[id];
  })!;
  hero.bag.add(foreignId);
  const foreign = hero.bag.entries.find(entry => entry.item === foreignId)!;
  assert.equal(hero.previewGemChange(foreign.id, gems), undefined, 'a class-incompatible item gets no empty slot');
});

test('previewGemPanel replaces instead of appending and returns undefined without a target slot', () => {
  const hero = new BattleCharacter('dark-knight', catalog, items);
  const weaponId = hero.bag.equipment['main-hand']!;
  setBagEntry(hero, weaponId, entry => { entry.numbers!.gemModifiers = [zeroModifier('strength', 100)]; });
  const weapon = hero.bag.get(weaponId)!;
  const panelWithExisting = hero.panel;
  const gems = [zeroModifier('strength', 7)];
  const preview = previewGemPanel({
    catalog, items, classId: hero.classId, level: hero.level, allocated: hero.allocated,
    equipped: hero.bag.equipment, bag: hero.bag, targetId: weapon.id, gemModifiers: gems,
  });
  assert.ok(preview);
  const loadout = expectedLoadout(hero);
  loadout['main-hand'] = { ...weapon, numbers: { ...weapon.numbers!, gemModifiers: gems } };
  assert.deepEqual(preview, calculateCharacter(catalog, items, hero.classId, hero.level, hero.allocated, loadout));
  assert.equal(preview.attributes.strength, panelWithExisting.attributes.strength - 100 + 7,
    'the existing +100 gem modifier is replaced, not appended');

  const ringId = Object.keys(items.items).find(id => {
    const equipment = items.items[id].equipment;
    return equipment?.slot === 'ring' && equipment.classes.includes('dark-knight') && !equipment.locked && catalog.equipment[id];
  })!;
  hero.bag.add(ringId);
  const spare = hero.bag.entries.find(entry => entry.item === ringId)!;
  assert.equal(previewGemPanel({
    catalog, items, classId: hero.classId, level: hero.level, allocated: hero.allocated,
    equipped: hero.bag.equipment, bag: hero.bag, targetId: spare.id, gemModifiers: gems,
  }), undefined, 'a bag item without an explicit empty slot is rejected');

  hero.bag.add('healing-potion-s');
  const potion = hero.bag.entries.find(entry => entry.item === 'healing-potion-s')!;
  assert.equal(previewGemPanel({
    catalog, items, classId: hero.classId, level: hero.level, allocated: hero.allocated,
    equipped: hero.bag.equipment, bag: hero.bag, targetId: potion.id, gemModifiers: gems, emptySlot: 'ring',
  }), undefined, 'a target without item numbers is rejected even with an empty slot');
  assert.equal(previewGemPanel({
    catalog, items, classId: hero.classId, level: hero.level, allocated: hero.allocated,
    equipped: hero.bag.equipment, bag: hero.bag, targetId: 'missing-id', gemModifiers: gems, emptySlot: 'ring',
  }), undefined, 'a missing target is rejected');
});

/* ------------------------------------------------------------------ */
/* AttributeAllocation 与 BattleCharacter                              */
/* ------------------------------------------------------------------ */

test('every level grants 5 attribute points and the cap is level 105', () => {
  const hero = zeroHero(1);
  assert.equal(hero.statPoints, 0);
  assert.equal(hero.level, 1);
  for (const level of [2, 10, 50, 104, 105]) {
    setHeroState(hero, level);
    assert.equal(hero.statPoints, (level - 1) * 5, `level ${level}`);
  }
  setHeroState(hero, 105);
  const all = { strength: 104, dexterity: 104, vitality: 104, intelligence: 104, mentality: 104 };
  hero.commitAllocation(all);
  assert.equal(hero.statPoints, 0);
  assert.throws(() => hero.commitAllocation({ ...ZERO(), strength: 1 }), /能力点/);

  const earned = zeroHero(1);
  const changes: number[] = [];
  earned.subscribe(() => changes.push(earned.statPoints));
  earned.addExperience(catalog.experience[0]!);
  assert.equal(earned.level, 2);
  assert.equal(earned.statPoints, 5);
  assert.deepEqual(changes, [5], 'one level-up publishes one updated point balance');
});

test('AttributeAllocation previews, cancels and commits pending points without touching the hero early', () => {
  const hero = zeroHero(2);
  assert.equal(hero.statPoints, 5);
  const before = hero.panel;
  let notifications = 0;
  hero.subscribe(() => notifications++);
  const draft = new AttributeAllocation(hero);
  assert.deepEqual(draft.pending, ZERO());
  assert.equal(draft.hasChanges, false);
  assert.equal(draft.remainingPoints, 5);
  draft.change('strength', 1);
  draft.change('vitality', 1);
  assert.equal(draft.remainingPoints, 3);
  assert.equal(draft.hasChanges, true);
  assert.equal(draft.attributes.strength, before.attributes.strength + 1);
  assert.equal(draft.attributes.vitality, before.attributes.vitality + 1);
  assert.deepEqual(hero.panel, before, 'draft changes do not mutate the hero panel');
  const pending = draft.pending;
  pending.strength = 99;
  assert.equal(draft.pending.strength, 1, 'pending returns a copy');

  draft.change('strength', -1);
  assert.equal(draft.remainingPoints, 4);
  draft.cancel();
  assert.equal(draft.hasChanges, false);
  assert.deepEqual(draft.pending, ZERO());
  assert.deepEqual(draft.attributes, before.attributes);
  assert.equal(notifications, 0);

  draft.change('strength', 1);
  draft.change('vitality', 1);
  const expected = expectedPanel(ZERO_STATS, items, ZERO_CLASS, 2, { ...ZERO(), strength: 1, vitality: 1 }, {});
  draft.commit();
  assert.deepEqual(hero.panel, expected);
  assert.deepEqual(hero.allocated, { ...ZERO(), strength: 1, vitality: 1 });
  assert.equal(hero.statPoints, 3);
  assert.equal(notifications, 1, 'commit publishes one panel update');
  assert.deepEqual(draft.pending, ZERO());
  assert.equal(draft.hasChanges, false);
  draft.commit();
  assert.equal(notifications, 1, 'a second commit with no pending points is a no-op');
  assert.throws(() => new AttributeAllocation(hero).change('strength', -1), /待确认/,
    'committed points cannot be undone by a later draft');
});

test('each primary attribute moves only the documented panel fields per point', () => {
  const hero = zeroHero(10);
  const base = hero.panel;
  for (const stat of PRIMARY_STATS) {
    hero.resetAttributes();
    hero.allocate(stat, 1);
    const after = hero.panel;
    const expected = expectedPanel(ZERO_STATS, items, ZERO_CLASS, 10, { ...ZERO(), [stat]: 1 }, {});
    assert.deepEqual(after, expected, stat);
    if (stat === 'vitality') {
      assert.equal(after.maxHealth - base.maxHealth, 80);
      assert.equal(after.defense - base.defense, 1);
      assert.equal(after.physicalAttack, base.physicalAttack);
      assert.equal(after.magicAttack, base.magicAttack);
      assert.equal(after.hitBase, base.hitBase);
      assert.equal(after.evasionRate, base.evasionRate);
    } else if (stat === 'strength') {
      assert.equal(after.physicalAttack, base.physicalAttack, 'trunc(1 × 500 / 1000) keeps unarmed strength at zero');
      assert.equal(after.maxHealth, base.maxHealth);
      assert.equal(after.magicAttack, base.magicAttack);
      assert.equal(after.hitBase, base.hitBase);
    } else if (stat === 'dexterity') {
      assert.equal(after.physicalAttack, base.physicalAttack + Math.trunc(1 / 2));
      assert.equal(after.hitBase, base.hitBase + 4);
      assert.equal(after.evasionBase, base.evasionBase + 1);
      assert.notEqual(after.evasionRate, base.evasionRate);
      assert.equal(after.maxHealth, base.maxHealth);
      assert.equal(after.magicAttack, base.magicAttack);
    } else if (stat === 'intelligence' || stat === 'mentality') {
      assert.equal(after.physicalAttack, base.physicalAttack);
      assert.equal(after.magicAttack, base.magicAttack, 'unarmed casting rates are zero');
      assert.equal(after.maxHealth, base.maxHealth);
      assert.equal(after.hitBase, base.hitBase + (stat === 'mentality' ? 4 : 0));
    }
  }
  hero.resetAttributes();
  assert.deepEqual(hero.panel, base);
});

test('weapon casting rates make intelligence and mentality points affect magic attack', () => {
  const definitions: Record<string, EquipmentNumbers> = {
    'caster-staff': zeroEquipmentNumbers({ magicPercent: [100, 100] }),
  };
  const fixture = fixtureStats(ZERO(), definitions);
  const fixtureItems = makeFixtureItems([fixtureItem('caster-staff', 'staff', 'main-hand')]);
  const weapon = instance('caster-staff', { magicPercent: 100 });
  const allocated: PrimaryAttributes = { ...ZERO(), intelligence: 10, mentality: 10 };
  const panel = calculateCharacter(fixture, fixtureItems, 'fixture-hero', 1, allocated, { 'main-hand': weapon });
  assert.equal(panel.magicAttack, Math.trunc(10 * 600 / 1000) + Math.trunc(10 * 600 / 1000));
  assert.deepEqual(panel, expectedPanel(fixture, fixtureItems, 'fixture-hero', 1, allocated, { 'main-hand': weapon }));

  const orbWeapon = instance('caster-orb', { magicPercent: 100 });
  const orbDefinitions = { 'caster-orb': zeroEquipmentNumbers({ magicPercent: [100, 100] }) };
  const orbFixtureItems = makeFixtureItems([fixtureItem('caster-orb', 'orb', 'main-hand')]);
  const orbPanel = calculateCharacter({ ...fixture, equipment: { ...fixture.equipment, ...orbDefinitions } }, orbFixtureItems,
    'fixture-hero', 1, allocated, { 'main-hand': orbWeapon });
  assert.equal(orbPanel.magicAttack, Math.trunc(10 * 700 / 1000) + Math.trunc(10 * 600 / 1000));
});

test('committing points on an equipped hero moves the panel exactly like the formulas', () => {
  const knight = new BattleCharacter('dark-knight', catalog, items);
  setHeroState(knight, 10);
  const beforeKnight = knight.panel;
  const knightDraft = new AttributeAllocation(knight);
  knightDraft.change('strength', 1);
  knightDraft.change('dexterity', 1);
  knightDraft.change('vitality', 1);
  knightDraft.commit();
  assert.deepEqual(knight.panel, expectedPanel(catalog, items, knight.classId, 10, knight.allocated, expectedLoadout(knight)));
  assert.equal(knight.panel.maxHealth, beforeKnight.maxHealth + 80);
  assert.equal(knight.panel.hitBase, beforeKnight.hitBase + 4);
  assert.equal(knight.panel.evasionBase, beforeKnight.evasionBase + 1);
  assert.ok(knight.panel.physicalAttack > beforeKnight.physicalAttack, 'longsword strength/dexterity points raise physical attack');

  const warlock = new BattleCharacter('warlock', catalog, items);
  setHeroState(warlock, 10);
  const beforeWarlock = warlock.panel;
  const casterDraft = new AttributeAllocation(warlock);
  for (let point = 0; point < 10; point += 1) casterDraft.change('intelligence', 1);
  for (let point = 0; point < 10; point += 1) casterDraft.change('mentality', 1);
  casterDraft.commit();
  assert.deepEqual(warlock.panel, expectedPanel(catalog, items, warlock.classId, 10, warlock.allocated, expectedLoadout(warlock)));
  assert.equal(warlock.panel.magicAttack - beforeWarlock.magicAttack,
    Math.trunc(10 * 600 / 1000) + Math.trunc(10 * 600 / 1000), 'staff gives 600 per mille to both casting attributes');
  assert.equal(warlock.panel.hitBase - beforeWarlock.hitBase, 40, 'mentality points add four hit base each');
  assert.equal(warlock.panel.evasionBase, beforeWarlock.evasionBase, 'intelligence and mentality do not change evasion base');
});

test('invalid allocation shapes, deltas and unaffordable commits are rejected atomically', () => {
  const hero = zeroHero(2);
  setHeroState(hero, 2);
  const before = hero.panel;
  const invalid = [
    { ...ZERO(), strength: -1 },
    { ...ZERO(), vitality: 0.5 },
    { ...ZERO(), mentality: Number.NaN },
    { ...ZERO(), intelligence: Number.POSITIVE_INFINITY },
    { ...ZERO(), strength: 6 },
    { strength: 1 },
    { ...ZERO(), extra: 1 },
  ];
  for (const delta of invalid) {
    assert.throws(() => hero.commitAllocation(delta as PrimaryAttributes));
    assert.equal(hero.statPoints, 5);
    assert.deepEqual(hero.panel, before);
  }
  hero.commitAllocation(ZERO());
  assert.equal(hero.statPoints, 5, 'a zero delta is a no-op');
  assert.throws(() => hero.allocate('luck' as PrimaryStat, 1), /属性操作无效/);
  assert.throws(() => hero.allocate('strength', 2 as 1), /属性操作无效/);
  assert.throws(() => hero.allocate('strength', -1), /已分配/);
  hero.commitAllocation({ ...ZERO(), strength: 5 });
  assert.throws(() => hero.allocate('strength', 1), /属性点/);
  assert.throws(() => hero.allocate('vitality', -1), /已分配/);

  setHeroState(hero, 2);
  const draft = new AttributeAllocation(hero);
  draft.change('vitality', 1);
  hero.commitAllocation({ ...ZERO(), strength: 5 });
  assert.throws(() => draft.commit(), /能力点/);
  assert.deepEqual(draft.pending, { ...ZERO(), vitality: 1 }, 'failed commit restores the pending draft');
  assert.deepEqual(hero.allocated, { ...ZERO(), strength: 5 });
  draft.cancel();

  const other = new AttributeAllocation(hero);
  assert.throws(() => other.change('strength', 2 as 1), /属性操作无效/);
  assert.throws(() => other.change('luck' as PrimaryStat, 1), /属性操作无效/);
  assert.throws(() => other.change('strength', -1), /待确认/);
});

test('resetAttributes returns every point and restores the base panel', () => {
  const hero = zeroHero(3);
  const base = hero.panel;
  hero.allocate('strength', 1);
  hero.allocate('vitality', 1);
  hero.allocate('dexterity', 1);
  assert.equal(hero.statPoints, 7);
  assert.notDeepEqual(hero.panel, base);
  hero.resetAttributes();
  assert.equal(hero.statPoints, 10);
  assert.deepEqual(hero.allocated, ZERO());
  assert.deepEqual(hero.panel, base);
  setHeroState(hero, 3);
  assert.equal(hero.statPoints, 10);
});

/* ------------------------------------------------------------------ */
/* 边界：空手、无装备、未知词条、异常装备引用                          */
/* ------------------------------------------------------------------ */

test('empty loadouts, zero modifiers, unknown modifiers and undefined main hand are inert', () => {
  const empty = calculateCharacter(ZERO_STATS, items, ZERO_CLASS, 1, ZERO(), {});
  const undefinedMain = calculateCharacter(ZERO_STATS, items, ZERO_CLASS, 1, ZERO(), { 'main-hand': undefined });
  assert.deepEqual(empty, undefinedMain);
  assert.equal(empty.physicalAttack, 0);
  assert.equal(empty.magicAttack, 0);
  assert.equal(empty.defense, 0);
  assert.equal(empty.baseDefense, 0);
  assert.equal(empty.magicResistance, 0);
  assert.equal(empty.baseMagicResistance, 0);
  assert.equal(empty.hitRate, 655);
  assert.equal(empty.evasionRate, 166);

  const ringId = 'inert-ring';
  const fixture = fixtureStats(ZERO(), { [ringId]: zeroEquipmentNumbers({}) });
  const ringItems = makeFixtureItems([fixtureItem(ringId, 'ring', 'ring')]);
  const ring = instance(ringId, { modifiers: [zeroModifier('strength', 0), zeroModifier('luck', 999)] });
  assert.deepEqual(calculateCharacter(fixture, ringItems, 'fixture-hero', 1, ZERO(), { ring }), empty,
    'unknown and zero modifiers do not secretly change another field');

  const bareWeapon: ItemInstance = { id: 'bare-dagger', item: 'dagger', quantity: 1, enhancement: 0, gems: [] };
  const barePanel = calculateCharacter(catalog, items, 'dark-knight', 1, ZERO(), { 'main-hand': bareWeapon });
  assert.deepEqual(barePanel, expectedPanel(catalog, items, 'dark-knight', 1, ZERO(), { 'main-hand': bareWeapon }),
    'equipment without instance numbers falls back to the definition');
  assert.equal(barePanel.magicAttack, Math.trunc(9 * 1000 / 1000) + Math.trunc(5 * 1000 / 1000),
    'missing instance numbers means no rolled weapon magic; only the dagger attribute rows remain');
});

test('negative primary attributes and negative attack rates reach the zero floor', () => {
  const staffId = 'negative-staff';
  const staffFixture = fixtureStats(ZERO(), { [staffId]: zeroEquipmentNumbers({ magicPercent: [100, 100] }) });
  const staffItems = makeFixtureItems([fixtureItem(staffId, 'staff', 'main-hand')]);
  const staff = instance(staffId, { magicPercent: 100 });
  for (const stat of PRIMARY_STATS) {
    const allocated: PrimaryAttributes = { ...ZERO(), [stat]: -10 };
    const equipped: Loadout = { 'main-hand': staff };
    const panel = calculateCharacter(staffFixture, staffItems, 'fixture-hero', 1, allocated, equipped);
    assert.deepEqual(panel, expectedPanel(staffFixture, staffItems, 'fixture-hero', 1, allocated, equipped), stat);
    assert.equal(panel.attributes[stat], -10, stat);
    if (stat === 'strength' || stat === 'dexterity') {
      assert.equal(panel.physicalAttack, 0, `${stat} cannot push physical attack below zero`);
    } else if (stat === 'vitality') {
      assert.equal(panel.baseDefense, -10);
      assert.equal(panel.defense, 0, 'negative vitality cannot create negative effective defense');
      assert.equal(panel.physicalResistance, 0);
    } else {
      assert.equal(panel.magicAttack, 0, `${stat} cannot push magic attack below zero`);
    }
  }

  const weaponId = 'negative-rate-weapon';
  const ringId = 'negative-rate-ring';
  const rateFixture = fixtureStats(ZERO(), {
    [weaponId]: zeroEquipmentNumbers({ attack: 100, magicPercent: [100, 100] }),
    [ringId]: zeroEquipmentNumbers({}),
  });
  const rateItems = makeFixtureItems([
    fixtureItem(weaponId, 'longsword', 'main-hand'),
    fixtureItem(ringId, 'ring', 'ring'),
  ]);
  const weapon = instance(weaponId, { magicPercent: 100 });
  const physicalPenalty: Loadout = {
    'main-hand': weapon,
    ring: instance(ringId, { modifiers: [zeroModifier('physicalAttackRate', -2000)] }),
  };
  const physicalPanel = calculateCharacter(rateFixture, rateItems, 'fixture-hero', 1, ZERO(), physicalPenalty);
  assert.equal(physicalPanel.physicalAttack, 0);
  assert.equal(physicalPanel.magicAttack, 100);
  assert.deepEqual(physicalPanel, expectedPanel(rateFixture, rateItems, 'fixture-hero', 1, ZERO(), physicalPenalty));

  const magicPenalty: Loadout = {
    'main-hand': weapon,
    ring: instance(ringId, { modifiers: [zeroModifier('magicAttackRate', -2000)] }),
  };
  const magicPanel = calculateCharacter(rateFixture, rateItems, 'fixture-hero', 1, ZERO(), magicPenalty);
  assert.equal(magicPanel.physicalAttack, 100);
  assert.equal(magicPanel.magicAttack, 0);
  assert.deepEqual(magicPanel, expectedPanel(rateFixture, rateItems, 'fixture-hero', 1, ZERO(), magicPenalty));
});

test('missing classes and missing equipment definitions fail loudly', () => {
  assert.throws(() => calculateCharacter(catalog, items, 'missing-class', 1, ZERO(), {}), /职业数值不存在/);
  assert.throws(() => calculateCharacter(catalog, items, 'dark-knight', 1, ZERO(), {
    'main-hand': { ...instance('missing-item'), item: 'missing-item' },
  }), /装备数值不存在/);
});

test('an undefined equipment instance in a slot is skipped rather than treated as a weapon', () => {
  const panel = calculateCharacter(ZERO_STATS, items, ZERO_CLASS, 1, ZERO(), { 'main-hand': undefined, 'off-hand': undefined });
  assert.equal(panel.offhandShield, false);
  assert.equal(panel.physicalAttack, 0);
  assert.equal(panel.shieldBlock, 0);
});

test('previewGemPanel applies the hand rules when the previewed item occupies an empty hand', () => {
  const hero = new BattleCharacter('dark-knight', catalog, items);
  hero.addExperience(Number.MAX_SAFE_INTEGER);
  const twoHandedId = Object.keys(items.items).find(id => {
    const equipment = items.items[id].equipment;
    return equipment?.twoHanded && equipment.classes.includes('dark-knight') && !equipment.locked && catalog.equipment[id];
  })!;
  const shieldId = Object.keys(items.items).find(id => {
    const equipment = items.items[id].equipment;
    return equipment?.slot === 'off-hand' && equipment.classes.includes('dark-knight') && !equipment.locked;
  })!;
  hero.bag.add(shieldId);
  hero.bag.equip(hero.bag.entries.find(entry => entry.item === shieldId)!.id, 'off-hand');
  hero.bag.add(twoHandedId);
  const twoHanded = hero.bag.entries.find(entry => entry.item === twoHandedId)!;
  const preview = previewGemPanel({
    catalog, items, classId: hero.classId, level: hero.level, allocated: hero.allocated,
    equipped: hero.bag.equipment, bag: hero.bag, targetId: twoHanded.id, gemModifiers: [], emptySlot: 'main-hand',
  });
  assert.ok(preview);
  assert.equal(preview.offhandShield, false, '装上双手武器后盾牌会被卸下，预览也要按没有盾计算');
  assert.equal(preview.shieldBlock, 0);
});
