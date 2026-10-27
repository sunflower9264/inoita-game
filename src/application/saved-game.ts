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
import {validateSceneSnapshot} from '../domain/scene-snapshot.ts';

export interface SavedGameContent {
  campaign:Campaign;world:WorldIndex;storyClasses:StoryClassCatalog;items:ItemCatalog;
  characterStats:CharacterStatsCatalog;battleCatalog:BattleCatalog;companions:CompanionCatalog;
}
type SaveUpgrade = (game:SaveGame<StoryWorldViewSnapshot>)=>void;
interface LegacyStoryRun {stage?:Record<string,unknown>}
/**
 * 旧存档升级链。33 → 34 时剧情运行时从 1 升到 2；旧舞台快照没有新版演出需要的
 * 场景和绑定，丢弃舞台让剧情从当前节点继续，其余进度原样保留。
 */
const SAVE_UPGRADES:Record<number,SaveUpgrade>={
  33:game=>{
    const runtime=game.session.runtime as unknown as {version:number;runs?:LegacyStoryRun[]}|undefined;
    if(runtime?.version===1){
      runtime.version=2;
      for(const run of runtime.runs??[])if(run.stage&&(!('scene' in run.stage)||!('bindings' in run.stage)))delete run.stage;
    }
    game.format=SAVE_FORMAT;
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
/** 已删除的扩容背包在旧档里换成可用的消耗品，避免删内容后旧进度读不出来。 */
const LEGACY_BAG_REPLACEMENTS:Record<string,string>={
  handbag:'healing-potion-m','small-bag':'healing-potion-l',backpack:'healing-potion-xl','infinity-bag':'elixir'};
function migrateLegacyBagItems(game:SaveGame<StoryWorldViewSnapshot>):SaveGame<StoryWorldViewSnapshot>{
  const session=game.session,legacy=(id:string|undefined)=>!!id&&LEGACY_BAG_REPLACEMENTS[id]!==undefined;
  const needsMigration=
    session.bag.instances.some(entry=>legacy(entry.item))||
    session.bag.shortcuts.some(([,row])=>row.some(slot=>slot?.kind==='item'&&legacy(slot.id)))||
    session.receipts.some(receipt=>receipt.reward.items.some(item=>legacy(item.item)))||
    session.groundLoot.drops.some(drop=>drop.reward.kind==='item'&&(legacy(drop.reward.item)||legacy(drop.reward.instance?.item)));
  if(!needsMigration)return game;
  const migrated=structuredClone(game),s=migrated.session;
  const replace=(id:string)=>LEGACY_BAG_REPLACEMENTS[id]??id;
  for(const entry of s.bag.instances)entry.item=replace(entry.item);
  for(const [,row] of s.bag.shortcuts)for(const slot of row)if(slot?.kind==='item')slot.id=replace(slot.id);
  for(const receipt of s.receipts)for(const item of receipt.reward.items)item.item=replace(item.item);
  for(const drop of s.groundLoot.drops)if(drop.reward.kind==='item'){
    drop.reward.item=replace(drop.reward.item);
    if(drop.reward.instance)drop.reward.instance.item=replace(drop.reward.instance.item);
  }
  return migrated;
}
/** 候选会话独立于当前游戏，坏记录在切换场景之前被拒绝。 */
export function prepareSavedGame(game:SaveGame<StoryWorldViewSnapshot>,content:SavedGameContent){
  const upgraded=migrateLegacyBagItems(upgradeSavedGame(game));
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
