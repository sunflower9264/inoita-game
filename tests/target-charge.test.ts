import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {planCharge} from '../src/domain/target-charge.ts';
import {planRearTeleport} from '../src/domain/rear-teleport.ts';
import {CombatController} from '../src/domain/combat.ts';
import type {CombatPort,Combatant,ActionPlayback} from '../src/domain/combat.ts';
import {parseBattle} from '../src/application/content-validation.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
const catalog=parseBattle(JSON.parse(fs.readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')));
const skill={id:'shield-bash',action:catalog.skills['shield-bash'].action!},charge=skill.action.charge!;
const caster:Combatant={id:'player',team:'party',position:{x:320,y:192},bounds:{x:-8,y:-8,width:16,height:16}};
const enemy:Combatant={...caster,id:'enemy',team:'hostile',position:{x:384,y:192}};
test('charge finds four grid landings, handles the close boundary, and respects blocked routes',()=>{
 for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
  const target={...enemy,position:{x:320+64*dx,y:192+64*dy}};
  assert.deepEqual(planCharge(caster,target,charge,()=>true),{destination:{x:320+40*dx,y:192+40*dy},close:false});
  assert.equal(planCharge(caster,{...target,position:{x:320+31*dx,y:192+31*dy}},charge,()=>true)?.close,true);
  assert.equal(planCharge(caster,{...target,position:{x:320+32*dx,y:192+32*dy}},charge,()=>true)?.close,false);
 }
 assert.deepEqual(planCharge(caster,enemy,charge,p=>p.x<344),{destination:{x:343,y:192},close:false},'solid wall falls back to the furthest standable point');
 const detour=planCharge(caster,enemy,charge,p=>p.x!==344||p.y<=176);
 assert.ok(detour&&!detour.close);assert.ok(Math.abs(detour.destination.x-384)+Math.abs(detour.destination.y-192)<=24);
});
test('a close charge stops before the body enters a wall even when the foot point can stand',()=>{
  let player=structuredClone(caster),onFrame:(index:number)=>void=()=>{},verifyCalls=0;
  const moves:number[]=[];
  const closeEnemy={...enemy,position:{x:336,y:192}};
  const port:CombatPort={canSelectSkill:()=>true,cooldowns:new CombatCooldownStore(()=>0).forActor('player'),
    actor:id=>id==='player'?player:closeEnemy,candidates:()=>[player,closeEnemy],facing:()=> 'east',
    moveToward:()=>{},stop:()=>{},canStand:()=>true,
    canPlaceBody:position=>position.x<=325,
    canRelocateVerify:()=>{verifyCalls++;return true;},
    relocate:position=>{player={...player,position};moves.push(position.x);},
    play:(_action,frame)=>{onFrame=frame;return ()=>{};},frame:()=>{},clearEffects:()=>{}};
  const combat=new CombatController('player',resolveBasicAttack(catalog,catalog.classes[0]),port);
  combat.request(skill);
  onFrame(0);
  assert.deepEqual(moves,[325],'8px 冲刺必须停在最后一个整盒可站点，而不是脚点可站的墙里');
  assert.equal(verifyCalls,0,'逐像素整盒检查已经覆盖沿途，不再为每步跑全路线搜索');
});

test('arrival uses the saved landing despite new occupation; cancellation preserves the paid cooldown',()=>{
 for(const mode of ['normal','interrupted','occupied','unreachable']){
  let player=structuredClone(caster),onFrame:(index:number)=>void=()=>{},blocked=mode==='unreachable';
  const events:{index:number;x:number;targets:number}[]=[],moves:number[]=[];
  const port:CombatPort={canSelectSkill:()=>true,cooldowns:new CombatCooldownStore(()=>0).forActor('player'),actor:id=>id==='player'?player:enemy,candidates:()=>[player,enemy],facing:()=> 'east',
   moveToward:()=>{},stop:()=>{},canStand:()=>!blocked,canPlaceBody:()=>!blocked,relocate:p=>{player={...player,position:p};moves.push(p.x);},
   play:(_a,frame)=>{onFrame=frame;return ()=>{};},
   frame:(a:ActionPlayback,index)=>events.push({index,x:a.caster.position.x,targets:a.target?1:0}),clearEffects:()=>{}};
  const combat=new CombatController('player',resolveBasicAttack(catalog,catalog.classes[0]),port);combat.request(skill);
  if(mode==='unreachable'){
   assert.deepEqual(combat.snapshot().cooldowns,{});
   assert.equal(combat.snapshot().state,'idle');assert.deepEqual(events,[]);continue;
  }
  if(mode==='interrupted')combat.cancel();
  if(mode==='occupied')blocked=true;
  onFrame(3);onFrame(3);
  if(mode==='normal'||mode==='occupied'){
   assert.deepEqual(moves,[360]);assert.deepEqual(events.map(e=>[e.index,e.x]),[[0,320],[1,320],[2,360],[3,360]]);
  }else{assert.deepEqual(moves,[]);assert.equal(combat.snapshot().state,'idle');assert.ok(events.every(e=>e.index<2));}
  assert.equal(combat.snapshot().cooldowns['shield-bash'].remainingMs,skill.action.cooldownFrames*60);
 }
});
test('unreachable target area falls back toward the target instead of cancelling',()=>{
 const plan=planCharge(caster,enemy,charge,point=>point.x<344,()=>true,()=>true);
 assert.deepEqual(plan,{destination:{x:343,y:192},close:false});
});
test('charge verifies at most two reachable candidates before falling back',()=>{
 let verifies=0;
 const plan=planCharge(caster,enemy,charge,()=>true,()=>true,()=>{verifies++;return false;});
 assert.equal(verifies,3);
 assert.deepEqual(plan,{destination:caster.position,close:false});
});
test('fallback stops before a narrow barrier and rejects unreachable landings',()=>{
 const stand=(point:{x:number;y:number})=>point.x<329||point.x>331;
 const plan=planCharge(caster,enemy,charge,stand,p=>p.x<329,p=>p.x<329);
 assert.deepEqual(plan,{destination:{x:328,y:192},close:false});
});
test('charge stays put when even the caster position cannot stand',()=>{
 assert.equal(planCharge(caster,enemy,charge,()=>false),undefined);
});
test('rear teleport requires a reachable landing',()=>{
 const target={...enemy,facing:'east' as const};
 assert.ok(planRearTeleport(caster,target,()=>true,()=>true));
 assert.equal(planRearTeleport(caster,target,()=>true,()=>false),undefined);
});
