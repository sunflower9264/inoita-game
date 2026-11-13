import { SCENE_KEYS } from '../application/scene-keys.ts';
import Phaser from 'phaser';
import { AUDIO_CATALOG_VERSION, GameAudio, type AudioCatalog } from '../application/game-audio.ts';
import type { StoryApp } from '../app.ts';
import { versionedContent } from '../application/asset-version.ts';

/** Always active so scene transitions do not interrupt audio loading or playback. */
export class AudioScene extends Phaser.Scene {
  private readonly app: StoryApp;
  constructor(app: StoryApp) { super(SCENE_KEYS.audio); this.app = app; }
  preload(): void { this.load.json('game-audio-catalog', versionedContent('content/audio.json')); }
  create(): void {
    const catalog = this.cache.json.get('game-audio-catalog') as AudioCatalog | undefined;
    if (!catalog || catalog.version !== AUDIO_CATALOG_VERSION) throw new Error('音频目录无法加载');
    this.app.audio = new GameAudio(this, catalog, () => this.app.suspended);
    window.dispatchEvent(new Event('game-audio-settings'));
    if (this.app.mode === 'game') {
      this.app.audio.enterStory();
      const world = this.app.game?.scene.getScene(SCENE_KEYS.world) as { map?: { id: string } } | undefined;
      if (world?.map) this.app.audio.enterMap(world.map.id);
    } else this.app.audio.enterMenu();
    void this.app.audio.prepareUi();
  }
}
