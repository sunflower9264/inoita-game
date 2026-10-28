const HASH_MULTIPLIER = 31;

/** 用 id 生成稳定的无符号种子；同一个 id 在寻路、战斗等任何地方都得到同一个值。 */
export function stableSeed(id: string): number {
  let hash = 0;
  for (const character of id) hash = (hash * HASH_MULTIPLIER + character.charCodeAt(0)) >>> 0;
  return hash;
}
