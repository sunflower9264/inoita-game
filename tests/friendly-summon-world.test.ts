import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {BattleCharacter} from '../src/domain/character-stats.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {EntityPlacement,EnemySpawn,MapExit,ActorDefinition,WorldMap} from '../src/domain/content.ts';
import {NavigationWorld} from '../src/domain/navigation-world.ts';
import {overlapsFootRect,type Point} from '../src/domain/navigation.ts';
import {canTraverse} from '../src/domain/pathfinding.ts';
import {Session} from '../src/domain/session.ts';
import {SummonCombatAwareness} from '../src/domain/summon-tactics.ts';
import {CHARACTER_ATLAS_ALIASES} from '../tools/character-atlas-aliases.ts';
import {loadCampaignCatalog,loadCharacterStatsCatalog,loadCompanionCatalog,loadItemCatalog} from './support/combat-test-harness.ts';
import {
  createFakeContainer,
  createFakeMovementWorld,
  createFakePhaserScene,
  createTestWorldCombat,
} from './support/world-combat-fixture.ts';

function normalizeActorClips(actor:ActorDefinition):void{
  for(const clip of Object.values(actor.clips)){
    for(const layer of clip?.layers??[]){
      if(layer.file)layer.file=CHARACTER_ATLAS_ALIASES[layer.file]??layer.file;
    }
  }
}

function normalizeBattleCatalog(raw:BattleCatalog):BattleCatalog{
  const copy=structuredClone(raw);
  for(const cls of copy.classes)normalizeActorClips(cls.actor);
  for(const enemy of copy.enemies)normalizeActorClips(enemy.actor);
  return copy;
}

const catalog=normalizeBattleCatalog(JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog);

async function summonWorldFixture(options:{
  walledColumn?:number;
  blockTiles?:(col:number,row:number)=>boolean;
  exits?:MapExit[];
  entities?:EntityPlacement[];
  enemySpawns?:EnemySpawn[];
  withCompanion?:boolean;
  withSummon?:boolean;
  playerAt?:Point;
  summonAt?:Point;
  customEnemyOverrides?:Record<string,Partial<BattleCatalog['enemies'][number]>>;
}={}){
  const battleCatalog=options.customEnemyOverrides
    ?{...catalog,enemies:catalog.enemies.map(enemy=>{
      const patch=options.customEnemyOverrides![enemy.id];
      return patch?{...enemy,...patch,behavior:{...enemy.behavior,...patch.behavior}}:enemy;
    })}
    :catalog;
  const blocked=Array<boolean>(4096).fill(false);
  // 地形在 NavigationWorld 构造时冻结，墙必须在建图前铺好。
  if(options.walledColumn!==undefined)for(let row=0;row<64;row++)blocked[row*64+options.walledColumn]=true;
  if(options.blockTiles)for(let row=0;row<64;row++)for(let col=0;col<64;col++)if(options.blockTiles(col,row))blocked[row*64+col]=true;
  const map:WorldMap={
    id:'summon-recall',name:'summon-recall',width:1024,height:1024,tileSize:16,columns:64,rows:64,
    blocked,ground:'',canopy:'',features:[],
    entities:options.entities??[],
    exits:options.exits??[],
    enemySpawns:options.enemySpawns??[],
  };
  const navigation=new NavigationWorld(map);
  const movement=createFakeMovementWorld(navigation);
  const items=loadItemCatalog(),statsCatalog=loadCharacterStatsCatalog();
  const campaign=loadCampaignCatalog(),companions=loadCompanionCatalog();
  const hero=new BattleCharacter('warlock',statsCatalog,items);
  hero.grantSkillPoint();
  const session=new Session(campaign,undefined,undefined,items,hero,battleCatalog,statsCatalog,companions);
  session.skills.maxAll();
  session.skills.bar().assign(0,0,{kind:'skill',id:'hell-s-pawn'});
  session.skills.bar().assign(0,1,{kind:'skill',id:'pain-overture'});
  let companionId:string|undefined;
  let extraActors:Record<string,unknown>={};
  if(options.withCompanion){
    session.bag.add('mercenary-emblem-black-knight');
    const ally=session.party!.recruit(session.bag.entries.find(e=>e.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
    session.party!.deployFirstAvailable(ally.id);
    companionId=ally.id;
    const allyActor=battleCatalog.classes.find(c=>c.id===ally.classId)!.actor;
    extraActors={[ally.definition.actor]:allyActor,[allyActor.id]:allyActor};
  }
  const heroActor=battleCatalog.classes.find(c=>c.id===hero.classId)!.actor;
  const startPos=options.playerAt??{x:512,y:512};
  const playerVisual={
    entity:{id:'player',actor:heroActor.id,x:startPos.x,y:startPos.y,flip:false},
    actor:heroActor,
    layers:[],
    container:createFakeContainer(startPos.x,startPos.y),
  } as never;
  const phaserScene=createFakePhaserScene({
    cameras:{main:{width:640,height:360,zoomX:1,zoomY:1,worldView:undefined,followOffset:{x:0,y:0},setFollowOffset(){}}},
    tweens:{add:()=>({stop(){},pause(){},resume(){}}),getTweensOf:()=>[],killTweensOf:()=>{}},
  });
  const origSprite=phaserScene.add.sprite.bind(phaserScene.add) as unknown as (...args:unknown[])=>{scene:unknown;anims:Record<string,unknown>};
  phaserScene.add.sprite=((...args:unknown[])=>{
    const sprite=origSprite(...args);
    sprite.scene=phaserScene;
    sprite.anims={...sprite.anims,create:()=>({destroy(){}}),remove:()=>{}};
    return sprite as never;
  }) as never;
  const world=await createTestWorldCombat({
    hero,session,map,movement,phaserScene,playerVisual,battleCatalog,
    appOverrides:{world:{actors:extraActors} as never},
  });
  await world.combat.start();

  const summonPos=options.summonAt??{x:64,y:64};
  let summonKey='';
  if(options.withSummon!==false){
    const base=world.combat.captureState();
    summonKey='summon';
    await world.combat.restoreState({
      ...base,
      roster:{
        enemies:[
          ...base.roster.enemies,
          {key:summonKey,enemyId:'enemy-hell-s-pawn-1',x:summonPos.x,y:summonPos.y,summonedBy:'player',summonedBySkill:'hell-s-pawn'},
        ],
        sequence:base.roster.sequence+1,
        partySize:session.party?.activeSize??1,
      },
      enemies:[
        ...base.enemies,
        {
          id:summonKey,facing:'south',summonRemainingMs:25_000,
          ai:{kind:'friendly-summon',state:{
            ownerId:'player',role:'hell-soldier',state:'idle',returning:false,clock:0,accumulator:0,
            nextDecisionAt:0,nextSearchAt:0,nextRecallAt:0,nextFollowSearchAt:0,targetSince:0,path:[],followActive:false,
            failedTargets:[],checkedTargets:[],fallbackTargets:[],farElapsed:0,stuckElapsed:0,followUnreachable:false,followSlot:0,
          }},
        },
      ],
      summonGroups:[['player',[summonKey]]],
    });
  }
  const visualOf=(id:string)=>[...movement.positions.keys()].find(v=>v.entity.id===id);
  const summonVisual=()=>visualOf(summonKey);
  const summonPosition=()=>summonVisual()?movement.position(summonVisual()!):undefined;
  const stepMs=(ms:number)=>{
    assert.equal(ms%60,0);
    const frames=ms/60;
    for(let i=0;i<frames;i++)world.combat.update(60,true);
  };
  return {
    world,combat:world.combat,session,hero,map,navigation,movement,companionId,summonKey,
    visualOf,summonVisual,summonPosition,stepMs,
    tactics:()=>{
      const diag=world.combat.diagnostics();
      if(!('awareness' in diag)||!diag.awareness)throw new Error('Combat closed');
      return diag.awareness;
    },
  };
}

test('an idle runtime still blocks recall while an enemy is pursuing any party member',async()=>{
  const wolf=catalog.enemies.find(e=>e.id==='enemy-wolf-1')!;
  const f=await summonWorldFixture({
    withCompanion:true,
    playerAt:{x:200,y:512},
    enemySpawns:[{id:'pursuer',enemyId:'enemy-wolf-1',x:520,y:540}],
    customEnemyOverrides:{'enemy-wolf-1':{maxHealth:99_999,behavior:{...wolf.behavior,aggression:'active',awarenessRangeUnits:8}}},
  });
  const allyVisual=f.visualOf(f.companionId!)!;
  f.movement.place(allyVisual,{x:508,y:532});
  f.stepMs(5760);
  assert.deepEqual(f.summonPosition(),{x:64,y:64});
  assert.equal(f.tactics().engagedTargetIds.includes('pursuer'),true);
  assert.ok(f.tactics().threats.some(entry=>entry.enemyId==='pursuer'&&entry.targetId===f.companionId));
  assert.equal(f.tactics().quietForMs,0);
  f.combat.destroy();
});

test('an idle enemy with old selection and threat records does not prevent safe recall',async()=>{
  const f=await summonWorldFixture({
    enemySpawns:[{id:'idle-monster',enemyId:'enemy-wolf-1',x:900,y:900}],
  });
  const base=f.combat.captureState();
  const cond=new CombatConditions();
  cond.applyState('player','stealthed',60_000,'player');
  await f.combat.restoreState({
    ...base,
    conditions:cond.captureState(),
    threat:{entries:[{ownerId:'idle-monster',sourceId:'player',score:50,updatedTick:0}]},
  });
  f.stepMs(6000);
  assert.deepEqual(f.tactics().engagedTargetIds,[]);
  const after=f.summonPosition()!;
  assert.notDeepEqual(after,{x:64,y:64});
  assert.ok(Math.hypot(after.x-512,after.y-512)<=64);
  f.combat.destroy();
});

test('world observation requires a continuous three seconds without hostile contact before recall',async t=>{
  t.mock.method(Math,'random',()=>0.5);
  const f=await summonWorldFixture({
    enemySpawns:[{id:'remote',enemyId:'enemy-wolf-1',x:528,y:512,respawn:false}],
  });
  f.stepMs(3000);
  assert.deepEqual(f.summonPosition(),{x:64,y:64});
  // 第 3000ms 时对远程怪发动一次真实命中，然后移除该怪，把最后一次真实交战锁在命中那一帧。
  f.combat.selectEnemy('remote');
  f.combat.attack();
  f.stepMs(240);
  f.session.enemyDefeated(f.world.roster.source('remote')!);
  f.combat.removeEnemy('remote');
  // 推进到距上次交战 2940ms：仍差 60ms 才满 3 秒脱战，不能召回。
  f.stepMs(2940);
  assert.equal(f.tactics().quietForMs,2940);
  assert.deepEqual(f.summonPosition(),{x:64,y:64});
  f.stepMs(60);
  assert.equal(f.tactics().quietForMs,3000);
  f.stepMs(120);
  assert.notDeepEqual(f.summonPosition(),{x:64,y:64});
  f.combat.destroy();
});

test('nearby hidden enemies cover both the old summon position and its owner position',async()=>{
  for(const position of [{x:96,y:64},{x:544,y:512}]){
    const f=await summonWorldFixture({
      enemySpawns:[{id:'hidden',enemyId:'enemy-wolf-1',x:position.x,y:position.y,respawn:false}],
    });
    const base=f.combat.captureState();
    const cond=new CombatConditions();
    cond.applyState('hidden','stealthed',60_000,'hidden');
    await f.combat.restoreState({...base,conditions:cond.captureState()});
    f.stepMs(6000);
    assert.deepEqual(f.summonPosition(),{x:64,y:64},'隐身敌人仍然阻止在其警戒范围内召回');
    f.session.enemyDefeated(f.world.roster.source('hidden')!);
    f.combat.removeEnemy('hidden');
    f.stepMs(240);
    assert.notDeepEqual(f.summonPosition(),{x:64,y:64},'已经死亡的敌人不再覆盖召回位置');
    f.combat.destroy();
  }
});

test('recall waits for runtime work, pause, story takeover and movement restrictions',async()=>{
  const f=await summonWorldFixture();
  // 在 4980ms 时施放自身增益（非敌对动作），保持 runtime 非空闲但 quietFor 继续累计超过 3 秒。
  f.stepMs(4980);
  f.combat.attack('pain-overture');
  f.stepMs(60);
  assert.deepEqual(f.summonPosition(),{x:64,y:64},'runtime 有未完成动作时不能召回');
  f.combat.update(10_000,false);
  assert.deepEqual(f.summonPosition(),{x:64,y:64},'暂停期间不能召回');
  await f.combat.normalizeForStory(new AbortController().signal);
  f.combat.update(10_000,false);
  assert.deepEqual(f.summonPosition(),{x:64,y:64},'剧情接管期间不能召回');

  // 眩晕（禁止行动）和定身（禁止移动）同样阻止召回；恢复后满足脱战与远距即刻召回。
  const f2=await summonWorldFixture();
  const base=f2.combat.captureState();
  const cond=new CombatConditions();
  cond.applyState(f2.summonKey,'stun',600,'enemy');
  await f2.combat.restoreState({...base,conditions:cond.captureState()});
  f2.stepMs(540);
  assert.deepEqual(f2.summonPosition(),{x:64,y:64},'眩晕期间不能召回');
  const condImm=new CombatConditions();
  condImm.applyState(f2.summonKey,'immobilized',600,'enemy');
  await f2.combat.restoreState({...f2.combat.captureState(),conditions:condImm.captureState()});
  f2.stepMs(540);
  assert.deepEqual(f2.summonPosition(),{x:64,y:64},'定身期间不能召回');
  f2.stepMs(5400);
  assert.notDeepEqual(f2.summonPosition(),{x:64,y:64},'限制解除且满足远距后正常召回');
  f.combat.destroy();
  f2.combat.destroy();
});

test('recall chooses a legal landing on the owners side of a wall without needing an origin route',async()=>{
  const f=await summonWorldFixture({walledColumn:34,summonAt:{x:800,y:512}});
  f.stepMs(6000);
  const point=f.summonPosition()!,owner=f.movement.position(f.world.playerVisual);
  const body=f.movement.actor(f.summonVisual()!),ownerBody=f.movement.actor(f.world.playerVisual);
  assert.ok(point.x<540,'落点不能在隔墙另一侧');
  assert.notDeepEqual(point,{x:800,y:512});
  const localFree=(p:Point)=>f.navigation.canPlace(body.shape(),p,body,[{actor:ownerBody,position:owner,enabled:false}]);
  assert.equal(canTraverse(owner,point,localFree),true);
  f.combat.destroy();
});

test('recall rejects occupied landing rings and map exits',async()=>{
  // 主角站在 (512, 512) 对应格子 (32, 32)；封死周围 (24..48px) 全部落点格。
  const occupied=await summonWorldFixture({
    blockTiles:(col,row)=>col>=28&&col<=36&&row>=28&&row<=36&&!(col===32&&row===32),
  });
  occupied.stepMs(6000);
  assert.deepEqual(occupied.summonPosition(),{x:64,y:64});
  occupied.combat.destroy();

  const exit=await summonWorldFixture({
    exits:[{destination:'other',x:440,y:440,width:144,height:144,spawn:{x:0,y:0},exitFacing:'south',facing:'south'}],
  });
  exit.stepMs(6000);
  assert.deepEqual(exit.summonPosition(),{x:64,y:64});
  exit.map.exits.length=0;
  exit.map.exits.push({destination:'other',x:525,y:465,width:50,height:94,spawn:{x:0,y:0},exitFacing:'south',facing:'south'});
  exit.stepMs(240);
  const point=exit.summonPosition()!;
  assert.notDeepEqual(point,{x:64,y:64});
  assert.ok(exit.map.exits.every(area=>!overlapsFootRect(point,area)));
  exit.combat.destroy();
});

test('recall keeps the same summon and all health, mana, effects, cooldowns and lifetime values',async()=>{
  const baseSummonDef=catalog.enemies.find(e=>e.id==='enemy-hell-s-pawn-1')!;
  const summonDef={...baseSummonDef,attributes:{...baseSummonDef.attributes,maxMana:50}};
  const f=await summonWorldFixture({
    customEnemyOverrides:{'enemy-hell-s-pawn-1':summonDef},
  });
  const beforeVisual=f.summonVisual()!;
  f.stepMs(4980);
  assert.deepEqual(f.summonPosition(),{x:64,y:64});
  f.world.roster.setEnemyHealth(f.summonKey,37,summonDef);
  f.world.roster.setEnemyMana(f.summonKey,12,summonDef);
  f.session.cooldowns.forActor(f.summonKey).start('command',17);
  const beforeRemaining=f.combat.captureState().enemies.find(e=>e.id===f.summonKey)!.summonRemainingMs!;
  f.stepMs(120);
  assert.notDeepEqual(f.summonPosition(),{x:64,y:64});
  assert.equal(f.summonVisual(),beforeVisual);
  const afterSnap=f.world.roster.enemySnapshot(f.summonKey,summonDef,f.hero.level)!;
  assert.equal(afterSnap.health,37);
  assert.equal(afterSnap.mana,12);
  assert.equal(f.session.cooldowns.forActor(f.summonKey).snapshot().command.remainingMs,17*60-120);
  const afterState=f.combat.captureState().enemies.find(e=>e.id===f.summonKey)!;
  assert.equal(afterState.summonRemainingMs,beforeRemaining-120);
  f.combat.destroy();
});

test('world adapters exclude mere selection, approach and a self buff with an old selected target',async t=>{
  t.mock.method(Math,'random',()=>0.5);
  const f=await summonWorldFixture({
    withSummon:false,
    playerAt:{x:512,y:512},
    enemySpawns:[{id:'unengaged',enemyId:'enemy-wolf-1',x:700,y:700}],
    customEnemyOverrides:{'enemy-wolf-1':{maxHealth:99_999,behavior:{...catalog.enemies.find(e=>e.id==='enemy-wolf-1')!.behavior,awarenessRangeUnits:1,canMove:false}}},
  });
  f.stepMs(960);
  f.combat.selectEnemy('unengaged');
  f.stepMs(960);
  assert.deepEqual(f.tactics().engagedTargetIds,[]);

  f.combat.attack();
  assert.equal(f.combat.attackState,'approaching');
  f.stepMs(960);
  assert.deepEqual(f.tactics().engagedTargetIds,[]);

  f.combat.attack('pain-overture');
  f.stepMs(960);
  assert.deepEqual(f.tactics().engagedTargetIds,[]);
  assert.equal(f.tactics().quietForMs,2880);

  f.movement.place(f.world.playerVisual,{x:688,y:700});
  f.combat.selectEnemy('unengaged');
  f.combat.attack();
  f.stepMs(960);
  assert.deepEqual(f.tactics().engagedTargetIds,['unengaged']);
  assert.equal(f.tactics().ownerTargetId,'unengaged');
  f.combat.destroy();
});

test('world observation preserves the summoners own target when control switches to another member',async t=>{
  t.mock.method(Math,'random',()=>0.5);
  const f=await summonWorldFixture({
    withCompanion:true,
    playerAt:{x:512,y:512},
    summonAt:{x:512,y:536},
    enemySpawns:[
      {id:'owner-target',enemyId:'enemy-wolf-1',x:524,y:512},
      {id:'other-target',enemyId:'enemy-wolf-1',x:640,y:512},
    ],
    customEnemyOverrides:{'enemy-wolf-1':{maxHealth:99_999,behavior:{...catalog.enemies.find(e=>e.id==='enemy-wolf-1')!.behavior,awarenessRangeUnits:1,canMove:false}}},
  });
  const observed:Array<ReturnType<SummonCombatAwareness['tactics']>>=[];
  const origTactics=SummonCombatAwareness.prototype.tactics;
  t.mock.method(SummonCombatAwareness.prototype,'tactics',function(this:SummonCombatAwareness,ownerId:string,partyIds:readonly string[],focus?:string){
    const result=origTactics.call(this,ownerId,partyIds,focus);
    if(ownerId==='player')observed.push(result);
    return result;
  });

  f.combat.selectEnemy('owner-target');
  f.combat.attack();
  f.stepMs(360);
  assert.equal(f.combat.switchControl(f.companionId!),true);
  f.movement.place(f.visualOf(f.companionId!)!,{x:628,y:512});
  f.combat.selectEnemy('other-target');
  for(let step=0;step<20&&f.combat.attackState==='idle';step++){
    f.combat.attack();
    if(f.combat.attackState==='idle')f.stepMs(60);
  }
  f.stepMs(960);

  const last=observed.at(-1)!;
  assert.equal(last.ownerTargetId,'owner-target');
  assert.ok(last.engagedTargetIds.includes('owner-target'));
  assert.ok(last.engagedTargetIds.includes('other-target'));
  f.combat.destroy();
});
