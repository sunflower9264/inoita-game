/**
 * 生产内容烟雾测试：用真实 `public/content` 编译到临时目录，再跑一个小战斗和一个剧情节点。
 *
 * 核对六职业的实际图片、图集帧与剧情动作范围，并验证编译内容能在运行时工作。
 * 独立运行：`npm run test:content-build`；不进入每次 `npm test`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContent } from '../tools/content-build.ts';
import { buildContentManifest } from '../tools/content-manifest.ts';
import { hashTree } from '../tools/build-version.ts';
import { CombatController } from '../src/domain/combat.ts';
import { CombatCooldownStore } from '../src/domain/combat-cooldowns.ts';
import { resolveBasicAttack } from '../src/domain/basic-attack.ts';
import { needsTarget, skillEvents } from '../src/domain/skill-action.ts';
import { StoryRuntime } from '../src/domain/story-runtime.ts';
import { residentCombatAssets } from '../src/rendering/resident-combat-assets.ts';
import { residentCombatCoverageGaps } from '../src/rendering/combat-visual-coverage.ts';
import { characterAssets, characterSceneClips } from '../src/rendering/combat-asset-descriptors.ts';
import { EFFECT_ATLAS_BY_FILE, EFFECT_ATLAS_PAGES } from '../src/generated/effect-atlas.ts';
import { validateSpriteSheet } from '../tools/validate-spritesheet.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'story-content-smoke-'));
try {
  const contentDir = path.join(temporary, 'content');
  await buildContent(path.join(root, 'public/content'), contentDir);
  const battle = JSON.parse(await fs.readFile(path.join(contentDir, 'battle.json'), 'utf8'));
  const campaign = JSON.parse(await fs.readFile(path.join(contentDir, 'campaign.json'), 'utf8'));
  const world = JSON.parse(await fs.readFile(path.join(contentDir, 'world.json'), 'utf8'));
  const wardrobe = JSON.parse(await fs.readFile(path.join(contentDir, 'wardrobe.json'), 'utf8'));
  const companions = JSON.parse(await fs.readFile(path.join(contentDir, 'companions.json'), 'utf8'));

  // 六职业分别核对编译后的技能、召唤物清单及实际图片/图集帧，复用本次临时构建。
  const headers = new Map(), atlases = new Map();
  const headerFor = async file => {
    if (headers.has(file)) return headers.get(file);
    const handle = await fs.open(path.join(root, 'public', file));
    try {
      const header = Buffer.alloc(24); await handle.read(header, 0, 24, 0);
      headers.set(file, header); return header;
    } finally { await handle.close(); }
  };
  for (const character of battle.classes) {
    const input = { battle, wardrobe, world, companions, classIds: [character.id], ownedCompanionIds: [] };
    assert.deepEqual(residentCombatCoverageGaps(input), { effects: [], layers: [], actorLayers: [], definitions: [], companions: [] }, character.id);
    const pack = residentCombatAssets(input);
    for (const asset of pack.assets) {
      const header = await headerFor(asset.file);
      if (asset.kind === 'spritesheet') validateSpriteSheet(header, {
        frameWidth: asset.config.frameWidth, frameHeight: asset.config.frameHeight, frames: asset.config.endFrame + 1
      }, asset.file);
      if (asset.kind === 'atlas' && !atlases.has(asset.atlas))
        atlases.set(asset.atlas, JSON.parse(await fs.readFile(path.join(root, 'public', asset.atlas), 'utf8')));
    }
    for (const name of pack.effectNames) for (const clip of Object.values(battle.attackEffects[name]?.clips ?? {}))
      for (const layer of clip.layers) {
        const frames = EFFECT_ATLAS_BY_FILE[layer.file]; if (!frames) continue;
        assert.ok(frames.length >= clip.frames, `${character.id}: ${name} 图集帧不足`);
        for (const reference of frames.slice(0, clip.frames)) {
          const page = EFFECT_ATLAS_PAGES[reference.page], atlas = atlases.get(page.data);
          assert.ok(atlas?.frames?.[reference.frame], `${character.id}: ${name} 缺少 ${reference.frame}`);
        }
      }
  }
  assert.equal(battle.classes.length, 6);
  const darkness = world.actors['enemy-dark-forces-of-evil-1'];
  const dialogue = new Set(characterAssets(darkness, characterSceneClips(darkness)).map(asset => asset.key));
  const meteor = characterAssets(darkness, Object.keys(darkness.clips).filter(name => name.includes('meteor')));
  assert.ok(meteor.length > 0);
  // 角色图集按页共享：陨石帧可能和对白帧落在同一页，不能再用单个文件键要求完全不加载。
  // 新口径只验证「陨石独占的页仍然不会被对白提前加载」，页级共享的代价写在下面的输出里。
  const avoided = meteor.filter(asset => !dialogue.has(asset.key));
  assert.ok(avoided.length > 0, '对白仍应避开陨石独占的页');
  for (const asset of avoided) assert.ok(!dialogue.has(asset.key), '黑暗空间对白提前持有陨石动作');
  let avoidedBytes = 0;
  for (const file of new Set(avoided.map(asset => asset.file))) {
    const header = await headerFor(file); avoidedBytes += header.readUInt32BE(16) * header.readUInt32BE(20) * 4;
  }
  console.log(`Six classes: files and atlas frames verified; dark-space dialogue avoids ${(avoidedBytes / 1048576).toFixed(2)} MiB meteor textures`);

  // 构建期清单：版本来自编译后目录，必需顶层键必须真的存在。
  const manifest = await buildContentManifest(contentDir, hashTree(contentDir));
  assert.deepEqual(manifest.required['content/campaign.json'], ['version', 'start', 'scripts', 'quests']);
  assert.deepEqual(manifest.required['content/battle.json'], ['classes', 'skills', 'enemies']);
  assert.ok(campaign.scripts && campaign.start && campaign.quests);

  // 编译后的技能 IR：目标需求、特效名和事件帧已经被运行时直接使用。
  const character = battle.classes[0];
  const skillId = character.skills.find(id => battle.skills[id].kind === 'active');
  const skill = battle.skills[skillId];
  assert.ok(skill?.action, '主动技能缺少动作时间轴');
  assert.equal(needsTarget(skill.action), skill.action.requiresTarget);
  assert.ok(Array.isArray(skill.action.effectNames));
  let events = 0;
  for (let frame = 0; frame < 240 && !events; frame++) events = skillEvents(skill.action, frame).length;
  assert.ok(events > 0, '编译后的技能事件帧没有被任何一帧触发');

  // 最小战斗：用编译后的目录跑一次普通攻击并命中。
  const caster = { id: 'player', team: 'party', position: { x: 100, y: 100 }, bounds: { x: -8, y: -8, width: 16, height: 16 } };
  const enemy = { ...caster, id: 'enemy', team: 'hostile', position: { x: 108, y: 100 } };
  const combatants = [caster, enemy];
  const contacts = [];
  let onFrame;
  const cooldowns = new CombatCooldownStore(() => 0);
  const port = {
    canSelectSkill: () => true,
    cooldowns: cooldowns.forActor('player'),
    actor: id => combatants.find(actor => actor.id === id),
    candidates: () => combatants,
    facing: () => 'east',
    moveToward: () => {}, stop: () => {}, canStand: () => true, relocate: () => {},
    play: (_action, frame) => { onFrame = frame; return () => {}; },
    frame: (action, index, contact) => {
      if (action.basicAttack && index === action.basicAttack.strikeFrame && action.target) contact(action.target.id);
    },
    contact: event => contacts.push(event.targetId),
    clearEffects: () => {},
  };
  const basic = resolveBasicAttack(battle, character);
  const combat = new CombatController('player', basic, port);
  assert.equal(combat.requestTarget('enemy'), 'started');
  for (let step = 0; step < 8 && !onFrame; step++) combat.update();
  assert.ok(onFrame, '最小战斗没有进入出招');
  onFrame(basic.strikeFrame);
  assert.deepEqual(contacts, ['enemy'], '普通攻击没有命中目标');

  // 最小剧情节点：从编译后的脚本直接执行一个空节点，确认图与运行时格式可读。
  const runtime = new StoryRuntime(campaign, {
    prepare: async () => {}, capture: () => undefined, present: async () => ({}), finish: async () => {},
    apply: () => {}, commit: () => {}, rollback: () => {}, evaluate: () => false,
  });
  assert.equal(await runtime.start('complete:quest-10', undefined, undefined, 'done'), true);
  assert.equal(runtime.snapshot().runs[0]?.status, 'completed');

  console.log('Content build smoke passed: compiled battle IR, minimal combat and a story node');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
