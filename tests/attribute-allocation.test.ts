import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BattleCharacter, type PrimaryAttributes } from '../src/domain/character-stats.ts';
import { AttributeAllocation } from '../src/domain/attribute-allocation.ts';
import { Session } from '../src/domain/session.ts';
import { characterCombatValues } from '../src/ui/character-values.ts';
import { parseBattle, parseCampaign, parseCharacterStats, parseCompanions, parseItemCatalog } from '../src/application/content-validation.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const stats = parseCharacterStats(read('character-stats')), items = parseItemCatalog(read('items'));
const battle = parseBattle(read('battle')), campaign = parseCampaign(read('campaign')), companions = parseCompanions(read('companions'));
const zero: PrimaryAttributes = { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 };
function start(classId = 'dark-knight') {
  const hero = new BattleCharacter(classId, stats, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle, stats, companions);
  return { hero, session };
}

test('six classes expose earned and spent level points through the live session', () => {
  for (const character of battle.classes) {
    const { hero, session } = start(character.id);
    const changes: number[][] = [];
    session.subscribe(() => changes.push([session.player!.level, hero.statPoints, session.skills.points()]));
    session.party!.addExperience(hero.player.nextLevelExperience);
    assert.deepEqual(changes.at(-1), [2, 3, 1]);
    hero.commitAllocation({ ...zero, vitality: 1 });
    hero.spendSkillPoints(1);
    session.party!.addExperience(stats.experience[1]! + stats.experience[2]!);
    assert.deepEqual(changes.at(-1), [4, 8, 2]);
    session.party!.addExperience(Number.MAX_SAFE_INTEGER);
    assert.deepEqual(changes.at(-1), [105, 311, 103]);
    const count = changes.length;
    session.party!.addExperience(100);
    assert.deepEqual([hero.statPoints, session.skills.points()], [311, 103]);
    // Party notifications may still occur, but cannot award more points.
    assert(changes.slice(count).every(value => value.join() === '105,311,103'));
  }
});

test('allocation previews include equipment, undo only pending points, and cancel without changing the hero', () => {
  const { hero } = start();
  hero.addExperience(hero.player.nextLevelExperience);
  hero.commitAllocation({ ...zero, strength: 1 });
  const before = hero.panel, balance = hero.statPoints, draft = new AttributeAllocation(hero);
  let notifications = 0;
  hero.subscribe(() => notifications++);
  assert.throws(() => draft.change('strength', -1), /待确认/);
  draft.change('strength', 1);draft.change('vitality', 1);
  assert.equal(draft.remainingPoints, 0);
  assert.throws(() => draft.change('intelligence', 1), /能力点/);
  assert.equal(draft.attributes.strength, before.attributes.strength + 1);
  assert.equal(draft.attributes.vitality, before.attributes.vitality + 1);
  assert.deepEqual(hero.panel, before);
  const leaked = draft.pending;leaked.strength = 99;
  assert.equal(draft.pending.strength, 1);
  draft.change('strength', -1);
  assert.equal(draft.remainingPoints, 1);
  draft.cancel();
  assert.equal(draft.hasChanges, false);
  assert.equal(draft.remainingPoints, balance);
  assert.deepEqual(draft.attributes, before.attributes);
  assert.equal(notifications, 0);
  assert.deepEqual(new AttributeAllocation(hero).pending, zero);
});

test('confirmation commits once, publishes a complete panel, and later visits cannot undo committed points', () => {
  const { hero, session } = start();
  hero.addExperience(hero.player.nextLevelExperience);
  const draft = new AttributeAllocation(hero), before = hero.panel;
  draft.change('strength', 1);draft.change('vitality', 1);draft.change('dexterity', 1);
  const observations: { points: number; attributes: PrimaryAttributes; values: string[] }[] = [];
  session.subscribe(() => {
    observations.push({ points: hero.statPoints, attributes: hero.panel.attributes, values: characterCombatValues(hero.panel) });
    draft.commit(); // A listener cannot repeat the same pending allocation.
  });
  draft.commit();draft.commit();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].points, 0);
  assert.equal(observations[0].attributes.strength, before.attributes.strength + 1);
  assert.equal(observations[0].attributes.vitality, before.attributes.vitality + 1);
  assert.equal(observations[0].attributes.dexterity, before.attributes.dexterity + 1);
  assert.equal(observations[0].values[0], String(hero.panel.physicalAttack));
  assert.equal(observations[0].values[5], String(hero.panel.defense));
  assert.equal(hero.panel.maxHealth, before.maxHealth + 80);
  assert.throws(() => new AttributeAllocation(hero).change('strength', -1), /待确认/);
});

test('invalid or unaffordable allocation is rejected before any attribute or balance changes', () => {
  const { hero } = start();hero.addExperience(hero.player.nextLevelExperience);
  const before = hero.panel;
  for (const delta of [{ ...zero, strength: -1 }, { ...zero, vitality: 0.5 }, { ...zero, mentality: NaN },
    { ...zero, intelligence: Infinity }, { ...zero, strength: 4 }, { strength: 1 }, { ...zero, extra: 1 }]) {
    assert.throws(() => hero.commitAllocation(delta as PrimaryAttributes));
    assert.equal(hero.statPoints, 3);assert.deepEqual(hero.panel, before);
  }
  const draft = new AttributeAllocation(hero);draft.change('vitality', 1);
  hero.commitAllocation({ ...zero, strength: 3 });
  assert.throws(() => draft.commit(), /能力点/);
  assert.equal(draft.pending.vitality, 1);
  assert.equal(hero.allocated.vitality, 0);
  draft.cancel();
});

test('character combat rows retain native order and percentage units', () => {
  const { hero } = start(), panel = hero.panel;
  assert.deepEqual(characterCombatValues({ ...panel, physicalAttack: 123, magicAttack: 45, criticalRate: 67,
    hitRate: 890, criticalDamage: 1234, defense: 567, physicalResistance: 111, magicResistance: 222,
    evasionRate: 333, weaponBlock: 444, shieldBlock: 555 }),
  ['123', '45', '6.7%', '89.0%', '123.4%', '567', '11.1%', '22.2%', '33.3%', '44.4%', '55.5%']);
});
