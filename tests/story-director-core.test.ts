import assert from 'node:assert/strict';
import { stageSnapshot } from './helpers/story-stage.ts';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Campaign } from '../src/domain/campaign.ts';
import type { StoryNode } from '../src/domain/story-graph.ts';
import type { StoryPresentationPort, StoryStage } from '../src/domain/story-performance.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector, type StoryUI, type StoryWorldPort } from '../src/domain/story-director.ts';

const base:Campaign=JSON.parse(readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8'));
const worldBase=JSON.parse(readFileSync(new URL('../public/content/world.json',import.meta.url),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const stage:StoryStage={type:'stage',map:base.start.map,x:base.start.x,y:base.start.y,facing:'south',playerVisible:true,cast:[]};
const node=(id:string,commands:StoryNode['commands']=[],exit:StoryNode['exit']={type:'end'}):StoryNode=>({id,presentation:[],commands,exit});
function harness(nodes:StoryNode[],presentation?:StoryPresentationPort,world?:StoryWorldPort){
  const campaign:Campaign={...structuredClone(base),scripts:{...structuredClone(base.scripts),demo:{entry:nodes[0].id,nodes}},
    events:[{id:'demo-event',source:'start',script:'demo'}]};
  const session=new Session(campaign),locks:boolean[]=[];
  const ui:StoryUI={async dialogue(){},async choice(_prompt,options){return options[0];},async questPopup(){},toast(){},closeDialogue(){},skipDialogue(){}};
  const director=new StoryDirector(campaign,session,ui,value=>locks.push(value),presentation,world);
  return {campaign,session,ui,director,locks};
}

test('director preserves a settled quest and resumes the popup after its presentation fails',async()=>{
  const award=node('award',[{type:'quest',command:{type:'complete',quest:'grafton-mission'}}],{type:'next',target:{script:'demo',node:'popup'}});
  const popup=node('popup');popup.presentation=[{type:'quest-popup',kind:'complete',quest:'grafton-mission'}];
  const h=harness([award,popup]);h.session.accept('grafton-mission');h.session.enemyDefeated({id:'fixture-earl',enemyId:'enemy-earl-grafton-1',x:0,y:0});
  let fail=true,shown=0;h.ui.questPopup=async(_kind,_quest,reward)=>{shown++;assert.ok(reward);if(fail)throw new Error('panel failed');};
  await assert.rejects(h.director.start(),/panel failed/);
  const afterAward=h.session.money;assert.equal(h.session.status('grafton-mission'),'completed');
  assert.equal(h.session.flags.has('demo-event'),false);assert.equal(h.director.busy,false);
  fail=false;await h.director.retry();assert.equal(h.session.money,afterAward);assert.equal(shown,2);
  assert.equal(h.session.flags.has('demo-event'),true);assert.deepEqual(h.locks,[true,false,true,false]);
});

test('a failed world projection retries only the projection after travel was applied',async()=>{
  const travel={map:'shadow-camp',x:1,y:2,facing:'south' as const};
  const play=node('play',[{type:'travel',destination:travel}],{type:'end'});
  let travels=0,projects=0,fail=true;
  const h=harness([play],undefined,{
    capture:()=>undefined,
    restore:async()=>{},
    checkpoint:()=>{},
    project:async()=>{if(fail){fail=false;throw new Error('project failed');}projects++;}
  });
  h.director.onTravel=async()=>{travels++;};
  await assert.rejects(h.director.start(),/project failed/);
  assert.equal(travels,1);
  assert.equal(await h.director.retry(),false);
  assert.equal(travels,1,'重试只重做投影，不再重复转场');
  assert.equal(projects,1);
});

test('a first stage inheriting the current map is drawn by execute instead of begin',async()=>{
  const play=node('play');
  play.presentation=[
    {type:'stage',mapFromWorld:true,map:base.start.map,x:base.start.x,y:base.start.y,facing:'south',playerVisible:true,cast:[]},
    {type:'wait',durationMs:0}
  ];
  const order:string[]=[];
  const h=harness([play],{
    begin(_signal,_stage,_curtain,defer){order.push('begin:'+!!defer);},
    async execute(action){order.push('execute:'+action.type);},
    async finish(){}
  });
  await h.director.start();
  assert.deepEqual(order,['begin:true','execute:stage','execute:wait'],'首幕只由 execute 画一次');
});

test('a following script run releases the previous stage instead of inheriting its temporary actors',async()=>{
  const first=node('first'),second=node('second');
  first.presentation=[{...stage}];second.presentation=[{...stage,map:'shadow-hall'}];
  const campaign:Campaign={...structuredClone(base),events:[
      {id:'first-event',source:'start',script:'first'},{id:'second-event',source:'start',script:'second'}],
    scripts:{...structuredClone(base.scripts),first:{entry:'first',nodes:[first]},second:{entry:'second',nodes:[second]}}};
  const session=new Session(campaign),log:string[]=[];
  const presentation:StoryPresentationPort={begin(_signal,value){log.push('begin:'+(value?.map??'world'));},
    async execute(action){log.push('execute:'+action.type);},async finish(){},async release(){log.push('release');}};
  const ui:StoryUI={async dialogue(){},async choice(_prompt,options){return options[0];},async questPopup(){},toast(){},closeDialogue(){},skipDialogue(){}};
  const director=new StoryDirector(campaign,session,ui,()=>{},presentation);
  try{await director.start();}finally{director.dispose();}
  assert.deepEqual(log.slice(0,5),[`begin:${base.start.map}`,'execute:stage','release','begin:shadow-hall','execute:stage'],
    '第二段脚本要先收起上一段舞台，再从正式世界取景');
});

test('a settled story playback asks the world to regroup friendly units once',async()=>{
  let settles=0,busyAtSettle:boolean|undefined;
  const order:string[]=[];
  const play=node('play');
  const presentation:StoryPresentationPort={begin(){},async execute(){},async finish(){},async release(){}};
  const world:StoryWorldPort={capture:()=>undefined,restore:async()=>{},checkpoint:()=>{order.push('checkpoint');},project:async()=>{},
    settle:()=>{settles++;busyAtSettle=director.busy;order.push('settle');}};
  const h=harness([play],presentation,world),director=h.director;
  await director.start();
  assert.equal(settles,1);assert.equal(busyAtSettle,false,'收尾时导演已经不再是忙碌状态');
  assert.deepEqual(order.slice(-2),['settle','checkpoint'],'收拢后的站位要写进事件检查点');
});

test('a hidden quest popup action is skipped without blocking the node',async()=>{
  const popup=node('popup',[],{type:'next',target:{script:'demo',node:'after'}});
  popup.presentation=[{type:'quest-popup',kind:'complete',quest:'quest-61'}];
  const h=harness([popup,node('after')]);
  assert.equal(h.session.accept('quest-61'),true);
  assert.equal(h.session.complete('quest-61'),true);
  assert.ok(h.session.rewardReceiptFor('quest-61'));
  let shown=0;h.ui.questPopup=async()=>{shown++;};
  assert.equal(await h.director.start(),true);
  assert.equal(shown,0,'隐藏任务面板不显示');
  assert.equal(h.director.runtime.eventStatus('demo-event'),'completed');
});

test('a quest completion popup finishes before the follow-up story starts',async()=>{
  const session=new Session(base);
  session.accept('grafton-mission');
  session.enemyDefeated({id:'earl',enemyId:'enemy-earl-grafton-1',x:0,y:0});
  session.applyStoryCommands([{type:'travel',destination:{map:'shadow-camp',x:392,y:328,facing:'south'}}]);
  assert.equal(session.status('grafton-mission'),'ready');
  const log:string[]=[];let closePopup!:()=>void;
  const ui:StoryUI={
    async dialogue(line){log.push('dialogue:'+line.text.slice(0,4));},
    async choice(_prompt,options){log.push('choice');return options[0];},
    questPopup(kind,quest){log.push('popup:'+kind+':'+quest.id);return new Promise<void>(resolve=>{closePopup=resolve;});},
    toast(){},closeDialogue(){},skipDialogue(){}
  };
  const stage:StoryStage={type:'stage',map:'shadow-camp',x:392,y:328,facing:'south',playerVisible:true,cast:[]};
  const director=new StoryDirector(base,session,ui,()=>{},{begin(){log.push('begin');},async execute(action){log.push('execute:'+action.type);},
    getStageState(){return stageSnapshot(stage);},getWorldChanges(){return [];},async finish(){log.push('finish');},async release(){log.push('release');}});
  const errors:unknown[]=[];director.onError=error=>errors.push(error);
  // 交付时 Session.complete 会立刻发出会话变化；后续事件必须等这次手动播放收好再开演。
  const running=director.interact({id:'quest-npc-located-npc-40',actor:'darius',characterId:'npc-40',x:392,y:328},worldBase.actors.darius);
  for(let index=0;index<20;index++)await tick();
  assert.deepEqual(log,['popup:complete:grafton-mission'],'奖励弹窗还开着时不能开演后续事件');
  assert.equal(director.runtime.eventStatus('event-6'),'idle');
  closePopup();
  await running;
  for(let index=0;index<100&&director.busy;index++)await tick();
  assert.deepEqual(errors,[]);
  assert.equal(director.runtime.eventStatus('event-6'),'completed');
  assert.ok(log.indexOf('popup:complete:grafton-mission')<log.indexOf('begin'),'弹窗先结束，演出才开演');
});

test('the presentation-start hook fires once, after the first stage is drawn',async()=>{
  const play=node('play');play.presentation=[stage,{type:'wait',durationMs:0}];
  const order:string[]=[];
  const h=harness([play],{begin(){order.push('begin');},async execute(action){order.push(action.type);},async finish(){order.push('finish');},getStageState(){return stageSnapshot(stage);}});
  h.director.onPresentationStarted=()=>order.push('started');
  await h.director.start();
  assert.equal(order.filter(value=>value==='started').length,1,'只回落一次');
  assert.ok(order.indexOf('started')>order.indexOf('begin'),'舞台已经启动');
  assert.ok(order.indexOf('started')<=order.indexOf('wait'),'首幕画出后、长动作之前收起加载页');
});

test('a dialogue-only entrance ends the loading wait at its first line',async()=>{
  const play=node('play');play.presentation=[{type:'dialogue',actor:null,speaker:'',text:'第一句'}];
  const h=harness([play]);const order:string[]=[];
  h.ui.dialogue=async()=>{order.push('dialogue');};
  h.director.onPresentationStarted=()=>order.push('started');
  await h.director.start();
  assert.deepEqual(order,['started','dialogue'],'先收起加载页，再显示对白');
});

test('a failed finish commits neither actor placement nor event completion',async()=>{
  const play=node('play',[{type:'flag',flag:'changed'}]);play.presentation=[stage];
  let fail=true;
  const h=harness([play],{begin(){},async execute(){},getStageState(){return stageSnapshot(stage);},
    getWorldChanges(){return [{id:'actor-instance',map:stage.map,actor:'darius',x:80,y:90}];},
    async finish(completed){if(completed&&fail)throw new Error('finish failed');},async release(){}});
  await assert.rejects(h.director.start(),/finish failed/);
  assert.equal(h.session.flags.has('changed'),false);assert.equal(h.session.flags.has('demo-event'),false);
  assert.equal(h.session.storyWorld.entity('actor-instance'),undefined);
  fail=false;await h.director.retry();assert.equal(h.session.flags.has('demo-event'),true);
  assert.equal(h.session.storyWorld.entity('actor-instance')?.x,80);
});

test('physical map projection can be retried after the terminal node has already committed',async()=>{
  const travel=node('travel',[{type:'travel',destination:{map:'shadow-hall',x:216,y:360,facing:'north'}}]);
  let fail=true,projects=0,checkpoints=0;
  const h=harness([travel],undefined,{capture(){return {};},async restore(){},async project(){projects++;if(fail)throw new Error('map unavailable');},checkpoint(){checkpoints++;}});
  await assert.rejects(h.director.start(),/map unavailable/);
  assert.equal(h.session.storyWorld.currentLocation?.map,'shadow-hall');assert.equal(h.session.flags.has('demo-event'),true);
  fail=false;await h.director.retry();assert.equal(projects,2);assert.equal(checkpoints,1);
  assert.equal(h.session.storyWorld.currentLocation?.x,216);assert.equal(h.director.busy,false);
});

test('waiting hands control to battle; failed continuation retains earned money and committed outcome',async()=>{
  const battle=node('battle',[],{type:'waitEncounter',encounter:{id:'guards',map:stage.map,status:'prepared',spawns:[]},outcomes:{won:{script:'demo',node:'after'}}});
  const after=node('after');after.presentation=[{type:'dialogue',actor:null,speaker:'',text:'victory'}];
  const h=harness([battle,after]);await h.director.start();assert.equal(h.director.busy,false);
  const encounter=h.director.runtime.snapshot().runs[0].waiting!.encounter;h.session.gainMoney(23);
  h.ui.dialogue=async()=>{throw new Error('portrait unavailable');};
  await assert.rejects(h.director.encounterResult(encounter,'won','result:guards'),/portrait unavailable/);
  assert.equal(h.session.money,23);assert.equal(h.session.storyWorld.encounter(encounter)?.status,'won');
  h.ui.dialogue=async()=>{};await h.director.retry();
  assert.equal(await h.director.encounterResult(encounter,'won','result:guards'),false);assert.equal(h.session.money,23);
});

test('late finish after cancellation cannot commit into a new playback',async()=>{
  const play=node('play',[{type:'flag',flag:'published'}]);play.presentation=[stage];
  let complete!:()=>void,delay=true;
  const h=harness([play],{begin(){},async execute(){},async finish(completed){if(completed&&delay)await new Promise<void>(resolve=>{complete=resolve;});},async release(){}});
  const old=h.director.start();await tick();h.director.cancel();assert.equal(await old,false);
  delay=false;await h.director.retry();complete();await tick();
  assert.equal(h.session.flags.has('published'),true);assert.equal(h.session.flags.has('demo-event'),true);
  assert.equal(h.director.busy,false);assert.deepEqual(h.locks,[true,false,true,false]);
});

test('cleanup failures release the input lease and do not prevent a later recovery',async()=>{
  const play=node('play',[{type:'flag',flag:'published'}]);play.presentation=[stage];
  let fail=true,released=0;
  const h=harness([play],{begin(){},async execute(){},async finish(){if(fail)throw new Error('finish failed');},
    async release(){released++;if(fail)throw new Error('cleanup failed');}});
  await assert.rejects(h.director.start(),/finish failed/);assert.equal(h.director.busy,false);assert.equal(released,1);
  fail=false;await h.director.retry();assert.equal(h.director.busy,false);assert.equal(h.session.flags.has('published'),true);assert.equal(released,2);
});

test('cancelling an in-flight performance rolls the session back to that playback baseline',async()=>{
  const play=node('play',[{type:'flag',flag:'published'}]);play.presentation=[stage];
  let release!:()=>void,held=true;
  const h=harness([play],{begin(){},async execute(){},getStageState(){return stageSnapshot(stage);},
    async finish(completed){if(completed&&held)await new Promise<void>(resolve=>{release=resolve;});},async release(){}});
  h.session.gainMoney(10);
  const started=h.director.start();await tick();
  h.session.gainMoney(20);assert.equal(h.session.money,30);
  h.director.cancel();assert.equal(h.session.money,10);
  held=false;release();await tick();await started;
});

test('a checkpoint restored mid-performance keeps its state under either cancel order',async()=>{
  const build=()=>{
    const play=node('play',[{type:'flag',flag:'published'}]);play.presentation=[stage];
    let release!:()=>void,held=true;
    const h=harness([play],{begin(){},async execute(){},getStageState(){return stageSnapshot(stage);},
      async finish(completed){if(completed&&held)await new Promise<void>(resolve=>{release=resolve;});},async release(){}});
    h.session.gainMoney(10);
    const checkpoint=h.session.captureState();
    h.session.gainMoney(20);
    return {h,checkpoint,finish:async(started:Promise<boolean>)=>{held=false;release();await tick();await started;}};
  };
  // 正式地图先取消旧演出再恢复快照。
  const first=build();const firstRun=first.h.director.start();await tick();
  first.h.director.cancel();first.h.session.restoreState(first.checkpoint);
  assert.equal(first.h.session.money,10);await first.finish(firstRun);assert.equal(first.h.session.money,10);
  // 旧演出仍持有基线时先恢复快照，随后取消不得把它拉回演出基线。
  const second=build();const secondRun=second.h.director.start();await tick();
  second.h.session.restoreState(second.checkpoint);second.h.director.cancel();
  assert.equal(second.h.session.money,10);await second.finish(secondRun);assert.equal(second.h.session.money,10);
});

test('a cross-map performance that waits for an encounter commits travel and opens the encounter',async()=>{
  const other='shadow-hall';
  const battleStage:StoryStage={...stage,map:other};
  const battle=node('battle',[],{type:'waitEncounter',encounter:{id:'guards',map:other,status:'prepared',spawns:[]},outcomes:{won:{script:'demo',node:'after'}}});
  battle.presentation=[battleStage];
  const after=node('after');
  const projections:unknown[]=[];
  const h=harness([battle,after],{begin(){},async execute(){},getStageState(){return stageSnapshot(battleStage);},async finish(){},async release(){}},
    {capture(){return {};},async restore(){},async project(stage){projections.push(stage);},checkpoint(){}});
  await h.director.start();
  const run=h.director.runtime.snapshot().runs.find(candidate=>candidate.status==='waiting');
  assert.ok(run?.waiting?.encounter);
  const location=h.session.storyWorld.currentLocation;
  assert.equal(location?.map,other);assert.deepEqual([location?.x,location?.y],[battleStage.x,battleStage.y]);
  assert.equal(h.session.storyWorld.encounter(run!.waiting!.encounter)?.status,'active');
  assert.equal(projections.length,1);
});

test('scripted money changes land with the node and reject a payment the party cannot afford',async()=>{
  // 原版把金币当 0 号物品，0x11/0x44 的物品号 0 就是收／发金币（findings 124）。
  const pay=node('pay',[{type:'money-take',amount:20},{type:'money-give',amount:5}]);
  const h=harness([pay]);
  h.session.gainMoney(30);
  await h.director.start();
  assert.equal(h.session.money,15,'先取后给，同一节点里按顺序结算');

  const broke=harness([node('pay',[{type:'money-take',amount:20}])]);
  broke.session.gainMoney(10);
  await assert.rejects(broke.director.start(),/金币不足/);
  assert.equal(broke.session.money,10,'付不起时整段不落地，金币不动');
  assert.equal(broke.session.flags.has('demo-event'),false);
});

test('director waits for the world to prepare story assets before beginning the performance',async()=>{
  const play=node('play');play.presentation=[stage];
  const calls:string[]=[];let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const h=harness([play],{begin(){calls.push('begin');},async execute(){},getStageState(){return stageSnapshot(stage);},async finish(){},async release(){}},
    {capture(){return {};},async restore(){},async project(){},checkpoint(){},async prefetch(){calls.push('prefetch');await gate;}});
  const started=h.director.start();
  await tick();
  assert.deepEqual(calls,['prefetch']);
  release();
  await started;
  assert.ok(calls.indexOf('begin')>0);
});

test('director hands the current script to the world prepare hook',async()=>{
  const play=node('play');
  let seen:string|undefined;
  const h=harness([play],undefined,{
    capture(){return {};},async restore(){},async project(){},checkpoint(){},
    async prepare(_commands,_signal,_stage,script){seen=script;}
  });
  await h.director.start();
  assert.equal(seen,'demo');
});

test('director recovers the full scene baseline after a failed node without recomputing its background',async()=>{
  const first=node('first',[],{type:'next',target:{script:'demo',node:'second'}});first.presentation=[stage];
  const second=node('second');second.presentation=[{type:'wait',durationMs:1}];
  const stable=stageSnapshot(stage,[
    {id:'entity:portal',actor:'portal',x:12,y:24,facing:'south',visible:true},
    {id:'entity:spring',actor:'spring-empty',x:32,y:24,facing:'south',visible:true},
  ]);
  let visible=structuredClone(stable),fail=true,restores=0,acknowledged=0;
  const h=harness([first,second],{
    begin(_signal,initial){if(initial&&'scene' in initial)visible=structuredClone(initial);},
    async execute(action){if(action.type==='wait'&&fail){visible.scene.actors.splice(1);throw new Error('effect unavailable');}},
    getStageState(){return structuredClone(visible);},
    async restoreStage(snapshot){restores++;assert.deepEqual(snapshot,stable);visible=structuredClone(snapshot);},
    committed(){acknowledged++;},async finish(){},release(){},
  });
  await assert.rejects(h.director.start(),/effect unavailable/);
  assert.equal(acknowledged,1);
  fail=false;await h.director.retry();
  assert.equal(restores,1);assert.equal(acknowledged,2);
  assert.deepEqual(visible,stable);
  assert.equal(h.session.runtimeState.runs[0].stage,undefined);
});

test('director acknowledges scene changes only after the command batch commits',async()=>{
  const play=node('play',[{type:'money-take',amount:1}]);play.presentation=[stage];
  let acknowledged=0;
  const h=harness([play],{begin(){},async execute(){},getStageState(){return stageSnapshot(stage);},
    committed(){acknowledged++;},async finish(){},release(){}});
  await assert.rejects(h.director.start());assert.equal(acknowledged,0);
  h.session.gainMoney(1);await h.director.retry();assert.equal(acknowledged,1);
});
