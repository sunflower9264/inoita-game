import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// 只替换 Phaser 的运行边界；正式界面场景的提示透明度缓存跑真实代码。
const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser' ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
    export default {
      Scene: class { constructor(config) { this.key = typeof config === 'string' ? config : config?.key; } },
      Scenes: { Events: { DESTROY: 'destroy', RESUME: 'resume', PAUSE: 'pause' } },
      BlendModes: { NORMAL: 0, ADD: 1, SCREEN: 2, MULTIPLY: 3 },
      Textures: { FilterMode: { NEAREST: 1 } },
      Input: { Events: { POINTER_MOVE: 'pointermove', POINTER_UP: 'pointerup', POINTER_UP_OUTSIDE: 'pointerupoutside' } },
      Math: { Clamp: (value, min, max) => Math.max(min, Math.min(max, value)) },
      Geom: { Rectangle: class {}, Circle: class {} }
    };
  `)}` } : next(specifier, context);
} });
const { FormalUiView } = await import('../src/ui/formal-ui-view.ts');
hook.deregister();

class FakeLabel {
  readonly element = {} as HTMLDivElement;
  visible = true;
  text = '';
  readonly opacities: string[] = [];
  setText(text: string): this { this.text = text; return this; }
  setPosition(): this { return this; }
  setAnchor(): this { return this; }
  setVisible(visible: boolean): this { this.visible = visible; return this; }
  setStyle(style: Partial<CSSStyleDeclaration>): this {
    if (style.opacity !== undefined) this.opacities.push(style.opacity);
    return this;
  }
  remove(): void {}
}

function fixture() {
  const label = new FakeLabel();
  const ui = {
    instant: { text: '提示', alpha: 1, tick() {} },
    tick() {},
    loadingState: undefined as undefined | { label: string; progress: number },
    defeated: false,
    suspended: false,
    worldRebuildCover: false,
    dialogueLine: undefined,
    choices: undefined,
    quest: undefined,
  };
  const scene = new FormalUiView({} as never,{ ui } as never,{} as never) as unknown as {
    domInstant: FakeLabel;
    update(time: number, delta: number): void;
  };
  scene.domInstant = label;
  return { scene, ui, label };
}

test('instant message opacity is written only when the text or alpha changes', () => {
  const { scene, ui, label } = fixture();
  scene.update(0, 16);
  assert.deepEqual(label.opacities, ['1']);

  scene.update(0, 16);
  assert.deepEqual(label.opacities, ['1'], '透明度没变时不重复写样式');

  ui.instant.alpha = .75;
  scene.update(0, 16);
  assert.deepEqual(label.opacities, ['1', '0.75'], '淡出到下一档才写');

  ui.instant.text = '另一条';
  ui.instant.alpha = 1;
  scene.update(0, 16);
  assert.deepEqual(label.opacities, ['1', '0.75', '1'], '新提示重新写透明度');

  ui.instant.text = '';
  scene.update(0, 16);
  assert.equal(label.visible, false, '提示消失后隐藏标签');

  ui.instant.text = '另一条';
  scene.update(0, 16);
  assert.deepEqual(label.opacities, ['1', '0.75', '1', '1'], '隐藏后再显示重新写透明度');

  const rebuilt = new FakeLabel();
  scene.domInstant = rebuilt;
  scene.update(0, 16);
  assert.deepEqual(rebuilt.opacities, ['1'], '标签重建后缓存不沿用旧节点');
});
