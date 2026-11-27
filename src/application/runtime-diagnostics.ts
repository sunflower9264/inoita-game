import { SAVE_FORMAT } from '../domain/save-game.ts';
import type { Session } from '../domain/session.ts';
import type { PressureSettings } from '../domain/pressure-enemies.ts';
import type { GameMode } from './control-state.ts';
import { displaySettings } from './display-settings.ts';
import { currentRefreshRate } from './frame-pacing.ts';
import { FrameStats, installDiagnosticMetrics, installDiagnosticSnapshot } from './game-diagnostics.ts';

const LOW_FPS_COOLDOWN_MS = 5 * 60_000;
const TEXTURE_COUNT_TTL_MS = 1000;
const TEXTURE_BYTES_TTL_MS = 60_000;
const STORAGE_ESTIMATE_TTL_MS = 300_000;

export interface DiagnosticRendererHost {
  readonly gl?: WebGL2RenderingContext | WebGLRenderingContext | null;
}

export interface DiagnosticTextureManagerHost {
  getTextureKeys(): string[];
  get(key: string): unknown;
}

export interface DiagnosticSoundItemHost {
  readonly key: string;
  readonly isPlaying: boolean;
  readonly isPaused: boolean;
}

export interface DiagnosticSoundManagerHost {
  readonly locked?: boolean;
  readonly mute?: boolean;
  readonly context?: { readonly state?: string } | null;
  getAll(key: string): ReadonlyArray<DiagnosticSoundItemHost>;
}

export interface DiagnosticGameHost {
  readonly renderer?: DiagnosticRendererHost | object | null;
  readonly textures?: DiagnosticTextureManagerHost;
  readonly sound?: DiagnosticSoundManagerHost;
}

export interface DiagnosticWorldSceneHost {
  readonly map?: { readonly id: string };
  diagnosticSnapshot(): unknown;
}

export interface RuntimeDiagnosticsApp {
  readonly mode: GameMode;
  readonly ready: boolean;
  readonly locked: boolean;
  readonly lockOwners: readonly string[];
  readonly suspended: boolean;
  readonly defeatOpen: boolean;
  readonly dialogueOpen: boolean;
  readonly choiceOpen: boolean;
  readonly questPopupOpen: boolean;
  readonly controlLayoutEditing: boolean;
  readonly keyBindingEditing: boolean;
  readonly loadingLabel?: string;
  readonly saveSlot?: number;
  readonly pressureMode?: boolean;
  readonly pressureSettings: Readonly<PressureSettings>;
  readonly trustedContent: boolean;
  readonly menuOpen: boolean;
  readonly session?: Session;
  readonly director?: {
    readonly busy: boolean;
    readonly runtime: {
      snapshot(): {
        readonly runs: ReadonlyArray<{
          readonly eventId?: string;
          readonly cursor: unknown;
          readonly status: string;
          readonly waiting?: { readonly encounter?: unknown };
        }>;
      };
    };
  };
  readonly audio?: {
    captureStoryAudio(): object;
    readonly settings: unknown;
  };
}

export interface RuntimeDiagnosticsHost {
  readonly app: RuntimeDiagnosticsApp;
  readonly game: () => DiagnosticGameHost | undefined;
  readonly worldScene: () => DiagnosticWorldSceneHost | undefined;
  readonly gmOn: () => boolean;
  readonly editingText: () => boolean;
  readonly now?: () => number;
}

/**
 * 运行期诊断聚合器：帧统计、WebGL/纹理/存储缓存探测、低帧率告警、心跳与运行态快照。
 * 与 Phaser 实体解耦，可直接在 Node 环境下测试掉帧告警阈值、冷却窗口与快照裁剪。
 */
export class RuntimeDiagnosticsController {
  private readonly host: RuntimeDiagnosticsHost;
  private readonly frameStats = new FrameStats();
  private diagnosticFrames = 0;
  private diagnosticLongFrames = 0;
  // 用 -Infinity 而不是 0：判断基于 performance.now()，初始 0 会让启动后前 5 分钟的掉帧无法上报。
  private lastLowFpsAt = Number.NEGATIVE_INFINITY;
  private heartbeatIndex = 0;
  private cachedRenderer: Record<string, unknown> | null = null;
  private cachedStorage: Record<string, unknown> | null = null;
  private cachedStorageAt = 0;
  private cachedTextureBytes = -1;
  private cachedTextureBytesAt = 0;
  private cachedTextureCount = -1;
  private cachedTextureCountAt = 0;

  constructor(host: RuntimeDiagnosticsHost) {
    this.host = host;
  }

  private now(): number {
    return this.host.now ? this.host.now() : performance.now();
  }

  frame(now: number): void {
    this.frameStats.frame(now);
  }

  readonly recordSceneChange = (scene: string, details: Record<string, unknown> = {}): void => {
    globalThis.storyDiagnostics?.record('scene-change', { scene, mode: this.host.app.mode, ...details }, false);
  };

  rendererDiagnostics(): Record<string, unknown> | null {
    if (this.cachedRenderer) return this.cachedRenderer;
    const renderer = this.host.game()?.renderer as DiagnosticRendererHost | undefined;
    const gl = renderer?.gl;
    if (!gl) return null;
    try {
      const debug = gl.getExtension('WEBGL_debug_renderer_info') as
        { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null;
      this.cachedRenderer = {
        version: gl.getParameter(gl.VERSION) as string,
        vendor: gl.getParameter(gl.VENDOR) as string,
        renderer: gl.getParameter(gl.RENDERER) as string,
        unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) as string : null,
        unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : null,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      };
    } catch {
      this.cachedRenderer = { unavailable: true };
    }
    return this.cachedRenderer;
  }

  textureDiagnostics(): Record<string, unknown> {
    const textures = this.host.game()?.textures;
    if (!textures) return { count: 0, estimatedBytes: null };
    try {
      const now = this.now();
      // 事件记录可能每秒多条；纹理名单一秒最多取一次，避免每条记录都分配一个键数组。
      if (this.cachedTextureCount < 0 || now - this.cachedTextureCountAt > TEXTURE_COUNT_TTL_MS) {
        const keys = textures.getTextureKeys();
        this.cachedTextureCount = keys.length;
        this.cachedTextureCountAt = now;
        if (this.cachedTextureBytes < 0 || now - this.cachedTextureBytesAt > TEXTURE_BYTES_TTL_MS) {
          let bytes = 0;
          for (const key of keys) {
            const texture = textures.get(key) as
              { source?: { width?: number; height?: number } | Array<{ width?: number; height?: number }> } | undefined;
            const source = Array.isArray(texture?.source) ? texture.source[0] : texture?.source;
            if (source?.width && source?.height) bytes += source.width * source.height * 4;
          }
          this.cachedTextureBytes = bytes;
          this.cachedTextureBytesAt = now;
        }
      }
      return { count: this.cachedTextureCount, estimatedBytes: this.cachedTextureBytes };
    } catch {
      return { count: 0, estimatedBytes: null };
    }
  }

  storageDiagnostics(): Record<string, unknown> | null {
    const now = this.now();
    if (this.cachedStorage && now - this.cachedStorageAt < STORAGE_ESTIMATE_TTL_MS) return this.cachedStorage;
    this.cachedStorageAt = now;
    try {
      const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
      if (!storage?.estimate) return null;
      void storage.estimate().then(estimate => {
        this.cachedStorage = { quota: estimate.quota ?? null, usage: estimate.usage ?? null };
      }).catch(() => {
        // 失败也记下结果：否则缓存一直是 null，每条诊断都会重新发起一次估算。
        this.cachedStorage = { unavailable: true };
      });
    } catch {
      return null;
    }
    return this.cachedStorage;
  }

  private memoryUsage(): Record<string, number> | null {
    if (typeof performance === 'undefined') return null;
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
    }).memory;
    if (!memory) return null;
    return {
      usedBytes: memory.usedJSHeapSize ?? 0,
      totalBytes: memory.totalJSHeapSize ?? 0,
      limitBytes: memory.jsHeapSizeLimit ?? 0,
    };
  }

  private navigatorMetrics(): Record<string, unknown> {
    if (typeof navigator === 'undefined') {
      return {
        hardwareConcurrency: null,
        deviceMemory: null,
        online: null,
        connection: null,
        maxTouchPoints: null,
        language: null,
      };
    }
    const nav = navigator as Navigator & {
      deviceMemory?: number;
      connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
    };
    const connection = nav.connection;
    return {
      hardwareConcurrency: nav.hardwareConcurrency || null,
      deviceMemory: nav.deviceMemory ?? null,
      online: nav.onLine,
      connection: connection ? {
        effectiveType: connection.effectiveType ?? null,
        downlink: connection.downlink ?? null,
        rtt: connection.rtt ?? null,
        saveData: connection.saveData ?? null,
      } : null,
      maxTouchPoints: nav.maxTouchPoints,
      language: nav.language,
    };
  }

  /** 每条诊断记录都附带的轻量指标；只做整数统计和缓存读取，不遍历纹理之外的集合。 */
  readonly metrics = (): Record<string, unknown> => ({
    frames: this.frameStats.snapshot(),
    heap: this.memoryUsage(),
    textures: this.textureDiagnostics(),
    renderer: this.rendererDiagnostics(),
    screen: {
      width: typeof innerWidth === 'number' ? innerWidth : null,
      height: typeof innerHeight === 'number' ? innerHeight : null,
      pixelRatio: typeof devicePixelRatio === 'number' ? devicePixelRatio : null,
      refreshHz: currentRefreshRate(),
      orientation: typeof screen === 'undefined' ? null : screen.orientation?.type ?? null,
      visualScale: typeof visualViewport === 'undefined' ? null : visualViewport?.scale ?? null,
    },
    settings: {
      frameRateLimit: displaySettings.frameRateLimit,
      renderScale: displaySettings.renderScale,
      fpsReadout: displaySettings.fps,
      textureBatching: displaySettings.textureBatching,
    },
    document: {
      hidden: typeof document === 'undefined' ? false : document.hidden,
      focused: typeof document === 'undefined' || typeof document.hasFocus !== 'function' ? false : document.hasFocus(),
    },
    storage: this.storageDiagnostics(),
    ...this.navigatorMetrics(),
  });

  /** 心跳只带少量状态，避免每分钟复制一份完整战斗现场。 */
  compact(): Record<string, unknown> {
    const { app, worldScene } = this.host;
    const session = app.session;
    const scene = worldScene();
    const location = session?.storyWorld.currentLocation;
    return {
      mode: app.mode,
      map: scene?.map?.id ?? location?.map ?? null,
      location: location ? { x: Math.round(location.x), y: Math.round(location.y), facing: location.facing } : null,
      player: session?.player ? { health: session.player.health, mana: session.player.mana } : null,
      quest: session?.currentQuest()?.id ?? null,
      locked: app.locked,
      lockOwners: app.lockOwners,
      menuOpen: app.menuOpen,
      storyBusy: app.director?.busy ?? false,
      saveSlot: app.saveSlot ?? null,
    };
  }

  /** 每分钟检查一次：明显掉帧才上报；在游戏世界内每分钟发一条心跳。 */
  readonly tick = (): void => {
    const { app, worldScene } = this.host;
    const framesNow = this.frameStats.snapshot();
    const longDelta = framesNow.longFrames - this.diagnosticLongFrames;
    const frameDelta = framesNow.frames - this.diagnosticFrames;
    this.diagnosticLongFrames = framesNow.longFrames;
    this.diagnosticFrames = framesNow.frames;
    const target = displaySettings.frameRateLimit;
    const now = this.now();
    // 切后台或长停顿后窗口里可能只有帧间隔、还没有每秒帧率样本；此时 avg/min 都是 0，
    // 不能当成明显掉帧，否则会写一条假记录并占掉接下来 5 分钟的上报额度。
    const degraded = framesNow.samples >= 30 && framesNow.secondSamples > 0 && frameDelta > 0
      && (framesNow.avgFps < target * 0.8 || framesNow.minFps < target * 0.5 || longDelta >= 5);
    if (degraded && now - this.lastLowFpsAt > LOW_FPS_COOLDOWN_MS) {
      this.lastLowFpsAt = now;
      const location = app.session?.storyWorld.currentLocation;
      globalThis.storyDiagnostics?.record('performance-low-fps', {
        target,
        fps: framesNow.fps,
        avgFps: framesNow.avgFps,
        minFps: framesNow.minFps,
        longFrames: longDelta,
        frames: frameDelta,
        maxFrameMs: framesNow.maxFrameMs,
        p95FrameMs: framesNow.p95FrameMs,
        map: location?.map ?? null,
        mode: app.mode,
      }, false);
    }
    this.heartbeatIndex += 1;
    const inWorld = app.mode === 'game' && !!worldScene();
    if (!inWorld && this.heartbeatIndex % 5 !== 0) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    globalThis.storyDiagnostics?.record('heartbeat', this.compact(), false);
  };

  readonly snapshot = (): Record<string, unknown> => {
    const { app, game, worldScene, gmOn, editingText } = this.host;
    const session = app.session;
    const party = session?.party;
    const sound = game()?.sound;
    const context = sound?.context;
    const sounds = sound?.getAll('') ?? []; // NoAudioSoundManager 的类型声明要求传入 key。
    const viewport = typeof visualViewport === 'undefined' ? null : visualViewport;
    return {
      mode: app.mode,
      ready: app.ready,
      locked: app.locked,
      lockOwners: app.lockOwners,
      saveSlot: app.saveSlot ?? null,
      saveFormat: SAVE_FORMAT,
      pressureMode: app.pressureMode,
      pressureSettings: app.pressureMode ? app.pressureSettings : undefined,
      gm: gmOn(),
      trustedContent: app.trustedContent,
      input: {
        editingText: editingText(),
        visualViewport: viewport ? {
          width: viewport.width,
          height: viewport.height,
          scale: viewport.scale,
          offsetTop: viewport.offsetTop,
        } : null,
      },
      suspended: app.suspended,
      defeatOpen: app.defeatOpen,
      menuOpen: app.menuOpen,
      dialogue: app.dialogueOpen,
      choice: app.choiceOpen,
      questPopup: app.questPopupOpen,
      editingControls: app.controlLayoutEditing,
      editingKeys: app.keyBindingEditing,
      loading: app.loadingLabel,
      location: session?.storyWorld.currentLocation,
      player: session?.player,
      combatTick: session?.combatTick,
      session: session ? {
        nowMs: session.nowMs,
        combatTick: session.combatTick,
        money: session.money,
        partyItemChance: session.partyItemChance,
        currentQuest: session.currentQuest()?.id ?? null,
        bagEntries: session.bag.entries.length,
        party: party ? {
          controlled: party.controlledId,
          active: party.activeIds,
          reserves: party.snapshot().reserves,
          rosterSlots: party.snapshot().rosterSlots,
        } : null,
      } : null,
      audio: app.audio ? {
        ...app.audio.captureStoryAudio(),
        settings: app.audio.settings,
        contextState: context?.state ?? null,
        managerLocked: sound?.locked ?? null,
        managerMuted: sound?.mute ?? null,
        playing: sounds.filter(item => item.isPlaying).map(item => item.key),
        paused: sounds.filter(item => item.isPaused).map(item => item.key),
      } : null,
      world: worldScene()?.diagnosticSnapshot(),
      story: app.director ? {
        busy: app.director.busy,
        runs: app.director.runtime.snapshot().runs
          .filter(run => run.status !== 'completed')
          .map(run => ({ event: run.eventId, cursor: run.cursor, status: run.status, encounter: run.waiting?.encounter })),
      } : null,
    };
  };

  /** 挂接全局快照、指标回调和每分钟心跳定时器；返回一次性清理句柄。 */
  install(intervalMs = 60_000): () => void {
    const clearSnapshot = installDiagnosticSnapshot(this.snapshot);
    const clearMetrics = installDiagnosticMetrics(this.metrics);
    const timer = globalThis.setInterval(this.tick, intervalMs);
    return () => {
      clearSnapshot();
      clearMetrics();
      globalThis.clearInterval(timer);
    };
  }
}
