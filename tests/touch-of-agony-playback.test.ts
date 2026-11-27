import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type Phaser from 'phaser';
import { skillForGrowth, type SkillGrowthProfile } from '../src/domain/battle.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { CombatCooldownStore } from '../src/domain/combat-cooldowns.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import { CombatController, type ActionPlayback, type Combatant, type CombatPort } from '../src/domain/combat.ts';
import { Session } from '../src/domain/session.ts';
import { characterFrameList } from '../src/rendering/character-atlas.ts';
import type { CharacterVisual } from '../src/rendering/characters.ts';
import { dispatchFrame, playCombat } from './support/combat-driver.ts';
import {
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import { createTestWorldCombat, installPhaserStubHooks } from './support/world-combat-fixture.ts';
import { FakeSprite } from './support/fake-sprite.ts';

const phaserHook = installPhaserStubHooks();
const { CombatPresenter } = await import('../src/rendering/combat-presenter.ts');
phaserHook.deregister();

const catalog = loadBattleCatalog();
const warlock = catalog.classes.find(character => character.id === 'warlock')!;
/** 动作序列里的逻辑帧号 → 当前图集帧名。 */
const attackClip = warlock.actor.clips['skill-touch-of-agony-east']!;
const logicalFrame = (index: number) => characterFrameList(attackClip.layers[0]!.file, attackClip.frames)[index]!.frame;
type Frame = { index: number; frame: number };

test('生产生命查询区分伤害链中尚未移除的零生命角色，主角佣兵敌人均读取即时 HP', async () => {
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, catalog, statsCatalog, companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally = session.party!.recruit(session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
  session.party!.deployFirstAvailable(ally.id);
  const actorDef = catalog.classes.find(c => c.id === 'dark-knight')!.actor;
  const world = await createTestWorldCombat({
    hero,
    session,
    appOverrides: {
      world: { actors: { [ally.definition.actor]: actorDef, [actorDef.id]: actorDef } } as never,
    },
  });
  const enemyDef = catalog.enemies.find(entry => entry.id === 'enemy-shin-1')!;
  const enemy = world.roster.placeEnemy(enemyDef.id, 96, 64);
  await world.combat.start();
  hero.setHealth(10);
  ally.setHealth(10);
  world.roster.setEnemyHealth(enemy.key, 10, enemyDef);

  const resolution = Reflect.get(world.combat, 'hitResolution') as CombatHitResolution;
  const alive = (id: string) => (Reflect.get(world.combat, 'isActorAlive') as (actorId: string) => boolean).call(world.combat, id);
  const setZero = (id: string) => {
    if (id === 'player') hero.setHealth(0);
    else if (id === ally.id) ally.setHealth(0);
    else world.roster.setEnemyHealth(id, 0, enemyDef);
  };

  for (const id of ['player', ally.id, enemy.key]) {
    assert.equal(alive(id), true);
    resolution.run(() => {
      setZero(id);
      resolution.deferDefeat(id, () => {});
      assert.equal(resolution.isAwaitingDefeat(id), true);
      assert.equal(alive(id), false);
    });
  }
  assert.equal(alive('missing'), false);
  world.combat.destroy();
});

class Sprite extends FakeSprite {
  anims = {
    currentAnim: { frames: [] as Frame[] }, currentFrame: { index: 1, frame: 0 },
    create: (definition: { frames: { frame: number }[] }) => {
      this.anims.currentAnim = { frames: definition.frames.map((frame, index) => ({ ...frame, index: index + 1 })) };
      return { ...this.anims.currentAnim, destroy() {} };
    },
    setCurrentFrame: (frame: Frame) => {
      this.anims.currentFrame = frame;
      this.emit('animationupdate', this.anims.currentAnim, frame);
    },
    stop: () => {},
  };
  override play() { this.anims.currentFrame = this.anims.currentAnim.frames[0]; return this; }
  step() {
    const next = this.anims.currentAnim.frames[this.anims.currentFrame.index];
    if (next) this.anims.setCurrentFrame(next);
    else this.emit('animationcomplete');
  }
}

function fixture(level = 8, growth: SkillGrowthProfile = 'hero', killOnHit?: number) {
  const skill = skillForGrowth(catalog.skills['touch-of-agony'], growth);
  const action = structuredClone(skill.action!);
  assert.equal(action.repeat!.requiresLivingTarget, true);
  const caster: Combatant = { id: 'caster', team: 'party', position: { x: 0, y: 0 }, bounds: { x: -8, y: -8, width: 16, height: 16 } };
  const target: Combatant = { ...caster, id: 'target', team: 'enemy', position: { x: 24, y: 0 } };
  const actors = new Map([caster, target].map(actor => [actor.id, actor]));
  const resolution = new CombatHitResolution();
  let targetHealth = 100;
  const character = {
    actor: warlock.actor, entity: { id: 'caster', actor: warlock.actor.id }, layers: [], clipName: null,
    container: { active: true, x: 0, y: 0, addAt: () => {} },
  } as unknown as CharacterVisual;
  const timers: { delay: number; callback: () => void; removed: boolean; remove: () => void }[] = [];
  const scene = {
    events: new EventEmitter(), add: { sprite: () => new Sprite() },
    time: {
      delayedCall: (delay: number, callback: () => void) => {
        const timer = { delay, callback, removed: false, remove() { this.removed = true; } };
        timers.push(timer);
        return timer;
      },
    },
  } as unknown as Phaser.Scene;
  const presenter = new CombatPresenter(scene, catalog, () => character, () => [...actors.values()]);
  let elapsed = 0, hits = 0, completed = 0, mana = 100, cancelOnHit = false;
  let playback!: ActionPlayback;
  const effects: { frame: number; effect: string }[] = [], dispatches: number[] = [];
  Reflect.set(presenter, 'pose', () => {});
  Reflect.set(presenter, 'visualEffect', (visual: { effect: string }) => effects.push({ frame: elapsed, effect: visual.effect }));
  const port: CombatPort = {
    cooldowns: new CombatCooldownStore(() => 0).forActor(caster.id),
    actor: id => actors.get(id), candidates: () => [...actors.values()], facing: () => 'east',
    isAlive: id => id !== target.id || targetHealth > 0,
    moveToward: () => {}, stop: () => {}, canStand: () => true, relocate: () => {}, clearEffects: () => {},
    canSpendMana: cost => mana >= cost, spendMana: cost => { mana -= cost; return true; },
    play: (current, onFrame, onComplete) => {
      playback = current;
      return playCombat(presenter, current, onFrame, () => { completed++; onComplete(); });
    },
    frame: (current, index, contact, ready) => resolution.run(() => dispatchFrame(presenter, current, index, contact, ready, () => {}, (_definition, work) => {
      dispatches.push(elapsed); resolution.run(work);
    })),
    runUnitSequence: work => resolution.run(work),
    unit: hit => {
      if (hit.cueIndex === 2) {
        hits++;
        if (killOnHit === hits) {
          targetHealth = 0;
          resolution.deferDefeat(target.id, () => actors.delete(target.id));
          assert.equal(actors.has(target.id), true, '致死单位结束时角色尚在场');
          assert.equal(resolution.isAwaitingDefeat(target.id), true);
        }
        if (cancelOnHit) combat.cancel();
      }
      return 'success';
    },
  };
  const combat = new CombatController(caster.id, null, port);
  assert.equal(combat.request({ id: skill.id, action, level, manaCost: 40 }, target.id), 'started');
  const sprite = character.layers[0] as unknown as Sprite;
  return {
    combat, playback, effects, dispatches, timers, sprite,
    advance: (frames: number) => { for (let index = 0; index < frames; index++) { elapsed++; sprite.step(); } },
    removeTarget: () => { actors.delete(target.id); combat.update(); },
    cancelOnNextHit: () => { cancelOnHit = true; },
    elapsed: () => elapsed, hits: () => hits, completed: () => completed, mana: () => mana,
  };
}

test('痛苦之击首击或中间击杀后接当前片段余帧，按原帧数结束', () => {
  for (const fatalHit of [1, 3, 7]) {
    const run = fixture(8, 'hero', fatalHit);
    run.advance(fatalHit * 3);
    assert.equal(run.hits(), fatalHit);
    assert.equal(run.sprite.anims.currentFrame.frame, logicalFrame(3));
    assert.equal(run.playback.repeatState?.stoppedAtFrame, fatalHit * 3);
    // 每轮循环开头都会播放 petal-ring；击杀发生在第 n 轮末帧时，同一帧也是下一轮的开头。
    assert.equal(run.effects.filter(effect => effect.effect === 'petal-ring').length, fatalHit + 1);
    assert.equal(run.combat.snapshot().state, 'attacking');
    run.advance(5);
    assert.equal(run.sprite.anims.currentFrame.frame, logicalFrame(8));
    assert.equal(run.completed(), 0);
    run.advance(1);
    assert.equal(run.completed(), 1);
    assert.equal(run.elapsed(), (fatalHit - 1) * 3 + 9);
    assert.equal(run.hits(), fatalHit);
    assert.equal(run.dispatches.length, fatalHit);
    assert.equal(run.mana(), 60);
    assert.equal(run.combat.snapshot().state, 'idle');
    assert.equal(run.timers[0].removed, true);
  }
});

test('两击之间目标离场，在下一执行帧停止归零并完成当前片段', () => {
  const run = fixture();
  run.advance(4); assert.equal(run.hits(), 1);
  run.removeTarget(); run.advance(2);
  assert.equal(run.playback.repeatState?.stoppedAtFrame, 6);
  assert.equal(run.sprite.anims.currentFrame.frame, logicalFrame(3));
  run.advance(5); assert.equal(run.completed(), 0);
  run.advance(1); assert.equal(run.elapsed(), 12); assert.equal(run.completed(), 1);
  assert.equal(run.hits(), 1);
  assert.deepEqual(run.dispatches, [3, 6]);
});

test('主角和佣兵八级正常打满时保留最后归零后的完整九帧尾部', () => {
  const counts: Record<SkillGrowthProfile, number[]> = {
    hero: [3, 4, 5, 6, 6, 7, 7, 7], companion: [3, 4, 5, 5, 6, 6, 6, 7],
  };
  for (const growth of ['hero', 'companion'] as const) for (let level = 1; level <= 8; level++) {
    const run = fixture(level, growth), count = counts[growth][level - 1];
    run.advance(count * 3);
    assert.equal(run.hits(), count, `${growth}:${level}`);
    assert.equal(run.sprite.anims.currentFrame.frame, logicalFrame(0));
    assert.equal(run.effects.filter(effect => effect.effect === 'petal-ring').length, count + 1);
    run.advance(8); assert.equal(run.completed(), 0);
    run.advance(1); assert.equal(run.completed(), 1);
    assert.equal(run.elapsed(), count * 3 + 9);
    assert.equal(run.playback.repeatState?.stoppedAtFrame, undefined);
    assert.equal(run.hits(), count);
  }
});

test('痛苦之击被取消时移除重播回调，旧动画和兜底计时器不再完成动作', () => {
  const run = fixture();
  run.cancelOnNextHit(); run.advance(3);
  assert.equal(run.hits(), 1);
  assert.equal(run.combat.snapshot().state, 'idle');
  run.advance(30);
  for (const timer of run.timers) timer.callback();
  assert.equal(run.hits(), 1); assert.equal(run.completed(), 0);
  assert.equal(run.sprite.listenerCount('animationupdate'), 0);
  assert.ok(run.timers.every(timer => timer.removed));
});
