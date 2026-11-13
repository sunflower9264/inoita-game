import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {prepareSavedGame,type SavedGameContent} from '../src/application/saved-game.ts';
import {newStorySession} from '../src/domain/story-class.ts';
import {captureSaveGame,saveSummary} from '../src/domain/save-game.ts';
import type {StoryWorldViewSnapshot} from '../src/scenes/world-scene.ts';
import {emptyShortcutRow} from '../src/domain/shortcut-bar.ts';
import type {WorldMap} from '../src/domain/content.ts';
import {WorldEnemyRoster} from '../src/domain/world-enemies.ts';
const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const content:SavedGameContent={campaign:read('campaign'),world:read('world'),storyClasses:read('story-classes'),
  items:read('items'),characterStats:read('character-stats'),battleCatalog:read('battle'),companions:read('companions')};
function record(index=0){
  const character=content.storyClasses.classes[index],session=newStorySession(content.campaign,content.world.actors[content.campaign.start.actor],character,
    content.items,content.characterStats,content.battleCatalog,content.companions);
  session.gainMoney(321);session.hero!.setHealth(7);session.hero!.setMana(3);
  const map=content.world.maps.find(entry=>entry.id!==content.campaign.start.map)!;
  const world:StoryWorldViewSnapshot={location:{map:map.id,x:16,y:24,facing:'west'},generatedEntities:[],scene:{map:map.id,
    actors:[{id:'player',actor:content.campaign.start.actor,memberId:'player',x:16,y:24,facing:'west',visible:true}]}};
  return captureSaveGame(session,world,saveSummary(session,{id:map.id,name:map.name},{name:character.name,portrait:'assets/ui/menus/character-kiyan.png'}));
}

test('format 36 saves keep their cached stage appearances through the upgrade',()=>{
  const saved=record(),script=Object.keys(content.campaign.scripts)[0],definition=content.campaign.scripts[script];
  const actor=content.world.actors[content.campaign.start.actor]!;
  const map=saved.world.location.map;
  saved.format=36;
  const runtime=saved.session.runtime as unknown as {version:number;runs:unknown[]};
  runtime.version=2;
  runtime.runs=[{id:'legacy-visual-stage',script,occurrence:'legacy-visual',cursor:{script,node:definition.entry},status:'running',
    stage:{type:'stage',map,x:saved.world.location.x,y:saved.world.location.y,facing:'west',playerVisible:true,cast:[],
      bindings:[['player','player']],scene:{map,actors:[{id:'player',actor:actor.id,memberId:'player',
        x:saved.world.location.x,y:saved.world.location.y,facing:'west',visible:true,appearance:structuredClone(actor)}]}}}];
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  const stage=candidate.session.runtimeState.runs[0]!.stage!;
  assert.equal(candidate.session.runtimeState.version,2,'旧档保留原来的完整快照版本');
  assert.deepEqual(stage.scene.actors[0]!.appearance,actor,'旧档的缓存外观仍可用于恢复');
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('format 41 saves with the removed counterattack settings still restore',()=>{
  const saved=record();
  saved.format=41;
  const party=saved.session.party as unknown as {heroCounterattack?:number};
  party.heroCounterattack=1;
  const before=structuredClone(saved);
  const candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.hero!.classId,saved.summary.classId);
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('format 43 saves drop quests removed from the campaign',()=>{
  const saved=record(),removed=['quest-8','quest-19','quest-20','quest-101','quest-451','quest-488','quest-504','quest-505','quest-506'];
  saved.format=43;
  for(const id of removed)saved.session.questBook.quests.push([id,{status:'locked',cycle:0,completedCycles:0,goals:{}}]);
  saved.session.trackedQuest=removed[0];
  saved.session.receipts.push({quest:removed[1],cycle:1,reward:{experience:0,money:0,items:[]}});
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content),state=candidate.session.captureState();
  assert.equal(state.questBook.quests.some(([id])=>removed.includes(id)),false,'旧档里的已删任务不再恢复');
  assert.equal(state.trackedQuest,undefined,'追踪到已删任务的旧档清除追踪');
  assert.equal(state.receipts.some(receipt=>removed.includes(receipt.quest)),false,'已删任务的结算回执一并清除');
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('each class restores into a fresh candidate and retains its destination, resources and inventory',()=>{
  for(let index=0;index<content.storyClasses.classes.length;index++){
    const saved=record(index),before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
    assert.equal(candidate.session.hero!.classId,saved.summary.classId);assert.equal(candidate.session.money,321);
    assert.equal(candidate.session.hero!.player.health,7);assert.equal(candidate.session.hero!.player.mana,3);
    assert.deepEqual(candidate.session.bag.captureState(),saved.session.bag);
    assert.deepEqual(candidate.world,saved.world);assert.equal(candidate.map.id,saved.world.location.map);
    assert.deepEqual(saved,before);
  }
});

test('the previous published save format restores without its missing scene snapshot and upgrades its runtime',()=>{
  const saved=record(),script=Object.keys(content.campaign.scripts)[0],definition=content.campaign.scripts[script];
  saved.format=33;
  const runtime=saved.session.runtime as unknown as {version:number;runs:unknown[]};
  runtime.version=1;
  runtime.runs=[{id:'legacy-run',script,occurrence:'legacy',cursor:{script,node:definition.entry},status:'running',
    stage:{type:'stage',map:saved.world.location.map,x:saved.world.location.x,y:saved.world.location.y,facing:'west',playerVisible:true,cast:[]}}];
  delete saved.world.scene;
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.money,321);
  assert.equal(candidate.session.runtimeState.version,2);
  assert.equal(candidate.session.runtimeState.runs[0]!.stage,undefined,'旧舞台没有场景与绑定，升级时丢弃');
  assert.equal(candidate.world.scene,undefined,'旧档没有场景快照，由地图重新投影');
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('format 34 and 33 duplicate skill shortcuts collapse to the last registered slot',()=>{
  for(const format of [34,33]){
    const saved=record(),skillId=content.battleCatalog.classes.find(value=>value.id===saved.summary.classId)!.skills[0]!;
    let playerRow=saved.session.bag.shortcuts.find(([owner])=>owner==='player')?.[1];
    if(!playerRow){playerRow=emptyShortcutRow();saved.session.bag.shortcuts.push(['player',playerRow]);}
    const original={kind:'skill' as const,id:skillId},row=emptyShortcutRow();
    row[0]={...original};row[9]={...original};
    for(let index=0;index<row.length;index++)playerRow[index]=row[index];
    saved.format=format;
    const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
    const restored=candidate.session.bag.captureState().shortcuts.find(([owner])=>owner==='player')![1];
    assert.equal(restored[0],null,'较早的副本被清掉');
    assert.deepEqual(restored[9],original,'保留数组里最后出现的技能槽');
    assert.deepEqual(saved,before,'迁移不改写原始存档');
  }
});

test('format 35 saves hide duplicate world actors and drop a duplicate story stage',()=>{
  const saved=record(),script=Object.keys(content.campaign.scripts)[0],definition=content.campaign.scripts[script];
  saved.format=35;
  const player=saved.world.scene!.actors[0]!,duplicate={...player,id:'duplicate-player'};
  saved.world.scene!.actors.push(duplicate);
  const runtime=saved.session.runtime as unknown as {version:number;runs:unknown[]};
  runtime.runs=[{id:'duplicate-stage',script,occurrence:'duplicate',cursor:{script,node:definition.entry},status:'running',
    stage:{type:'stage',map:saved.world.location.map,x:saved.world.location.x,y:saved.world.location.y,facing:'west',
      playerVisible:true,cast:[],bindings:[['player','player']],
      scene:{map:saved.world.location.map,actors:[player,{...player,id:'duplicate-player'}]}}}];
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.world.scene!.actors.find(actor=>actor.id==='duplicate-player')!.visible,false);
  assert.equal(candidate.session.runtimeState.runs[0]!.stage,undefined,'重复演员的旧舞台不恢复');
  assert.deepEqual(saved,before,'迁移不改写原始存档');
});

test('format 40 saves gain an empty reserved drop state on upgrade',()=>{
  const saved=record();saved.format=40;
  const candidate=prepareSavedGame(saved,content);
  assert.deepEqual(candidate.session.captureState().reservedDrops,{unlockMisses:0,claimed:[]});
});

test('old saves containing removed expansion bags migrate to consumables',()=>{
  const saved=record(),bag=saved.session.bag;
  const equipped=new Set([...Object.values(bag.worn),...bag.companionEquipment.flatMap(([,equipment])=>Object.values(equipment))]);
  const entry=bag.instances.find(value=>!equipped.has(value.id))!;
  entry.item='handbag';
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.bag.get(entry.id)?.item,'healing-potion-m');
  assert.deepEqual(saved,before,'旧档迁移不改写槽里的原件');
});

test('old infinity bags keep the existing elixir replacement',()=>{
  // 旧档保持原样：不因为 reservedItems 改动既有迁移结果，避免影响现有测试玩家。
  const saved=record(),bag=saved.session.bag;
  const equipped=new Set([...Object.values(bag.worn),...bag.companionEquipment.flatMap(([,equipment])=>Object.values(equipment))]);
  const entry=bag.instances.find(value=>!equipped.has(value.id))!;
  entry.item='infinity-bag';
  const candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.bag.get(entry.id)?.item,'elixir');
});

test('old saves containing removed items drop them and every reference',()=>{
  for(const legacyItem of ['standard-dice','stats-reset-spell','resurrection-prayer']){
    const saved=record(),bag=saved.session.bag;
    const equipped=new Set([...Object.values(bag.worn),...bag.companionEquipment.flatMap(([,equipment])=>Object.values(equipment))]);
    const entry=bag.instances.find(value=>!equipped.has(value.id))!;
    entry.item=legacyItem;
    if(!bag.shortcuts.length)bag.shortcuts.push(['player',emptyShortcutRow()]);
    const row=bag.shortcuts[0]![1];
    row[row.length-1]={kind:'item',id:legacyItem};
    const map=saved.world.location.map;
    saved.session.groundLoot.drops.push({id:'ground-legacy',map,x:16,y:24,reward:{kind:'item',item:legacyItem,quantity:1}});
    saved.session.shops.stock.push(['legacy-shop',[{id:'legacy-offer',instance:{id:'legacy-instance',item:legacyItem,quantity:1,enhancement:0,gems:[]},
      limited:true,concealed:false,sold:false}]]);
    const before=structuredClone(saved),candidate=prepareSavedGame(saved,content),state=candidate.session.bag.captureState();
    assert.equal(candidate.session.bag.get(entry.id),undefined,`${legacyItem} 实例被丢弃`);
    assert.ok(!state.allCells.includes(entry.id),`${legacyItem} 全部页不再引用被丢弃的实例`);
    for(const cells of Object.values(state.pouches))assert.ok(!cells.includes(entry.id),`${legacyItem} 分类袋不再引用被丢弃的实例`);
    for(const [,shortcut] of state.shortcuts)for(const slot of shortcut)assert.ok(!(slot?.kind==='item'&&slot.id===legacyItem),`${legacyItem} 快捷栏不再指向被删除的道具`);
    const restored=candidate.session.captureState();
    assert.ok(!restored.groundLoot.drops.some(drop=>drop.id==='ground-legacy'),`${legacyItem} 地面掉落被丢弃`);
    assert.ok(!restored.shops.stock.some(([,offers])=>offers.some(offer=>offer.instance.item===legacyItem)),`${legacyItem} 商店存货被丢弃`);
    assert.deepEqual(saved,before,'旧档迁移不改写槽里的原件');
  }
});

test('a save written with a wiped party is repaired before it enters the world',()=>{
  const saved=record();
  saved.session.hero!.health=0;
  const candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.hasLivingMember,true);
  assert.equal(candidate.session.hero!.player.health,candidate.session.hero!.player.maxHealth);
  assert.equal(candidate.session.hero!.player.mana,candidate.session.hero!.player.maxMana);
  assert.equal(saved.session.hero!.health,0,'修复只发生在候选会话，不改写槽里的原件');
});

test('invalid class, map, position and actors are rejected without changing the saved input',()=>{
  for(const change of [
    (game:ReturnType<typeof record>)=>{game.summary.classId='missing';},
    (game:ReturnType<typeof record>)=>{game.world.location.map='missing';},
    (game:ReturnType<typeof record>)=>{game.world.location.x=NaN;},
    (game:ReturnType<typeof record>)=>{game.world.generatedEntities.push({id:'ghost',actor:'missing',x:0,y:0});},
    (game:ReturnType<typeof record>)=>{game.world.scene!.map='another-map';},
    (game:ReturnType<typeof record>)=>{game.world.scene!.actors[0]!.x++;},
    (game:ReturnType<typeof record>)=>{game.world.scene!.actors.push({...game.world.scene!.actors[0]!});},
  ]){
    const saved=record();change(saved);const before=structuredClone(saved);
    assert.throws(()=>prepareSavedGame(saved,content));assert.deepEqual(saved,before);
  }
});

test('scene visit actors are validated before installation for current and previous saves',()=>{
  for(const format of [47,48]){
    const saved=record();saved.format=format;
    saved.world.scene!.visit={generatedEntities:[{id:'visitor',actor:'missing',x:0,y:0}],
      breakableRolls:[],roster:{enemies:[],sequence:0,partySize:1}};
    const before=structuredClone(saved);
    assert.throws(()=>prepareSavedGame(saved,content),/存档记录的地图人物无效/);
    assert.deepEqual(saved,before);
    saved.world.scene!.visit.generatedEntities[0]!.actor=content.campaign.start.actor;
    assert.equal(prepareSavedGame(saved,content).world.scene!.visit!.generatedEntities[0]!.actor,content.campaign.start.actor);
  }
});

test('format 37 pity counters migrate to unique and epic counters',()=>{
  const saved=record();saved.format=37;
  const pity=saved.session.lootPity as unknown as {
    version:number;
    members:[string,{equipmentMisses:number;rarePlusMisses:number}][];
    chests:[string,{equipmentMisses:number;rarePlusMisses:number}][];
    bossDefeats:string[];
  };
  pity.version=1;
  pity.members=[['player',{equipmentMisses:3,rarePlusMisses:7}]];
  pity.chests=[['ordinary',{equipmentMisses:2,rarePlusMisses:5}]];
  pity.bossDefeats=['enemy-boss'];
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  const state=candidate.session.lootPity.captureState();
  assert.equal(state.version,2);
  assert.deepEqual(state.members.find(([id])=>id==='player')?.[1],{equipmentMisses:3,uniqueMisses:7,epicMisses:0});
  assert.deepEqual(state.chests.find(([id])=>id==='ordinary')?.[1],{equipmentMisses:2,uniqueMisses:0,epicMisses:0});
  assert.deepEqual(state.bossDefeats,['enemy-boss']);
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('format 38 saves gain an empty consumed-sword set on upgrade',()=>{
  const saved=record();saved.format=38;delete (saved.session as {legendaryWeapons?:unknown}).legendaryWeapons;
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.deepEqual(candidate.session.legendaryWeapons.captureState(),{used:[]});
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('current saves keep the per-map consumed sword list',()=>{
  const saved=record();saved.session.legendaryWeapons={used:['map-a:sword-001','map-a:sword-005']};
  const candidate=prepareSavedGame(saved,content);
  assert.deepEqual(candidate.session.legendaryWeapons.captureState(),{used:['map-a:sword-001','map-a:sword-005']});
});

const HALL_MAP='noxious-sanctum-main-hall-2e80d907',CURSED_GHOST='enemy-cursed-ghost-1';
const ghostSpawns=Array.from({length:7},(_,index)=>`${HALL_MAP}-spawn-${String(index+1).padStart(3,'0')}`);
const hallMap=read<WorldMap>(`maps/${HALL_MAP}`);
const permanent=(id:string):[string,{health:number;deadUntil:'permanent'}]=>[id,{health:0,deadUntil:'permanent'}];
/** 复现 39 版旧档：event-115 的 remove-enemy 把这 7 只写成了永久死亡。 */
function legacyGhostSave(runtime:(saved:ReturnType<typeof record>)=>void){
  const saved=record();saved.format=39;
  saved.session.enemies.push(...ghostSpawns.map(permanent),permanent('enemy-boss-permanent'));
  saved.session.storyWorld.entities.push(...ghostSpawns.map(id=>({id,removed:true})));
  saved.session.storyWorld.enemyRemovals=[
    {enemyId:CURSED_GHOST,map:HALL_MAP,all:true},
    {enemyId:'enemy-other-map',map:'another-map',all:true},
  ];
  saved.session.storyWorld.flags.push(...[...ghostSpawns,CURSED_GHOST]
    .map(enemyId=>JSON.stringify(['absent-enemy',HALL_MAP,enemyId])));
  runtime(saved);
  return saved;
}

test('format 39 saves restore event-115 hall ghosts after the event completed',()=>{
  const saved=legacyGhostSave(value=>{value.session.runtime.completedEvents.push('event-115');});
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  for(const id of ghostSpawns)assert.equal(candidate.session.enemyVitals(id).deadUntil,undefined);
  assert.equal(candidate.session.enemyVitals('enemy-boss-permanent').deadUntil,'permanent','其他敌人的永久死亡保持不变');
  assert.equal(candidate.session.storyWorld.enemyAvailable(HALL_MAP,CURSED_GHOST),true);
  for(const id of ghostSpawns)assert.equal(candidate.session.storyWorld.entity(id),undefined);
  assert.deepEqual(candidate.session.storyWorld.pendingEnemyRemovals,
    [{enemyId:'enemy-other-map',map:'another-map',all:true}],'只清掉大厅的清场命令');
  const roster=new WorldEnemyRoster(candidate.session,hallMap,[],1,undefined,()=>0.9);
  assert.deepEqual(roster.spawns.map(spawn=>spawn.id).sort(),[...ghostSpawns].sort());
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('format 39 saves taken during event-115 keep the hall ghosts suppressed',()=>{
  const saved=legacyGhostSave(value=>{
    value.session.runtime.runs.push({id:'legacy-event-115',eventId:'event-115',occurrence:'region:event-115',
      cursor:{script:'event-115',node:'done'},status:'running'});
  });
  const candidate=prepareSavedGame(saved,content);
  for(const id of ghostSpawns)assert.equal(candidate.session.enemyVitals(id).deadUntil,undefined);
  assert.equal(candidate.session.storyWorld.enemyAvailable(HALL_MAP,CURSED_GHOST),false);
  assert.equal(candidate.session.enemyVitals('enemy-boss-permanent').deadUntil,'permanent');
  assert.deepEqual(new WorldEnemyRoster(candidate.session,hallMap,[],1,undefined,()=>0.9).spawns,[]);
});

test('format 39 saves that never started event-115 restore the hall ghosts without suppression',()=>{
  const saved=legacyGhostSave(()=>{});
  const candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.storyWorld.enemyAvailable(HALL_MAP,CURSED_GHOST),true);
  assert.equal(candidate.session.enemyVitals('enemy-boss-permanent').deadUntil,'permanent');
  const roster=new WorldEnemyRoster(candidate.session,hallMap,[],1,undefined,()=>0.9);
  assert.deepEqual(roster.spawns.map(spawn=>spawn.id).sort(),[...ghostSpawns].sort());
});

test('format 44 equipment defaults unlocked and current equipment locks round trip',()=>{
  const legacy=record();legacy.format=44;
  for(const entry of legacy.session.bag.instances)delete entry.locked;
  const candidate=prepareSavedGame(legacy,content);
  assert.ok(candidate.session.bag.captureState().instances.every(entry=>!entry.locked));
  const saved=record(),equipment=saved.session.bag.instances.find(entry=>content.items.items[entry.item].equipment)!;
  equipment.locked=true;
  const loaded=prepareSavedGame(saved,content);
  assert.equal(loaded.session.bag.get(equipment.id)!.locked,true);
});

 test('format 46 held poses retain their finish policy and do not mutate the old save',()=>{
  const saved=record(); saved.format=46;
  const player=saved.world.scene!.actors[0]!;
  Object.assign(player,{clip:'lie-side-west',animationProgress:1,animationPlaying:false});
  const before=structuredClone(saved);
  const restored=prepareSavedGame(saved,content);
  assert.equal(restored.world.scene!.actors[0]!.storyPoseHold,true);
  assert.deepEqual(saved,before);
 });

test('format 46 repairs a hidden player only in the affected same-map event',()=>{
  for (const event of [352,4]) {
    const saved=record();saved.format=46;
    const script=`event-${event}`,map=saved.world.location.map;
    const player=structuredClone(saved.world.scene!.actors[0]!);player.visible=false;
    const runtime=saved.session.runtime as unknown as {runs:unknown[]};
    runtime.runs=[{id:'visibility',script,eventId:script,occurrence:'visibility',cursor:{script,node:content.campaign.scripts[script]!.entry},status:'running',
      stage:{type:'stage',map,x:player.x,y:player.y,facing:player.facing,playerVisible:false,cast:[],bindings:[['player','player']],scene:{map,actors:[player]}}}];
    const stage=prepareSavedGame(saved,content).session.runtimeState.runs[0]!.stage!;
    assert.equal(stage.playerVisible,event===352);
    assert.equal(stage.scene.actors[0]!.visible,event===352);
  }
});
