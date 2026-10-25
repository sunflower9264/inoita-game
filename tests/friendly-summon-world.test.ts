import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {ActiveCombatAction,Combatant} from '../src/domain/combat.ts';
import {CombatRuntime} from '../src/domain/combat-runtime.ts';
import {SummonCombatAwareness} from '../src/domain/summon-tactics.ts';
import {NavigationWorld,type NavigationActor} from '../src/domain/navigation-world.ts';
import {canTraverse} from '../src/domain/pathfinding.ts';
import {overlapsFootRect,type Point} from '../src/domain/navigation.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,ADD:1,MULTIPLY:2,SCREEN:3},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
phaser.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const box={x:-4,y:-4,width:8,height:8};
interface TestVisual {id:string;actor:{collision:typeof box};container:{active:boolean;visible:boolean}}
interface TestEnemy {
  key:string;visual:TestVisual;summonedBy?:string;summonRemainingMs?:number;
  definition:{behavior:{awarenessRangeUnits:number}};
  controller:{snapshot():{state:string;targetId?:string};actionState():string;currentTargetId():string|undefined;
    combatController:{activeAction():ActiveCombatAction|undefined}};
}

function fixture(){
  const terrain={name:'summon-recall',tileSize:16,columns:64,rows:64,blocked:Array<boolean>(4096).fill(false)};
  const navigation=new NavigationWorld(terrain);
  const session={combatTick:0,party:{activeIds:['player','companion'],controlledId:'player'}};
  const positions=new Map<TestVisual,Point>(),bodies=new Map<TestVisual,NavigationActor>(),actors=new Map<string,Combatant>();
  const dead=new Set<string>(),actions=new Map<string,ActiveCombatAction>(),selected=new Map<string,string>();
  const stateByEnemy=new Map<string,{state:string;targetId?:string}>();
  const partyControllers=new Map<string,{activeAction():ActiveCombatAction|undefined;snapshot():{state:string;targetId?:string};
    actionState():string;selectedTargetId():string|undefined}>();
  const moved:{visual:TestVisual;point:Point}[]=[];
  function addActor(id:string,team:string,position:Point):TestVisual {
    const visual:TestVisual={id,actor:{collision:{...box}},container:{active:true,visible:true}};
    const point={...position};positions.set(visual,point);
    const body:NavigationActor={shape:()=>visual.actor,position:()=>point,enabled:()=>visual.container.visible};
    bodies.set(visual,body);navigation.register(body);
    actors.set(id,{id,team,position:point,bounds:visual.actor.collision});
    if(team==='party')partyControllers.set(id,{activeAction:()=>actions.get(id),snapshot:()=>({state:actions.get(id)?.state??'idle',targetId:selected.get(id)}),
      actionState:()=>actions.get(id)?.state??'idle',selectedTargetId:()=>selected.get(id)});
    return visual;
  }
  const ownerVisual=addActor('player','party',{x:512,y:512});
  addActor('companion','party',{x:512,y:560});
  const visual=addActor('summon','party',{x:64,y:64});
  partyControllers.delete('summon');
  const summon:TestEnemy={key:'summon',visual,summonedBy:'player',summonRemainingMs:12340,
    definition:{behavior:{awarenessRangeUnits:8}},
    controller:{snapshot:()=>({state:'idle'}),actionState:()=> 'idle',currentTargetId:()=>undefined,
      combatController:{activeAction:()=>actions.get('summon')}}};
  const arena:TestEnemy[]=[summon];
  const combatRuntime=new CombatRuntime(()=>session.combatTick);
  const awareness=new SummonCombatAwareness(0);
  const resources={health:37,mana:12,cooldowns:{command:17},buffs:['protection']};
  const movement={navigation,position:(value:TestVisual)=>({...positions.get(value)!}),actor:(value:TestVisual)=>bodies.get(value)!,
    canStand:(value:TestVisual,point:Point)=>navigation.canStand(bodies.get(value)!,point),
    place:(value:TestVisual,point:Point)=>{
      assert.equal(navigation.canStand(bodies.get(value)!,point),true,'召回只能提交合法落点');
      Object.assign(positions.get(value)!,point);moved.push({visual:value,point:{...point}});
    }};
  let canAct=true,canMove=true;
  const state={app:{session},scene:{movement,performing:false,map:{exits:[] as {x:number;y:number;width:number;height:number}[],entities:[] as Point[]}},
    arena,partyControllers,combatRuntime,summonAwareness:awareness,partyActionsSuspended:false,
    conditions:{canAct:()=>canAct,canMove:()=>canMove},
    combatant:(id:string)=>actors.get(id),combatants:()=>[...actors.values()],isActorAlive:(id:string)=>actors.has(id)&&!dead.has(id),
    visualOf:(id:string)=>[...positions.keys()].find(value=>value.id===id),
    threat:{clear:()=>assert.fail('召回不能清空仇恨'),clearOwner:()=>assert.fail('召回不能清空角色仇恨'),has:()=>true}};
  const world=Object.setPrototypeOf(state,WorldCombat.prototype);
  const method=(name:string)=>Reflect.get(WorldCombat.prototype,name).bind(world) as (...args:unknown[])=>unknown;
  function hostile(id:string,point:Point,range=8):TestEnemy {
    const visual=addActor(id,'hostile',point);stateByEnemy.set(id,{state:'idle'});
    const enemy:TestEnemy={key:id,visual,definition:{behavior:{awarenessRangeUnits:range}},
      controller:{snapshot:()=>stateByEnemy.get(id)!,actionState:()=>stateByEnemy.get(id)!.state,
        currentTargetId:()=>stateByEnemy.get(id)!.targetId,combatController:{activeAction:()=>actions.get(id)}}};
    arena.push(enemy);return enemy;
  }
  return {world,state,session,terrain,navigation,positions,bodies,actors,dead,actions,selected,awareness,combatRuntime,
    ownerVisual,summon,arena,moved,resources,hostile,stateByEnemy,addActor,
    setTime:(milliseconds:number)=>{assert.equal(milliseconds%60,0);session.combatTick=milliseconds/60;},
    setCapabilities:(act:boolean,move:boolean)=>{canAct=act;canMove=move;},
    recall:()=>method('tryRecallSummon')(summon) as boolean,observe:()=>method('observeSummonCombat')(),
    tactics:()=>awareness.tactics(summon.summonedBy!,session.party.activeIds)};
}

test('an idle runtime still blocks recall while an enemy is pursuing any party member',()=>{
  const f=fixture();f.setTime(6000);
  f.hostile('pursuer',{x:900,y:900});
  f.stateByEnemy.set('pursuer',{state:'chasing',targetId:'companion'});
  assert.equal(f.combatRuntime.idle,true);
  assert.equal(f.recall(),false);
  f.observe();
  assert.deepEqual(f.tactics().engagedTargetIds,['pursuer']);
  assert.deepEqual(f.tactics().threats,[{enemyId:'pursuer',targetId:'companion'}]);
  assert.equal(f.awareness.quietFor(6000),0);
});

test('an idle enemy with old selection and threat records does not prevent safe recall',()=>{
  const f=fixture();f.setTime(6000);
  f.hostile('idle-monster',{x:900,y:900});
  f.stateByEnemy.set('idle-monster',{state:'idle',targetId:'player'});
  f.observe();
  assert.deepEqual(f.tactics().engagedTargetIds,[]);
  assert.equal(f.recall(),true);
  assert.equal(f.moved.length,1);
});

test('world observation requires a continuous three seconds without hostile contact before recall',()=>{
  const f=fixture();f.setTime(2940);assert.equal(f.recall(),false);
  f.setTime(3000);assert.equal(f.recall(),true);
  const enemy=f.hostile('remote',{x:900,y:900});
  f.setTime(6000);f.stateByEnemy.set(enemy.key,{state:'chasing',targetId:'player'});f.observe();
  f.stateByEnemy.set(enemy.key,{state:'idle'});
  f.setTime(8940);f.observe();assert.equal(f.recall(),false);
  f.setTime(9000);f.observe();assert.equal(f.recall(),true);
});

test('nearby hidden enemies cover both the old summon position and its owner position',()=>{
  for(const position of [{x:96,y:64},{x:544,y:512}]){
    const f=fixture();f.setTime(6000);
    const hidden=f.hostile('hidden',position);f.actors.get(hidden.key)!.states=['stealthed'];
    assert.equal(f.recall(),false,'隐身敌人仍然阻止在其警戒范围内召回');
    f.dead.add(hidden.key);assert.equal(f.recall(),true,'已经死亡的敌人不再覆盖召回位置');
  }
});

test('recall waits for runtime work, pause, story takeover and movement restrictions',()=>{
  const f=fixture();f.setTime(6000);
  const cancel=f.combatRuntime.schedule('late-projectile',1,()=>{});
  assert.equal(f.recall(),false);cancel();
  f.combatRuntime.setPaused('menu',true);assert.equal(f.recall(),false);f.combatRuntime.setPaused('menu',false);
  f.state.scene.performing=true;assert.equal(f.recall(),false);f.state.scene.performing=false;
  f.state.partyActionsSuspended=true;assert.equal(f.recall(),false);f.state.partyActionsSuspended=false;
  f.setCapabilities(false,false);assert.equal(f.recall(),false);
  f.setCapabilities(true,false);assert.equal(f.recall(),false);
  f.setCapabilities(true,true);assert.equal(f.recall(),true);
});

test('recall chooses a legal landing on the owners side of a wall without needing an origin route',()=>{
  const f=fixture();f.setTime(6000);
  for(let row=0;row<64;row++)f.terrain.blocked[row*64+34]=true;
  Object.assign(f.positions.get(f.summon.visual)!,{x:800,y:512});
  const original=Object.freeze({...f.positions.get(f.summon.visual)!});
  assert.equal(f.recall(),true);
  const point=f.moved[0].point,owner=f.actors.get('player')!,body=f.bodies.get(f.summon.visual)!;
  assert.ok(point.x<540,'落点不能在隔墙另一侧');
  assert.notDeepEqual(point,original);
  const localFree=(p:Point)=>f.navigation.canPlace(body.shape(),p,body,[{actor:f.bodies.get(f.ownerVisual)!,position:owner.position,enabled:false}]);
  assert.equal(canTraverse(owner.position,point,localFree),true);
});

test('recall rejects occupied landing rings and map exits',()=>{
  const occupied=fixture();occupied.setTime(6000);
  occupied.addActor('large-blocker','neutral',{x:512,y:512}).actor.collision={x:-80,y:-80,width:160,height:160};
  assert.equal(occupied.recall(),false);assert.deepEqual(occupied.moved,[]);
  const exit=fixture();exit.setTime(6000);
  exit.state.scene.map.exits.push({x:440,y:440,width:144,height:144});
  assert.equal(exit.recall(),false);assert.deepEqual(exit.moved,[]);
  exit.state.scene.map.exits.length=0;
  exit.state.scene.map.exits.push({x:525,y:465,width:50,height:94});
  assert.equal(exit.recall(),true);
  assert.ok(exit.state.scene.map.exits.every(area=>!overlapsFootRect(exit.moved[0].point,area)));
});

test('recall keeps the same summon and all health, mana, effects, cooldowns and lifetime values',()=>{
  const f=fixture();f.setTime(6000);
  const summon=f.summon,visual=summon.visual,controller=summon.controller;
  const before=structuredClone({resources:f.resources,lifetime:summon.summonRemainingMs,owner:summon.summonedBy});
  assert.equal(f.recall(),true);
  assert.equal(f.arena[0],summon);assert.equal(summon.visual,visual);assert.equal(summon.controller,controller);
  assert.equal(f.moved[0].visual,visual);
  assert.deepEqual({resources:f.resources,lifetime:summon.summonRemainingMs,owner:summon.summonedBy},before);
});

test('world adapters exclude mere selection, approach and a self buff with an old selected target',()=>{
  const f=fixture();f.hostile('unengaged',{x:700,y:700});
  f.selected.set('player','unengaged');f.setTime(600);f.observe();
  assert.deepEqual(f.tactics().engagedTargetIds,[]);
  f.actions.set('player',{state:'approaching',targetId:'unengaged'});f.setTime(1200);f.observe();
  assert.deepEqual(f.tactics().engagedTargetIds,[]);
  f.actions.set('player',{state:'attacking',skill:{id:'demon-s-shield',action:catalog.skills['demon-s-shield'].action!}});
  f.setTime(1800);f.observe();
  assert.deepEqual(f.tactics().engagedTargetIds,[]);
  assert.equal(f.awareness.quietFor(3000),3000);
  f.actions.set('player',{state:'attacking',targetId:'unengaged'});f.setTime(1860);f.observe();
  assert.deepEqual(f.tactics().engagedTargetIds,['unengaged']);
  assert.equal(f.tactics().ownerTargetId,'unengaged');
});

test('world observation preserves the summoners own target when control switches to another member',()=>{
  const f=fixture();f.hostile('owner-target',{x:700,y:700});f.hostile('other-target',{x:800,y:800});
  f.actions.set('player',{state:'attacking',targetId:'owner-target'});
  f.actions.set('companion',{state:'attacking',targetId:'other-target'});
  f.session.party.controlledId='companion';f.setTime(600);f.observe();
  assert.equal(f.tactics().ownerTargetId,'owner-target');
  assert.deepEqual(f.tactics().engagedTargetIds,['owner-target','other-target']);
});
