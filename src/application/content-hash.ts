import {createHash} from 'node:crypto';

/** 内容摘要取 SHA-256 十六进制的前 16 位；够区分构建产物，又比整串短。 */
const CONTENT_HASH_LENGTH = 16;

/** 与生成器和构建期校验共用的稳定序列化：键排序、无空白。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 内容哈希只用于判断「产物是否对应当前输入」，不参与游戏逻辑。 */
export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, CONTENT_HASH_LENGTH);
}
