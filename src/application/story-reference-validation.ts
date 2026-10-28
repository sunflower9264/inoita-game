import type { WorldIndex, WorldMap } from '../domain/content.ts';
import type { Campaign } from '../domain/campaign.ts';
import type { BattleCatalog } from '../domain/battle.ts';
import type { ItemCatalog } from '../domain/items.ts';
import type { StoryCondition } from '../domain/story-condition.ts';
import type { StoryEncounter } from '../domain/story-world.ts';
import { storyExitId } from '../domain/story-world.ts';
import { storyActions } from '../domain/story-script.ts';
import type { StoryCommand } from '../domain/story-graph.ts';

/** Only maps mentioned by authored story content need to be loaded at startup. */
export function storyReferenceMaps(campaign:Campaign):Set<string>{
  const ids=new Set([campaign.start.map,...[...campaign.placements,...campaign.mapEntryPlacements??[]].map(entity=>entity.map),...campaign.events.flatMap(event=>event.map?[event.map]:[]),
    ...(campaign.exitRules??[]).map(exit=>exit.map),...(campaign.enemyPlacements??[]).map(enemy=>enemy.map)]);
  for(const action of storyActions(campaign)){
    if(action.type==='stage')ids.add(action.map);
    if(action.type==='world-object'){
      if(action.command.kind==='place')ids.add(action.command.entity.map);
      if(action.command.kind==='remove-character')ids.add(action.command.map);
    }
  }
  for(const script of Object.values(campaign.scripts))for(const node of script.nodes){
    if(node.stage)ids.add(node.stage.map);
    if(node.exit.type==='waitEncounter')ids.add(node.exit.encounter.map);
    for(const command of node.commands){
      if(command.type==='travel')ids.add(command.destination.map);
      if(command.type==='encounter')ids.add(command.encounter.map);
      if(command.type==='world'){
        if(command.command.kind==='place')ids.add(command.command.entity.map);
        if(command.command.kind==='actor-visibility'||command.command.kind==='remove-character'||command.command.kind==='enemy-availability')ids.add(command.command.map);
        if(command.command.kind==='travel')ids.add(command.command.destination.map);
        if(command.command.kind==='enemy-location'&&command.command.location)ids.add(command.command.location.map);
        if(command.command.kind==='encounter')ids.add(command.command.encounter.map);
      }
    }
  }
  return ids;
}

/** Runtime preparation and the build use the same references, including command-only events. */
export function validateStoryReferences(campaign:Campaign,world:WorldIndex,battle:BattleCatalog,maps:ReadonlyMap<string,WorldMap>,items:ItemCatalog):void{
  const ensure=(value:unknown,message:string):void=>{if(!value)throw new Error('剧情引用无效：'+message);};
  for(const id of storyReferenceMaps(campaign))ensure(world.maps.some(map=>map.id===id)&&maps.has(id),'地图不存在 '+id);
  const entities=new Set([...[...campaign.placements,...campaign.mapEntryPlacements??[]].map(entity=>entity.id),...[...maps.values()].flatMap(map=>map.entities.map(entity=>entity.id))]);
  /**
   * 每个世界实体的归属地图。演出把绑定演员写回正式世界时用的是舞台地图（`story-presenter.getWorldChanges`），
   * 所以舞台与实体必须同图：跨图绑定会把这个 NPC 从原图抹掉、再放到舞台上，而且全程不报错。
   * 摆放点优先于地图实体——它是剧情侧的权威声明。
   */
  // 世界实体 ID 只在单张地图内唯一：同一扇石门的编号可以在多个地图重复。
  // 因此这里记录每个实体出现过的地图集合，舞台绑定只要在本图出现就能通过。
  const entityMaps=new Map<string,Set<string>>();
  const rememberEntityMap=(id:string,map:string):void=>{
    const homes=entityMaps.get(id);
    if(homes)homes.add(map);else entityMaps.set(id,new Set([map]));
  };
  for(const map of maps.values())for(const entity of map.entities)rememberEntityMap(entity.id,map.id);
  for(const entity of [...campaign.placements,...campaign.mapEntryPlacements??[]])rememberEntityMap(entity.id,entity.map);
  const checkEntityMap=(id:string,map:string,message:string):void=>{
    const homes=entityMaps.get(id);
    ensure(homes===undefined||homes.has(map),`${message}：${id} 在 ${[...homes??[]].join('/')}，舞台在 ${map}`);
  };
  const actors=new Set(Object.keys(world.actors)),enemies=new Set(battle.enemies.map(enemy=>enemy.id));
  const exits=new Map([...maps.values()].flatMap(map=>map.exits.map(exit=>[storyExitId(map.id,exit),map.id] as const)));
  const commands:StoryCommand[]=[...Object.values(campaign.scripts).flatMap(script=>script.nodes.flatMap(node=>node.commands)),
    ...storyActions(campaign).flatMap(action=>action.type==='world-object'?[{type:'world' as const,command:action.command}]:[])];
  const characters=new Set([
    ...[...campaign.placements,...campaign.mapEntryPlacements??[]].map(entity=>entity.characterId),
    ...[...maps.values()].flatMap(map=>map.entities.map(entity=>entity.characterId)),
    ...commands.flatMap(command=>command.type==='world'&&command.command.kind==='place'?[command.command.entity.characterId]:[]),
    ...storyActions(campaign).flatMap(action=>action.type==='stage'?action.cast.map(member=>member.characterId):[]),
  ].filter((id):id is string=>!!id));
  for(const quest of campaign.quests)for(const change of quest.targetChanges??[]){
    const goal=quest.goals.find(goal=>goal.id===change.goal);
    if(goal?.characterId)characters.add(goal.characterId);
  }
  for(const command of commands)if(command.type==='world'&&command.command.kind==='place')entities.add(command.command.entity.id);
  for(const action of storyActions(campaign))if(action.type==='appear'&&action.worldEntityId)
    ensure(entities.has(action.worldEntityId),'出场实体不存在 '+action.worldEntityId);
  const point=(mapId:string,x:number,y:number,owner:string):void=>{const map=maps.get(mapId);ensure(map&&x>=0&&x<map.width&&y>=0&&y<map.height,'位置超出地图 '+owner);};
  const quests=new Set(campaign.quests.map(quest=>quest.id));
  for(const map of maps.values())for(const spawn of map.questItemSpawns??[]){
    ensure(quests.has(spawn.quest),'地图任务物品引用任务不存在 '+spawn.quest);
    ensure(items.items[spawn.item],'地图任务物品不存在 '+spawn.item);
    point(map.id,spawn.x,spawn.y,spawn.id);
  }
  const encounter=(value:StoryEncounter):void=>{
    ensure(value.spawns.length,'遭遇需要敌人 '+value.id);
    for(const spawn of value.spawns){ensure(enemies.has(spawn.enemyId),'遭遇敌人不存在 '+spawn.enemyId);if(!value.mapFromStage)point(value.map,spawn.x,spawn.y,value.id+'/'+spawn.id);}
  };
  const condition=(value:StoryCondition|undefined):void=>{
    if(!value)return;
    if(value.type==='all'||value.type==='any'){value.conditions.forEach(condition);return;}
    if(value.type==='not'){condition(value.condition);return;}
    if(value.type==='world'){
      if(value.key==='map')ensure(world.maps.some(map=>map.id===value.value),'条件地图不存在 '+value.value);
      if(value.key==='near-actor')ensure(actors.has(String(value.value)),'条件人物不存在 '+value.value);
      if(value.key==='near-entity')ensure(entities.has(String(value.value)),'条件实体不存在 '+value.value);
      if(value.key.startsWith('region:'))ensure(campaign.events.some(event=>event.id===value.key.slice(7)&&event.source==='region'),'条件区域不存在 '+value.key);
    }
  };
  ensure(actors.has(campaign.start.actor),'主角不存在 '+campaign.start.actor);point(campaign.start.map,campaign.start.x,campaign.start.y,'start');
  for(const placement of [...campaign.placements,...campaign.mapEntryPlacements??[]]){ensure(actors.has(placement.actor),'人物不存在 '+placement.actor);point(placement.map,placement.x,placement.y,placement.id);condition(placement.condition);}
  for(const quest of campaign.quests){
    if(quest.giver)ensure(actors.has(quest.giver),'任务交付人物不存在 '+quest.giver);
    if(quest.delivery)ensure(actors.has(quest.delivery),'任务交付对象不存在 '+quest.delivery);
    if(quest.giverCharacterId)ensure(characters.has(quest.giverCharacterId),'任务发布人物身份不存在 '+quest.giverCharacterId);
    if(quest.deliveryCharacterId)ensure(characters.has(quest.deliveryCharacterId),'任务交付人物身份不存在 '+quest.deliveryCharacterId);
    condition(quest.availableWhen);
    for(const change of quest.targetChanges??[]){
      ensure(enemies.has(change.enemyId),'任务变身敌人不存在 '+change.enemyId);
      ensure(actors.has(change.actor),'任务变身人物不存在 '+change.actor);
      ensure(quest.goals.some(goal=>goal.id===change.goal&&goal.kind==='interact'&&goal.target===change.actor),'任务变身目标不匹配 '+quest.id);
    }
    for(const target of quest.descriptionTargets??[]){
      ensure(actors.has(target.target)||entities.has(target.target),'任务说明人物不存在 '+target.target);
      if(target.characterId)ensure(characters.has(target.characterId),'任务说明人物身份不存在 '+target.characterId);
    }
    for(const goal of quest.goals){
      if(goal.characterId)ensure(characters.has(goal.characterId),'任务目标人物身份不存在 '+goal.characterId);
      if(goal.kind==='defeat')ensure(enemies.has(goal.target),'任务敌人不存在 '+goal.target);
      if(goal.kind==='talk')ensure(actors.has(goal.target)||entities.has(goal.target),'任务对话人物不存在 '+goal.target);
    }
  }
  for(const event of campaign.events){
    if(event.nearCharacterId)ensure(characters.has(event.nearCharacterId),'近身人物身份不存在 '+event.nearCharacterId);
    condition(event.condition);if(event.entity)ensure(entities.has(event.entity),'事件实体不存在 '+event.entity);
    if(event.region&&event.map){const map=maps.get(event.map);ensure(map&&event.region.x<map.width&&event.region.y<map.height&&event.region.x+event.region.width>0&&event.region.y+event.region.height>0,'区域没有覆盖地图 '+event.id);}
  }
  for(const rule of campaign.exitRules??[]){ensure(exits.get(rule.id)===rule.map,'出口不存在 '+rule.id);condition(rule.condition);}
  for(const script of Object.values(campaign.scripts))for(const node of script.nodes){
    if(node.exit.type==='branch')condition(node.exit.condition);
    if(node.exit.type==='waitEncounter'){
      ensure(!!node.exit.outcomes.won,'遭遇缺少胜利出口 '+node.exit.encounter.id);
      encounter(node.exit.encounter);
    }
    // 舞台绑定的跨图检查已经覆盖 cast；这里补 `appear` 和 `mapFromStage` 摆放：
    // 它们同样会把一个世界实体写到舞台地图上，跨图时会把原图的 NPC 抹掉。
    const nodeStage=node.stage??node.presentation.find(action=>action.type==='stage');
    const nodeStageMap=nodeStage&&!nodeStage.mapFromWorld?nodeStage.map:undefined;
    if(nodeStageMap)for(const action of node.presentation){
      if(action.type==='appear'&&action.worldEntityId){
        checkEntityMap(action.worldEntityId,nodeStageMap,'出场实体跨越地图');
      }
      if(action.type==='world-object'&&action.command.kind==='place'&&action.command.mapFromStage){
        checkEntityMap(action.command.entity.id,nodeStageMap,'演出摆放跨越地图');
      }
    }
    const stages=[...(node.stage?[node.stage]:[]),...node.presentation.filter(action=>action.type==='stage')];
    for(const stage of stages){
      for(const member of stage.cast)if(member.enemyId)ensure(enemies.has(member.enemyId),'舞台敌人不存在 '+member.enemyId);
      const bindings=stage.cast.flatMap(member=>member.worldEntityId?[member.worldEntityId]:[]);
      ensure(new Set(bindings).size===bindings.length,'同一舞台重复绑定世界实体 '+node.id);
      for(const id of bindings){
        ensure(entities.has(id),'舞台世界实体不存在 '+id);
        // `place` 命令临时创建的实体没有静态归属，只做存在性检查。
        checkEntityMap(id,stage.map,'舞台绑定跨越地图');
      }
    }
  }
  for(const command of commands){
    if(command.type==='encounter')encounter(command.encounter);
    if(command.type==='talk')ensure(actors.has(command.target)||entities.has(command.target),'对话命令人物不存在 '+command.target);
    if(command.type==='world'){
      const value=command.command;
      if(value.kind==='place'){ensure(actors.has(value.entity.actor),'放置人物不存在 '+value.entity.actor);if(!value.mapFromStage)point(value.entity.map,value.entity.x,value.entity.y,value.entity.id);}
      if(value.kind==='show'||value.kind==='hide'||value.kind==='remove')ensure(entities.has(value.id)
        ||value.id.startsWith('quest-npc-located-')&&actors.has(value.id.slice('quest-npc-located-'.length)),'操作实体不存在 '+value.id);
      if(value.kind==='enemy-availability')ensure(enemies.has(value.enemyId),'地图怪物不存在 '+value.enemyId);
      if(value.kind==='exit')ensure(exits.has(value.id),'操作出口不存在 '+value.id);
      if(value.kind==='remove-enemy')ensure(enemies.has(value.enemyId),'移除敌人不存在 '+value.enemyId);
      if(value.kind==='enemy-location'){ensure(enemies.has(value.enemyId),'登记敌人不存在 '+value.enemyId);if(value.location)point(value.location.map,value.location.x,value.location.y,value.enemyId);}
      if(value.kind==='actor-appearance'){ensure(actors.has(value.actor),'外观人物不存在 '+value.actor);ensure(actors.has(value.appearance),'替换外观不存在 '+value.appearance);}
      if(value.kind==='encounter')encounter(value.encounter);
      if(value.kind==='travel')point(value.destination.map,value.destination.x,value.destination.y,'travel');
    }
    if(command.type==='travel')point(command.destination.map,command.destination.x,command.destination.y,'travel');
  }
}
