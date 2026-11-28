import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type {ActorDefinition, AnimationClip, WorldMap} from '../src/domain/content.ts';
import {validateSceneSnapshot, type SceneSnapshot} from '../src/domain/scene-snapshot.ts';
import type {StoryStageSnapshot} from '../src/domain/story-performance.ts';
import {prepareSceneVisit,generateMapEntities} from '../src/domain/scene-visit.ts';
import {placementMayBeInactive} from '../src/domain/map-placement.ts';
import {Session} from '../src/domain/session.ts';
import {BattleCharacter, type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import type {CompanionCatalog} from '../src/domain/party.ts';
import {parseDrops} from '../src/domain/drops.ts';
import {parseSprings} from '../src/domain/springs.ts';
import {WorldEnemyRoster} from '../src/domain/world-enemies.ts';
import {claimStoryTrigger} from '../src/domain/story-trigger-occupancy.ts';
import {
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import {createFakePhaserScene, createTestWorldCombat, installPhaserStubHooks} from './support/world-combat-fixture.ts';
import {buildTestWorldScene, loadWorldSceneClass} from './support/world-scene-fixture.ts';

const hook=installPhaserStubHooks();
const {StoryPresenter}=await import('../src/rendering/story-presenter.ts');
hook.deregister();
const WorldScene=await loadWorldSceneClass();

function stripActorFiles(actor:ActorDefinition):ActorDefinition {
  const clips:ActorDefinition['clips']={};
  for(const [name,clip] of Object.entries(actor.clips) as [keyof ActorDefinition['clips'], AnimationClip|undefined][]){
    if(!clip)continue;
    clips[name]={...clip,layers:clip.layers.map(layer=>({...layer,file:''}))};
  }
  return {...actor,clips};
}
function completePhaserScene(extraSprite?:(sprite:Record<string,unknown>)=>void){
  const base=createFakePhaserScene();
  const baseAdd=base.add as unknown as {sprite:(...args:unknown[])=>Record<string,unknown>};
  const baseTweens=base.tweens as unknown as Record<string,unknown>;
  const scene=createFakePhaserScene({
    tweens:{...baseTweens,killTweensOf:()=>{},getTweensOf:()=>[]},
    add:{
      ...baseAdd,
      sprite:(...args:unknown[])=>{
        const sprite=baseAdd.sprite(...args);
        const anims=sprite.anims as Record<string,unknown>;
        Object.assign(anims,{isPlaying:false,getProgress:()=>0,create:(config:unknown)=>{const anim={...(config as object),destroy:()=>{}};anims.currentAnim=anim;return anim;}});
        Object.assign(sprite,{scene,texture:sprite.texture??{key:''},setTexture(){return sprite;},play(){anims.isPlaying=true;return sprite;}});
        extraSprite?.(sprite);
        return sprite;
      },
    },
  });
  return scene;
}
function localBattleCatalog(base=loadBattleCatalog()):BattleCatalog {
  return {
    ...base,
    classes:base.classes.map(entry=>({...entry,actor:stripActorFiles(entry.actor)})),
    enemies:base.enemies.map(entry=>({...entry,actor:stripActorFiles(entry.actor)})),
  };
}
function appearance(id:string,texture=id):ActorDefinition {
  return {id,name:id,description:'',portrait:null,clips:{'idle-south':{
    frameWidth:16,frameHeight:16,frames:1,originX:.5,originY:1,frameRate:1,mirrorX:false,
    layers:[{key:texture,file:`${texture}.png`,blend:'normal'}]
  }}};
}
function visual(id:string,actor:ActorDefinition,x:number,y:number){
  return {entity:{id,actor:actor.id,x:-100,y:-100},actor,
    container:{x:x+1000,y:y+1000,visible:false,alpha:1},
    physics:{x,y},clipName:'idle-south',layers:[] as {anims:{currentAnim:object|null;getProgress():number;isPlaying:boolean}}[]};
}

test('在拉宾斯身边读档保留已触发的邀请，走开后才可再触发', async () => {
  const host=buildTestWorldScene(WorldScene,{
    map:{id:'berkel-capital'},player:{container:{}},movement:{position:()=>({x:424,y:216})},facing:'south',
    app:{ui:{},session:{hasLivingMember:true}},
    sceneOverrides:{captureStoryScene:()=>undefined,projectStoryWorld:async()=>{},syncControlledCharacter(){}},
  });
  const robbins={id:'quest-npc-npc-362'};
  const contacts={regions:['square'],characters:[robbins.id],nearEvents:['event-595']};
  host.restoreTriggerContacts(contacts);
  const capture=host.captureSaveWorld();
  assert.equal(capture.ok,true);
  if(!capture.ok)throw new Error('捕获失败');
  const saved=JSON.parse(JSON.stringify(capture.world));
  host.restoreTriggerContacts(undefined);
  await host.restoreStoryWorld(saved,new AbortController().signal);
  assert.deepEqual([...host.triggers.occupiedTriggers],contacts.regions);
  assert.deepEqual([...host.triggers.occupiedNearEvents],contacts.nearEvents);
  const approach=(touching:boolean)=>claimStoryTrigger([robbins],host.triggers.occupiedCharacters,()=>touching,()=>true);
  assert.equal(approach(true),null);
  assert.equal(approach(false),null);
  assert.equal(approach(true)?.event,robbins);
});

test('live capture includes the physical scene with equipped party, props, enemy instances and summons while world is covered',async t=>{
  t.mock.method(Math,'random',()=>0.99);
  const battleCatalog=localBattleCatalog();
  const items=loadItemCatalog();
  const statsCatalog=loadCharacterStatsCatalog();
  const campaign=loadCampaignCatalog();
  const companions=loadCompanionCatalog();
  const hero=new BattleCharacter('warlock',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog,statsCatalog,companions);
  session.skills.maxAll();
  session.skills.bar().assign(0,1,{kind:'skill',id:'hell-s-pawn'});
  session.bag.add('mercenary-emblem-black-knight',2);
  const recruit=()=>session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  const first=recruit();
  const second=recruit();
  session.party!.deployFirstAvailable(first.id);
  session.party!.deployFirstAvailable(second.id);
  second.setHealth(0);

  const dkActor=battleCatalog.classes.find(entry=>entry.id==='dark-knight')!.actor;
  const shieldClip={
    ...appearance('companion','equipped-shield').clips['idle-south']!,
    layers:[{key:'equipped-shield',file:'',blend:'normal' as const}],
  };
  const companionActor:ActorDefinition={
    id:'companion',
    name:'companion',
    description:'',
    portrait:null,
    collision:{x:-8,y:-8,width:16,height:16},
    clips:{
      ...dkActor.clips,
      'idle-south':shieldClip,
      'idle-east':structuredClone(shieldClip),
      'idle-north':structuredClone(shieldClip),
      'idle-west':structuredClone(shieldClip),
    },
  };
  const map:WorldMap={
    id:'camp',
    name:'camp',
    width:320,
    height:320,
    tileSize:16,
    columns:20,
    rows:20,
    blocked:Array<boolean>(400).fill(false),
    ground:'',
    canopy:'',
    features:[],
    entities:[],
    exits:[],
    breakableSpawn:'jar',
    enemySpawns:[
      {id:'wolf-1',enemyId:'enemy-snake-1',x:208,y:208,breakableEligible:true},
      {id:'wolf-2',enemyId:'enemy-snake-1',x:256,y:208},
    ],
  };
  const roster=new WorldEnemyRoster(session,map,[],undefined,()=>0.99);
  const phaserScene=completePhaserScene(sprite=>{
    Object.assign(sprite.anims as object,{currentAnim:{},getProgress:()=>1,isPlaying:false});
    Object.assign(sprite,{play(){return sprite;}});
  });
  const world=await createTestWorldCombat({
    phaserScene,
    map,
    hero,
    session,
    roster,
    battleCatalog,
    items,
    characterStats:statsCatalog,
    sceneOverrides:{
      equipmentAppearance:id=>id===first.id?companionActor:undefined,
    },
    appOverrides:{
      world:{actors:{[first.definition.actor]:dkActor,[second.definition.actor]:dkActor}} as never,
    },
  });
  await world.combat.start();
  world.combat.attack('hell-s-pawn');
  for(let i=0;i<30;i++){
    world.combat.update(60,true);
    if(world.combat.captureState().roster.enemies.some(entry=>entry.summonedBy==='player'))break;
  }
  const summonKey=world.combat.captureState().roster.enemies.find(entry=>entry.summonedBy==='player')!.key;
  session.storyWorld.apply({kind:'encounter',encounter:{id:'dead',map:'camp',status:'active',spawns:[{id:'1',enemyId:'enemy-snake-1',x:80,y:64}]}});
  world.combat.syncChestEnemies();
  session.setOneHitKill('player',true);
  world.combat.selectEnemy('dead:1');
  world.combat.attack();
  for(let i=0;i<20;i++){
    world.combat.update(60,true);
    if(world.combat.diagnostics().enemies?.some(entry=>entry.id==='dead:1'&&entry.pendingDefeat))break;
  }
  world.combat.adoptStoryPositions([
    {id:`member:${first.id}`,actor:companionActor.id,memberId:first.id,x:60,y:70,facing:'east',visible:true},
    {id:'enemy:wolf-1',actor:'enemy-snake-1',enemyKey:'wolf-1',x:160,y:80,facing:'west',visible:true},
    {id:'enemy:wolf-2',actor:'enemy-snake-1',enemyKey:'wolf-2',x:208,y:80,facing:'west',visible:true},
    {id:`enemy:${summonKey}`,actor:'enemy-hell-s-pawn-1',enemyKey:summonKey,x:240,y:80,facing:'west',visible:true},
  ]);

  const player=visual('player',appearance('hero','equipped-sword'),12,18);
  const gate=visual('gate-1',appearance('gate'),20,30);
  const chest=visual('chest-1',{...appearance('chest'),chest:'wooden' as ActorDefinition['chest']},30,40);
  const spring=visual('spring-1',appearance('spring-empty'),40,50);spring.entity.actor='spring-high';
  const hidden=visual('hidden-1',appearance('npc'),50,60);
  player.layers.push({anims:{currentAnim:{},getProgress:()=>.25,isPlaying:true}});
  // 单帧动画在 Phaser 里的进度是 NaN（1/(帧数-1)），快照必须收敛成 undefined 才能通过校验。
  gate.layers.push({anims:{currentAnim:{},getProgress:()=>NaN,isPlaying:true}});
  const movement={position:(value:{physics:{x:number;y:number}})=>({...value.physics})};
  const host=buildTestWorldScene(WorldScene,{
    map:{id:'camp'},player,movement,combat:world.combat,facing:'north',
    characters:[gate,chest,spring,hidden],
    app:{ui:{},session:{hasLivingMember:true,
      storyWorld:{actorVisible:(_map:string,actor:string)=>actor!=='npc',isPlaced:()=>false},
      chests:{isOpened:(_map:string,id:string)=>id==='chest-1'},
      legendaryWeapons:{isPulled:()=>false},
      visible:()=>true}},
  });
  host.restoreTriggerContacts(undefined);
  const snapshot:SceneSnapshot=host.captureStoryScene();
  assert.deepEqual(host.captureStoryWorld().scene,snapshot,'rollback captures the same complete physical scene');
  host.app.ui.loadingState={label:'正在准备进图剧情',progress:0};
  assert.deepEqual(host.captureSaveWorld(),{ok:false,reason:'loading'},'进图事件登记前不能写进普通或后台自动存档');
  delete (host.app.ui as {loadingState?:unknown}).loadingState;
  const saved=host.captureSaveWorld();assert.equal(saved.ok,true);
  if(!saved.ok)throw new Error('无法捕获存档');
  const savedScene:SceneSnapshot=saved.world.scene!;
  assert.equal(savedScene.actors.find(actor=>actor.id==='enemy:wolf-1')!.appearance,undefined);
  assert.equal(savedScene.actors.find(actor=>actor.id===`enemy:${summonKey}`)!.appearance,undefined);
  assert.equal(savedScene.actors.find(actor=>actor.id===`member:${first.id}`)!.appearance,undefined);
  assert.equal(savedScene.actors.find(actor=>actor.id==='player')!.appearance,undefined);
  assert.ok(snapshot.actors.find(actor=>actor.id==='enemy:wolf-1')!.appearance);
  validateSceneSnapshot(savedScene);
  assert.deepEqual(snapshot.visit?.breakableRolls,[['wolf-1','enemy-snake-1']]);
  validateSceneSnapshot(snapshot);
  assert.deepEqual(snapshot.actors.map(actor=>actor.id),[
    'player','entity:gate-1','entity:chest-1','entity:spring-1','entity:hidden-1',
    `member:${first.id}`,`member:${second.id}`,'enemy:wolf-1','enemy:wolf-2',`enemy:${summonKey}`,'enemy:dead:1'
  ]);
  assert.deepEqual(snapshot.actors.filter(actor=>actor.visible).map(actor=>actor.id),[
    'player','entity:gate-1','entity:spring-1',`member:${first.id}`,'enemy:wolf-1','enemy:wolf-2',`enemy:${summonKey}`
  ]);
  const captured=(id:string)=>snapshot.actors.find(actor=>actor.id===id)!;
  assert.deepEqual([captured('player').x,captured('player').y,captured('player').facing],[12,18,'north']);
  assert.equal(captured('player').appearance?.clips['idle-south']?.layers[0]?.key,'equipped-sword');
  assert.equal(captured(`member:${first.id}`).appearance?.clips['idle-south']?.layers[0]?.key,'equipped-shield');
  assert.equal(captured(`member:${first.id}`).followsPlayer,true);
  assert.equal(captured(`member:${second.id}`).followsPlayer,true,'阵亡队员也登记为跟随者，显隐仍按自己的存活状态');
  assert.deepEqual([captured('player').animationProgress,captured('player').animationPlaying],[.25,true]);
  assert.deepEqual([captured(`member:${first.id}`).animationProgress,captured(`member:${first.id}`).animationPlaying],[1,false]);
  assert.equal(captured('entity:gate-1').animationProgress,undefined,'单帧动画的 NaN 进度不能写进快照');
  assert.equal(captured('entity:gate-1').animationPlaying,true);
  assert.equal(captured('entity:spring-1').actor,'spring-high');
  assert.equal(captured('entity:spring-1').appearance?.id,'spring-empty');
  assert.equal(captured('enemy:wolf-1').enemyId,captured('enemy:wolf-2').enemyId);
  assert.equal(captured(`enemy:${summonKey}`).summonedBy,'player');
  companionActor.clips['idle-south']!.layers[0]!.key='changed-later';
  assert.equal(captured(`member:${first.id}`).appearance?.clips['idle-south']?.layers[0]?.key,'equipped-shield');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).actors.length,snapshot.actors.length);
  world.combat.destroy();
});

test('a pulled legendary sword is hidden from the live story scene snapshot',()=>{
  const player=visual('player',appearance('hero'),12,18);
  const sword=visual('sword-1',{...appearance('legendary-sword'),service:'legendary-sword' as const},30,40);
  const movement={position:(value:{physics:{x:number;y:number}})=>({...value.physics})};
  const host=buildTestWorldScene(WorldScene,{
    map:{id:'camp'},player,movement,characters:[sword],
    app:{session:{storyWorld:{actorVisible:()=>true,isPlaced:()=>false},visible:()=>true,
      chests:{isOpened:()=>false},
      legendaryWeapons:{isPulled:(mapId:string,entityId:string)=>mapId==='camp'&&entityId==='sword-1'}}},
  });
  const snapshot:SceneSnapshot=host.captureStoryScene();
  const captured=snapshot.actors.find(actor=>actor.id==='entity:sword-1');
  assert.ok(captured,'古剑仍在快照里，只是不可见');
  assert.equal(captured.visible,false,'已拔出的古剑不再出现在剧情舞台');
  validateSceneSnapshot(snapshot);
});

test('scene snapshot rejects ambiguous identities and invalid reconstruction data',()=>{
  const valid:SceneSnapshot={map:'camp',actors:[{id:'player',actor:'hero',x:1,y:2,facing:'south',visible:true,appearance:appearance('hero')}]};
  validateSceneSnapshot(valid);
  for(const change of [
    (snapshot:SceneSnapshot)=>snapshot.actors.push({...snapshot.actors[0]!}),
    (snapshot:SceneSnapshot)=>{snapshot.actors[0]!.x=NaN;},
    (snapshot:SceneSnapshot)=>{snapshot.actors[0]!.alpha=2;},
    (snapshot:SceneSnapshot)=>{snapshot.actors[0]!.animationProgress=2;},
    (snapshot:SceneSnapshot)=>{snapshot.actors[0]!.worldEntityId='';},
    (snapshot:SceneSnapshot)=>{snapshot.actors[0]!.followsPlayer='yes' as unknown as boolean;},
    (snapshot:SceneSnapshot)=>{snapshot.actors[0]!.followVisibility=1 as unknown as boolean;},
    (snapshot:SceneSnapshot)=>{snapshot.actors[0]!.appearance!.clips['idle-south']!.layers[0]!.key='';},
  ]){
    const invalid=structuredClone(valid);change(invalid);assert.throws(()=>validateSceneSnapshot(invalid),/快照/);
  }
});

test('scene snapshot rejects two visible actors for one world instance',()=>{
  const duplicate:SceneSnapshot={map:'camp',actors:[
    {id:'first',actor:'guard',worldEntityId:'gate',x:1,y:2,facing:'south',visible:true},
    {id:'second',actor:'guard',worldEntityId:'gate',x:3,y:4,facing:'south',visible:true},
  ]};
  assert.throws(()=>validateSceneSnapshot(duplicate),/演员实例重复.*world:gate/);
});

test('snapshot appearance validation accepts every published actor definition',()=>{
  const world=JSON.parse(readFileSync(new URL('../public/content/world.json',import.meta.url),'utf8'));
  const actors=Object.values(world.actors) as ActorDefinition[];
  validateSceneSnapshot({map:'catalog',actors:actors.map(actor=>({id:actor.id,actor:actor.id,x:0,y:0,
    facing:'south',visible:true,appearance:actor}))});
});

test('foreign map preparation isolates session state and formal adoption preserves random map contents',()=>{
  const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
  const campaign=read('campaign'),world=read('world'),battleCatalog=read('battle');
  const session=new Session(campaign),map=read('maps/shadow-training-dungeon1-5e8c19b4');
  const springs=parseSprings(read('springs'));
  const drops=parseDrops(read('drops'),read('items'),battleCatalog.enemies.map((enemy:{id:string})=>enemy.id));
  session.storyWorld.apply({kind:'place',scope:'visit',entity:{...map.entities[0],id:'future-visit-npc',map:map.id}});
  const before=session.captureState();
  const player={id:'player',actor:campaign.start.actor,x:map.width/2,y:map.height/2,facing:'east' as const,visible:true,
    appearance:world.actors[campaign.start.actor]};
  const snapshot=prepareSceneVisit({session,campaign,world,battleCatalog,drops,springs},map,player,()=>0);
  validateSceneSnapshot(snapshot);
  assert.deepEqual(session.captureState(),before,'rendering a foreign stage must leave formal session untouched');
  assert.deepEqual(snapshot.visit!.generatedEntities,generateMapEntities(map,campaign,springs,1,()=>0,
    entity=>!placementMayBeInactive(entity)));
  assert(snapshot.actors.some(actor=>actor.enemyKey),'prepared scene materializes enemy instances');
  assert(snapshot.actors.some(actor=>actor.worldEntityId==='future-visit-npc'),'next-visit registrations appear in the prepared destination');
  assert(snapshot.actors.some(actor=>actor.worldEntityId&&snapshot.visit!.generatedEntities.some(entity=>entity.id===actor.worldEntityId&&entity.spring)),
    'prepared scene materializes the actual rolled spring');
  const formal=new WorldEnemyRoster(session,map,[],undefined,()=>.99);
  formal.adoptPreparedState(snapshot.visit!);
  assert.deepEqual(formal.captureState(),snapshot.visit!.roster);
  assert.deepEqual(formal.refresh(),{added:[],removed:[]},'normal refresh must preserve the adopted breakable rolls');
  assert.deepEqual(formal.capturePreparedState().breakableRolls,snapshot.visit!.breakableRolls);
});

test('a flipped directional placement starts facing east in a prepared scene',()=>{
  const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
  const campaign=read('campaign'),world=read('world'),battleCatalog=read('battle');
  const session=new Session(campaign),map=read('maps/silent-cave-depths');
  const springs=parseSprings(read('springs'));
  const drops=parseDrops(read('drops'),read('items'),battleCatalog.enemies.map((enemy:{id:string})=>enemy.id));
  const player={id:'player',actor:campaign.start.actor,x:map.width/2,y:map.height/2,facing:'south' as const,visible:true,
    appearance:world.actors[campaign.start.actor]};
  const snapshot=prepareSceneVisit({session,campaign,world,battleCatalog,drops,springs},map,player,()=>0);
  const earl=snapshot.actors.find(actor=>actor.actor==='earl-grafton');
  assert.ok(earl,'预备场景里应有伯爵');
  assert.equal(earl!.flip,true,'伯爵摆放点带 flip');
  assert.equal(earl!.facing,'east','flip 是摆放朝向，四向素材应初始朝东而不是朝南');
});

test('prepared party members are marked as followers of the player',()=>{
  const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
  const campaign=read('campaign'),world=read('world'),battleCatalog=read('battle'),items=read('items');
  const stats=read('character-stats') as CharacterStatsCatalog,companionCatalog=read('companions') as CompanionCatalog;
  const session=new Session(campaign,undefined,undefined,items,new BattleCharacter('assassin',stats,items),undefined,stats,companionCatalog);
  session.party!.joinStory('mercenary-azad');
  const map=read('maps/shadow-training-dungeon1-5e8c19b4');
  const springs=parseSprings(read('springs'));
  const drops=parseDrops(read('drops'),items,battleCatalog.enemies.map((enemy:{id:string})=>enemy.id));
  const player={id:'player',actor:campaign.start.actor,x:map.width/2,y:map.height/2,facing:'east' as const,visible:true,
    appearance:world.actors[campaign.start.actor]};
  const snapshot=prepareSceneVisit({session,campaign,world,battleCatalog,drops,springs},map,player,()=>0);
  const member=snapshot.actors.find(actor=>actor.memberId&&actor.memberId!=='player');
  assert.ok(member,'队伍成员进入预备场景');
  assert.equal(member!.followsPlayer,true,'预备场景里的队员同样跟随主角');
});

test('formal cross-map handoff adopts the matching prepared visit only',async()=>{
  const scene:SceneSnapshot={map:'destination',actors:[],visit:{generatedEntities:[],roster:{enemies:[],sequence:0,partySize:1},breakableRolls:[]}};
  let received:unknown;
  const host=buildTestWorldScene(WorldScene,{
    map:{id:'origin'},
    app:{session:{storyWorld:{currentLocation:{map:'destination',x:1,y:2,facing:'south'}}},ui:{setWorldRebuildCover(){}}},
    sceneOverrides:{
      scene:{isActive:()=>true},
      prefetchStoryEntry:async()=>{},
      restartStoryWorld:async(_location:unknown,_signal:AbortSignal,options:{preparedScene?:SceneSnapshot})=>{received=options.preparedScene;},
    },
  });
  await host.projectStoryWorld({scene} as never,new AbortController().signal);
  assert.equal(received,scene);
  await host.projectStoryWorld({scene:{...scene,map:'unrelated'}} as never,new AbortController().signal);
  assert.equal(received,undefined);
});

test('rollback restores physical prop positions and drained appearance while retaining rebuilt equipped textures',async()=>{
  const player=visual('player',appearance('hero','current-outfit'),10,20);
  const spring=visual('spring',appearance('spring-full'),0,0);
  Object.assign(spring.container,{setAlpha(this:typeof spring.container,value:number){this.alpha=value;return this;},setVisible(this:typeof spring.container,value:boolean){this.visible=value;return this;}});
  let restoredCombat=false;
  const host=buildTestWorldScene(WorldScene,{
    map:{id:'camp'},player,characters:[spring],loadingWorld:false,
    movement:{refreshShape(){},placeAll:(placements:{visual:typeof spring;position:{x:number;y:number}}[])=>{
      for(const placement of placements)Object.assign(placement.visual.physics,placement.position);
    }},
    combat:{discardPendingDefeats(){},async restoreState(){restoredCombat=true;}},
    app:{},
    sceneOverrides:{async projectStoryWorld(){},setClip(){},syncControlledCharacter(){}},
  });
  await host.restoreStoryWorld({location:{map:'camp',x:10,y:20,facing:'south'},world:{},generatedEntities:[],scene:{map:'camp',actors:[
    {id:'player',actor:'hero',memberId:'player',x:10,y:20,facing:'south',visible:true,appearance:appearance('hero','expired-outfit')},
    {id:'entity:spring',actor:'spring-full',worldEntityId:'spring',x:42,y:56,facing:'west',visible:true,appearance:appearance('spring-empty')}
  ]}},new AbortController().signal);
  assert.equal(restoredCombat,true);
  assert.deepEqual(spring.physics,{x:42,y:56});
  assert.equal(spring.actor.id,'spring-empty');
  assert.equal(player.actor.clips['idle-south']!.layers[0]!.key,'current-outfit');
});

test('combat position handoff only updates living instances still present in the formal world',async t=>{
  const battleCatalog=localBattleCatalog();
  const items=loadItemCatalog();
  const statsCatalog=loadCharacterStatsCatalog();
  const campaign=loadCampaignCatalog();
  const companions=loadCompanionCatalog();
  const hero=new BattleCharacter('dark-knight',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog,statsCatalog,companions);
  session.bag.add('mercenary-emblem-black-knight',2);
  const recruit=()=>session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  const ally=recruit(),dead=recruit();
  session.party!.deployFirstAvailable(ally.id);
  session.party!.deployFirstAvailable(dead.id);
  dead.setHealth(0);
  const dkActor=battleCatalog.classes.find(entry=>entry.id==='dark-knight')!.actor;
  const map:WorldMap={
    id:'adopt-map',name:'adopt-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'monster',enemyId:'enemy-snake-1',x:160,y:160}],
  };
  const world=await createTestWorldCombat({
    phaserScene:completePhaserScene(),
    map,hero,session,battleCatalog,items,characterStats:statsCatalog,
    appOverrides:{world:{actors:{[ally.definition.actor]:dkActor,[dead.definition.actor]:dkActor}} as never},
  });
  await world.combat.start();
  const placements:unknown[]=[];
  const origPlaceAll=world.scene.movement!.placeAll.bind(world.scene.movement!);
  t.mock.method(world.scene.movement!,'placeAll',(values:unknown[],...rest:unknown[])=>{
    placements.push(...values);
    return origPlaceAll(values as never,...(rest as []));
  });
  world.combat.adoptStoryPositions([
    {id:`member:${ally.id}`,actor:dkActor.id,memberId:ally.id,x:20,y:30,facing:'east',visible:true},
    {id:`member:${dead.id}`,actor:dkActor.id,memberId:dead.id,x:40,y:50,facing:'east',visible:true},
    {id:'enemy:monster',actor:'enemy-snake-1',enemyKey:'monster',x:60,y:70,facing:'west',visible:false,removed:true},
    {id:'enemy:missing',actor:'enemy-snake-1',enemyKey:'missing',x:80,y:90,facing:'west',visible:true}
  ]);
  assert.equal(placements.length,1);
  assert.deepEqual((placements[0] as {position:unknown;enabled:boolean}).position,{x:20,y:30});
  assert.equal((placements[0] as {enabled:boolean}).enabled,true);
  assert.equal(world.combat.captureStoryActors().find(actor=>actor.memberId===ally.id)?.facing,'east');
  assert.equal(world.combat.captureStoryActors().find(actor=>actor.memberId===dead.id)?.facing,'south');
  world.combat.destroy();
});

test('a live visit snapshot keeps the actual enemy foot position alongside its original random replacement',async()=>{
  const battleCatalog=localBattleCatalog();
  const items=loadItemCatalog();
  const statsCatalog=loadCharacterStatsCatalog();
  const campaign=loadCampaignCatalog();
  const hero=new BattleCharacter('dark-knight',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog,statsCatalog);
  const map:WorldMap={
    id:'visit-map',name:'visit-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    breakableSpawn:'jar',
    enemySpawns:[{id:'wolf-1',enemyId:'enemy-snake-1',x:32,y:32,breakableEligible:true}],
  };
  const roster=new WorldEnemyRoster(session,map,[],undefined,()=>0);
  const world=await createTestWorldCombat({phaserScene:completePhaserScene(),map,hero,session,roster,battleCatalog,items,characterStats:statsCatalog});
  await world.combat.start();
  world.combat.adoptStoryPositions([{id:'enemy:wolf-1',actor:'enemy-jar-1',enemyKey:'wolf-1',x:96,y:112,facing:'south',visible:true}]);
  const generated=world.roster.capturePreparedState();
  const captured=world.combat.captureStoryVisit();
  const capturedEnemy=captured.roster.enemies[0]!;
  const generatedEnemy=generated.roster.enemies[0]!;
  assert.deepEqual({key:capturedEnemy.key,enemyId:capturedEnemy.enemyId,x:capturedEnemy.x,y:capturedEnemy.y},{key:'wolf-1',enemyId:'enemy-jar-1',x:96,y:112});
  assert.deepEqual(captured.breakableRolls,[['wolf-1','enemy-jar-1']]);
  assert.deepEqual({key:generatedEnemy.key,enemyId:generatedEnemy.enemyId,x:generatedEnemy.x,y:generatedEnemy.y},{key:'wolf-1',enemyId:'enemy-jar-1',x:32,y:32});
  world.combat.destroy();
});

test('story presenter prepares a foreign map through the real visit builder', async () => {
  const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
  const campaign=read('campaign'),worldIndex=read('world'),battleCatalog=read('battle'),items=read('items');
  const session=new Session(campaign);
  const destination='shadow-training-dungeon1-5e8c19b4',startMap=campaign.start.map;
  const player={actor:worldIndex.actors[campaign.start.actor],
    entity:{id:'player',actor:campaign.start.actor,x:10,y:20},container:{x:10,y:20,visible:true},layers:[],clipName:null};
  const formal={map:{id:startMap},player,facing:'south',characters:[],cameras:{main:{scrollX:5,scrollY:6}},worldReady:()=>true,
    captureStoryScene(){return {map:startMap,actors:[{id:'player',actor:campaign.start.actor,x:10,y:20,facing:'south',visible:true}]};},
    prefetchMap(){}};
  const characters=new Map<string,unknown>();
  let shown:StoryStageSnapshot|undefined;
  const makeVisual=(actor:{id:string;actor:string;x:number;y:number;visible:boolean})=>({
    actor:{id:actor.actor,clips:{}},entity:{id:actor.id,actor:actor.actor,x:actor.x,y:actor.y},
    container:{x:actor.x,y:actor.y,visible:actor.visible},layers:[],clipName:null});
  const stageEvents=new EventEmitter();
  const stageScene={
    characters,map:undefined as {id:string}|undefined,player:undefined as unknown,facing:'south',events:stageEvents,
    scene:{stop(){stageEvents.emit('shutdown');}},
    movement:{position:(value:{container:{x:number;y:number}})=>({x:value.container.x,y:value.container.y}),
      place:(value:{container:{x:number;y:number}},position:{x:number;y:number})=>{value.container.x=position.x;value.container.y=position.y;},
      placeAll:(values:{visual:{container:{x:number;y:number}};position:{x:number;y:number}}[])=>{
        for(const value of values){value.visual.container.x=value.position.x;value.visual.container.y=value.position.y;}},
      register(){},setEnabled(){},setGhost(){},remove(){},stop(){}},
    cameras:{main:{scrollX:0,scrollY:0,width:960,height:640,zoom:1,stopFollow(){},centerOn(){},setScroll(){}}},
    sys:{isActive:()=>true},scale:{width:960,height:640},
    add:{container:(x:number,y:number)=>({x,y,setDepth(){return this;},setVisible(){return this;},setAlpha(){return this;},destroy(){}}),
      rectangle:()=>({setOrigin(){return this;},setScrollFactor(){return this;},setDepth(){return this;},setAlpha(){return this;},
        setPosition(){return this;},setSize(){return this;},setFillStyle(){return this;},setVisible(){return this;},destroy(){}})},
    async showStage(value:StoryStageSnapshot){shown=value;this.map={id:value.map};characters.clear();
      for(const actor of value.scene.actors)characters.set(actor.id,makeVisual(actor));this.player=characters.get('player');},
    ensureActors(value:StoryStageSnapshot){for(const actor of value.scene.actors)
      if(!characters.has(actor.id))characters.set(actor.id,makeVisual(actor));},
    async prepareActorAssets(){},releaseStage(){},clearEarlyCurtain(){}
  };
  const app={world:worldIndex,session,campaign,battleCatalog,items,
    content:{map:async(file:string)=>JSON.parse(readFileSync(new URL('../public/'+file,import.meta.url),'utf8')),
      drops:async()=>read('drops'),springs:async()=>read('springs')},
    wardrobe:{textures:[]},audio:{enterMap(){},captureStoryAudio:()=>undefined,restoreStoryAudio(){}},ui:{mode:'game'}};
  const presenter=new StoryPresenter(app as never,()=>formal as never,()=>stageScene as never);
  const signal=new AbortController().signal;
  await presenter.begin(signal);
  await presenter.execute({type:'stage',map:destination,resetActors:true,x:120,y:160,facing:'south',playerVisible:true,cast:[]},
    {signal,skipSignal:signal});
  assert.equal(shown?.map,destination);
  assert.ok(shown!.scene.actors.some(actor=>actor.id==='player'));
  assert.ok(shown!.scene.actors.some(actor=>actor.id.startsWith('entity:')),'目标地图的实体由真实 prepareSceneVisit 生成');
  await presenter.release();
});
