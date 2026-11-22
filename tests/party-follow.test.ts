import assert from 'node:assert/strict';
import test from 'node:test';
import {PartyFollow} from '../src/domain/party-follow.ts';
import type {PartyPort} from '../src/domain/party-ai.ts';
import type {Point} from '../src/domain/navigation.ts';
import {PathBudget} from '../src/domain/path-budget.ts';
import {NavigationWorld} from '../src/domain/navigation-world.ts';
import {canTraverse} from '../src/domain/pathfinding.ts';

function setup(blocked=(_p:Point)=>false){
  const bounds={x:-8,y:-8,width:16,height:16};
  const actor={id:'ally',team:'party',position:{x:64,y:176},bounds},leader={id:'hero',team:'party',position:{x:128,y:128},bounds};
  const budget=new PathBudget(512);let next:(()=>Point|undefined)|undefined,rescues=0,scale=1;
  const free=(p:Point)=>p.x>=8&&p.x<=1000&&p.y>=8&&p.y<=1000&&!blocked(p);
  const port={actor:()=>actor,followSlot:()=>0,leaderFacing:()=>'east' as const,canStand:free,navigationBounds:()=>({x:0,y:0,width:1024,height:1024}),
    pathBudget:budget,followPath:(callback:()=>Point|undefined,speed=1)=>{next=callback;scale=speed;},stop:()=>{next=undefined;},
    regroup:()=>{rescues++;actor.position={...leader.position};return true;}} as unknown as PartyPort;
  const follower=new PartyFollow(actor.id,port);
  const step=(move=true)=>{budget.reset();follower.tick(actor,leader,60);follower.move(actor,leader,'support',60);
    const p=next?.();if(p&&move){const dx=p.x-actor.position.x,dy=p.y-actor.position.y,d=Math.hypot(dx,dy),n=Math.min(d,6*scale);if(d)actor.position={x:actor.position.x+dx/d*n,y:actor.position.y+dy/d*n};}};
  return {actor,leader,follower,port,step,rescues:()=>rescues};
}

function setupOccupiedFollow(
  blockerBounds={x:-8,y:-8,width:16,height:16},
  navigation=new NavigationWorld({name:'occupied follow route',bounds:{x:0,y:0,width:320,height:240}}),
){
  const run=setup();
  run.actor.position={x:40,y:120};
  run.leader.position={x:220,y:120};
  const self={
    position:()=>run.actor.position,
    shape:()=>({collision:run.actor.bounds}),
    enabled:()=>true,
    faction:()=>'party' as const,
  };
  navigation.register(self);
  navigation.register({
    position:()=>run.leader.position,
    shape:()=>({collision:run.leader.bounds}),
    enabled:()=>true,
    faction:()=>'party',
  });
  const blocker={position:{x:88,y:120}};
  navigation.register({
    position:()=>blocker.position,
    shape:()=>({collision:blockerBounds}),
    enabled:()=>true,
    faction:()=>'hostile',
  });
  run.port.canStand=point=>navigation.canStand(self,point);
  run.port.navigationBounds=()=>navigation.bounds;
  run.port.navigationSnapshot=()=>navigation.captureStandability(self);
  run.port.followNavigationSnapshot=()=>navigation.captureStandability(self,true);
  return {...run,blocker};
}

test('wall-hidden support formation walks to its leader without rescue',()=>{
  const f=setup(p=>p.x>=32&&p.x<=112&&p.y>=48&&p.y<=144);
  for(let i=0;i<100;i++)f.step();
  assert(Math.hypot(f.actor.position.x-128,f.actor.position.y-128)<=24);assert.equal(f.rescues(),0);
});
test('a moving leader is followed continuously without path searches on open ground',()=>{
  const f=setup();f.actor.position={x:80,y:128};
  for(let i=0;i<120;i++){f.leader.position.x+=5;f.step();}
  assert(Math.hypot(f.actor.position.x-f.leader.position.x,f.actor.position.y-f.leader.position.y)<96);
  assert.equal(f.rescues(),0);assert.equal(f.follower.diagnostics.searches,0);
});
test('kiting does not withdraw but sustained departure and extreme separation do',()=>{
  const f=setup();f.actor.position={x:200,y:200};let returning=false;
  for(let i=0;i<100;i++){f.leader.position={x:200+100*Math.cos(i/8),y:200+100*Math.sin(i/8)};returning=f.follower.tick(f.actor,f.leader,60);assert.equal(returning,false);}
  for(let i=0;i<70;i++){f.leader.position={x:300+i*5,y:200};returning=f.follower.tick(f.actor,f.leader,60);}
  assert.equal(returning,true);
  f.actor.position={...f.leader.position};for(let i=0;i<12;i++)returning=f.follower.tick(f.actor,f.leader,60);assert.equal(returning,false);
});
test('budget starvation keeps search pending and never counts as a failed recovery',()=>{
  const f=setup(p=>p.x>80&&p.x<100);f.actor.position={x:40,y:128};
  f.port.pathBudget={take:()=>0};
  // Waiting for a budget must not be mistaken for an unreachable destination.
  for(let i=0;i<100;i++)f.step();
  assert.equal(f.rescues(),0);assert.equal(f.follower.diagnostics.expanded,0);
});

test('following around a corner stays on the walkable corridor and does not rescue',()=>{
  const blocked=(p:Point)=>p.x>160&&p.y<160;
  const f=setup(blocked);f.actor.position={x:128,y:48};f.leader.position={x:128,y:96};
  for(let i=0;i<100;i++){
    if(i<20)f.leader.position.y+=4;
    else if(i<60)f.leader.position.x+=4;
    f.step();assert.equal(blocked(f.actor.position),false);
  }
  assert(Math.hypot(f.actor.position.x-f.leader.position.x,f.actor.position.y-f.leader.position.y)<80);
  assert.equal(f.rescues(),0);
});

test('fixed-obstacle path snapshots skip moving actors but still check their occupancy at execution',async()=>{
  const {NavigationWorld}=await import('../src/domain/navigation-world.ts');
  const navigation=new NavigationWorld({name:'follow',tileSize:16,columns:20,rows:20,blocked:Array(400).fill(false)});
  const shape={collision:{x:-8,y:-8,width:16,height:16}};
  const self={shape:()=>shape,position:()=>({x:32,y:32}),enabled:()=>true};navigation.register(self);
  let sampled=0;
  const moving={shape:()=>shape,position:()=>{sampled++;return {x:80,y:80};},enabled:()=>true};navigation.register(moving);
  const content={shape:()=>shape,position:()=>({x:112,y:112}),enabled:()=>true,content:()=>true};navigation.register(content);
  const snapshot=navigation.captureStandability(self,true);
  assert.equal(sampled,0);assert.equal(snapshot.canStand({x:80,y:80}),true);
  assert.equal(snapshot.canStand({x:112,y:112}),false);
  assert.equal(navigation.canStand(self,{x:80,y:80}),false);
});

test('following walks through a narrow corner with the same terrain clearance as live movement',()=>{
  const columns=12,rows=12;
  const blocked=Array.from({length:columns*rows},(_,index)=>{
    const column=index%columns,row=Math.floor(index/columns);
    return !((column===2&&row>=2&&row<=8)||(row===8&&column>=2&&column<=9));
  });
  const navigation=new NavigationWorld({name:'narrow corner',tileSize:16,columns,rows,blocked});
  const run=setup();
  run.actor.position={x:40,y:40};
  run.leader.position={x:152,y:136};
  run.actor.bounds={x:-8,y:-16,width:16,height:24};
  const self={shape:()=>({collision:run.actor.bounds}),position:()=>run.actor.position,enabled:()=>true};
  navigation.register(self);
  run.port.canStand=point=>navigation.canStand(self,point);
  run.port.navigationBounds=()=>navigation.bounds;
  run.port.followNavigationSnapshot=()=>navigation.captureStandability(self,true);

  const snapshot=navigation.captureStandability(self,true);
  assert(snapshot.canStandXY);
  for(const point of [{x:40,y:40},{x:40,y:136},{x:56,y:136},{x:56,y:120}]){
    const expected=navigation.canStand(self,point);
    assert.equal(snapshot.canStand(point),expected,`point query at ${point.x},${point.y}`);
    assert.equal(snapshot.canStandXY(point.x,point.y),expected,`coordinate query at ${point.x},${point.y}`);
  }
  for(let frame=0;frame<120;frame++){
    const previous={...run.actor.position};
    run.step();
    assert(canTraverse(previous,run.actor.position,run.port.canStand));
  }
  assert(Math.hypot(run.actor.position.x-128,run.actor.position.y-136)<=12);
  assert.equal(run.rescues(),0);
});

test('a follower resumes its recovered route when physical blocking ends',()=>{
  const run=setup();
  run.actor.position={x:40,y:128};
  run.leader.position={x:200,y:128};
  // 模拟移动意图被物理碰撞挡住 1.5 秒，再让角色正常走动。
  for(let frame=0;frame<25;frame++)run.step(false);
  assert.equal(run.rescues(),0);
  for(let frame=0;frame<12;frame++)run.step();
  assert(run.actor.position.x>64,'挡路解除后应重新迈步');
  for(let frame=0;frame<40;frame++)run.step();
  assert(Math.hypot(run.actor.position.x-148,run.actor.position.y-102)<=12);
  assert.equal(run.rescues(),0);
});

test('recovery attempts preserve the four-second rescue threshold without resetting total stalled time',()=>{
  const run=setup();
  for(let frame=0;frame<66;frame++)run.step(false);
  assert.equal(run.rescues(),0,'不足四秒不能拉回');
  for(let frame=0;frame<6;frame++)run.step(false);
  assert.equal(run.rescues(),1,'多次恢复仍不移动时应保留拉回兜底');
});

test('following detours around a blocking actor without crossing its body or rescuing',()=>{
  const run=setupOccupiedFollow();
  for(let frame=0;frame<120;frame++){
    const previous={...run.actor.position};
    run.step();
    assert(canTraverse(previous,run.actor.position,run.port.canStand),'行走不能穿过挡路的人物');
  }
  assert(Math.hypot(run.actor.position.x-168,run.actor.position.y-94)<=12);
  assert.equal(run.rescues(),0);
});

test('following resumes after an actor that closed the passage moves away',()=>{
  const run=setupOccupiedFollow({x:-8,y:-120,width:16,height:240});
  for(let frame=0;frame<40;frame++)run.step();
  assert(run.actor.position.x<=72);
  assert.equal(run.rescues(),0);
  run.blocker.position.y=-200;
  for(let frame=0;frame<80;frame++)run.step();
  assert(Math.hypot(run.actor.position.x-168,run.actor.position.y-94)<=12);
  assert.equal(run.rescues(),0);
});

test('an occupied-route search keeps its snapshot while waiting for budget and then continues walking',()=>{
  const run=setupOccupiedFollow();
  const capture=run.port.navigationSnapshot!;
  let snapshots=0,waiting=true;
  run.port.navigationSnapshot=()=>{
    snapshots++;
    return capture();
  };
  run.port.pathBudget={take:(_owner,limit)=>snapshots&&waiting?0:Math.min(limit,48)};
  for(let frame=0;frame<100;frame++)run.step();
  assert.equal(snapshots,1,'跨帧搜索复用同一份占位');
  assert.equal(run.rescues(),0,'等预算时不应拉回');
  assert.equal(run.follower.diagnostics.recoveries,0,'等预算不算一次恢复失败');
  waiting=false;
  for(let frame=0;frame<80;frame++)run.step();
  assert(Math.hypot(run.actor.position.x-168,run.actor.position.y-94)<=12);
  assert.equal(run.rescues(),0);
});

test('a genuinely closed passage still permits rescue after repeated failed routes',()=>{
  const run=setupOccupiedFollow({x:-8,y:-120,width:16,height:240});
  for(let frame=0;frame<60;frame++)run.step();
  assert.equal(run.rescues(),0);
  for(let frame=0;frame<180;frame++)run.step();
  assert.equal(run.rescues(),1);
  assert(run.follower.diagnostics.recoveries>=2);
});

test('a follower resumes around the corner when a doorway opens during an occupied-route retry',()=>{
  const columns=50,rows=50;
  const blocked=Array.from({length:columns*rows},(_,index)=>index%columns===24&&Math.floor(index/columns)!==8);
  const navigation=new NavigationWorld({name:'room with narrow doorway',tileSize:16,columns,rows,blocked});
  const run=setupOccupiedFollow(undefined,navigation);
  run.actor.position={x:360,y:136};
  run.leader.position={x:520,y:136};
  run.blocker.position={x:392,y:136};
  const capture=run.port.navigationSnapshot!;
  let snapshots=0,rescues=0;
  run.port.navigationSnapshot=()=>{
    snapshots++;
    return capture();
  };
  run.port.regroup=()=>{rescues++;return false;};
  // 大房间需要跨多帧搜索；等第一次确认门被堵住，再在重试期间放行。
  for(let frame=0;frame<300&&snapshots<2;frame++)run.step();
  assert.equal(snapshots,2);
  const stopped={...run.actor.position},goal={x:468,y:110};
  run.blocker.position.y=-100;
  assert.equal(canTraverse(stopped,goal,run.port.canStand),false,'出门后还需转弯，不能只检查到终点的直线');
  for(let frame=0;frame<2;frame++)run.step();
  assert(Math.hypot(run.actor.position.x-stopped.x,run.actor.position.y-stopped.y)>4,'门打开后应在下一次决策前恢复行走');
  for(let frame=0;frame<80;frame++){
    const previous={...run.actor.position};
    run.step();
    assert(canTraverse(previous,run.actor.position,run.port.canStand));
  }
  assert(Math.hypot(run.actor.position.x-goal.x,run.actor.position.y-goal.y)<=12);
  assert.equal(rescues,0);
});

test('a large room with a permanently blocked doorway still rescues within the stall window',()=>{
  const columns=50,rows=50;
  const blocked=Array.from({length:columns*rows},(_,index)=>index%columns===24&&Math.floor(index/columns)!==8);
  const navigation=new NavigationWorld({name:'large room with permanently blocked doorway',tileSize:16,columns,rows,blocked});
  const run=setupOccupiedFollow(undefined,navigation);
  run.actor.position={x:360,y:136};
  run.leader.position={x:520,y:136};
  run.blocker.position={x:392,y:136};
  let frames=0;
  for(;frames<400&&run.rescues()===0;frames++)run.step();
  assert.equal(run.rescues(),1,`门口一直堵住时应在 400 帧内拉回，实际 ${frames} 帧内没有拉回`);
  assert(frames<400);
});
