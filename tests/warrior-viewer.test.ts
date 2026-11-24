import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  assert.equal(Object.keys(proto.sprites).length, 18);
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
  assert.equal(Object.keys(proto.effectSheet.frames).length, 414);
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
    'skill-sovereign-pierce': 19,
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

      // Check timelines across all 3 basic attacks + 6 damage skills + 3 self-buffs
      const skillsWithEffects = [
        'attack', 'attack-2', 'attack-3', 'thrust',
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
      assert.deepEqual(pierceTl.afterimages?.frames, [4, 5, 6]);
      assert.deepEqual(pierceTl.shakeFrames, [5]);
      assert.ok(pierceTl.effects.some(e => e.effect === 'spear-heavy-pierce' && e.variant === facing));
      assert.ok(pierceTl.effects.some(e => e.effect === 'impact-burst' && e.onTarget));

      const whirlTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-whirl-sweep', facing, audio, proto.actionTimelines);
      assert.equal(whirlTl.markers.filter(m => m.kind === 'strike').length, 3);
      assert.ok(whirlTl.effects.some(e => e.effect === 'spear-flower-spin' && e.variant === facing && e.startFrame === 0));
      assert.ok(whirlTl.effects.some(e => e.effect === 'spear-gale-sweep' && e.variant === facing));

      const spinTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-spin-storm', facing, audio, proto.actionTimelines);
      assert.equal(spinTl.markers.filter(m => m.kind === 'strike').length, 4);
      assert.deepEqual(spinTl.shakeFrames, [3, 7, 11, 14]);
      assert.ok(spinTl.effects.some(e => e.effect === 'spear-spin-storm' && e.variant === facing && e.startFrame === 2));
      assert.ok(spinTl.effects.some(e => e.effect === 'curse-wind-ring' && e.placement === 'ground'));

      const flurryTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-flurry-thrust', facing, audio, proto.actionTimelines);
      assert.equal(flurryTl.markers.filter(m => m.kind === 'strike').length, 3);
      assert.ok(flurryTl.effects.some(e => e.effect === 'spear-flurry-needles' && e.variant === facing));
      assert.ok(flurryTl.effects.some(e => e.effect === 'spear-flurry-finisher' && e.variant === facing));

      const slamTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-dragon-slam', facing, audio, proto.actionTimelines);
      assert.deepEqual(slamTl.shakeFrames, [4]);
      assert.ok(slamTl.effects.some(e => e.effect === 'spear-slam-arc' && e.variant === facing));
      assert.ok(slamTl.effects.some(e => e.effect === 'state-stun' && e.onTarget));

      const sovTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-sovereign-pierce', facing, audio, proto.actionTimelines);
      assert.ok(sovTl.effects.some(e => e.effect === 'spear-sovereign-beam' && e.variant === facing));
      assert.deepEqual(sovTl.afterimages?.frames, [9, 10, 11]);
      assert.deepEqual(sovTl.shakeFrames, [10, 11]);

      const focusTl = actionTimeline(mergedCatalog, mergedItems, mergedBattle, spearEquipment, 'skill-focus-edge', facing, audio, proto.actionTimelines);
      assert.ok(focusTl.appearanceColors && focusTl.appearanceColors.length > 0);
    }
  }
});
