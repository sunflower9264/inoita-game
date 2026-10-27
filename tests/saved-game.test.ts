import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {prepareSavedGame,type SavedGameContent} from '../src/application/saved-game.ts';
import {newStorySession} from '../src/domain/story-class.ts';
import {captureSaveGame,saveSummary} from '../src/domain/save-game.ts';
import type {StoryWorldViewSnapshot} from '../src/scenes/world-scene.ts';
const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const content:SavedGameContent={campaign:read('campaign'),world:read('world'),storyClasses:read('story-classes'),
  items:read('items'),characterStats:read('character-stats'),battleCatalog:read('battle'),companions:read('companions')};
function record(index=0){
  const character=content.storyClasses.classes[index],session=newStorySession(content.campaign,content.world.actors[content.campaign.start.actor],character,
    content.items,content.characterStats,content.battleCatalog,content.companions);
  session.gainMoney(321);session.hero!.setHealth(7);session.hero!.setMana(3);
  const map=content.world.maps.find(entry=>entry.id!==content.campaign.start.map)!;
  const world:StoryWorldViewSnapshot={location:{map:map.id,x:16,y:24,facing:'west'},generatedEntities:[],scene:{map:map.id,
    actors:[{id:'player',actor:content.campaign.start.actor,memberId:'player',x:16,y:24,facing:'west',visible:true}]}};
  return captureSaveGame(session,world,saveSummary(session,{id:map.id,name:map.name},{name:character.name,portrait:'assets/ui/menus/character-kiyan.png'}));
}

test('each class restores into a fresh candidate and retains its destination, resources and inventory',()=>{
  for(let index=0;index<content.storyClasses.classes.length;index++){
    const saved=record(index),before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
    assert.equal(candidate.session.hero!.classId,saved.summary.classId);assert.equal(candidate.session.money,321);
    assert.equal(candidate.session.hero!.player.health,7);assert.equal(candidate.session.hero!.player.mana,3);
    assert.deepEqual(candidate.session.bag.captureState(),saved.session.bag);
    assert.deepEqual(candidate.world,saved.world);assert.equal(candidate.map.id,saved.world.location.map);
    assert.deepEqual(saved,before);
  }
});

test('the previous published save format restores without its missing scene snapshot and upgrades its runtime',()=>{
  const saved=record(),script=Object.keys(content.campaign.scripts)[0],definition=content.campaign.scripts[script];
  saved.format=33;
  const runtime=saved.session.runtime as unknown as {version:number;runs:unknown[]};
  runtime.version=1;
  runtime.runs=[{id:'legacy-run',script,occurrence:'legacy',cursor:{script,node:definition.entry},status:'running',
    stage:{type:'stage',map:saved.world.location.map,x:saved.world.location.x,y:saved.world.location.y,facing:'west',playerVisible:true,cast:[]}}];
  delete saved.world.scene;
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.money,321);
  assert.equal(candidate.session.runtimeState.version,2);
  assert.equal(candidate.session.runtimeState.runs[0]!.stage,undefined,'旧舞台没有场景与绑定，升级时丢弃');
  assert.equal(candidate.world.scene,undefined,'旧档没有场景快照，由地图重新投影');
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('old saves containing removed expansion bags migrate to consumables',()=>{
  const saved=record(),bag=saved.session.bag;
  const equipped=new Set([...Object.values(bag.worn),...bag.companionEquipment.flatMap(([,equipment])=>Object.values(equipment))]);
  const entry=bag.instances.find(value=>!equipped.has(value.id))!;
  entry.item='handbag';
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.bag.get(entry.id)?.item,'healing-potion-m');
  assert.deepEqual(saved,before,'旧档迁移不改写槽里的原件');
});

test('invalid class, map, position and actors are rejected without changing the saved input',()=>{
  for(const change of [
    (game:ReturnType<typeof record>)=>{game.summary.classId='missing';},
    (game:ReturnType<typeof record>)=>{game.world.location.map='missing';},
    (game:ReturnType<typeof record>)=>{game.world.location.x=NaN;},
    (game:ReturnType<typeof record>)=>{game.world.generatedEntities.push({id:'ghost',actor:'missing',x:0,y:0});},
    (game:ReturnType<typeof record>)=>{game.world.scene!.map='another-map';},
    (game:ReturnType<typeof record>)=>{game.world.scene!.actors[0]!.x++;},
    (game:ReturnType<typeof record>)=>{game.world.scene!.actors.push({...game.world.scene!.actors[0]!});},
  ]){
    const saved=record();change(saved);const before=structuredClone(saved);
    assert.throws(()=>prepareSavedGame(saved,content));assert.deepEqual(saved,before);
  }
});
