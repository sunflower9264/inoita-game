import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EnemyController } from '../src/domain/enemy-ai.ts';
import type { EnemyPort } from '../src/domain/enemy-ai.ts';
import type { EnemyBehavior, ResolvedBasicAttack } from '../src/domain/battle.ts';
import type { Combatant } from '../src/domain/combat.ts';
import { attackDistance } from '../src/domain/basic-attack.ts';
import { findPath } from '../src/domain/pathfinding.ts';
import type { Facing } from '../src/domain/content.ts';
import type { Point } from '../src/domain/navigation.ts';

const box={x:-8,y:-8,width:16,height:16};
const attack:ResolvedBasicAttack={frameDurationMs:60,cycleFrames:4,effectiveCycleFrames:4,
  damage:{effect:'physical',source:'bestNormalDamage',attributeWeights:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},ranks:[{fixedAddition:0,operation:{kind:'add',amount:0}}]},
  approachDistanceUnits:2,searchRadiusPx:1,strikeFrame:1,swingFrame:null,swings:[],impacts:[],projectile:null,
  clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'},
  sequence:{north:[0,1,2,3],south:[0,1,2,3],east:[0,1,2,3],west:[0,1,2,3]}};

function setup(overrides:Partial<EnemyBehavior>={},random:()=>number=Math.random) {
  const actor:Combatant={id:'monster',team:'enemy',position:{x:16,y:32},bounds:box};
  const player:Combatant={id:'player',team:'party',position:{x:96,y:32},bounds:box};
  const home={...actor.position};
  let waypoint:Point|undefined,follow:(()=>Point|undefined)|undefined,finish:(()=>void)|undefined,plays=0,checks=0;
  let heading:Facing='south';
  const behavior:EnemyBehavior={aggression:'active',awarenessRangeUnits:12,moveSpeedPxPerSecond:100,canMove:true,canTurn:true,...overrides};
  const port:EnemyPort={cooldowns:new CombatCooldownStore(()=>0).forActor(actor.id),actor:id=>[actor,player].find(a=>a.id===id),candidates:()=>[actor,player],facing:()=>heading,face:facing=>{heading=facing;},
    moveToward:point=>{follow=undefined;waypoint={...point};},followPath:next=>{follow=next;waypoint=next();},stop:()=>{follow=undefined;waypoint=undefined;},home:()=>home,
    navigationBounds:()=>({x:8,y:8,width:144,height:80}),
    canStand:point=>{checks++;return point.x>=8&&point.x<=152&&point.y>=8&&point.y<=88&&!(Math.abs(point.x-player.position.x)<16&&Math.abs(point.y-player.position.y)<16);},
    relocate:point=>{actor.position={...point};},play:(action,_frame,onComplete)=>{plays++;heading=action.facing;finish=onComplete;return ()=>{};},
    frame:()=>{},clearEffects:()=>{}};
  const ai=new EnemyController(actor.id,behavior,attack,port,[],random);
  const advance=(ticks=1)=>{for(let i=0;i<ticks;i++){if(follow)waypoint=follow();if(waypoint){const dx=waypoint.x-actor.position.x,dy=waypoint.y-actor.position.y,d=Math.hypot(dx,dy),step=Math.min(d,behavior.moveSpeedPxPerSecond*.06);if(d)actor.position={x:actor.position.x+dx/d*step,y:actor.position.y+dy/d*step};}ai.update(60);}};
  return {ai,actor,player,port,advance,finish:()=>finish!(),plays:()=>plays,heading:()=>heading,checks:()=>checks,waypoint:()=>waypoint};
}

test('enemies ignore hidden focus and retaliation sources and forget a target entering stealth',()=>{
 const run=setup();run.player.states=['stealthed'];run.port.focusTarget=()=>run.player.id;
 run.ai.update(60);assert.equal(run.ai.snapshot().targetId,undefined);assert.equal(run.waypoint(),undefined);
 run.ai.onContact({casterId:run.player.id,targetId:run.actor.id});
 assert.equal(run.ai.snapshot().targetId,undefined);
 run.player.states=[];run.ai.update(60);assert.equal(run.ai.snapshot().targetId,run.player.id);assert.ok(run.waypoint());
 run.player.states=['stealthed'];run.ai.update(60);
 assert.equal(run.ai.snapshot().targetId,undefined);assert.equal(run.waypoint(),undefined);
 run.player.states=[];run.ai.update(60);assert.equal(run.ai.snapshot().targetId,run.player.id);
});

test('a stealth notification immediately clears enemy target and path before the next logic tick',()=>{
 const run=setup();run.ai.update(60);assert.equal(run.ai.snapshot().targetId,run.player.id);assert.ok(run.waypoint());
 run.player.states=['stealthed'];run.ai.targetRemoved(run.player.id);
 assert.equal(run.ai.snapshot().targetId,undefined);assert.equal(run.waypoint(),undefined);
 assert.equal(run.ai.captureState().pendingReturn,false);assert.equal(run.ai.snapshot().state,'idle');
 run.ai.update(59);assert.equal(run.ai.snapshot().targetId,undefined);
});

test('immobilized or ambushing enemies can strike in range but cannot chase',()=>{
 for(const state of ['immobilized','ambush'] as const){
  const run=setup();run.actor.states=[state];run.ai.update(60);
  assert.equal(run.waypoint(),undefined);assert.equal(run.plays(),0);
  run.player.position={x:32,y:32};run.ai.update(60);assert.equal(run.plays(),1);
 }
});

test('state changes stop existing paths before another decision tick and stun blocks nearby attacks',()=>{
 const run=setup();run.ai.update(60);assert.ok(run.waypoint());
 run.actor.states=['immobilized'];const position={...run.actor.position};run.advance();
 assert.deepEqual(run.actor.position,position);assert.equal(run.waypoint(),undefined);
 run.actor.states=['stun'];run.player.position={x:32,y:32};run.ai.update(60);assert.equal(run.plays(),0);
 run.actor.states=[];run.ai.update(60);assert.equal(run.plays(),1);
});

test('checkpoint restores the remaining idle tick and reconnects a detached wandering path',()=>{
  const run=setup({aggression:'passive',wander:{idleDurationMs:180}},()=>.1);
  run.ai.update(150);const idle=run.ai.captureState();
  assert.equal(idle.idleElapsed,120);assert.equal(idle.accumulator,30);
  run.ai.update(60);assert.equal(run.ai.snapshot().state,'wandering');
  run.ai.restoreState(idle);assert.equal(run.waypoint(),undefined);
  run.ai.update(29);assert.equal(run.ai.snapshot().state,'idle');
  run.ai.update(1);assert.equal(run.ai.snapshot().state,'wandering');
  const wandering=run.ai.captureState(),path=structuredClone(wandering.path);
  run.ai.cancel();assert.equal(run.waypoint(),undefined);
  run.ai.restoreState(wandering);assert.deepEqual(run.waypoint(),path[0]);
  wandering.path[0].x=999;assert.deepEqual(run.ai.captureState().path,path);
  const restored=run.ai.captureState();restored.path.length=0;
  assert.deepEqual(run.ai.captureState().path,path);
});

test('A* routes to an available attack position and refuses diagonal corner cutting',()=>{
  const bounds={x:0,y:0,width:64,height:64};
  const path=findPath({x:8,y:8},{bounds,canStand:p=>!(p.x>=24&&p.x<=32&&p.y<48),
    isGoal:p=>p.x===48&&p.y===8,heuristic:p=>Math.hypot(48-p.x,8-p.y)});
  assert.ok(path);assert.ok(path.some(p=>p.y>=48));assert.deepEqual(path.at(-1),{x:48,y:8});
  assert.equal(findPath({x:0,y:0},{bounds:{x:0,y:0,width:8,height:8},canStand:p=>!(p.x===8&&p.y===0)&&!(p.x===0&&p.y===8),isGoal:p=>p.x===8&&p.y===8,heuristic:()=>0}),null);
  const target={x:40,y:40};
  const ring=findPath({x:0,y:40},{bounds,canStand:p=>!(Math.abs(p.x-40)<16&&Math.abs(p.y-40)<16),
    isGoal:p=>attackDistance(p,box,target,box)<=2,heuristic:p=>Math.max(0,Math.hypot(p.x-40,p.y-40)-32)});
  assert.ok(ring);assert.notDeepEqual(ring.at(-1),target);assert.ok(attackDistance(ring.at(-1)!,box,target,box)<=2);
});

test('a fractional start joins the fixed grid before entering an exactly aligned narrow passage',()=>{
  for(const origin of [{x:0,y:0},{x:3,y:5}]){
    const start={x:origin.x+10.5,y:origin.y+10.25};
    const goal={x:origin.x+32,y:origin.y+56};
    const path=findPath(start,{bounds:{...origin,width:64,height:64},
      canStand:point=>point.y<=origin.y+16||point.x===goal.x,
      isGoal:point=>point.x===goal.x&&point.y===goal.y,heuristic:point=>Math.hypot(goal.x-point.x,goal.y-point.y)});
    assert.ok(path);assert.deepEqual(path.at(-1),goal);
    assert.ok(path.every(point=>(point.x-origin.x)%8===0&&(point.y-origin.y)%8===0));
    assert.ok(path.filter(point=>point.y>origin.y+16).every(point=>point.x===goal.x));
    assert.deepEqual(start,{x:origin.x+10.5,y:origin.y+10.25},'the caller keeps the real unsnapped position');
  }
});

test('a start beside a wall cannot snap through it and an already valid start needs no grid connection',()=>{
  const start={x:14,y:10},bounds={x:0,y:0,width:40,height:32};
  const canStand=(point:Point)=>point.x<15||point.x>23;
  assert.equal(findPath(start,{bounds,canStand,isGoal:point=>point.x===32&&point.y===8,heuristic:point=>Math.hypot(32-point.x,8-point.y)}),null);
  const path=findPath(start,{bounds,canStand,isGoal:point=>point.x===0&&point.y===8,heuristic:point=>Math.hypot(point.x,point.y-8)});
  assert.ok(path);assert.ok(path.every(point=>point.x<15));assert.deepEqual(path.at(-1),{x:0,y:8});
  assert.deepEqual(findPath(start,{bounds,canStand,isGoal:point=>point.x===14&&point.y===10,heuristic:()=>0}),[]);
});

test('active enemies detect at quantized range, chase with A*, and attack without player search bias',()=>{
  const run=setup();run.player.position.x=120;
  run.ai.update(59);assert.equal(run.ai.snapshot().state,'idle');
  run.ai.update(1);assert.equal(run.ai.snapshot().state,'idle','104 pixels is outside 12 units');
  run.player.position.x=119;run.advance();assert.equal(run.ai.snapshot().state,'chasing','103 pixels is inside 12 units');
  run.advance(50);assert.equal(run.ai.snapshot().state,'attacking');assert.equal(run.plays(),1);
  assert.equal(run.waypoint(),undefined);run.finish();run.advance();assert.equal(run.plays(),2);
});

test('passive enemies activate only on opposing contact and fixed enemies preserve their facing',()=>{
  const run=setup({aggression:'passive',canMove:false,canTurn:false,moveSpeedPxPerSecond:0});
  run.player.position={x:32,y:32};run.advance(3);assert.equal(run.plays(),0);
  run.ai.onContact({casterId:'monster',targetId:'monster'});run.advance();assert.equal(run.plays(),0);
  run.ai.onContact({casterId:'player',targetId:'monster'});run.advance();
  assert.equal(run.plays(),1);assert.equal(run.heading(),'south');assert.equal(run.waypoint(),undefined);
});

test('disabling an enemy stops its action while retaining the selected target',()=>{
  const run=setup();run.advance();assert.equal(run.ai.snapshot().targetId,'player');
  run.ai.disable();assert.equal(run.ai.snapshot().targetId,'player');
  assert.equal(run.waypoint(),undefined);
});

test('an attack finishes after losing detection, then returns home without reacting during the return',()=>{
  const run=setup();run.advance(40);assert.equal(run.ai.snapshot().state,'attacking');
  const attackAt={...run.actor.position};run.player.position={x:1000,y:1000};run.advance();
  assert.equal(run.ai.snapshot().state,'attacking');run.finish();run.advance();assert.equal(run.ai.snapshot().state,'returning');
  run.player.position={x:attackAt.x+16,y:attackAt.y};run.ai.onContact({casterId:'player',targetId:'monster'});
  run.advance();assert.equal(run.ai.snapshot().state,'returning');assert.equal(run.plays(),1);
  run.player.position={x:1000,y:1000};run.advance(45);
  assert.deepEqual(run.actor.position,{x:16,y:32});assert.equal(run.ai.snapshot().state,'idle');
});

test('unreachable targets back off 180 ms while chasing, then resume after an obstruction moves',()=>{
  const run=setup();let blocked=true,calls=0;
  const original=run.port.canStand;run.port.canStand=point=>{calls++;return !blocked&&original(point);};
  run.advance();const first=calls;assert.ok(first>0);assert.equal(run.waypoint(),undefined);
  // 追活人时按重寻路间隔退避（180 毫秒 = 3 帧），退避期内不再撞同一堵墙。
  run.advance(2);assert.equal(calls,first,'180 毫秒退避期内不重试');
  blocked=false;
  run.advance(2);assert.ok(run.waypoint(),'退避结束后重新寻路');
  run.ai.cancel();assert.equal(run.ai.snapshot().state,'idle');assert.equal(run.waypoint(),undefined);
  run.ai.dispose();run.advance(3);assert.equal(run.plays(),0);
});

test('a cross-frame search spends the shared budget and waits for a path when the straight line is blocked',()=>{
  // 移动速度放到接近 0：只看搜索期间是否原地等、完成后是否换用路径点。
  const run=setup({moveSpeedPxPerSecond:1});let grants=0;
  run.port.pathBudget={take:limit=>{grants++;return Math.min(limit,4);}};
  run.advance();
  assert.ok(grants>0,'从共享预算领取扩展');
  // 直线走不通时不能硬撞墙；先原地等，等路径算完再走。
  assert.equal(run.waypoint(),undefined,'直线被挡时原地等');
  for(let frame=0;frame<400&&run.waypoint()===undefined;frame++)run.advance();
  const next=run.waypoint();
  assert.ok(next&&next.x!==run.player.position.x,'搜索完成后改走路径点');
});

test('a body stalled by physics replans after 180 ms even when the next segment remains clear',()=>{
  const run=setup();let queries=0;
  run.port.navigationBounds=()=>{queries++;return {x:8,y:8,width:144,height:80};};
  run.ai.update(60);assert.equal(queries,1);assert.ok(run.waypoint());
  // 不推进实体坐标，模拟物理碰撞或其他角色把它挤在原地。
  run.ai.update(120);assert.equal(queries,1);
  run.ai.update(60);assert.equal(queries,2);
  run.ai.update(120);assert.equal(queries,2);run.ai.update(60);assert.equal(queries,3);
});

test('A* shares spatial checks within one search and refreshes them for the next search',()=>{
  let blocked=false;const counts=new Map<string,number>();
  const query={bounds:{x:0,y:0,width:32,height:32},
    canStand:(point:Point)=>{const key=`${point.x},${point.y}`;counts.set(key,(counts.get(key)??0)+1);return !blocked;},
    isGoal:(point:Point)=>point.x===32&&point.y===32,heuristic:(point:Point)=>Math.hypot(32-point.x,32-point.y)};
  assert.ok(findPath({x:0,y:0},query));assert.ok(counts.size>1);assert.ok([...counts.values()].every(count=>count===1));
  blocked=true;counts.clear();assert.equal(findPath({x:0,y:0},query),null);
});

function wandering(values:number[],overrides:Partial<EnemyBehavior>={}) {
  let calls=0;
  const run=setup({aggression:'passive',wander:{idleDurationMs:240},...overrides},()=>values[calls++]??.99);
  run.actor.position={x:64,y:40};run.player.position={x:1000,y:1000};
  return {...run,randomCalls:()=>calls};
}

test('wandering waits for the native idle cycle and uses the move/turn probability boundaries',()=>{
  for(const [move,turn,state,heading] of [
    [.29,.49,'wandering','west'],[.29,.5,'wandering','south'],
    [.3,.29,'idle','west'],[.3,.3,'idle','south'],
  ] as const){
    const run=wandering([move,turn,0,0]);
    run.advance(3);assert.equal(run.randomCalls(),0);assert.equal(run.ai.snapshot().state,'idle');
    run.advance();assert.equal(run.ai.snapshot().state,state);assert.equal(run.heading(),heading);
    assert.equal(run.randomCalls(),state==='wandering'?4:2);
  }
});

test('wandering distances use the integer average of two 1–4 rolls, then resume idle',()=>{
  const counts=new Map<number,number>();
  for(let first=1;first<=4;first++)for(let second=1;second<=4;second++){
    const run=wandering([0,.99,(first-1)/4,(second-1)/4]);run.advance(4);
    const distance=Math.floor((first+second)/2)*8;
    for(let i=0;i<20&&run.ai.snapshot().state==='wandering';i++)run.advance();
    assert.deepEqual(run.actor.position,{x:64,y:40+distance});
    assert.equal(run.ai.snapshot().state,'idle');assert.equal(run.waypoint(),undefined);
    assert.equal(run.randomCalls(),4,'walking must not draw another destination');
    run.advance(3);assert.equal(run.randomCalls(),4,'restart a full idle period after arrival');
    counts.set(distance,(counts.get(distance)??0)+1);
  }
  assert.deepEqual([...counts],[[8,3],[16,7],[24,5],[32,1]]);
});

test('blocked wandering keeps its chosen facing and retries only after another idle cycle',()=>{
  const run=wandering([0,0,0,0]);run.port.canStand=()=>false;
  run.advance(4);assert.equal(run.ai.snapshot().state,'idle');assert.equal(run.heading(),'west');
  assert.equal(run.waypoint(),undefined);assert.equal(run.randomCalls(),4);
  run.advance(3);assert.equal(run.randomCalls(),4);run.advance();assert.equal(run.randomCalls(),6);
});

test('ordinary wandering is interrupted by contact or detection; return and disable reset the idle timer',()=>{
  for(const aggression of ['active','passive'] as const){
    const run=wandering([0,.99,.99,.99],{aggression});run.advance(5);
    assert.equal(run.ai.snapshot().state,'wandering');
    run.player.position={x:120,y:40};
    if(aggression==='passive')run.ai.onContact({casterId:'player',targetId:'monster'});
    run.advance();assert.equal(run.ai.snapshot().state,'chasing');assert.equal(run.ai.snapshot().targetId,'player');
    assert.ok(run.waypoint()!.x>run.actor.position.x,'chase replaces the southbound wander path');
    run.player.position={x:1000,y:1000};run.advance();assert.equal(run.ai.snapshot().state,'returning');
    for(let i=0;i<40&&run.ai.snapshot().state==='returning';i++)run.advance();
    assert.deepEqual(run.actor.position,{x:16,y:32});assert.equal(run.ai.snapshot().state,'idle');
    run.advance(3);assert.equal(run.randomCalls(),4);
    run.ai.disable();run.advance(3);assert.equal(run.randomCalls(),4);
  }
});

test('fixed actors and actors without explicit wander configuration remain still',()=>{
  for(const overrides of [{canMove:false,canTurn:false},{wander:undefined},{aggression:'none'}] as Partial<EnemyBehavior>[]){
    const run=wandering([0,0,0,0],overrides);run.advance(50);
    assert.deepEqual(run.actor.position,{x:64,y:40});assert.equal(run.randomCalls(),0);
  }
});

test('a moving wanderer stops when its route is blocked and cancellation clears its callback',()=>{
  const run=wandering([0,.99,.99,.99]);let next:(()=>Point|undefined)|undefined;
  const follow=run.port.followPath;run.port.followPath=callback=>{next=callback;follow(callback);};
  run.advance(4);assert.ok(next?.());run.port.canStand=()=>false;
  assert.equal(next?.(),undefined);run.advance();assert.equal(run.ai.snapshot().state,'idle');
  run.ai.cancel();assert.equal(next?.(),undefined);run.ai.dispose();assert.equal(next?.(),undefined);
});
