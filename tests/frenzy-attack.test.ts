import {dispatchFrame,playCombat} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {FakeSprite} from './support/fake-sprite.ts';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import type {BasicAttackDefinition,BattleCatalog} from '../src/domain/battle.ts';
import {CombatController} from '../src/domain/combat.ts';
import type {ActionPlayback,BasicAreaContact,Combatant,CombatPort} from '../src/domain/combat.ts';
import {resolveBasicAttack,FACINGS} from '../src/domain/basic-attack.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {runActionDispatch} from '../src/domain/action-dispatch.ts';
import {parseWardrobe} from '../src/application/content-validation.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';
import type {ActionDispatchRunner} from '../src/rendering/combat-presenter.ts';

const hook=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,MULTIPLY:1,SCREEN:2,ADD:3}}',shortCircuit:true}:next(specifier,context);
}});
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const catalog:BattleCatalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8'));
const knight=catalog.classes.find(character=>character.id==='dark-knight')!;
const normal=resolveBasicAttack(catalog,knight);
const caster:Combatant={id:'source',team:'party',position:{x:0,y:0},bounds:{x:-8,y:-8,width:16,height:16}};
const enemy:Combatant={...caster,id:'enemy',team:'enemy',position:{x:8,y:0}};

function profile(frames=5,strike=2,swing:number|null=2){
  const actor=structuredClone(knight.actor);
  for(const facing of FACINGS)actor.clips[normal.clips[facing]]!.frames=frames;
  const definition:BasicAttackDefinition={...catalog.basicAttacks[knight.basicAttack!.profileId],
    timing:'fixed-animation',cycleFrames:frames,strikeFrame:strike,swingFrame:swing,
    swingOrder:'after-strike',swings:swing===null?[]:['dagger-swing'],strikes:undefined,
    targeting:{target:'area',targetRangePx:32,targetRangeMetric:'octagonal-grid'},
    projectile:null,transition:undefined,targetEffects:[],dispatch:{breaksStealth:true}};
  const character={actor,basicAttack:{profileId:'frenzy',clips:normal.clips}};
  return {actor,definition,character,attack:resolveBasicAttack({basicAttacks:{frenzy:definition}},character)};
}
class Sprite extends FakeSprite {
  stopped=false;
  visible=true;
  definitions:{frames:{frame:number}[];frameRate:number}[]=[];
  anims={create:(definition:{frames:{frame:number}[];frameRate:number})=>this.definitions.push(definition),
    stop:()=>{this.stopped=true;},timeScale:1,accumulator:0};
  override setVisible(value:boolean){this.visible=value;return this;}
}
function rendering(actor=profile().actor){
  const character={actor,entity:{id:'source',actor:actor.id},layers:[],clipName:null,
    container:{active:true,x:0,y:0,addAt:()=>{}}} as unknown as CharacterVisual;
  const timers:{delay:number;callback:()=>void;removed:boolean;remove:()=>void}[]=[];
  const scene={events:new EventEmitter(),add:{sprite:()=>new Sprite()},anims:{exists:()=>false,create:()=>{},generateFrameNumbers:()=>[]},
    time:{delayedCall:(delay:number,callback:()=>void)=>{
      const timer={delay,callback,removed:false,remove(){this.removed=true;}};timers.push(timer);return timer;
    }}} as unknown as Phaser.Scene;
  const presenter=new CombatPresenter(scene,catalog,id=>id==='source'?character:undefined,()=>[]);
  const swings:string[]=[];
  Reflect.set(presenter,'placedEffect',(name:string)=>swings.push(name));
  return {presenter,character,timers,swings,sprite:()=>character.layers[0] as unknown as Sprite};
}
function controllerRun(frames=5,strike=2,swing:number|null=2){
  const selected=profile(frames,strike,swing),render=rendering(selected.actor);
  const actors=new Map([[caster.id,structuredClone(caster)],[enemy.id,structuredClone(enemy)]]);
  const areas:BasicAreaContact[]=[],plays:{action:ActionPlayback;frame:(index:number)=>void;finish:()=>void}[]=[];
  const areaCallbacks:(()=>void)[]=[];
  let selections=0;
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor(caster.id),
    actor:id=>actors.get(id),candidates:()=>[...actors.values()],facing:()=> 'south',moveToward:()=>{},stop:()=>{},
    canStand:()=>true,relocate:()=>{},clearEffects:()=>{},
    selectBasicAttack:()=>{selections++;return selected.attack;},
    play:(action,frame,finish)=>{plays.push({action,frame,finish});action.getAttackSpeedRate=()=>assert.fail('fixed animation read attack speed');
      return playCombat(render.presenter,action,frame,finish);},
    frame:(action,index,contact,unitsReady,areaContact)=>{
      areaCallbacks.push(areaContact!);dispatchFrame(render.presenter,action,index,contact,unitsReady,undefined,undefined,areaContact);
    },
    areaContact:event=>areas.push(event),contact:()=>assert.fail('area used a single target contact'),
    spendMana:()=>assert.fail('basic replacement spent mana')};
  const controller=new CombatController(caster.id,normal,port);
  return {...render,selected,actors,areas,plays,areaCallbacks,port,controller,selections:()=>selections,
    advance:(index:number)=>render.sprite().emit('animationupdate',{}, {index:index+1})};
}

test('fixed basic animation uses complete source frames and ignores a speed cycle override',()=>{
  for(const [frames,strike]of [[5,2],[8,4],[12,4]]){
    const run=profile(frames,strike,null);
    const attack=resolveBasicAttack({basicAttacks:{frenzy:run.definition}},run.character,1);
    assert.equal(attack.effectiveCycleFrames,frames);
    for(const facing of FACINGS)assert.deepEqual(attack.sequence[facing],Array.from({length:frames},(_,index)=>index));
    run.character.actor.clips[normal.clips.south]!.frames--;
    assert.throws(()=>resolveBasicAttack({basicAttacks:{frenzy:run.definition}},run.character),/帧数不匹配/);
  }
});

test('Phaser fixed playback never reads speed and completes once at its original animation end',()=>{
  for(const frames of [5,8,12]){
    const run=profile(frames),render=rendering(run.actor),seen:number[]=[];
    let finished=0;
    const action:ActionPlayback={caster,facing:'south',basicAttack:run.attack,getAttackSpeedRate:()=>assert.fail('speed read')};
    const cancel=playCombat(render.presenter,action,index=>seen.push(index),()=>finished++);
    const sprite=render.sprite();
    assert.equal(sprite.definitions[0].frameRate,1000/60);
    assert.equal(sprite.definitions[0].frames.length,frames);
    sprite.emit('animationupdate',{}, {index:frames});assert.deepEqual(seen,Array.from({length:frames-1},(_,index)=>index+1));assert.equal(finished,0);
    sprite.emit('animationcomplete');assert.equal(finished,1);assert.equal(sprite.stopped,true);
    render.timers[0].callback();assert.equal(finished,1);cancel();assert.equal(render.timers[0].removed,true);
    assert.equal(sprite.listenerCount('animationupdate'),0);
  }
});

test('selection happens once after normal approach and area dispatch survives the original target leaving',()=>{
  const run=controllerRun();run.actors.get(enemy.id)!.position.x=1000;
  assert.equal(run.controller.requestTarget(enemy.id),'started');run.controller.update();assert.equal(run.selections(),0);
  run.actors.get(enemy.id)!.position.x=8;run.controller.update();assert.equal(run.selections(),1);
  assert.equal(run.plays[0].action.basicAttack,run.selected.attack);
  run.actors.delete(enemy.id);run.controller.targetRemoved(enemy.id);
  assert.equal(run.controller.snapshot().state,'attacking');assert.equal(run.controller.snapshot().targetId,undefined);
  run.advance(4);run.advance(4);run.areaCallbacks[0]();
  assert.deepEqual(run.areas,[{casterId:caster.id,basicAttack:run.selected.attack}]);
  assert.equal(run.selections(),1);assert.deepEqual(run.controller.snapshot().cooldowns,{});
  run.sprite().emit('animationcomplete');assert.equal(run.controller.snapshot().state,'idle');
});

test('cancelled area callbacks cannot run in the next attack and cancelling playback removes its timer',()=>{
  const run=controllerRun();run.controller.requestTarget(enemy.id);
  const previous=run.plays[0],callback=run.areaCallbacks[0],sprite=run.sprite(),timer=run.timers[0];
  run.controller.cancel();run.controller.requestTarget(enemy.id);
  callback();previous.frame(4);previous.finish();sprite.emit('animationcomplete');timer.callback();
  assert.equal(run.areas.length,0);assert.equal(run.controller.snapshot().state,'attacking');
  assert.equal(timer.removed,true);assert.equal(sprite.listenerCount('animationupdate'),0);
  run.advance(4);assert.equal(run.areas.length,1);
});

test('a same-frame swing follows the whole area dispatch and stealth break before deferred defeat',()=>{
  for(const [frames,strike]of [[5,2],[12,4]]){
    const run=controllerRun(frames,strike,strike),resolution=new CombatHitResolution(),order:string[]=[];
    let concealed=true;
    Reflect.set(run.presenter,'placedEffect',()=>{assert.equal(run.character.container.active,true);order.push('swing');});
    run.port.areaContact=()=>{order.push('target1','target2');resolution.deferDefeat(caster.id,()=>{
      order.push('defeat');run.character.container.active=false;
    });};
    const dispatch:ActionDispatchRunner=(definition,work,after)=>resolution.run(()=>{
      runActionDispatch(definition.breaksStealth,{isStealthed:()=>concealed,work,
        removeStealth:()=>{order.push('break');concealed=false;}});after?.();
    });
    run.port.frame=(action,index,contact,unitsReady,areaContact)=>dispatchFrame(run.presenter,action,index,contact,unitsReady,undefined,dispatch,areaContact);
    run.controller.requestTarget(enemy.id);run.advance(strike);
    assert.deepEqual(order,['target1','target2','break','swing','defeat']);
  }
});

test('a swing on an earlier frame stays before the strike and a profile without a swing emits none',()=>{
  for(const [swing,expected]of [[3,['swing','area']],[null,['area']]] as const){
    const run=controllerRun(8,4,swing),order:string[]=[];
    Reflect.set(run.presenter,'placedEffect',()=>order.push('swing'));run.port.areaContact=()=>order.push('area');
    run.controller.requestTarget(enemy.id);run.advance(7);assert.deepEqual(order,expected);
  }
});

test('an unavailable animation waits without dispatch, hides only body layers, and restores their visibility',()=>{
  for(const durationFrames of [128,5,8,12]){
    const run=controllerRun(),visible=new Sprite(),hidden=new Sprite();hidden.visible=false;
    run.character.layers.push(visible as unknown as Phaser.GameObjects.Sprite,hidden as unknown as Phaser.GameObjects.Sprite);
    run.port.selectBasicAttack=()=>({kind:'animation-unavailable',durationFrames});
    let dispatches=0;
    run.port.frame=(action,index,contact,unitsReady,areaContact)=>dispatchFrame(run.presenter,action,index,contact,unitsReady,undefined,(_definition,work,after)=>{dispatches++;work();after?.();},areaContact);
    assert.equal(run.controller.requestTarget(enemy.id),'started');
    assert.equal(run.plays[0].action.basicAttack,null);
    assert.deepEqual(run.plays[0].action.basicAttackWait,{kind:'animation-unavailable',durationFrames});
    assert.equal(run.controller.snapshot().state,'attacking');assert.equal(run.controller.snapshot().targetId,enemy.id);
    assert.equal(run.timers[0].delay,durationFrames*60);assert.equal(run.character.container.active,true);
    assert.equal(visible.visible,false);assert.equal(hidden.visible,false);assert.equal(visible.definitions.length,0);
    run.actors.delete(enemy.id);run.controller.targetRemoved(enemy.id);assert.equal(run.controller.snapshot().state,'attacking');
    run.plays[0].frame(127);assert.equal(dispatches,0);assert.deepEqual(run.areas,[]);assert.deepEqual(run.swings,[]);
    assert.deepEqual(run.controller.snapshot().cooldowns,{});
    run.timers[0].callback();assert.equal(run.controller.snapshot().state,'idle');
    assert.equal(visible.visible,true);assert.equal(hidden.visible,false);
    run.timers[0].callback();assert.equal(run.controller.snapshot().state,'idle');
  }
});

test('cancelling an unavailable animation restores body layers and cancels its old completion callback',()=>{
  const run=controllerRun(),body=new Sprite();run.character.layers.push(body as unknown as Phaser.GameObjects.Sprite);
  run.port.selectBasicAttack=()=>({kind:'animation-unavailable',durationFrames:128});
  run.controller.requestTarget(enemy.id);const timer=run.timers[0];assert.equal(body.visible,false);
  run.controller.cancel();assert.equal(body.visible,true);assert.equal(timer.removed,true);
  run.port.selectBasicAttack=()=>run.selected.attack;run.controller.requestTarget(enemy.id);timer.callback();
  assert.equal(run.controller.snapshot().state,'attacking');assert.equal(body.visible,true);
});

test('fixed area profile validation checks source length and rejects conflicting strike delivery modes',()=>{
  const run=profile(),stance=Object.fromEntries(FACINGS.map(facing=>[normal.clips[facing],'pose']));
  const wardrobe={textures:[],sprites:{},variants:{},defaults:{},equipment:{},
    poses:{pose:{mirrorX:false,frameRate:1000/60,frames:Array.from({length:5},()=>[])}},
    stances:{stance},skills:{},attacks:{stance:catalog.basicAttacks[knight.basicAttack!.profileId]},
    frenzyAttacks:{stance:{...run.definition,clips:normal.clips}},skillStances:{}};
  assert.ok(parseWardrobe(wardrobe).frenzyAttacks?.stance);
  for(const change of [{strikeFrame:5},{swingFrame:5},{cycleFrames:6},{strikes:[{frame:2,hand:'main-hand'}]},
    {projectile:normal.projectile??{effect:'bolt',offsetX:0,offsetY:0,stepDistancePx:8,stepDurationMs:60}}]){
    const bad=structuredClone(wardrobe);Object.assign(bad.frenzyAttacks.stance,change);
    assert.throws(()=>parseWardrobe(bad));
  }
  const wait={...wardrobe,frenzyAttacks:undefined,frenzyWaitFrames:{stance:128}};
  assert.equal(parseWardrobe(wait).frenzyWaitFrames?.stance,128);
  assert.throws(()=>parseWardrobe({...wardrobe,frenzyWaitFrames:{stance:128}}));
  assert.throws(()=>parseWardrobe({...wait,frenzyWaitFrames:{missing:128}}));
  assert.throws(()=>parseWardrobe({...wait,frenzyWaitFrames:{stance:0}}));
});
