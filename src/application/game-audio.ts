import type { PhysicalHit } from '../domain/physical-hit.ts';
import { versionedAsset } from './asset-version.ts';
import type Phaser from 'phaser';

/** 音频目录结构版本；内容 JSON 与运行时必须一致，改结构时加一。 */
export const AUDIO_CATALOG_VERSION = 3;

export interface AudioCatalog {
  version: typeof AUDIO_CATALOG_VERSION;
  music: Record<string, string>;
  effects: Record<string, string>;
  menuMusic: string;
  maps: Record<string, { music: string | null; ambience: string | null }>;
  enemies: Record<string, { attack: string | null; death: string | null; struck:string|null }>;
  combat:{weapons:Record<string,{normal:{sound:string;weight:number}[];critical:string;miss:string|null;blocked:string}>;shieldBlock:string;periodicDamage:string};
  skills: Record<string, string>;
  ui: Record<'open' | 'move' | 'select' | 'questStart' | 'questComplete' | 'heal' | 'loot' | 'itemMove' | 'chestOpen' | 'enchant' | 'craft', string>;
  unbound: string[];
}

/** 两个通道各自保存 0–1 的音量；0 表示静音。 */
interface AudioPreferences { music: number; effects: number }
/** 保留上一首 BGM 的解码缓存：往回走一张图时不用重新解码（约 25 MB/首）。 */
const MUSIC_CACHE_RETENTION = 1;
export interface StoryAudioState { music: string | null; ambience: string | null }
const STORAGE_KEY = 'inotia4.audio.v1';
/** 升级音效不在目录结构的任何索引里，只能按资源名直接引用。 */
const LEVEL_UP_EFFECT = 'Common_LevelUp';
/** 预加载分批大小：批次越短，加载期间到达的冷音效排在队尾的时间越短。 */
const PRELOAD_BATCH = 6;
/** 音效缓存键前缀：加载器与 BGM 共用同一个音频缓存，靠它区分一次性音效。 */
const EFFECT_KEY_PREFIX = 'se:';
/** 通道主音量：音乐和氛围声压低，给界面与战斗音效留动态范围。 */
const MUSIC_MASTER_VOLUME = 0.65;
const AMBIENCE_MASTER_VOLUME = 0.45;
/** 一次性音效的主音量。 */
const EFFECT_MASTER_VOLUME = 0.75;
/** 32 位无符号随机数的取值个数；用它把随机整数换算成 0–1 的比例。 */
const UINT32_RANGE = 2 ** 32;
/** 音效加载失败后冷却这么久再允许重试，避免每次触发都重新排队。 */
const FAILED_SOUND_RETRY_MS = 5000;

/** 兼容旧存档：布尔值 true/false 分别迁到满音量和静音。 */
function volumeOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(1, Math.max(0, value));
  return value === false ? 0 : 1;
}

function preferences(): AudioPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { music: volumeOf(saved.music), effects: volumeOf(saved.effects) };
  } catch { return { music: 1, effects: 1 }; }
}

/** The audio scene owns loading; Phaser's SoundManager owns playback across scene changes. */
export class GameAudio {
  readonly catalog: AudioCatalog;
  readonly settings = preferences();
  private readonly scene: Phaser.Scene;
  private readonly isSuspended: () => boolean;
  private readonly pending = new Map<string, Promise<boolean>>();
  /** 已停止但仍保留在缓存里的 BGM key（最多 MUSIC_CACHE_RETENTION 首）。 */
  private readonly retainedMusic: string[] = [];
  private readonly queued = new Map<string, { path: string; resolve: (loaded: boolean) => void }>();
  /** 正在等待加载完成、准备补播的音效；同一条只补播一次。 */
  private readonly replayQueued = new Set<string>();
  private readonly residentEffects: Set<string>;
  private combatEffects = new Set<string>();
  private storyEffects = new Set<string>();
  private readonly loadedEffects = new Set<string>();
  private readonly playingEffects = new Map<string, Set<Phaser.Sound.BaseSound>>();
  private loading = false;
  private scheduled = false;
  private music?: Phaser.Sound.BaseSound;
  private ambience?: Phaser.Sound.BaseSound;
  private playingMusicKey?: string;
  private playingAmbienceKey?: string;
  private musicId: string | null = null;
  private ambienceId: string | null = null;
  private musicRevision = 0;
  private ambienceRevision = 0;
  /** 每次切换菜单、故事或地图都递增；未加载完的音效据此放弃补播。 */
  private contextRevision = 0;
  private readonly failedUntil = new Map<string, number>();

  constructor(scene: Phaser.Scene, catalog: AudioCatalog, isSuspended: () => boolean) {
    this.scene = scene;
    this.catalog = catalog;
    this.residentEffects = new Set([
      ...Object.values(catalog.ui), LEVEL_UP_EFFECT, catalog.combat.shieldBlock, catalog.combat.periodicDamage,
    ].filter(name => !!catalog.effects[name]).map(name => `${EFFECT_KEY_PREFIX}${name}`));
    this.isSuspended = isSuspended;
    this.scene.load.maxParallelDownloads = 2;
  }

  /** 设置通道音量；0 等价于以前的“关闭”，会停掉对应循环并释放缓存。 */
  setVolume(channel: keyof AudioPreferences, value: number): void {
    const next = volumeOf(value);
    const previous = this.settings[channel];
    if (previous === next) return;
    this.settings[channel] = next;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* private browsing */ }
    if (channel === 'music') {
      if (previous <= 0 || next <= 0) this.applyLoop('music');
      else this.setSoundVolume(this.music, MUSIC_MASTER_VOLUME * next);
    } else {
      if (previous <= 0 || next <= 0) this.applyLoop('ambience');
      else this.setSoundVolume(this.ambience, AMBIENCE_MASTER_VOLUME * next);
    }
  }

  private setSoundVolume(sound: Phaser.Sound.BaseSound | undefined, volume: number): void {
    (sound as { setVolume?(value: number): unknown } | undefined)?.setVolume?.(volume);
  }

  enterMenu(): void {
    this.contextRevision++;
    this.combatEffects = new Set();
    this.storyEffects = new Set();
    this.setLoop('music', this.catalog.menuMusic);
    this.setLoop('ambience', null);
    this.releaseRetainedMusic();
    this.releaseUnusedEffects();
  }

  enterStory(): void {
    this.contextRevision++;
    this.setLoop('music', null);
    this.setLoop('ambience', null);
  }

  enterMap(mapId: string): void {
    const entry = this.catalog.maps[mapId];
    if (!entry) return;
    this.contextRevision++;
    // 原版地图记录里两个字节都用 255 表示「不更换」：BGM 是越界编号被
    // `SOUNDSYSTEM_PlayBGM_IPHONE` 拒绝，环境音是 `Play_BGM_AMBIENT_CURRENT`
    // 整段跳过。导出时 255 变成 null，所以 null 只能表示保留，不能表示停止。
    if (entry.music) this.setLoop('music', entry.music);
    if (entry.ambience) this.setLoop('ambience', entry.ambience);
  }

  captureStoryAudio(): StoryAudioState { return { music: this.musicId, ambience: this.ambienceId }; }

  restoreStoryAudio(state: StoryAudioState): void {
    if (state.music !== null && !this.catalog.music[state.music]) throw new Error('剧情音乐不存在：' + state.music);
    if (state.ambience !== null && !this.catalog.effects[state.ambience]) throw new Error('剧情环境音不存在：' + state.ambience);
    this.contextRevision++;
    this.setLoop('music', state.music); this.setLoop('ambience', state.ambience);
  }

  setStoryMusic(sound: string | null): void {
    if (sound !== null && !this.catalog.music[sound]) throw new Error('剧情音乐不存在：' + sound);
    this.contextRevision++;
    this.setLoop('music', sound);
  }

  stopStoryAudio():void {
    this.restoreStoryAudio({music:null,ambience:null});
    // removeAll 会销毁声音对象；stopAll 只停不销毁，被打断的一次性音效会一直留在管理器里。
    this.scene.sound.removeAll();
  }

  effect(name: string | null | undefined): void {
    const volume = this.settings.effects;
    if (!name || volume <= 0 || !this.catalog.effects[name]) return;
    const key = `${EFFECT_KEY_PREFIX}${name}`;
    if (this.scene.cache.audio.exists(key)) {
      if (!this.isSuspended()) this.playEffect(key, volume);
      return;
    }
    // 音效要等到加载完成才响；同一次加载期间重复触发只补播一次，免得到货瞬间叠放几遍。
    if (this.replayQueued.has(key)) return;
    this.replayQueued.add(key);
    const context = this.contextRevision;
    void this.load(key, this.catalog.effects[name]).then(loaded => {
      this.replayQueued.delete(key);
      const current = this.settings.effects;
      if (loaded && context === this.contextRevision && current > 0 && !this.isSuspended())
        this.playEffect(key, current);
      if (loaded) this.releaseAbandonedKey(key);
    });
  }

  private playEffect(key: string, volume: number): void {
    const sound = this.scene.sound.add(key, { volume: EFFECT_MASTER_VOLUME * volume });
    let active = this.playingEffects.get(key);
    if (!active) this.playingEffects.set(key, active = new Set());
    active.add(sound);
    let finished = false;
    const finish = (destroy: boolean): void => {
      if (finished) return;
      finished = true;
      sound.off('complete', complete); sound.off('stop', stopped); sound.off('destroy', destroyed);
      active.delete(sound);
      if (!active.size) this.playingEffects.delete(key);
      if (destroy) sound.destroy();
      this.releaseAbandonedKey(key);
    };
    const complete = (): void => finish(true);
    // Phaser 的 destroy 会先同步发出 stop。停止只做记账，不能再调 destroy：
    // 否则内层销毁先把 muteNode 置空，外层继续 disconnect 就报 null。
    // 自然播完由 complete 负责销毁；外部停止的人（removeAll）自己会销毁。
    const stopped = (): void => finish(false);
    const destroyed = (): void => finish(false);
    sound.once('complete', complete); sound.once('stop', stopped); sound.once('destroy', destroyed);
    if (!sound.play()) complete();
  }

  ui(name: keyof AudioCatalog['ui']): void { this.effect(this.catalog.ui[name]); }
  playerHit(weaponKind:string,kind:PhysicalHit['kind'],targetEnemy?:string):void {
    const entry=this.catalog.combat.weapons[weaponKind]??this.catalog.combat.weapons.unarmed;
    if(kind==='miss'){this.effect(entry.miss);return;}
    const struck=targetEnemy&&this.catalog.enemies[targetEnemy]?.struck;
    if(struck){this.effect(struck);return;}
    if(kind==='critical'){this.effect(entry.critical);return;}
    if(kind!=='hit'){this.effect(entry.blocked);return;}
    const total=entry.normal.reduce((sum,cue)=>sum+cue.weight,0);
    let roll=crypto.getRandomValues(new Uint32Array(1))[0]/UINT32_RANGE*total;
    for(const cue of entry.normal){roll-=cue.weight;if(roll<0){this.effect(cue.sound);break;}}
  }
  shieldBlock():void {this.effect(this.catalog.combat.shieldBlock);}
  periodicDamage():void {this.effect(this.catalog.combat.periodicDamage);}
  playerLevelUp():void {this.effect(LEVEL_UP_EFFECT);}
  playerSkill(id: string): void { this.effect(this.catalog.skills[id]); }
  monsterAttack(id: string): void { this.effect(this.catalog.enemies[id]?.attack); }
  monsterDeath(id: string): void { this.effect(this.catalog.enemies[id]?.death); }

  /** 调用方提供当前整支队伍与地图的完整清单；替换时仍在播放的旧音效保留到结束。 */
  prepareCombat(skillIds: Iterable<string | null | undefined>, actionSounds: Iterable<string | null | undefined> = [],
    options: { weaponKinds?: Iterable<string>; enemyIds?: Iterable<string> } = {}): Promise<void> {
    return this.prepareEffects('combat', [
      ...[...(options.weaponKinds ?? [])].map(kind => this.catalog.combat.weapons[kind] ?? this.catalog.combat.weapons.unarmed).filter(Boolean).flatMap(entry =>
        [entry.critical, entry.blocked, ...entry.normal.map(cue => cue.sound), ...(entry.miss ? [entry.miss] : [])]),
      ...[...(options.enemyIds ?? [])].flatMap(id => Object.values(this.catalog.enemies[id] ?? {})),
      ...[...skillIds].map(id => id ? this.catalog.skills[id] : undefined),
      ...actionSounds
    ]);
  }

  prepareUi(): Promise<void> { return this.prepareKeys(this.residentEffects, () => true); }

  /** 剧情 `sound` 动作引用的是 `audio.json effects`，进图前一并装好，第一次播放不再等加载。 */
  prepareStoryEffects(names: Iterable<string | null | undefined>, signal?: AbortSignal): Promise<void> {
    return this.prepareEffects('story', names, signal);
  }

  private async prepareEffects(scope: 'combat' | 'story', names: Iterable<string | null | undefined>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const wanted = new Set([...names].filter((name): name is string => !!name && !!this.catalog.effects[name]).map(name => `${EFFECT_KEY_PREFIX}${name}`));
    if (scope === 'combat') this.combatEffects = wanted;
    else this.storyEffects = wanted;
    const current = (): boolean => !signal?.aborted && wanted === (scope === 'combat' ? this.combatEffects : this.storyEffects);
    const cancel = (): void => {
      if (wanted === (scope === 'combat' ? this.combatEffects : this.storyEffects)) {
        if (scope === 'combat') this.combatEffects = new Set();
        else this.storyEffects = new Set();
      }
      this.releaseUnusedEffects();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    this.releaseUnusedEffects();
    try { await this.prepareKeys(wanted, current); signal?.throwIfAborted(); }
    finally { signal?.removeEventListener('abort', cancel); }
  }

  /** 按批预加载音效名；分批让加载期间到达的冷音效最多只等一批，而不是等整批排干。 */
  private async prepareKeys(keys: Set<string>, current: () => boolean): Promise<void> {
    const wanted = [...keys];
    for (let index = 0; index < wanted.length && current(); index += PRELOAD_BATCH)
      await Promise.all(wanted.slice(index, index + PRELOAD_BATCH).map(async key => {
        await this.load(key, this.catalog.effects[key.slice(EFFECT_KEY_PREFIX.length)]);
        this.releaseAbandonedKey(key);
      }));
  }

  private releaseUnusedEffects(): void {
    for (const key of this.loadedEffects) this.releaseAbandonedKey(key);
  }

  private setLoop(channel: 'music' | 'ambience', id: string | null): void {
    if (channel === 'music') {
      if (this.musicId === id) return;
      this.musicId = id; this.musicRevision++;
    } else {
      if (this.ambienceId === id) return;
      this.ambienceId = id; this.ambienceRevision++;
    }
    this.applyLoop(channel);
  }

  private applyLoop(channel: 'music' | 'ambience'): void {
    const music = channel === 'music';
    const current = music ? this.music : this.ambience;
    const previousKey = music ? this.playingMusicKey : this.playingAmbienceKey;
    const id = music ? this.musicId : this.ambienceId;
    const revision = music ? ++this.musicRevision : ++this.ambienceRevision;
    const volume = music ? this.settings.music : this.settings.effects;
    const path = id && (music ? this.catalog.music[id] : this.catalog.effects[id]);
    const key = this.desiredKey(channel);
    current?.stop(); current?.destroy();
    if (music) { this.music = undefined; this.playingMusicKey = undefined; }
    else { this.ambience = undefined; this.playingAmbienceKey = undefined; }
    // 马上要播的这一首不算历史；否则 A→B→A 会在加载前先把 A 淘汰掉。
    if (music && key) this.dropRetainedMusic(key);
    // 解码后的 BGM 很大，但往回切图很常见；保留上一首，超出的再释放。
    if (previousKey) {
      if (music) this.retainMusic(previousKey);
      else this.releaseAbandonedKey(previousKey);
    }
    if (!key || !path) { if (music && volume <= 0) this.releaseRetainedMusic(); return; }
    void this.load(key, path).then(loaded => {
      const current = music ? this.settings.music : this.settings.effects;
      if (!loaded || revision !== (music ? this.musicRevision : this.ambienceRevision) || current <= 0) {
        // 本次不再播放：把刚解码出来、又没有其他主人的缓存一并释放。
        if (loaded) this.releaseAbandonedKey(key);
        return;
      }
      const sound = this.scene.sound.add(key, { loop: true, volume: music ? MUSIC_MASTER_VOLUME * current : AMBIENCE_MASTER_VOLUME * current });
      if (music) { this.music = sound; this.playingMusicKey = key; this.dropRetainedMusic(key); }
      else { this.ambience = sound; this.playingAmbienceKey = key; }
      sound.play();
      if (this.isSuspended()) sound.pause();
    });
  }

  /** 当前通道想播的缓存键；静音或没有配置时为空。 */
  private desiredKey(channel: 'music' | 'ambience'): string | undefined {
    const music = channel === 'music';
    const id = music ? this.musicId : this.ambienceId;
    const volume = music ? this.settings.music : this.settings.effects;
    const path = id && (music ? this.catalog.music[id] : this.catalog.effects[id]);
    return volume > 0 && id && path ? `${music ? 'bgm' : 'se'}:${id}` : undefined;
  }

  /**
   * 一次加载被放弃后释放它的解码缓存。仍在播、仍被当前通道需要、或留给回切的 key 不删。
   * 同一 key 可能被前后两代请求共用（A→B→A），所以按「现在还有谁要它」判断，而不是按 revision。
   */
  private releaseAbandonedKey(key: string): void {
    if (this.residentEffects.has(key) || this.combatEffects.has(key) || this.storyEffects.has(key)) return;
    if (this.playingEffects.get(key)?.size || this.replayQueued.has(key)) return;
    if (key === this.playingMusicKey || key === this.playingAmbienceKey) return;
    if (this.retainedMusic.includes(key)) return;
    if (key === this.desiredKey('music') || key === this.desiredKey('ambience')) return;
    if (this.scene.sound.getAll(key).some(sound => sound.isPlaying)) return;
    this.scene.cache.audio.remove(key);
    this.loadedEffects.delete(key);
  }

  private retainMusic(key: string): void {
    if (this.retainedMusic.includes(key)) return;
    if (this.playingMusicKey === key) return;
    this.retainedMusic.push(key);
    while (this.retainedMusic.length > MUSIC_CACHE_RETENTION) {
      const oldest = this.retainedMusic.shift()!;
      if (oldest !== this.playingMusicKey) this.scene.cache.audio.remove(oldest);
    }
  }
  private dropRetainedMusic(key: string): void {
    const index = this.retainedMusic.indexOf(key);
    if (index >= 0) this.retainedMusic.splice(index, 1);
  }
  private releaseRetainedMusic(): void {
    for (const key of this.retainedMusic.splice(0)) if (key !== this.playingMusicKey) this.scene.cache.audio.remove(key);
  }
  private load(key: string, path: string): Promise<boolean> {
    if (!path) return Promise.resolve(false);
    if (key.startsWith(EFFECT_KEY_PREFIX)) this.loadedEffects.add(key);
    if (this.scene.cache.audio.exists(key)) return Promise.resolve(true);
    if (Date.now() < (this.failedUntil.get(key) ?? 0)) return Promise.resolve(false);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const result = new Promise<boolean>(resolve => {
      this.queued.set(key, { path, resolve });
      this.schedule();
    });
    this.pending.set(key, result);
    void result.then(() => { if (this.pending.get(key) === result) this.pending.delete(key); });
    return result;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.flush(); });
  }

  private flush(): void {
    if (this.loading || !this.queued.size) return;
    const batch = [...this.queued];
    this.queued.clear();
    this.loading = true;
    const missing = batch.filter(([key]) => !this.scene.cache.audio.exists(key));
    if (!missing.length) {
      for (const [, request] of batch) request.resolve(true);
      this.loading = false; this.schedule(); return;
    }
    this.scene.load.once('complete', () => {
      for (const [key, request] of batch) {
        const loaded = this.scene.cache.audio.exists(key);
        if (!loaded) {
          this.failedUntil.set(key, Date.now() + FAILED_SOUND_RETRY_MS);
          console.warn(`音频资源加载失败：${request.path}`);
        }
        request.resolve(loaded);
      }
      this.loading = false;
      if (this.queued.size) this.schedule();
    });
    for (const [key, request] of missing) this.scene.load.audio(key, versionedAsset(request.path));
    this.scene.load.start();
  }
}
