import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {ActorDefinition, Facing} from '../src/domain/content.ts';
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

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}},Scenes:{Events:{SHUTDOWN:\'shutdown\'}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldScene}=await import('../src/scenes/world-scene.ts');
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {StoryPresenter}=await import('../src/rendering/story-presenter.ts');
hook.deregister();

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

test('live capture includes the physical scene with equipped party, props, enemy instances and summons while world is covered',()=>{
  const player=visual('player',appearance('hero','equipped-sword'),12,18);
  const gate=visual('gate-1',appearance('gate'),20,30);
  const chest=visual('chest-1',{...appearance('chest'),chest:'wooden' as ActorDefinition['chest']},30,40);
  const spring=visual('spring-1',appearance('spring-empty'),40,50);spring.entity.actor='spring-high';
  const hidden=visual('hidden-1',appearance('npc'),50,60);
  const companion=visual('companion-1',appearance('companion','equipped-shield'),60,70);
  player.layers.push({anims:{currentAnim:{},getProgress:()=>.25,isPlaying:true}});
  companion.layers.push({anims:{currentAnim:{},getProgress:()=>1,isPlaying:false}});
  // 单帧动画在 Phaser 里的进度是 NaN（1/(帧数-1)），快照必须收敛成 undefined 才能通过校验。
  gate.layers.push({anims:{currentAnim:{},getProgress:()=>NaN,isPlaying:true}});
  const fallen=visual('companion-2',appearance('companion'),61,71);
  const enemy=(key:string,x:number,summonedBy?:string)=>({key,definition:{id:'wolf',actor:appearance('wolf')},
    visual:visual(key,appearance('wolf'),x,80),facing:'west' as Facing,summonedBy});
  const movement={position:(value:{physics:{x:number;y:number}})=>({...value.physics})};
  const combat=Object.assign(Object.create(WorldCombat.prototype),{scene:{movement},
    allies:[{id:'companion-1',member:{definition:{actor:'companion'},alive:true},visual:companion,facing:'east'},
      {id:'companion-2',member:{definition:{actor:'companion'},alive:false},visual:fallen,facing:'south'}],
    arena:[enemy('wolf-1',70),enemy('wolf-2',80),enemy('summon-1',90,'player'),enemy('dead-1',100)],
    performanceHidden:true,isActorAlive:(id:string)=>id!=='dead-1',pendingDefeats:new Set<string>(),captureState:()=>undefined,
    captureStoryVisit:()=>({roster:{enemies:[],sequence:0,partySize:1},breakableRolls:[['wolf-1','wolf']]})});
  const host=Object.assign(Object.create(WorldScene.prototype),{map:{id:'camp'},player,movement,combat,facing:'north',
    characters:[gate,chest,spring,hidden],baseEntities:[],chestOpened:(value:unknown)=>value===chest,
    app:{session:{storyWorld:{actorVisible:(_map:string,actor:string)=>actor!=='npc'},visible:()=>true}}});
  const snapshot:SceneSnapshot=host.captureStoryScene();
  assert.deepEqual(host.captureStoryWorld().scene,snapshot,'rollback captures the same complete physical scene');
  assert.deepEqual(snapshot.visit?.breakableRolls,[['wolf-1','wolf']]);
  validateSceneSnapshot(snapshot);
  assert.deepEqual(snapshot.actors.map(actor=>actor.id),[
    'player','entity:gate-1','entity:chest-1','entity:spring-1','entity:hidden-1',
    'member:companion-1','member:companion-2','enemy:wolf-1','enemy:wolf-2','enemy:summon-1','enemy:dead-1'
  ]);
  assert.deepEqual(snapshot.actors.filter(actor=>actor.visible).map(actor=>actor.id),[
    'player','entity:gate-1','entity:spring-1','member:companion-1','enemy:wolf-1','enemy:wolf-2','enemy:summon-1'
  ]);
  const captured=(id:string)=>snapshot.actors.find(actor=>actor.id===id)!;
  assert.deepEqual([captured('player').x,captured('player').y,captured('player').facing],[12,18,'north']);
  assert.equal(captured('player').appearance?.clips['idle-south']?.layers[0]?.key,'equipped-sword');
  assert.equal(captured('member:companion-1').appearance?.clips['idle-south']?.layers[0]?.key,'equipped-shield');
  assert.equal(captured('member:companion-1').followsPlayer,true);
  assert.equal(captured('member:companion-2').followsPlayer,true,'阵亡队员也登记为跟随者，显隐仍按自己的存活状态');
  assert.deepEqual([captured('player').animationProgress,captured('player').animationPlaying],[.25,true]);
  assert.deepEqual([captured('member:companion-1').animationProgress,captured('member:companion-1').animationPlaying],[1,false]);
  assert.equal(captured('entity:gate-1').animationProgress,undefined,'单帧动画的 NaN 进度不能写进快照');
  assert.equal(captured('entity:gate-1').animationPlaying,true);
  assert.equal(captured('entity:spring-1').actor,'spring-high');
  assert.equal(captured('entity:spring-1').appearance?.id,'spring-empty');
  assert.equal(captured('enemy:wolf-1').enemyId,captured('enemy:wolf-2').enemyId);
  assert.equal(captured('enemy:summon-1').summonedBy,'player');
  companion.actor.clips['idle-south']!.layers[0]!.key='changed-later';
  assert.equal(captured('member:companion-1').appearance?.clips['idle-south']?.layers[0]?.key,'equipped-shield');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).actors.length,snapshot.actors.length);
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
  const formal=new WorldEnemyRoster(session,map,[],1,undefined,()=>.99);
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
  const host=Object.assign(Object.create(WorldScene.prototype),{
    map:{id:'origin'},app:{session:{storyWorld:{currentLocation:{map:'destination',x:1,y:2,facing:'south'}}},ui:{setWorldRebuildCover(){}}},
    scene:{isActive:()=>true},prefetchStoryEntry:async()=>{},restartStoryWorld:async(...args:unknown[])=>{received=args[5];}
  });
  await host.projectStoryWorld({scene},new AbortController().signal);
  assert.equal(received,scene);
  await host.projectStoryWorld({scene:{...scene,map:'unrelated'}},new AbortController().signal);
  assert.equal(received,undefined);
});

test('rollback restores physical prop positions and drained appearance while retaining rebuilt equipped textures',async()=>{
  const player=visual('player',appearance('hero','current-outfit'),10,20);
  const spring=visual('spring',appearance('spring-full'),0,0);
  Object.assign(spring.container,{setAlpha(this:typeof spring.container,value:number){this.alpha=value;return this;},setVisible(this:typeof spring.container,value:boolean){this.visible=value;return this;}});
  let restoredCombat=false;
  const host=Object.assign(Object.create(WorldScene.prototype),{map:{id:'camp'},player,characters:[spring],loadingWorld:false,
    encounterResults:new Set<string>(),
    movement:{refreshShape(){},placeAll:(placements:{visual:typeof spring;position:{x:number;y:number}}[])=>{
      for(const placement of placements)Object.assign(placement.visual.physics,placement.position);
    }},combat:{async restoreState(){restoredCombat=true;}},app:{},
    async projectStoryWorld(){},setClip(){},syncControlledCharacter(){}});
  await host.restoreStoryWorld({location:{map:'camp',x:10,y:20,facing:'south'},world:{},generatedEntities:[],scene:{map:'camp',actors:[
    {id:'player',actor:'hero',memberId:'player',x:10,y:20,facing:'south',visible:true,appearance:appearance('hero','expired-outfit')},
    {id:'entity:spring',actor:'spring-full',worldEntityId:'spring',x:42,y:56,facing:'west',visible:true,appearance:appearance('spring-empty')}
  ]}},new AbortController().signal);
  assert.equal(restoredCombat,true);
  assert.deepEqual(spring.physics,{x:42,y:56});
  assert.equal(spring.actor.id,'spring-empty');
  assert.equal(player.actor.clips['idle-south']!.layers[0]!.key,'current-outfit');
});

test('combat position handoff only updates living instances still present in the formal world',()=>{
  const active=visual('ally',appearance('ally'),1,2),dead=visual('dead',appearance('ally'),3,4);
  const monster=visual('monster',appearance('wolf'),5,6);active.actor.clips={};dead.actor.clips={};monster.actor.clips={};
  const placements:unknown[]=[];
  const scene={movement:{placeAll:(value:unknown[])=>placements.push(...value)},player:{}};
  const combat=Object.assign(Object.create(WorldCombat.prototype),{scene,
    allies:[{id:'ally',member:{alive:true},visual:active,facing:'south'},{id:'dead',member:{alive:false},visual:dead,facing:'south'}],
    arena:[{key:'monster',visual:monster,facing:'south'}],performanceHidden:true,isActorAlive:()=>true,pendingDefeats:new Set<string>()});
  combat.adoptStoryPositions([
    {id:'member:ally',actor:'ally',memberId:'ally',x:20,y:30,facing:'east',visible:true},
    {id:'member:dead',actor:'ally',memberId:'dead',x:40,y:50,facing:'east',visible:true},
    {id:'enemy:monster',actor:'wolf',enemyKey:'monster',x:60,y:70,facing:'west',visible:false,removed:true},
    {id:'enemy:missing',actor:'wolf',enemyKey:'missing',x:80,y:90,facing:'west',visible:true}
  ]);
  assert.equal(placements.length,1);
  assert.deepEqual(placements[0],{visual:active,position:{x:20,y:30},enabled:false});
  assert.equal(combat.allies[0].facing,'east');
});

test('a live visit snapshot keeps the actual enemy foot position alongside its original random replacement',()=>{
  const enemy=visual('wolf-1',appearance('jar'),44,55);
  const generated={roster:{enemies:[{key:'wolf-1',enemyId:'jar',x:1,y:2}],sequence:0,partySize:1},breakableRolls:[['wolf-1','jar']]};
  const combat=Object.assign(Object.create(WorldCombat.prototype),{
    scene:{movement:{position:(visual:typeof enemy)=>({...visual.physics})}},
    visualOf:()=>enemy,roster:{capturePreparedState:()=>structuredClone(generated)}
  });
  const captured=combat.captureStoryVisit();
  assert.deepEqual(captured.roster.enemies[0],{key:'wolf-1',enemyId:'jar',x:44,y:55});
  assert.deepEqual(captured.breakableRolls,[['wolf-1','jar']]);
  assert.deepEqual(generated.roster.enemies[0],{key:'wolf-1',enemyId:'jar',x:1,y:2});
});

test('story presenter prepares a foreign map through the real visit builder', async () => {
  const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
  const campaign=read('campaign'),worldIndex=read('world'),battleCatalog=read('battle'),items=read('items');
  const session=new Session(campaign);
  const destination='shadow-training-dungeon1-5e8c19b4',startMap=campaign.start.map;
  const player={actor:worldIndex.actors[campaign.start.actor],
    entity:{id:'player',actor:campaign.start.actor,x:10,y:20},container:{x:10,y:20,visible:true},layers:[],clipName:null};
  const formal={map:{id:startMap},player,facing:'south',characters:[],cameras:{main:{scrollX:5,scrollY:6}},
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
