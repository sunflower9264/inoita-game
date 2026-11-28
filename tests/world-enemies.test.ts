import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Session, DEFAULT_ENEMY_RESPAWN_MS } from '../src/domain/session.ts';
import { WorldEnemyRoster, applyStoryEnemyRemovals, encounterSpawnId } from '../src/domain/world-enemies.ts';
import { QuestEnemyWatch } from '../src/domain/quest-enemies.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { WorldMap } from '../src/domain/content.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { DropCatalog } from '../src/domain/drops.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { playthrough } from './helpers/story-playthrough.ts';

const content=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}`,import.meta.url),'utf8'));
const campaign=content('campaign.json') as Campaign;
const dropsCatalog=content('drops.json') as DropCatalog;
const itemsCatalog=content('items.json') as ItemCatalog;
const statsCatalog=content('character-stats.json') as CharacterStatsCatalog;
const turtleMap=()=>content('maps/piolren-meadows-7-4c61d9fe.json') as WorldMap;
const turtleSpawnIds=()=>turtleMap().enemySpawns!.filter(spawn=>spawn.enemyId==='enemy-meadow-turtle-1').map(spawn=>spawn.id);
const applyScriptWorld=(session:Session,scriptId:string)=>{
  for(const node of campaign.scripts[scriptId]!.nodes)for(const cmd of node.commands)if(cmd.type==='world')session.applyStoryCommands([cmd]);
};
/** 复现 event-231 的 remove-enemy：先让当前名册消费命令，写入剧情移除和永久死亡。 */
const removeStoryTurtles=(session:Session,map:WorldMap):void=>{
  session.applyStoryCommands([{type:'world',command:{kind:'remove-enemy',enemyId:'enemy-meadow-turtle-1',map:map.id,all:true}}]);
  const roster=new WorldEnemyRoster(session,map,[]);
  applyStoryEnemyRemovals(session,map.id,roster.enemies,key=>roster.removeEnemy(key));
};

test('map enemy dies, remains absent across map visits, then respawns after game time',()=>{
  const session=new Session(campaign);
  const map=content('maps/shadow-forest-west.json') as WorldMap;
  const first=new WorldEnemyRoster(session,map,[]);
  const spawn=first.spawns[0];
  assert.ok(spawn);
  session.setEnemyVitals(spawn.id,1,0);
  session.enemyDefeated(spawn);
  assert.deepEqual(first.refresh().removed,[spawn.id]);
  assert.equal(new WorldEnemyRoster(session,map,[]).source(spawn.id)?.id,spawn.id);
  assert.equal(new WorldEnemyRoster(session,map,[]).enemies.some(enemy=>enemy.key===spawn.id),false);
  session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS-1);
  assert.equal(first.refresh().added.length,0);
  session.advanceGameTime(1);
  assert.deepEqual(first.refresh().added.map(enemy=>enemy.key),[spawn.id]);
  assert.deepEqual(session.enemyVitals(spawn.id),{});
});

test('reused dungeons follow story enemy-availability across chapters regardless of hero level',()=>{
  const hero=new BattleCharacter('lancer',statsCatalog,itemsCatalog);
  hero.restoreState({...hero.captureState(),level:40});
  const session=new Session(campaign,undefined,undefined,itemsCatalog,hero,undefined,statsCatalog);
  const dungeon1=content('maps/shadow-training-dungeon1-5e8c19b4.json') as WorldMap;
  const dungeon2=content('maps/shadow-training-dungeon-2-a6b8293b.json') as WorldMap;
  const enemyIds=(map:WorldMap)=>{
    const roster=new WorldEnemyRoster(session,map,[]);
    const fromSpawns=[...new Set(roster.spawns.map(spawn=>spawn.enemyId))].sort();
    const fromPlaced=[...new Set(roster.enemies.map(enemy=>enemy.enemyId))].sort();
    assert.deepEqual(fromPlaced,fromSpawns,'实际生成的敌怪种类必须与投影名单一致');
    assert.ok(roster.enemies.length>0,'有效刷怪点应实际生成到场上名册');
    return fromPlaced;
  };

  applyScriptWorld(session,'event-0');
  applyScriptWorld(session,'event-604');
  assert.deepEqual(enemyIds(dungeon1),['enemy-cave-bat-1','enemy-fragile-skeleton-soldier-1']);
  assert.deepEqual(enemyIds(dungeon2),['enemy-knife-needled-mosquitoes-1','enemy-reagents-1']);

  applyScriptWorld(session,'event-55');
  applyScriptWorld(session,'event-156');
  const records:{kind:string;detail:unknown}[]=[];
  const previous=globalThis.storyDiagnostics;
  globalThis.storyDiagnostics={record:(kind:string,detail:unknown)=>records.push({kind,detail})} as unknown as typeof globalThis.storyDiagnostics;
  try{
    assert.deepEqual(enemyIds(dungeon1),['enemy-bat-2','enemy-skeleton-2'],'40 级回帝国时应按剧情开关刷出 41 级中期怪');
    assert.deepEqual(enemyIds(dungeon2),['enemy-black-skeleton-1','enemy-boss-skeleton-1','enemy-dungeon-mimics-1'],
      '40 级回帝国时训练场 2 应按剧情开关刷出 42 级中期怪');
    assert.equal(records.filter(record=>record.kind==='map-enemies-empty').length,0);
  }finally{globalThis.storyDiagnostics=previous;}

  applyScriptWorld(session,'event-605');
  assert.deepEqual(enemyIds(dungeon1),['enemy-evil-bat-1','enemy-remains-of-a-forgotten-soldier-1']);
  assert.deepEqual(enemyIds(dungeon2),['enemy-evil-bat-1','enemy-remains-of-a-forgotten-soldier-1']);
});

test('beacon-hill-floor-1 spawns all 7 goblins regardless of hero level',()=>{
  const hero=new BattleCharacter('lancer',statsCatalog,itemsCatalog);
  hero.restoreState({...hero.captureState(),level:53});
  const session=new Session(campaign,undefined,undefined,itemsCatalog,hero,undefined,statsCatalog);
  const map=content('maps/beacon-hill-floor-1-7f80ae24.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]);
  assert.equal(roster.spawns.filter(spawn=>spawn.enemyId==='enemy-white-goblin-warrior-1').length,7);
  assert.equal(roster.spawns.length,8);
  assert.equal(roster.enemies.filter(enemy=>enemy.enemyId==='enemy-white-goblin-warrior-1').length,7);
  assert.equal(roster.enemies.length,8);
});

test('spawn projection is reused until the story world or generated spawns change',()=>{
  const session=new Session(campaign);
  const map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]);
  const first=roster.spawns;
  assert.equal(roster.spawns,first,'没有变化时复用同一份投影');
  const spawn=map.enemySpawns![0]!;
  session.applyStoryCommands([{type:'world',command:{kind:'enemy-availability',map:map.id,enemyId:spawn.enemyId,available:false}}]);
  const next=roster.spawns;
  assert.notEqual(next,first,'剧情世界变化后重新投影');
  assert.ok(!next.some(value=>value.enemyId===spawn.enemyId));
  session.chests.spawnEnemy(map.id,'test','enemy-cave-bat',{x:10,y:20});
  assert.ok(roster.spawns.some(value=>value.id.startsWith('spring:')),'宝箱/泉水生成后重新投影');
});

test('unchanged enemy spawn eligibility does not rescan the map on every battle tick',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]),spawn=roster.spawns[0]!;
  const canSpawn=session.canRespawnEnemy.bind(session);let checks=0;
  session.canRespawnEnemy=value=>{checks++;return canSpawn(value);};
  const revision=session.enemySpawnRevision;
  for(let tick=0;tick<100;tick++){
    session.setEnemyVitals(spawn.id,100-tick,0);session.advanceGameTime(60);
    assert.deepEqual(roster.refresh(),{added:[],removed:[]});
  }
  assert.equal(session.enemySpawnRevision,revision);
  assert.equal(checks,0,'受伤不改变生成资格，不重扫地图');
  session.enemyDefeated(spawn,120);
  assert.deepEqual(roster.refresh().removed,[spawn.id]);
  roster.refresh(); // 槽位离场会使可破坏物替换记录失效，允许重新建立一次生成投影。
  const afterDeath=checks;
  session.advanceGameTime(119);assert.equal(roster.refresh().added.length,0);assert.equal(checks,afterDeath);
  session.advanceGameTime(1);assert.deepEqual(roster.refresh().added.map(value=>value.key),[spawn.id]);
});

test('manual roster removals and restored session eligibility invalidate the stable refresh',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]),spawn=roster.spawns[0]!;
  roster.removeEnemy(spawn.id);
  assert.deepEqual(roster.refresh().added.map(value=>value.key),[spawn.id]);
  const saved=session.captureState();session.enemyDefeated(spawn);
  assert.deepEqual(roster.refresh().removed,[spawn.id]);
  session.restoreState(saved);
  assert.deepEqual(roster.refresh().added.map(value=>value.key),[spawn.id]);
  const placed=roster.captureState();roster.restoreState(placed);
  assert.deepEqual(roster.refresh(),{added:[],removed:[]});
});

test('same-length direct instance replacement cannot bypass the roster identity check',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]),placed=roster.enemies[0]!,original=placed.key;
  placed.key='local-summon';placed.summonedBy='player';
  assert.deepEqual(roster.refresh().added.map(enemy=>enemy.key),[original]);
  assert.ok(roster.enemies.some(enemy=>enemy.key==='local-summon'),'临时召唤仍保留');
});

test('removing a summon owner also removes its summons from the roster',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]),owner=roster.enemies[0]!;
  roster.restoreEnemy({key:'summon',enemyId:owner.enemyId,x:owner.x+8,y:owner.y,summonedBy:owner.key});
  assert.equal(roster.enemies.some(enemy=>enemy.key==='summon'),true);
  session.applyStoryCommands([{type:'world',command:{kind:'enemy-availability',map:map.id,enemyId:owner.enemyId,available:false}}]);
  const changes=roster.refresh();
  assert.ok(changes.removed.includes(owner.key));
  assert.ok(changes.removed.includes('summon'),'主人的生成资格消失时召唤物一起移除');
  assert.equal(roster.enemies.some(enemy=>enemy.key==='summon'),false);
});

test('a source enemy identity changed in place refreshes its existing slot',()=>{
  const session=new Session(campaign),map={id:'identity-map',enemySpawns:[
    {id:'slot',enemyId:'enemy-before',x:16,y:16}
  ]} as unknown as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]);
  map.enemySpawns![0]!.enemyId='enemy-after';
  const changes=roster.refresh();
  assert.deepEqual(changes.removed,['slot']);
  assert.deepEqual(changes.added.map(enemy=>enemy.enemyId),['enemy-after']);
  assert.deepEqual(roster.refresh(),{added:[],removed:[]});
});

test('rolled-back enemy deaths invalidate the spawn eligibility cache',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]),spawn=roster.spawns[0]!;
  assert.throws(()=>session.atomic(()=>{
    session.enemyDefeated(spawn);
    assert.deepEqual(roster.refresh().removed,[spawn.id]);
    throw new Error('rollback');
  },['enemies','questBook']),/rollback/);
  assert.deepEqual(roster.refresh().added.map(enemy=>enemy.key),[spawn.id]);
});

test('an all-hidden map records a map-enemies-empty diagnostic without tiers',()=>{
  const map=content('maps/shadow-training-dungeon1-5e8c19b4.json') as WorldMap;
  const hidden=new Session(campaign);
  const enemyIds=[...new Set(map.enemySpawns!.map(spawn=>spawn.enemyId))];
  hidden.applyStoryCommands(enemyIds.map(enemyId=>({type:'world' as const,
    command:{kind:'enemy-availability' as const,map:map.id,enemyId,available:false}})));
  const records:{kind:string;detail:Record<string,unknown>}[]=[];
  const previous=globalThis.storyDiagnostics;
  globalThis.storyDiagnostics={record:(kind:string,detail:unknown)=>records.push({kind,detail:detail as Record<string,unknown>})} as unknown as typeof globalThis.storyDiagnostics;
  try{
    new WorldEnemyRoster(hidden,map,[]);
    const empty=records.filter(record=>record.kind==='map-enemies-empty');
    assert.equal(empty.length,1);
    assert.equal('tiers' in empty[0]!.detail,false);
  }finally{globalThis.storyDiagnostics=previous;}
});

test('quest enemies added after entry restore story-disabled spawns while active and retire when finished',()=>{
  const session=new Session(campaign);
  const map=content('maps/shadow-training-dungeon1-5e8c19b4.json') as WorldMap;
  const target='enemy-evil-bat-1';
  session.applyStoryCommands([{type:'world',command:{kind:'enemy-availability',map:map.id,enemyId:target,available:false}}]);
  let ids:ReadonlySet<string>=new Set();
  const provider={snapshot:()=>({revision:1,ids})};
  const roster=new WorldEnemyRoster(session,map,[],provider);
  assert.equal(roster.spawns.some(spawn=>spawn.enemyId===target),false);

  ids=new Set([target]);
  assert.ok(roster.refresh().added.some(enemy=>enemy.enemyId===target));
  assert.equal(roster.spawns.some(spawn=>spawn.enemyId===target),true,'任务激活期间补回被剧情禁用的目标怪');

  ids=new Set();
  const retired=roster.refresh();
  assert.ok(retired.removed.length>0,'任务离开进行中后当场撤回被剧情禁用的怪');
  assert.equal(roster.spawns.some(spawn=>spawn.enemyId===target),false,'刷新后恢复剧情禁用');
  assert.equal(roster.enemies.some(enemy=>enemy.enemyId===target),false);
});

test('native quest spirits use ordinary map spawns and deaths alone do not grant material',()=>{
  const quest={...campaign.quests.find(quest=>quest.id==='knight-uniform')!,availableWhen:{type:'always' as const,value:true}};
  const session=new Session({...campaign,quests:[quest],questGroups:[],events:[]});
  assert.equal(session.accept('knight-uniform'),true);
  const map=content('maps/shadow-training-dungeon-2-a6b8293b.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[],undefined,()=>1);
  const spirits=roster.spawns.filter(spawn=>spawn.enemyId==='enemy-reagents-1');
  assert.equal(spirits.length,5);
  for(const spawn of spirits){
    session.enemyDefeated(spawn);
    assert.equal(session.canRespawnEnemy(spawn),false);
    assert.equal(session.enemyDefeated(spawn),false);
    assert.equal(roster.refresh().removed.includes(spawn.id),true);
  }
  assert.equal(session.itemCount('ectoplasm'),0,'death callbacks leave task material to actual drop and pickup');
  assert.equal(session.status('knight-uniform'),'active');
  session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS);
  const returned=roster.refresh().added.map(enemy=>enemy.key);
  assert.ok(spirits.every(spawn=>returned.includes(spawn.id)));
});


test('map resources survive scene rebuilds while summoned instances stay local to the roster',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const definitions=content('battle.json').enemies as import('../src/domain/battle.ts').EnemyDefinition[];
  const roster=new WorldEnemyRoster(session,map,[]),spawn=roster.enemies[0];
  const definition=definitions.find(enemy=>enemy.id===spawn.enemyId)!;
  roster.setEnemyHealth(spawn.key,Math.trunc(definition.maxHealth/2),definition);
  roster.setEnemyMana(spawn.key,0,definition);
  const saved=roster.enemySnapshot(spawn.key,definition)!;
  const summon=roster.placeEnemy(definition.id,32,40);summon.summonedBy=spawn.key;
  roster.moveEnemy(summon.key,40,48);roster.setEnemyHealth(summon.key,1,definition);
  assert.deepEqual([summon.x,summon.y],[40,48]);
  assert.equal(roster.enemySnapshot(spawn.key,definition)!.health,saved.health);
  const restored=new WorldEnemyRoster(session,map,[]);
  assert.deepEqual(restored.enemySnapshot(spawn.key,definition),saved);
  assert.equal(restored.enemies.some(enemy=>enemy.key===summon.key),false);
  roster.removeEnemy(summon.key);
  assert.equal(roster.enemySnapshot(summon.key,definition),undefined);
  assert.deepEqual(roster.enemySnapshot(spawn.key,definition),saved);
});

test('story encounter instances appear after a node commit, require every settled death and survive restoration',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]),enemyId=roster.spawns[0].enemyId;
  const encounter={id:'earl-battle:run-1',map:map.id,status:'active' as const,spawns:[
    {id:'earl',enemyId,x:128,y:128},{id:'guard',enemyId,x:160,y:128}
  ]};
  session.applyStoryCommands([{type:'encounter',encounter}]);
  assert.deepEqual(roster.refresh().added.map(enemy=>enemy.key),encounter.spawns.map(spawn=>encounterSpawnId(encounter.id,spawn.id)));
  const earl=roster.source(encounterSpawnId(encounter.id,'earl'))!,guard=roster.source(encounterSpawnId(encounter.id,'guard'))!;
  session.setEnemyVitals(earl.id,0,0);
  assert.equal(roster.completedEncounters().length,0,'zero HP alone does not imply settled rewards');
  session.enemyDefeated(earl);
  assert.equal(roster.completedEncounters().length,0,'a surviving guard keeps the encounter active');
  session.enemyDefeated(guard);
  assert.deepEqual(roster.completedEncounters().map(encounter=>encounter.id),[encounter.id]);
  const state=session.captureState();session.restoreState(state);
  const restored=new WorldEnemyRoster(session,map,[]);
  assert.equal(restored.enemies.some(enemy=>enemy.key===earl.id||enemy.key===guard.id),false);
  assert.equal(restored.completedEncounters()[0].id,encounter.id);
  session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id:encounter.id,result:'won'}}]);
  restored.refresh();assert.equal(restored.completedEncounters().length,0);
  session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS*10);
  assert.equal(restored.refresh().added.some(enemy=>enemy.key===earl.id||enemy.key===guard.id),false);
});

test('completed encounter checks reuse their cache until settlement or encounter changes',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]),enemyId=roster.spawns[0].enemyId;
  const encounter={id:'cache-battle:run-1',map:map.id,status:'active' as const,spawns:[
    {id:'first',enemyId,x:128,y:128},{id:'second',enemyId,x:160,y:128}
  ]};
  session.applyStoryCommands([{type:'encounter',encounter}]);
  roster.refresh();
  const unfinished=roster.completedEncounters();
  assert.deepEqual(unfinished,[]);
  assert.equal(roster.completedEncounters(),unfinished,'敌人和遭遇状态没变时复用缓存');
  const first=roster.source(encounterSpawnId(encounter.id,'first'))!,second=roster.source(encounterSpawnId(encounter.id,'second'))!;
  session.enemyDefeated(first);
  const partial=roster.completedEncounters();
  assert.notEqual(partial,unfinished,'死亡结算使缓存失效');
  assert.deepEqual(partial,[]);
  session.enemyDefeated(second);
  const completed=roster.completedEncounters();
  assert.deepEqual(completed.map(value=>value.id),[encounter.id]);
  assert.equal(roster.completedEncounters(),completed);
  const saved=session.captureState();
  session.restoreState(saved);
  const restored=new WorldEnemyRoster(session,map,[]);
  assert.deepEqual(restored.completedEncounters().map(value=>value.id),[encounter.id],'恢复状态后重新判定');
  session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id:encounter.id,result:'won'}}]);
  assert.deepEqual(restored.completedEncounters(),[],'遭遇结算使缓存失效');
});

test('loading a save taken during an active encounter restores its boss',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const enemyId=(new WorldEnemyRoster(session,map,[])).spawns[0].enemyId;
  const encounter={id:'boss-battle:run-1',map:map.id,status:'active' as const,spawns:[
    {id:'boss',enemyId,x:128,y:128}
  ]};
  session.applyStoryCommands([{type:'encounter',encounter}]);
  const state=session.captureState();

  // 战败后读取这份存档，走的是新建会话再恢复；遭遇仍是 active，Boss 必须重新出现在名册里。
  const loaded=new Session(campaign);loaded.restoreState(state);
  const roster=new WorldEnemyRoster(loaded,map,[]);
  const key=encounterSpawnId(encounter.id,'boss');
  assert.equal(loaded.storyWorld.encounter(encounter.id)?.status,'active');
  assert.equal(roster.enemies.some(enemy=>enemy.key===key),true);
});

test('completed story encounters ignore a long settled history',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const enemyId=(new WorldEnemyRoster(session,map,[])).spawns[0].enemyId;
  for(let index=0;index<100;index++){
    const id=`settled-battle-${index}`;
    session.applyStoryCommands([{type:'encounter',encounter:{id,map:map.id,status:'active',spawns:[{id:'enemy',enemyId,x:index,y:index}]}}]);
    session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id,result:'won'}}]);
  }
  const encounter={id:'current-battle',map:map.id,status:'active' as const,spawns:[{id:'boss',enemyId,x:64,y:64}]};
  session.applyStoryCommands([{type:'encounter',encounter}]);
  const roster=new WorldEnemyRoster(session,map,[]),key=encounterSpawnId(encounter.id,'boss');
  const spawn=roster.source(key)!;
  session.setEnemyVitals(key,0,0);
  session.enemyDefeated(spawn);
  assert.deepEqual(roster.completedEncounters().map(value=>value.id),['current-battle'],
    '每帧检查只遍历进行中的遭遇，不受已结算历史数量影响');
  session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id:encounter.id,result:'won'}}]);
  assert.deepEqual(roster.completedEncounters(),[]);
});

test('breakable spawns follow the native replacement branch and reroll after death',()=>{
  const map={id:'breakable-map',breakableSpawn:'jar' as const,enemySpawns:[
    {id:'slot',enemyId:'enemy-base',x:0,y:0,breakableEligible:true}
  ]} as unknown as WorldMap;
  const values=[0,0.05];
  let index=0;
  const session=new Session(campaign);
  const roster=new WorldEnemyRoster(session,map,[],undefined,()=>values[index++]??1);
  assert.equal(roster.source('slot')?.enemyId,'enemy-jar-1');
  const source=roster.source('slot')!;
  session.setEnemyVitals(source.id,0,0);
  session.enemyDefeated(source);
  roster.refresh();
  session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS);
  roster.refresh();
  assert.equal(roster.source('slot')?.enemyId,'enemy-box-1','刷新后重新掷替换结果');
});

test('breakable replacement respects branch, eligibility and quest protection',()=>{
  const spawn={id:'slot',enemyId:'enemy-base',x:0,y:0,breakableEligible:true};
  const make=(branch:'bush'|'jar'|undefined,random:()=>number,eligible=true,ids=new Set<string>())=>
    new WorldEnemyRoster(new Session(campaign),{id:'breakable-map',breakableSpawn:branch,enemySpawns:[{...spawn,breakableEligible:eligible}]} as unknown as WorldMap,
      [],{snapshot:()=>({revision:1,ids})},random);
  assert.equal(make(undefined,()=>0).source('slot')?.enemyId,'enemy-box-1','缺省分支是箱子');
  assert.equal(make('bush',()=>0).source('slot')?.enemyId,'enemy-bush-1');
  assert.equal(make('jar',()=>0).source('slot')?.enemyId,'enemy-jar-1');
  assert.equal(make('jar',()=>0.05).source('slot')?.enemyId,'enemy-box-1');
  assert.equal(make('jar',()=>0.07).source('slot')?.enemyId,'enemy-base');
  assert.equal(make('jar',()=>0,false).source('slot')?.enemyId,'enemy-base','非资格点不替换');
  assert.equal(make('jar',()=>0,true,new Set(['enemy-base'])).source('slot')?.enemyId,'enemy-base','任务敌人不替换');
});

test('a breaking spawn that becomes a quest target restores the original enemy',()=>{
  const map={id:'breakable-map',breakableSpawn:'jar' as const,enemySpawns:[
    {id:'slot',enemyId:'enemy-base',x:0,y:0,breakableEligible:true}
  ]} as unknown as WorldMap;
  let ids=new Set<string>();
  const provider={snapshot:()=>({revision:ids.size,ids})};
  const roster=new WorldEnemyRoster(new Session(campaign),map,[],provider,()=>0);
  assert.equal(roster.source('slot')?.enemyId,'enemy-jar-1');
  ids=new Set(['enemy-base']);
  roster.refresh();
  assert.equal(roster.source('slot')?.enemyId,'enemy-base');
});

test('re-entering a different map respawns ordinary enemies but not permanent ones',()=>{
  const mapA={id:'map-a',enemySpawns:[
    {id:'map-a-spawn-1',enemyId:'enemy-normal',x:0,y:0},
    {id:'map-a-spawn-2',enemyId:'enemy-permanent',x:16,y:0,respawn:false as const}
  ]} as unknown as WorldMap;
  const mapB={id:'map-b',enemySpawns:[]} as unknown as WorldMap;
  const session=new Session(campaign);
  const first=new WorldEnemyRoster(session,mapA,[]);
  const normal=first.source('map-a-spawn-1')!,permanent=first.source('map-a-spawn-2')!;
  session.enemyDefeated(normal);session.enemyDefeated(permanent);
  assert.equal(session.canRespawnEnemy(normal),false);
  assert.equal(session.canRespawnEnemy(permanent),false);

  new WorldEnemyRoster(session,mapB,[]);
  const back=new WorldEnemyRoster(session,mapA,[]);
  assert.ok(back.source('map-a-spawn-1'),'重新进图后普通怪恢复');
  assert.equal(back.enemies.some(enemy=>enemy.key==='map-a-spawn-2'),false,'一次性敌人不恢复');

  // 同一张图的场景重建（读档、检查点、同图演出）不是新访问，不能把刚杀的怪刷回来。
  session.enemyDefeated(back.source('map-a-spawn-1')!);
  const rebuilt=new WorldEnemyRoster(session,mapA,[]);
  assert.equal(rebuilt.enemies.some(enemy=>enemy.key==='map-a-spawn-1'),false);
});

test('restored breakable identities stay pinned to the saved roster',()=>{
  const map={id:'breakable-map',breakableSpawn:'jar' as const,enemySpawns:[
    {id:'slot-a',enemyId:'enemy-base-a',x:0,y:0,breakableEligible:true},
    {id:'slot-b',enemyId:'enemy-base-b',x:16,y:0,breakableEligible:true}
  ]} as unknown as WorldMap;
  const saved=new WorldEnemyRoster(new Session(campaign),map,[],undefined,()=>0).captureState();
  // 新名册构造时本来会把两个槽都解析成原怪；恢复后必须沿用存档里的罐子身份。
  const restored=new WorldEnemyRoster(new Session(campaign),map,[],undefined,()=>0.9);
  assert.deepEqual(restored.enemies.map(enemy=>enemy.enemyId),['enemy-base-a','enemy-base-b']);
  restored.restoreState(saved);
  assert.deepEqual(restored.spawns.map(spawn=>spawn.enemyId),['enemy-jar-1','enemy-jar-1']);
  assert.deepEqual(restored.refresh(),{added:[],removed:[]},'恢复后不能把同 key 当成换怪');
  assert.equal(restored.source('slot-a')?.enemyId,'enemy-jar-1','死亡结算读到的也是恢复后的身份');
});

test('restored original identities are pinned even when a fresh roll would replace them',()=>{
  const map={id:'breakable-map',breakableSpawn:'jar' as const,enemySpawns:[
    {id:'slot',enemyId:'enemy-base',x:0,y:0,breakableEligible:true}
  ]} as unknown as WorldMap;
  const saved=new WorldEnemyRoster(new Session(campaign),map,[],undefined,()=>0.9).captureState();
  const restored=new WorldEnemyRoster(new Session(campaign),map,[],undefined,()=>0);
  assert.equal(restored.source('slot')?.enemyId,'enemy-jar-1','构造时本来会掷成罐子');
  restored.restoreState(saved);
  assert.equal(restored.spawns[0]?.enemyId,'enemy-base');
  assert.deepEqual(restored.refresh(),{added:[],removed:[]});
});

test('a same-key identity change does not reroll the breakable cache',()=>{
  const map={id:'breakable-map',breakableSpawn:'jar' as const,enemySpawns:[
    {id:'slot',enemyId:'enemy-base',x:0,y:0,breakableEligible:true}
  ]} as unknown as WorldMap;
  let rolls=0;
  const roster=new WorldEnemyRoster(new Session(campaign),map,[],undefined,()=>rolls++===0?0:0.9);
  assert.equal(roster.source('slot')?.enemyId,'enemy-jar-1');
  roster.enemies[0]!.enemyId='enemy-base';
  const first=roster.refresh();
  assert.deepEqual(first.removed,['slot']);
  assert.deepEqual(first.added.map(enemy=>enemy.enemyId),['enemy-jar-1']);
  assert.deepEqual(roster.refresh(),{added:[],removed:[]},'同 key 换身份后不能重掷成另一种身份');
  assert.equal(roster.source('slot')?.enemyId,'enemy-jar-1');
});

test('event-115 availability clears and restores all hall ghosts including a breakable slot',()=>{
  const map=content('maps/noxious-sanctum-main-hall-2e80d907.json') as WorldMap;
  const spawnIds=map.enemySpawns!.map(spawn=>spawn.id).sort();
  const session=new Session(campaign);
  const availability=(available:boolean)=>session.applyStoryCommands([{type:'world',
    command:{kind:'enemy-availability',map:map.id,enemyId:'enemy-cursed-ghost-1',available}}]);
  const rolls=[0,0.9,0.9,0.9,0.9,0.9,0.9];
  let roll=0;

  availability(false);
  const roster=new WorldEnemyRoster(session,map,[],undefined,()=>rolls[roll++]??0.9);
  assert.equal(roster.spawns.length,0);
  assert.deepEqual(roster.refresh().added,[]);

  availability(true);
  assert.deepEqual(roster.refresh().added.map(enemy=>enemy.key).sort(),spawnIds);
  assert.deepEqual(roster.spawns.map(spawn=>spawn.id).sort(),spawnIds);
  assert.equal(roster.source(spawnIds[0]!)?.enemyId,'enemy-jar-1','可破坏物槽也被压制后重新掷出替换结果');

  availability(false);
  assert.deepEqual(roster.spawns,[]);
  assert.deepEqual(roster.refresh().removed.sort(),spawnIds,'恢复后的替换槽同样会被清场');
});

test('event-115 scene commands suppress the hall ghosts until the battle result restores them',()=>{
  const map=content('maps/noxious-sanctum-main-hall-2e80d907.json') as WorldMap;
  const script=campaign.scripts['event-115']!;
  const commands=(node:string)=>script.nodes.find(entry=>entry.id===node)!.commands;
  const spawnIds=map.enemySpawns!.map(spawn=>spawn.id).sort();
  for(const result of ['battle-won','battle-lost']){
    const session=new Session(campaign);
    const roster=new WorldEnemyRoster(session,map,[],undefined,()=>0.9);
    assert.deepEqual(roster.spawns.map(spawn=>spawn.id).sort(),spawnIds);

    session.applyStoryCommands(commands('scene-1'));
    assert.equal(roster.spawns.length,0);
    assert.deepEqual(roster.refresh().removed.sort(),spawnIds);

    session.applyStoryCommands(commands(result));
    assert.deepEqual(roster.refresh().added.map(enemy=>enemy.key).sort(),spawnIds);
    assert.deepEqual(roster.spawns.map(spawn=>spawn.id).sort(),spawnIds);
  }
});

test('pending removals keep commands for maps that were not applied yet',()=>{
  const mapA={id:'map-a',enemySpawns:[{id:'map-a-spawn',enemyId:'enemy-a',x:0,y:0}]} as unknown as WorldMap;
  const mapB={id:'map-b',enemySpawns:[{id:'map-b-spawn',enemyId:'enemy-b',x:0,y:0}]} as unknown as WorldMap;
  const session=new Session(campaign);
  session.applyStoryCommands([
    {type:'world',command:{kind:'remove-enemy',enemyId:'enemy-a',map:'map-a',all:true}},
    {type:'world',command:{kind:'remove-enemy',enemyId:'enemy-b',map:'map-b',all:true}},
  ]);

  const rosterA=new WorldEnemyRoster(session,mapA,[]);
  applyStoryEnemyRemovals(session,'map-a',rosterA.enemies,key=>rosterA.removeEnemy(key));
  assert.deepEqual(rosterA.enemies,[]);
  assert.deepEqual(session.storyWorld.pendingEnemyRemovals,[{enemyId:'enemy-b',map:'map-b',all:true}]);

  const rosterB=new WorldEnemyRoster(session,mapB,[]);
  assert.equal(rosterB.enemies.some(enemy=>enemy.key==='map-b-spawn'),true);
  applyStoryEnemyRemovals(session,'map-b',rosterB.enemies,key=>rosterB.removeEnemy(key));
  assert.deepEqual(rosterB.enemies,[]);
  assert.deepEqual(session.storyWorld.pendingEnemyRemovals,[]);
});

test('a second encounter occurrence with the same cast owns fresh enemy resources',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]),enemyId=roster.spawns[0].enemyId;
  const add=(id:string)=>session.applyStoryCommands([{type:'encounter',encounter:{id,map:map.id,status:'active',spawns:[{id:'earl',enemyId,x:128,y:128}]}}]);
  add('run-1');roster.refresh();session.enemyDefeated(roster.source(encounterSpawnId('run-1','earl'))!);
  session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id:'run-1',result:'won'}}]);
  add('run-2');
  assert.deepEqual(roster.refresh().added.map(enemy=>enemy.key),[encounterSpawnId('run-2','earl')]);
});

test('pruning old completed encounters also clears their one-off enemy death records',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]),enemyId=roster.spawns[0].enemyId,keys:string[]=[];
  for(let index=0;index<65;index++){
    const encounter={id:`repeat-${index}`,map:map.id,status:'active' as const,
      spawns:[{id:'mob',enemyId,x:128+index,y:128}]};
    session.applyStoryCommands([{type:'encounter',encounter}]);
    const key=encounterSpawnId(encounter.id,'mob');keys.push(key);
    session.enemyDefeated({...encounter.spawns[0]!,id:key,respawn:false});
    session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id:encounter.id,result:'won'}}]);
  }
  assert.equal(session.storyWorld.encounter('repeat-0'),undefined,'超出上限的已完成遭遇被删');
  assert.deepEqual(session.enemyVitals(keys[0]!),{},'它的怪物死亡记录一起清掉');
  assert.equal(session.storyWorld.encounter('repeat-64')?.status,'won');
  assert.equal(session.enemyVitals(keys[64]!).deadUntil,'permanent','窗口内最近一次遭遇仍保留状态');
});

test('story-removed map enemies return while an active quest targets them',()=>{
  const session=new Session(campaign),map=turtleMap(),spawnIds=turtleSpawnIds();
  removeStoryTurtles(session,map);
  for(const id of spawnIds){
    assert.equal(session.storyWorld.visible(id),false,'剧情 remove-enemy 已撤下地图槽');
    assert.equal(session.enemyVitals(id).deadUntil,'permanent');
  }
  assert.equal(new WorldEnemyRoster(session,map,[]).enemies.some(enemy=>enemy.enemyId==='enemy-meadow-turtle-1'),false,
    '没有进行中任务时不生成');

  assert.equal(session.accept('quest-357'),true);
  const roster=new WorldEnemyRoster(session,map,[],new QuestEnemyWatch(session,dropsCatalog.questItems),()=>1);
  assert.deepEqual(roster.enemies.filter(enemy=>enemy.enemyId==='enemy-meadow-turtle-1').map(enemy=>enemy.key).sort(),
    [...spawnIds].sort(),'任务目标豁免剧情永久移除');
  for(const id of spawnIds)assert.deepEqual(session.enemyVitals(id),{},'豁免生成前清掉永久死亡与 0 血记录');
});

test('kills still count after the story returns a quest-target map enemy',()=>{
  const session=new Session(campaign),map=turtleMap(),spawnIds=turtleSpawnIds();
  removeStoryTurtles(session,map);
  assert.equal(session.accept('quest-357'),true);
  const roster=new WorldEnemyRoster(session,map,[],new QuestEnemyWatch(session,dropsCatalog.questItems),()=>1);
  const key=spawnIds[0]!,spawn=roster.source(key)!;
  assert.equal(spawn.enemyId,'enemy-meadow-turtle-1');
  const previousFacts=session.questBook.factSequence('combat');
  session.enemyDefeated(spawn);
  assert.equal(session.questBook.factSequence('combat'),previousFacts+1,'击杀事实不会因旧死亡记录被跳过');
  assert.equal(typeof session.enemyVitals(key).deadUntil,'number','击杀后按普通刷新计时');
  session.bag.add('meadow-turtle-s-shell',3);session.refresh();
  assert.equal(session.questBook.state('quest-357')!.goals['objective-1'],3,'任务物品目标正常计数');
});

test('story-removed quest targets survive unrelated refreshes',()=>{
  const session=new Session(campaign),map=turtleMap(),spawnIds=turtleSpawnIds();
  removeStoryTurtles(session,map);
  assert.equal(session.accept('quest-357'),true);
  const roster=new WorldEnemyRoster(session,map,[],new QuestEnemyWatch(session,dropsCatalog.questItems),()=>1);
  assert.equal(roster.enemies.filter(enemy=>enemy.enemyId==='enemy-meadow-turtle-1').length,spawnIds.length);

  session.applyStoryCommands([{type:'flag',flag:'unrelated-refresh',value:true}]);
  assert.deepEqual(roster.refresh().removed,[],'无关剧情修订不会删掉已生成的任务怪');
  assert.equal(roster.enemies.filter(enemy=>enemy.enemyId==='enemy-meadow-turtle-1').length,spawnIds.length);

  session.setEnemyVitals(spawnIds[0]!,100,50);
  session.applyStoryCommands([{type:'flag',flag:'damaged-refresh',value:true}]);
  assert.deepEqual(roster.refresh().removed,[],'掉血后的活怪同样不能被刷新删掉');
  assert.deepEqual(session.enemyVitals(spawnIds[0]!),{health:100,mana:50});
});

test('a quest target removed by story keeps its normal death timer',()=>{
  const session=new Session(campaign),map=turtleMap(),spawnIds=turtleSpawnIds();
  removeStoryTurtles(session,map);
  assert.equal(session.accept('quest-357'),true);
  const roster=new WorldEnemyRoster(session,map,[],new QuestEnemyWatch(session,dropsCatalog.questItems),()=>1);
  const key=spawnIds[0]!,spawn=roster.source(key)!;
  session.enemyDefeated(spawn);
  roster.removeEnemy(key);
  assert.deepEqual(roster.refresh().added,[],'普通击杀的刷新计时期间不能借任务豁免复活');
  assert.equal(typeof session.enemyVitals(key).deadUntil,'number');
  session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS);
  assert.ok(roster.refresh().added.some(enemy=>enemy.key===key),'计时结束后照常恢复');
});

test('a story-removed encounter enemy is not restored by a quest target',()=>{
  const session=new Session(campaign),map='hall-of-abyss-f7a501f5';
  session.applyStoryCommands([{type:'encounter',encounter:{id:'boss-battle',map,status:'active',
    spawns:[{id:'boss',enemyId:'enemy-alexander-2',x:100,y:100}]}}]);
  assert.equal(session.accept('quest-297'),true);
  const roster=new WorldEnemyRoster(session,{...content('maps/'+map+'.json') as WorldMap,enemySpawns:[]},[],
    new QuestEnemyWatch(session,dropsCatalog.questItems));
  const key=encounterSpawnId('boss-battle','boss');
  session.removeStoryEnemy(key);
  assert.deepEqual(roster.refresh().added,[],'剧情遭遇槽不能被任务豁免刷回来');
  assert.equal(roster.enemies.some(enemy=>enemy.key===key),false);
});

test('a finished or unaccepted quest no longer exempts story-removed map enemies',()=>{
  const session=new Session(campaign),map=turtleMap(),spawnIds=turtleSpawnIds();
  removeStoryTurtles(session,map);
  assert.equal(session.accept('quest-357'),true);
  const watch=new QuestEnemyWatch(session,dropsCatalog.questItems);
  const roster=new WorldEnemyRoster(session,map,[],watch,()=>1);
  assert.equal(roster.enemies.some(enemy=>enemy.enemyId==='enemy-meadow-turtle-1'),true);

  session.bag.add('meadow-turtle-s-shell',3);
  session.bag.add('canyon-bear-s-gallbladder',3);
  session.refresh();
  assert.equal(session.status('quest-357'),'ready');
  const readyChanges=roster.refresh();
  assert.ok(spawnIds.every(id=>readyChanges.removed.includes(id)),'待交付后剧情移除重新生效');
  assert.equal(roster.enemies.some(enemy=>enemy.enemyId==='enemy-meadow-turtle-1'),false);

  assert.equal(session.complete('quest-357'),true);
  assert.equal(session.status('quest-357'),'available','可重复任务回到可接取');
  assert.equal(new WorldEnemyRoster(session,map,[],watch,()=>1).enemies.some(enemy=>enemy.enemyId==='enemy-meadow-turtle-1'),false,
    '完成并重新进图也不会生成');
});

test('activeQuest campaign spawn invalidates sourceProjection without questEnemies provider',()=>{
  const quest={...campaign.quests.find(q=>q.id==='knight-uniform')!,availableWhen:{type:'always' as const,value:true}};
  const session=new Session({...campaign,quests:[quest],questGroups:[],events:[]});
  const map={id:'quest-spawn-map',enemySpawns:[]} as unknown as WorldMap;
  const questSpawn={id:'q-placement',enemyId:'enemy-reagents-1',map:'quest-spawn-map',x:32,y:32,activeQuest:'knight-uniform',rewardItem:'ectoplasm',respawn:false as const};
  const roster=new WorldEnemyRoster(session,map,[questSpawn]);
  assert.equal(roster.enemies.length,0,'接取前 activeQuest 刷怪点不生成');

  assert.equal(session.accept('knight-uniform'),true);
  const changes=roster.refresh();
  assert.deepEqual(changes.added.map(e=>e.key),['q-placement'],'未传 questEnemies 时 questBook.version 变更仍应立即失效 sourceProjection 并刷出');
  assert.equal(roster.enemies.length,1);
});

test('breakableEligible quest target without cached roll does not spuriously bump breakableRevision on unrelated story flags',()=>{
  const session=new Session(campaign);
  const map={id:'breakable-rev-map',breakableSpawn:'jar',enemySpawns:[
    {id:'slot-1',enemyId:'enemy-cave-bat-1',x:32,y:32,breakableEligible:true},
  ]} as unknown as WorldMap;
  const ids=new Set(['enemy-cave-bat-1']);
  const provider={snapshot:()=>({revision:1,ids})};
  const roster=new WorldEnemyRoster(session,map,[],provider,()=>0);
  assert.equal(roster.enemies[0]?.enemyId,'enemy-cave-bat-1');
  const before=roster.presenceRevision;
  session.mark('unrelated-story-flag');
  const afterFlag=roster.presenceRevision;
  assert.equal(afterFlag,before+1,'无关剧情标志应仅推进一次 presenceRevision');
  void roster.spawns;
  assert.equal(roster.presenceRevision,afterFlag,'无缓存可破坏替换记录时读取 spawns 不应额外递增 breakableRevision');
});

test('new session StoryDirector automatically chains event-604 after event-0 to disable endgame spawns',async()=>{
  const h=playthrough();
  try{
    assert.equal(await h.director.start(),true);
    await h.idle();
    assert.equal(h.session.runtimeState.completedEvents.includes('event-0'),true);
    assert.equal(h.session.runtimeState.completedEvents.includes('event-604'),true,'开场 event-0 完成后应由真实导演自动串联触发 event-604');
    const dungeon1=content('maps/shadow-training-dungeon1-5e8c19b4.json') as WorldMap;
    const dungeon2=content('maps/shadow-training-dungeon-2-a6b8293b.json') as WorldMap;
    const roster1=new WorldEnemyRoster(h.session,dungeon1,[]);
    const roster2=new WorldEnemyRoster(h.session,dungeon2,[]);
    assert.deepEqual([...new Set(roster1.enemies.map(e=>e.enemyId))].sort(),['enemy-cave-bat-1','enemy-fragile-skeleton-soldier-1']);
    assert.deepEqual([...new Set(roster2.enemies.map(e=>e.enemyId))].sort(),['enemy-knife-needled-mosquitoes-1','enemy-reagents-1']);
  }finally{
    h.director.dispose();
  }
});
