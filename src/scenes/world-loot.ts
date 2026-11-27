import type { StoryContext } from '../application/ports.ts';
import type { MapExit } from '../domain/content.ts';
import type { DropCatalog, DropReward } from '../domain/drops.ts';
import { groundLootFor, type GroundDrop } from '../domain/ground-loot.ts';
import type { ItemCatalog } from '../domain/items.ts';
import type { NavigationWorld } from '../domain/navigation-world.ts';

export interface LootRecipientVisual {
  readonly container: { readonly active: boolean; readonly x: number; readonly y: number };
}

export type LootNavigationPort = Pick<NavigationWorld, 'terrainFree' | 'nearest'>;

export interface WorldLootHost<TVisual extends LootRecipientVisual = LootRecipientVisual> {
  readonly app: Pick<StoryContext, 'session' | 'items' | 'ui' | 'audio'>;
  readonly destroyed: boolean;
  readonly loadingWorld: boolean;
  readonly map: { readonly id: string; readonly exits: readonly MapExit[] } | undefined;
  readonly dropCatalog: DropCatalog | undefined;
  readonly navigation: LootNavigationPort | undefined;
  readonly combat: {
    collectMana(pickup: NonNullable<ItemCatalog['items'][string]['pickup']>): boolean;
    readonly controlledId: string;
    readonly controlledVisual?: TVisual;
  } | undefined;
  readonly player: TVisual | undefined;
  syncView(drops: readonly GroundDrop[]): void;
  enqueuePickup(rewards: readonly DropReward[], recipientId: string): void;
}

/** 掉落物只落在能走过去、且不压住地图进出口的位置（按 8×8 贴图盒计算）。 */
export function resolveLootLanding(
  navigation: LootNavigationPort | undefined,
  exits: readonly Pick<MapExit, 'x' | 'y' | 'width' | 'height'>[],
  x: number,
  y: number,
): { x: number; y: number } {
  if (!navigation) return { x, y };
  const point = { x, y };
  const clear = (candidate: { x: number; y: number }) =>
    !exits.some(exit =>
      candidate.x + 4 > exit.x && candidate.x - 4 < exit.x + exit.width &&
      candidate.y + 4 > exit.y && candidate.y - 4 < exit.y + exit.height);
  if (navigation.terrainFree(point) && clear(point)) return point;
  const shape = { collision: { x: -4, y: -4, width: 8, height: 8 } };
  try {
    return navigation.nearest(shape, point, undefined, [], clear);
  } catch {
    return navigation.nearest(shape, point);
  }
}

/**
 * 协调正式世界的地面掉落视图同步、自动拾取与剧情接管前的整图清理。
 */
export class WorldLootCoordinator<TVisual extends LootRecipientVisual = LootRecipientVisual> {
  private readonly host: WorldLootHost<TVisual>;
  /** 上次同步给掉落视图的 store revision。 */
  revision = -1;
  private readonly pickupRecipients = new Map<string, TVisual>();

  constructor(host: WorldLootHost<TVisual>) {
    this.host = host;
  }

  reset(): void {
    this.revision = -1;
    this.pickupRecipients.clear();
  }

  recipient(id: string): TVisual | undefined {
    return this.pickupRecipients.get(id);
  }

  landing(map: string, x: number, y: number): { x: number; y: number } {
    const current = this.host.map;
    if (!this.host.navigation || current?.id !== map) return { x, y };
    return resolveLootLanding(this.host.navigation, current.exits, x, y);
  }

  refresh(): void {
    const map = this.host.map;
    if (this.host.destroyed || !map) return;
    const store = groundLootFor(this.host.app.session);
    this.host.syncView(store.dropsOnMap(map.id));
    this.revision = store.revision;
  }

  advance(stepDelta: number): void {
    const map = this.host.map;
    if (!map) return;
    const store = groundLootFor(this.host.app.session);
    store.advance(map.id, stepDelta);
    if (store.revision !== this.revision) {
      this.revision = store.revision;
      this.host.syncView(store.dropsOnMap(map.id));
    }
  }

  /** 一份地面奖励入账；无法结算的返回 false 让掉落留在地上。 */
  receiveReward(reward: DropReward): boolean {
    const { app, combat, dropCatalog } = this.host;
    const session = app.session;
    if (reward.kind === 'money') {
      session.gainMoney(reward.amount);
      return true;
    }
    const item = app.items.items[reward.item];
    const questRemaining = item?.category === 'quest' ? session.questItemPickupRemaining(reward.item) : undefined;
    if (questRemaining !== undefined && questRemaining <= 0) {
      app.ui.showInstant('任务道具已经够了，不能再捡。');
      return false;
    }
    if (item?.pickup) {
      if (!combat) return false;
      return combat.collectMana(item.pickup);
    }
    if (reward.instance) session.bag.receiveDrop(reward.instance);
    else session.bag.add(reward.item, reward.quantity);
    if (dropCatalog?.reservedDrops?.entries.some(entry => entry.item === reward.item && entry.once)) {
      session.claimReservedDrop(reward.item);
    }
    return true;
  }

  /** 拾取只有一张共享背包：谁被操控，谁走到掉落上就捡进同一份背包。 */
  collectNearby(
    position: { x: number; y: number },
    receive: (reward: DropReward) => boolean = reward => this.receiveReward(reward),
  ): void {
    const map = this.host.map;
    if (!map) return;
    const { app, combat, player } = this.host;
    const collectorId = combat?.controlledId ?? 'player';
    const visual = combat?.controlledVisual ?? player;
    const session = app.session;
    const store = groundLootFor(session);
    const availability = `${session.bag.revision}|${session.questBook.version}|${session.storyWorld.revision}|${session.restorationVersion}|${!!combat}|${session.hasLivingMember}`;
    const picked = store.collectNearby(map.id, position.x, position.y, receive, availability);
    if (!picked.length) return;
    globalThis.storyDiagnostics?.record('pickup', {
      map: map.id,
      count: picked.length,
      items: picked.slice(0, 12).map(drop => drop.reward.kind === 'item' ? drop.reward.item : 'money'),
    }, false);
    session.questItemGenerators.collected(picked.map(drop => drop.id), session.combatTick);
    app.audio?.ui('loot');
    if (picked.some(drop => drop.reward.kind === 'item')) session.emit();
    this.host.syncView(store.dropsOnMap(map.id));
    this.revision = store.revision;
    if (visual) {
      this.pickupRecipients.set(collectorId, visual);
      this.host.enqueuePickup(
        picked.map(drop => drop.reward).filter(reward => reward.kind === 'money' || !app.items.items[reward.item].pickup),
        collectorId,
      );
    }
  }

  /** 剧情接管前的自动拾取：只收当前地图，飞行中的魔法宝石也一并结算。 */
  collectAllOnMap(receive: (reward: DropReward) => boolean = reward => this.receiveReward(reward)): void {
    const map = this.host.map;
    if (!map || this.host.loadingWorld || this.host.destroyed) return;
    const session = this.host.app.session;
    const store = groundLootFor(session);
    let picked: GroundDrop[] = [];
    session.batchNotifications(() => {
      picked = store.collectAll(map.id, receive);
      if (!picked.length) return;
      session.questItemGenerators.collected(picked.map(drop => drop.id), session.combatTick);
      session.emit();
    });
    if (picked.length) {
      this.host.syncView(store.dropsOnMap(map.id));
      this.revision = store.revision;
    }
  }
}
