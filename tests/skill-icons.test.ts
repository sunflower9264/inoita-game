import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { parseBattle } from '../src/application/content-validation.ts';
import {
  CANONICAL_RIM_SAMPLES,
  SKILL_ICON_CENTER,
  SKILL_ICON_SIZE,
  SKILL_RIM_INNER_RADIUS,
  extractCanonicalSkillRim,
} from '../tools/skill-icon-rim.ts';

const publicRoot = new URL('../public/', import.meta.url);
const assetSourceRoot = new URL('../asset-source/', import.meta.url);
const readPng = (base: URL, rel: string) => PNG.sync.read(fs.readFileSync(new URL(rel, base)));

test('all class skills ship native 75px touch icons for lists and shortcuts', () => {
  const battle = parseBattle(JSON.parse(fs.readFileSync(new URL('content/battle.json', publicRoot), 'utf8')));
  const skills = battle.classes.flatMap(character => character.skills);
  assert.equal(new Set(skills).size, 105);
  const icons = new Set<string>();
  for (const key of skills) {
    const file = battle.skills[key].icon; icons.add(file);
    const image = fs.readFileSync(new URL(file, publicRoot));
    assert.equal(image.subarray(1, 4).toString(), 'PNG', key);
    assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], [SKILL_ICON_SIZE, SKILL_ICON_SIZE], key);
  }
  assert.equal(icons.size, 105);
});

test('lancer skill icons strictly match the canonical symmetric circular rim without corner overflow', () => {
  const battle = parseBattle(JSON.parse(fs.readFileSync(new URL('content/battle.json', publicRoot), 'utf8')));
  const lancer = battle.classes.find(character => character.id === 'lancer');
  assert.ok(lancer, 'missing lancer class');
  assert.equal(lancer.skills.length, 15);

  const canonical = extractCanonicalSkillRim(
    CANONICAL_RIM_SAMPLES.map(rel => readPng(assetSourceRoot, rel)),
  );

  for (const skillId of lancer.skills) {
    const file = battle.skills[skillId].icon;
    const sourceBytes = fs.readFileSync(new URL(file, assetSourceRoot));
    const publicBytes = fs.readFileSync(new URL(file, publicRoot));
    assert.ok(sourceBytes.equals(publicBytes), `${file} asset-source 与 public 副本不一致`);

    const png = PNG.sync.read(sourceBytes);
    assert.deepEqual([png.width, png.height], [SKILL_ICON_SIZE, SKILL_ICON_SIZE], file);
    for (let y = 0; y < SKILL_ICON_SIZE; y++) {
      for (let x = 0; x < SKILL_ICON_SIZE; x++) {
        const idx = (y * SKILL_ICON_SIZE + x) * 4;
        const r = Math.hypot(x - SKILL_ICON_CENTER, y - SKILL_ICON_CENTER);
        const alpha = png.data[idx + 3]!;
        if (r >= SKILL_RIM_INNER_RADIUS) {
          assert.equal(alpha, canonical.rgba[idx + 3], `${file} 透明通道越界于 (${x},${y}) r=${r.toFixed(2)}`);
          if (alpha === 0) {
            assert.deepEqual([png.data[idx], png.data[idx + 1], png.data[idx + 2]], [0, 0, 0], `${file} 透明像素应清零于 (${x},${y})`);
          } else {
            assert.deepEqual(
              [png.data[idx], png.data[idx + 1], png.data[idx + 2]],
              [canonical.rgba[idx], canonical.rgba[idx + 1], canonical.rgba[idx + 2]],
              `${file} 外圈青铜框偏离标准值于 (${x},${y}) r=${r.toFixed(2)}`,
            );
          }
        } else {
          assert.equal(alpha, 255, `${file} 图标圆内应完全不透明于 (${x},${y})`);
        }
      }
    }
  }
});

test('extractCanonicalSkillRim rejects asymmetric, corner-leaking, or mismatched icons', () => {
  const clean = readPng(assetSourceRoot, 'assets/skills/dark-strike.png');
  const broken = readPng(assetSourceRoot, 'assets/skills/rush-of-anger.png');
  assert.throws(() => extractCanonicalSkillRim([broken, broken]), /八向对称|圆外|不一致/);
  assert.throws(() => extractCanonicalSkillRim([clean, broken]), /透明通道不一致|外圈颜色不一致/);

  // 合成一枚左下角越界 1 像素的图标，验证单点圆外泄漏也会被构建期直接拦截
  const cornerLeak = new PNG({ width: SKILL_ICON_SIZE, height: SKILL_ICON_SIZE });
  clean.data.copy(cornerLeak.data);
  const leakIdx = (70 * SKILL_ICON_SIZE + 4) * 4;
  cornerLeak.data[leakIdx + 3] = 255;
  assert.throws(() => extractCanonicalSkillRim([clean, cornerLeak]), /透明通道不一致/);
  assert.throws(() => extractCanonicalSkillRim([cornerLeak, cornerLeak]), /八向对称|圆外/);
});
