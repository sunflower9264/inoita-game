import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canStandOnTerrain,overlapsFootRect} from '../src/domain/navigation.ts';
import type {Point} from '../src/domain/navigation.ts';
import {NavigationWorld,mirroredCollision} from '../src/domain/navigation-world.ts';
import { storyActions } from '../src/domain/story-script.ts';
import { storyConditionReferences } from '../src/domain/story-condition.ts';
import { StoryWorldState } from '../src/domain/story-world.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type {ChoiceAction, ClipName, DialogueLine, WorldIndex, WorldMap} from '../src/domain/content.ts';
import type { StoryStage } from '../src/domain/story-performance.ts';
import { parseCampaign, parseItemCatalog, parseStoryInterface, validateStoryItems } from '../src/application/content-validation.ts';
import { PROP_ATLAS_BY_KEY } from '../src/generated/prop-atlas.ts';
import { UI_ATLAS_FRAMES } from '../src/generated/ui-atlas.ts';
import { sourceAssetPath } from '../tools/asset-source.ts';


function navigationFor(map: WorldMap, entities = map.entities): NavigationWorld {
 const navigation = new NavigationWorld(map);
 for (const entity of entities) navigation.register({shape:()=>({collision:mirroredCollision(world.actors[entity.actor].collision,entity.flip)}),position:()=>entity,enabled:()=>true});
 return navigation;
}

const root=fileURLToPath(new URL('../public/',import.meta.url));
const read=<T = WorldMap>(file: string): T=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8')) as T;
const world=read<WorldIndex>('content/world.json'),campaign=read<Campaign>('content/campaign.json');
const storyInterface=read<{portraits:Record<string,string>}>('content/story-interface.json');
// 原版 PORTRAITBASE 身份；只保留有立绘的人物。
const originalActorIdentities:Record<string,string>={
 darius:'2:40','azad-053':'2:53',portia:'2:54',janus:'2:55',shinty:'2:56','alexander-057':'2:57',
 'eara-058':'2:58',saint:'2:79','eara-142':'2:142','cornette-199':'2:199','olaf-249':'2:249',
 'eara-302':'2:302','eara-492':'2:492','veteran-498':'2:498','stranger-of-hwagan-509':'2:509',
 'azad-510':'2:510','shin-587':'2:587','portia-599':'2:599',
 'enemy-dragon-alexander-1':'1:350','enemy-dark-forces-of-evil-1':'1:356',
};

test('the capital and camp use town poses, and the cave confrontation changes them before walking', () => {
 for (const id of ['shadow-camp', 'berkel-capital']) {
  assert.equal(read(`content/maps/${id}.json`).townPose, true, id);
 }
 assert.equal(read('content/maps/silent-cave-depths.json').townPose ?? false, false);
 const scene = campaign.scripts['event-5'].nodes.find(node => node.id === 'scene-2')!;
 const switches = scene.presentation.flatMap((action, i) => action.type === 'town-pose'
  ? [[action.enabled, scene.presentation[i + 1]?.type]] : []);
 assert.deepEqual(switches, [[true, 'wait'], [false, 'walk'], [true, 'wait']]);
});

test('the minotaur eats the fishcake without leaving a ground drop', () => {
 const node = campaign.scripts['event-312'].nodes.find(node => node.id === 'scene-1')!;
 assert.ok(!node.commands.some(command => command.type === 'item-drop' && command.item === 'special-fishcake'),
  '不生成可拾取的地面鲤鱼饼');
 assert.ok(node.commands.some(command => command.type === 'item-take' && command.item === 'special-fishcake' && command.quantity === 1),
  '从背包扣掉牛头怪吃掉的那一份');
});

test('dialogue portraits resolve to exported files and player identity is separate from NPC professions',()=>{
 assert.equal(world.actors.kiyan.portrait,'kiyan');assert.equal(world.actors.saint.portrait,'saint');
 assert.equal(world.actors.darius.portrait,'darius');assert.equal(world.actors['shadow-soldier'].portrait,null);
 assert.equal(Object.keys(world.portraits).length,13);
 const portraitActors:Record<string,string>={
  'story-alexander-ed2defb7':'alexander-057','story-azad-c7a37952':'azad-053',
  'story-cornette-db80543f':'cornette-199','story-veteran-eaf2cb52':'veteran-498',
  'story-eara-e221699c':'saint','story-eara-a64df27b':'saint',
  'story-eara-7c52b73b':'saint','story-eara-22d61f15':'saint',
  'story-eara-e221699c-disguise-mask':'saint',
  'story-olaf-d48a31ff':'olaf','story-olaf-d48a31ff-disguise-mask':'olaf',
  'mercenary-portia':'portia','mercenary-azad':'azad-053','mercenary-shin':'shinty',
  'mercenary-stranger-of-hwagan':'azad-053','mercenary-olaf':'olaf',
 };
 for(const [actor,portrait] of Object.entries(portraitActors))assert.equal(world.actors[actor].portrait,portrait,actor);
 for(const actor of ['story-kiyan-815ba0f7','story-eara-0079206d','story-lying-kiyan-75e14e3d','story-the-channel-df7b0415'])assert.equal(world.actors[actor].portrait,null,actor);
 assert.deepEqual(world.portraits.olaf,{file:'assets/portraits/olaf.png',width:508,height:508});
 assert.equal(storyInterface.portraits.olaf,'assets/ui/story/portrait-olaf.png');
 for(const file of [world.portraits.olaf.file])assert.ok(fs.existsSync(path.join(root,file)),file);
 assert.ok(UI_ATLAS_FRAMES[storyInterface.portraits.olaf],storyInterface.portraits.olaf);
 for(const portrait of Object.values(world.portraits)) {
  assert.ok(fs.existsSync(path.join(root,portrait.file)),portrait.file);
 }
 for(const actor of Object.values(world.actors))if(actor.portrait)assert.ok(world.portraits[actor.portrait]);
 for(const action of storyActions(campaign)) {
  const lines=[action as DialogueLine,...((action as ChoiceAction).options??[]).flatMap(option=>option.lines??[])];
  for(const line of lines)if(line.actor)assert.ok(world.actors[line.actor],line.actor);
 }
 for(const direction of ['south','west','north','east'])for(const action of ['idle','walk'])assert.ok(world.actors.kiyan.clips[`${action}-${direction}` as ClipName]!.frames>1);
 assert.equal(world.actors['ectoplasm-spirit'].clips['idle-south']?.frames,4);
});

test('every speaking actor with an original portrait identity has an exported portrait',()=>{
 // 原版 PORTRAITBASE 身份到对白立绘键的映射，对应 ../inoita/work/tools/game_content/portrait_map.py。
 // 测试自带这份表，不读取仓库外的原版工程；kind 0 是玩家、1 是怪物、2 是 NPC。
 const originalPortraitKeys:Record<string,string>={
  '0:0':'kiyan','2:40':'darius','2:53':'azad-053','2:509':'azad-053','2:510':'azad-053',
  '2:54':'portia','2:599':'portia','2:55':'janus','2:56':'shinty','2:587':'shinty',
  '2:57':'alexander-057','2:58':'saint','2:79':'saint','2:142':'saint','2:302':'saint',
  '2:492':'saint','2:199':'cornette-199','2:249':'olaf','2:498':'veteran-498',
  '1:350':'red-dragon','1:523':'red-dragon','1:356':'purple-demon','1:526':'purple-demon',
 };
 const originalIdentity=(actorId:string):string|undefined=>{
  if(actorId==='kiyan')return '0:0';
  return originalActorIdentities[actorId];
 };
 const actorsByName=new Map<string,string[]>();
 for(const [actorId,actor] of Object.entries(world.actors)) {
  const ids=actorsByName.get(actor.name)??[];
  ids.push(actorId);actorsByName.set(actor.name,ids);
 }
 const speakingActors=new Set<string>();
 for(const action of storyActions(campaign)) {
  const lines=[action as DialogueLine,...((action as ChoiceAction).options??[]).flatMap(option=>option.lines??[])];
  for(const line of lines) {
   if(line.actor){speakingActors.add(line.actor);continue;}
   // 同一句发言者对应多个人物时不猜：要靠剧情显式绑定 actor 才能带立绘。
   const matches=actorsByName.get(line.speaker)??[];
   if(matches.length===1)speakingActors.add(matches[0]!);
  }
 }
 for(const actorId of speakingActors) {
  const identity=originalIdentity(actorId);
  const portraitKey=identity===undefined?undefined:originalPortraitKeys[identity];
  if(!portraitKey)continue;
  const portrait=world.actors[actorId]?.portrait;
  assert.ok(portrait,`${actorId} 在原版有 ${portraitKey} 立绘，剧情对白里会说话，但人物没有 portrait`);
  assert.ok(world.portraits[portrait],`${actorId} 的立绘 ${portrait} 不在 world.portraits 中`);
 }
 // “巨大的黑暗力量堆”在 world 里对应两个人物；对白不显式绑定 actor 时无法唯一解析，
 // 这 7 句必须绑定到有立绘的 enemy-dark-forces-of-evil-1。
 const darkForcesLines=storyActions(campaign)
  .flatMap(action=>[action as DialogueLine,...((action as ChoiceAction).options??[]).flatMap(option=>option.lines??[])])
  .filter(line=>line.speaker==='巨大的黑暗力量堆');
 assert.ok(darkForcesLines.length>=7);
 for(const line of darkForcesLines)assert.equal(line.actor,'enemy-dark-forces-of-evil-1');
});

test('character clips resolve to valid assets inside the game project',()=>{
 for(const actor of Object.values(world.actors))for(const clip of Object.values(actor.clips)) {
  assert.ok(clip);
  assert.ok(clip.frameWidth>0&&clip.frameHeight>0&&clip.frames>0);
  for(const layer of clip.layers)assert.ok(fs.existsSync(sourceAssetPath(layer.file)),layer.file);
 }
 for(const prop of world.props){assert.ok(fs.existsSync(sourceAssetPath(prop.file)),prop.file);assert.ok(PROP_ATLAS_BY_KEY[prop.key],`prop atlas frame missing: ${prop.key}`);}
});
test('characters, chest variants and springs retain foot bounds while passage markers stay traversable',()=>{
 const expected={x:-8,y:-8,width:16,height:16};
 assert.deepEqual(world.actors.kiyan.collision,expected);
 for(const key of ['treasure-box-a0caef88','improved-treasure-box-85467c1c','box-5f6f8808','old-box-1d5f38b4','treasure-box-5ea1dd1f','treasure-box-0b584b3d','treasure-box-aa819e7d'])assert.deepEqual(world.actors[key].collision,expected,key);
 // 泉水是直接动画 366：ANIMATIONAREABASE 第 366 行四向距离 8/8/8/8，原版同样阻挡移动。
 for(const key of ['clear-springs-f6f095b4','cool-springs-5de52ba9','mystic-springs-5aa6a4bb','fountain-of-the-djinns-0a709a87','fountain-of-chaos-5e5e149c'])assert.deepEqual(world.actors[key].collision,expected,key);
 for(const key of ['darius','shadow-soldier','portia','janus','ectoplasm-spirit'])assert.deepEqual(world.actors[key].collision,expected,key);
 assert.deepEqual(world.actors['dark-sorcerer-kane-da3b1c3e'].collision,{x:-8,y:-16,width:16,height:24});
 assert.ok(world.actors['weapons-dealer-f31d78ce'].collision);
 for(const key of ['leap-gate-253891b2','map-exit-700fd234','map-exit-38b4014e','bridge-00bff61d'])assert.equal(world.actors[key].collision,undefined,key);
});
test('every map destination has terrain supporting an exit foot contact',()=>{
 for(const ref of world.maps) {
  const map=read<WorldMap>(ref.file);
  const navigation=navigationFor(map,[]);
  for(const destination of new Set(map.exits.map(e=>e.destination))) {
   assert.ok(map.exits.filter(e=>e.destination===destination).some(e=>{
    for(let y=e.y-4;y<=e.y+e.height+4;y+=4)for(let x=e.x-4;x<=e.x+e.width+4;x+=4)if(navigation.canPlace(world.actors.kiyan,{x,y})&&overlapsFootRect({x,y},e))return true;
    return false;
   }),`${map.id} -> ${destination}`);
  }
 }
});
test('all exported maps have matching dimensions, assets, actors and valid destinations',()=>{
 const ids=new Set(world.maps.map(map=>map.id));assert.equal(ids.size,416);
 for(const item of world.maps) {
  const map=read(item.file);
  assert.equal(map.blocked.length,map.columns*map.rows);assert.equal(map.width,map.columns*map.tileSize);
  if(map.water!==undefined)assert.ok(map.water.every((cell,index)=>cell>=0&&cell<map.columns*map.rows&&(index===0||cell>map.water![index-1]!)),`${map.id} water`);
  assert.ok(fs.existsSync(path.join(root,map.ground)));assert.ok(fs.existsSync(path.join(root,map.canopy)));
  for(const entity of map.entities)assert.ok(world.actors[entity.actor],entity.actor);
  for(const exit of map.exits) {
   assert.ok(ids.has(exit.destination),`${map.id} -> ${exit.destination}`);
   assert.ok(exit.x>=0&&exit.y>=0&&exit.x+exit.width<=map.width&&exit.y+exit.height<=map.height,map.id);
  }
 }
});
test('authored story characters stand on walkable cells and every quest has a real hand-in actor',()=>{
 // 站的人自己那一格可以不通行——原版把常驻 NPC 摆在柜台上是常态（鑫迪就站在利诺恩安全屋
 // (15,7) 的柜台格里），玩家从相邻格说话即可：交互距离是曼哈顿 24 px（NEAR_OBJECT_DISTANCE，
 // 对齐原版 PLAYER_DoCheckNearNPC），正相邻的 16 px 够得着、斜相邻的 32 px 够不着。
 // 所以要保证的是「够得着」：自己那格能站，或者上下左右有一格能站。
 const reachable=(map:WorldMap,point:Point)=>canStandOnTerrain(map,point.x,point.y)
  ||[[16,0],[-16,0],[0,16],[0,-16]].some(([dx,dy])=>canStandOnTerrain(map,point.x+dx,point.y+dy));
 for(const entity of campaign.placements) {
  const map=read(world.maps.find(m=>m.id===entity.map)!.file);
  assert.ok(reachable(map,entity),entity.id);
  assert.ok(world.actors[entity.actor],entity.actor);
 }
 // 任务点名的场景角色要有地方站：可以是剧情摆放点，也可以是地图自带的静态实体
 // （原版把常驻 NPC 直接摆在地图数据里，复刻照搬；例如交付对象是块巨石的那种）。
 // 三种摆放来源都算：剧情摆放点、地图自带静态实体、以及进图登记
 // （`mapEntryPlacements`，例如评论邀请的露娜按「任务可接取」在九张图上出现）。
 const placed=new Set<string>([...campaign.placements.map(p=>p.actor),
   ...(campaign.mapEntryPlacements??[]).map(p=>p.actor),
   ...world.maps.flatMap(entry=>read<WorldMap>(entry.file).entities.map(entity=>entity.actor))]);
 for(const quest of campaign.quests) {
  // 由剧情事件授予的任务没有发布者（giver 为空），这类不要求摆放点。
  for(const actor of [quest.giver,quest.delivery]) if(actor) assert.ok(placed.has(actor),`${quest.id} ${actor}`);
  for(const script of [quest.offerScript,quest.completeScript])if(script)assert.ok(campaign.scripts[script],script);
  for(const prerequisite of storyConditionReferences(quest.availableWhen).quests)assert.ok(campaign.quests.some(q=>q.id===prerequisite));
 }
});
test('quest actors have an approach through terrain independently of story gates',()=>{
 const maps=new Map<string,WorldMap>(world.maps.map(item=>[item.id,read<WorldMap>(item.file)]));
 for(const entity of campaign.placements) {
  const map=maps.get(entity.map)!,starts: Point[]=[];
  const navigation=navigationFor(map,[]);
  if(map.id===campaign.start.map)starts.push(campaign.start);
  for(const source of maps.values())for(const exit of source.exits)if(exit.destination===map.id)starts.push(exit.spawn);
  const visited=new Set<number>(),queue: number[]=[];
  for(const spawn of starts){const p=navigation.nearest(world.actors.kiyan,spawn);const index=Math.floor(p.y/16)*map.columns+Math.floor(p.x/16);if(!visited.has(index)){visited.add(index);queue.push(index);}}
  for(let i=0;i<queue.length;i++) {
   const cell=queue[i],x=cell%map.columns,y=Math.floor(cell/map.columns);
   for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const xx=x+dx,yy=y+dy,next=yy*map.columns+xx;
    if(xx<0||yy<0||xx>=map.columns||yy>=map.rows||!navigation.canPlace(world.actors.kiyan,{x:xx*16+8,y:yy*16+8})||visited.has(next))continue;
    visited.add(next);queue.push(next);
   }
  }
  assert.ok([...visited].some(i=>Math.hypot(i%map.columns*16+8-entity.x,Math.floor(i/map.columns)*16+8-entity.y)<30),entity.id);
 }
});

function gateWorld(map: WorldMap, event?: string): NavigationWorld {
 const state=new StoryWorldState();
 if(event)for(const node of campaign.scripts[event].nodes)for(const action of node.commands){
  if(action.type!=='world')continue;
  const command=action.command;
  if((command.kind==='actor-visibility'||command.kind==='remove-character')&&command.map===map.id)state.apply(command);
 }
 const authored=campaign.placements.filter(entity=>entity.map===map.id);
 const base=map.entities.filter(entity=>!authored.some(other=>other.characterId===entity.characterId));
 return navigationFor(map,state.projectEntities(map.id,[...base,...authored],campaign.placements));
}

function approachExists(map:WorldMap,navigation:NavigationWorld,start:Point,goal:(point:Point)=>boolean):boolean {
 const actor={shape:()=>world.actors.kiyan,position:()=>start,enabled:()=>true};
 for(let y=8;y<map.height;y+=8)for(let x=8;x<map.width;x+=8){
  const point={x,y};
  if(goal(point)&&navigation.path(actor,point))return true;
 }
 return false;
}

test('event 66 opens the werewolf lair exit while the original boulders block it beforehand',()=>{
 const map=read<WorldMap>('content/maps/werewolf-lair-43f5b4c5.json');
 const goal=(point:Point)=>map.exits.some(exit=>exit.destination==='mines-lowest-floor-22a46945'&&overlapsFootRect(point,exit));
 assert.equal(approachExists(map,gateWorld(map),{x:344,y:152},goal),false);
 assert.equal(approachExists(map,gateWorld(map,'event-66'),{x:344,y:152},goal),true);
});

test('event 32 opens the prison gates before Izelynn can be approached',()=>{
 const map=read<WorldMap>('content/maps/goblin-prison-1-cee53ab6.json');
 const target=campaign.placements.find(entity=>entity.id==='quest-npc-npc-175')!;
 const goal=(point:Point)=>Math.abs(point.x-target.x)+Math.abs(point.y-target.y)<=24;
 assert.equal(approachExists(map,gateWorld(map),{x:440,y:472},goal),false);
 assert.equal(approachExists(map,gateWorld(map,'event-32'),{x:440,y:472},goal),true);
});

test('event-158 no longer walks to the blocked fixed opening tile',()=>{
 const script=campaign.scripts['event-158'];
 assert.ok(script);
 const scene=script.nodes.find(node=>node.id==='scene-1');
 assert.ok(scene);
 assert.ok(!(scene.presentation??[]).some(action=>action.type==='walk'&&action.x===136&&action.y===216));
});

test('ancient swords and innkeepers carry their interaction services',()=>{
 assert.equal(world.actors['the-legendary-sword-cb440e18'].service,'legendary-sword');
 for(const id of ['innkeeper-ad05fa66','innkeeper-4c9ac51d','innkeeper-dfa04fff','innkeeper-b8f0066b'])assert.equal(world.actors[id].service,'innkeeper');
 let swords=0,innkeepers=0;
 for(const reference of world.maps){
  const map=read<WorldMap>(reference.file);
  for(const entity of map.entities){
   if(entity.characterId==='npc-39')swords+=1;
   if(['npc-5','npc-358','npc-379','npc-590'].includes(entity.characterId??''))innkeepers+=1;
  }
 }
 assert.equal(swords,23);assert.equal(innkeepers,8);
});

test('native quest state commands commit before their popup and same-state guards bypass both',()=>{
 let journaled=0,journalExternal=0;
 for(const [name,script] of Object.entries(campaign.scripts)){
  if(!/^event-\d+$/.test(name))continue;
  for(const node of script.nodes)for(const command of node.commands){
   if(command.type!=='quest'||!['accept','script-complete'].includes(command.command.type))continue;
   if(!('quest' in command.command))continue;
   const questId=command.command.quest;
   const quest=campaign.quests.find(entry=>entry.id===questId)!;
   assert.ok(quest,`${name}/${node.id}`);
   assert.ok(node.exit.type==='next');
   const next=script.nodes.find(candidate=>candidate.id===(node.exit.type==='next'?node.exit.target.node:''))!;
   const popup=next.presentation.find(action=>action.type==='quest-popup'&&action.quest===quest.id);
   if(quest.journal===false){journalExternal++;assert.equal(popup,undefined,`${name}/${quest.id}`);continue;}
   journaled++;
   assert.deepEqual(popup,{type:'quest-popup',kind:command.command.type==='accept'?'start':'complete',quest:quest.id});
   assert.deepEqual(next.commands,[],'confirming the popup cannot commit the reward again');
   assert.ok(next.exit.type==='next');
   assert.ok(script.nodes.some(guard=>guard.exit.type==='branch'&&guard.exit.otherwise.node===node.id
    &&guard.exit.then.node===(next.exit.type==='next'?next.exit.target.node:'')),`${name}/${quest.id}: missing same-state guard`);
  }
 }
 assert.ok(journaled>0);assert.ok(journalExternal>0);
});

test('content validation rejects broken story interface assets, invalid quest quantities, broken item references, and mismatched interactionEvent',()=>{
 const items=parseItemCatalog(read('content/items.json'));
 const rawInterface=parseStoryInterface(read('content/story-interface.json'));
 validateStoryItems(campaign,items);
 const missing=structuredClone(rawInterface);delete missing.assets['menu'];
 assert.throws(()=>parseStoryInterface(missing),/menu/);
 const invalid=structuredClone(rawInterface);invalid.player.health=invalid.player.maxHealth+1;
 assert.throws(()=>parseStoryInterface(invalid),/上限/);
 assert.throws(()=>validateStoryItems(campaign,{...items,items:{}}),/物品/);
 const fraction=structuredClone(campaign);fraction.quests[0]!.goals[0]!.quantity=1.5;
 assert.throws(()=>parseCampaign(fraction),/整数/);
 for(const value of ['missing-event','event-285','event-186',undefined]){
  const copy=structuredClone(campaign) as unknown as Record<string,unknown>;
  const target=(copy.quests as {id:string;interactionEvent?:string}[]).find(q=>q.id==='quest-371')!;
  target.interactionEvent=value;
  assert.throws(()=>parseCampaign(copy),/剧情交互/);
 }
});

test('battle threshold and death scenes remove their triggering boss, start on the battle map, and retain live player positions when unplaced',()=>{
 for(const event of campaign.events.filter(candidate=>candidate.source==='battle'&&candidate.key?.startsWith('health-below-30:'))){
  const key=event.key;if(!key||!key.startsWith('health-below-30:'))continue;
  const enemyId=key.slice('health-below-30:'.length);
  const commands=campaign.scripts[event.script].nodes.flatMap(node=>node.commands);
  assert.ok(commands.some(command=>command.type==='world'&&command.command.kind==='remove-enemy'
   &&command.command.enemyId===enemyId),`${event.id} 必须移除 ${enemyId}`);
 }
 const firstMap=(id:string)=>campaign.scripts[id].nodes.flatMap(node=>node.presentation).find(action=>action.type==='stage')!.map;
 assert.equal(firstMap('event-61'),'werewolf-lair-43f5b4c5');
 assert.equal(firstMap('event-112'),'steel-altar-a048555a');
 assert.equal(firstMap('event-135'),'redhoods-boss-room-c9f73fd1');
 assert.equal(firstMap('event-55'),'old-sanctuary-54cffd62');
 const stageOf=(name:string)=>campaign.scripts[name].nodes.map(node=>node.presentation[0]).find(action=>action?.type==='stage') as StoryStage;
 assert.equal(stageOf('event-28').retainPlayerPosition,true);
 assert.equal(stageOf('event-27').retainPlayerPosition,true);
 assert.equal(stageOf('event-3').retainPlayerPosition,undefined);
});
