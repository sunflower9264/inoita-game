import type { SaveStorage } from '../domain/save-game.ts';

/**
 * GM（调试）开关的本地持久化。**默认关闭**，且明文可见——它是开发开关，不是需要隐藏的秘密。
 *
 * 键与存档（`inotia4.story.v1.slot0`）、音频设置（`inotia4.audio.v1`）同一套命名，但单独一个
 * 前缀：调试开关不该混进存档键空间，玩家清存档也不该顺手把它清掉。
 *
 * 读失败（隐私模式、浏览器禁用存储）一律当关闭；写失败只保留本次运行内的值并报出来，
 * 不抛给调用方——一个调试开关不该让游戏启动失败。
 */
const GM_KEY = 'inotia4.gm.v1.enabled';

/** 没有可写存储时的替身：读为空、写静默丢弃。 */
const volatileStorage: SaveStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

export function defaultGmStorage(): SaveStorage {
  return typeof localStorage === 'undefined' ? volatileStorage : localStorage;
}

export class GmMode {
  private readonly storage: SaveStorage;
  private value: boolean;

  constructor(storage?: SaveStorage) {
    this.storage = storage ?? defaultGmStorage();
    const raw = this.read();
    this.value = raw === 'on';
  }

  get on(): boolean { return this.value; }

  set(on: boolean): boolean {
    this.value = on;
    // 写不进去时（隐私模式）只影响刷新后的保留，不影响本次运行。
    try { on ? this.storage.setItem(GM_KEY, 'on') : this.storage.removeItem(GM_KEY); }
    catch { /* 一个调试开关不该让游戏启动失败 */ }
    return this.value;
  }
  toggle(): boolean { return this.set(!this.value); }

  private read(): string | null {
    try { return this.storage.getItem(GM_KEY); }
    catch { return null; }
  }
}
