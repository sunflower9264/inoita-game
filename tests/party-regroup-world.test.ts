import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { NavigationWorld, type NavigationActor } from '../src/domain/navigation-world.ts';
import type { Point } from '../src/domain/navigation.ts';

const hook=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,ADD:1,MULTIPLY:2,SCREEN:3},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const { WorldCombat }=await import('../src/scenes/world-combat.ts');
hook.deregister();

const body={x:-8,y:-8,width:16,height:16};
interface TestVisual { id:string; actor:{collision:typeof body;clips:Record<string,never>}; container:{active:boolean;visible:boolean} }
interface TestAlly { id:string; visual:TestVisual; member:{player:{health:number}}; facing:'south'; ai:{cancel():void} }

function fixture(options:{sealed?:boolean;wall?:boolean}={}){
  const blocked=Array<boolean>(40*40).fill(!!options.sealed);
  // 整列墙把地图分成左右两半，主角在右侧；墙另一侧的最近格心不能成为落点。
  if(options.wall)for(let row=0;row<40;row++)blocked[row*40+20]=true;
  const navigation=new NavigationWorld({name:'party-regroup',tileSize:16,columns:40,rows:40,blocked});
  const positions=new Map<TestVisual,Point>(),actors=new Map<TestVisual,NavigationActor>();
  function addVisual(id:string,point:Point):TestVisual{
    const visual={id,actor:{collision:{...body},clips:{}},container:{active:true,visible:true}};
    const position={...point};positions.set(visual,position);
    const actor:NavigationActor={shape:()=>visual.actor,position:()=>position,enabled:()=>visual.container.visible};
    actors.set(visual,actor);navigation.register(actor);return visual;
  }
  const hero=addVisual('player',{x:512,y:512});
  const moved:string[]=[],cancelled:string[]=[];let switches=0;
  const movement={
    navigation,
    position:(visual:TestVisual)=>({...positions.get(visual)!}),
    actor:(visual:TestVisual)=>actors.get(visual)!,
    place:(visual:TestVisual,point:Point)=>{
      const actor=actors.get(visual)!;
      assert.equal(navigation.terrainFree(point),true,'落点脚点必须可站');
      assert.equal(navigation.canPlaceBody(actor.shape(),point,actor),true,'落点整盒不能压地形或叠人');
      Object.assign(positions.get(visual)!,point);moved.push(visual.id);
    },
    stop:()=>{},
  };
  const party={activeIds:['player','companion','second'],controlledId:'companion',
    switchControl:()=>{switches+=1;return true;}};
  function ally(id:string,point:Point):TestAlly{
    const visual=addVisual(id,point);
    return {id,visual,member:{player:{health:50}},facing:'south',ai:{cancel(){cancelled.push(id);}}};
  }
  const allies=[ally('companion',{x:64,y:64}),ally('second',{x:600,y:600})];
  const state={app:{session:{party}},scene:{player:hero,facing:'south'},movement,allies,
    fallen:new Set<string>(),closed:false};
  const combat=Object.setPrototypeOf(state,WorldCombat.prototype) as unknown as InstanceType<typeof WorldCombat>;
  return {combat,navigation,positions,actors,party,hero,allies,moved,cancelled,fallen:state.fallen,
    switches:()=>switches};
}

test('regrouping pulls every living ally beside the hero without changing the controlled member',()=>{
  const f=fixture();
  f.combat.regroupPartyAroundHero();
  const hero=f.positions.get(f.hero)!;
  for(const member of f.allies){
    const point=f.positions.get(member.visual)!;
    assert.ok(Math.hypot(point.x-hero.x,point.y-hero.y)<=64,`${member.id} 离主角太远`);
  }
  assert.equal(f.party.controlledId,'companion','操控者保持重聚前的佣兵');
  assert.equal(f.switches(),0,'重聚不能切换操控者');
  assert.deepEqual(f.cancelled.sort(),['companion','second'],'移动前清掉旧寻路');
  assert.deepEqual(f.moved.sort(),['companion','second']);
});

test('a stuck follower is pulled beside the controlled member without moving the rest of the party',()=>{
  const f=fixture();f.party.controlledId='player';
  const follower=f.allies[1]!,other=f.allies[0]!;
  const otherBefore={...f.positions.get(other.visual)!};
  Reflect.get(WorldCombat.prototype,'catchUpFollower').call(f.combat,'second');
  const hero=f.positions.get(f.hero)!;
  const point=f.positions.get(follower.visual)!;
  assert.ok(Math.hypot(point.x-hero.x,point.y-hero.y)<=64,'收拢落点应该在队长身边');
  assert.ok(f.cancelled.includes('second'),'收拢前要清掉这名队员的旧寻路');
  assert.deepEqual(f.positions.get(other.visual),otherBefore,'只移动卡住的那名队员');
});

test('regrouping never places an ally on the other side of a wall',()=>{
  const f=fixture({wall:true});
  f.combat.regroupPartyAroundHero();
  const hero=f.positions.get(f.hero)!;
  for(const member of f.allies){
    const point=f.positions.get(member.visual)!;
    assert.ok(point.x>336,`${member.id} 被放到了墙另一侧`);
    // 落点已被这名队员占住；验证可达性时先把它从占位里拿掉。
    member.visual.container.visible=false;
    const reachable=f.navigation.path(f.actors.get(f.hero)!,point);
    member.visual.container.visible=true;
    assert.notEqual(reachable,null,'落点必须从主角处走得到');
    assert.ok(Math.hypot(point.x-hero.x,point.y-hero.y)<=64);
  }
});

test('a fallen ally stays where it fell while the rest regroup',()=>{
  const f=fixture(),fallen=f.allies[0]!;
  f.fallen.add(fallen.id);
  f.combat.regroupPartyAroundHero();
  assert.deepEqual(f.positions.get(fallen.visual),{x:64,y:64});
  assert.ok(!f.cancelled.includes(fallen.id),'倒下的成员不该被移动');
  assert.ok(f.moved.includes('second'));
});

test('a sealed map keeps the party in place instead of throwing',()=>{
  const f=fixture({sealed:true});
  assert.doesNotThrow(()=>f.combat.regroupPartyAroundHero());
  assert.deepEqual(f.moved,[]);
});

test('the party landing anchor is the hero, not the controlled mercenary',()=>{
  const f=fixture();
  const controlled=f.actors.get(f.allies[0]!.visual)!;
  const landing=Reflect.get(WorldCombat.prototype,'partyLanding').call(f.combat,controlled.shape(),controlled) as Point|undefined;
  assert.ok(landing);
  assert.ok(Math.hypot(landing.x-512,landing.y-512)<=48,'落点由主角位置决定');
  assert.ok(Math.hypot(landing.x-64,landing.y-64)>100,'不是围着被操控的佣兵');
});
