import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {CloudSaveClient} from '../src/application/cloud-save.ts';
import {restoreCloudSaves} from '../src/application/cloud-save-sync.ts';
import {newStorySession} from '../src/domain/story-class.ts';
import {captureSaveGame,saveSummary,SaveSlots,type SaveSlotRef} from '../src/domain/save-game.ts';
import type {StoryWorldViewSnapshot} from '../src/application/world-snapshot.ts';
import type {StoryApp} from '../src/app.ts';
import type {WorldScene} from '../src/scenes/world-scene.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Scenes:{Events:{SHUTDOWN:"shutdown"}},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {createSessionLifecycle}=await import('../src/session-lifecycle.ts');hook.deregister();

test('cloud restore checks a real session and map before replacing each local slot',async t=>{
  const {headlessContent}=await import('./helpers/story-playthrough.ts');
  const {campaign,world,items,battle,stats,storyClasses,companions,maps}=headlessContent;
  const selected=storyClasses.classes[0]!,actor=world.actors[campaign.start.actor];
  const session=newStorySession(campaign,actor,selected,items,stats,battle,companions);
  const map=world.maps.find(value=>value.id===campaign.start.map)!;
  const scene:StoryWorldViewSnapshot={location:{map:map.id,x:16,y:24,facing:'west'},generatedEntities:[]};
  const game=captureSaveGame(session,scene,saveSummary(session,map,{name:selected.name,portrait:'kiyan.png'},'data:image/jpeg;base64,AQ=='));
  game.summary.name='云端章节';
  const broken=structuredClone(game);broken.world.location.map='missing-map';
  const files:string[]=[];
  const app={session,campaign,world,items,storyClasses,characterStats:stats,battleCatalog:battle,companions,
    content:{storyClasses:async()=>storyClasses,map:async(file:string)=>{
      files.push(file);
      if(files.length===1)throw new Error('目标地图暂时无法加载');
      assert.equal(file,map.file);return maps.get(map.id);
    }}} as unknown as StoryApp;
  const lifecycle=createSessionLifecycle(app,{prepareStory:async()=>{}} as unknown as Parameters<typeof createSessionLifecycle>[1]);
  const local=new Map<string,string>();
  const slots=new SaveSlots<StoryWorldViewSnapshot>({getItem:key=>local.get(key)??null,
    setItem:(key,value)=>{local.set(key,value);},removeItem:key=>{local.delete(key);}});
  const original=JSON.stringify({...game,summary:{...game.summary,name:'本机章节'}});
  slots.writeRaw(0,original);slots.writeRaw(1,original);
  const cloud=new CloudSaveClient();
  t.mock.method(cloud,'list',async()=>({ok:true,value:[0,1,2].map(slot=>({slot,format:game.format,bytes:1,updatedAt:1,summary:game.summary}))}));
  t.mock.method(cloud,'download',async(slot:SaveSlotRef)=>({ok:true,value:slot===0?broken:game}));
  const result=await restoreCloudSaves({cloud,saves:slots,confirm:async()=>true,
    validate:async(candidate,signal,slot)=>{await lifecycle.prepareCandidate(candidate,signal,slot);}});
  assert.deepEqual(result.failures,[{slot:0,reason:'游戏存档出错。无法正常进行游戏。'},
    {slot:1,reason:'游戏存档出错。无法正常进行游戏。'}]);
  assert.equal(result.completed,1);assert.deepEqual(files,[map.file,map.file]);
  for(const slot of [0,1,2]){
    const reading=slots.readRaw(slot);assert.ok(reading.kind==='ok');
    assert.equal(reading.raw,slot===2?JSON.stringify(game):original);
  }
  assert.equal(app.session,session);
});

test('leaving a session cancels business work before shutdown and releases resources only after shutdown',()=>{
  const events:string[]=[],controller=new AbortController();
  let shutdown:(()=>void)|undefined;
  const session={} as StoryApp['session'];
  const scene={sys:{isActive:()=>true,isPaused:()=>false},events:{once(_event:string,done:()=>void){shutdown=done;}},
    scene:{start(){events.push('scene-stop');assert.equal(controller.signal.aborted,true);}}};
  const app={session,mode:'game',ui:{canReturn:true,resetInput(){events.push('input');},lock(){},setMode(){}},
    gm:{dispose(){events.push('gm');}},director:{dispose(){events.push('director');}},
    clearMapPrefetch(){},clearStoryPrefetch(){},releaseSession(expected:unknown){assert.equal(expected,session);events.push('release');},
    game:{scene:{getScene(){return undefined;}}}} as unknown as StoryApp;
  const lifecycle=createSessionLifecycle(app,{lifetime:{current:controller},
    worldScene:()=>({discardWorldWork(){events.push('discard');}} as WorldScene),currentScene:()=>scene as never,
    gmOn:()=>false,runtimeDiagnostics:()=>({}),prepareStory:async()=>{},prepareMenuCore:async()=>{},
    refreshMenuWhenReady(){},cancelCommonPreload(){},clearMenuPreparations(){},recordSceneChange(){},
    remeasureRefreshAfterStart(){},startAutoSave(){},stopAutoSave(){events.push('save-stop');},autoSaver:()=>undefined});
  lifecycle.exit();
  assert.deepEqual(events,['discard','save-stop','gm','director','input','scene-stop']);
  assert.equal(app.mode,'menu');
  assert.ok(shutdown);shutdown();
  assert.equal(events.at(-1),'release');
});
