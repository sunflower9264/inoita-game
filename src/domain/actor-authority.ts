import type { EntityPlacement, PlacementAuthority } from './content.ts';
import type { SceneActorState } from './scene-snapshot.ts';
import type { StoryEntityState } from './story-world.ts';

export type { PlacementAuthority };

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

type AuthoritySource = Pick<EntityPlacement, 'id' | 'authority'>;

export function placementAuthority(value: AuthoritySource | StoryEntityState | SceneActorState): PlacementAuthority {
  if (value.authority) return value.authority;
  const id = 'worldEntityId' in value && value.worldEntityId ? value.worldEntityId : value.id;
  if (id.startsWith('quest-npc-located-')) return 'registered';
  if (id.startsWith('quest-npc-')) return 'npc';
  if (id.startsWith('story-') || id.startsWith('quest-target:')) return 'story';
  return 'static';
}
