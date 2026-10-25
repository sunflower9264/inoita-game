import type { PhysicalHit } from '../domain/physical-hit.ts';
import { versionedAsset } from './asset-version.ts';
import type Phaser from 'phaser';

export interface AudioCatalog {
  version: 3;
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

interface AudioPreferences { music: boolean; effects: boolean }
/** 保留上一首 BGM 的解码缓存：往回走一张图时不用重新解码（约 25 MB/首）。 */
const MUSIC_CACHE_RETENTION = 1;
export interface StoryAudioState { music: string | null; ambience: string | null }
const STORAGE_KEY = 'inotia4.audio.v1';
/** 升级音效不在目录结构的任何索引里，只能按资源名直接引用。 */
const LEVEL_UP_EFFECT = 'Common_LevelUp';
/** 预加载分批大小：批次越短，加载期间到达的冷音效排在队尾的时间越短。 */
const PRELOAD_BATCH = 6;

function preferences(): AudioPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { music: saved.music !== false, effects: saved.effects !== false };
  } catch { return { music: true, effects: true }; }
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
    this.isSuspended = isSuspended;
    this.scene.load.maxParallelDownloads = 2;
  }

  setEnabled(channel: keyof AudioPreferences, enabled: boolean): void {
    if (this.settings[channel] === enabled) return;
    this.settings[channel] = enabled;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* private browsing */ }
    if (channel === 'music') this.applyLoop('music');
    else this.applyLoop('ambience');
  }

  enterMenu(): void {
    this.contextRevision++;
    this.setLoop('music', this.catalog.menuMusic);
    this.setLoop('ambience', null);
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
    this.scene.sound.stopAll();
  }

  effect(name: string | null | undefined): void {
    if (!name || !this.settings.effects || !this.catalog.effects[name]) return;
    const key = `se:${name}`;
    if (this.scene.cache.audio.exists(key)) {
      if (!this.isSuspended()) this.scene.sound.play(key, { volume: 0.75 });
      return;
    }
    // 音效要等到加载完成才响；同一次加载期间重复触发只补播一次，免得到货瞬间叠放几遍。
    if (this.replayQueued.has(key)) return;
    this.replayQueued.add(key);
    const context = this.contextRevision;
    void this.load(key, this.catalog.effects[name]).then(loaded => {
      this.replayQueued.delete(key);
      if (loaded && context === this.contextRevision && this.settings.effects && !this.isSuspended())
        this.scene.sound.play(key, { volume: 0.75 });
    });
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
    let roll=crypto.getRandomValues(new Uint32Array(1))[0]/4294967296*total;
    for(const cue of entry.normal){roll-=cue.weight;if(roll<0){this.effect(cue.sound);break;}}
  }
  shieldBlock():void {this.effect(this.catalog.combat.shieldBlock);}
  periodicDamage():void {this.effect(this.catalog.combat.periodicDamage);}
  playerLevelUp():void {this.effect(LEVEL_UP_EFFECT);}
  playerSkill(id: string): void { this.effect(this.catalog.skills[id]); }
  monsterAttack(id: string): void { this.effect(this.catalog.enemies[id]?.attack); }
  monsterDeath(id: string): void { this.effect(this.catalog.enemies[id]?.death); }

  /**
   * 进入战斗前预加载战斗音效：固定战斗音效、全部武器反馈、全部怪物攻击／死亡／受击，
   * 加上参战职业的技能音效与技能动作自带的分支音效（动作单元、派发收尾、时间轴反馈）。
   *
   * 武器与怪物按目录全量取；技能音效只能由战斗层按参战职业给出。
   */
  prepareCombat(skillIds: Iterable<string | null | undefined>, actionSounds: Iterable<string | null | undefined> = []): Promise<void> {
    return this.prepare([
      LEVEL_UP_EFFECT, this.catalog.combat.shieldBlock, this.catalog.combat.periodicDamage,
      ...Object.values(this.catalog.combat.weapons).flatMap(entry =>
        [entry.critical, entry.blocked, ...entry.normal.map(cue => cue.sound), ...(entry.miss ? [entry.miss] : [])]),
      ...Object.values(this.catalog.enemies).flatMap(entry => Object.values(entry)),
      ...[...skillIds].map(id => id ? this.catalog.skills[id] : undefined),
      ...actionSounds
    ]);
  }

  prepareUi(): Promise<void> { return this.prepare(Object.values(this.catalog.ui)); }

  /** 剧情 `sound` 动作引用的是 `audio.json effects`，进图前一并装好，第一次播放不再等加载。 */
  prepareStoryEffects(names: Iterable<string | null | undefined>): Promise<void> { return this.prepare(names); }

  /** 按批预加载音效名；分批让加载期间到达的冷音效最多只等一批，而不是等整批排干。 */
  private async prepare(names: Iterable<string | null | undefined>): Promise<void> {
    const wanted = [...new Set([...names].filter((name): name is string => !!name && !!this.catalog.effects[name]))];
    for (let index = 0; index < wanted.length; index += PRELOAD_BATCH)
      await Promise.all(wanted.slice(index, index + PRELOAD_BATCH).map(name => this.load(`se:${name}`, this.catalog.effects[name])));
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
    const enabled = music ? this.settings.music : this.settings.effects;
    const path = id && (music ? this.catalog.music[id] : this.catalog.effects[id]);
    const key = enabled && id && path ? `${music ? 'bgm' : 'se'}:${id}` : undefined;
    current?.stop(); current?.destroy();
    if (music) { this.music = undefined; this.playingMusicKey = undefined; }
    else { this.ambience = undefined; this.playingAmbienceKey = undefined; }
    // 马上要播的这一首不算历史；否则 A→B→A 会在加载前先把 A 淘汰掉。
    if (music && key) this.dropRetainedMusic(key);
    // 解码后的 BGM 很大，但往回切图很常见；保留上一首，超出的再释放。
    if (previousKey) {
      if (music) this.retainMusic(previousKey);
      else this.scene.cache.audio.remove(previousKey);
    }
    if (!key || !path) { if (music && !enabled) this.releaseRetainedMusic(); return; }
    void this.load(key, path).then(loaded => {
      if (!loaded || revision !== (music ? this.musicRevision : this.ambienceRevision) ||
          !(music ? this.settings.music : this.settings.effects)) return;
      const sound = this.scene.sound.add(key, { loop: true, volume: music ? 0.65 : 0.45 });
      if (music) { this.music = sound; this.playingMusicKey = key; this.dropRetainedMusic(key); }
      else { this.ambience = sound; this.playingAmbienceKey = key; }
      sound.play();
      if (this.isSuspended()) sound.pause();
    });
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
          this.failedUntil.set(key, Date.now() + 5000);
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
