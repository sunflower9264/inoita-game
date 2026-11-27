import assert from 'node:assert/strict';
import test from 'node:test';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import type { PhysicalHit } from '../src/domain/physical-hit.ts';
import {
  createCombatTestHarness,
  loadBattleCatalog,
  loadCharacterStatsCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const items = loadItemCatalog();
const stats = loadCharacterStatsCatalog();

function fixture() {
  const hero = new BattleCharacter('warrior', stats, items);
  const ally = new BattleCharacter('warrior', stats, items);
  let rank = 1;
  let allyRank = 8;
  let rankVersion = 0;
  let allyRankVersion = 0;
  // 技能配置的版本随等级变化，和正式 SkillConfiguration 一样让被动与反应缓存失效。
  const configuration = (value: () => number, version: () => number) => ({
    get version() {
      return version();
    },
    resetVersion: 0,
    draft: () => ({ levels: { 'soul-s-thirst': value(), 'blood-thirst': 1 } }),
  });
  Object.assign(ally, { skills: configuration(() => allyRank, () => allyRankVersion) });
  const conditions = new CombatConditions();
  const order: string[] = [];
  const presenter = {
    showEffects: (_id: string, entries: readonly { effect: string }[]) => {
      for (const entry of entries) order.push(entry.effect);
    },
  };
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    characterStats: stats,
    items,
    conditions,
    hitResolution: new CombatHitResolution(),
    hero,
    members: new Map([
      ['player', hero],
      ['ally', ally],
    ]),
    sessionSkills: () => configuration(() => rank, () => rankVersion) as never,
    party: () => ({ groupModifiers: () => ({}), groupModifierVersion: 0 }) as never,
    activeParty: () => ['player', 'ally'],
    settlementOverrides: {
      onShowEffects: (_actorId, targetId, entries) => presenter.showEffects(targetId, entries),
    },
  });
  harness.settlement.attackProc = () => {};
  const cast = (id = 'player') => {
    const unit = catalog.skills['blood-thirst'].action!.combatUnits![0];
    assert.equal(unit.effect, 'buff');
    if (unit.effect !== 'buff') throw new Error('missing Blood Thirst parent');
    conditions.applyBuff(id, unit.buff, unit.ranks[0].strength, unit.ranks[0].effect);
  };
  const contact = (id = 'player', kind: PhysicalHit['kind'] = 'hit', damageKind: 'physical' | 'magic' = 'physical', damage = 101) =>
    harness.settlement.resolveHitReactions(
      { casterId: id, targetId: id === 'player' ? 'ally' : 'player' },
      { kind, damage },
      damageKind,
      'basic-attack',
    );
  const reset = () => {
    hero.setHealth(1);
    hero.setMana(0);
    ally.setHealth(1);
    ally.setMana(0);
    order.length = 0;
  };
  reset();
  return {
    harness,
    hero,
    ally,
    conditions,
    order,
    presenter,
    cast,
    contact,
    reset,
    learn: (value: number) => {
      rank = value;
      rankVersion++;
    },
    learnAlly: (value: number) => {
      allyRank = value;
      allyRankVersion++;
    },
  };
}

const chances = [50, 70, 90, 120, 130, 140, 150, 160];
const mana = [7, 9, 11, 14, 15, 16, 17, 18];

test('all learned Soul’s Thirst ranks feed real party attributes but alone never roll or recover resources', t => {
  const f = fixture();
  let rolls = 0;
  t.mock.method(Math, 'random', () => {
    rolls++;
    return 0;
  });
  for (let index = 0; index < 8; index++) {
    f.learn(index + 1);
    assert.equal(f.harness.stats.actorAttribute('player', 'bloodThirstChance'), chances[index]);
    assert.equal(f.harness.stats.actorAttribute('player', 'bloodThirstManaRecovery'), mana[index]);
    f.contact();
    assert.equal(f.hero.player.health, 1);
    assert.equal(f.hero.player.mana, 0);
  }
  // 灵魂之渴望本身不抽签；物理命中只消耗残影那一次无条件抽签。
  assert.equal(rolls, 8);
  assert.equal(f.order.length, 0);
});

test('each learned rank augments one shared strict roll and restores fixed MP independently of captured damage', t => {
  const f = fixture();
  f.cast();
  let roll = 1;
  let rolls = 0;
  t.mock.method(Math, 'random', () => {
    rolls++;
    return (roll - 0.5) / 999;
  });
  for (let index = 0; index < 8; index++) {
    f.learn(index + 1);
    const threshold = 200 + chances[index];
    assert.equal(f.harness.stats.actorAttribute('player', 'bloodThirstChance'), threshold);
    // 一个是本项自己的抽签，另一个是残影的无条件抽签。
    f.reset();
    roll = threshold;
    let before = rolls;
    f.contact();
    assert.equal(rolls, before + 2);
    assert.equal(f.hero.player.health, 1);
    assert.equal(f.hero.player.mana, 0);
    assert.equal(f.order.length, 0);
    roll = threshold - 1;
    before = rolls;
    f.ally.setMana(100);
    f.contact();
    assert.equal(rolls, before + 2);
    assert.equal(f.hero.player.health, 23);
    assert.equal(f.hero.player.mana, mana[index]);
    assert.equal(f.ally.player.mana, 100);
    assert.deepEqual(f.order, ['life-drain', 'mana-recovery']);
    f.reset();
    f.contact('player', 'hit', 'physical', 0);
    assert.equal(f.hero.player.health, 1);
    assert.equal(f.hero.player.mana, mana[index]);
    assert.deepEqual(f.order, ['life-drain', 'mana-recovery']);
  }
});

test('the live learned mana rank is read after the life effect inside the same reaction', t => {
  const f = fixture();
  f.cast();
  t.mock.method(Math, 'random', () => 0);
  f.presenter.showEffects = (_id, entries) => {
    for (const { effect } of entries) {
      f.order.push(`${effect}:${f.hero.player.health}:${f.hero.player.mana}`);
      if (effect === 'life-drain') f.learn(8);
    }
  };
  f.contact();
  assert.deepEqual(f.order, ['life-drain:23:0', 'mana-recovery:23:18']);
  assert.equal(f.hero.player.mana, 18);
});

test('party members retain their own learned rank and parent expiry removes its trigger eligibility', t => {
  const f = fixture();
  f.cast();
  f.cast('ally');
  t.mock.method(Math, 'random', () => 0);
  // 固定恢复公式 b+5：佣兵八级 b=12，故回 17 MP。
  f.contact();
  f.contact('ally');
  assert.equal(f.hero.player.mana, 7);
  assert.equal(f.ally.player.mana, 17);
  f.learnAlly(0);
  f.reset();
  f.contact('ally');
  assert.equal(f.ally.player.health, 23);
  assert.equal(f.ally.player.mana, 0);
  f.conditions.update(152 * 60);
  f.reset();
  f.contact();
  assert.equal(f.hero.player.health, 1);
  assert.equal(f.hero.player.mana, 0);
  assert.equal(f.harness.stats.actorAttribute('player', 'bloodThirstChance'), 50);
});
