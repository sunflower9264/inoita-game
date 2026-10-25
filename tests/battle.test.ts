import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { SkillConfiguration } from '../src/domain/skill-configuration.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { ClipName } from '../src/domain/content.ts';
import { needsTarget, skillEffectNames, skillEvents } from '../src/domain/skill-action.ts';
import { parseBattle } from '../src/application/content-validation.ts';
const publicRoot = new URL('../public/', import.meta.url);
const catalog: BattleCatalog = JSON.parse(readFileSync(new URL('content/battle.json', publicRoot), 'utf8'));

test('six complete classes, legal ranks, original assets and independent actor animations', () => {
  assert.equal(catalog.classes.length, 6); assert.equal(Object.keys(catalog.skills).length, 90);
  const allSkills = catalog.classes.flatMap(c => c.skills);
  assert.equal(new Set(allSkills).size, 90);
  for (const character of catalog.classes) {
    assert.equal(character.skills.length, 15);
    assert.equal(character.skills.filter(id => catalog.skills[id].kind === 'active').length, 9);
    assert.ok(character.description); assert.ok(existsSync(new URL(character.preview, publicRoot)));
    const active = character.skills.filter(id => catalog.skills[id].kind === 'active');
    assert.ok(character.actor.collision);
    // 站立、行走、普攻各四向，再加每个主动技能的四个朝向。
    assert.equal(Object.keys(character.actor.clips).length, 12 + active.length * 4);
    for (const clip of Object.values(character.actor.clips)) {
      assert.ok(clip);
      assert.equal(clip.frameRate, 1000 / 60);
      for (const layer of clip.layers) assert.ok(existsSync(new URL(layer.file, publicRoot)));
    }
    for (const id of character.skills) {
      const skill = catalog.skills[id]; assert.ok(skill.name && skill.description); assert.ok(existsSync(new URL(skill.icon, publicRoot)));
      assert.deepEqual(skill.ranks.map(r => r.level), [1,2,3,4,5,6,7,8]);
      for (const rank of skill.ranks) {
        assert.ok(rank.details!.length > 0);
        for (const field of rank.details!) assert.ok(field.label && field.value && !/%[a-z]|NaN|undefined|\$[RGB]/.test(field.value));
        assert.equal(rank.details!.some(d => d.label === '冷却时间'), skill.kind === 'active');
      }
    }
  }
});

test('every active skill carries its action timeline, effect assets and target rule', () => {
  const facings = ['south','west','north','east'] as const;
  let selfOnly = 0, targeted = 0;
  for (const character of catalog.classes) {
    for (const id of character.skills) {
      const skill = catalog.skills[id], action = skill.action;
      if (skill.kind === 'passive') { assert.equal(action, null, id); continue; }
      assert.ok(action, id);
      const frameCount = character.actor.clips[`skill-${id}-south`]!.frames;
      if (action.transition?.kind === 'trace') assert.ok(action.transition.effect, id);
      // skillEffectNames 已经包含过渡本身的两个特效，这里只补动作单元引用的。
      const names = skillEffectNames(action);
      assert.ok(action.cooldownFrames > 0 && action.approachDistanceUnits >= 0 && action.searchRadiusPx >= action.approachDistanceUnits * 8);
      // 事件按帧号升序，且至少有一个执行动作单元的事件落在动作时长内。
      const unitFrames = action.events.filter(event => event.kind === 'units').map(event => event.frame);
      assert.ok(unitFrames.length > 0, id);
      assert.deepEqual(action.events.map(event => event.frame), [...action.events.map(event => event.frame)].sort((a,b)=>a-b), id);
      assert.ok(unitFrames.every(frame => frame >= 0 && frame < frameCount), `${id}: ${unitFrames}`);
      for (const facing of facings) {
        const clip = character.actor.clips[`skill-${id}-${facing}` as ClipName];
        assert.ok(clip, `${id}/${facing}`);
        assert.equal(clip.frames, frameCount, `${id}/${facing}`);  // 末帧停留已展开
        for (const layer of clip.layers) assert.ok(existsSync(new URL(layer.file, publicRoot)), layer.file);
      }
      // 挥击槽按朝向取变体，飞行的投射物按十六向取变体，其余只有一版。
      const flight = action.transition?.kind === 'trace' ? action.transition.effect : null;
      for (const name of names) {
        const effect = catalog.attackEffects[name];
        assert.ok(effect, `${id}: ${name}`);
        // 挥击槽按朝向取变体；跟随施法者的那一版也要有方向变体。
        const swung = action.events.some(event => event.kind === 'swing' && event.effects.some(visual => visual.effect === name));
        const wanted = swung ? facings
          : name === flight ? ['heading-0','heading-90','heading-180','heading-270'] : ['default'];
        assert.ok(wanted.every(variant => effect.clips[variant]), `${id}: ${name}`);
        for (const clip of Object.values(effect.clips))
          for (const layer of clip.layers) assert.ok(existsSync(new URL(layer.file, publicRoot)), layer.file);
      }
      // 每一个事件都必须真的能被某一帧触发，否则动画播完也不会有效果。
      const fired = new Set<number>();
      for (let frame = 0; frame < frameCount; frame++)
        for (const event of skillEvents(action, frame)) fired.add(event.frame);
      const wanted = [...new Set(action.events.map(event => event.frame))].sort((a,b)=>a-b);
      assert.deepEqual([...fired].sort((a,b)=>a-b), wanted, id);
      needsTarget(action) ? targeted++ : selfOnly++;
    }
  }
  assert.equal(targeted + selfOnly, 54);
  assert.ok(selfOnly > 0 && targeted > 0, `self ${selfOnly} targeted ${targeted}`);
});

test('专有流程的逐帧生成与全屏填充按原版参数进内容，且能被校验器接受', () => {
  // 地狱火召唤：每个逻辑帧在屏幕范围内生成一次火焰，一直生成到动作结束。
  const hellfire = catalog.skills['summon-hellfire'].action!;
  const spawn = hellfire.events.find(event => event.kind === 'spawn');
  assert.ok(spawn && spawn.kind === 'spawn');
  const hellfireFrames = catalog.classes.find(c => c.skills.includes('summon-hellfire'))!.actor.clips['skill-summon-hellfire-south']!.frames;
  assert.equal(spawn.frame, 0); assert.equal(spawn.until, hellfireFrames);
  assert.equal(spawn.effect, 'hellfire-burst'); assert.equal(spawn.marginPx, 16);
  // 耀眼的闪光：帧 1..4 全屏填充透明度 80/60/40/20，帧 8 复位。
  const flash = catalog.skills['blinding-flash'].action!;
  const keyframes = flash.events.filter(event => event.kind === 'screen').map(event => [event.frame, event.fillTransparency]);
  assert.deepEqual(keyframes, [[1,80],[2,60],[3,40],[4,20],[8,100]]);
  // 结束帧越界与透明度越界都要被拒绝。
  const late = structuredClone(catalog);
  (late.skills['summon-hellfire'].action!.events.find(e => e.kind === 'spawn') as { until: number }).until = 10000;
  assert.throws(() => parseBattle(late), /触发帧/, '生成区间超出动作时长');
  const opaque = structuredClone(catalog);
  (opaque.skills['blinding-flash'].action!.events.find(e => e.kind === 'screen') as { fillTransparency: number }).fillTransparency = 200;
  assert.throws(() => parseBattle(opaque), /透明度/);
});

test('draft and save isolate classes; levels can only change through learning', () => {
  const config = new SkillConfiguration(), [knight,assassin] = catalog.classes;
  const draft = config.draft(catalog, knight.id);
  assert.deepEqual(Object.keys(draft.levels).sort(), [...knight.skills].sort());
  assert.ok(Object.values(draft.levels).every(level => level === 1));
  config.save(catalog,knight.id,draft);
  assert.equal(config.draft(catalog,assassin.id).levels[knight.skills[0]],undefined,'职业之间互不串号');
  const forged = config.draft(catalog,knight.id);
  forged.levels[knight.skills[0]] = 9;
  assert.throws(() => config.save(catalog,knight.id,forged), /只能通过学习/);
  const foreign = config.draft(catalog,knight.id);
  foreign.levels[assassin.skills[0]] = 1;
  assert.throws(() => config.save(catalog,knight.id,foreign), /只能通过学习/);
});

test('learned active skills drive the default quick bar and the group page', () => {
  const config = new SkillConfiguration(), [knight, assassin] = catalog.classes;
  const active = knight.skills.filter(id => catalog.skills[id].kind === 'active');
  assert.deepEqual(config.activeSkills(catalog, knight.id), active, '默认全学会，按职业表次序');
  assert.equal(config.shortcutPage(knight.id), 0);
  assert.equal(config.nextShortcutPage(knight.id), 1);
  assert.equal(config.shortcutPage(assassin.id), 0, '组号按职业各记一份');
  config.nextShortcutPage(knight.id);
  assert.equal(config.shortcutPage(knight.id), 0);
});

test('complete enemy catalog preserves variants and shares valid animation resources', () => {
  assert.equal(catalog.enemies.length, 553);
  assert.equal(new Set(catalog.enemies.map(e => e.id)).size, 553);
  assert.ok(new Set(catalog.enemies.map(e => e.actor.id)).size < catalog.enemies.length);
  const labels = new Set<string>();
  for (const enemy of catalog.enemies) {
    const label = `${enemy.name} ${enemy.variant}`;
    assert.ok(!labels.has(label), label); labels.add(label);
    const clip = enemy.actor.clips['idle-south']!;
    assert.ok(clip.frames > 0 && Number.isInteger(clip.frames));
    assert.equal(clip.frameRate, 1000 / 60);
    assert.ok(clip.layers.length > 0);
    for (const layer of clip.layers) assert.ok(existsSync(new URL(layer.file, publicRoot)));
    assert.ok(enemy.actor.collision!.width > 0 && enemy.actor.collision!.height > 0);
  }
});
