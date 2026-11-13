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
/** 40 版迁移只针对「被污染的神殿大堂」这 7 只常驻恶灵，其他敌人的永久死亡原样保留。 */
const NOXIOUS_HALL_MAP='noxious-sanctum-main-hall-2e80d907';
const CURSED_GHOST_ENEMY='enemy-cursed-ghost-1';
const CURSED_GHOST_SPAWNS=new Set(Array.from({length:7},(_,index)=>
  `${NOXIOUS_HALL_MAP}-spawn-${String(index+1).padStart(3,'0')}`));
const absentEnemyFlag=(map:string,enemyId:string)=>JSON.stringify(['absent-enemy',map,enemyId]);
/** 43 版之前所有任务都会写进存档；这些日志外废案删除后，旧档升级时一并清掉。 */
const REMOVED_QUESTS=new Set(['quest-8','quest-19','quest-20','quest-101','quest-451','quest-488','quest-504','quest-505','quest-506']);
interface SavedStoryRuntime {runs?:{eventId?:string;status?:string}[];completedEvents?:string[]}
/** 事件已结束或从未开始时不压制；只有它正在演出或等待战斗时才保留清场标记。 */
function eventInProgress(runtime:SavedStoryRuntime|undefined,eventId:string):boolean {
  if(!runtime||runtime.completedEvents?.includes(eventId))return false;
  return (runtime.runs??[]).some(run=>run.eventId===eventId&&(run.status==='running'||run.status==='waiting'));
}
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
  46:game=>{
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (typeof record.clip === 'string' && /^(lie-down|lie-side|cry|pick-up)-/.test(record.clip)) record.storyPoseHold = true;
      const visibleEvents = ['event-54','event-60','event-72','event-74','event-85','event-352','event-392','event-393','event-394','event-395'];
      if (visibleEvents.includes(String(record.eventId ?? record.script)) && record.stage && typeof record.stage === 'object') {
        const stage = record.stage as {playerVisible?:boolean;scene?:{actors?:SceneActorState[]}};
        stage.playerVisible = true;
        for (const actor of stage.scene?.actors ?? []) {
          if (actor.id === 'player') actor.visible = true;
          else if (actor.followsPlayer && !actor.stageHidden && actor.followVisibility !== undefined) {
            actor.visible = actor.followVisibility; delete actor.followVisibility;
          }
        }
      }
      for (const child of Object.values(record)) visit(child);
    };
    visit(game.session); visit(game.world);
    game.format=47;
  },
  45:game=>{
    const party=game.session.party;
    for(const member of party?.members??[]){
      member.allocationBaseLevel=member.level;
      member.allocation={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
    }
    game.format=46;
  },
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
  /** 37 只改变写档方式：舞台外观不再写入，读档时重新解析。旧档里的完整外观仍然可读。 */
  36:game=>{
    game.format=37;
  },
  /**
   * 37 → 38：掉落保底从两本账扩成三本。旧 rarePlusMisses 迁到 uniqueMisses，
   * 紫装从 0 开始；宝箱不记黄/紫保底。已经是新结构的档保持原值，保证幂等。
   */
  37:game=>{
    interface LegacyCounters { equipmentMisses?:unknown; rarePlusMisses?:unknown; uniqueMisses?:unknown; epicMisses?:unknown }
    interface LegacyPity { version:number; members:[string,LegacyCounters][]; chests:[string,LegacyCounters][]; bossDefeats:string[] }
    const pity=game.session.lootPity as unknown as LegacyPity|undefined;
    if(!pity)game.session.lootPity={version:2,members:[],chests:[],bossDefeats:[]};
    else if(pity.version!==2){
      const convert=(counters:{equipmentMisses?:unknown;rarePlusMisses?:unknown;uniqueMisses?:unknown;epicMisses?:unknown}) => ({
        equipmentMisses:Number.isSafeInteger(counters.equipmentMisses)?counters.equipmentMisses as number:0,
        uniqueMisses:Number.isSafeInteger(counters.uniqueMisses)?counters.uniqueMisses as number:
          (Number.isSafeInteger(counters.rarePlusMisses)?counters.rarePlusMisses as number:0),
        epicMisses:Number.isSafeInteger(counters.epicMisses)?counters.epicMisses as number:0
      });
      pity.version=2;
      pity.members=pity.members.map(([id,counters])=>[id,convert(counters)]);
      // 宝箱只维护装备计数，旧 rarePlusMisses 从未参与宝箱逻辑，迁移时直接归零。
      pity.chests=pity.chests.map(([id,counters])=>[id,{
        equipmentMisses:Number.isSafeInteger(counters.equipmentMisses)?counters.equipmentMisses as number:0,
        uniqueMisses:0,
        epicMisses:0
      }]);
    }
    game.format=38;
  },
  38:game=>{
    // 38 → 39：记录每张地图已拔出的古老武器；旧档视为一把都没拔。
    game.session.legendaryWeapons={used:[]};
    game.format=39;
  },
  /**
   * 39 → 40：event-115 以前用 remove-enemy 把这 7 只常驻恶灵写成永久死亡，
   * 换图、读档、检查点都不恢复。这里只撤销这 7 个固定 spawn 的永久状态，
   * 其他敌人的永久死亡原样保留；事件正在演出或等待战斗时改为「暂时不可生成」，
   * 事件结束后由 battle-won / battle-lost 的正常命令解除压制。
   */
  39:game=>{
    const session=game.session,world=session.storyWorld;
    session.enemies=session.enemies.filter(([id,enemy])=>!(CURSED_GHOST_SPAWNS.has(id)&&enemy.deadUntil==='permanent'));
    world.entities=world.entities.filter(entity=>!(CURSED_GHOST_SPAWNS.has(entity.id)&&entity.removed));
    if(world.enemyRemovals)world.enemyRemovals=world.enemyRemovals.filter(removal=>
      !(removal.map===NOXIOUS_HALL_MAP&&removal.enemyId===CURSED_GHOST_ENEMY));
    const staleFlags=new Set([...CURSED_GHOST_SPAWNS].map(id=>absentEnemyFlag(NOXIOUS_HALL_MAP,id)));
    staleFlags.add(absentEnemyFlag(NOXIOUS_HALL_MAP,CURSED_GHOST_ENEMY));
    world.flags=world.flags.filter(flag=>!staleFlags.has(flag));
    if(eventInProgress(session.runtime,'event-115'))
      world.flags.push(absentEnemyFlag(NOXIOUS_HALL_MAP,CURSED_GHOST_ENEMY));
    game.format=40;
  },
  40:game=>{
    // 40 → 41：付费道具改为独立掉落；旧档只补空的领取/保底状态，不清理已有物品。
    game.session.reservedDrops={unlockMisses:0,claimed:[]};
    game.format=41;
  },
  41:game=>{
    // 41 → 42：删除自动反击档位和队伍受击计数；佣兵只跟随主角的攻击。
    const party=game.session.party as unknown as {heroCounterattack?:unknown;members?:{counterattack?:unknown}[]}|undefined;
    if(party){delete party.heroCounterattack;for(const member of party.members??[])delete member.counterattack;}
    const world=game.world.world as unknown as {damageCount?:unknown}|undefined;
    if(world)delete world.damageCount;
    game.format=42;
  },
  /** 42 → 43：摘要增加可选的存档截图；旧档没有截图，存档页不画图片。 */
  42:game=>{
    game.format=43;
  },
  /** 43 → 44：删除 9 条日志外废案；旧档的任务簿、运行池、回执与追踪一并清理。 */
  44:game=>{
    for(const entry of game.session.bag.instances)entry.locked=false;
    game.format=45;
  },
  43:game=>{
    const session=game.session;
    session.questBook.quests=session.questBook.quests.filter(([id])=>!REMOVED_QUESTS.has(id));
    session.questBook.runningQuestIds=session.questBook.runningQuestIds.filter(id=>!REMOVED_QUESTS.has(id));
    session.receipts=session.receipts.filter(receipt=>!REMOVED_QUESTS.has(receipt.quest));
    if(session.trackedQuest&&REMOVED_QUESTS.has(session.trackedQuest))delete session.trackedQuest;
    game.format=44;
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
const LEGACY_REMOVED_ITEMS=new Set(['novice-dice','standard-dice','advanced-dice','supreme-dice','chaos-dice','stats-reset-spell','resurrection-prayer']);
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
  // 旧档已经拥有的解锁型道具补领取记录：不删除任何东西，只避免新掉落再给一份。
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
  // 旧版本可能把全队 0 血写成存档；进世界前恢复上阵队伍，避免读档后立刻弹出阵亡面板。
  if(!session.hasLivingMember){
    if(session.party)session.party.recover();else session.hero?.recover();
    globalThis.storyDiagnostics?.record('save-repaired-no-survivor',{classId:upgraded.summary.classId,level:upgraded.summary.level,map:location.map});
  }else if(session.party&&!session.party.alive(session.party.controlledId)){
    session.party.switchControl(session.party.livingIds[0]!);
  }
  if(world.world)world.world=prepareCombatRestore(world.world,content.battleCatalog,session.party?.activeIds??[]);
  return {session,world,map};
}
