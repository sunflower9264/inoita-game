import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { CampaignQuest, Campaign } from '../src/domain/campaign.ts';
import { Session } from '../src/domain/session.ts';
import {groundLootFor} from '../src/domain/ground-loot.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import { moneyGain } from '../src/domain/economy.ts';

const read=<T>(file:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${file}.json`,import.meta.url),'utf8')) as T;
const items=read<ItemCatalog>('items'),battle=read<BattleCatalog>('battle'),stats=read<CharacterStatsCatalog>('character-stats'),companions=read<CompanionCatalog>('companions');
function quest(id:string,patch:Partial<CampaignQuest>={}):CampaignQuest {
  return {id,title:id,description:id,giver:'npc',guidance:{available:'offer',active:'continue'},goals:[],completion:'talk',
    progressText:'continue',completeText:'thanks',...patch};
}

test('explicit re-admission starts a fresh settlement cycle while duplicate completion stays idempotent',()=>{
  const session=new Session(campaign([quest('again',{rewards:{experience:0,money:5,items:[]}})]));
  for(const type of ['accept','accept','script-ready'] as const){
    session.applyStoryCommands([{type:'quest',command:{type,quest:'again',...(type==='accept'?{source:'script' as const}:{})}}]);
    session.applyStoryCommands([{type:'quest',command:{type:'script-complete',quest:'again'}}]);
    session.applyStoryCommands([{type:'quest',command:{type:'script-complete',quest:'again'}}]);
  }
  assert.equal(session.money,moneyGain(15),'三轮各发 5 金币，按获取倍率放大');
  assert.deepEqual(session.captureState().receipts.map(r=>r.cycle),[0,1,2]);
  assert.equal(session.quests.get('again')!.completedCycles,3);
});
function campaign(quests:CampaignQuest[]):Campaign {
  return {version:2,contentVersion:1,start:{map:'camp',actor:'player',x:16,y:16,facing:'south',script:'opening'},quests,placements:[],questGroups:[],events:[],
    scripts:{opening:{entry:'entry',nodes:[{id:'entry',presentation:[],commands:[],exit:{type:'end'}}]}}};
}

function refreshCounter(t:test.TestContext,session:Session){
  let calls=0;
  const original=session.questBook.plan.bind(session.questBook);
  t.mock.method(session.questBook,'plan',(command:Parameters<typeof original>[0])=>{calls++;return original(command);});
  return ()=>calls;
}

test('unchanged quest inputs skip plans across repeated NPC queries and unrelated notifications',t=>{
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign([quest('one')]),undefined,undefined,items,hero,battle,stats,companions);
  const calls=refreshCounter(t,session);
  for(let index=0;index<50;index++){
    session.refresh();session.forActor('npc');session.deliverablesFor(`npc-${index}`);
  }
  session.gainMoney(1);hero.setHealth(1);hero.setMana(0);session.emit();
  assert.equal(calls(),0);
});

test('silent bag writes refresh item goals once and reuse the resulting quest revision',t=>{
  const session=new Session(campaign([quest('letter',{completion:'all',goals:[{id:'letter',kind:'item',target:'letter',quantity:1}]})]));
  session.accept('letter');const calls=refreshCounter(t,session);let notifications=0;session.subscribe(()=>notifications++);
  session.bag.add('letter');session.forActor('npc');
  assert.equal(session.status('letter'),'ready');assert.equal(calls(),1);
  session.refresh();session.deliverablesFor('npc');assert.equal(calls(),1);
  session.bag.remove('letter',1);session.forActor('npc');
  assert.equal(session.status('letter'),'active');assert.equal(calls(),2);assert.equal(notifications,0);
});

test('quest dependency reads detect direct flags, choices, runtime checkpoints and live world values',t=>{
  const content=campaign([
    quest('flag',{availableWhen:{type:'not',condition:{type:'flag',flag:'blocked'}}}),
    quest('choice',{availableWhen:{type:'any',conditions:[{type:'choice',choice:'route',value:'north'}]}}),
    quest('world',{availableWhen:{type:'all',conditions:[{type:'world',key:'player-x',value:24}]}}),
    quest('event',{availableWhen:{type:'event',event:'event',status:'completed'}})
  ]);
  content.events=[{id:'event',source:'start',script:'opening'}];
  const session=new Session(content),values={'player-x':0};session.setStoryWorldContext(()=>values);
  const calls=refreshCounter(t,session);let notifications=0;session.subscribe(()=>notifications++);
  session.storyWorld.apply({kind:'flag',id:'blocked',value:true});session.refresh();
  assert.equal(session.status('flag'),'locked');assert.equal(calls(),1);
  session.storyWorld.apply({kind:'choice',id:'route',value:'north'});session.refresh();
  assert.equal(session.status('choice'),'available');assert.equal(calls(),2);
  values['player-x']=24;session.forActor('npc');assert.equal(session.status('world'),'available');assert.equal(calls(),3);
  const runtime=session.runtimeState;runtime.completedEvents=['event'];
  runtime.runs=[{id:'story:1',occurrence:'start:1',eventId:'event',cursor:{script:'opening',node:'entry'},status:'completed'}];runtime.sequence=1;
  session.runtimeState=runtime;session.forActor('npc');
  assert.equal(session.status('event'),'available');assert.equal(calls(),4);
  session.refresh();assert.equal(calls(),4);assert.equal(notifications,0);
  session.setStoryWorldContext(()=>({'player-x':0}));assert.equal(session.status('world'),'locked');assert.equal(calls(),5);
});

test('equipment shortcut completion follows the controlled member after a cached refresh',()=>{
  const weapon=items.startingEquipment['dark-knight']['main-hand']!;
  const definition=Object.values(companions.definitions).find(member=>member.classId==='priest')!;
  const story={...definition,id:'story-cache-priest',source:'story' as const};
  const catalog={...companions,definitions:{...companions.definitions,[story.id]:story}};
  const hero=new BattleCharacter('dark-knight',stats,items),session=new Session(campaign([quest('equipped',{
    completion:'all',itemCompletion:'equipped-item-shortcut',goals:[{id:'weapon',kind:'item',target:weapon,quantity:1}]
  })]),undefined,undefined,items,hero,battle,stats,catalog);
  session.accept('equipped');session.refresh();assert.equal(session.status('equipped'),'ready');
  session.applyStoryCommands([{type:'party-join',companion:story.id}]);
  session.party!.switchControl('story-'+story.id);session.refresh();assert.equal(session.status('equipped'),'active');
  session.party!.switchControl('player');session.refresh();assert.equal(session.status('equipped'),'ready');
  const equipped=hero.bag.equipment['main-hand']!;hero.bag.unequip('main-hand');session.refresh();
  assert.equal(session.status('equipped'),'ready','the unequipped weapon now satisfies the inventory goal');
  hero.bag.take(equipped,1);session.refresh();assert.equal(session.status('equipped'),'active');
});

test('restores and failed commits leave quest refresh caches coherent',t=>{
  const session=new Session(campaign([quest('letter',{completion:'all',goals:[{id:'letter',kind:'item',target:'letter',quantity:1}]})]));
  session.accept('letter');const before=session.captureState();
  session.bag.add('letter');session.refresh();assert.equal(session.status('letter'),'ready');
  session.restoreState(before);session.refresh();assert.equal(session.status('letter'),'active');
  const original=session.bag.add.bind(session.bag);
  t.mock.method(session.bag,'add',(item:string,quantity?:number)=>{original(item,quantity);session.refresh();throw new Error('fixture commit failure');});
  assert.throws(()=>session.applyStoryCommands([{type:'item-give',item:'letter',quantity:1}]),/fixture commit failure/);
  assert.deepEqual(session.captureState(),before);session.refresh();assert.equal(session.status('letter'),'active');
});

test('a failed refresh plan is retried even when its input versions stay the same',t=>{
  const session=new Session(campaign([quest('one')]));
  const original=session.questBook.plan.bind(session.questBook);let fail=true,calls=0;
  t.mock.method(session.questBook,'plan',(command:Parameters<typeof original>[0])=>{
    calls++;if(fail)throw new Error('fixture plan failure');return original(command);
  });
  session.bag.add('letter');assert.throws(()=>session.refresh(),/fixture plan failure/);
  fail=false;session.refresh();session.refresh();assert.equal(calls,2);
});

test('native cleanup removes what remains and ground items require pickup',()=>{
  const session=new Session(campaign([]),undefined,undefined,items);
  session.bag.add('west-mine-key',1);
  session.gainMoney(7);
  session.applyStoryCommands([{type:'item-take',item:'west-mine-key',quantity:3,allowPartial:true},
    {type:'money-take',amount:500,allowPartial:true},{type:'item-take',item:'west-mine-key',quantity:3,allowPartial:true},
    {type:'item-drop',item:'west-mine-key',quantity:1,map:'camp',x:40,y:56}]);
  assert.equal(session.money,0);assert.equal(session.itemCount('west-mine-key'),0);
  assert.equal(groundLootFor(session).forMap('camp')[0].reward.kind,'item');
  const state=session.captureState();session.restoreState(state);
  assert.equal(groundLootFor(session).forMap('camp').length,1);
  groundLootFor(session).collectNearby('camp',40,56,reward=>{if(reward.kind==='item')session.bag.add(reward.item,reward.quantity);});
  assert.equal(session.itemCount('west-mine-key'),1);
});

test('quest menus use the acceptance NPC before admission and the delivery NPC afterwards',()=>{
  const session=new Session(campaign([quest('letter',{giver:'sender',delivery:'recipient'}),
    quest('event-only',{giver:undefined,delivery:'recipient'}),quest('second',{giver:'sender',delivery:'recipient'})]));
  assert.deepEqual(session.forActor('sender').map(value=>value.id),['letter','second']);
  assert.deepEqual(session.forActor('recipient'),[]);
  session.accept('letter');
  assert.deepEqual(session.forActor('sender').map(value=>value.id),['second']);
  assert.deepEqual(session.forActor('recipient').map(value=>value.id),['letter']);
  session.accept('event-only');
  assert.deepEqual(session.forActor('recipient').map(value=>value.id),['letter','event-only']);
  assert.deepEqual(session.deliverablesFor('recipient'),[]);
});

test('NPC interaction executes one native quest slot instead of listing every related quest',()=>{
  const content=campaign([
    quest('main-offer',{giver:'npc'}),
    quest('side-offer',{giver:'npc'}),
    quest('hidden-delivery',{delivery:'npc',hidden:true}),
    quest('ongoing',{giver:'npc',completion:'all',goals:[{id:'token',kind:'item',target:'token',quantity:2}]}),
  ]);
  content.questGroups=[
    {id:'g-main',title:'main',kind:'main',questIds:['main-offer','hidden-delivery']},
    {id:'g-side',title:'side',kind:'side',questIds:['side-offer','ongoing']},
  ];
  const session=new Session(content);
  assert.equal(session.npcQuestSlot('npc')?.id,'main-offer','可接主线优先于支线');
  session.accept('hidden-delivery');
  assert.equal(session.status('hidden-delivery'),'ready');
  assert.equal(session.npcQuestSlot('npc')?.id,'hidden-delivery','隐藏的待交付压过可接任务');
  assert.equal(session.forActor('npc').some(value=>value.id==='hidden-delivery'),false,'完整列表仍只含日志可见任务');
  session.complete('hidden-delivery');
  assert.equal(session.npcQuestSlot('npc')?.id,'main-offer');
  session.accept('main-offer');
  assert.equal(session.npcQuestSlot('npc')?.id,'main-offer','对话任务接取即待交付');
  session.complete('main-offer');
  assert.equal(session.npcQuestSlot('npc')?.id,'side-offer','没有待交付与可接主线时才轮到支线');
  session.accept('ongoing');
  assert.equal(session.status('ongoing'),'active');
  assert.equal(session.npcQuestSlot('npc')?.id,'side-offer','可接支线仍优先于进行中的任务');
  session.accept('side-offer');
  assert.equal(session.npcQuestSlot('npc')?.id,'side-offer');
  session.focusDebugQuest('ongoing');
  assert.equal(session.npcQuestSlot('npc')?.id,'ongoing','GM 焦点只认焦点任务');
});

test('multiple pending deliveries keep the native running-pool order',()=>{
  const session=new Session(campaign([quest('first',{delivery:'npc'}),quest('second',{delivery:'npc'})]));
  session.accept('second');session.accept('first');
  assert.deepEqual([session.status('second'),session.status('first')],['ready','ready']);
  assert.equal(session.npcQuestSlot('npc')?.id,'second','先进入运行池的待交付任务先执行');
  assert.equal(session.marker('npc'),'ready');
});

test('Session delegates real multi-goal progress, handover and rewards to one commit visible to listeners',()=>{
  const content=campaign([quest('materials',{completion:'all',goals:[
    {id:'meat',kind:'item',target:'meat',quantity:5},{id:'bone',kind:'item',target:'bone',quantity:5}],
    handoverItems:[{item:'meat',quantity:5},{item:'bone',quantity:5}],rewards:{experience:0,money:50,items:[{item:'potion',quantity:2}]}})]);
  const session=new Session(content);session.accept('materials');session.bag.add('meat',5);session.bag.add('bone',5);session.emit();
  assert.equal(session.status('materials'),'ready');assert.deepEqual(session.quests.get('materials')!.goals,{meat:5,bone:5});
  const states:unknown[]=[];session.subscribe(value=>states.push({money:value.money,status:value.status('materials'),meat:value.itemCount('meat'),potion:value.itemCount('potion')}));
  assert.equal(session.complete('materials'),true);
  assert.deepEqual(states,[{money:moneyGain(50),status:'completed',meat:0,potion:2}]);assert.equal(session.complete('materials'),false);
  assert.deepEqual(session.rewardReceiptFor('materials'),{experience:0,money:moneyGain(50),items:[{item:'potion',quantity:2}]});
});

test('node batches evaluate earlier flags and item grants before quest acceptance and settlement',()=>{
  const session=new Session(campaign([quest('delivery',{availableWhen:{type:'flag',flag:'permission'},completion:'all',
    goals:[{id:'letter',kind:'item',target:'letter',quantity:1}],handoverItems:[{item:'letter',quantity:1}],rewards:{experience:0,money:4,items:[]}})]));
  assert.equal(session.status('delivery'),'locked');let updates=0;session.subscribe(()=>updates++);
  session.applyStoryCommands([{type:'flag',flag:'permission'},{type:'item-give',item:'letter',quantity:1},
    {type:'quest',command:{type:'accept',quest:'delivery'}},{type:'quest',command:{type:'complete',quest:'delivery'}}]);
  assert.equal(updates,1);assert.equal(session.status('delivery'),'completed');assert.equal(session.itemCount('letter'),0);assert.equal(session.money,moneyGain(4));
  assert.equal(session.flags.has('permission'),true);
});

test('a failed joint handover leaves inventory, quests, receipts and subscribers unchanged',()=>{
  const content=campaign(['first','second'].map(id=>quest(id,{completion:'all',goals:[{id:'wood',kind:'item',target:'wood',quantity:3}],handoverItems:[{item:'wood',quantity:3}],rewards:{experience:0,money:5,items:[]}})));
  const session=new Session(content);session.bag.add('wood',4);session.accept('first');session.accept('second');const baseline=session.captureState();
  let updates=0;session.subscribe(()=>updates++);
  assert.throws(()=>session.applyStoryCommands([{type:'quest',command:{type:'complete',quest:'first'}},{type:'quest',command:{type:'complete',quest:'second'}}]),/目标尚未达成/);
  assert.deepEqual(session.captureState(),baseline);assert.equal(updates,0);
});

test('an item plan failure leaves prior planned removals and notifications untouched',()=>{
  const content=campaign([quest('test')]),session=new Session(content,undefined,undefined,items);
  const [pickup]=Object.entries(items.items).find(([,item])=>item.pickup)!;assert.ok(pickup);
  const existing=session.bag.entries[0],baseline=session.captureState();let updates=0;session.subscribe(()=>updates++);
  assert.throws(()=>session.applyStoryCommands([{type:'item-take',item:existing.item,quantity:1},{type:'item-give',item:pickup,quantity:1}]),/地面拾取/);
  assert.deepEqual(session.captureState(),baseline);assert.equal(updates,0);
});

test('an unexpected commit failure rolls back a successful removal before publishing any notification',()=>{
  const session=new Session(campaign([quest('test')]),undefined,undefined,items),existing=session.bag.entries[0],baseline=session.captureState();
  let updates=0;session.subscribe(()=>updates++);const original=session.bag.add;
  session.bag.add=()=>{throw new Error('fixture commit failure');};
  try{assert.throws(()=>session.applyStoryCommands([{type:'item-take',item:existing.item,quantity:1},{type:'item-give',item:existing.item,quantity:1}]),/commit failure/);}
  finally{session.bag.add=original;}
  assert.deepEqual(session.captureState(),baseline);assert.equal(updates,0);
});

test('a fresh interaction occurrence can reuse an entity without hiding it or inheriting another quest counter',()=>{
  const goal={id:'altar',kind:'interact' as const,target:'altar',quantity:1};
  const session=new Session(campaign([quest('first',{completion:'all',goals:[goal]}),quest('second',{completion:'all',goals:[goal],
    availableWhen:{type:'quest',quest:'first',status:'completed'}})]));
  session.accept('first');session.applyStoryCommands([{type:'interaction',target:'altar',instance:'same-altar'}]);
  assert.equal(session.status('first'),'ready');assert.equal(session.visible({id:'same-altar'}),true);
  session.complete('first');session.accept('second');session.interact('altar','same-altar');assert.equal(session.status('second'),'ready');
  assert.equal(session.visible({id:'same-altar'}),true);
});

test('ordinary deaths share defeat goals, duplicate death callbacks do not count and respawns create new facts',()=>{
  const session=new Session(campaign([quest('hunt',{completion:'all',goals:[{id:'bears',kind:'defeat',target:'bear',quantity:2}]})]));
  session.accept('hunt');const spawn={id:'spawn',enemyId:'bear',x:10,y:10};
  session.enemyDefeated(spawn,10);session.enemyDefeated(spawn,10);assert.equal(session.quests.get('hunt')!.goals.bears,1);
  const capture=session.captureState();session.restoreState(capture);session.enemyDefeated(spawn,10);assert.equal(session.quests.get('hunt')!.goals.bears,1);
  session.advanceGameTime(10);assert.equal(session.canSpawnEnemy(spawn),true);session.enemyDefeated(spawn,10);
  assert.equal(session.status('hunt'),'ready');assert.equal(session.quests.get('hunt')!.goals.bears,2);
});

test('runtime completion, world changes and reward receipts are captured in the same stable node',()=>{
  const content=campaign([quest('one')]);content.events=[{id:'event',source:'start',script:'opening'}];
  const session=new Session(content);session.accept('one');const checkpoint=session.runtimeState;
  checkpoint.completedEvents=['event'];checkpoint.runs=[{id:'story:1',occurrence:'start:1',eventId:'event',cursor:{script:'opening',node:'entry'},status:'completed'}];checkpoint.sequence=1;
  session.applyStoryCommands([{type:'quest',command:{type:'script-ready',quest:'one'}},{type:'quest',command:{type:'complete',quest:'one'}},{type:'world',command:{kind:'hide',id:'npc'}},{type:'choice',choice:'decision',value:'north'}],checkpoint);
  const saved=session.captureState();assert.equal(saved.runtime.completedEvents[0],'event');assert.equal(session.visible({id:'npc'}),false);
  assert.equal(session.evaluateCondition({type:'choice',choice:'decision',value:'north'}),true);
  session.mark('later');session.restoreState(saved);assert.deepEqual(session.captureState(),saved);
  assert.equal(session.evaluateCondition({type:'event',event:'event',status:'completed'}),true);
});

test('malformed snapshots reject unknown inventory, skill and runtime references without changing the live state',()=>{
  const hero=new BattleCharacter('dark-knight',stats,items),session=new Session(campaign([quest('one')]),undefined,undefined,items,hero,battle,stats,companions);
  const baseline=session.captureState();let updates=0;session.subscribe(()=>updates++);
  const invalidItem=structuredClone(baseline);invalidItem.bag.instances[0].item='missing-item';
  assert.throws(()=>session.restoreState(invalidItem),/物品引用/);assert.deepEqual(session.captureState(),baseline);
  const invalidSkill=structuredClone(baseline);invalidSkill.skills.loadouts.push(['dark-knight',{levels:{unknown:1}}]);
  assert.throws(()=>session.restoreState(invalidSkill),/技能引用/);assert.deepEqual(session.captureState(),baseline);
  const invalidRuntime=structuredClone(baseline);invalidRuntime.runtime.completedEvents=['unknown'];
  assert.throws(()=>session.restoreState(invalidRuntime),/事件不存在/);assert.deepEqual(session.captureState(),baseline);
  const lateFailure=structuredClone(baseline);lateFailure.bag.instances[0].quantity++;lateFailure.money=77;lateFailure.combatClock!.frame=-1;
  assert.throws(()=>session.restoreState(lateFailure));assert.deepEqual(session.captureState(),baseline);assert.equal(updates,0);
});

test('snapshots add newly authored tasks',()=>{
  const initial=campaign([quest('one')]),first=new Session(initial);first.accept('one');
  first.applyStoryCommands([{type:'quest',command:{type:'script-ready',quest:'one'}}]);const saved=first.captureState();
  const next=structuredClone(initial);next.quests.push(quest('two',{availableWhen:{type:'quest',quest:'one',status:'accepted'}}));
  const expanded=new Session(next);expanded.restoreState(saved);assert.equal(expanded.status('one'),'ready');assert.equal(expanded.status('two'),'available');
});

test('successful badge recruitment publishes one source-item fact with the member and badge in one notification',()=>{
  const content=campaign([quest('recruit',{completion:'all',goals:[{id:'badge',kind:'recruit',target:'mercenary-emblem-priest',quantity:1}]})]);
  const hero=new BattleCharacter('dark-knight',stats,items),session=new Session(content,undefined,undefined,items,hero,battle,stats,companions);
  session.accept('recruit');session.bag.add('mercenary-emblem-priest');
  const badge=session.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!,observed:unknown[]=[];
  session.subscribe(value=>observed.push({status:value.status('recruit'),badges:value.itemCount('mercenary-emblem-priest'),members:value.party!.snapshot().members.length}));
  session.party!.recruit(badge.id,()=>0);
  assert.deepEqual(observed,[{status:'ready',badges:0,members:1}]);
  assert.equal(session.captureState().factSequences.find(([source])=>source==='recruit')?.[1],1);
  const before=session.captureState();observed.length=0;
  assert.throws(()=>session.party!.recruit(badge.id,()=>0),/不在背包/);
  assert.deepEqual(session.captureState(),before);assert.deepEqual(observed,[]);
});

test('failed badge generation publishes no recruit fact, and story companions do not satisfy a badge goal',()=>{
  const content=campaign([quest('recruit',{completion:'all',goals:[{id:'badge',kind:'recruit',target:'mercenary-emblem-priest',quantity:1}]})]);
  const story={...Object.values(companions.definitions)[0],id:'story-example',source:'story' as const};
  const catalog:CompanionCatalog={...companions,definitions:{...companions.definitions,[story.id]:story}};
  const hero=new BattleCharacter('dark-knight',stats,items),session=new Session(content,undefined,undefined,items,hero,battle,stats,catalog);
  session.accept('recruit');session.bag.add('mercenary-emblem-priest');const badge=session.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!;
  const before=session.captureState();let updates=0;session.subscribe(()=>updates++);
  assert.throws(()=>session.party!.recruit(badge.id,()=>1),/随机值/);assert.deepEqual(session.captureState(),before);assert.equal(updates,0);
  session.applyStoryCommands([{type:'party-join',companion:story.id}]);
  assert.equal(session.status('recruit'),'active');assert.equal(session.quests.get('recruit')!.goals.badge,0);
  assert.equal(session.captureState().factSequences.some(([source])=>source==='recruit'),false);
});

test('party admission and experience settlement preserve their declared order within an atomic node',()=>{
  const story={...Object.values(companions.definitions)[0],id:'story-example',source:'story' as const};
  const catalog:CompanionCatalog={...companions,definitions:{...companions.definitions,[story.id]:story}};
  const create=()=>{
    const hero=new BattleCharacter('dark-knight',stats,items),session=new Session(campaign([quest('reward',{rewards:{experience:stats.experience[0]!,money:0,items:[]}})]),undefined,undefined,items,hero,battle,stats,catalog);
    session.accept('reward');session.applyStoryCommands([{type:'quest',command:{type:'script-ready',quest:'reward'}}]);return session;
  };
  const earlier=create();earlier.applyStoryCommands([{type:'party-join',companion:story.id},{type:'quest',command:{type:'complete',quest:'reward'}}]);
  assert.equal(earlier.hero!.level,2);assert.equal(earlier.party!.get('story-'+story.id)!.level,1);
  const later=create();later.applyStoryCommands([{type:'quest',command:{type:'complete',quest:'reward'}},{type:'party-join',companion:story.id}]);
  assert.equal(later.party!.get('story-'+story.id)!.level,2);
});

test('character state, equipment and control commands use real domain abilities in declared order',()=>{
  const story={...Object.values(companions.definitions)[0],id:'story-example',source:'story' as const};
  const catalog:CompanionCatalog={...companions,definitions:{...companions.definitions,[story.id]:story}},hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign([quest('one')]),undefined,undefined,items,hero,battle,stats,catalog),weapon=items.startingEquipment['dark-knight']['main-hand']!,old=hero.bag.equipment['main-hand'];
  let updates=0;session.subscribe(()=>updates++);
  session.applyStoryCommands([{type:'item-give',item:weapon,quantity:1},{type:'equip',member:'player',item:weapon,slot:'main-hand'},
    {type:'health',member:'player',value:1},{type:'mana',member:'player',value:0},
    {type:'party-join',companion:story.id},{type:'health',member:'story-'+story.id,value:2},{type:'party-control',member:'story-'+story.id},
    {type:'health',member:'player',value:'full'},{type:'mana',member:'player',value:'full'}]);
  assert.notEqual(hero.bag.equipment['main-hand'],old);assert.ok(hero.bag.entries.some(entry=>entry.id===old));
  assert.equal(hero.player.health,hero.player.maxHealth);assert.equal(hero.player.mana,hero.player.maxMana);
  assert.equal(session.party!.get('story-'+story.id)!.player.health,2);assert.equal(session.party!.controlledId,'story-'+story.id);assert.equal(updates,1);
  const baseline=session.captureState();updates=0;
  assert.throws(()=>session.applyStoryCommands([{type:'health',member:'player',value:0},{type:'party-control',member:'player'}]),/倒下/);
  assert.deepEqual(session.captureState(),baseline);assert.equal(updates,0);
});

test('declared talk completion publishes typed facts separately from object interactions',()=>{
  const session=new Session(campaign([quest('talk-to-both',{completion:'all',goals:[
    {id:'first',kind:'talk',target:'first-npc',quantity:1},{id:'second',kind:'talk',target:'second-npc',quantity:1}]} )]));
  session.accept('talk-to-both');session.applyStoryCommands([{type:'interaction',target:'first-npc',instance:'first-instance'}]);
  assert.equal(session.quests.get('talk-to-both')!.goals.first,0);
  session.applyStoryCommands([{type:'talk',target:'first-npc'}]);assert.equal(session.status('talk-to-both'),'active');
  assert.equal(session.quests.get('talk-to-both')!.goals.first,1);
  const saved=session.captureState();session.restoreState(saved);session.applyStoryCommands([{type:'talk',target:'second-npc'}]);
  assert.equal(session.status('talk-to-both'),'ready');assert.equal(session.captureState().factSequences.find(([source])=>source==='talk')?.[1],2);
});

test('branches and quest availability see a pending travel destination before formal scene projection',()=>{
  const session=new Session(campaign([quest('destination',{availableWhen:{type:'world',key:'map',value:'next'}})]));
  session.setStoryWorldContext(()=>({map:'camp'}));
  const travel={type:'travel' as const,destination:{map:'next',x:16,y:32,facing:'south' as const}};
  assert.equal(session.status('destination'),'locked');
  assert.equal(session.evaluateCondition({type:'world',key:'map',value:'next'},[travel]),true);
  assert.equal(session.evaluateCondition({type:'quest',quest:'destination',status:'available'},[travel]),true);
  assert.equal(session.status('destination'),'locked');assert.equal(session.storyWorld.currentLocation,undefined);
  session.applyStoryCommands([travel,{type:'quest',command:{type:'accept',quest:'destination'}},{type:'quest',command:{type:'script-ready',quest:'destination'}}]);
  assert.equal(session.status('destination'),'ready');assert.equal(session.evaluateCondition({type:'world',key:'map',value:'next'}),true);
});

test('waiting checkpoints require one active encounter with the declared node and result exits',()=>{
  const content=campaign([]),ref={script:'opening',node:'done'};
  const definition={id:'battle',map:'camp',status:'prepared' as const,spawns:[{id:'foe',enemyId:'bear',x:16,y:16}]};
  content.scripts.opening.nodes=[{id:'entry',presentation:[],commands:[],exit:{type:'waitEncounter',encounter:definition,outcomes:{won:ref,lost:ref}}},
    {id:'done',presentation:[],commands:[],exit:{type:'end'}}];
  const session=new Session(content),runtime=session.runtimeState,encounter={...definition,id:'story:1:entry:battle',status:'active' as const};
  runtime.sequence=1;runtime.runs=[{id:'story:1',script:'opening',occurrence:'manual:1',cursor:{script:'opening',node:'entry'},status:'waiting',
    waiting:{encounter:encounter.id,outcomes:{won:ref,lost:ref}}}];
  session.applyStoryCommands([{type:'encounter',encounter}],runtime);const baseline=session.captureState();
  session.restoreState(baseline);assert.deepEqual(session.captureState(),baseline);
  let updates=0;session.subscribe(()=>updates++);
  for(const status of ['won','lost','prepared'] as const){
    const invalid=structuredClone(baseline);invalid.storyWorld.encounters[0].status=status;
    assert.throws(()=>session.restoreState(invalid),/等待遭遇/);assert.deepEqual(session.captureState(),baseline);
  }
  const wrongNode=structuredClone(baseline);wrongNode.runtime.runs[0].cursor=ref;
  assert.throws(()=>session.restoreState(wrongNode),/剧情节点不一致/);
  const duplicate=structuredClone(baseline);duplicate.runtime.runs.push({...structuredClone(runtime.runs[0]),id:'story:2'});
  assert.throws(()=>session.restoreState(duplicate),/重复等待/);assert.equal(updates,0);
  assert.throws(()=>session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id:encounter.id,result:'won'}}]),/等待遭遇/);
  assert.deepEqual(session.captureState(),baseline);
  const resumed=structuredClone(runtime);resumed.runs[0].status='running';resumed.runs[0].cursor=ref;delete resumed.runs[0].waiting;
  session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id:encounter.id,result:'won'}}],resumed);
  assert.equal(session.storyWorld.encounter(encounter.id)!.status,'won');assert.equal(session.runtimeState.runs[0].status,'running');assert.equal(updates,1);
  assert.throws(()=>{session.runtimeState=runtime;},/等待遭遇/);assert.equal(session.runtimeState.runs[0].status,'running');
});

