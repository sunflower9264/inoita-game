import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import type { ActorDefinition, AnimationClip } from '../src/domain/content.ts';
import { sourceAssetPath } from '../tools/asset-source.ts';
import { atlasImageSize } from './support/atlas-image.ts';
import {
  CHARACTER_ATLAS_BY_FILE, CHARACTER_ATLAS_PAGES, CHARACTER_ATLAS_SOURCE_DIGEST
} from '../src/generated/character-atlas.ts';
import { characterAssets } from '../src/rendering/combat-asset-descriptors.ts';
import {
  characterAtlasEntry, characterAtlasPageKeys, characterFrame, characterFrameList
} from '../src/rendering/character-atlas.ts';
import { retainLoadedSceneAssets } from '../src/rendering/scene-assets.ts';
import { characterAtlasSourceDigest, collectCharacterAtlasSource } from '../tools/build-character-atlas.ts';
import { CHARACTER_ATLAS_ALIASES } from '../tools/character-atlas-aliases.ts';

const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? { shortCircuit: true, url: 'data:text/javascript,export default { BlendModes: { NORMAL: 0, SCREEN: 1, ADD: 2, MULTIPLY: 3 } };' }
    : next(specifier, context);
} });
const { createCharacter, setCharacterClip, playCharacterSequence, showIdlePose } =
  await import('../src/rendering/characters.ts');
hook.deregister();

interface AtlasFrameJson {
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}
interface AtlasPageJson { frames: Record<string, AtlasFrameJson>; meta: { size: { w: number; h: number } } }

const pageJson = (index: number): AtlasPageJson =>
  JSON.parse(readFileSync(new URL(`../public/${CHARACTER_ATLAS_PAGES[index]!.data}`, import.meta.url), 'utf8')) as AtlasPageJson;

/** 用真实的图集文件做一个只有 idle/attack 的替身 actor。 */
function actorFor(file: string, frames: number): ActorDefinition {
  const clip = (name: string): AnimationClip => ({
    frameWidth: 16, frameHeight: 16, frames, originX: .5, originY: 1, frameRate: 10, mirrorX: false,
    layers: [{ key: `test-${name}`, file, blend: 'normal' }]
  });
  return {
    id: 'test-atlas-actor', name: '测试', description: '', portrait: null,
    clips: { 'idle-south': clip('idle-south'), 'attack-south': clip('attack-south') }
  };
}

function mappedActor(frames = 4): { actor: ActorDefinition; file: string } {
  const found = Object.entries(CHARACTER_ATLAS_BY_FILE).find(([, entry]) => entry.pages.length >= frames);
  assert.ok(found, '图集至少有一个文件带足够帧');
  const [file] = found;
  return { file, actor: actorFor(file, frames) };
}

test('角色图集生成物与当前内容一致', () => {
  const source = collectCharacterAtlasSource();
  assert.equal(characterAtlasSourceDigest(source), CHARACTER_ATLAS_SOURCE_DIGEST, '运行 npm run atlas:characters');
});

test('每个图集页的图片尺寸、帧边界和 JSON 信息一致且帧不重叠', () => {
  assert.ok(CHARACTER_ATLAS_PAGES.length > 0, '至少生成一页');
  for (const [index, page] of CHARACTER_ATLAS_PAGES.entries()) {
    assert.deepEqual(atlasImageSize(new URL(`../public/${page.file}`, import.meta.url)),
      { w: page.width, h: page.height }, `${index}: 图片尺寸`);
    const json = pageJson(index);
    assert.deepEqual(json.meta.size, { w: page.width, h: page.height }, `${index}: meta 尺寸`);
    const rects: { x: number; y: number; w: number; h: number; name: string }[] = [];
    for (const [name, frame] of Object.entries(json.frames)) {
      const { x, y, w, h } = frame.frame;
      assert.equal(frame.rotated, false, `${index}/${name}: rotated`);
      assert.equal(frame.trimmed, false, `${index}/${name}: 不裁边`);
      assert.deepEqual(frame.spriteSourceSize, { x: 0, y: 0, w, h }, `${index}/${name}: spriteSourceSize`);
      assert.deepEqual(frame.sourceSize, { w, h }, `${index}/${name}: sourceSize`);
      assert.ok(x >= 0 && y >= 0 && x + w <= page.width && y + h <= page.height, `${index}/${name}: 在页内`);
      rects.push({ x, y, w, h, name });
    }
    assert.ok(json.frames[page.frame], `${index}: sentinel 帧存在`);
    for (let left = 0; left < rects.length; left++) {
      const a = rects[left]!;
      for (let right = left + 1; right < rects.length; right++) {
        const b = rects[right]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.equal(overlap, false, `${index}: ${a.name} 与 ${b.name} 重叠`);
      }
    }
  }
});

test('运行时引用的角色文件都有映射，每个动作的帧数都被覆盖', () => {
  const source = collectCharacterAtlasSource();
  const mapped = new Set(Object.keys(CHARACTER_ATLAS_BY_FILE));
  for (const file of Object.keys(source.byFile)) {
    const entry = characterAtlasEntry(file);
    assert.ok(entry, `文件没有映射：${file}`);
    assert.equal(entry.prefix,
      createHash('sha256').update(readFileSync(sourceAssetPath(file))).digest('hex').slice(0, 10),
      `帧名前缀与文件内容不一致：${file}`);
    assert.ok(entry.pages.length > 0, `文件没有帧：${file}`);
    for (const page of entry.pages) assert.ok(CHARACTER_ATLAS_PAGES[page], `${file}: 页 ${page} 不存在`);
  }
  for (const group of source.groups) {
    const file = group.paths[0]!;
    const entry = characterAtlasEntry(file)!;
    assert.ok(entry.pages.length >= group.frames, `${file}: 映射 ${entry.pages.length} 帧 < 引用 ${group.frames} 帧`);
    assert.ok(mapped.has(file), `${file}: 未写入 CHARACTER_ATLAS_BY_FILE`);
  }
  for (const file of mapped) assert.ok(source.byFile[file], `图集里有内容不再引用的文件：${file}`);
});

test('职业选择的 playerActor 和 previewActor 动作都有角色图集映射', () => {
  const catalog = JSON.parse(readFileSync(
    new URL('../public/content/story-classes.json', import.meta.url), 'utf8')) as {
    classes: { playerActor: ActorDefinition; previewActor: ActorDefinition }[];
  };
  const mapped = new Set(Object.keys(CHARACTER_ATLAS_BY_FILE));
  for (const entry of catalog.classes)
    for (const actor of [entry.playerActor, entry.previewActor])
      for (const [clipName, clip] of Object.entries(actor.clips))
        for (const layer of (clip as AnimationClip).layers) {
          if (!layer.file) continue;
          const canonical = CHARACTER_ATLAS_ALIASES[layer.file] ?? layer.file;
          assert.ok(mapped.has(canonical), `${actor.id}/${clipName} → ${layer.file}`);
        }
});

test('characterAssets 对已映射文件只返回图集页，动态外观不返回资源', () => {
  const { actor, file } = mappedActor();
  const assets = characterAssets(actor);
  const entry = characterAtlasEntry(file)!;
  const expectedKeys = [...new Set(entry.pages.slice(0, 4).map(page => CHARACTER_ATLAS_PAGES[page]!.key))].sort();
  assert.deepEqual(assets.map(asset => asset.key).sort(), expectedKeys);
  assert.ok(assets.every(asset => asset.kind === 'atlas'), '不能再返回 spritesheet');
  const first = CHARACTER_ATLAS_PAGES[entry.pages[0]!]!;
  assert.ok(assets.every(asset => asset.kind === 'atlas' && asset.atlas === first.data));

  const dynamic = structuredClone(actor);
  for (const clip of Object.values(dynamic.clips)) for (const layer of clip!.layers) layer.file = '';
  assert.deepEqual(characterAssets(dynamic), []);

  const fallback = structuredClone(actor);
  for (const clip of Object.values(fallback.clips)) {
    clip!.layers[0] = { key: 'unmapped-layer', file: 'assets/characters/__unmapped__.png', blend: 'normal' };
  }
  const sheets = characterAssets(fallback);
  assert.deepEqual(sheets.map(asset => asset.kind), ['spritesheet']);
  assert.equal(sheets[0]!.key, 'unmapped-layer');
});

class FakeAnimationState extends EventEmitter {
  isPlaying = false;
  accumulator = 0;
  timeScale = 1;
  currentFrame?: { index: number };
  created: { key: string; frame: string | number }[] = [];
  played?: { key: string; startFrame: number };
  create(config: { frames: { key: string; frame: string | number }[] }): unknown {
    this.created.push(...config.frames);
    return { frames: [...config.frames], destroy: () => { (config.frames as unknown[]).length = 0; } };
  }
  play(config: { key: string; startFrame?: number }): void {
    this.played = { key: config.key, startFrame: config.startFrame ?? 0 };
    this.currentFrame = { index: (config.startFrame ?? 0) + 1 };
    this.isPlaying = true;
  }
  stop(): void { this.isPlaying = false; }
}

class Sprite extends EventEmitter {
  scene: unknown;
  active = true;
  visible = true;
  alpha = 1;
  x = 0;
  y = 0;
  originX = 0;
  originY = 0;
  scaleX = 1;
  scaleY = 1;
  blendMode = 0;
  parentContainer?: Container;
  texture?: { key: string };
  frame?: { name: string | number };
  anims = new FakeAnimationState();
  constructor(scene: unknown, key: string, frame: string | number = 0) {
    super();
    this.scene = scene;
    this.setTexture(key, frame);
  }
  setTexture(key: string, frame: string | number = 0): this { this.texture = { key }; this.frame = { name: frame }; return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setOrigin(x: number, y: number): this { this.originX = x; this.originY = y; return this; }
  setScale(x: number, y = x): this { this.scaleX = x; this.scaleY = y; return this; }
  setBlendMode(mode: number): this { this.blendMode = mode; return this; }
  setVisible(value: boolean): this { this.visible = value; return this; }
  setAlpha(value: number): this { this.alpha = value; return this; }
  play(config: { key: string; startFrame?: number }): this { this.anims.play(config); return this; }
  destroy(): void {
    if (!this.scene) return;
    this.emit('destroy');
    this.removeAllListeners();
    this.parentContainer?.remove(this);
    this.scene = undefined;
    this.active = false;
  }
}

class Container {
  list: Sprite[] = [];
  active = true;
  setDepth(): this { return this; }
  addAt(sprite: Sprite, index: number): this { this.list.splice(index, 0, sprite); sprite.parentContainer = this; return this; }
  getIndex(sprite: Sprite): number { return this.list.indexOf(sprite); }
  moveTo(sprite: Sprite, index: number): this { this.remove(sprite); this.list.splice(index, 0, sprite); return this; }
  remove(sprite: Sprite): void { const index = this.list.indexOf(sprite); if (index >= 0) this.list.splice(index, 1); }
  destroy(): void { for (const sprite of [...this.list]) sprite.destroy(); this.active = false; }
}

interface AnimationDefinition { frames: { key: string; frame: string | number }[] }

function setupScene() {
  const removed: string[] = [];
  const textures = Object.assign(new EventEmitter(), {
    exists: (key: string) => typeof key === 'string',
    get: (key: string) => ({ key, has: () => true }),
    remove: (key: string) => { removed.push(key); return true; }
  });
  const definitions = new Map<string, AnimationDefinition>();
  const anims = {
    exists: (key: string) => definitions.has(key),
    get: (key: string) => definitions.get(key),
    remove: (key: string) => definitions.delete(key),
    create: (config: AnimationDefinition & { key: string }) => {
      definitions.set(config.key, config);
      return config;
    },
    generateFrameNumbers: () => []
  };
  const scene = {
    textures, anims,
    events: new EventEmitter(),
    add: {
      sprite: (_x: number, _y: number, key: string, frame?: string | number) => new Sprite(scene, key, frame),
      container: () => new Container()
    }
  } as unknown as Phaser.Scene;
  return { scene, definitions, removed };
}

function frameKeys(refs: readonly { key: string }[]): string[] {
  return refs.map(ref => ref.key);
}

test('角色动作播放取到图集页纹理和帧名', () => {
  const { actor, file } = mappedActor();
  const expected = characterFrameList(file, 4);
  assert.equal(expected.length, 4);
  const { scene, definitions } = setupScene();
  const character = createCharacter(scene, actor, { id: 'test', actor: actor.id, x: 0, y: 0 });
  const sprite = character.layers[0] as unknown as Sprite;
  assert.equal(sprite.texture!.key, expected[0]!.key);
  assert.equal(sprite.frame!.name, expected[0]!.frame);

  setCharacterClip(scene, character, 'attack-south', true);
  const animation = [...definitions.values()].find(value =>
    value.frames.length === 4 && value.frames.every((frame, index) => frame.frame === expected[index]!.frame));
  assert.ok(animation, '动作动画使用图集帧名');
  assert.deepEqual(frameKeys(animation.frames), frameKeys(expected));

  playCharacterSequence(scene, character, 'attack-south', [0, 2], 40);
  assert.deepEqual(sprite.anims.created, [expected[0], expected[2]]);

  showIdlePose(character, 'south', 4, 4);
  assert.equal(sprite.texture!.key, expected[0]!.key);
  assert.equal(sprite.frame!.name, expected[0]!.frame);
  character.container.destroy();
});

test('动态外观（file 为空）继续按图层键和数字帧播放', () => {
  const { scene } = setupScene();
  const dynamic = actorFor('', 4);
  const character = createCharacter(scene, dynamic, { id: 'test', actor: dynamic.id, x: 0, y: 0 });
  const sprite = character.layers[0] as unknown as Sprite;
  assert.equal(sprite.texture!.key, 'test-idle-south');
  assert.equal(sprite.frame!.name, 0);
  character.container.destroy();
});

test('静态角色图层缺少图集映射或帧数不足时直接失败', () => {
  const { scene } = setupScene();
  const unmapped = actorFor('assets/characters/__unmapped__.png', 4);
  assert.throws(() => createCharacter(scene, unmapped, { id: 'test', actor: unmapped.id, x: 0, y: 0 }),
    /角色图集缺少文件映射：assets\/characters\/__unmapped__\.png/);

  const [file, entry] = Object.entries(CHARACTER_ATLAS_BY_FILE)[0]!;
  const short = actorFor(file, entry.pages.length + 1);
  assert.throws(() => createCharacter(scene, short, { id: 'test', actor: short.id, x: 0, y: 0 }),
    /角色图集帧不足/);
});

test('同一文件跨页时动画帧和待机帧各自指向正确的页', () => {
  const found = Object.entries(CHARACTER_ATLAS_BY_FILE).find(([, entry]) => new Set(entry.pages).size > 1);
  assert.ok(found, '至少有一个文件跨页');
  const [file, entry] = found;
  const split = entry.pages.findIndex((page, index) => index > 0 && page !== entry.pages[index - 1]);
  assert.ok(split > 0, '找到换页位置');
  assert.notEqual(CHARACTER_ATLAS_PAGES[entry.pages[0]!]!.key, CHARACTER_ATLAS_PAGES[entry.pages[split]!]!.key);
  const expected = characterFrameList(file, entry.pages.length);
  assert.deepEqual(frameKeys(expected), entry.pages.map(page => CHARACTER_ATLAS_PAGES[page]!.key));
  assert.deepEqual(characterAtlasPageKeys(file),
    [...new Set(entry.pages.map(page => CHARACTER_ATLAS_PAGES[page]!.key))]);

  const actor = actorFor(file, entry.pages.length);
  const { scene, definitions, removed } = setupScene();
  const character = createCharacter(scene, actor, { id: 'test', actor: actor.id, x: 0, y: 0 });
  setCharacterClip(scene, character, 'attack-south', true);
  const animation = [...definitions.values()].find(value => value.frames.length === expected.length);
  assert.ok(animation);
  assert.deepEqual(frameKeys(animation.frames), frameKeys(expected), '动画每一帧指向自己所在的页');

  playCharacterSequence(scene, character, 'attack-south', [0, split], 40);
  const sprite = character.layers[0] as unknown as Sprite;
  assert.deepEqual(sprite.anims.created, [expected[0], expected[split]]);

  showIdlePose(character, 'south', entry.pages.length + split, entry.pages.length);
  assert.equal(sprite.texture!.key, expected[split]!.key);
  assert.equal(sprite.frame!.name, expected[split]!.frame);
  character.container.destroy();
  // 序列的租约覆盖它实际用到的两页，释放时两页都归还。
  assert.ok(removed.includes(expected[0]!.key), '释放第一页');
  assert.ok(removed.includes(expected[split]!.key), '释放跨页后的页');
});

test('页释放会删掉引用它的角色动画，下次切动作重新创建', () => {
  const { actor, file } = mappedActor();
  const pageKey = characterFrame(file, 0)!.key;
  const { scene, definitions } = setupScene();
  const character = createCharacter(scene, actor, { id: 'test', actor: actor.id, x: 0, y: 0 });
  assert.ok(definitions.size > 0, '切动作时创建了全局动画');

  // 模拟地图/舞台持有的页租约释放：场景纹理管理器会真正走 releaseEffectAnimations。
  const lease = retainLoadedSceneAssets(scene, [pageKey]);
  lease.release();
  assert.equal(definitions.size, 0, '引用该页的角色动画被删掉');

  setCharacterClip(scene, character, 'idle-south', true);
  assert.ok(definitions.size > 0, '再次切动作重建动画');
  const animation = [...definitions.values()][0]!;
  assert.ok(animation.frames.length > 0);
  assert.equal(animation.frames[0]!.key, pageKey);
  character.container.destroy();
});
