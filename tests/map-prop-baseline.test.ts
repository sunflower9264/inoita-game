import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { contentDigest } from '../src/application/content-hash.ts';

const read = (file: string): any => JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
const world = read('content/world.json');
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/map-prop-baseline.json', import.meta.url), 'utf8'));

/**
 * 地图物件的纹理、顺序和绘制坐标由基线检查；地图内容变化时核对调试表的来源摘要。
 */
test('map prop feature manifest and debug source hashes stay unchanged', () => {
  const records: unknown[] = [];
  const mapEntries: [string, unknown][] = [];
  let duplicateGroups = 0, flips = 0, nonNormal = 0;
  for (const reference of world.maps) {
    const map = read(reference.file);
    mapEntries.push([map.id, map]);
    const counts = new Map<string, number>();
    map.features.forEach((feature: any, index: number) => {
      counts.set(feature.texture, (counts.get(feature.texture) ?? 0) + 1);
      if (feature.flip) flips++;
      if (feature.blend !== 'normal') nonNormal++;
      records.push([map.id, index, feature.texture, feature.x, feature.y, feature.offsetX, feature.offsetY,
        feature.width, feature.flip, feature.blend,
        feature.x - (feature.flip ? feature.width - feature.offsetX : feature.offsetX), feature.y - feature.offsetY]);
    });
    for (const count of counts.values()) if (count > 1) duplicateGroups++;
  }
  const manifestHash = contentDigest(records);
  assert.equal(records.length, fixture.records);
  assert.equal(manifestHash, fixture.manifestHash);
  assert.equal(duplicateGroups, fixture.duplicateGroups);
  assert.equal(flips, fixture.flips);
  assert.equal(nonNormal, fixture.nonNormal);
  const debug = read('content/debug/start.json');
  assert.equal(debug.meta.sources.maps, contentDigest(mapEntries));
  assert.equal(debug.meta.sourceHash, contentDigest(debug.meta.sources));
});
