import fs from 'node:fs/promises';
import path from 'node:path';
import { contentDigest } from '../src/application/content-hash.ts';
import { compileSkillDisplay } from '../src/domain/skill-display.ts';
import { compileSkillAction } from '../src/domain/skill-action-compiler.ts';
import type { SkillAction, SkillDisplayRow, SkillRank } from '../src/domain/battle.ts';

export interface ContentBuildStats {
  files: number;
  sourceBytes: number;
  outputBytes: number;
  /** 编译过的技能 profile 数与展示行数。 */
  skillProfiles: number;
  displayRows: number;
  irSkills: number;
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
  let sourceBytes = 0, outputBytes = 0, skillProfiles = 0, displayRows = 0, irSkills = 0;
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
    const parsed: unknown = JSON.parse(text);
    let transformed: unknown = parsed;
    if (file.relative === 'battle.json') {
      const battle = parsed as BattleLike;
      for (const skill of Object.values(battle.skills ?? {})) {
        skillProfiles += compileProfile(skill);
        if (skill.companion) skillProfiles += compileProfile(skill.companion);
        displayRows += skill.display?.length ?? 0;
        if (skill.companion) displayRows += skill.companion.display?.length ?? 0;
      }
      irSkills += compilePilotActions(battle);
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
  return { files: files.length, sourceBytes, outputBytes, skillProfiles, displayRows, irSkills };
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

/** 动作 IR 试点：Warlock 的全部技能 + enemy-lunatic-djinn-1。 */
function compilePilotActions(battle: BattleLike): number {
  const pilotSkills = new Set(battle.classes?.find(character => character.id === 'warlock')?.skills ?? []);
  let count = 0;
  const compile = (action: SkillAction | null | undefined): void => {
    if (!action) return;
    Object.assign(action, compileSkillAction(action));
    count++;
  };
  for (const [id, skill] of Object.entries(battle.skills ?? {})) {
    if (!pilotSkills.has(id)) continue;
    compile(skill.action);
    compile(skill.followUpAction);
    if (skill.companion) {
      compile(skill.companion.action);
      compile(skill.companion.followUpAction);
    }
  }
  for (const enemy of battle.enemies ?? []) {
    if (enemy.id !== 'enemy-lunatic-djinn-1') continue;
    for (const skill of enemy.skills ?? []) {
      compile(skill.action);
      compile(skill.companionAction);
    }
    compile(enemy.commandAction?.action);
  }
  return count;
}
