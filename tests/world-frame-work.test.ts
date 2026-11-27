import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Session} from '../src/domain/session.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {Campaign} from '../src/domain/campaign.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import {SkillConfiguration} from '../src/domain/skill-configuration.ts';
import {CompanionSkillProgression} from '../src/domain/companion-progression.ts';
import {SCENE_KEYS} from '../src/application/scene-keys.ts';
import {groundLootFor} from '../src/domain/ground-loot.ts';
import type {ShortcutSlot} from '../src/ui/hud/action-controls.ts';
import {buildTestWorldScene,loadWorldSceneClass} from './support/world-scene-fixture.ts';

const WorldScene=await loadWorldSceneClass();

test('stationary loot retries when bag, quests, recipients or restored progress change',()=>{
  let attempts=0,accept=false;
  const session={bag:{revision:0},questBook:{version:0},storyWorld:{revision:0},restorationVersion:0,
    hasLivingMember:false,questItemGenerators:{collected(){}},combatTick:0};
  const store=groundLootFor(session as unknown as Session);store.add('map',0,0,[{kind:'money',amount:1}]);
  const host=buildTestWorldScene(WorldScene,{
    map:{id:'map',exits:[]},
    app:{session,items:{items:{}}},
    sceneOverrides:{receiveGroundReward:()=>{attempts++;return accept;}},
  });
  for(let frame=0;frame<60;frame++)host.collectGroundLoot({x:0,y:0});
  assert.equal(attempts,1,'unchanged frames do not retry refused drops');
  session.bag.revision++;host.collectGroundLoot({x:0,y:0});assert.equal(attempts,2);
  session.questBook.version++;host.collectGroundLoot({x:0,y:0});assert.equal(attempts,3);
  Object.assign(session,{hasLivingMember:true});host.collectGroundLoot({x:0,y:0});assert.equal(attempts,4);
  host.combat={} as never;host.collectGroundLoot({x:0,y:0});assert.equal(attempts,5);
  Object.assign(session,{restorationVersion:1});host.collectGroundLoot({x:0,y:0});assert.equal(attempts,6);
  accept=true;host.collectGroundLoot({x:1,y:0});assert.equal(store.forMap('map').length,0);
});

test('stationary interaction reuses candidates until scene positions or visibility change',()=>{
  let inspected=0;
  const container={x:8,y:0,visible:true,setAlpha(){return this;},setVisible(value:boolean){this.visible=value;return this;}};
  const npc={entity:{id:'npc',actor:'npc'},actor:{id:'npc',description:'talk'},get container(){inspected++;return container;}};
  const session={
    questBook:{version:0},
    storyWorld:{revision:0,actorVisible:()=>true,isPlaced:()=>false},
    chests:{revision:0,isOpened:()=>false},
    legendaryWeapons:{revision:0,isPulled:()=>false},
    springs:{isEmpty:()=>false},
    visible:()=>true,
    marker:()=>null,
    markerActor:()=>false,
    npcQuestSlot:()=>undefined,
    canInteract:()=>false,
    status:()=>'locked' as const,
  };
  const host=buildTestWorldScene(WorldScene,{
    app:{session,storyInterface:{assets:{}}},
    map:{id:'map'},
    player:{container:{x:0,y:0}},
    characters:[npc],
    movement:{placeAll(values:{position:{x:number;y:number}}[]){Object.assign(container,values[0].position);},setEnabled(){}},
    sceneOverrides:{
      setClip(){},refreshLoadout(){},noticeQuestChanges(){},refreshMinimapInteractions(){},
      refreshStateSignature:()=> 'visibility-change',
    },
  });
  host.updateInteractionTarget();assert.equal(host.near,npc);inspected=0;
  for(let frame=0;frame<60;frame++)host.updateInteractionTarget();
  assert.equal(inspected,0,'unchanged player and world do not inspect map characters');
  host.restoreScenePositions({map:'map',actors:[{id:'npc',actor:'npc',worldEntityId:'npc',x:80,y:0,facing:'south',visible:true}]});
  host.updateInteractionTarget();assert.equal(host.near,null,'restored NPC position invalidates the nearby result');
  host.restoreScenePositions({map:'map',actors:[{id:'npc',actor:'npc',worldEntityId:'npc',x:8,y:0,facing:'south',visible:true}]});
  host.updateInteractionTarget();assert.equal(host.near,npc);
  session.visible=()=>false;host.refreshState();
  host.updateInteractionTarget();assert.equal(host.near,null,'visibility updates invalidate a stationary target');
  session.questBook.version++;container.visible=true;
  host.updateInteractionTarget();assert.equal(host.near,npc,'quest changes invalidate the query');
  host.player!.container.x=80;host.updateInteractionTarget();assert.equal(host.near,null,'player movement invalidates the query');
});

test('interaction distance filters task queries and preserves visibility, opened objects and tie order',()=>{
  const character=(id:string,x:number,extra:{actor?:object;entity?:object;container?:object}={})=>({
    entity:{id,actor:id,...extra.entity},
    actor:extra.actor??{description:'talk'},
    container:{x,y:0,visible:true,...extra.container},
  });
  const far=character('far',25),hidden=character('hidden',1,{container:{x:1,y:0,visible:false}});
  const chest=character('chest',2,{actor:{chest:true}}),spring=character('spring',3,{entity:{id:'spring',actor:'spring',spring:true}});
  const decorative=character('decorative',4,{actor:{}}),first=character('first',24),tie=character('tie',-24);
  const queried:string[]=[];let refreshed=0;
  const host=buildTestWorldScene(WorldScene,{
    app:{session:{
      refresh:()=>refreshed++,
      questBook:{version:0},
      storyWorld:{revision:0,isPlaced:()=>false},
      chests:{revision:0,isOpened:()=>true},
      legendaryWeapons:{revision:0,isPulled:()=>false},
      springs:{isEmpty:()=>true},
      npcQuestSlot:(actorId:string)=>{queried.push(actorId);return undefined;},
      canInteract:()=>false,
      status:()=>'locked' as const,
      markerActor:()=>false,
    }},
    map:{id:'map'},
    player:{container:{x:0,y:0}},
    characters:[far,hidden,chest,spring,decorative,first,tie],
  });
  host.updateInteractionTarget();
  assert.equal(refreshed,0,'交互目标不再每帧刷新任务簿');assert.deepEqual(queried,['decorative','first','tie']);assert.equal(host.near,first);
  first.container.x=30;tie.container.x=-30;host.interactionRevision++;host.updateInteractionTarget();assert.equal(host.near,null);
});

test('shortcut pages reuse layout snapshots while mana, eligibility, quantity and recovery stay live',t=>{
  const read=<T>(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
  const battle=read<BattleCatalog>('battle'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
  const hero=new BattleCharacter('dark-knight',stats,items),session=new Session(read<Campaign>('campaign'),undefined,undefined,items,hero,battle);
  let slots:readonly ShortcutSlot[]=[],allowed=true,cost=1,seenRank=0;
  let recoveryCooldown={remainingMs:100,durationMs:200};
  t.mock.getter(session.recovery,'cooldown',()=>recoveryCooldown);
  const host=buildTestWorldScene(WorldScene,{
    app:{session,battleCatalog:battle,items},
    worldHud:{ready:true,setShortcutPage:(value:readonly ShortcutSlot[])=>{slots=value;}},
    combat:{controlledMember:hero,controlledId:'player',
      skillShortcutState:(_skill:string,rank:number)=>{seenRank=rank;return {cost,enabled:allowed};}},
  });
  host.refreshCombatHud();assert.equal(slots[0].enabled,true);assert.equal(seenRank,1);
  const draft=t.mock.method(session.skills,'draft');
  for(let frame=0;frame<10;frame++)host.refreshCombatHud();
  assert.equal(draft.mock.callCount(),0,'unchanged frames reuse the learned levels and shortcut row');
  hero.setMana(0);host.refreshCombatHud();assert.equal(slots[0].enabled,false);
  cost=0;host.refreshCombatHud();assert.equal(slots[0].enabled,true);
  allowed=false;host.refreshCombatHud();assert.equal(slots[0].enabled,false);
  recoveryCooldown={remainingMs:20,durationMs:200};host.refreshCombatHud();
  assert.equal(slots[5].cooldown?.remainingMs,20);assert.equal(draft.mock.callCount(),0);
  const potion=items.startingShortcut!,quantity=session.bag.count(potion);
  session.bag.add(potion);host.refreshCombatHud();assert.equal(slots[5].quantity,quantity+1);
  hero.grantSkillPoint();hero.grantSkillPoint();session.skills.learn('dark-strike');
  host.refreshCombatHud();assert.equal(seenRank,2);
  const saved=session.skills.captureState();session.skills.nextShortcutPage(hero.classId);
  host.refreshCombatHud();assert(slots.every(slot=>slot.entry===null));
  session.skills.restoreState(saved);host.refreshCombatHud();assert.equal(slots[0].entry?.id,'dark-strike');
  const companion={classId:hero.classId,player:{mana:10},skills:new SkillConfiguration()};
  Object.assign(host.combat!,{controlledMember:companion,controlledId:'companion'});
  host.refreshCombatHud();assert.equal(seenRank,1);
  Object.assign(host.combat!,{controlledMember:hero,controlledId:'player'});
  host.refreshCombatHud();assert.equal(seenRank,2);
  session.bag.remove(potion,session.bag.count(potion));host.refreshCombatHud();assert.equal(slots[5].entry,null);
});

test('one combat tick paints the shortcut wheel and keyboard skill row once, while event refreshes stay immediate',()=>{
  const configuration={version:0,shortcutPage:()=>0,activeSkills:()=>['skill'],draft:()=>({levels:{skill:1}})};
  const bag={revision:0,catalog:{startingShortcut:undefined},ensureShortcuts:(_owner:string,row:unknown)=>row,count:()=>0};
  const paints:string[]=[];
  let cooldownReads=0;
  let cooldowns:Readonly<Record<string,{remainingMs:number;durationMs:number}>>={'skill':{remainingMs:1000,durationMs:2000}};
  const session={combatTick:0,bag,skills:configuration};
  const host=buildTestWorldScene(WorldScene,{
    app:{session,battleCatalog:{skills:{skill:{icon:'skill.png'}}},items:{items:{}}},
    worldHud:{ready:true,setShortcutPage:()=>paints.push('skillHud','controls')},
    combat:{controlledMember:{classId:'dark-knight',player:{mana:10},skills:configuration},controlledId:'player',
      get cooldowns(){cooldownReads++;return cooldowns;},
      skillShortcutState:()=>({cost:0,enabled:true})},
  });
  host.refreshCombatHudIfTickChanged();
  host.refreshCombatHudIfTickChanged();
  assert.equal(cooldownReads,1,'同一逻辑帧只取一次冷却快照');
  assert.deepEqual(paints,['skillHud','controls'],'同一逻辑帧两个快捷栏各只绘制一次');
  cooldowns={'skill':{remainingMs:900,durationMs:2000}};
  session.combatTick=1;
  host.refreshCombatHudIfTickChanged();
  assert.equal(cooldownReads,2,'逻辑帧前进后才重新取冷却快照');
  assert.deepEqual(paints,['skillHud','controls','skillHud','controls']);
  cooldowns={'skill':{remainingMs:800,durationMs:2000}};
  host.refreshLoadout();
  assert.deepEqual(paints,['skillHud','controls','skillHud','controls','skillHud','controls'],'换人、换页和背包事件不等逻辑帧');
  host.refreshCombatHudIfTickChanged();
  assert.equal(paints.length,6,'事件已经刷新过的同一逻辑帧不再重画');
  const withoutCombat=buildTestWorldScene(WorldScene,{
    app:{session:{combatTick:0}},worldHud:{ready:true,setShortcutPage:()=>assert.fail('没有战斗和操控者时不应绘制')},
  });
  withoutCombat.refreshCombatHudIfTickChanged();
  withoutCombat.refreshCombatHud();
  const withoutSession=buildTestWorldScene(WorldScene,{
    app:{},worldHud:{ready:true,setShortcutPage:()=>assert.fail('没有会话时不应绘制')},
  });
  withoutSession.refreshCombatHudIfTickChanged();
  withoutSession.refreshCombatHud();
});

test('companion skill growth, saved configurations and restores advance the shortcut input version',()=>{
  const catalog={classes:[{id:'priest',skills:['heal']}],skills:{heal:{kind:'active'}}} as unknown as BattleCatalog;
  const skills=new CompanionSkillProgression({heal:2},{heal:{classId:'priest',position:0,maxLevel:2,requiredLevels:[1,5]}});
  const before=skills.version;skills.updateLevel(1);assert(skills.version>before);assert.equal(skills.draft(catalog,'priest').levels.heal,1);
  const lower=skills.version;skills.updateLevel(5);assert(skills.version>lower);assert.equal(skills.draft(catalog,'priest').levels.heal,2);
  const grown=skills.version;skills.save(catalog,'priest',skills.draft(catalog,'priest'));assert(skills.version>grown);
  const saved=skills.captureState(),version=skills.version;skills.restoreState(saved);assert(skills.version>version);
});

test('entry loading stays up until the entry performance draws its first frame',async()=>{
  const calls:string[]=[];let release!:()=>void;
  const ui={loadingState:{label:'正在前往新的地方…',progress:0},failed:false,
    loaded(){calls.push('loaded');},error(){calls.push('error');}};
  const director:{onPresentationStarted?:()=>void}={};
  const host=buildTestWorldScene(WorldScene,{app:{ui,director}});
  const story=new Promise<boolean>(resolve=>{release=()=>resolve(false);});
  const pending=host.readiness.holdEntryLoading(()=>story,ui as never,director,work=>work());
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[],'第一幕出现前不能收起加载页');
  assert.equal(typeof director.onPresentationStarted,'function');
  director.onPresentationStarted!();
  await pending;
  assert.deepEqual(calls,['loaded']);
  assert.equal(director.onPresentationStarted,undefined);
  release();
});

test('an entry performance without any drawn frame still ends the loading page once',async()=>{
  const calls:string[]=[];
  const ui={loadingState:{label:'正在前往新的地方…',progress:0},failed:false,
    loaded(){calls.push('loaded');},error(){calls.push('error');}};
  const director:{onPresentationStarted?:()=>void}={};
  const host=buildTestWorldScene(WorldScene,{app:{ui,director}});
  await host.readiness.holdEntryLoading(async()=>false,ui as never,director,work=>work());
  assert.deepEqual(calls,['loaded']);
  assert.equal(director.onPresentationStarted,undefined);
});

test('stage occlusion hides the world camera, pauses physics and restores it on release',()=>{
  const calls:string[]=[];
  const camera={visible:true,
    preRender(){calls.push('preRender');},
    setVisible(value:boolean){calls.push(`visible:${value}`);camera.visible=value;return camera;}};
  const physics={world:{},pause(){calls.push('pause');},resume(){calls.push('resume');}};
  const messages={values:[] as boolean[],setPaused(value:boolean){this.values.push(value);}};
  const loot={values:[] as boolean[],setPaused(value:boolean){this.values.push(value);}};
  const host=buildTestWorldScene(WorldScene,{
    destroyed:false,stageOccluded:false,loadingWorld:false,
    app:{ui:{ready:true,controlLayoutEditing:false},locked:true,suspended:false,director:{busy:true}},
    sceneOverrides:{
      cameras:{main:camera},physics,pickupMessages:messages,groundLootView:loot,
      sys:{isActive:()=>true},
    },
  });
  host.setStageOccluded(true);
  assert.deepEqual(calls,['preRender','visible:false','pause'],'隐藏前先结算镜头，再停渲染和物理');
  assert.deepEqual(messages.values,[true]);
  assert.deepEqual(loot.values,[true]);
  host.setStageOccluded(true);
  assert.deepEqual(calls,['preRender','visible:false','pause'],'同值不重复操作');
  host.setStageOccluded(false);
  assert.deepEqual(calls.slice(-2),['visible:true','resume']);
  assert.equal(host.stageOccluded,false);

  const dead=buildTestWorldScene(WorldScene,{
    destroyed:true,stageOccluded:false,
    sceneOverrides:{cameras:{main:{setVisible(){throw new Error('销毁后不应触碰相机');}}},physics:{world:{}}},
  });
  assert.doesNotThrow(()=>dead.setStageOccluded(true));
  assert.equal(dead.stageOccluded,false);
});

test('world update stays idle while the stage covers it and recovers when the stage is gone',()=>{
  let covered=true;
  const calls:string[]=[];
  const host=buildTestWorldScene(WorldScene,{
    stageOccluded:true,destroyed:false,loadingWorld:false,
    app:{ui:{ready:true,controlLayoutEditing:false},locked:false,suspended:false,director:{busy:false}},
    sceneOverrides:{
      scene:{get:(key:string)=>key===SCENE_KEYS.storyStage?{worldCovered:covered}:undefined},
      cameras:{main:{preRender(){calls.push('preRender');},setVisible(value:boolean){calls.push(`visible:${value}`);}}},
      physics:{world:{},pause(){calls.push('pause');},resume(){calls.push('resume');}},
      pickupMessages:{setPaused(){}},groundLootView:{setPaused(){}},
      sys:{isActive:()=>true},
    },
  });
  host.update(0,16);
  assert.equal(host.stageOccluded,true,'舞台仍盖住时不推进世界');
  assert.deepEqual(calls,[]);
  covered=false;
  host.update(0,16);
  assert.equal(host.stageOccluded,false,'舞台消失后自愈');
  assert.deepEqual(calls,['visible:true','resume']);
});

test('unchanged map state skips the character visibility loop',()=>{
  let touched=0;
  const host=buildTestWorldScene(WorldScene,{
    app:{session:{visible:()=>true,storyWorld:{actorVisible:()=>true,isPlaced:()=>false},
      chests:{isOpened:()=>false},legendaryWeapons:{isPulled:()=>false},marker:()=>null,markerActor:()=>false}},
    combat:{},map:undefined,
    characters:[{entity:{id:'npc',actor:'npc'},actor:{id:'npc'},container:{x:0,y:0,setVisible:()=>touched++}}],
    movement:{setEnabled(){}},
    sceneOverrides:{
      refreshLoadout(){},noticeQuestChanges(){},refreshStateSignature:()=>'same',
    },
  });
  host.refreshState();
  assert.equal(touched,1,'第一次按状态刷新角色显隐');
  host.refreshState();
  assert.equal(touched,1,'签名不变时不再执行角色显隐循环');
});


test('nonvisual equipment changes stats without resetting the actor, collision or attack',async()=>{
  const read=<T>(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
  const battle=read<BattleCatalog>('battle'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
  const hero=new BattleCharacter('dark-knight',stats,items),actor=battle.classes.find(value=>value.id==='dark-knight')!.actor;
  const session=new Session(read<Campaign>('campaign'),undefined,{classId:hero.classId,appearance:actor},items,hero,battle);
  const ringId=Object.entries(items.items).find(([,item])=>item.equipment?.slot==='ring'&&!item.equipment.locked)![0];
  session.bag.add(ringId);const entry=session.bag.entries.find(entry=>entry.item===ringId)!;
  const outfit={actor};let preparations=0;
  const host=buildTestWorldScene(WorldScene,{
    app:{session,battleCatalog:battle,items,wardrobe:{textures:[]}},
    player:{actor},
    movement:{refreshShape:()=>assert.fail('饰品不改变碰撞体')},
    combat:{updateEquipment:()=>assert.fail('饰品不重置攻击')},
    sceneOverrides:{syncControlledCharacter(){}},
  });
  host.outfits.wardrobe={prepare:async()=>{preparations++;return outfit as never;},activate(){},releasePreview(){},destroy(){}};
  const revision=session.bag.revision;
  await host.changeEquipment(entry.id,'ring');
  assert.equal(session.bag.equipment.ring,entry.id);assert.ok(session.bag.revision>revision);
  assert.equal(host.player!.actor,actor);
  await host.projectEquipment(new AbortController().signal);
  assert.equal(preparations,1,'会话刷新不会再次准备已完成的换装');
});

test('lamp preparation cancels or rejects a blocked landing before creating a merchant',async()=>{
  for(const failure of ['abort','map','blocked','load'] as const){
    const actor=JSON.parse(readFileSync(new URL('../public/content/world.json',import.meta.url),'utf8')).actors['lamp-dealer-007'];
    const controller=new AbortController();let released=0,created=0;
    const session={};
    const host=buildTestWorldScene(WorldScene,{
      app:{session,world:{actors:{[actor.id]:actor}},shops:{lampShop:actor.id}},
      map:{id:'map',name:'map'},player:{},destroyed:false,
      movement:{navigation:{nearestReachableBody:()=>undefined}},
      sceneOverrides:{
        controlledPosition:()=>({x:80,y:80}),
        createActor:()=>{created++;throw new Error('must not create');},
        loadAssets:async()=>{
          if(failure==='load')throw new Error('load failed');
          if(failure==='abort')controller.abort();
          if(failure==='map')host.map={id:'other',name:'other'} as never;
          return {release:()=>released++};
        },
      },
    });
    await assert.rejects(()=>host.summonLampMerchant('lamp',controller.signal));
    assert.equal(created,0);assert.equal(released,failure==='load'?0:1);
  }
});

test('world appearance follows town maps and keeps an explicit armed story override', async () => {
  const read=<T>(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
  const battle=read<BattleCatalog>('battle'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
  const hero=new BattleCharacter('dark-knight',stats,items),actor=battle.classes.find(value=>value.id==='dark-knight')!.actor;
  const session=new Session(read<Campaign>('campaign'),undefined,{classId:hero.classId,appearance:actor},items,hero,battle);
  const selected:boolean[]=[];
  const host=buildTestWorldScene(WorldScene,{
    app:{session,battleCatalog:battle},player:{actor},
    map:{townPose:true},
    sceneOverrides:{request:new AbortController()},
  });
  host.outfits.wardrobe={prepare:async (_base:unknown,_equipment:unknown,_class:unknown,options?:{townPose?:boolean})=>{
    selected.push(!!options?.townPose);return {actor} as never;
  },activate(){},releasePreview(){},destroy(){}};
  await host.preparePlayerAppearance();
  host.outfits.playerTownPose=false;
  await host.preparePlayerAppearance();
  delete host.outfits.playerTownPose;host.map!.townPose=false;
  await host.preparePlayerAppearance();
  assert.deepEqual(selected,[true,false,false]);
});

test('restoring a story scene adopts its hero posture and forces a new outfit', () => {
  const host=buildTestWorldScene(WorldScene,{
    map:{id:'town'},movement:{placeAll(){}},characters:[],
    sceneOverrides:{refreshMinimapInteractions(){}},
  });
  host.outfits.playerTownPose=true;
  host.outfits.projectedPlayerEquipment='signature';
  host.restoreScenePositions({map:'town',actors:[
    {id:'player',actor:'hero',x:10,y:20,facing:'south',visible:true,townPose:false}
  ]});
  assert.equal(host.outfits.playerTownPose,false);
  assert.equal(host.outfits.projectedPlayerEquipment,'','姿态变化必须重新合成主角外观');
});
