import type { Bag } from './bag.ts';
import type { BattleCharacter, CharacterStatsCatalog } from './character-stats.ts';
import type { ChestVisits } from './chests.ts';
import { settleCombatRewards, type CombatRewardInput, type CombatRewardSettlement } from './combat-rewards.ts';
import type { CampaignEnemyPlacement, ChestKind, EnemySpawn, MapExit, WorldMap } from './content.ts';
import { rollChestLoot, type DropCatalog, type DropReward, type QuestDropRequirement } from './drops.ts';
import type { GroundLootStore } from './ground-loot.ts';
import type { LootPity } from './loot-pity.ts';
import type { PartyRoster } from './party.ts';
import type { EnemyState, SessionEnemyStore } from './session-enemies.ts';
import type { AtomicFrame, AtomicSubsystem } from './session-story-commands.ts';
import type { StoryWorldState } from './story-world.ts';

/** 落位修正需要的边界信息；调用方持有完整地图时直接传地图对象。 */
export type MapBoundary = Pick<WorldMap, 'width' | 'height'> & { exits?: readonly MapExit[] };

export interface EnemyDefeatInput extends Pick<
  CombatRewardInput,
  'enemy' | 'map' | 'x' | 'y' | 'lootLevel' | 'enemyLevel' | 'elite' | 'earnsExperience' | 'pressureMode' | 'drops' | 'stats' | 'random'
> {
  key: string;
  spawn?: EnemySpawn | CampaignEnemyPlacement;
  /** 地图适配器提供的纯落点计算。 */
  landing(x: number, y: number): { x: number; y: number };
}

export interface EnemyDefeatResult {
  settlement: CombatRewardSettlement;
  levelledIds: string[];
  notify(): void;
}

/** 越界坐标落到出口格或地图中心：原版 SAVE_ReviseCharacterLocation 的判据与兜底（findings 175）。 */
export function reviseOutOfBoundsLocation(storyWorld: StoryWorldState, map: string, boundary: MapBoundary): void {
  const location = storyWorld.currentLocation;
  if (!location || location.map !== map) return;
  if (location.x >= 1 && location.y >= 1 && location.x < boundary.width && location.y < boundary.height) return;
  // 原版随机取一条出口记录；这里固定取第一条，保证验收可复现（偏离记在 findings 175）。
  const exit = (boundary.exits ?? [])[0];
  // 出口记录给的是格子左上角，角色的脚点应落在格子中心（tileSize 16 的一半）。
  const exitTileCenterOffsetPx = 8;
  const fixed = exit
    ? { x: exit.x + exitTileCenterOffsetPx, y: exit.y + exitTileCenterOffsetPx }
    : { x: Math.floor(boundary.width / 2), y: Math.floor(boundary.height / 2) };
  storyWorld.apply({ kind: 'travel', destination: { ...location, ...fixed } });
}

export function placeSessionGroundRewards(
  host: {
    bag: Bag;
    groundLoot: GroundLootStore;
    atomic<T>(operation: () => T, touched: readonly AtomicSubsystem[]): T;
    readonly currentAtomicFrame: AtomicFrame | undefined;
  },
  map: string,
  x: number,
  y: number,
  rewards: readonly DropReward[],
): void {
  if (!rewards.length) return;
  host.atomic(() => {
    const store = host.groundLoot, frame = host.currentAtomicFrame!;
    if (!frame.touched.has('groundLoot')) {
      const maps = frame.groundMaps ??= new Map();
      if (!maps.has(map)) maps.set(map, store.checkpointMap(map));
    }
    const prepared = rewards.map(reward => {
      if (reward.kind !== 'item' || reward.instance) return reward;
      if (host.bag.catalog.items[reward.item].stackable && reward.lootLevel === undefined) return reward;
      const instance = host.bag.prepareDrop(reward.item, {
        ...(reward.roll ? { grade: reward.roll, sockets: reward.roll.sockets } : {}),
        lootLevel: reward.lootLevel,
      });
      return { ...reward, instance };
    });
    store.add(map, x, y, prepared);
  }, ['bag']);
}

export function openSessionChest(
  host: {
    chests: ChestVisits;
    lootPity: LootPity;
    hero?: BattleCharacter;
    party?: PartyRoster;
    storyWorld: StoryWorldState;
    atomic<T>(operation: () => T, touched: readonly AtomicSubsystem[]): T;
    placeGroundRewards(map: string, x: number, y: number, rewards: readonly DropReward[]): void;
  },
  input: {
    map: Pick<WorldMap, 'id' | 'lootLevel' | 'chestLevel'>;
    entity: string;
    kind: ChestKind;
    position: { x: number; y: number };
    catalog: DropCatalog;
    stats: CharacterStatsCatalog;
    landing: () => { x: number; y: number };
  },
): boolean {
  const { map, entity, kind, position, catalog, stats } = input;
  if (map.lootLevel === undefined) throw new Error('宝箱缺少地图掉落数据');
  const level = map.chestLevel ?? Math.max(1, map.lootLevel);
  return host.atomic(() => {
    const result = host.chests.open(map.id, entity, position, () => {
      const equipmentBonus = catalog.pity ? host.lootPity.chestEquipmentBonus(kind, catalog.pity) : 0;
      const rolled = rollChestLoot(catalog, stats, kind, level, host.hero!.level, Math.random, host.party?.groupModifiers(), { equipmentBonus });
      host.lootPity.recordChest(kind, { equipment: rolled.rewards.some(reward => reward.kind === 'item' && !!reward.roll) });
      return rolled;
    }, host.storyWorld.isPlaced(entity));
    if (!result) return false;
    if (result.rewards.length) {
      const landing = input.landing();
      host.placeGroundRewards(map.id, landing.x, landing.y, result.rewards);
    }
    return true;
  }, ['chests', 'lootPity', 'bag']);
}

export interface EnemyDefeatSettlementHost {
  enemies: SessionEnemyStore;
  chests: ChestVisits;
  bag: Bag;
  groundLoot: GroundLootStore;
  hero?: BattleCharacter;
  party?: PartyRoster;
  lootPity: LootPity;
  partyItemChance: number;
  getReservedDropMisses(): number;
  setReservedDropMisses(value: number): void;
  claimedReservedDrops: ReadonlySet<string>;
  questDropRequirements(): readonly (readonly QuestDropRequirement[])[];
  enemyDefeated(spawn: EnemySpawn | CampaignEnemyPlacement): boolean;
  placeGroundRewards(map: string, x: number, y: number, rewards: readonly DropReward[]): void;
  atomic<T>(operation: () => T, touched: readonly AtomicSubsystem[]): T;
  runDeferredDefeatBatch<T>(defeats: string[], operation: () => T): T;
  emit(): void;
  refresh(): void;
  notifySessionListeners(report: (operation: () => void) => void): void;
  notifyDefeatListeners(enemyId: string, report: (operation: () => void) => void): void;
}

/** 一次死亡只提交一次游戏状态；返回的通知在死亡单移除后发布。 */
export function settleSessionEnemyDefeat(
  host: EnemyDefeatSettlementHost,
  input: EnemyDefeatInput,
): EnemyDefeatResult | undefined {
  if (input.spawn && host.enemies.raw(input.spawn.id)?.deadUntil !== undefined) return undefined;
  const store = host.groundLoot;
  const defeats: string[] = [];
  const enemies = new Map<string, EnemyState | undefined>();
  const remember = (id: string) => { if (!enemies.has(id)) enemies.set(id, host.enemies.raw(id)); };
  if (input.spawn) remember(input.spawn.id);

  let levelledIds: string[] = [];
  let living: readonly string[] = [];
  const settlement = host.runDeferredDefeatBatch(defeats, () =>
    host.atomic(() => {
      try {
        if (input.spawn) host.enemyDefeated(input.spawn);
        living = host.party?.livingIds ?? [];
        const levels = new Map(living.map(id => [id, id === 'player' ? host.hero?.level : host.party?.get(id)?.level]));
        const heroLevel = host.hero?.level ?? 1;
        const result = settleCombatRewards({
          ...input,
          hasSpawn: !!input.spawn,
          oneTime: input.spawn?.respawn === false,
          heroLevel,
          partySize: Math.max(1, living.length),
          party: (living.length ? living : ['player']).map(id => ({ id, level: (id === 'player' ? host.hero : host.party?.get(id))?.level ?? heroLevel })),
          modifiers: host.party?.groupModifiers(),
          itemChance: host.partyItemChance,
          questRequirements: host.questDropRequirements(),
          pity: host.lootPity,
          reserved: {
            misses: host.getReservedDropMisses(),
            claimed: host.claimedReservedDrops,
            pending: new Set(store.dropsOnMap(input.map).flatMap(drop => drop.reward.kind === 'item' ? [drop.reward.item] : [])),
          },
        });
        for (const record of result.pityRecords) {
          host.lootPity.recordEnemy(
            record.ownerId,
            { equipment: record.equipment, bestRarity: record.bestRarity },
            record.eligibility,
            record.points,
          );
        }
        host.setReservedDropMisses(result.reservedUnlockMisses);
        const add = (x: number, y: number, rewards: readonly DropReward[]) => {
          if (!rewards.length) return;
          const landing = input.landing(x, y);
          host.placeGroundRewards(input.map, landing.x, landing.y, rewards);
        };
        if (result.breakable) {
          add(input.x, input.y, result.breakable.rewards);
          // 只保存本次可能覆盖的衍生怪状态，不复制其他地图的死亡历史。
          host.atomic(() => {
            for (const spawn of host.chests.spawns) {
              if (spawn.id.startsWith('breakable:') && spawn.id.includes(':' + input.key + ':')) remember(spawn.id);
            }
            for (const id of host.chests.spawnBreakableEnemies(input.map, input.key, result.breakable!.enemies, { x: input.x, y: input.y })) {
              remember(id);
              host.enemies.forget(id);
            }
          }, ['chests']);
        } else {
          const offsets = [0, 5, -5];
          for (const group of result.owners) add(input.x + offsets[group.slot % offsets.length]!, input.y, group.rewards);
          add(input.x, input.y, result.reserved);
        }
        if (input.spawn) add(input.x, input.y, result.quest);
        if (result.experience > 0) host.party?.addExperience(result.experience);
        levelledIds = living.filter(id => ((id === 'player' ? host.hero : host.party?.get(id))?.level ?? 0) > (levels.get(id) ?? 0));
        host.emit();
        return result;
      } catch (error) {
        host.enemies.restoreSubset(enemies);
        throw error;
      }
    }, ['bag', 'hero', 'skills', 'party', 'questBook', 'storyWorld', 'lootPity', 'reservedDrops']));

  let notified = false;
  return {
    settlement,
    levelledIds,
    notify: () => {
      if (notified) return;
      notified = true;
      const report = (operation: () => void) => {
        try { operation(); } catch (error) { console.error('击杀结算通知失败', error); }
      };
      report(() => host.refresh());
      host.notifySessionListeners(report);
      for (const enemy of defeats) host.notifyDefeatListeners(enemy, report);
    },
  };
}
