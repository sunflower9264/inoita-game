import {newStorySession,type StoryClassCatalog} from '../domain/story-class.ts';
import {isReadableSaveFormat,restoreSaveGame,type SaveGame} from '../domain/save-game.ts';
import {prepareCombatRestore} from '../domain/combat-snapshot.ts';
import type {Campaign} from '../domain/campaign.ts';
import type {WorldIndex} from '../domain/content.ts';
import type {ItemCatalog} from '../domain/items.ts';
import type {CharacterStatsCatalog} from '../domain/character-stats.ts';
import type {BattleCatalog} from '../domain/battle.ts';
import type {CompanionCatalog} from '../domain/party.ts';
import type {StoryWorldViewSnapshot} from './world-snapshot.ts';
import {validateSceneSnapshot} from '../domain/scene-snapshot.ts';

export interface SavedGameContent {
  campaign:Campaign;world:WorldIndex;storyClasses:StoryClassCatalog;items:ItemCatalog;
  characterStats:CharacterStatsCatalog;battleCatalog:BattleCatalog;companions:CompanionCatalog;
}
export function prepareSavedGame(game:SaveGame<StoryWorldViewSnapshot>,content:SavedGameContent){
  if(!isReadableSaveFormat(game.format))throw new Error('存档版本不受支持');
  const selected=content.storyClasses.classes.find(entry=>entry.id===game.summary.classId);
  if(!selected)throw new Error('存档记录的职业在当前内容里不存在');
  const world=structuredClone(game.world),location=world?.location;
  const map=content.world.maps.find(entry=>entry.id===location?.map);
  if(!map||game.summary.mapId!==location.map||!Number.isFinite(location.x)||!Number.isFinite(location.y)||
    !['north','south','east','west'].includes(location.facing))throw new Error('存档记录的地图或位置无效');
  if(!Array.isArray(world.generatedEntities)||new Set(world.generatedEntities.map(entity=>entity.id)).size!==world.generatedEntities.length||
    world.generatedEntities.some(entity=>!content.world.actors[entity.actor]||!Number.isFinite(entity.x)||!Number.isFinite(entity.y)))throw new Error('存档记录的地图人物无效');
  const contacts=world.triggerContacts;
  if(contacts!==undefined&&(!contacts||[contacts.regions,contacts.characters,contacts.nearEvents].some(
    ids=>!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))))throw new Error('存档记录的剧情接触无效');
  // 缺场景快照时，位置由 `location` 与剧情世界状态重新投影。
  if(world.scene){
    validateSceneSnapshot(world.scene);
    if(world.scene.visit?.generatedEntities.some(entity=>!content.world.actors[entity.actor]))
      throw new Error('存档记录的地图人物无效');
    if(world.scene.visit){
      const enemyIds=new Set(content.battleCatalog.enemies.map(enemy=>enemy.id));
      if(world.scene.visit.roster.enemies.some(enemy=>!enemyIds.has(enemy.enemyId))||
        world.scene.visit.breakableRolls.some(([,enemyId])=>!enemyIds.has(enemyId)))
        throw new Error('存档记录的地图敌人无效');
    }
    const player=world.scene.actors.find(actor=>actor.id==='player');
    if(world.scene.map!==location.map||!player||player.x!==location.x||player.y!==location.y||player.facing!==location.facing)
      throw new Error('存档场景与主角位置不一致');
  }
  const session=newStorySession(content.campaign,content.world.actors[content.campaign.start.actor],selected,
    content.items,content.characterStats,content.battleCatalog,content.companions);
  restoreSaveGame(session,game);
  // 读取时补齐已经拥有的解锁道具领取记录：不改背包，只避免一次性掉落再给一份。
  const seeded=new Set<string>();
  for(const entry of session.bag.entries){
    const definition=content.items.items[entry.item];
    if(definition?.use?.kind==='recipe'||definition?.use?.kind==='box'||entry.item.startsWith('sealed-skillbook'))
      seeded.add(entry.item);
  }
  for(const [id,definition] of Object.entries(content.items.items)){
    if(definition.use?.kind==='recipe'&&definition.use.recipes?.some(recipe=>session.bag.learnedRecipes.includes(recipe)))
      seeded.add(id);
  }
  session.seedReservedClaims(seeded);
  if(!session.hasLivingMember)throw new Error('存档没有存活队员');
  if(session.party&&!session.party.alive(session.party.controlledId)){
    session.party.switchControl(session.party.livingIds[0]!);
  }
  if(world.world)world.world=prepareCombatRestore(world.world,content.battleCatalog,session.party?.activeIds??[]);
  return {session,world,map};
}
