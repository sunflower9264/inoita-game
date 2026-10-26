import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { EFFECT_ATLAS_BY_FILE, EFFECT_ATLAS_PAGES, EFFECT_ATLAS_SOURCE_DIGEST } from '../src/generated/effect-atlas.ts';
import { effectAtlasSourceDigest, EFFECT_ATLAS_TARGETS } from '../tools/build-effect-atlas.ts';
import { effectAssets } from '../src/rendering/combat-asset-descriptors.ts';
import { releaseEffectAnimations, rememberEffectAnimation } from '../src/rendering/effect-animations.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type Phaser from 'phaser';

const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
      export default { BlendModes: { NORMAL: 0, SCREEN: 1, ADD: 2, MULTIPLY: 3 } };
    `)}` }
    : next(specifier, context);
} });
const { createEffect } = await import('../src/rendering/effects.ts');
hook.deregister();

class Node extends EventEmitter {
  active = true; visible = true; alpha = 1; x = 0; y = 0; list: Node[] = [];
  texture = { key: '' }; frame?: string; playConfig?: { key: string; startFrame: number; repeat: number };
  anims = { accumulator: 0 };
  get length(): number { return this.list.length; }
  add(value: Node): this { this.list.push(value); return this; }
  addAt(value: Node): this { return this.add(value); }
  remove(value: Node): this { this.list = this.list.filter(child => child !== value); return this; }
  removeAll(destroy = false): this { for (const child of [...this.list]) { this.remove(child); if (destroy) child.destroy(); } return this; }
  destroy(): void { this.active = false; }
  setOrigin(): this { return this; } setScale(): this { return this; } setBlendMode(): this { return this; }
  setName(): this { return this; } setDepth(): this { return this; } setVisible(): this { return this; }
  setAlpha(): this { return this; } setPosition(): this { return this; }
  play(config: { key: string; startFrame: number; repeat: number }): this { this.playConfig = config; return this; }
}

const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8')) as T;
const battle = read<BattleCatalog>('content/battle.json');

test('特效裁边图集的页面、帧边界和裁剪信息一致', () => {
  assert.ok(EFFECT_ATLAS_PAGES.length > 0, '至少生成一页');
  for (const page of EFFECT_ATLAS_PAGES) {
    const json = read<{ frames: Record<string, { frame: { x: number; y: number; w: number; h: number };
      rotated: boolean; trimmed: boolean;
      spriteSourceSize: { x: number; y: number; w: number; h: number };
      sourceSize: { w: number; h: number } }>; meta: { size: { w: number; h: number } } }>(page.data);
    assert.deepEqual(json.meta.size, { w: page.width, h: page.height }, `${page.key} 尺寸与元数据一致`);
    assert.ok(json.frames[page.frame], `${page.key} 有哨兵帧`);
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    for (const [name, frame] of Object.entries(json.frames)) {
      assert.equal(frame.rotated, false, `${name} 不旋转`);
      assert.equal(frame.trimmed, true, `${name} 记录了裁剪`);
      const { x, y, w, h } = frame.frame;
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= page.width && y + h <= page.height,
        `${name} 在页面内`);
      assert.ok(frame.spriteSourceSize.x >= 0 && frame.spriteSourceSize.y >= 0
        && frame.spriteSourceSize.x + frame.spriteSourceSize.w <= frame.sourceSize.w
        && frame.spriteSourceSize.y + frame.spriteSourceSize.h <= frame.sourceSize.h, `${name} 裁剪信息在原帧内`);
      rects.push({ x, y, w, h });
    }
    for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
      const first = rects[a]!, second = rects[b]!;
      const overlap = first.x < second.x + second.w && second.x < first.x + first.w
        && first.y < second.y + second.h && second.y < first.y + first.h;
      assert.equal(overlap, false, `${page.key} 第 ${a}/${b} 帧重叠`);
    }
  }
});

test('四个大特效的每个图层都有裁边帧，映射与源摘要一致', () => {
  for (const name of EFFECT_ATLAS_TARGETS) {
    const effect = battle.attackEffects[name];
    assert.ok(effect, `目标特效存在：${name}`);
    for (const clip of Object.values(effect.clips)) {
      for (const layer of clip.layers) {
        const frames = EFFECT_ATLAS_BY_FILE[layer.file];
        assert.ok(frames, `图层进入图集：${layer.file}`);
        assert.ok(frames.length >= clip.frames, `${layer.file} 帧数覆盖 ${clip.frames}`);
        for (const frame of frames.slice(0, clip.frames)) {
          const page = EFFECT_ATLAS_PAGES[frame.page];
          assert.ok(page, `页索引有效：${frame.page}`);
          assert.ok(read<{ frames: Record<string, unknown> }>(page.data).frames[frame.frame], `帧存在：${frame.frame}`);
        }
      }
    }
  }
  assert.equal(effectAtlasSourceDigest(), EFFECT_ATLAS_SOURCE_DIGEST, '图集不是旧文件');
});

test('特效资产计划对图集特效只加载图集页，其他特效仍按 spritesheet 加载', () => {
  const target = battle.attackEffects[EFFECT_ATLAS_TARGETS[0]!]!;
  const targetAssets = effectAssets({ [EFFECT_ATLAS_TARGETS[0]!]: target });
  assert.ok(targetAssets.length > 0);
  assert.ok(targetAssets.every(asset => asset.kind === 'atlas'), '目标特效全部走图集页');
  assert.ok(targetAssets.every(asset => asset.key.startsWith('effects-atlas:')), '图集页 key 正确');

  const plain = battle.attackEffects['giant-blow']!;
  const plainAssets = effectAssets({ 'giant-blow': plain });
  assert.ok(plainAssets.length > 0);
  assert.ok(plainAssets.every(asset => asset.kind === 'spritesheet'), '未纳入图集的特效保持原加载方式');
});

test('特效播放走图集帧：每层用页纹理，动画帧按映射顺序排列', () => {
  const animations = new Map<string, { key: string; frames: { key: string; frame: string }[]; frameRate: number }>();
  const nodes: Node[] = [];
  const make = (): Node => { const node = new Node(); nodes.push(node); return node; };
  const textures = new Set(EFFECT_ATLAS_PAGES.map(page => page.key));
  const scene = {
    textures: { exists: (key: string) => textures.has(key) },
    anims: {
      exists: (key: string) => animations.has(key), get: (key: string) => animations.get(key),
      create: (value: { key: string; frames: { key: string; frame: string }[]; frameRate: number }) => {
        animations.set(value.key, value); return value;
      },
      remove: (key: string) => animations.delete(key),
      generateFrameNumbers: () => []
    },
    add: {
      container: (x = 0, y = 0) => { const node = make(); node.x = x; node.y = y; return node; },
      sprite: (x: number, y: number, key: string, frame?: string) => {
        const node = make(); node.x = x; node.y = y; node.texture = { key }; node.frame = frame; return node;
      }
    },
    time: { delayedCall: () => ({ remove() {} }) },
    tweens: { killTweensOf() {} }
  } as unknown as Phaser.Scene;
  const effect = battle.attackEffects['rampage-burst']!;
  const clip = effect.clips.default!;
  const container = createEffect(scene, clip, 10, 20, true) as unknown as Node;
  assert.equal(container.x, 10);
  assert.equal(container.y, 20);
  assert.equal(container.list.length, clip.layers.length, '每层都建了精灵');
  for (const [index, sprite] of container.list.entries()) {
    const layer = clip.layers[index]!;
    const mapping = EFFECT_ATLAS_BY_FILE[layer.file]!;
    assert.ok(mapping, `第 ${index} 层有图集映射`);
    const firstPage = EFFECT_ATLAS_PAGES[mapping[0]!.page]!;
    assert.equal(sprite.texture.key, firstPage.key, `第 ${index} 层使用图集页`);
    const animation = animations.get(`${layer.key}@atlas`);
    assert.ok(animation, `第 ${index} 层创建动画`);
    assert.equal(animation.frames.length, clip.frames, `第 ${index} 层帧数一致`);
    assert.deepEqual(animation.frames[0], { key: firstPage.key, frame: mapping[0]!.frame });
    assert.equal(sprite.playConfig?.key, `${layer.key}@atlas`);
  }
});

test('图集页释放时会清掉引用该页的特效动画', () => {
  const animations = new Set(['anim@atlas']);
  const scene = { anims: { exists: (key: string) => animations.has(key), remove: (key: string) => animations.delete(key) } } as unknown as Phaser.Scene;
  rememberEffectAnimation(scene, 'anim@atlas', ['effects-atlas:0', 'effects-atlas:1']);
  releaseEffectAnimations(scene, 'effects-atlas:1');
  assert.equal(animations.has('anim@atlas'), false, '页释放后动画不再指向缺失纹理');
  releaseEffectAnimations(scene, 'effects-atlas:0');
});
