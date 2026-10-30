import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { adjacentLivingMember, PartyRoster, type CompanionCatalog } from '../src/domain/party.ts';
import type { CounterattackMode } from '../src/domain/party-ai.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { WorldMap } from '../src/domain/content.ts';
import { Session } from '../src/domain/session.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats'),catalog=read<CompanionCatalog>('companions');

test('original mercenary emblems recruit owned members, deploy two, and expel with their equipment',()=>{
  const hero=new BattleCharacter('dark-knight',stats,items);
  const party=new PartyRoster(hero,stats,items,catalog,()=>{});
  hero.bag.add('mercenary-emblem-assassin');
  const badge=hero.bag.entries.find(entry=>entry.item==='mercenary-emblem-assassin')!;
  const first=party.recruit(badge.id,()=>0).member;
  assert.equal(first.classId,'assassin');
  assert.equal(hero.bag.count('mercenary-emblem-assassin'),0);
  assert.deepEqual(party.activeIds,['player']);
  assert.equal(party.snapshot().rosterSlots.length,18);
  party.deployFirstAvailable(first.id);
  assert.deepEqual(party.activeIds,['player',first.id]);
  assert.ok(hero.bag.equipmentItems(hero.bag.equipmentFor(first.id))['main-hand']);
  hero.bag.add('hero-emblem',2);
  const second=party.recruit(hero.bag.entries.find(entry=>entry.item==='hero-emblem')!.id,()=>0).member;
  assert.equal(second.definition.elite,true);
  party.deployFirstAvailable(second.id);
  assert.equal(items.items['divine-mercenary-emblem'].use?.elite,true);
  const third=party.recruit(hero.bag.entries.find(entry=>entry.item==='hero-emblem')!.id,()=>.2).member;
  assert.deepEqual(party.activeIds,['player',first.id,second.id]);
  assert.deepEqual(party.snapshot().reserves,[third.id]);
  party.reserve(first.id);party.deployFirstAvailable(third.id);
  assert.deepEqual(party.activeIds,['player',third.id,second.id]);
  assert.equal(party.switchControl(second.id),true);
  assert.throws(()=>party.dismiss(second.id),/移出队伍/);
  party.reserve(second.id);party.dismiss(second.id);
  assert.equal(party.controlledId,'player');
  assert.deepEqual(hero.bag.equipmentFor(second.id),{});
  assert.equal(party.get(second.id),undefined);
});

test('living deployed members receive experience and a scroll restores ten percent of both resources',()=>{
  const hero=new BattleCharacter('dark-knight',stats,items);
  const party=new PartyRoster(hero,stats,items,catalog,()=>{});
  hero.bag.add('mercenary-emblem-priest');
  const member=party.recruit(hero.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!.id,()=>0).member;
  party.deployFirstAvailable(member.id);
  member.setHealth(0);
  assert.equal(party.switchControl(member.id),false);
  const before=member.player.experience;
  party.addExperience(25);
  assert.equal(member.player.experience,before);
  hero.bag.add('resurrection-scroll');
  const scroll=hero.bag.entries.find(entry=>entry.item==='resurrection-scroll')!;
  assert.equal(party.revive(member.id,scroll.id).kind,'revive');
  assert.equal(member.player.health,Math.floor(member.player.maxHealth*.1));
  assert.equal(member.player.mana,Math.floor(member.player.maxMana*.1));
  assert.equal(hero.bag.count('resurrection-scroll'),0);
  party.addExperience(25);
  assert.ok(member.player.experience>before);
});

test('story companions use authored join and leave without inventing an event in the current campaign',()=>{
  const campaign=read<Campaign>('campaign');
  // 剧情入队／离队引用的是 `companions.json` 里定义过的伙伴：原版 `0x12`/`0x20` 带的是 NPCINFOBASE 号，
  // 生成时按 companion-sources 换成复刻的伙伴键（findings 130），不能凭空写一个不存在的键。
  const referenced=new Set<string>();
  for(const script of Object.values(campaign.scripts))
    for(const node of script.nodes)
      for(const command of node.commands)
        if(command.type==='party-join'||command.type==='party-leave') referenced.add(command.companion);
  for(const id of referenced) assert.ok(catalog.definitions[id],`剧情引用了未定义的伙伴 ${id}`);
  const original=Object.values(catalog.definitions)[0];
  const story:CompanionCatalog={...catalog,definitions:{...catalog.definitions,
    'story-example':{...original,id:'story-example',source:'story'}}};
  const hero=new BattleCharacter('dark-knight',stats,items);
  const party=new PartyRoster(hero,stats,items,story,()=>{});
  const member=party.joinStory('story-example');
  assert.equal(party.joinStory('story-example'),member);
  assert.ok(party.activeIds.includes(member.id));
  assert.equal(party.leaveStory('story-example'),true);
  assert.equal(party.get(member.id),undefined);
});

test('story companions join the roster as reserves when both active slots are full',()=>{
  const {party}=setup();
  party.bag.add('mercenary-emblem-black-knight');
  const first=party.recruit(party.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  party.deployFirstAvailable(first.id);
  party.bag.add('mercenary-emblem-black-knight');
  const second=party.recruit(party.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  party.deployFirstAvailable(second.id);
  assert.deepEqual(party.activeIds,['player',first.id,second.id]);
  const story=party.joinStory('mercenary-portia');
  assert.deepEqual(party.activeIds,['player',first.id,second.id],'剧情伙伴不挤掉已上阵的佣兵');
  assert.equal(party.get(story.id),story);
  assert.ok(party.snapshot().reserves.includes(story.id),'剧情伙伴留在候补名册');
  assert.equal(party.joinStory('mercenary-portia'),story,'重复加入返回同一个伙伴');
  assert.equal(party.leaveStory('mercenary-portia'),true);
});

test('enemy health scales with deployed party size and survives a map reload',()=>{
  const campaign=read<Campaign>('campaign'),map=JSON.parse(readFileSync(new URL('../public/content/maps/shadow-forest-west.json',import.meta.url),'utf8')) as WorldMap;
  const battle=read<BattleCatalog>('battle'),hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats,catalog);
  const roster=new WorldEnemyRoster(session,map,[],hero.level),placed=roster.enemies[0];
  const definition=battle.enemies.find(enemy=>enemy.id===placed.enemyId)!;
  const original=roster.enemySnapshot(placed.key,definition,hero.level)!;
  roster.setEnemyHealth(placed.key,Math.floor(original.maxHealth/2),definition);
  session.bag.add('mercenary-emblem-priest');
  const recruit=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!.id,()=>0).member;
  session.party!.deployFirstAvailable(recruit.id);
  roster.setPartySize(session.party!.activeSize,battle.enemies);
  const scaled=roster.enemySnapshot(placed.key,definition,hero.level)!;
  assert.equal(scaled.partySize,2);
  assert.ok(Math.abs(scaled.health/scaled.maxHealth-.5)<.02);
  const revisited=new WorldEnemyRoster(session,map,[],hero.level).enemySnapshot(placed.key,definition,hero.level)!;
  assert.equal(revisited.health,scaled.health);
  assert.equal(revisited.maxHealth,scaled.maxHealth);
});

function setup(){const hero=new BattleCharacter('dark-knight',stats,items);return {hero,party:new PartyRoster(hero,stats,items,catalog,()=>{})};}
function recruit(party:PartyRoster,item='mercenary-emblem-black-knight',random=()=>0){
  party.bag.add(item);return party.recruit(party.bag.entries.find(entry=>entry.item===item)!.id,random).member;
}
test('a companion panel is reused until the bag revision or level changes',()=>{
  const {party}=setup(),member=recruit(party);
  const first=member.panel;
  assert.equal(member.panel,first,'同一背包版本直接复用');
  party.bag.add('healing-potion-s');
  assert.notEqual(member.panel,first,'背包变化后重新计算');
});
test('all eighteen roster slots open and capacity failures preserve the emblem',()=>{
  const {party}=setup();const members=Array.from({length:18},()=>recruit(party));
  assert.deepEqual(party.snapshot().rosterSlots,members.map(member=>member.id));
  party.bag.add('mercenary-emblem-black-knight');const emblem=party.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!;
  assert.throws(()=>party.recruit(emblem.id,()=>0),/名册已满/);
  assert.equal(party.bag.count('mercenary-emblem-black-knight'),1);
  party.dismiss(members[4].id);const replacement=party.recruit(emblem.id,()=>0).member;
  assert.equal(party.snapshot().rosterSlots[4],replacement.id);
});
test('recruitment uses native quality weights, generated attributes and automatic rank thresholds',()=>{
  const {party}=setup();const common=recruit(party),trained=recruit(party,'mercenary-emblem-black-knight',()=>.99),rare=recruit(party,'hero-emblem');
  assert.equal(common.definition.quality,0);assert.equal(trained.definition.quality,1);assert.equal(rare.definition.quality,2);
  assert.equal(common.generated.baseAttributes.strength,10);assert.notDeepEqual(common.generated.baseAttributes,stats.classes['dark-knight']);
  assert.equal(common.snapshot().skillLevels['dark-strike'],1);assert.equal(common.snapshot().skillLevels['firestorm']??0,0);
  assert.ok(Object.keys(common.generated.skillCaps).length<15);assert.equal(rare.generated.groupSkills.length,2);
  common.skills.updateLevel(32);assert.equal(common.skills.skillLevels()['dark-strike'],1);
  common.skills.updateLevel(33);assert.equal(common.skills.skillLevels()['dark-strike'],2);
  common.skills.updateLevel(105);assert.equal(common.skills.skillLevels()['dark-strike'],common.generated.skillCaps['dark-strike']);
  const battle=read<BattleCatalog>('battle'),draft=common.skills.draft(battle,common.classId);
  draft.levels['firestorm']=9;assert.throws(()=>common.skills.save(battle,common.classId,draft),/等级/);
});
test('reserve experience and group skills apply without deployment, duplicates do not stack',()=>{
  const {party}=setup();const first=recruit(party),second=recruit(party);
  assert.equal(party.groupModifiers()['low-health-resistance'],100);
  party.addExperience(25);assert.equal(first.player.experience,25);assert.equal(second.player.experience,25);
  party.dismiss(first.id);assert.equal(party.groupModifiers()['low-health-resistance'],100);
  party.dismiss(second.id);assert.equal(party.groupModifiers()['low-health-resistance'],undefined);
});
test('deployment refuses implicit replacement and death selects the next living slot cyclically',()=>{
  const {hero,party}=setup();const first=recruit(party),second=recruit(party),third=recruit(party);
  party.deployFirstAvailable(first.id);party.deployFirstAvailable(second.id);
  assert.throws(()=>party.deployFirstAvailable(third.id),/已满/);assert.throws(()=>party.deploy(third.id,1),/已占用/);
  party.switchControl(first.id);first.setHealth(0);assert.equal(party.onDefeat(first.id),false);assert.equal(party.controlledId,second.id);
  assert.throws(()=>party.reserve(first.id),/阵亡/);second.setHealth(0);party.onDefeat(second.id);assert.equal(party.controlledId,'player');
  assert.deepEqual(party.snapshot().living,['player']);
  hero.setHealth(0);assert.equal(party.onDefeat('player'),true);assert.deepEqual(party.snapshot().living,[]);
});
test('prayer requires a full wipe and revival consumes once while restoring resources',()=>{
  const {hero,party}=setup();const first=recruit(party);party.deployFirstAvailable(first.id);
  party.bag.add('resurrection-prayer');const prayer=party.bag.entries.find(entry=>entry.item==='resurrection-prayer')!;
  first.setHealth(0);assert.throws(()=>party.revive(first.id,prayer.id),/全队阵亡/);assert.equal(party.bag.count('resurrection-prayer'),1);
  hero.setHealth(0);party.revive('player',prayer.id);
  assert.equal(hero.player.health,hero.player.maxHealth);assert.equal(first.player.health,first.player.maxHealth);
  assert.equal(first.player.mana,first.player.maxMana);assert.equal(party.bag.count('resurrection-prayer'),0);
  assert.throws(()=>party.revive('player',prayer.id),/不可用/);
  first.setHealth(0);party.bag.add('improved-resurrection-scroll');
  party.revive(first.id,party.bag.entries.find(entry=>entry.item==='improved-resurrection-scroll')!.id);
  assert.equal(first.player.health,first.player.maxHealth);assert.equal(first.player.mana,first.player.maxMana);
});

test('a restored combat maximum does not grant its resource increase twice',()=>{
  const {party}=setup(),member=recruit(party);const maxHealth=member.player.maxHealth+500;
  member.setCombatResourceLimits(maxHealth,400);member.setHealth(maxHealth-20);
  const state=party.captureState();party.restoreState(state);
  const restored=party.get(member.id)!;restored.setCombatResourceLimits(maxHealth,400);
  assert.equal(restored.player.health,maxHealth-20);assert.equal(restored.player.maxHealth,maxHealth);
});
test('counterattack keeps the original three levels through a checkpoint',()=>{
  const {party}=setup(),member=recruit(party);
  assert.equal(party.counterattack('player'),2);assert.equal(party.counterattack(member.id),2);
  party.setCounterattack('player',1);party.setCounterattack(member.id,0);
  assert.throws(()=>party.setCounterattack(member.id,3 as CounterattackMode),/反击档位/);
  const state=party.captureState();party.restoreState(state);
  assert.equal(party.counterattack('player'),1);assert.equal(party.counterattack(member.id),0);
  assert.equal(party.counterattack('missing'),0);
});
test('companion resource projections and single-capacity reads preserve the other resource',()=>{
  const {party}=setup(),member=recruit(party),base=member.player;
  member.setHealth(base.maxHealth-100);member.spendMana(-40);
  member.setCombatResourceLimits(base.maxHealth+300,base.maxMana);
  assert.deepEqual([member.player.health,member.player.mana],[base.maxHealth-100,base.maxMana+40]);
  member.setHealth(base.maxHealth+300);member.setCombatResourceLimits(base.maxHealth,base.maxMana);
  assert.equal(member.player.health,base.maxHealth+300);
  member.setMana(20);assert.equal(member.player.health,base.maxHealth+300);
  member.spendMana(-300);member.setCombatResourceCapacity('maxHealth',base.maxHealth);
  assert.deepEqual([member.player.health,member.player.mana],[base.maxHealth,320]);
  member.setCombatResourceCapacity('maxMana',base.maxMana);assert.equal(member.player.mana,base.maxMana);
  member.setCombatResourceCapacity('maxHealth',0);
  assert.deepEqual([member.player.maxHealth,member.player.health],[0,0]);
  member.setCombatResourceLimits(base.maxHealth,base.maxMana);assert.equal(member.player.health,0);
  member.setHealth(25);assert.equal(member.player.health,25);
});
test('an invalid random source leaves recruitment inventory and roster untouched',()=>{
  const {party}=setup();party.bag.add('hero-emblem');const id=party.bag.entries.find(entry=>entry.item==='hero-emblem')!.id;
  assert.throws(()=>party.recruit(id,()=>1),/随机值/);
  assert.equal(party.bag.count('hero-emblem'),1);assert.equal(party.snapshot().members.length,0);
});

test('adjacentLivingMember cycles forward and backward, wraps, and tolerates a missing current',()=>{
  const ids=['player','a','b'];
  assert.equal(adjacentLivingMember(ids,'player',1),'a');
  assert.equal(adjacentLivingMember(ids,'b',1),'player');
  assert.equal(adjacentLivingMember(ids,'player',-1),'b');
  assert.equal(adjacentLivingMember(ids,'a',-1),'player');
  assert.equal(adjacentLivingMember(['player'],'player',1),'player');
  assert.equal(adjacentLivingMember([],'player',1),undefined);
  // 刚阵亡的操控者不在存活列表里：正向取第一个、反向取最后一个。
  assert.equal(adjacentLivingMember(ids,'dead',1),'player');
  assert.equal(adjacentLivingMember(ids,'dead',-1),'b');
});
