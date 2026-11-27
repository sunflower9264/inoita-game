import { AUTO_SAVE_SLOT, type SaveGame, type SaveSlots } from '../domain/save-game.ts';
import type { WorldIndex } from '../domain/content.ts';
import type { MenuPanels } from '../domain/menu-panels.ts';
import type { Session } from '../domain/session.ts';
import type { StoryClassCatalog } from '../domain/story-class.ts';
import { AutoSaver } from './auto-save.ts';
import type { GameMode } from './control-state.ts';
import { captureSessionSave } from './saved-game.ts';
import type { SaveWorldResult, StoryWorldViewSnapshot } from './world-snapshot.ts';

export interface AutoSaveThumbnailPort {
  latest(): string | undefined;
  capture(): Promise<string | undefined>;
  reset(): void;
}

export interface SessionAutoSaveApp {
  readonly mode: GameMode;
  readonly suspended: boolean;
  readonly locked: boolean;
  readonly pressureMode?: boolean;
  readonly storyJumpActive: boolean;
  readonly session?: Session;
  readonly director?: { readonly busy: boolean };
  readonly world?: WorldIndex;
  readonly storyClasses?: StoryClassCatalog;
  readonly menuPanels?: Pick<MenuPanels, 'character'>;
  readonly saves: Pick<SaveSlots<StoryWorldViewSnapshot>, 'write'>;
  captureSaveWorld?: () => SaveWorldResult;
}

export interface SessionAutoSaveHost {
  readonly app: SessionAutoSaveApp;
  readonly thumbnails: AutoSaveThumbnailPort;
  readonly now?: () => number;
}

/**
 * 自动存档控制器：进图、剧情事件完成、任务接取/完成、定时与切后台共享同一代次守卫，
 * 避免切局或异步截图期间把旧会话快照写入自动槽。
 */
export class SessionAutoSaveController {
  private readonly host: SessionAutoSaveHost;
  private saver?: AutoSaver<StoryWorldViewSnapshot>;
  private generation = 0;
  private unsubscribeQuests?: () => void;

  constructor(host: SessionAutoSaveHost) {
    this.host = host;
  }

  get current(): AutoSaver<StoryWorldViewSnapshot> | undefined {
    return this.saver;
  }

  request(): void {
    this.saver?.request();
  }

  flushForBackground(): void {
    this.saver?.flushForBackground();
  }

  stop(): void {
    this.generation += 1;
    this.unsubscribeQuests?.();
    this.unsubscribeQuests = undefined;
    this.saver?.stop();
    this.saver = undefined;
    this.host.thumbnails.reset();
  }

  start(session: Session): void {
    this.stop();
    const { app, thumbnails } = this.host;
    const now = this.host.now ?? (() => performance.now());
    const generation = this.generation;
    const writeSlot = (mode: 'sync' | 'async', game: SaveGame<StoryWorldViewSnapshot>, started = now()): void => {
      try {
        app.saves.write(AUTO_SAVE_SLOT, game);
        globalThis.storyDiagnostics?.record(
          'save',
          { slot: 'auto', mode, elapsedMs: Math.round((now() - started) * 10) / 10 },
          false,
        );
      } catch (error) {
        globalThis.storyDiagnostics?.record('save-error', { slot: 'auto', mode, error });
        throw error;
      }
    };

    const saver = new AutoSaver<StoryWorldViewSnapshot>({
      enabled: () => app.mode === 'game' && !app.suspended && !!app.session && !app.pressureMode && !app.storyJumpActive,
      // 演出与菜单锁着时不抢写：等解锁后再写，免得存到一半的状态。
      locked: () => app.locked || !!app.director?.busy,
      capture: () => {
        if (!app.storyClasses || !app.menuPanels) return undefined;
        const captured = captureSessionSave(session, app.world, {
          storyClasses: app.storyClasses,
          menuPanels: app.menuPanels,
          captureSaveWorld: app.captureSaveWorld,
        }, thumbnails.latest());
        return captured.ok ? captured.record : undefined;
      },
      write: game => {
        if (generation === this.generation && app.session === session && app.mode === 'game') {
          writeSlot('sync', game);
        }
      },
      // 常规自动存档先截一张当前画面；页面即将隐藏时仍走同步 write，保留上一张截图。
      writeAsync: async (game, isLatest) => {
        const started = now();
        const screenshot = await thumbnails.capture();
        // 等截图期间回标题、读档或换了会话时，不能把旧快照写进新的自动槽。
        if (!isLatest() || generation !== this.generation || app.session !== session || app.mode !== 'game' || app.storyJumpActive) {
          return;
        }
        if (screenshot) game.summary.screenshot = screenshot;
        writeSlot('async', game, started);
      },
      now,
    });

    this.saver = saver;
    this.unsubscribeQuests = saver.watchQuests(session);
    saver.start();
  }
}
