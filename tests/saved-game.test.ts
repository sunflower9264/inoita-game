import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {AutoSaver} from '../src/application/auto-save.ts';
import {captureSessionSave,prepareSavedGame,type SavedGameContent} from '../src/application/saved-game.ts';
import type {MenuPanels} from '../src/domain/menu-panels.ts';
import {newStorySession} from '../src/domain/story-class.ts';
import {captureSaveGame,saveSummary} from '../src/domain/save-game.ts';
import type {StoryWorldViewSnapshot} from '../src/application/world-snapshot.ts';
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

test('未创建菜单时，切到后台仍能保存当前职业和地图并读回',()=>{
  const {session,map,world}=prepareSavedGame(record(1),content);
  const source={storyClasses:content.storyClasses,menuPanels:read<MenuPanels>('menu-panels'),
    captureSaveWorld:()=>({ok:true as const,map,world})};
  const writes:ReturnType<typeof record>[]=[];
  const saver=new AutoSaver<StoryWorldViewSnapshot>({
    enabled:()=>true,
    capture:()=>{
      const captured=captureSessionSave(session,content.world,source);
      return captured.ok?captured.record:undefined;
    },
    write:game=>writes.push(game),
  });
  saver.flushForBackground();
  assert.equal(writes.length,1);
  const saved=writes[0];
  assert.equal(saved.summary.classId,session.hero!.classId);
  assert.equal(saved.summary.mapId,map.id);
  assert.equal(saved.summary.screenshot,undefined);
  assert.deepEqual(prepareSavedGame(saved,content).world,world);
});

test('a save before the minotaur scene keeps its fishcake',()=>{
  const saved=record(),bag=saved.session.bag,id='legacy-fishcake';
  bag.instances.push({id,item:'special-fishcake',quantity:1,enhancement:0,gems:[]});
  bag.pouches.quest.push(id);bag.allCells.push(id);
  const candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.bag.count('special-fishcake'),1,'还没走过那段剧情时保留任务道具');
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

test('scene visit actors are validated before installation',()=>{
  const saved=record();
  saved.world.scene!.visit={generatedEntities:[{id:'visitor',actor:'missing',x:0,y:0}],
    breakableRolls:[],roster:{enemies:[],sequence:0,partySize:1}};
  const before=structuredClone(saved);
  assert.throws(()=>prepareSavedGame(saved,content),/存档记录的地图人物无效/);
  assert.deepEqual(saved,before);
  saved.world.scene!.visit.generatedEntities[0]!.actor=content.campaign.start.actor;
  assert.equal(prepareSavedGame(saved,content).world.scene!.visit!.generatedEntities[0]!.actor,content.campaign.start.actor);
});

test('scene visit enemy roster and breakable rolls are validated before installation',()=>{
  const enemy=content.battleCatalog.enemies[0]!.id;
  for(const invalid of ['roster','roll']){
    const saved=record();
    const visit=saved.world.scene!.visit={generatedEntities:[],
      breakableRolls:[['spawn',invalid==='roll'?'missing':enemy]],
      roster:{enemies:[{key:'enemy',enemyId:invalid==='roster'?'missing':enemy,x:0,y:0}],sequence:0,partySize:1}};
    const before=structuredClone(saved);
    assert.throws(()=>prepareSavedGame(saved,content),/存档记录的地图敌人无效/);
    assert.deepEqual(saved,before);
    visit.roster.enemies[0]!.enemyId=enemy;visit.breakableRolls[0]![1]=enemy;
    assert.deepEqual(prepareSavedGame(saved,content).world.scene!.visit,visit);
  }
});

test('current saves keep the per-map consumed sword list',()=>{
  const saved=record();saved.session.legendaryWeapons={used:['map-a:sword-001','map-a:sword-005']};
  const candidate=prepareSavedGame(saved,content);
  assert.deepEqual(candidate.session.legendaryWeapons.captureState(),{used:['map-a:sword-001','map-a:sword-005']});
});

test('equipment defaults unlocked and current equipment locks round trip',()=>{
  const candidate=prepareSavedGame(record(),content);
  assert.ok(candidate.session.bag.captureState().instances.every(entry=>!entry.locked));
  const saved=record(),equipment=saved.session.bag.instances.find(entry=>content.items.items[entry.item].equipment)!;
  equipment.locked=true;
  const loaded=prepareSavedGame(saved,content);
  assert.equal(loaded.session.bag.get(equipment.id)!.locked,true);
});

test('current saves retain explicit hero posture', () => {
  const current = record();
  current.world.scene!.actors[0].townPose = false;
  assert.equal(prepareSavedGame(current, content).world.scene!.actors[0].townPose, false);
});

test('only format 1 is installed',()=>{
  const saved=record();
  assert.equal(saved.format,1);
  for(const format of [0,2,3])
    assert.throws(()=>prepareSavedGame({...saved,format},content),/存档版本不受支持/);
});


test('a save with no living member is rejected',()=>{
  const saved=record();saved.session.hero!.health=0;
  assert.throws(()=>prepareSavedGame(saved,content),/存档没有存活队员/);
});

test('a saved sentinel quest resumes after seven defeats and grants its reward once',()=>{
  const initial=record();
  const {session,world}=prepareSavedGame(initial,content);
  assert.equal(session.accept('quest-39'),true);
  for(let i=0;i<7;i++)session.recordStoryDefeat('enemy-arnen-sentinel-1');
  const checkpoint=captureSaveGame(session,world,initial.summary);
  const resumed=prepareSavedGame(checkpoint,content).session;
  assert.equal(resumed.status('quest-39'),'active');
  resumed.recordStoryDefeat('enemy-arnen-sentinel-1');
  assert.equal(resumed.status('quest-39'),'ready');
  const money=resumed.money;
  assert.equal(resumed.complete('quest-39'),true);
  const reward=resumed.rewardReceiptFor('quest-39')!;
  assert.ok(reward.money>0);
  const restored=prepareSavedGame(captureSaveGame(resumed,world,initial.summary),content).session;
  assert.deepEqual(restored.rewardReceiptFor('quest-39'),reward);
  assert.equal(restored.complete('quest-39'),false);
  assert.equal(restored.money,money+reward.money);
});
