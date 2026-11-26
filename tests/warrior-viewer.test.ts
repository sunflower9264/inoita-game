import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { Facing } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { costumeRecipe, type CostumePose, type WardrobeCatalog } from '../src/domain/wardrobe.ts';
import { EFFECT_ATLAS_BY_FILE } from '../src/generated/effect-atlas.ts';
import {
  actionChoices, actionNotices, actionTimeline, activeEffectsAtFrame, armorChoices,
  compatibleOffhands, effectOverlayBounds, formatInventoryMarkdown, framePieces,
  mergePrototypeBattle, mergePrototypeWeapon, Playback, PoseRepository, poseBounds,
  variantChoices, viewerRecipe, warriorAssetInventory, warriorPartSpecs, warriorPoseIds,
  warriorPoseMatrix, warriorPresets, weaponChoices,
} from '../tools/warrior-viewer/model.ts';
import type {
  AudioCatalogLite, CompanionCatalogLite, EquipmentSelection, MenuPanelsLite,
  PrototypeWeaponBundle, StatusHudLite, StoryClassesLite,
} from '../tools/warrior-viewer/model.ts';

const root = new URL('../public/', import.meta.url);
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(new URL(file, root), 'utf8')) as T;
const catalog = readJson<WardrobeCatalog>('content/wardrobe.json');
const items = readJson<ItemCatalog>('content/items.json');
const battle = readJson<BattleCatalog>('content/battle.json');
const storyClasses = readJson<StoryClassesLite>('content/story-classes.json');
const menuPanels = readJson<MenuPanelsLite>('content/menu-panels.json');
const statusHud = readJson<StatusHudLite>('content/status-hud.json');
const companions = readJson<CompanionCatalogLite>('content/companions.json');
const audio = readJson<AudioCatalogLite>('content/audio.json');
const defaults = items.startingEquipment.warrior;
const directions: Facing[] = ['south', 'west', 'north', 'east'];
const skillNames = Object.fromEntries(Object.entries(battle.skills).map(([id, value]) => [id, value.name]));

test('viewer includes all warrior skills, combo, frenzy, town movement and shared die pose without altering main costumeRecipe', () => {
  const mainRecipe = costumeRecipe(catalog, items, defaults, 'warrior');
  assert.equal(mainRecipe.poses['die-south'], undefined);
  for (const facing of directions) {
    const choices = actionChoices(catalog, items, defaults, facing, skillNames);
    assert.equal(choices.filter(choice => choice.group === '主动技能').length, 9);
    assert.ok(choices.some(choice => choice.key === 'attack-3'));
    assert.ok(choices.some(choice => choice.key === 'frenzy-two-handed'));
    assert.equal(new Set(choices.map(choice => choice.key)).size, choices.length);
    const town = choices.find(choice => choice.key === 'town-walk')!;
    assert.equal(town.poseId, catalog.stances['unarmed:empty'][`walk-${facing}`]);
    assert.notEqual(town.poseId, choices.find(choice => choice.key === 'walk')!.poseId);
    const die = choices.find(choice => choice.key === 'die')!;
    assert.equal(die.group, '阵亡动作');
    assert.equal(die.poseId, catalog.sharedPoses?.[`die-${facing}`]);
    assert.equal(catalog.poses[die.poseId].frames.length, 23);
  }
});

test('weapons, armor and presets offer unique warrior appearances and valid offhand combinations', () => {
  const main = weaponChoices(catalog, items);
  const signatures = main.map(choice => JSON.stringify([choice.kind, catalog.equipment[choice.id].main]));
  assert.equal(signatures.length, new Set(signatures).size);
  assert.ok(main.every(choice => items.items[choice.id].equipment!.classes.includes('warrior')));
  assert.deepEqual(compatibleOffhands(catalog, items, 'greatsword'), []);
  assert.ok(compatibleOffhands(catalog, items, 'dagger').some(choice => choice.kind === 'shield'));
  assert.ok(compatibleOffhands(catalog, items, 'dagger').some(choice => choice.kind === 'longsword'));
  assert.ok(compatibleOffhands(catalog, items).every(choice => choice.kind === 'shield'));

  assert.ok(armorChoices(catalog, items, 'body').length >= 50);
  assert.ok(armorChoices(catalog, items, 'head').length >= 50);
  assert.equal(armorChoices(catalog, items, 'back').length, 4);

  const presets = warriorPresets(catalog, companions);
  assert.equal(presets[0].id, 'hero');
  assert.ok(presets.some(p => p.appearanceId === 'mercenary-warrior'));
  assert.ok(presets.some(p => p.appearanceId === 'mercenary-olaf'));
  assert.ok(presets.some(p => p.appearanceId === 'mercenary-shin'));
  const olafRecipe = viewerRecipe(catalog, items, defaults, {}, 'mercenary-olaf');
  assert.equal(olafRecipe.variants.body, catalog.companions!['mercenary-olaf'].variants.body);
});

test('every available weapon stance and die pose resolves all four directions and every frame to valid atlas pieces', () => {
  const representatives = new Map<string, string | undefined>([['unarmed', undefined]]);
  for (const choice of weaponChoices(catalog, items)) representatives.set(choice.kind, choice.id);
  const sheets = new Map(catalog.textures.map(texture => {
    const bytes = fs.readFileSync(new URL(texture.file, root));
    return [texture.key, [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]];
  }));
  const seen = new Set<string>();
  for (const [mainKind, main] of representatives) {
    const offhands = new Map<string, string | undefined>([['empty', undefined]]);
    for (const choice of compatibleOffhands(catalog, items, main)) offhands.set(choice.kind, choice.id);
    for (const [offKind, off] of offhands) {
      const equipment: EquipmentSelection = {};
      if (main) equipment['main-hand'] = main;
      if (off) equipment['off-hand'] = off;
      const recipe = viewerRecipe(catalog, items, equipment, {});
      seen.add(`${mainKind}:${offKind}`);
      for (const facing of directions) for (const action of actionChoices(catalog, items, equipment, facing, skillNames)) {
        const pose = catalog.poses[action.poseId];
        assert.ok(pose?.frames.length, action.poseId);
        assert.ok(pose.frameRate > 0);
        for (const frame of pose.frames) {
          const pieces = framePieces(catalog, recipe.variants, frame);
          assert.deepEqual(pieces.map(piece => piece.order), pieces.map(piece => piece.order).sort((a, b) => a - b));
          for (const { sprite } of pieces) {
            const sheet = sheets.get(sprite.texture)!;
            assert.ok(sheet, sprite.texture);
            assert.ok(sprite.x >= 0 && sprite.y >= 0);
            assert.ok(sprite.x + sprite.width <= sheet[0] && sprite.y + sprite.height <= sheet[1]);
          }
        }
      }
    }
  }
  assert.equal(seen.size, 27);
});

test('action timelines resolve swings, skill effects, buff tints, sounds and atlas frames across stances', () => {
  // 2H basic combo 1/2/3 -> heavy-swing / heavy-swing-2 / heavy-swing-3
  for (const [key, expectedFx] of [['attack', 'heavy-swing'], ['attack-2', 'heavy-swing-2'], ['attack-3', 'heavy-swing-3']] as const) {
    const tl = actionTimeline(catalog, items, battle, defaults, key, 'south', audio);
    assert.ok(tl.effects.some(cue => cue.effect === expectedFx && cue.variant === 'south'), key);
    assert.ok(tl.sounds.includes('Weapon_TwoHand_Sword_Attack'));
    assert.ok(tl.cycleFrames && tl.cycleFrames > 0);
  }
  // Giant blow switches effect between two-handed (giant-blow) and one-handed (giant-blow-swing)
  const gb2h = actionTimeline(catalog, items, battle, defaults, 'skill-giant-blow', 'west', audio);
  assert.ok(gb2h.effects.some(cue => cue.effect === 'giant-blow' && cue.variant === 'west'));
  assert.ok(gb2h.sounds.includes('Wa_Titan_Attack'));
  const activeMid = activeEffectsAtFrame(gb2h, battle, 14);
  assert.equal(activeMid.length, 1);
  assert.equal(activeMid[0].effectFrame, 2);
  assert.ok(effectOverlayBounds(battle, gb2h, 'west'));

  const longswordId = weaponChoices(catalog, items).find(w => w.kind === 'longsword')!.id;
  const gb1h = actionTimeline(catalog, items, battle, { 'main-hand': longswordId }, 'skill-giant-blow', 'west', audio);
  assert.ok(gb1h.effects.some(cue => cue.effect === 'giant-blow-swing' && cue.variant === 'west'));

  // Enrage carries 7-frame red appearanceColors and armor-ember + aura-ring
  const enrageTl = actionTimeline(catalog, items, battle, defaults, 'skill-enrage', 'south', audio);
  assert.equal(enrageTl.appearanceColors?.length, 7);
  assert.ok(enrageTl.effects.some(cue => cue.effect === 'armor-ember'));
  assert.ok(enrageTl.effects.some(cue => cue.effect === 'aura-ring'));

  // Every active skill effect resolves cleanly to EFFECT_ATLAS_BY_FILE
  const warriorClass = battle.classes.find(c => c.id === 'warrior')!;
  for (const skillId of warriorClass.skills) {
    if (battle.skills[skillId].kind !== 'active') continue;
    for (const eq of [defaults, { 'main-hand': longswordId }]) {
      const tl = actionTimeline(catalog, items, battle, eq, `skill-${skillId}`, 'south', audio);
      assert.ok(tl.markers.length > 0, skillId);
      for (const cue of tl.effects) {
        const clip = battle.attackEffects[cue.effect]?.clips[cue.variant];
        assert.ok(clip, `${skillId}:${cue.effect}/${cue.variant}`);
        for (const layer of clip.layers) {
          const atlasFrames = EFFECT_ATLAS_BY_FILE[layer.file];
          assert.ok(atlasFrames && atlasFrames.length >= clip.frames, `effect atlas missing ${layer.file}`);
        }
      }
      for (const soundId of tl.sounds) {
        assert.ok(audio.effects[soundId], `missing audio ${soundId}`);
      }
    }
  }
});

test('boundary notices warn about unarmed+shield frenzy wait and weapon-less original skill poses', () => {
  const shieldId = weaponChoices(catalog, items, true).find(w => w.kind === 'shield')!.id;
  const unarmedShieldPose = catalog.poses[catalog.stances['unarmed:shield']['idle-south']!];
  const shieldNotices = actionNotices(catalog, items, { 'off-hand': shieldId }, 'idle', unarmedShieldPose);
  assert.ok(shieldNotices.some(msg => msg.includes('128 帧等待')));

  const armorPenPose = catalog.poses[catalog.skills.warrior['skill-armor-penetration-south']!];
  const twoHandedNotices = actionNotices(catalog, items, defaults, 'skill-armor-penetration', armorPenPose);
  assert.ok(twoHandedNotices.some(msg => msg.includes('双手武器')));
});

test('asset inventory covers all 30 pose templates, 12 warrior parts (with die-only weapon slices) and supplemental assets', () => {
  assert.equal(warriorPoseIds(catalog, items).length, 117);
  const templates = warriorPoseMatrix(catalog, items, skillNames);
  assert.equal(templates.length, 30);
  assert.ok(templates.some(t => t.category === '阵亡动作' && t.frames.south === 23));

  const parts = warriorPartSpecs(catalog, items);
  assert.equal(parts.length, 12);
  assert.ok(!parts.some(p => p.part === 'cast-prop-1'));
  const twoHanded = parts.find(p => p.part === 'two-handed')!;
  assert.equal(twoHanded.sliceCount, 11);
  assert.equal(twoHanded.dieOnlyCount, 2); // #8 and #10 appear only in die pose
  assert.equal(twoHanded.slices[8].dieUsed && !twoHanded.slices[8].combatUsed, true);
  assert.equal(twoHanded.slices[10].dieUsed && !twoHanded.slices[10].combatUsed, true);
  const mainBlade = parts.find(p => p.part === 'main-blade')!;
  assert.equal(mainBlade.dieOnlyCount, 1); // #5 appears only in die pose

  const inventory = warriorAssetInventory(catalog, items, battle, storyClasses, menuPanels, statusHud, audio);
  assert.equal(inventory.stanceCount, 27);
  assert.equal(inventory.supplemental.skills.length, 15);
  assert.equal(inventory.supplemental.buffIcons.length, 8);
  assert.equal(inventory.supplemental.identity.length, 4);
  assert.ok(inventory.supplemental.effects.length >= 30);
  assert.ok(inventory.supplemental.sounds.length >= 10);

  const md = formatInventoryMarkdown(inventory);
  assert.ok(md.includes('# 狂战士完整动作与素材规格清单'));
  assert.ok(md.includes('战斗阵亡'));
  assert.ok(md.includes('无外观切片的装备槽'));
});

test('independent appearance overrides keep pose selection and original catalog intact', () => {
  const recipe = viewerRecipe(catalog, items, defaults, { 'coat-front': 'coat-front-style-2', 'head-front': null });
  assert.equal(recipe.variants['coat-front'], 'coat-front-style-2');
  assert.equal(recipe.variants['coat-back'], catalog.defaults['coat-back']);
  assert.equal(recipe.variants['head-front'], undefined);
  assert.equal(catalog.defaults['coat-front'], 'coat-front-style-1');
  const pose = catalog.poses[recipe.poses['attack-west']!];
  const entries = framePieces(catalog, recipe.variants, pose.frames[0]);
  assert.ok(!entries.some(piece => piece.part.part === 'head-front'));
  assert.ok(entries.some(piece => piece.part.part === 'coat-front'));
  const options = variantChoices(catalog, items, 'two-handed');
  assert.equal(options.length, 13);
  assert.ok(options.every(choice => choice.warrior));
  assert.equal(new Set(options.map(choice => choice.id)).size, options.length);
  assert.throws(() => framePieces(catalog, { body: 'missing' }, pose.frames[0]), /外观款式缺失/);
});

test('bounds use anchors and negative part scale, then mirror the entire pose', () => {
  const data = {
    variants: { base: ['test'] },
    sprites: { test: { texture: 'sheet', x: 0, y: 0, width: 6, height: 4, anchorX: 2, anchorY: 1 } },
  } as unknown as WardrobeCatalog;
  const pose: CostumePose = { mirrorX: false, frameRate: 10, frames: [[{
    part: 'body', piece: 0, x: 3, y: 4, angle: 0, scaleX: -1, scaleY: 1, alpha: 0.3,
  }]] };
  assert.deepEqual(poseBounds(data, { body: 'base' }, pose), { left: -1, right: 5, top: 0, bottom: 7 });
  assert.deepEqual(poseBounds(data, { body: 'base' }, { ...pose, mirrorX: true }),
    { left: -5, right: 1, top: 0, bottom: 7 });
  assert.equal(framePieces(data, { body: 'base' }, pose.frames[0])[0].part.alpha, 0.3);
});

test('playback preserves repeated source frames and supports pause, stepping, resume and speed changes', () => {
  const player = new Playback();
  player.configure(4, 10);
  assert.equal(player.advance(250), true);
  assert.equal(player.frame, 2);
  player.seek(3);
  assert.equal(player.advance(1000), false);
  assert.equal(player.frame, 3);
  player.toggle();
  player.advance(100);
  assert.equal(player.frame, 0);
  player.speed = 2;
  player.advance(50);
  assert.equal(player.frame, 1);
  player.seek(100);
  assert.equal(player.frame, 3);
  player.configure(2, 20);
  assert.equal(player.frame, 1);
  player.seek(-1);
  assert.equal(player.frame, 0);
});

test('split pose loading shares requests, supports full catalogs and retries failures', async () => {
  const sample = Object.values(catalog.poses)[0];
  const split = { ...catalog, poses: {} };
  let loads = 0;
  const repository = new PoseRepository(split, async url => {
    loads++;
    assert.ok(url.startsWith('/content/wardrobe/poses/'));
    if (loads === 1) throw new Error('load failed');
    return sample;
  });
  await assert.rejects(repository.get('test'), /load failed/);
  const [first, second] = await Promise.all([repository.get('test'), repository.get('test')]);
  assert.equal(first, second);
  assert.equal(loads, 2);
  await repository.get('test');
  assert.equal(loads, 2);
  const full = new PoseRepository(catalog, async () => { throw new Error('unexpected download'); });
  assert.equal(await full.get(Object.keys(catalog.poses)[0]), sample);
});

test('spear prototype integrates cleanly with existing wardrobe outfits across all four directions without polluting warrior inventory', () => {
  const repoRoot = new URL('../', import.meta.url);
  const proto = JSON.parse(fs.readFileSync(new URL('tools/warrior-viewer/prototypes/spear/spear-prototype.json', repoRoot), 'utf8')) as PrototypeWeaponBundle;
  const pngBytes = fs.readFileSync(new URL(proto.texture.file, repoRoot));
  const pngWidth = pngBytes.readUInt32BE(16);
  const pngHeight = pngBytes.readUInt32BE(20);
  assert.equal(Object.keys(proto.sprites).length, 30);
  for (const sprite of Object.values(proto.sprites)) {
    assert.equal(sprite.texture, proto.texture.key);
    assert.ok(sprite.x >= 0 && sprite.y >= 0);
    assert.ok(sprite.x + sprite.width <= pngWidth && sprite.y + sprite.height <= pngHeight);
  }

  // Validate prototype spear effect sheet PNG and frame bounds
  assert.ok(proto.effectSheet);
  const effBytes = fs.readFileSync(new URL(proto.effectSheet.texture.file, repoRoot));
  const effWidth = effBytes.readUInt32BE(16);
  const effHeight = effBytes.readUInt32BE(20);
  assert.equal(Object.keys(proto.effectSheet.frames).length, 488);
  for (const rect of Object.values(proto.effectSheet.frames)) {
    assert.ok(rect.x >= 0 && rect.y >= 0);
    assert.ok(rect.x + rect.width <= effWidth && rect.y + rect.height <= effHeight);
  }

  const { catalog: mergedCatalog, items: mergedItems } = mergePrototypeWeapon(catalog, items, proto);
  const mergedBattle = mergePrototypeBattle(battle, proto);
  // Original catalogs & warrior asset inventory remain untouched
  assert.equal(catalog.equipment[proto.weaponId], undefined);
  assert.equal(battle.attackEffects['spear-thrust-beam'], undefined);
  assert.equal(warriorPoseIds(mergedCatalog, mergedItems).length, 117);
  assert.equal(warriorPoseMatrix(mergedCatalog, mergedItems, skillNames).length, 30);

  const bodyArmor = armorChoices(mergedCatalog, mergedItems, 'body')[3].id;
  const headArmor = armorChoices(mergedCatalog, mergedItems, 'head')[3].id;
  const cloakArmor = armorChoices(mergedCatalog, mergedItems, 'back')[1].id;
  const spearEquipment: EquipmentSelection = {
    'main-hand': proto.weaponId,
    body: bodyArmor,
    head: headArmor,
    back: cloakArmor,
  };
  assert.deepEqual(compatibleOffhands(mergedCatalog, mergedItems, proto.weaponId), []);

  const expectedFrames: Record<string, number> = {
    idle: 14,
    walk: 8,
    thrust: 10,
    sweep: 12,
    'spear-upright-idle': 14,
    attack: 8,
    'attack-2': 7,
    'attack-3': 8,
    'skill-dragon-pierce': 12,
    'skill-whirl-sweep': 16,
    'skill-spin-storm': 18,
    'skill-flurry-thrust': 17,
    'skill-dragon-slam': 11,
    'skill-sovereign-pierce': 28,
    'skill-focus-edge': 12,
    'skill-dragon-step': 12,
    'skill-gale-stance': 12,
    'spear-die': 23,
  };

  for (const appearance of [undefined, 'mercenary-olaf']) {
    const recipe = viewerRecipe(mergedCatalog, mergedItems, spearEquipment, {}, appearance);
    assert.equal(recipe.variants.spear, proto.variantId);
    for (const facing of directions) {
      const choices = actionChoices(mergedCatalog, mergedItems, spearEquipment, facing, skillNames, proto.actionLabels);
      const protoActions = choices.filter(choice => !choice.key.startsWith('town-') && choice.key !== 'die');
      assert.equal(protoActions.length, Object.keys(expectedFrames).length);
      for (const [key, count] of Object.entries(expectedFrames)) {
        const action = protoActions.find(choice => choice.key === key);
        assert.ok(action, `missing prototype action ${key} (${facing})`);
        const pose = mergedCatalog.poses[action.poseId];
        assert.equal(pose.frames.length, count, `${action.poseId} frame count`);
        assert.equal(pose.mirrorX, facing === 'east');
        for (const frame of pose.frames) {
          const pieces = framePieces(mergedCatalog, recipe.variants, frame);
          assert.ok(pieces.some(p => p.part.part === 'spear'), `${action.poseId} should draw spear`);
          assert.ok(pieces.some(p => p.part.part === 'coat-front'), `${action.poseId} should draw armor`);
          if (!appearance) assert.ok(pieces.some(p => p.part.part === 'cloak'), `${action.poseId} should draw cloak`);
          else assert.ok(!pieces.some(p => p.part.part === 'cloak'), 'olaf fixedParts suppresses cloak');
        }
      }

      // Check single-handed ~46% golden-balance trail carry (idle/walk) and diagonal back-slung town movement (town-idle/town-walk) across all 4 directions and all frames
      for (const [key, expectedCount] of [['idle', 14], ['walk', 8]] as const) {
        const action = choices.find(choice => choice.key === key)!;
        const pose = mergedCatalog.poses[action.poseId];
        assert.equal(pose.frames.length, expectedCount);
        const expectedPrefix = facing === 'south'
          ? 'spear-carry-south-'
          : facing === 'north'
            ? 'spear-carry-north-'
            : 'spear-carry-side-';
        let baseGripDx: number | undefined;
        let baseGripDy: number | undefined;
        for (let fi = 0; fi < pose.frames.length; fi++) {
          const frame = pose.frames[fi];
          const spearIdx = frame.findIndex(p => p.part === 'spear');
          const spear = frame[spearIdx];
          assert.ok(spear, `${action.poseId} F${fi} missing spear`);
          assert.ok(proto.variants[proto.variantId][spear.piece]?.startsWith(expectedPrefix), `${action.poseId} F${fi} should use ${expectedPrefix}`);
          const armIndices = frame
            .map((p, idx) => (p.part === 'coat-front' && p.piece >= 5 ? idx : -1))
            .filter(idx => idx >= 0);
          assert.equal(armIndices.length, 2, `${action.poseId} F${fi} should have one gripping arm and one free arm`);
          let gripArmIdx: number;
          if (facing === 'west' || facing === 'east') {
            gripArmIdx = armIndices[1];
            assert.ok(armIndices[0] < spearIdx && spearIdx < gripArmIdx, `${action.poseId} F${fi} spear should sit over far free arm and beneath near gripping arm`);
          } else if (facing === 'south') {
            gripArmIdx = frame.findIndex(p => p.part === 'coat-front' && p.piece >= 5 && p.scaleX === -1);
            assert.ok(gripArmIdx >= 0 && spearIdx < gripArmIdx, `${action.poseId} F${fi} south spear should sit beneath right gripping arm (scaleX=-1)`);
          } else {
            gripArmIdx = frame.findIndex(p => p.part === 'coat-front' && p.piece >= 5 && p.scaleX === 1);
            const cloakIdx = frame.findIndex(p => p.part === 'cloak');
            assert.ok(gripArmIdx >= 0 && spearIdx < gripArmIdx, `${action.poseId} F${fi} north spear should sit beneath right gripping arm (scaleX=1)`);
            assert.ok(cloakIdx < 0 || spearIdx < cloakIdx, `${action.poseId} F${fi} north spear should sit before cloak`);
          }
          const dx = spear.x - frame[gripArmIdx].x;
          const dy = spear.y - frame[gripArmIdx].y;
          if (baseGripDx === undefined) {
            baseGripDx = dx;
            baseGripDy = dy;
          } else {
            assert.equal(dx, baseGripDx, `${action.poseId} F${fi} spear X should stay locked to single gripping hand`);
            assert.equal(dy, baseGripDy, `${action.poseId} F${fi} spear Y should stay locked to single gripping hand`);
          }
        }
      }

      for (const [key, expectedCount] of [['town-idle', 14], ['town-walk', 8]] as const) {
        const action = choices.find(choice => choice.key === key);
        assert.ok(action, `missing ${key} (${facing})`);
        assert.equal(action.group, '地图动作');
        assert.equal(action.poseId, `prototype-spear-${key}-${facing}`);
        const pose = mergedCatalog.poses[action.poseId];
        assert.equal(pose.frames.length, expectedCount, `${action.poseId} frame count`);
        assert.equal(pose.mirrorX, facing === 'east');
        assert.equal(actionNotices(mergedCatalog, mergedItems, spearEquipment, key, pose).length, 0, `${action.poseId} should not warn weapon hidden`);
        for (const frame of pose.frames) {
          const pieces = framePieces(mergedCatalog, recipe.variants, frame);
          const spearIdx = frame.findIndex(p => p.part === 'spear');
          const cloakIdx = frame.findIndex(p => p.part === 'cloak');
          assert.ok(spearIdx >= 0, `${action.poseId} should draw back-slung spear`);
          assert.ok(pieces.some(p => p.part.part === 'coat-front'), `${action.poseId} should draw armor`);
          const spriteId = proto.variants[proto.variantId][frame[spearIdx].piece];
          assert.ok(spriteId?.startsWith(facing === 'west' || facing === 'east' ? 'spear-back-side-' : 'spear-back-diag-'));
          if (facing === 'north') {
            const headFrontIdx = frame.findIndex(p => p.part === 'head-front');
            assert.ok(spearIdx > cloakIdx, `${action.poseId} north back-slung spear should draw over cloak`);
            assert.ok(headFrontIdx < 0 || spearIdx < headFrontIdx, `${action.poseId} north back-slung spear should sit beneath hair/helmet`);
          } else assert.equal(spearIdx, 0, `${action.poseId} ${facing} back-slung spear should draw behind body/cloak`);
        }
      }

      // Check timelines across all 3 basic attacks + 6 damage skills + 3 self-buffs
      const skillsWithEffects = [
        'attack', 'attack-2', 'attack-3', 'thrust', 'sweep',
        'skill-dragon-pierce', 'skill-whirl-sweep', 'skill-spin-storm',
        'skill-flurry-thrust', 'skill-dragon-slam', 'skill-sovereign-pierce',
        'skill-focus-edge', 'skill-dragon-step', 'skill-gale-stance',
      ];
      for (const key of skillsWithEffects) {
        const tl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, key, facing, audio, proto.actionTimelines);
        assert.ok(tl.effects.length >= 1, `${key} should have effects`);
        assert.ok(effectOverlayBounds(mergedBattle, tl, facing), `${key} bounds`);
        for (const cue of tl.effects) {
          const clip = mergedBattle.attackEffects[cue.effect]?.clips[cue.variant];
          assert.ok(clip, `${key}:${cue.effect}/${cue.variant}`);
          for (const layer of clip.layers) {
            const protoKeys = proto.effectSheet.byFile[layer.file];
            const atlasKeys = EFFECT_ATLAS_BY_FILE[layer.file];
            assert.ok((protoKeys && protoKeys.length >= clip.frames) || (atlasKeys && atlasKeys.length >= clip.frames),
              `missing frames for ${layer.file}`);
          }
        }
        for (const soundId of tl.sounds) {
          assert.ok(audio.effects[soundId], `${key} missing audio ${soundId}`);
        }
      }

      const atk3Tl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'attack-3', facing, audio, proto.actionTimelines);
      assert.equal(atk3Tl.shakeFrames.length, 0);
      assert.ok(atk3Tl.effects.some(e => e.effect === 'spear-basic-lift' && e.variant === facing && e.startFrame === 2));
      assert.ok(!atk3Tl.effects.some(e => e.effect === 'state-stun'));

      const pierceTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-dragon-pierce', facing, audio, proto.actionTimelines);
      assert.equal(pierceTl.afterimages, undefined, 'stationary dragon-pierce should not draw dash afterimages');
      assert.deepEqual(pierceTl.shakeFrames, []);
      assert.ok(pierceTl.effects.some(e => e.effect === 'spear-heavy-pierce' && e.variant === facing));
      assert.ok(pierceTl.effects.some(e => e.effect === 'impact-burst' && e.onTarget));

      const whirlTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-whirl-sweep', facing, audio, proto.actionTimelines);
      assert.equal(whirlTl.markers.filter(m => m.kind === 'strike').length, 3);
      assert.deepEqual(whirlTl.shakeFrames, []);
      assert.ok(whirlTl.effects.some(e => e.effect === 'spear-flower-spin' && e.variant === facing && e.startFrame === 0));
      assert.ok(whirlTl.effects.some(e => e.effect === 'spear-gale-sweep' && e.variant === facing));
      const whirlPose = mergedCatalog.poses[proto.stancePoses[`skill-whirl-sweep-${facing}`]];
      const whirlF2Spear = whirlPose.frames[2].find(p => p.part === 'spear');
      assert.equal(whirlF2Spear?.alpha, 1, 'whirl flower keeps solid opaque spear');

      const spinTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-spin-storm', facing, audio, proto.actionTimelines);
      assert.equal(spinTl.markers.filter(m => m.kind === 'strike').length, 4);
      assert.deepEqual(spinTl.shakeFrames, []);
      assert.ok(spinTl.effects.some(e => e.effect === 'spear-spin-storm' && e.variant === facing && e.startFrame === 2));
      assert.ok(spinTl.effects.some(e => e.effect === 'curse-wind-ring' && e.placement === 'ground'));

      const flurryTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-flurry-thrust', facing, audio, proto.actionTimelines);
      assert.equal(flurryTl.markers.filter(m => m.kind === 'strike').length, 3);
      assert.deepEqual(flurryTl.shakeFrames, []);
      assert.ok(flurryTl.effects.some(e => e.effect === 'spear-flurry-needles' && e.variant === facing));
      assert.ok(flurryTl.effects.some(e => e.effect === 'spear-flurry-finisher' && e.variant === facing));

      const slamTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-dragon-slam', facing, audio, proto.actionTimelines);
      assert.deepEqual(slamTl.shakeFrames, [4]);
      assert.ok(slamTl.effects.some(e => e.effect === 'spear-slam-arc' && e.variant === facing));
      assert.ok(slamTl.effects.some(e => e.effect === 'state-stun' && e.onTarget));

      const sovTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-sovereign-pierce', facing, audio, proto.actionTimelines);
      assert.ok(sovTl.effects.some(e => e.effect === 'spear-sovereign-dome-back' && e.variant === 'default' && e.placement === 'ground' && e.startFrame === 0));
      assert.ok(sovTl.effects.some(e => e.effect === 'spear-sovereign-dome' && e.variant === 'default' && e.placement === 'above-characters' && e.startFrame === 0));
      assert.ok(sovTl.effects.some(e => e.effect === 'spear-sovereign-charge' && e.variant === 'default' && e.startFrame === 12));
      for (const beamDir of ['west', 'east', 'south', 'north'] as const) {
        assert.ok(
          sovTl.effects.some(e => e.effect === 'spear-sovereign-beam' && e.variant === beamDir && e.startFrame === 16),
          `万圣龙王破在 ${facing} 朝向下必须在 F16 同时释放 ${beamDir} 方向纯冲击波`,
        );
      }
      assert.equal(sovTl.markers.filter(m => m.kind === 'strike').length, 5, '万圣龙王破应含 3 段能量罩触碰脉冲伤害 + 2 段四向全屏冲击波重创共 5 次命中标记');
      assert.equal(sovTl.appearanceColors, undefined, '万圣龙王破严禁使人物变色（appearanceColors 必须为空）');
      assert.equal(sovTl.afterimages, undefined, 'stationary sovereign-pierce should not draw dash afterimages');
      assert.deepEqual(sovTl.shakeFrames, [17]);
      const sovWestClip = mergedBattle.attackEffects['spear-sovereign-beam']?.clips.west;
      const sovSouthClip = mergedBattle.attackEffects['spear-sovereign-beam']?.clips.south;
      assert.ok(sovWestClip && sovWestClip.frameWidth >= 320, '东西向全屏冲击波单臂宽度应达到全屏跨度 (>= 320px)');
      assert.ok(sovSouthClip && sovSouthClip.frameHeight >= 220, '南北向全屏冲击波单臂高度应达到全屏跨度 (>= 220px)');

      const focusTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-focus-edge', facing, audio, proto.actionTimelines);
      assert.ok(focusTl.appearanceColors && focusTl.appearanceColors.length > 0);
    }
  }

  // 防回归：西向/东向全套长枪姿态绝不含背后翘起旋转手臂（angle !== 0）或刺客猫背胸甲（coat-front[15]），
  // 除行走（walk / town-walk）外的全部西向/东向招式绝不含走路循环腿切片（coat-back[7..10]），
  // 且在多套不同盔甲外观下全部帧的双手臂与长枪切片均有效解析。
  const walkingLegPieces = new Set([7, 8, 9, 10]);
  const armorSamples = [0, 3, 10, 25].map(idx => armorChoices(mergedCatalog, mergedItems, 'body')[idx].id);
  for (const [clip, poseId] of Object.entries(proto.stancePoses)) {
    if (!clip.endsWith('-west') && !clip.endsWith('-east')) continue;
    if (clip.startsWith('spear-die-')) continue;
    const isWalkClip = clip.startsWith('walk-') || clip.startsWith('town-walk-');
    const pose = mergedCatalog.poses[poseId];
    assert.ok(pose, `missing pose ${poseId}`);
    for (let fi = 0; fi < pose.frames.length; fi++) {
      const frame = pose.frames[fi];
      for (const part of frame) {
        if (part.part === 'coat-front') {
          assert.equal(part.angle, 0, `${poseId} F${fi} coat-front[${part.piece}] 不应出现旋转怪手`);
          assert.notEqual(part.piece, 15, `${poseId} F${fi} 不应混用刺客猫背胸甲 coat-front[15]`);
        }
        if (!isWalkClip && part.part === 'coat-back') {
          assert.ok(!walkingLegPieces.has(part.piece), `${poseId} F${fi} 非行走招式不应混用走路腿 coat-back[${part.piece}]`);
        }
      }
      for (const armorId of armorSamples) {
        const recipe = viewerRecipe(mergedCatalog, mergedItems, { 'main-hand': proto.weaponId, body: armorId }, {});
        const pieces = framePieces(mergedCatalog, recipe.variants, frame);
        const minCoatFront = clip.startsWith('town-walk-') ? 2 : 3;
        assert.ok(pieces.filter(p => p.part.part === 'coat-front').length >= minCoatFront, `${poseId} F${fi} (${armorId}) 应含胸甲与有效手臂`);
      }
    }
  }

  // 防回归：狂龙穿心破、虬龙扫暴阵、连环点枪、万圣龙王破四招为纯原地释放，全四向脚部（coat-back）中心不滑步位移。
  const stationarySkills = ['skill-dragon-pierce', 'skill-whirl-sweep', 'skill-flurry-thrust', 'skill-sovereign-pierce'];
  const defaultSpearRecipe = viewerRecipe(mergedCatalog, mergedItems, { 'main-hand': proto.weaponId }, {});
  for (const skillKey of stationarySkills) {
    for (const facing of directions) {
      const poseId = proto.stancePoses[`${skillKey}-${facing}`];
      const pose = mergedCatalog.poses[poseId];
      assert.ok(pose, `missing stationary pose ${poseId}`);
      const sign = pose.mirrorX ? -1 : 1;
      const centers: { cx: number; botY: number }[] = [];
      for (const frame of pose.frames) {
        const leg = framePieces(mergedCatalog, defaultSpearRecipe.variants, frame).find(p => p.part.part === 'coat-back');
        assert.ok(leg, `${poseId} missing coat-back`);
        const ax = leg.part.scaleX < 0 ? leg.sprite.width - leg.sprite.anchorX : leg.sprite.anchorX;
        const left = leg.part.x - ax;
        const right = left + leg.sprite.width;
        const cx = ((left + right) / 2) * sign;
        const botY = leg.part.y - leg.sprite.anchorY + leg.sprite.height;
        assert.ok(Math.abs(cx) <= 2.5, `${poseId} foot center drifted horizontally: ${cx}`);
        centers.push({ cx, botY });
      }
      const dxSpan = Math.max(...centers.map(c => c.cx)) - Math.min(...centers.map(c => c.cx));
      const dySpan = Math.max(...centers.map(c => c.botY)) - Math.min(...centers.map(c => c.botY));
      assert.ok(dxSpan <= 3.5, `${poseId} horizontal foot drift too large: ${dxSpan}`);
      assert.ok(dySpan <= 4, `${poseId} vertical foot drift too large: ${dySpan}`);
    }
  }

  // 防回归：全部北向战斗动作（基础动作、三段普攻、全部主动技能）及四向旋风枪舞在有/无披风状态下，
  // 人物双腿裆部空隙（x ∈ [-4, 4], y ≥ -8）及中轴脚底以下绝不露出任何长枪像素，且突刺不混入短剑头顶悬空手（coat-front[5] y < -30）。
  const loadedTextures = new Map<string, PNG>();
  for (const tex of catalog.textures) {
    loadedTextures.set(tex.key, PNG.sync.read(fs.readFileSync(new URL(tex.file, root))));
  }
  loadedTextures.set(proto.texture.key, PNG.sync.read(pngBytes));

  const northCombatClips = Object.keys(proto.stancePoses).filter(clip =>
    (clip.endsWith('-north') && !clip.startsWith('town-') && clip !== 'spear-die-north')
    || clip.startsWith('skill-spin-storm-'));

  for (const clip of northCombatClips) {
    const poseId = proto.stancePoses[clip];
    const pose = mergedCatalog.poses[poseId];
    assert.ok(pose, `missing pose ${poseId}`);
    for (let fi = 0; fi < pose.frames.length; fi++) {
      const frame = pose.frames[fi];
      // 四向旋风枪舞中包含南向/西向/东向旋转与起收帧，仅对朝北背身帧（body[2]/body[3]）检查双腿间漏枪把
      const spearEntry = frame.find(p => p.part === 'spear');
      const isNorthBodyFrame = frame.some(p => p.part === 'body' && (p.piece === 2 || p.piece === 3));
      if (clip.startsWith('skill-spin-storm-') && !isNorthBodyFrame) {
        continue;
      }
      assert.ok(spearEntry, `${poseId} F${fi} missing spear`);
      for (const part of frame) {
        if (part.part === 'coat-front' && part.piece === 5) {
          assert.ok(part.y > -30, `${poseId} F${fi} 不应混入头顶悬空手臂 coat-front[5]`);
        }
      }
      for (const appearance of [undefined, 'mercenary-olaf'] as const) {
        const variants = viewerRecipe(mergedCatalog, mergedItems, spearEquipment, {}, appearance).variants;
        const pieces = framePieces(mergedCatalog, variants, frame);
        let crotchSpearPixels = 0;
        for (let dy = -8; dy <= 24; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const localX = pose.mirrorX ? -dx : dx;
            let topPart: string | null = null;
            for (const { part, sprite } of pieces) {
              const png = loadedTextures.get(sprite.texture)!;
              const rad = (part.angle * Math.PI) / 180;
              const cos = Math.cos(rad);
              const sin = Math.sin(rad);
              const rx = localX - part.x;
              const ry = dy - part.y;
              const u = (rx * cos + ry * sin) / part.scaleX + sprite.anchorX;
              const v = (-rx * sin + ry * cos) / part.scaleY + sprite.anchorY;
              const sx = Math.floor(u + 1e-6);
              const sy = Math.floor(v + 1e-6);
              if (sx >= 0 && sx < sprite.width && sy >= 0 && sy < sprite.height) {
                const idx = ((sprite.y + sy) * png.width + (sprite.x + sx)) * 4;
                if (png.data[idx + 3] > 20) topPart = part.part;
              }
            }
            if (topPart === 'spear') crotchSpearPixels++;
          }
        }
        assert.equal(crotchSpearPixels, 0, `${clip} (${poseId}) F${fi} [${appearance ?? 'cloak'}] 双腿间露出 ${crotchSpearPixels} 个长枪像素`);
      }
    }
  }

  // 防回归：长枪全部战斗动作（基础直刺/横扫、三段普攻、6 项伤害主动技、3 项增益主动技）在全四向下均具备真实头部动画，
  // 且每帧 head-front、head-back 与脸部 body 的位置/朝向/切片配对严格同步，兼容主角默认发型、多款头盔与奥拉夫佣兵预设。
  const combatHeadActions = [
    'thrust', 'sweep', 'attack', 'attack-2', 'attack-3',
    'skill-dragon-pierce', 'skill-whirl-sweep', 'skill-spin-storm',
    'skill-flurry-thrust', 'skill-dragon-slam', 'skill-sovereign-pierce',
    'skill-focus-edge', 'skill-dragon-step', 'skill-gale-stance',
  ];
  const expectedFaceForHeadPiece: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 0, 5: 1 };
  const headStylesToVerify = [
    viewerRecipe(mergedCatalog, mergedItems, { 'main-hand': proto.weaponId }, {}),
    viewerRecipe(mergedCatalog, mergedItems, { 'main-hand': proto.weaponId, head: armorChoices(mergedCatalog, mergedItems, 'head')[1].id }, {}),
    viewerRecipe(mergedCatalog, mergedItems, { 'main-hand': proto.weaponId, head: armorChoices(mergedCatalog, mergedItems, 'head')[8].id }, {}),
    viewerRecipe(mergedCatalog, mergedItems, { 'main-hand': proto.weaponId }, {}, 'mercenary-olaf'),
  ];
  for (const actionKey of combatHeadActions) {
    for (const facing of directions) {
      const poseId = proto.stancePoses[`${actionKey}-${facing}`];
      const pose = mergedCatalog.poses[poseId];
      assert.ok(pose, `missing combat pose ${poseId}`);
      const headStates = new Set<string>();
      const xs: number[] = [];
      const ys: number[] = [];
      for (let fi = 0; fi < pose.frames.length; fi++) {
        const frame = pose.frames[fi];
        const headFronts = frame.filter(p => p.part === 'head-front');
        const headBacks = frame.filter(p => p.part === 'head-back');
        const bodyFaces = frame.filter(p => p.part === 'body' && p.piece < 4);
        assert.ok(headFronts.length >= 1, `${poseId} F${fi} missing head-front`);
        assert.ok(bodyFaces.length >= 1, `${poseId} F${fi} missing body face`);
        const primary = headFronts[0];
        headStates.add(`${primary.piece}:${primary.x}:${primary.y}:${primary.scaleX}`);
        xs.push(primary.x);
        ys.push(primary.y);
        for (const hf of headFronts) {
          const expectedFace = expectedFaceForHeadPiece[hf.piece];
          assert.notEqual(expectedFace, undefined, `${poseId} F${fi} unexpected head-front piece ${hf.piece}`);
          assert.ok(
            bodyFaces.some(bf => bf.piece === expectedFace && bf.x === hf.x && bf.y === hf.y && bf.scaleX === hf.scaleX),
            `${poseId} F${fi} head-front[${hf.piece}]@(${hf.x},${hf.y},sx=${hf.scaleX}) 未与脸部 body[${expectedFace}] 同步`,
          );
          if (headBacks.length > 0) {
            assert.ok(
              headBacks.some(hb => hb.piece === hf.piece && hb.x === hf.x && hb.y === hf.y && hb.scaleX === hf.scaleX),
              `${poseId} F${fi} head-back 未与 head-front[${hf.piece}]@(${hf.x},${hf.y},sx=${hf.scaleX}) 同步`,
            );
          }
        }
        for (const recipe of headStylesToVerify) {
          const pieces = framePieces(mergedCatalog, recipe.variants, frame);
          assert.ok(pieces.some(p => p.part.part === 'body' && p.part.piece < 4), `${poseId} F${fi} should resolve body face`);
          if (recipe.variants['head-front']) {
            assert.ok(pieces.some(p => p.part.part === 'head-front'), `${poseId} F${fi} should resolve head-front`);
          }
        }
      }
      const dxSpan = Math.max(...xs) - Math.min(...xs);
      const dySpan = Math.max(...ys) - Math.min(...ys);
      assert.ok(headStates.size >= 3, `${actionKey}-${facing} (${poseId}) 头部状态过少（${headStates.size}），存在头部僵直`);
      assert.ok(dxSpan + dySpan >= 2, `${actionKey}-${facing} (${poseId}) 头部总位移过小（dx=${dxSpan}, dy=${dySpan}）`);
    }
  }

  // 防回归：除 360° 旋风枪舞（skill-spin-storm）外，长枪全部 13 项战斗动作在全四向下：
  // 1) 头部只动不转向（严格锁定当前朝向头部切片与正向 scaleX === 1，杜绝 turn-back、跨向转头与北向镜像翻转）；
  // 2) 南/北向全程锁定 head.x === 0 零横晃（杜绝左右甩头或侧跳）；
  // 3) 整段动作水平/纵向位移方向反转次数不超过阈值（单段动作 <= 2 次、二段式连环点枪 <= 3 次，杜绝逐帧啄木鸟抖头与多次反复点头）。
  const nonSpinCombatActions = combatHeadActions.filter(a => a !== 'skill-spin-storm');
  const nonTurningHeadPiecesByFacing: Record<Facing, Set<number>> = {
    south: new Set([0, 4]),
    west: new Set([1, 5]),
    north: new Set([3]),
    east: new Set([1, 5]),
  };
  const countDirectionReversals = (vals: readonly number[]): number => {
    let reversals = 0;
    let prevSign = 0;
    for (let i = 1; i < vals.length; i++) {
      const diff = vals[i] - vals[i - 1];
      if (diff === 0) continue;
      const sign = diff > 0 ? 1 : -1;
      if (prevSign !== 0 && sign !== prevSign) reversals++;
      prevSign = sign;
    }
    return reversals;
  };
  for (const actionKey of nonSpinCombatActions) {
    for (const facing of directions) {
      const poseId = proto.stancePoses[`${actionKey}-${facing}`];
      const pose = mergedCatalog.poses[poseId];
      const allowed = nonTurningHeadPiecesByFacing[facing];
      const xs: number[] = [];
      const ys: number[] = [];
      for (let fi = 0; fi < pose.frames.length; fi++) {
        for (const hf of pose.frames[fi].filter(p => p.part === 'head-front')) {
          assert.ok(
            allowed.has(hf.piece) && hf.scaleX === 1,
            `${actionKey}-${facing} (${poseId}) F${fi} 头部发生转向或镜像：head-front[${hf.piece}](sx=${hf.scaleX})`,
          );
          if (facing === 'south' || facing === 'north') {
            assert.equal(hf.x, 0, `${actionKey}-${facing} (${poseId}) F${fi} 南北向头部不应左右晃动（x=${hf.x}）`);
          }
        }
        const primary = pose.frames[fi].find(p => p.part === 'head-front')!;
        xs.push(primary.x);
        ys.push(primary.y);
      }
      const maxReversals = actionKey === 'skill-flurry-thrust' ? 3 : 2;
      assert.ok(
        countDirectionReversals(xs) <= maxReversals,
        `${actionKey}-${facing} 头部水平方向往复抖动过多（reversals=${countDirectionReversals(xs)}, xs=${xs.join(',')}）`,
      );
      assert.ok(
        countDirectionReversals(ys) <= maxReversals,
        `${actionKey}-${facing} 头部纵向往复点头过多（reversals=${countDirectionReversals(ys)}, ys=${ys.join(',')}）`,
      );
    }
  }

  // 防回归：虬龙扫暴阵四向横扫光弧 spear-gale-sweep 峰值帧（f2）精确对称于各自正方向（南 +90° / 西 ±180° / 北 -90° / 东 0°）。
  const effPng = PNG.sync.read(effBytes);
  // 防回归：万圣龙王破半球能量罩（spear-sovereign-dome）零暗蓝黑边（base 层仅含高亮青/淡金色阶，不压暗灰底），且 f10/f11 结束帧保持原大尺寸原地渐隐消散（绝不向内收缩）。
  {
    const domeClip = proto.attackEffects?.['spear-sovereign-dome']?.clips.default;
    assert.ok(domeClip, 'missing spear-sovereign-dome default clip');
    const baseFile = domeClip.layers[0]!.file;
    const addFile = domeClip.layers[1]!.file;
    const measureDomeFrame = (fi: number) => {
      const baseRect = proto.effectSheet!.frames[proto.effectSheet!.byFile[baseFile]![fi]!]!;
      const addRect = proto.effectSheet!.frames[proto.effectSheet!.byFile[addFile]![fi]!]!;
      let minX = Infinity, maxX = -Infinity, sumAddAlpha = 0;
      for (let y = 0; y < addRect.height; y++) {
        for (let x = 0; x < addRect.width; x++) {
          const bIdx = ((baseRect.y + y) * effPng.width + (baseRect.x + x)) * 4;
          if (effPng.data[bIdx + 3] > 0) {
            assert.ok(
              effPng.data[bIdx] >= 160 && effPng.data[bIdx + 1] >= 220,
              `spear-sovereign-dome f${fi} base 存在压暗灰底的深暗色像素 rgb(${effPng.data[bIdx]},${effPng.data[bIdx + 1]},${effPng.data[bIdx + 2]})`,
            );
            assert.ok(effPng.data[bIdx + 3] <= 90, `spear-sovereign-dome f${fi} base 不透明度过高（${effPng.data[bIdx + 3]}），会产生厚硬粗边`);
          }
          const aAlpha = effPng.data[((addRect.y + y) * effPng.width + (addRect.x + x)) * 4 + 3];
          if (aAlpha >= 8) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            sumAddAlpha += aAlpha;
          }
        }
      }
      return { spanX: maxX - minX, sumAddAlpha };
    };
    const f8 = measureDomeFrame(8);
    const f10 = measureDomeFrame(10);
    const f11 = measureDomeFrame(11);
    assert.ok(Math.abs(f10.spanX - f8.spanX) <= 3, `spear-sovereign-dome f10 不应向内收缩（f8=${f8.spanX}, f10=${f10.spanX}）`);
    assert.ok(Math.abs(f11.spanX - f8.spanX) <= 3, `spear-sovereign-dome f11 不应向内收缩（f8=${f8.spanX}, f11=${f11.spanX}）`);
    assert.ok(f8.sumAddAlpha > f10.sumAddAlpha && f10.sumAddAlpha > f11.sumAddAlpha, 'spear-sovereign-dome f8 -> f10 -> f11 应平滑渐隐消失');
  }
  const expectedCardinalDeg: Record<Facing, number> = { south: 90, west: 180, north: -90, east: 0 };
  for (const facing of directions) {
    const clip = proto.attackEffects?.['spear-gale-sweep']?.clips[facing];
    assert.ok(clip, `missing spear-gale-sweep clip for ${facing}`);
    const frameKey = proto.effectSheet.byFile[clip.layers[0].file]?.[2];
    assert.ok(frameKey, `missing spear-gale-sweep f2 for ${facing}`);
    const rect = proto.effectSheet.frames[frameKey];
    const ox = clip.originX * clip.frameWidth;
    const oy = clip.originY * clip.frameHeight;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const alpha = effPng.data[((rect.y + y) * effPng.width + (rect.x + x)) * 4 + 3];
        if (alpha > 20) {
          sumX += clip.mirrorX ? (ox - x) : (x - ox);
          sumY += y - oy;
          count++;
        }
      }
    }
    assert.ok(count > 0, `spear-gale-sweep ${facing} f2 empty`);
    const deg = (Math.atan2(sumY / count - (-12), sumX / count) * 180) / Math.PI;
    const diff = Math.abs((((deg - expectedCardinalDeg[facing]) + 540) % 360) - 180);
    assert.ok(diff <= 4, `spear-gale-sweep ${facing} 峰值质心方位角 ${deg.toFixed(1)}° 偏离正方向 ${expectedCardinalDeg[facing]}°（差 ${diff.toFixed(1)}°）`);
  }

  // 防回归：全四向全部 14 项战斗动作每帧均使用干净双手（恰好 2 条 0° 手臂 coat-front[3..14]），多套盔甲有效解析；
  // 普攻二段更名为「普攻 · 横扫」且 spear-basic-flick 峰值帧对称于四正方向；
  // 普攻三段「上挑」全四向每帧双手像素均紧贴长枪枪杆（杜绝手枪分离）。
  assert.equal(proto.actionLabels?.['attack-2'], '普攻 · 横扫');
  for (const facing of directions) {
    const clip = proto.attackEffects?.['spear-basic-flick']?.clips[facing];
    assert.ok(clip, `missing spear-basic-flick clip for ${facing}`);
    const frameKey = proto.effectSheet.byFile[clip.layers[0].file]?.[1];
    assert.ok(frameKey, `missing spear-basic-flick f1 for ${facing}`);
    const rect = proto.effectSheet.frames[frameKey];
    const ox = clip.originX * clip.frameWidth;
    const oy = clip.originY * clip.frameHeight;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        if (effPng.data[((rect.y + y) * effPng.width + (rect.x + x)) * 4 + 3] > 20) {
          sumX += clip.mirrorX ? (ox - x) : (x - ox);
          sumY += y - oy;
          count++;
        }
      }
    }
    assert.ok(count > 0);
    const deg = (Math.atan2(sumY / count - (-12), sumX / count) * 180) / Math.PI;
    const diff = Math.abs((((deg - expectedCardinalDeg[facing]) + 540) % 360) - 180);
    assert.ok(diff <= 5, `spear-basic-flick ${facing} 峰值质心方位角 ${deg.toFixed(1)}° 偏离正方向 ${expectedCardinalDeg[facing]}°（差 ${diff.toFixed(1)}°）`);
  }

  for (const actionKey of combatHeadActions) {
    for (const facing of directions) {
      const poseId = proto.stancePoses[`${actionKey}-${facing}`];
      const pose = mergedCatalog.poses[poseId];
      for (let fi = 0; fi < pose.frames.length; fi++) {
        const frame = pose.frames[fi];
        const arms = frame.filter(p => p.part === 'coat-front' && p.piece >= 3 && p.piece <= 14);
        assert.equal(arms.length, 2, `${actionKey}-${facing} (${poseId}) F${fi} 应恰好含 2 条双手持枪手臂，实际 ${arms.length}`);
        for (const arm of arms) {
          assert.equal(arm.angle, 0, `${actionKey}-${facing} (${poseId}) F${fi} coat-front[${arm.piece}] 不应存在旋转手臂`);
        }
        if (facing === 'south' || facing === 'north') {
          for (const armorId of armorSamples) {
            const recipe = viewerRecipe(mergedCatalog, mergedItems, { 'main-hand': proto.weaponId, body: armorId }, {});
            const pieces = framePieces(mergedCatalog, recipe.variants, frame);
            assert.ok(pieces.filter(p => p.part.part === 'coat-front').length >= 3, `${poseId} F${fi} (${armorId}) 应含胸甲与双手`);
          }
        }
      }
    }
  }

  // 普攻三段「上挑」手枪像素级贴合检查：全四向每帧两条手臂的像素包络与长枪像素的最小距离均 <= 4px（严防手枪分离）
  for (const facing of directions) {
    const poseId = proto.stancePoses[`attack-3-${facing}`];
    const pose = mergedCatalog.poses[poseId];
    for (let fi = 0; fi < pose.frames.length; fi++) {
      const pieces = framePieces(mergedCatalog, defaultSpearRecipe.variants, pose.frames[fi]);
      const collectPixels = (entry: (typeof pieces)[number]): [number, number][] => {
        const png = loadedTextures.get(entry.sprite.texture)!;
        const pts: [number, number][] = [];
        for (let sy = 0; sy < entry.sprite.height; sy++) {
          for (let sx = 0; sx < entry.sprite.width; sx++) {
            const alpha = png.data[((entry.sprite.y + sy) * png.width + (entry.sprite.x + sx)) * 4 + 3];
            if (alpha <= 40) continue;
            const wx = entry.part.x + (sx - entry.sprite.anchorX) * entry.part.scaleX;
            const wy = entry.part.y + (sy - entry.sprite.anchorY) * entry.part.scaleY;
            pts.push([wx, wy]);
          }
        }
        return pts;
      };
      const spearEntry = pieces.find(p => p.part.part === 'spear')!;
      const armEntries = pieces.filter(p => p.part.part === 'coat-front' && p.part.piece >= 3 && p.part.piece <= 14);
      const spearPts = collectPixels(spearEntry);
      for (const armEntry of armEntries) {
        const armPts = collectPixels(armEntry);
        let minDist2 = Infinity;
        for (const [ax, ay] of armPts) {
          for (const [sx, sy] of spearPts) {
            const d2 = (ax - sx) * (ax - sx) + (ay - sy) * (ay - sy);
            if (d2 < minDist2) minDist2 = d2;
          }
        }
        const minDist = Math.sqrt(minDist2);
        assert.ok(minDist <= 4, `attack-3-${facing} (${poseId}) F${fi} 手臂 coat-front[${armEntry.part.piece}] 与长枪分离（最小距离 ${minDist.toFixed(1)}px）`);
      }

      // 南北朝向「上挑」顶点帧（F3..F5）采用 ~19° 窄透视陡角切片 #17（既不外飘成 45° 东砍 maxX <= 14，也不硬化成 0° 挡脸竖棍 xSpan >= 14）
      if ((facing === 'south' || facing === 'north') && fi >= 3 && fi <= 5) {
        assert.equal(spearEntry.part.piece, 17, `attack-3-${facing} F${fi} 顶点应使用 ~19° 陡角透视切片 #17`);
        const xs = spearPts.map(([px]) => px);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        assert.ok(maxX <= 14, `attack-3-${facing} F${fi} 枪尖不应外飘成大斜砍（maxX=${maxX}）`);
        assert.ok(maxX - minX >= 14, `attack-3-${facing} F${fi} 枪身不应退化为 0° 鼻梁贴棍（xSpan=${maxX - minX}）`);
      }
    }
  }

  // 防回归：spear-basic-lift 在南/北朝向采用仿原版窄 J 形 3D 透视立弧（峰值帧纵向跨度 >= 48px 且水平延展收束在肩宽附近 <= 18px）
  for (const facing of ['south', 'north'] as const) {
    const clip = proto.attackEffects?.['spear-basic-lift']?.clips[facing];
    assert.ok(clip, `missing spear-basic-lift clip for ${facing}`);
    const ox = clip.originX * clip.frameWidth;
    const frameKey = proto.effectSheet.byFile[clip.layers[0].file]?.[1];
    assert.ok(frameKey, `missing spear-basic-lift f1 for ${facing}`);
    const rect = proto.effectSheet.frames[frameKey];
    let minLx = Infinity, maxLx = -Infinity, minLy = Infinity, maxLy = -Infinity;
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        if (effPng.data[((rect.y + y) * effPng.width + (rect.x + x)) * 4 + 3] > 20) {
          const lx = x - ox;
          if (lx < minLx) minLx = lx;
          if (lx > maxLx) maxLx = lx;
          if (y < minLy) minLy = y;
          if (y > maxLy) maxLy = y;
        }
      }
    }
    assert.ok(maxLy - minLy >= 48, `spear-basic-lift ${facing} f1 纵向挑弧跨度不足（${maxLy - minLy}px）`);
    assert.ok(maxLx <= 20 && maxLx - minLx >= 8, `spear-basic-lift ${facing} f1 水平弧宽应在窄 J 形透视区间内（[${minLx.toFixed(1)}, ${maxLx.toFixed(1)}]）`);
  }

  // 防回归：虬龙扫暴阵南向全程保持正视抬头（head-front[0]、y <= 3）不低头埋胸且南北向零横晃；
  // 万圣龙王破南向盘枪与凝势段（F0..F8）保持正视抬头不低头，南北向消除左右往复甩头。
  {
    const whirlSouth = mergedCatalog.poses[proto.stancePoses['skill-whirl-sweep-south']];
    for (let fi = 0; fi < whirlSouth.frames.length; fi++) {
      const hf = whirlSouth.frames[fi].find(p => p.part === 'head-front')!;
      assert.equal(hf.piece, 0, `skill-whirl-sweep-south F${fi} 不应切入低头切片 head-front[${hf.piece}]`);
      assert.equal(hf.x, 0, `skill-whirl-sweep-south F${fi} 头部不应左右晃动（x=${hf.x}）`);
      assert.ok(hf.y <= 3, `skill-whirl-sweep-south F${fi} 头部下沉过度（y=${hf.y}）`);
    }
    const whirlNorth = mergedCatalog.poses[proto.stancePoses['skill-whirl-sweep-north']];
    for (let fi = 0; fi < whirlNorth.frames.length; fi++) {
      const hf = whirlNorth.frames[fi].find(p => p.part === 'head-front')!;
      assert.equal(hf.x, 0, `skill-whirl-sweep-north F${fi} 头部不应左右乱晃（x=${hf.x}）`);
    }
    const sovSouth = mergedCatalog.poses[proto.stancePoses['skill-sovereign-pierce-south']];
    for (let fi = 0; fi <= 15; fi++) {
      const hf = sovSouth.frames[fi].find(p => p.part === 'head-front')!;
      assert.equal(hf.piece, 0, `skill-sovereign-pierce-south F${fi} 乱舞/蓄核段不应低头（piece=${hf.piece}）`);
      assert.equal(hf.x, 0, `skill-sovereign-pierce-south F${fi} 乱舞/蓄核段头部不应左右晃动（x=${hf.x}）`);
    }
    const sovNorth = mergedCatalog.poses[proto.stancePoses['skill-sovereign-pierce-north']];
    for (let fi = 0; fi < sovNorth.frames.length; fi++) {
      const hf = sovNorth.frames[fi].find(p => p.part === 'head-front')!;
      assert.equal(hf.x, 0, `skill-sovereign-pierce-north F${fi} 头部不应左右乱晃（x=${hf.x}）`);
    }
    // 连环点枪全四向在 F1..F8 高频急刺段保持稳姿定头（不逐帧抽搐切换切片或往复抖动），且南/北向全帧 head.x === 0 零横晃、纵向跨度克制无砸头跳变
    for (const facing of directions) {
      const flurryPose = mergedCatalog.poses[proto.stancePoses[`skill-flurry-thrust-${facing}`]];
      const f1Head = flurryPose.frames[1].find(p => p.part === 'head-front')!;
      for (let fi = 2; fi <= 8; fi++) {
        const hf = flurryPose.frames[fi].find(p => p.part === 'head-front')!;
        assert.equal(hf.piece, f1Head.piece, `skill-flurry-thrust-${facing} F${fi} 急刺段头部不应逐帧闪烁切片`);
        assert.equal(hf.x, f1Head.x, `skill-flurry-thrust-${facing} F${fi} 急刺段头部不应水平抖动`);
        assert.equal(hf.y, f1Head.y, `skill-flurry-thrust-${facing} F${fi} 急刺段头部不应上下抖动`);
      }
    }
    for (const facing of ['south', 'north'] as const) {
      const flurryPose = mergedCatalog.poses[proto.stancePoses[`skill-flurry-thrust-${facing}`]];
      const ys = flurryPose.frames.map((frame, fi) => {
        const hf = frame.find(p => p.part === 'head-front')!;
        assert.equal(hf.x, 0, `skill-flurry-thrust-${facing} F${fi} 头部不应左右晃动（x=${hf.x}）`);
        return hf.y;
      });
      assert.ok(Math.max(...ys) - Math.min(...ys) <= 6, `skill-flurry-thrust-${facing} 纵向头部位移过猛（span=${Math.max(...ys) - Math.min(...ys)}）`);
    }
    // 防回归：西/东朝向全部横扫招式（基础横扫 sweep、普攻二段 attack-2、虬龙扫暴阵 skill-whirl-sweep）枪尖必须扫出饱满 180° 纵深弧幅（北侧 <= -32px 至南侧 >= +18px，总纵向跨度 >= 55px），杜绝缩成小幅平戳。
    const spearPngForSweep = loadedTextures.get(proto.texture.key)!;
    const sweepVariantKeys = proto.variants[proto.variantId];
    for (const sweepAction of ['sweep', 'attack-2', 'skill-whirl-sweep'] as const) {
      for (const facing of ['west', 'east'] as const) {
        const poseId = proto.stancePoses[`${sweepAction}-${facing}`];
        const pose = mergedCatalog.poses[poseId];
        const tipYs: number[] = [];
        const tipXs: number[] = [];
        const sign = pose.mirrorX ? -1 : 1;
        for (const frame of pose.frames) {
          const sp = frame.find(p => p.part === 'spear')!;
          const rect = proto.sprites[sweepVariantKeys[sp.piece]!];
          let sumX = 0;
          let sumY = 0;
          let cnt = 0;
          for (let sy = 0; sy < rect.height; sy++) {
            for (let sx = 0; sx < rect.width; sx++) {
              const idx = ((rect.y + sy) * spearPngForSweep.width + (rect.x + sx)) * 4;
              if (
                spearPngForSweep.data[idx + 3] > 200
                && spearPngForSweep.data[idx] > 205
                && spearPngForSweep.data[idx + 1] > 215
                && spearPngForSweep.data[idx + 2] > 225
              ) {
                sumX += (sp.x + (sx - rect.anchorX) * sp.scaleX) * sign;
                sumY += sp.y + (sy - rect.anchorY) * sp.scaleY;
                cnt++;
              }
            }
          }
          assert.ok(cnt > 0, `${poseId} spear tip pixels missing`);
          tipXs.push(sumX / cnt);
          tipYs.push(sumY / cnt);
        }
        const minTipY = Math.min(...tipYs);
        const maxTipY = Math.max(...tipYs);
        assert.ok(minTipY <= -32, `${sweepAction}-${facing} 横扫北侧起势不足（minTipY=${minTipY.toFixed(1)}）`);
        assert.ok(maxTipY >= 18, `${sweepAction}-${facing} 横扫南侧随挥不足（maxTipY=${maxTipY.toFixed(1)}）`);
        assert.ok(maxTipY - minTipY >= 55, `${sweepAction}-${facing} 横扫纵向运动范围过小（span=${(maxTipY - minTipY).toFixed(1)}）`);
        if (facing === 'west') {
          assert.ok(Math.min(...tipXs) <= -34, `${sweepAction}-west 正西伸展不足`);
        } else {
          assert.ok(Math.max(...tipXs) >= 34, `${sweepAction}-east 正东伸展不足`);
        }
      }
    }
    // 防回归：持枪待机与持枪行走（idle/walk）四向采用单手「~45%..50% 黄金重心平提（Trail Carry）」：
    // 1) 仅由单只握枪手紧贴枪杆（perp <= 2.0px），另一只空手自然垂落/摆臂且与枪杆保持安全净空（perp >= 3.0px，杜绝双手抱枪或枪杆横切空手穿模）；
    // 2) 握枪单手必须落在 42%..53% 黄金重心区间（手前仅露 6~8px 精干木杆接红缨枪头，彻底杜绝 <35% 握太靠后漏长杆或 >55% 握到红缨/枪尖）。
    const measureSingleHandCarry = (poseId: string, fi: number, facing: Facing) => {
      const pose = mergedCatalog.poses[poseId];
      const frame = pose.frames[fi];
      const sp = frame.find(p => p.part === 'spear')!;
      const rect = proto.sprites[sweepVariantKeys[sp.piece]!];
      const allPts: [number, number][] = [];
      let tipSX = 0, tipSY = 0, tipCnt = 0;
      for (let sy = 0; sy < rect.height; sy++) {
        for (let sx = 0; sx < rect.width; sx++) {
          const idx = ((rect.y + sy) * spearPngForSweep.width + (rect.x + sx)) * 4;
          if (spearPngForSweep.data[idx + 3] > 40) {
            allPts.push([sx, sy]);
            if (spearPngForSweep.data[idx] > 205 && spearPngForSweep.data[idx + 1] > 215 && spearPngForSweep.data[idx + 2] > 225) {
              tipSX += sx; tipSY += sy; tipCnt++;
            }
          }
        }
      }
      const tx0 = tipSX / tipCnt, ty0 = tipSY / tipCnt;
      let butt = allPts[0]!, maxD = -1;
      for (const p of allPts) { const d = Math.hypot(p[0] - tx0, p[1] - ty0); if (d > maxD) { maxD = d; butt = p; } }
      let tip = allPts[0]!; maxD = -1;
      for (const p of allPts) { const d = Math.hypot(p[0] - butt[0], p[1] - butt[1]); if (d > maxD) { maxD = d; tip = p; } }
      const bx = sp.x + (butt[0] - rect.anchorX) * sp.scaleX;
      const by = sp.y + (butt[1] - rect.anchorY) * sp.scaleY;
      const tx = sp.x + (tip[0] - rect.anchorX) * sp.scaleX;
      const ty = sp.y + (tip[1] - rect.anchorY) * sp.scaleY;
      const vx = tx - bx, vy = ty - by, vlen = Math.hypot(vx, vy), vlen2 = vx * vx + vy * vy;
      const pieces = framePieces(mergedCatalog, defaultSpearRecipe.variants, frame);
      const arms = pieces.filter(p => p.part.part === 'coat-front' && p.part.piece >= 5);
      const measured = arms.map(({ part, sprite }, idx) => {
        const tex = loadedTextures.get(sprite.texture)!;
        let sumX = 0, sumY = 0, cnt = 0;
        for (let sy = Math.max(0, sprite.height - 5); sy < sprite.height; sy++) {
          for (let sx = 0; sx < sprite.width; sx++) {
            if (tex.data[((sprite.y + sy) * tex.width + (sprite.x + sx)) * 4 + 3] > 30) {
              sumX += part.x + (sx - sprite.anchorX) * part.scaleX;
              sumY += part.y + (sy - sprite.anchorY) * part.scaleY;
              cnt++;
            }
          }
        }
        const hx = sumX / cnt, hy = sumY / cnt;
        const pct = (((hx - bx) * vx + (hy - by) * vy) / vlen2) * 100;
        const perp = Math.abs((hx - bx) * (-vy) + (hy - by) * vx) / vlen;
        const isGrip = facing === 'south'
          ? part.scaleX === -1
          : facing === 'north'
            ? part.scaleX === 1
            : idx === arms.length - 1;
        return { pct, perp, isGrip };
      });
      return {
        span: vlen,
        grip: measured.find(m => m.isGrip)!,
        free: measured.find(m => !m.isGrip)!,
      };
    };

    for (const key of ['idle', 'walk'] as const) {
      for (const facing of directions) {
        const poseId = proto.stancePoses[`${key}-${facing}`];
        const pose = mergedCatalog.poses[poseId];
        for (let fi = 0; fi < pose.frames.length; fi++) {
          const { span, grip, free } = measureSingleHandCarry(poseId, fi, facing);
          if (facing === 'south' || facing === 'north') {
            assert.ok(span >= 37 && span <= 43, `${key}-${facing} F${fi} 南北向 3D 透视总长应在 37..43px，实际 ${span.toFixed(1)}px`);
          } else {
            assert.ok(span >= 48 && span <= 53, `${key}-${facing} F${fi} 东西向平提总长应在 48..53px，实际 ${span.toFixed(1)}px`);
          }
          assert.ok(
            grip.pct >= 42 && grip.pct <= 53,
            `${key}-${facing} F${fi} 单手握位偏离黄金重心（pct=${grip.pct.toFixed(1)}%，应在 42%..53% 以避免漏长杆或摸红缨）`,
          );
          assert.ok(grip.perp <= 2.0, `${key}-${facing} F${fi} 握枪单手未贴合枪杆（perp=${grip.perp.toFixed(1)}px）`);
          assert.ok(free.perp >= 3.0, `${key}-${facing} F${fi} 自由摆动空手与枪杆穿模或变成双手抱枪（free.perp=${free.perp.toFixed(1)}px）`);
        }
      }
    }
    // 防回归：长枪「五段解剖分区与六大动态握把」规范：
    // 1) 突刺/连刺/重刺/聚气动作全四向双拳投影严格落在 0%..66% 合法硬木握杆区（严禁 >66% 摸到金箍红缨/枪刃，或 <-2% 滑出铁镦悬空）；
    // 2) 南向突刺与立枪聚气双拳必须拉开 >=12% 轴向前后握距（杜绝 1px 叠拳）；
    // 3) 西/东向立枪聚气（skill-focus-edge 等）双拳与竖枪法向距离均 <= 4px（杜绝右手叉腰脱杆 13px）。
    const getHandProjections = (poseId: string, fi: number) => {
      const pose = mergedCatalog.poses[poseId];
      const frame = pose.frames[fi];
      const sp = frame.find(p => p.part === 'spear')!;
      const rect = proto.sprites[sweepVariantKeys[sp.piece]!];
      const allPts: [number, number][] = [];
      let tipSX = 0, tipSY = 0, tipCnt = 0;
      for (let sy = 0; sy < rect.height; sy++) {
        for (let sx = 0; sx < rect.width; sx++) {
          const idx = ((rect.y + sy) * spearPngForSweep.width + (rect.x + sx)) * 4;
          if (spearPngForSweep.data[idx + 3] > 40) {
            allPts.push([sx, sy]);
            if (spearPngForSweep.data[idx] > 205 && spearPngForSweep.data[idx + 1] > 215 && spearPngForSweep.data[idx + 2] > 225) {
              tipSX += sx; tipSY += sy; tipCnt++;
            }
          }
        }
      }
      const tx0 = tipSX / tipCnt, ty0 = tipSY / tipCnt;
      let butt = allPts[0]!, maxD = -1;
      for (const p of allPts) { const d = Math.hypot(p[0] - tx0, p[1] - ty0); if (d > maxD) { maxD = d; butt = p; } }
      let tip = allPts[0]!; maxD = -1;
      for (const p of allPts) { const d = Math.hypot(p[0] - butt[0], p[1] - butt[1]); if (d > maxD) { maxD = d; tip = p; } }
      const bx = sp.x + (butt[0] - rect.anchorX) * sp.scaleX;
      const by = sp.y + (butt[1] - rect.anchorY) * sp.scaleY;
      const tx = sp.x + (tip[0] - rect.anchorX) * sp.scaleX;
      const ty = sp.y + (tip[1] - rect.anchorY) * sp.scaleY;
      const vx = tx - bx, vy = ty - by, vlen2 = vx * vx + vy * vy;

      const pieces = framePieces(mergedCatalog, defaultSpearRecipe.variants, frame);
      const arms = pieces.filter(p => p.part.part === 'coat-front' && p.part.piece >= 5);
      return arms.map(({ part, sprite }) => {
        const tex = loadedTextures.get(sprite.texture)!;
        const syStart = Math.max(0, sprite.height - 5);
        const syEnd = sprite.height;
        let sumX = 0, sumY = 0, cnt = 0;
        for (let sy = syStart; sy < syEnd; sy++) {
          for (let sx = 0; sx < sprite.width; sx++) {
            if (tex.data[((sprite.y + sy) * tex.width + (sprite.x + sx)) * 4 + 3] > 30) {
              sumX += part.x + (sx - sprite.anchorX) * part.scaleX;
              sumY += part.y + (sy - sprite.anchorY) * part.scaleY;
              cnt++;
            }
          }
        }
        const hx = sumX / cnt, hy = sumY / cnt;
        const pct = (((hx - bx) * vx + (hy - by) * vy) / vlen2) * 100;
        const perp = Math.abs((hx - bx) * (-vy) + (hy - by) * vx) / Math.sqrt(vlen2);
        return { pct, perp };
      }).sort((a, b) => a.pct - b.pct);
    };

    const thrustAndBuffActions = [
      'thrust', 'attack', 'skill-dragon-pierce', 'skill-flurry-thrust', 'skill-sovereign-pierce', 'skill-focus-edge',
    ] as const;
    for (const actionKey of thrustAndBuffActions) {
      for (const facing of directions) {
        const poseId = proto.stancePoses[`${actionKey}-${facing}`];
        const pose = mergedCatalog.poses[poseId];
        for (let fi = 0; fi < pose.frames.length; fi++) {
          const projs = getHandProjections(poseId, fi);
          assert.equal(projs.length, 2, `${poseId} F${fi} should have 2 hands`);
          for (const h of projs) {
            assert.ok(
              h.pct >= -2 && h.pct <= 55,
              `${actionKey}-${facing} F${fi} 手掌落在非法区（pct=${h.pct.toFixed(1)}%，合法不碰红缨纯木杆区为 0%..55%）`,
            );
          }
          if (facing === 'south') {
            const sep = projs[1].pct - projs[0].pct;
            assert.ok(sep >= 10, `${actionKey}-south F${fi} 双拳前后间距过小（sep=${sep.toFixed(1)}%），存在叠拳现象`);
          }
          if ((actionKey === 'skill-focus-edge' || actionKey === 'skill-sovereign-pierce') && (facing === 'west' || facing === 'east')) {
            for (const h of projs) {
              assert.ok(h.perp <= 4.0, `${actionKey}-${facing} F${fi} 立枪手掌脱杆过远（perp=${h.perp.toFixed(1)}px）`);
            }
          }
        }
      }
    }
  }

  // 美术一致性防回归：
  // 1) 同平面全长长枪切片（#0..#7, #9..#15, #18..#19, #24..#27, #29）最大像素跨度统一在 50.0..53.0px（杜绝 61px 拉伸变形）；
  // 2) 全部 70 套姿态中长枪部件禁止使用 scaleY < 0（保持 100% 顶光高光与红缨重力一致）。
  {
    const spearPng = loadedTextures.get(proto.texture.key)!;
    const fullLengthIndices = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 18, 19, 24, 25, 26, 27, 29];
    const variantKeys = proto.variants[proto.variantId];
    for (const idx of fullLengthIndices) {
      const spriteKey = variantKeys[idx]!;
      const sp = proto.sprites[spriteKey];
      const pts: [number, number][] = [];
      for (let sy = 0; sy < sp.height; sy++) {
        for (let sx = 0; sx < sp.width; sx++) {
          if (spearPng.data[((sp.y + sy) * spearPng.width + (sp.x + sx)) * 4 + 3] > 20) {
            pts.push([sx, sy]);
          }
        }
      }
      let maxD = 0;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
          if (d > maxD) maxD = d;
        }
      }
      assert.ok(maxD >= 50.0 && maxD <= 53.0, `长枪同平面切片 #${idx} (${variantKeys[idx]}) 长度应统一在 50..53px，实际 ${maxD.toFixed(1)}px`);
    }
    for (const [poseId, pose] of Object.entries(proto.poses)) {
      pose.frames.forEach((frame, fi) => {
        for (const p of frame) {
          if (p.part === 'spear') {
            assert.equal(p.scaleY, 1, `${poseId} F${fi} 长枪禁止垂直翻转 scaleY=${p.scaleY}（破坏顶光一致性）`);
          }
        }
      });
    }
  }
});
