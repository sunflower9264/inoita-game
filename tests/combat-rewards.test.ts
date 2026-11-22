import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { PendingEnemyDefeats } from '../src/domain/combat-outcomes.ts';
import { parseDrops, type DropCatalog, type QuestDropRequirement } from '../src/domain/drops.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { Session } from '../src/domain/session.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import { groundLootFor } from '../src/domain/ground-loot.ts';
import { calculateEnemy } from '../src/domain/enemy-stats.ts';

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = read<ItemCatalog>('items');
const battle = read<BattleCatalog>('battle');
const stats = read<CharacterStatsCatalog>('character-stats');
const drops = parseDrops(read<Record<string, unknown>>('drops'), items, battle.enemies.map(enemy => enemy.id));

interface RewardCall { map: string; x: number; y: number; rewards: readonly { kind: string; item?: string; amount?: number; roll?: { rarity: number } }[]; rendered: boolean }
interface Member { id: string; level: number }

interface HarnessOptions {
  enemyId?: string;
  heroLevel?: number;
  level?: number;
  elite?: boolean;
  lootLevel?: number;
  casterId?: string;
  members?: Member[];
  arena?: { key: string; summonedBy?: string; definition: { commandAction?: unknown } }[];
  quests?: readonly (readonly QuestDropRequirement[])[];
  sceneLevel?: number;
  drops?: DropCatalog;
}

function harness(options: HarnessOptions = {}) {
  const enemyId=options.enemyId??'enemy-slime-1',definition=battle.enemies.find(enemy=>enemy.id===enemyId)!;
  const heroLevel=options.heroLevel??10,level=options.level??1,map='reward-map';
  const hero=new BattleCharacter('dark-knight',stats,items);
  hero.restoreState({...hero.captureState(),level:heroLevel});
  const session=new Session(read<Campaign>('campaign'),undefined,undefined,items,hero,battle,stats,read<CompanionCatalog>('companions'));
  session.chests.enterMap(map);
  for(let index=1;index<(options.members?.length??1);index++){
    hero.bag.add('mercenary-emblem-assassin');
    const badge=hero.bag.entries.find(entry=>entry.item==='mercenary-emblem-assassin')!;
    const recruited=session.party!.recruit(badge.id,()=>0).member;
    session.party!.deployFirstAvailable(recruited.id);
  }
  if(options.quests)session.questDropRequirements=()=>options.quests!;
  const spawn={id:'spawn-'+enemyId,enemyId,x:10,y:20};
  const loot:RewardCall[]=[],experience:number[]=[],defeated:unknown[]=[];
  session.subscribeDefeats(()=>defeated.push(spawn));
  const host={roster:{source:():typeof spawn|undefined=>spawn},app:{pressureMode:false},drops:options.drops??drops};
  const settle=()=>{
    const earnsExperience= !options.casterId || options.casterId==='player'||!!options.arena?.some(enemy=>enemy.key===options.casterId&&enemy.summonedBy==='player');
    const result=session.settleEnemyDefeat({key:spawn.id,spawn:host.roster.source(),enemy:definition,map,x:10,y:20,
      lootLevel:options.lootLevel??0,enemyLevel:level,elite:options.elite??false,earnsExperience,
      pressureMode:host.app.pressureMode,drops:host.drops,stats,random:Math.random,landing:(x,y)=>({x,y})});
    if(!result)return;
    const value=result.settlement;
    const push=(rewards:RewardCall['rewards'],x=10)=>loot.push({map,x,y:20,rewards,rendered:true});
    if(value.breakable)push(value.breakable.rewards);
    else for(const owner of value.owners)push(owner.rewards,10+[0,5,-5][owner.slot%3]!);
    if(value.reserved.length)push(value.reserved);
    if(host.roster.source())push(value.quest);
    if(value.experience)experience.push(value.experience);
    result.notify();
  };
  return {host,settle,definition,hero,session,pity:session.lootPity,chests:session.chests,spawn,loot,defeated,experience};
}

test('a normal kill grants experience and rolls ordinary loot for every living member', t => {
  t.mock.method(Math, 'random', () => 0);
  const run = harness({ enemyId: 'enemy-slime-1', heroLevel: 10, level: 1 });
  run.settle();

  const expected = calculateEnemy(run.definition, { level: 1, elite: false, partySize: 1, playerLevel: 10 }).experience;
  assert.deepEqual(run.experience, [expected], '普通击杀按敌人等级、精英和队伍人数结算一次经验');
  assert.deepEqual(run.defeated, [run.spawn], '有地图生成点的敌人写入击杀记录');
  assert.equal(run.loot.length, 2, '普通掉落与任务掉落各一次');
  const ordinary = run.loot[0]!;
  assert.ok(ordinary.rewards.length > 0, '固定随机源下普通掉落非空');
  assert.ok(ordinary.rewards.some(reward => reward.kind === 'money'), '普通掉落包含货币槽');
  assert.ok(ordinary.rewards.some(reward => reward.kind === 'item'), '普通掉落包含物品槽');
  assert.deepEqual(run.loot[1]!.rewards, [], '没有任务需求时不产出任务掉落');
  assert.equal(run.pity.counters('player').equipmentMisses, 0, '掉出装备后清空装备保底计数');
});

test('a breakable is rolled once with no experience and no pity, and its spawned enemies stay in the visit', t => {
  t.mock.method(Math, 'random', () => 0);
  const run = harness({ enemyId: 'enemy-jar-1', heroLevel: 10 });
  run.settle();

  assert.deepEqual(run.experience, [], '景物怪不给经验');
  assert.equal(run.loot.length, 2, '景物奖励与任务掉落各结算一次');
  assert.ok(run.loot[0]!.rewards.length > 0, '景物奖励按可破坏物规则掷出');
  assert.deepEqual(run.loot[1]!.rewards, []);
  assert.deepEqual(run.chests.spawns.map(spawn => spawn.enemyId), ['enemy-barrel-of-toxic-waste-1']);
  assert.equal(run.pity.counters('player').equipmentMisses, 0, '景物怪不累计装备保底');
});

test('a party-attributed kill grants experience while a hostile kill does not', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const summonRun = harness({
    enemyId: 'enemy-slime-1', heroLevel: 10, casterId: 'summon-1',
    arena: [{ key: 'summon-1', summonedBy: 'player', definition: {} }],
  });
  summonRun.settle();
  assert.equal(summonRun.experience.length, 1, '友方召唤物的击杀算给队伍');
  assert.ok(summonRun.experience[0]! > 0);

  const hostileRun = harness({ enemyId: 'enemy-slime-1', heroLevel: 10, casterId: 'enemy-other' });
  hostileRun.settle();
  assert.deepEqual(hostileRun.experience, [], '非队伍来源的击杀不给经验');
});

test('the unique pity forces a unique drop and resets the unique counter', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const run = harness({ enemyId: 'enemy-head-goblin-1', heroLevel: 20, level: 13 });
  run.pity.counters('player').uniqueMisses = 24;

  run.settle();

  const rewards = run.loot.flatMap(call => call.rewards);
  const uniqueItems = new Set(drops.equipment.unique.map(choice => choice.item));
  const guaranteed = rewards.find(reward => reward.kind === 'item' && reward.roll);
  assert.ok(guaranteed, '黄装保底必须产出带品级快照的物品');
  assert.ok(uniqueItems.has(guaranteed.item!), '保底产出的是黄装池物品');
  assert.equal(run.pity.counters('player').uniqueMisses, 0, '命中黄装后清空黄装保底计数');
  assert.equal(run.pity.counters('player').equipmentMisses, 0, '带品级快照的黄装同时算作装备命中，装备保底清零');
});

test('the equipment pity bonus is added to the ordinary equipment slot', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const catalog = structuredClone(drops);
  catalog.pity!.equipment = { stepPermille: 10000, capPermille: 10000 };
  const run = harness({ enemyId: 'enemy-head-goblin-1', heroLevel: 20, level: 13, drops: catalog });
  run.pity.counters('player').equipmentMisses = 1;

  run.settle();

  const rewards = run.loot.flatMap(call => call.rewards);
  assert.ok(rewards.some(reward => reward.kind === 'item' && reward.roll),
    '装备保底加成把装备槽推到必中');
  assert.equal(run.pity.counters('player').equipmentMisses, 0, '装备命中后清空装备保底计数');
});

test('the epic pity forces an epic drop once eligible', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const run = harness({ enemyId: 'enemy-blackhoods-boss-1', heroLevel: 60, level: 65 });
  run.pity.takeBossFirstDefeat('enemy-blackhoods-boss-1');
  run.pity.counters('player').epicMisses = 39;

  run.settle();

  const rewards = run.loot.flatMap(call => call.rewards);
  assert.ok(rewards.some(reward => reward.kind === 'item' && reward.roll?.rarity === 4), '紫装保底产出紫装');
  assert.equal(run.pity.counters('player').epicMisses, 0, '命中紫装后清空紫装保底计数');
});

test('the first boss defeat guarantees equipment, and the same boss does not repeat it', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const run = harness({ enemyId: 'enemy-starving-boss-wolf-1', heroLevel: 10, level: 6 });

  run.settle();
  const first = run.loot.flatMap(call => call.rewards);
  assert.ok(first.some(reward => reward.kind === 'item' && reward.roll && reward.roll.rarity >= 2),
    'Boss 首杀按配置保底装备并抬高最低稀有度');
  assert.equal(run.pity.bossDefeated('enemy-starving-boss-wolf-1'), true, '首杀记录写入保底状态');

  const second = harness({ enemyId: 'enemy-starving-boss-wolf-1', heroLevel: 10, level: 6 });
  second.pity.takeBossFirstDefeat('enemy-starving-boss-wolf-1');
  second.pity.counters('player').equipmentMisses = 0;
  second.settle();
  assert.ok(second.loot.flatMap(call => call.rewards).some(reward=>reward.roll&&reward.roll.rarity>=2), 'Boss 每次至少掉落稀有装备');
});

test('a paid drop uses its own channel and advances its own pity counter', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const run = harness({ enemyId: 'enemy-head-goblin-1', heroLevel: 20, level: 13 });
  run.session.reservedDropMisses = 24;

  run.settle();

  const reservedItems = new Set(drops.reservedDrops!.entries.map(entry => entry.item));
  const rewards = run.loot.flatMap(call => call.rewards);
  assert.ok(rewards.some(reward => reward.kind === 'item' && reservedItems.has(reward.item!)),
    '付费道具从独立通道掉落，不混入普通掉落池');
  assert.equal(run.session.reservedDropMisses, 25, '付费道具保底计数独立推进');
  assert.equal(run.pity.counters('player').equipmentMisses, 1, '付费通道不影响普通装备保底');
});

test('quest drops spawn once per kill even when the party has two members', t => {
  t.mock.method(Math, 'random', () => 0);
  const run = harness({
    enemyId: 'enemy-slime-1', heroLevel: 10,
    members: [{ id: 'player', level: 10 }, { id: 'ally', level: 8 }],
    quests: [[{ item: 'magic-stone-piece', quantity: 3, owned: 0 }]],
  });
  run.settle();

  const questCalls = run.loot.filter(call => call.rewards.some(reward => reward.kind === 'item' && reward.item === 'magic-stone-piece'));
  assert.equal(questCalls.length, 1, '任务掉落共享，不随队伍人数翻倍');
  assert.equal(questCalls[0]!.rewards.filter(reward => reward.item === 'magic-stone-piece').length, 1);
  assert.equal(run.loot.length, 3, '两名成员各一次普通掉落，再加一次任务掉落');
});

test('a kill without a map spawn still grants experience but has no loot or defeat record', t => {
  t.mock.method(Math, 'random', () => 0);
  const run = harness({ enemyId: 'enemy-slime-1', heroLevel: 10 });
  (run.host as unknown as { roster: { source: () => undefined } }).roster.source = () => undefined;
  run.settle();

  assert.equal(run.experience.length, 1, '召唤/临时敌人即使没有生成点也给经验');
  assert.equal(run.loot.length, 0, '没有生成点就不结算掉落');
  assert.deepEqual(run.defeated, [], '没有生成点不写击杀记录');
});

test('challenge enemies without a map spawn still settle normal loot', t => {
  t.mock.method(Math, 'random', () => 0);
  const run = harness({ enemyId: 'enemy-slime-1', heroLevel: 10 });
  (run.host as unknown as { roster: { source: () => undefined } }).roster.source = () => undefined;
  (run.host as unknown as { app: { pressureMode?: boolean } }).app.pressureMode = true;
  run.settle();

  assert.equal(run.experience.length, 1);
  assert.ok(run.loot.some(call => call.rewards.some(reward => reward.kind === 'item')),
    '挑战模式的临时怪也按普通击杀结算掉落');
  assert.deepEqual(run.defeated, [], '没有地图生成点时不写地图击杀记录');
});

test('an enemy without a drop rule skips normal loot but still records the kill', () => {
  const run = harness({ enemyId: 'enemy-slime-1', heroLevel: 10 });
  (run.host as unknown as { drops: DropCatalog }).drops = { ...drops, enemies: {} };
  run.settle();
  assert.equal(run.loot.length, 1, '只剩任务掉落这一次空结算');
  assert.deepEqual(run.loot[0]!.rewards, []);
});

test('failed reward insertion rolls back kill, first boss, items, experience and pruned ground loot',t=>{
  t.mock.method(Math,'random',()=>0);
  const run=harness({enemyId:'enemy-starving-boss-wolf-1',heroLevel:10,level:6});
  const store=groundLootFor(run.session);
  store.add('reward-map',0,0,Array.from({length:64},()=>({kind:'money' as const,amount:1})));
  store.add('another-map',0,0,[{kind:'money',amount:9}]);
  run.session.setEnemyVitals('unrelated',42,0);
  const before=run.session.captureState();
  const add=store.add.bind(store);
  const mocked=t.mock.method(store,'add',(...args:Parameters<typeof add>)=>{add(...args);throw new Error('injected insertion failure');});
  assert.throws(()=>run.settle(),/injected insertion/);
  const rolledBack=run.session.captureState();
  const byId=(a:{id:string},b:{id:string})=>a.id.localeCompare(b.id);
  rolledBack.groundLoot.drops.sort(byId);before.groundLoot.drops.sort(byId);
  assert.deepEqual(rolledBack,before);
  assert.deepEqual(run.defeated,[]);
  mocked.mock.restore();
  run.settle();
  assert.equal(run.pity.bossDefeated(run.definition.id),true);
  assert.deepEqual(run.defeated,[run.spawn]);
  const after=run.session.captureState();
  run.settle();
  assert.deepEqual(run.session.captureState(),after,'重复击杀不发第二次奖励');
});

test('defeat notifications isolate observer exceptions after committing the kill',t=>{
  const run=harness();let later=0;
  t.mock.method(console,'error',()=>{});
  run.session.subscribe(()=>{throw new Error('observer failure');});
  run.session.subscribe(()=>later++);
  run.session.subscribeDefeats(()=>{throw new Error('defeat observer failure');});
  run.session.subscribeDefeats(()=>later++);
  run.settle();
  assert.equal(later,2);
  assert.notEqual(run.session.enemyVitals(run.spawn.id).deadUntil,undefined);
});

test('a defeat ticket clears before settle and reports presentation failures once',()=>{
  const tickets=new PendingEnemyDefeats();const failures:('settle'|'present')[]=[];
  let commits=0,presentations=0;
  tickets.add('enemy',()=>{assert.equal(tickets.has('enemy'),false);commits++;},()=>{
    presentations++;throw new Error('presentation');
  },(_error,_render,phase)=>{failures.push(phase);});
  assert.doesNotThrow(()=>tickets.complete('enemy'));
  assert.equal(tickets.has('enemy'),false);
  assert.equal(commits,1);assert.equal(presentations,1);
  assert.deepEqual(failures,['present']);
  tickets.complete('enemy');assert.equal(commits,1);assert.equal(presentations,1);
});

test('a breakable spawn error restores chest visit and the death record',t=>{
  t.mock.method(Math,'random',()=>0);
  const run=harness({enemyId:'enemy-jar-1'}),before=run.session.captureState();
  const spawn=run.chests.spawnBreakableEnemies.bind(run.chests);
  t.mock.method(run.chests,'spawnBreakableEnemies',(...args:Parameters<typeof spawn>)=>{
    spawn(...args);throw new Error('injected chest failure');
  });
  assert.throws(()=>run.settle(),/injected chest/);
  assert.deepEqual(run.session.captureState(),before);
});

test('an experience error restores already-added ground rewards and hero progression',t=>{
  t.mock.method(Math,'random',()=>0);
  const run=harness(),before=run.session.captureState();
  const add=run.session.party!.addExperience.bind(run.session.party);
  t.mock.method(run.session.party!,'addExperience',(amount:number)=>{add(amount);throw new Error('injected experience failure');});
  assert.throws(()=>run.settle(),/injected experience/);
  assert.deepEqual(run.session.captureState(),before);
  assert.deepEqual(run.defeated,[]);
});

test('a failed kill settlement restores a quest actor released by the same kill',t=>{
  t.mock.method(Math,'random',()=>0);
  const run=harness({enemyId:'enemy-purification-cave-watcher-1'}),session=run.session;
  const map='snow-fey-village-b6acd59c',characterId='npc-574';
  session.applyStoryCommands([{type:'travel',destination:{map,x:552,y:528,facing:'north'}}]);
  assert.ok(session.accept('quest-351'));
  for(const enemy of ['enemy-frost-werewolf-1','enemy-iceshell-turtle-1'])session.recordQuestFact('defeat',enemy);
  session.applyStoryCommands([{type:'world',command:{kind:'remove-character',map,characterId,all:false}}]);
  assert.equal(session.storyWorld.actorVisible(map,characterId),false);
  const add=session.party!.addExperience.bind(session.party);
  t.mock.method(session.party!,'addExperience',(amount:number)=>{add(amount);throw new Error('injected experience failure');});
  assert.throws(()=>run.settle(),/injected experience/);
  // 任务和交付人一起退回：不能任务还在进行中，人物却已经出现。
  assert.equal(session.status('quest-351'),'active');
  assert.equal(session.storyWorld.actorVisible(map,characterId),false);
  assert.equal(session.visitorReleaseRevision,0,'回滚后投影信号不能领先真实状态');
});

test('quest drop requirements are queried after this kill updates its quest',()=>{
  const run=harness({enemyId:'enemy-earl-grafton-1'});
  run.session.accept('grafton-mission');
  let checked=false;
  run.session.questDropRequirements=()=>{
    assert.equal(run.session.status('grafton-mission'),'ready');checked=true;return [];
  };
  run.settle();assert.equal(checked,true);
});


test('failed kill settlement restores companions in place for existing world bindings',t=>{
  t.mock.method(Math,'random',()=>0);
  const run=harness({members:[{id:'player',level:10},{id:'ally',level:10}]}),party=run.session.party!;
  const id=party.activeIds.find(id=>id!=='player')!;
  const member=party.get(id)!,skills=member.skills;
  // 世界的队友记录与头顶血条都会保留这一成员引用。
  const ally={member},readOverhead=()=>member.player;
  const before=run.session.captureState(),beforeMember=member.captureState();
  const add=party.addExperience.bind(party);
  t.mock.method(party,'addExperience',(amount:number)=>{
    add(amount);member.setHealth(0);throw new Error('injected companion settlement failure');
  });
  assert.throws(()=>run.settle(),/injected companion settlement/);
  assert.deepEqual(run.session.captureState(),before);
  assert.equal(party.get(id),ally.member,'回滚保持世界正在使用的成员对象');
  assert.equal(party.get(id)!.skills,skills,'技能消费者持有的对象也保持有效');
  assert.deepEqual(ally.member.captureState(),beforeMember);
  assert.equal(readOverhead().health,beforeMember.health);
  party.get(id)!.setHealth(1);
  assert.equal(readOverhead().health,1,'恢复后的血量变化仍能由原血条闭包读到');
  assert.equal(ally.member.alive,true);
});

test('equipment from a kill can be picked up on a map full of mana gems', t=>{
  t.mock.method(Math,'random',()=>0.999);
  const run=harness({enemyId:'enemy-head-goblin-1',heroLevel:20,level:13});
  run.pity.counters('player').uniqueMisses=24;
  const store=groundLootFor(run.session),map='reward-map';
  for(let i=0;i<64;i++)store.addFlying(map,{x:80,y:80},{x:100,y:100,direction:0},'mana-gem',100);
  store.advance(map,100);
  run.settle();
  assert.equal(store.dropsOnMap(map).length,64);
  const equipment=run.loot.flatMap(call=>call.rewards).find(reward=>reward.roll);
  assert.ok(equipment?.item);
  const picked=store.collectNearby(map,10,20,reward=>{
    if(reward.kind!=='item'||reward.item!==equipment.item||!reward.instance)return false;
    run.session.bag.receiveDrop(reward.instance);
  });
  assert.equal(picked.length,1);
  const reward=picked[0].reward;
  assert.ok(reward.kind==='item'&&reward.instance?.numbers);
  assert.deepEqual(run.session.bag.entries.find(entry=>entry.item===equipment.item)?.numbers,reward.instance.numbers);
});
