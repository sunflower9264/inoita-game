import type { AssetLease } from '../application/assets.ts';
import { buildEntryPlan, entryPlanAssets } from '../application/entry-plan.ts';
import type { StoryContext } from '../application/ports.ts';
import type { EntityPlacement, MapExit, WorldMap } from '../domain/content.ts';
import type { DropCatalog } from '../domain/drops.ts';
import type { SpringCatalog } from '../domain/springs.ts';
import { storyReachableScripts } from '../domain/story-entry.ts';
import { potentialMapEnemyIds, storyPresentationAssets, type WorldAssetInputs } from '../rendering/map-assets.ts';
import type { PendingAsset } from '../rendering/scene-assets.ts';
import { domAssets } from '../ui/dom/assets.ts';

export interface WorldPrefetchHost {
  readonly app: StoryContext;
  readonly destroyed: boolean;
  readonly loadingWorld: boolean;
  readonly map: WorldMap | undefined;
  readonly entities: readonly EntityPlacement[];
  readonly dropCatalog: DropCatalog | undefined;
  readonly springCatalog: SpringCatalog | undefined;
  readonly requestSignal: AbortSignal;
  readonly now: number;
  readonly worldView: { contains(x: number, y: number): boolean } | undefined;
  exitAvailable(exit: MapExit): boolean;
  loadAssets(assets: PendingAsset[], options: { progress?: (value: number) => void; lifetime?: 'scene' | 'manual'; signal?: AbortSignal }): Promise<AssetLease>;
  loadStoryEntryAssets(assets: PendingAsset[], signal: AbortSignal): Promise<{ missing: number; lease: AssetLease }>;
}

/**
 * 协调正式世界的进图素材输入汇集、剧情表现补载与玩家沿出口移动时的邻图预加载，
 * 与 Phaser Scene 及 `loadSceneAssets` 具体实现通过 `WorldPrefetchHost` 解耦。
 */
export class WorldPrefetcher {
  private readonly host: WorldPrefetchHost;
  prefetchTarget?: string;
  private prefetchFailedTarget?: string;
  private prefetchRetryAt = 0;
  prefetchTask?: Promise<void>;
  private prefetchRequest?: AbortController;

  constructor(host: WorldPrefetchHost) {
    this.host = host;
  }

  reset(): void {
    this.prefetchRequest?.abort();
    this.prefetchTarget = undefined;
    this.prefetchTask = undefined;
    this.prefetchRequest = undefined;
    this.prefetchFailedTarget = undefined;
    this.prefetchRetryAt = 0;
  }

  /** 正式世界、入口计划和运行时兜底共用的素材输入。 */
  assetInputs(): WorldAssetInputs {
    const { app, dropCatalog, springCatalog } = this.host;
    const session = app.session;
    if (!session.character) throw new Error('正式游戏缺少主角外观');
    if (!session.hero) throw new Error('正式游戏缺少主角战斗数值');
    if (!dropCatalog || !springCatalog) throw new Error('掉落与泉水目录尚未就绪');
    return {
      world: app.world,
      campaign: app.campaign,
      battle: app.battleCatalog,
      items: app.items,
      wardrobe: app.wardrobe,
      drops: dropCatalog,
      springs: springCatalog,
      statusHud: app.statusHud,
      controlSkin: app.controlSkin,
      storyInterface: app.storyInterface,
      storyWorld: session.storyWorld,
      companions: app.companions,
      party: session.party,
      hero: session.hero,
      heroSkills: session.skills,
      playerBase: session.character.appearance,
    };
  }

  /** 读档/失败恢复时运行中的剧情游标，入口计划要一起预热。 */
  activeStoryScripts(): string[] {
    return this.host.app.session.runtimeState.runs
      .filter(run => run.status === 'running' || run.status === 'waiting')
      .map(run => run.cursor.script);
  }

  /** 这张图战斗可能出现的全部敌人；进图预取和战斗开场共用同一份超集。 */
  combatEnemyIds(): string[] {
    if (!this.host.map) return [];
    return potentialMapEnemyIds(this.host.map, this.assetInputs(), {
      scripts: this.activeStoryScripts(),
      entities: [...this.host.entities],
    });
  }

  /** 开演前只补说话人的立绘和这一段用到的音效。 */
  async ensureStoryAssets(scripts: readonly string[], signal: AbortSignal): Promise<void> {
    if (this.host.loadingWorld || !this.host.map || this.host.destroyed) return;
    signal.throwIfAborted();
    const { app } = this.host;
    const reachable = storyReachableScripts(app.campaign, scripts);
    const presentation = storyPresentationAssets(app.campaign, reachable, this.assetInputs());
    const portraits = presentation.portraits.filter(file => !domAssets.peek(file));
    if (portraits.length) await app.ui.preloadPortraits(portraits, signal, () => {});
    await app.audio?.prepareStoryEffects(presentation.sounds, signal);
    signal.throwIfAborted();
  }

  /** 提前准备当前剧情的世界资源，由会话持有到正式世界接管。 */
  prefetchStoryEntry(mapId: string, script: string | undefined, signal: AbortSignal): Promise<void> {
    const { app, loadingWorld, destroyed, map } = this.host;
    if (loadingWorld || destroyed || !map || !app.storyAssetPreparation) return Promise.resolve();
    return app.storyAssetPreparation
      .prepare(mapId, JSON.stringify([mapId, script]), signal, request => this.loadStoryEntry(mapId, script, request))
      .catch(error => {
        if (!signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
          globalThis.storyDiagnostics?.record('story-entry-prefetch-failed', { map: mapId, error });
        }
      });
  }

  private async loadStoryEntry(mapId: string, script: string | undefined, signal: AbortSignal): Promise<AssetLease> {
    const { app } = this.host;
    const reference = app.world.maps.find(entry => entry.id === mapId);
    if (!reference) throw new Error('剧情预取地图不存在：' + mapId);
    const inputs = this.assetInputs();
    const session = app.session;
    const active = [...new Set([...this.activeStoryScripts(), ...(script ? [script] : [])])];
    const map = await app.content.map(reference.file, signal);
    signal.throwIfAborted();
    const plan = buildEntryPlan({
      currentMap: map,
      inputs,
      completedEvents: session.runtimeState.completedEvents,
      questStatus: questId => session.status(questId),
      activeScripts: active,
      includeResidentCombat: !app.residentCombatReady,
    });
    const assets = entryPlanAssets(plan);
    const { missing, lease } = await this.host.loadStoryEntryAssets(assets, signal);
    if (signal.aborted) {
      lease.release();
      signal.throwIfAborted();
    }
    globalThis.storyDiagnostics?.record('story-entry-prefetch', { map: mapId, missing });
    return lease;
  }

  /** 仅提前准备目标地图两层大图；人物和物件由正式进图按需装配。 */
  prefetchMap(destination: string): void {
    const { app, map, loadingWorld, destroyed, requestSignal } = this.host;
    if (!map || destination === map.id || loadingWorld || destroyed) return;
    if (this.prefetchTarget === destination) return;
    if (this.prefetchFailedTarget === destination && this.host.now < this.prefetchRetryAt) return;
    this.prefetchTarget = destination;
    this.prefetchRequest?.abort();
    const controller = this.prefetchRequest = new AbortController();
    const cancel = () => controller.abort(requestSignal.reason);
    requestSignal.addEventListener('abort', cancel, { once: true });
    if (requestSignal.aborted) cancel();
    const signal = controller.signal;
    const run = async () => {
      while (!signal.aborted && this.prefetchTarget) {
        const target = this.prefetchTarget;
        try {
          const reference = app.world.maps.find(entry => entry.id === target);
          if (!reference) throw new Error(`地图不存在：${target}`);
          const loaded = await app.content.map(reference.file, signal);
          signal.throwIfAborted();
          const lease = await this.host.loadAssets([
            { kind: 'image', key: loaded.id + '-ground', file: loaded.ground },
            { kind: 'image', key: loaded.id + '-canopy', file: loaded.canopy },
          ], { lifetime: 'manual', signal });
          if (signal.aborted || this.prefetchTarget !== target) lease.release();
          else app.retainMapPrefetch(lease);
        } catch {
          if (signal.aborted) return;
          if (this.prefetchTarget === target) {
            this.prefetchFailedTarget = target;
            this.prefetchRetryAt = this.host.now + 1000;
            this.prefetchTarget = undefined;
            return;
          }
        }
        if (this.prefetchTarget === target) return;
      }
    };
    const task = run();
    this.prefetchTask = task;
    void task.finally(() => {
      requestSignal.removeEventListener('abort', cancel);
      if (this.prefetchTask === task) this.prefetchTask = undefined;
      if (this.prefetchRequest === controller) this.prefetchRequest = undefined;
    });
  }

  prefetchVisibleExit(position: { x: number; y: number }, previous: { x: number; y: number }): void {
    const map = this.host.map;
    const worldView = this.host.worldView;
    if (!map || !worldView) return;
    const vx = position.x - previous.x;
    const vy = position.y - previous.y;
    let destination: string | undefined;
    let nearest = Infinity;
    for (const exit of map.exits) {
      if (exit.destination === map.id || !this.host.exitAvailable(exit)) continue;
      const x = exit.x + exit.width / 2;
      const y = exit.y + exit.height / 2;
      if (!worldView.contains(x, y)) continue;
      const dx = x - position.x;
      const dy = y - position.y;
      if (dx * vx + dy * vy <= 0) continue;
      const distance = dx * dx + dy * dy;
      if (distance < nearest) {
        nearest = distance;
        destination = exit.destination;
      }
    }
    if (destination) this.prefetchMap(destination);
  }
}
