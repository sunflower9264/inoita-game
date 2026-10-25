import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { BattleCatalog, SkillAction } from '../src/domain/battle.ts';
import { parseBattle } from '../src/application/content-validation.ts';
import { compileSkillDisplay } from '../src/domain/skill-display.ts';
import { compileSkillAction } from '../src/domain/skill-action-compiler.ts';
import {
  needsTarget, skillEffectNames, skillEvents, skillPlaybackEvents, skillSequence,
  skillSoundNames, skillSummonNames
} from '../src/domain/skill-action.ts';

const source = JSON.parse(fs.readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')) as BattleCatalog;

function allActions(catalog: BattleCatalog): { id: string; action: SkillAction }[] {
  const result: { id: string; action: SkillAction }[] = [];
  for (const [id, skill] of Object.entries(catalog.skills)) {
    if (skill.action) result.push({ id, action: skill.action });
    if (skill.followUpAction) result.push({ id: id + ':follow-up', action: skill.followUpAction });
    if (skill.companion?.action) result.push({ id: id + ':companion', action: skill.companion.action });
    if (skill.companion?.followUpAction) result.push({ id: id + ':companion-follow-up', action: skill.companion.followUpAction });
  }
  for (const enemy of catalog.enemies) {
    for (const [index, skill] of (enemy.skills ?? []).entries()) {
      if ('action' in skill && skill.action) result.push({ id: `${enemy.id}-skill-${index}`, action: skill.action });
      if ('companionAction' in skill && skill.companionAction) result.push({ id: `${enemy.id}-companion-${index}`, action: skill.companionAction });
    }
    if (enemy.commandAction?.action) result.push({ id: `${enemy.id}-command`, action: enemy.commandAction.action });
    if (enemy.commandAction?.companionAction) result.push({ id: `${enemy.id}-command-companion`, action: enemy.commandAction.companionAction });
  }
  return result;
}

function frameLimit(action: SkillAction): number {
  const eventFrames = action.events.map(event => event.kind === 'spawn' ? event.until - 1 : event.frame);
  const repeatFrames = action.repeat ? action.repeat.restartAfterFrame * 8 + Math.max(0, ...eventFrames) : 0;
  return Math.max(0, ...eventFrames, repeatFrames) + 5;
}

test('action IR preserves every derived field and event lookup', () => {
  const actions = allActions(source);
  assert.ok(actions.length > 0);
  let checked = 0;
  for (const { id, action } of actions) {
    const legacy = {
      requiresTarget: needsTarget(action),
      effectNames: skillEffectNames(action),
      soundNames: skillSoundNames(action),
      summonNames: skillSummonNames(action)
    };
    const compiled = compileSkillAction(action);
    assert.equal(compiled.requiresTarget, legacy.requiresTarget, id);
    assert.deepEqual(compiled.effectNames, legacy.effectNames, id);
    assert.deepEqual(compiled.soundNames, legacy.soundNames, id);
    assert.deepEqual(compiled.summonNames, legacy.summonNames, id);
    assert.equal(needsTarget(compiled), legacy.requiresTarget, id);
    const limit = frameLimit(action);
    for (let frame = 0; frame <= limit; frame++) {
      assert.deepEqual(skillEvents(compiled, frame), skillEvents(action, frame), `${id} frame ${frame}`);
      for (let level = 1; level <= 8; level++)
        assert.deepEqual(skillPlaybackEvents(compiled, frame, level), skillPlaybackEvents(action, frame, level),
          `${id} frame ${frame} level ${level}`);
    }
    assert.deepEqual(skillSequence(compiled, 4, 20), skillSequence(action, 4, 20), id);
    const roundTrip = JSON.parse(JSON.stringify(compiled)) as SkillAction;
    assert.deepEqual(skillEvents(roundTrip, Math.min(commonFrame(action), frameLimit(action))),
      skillEvents(action, Math.min(commonFrame(action), frameLimit(action))), id + ':json');
    checked++;
  }
  assert.ok(checked > 0);
});

function commonFrame(action: SkillAction): number {
  return action.events.find(event => event.kind !== 'capture-targets')?.frame ?? 0;
}

test('compiled battle passes the same content validation', () => {
  const battle = structuredClone(source);
  for (const skill of Object.values(battle.skills)) {
    for (const profile of [skill, skill.companion]) {
      if (!profile?.ranks?.length) continue;
      const { display, displayValues } = compileSkillDisplay(profile.ranks);
      profile.display = display;
      profile.ranks.forEach((rank, index) => {
        rank.displayValues = displayValues[index]!;
        delete rank.details;
      });
    }
  }
  const actions = allActions(battle);
  for (const { action } of actions) Object.assign(action, compileSkillAction(action));
  assert.doesNotThrow(() => parseBattle(battle));
});
