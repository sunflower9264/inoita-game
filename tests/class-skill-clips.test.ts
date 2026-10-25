import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseBattle, parseWardrobe } from '../src/application/content-validation.ts';

const read = (file: string): any => JSON.parse(fs.readFileSync(new URL(`../public/content/${file}`, import.meta.url), 'utf8'));
const battle = parseBattle(read('battle.json'));
const wardrobe = parseWardrobe(read('wardrobe.json'));

test('every class actor skill clip has a Wardrobe pose, so the current class pack need not drive skill appearance', () => {
  let checked = 0;
  for (const character of battle.classes) {
    const poses = new Set(Object.keys(wardrobe.skills[character.id] ?? {}));
    for (const stance of Object.values(wardrobe.skillStances[character.id] ?? {}))
      for (const clip of Object.keys(stance.poses)) poses.add(clip);
    for (const clip of Object.keys(character.actor.clips)) {
      if (!clip.startsWith('skill-')) continue;
      assert.ok(poses.has(clip), `${character.id}: ${clip} has no Wardrobe pose`);
      checked++;
    }
  }
  assert.equal(checked, 216, '6 classes × 36 skill clips');
});
