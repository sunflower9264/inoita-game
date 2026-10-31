import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { EnemySpawn, WorldIndex } from '../src/domain/content.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import { Session } from '../src/domain/session.ts';
import { SessionCheckpoint } from '../src/domain/session-checkpoint.ts';
import { groundLootFor } from '../src/domain/ground-loot.ts';
import { healerRevivalQuote, reviveAtHealer } from '../src/domain/party-revival.ts';
import { StoryDirector } from '../src/domain/story-director.ts';
import { GameUI } from '../src/ui/game-ui.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const campaign=read<Campaign>('campaign'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
const battle=read<BattleCatalog>('battle'),companions=read<CompanionCatalog>('companions');
function createSession(withParty=false):Session {
  const hero=new BattleCharacter('dark-knight',stats,items);
  return new Session(campaign,undefined,undefined,items,hero,battle,stats,withParty?companions:undefined);
}

test('a checkpoint rolls back rewards, growth, equipment and skills together and leaves its snapshot detached',()=>{
  const session=createSession(),hero=session.hero!,checkpoints=new SessionCheckpoint<{positions:{x:number;y:number}[]}>();
  const location={map:campaign.start.map,x:64,y:80};
  session.enterMap(location.map);session.accept('grafton-mission');session.trackQuest('grafton-mission');
  hero.addExperience(stats.experience[0]!);hero.allocate('strength',1);hero.setHealth(7);hero.setMana(3);
  session.skills.setShortcutPage(hero.classId,1);session.gainMoney(123);
  const before=session.captureState(),revision=session.bag.revision;
  checkpoints.capture(session,location,{positions:[{x:10,y:12}]});
  session.enemyDefeated({id:'earl',enemyId:'enemy-earl-grafton-1',x:0,y:0});assert.equal(session.complete('grafton-mission'),true);
  session.mark('after-checkpoint');hero.addExperience(1000);hero.grantSkillPoint();hero.resetAttributes();
  session.bag.unequip('main-hand');session.skills.setShortcutPage(hero.classId,0);hero.setHealth(0);
  const peek=checkpoints.peek()!;peek.session.money=999999;peek.world.positions[0].x=999;
  const restored=checkpoints.restore(session)!;
  assert.deepEqual(restored,{location,world:{positions:[{x:10,y:12}]}});
  assert.deepEqual(session.captureState(),before);
  assert.equal(session.complete('grafton-mission'),false);
  assert.ok(session.bag.revision>revision);assert.equal(session.restorationVersion,1);
  assert.equal(hero.player.health,7);assert.equal(hero.player.mana,3);
  restored.world.positions[0].x=44;
  checkpoints.restore(session);assert.deepEqual(session.captureState(),before);
  assert.equal(checkpoints.peek()!.world.positions[0].x,10);
});

test('restoring rolls back dropped rewards, opened chests, store stock and remaining gameplay timers',()=>{
  const session=createSession(),hero=session.hero!,map=campaign.start.map;
  session.enterMap(map);session.gainMoney(50);
  const spawn:EnemySpawn={id:'fixture-enemy',enemyId:battle.enemies[0].id,x:32,y:32};
  session.enemyDefeated(spawn,5000);session.advanceGameTime(1000);
  hero.setHealth(hero.player.health-5);
  const potion=session.bag.entries.find(entry=>entry.item===items.startingShortcut)!;
  assert.equal(session.recovery.use(session.bag,potion.id,[{id:'player',player:hero.player,setHealth:value=>hero.setHealth(value),setMana:value=>hero.setMana(value)}],'player').used,true);
  session.chests.open(map,'first-chest',{x:16,y:16},()=>({rewards:[],enemies:[battle.enemies[0].id]}));
  const stock=session.shops.open('fixture-shop',()=>[{id:session.shops.identity(),instance:session.bag.entries[0],limited:true,concealed:false,sold:false}]);
  const loot=groundLootFor(session);loot.add(map,100,120,[{kind:'money',amount:25}]);
  const checkpoint=new SessionCheckpoint();checkpoint.capture(session,{map,x:80,y:80},undefined);
  const before=session.captureState(),cooldown=session.recovery.cooldown;
  session.advanceGameTime(10000);assert.equal(session.canSpawnEnemy(spawn),true);
  stock[0].sold=true;loot.collectNearby(map,100,120,reward=>{if(reward.kind==='money')session.gainMoney(reward.amount);});
  session.chests.open(map,'second-chest',{x:24,y:24},()=>({rewards:[],enemies:[]}));
  let updates=0;session.subscribe(()=>updates++);checkpoint.restore(session);
  assert.equal(updates,1);assert.deepEqual(session.captureState(),before);
  assert.deepEqual(session.recovery.cooldown,cooldown);
  assert.equal(session.chests.isOpened(map,'first-chest'),true);assert.equal(session.chests.isOpened(map,'second-chest'),false);
  assert.equal(session.shops.open('fixture-shop',()=>{throw new Error('stock should be restored');})[0].sold,false);
  const collect=()=>loot.collectNearby(map,100,120,reward=>{if(reward.kind==='money')session.gainMoney(reward.amount);});
  assert.equal(collect().length,1);assert.equal(collect().length,0);assert.equal(session.money,75);
  session.advanceGameTime(3999);assert.equal(session.canSpawnEnemy(spawn),false);
  session.advanceGameTime(1);assert.equal(session.canSpawnEnemy(spawn),true);
});

test('restoring recreates dismissed companions without regenerating their gear, skills or identifiers',()=>{
  const session=createSession(true),party=session.party!,bag=session.bag;
  bag.add('mercenary-emblem-priest');
  const member=party.recruit(bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!.id,()=>0).member;
  party.deployFirstAvailable(member.id);
  member.skills.setShortcutPage(member.classId,1);member.setHealth(13);member.setMana(2);
  const before=session.captureState();party.reserve(member.id);
  party.dismiss(member.id);assert.equal(party.get(member.id),undefined);
  session.restoreState(before);
  assert.deepEqual(session.captureState(),before);assert.equal(party.get(member.id)!.player.health,13);
  assert.equal(party.get(member.id)!.skills.shortcutPage(member.classId),1);
  const ids=new Set(session.bag.captureState().instances.map(entry=>entry.id));
  assert.equal(ids.size,session.bag.captureState().instances.length);
  assert.ok(Object.values(bag.equipmentFor(member.id)).every(id=>ids.has(id!)));
});

test('the soul healer charges only fallen deployed members, commits once and returns control to the hero',()=>{
  const session=createSession(true),party=session.party!,hero=session.hero!;
  session.bag.add('mercenary-emblem-priest',2);
  const recruit=()=>party.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!.id,()=>0).member;
  const first=recruit(),second=recruit();party.deployFirstAvailable(first.id);party.deployFirstAvailable(second.id);
  hero.setHealth(0);first.setHealth(0);party.switchControl(second.id);
  const quote=healerRevivalQuote(session);
  assert.deepEqual(quote,{cost:10+2*(hero.level+first.player.level),memberIds:['player',first.id]});
  session.gainMoney(quote.cost-1);
  assert.throws(()=>reviveAtHealer(session),/金币不足/);assert.equal(hero.player.health,0);
  session.gainMoney(1);let updates=0;session.subscribe(()=>updates++);
  assert.deepEqual(reviveAtHealer(session),quote);assert.equal(updates,1);assert.equal(session.money,0);
  assert.equal(hero.player.health,hero.player.maxHealth);assert.equal(first.player.mana,first.player.maxMana);
  assert.equal(party.controlledId,'player');assert.throws(()=>reviveAtHealer(session),/没有需要/);
  assert.equal(session.money,0);
});

test('healer choices cancel cleanly and repeated confirmation cannot double-charge',async()=>{
  const session=createSession(true),party=session.party!,ui=new GameUI();
  const actor=read<WorldIndex>('world').actors['soul-healer-20ef01d8'];
  assert.equal(actor.service,'soul-healer');
  session.bag.add('mercenary-emblem-priest');
  const member=party.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!.id,()=>0).member;
  party.deployFirstAvailable(member.id);member.setHealth(0);session.gainMoney(100);
  const director=new StoryDirector(campaign,session,ui,locked=>ui.lock(locked));
  const quote=healerRevivalQuote(session),revive=()=>{reviveAtHealer(session);};
  const first=director.visitHealer(actor,revive);
  assert.equal(ui.locked,true);assert.match(ui.choices!.description,new RegExp(String(quote.cost)));
  ui.choices!.choose(ui.choices!.options[1]);assert.equal(await first,true);
  assert.equal(session.money,100);assert.equal(member.alive,false);assert.equal(ui.locked,false);
  const second=director.visitHealer(actor,revive),choice=ui.choices!;
  choice.choose(choice.options[0]);choice.choose(choice.options[0]);assert.equal(await second,true);
  assert.equal(session.money,100-quote.cost);assert.equal(member.alive,true);assert.equal(ui.locked,false);
  member.setHealth(0);const cancelled=director.visitHealer(actor,revive);
  director.cancel();assert.equal(await cancelled,false);assert.equal(session.money,100-quote.cost);
  assert.equal(member.alive,false);assert.equal(ui.choices,undefined);
});

test('checkpoint restores buff resource limits before applying the saved combat conditions again',()=>{
  const session=createSession(true),hero=session.hero!,party=session.party!;
  session.bag.add('mercenary-emblem-priest');
  const member=party.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!.id,()=>0).member;
  party.deployFirstAvailable(member.id);
  const savedLimits=[hero,member].map(character=>({maxHealth:character.player.maxHealth+100,maxMana:character.player.maxMana+50}));
  [hero,member].forEach((character,i)=>{
    const cap=savedLimits[i];character.setCombatResourceLimits(cap.maxHealth,cap.maxMana);
    character.setHealth(cap.maxHealth-7);character.setMana(cap.maxMana-3);
  });
  const before=session.captureState();hero.clearCombatResourceLimits();member.clearCombatResourceLimits();
  session.restoreState(before);
  [hero,party.get(member.id)!].forEach((character,i)=>{
    const cap=savedLimits[i];character.setCombatResourceLimits(cap.maxHealth,cap.maxMana);
    assert.equal(character.player.health,cap.maxHealth-7);assert.equal(character.player.mana,cap.maxMana-3);
  });
  assert.deepEqual(session.captureState(),before);
});

test('a death checkpoint does not bring consumed ancient swords back',()=>{
  const session=createSession(),checkpoint=new SessionCheckpoint<undefined>();
  session.legendaryWeapons.markPulled('map-a','sword-001');
  checkpoint.capture(session,{map:campaign.start.map,x:16,y:24},undefined);
  session.legendaryWeapons.markPulled('map-a','sword-002');
  checkpoint.restore(session);
  assert.equal(session.legendaryWeapons.isPulled('map-a','sword-001'),true);
  assert.equal(session.legendaryWeapons.isPulled('map-a','sword-002'),true);
});
