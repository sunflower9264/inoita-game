import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { STORY_POSE_NAMES } from '../src/domain/content.ts';
import { contentDigest } from '../src/application/content-hash.ts';
import { compileSkillDisplay } from '../src/domain/skill-display.ts';
import { compileSkillAction } from '../src/domain/skill-action-compiler.ts';
import { wardrobePoseRelativeFile, type WardrobeCatalog } from '../src/domain/wardrobe.ts';
import type { SkillAction, SkillDisplayRow, SkillRank } from '../src/domain/battle.ts';

export interface ContentBuildStats {
  files: number;
  sourceBytes: number;
  outputBytes: number;
  /** 编译过的技能 profile 数与展示行数。 */
  skillProfiles: number;
  displayRows: number;
  irSkills: number;
  wardrobePoses: number;
  /** 被合并到同一贴图键的动画图层数。 */
  dedupedLayers: number;
  /** battle/world 里动画贴图键的数量变化。 */
  clipKeysBefore: number;
  clipKeysAfter: number;
}

interface SourceFile {
  relative: string;
  absolute: string;
}

interface SkillProfileLike {
  ranks?: SkillRank[];
  display?: SkillDisplayRow[];
  action?: SkillAction | null;
  followUpAction?: SkillAction;
  companion?: SkillProfileLike;
}

interface EnemySkillLike {
  action?: SkillAction;
  companionAction?: SkillAction;
}

interface BattleLike {
  classes?: { id: string; skills: string[] }[];
  skills?: Record<string, SkillProfileLike>;
  enemies?: { id: string; skills?: EnemySkillLike[]; commandAction?: EnemySkillLike }[];
}

interface ClipLayerLike { key: string; file: string; [field: string]: unknown }
interface ClipLike {
  frameWidth: number; frameHeight: number; frames: number; frameRate: number;
  layers: ClipLayerLike[]; [field: string]: unknown;
}
interface ClipRecord { clip: ClipLike; name: string; layer: ClipLayerLike }
interface ClipDedupe {
  docs: Map<string, unknown>;
  canonical: Map<string, { key: string; file: string }>;
  hashes: Map<string, string>;
  dedupedLayers: number;
  clipKeysBefore: number;
  clipKeysAfter: number;
}

/** 和 `setCharacterClip` 的 `single` 判定保持一致；特效动画本身不注册 repeat。 */
function singleClip(name: string): boolean {
  return name.startsWith('attack-') || name.startsWith('skill-') || name.startsWith('die-')
    || STORY_POSE_NAMES.some(pose => name.startsWith(`${pose}-`));
}

function walkClips(value: unknown, visit: (clip: ClipLike, name: string) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) walkClips(item, visit); return; }
  const record = value as Record<string, unknown>;
  if (record.clips && typeof record.clips === 'object' && !Array.isArray(record.clips)) {
    for (const [name, clip] of Object.entries(record.clips as Record<string, unknown>)) {
      if (clip && typeof clip === 'object' && Array.isArray((clip as ClipLike).layers)) visit(clip as ClipLike, name);
    }
  }
  for (const child of Object.values(record)) walkClips(child, visit);
}

/**
 * 动画图层的贴图按内容寻址合并：文件字节、帧尺寸、帧数、帧率和循环类型都一样时，
 * 多个方向/多个角色共用同一个纹理键。运行时 Phaser 只解码、上传一份；`mirrorX`
 * 仍留在各自的 clip 上，翻转逻辑不变。
 *
 * 只处理 battle.json / world.json 的 `clips`，因为地图 JSON 用 prop 键、不在 debug
 * 来源哈希里；这两份文件不在调试现场表的来源哈希中，合并不会让现场表过期。
 */
async function dedupeClipLayers(sourceDir: string, files: SourceFile[]): Promise<ClipDedupe> {
  const docs = new Map<string, unknown>();
  for (const relative of ['battle.json', 'world.json']) {
    const source = files.find(file => file.relative === relative);
    if (source) docs.set(relative, JSON.parse(await fs.readFile(source.absolute, 'utf8')));
  }
  const records: ClipRecord[] = [];
  for (const document of docs.values()) {
    walkClips(document, (clip, name) => {
      for (const layer of clip.layers) if (layer.file) records.push({ clip, name, layer });
    });
  }
  const hashes = new Map<string, string>();
  const assetRoot = path.resolve(sourceDir, '..');
  const hashFile = async (file: string): Promise<string | undefined> => {
    const cached = hashes.get(file);
    if (cached !== undefined) return cached || undefined;
    if (!file.startsWith('assets/')) return undefined;
    try {
      const bytes = await fs.readFile(path.join(assetRoot, file));
      const hash = createHash('sha256').update(bytes).digest('hex');
      hashes.set(file, hash);
      return hash;
    } catch {
      hashes.set(file, '');
      return undefined;
    }
  };
  const groups = new Map<string, ClipLayerLike[]>();
  for (const record of records) {
    const hash = await hashFile(record.layer.file);
    if (!hash) continue;
    const kind = record.layer.file.split('/')[1] ?? '';
    const group = [hash, record.clip.frameWidth, record.clip.frameHeight, record.clip.frames,
      record.clip.frameRate, singleClip(record.name) ? 'single' : 'loop', kind].join('|');
    const entries = groups.get(group);
    if (entries) entries.push(record.layer); else groups.set(group, [record.layer]);
  }
  let clipKeysBefore = 0, clipKeysAfter = 0;
  const before = new Set<string>(), after = new Set<string>();
  const canonical = new Map<string, { key: string; file: string }>();
  const keyOwners = new Map<string, string>();
  for (const [group, entries] of groups) {
    const ordered = [...entries].sort((a, b) => a.file.localeCompare(b.file) || a.key.localeCompare(b.key));
    const chosen = { key: ordered[0]!.key, file: ordered[0]!.file };
    const owner = keyOwners.get(chosen.key);
    if (owner && owner !== group) throw new Error(`贴图键指向不同资源：${chosen.key}`);
    keyOwners.set(chosen.key, group);
    canonical.set(group, chosen);
  }
  let dedupedLayers = 0;
  for (const record of records) {
    before.add(record.layer.key);
    const hash = hashes.get(record.layer.file);
    if (!hash) { after.add(record.layer.key); continue; }
    const kind = record.layer.file.split('/')[1] ?? '';
    const group = [hash, record.clip.frameWidth, record.clip.frameHeight, record.clip.frames,
      record.clip.frameRate, singleClip(record.name) ? 'single' : 'loop', kind].join('|');
    const chosen = canonical.get(group);
    if (!chosen) { after.add(record.layer.key); continue; }
    if (record.layer.key !== chosen.key || record.layer.file !== chosen.file) dedupedLayers++;
    record.layer.key = chosen.key;
    record.layer.file = chosen.file;
    after.add(record.layer.key);
  }
  clipKeysBefore = before.size;
  clipKeysAfter = after.size;
  return { docs, canonical, hashes, dedupedLayers, clipKeysBefore, clipKeysAfter };
}

async function filesUnder(directory: string, relative = ''): Promise<SourceFile[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: SourceFile[] = [];
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(childAbsolute, childRelative));
    else if (entry.isFile()) result.push({ relative: childRelative, absolute: childAbsolute });
  }
  return result;
}

/**
 * 构建期把 public/content 转成运行时内容目录。
 *
 * - 所有 JSON minify；
 * - battle.json 的每个技能（hero + companion）把 details 编译成
 *   display（模板） + 每级 displayValues（数值），并删除重复的格式化字符串；
 * - 所有变换都必须通过 compileSkillDisplay 的逐字还原检查。
 */
export async function buildContent(sourceDir: string, outputDir: string): Promise<ContentBuildStats> {
  const files = await filesUnder(sourceDir);
  const dedupe = await dedupeClipLayers(sourceDir, files);
  let sourceBytes = 0, outputBytes = 0, skillProfiles = 0, displayRows = 0, irSkills = 0, wardrobePoses = 0;
  for (const file of files) {
    const target = path.join(outputDir, file.relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (!file.relative.endsWith('.json')) {
      const bytes = await fs.readFile(file.absolute);
      await fs.writeFile(target, bytes);
      sourceBytes += bytes.byteLength;
      outputBytes += bytes.byteLength;
      continue;
    }
    const text = await fs.readFile(file.absolute, 'utf8');
    const parsed: unknown = dedupe.docs.get(file.relative) ?? JSON.parse(text);
    let transformed: unknown = parsed;
    if (file.relative === 'battle.json') {
      const battle = parsed as BattleLike;
      for (const skill of Object.values(battle.skills ?? {})) {
        skillProfiles += compileProfile(skill);
        if (skill.companion) skillProfiles += compileProfile(skill.companion);
        displayRows += skill.display?.length ?? 0;
        if (skill.companion) displayRows += skill.companion.display?.length ?? 0;
      }
      irSkills += compileActions(battle);
    } else if (file.relative === 'shops.json') {
      // shops 的装备表约 1.2 MB，独立成文件；运行时第一次打开商店再取。
      const shops = parsed as { equipment?: Record<string, Record<string, unknown>> };
      const equipment = Object.fromEntries(Object.entries(shops.equipment ?? {}).map(([id, entry]) => {
        // variants 与 character-stats.gradeVariants 重复；运行时由 stats 派生。
        const { variants: _variants, ...rest } = entry;
        return [id, rest];
      }));
      // 保留空对象，信任路径的 ContentLoader 不跑 parseShops，仍需能读 equipment。
      shops.equipment = {};
      transformed = shops;
      const equipmentText = JSON.stringify({ equipment });
      const equipmentTarget = path.join(path.dirname(target), 'shops-equipment.json');
      await fs.writeFile(equipmentTarget, equipmentText);
      outputBytes += Buffer.byteLength(equipmentText);
    } else if (file.relative === 'wardrobe.json') {
      // 人物动作约 3.9 MB，却只有当前武器/职业用到的十几条会被合成。
      // 逐条拆文件，运行时按 recipe 取；索引留给 dev/GM 的完整校验。
      const wardrobe = parsed as WardrobeCatalog;
      const poses = wardrobe.poses ?? {};
      const ids = Object.keys(poses);
      wardrobe.poses = {};
      transformed = wardrobe;
      for (const id of ids) {
        const text = JSON.stringify(poses[id]);
        const poseTarget = path.join(outputDir, wardrobePoseRelativeFile(id));
        await fs.mkdir(path.dirname(poseTarget), { recursive: true });
        await fs.writeFile(poseTarget, text);
        outputBytes += Buffer.byteLength(text);
      }
      const indexText = JSON.stringify(ids);
      await fs.writeFile(path.join(path.dirname(target), 'wardrobe', 'pose-index.json'), indexText);
      outputBytes += Buffer.byteLength(indexText);
      wardrobePoses = ids.length;
    } else {
      // 防止 minify 改动数值/键/结构：解析后的 canonical 内容必须一致。
      const minified = JSON.stringify(parsed);
      if (contentDigest(JSON.parse(minified)) !== contentDigest(parsed))
        throw new Error(`内容压缩后语义不一致：${file.relative}`);
    }
    const minified = JSON.stringify(transformed);
    await fs.writeFile(target, minified);
    sourceBytes += Buffer.byteLength(text);
    outputBytes += Buffer.byteLength(minified);
  }
  return { files: files.length, sourceBytes, outputBytes, skillProfiles, displayRows, irSkills, wardrobePoses,
    dedupedLayers: dedupe.dedupedLayers, clipKeysBefore: dedupe.clipKeysBefore, clipKeysAfter: dedupe.clipKeysAfter };
}

/** 返回编译过的 profile 数（1 = 本体，companion 另算）。 */
function compileProfile(skill: SkillProfileLike): number {
  if (!skill.ranks?.length) return 0;
  const { display, displayValues } = compileSkillDisplay(skill.ranks);
  skill.display = display;
  skill.ranks.forEach((rank, index) => {
    rank.displayValues = displayValues[index]!;
    delete rank.details;
  });
  return 1;
}

/**
 * 动作 IR：把全部技能与敌人的派生字段（目标需求、效果/音效/召唤名、事件帧索引）
 * 提前算进内容。战斗运行时优先读这些字段，旧内容没有时仍按原逻辑计算。
 */
function compileActions(battle: BattleLike): number {
  let count = 0;
  const compile = (action: SkillAction | null | undefined): void => {
    if (!action) return;
    Object.assign(action, compileSkillAction(action));
    count++;
  };
  for (const skill of Object.values(battle.skills ?? {})) {
    compile(skill.action);
    compile(skill.followUpAction);
    if (skill.companion) {
      compile(skill.companion.action);
      compile(skill.companion.followUpAction);
    }
  }
  for (const enemy of battle.enemies ?? []) {
    for (const skill of enemy.skills ?? []) {
      compile(skill.action);
      compile(skill.companionAction);
    }
    compile(enemy.commandAction?.action);
    compile(enemy.commandAction?.companionAction);
  }
  return count;
}
