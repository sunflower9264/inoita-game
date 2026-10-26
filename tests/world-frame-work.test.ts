import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {Session} from '../src/domain/session.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {Campaign} from '../src/domain/campaign.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import {SkillConfiguration} from '../src/domain/skill-configuration.ts';
import {NavigationWorld} from '../src/domain/navigation-world.ts';
import {CompanionSkillProgression} from '../src/domain/companion-progression.ts';
import {SCENE_KEYS} from '../src/application/scene-keys.ts';
import type {ShortcutSlot} from '../src/ui/phaser/action-controls.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldScene}=await import('../src/scenes/world-scene.ts');hook.deregister();
const invoke=(host:object,name:string,...args:unknown[])=>Reflect.get(WorldScene.prototype,name).call(host,...args);

test('interaction distance filters task queries and preserves visibility, opened objects and tie order',()=>{
  const character=(id:string,x:number,extra={})=>({entity:{id},actor:{},container:{x,y:0,visible:true},...extra});
  const far=character('far',25),hidden=character('hidden',1,{container:{x:1,y:0,visible:false}});
  const chest=character('chest',2,{actor:{chest:true}}),spring=character('spring',3,{entity:{id:'spring',spring:true}});
  const decorative=character('decorative',4),first=character('first',24),tie=character('tie',-24);
  const queried:string[]=[];let refreshed=0;
  const host={app:{session:{refresh:()=>refreshed++,chests:{isOpened:()=>true},springs:{isEmpty:()=>true}}},map:{id:'map'},
    player:{container:{x:0,y:0}},characters:[far,hidden,chest,spring,decorative,first,tie],near:null as unknown,
    chestOpened:(value:typeof chest)=>value===chest,
    interactionCandidate:(value:typeof far)=>{queried.push(value.entity.id);return value!==decorative?1:null;}};
  invoke(host,'updateInteractionTarget');
  assert.equal(refreshed,1);assert.deepEqual(queried,['decorative','first','tie']);assert.equal(host.near,first);
  first.container.x=30;tie.container.x=-30;invoke(host,'updateInteractionTarget');assert.equal(host.near,null);
});

test('shortcut pages reuse layout snapshots while mana, eligibility, quantity and recovery stay live',t=>{
  const read=<T>(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
  const battle=read<BattleCatalog>('battle'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
  const hero=new BattleCharacter('dark-knight',stats,items),session=new Session(read<Campaign>('campaign'),undefined,undefined,items,hero,battle);
  let slots:readonly ShortcutSlot[]=[],allowed=true,cost=1,seenRank=0;
  let recoveryCooldown={remainingMs:100,durationMs:200};
  t.mock.getter(session.recovery,'cooldown',()=>recoveryCooldown);
  const host=Object.assign(Object.create(WorldScene.prototype),{app:{session,battleCatalog:battle,items},
    controls:{setShortcutPage:(value:readonly ShortcutSlot[])=>{slots=value;}},
    combat:{controlledMember:hero,controlledId:'player',skillSlotAvailable:()=>allowed,
      skillManaCost:(_owner:string,_skill:string,rank:number)=>{seenRank=rank;return cost;}}});
  invoke(host,'refreshShortcutPage');assert.equal(slots[0].enabled,true);assert.equal(seenRank,1);
  const draft=t.mock.method(session.skills,'draft');
  for(let frame=0;frame<10;frame++)invoke(host,'refreshShortcutPage');
  assert.equal(draft.mock.callCount(),0,'unchanged frames reuse the learned levels and shortcut row');
  hero.setMana(0);invoke(host,'refreshShortcutPage');assert.equal(slots[0].enabled,false);
  cost=0;invoke(host,'refreshShortcutPage');assert.equal(slots[0].enabled,true);
  allowed=false;invoke(host,'refreshShortcutPage');assert.equal(slots[0].enabled,false);
  recoveryCooldown={remainingMs:20,durationMs:200};invoke(host,'refreshShortcutPage');
  assert.equal(slots[5].cooldown?.remainingMs,20);assert.equal(draft.mock.callCount(),0);
  const potion=items.startingShortcut!,quantity=session.bag.count(potion);
  session.bag.add(potion);invoke(host,'refreshShortcutPage');assert.equal(slots[5].quantity,quantity+1);
  hero.grantSkillPoint();hero.grantSkillPoint();session.skills.learn('dark-strike');
  invoke(host,'refreshShortcutPage');assert.equal(seenRank,2);
  const saved=session.skills.captureState();session.skills.nextShortcutPage(hero.classId);
  invoke(host,'refreshShortcutPage');assert(slots.every(slot=>slot.entry===null));
  session.skills.restoreState(saved);invoke(host,'refreshShortcutPage');assert.equal(slots[0].entry?.id,'dark-strike');
  const companion={classId:hero.classId,player:{mana:10},skills:new SkillConfiguration()};
  host.combat.controlledMember=companion;host.combat.controlledId='companion';
  invoke(host,'refreshShortcutPage');assert.equal(seenRank,1);
  host.combat.controlledMember=hero;host.combat.controlledId='player';
  invoke(host,'refreshShortcutPage');assert.equal(seenRank,2);
  session.bag.remove(potion,session.bag.count(potion));invoke(host,'refreshShortcutPage');assert.equal(slots[5].entry,null);
});

test('companion skill growth, saved configurations and restores advance the shortcut input version',()=>{
  const catalog={classes:[{id:'priest',skills:['heal']}],skills:{heal:{kind:'active'}}} as unknown as BattleCatalog;
  const skills=new CompanionSkillProgression({heal:2},{heal:{classId:'priest',position:0,maxLevel:2,requiredLevels:[1,5]}});
  const before=skills.version;skills.updateLevel(1);assert(skills.version>before);assert.equal(skills.draft(catalog,'priest').levels.heal,1);
  const lower=skills.version;skills.updateLevel(5);assert(skills.version>lower);assert.equal(skills.draft(catalog,'priest').levels.heal,2);
  const grown=skills.version;skills.save(catalog,'priest',skills.draft(catalog,'priest'));assert(skills.version>grown);
  const saved=skills.captureState(),version=skills.version;skills.restoreState(saved);assert(skills.version>version);
});

test('gm travel snaps a blocked destination point and reports why a map cannot be entered',async()=>{
 const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
 const campaign=read('campaign'),world=read('world'),map=read('maps/shadow-camp');
 const commands:{type:string;destination:{x:number;y:number}}[][]=[];let restarts=0;
 const host:any=Object.assign(Object.create(WorldScene.prototype),{
  app:{world,campaign,content:{map:async()=>map},ui:{loading:()=>{}},
   session:{applyStoryCommands:(value:{type:string;destination:{x:number;y:number}}[])=>commands.push(value)}},
  loadingWorld:false,destroyed:false,equippedActor:world.actors[campaign.start.actor],scene:{}});
 // 场景重启会走 `open()`，结束时把加载标志放回去；夹具照这个语义复位。
 host.scene.restart=(options:{onReady?:()=>void})=>{restarts++;host.loadingWorld=false;options.onReady?.();};
 const result=await invoke(host,'gmTravel','shadow-camp',{x:8,y:8});
 assert.deepEqual(result,{ok:true});assert.equal(restarts,1);
 // 没这张图时要说清是地图不对，而不是笼统地失败。
 assert.deepEqual(await invoke(host,'gmTravel','missing-map'),{ok:false,reason:'地图不存在：missing-map'});
 const travel=commands[0]!.find(command=>command.type==='travel')!;
 const [x,y]=[travel.destination.x,travel.destination.y];
 assert.notDeepEqual([x,y],[8,8],'站不住的坐标要被吸附');
 assert.equal(new NavigationWorld(map).terrainFree({x,y}),true);
});

test('entry loading stays up until the entry performance draws its first frame',async()=>{
  const calls:string[]=[];let release!:()=>void;
  const ui={loadingState:{label:'正在前往新的地方…',progress:0},failed:false,
    loaded(){calls.push('loaded');},error(){calls.push('error');}};
  const director:{onPresentationStarted?:()=>void}={};
  const host=Object.assign(Object.create(WorldScene.prototype),{
    app:{ui,director},holdingEntryLoading:false,entryStoryStarted:undefined as (()=>void)|undefined});
  const story=new Promise<boolean>(resolve=>{release=()=>resolve(false);});
  const pending=invoke(host,'holdEntryLoading',()=>story,ui) as Promise<void>;
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[],'第一幕出现前不能收起加载页');
  assert.equal(host.holdingEntryLoading,true);
  assert.equal(typeof director.onPresentationStarted,'function');
  director.onPresentationStarted!();
  await pending;
  assert.deepEqual(calls,['loaded']);
  assert.equal(host.holdingEntryLoading,false);
  assert.equal(director.onPresentationStarted,undefined);
  release();
});

test('an entry performance without any drawn frame still ends the loading page once',async()=>{
  const calls:string[]=[];
  const ui={loadingState:{label:'正在前往新的地方…',progress:0},failed:false,
    loaded(){calls.push('loaded');},error(){calls.push('error');}};
  const director:{onPresentationStarted?:()=>void}={};
  const host=Object.assign(Object.create(WorldScene.prototype),{
    app:{ui,director},holdingEntryLoading:false,entryStoryStarted:undefined as (()=>void)|undefined});
  await (invoke(host,'holdEntryLoading',async()=>false,ui) as Promise<void>);
  assert.deepEqual(calls,['loaded']);
  assert.equal(host.holdingEntryLoading,false);
});

test('stage occlusion hides the world camera, pauses physics and restores it on release',()=>{
  const calls:string[]=[];
  const camera={visible:true,
    preRender(){calls.push('preRender');},
    setVisible(value:boolean){calls.push(`visible:${value}`);camera.visible=value;return camera;}};
  const physics={world:{},pause(){calls.push('pause');},resume(){calls.push('resume');}};
  const messages={values:[] as boolean[],setPaused(value:boolean){this.values.push(value);}};
  const loot={values:[] as boolean[],setPaused(value:boolean){this.values.push(value);}};
  const host=Object.assign(Object.create(WorldScene.prototype),{
    destroyed:false,stageOccluded:false,cameras:{main:camera},physics,
    pickupMessages:messages,groundLootView:loot,
    sys:{isActive:()=>true},loadingWorld:false,performing:false,
    app:{ui:{ready:true,controlLayoutEditing:false},locked:true,suspended:false,director:{busy:true}}});
  invoke(host,'setStageOccluded',true);
  assert.deepEqual(calls,['preRender','visible:false','pause'],'隐藏前先结算镜头，再停渲染和物理');
  assert.deepEqual(messages.values,[true]);
  assert.deepEqual(loot.values,[true]);
  invoke(host,'setStageOccluded',true);
  assert.deepEqual(calls,['preRender','visible:false','pause'],'同值不重复操作');
  invoke(host,'setStageOccluded',false);
  assert.deepEqual(calls.slice(-2),['visible:true','resume']);
  assert.equal(host.stageOccluded,false);

  const dead=Object.assign(Object.create(WorldScene.prototype),{destroyed:true,stageOccluded:false,
    cameras:{main:{setVisible(){throw new Error('销毁后不应触碰相机');}}},physics:{world:{}}});
  assert.doesNotThrow(()=>invoke(dead,'setStageOccluded',true));
  assert.equal(dead.stageOccluded,false);
});

test('world update stays idle while the stage covers it and recovers when the stage is gone',()=>{
  let covered=true;
  const calls:string[]=[];
  const host=Object.assign(Object.create(WorldScene.prototype),{
    stageOccluded:true,destroyed:false,
    scene:{get:(key:string)=>key===SCENE_KEYS.storyStage?{worldCovered:covered}:undefined},
    cameras:{main:{preRender(){calls.push('preRender');},setVisible(value:boolean){calls.push(`visible:${value}`);}}},
    physics:{world:{},pause(){calls.push('pause');},resume(){calls.push('resume');}},
    pickupMessages:{setPaused(){}},groundLootView:{setPaused(){}},
    sys:{isActive:()=>true},loadingWorld:false,performing:false,
    app:{ui:{ready:true,controlLayoutEditing:false},locked:false,suspended:false,director:{busy:false}}});
  invoke(host,'update',0,16);
  assert.equal(host.stageOccluded,true,'舞台仍盖住时不推进世界');
  assert.deepEqual(calls,[]);
  covered=false;
  invoke(host,'update',0,16);
  assert.equal(host.stageOccluded,false,'舞台消失后自愈');
  assert.deepEqual(calls,['visible:true','resume']);
});
