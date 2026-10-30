import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import type Phaser from 'phaser';
import { GameAudio, type AudioCatalog } from '../src/application/game-audio.ts';

const catalog = JSON.parse(readFileSync(new URL('../public/content/audio.json', import.meta.url), 'utf8')) as AudioCatalog;

function harness(options: { suspended?: () => boolean } = {}) {
  const cache = new Set<string>();
  const queued: string[] = [];
  /** 所有被 loader 请求过的 key，用来断言缓存命中后不再重新加载。 */
  const requested: string[] = [];
  /** 每次 loader.start() 处理掉的文件数，用来确认预加载分了批。 */
  const batches: number[] = [];
  /** 一次性音效的播放记录；循环音频走 sound.add()，不进这里。 */
  const played: string[] = [];
  const sounds: { key: string; isPlaying: boolean; destroyed: boolean; volume: number; setVolume(value: number): void }[] = [];
  let sinceStart = 0;
  const loader = Object.assign(new EventEmitter(), {
    audio(key: string) { requested.push(key); queued.push(key); sinceStart++; },
    start() { batches.push(sinceStart); sinceStart = 0; },
  });
  const scene = {
    load: loader,
    cache: { audio: { exists: (key: string) => cache.has(key), remove: (key: string) => cache.delete(key) } },
    sound: {
      stopAll(){for(const sound of sounds)sound.isPlaying=false;},
      add(key: string) {
        assert.ok(cache.has(key));
        const sound = {
          key, isPlaying: false, destroyed: false, volume: 1,
          play() { this.isPlaying = true; },
          pause() { this.isPlaying = false; },
          stop() { this.isPlaying = false; },
          setVolume(value: number) { this.volume = value; },
          destroy() { this.destroyed = true; },
        };
        sounds.push(sound);
        return sound;
      },
      play(key: string) {
        assert.ok(cache.has(key), `音效未加载就播放：${key}`);
        played.push(key);
      },
    },
  };
  const finish = async () => {
    for (const key of queued.splice(0)) cache.add(key);
    loader.emit('complete');
    await setImmediate();
  };
  return {
    audio: new GameAudio(scene as unknown as Phaser.Scene, catalog, options.suspended ?? (() => false)),
    sounds,
    batches,
    played,
    cachedKeys: () => new Set(cache),
    playing: () => sounds.filter(sound => sound.isPlaying).map(sound => sound.key),
    requested: () => [...requested],
    async finishLoading() {
      await setImmediate();
      await finish();
    },
    /** 反复推进 loader，直到没有排队中的文件；分批预加载要调用多次。 */
    async drain() {
      await setImmediate();
      for (let guard = 0; queued.length && guard < 200; guard++) await finish();
    },
  };
}

test('native stop-all clears loops and cancels late sound playback',async()=>{
  const f=harness();f.audio.enterMenu();await f.drain();
  assert(f.playing().length);
  f.audio.effect(catalog.ui.questStart);
  f.audio.stopStoryAudio();await f.drain();
  assert.deepEqual(f.playing(),[]);
  assert.deepEqual(f.played,[]);
  assert.deepEqual(f.audio.captureStoryAudio(),{music:null,ambience:null});
});

test('story audio restores actual loop choices and abandons late cinematic music loads', async () => {
  const f = harness();
  const [mapId, map] = Object.entries(catalog.maps).find(([, entry]) => entry.music)!;
  f.audio.enterMap(mapId); await f.drain();
  const saved = f.audio.captureStoryAudio();
  assert.deepEqual(saved, { music: map.music, ambience: map.ambience });
  // This map keeps the current music; guessing from its map entry loses the actual track.
  f.audio.enterMap('shadow-camp'); await f.drain();
  assert.equal(f.audio.captureStoryAudio().music, saved.music);
  const other = Object.keys(catalog.music).find(id => id !== saved.music)!;
  f.audio.setStoryMusic(other);
  f.audio.restoreStoryAudio(saved);
  await f.drain();
  assert.deepEqual(f.playing().filter(key => key.startsWith('bgm:')), [`bgm:${saved.music}`]);
  assert.deepEqual(f.audio.captureStoryAudio(), saved);
  assert.throws(() => f.audio.restoreStoryAudio({ music: null, ambience: 'unknown' }), /环境音不存在/);
  assert.deepEqual(f.audio.captureStoryAudio(), saved, 'invalid restore does not partially stop the live music');
  saved.music = null;
  assert.equal(f.audio.captureStoryAudio().music, map.music, 'snapshots cannot mutate live loop state');
  f.audio.setStoryMusic(null); assert.deepEqual(f.playing().filter(key => key.startsWith('bgm:')), []);
});

test('story entry stops menu music; maps retain only story music and returning to menu restores its theme', async () => {
  const f = harness();
  f.audio.enterMenu(); await f.finishLoading();
  const theme = f.sounds[0];
  assert.deepEqual(f.playing(), [`bgm:${catalog.menuMusic}`]);
  f.audio.enterMenu(); await f.finishLoading();
  assert.equal(f.sounds.length, 1);

  f.audio.enterStory();
  assert.equal(theme.destroyed, true);
  assert.deepEqual(f.playing(), []);
  f.audio.enterMap('shadow-camp'); await f.finishLoading();
  assert.deepEqual(f.playing(), [`se:${catalog.maps['shadow-camp'].ambience}`]);

  const [mapId, map] = Object.entries(catalog.maps).find(([, entry]) => entry.music)!;
  f.audio.enterMap(mapId); await f.finishLoading();
  assert.ok(f.playing().includes(`bgm:${map.music}`));
  f.audio.enterMap('shadow-camp'); await f.finishLoading();
  assert.ok(f.playing().includes(`bgm:${map.music}`));

  f.audio.enterMenu(); await f.finishLoading();
  assert.deepEqual(f.playing(), [`bgm:${catalog.menuMusic}`]);
});

test('环境音编号 255 表示不更换，进入没有环境音配置的地图不会停掉当前循环', async () => {
  const f = harness();
  const ambience = catalog.maps['shadow-camp'].ambience;
  assert.ok(ambience);
  const keepsAmbience = Object.entries(catalog.maps).find(([, entry]) => !entry.ambience);
  assert.ok(keepsAmbience);
  f.audio.enterMap('shadow-camp'); await f.drain();
  assert.deepEqual(f.playing(), [`se:${ambience}`]);

  f.audio.enterMap(keepsAmbience[0]); await f.drain();
  assert.deepEqual(f.playing().filter(key => key.startsWith('se:')), [`se:${ambience}`]);
  assert.equal(f.audio.captureStoryAudio().ambience, ambience);
});

test('a menu track that finishes loading after story entry cannot start during the opening', async () => {
  const f = harness();
  f.audio.enterMenu();
  await setImmediate();
  f.audio.enterStory();
  f.audio.enterMap('shadow-camp');
  await f.finishLoading();
  await f.finishLoading();
  assert.deepEqual(f.playing(), [`se:${catalog.maps['shadow-camp'].ambience}`]);
  assert.ok(f.sounds.every(sound => !sound.key.startsWith('bgm:')));

  f.audio.enterMenu(); await f.finishLoading();
  assert.deepEqual(f.playing(), [`bgm:${catalog.menuMusic}`]);
});

const effectName = 'UI_Menu_select';

test('第一次触发的音效在加载完成后补播，而不是被丢掉', async () => {
  const f = harness();
  f.audio.effect(effectName);
  assert.deepEqual(f.played, [], '加载完成前不播放');
  await f.drain();
  assert.deepEqual(f.played, [`se:${effectName}`]);
});

test('同一次加载期间重复触发只补播一次', async () => {
  const f = harness();
  f.audio.effect(effectName); f.audio.effect(effectName); f.audio.effect(effectName);
  await f.drain();
  assert.deepEqual(f.played, [`se:${effectName}`]);
  assert.deepEqual(f.batches, [1], '同名音效只排一次加载');
});

test('已加载的音效立即播放，且不再重新加载', async () => {
  const f = harness();
  f.audio.effect(effectName); await f.drain();
  const batches = f.batches.length;
  f.audio.effect(effectName);
  assert.deepEqual(f.played, [`se:${effectName}`, `se:${effectName}`], '缓存命中当帧播放');
  assert.equal(f.batches.length, batches, '缓存命中不重新加载');
});

test('换图或进入剧情后，此前的冷音效不再补播', async () => {
  const mapChange = harness();
  mapChange.audio.effect(effectName);
  mapChange.audio.enterMap('shadow-camp');
  await mapChange.drain();
  assert.deepEqual(mapChange.played, []);

  const storyEntry = harness();
  storyEntry.audio.effect(effectName);
  storyEntry.audio.enterStory();
  await storyEntry.drain();
  assert.deepEqual(storyEntry.played, []);
});

test('加载完成时音效开关已关或已挂起，都不补播', async () => {
  const muted = harness();
  muted.audio.effect(effectName);
  muted.audio.setVolume('effects', 0);
  await muted.drain();
  assert.deepEqual(muted.played, []);

  const suspended = harness({ suspended: () => true });
  suspended.audio.effect(effectName);
  await suspended.drain();
  assert.deepEqual(suspended.played, []);
});

test('预加载按批排队，冷音效最多只等一批', async () => {
  const f = harness();
  const pending = f.audio.prepareCombat(Object.keys(catalog.skills), Object.values(catalog.skills));
  await f.drain();
  await pending;
  assert.ok(f.batches.length > 1, '预加载分了批');
  assert.ok(f.batches.every(count => count > 0 && count <= 6), `每批不超过 6 个：${f.batches.join(',')}`);
  assert.deepEqual(f.played, [], '预加载不发声');
});

test('战斗音效预加载覆盖运行时能触发的每一条音效', async () => {
  const battle = JSON.parse(readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8'));
  const sounds = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'sound' && typeof item === 'string') sounds.add(item);
      else walk(item);
    }
  };
  walk(battle);
  // 这条音效只在动作定义里出现，不在音频目录的技能索引里，是预加载最容易漏掉的一类。
  assert.ok(sounds.has('A_Skill_Attack01'));

  const f = harness();
  const pending = f.audio.prepareCombat(Object.keys(catalog.skills), sounds);
  await f.drain();
  await pending;
  const cached = f.cachedKeys();
  assert.deepEqual([...sounds].filter(name => catalog.effects[name] && !cached.has(`se:${name}`)), []);

  const weaponSounds = Object.values(catalog.combat.weapons)
    .flatMap(entry => [entry.critical, entry.blocked, ...entry.normal.map(cue => cue.sound), ...(entry.miss ? [entry.miss] : [])]);
  assert.deepEqual(weaponSounds.filter(name => name && !cached.has(`se:${name}`)), []);
});

test('keeps the previous BGM decoded so walking back does not reload it', async () => {
  const f=harness();
  const entries=Object.entries(catalog.maps).filter(([,entry])=>entry.music);
  const first=entries[0],second=entries.find(([,entry])=>entry.music!==first[1].music)!;
  assert.ok(second,'目录里至少要有两张不同 BGM 的地图');
  const firstKey=`bgm:${first[1].music}`;
  f.audio.enterMap(first[0]);await f.drain();
  assert.ok(f.cachedKeys().has(firstKey));
  f.audio.enterMap(second[0]);await f.drain();
  assert.ok(f.cachedKeys().has(firstKey),'上一首 BGM 仍保留在缓存里');
  const requests=f.requested().filter(key=>key===firstKey).length;
  f.audio.enterMap(first[0]);await f.drain();
  assert.equal(f.requested().filter(key=>key===firstKey).length,requests,'回到上一张图不再重新加载');
  assert.ok(f.playing().includes(firstKey));
});

test('retains only one previous BGM and releases retained music when disabled', async () => {
  const f=harness();
  const tracks=[...new Set(Object.values(catalog.maps).map(entry=>entry.music).filter((id):id is string=>!!id))];
  const maps=tracks.slice(0,3).map(id=>Object.entries(catalog.maps).find(([,entry])=>entry.music===id)!);
  assert.equal(maps.length,3,'目录里至少要有三首地图 BGM');
  for(const [mapId] of maps){f.audio.enterMap(mapId);await f.drain();}
  assert.ok(f.cachedKeys().has(`bgm:${maps[1][1].music}`),'上一首保留');
  assert.ok(!f.cachedKeys().has(`bgm:${maps[0][1].music}`),'更早的释放');
  f.audio.setVolume('music',0);
  assert.ok(![...f.cachedKeys()].some(key=>key.startsWith('bgm:')),'音乐音量为 0 后释放所有 BGM 缓存');
});

test('volume changes update the live loop without restarting it', async () => {
  const f=harness();
  f.audio.enterMenu();await f.drain();
  const music=f.sounds.find(sound=>sound.key===`bgm:${catalog.menuMusic}`)!;
  f.audio.setVolume('music',0.5);
  assert.equal(music.volume,0.325);
  assert.equal(f.sounds.length,1,'只改音量，不重建循环');
  assert.ok(f.playing().includes(music.key));
});

test('zero effects volume suppresses sound effects', async () => {
  const f=harness();
  f.audio.setVolume('effects',0);
  f.audio.effect(catalog.ui.questStart);
  await f.drain();
  assert.deepEqual(f.played,[]);
});
