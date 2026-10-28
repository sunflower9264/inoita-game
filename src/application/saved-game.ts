import {newStorySession,type StoryClassCatalog} from '../domain/story-class.ts';
import {SAVE_FORMAT,isReadableSaveFormat,restoreSaveGame,type SaveGame} from '../domain/save-game.ts';
import {prepareCombatRestore} from '../domain/combat-snapshot.ts';
import type {Campaign} from '../domain/campaign.ts';
import type {WorldIndex} from '../domain/content.ts';
import type {ItemCatalog} from '../domain/items.ts';
import type {CharacterStatsCatalog} from '../domain/character-stats.ts';
import type {BattleCatalog} from '../domain/battle.ts';
import type {CompanionCatalog} from '../domain/party.ts';
import type {StoryWorldViewSnapshot} from '../scenes/world-scene.ts';
import {validateSceneSnapshot,type SceneActorState} from '../domain/scene-snapshot.ts';
import {duplicateVisibleActors} from '../domain/actor-census.ts';
import {dedupeSkillShortcuts} from '../domain/shortcut-bar.ts';

export interface SavedGameContent {
  campaign:Campaign;world:WorldIndex;storyClasses:StoryClassCatalog;items:ItemCatalog;
  characterStats:CharacterStatsCatalog;battleCatalog:BattleCatalog;companions:CompanionCatalog;
}
type SaveUpgrade = (game:SaveGame<StoryWorldViewSnapshot>)=>void;
interface LegacyStoryRun {stage?:Record<string,unknown>}
type LegacyScene = {actors?:unknown};
function duplicateSceneActors(scene:unknown):SceneActorState[][] {
  if(!scene||typeof scene!=='object')return [];
  const actors=(scene as LegacyScene).actors;
  if(!Array.isArray(actors))return [];
  return [...duplicateVisibleActors(actors as SceneActorState[]).values()];
}
function hideDuplicateSceneActors(scene:unknown):void {
  for(const same of duplicateSceneActors(scene))for(const actor of same.slice(1))actor.visible=false;
}
function stageHasDuplicateActors(stage:unknown):boolean {
  if(!stage||typeof stage!=='object')return false;
  const value=stage as {scene?:unknown;scenes?:unknown};
  if(duplicateSceneActors(value.scene).length)return true;
  return Array.isArray(value.scenes)&&value.scenes.some(scene=>duplicateSceneActors(scene).length>0);
}
/**
 * 旧存档升级链。33 → 34 时剧情运行时从 1 升到 2；旧舞台快照没有新版演出需要的
 * 场景和绑定，丢弃舞台让剧情从当前节点继续，其余进度原样保留。
 * 34 → 35 把同一技能占多格的旧快捷栏收敛成最后一格。
 * 35 → 36 收紧演员校验：世界场景里重复的同一实例只保留第一份；正在播放的舞台
 * 如果带重复演员，丢弃舞台快照，让剧情从当前节点继续而不是拒绝整份存档。
 */
const SAVE_UPGRADES:Record<number,SaveUpgrade>={
  33:game=>{
    const runtime=game.session.runtime as unknown as {version:number;runs?:LegacyStoryRun[]}|undefined;
    if(runtime?.version===1){
      runtime.version=2;
      for(const run of runtime.runs??[])if(run.stage&&(!('scene' in run.stage)||!('bindings' in run.stage)))delete run.stage;
    }
    game.format=34;
  },
  34:game=>{
    for(const [,row] of game.session.bag.shortcuts){
      const deduped=dedupeSkillShortcuts(row);
      for(let index=0;index<row.length;index++)row[index]=deduped[index]??null;
    }
    game.format=35;
  },
  35:game=>{
    hideDuplicateSceneActors(game.world?.scene);
    const runtime=game.session.runtime as unknown as {runs?:unknown[]}|undefined;
    for(const run of runtime?.runs??[]){
      if(!run||typeof run!=='object')continue;
      const value=run as {stage?:unknown};
      if(stageHasDuplicateActors(value.stage))delete value.stage;
    }
    game.format=36;
  },
};
function upgradeSavedGame(game:SaveGame<StoryWorldViewSnapshot>):SaveGame<StoryWorldViewSnapshot>{
  if(game.format===SAVE_FORMAT)return game;
  if(!isReadableSaveFormat(game.format))throw new Error('存档版本不受支持');
  const upgraded=structuredClone(game);
  while(upgraded.format!==SAVE_FORMAT){
    const upgrade=SAVE_UPGRADES[upgraded.format];if(!upgrade)throw new Error('存档版本不受支持');
    upgrade(upgraded);
  }
  return upgraded;
}
/**
 * 已删除的道具在旧档里这样处理：扩容背包换成可用的消耗品，其余直接丢弃。
 * 丢弃时必须同时清掉格位与快捷栏引用，否则背包自检会拒绝整份存档。
 */
const LEGACY_BAG_REPLACEMENTS:Record<string,string>={
  handbag:'healing-potion-m','small-bag':'healing-potion-l',backpack:'healing-potion-xl','infinity-bag':'elixir'};
const LEGACY_REMOVED_ITEMS=new Set(['novice-dice','standard-dice','advanced-dice','supreme-dice','chaos-dice','stats-reset-spell']);
function migrateLegacyItems(game:SaveGame<StoryWorldViewSnapshot>):SaveGame<StoryWorldViewSnapshot>{
  const session=game.session;
  const legacy=(id:string|undefined)=>!!id&&(LEGACY_BAG_REPLACEMENTS[id]!==undefined||LEGACY_REMOVED_ITEMS.has(id));
  const needsMigration=
    session.bag.instances.some(entry=>legacy(entry.item))||
    session.bag.shortcuts.some(([,row])=>row.some(slot=>slot?.kind==='item'&&legacy(slot.id)))||
    session.receipts.some(receipt=>receipt.reward.items.some(item=>legacy(item.item)))||
    session.groundLoot.drops.some(drop=>drop.reward.kind==='item'&&(legacy(drop.reward.item)||legacy(drop.reward.instance?.item)))||
    session.shops.stock.some(([,offers])=>offers.some(offer=>legacy(offer.instance.item)));
  if(!needsMigration)return game;
  const migrated=structuredClone(game),s=migrated.session;
  const replace=(id:string)=>LEGACY_BAG_REPLACEMENTS[id]??id;
  const removedIds=new Set<string>();
  s.bag.instances=s.bag.instances.filter(entry=>{
    entry.item=replace(entry.item);
    if(!LEGACY_REMOVED_ITEMS.has(entry.item))return true;
    removedIds.add(entry.id);return false;
  });
  if(removedIds.size){
    for(const [pouch,cells] of Object.entries(s.bag.pouches))
      s.bag.pouches[pouch as keyof typeof s.bag.pouches]=cells.filter(id=>id===undefined||!removedIds.has(id));
    s.bag.allCells=s.bag.allCells.filter(id=>id===undefined||!removedIds.has(id));
  }
  for(const [,row] of s.bag.shortcuts)for(const [index,slot] of row.entries())if(slot?.kind==='item'){
    if(LEGACY_REMOVED_ITEMS.has(slot.id))row[index]=null;else slot.id=replace(slot.id);
  }
  for(const receipt of s.receipts){
    for(const item of receipt.reward.items)item.item=replace(item.item);
    receipt.reward.items=receipt.reward.items.filter(item=>!LEGACY_REMOVED_ITEMS.has(item.item));
  }
  s.groundLoot.drops=s.groundLoot.drops.filter(drop=>{
    if(drop.reward.kind!=='item')return true;
    drop.reward.item=replace(drop.reward.item);
    if(drop.reward.instance)drop.reward.instance.item=replace(drop.reward.instance.item);
    const instanceItem=drop.reward.instance?.item;
    return !LEGACY_REMOVED_ITEMS.has(drop.reward.item)&&!(instanceItem&&LEGACY_REMOVED_ITEMS.has(instanceItem));
  });
  for(const [,offers] of s.shops.stock)offers.splice(0,offers.length,...offers.filter(offer=>!LEGACY_REMOVED_ITEMS.has(offer.instance.item)));
  return migrated;
}
/** 候选会话独立于当前游戏，坏记录在切换场景之前被拒绝。 */
export function prepareSavedGame(game:SaveGame<StoryWorldViewSnapshot>,content:SavedGameContent){
  const upgraded=migrateLegacyItems(upgradeSavedGame(game));
  const selected=content.storyClasses.classes.find(entry=>entry.id===upgraded.summary.classId);
  if(!selected)throw new Error('存档记录的职业在当前内容里不存在');
  const world=structuredClone(upgraded.world),location=world?.location;
  const map=content.world.maps.find(entry=>entry.id===location?.map);
  if(!map||upgraded.summary.mapId!==location.map||!Number.isFinite(location.x)||!Number.isFinite(location.y)||
    !['north','south','east','west'].includes(location.facing))throw new Error('存档记录的地图或位置无效');
  if(!Array.isArray(world.generatedEntities)||new Set(world.generatedEntities.map(entity=>entity.id)).size!==world.generatedEntities.length||
    world.generatedEntities.some(entity=>!content.world.actors[entity.actor]||!Number.isFinite(entity.x)||!Number.isFinite(entity.y)))throw new Error('存档记录的地图人物无效');
  // 33 版存档没有场景快照；位置由 `location` 与剧情世界状态重新投影。
  if(world.scene){
    validateSceneSnapshot(world.scene);
    const player=world.scene.actors.find(actor=>actor.id==='player');
    if(world.scene.map!==location.map||!player||player.x!==location.x||player.y!==location.y||player.facing!==location.facing)
      throw new Error('存档场景与主角位置不一致');
  }
  const session=newStorySession(content.campaign,content.world.actors[content.campaign.start.actor],selected,
    content.items,content.characterStats,content.battleCatalog,content.companions);
  restoreSaveGame(session,upgraded);
  if(world.world)world.world=prepareCombatRestore(world.world,content.battleCatalog,session.party?.activeIds??[]);
  return {session,world,map};
}
