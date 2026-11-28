import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { WorldMap } from '../src/domain/content.ts';
import { parseDrops } from '../src/domain/drops.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { QuestEnemyWatch } from '../src/domain/quest-enemies.ts';
import { Session } from '../src/domain/session.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';

const read=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const campaign=read('campaign') as Campaign,items=read('items') as ItemCatalog,battle=read('battle') as BattleCatalog;
const drops=parseDrops(read('drops'),items,battle.enemies.map(enemy=>enemy.id));
const map=(name:string)=>read(`maps/${name}`) as WorldMap;

function sessionFor(questId:string,accept:boolean):Session{
  const quest={...campaign.quests.find(value=>value.id===questId)!,availableWhen:{type:'always' as const,value:true}};
  const session=new Session({...campaign,quests:[quest],questGroups:[],events:[]});
  if(accept)assert.equal(session.accept(questId),true);
  return session;
}

test('item quest restores a story-disabled drop source while active and keeps native level',()=>{
  const session=sessionFor('quest-171',true);
  const mapData=map('closed-dungeon-2-563efc16');
  session.applyStoryCommands([{type:'world',command:{kind:'enemy-availability',map:mapData.id,enemyId:'enemy-enraged-magic-book-1',available:false}}]);
  const roster=new WorldEnemyRoster(session,mapData,[],new QuestEnemyWatch(session,drops.questItems));
  assert.ok(roster.spawns.some(spawn=>spawn.enemyId==='enemy-enraged-magic-book-1'));
  const definition=battle.enemies.find(enemy=>enemy.id==='enemy-enraged-magic-book-1')!;
  const placed=roster.enemies.find(enemy=>enemy.enemyId===definition.id)!;
  assert.equal(roster.enemySnapshot(placed.key,definition,105)?.level,definition.level,'任务怪不按玩家等级缩放');
});

test('defeat quest restores a story-disabled target while active',()=>{
  const session=sessionFor('quest-181',true);
  const mapData=map('shadow-training-dungeon-2-a6b8293b');
  session.applyStoryCommands([{type:'world',command:{kind:'enemy-availability',map:mapData.id,enemyId:'enemy-knife-needled-mosquitoes-1',available:false}}]);
  const roster=new WorldEnemyRoster(session,mapData,[],new QuestEnemyWatch(session,drops.questItems));
  assert.ok(roster.spawns.some(spawn=>spawn.enemyId==='enemy-knife-needled-mosquitoes-1'));
});

test('targetChanges enemy is protected when story-disabled',()=>{
  const session=sessionFor('quest-18',true);
  const mapData=map('training-dungeon-two');
  session.applyStoryCommands([{type:'world',command:{kind:'enemy-availability',map:mapData.id,enemyId:'enemy-shaggy-grayfang-1',available:false}}]);
  const roster=new WorldEnemyRoster(session,mapData,[],new QuestEnemyWatch(session,drops.questItems));
  assert.ok(roster.spawns.some(spawn=>spawn.enemyId==='enemy-shaggy-grayfang-1'));
});

test('a story-hidden enemy stays spawnable while its quest is active',()=>{
  const session=sessionFor('quest-181',true);
  const mapData=map('shadow-training-dungeon-2-a6b8293b');
  const target='enemy-knife-needled-mosquitoes-1';
  session.applyStoryCommands([{type:'world',command:{kind:'enemy-availability',map:mapData.id,enemyId:target,available:false}}]);

  const roster=new WorldEnemyRoster(session,mapData,[],new QuestEnemyWatch(session,drops.questItems));
  assert.ok(roster.spawns.some(spawn=>spawn.enemyId===target),'任务进行中，剧情禁用不压任务目标');

  session.applyStoryCommands([{type:'quest',command:{type:'script-complete',quest:'quest-181'}}]);
  const completed=new WorldEnemyRoster(session,mapData,[],new QuestEnemyWatch(session,drops.questItems));
  assert.equal(completed.spawns.some(spawn=>spawn.enemyId===target),false,'任务结束后剧情禁用重新生效');
});

test('inactive quests do not protect their enemies',()=>{
  const session=sessionFor('quest-181',false);
  const watch=new QuestEnemyWatch(session,drops.questItems);
  assert.equal(watch.snapshot().ids.has('enemy-knife-needled-mosquitoes-1'),false);
});

test('accepting a quest after entry adds its story-disabled enemy on refresh',()=>{
  const session=sessionFor('quest-181',false);
  const mapData=map('shadow-training-dungeon-2-a6b8293b');
  const target='enemy-knife-needled-mosquitoes-1';
  session.applyStoryCommands([{type:'world',command:{kind:'enemy-availability',map:mapData.id,enemyId:target,available:false}}]);
  const roster=new WorldEnemyRoster(session,mapData,[],new QuestEnemyWatch(session,drops.questItems));
  assert.equal(roster.spawns.some(spawn=>spawn.enemyId===target),false);
  assert.equal(session.accept('quest-181'),true);
  assert.ok(roster.refresh().added.some(enemy=>enemy.enemyId===target));
});

test('item goals include every enemy source for the required item',()=>{
  const session=sessionFor('quest-171',true);
  const watch=new QuestEnemyWatch(session,{
    'enemy-a':[{item:'raging-magic-bookcores',threshold:50}],
    'enemy-b':[{item:'raging-magic-bookcores',threshold:50}],
    'enemy-c':[{item:'unrelated-item',threshold:50}],
  });
  assert.deepEqual([...watch.snapshot().ids].sort(),['enemy-a','enemy-b']);
});

test('quest enemy snapshot is cached by quest-book version',()=>{
  const session=sessionFor('quest-181',true);
  const watch=new QuestEnemyWatch(session,drops.questItems);
  const first=watch.snapshot();
  const second=watch.snapshot();
  assert.equal(second.ids,first.ids,'版本未变时复用同一个 Set');
  assert.ok(first.ids.has('enemy-knife-needled-mosquitoes-1'));
});
