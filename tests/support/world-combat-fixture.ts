import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import type { StoryContext } from '../../src/application/ports.ts';
import type { BattleCatalog } from '../../src/domain/battle.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../../src/domain/character-stats.ts';
import type { WorldMap } from '../../src/domain/content.ts';
import type { DropCatalog } from '../../src/domain/drops.ts';
import type { ItemCatalog } from '../../src/domain/items.ts';
import { Session } from '../../src/domain/session.ts';
import type { WardrobeCatalog } from '../../src/domain/wardrobe.ts';
import { WorldEnemyRoster } from '../../src/domain/world-enemies.ts';
import type { CharacterVisual } from '../../src/rendering/characters.ts';
import type { MovementWorld } from '../../src/rendering/movement-world.ts';
import type { WorldCombat } from '../../src/scenes/world-combat.ts';
import type { CombatWorldHost } from '../../src/scenes/world-combat-host.ts';
import { NavigationWorld, type NavigationActor, type NavigationFaction } from '../../src/domain/navigation-world.ts';
import type { Point } from '../../src/domain/navigation.ts';
import {
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadContentCatalog,
  loadDropCatalog,
  loadItemCatalog,
  loadWardrobeCatalog,
} from './combat-test-harness.ts';
import { FakeSprite } from './fake-sprite.ts';

export const PHASER_STUB_SOURCE = `
export default {
  BlendModes: { NORMAL: 0, ADD: 1, MULTIPLY: 2, SCREEN: 3 },
  TintModes: { FILL: 0, OVERLAY: 1 },
  Geom: {
    Rectangle: class {
      constructor(x = 0, y = 0, width = 0, height = 0) {
        this.x = x; this.y = y; this.width = width; this.height = height;
      }
      static Contains(area, x, y) {
        if (!area || typeof area !== 'object') return true;
        return x >= area.x && y >= area.y && x <= area.x + area.width && y <= area.y + area.height;
      }
    },
  },
  Core: { Events: { POST_RENDER: 'postrender' } },
  Scenes: { Events: { SHUTDOWN: 'shutdown', PRE_UPDATE: 'preupdate', POST_UPDATE: 'postupdate', PRE_RENDER: 'prerender' } },
  Input: { Events: { POINTER_DOWN: 'pointerdown' } },
  Scene: class { constructor(config) { this.config = config; } },
  Physics: { Arcade: { Body: class {} } },
};
`;

let cachedWorldCombatCtor: typeof WorldCombat | undefined;

/**
 * 注册最小 Phaser 运行时桩并动态加载 `WorldCombat` 构造函数。
 * 纯领域测试不要调用此函数；只有场景级 `WorldCombat` 集成测试才使用。
 */
export async function loadWorldCombatClass(): Promise<typeof WorldCombat> {
  if (cachedWorldCombatCtor) return cachedWorldCombatCtor;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'phaser'
        ? { url: `data:text/javascript,${encodeURIComponent(PHASER_STUB_SOURCE)}`, shortCircuit: true }
        : next(specifier, context);
    },
  });
  try {
    const mod = await import('../../src/scenes/world-combat.ts');
    cachedWorldCombatCtor = mod.WorldCombat;
    return cachedWorldCombatCtor;
  } finally {
    hook.deregister();
  }
}

export function installPhaserStubHooks() {
  return registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'phaser'
        ? { url: `data:text/javascript,${encodeURIComponent(PHASER_STUB_SOURCE)}`, shortCircuit: true }
        : next(specifier, context);
    },
  });
}

export interface FakeDisplayNode extends EventEmitter {
  x: number;
  y: number;
  alpha: number;
  active: boolean;
  visible: boolean;
  depth: number;
  name: string;
  list: FakeSprite[];
  parentContainer?: FakeDisplayNode;
  setPosition(x: number, y: number): this;
  setDepth(depth: number): this;
  setName(name: string): this;
  setAlpha(alpha: number): this;
  setVisible(visible: boolean): this;
  setActive(active: boolean): this;
  setOrigin(...args: unknown[]): this;
  setRotation(...args: unknown[]): this;
  setFillStyle(...args: unknown[]): this;
  setStrokeStyle(...args: unknown[]): this;
  setScale(x: number, y?: number): this;
  setSize(w: number, h: number): this;
  setScrollFactor(...args: unknown[]): this;
  setBlendMode(...args: unknown[]): this;
  setTint(...args: unknown[]): this;
  setTintMode(...args: unknown[]): this;
  setInteractive(...args: unknown[]): this;
  disableInteractive(): this;
  setData(...args: unknown[]): this;
  add(child: unknown): this;
  addAt(child: unknown, index: number): this;
  getIndex(child: unknown): number;
  moveTo(child: unknown, index: number): this;
  remove(child: unknown): this;
  removeAll(): this;
  bringToTop(child: unknown): this;
  destroy(): void;
}

export function createFakeContainer(x = 0, y = 0): FakeDisplayNode {
  const node = new EventEmitter() as FakeDisplayNode;
  node.x = x;
  node.y = y;
  node.alpha = 1;
  node.active = true;
  node.visible = true;
  node.depth = 0;
  node.name = '';
  node.list = [];
  node.setPosition = (nx, ny) => { node.x = nx; node.y = ny; return node; };
  node.setDepth = d => { node.depth = d; return node; };
  node.setName = n => { node.name = n; return node; };
  node.setAlpha = a => { node.alpha = a; return node; };
  node.setVisible = v => { node.visible = v; return node; };
  node.setActive = a => { node.active = a; return node; };
  node.setOrigin = () => node;
  node.setRotation = () => node;
  node.setFillStyle = () => node;
  node.setStrokeStyle = () => node;
  node.setScale = () => node;
  node.setSize = () => node;
  node.setScrollFactor = () => node;
  node.setBlendMode = () => node;
  node.setTint = () => node;
  node.setTintMode = () => node;
  node.setInteractive = () => node;
  node.disableInteractive = () => node;
  node.setData = () => node;
  node.add = child => {
    node.list.push(child as FakeSprite);
    return node;
  };
  node.addAt = (child, index) => {
    node.list.splice(index, 0, child as FakeSprite);
    return node;
  };
  node.getIndex = child => node.list.indexOf(child as FakeSprite);
  node.moveTo = (child, index) => {
    const current = node.list.indexOf(child as FakeSprite);
    if (current >= 0) {
      node.list.splice(current, 1);
      node.list.splice(index, 0, child as FakeSprite);
    }
    return node;
  };
  node.remove = child => {
    const idx = node.list.indexOf(child as FakeSprite);
    if (idx >= 0) node.list.splice(idx, 1);
    return node;
  };
  node.removeAll = () => {
    node.list = [];
    return node;
  };
  node.bringToTop = child => {
    const idx = node.list.indexOf(child as FakeSprite);
    if (idx >= 0) {
      node.list.splice(idx, 1);
      node.list.push(child as FakeSprite);
    }
    return node;
  };
  node.destroy = () => {
    if (!node.active) return;
    node.active = false;
    node.emit('destroy');
    node.removeAllListeners();
  };
  return node;
}

export function createFakePhaserScene(overrides: Record<string, unknown> = {}): Phaser.Scene {
  const events = new EventEmitter();
  const gameEvents = new EventEmitter();
  const scene = {
    events,
    game: { events: gameEvents, loop: { frame: 0 } },
    cameras: {
      main: {
        width: 640,
        height: 360,
        zoomX: 1,
        zoomY: 1,
        scrollX: 0,
        scrollY: 0,
        visible: true,
        followOffset: { x: 0, y: 0 },
        setFollowOffset(x: number, y: number) { this.followOffset.x = x; this.followOffset.y = y; return this; },
        setBackgroundColor() { return this; },
        setVisible(value: boolean) { this.visible = value; return this; },
        setZoom() { return this; },
        setRoundPixels() { return this; },
        setBounds() { return this; },
        startFollow() { return this; },
        preRender() {},
        worldView: undefined,
      },
    },
    time: { now: 0, delayedCall: (_delay: number, _cb: () => void) => ({ remove() {} }) },
    tweens: { add: () => ({ stop() {}, pause() {}, resume() {} }) },
    textures: {
      exists: () => true,
      get: () => ({ has: () => true }),
      remove: () => {},
    },
    anims: {
      exists: () => false,
      create: () => {},
      generateFrameNumbers: () => [],
      remove: () => {},
    },
    load: {
      start: () => {},
      once: () => {},
      image: () => {},
      spritesheet: () => {},
    },
    add: {
      container: (x = 0, y = 0, children?: unknown[]) => {
        const c = createFakeContainer(x, y);
        for (const child of children ?? []) c.add(child);
        return c;
      },
      layer: () => createFakeContainer(0, 0),
      sprite: () => {
        const sprite = Object.assign(new FakeSprite(), {
          scene: {} as unknown,
          active: true,
          visible: true,
          blendMode: 0,
          isTinted: false,
          tintMode: 0,
          tintTopLeft: 0xffffff,
          anims: {
            accumulator: 0,
            timeScale: 1,
            currentFrame: { index: 1 },
            currentAnim: { frames: [{ index: 1 }] },
            paused: false,
            pause() { this.paused = true; },
            resume() { this.paused = false; },
            stop() {},
            setCurrentFrame(frame: { index: number }) { this.currentFrame = frame; },
          },
          setPosition() { return sprite; },
          setDepth() { return sprite; },
          setAlpha() { return sprite; },
          setFlipX() { return sprite; },
          setTint() { return sprite; },
          setTintMode() { return sprite; },
          clearTint() { return sprite; },
          enableFilters() { return sprite; },
        });
        return sprite;
      },
      image: () => createFakeContainer(0, 0),
      rectangle: () => createFakeContainer(0, 0),
    },
    ...overrides,
  };
  return scene as unknown as Phaser.Scene;
}

export function createFakeMovementWorld(navigation: NavigationWorld): MovementWorld & {
  positions: Map<CharacterVisual, Point>;
  moved: Point[];
} {
  const positions = new Map<CharacterVisual, Point>();
  const actors = new Map<CharacterVisual, NavigationActor>();
  const unregisters = new Map<CharacterVisual, () => void>();
  const bodies = new Map<CharacterVisual, { x: number; y: number; velocity: { x: number; y: number }; enable: boolean }>();
  const moved: Point[] = [];
  const register = (visual: CharacterVisual, _canMove = true, _selfHeal = true, faction: NavigationFaction = 'party') => {
    const pos = { x: visual.container.x ?? 0, y: visual.container.y ?? 0 };
    positions.set(visual, pos);
    const body = { x: pos.x, y: pos.y, velocity: { x: 0, y: 0 }, enable: true };
    bodies.set(visual, body);
    const navActor: NavigationActor = {
      shape: () => visual.actor,
      position: () => positions.get(visual)!,
      enabled: () => visual.container.visible && body.enable,
      faction: () => faction,
    };
    actors.set(visual, navActor);
    unregisters.set(visual, navigation.register(navActor));
    return body as unknown as Phaser.Physics.Arcade.Body;
  };
  const ensure = (visual: CharacterVisual) => {
    if (!actors.has(visual)) register(visual);
    return actors.get(visual)!;
  };
  const visualSetEnabled = (visual: CharacterVisual, enabled: boolean) => {
    visual.container.visible = enabled;
    const body = bodies.get(visual);
    if (body) body.enable = enabled;
  };
  const movement = {
    navigation,
    terrainCorrections: [],
    setNoclip() {},
    register,
    remove(visual: CharacterVisual) {
      unregisters.get(visual)?.();
      unregisters.delete(visual);
      actors.delete(visual);
      positions.delete(visual);
      bodies.delete(visual);
    },
    position(visual: CharacterVisual) {
      ensure(visual);
      return { ...positions.get(visual)! };
    },
    displayPosition(visual: CharacterVisual) {
      ensure(visual);
      return { ...positions.get(visual)! };
    },
    actor: ensure,
    body(visual: CharacterVisual) {
      ensure(visual);
      return bodies.get(visual) as unknown as Phaser.Physics.Arcade.Body;
    },
    state: () => undefined,
    canStand(visual: CharacterVisual, point: Point) {
      return navigation.canStand(ensure(visual), point);
    },
    place(visual: CharacterVisual, point: Point) {
      ensure(visual);
      positions.set(visual, { ...point });
      visual.container.x = point.x;
      visual.container.y = point.y;
      const body = bodies.get(visual)!;
      body.x = point.x;
      body.y = point.y;
      moved.push({ ...point });
    },
    placeAll(values: readonly { visual: CharacterVisual; position: Point; enabled: boolean }[]) {
      for (const value of values) {
        movement.place(value.visual, value.position);
        visualSetEnabled(value.visual, value.enabled);
      }
    },
    toward() {},
    followPath: () => false,
    stop(visual: CharacterVisual) {
      const body = bodies.get(visual);
      if (body) body.velocity = { x: 0, y: 0 };
    },
    setEnabled(visual: CharacterVisual, enabled: boolean) {
      ensure(visual);
      bodies.get(visual)!.enable = enabled;
    },
    setPaused() {},
    refreshShape() {},
  } as unknown as MovementWorld;
  return Object.assign(movement, { positions, moved });
}

export interface TestWorldCombatOptions {
  phaserScene?: Phaser.Scene;
  sceneOverrides?: Partial<CombatWorldHost>;
  appOverrides?: Partial<StoryContext>;
  map?: WorldMap;
  hero?: BattleCharacter;
  session?: Session;
  battleCatalog?: BattleCatalog;
  items?: ItemCatalog;
  wardrobe?: WardrobeCatalog;
  characterStats?: CharacterStatsCatalog;
  drops?: DropCatalog;
  roster?: WorldEnemyRoster;
  movement?: MovementWorld;
  playerVisual?: CharacterVisual;
}

/**
 * 通过正式构造函数创建一个可执行场景行为的 `WorldCombat` 实例（零原型篡改）。
 */
export async function createTestWorldCombat(options: TestWorldCombatOptions = {}) {
  const WorldCombatCtor = await loadWorldCombatClass();
  const battleCatalog = options.battleCatalog ?? loadBattleCatalog();
  const items = options.items ?? loadItemCatalog();
  const wardrobe = options.wardrobe ?? loadWardrobeCatalog();
  const characterStats = options.characterStats ?? loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const drops = options.drops ?? loadDropCatalog();
  const hero = options.hero ?? new BattleCharacter('dark-knight', characterStats, items);
  const session = options.session ?? new Session(campaign, undefined, undefined, items, hero, battleCatalog, characterStats, companions);
  const map: WorldMap = options.map ?? {
    id: 'test-map',
    name: 'test-map',
    width: 320,
    height: 320,
    tileSize: 16,
    columns: 20,
    rows: 20,
    blocked: Array<boolean>(400).fill(false),
    ground: '',
    canopy: '',
    features: [],
    entities: [],
    exits: [],
    enemySpawns: [],
  };
  const movement = options.movement ?? createFakeMovementWorld(new NavigationWorld(map));
  const roster = options.roster ?? new WorldEnemyRoster(session, map, [], hero.level);
  const phaserScene = options.phaserScene ?? createFakePhaserScene();

  const defaultActor = battleCatalog.classes.find(c => c.id === hero.classId)?.actor;
  const playerVisual =
    options.playerVisual ??
    ({
      entity: { id: 'player', actor: defaultActor?.id ?? 'hero', x: 64, y: 64, flip: false },
      actor: defaultActor ?? { id: 'hero', name: 'hero', clips: {}, collision: { x: -8, y: -8, width: 16, height: 16 } },
      layers: [],
      container: createFakeContainer(64, 64),
    } as unknown as CharacterVisual);

  const sceneHost: CombatWorldHost = {
    phaserScene,
    cameras: phaserScene.cameras,
    events: phaserScene.events,
    time: phaserScene.time,
    tweens: phaserScene.tweens,
    game: phaserScene.game,
    canCombatControl: true,
    map,
    entities: [],
    player: playerVisual,
    movement,
    facing: 'south',
    combatEnemyIds: () => [],
    equipmentAppearance: () => undefined,
    handleCombatDefeat: () => {},
    offensiveSkillCompleted: () => {},
    preparePartyMember: async () => {},
    preparePlayerAppearance: async () => {},
    refreshCombatHud: () => {},
    refreshCombatTarget: () => {},
    reviveMember: () => ({ ok: true }),
    lootLanding: (_map, x, y) => ({ x, y }),
    refreshGroundLoot: () => {},
    syncControlledCharacter: () => {},
    ...options.sceneOverrides,
  };

  const app = {
    session,
    director: undefined,
    audio: undefined,
    battleCatalog,
    characterStats,
    items,
    wardrobe,
    world: { actors: {} },
    statusHud: loadContentCatalog<StoryContext['statusHud']>('status-hud'),
    ui: { showInstant() {} },
    locked: false,
    suspended: false,
    pressureMode: false,
    pressureSettings: undefined,
    gmSpeedMultiplier: 1,
    ...options.appOverrides,
  } as unknown as ConstructorParameters<typeof WorldCombat>[1];

  const combat = new WorldCombatCtor(sceneHost, app, roster, hero, drops);
  return {
    combat,
    scene: sceneHost,
    phaserScene,
    app,
    roster,
    hero,
    session,
    drops,
    battleCatalog,
    items,
    wardrobe,
    characterStats,
    map,
    playerVisual,
  };
}
