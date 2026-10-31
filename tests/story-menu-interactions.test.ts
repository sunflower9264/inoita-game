import { UI_EVENTS } from '../src/application/ui-events.ts';
import { displaySettings } from '../src/application/display-settings.ts';
import {parseCrafting} from '../src/domain/crafting.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import type { StoryUIContext } from '../src/application/ports.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { WorldIndex } from '../src/domain/content.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { ItemCatalog, EquipmentSlot } from '../src/domain/items.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import { Session } from '../src/domain/session.ts';
import { SaveSlots } from '../src/domain/save-game.ts';
import type { StoryWorldViewSnapshot } from '../src/scenes/world-scene.ts';
import type { MenuPanels } from '../src/domain/menu-panels.ts';
import type { ControlSkin } from '../src/domain/control-skin.ts';
import type { ShopCatalog, Storefront } from '../src/domain/shop.ts';
import type { StoryClassCatalog } from '../src/domain/story-class.ts';
import type { StoryInterface } from '../src/domain/story-interface.ts';
import { ControlLayoutPreferences, CONTROL_IDS, resolveControlLayout, type ControlId } from '../src/ui/control-layout.ts';
import { KeyBindingPreferences } from '../src/application/key-bindings.ts';
import { controlSettings } from '../src/application/control-settings.ts';
import { controlViewport } from '../src/ui/phaser/control-layout-viewport.ts';
import { GameUI } from '../src/ui/game-ui.ts';
import type { ScrollArea, UiSurface } from '../src/ui/phaser/widgets.ts';
import { COMMON_BUTTON } from '../src/ui/common-button.ts';
import { createGmActions } from '../src/debug/gm-actions.ts';
import type { ForgePanel } from '../src/ui/phaser/forge-panel.ts';

// Only Phaser's drawing boundary is replaced. StoryUI, UiSurface, ScrollArea,
// button events, GameUI locks and every domain transaction run their real code.
class Events {
  private listeners = new Map<string, { callback: (...args: any[]) => void; context?: unknown; once: boolean }[]>();
  on(event: string, callback: (...args: any[]) => void, context?: unknown) {
    const listeners = this.listeners.get(event) ?? []; listeners.push({ callback, context, once: false });
    this.listeners.set(event, listeners); return this;
  }
  once(event: string, callback: (...args: any[]) => void, context?: unknown) {
    this.on(event, callback, context); this.listeners.get(event)!.at(-1)!.once = true; return this;
  }
  off(event: string, callback: (...args: any[]) => void, context?: unknown) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter(value => value.callback !== callback || value.context !== context)); return this;
  }
  emit(event: string, ...args: any[]) {
    for (const value of [...this.listeners.get(event) ?? []]) {
      if (value.once) this.off(event, value.callback, value.context);
      value.callback.apply(value.context, args);
    }
    return this;
  }
  removeAllListeners() { this.listeners.clear(); }
}

class Rect {
  x: number; y: number; width: number; height: number;
  constructor(x = 0, y = 0, width = 1, height = 1) { this.x = x; this.y = y; this.width = width; this.height = height; }
  setSize(width: number, height: number) { this.width = width; this.height = height; return this; }
  contains(x: number, y: number) { return x >= this.x && y >= this.y && x <= this.x + this.width && y <= this.y + this.height; }
  static Contains(area: Rect, x: number, y: number) { return area.contains(x, y); }
}

class Display extends Events {
  active = true; visible = true; alpha = 1; depth = 0;
  flipX = false; flipY = false; blendMode = 0;
  x = 0; y = 0; width = 74; height = 74; scaleX = 1; scaleY = 1;
  text = ''; color = ''; texture = { key: '' }; list: Display[] = []; parentContainer?: Display;
  input?: { enabled: boolean; hitArea: Rect; hitAreaCallback?: (area: Rect, x: number, y: number) => boolean };
  private data = new Map<string, any>();
  private wrap?: (value: string) => string;
  private fontSize = 22;
  context = { measureText: (value: string) => ({ width: value.length * this.fontSize * .55 }) };
  constructor(x = 0, y = 0, width = 74, height = 74) { super(); this.x = x; this.y = y; this.width = width; this.height = height; }
  get length() { return this.list.length; }
  setDepth(value: number) { this.depth = value; return this; }
  setPosition(x: number, y: number) { this.x = x; this.y = y; return this; }
  setScale(x: number, y = x) { this.scaleX = x; this.scaleY = y; return this; }
  setSize(width: number, height: number) { this.width = width; this.height = height; return this; }
  setDisplaySize(width: number, height: number) { return this.setSize(width, height); }
  setVisible(value: boolean) { this.visible = value; return this; }
  setAlpha(value: number) { this.alpha = value; return this; }
  setAlign() { return this; }
  bringToTop(value: Display) { this.remove(value); this.add(value); return this; }
  setOrigin() { return this; } setStrokeStyle() { return this; }
  setBlendMode(value: number) { this.blendMode = value; return this; }
  fillStyle() { return this; } slice() { return this; } fillPath() { return this; }
  setFlipX(value = true) { this.flipX = value; return this; }
  setFlipY(value = true) { this.flipY = value; return this; }
  setCrop() { return this; } setMask() { return this; }
  createGeometryMask() { return {}; }
  setData(key: string, value: any) { this.data.set(key, value); return this; }
  getData(key: string): any { return this.data.get(key); }
  setInteractive(area?: Rect, callback?: (area: Rect, x: number, y: number) => boolean) {
    if(!area&&this.input){this.input.enabled=true;return this;}
    this.input = { enabled: true, hitArea: area??new Rect(0,0,this.width,this.height), hitAreaCallback: callback }; return this;
  }
  disableInteractive() { if (this.input) this.input.enabled = false; return this; }
  setWordWrapCallback(callback: (value: string) => string) { this.wrap = callback; return this; }
  setFontSize(value: number) { this.fontSize = value; return this; }
  setText(value: string) {
    this.text = this.wrap?.(value) ?? value;
    this.width = Math.max(...this.text.split('\n').map(row => this.context.measureText(row).width), 0);
    this.height = this.text.split('\n').length * (this.fontSize + 5); return this;
  }
  add(value: Display | Display[]) { for (const child of Array.isArray(value) ? value : [value]) { child.parentContainer?.remove(child); this.list.push(child); child.parentContainer = this; } return this; }
  addAt(value: Display, index: number) { this.add(value); this.list.splice(this.list.indexOf(value), 1); this.list.splice(index, 0, value); return this; }
  remove(value: Display) { this.list = this.list.filter(child => child !== value); if (value.parentContainer === this) value.parentContainer = undefined; return this; }
  removeAll(destroy = false) { for (const child of [...this.list]) { this.remove(child); if (destroy) child.destroy(); } return this; }
  destroy() { if (!this.active) return; this.active = false; this.parentContainer?.remove(this); this.removeAll(true); this.removeAllListeners(); }
  getWorldTransformMatrix(): { scaleX: number; scaleY: number; transformPoint: (x: number, y: number) => { x: number; y: number } } {
    const parent = this.parentContainer?.getWorldTransformMatrix(), scaleX = (parent?.scaleX ?? 1) * this.scaleX, scaleY = (parent?.scaleY ?? 1) * this.scaleY;
    const position = parent?.transformPoint(this.x, this.y) ?? { x: this.x, y: this.y };
    return { scaleX, scaleY, transformPoint: (x, y) => ({ x: position.x + x * scaleX, y: position.y + y * scaleY }) };
  }
  getBounds() { const matrix = this.getWorldTransformMatrix(), position = matrix.transformPoint(0, 0); return new Rect(position.x, position.y, this.width * matrix.scaleX, this.height * matrix.scaleY); }
  get shown(): boolean { return this.active && this.visible && (this.parentContainer?.shown ?? true); }
}

class MaskRectangle extends Display {
  constructor(_scene: unknown, x: number, y: number, width: number, height: number) { super(x, y, width, height); }
}
const boundaryKey = Symbol.for('inotia.story-menu-test.phaser');
Object.defineProperty(globalThis, boundaryKey, { value: { Rect, MaskRectangle }, configurable: true });
const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser' ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
    const boundary=globalThis[Symbol.for('inotia.story-menu-test.phaser')];
    export default {WEBGL:2,Geom:{Rectangle:boundary.Rect},GameObjects:{Rectangle:boundary.MaskRectangle},
      Math:{Clamp:(value,min,max)=>Math.max(min,Math.min(max,value))},BlendModes:{NORMAL:0,ADD:1,SCREEN:2,MULTIPLY:3}};
  `)}` } : next(specifier, context);
} });
const { StoryUI } = await import('../src/ui/story-ui.ts');
hook.deregister();
Object.defineProperties(globalThis, {
  window: { value: { devicePixelRatio: 1 }, configurable: true },
  document: { value: { documentElement: {}, getElementById: (id: string) => id === 'safe-area' ? {} : null, addEventListener() {}, removeEventListener() {} }, configurable: true },
  getComputedStyle: { value: () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0' }), configurable: true }
});

// Drawn objects remain inspectable, but only live, visible objects are returned.
// click() executes the production UiSurface hit callback and pointer handlers.
class MenuScene {
  readonly nodes: Display[] = [];
  readonly events = new Events();
  readonly scale = Object.assign(new Events(), { width: 1024, height: 640 });
  readonly input = Object.assign(new Events(), { keyboard: new Events(), activePointer: { id: 1, x: 0, y: 0, isDown: false }, setDraggable: (object:Display) => object.setData('draggable',true), setDragState: () => {} });
  readonly game = { events: new Events(), renderer: { type: 1 }, canvas: { getBoundingClientRect: () => ({ x: 0, y: 0, width: 1024, height: 640 }) } };
  readonly cameras = { main: {} };
  private readonly imageTextures = new Map<string, Map<string, { width: number; height: number }>>();
  readonly textures = { exists: () => false, get: (key: string) => {
    let frames = this.imageTextures.get(key);
    if (!frames) {
      const bytes = readFileSync(new URL(`../public/${key.replace(/^interface:/, '')}`, import.meta.url));
      frames = new Map([['__BASE', { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }]]);
      this.imageTextures.set(key, frames);
    }
    const source = frames;
    return { get: (frame = '__BASE') => source.get(frame)!, has: (frame: string) => source.has(frame),
      add: (frame: string, _source: number, _x: number, _y: number, width: number, height: number) => {
        const value = { width, height }; source.set(frame, value); return value;
      } };
  } };
  private timers: { callback: () => void; active: boolean }[] = [];
  readonly time = { delayedCall: (_delay: number, callback: () => void) => {
    const timer = { callback, active: true }; this.timers.push(timer);
    return { remove() { timer.active = false; } };
  } };
  hold() { for (const timer of this.timers.splice(0)) if (timer.active) timer.callback(); }
  private make(x = 0, y = 0, width = 74, height = 74) { const value = new Display(x, y, width, height); this.nodes.push(value); return value; }
  readonly add = {
    graphics: () => this.make(),
    container: (x = 0, y = 0) => this.make(x, y), layer: () => this.make(),
    rectangle: (x: number, y: number, width: number, height: number) => this.make(x, y, width, height),
    zone: (x: number, y: number, width: number, height: number) => this.make(x, y, width, height),
    image: (x: number, y: number, key: string, frame?: string) => {
      const size = this.textures.get(key).get(frame), value = this.make(x, y, size.width, size.height);
      value.texture.key = key; return value;
    },
    nineslice: (x: number, y: number, key: string, frame: string | undefined, width: number, height: number,
      left: number, right: number, top: number, bottom: number) => {
      const source=this.textures.get(key).get(frame),threeSlice=top===0&&bottom===0;
      const value=this.make(x,y,Math.max(width,left+right),threeSlice?source.height:Math.max(height,top+bottom));
      value.texture.key=key;
      return value.setData('nineSlice',{sourceWidth:source.width,sourceHeight:source.height,left,right,top,bottom});
    },
    text: (x: number, y: number, value: string, style: { fontSize: number; color?: string }) => {
      const node = this.make(x, y).setFontSize(style.fontSize).setText(value); node.color = style.color ?? ''; return node;
    }
  };
  buttons(label: string) { return this.nodes.filter(node => node.shown && node.getData('uiAction') && node.getData('label') === label); }
  button(label: string) { const buttons = this.buttons(label); assert.equal(buttons.length, 1, `唯一按钮：${label}`); return buttons[0]!; }
  texts() { return this.nodes.filter(node => node.shown && node.text).map(node => node.text); }
  pointAt(button: Display) {
    const area = button.input?.hitArea ?? new Rect(0, 0, button.width, button.height), matrix = button.getWorldTransformMatrix();
    Object.assign(this.input.activePointer, matrix.transformPoint(area.width / 2, area.height / 2));
    return area;
  }
  canHit(button: Display) {
    const area = this.pointAt(button);
    return button.shown && !!button.input?.enabled && (button.input.hitAreaCallback?.(area, area.width / 2, area.height / 2) ?? true);
  }
  press(button: Display) {
    assert(this.canHit(button), `按钮允许按下：${button.getData('label')}`);
    const area = button.input!.hitArea, pointer = this.input.activePointer; pointer.isDown = true;
    this.input.emit('pointerdown', pointer); button.emit('pointerdown', pointer, area.width / 2, area.height / 2, { stopPropagation() {} });
  }
  release(button: Display) {
    const pointer = this.input.activePointer;
    pointer.isDown = false; button.emit('pointerup', pointer); this.input.emit('pointerup', pointer);
  }
  tryClick(button: Display) { if (!this.canHit(button)) return false; this.press(button); this.release(button); return true; }
  click(button: Display) { assert(this.tryClick(button), `按钮可点击：${button.getData('label')}`); }
  key(key: string, shiftKey = false) {
    let prevented = false;
    this.input.keyboard.emit('keydown', { key, shiftKey, preventDefault: () => { prevented = true; } });
    return prevented;
  }
  resize(width: number, height: number) { this.scale.width = width; this.scale.height = height; this.scale.emit('resize'); }
}

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = read<ItemCatalog>('items'), stats = read<CharacterStatsCatalog>('character-stats'), battle = read<BattleCatalog>('battle');
const campaign = read<Campaign>('campaign'), companions = read<CompanionCatalog>('companions'), world = read<WorldIndex>('world');
campaign.debugStory = read<Campaign['debugStory']>('debug/start');
const panels = read<MenuPanels>('menu-panels'), content = read<StoryInterface>('story-interface');
interface MenuInternals {
  selectedMemberId: string;
  forge?: ForgePanel;
  operation?: { entry: string; kind: 'use' | 'discard'; quantity: number };
  keyboardFocus?: Display;
  body: UiSurface;
  surface: UiSurface;
  description: UiSurface;
  modal: UiSurface;
  busy: boolean;
  notice?: string;
  shortcutEdit?: { page: number };
  shopPanel?: { store: Storefront; bagScroll?: ScrollArea };
  confirmOperation(): void;
}
function fixture(classId = 'dark-knight') {
  const hero = new BattleCharacter(classId, stats, items), session = new Session(campaign, undefined, undefined, items, hero, battle, stats, companions);
  const controls = new GameUI(); controls.mode = 'game'; controls.ready = true;
  // 存档走内存存储；世界快照在菜单测试里只求能原样写回，语义由 save-game 的用例覆盖。
  const stored = new Map<string, string>();
  const saves = new SaveSlots<StoryWorldViewSnapshot>({ getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); }, removeItem: key => { stored.delete(key); } });
  const app: StoryUIContext = { content:{shopEquipment:async()=>({})}, controlLayout:new ControlLayoutPreferences(null), keyBindings:new KeyBindingPreferences(null), ui: controls, battleCatalog: battle, storyClasses: read<StoryClassCatalog>('story-classes'), menuPanels: panels,
    saves, captureSaveWorld: () => ({ ok: true, map: { id: campaign.start.map, name: '测试地图' },
      world: { location: { map: campaign.start.map, x: 16, y: 24, facing: 'south' as const }, generatedEntities: [],
        scene:{map:campaign.start.map,actors:[{id:'player',actor:campaign.start.actor,memberId:'player',x:16,y:24,facing:'south',visible:true}]} } }),
    crafting:parseCrafting(read('crafting')),controlSkin: read<ControlSkin>('control-skin'), shops: read<ShopCatalog>('shops'), characterStats: stats,
    changeEquipment: async (entry, slot, signal, owner = 'player') => {
      signal?.throwIfAborted(); const member = owner === 'player' ? hero : session.party!.get(owner)!;
      if (entry) session.bag.equip(entry, slot as EquipmentSlot, owner, member.classId, member.level); else session.bag.unequip(slot, owner);
      return '';
    } };
  const scene = new MenuScene(), menu = new StoryUI(app); menu.attach(scene as unknown as Phaser.Scene); menu.bind(session, world, content);
  controls.view = {
    sync: () => menu.sync(), resetInput: () => scene.game.events.emit(UI_EVENTS.cancelInput),
    renderText() {}, paginate: (_ui, text) => [{ text, end: text.length }], async portrait() {}
  };
  const internals = menu as unknown as MenuInternals;
  const entry = (item: string) => session.bag.entries.find(value => value.item === item)!;
  const add = (item: string, quantity = 1, skill?: string) => { session.bag.add(item, quantity, skill); return session.bag.entries.find(value => value.item === item && value.skill === skill)!; };
  const recruit = (className = 'warlock') => {
    const badge = add(`mercenary-emblem-${className}`), member = session.party!.recruit(badge.id, () => 0).member;
    session.party!.deployFirstAvailable(member.id); return member;
  };
  const select = (id: string) => {
    menu.show('bag'); const name = id === 'player' ? world.actors[campaign.start.actor].name : session.party!.get(id)!.definition.name;
    scene.click(scene.button(name)); assert.equal(internals.selectedMemberId, id);
  };
  return { hero, session, scene, menu, internals, controls, app, entry, add, recruit, select, cleanup: () => scene.events.emit('shutdown') };
}

function keyboardFocus(f: ReturnType<typeof fixture>, label: string, shift = false) {
  for (let index = 0; index < 100; index++) {
    f.scene.key('Tab', shift);
    if (f.internals.keyboardFocus?.getData('label') === label) return f.internals.keyboardFocus;
  }
  assert.fail(`键盘能够到达 ${label}`);
}

function setHeroWeapon(f: ReturnType<typeof fixture>, sockets: number, uses: number, enhancement = 0) {
  const weapon = f.hero.bag.get(f.hero.bag.equipment['main-hand']!)!;
  const state = f.hero.bag.captureState(), target = state.instances.find(entry => entry.id === weapon.id)!;
  target.numbers!.sockets = sockets; target.numbers!.enhancementUses = uses; target.enhancement = enhancement;
  f.hero.bag.restoreState(state);
  return weapon;
}

function openHeroForge(f: ReturnType<typeof fixture>, label = '强化/镶嵌') {
  f.menu.show('bag'); f.scene.click(f.scene.button('主手')); f.scene.click(f.scene.button(label));
  assert.ok(f.internals.forge, 'forge 已打开');
  return f.internals.forge!;
}

test('character allocation uses native arrow art and keeps points in the allocation area', t => {
  const f=fixture();t.after(f.cleanup);f.hero.addExperience(f.hero.player.nextLevelExperience);
  const before=f.hero.panel.attributes,points=f.hero.statPoints;
  f.menu.show('status');
  assert.equal(f.scene.texts().filter(text=>text.startsWith(panels.character.labels.statPoints)).length,1);
  assert(!f.scene.texts().some(text=>text.includes(panels.character.labels.skillPoints)));
  f.scene.click(f.scene.button('查看属性加点'));
  const plus=f.scene.button('增加力量'),minus=f.scene.button('减少力量');
  assert.equal(plus.list.length,2,'按钮只画原版箭头与按下图，不叠矩形或加减文字');
  for(const [button,flip] of [[minus,false],[plus,true]] as const){
    const face=button.getData('face') as Display,highlight=button.getData('highlight') as Display;
    assert.equal(face.texture.key,`interface:${panels.assets['character-step']}`);
    assert.equal(highlight.texture.key,`interface:${panels.assets['character-step-pressed']}`);
    assert.deepEqual([face.width,face.height,face.x,face.y],[51,58,0,0]);
    assert.equal(face.flipX,flip);assert.equal(highlight.flipX,flip);
    assert.equal(highlight.blendMode,1,'按下图沿用原版叠加混合');
    assert.equal(button.getData('labelText'),undefined);
  }
  assert(!f.scene.canHit(minus),'未投入点数时不能减点');
  f.scene.press(plus);assert.equal(plus.getData('highlight').visible,true);
  f.scene.game.events.emit(UI_EVENTS.cancelInput);
  assert.equal(plus.getData('highlight').visible,false);f.scene.release(plus);
  assert.equal(f.hero.statPoints,points,'取消按下不投入点数');
  for(let index=0;index<points;index++)f.scene.click(f.scene.button('增加力量'));
  assert(!f.scene.canHit(f.scene.button('增加敏捷')),'余额耗尽后所有加点按钮禁用');
  f.scene.click(f.scene.button('减少力量'));
  assert(f.scene.canHit(f.scene.button('增加敏捷')),'撤销本轮投入后恢复余额');
  const close=f.scene.button('确认属性加点');
  assert.equal(close.getData('face').texture.key,`interface:${panels.assets.confirm}`);
  f.scene.click(close);assert(!f.scene.canHit(f.scene.button('增加力量')),'确认框阻止底层加点');
  f.scene.click(f.scene.button('取消'));
  assert.deepEqual(f.hero.panel.attributes,before);assert.equal(f.hero.statPoints,points);
  f.scene.click(f.scene.button('查看属性加点'));f.scene.click(f.scene.button('增加力量'));
  f.scene.click(f.scene.button('确认属性加点'));f.scene.click(f.scene.button('确定'));
  assert.equal(f.hero.panel.attributes.strength,before.strength+1);assert.equal(f.hero.statPoints,points-1);
  f.scene.click(f.scene.button('查看属性加点'));
  assert(!f.scene.canHit(f.scene.button('减少力量')),'确认后的点数不再属于本轮投入');
});

test('character level, class and name stack without overlapping',t=>{
  const f=fixture();t.after(f.cleanup);f.menu.show('status');
  const node=(text:string)=>f.scene.nodes.find(value=>value.shown&&value.text===text)!;
  const level=node(`等级 ${f.hero.level}`);
  const profession=node(f.app.storyClasses.classes.find(value=>value.id===f.hero.classId)!.name);
  const name=node(world.actors[campaign.start.actor].name);
  assert.ok(level.y+level.height<=profession.y,`等级与职业行重叠：${level.y+level.height} > ${profession.y}`);
  assert.ok(profession.y+profession.height<=name.y,`职业与姓名重叠：${profession.y+profession.height} > ${name.y}`);
});

test('ability allocation counts added points per attribute and the reset button returns them for free',t=>{
  const f=fixture();t.after(f.cleanup);f.hero.addExperience(f.hero.player.nextLevelExperience);
  const points=f.hero.statPoints,base=f.hero.panel.attributes;
  f.menu.show('status');f.scene.click(f.scene.button('查看属性加点'));
  const added=()=>f.scene.nodes.find(node=>node.shown&&node.color==='#e1823b'&&node.x===781&&node.y===84);
  assert.equal(added(),undefined,'没有投入时不画计数');
  f.scene.click(f.scene.button('增加力量'));
  assert.equal(added()?.text,'+1','本轮投入立即计入右侧总数');
  f.scene.click(f.scene.button('增加力量'));
  assert.equal(added()?.text,'+2');
  const strengthValue=f.scene.nodes.find(node=>node.shown&&node.x===751&&node.y===84);
  assert.equal(strengthValue?.text,String(base.strength+2),'加点预览同步显示本轮增量');
  f.scene.click(f.scene.button('确认属性加点'));f.scene.click(f.scene.button('确定'));
  assert.equal(f.hero.allocated.strength,2);
  f.scene.click(f.scene.button('查看属性加点'));
  assert.equal(added()?.text,'+2','已确认的点数继续显示');
  f.scene.click(f.scene.button('能力初始化'));
  assert.deepEqual(f.hero.allocated,{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0});
  assert.equal(f.hero.statPoints,points,'初始化不消耗任何道具，点数全部返还');
  assert.deepEqual(f.hero.panel.attributes,base);
  assert.equal(added(),undefined,'初始化后计数清零');
  assert(f.scene.texts().includes(`${panels.character.labels.statPoints} ${points}`),'标题栏显示返还后的全部点数');
});

test('holding an allocation arrow keeps adding points until released',t=>{
  const f=fixture();t.after(f.cleanup);f.hero.addExperience(f.hero.player.nextLevelExperience);
  f.menu.show('status');f.scene.click(f.scene.button('查看属性加点'));
  const added=()=>f.scene.nodes.find(node=>node.shown&&node.color==='#e1823b'&&node.x===781&&node.y===84);
  f.scene.press(f.scene.button('增加力量'));
  assert.equal(added(),undefined,'还没到长按阈值时不加点');
  f.scene.hold();
  assert.equal(added()?.text,'+1','按住到阈值后开始自动加点');
  f.scene.hold();
  assert.equal(added()?.text,'+2','按住期间每一拍再加一点');
  f.scene.release(f.scene.button('增加力量'));
  f.scene.hold();
  assert.equal(added()?.text,'+2','松开后停止连加');
});

test('skill settings page drops the initial-point label and keeps the reset button',t=>{
  const f=fixture();t.after(f.cleanup);
  f.menu.show('skills');f.scene.click(f.scene.button('设置'));
  assert(!f.scene.texts().includes(panels.skillPanel.labels.initialSkillPoints),'设置页不再画「初始技能点」');
  assert(f.scene.canHit(f.scene.button(panels.skillPanel.labels.resetButton)),'初始化按钮仍在');
});

test('AI settings shows two columns and clears the description for unlearned skills',t=>{
  const f=fixture();t.after(f.cleanup);
  f.menu.show('skills');f.scene.click(f.scene.button('AI 设置'));
  const headers=panels.skillColumns.map(column=>`interface:${column.image}`);
  assert.deepEqual(headers.map(key=>f.scene.nodes.filter(node=>node.shown&&node.texture.key===key).length),[1,1,0],
    'AI 页只画两个主动技能列标题');
  const character=battle.classes.find(value=>value.id===f.hero.classId)!;
  const draft=f.session.skills.draft(battle,f.hero.classId);
  const unlearned=character.skills.slice(0,9).find(id=>!(draft.levels[id]>0))!;
  const learned=character.skills.slice(0,9).find(id=>(draft.levels[id]??0)>0)!;
  f.scene.click(f.scene.button(battle.skills[unlearned].name));
  assert(!f.scene.texts().some(text=>text.includes(`${battle.skills[unlearned].name} (LV`)),'未学会技能不显示虚假的 LV 1');
  f.scene.click(f.scene.button(battle.skills[learned].name));
  assert(f.scene.texts().some(text=>text.includes(`${battle.skills[learned].name} (LV`)),'已学会技能仍显示说明');
});

test('story companions use their own skill label and no mercenary group',t=>{
  const f=fixture();t.after(f.cleanup);
  const story=f.session.party!.joinStory('mercenary-portia');
  f.select(story.id);f.menu.show('skills');
  assert(f.scene.texts().includes('伙伴技能'));
  assert(!f.scene.texts().includes('佣兵技能'));
  f.menu.show('party');f.scene.click(f.scene.button(story.definition.name));f.scene.click(f.scene.button('技能目录'));
  assert(!f.scene.texts().includes('佣兵团'),'剧情伙伴不显示佣兵团区');

  const mercenary=f.recruit('warlock');
  f.menu.show('party');f.scene.click(f.scene.button(mercenary.definition.name));f.scene.click(f.scene.button('技能目录'));
  assert(f.scene.texts().includes('佣兵团'),'佣兵仍显示佣兵团区');
});

test('party skill cells hide the zero badge and show the locked overlay instead',t=>{
  const f=fixture();t.after(f.cleanup);f.menu.show('party');f.scene.click(f.scene.button('技能目录'));
  const character=battle.classes.find(value=>value.id===f.hero.classId)!;
  const draft=f.session.skills.draft(battle,f.hero.classId);
  const unlearned=character.skills.find(id=>!(draft.levels[id]>0))!;
  const learned=character.skills.find(id=>(draft.levels[id]??0)>0)!;
  const zero=f.scene.button(`${battle.skills[unlearned].name} 0 级`);
  assert(!zero.list.some(node=>node.text==='0'),'0 级格不画数字');
  assert(!zero.list.some(node=>node.texture.key===`interface:${panels.assets['skill-rank']}`),'0 级格不画等级底图');
  assert(zero.list.some(node=>node.texture.key===`interface:${panels.assets['skill-locked']}`),'0 级格画未掌握遮罩');
  const rank=f.scene.button(`${battle.skills[learned].name} ${draft.levels[learned]} 级`);
  assert(rank.list.some(node=>node.texture.key===`interface:${panels.assets['skill-rank']}`),'已学会格保留等级角标');
});

test('status page shows party group magic resistance and drops it when the member leaves',t=>{
  const f=fixture();t.after(f.cleanup);f.menu.show('status');
  const value=()=>{
    const label=[...f.scene.nodes].reverse().find(node=>node.shown&&node.text==='魔法抗性')!;
    return Number(([...f.scene.nodes].reverse().find(node=>node.shown&&node.x===928&&node.y===label.y)!.text).replace('%',''));
  };
  const before=value();
  const member=f.recruit('warlock');
  member.generated.groupSkills.splice(0,member.generated.groupSkills.length,'magic-resistance');
  f.menu.show('status');
  assert.equal(Math.round((value()-before)*10)/10,3,'佣兵团技能 +30‰ 显示为 +3.0%');
  f.session.party!.reserve(member.id);f.session.party!.dismiss(member.id);
  assert.equal(value(),before,'佣兵离开名册后面板恢复');
});

test('character titles stay clear of content-frame shadows and all attribute labels are Chinese',t=>{
  const f=fixture();t.after(f.cleanup);
  f.menu.show('status');
  const labels=['物理攻击','魔法攻击','暴击率','命中率','暴击伤害','防御力',
    '物理抗性','魔法抗性','闪避率','武器格挡率','盾牌格挡率'];
  assert.deepEqual(panels.character.combatLabels,labels);
  for(const label of [...labels,'生命','魔法','经验',`等级 ${f.hero.level}`])assert(f.scene.texts().includes(label));
  for(const adjusting of [false,true]){
    if(adjusting)f.scene.click(f.scene.button('查看属性加点'));
    const title=f.scene.nodes.find(node=>node.shown&&node.text.startsWith(panels.character.labels.statPoints))!;
    const body=title.parentContainer!;
    const corners=body.list.filter(node=>node.texture.key===`interface:${panels.assets['corner-nw']}`&&node.x===496);
    assert.equal(corners.length,1);assert.equal(corners[0].y,49,'属性内容框从标题下方开始');
    assert(title.y+title.height<=corners[0].y,'标题文字位于内容边框上方');
    assert.equal(title.x,adjusting?534:522,'原版标题内边距让开左上装饰');
    assert.equal(body.list.at(-1),title,'标题文字在装饰和按钮之后绘制');
  }
});

test('system exposes load alongside save while settings keeps the working display and audio preferences',t=>{
  displaySettings.setCriticalDecorations(true);
  t.after(()=>displaySettings.setCriticalDecorations(true));
  const f=fixture();t.after(f.cleanup);
  const audio={settings:{music:1,effects:1},setVolume(channel:'music'|'effects',value:number){this.settings[channel]=value;}};
  Object.defineProperty(f.app,'audio',{value:audio});
  f.menu.show('system');
  const actions=f.scene.nodes.filter(node=>node.shown&&node.getData('uiAction')&&node.getData('labelText'));
  assert.deepEqual(actions.map(node=>node.getData('label')),['保存游戏','读取存档','设置','返回主菜单']);
  assert(actions.every(node=>node.y+node.input!.hitArea.height<=431),'四个系统操作都在内容区内');
  f.scene.click(f.scene.button('设置'));
  assert.equal(f.scene.buttons('读取存档').length,0);assert.equal(f.scene.buttons('读档').length,0);
  assert(!f.scene.texts().some(text=>text.includes('语言')||text.includes('简体中文')));
  assert(f.scene.texts().includes('音乐'));assert(f.scene.texts().includes('音效'));
  // 音乐、音效改成滑动条；帧率显示和暴击光效仍是开关。
  const sliders=f.internals.body.sliders;
  assert.deepEqual(sliders.map(slider=>slider.label),['music','effects']);
  assert.equal(sliders[0]!.value,1);assert.equal(sliders[1]!.value,1);
  const toggle=(y:number)=>f.scene.buttons('开启').concat(f.scene.buttons('关闭')).find(node=>node.y===y)!;
  const rows={fps:260,critical:350} as const;
  assert(toggle(rows.fps));assert(toggle(rows.critical));
  // 设置项按 90 行距排，谁也盖不住谁；操作方式位于滚动内容末尾，不要求在首屏视口内。
  const control=f.scene.nodes.find(node=>node.shown&&node.getData('uiAction')&&String(node.getData('label')).startsWith('操作方式：'))!,criticalToggle=toggle(rows.critical);
  assert(control.y>=criticalToggle.y+criticalToggle.input!.hitArea.height,'操作方式排在暴击光效下方');
  // 设置页在滚动区里，拖动过的抬手不能算点击。
  f.scene.press(toggle(rows.critical));
  f.scene.input.activePointer.y-=40;
  f.scene.input.emit('pointermove',f.scene.input.activePointer);
  f.scene.release(toggle(rows.critical));
  assert.equal(displaySettings.criticalDecorations,true,'拖动滚动区的抬手不切换暴击光效');
  sliders[0]!.setValue(.4);
  assert.equal(audio.settings.music,.4);assert(f.scene.texts().includes('40%'));
  sliders[0]!.setValue(0);
  assert.equal(audio.settings.music,0);assert(f.scene.texts().includes('关闭'),'最左边显示关闭');
  sliders[1]!.setValue(.25);
  assert.equal(audio.settings.effects,.25);
  assert.equal(toggle(rows.fps).getData('label'),'开启','帧率显示是画面偏好，不受音量影响');
  assert.equal(toggle(rows.critical).getData('label'),'开启','暴击光效不受音量影响');
  f.scene.click(toggle(rows.critical));
  assert.equal(displaySettings.criticalDecorations,false);
  assert.equal(toggle(rows.critical).getData('label'),'关闭');
  assert.equal(toggle(rows.fps).getData('label'),'开启','暴击光效与帧率显示互不影响');
  assert.equal(audio.settings.music,0);assert.equal(audio.settings.effects,.25);
});

test('organise sits above and centered on the all-items category without overlapping its frame', t => {
  const f=fixture();t.after(f.cleanup);f.menu.show('bag');
  const organize=f.scene.button('整理'),all=f.scene.button('全部');
  const organizeArea=organize.input!.hitArea,allArea=all.input!.hitArea;
  assert.equal(organize.x+organizeArea.width/2,all.x+allArea.width/2);
  assert(organize.y+organizeArea.height<=all.y-12,'整理底部让开分类外框上沿');
  assert.equal(organizeArea.width,84);assert.equal(organizeArea.height,44);
  assert(f.scene.canHit(organize));f.scene.click(organize);
  f.scene.resize(700,480);assert(f.scene.canHit(f.scene.button('整理')),'重排后仍能点击');
});

test('custom menu buttons share native art and keep labels above their pressed layer', t => {
  const f=fixture();t.after(f.cleanup);
  Object.defineProperty(f.app,'audio',{value:{settings:{music:1,effects:1},setVolume(){}}});
  for(const page of ['system','settings','bag','status'] as const){
    f.menu.show(page);
    if(page==='status')f.scene.click(f.scene.button('查看属性加点'));
    const buttons=f.scene.nodes.filter(node=>node.shown&&node.getData('uiAction')&&node.getData('labelText'));
    assert(buttons.length>0,`${page}包含文字按钮`);
    for(const button of buttons){
      for(const [part,file] of [['face',COMMON_BUTTON.image],['highlight',COMMON_BUTTON.pressed]] as const){
        const layer=button.getData(part) as Display;
        assert.equal(layer.list.length,3,'Canvas 按钮由原图左端、中段、右端组成');
        assert(layer.list.every(image=>image.texture.key===`interface:${file}`));
      }
      assert.equal(button.list.at(-1),button.getData('labelText'),'文字画在按下亮图上方');
    }
    const enabled=buttons.find(button=>f.scene.canHit(button));
    if(enabled){
      f.scene.press(enabled);assert.equal(enabled.getData('highlight').visible,true);
      f.scene.game.events.emit(UI_EVENTS.cancelInput);f.scene.release(enabled);
      assert.equal(enabled.getData('highlight').visible,false,'取消输入后原版亮图收回');
    }
  }
});

test('WebGL common button slices stay inside hit areas and preserve selected feedback on input cancellation', t => {
  const f=fixture();t.after(f.cleanup);f.scene.game.renderer.type=2;f.menu.show('system');
  // 窄按钮和方按钮覆盖两种宽高比，后者触及 NineSlice 的最小宽度。
  const narrow=f.internals.surface.button('窄按钮',0,0,84,44,()=>{}, {selected:true}) as unknown as Display;
  f.internals.surface.button('方按钮',0,70,58,58,()=>{});
  const buttons=f.scene.nodes.filter(node=>node.shown&&node.getData('uiAction')&&node.getData('labelText'));
  assert.equal(buttons.length,6);
  for(const button of buttons){
    const area=button.input!.hitArea;
    for(const [part,file] of [['face',COMMON_BUTTON.image],['highlight',COMMON_BUTTON.pressed]] as const){
      const group=button.getData(part) as Display;
      assert.equal(group.list.length,1,'WebGL 用单个 Phaser NineSlice');
      const slice=group.list[0]!,layout=slice.getData('nineSlice');
      assert.equal(slice.texture.key,`interface:${file}`);
      assert.deepEqual([layout.left,layout.right,layout.top,layout.bottom],[COMMON_BUTTON.cap,COMMON_BUTTON.cap,0,0]);
      assert.equal(slice.height,layout.sourceHeight,'ThreeSlice 高度来自原始纹理');
      assert.equal(group.scaleX,group.scaleY,'两端统一等比缩放');
      assert(Math.abs(group.x+slice.width*group.scaleX-area.width)<1e-8,'延展后的宽度与命中区一致');
      assert(group.y>=-1e-8&&group.y+slice.height*group.scaleY<=area.height+1e-8,'原图上下边保持在命中区内');
      assert(layout.left*group.scaleX+layout.right*group.scaleX<=area.width+1e-8,'两端不会反向挤压中段');
    }
    assert.equal(button.list.at(-1),button.getData('labelText'),'文字位于原图和亮图上方');
  }
  assert(narrow.getData('highlight').visible);
  f.scene.press(narrow);f.scene.game.events.emit(UI_EVENTS.cancelInput);f.scene.release(narrow);
  assert.equal(narrow.getData('highlight').visible,true,'取消输入后选中按钮保持亮图');
  narrow.emit('pointerout');assert.equal(narrow.getData('highlight').visible,true);
  const plain=f.scene.button('设置');f.scene.press(plain);f.scene.game.events.emit(UI_EVENTS.cancelInput);f.scene.release(plain);
  assert.equal(plain.getData('highlight').visible,false,'普通按钮取消输入后恢复常态');
});

test('companion bag rejects hero-only items at the button, direct entry and confirmation boundaries', t => {
  for (const item of ['skills-reset-spell', 'supreme-elixir']) {
    const f = fixture(); t.after(f.cleanup); f.hero.addExperience(f.hero.player.nextLevelExperience); f.hero.allocate('strength', 1);
    const member = f.recruit(), source = f.add(item); f.select(member.id); f.menu.debugDescribe(source.id);
    const label = item === 'skills-reset-spell' ? '初始化技能' : '使用';
    assert.equal(f.scene.button(label).input!.enabled, false, item);
    const before = f.session.captureState(); f.menu.debugUse(source.id);
    assert.equal(f.internals.operation, undefined, `${item} 不进入使用流程`); assert.deepEqual(f.session.captureState(), before);
    f.internals.operation = { entry: source.id, kind: 'use', quantity: 1 }; f.internals.confirmOperation();
    assert.deepEqual(f.session.captureState(), before, `${item} 确认前再次拒绝，库存与整队状态不变`);
    f.internals.operation = undefined;
  }
});

test('processing items no longer expose a use button on their own description', t => {
  const f=fixture();t.after(f.cleanup);
  const gem=f.add('novice-jewel'),scroll=f.add('novice-weapon-scroll');
  f.menu.debugDescribe(gem.id);
  assert.equal(f.scene.buttons('使用').length,0,'宝石说明没有使用按钮');
  assert.equal(f.scene.buttons('镶嵌').length,0,'宝石不再从道具侧镶嵌');
  f.menu.debugDescribe(scroll.id);
  assert.equal(f.scene.buttons('使用').length,0,'卷轴说明没有使用按钮');
  assert.equal(f.scene.buttons('强化').length,0,'卷轴不再从道具侧强化');
});

test('equipment without enhancement, sockets or chaos has no forge button', t => {
  const f=fixture();t.after(f.cleanup);
  const equipmentId=Object.keys(items.items).find(id=>{const equipment=items.items[id].equipment;return !!equipment&&!equipment.enchantable&&!equipment.locked;})!;
  const entry=f.add(equipmentId);
  const state=f.hero.bag.captureState(),target=state.instances.find(value=>value.id===entry.id)!;
  target.numbers!.sockets=0;f.hero.bag.restoreState(state);
  f.menu.debugDescribe(entry.id);
  for(const label of ['强化','镶嵌','净化','强化/镶嵌'])assert.equal(f.scene.buttons(label).length,0,label);
});

test('forge opens from the worn equipment and enhances continuously', t => {
  const f=fixture();t.after(f.cleanup);
  const weapon=setHeroWeapon(f,3,3);f.add('novice-weapon-scroll',3);
  t.mock.method(Math,'random',()=>0.99);
  const forge=openHeroForge(f);
  assert.equal(f.internals.surface.root.visible,false,'forge 打开时背包层隐藏');
  assert.equal(f.internals.modal.root.visible,true);
  assert.equal(forge.targetId,weapon.id);
  assert.equal(f.scene.buttons('强化').length,1,'强化页签唯一');
  assert.equal(f.scene.buttons('镶嵌').length,1,'镶嵌页签唯一');
  assert.ok(f.scene.texts().some(text=>text.includes('+1 确定，+2 25%')),'强化页显示概率');
  f.scene.click(f.scene.button('卷轴:低级武器强化卷轴'));
  assert.equal(f.hero.bag.get(weapon.id)!.enhancement,1);
  assert.equal(f.hero.bag.get(weapon.id)!.numbers!.enhancementUses,2);
  assert.ok(f.scene.texts().some(text=>text.includes('强化 +1')),'结果行保留在 forge 内');
  assert.equal(f.scene.buttons('卷轴:低级武器强化卷轴').length,1,'卷轴还有剩余，行仍在');
  f.scene.click(f.scene.button('卷轴:低级武器强化卷轴'));
  assert.equal(f.hero.bag.get(weapon.id)!.enhancement,2);
  assert.equal(f.hero.bag.get(weapon.id)!.numbers!.enhancementUses,1);
});

test('forge disables normal scrolls at zero durability and highlights chaos', t => {
  const f=fixture();t.after(f.cleanup);
  const weapon=setHeroWeapon(f,3,0,10);f.add('novice-weapon-scroll');f.add('chaos-weapon-scroll');
  openHeroForge(f);
  assert.equal(f.scene.button('卷轴:低级武器强化卷轴').input!.enabled,false,'普通卷轴耐久不足');
  assert.ok(f.scene.texts().some(text=>text.includes('耐久度不足')));
  assert.ok(f.scene.nodes.some(node=>node.shown&&node.getData('forge-highlight')==='chaos'),'混沌卷轴高亮');
  const chaos=f.scene.button('卷轴:混沌武器强化卷轴');
  assert.ok(chaos.input!.enabled,'混沌卷轴可用');
  t.mock.method(Math,'random',()=>0.999);
  f.scene.click(chaos);
  assert.equal(f.hero.bag.get(weapon.id)!.enhancement,9,'混沌失败降 1 级');
  assert.equal(f.hero.bag.get(weapon.id)!.numbers!.enhancementUses,0,'混沌不消耗耐久');
  assert.ok(f.scene.texts().some(text=>text.includes('强化失败')));
});

test('forge sockets, removes and replaces gems with confirmation', t => {
  const f=fixture();t.after(f.cleanup);
  const weapon=setHeroWeapon(f,3,3);
  const first=f.add('novice-jewel'),second=f.add('standard-jewel'),replacement=f.add('advanced-jewel');
  openHeroForge(f);
  f.scene.click(f.scene.button('镶嵌'));
  f.scene.click(f.scene.button(`宝石:${first.id}`));
  assert.ok(f.scene.texts().some(text=>text.includes('镶嵌后')),'镶嵌前显示角色面板差值');
  f.scene.click(f.scene.button('确认镶嵌'));
  assert.equal(f.hero.bag.get(weapon.id)!.gems.length,1);
  assert.equal(f.hero.bag.get(weapon.id)!.numbers!.gemModifiers.length,1);
  f.scene.click(f.scene.button('孔位1'));
  f.scene.click(f.scene.button('取出'));
  assert.ok(f.internals.forge!.confirming);
  f.scene.click(f.scene.button('是'));
  assert.equal(f.hero.bag.get(weapon.id)!.gems.length,0);
  assert.equal(f.hero.bag.count('novice-jewel'),1,'宝石回到背包');
  f.scene.click(f.scene.button(`宝石:${second.id}`));
  f.scene.click(f.scene.button('确认镶嵌'));
  assert.equal(f.hero.bag.get(weapon.id)!.gems.length,1);
  f.scene.click(f.scene.button('孔位1'));
  f.scene.click(f.scene.button('替换'));
  f.scene.click(f.scene.button(`宝石:${replacement.id}`));
  f.scene.click(f.scene.button('确认替换'));
  assert.ok(f.internals.forge!.confirming,'替换也要二次确认');
  f.scene.click(f.scene.button('是'));
  const after=f.hero.bag.get(weapon.id)!;
  assert.equal(after.gems[0],replacement.item);
  assert.equal(f.hero.bag.count('standard-jewel'),1,'旧宝石回到背包');
});

test('forge purifies chaos and Escape returns to the description', t => {
  const f=fixture();t.after(f.cleanup);
  const weapon=setHeroWeapon(f,3,3);
  const state=f.hero.bag.captureState(),target=state.instances.find(entry=>entry.id===weapon.id)!;
  target.numbers!.chaos={tier:'chaos',valuePercent:10,levelOffset:0};f.hero.bag.restoreState(state);
  f.add('jewel-of-catharsis');
  openHeroForge(f);
  f.scene.click(f.scene.button('净化'));
  f.scene.click(f.scene.button('净化石:净化之宝石'));
  assert.equal(f.hero.bag.get(weapon.id)!.numbers!.chaos,undefined);
  assert.equal(f.hero.bag.count('jewel-of-catharsis'),0);
  f.add('novice-jewel');
  f.scene.click(f.scene.button('镶嵌'));
  const gem=f.hero.bag.entries.find(entry=>entry.item==='novice-jewel')!;
  f.scene.click(f.scene.button(`宝石:${gem.id}`));
  f.scene.click(f.scene.button('确认镶嵌'));
  f.scene.click(f.scene.button('孔位1'));
  f.scene.click(f.scene.button('取出'));
  assert.ok(f.internals.forge!.confirming);
  assert(f.scene.key('Escape'));
  assert.equal(f.internals.forge!.confirming,false,'Escape 先取消确认');
  assert.ok(f.internals.forge);
  assert(f.scene.key('Escape'));
  assert.equal(f.internals.forge,undefined,'再按一次关闭 forge');
  assert.equal(f.internals.surface.root.visible,true);
  assert.equal(f.scene.buttons('强化/镶嵌').length,1,'回到装备说明');
});

test('dense action row fits four actions including the forge entry', async t => {
  const f=fixture();t.after(f.cleanup);f.hero.addExperience(Number.MAX_SAFE_INTEGER);
  const first=f.add('ferrule'),second=f.add('copper-ring'),third=f.add('crystal-ring');
  const equip=async(id:string)=>{f.menu.debugDescribe(id);f.scene.click(f.scene.button('装备'));await Promise.resolve();};
  await equip(first.id);await equip(second.id);
  const state=f.session.bag.captureState(),target=state.instances.find(entry=>entry.id===third.id)!;
  target.numbers!.sockets=1;f.session.bag.restoreState(state);
  f.menu.debugDescribe(third.id);
  const buttons=['替换戒指','替换饰品','镶嵌','丢弃'].map(label=>f.scene.button(label));
  assert.ok(buttons.every(button=>button.input!.hitArea.width===92),'4 个动作都改文字按钮');
  const xs=buttons.map(button=>button.x).sort((left,right)=>left-right);
  for(let index=1;index<xs.length;index++)assert.equal(xs[index]-xs[index-1],94,'按钮步长 94');
  assert.ok(xs.at(-1)!-xs[0]!+92<=377,'4 个按钮总宽不超出操作行');
});

test('hero bag still applies skill reset and supreme elixir', t => {
  for (const item of ['skills-reset-spell', 'supreme-elixir']) {
    const f = fixture(); t.after(f.cleanup); f.hero.addExperience(Number.MAX_SAFE_INTEGER); f.hero.allocate('strength', 1);
    f.session.skills.learn('dark-strike');f.session.skills.learn('dark-strike');
    const skill = battle.classes.find(value => value.id === f.hero.classId)!.skills[1]; f.session.skills.learn(skill);
    const source = f.add(item), points = f.session.skills.points(); f.menu.debugUse(source.id); f.scene.click(f.scene.button('确定'));
    assert.equal(f.session.bag.count(item), 0);
    if (item === 'skills-reset-spell') assert.equal(f.session.skills.level(skill), 0);
    if (item === 'supreme-elixir') assert.equal(f.session.skills.points(), points + 1);
  }
});

test('skill description colors, unchanged comparisons and learning button share native requirements',t=>{
  const f=fixture();t.after(f.cleanup);const skill=battle.skills['phantom-clash'];
  f.hero.addExperience(Number.MAX_SAFE_INTEGER);f.menu.show('skills');f.scene.click(f.scene.button(skill.name));
  const condition=()=>f.scene.nodes.find(node=>node.shown&&node.text==='条件：投入6技能点')!;
  const learn=()=>f.scene.nodes.find(node=>node.shown&&String(node.getData('label')).startsWith('学习'))!;
  assert.equal(condition().color,'#ff0000');assert.equal(learn().input!.enabled,false);
  assert(f.scene.nodes.some(node=>node.shown&&node.text==='225.0%'&&node.color==='#00b4ff'));
  f.session.skills.learn('dark-strike');f.session.skills.learn('dark-strike');f.menu.sync();
  assert.equal(condition().color,'#ffffff');assert.equal(learn().input!.enabled,true);
  f.scene.click(learn());
  const arrows=()=>f.scene.nodes.filter(node=>node.shown&&node.texture.key===`interface:${panels.assets['skill-compare-arrow']}`);
  assert.equal(arrows().length,4,'魔耗和三个效果都比较，固定持续时间也显示');
  while(f.session.skills.level(skill.id)<skill.normalMaxLevel)f.session.skills.learn(skill.id);
  f.menu.sync();assert.equal(arrows().length,0,'普通学习上限收起整段预览');
  assert(!f.scene.texts().some(text=>text.startsWith('条件：投入')));
  assert.equal(learn().input!.enabled,false);
});

test('shop equipment condition colors use the viewed member across menu pages',t=>{
  const f=fixture();t.after(f.cleanup);const member=f.recruit('warlock');
  const [key,item]=Object.entries(items.items).find(([,item])=>item.equipment?.classes.includes('warlock')&&!item.equipment.classes.includes('dark-knight')&&item.sellable)!;
  f.add(key);
  for(const [owner,color]of [[member.id,'#ffffff'],['player','#ff0000']]){
    f.select(owner);f.menu.openShop('merchandise-dealer-b09d9585','');f.scene.click(f.scene.button(`出售 ${item.name}`));
    const body=f.internals.description.scrolls[0].content as unknown as Display;
    assert.equal(body.list.find(node=>node.text===item.typeName)!.color,color);
  }
});

test('companion skill descriptions use the member cap and next learning level',t=>{
  const f=fixture();t.after(f.cleanup);const member=f.recruit('warlock');f.select(member.id);
  const id=battle.classes.find(character=>character.id===member.classId)!.skills.find(id=>member.snapshot().skillCaps[id]>0)!;
  f.menu.show('skills');f.scene.click(f.scene.button(battle.skills[id].name));
  assert(f.scene.texts().includes(`最高等级： LV ${member.snapshot().skillCaps[id]}`));
  assert(!f.scene.texts().some(text=>text.startsWith('需要技能点数：')));
});

test('learning immediately redraws skill lock, rank, description and shortcut availability', t => {
  const f = fixture(); t.after(f.cleanup); f.hero.addExperience(Number.MAX_SAFE_INTEGER);
  f.session.skills.learn('dark-strike');f.session.skills.learn('dark-strike');
  const id = battle.classes.find(value => value.id === f.hero.classId)!.skills[1], skill = battle.skills[id];
  f.menu.show('skills'); f.scene.click(f.scene.button(skill.name));
  const icon = () => f.scene.button(skill.name);
  const hasImage = (key: string) => icon().list.some(value => value.texture.key === `interface:${panels.assets[key]}`);
  assert(hasImage('skill-locked')); assert.equal(f.scene.button('快捷键').input!.enabled, false);
  const learn = () => { const button = f.scene.nodes.find(value => value.shown && value.input?.enabled && String(value.getData('label')).startsWith('学习')); assert(button); f.scene.click(button); };
  learn(); assert.equal(f.session.skills.level(id), 1); assert(!hasImage('skill-locked')); assert(hasImage('skill-rank-1'));
  assert.equal(f.scene.button('快捷键').input!.enabled, true);
  learn(); assert.equal(f.session.skills.level(id), 2); assert(hasImage('skill-rank-2'));
  assert(f.scene.texts().includes(`${skill.name} (LV 2)`), '同一技能页即时重绘当前等级说明');
});

test('a skill moves to the last registered shortcut and clicking that slot again cancels it',t=>{
  const f=fixture();t.after(f.cleanup);const id='dark-strike',skill=battle.skills[id];
  f.hero.addExperience(Number.MAX_SAFE_INTEGER);f.session.skills.learn(id);
  f.menu.show('skills');f.scene.click(f.scene.button(skill.name));
  if(f.scene.buttons('取消快捷键').length)f.scene.click(f.scene.button('取消快捷键'));
  f.scene.click(f.scene.button('快捷键'));
  const row=()=>f.session.bag.captureState().shortcuts.find(([owner])=>owner==='player')![1];
  f.scene.click(f.scene.button('快捷位 1'));
  f.scene.click(f.scene.button('快捷位 2'));
  assert.equal(row()[0],null,'登记到新槽会清掉同一技能的旧槽');
  assert.deepEqual(row()[1],{kind:'skill',id});
  f.scene.click(f.scene.button('快捷位 2'));
  assert.equal(row()[1],null,'再次点击已登记技能的槽位会取消');
  assert.ok(f.internals.shortcutEdit,'取消后仍留在登记屏');
  f.scene.click(f.scene.button('快捷位 3'));
  f.scene.click(f.scene.button('切换技能组'));
  f.scene.click(f.scene.button('快捷位 4'));
  assert.equal(row()[2],null,'换到第二组也会清掉第一组的旧槽');
  assert.deepEqual(row()[9],{kind:'skill',id});
  assert.equal(row().filter(entry=>entry?.kind==='skill'&&entry.id===id).length,1);
});

test('companion equipment buttons validate the selected member and hero buttons retain class restrictions', async t => {
  const f = fixture(); t.after(f.cleanup); f.hero.addExperience(Number.MAX_SAFE_INTEGER);
  const member = f.recruit(), orb = f.add('crystal-orb'); f.select(member.id); f.menu.debugDescribe(orb.id);
  assert.equal(f.scene.button('装备').input!.enabled, true); f.scene.click(f.scene.button('装备')); await Promise.resolve();
  assert.equal(f.session.bag.equipmentFor(member.id)['main-hand'], orb.id);
  f.select('player'); const other = f.add('crystal-orb'); f.menu.debugDescribe(other.id);
  assert(f.scene.texts().includes('适合职业：黑魔导、祭司'), '装备详情写明适用职业');
  assert.equal(f.scene.buttons('装备').filter(button => button.input?.enabled).length, 0, '主角仍按黑暗骑士职业限制');
  assert.notEqual(f.session.bag.equipment['main-hand'], other.id);
});

test('rings fill the first empty ring slot and ask which one to replace when both are full', async t => {
  const f = fixture(); t.after(f.cleanup); f.hero.addExperience(Number.MAX_SAFE_INTEGER);
  const first = f.add('ferrule'), second = f.add('copper-ring'), third = f.add('crystal-ring');
  const equip = async (id: string) => { f.menu.debugDescribe(id); f.scene.click(f.scene.button('装备')); await Promise.resolve(); };
  await equip(first.id);
  assert.equal(f.session.bag.equipment['ring'], first.id);
  assert.equal(f.session.bag.equipment['accessory'], undefined, '第二个戒指槽位应优先填空位');
  await equip(second.id);
  assert.equal(f.session.bag.equipment['ring'], first.id, '第二枚戒指不能顶掉第一枚');
  assert.equal(f.session.bag.equipment['accessory'], second.id);
  f.menu.debugDescribe(third.id);
  assert.equal(f.scene.buttons('装备').filter(button => button.input?.enabled).length, 0, '两格都满时不再自动替换');
  assert.ok(f.scene.button('替换戒指'));
  f.scene.click(f.scene.button('替换饰品')); await Promise.resolve();
  assert.equal(f.session.bag.equipment['ring'], first.id);
  assert.equal(f.session.bag.equipment['accessory'], third.id, '替换动作只改用户选择的槽位');
});

test('bag drags onto an equipment slot only equip what the selected member can use', async t => {
  const f = fixture(); t.after(f.cleanup); f.hero.addExperience(Number.MAX_SAFE_INTEGER);
  const dragTo = (id: string, label = '主手') => {
    f.menu.show('bag');
    const entry = f.session.bag.get(id)!;
    f.scene.press(f.scene.button(items.items[entry.item].name)); f.scene.hold();
    f.scene.pointAt(f.scene.button(label));
    f.scene.input.activePointer.isDown = false;
    f.scene.input.emit('pointerup', f.scene.input.activePointer);
  };
  const bow = f.add('basic-bow'), before = f.session.bag.equipment['main-hand'];
  dragTo(bow.id); await Promise.resolve();
  assert.equal(f.session.bag.equipment['main-hand'], before, '黑暗骑士拖弓不生效');
  assert.equal(f.session.bag.get(bow.id)?.id, bow.id, '不能穿的装备留在背包');
  assert.ok(!f.internals.notice, '职业不符不产生页面提示');
  const sword = f.add('basic-greatsword'); dragTo(sword.id); await Promise.resolve();
  assert.equal(f.session.bag.equipment['main-hand'], sword.id, '本职业可用的双手剑仍可拖上');
  const member = f.recruit('warlock'), orb = f.add('crystal-orb'); f.select(member.id);
  dragTo(bow.id); await Promise.resolve();
  assert.notEqual(f.session.bag.equipmentFor(member.id)['main-hand'], bow.id, '佣兵同样按自己的职业判定');
  assert.ok(!f.internals.notice);
  dragTo(orb.id); await Promise.resolve();
  assert.equal(f.session.bag.equipmentFor(member.id)['main-hand'], orb.id);
});

test('generic, foreign, maxed and companion-view skillbooks can all be discarded', t => {
  const classSkills = battle.classes.find(value => value.id === 'dark-knight')!.skills;
  const foreign = battle.classes.find(value => value.id === 'warlock')!.skills[0];
  for (const scenario of ['generic', 'foreign', 'maxed', 'companion']) {
    const f = fixture(); t.after(f.cleanup); f.hero.addExperience(Number.MAX_SAFE_INTEGER);
    const bound = scenario === 'foreign' ? foreign : scenario === 'maxed' ? classSkills[0] : undefined;
    if (scenario === 'maxed') {
      const skill = battle.skills[bound!];
      while (f.session.skills.level(bound!) < skill.normalMaxLevel) f.session.skills.learn(bound!);
      while (f.session.skills.level(bound!) < skill.ranks.length) f.session.skills.book(bound!);
      assert.equal(f.session.skills.level(bound!), 8, '丢弃场景确实使用满八级技能的绑定技能书');
    }
    if (scenario === 'companion') f.select(f.recruit().id);
    const source = f.add('skillbook', 1, bound); f.menu.debugUse(source.id, 'discard');
    assert.equal(f.scene.button('确定').input!.enabled, true, scenario); f.scene.click(f.scene.button('确定'));
    assert.equal(f.session.bag.get(source.id), undefined, `${scenario} 技能书成功丢弃`);
  }
});

test('discarding a lamp only removes inventory; using a lamp opens its shop', t => {
  const f = fixture(); t.after(f.cleanup); const lamp = f.add('lamp', 2);
  f.menu.debugUse(lamp.id, 'discard'); f.scene.click(f.scene.button('确定'));
  assert.equal(f.session.bag.count('lamp'), 1); assert.equal(f.scene.buttons('返回背包').length, 0);
  assert(f.scene.buttons('背包').length, '丢弃后留在背包页');
  f.menu.debugUse(f.entry('lamp').id); f.scene.click(f.scene.button('确定'));
  assert.equal(f.session.bag.count('lamp'), 0); assert.equal(f.scene.buttons('背包').length, 0, '使用后进入商店而非菜单标签页');
  assert(f.scene.texts().some(value => value.includes('神灯')), '真实商店面板已经绘制');
});

test('description buttons and scrolling reject modal, busy, suspended and closed input', t => {
  const f = fixture(); t.after(f.cleanup); const source = f.add('skills-reset-spell');
  f.menu.debugDescribe(source.id); f.menu.debugUse(source.id, 'discard');
  const button = f.scene.button('初始化技能'), scroll = f.internals.description.scrolls[0]!;
  scroll.setHeight(1000);
  const point = scroll.content.getWorldTransformMatrix().transformPoint(10, 10);
  Object.assign(f.scene.input.activePointer, point);
  const before = f.session.captureState();
  assert.equal(scroll.contains(f.scene.input.activePointer as Phaser.Input.Pointer), false, '模态打开时说明滚动区拒绝输入');
  f.scene.input.emit('wheel', f.scene.input.activePointer, [], 0, 120);
  assert.equal(scroll.scrollTop, 0, '模态下滚轮不改变说明');
  assert.equal(f.scene.tryClick(button), false, '模态下独立说明按钮拒绝点击');
  assert.equal(f.internals.operation?.kind, 'discard'); assert.deepEqual(f.session.captureState(), before);

  f.internals.operation = undefined; f.menu.sync();
  Object.assign(f.scene.input.activePointer, point);
  assert.equal(scroll.contains(f.scene.input.activePointer as Phaser.Input.Pointer), true);
  f.scene.input.emit('wheel', f.scene.input.activePointer, [], 0, 120);
  assert(scroll.scrollTop > 0, '正常说明滚轮仍可用');
  for (const state of ['busy', 'suspended'] as const) {
    Object.assign(f.scene.input.activePointer, point, { isDown: true });
    f.scene.input.emit('pointerdown', f.scene.input.activePointer);
    const offset: number = scroll.scrollTop;
    if (state === 'busy') f.internals.busy = true; else f.controls.suspend(true);
    f.menu.sync(); Object.assign(f.scene.input.activePointer, point);
    assert.equal(scroll.contains(f.scene.input.activePointer as Phaser.Input.Pointer), false, state);
    f.scene.input.activePointer.y -= 100;
    f.scene.input.emit('pointermove', f.scene.input.activePointer);
    assert.equal(scroll.scrollTop, offset, `${state} 中已开始的滚动手势停止`);
    assert.equal(f.scene.tryClick(button), false, state);
    if (state === 'busy') f.internals.busy = false; else f.controls.suspend(false);
    f.menu.sync(); f.scene.input.activePointer.isDown = false; f.scene.input.emit('pointerup', f.scene.input.activePointer);
  }
  f.menu.close();
  assert.equal(scroll.contains(f.scene.input.activePointer as Phaser.Input.Pointer), false, '关闭后拒绝滚动');
  assert.equal(f.scene.tryClick(button), false, '关闭后拒绝残留按钮');
  assert.deepEqual(f.session.captureState(), before);
});

test('scrolling a worn item description never scrolls the bag grid underneath', t => {
  const f = fixture(); t.after(f.cleanup);
  const worn = f.hero.bag.get(f.hero.bag.equipment['main-hand']!)!;
  f.menu.debugDescribe(worn.id, 'right');
  const bag = f.internals.body.scrolls[0]!, detail = f.internals.description.scrolls[0]!;
  bag.setHeight(2000); detail.setHeight(2000);
  const a = (bag as unknown as { mask: Display }).mask.getBounds();
  const b = (detail as unknown as { mask: Display }).mask.getBounds();
  const left = Math.max(a.x, b.x), right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y), bottom = Math.min(a.y + a.height, b.y + b.height);
  assert.ok(right > left && bottom > top, '说明面板必须与背包网格重叠');
  Object.assign(f.scene.input.activePointer, { x: (left + right) / 2, y: (top + bottom) / 2 });
  const pointer = f.scene.input.activePointer as Phaser.Input.Pointer;
  assert.equal(bag.contains(pointer), true); assert.equal(detail.contains(pointer), true);
  const bagOffset = bag.scrollTop;
  f.scene.input.emit('wheel', pointer, [], 0, 120);
  assert.ok(detail.scrollTop > 0, '说明面板跟随滚轮');
  assert.equal(bag.scrollTop, bagOffset, '被盖住的背包不能一起滚动');
});

test('scrolling a shop description never scrolls the bag column underneath', t => {
  const f = fixture(); t.after(f.cleanup); f.session.gainMoney(1_000_000);
  f.menu.debugShop(f.app.shops.lampShop, 'description', 'buy');
  const bag = f.internals.shopPanel!.bagScroll!, detail = f.internals.description.scrolls.at(-1)!;
  bag.setHeight(2000); detail.setHeight(2000);
  const a = (bag as unknown as { mask: Display }).mask.getBounds();
  const b = (detail as unknown as { mask: Display }).mask.getBounds();
  const left = Math.max(a.x, b.x), right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y), bottom = Math.min(a.y + a.height, b.y + b.height);
  assert.ok(right > left && bottom > top, '商店说明面板必须与背包栏重叠');
  Object.assign(f.scene.input.activePointer, { x: (left + right) / 2, y: (top + bottom) / 2 });
  const pointer = f.scene.input.activePointer as Phaser.Input.Pointer;
  assert.equal(bag.contains(pointer), true); assert.equal(detail.contains(pointer), true);
  const bagOffset = bag.scrollTop;
  f.scene.input.emit('wheel', pointer, [], 0, 120);
  assert.ok(detail.scrollTop > 0, '商店说明面板跟随滚轮');
  assert.equal(bag.scrollTop, bagOffset, '被盖住的商店背包不能一起滚动');
});

test('opening a modal cancels an unfinished description press before it can resume', t => {
  const f = fixture(); t.after(f.cleanup); const source = f.add('skills-reset-spell'); f.menu.debugDescribe(source.id);
  const button = f.scene.button('初始化技能');
  for (const transition of ['modal', 'suspended'] as const) {
    f.scene.press(button); assert.equal(button.getData('highlight').visible, true);
    if (transition === 'modal') f.internals.operation = { entry: source.id, kind: 'discard', quantity: 1 };
    else f.controls.suspend(true);
    f.menu.sync();
    assert.equal(button.getData('highlight').visible, false, `${transition} 清理按下状态`);
    if (transition === 'modal') f.internals.operation = undefined;
    else f.controls.suspend(false);
    f.menu.sync(); f.scene.release(button);
    assert.equal(f.internals.operation, undefined, `${transition} 恢复后松手不触发旧操作`);
  }
  assert.equal(f.session.bag.count(source.item), 1);
});

test('keyboard reaches equipment description actions and modal focus stays inside the modal', async t => {
  const f = fixture(); t.after(f.cleanup);
  const item = items.startingEquipment['dark-knight']['main-hand']!, weapon = f.add(item);
  f.menu.debugDescribe(weapon.id); keyboardFocus(f, '装备'); assert(f.scene.key('Enter')); await Promise.resolve();
  assert.equal(f.session.bag.equipment['main-hand'], weapon.id, 'Enter 执行独立说明层装备按钮');
  const source = f.add('skills-reset-spell'); f.menu.debugDescribe(source.id);
  keyboardFocus(f, '丢弃', true); assert(f.scene.key(' '));
  assert.equal(f.internals.operation?.kind, 'discard', 'Shift+Tab 与空格执行说明层按钮');
  const labels = new Set<string>();
  for (let index = 0; index < 6; index++) { f.scene.key('Tab', index % 2 === 1); labels.add(f.internals.keyboardFocus!.getData('label')); }
  assert.deepEqual([...labels].sort(), ['取消', '确定'], '确认框只能遍历自己的按钮');
  assert(f.scene.key('Escape')); assert.equal(f.internals.operation, undefined);
  assert.equal(f.session.bag.count(source.item), 1, 'Escape 取消确认');
  keyboardFocus(f, '关闭', true); assert(f.scene.key('Enter'));
  assert.equal(f.scene.buttons('初始化技能').length, 0, '键盘关闭说明而保留背包'); assert(f.scene.buttons('背包').length);
});

test('keyboard reaches shop buy and sell description actions and Escape backs out', t => {
  const f = fixture(); t.after(f.cleanup); const shop = f.app.shops.lampShop; f.session.gainMoney(1_000_000);
  for (const kind of ['buy', 'sell'] as const) {
    f.menu.debugShop(shop, 'description', kind);
    const label = kind === 'buy' ? '购买' : '出售'; keyboardFocus(f, label); assert(f.scene.key(kind === 'buy' ? 'Enter' : ' '));
    assert(f.internals.modal.root.visible, `${label} 从说明层进入真实交易弹层`);
    assert(f.scene.key('Escape')); assert.equal(f.internals.modal.root.visible, false, 'Escape 取消交易');
  }
});

test('keyboard operates every shortcut slot, switches groups, returns and cancels', t => {
  const f = fixture(); t.after(f.cleanup); const item = items.startingShortcut, source = f.entry(item);
  f.menu.debugDescribe(source.id); f.scene.click(f.scene.button('取消快捷键'));
  f.scene.click(f.scene.button('快捷键')); assert.equal(f.scene.buttons('背包').length, 0);
  for (let slot = 1; slot <= 6; slot++) {
    keyboardFocus(f, `快捷位 ${slot}`); assert(f.scene.key(slot % 2 ? 'Enter' : ' '));
    const row = f.session.bag.captureState().shortcuts.find(([owner]) => owner === 'player')![1];
    assert.deepEqual(row[slot - 1], { kind: 'item', id: item });
  }
  keyboardFocus(f, '切换技能组'); assert(f.scene.key('Enter')); assert.equal(f.internals.shortcutEdit?.page, 1);
  keyboardFocus(f, '快捷位 6', true); assert(f.scene.key(' '));
  assert.deepEqual(f.session.bag.captureState().shortcuts.find(([owner]) => owner === 'player')![1][11], { kind: 'item', id: item });
  keyboardFocus(f, '返回', true); assert(f.scene.key('Enter')); assert.equal(f.internals.shortcutEdit, undefined);
  assert(f.scene.buttons('背包').length);
  f.menu.debugDescribe(source.id); f.scene.click(f.scene.button('取消快捷键')); f.scene.click(f.scene.button('快捷键'));
  assert(f.scene.key('Escape')); assert.equal(f.internals.shortcutEdit, undefined); assert(f.scene.buttons('背包').length);
});

function editingControl(f: ReturnType<typeof fixture>, id: ControlId) {
  const objects=f.scene.nodes.filter(node=>node.shown&&node.getData('controlId')===id);
  assert.equal(objects.length,1,`唯一可拖动控件 ${id}`);return objects[0]!;
}
function openControls(f: ReturnType<typeof fixture>) {
  controlSettings.setMode('stick');
  f.menu.show('settings');
  const control=f.scene.button('拖动调整');
  f.internals.body.scrolls.at(-1)?.reveal(control as unknown as Phaser.GameObjects.Container);
  f.scene.click(control);
}

test('control editor hides the menu, keeps the shade and HUD buttons, previews the controlled actor and returns to settings',t=>{
  const f=fixture();t.after(f.cleanup);
  const member=f.recruit();f.select(member.id);
  const icon=f.app.battleCatalog.skills[Object.keys(f.app.battleCatalog.skills)[0]].icon;
  f.app.captureControlPreview=()=>[{entry:{kind:'skill',id:'preview'},icon,quantity:0,enabled:false,cooldown:{remainingMs:500,durationMs:1000}},
    {entry:{kind:'item',id:items.startingShortcut},icon:items.items[items.startingShortcut].icon,quantity:7,enabled:true}];
  openControls(f);
  assert(f.controls.controlLayoutEditing);assert(f.controls.locked);
  assert.equal(f.internals.surface.root.visible,false);assert.equal(f.internals.description.root.visible,false);
  assert.equal(f.scene.buttons('关闭菜单').length,0);assert.equal(f.scene.buttons('存档').length,1);
  assert.equal(f.scene.canHit(f.scene.button('存档')),false,'背景 HUD 不响应');
  assert(f.scene.nodes.some(node=>node.shown&&node.depth===99),'菜单遮罩保留');
  for(const id of CONTROL_IDS) {
    const object=editingControl(f,id),input=object.input!;
    assert(object.getData('draggable'));
    assert(input.hitAreaCallback!(input.hitArea,object.width*.9,object.height*.9),'控件右下部分也能开始拖动');
    assert.equal(input.hitAreaCallback!(input.hitArea,object.width+1,object.height/2),false);
  }
  assert(editingControl(f,'slot-0').list.some(node=>node.texture.key===`interface:${icon}`),'读取实际操控者当前组的图标');
  assert(editingControl(f,'slot-1').list.some(node=>node.text==='7'));
  const reset=f.scene.button('恢复默认'),close=f.scene.button('关闭控件位置');
  assert(reset.parentContainer!.depth>editingControl(f,'move').parentContainer!.depth,'工具栏在拖动控件上方');
  f.scene.click(close);
  assert.equal(f.controls.controlLayoutEditing,false);assert(f.controls.locked);
  assert.equal(f.scene.buttons('拖动调整').length,1);assert.equal(f.scene.buttons('恢复默认').length,0);
  openControls(f);assert(f.scene.key('Escape'));assert.equal(f.scene.buttons('拖动调整').length,1);
  assert(f.controls.locked);assert(f.scene.key('Escape'));assert.equal(f.controls.locked,false);
});

test('control editor saves only on release, allows overlap, resets in place and supports toolbar keyboard input',t=>{
  const f=fixture();t.after(f.cleanup);openControls(f);
  const pointer=f.scene.input.activePointer;
  for(const id of CONTROL_IDS) {
    const object=editingControl(f,id);
    object.emit('dragstart',pointer);object.emit('drag',pointer,512,320);
    f.menu.sync();assert.deepEqual([object.x,object.y],[512,320],'普通同步保留正在拖动的位置');
    assert.equal(f.app.controlLayout.snapshot()[id],undefined,'拖动中不保存');
    object.emit('dragend',pointer);
    assert.deepEqual(f.app.controlLayout.snapshot()[id],{x:.5,y:.5});
  }
  assert(f.controls.locked);assert(f.controls.controlLayoutEditing);
  assert(f.scene.key('Tab'));assert(f.scene.key('Tab'));assert(f.scene.key('Enter'));
  assert.deepEqual(f.app.controlLayout.snapshot(),{});assert(f.controls.controlLayoutEditing);
  const defaultLayout=resolveControlLayout(controlViewport(f.scene as unknown as Phaser.Scene));
  for(const id of CONTROL_IDS)assert.deepEqual([editingControl(f,id).x,editingControl(f,id).y],[defaultLayout[id].x,defaultLayout[id].y]);
  // 工具栏现在只有“恢复默认”和关闭钮；从“恢复默认”继续往后 Tab 到关闭钮。
  assert(f.scene.key('Tab'));
  assert(f.scene.key('Enter'));assert.equal(f.controls.controlLayoutEditing,false);
});

test('settings cycles operation modes in place and shows the matching editor entry',t=>{
  const f=fixture();t.after(f.cleanup);t.after(()=>controlSettings.setMode('stick'));
  controlSettings.setMode('stick');
  f.menu.show('settings');
  // 这些行在滚动区末尾，先滚到可见再点，和玩家实际操作的路径一致。
  const clickRow=(label:string)=>{const row=f.scene.button(label);f.internals.body.scrolls.at(-1)?.reveal(row as unknown as Phaser.GameObjects.Container);f.scene.click(row);};
  const touchObjects=()=>f.scene.nodes.filter(node=>node.shown&&node.getData('controlId')).length;
  assert.equal(f.scene.buttons('操作方式：虚拟摇杆').length,1);
  assert.equal(f.scene.buttons('拖动调整').length,1,'触屏模式提供控件位置入口');
  assert.equal(f.scene.buttons('修改键位').length,0);

  // 点一下换下一种：摇杆 → 十字 → 电脑模式 → 摇杆，全程留在设置页。
  clickRow('操作方式：虚拟摇杆');
  assert.equal(controlSettings.mode,'dpad');
  assert.equal(f.scene.buttons('操作方式：十字按键').length,1);
  assert.equal(f.scene.buttons('拖动调整').length,1);

  clickRow('操作方式：十字按键');
  assert.equal(controlSettings.mode,'keyboard');
  assert.equal(f.scene.buttons('操作方式：电脑模式').length,1);
  assert.equal(f.scene.buttons('修改键位').length,1,'电脑模式显示键位设置入口');
  assert.equal(f.scene.buttons('拖动调整').length,0);

  clickRow('操作方式：电脑模式');
  assert.equal(controlSettings.mode,'stick');
  assert.equal(f.scene.buttons('操作方式：虚拟摇杆').length,1);
  assert.equal(f.scene.buttons('拖动调整').length,1);

  // 触屏的“拖动调整”打开的就是可拖动控件面板。
  clickRow('拖动调整');
  assert(f.controls.controlLayoutEditing);
  assert.equal(touchObjects(),CONTROL_IDS.length);
  assert.equal(f.scene.buttons('恢复默认').length,1);
});

test('control editor cancels unfinished drags on input cancellation, suspension, resize, leaving canvas and close',t=>{
  for(const cancel of ['input','suspend','resize','outside','close'] as const) {
    const f=fixture();t.after(f.cleanup);f.app.controlLayout.set('move',{x:.25,y:.65});openControls(f);
    const object=editingControl(f,'move'),pointer=f.scene.input.activePointer;
    object.emit('dragstart',pointer);object.emit('drag',pointer,512,320);
    if(cancel==='input')f.controls.resetInput();
    if(cancel==='suspend'){f.controls.suspend(true);f.controls.suspend(false);}
    if(cancel==='resize')f.scene.resize(1280,720);
    if(cancel==='outside')f.scene.input.emit('gameout');
    if(cancel==='close')f.scene.click(f.scene.button('关闭控件位置'));
    object.emit('dragend',pointer);
    assert.deepEqual(f.app.controlLayout.snapshot(),{move:{x:.25,y:.65}},cancel);
    if(cancel!=='close') {
      const expected=resolveControlLayout(controlViewport(f.scene as unknown as Phaser.Scene),f.app.controlLayout.snapshot()).move;
      assert.deepEqual([object.x,object.y],[expected.x,expected.y],cancel);
    }
  }
});

test('shortcut registration uses the same custom positions for both pages',t=>{
  const f=fixture();t.after(f.cleanup);
  f.app.controlLayout.set('slot-0',{x:.2,y:.4});f.app.controlLayout.set('swap',{x:.6,y:.3});
  const source=f.entry(items.startingShortcut);f.menu.debugDescribe(source.id);
  f.scene.click(f.scene.button('取消快捷键'));f.scene.click(f.scene.button('快捷键'));
  const center=(button:Display)=>button.getWorldTransformMatrix().transformPoint(button.input!.hitArea.width/2,button.input!.hitArea.height/2);
  const expected=resolveControlLayout(controlViewport(f.scene as unknown as Phaser.Scene),f.app.controlLayout.snapshot());
  for(let page=0;page<2;page++) {
    assert.deepEqual(center(f.scene.button('快捷位 1')),{x:expected['slot-0'].x,y:expected['slot-0'].y});
    assert.deepEqual(center(f.scene.button('切换技能组')),{x:expected.swap.x,y:expected.swap.y});
    f.scene.click(f.scene.button('切换技能组'));
  }
});

test('party and shop modal placement survives StoryUI sync and resize in either opening order', t => {
  for (const order of [['party', 'shop'], ['shop', 'party']] as const) {
    const f = fixture(); t.after(f.cleanup); const member = f.recruit(); f.session.party!.reserve(member.id);
    for (const kind of order) {
      if (kind === 'party') { f.menu.show('party'); f.scene.click(f.scene.button(member.definition.name)); f.scene.click(f.scene.button('放逐')); }
      else f.menu.debugShop(f.app.shops.lampShop, 'quantity');
      const expected = kind === 'party' ? { x: 153, y: 112.5 } : { x: 287, y: 145 };
      const centered = () => {
        const position = f.internals.surface.root.getWorldTransformMatrix().transformPoint(expected.x, expected.y), modal = f.internals.modal.root;
        assert(Math.abs(modal.x - position.x) < 1e-7, `${kind} 横向中心保持自身尺寸`);
        assert(Math.abs(modal.y - position.y) < 1e-7, `${kind} 纵向中心保持自身尺寸`);
      };
      assert(f.internals.modal.root.visible); centered(); f.menu.sync(); centered();
      f.scene.resize(1366, 768); centered(); f.menu.sync(); centered();
      f.scene.key('Escape');
    }
  }
});

test('native rarity colors reach the real menu Text objects in bag, worn equipment and shop descriptions', t => {
  const f=fixture();t.after(f.cleanup);
  const owned=f.add(items.startingEquipment['dark-knight']['main-hand']!);
  f.session.bag.equip(owned.id,'main-hand','player',f.hero.classId,f.hero.level);
  for(const [grade,color] of [[10,'#ffe600'],[14,'#9c00ff']] as const){
    const state=f.session.bag.captureState();state.instances.find(entry=>entry.id===owned.id)!.numbers!.grade=grade;
    f.session.bag.restoreState(state);
    for(const side of ['left','right'] as const){
      f.menu.debugDescribe(owned.id,side);
      assert.equal(f.scene.nodes.find(node=>node.shown&&node.text===items.items[owned.item].name)!.color,color);
    }
  }
  t.mock.method(Math,'random',()=>.2);
  f.menu.openShop('rare-items-dealer-2d609a7f','');
  const offer=f.internals.shopPanel!.store.offers[0];offer.concealed=false;offer.instance.numbers!.grade=10;
  f.scene.click(f.scene.buttons(`购买 ${items.items[offer.instance.item].name}`)[0]!);
  assert.equal(f.scene.nodes.find(node=>node.shown&&node.text===items.items[offer.instance.item].name)!.color,'#ffe600');
});

test('rare shop conceals descriptions before purchase and preserves full instances after purchase', t => {
  t.mock.method(Math, 'random', () => .2);
  const f = fixture(); t.after(f.cleanup); f.session.gainMoney(1_000_000);
  const rare = 'rare-items-dealer-2d609a7f'; f.menu.openShop(rare, '');
  const offer = f.internals.shopPanel!.store.offers[0], original = structuredClone(offer.instance), item = items.items[original.item];
  assert.equal(offer.concealed, true); assert.equal(original.numbers?.sockets, 1);
  assert.equal(original.numbers?.gradeName, '生锈的', '固定随机源生成普通稀有度、带前缀的珍品');
  f.scene.click(f.scene.buttons(`购买 ${item.name}`)[0]!);
  const title = (name:string) => f.scene.nodes.find(node => node.shown && node.text === name)!;
  assert.equal(title(`${item.typeName}（未鉴定）`).color, '#808080', '购买前显示原版灰色未鉴定名称');
  assert.equal(f.internals.description.scrolls[0]!.content.list.length, 0, '购买前正文没有属性、品质、孔位或宝石图标');
  f.scene.click(f.scene.button('购买')); f.scene.click(f.scene.button('确定'));
  const purchased = f.session.bag.entries.find(entry => entry.item === original.item)!;
  assert(purchased); assert.deepEqual(purchased.numbers, original.numbers, '购买完整保留原数值实例');
  assert.deepEqual(purchased.gems, original.gems); assert.equal(purchased.enhancement, original.enhancement);
  assert.notEqual(purchased.id, original.id, '商品进入背包获得独立持有标识');
  f.menu.debugDescribe(purchased.id);
  assert.equal(title(`生锈的 ${item.name}`).color, '#ffffff', '普通稀有度保持原版白色，品质前缀在名称中');
  assert(f.scene.texts().join('\n').includes('防御力'), '背包中显示实际装备数值');
  assert(f.scene.texts().join('\n').includes('宝石孔数量 1'), '拥有后可见原实例的一孔');
  f.menu.openShop(rare, ''); f.scene.click(f.scene.button(`出售 ${item.name}`));
  assert(f.internals.description.scrolls[0]!.content.list.length > 0, '出售已拥有装备仍显示完整正文');
  assert.equal(title(`生锈的 ${item.name}`).color, '#ffffff', '出售说明保留原版名称与品质色');

  const regular = Object.entries(f.app.shops.shops).find(([, shop]) => shop.categories.length && shop.stockRules.some(rule => rule.kind === 'level-range'))![0];
  f.menu.openShop(regular, ''); const ordinary = f.internals.shopPanel!.store.offers[0];
  assert.equal(ordinary.concealed, false); f.scene.click(f.scene.buttons(`购买 ${items.items[ordinary.instance.item].name}`)[0]!);
  assert(f.internals.description.scrolls[0]!.content.list.length > 0, '普通商品购买前保持正常说明');
});

test('shop category changes reset scrolling while details, transactions and session updates preserve it', t => {
  const f = fixture(); t.after(f.cleanup);
  const supplies = Object.keys(items.items).filter(id => items.items[id].category === 'consumable' && !items.items[id].pickup).slice(0, 40);
  assert.equal(supplies.length, 40); for (const id of supplies) f.add(id);
  f.menu.openShop(f.app.shops.lampShop, '');
  const bagScroll = (): ScrollArea => f.internals.shopPanel!.bagScroll!;
  const wheel = (distance: number) => {
    const scroll = bagScroll(), point = scroll.surface.root.getWorldTransformMatrix().transformPoint(scroll.x + 10, scroll.y + 10);
    Object.assign(f.scene.input.activePointer, point); f.scene.input.emit('wheel', f.scene.input.activePointer, [], 0, distance);
    return scroll.scrollTop;
  };
  assert(wheel(300) >= 300, '全部列表先滚动至少300个内容像素');
  f.scene.click(f.scene.button('消耗')); assert.equal(bagScroll().scrollTop, 0, '分类回调重绘后从顶部开始');
  f.scene.click(f.scene.button('全部')); assert.equal(bagScroll().scrollTop, 0, '返回全部同样从顶部开始');
  f.scene.click(f.scene.button('消耗')); const offset: number = wheel(150); assert(offset > 0);
  f.session.gainMoney(1); assert.equal(bagScroll().scrollTop, offset, 'Session通知触发真实StoryUI重绘仍保留位置');
  const button = f.scene.nodes.find(node => {
    const label = String(node.getData('label') ?? ''), entry = f.session.bag.entries.find(entry => label === `出售 ${items.items[entry.item].name}`);
    return node.shown && !!entry && items.items[entry.item].sellable !== false && f.internals.shopPanel!.store.sellPrice(entry) > 0 && f.scene.canHit(node);
  });
  assert(button, '长列表中有可见且可出售的物品');
  const sold = f.session.bag.entries.find(entry => button.getData('label') === `出售 ${items.items[entry.item].name}`)!;
  const quantity = f.session.bag.count(sold.item); f.scene.click(button);
  assert.equal(bagScroll().scrollTop, offset, '点选详情重绘不跳回顶部');
  f.scene.click(f.scene.button('出售'));
  for (let step = 0; step < 2 && f.internals.modal.root.visible; step++) f.scene.click(f.scene.button('确定'));
  assert.equal(f.session.bag.count(sold.item), quantity - 1, '通过实际交易按钮完成一次出售');
  assert.equal(bagScroll().scrollTop, offset, '成交及库存通知重绘保持同分类滚动位置');
});

test('bag grid drags swap special items and organise from a category updates every layout', t => {
  const f = fixture(); t.after(f.cleanup);
  const source = f.add('novice-weapon-scroll'), other = f.add('novice-jewel');
  f.menu.show('bag');
  const before = f.session.bag.pouchCells, counts = f.session.bag.counts;
  const from = f.session.bag.allCells.findIndex(entry => entry?.id === source.id),
    to = f.session.bag.allCells.findIndex(entry => entry?.id === other.id);
  f.scene.press(f.scene.button(items.items[source.item].name)); f.scene.hold();
  f.scene.pointAt(f.scene.button(items.items[other.item].name));
  f.scene.input.activePointer.isDown = false;
  f.scene.input.emit('pointerup', f.scene.input.activePointer);
  assert.equal(f.internals.operation, undefined,'强化道具拖到物品上用于交换位置');
  assert.equal(f.session.bag.allCells[to]!.id,source.id);assert.equal(f.session.bag.allCells[from]!.id,other.id);
  assert.deepEqual(f.session.bag.pouchCells,before);
  assert.deepEqual(f.session.bag.counts,counts);
  f.scene.click(f.scene.button('材料'));
  f.session.bag.placeInCell(source.id,'material',8);
  let updates=0;const unsubscribe=f.session.subscribe(()=>updates++);t.after(unsubscribe);
  f.scene.click(f.scene.button('整理'));
  assert.equal(updates,1,'整理按钮在分类页面也一次性更新全部与分类');
  assert.deepEqual(f.session.bag.allCells.map(entry=>entry!.id),f.session.bag.entries.map(entry=>entry.id));
  for(const cells of Object.values(f.session.bag.pouchCells))assert.equal(cells.some(entry=>entry===undefined),false);
  f.scene.click(f.scene.button('整理'));assert.equal(updates,1,'重复整理无更新');
});

test('processing items use the equipment forge instead of drag-and-drop', t => {
  const f=fixture();t.after(f.cleanup);
  const source=f.add('novice-weapon-scroll',3),weapon=f.hero.bag.get(f.hero.bag.equipment['main-hand']!)!;
  f.hero.bag.unequip('main-hand');
  const state=f.hero.bag.captureState(),target=state.instances.find(entry=>entry.id===weapon.id)!;
  target.numbers!.enhancementUses=3;target.numbers!.sockets=3;f.hero.bag.restoreState(state);
  f.menu.show('bag');
  const from=f.hero.bag.allCells.findIndex(entry=>entry?.id===source.id),to=f.hero.bag.allCells.findIndex(entry=>entry?.id===weapon.id);
  assert.equal(f.scene.buttons('强化').length,0,'说明面板打开前没有强化按钮');
  f.scene.press(f.scene.button(items.items[source.item].name));f.scene.hold();
  f.scene.pointAt(f.scene.button(items.items[weapon.item].name));
  f.scene.input.activePointer.isDown=false;f.scene.input.emit('pointerup',f.scene.input.activePointer);
  assert.equal(f.hero.bag.count(source.item),3,'拖到装备上不再直接使用');
  assert.equal(f.hero.bag.get(weapon.id)!.enhancement,0);
  assert.equal(f.hero.bag.allCells[to]!.id,source.id,'拖放仍然交换格位');
  assert.equal(f.hero.bag.allCells[from]!.id,weapon.id);
  f.menu.debugDescribe(weapon.id);
  assert.equal(f.scene.buttons('强化/镶嵌').length,1,'装备说明进入强化台');
  f.scene.click(f.scene.button('强化/镶嵌'));
  assert.ok(f.internals.forge);
  const originalRandom=Math.random;Math.random=()=>0;t.after(()=>{Math.random=originalRandom;});
  f.scene.click(f.scene.button('卷轴:低级武器强化卷轴'));
  assert.equal(f.hero.bag.count(source.item),2);
  assert.equal(f.hero.bag.get(weapon.id)!.enhancement,2);
  assert.ok(f.scene.texts().some(text=>text.includes('强化大成功 +2')));
  assert.equal(f.controls.instant.text,'','结果留在 forge，不走即时消息');
});

test('fusion menu selects or drags equipment, confirms once and blocks underlying input', t => {
  const f=fixture();t.after(f.cleanup);const bag=f.session.bag;
  const target=bag.equipment['main-hand']!;bag.unequip('main-hand');
  const item=items.items[bag.get(target)!.item];
  f.session.gainMoney(100000);
  for(const op of Object.values(f.app.crafting!.operations))for(const m of op.materials)f.add(m.item,m.quantity*4);
  const machine=Object.keys(world.actors).find(id=>world.actors[id].service==='fusion-machine')!;
  f.menu.openCrafting(machine);f.scene.click(f.scene.button('切换融合模式'));f.scene.click(f.scene.button('深渊混沌合成'));
  f.scene.click(f.scene.button(item.name));
  assert(f.scene.texts().some(text=>text.replace(/\n/g,'')==='深渊混沌道具只适用于混沌道具。'));
  f.scene.key('Escape');f.scene.click(f.scene.button('混沌合成'));
  f.scene.press(f.scene.button(item.name));f.scene.hold();f.scene.pointAt(f.scene.button('合成装备'));
  f.scene.input.activePointer.isDown=false;f.scene.input.emit('pointerup',f.scene.input.activePointer);
  assert(f.scene.texts().includes(item.name));
  const before=bag.captureState(),money=f.session.money;
  f.scene.click(f.scene.button('组合'));
  assert(f.scene.texts().includes('是否以当前的配方来合成？'));
  assert.equal(f.scene.canHit(f.scene.button('深渊混沌合成')),false);
  const no=f.scene.button('否');f.scene.click(no);assert.deepEqual(bag.captureState(),before);assert.equal(f.session.money,money);
  f.scene.click(f.scene.button('组合'));
  const yes=f.scene.button('是');f.scene.click(yes);
  assert.equal(bag.get(target)!.numbers!.chaos!.tier,'chaos');assert.equal(f.session.money,money-item.level*700);
  assert.deepEqual(bag.captureState().allCells,before.allCells);
  yes.getData('action')();assert.equal(f.session.money,money-item.level*700,'同一个确认按钮不会再次扣费');
  f.scene.click(f.scene.button('深渊混沌合成'));f.scene.click(f.scene.button(item.name));f.scene.click(f.scene.button('组合'));f.scene.click(f.scene.button('是'));
  assert.equal(bag.get(target)!.numbers!.chaos!.tier,'epic-chaos');assert.equal(f.session.money,money-item.level*1600);
  f.menu.close();assert.equal(f.controls.locked,false);
});

test('save page writes the loaded world into the chosen slot and asks before overwriting it', t => {
  const f=fixture();t.after(f.cleanup);
  f.session.gainMoney(77);f.session.accept('grafton-mission');
  f.menu.show('save');
  f.scene.click(f.scene.button('存档槽 2'));
  const written=f.app.saves.inspect(1);
  assert.equal(written.kind,'ok');
  if(written.kind!=='ok')return;
  assert.deepEqual({ ...written.game.summary, savedAt:undefined },{ classId:'dark-knight', className:'黑暗骑士', portrait:f.app.menuPanels.character.portraits.kiyan.image,
    level:1, mapId:campaign.start.map, mapName:'测试地图', savedAt:undefined });
  assert.ok(Number.isFinite(written.game.summary.savedAt),'手动保存写入了时间');
  assert.equal(written.game.world.location.x,16);
  assert.deepEqual(written.game.session.money,f.session.money);
  assert(f.scene.texts().includes('保存成功'));
  f.scene.click(f.scene.button('确认'));
  assert.equal(f.internals.modal.root.visible,false);

  // 槽里的摘要回到面板上：标题、地图名与等级/职业。
  f.menu.show('save');
  assert(f.scene.texts().includes('测试地图')&&f.scene.texts().includes('LV.1 · 黑暗骑士'));

  // 已有存档的槽再存要先确认；选「否」时槽里的字节一个都不动。
  const bytes=JSON.stringify(f.app.saves.inspect(1));
  f.scene.click(f.scene.button('存档槽 2'));
  assert(f.scene.texts().includes('这个存档槽里已经有存档，确定覆盖？'));
  // 确认层铺满整屏：花纹从屏幕左缘平铺，最后一格覆盖到右缘之外由画布裁掉。
  const edgeKey=`interface:${f.app.menuPanels.assets['message-edge']}`;
  const edges=f.scene.nodes.filter(node=>node.shown&&node.texture.key===edgeKey);
  assert.ok(edges.length>0);
  const left=Math.min(...edges.map(edge=>edge.getWorldTransformMatrix().transformPoint(0,0).x));
  const right=Math.max(...edges.map(edge=>edge.getWorldTransformMatrix().transformPoint(edge.width,0).x));
  assert.ok(Math.abs(left)<1e-6,`花纹从画布左缘开始，实际 ${left}`);
  assert.ok(right>=1024,`花纹要盖过整屏宽度，实际到 ${right}`);
  assert.equal(f.scene.canHit(f.scene.button('存档槽 1')),false,'确认框挡住下层槽位');
  f.scene.click(f.scene.button('否'));
  assert.equal(JSON.stringify(f.app.saves.inspect(1)),bytes);
  f.session.gainMoney(5);
  f.scene.click(f.scene.button('存档槽 2'));f.scene.click(f.scene.button('是'));
  const overwritten=f.app.saves.inspect(1);
  assert.equal(overwritten.kind==='ok'&&overwritten.game.session.money,f.session.money,'确认后写入当前状态');
  assert(f.scene.texts().includes('保存成功'));
});

/** 存档行按钮所在的滚动区；按行按钮的直接父容器匹配，顺带验证行确实画进了滚动内容。 */
function slotRowScroll(f:ReturnType<typeof fixture>,row:Display):ScrollArea{
  const scroll=f.internals.surface.scrolls.find(value=>(value.content as unknown as Display)===row.parentContainer);
  assert.ok(scroll,'行按钮位于滚动区内容容器里');return scroll;
}
/** 在行上按下、纵向拖动超过阈值再抬手；返回这次手势所在的滚动区。 */
function dragSlotRow(f:ReturnType<typeof fixture>,row:Display):ScrollArea{
  const scroll=slotRowScroll(f,row);
  f.scene.press(row);
  f.scene.input.activePointer.y-=40;
  f.scene.input.emit('pointermove',f.scene.input.activePointer);
  f.scene.release(row);
  return scroll;
}

test('dragging a save slot scrolls instead of saving or confirming an overwrite', t => {
  const f=fixture();t.after(f.cleanup);
  f.menu.show('save');
  const scroll=dragSlotRow(f,f.scene.button('存档槽 2'));
  assert.equal(scroll.moved,true,'拖动超过阈值');
  assert(scroll.scrollTop>0,'列表跟随手指滚动');
  assert.deepEqual(f.app.saves.inspect(1),{kind:'empty'},'拖动抬手不写空槽');
  assert(!f.scene.texts().includes('保存成功'));
  assert.equal(f.internals.modal.root.visible,false);

  // 拖动后原地点同一行仍然存档：新的 pointerdown 会重置滚动区的拖动标记。
  f.scene.click(f.scene.button('存档槽 2'));
  assert.equal(f.app.saves.inspect(1).kind,'ok');
  assert(f.scene.texts().includes('保存成功'));
  f.scene.click(f.scene.button('确认'));

  // 行内「删除」控件也在同一个 content 里：拖动不弹删除确认。
  dragSlotRow(f,f.scene.button('存档槽 2 删除'));
  assert(!f.scene.texts().includes('删除后无法恢复，确定删除这个存档？'));
  assert.equal(f.internals.modal.root.visible,false);

  // 已有存档：拖动抬手不弹覆盖确认，原地点击才弹。
  dragSlotRow(f,f.scene.button('存档槽 2'));
  assert(!f.scene.texts().includes('这个存档槽里已经有存档，确定覆盖？'));
  assert.equal(f.internals.modal.root.visible,false);
  // 存档后列表按时间倒序，刚存的槽会跳到第一行；先把滚动位置拉回顶部再点。
  const row=f.scene.button('存档槽 2');
  slotRowScroll(f,row).scrollTop=0;
  f.scene.click(row);
  assert(f.scene.texts().includes('这个存档槽里已经有存档，确定覆盖？'));
});

test('dragging a load slot scrolls instead of asking to load, and a tap afterwards still asks', async t => {
  const f=fixture();t.after(f.cleanup);let loads=0;
  f.app.resumeSlot=async()=>{loads++;};
  f.menu.show('save');f.scene.click(f.scene.button('存档槽 2'));f.scene.click(f.scene.button('确认'));
  f.menu.show('load');
  const scroll=dragSlotRow(f,f.scene.button('存档槽 2'));
  assert.equal(scroll.moved,true,'拖动超过阈值');
  assert(scroll.scrollTop>0,'列表跟随手指滚动');
  assert(!f.scene.texts().includes('读取存档将丢失当前未保存的进度，确定读取？'),'拖动不弹读档确认');
  assert.equal(loads,0);
  assert.equal(f.internals.modal.root.visible,false);

  f.scene.click(f.scene.button('存档槽 2'));
  assert(f.scene.texts().includes('读取存档将丢失当前未保存的进度，确定读取？'));
  f.scene.click(f.scene.button('是'));
  await Promise.resolve();
  assert.equal(loads,1);
});

test('saving without a loaded world reports the original refusal and leaves the slot empty', t => {
  const f=fixture();t.after(f.cleanup);
  f.app.captureSaveWorld=undefined;
  f.menu.show('save');
  f.scene.click(f.scene.button('存档槽 1'));
  assert(f.scene.texts().includes('在当前的地图中无法进行存档。'));
  assert.deepEqual(f.app.saves.inspect(0),{kind:'empty'});
  f.scene.click(f.scene.button('确认'));
  assert.deepEqual(f.app.saves.inspect(0),{kind:'empty'});
});

test('save refusal distinguishes a debug scene from map loading and a missing world', t => {
  const f=fixture();t.after(f.cleanup);
  f.app.captureSaveWorld=()=>({ok:false,reason:'debug'});
  f.menu.show('save');f.scene.click(f.scene.button('存档槽 1'));
  assert(f.scene.texts().includes('调试现场不能存档，请先在调试面板点「结束本次调试」。'));
  f.scene.click(f.scene.button('确认'));
  f.app.captureSaveWorld=()=>({ok:false,reason:'loading'});
  f.menu.show('save');f.scene.click(f.scene.button('存档槽 1'));
  assert(f.scene.texts().includes('地图正在载入，请稍后再存档。'));
  f.scene.click(f.scene.button('确认'));
  f.app.captureSaveWorld=()=>({ok:false,reason:'not-ready'});
  f.menu.show('save');f.scene.click(f.scene.button('存档槽 1'));
  assert(f.scene.texts().includes('在当前的地图中无法进行存档。'));
  f.scene.click(f.scene.button('确认'));
  assert.deepEqual(f.app.saves.inspect(0),{kind:'empty'});
});

test('the auto row is read-only while manual slots can be deleted after a confirmation', t => {
  const f=fixture();t.after(f.cleanup);
  f.menu.show('save');
  // 自动槽没有改名/删除入口，也没有保存动作。
  assert.equal(f.scene.buttons('自动存档 改名').length,0);
  assert.equal(f.scene.buttons('自动存档 删除').length,0);
  assert.equal(f.scene.buttons('自动存档').length,0);
  // 十个手动槽都在列表里。
  for(let slot=1;slot<=10;slot++)assert.equal(f.scene.buttons(`存档槽 ${slot}`).length,1,`存档槽 ${slot}`);
  f.scene.click(f.scene.button('存档槽 1'));f.scene.click(f.scene.button('确认'));
  assert.equal(f.app.saveSlot,0);
  f.scene.click(f.scene.button('存档槽 1 删除'));
  assert(f.scene.texts().includes('删除后无法恢复，确定删除这个存档？'));
  f.scene.click(f.scene.button('否'));
  assert.equal(f.app.saves.inspect(0).kind,'ok','选「否」不动存档');
  f.scene.click(f.scene.button('存档槽 1 删除'));f.scene.click(f.scene.button('是'));
  assert.equal(f.app.saves.inspect(0).kind,'empty');
  assert.equal(f.app.saveSlot,undefined,'删掉当前槽后清空 saveSlot');
});

test('renaming a save asks for text and only stores Chinese, English and digits',async t=>{
  const f=fixture();t.after(f.cleanup);
  f.menu.show('save');f.scene.click(f.scene.button('存档槽 1'));f.scene.click(f.scene.button('确认'));
  const before=f.app.saves.inspect(0);assert.equal(before.kind,'ok');if(before.kind!=='ok')return;
  let asked='';
  Object.defineProperty(f.app,'promptText',{configurable:true,value:async(initial:string)=>{asked=initial;return '第一章！？';}});
  f.scene.click(f.scene.button('存档槽 1 改名'));
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(asked,'','首次改名时输入框是空的');
  const after=f.app.saves.inspect(0);assert.equal(after.kind,'ok');if(after.kind!=='ok')return;
  assert.equal(after.game.summary.name,'第一章','只保留中文、英文和数字');
  assert.equal(after.game.summary.savedAt,before.game.summary.savedAt,'改名不动存档内容');
  // 改名后的行标题用新名字；行按钮的可访问名仍是「存档槽 N」。
  assert(f.scene.texts().includes('第一章'));
  f.scene.click(f.scene.button('存档槽 1 删除'));
  f.scene.click(f.scene.button('否'));
});

test('system opens load slots and confirmation isolates input before restoring a valid slot',async t=>{
  const f=fixture();t.after(f.cleanup);let loads=0,signal:AbortSignal|undefined;
  f.app.resumeSlot=async(slot,request)=>{assert.equal(slot,1);loads++;signal=request;};
  f.menu.show('save');f.scene.click(f.scene.button('存档槽 2'));f.scene.click(f.scene.button('确认'));
  const saved=f.app.saves.inspect(1);assert.equal(saved.kind,'ok');if(saved.kind!=='ok')return;
  const damaged=structuredClone(saved.game);Reflect.deleteProperty(damaged,'world');f.app.saves.write(0,damaged);assert.equal(f.app.saves.inspect(0).kind,'unreadable');
  f.menu.show('system');f.scene.click(f.scene.button('读取存档'));
  assert(f.scene.texts().includes('读取存档'));
  assert.equal(f.scene.buttons('存档槽 1').length,0);assert.equal(f.scene.buttons('存档槽 3').length,0);
  f.scene.click(f.scene.button('存档槽 2'));
  assert(f.scene.texts().includes('读取存档将丢失当前未保存的进度，确定读取？'));
  assert.equal(loads,0);assert.equal(f.scene.canHit(f.scene.button('存档槽 2')),false);
  f.scene.click(f.scene.button('否'));assert.equal(loads,0);
  f.scene.click(f.scene.button('存档槽 2'));f.scene.key('Escape');assert.equal(loads,0);assert.equal(f.internals.modal.root.visible,false);
  f.scene.click(f.scene.button('存档槽 2'));f.scene.click(f.scene.button('是'));
  await Promise.resolve();assert.equal(loads,1);assert.equal(signal?.aborted,false);
});

test('load preparation keeps the game menu alive under loading and reports failure without altering the session',async t=>{
  const f=fixture();t.after(f.cleanup);const before=f.session.captureState();let reject!:(error:Error)=>void,signal:AbortSignal|undefined;
  f.app.resumeSlot=async(_slot,request)=>{
    signal=request;f.controls.loading('正在读取存档…');
    try{await new Promise<void>((_done,fail)=>reject=fail);}finally{f.controls.loaded();}
  };
  f.menu.show('save');f.scene.click(f.scene.button('存档槽 1'));f.scene.click(f.scene.button('确认'));
  f.menu.show('load');f.scene.click(f.scene.button('存档槽 1'));f.scene.click(f.scene.button('是'));
  assert.equal(signal?.aborted,false);assert.equal(f.internals.busy,true);assert.equal(f.controls.locked,true);
  reject(new Error('存档内容无效'));await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.internals.busy,false);assert(f.scene.texts().includes('存档内容无效'));
  assert.deepEqual(f.session.captureState(),before);assert.equal(f.controls.mode,'game');assert.equal(f.controls.ready,true);
  f.scene.click(f.scene.button('确认'));assert.equal(f.scene.canHit(f.scene.button('存档槽 1')),true);
});

test('closing a pending load cancels its preparation and a late error cannot reopen the menu',async t=>{
  const f=fixture();t.after(f.cleanup);let reject!:(error:Error)=>void,signal:AbortSignal|undefined;
  f.app.resumeSlot=async(_slot,request)=>{signal=request;await new Promise<void>((_done,fail)=>reject=fail);};
  f.menu.show('save');f.scene.click(f.scene.button('存档槽 1'));f.scene.click(f.scene.button('确认'));
  f.menu.show('load');f.scene.click(f.scene.button('存档槽 1'));f.scene.click(f.scene.button('是'));
  f.scene.key('Escape');assert.equal(signal?.aborted,true);assert.equal(f.controls.locked,false);
  reject(new Error('late failure'));await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.internals.surface.root.visible,false);assert(!f.scene.texts().includes('late failure'));
});

test('the GM story page lists tasks and enters the selected one without exposing identifiers', async t => {
  const f=fixture();t.after(f.cleanup);
  const gm=createGmActions({session:f.session,campaign,report:async()=>true});
  gm.previewStory=async target=>({ok:true,preview:{quest:target.quest,phase:'available',location:campaign.start}});
  Object.defineProperty(f.app,'gm',{value:gm,configurable:true});
  f.menu.show('debug');f.scene.click(f.scene.button('调试页 剧情'));
  assert.equal(f.scene.buttons('分类 全部').length,0,'不再提供混合全部栏');
  assert.ok(f.scene.button('分类 主线')&&f.scene.button('分类 支线'));
  const texts=()=>f.scene.texts().join(' ');
  const taskButtons=()=>f.scene.nodes.filter(node=>node.shown&&node.getData('uiAction')&&String(node.getData('label')).startsWith('任务 '));
  assert(taskButtons().length>0,'剧情页没有列出任务');
  assert(!/event-\d|scene-\d|quest-\d|shadow-camp/.test(texts()));
  assert.equal(f.scene.buttons('任务 向卓拉德报告').length,0);
  await new Promise(resolve=>setImmediate(resolve));
  assert(f.scene.button('进入任务').input?.enabled);
  assert(texts().includes('调试现场：'));
  assert(texts().includes('默认起点：'));
  f.scene.click(f.scene.button('进入任务'));
  await new Promise(resolve=>setImmediate(resolve));
  const last=gm.actions().at(-1)!;
  assert.equal(last.call,'jumpStory');
  assert.equal(last.ok,false);
  const target=last.args[0] as {quest:string};
  assert(campaign.debugStory!.tasks.some(task=>task.quest===target.quest));
  assert(texts().includes('未能进入任务：当前会话还没有装配剧情导演'));
});

test('openDebugStory returns to the story tab without opening a completion dialog', async t => {
  const f=fixture();t.after(f.cleanup);
  const gm=createGmActions({session:f.session,campaign,report:async()=>true});
  gm.previewStory=async target=>({ok:true,preview:{quest:target.quest,phase:'available',location:campaign.start}});
  Object.defineProperty(f.app,'gm',{value:gm,configurable:true});
  f.menu.show('debug');f.scene.click(f.scene.button('调试页 人物'));
  assert.ok(f.scene.button('调试页 剧情'));
  f.menu.openDebugStory();
  const texts=()=>f.scene.texts().join(' ');
  assert.ok(f.scene.button('分类 主线'),'应回到剧情页');
  assert.ok(f.scene.button('进入任务'),'剧情页操作仍可用');
  assert(!texts().includes('调试已结束'),'不应弹出调试结束提示');
  assert(!texts().includes('自动承接'),'不应自动承接下一任务');
});

test('task previews keep late results on their own selection and disable unprepared entries',async t=>{
  const f=fixture();t.after(f.cleanup);
  const gm=createGmActions({session:f.session,campaign});
  const requests:{target:{quest:string};resolve:(result:Awaited<ReturnType<typeof gm.previewStory>>)=>void}[]=[];
  gm.previewStory=target=>new Promise(resolve=>requests.push({target,resolve}));
  Object.defineProperty(f.app,'gm',{value:gm,configurable:true});
  f.menu.show('debug');f.scene.click(f.scene.button('调试页 剧情'));
  const taskButtons=()=>f.scene.nodes.filter(node=>node.shown&&node.getData('uiAction')&&String(node.getData('label')).startsWith('任务 '));
  assert.equal(requests.length,1,'选中第一个任务时只准备这一个现场');
  assert.equal(f.scene.button('进入任务').input?.enabled,false);
  const first=requests[0]!;
  f.scene.click(taskButtons()[1]!);
  assert.equal(requests.length,2);
  first.resolve({ok:true,preview:{quest:first.target.quest,phase:'available',location:campaign.start}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.scene.button('进入任务').input?.enabled,false,'旧任务的完成不能启用新任务');
  requests[1]!.resolve({ok:false,reason:'测试现场缺少前置人物'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.scene.button('进入任务').input?.enabled,false);
  assert(f.scene.texts().join(' ').includes('测试现场缺少前置人物'));
  f.scene.click(taskButtons()[2]??taskButtons()[0]!);
  assert.equal(requests.length,3);
  requests[2]!.resolve({ok:true,preview:{quest:requests[2]!.target.quest,phase:'active',location:campaign.start}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.scene.button('进入任务').input?.enabled,true);
  f.scene.click(f.scene.button('调试页 人物'));
  assert.equal(requests.length,3,'离开剧情页不再发预览');
});


test('the GM character page levels, heals and toggles the debug switches', async t => {
  const f = fixture(); t.after(f.cleanup);
  const flags = new Set<string>();
  const gm = createGmActions({ session: f.session, campaign, report: async () => true, combat: {
    setInvincible: (id, enabled) => { if (enabled) flags.add(id); else flags.delete(id); return { ok: true }; },
    isInvincible: id => flags.has(id),
  } });
  Object.defineProperty(f.app, 'gm', { value: gm, configurable: true });
  f.menu.show('system'); f.scene.click(f.scene.button('调试'));

  for (const label of ['状态', '人物', '道具', '剧情']) {
    const button = f.scene.button(`调试页 ${label}`);
    assert.ok(button.x >= 0 && button.x + button.input!.hitArea.width <= 960, `页签 ${label} 不越界`);
  }

  f.scene.click(f.scene.button('调试页 人物'));
  assert.ok(f.scene.texts().some(text => text.includes('等级 Lv.')), f.scene.texts().join(' | '));
  assert.equal(f.scene.buttons('角色 player').length, 1);
  for (const label of ['升一级', '回满 HP', '回满 MP', '全队回满', '无敌', '技能无 CD']) {
    assert.equal(f.scene.buttons(label).length, 1, label);
  }

  const before = f.hero.level;
  f.scene.click(f.scene.button('升一级'));
  assert.equal(f.hero.level, before + 1);
  assert.equal(gm.actions().at(-1)?.call, 'levelUp');

  f.hero.setHealth(1);
  f.scene.click(f.scene.button('回满 HP'));
  assert.equal(f.hero.player.health, f.hero.player.maxHealth);

  f.scene.click(f.scene.button('无敌'));
  assert.equal(gm.characters()[0]!.invincible, true);
  assert.equal(f.scene.button('无敌').getData('selected'), true);
});

test('the GM item page scrolls addable items, shows details and gives a chosen quantity', async t => {
  const f = fixture(); t.after(f.cleanup);
  const gm = createGmActions({ session: f.session, campaign, report: async () => true });
  Object.defineProperty(f.app, 'gm', { value: gm, configurable: true });
  f.menu.show('system'); f.scene.click(f.scene.button('调试'));
  f.scene.click(f.scene.button('调试页 道具'));

  const slots = () => f.scene.nodes.filter(node => node.shown && String(node.getData('label') ?? '').startsWith('道具 '));
  assert.equal(slots().length, gm.items().length, '所有可发放物品都在同一个滚动列表里');
  assert.ok(!slots().some(node => node.getData('label') === '道具 mana-gem'));

  f.scene.click(f.scene.button('过滤 装备'));
  assert.ok(slots().every(node => {
    const id = String(node.getData('label')).replace(/^道具 /, '');
    return items.items[id]!.category === 'equipment';
  }));

  const first = slots()[0]!;
  const id = String(first.getData('label')).replace(/^道具 /, '');
  const before = f.session.bag.count(id);
  f.scene.click(first);
  assert.ok(f.scene.nodes.some(node => node.shown && node.texture.key === 'interface:assets/ui/menus/inventory-selected.png'),
    '选中后叠背包选中框');
  // 点物品打开与背包同一套说明面板；标题是物品名，关闭按钮独立于菜单关闭。
  assert.ok(f.scene.texts().some(text => text.includes(items.items[id]!.name)), f.scene.texts().join(' | '));
  assert.equal(f.scene.buttons('关闭').length, 1);
  // 详情层停在左半边：右栏的数量/发放按钮（x≥786）与底排金币按钮（y≥404）都不被盖住。
  const detailClose = f.scene.button('关闭');
  assert.ok(detailClose.x < 496, '详情层在左半边');
  assert.ok(detailClose.x + detailClose.input!.hitArea.width < 786, '详情层停在右侧交互按钮左边');
  f.scene.click(detailClose);

  f.scene.click(f.scene.button('数量 +10'));
  f.scene.click(f.scene.button('数量 +10'));
  f.scene.click(f.scene.button('加入背包'));
  assert.equal(f.session.bag.count(id), before + 21);
  assert.equal(gm.actions().at(-1)?.call, 'giveItem');

  // 列表用滚动，不再有翻页按钮。
  assert.equal(f.scene.buttons('上一页').length, 0);
  assert.equal(f.scene.buttons('下一页').length, 0);
  assert.ok(f.scene.texts().includes('滚轮或拖动列表查看更多'));

  const money = f.session.money;
  f.scene.click(f.scene.button('金币 +1万'));
  assert.equal(f.session.money, money + 10_000);
  assert.equal(gm.actions().at(-1)?.call, 'gainMoney');
});

test('session notifications only repaint the menu page whose data changed', t => {
  const f=fixture();t.after(f.cleanup);
  f.menu.show('bag');
  const close=f.scene.button('关闭菜单');
  // 背包页不显示生命值；战斗回血/掉血的会话通知不该把整页背包重建一遍。
  f.hero.setHealth(Math.max(1,f.hero.player.health-1));
  assert.equal(f.scene.button('关闭菜单'),close,'只改生命值时背包页保持原对象');
  // 钱是背包页真正显示的数据；变化后必须真实重绘动态内容，但静态关闭按钮不重建。
  const bagScroll=f.internals.body.scrolls[0];
  f.session.gainMoney(1);
  const rebuilt=f.scene.button('关闭菜单');
  assert.equal(rebuilt,close,'静态关闭按钮不重建');
  assert.notEqual(f.internals.body.scrolls[0],bagScroll,'钱变化后背包动态内容重绘');
  assert.equal(close.active,true,'静态对象仍在使用');

  // 系统页不消费会话数据，任何会话通知都不该重绘它。
  f.menu.show('system');
  const systemClose=f.scene.button('关闭菜单');
  f.session.gainMoney(1);
  assert.equal(f.scene.button('关闭菜单'),systemClose,'系统页不因会话通知重绘');

  // 状态页显示生命值，变化时必须重绘动态内容；静态关闭按钮保持同一个对象。
  f.menu.show('status');
  const statusClose=f.scene.button('关闭菜单');
  const statusDynamic=f.internals.body.root.list.find(child=>child!==f.internals.body.staticRoot);
  f.hero.setHealth(Math.max(1,f.hero.player.health-1));
  assert.equal(f.scene.button('关闭菜单'),statusClose,'静态关闭按钮不重建');
  assert.notEqual(f.internals.body.root.list.find(child=>child!==f.internals.body.staticRoot),statusDynamic,'状态页数值变化时重绘动态内容');
});

test('bag chrome is reused across rerenders and replaced when the page changes', t => {
  const f=fixture();t.after(f.cleanup);
  f.menu.show('bag');
  const chrome=f.internals.body.staticRoot,count=chrome.list.length,first=chrome.list[0];
  assert(count>0,'背包页有静态图框');
  f.session.gainMoney(1);
  assert.equal(f.internals.body.staticRoot,chrome,'同页重画沿用静态容器');
  assert.equal(chrome.list.length,count,'同页重画不重复添加图框');
  assert.equal(chrome.list[0],first,'同页重画复用同一批静态对象');
  f.menu.show('status');
  assert.equal(chrome.list.length,0,'换页后旧静态层被清掉');
  f.menu.show('bag');
  assert(chrome.list.length>0,'回到背包页重新建静态图框');
});
