import { BODY_ADJACENT_GAP, nearInteractable, nearInteractive, SHOP_COUNTER_GAP } from './chests.ts';
import type { ActorDefinition, EntityPlacement } from './content.ts';
import type { Session } from './session.ts';

type InteractionService = NonNullable<ActorDefinition['service']>;

/** 交互决策的结果；场景按 kind 执行对应表现或面板。 */
type InteractionAction =
  | { kind: 'chest' }
  | { kind: 'spring' }
  | { kind: 'crafting' }
  | { kind: 'soul-healer' }
  | { kind: 'legendary-sword' }
  | { kind: 'innkeeper' }
  | { kind: 'shop' }
  | { kind: 'story' };

/** 场景对“附近目标”的只读描述；判定顺序按原版，不由调用方拼 switch。 */
export interface InteractionTarget {
  chest: boolean;
  spring: boolean;
  service?: InteractionService;
  /** 目标实体是否带任务目标（objective）；有任务目标时商店让位给剧情。 */
  objective: boolean;
  /** 该 NPC 当前是否占用了任务槽（可接/可交）。 */
  questSlot: boolean;
  /** 附近目标是否有对应商店。 */
  shop: boolean;
}

/**
 * 纯决策：宝箱 → 泉水 → 任务槽 → NPC 服务 → 商店 → 普通剧情。
 * 场景只负责把附近对象翻译成这些布尔值，并按返回的动作执行。
 */
export function resolveInteraction(target: InteractionTarget): InteractionAction {
  if (target.chest) return { kind: 'chest' };
  if (target.spring) return { kind: 'spring' };
  // 原版先取 NPC 任务槽，再执行 NPC 功能分支；任务槽优先于融合机/治疗/古剑/旅店。
  if (target.service && target.questSlot) return { kind: 'story' };
  if (target.service === 'fusion-machine') return { kind: 'crafting' };
  if (target.service === 'soul-healer') return { kind: 'soul-healer' };
  if (target.service === 'legendary-sword') return { kind: 'legendary-sword' };
  if (target.service === 'innkeeper') return { kind: 'innkeeper' };
  if (target.shop && !target.objective && !target.questSlot) return { kind: 'shop' };
  return { kind: 'story' };
}

export type InteractionSessionReader = Pick<Session, 'npcQuestSlot' | 'canInteract' | 'status' | 'markerActor'> & {
  hasNearEvent?(entity: Pick<EntityPlacement, 'id' | 'actor' | 'characterId'>, mapId?: string): boolean;
};

export interface InteractionSceneCandidate {
  entity: Pick<EntityPlacement, 'id' | 'actor' | 'characterId' | 'spring' | 'hint' | 'objective' | 'flip'>;
  actor: Pick<ActorDefinition, 'service' | 'chest' | 'description' | 'collision'>;
  container: { x: number; y: number; visible: boolean };
}

/**
 * 正式世界「够得着」的距离规则：
 * 宝箱与传说古剑按原版身边曼哈顿 24 px；商店与旅店可隔柜台（32 px）；其余人物与机关仅贴身一格（8 px）。
 */
export function withinInteractionRange(
  from: { x: number; y: number },
  target: { x: number; y: number },
  actor: Pick<ActorDefinition, 'chest' | 'service' | 'collision'>,
  flip = false,
  hasShop = false,
): boolean {
  const sword = actor.service === 'legendary-sword';
  if (actor.chest || sword) return nearInteractable(from, target);
  const gap = hasShop || actor.service === 'innkeeper' ? SHOP_COUNTER_GAP : BODY_ADJACENT_GAP;
  return nearInteractive(from, target, actor.collision, flip, gap);
}

/**
 * 交互候选优先级档位（距离相同时比较）：
 * 0 = 当前交互会推进任务目标或交付已就绪任务；
 * 1 = 头顶有任务标记（如可接取或进行中提示）；
 * 2 = 商店、服务、宝箱、泉水、描述或提示等普通可交互对象；
 * null = 当前不可选中交互。
 */
export function interactionCandidateRank(
  entity: Pick<EntityPlacement, 'id' | 'actor' | 'characterId' | 'spring' | 'hint' | 'objective'>,
  actor: Pick<ActorDefinition, 'service' | 'chest' | 'description'>,
  session: InteractionSessionReader,
  hasShop = false,
  mapId?: string,
): 0 | 1 | 2 | null {
  const slot = session.npcQuestSlot(entity.actor, entity.characterId);
  if (session.canInteract(entity.actor, entity.id, entity.characterId) || (slot && session.status(slot.id) === 'ready')) {
    return 0;
  }
  if (session.markerActor(entity.actor, entity.characterId) || session.hasNearEvent?.(entity, mapId)) return 1;
  if (actor.service || actor.chest || entity.spring || actor.description || entity.hint || entity.objective || hasShop) {
    return 2;
  }
  return null;
}

/**
 * 从候选对象中挑出正式游戏按交互键会选中的唯一目标：
 * 先按曼哈顿距离挑最近，距离相同时按 0 < 1 < 2 档位比较，仍相同时保持在场顺序。
 */
export function pickNearestInteractionTarget<C extends InteractionSceneCandidate>(
  from: { x: number; y: number },
  candidates: Iterable<C>,
  session: InteractionSessionReader,
  options?: {
    hasShop?: (actorId: string) => boolean;
    isUnavailable?: (candidate: C) => boolean;
    mapId?: string;
  },
): C | null {
  let nearest: C | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestRank = 3;
  for (const candidate of candidates) {
    if (!candidate.container.visible) continue;
    if (options?.isUnavailable?.(candidate)) continue;
    const hasShop = options?.hasShop?.(candidate.entity.actor) ?? false;
    if (!withinInteractionRange(from, candidate.container, candidate.actor, !!candidate.entity.flip, hasShop)) continue;
    const rank = interactionCandidateRank(candidate.entity, candidate.actor, session, hasShop, options?.mapId);
    if (rank === null) continue;
    const d = Math.abs(candidate.container.x - from.x) + Math.abs(candidate.container.y - from.y);
    if (d < bestDistance || (d === bestDistance && rank < bestRank)) {
      bestDistance = d;
      nearest = candidate;
      bestRank = rank;
    }
  }
  return nearest;
}
