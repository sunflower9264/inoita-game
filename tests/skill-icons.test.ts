import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseBattle } from '../src/application/content-validation.ts';

const root = new URL('../public/', import.meta.url);
test('all class skills ship native 75px touch icons for lists and shortcuts', () => {
  const battle = parseBattle(JSON.parse(fs.readFileSync(new URL('content/battle.json', root), 'utf8')));
  const skills = battle.classes.flatMap(character => character.skills);
  assert.equal(new Set(skills).size, 105);
  const icons = new Set<string>();
  for (const key of skills) {
    const file = battle.skills[key].icon; icons.add(file);
    const image = fs.readFileSync(new URL(file, root));
    assert.equal(image.subarray(1, 4).toString(), 'PNG', key);
    assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], [75, 75], key);
  }
  assert.equal(icons.size, 105);
});
