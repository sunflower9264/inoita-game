import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {prepareSavedGame,type SavedGameContent} from '../src/application/saved-game.ts';
import {newStorySession} from '../src/domain/story-class.ts';
import {captureSaveGame,saveSummary} from '../src/domain/save-game.ts';
import type {StoryWorldViewSnapshot} from '../src/scenes/world-scene.ts';
import {emptyShortcutRow} from '../src/domain/shortcut-bar.ts';
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

test('old saves containing removed expansion bags migrate to consumables',()=>{
  const saved=record(),bag=saved.session.bag;
  const equipped=new Set([...Object.values(bag.worn),...bag.companionEquipment.flatMap(([,equipment])=>Object.values(equipment))]);
  const entry=bag.instances.find(value=>!equipped.has(value.id))!;
  entry.item='handbag';
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.bag.get(entry.id)?.item,'healing-potion-m');
  assert.deepEqual(saved,before,'旧档迁移不改写槽里的原件');
});

test('old saves containing removed items drop them and every reference',()=>{
  for(const legacyItem of ['standard-dice','stats-reset-spell']){
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
