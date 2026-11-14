import test from 'node:test';
import assert from 'node:assert/strict';
import { DomButton, DomComponent, DomImage } from '../src/ui/dom/components.ts';
import { DomAssets } from '../src/ui/dom/assets.ts';
import { ActionPressGate } from '../src/ui/action-press-gate.ts';
import { DomActionControls } from '../src/ui/dom/action-controls.ts';
import { CONTROL_PARTS, type ControlSkin } from '../src/domain/control-skin.ts';
import fs from 'node:fs';
import { DomStatusHud } from '../src/ui/dom/status-hud.ts';
import type { StatusHudSkin } from '../src/domain/status-hud.ts';
import type { StoryPlayerState } from '../src/domain/story-interface.ts';
import type { PartyActiveSnapshot } from '../src/domain/party.ts';
import { DomMinimap } from '../src/ui/dom/minimap.ts';
import type { WorldMap } from '../src/domain/content.ts';
import { MINIMAP_ASSETS } from '../src/domain/story-interface.ts';
import { DomComputerSkillHud } from '../src/ui/dom/computer-skill-hud.ts';
import { DomCooldown } from '../src/ui/dom/cooldown.ts';
import { DomMoveStick } from '../src/ui/dom/move-stick.ts';
import { ControlSettings } from '../src/application/control-settings.ts';
import { KeyBindingPreferences } from '../src/application/key-bindings.ts';

class Element extends EventTarget {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  hidden = false; removed = false; src = ''; textContent = '';
  children: Element[] = [];
  captures = new Set<number>();
  attributes = new Map<string, string>();
  classList = { add: (..._names: string[]) => {} };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name); }
  append(...children: Element[]) { children.forEach(child => this.appendChild(child)); }
  appendChild(child: Element) { this.children.push(child); return child; }
  remove() { this.removed = true; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
}
function harness() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element(), createElementNS: () => new Element() } });
  const restore = () => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); };
  return { parent: new Element() as unknown as HTMLElement, restore };
}
function pointer(target: HTMLElement, name: string, id: number, x = 20, y = 20, buttons = 1) {
  const event = new Event(name, { cancelable: true });
  Object.assign(event, { pointerId: id, button: 0, clientX: x, clientY: y, buttons });
  target.dispatchEvent(event);
}

test('pointer capture, shared action exclusion and cancellation recover correctly', () => {
  const h = harness();
  try {
    const gate = new ActionPressGate(); let actions = 0;
    const options = { enabled: () => true, trigger: 'down' as const, action: () => { actions++; }, press: (id: number) => gate.press(id), release: (id: number) => gate.release(id) };
    const a = new DomButton(h.parent, options), b = new DomButton(h.parent, options);
    const hit = (a.element as unknown as Element).children[0];
    assert.deepEqual([hit.style.top, hit.style.right, hit.style.bottom, hit.style.left], ['0', '0', '0', '0'], '安卓旧版网页内核可确定热区尺寸');
    pointer(a.element, 'pointerdown', 8); pointer(b.element, 'pointerdown', 9);
    assert.equal(actions, 1);
    pointer(a.element, 'pointercancel', 99);
    pointer(b.element, 'pointerdown', 9);
    assert.equal(actions, 1);
    pointer(a.element, 'pointercancel', 8);
    pointer(b.element, 'pointerdown', 9); assert.equal(actions, 2);
    b.visible(false);
    pointer(a.element, 'pointerdown', 10); assert.equal(actions, 3);
    a.destroy(); b.destroy();
  } finally { h.restore(); }
});

test('release activation requires the same pointer inside the button', () => {
  const h = harness();
  try {
    let actions = 0;
    const button = new DomButton(h.parent, { enabled: () => true, trigger: 'up', action: () => { actions++; } });
    pointer(button.element, 'pointerdown', 1); pointer(button.element, 'pointerup', 2);
    assert.equal(actions, 0);
    pointer(button.element, 'pointerup', 1, 120); assert.equal(actions, 0);
    pointer(button.element, 'pointerdown', 3); pointer(button.element, 'pointerup', 3);
    assert.equal(actions, 1); button.element.dispatchEvent(new Event('click', { cancelable: true }));
    assert.equal(actions, 1); button.destroy();
  } finally { h.restore(); }
});

test('destroying a parent cancels and removes its descendants', () => {
  const h = harness();
  try {
    const parent = new DomComponent(h.parent), child = new DomComponent(parent);
    parent.destroy(); parent.destroy();
    assert.equal(child.signal.aborted, true);
    assert.equal((child.element as unknown as Element).removed, true);
  } finally { h.restore(); }
});

test('cover cropping retains source pixels and releases its asset on destruction', async () => {
  const h = harness();
  try {
    const assets = new DomAssets({ image: async () => ({ width: 200, height: 100 }), atlas: async () => ({ frames: {} }) });
    const image = new DomImage(h.parent).rect({ x: 0, y: 0, width: 50, height: 50 }).fitting('cover');
    await image.load(assets, 'portrait.png');
    const picture = (image.element as unknown as Element).children[0];
    assert.equal(picture.style.width, '100px'); assert.equal(picture.style.left, '-25px');
    image.destroy(); assert.equal(assets.size, 0);
  } finally { h.restore(); }
});

test('a reused DOM image clears its old picture when the next load fails',async()=>{
  const h=harness();
  try{
    let fail=false;
    const assets=new DomAssets({image:async()=>{if(fail)throw new Error('load failed');return {width:10,height:10};},atlas:async()=>({frames:{}})});
    const image=new DomImage(h.parent).rect({x:0,y:0,width:10,height:10});
    await image.load(assets,'first.png');
    const picture=(image.element as unknown as Element).children[0];
    assert.equal(picture.hidden,false);assert.ok(picture.src.includes('first.png'));
    fail=true;
    await assert.rejects(image.load(assets,'broken.png'),/load failed/);
    assert.equal(picture.hidden,true,'加载失败不能继续显示上一张图');
    assert.equal(assets.size,0,'失败后释放旧图片');
    image.destroy();
  }finally{h.restore();}
});

test('DOM wheel dispatches skills and items, respects cooldowns and cancels held actions when hidden', async () => {
  const h = harness();
  try {
    const assets = new DomAssets({ image: async () => ({ width: 94, height: 94 }), atlas: async () => ({ frames: {} }) });
    const skin = Object.fromEntries(CONTROL_PARTS.map(part => [part, `${part}.png`])) as ControlSkin;
    const calls: string[] = [], errors: unknown[] = [];
    const wheel = new DomActionControls(h.parent, skin, { attack: () => calls.push('attack'), skill: id => calls.push(id), item: id => calls.push(id), swap: () => calls.push('swap') }, error => errors.push(error), assets);
    wheel.setShortcutPage([
      { entry: { kind: 'skill', id: 'skill' }, icon: 'skill.png', quantity: 0, enabled: true },
      { entry: { kind: 'item', id: 'potion' }, icon: 'potion.png', quantity: 2, enabled: true }
    ]);
    wheel.visible(true);
    const buttons = (wheel.element as unknown as Element).children;
    pointer(buttons[2] as unknown as HTMLElement, 'pointerdown', 1);
    pointer(buttons[3] as unknown as HTMLElement, 'pointerdown', 2);
    assert.deepEqual(calls, ['skill']);
    wheel.visible(false); wheel.visible(true);
    pointer(buttons[3] as unknown as HTMLElement, 'pointerdown', 2);
    assert.deepEqual(calls, ['skill', 'potion']);
    pointer(buttons[3] as unknown as HTMLElement, 'pointerup', 2);
    wheel.setCooldowns({ skill: { durationMs: 1000, remainingMs: 500 } });
    pointer(buttons[2] as unknown as HTMLElement, 'pointerdown', 3);
    assert.equal(calls.length, 2);
    assert.equal(wheel.snapshot()[0].cooldown?.remainingMs, 500);
    wheel.setCooldowns({});
    pointer(buttons[2] as unknown as HTMLElement, 'pointerdown', 4);
    assert.equal(calls.length, 3);
    wheel.setCooldowns({ skill: { durationMs: 1000, remainingMs: 900 } });
    pointer(buttons[3] as unknown as HTMLElement, 'pointerdown', 5);
    assert.equal(calls.length, 3, '技能进入冷却后，按住它的手指仍拥有动作互斥');
    wheel.destroy();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(assets.size, 0); assert.deepEqual(errors, []);
  } finally { h.restore(); }
});

test('wheel cooldown stays aligned with the current shortcut icon when its size changes', async () => {
  const h = harness();
  try {
    const assets = new DomAssets({ image: async () => ({ width: 94, height: 94 }), atlas: async () => ({ frames: {} }) });
    const skin = Object.fromEntries(CONTROL_PARTS.map(part => [part, `${part}.png`])) as ControlSkin;
    const errors: unknown[] = [];
    const wheel = new DomActionControls(h.parent, skin, { attack: () => {}, skill: () => {}, item: () => {}, swap: () => {} }, error => errors.push(error), assets);
    wheel.layout({ width: 1200, height: 700, insets: { left: 12, right: 8, top: 0, bottom: 6 } }, { 'slot-0': { x: .7, y: .5, scale: 1.4 } });
    const face = (wheel.element as unknown as Element).children[2].children[1];
    const icon = face.children[2], overlay = icon.children[1];
    const aligned = (size: string) => {
      assert.equal(overlay.hidden, false);
      assert.equal(overlay.style.left, '0px'); assert.equal(overlay.style.top, '0px');
      for (const property of ['width', 'height']) assert.equal(overlay.style[property], icon.style[property], property);
      assert.equal(overlay.style.width, size);
      const radius = Number.parseFloat(size) / 2, svg = overlay.children[0];
      assert.equal(svg.style.left, '0'); assert.equal(svg.style.top, '0');
      assert.equal(svg.getAttribute('viewBox'), `${-radius} ${-radius} ${radius * 2} ${radius * 2}`);
    };
    const cooldown = { remainingMs: 500, durationMs: 1000 };
    wheel.setShortcutPage([{ entry: { kind: 'item', id: 'potion' }, icon: 'potion.png', quantity: 2, enabled: true, cooldown }]);
    aligned('64px');
    wheel.setCooldowns({ skill: cooldown });
    wheel.setShortcutPage([{ entry: { kind: 'skill', id: 'skill' }, icon: 'skill.png', quantity: 0, enabled: true }]);
    aligned('75px');
    wheel.setShortcutPage([{ entry: { kind: 'item', id: 'potion' }, icon: 'potion.png', quantity: 2, enabled: true, cooldown }]);
    aligned('64px');
    wheel.destroy(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(assets.size, 0); assert.deepEqual(errors, []);
  } finally { h.restore(); }
});

test('the wheel shield covers the gaps between action buttons', () => {
  const h = harness();
  try {
    const assets = new DomAssets({ image: async () => ({ width: 94, height: 94 }), atlas: async () => ({ frames: {} }) });
    const skin = Object.fromEntries(CONTROL_PARTS.map(part => [part, `${part}.png`])) as ControlSkin;
    const wheel = new DomActionControls(h.parent, skin, { attack: () => {}, skill: () => {}, item: () => {}, swap: () => {} }, () => {}, assets);
    wheel.layout({ width: 1200, height: 700, insets: { left: 12, right: 8, top: 0, bottom: 6 } });
    const root = wheel.element as unknown as Element, shield = root.children[0], attack = root.children[1];
    assert.equal(shield.style.pointerEvents, 'auto', '空白处由挡板接收，不再落到地图');
    assert.equal(shield.getAttribute('aria-hidden'), 'true');
    assert.ok(Number.parseFloat(shield.style.width) > Number.parseFloat(attack.style.width));
    assert.ok(Number.parseFloat(shield.style.height) > Number.parseFloat(attack.style.height));
    assert.ok(Number.parseFloat(shield.style.left) < Number.parseFloat(attack.style.left),
      '挡板从最左的快捷位包到攻击键，按钮之间的空隙也在里面');
    wheel.destroy();
  } finally { h.restore(); }
});

test('DOM status panels switch the controlled portrait, retain dead member artwork and release subscriptions', async () => {
  const h = harness();
  try {
    const skin = JSON.parse(fs.readFileSync(new URL('../public/content/status-hud.json', import.meta.url), 'utf8')) as StatusHudSkin;
    const assets = new DomAssets({ image: async () => ({ width: 300, height: 300 }), atlas: async url => JSON.parse(fs.readFileSync(new URL(`../public/${url}`, import.meta.url), 'utf8')) });
    const hero = { level: 5, health: 90, maxHealth: 100, mana: 50, maxMana: 100, experience: 20, nextLevelExperience: 50 } as StoryPlayerState;
    const ally = { ...hero, id: 'ally', level: 7, health: 0 };
    let controlled = 'player', refresh = () => {}, unsubscribed = 0, focused = 0;
    const selected: string[] = [], errors: unknown[] = [];
    const view = new DomStatusHud(h.parent, skin, {
      readPlayer: () => controlled === 'player' ? hero : ally,
      readHero: () => hero,
      subscribe: callback => { refresh = callback; return () => { unsubscribed++; }; },
      readParty: () => ({ controlled, active: ['player', 'ally'], living: ['player'], members: [ally] }) as unknown as PartyActiveSnapshot,
      portraitFor: id => `${id}.png`, onSelect: id => selected.push(id), onFocus: () => { focused++; }
    }, error => errors.push(error), assets);
    view.layout({ width: 960, height: 640, insets: { top: 0, right: 0, bottom: 0, left: 0 } });
    view.setVisible(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    const roots = (view.element as unknown as Element).children;
    const playerScale=Number(roots[0].style.transform.match(/scale\(([^)]+)\)/)?.[1]);
    assert.ok(Math.abs(Number.parseFloat(roots[0].style.top)+skin.player.inset.top*playerScale)<1e-9,'主角状态栏的可见顶边对齐屏幕');
    const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
    const playerImages = all(roots[0]).filter(node => node.src.endsWith('player.png'));
    const allyImages = all(roots[1]).filter(node => node.src.endsWith('ally.png'));
    assert.equal(playerImages.length, 1); assert.equal(allyImages.length, 1);
    const portraitBox = roots[1].children.find(node => node.children.includes(allyImages[0]))!;
    assert.equal(portraitBox.style.filter, 'brightness(.47)');
    pointer(roots[1] as unknown as HTMLElement, 'pointerdown', 1); pointer(roots[1] as unknown as HTMLElement, 'pointerup', 1);
    pointer(roots[0] as unknown as HTMLElement, 'pointerdown', 2); pointer(roots[0] as unknown as HTMLElement, 'pointerup', 2);
    assert.deepEqual(selected, ['ally']); assert.equal(focused, 1);
    controlled = 'ally'; refresh();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(all(roots[0]).filter(node => node.src.endsWith('ally.png')).length, 1);
    assert.equal(all(roots[1]).filter(node => node.src.endsWith('player.png')).length, 1);
    view.setTarget({ id: 'boss', name: '敌人', health: 100, maxHealth: 200, level: 8, sceneLevel: false, specialRank: 1 });
    const target = roots.at(-1)!;
    assert.equal(target.hidden, false);
    view.setVisible(false); assert.equal(target.hidden, true); assert.equal(roots[0].hidden, true);
    view.destroy(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(unsubscribed, 1); assert.equal(assets.size, 0); assert.deepEqual(errors, []);
  } finally { h.restore(); }
});

test('DOM minimap combines terrain, keeps native marker sizes and reuses or removes markers', async () => {
  const h = harness();
  try {
    const assets = new DomAssets({ image: async () => ({ width: 22, height: 20 }), atlas: async () => ({ frames: {} }) });
    const files = Object.fromEntries(MINIMAP_ASSETS.map(part => [part, `${part}.png`]));
    const map = { id: 'test', columns: 3, rows: 3, tileSize: 16, blocked: [true, true, false, false, false, false, true, false, true], exits: [] } as unknown as WorldMap;
    const errors: unknown[] = [];
    const view = new DomMinimap(h.parent, map, files, error => errors.push(error), assets);
    view.layout({ width: 960, height: 640, insets: { left: 4, top: 2, right: 0, bottom: 0 } });
    view.visible(true);
    const root = view.element as unknown as Element;
    assert.equal(root.children[0].children.length, 2, '地形按通行状态合成两条路径');
    view.updateTasks([{ id: 'quest', x: 16, y: 32, status: 'available' }]);
    const task = root.children.at(-1)!;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(task.style.width, '22px', '标记保持原素材尺寸');
    assert.equal(task.style.transform, 'translate(-50%,-50%)');
    const count = root.children.length;
    view.updateTasks([{ id: 'quest', x: 32, y: 32, status: 'ready' }]);
    assert.equal(root.children.length, count, '同一个任务复用节点');
    assert.equal(task.style.left, '13px');
    view.updateTasks([]); assert.equal(task.removed, true);
    view.updateInteractions([{ id: 'chest', x: 48, y: 16 }]);
    const interaction = root.children.at(-1)!;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(interaction.style.width, '22px', '交互圆环保持原素材尺寸');
    assert.equal(interaction.style.left, '18px');
    const countWithInteraction = root.children.length;
    view.updateInteractions([{ id: 'chest', x: 64, y: 16 }]);
    assert.equal(root.children.length, countWithInteraction, '同一个交互点复用节点');
    assert.equal(interaction.style.left, '23px');
    view.updateInteractions([]); assert.equal(interaction.removed, true);
    assert.equal(view.extent().x, 16); assert.equal(view.extent().y, 2);
    view.destroy(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(assets.size, 0); assert.deepEqual(errors, []);
  } finally { h.restore(); }
});

test('DOM cooldown handles a full circle, fractional seconds, empty and zero-duration cooldowns', () => {
  const h = harness();
  try {
    const parent = new DomComponent(h.parent), view = new DomCooldown(parent);
    const root = view.element as unknown as Element;
    view.update({ remainingMs: 500, durationMs: 1000 }, 32, true);
    assert.equal(root.hidden, false); assert.equal(root.children[1].textContent, '1');
    assert.match(root.children[0].children[0].getAttribute('d')!, /A 32 32/);
    view.update({ remainingMs: 10, durationMs: 0 }, 32, true);
    assert.ok(!root.children[0].children[0].getAttribute('d')!.includes('NaN'));
    view.update({ remainingMs: 0, durationMs: 1000 }, 32, true);
    assert.equal(root.hidden, true); parent.destroy();
  } finally { h.restore(); }
});

test('computer skill row updates native icons, item counts and cooldown seconds without rebuilding cells', async () => {
  const h = harness();
  try {
    const assets = new DomAssets({ image: async () => ({ width: 80, height: 80 }), atlas: async () => ({ frames: {} }) });
    const skin = Object.fromEntries(CONTROL_PARTS.map(part => [part, `${part}.png`])) as ControlSkin;
    const errors: unknown[] = [];
    const row = new DomComputerSkillHud(h.parent, skin, error => errors.push(error), assets);
    row.setPage([{ entry: { kind: 'item', id: 'potion' }, icon: 'potion.png', quantity: 3, enabled: true }]);
    row.layout({ width: 960, height: 640, insets: { left: 0, right: 0, top: 0, bottom: 0 } });
    const root = row.element as unknown as Element, cell = root.children[0];
    const count = root.children.length;
    assert.equal(cell.children.at(-1)!.textContent, '3');
    row.setPage([{ entry: { kind: 'item', id: 'potion' }, icon: 'potion.png', quantity: 2, enabled: true, cooldown: { remainingMs: 1500, durationMs: 2000 } }]);
    assert.equal(root.children.length, count); assert.equal(cell.children.at(-1)!.textContent, '2');
    assert.equal(cell.children[3].children[0].children[1].textContent, '2');
    const icon = cell.children[2], center = cell.children[3], overlay = center.children[0];
    assert.equal(Number.parseFloat(center.style.left) + Number.parseFloat(overlay.style.left), Number.parseFloat(icon.style.left));
    assert.equal(Number.parseFloat(center.style.top) + Number.parseFloat(overlay.style.top), Number.parseFloat(icon.style.top));
    assert.equal(overlay.style.width, icon.style.width); assert.equal(overlay.style.height, icon.style.height);
    assert.equal(root.style.pointerEvents, 'auto', '技能行阻止点击穿透到游戏世界');
    row.destroy(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(assets.size, 0); assert.deepEqual(errors, []);
  } finally { h.restore(); }
});

test('DOM movement switches styles, tracks four directions and recovers from lost or superseded pointers', async () => {
  const h = harness();
  try {
    const settings = new ControlSettings(null);
    const assets = new DomAssets({ image: async () => ({ width: 70, height: 70 }), atlas: async () => ({ frames: {} }) });
    const skin = Object.fromEntries(CONTROL_PARTS.map(part => [part, `${part}.png`])) as ControlSkin;
    const errors: unknown[] = [];
    const stick = new DomMoveStick(h.parent, skin, error => errors.push(error), settings, assets);
    stick.layout({ width: 1000, height: 720, insets: { left: 0, right: 0, top: 0, bottom: 0 } });
    const x = stick.element.style.left;
    settings.setMode('dpad');
    assert.equal(stick.element.style.width, '274px');
    assert.notEqual(stick.element.style.left, x, '较大的圆盘立即重新排布');
    pointer(stick.element, 'pointerdown', 1, 50, 20); assert.deepEqual(stick.axis, { x: 0, y: -1 });
    pointer(stick.element, 'pointermove', 1, 80, 50); assert.deepEqual(stick.axis, { x: 1, y: 0 });
    pointer(stick.element, 'pointermove', 1, 50, 80); assert.deepEqual(stick.axis, { x: 0, y: 1 });
    pointer(stick.element, 'pointermove', 1, 20, 50); assert.deepEqual(stick.axis, { x: -1, y: 0 });
    pointer(stick.element, 'pointerup', 1); assert.deepEqual(stick.axis, { x: 0, y: 0 });
    pointer(stick.element, 'pointerdown', 2, 50, 20);
    pointer(stick.element, 'pointerdown', 3, 80, 50);
    pointer(stick.element, 'pointercancel', 2);
    assert.deepEqual(stick.axis, { x: 1, y: 0 }, '旧指针的取消不影响新指针');
    pointer(stick.element, 'pointermove', 3, 80, 50, 0); assert.deepEqual(stick.axis, { x: 0, y: 0 });
    settings.setMode('stick');
    pointer(stick.element, 'pointerdown', 4, 50, 80); assert.deepEqual(stick.axis, { x: 0, y: 1 });
    stick.setVisible(false); assert.deepEqual(stick.axis, { x: 0, y: 0 });
    stick.destroy(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(assets.size, 0); assert.deepEqual(errors, []);
  } finally { h.restore(); }
});

test('DOM movement honours rebindings, physical key release and keyboard mode while its artwork is hidden', async () => {
  const h = harness();
  try {
    const settings = new ControlSettings(null), bindings = new KeyBindingPreferences(null);
    const assets = new DomAssets({ image: async () => ({ width: 70, height: 70 }), atlas: async () => ({ frames: {} }) });
    const skin = Object.fromEntries(CONTROL_PARTS.map(part => [part, `${part}.png`])) as ControlSkin;
    const stick = new DomMoveStick(h.parent, skin, () => {}, settings, assets);
    const event = (code: string, shiftKey = false) => ({ code, key: code, shiftKey, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, preventDefault() {} }) as KeyboardEvent;
    stick.keyDown(event('KeyW'), bindings); assert.deepEqual(stick.axis, { x: 0, y: -1 });
    stick.keyUp(event('KeyW')); assert.deepEqual(stick.axis, { x: 0, y: 0 });
    bindings.set('move.up', { code: 'ArrowUp', shift: false, ctrl: false, alt: false, meta: false });
    stick.keyDown(event('KeyW'), bindings); assert.deepEqual(stick.axis, { x: 0, y: 0 });
    stick.keyDown(event('ArrowUp'), bindings); assert.deepEqual(stick.axis, { x: 0, y: -1 });
    stick.keyUp(event('ArrowUp'));
    bindings.set('move.up', { code: 'KeyW', shift: true, ctrl: false, alt: false, meta: false });
    stick.keyDown(event('KeyW', true), bindings); stick.keyUp(event('KeyW', false));
    assert.deepEqual(stick.axis, { x: 0, y: 0 }, '先松修饰键也按物理键码清理');
    settings.setMode('keyboard'); assert.equal(stick.element.hidden, true);
    stick.keyDown(event('KeyW', true), bindings); assert.deepEqual(stick.axis, { x: 0, y: -1 });
    stick.keyUp(event('KeyW', true)); settings.setMode('stick'); assert.equal(stick.element.hidden, false);
    stick.setVisible(false); stick.keyDown(event('KeyW', true), bindings); assert.deepEqual(stick.axis, { x: 0, y: 0 });
    stick.destroy(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(assets.size, 0);
  } finally { h.restore(); }
});
