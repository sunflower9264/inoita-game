import type { Campaign } from '../domain/campaign.ts';
import type { BattleCatalog } from '../domain/battle.ts';
import type { BattleCharacter } from '../domain/character-stats.ts';
import type { ActorDefinition, EntityPlacement, WorldIndex, WorldMap } from '../domain/content.ts';
import type { ControlSkin } from '../domain/control-skin.ts';
import { BREAKABLE_ENEMY_IDS, type DropCatalog } from '../domain/drops.ts';
import type { ItemCatalog } from '../domain/items.ts';
import type { CompanionCatalog, PartyRoster } from '../domain/party.ts';
import type { SpringCatalog } from '../domain/springs.ts';
import { learnedSkillIds, type SkillDraftSource } from '../domain/skill-configuration.ts';
import type { StatusHudSkin } from '../domain/status-hud.ts';
import type { StoryInterface } from '../domain/story-interface.ts';
import type { StoryNode } from '../domain/story-graph.ts';
import type { StoryStage } from '../domain/story-performance.ts';
import type { StoryEncounter, StoryWorldState } from '../domain/story-world.ts';
import type { WardrobeCatalog } from '../domain/wardrobe.ts';
import { characterAssets } from './characters.ts';
import { characterSceneClips } from './combat-asset-descriptors.ts';
import { mapSurfaceAssets } from './map-layers.ts';
import { enemyCombatAssets, partyMemberCombatAssets, playerCombatAssets, sharedCombatAssets } from './combat-assets.ts';
import { groundLootAssets } from './ground-loot.ts';
import { controlSkinAssets } from './control-skin.ts';
import { pickupMessageAssets } from './pickup-messages.ts';
import { questMarkerAssets } from './quest-marker.ts';
import type { PendingAsset } from './scene-assets.ts';
import { statusHudAssets } from './status-hud.ts';

export interface WorldAssetInputs {
  world: WorldIndex;
  campaign: Campaign;
  battle: BattleCatalog;
  items: ItemCatalog;
  wardrobe: WardrobeCatalog;
  drops: DropCatalog;
  springs: SpringCatalog;
  statusHud: StatusHudSkin;
  controlSkin: ControlSkin;
  storyInterface: StoryInterface;
  storyWorld: StoryWorldState;
  companions: CompanionCatalog;
  party?: PartyRoster;
  hero: BattleCharacter;
  /** 主角技能配置；省略时按全部技能规划（构建期/测试）。 */
  heroSkills?: SkillDraftSource;
  /** 主角当前外观（`session.character.appearance`）。 */
  playerBase: ActorDefinition;
}

export interface MapVisualPlan {
  assets: PendingAsset[];
  actorIds: Set<string>;
}

interface MapVisualOptions {
  /** 当前图已经投影出来的实体；省略时按静态摆放 + 随机结果的超集。 */
  entities?: readonly EntityPlacement[];
  /** 只扫描本次入口闭包里的脚本；省略时扫描全部脚本（单元测试/兜底）。 */
  scripts?: Iterable<string>;
}

/** 所有脚本里在这张地图上开演的舞台角色（含 `node.stage` 与 parallel 里的舞台）。 */
function stageActorsForMap(campaign: Pick<Campaign, 'scripts'>, mapId: string, scriptNames: readonly string[]): string[] {
  const actors = new Set<string>();
  const addStage = (stage: StoryStage | undefined) => {
    if (!stage || stage.mapFromWorld || stage.map !== mapId) return;
    for (const member of stage.cast) actors.add(member.actor);
  };
  const addActions = (actions: readonly StoryNode['presentation'][number][]) => {
    for (const action of actions) {
      if (action.type === 'stage') addStage(action);
      else if (action.type === 'parallel') addActions(action.actions);
    }
  };
  for (const name of scriptNames) {
    const script = campaign.scripts[name];
    if (!script) continue;
    for (const node of script.nodes) {
      addStage(node.stage);
      addActions(node.presentation);
    }
  }
  return [...actors];
}

/**
 * 进入地图 X 的视觉素材。传 `entities` 时按当前实际投影加载；不传时返回保守超集，
 * 供剧情目的地预取使用（随机降级、泉水各档、条件摆放都算进去）。
 */
export function planMapVisuals(map: WorldMap, input: WorldAssetInputs, options: MapVisualOptions = {}): MapVisualPlan {
  const { campaign, world, storyWorld, springs } = input;
  const assets = mapSurfaceAssets(map, world.props);

  const actorIds = new Set<string>();
  const add = (id: string | undefined) => {
    if (!id) return;
    actorIds.add(id);
    const rendered = storyWorld.actorAppearance(id);
    if (rendered !== id) actorIds.add(rendered);
  };
  add(campaign.start.actor);
  add(input.playerBase.id);
  for (const entity of options.entities ?? map.entities) add(entity.actor);
  // 任务定位 NPC 等由剧情世界投影出来的人物，不一定在静态摆放里。
  for (const entity of storyWorld.projectEntities(map.id, map.entities, campaign.placements)) add(entity.actor);
  for (const entity of map.entities) {
    add(entity.actor);
    add(entity.downgrade?.actor);
  }
  for (const placement of campaign.placements) if (placement.map === map.id) { add(placement.actor); add(placement.downgrade?.actor); }
  for (const placement of campaign.mapEntryPlacements ?? []) if (placement.map === map.id) { add(placement.actor); add(placement.downgrade?.actor); }
  const hasSpring = map.entities.some(entity => entity.spring)
    || campaign.placements.some(placement => placement.map === map.id && placement.spring);
  if (hasSpring) {
    for (const spring of springs.springs) add(spring.id);
    add(springs.empty);
  }
  const scriptNames = options.scripts ? [...options.scripts] : Object.keys(campaign.scripts);
  for (const actor of stageActorsForMap(campaign, map.id, scriptNames)) add(actor);
  // 剧情命令写入本图的人物，以及外观替换。只扫描本次闭包脚本，避免把整部剧情的人物都装进每张图。
  for (const name of scriptNames) {
    const script = campaign.scripts[name];
    if (!script) continue;
    for (const node of script.nodes) {
      for (const command of node.commands) {
        if (command.type !== 'world') continue;
        if (command.command.kind === 'place' && (command.command.entity.map === map.id || command.command.mapFromStage))
          add(command.command.entity.actor);
        else if (command.command.kind === 'actor-appearance') add(command.command.appearance);
      }
    }
  }
  for (const id of actorIds) {
    const actor = world.actors[id];
    if (!actor) throw new Error(`角色资源缺失：${id}`);
    assets.push(...characterAssets(actor, characterSceneClips(actor)));
  }
  return { assets, actorIds };
}

interface EnemyPlanOptions {
  /** 本次入口闭包里的脚本；省略时扫描全部脚本（入口进图一次，成本可接受）。 */
  scripts?: Iterable<string>;
  /** 当前图已经投影出来的实体；宝箱怪可能来自剧情生成。 */
  entities?: readonly EntityPlacement[];
  checkpointEnemies?: Iterable<string>;
}

/** 目标图可能出现的敌人 id 超集；不构造 `WorldEnemyRoster`，避免 `session.enterMap` 的副作用。 */
export function potentialMapEnemyIds(map: WorldMap, input: WorldAssetInputs, options: EnemyPlanOptions = {}): string[] {
  const ids = new Set<string>();
  // 预取不按等级选档：剧情可能在到达目的地前升级，档位会变；全档敌人种类很少。
  for (const spawn of map.enemySpawns ?? []) ids.add(spawn.enemyId);
  if ((map.enemySpawns ?? []).some(spawn => spawn.breakableEligible)) {
    for (const enemyId of Object.values(BREAKABLE_ENEMY_IDS)) ids.add(enemyId);
    for (const kind of ['bush', 'jar', 'box', 'fortunate-box'] as const) {
      const spawn = input.drops.breakables?.[kind]?.spawn;
      if (spawn) ids.add(spawn.enemyId);
    }
  }
  for (const spawn of input.campaign.enemyPlacements ?? []) if (spawn.map === map.id) ids.add(spawn.enemyId);
  for (const spawn of input.storyWorld.enemySpawns(map.id)) ids.add(spawn.enemyId);
  for (const encounter of input.storyWorld.activeEncounters)
    if (encounter.map === map.id) for (const spawn of encounter.spawns) ids.add(spawn.enemyId);
  const addChest = (actor: string) => {
    const chest = input.world.actors[actor]?.chest;
    const spawn = chest ? input.drops.chests[chest]?.spawn : undefined;
    if (spawn) ids.add(spawn.enemyId);
  };
  for (const entity of [...map.entities, ...(options.entities ?? [])]) addChest(entity.actor);
  const hasSpring = map.entities.some(entity => entity.spring)
    || input.campaign.placements.some(placement => placement.map === map.id && placement.spring);
  if (hasSpring) for (const effect of input.springs.effects) if (effect.enemy) ids.add(effect.enemy);

  const visitScript = (name: string) => {
    const script = input.campaign.scripts[name];
    if (!script) return;
    for (const node of script.nodes) {
      const addEncounter = (encounter: StoryEncounter) => {
        if (!encounter.mapFromStage && encounter.map !== map.id) return;
        for (const spawn of encounter.spawns) ids.add(spawn.enemyId);
      };
      for (const command of node.commands) {
        if (command.type === 'encounter') addEncounter(command.encounter);
        else if (command.type === 'world') {
          if (command.command.kind === 'place') {
            const entity = command.command.entity;
            if (entity.map === map.id || command.command.mapFromStage) addChest(entity.actor);
          } else if (command.command.kind === 'encounter') addEncounter(command.command.encounter);
          else if (command.command.kind === 'enemy-location') {
            const location = command.command.location;
            if ((location && location.map === map.id) || command.command.mapFromStage) ids.add(command.command.enemyId);
          }
        }
      }
      if (node.exit.type === 'waitEncounter') addEncounter(node.exit.encounter);
    }
  };
  if (options.scripts) for (const name of options.scripts) visitScript(name);
  else for (const name of Object.keys(input.campaign.scripts)) visitScript(name);
  for (const id of options.checkpointEnemies ?? []) ids.add(id);
  return [...ids];
}

interface MapCombatOptions extends EnemyPlanOptions {
  enemyIds?: Iterable<string>;
  partyIds?: Iterable<string>;
  joinCompanionIds?: Iterable<string>;
}

/** 目标图的完整战斗素材：主角、当前队伍、剧情会加入的伙伴、可能出现的敌人。 */
export function planMapCombat(map: WorldMap, input: WorldAssetInputs, options: MapCombatOptions = {}): PendingAsset[] {
  // 主角和已入队伙伴只装已学技能；尚未入队/只声明加入的伙伴仍用全套，避免剧情加入时缺素材。
  const heroLearned = input.heroSkills ? learnedSkillIds(input.battle, input.hero.classId, input.heroSkills) : undefined;
  const assets: PendingAsset[] = [
    ...playerCombatAssets({ catalog: input.battle, wardrobe: input.wardrobe, items: input.items, hero: input.hero, actor: input.playerBase,
      learnedSkills: heroLearned }),
    ...sharedCombatAssets(input.battle, input.wardrobe)
  ];
  const partyIds = options.partyIds ?? input.party?.activeIds ?? [];
  for (const id of partyIds) {
    if (id === 'player') continue;
    const member = input.party?.get(id);
    const actor = member ? input.world.actors[member.definition.actor] : undefined;
    if (!member || !actor) continue;
    assets.push(...partyMemberCombatAssets(input.battle, input.wardrobe, member.classId, actor,
      learnedSkillIds(input.battle, member.classId, member.skills),
      { items: input.items, equipment: input.hero.bag.equipmentItems(input.hero.bag.equipmentFor(id)) }));
  }
  const joins = new Set(options.joinCompanionIds ?? []);
  if (!options.joinCompanionIds) {
    for (const name of options.scripts ?? Object.keys(input.campaign.scripts)) {
      const script = input.campaign.scripts[name];
      if (!script) continue;
      for (const node of script.nodes) for (const command of node.commands)
        if (command.type === 'party-join') joins.add(command.companion);
    }
  }
  for (const id of joins) {
    const definition = input.companions.definitions[id];
    const actor = definition ? input.world.actors[definition.actor] : undefined;
    if (definition && actor) assets.push(...partyMemberCombatAssets(input.battle, input.wardrobe, definition.classId, actor));
  }
  for (const id of options.enemyIds ?? potentialMapEnemyIds(map, input, options)) {
    const definition = input.battle.enemies.find(enemy => enemy.id === id);
    if (!definition) throw new Error(`敌人定义缺失：${id}`);
    assets.push(...enemyCombatAssets(input.battle, definition));
  }
  return assets;
}

type SharedEntryInput = Pick<WorldAssetInputs,
  'battle' | 'items' | 'wardrobe' | 'statusHud' | 'controlSkin' | 'storyInterface'>;

/** 所有地图共用、进入世界前必须就位的素材：HUD、控制皮肤、地面物品、头顶任务图标、衣柜图集、剧情特效与战斗全局。 */
export function sharedEntryAssets(input: SharedEntryInput): PendingAsset[] {
  return [
    ...statusHudAssets(input.statusHud),
    ...controlSkinAssets(input.controlSkin),
    ...groundLootAssets(input.items),
    ...pickupMessageAssets(),
    ...questMarkerAssets(input.storyInterface),
    ...input.wardrobe.textures.map(texture => ({ kind: 'image' as const, ...texture })),
    ...sharedCombatAssets(input.battle, input.wardrobe)
  ];
}

interface StoryPresentationAssets {
  portraits: string[];
  sounds: string[];
}

/**
 * 闭包脚本会用到的立绘与音效。遍历所有节点（包括分支里的对话），
 * 这样第一次对白出现时不需要再发请求。
 */
export function storyPresentationAssets(campaign: Pick<Campaign, 'scripts'>, scripts: Iterable<string>, input: WorldAssetInputs): StoryPresentationAssets {
  const portraits = new Set<string>();
  const sounds = new Set<string>();
  const visit = (actions: readonly StoryNode['presentation'][number][]) => {
    for (const action of actions) {
      if (action.type === 'parallel') { visit(action.actions); continue; }
      if (action.type === 'dialogue') {
        const key = action.portrait === undefined ? (action.actor ? input.world.actors[action.actor]?.portrait : undefined) : action.portrait;
        const file = key ? input.storyInterface.portraits[key] : undefined;
        if (file) portraits.add(file);
      } else if (action.type === 'sound' && action.sound) sounds.add(action.sound);
    }
  };
  for (const name of new Set(scripts)) {
    const script = campaign.scripts[name];
    if (!script) continue;
    for (const node of script.nodes) visit(node.presentation);
  }
  return { portraits: [...portraits], sounds: [...sounds] };
}
