import Phaser from 'phaser';
import type { ActorDefinition, AnimationClip, ClipName, EntityPlacement, Facing } from '../domain/content.ts';
import { STORY_POSE_NAMES } from '../domain/content.ts';
import { idlePoseFrame } from '../domain/basic-attack.ts';
import { blendModeOf } from './blend-modes.ts';
import { applyCharacterVisibility } from './character-visibility.ts';

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
  const character: CharacterVisual = { entity, actor, container: scene.add.container(entity.x, entity.y).setDepth(entity.y + .5), layers: [], clipName: null, facing: null };
  try { setCharacterClip(scene, character, 'idle-south'); return character; }
  catch (error) { character.container.destroy(); throw error; }
}

/**
 * 换一套图层：销毁旧贴图，按新动作的镜像关系建出各图层，返回该动作的定义。
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
  for (const sprite of character.layers) sprite.destroy(); character.layers = [];
  for (const layer of clip.layers) {
    // 按共同的脚底锚点镜像，而不是贴图中心。
    const sprite = scene.add.sprite(0, 0, layer.key).setOrigin(clip.originX, clip.originY)
      .setBlendMode(blendModeOf(layer.blend)).setScale(flipped ? -1 : 1, 1);
    character.container.addAt(sprite, character.layers.length); character.layers.push(sprite);
  }
  applyCharacterVisibility(character);
  return clip;
}

/**
 * 播放角色的一个动作。默认在当前动作与目标动作相同时直接返回，保留已经播到的进度。
 *
 * `restart` 为真时跳过这个优化，强制重建贴图并从第 0 帧重新播放。战斗动作必须用它：
 * `CombatPresenter.play` 把「动作结束」挂在动画完成事件上，而那个事件只有在贴图真的
 * 重新播放之后才会到来；若这里因为同名而提前返回，播的是已经播完的旧动画，事件永远
 * 不会到来，战斗状态就停在「攻击中」，此后普攻和技能都失去响应。
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
    const startFrame = previous?.currentFrame ? (previous.currentFrame.index - 1) % clip.frames : 0;
    const elapsed = previous?.accumulator ?? 0;
    replaceLayers(scene, character, name);
    // 动作类动画播放一次，行走与待机循环。普攻走 playCharacterSequence，不经过这里。
    // 剧情姿态也播一次：播完停在末帧还是回待机由演出动作的 `hold` 决定，呈现端挂动画完成事件处理。
    const single = name.startsWith('attack-') || name.startsWith('skill-') || name.startsWith('die-')
      || STORY_POSE_NAMES.some(pose => name.startsWith(`${pose}-`));
    clip.layers.forEach((layer, index) => {
      if (typeof scene.anims?.get === 'function' && scene.anims.exists(layer.key) && !(scene.anims.get(layer.key)?.frames?.length)) {
        scene.anims.remove(layer.key);
      }
      if (!scene.anims.exists(layer.key)) {
        const frames = scene.anims.generateFrameNumbers(layer.key, { start: 0, end: clip.frames - 1 });
        if (!scene.textures || frames?.length) scene.anims.create({ key: layer.key, frames, frameRate: clip.frameRate, repeat: single ? 0 : -1 });
      }
      const sprite = character.layers[index];
      if (scene.textures && !scene.anims.exists(layer.key)) return;
      sprite.play({ key: layer.key, startFrame: Math.max(0, Math.min(startFrame, clip.frames - 1)) });
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
  clip.layers.forEach((layer, index) => {
    const key = `${layer.key}#${name}#action`;
    const sprite = character.layers[index];
    sprite.anims.create({ key, frames: sequence.map(frame => ({ key: layer.key, frame })), frameRate: 1000 / frameDurationMs, repeat: 0 });
    sprite.play({ key });
  });
}

/**
 * 这批图层是否仍是角色当前画面。剧情投影、换装或另一个动作换过图层后，画面归接手者，
 * 起手的那次表现只能放手：旧 Sprite 已经销毁，新图层的动画也不是它起的。
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
    sprite.setVisible(true).setTexture(source.key, frame)
      .setOrigin(clip.originX, clip.originY).setScale(flipped ? -1 : 1, 1);
  });
}
