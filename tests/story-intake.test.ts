import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {Campaign} from '../src/domain/campaign.ts';
import type {WorldMap} from '../src/domain/content.ts';
import type {StoryStage} from '../src/domain/story-performance.ts';
import {Session} from '../src/domain/session.ts';
import {StoryRuntime} from '../src/domain/story-runtime.ts';
import {WorldEnemyRoster, encounterSpawnId,applyStoryEnemyRemovals} from '../src/domain/world-enemies.ts';

const read = <T>(name:string):T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const campaign = read<Campaign>('campaign');

test('a native boss form removal clears the old encounter without awarding a player kill',()=>{
  const session=new Session(campaign);
  const commands=campaign.scripts['event-360'].nodes.flatMap(node=>node.commands).filter(command=>command.type==='world'&&command.command.kind==='remove-enemy');
  assert(commands.length);
  const command=commands[0];if(command.type!=='world'||command.command.kind!=='remove-enemy')assert.fail();
  const enemyId=command.command.enemyId;
  // b17382dd 起 remove-enemy 不再携带预览地图（运行时继承实际当前地图），
  // 这里自己选一张真实地图承载这场遭遇。
  const map='room-of-resurrection-394abb48';
  session.applyStoryCommands([{type:'encounter',encounter:{id:'old-form',map,status:'active',spawns:[{id:'boss',enemyId,x:100,y:100}]}}]);
  const roster=new WorldEnemyRoster(session,{...read<WorldMap>('maps/'+map),enemySpawns:[]},[],1);
  const before=session.captureState().questBook;
  session.applyStoryCommands(commands);
  applyStoryEnemyRemovals(session,map,roster.enemies,key=>roster.removeEnemy(key));
  assert.equal(roster.completedEncounters()[0]?.id,'old-form');
  assert.equal(session.storyWorld.visible(encounterSpawnId('old-form','boss')),false);
  assert.deepEqual(session.captureState().questBook,before);
  assert.deepEqual(session.storyWorld.pendingEnemyRemovals,[]);
});

test('a native encounter without a map condition uses the current scene and finishes after restore',async()=>{
  const session=new Session(campaign),script='event-37',map='shadow-forest-west';
  const port={async prepare(){},currentMap:()=>map,capture:()=>session.captureState(),async present(){return {};},async finish(){},
    commit(commit:import('../src/domain/story-runtime.ts').StoryNodeCommit){session.applyStoryCommands(commit.commands,commit.checkpoint);},
    rollback(value:unknown){session.restoreState(value as ReturnType<Session['captureState']>);},
    evaluate(condition:import('../src/domain/story-condition.ts').StoryCondition){return session.evaluateCondition(condition);}};
  const graph={version:2 as const,scripts:{[script]:campaign.scripts[script]},events:[]};
  const runtime=new StoryRuntime(graph,port);await runtime.start(script);
  const encounter=session.storyWorld.activeEncounters[0];
  assert.equal(encounter.map,map);assert.equal(encounter.mapFromStage,undefined);assert.equal(encounter.spawns.length,4);
  const copy=new StoryRuntime(graph,port);copy.restore(runtime.snapshot());
  assert.equal(await copy.encounterResult(encounter.id,'won','restored-win'),true);
  assert.equal(session.storyWorld.encounter(encounter.id)?.status,'won');
});

test('native enemy location registrations remain on their declared maps after the movie',()=>{
  const session=new Session(campaign);
  const commands=campaign.scripts['event-72'].nodes.flatMap(node=>node.commands).filter(command=>command.type==='world'&&command.command.kind==='enemy-location');
  assert.equal(commands.length,10);session.applyStoryCommands(commands);
  const state=session.captureState();session.restoreState(state);
  assert.equal(session.storyWorld.captureState().enemyLocations?.length,10);
  const location=session.storyWorld.captureState().enemyLocations![0];
  assert(session.storyWorld.enemySpawns(location.map).some(spawn=>spawn.enemyId===location.enemyId));
  session.applyStoryCommands([{type:'world',command:{kind:'enemy-location',enemyId:location.enemyId,location:null}}]);
  assert(!session.storyWorld.enemySpawns(location.map).some(spawn=>spawn.enemyId===location.enemyId));
});

function playback(script:string) {
  const session = new Session(campaign);
  const runtime = new StoryRuntime({version:2, scripts:{[script]:campaign.scripts[script]}, events:[]}, {
    async prepare(){}, capture(){return session.captureState();}, async present(){return {};}, async finish(){},
    commit(commit){session.applyStoryCommands(commit.commands, commit.checkpoint);},
    rollback(snapshot){session.restoreState(snapshot as ReturnType<Session['captureState']>);},
    evaluate(condition, commands){return session.evaluateCondition(condition, commands);},
  });
  return {session, runtime};
}

// 原始事件 15 的指令是 (cmd=9,arg0=1,quest=12,u_2=0)：必须接取而非重置。
// 任务 #12 是类型 0，首次接取调用 IsComplete 后即待交付（findings/234）。
test('published native event 15 accepts quest 12 ready and repeated acceptance writes active', async()=>{
  const {session, runtime} = playback('event-15');
  await runtime.start('event-15');
  assert.equal(session.status('quest-12'), 'ready');
  assert.deepEqual(session.quests.get('quest-12')!.goals, {});
  const running = session.captureState().questBook.runningQuestIds;
  await runtime.start('event-15');
  assert.equal(session.status('quest-12'), 'active');
  assert.deepEqual(session.quests.get('quest-12')!.goals, {});
  assert.deepEqual(session.captureState().questBook.runningQuestIds, running);
});

test('published quest 29 requires both materials and consumes both on settlement', ()=>{
  const session = new Session(campaign), quest = campaign.quests.find(quest=>quest.id==='quest-29')!;
  assert.equal(quest.goals.length, 2);
  session.accept(quest.id);
  session.bag.add(quest.goals[0].target, 5);
  session.applyStoryCommands([{type:'quest',command:{type:'refresh'}}]);
  assert.equal(session.status(quest.id), 'active');
  session.bag.add(quest.goals[1].target, 5);
  session.applyStoryCommands([{type:'quest',command:{type:'refresh'}}]);
  assert.equal(session.status(quest.id), 'ready');
  session.complete(quest.id);
  for(const goal of quest.goals) assert.equal(session.itemCount(goal.target), 0);
  assert.equal(session.status(quest.id), 'completed');
});

test('published delivery quest 50 takes its key from the story event and removes it on settlement', ()=>{
  const session = new Session(campaign), quest = campaign.quests.find(quest=>quest.id==='quest-50')!;
  assert.equal(session.itemCount('west-mine-key'), 0);
  assert.ok(session.accept(quest.id));
  // 钥匙由接取 #50 的那段剧情用事件命令发放，接取本身不再补发第二把。
  assert.equal(session.itemCount('west-mine-key'), 0);
  session.bag.add('west-mine-key', 1);
  session.applyStoryCommands([{type:'quest',command:{type:'refresh'}}]);
  assert.equal(session.status(quest.id), 'ready');
  session.complete(quest.id);
  assert.equal(session.itemCount('west-mine-key'), 0);
});

test('published native event 11 waits for all three settled deaths and deduplicates victory', async()=>{
  const {session, runtime} = playback('event-11');
  await runtime.start('event-11');
  const run = runtime.snapshot().runs[0];
  assert.equal(run.status, 'waiting');
  assert.equal(runtime.busy, false);
  const encounter = session.storyWorld.activeEncounters[0];
  assert.equal(encounter.map, 'shadow-forest-west');
  assert.deepEqual(encounter.spawns.map(spawn=>[spawn.enemyId,spawn.x,spawn.y]), [
    ['enemy-berkel-soldier-3',504,488], ['enemy-berkel-soldier-4',456,440], ['enemy-berkel-soldier-5',552,440],
  ]);
  const roster = new WorldEnemyRoster(session, {...read<WorldMap>('maps/shadow-forest-west'),enemySpawns:[]}, [], 1);
  for(const spawn of encounter.spawns.slice(0,2)) session.enemyDefeated(roster.source(encounterSpawnId(encounter.id,spawn.id))!);
  assert.equal(roster.completedEncounters().length, 0);
  const last = encounter.spawns[2];
  session.enemyDefeated(roster.source(encounterSpawnId(encounter.id,last.id))!);
  assert.equal(roster.completedEncounters()[0].id, encounter.id);
  session.gainMoney(19);
  assert.equal(await runtime.encounterResult(encounter.id,'won','intake:won'), true);
  assert.equal(runtime.snapshot().runs[0].status, 'completed');
  assert.equal(await runtime.encounterResult(encounter.id,'won','intake:won'), false);
  assert.equal(session.money, 19);
});

test('published event 11 has a terminal defeat branch', async()=>{
  const {session, runtime} = playback('event-11');
  await runtime.start('event-11');
  const encounter = session.storyWorld.activeEncounters[0];
  await runtime.encounterResult(encounter.id,'lost','intake:lost');
  assert.equal(runtime.snapshot().runs[0].status, 'completed');
  assert.equal(session.storyWorld.encounter(encounter.id)?.status, 'lost');
});

// 原版事件 27 的 0x44 扣掉事件 26 发出的解毒剂，随后把蜘蛛女王这一场交给真实遭遇。
test('published native event 27 takes the antidote, accepts quest 31 and hands the queen spider fight to a real encounter', async()=>{
  const scripts = { 'event-27': campaign.scripts['event-27'], 'event-28': campaign.scripts['event-28'] };
  const session = new Session(campaign);
  const runtime = new StoryRuntime({version:2, scripts, events:[]}, {
    // 事件 27 的物件命令带 mapFromStage：舞台没给地图时，运行时回落到当前地图。
    async prepare(){}, currentMap:()=>'spider-s-lair-2-ba4a24b9', capture(){return session.captureState();}, async present(){return {};}, async finish(){},
    commit(commit){session.applyStoryCommands(commit.commands, commit.checkpoint);},
    rollback(snapshot){session.restoreState(snapshot as ReturnType<Session['captureState']>);},
    evaluate(condition, commands){return session.evaluateCondition(condition, commands);},
  });
  // 事件 26 的 0x11 给物品在这里已经发生；事件 27 的 0x44 必须能扣掉同一件，任务与道具链才闭合。
  session.applyStoryCommands([{type:'item-give',item:'robbie-s-special-antidote',quantity:1}]);
  await runtime.start('event-27');
  assert.equal(session.itemCount('robbie-s-special-antidote'), 0);
  assert.equal(session.status('quest-31'), 'active');
  assert.equal(runtime.snapshot().runs[0].status, 'waiting');
  const encounter = session.storyWorld.activeEncounters[0];
  assert.equal(encounter.map, 'spider-s-lair-2-ba4a24b9');
  assert.deepEqual(encounter.spawns.map(spawn=>[spawn.enemyId,spawn.x,spawn.y]), [['enemy-queen-spider-1',216,136]]);
  // 打完整场之后任务进入「目标已达成」，事件 28 的条件随之成立。
  const roster = new WorldEnemyRoster(session, {...read<WorldMap>('maps/spider-s-lair-2-ba4a24b9'),enemySpawns:[]}, [], 1);
  for(const spawn of encounter.spawns) session.enemyDefeated(roster.source(encounterSpawnId(encounter.id,spawn.id))!);
  assert.equal(await runtime.encounterResult(encounter.id,'won','intake:won'), true);
  assert.equal(runtime.snapshot().runs[0].status, 'completed');
  assert.equal(session.status('quest-31'), 'ready');
  const settlement = campaign.events.find(event=>event.id==='event-28')!;
  assert.ok(settlement.condition);
  assert.equal(session.evaluateCondition(settlement.condition), true);
  await runtime.start('event-28');
  assert.equal(session.status('quest-31'), 'completed');
});

// 原版事件 28（结算 #30/#31）从不摆主角，也没有切图命令。生成器补的舞台锚点是全图第一块
// 可站格，演出收尾把这个锚点写回世界就会把主角从战场传送走（蜘蛛女王死后 (216,136) → (200,72)）。
// `retainPlayerPosition` 让演出接上一镜的主角位置，收尾写回的就是他真实站的地方；
// 只有放置类命令才算「原版摆过主角」——事件 27 对主角只有一条走位（`0x47`），起点照样是
// 他真实站的地方，所以它也拿这个标记；真有放置命令的事件（事件 3 先切图再放人）不加。见 findings 189。
test('events with no native player placement retain the live player position instead of a synthetic anchor', ()=>{
  const stageOf = (name:string) => campaign.scripts[name].nodes
    .map(node=>node.presentation[0]).find(action=>action?.type==='stage') as StoryStage;
  assert.equal(stageOf('event-28').retainPlayerPosition, true);
  assert.equal(stageOf('event-27').retainPlayerPosition, true);
  assert.equal(stageOf('event-3').retainPlayerPosition, undefined);
});

test('published event 74 requires quest 57 to be active, preserving the native state mask', ()=>{
  const session = new Session(campaign);
  const quest = campaign.quests.find(quest=>quest.id==='quest-57')!;
  assert.equal(quest.completion, 'story');
  assert.equal(quest.giver, undefined);
  const event = campaign.events.find(event=>event.id==='event-74')!;
  assert.ok(event.condition);
  assert.equal(session.evaluateCondition(event.condition), false);
  session.applyStoryCommands([{type:'quest',command:{type:'accept',quest:quest.id}}]);
  assert.equal(session.evaluateCondition(event.condition), true);
  session.applyStoryCommands([{type:'quest',command:{type:'script-ready',quest:quest.id}}]);
  assert.equal(session.status(quest.id), 'ready');
  assert.equal(session.evaluateCondition(event.condition), false);
  session.applyStoryCommands([{type:'quest',command:{type:'script-complete',quest:quest.id}}]);
  assert.equal(session.evaluateCondition(event.condition), false);
  assert.equal(session.money, 0);
});
