#!/usr/bin/env node
/**
 * 用真实运行时回放剧情链，生成 GM 任务起点现场表。
 *
 * 用法：
 *   npm run debug-start                    重新生成 public/content/debug/start.json
 *   npm run debug-start:check              只检查现场表是否与当前内容一致
 *   node tools/debug-start/story-debug-start.ts --quest quest-10 --print
 *   node tools/debug-start/story-debug-start.ts --quest quest-10 --out /tmp/quest-10.json --write
 *
 * 游戏内容读 public/content，剧情路线、上下文、脚本草稿、源码映射和证据读本目录 data/。
 * 生成期间内容被改动会直接失败，避免写出半新半旧的现场表。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseBattle, parseCampaign, parseCharacterStats, parseCompanions, parseItemCatalog, parseMap, parseStoryClasses, parseWorld} from '../../src/application/content-validation.ts';
import {DebugTaskBuilder, digest} from './debug-solver.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const GAME = path.join(ROOT, 'public/content');
const PUBLIC = path.join(ROOT, 'public');
const WORK = path.join(here, 'data');
const OUT = path.join(GAME, 'debug/start.json');

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

const files = {
  campaign: path.join(GAME, 'campaign.json'),
  world: path.join(GAME, 'world.json'),
  items: path.join(GAME, 'items.json'),
  battle: path.join(GAME, 'battle.json'),
  stats: path.join(GAME, 'character-stats.json'),
  companions: path.join(GAME, 'companions.json'),
  storyClasses: path.join(GAME, 'story-classes.json'),
  routes: path.join(WORK, 'story-debug-routes.json'),
  contexts: path.join(WORK, 'story-debug-contexts.json'),
  scripts: path.join(WORK, 'story-scripts-draft.json'),
  sourceMap: path.join(WORK, 'source-map.json'),
  evidence: path.join(WORK, 'story-debug-evidence.json'),
  order: path.join(WORK, 'story-debug-order.json'),
};
const raw = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, read(file)]));
const campaign = parseCampaign(raw.campaign);
const world = parseWorld(raw.world);
const mapFiles = world.maps.map(reference => path.join(PUBLIC, reference.file));
const mapDocuments = mapFiles.map(read);
const maps = new Map(world.maps.map((reference, index) => [reference.id, parseMap(mapDocuments[index])]));
/** 生成前后各取一次内容指纹；另一路改动正在写内容时不能把新旧结果混进同一张表。 */
const contentFiles = [files.campaign, files.world, files.items, files.battle, files.stats, files.companions, files.storyClasses];
const contentFingerprint = () => digest([...contentFiles.map(read), ...mapFiles.map(read)]);
const contentBefore = digest([raw.campaign, raw.world, raw.items, raw.battle, raw.stats, raw.companions, raw.storyClasses, ...mapDocuments]);
const builder = await DebugTaskBuilder.create({
  content: {
    campaign, world, maps,
    items: parseItemCatalog(raw.items),
    battle: parseBattle(raw.battle),
    stats: parseCharacterStats(raw.stats),
    companions: parseCompanions(raw.companions),
    storyClasses: parseStoryClasses(raw.storyClasses),
  },
  itemsRaw: raw.items,
  routes: raw.routes,
  contexts: raw.contexts,
  draft: raw.scripts,
  sourceMap: raw.sourceMap,
});

const only = option('--quest');
const {tasks, gaps} = await builder.buildAll(only ? [only] : undefined);
const orderRows: string[] = raw.order.quests;
if (new Set(orderRows).size !== orderRows.length) throw new Error('调试任务顺序表有重复任务');
/** 调试目录按顺序表的剧情顺序显示；表里没有的新任务排在末尾并提示补表。 */
const order = new Map(orderRows.map((quest, index) => [quest, index]));
const unordered = tasks.filter(task => !order.has(task.quest)).map(task => task.quest);
if (unordered.length) console.error(`调试任务顺序表缺少：${unordered.join(', ')}；这些任务会排在末尾`);
tasks.sort((left, right) =>
  (order.get(left.quest) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.quest) ?? Number.MAX_SAFE_INTEGER));
if (contentFingerprint() !== contentBefore) {
  console.error('生成期间 public/content 发生变化，请重新运行 npm run debug-start');
  process.exit(3);
}
const byGapKind = Object.fromEntries(gaps.reduce((map, gap) => map.set(gap.kind, (map.get(gap.kind) ?? 0) + 1), new Map()));
const sources = {
  campaign: digest(raw.campaign),
  items: digest(raw.items),
  maps: digest([...maps].map(([id, map]) => [id, map])),
  routes: digest(raw.routes),
  contexts: digest(raw.contexts),
  scripts: digest(raw.scripts),
  sourceMap: digest(raw.sourceMap),
  evidence: digest(raw.evidence),
  order: digest(raw.order),
};
const generatedAt = new Date(Math.max(...Object.values(files).map(file => fs.statSync(file).mtimeMs),
  ...mapFiles.map(file => fs.statSync(file).mtimeMs))).toISOString();
const document = {
  schema: 1,
  meta: {
    generator: 'story_debug_start.ts', interpreterVersion: 3, semanticsVersion: 3,
    sourceHash: digest(sources), generatedAt, sources,
    coverage: {
      eligible: tasks.length + gaps.length, verified: tasks.length, gaps: gaps.length,
      excludedNoIntake: campaign.quests.length - tasks.length - gaps.length,
      excludedUnreachableEvents: 0, unreachableNodes: 0, byGapKind,
    },
  },
  tasks, gaps,
};
const text = JSON.stringify(document) + '\n';
const comparable = (value: any) => ({...value, meta: {...value.meta, generatedAt: ''}});

if (flag('--print')) {
  console.log(JSON.stringify({tasks, gaps}, null, 2));
} else if (flag('--gaps')) {
  console.log(JSON.stringify(gaps, null, 2));
} else if (flag('--check')) {
  if (!fs.existsSync(OUT)) {
    console.error(`现场表不存在：${path.relative(ROOT, OUT)}；运行 npm run debug-start`);
    process.exit(1);
  }
  const current = read(OUT);
  if (JSON.stringify(comparable(current)) !== JSON.stringify(comparable(document))) {
    console.error('现场表已过期：运行 npm run debug-start 重新生成');
    process.exit(1);
  }
  console.log(JSON.stringify({tasks: tasks.length, gaps: gaps.length, upToDate: true}));
} else if (flag('--write')) {
  if (gaps.length && flag('--strict')) {
    console.error(`现场表有 ${gaps.length} 个缺口，未写入`);
    process.exit(1);
  }
  const output = option('--out') ?? OUT;
  if (only && !option('--out')) {
    console.error('单任务生成必须配合 --out，避免用部分目录覆盖完整现场表');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, text);
  console.log(JSON.stringify({tasks: tasks.length, gaps: gaps.length, byGapKind}));
  console.log(`写入 ${path.relative(ROOT, output)}`);
} else {
  console.log(JSON.stringify({tasks: tasks.length, gaps: gaps.length, byGapKind}));
}
process.exit(gaps.length && flag('--strict') ? 1 : 0);
