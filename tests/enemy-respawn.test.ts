import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Session,DEFAULT_ENEMY_RESPAWN_MS,OFFSCREEN_ENEMY_RESPAWN_MS} from '../src/domain/session.ts';
import {WorldEnemyRoster,type EnemyRespawnView} from '../src/domain/world-enemies.ts';
import type {WorldMap} from '../src/domain/content.ts';
import type {Campaign} from '../src/domain/campaign.ts';

const campaign=JSON.parse(readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8')) as Campaign;
const visible={x:0,y:0,width:200,height:200};
const away={x:1000,y:1000,width:200,height:200};
function fixture(respawn=true){
  const session=new Session(campaign);
  const map={id:'respawn-test',enemySpawns:[{id:'resident',enemyId:'enemy-cave-bat',x:100,y:100,respawn}]} as WorldMap;
  const roster=new WorldEnemyRoster(session,map,[]),spawn=roster.spawns[0]!;
  const defeat=()=>{session.enemyDefeated(spawn);roster.refresh(visible);};
  return {session,map,roster,spawn,defeat};
}

test('a visible spawn keeps 60 seconds while an offscreen spawn returns at 20 seconds',()=>{
  for(const [view,deadline] of [[visible,DEFAULT_ENEMY_RESPAWN_MS],[away,OFFSCREEN_ENEMY_RESPAWN_MS]] as const){
    const {session,roster,spawn,defeat}=fixture();defeat();
    session.advanceGameTime(deadline-1);assert.equal(roster.refresh(view).added.length,0);
    session.advanceGameTime(1);assert.deepEqual(roster.refresh(view).added.map(enemy=>enemy.key),[spawn.id]);
    assert.equal(roster.isPresent(spawn.id),true);
    assert.deepEqual(session.enemyVitals(spawn.id),{});
    assert.equal(roster.refresh(visible).removed.length,0,'回头不会撤走已经刷新的怪');
  }
});

test('returning to view before refresh preserves the original normal deadline',()=>{
  const {session,roster,defeat}=fixture();defeat();
  session.advanceGameTime(19_999);roster.refresh(away);
  session.advanceGameTime(1);assert.equal(roster.refresh(visible).added.length,0);
  session.advanceGameTime(39_999);assert.equal(roster.refresh(visible).added.length,0);
  session.advanceGameTime(1);assert.equal(roster.refresh(visible).added.length,1);
});

test('moving the camera after 20 seconds rechecks only waiting spawns and permits early refresh',()=>{
  const {session,roster,defeat}=fixture();defeat();
  session.advanceGameTime(20_000);assert.equal(roster.refresh(visible).added.length,0);
  const early=session.enemyVitals('resident').offscreenRespawnAt;
  assert.equal(roster.refresh(away).added.length,1);
  assert.equal(early,20_000);
});

test('the 48 map-pixel margin protects every edge including its exact boundary',()=>{
  const views:EnemyRespawnView[]=[
    {x:148,y:0,width:100,height:200},{x:-48,y:0,width:100,height:200},
    {x:0,y:148,width:200,height:100},{x:0,y:-48,width:200,height:100},
  ];
  for(const view of views){
    const {session,roster,defeat}=fixture();defeat();session.advanceGameTime(20_000);
    assert.equal(roster.refresh(view).added.length,0);
    const farther={...view};
    if(view.width===100)farther.x+=view.x===148?0.01:-0.01;
    else farther.y+=view.y===148?0.01:-0.01;
    assert.equal(roster.refresh(farther).added.length,1);
  }
});

test('camera resize and a mutated world rectangle are rechecked',()=>{
  const {session,roster,defeat}=fixture();defeat();session.advanceGameTime(20_000);
  const view={...visible};assert.equal(roster.refresh(view).added.length,0);
  view.width=40;assert.equal(roster.refresh(view).added.length,1,'窗口缩小后生成点在缓冲范围外');
});

test('missing or invalid camera information retains the normal deadline',()=>{
  for(const view of [undefined,{...away,width:0},{...away,x:NaN}]){
    const {session,roster,defeat}=fixture();defeat();session.advanceGameTime(20_000);
    assert.equal(roster.refresh(view).added.length,0);
    session.advanceGameTime(40_000);assert.equal(roster.refresh(view).added.length,1);
  }
});

test('saved deaths retain both deadlines through a same-map session rebuild',()=>{
  const first=fixture();first.defeat();first.session.advanceGameTime(19_999);
  const saved=JSON.parse(JSON.stringify(first.session.captureState()));
  const session=new Session(campaign);session.restoreState(saved);
  const roster=new WorldEnemyRoster(session,first.map,[]);
  assert.equal(roster.refresh(away).added.length,0);
  session.advanceGameTime(1);assert.equal(roster.refresh(away).added.length,1);
  session.enemyDefeated(first.spawn);roster.refresh(visible);
  session.enterMap('elsewhere');
  assert.equal(new WorldEnemyRoster(session,first.map,[]).isPresent(first.spawn.id),true,'换图重置普通怪的现有规则保留');
});

test('permanent deaths, captured targets and dynamic story spawns do not accelerate',()=>{
  const once=fixture(false);once.defeat();once.session.advanceGameTime(60_000);
  assert.equal(once.roster.refresh(away).added.length,0);
  const captured=fixture();
  const saved=captured.session.captureState();
  saved.enemies.push(['resident',{deadUntil:'permanent',capture:{map:captured.map.id,visit:saved.storyWorld.mapVisit}}]);
  captured.session.restoreState(saved);captured.roster.refresh(visible);captured.session.advanceGameTime(60_000);
  assert.equal(captured.roster.refresh(away).added.length,0);
  const dynamic=fixture();
  dynamic.session.chests.spawnEnemy(dynamic.map.id,'dynamic','enemy-cave-bat',{x:100,y:100});
  dynamic.roster.refresh();
  const spawn=dynamic.roster.spawns.find(value=>value.id!=='resident')!;
  dynamic.session.enemyDefeated(spawn);dynamic.roster.refresh(visible);dynamic.session.advanceGameTime(20_000);
  assert.equal(dynamic.roster.refresh(away).added.some(enemy=>enemy.key===spawn.id),false);
});

test('moving the camera does not rescan all living enemies or all spawns before an early deadline',t=>{
  const {session,roster,defeat}=fixture();
  const canRespawn=t.mock.method(session,'canRespawnEnemy');
  for(let index=0;index<100;index++)roster.refresh({...visible,x:index});
  assert.equal(canRespawn.mock.callCount(),0);
  defeat();roster.refresh(visible);
  const before=canRespawn.mock.callCount();
  for(let index=0;index<100;index++){session.advanceGameTime(1);roster.refresh({...visible,x:index});}
  assert.ok(canRespawn.mock.callCount()-before<=100,'只复核一个等待生成点');
  assert.equal(roster.enemies.length,0);
});

test('invalid early deadlines are rejected and a story removal clears a previous timer',()=>{
  const {session,defeat}=fixture();defeat();
  for(const offscreenRespawnAt of [-1,Infinity,60_001]){
    const saved=structuredClone(session.captureState());saved.enemies[0]![1].offscreenRespawnAt=offscreenRespawnAt;
    assert.throws(()=>session.restoreState(saved),/敌人刷新时间/);
  }
  session.removeStoryEnemy('resident');assert.equal(session.enemyVitals('resident').offscreenRespawnAt,undefined);
  assert.doesNotThrow(()=>session.restoreState(structuredClone(session.captureState())));
});
