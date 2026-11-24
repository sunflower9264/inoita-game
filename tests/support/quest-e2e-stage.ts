import assert from 'node:assert/strict';
import { assertUniqueActorInstances } from '../../src/domain/actor-census.ts';
import { assertScenePlan, planScene } from '../../src/domain/scene-plan.ts';
import type { SceneSnapshot } from '../../src/domain/scene-snapshot.ts';
import { prepareSceneVisit } from '../../src/domain/scene-visit.ts';
import type { Session } from '../../src/domain/session.ts';
import type { PerformanceAction, StoryPresentationPort, StoryStage, StoryStageSnapshot } from '../../src/domain/story-performance.ts';
import { applyStorySceneAction, hidePendingEntrances, resolveStoryScene } from '../../src/domain/story-scene.ts';
import type { QuestHarnessContent } from './quest-e2e-indexes.ts';

export function createStoryPresentationPorts(params: {
  content: QuestHarnessContent;
  session: Session;
  validateStages: boolean;
  onStageAction?: (action: PerformanceAction) => void | Promise<void>;
}): StoryPresentationPort {
  const { content, session, validateStages, onStageAction } = params;

  if (!validateStages) {
    let fastStage: StoryStageSnapshot | undefined;
    const makeFastStage = (declaration: StoryStage): StoryStageSnapshot => {
      const fallbackMap = fastStage?.map ?? session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
      const map = declaration.mapFromWorld ? fallbackMap : declaration.map;
      const facing = declaration.facing ?? 'south';
      const actors: SceneSnapshot['actors'] = [
        {
          id: 'player',
          actor: content.campaign.start.actor,
          x: declaration.x,
          y: declaration.y,
          facing,
          visible: declaration.playerVisible,
        },
      ];
      const bindings: [string, string][] = [['player', 'player']];
      for (const member of declaration.cast) {
        if (member.id === 'player') continue;
        actors.push({
          id: member.id,
          actor: member.actor,
          x: member.x,
          y: member.y,
          facing: member.facing,
          visible: member.visible,
          ...(member.characterId !== undefined ? { characterId: member.characterId } : {}),
          ...(member.worldEntityId !== undefined ? { worldEntityId: member.worldEntityId } : {}),
          ...(member.memberId !== undefined ? { memberId: member.memberId } : {}),
          ...(member.enemyId !== undefined ? { enemyId: member.enemyId } : {}),
          ...(member.unpositioned !== undefined ? { unpositioned: member.unpositioned } : {}),
        });
        bindings.push([member.id, member.id]);
      }
      return {
        ...declaration,
        map,
        facing,
        scene: { map, actors },
        bindings,
      };
    };

    return {
      begin(_signal, restored) {
        if (restored && 'scene' in restored) {
          fastStage = structuredClone(restored);
        } else if (restored) {
          fastStage = makeFastStage(restored);
        } else {
          const loc = session.storyWorld.currentLocation ?? { ...content.campaign.start, facing: 'south' as const };
          fastStage = makeFastStage({ type: 'stage', ...loc, playerVisible: true, cast: [] });
        }
      },
      async execute(action) {
        await onStageAction?.(action);
        if (action.type === 'stage') {
          fastStage = makeFastStage(action);
        } else if (fastStage && action.type === 'walk' && action.target === 'player') {
          fastStage = {
            ...fastStage,
            x: action.x,
            y: action.y,
            scene: {
              ...fastStage.scene,
              actors: fastStage.scene.actors.map(a => (a.id === 'player' ? { ...a, x: action.x, y: action.y } : a)),
            },
          };
        } else if (fastStage && action.type === 'face' && action.target === 'player') {
          fastStage = {
            ...fastStage,
            facing: action.facing,
            scene: {
              ...fastStage.scene,
              actors: fastStage.scene.actors.map(a => (a.id === 'player' ? { ...a, facing: action.facing } : a)),
            },
          };
        }
      },
      async restoreStage(saved) {
        fastStage = structuredClone(saved);
      },
      getStageState: () => (fastStage ? structuredClone(fastStage) : undefined),
      getWorldChanges: () => [],
      committed() {},
      async finish() {},
      async flushStage() {},
      release() {
        fastStage = undefined;
      },
    };
  }

  let stage: StoryStageSnapshot | undefined;
  const scenes = new Map<string, SceneSnapshot>();
  const committedScenes = new Map<string, SceneSnapshot>();
  const remember = () => {
    if (stage) scenes.set(stage.map, structuredClone(stage.scene));
  };

  const captureScene = (declaration?: StoryStage): SceneSnapshot => {
    const location = session.storyWorld.currentLocation ?? { ...content.campaign.start, facing: 'south' as const };
    const mapId = declaration && !declaration.mapFromWorld ? declaration.map : location.map;
    const map = content.maps.get(mapId);
    assert.ok(map, `舞台地图不存在：${mapId}`);
    const player = mapId === location.map ? location : declaration!;
    return prepareSceneVisit(
      { session, campaign: content.campaign, world: content.world, battleCatalog: content.battle, drops: content.drops, springs: content.springs },
      map,
      { id: 'player', actor: content.campaign.start.actor, x: player.x, y: player.y, facing: player.facing, visible: true },
      () => 0.5,
    );
  };

  const resolveStage = (declaration: StoryStage): StoryStageSnapshot => {
    remember();
    const sameMap = stage && (declaration.mapFromWorld || declaration.map === stage.map) && !declaration.resetActors;
    const mapId = declaration.mapFromWorld ? stage?.map ?? session.storyWorld.currentLocation?.map ?? content.campaign.start.map : declaration.map;
    const scene = sameMap
      ? stage!.scene
      : !declaration.resetActors && scenes.has(mapId)
        ? scenes.get(mapId)!
        : captureScene(declaration);
    if (!committedScenes.has(mapId) || declaration.resetActors) committedScenes.set(mapId, structuredClone(scene));
    return resolveStoryScene(declaration, scene);
  };

  return {
    begin(_signal, restored) {
      stage = undefined;
      scenes.clear();
      committedScenes.clear();
      const loc = session.storyWorld.currentLocation ?? { ...content.campaign.start, facing: 'south' as const };
      stage = restored && 'scene' in restored
        ? structuredClone(restored)
        : resolveStage(restored ?? { type: 'stage', ...loc, playerVisible: true, cast: [] });
      remember();
      committedScenes.set(stage.map, structuredClone(stage.scene));
      assertUniqueActorInstances(stage.scene.actors, `舞台 ${stage.map}/begin`);
      assertScenePlan(planScene(stage.scene, stage.bindings));
    },
    async execute(action, _playback, pendingEntrances) {
      await onStageAction?.(action);
      if (action.type === 'stage') {
        stage = resolveStage(action);
        if (pendingEntrances?.length) stage = hidePendingEntrances(stage, action, pendingEntrances);
      } else if (stage) {
        stage = applyStorySceneAction(stage, action);
      }
      if (stage) {
        assertUniqueActorInstances(stage.scene.actors, `舞台 ${stage.map}/${action.type}`);
        assertScenePlan(planScene(stage.scene, stage.bindings));
      }
    },
    async restoreStage(saved) {
      stage = structuredClone(saved);
      scenes.clear();
      for (const s of saved.scenes ?? []) scenes.set(s.map, structuredClone(s));
      scenes.set(saved.map, structuredClone(saved.scene));
      committedScenes.clear();
      for (const [m, s] of scenes) committedScenes.set(m, structuredClone(s));
      assertUniqueActorInstances(stage.scene.actors, `舞台 ${stage.map}/restore`);
      assertScenePlan(planScene(stage.scene, stage.bindings));
    },
    getStageState() {
      return stage ? structuredClone(stage) : undefined;
    },
    getWorldChanges() {
      remember();
      return [...scenes].flatMap(([map, scene]) =>
        scene.actors.flatMap(actor => {
          if (!actor.worldEntityId || actor.unpositioned || actor.stageHidden) return [];
          const previous = committedScenes.get(map)?.actors.find(value => value.id === actor.id);
          if (
            previous &&
            previous.worldEntityId === actor.worldEntityId &&
            previous.actor === actor.actor &&
            previous.x === actor.x &&
            previous.y === actor.y &&
            previous.facing === actor.facing &&
            previous.visible === actor.visible
          ) {
            return [];
          }
          return [
            {
              id: actor.worldEntityId,
              map,
              actor: actor.actor,
              characterId: actor.characterId,
              x: actor.x,
              y: actor.y,
              facing: actor.facing,
              visible: actor.visible,
            },
          ];
        }),
      );
    },
    committed() {
      remember();
      committedScenes.clear();
      for (const [m, s] of scenes) committedScenes.set(m, structuredClone(s));
    },
    async finish() {},
    async flushStage() {},
    release() {
      stage = undefined;
      scenes.clear();
      committedScenes.clear();
    },
  };
}
