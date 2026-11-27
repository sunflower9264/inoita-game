import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import test from 'node:test';
import type {Campaign} from '../src/domain/campaign.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {WorldIndex,WorldMap,EnemySpawn} from '../src/domain/content.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import {Session,DEFAULT_ENEMY_RESPAWN_MS} from '../src/domain/session.ts';
import {StoryDirector,type StoryUI} from '../src/domain/story-director.ts';
import {WorldEnemyRoster,encounterSpawnId} from '../src/domain/world-enemies.ts';
import {SaveSlots,captureSaveGame,type SaveStorage} from '../src/domain/save-game.ts';
import {groundLootFor} from '../src/domain/ground-loot.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const published=read<Campaign>('campaign'),world=read<WorldIndex>('world'),battle=read<BattleCatalog>('battle');
const items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
const map=read<WorldMap>('maps/eternal-winter-swamps-40e6e0d1');
const neighbor=read<WorldMap>('maps/'+map.exits[0].destination);
const returnExit=neighbor.exits.find(exit=>exit.destination===map.id)!;
const quest=published.quests.find(quest=>quest.id==='quest-248')!,enemyId='enemy-jagged-teeth-rats-1';
const definition=battle.enemies.find(enemy=>enemy.id===enemyId)!;
// 使用正式任务、敌人、生成点和出口，隔离本条捕捉规则，无需重跑前十章。
const content:Campaign={...published,quests:[quest],questGroups:[],events:[]};
const ui:StoryUI={async dialogue(){},async choice(_prompt,options){return options[0];},async questPopup(){},
  closeDialogue(){},skipDialogue(){}};
function createSession(){return new Session(content,undefined,undefined,items,
  new BattleCharacter('dark-knight',stats,items),battle,stats);}
function enter(session:Session,destination:{map:string;x:number;y:number;facing:'north'|'south'|'east'|'west'},next:WorldMap){
  session.applyStoryCommands([{type:'travel',destination}]);session.enterMap(next.id,next.questItemSpawns??[]);
}
function begin(){const session=createSession();enter(session,{map:map.id,...returnExit.spawn,facing:'east'},map);
  assert.equal(session.accept(quest.id),true);return session;}
function director(session:Session){return new StoryDirector(content,session,ui,()=>{},
  {begin(){},async execute(){},async finish(){},release(){}});}
function targets(session:Session){return session.storyWorld.projectEntities(map.id,[]).filter(entity=>entity.characterId==='npc-458');}
function roster(session:Session){return new WorldEnemyRoster(session,map,[],session.hero!.level,undefined,()=>1);}
function ratCount(enemies:WorldEnemyRoster){return enemies.enemies.filter(enemy=>enemy.enemyId===enemyId).length;}
function progress(session:Session){return session.quests.get(quest.id)!.goals[quest.goals[0].id];}
async function capture(session:Session,story:StoryDirector,enemies:WorldEnemyRoster){
  enemies.refresh();const placed=enemies.enemies.find(enemy=>enemy.enemyId===enemyId);assert.ok(placed,'实际地图仍有可捕捉的鼠');
  const before=enemies.enemySnapshot(placed.key,definition,session.hero!.level)!;
  assert.equal(story.healthChanged(enemyId,before.health,Math.floor(before.maxHealth*.2),before.maxHealth,
    {id:placed.key,map:map.id,x:placed.x,y:placed.y}),true);
  await setImmediate();
  enemies.refresh();const target=targets(session).find(target=>target.id==='quest-target:'+placed.key);assert.ok(target);
  return {target,source:enemies.source(placed.key)!};
}
function roundTrip(session:Session){
  const memory=new Map<string,string>(),storage:SaveStorage={getItem:key=>memory.get(key)??null,
    setItem:(key,value)=>{memory.set(key,value);},removeItem:key=>{memory.delete(key);}};
  const saves=new SaveSlots<{map:string}>(storage);
  saves.write(1,captureSaveGame(session,{map:map.id},{classId:'dark-knight',className:'黑暗骑士',portrait:'kiyan.png',
    level:session.hero!.level,mapId:map.id,mapName:map.name}));
  const saved=saves.inspect(1);assert.equal(saved.kind,'ok');if(saved.kind!=='ok')throw new Error('存档未写入');
  const restored=createSession();restored.restoreState(saved.game.session);restored.enterMap(map.id,map.questItemSpawns??[]);return restored;
}
function leaveAndReturn(session:Session){
  const exit=map.exits[0];enter(session,{map:neighbor.id,...exit.spawn,facing:'west'},neighbor);
  assert.equal(targets(session).length,0,'离图清理尚未交互或已移除的目标NPC');
  enter(session,{map:map.id,...returnExit.spawn,facing:'east'},map);
}

test('the real seven-rat quest uses six native sources, waits without spawning, then gets its seventh after a normal return',async()=>{
  const session=begin(),story=director(session),enemies=roster(session),bag=session.bag.captureState();let defeats=0;
  session.subscribeDefeats(()=>defeats++);
  assert.equal(quest.goals[0].quantity,7);assert.equal(ratCount(enemies),6);
  try{
    for(let count=0;count<6;count++){
      const {target,source}=await capture(session,story,enemies);assert.equal(progress(session),count,'转换不记交互');
      assert.equal(session.enemyDefeated(source),false,'转换不补发死亡事实');
      await story.interact(target,world.actors[target.actor]);assert.equal(progress(session),count+1);
      assert.equal(session.interact(target.actor,target.id,target.characterId),false,'同一NPC移除后不能重复计数');
    }
    session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS*10);enemies.refresh();
    assert.equal(ratCount(enemies),0);assert.equal(targets(session).length,0);assert.equal(progress(session),6);
    assert.equal(session.status(quest.id),'active');assert.equal(defeats,0);
    assert.equal(groundLootFor(session).forMap(map.id).length,0);assert.deepEqual(session.bag.captureState(),bag);
    assert.equal(session.hero!.player.experience,0);assert.equal(session.money,0);
    const restored=roundTrip(session);assert.equal(ratCount(roster(restored)),0,'同一访问JSON恢复继续抑制源');
    leaveAndReturn(restored);const fresh=roster(restored),freshStory=director(restored);
    try{
      assert.equal(ratCount(fresh),6);const {target}=await capture(restored,freshStory,fresh);
      await freshStory.interact(target,world.actors[target.actor]);
      assert.equal(progress(restored),7);assert.equal(restored.status(quest.id),'ready');
      assert.equal(restored.hero!.player.experience,0);assert.equal(restored.money,0);
    }finally{freshStory.dispose();}
  }finally{story.dispose();}
});

test('an uncollected capture survives same-visit JSON save once and disappears on leaving the map',async()=>{
  const session=begin(),story=director(session),enemies=roster(session);
  try{
    const {source}=await capture(session,story,enemies),restored=roundTrip(session),fresh=roster(restored);
    assert.equal(ratCount(fresh),5);assert.equal(targets(restored).length,1);assert.equal(progress(restored),0);
    restored.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS*10);fresh.refresh();
    assert.equal(ratCount(fresh),5);assert.equal(targets(restored).length,1);
    assert.equal(restored.weakenQuestTarget(enemyId,{...source,map:map.id}),false);
    leaveAndReturn(restored);assert.equal(ratCount(roster(restored)),6);assert.equal(targets(restored).length,0);
    assert.equal(progress(restored),0);assert.equal(restored.status(quest.id),'active');
  }finally{story.dispose();}
});

test('capture metadata is validated while ordinary enemy death keeps its normal timer',async()=>{
  const session=begin(),story=director(session),enemies=roster(session);
  try{
    await capture(session,story,enemies);const saved=session.captureState(),captured=saved.enemies.find(([,state])=>state.capture)!;
    captured[1].capture!.visit=saved.storyWorld.mapVisit+1;
    assert.throws(()=>createSession().restoreState(saved),/捕捉来源无效/);
    const ordinary:EnemySpawn={id:'ordinary-control',enemyId,x:40,y:40};
    session.enemyDefeated(ordinary);assert.equal(session.canRespawnEnemy(ordinary),false);
    session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS);assert.equal(session.canRespawnEnemy(ordinary),true);
    assert.equal(ratCount(roster(session)),5,'普通死亡的计时不解除捕捉槽绑定');
  }finally{story.dispose();}
});

test('turning an encounter enemy into a capture target does not count as a settled death',async()=>{
  const session=begin(),story=director(session);
  session.applyStoryCommands([{type:'world',command:{kind:'encounter',encounter:{id:'capture-control',map:map.id,status:'active',
    spawns:[{id:'rat',enemyId,x:40,y:40}]}}}]);
  try{
    const enemies=roster(session),id=encounterSpawnId('capture-control','rat');
    const before=enemies.enemySnapshot(id,definition,session.hero!.level)!;
    assert.equal(story.healthChanged(enemyId,before.health,Math.floor(before.maxHealth*.2),before.maxHealth,
      {id,map:map.id,x:40,y:40}),true);await setImmediate();enemies.refresh();
    assert.deepEqual(enemies.completedEncounters(),[]);
    assert.equal(progress(session),0);assert.equal(session.status(quest.id),'active');
  }finally{story.dispose();}
});
