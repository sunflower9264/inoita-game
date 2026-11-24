import type { AttackPlacement, BasicAttackComboStep, BasicAttackDefinition, BattleCatalog, SkillAction } from '../../src/domain/battle.ts';
import type { EffectClip, Facing } from '../../src/domain/content.ts';
import type { EquipmentSlot, ItemCatalog } from '../../src/domain/items.ts';
import type { StatusColor } from '../../src/domain/status-color.ts';
import { costumeRecipe, sharedWardrobePoses, townMovementPoses, wardrobePoseFile } from '../../src/domain/wardrobe.ts';
import type { CostumePart, CostumePiece, CostumePose, WardrobeCatalog } from '../../src/domain/wardrobe.ts';

export const WARRIOR_CORE_PARTS = ['body', 'head-front', 'head-back', 'coat-front', 'coat-back', 'cloak'] as const;
export const WARRIOR_WEAPON_PARTS = ['two-handed', 'main-blade', 'off-blade', 'main-dagger', 'off-dagger', 'shield'] as const;
export const WARRIOR_PARTS = [...WARRIOR_CORE_PARTS, ...WARRIOR_WEAPON_PARTS] as const;

export const WARRIOR_NO_VISUAL_SLOTS: readonly { slot: EquipmentSlot; label: string; note: string }[] = [
  { slot: 'hands', label: '护手', note: '手臂与手套画在「上衣 / 双臂」切片中，护手槽位不切换外观' },
  { slot: 'feet', label: '鞋子', note: '腿脚与靴子画在「下装 / 腿脚」切片中，鞋子槽位不切换外观' },
  { slot: 'ring', label: '戒指', note: '仅提供属性与背包图标，无人物切片' },
  { slot: 'neck', label: '项链', note: '仅提供属性与背包图标，无人物切片' },
];

export const PART_NAMES: Record<string, string> = {
  body: '基础头脸', 'head-front': '发型 / 帽子', 'head-back': '头饰',
  'coat-front': '上衣 / 双臂', 'coat-back': '下装 / 腿脚', cloak: '披风',
  'two-handed': '双手武器', 'main-blade': '主手剑 / 斧 / 锤', 'off-blade': '副手剑 / 斧 / 锤',
  'main-dagger': '主手短剑', 'off-dagger': '副手短剑', shield: '盾牌',
  spear: '长枪（样板）',
  'cast-prop-1': '技能道具',
};

const PART_SLOT_LABELS: Record<string, string> = {
  body: '角色基础（不可换装备）',
  'head-front': '头部装备（head）',
  'head-back': '头部装备（head）',
  'coat-front': '身体装备（body）',
  'coat-back': '身体装备（body）',
  cloak: '披风装备（back）',
  'two-handed': '主手双手剑（main-hand）',
  'main-blade': '主手单手剑/斧/锤（main-hand）',
  'off-blade': '副手单手剑/斧/锤（off-hand）',
  'main-dagger': '主手短剑（main-hand）',
  'off-dagger': '副手短剑（off-hand）',
  shield: '副手盾牌（off-hand）',
};

const KIND_LABELS: Record<string, string> = {
  unarmed: '空手', empty: '空副手', dagger: '短剑', longsword: '长剑',
  axe: '斧', mace: '钝器', 'two-handed': '双手剑', shield: '盾牌', spear: '长枪',
};

const ACTION_NAMES: Record<string, string> = {
  idle: '持械待机', walk: '持械行走', attack: '普通攻击 · 第一段',
  'attack-2': '普通攻击 · 第二段', 'attack-3': '普通攻击 · 第三段',
  'dual-attack': '双持攻击', 'dual-quick-attack': '双持快速攻击',
  'frenzy-blade': '狂暴攻击 · 单手', 'frenzy-dagger': '狂暴攻击 · 短剑',
  'frenzy-two-handed': '狂暴攻击 · 双手', die: '战斗阵亡',
  thrust: '直刺', sweep: '横扫',
  'spear-upright-idle': '立枪待机（单手直立）',
};

const WEAPON_PART_BY_KIND: Record<string, { main?: string; off?: string }> = {
  dagger: { main: 'main-dagger', off: 'off-dagger' },
  longsword: { main: 'main-blade', off: 'off-blade' },
  axe: { main: 'main-blade', off: 'off-blade' },
  mace: { main: 'main-blade', off: 'off-blade' },
  'two-handed': { main: 'two-handed' },
  spear: { main: 'spear' },
  shield: { off: 'shield' },
};

const WARRIOR_MAIN_KINDS = new Set(['unarmed', 'dagger', 'longsword', 'axe', 'mace', 'two-handed']);
const WARRIOR_OFF_KINDS = new Set(['empty', 'dagger', 'longsword', 'axe', 'mace', 'shield']);
const DIRECTIONS: readonly Facing[] = ['south', 'west', 'north', 'east'];

const WARRIOR_EXTRA_BUFF_ICONS: readonly { id: string; label: string; source: string }[] = [
  { id: 'shouts-of-threat', label: '狮子吼（减攻防/挑衅）', source: '主动技能：狮子吼' },
  { id: 'armor-penetration', label: '穿透防具', source: '主动技能：穿透防具' },
  { id: 'weapon-hitback', label: '狂气之剑（反伤）', source: '主动技能：狂气之剑' },
  { id: 'blood-thirst', label: '血之渴望（吸血）', source: '主动技能：血之渴望' },
  { id: 'storm-of-frenzy', label: '狂乱之暴风', source: '主动技能：狂乱之暴风' },
  { id: 'storm-of-frenzy-power', label: '狂乱之暴风 · 叠加增伤', source: '主动技能：狂乱之暴风（受击叠加）' },
  { id: 'enrage', label: '血之狂暴', source: '主动技能：血之狂暴' },
  { id: 'blood-revenge', label: '复仇之天神（暴击叠加）', source: '被动技能：复仇之天神' },
];

export type EquipmentSelection = Partial<Record<EquipmentSlot, string>>;
export type VariantOverrides = Record<string, string | null>;
export interface WeaponChoice { id: string; label: string; kind: string }
export interface PrototypeEffectSheet {
  texture: { key: string; file: string };
  frames: Record<string, { x: number; y: number; width: number; height: number }>;
  byFile: Record<string, string[]>;
}
export interface PrototypeEffectCueSpec {
  effect: string;
  startFrame: number;
  variant?: 'facing' | 'default';
  placement?: AttackPlacement;
  onTarget?: boolean;
  targetDistancePx?: number;
  source: string;
}
export interface PrototypeAfterimageSpec {
  frames: number[];
  opacity: number;
  distancesPx: number[];
}
export interface PrototypeActionTimelineSpec {
  cycleFrames?: number;
  cues?: PrototypeEffectCueSpec[];
  markers?: KeyframeMarker[];
  shakeFrames?: number[];
  afterimages?: PrototypeAfterimageSpec;
  appearanceColors?: readonly StatusColor[];
  sounds?: string[];
  swingFrame?: number | null;
  strikeFrame?: number;
  swings?: string[];
  swingPlacement?: AttackPlacement;
  swingLabel?: string;
  sound?: string;
}
export interface PrototypeWeaponBundle {
  weaponId: string;
  weaponName: string;
  weaponKind: string;
  partName: string;
  variantId: string;
  texture: { key: string; file: string };
  sprites: Record<string, CostumePiece>;
  variants: Record<string, (string | null)[]>;
  stancePoses: Record<string, string>;
  actionLabels?: Record<string, string>;
  actionTimelines?: Record<string, PrototypeActionTimelineSpec>;
  effectSheet?: PrototypeEffectSheet;
  attackEffects?: BattleCatalog['attackEffects'];
  poses: Record<string, CostumePose>;
}
export interface ArmorChoice { id: string; label: string; slot: 'body' | 'head' | 'back'; parts: Record<string, string> }
export interface CompanionPreset { id: string; label: string; appearanceId?: string; fixedParts: string[] }
export interface ActionChoice { key: string; label: string; group: string; poseId: string }
export interface FramePiece { order: number; part: CostumePart; key: string; sprite: CostumePiece }
export interface PoseBounds { left: number; top: number; right: number; bottom: number }
export interface VariantOption { id: string; label: string; warrior: boolean }

export interface EffectCueSpec {
  effect: string;
  variant: string;
  startFrame: number;
  frames: number;
  placement: AttackPlacement;
  attachmentPoint?: 'feet' | 'effect-anchor';
  onTarget: boolean;
  targetDistancePx?: number;
  source: string;
}

export interface KeyframeMarker {
  frame: number;
  kind: 'swing' | 'strike' | 'effect' | 'charge' | 'buff';
  label: string;
}

export interface ActionTimeline {
  cycleFrames?: number;
  effects: EffectCueSpec[];
  markers: KeyframeMarker[];
  sounds: string[];
  shakeFrames: number[];
  afterimages?: PrototypeAfterimageSpec;
  appearanceColors?: readonly StatusColor[];
}

export interface ActiveEffectLayer {
  cue: EffectCueSpec;
  clip: EffectClip;
  effectFrame: number;
}

export interface WarriorPoseTemplate {
  id: string;
  category: string;
  labels: string[];
  stances: string[];
  frames: Record<Facing, number>;
  frameRate: number;
  mirrorEast: boolean;
  parts: string[];
  sampleEquipment: EquipmentSelection;
  sampleActionKey: string;
}

export interface PartSliceSpec {
  index: number;
  defaultKey: string | null;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  combatUsed: boolean;
  dieUsed: boolean;
}

export interface WarriorPartSpec {
  part: string;
  label: string;
  slotLabel: string;
  sliceCount: number;
  combatUsedCount: number;
  dieOnlyCount: number;
  warriorVariantCount: number;
  totalVariantCount: number;
  defaultVariant: string;
  slices: PartSliceSpec[];
}

export interface CompanionCatalogLite {
  definitions: Record<string, { id: string; name: string; classId: string; actor: string; source?: string }>;
}

export interface StoryClassesLite {
  classes: { id: string; name: string; icon: string; previewActor: { id: string; clips: Record<string, { frames: number; frameWidth: number; frameHeight: number }> } }[];
}

export interface MenuPanelsLite {
  assets: Record<string, string>;
  classes: Record<string, { preview: string }>;
  character: { classPortraits: Record<string, string> };
}

export interface StatusHudLite {
  buffIcons: { size: number; catalog: Record<string, string> };
}

export interface AudioCatalogLite {
  effects: Record<string, string>;
  combat?: {
    weapons?: Record<string, {
      normal?: { sound: string; weight: number }[];
      critical?: string | null;
      miss?: string | null;
      blocked?: string | null;
    }>;
    shieldBlock?: string;
  };
  skills?: Record<string, string>;
}

export interface SupplementalAssetInventory {
  identity: { label: string; file: string; usage: string }[];
  skills: {
    id: string; name: string; kind: 'active' | 'passive'; icon: string;
    requiredPoints: number; cooldownFrames?: number; effects: string[]; sounds: string[];
  }[];
  buffIcons: { id: string; label: string; file: string; source: string }[];
  effects: {
    id: string; directions: string[]; frames: number; frameRate: number;
    width: number; height: number; layers: number; blends: string[]; usedBy: string[];
    previewFile: string;
  }[];
  sounds: { id: string; file: string; category: '技能音效' | '武器攻击音效'; usedBy: string[] }[];
}

export interface WarriorAssetInventory {
  stanceCount: number;
  totalPoseFiles: number;
  templates: WarriorPoseTemplate[];
  parts: WarriorPartSpec[];
  noVisualSlots: readonly { slot: EquipmentSlot; label: string; note: string }[];
  supplemental: SupplementalAssetInventory;
}

export function weaponChoices(catalog: WardrobeCatalog, items: ItemCatalog, offhand = false): WeaponChoice[] {
  const result: WeaponChoice[] = [];
  const seen = new Set<string>();
  for (const [id, item] of Object.entries(items.items)) {
    const equipment = item.equipment;
    const appearance = catalog.equipment[id];
    if (!equipment?.classes.includes('warrior') || !appearance) continue;
    const usable = offhand ? item.kind === 'shield' || equipment.dualWield : equipment.slot === 'main-hand';
    if (!usable) continue;
    const parts = offhand && equipment.dualWield ? appearance.offHand : appearance.main;
    const signature = JSON.stringify([item.kind, parts]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push({ id, label: item.name, kind: item.kind });
  }
  return result;
}

export function compatibleOffhands(catalog: WardrobeCatalog, items: ItemCatalog, main?: string): WeaponChoice[] {
  const kind = main ? items.items[main].kind : 'unarmed';
  return weaponChoices(catalog, items, true).filter(choice => catalog.stances[`${kind}:${choice.kind}`]);
}

export function armorChoices(catalog: WardrobeCatalog, items: ItemCatalog, slot: 'body' | 'head' | 'back'): ArmorChoice[] {
  const result: ArmorChoice[] = [];
  const seen = new Set<string>();
  for (const [id, item] of Object.entries(items.items)) {
    const equipment = item.equipment;
    const appearance = catalog.equipment[id];
    if (!equipment?.classes.includes('warrior') || equipment.slot !== slot || !appearance) continue;
    if (!Object.keys(appearance.main).length) continue;
    const signature = JSON.stringify(Object.entries(appearance.main).sort());
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push({ id, label: item.name, slot, parts: appearance.main });
  }
  return result;
}

export function warriorPresets(catalog: WardrobeCatalog, companions?: CompanionCatalogLite): CompanionPreset[] {
  const result: CompanionPreset[] = [{ id: 'hero', label: '主角 · 凯恩（狂战士）', fixedParts: [] }];
  if (!companions || !catalog.companions) return result;
  const seenActors = new Set<string>();
  for (const definition of Object.values(companions.definitions)) {
    if (definition.classId !== 'warrior') continue;
    const entry = catalog.companions[definition.actor];
    if (!entry || seenActors.has(definition.actor)) continue;
    seenActors.add(definition.actor);
    const suffix = definition.source === 'story' ? '剧情伙伴' : '狂战士佣兵';
    result.push({
      id: definition.actor,
      label: `${definition.name}（${suffix} · ${definition.actor}）`,
      appearanceId: definition.actor,
      fixedParts: [...entry.fixedParts],
    });
  }
  return result;
}

export function mergePrototypeWeapon(catalog: WardrobeCatalog, items: ItemCatalog,
  prototype: PrototypeWeaponBundle): { catalog: WardrobeCatalog; items: ItemCatalog } {
  const stanceKey = `${prototype.weaponKind}:empty`;
  const fallbackAttack = catalog.attacks['two-handed:empty'] ?? Object.values(catalog.attacks)[0];
  const mergedCatalog: WardrobeCatalog = {
    ...catalog,
    textures: catalog.textures.some(t => t.key === prototype.texture.key)
      ? catalog.textures
      : [...catalog.textures, prototype.texture],
    sprites: { ...catalog.sprites, ...prototype.sprites },
    variants: { ...catalog.variants, ...prototype.variants },
    equipment: {
      ...catalog.equipment,
      [prototype.weaponId]: { main: { [prototype.partName]: prototype.variantId }, offHand: {} },
    },
    poses: { ...catalog.poses, ...prototype.poses },
    stances: { ...catalog.stances, [stanceKey]: prototype.stancePoses },
    attacks: { ...catalog.attacks, [stanceKey]: fallbackAttack },
  };
  const sampleItem = Object.values(items.items).find(item => item.equipment?.slot === 'main-hand' && item.equipment.classes.includes('warrior'))!;
  const mergedItems: ItemCatalog = {
    ...items,
    items: {
      ...items.items,
      [prototype.weaponId]: {
        ...sampleItem,
        name: prototype.weaponName,
        kind: prototype.weaponKind as ItemCatalog['items'][string]['kind'],
        equipment: {
          ...sampleItem.equipment!,
          slot: 'main-hand',
          classes: ['warrior'],
          dualWield: false,
          twoHanded: true,
        },
      },
    },
  };
  return { catalog: mergedCatalog, items: mergedItems };
}

export function mergePrototypeBattle(battle: BattleCatalog, prototype: PrototypeWeaponBundle): BattleCatalog {
  if (!prototype.attackEffects || !Object.keys(prototype.attackEffects).length) return battle;
  return {
    ...battle,
    attackEffects: {
      ...battle.attackEffects,
      ...prototype.attackEffects,
    },
  };
}

export function viewerRecipe(catalog: WardrobeCatalog, items: ItemCatalog, equipment: EquipmentSelection,
  overrides: VariantOverrides, appearanceId?: string) {
  const mainKind = equipment['main-hand'] ? items.items[equipment['main-hand']]?.kind : undefined;
  const classId = mainKind && !WARRIOR_MAIN_KINDS.has(mainKind) ? undefined : 'warrior';
  const recipe = costumeRecipe(catalog, items, equipment, classId, appearanceId);
  const variants: Record<string, string> = { ...recipe.variants };
  for (const [part, variant] of Object.entries(overrides)) {
    if (variant === null) delete variants[part];
    else variants[part] = variant;
  }
  return { ...recipe, variants };
}

export function actionChoices(catalog: WardrobeCatalog, items: ItemCatalog, equipment: EquipmentSelection,
  facing: Facing, skillNames: Record<string, string>, customLabels?: Record<string, string>): ActionChoice[] {
  const recipe = viewerRecipe(catalog, items, equipment, {});
  const mainKind = equipment['main-hand'] ? items.items[equipment['main-hand']]?.kind : undefined;
  const isPrototypeWeapon = !!mainKind && !WARRIOR_MAIN_KINDS.has(mainKind);
  const result: ActionChoice[] = [];
  for (const [clip, poseId] of Object.entries(recipe.poses)) {
    const suffix = `-${facing}`;
    if (!poseId || !clip.endsWith(suffix)) continue;
    const key = clip.slice(0, -suffix.length);
    const skill = key.startsWith('skill-');
    const group = isPrototypeWeapon
      ? (skill ? '主动技能' : key.startsWith('attack') ? '普通攻击' : key === 'spear-die' ? '阵亡动作' : '基础动作')
      : skill ? '主动技能' : key.startsWith('frenzy-') ? '狂暴攻击'
        : key.startsWith('dual-') ? '双持攻击' : key.startsWith('attack') ? '普通攻击' : '基础动作';
    const label = customLabels?.[key] ?? (skill ? skillNames[key.slice(6)] ?? key : ACTION_NAMES[key] ?? key);
    result.push({ key, label, group, poseId });
  }
  const town = townMovementPoses(catalog);
  for (const movement of ['idle', 'walk'] as const) {
    result.push({ key: `town-${movement}`, label: movement === 'idle' ? '地图待机' : '地图行走',
      group: '地图动作', poseId: town[`${movement}-${facing}`]! });
  }
  const shared = sharedWardrobePoses(catalog);
  const diePose = shared[`die-${facing}`];
  if (diePose) {
    result.push({ key: 'die', label: ACTION_NAMES.die, group: '阵亡动作', poseId: diePose });
  }
  return result;
}

export function actionNotices(catalog: WardrobeCatalog, items: ItemCatalog, equipment: EquipmentSelection,
  actionKey: string, pose: CostumePose): string[] {
  const notices: string[] = [];
  const mainKind = equipment['main-hand'] ? items.items[equipment['main-hand']].kind : 'unarmed';
  const offKind = equipment['off-hand'] ? items.items[equipment['off-hand']].kind : 'empty';
  const stance = `${mainKind}:${offKind}`;
  const wait = catalog.frenzyWaitFrames?.[stance];
  if (wait !== undefined && !catalog.frenzyAttacks?.[stance]) {
    notices.push(`当前架势（${KIND_LABELS[mainKind] ?? mainKind} + ${KIND_LABELS[offKind] ?? offKind}）无狂暴攻击动作，触发「战栗的狂气」时走 ${wait} 帧等待。`);
  }
  const partsInPose = new Set<string>();
  for (const frame of pose.frames) for (const part of frame) partsInPose.add(part.part);
  const mainPart = WEAPON_PART_BY_KIND[mainKind]?.main;
  if (mainPart && !partsInPose.has(mainPart)) {
    notices.push(`原版骨架提示：该动作（${actionKey}）的帧数据不含「${PART_NAMES[mainPart] ?? mainPart}」槽位，播放期间主手武器会隐藏。`);
  }
  const offPart = WEAPON_PART_BY_KIND[offKind]?.off;
  if (offPart && !partsInPose.has(offPart)) {
    notices.push(`原版骨架提示：该动作（${actionKey}）的帧数据不含「${PART_NAMES[offPart] ?? offPart}」槽位，播放期间副手装备会隐藏。`);
  }
  return notices;
}

function collectWarriorVariants(catalog: WardrobeCatalog, items: ItemCatalog): Set<string> {
  const used = new Set<string>(Object.values(catalog.defaults));
  for (const [id, item] of Object.entries(items.items)) {
    if (!item.equipment?.classes.includes('warrior')) continue;
    const appearance = catalog.equipment[id];
    if (!appearance) continue;
    for (const variant of [...Object.values(appearance.main), ...Object.values(appearance.offHand)]) used.add(variant);
  }
  return used;
}

export function variantChoices(catalog: WardrobeCatalog, items: ItemCatalog, part: string): VariantOption[] {
  const names = new Map<string, Set<string>>();
  const warriorVariants = collectWarriorVariants(catalog, items);
  for (const [id, appearance] of Object.entries(catalog.equipment)) {
    const name = items.items[id]?.name;
    if (!name) continue;
    for (const map of [appearance.main, appearance.offHand]) {
      const variant = map[part];
      if (!variant) continue;
      if (!names.has(variant)) names.set(variant, new Set());
      names.get(variant)!.add(name);
    }
  }
  return Object.keys(catalog.variants).filter(id => id === part || id.startsWith(`${part}-style-`))
    .map(id => ({
      id,
      label: [...(names.get(id) ?? [])].slice(0, 2).join(' / ') ||
        `${PART_NAMES[part] ?? part} · ${id.split('-style-')[1] ?? '默认'}`,
      warrior: warriorVariants.has(id),
    }));
}

export function framePieces(catalog: WardrobeCatalog, variants: Record<string, string>, frame: CostumePart[]): FramePiece[] {
  const result: FramePiece[] = [];
  for (const [order, part] of frame.entries()) {
    const variant = variants[part.part];
    if (!variant) continue;
    const entries = catalog.variants[variant];
    if (!entries) throw new Error(`外观款式缺失：${variant}`);
    const key = entries[part.piece];
    if (key === null) continue;
    const sprite = key ? catalog.sprites[key] : undefined;
    if (!sprite) throw new Error(`切片缺失：${variant}[${part.piece}]`);
    result.push({ order, part, key: key!, sprite });
  }
  return result;
}

export function poseBounds(catalog: WardrobeCatalog, variants: Record<string, string>, pose: CostumePose): PoseBounds {
  const bounds = { left: 0, top: 0, right: 0, bottom: 0 };
  for (const frame of pose.frames) for (const { part, sprite } of framePieces(catalog, variants, frame)) {
    const angle = part.angle * Math.PI / 180;
    for (const x of [0, sprite.width]) for (const y of [0, sprite.height]) {
      const u = (x - sprite.anchorX) * part.scaleX;
      const v = (y - sprite.anchorY) * part.scaleY;
      const px = part.x + u * Math.cos(angle) - v * Math.sin(angle);
      const py = part.y + u * Math.sin(angle) + v * Math.cos(angle);
      const worldX = pose.mirrorX ? -px : px;
      bounds.left = Math.min(bounds.left, Math.floor(worldX));
      bounds.right = Math.max(bounds.right, Math.ceil(worldX));
      bounds.top = Math.min(bounds.top, Math.floor(py));
      bounds.bottom = Math.max(bounds.bottom, Math.ceil(py));
    }
  }
  return bounds;
}

function resolveEffectVariant(battle: BattleCatalog, effectId: string, preferred: string): string {
  const clips = battle.attackEffects[effectId]?.clips;
  if (!clips) return preferred;
  if (clips[preferred]) return preferred;
  return clips.default ? 'default' : Object.keys(clips)[0] ?? preferred;
}

function addCue(target: EffectCueSpec[], seen: Set<string>, battle: BattleCatalog,
  effectId: string, preferredVariant: string, startFrame: number, placement: AttackPlacement, onTarget: boolean, source: string, targetDistancePx?: number): void {
  const definition = battle.attackEffects[effectId];
  if (!definition) return;
  const variant = resolveEffectVariant(battle, effectId, preferredVariant);
  const clip = definition.clips[variant];
  if (!clip) return;
  const key = `${effectId}|${variant}|${startFrame}|${placement}|${onTarget}|${targetDistancePx ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({
    effect: effectId,
    variant,
    startFrame,
    frames: clip.frames,
    placement,
    attachmentPoint: definition.attachmentPoint,
    onTarget,
    targetDistancePx,
    source,
  });
}

function weaponAttackSounds(audio: AudioCatalogLite | undefined, weaponKind: string): string[] {
  const entry = audio?.combat?.weapons?.[weaponKind];
  if (!entry) return [];
  const sounds: string[] = [];
  for (const item of entry.normal ?? []) if (!sounds.includes(item.sound)) sounds.push(item.sound);
  if (entry.critical && !sounds.includes(entry.critical)) sounds.push(entry.critical);
  return sounds;
}

function resolveAttackTimeline(battle: BattleCatalog, audio: AudioCatalogLite | undefined,
  attack: BasicAttackDefinition | (BasicAttackDefinition & BasicAttackComboStep), facing: Facing, weaponKind: string): ActionTimeline {
  const effects: EffectCueSpec[] = [];
  const seen = new Set<string>();
  const markers: KeyframeMarker[] = [];
  const sounds = weaponAttackSounds(audio, weaponKind);
  const shakeFrames: number[] = [];

  if (attack.swingFrame !== null && attack.swingFrame !== undefined && attack.swings.length) {
    markers.push({ frame: attack.swingFrame, kind: 'swing', label: `出刀光（${attack.swings.join(' / ')}）` });
    for (const effectId of attack.swings) {
      addCue(effects, seen, battle, effectId, facing, attack.swingFrame, attack.swingPlacement ?? 'above-characters', false, '挥砍刀光');
    }
  }
  if (attack.strikes?.length) {
    for (const strike of attack.strikes) {
      markers.push({ frame: strike.frame, kind: 'strike', label: strike.hand === 'main-hand' ? '主手命中' : '副手命中' });
    }
  } else {
    markers.push({ frame: attack.strikeFrame, kind: 'strike', label: '命中结算' });
  }
  for (const effect of attack.dispatch?.casterEffects ?? []) {
    addCue(effects, seen, battle, effect.effect, 'default', attack.strikeFrame, effect.placement, false, '施放特效');
  }
  if (attack.dispatch?.sound && !sounds.includes(attack.dispatch.sound)) sounds.push(attack.dispatch.sound);
  if (attack.dispatch?.shake) shakeFrames.push(attack.strikeFrame);

  markers.sort((a, b) => a.frame - b.frame);
  return { cycleFrames: attack.cycleFrames, effects, markers, sounds, shakeFrames };
}

function resolveSkillTimeline(battle: BattleCatalog, audio: AudioCatalogLite | undefined,
  skillId: string, action: SkillAction, facing: Facing): ActionTimeline {
  const effects: EffectCueSpec[] = [];
  const seen = new Set<string>();
  const markers: KeyframeMarker[] = [];
  const sounds: string[] = [];
  const shakeFrames: number[] = [];

  if (action.charge) {
    markers.push({ frame: action.charge.arrivalFrame, kind: 'charge', label: '冲锋抵达' });
  }
  let unitHitIndex = 0;
  const totalUnitEvents = action.events.filter(event => event.kind === 'units').length;
  for (const event of action.events) {
    switch (event.kind) {
      case 'cast':
        addCue(effects, seen, battle, event.effect.effect, 'default', event.frame, event.effect.placement, false, '起手施法');
        markers.push({ frame: event.frame, kind: 'effect', label: `起手特效（${event.effect.effect}）` });
        break;
      case 'caster':
        for (const visual of event.effects) {
          addCue(effects, seen, battle, visual.effect, 'default', event.frame, visual.placement, false, '自身特效');
        }
        if (event.effects.length) {
          markers.push({ frame: event.frame, kind: 'effect', label: `自身特效（${event.effects.map(e => e.effect).join(' / ')}）` });
        }
        break;
      case 'swing':
        for (const visual of event.effects) {
          const variant = visual.recipient === 'caster' ? facing : 'default';
          addCue(effects, seen, battle, visual.effect, variant, event.frame, visual.placement, visual.recipient === 'target', '技能挥砍');
        }
        if (event.effects.length) {
          markers.push({ frame: event.frame, kind: 'swing', label: `技能刀光（${event.effects.map(e => e.effect).join(' / ')}）` });
        }
        break;
      case 'impact': {
        const onTarget = event.target !== 'self' && event.effect.recipient === 'target';
        addCue(effects, seen, battle, event.effect.effect, 'default', event.frame, event.effect.placement, onTarget, onTarget ? '目标特效' : '自身环绕特效');
        markers.push({ frame: event.frame, kind: 'effect', label: `特效（${event.effect.effect}）` });
        break;
      }
      case 'units': {
        unitHitIndex++;
        const selfOnly = event.cues.every(cue => cue.target === 'self');
        const label = selfOnly ? '增益生效' : totalUnitEvents > 1 ? `第 ${unitHitIndex} 段命中` : '技能结算';
        markers.push({ frame: event.frame, kind: selfOnly ? 'buff' : 'strike', label });
        for (const visual of event.dispatch?.casterEffects ?? []) {
          addCue(effects, seen, battle, visual.effect, 'default', event.frame, visual.placement, false, '施放光环');
        }
        for (const cue of event.cues) {
          if (cue.sound && !sounds.includes(cue.sound)) sounds.push(cue.sound);
          for (const visual of cue.effects) {
            const onTarget = cue.target !== 'self' && visual.recipient === 'target';
            addCue(effects, seen, battle, visual.effect, 'default', event.frame, visual.placement, onTarget, onTarget ? '目标受击特效' : '自身特效');
          }
        }
        if (event.dispatch?.sound && !sounds.includes(event.dispatch.sound)) sounds.push(event.dispatch.sound);
        if (event.dispatch?.shake && !shakeFrames.includes(event.frame)) shakeFrames.push(event.frame);
        break;
      }
      default:
        break;
    }
  }
  const fallbackSkillSound = audio?.skills?.[skillId];
  if (fallbackSkillSound && !sounds.includes(fallbackSkillSound)) sounds.push(fallbackSkillSound);

  const baseAction = battle.skills[skillId]?.action;
  let appearanceColors: readonly StatusColor[] | undefined;
  for (const unit of baseAction?.combatUnits ?? []) {
    if (unit.effect === 'buff') {
      const colors = unit.ranks[0]?.effect.appearanceColors;
      if (colors?.length) { appearanceColors = colors; break; }
    }
  }
  markers.sort((a, b) => a.frame - b.frame);
  return { effects, markers, sounds, shakeFrames, appearanceColors };
}

function resolvePrototypeTimeline(battle: BattleCatalog, spec: PrototypeActionTimelineSpec, facing: Facing): ActionTimeline {
  const effects: EffectCueSpec[] = [];
  const seen = new Set<string>();
  const markers: KeyframeMarker[] = [...(spec.markers ?? [])];
  const sounds = [...(spec.sounds ?? [])];
  if (spec.sound && !sounds.includes(spec.sound)) sounds.push(spec.sound);

  for (const cue of spec.cues ?? []) {
    const preferredVariant = cue.variant === 'default' ? 'default' : facing;
    addCue(effects, seen, battle, cue.effect, preferredVariant, cue.startFrame,
      cue.placement ?? 'above-characters', cue.onTarget ?? false, cue.source, cue.targetDistancePx);
  }

  const swingLabel = spec.swingLabel ?? '出特效';
  if (spec.swingFrame !== null && spec.swingFrame !== undefined && spec.swings?.length) {
    markers.push({ frame: spec.swingFrame, kind: 'swing', label: `${swingLabel}（${spec.swings.join(' / ')}）` });
    for (const effectId of spec.swings) {
      addCue(effects, seen, battle, effectId, facing, spec.swingFrame, spec.swingPlacement ?? 'above-characters', false, swingLabel);
    }
  }
  if (spec.strikeFrame !== undefined) {
    markers.push({ frame: spec.strikeFrame, kind: 'strike', label: '命中结算' });
  }
  markers.sort((a, b) => a.frame - b.frame);
  return {
    cycleFrames: spec.cycleFrames,
    effects,
    markers,
    sounds,
    shakeFrames: [...(spec.shakeFrames ?? [])],
    afterimages: spec.afterimages,
    appearanceColors: spec.appearanceColors,
  };
}

export function actionTimeline(catalog: WardrobeCatalog, items: ItemCatalog, battle: BattleCatalog,
  equipment: EquipmentSelection, actionKey: string, facing: Facing, audio?: AudioCatalogLite,
  customTimelines?: Record<string, PrototypeActionTimelineSpec>): ActionTimeline {
  const custom = customTimelines?.[actionKey];
  if (custom) return resolvePrototypeTimeline(battle, custom, facing);
  const recipe = viewerRecipe(catalog, items, equipment, {});
  const mainKind = equipment['main-hand'] ? items.items[equipment['main-hand']].kind : 'unarmed';
  if (actionKey === 'attack') return resolveAttackTimeline(battle, audio, recipe.attack, facing, mainKind);
  if (actionKey === 'attack-2' || actionKey === 'attack-3') {
    const step = recipe.attack.combo?.[actionKey === 'attack-2' ? 0 : 1];
    if (step) return resolveAttackTimeline(battle, audio, { ...recipe.attack, ...step }, facing, mainKind);
  }
  if ((actionKey === 'dual-attack' || actionKey === 'dual-quick-attack') && recipe.dualWieldAttack) {
    return resolveAttackTimeline(battle, audio, recipe.dualWieldAttack, facing, mainKind);
  }
  if (actionKey.startsWith('frenzy-') && recipe.frenzyAttack) {
    return resolveAttackTimeline(battle, audio, recipe.frenzyAttack, facing, mainKind);
  }
  if (actionKey.startsWith('skill-')) {
    const skillId = actionKey.slice(6);
    const override = recipe.actions[skillId];
    const base = battle.skills[skillId]?.action;
    const action = override ?? base;
    if (action) return resolveSkillTimeline(battle, audio, skillId, action, facing);
  }
  return { effects: [], markers: [], sounds: [], shakeFrames: [] };
}

export function activeEffectsAtFrame(timeline: ActionTimeline, battle: BattleCatalog, frame: number): ActiveEffectLayer[] {
  const active: ActiveEffectLayer[] = [];
  for (const cue of timeline.effects) {
    const offset = frame - cue.startFrame;
    if (offset < 0 || offset >= cue.frames) continue;
    const clip = battle.attackEffects[cue.effect]?.clips[cue.variant];
    if (!clip) continue;
    active.push({ cue, clip, effectFrame: offset });
  }
  return active;
}

export function facingVector(facing: Facing): { x: number; y: number } {
  switch (facing) {
    case 'south': return { x: 0, y: 1 };
    case 'north': return { x: 0, y: -1 };
    case 'west': return { x: -1, y: 0 };
    case 'east': return { x: 1, y: 0 };
  }
}

export function effectOverlayBounds(battle: BattleCatalog, timeline: ActionTimeline, facing: Facing,
  effectAnchor: { x: number; y: number } = { x: 0, y: -4 }): PoseBounds | null {
  if (!timeline.effects.length) return null;
  const dir = facingVector(facing);
  let left = 0, top = 0, right = 0, bottom = 0;
  let found = false;
  for (const cue of timeline.effects) {
    const clip = battle.attackEffects[cue.effect]?.clips[cue.variant];
    if (!clip) continue;
    found = true;
    const dist = cue.targetDistancePx ?? 28;
    const baseX = cue.onTarget ? dir.x * dist : 0;
    const baseY = cue.onTarget ? dir.y * dist : (cue.placement === 'attached' && cue.attachmentPoint !== 'feet' ? effectAnchor.y : 0);
    const ox = clip.originX * clip.frameWidth;
    const oy = clip.originY * clip.frameHeight;
    const minX = clip.mirrorX ? baseX - (clip.frameWidth - ox) : baseX - ox;
    const maxX = clip.mirrorX ? baseX + ox : baseX + (clip.frameWidth - ox);
    left = Math.min(left, Math.floor(minX));
    right = Math.max(right, Math.ceil(maxX));
    top = Math.min(top, Math.floor(baseY - oy));
    bottom = Math.max(bottom, Math.ceil(baseY + (clip.frameHeight - oy)));
  }
  return found ? { left, top, right, bottom } : null;
}

function stanceEquipmentMap(catalog: WardrobeCatalog, items: ItemCatalog): Map<string, EquipmentSelection> {
  const repMain = new Map<string, string | undefined>([['unarmed', undefined]]);
  for (const choice of weaponChoices(catalog, items)) if (!repMain.has(choice.kind)) repMain.set(choice.kind, choice.id);
  const repOff = new Map<string, string | undefined>([['empty', undefined]]);
  for (const choice of weaponChoices(catalog, items, true)) if (!repOff.has(choice.kind)) repOff.set(choice.kind, choice.id);

  const map = new Map<string, EquipmentSelection>();
  for (const stance of Object.keys(catalog.stances)) {
    const [m, o] = stance.split(':');
    if (!WARRIOR_MAIN_KINDS.has(m) || !WARRIOR_OFF_KINDS.has(o)) continue;
    if (!repMain.has(m) || !repOff.has(o)) continue;
    const selection: EquipmentSelection = {};
    if (repMain.get(m)) selection['main-hand'] = repMain.get(m);
    if (repOff.get(o)) selection['off-hand'] = repOff.get(o);
    map.set(stance, selection);
  }
  return map;
}

/** 狂战士在全部 27 种架势 + 主动技能 + 阵亡动作下实际会用到的全部姿态编号。 */
export function warriorPoseIds(catalog: WardrobeCatalog, items: ItemCatalog): string[] {
  const ids = new Set<string>();
  const stances = stanceEquipmentMap(catalog, items);
  for (const equipment of stances.values()) {
    for (const facing of DIRECTIONS) {
      for (const action of actionChoices(catalog, items, equipment, facing, {})) ids.add(action.poseId);
    }
  }
  return [...ids].sort();
}

export function warriorPoseMatrix(catalog: WardrobeCatalog, items: ItemCatalog, skillNames: Record<string, string>): WarriorPoseTemplate[] {
  const stances = stanceEquipmentMap(catalog, items);
  const grouped = new Map<string, {
    category: string;
    labels: Set<string>;
    stances: Set<string>;
    dirIds: Partial<Record<Facing, string>>;
    sampleEquipment: EquipmentSelection;
    sampleActionKey: string;
  }>();

  const formatStance = (stance: string) => {
    const [m, o] = stance.split(':');
    return o === 'empty' ? (KIND_LABELS[m] ?? m) : `${KIND_LABELS[m] ?? m}+${KIND_LABELS[o] ?? o}`;
  };

  for (const [stance, equipment] of stances) {
    const southActions = actionChoices(catalog, items, equipment, 'south', skillNames);
    const byFacing = Object.fromEntries(DIRECTIONS.map(facing => [
      facing,
      new Map(actionChoices(catalog, items, equipment, facing, skillNames).map(choice => [choice.key, choice.poseId])),
    ])) as Record<Facing, Map<string, string>>;

    for (const action of southActions) {
      const id = action.poseId;
      let entry = grouped.get(id);
      if (!entry) {
        entry = {
          category: action.group,
          labels: new Set(),
          stances: new Set(),
          dirIds: {
            south: byFacing.south.get(action.key),
            west: byFacing.west.get(action.key),
            north: byFacing.north.get(action.key),
            east: byFacing.east.get(action.key),
          },
          sampleEquipment: equipment,
          sampleActionKey: action.key,
        };
        grouped.set(id, entry);
      }
      entry.labels.add(action.label);
      if (action.group === '地图动作' || action.group === '阵亡动作') entry.stances.add('全武器共用');
      else entry.stances.add(formatStance(stance));
    }
  }

  const categoryOrder = ['地图动作', '基础动作', '普通攻击', '双持攻击', '狂暴攻击', '主动技能', '阵亡动作'];
  const result: WarriorPoseTemplate[] = [];
  for (const [id, entry] of grouped) {
    const southPose = catalog.poses[entry.dirIds.south!];
    const westPose = catalog.poses[entry.dirIds.west!];
    const northPose = catalog.poses[entry.dirIds.north!];
    const eastPose = catalog.poses[entry.dirIds.east!];
    if (!southPose || !westPose || !northPose || !eastPose) continue;
    const partSet = new Set<string>();
    for (const pose of [southPose, westPose, northPose, eastPose]) {
      for (const frame of pose.frames) {
        for (const p of frame) if ((WARRIOR_PARTS as readonly string[]).includes(p.part)) partSet.add(p.part);
      }
    }
    result.push({
      id,
      category: entry.category,
      labels: [...entry.labels],
      stances: entry.stances.size >= 27 ? ['全部 27 种架势'] : [...entry.stances],
      frames: {
        south: southPose.frames.length,
        west: westPose.frames.length,
        north: northPose.frames.length,
        east: eastPose.frames.length,
      },
      frameRate: southPose.frameRate,
      mirrorEast: eastPose.mirrorX,
      parts: WARRIOR_PARTS.filter(part => partSet.has(part)),
      sampleEquipment: entry.sampleEquipment,
      sampleActionKey: entry.sampleActionKey,
    });
  }
  result.sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) || a.id.localeCompare(b.id));
  return result;
}

export function warriorPartSpecs(catalog: WardrobeCatalog, items: ItemCatalog): WarriorPartSpec[] {
  const stances = stanceEquipmentMap(catalog, items);
  const combatPoseIds = new Set<string>();
  const diePoseIds = new Set<string>();
  for (const equipment of stances.values()) {
    for (const facing of DIRECTIONS) {
      for (const action of actionChoices(catalog, items, equipment, facing, {})) {
        if (action.key === 'die') diePoseIds.add(action.poseId);
        else combatPoseIds.add(action.poseId);
      }
    }
  }
  const combatIndices = new Map<string, Set<number>>();
  const dieIndices = new Map<string, Set<number>>();
  const collect = (poseIds: Set<string>, target: Map<string, Set<number>>) => {
    for (const pid of poseIds) {
      const pose = catalog.poses[pid];
      if (!pose) continue;
      for (const frame of pose.frames) for (const part of frame) {
        if (!target.has(part.part)) target.set(part.part, new Set());
        target.get(part.part)!.add(part.piece);
      }
    }
  };
  collect(combatPoseIds, combatIndices);
  collect(diePoseIds, dieIndices);

  const warriorVariants = collectWarriorVariants(catalog, items);
  return WARRIOR_PARTS.map(part => {
    const allVariants = Object.keys(catalog.variants).filter(id => id === part || id.startsWith(`${part}-style-`));
    const warriorCount = allVariants.filter(id => warriorVariants.has(id)).length;
    const defaultVariant = catalog.defaults[part] ?? allVariants.find(id => warriorVariants.has(id)) ?? allVariants[0];
    const entries = catalog.variants[defaultVariant] ?? [];
    const combatSet = combatIndices.get(part) ?? new Set<number>();
    const dieSet = dieIndices.get(part) ?? new Set<number>();
    const slices: PartSliceSpec[] = entries.map((key, index) => {
      const sprite = key ? catalog.sprites[key] : undefined;
      return {
        index,
        defaultKey: key,
        width: sprite?.width ?? 0,
        height: sprite?.height ?? 0,
        anchorX: sprite?.anchorX ?? 0,
        anchorY: sprite?.anchorY ?? 0,
        combatUsed: combatSet.has(index),
        dieUsed: dieSet.has(index),
      };
    });
    return {
      part,
      label: PART_NAMES[part] ?? part,
      slotLabel: PART_SLOT_LABELS[part] ?? part,
      sliceCount: entries.length,
      combatUsedCount: slices.filter(slice => slice.combatUsed).length,
      dieOnlyCount: slices.filter(slice => !slice.combatUsed && slice.dieUsed).length,
      warriorVariantCount: warriorCount,
      totalVariantCount: allVariants.length,
      defaultVariant,
      slices,
    };
  });
}

export function warriorSupplementalAssets(catalog: WardrobeCatalog, battle: BattleCatalog,
  storyClasses: StoryClassesLite, menuPanels: MenuPanelsLite, statusHud: StatusHudLite,
  audio: AudioCatalogLite): SupplementalAssetInventory {
  const warriorClass = battle.classes.find(entry => entry.id === 'warrior');
  const storyWarrior = storyClasses.classes.find(entry => entry.id === 'warrior');
  const identity: SupplementalAssetInventory['identity'] = [];
  if (storyWarrior?.icon) identity.push({ label: '选职业图标', file: storyWarrior.icon, usage: '开场选职业界面（story-classes.json）' });
  const classPortrait = menuPanels.character.classPortraits.warrior;
  if (classPortrait) identity.push({ label: '角色属性页职业立绘', file: classPortrait, usage: '角色属性菜单（menu-panels.json）' });
  const partyBadge = menuPanels.assets['party-class-warrior'];
  if (partyBadge) identity.push({ label: '队伍职业徽章', file: partyBadge, usage: '佣兵/队伍列表标识（menu-panels.json）' });
  const preview = menuPanels.classes.warrior?.preview ?? warriorClass?.preview;
  if (preview) identity.push({ label: '职业静态预览图', file: preview, usage: '职业预览（menu-panels.json / battle.json）' });

  const effectUsers = new Map<string, Set<string>>();
  const soundUsers = new Map<string, { category: '技能音效' | '武器攻击音效'; usedBy: Set<string> }>();
  const markEffect = (id: string, label: string) => {
    if (!battle.attackEffects[id]) return;
    if (!effectUsers.has(id)) effectUsers.set(id, new Set());
    effectUsers.get(id)!.add(label);
  };
  const markSound = (id: string, category: '技能音效' | '武器攻击音效', label: string) => {
    if (!audio.effects[id]) return;
    if (!soundUsers.has(id)) soundUsers.set(id, { category, usedBy: new Set() });
    soundUsers.get(id)!.usedBy.add(label);
  };

  const scanEffectsAndSounds = (value: unknown, label: string, soundCategory: '技能音效' | '武器攻击音效') => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) scanEffectsAndSounds(item, label, soundCategory); return; }
    const record = value as Record<string, unknown>;
    for (const field of ['effect', 'applicationEffect', 'loopEffect']) {
      if (typeof record[field] === 'string') markEffect(record[field] as string, label);
    }
    for (const field of ['swings', 'impacts']) {
      if (Array.isArray(record[field])) for (const id of record[field] as unknown[]) if (typeof id === 'string') markEffect(id, label);
    }
    if (typeof record.sound === 'string') markSound(record.sound, soundCategory, label);
    for (const child of Object.values(record)) if (child && typeof child === 'object') scanEffectsAndSounds(child, label, soundCategory);
  };

  const skills: SupplementalAssetInventory['skills'] = [];
  for (const skillId of warriorClass?.skills ?? []) {
    const skill = battle.skills[skillId];
    if (!skill) continue;
    const localEffects = new Set<string>();
    const localSounds = new Set<string>();
    const scanSkill = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) scanSkill(item); return; }
      const record = value as Record<string, unknown>;
      for (const field of ['effect', 'applicationEffect', 'loopEffect']) {
        if (typeof record[field] === 'string' && battle.attackEffects[record[field] as string]) {
          localEffects.add(record[field] as string);
          markEffect(record[field] as string, `技能：${skill.name}`);
        }
      }
      if (typeof record.sound === 'string' && audio.effects[record.sound]) {
        localSounds.add(record.sound);
        markSound(record.sound, '技能音效', `技能：${skill.name}`);
      }
      for (const child of Object.values(record)) if (child && typeof child === 'object') scanSkill(child);
    };
    scanSkill(skill);
    for (const [stance, stanceData] of Object.entries(catalog.skillStances.warrior ?? {})) {
      if (!WARRIOR_MAIN_KINDS.has(stance.split(':')[0])) continue;
      const override = stanceData.actions[skillId];
      if (override) scanSkill(override);
    }
    const mappedSound = audio.skills?.[skillId];
    if (mappedSound && audio.effects[mappedSound]) {
      localSounds.add(mappedSound);
      markSound(mappedSound, '技能音效', `技能：${skill.name}`);
    }
    skills.push({
      id: skillId,
      name: skill.name,
      kind: skill.kind,
      icon: skill.icon,
      requiredPoints: skill.requiredInvestedSkillPoints ?? 0,
      cooldownFrames: skill.action?.cooldownFrames,
      effects: [...localEffects].sort(),
      sounds: [...localSounds].sort(),
    });
  }

  for (const [stance, attack] of Object.entries(catalog.attacks)) {
    const main = stance.split(':')[0];
    if (!WARRIOR_MAIN_KINDS.has(main)) continue;
    scanEffectsAndSounds(attack, `普攻（${KIND_LABELS[main] ?? main}）`, '武器攻击音效');
  }
  for (const [stance, attack] of Object.entries(catalog.dualWieldAttacks ?? {})) {
    const main = stance.split(':')[0];
    if (!WARRIOR_MAIN_KINDS.has(main)) continue;
    scanEffectsAndSounds(attack, `双持攻击（${KIND_LABELS[main] ?? main}）`, '武器攻击音效');
  }
  for (const [stance, attack] of Object.entries(catalog.frenzyAttacks ?? {})) {
    const main = stance.split(':')[0];
    if (!WARRIOR_MAIN_KINDS.has(main)) continue;
    scanEffectsAndSounds(attack, `狂暴攻击（${KIND_LABELS[main] ?? main}）`, '武器攻击音效');
  }
  for (const kind of WARRIOR_MAIN_KINDS) {
    const entry = audio.combat?.weapons?.[kind];
    if (!entry) continue;
    for (const item of entry.normal ?? []) markSound(item.sound, '武器攻击音效', `普攻（${KIND_LABELS[kind] ?? kind}）`);
    if (entry.critical) markSound(entry.critical, '武器攻击音效', `暴击（${KIND_LABELS[kind] ?? kind}）`);
    if (entry.miss) markSound(entry.miss, '武器攻击音效', `未命中（${KIND_LABELS[kind] ?? kind}）`);
  }
  if (audio.combat?.shieldBlock) markSound(audio.combat.shieldBlock, '武器攻击音效', '盾牌格挡');

  const buffIcons = WARRIOR_EXTRA_BUFF_ICONS
    .filter(item => statusHud.buffIcons.catalog[item.id])
    .map(item => ({ ...item, file: statusHud.buffIcons.catalog[item.id]! }));

  const effects = [...effectUsers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, users]) => {
    const def = battle.attackEffects[id];
    const directions = Object.keys(def.clips);
    const sample = def.clips.south ?? def.clips.default ?? def.clips[directions[0]];
    const blends = [...new Set(sample.layers.map(layer => layer.blend === 'backdrop' ? `backdrop(${layer.operations.join('+')})` : layer.blend))];
    return {
      id,
      directions,
      frames: sample.frames,
      frameRate: sample.frameRate,
      width: sample.frameWidth,
      height: sample.frameHeight,
      layers: sample.layers.length,
      blends,
      usedBy: [...users].sort(),
      previewFile: sample.layers[0]?.file ?? '',
    };
  });

  const sounds = [...soundUsers.entries()]
    .sort(([, a], [, b]) => a.category.localeCompare(b.category))
    .map(([id, info]) => ({ id, file: audio.effects[id]!, category: info.category, usedBy: [...info.usedBy].sort() }));

  return { identity, skills, buffIcons, effects, sounds };
}

export function warriorAssetInventory(catalog: WardrobeCatalog, items: ItemCatalog, battle: BattleCatalog,
  storyClasses: StoryClassesLite, menuPanels: MenuPanelsLite, statusHud: StatusHudLite,
  audio: AudioCatalogLite): WarriorAssetInventory {
  const skillNames = Object.fromEntries(Object.entries(battle.skills).map(([id, value]) => [id, value.name]));
  return {
    stanceCount: stanceEquipmentMap(catalog, items).size,
    totalPoseFiles: warriorPoseIds(catalog, items).length,
    templates: warriorPoseMatrix(catalog, items, skillNames),
    parts: warriorPartSpecs(catalog, items),
    noVisualSlots: WARRIOR_NO_VISUAL_SLOTS,
    supplemental: warriorSupplementalAssets(catalog, battle, storyClasses, menuPanels, statusHud, audio),
  };
}

export function formatInventoryMarkdown(inventory: WarriorAssetInventory): string {
  const lines: string[] = [
    '# 狂战士完整动作与素材规格清单（新职业制作对照）',
    '',
    `- 合法武器组合：${inventory.stanceCount} 种`,
    `- 独立四向动作模板：${inventory.templates.length} 组（共 ${inventory.totalPoseFiles} 个姿态文件）`,
    `- 纸娃娃换装部位：${inventory.parts.length} 个（无外观装备槽：${inventory.noVisualSlots.map(s => s.label).join('、')}）`,
    `- 技能图标：${inventory.supplemental.skills.length} 枚（9 主动 + 6 被动）`,
    `- 状态图标：${inventory.supplemental.buffIcons.length} 枚`,
    `- 战斗与技能特效：${inventory.supplemental.effects.length} 组`,
    `- 战斗与技能音效：${inventory.supplemental.sounds.length} 个`,
    '',
    '## 一、独立动作模板表',
    '',
    '| 分类 | 动作名称 | 适用架势 | 帧数（南/西/北/东） | 帧率 | 东向镜像 | 姿态编号 | 涉及部位 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const row of inventory.templates) {
    const f = `${row.frames.south}/${row.frames.west}/${row.frames.north}/${row.frames.east}`;
    lines.push(`| ${row.category} | ${row.labels.join(' / ')} | ${row.stances.join('、')} | ${f} | ${row.frameRate.toFixed(1)} | ${row.mirrorEast ? '是' : '否'} | \`${row.id}\` | ${row.parts.map(p => PART_NAMES[p] ?? p).join('、')} |`);
  }
  lines.push('', '## 二、12 个纸娃娃换装部位规格', '',
    '| 部位 | 对应装备槽 | 单套切片数 | 战斗调用 | 仅阵亡调用 | 狂战士款式数 | 逐索引参考尺寸（默认款式） |',
    '|---|---|---|---|---|---|---|');
  for (const part of inventory.parts) {
    const sizes = part.slices.map(s => `#${s.index}:${s.width}×${s.height}${s.combatUsed ? '' : s.dieUsed ? '(仅阵亡)' : '(未用)'}`).join(' ');
    lines.push(`| ${part.label} (\`${part.part}\`) | ${part.slotLabel} | ${part.sliceCount} | ${part.combatUsedCount} | ${part.dieOnlyCount} | ${part.warriorVariantCount} / ${part.totalVariantCount} | ${sizes} |`);
  }
  lines.push('', '### 无外观切片的装备槽', '');
  for (const slot of inventory.noVisualSlots) lines.push(`- **${slot.label}** (\`${slot.slot}\`)：${slot.note}`);

  lines.push('', '## 三、职业标识与界面素材', '', '| 名称 | 文件路径 | 用途 |', '|---|---|---|');
  for (const item of inventory.supplemental.identity) lines.push(`| ${item.label} | \`${item.file}\` | ${item.usage} |`);

  lines.push('', '## 四、15 项技能与图标', '', '| 技能 | 类型 | 门槛技能点 | 冷却帧 | 图标 | 关联特效 | 关联音效 |', '|---|---|---|---|---|---|---|');
  for (const s of inventory.supplemental.skills) {
    lines.push(`| ${s.name} (\`${s.id}\`) | ${s.kind === 'active' ? '主动' : '被动'} | ${s.requiredPoints} | ${s.cooldownFrames ?? '—'} | \`${s.icon}\` | ${s.effects.join('、') || '—'} | ${s.sounds.join('、') || '—'} |`);
  }

  lines.push('', '## 五、状态（Buff）图标', '', '| 状态 | 图标路径 | 来源 |', '|---|---|---|');
  for (const b of inventory.supplemental.buffIcons) lines.push(`| ${b.label} (\`${b.id}\`) | \`${b.file}\` | ${b.source} |`);

  lines.push('', '## 六、战斗与技能特效清单', '', '| 特效编号 | 方向 | 帧数 | 尺寸 | 图层数 | 混合方式 | 关联动作 |', '|---|---|---|---|---|---|---|');
  for (const e of inventory.supplemental.effects) {
    lines.push(`| \`${e.id}\` | ${e.directions.join('/')} | ${e.frames} | ${e.width}×${e.height} | ${e.layers} | ${e.blends.join(' / ')} | ${e.usedBy.join('、')} |`);
  }

  lines.push('', '## 七、战斗与技能音效', '', '| 音效编号 | 分类 | 音频文件 | 关联动作 |', '|---|---|---|---|');
  for (const s of inventory.supplemental.sounds) lines.push(`| \`${s.id}\` | ${s.category} | \`${s.file}\` | ${s.usedBy.join('、')} |`);

  return lines.join('\n') + '\n';
}

/** 每次加载完成都返回数据，由调用方只安装仍然选中的动作。失败的请求允许重试。 */
export class PoseRepository {
  private readonly loads = new Map<string, Promise<CostumePose>>();
  readonly catalog: WardrobeCatalog;
  private readonly fetchPose: (url: string) => Promise<CostumePose>;

  constructor(catalog: WardrobeCatalog, fetchPose: (url: string) => Promise<CostumePose>) {
    this.catalog = catalog;
    this.fetchPose = fetchPose;
  }

  async get(id: string): Promise<CostumePose> {
    const existing = this.catalog.poses[id];
    if (existing) return existing;
    let pending = this.loads.get(id);
    if (!pending) {
      pending = this.fetchPose(`/${wardrobePoseFile(id)}`).then(pose => {
        if (!pose.frames.length || !(pose.frameRate > 0)) throw new Error(`动作数据无效：${id}`);
        this.catalog.poses[id] = pose;
        return pose;
      }).catch(error => { this.loads.delete(id); throw error; });
      this.loads.set(id, pending);
    }
    return pending;
  }
}

export class Playback {
  frame = 0;
  playing = true;
  speed = 1;
  private elapsed = 0;
  private count = 1;
  private rate = 1;

  configure(count: number, rate: number): void {
    this.count = count;
    this.rate = rate;
    this.frame = Math.min(this.frame, count - 1);
    this.elapsed = 0;
  }

  seek(frame: number): void {
    this.frame = Math.max(0, Math.min(this.count - 1, Math.round(frame)));
    this.playing = false;
    this.elapsed = 0;
  }

  toggle(): void { this.playing = !this.playing; this.elapsed = 0; }

  advance(delta: number): boolean {
    if (!this.playing) return false;
    this.elapsed += delta * this.speed;
    const duration = 1000 / this.rate;
    const steps = Math.floor(this.elapsed / duration);
    if (!steps) return false;
    this.elapsed -= steps * duration;
    this.frame = (this.frame + steps) % this.count;
    return true;
  }
}
