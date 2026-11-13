import type Phaser from 'phaser';
import type { ActorDefinition } from '../domain/content.ts';
import type { EquipmentSlot, ItemCatalog } from '../domain/items.ts';
import type { CostumePose, WardrobeCatalog } from '../domain/wardrobe.ts';
import { OutfitPool, type Outfit, type WardrobePrepareOptions } from './outfit-pool.ts';

/** 场景只持有外观使用权；合成与缓存交给本次游戏共用的外观池。 */
export class Wardrobe {
  private readonly scene: Phaser.Scene;
  private readonly pool: OutfitPool;
  private readonly ownsPool: boolean;
  private readonly held = new Map<string, { outfit: Outfit; release(): void }>();
  private request = new AbortController();
  private active = true;
  private current?: Outfit;
  private readonly onShutdown = () => this.destroy();

  constructor(scene: Phaser.Scene, catalog: WardrobeCatalog, items: ItemCatalog,
    poseLoader?: (ids: readonly string[], signal: AbortSignal) => Promise<Record<string, CostumePose>>, pool?: OutfitPool) {
    this.scene = scene; this.ownsPool = !pool;
    this.pool = pool ?? new OutfitPool(scene, catalog, items, poseLoader);
    scene.events.once('shutdown', this.onShutdown);
  }
  activate(outfit: Outfit): void {
    if (this.current === outfit) return;
    if (this.current) this.current.users--;
    outfit.users++; this.current = outfit;
    for (const [key, lease] of this.held) if (lease.outfit !== outfit) { lease.release(); this.held.delete(key); }
  }
  async prepare(base: ActorDefinition, equipment: Partial<Record<EquipmentSlot, string>>, classId?: string,
    options?: WardrobePrepareOptions): Promise<Outfit> {
    if (!this.active || !this.pool.available) throw new DOMException('场景已关闭', 'AbortError');
    const request = this.request.signal, external = options?.signal, controller = new AbortController();
    const abort = () => controller.abort(request.aborted ? request.reason : external?.reason);
    request.addEventListener('abort', abort, { once: true }); external?.addEventListener('abort', abort, { once: true });
    if (request.aborted || external?.aborted) abort();
    const normalized = options?.clipNames === undefined ? options : { ...options, clipNames: [...options.clipNames] };
    let lease: { outfit: Outfit; release(): void } | undefined;
    try {
      const key = this.pool.key(base, equipment, classId, normalized);
      controller.signal.throwIfAborted();
      const ready = this.held.get(key);
      if (ready) return ready.outfit;
      lease = await this.pool.acquire(base, equipment, classId, normalized, controller.signal);
      controller.signal.throwIfAborted();
      const existing = this.held.get(key);
      if (existing) { lease.release(); return existing.outfit; }
      this.held.set(key, lease);
      for (const [candidate, held] of this.held) {
        if (this.held.size <= 3) break;
        if (candidate !== key && held.outfit !== this.current) { held.release(); this.held.delete(candidate); }
      }
      return lease.outfit;
    } catch (error) { lease?.release(); throw error; }
    finally { request.removeEventListener('abort', abort); external?.removeEventListener('abort', abort); }
  }
  clear(): void {
    this.request.abort(new DOMException('人物外观生成已取消', 'AbortError')); this.request = new AbortController();
    if (this.current) this.current.users--; this.current = undefined;
    for (const lease of this.held.values()) lease.release(); this.held.clear();
    if (this.ownsPool) this.pool.clear();
  }
  destroy(): void {
    if (!this.active) return;
    this.active = false; this.scene.events.off('shutdown', this.onShutdown); this.clear();
    if (this.ownsPool) this.pool.destroy();
  }
}
