import type { BattleCatalog } from '../domain/battle.ts';
import type { WorldIndex, WorldMap } from '../domain/content.ts';
import type { Campaign } from '../domain/campaign.ts';
import type { ItemCatalog } from '../domain/items.ts';
import { storyActions } from '../domain/story-script.ts';
import type { StoryPlace, StorySpot } from '../domain/story-graph.ts';
import type { WardrobeCatalog } from '../domain/wardrobe.ts';
import type { StoryEncounter } from '../domain/story-world.ts';
import type { AudioCatalog } from './game-audio.ts';
import { questItemOverflows } from './quest-item-grants.ts';
import { validateStoryPerformance } from './story-performance-validation.ts';
import { validateStoryReferences } from './story-reference-validation.ts';

/**
 * 跨文件的内容一致性规则：单独一份内容文件合法，彼此对不上仍然会让游戏在运行到某张
 * 地图、某段剧情时才坏掉。这里集中检查这些引用关系。
 *
 * 规则原先写在 `tools/validate-content.mjs`（无类型的 `.mjs`，不在 tsconfig 的 include 里），
 * 字段名写错没有任何工具会发现。搬到 `src/` 下之后受 `strict` 检查，
 * 也能在测试里脱离文件系统调用。
 *
 * 这里只接受**已解析**的内容对象——读文件与解析留在调用方，
 * 因为资源存在性与图集头那两项检查需要文件系统，浏览器侧不能有。
 */
interface ContentRelations {
  world: WorldIndex;
  battle: BattleCatalog;
  campaign: Campaign;
  items: ItemCatalog;
  wardrobe: WardrobeCatalog;
  audio: AudioCatalog;
  /** 已解析的地图，键是地图标识。 */
  maps: ReadonlyMap<string, WorldMap>;
}

export function validateContentRelations(input: ContentRelations): void {
  const { world, battle, campaign, items, wardrobe, audio, maps } = input;
  const ensure = (value: unknown, message: string): void => { if (!value) throw new Error(message); };
  const ids = new Set(world.maps.map(map => map.id));

  // 音频目录：每条音乐与音效都要能落到实际文件，且覆盖全部地图、怪物与技能。
  // 「13 首音乐 / 170 个音效」是当前导出结果的快照而非契约，加一首 BGM 就要改这里。
  // `version` 是运行时认得的格式版本，属契约；条目数量只是「当前导出结果长这样」的快照，
  // 加一首 BGM 就要改这里，所以只要求目录非空。引用完整性由下面的对象映射数量与逐项检查保证。
  ensure(audio.version === 3 && Object.keys(audio.music).length > 0 && Object.keys(audio.effects).length > 0, '音频目录不完整');
  ensure(audio.music[audio.menuMusic], '主菜单背景音乐缺失');
  ensure(Object.keys(audio.maps).length === world.maps.length && Object.keys(audio.enemies).length === battle.enemies.length, '音频对象映射不完整');
  for (const id of ids) {
    const entry = audio.maps[id];
    ensure(entry, '地图音频缺失 ' + id);
    ensure(!entry.music || audio.music[entry.music], '地图背景音乐缺失 ' + id);
    ensure(!entry.ambience || audio.effects[entry.ambience], '地图环境音缺失 ' + id);
  }
  for (const enemy of battle.enemies) {
    const entry = audio.enemies[enemy.id];
    ensure(entry, '怪物音效缺失 ' + enemy.id);
    for (const cue of Object.values(entry)) ensure(!cue || audio.effects[cue], '怪物音效文件缺失 ' + enemy.id);
  }
  const weaponKinds = new Set(['unarmed', ...Object.values(items.items).filter(item => item.equipment?.slot === 'main-hand').map(item => item.kind)]);
  for (const kind of weaponKinds) {
    const entry = audio.combat.weapons[kind];
    ensure(entry && entry.normal.length, '武器反馈缺失 ' + kind);
    for (const cue of [...entry.normal.map(cue => cue.sound), entry.critical, entry.blocked, entry.miss].filter((value): value is string => Boolean(value))) ensure(audio.effects[cue], '武器反馈音效缺失 ' + cue);
    for (const cue of entry.normal) ensure(Number.isInteger(cue.weight) && cue.weight > 0, '音效权重无效 ' + kind);
  }
  for (const cue of [audio.combat.shieldBlock, audio.combat.periodicDamage]) ensure(audio.effects[cue], '战斗音效缺失 ' + cue);
  for (const skill of Object.values(battle.skills)) if (skill.kind === 'active') ensure(audio.effects[audio.skills[skill.id]], '人物技能音效缺失 ' + skill.id);
  const checkUnitSounds = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(checkUnitSounds);
    else if (value && typeof value === 'object') {
      const unit = value as { dispatch?: { sound?: string }; kind?: string; cues?: { sound?: string }[] };
      if (unit.dispatch?.sound) ensure(audio.effects[unit.dispatch.sound], '动作派发音效缺失 ' + unit.dispatch.sound);
      if (unit.kind === 'units') for (const cue of unit.cues ?? []) ensure(!cue.sound || audio.effects[cue.sound], '技能单元音效缺失 ' + cue.sound);
      Object.values(value).forEach(checkUnitSounds);
    }
  };
  checkUnitSounds(battle);
  checkUnitSounds(wardrobe);
  ensure(audio.ui.enchant === 'UI_Enchant' && audio.ui.craft === 'UI_Craft', '装备加工音效缺失');
  ensure(audio.effects[audio.ui.chestOpen], '宝箱开启音效缺失');
  for (const cue of Object.values(audio.ui)) ensure(audio.effects[cue], '界面音效缺失 ' + cue);

  // 地图之间的引用：出口目标、人物、场景物件、敌人出生点。
  const enemyIds = new Set(battle.enemies.map(enemy => enemy.id));
  const spawnIds = new Set<string>();
  for (const reference of world.maps) {
    const map = maps.get(reference.id);
    ensure(map, `地图标识不匹配 ${reference.id}`);
    const current = map as WorldMap;
    for (const exit of current.exits) ensure(ids.has(exit.destination), `出口目标缺失 ${exit.destination}`);
    for (const entity of current.entities) {
      ensure(world.actors[entity.actor], `人物缺失 ${entity.actor}`);
      if (world.actors[entity.actor].chest) ensure(Number.isSafeInteger(current.lootLevel) && (current.lootLevel as number) >= 0 && (current.lootLevel as number) <= 255, `宝箱地图掉落等级缺失 ${current.id}`);
    }
    for (const feature of current.features) ensure(world.props.some(p => p.key === feature.texture), `场景物件缺失 ${feature.texture}`);
    for (const spawn of current.enemySpawns ?? []) {
      ensure(enemyIds.has(spawn.enemyId), `敌人定义缺失 ${spawn.enemyId}`);
      ensure(!spawnIds.has(spawn.id), `敌人出生点标识重复 ${spawn.id}`);
      spawnIds.add(spawn.id);
    }
  }

  // 剧情与地图、人物、脚本之间的引用。
  ensure(ids.has(campaign.start.map) && world.actors[campaign.start.actor] && campaign.scripts[campaign.start.script], '剧情起点不完整');
  for (const entity of [...campaign.placements,...campaign.mapEntryPlacements??[]]) {
    ensure(ids.has(entity.map) && world.actors[entity.actor], `剧情人物缺失 ${entity.id}`);
    if (entity.afterInteractScript) ensure(campaign.scripts[entity.afterInteractScript], `交互剧情缺失 ${entity.id}`);
  }
  for (const enemy of campaign.enemyPlacements ?? []) {
    const map = maps.get(enemy.map);
    ensure(map && enemyIds.has(enemy.enemyId), `任务敌人缺失 ${enemy.id}`);
    const current = map as WorldMap;
    ensure(enemy.x >= 0 && enemy.x < current.width && enemy.y >= 0 && enemy.y < current.height, `任务敌人站位超出地图 ${enemy.id}`);
    ensure(!spawnIds.has(enemy.id), `敌人出生点标识重复 ${enemy.id}`);
    spawnIds.add(enemy.id);
  }
  // 地点是导出层按原版证据算出来的（`work/tools/game_content/story_places.py`）：只校验它落在真实地图上。
  const checkSpot = (spot: StorySpot, owner: string) => {
    ensure(ids.has(spot.map), `地点地图缺失 ${owner}`);
    const map = maps.get(spot.map) as WorldMap | undefined;
    ensure(!!map && Number.isFinite(spot.x) && Number.isFinite(spot.y)
      && spot.x >= 0 && spot.x < map.width && spot.y >= 0 && spot.y < map.height, `地点坐标超出地图 ${owner}`);
  };
  const checkPlace = (place: StoryPlace | undefined, owner: string) => {
    if (place?.type === 'fixed') checkSpot(place, owner);
    else if (place?.type === 'alternatives') place.spots.forEach((spot, index) => checkSpot(spot, `${owner}[${index}]`));
  };
  for (const event of campaign.events) checkPlace(event.place, event.id);
  for (const task of campaign.debugStory?.tasks ?? []) {
    checkSpot(task.entry, `debug:${task.quest}`);
    const start = task.start;
    if (!start) continue;
    const startWorld = start.world;
    ensure(!!startWorld, `调试现场缺少世界落点 ${task.quest}`);
    // 落点地图必须存在、坐标在地图内；「是否与 entry 一致」只对不是开幕前的切点要求：
    // `cut = before-opening` 的现场停在开幕事件的开场图，和旧目录的接取落点本来就可能不同。
    checkSpot({ ...startWorld!.location, source: 'debug-start' }, `debug-start:${task.quest}`);
    if (task.play?.cut !== 'before-opening')
      ensure(startWorld!.location.map === task.entry.map && startWorld!.location.x === task.entry.x
        && startWorld!.location.y === task.entry.y, `调试现场落点与任务入口不一致 ${task.quest}`);
    for (const entity of startWorld!.entities ?? []) {
      ensure(!entity.map || ids.has(entity.map), `调试现场人物地图缺失 ${task.quest}:${entity.id}`);
      ensure(!entity.actor || world.actors[entity.actor], `调试现场人物角色缺失 ${task.quest}:${entity.id}`);
      if (!entity.map || entity.x === undefined || entity.y === undefined) continue;
      const map = maps.get(entity.map) as WorldMap | undefined;
      ensure(!!map && entity.x >= 0 && entity.x < map.width && entity.y >= 0 && entity.y < map.height,
        `调试现场人物坐标超出地图 ${task.quest}:${entity.id}`);
    }
    for (const spawn of startWorld!.enemyLocations ?? []) {
      const map = maps.get(spawn.map) as WorldMap | undefined;
      ensure(!!map && spawn.x >= 0 && spawn.x < map.width && spawn.y >= 0 && spawn.y < map.height,
        `调试现场敌人坐标超出地图 ${task.quest}:${spawn.id}`);
    }
    for (const item of [...start.items ?? [], ...start.requiresProfile?.items ?? []])
      ensure(!!items.items[item.item], `调试现场物品缺失 ${task.quest}:${item.item}`);
    for (const id of start.itemReset ?? []) ensure(!!items.items[id], `调试现场待清物品缺失 ${task.quest}:${id}`);
    for (const absent of startWorld!.absentActors ?? [])
      ensure(ids.has(absent.map) && !!world.actors[absent.actor], `调试现场缺场人物缺失 ${task.quest}:${absent.actor}`);
    for (const absent of startWorld!.absentEnemies ?? []) {
      ensure(ids.has(absent.map), `调试现场缺场敌人地图缺失 ${task.quest}`);
      ensure(enemyIds.has(absent.enemyId), `调试现场缺场敌人不存在 ${task.quest}:${absent.enemyId}`);
    }
  }
  for (const quest of campaign.quests)
    for (const phase of ['available', 'active', 'ready'] as const) checkPlace(quest.places?.[phase], `${quest.id}:${phase}`);
  for (const event of campaign.events) ensure((!event.map || ids.has(event.map)) && campaign.scripts[event.script], `剧情事件缺失 ${event.id}`);
  for (const action of storyActions(campaign)) {
    const lines = action.type === 'dialogue' ? [action] : action.type === 'choice' ? action.options.flatMap(option => option.lines ?? []) : [];
    for (const line of lines) {
      if (line.actor) ensure(world.actors[line.actor], `对白人物缺失 ${line.actor}`);
      if (line.portrait) ensure(world.portraits[line.portrait], `对白立绘缺失 ${line.portrait}`);
    }
  }

  // 同一场遭遇里两条摆位完全一样，只会多出一只同样的敌人：那是复制出来的记录，不是设计。
  // 跨摆位的重复（演出位 + 参战位）在这里判断不了——原版把同一只怪先摆台前、开打前撤下再摆到
  // 开打格，两条记录的坐标本来就不同；那类重复由导出脚本的「切图作废旧单位」规则和剧情用例兜住。
  const checkEncounter = (owner: string, encounter: StoryEncounter): void => {
    const seen = new Set<string>();
    for (const spawn of encounter.spawns) {
      const key = `${spawn.enemyId}|${spawn.x}|${spawn.y}`;
      ensure(!seen.has(key), `剧情 ${owner} 在同一格摆了两只 ${spawn.enemyId}`);
      seen.add(key);
    }
  };
  for (const [name, script] of Object.entries(campaign.scripts))
    for (const node of script.nodes) {
      if (node.exit.type === 'waitEncounter') checkEncounter(`${name}/${node.id}`, node.exit.encounter);
      for (const command of node.commands) if (command.type === 'encounter') checkEncounter(`${name}/${node.id}`, command.encounter);
    }

  // 任务道具发放超过交付需求，交完就会剩一件占着背包：任务类道具既不能丢也不能卖。
  for (const overflow of questItemOverflows(campaign))
    ensure(false, `任务 ${overflow.quest} 的 ${overflow.item} 发了 ${overflow.granted} 件，交付只需要 ${overflow.required} 件`);

  validateStoryPerformance(world, campaign, maps, audio);
  validateStoryReferences(campaign, world, battle, maps, items);
}