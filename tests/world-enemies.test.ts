import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Session, DEFAULT_ENEMY_RESPAWN_MS } from '../src/domain/session.ts';
import { WorldEnemyRoster, encounterSpawnId, selectMapSpawns } from '../src/domain/world-enemies.ts';
import type { WorldMap } from '../src/domain/content.ts';
import type { Campaign } from '../src/domain/campaign.ts';

const content=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}`,import.meta.url),'utf8'));
const campaign=content('campaign.json') as Campaign;

test('map enemy dies, remains absent across map visits, then respawns after game time',()=>{
  const session=new Session(campaign);
  const map=content('maps/shadow-forest-west.json') as WorldMap;
  const first=new WorldEnemyRoster(session,map,[],1);
  const spawn=first.spawns[0];
  assert.ok(spawn);
  session.setEnemyVitals(spawn.id,1,0);
  session.enemyDefeated(spawn);
  assert.deepEqual(first.refresh().removed,[spawn.id]);
  assert.equal(new WorldEnemyRoster(session,map,[],1).source(spawn.id)?.id,spawn.id);
  assert.equal(new WorldEnemyRoster(session,map,[],1).enemies.some(enemy=>enemy.key===spawn.id),false);
  session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS-1);
  assert.equal(first.refresh().added.length,0);
  session.advanceGameTime(1);
  assert.deepEqual(first.refresh().added.map(enemy=>enemy.key),[spawn.id]);
  assert.deepEqual(session.enemyVitals(spawn.id),{});
});

test('mixed-level source map activates the last tier reached by the hero',()=>{
  const map=content('maps/shadow-training-dungeon1-5e8c19b4.json') as WorldMap;
  const session=new Session(campaign);
  for(const [level,expected] of [[1,3],[40,3],[41,41],[90,41],[103,103],[105,103]]){
    const roster=new WorldEnemyRoster(session,map,[],level);
    assert.ok(roster.spawns.some(spawn=>spawn.tierLevel===expected));
    assert.ok(roster.spawns.every(spawn=>spawn.tierLevel===undefined||spawn.tierLevel===expected));
  }
});

test('spawn projection is reused until the story world or generated spawns change',()=>{
  const session=new Session(campaign);
  const map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[],1);
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

test('tier bands switch only after reaching the next representative level',()=>{
  const map={id:'band-map',enemySpawns:[
    {id:'low',enemyId:'enemy-low',x:0,y:0,tierLevel:10},
    {id:'mid',enemyId:'enemy-mid',x:0,y:0,tierLevel:50},
    {id:'high',enemyId:'enemy-high',x:0,y:0,tierLevel:90},
    {id:'free',enemyId:'enemy-free',x:0,y:0},
  ]} as unknown as WorldMap;
  const ids=(level:number)=>selectMapSpawns(map,[],level).map(spawn=>spawn.id);
  assert.deepEqual(ids(1),['low','free']);
  assert.deepEqual(ids(49),['low','free']);
  assert.deepEqual(ids(50),['mid','free']);
  assert.deepEqual(ids(89),['mid','free']);
  assert.deepEqual(ids(90),['high','free']);
});

test('active quest enemies stay when their tier is not selected',()=>{
  const map={id:'quest-map',enemySpawns:[
    {id:'low',enemyId:'enemy-low',x:0,y:0,tierLevel:10},
    {id:'high',enemyId:'enemy-high',x:0,y:0,tierLevel:90},
    {id:'free',enemyId:'enemy-free',x:0,y:0},
  ]} as unknown as WorldMap;
  const ids=selectMapSpawns(map,[],10,{questEnemies:new Set(['enemy-high'])}).map(spawn=>spawn.id);
  assert.deepEqual(ids,['low','high','free']);
});

test('an unavailable selected band falls back to the nearest lower available tier only',()=>{
  const map={id:'fallback-map',enemySpawns:[
    {id:'low',enemyId:'enemy-low',x:0,y:0,tierLevel:10},
    {id:'mid',enemyId:'enemy-mid',x:0,y:0,tierLevel:50},
    {id:'high',enemyId:'enemy-high',x:0,y:0,tierLevel:90},
  ]} as unknown as WorldMap;
  const lower=selectMapSpawns(map,[],50,{spawnable:spawn=>spawn.enemyId!=='enemy-mid'}).map(spawn=>spawn.id);
  assert.deepEqual(lower,['low'],'选中档不可用时补最近低档');
  const noLower=selectMapSpawns(map,[],50,{spawnable:spawn=>spawn.enemyId==='enemy-high'}).map(spawn=>spawn.id);
  assert.deepEqual(noLower,['mid'],'没有可用低档时不向高档回退');
});

test('story-hidden selected band falls back to a lower tier and an all-hidden map records a diagnostic',()=>{
  const map=content('maps/shadow-training-dungeon1-5e8c19b4.json') as WorldMap;
  const tiers=[...new Set(map.enemySpawns!.flatMap(spawn=>spawn.tierLevel===undefined?[]:[spawn.tierLevel]))];
  const hide=(session:Session,tier:number)=>session.applyStoryCommands(map.enemySpawns!
    .filter(spawn=>spawn.tierLevel===tier).map(spawn=>({type:'world' as const,
      command:{kind:'enemy-availability' as const,map:map.id,enemyId:spawn.enemyId,available:false}})));

  const partial=new Session(campaign);hide(partial,41);
  const fallback=new WorldEnemyRoster(partial,map,[],41);
  assert.ok(fallback.spawns.some(spawn=>spawn.tierLevel===3));
  assert.ok(fallback.spawns.every(spawn=>spawn.tierLevel!==41));

  const hidden=new Session(campaign);for(const tier of tiers)hide(hidden,tier);
  const records:{kind:string;detail:unknown}[]=[];
  const previous=globalThis.storyDiagnostics;
  globalThis.storyDiagnostics={record:(kind:string,detail:unknown)=>records.push({kind,detail})} as unknown as typeof globalThis.storyDiagnostics;
  try{
    new WorldEnemyRoster(hidden,map,[],41);
    assert.equal(records.filter(record=>record.kind==='map-enemies-empty').length,1);
  }finally{globalThis.storyDiagnostics=previous;}
});

test('quest enemies added after entry are merged without swapping the selected tier',()=>{
  const session=new Session(campaign);
  const map=content('maps/shadow-training-dungeon1-5e8c19b4.json') as WorldMap;
  const highSpawn=map.enemySpawns!.find(spawn=>spawn.tierLevel===103)!;
  let ids:ReadonlySet<string>=new Set();
  const provider={snapshot:()=>({revision:1,ids})};
  const roster=new WorldEnemyRoster(session,map,[],10,provider);
  assert.equal(roster.spawns.some(spawn=>spawn.enemyId===highSpawn.enemyId),false);

  ids=new Set([highSpawn.enemyId]);
  assert.ok(roster.refresh().added.some(enemy=>enemy.enemyId===highSpawn.enemyId));
  assert.ok(roster.spawns.every(spawn=>spawn.tierLevel===undefined||spawn.tierLevel===3||spawn.enemyId===highSpawn.enemyId),
    '只补任务怪，不切到高档');

  ids=new Set();
  roster.refresh();
  assert.ok(roster.spawns.some(spawn=>spawn.enemyId===highSpawn.enemyId),'本次进图内任务怪保留到离图');
  const next=new WorldEnemyRoster(session,map,[],10,provider);
  assert.equal(next.spawns.some(spawn=>spawn.enemyId===highSpawn.enemyId),false,'重建名册后恢复档位过滤');
});

test('native quest spirits use ordinary map spawns and deaths alone do not grant material',()=>{
  const quest={...campaign.quests.find(quest=>quest.id==='knight-uniform')!,availableWhen:{type:'always' as const,value:true}};
  const session=new Session({...campaign,quests:[quest],questGroups:[],events:[]});
  assert.equal(session.accept('knight-uniform'),true);
  const map=content('maps/shadow-training-dungeon-2-a6b8293b.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[],4,undefined,()=>1);
  const spirits=roster.spawns.filter(spawn=>spawn.enemyId==='enemy-reagents-1');
  assert.equal(spirits.length,5);
  for(const spawn of spirits){
    session.enemyDefeated(spawn);
    assert.equal(session.canSpawnEnemy(spawn),false);
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
  const roster=new WorldEnemyRoster(session,map,[],1),spawn=roster.enemies[0];
  const definition=definitions.find(enemy=>enemy.id===spawn.enemyId)!;
  roster.setEnemyHealth(spawn.key,Math.trunc(definition.maxHealth/2),definition);
  roster.setEnemyMana(spawn.key,0,definition);
  const saved=roster.enemySnapshot(spawn.key,definition)!;
  const summon=roster.placeEnemy(definition.id,32,40);summon.summonedBy=spawn.key;
  roster.moveEnemy(summon.key,40,48);roster.setEnemyHealth(summon.key,1,definition);
  assert.deepEqual([summon.x,summon.y],[40,48]);
  assert.equal(roster.enemySnapshot(spawn.key,definition)!.health,saved.health);
  const restored=new WorldEnemyRoster(session,map,[],1);
  assert.deepEqual(restored.enemySnapshot(spawn.key,definition),saved);
  assert.equal(restored.enemies.some(enemy=>enemy.key===summon.key),false);
  roster.removeEnemy(summon.key);
  assert.equal(roster.enemySnapshot(summon.key,definition),undefined);
  assert.deepEqual(roster.enemySnapshot(spawn.key,definition),saved);
});

test('story encounter instances appear after a node commit, require every settled death and survive restoration',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[],1),enemyId=roster.spawns[0].enemyId;
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
  const restored=new WorldEnemyRoster(session,map,[],1);
  assert.equal(restored.enemies.some(enemy=>enemy.key===earl.id||enemy.key===guard.id),false);
  assert.equal(restored.completedEncounters()[0].id,encounter.id);
  session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id:encounter.id,result:'won'}}]);
  restored.refresh();assert.equal(restored.completedEncounters().length,0);
  session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS*10);
  assert.equal(restored.refresh().added.some(enemy=>enemy.key===earl.id||enemy.key===guard.id),false);
});

test('loading a save taken during an active encounter restores its boss',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const enemyId=(new WorldEnemyRoster(session,map,[],1)).spawns[0].enemyId;
  const encounter={id:'boss-battle:run-1',map:map.id,status:'active' as const,spawns:[
    {id:'boss',enemyId,x:128,y:128}
  ]};
  session.applyStoryCommands([{type:'encounter',encounter}]);
  const state=session.captureState();

  // 战败后读取这份存档，走的是新建会话再恢复；遭遇仍是 active，Boss 必须重新出现在名册里。
  const loaded=new Session(campaign);loaded.restoreState(state);
  const roster=new WorldEnemyRoster(loaded,map,[],1);
  const key=encounterSpawnId(encounter.id,'boss');
  assert.equal(loaded.storyWorld.encounter(encounter.id)?.status,'active');
  assert.equal(roster.enemies.some(enemy=>enemy.key===key),true);
});

test('breakable spawns follow the native replacement branch and reroll after death',()=>{
  const map={id:'breakable-map',breakableSpawn:'jar' as const,enemySpawns:[
    {id:'slot',enemyId:'enemy-base',x:0,y:0,breakableEligible:true}
  ]} as unknown as WorldMap;
  const values=[0,0.05];
  let index=0;
  const session=new Session(campaign);
  const roster=new WorldEnemyRoster(session,map,[],1,undefined,()=>values[index++]??1);
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
      [],1,{snapshot:()=>({revision:1,ids})},random);
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
  const roster=new WorldEnemyRoster(new Session(campaign),map,[],1,provider,()=>0);
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
  const first=new WorldEnemyRoster(session,mapA,[],1);
  const normal=first.source('map-a-spawn-1')!,permanent=first.source('map-a-spawn-2')!;
  session.enemyDefeated(normal);session.enemyDefeated(permanent);
  assert.equal(session.canSpawnEnemy(normal),false);
  assert.equal(session.canSpawnEnemy(permanent),false);

  new WorldEnemyRoster(session,mapB,[],1);
  const back=new WorldEnemyRoster(session,mapA,[],1);
  assert.ok(back.source('map-a-spawn-1'),'重新进图后普通怪恢复');
  assert.equal(back.enemies.some(enemy=>enemy.key==='map-a-spawn-2'),false,'一次性敌人不恢复');

  // 同一张图的场景重建（读档、检查点、同图演出）不是新访问，不能把刚杀的怪刷回来。
  session.enemyDefeated(back.source('map-a-spawn-1')!);
  const rebuilt=new WorldEnemyRoster(session,mapA,[],1);
  assert.equal(rebuilt.enemies.some(enemy=>enemy.key==='map-a-spawn-1'),false);
});

test('restored breakable identities stay pinned to the saved roster',()=>{
  const map={id:'breakable-map',breakableSpawn:'jar' as const,enemySpawns:[
    {id:'slot-a',enemyId:'enemy-base-a',x:0,y:0,breakableEligible:true},
    {id:'slot-b',enemyId:'enemy-base-b',x:16,y:0,breakableEligible:true}
  ]} as unknown as WorldMap;
  const saved=new WorldEnemyRoster(new Session(campaign),map,[],1,undefined,()=>0).captureState();
  // 新名册构造时本来会把两个槽都解析成原怪；恢复后必须沿用存档里的罐子身份。
  const restored=new WorldEnemyRoster(new Session(campaign),map,[],1,undefined,()=>0.9);
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
  const saved=new WorldEnemyRoster(new Session(campaign),map,[],1,undefined,()=>0.9).captureState();
  const restored=new WorldEnemyRoster(new Session(campaign),map,[],1,undefined,()=>0);
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
  const roster=new WorldEnemyRoster(new Session(campaign),map,[],1,undefined,()=>rolls++===0?0:0.9);
  assert.equal(roster.source('slot')?.enemyId,'enemy-jar-1');
  roster.enemies[0]!.enemyId='enemy-base';
  const first=roster.refresh();
  assert.deepEqual(first.removed,['slot']);
  assert.deepEqual(first.added.map(enemy=>enemy.enemyId),['enemy-jar-1']);
  assert.deepEqual(roster.refresh(),{added:[],removed:[]},'同 key 换身份后不能重掷成另一种身份');
  assert.equal(roster.source('slot')?.enemyId,'enemy-jar-1');
});

test('a second encounter occurrence with the same cast owns fresh enemy resources',()=>{
  const session=new Session(campaign),map=content('maps/shadow-forest-west.json') as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[],1),enemyId=roster.spawns[0].enemyId;
  const add=(id:string)=>session.applyStoryCommands([{type:'encounter',encounter:{id,map:map.id,status:'active',spawns:[{id:'earl',enemyId,x:128,y:128}]}}]);
  add('run-1');roster.refresh();session.enemyDefeated(roster.source(encounterSpawnId('run-1','earl'))!);
  session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id:'run-1',result:'won'}}]);
  add('run-2');
  assert.deepEqual(roster.refresh().added.map(enemy=>enemy.key),[encounterSpawnId('run-2','earl')]);
});
