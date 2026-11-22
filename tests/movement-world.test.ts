import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire,registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import {NavigationWorld} from '../src/domain/navigation-world.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';
import {CHARACTER_FOOT_DEPTH_OFFSET} from '../src/rendering/depths.ts';
import type {MovementBody} from '../src/rendering/arcade-movement.ts';
import type {MovementWorld as MovementWorldType} from '../src/rendering/movement-world.ts';

const require=createRequire(import.meta.url);
const World=require('../node_modules/phaser/src/physics/arcade/World.js') as typeof Phaser.Physics.Arcade.World;
const bodyUrl=new URL('../node_modules/phaser/src/physics/arcade/Body.js',import.meta.url).href;
const shim=`import Body from ${JSON.stringify(bodyUrl)};export default {Physics:{Arcade:{Body}},Scenes:{Events:{PRE_UPDATE:'preupdate',POST_UPDATE:'postupdate',PRE_RENDER:'prerender',RENDER:'render'}}};`;
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:`data:text/javascript,${encodeURIComponent(shim)}`,shortCircuit:true}:next(specifier,context);}});
const {MovementWorld}=await import('../src/rendering/movement-world.ts');hook.deregister();
type CollisionObject=Parameters<NonNullable<Phaser.Physics.Arcade.Collider['processCallback']>>[0];

function harness(){
  const events=new EventEmitter(),members=new Set<unknown>();
  const group={scene:{},add(value:unknown){members.add(value)},remove(value:unknown){members.delete(value)},destroy(){members.clear()}};
  const scene={sys:{scale:{width:640,height:480}},events,add:{group:()=>group}} as unknown as Phaser.Scene;
  const world=new World(scene,{gravity:{x:0,y:0},debug:false});
  scene.physics={world,add:{collider:(...args:Parameters<typeof world.addCollider>)=>world.addCollider(...args)}} as Phaser.Physics.Arcade.ArcadePhysics;
  const navigation=new NavigationWorld({name:'arena',bounds:{x:0,y:0,width:400,height:400}});
  const movement=new MovementWorld(scene,navigation);
  return {events,world,navigation,movement,members};
}

function testVisual(id:string,x:number,y:number,depthWrites:number[]=[]){
  const container=Object.assign(new EventEmitter(),{
    x,y,depth:0,scaleX:1,scaleY:1,angle:0,rotation:0,displayOriginX:0,displayOriginY:0,active:true,visible:true,
    setPosition(nx:number,ny:number){this.x=nx;this.y=ny;return this;},
    setDepth(value:number){this.depth=value;depthWrites.push(value);return this;},
    setVisible(value:boolean){this.visible=value;return this;}
  });
  return {visual:{actor:{collision:{x:-4,y:-4,width:8,height:8}},entity:{id},container} as unknown as CharacterVisual,container,depthWrites};
}

function samplesOf(movement:MovementWorldType):Map<unknown,unknown>{
  return (movement as unknown as {interpolation:{samples:Map<unknown,unknown>}}).interpolation.samples;
}
function settle(movement:MovementWorldType):void{
  (movement as unknown as {settleStep(delta:number):void}).settleStep(16);
}
/** 直接模拟一个物理步后的脚点；物理层正常会用 postUpdate 把容器同步到同一位置。 */
function moveFoot(body:MovementBody,container:{x:number;y:number},x:number,y:number):void{
  body.position.set(x-4,y-4);body.updateCenter();container.x=x;container.y=y;
}

test('the installed collision filter follows registered bodies, current visibility and shape, and removal',t=>{
  const members=new Set<unknown>(),events=new EventEmitter();
  const group={scene:{},add:(value:unknown)=>members.add(value),remove:(value:unknown)=>members.delete(value),destroy:()=>members.clear()};
  const scene={sys:{scale:{width:640,height:480}},events,add:{group:()=>group}} as unknown as Phaser.Scene;
  const world=new World(scene,{gravity:{x:0,y:0},debug:false});
  let collider:Phaser.Physics.Arcade.Collider;
  scene.physics={world,add:{collider:(...args:Parameters<typeof world.addCollider>)=>{collider=world.addCollider(...args);return collider;}}} as Phaser.Physics.Arcade.ArcadePhysics;
  const movement=new MovementWorld(scene,new NavigationWorld({name:'arena',bounds:{x:0,y:0,width:200,height:200}}));
  t.after(()=>{movement.destroy();world.destroy();});
  const visual=(id:string,x:number)=>({actor:{collision:{x:-4,y:-4,width:8,height:8}},entity:{id},container:Object.assign(new EventEmitter(),{
    x,y:40,scaleX:1,scaleY:1,angle:0,rotation:0,displayOriginX:0,displayOriginY:0,active:true,visible:true,
    setPosition(x:number,y:number){this.x=x;this.y=y;return this;},setDepth(){return this;},setVisible(value:boolean){this.visible=value;return this;}
  })}) as unknown as CharacterVisual;
  const first=visual('first',40),second=visual('second',48);
  const a=movement.register(first),b=movement.register(second);
  const permits=(x:unknown,y:unknown)=>collider!.processCallback!(x as CollisionObject,y as CollisionObject);
  assert.equal(permits(first.container,second.container),true);assert.equal(permits(a,b),true);
  first.container.visible=false;assert.equal(permits(a,b),false);first.container.visible=true;
  movement.setEnabled(second,false);assert.equal(permits(a,b),false);movement.setEnabled(second,true);
  second.actor.collision=undefined;assert.equal(permits(a,b),false);
  second.actor.collision={x:-4,y:-4,width:8,height:8};assert.equal(permits(a,b),true);
  assert.equal(permits({body:{}},b),false);assert.equal(permits({body:null},b),false);
  movement.remove(first);a.enable=true;assert.equal(permits(a,b),false,'removed bodies cannot regain collision membership');
  const replacement=movement.register(first);assert.notEqual(replacement,a);assert.equal(permits(first.container,second.container),true);
  first.container.emit('destroy');replacement.enable=true;assert.equal(permits(replacement,b),false);
  assert.equal(members.has(first.container),false);assert.equal(members.has(second.container),true);
  // 同队单位互不碰撞；队伍与中立单位仍按实体范围碰撞。
  const ally=visual('ally',56);const allyBody=movement.register(ally,true,true,'party');
  movement.register(second,true,true,'party');
  assert.equal(permits(allyBody,b),false,'同队单位之间不参与碰撞');
  movement.register(second,true,true);
  assert.equal(permits(allyBody,b),true,'队伍单位与中立单位仍碰撞');
});

test('a separation that pushes the foot into terrain returns to the step start; when the start is illegal too it recovers to the nearest body-free spot',t=>{
  const events=new EventEmitter();
  const group={scene:{},add(){},remove(){},destroy(){}};
  const scene={sys:{scale:{width:640,height:480}},events,add:{group:()=>group}} as unknown as Phaser.Scene;
  const world=new World(scene,{gravity:{x:0,y:0},debug:false});
  scene.physics={world,add:{collider:(...args:Parameters<typeof world.addCollider>)=>world.addCollider(...args)}} as Phaser.Physics.Arcade.ArcadePhysics;
  // 12×12 格，第 5 行整行是墙；其余可站。脚点 (40,40) 在 row 2，墙带覆盖 y 80..96。
  const blocked=new Array(144).fill(false);for(let col=0;col<12;col++)blocked[5*12+col]=true;
  const navigation=new NavigationWorld({name:'arena',tileSize:16,columns:12,rows:12,blocked});
  const movement=new MovementWorld(scene,navigation);
  t.after(()=>{movement.destroy();world.destroy();});
  const collision={x:-8,y:-8,width:16,height:16};
  const visual={actor:{collision},entity:{id:'hero'},container:Object.assign(new EventEmitter(),{
    x:40,y:40,scaleX:1,scaleY:1,angle:0,rotation:0,displayOriginX:0,displayOriginY:0,active:true,visible:true,
    setPosition(x:number,y:number){this.x=x;this.y=y;return this;},setDepth(){return this;},setVisible(value:boolean){this.visible=value;return this;}
  })} as unknown as CharacterVisual;
  const body=movement.register(visual,true);
  const settle=()=>(movement as unknown as {settleStep(delta:number):void}).settleStep(16);
  body.update(.016); // 正常一步：本帧起点 (40,40)
  // 模拟碰撞分离把身体推进墙带：body 左上角 = 脚点 + collision 偏移。
  body.position.set(40+collision.x,88+collision.y);body.updateCenter();
  settle();
  assert.deepEqual(movement.position(visual),{x:40,y:40},'分离造成的位移应退回本帧起点');
  // 起点本身也不合法：只能按整个碰撞盒就近自愈，不能停在墙里。
  (body as unknown as {stepStart:{x:number;y:number}}).stepStart={x:40,y:88};
  body.position.set(40+collision.x,88+collision.y);body.updateCenter();
  settle();
  const foot=movement.position(visual);
  assert.ok(navigation.terrainFree(foot),`自愈后的脚点仍不可站：${JSON.stringify(foot)}`);
  assert.ok(navigation.bodyTerrainFree({collision},foot),`自愈后的整盒仍压墙：${JSON.stringify(foot)}`);
});

test('content actors placed on blocked terrain are never relocated by physics',t=>{
  const events=new EventEmitter();
  const group={scene:{},add(){},remove(){},destroy(){}};
  const scene={sys:{scale:{width:640,height:480}},events,add:{group:()=>group}} as unknown as Phaser.Scene;
  const world=new World(scene,{gravity:{x:0,y:0},debug:false});
  scene.physics={world,add:{collider:(...args:Parameters<typeof world.addCollider>)=>world.addCollider(...args)}} as Phaser.Physics.Arcade.ArcadePhysics;
  const blocked=new Array(144).fill(false);for(let col=0;col<12;col++)blocked[5*12+col]=true;
  const navigation=new NavigationWorld({name:'arena',tileSize:16,columns:12,rows:12,blocked});
  const movement=new MovementWorld(scene,navigation);
  t.after(()=>{movement.destroy();world.destroy();});
  const visual={actor:{collision:{x:-8,y:-8,width:16,height:16}},entity:{id:'torch'},container:Object.assign(new EventEmitter(),{
    x:40,y:88,scaleX:1,scaleY:1,angle:0,rotation:0,displayOriginX:0,displayOriginY:0,active:true,visible:true,
    setPosition(x:number,y:number){this.x=x;this.y=y;return this;},setDepth(){return this;},setVisible(value:boolean){this.visible=value;return this;}
  })} as unknown as CharacterVisual;
  const body=movement.register(visual,false);
  body.update(.016);
  (movement as unknown as {settleStep(delta:number):void}).settleStep(16);
  assert.deepEqual(movement.position(visual),{x:40,y:88},'内容坐标必须原样保留');
  assert.equal(movement.state(visual)!.wallRecoveries,0,'原地写回不算一次回退');
  // projectStoryWorld 会拿内容坐标重建整组落位；这条必须继续被跳过而不是校验失败。
  assert.equal(navigation.canSettleAll([{actor:movement.actor(visual),position:{x:40,y:88},enabled:true}]),true);
  movement.placeContent(visual,{x:72,y:88},true);
  assert.deepEqual(movement.position(visual),{x:72,y:88},'机关按脚本移到另一阻挡格，坐标不能被人物落位规则修正');
  body.update(.016);
  (movement as unknown as {settleStep(delta:number):void}).settleStep(16);
  assert.deepEqual(movement.position(visual),{x:72,y:88});
  movement.placeContent(visual,{x:72,y:88},false);
  assert.equal(body.enable,false);
  assert.equal(visual.container.visible,false);
});

test('content placements and shape changes refresh the content index at the new footprint',t=>{
  const h=harness();
  t.after(()=>{h.movement.destroy();h.world.destroy();});
  const torch=testVisual('torch',40,40);
  h.movement.register(torch.visual,false);
  const query={collision:{x:-4,y:-4,width:8,height:8}};
  assert.equal(h.navigation.blockedByContent(query,{x:40,y:40}),true);
  h.movement.placeContent(torch.visual,{x:120,y:120},true);
  assert.equal(h.navigation.blockedByContent(query,{x:40,y:40}),false,'placeContent 撤销旧格子的登记');
  assert.equal(h.navigation.blockedByContent(query,{x:120,y:120}),true,'placeContent 按新位置命中');
  h.movement.placeAll([{visual:torch.visual,position:{x:200,y:200},enabled:true}]);
  assert.equal(h.navigation.blockedByContent(query,{x:120,y:120}),false,'placeAll 撤销旧格子的登记');
  assert.equal(h.navigation.blockedByContent(query,{x:200,y:200}),true,'placeAll 按新位置命中');
  torch.visual.actor.collision={x:-16,y:-16,width:32,height:32};
  h.movement.refreshShape(torch.visual);
  assert.equal(h.navigation.blockedByContent(query,{x:212,y:200}),true,'换外观后新碰撞盒覆盖的格子已登记');
  h.movement.remove(torch.visual);
  assert.equal(h.navigation.blockedByContent(query,{x:212,y:200}),false,'注销后索引同步移除');
});

test('a movable actor without terrain recovery is not relocated when its start is illegal',t=>{
  const events=new EventEmitter();
  const group={scene:{},add(){},remove(){},destroy(){}};
  const scene={sys:{scale:{width:640,height:480}},events,add:{group:()=>group}} as unknown as Phaser.Scene;
  const world=new World(scene,{gravity:{x:0,y:0},debug:false});
  scene.physics={world,add:{collider:(...args:Parameters<typeof world.addCollider>)=>world.addCollider(...args)}} as Phaser.Physics.Arcade.ArcadePhysics;
  const blocked=new Array(144).fill(false);for(let col=0;col<12;col++)blocked[5*12+col]=true;
  const navigation=new NavigationWorld({name:'arena',tileSize:16,columns:12,rows:12,blocked});
  const movement=new MovementWorld(scene,navigation);
  t.after(()=>{movement.destroy();world.destroy();});
  const visual={actor:{collision:{x:-8,y:-8,width:16,height:16}},entity:{id:'guard'},container:Object.assign(new EventEmitter(),{
    x:40,y:88,scaleX:1,scaleY:1,angle:0,rotation:0,displayOriginX:0,displayOriginY:0,active:true,visible:true,
    setPosition(x:number,y:number){this.x=x;this.y=y;return this;},setDepth(){return this;},setVisible(value:boolean){this.visible=value;return this;}
  })} as unknown as CharacterVisual;
  const body=movement.register(visual,true,false);
  body.update(.016);
  (movement as unknown as {settleStep(delta:number):void}).settleStep(16);
  assert.deepEqual(movement.position(visual),{x:40,y:88},'敌人/非恢复角色不搬迁内容异常点');
  assert.equal(movement.state(visual)!.terrainRecovery,false);
});

test('placeAll repairs a strict actor out of a blocked cell instead of aborting the performance',t=>{
  const events=new EventEmitter(),group={scene:{},add(){},remove(){},destroy(){}};
  const scene={sys:{scale:{width:640,height:480}},events,add:{group:()=>group}} as unknown as Phaser.Scene;
  const world=new World(scene,{gravity:{x:0,y:0},debug:false});
  scene.physics={world,add:{collider:(...args:Parameters<typeof world.addCollider>)=>world.addCollider(...args)}} as Phaser.Physics.Arcade.ArcadePhysics;
  const blocked=new Array(144).fill(false);for(let col=0;col<12;col++)blocked[5*12+col]=true;
  const navigation=new NavigationWorld({name:'arena',tileSize:16,columns:12,rows:12,blocked});
  const movement=new MovementWorld(scene,navigation);
  t.after(()=>{movement.destroy();world.destroy();});
  const collision={x:-8,y:-8,width:16,height:16};
  const visual={actor:{collision},entity:{id:'hero'},container:Object.assign(new EventEmitter(),{
    x:40,y:40,scaleX:1,scaleY:1,angle:0,rotation:0,displayOriginX:0,displayOriginY:0,active:true,visible:true,
    setPosition(x:number,y:number){this.x=x;this.y=y;return this;},setDepth(){return this;},setVisible(value:boolean){this.visible=value;return this;}
  })} as unknown as CharacterVisual;
  movement.register(visual,true,true);
  assert.doesNotThrow(()=>movement.placeAll([{visual,position:{x:40,y:88},enabled:true}]));
  const foot=movement.position(visual);
  assert.ok(navigation.terrainFree(foot),`修正后的脚点仍不可站：${JSON.stringify(foot)}`);
  assert.ok(navigation.bodyTerrainFree({collision},foot),`修正后的整盒仍压墙：${JSON.stringify(foot)}`);
});

test('placeAll keeps the performance alive when the map has no legal body spot',t=>{
  const events=new EventEmitter(),group={scene:{},add(){},remove(){},destroy(){}};
  const scene={sys:{scale:{width:640,height:480}},events,add:{group:()=>group}} as unknown as Phaser.Scene;
  const world=new World(scene,{gravity:{x:0,y:0},debug:false});
  scene.physics={world,add:{collider:(...args:Parameters<typeof world.addCollider>)=>world.addCollider(...args)}} as Phaser.Physics.Arcade.ArcadePhysics;
  const blocked=new Array(144).fill(true);
  const navigation=new NavigationWorld({name:'sealed',tileSize:16,columns:12,rows:12,blocked});
  const movement=new MovementWorld(scene,navigation);
  t.after(()=>{movement.destroy();world.destroy();});
  const collision={x:-8,y:-8,width:16,height:16};
  const visual={actor:{collision},entity:{id:'hero'},container:Object.assign(new EventEmitter(),{
    x:40,y:40,scaleX:1,scaleY:1,angle:0,rotation:0,displayOriginX:0,displayOriginY:0,active:true,visible:true,
    setPosition(x:number,y:number){this.x=x;this.y=y;return this;},setDepth(){return this;},setVisible(value:boolean){this.visible=value;return this;}
  })} as unknown as CharacterVisual;
  movement.register(visual,true,true);
  assert.doesNotThrow(()=>movement.placeAll([{visual,position:{x:40,y:88},enabled:true}]),
    '没有合法落点时保持原位并记录，不中断剧情');
  assert.deepEqual(movement.position(visual),{x:40,y:88});
});

test('movable actors sample their steps and stop at the live position; static actors join physics and write depth once',t=>{
  const h=harness();
  t.after(()=>{h.movement.destroy();h.world.destroy();});
  const hero=testVisual('hero',40,40);
  const heroWrites=hero.depthWrites;
  const body=h.movement.register(hero.visual,true);
  assert.equal(h.movement.body(hero.visual),body);
  assert.equal(h.members.has(hero.container),true,'会动角色仍进入物理 group');
  assert.equal(samplesOf(h.movement).has(hero.container),true,'会动角色进入采样表');

  moveFoot(body,hero.container,50,40);settle(h.movement);
  moveFoot(body,hero.container,60,40);settle(h.movement);
  settle(h.movement);
  assert.deepEqual(h.movement.position(hero.visual),{x:60,y:40});
  assert.deepEqual(h.movement.displayPosition(hero.visual),{x:60,y:40},'停步后显示读当前位置，不回退到 50');

  h.movement.setEnabled(hero.visual,false);
  moveFoot(body,hero.container,70,40);settle(h.movement);
  assert.deepEqual(h.movement.displayPosition(hero.visual),{x:70,y:40},'禁用时也收敛到当前脚点');
  h.movement.setEnabled(hero.visual,true);
  moveFoot(body,hero.container,80,40);settle(h.movement);
  assert.deepEqual(h.movement.displayPosition(hero.visual),{x:70,y:40},'重新启用后从 70 出发，不滑回 40');

  h.movement.place(hero.visual,{x:160,y:120});
  assert.deepEqual(h.movement.displayPosition(hero.visual),{x:160,y:120},'瞬移后立即读新位置');
  moveFoot(body,hero.container,170,120);settle(h.movement);
  assert.deepEqual(h.movement.displayPosition(hero.visual),{x:160,y:120},'瞬移后的下一段从新位置插值，不拖旧尾');
  hero.container.y=60;
  (h.movement as unknown as {syncDepth():void}).syncDepth();
  assert.equal(heroWrites.at(-1),60+CHARACTER_FOOT_DEPTH_OFFSET,'会动角色仍每帧同步深度');

  const torchWrites:number[]=[];
  const torch=testVisual('torch',40,80,torchWrites);
  h.movement.register(torch.visual,false);
  assert.equal(h.members.has(torch.container),true,'静态角色仍进入物理 group');
  assert.equal(samplesOf(h.movement).has(torch.container),false,'静态角色不进采样表');
  assert.deepEqual(torchWrites,[80+CHARACTER_FOOT_DEPTH_OFFSET],'静态角色注册时写一次深度');
  // 静态角色不再每帧遍历：直接改容器 y 不会被 POST_UPDATE 的深度同步发现，落位时会补写。
  torch.container.y=128;
  (h.movement as unknown as {syncDepth():void}).syncDepth();
  assert.deepEqual(torchWrites,[80+CHARACTER_FOOT_DEPTH_OFFSET],'静态深度不再每帧遍历');
  h.movement.place(torch.visual,{x:40,y:128});
  assert.equal(torchWrites.at(-1),128+CHARACTER_FOOT_DEPTH_OFFSET,'落位时写一次深度');
});

test('repeated register toggles sampling membership and resumes smoothly from the current position',t=>{
  const h=harness();
  t.after(()=>{h.movement.destroy();h.world.destroy();});
  const actor=testVisual('actor',40,40);
  const body=h.movement.register(actor.visual,false);
  const samples=samplesOf(h.movement);
  assert.equal(samples.has(actor.container),false);

  h.movement.register(actor.visual,true);
  assert.equal(samples.has(actor.container),true,'静态转动态重新加入采样');
  moveFoot(body,actor.container,50,40);settle(h.movement);
  assert.deepEqual(h.movement.displayPosition(actor.visual),{x:40,y:40},'从登记位置平滑开始');
  h.movement.register(actor.visual,true);
  assert.deepEqual(h.movement.displayPosition(actor.visual),{x:40,y:40},'重复登记为会动不会重置当前插值');

  h.movement.register(actor.visual,false);
  assert.equal(samples.has(actor.container),false,'动态转静态移除采样');
  assert.deepEqual(h.movement.displayPosition(actor.visual),{x:50,y:40},'静态直接读容器当前位置');

  h.movement.register(actor.visual,true);
  moveFoot(body,actor.container,60,40);settle(h.movement);
  assert.deepEqual(h.movement.displayPosition(actor.visual),{x:50,y:40},'再次转动态从 50 出发，不跳回 40');
});

test('a static actor with a walk intention is sampled and depth-sorted until it stops',t=>{
  const h=harness();
  t.after(()=>{h.movement.destroy();h.world.destroy();});
  const writes:number[]=[];
  const walker=testVisual('walker',40,40,writes);
  const body=h.movement.register(walker.visual,false);
  const samples=samplesOf(h.movement);
  assert.equal(samples.has(walker.container),false,'没有移动意图的静态角色不进采样');
  assert.deepEqual(writes,[40+CHARACTER_FOOT_DEPTH_OFFSET],'注册时写一次深度');

  // 剧情走位会临时取消固定；MovementWorld.walkTo 本身负责采样和深度成员。
  body.setImmovable(false);
  const route=h.movement.walkTo(walker.visual,{x:40,y:120},120);
  assert.equal(samples.has(walker.container),true,'walkTo 给静态角色临时加入采样');

  let time=0;
  const beginFrame=(delta:number)=>(h.movement as unknown as {beginFrame(time:number,delta:number):void}).beginFrame(time,delta);
  const syncDepth=()=>(h.movement as unknown as {syncDepth():void}).syncDepth();
  const step=(delta=1000/60)=>{
    time+=delta;
    beginFrame(delta);
    h.world.update(time,delta);
    h.world.postUpdate();
    syncDepth();
  };
  step();
  const firstPhysical=h.movement.position(walker.visual);
  const firstDisplay=h.movement.displayPosition(walker.visual);
  assert.ok(firstPhysical.y>40,'走位路线开始推进');
  assert.ok(firstDisplay.y>=40&&firstDisplay.y<firstPhysical.y,'显示位置仍在起终点之间，不平移跳到最新脚点');
  assert.ok(writes.length>1&&writes.at(-1)!>40+CHARACTER_FOOT_DEPTH_OFFSET,'走位时深度继续更新');

  for(let i=0;i<300&&route.state==='walking';i++)step();
  assert.equal(route.state,'arrived');
  const end=h.movement.position(walker.visual);
  assert.ok(end.y>40);
  h.movement.stop(walker.visual);
  assert.equal(samples.has(walker.container),false,'停步后移出临时采样');
  assert.deepEqual(h.movement.displayPosition(walker.visual),end,'停步后显示停在当前脚点，不回到旧位置');
  const depthAfterStop=writes.at(-1);
  syncDepth();
  assert.equal(writes.at(-1),depthAfterStop,'停步后不再进入动态深度遍历');
});

test('drive, toward and followPath give a static actor temporary sampling until stop',t=>{
  const h=harness();
  t.after(()=>{h.movement.destroy();h.world.destroy();});
  const actor=testVisual('actor',80,80);
  h.movement.register(actor.visual,false);
  const samples=samplesOf(h.movement);
  for(const start of [
    ()=>h.movement.drive(actor.visual,{x:1,y:0},60),
    ()=>h.movement.toward(actor.visual,{x:120,y:80},60),
    ()=>h.movement.followPath(actor.visual,()=>undefined,60)
  ]){
    start();
    assert.equal(samples.has(actor.container),true,'移动意图让静态角色临时进入采样');
    h.movement.stop(actor.visual);
    assert.equal(samples.has(actor.container),false,'stop 移出临时采样');
  }
});

test('story walks find a reachable tile when the dynamic map blocks the target',t=>{
  const events=new EventEmitter();
  const group={scene:{},add(){},remove(){},destroy(){}};
  const scene={sys:{scale:{width:640,height:480}},events,add:{group:()=>group}} as unknown as Phaser.Scene;
  const world=new World(scene,{gravity:{x:0,y:0},debug:false});
  scene.physics={world,add:{collider:(...args:Parameters<typeof world.addCollider>)=>world.addCollider(...args)}} as Phaser.Physics.Arcade.ArcadePhysics;
  // 只挡住目标所在的一格：兜底应朝目标推进到最近的整盒可站格，而不是原地不动。
  const blocked=new Array(144).fill(false);blocked[5*12+2]=true;
  const navigation=new NavigationWorld({name:'arena',tileSize:16,columns:12,rows:12,blocked});
  const movement=new MovementWorld(scene,navigation);
  t.after(()=>{movement.destroy();world.destroy();});
  const collision={x:-8,y:-8,width:16,height:16};
  const visual={actor:{collision},entity:{id:'hero'},container:Object.assign(new EventEmitter(),{
    x:40,y:40,scaleX:1,scaleY:1,angle:0,rotation:0,displayOriginX:0,displayOriginY:0,active:true,visible:true,
    setPosition(x:number,y:number){this.x=x;this.y=y;return this;},setDepth(){return this;},setVisible(value:boolean){this.visible=value;return this;}
  })} as unknown as CharacterVisual;
  movement.register(visual,true);
  movement.place(visual,{x:40,y:40});
  const result=navigation.storyWalkDestination(movement.actor(visual).shape(),movement.position(visual),{x:40,y:88},true);
  assert.ok(result,'阻挡目标应能找到最近可站点');
  assert.ok(navigation.terrainFree(result),`兜底脚点不可站：${JSON.stringify(result)}`);
  assert.ok(navigation.bodyTerrainFree({collision},result),`兜底整盒压墙：${JSON.stringify(result)}`);
  assert.ok(result.y>40&&result.y<80,`兜底要朝目标推进但停在阻挡格前：${JSON.stringify(result)}`);
  assert.notDeepEqual(result,{x:40,y:88},'兜底不能回到被挡的目标格');
});

test('story walk origin repairs a standable cell occupied by another actor',()=>{
  const navigation=new NavigationWorld({name:'arena',bounds:{x:0,y:0,width:200,height:200}});
  const from={x:100,y:100},shape={collision:{x:-8,y:-8,width:16,height:16}};
  navigation.register({position:()=>from,shape:()=>shape,enabled:()=>true,faction:()=>'hostile' as const});
  const origin=navigation.storyWalkOrigin(shape,from);
  assert.notDeepEqual(origin,from,'被其他角色占住时也要修正起点');
  assert.equal(navigation.canPlace(shape,origin),true);
});

test('re-registering a walking actor as static keeps temporary sampling until stop',t=>{
  const h=harness();
  t.after(()=>{h.movement.destroy();h.world.destroy();});
  const actor=testVisual('actor',80,80);
  h.movement.register(actor.visual,true);
  const samples=samplesOf(h.movement);
  h.movement.drive(actor.visual,{x:1,y:0},60);
  h.movement.register(actor.visual,false);
  assert.equal(samples.has(actor.container),true,'走位中改为静态仍保留临时采样');
  h.movement.stop(actor.visual);
  assert.equal(samples.has(actor.container),false,'停步后移出临时采样');
});
