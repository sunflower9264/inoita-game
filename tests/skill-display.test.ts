import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { BattleCatalog, SkillDefinition } from '../src/domain/battle.ts';
import { skillForGrowth } from '../src/domain/battle.ts';
import { plainDescription } from '../src/domain/description-text.ts';
import { compileSkillDisplay, formatSkillDetail, skillDetailEntries } from '../src/domain/skill-display.ts';
import { skillDescriptionParts, skillNextLevelPreview } from '../src/ui/skill-detail-lines.ts';

const catalog = JSON.parse(fs.readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')) as BattleCatalog;

function compiledSkill(skill: SkillDefinition): SkillDefinition {
  const ranks = skill.ranks;
  const { display, displayValues } = compileSkillDisplay(ranks);
  return {
    ...skill,
    display,
    ranks: ranks.map((rank, index) => ({ ...rank, details: undefined, displayValues: displayValues[index]! }))
  };
}

test('compiled skill display reproduces every detail value, zero value and colored part', () => {
  let rows = 0;
  for (const skill of Object.values(catalog.skills)) {
    for (const profile of [skill, skillForGrowth(skill, 'companion')]) {
      const { display, displayValues } = compileSkillDisplay(profile.ranks);
      for (let rankIndex = 0; rankIndex < profile.ranks.length; rankIndex++) {
        const rank = profile.ranks[rankIndex]!;
        const details = rank.details!;
        assert.equal(displayValues[rankIndex]!.length, display.length);
        for (let index = 0; index < details.length; index++) {
          const original = details[index]!;
          const formatted = formatSkillDetail(display[index]!, displayValues[rankIndex]![index]!);
          assert.equal(formatted.text, original.value);
          assert.deepEqual(formatted.parts, original.valueParts ?? [{ text: original.value }]);
          if (original.zeroValue !== undefined)
            assert.equal(formatSkillDetail(display[index]!, 0).text, original.zeroValue);
          rows++;
        }
      }
    }
  }
  assert.equal(rows, 4688);
});

test('compiled display and source details produce identical descriptions and level previews', () => {
  for (const skill of Object.values(catalog.skills)) {
    for (const growth of ['hero', 'companion'] as const) {
      const source = skillForGrowth(skill, growth);
      const compiled = compiledSkill(source);
      for (let level = 0; level <= 8; level++) {
        assert.equal(plainDescription(skillDescriptionParts(compiled, level)), plainDescription(skillDescriptionParts(source, level)));
        assert.deepEqual(
          skillNextLevelPreview(compiled.ranks, level, compiled.kind, compiled.normalMaxLevel, compiled.display),
          skillNextLevelPreview(source.ranks, level, source.kind, source.normalMaxLevel)
        );
      }
    }
  }
});

test('compiled entries expose the same labels, values and zero text as legacy details', () => {
  const skill = catalog.skills['dark-strike']!;
  const compiled = compiledSkill(skill);
  for (let level = 0; level < skill.ranks.length; level++) {
    const sourceEntries = skillDetailEntries({}, skill.ranks[level]!);
    const compiledEntries = skillDetailEntries(compiled, compiled.ranks[level]!);
    assert.deepEqual(compiledEntries.map(entry => [entry.label, entry.text, entry.zeroText]),
      sourceEntries.map(entry => [entry.label, entry.text, entry.zeroText]));
  }
});
