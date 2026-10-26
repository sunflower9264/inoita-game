import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type Phaser from 'phaser';
import type { CharacterVisual } from '../src/rendering/characters.ts';

// `setCharacterClip` 只在需要 Phaser 的显示对象，替身足够。
const hook = registerHooks({ resolve(specifier, context, next) { return specifier === 'phaser'
  ? { url: 'data:text/javascript,export default {BlendModes:{NORMAL:0,SCREEN:1,ADD:2,MULTIPLY:3}}', shortCircuit: true }
  : next(specifier, context); } });
const { setCharacterClip } = await import('../src/rendering/characters.ts');
hook.deregister();

const clip = (key: string, mirrorX = false) => ({ frameWidth: 1, frameHeight: 1, frames: 3, originX: 0, originY: 0,
  frameRate: 10, mirrorX, layers: [{ key, file: 'unused.png', blend: 'normal' }] });

test('story poses play once so the completion event can settle them', () => {
  const created: { key: string; repeat: number }[] = [];
  const scene = {
    anims: {
      exists: () => false,
      create: (definition: { key: string; repeat: number }) => { created.push({ key: definition.key, repeat: definition.repeat }); return definition; },
      generateFrameNumbers: () => [],
    },
    add: { sprite: () => ({ anims: { timeScale: 1 }, setOrigin() { return this; }, setBlendMode() { return this; },
      setScale() { return this; }, play() {}, destroy() {} }) },
  } as unknown as Phaser.Scene;
  const visual = {
    entity: { actor: 'kiyan', flip: false },
    actor: { clips: { 'cry-south': clip('cry-south'), 'look-around-south': clip('look-around-south'),
      'idle-south': clip('idle-south'), 'walk-south': clip('walk-south') } },
    container: { addAt() {} }, layers: [], clipName: null,
  } as unknown as CharacterVisual;
  for (const name of ['cry-south', 'look-around-south', 'idle-south', 'walk-south'] as const) setCharacterClip(scene, visual, name, true);
  // 剧情姿态和其它动作类动画一样播一次（`repeat: 0`），这样播完才会来 `animationcomplete`——
  // 呈现端按演出动作的 `hold` 决定那时停在末帧还是回待机。待机与行走继续循环。
  assert.deepEqual(created, [
    { key: 'cry-south', repeat: 0 }, { key: 'look-around-south', repeat: 0 },
    { key: 'idle-south', repeat: -1 }, { key: 'walk-south', repeat: -1 },
  ]);
});

test('a map placement marked flip does not reverse the direction of walk clips', () => {
  const sprites: { scaleX: number; scaleY: number }[] = [];
  const scene = {
    anims: { exists: () => false, remove() {}, create() {}, generateFrameNumbers: () => [] },
    add: { sprite: () => {
      const sprite = { scaleX: 1, scaleY: 1, anims: { timeScale: 1, accumulator: 0 },
        setOrigin() { return sprite; }, setBlendMode() { return sprite; },
        setScale(x: number, y = 1) { sprite.scaleX = x; sprite.scaleY = y; return sprite; },
        play() { return sprite; }, destroy() {} };
      sprites.push(sprite); return sprite;
    } },
  } as unknown as Phaser.Scene;
  const actor = { id: 'earl-grafton', clips: {
    'idle-south': clip('earl-grafton-idle-south'),
    'walk-south': clip('earl-grafton-walk-south'),
    'walk-west': clip('earl-grafton-walk-west'),
    'walk-east': clip('earl-grafton-walk-east', true),
  } } as unknown as CharacterVisual['actor'];
  for (const flip of [false, true]) {
    const visual = { entity: { id: 'earl-grafton', actor: 'earl-grafton', x: 184, y: 184, flip },
      actor, container: { addAt() {} }, layers: [], clipName: null } as unknown as CharacterVisual;
    for (const [name, expected] of [['walk-east', -1], ['walk-west', 1], ['walk-south', 1]] as const) {
      setCharacterClip(scene, visual, name, true);
      assert.equal(visual.flipped, expected < 0, `${name} flipped（摆放点 flip=${flip}）`);
      assert.equal(sprites.at(-1)!.scaleX, expected, `${name} scaleX（摆放点 flip=${flip}）`);
    }
  }
});

test('a single-direction static actor still uses the placement flip as its mirror', () => {
  const sprites: { scaleX: number }[] = [];
  const scene = {
    anims: { exists: () => false, remove() {}, create() {}, generateFrameNumbers: () => [] },
    add: { sprite: () => {
      const sprite = { scaleX: 1, scaleY: 1, anims: { timeScale: 1, accumulator: 0 },
        setOrigin() { return sprite; }, setBlendMode() { return sprite; },
        setScale(x: number) { sprite.scaleX = x; return sprite; }, play() { return sprite; }, destroy() {} };
      sprites.push(sprite); return sprite;
    } },
  } as unknown as Phaser.Scene;
  const actor = { id: 'lamp-f6c235d6', clips: { 'idle-south': clip('lamp-idle-south') } } as unknown as CharacterVisual['actor'];
  const visual = { entity: { id: 'lamp', actor: 'lamp-f6c235d6', x: 0, y: 0, flip: true },
    actor, container: { addAt() {} }, layers: [], clipName: null } as unknown as CharacterVisual;
  setCharacterClip(scene, visual, 'idle-south', true);
  assert.equal(sprites.at(-1)!.scaleX, -1, '单向素材仍按摆放点镜像');
});
