import type { PlacementAuthority } from './content.ts';

/** 判断投放来源所需的最小结构；由世界实体、静态摆放与场景演员共用。 */
export interface PlacementAuthoritySource {
  readonly id: string;
  readonly authority?: PlacementAuthority;
  readonly worldEntityId?: string;
}

/**
 * 一个可见对象是谁放下的，而不是它叫什么。
 *
 * - `registered`：剧情位置登记，代表这个角色在这张图上的正式副本；
 * - `npc`：任务摆放的普通 NPC；
 * - `story`：演出临时创建或迁移到别处的过场实例；
 * - `static`：地图自带对象。
 *
 * 旧内容没有写这个字段；读取时按 ID 解码一次，之后都读字段。
 */
export function placementAuthority(value: PlacementAuthoritySource): PlacementAuthority {
  if (value.authority) return value.authority;
  const id = value.worldEntityId || value.id;
  if (id.startsWith('quest-npc-located-')) return 'registered';
  if (id.startsWith('quest-npc-')) return 'npc';
  if (id.startsWith('story-') || id.startsWith('quest-target:')) return 'story';
  return 'static';
}
