import Phaser from 'phaser';
import type { BattleCatalog } from '../../src/domain/battle.ts';
import type { Facing } from '../../src/domain/content.ts';
import type { ItemCatalog } from '../../src/domain/items.ts';
import { statusColorMatrix } from '../../src/domain/status-color.ts';
import type { CostumePose, WardrobeCatalog } from '../../src/domain/wardrobe.ts';
import { EFFECT_ATLAS_BY_FILE, EFFECT_ATLAS_PAGES } from '../../src/generated/effect-atlas.ts';
import { UI_ICON_ATLAS_DATA, UI_ICON_ATLAS_FILE, UI_ICON_FRAMES } from '../../src/generated/icon-atlas.ts';
import { UI_ATLAS_FRAMES, UI_ATLAS_PAGES } from '../../src/generated/ui-atlas.ts';
import { blendModeOf } from '../../src/rendering/blend-modes.ts';
import { backdropApproximation, layerDraw } from '../../src/rendering/effect-colors.ts';
import {
  PART_NAMES, Playback, PoseRepository, WARRIOR_CORE_PARTS, actionChoices, actionNotices,
  actionTimeline, activeEffectsAtFrame, armorChoices, compatibleOffhands, effectOverlayBounds,
  facingVector, formatInventoryMarkdown, framePieces, mergePrototypeWeapon, poseBounds,
  variantChoices, viewerRecipe, warriorAssetInventory, warriorPoseIds, warriorPresets, weaponChoices,
} from './model.ts';
import type {
  ActionChoice, ActionTimeline, ActiveEffectLayer, AudioCatalogLite, CompanionCatalogLite,
  CompanionPreset, EquipmentSelection, FramePiece, MenuPanelsLite, PoseBounds,
  PrototypeWeaponBundle, StatusHudLite, StoryClassesLite, VariantOverrides, WarriorAssetInventory,
} from './model.ts';

interface AtlasJsonFrame {
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
}
interface AtlasJson { frames: Record<string, AtlasJsonFrame> }
interface LoadedAtlas { key: string; image: HTMLImageElement; data: AtlasJson }

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`页面控件缺失：${id}`);
  return found as T;
}

function option(value: string, label: string): HTMLOptionElement {
  return new Option(label, value);
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`读取失败 ${response.status}：${url}`);
  return response.json() as Promise<T>;
}

async function readImage(file: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = `/${file}`;
  try { await image.decode(); }
  catch { throw new Error(`图片加载失败：${file}`); }
  return image;
}

const playback = new Playback();
const workspace = element<HTMLElement>('inspector-view');
const inventoryView = element<HTMLElement>('inventory-view');
const tabInspector = element<HTMLButtonElement>('tab-inspector');
const tabInventory = element<HTMLButtonElement>('tab-inventory');
const status = element('status');
const actionsElement = element('actions');
const variantsElement = element('variants');
const piecesElement = element('pieces');
const effectSummaryElement = element('effect-summary');
const noticesElement = element('action-notices');
const keyframeBar = element('keyframe-bar');
const soundBar = element('sound-bar');
const presetSelect = element<HTMLSelectElement>('preset');
const mainSelect = element<HTMLSelectElement>('main-hand');
const offSelect = element<HTMLSelectElement>('off-hand');
const bodyArmorSelect = element<HTMLSelectElement>('armor-body');
const headArmorSelect = element<HTMLSelectElement>('armor-head');
const backArmorSelect = element<HTMLSelectElement>('armor-back');
const showEffectsInput = element<HTMLInputElement>('show-effects');
const showTintInput = element<HTMLInputElement>('show-tint');
const timeline = element<HTMLInputElement>('timeline');
const playButton = element<HTMLButtonElement>('play');
const zoomSelect = element<HTMLSelectElement>('zoom');
const stage = element('stage');
const showAll = element<HTMLButtonElement>('show-all');

let catalog: WardrobeCatalog;
let items: ItemCatalog;
let battle: BattleCatalog;
let storyClasses: StoryClassesLite;
let menuPanels: MenuPanelsLite;
let statusHud: StatusHudLite;
let companions: CompanionCatalogLite;
let audioCatalog: AudioCatalogLite;
let repository: PoseRepository;
let skillNames: Record<string, string> = {};
let prototypeLabels: Record<string, string> = {};
let defaultWeaponId = '';
let presets: CompanionPreset[] = [];
let appearanceId: string | undefined;
let equipment: EquipmentSelection = {};
let overrides: VariantOverrides = {};
let hiddenParts = new Set<string>();
let facing: Facing = 'south';
let selectedAction = 'idle';
let choices: ActionChoice[] = [];
let pose: CostumePose | undefined;
let currentTimeline: ActionTimeline = { effects: [], markers: [], sounds: [], shakeFrames: [] };
let activeEffects: ActiveEffectLayer[] = [];
let bounds: PoseBounds = { left: 0, top: -40, right: 0, bottom: 0 };
let effectAnchor: { x: number; y: number } = { x: 0, y: -4 };
let variants: Record<string, string> = {};
let currentPieces: FramePiece[] = [];
let soloOrder: number | undefined;
let revision = 0;
let ready = false;
let currentView: 'inspector' | 'inventory' = 'inspector';
let inventoryBuilt = false;
let inventoryData: WarriorAssetInventory | undefined;
let inventoryCategoryFilter = '全部';
let scene: CharacterScene | undefined;
let game: Phaser.Game | undefined;
let observer: ResizeObserver | undefined;
let previewAudio: HTMLAudioElement | undefined;

const images = new Map<string, HTMLImageElement>();
const thumbnailCache = new Map<string, string>();
const atlasStore = new Map<string, LoadedAtlas>();
const atlasPending = new Map<string, Promise<LoadedAtlas>>();
const atlasThumbCache = new Map<string, string>();
const variantUseLabels = new Map<string, HTMLElement>();
const pieceCards = new Map<number, {
  card: HTMLElement; name: HTMLElement; order: HTMLElement; image: HTMLImageElement;
  details: HTMLElement; solo: HTMLButtonElement;
}>();

function report(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle('error', error);
}

async function loadAtlas(key: string, file: string, dataFile: string): Promise<LoadedAtlas> {
  const existing = atlasStore.get(key);
  if (existing) return existing;
  let pending = atlasPending.get(key);
  if (!pending) {
    pending = Promise.all([readImage(file), readJson<AtlasJson>(`/${dataFile}`)]).then(([image, data]) => {
      const loaded: LoadedAtlas = { key, image, data };
      atlasStore.set(key, loaded);
      if (scene && !scene.textures.exists(key)) scene.textures.addAtlas(key, image, data);
      return loaded;
    }).catch(error => {
      atlasPending.delete(key);
      throw error;
    });
    atlasPending.set(key, pending);
  }
  return pending;
}

function cropAtlasFrame(atlas: LoadedAtlas, frameName: string): string {
  const cacheKey = `${atlas.key}|${frameName}`;
  const cached = atlasThumbCache.get(cacheKey);
  if (cached) return cached;
  const entry = atlas.data.frames[frameName];
  if (!entry) return '';
  const { x, y, w, h } = entry.frame;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  canvas.getContext('2d')!.drawImage(atlas.image, x, y, w, h, 0, 0, w, h);
  const url = canvas.toDataURL();
  atlasThumbCache.set(cacheKey, url);
  return url;
}

async function resolveUiThumb(file: string): Promise<string> {
  const iconFrame = UI_ICON_FRAMES[file];
  if (iconFrame) {
    const atlas = await loadAtlas('viewer-icon-atlas', UI_ICON_ATLAS_FILE, UI_ICON_ATLAS_DATA);
    return cropAtlasFrame(atlas, iconFrame);
  }
  const uiFrame = UI_ATLAS_FRAMES[file];
  if (uiFrame) {
    const page = UI_ATLAS_PAGES[uiFrame.page];
    if (page) {
      const atlas = await loadAtlas(page.key, page.file, page.data);
      return cropAtlasFrame(atlas, uiFrame.frame);
    }
  }
  return `/${file}`;
}

async function ensureEffectPages(effectFiles: Iterable<string>): Promise<void> {
  const pageIndices = new Set<number>();
  for (const file of effectFiles) {
    const frames = EFFECT_ATLAS_BY_FILE[file];
    if (!frames) continue;
    for (const ref of frames) pageIndices.add(ref.page);
  }
  await Promise.all([...pageIndices].map(index => {
    const page = EFFECT_ATLAS_PAGES[index];
    return page ? loadAtlas(page.key, page.file, page.data) : Promise.resolve();
  }));
}

async function ensureTimelineEffectsLoaded(tl: ActionTimeline): Promise<void> {
  const files = new Set<string>();
  for (const cue of tl.effects) {
    const clip = battle.attackEffects[cue.effect]?.clips[cue.variant];
    if (!clip) continue;
    for (const layer of clip.layers) files.add(layer.file);
  }
  if (files.size) await ensureEffectPages(files);
}

/** 原图集里的切片按像素原样裁出；缩放只交给 CSS 的整数倍显示。 */
function thumbnail(key: string): string {
  const existing = thumbnailCache.get(key);
  if (existing) return existing;
  const sprite = catalog.sprites[key];
  const image = images.get(sprite.texture);
  if (!image) throw new Error(`切片图集未加载：${sprite.texture}`);
  const canvas = document.createElement('canvas');
  canvas.width = sprite.width;
  canvas.height = sprite.height;
  canvas.getContext('2d')!.drawImage(image, sprite.x, sprite.y, sprite.width, sprite.height,
    0, 0, sprite.width, sprite.height);
  const result = canvas.toDataURL();
  thumbnailCache.set(key, result);
  return result;
}

function playSound(soundId: string): void {
  const file = audioCatalog.effects[soundId];
  if (!file) { report(`音效文件缺失：${soundId}`, true); return; }
  if (!previewAudio) previewAudio = new Audio();
  previewAudio.pause();
  previewAudio.src = `/${file}`;
  previewAudio.currentTime = 0;
  void previewAudio.play().catch(error => {
    report(`音效播放失败（${soundId}）：${error instanceof Error ? error.message : String(error)}`, true);
  });
}

class CharacterScene extends Phaser.Scene {
  private groundEffects!: Phaser.GameObjects.Container;
  private root!: Phaser.GameObjects.Container;
  private topEffects!: Phaser.GameObjects.Container;
  private readonly sprites: Phaser.GameObjects.Image[] = [];
  private readonly colorFilters = new WeakMap<Phaser.GameObjects.Image, Phaser.Filters.ColorMatrix>();
  private readonly groundPool: Phaser.GameObjects.Image[] = [];
  private readonly topPool: Phaser.GameObjects.Image[] = [];

  constructor() { super('warrior-viewer'); }

  create(): void {
    for (const [key, image] of images) this.textures.addImage(key, image);
    for (const [key, piece] of Object.entries(catalog.sprites)) {
      this.textures.get(piece.texture).add(key, 0, piece.x, piece.y, piece.width, piece.height);
    }
    for (const atlas of atlasStore.values()) {
      if (!this.textures.exists(atlas.key)) this.textures.addAtlas(atlas.key, atlas.image, atlas.data);
    }
    this.groundEffects = this.add.container(0, 0);
    this.root = this.add.container(0, 0);
    this.topEffects = this.add.container(0, 0);
    scene = this;
    this.scale.on('resize', () => this.draw());
    void refresh();
  }

  override update(_time: number, delta: number): void {
    if (ready && currentView === 'inspector' && playback.advance(delta)) renderFrame();
  }

  setLoading(): void {
    this.groundEffects.setVisible(false);
    this.root.setVisible(false);
    this.topEffects.setVisible(false);
  }

  private drawEffectList(container: Phaser.GameObjects.Container, pool: Phaser.GameObjects.Image[],
    itemsToDraw: ActiveEffectLayer[]): void {
    const dir = facingVector(facing);
    let used = 0;
    for (const active of itemsToDraw) {
      const { cue, clip, effectFrame } = active;
      const baseX = cue.onTarget ? dir.x * 28 : 0;
      const baseY = cue.onTarget
        ? dir.y * 28
        : (cue.placement === 'attached' && cue.attachmentPoint !== 'feet' ? effectAnchor.y : 0);
      for (const layer of clip.layers) {
        const ref = EFFECT_ATLAS_BY_FILE[layer.file]?.[effectFrame];
        if (!ref) continue;
        const page = EFFECT_ATLAS_PAGES[ref.page];
        if (!page || !this.textures.exists(page.key)) continue;
        let sprite = pool[used];
        if (!sprite) {
          sprite = this.add.image(0, 0, page.key, ref.frame);
          container.add(sprite);
          pool.push(sprite);
        }
        const draw = layerDraw(layer);
        const mode = blendModeOf(draw.kind === 'backdrop' ? backdropApproximation(layer.operations) : draw.blend);
        sprite.setTexture(page.key, ref.frame)
          .setOrigin(clip.originX, clip.originY)
          .setPosition(baseX, baseY)
          .setScale(clip.mirrorX ? -1 : 1, 1)
          .setBlendMode(mode)
          .setVisible(true);
        used++;
      }
    }
    for (let index = used; index < pool.length; index++) pool[index].setVisible(false);
    container.setVisible(used > 0);
  }

  draw(): void {
    if (!pose || !ready) return;
    const margin = 40;
    const charWidth = Math.max(1, bounds.right - bounds.left + 1);
    const charHeight = Math.max(1, bounds.bottom - bounds.top + 1);
    const charFit = Math.max(1, Math.floor(Math.min((this.scale.width - margin) / charWidth,
      (this.scale.height - margin) / charHeight)));
    const showEffects = showEffectsInput.checked && soloOrder === undefined;
    const effBounds = showEffects ? effectOverlayBounds(battle, currentTimeline, facing, effectAnchor) : null;
    let fit = charFit;
    if (effBounds) {
      const combinedW = Math.max(charWidth, Math.max(bounds.right, effBounds.right) - Math.min(bounds.left, effBounds.left) + 1);
      const combinedH = Math.max(charHeight, Math.max(bounds.bottom, effBounds.bottom) - Math.min(bounds.top, effBounds.top) + 1);
      const combinedFit = Math.max(1, Math.floor(Math.min((this.scale.width - margin) / combinedW,
        (this.scale.height - margin) / combinedH)));
      fit = Math.min(charFit, Math.max(2, combinedFit));
    }
    const requested = Number(zoomSelect.value);
    const zoom = Math.min(fit, requested);
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;
    const originX = Math.round(this.scale.width / 2 - centerX * zoom);
    const originY = Math.round(this.scale.height / 2 - centerY * zoom);

    this.root.setPosition(originX, originY).setScale(pose.mirrorX ? -zoom : zoom, zoom).setVisible(true);
    this.groundEffects.setPosition(originX, originY).setScale(zoom, zoom);
    this.topEffects.setPosition(originX, originY).setScale(zoom, zoom);

    const tintColors = showTintInput.checked && soloOrder === undefined ? currentTimeline.appearanceColors : undefined;
    const tintMatrix = tintColors?.length ? statusColorMatrix(tintColors, playback.frame, false, false) : undefined;

    for (const [index, entry] of currentPieces.entries()) {
      let sprite = this.sprites[index];
      if (!sprite) {
        sprite = this.add.image(0, 0, entry.sprite.texture, entry.key);
        this.root.add(sprite);
        this.sprites.push(sprite);
      }
      const { part, sprite: piece } = entry;
      const visible = soloOrder === undefined ? !hiddenParts.has(part.part) : soloOrder === entry.order;
      sprite.setTexture(piece.texture, entry.key)
        .setOrigin(piece.anchorX / piece.width, piece.anchorY / piece.height)
        .setPosition(part.x, part.y).setScale(part.scaleX, part.scaleY)
        .setAngle(part.angle).setAlpha(part.alpha)
        .setVisible(visible);
      let filter = this.colorFilters.get(sprite);
      if (tintMatrix && visible) {
        if (!filter) {
          sprite.enableFilters();
          filter = sprite.filters?.internal.addColorMatrix();
          if (filter) this.colorFilters.set(sprite, filter);
        }
        if (filter) {
          filter.colorMatrix.set(tintMatrix);
          filter.setActive(true);
        }
      } else if (filter) {
        filter.setActive(false);
      }
    }
    for (let index = currentPieces.length; index < this.sprites.length; index++) {
      this.sprites[index].setVisible(false);
    }

    if (showEffects && activeEffects.length) {
      const ground = activeEffects.filter(item => item.cue.placement === 'ground');
      const top = activeEffects.filter(item => item.cue.placement !== 'ground');
      this.drawEffectList(this.groundEffects, this.groundPool, ground);
      this.drawEffectList(this.topEffects, this.topPool, top);
    } else {
      this.drawEffectList(this.groundEffects, this.groundPool, []);
      this.drawEffectList(this.topEffects, this.topPool, []);
    }

    const modeTag = showEffects && currentTimeline.effects.length ? ' · 含特效' : '';
    const tintTag = tintMatrix ? ' · 含染色' : '';
    element('scale-info').textContent = zoom === requested
      ? `${zoom}× · 原始像素${modeTag}${tintTag}`
      : `${zoom}× · 适应画布（选择 ${requested}×）${modeTag}${tintTag}`;
  }
}

function syncPlayback(): void {
  playButton.textContent = playback.playing ? '暂停' : '继续播放';
  playButton.setAttribute('aria-label', playback.playing ? '暂停播放' : '继续播放');
  element('frame-label').textContent = pose ? `${playback.frame + 1} / ${pose.frames.length}` : '— / —';
  timeline.value = String(playback.frame);
  keyframeBar.querySelectorAll<HTMLButtonElement>('.kf-pill').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.frame) === playback.frame);
  });
}

function resetSolo(): void {
  soloOrder = undefined;
  showAll.hidden = true;
}

function toggleSolo(order: number): void {
  if (soloOrder === order) resetSolo();
  else {
    playback.seek(playback.frame);
    soloOrder = order;
    showAll.hidden = false;
  }
  renderFrame();
}

function renderKeyframesAndSounds(): void {
  const pills: HTMLElement[] = [];
  if (currentTimeline.cycleFrames !== undefined) {
    const cycle = document.createElement('span');
    cycle.className = 'kf-pill';
    cycle.textContent = `攻速周期 ${currentTimeline.cycleFrames} 帧`;
    pills.push(cycle);
  }
  for (const marker of currentTimeline.markers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `kf-pill kind-${marker.kind}`;
    button.dataset.frame = String(marker.frame);
    button.textContent = `F${marker.frame + 1} ${marker.label}`;
    button.title = `跳至第 ${marker.frame + 1} 帧（索引 ${marker.frame}）`;
    button.onclick = () => selectFrame(marker.frame);
    pills.push(button);
  }
  if (currentTimeline.shakeFrames.length) {
    const shake = document.createElement('span');
    shake.className = 'kf-pill';
    shake.textContent = `震屏帧：${currentTimeline.shakeFrames.map(f => `F${f + 1}`).join(' / ')}`;
    pills.push(shake);
  }
  if (currentTimeline.appearanceColors?.length) {
    const tint = document.createElement('span');
    tint.className = 'kf-pill kind-buff';
    tint.textContent = `外观染色：${currentTimeline.appearanceColors.length} 帧循环`;
    pills.push(tint);
  }
  keyframeBar.hidden = !pills.length;
  keyframeBar.replaceChildren(...pills);

  if (!currentTimeline.sounds.length) {
    soundBar.hidden = true;
    soundBar.replaceChildren();
  } else {
    soundBar.hidden = false;
    const label = document.createElement('span');
    label.textContent = '绑定音效：';
    const buttons = currentTimeline.sounds.map(id => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sound-btn';
      btn.textContent = `▶ ${id}`;
      btn.onclick = () => playSound(id);
      return btn;
    });
    soundBar.replaceChildren(label, ...buttons);
  }
}

function renderEffectSummary(): void {
  if (!currentTimeline.effects.length) {
    effectSummaryElement.hidden = true;
    effectSummaryElement.textContent = '';
    return;
  }
  effectSummaryElement.hidden = false;
  if (!activeEffects.length) {
    const list = currentTimeline.effects
      .map(cue => `${cue.effect}（F${cue.startFrame + 1}~F${cue.startFrame + cue.frames}，${cue.source}）`)
      .join('；');
    effectSummaryElement.textContent = `当前帧无生效特效。本动作挂接特效：${list}`;
    return;
  }
  const parts = activeEffects.map(({ cue, clip, effectFrame }) =>
    `${cue.source} ${cue.effect}[${cue.variant}] · 第 ${effectFrame + 1}/${cue.frames} 帧 · ${clip.frameWidth}×${clip.frameHeight} · ${clip.layers.length} 层（${cue.onTarget ? '目标身位' : cue.placement}）`,
  );
  effectSummaryElement.textContent = `当前帧叠加特效：${parts.join(' ｜ ')}`;
}

function renderPieces(): void {
  const cards = currentPieces.map(entry => {
    const { part, sprite } = entry;
    let view = pieceCards.get(entry.order);
    if (!view) {
      const card = document.createElement('article');
      card.className = 'piece-card';
      const header = document.createElement('header');
      const name = document.createElement('strong');
      const order = document.createElement('span');
      header.append(name, order);
      const imageBox = document.createElement('div');
      imageBox.className = 'piece-image';
      const image = document.createElement('img');
      imageBox.append(image);
      const details = document.createElement('pre');
      const solo = document.createElement('button');
      solo.onclick = () => toggleSolo(entry.order);
      card.append(header, imageBox, details, solo);
      view = { card, name, order, image, details, solo };
      pieceCards.set(entry.order, view);
    }
    view.card.classList.toggle('selected', soloOrder === entry.order);
    view.name.textContent = PART_NAMES[part.part] ?? part.part;
    view.order.textContent = `#${entry.order + 1}`;
    const source = thumbnail(entry.key);
    if (view.image.getAttribute('src') !== source) view.image.src = source;
    view.image.alt = `${view.name.textContent} 原始切片 ${entry.key}`;
    const zoom = Math.max(1, Math.min(4, Math.floor(120 / sprite.width), Math.floor(94 / sprite.height)));
    view.image.width = sprite.width * zoom;
    view.image.height = sprite.height * zoom;
    view.details.textContent = `${entry.key} · 索引 ${part.piece}\n${sprite.width}×${sprite.height} · 基准 (${sprite.anchorX}, ${sprite.anchorY})\n位置 (${part.x}, ${part.y}) · 角度 ${part.angle}°\n缩放 ${part.scaleX}, ${part.scaleY} · 透明度 ${part.alpha}`;
    view.solo.textContent = soloOrder === entry.order ? '恢复完整角色' : '仅看此片';
    return view.card;
  });
  if (cards.length !== piecesElement.children.length || cards.some((card, index) => piecesElement.children[index] !== card)) {
    piecesElement.replaceChildren(...cards);
  }
  if (!cards.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-pieces';
    empty.textContent = '这一帧没有可见部件。可在右侧恢复外观。';
    piecesElement.append(empty);
  }
  element('piece-count').textContent = `${cards.length} 片 · 从后到前${activeEffects.length ? ` · +${activeEffects.length} 组特效` : ''}`;
}

function renderFrame(): void {
  if (!pose || !ready) return;
  currentPieces = framePieces(catalog, variants, pose.frames[playback.frame]);
  activeEffects = activeEffectsAtFrame(currentTimeline, battle, playback.frame);
  if (soloOrder !== undefined && !currentPieces.some(entry => entry.order === soloOrder)) resetSolo();
  scene?.draw();
  syncPlayback();
  renderEffectSummary();
  renderPieces();
  const used = new Set(currentPieces.map(entry => entry.part.part));
  for (const [part, label] of variantUseLabels) {
    label.textContent = hiddenParts.has(part) ? '已隐藏' : used.has(part) ? '使用中' : '未使用';
  }
}

function renderActions(): void {
  const groups = new Map<string, HTMLElement>();
  for (const choice of choices) {
    let group = groups.get(choice.group);
    if (!group) {
      group = document.createElement('section');
      group.className = 'action-group';
      const title = document.createElement('h3');
      title.textContent = choice.group;
      group.append(title);
      groups.set(choice.group, group);
    }
    const button = document.createElement('button');
    button.textContent = choice.label;
    button.dataset.action = choice.key;
    button.setAttribute('aria-current', String(choice.key === selectedAction));
    button.onclick = () => {
      selectedAction = choice.key;
      playback.frame = 0;
      void refresh();
    };
    group.append(button);
  }
  actionsElement.replaceChildren(...groups.values());
  element('action-count').textContent = `${choices.length} 组`;
}

function renderVariants(): void {
  variantUseLabels.clear();
  const baseVariants = viewerRecipe(catalog, items, equipment, {}, appearanceId).variants;
  const parts = new Set<string>([...WARRIOR_CORE_PARTS]);
  for (const part of [...Object.keys(baseVariants), ...Object.keys(overrides), ...Object.keys(variants)]) {
    if (part !== 'cast-prop-1') parts.add(part);
  }
  const rows: HTMLElement[] = [];
  for (const part of parts) {
    const available = variantChoices(catalog, items, part);
    if (!available.length) continue;
    const row = document.createElement('div');
    row.className = 'variant-row';
    const title = document.createElement('div');
    title.className = 'variant-title';
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !hiddenParts.has(part);
    checkbox.onchange = () => {
      if (checkbox.checked) hiddenParts.delete(part);
      else hiddenParts.add(part);
      renderFrame();
    };
    label.append(checkbox, PART_NAMES[part] ?? part);
    const usage = document.createElement('span');
    usage.className = 'variant-use';
    variantUseLabels.set(part, usage);
    title.append(label, usage);
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${PART_NAMES[part] ?? part}外观`);
    select.append(option('', '不显示'));
    const warriorOpts = available.filter(choice => choice.warrior);
    const otherOpts = available.filter(choice => !choice.warrior);
    if (warriorOpts.length && otherOpts.length) {
      const g1 = document.createElement('optgroup');
      g1.label = `狂战士可用（${warriorOpts.length}）`;
      g1.append(...warriorOpts.map(choice => option(choice.id, choice.label)));
      const g2 = document.createElement('optgroup');
      g2.label = `其他职业 / 佣兵款式（${otherOpts.length}）`;
      g2.append(...otherOpts.map(choice => option(choice.id, choice.label)));
      select.append(g1, g2);
    } else {
      select.append(...available.map(choice => option(choice.id, choice.label)));
    }
    select.value = variants[part] ?? '';
    select.onchange = () => {
      overrides[part] = select.value || null;
      void refresh(false);
    };
    const id = document.createElement('div');
    id.className = 'variant-id';
    id.textContent = variants[part] ?? '未装备';
    row.append(title, select, id);
    rows.push(row);
  }
  variantsElement.replaceChildren(...rows);
}

async function refresh(rebuildActions = true): Promise<void> {
  const request = ++revision;
  ready = false;
  workspace.setAttribute('aria-busy', 'true');
  scene?.setLoading();
  report('正在准备动作与特效…');
  try {
    variants = viewerRecipe(catalog, items, equipment, overrides, appearanceId).variants;
    if (rebuildActions) {
      choices = actionChoices(catalog, items, equipment, facing, skillNames,
        equipment['main-hand']?.startsWith('prototype-') ? prototypeLabels : undefined);
      if (!choices.some(choice => choice.key === selectedAction)) {
        selectedAction = 'idle';
        playback.frame = 0;
      }
      renderActions();
    }
    const selected = choices.find(choice => choice.key === selectedAction)!;
    const nextTimeline = actionTimeline(catalog, items, battle, equipment, selected.key, facing, audioCatalog);
    const [nextPose] = await Promise.all([
      repository.get(selected.poseId),
      ensureTimelineEffectsLoaded(nextTimeline),
    ]);
    if (request !== revision) return;
    pose = nextPose;
    currentTimeline = nextTimeline;
    bounds = poseBounds(catalog, variants, pose);
    playback.configure(pose.frames.length, pose.frameRate);
    timeline.max = String(pose.frames.length - 1);
    resetSolo();
    renderVariants();
    renderKeyframesAndSounds();
    const notices = actionNotices(catalog, items, equipment, selected.key, pose);
    noticesElement.hidden = !notices.length;
    noticesElement.replaceChildren(...notices.map(text => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    }));
    element('action-title').textContent = selected.label;
    element('pose-info').textContent = `${selected.poseId} · ${Number(pose.frameRate.toFixed(2))} fps${pose.mirrorX ? ' · 镜像' : ''}`;
    ready = true;
    workspace.setAttribute('aria-busy', 'false');
    renderFrame();
    const fxInfo = currentTimeline.effects.length ? ` · ${currentTimeline.effects.length} 组特效` : '';
    report(`游戏原始素材 · ${pose.frames.length} 帧${fxInfo} · 可切换「职业素材总清单」查看全套新职业规格`);
  } catch (error) {
    if (request !== revision) return;
    report(error instanceof Error ? error.message : String(error), true);
    workspace.setAttribute('aria-busy', 'false');
  }
}

function refreshWeapons(): void {
  const compatible = compatibleOffhands(catalog, items, equipment['main-hand']);
  if (!compatible.some(choice => choice.id === equipment['off-hand'])) delete equipment['off-hand'];
  offSelect.replaceChildren(option('', '空手'), ...compatible.map(choice => option(choice.id, choice.label)));
  offSelect.value = equipment['off-hand'] ?? '';
  offSelect.disabled = !compatible.length;
}

function clearOverridesForParts(partList: readonly string[]): void {
  for (const part of partList) {
    delete overrides[part];
    hiddenParts.delete(part);
  }
}

function clearWeaponOverrides(): void {
  clearOverridesForParts(['two-handed', 'main-blade', 'off-blade', 'main-dagger', 'off-dagger', 'shield', 'spear']);
}

function selectFrame(frame: number): void {
  if (!ready) return;
  playback.seek(frame);
  renderFrame();
}

function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderInventoryPoses(inventory: WarriorAssetInventory): void {
  const categories = ['全部', ...new Set(inventory.templates.map(row => row.category))];
  const filterBar = element('inventory-pose-filters');
  filterBar.replaceChildren(...categories.map(category => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = category === '全部'
      ? `全部（${inventory.templates.length}）`
      : `${category}（${inventory.templates.filter(r => r.category === category).length}）`;
    btn.setAttribute('aria-pressed', String(category === inventoryCategoryFilter));
    btn.onclick = () => {
      inventoryCategoryFilter = category;
      renderInventoryPoses(inventory);
    };
    return btn;
  }));

  const rows = inventoryCategoryFilter === '全部'
    ? inventory.templates
    : inventory.templates.filter(row => row.category === inventoryCategoryFilter);
  const tbody = element('inventory-poses');
  tbody.replaceChildren(...rows.map(row => {
    const tr = document.createElement('tr');
    const td = (content: string | Node) => {
      const cell = document.createElement('td');
      if (typeof content === 'string') cell.textContent = content;
      else cell.append(content);
      return cell;
    };
    const nameWrap = document.createElement('div');
    const title = document.createElement('div');
    title.textContent = row.labels.join(' / ');
    const code = document.createElement('code');
    code.textContent = row.id;
    nameWrap.append(title, code);
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.textContent = '去预览';
    previewBtn.onclick = () => {
      if (row.sampleEquipment['main-hand']) equipment['main-hand'] = row.sampleEquipment['main-hand'];
      else delete equipment['main-hand'];
      mainSelect.value = equipment['main-hand'] ?? '';
      clearWeaponOverrides();
      refreshWeapons();
      if (row.sampleEquipment['off-hand']) equipment['off-hand'] = row.sampleEquipment['off-hand'];
      else delete equipment['off-hand'];
      offSelect.value = equipment['off-hand'] ?? '';
      selectedAction = row.sampleActionKey;
      playback.frame = 0;
      switchView('inspector');
      void refresh();
    };
    tr.append(
      td(row.category),
      td(nameWrap),
      td(row.stances.join('、')),
      td(`${row.frames.south} / ${row.frames.west} / ${row.frames.north} / ${row.frames.east}`),
      td(`${Number(row.frameRate.toFixed(1))} fps · ${row.mirrorEast ? '东向镜像' : '无镜像'}`),
      td(row.parts.map(part => PART_NAMES[part] ?? part).join('、')),
      td(previewBtn),
    );
    return tr;
  }));
  element('inventory-poses-count').textContent = `${rows.length} / ${inventory.templates.length} 组独立模板（共 ${inventory.totalPoseFiles} 个姿态文件）`;
}

function renderInventoryParts(inventory: WarriorAssetInventory): void {
  const noVisual = element('inventory-no-visual-slots');
  noVisual.textContent = `无纸娃娃切片的装备槽：${inventory.noVisualSlots.map(s => `${s.label}（${s.note}）`).join('；')}`;

  const container = element('inventory-parts');
  container.replaceChildren(...inventory.parts.map(part => {
    const card = document.createElement('article');
    card.className = 'part-spec-card';
    const header = document.createElement('div');
    header.className = 'part-spec-header';
    const title = document.createElement('strong');
    title.textContent = `${part.label}（${part.part}） · ${part.slotLabel}`;
    const meta = document.createElement('span');
    meta.className = 'part-spec-meta';
    meta.textContent = `单套 ${part.sliceCount} 张切片 · 战斗用 ${part.combatUsedCount} 张${part.dieOnlyCount ? ` · 仅阵亡用 ${part.dieOnlyCount} 张` : ''} · 狂战士可用 ${part.warriorVariantCount} 款（总 ${part.totalVariantCount} 款）`;
    header.append(title, meta);

    const strip = document.createElement('div');
    strip.className = 'slice-strip';
    strip.append(...part.slices.map(slice => {
      const mini = document.createElement('div');
      mini.className = `slice-mini${!slice.combatUsed && slice.dieUsed ? ' die-only' : !slice.combatUsed && !slice.dieUsed ? ' unused' : ''}`;
      const imgBox = document.createElement('div');
      imgBox.className = 'slice-mini-img';
      if (slice.defaultKey) {
        const img = document.createElement('img');
        img.src = thumbnail(slice.defaultKey);
        img.alt = `${part.label} #${slice.index}`;
        const scale = Math.max(1, Math.min(3, Math.floor(88 / Math.max(1, slice.width)), Math.floor(50 / Math.max(1, slice.height))));
        img.width = slice.width * scale;
        img.height = slice.height * scale;
        imgBox.append(img);
      }
      const badge = document.createElement('span');
      badge.className = slice.combatUsed ? 'badge' : slice.dieUsed ? 'badge warn' : 'badge muted';
      badge.textContent = slice.combatUsed ? '战斗动作' : slice.dieUsed ? '仅阵亡用' : '狂战士未用';
      const info = document.createElement('div');
      info.textContent = `#${slice.index} · ${slice.width}×${slice.height}`;
      const anchor = document.createElement('div');
      anchor.style.color = 'var(--muted)';
      anchor.textContent = `基准 (${slice.anchorX}, ${slice.anchorY})`;
      mini.append(imgBox, badge, info, anchor);
      return mini;
    }));
    card.append(header, strip);
    return card;
  }));
  const totalDefaultSlices = inventory.parts.reduce((sum, p) => sum + p.sliceCount, 0);
  element('inventory-parts-count').textContent = `${inventory.parts.length} 个部位 · 单套合计 ${totalDefaultSlices} 张切片`;
}

async function renderInventorySupplemental(inventory: WarriorAssetInventory): Promise<void> {
  const { identity, skills, buffIcons, effects, sounds } = inventory.supplemental;

  const identityCards = await Promise.all(identity.map(async item => {
    const card = document.createElement('article');
    card.className = 'asset-card';
    const thumb = document.createElement('div');
    thumb.className = 'asset-thumb light-bg';
    const img = document.createElement('img');
    img.src = await resolveUiThumb(item.file);
    img.alt = item.label;
    thumb.append(img);
    const meta = document.createElement('div');
    meta.className = 'asset-meta';
    const strong = document.createElement('strong');
    strong.textContent = item.label;
    const usage = document.createElement('span');
    usage.textContent = item.usage;
    const code = document.createElement('code');
    code.textContent = item.file;
    meta.append(strong, usage, code);
    card.append(thumb, meta);
    return card;
  }));
  element('inventory-identity').replaceChildren(...identityCards);

  const skillCards = await Promise.all(skills.map(async s => {
    const card = document.createElement('article');
    card.className = 'skill-card';
    const thumb = document.createElement('div');
    thumb.className = 'asset-thumb';
    const img = document.createElement('img');
    img.src = await resolveUiThumb(s.icon);
    img.alt = s.name;
    thumb.append(img);
    const meta = document.createElement('div');
    meta.className = 'asset-meta';
    const strong = document.createElement('strong');
    strong.textContent = `${s.name}（${s.kind === 'active' ? '主动' : '被动'} · 门槛 ${s.requiredPoints} 点）`;
    const sub = document.createElement('span');
    sub.textContent = s.cooldownFrames ? `冷却 ${s.cooldownFrames} 帧（${(s.cooldownFrames * 60 / 1000).toFixed(1)} 秒）` : '常驻 / 触发型被动';
    const fx = document.createElement('code');
    fx.textContent = `特效：${s.effects.join(', ') || '无'} ｜ 音效：${s.sounds.join(', ') || '无'}`;
    meta.append(strong, sub, fx);
    card.append(thumb, meta);
    return card;
  }));
  element('inventory-skills').replaceChildren(...skillCards);

  const buffCards = await Promise.all(buffIcons.map(async b => {
    const card = document.createElement('article');
    card.className = 'asset-card';
    const thumb = document.createElement('div');
    thumb.className = 'asset-thumb';
    const img = document.createElement('img');
    img.src = await resolveUiThumb(b.file);
    img.alt = b.label;
    thumb.append(img);
    const meta = document.createElement('div');
    meta.className = 'asset-meta';
    const strong = document.createElement('strong');
    strong.textContent = b.label;
    const src = document.createElement('span');
    src.textContent = b.source;
    const code = document.createElement('code');
    code.textContent = b.file;
    meta.append(strong, src, code);
    card.append(thumb, meta);
    return card;
  }));
  element('inventory-buffs').replaceChildren(...buffCards);
  element('inventory-ui-count').textContent = `${identity.length} 项职业图 · ${skills.length} 技能图标 · ${buffIcons.length} 状态图标`;

  await ensureEffectPages(effects.map(e => e.previewFile).filter(Boolean));
  const effectCards = effects.map(e => {
    const card = document.createElement('article');
    card.className = 'effect-card';
    const thumb = document.createElement('div');
    thumb.className = 'asset-thumb';
    const refs = EFFECT_ATLAS_BY_FILE[e.previewFile];
    if (refs?.length) {
      const midRef = refs[Math.floor(refs.length / 2)];
      const page = EFFECT_ATLAS_PAGES[midRef.page];
      const loaded = page ? atlasStore.get(page.key) : undefined;
      if (loaded) {
        const src = cropAtlasFrame(loaded, midRef.frame);
        if (src) {
          const img = document.createElement('img');
          img.src = src;
          img.alt = e.id;
          thumb.append(img);
        }
      }
    }
    const meta = document.createElement('div');
    meta.className = 'asset-meta';
    const strong = document.createElement('strong');
    strong.textContent = `${e.id}（${e.frames} 帧 · ${e.width}×${e.height}）`;
    const sub = document.createElement('span');
    sub.textContent = `方向：${e.directions.join('/')} · ${e.layers} 层（${e.blends.join(' / ')}）`;
    const used = document.createElement('code');
    used.textContent = `关联：${e.usedBy.join('、')}`;
    meta.append(strong, sub, used);
    card.append(thumb, meta);
    return card;
  });
  element('inventory-effects').replaceChildren(...effectCards);
  element('inventory-effects-count').textContent = `${effects.length} 组特效`;

  element('inventory-sounds').replaceChildren(...sounds.map(s => {
    const card = document.createElement('article');
    card.className = 'sound-card';
    const meta = document.createElement('div');
    meta.className = 'asset-meta';
    const strong = document.createElement('strong');
    strong.textContent = `${s.id}（${s.category}）`;
    const used = document.createElement('span');
    used.textContent = s.usedBy.join('、');
    const code = document.createElement('code');
    code.textContent = s.file;
    meta.append(strong, used, code);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sound-btn';
    btn.textContent = '▶ 试听';
    btn.onclick = () => playSound(s.id);
    card.append(meta, btn);
    return card;
  }));
  element('inventory-sounds-count').textContent = `${sounds.length} 个音效`;
}

async function openInventory(): Promise<void> {
  if (inventoryBuilt && inventoryData) return;
  report('正在汇总狂战士全部 117 个姿态与配套素材…');
  try {
    const ids = warriorPoseIds(catalog, items);
    await Promise.all(ids.map(id => repository.get(id)));
    inventoryData = warriorAssetInventory(catalog, items, battle, storyClasses, menuPanels, statusHud, audioCatalog);
    element('inventory-summary').textContent =
      `合法武器组合 ${inventoryData.stanceCount} 种 · 独立四向动作模板 ${inventoryData.templates.length} 组（${inventoryData.totalPoseFiles} 个姿态文件） · 换装部位 ${inventoryData.parts.length} 个 · 技能 ${inventoryData.supplemental.skills.length} 项 · 状态图标 ${inventoryData.supplemental.buffIcons.length} 枚 · 特效 ${inventoryData.supplemental.effects.length} 组 · 音效 ${inventoryData.supplemental.sounds.length} 个`;
    renderInventoryPoses(inventoryData);
    renderInventoryParts(inventoryData);
    await renderInventorySupplemental(inventoryData);
    inventoryBuilt = true;
    report('狂战士全量素材规格已就绪 · 可点击任意动作模板跳转画布，或导出规格清单');
  } catch (error) {
    report(error instanceof Error ? error.message : String(error), true);
  }
}

function switchView(view: 'inspector' | 'inventory'): void {
  currentView = view;
  const isInspector = view === 'inspector';
  workspace.hidden = !isInspector;
  inventoryView.hidden = isInspector;
  tabInspector.setAttribute('aria-selected', String(isInspector));
  tabInventory.setAttribute('aria-selected', String(!isInspector));
  if (isInspector) {
    const parent = element('character-canvas');
    if (parent.clientWidth && parent.clientHeight) game?.scale.resize(parent.clientWidth, parent.clientHeight);
    scene?.draw();
  } else {
    void openInventory();
  }
}

function wireControls(): void {
  tabInspector.onclick = () => switchView('inspector');
  tabInventory.onclick = () => switchView('inventory');

  element('export-markdown').onclick = () => {
    if (!inventoryData) return;
    downloadFile('warrior-asset-spec.md', formatInventoryMarkdown(inventoryData), 'text/markdown;charset=utf-8');
  };
  element('export-json').onclick = () => {
    if (!inventoryData) return;
    downloadFile('warrior-asset-spec.json', JSON.stringify(inventoryData, null, 2) + '\n', 'application/json;charset=utf-8');
  };

  playButton.onclick = () => {
    if (!ready) return;
    playback.toggle();
    resetSolo();
    renderFrame();
  };
  element('previous').onclick = () => selectFrame(playback.frame - 1);
  element('next').onclick = () => selectFrame(playback.frame + 1);
  timeline.oninput = () => selectFrame(Number(timeline.value));
  element<HTMLSelectElement>('speed').onchange = event => {
    playback.speed = Number((event.target as HTMLSelectElement).value);
  };
  zoomSelect.onchange = () => scene?.draw();
  showEffectsInput.onchange = () => scene?.draw();
  showTintInput.onchange = () => scene?.draw();
  element<HTMLSelectElement>('background').onchange = event => {
    stage.className = `stage ${(event.target as HTMLSelectElement).value}`;
  };
  showAll.onclick = () => { resetSolo(); renderFrame(); };

  presetSelect.onchange = () => {
    const preset = presets.find(entry => entry.id === presetSelect.value);
    appearanceId = preset?.appearanceId;
    clearOverridesForParts(WARRIOR_CORE_PARTS);
    void refresh(false);
  };
  mainSelect.onchange = () => {
    if (mainSelect.value) equipment['main-hand'] = mainSelect.value;
    else delete equipment['main-hand'];
    clearWeaponOverrides();
    refreshWeapons();
    void refresh();
  };
  offSelect.onchange = () => {
    if (offSelect.value) equipment['off-hand'] = offSelect.value;
    else delete equipment['off-hand'];
    clearWeaponOverrides();
    void refresh();
  };
  const wireArmor = (select: HTMLSelectElement, slot: 'body' | 'head' | 'back', affectedParts: readonly string[]) => {
    select.onchange = () => {
      if (select.value) equipment[slot] = select.value;
      else delete equipment[slot];
      clearOverridesForParts(affectedParts);
      void refresh(false);
    };
  };
  wireArmor(bodyArmorSelect, 'body', ['coat-front', 'coat-back']);
  wireArmor(headArmorSelect, 'head', ['head-front', 'head-back']);
  wireArmor(backArmorSelect, 'back', ['cloak']);

  element('reset').onclick = () => {
    appearanceId = undefined;
    presetSelect.value = 'hero';
    equipment = { 'main-hand': defaultWeaponId };
    overrides = {};
    hiddenParts = new Set();
    mainSelect.value = defaultWeaponId;
    bodyArmorSelect.value = '';
    headArmorSelect.value = '';
    backArmorSelect.value = '';
    refreshWeapons();
    void refresh();
  };

  element('directions').querySelectorAll<HTMLButtonElement>('button').forEach(button => {
    button.onclick = () => {
      facing = button.dataset.facing as Facing;
      element('directions').querySelectorAll('button').forEach(other => {
        other.setAttribute('aria-pressed', String(other === button));
      });
      void refresh();
    };
  });

  window.addEventListener('keydown', event => {
    if (!ready || currentView !== 'inspector' || event.altKey || event.metaKey || event.ctrlKey) return;
    if ((event.target as HTMLElement).closest('input, select, textarea, button, [contenteditable]')) return;
    if (event.code === 'Space') { event.preventDefault(); playButton.click(); }
    if (event.code === 'ArrowLeft') { event.preventDefault(); selectFrame(playback.frame - 1); }
    if (event.code === 'ArrowRight') { event.preventDefault(); selectFrame(playback.frame + 1); }
  });
}

async function boot(): Promise<void> {
  const [loadedBattle, loadedCatalog, loadedItems, loadedStoryClasses, loadedMenuPanels, loadedStatusHud,
    loadedCompanions, loadedAudio, spearProto] = await Promise.all([
    readJson<BattleCatalog>('/content/battle.json'),
    readJson<WardrobeCatalog>('/content/wardrobe.json'),
    readJson<ItemCatalog>('/content/items.json'),
    readJson<StoryClassesLite>('/content/story-classes.json'),
    readJson<MenuPanelsLite>('/content/menu-panels.json'),
    readJson<StatusHudLite>('/content/status-hud.json'),
    readJson<CompanionCatalogLite>('/content/companions.json'),
    readJson<AudioCatalogLite>('/content/audio.json'),
    readJson<PrototypeWeaponBundle>('./prototypes/spear/spear-prototype.json').catch(() => undefined),
  ]);
  battle = loadedBattle;
  storyClasses = loadedStoryClasses;
  menuPanels = loadedMenuPanels;
  statusHud = loadedStatusHud;
  companions = loadedCompanions;
  audioCatalog = loadedAudio;
  if (spearProto) {
    const merged = mergePrototypeWeapon(loadedCatalog, loadedItems, spearProto);
    catalog = merged.catalog;
    items = merged.items;
    prototypeLabels = spearProto.actionLabels ?? {};
  } else {
    catalog = loadedCatalog;
    items = loadedItems;
  }
  repository = new PoseRepository(catalog, readJson<CostumePose>);
  skillNames = Object.fromEntries(Object.entries(battle.skills).map(([id, value]) => [id, value.name]));
  const warriorClass = battle.classes.find(entry => entry.id === 'warrior');
  if (warriorClass?.actor.effectAnchor) effectAnchor = warriorClass.actor.effectAnchor;

  presets = warriorPresets(catalog, companions);
  presetSelect.replaceChildren(...presets.map(preset => option(preset.id, preset.label)));
  presetSelect.value = 'hero';

  const weaponOpts = weaponChoices(catalog, items);
  const defaultAppearance = catalog.equipment[items.startingEquipment.warrior['main-hand']!];
  const warriorDefault = weaponOpts.find(choice => JSON.stringify(catalog.equipment[choice.id].main) ===
    JSON.stringify(defaultAppearance.main))!;
  const protoOpt = spearProto ? weaponOpts.find(choice => choice.id === spearProto.weaponId) : undefined;
  const requestedWeapon = new URLSearchParams(window.location.search).get('weapon');
  defaultWeaponId = requestedWeapon && weaponOpts.some(choice => choice.id === requestedWeapon)
    ? requestedWeapon
    : warriorDefault.id;
  equipment = { 'main-hand': defaultWeaponId };

  mainSelect.append(option('', '空手'));
  if (protoOpt) mainSelect.append(option(protoOpt.id, protoOpt.label));
  mainSelect.append(
    option(warriorDefault.id, `${warriorDefault.label}（狂战士默认）`),
    ...weaponOpts
      .filter(choice => choice.id !== warriorDefault.id && choice.id !== protoOpt?.id)
      .map(choice => option(choice.id, choice.label)),
  );
  mainSelect.value = defaultWeaponId;
  refreshWeapons();

  const populateArmor = (select: HTMLSelectElement, slot: 'body' | 'head' | 'back', emptyLabel: string) => {
    const list = armorChoices(catalog, items, slot);
    select.replaceChildren(option('', emptyLabel), ...list.map(choice => option(choice.id, choice.label)));
  };
  populateArmor(bodyArmorSelect, 'body', '默认基础服装');
  populateArmor(headArmorSelect, 'head', '默认发型');
  populateArmor(backArmorSelect, 'back', '无披风');

  wireControls();
  await Promise.all(catalog.textures.map(async texture => { images.set(texture.key, await readImage(texture.file)); }));
  const parent = element('character-canvas');
  game = new Phaser.Game({
    type: Phaser.WEBGL, parent, width: parent.clientWidth, height: parent.clientHeight,
    transparent: true, pixelArt: true, roundPixels: false, antialias: false, banner: false,
    audio: { noAudio: true }, scene: CharacterScene,
    scale: { mode: Phaser.Scale.NONE }, fps: { target: 30 },
  });
  observer = new ResizeObserver(() => {
    if (parent.clientWidth && parent.clientHeight) game?.scale.resize(parent.clientWidth, parent.clientHeight);
  });
  observer.observe(parent);
}

window.addEventListener('pagehide', () => {
  observer?.disconnect();
  previewAudio?.pause();
  game?.destroy(true);
});
void boot().catch(error => report(error instanceof Error ? error.message : String(error), true));
