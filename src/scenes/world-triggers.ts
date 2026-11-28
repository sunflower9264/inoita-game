import type { StoryContext } from '../application/ports.ts';
import type { StoryWorldViewSnapshot } from '../application/world-snapshot.ts';
import type { Campaign } from '../domain/campaign.ts';
import type { CollisionBox, MapExit, WorldMap } from '../domain/content.ts';
import { ExitTrigger, overlapsFootRect, segmentOverlapsFootRect, type GameRectangle, type Point } from '../domain/navigation.ts';
import type { StoryEvent } from '../domain/story-graph.ts';
import { buildStoryTriggerIndex, type StoryTriggerIndex } from '../domain/story-trigger-index.ts';
import { claimStoryTrigger } from '../domain/story-trigger-occupancy.ts';
import { storyExitId } from '../domain/story-world.ts';

const EMPTY_REGIONS: readonly GameRectangle[] = Object.freeze([]);

export interface TriggerCharacter {
  readonly entity: {
    readonly id: string;
    readonly actor: string;
    readonly characterId?: string;
    readonly objective?: string;
    readonly flip?: boolean;
  };
  readonly actor: { readonly collision?: CollisionBox };
  readonly container: { readonly x: number; readonly y: number; readonly visible: boolean };
}

export interface WorldTriggerStepInput {
  readonly map: Pick<WorldMap, 'id'>;
  readonly campaign: Campaign;
  readonly session: StoryContext['session'];
  readonly director: Pick<StoryContext['director'], 'allowsAutomaticEvent' | 'runtime' | 'enterRegion'>;
  readonly characters: readonly TriggerCharacter[];
  readonly pos: { readonly x: number; readonly y: number };
  readonly previousPos?: { readonly x: number; readonly y: number };
  readonly moving: boolean;
  readonly playStory: (work: () => Promise<boolean>) => unknown;
  readonly onExit: (exit: MapExit) => void;
}

/**
 * 管理世界场景的区域事件、近身人物事件、出口触发、遭遇结果防重放与触发器空间索引，
 * 让无头剧情回放测试与正式 `WorldScene` 执行同一套纯 TS 触发判定。
 */
export class WorldTriggerCoordinator {
  occupiedTriggers = new Set<string>();
  occupiedCharacters = new Set<string>();
  occupiedNearEvents = new Set<string>();
  readonly encounterResults = new Set<string>();
  triggerIndex?: StoryTriggerIndex<TriggerCharacter>;
  exitTrigger?: ExitTrigger<MapExit>;

  reset(contacts?: StoryWorldViewSnapshot['triggerContacts']): void {
    this.restoreContacts(contacts);
    this.encounterResults.clear();
    this.triggerIndex = undefined;
    this.exitTrigger = undefined;
  }

  restoreContacts(contacts: StoryWorldViewSnapshot['triggerContacts']): void {
    this.occupiedTriggers = new Set(contacts?.regions);
    this.occupiedCharacters = new Set(contacts?.characters);
    this.occupiedNearEvents = new Set(contacts?.nearEvents);
  }

  captureContacts(): StoryWorldViewSnapshot['triggerContacts'] {
    if (!this.occupiedTriggers.size && !this.occupiedCharacters.size && !this.occupiedNearEvents.size) {
      return undefined;
    }
    return {
      regions: [...this.occupiedTriggers],
      characters: [...this.occupiedCharacters],
      nearEvents: [...this.occupiedNearEvents],
    };
  }

  setExitTrigger(exits: readonly MapExit[], origin: { x: number; y: number }, armedOnSpawn = true): void {
    this.exitTrigger = new ExitTrigger([...exits], origin, armedOnSpawn);
  }

  syncExitPosition(origin: { x: number; y: number }): void {
    this.exitTrigger?.syncPosition(origin);
  }

  rebuildIndex(campaign: Campaign, mapId: string | undefined, characters: readonly TriggerCharacter[]): void {
    this.triggerIndex = mapId ? buildStoryTriggerIndex(campaign, mapId, characters) : undefined;
    for (const id of this.occupiedCharacters) {
      if (!this.triggerIndex?.nearCharacters.some(group => group.id === id && group.character.container.visible)) {
        this.occupiedCharacters.delete(id);
      }
    }
  }

  /**
   * 剧情位移或切换受控人后立即淘汰已离开的区域占用，
   * 避免紧随其后的检查点把旧区域占用存进快照，也保证再次踏入立即重触发。
   */
  pruneOccupiedRegions(
    pos: { readonly x: number; readonly y: number },
    campaign: Campaign,
    mapId: string | undefined,
    characters: readonly TriggerCharacter[],
  ): void {
    if (!this.occupiedTriggers.size || !mapId) return;
    const index = this.triggerIndex ?? buildStoryTriggerIndex(campaign, mapId, characters);
    const regionsById = new Map(index.regionEvents.map(event => [event.id, event.region]));
    for (const id of [...this.occupiedTriggers]) {
      const region = regionsById.get(id);
      if (!region || !overlapsFootRect(pos, region)) this.occupiedTriggers.delete(id);
    }
  }

  /**
   * 当前地图上满足自动触发条件、且受控队长自身尚未踏入的区域矩形列表。
   * 非受控队员和友方召唤物的跟随、追击、位移与收拢落点均不得进入或穿越这些边界。
   */
  activeRegions(
    map: Pick<WorldMap, 'id'> | undefined,
    campaign: Campaign,
    session: StoryContext['session'],
    director: Pick<StoryContext['director'], 'allowsAutomaticEvent' | 'runtime'> | undefined,
    characters: readonly TriggerCharacter[],
    excludeAt?: Point,
  ): readonly GameRectangle[] {
    if (!map || !director) return EMPTY_REGIONS;
    const index = this.triggerIndex ?? (this.triggerIndex = buildStoryTriggerIndex(campaign, map.id, characters));
    if (!index.regionEvents.length) return EMPTY_REGIONS;
    let matched: GameRectangle[] | undefined;
    for (const event of index.regionEvents) {
      const region = event.region;
      if (!region) continue;
      if (excludeAt && overlapsFootRect(excludeAt, region)) continue;
      if (!director.allowsAutomaticEvent(event)) continue;
      if (event.condition && !session.evaluateCondition(event.condition)) continue;
      const status = director.runtime.eventStatus(event.id);
      if (status !== 'idle' && !(status === 'completed' && event.repeat)) continue;
      (matched ??= []).push(region);
    }
    return matched ?? EMPTY_REGIONS;
  }

  exitAvailable(
    map: Pick<WorldMap, 'id'> | undefined,
    exit: MapExit,
    session: StoryContext['session'],
    campaign: Campaign,
  ): boolean {
    if (!map || !session.storyWorld.exitEnabled(map.id, exit)) return false;
    const rule = campaign.exitRules?.find(entry => entry.map === map.id && entry.id === storyExitId(map.id, exit));
    return !rule || session.evaluateCondition(rule.condition);
  }

  storyWorldContext(
    map: Pick<WorldMap, 'id'> | undefined,
    playerPos: { x: number; y: number } | undefined,
    near: TriggerCharacter | null,
    campaign: Campaign,
  ): Record<string, string | boolean | number> {
    const values: Record<string, string | boolean | number> = {
      map: map?.id ?? '',
      'near-actor': near?.entity.actor ?? '',
      'near-entity': near?.entity.id ?? '',
      interaction: near?.entity.objective ?? '',
    };
    if (playerPos) {
      values['player-x'] = playerPos.x;
      values['player-y'] = playerPos.y;
    }
    for (const event of campaign.events) {
      if (event.source === 'region') {
        values[`region:${event.id}`] =
          !!playerPos && event.map === map?.id && !!event.region && overlapsFootRect(playerPos, event.region);
      }
    }
    return values;
  }

  settleCompletedEncounters(
    canControl: boolean,
    director: Pick<StoryContext['director'], 'busy' | 'encounterResult'>,
    completed: readonly { id: string }[] | undefined,
    playStory: (work: () => Promise<boolean>) => unknown,
  ): boolean {
    if (!canControl || director.busy || !completed) return false;
    for (const encounter of completed) {
      if (this.encounterResults.has(encounter.id)) continue;
      this.encounterResults.add(encounter.id);
      playStory(() => director.encounterResult(encounter.id, 'won', `result:${encounter.id}:won`));
      return true;
    }
    return false;
  }

  stepAfterMovement(input: WorldTriggerStepInput): 'region' | 'exit' | 'none' {
    const { map, campaign, session, director, characters, pos, previousPos, moving, playStory, onExit } = input;
    const triggerIndex = this.triggerIndex ?? buildStoryTriggerIndex(campaign, map.id, characters);
    const availability = (event: StoryEvent) => {
      if (!director.allowsAutomaticEvent(event) || (event.condition && !session.evaluateCondition(event.condition))) {
        return;
      }
      return director.runtime.eventStatus(event.id);
    };
    const occupied = this.occupiedTriggers;
    const region = claimStoryTrigger(
      triggerIndex.regionEvents,
      occupied,
      event => {
        if (!event.region) return false;
        // 已占用的区域按当前脚点判定离开，转身退回外侧的当帧立即解除占用；
        // 未占用的区域在正常移动中按闭线段扫掠，单步跨过 16px 窄条带也能命中。
        if (occupied.has(event.id)) return overlapsFootRect(pos, event.region);
        return moving && previousPos ? segmentOverlapsFootRect(previousPos, pos, event.region) : overlapsFootRect(pos, event.region);
      },
      event => {
        const status = availability(event);
        return status === 'idle' || (status === 'completed' && event.repeat) ? status : false;
      },
      status => status === 'idle',
    );
    if (region) {
      playStory(async () => {
        const played = await director.enterRegion(region.event.id, region.event.map!);
        if (!played) occupied.delete(region.event.id);
        return played;
      });
      return 'region';
    }
    const exit = this.exitTrigger?.update(pos, moving, candidate => this.exitAvailable(map, candidate, session, campaign));
    if (exit && this.exitAvailable(map, exit, session, campaign)) {
      onExit(exit);
      return 'exit';
    }
    return 'none';
  }
}
