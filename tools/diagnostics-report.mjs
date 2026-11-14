#!/usr/bin/env node
/**
 * 诊断日志查看器：把 `.diagnostics` 里的两个 JSONL 流按会话汇总。
 *
 *   npm run diag:list                 最近 20 个会话
 *   npm run diag:session -- <会话 id> 一个会话的时间线
 *   npm run diag:list -- --limit 50   指定列表数量
 *   npm run diag:list -- --dir <目录> 换一个诊断目录
 *
 * 只读文件，不修改日志；重复上传的相同 id 先按第一次出现去重。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isErrorEntry } from './diagnostic-collector.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(path.dirname(HERE), '.diagnostics');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

async function readStream(directory, base) {
  let names = [];
  try { names = await fs.readdir(directory); } catch { return []; }
  const files = names.filter(name => name === base || name.startsWith(base.replace('.jsonl', '.')))
    .sort((a, b) => b.localeCompare(a));
  const entries = [];
  for (const name of files) {
    let text = '';
    try { text = await fs.readFile(path.join(directory, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.id === 'string' && typeof entry.session === 'string') entries.push(entry);
      } catch { /* 半行或损坏的记录跳过。 */ }
    }
  }
  return entries;
}

export async function loadEntries(directory = DEFAULT_DIR) {
  const [errors, session] = await Promise.all([
    readStream(directory, 'client-errors.jsonl'),
    readStream(directory, 'client-session.jsonl'),
  ]);
  const seen = new Set();
  const entries = [];
  for (const entry of [...errors, ...session]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  entries.sort((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0)
    || (a.seq ?? 0) - (b.seq ?? 0));
  return entries;
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h${minutes}m`;
  if (minutes) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function clock(entry) {
  if (typeof entry.sinceStartMs === 'number') {
    const total = Math.round(entry.sinceStartMs / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  const date = new Date(entry.time);
  return Number.isNaN(date.getTime()) ? '?' : date.toISOString().slice(11, 19);
}

function buildText(entry) {
  const build = entry.build;
  if (!build || typeof build !== 'object') return '';
  return [build.game, build.contentVersion].filter(Boolean).join(' / ');
}

function mapOf(entry) {
  const details = entry.details && typeof entry.details === 'object' ? entry.details : {};
  return details.map ?? details.location?.map ?? entry.state?.location?.map ?? null;
}

function summarize(session, entries) {
  const first = entries[0];
  const last = entries.at(-1);
  const ended = entries.some(entry => entry.kind === 'session-end');
  const maps = new Set();
  for (const entry of entries) {
    const map = mapOf(entry);
    if (map) maps.add(map);
  }
  return {
    session,
    start: first?.time ?? null,
    end: last?.time ?? null,
    durationMs: first && last ? (Date.parse(last.time) || 0) - (Date.parse(first.time) || 0) : 0,
    entries: entries.length,
    errors: entries.filter(entry => isErrorEntry(entry) && entry.kind !== 'console-warn').length,
    warnings: entries.filter(entry => entry.kind === 'console-warn').length,
    lowFps: entries.filter(entry => entry.kind === 'performance-low-fps').length,
    maps: [...maps],
    build: first?.build ?? null,
    firstKind: first?.kind ?? null,
    lastKind: last?.kind ?? null,
    ended,
  };
}

export function groupSessions(entries) {
  const groups = new Map();
  for (const entry of entries) {
    let group = groups.get(entry.session);
    if (!group) { group = []; groups.set(entry.session, group); }
    group.push(entry);
  }
  return [...groups].map(([session, list]) => ({ ...summarize(session, list), entries: list }))
    .sort((a, b) => (Date.parse(b.start) || 0) - (Date.parse(a.start) || 0));
}

function short(value, limit = 140) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function detailLine(entry) {
  const details = entry.details && typeof entry.details === 'object' ? entry.details : {};
  switch (entry.kind) {
    case 'heartbeat': {
      const frames = entry.metrics?.frames;
      const heap = entry.metrics?.heap;
      return [`map=${details.map ?? '?'}`, `hp=${details.player?.health ?? '?'}`,
        `fps=${frames?.fps ?? '?'}/${frames?.avgFps ?? '?'}/${frames?.minFps ?? '?'}`,
        `long=${frames?.longFrames ?? '?'}`,
        `heap=${heap ? Math.round(heap.usedBytes / 1048576) : '?'}MB`,
        `locked=${details.locked ? 'yes' : 'no'}`, `quest=${details.quest ?? '-'}`].join(' ');
    }
    case 'performance-low-fps': {
      const frames = entry.metrics?.frames;
      return [`target=${details.target}`, `avg=${details.avgFps}`, `min=${details.minFps}`,
        `long=${details.longFrames}`, `p95=${details.p95FrameMs}ms`, `samples=${frames?.samples ?? '?'}`].join(' ');
    }
    case 'combat-tick':
      return [`enemies=${details.enemies}`, `party=${details.aliveParty}`,
        `hits=${details.hits}`, `dealt=${details.damageDealt}`, `taken=${details.damageTaken}`].join(' ');
    case 'combat-end':
      return [`ms=${details.durationMs}`, `hits=${details.hits}`,
        `dealt=${details.damageDealt}`, `taken=${details.damageTaken}`, `enemies=${details.enemies}`].join(' ');
    case 'window-error':
    case 'console-error':
    case 'console-warn':
    case 'unhandled-rejection':
    case 'content-load-error':
    case 'load-error':
    case 'save-error':
    case 'asset-load-error':
      return short(details.message ?? details.error?.message ?? details.reason?.message ?? details.error ?? details, 220);
    case 'session-start':
      return short({ build: entry.build, navigation: details.navigation }, 220);
    case 'session-recovered':
      return `previous=${details.previousSession} last=${details.previousKind} at=${details.previousTime}`;
    default: {
      const { state: _state, ...rest } = details;
      return short(rest, 180);
    }
  }
}

async function list(directory, limit) {
  const entries = await loadEntries(directory);
  if (!entries.length) {
    console.log(`没有诊断日志：${path.join(directory, 'client-errors.jsonl')}`);
    return;
  }
  const sessions = groupSessions(entries).slice(0, limit);
  console.log(`最近 ${sessions.length} 个会话（共 ${new Set(entries.map(entry => entry.session)).size} 个）\n`);
  for (const session of sessions) {
    const build = session.build ? [session.build.game, session.build.contentVersion].filter(Boolean).join('/') : '?';
    console.log(`${session.session}  ${session.start ?? '?'}  时长 ${duration(session.durationMs)}  ${session.ended ? '正常结束' : '未正常结束'}`);
    console.log(`  版本 ${build || '?'}  记录 ${session.entries.length}  错误 ${session.errors}  警告 ${session.warnings}  掉帧 ${session.lowFps}`);
    console.log(`  地图 ${session.maps.length ? session.maps.join(', ') : '-'}  最后 ${session.lastKind ?? '-'}`);
    console.log('');
  }
  console.log('查看单个会话：npm run diag:session -- <会话 id>');
}

async function showSession(directory, sessionId) {
  const entries = await loadEntries(directory);
  const session = entries.filter(entry => entry.session === sessionId);
  if (!session.length) {
    console.error(`找不到会话：${sessionId}`);
    process.exitCode = 1;
    return;
  }
  const summary = summarize(sessionId, session);
  console.log(`会话 ${sessionId}`);
  console.log(`开始 ${summary.start}  结束 ${summary.end ?? '-'}  时长 ${duration(summary.durationMs)}  ${summary.ended ? '正常结束' : '未正常结束'}`);
  console.log(`版本 ${buildText(session[0]) || '?'}  地图 ${summary.maps.join(', ') || '-'}`);
  console.log(`记录 ${summary.entries}  错误 ${summary.errors}  警告 ${summary.warnings}  掉帧 ${summary.lowFps}\n`);
  for (const entry of session) {
    const marker = entry.kind === 'console-warn' ? 'w' : isErrorEntry(entry) ? '!' : ' ';
    const repeats = entry.repeats ? `  (重复 ${entry.repeats} 次)` : '';
    console.log(`${marker} ${clock(entry).padStart(7)}  ${String(entry.kind).padEnd(24)} ${detailLine(entry)}${repeats}`);
  }
}

const directory = path.resolve(argument('--dir', DEFAULT_DIR));
const sessionId = argument('--session', '');
if (sessionId) await showSession(directory, sessionId);
else await list(directory, Number(argument('--limit', '20')) || 20);
