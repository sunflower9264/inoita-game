import {CombatRuntime} from '../src/domain/combat-runtime.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { StoryContext } from '../src/application/ports.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { CombatController, type Combatant } from '../src/domain/combat.ts';
import { PartyController, type PartyPort } from '../src/domain/party-ai.ts';
import { resolveBasicAttack } from '../src/domain/basic-attack.ts';

// These tests execute the scene adapters' coordination logic without a browser renderer.
const phaser = registerHooks({resolve(specifier, context, next) {
  return specifier === 'phaser' ? {url:'data:text/javascript,export default {BlendModes:{NORMAL:0,ADD:1,MULTIPLY:2,SCREEN:3},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true} : next(specifier,context);
}});
const { WorldCombat } = await import('../src/scenes/world-combat.ts');
const { StoryPresenter } = await import('../src/rendering/story-presenter.ts');
const { WorldScene } = await import('../src/scenes/world-scene.ts');
phaser.deregister();
const battle=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

function partyAction(id:string,cooldowns:CombatCooldownStore) {
  const caster:Combatant={id,team:'party',position:{x:32,y:32},bounds:{x:-4,y:-4,width:8,height:8}};
  const enemy:Combatant={...caster,id:'enemy',team:'hostile',position:{x:40,y:32}};
  let stops=0,clears=0,hits=0,cancelled=0;
  let oldFrame:((frame:number)=>void)|undefined;
  const port:PartyPort={cooldowns:cooldowns.forActor(id),actor:key=>[caster,enemy].find(actor=>actor.id===key),candidates:()=>[caster,enemy],facing:()=> 'east',
    moveToward(){},stop(){stops++;},canStand:()=>true,relocate(){},clearEffects(){clears++;},
    play:(_action,frame)=>{oldFrame=frame;return()=>{cancelled++;};},frame(){},contact(){hits++;},
    leader:()=>caster,focusTarget:()=>undefined,inCombat:()=>true,counterattack:()=>2,damageCount:()=>0,navigationBounds:()=>({x:0,y:0,width:256,height:256}),
    followPath(){},skills:()=>[],skillKind:()=>undefined,vitals:()=>({health:10,maxHealth:10}),attacking:()=>false,attackRange:()=>4};
  const controller=new CombatController(id,resolveBasicAttack(battle,battle.classes[0]),port);
  const ai=new PartyController(id,port,controller);
  port.cooldowns.start('dark-strike',15);
  controller.requestTarget('enemy');
  assert.equal(controller.snapshot().state,'attacking');
  return {controller,ai,port,fireOldFrame:()=>oldFrame?.(100),stats:()=>({stops,clears,hits,cancelled})};
}

function pauseFixture(performing=false) {
  const time={frame:0},cooldowns=new CombatCooldownStore(()=>time.frame);
  const hero=partyAction('player',cooldowns),ally=partyAction('companion-1',cooldowns);
  const player={container:{active:true}},visual={container:{active:true}};
  const stopped:unknown[]=[],temporary:string[]=[];
  const state={
    scene:{player,performing,movement:{stop:(value:unknown)=>stopped.push(value)}},
    app:{session:{party:{activeIds:['player','companion-1'],controlledId:'companion-1'}}},
    partyActionsSuspended:false,partyControllers:new Map([['player',hero.controller],['companion-1',ally.controller]]),
    heroAi:hero.ai,allies:[{id:'companion-1',visual,ai:ally.ai}],arena:[],
    conditions:{clearTemporary:(id:string)=>temporary.push(id)}
  };
  const runtime=Object.setPrototypeOf(state,WorldCombat.prototype) as unknown as InstanceType<typeof WorldCombat>;
  return {runtime,state,hero,ally,stopped,temporary,player,visual,advanceFrames:(frames:number)=>{time.frame+=frames;}};
}

test('a menu pause preserves party actions and cooldowns until control resumes',()=>{
  const f=pauseFixture(),paused: boolean[]=[];
  const visuals=new Map([['player',{layers:[],container:{active:true}}],['companion-1',{layers:[],container:{active:true}}]]);
  Object.assign(f.state,{visualOf:(id:string)=>visuals.get(id),presenterFor:()=>({setPaused:(value:boolean)=>paused.push(value)}),
    combatEffects:{setPaused:()=>{}}});
  Object.assign(f.state.scene.movement,{setPaused:()=>{}});
  f.hero.port.isPaused=()=>f.runtime.paused;f.ally.port.isPaused=()=>f.runtime.paused;
  f.runtime.setPaused(true);f.hero.fireOldFrame();f.ally.fireOldFrame();
  assert.equal(f.runtime.paused,true);
  for(const member of [f.hero,f.ally]){
    assert.equal(member.controller.snapshot().state,'attacking');assert.equal(member.stats().cancelled,0);
    assert.equal(member.controller.snapshot().cooldowns['dark-strike'].remainingMs,900);
  }
  f.runtime.setPaused(false);assert.equal(f.runtime.paused,false);assert.deepEqual(paused,[true,true,false,false]);
});

test('resetting skills during a menu cancels the hero delayed work while preserving paid cooldowns',()=>{
  const f=pauseFixture();let revision=0,hits=0;
  Object.assign(f.state.app.session,{skills:{get resetVersion(){return revision;}}});
  Reflect.set(f.state,'lastSkillReset',0);
  Reflect.get(f.state,'runtime').schedule('player',1,()=>hits++);
  revision++;Reflect.get(WorldCombat.prototype,'onPartyChanged').call(f.runtime);
  f.advanceFrames(1);Reflect.get(f.state,'runtime').step(1);
  assert.equal(hits,0);assert.equal(f.hero.stats().cancelled,1);assert.equal(f.ally.stats().cancelled,0);
  assert.equal(f.hero.controller.snapshot().cooldowns['dark-strike'].remainingMs,840);
});

test('cinematic takeover cancels every party action and old callbacks once, keeping cooldowns',()=>{
  const f=pauseFixture();
  f.runtime.suspendPartyActions();
  const once={hero:f.hero.stats(),ally:f.ally.stats()};
  f.runtime.suspendPartyActions();
  f.hero.fireOldFrame();f.ally.fireOldFrame();
  assert.deepEqual({hero:f.hero.stats(),ally:f.ally.stats()},once);
  assert.equal(once.hero.cancelled,1);assert.equal(once.ally.cancelled,1);
  assert.equal(once.hero.hits,0);assert.equal(once.ally.hits,0);
  assert.deepEqual(f.stopped,[f.player,f.visual]);
  assert.deepEqual(f.temporary,['player','companion-1']);
  for(const member of [f.hero,f.ally])assert.equal(member.controller.snapshot().cooldowns['dark-strike'].remainingMs,900);
  f.ally.controller.update();assert.equal(f.ally.controller.snapshot().cooldowns['dark-strike'].remainingMs,900);
  f.advanceFrames(4);
  for(const member of [f.hero,f.ally])assert.equal(member.controller.snapshot().cooldowns['dark-strike'].remainingMs,660);
});

test('the dialogue input lock cancels combat before the director takes ownership of player movement',()=>{
  const f=pauseFixture();
  f.runtime.suspendPartyActions();
  assert.equal(f.hero.stats().cancelled,1);
  assert.equal(f.ally.stats().cancelled,1);
  f.state.scene.performing=true;
  f.stopped.length=0;
  f.runtime.suspendPartyActions();
  f.hero.fireOldFrame();f.ally.fireOldFrame();
  assert.deepEqual(f.stopped,[]);
  assert.equal(f.hero.stats().hits,0);assert.equal(f.ally.stats().hits,0);
});

test('finishing cinematic presentation leaves formal player and companion camera unchanged',async()=>{
  const companion={container:{x:80,y:32}},player={container:{x:32,y:32}};
  const camera={follow:companion.container};
  const world={player,map:{id:'test'},cameras:{main:camera},
    movement:{place(){throw new Error('presentation cannot move formal player');}},
    syncControlledCharacter(){throw new Error('runtime projects after the node commits');}
  } as unknown as InstanceType<typeof WorldScene>;
  const stage={map:undefined};
  const presenter=new StoryPresenter({} as StoryContext,()=>world,()=>stage as unknown as import('../src/scenes/story-stage-scene.ts').StoryStageScene);
  await presenter.finish(true,new AbortController().signal);
  assert.equal(camera.follow,companion.container);
  assert.deepEqual(player.container,{x:32,y:32});
});

test('a controlled companion already inside an exit must leave it before the performance can trigger travel again',()=>{
  const exit={x:64,y:0,width:32,height:64,destination:'next-map',spawn:{x:8,y:8},facing:'east' as const};
  const companion={container:{active:true,x:80,y:32}};
  const state={app:{gmNoclip:false},player:{container:{active:true,x:32,y:32}},combat:{controlledVisual:companion},map:{exits:[exit]},
    movement:{position:()=>({x:80,y:32})},cameras:{main:{startFollow(){}}},refreshLoadout(){},refreshCombatTarget(){},syncHud(){}};
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  scene.syncControlledCharacter(true);
  assert.equal(scene.exitTrigger!.update({x:82,y:32},true),null);
  assert.equal(scene.exitTrigger!.update({x:40,y:32},true),null);
  assert.equal(scene.exitTrigger!.update({x:80,y:32},true),exit);
});

test('a companion warlock commands only its own soldier, and an untargeted summon fires in place',()=>{
  const casterId='companion-warlock',calls:{summon:string;target:string|undefined;level:number}[]=[];
  const makeSummon=(key:string,summonedBy:string,x:number)=>({key,summonedBy,visual:{container:{x,y:0}},
    definition:{id:'enemy-hell-s-pawn-1',commandAction:{id:'soldier-command'}},
    controller:{command:(_command:unknown,target:string|undefined,level:number)=>calls.push({summon:key,target,level})}});
  const own=makeSummon('own',casterId,0),heroSummon=makeSummon('hero-summon','player',1),other=makeSummon('other','companion-ranger',2);
  const hostile={key:'hostile',visual:{container:{x:40,y:0}},definition:{id:'wolf'}};
  const member={panel:{attributes:{strength:3,dexterity:4,vitality:5,intelligence:6,mentality:7}}};
  const context={defeated:false,closed:false,pendingDefeats:{has:()=>false},hero:{level:40},arena:[own,heroSummon,other,hostile],
    memberOf:(id:string)=>id===casterId?member:undefined,partyFighter:()=>({physicalAttack:1}),
    movement:{position:(visual:typeof own.visual)=>visual.container},
    combatant:(id:string)=>({id,team:id==='hostile'?'hostile':'party'}),
    // 召唤物没有当前目标：命令不带目标，原地按自身范围施放，不改成最近的敌人。
    enemyTarget:()=>undefined};
  const action=battle.skills['monster-s-scream'].action!;
  const cueIndex=action.combatUnits!.findIndex(unit=>unit.effect==='action');
  Reflect.get(WorldCombat.prototype,'skillUnit').call(Object.setPrototypeOf(context,WorldCombat.prototype),{casterId,targetId:casterId,cueIndex,skill:{id:'monster-s-scream',action,level:3}});
  assert.deepEqual(calls,[{summon:'own',target:undefined,level:3}]);
});

test('the scream fails, and spends nothing, when the caster owns no summon',()=>{
  const casterId='companion-warlock',calls:unknown[]=[];
  const hostile={key:'hostile',visual:{container:{x:40,y:0}},definition:{id:'wolf'}};
  const context={defeated:false,closed:false,pendingDefeats:{has:()=>false},hero:{level:40},
    arena:[hostile],memberOf:(id:string)=>id===casterId?{panel:{attributes:{strength:0,dexterity:0,vitality:0,intelligence:9,mentality:0}}}:undefined,
    combatant:(id:string)=>({id,team:id==='hostile'?'hostile':'party'}),enemyTarget:()=>undefined,
    partyFighter:()=>({physicalAttack:1}),movement:{position:()=>({x:0,y:0})}};
  const action=battle.skills['monster-s-scream'].action!;
  const cueIndex=action.combatUnits!.findIndex(unit=>unit.effect==='action');
  const outcome=Reflect.get(WorldCombat.prototype,'skillUnit').call(Object.setPrototypeOf(context,WorldCombat.prototype),
    {casterId,targetId:casterId,cueIndex,skill:{id:'monster-s-scream',action,level:1}});
  assert.equal(outcome,'failure','没有召唤就不算成功，也就不会耗资源');
  assert.deepEqual(calls,[]);
});

test('every active summon of the caster is commanded, and it follows the summon current target',()=>{
  const casterId='companion-warlock',calls:{summon:string;target:string}[]=[];
  const makeSummon=(key:string,x:number)=>({key,summonedBy:casterId,visual:{container:{x,y:0}},
    definition:{id:'enemy-hell-s-pawn-1',commandAction:{id:'soldier-command'}},
    controller:{command:(_command:unknown,target:string)=>calls.push({summon:key,target})}});
  const far=makeSummon('far',900),near=makeSummon('near',10);
  const hostile={key:'hostile',visual:{container:{x:12,y:0}},definition:{id:'wolf'}};
  const otherHostile={key:'other',visual:{container:{x:950,y:0}},definition:{id:'wolf'}};
  const context={defeated:false,closed:false,pendingDefeats:{has:()=>false},hero:{level:40},
    arena:[far,near,hostile,otherHostile],
    memberOf:(id:string)=>id===casterId?{panel:{attributes:{strength:0,dexterity:0,vitality:0,intelligence:9,mentality:0}}}:undefined,
    combatant:(id:string)=>({id,team:id==='hostile'||id==='other'?'hostile':'party'}),
    // 远处那个召唤的当前目标是另一个敌人，就沿它打，不改成最近的。
    enemyTarget:(id:string)=>id==='far'?'other':id==='near'?'hostile':undefined,
    partyFighter:()=>({physicalAttack:1}),movement:{position:(visual:{container:{x:number}})=>visual.container}};
  const action=battle.skills['monster-s-scream'].action!;
  const cueIndex=action.combatUnits!.findIndex(unit=>unit.effect==='action');
  const outcome=Reflect.get(WorldCombat.prototype,'skillUnit').call(Object.setPrototypeOf(context,WorldCombat.prototype),
    {casterId,targetId:casterId,cueIndex,skill:{id:'monster-s-scream',action,level:1}});
  assert.equal(outcome,'success');
  assert.deepEqual(calls,[{summon:'far',target:'other'},{summon:'near',target:'hostile'}]);
});

test('a spring that has already been drunk is no longer an interaction target',()=>{
  const spring={container:{visible:true,x:8,y:0},actor:{},entity:{id:'well-1',actor:'clear-springs-f6f095b4',x:8,y:0,spring:true}};
  // 挑脚下的可交互对象前会先刷新任务投影（任务日志与头顶标记都读它），替身也要提供这一步。
  let refreshed=0;
  const state=(empty:boolean)=>({player:{container:{visible:true,x:0,y:0}},characters:[spring],combat:{controlledVisual:undefined},map:{id:'forest'},
    app:{session:{refresh:()=>{refreshed++;},springs:{isEmpty:()=>empty},chests:{isOpened:()=>false},
      // 交互判定会先看任务槽、任务目标标记和可交互声明；泉水用例只关心泉水本身。
      npcQuestSlot:()=>undefined,canInteract:()=>false,status:()=>'locked',markerActor:()=>undefined},
    campaign:{quests:[]}}});
  const scene=Object.setPrototypeOf(state(true),WorldScene.prototype) as unknown as {near:unknown;updateInteractionTarget():void};
  scene.updateInteractionTarget();
  assert.equal(scene.near,null,'喝空的泉水不再靠近可交互');
  const full=Object.setPrototypeOf(state(false),WorldScene.prototype) as unknown as {near:unknown;updateInteractionTarget():void};
  full.updateInteractionTarget();
  assert.equal(full.near,spring,'满水的泉水照常可选');
  assert.equal(refreshed,2,'每次交互判定都先刷新一次任务投影');
});

test('drinking replaces the spring visuals with the waterless well',()=>{
  const clip=(key:string)=>({frameWidth:43,frameHeight:34,frames:1,originX:.5,originY:1,frameRate:10,mirrorX:false,layers:[{key,file:key+'.png',blend:'normal'}]});
  const world={actors:{'clear-springs-f6f095b4':{clips:{'idle-south':clip('clear-springs-f6f095b4-idle-south-normal')}},
    'well-7abb1f76':{clips:{'idle-south':clip('well-7abb1f76-idle-south-normal')}}}};
  const drawn:string[]=[];
  const sprite=(key:string)=>({key,alpha:1,setOrigin(){return this;},setBlendMode(){return this;},setTexture(){return this;},setVisible(){return this;},setScale(){return this;},setAlpha(){return this;},destroy(){},play(){},anims:{}});
  // drainSpring 把场景本身当作 Phaser scene 用，所以贴图工厂与动画表挂在 state 上。
  const character={entity:{id:'well-1',actor:'clear-springs-f6f095b4',x:0,y:0},actor:world.actors['clear-springs-f6f095b4'],container:{addAt(){}},layers:[],clipName:'idle-south' as const};
  const state={springCatalog:{empty:'well-7abb1f76'},app:{world},
    anims:{exists:()=>true,create(){},generateFrameNumbers:()=>[]},
    add:{sprite:(_x:number,_y:number,key:string)=>{drawn.push(key);return sprite(key);}}};
  const runtime=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as {drainSpring(character:unknown):void};
  runtime.drainSpring(character);
  assert.equal(character.actor,world.actors['well-7abb1f76'],'换成没有液体的水井外观');
  assert.deepEqual(drawn,['well-7abb1f76-idle-south-normal'],'图层按新外观重建，而不是沿用旧贴图');
});

test('party death finishes on logical time even when no Tween completion arrives',()=>{
  let frame=0,defeats=0,stopped=0,visible=true;
  const kernel=new CombatRuntime(()=>frame),visual={layers:[],actor:{clips:{}},container:{active:true,setVisible:(value:boolean)=>{visible=value;}}};
  const member={player:{health:0},clearCombatResourceLimits:()=>{}};
  const host=Object.setPrototypeOf({runtime:kernel,closed:false,defeated:false,fallen:new Set(),deathTweens:new Map(),partyControllers:new Map(),
    activeParty:['player'],controlledVisual:visual,visualOf:()=>visual,memberOf:()=>member,hero:member,heroAi:{disable:()=>{}},allies:[],arena:[],
    conditions:{remove:()=>{}},movement:{position:()=>({x:0,y:0}),stop:()=>{},setEnabled:()=>{}},outcomes:{setPaused:()=>{}},stopEnemies:()=>{},
    app:{session:{party:{onDefeat:()=>true}}},scene:{facing:'south',handleCombatDefeat:()=>defeats++,tweens:{add:(options:object)=>{
      assert.equal('onComplete' in options,false);return {stop:()=>stopped++};
    }}},
  },WorldCombat.prototype);
  Reflect.get(WorldCombat.prototype,'memberDefeated').call(host,'player');
  kernel.setPaused('menu',true);kernel.step(1);assert.equal(defeats,0);kernel.setPaused('menu',false);
  for(;frame<9;)kernel.step(++frame);assert.equal(defeats,0);kernel.step(++frame);
  assert.equal(defeats,1);assert.equal(visible,false);assert.equal(stopped,1);assert.equal(kernel.idle,true);
});
