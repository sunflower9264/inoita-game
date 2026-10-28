import assert from 'node:assert/strict';
import { stageSnapshot } from './helpers/story-stage.ts';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { ActorDefinition } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import { Session, DEFAULT_ENEMY_RESPAWN_MS } from '../src/domain/session.ts';
import { AUTO_SAVE_SLOT, MANUAL_SAVE_SLOT_COUNT, SAVE_FORMAT, SaveSlots, captureSaveGame, restoreSaveGame, sanitizeSaveName, saveSummary, type SaveStorage } from '../src/domain/save-game.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const campaign=read<Campaign>('campaign'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
const battle=read<BattleCatalog>('battle'),companions=read<CompanionCatalog>('companions');

interface World { location:{ map:string } }
function memory(initial:Record<string,string>={}):SaveStorage & { entries:Map<string,string> } {
  const entries=new Map(Object.entries(initial));
  return { entries, getItem:key=>entries.get(key) ?? null, setItem:(key,value)=>{entries.set(key,value);}, removeItem:key=>{entries.delete(key);} };
}
/** 与 `story-class.ts` 的 newStorySession 同构：读档时也是先建同职业的新会话再灌状态。 */
function createSession():Session {
  return new Session(campaign,undefined,undefined,items,new BattleCharacter('dark-knight',stats,items),battle,stats,companions);
}
function record(session:Session, world:World = { location:{ map:campaign.start.map } }) {
  return captureSaveGame(session,world,saveSummary(session,{ id:campaign.start.map, name:'黑暗骑士团营地' },{ name:'黑暗骑士', portrait:'assets/ui/menus/character-kiyan.png' }));
}

test('a save slot round-trips the whole session and the world view into a fresh session',()=>{
  const slots=new SaveSlots<World>(memory()),session=createSession(),hero=session.hero!;
  session.enterMap(campaign.start.map);session.accept('grafton-mission');session.trackQuest('grafton-mission');
  hero.addExperience(stats.experience[0]!);hero.allocate('strength',1);hero.setHealth(7);hero.setMana(3);
  session.gainMoney(321);session.mark('saved-flag');session.advanceGameTime(4200);
  session.bag.add(items.startingShortcut,2);
  const before=session.captureState();
  slots.write(1,record(session,{ location:{ map:campaign.start.map } }));

  const reading=slots.inspect(1);
  assert.equal(reading.kind,'ok');
  if(reading.kind!=='ok')return;
  assert.equal(reading.game.format,SAVE_FORMAT);
  // 摘要字段逐一核对；`savedAt` 是写入时刻，不参与固定值比较。
  assert.deepEqual({ ...reading.game.summary, savedAt:undefined },{ classId:'dark-knight', className:'黑暗骑士', portrait:'assets/ui/menus/character-kiyan.png',
    level:hero.player.level, mapId:campaign.start.map, mapName:'黑暗骑士团营地', savedAt:undefined });
  assert.ok(Number.isFinite(reading.game.summary.savedAt),'存档带上写入时间');

  const loaded=createSession(),world=restoreSaveGame(loaded,reading.game);
  assert.deepEqual(world,{ location:{ map:campaign.start.map } });
  assert.deepEqual(loaded.captureState(),before);

  // 槽里的记录是快照：改读出来的那份，既不动会话也不动槽里存的字节。
  reading.game.session.money=9;
  assert.equal(session.captureState().money,before.money);
  const again=slots.inspect(1);
  assert.equal(again.kind==='ok'&&again.game.session.money,before.money);
});

test('damaged slots stay unreadable while an older development format displays EMPTY',()=>{
  const storage=memory({'inotia4.story.v1.slot0':'{not json','inotia4.story.v1.slot1':JSON.stringify({ format:2, summary:{ classId:'dark-knight', mapId:'m', level:1 }, session:{}, world:{} }) });
  const slots=new SaveSlots<World>(storage);
  assert.deepEqual(slots.inspect(0),{ kind:'unreadable', reason:'存档内容不是有效 JSON' });
  assert.equal(slots.inspect(1).kind,'empty');
  assert.deepEqual(slots.inspect(2),{ kind:'empty' });
  slots.erase(0);
  assert.deepEqual(slots.inspect(0),{ kind:'empty' });
});

test('the previous published format stays readable until the slot is overwritten',()=>{
  const slots=new SaveSlots<World>(memory()),session=createSession(),legacy=record(session);legacy.format=SAVE_FORMAT-1;
  slots.write(1,legacy);
  const reading=slots.inspect(1);
  assert.equal(reading.kind,'ok');assert.equal(reading.kind==='ok'&&reading.game.format,SAVE_FORMAT-1);
  slots.write(1,record(session));
  const rewritten=slots.inspect(1);
  assert.equal(rewritten.kind,'ok');assert.equal(rewritten.kind==='ok'&&rewritten.game.format,SAVE_FORMAT);
});

test('slot numbers are bounded and a refusing storage reports the write failure',()=>{
  const slots=new SaveSlots<World>(memory()),session=createSession();
  assert.throws(()=>slots.inspect(MANUAL_SAVE_SLOT_COUNT),/存档槽编号无效/);
  assert.throws(()=>slots.write(-1,record(session)),/存档槽编号无效/);
  const refusing=new SaveSlots<World>({ getItem:()=>null, setItem:()=>{ throw new Error('存储空间已满'); }, removeItem:()=>{} });
  assert.throws(()=>refusing.write(0,record(session)),/存储空间已满/);
});

test('ten manual slots plus one auto slot, and the auto slot refuses erase and rename',()=>{
  const storage=memory(),slots=new SaveSlots<World>(storage),session=createSession();
  slots.write(MANUAL_SAVE_SLOT_COUNT-1,record(session));
  assert.equal(slots.inspect(MANUAL_SAVE_SLOT_COUNT-1).kind,'ok','第十个手动槽可用');
  slots.write(AUTO_SAVE_SLOT,record(session));
  assert.ok(storage.entries.has('inotia4.story.v1.auto'),'自动槽写在自己的键上');
  assert.equal(slots.inspect(AUTO_SAVE_SLOT).kind,'ok');
  assert.throws(()=>slots.erase(AUTO_SAVE_SLOT),/自动存档不能删除或改名/);
  assert.throws(()=>slots.rename(AUTO_SAVE_SLOT,'第一章'),/自动存档不能删除或改名/);
  assert.equal(slots.inspect(AUTO_SAVE_SLOT).kind,'ok','拒绝之后自动槽原样保留');
});

test('renaming only rewrites the summary name and keeps the saved state untouched',()=>{
  const slots=new SaveSlots<World>(memory()),session=createSession();
  slots.write(1,record(session));
  const before=slots.inspect(1);assert.equal(before.kind,'ok');if(before.kind!=='ok')return;
  assert.equal(slots.rename(1,'第一章'),'第一章');
  const after=slots.inspect(1);assert.equal(after.kind,'ok');if(after.kind!=='ok')return;
  assert.equal(after.game.summary.name,'第一章');
  assert.equal(after.game.summary.savedAt,before.game.summary.savedAt,'改名不动写入时间');
  assert.deepEqual(after.game.session,before.game.session);
  assert.deepEqual(after.game.world,before.game.world);
  // 覆盖保存时保留旧名字；空名回退到默认叫法。
  slots.write(1,record(session));
  const kept=slots.inspect(1);assert.equal(kept.kind==='ok'&&kept.game.summary.name,'第一章');
  assert.equal(slots.rename(1,'   '),undefined);
  const cleared=slots.inspect(1);assert.equal(cleared.kind==='ok'&&cleared.game.summary.name,undefined);
  assert.throws(()=>slots.rename(0,'第二章'),/没有可以改名的存档/);
});

test('save names keep only Chinese, English and digits',()=>{
  assert.equal(sanitizeSaveName('第一章 Abc 123！？'),'第一章Abc123');
  assert.equal(sanitizeSaveName('刺杀-格里普顿'),'刺杀格里普顿');
  assert.equal(sanitizeSaveName('!!!'),'');
  assert.equal([...sanitizeSaveName('一二三四五六七八九十一二三')].length,12,'超长截断到 12 个字符');
});

test('restoring rejects a save made by another class instead of silently rebuilding it',()=>{
  const session=createSession();
  const foreign=record(session);
  foreign.session.classId='assassin';
  assert.throws(()=>restoreSaveGame(createSession(),foreign),/检查点与当前游戏角色不一致/);
});


test('defeated bosses and removed story enemies survive JSON slots while ordinary respawn timers still run',()=>{
  const session=createSession(),slots=new SaveSlots<World>(memory());
  const boss={id:'grafton-battle',enemyId:'enemy-earl-grafton-1',x:40,y:56,respawn:false as const};
  const ordinary={id:'ordinary-wolf',enemyId:'enemy-wild-wolf-1',x:64,y:64};
  session.enemyDefeated(boss);session.enemyDefeated(ordinary);session.removeStoryEnemy('removed-by-story');
  slots.write(0,record(session));
  const saved=slots.inspect(0);assert.equal(saved.kind,'ok');if(saved.kind!=='ok')return;
  const loaded=createSession();restoreSaveGame(loaded,saved.game);
  assert.deepEqual(loaded.captureState(),session.captureState());
  assert.equal(loaded.enemyVitals(boss.id).deadUntil,'permanent');
  assert.equal(loaded.canSpawnEnemy(boss),false);assert.equal(loaded.canSpawnEnemy(ordinary),false);
  assert.equal(loaded.canSpawnEnemy({...ordinary,id:'removed-by-story'}),false);
  loaded.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS);
  assert.equal(loaded.canSpawnEnemy(ordinary),true);assert.equal(loaded.canSpawnEnemy(boss),false);
  for(const invalid of [null,Infinity,-Infinity,-1]){
    const broken=structuredClone(loaded.captureState());
    (broken.enemies.find(([id])=>id===boss.id)![1] as {deadUntil:unknown}).deadUntil=invalid;
    const before=loaded.captureState();assert.throws(()=>loaded.restoreState(broken),/敌人状态无效/);
    assert.deepEqual(loaded.captureState(),before);
  }
});

test('a debug-pinned quest is stripped from the player save and restores at its natural status',()=>{
  const session=createSession();
  // 收集目标已满足；实验钉住仅影响现场状态。
  assert.equal(session.accept('quest-197'),true);
  for(const goal of session.definition('quest-197')!.goals)session.bag.add(goal.target,goal.quantity);
  session.refresh();
  assert.equal(session.status('quest-197'),'ready');
  session.pinDebugQuest('quest-197');
  assert.equal(session.status('quest-197'),'active');
  const saved=record(session);
  assert.equal(saved.session.questBook.debugPins,undefined,'调试钉住不写进玩家存档');
  const loaded=createSession();
  restoreSaveGame(loaded,saved);
  assert.equal(loaded.status('quest-197'),'ready','读回来是正常任务模型的状态');
});

test('current saves keep playback state but resolve actor appearances again on load',()=>{
  const session=createSession(),script=Object.keys(campaign.scripts)[0],definition=campaign.scripts[script];
  const portalAppearance:ActorDefinition={id:'portal',name:'传送门',description:'',clips:{},portrait:null};
  const stage=stageSnapshot({type:'stage',...campaign.start,facing:'south',playerVisible:true,cast:[]},[
    {id:'entity:portal',actor:'portal',x:48,y:64,facing:'south',visible:true,appearance:portalAppearance,clip:'idle-south'},
    {id:'entity:spring',actor:'spring-empty',x:80,y:64,facing:'south',visible:true},
  ]);
  stage.scenes=[{map:'training-dungeon-one',actors:[
    {id:'player',actor:'player',x:80,y:88,facing:'east',visible:true},
    {id:'entity:random-chest',actor:'chest',x:104,y:120,facing:'south',visible:false},
  ]}];
  const runtime=session.runtimeState;
  runtime.runs=[{id:'story:1',script,occurrence:'fixture',cursor:{script,node:definition.entry},status:'running',stage}];
  runtime.sequence=1;session.runtimeState=runtime;
  const slots=new SaveSlots<World>(memory());slots.write(0,record(session));
  const saved=slots.inspect(0);assert.equal(saved.kind,'ok');if(saved.kind!=='ok')return;
  assert.equal(saved.game.format,SAVE_FORMAT);assert.equal(saved.game.session.runtime.version,3);
  const savedStage=saved.game.session.runtime.runs[0]!.stage!;
  assert.equal(savedStage.scene.actors.find(actor=>actor.id==='entity:portal')!.appearance,undefined,
    '存档不重复保存可重建的完整外观');
  assert.equal(savedStage.scene.actors.find(actor=>actor.id==='entity:portal')!.clip,'idle-south',
    '演出姿态仍留在检查点里');
  const restored=createSession();restoreSaveGame(restored,saved.game);
  const expected=structuredClone(stage);delete expected.scene.actors.find(actor=>actor.id==='entity:portal')!.appearance;
  assert.deepEqual(restored.runtimeState.runs[0]!.stage,expected);
  delete (saved.game.session.runtime.runs[0]!.stage as Partial<typeof stage>).scene;
  assert.throws(()=>restoreSaveGame(createSession(),saved.game),/场景快照/);
});

test('summary reads reuse the parsed summary until the raw save changes',()=>{
  const slots=new SaveSlots<World>(memory()),session=createSession();
  session.enterMap(campaign.start.map);
  slots.write(0,record(session));
  const first=slots.peek(0);
  assert.equal(first.kind,'ok');
  assert.equal(slots.peek(0),first,'原文没变时复用同一份摘要');
  slots.rename(0,'新名字');
  const renamed=slots.peek(0);
  assert.notEqual(renamed,first,'改名后缓存失效');
  assert.equal(renamed.kind==='ok'?renamed.summary.name:undefined,'新名字');
  slots.erase(0);
  assert.equal(slots.peek(0).kind,'empty','删除后缓存失效');
});
