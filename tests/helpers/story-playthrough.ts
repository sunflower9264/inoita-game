import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBattle, parseCampaign, parseCharacterStats, parseCompanions, parseItemCatalog, parseStoryClasses, parseWorld } from '../../src/application/content-validation.ts';
import type { EntityPlacement, MapExit, WorldMap } from '../../src/domain/content.ts';
import { NavigationWorld } from '../../src/domain/navigation-world.ts';
import { canTraverse } from '../../src/domain/pathfinding.ts';
import { ExitTrigger, overlapsFootRect, within, type Point } from '../../src/domain/navigation.ts';
import { WorldTriggerCoordinator, type TriggerCharacter } from '../../src/scenes/world-triggers.ts';
import { nearInteractive } from '../../src/domain/chests.ts';
import { newStorySession } from '../../src/domain/story-class.ts';
import { StoryDirector, type StoryUI } from '../../src/domain/story-director.ts';
import { type PerformanceAction, type StoryPresentationPort, type StoryStage, type StoryStageSnapshot } from '../../src/domain/story-performance.ts';
import { resolveStoryScene, applyStorySceneAction, hidePendingEntrances } from '../../src/domain/story-scene.ts';
import { assertUniqueActorInstances } from '../../src/domain/actor-census.ts';
import { assertScenePlan, planScene } from '../../src/domain/scene-plan.ts';
import { prepareSceneVisit } from '../../src/domain/scene-visit.ts';
import { authoredPlacements, baseMapEntities } from '../../src/domain/map-placement.ts';
import { parseSprings } from '../../src/domain/springs.ts';
import type { SceneSnapshot } from '../../src/domain/scene-snapshot.ts';
import { WorldEnemyRoster } from '../../src/domain/world-enemies.ts';
import { QuestEnemyWatch } from '../../src/domain/quest-enemies.ts';
import { parseDrops, rollQuestDrops } from '../../src/domain/drops.ts';
import { groundLootFor } from '../../src/domain/ground-loot.ts';
import type { SessionState } from '../../src/domain/session.ts';
import { calculateEnemy } from '../../src/domain/enemy-stats.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL('../../public/content/'+name+'.json',import.meta.url),'utf8'));
const campaign=parseCampaign(read('campaign')),world=parseWorld(read('world'));
const items=parseItemCatalog(read('items')),stats=parseCharacterStats(read('character-stats')),battle=parseBattle(read('battle'));
const classes=parseStoryClasses(read('story-classes')),companions=parseCompanions(read('companions'));
const drops=parseDrops(read('drops'),items,battle.enemies.map(enemy=>enemy.id));
const springs=parseSprings(read('springs'));
const maps=new Map(world.maps.map(ref=>[ref.id,read('maps/'+ref.id) as WorldMap]));
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
/** 无头回放测试共用同一份解析后的内容。 */
export const headlessContent={campaign,world,maps,items,battle,stats,storyClasses:classes,companions};

/** Runs the real director and session. Only elapsed presentation time and combat damage are omitted. */
export function playthrough(saved?:SessionState){
  const session=newStorySession(campaign,world.actors[campaign.start.actor],classes.classes[0],items,stats,battle,companions);
  if(saved)session.restoreState(saved);
  const questEnemies=new QuestEnemyWatch(session,drops.questItems);
  let stage:StoryStageSnapshot|undefined,choiceQueue:string[]=['option-3'],worldNeedsLanding=false;
  const scenes=new Map<string,SceneSnapshot>(),committedScenes=new Map<string,SceneSnapshot>();
  const remember=()=>{if(stage)scenes.set(stage.map,structuredClone(stage.scene));};
  const lines:string[]=[],popups:string[]=[],actions:PerformanceAction[]=[],errors:unknown[]=[];
  const entities=():EntityPlacement[]=>{
    const map=maps.get(session.storyWorld.currentLocation!.map)!;
    const authored=authoredPlacements(map,campaign);
    const base=baseMapEntities(map,campaign,entity=>session.visible(entity));
    return session.storyWorld.projectEntities(map.id,[...base,...authored],campaign.placements)
      .filter(entity=>session.storyWorld.visible(entity.id)&&(!('condition' in entity)||session.evaluateCondition(entity.condition as import('../../src/domain/story-condition.ts').StoryCondition)));
  };
  const capture=(declaration?:StoryStage):SceneSnapshot=>{
    const location=session.storyWorld.currentLocation!;
    const map=declaration&&!declaration.mapFromWorld?declaration.map:location.map;
    const player=map===location.map?location:declaration!;
    return prepareSceneVisit({session,campaign,world,battleCatalog:battle,drops,springs},maps.get(map)!,
      {id:'player',actor:campaign.start.actor,x:player.x,y:player.y,facing:player.facing,visible:true},()=>0.5);
  };
  const resolve=(declaration:StoryStage):StoryStageSnapshot=>{
    remember();
    const sameMap=stage&&(declaration.mapFromWorld||declaration.map===stage.map)&&!declaration.resetActors;
    const map=declaration.mapFromWorld?stage?.map??session.storyWorld.currentLocation!.map:declaration.map;
    const scene=sameMap?stage!.scene:!declaration.resetActors&&scenes.has(map)?scenes.get(map)!:capture(declaration);
    if(!committedScenes.has(map)||declaration.resetActors)committedScenes.set(map,structuredClone(scene));
    return resolveStoryScene(declaration,scene);
  };
  const presentation:StoryPresentationPort={
    begin(_signal,restored){
      stage=undefined;scenes.clear();committedScenes.clear();
      stage=restored&&'scene' in restored?structuredClone(restored):resolve(restored??{
        type:'stage',...session.storyWorld.currentLocation!,playerVisible:true,cast:[]});
      remember();committedScenes.set(stage.map,structuredClone(stage.scene));
      assertUniqueActorInstances(stage.scene.actors,`剧情舞台 ${stage.map}/begin`);
      assertScenePlan(planScene(stage.scene,stage.bindings));
    },
    async execute(action, _playback?, pendingEntrances?){
      actions.push(action);
      if(action.type==='stage'){
        stage=resolve(action);
        if(pendingEntrances?.length)stage=hidePendingEntrances(stage,action,pendingEntrances);
      }
      else if(stage)stage=applyStorySceneAction(stage,action);
      if(stage){
        assertUniqueActorInstances(stage.scene.actors,`剧情舞台 ${stage.map}/${action.type}`);
        assertScenePlan(planScene(stage.scene,stage.bindings));
      }
    },
    // 失败重试与读档恢复共用这条入口：与真实 presenter 一样，用快照重建已访问地图清单，
    // 而不是只把演员名单塞回去。以前缺少这一项，重试会静默跳过场景恢复。
    async restoreStage(saved){
      stage=structuredClone(saved);
      scenes.clear();
      for(const scene of saved.scenes??[])scenes.set(scene.map,structuredClone(scene));
      scenes.set(saved.map,structuredClone(saved.scene));
      committedScenes.clear();
      for(const [map,scene] of scenes)committedScenes.set(map,structuredClone(scene));
      assertUniqueActorInstances(stage.scene.actors,`剧情舞台 ${stage.map}/restore`);
      assertScenePlan(planScene(stage.scene,stage.bindings));
    },
    getStageState(){return stage?structuredClone(stage):undefined;},
    getWorldChanges(){
      remember();
      return [...scenes].flatMap(([map,scene])=>scene.actors.flatMap(actor=>{
        if(!actor.worldEntityId||actor.unpositioned||actor.stageHidden)return [];
        const previous=committedScenes.get(map)?.actors.find(value=>value.id===actor.id);
        if(previous&&previous.worldEntityId===actor.worldEntityId&&previous.actor===actor.actor
          &&previous.x===actor.x&&previous.y===actor.y&&previous.facing===actor.facing&&previous.visible===actor.visible)return [];
        return [{id:actor.worldEntityId,map,actor:actor.actor,characterId:actor.characterId,
          x:actor.x,y:actor.y,facing:actor.facing,visible:actor.visible}];
      }));
    },
    committed(){remember();committedScenes.clear();for(const [map,scene] of scenes)committedScenes.set(map,structuredClone(scene));},
    async finish(){},release(){worldNeedsLanding=!!stage;stage=undefined;scenes.clear();committedScenes.clear();}
  };
  const ui:StoryUI={async dialogue(line){lines.push(line.text);},async choice(_prompt,options){
    // 排队的值命中某个选项时优先用它：跟一个 NPC 说话时菜单项是任务号，这样才能指名接哪一条。
    // 队首不在本次选项里、但队列后面有能命中的值，说明这一次没有对应的选择点
    // （典型例子：NPC 只有一个任务时不弹多任务菜单），跳过队首继续找。
    while(choiceQueue.length>0){
      const queued=choiceQueue[0];
      const hit=options.find(option=>option.value===queued);
      if(hit){choiceQueue.shift();return hit;}
      if(!choiceQueue.slice(1).some(value=>options.some(option=>option.value===value)))break;
      choiceQueue.shift();
    }
    // 原版 NPC 菜单只执行任务槽 0，不会把多个任务做成「选择 / 离开」列表。
    if(options.some(option=>option.value==='leave'))assert.fail('NPC 任务选择菜单不应出现');
    const next=choiceQueue.shift();return options.find(option=>option.value===next)??options.at(-1)!;
  },async questPopup(kind,quest){popups.push(kind+':'+quest.id);},closeDialogue(){},skipDialogue(){}};
  const director=new StoryDirector(campaign,session,ui,()=>{},presentation);
  director.onError=error=>errors.push(error);
  // 每次建场都按 WorldScene 的出生落位规则修正玩家：出口给的 spawn 可能压在巨石或人物身上，
  // 正式场景会在整盒站不住时换到最近的合法落点。落点本来就合法时扫描原样返回，不会挪人。
  const landPlayer=()=>{
    const location=session.storyWorld.currentLocation!,map=maps.get(location.map)!;
    const navigation=new NavigationWorld(map);
    for(const entity of entities())navigation.register({position:()=>entity,shape:()=>world.actors[entity.actor],enabled:()=>true});
    const shape=world.actors[campaign.start.actor];
    const point=navigation.nearestBody(shape,location)??navigation.nearest(shape,location);
    session.movePlayer({...location,...point});
  };
  const idle=async()=>{for(let count=0;count<1000;count++){
    await tick();if(errors.length)throw errors[0];
    if(!director.busy){await tick();if(!director.busy){
      const location=session.storyWorld.currentLocation!,map=maps.get(location.map)!;
      session.enterMap(map.id,map.questItemSpawns??[],map);
      // 演出期间人物互不阻挡；回到正式世界时按正式建场规则落位。
      if(worldNeedsLanding){worldNeedsLanding=false;landPlayer();}
      return;
    }}
  }throw new Error('剧情队列未停止');};
  if(!saved)session.applyStoryCommands([{type:'travel',destination:{...campaign.start,facing:'south'}}]);
  // 找得到就返回那个落脚点，不移动玩家。
  const findPoint=(goal:(point:Point)=>boolean,standable=true):Point|undefined=>{
    const location=session.storyWorld.currentLocation!,map=maps.get(location.map)!;
    const navigation=new NavigationWorld(map);
    const player={position:()=>location,shape:()=>world.actors[campaign.start.actor],enabled:()=>true};
    navigation.register(player);
    for(const entity of entities())navigation.register({position:()=>entity,shape:()=>world.actors[entity.actor],enabled:()=>true});
    const scanCandidates=(checkPath:boolean):Point|undefined=>{
      const candidates:Point[]=[];
      for(let y=4;y<map.height;y+=8)for(let x=4;x<map.width;x+=8)if(goal({x,y}))candidates.push({x,y});
      candidates.sort((a,b)=>Math.hypot(a.x-location.x,a.y-location.y)-Math.hypot(b.x-location.x,b.y-location.y));
      if(!checkPath)return candidates[0];
      for(const point of candidates)if(navigation.path(player,point))return point;
      return undefined;
    };
    if(!standable){
      // 只检查目标形状、不要求可站立：区域本身压在出口格或墙上时用这条。
      return scanCandidates(false);
    }
    // 在原扫描用的 8px 网格上做一次可达性 BFS，再取欧氏距离最近的目标点。
    // 原实现为每个候选点单独跑 A*；目标不可达时会做上千次整图搜索，
    // 单次 walk 就能把整条用例拖到几十分钟。
    const step=8,lattice=(point:Point):Point=>({x:4+Math.round((point.x-4)/step)*step,y:4+Math.round((point.y-4)/step)*step});
    const free=(point:Point)=>navigation.canStand(player,point);
    const start=lattice(location);
    if(!free(start)||!canTraverse(location,start,free))return scanCandidates(true);
    const reachable=new Set<string>([`${start.x},${start.y}`]),queue:Point[]=[start];
    for(let at=0;at<queue.length;at++){
      const current=queue[at]!;
      for(const [dx,dy] of [[step,0],[-step,0],[0,step],[0,-step],[step,step],[step,-step],[-step,step],[-step,-step]]){
        const next={x:current.x+dx,y:current.y+dy};
        if(next.x<4||next.y<4||next.x>=map.width||next.y>=map.height)continue;
        const key=`${next.x},${next.y}`;
        if(reachable.has(key)||!free(next)||!canTraverse(current,next,free))continue;
        reachable.add(key);queue.push(next);
      }
    }
    let best:Point|undefined,bestDistance=Infinity;
    for(let y=4;y<map.height;y+=step)for(let x=4;x<map.width;x+=step){
      if(!reachable.has(`${x},${y}`)||!goal({x,y}))continue;
      const distance=Math.hypot(x-location.x,y-location.y);
      if(distance<bestDistance){bestDistance=distance;best={x,y};}
    }
    return best;
  };
  // 触发层跑纯 TS 的 WorldTriggerCoordinator：区域／近身／出口的判定顺序、占用表与条件求值与
  // WorldScene.afterMovement 完全同源。渲染、物理、UI 与切图重建是桩——这里要验的是「这一帧该不该触发、该触发哪一个」。
  interface SceneHost {
    map: WorldMap;
    characters: TriggerCharacter[];
    player: {container:{x:number;y:number}};
    combat: {roster?:WorldEnemyRoster};
    exitTrigger: ExitTrigger<MapExit> | undefined;
    update(time:number, delta:number):void;
  }
  let visit:{mapId:string;occupied:Set<string>;app:Record<string,unknown>;host:SceneHost;triggers:WorldTriggerCoordinator;step:(events:typeof campaign.events)=>void}|undefined;
  let requestedExit:MapExit|undefined,firedExit:MapExit|undefined;
  const enterVisit=():void=>{
    const location=session.storyWorld.currentLocation!,map=maps.get(location.map)!;
    if(visit?.mapId===map.id)return;
    // 切图会重建场景，占用表随之清空——真实场景在 create 时也是这么做的。
    const triggers=new WorldTriggerCoordinator();
    triggers.setExitTrigger(map.exits??[],{x:location.x,y:location.y},false);
    let lastPlayerPosition={x:location.x,y:location.y};
    const playStory=(work:()=>Promise<boolean>)=>{void work().catch(error=>errors.push(error));};
    const app={session,campaign,director,ui:{...ui,ready:true,controlLayoutEditing:false},locked:false,suspended:false};
    const host:SceneHost={
      map,characters:[],
      player:{container:{x:location.x,y:location.y}},
      combat:{roster:undefined},
      get exitTrigger(){return triggers.exitTrigger;},
      set exitTrigger(value){triggers.exitTrigger=value;},
      update(){triggers.settleCompletedEncounters(true,director,host.combat.roster?.completedEncounters(),playStory);},
    };
    const step=(events:typeof campaign.events)=>{
      const current=session.storyWorld.currentLocation!;
      const pos={x:current.x,y:current.y};
      const previous=lastPlayerPosition;
      const moving=Math.hypot(pos.x-previous.x,pos.y-previous.y)>.01;
      lastPlayerPosition=pos;
      triggers.stepAfterMovement({
        map:host.map,
        campaign:{...campaign,events},
        session,
        director,
        characters:host.characters,
        pos,
        moving,
        playStory,
        onExit:(exit:MapExit)=>{
          firedExit=exit;
          session.applyStoryCommands([{type:'travel',destination:{map:exit.destination,...exit.spawn,facing:exit.facing==='any'?'south':exit.facing}}]);
          requestedExit=exit;
        },
      });
    };
    visit={mapId:map.id,occupied:triggers.occupiedTriggers,app,host,triggers,step};
  };
  const afterMovement=(scope:'none'|'near'|'all'='none',only?:string|readonly string[]):void=>{
    enterVisit();
    const location=session.storyWorld.currentLocation!,host=visit!.host;
    // 这一帧放行哪些触发由调用方决定：辅助器的 walk 只负责把玩家带到某处，
    // 让半路的戏把脚本化走位截走会让每个用例的时序都不可预期。
    // `region` 要验的是门口竞争，用 all；`approach` 要验的是走近就起演，用 near；
    // 其余（travel／pickup）只走出口触发，用 none。
    // only 用来把放行范围收窄到某一个事件：走到它的区域不该顺手点燃沿途别的戏。
    const wanted=typeof only==='string'?[only]:only;
    const events=wanted?campaign.events.filter(event=>wanted.includes(event.id))
      :scope==='all'?campaign.events
      :scope==='near'?campaign.events.filter(event=>event.source==='near'):[];
    host.map=maps.get(location.map)!;
    host.characters=entities().map(entity=>({entity,actor:world.actors[entity.actor],
      container:{x:entity.x,y:entity.y,visible:true}}));
    host.player.container.x=location.x;host.player.container.y=location.y;
    visit!.step(events);
  };
  const updateWorld = async (roster: WorldEnemyRoster) => {
    enterVisit();
    const host = visit!.host;
    host.combat.roster = roster;
    host.update(0, 0);
    await idle();
  };
  /** 分步走过一段直线，每一步都跑真实的 afterMovement。返回 true 表示途中切了图。 */
  const stride=async(to:Point,scope:'none'|'near'|'all'='none',only?:string|readonly string[],quiet:'none'|'transit'|'all'='none'):Promise<boolean>=>{
    const start={...session.storyWorld.currentLocation!};
    const distance=Math.hypot(to.x-start.x,to.y-start.y);
    const direction=distance>.01?{x:(to.x-start.x)/distance,y:(to.y-start.y)/distance}:{x:1,y:0};
    // 出口触发要两个条件：这一帧确实在移动（`ExitTrigger.update` 的 moving），
    // 且出生保护已解除（出生点压在出口格上时要先走出去）。
    // 剧情把玩家直接送进出口格、或者目标就在脚下时这两条都不成立，真实游戏里玩家是走进来的。
    // 所以短距离时先退到 24 像素外（脚底矩形半径 8 再加上一格，退 8 仍会碰到出口格），再走进去。
    const runUp=24;
    const origin=distance>=runUp?start:{x:Math.round(to.x-direction.x*runUp),y:Math.round(to.y-direction.y*runUp)};
    if(origin.x!==start.x||origin.y!==start.y){
      session.applyStoryCommands([{type:'travel',destination:{...session.storyWorld.currentLocation!,...origin}}]);
      if(quiet==='none')afterMovement(scope,only);
      else{
        // 退到起步点时也别让脚下的门生效：这一步只是为走进目标做准备。
        enterVisit();
        const host=visit!.host as unknown as {exitTrigger:unknown},saved=host.exitTrigger;
        host.exitTrigger=new ExitTrigger([],{x:origin.x,y:origin.y});
        try{afterMovement(scope,only);}finally{host.exitTrigger=saved;}
      }
      if(requestedExit){const exit=requestedExit;requestedExit=undefined;visit=undefined;
        const arrived=maps.get(exit.destination)!;
        session.enterMap(exit.destination,arrived.questItemSpawns??[],arrived);
        landPlayer();
        await director.enterMap(exit.destination);await idle();return true;}
    }
    const span=Math.hypot(to.x-origin.x,to.y-origin.y);
    // 上限防止病态输入把整轮测试拖死；正常走位都在几十步以内。
    const steps=Math.max(1,Math.min(400,Math.ceil(span/8)));
    enterVisit();
    const host=visit!.host as unknown as {exitTrigger:unknown},savedTrigger=host.exitTrigger;
    // 起步点可能正压在出口上：先用「没有移动」的一帧让触发器重新上膛。
    // 否则上面收起出口的起步/途中帧不会经过它，出生保护会一直把最后一帧锁住。
    if(quiet!=='none')(savedTrigger as {update?:(point:Point,moving:boolean)=>unknown}).update?.(origin,false);
    for(let index=1;index<=steps;index++){
      // 途中把出口收起来：穿过别的门会被传送走，目的地的事件就轮不到了。
      // 最后一帧恢复真实出口——发生在门口的那次判定必须是真的。
      if(quiet!=='none')host.exitTrigger=quiet==='transit'&&index===steps?savedTrigger:new ExitTrigger([],{x:origin.x,y:origin.y});
      const point={x:Math.round(origin.x+(to.x-origin.x)*index/steps),y:Math.round(origin.y+(to.y-origin.y)*index/steps)};
      const before=session.storyWorld.currentLocation!;
      // 逐步走位只是位置推进，真实运行时不经过剧情命令批次（玩家位置由 Arcade 物理推进），
      // 所以走 `movePlayer` 这条同一段簿记的轻通路；触发层仍在下一行按真实帧序跑。
      session.movePlayer({...before,...point});
      afterMovement(scope,only);
      if(requestedExit){
        const exit=requestedExit;requestedExit=undefined;visit=undefined;
        const arrived=maps.get(exit.destination)!;
        session.enterMap(exit.destination,arrived.questItemSpawns??[],arrived);
        landPlayer();
        await director.enterMap(exit.destination);await idle();return true;
      }
      // 剧情可能在这一帧把玩家送去别的舞台：继续按原路径走会把它的落点覆盖掉。
      const after=session.storyWorld.currentLocation!;
      if(after.map!==before.map||Math.hypot(after.x-point.x,after.y-point.y)>1){await idle();return true;}
      if(director.busy)await idle();
    }
    if(quiet!=='none')host.exitTrigger=savedTrigger;
    return false;
  };
  const walkTo=async(goal:(point:Point)=>boolean,scope:'none'|'near'|'all'='none',only?:string|readonly string[],quiet:'none'|'transit'|'all'='transit'):Promise<boolean>=>{
    const point=findPoint(goal);if(!point)return false;
    // 途中收起别的出口：直线走过去可能穿过一扇无关的门，把玩家送进另一个房间。
    // 走向 NPC 时连最后一帧也收起（`all`）；走向出口时最后一帧恢复真实出口（`transit`）。
    await stride(point,scope,only,quiet);return true;
  };
  /**
   * 走到指定的那一个出口。走过去时只让这个出口生效：地图上别的门如果被脚底矩形碰到，
   * 场景会按出口表顺序把玩家带去别处（矮人村去矿区的路上会穿过村长之家那扇门）。
   * 到门口那一帧的判定仍然是真实的——出生保护、是否在移动、区域与出口的先后顺序都不变。
   */
  const approachExit=async(exit:WorldMap['exits'][number]):Promise<void>=>{
    enterVisit();
    const host=visit!.host as unknown as {exitTrigger:unknown};
    const saved=host.exitTrigger,location=session.storyWorld.currentLocation!;
    // 只能走目标出口，但同图自指向出口是原版用来连接互不连通区域的传送点：
    // `walk` 的图内传送依赖它们真的能触发，关掉就会把「要走传送才能到的出口」判成无路。
    const map=maps.get(location.map)!;
    // 剧情路线是定向探测：视为玩家已走到目标出口前，不套用真实进图的到达缓冲区。
    host.exitTrigger=new ExitTrigger([exit,...(map.exits??[]).filter(candidate=>candidate!==exit&&candidate.destination===map.id)],
      {x:location.x,y:location.y},false);
    try{await walk(point=>within(point,exit),`出口 ${exit.destination}`);}
    finally{host.exitTrigger=saved;}
  };
  const walk=async(goal:(point:Point)=>boolean,label:string,scope:'none'|'near'|'all'='none',only?:string|readonly string[],quiet:'none'|'transit'|'all'='transit')=>{
    if(await walkTo(goal,scope,only,quiet))return;
    // 一张图可能有互不连通的区域，原版用「目标还是本图的出口」在图内传送把它们连起来。
    // 选传送点不能贪心：已经进过的区域可能还得再进一次（旧宅地下迷宫就是这样）。
    // 先在可行走区域上求连通分量，再把自指向出口当成分量之间的边做最短路，按计划逐跳走进去。
    const map=maps.get(session.storyWorld.currentLocation!.map)!;
    const shape=world.actors[campaign.start.actor];
    const navigation=new NavigationWorld(map);
    const actor={position:()=>session.storyWorld.currentLocation!,shape:()=>shape,enabled:()=>true};
    navigation.register(actor);
    for(const entity of entities())navigation.register({position:()=>entity,shape:()=>world.actors[entity.actor],enabled:()=>true});
    const step=8,nodes:Point[]=[],index=new Map<string,number>();
    for(let y=4;y<map.height;y+=step)for(let x=4;x<map.width;x+=step)
      if(navigation.canStand(actor,{x,y})){index.set(x+','+y,nodes.length);nodes.push({x,y});}
    const parents=nodes.map((_,at)=>at);
    const component=(at:number):number=>parents[at]===at?at:(parents[at]=component(parents[at]));
    const link=(a:number,b:number):void=>{a=component(a);b=component(b);if(a!==b)parents[b]=a;};
    for(const point of nodes)for(const [dx,dy] of [[step,0],[0,step]]){
      const next=index.get((point.x+dx)+','+(point.y+dy));
      if(next!==undefined)link(index.get(point.x+','+point.y)!,next);
    }
    /** 离这个点最近的可站立格所在的分量；落点由场景在建场时修正，规划按最近的合法区域算。 */
    const componentAt=(point:Point):number|undefined=>{
      let best:number|undefined,distance=Infinity;
      for(const node of nodes){const d=(node.x-point.x)**2+(node.y-point.y)**2;if(d<distance){distance=d;best=component(index.get(node.x+','+node.y)!);}}
      return best;
    };
    const componentOfRect=(rect:{x:number;y:number;width:number;height:number}):number|undefined=>{
      for(const node of nodes)if(within(node,rect))return component(index.get(node.x+','+node.y)!);
      return undefined;
    };
    let target:number|undefined;
    for(const node of nodes)if(goal(node)){target=component(index.get(node.x+','+node.y)!);break;}
    const start=componentAt(session.storyWorld.currentLocation!);
    if(start!==undefined&&target!==undefined){
      const edges=new Map<number,{exit:WorldMap['exits'][number];spawn:Point;to:number}[]>();
      for(const exit of map.exits??[]){
        if(exit.destination!==map.id||!exit.spawn)continue;
        const from=componentOfRect(exit),to=componentAt(exit.spawn);
        if(from===undefined||to===undefined||from===to)continue;
        if(!edges.has(from))edges.set(from,[]);
        edges.get(from)!.push({exit,spawn:exit.spawn,to});
      }
      if(process.env.DEBUG_WALK)console.error('walk-plan',map.id,'nodes',nodes.length,'start',start,'target',target,'edges',[...edges.values()].flat().length);
      const previous=new Map<number,{from:number;exit:WorldMap['exits'][number];spawn:Point}>();
      const queue=[start],seen=new Set([start]);
      for(let at=0;at<queue.length&&!seen.has(target);at++)for(const edge of edges.get(queue[at])??[]){
        if(seen.has(edge.to))continue;
        seen.add(edge.to);previous.set(edge.to,{from:queue[at],exit:edge.exit,spawn:edge.spawn});queue.push(edge.to);
      }
      if(seen.has(target)){
        const hops:{exit:WorldMap['exits'][number];spawn:Point}[]=[];
        for(let at=target;at!==start;){const hop=previous.get(at)!;hops.push({exit:hop.exit,spawn:hop.spawn});at=hop.from;}
        for(const hop of hops.reverse()){
          if(process.env.DEBUG_WALK)console.error('walk-teleport',map.id,JSON.stringify(hop.spawn));
          // 走进出口就够了：传送由场景的 ExitTrigger 判定，并把转场位置写回会话。
          if(!await walkTo(point=>within(point,hop.exit),scope,only))break;
          await idle();
        }
        if(await walkTo(goal,scope,only))return;
      }
    }
    const location=session.storyWorld.currentLocation!;
    if(process.env.DEBUG_WALK)console.error('walk-blocked',location.map,location.x,location.y,JSON.stringify(entities().map(entity=>({id:entity.id,actor:entity.actor,x:entity.x,y:entity.y}))));
    assert.fail(`${location.map} (${location.x},${location.y}) 无路到达 ${label}`);
  };
  const region=async(id:string)=>{
    const event=campaign.events.find(event=>event.id===id)!;
    assert.equal(session.storyWorld.currentLocation?.map,event.map,id+' 所在地图');
    assert.ok(!event.condition||session.evaluateCondition(event.condition),id+' 前置条件');
    // 优先停在「区域里不是门口」的落脚点：区域紧贴出口格时（旧圣殿的 event-54 就是），
    // 停在门口会让演出刚一结束就被出口传送走。区域本身盖在出口格上时（事件 1）找不到
    // 这样的点，回落到门口走进区域——那正是要验的出口竞争。
    // 只放行这一个事件：出口竞争照旧，沿途别的戏不点燃。
    const map=maps.get(event.map!)!;
    const clear=(point:Point)=>!(map.exits??[]).some(exit=>overlapsFootRect(point,exit));
    const clean=findPoint(point=>overlapsFootRect(point,event.region!)&&clear(point));
    // 有干净落脚点就安静地走过去（途中收起出口，免得被别的门带走），最后一帧出口是真的；
    // 区域本身盖在出口格上时（事件 1）没有这样的点，照旧走进去让出口竞争发生。
    if(clean)await stride(clean,'all',id,'transit');
    else{
      // 没有可站立的落脚点时放下这个要求，但仍然避开出口：辅助器不做物理，位置本来就由
      // 转场命令直接写，可落脚性不是它要验的；被别的门带走才是。
      const loose=findPoint(point=>overlapsFootRect(point,event.region!)&&clear(point),false);
      // 区域整个压在出口格上（事件 1 那种）时找不到避开出口的点，这时才走进去，
      // 让区域与出口的先后顺序照着场景的判定发生。
      if(loose)await stride(loose,'all',id,'all');
      else await walk(point=>overlapsFootRect(point,event.region!),id,'all',id);
    }
    await idle();
    // 只核对场景确实上报过：直接通知导演会绕过占用表、条件求值与出口竞争，
    // 那样「走位时先碰出口还是先进区域」这类缺陷就测不出来。
    assert.notEqual(director.runtime.eventStatus(id),'idle',id+' 由场景触发');
  };
  const travel=async(target:string)=>{
    // 只有导出的出口能切图；演出带的转场仍由导演负责。切图本身由场景的出口触发完成。
    const trace:string[]=[];
    const blocked=new Set<string>();
    const edge=(map:string,exit:WorldMap['exits'][number])=>`${map}:${exit.x},${exit.y}:${exit.destination}`;
    for(let hop=0;session.storyWorld.currentLocation!.map!==target;hop++){
      const from=session.storyWorld.currentLocation!.map;
      assert.ok(hop<40,`${from} 无出口路径到 ${target}；轨迹 ${trace.join(' ')}`);
      const queue=[from],previous=new Map<string,{map:string;exit:WorldMap['exits'][number]}>();
      for(const mapId of queue){if(mapId===target)break;for(const exit of maps.get(mapId)!.exits){
        if(exit.destination===from||previous.has(exit.destination)||blocked.has(edge(mapId,exit))||!session.storyWorld.exitEnabled(mapId,exit))continue;
        previous.set(exit.destination,{map:mapId,exit});queue.push(exit.destination);
      }}
      const here=maps.get(from)!;
      assert.ok(previous.has(target),`${from} 无出口路径到 ${target}；本图出口 ${JSON.stringify(here.exits.map(exit=>(exit.destination+(session.storyWorld.exitEnabled(from,exit)?'开':'关'))))}`);
      let next=target;while(previous.get(next)!.map!==from)next=previous.get(next)!.map;
      const hopExit=previous.get(next)!.exit;
      try{await approachExit(hopExit);}
      catch(error){
        if(!(error instanceof assert.AssertionError)||!error.message.includes(`无路到达 出口 ${hopExit.destination}`))throw error;
        // 地图相邻不代表机关已经打开；保留门的状态，排除这条边后重新选路。
        blocked.add(edge(from,hopExit));continue;
      }
      await idle();
      // 跳不过去时这条轨迹是唯一能看出「卡在哪一跳」的东西：只记走了哪条边。
      const at=session.storyWorld.currentLocation!;
      trace.push(`${from}->${at.map}${at.map===next?'':'!'}[触发${firedExit?firedExit.destination+'@'+firedExit.x+','+firedExit.y:'无'}/目标${next}@${hopExit.x},${hopExit.y}]`);
      firedExit=undefined;
    }
  };
  const walkNear=async(characterId:string)=>{
    const list=entities(),entity=list.find(entity=>entity.characterId===characterId);
    assert.ok(entity,`可见角色 ${characterId}（现在在 ${session.storyWorld.currentLocation?.map}，`+
      `本图可见实体 ${list.length} 个：${list.slice(0,10).map(item=>item.characterId??item.actor).join(',')}）`);
    const collision=world.actors[entity.actor].collision;
    await walk(point=>nearInteractive(point,entity,collision,!!entity.flip),'角色 '+characterId,'none',undefined,'all');
    await idle();
    return entity;
  };
  const approach=async(characterId:string,_rearm=false)=>{
    const entity=await walkNear(characterId);
    if(session.hasNearEvent(entity)){
      await director.interact(entity,world.actors[entity.actor]);await idle();
    }
    return entity;
  };
  const talk=async(characterId:string)=>{
    const entity=await walkNear(characterId);
    await director.interact(entity,world.actors[entity.actor]);await idle();
  };
  const defeat=async(enemyId:string)=>{
    const map=maps.get(session.storyWorld.currentLocation!.map)!;
    const roster=new WorldEnemyRoster(session,map,[],questEnemies);
    const spawn=roster.spawns.find(spawn=>spawn.enemyId===enemyId&&roster.isPresent(spawn.id,enemyId));assert.ok(spawn,'当前地图敌人 '+enemyId);
    const hero=session.hero!,killer=session.party?.controlledId??'player';
    const member=killer==='player'?hero:session.party?.get(killer);
    assert.ok(member?.player.health,'击杀者必须是存活的受控队员');
    const definition=battle.enemies.find(enemy=>enemy.id===enemyId)!;
    const before=roster.enemySnapshot(spawn.id,definition,hero.level)!;
    const experience=calculateEnemy(definition,{level:before.level,elite:before.elite,
      partySize:Math.max(1,session.party?.livingIds.length??1),playerLevel:hero.level}).experience;
    const rewards=rollQuestDrops(drops,enemyId,session.questDropRequirements(),()=>0);
    session.enemyDefeated(spawn);
    groundLootFor(session).add(map.id,spawn.x,spawn.y,rewards);
    const picked=groundLootFor(session).collectNearby(map.id,spawn.x,spawn.y,reward=>{
      if(reward.kind==='item'){
        if(reward.instance)session.bag.receiveDrop(reward.instance);else session.bag.add(reward.item,reward.quantity);
      }
    });
    session.questItemGenerators.collected(picked.map(drop=>drop.id),session.combatTick);
    if(experience>0)session.party?.addExperience(experience);
    session.emit();
    await idle();
    return roster;
  };
  const wait=async(milliseconds:number)=>{
    const map=maps.get(session.storyWorld.currentLocation!.map)!;
    session.enterMap(map.id,map.questItemSpawns??[],map);
    session.advanceGameTime(milliseconds);session.advanceCombatFrames(milliseconds,()=>{});await idle();
  };
  const pickup=async(item:string,quantity=1)=>{
    let received=0;let stalled=0;
    while(received<quantity){
      const map=maps.get(session.storyWorld.currentLocation!.map)!,store=groundLootFor(session);
      const drop=store.forMap(map.id).find(drop=>drop.reward.kind==='item'&&drop.reward.item===item);
      // 生成点拾取后会进入刷新计时，地面会空一段时间；等一轮再看，连续三轮没有才报错。
      if(!drop){if(++stalled>=3)assert.fail(`地面物品 ${item} 三轮没有刷新，停在 ${received}/${quantity}`);
        await wait(60_000);continue;}
      await walk(point=>Math.abs(point.x-drop.x)<=12&&Math.abs(point.y-drop.y)<=12,'拾取 '+item);
      const point=session.storyWorld.currentLocation!;
      const picked=store.collectNearby(map.id,point.x,point.y,reward=>{
        if(reward.kind==='money'){session.gainMoney(reward.amount);return;}
        if(reward.instance)session.bag.receiveDrop(reward.instance);else session.bag.add(reward.item,reward.quantity);
      });
      assert.ok(picked.length,'地面物品可拾取');
      session.questItemGenerators.collected(picked.map(drop=>drop.id),session.combatTick);
      const gained=picked.reduce((sum,drop)=>sum+(drop.reward.kind==='item'&&drop.reward.item===item?drop.reward.quantity:0),0);
      received+=gained;
      // 捡到的东西不是目标物品时数量不会涨；只有连续三轮都没有进展才报错，
      // 找到目标后必须清零，否则残留的停滞计数会误伤下一轮正常拾取。
      if(gained===0){if(++stalled>=3)assert.fail(`拾取 ${item} 三轮没有进展，停在 ${received}/${quantity}`);}
      else stalled=0;
      session.emit();await idle();
    }
  };
  const damage=async(enemyId:string,remainingRatio:number)=>{
    assert.ok(remainingRatio>=0&&remainingRatio<=1);
    const map=maps.get(session.storyWorld.currentLocation!.map)!;
    const roster=new WorldEnemyRoster(session,map,[],questEnemies),definition=battle.enemies.find(enemy=>enemy.id===enemyId)!;
    const placed=roster.enemies.find(enemy=>enemy.enemyId===enemyId);
    assert.ok(placed,`当前地图受伤敌人 ${enemyId}（现在在 ${map.id}，本图 ${roster.enemies.length} 只：${[...new Set(roster.enemies.map(enemy=>enemy.enemyId))].slice(0,8).join(',')}）`);
    const snapshot=roster.enemySnapshot(placed.key,definition,session.hero!.level)!;
    const after=Math.floor(snapshot.maxHealth*remainingRatio);
    const handled=director.healthChanged(enemyId,snapshot.health,after,snapshot.maxHealth,{id:placed.key,map:map.id,x:placed.x,y:placed.y});
    roster.setEnemyHealth(placed.key,handled?Math.max(1,after):after,definition);await idle();return handled;
  };
  return {session,director,region,travel,approach,talk,defeat,damage,wait,pickup,idle,landPlayer,entities,lines,popups,actions,frame:afterMovement,updateWorld,
    choices:(values:string[])=>{choiceQueue=values;}};
}
