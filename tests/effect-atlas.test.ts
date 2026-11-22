import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { atlasImageSize } from './support/atlas-image.ts';
import test from 'node:test';
import { EFFECT_ATLAS_BY_FILE, EFFECT_ATLAS_PAGES, EFFECT_ATLAS_SOURCE_DIGEST } from '../src/generated/effect-atlas.ts';
import { effectAtlasSourceDigest, EFFECT_ATLAS_TARGETS, STORY_EFFECT_TARGETS } from '../tools/build-effect-atlas.ts';
import { effectAssets } from '../src/rendering/combat-asset-descriptors.ts';
import { releaseEffectAnimations, rememberEffectAnimation } from '../src/rendering/effect-animations.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { sourceAssetPath } from '../tools/asset-source.ts';
import type { EffectClip } from '../src/domain/content.ts';
import type Phaser from 'phaser';

const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
      export default { BlendModes: { NORMAL: 0, SCREEN: 1, ADD: 2, MULTIPLY: 3 } };
    `)}` }
    : next(specifier, context);
} });
const { createEffect, effectAtlasAnimationKey } = await import('../src/rendering/effects.ts');
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

interface AtlasFrameJson {
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}
const pageJsonCache = new Map<number, { frames: Record<string, AtlasFrameJson>; meta: { size: { w: number; h: number } } }>();
const pageJson = (index: number): { frames: Record<string, AtlasFrameJson>; meta: { size: { w: number; h: number } } } => {
  const cached = pageJsonCache.get(index);
  if (cached) return cached;
  const parsed = read<{ frames: Record<string, AtlasFrameJson>; meta: { size: { w: number; h: number } } }>(EFFECT_ATLAS_PAGES[index]!.data);
  pageJsonCache.set(index, parsed);
  return parsed;
};

test('特效裁边图集的页面、帧边界和裁剪信息一致', () => {
  assert.ok(EFFECT_ATLAS_PAGES.length > 0, '至少生成一页');
  for (const [index, page] of EFFECT_ATLAS_PAGES.entries()) {
    assert.equal(page.key, `effects-atlas:${index}`, `${page.key} 使用稳定的页 key`);
    assert.equal(page.file, `assets/effect-atlas/effects-${index}.webp`, `${page.key} 图片路径`);
    assert.deepEqual(atlasImageSize(`public/${page.file}`), { w: page.width, h: page.height }, `${page.key} 图片尺寸`);
    assert.equal(page.data, `assets/effect-atlas/effects-${index}.json`, `${page.key} 数据路径`);
    assert.ok(page.width > 0 && page.width <= 2048 && page.height > 0 && page.height <= 2048, `${page.key} 在单页尺寸内`);
    const json = pageJson(index);
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

test('所有战斗特效的每个图层都进入图集，映射覆盖各自的帧序号且与源摘要一致', () => {
  const sourceFiles = new Set<string>();
  let layerCount = 0;
  for (const [effectName, effect] of Object.entries(battle.attackEffects)) {
    assert.ok(EFFECT_ATLAS_TARGETS.includes(effectName), `特效全部纳入图集：${effectName}`);
    for (const clip of Object.values(effect.clips)) {
      for (const layer of clip.layers) {
        if (!layer.file) continue;
        layerCount++;
        sourceFiles.add(layer.file);
        const frames = EFFECT_ATLAS_BY_FILE[layer.file];
        assert.ok(frames, `图层进入图集：${effectName} / ${layer.file}`);
        assert.ok(frames.length >= clip.frames, `${layer.file} 映射帧数 ${frames.length} 覆盖 ${clip.frames}`);
        for (let index = 0; index < clip.frames; index++) {
          const ref = frames[index]!;
          assert.ok(EFFECT_ATLAS_PAGES[ref.page], `${layer.file} 第 ${index} 帧的页索引有效`);
          assert.ok(pageJson(ref.page).frames[ref.frame], `${layer.file} 第 ${index} 帧存在于图集 JSON`);
        }
      }
    }
  }
  assert.ok(layerCount > 0, '战斗内容里有图层文件');
  const world = read<{ storyEffects?: Record<string, { clips: Record<string, EffectClip> }> }>('content/world.json');
  for (const effect of Object.values(world.storyEffects ?? {}))
    for (const clip of Object.values(effect.clips))
      for (const layer of clip.layers) if (layer.file) sourceFiles.add(layer.file);
  // 掉落拾取特效来自 items.json；第一次掉落时才播放，漏收不会在进图时暴露。
  const items = read<{ items: Record<string, { pickup?: { hitDrop?: { directions?: { clip: EffectClip }[] } } }> }>('content/items.json');
  for (const item of Object.values(items.items))
    for (const direction of item.pickup?.hitDrop?.directions ?? [])
      for (const layer of direction.clip.layers) if (layer.file) {
        sourceFiles.add(layer.file);
        const frames = EFFECT_ATLAS_BY_FILE[layer.file];
        assert.ok(frames, `掉落特效进入图集：${layer.file}`);
        assert.ok(frames.length >= direction.clip.frames, `${layer.file} 映射帧数覆盖掉落动画`);
      }
  assert.deepEqual(Object.keys(EFFECT_ATLAS_BY_FILE).sort(), [...sourceFiles].sort(), '映射覆盖所有特效图层文件，且没有多余文件');
  assert.equal(effectAtlasSourceDigest(), EFFECT_ATLAS_SOURCE_DIGEST, '图集不是旧文件');
});

test('内容相同的共用文件只装一次，所有路径映射到同一批帧', () => {
  const pathsByHash = new Map<string, string[]>();
  for (const file of Object.keys(EFFECT_ATLAS_BY_FILE)) {
    const hash = createHash('sha256')
      .update(readFileSync(sourceAssetPath(file)))
      .digest('hex');
    const paths = pathsByHash.get(hash) ?? [];
    paths.push(file);
    pathsByHash.set(hash, paths);
  }
  let shared = 0;
  for (const paths of pathsByHash.values()) {
    if (paths.length < 2) continue;
    shared++;
    const reference = JSON.stringify(EFFECT_ATLAS_BY_FILE[paths[0]!]);
    for (const path of paths.slice(1))
      assert.equal(JSON.stringify(EFFECT_ATLAS_BY_FILE[path]), reference, `共用文件映射一致：${path}`);
  }
  assert.ok(shared > 0, '内容里存在共用文件，common 块生效');
});

test('特效资产计划对每个战斗特效都只加载图集页', () => {
  let checked = 0;
  for (const [name, effect] of Object.entries(battle.attackEffects)) {
    const assets = effectAssets({ [name]: effect });
    assert.ok(assets.length > 0, `${name} 有可加载素材`);
    for (const asset of assets) {
      assert.equal(asset.kind, 'atlas', `${name} 只返回图集页：${asset.key}`);
      assert.ok(asset.key.startsWith('effects-atlas:'), `${name} 图集页 key 正确：${asset.key}`);
    }
    checked++;
  }
  assert.equal(checked, EFFECT_ATLAS_TARGETS.length, '所有攻击特效都检查过');
});

test('剧情特效的每个图层文件也进入图集，资产计划只返回图集页', () => {
  const world = read<{ storyEffects?: Record<string, { clips: Record<string, EffectClip> }> }>('content/world.json');
  const effects = world.storyEffects ?? {};
  assert.deepEqual(Object.keys(effects).sort(), [...STORY_EFFECT_TARGETS].sort(), '剧情特效目标完整');
  assert.ok(STORY_EFFECT_TARGETS.length > 0, '内容里有剧情特效');
  let layerCount = 0;
  for (const [name, effect] of Object.entries(effects)) {
    for (const clip of Object.values(effect.clips)) {
      for (const layer of clip.layers) {
        if (!layer.file) continue;
        layerCount++;
        const frames = EFFECT_ATLAS_BY_FILE[layer.file];
        assert.ok(frames, `剧情特效图层进入图集：${name} / ${layer.file}`);
        assert.ok(frames.length >= clip.frames, `${layer.file} 帧数覆盖 ${clip.frames}`);
        for (let index = 0; index < clip.frames; index++) {
          const ref = frames[index]!;
          assert.ok(pageJson(ref.page).frames[ref.frame], `${layer.file} 第 ${index} 帧存在于图集 JSON`);
        }
      }
    }
    const assets = effectAssets({ [name]: effect });
    assert.ok(assets.length > 0, `${name} 有可加载素材`);
    for (const asset of assets) {
      assert.equal(asset.kind, 'atlas', `${name} 只返回图集页：${asset.key}`);
      assert.ok(asset.key.startsWith('effects-atlas:'), `${name} 图集页 key 正确：${asset.key}`);
    }
  }
  assert.ok(layerCount > 0, '剧情特效里有图层文件');
});

test('小特效共享图集页，页数不会随特效数量线性膨胀', () => {
  const pagesByEffect = new Map<string, Set<number>>();
  const effectsByPage = new Map<number, Set<string>>();
  const collect = (name: string, clips: Record<string, EffectClip>): void => {
    const pages = new Set<number>();
    for (const clip of Object.values(clips)) {
      for (const layer of clip.layers) {
        if (!layer.file) continue;
        for (const frame of (EFFECT_ATLAS_BY_FILE[layer.file] ?? []).slice(0, clip.frames)) {
          pages.add(frame.page);
          const effects = effectsByPage.get(frame.page) ?? new Set<string>();
          effects.add(name);
          effectsByPage.set(frame.page, effects);
        }
      }
    }
    pagesByEffect.set(name, pages);
  };
  for (const [name, effect] of Object.entries(battle.attackEffects)) collect(`attack:${name}`, effect.clips);
  const world = read<{ storyEffects?: Record<string, { clips: Record<string, EffectClip> }> }>('content/world.json');
  for (const [name, effect] of Object.entries(world.storyEffects ?? {})) collect(`story:${name}`, effect.clips);
  const totalEffects = EFFECT_ATLAS_TARGETS.length + STORY_EFFECT_TARGETS.length;
  const counts = [...pagesByEffect.values()].map(pages => pages.size);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const sharedPages = [...effectsByPage.values()].filter(effects => effects.size > 1).length;
  console.log(`特效图集页数统计：${totalEffects} 个特效 / ${EFFECT_ATLAS_PAGES.length} 页；` +
    `每个特效用页 最少 ${min}、最多 ${max}、平均 ${(total / counts.length).toFixed(2)}；` +
    `${sharedPages} 页被多个特效共用`);
  assert.ok(EFFECT_ATLAS_PAGES.length < totalEffects, '页数少于特效数，避免每个特效各占一页');
  assert.ok(sharedPages > 0, '至少有一页被多个特效共用');
  assert.ok(total / counts.length < 2, '平均每个特效用页少于 2，说明小特效在共享页面');
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
    const pages = [...new Set(mapping.slice(0, clip.frames).map(ref => EFFECT_ATLAS_PAGES[ref.page]!.key))];
    const animationKey = effectAtlasAnimationKey(layer, clip, pages);
    const animation = animations.get(animationKey);
    assert.ok(animation, `第 ${index} 层创建动画`);
    assert.equal(animation.frames.length, clip.frames, `第 ${index} 层帧数一致`);
    assert.deepEqual(animation.frames[0], { key: firstPage.key, frame: mapping[0]!.frame });
    assert.equal(sprite.playConfig?.key, animationKey);
  }
});

test('静态特效图层缺少映射、帧数不足或页纹理未加载时直接失败', () => {
  const scene=(textures:Set<string>)=>{
    const animations=new Map<string,{key:string;frames:{key:string;frame:string}[];frameRate:number}>();
    return {
      textures:{exists:(key:string)=>textures.has(key)},
      anims:{exists:(key:string)=>animations.has(key),get:(key:string)=>animations.get(key),
        create:(value:{key:string;frames:{key:string;frame:string}[];frameRate:number})=>{animations.set(value.key,value);return value;},
        remove:(key:string)=>{animations.delete(key);}},
      add:{container:()=>new Node(),sprite:()=>new Node()},
      time:{delayedCall:()=>({remove(){}})}
    } as unknown as Phaser.Scene;
  };
  const base=battle.attackEffects['rampage-burst']!.clips.default!;
  const allPages=new Set(EFFECT_ATLAS_PAGES.map(page=>page.key));

  const unmapped={...base,layers:base.layers.map(layer=>({...layer,file:'assets/missing/effect.png'}))};
  assert.throws(()=>createEffect(scene(allPages),unmapped,0,0),/特效图集缺少文件映射：assets\/missing\/effect\.png/);

  const [file,mapping]=Object.entries(EFFECT_ATLAS_BY_FILE).find(([,refs])=>refs.length>=base.frames)!;
  const layers=base.layers.map(layer=>({...layer,file}));
  assert.throws(()=>createEffect(scene(allPages),{...base,frames:mapping.length+1,layers},0,0),/特效图集帧不足/);

  const missing=new Set(allPages);missing.delete(EFFECT_ATLAS_PAGES[mapping[0]!.page]!.key);
  assert.throws(()=>createEffect(scene(missing),{...base,layers},0,0),/特效图集页纹理未加载/);
});

test('图集动画键包含文件与帧参数，同一图层键不会复用到别的文件', () => {
  const clip = battle.attackEffects['rampage-burst']!.clips.default!;
  const layer = clip.layers[0]!;
  const pages = ['effects-atlas:0'];
  const base = effectAtlasAnimationKey(layer, clip, pages);
  assert.notEqual(effectAtlasAnimationKey({ ...layer, file: 'assets/other-effect/other.png' }, clip, pages), base, '不同文件有不同的动画键');
  assert.notEqual(effectAtlasAnimationKey(layer, { ...clip, frames: clip.frames + 1 }, pages), base, '不同帧数有不同的动画键');
  assert.notEqual(effectAtlasAnimationKey(layer, { ...clip, frameRate: clip.frameRate + 1 }, pages), base, '不同帧率有不同的动画键');
});

test('图集页释放时会清掉引用该页的特效动画', () => {
  const animations = new Set(['anim@atlas']);
  const scene = { anims: { exists: (key: string) => animations.has(key), remove: (key: string) => animations.delete(key) } } as unknown as Phaser.Scene;
  rememberEffectAnimation(scene, 'anim@atlas', ['effects-atlas:0', 'effects-atlas:1']);
  releaseEffectAnimations(scene.anims, 'effects-atlas:1');
  assert.equal(animations.has('anim@atlas'), false, '页释放后动画不再指向缺失纹理');
  releaseEffectAnimations(scene.anims, 'effects-atlas:0');
});
