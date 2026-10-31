import test from 'node:test';
import assert from 'node:assert/strict';
import { FriendlySummonController, friendlySummonStationaryState, type FriendlySummonPort, type FriendlySummonRole, type FriendlySummonTactics } from '../src/domain/friendly-summon-ai.ts';
import { CombatCooldownStore } from '../src/domain/combat-cooldowns.ts';
import type { ActionPlayback, Combatant } from '../src/domain/combat.ts';
import type { EnemyBehavior, ResolvedBasicAttack } from '../src/domain/battle.ts';
import type { GameRectangle, Point } from '../src/domain/navigation.ts';

const box={x:-8,y:-8,width:16,height:16};
const attack:ResolvedBasicAttack={frameDurationMs:60,cycleFrames:15,effectiveCycleFrames:15,
  damage:{effect:'physical',source:'bestNormalDamage',attributeWeights:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},ranks:[{fixedAddition:0,operation:{kind:'add',amount:0}}]},
  approachDistanceUnits:4,searchRadiusPx:64,strikeFrame:8,swingFrame:null,swings:[],impacts:[],projectile:null,
  clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'},
  sequence:{north:Array(15).fill(0),south:Array(15).fill(0),east:Array(15).fill(0),west:Array(15).fill(0)}};
const defaultBehavior:EnemyBehavior={aggression:'active',awarenessRangeUnits:8,moveSpeedPxPerSecond:133.33333333333334,canMove:true,canTurn:true};

function setup(role:FriendlySummonRole='hell-soldier',id='summon',behaviorOverrides:Partial<EnemyBehavior>={}) {
  const behavior:EnemyBehavior={...defaultBehavior,...behaviorOverrides};
  const owner:Combatant={id:'owner',team:'party',position:{x:0,y:0},bounds:box};
  const actor:Combatant={id,team:'party',position:{x:48,y:0},bounds:box};
  const actors=[owner,actor];
  const vitals=new Map<string,{current:number;maximum:number}>([['owner',{current:100,maximum:100}]]);
  let tactics:FriendlySummonTactics={engagedTargetIds:[],threats:[],partyIds:['owner']};
  let autonomous:(id:string)=>boolean=()=>true;
  let bounds:GameRectangle={x:-128,y:-128,width:768,height:256};
  let blocked:(point:Point)=>boolean=()=>false;
  let follow:(()=>Point|undefined)|undefined;
  let time=0,recalls=0,allowedRecall=false,paused=false,searches=0,interruptions=0;
  const actions:ActionPlayback[]=[];
  let playback:{action:ActionPlayback;frame:(index:number)=>void;complete:()=>void;index:number}|undefined;
  const stand=(point:Point)=>!blocked(point)&&!actors.some(other=>other!==actor&&Math.abs(other.position.x-point.x)<16&&Math.abs(other.position.y-point.y)<16);
  const port:FriendlySummonPort={
    cooldowns:new CombatCooldownStore(()=>Math.floor(time/60)).forActor(id),isPaused:()=>paused,
    actor:key=>actors.find(item=>item.id===key),candidates:()=>actors,isAlive:key=>actors.some(item=>item.id===key),
    health:key=>vitals.get(key),facing:()=> 'south',moveToward:()=>assert.fail('budgeted pathfinding must own movement'),
    followPath:next=>{follow=next;},stop:()=>{follow=undefined;},home:()=>({x:48,y:0}),
    navigationBounds:()=>bounds,canStand:stand,navigationSnapshot:()=>{
      searches++;
      const positions=actors.filter(other=>other!==actor).map(other=>({...other.position}));
      const obstacle=blocked;
      return {bounds:{...bounds},start:{...actor.position},canStand:point=>!obstacle(point)&&!positions.some(position=>Math.abs(position.x-point.x)<16&&Math.abs(position.y-point.y)<16)};
    },
    tactics:()=>tactics,tryRecall:()=>{recalls++;if(!allowedRecall)return false;actor.position={x:32,y:0};return true;},
    autonomousTarget:id=>autonomous(id),
    relocate:point=>{actor.position={...point};},
    play:(action,frame,complete)=>{
      actions.push(action);const active={action,frame,complete,index:0};playback=active;
      return ()=>{if(playback===active){interruptions++;playback=undefined;}};
    },frame:()=>{},clearEffects:()=>{},
  };
  const ai=new FriendlySummonController(id,owner.id,role,behavior,attack,port);
  const enemy=(key:string,position:Point)=>{const result:Combatant={id:key,team:'enemy',position:{...position},bounds:box};actors.push(result);return result;};
  const advance=(ticks=1,move=true)=>{for(let i=0;i<ticks;i++){
    time+=60;
    if(move){const next=follow?.();if(next){const dx=next.x-actor.position.x,dy=next.y-actor.position.y,length=Math.hypot(dx,dy),step=Math.min(length,8);if(length)actor.position={x:actor.position.x+dx/length*step,y:actor.position.y+dy/length*step};}}
    if(playback){const active=playback;active.frame(++active.index);if(active.index>=15&&playback===active){playback=undefined;active.complete();}}
    ai.step();
  }};
  return {ai,actor,owner,actors,vitals,enemy,advance,actions,
    setTactics:(value:Partial<FriendlySummonTactics>)=>{tactics={...tactics,...value};},
    setBounds:(value:GameRectangle)=>{bounds=value;},setBlocked:(value:(point:Point)=>boolean)=>{blocked=value;},
    allowRecall:()=>{allowedRecall=true;},setPaused:(value:boolean)=>{paused=value;},
    setAutonomousTarget:(value:(id:string)=>boolean)=>{autonomous=value;},
    recalls:()=>recalls,searches:()=>searches,interruptions:()=>interruptions,next:()=>follow?.()};
}

test('active friendly summons notice an enemy inside their own eight-unit awareness without an engagement signal',()=>{
  for(const role of ['hell-soldier','beast'] as const){
    const run=setup(role),enemy=run.enemy('noticed',{x:119,y:0});
    run.advance(20);
    assert.equal(run.ai.snapshot().targetId,enemy.id,`${role} 应主动发现警戒范围内的敌人`);
    assert.ok(run.actions.length>0,`${role} 应实际起手`);
  }
});

test('owner selection and focus alone never admit an enemy outside the summon own awareness',()=>{
  const run=setup(),enemy=run.enemy('outside-sight',{x:120,y:0});
  run.setTactics({ownerTargetId:enemy.id,focusTargetId:enemy.id});run.advance(20);
  assert.equal(run.ai.snapshot().targetId,undefined);
  assert.equal(run.actions.length,0);
  run.setTactics({engagedTargetIds:[enemy.id]});run.advance(12);
  assert.equal(run.ai.snapshot().targetId,enemy.id);
});

test('autonomous acquisition still respects the 128px owner leash',()=>{
  const run=setup();run.actor.position={x:80,y:0};
  run.enemy('far-from-owner',{x:151,y:0}); // 距召唤物 71px（警戒内），距主人 151px
  for(let frame=0;frame<20;frame++)run.advance(1,false);
  assert.equal(run.ai.snapshot().targetId,undefined);
  assert.equal(run.actions.length,0);
});

test('passive friendly summons do not self-acquire but still join engaged combat',()=>{
  const run=setup('hell-soldier','summon',{aggression:'passive'}),enemy=run.enemy('nearby',{x:119,y:0});
  run.advance(20);
  assert.equal(run.ai.snapshot().targetId,undefined);
  assert.equal(run.actions.length,0);
  run.setTactics({engagedTargetIds:[enemy.id]});run.advance(12);
  assert.equal(run.ai.snapshot().targetId,enemy.id);
});

test('autonomous acquisition never opens display-only scenery',()=>{
  const run=setup(),prop=run.enemy('crate',{x:119,y:0});
  run.setAutonomousTarget(id=>id!==prop.id);run.advance(20);
  assert.equal(run.ai.snapshot().targetId,undefined);
  assert.equal(run.actions.length,0);
});

test('friendly summons follow their real owner through paths instead of returning to their spawn',()=>{
  const run=setup();run.owner.position={x:220,y:0};run.advance();
  assert.equal(run.ai.snapshot().state,'following');run.advance(8);assert.ok(run.next(),JSON.stringify(run.ai.captureState()));
  run.advance(50);assert.ok(Math.hypot(run.actor.position.x-run.owner.position.x,run.actor.position.y-run.owner.position.y)<=64);
  assert.ok(run.actor.position.x>150);assert.equal(run.recalls(),0);
});

test('completed follow paths keep a safe useful prefix when their owner keeps moving',()=>{
  const run=setup();run.owner.position={x:220,y:0};
  for(let frame=0;frame<35;frame++){run.owner.position.x+=8;run.advance();}
  assert.ok(run.actor.position.x>160,'moving goals must not discard every completed route');
  assert.equal(run.recalls(),0);
});

test('a continuously moving committed enemy does not invalidate every multi-frame pursuit route',()=>{
  const run=setup();run.actor.position={x:-80,y:0};
  const target=run.enemy('moving',{x:124,y:0});run.setBlocked(point=>point.x>=32&&point.x<=48&&Math.abs(point.y)<=64);
  run.setTactics({engagedTargetIds:[target.id],ownerTargetId:target.id});
  let sawPending=false;
  for(let frame=0;frame<35;frame++){
    target.position={x:100+Math.cos(frame*.25)*24,y:Math.sin(frame*.25)*24};run.advance();
    sawPending ||= run.ai.snapshot().searchPending;assert.ok(run.ai.snapshot().expandedNodes<=64);
  }
  assert.equal(sawPending,true);assert.equal(run.ai.snapshot().targetId,target.id);
  assert.ok(Math.hypot(run.actor.position.x+80,run.actor.position.y)>32,'a safe completed prefix should advance pursuit');
});

test('stable summon identities prefer different nearby follow positions',()=>{
  const landings=[];
  for(const id of ['summon-a','summon-b','summon-c']){
    const run=setup('hell-soldier',id);run.actor.position={x:100,y:0};run.advance(12,false);
    const landing=run.ai.captureState().path.at(-1);assert.ok(landing);landings.push(`${landing.x.toFixed(2)},${landing.y.toFixed(2)}`);
  }
  assert.equal(new Set(landings).size,3);
});

test('stable summon identities approach different attack positions when they need a route',()=>{
  const landings=[];
  for(const id of ['summon-a','summon-b','summon-c']){
    const run=setup('hell-soldier',id);run.actor.position={x:-100,y:0};const target=run.enemy('target',{x:100,y:0});
    run.setTactics({engagedTargetIds:[target.id]});run.advance(20,false);
    const landing=run.ai.captureState().path.at(-1);assert.ok(landing);landings.push(`${landing.x.toFixed(2)},${landing.y.toFixed(2)}`);
  }
  assert.equal(new Set(landings).size,3);
});

test('an unreachable preferred attack side falls back to the ordinary attack band before blacklisting the enemy',()=>{
  const run=setup();run.actor.position={x:0,y:0};run.owner.position={x:-32,y:0};const target=run.enemy('target',{x:64,y:0});
  run.setBounds({x:-48,y:-32,width:160,height:64});run.setBlocked(point=>point.x>=72&&point.x<=80);
  run.setTactics({engagedTargetIds:[target.id]});run.advance(30,false);
  assert.equal(run.ai.snapshot().targetId,target.id);assert.ok(run.ai.captureState().path.length>0);
  assert.equal(run.ai.captureState().failedTargets.some(entry=>entry.id===target.id),false);
});

test('hell soldiers assist the owner while beasts prioritize the attacker threatening the owner',()=>{
  for(const role of ['hell-soldier','beast'] as const){
    const run=setup(role),focus=run.enemy('owner-target',{x:72,y:16}),danger=run.enemy('danger',{x:48,y:32});
    run.setTactics({engagedTargetIds:[focus.id,danger.id],ownerTargetId:focus.id,threats:[{enemyId:danger.id,targetId:'owner'}]});
    run.advance();assert.equal(run.ai.snapshot().targetId,role==='hell-soldier'?focus.id:danger.id);
    assert.equal(run.actions.length,1);
  }
});

test('an endangered owner overrides routine damage targets for either role',()=>{
  for(const role of ['hell-soldier','beast'] as const){
    const run=setup(role),focus=run.enemy('focus',{x:72,y:16}),danger=run.enemy('danger',{x:48,y:32});
    run.vitals.set('owner',{current:30,maximum:100});
    run.setTactics({engagedTargetIds:[focus.id,danger.id],ownerTargetId:focus.id,threats:[{enemyId:danger.id,targetId:'owner'}]});
    run.advance();assert.equal(run.ai.snapshot().targetId,danger.id);
  }
});

test('beasts keep an enemy already attacking them before ordinary owner focus',()=>{
  const run=setup('beast'),focus=run.enemy('focus',{x:72,y:16}),tanked=run.enemy('tanked',{x:48,y:32});
  run.setTactics({engagedTargetIds:[focus.id,tanked.id],ownerTargetId:focus.id,threats:[{enemyId:tanked.id,targetId:'summon'}]});
  run.advance();assert.equal(run.ai.snapshot().targetId,tanked.id);
});

test('higher priority changes wait for the complete attack cycle rather than its strike frame',()=>{
  const run=setup(),first=run.enemy('first',{x:72,y:16}),second=run.enemy('second',{x:48,y:32});
  run.setTactics({engagedTargetIds:[first.id,second.id],ownerTargetId:first.id});run.advance();
  run.setTactics({ownerTargetId:second.id});run.advance(9);
  assert.equal(run.ai.snapshot().targetId,first.id);assert.equal(run.actions.length,1);assert.equal(run.interruptions(),0);
  run.advance(6);assert.equal(run.ai.snapshot().targetId,second.id);assert.equal(run.actions.length,2);assert.equal(run.interruptions(),0);
});

test('hard return takes precedence over enemy selection and resumes only within 64 pixels',()=>{
  const run=setup(),enemy=run.enemy('enemy',{x:72,y:0});
  run.setTactics({engagedTargetIds:[enemy.id],ownerTargetId:enemy.id});run.advance();
  run.owner.position={x:260,y:0};run.advance();assert.equal(run.ai.snapshot().targetId,undefined);
  assert.equal(run.actions.length,1,'the active attack is allowed to finish');
  run.advance(14);assert.equal(run.ai.snapshot().state,'returning');assert.equal(run.actions.length,1);
  run.actor.position={x:180,y:0};run.advance(3,false);assert.equal(run.ai.snapshot().state,'returning');
  run.actor.position={x:200,y:0};run.advance(3,false);assert.notEqual(run.ai.snapshot().state,'returning');
});

test('target ranges distinguish autonomous protection from a committed ranged-owner target',()=>{
  const ordinary=setup();const far=ordinary.enemy('far',{x:150,y:0});ordinary.setTactics({engagedTargetIds:[far.id]});ordinary.advance();
  assert.equal(ordinary.ai.snapshot().targetId,undefined);assert.equal(ordinary.searches(),0);
  ordinary.setTactics({ownerTargetId:far.id});ordinary.advance(15);assert.equal(ordinary.ai.snapshot().targetId,far.id);
});

test('pending searches use at most 64 expanded nodes per frame and cannot count as a stuck follower',()=>{
  const run=setup();run.actor.position={x:80,y:0};run.setBounds({x:-512,y:-512,width:1024,height:1024});
  run.setBlocked(point=>point.x>=32&&point.x<=48);
  for(let i=0;i<84;i++){
    run.advance(1,false);assert.ok(run.ai.snapshot().expandedNodes<=64);
    assert.equal(run.ai.captureState().followUnreachable,false);
    assert.equal(run.ai.captureState().stuckElapsed,0);
  }
  assert.equal(run.ai.snapshot().searchPending,true);assert.equal(run.recalls(),0);
});

test('an unreachable preferred enemy is cached and a reachable next candidate is tried',()=>{
  const run=setup(),blocked=run.enemy('a-blocked',{x:112,y:0}),near=run.enemy('b-reachable',{x:48,y:32});
  run.setBounds({x:-32,y:-32,width:192,height:80});run.setBlocked(point=>point.x>=80&&point.x<=88);
  run.setTactics({engagedTargetIds:[blocked.id,near.id],ownerTargetId:blocked.id});
  run.advance(10,false);assert.equal(run.ai.snapshot().targetId,near.id);assert.ok(run.actions.length>0);
  assert.ok(run.ai.captureState().failedTargets.some(entry=>entry.id===blocked.id));
});

test('far followers attempt recovery only after 5040 milliseconds and keep safety authority in the world',()=>{
  const run=setup();run.owner.position={x:500,y:0};
  run.advance(83,false);assert.equal(run.recalls(),0);run.advance(1,false);assert.equal(run.recalls(),1);
  assert.ok(run.actor.position.x<100,'an unsafe world response cannot teleport the summon');
  run.allowRecall();run.advance(3,false);assert.equal(run.recalls(),2);assert.deepEqual(run.actor.position,{x:32,y:0});
  assert.equal(run.ai.captureState().farElapsed,0);
});

test('a fully proven short-distance blocked route can recover without the 320 pixel distance gate',()=>{
  const run=setup();run.actor.position={x:80,y:0};run.setBounds({x:-16,y:-16,width:112,height:32});
  run.setBlocked(point=>point.x>=32&&point.x<=48);run.allowRecall();
  run.advance(83,false);assert.equal(run.recalls(),0);run.advance(4,false);assert.ok(run.recalls()>=1);
  assert.deepEqual(run.actor.position,{x:32,y:0});
});

test('a summon blocked within 64 pixels of its owner still recalls after the delay',()=>{
  const run=setup();run.actor.position={x:56,y:0};run.setBounds({x:-16,y:-16,width:96,height:32});
  run.setBlocked(point=>point.x>=24&&point.x<=40);run.allowRecall();
  let recalledAt=0;
  for(let frame=0;frame<220;frame++){
    run.advance(1,false);
    if(run.recalls()){recalledAt=frame+1;break;}
  }
  assert.ok(recalledAt>=80,`贴身卡住也要完整等待，实际第 ${recalledAt} 帧`);
  assert.ok(recalledAt<140,`贴身卡住不能无限等待，实际第 ${recalledAt} 帧`);
  assert.deepEqual(run.actor.position,{x:32,y:0});
});

test('a summon idling beside its owner never recalls',()=>{
  const run=setup();run.actor.position={x:16,y:0};run.allowRecall();run.advance(220,false);
  assert.equal(run.recalls(),0);
});

test('proven unreachable follow goals retain their evidence across repeated budgeted searches',()=>{
  const run=setup();run.actor.position={x:80,y:0};run.setBounds({x:-256,y:-256,width:512,height:512});
  run.setBlocked(point=>point.x>=32&&point.x<=48);run.allowRecall();
  let firstFailure=0,firstRecall=0;
  for(let frame=0;frame<220;frame++){
    run.advance(1,false);const state=run.ai.captureState();
    if(!firstFailure&&state.followUnreachable)firstFailure=state.clock;
    if(!firstFailure){assert.equal(state.stuckElapsed,0);assert.equal(run.recalls(),0);}
    if(run.recalls()){firstRecall=state.clock;break;}
  }
  assert.ok(firstFailure>60,'the initial search must actually span many budgeted frames');
  assert.ok(firstRecall>=firstFailure+4980);assert.ok(firstRecall<13000,'rechecks must not repeatedly erase proven failure');
});

test('immobilization, stun, and paused time cannot manufacture recovery eligibility',()=>{
  for(const state of ['immobilized','stun'] as const){
    const run=setup();run.owner.position={x:500,y:0};run.actor.states=[state];run.advance(100,false);
    assert.equal(run.recalls(),0);assert.equal(run.ai.captureState().farElapsed,0);assert.equal(run.ai.captureState().stuckElapsed,0);
  }
  const paused=setup();paused.owner.position={x:500,y:0};paused.setPaused(true);paused.advance(100,false);
  assert.equal(paused.ai.captureState().clock,0);assert.equal(paused.recalls(),0);
});

test('captured paths and memories are detached, and stationary saves discard transient decisions',()=>{
  const run=setup();run.owner.position={x:220,y:0};run.advance(9);
  const saved=run.ai.captureState();assert.ok(saved.path.length>0);saved.path[0].x=999;
  assert.notEqual(run.ai.captureState().path[0].x,999);
  const stable=friendlySummonStationaryState(run.ai.captureState());
  assert.equal(stable.ownerId,'owner');assert.equal(stable.role,'hell-soldier');assert.equal(stable.state,'idle');assert.deepEqual(stable.path,[]);
  assert.equal(stable.clock,0);assert.equal(stable.targetId,undefined);assert.equal(stable.followActive,false);assert.equal(stable.followSlot,0);
  run.ai.restoreState(stable);assert.equal(run.ai.snapshot().searchPending,false);assert.equal(run.next(),undefined);
  assert.throws(()=>run.ai.restoreState({...stable,ownerId:'somebody-else'}),/主人/);
});

test('an equal-priority closer target cannot replace a valid target before the hold expires',()=>{
  const run=setup();run.actor.position={x:-80,y:0};
  const first=run.enemy('first',{x:104,y:0});run.setTactics({engagedTargetIds:[first.id]});run.advance(7,false);
  assert.equal(run.ai.snapshot().targetId,first.id);
  const second=run.enemy('second',{x:-56,y:24});run.setTactics({engagedTargetIds:[first.id,second.id]});
  const chosenAt=run.ai.captureState().targetSince;
  while(run.ai.captureState().clock-chosenAt<540){run.advance(1,false);assert.equal(run.ai.snapshot().targetId,first.id);}
  run.advance(4,false);assert.equal(run.ai.snapshot().targetId,second.id);
});

test('an equal-priority alternative that saves less than 32 route pixels does not cause churn',()=>{
  const run=setup();run.actor.position={x:-80,y:0};
  const first=run.enemy('first',{x:104,y:0});run.setTactics({engagedTargetIds:[first.id]});run.advance(7,false);
  const second=run.enemy('second',{x:98,y:16});run.setTactics({engagedTargetIds:[first.id,second.id]});run.advance(35,false);
  assert.equal(run.ai.snapshot().targetId,first.id);assert.equal(run.actions.length,0);
  assert.ok(run.ai.captureState().checkedTargets.some(entry=>entry.id===second.id));
});

test('beasts distinguish the 35 percent low-health ally threshold from ordinary owner focus',()=>{
  for(const health of [35,36]){
    const run=setup('beast'),normal=run.enemy('normal',{x:72,y:16}),danger=run.enemy('danger',{x:48,y:32});
    run.actors.push({id:'ally',team:'party',position:{x:0,y:40},bounds:box});run.vitals.set('ally',{current:health,maximum:100});
    run.setTactics({engagedTargetIds:[normal.id,danger.id],ownerTargetId:normal.id,partyIds:['owner','ally'],threats:[{enemyId:danger.id,targetId:'ally'}]});
    run.advance();assert.equal(run.ai.snapshot().targetId,health===35?danger.id:normal.id);
  }
});
