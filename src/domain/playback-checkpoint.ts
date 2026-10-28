import type { SceneSnapshot } from './scene-snapshot.ts';
import type { StoryRuntimeSnapshot } from './story-runtime.ts';
import type { StoryStageSnapshot } from './story-performance.ts';

/**
 * 存档里的剧情检查点。
 *
 * 运行中的舞台快照会为每个演员缓存一份完整外观（`ActorDefinition` 含所有动画帧和图层），
 * 但这份外观能从世界角色、队伍装备和剧情外观覆盖重新算出来。存档只保留无法重建的
 * 演出状态（位置、朝向、显隐、姿态和镜头），外观在恢复时由舞台重新解析。
 *
 * 版本 3 表示这份快照已经去掉缓存外观；版本 2 是仍在运行的完整快照。
 */
export interface PlaybackCheckpoint extends Omit<StoryRuntimeSnapshot, 'version'> {
  version: 3;
}

/** 把运行中的剧情快照转成存档检查点；没有舞台时不改版本，也不复制演员外观。 */
export function toPlaybackCheckpoint(runtime: StoryRuntimeSnapshot): StoryRuntimeSnapshot {
  const checkpoint = structuredClone(runtime);
  let hasStage = false;
  for (const run of checkpoint.runs) {
    if (!run.stage) continue;
    hasStage = true;
    stripStageAppearance(run.stage);
  }
  if (hasStage) checkpoint.version = 3;
  return checkpoint;
}

function stripStageAppearance(stage: StoryStageSnapshot): void {
  stripSceneAppearance(stage.scene);
  for (const scene of stage.scenes ?? []) stripSceneAppearance(scene);
}

function stripSceneAppearance(scene: SceneSnapshot): void {
  for (const actor of scene.actors) delete actor.appearance;
}
