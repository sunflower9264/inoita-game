/**
 * 从正式剧情内容生成调试跳转用的游玩顺序。
 *
 * `public/content/campaign.json` 里的 `storyProgression` 是派生产物：任务接取／交付、
 * 事件顺序、选项和地图都从 `scripts`、`events`、`quests` 推导，手工修改会在下次
 * `npm run validate:content` 时被检查出来。正式游玩不读取这份数据，只有 GM 跳转使用。
 *
 * 用法：
 *   node tools/story-progression.ts            重新生成并写入 campaign.json
 *   node tools/story-progression.ts --check    只核对，不写文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Campaign, StoryProgressionStep } from '../src/domain/campaign.ts';
import { deriveStoryProgression, type StoryProgression } from '../src/domain/story-progression.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const campaignPath = path.join(root, 'public/content/campaign.json');
const KEY_ORDER: (keyof StoryProgressionStep)[] = ['event', 'script', 'accept', 'ready', 'deliver', 'choices', 'map', 'resumeAfterStage'];

function stepText(step: StoryProgressionStep): string {
  const parts: string[] = [];
  for (const key of KEY_ORDER) {
    if (step[key] === undefined) continue;
    parts.push(JSON.stringify(key) + ': ' + JSON.stringify(step[key]));
  }
  return '{' + parts.join(', ') + '}';
}

function progressionText(progression: StoryProgression, questOrder: Map<string, number>): string {
  const ongoing = [...progression.ongoing].sort((a, b) => (questOrder.get(a) ?? 0) - (questOrder.get(b) ?? 0));
  const lines: string[] = [];
  lines.push('  "storyProgression": {');
  lines.push('    "ongoing": ' + JSON.stringify(ongoing) + ',');
  lines.push('    "steps": [');
  progression.steps.forEach((step, index) => {
    lines.push('      ' + stepText(step) + (index + 1 < progression.steps.length ? ',' : ''));
  });
  lines.push('    ]');
  lines.push('  }');
  return lines.join('\n');
}

/** 只替换顶层 `storyProgression` 属性，保留 campaign.json 其余部分的原始排版。 */
function spliceCampaign(raw: string, replacement: string): string {
  const marker = '\n  "storyProgression": {';
  const start = raw.indexOf(marker);
  if (start < 0) throw new Error('campaign.json 缺少 storyProgression');
  const brace = start + marker.length - 1;
  let depth = 0, inString = false, escape = false, end = -1;
  for (let index = brace; index < raw.length; index++) {
    const char = raw[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') { depth--; if (depth === 0) { end = index; break; } }
  }
  if (end < 0) throw new Error('campaign.json 的 storyProgression 没有闭合');
  return raw.slice(0, start + 1) + replacement + raw.slice(end + 1);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, sortKeys(record[key])]));
  }
  return value;
}

function sameProgression(left: StoryProgression, right: StoryProgression | undefined): boolean {
  if (!right) return false;
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
}

function firstDifference(actual: StoryProgression, expected: StoryProgression): string {
  if (actual.steps.length !== expected.steps.length)
    return `步数不同：生成 ${actual.steps.length}，文件 ${expected.steps.length}`;
  for (let index = 0; index < actual.steps.length; index++) {
    const a = JSON.stringify(sortKeys(actual.steps[index]));
    const b = JSON.stringify(sortKeys(expected.steps[index]));
    if (a !== b) return `第 ${index} 步不同：生成 ${a}，文件 ${b}`;
  }
  return `ongoing 不同：生成 ${JSON.stringify(actual.ongoing)}，文件 ${JSON.stringify(expected.ongoing)}`;
}

export function buildStoryProgression(campaign: Campaign): StoryProgression {
  return deriveStoryProgression(campaign);
}

export function checkStoryProgression(raw: string): StoryProgression {
  const campaign = JSON.parse(raw) as Campaign;
  const derived = deriveStoryProgression(campaign);
  if (!sameProgression(derived, campaign.storyProgression))
    throw new Error('storyProgression 已过期；运行 npm run generate:story-progression 重新生成。'
      + (campaign.storyProgression ? '\n' + firstDifference(derived, campaign.storyProgression) : ''));
  return derived;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raw = fs.readFileSync(campaignPath, 'utf8');
  const campaign = JSON.parse(raw) as Campaign;
  if (process.argv.includes('--check')) {
    try {
      const derived = checkStoryProgression(raw);
      console.log(`storyProgression 已是最新：${derived.steps.length} 步。`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
    const derived = deriveStoryProgression(campaign);
    const questOrder = new Map(campaign.quests.map((quest, index) => [quest.id, index]));
    const output = spliceCampaign(raw, progressionText(derived, questOrder));
    JSON.parse(output);
    fs.writeFileSync(campaignPath, output);
    console.log(`已生成 storyProgression：${derived.steps.length} 步。`);
  }
}
