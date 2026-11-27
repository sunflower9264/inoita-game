import type { EnemySpawn } from './content.ts';
import { encounterSpawnId, type StoryEncounter } from './story-world.ts';

export interface EnemyState {
  health?: number;
  mana?: number;
  deadUntil?: number | 'permanent';
  offscreenRespawnAt?: number;
  capture?: { map: string; visit: number };
}

export const DEFAULT_ENEMY_RESPAWN_MS = 60_000;
export const OFFSCREEN_ENEMY_RESPAWN_MS = 20_000;

/** 会话持有的敌人生命/复活/捕捉状态存储，分离“血蓝修订号”和“生成资格修订号”。 */
export class SessionEnemyStore {
  private readonly states = new Map<string, EnemyState>();
  private revisionValue = 0;
  private spawnRevisionValue = 0;

  /** `states` 每次写入/删除/恢复都会递增；用于存档快照缓存复用。 */
  get revision(): number { return this.revisionValue; }

  /** 仅生成资格变化时递增，受伤和回蓝不使地图生成名单失效。 */
  get spawnRevision(): number { return this.spawnRevisionValue; }

  raw(id: string): EnemyState | undefined { return this.states.get(id); }

  private setState(id: string, state: EnemyState): void {
    const previous = this.states.get(id);
    if (previous?.deadUntil !== state.deadUntil || previous?.offscreenRespawnAt !== state.offscreenRespawnAt) {
      this.spawnRevisionValue++;
    }
    // 存档快照按 `revision` 复用；每次 set 都视为一次新写入。
    this.states.set(id, state);
    this.revisionValue++;
  }

  private deleteState(id: string): void {
    if (this.states.get(id)?.deadUntil !== undefined) this.spawnRevisionValue++;
    if (this.states.delete(id)) this.revisionValue++;
  }

  vitals(id: string): Readonly<EnemyState> {
    const state = this.states.get(id);
    return { ...state, ...(state?.capture ? { capture: { ...state.capture } } : {}) };
  }

  setVitals(id: string, health: number, mana: number): void {
    this.setState(id, { ...this.states.get(id), health, mana });
  }

  forget(id: string): void {
    this.deleteState(id);
  }

  /** 按前缀清理历史剧情敌怪状态（如跨时间点跳转清理 `story-located-`），避免触发整份会话深拷贝。 */
  forgetByPrefix(prefix: string): number {
    let removed = 0;
    for (const id of [...this.states.keys()]) {
      if (!id.startsWith(prefix)) continue;
      this.deleteState(id);
      removed++;
    }
    return removed;
  }

  /** 一次性剧情遭遇被有界历史淘汰后，同步删除对应生成点状态。 */
  forgetEncounters(encounters: readonly StoryEncounter[]): void {
    for (const encounter of encounters) {
      for (const spawn of encounter.spawns) {
        this.deleteState(encounterSpawnId(encounter.id, spawn.id));
      }
    }
  }

  /** 进图时按新访问规则重置普通地图怪，清理过期的捕捉与上一张图的临时/可破坏记录。 */
  transitionMap(
    map: string,
    previousChestMap: string | undefined,
    chestSpawns: readonly EnemySpawn[],
    visit: number,
    mapSpawns?: readonly EnemySpawn[],
  ): void {
    const entering = previousChestMap !== map;
    if (entering && mapSpawns) {
      for (const spawn of mapSpawns) {
        if (spawn.respawn === false) continue;
        const state = this.states.get(spawn.id);
        if (!state || state.deadUntil === 'permanent' || state.capture) continue;
        this.deleteState(spawn.id);
      }
    }
    for (const [id, enemy] of this.states) {
      if (enemy.capture && (enemy.capture.map !== map || enemy.capture.visit !== visit)) {
        this.deleteState(id);
      }
    }
    if (previousChestMap !== map) {
      for (const spawn of chestSpawns) this.deleteState(spawn.id);
      // 永久死亡的 breakable 记录只属于上一次地图访问，换图后不会再生成，直接清掉。
      for (const [id, enemy] of this.states) {
        if (id.startsWith('breakable:') && enemy.deadUntil === 'permanent') this.deleteState(id);
      }
      if (previousChestMap !== undefined) {
        for (const [id, enemy] of this.states) {
          if (enemy.deadUntil !== 'permanent') this.deleteState(id);
        }
      }
    }
  }

  markStoryRemoved(id: string): void {
    const state: EnemyState = { ...this.states.get(id), health: 0, deadUntil: 'permanent' };
    delete state.offscreenRespawnAt;
    this.setState(id, state);
  }

  /** 名册在正常/视野外计时到期，或明确豁免剧情清场时，消费死亡记录并恢复满血。 */
  clearDefeat(id: string, nowMs: number, offscreen = false): boolean {
    const state = this.states.get(id);
    if (!state) return true;
    if (state.capture) return false;
    if (state.deadUntil === undefined) return true;
    if (
      state.deadUntil !== 'permanent'
      && nowMs < state.deadUntil
      && !(offscreen && state.offscreenRespawnAt !== undefined && nowMs >= state.offscreenRespawnAt)
    ) {
      return false;
    }
    const rest: EnemyState = { ...state };
    delete rest.deadUntil;
    delete rest.offscreenRespawnAt;
    delete rest.health;
    if (Object.keys(rest).length) this.setState(id, rest);
    else this.deleteState(id);
    return true;
  }

  /** 只读死亡刷新资格；剧情与任务的在场规则由敌人名册处理。 */
  canRespawn(spawn: Pick<EnemySpawn, 'id'>, nowMs: number, offscreen = false): boolean {
    const state = this.states.get(spawn.id);
    if (state?.capture) return false;
    if (state?.deadUntil === undefined) return true;
    if (state.deadUntil === 'permanent') return false;
    return nowMs >= state.deadUntil
      || offscreen && state.offscreenRespawnAt !== undefined && nowMs >= state.offscreenRespawnAt;
  }

  markCaptured(id: string, map: string, visit: number): void {
    this.setState(id, { health: 1, deadUntil: 'permanent', capture: { map, visit } });
  }

  markDefeated(spawn: Pick<EnemySpawn, 'id' | 'respawn'>, nowMs: number, respawnMs = DEFAULT_ENEMY_RESPAWN_MS): void {
    this.setState(
      spawn.id,
      spawn.respawn === false
        ? { deadUntil: 'permanent' }
        : { deadUntil: nowMs + respawnMs, offscreenRespawnAt: nowMs + Math.min(respawnMs, OFFSCREEN_ENEMY_RESPAWN_MS) },
    );
  }

  captureEntries(): [string, EnemyState][] {
    return [...this.states].map(([id, enemy]) => [id, structuredClone(enemy)]);
  }

  restoreEntries(entries: Iterable<readonly [string, EnemyState]>): void {
    this.states.clear();
    for (const [id, enemy] of entries) this.states.set(id, enemy);
    this.revisionValue++;
    this.spawnRevisionValue++;
  }

  /** 回滚结算期间涉及的一小组敌人状态，不复制整张地图历史。 */
  restoreSubset(entries: Iterable<readonly [string, EnemyState | undefined]>): void {
    for (const [id, state] of entries) {
      if (state) this.states.set(id, state);
      else this.states.delete(id);
    }
    this.revisionValue++;
    this.spawnRevisionValue++;
  }
}
