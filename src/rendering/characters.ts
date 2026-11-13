import Phaser from 'phaser';
import type { ActorDefinition, AnimationClip, ClipName, EntityPlacement, Facing } from '../domain/content.ts';
import { STORY_POSE_NAMES } from '../domain/content.ts';
import { idlePoseFrame } from '../domain/basic-attack.ts';
import { blendModeOf } from './blend-modes.ts';
import { applyCharacterVisibility } from './character-visibility.ts';
import { currentAnimationFrame, rememberEffectAnimation } from './effect-animations.ts';
import { characterAtlasEntry, characterFrame, characterFrameList } from './character-atlas.ts';
import { CHARACTER_FOOT_DEPTH_OFFSET } from './depths.ts';

import type { AssetLease } from '../application/assets.ts';
import { retainLoadedSceneAssets } from './scene-assets.ts';
export const PLAYER_MOVE_SPEED = 8 * 1000 / 60;

export interface CharacterVisual {
  entity: EntityPlacement;
  actor: ActorDefinition;
  container: Phaser.GameObjects.Container;
  layers: Phaser.GameObjects.Sprite[];
  clipName: ClipName | null;
  /** 当前动画对应的朝向；动画名统一以 -<朝向> 结尾。 */
  facing: Facing | null;
  flipped?: boolean;
}

interface CharacterSequence {
  actor: ActorDefinition;
  texture: Phaser.Textures.Texture | undefined;
  textureKey: string;
  /** 规范文件路径；同一页可能有多张长条图，光看纹理键分不清。 */
  file: string;
  frames: readonly number[];
  frameDurationMs: number;
  animation: Phaser.Animations.Animation;
  lease?: AssetLease;
}

const characterSequences = new WeakMap<Phaser.GameObjects.Sprite, CharacterSequence>();
const sequenceCleanupInstalled = new WeakSet<Phaser.GameObjects.Sprite>();
const CHARACTER_SEQUENCE_KEY = 'character-action';

function releaseCharacterSequence(sprite: Phaser.GameObjects.Sprite): void {
  const cached = characterSequences.get(sprite);
  if (!cached) return;
  characterSequences.delete(sprite);
  cached.animation.destroy();
  cached.lease?.release();
}

/** 逻辑帧号 → 实际纹理键和帧名；只有动态外观（`file` 为空）继续用原纹理和数字帧。 */
function layerFrame(layer: { key: string; file?: string }, index: number): { key: string; frame: string | number } {
  if (!layer.file) return { key: layer.key, frame: index };
  const frame = characterFrame(layer.file, index);
  if (frame) return frame;
  const mapped = characterAtlasEntry(layer.file)?.pages.length ?? 0;
  throw new Error(mapped
    ? `角色图集帧不足：${layer.file} 需要第 ${index} 帧，只映射了 ${mapped} 帧`
    : `角色图集缺少文件映射：${layer.file}`);
}

/** 每个 Sprite 只保留最近一套动作序列；待机期间保留，换外观或销毁时释放。 */
export function playCharacterLayerSequence(scene: Phaser.Scene, character: CharacterVisual,
  sprite: Phaser.GameObjects.Sprite, layer: AnimationClip['layers'][number], sequence: readonly number[],
  frameDurationMs: number, startFrame = 0): void {
  const frames = sequence.map(index => layerFrame(layer, index));
  const textureKeys = [...new Set(frames.map(frame => frame.key))];
  const textureKey = textureKeys[0] ?? layer.key;
  const texture = scene.textures?.get(textureKey);
  const file = layer.file ?? '';
  let cached = characterSequences.get(sprite);
  const same = cached?.actor === character.actor && cached.texture === texture && cached.textureKey === textureKey
    && cached.file === file && cached.frameDurationMs === frameDurationMs && cached.frames.length === sequence.length
    && sequence.every((frame, index) => cached!.frames[index] === frame);
  if (!same) {
    // 合成外观由 OutfitPool 持有；普通源纹理或图集页由 AssetPool 保留到局部动画释放。
    const lease = layer.file && scene.textures ? retainLoadedSceneAssets(scene, textureKeys) : undefined;
    try {
      releaseCharacterSequence(sprite);
      const animation = sprite.anims.create({ key: CHARACTER_SEQUENCE_KEY,
        frames, frameRate: 1000 / frameDurationMs, repeat: 0 });
      if (!animation) throw new Error(`角色动作序列创建失败：${layer.key}`);
      cached = { actor: character.actor, texture, textureKey, file, frames: [...sequence],
        frameDurationMs, animation, lease };
      characterSequences.set(sprite, cached);
    } catch (error) { lease?.release(); throw error; }
    if (!sequenceCleanupInstalled.has(sprite)) {
      sequenceCleanupInstalled.add(sprite);
      // Sprite 的 preDestroy 会先清 AnimationState；这里通过缓存里的动画对象收尾。
      sprite.once('destroy', () => releaseCharacterSequence(sprite));
    }
  }
  sprite.play({ key: CHARACTER_SEQUENCE_KEY, startFrame });
  sprite.anims.timeScale = 1;
}

const FACING_SUFFIX = /-(north|south|east|west)$/;

export { characterAssets } from './combat-asset-descriptors.ts';

/**
 * 角色当前动画的进度与播放状态，供剧情场景快照保存。
 *
 * Phaser 对单帧动画的 `getProgress()` 返回 NaN（帧进度按 `1/(帧数-1)` 计算），
 * 而快照只接受 0..1 的有限值，所以这里统一收敛：非有限值直接省略。
 */
export function characterAnimationState(character: CharacterVisual): { progress?: number; playing?: boolean } {
  const animation = character.layers[0]?.anims;
  if (!animation?.currentAnim) return {};
  const progress = animation.getProgress();
  return {
    ...(Number.isFinite(progress) ? { progress: Math.min(1, Math.max(0, progress)) } : {}),
    playing: animation.isPlaying
  };
}

/**
 * 动作当前是否要水平镜像。
 *
 * 四向素材（有 `idle-east`/`walk-east` 这类左右动作）已经用 clip 的 `mirrorX` 表达朝向：
 * `walk-east` 是朝西图的原样副本再翻转。地图摆放点的 `flip` 在原版里是「这个点朝东」
 * 的朝向位，不能再当成第二次镜像，否则东西向会正负抵消，角色背对行进方向走。
 * 只有单向素材（灯、火把这类静态对象）仍然靠摆放点的 `flip` 做左右翻转。
 */
export function clipMirrored(clip: AnimationClip, actor: ActorDefinition, entity: Pick<EntityPlacement, 'flip'>): boolean {
  const directional = !!actor.clips['idle-east'] || !!actor.clips['idle-west']
    || !!actor.clips['walk-east'] || !!actor.clips['walk-west'];
  return !!clip.mirrorX !== (directional ? false : !!entity.flip);
}

export function createCharacter(scene: Phaser.Scene, actor: ActorDefinition, entity: EntityPlacement): CharacterVisual {
  const character: CharacterVisual = { entity, actor, container: scene.add.container(entity.x, entity.y).setDepth(entity.y + CHARACTER_FOOT_DEPTH_OFFSET), layers: [], clipName: null, facing: null };
  try { setCharacterClip(scene, character, 'idle-south'); return character; }
  catch (error) { character.container.destroy(); throw error; }
}

/**
 * 按新动作更新图层：复用仍存在的 Sprite，数量变化时才增删，返回该动作的定义。
 * 每次都换一个新的 `character.layers` 数组：数组身份就是这批图层的身份，动作表现收尾时
 * 用它判断画面是否还是自己起手的那一批（见 `isCurrentLayers`），不要改成原地复用数组。
 */
function replaceLayers(scene: Phaser.Scene, character: CharacterVisual, name: ClipName): AnimationClip {
  const clip = character.actor.clips[name];
  if (!clip) throw new Error(`角色动作缺少资源：${character.entity.actor}/${name}`);
  const flipped = clipMirrored(clip, character.actor, character.entity);
  character.clipName = name;
  character.facing = (FACING_SUFFIX.exec(name)?.[1] as Facing | undefined) ?? null;
  character.flipped = flipped;
  const previous = character.layers, layers: Phaser.GameObjects.Sprite[] = [];
  for (let index = 0; index < clip.layers.length; index++) {
    const layer = clip.layers[index];
    let sprite = previous[index];
    const first = layerFrame(layer, 0);
    if (sprite?.scene && sprite.anims) {
      if (characterSequences.get(sprite)?.actor !== character.actor) releaseCharacterSequence(sprite);
      sprite.removeAllListeners('animationcomplete');
      sprite.anims.stop();
      sprite.setTexture(first.key, first.frame).setPosition(0, 0).setVisible(true);
      if (character.container.getIndex(sprite) !== index) character.container.moveTo(sprite, index);
    } else {
      sprite?.destroy();
      sprite = scene.add.sprite(0, 0, first.key, first.frame);
      character.container.addAt(sprite, index);
    }
    // 按共同的脚底锚点镜像，而不是贴图中心；透明度由潜行状态继续维护。
    sprite.setOrigin(clip.originX, clip.originY).setBlendMode(blendModeOf(layer.blend)).setScale(flipped ? -1 : 1, 1);
    sprite.anims.timeScale = 1;
    layers.push(sprite);
  }
  for (let index = clip.layers.length; index < previous.length; index++) previous[index].destroy();
  // 数组身份代表本次动作批次，Sprite 本身可以复用。
  character.layers = layers;
  applyCharacterVisibility(character);
  return clip;
}

/**
 * 播放角色的一个动作。默认在当前动作与目标动作相同时直接返回，保留已经播到的进度。
 *
 * `restart` 为真时重新开始播放，并取得新的图层批次身份，连续同名动作也能重新起手。
 * 普通行走换向沿用上一方向的帧号和帧内时间。
 */
export function setCharacterClip(scene: Phaser.Scene, character: CharacterVisual, name: ClipName, restart = false): void {
    const clip = character.actor.clips[name];
    if (!clip) {
      if (Object.keys(character.actor.clips).length) throw new Error(`角色动作缺少资源：${character.entity.actor}/${name}`);
      return;
    }
    if (!restart && character.clipName === name && character.flipped === clipMirrored(clip, character.actor, character.entity)) return;
    // 转向时保留当前帧号和帧内已过时间，所有图层一起接上。
    const previous = character.clipName?.startsWith('walk-') && name.startsWith('walk-')
      ? character.layers[0]?.anims : null;
    const startFrame = previous?.currentFrame ? currentAnimationFrame(previous) % clip.frames : 0;
    const elapsed = previous?.accumulator ?? 0;
    replaceLayers(scene, character, name);
    // 动作类动画播放一次，行走与待机循环。普攻走 playCharacterSequence，不经过这里。
    // 剧情姿态也播一次：播完停在末帧还是回待机由演出动作的 `hold` 决定，呈现端挂动画完成事件处理。
    const single = name.startsWith('attack-') || name.startsWith('skill-') || name.startsWith('die-')
      || STORY_POSE_NAMES.some(pose => name.startsWith(`${pose}-`));
    clip.layers.forEach((layer, index) => {
      // 图集层的帧分散在页纹理里，动画键要带上实际页；同一页的不同长条图靠文件路径区分。
      const atlasFrames = layer.file ? characterFrameList(layer.file, clip.frames) : [];
      if (layer.file && atlasFrames.length !== clip.frames) {
        const mapped = characterAtlasEntry(layer.file)?.pages.length ?? 0;
        throw new Error(mapped
          ? `角色图集帧不足：${layer.file} 需要 ${clip.frames} 帧，只映射了 ${mapped} 帧`
          : `角色图集缺少文件映射：${layer.file}`);
      }
      const useAtlas = atlasFrames.length === clip.frames;
      const textureKeys = useAtlas ? [...new Set(atlasFrames.map(frame => frame.key))] : [layer.key];
      const animationKey = `${layer.file || layer.key}#${textureKeys.join('+') || layer.key}` +
        `#clip:${clip.frames}:${clip.frameRate}:${single ? 0 : -1}`;
      // 页纹理可能在上一次地图关闭时被释放，而动画还留在全局表里；帧已失效就重建，不能直接播放。
      const existing = typeof scene.anims?.get === 'function' && scene.anims.exists(animationKey)
        ? scene.anims.get(animationKey) : undefined;
      const stale = !!existing?.frames.some(frame => {
        const textureFrame = (frame as unknown as { frame?: { texture?: unknown } }).frame;
        return !!textureFrame && typeof textureFrame === 'object' && !textureFrame.texture;
      });
      if (existing && (!existing.frames.length || stale)) scene.anims.remove(animationKey);
      if (!scene.anims.exists(animationKey)) {
        const frames = useAtlas ? atlasFrames
          : scene.anims.generateFrameNumbers(layer.key, { start: 0, end: clip.frames - 1 });
        if (!scene.textures || frames?.length) {
          scene.anims.create({ key: animationKey, frames, frameRate: clip.frameRate, repeat: single ? 0 : -1 });
          rememberEffectAnimation(scene, animationKey, textureKeys);
        }
      }
      const sprite = character.layers[index];
      if (scene.textures && !scene.anims.exists(animationKey)) return;
      sprite.play({ key: animationKey, startFrame: Math.max(0, Math.min(startFrame, clip.frames - 1)) });
      sprite.anims.timeScale=1;
      sprite.anims.accumulator = elapsed;
    });
}

/**
 * 按逻辑帧序列播放一次动作，每次都从第 0 帧开始，连续同方向攻击也重新起手。
 * 每个逻辑帧都是独立条目，即使重复引用同一张图片也各有自己的序号，
 * 所以素材播完后仍能在第 10 帧这类位置触发事件。动画定义跟着这个 Sprite 走，
 * 不注册到全局 AnimationManager，不同角色的周期设置不会互相影响。
 */
export function playCharacterSequence(scene: Phaser.Scene, character: CharacterVisual, name: ClipName, sequence: number[], frameDurationMs: number): void {
  const clip = replaceLayers(scene, character, name);
  clip.layers.forEach((layer, index) =>
    playCharacterLayerSequence(scene, character, character.layers[index], layer, sequence, frameDurationMs));
}

/**
 * 这批图层是否仍是角色当前画面。剧情投影、换装或另一个动作换过图层后，画面归接手者，
 * 起手的那次表现只能放手：新批次中的 Sprite 已经由别的动作接手。
 */
export function isCurrentLayers(character: CharacterVisual, layers: readonly Phaser.GameObjects.Sprite[]): boolean {
  // 场景关闭会销毁整批 Sprite，但 `character.layers` 仍指着同一个数组；只看数组身份
  // 会漏掉这种情况，收尾再碰销毁后的 `layer.anims` 就会抛进主循环、把画面停住。
  return character.layers === layers && layers.every(layer => !!layer.scene);
}

/**
 * 普攻素材播完后把画面换回待机，让动作收尾接得上。原版 `CHAR_Draw` 在动作计数达到
 * 当前动作源帧数时改画待机动作、按计数取模选帧，所以原版看不到动作演完后僵在末帧。
 *
 * 逻辑帧推进和出手、命中事件不受影响：它们由战斗时钟驱动，与 Sprite 自己的动画无关。
 * 但画面必须只剩一个驱动者——从这一帧起画面交给待机，所以先停掉动作动画；否则它还按
 * 自己的节奏推进，隔几帧就把攻击素材写回贴图，和下面逐帧换的待机画面互相覆盖，
 * 表现就是攻击动画抽搐。待机素材本身已按待机周期补过循环帧，逐帧换过去就是完整的待机动画。
 * 攻击比待机多出的图层（例如发光层）此时没有对应画面，收起。
 */
export function showIdlePose(character: CharacterVisual, facing: Facing, frameIndex: number, sourceFrameCount: number): void {
  const clip = character.actor.clips[`idle-${facing}`];
  if (!clip) return;
  const frame = idlePoseFrame(frameIndex, sourceFrameCount, clip.frames);
  if (frame === null) return;
  const flipped = clipMirrored(clip, character.actor, character.entity);
  character.layers.forEach((sprite, index) => {
    if (sprite.anims.isPlaying) sprite.anims.stop();
    const source = clip.layers[index];
    if (!source) { sprite.setVisible(false); return; }
    const texture = layerFrame(source, frame);
    sprite.setVisible(true).setTexture(texture.key, texture.frame)
      .setOrigin(clip.originX, clip.originY).setScale(flipped ? -1 : 1, 1);
  });
}
