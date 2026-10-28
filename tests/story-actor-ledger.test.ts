import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {auditStoryActors} from '../tools/audit-story-actors.ts';

const baseline=JSON.parse(readFileSync(new URL('./fixtures/story-actor-ledger.json',import.meta.url),'utf8'));

test('the story actor identity ledger is unchanged',()=>{
  const report=auditStoryActors();
  assert.deepEqual(report.summary,baseline.summary);
  assert.equal(report.identity.multipleSelectors.length,baseline.expected.multipleSelectors);
  assert.equal(report.identity.characterOnly,baseline.expected.characterOnly);
  assert.equal(report.identity.templates.length,baseline.expected.templates);
  assert.equal(report.identity.explicitWorldRefs,baseline.expected.explicitWorldRefs);
  assert.equal(report.mapFromWorld.stages,baseline.expected.mapFromWorldStages);
  assert.equal(report.mapFromWorld.casts,baseline.expected.mapFromWorldCasts);
  assert.equal(report.places.uniqueIds,baseline.expected.placeIds);
  assert.equal(report.places.duplicateAcrossMaps.length,baseline.expected.duplicatePlaceIdsAcrossMaps);
  assert.equal(report.places.duplicateCharacterIds.length,baseline.expected.duplicatePlaceCharacterIds);
  assert.equal(report.ambiguous.length,baseline.expected.ambiguous);
  assert.equal(report.reportHash,baseline.reportHash,'身份台账变化时必须显式更新基线');
});
