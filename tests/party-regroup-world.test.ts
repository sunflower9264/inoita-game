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
interface TestContainer { active:boolean; visible:boolean; setAlpha(value:number):TestContainer; setVisible(value:boolean):TestContainer }
interface TestVisual { id:string; actor:{collision:typeof body;clips:Record<string,never>}; container:TestContainer }
interface TestAlly { id:string; visual:TestVisual; member:{player:{health:number};clearCombatResourceLimits?():void}; facing:'south';
  ai:{cancel():void;actionState():string;selectedTargetId():string|undefined;reset?():void} }
interface TestEnemy { key:string; visual:TestVisual; facing:'south'; summonedBy?:string; summonRemainingMs?:number;
  controller?:{cancel():void;actionState():string} }

function fixture(options:{sealed?:boolean;wall?:boolean}={}){
  const blocked=Array<boolean>(40*40).fill(!!options.sealed);
  // 整列墙把地图分成左右两半，主角在右侧；墙另一侧的最近格心不能成为落点。
  if(options.wall)for(let row=0;row<40;row++)blocked[row*40+20]=true;
  const navigation=new NavigationWorld({name:'party-regroup',tileSize:16,columns:40,rows:40,blocked});
  const positions=new Map<TestVisual,Point>(),actors=new Map<TestVisual,NavigationActor>();
  function addVisual(id:string,point:Point):TestVisual{
    const container:TestContainer={active:true,visible:true,
      setAlpha(){return container;},setVisible(value){container.visible=value;return container;}};
    const visual={id,actor:{collision:{...body},clips:{}},container};
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
    placeAll:(values:{visual:TestVisual;position:Point}[])=>{
      for(const value of values){Object.assign(positions.get(value.visual)!,value.position);moved.push(value.visual.id);}
    },
    setEnabled:()=>{},
    stop:()=>{},
  };
  const party={activeIds:['player','companion','second'],controlledId:'companion',
    slotOf:(id:string)=>id==='companion'?0:id==='second'?1:undefined,
    switchControl:()=>{switches+=1;return true;}};
  function ally(id:string,point:Point):TestAlly{
    const visual=addVisual(id,point);
    return {id,visual,member:{player:{health:50}},facing:'south',ai:{cancel(){cancelled.push(id);},actionState:()=> 'idle',selectedTargetId:()=>undefined,reset(){}}};
  }
  const allies=[ally('companion',{x:64,y:64}),ally('second',{x:600,y:600})];
  const state={app:{session:{party}},scene:{player:hero,facing:'south'},movement,allies,
    formationOffsets:new Map<string,Point>(),
    arena:[] as TestEnemy[],pendingDefeats:new Set<string>(),fallen:new Set<string>(),closed:false};
  const combat=Object.setPrototypeOf(state,WorldCombat.prototype) as unknown as InstanceType<typeof WorldCombat>;
  return {combat,navigation,movement,positions,actors,party,hero,allies,moved,cancelled,fallen:state.fallen,app:state.app,
    addVisual,arena:state.arena,pendingDefeats:state.pendingDefeats,switches:()=>switches};
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

test('a far stuck follower is pulled beside the controlled member without moving the rest of the party',()=>{
  const f=fixture();f.party.controlledId='player';
  const follower=f.allies[1]!,other=f.allies[0]!;
  Object.assign(f.positions.get(follower.visual)!,{x:0,y:0});
  const otherBefore={...f.positions.get(other.visual)!};
  Reflect.get(WorldCombat.prototype,'catchUpFollower').call(f.combat,'second');
  const hero=f.positions.get(f.hero)!;
  const point=f.positions.get(follower.visual)!;
  assert.ok(Math.hypot(point.x-hero.x,point.y-hero.y)<=64,'收拢落点应该在队长身边');
  assert.ok(f.cancelled.includes('second'),'收拢前要清掉这名队员的旧寻路');
  assert.deepEqual(f.positions.get(other.visual),otherBefore,'只移动卡住的那名队员');
});

test('story settlement moves far or trapped allies and friendly summons, but not nearby or hostile units',()=>{
  const f=fixture();f.party.controlledId='player';
  Object.defineProperty(f.combat,'memberOf',{value:(id:string)=>id==='player'?{player:{health:100}}:undefined});
  Object.defineProperty(f.combat,'isActorAlive',{value:(id:string)=>id==='summon-1'});
  let summonCancels=0;
  const summonVisual=f.addVisual('summon',{x:80,y:80});
  f.arena.push({key:'summon-1',visual:summonVisual,facing:'south',summonedBy:'player',
    controller:{cancel(){summonCancels++;},actionState:()=> 'idle'}});
  const hostileVisual=f.addVisual('hostile',{x:300,y:300});
  f.arena.push({key:'hostile',visual:hostileVisual,facing:'south'});
  const near=f.allies[1]!,nearPosition=f.positions.get(near.visual)!;
  nearPosition.x=460;nearPosition.y=500;
  const far=f.allies[0]!,hostileBefore={...f.positions.get(hostileVisual)!};
  f.combat.settleFriendlyUnitsAroundHero();
  const hero=f.positions.get(f.hero)!;
  for(const visual of [far.visual,summonVisual]){
    const point=f.positions.get(visual)!;
    assert.ok(Math.hypot(point.x-hero.x,point.y-hero.y)<=64,`${visual.id} 应该被收拢到主角身边`);
  }
  assert.deepEqual(f.positions.get(near.visual),{x:460,y:500},'已经在主角身边的队员不移动');
  assert.deepEqual(f.positions.get(hostileVisual),hostileBefore,'敌对单位不受剧情收尾影响');
  assert.equal(summonCancels,1);
});

test('story settlement still pulls idle units when the handoff encounter is already active',()=>{
  const f=fixture();f.party.controlledId='player';
  Object.assign(f.app.session,{storyWorld:{activeEncounters:[{id:'event-242-battle',status:'active'}]}});
  const far=f.allies[0]!,before={...f.positions.get(far.visual)!};
  f.combat.settleFriendlyUnitsAroundHero();
  assert.notDeepEqual(f.positions.get(far.visual),before,'剧情开战时遭遇已 active，也不能吞掉闲置佣兵的收拢');
  const hero=f.positions.get(f.hero)!;
  const point=f.positions.get(far.visual)!;
  assert.ok(Math.hypot(point.x-hero.x,point.y-hero.y)<=64,'遭遇 active 但未交战时佣兵应回到主角身边');
  assert.ok(f.cancelled.includes(far.id),'收拢前要清掉旧寻路');
});

test('story settlement does not pull allies while a battle target is active',()=>{
  const f=fixture();f.party.controlledId='player';
  (f.combat as unknown as {focusTargetId?:string}).focusTargetId='enemy-target';
  const far=f.allies[0]!,before={...f.positions.get(far.visual)!};
  f.combat.settleFriendlyUnitsAroundHero();
  assert.deepEqual(f.positions.get(far.visual),before);
  assert.ok(!f.moved.includes(far.id));
});

test('stage-only hidden combat actors do not disable or move the formal battle enemy',()=>{
  const f=fixture();
  const visual=f.addVisual('enemy-shin',{x:100,y:100});
  f.arena.push({key:'enemy-shin',visual,facing:'south'});
  Object.defineProperty(f.combat,'isActorAlive',{value:()=>true});
  f.combat.adoptStoryPositions([
    {id:'enemy:enemy-shin',actor:'enemy-shin-1',enemyKey:'enemy-shin',x:200,y:200,facing:'south',visible:false,stageHidden:true},
  ]);
  assert.deepEqual(f.positions.get(visual),{x:100,y:100},'仅为舞台隐藏的敌人不能把正式敌人停用或挪走');
  assert.ok(!f.moved.includes('enemy-shin'));
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

test('follow goals use opposite formation slots and rotate smoothly with movement',()=>{
  const f=fixture();f.party.controlledId='player';
  const goal=(id:string)=>Reflect.get(WorldCombat.prototype,'partyFollowGoal').call(f.combat,id) as Point|undefined;
  const first=goal('companion'),second=goal('second');
  assert.ok(first&&second);
  assert.notDeepEqual(first,second);
  const hero=f.positions.get(f.hero)!;
  assert.ok(first.x<hero.x&&second.x>hero.x,'面朝南时两名佣兵分在左右');
  let previousFirstOffset={x:first.x-hero.x,y:first.y-hero.y};
  let previousSecondOffset={x:second.x-hero.x,y:second.y-hero.y};
  // 队长向北移动：队形要平滑转到另一侧，单步偏移不能跳过去。
  for(let step=0;step<10;step++){
    hero.y-=8;
    const nextFirst=goal('companion'),nextSecond=goal('second');
    assert.ok(nextFirst&&nextSecond);
    const firstOffset={x:nextFirst.x-hero.x,y:nextFirst.y-hero.y};
    const secondOffset={x:nextSecond.x-hero.x,y:nextSecond.y-hero.y};
    assert.ok(Math.hypot(firstOffset.x-previousFirstOffset.x,firstOffset.y-previousFirstOffset.y)<16,
      `换边要平滑，不能瞬移：${JSON.stringify(previousFirstOffset)} -> ${JSON.stringify(firstOffset)}`);
    assert.ok(Math.hypot(secondOffset.x-previousSecondOffset.x,secondOffset.y-previousSecondOffset.y)<16,
      `换边要平滑，不能瞬移：${JSON.stringify(previousSecondOffset)} -> ${JSON.stringify(secondOffset)}`);
    previousFirstOffset=firstOffset;previousSecondOffset=secondOffset;
  }
  assert.ok(previousFirstOffset.x>0&&previousSecondOffset.x<0,'向北走后队形转到另一侧');
});

test('a nearby stuck follower is re-pathed without teleporting',()=>{
  const f=fixture();f.party.controlledId='player';
  const follower=f.allies[1]!,before={...f.positions.get(follower.visual)!};
  Reflect.get(WorldCombat.prototype,'catchUpFollower').call(f.combat,'second');
  assert.deepEqual(f.positions.get(follower.visual),before);
  assert.ok(f.cancelled.includes('second'));
  assert.ok(!f.moved.includes('second'));
});

test('story settlement separates allies that already overlap the hero or each other',()=>{
  const f=fixture();f.party.controlledId='player';
  const heroPosition={...f.positions.get(f.hero)!};
  for(const ally of f.allies)Object.assign(f.positions.get(ally.visual)!,heroPosition);
  f.combat.settleFriendlyUnitsAroundHero();
  const points=[f.positions.get(f.hero)!,...f.allies.map(ally=>f.positions.get(ally.visual)!)];
  for(let left=0;left<points.length;left++)for(let right=left+1;right<points.length;right++)
    assert.ok(Math.abs(points[left]!.x-points[right]!.x)>=16||Math.abs(points[left]!.y-points[right]!.y)>=16,
      `单位 ${left}/${right} 仍然重叠`);
});

test('reviving two allies places them apart',()=>{
  const f=fixture();f.party.controlledId='player';
  const revived:string[]=[];
  for(const ally of f.allies){ally.member.player.health=1;ally.member.clearCombatResourceLimits=()=>{};}
  Object.defineProperty(f.combat,'visualOf',{value:(id:string)=>f.allies.find(ally=>ally.id===id)?.visual});
  Object.defineProperty(f.combat,'memberOf',{value:(id:string)=>f.allies.find(ally=>ally.id===id)?.member});
  Object.defineProperty(f.combat,'runtime',{value:{cancel(){}}});
  Object.assign(f.combat as unknown as Record<string,unknown>,{
    partyDefeatWork:new Map(),deathTweens:new Map(),dealtDamage:new Set(),
    conditions:{remove(){}},partyControllers:new Map(),outcomes:{recover(){}},
    app:{...f.app,session:{...f.app.session,reviveCombatActor:(id:string)=>revived.push(id)}},
    movement:{...f.movement,setEnabled(){}},
  });
  f.combat.reviveMember('companion');f.combat.reviveMember('second');
  const [first,second]=f.allies.map(ally=>f.positions.get(ally.visual)!);
  assert.ok(Math.abs(first!.x-second!.x)>=16||Math.abs(first!.y-second!.y)>=16,'两名复活的佣兵不能重叠');
  assert.deepEqual(revived,['companion','second']);
});
