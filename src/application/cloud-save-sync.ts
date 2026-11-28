import {
  AUTO_SAVE_SLOT,
  MANUAL_SAVE_SLOT_COUNT,
  saveFormatStatus,
  readSaveRecord,
  type SaveGame,
  type SaveRawReading,
  type SaveSlotRef,
  type SaveSlots,
} from '../domain/save-game.ts';
import type { CloudSaveEntry, CloudSaveError, CloudSavePort } from './cloud-save.ts';

interface CloudSyncFailure {
  slot: SaveSlotRef;
  reason: string;
}

export interface CloudSyncResult {
  ok: boolean;
  /** 本次涉及的槽位数：备份是本机非空槽，恢复是云端槽。 */
  total: number;
  completed: number;
  failures: CloudSyncFailure[];
  /** 整批失败（列云端失败、网络中断等），没有逐槽结果时用。 */
  error?: string;
  aborted?: boolean;
  cancelled?: boolean;
}

interface CloudSaveSyncPorts<World = unknown> {
  cloud: CloudSavePort;
  saves: SaveSlots<World>;
  confirm(message: string): Promise<boolean>;
  progress?(message: string): void;
  signal?: AbortSignal;
}

function reasonOf(reading: SaveRawReading): string {
  switch (reading.kind) {
    case 'future': return '本机存档版本比当前游戏新，无法上传';
    case 'unreadable': return reading.reason;
    default: return '';
  }
}

function stopBatch(error: CloudSaveError): boolean {
  return error.code === 'network' || error.code === 'timeout' || error.code === 'aborted'
    || error.code === 'unauthorized' || error.code === 'locked' || error.code === 'rate-limited'
    || error.code === 'server' || error.code === 'unsupported' || error.code === 'storage-full';
}

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

function localRefs(): SaveSlotRef[] {
  return [AUTO_SAVE_SLOT, ...Array.from({ length: MANUAL_SAVE_SLOT_COUNT }, (_, slot) => slot)];
}

/**
 * 把本机有效存档备份到云端。先列云端判断同号槽冲突，覆盖前由 `confirm` 询问；
 * 网络/鉴权/锁定错误停止整批，单槽格式或大小错误记录后继续。
 */
export async function backupLocalSaves<World>(ports: CloudSaveSyncPorts<World>): Promise<CloudSyncResult> {
  const local: { slot: SaveSlotRef; raw: string }[] = [];
  const failures: CloudSyncFailure[] = [];
  let total = 0;
  for (const slot of localRefs()) {
    const reading = ports.saves.readRaw(slot);
    if (reading.kind === 'empty' || reading.kind === 'obsolete') continue;
    total += 1;
    if (reading.kind === 'ok') local.push({ slot, raw: reading.raw });
    else failures.push({ slot, reason: reasonOf(reading) });
  }
  if (!local.length) return { ok: failures.length === 0, total, completed: 0, failures };
  const listed = await ports.cloud.list(ports.signal);
  if (!listed.ok) return { ok: false, total, completed: 0, failures, error: listed.error.message };
  const conflicts = local.filter(item => listed.value.some(entry => entry.slot === item.slot));
  if (conflicts.length) {
    const confirmed = await ports.confirm(
      `云端已有 ${conflicts.length} 个同号存档（包括自动存档），继续会用本机存档覆盖它们。确定上传吗？`,
    );
    if (!confirmed) return { ok: false, total, completed: 0, failures, cancelled: true };
  }
  let completed = 0;
  for (const [index, item] of local.entries()) {
    if (ports.signal?.aborted) return { ok: false, total, completed, failures, aborted: true };
    ports.progress?.(`正在上传 ${index + 1}/${local.length}…`);
    let game: unknown;
    try { game = JSON.parse(item.raw); }
    catch { failures.push({ slot: item.slot, reason: '本机存档内容无效' }); continue; }
    const result = await ports.cloud.upload(item.slot, game, ports.signal);
    if (!result.ok) {
      if (result.error.code === 'aborted') return { ok: false, total, completed, failures, aborted: true };
      failures.push({ slot: item.slot, reason: result.error.message });
      if (stopBatch(result.error)) break;
      continue;
    }
    completed += 1;
  }
  return { ok: failures.length === 0, total, completed, failures };
}

/**
 * 把云端存档恢复到本机。下载前先按格式预检；本机同号非空槽覆盖前由 `confirm` 询问。
 * 逐槽下载并写入，网络/鉴权/额度错误停止；已写入的槽位保留，玩家可重试补齐。
 */
export async function restoreCloudSaves<World>(ports: CloudSaveSyncPorts<World> & {
  validate(game:SaveGame<World>,signal:AbortSignal,slot:SaveSlotRef):Promise<void>;
}): Promise<CloudSyncResult> {
  const signal=ports.signal??new AbortController().signal;
  const listed = await ports.cloud.list(ports.signal);
  if (!listed.ok) return { ok: false, total: 0, completed: 0, failures: [], error: listed.error.message };
  const entries = listed.value;
  if (!entries.length) return { ok: true, total: 0, completed: 0, failures: [] };
  const failures: CloudSyncFailure[] = [];
  const candidates: CloudSaveEntry[] = [];
  for (const entry of entries) {
    const status = saveFormatStatus(entry.format);
    if (status === 'future') {
      failures.push({ slot: entry.slot, reason: '云端存档版本比当前游戏新，请先更新游戏' });
      continue;
    }
    if (status === 'obsolete') {
      failures.push({ slot: entry.slot, reason: '云端存档版本过旧，无法恢复' });
      continue;
    }
    if (status === 'unknown') {
      failures.push({ slot: entry.slot, reason: '云端存档版本无效' });
      continue;
    }
    candidates.push(entry);
  }
  if (!candidates.length) return { ok: false, total: entries.length, completed: 0, failures };
  const conflicts = candidates.filter(entry => ports.saves.readRaw(entry.slot).kind !== 'empty');
  if (conflicts.length) {
    const confirmed = await ports.confirm(
      `本机有 ${conflicts.length} 个同号存档（包括自动存档），继续会用云端存档覆盖，覆盖后本机原内容无法恢复。`,
    );
    if (!confirmed) return { ok: false, total: entries.length, completed: 0, failures, cancelled: true };
  }
  let completed = 0;
  for (const [index, entry] of candidates.entries()) {
    if (ports.signal?.aborted) return { ok: false, total: entries.length, completed, failures, aborted: true };
    ports.progress?.(`正在下载 ${index + 1}/${candidates.length}…`);
    const result = await ports.cloud.download(entry.slot, ports.signal);
    if (!result.ok) {
      if (result.error.code === 'aborted') return { ok: false, total: entries.length, completed, failures, aborted: true };
      failures.push({ slot: entry.slot, reason: result.error.message });
      if (stopBatch(result.error)) break;
      continue;
    }
    try {
      signal.throwIfAborted();
      const reading=readSaveRecord<World>(result.value);
      if(reading.kind!=='ok')throw new Error(reading.reason);
      await ports.validate(reading.game,signal,entry.slot);
      signal.throwIfAborted();
      ports.saves.writeRaw(entry.slot, JSON.stringify(reading.game));
      await ports.saves.flush?.(entry.slot);
      completed += 1;
    } catch (error) {
      if(signal.aborted)return {ok:false,total:entries.length,completed,failures,aborted:true};
      failures.push({ slot: entry.slot, reason: error instanceof Error ? error.message : '本机存档写入失败' });
      if (isQuotaError(error)) break;
    }
  }
  return { ok: failures.length === 0, total: entries.length, completed, failures };
}
