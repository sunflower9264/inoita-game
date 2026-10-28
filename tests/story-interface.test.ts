import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { Session } from '../src/domain/session.ts';
import { groundLootFor } from '../src/domain/ground-loot.ts';
import { rollQuestDrops, type DropCatalog } from '../src/domain/drops.ts';
import { parseItemCatalog, parseCampaign, parseStoryInterface, parseCharacterStats, validateStoryItems } from '../src/application/content-validation.ts';
import type { EnemySpawn, WorldMap } from '../src/domain/content.ts';

const items=parseItemCatalog(JSON.parse(fs.readFileSync(new URL('../public/content/items.json',import.meta.url),'utf8')));
const campaign=parseCampaign(JSON.parse(fs.readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8')));
const content=parseStoryInterface(JSON.parse(fs.readFileSync(new URL('../public/content/story-interface.json',import.meta.url),'utf8')));
const stats=parseCharacterStats(JSON.parse(fs.readFileSync(new URL('../public/content/character-stats.json',import.meta.url),'utf8')));
const drops=JSON.parse(fs.readFileSync(new URL('../public/content/drops.json',import.meta.url),'utf8')) as DropCatalog;
/**
 * 灵魂物质的五个原版生成点。任务材料由普通怪按原版严格概率掉落、落地后拾取，
 * 不再挂在 `campaign.enemyPlacements` 的携带怪上；掉落边界与失败重试见 quest-drops.test.ts。
 */
const dungeon=JSON.parse(fs.readFileSync(new URL('../public/content/maps/shadow-training-dungeon-2-a6b8293b.json',import.meta.url),'utf8')) as WorldMap;
const spiritSpawns=dungeon.enemySpawns!.filter(spawn=>spawn.enemyId==='enemy-reagents-1');
/** 击败一只携带怪：材料按掉落规则落到地面，不进背包。 */
function dropSpirit(session:Session,spawn:EnemySpawn):void {
  groundLootFor(session).add(dungeon.id,spawn.x,spawn.y,rollQuestDrops(drops,spawn.enemyId,session.questDropRequirements(),()=>0));
}
/** 走到掉落点捡起来：可堆叠材料进背包，并像场景那样通知一次界面。 */
function collectSpirit(session:Session,spawn:EnemySpawn):void {
  groundLootFor(session).collectNearby(dungeon.id,spawn.x,spawn.y,reward=>{if(reward.kind==='item')session.bag.add(reward.item,reward.quantity);});
  session.emit();
}
function collectSession() {
  const session=new Session(campaign,content.player);
  // 首章三连：格里普顿是击杀目标（原版由剧情遭遇安排他上场），另两条按交付对话结束。
  // 每一步都断言：这条链曾经不检查返回值，内容改了也照样「跑过」。
  assert.equal(session.accept('grafton-mission'),true);
  session.enemyDefeated({id:'earl',enemyId:'enemy-earl-grafton-1',x:0,y:0});
  assert.equal(session.complete('grafton-mission'),true);
  for(const id of ['cardinal-summons','meet-portia']) {assert.equal(session.accept(id),true);assert.equal(session.complete(id),true);}
  assert.equal(session.accept('knight-uniform'),true);
  return session;
}
test('quest pickup and hand-in update inventory and progress together, without duplicate items',()=>{
  const session=collectSession(),updates:number[]=[];
  assert.equal(session.complete('knight-uniform'),false);
  assert.equal(spiritSpawns.length,5);
  // 先打怪、材料落地；再走过去捡。地上的材料不算进背包。
  for(const spawn of spiritSpawns){session.enemyDefeated(spawn);dropSpirit(session,spawn);}
  assert.equal(session.itemCount('ectoplasm'),0);
  assert.equal(groundLootFor(session).forMap(dungeon.id).length,5);
  session.subscribe(s=>updates.push(s.itemCount('ectoplasm')));
  for(const [index,spawn] of spiritSpawns.entries()) {
    collectSpirit(session,spawn);
    assert.equal(session.itemCount('ectoplasm'),index+1);
    assert.equal(session.quests.get('knight-uniform')!.goals[campaign.quests.find(quest=>quest.id==='knight-uniform')!.goals[0].id],index+1);
  }
  assert.equal(groundLootFor(session).forMap(dungeon.id).length,0,'捡过就不再留在原地');
  assert.equal(session.status('knight-uniform'),'ready');
  assert.equal(session.complete('knight-uniform'),true);
  assert.equal(session.itemCount('ectoplasm'),0);
  assert.equal(session.itemCount('supreme-elixir'),1);
  assert.equal(session.complete('knight-uniform'),false);
  assert.deepEqual(updates,[1,2,3,4,5,0]);
  assert.equal(new Session(campaign,content.player).bag.counts.size,0);
});
test('two quests for the same material share inventory and cannot spend it twice',()=>{
  const source=campaign.quests.find(q=>q.id==='knight-uniform')!;
  const session=new Session({...campaign,quests:[{...source,id:'first',availableWhen:undefined,goals:source.goals.map(goal=>({...goal,quantity:1})),handoverItems:[{item:source.goals[0].target,quantity:1}]},
    {...source,id:'second',availableWhen:undefined,goals:source.goals.map(goal=>({...goal,quantity:1})),handoverItems:[{item:source.goals[0].target,quantity:1}]}]});
  session.accept('first');session.accept('second');session.applyStoryCommands([{type:'item-give',item:'ectoplasm',quantity:1}]);
  assert.equal(session.itemCount('ectoplasm'),1);
  assert.equal(session.status('second'),'ready');
  assert.equal(session.complete('first'),true);
  assert.equal(session.status('second'),'active');
  assert.equal(session.complete('second'),false);
});
test('tracking accepts only active quests and falls back after completion',()=>{
  // 夹具要一条「一次交互就能完成」的任务：靠击杀目标的任务推不动，回退那一段就走不到。
  const source=campaign.quests.find(quest=>quest.goals.length===1&&quest.goals[0].kind==='interact'&&quest.goals[0].quantity===1&&!quest.handoverItems?.length);
  assert.ok(source,'内容里需要一条单次交互即可完成的任务');
  const session=new Session({...campaign,quests:[{...source,id:'first',availableWhen:undefined},{...source,id:'second',availableWhen:undefined}]});
  assert.equal(session.trackQuest('missing'),false);assert.equal(session.trackQuest('second'),false);
  session.accept('first');session.accept('second');assert.equal(session.trackQuest('second'),true);
  assert.equal(session.currentQuest()?.id,'second');
  assert.equal(session.interact(source.goals[0].target,'target'),true);
  assert.equal(session.complete('second'),true);
  assert.equal(session.currentQuest()?.id,'first');assert.equal(session.trackQuest('second'),false);
});
test('presentation rejects missing images, invalid resources and broken item references',()=>{
  validateStoryItems(campaign,items);
  const missing=structuredClone(content);delete missing.assets['menu'];
  assert.throws(()=>parseStoryInterface(missing),/menu/);
  const invalid=structuredClone(content);invalid.player.health=invalid.player.maxHealth+1;
  assert.throws(()=>parseStoryInterface(invalid),/上限/);
  assert.throws(()=>validateStoryItems(campaign,{...items,items:{}}),/物品/);
  const fraction=structuredClone(campaign);fraction.quests[0].goals[0].quantity=1.5;
  assert.throws(()=>parseCampaign(fraction),/整数/);
});
test('main quest rewards grant experience, coins and class armor once',()=>{
  const armor:Record<string,string>={
    'dark-knight':'berkel-plate-armor',warrior:'berkel-plate-armor',
    assassin:'berkel-leather-armor',ranger:'berkel-leather-armor',
    warlock:'berkel-knight-s-robe',priest:'berkel-knight-s-robe'
  };
  for(const [classId,expectedArmor] of Object.entries(armor)){
    const hero=new BattleCharacter(classId,stats,items);
    const session=new Session(campaign,content.player,{classId,appearance:JSON.parse(fs.readFileSync(new URL('../public/content/world.json',import.meta.url),'utf8')).actors.kiyan},items,hero);
    const expected=new BattleCharacter(classId,stats,items);
    expected.addExperience(1490+298+298+1660);
    session.accept('grafton-mission');session.enemyDefeated({id:'earl',enemyId:'enemy-earl-grafton-1',x:0,y:0});
    assert.equal(session.complete('grafton-mission'),true);
    assert.equal(session.itemCount('supreme-elixir'),1);
    for(const id of ['cardinal-summons','meet-portia']){session.accept(id);assert.equal(session.complete(id),true);}
    session.accept('knight-uniform');
    for(const spawn of spiritSpawns){session.enemyDefeated(spawn);dropSpirit(session,spawn);collectSpirit(session,spawn);}
    assert.equal(session.complete('knight-uniform'),true);
    assert.equal(session.money,200);
    assert.equal(session.itemCount(expectedArmor),1);
    for(const other of new Set(Object.values(armor)))if(other!==expectedArmor)assert.equal(session.itemCount(other),0);
    assert.equal(hero.level,expected.level);
    assert.equal(hero.player.experience,expected.player.experience);
    assert.equal(session.complete('knight-uniform'),false);
    assert.equal(session.itemCount(expectedArmor),1);
  }
});
