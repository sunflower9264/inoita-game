import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {ExitTrigger,overlapsFootRect} from '../src/domain/navigation.ts';

const campaign=JSON.parse(fs.readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8')) as {
  events:{id:string;region?:{x:number;y:number;width:number;height:number}}[]};
const village=JSON.parse(fs.readFileSync(
  new URL('../public/content/maps/steel-orc-village-57c67f8c.json',import.meta.url),'utf8')) as {
  exits:{x:number;y:number;width:number;height:number;destination:string}[]};
const swamp=JSON.parse(fs.readFileSync(
  new URL('../public/content/maps/steel-swamp-2-2dae7d1a.json',import.meta.url),'utf8')) as {
  exits:{destination:string;spawn:{x:number;y:number}}[]};

test('a locked story exit remains armed and triggers once after its condition becomes true',()=>{
  const exit={id:'gate',x:64,y:16,width:32,height:32},trigger=new ExitTrigger([exit],{x:8,y:32});
  const inside={x:88,y:32};let unlocked=false;
  assert.equal(trigger.update(inside,true,()=>unlocked),null);
  assert.equal(trigger.update(inside,true,()=>unlocked),null);
  unlocked=true;assert.equal(trigger.update(inside,true,()=>unlocked),exit);
  assert.equal(trigger.update(inside,true,()=>unlocked),null);
  trigger.update({x:32,y:32},true,()=>unlocked);
  assert.equal(trigger.update(inside,true,()=>unlocked),exit);
});

test('a locked exit cannot shadow an overlapping available exit',()=>{
  const closed={id:'closed',x:64,y:16,width:32,height:32},open={...closed,id:'open'};
  const trigger=new ExitTrigger([closed,open],{x:8,y:32});
  assert.equal(trigger.update({x:88,y:32},true,exit=>exit.id==='open'),open);
});

test('a region event sharing the doorway cell is reached before the exit teleports the player',()=>{
  // 事件 1 的原版矩形与营地东侧去丛林西的四个出口格完全重合（findings 96）：走位时
  // 两种判定必须同粒度（原版都按角色碰撞盒，findings 49），否则身体刚探进门口格时只有出口成立，
  // 玩家被先传送走，演出与它接取的任务一起被跳过。
  // 这里按 world-scene 的顺序复现：先区域、命中即返回，再出口。
  const exit={id:'camp-east',x:384,y:336,width:16,height:16},region={x:384,y:304,width:16,height:64};
  const trigger=new ExitTrigger([exit],{x:200,y:344});
  const stepTo=(x:number)=>{const point={x,y:344};
    if(overlapsFootRect(point,region))return 'event';
    return trigger.update(point,true)===exit?'exit':null;};
  assert.equal(stepTo(376),null,'身体还没探到门口：既不开演，也不传送');
  assert.equal(stepTo(378),'event','身体探进门口格：演出先于传送');
});

test('ordinary entry spawn still requires leaving the open doorway before returning',()=>{
  const exit={id:'gate',x:64,y:16,width:32,height:32},inside={x:80,y:32};
  const trigger=new ExitTrigger([exit],inside);
  assert.equal(trigger.update(inside,true,()=>true),null);
  trigger.update({x:32,y:32},true,()=>true);
  assert.equal(trigger.update(inside,true,()=>true),exit);
});

test('the steel orc village entrance reaches its cutscene area before the return exit re-arms',()=>{
  // 回归：进图落点曾被推离出口 24 像素，正好越过 event-91 的触发区；事件改在南门补播，
  // 收尾把哨所的 npc-250 一起删掉。落点必须留在出口给的坐标上，让村口剧情先触发。
  const event=campaign.events.find(value=>value.id==='event-91');
  const arrival=swamp.exits.find(exit=>exit.destination==='steel-orc-village-57c67f8c');
  const back=village.exits.find(exit=>exit.destination==='steel-swamp-2-2dae7d1a');
  assert.ok(event?.region&&arrival&&back);
  const gate=new ExitTrigger([back],arrival.spawn);
  // 落点正压在回程出口上；往村里走一步先进入 event-91，此时出口仍锁着。
  const step={x:arrival.spawn.x,y:arrival.spawn.y-1};
  assert.equal(overlapsFootRect(step,event.region),true);
  assert.equal(gate.update(step,true),null);
  // 走出 80 像素缓冲区后出口才重新武装；走回来才允许离开。
  const clear={x:arrival.spawn.x,y:arrival.spawn.y-96};
  assert.equal(overlapsFootRect(clear,event.region),false);
  assert.equal(gate.update(clear,true),null);
  assert.equal(gate.update(arrival.spawn,true),back);
});
