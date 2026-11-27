import assert from 'node:assert/strict';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import type { ActorDefinition, WorldMap } from '../src/domain/content.ts';
import { FriendlySummonController } from '../src/domain/friendly-summon-ai.ts';
import { NavigationWorld } from '../src/domain/navigation-world.ts';
import type { Point } from '../src/domain/navigation.ts';
import { PartyController } from '../src/domain/party-ai.ts';
import { Session } from '../src/domain/session.ts';
import { CHARACTER_ATLAS_ALIASES } from '../tools/character-atlas-aliases.ts';
import {
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import {
  createFakeContainer,
  createFakeMovementWorld,
  createFakePhaserScene,
  createTestWorldCombat,
} from './support/world-combat-fixture.ts';

function normalizeActorClips(actor: ActorDefinition): void {
  for (const clip of Object.values(actor.clips)) {
    for (const layer of clip?.layers ?? []) {
      if (layer.file) layer.file = CHARACTER_ATLAS_ALIASES[layer.file] ?? layer.file;
    }
  }
}

function normalizeBattleCatalog(raw: BattleCatalog): BattleCatalog {
  const copy = structuredClone(raw);
  for (const cls of copy.classes) normalizeActorClips(cls.actor);
  for (const enemy of copy.enemies) normalizeActorClips(enemy.actor);
  return copy;
}

async function regroupFixture(options:{sealed?:boolean;wall?:boolean;enemySpawns?:WorldMap['enemySpawns'];heroClass?:string}={}){
  const battleCatalog=normalizeBattleCatalog(loadBattleCatalog()),items=loadItemCatalog(),statsCatalog=loadCharacterStatsCatalog();
  const campaign=loadCampaignCatalog(),companions=loadCompanionCatalog();
  const blocked=Array<boolean>(40*40).fill(!!options.sealed);
  // 整列墙把地图分成左右两半，主角在右侧；墙另一侧的最近格心不能成为落点。
  if(options.wall)for(let row=0;row<40;row++)blocked[row*40+20]=true;
  const map:WorldMap={
    id:'party-regroup',name:'party-regroup',width:640,height:640,tileSize:16,columns:40,rows:40,
    blocked,ground:'',canopy:'',features:[],entities:[],exits:[],enemySpawns:options.enemySpawns??[],
  };
  const navigation=new NavigationWorld(map);
  const movement=createFakeMovementWorld(navigation);
  const hero=new BattleCharacter(options.heroClass??'dark-knight',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog,statsCatalog,companions);
  if(options.heroClass==='warlock'){
    session.skills.maxAll();
    session.skills.bar().assign(0,0,{kind:'skill',id:'hell-s-pawn'});
  }
  session.bag.add('mercenary-emblem-black-knight');
  session.bag.add('mercenary-emblem-black-knight');
  const emblemId=()=>session.bag.entries.find(e=>e.item==='mercenary-emblem-black-knight')!.id;
  const first=session.party!.recruit(emblemId(),()=>0).member;
  const second=session.party!.recruit(emblemId(),()=>0).member;
  session.party!.deployFirstAvailable(first.id);
  session.party!.deployFirstAvailable(second.id);
  const heroActor=battleCatalog.classes.find(c=>c.id===hero.classId)!.actor;
  const allyActor=battleCatalog.classes.find(c=>c.id===first.classId)!.actor;
  const playerVisual={
    entity:{id:'player',actor:heroActor.id,x:512,y:512,flip:false},
    actor:heroActor,
    layers:[],
    container:createFakeContainer(512,512),
  } as never;
  const phaserScene=createFakePhaserScene({
    cameras:{main:{width:640,height:360,zoomX:1,zoomY:1,worldView:undefined,followOffset:{x:0,y:0},setFollowOffset(){}}},
    tweens:{add:()=>({stop(){},pause(){},resume(){}}),getTweensOf:()=>[],killTweensOf:()=>{}},
  });
  const world=await createTestWorldCombat({
    hero,session,map,movement,phaserScene,playerVisual,battleCatalog,
    appOverrides:{world:{actors:{[first.definition.actor]:allyActor,[second.definition.actor]:allyActor,[allyActor.id]:allyActor}} as never},
  });
  await world.combat.start();
  const findVisual=(id:string)=>{
    for(const visual of movement.positions.keys())if(visual.entity.id===id)return visual;
    return undefined;
  };
  const placeActor=(id:string,point:Point)=>{
    const visual=id==='player'?world.playerVisual:findVisual(id)!;
    movement.place(visual,point);
    return visual;
  };
  const positionOf=(id:string)=>{
    const visual=id==='player'?world.playerVisual:findVisual(id)!;
    return movement.position(visual);
  };
  if(!options.sealed){
    placeActor(first.id,{x:64,y:64});
    placeActor(second.id,{x:600,y:600});
  }
  movement.moved.length=0;
  return {world,combat:world.combat,session,party:session.party!,navigation,movement,hero,first,second,findVisual,placeActor,positionOf};
}

test('regrouping pulls every living ally beside the hero without changing the controlled member',async t=>{
  const f=await regroupFixture();
  assert.equal(f.combat.switchControl(f.first.id),true);
  f.placeActor(f.first.id,{x:64,y:64});
  f.placeActor(f.second.id,{x:600,y:600});
  let switches=0;
  const origSwitch=f.party.switchControl.bind(f.party);
  t.mock.method(f.party,'switchControl',(id:string)=>{switches++;return origSwitch(id);});
  const cancelled:string[]=[];
  const origCancel=PartyController.prototype.cancel;
  t.mock.method(PartyController.prototype,'cancel',function(this:PartyController){
    cancelled.push((this as unknown as {id:string}).id);
    return origCancel.call(this);
  });

  f.combat.regroupPartyAroundHero();
  const hero=f.positionOf('player');
  for(const id of [f.first.id,f.second.id]){
    const point=f.positionOf(id);
    assert.ok(Math.hypot(point.x-hero.x,point.y-hero.y)<=64,`${id} 离主角太远`);
  }
  assert.equal(f.party.controlledId,f.first.id,'操控者保持重聚前的佣兵');
  assert.equal(switches,0,'重聚不能切换操控者');
  assert.deepEqual(cancelled.sort(),[f.first.id,f.second.id].sort(),'移动前清掉旧寻路');
  f.combat.destroy();
});

test('setting a focus target does not cancel companion AI',async t=>{
  const f=await regroupFixture({enemySpawns:[{id:'enemy',enemyId:'enemy-wolf-1',x:200,y:200}]});
  const cancelled:string[]=[];
  const origCancel=PartyController.prototype.cancel;
  t.mock.method(PartyController.prototype,'cancel',function(this:PartyController){
    cancelled.push((this as unknown as {id:string}).id);
    return origCancel.call(this);
  });
  f.combat.focusTarget('enemy');
  assert.deepEqual(cancelled,[],'软集火只影响下一拍的目标优先级');
  f.combat.destroy();
});

test('a far stuck follower is pulled beside the controlled member without moving the rest of the party',async t=>{
  const f=await regroupFixture();
  const follower=f.second,other=f.first;
  f.placeActor('player',{x:380,y:512});
  f.placeActor(other.id,{x:490,y:512});
  f.placeActor(follower.id,{x:0,y:0});
  f.combat.update(60,true);
  const otherBefore=f.positionOf(other.id);
  const cancelled:string[]=[];
  const origCancel=PartyController.prototype.cancel;
  t.mock.method(PartyController.prototype,'cancel',function(this:PartyController){
    cancelled.push((this as unknown as {id:string}).id);
    return origCancel.call(this);
  });

  f.placeActor('player',{x:512,y:512});
  f.combat.update(60,true);
  const hero=f.positionOf('player');
  const point=f.positionOf(follower.id);
  assert.ok(Math.hypot(point.x-hero.x,point.y-hero.y)<=64,'收拢落点应该在队长身边');
  assert.ok(cancelled.includes(follower.id),'收拢前要清掉这名队员的旧寻路');
  assert.deepEqual(f.positionOf(other.id),otherBefore,'只移动卡住的那名队员');
  f.combat.destroy();
});

test('story settlement moves far or trapped allies and friendly summons, but not nearby or hostile units',async t=>{
  const f=await regroupFixture({heroClass:'warlock',enemySpawns:[{id:'hostile',enemyId:'enemy-wolf-1',x:300,y:300}]});
  f.combat.attack('hell-s-pawn');
  for(let step=0;step<5;step++)f.combat.update(60,true);
  const summon=f.world.roster.enemies.find(entry=>entry.summonedBy==='player')!;
  f.placeActor(summon.key,{x:80,y:80});
  f.placeActor(f.second.id,{x:460,y:500});
  f.placeActor(f.first.id,{x:64,y:64});
  let summonCancels=0;
  const origSummonCancel=FriendlySummonController.prototype.cancel;
  t.mock.method(FriendlySummonController.prototype,'cancel',function(this:FriendlySummonController){
    summonCancels++;
    return origSummonCancel.call(this);
  });
  const hostileBefore=f.positionOf('hostile');

  f.combat.settleFriendlyUnitsAroundHero();
  const hero=f.positionOf('player');
  for(const id of [f.first.id,summon.key]){
    const point=f.positionOf(id);
    assert.ok(Math.hypot(point.x-hero.x,point.y-hero.y)<=64,`${id} 应该被收拢到主角身边`);
  }
  assert.deepEqual(f.positionOf(f.second.id),{x:460,y:500},'已经在主角身边的队员不移动');
  assert.deepEqual(f.positionOf('hostile'),hostileBefore,'敌对单位不受剧情收尾影响');
  assert.equal(summonCancels,1);
  f.combat.destroy();
});

test('story settlement still pulls idle units when the handoff encounter is already active',async t=>{
  const f=await regroupFixture();
  f.session.applyStoryCommands([{
    type:'world',
    command:{
      kind:'encounter',
      encounter:{id:'event-242-battle',map:'party-regroup',status:'active',spawns:[]},
    },
  }]);
  const far=f.first,before=f.positionOf(far.id);
  const cancelled:string[]=[];
  const origCancel=PartyController.prototype.cancel;
  t.mock.method(PartyController.prototype,'cancel',function(this:PartyController){
    cancelled.push((this as unknown as {id:string}).id);
    return origCancel.call(this);
  });
  f.combat.settleFriendlyUnitsAroundHero();
  assert.notDeepEqual(f.positionOf(far.id),before,'剧情开战时遭遇已 active，也不能吞掉闲置佣兵的收拢');
  const hero=f.positionOf('player'),point=f.positionOf(far.id);
  assert.ok(Math.hypot(point.x-hero.x,point.y-hero.y)<=64,'遭遇 active 但未交战时佣兵应回到主角身边');
  assert.ok(cancelled.includes(far.id),'收拢前要清掉旧寻路');
  f.combat.destroy();
});

test('story settlement does not pull allies while a battle target is active',async()=>{
  const f=await regroupFixture({enemySpawns:[{id:'enemy-target',enemyId:'enemy-wolf-1',x:200,y:200}]});
  f.combat.focusTarget('enemy-target');
  const far=f.first,before=f.positionOf(far.id);
  f.movement.moved.length=0;
  f.combat.settleFriendlyUnitsAroundHero();
  assert.deepEqual(f.positionOf(far.id),before);
  assert.deepEqual(f.movement.moved,[]);
  f.combat.destroy();
});

test('stage-only hidden combat actors do not disable or move the formal battle enemy',async()=>{
  const f=await regroupFixture({enemySpawns:[{id:'enemy-shin',enemyId:'enemy-wolf-1',x:100,y:100}]});
  const visual=f.findVisual('enemy-shin')!;
  f.movement.moved.length=0;
  f.combat.adoptStoryPositions([
    {id:'enemy:enemy-shin',actor:'enemy-shin-1',enemyKey:'enemy-shin',x:200,y:200,facing:'south',visible:false,stageHidden:true},
  ]);
  assert.deepEqual(f.movement.position(visual),{x:100,y:100},'仅为舞台隐藏的敌人不能把正式敌人停用或挪走');
  assert.deepEqual(f.movement.moved,[]);
  f.combat.destroy();
});

test('regrouping never places an ally on the other side of a wall',async()=>{
  const f=await regroupFixture({wall:true});
  f.combat.regroupPartyAroundHero();
  const hero=f.positionOf('player');
  for(const id of [f.first.id,f.second.id]){
    const visual=f.findVisual(id)!;
    const point=f.positionOf(id);
    assert.ok(point.x>336,`${id} 被放到了墙另一侧`);
    // 落点已被这名队员占住；验证可达性时先把它从占位里拿掉。
    visual.container.visible=false;
    const reachable=f.navigation.path(f.movement.actor(f.world.playerVisual),point);
    visual.container.visible=true;
    assert.notEqual(reachable,null,'落点必须从主角处走得到');
    assert.ok(Math.hypot(point.x-hero.x,point.y-hero.y)<=64);
  }
  f.combat.destroy();
});

test('a fallen ally stays where it fell while the rest regroup',async t=>{
  const f=await regroupFixture();
  f.first.setHealth(0);
  f.combat.update(60,true);
  const fallenBefore=f.positionOf(f.first.id);
  const cancelled:string[]=[];
  const origCancel=PartyController.prototype.cancel;
  t.mock.method(PartyController.prototype,'cancel',function(this:PartyController){
    cancelled.push((this as unknown as {id:string}).id);
    return origCancel.call(this);
  });
  f.combat.regroupPartyAroundHero();
  assert.deepEqual(f.positionOf(f.first.id),fallenBefore);
  assert.ok(!cancelled.includes(f.first.id),'倒下的成员不该被移动');
  assert.ok(cancelled.includes(f.second.id));
  f.combat.destroy();
});

test('a sealed map keeps the party in place instead of throwing',async()=>{
  const f=await regroupFixture({sealed:true});
  f.movement.moved.length=0;
  assert.doesNotThrow(()=>f.combat.regroupPartyAroundHero());
  assert.deepEqual(f.movement.moved,[]);
  f.combat.destroy();
});

test('the party landing anchor is the hero, not the controlled mercenary',async()=>{
  const f=await regroupFixture();
  assert.equal(f.combat.switchControl(f.first.id),true);
  f.placeActor(f.first.id,{x:64,y:64});
  f.placeActor(f.second.id,{x:200,y:200});
  f.combat.regroupPartyAroundHero();
  const landing=f.positionOf(f.second.id);
  assert.ok(Math.hypot(landing.x-512,landing.y-512)<=64,'落点由主角位置决定');
  assert.ok(Math.hypot(landing.x-64,landing.y-64)>100,'不是围着被操控的佣兵');
  f.combat.destroy();
});

test('catch-up landing avoids the hero when a companion is controlled',async()=>{
  const f=await regroupFixture();
  assert.equal(f.combat.switchControl(f.first.id),true);
  f.placeActor(f.first.id,{x:250,y:100});
  f.placeActor(f.second.id,{x:600,y:600});
  // 操控 0 号佣兵时，1 号佣兵相对队长的后排侧位正好落在这里；主角站在同一个点上。
  f.placeActor('player',{x:76,y:64});
  f.combat.update(60,true);
  f.placeActor(f.first.id,{x:100,y:100});
  f.combat.update(60,true);
  const landing=f.positionOf(f.second.id),hero=f.positionOf('player');
  assert.notDeepEqual(landing,{x:600,y:600},'卡住补位应该真的移动');
  assert.ok(Math.abs(landing.x-hero.x)>=16||Math.abs(landing.y-hero.y)>=16,
    '补位落点不能和主角重叠');
  f.combat.destroy();
});

test('a stuck follower is placed beside the controlled member',async t=>{
  const f=await regroupFixture();
  const follower=f.second;
  f.placeActor(f.first.id,{x:500,y:512});
  f.placeActor(follower.id,{x:0,y:0});
  const before=f.positionOf(follower.id);
  const cancelled:string[]=[];
  const origCancel=PartyController.prototype.cancel;
  t.mock.method(PartyController.prototype,'cancel',function(this:PartyController){
    cancelled.push((this as unknown as {id:string}).id);
    return origCancel.call(this);
  });
  for(let step=0;step<90&&!cancelled.includes(follower.id);step++)f.combat.update(60,true);
  assert.notDeepEqual(f.positionOf(follower.id),before);
  assert.ok(cancelled.includes(follower.id));
  f.combat.destroy();
});

test('a second regroup within the cooldown does not move the follower again',async()=>{
  const f=await regroupFixture();
  const follower=f.second,before=f.positionOf(follower.id);
  f.placeActor('player',{x:200,y:512});
  f.placeActor(follower.id,{x:0,y:0});
  f.combat.update(60,true);
  f.placeActor('player',{x:512,y:512});
  f.combat.update(60,true);
  const afterFirst=f.positionOf(follower.id);
  assert.notDeepEqual(afterFirst,before);
  f.combat.update(1000,true);
  f.placeActor('player',{x:120,y:512});
  f.combat.update(60,true);
  assert.deepEqual(f.positionOf(follower.id),afterFirst);
  f.combat.destroy();
});

test('story settlement separates allies that already overlap the hero or each other',async()=>{
  const f=await regroupFixture();
  const heroPosition=f.positionOf('player');
  for(const id of [f.first.id,f.second.id])f.placeActor(id,heroPosition);
  f.combat.settleFriendlyUnitsAroundHero();
  const points=[f.positionOf('player'),f.positionOf(f.first.id),f.positionOf(f.second.id)];
  for(let left=0;left<points.length;left++)for(let right=left+1;right<points.length;right++)
    assert.ok(Math.abs(points[left]!.x-points[right]!.x)>=16||Math.abs(points[left]!.y-points[right]!.y)>=16,
      `单位 ${left}/${right} 仍然重叠`);
  f.combat.destroy();
});

test('reviving two allies places them apart',async()=>{
  const f=await regroupFixture();
  f.first.setHealth(0);f.second.setHealth(0);
  f.combat.update(60,true);
  f.first.setHealth(1);f.second.setHealth(1);
  f.combat.reviveMember(f.first.id);
  f.combat.reviveMember(f.second.id);
  const first=f.positionOf(f.first.id),second=f.positionOf(f.second.id);
  assert.ok(Math.abs(first.x-second.x)>=16||Math.abs(first.y-second.y)>=16,'两名复活的佣兵不能重叠');
  f.combat.destroy();
});

test('the AI-controlled hero can recover beside a controlled mercenary',async()=>{
  const f=await regroupFixture();
  assert.equal(f.combat.switchControl(f.first.id),true);
  f.placeActor('player',{x:64,y:64});
  f.placeActor(f.first.id,{x:350,y:512});
  f.combat.update(60,true);
  f.placeActor(f.first.id,{x:512,y:512});
  f.combat.update(60,true);
  assert.notDeepEqual(f.positionOf('player'),{x:64,y:64});
  assert.ok(Math.hypot(f.positionOf('player').x-512,f.positionOf('player').y-512)<=64);
  assert.notDeepEqual(f.positionOf('player'),f.positionOf(f.first.id));
  f.combat.destroy();
});
