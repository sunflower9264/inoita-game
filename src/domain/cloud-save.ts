import { AUTO_SAVE_SLOT, MANUAL_SAVE_SLOT_COUNT, saveSlotLabel, type SaveSlotRef } from './save-game.ts';

/**
 * 云存档账号规则：大小写不敏感，NFKC 归一化后按码点计算长度。
 * 账号只用字母、数字、下划线和汉字；密码允许任意字符，区分大小写。
 */
const CLOUD_ACCOUNT_MIN_LENGTH = 3;
export const CLOUD_ACCOUNT_MAX_LENGTH = 24;
const CLOUD_PASSWORD_MIN_LENGTH = 6;
export const CLOUD_PASSWORD_MAX_LENGTH = 64;
const CLOUD_PASSWORD_MAX_BYTES = 512;
/** 连续输错多少次锁定，以及锁定时长。 */
export const CLOUD_LOGIN_MAX_FAILURES = 3;
export const CLOUD_LOCK_DURATION_MS = 15 * 60 * 1000;
/** 会话 token 的有效期；续期后重新计算，但不会超过会话链总上限。 */
export const CLOUD_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 剩余多少天内打开云页会触发续期。 */
export const CLOUD_SESSION_RENEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 从登录/注册/改密算起的会话链总上限；到达后必须重新登录。 */
export const CLOUD_SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** 单个云存档和单账号总量上限；前者也是服务端请求体上限。 */
export const CLOUD_SAVE_MAX_BYTES = 2 * 1024 * 1024;
export const CLOUD_ACCOUNT_SAVE_QUOTA_BYTES = 16 * 1024 * 1024;

export const CLOUD_NEW_PASSWORD_SAME_MESSAGE = '新密码不能与当前密码相同。';
export const CLOUD_PASSWORD_CHANGED_MESSAGE = '密码已修改，其他设备需要重新登录。';

const ACCOUNT_CHARACTER = /[\p{L}\p{N}_]/u;

export function normalizeCloudAccount(value: string): string {
  return value.normalize('NFKC').trim();
}

/** 输入时过滤：只保留允许的字符，并截到账号最大长度。 */
export function sanitizeCloudAccountInput(value: string): string {
  const kept = [...normalizeCloudAccount(value)].filter(character => ACCOUNT_CHARACTER.test(character)).join('');
  return kept.slice(0, CLOUD_ACCOUNT_MAX_LENGTH);
}

export function validateCloudAccount(value: string): string | undefined {
  const account = normalizeCloudAccount(value);
  const length = [...account].length;
  if (!length) return '请输入账号。';
  if (length < CLOUD_ACCOUNT_MIN_LENGTH || length > CLOUD_ACCOUNT_MAX_LENGTH)
    return `账号需为 ${CLOUD_ACCOUNT_MIN_LENGTH}–${CLOUD_ACCOUNT_MAX_LENGTH} 个字符。`;
  if (![...account].every(character => ACCOUNT_CHARACTER.test(character)))
    return '账号只能使用字母、数字、下划线或汉字。';
  return undefined;
}

export function validateCloudPassword(value: string): string | undefined {
  const length = [...value].length;
  if (length < CLOUD_PASSWORD_MIN_LENGTH || length > CLOUD_PASSWORD_MAX_LENGTH)
    return `密码需为 ${CLOUD_PASSWORD_MIN_LENGTH}–${CLOUD_PASSWORD_MAX_LENGTH} 个字符。`;
  if (new TextEncoder().encode(value).length > CLOUD_PASSWORD_MAX_BYTES) return '密码过长。';
  return undefined;
}

/** 账号判重用的稳定身份：归一化后转小写。 */
export function cloudAccountIdentity(value: string): string {
  return normalizeCloudAccount(value).toLowerCase();
}

export function cloudSaveSlotId(ref: SaveSlotRef): string {
  return ref === AUTO_SAVE_SLOT ? 'auto' : String(ref);
}

export function parseCloudSaveSlotId(value: string): SaveSlotRef | undefined {
  if (value === 'auto') return AUTO_SAVE_SLOT;
  if (!/^(?:0|[1-9][0-9]?)$/.test(value)) return undefined;
  const slot = Number(value);
  return Number.isSafeInteger(slot) && slot >= 0 && slot < MANUAL_SAVE_SLOT_COUNT ? slot : undefined;
}

/** 云端提示里用的槽位名，与存档页保持一致。 */
export function cloudSlotLabel(ref: SaveSlotRef): string {
  return saveSlotLabel(ref);
}

export function cloudLockedMessage(retryAfterSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const minutes = Math.ceil(seconds / 60);
  return `密码连续输错 ${CLOUD_LOGIN_MAX_FAILURES} 次，账号已锁定，请 ${minutes} 分钟后再试。`;
}

export function cloudWrongPasswordMessage(remainingAttempts: number): string {
  return `账号或密码错误，还可尝试 ${Math.max(0, remainingAttempts)} 次。`;
}

export function cloudWrongCurrentPasswordMessage(remainingAttempts: number): string {
  return `当前密码错误，还可尝试 ${Math.max(0, remainingAttempts)} 次。`;
}

export function cloudRateLimitedMessage(retryAfterSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const wait = seconds >= 60 ? `${Math.ceil(seconds / 60)} 分钟` : `${seconds} 秒`;
  return `操作太频繁，请 ${wait}后再试。`;
}
