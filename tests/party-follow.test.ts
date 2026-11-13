import assert from 'node:assert/strict';
import test from 'node:test';
import {PartyFollow,PartyTrail} from '../src/domain/party-follow.ts';
import type {PartyPort} from '../src/domain/party-ai.ts';
import type {Point} from '../src/domain/navigation.ts';
import {PathBudget} from '../src/domain/path-budget.ts';

function setup(blocked=(_p:Point)=>false){
  const bounds={x:-8,y:-8,width:16,height:16};
  const actor={id:'ally',team:'party',position:{x:64,y:176},bounds},leader={id:'hero',team:'party',position:{x:128,y:128},bounds};
  const trail=new PartyTrail(),budget=new PathBudget(512);let next:(()=>Point|undefined)|undefined,rescues=0,scale=1;
  const free=(p:Point)=>p.x>=8&&p.x<=1000&&p.y>=8&&p.y<=1000&&!blocked(p);
  const port={actor:()=>actor,followTrail:trail,followSlot:()=>0,canStand:free,navigationBounds:()=>({x:0,y:0,width:1024,height:1024}),
    pathBudget:budget,followPath:(callback:()=>Point|undefined,speed=1)=>{next=callback;scale=speed;},stop:()=>{next=undefined;},
    regroup:()=>{rescues++;actor.position={...leader.position};return true;}} as unknown as PartyPort;
  const follower=new PartyFollow(actor.id,port);
  const step=()=>{budget.reset();trail.record('hero',leader.position,60,'east');follower.tick(actor,leader,60);follower.move(actor,leader,'support',60);
    const p=next?.();if(p){const dx=p.x-actor.position.x,dy=p.y-actor.position.y,d=Math.hypot(dx,dy),n=Math.min(d,6*scale);if(d)actor.position={x:actor.position.x+dx/d*n,y:actor.position.y+dy/d*n};}};
  return {actor,leader,trail,follower,port,step,rescues:()=>rescues};
}

test('wall-hidden support formation walks to its leader without rescue',()=>{
  const f=setup(p=>p.x>=32&&p.x<=112&&p.y>=48&&p.y<=144);
  for(let i=0;i<100;i++)f.step();
  assert(Math.hypot(f.actor.position.x-128,f.actor.position.y-128)<=24);assert.equal(f.rescues(),0);
});
test('a moving leader is followed continuously with bounded shared history and no path searches on open ground',()=>{
  const f=setup();f.actor.position={x:80,y:128};
  for(let i=0;i<120;i++){f.leader.position.x+=5;f.step();}
  assert(Math.hypot(f.actor.position.x-f.leader.position.x,f.actor.position.y-f.leader.position.y)<96);
  assert.equal(f.rescues(),0);assert.equal(f.follower.diagnostics.searches,0);
  const trail=new PartyTrail();for(let i=0;i<2000;i++)trail.record('hero',{x:i*8,y:20},60,'east');assert.equal(trail.size,128);
});
test('kiting does not withdraw but sustained departure and extreme separation do',()=>{
  const f=setup();f.actor.position={x:200,y:200};let returning=false;
  for(let i=0;i<100;i++){f.leader.position={x:200+100*Math.cos(i/8),y:200+100*Math.sin(i/8)};f.trail.record('hero',f.leader.position,60,'east');returning=f.follower.tick(f.actor,f.leader,60);assert.equal(returning,false);}
  for(let i=0;i<70;i++){f.leader.position={x:300+i*5,y:200};f.trail.record('hero',f.leader.position,60,'east');returning=f.follower.tick(f.actor,f.leader,60);}
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
