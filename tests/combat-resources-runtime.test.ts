import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {CombatController,type Combatant,type CombatPort} from '../src/domain/combat.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {Session} from '../src/domain/session.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import {PartyRoster,type CompanionCatalog} from '../src/domain/party.ts';
import type {BattleBuffEffect,BattleCatalog} from '../src/domain/battle.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type {ItemCatalog} from '../src/domain/items.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {WorldScene}=await import('../src/scenes/world-scene.ts');
phaser.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
const read=<T>(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const battle=read<BattleCatalog>('battle'),campaign=read<Campaign>('campaign');
const effect=(overrides:Partial<BattleBuffEffect>):BattleBuffEffect=>({durationMs:10000,tickMs:0,modifiers:[],states:[],periodic:[],...overrides});

function castFixture(){
  const caster:Combatant={id:'player',team:'party',position:{x:0,y:0},bounds:{x:-8,y:-8,width:16,height:16}};
  const target:Combatant={...caster,id:'enemy',team:'enemy',position:{x:100,y:0}};
  let cost=30,mana=50,plays=0;
  const checks:number[]=[],spent:number[]=[];
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor(caster.id),actor:id=>id===caster.id?caster:target,candidates:()=>[caster,target],facing:()=> 'east',
    moveToward:()=>{},stop:()=>{},canStand:()=>true,relocate:()=>{},clearEffects:()=>{},frame:()=>{},
    manaCost:()=>cost,canSpendMana:value=>{checks.push(value);return mana>=value;},
    spendMana:value=>{spent.push(value);if(mana<value)return false;mana-=value;return true;},
    play:()=>{plays++;return()=>{};}};
  const combat=new CombatController(caster.id,null,port);
  const skill={id:'dark-strike',action:battle.skills['dark-strike'].action!,manaCost:999};
  return {combat,skill,checks,spent,near:()=>{target.position.x=24;},cost:(value:number)=>{cost=value;},
    mana:()=>mana,plays:()=>plays};
}

test('approach rechecks current mana cost at cast time and refuses a newly unaffordable skill',()=>{
  for(const [cost,plays,mana] of [[12,1,38],[70,0,50]]){
    const run=castFixture();assert.equal(run.combat.request(run.skill,'enemy'),'started');
    assert.deepEqual(run.checks,[30]);assert.deepEqual(run.spent,[]);
    run.cost(cost);run.near();run.combat.update();
    assert.deepEqual(run.spent,[cost]);assert.equal(run.plays(),plays);assert.equal(run.mana(),mana);
    assert.equal(!!run.combat.snapshot().cooldowns['dark-strike'],!!plays);
  }
});

test('zero and negative live costs override a stale positive cost and settle only once',()=>{
  for(const cost of [0,-7]){
    const run=castFixture();run.cost(cost);run.near();
    assert.equal(run.combat.request(run.skill,'enemy'),'started');run.combat.update();
    assert.equal(run.plays(),1);assert.equal(run.mana(),50-cost);
    assert.deepEqual(run.spent,cost?[cost]:[]);assert.deepEqual(run.checks,cost?[cost]:[]);
  }
});

test('signed native mana settlement can exceed the ceiling until the next ordinary resource write',()=>{
  const stats=read<CharacterStatsCatalog>('character-stats'),items=read<ItemCatalog>('items');
  const hero=new BattleCharacter('dark-knight',stats,items);
  const party=new PartyRoster(hero,stats,items,read<CompanionCatalog>('companions'),()=>{});
  hero.bag.add('mercenary-emblem-priest');
  const companion=party.recruit(hero.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!.id,()=>0).member;
  for(const member of [hero,companion]){
    member.setMana(2);assert.equal(member.spendMana(0),true);assert.equal(member.player.mana,2);
    assert.equal(member.spendMana(-7),true);assert.equal(member.player.mana,9);
    assert.equal(member.spendMana(-member.player.maxMana),true);assert.equal(member.player.mana,member.player.maxMana+9);
    assert.equal(member.spendMana(member.player.mana+1),false);assert.equal(member.player.mana,member.player.maxMana+9);
    member.setMana(member.player.mana);assert.equal(member.player.mana,member.player.maxMana);
  }
});

function recoveryFixture(){
  const session=new Session(campaign),conditions=new CombatConditions();
  const makeMember=(level:number,health=1)=>{
    const player={level,health,maxHealth:1000,mana:0,maxMana:100};
    return {level,player,panel:{maxHealth:1000,maxMana:100},setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number){this.player[key]=value;},
      setCombatResourceLimits:(health:number,mana:number)=>{player.maxHealth=health;player.maxMana=mana;player.health=Math.min(player.health,health);player.mana=Math.min(player.mana,mana);},setHealth:(value:number)=>{player.health=Math.min(player.maxHealth,Math.max(0,value));},
      setMana:(value:number)=>{player.mana=Math.min(player.maxMana,Math.max(0,value));}};
  };
  const player=makeMember(1),ally=makeMember(10),dead=makeMember(20,0);
  const members=new Map([['player',player],['ally',ally],['dead',dead]]);
  const monsters=new Map([['monster',{level:7,health:1,maxHealth:100,mana:0,maxMana:100}],
    ['dead-monster',{level:80,health:0,maxHealth:100,mana:0,maxMana:100}]]);
  const host={app:{session,battleCatalog:battle},conditions,hero:{level:99},activeParty:[...members.keys()],
    arena:[...monsters.keys()].map(key=>({key,definition:{}})),pendingDefeats:new Set<string>(),
    memberOf:(id:string)=>members.get(id),partyPassives:()=>[],
    equipmentRecovery:(id:string)=>({manaRecoveryPerPulse:id==='ally'?3:0,manaCostReductionRate:id==='ally'?30:0}),
    roster:{enemySnapshot:(id:string)=>monsters.get(id),
      setEnemyMana:(id:string,value:number)=>{const m=monsters.get(id)!;m.mana=Math.min(m.maxMana,Math.max(0,value));},
      setEnemyHealth:(id:string,value:number)=>{const m=monsters.get(id)!;m.health=Math.min(m.maxHealth,Math.max(0,value));}},
    resourceCapacityInputs(id:string):unknown{return method('resourceCapacityInputs').call(host,id);},
    readResourceCapacity(id:string,key:string):number{return method('readResourceCapacity').call(host,id,key);},
    syncCombatResourceLimits(id:string):void{method('syncCombatResourceLimits').call(host,id);},
    actorAttribute(id:string,key:string):number{return method('actorAttribute').call(host,id,key);},
    restoreHealth(id:string,amount:number):void{method('restoreHealth').call(host,id,amount);},
    restoreMana(id:string,amount:number):void{method('restoreMana').call(host,id,amount);},
    recoverResources():void{method('recoverResources').call(host);},
    periodicTick:()=>{},
  };
  return {host,session,conditions,player,ally,dead,monsters,advance:(delta:number)=>session.advanceCombatFrames(delta,()=>{conditions.update(60);for(const id of host.activeParty)host.syncCombatResourceLimits(id);host.recoverResources();})};
}

test('host resource attributes use each actor default plus equipment and stacked buffs with native nonnegative reads',()=>{
  const run=recoveryFixture();
  assert.equal(run.host.actorAttribute('player','healthRecoveryPerPulse'),99);
  assert.equal(run.host.actorAttribute('ally','healthRecoveryPerPulse'),132);
  assert.equal(run.host.actorAttribute('monster','healthRecoveryPerPulse'),0);
  assert.equal(run.host.actorAttribute('monster','manaRecoveryPerPulse'),8);
  assert.equal(run.host.actorAttribute('monster','manaCostRate'),0);
  assert.equal(run.host.actorAttribute('ally','manaRecoveryPerPulse'),11);
  assert.equal(run.host.actorAttribute('ally','manaCostReductionRate'),30);
  assert.equal(method('skillManaCost').call(run.host,'ally','dark-strike',1),38);
  assert.equal(method('skillManaCost').call(run.host,'monster','dark-strike',1),0);
  assert.equal(method('skillManaCost').call(run.host,'player','dark-strike',0),undefined);
  const recovery=effect({maxStacks:3,modifiers:[{attribute:'healthRecoveryPerPulse',operation:{kind:'add',amount:10}},
    {attribute:'manaRecoveryPerPulse',operation:{kind:'add',amount:4}}]});
  run.conditions.applyBuff('ally','light-command',1,recovery);run.conditions.applyBuff('ally','light-command',1,recovery);
  assert.equal(run.host.actorAttribute('ally','healthRecoveryPerPulse'),152);assert.equal(run.host.actorAttribute('ally','manaRecoveryPerPulse'),19);
  run.advance(1860);assert.equal(run.ally.player.health,153);assert.equal(run.ally.player.mana,19);
  for(const key of ['healthRecoveryPerPulse','manaRecoveryPerPulse','manaCostRate','manaCostReductionRate'] as const){
    run.conditions.setTemporaryAttribute('ally',key,-100);assert.equal(run.host.actorAttribute('ally',key),-100);
    run.conditions.clearTemporaryAttribute('ally',key);
    run.conditions.applyBuff('ally','light-command',1,effect({modifiers:[{attribute:key,operation:{kind:'set',amount:-100}}]}));
    assert.equal(run.host.actorAttribute('ally',key),0);
  }
});

test('scene recovery retains session phase, uses monster own emergency level and never revives dead actors',()=>{
  const run=recoveryFixture();
  run.conditions.applyBuff('monster','monster-emergency-recovery',0,effect({}));
  run.advance(1859);assert.equal(run.player.player.health,1);assert.equal(run.ally.player.mana,0);
  run.session.enterMap('another-map');run.advance(1);
  assert.deepEqual([run.player.player.health,run.player.player.mana],[100,8]);
  assert.deepEqual([run.ally.player.health,run.ally.player.mana],[133,11]);
  assert.deepEqual([run.monsters.get('monster')!.health,run.monsters.get('monster')!.mana],[22,8]);
  assert.deepEqual([run.dead.player.health,run.dead.player.mana],[0,0]);
  assert.deepEqual([run.monsters.get('dead-monster')!.health,run.monsters.get('dead-monster')!.mana],[0,0]);
  run.host.pendingDefeats.add('monster');run.advance(1860*10);
  assert.deepEqual([run.player.player.health,run.player.player.mana],[1000,88]);
  assert.deepEqual([run.ally.player.health,run.ally.player.mana],[1000,100]);
  assert.deepEqual([run.monsters.get('monster')!.health,run.monsters.get('monster')!.mana],[22,8]);
  run.host.restoreMana('dead',50);run.host.restoreMana('dead-monster',50);run.host.restoreMana('monster',50);
  assert.equal(run.dead.player.mana,0);assert.equal(run.monsters.get('dead-monster')!.mana,0);assert.equal(run.monsters.get('monster')!.mana,8);
});

test('long scene updates use the recovery buff active at each pulse and match split updates',()=>{
  const run=(deltas:number[])=>{
    const fixture=recoveryFixture(),amounts:number[]=[];
    const restoreHealth=fixture.host.restoreHealth;
    fixture.host.restoreHealth=(id,amount)=>{if(id==='player')amounts.push(amount);restoreHealth(id,amount);};
    fixture.conditions.applyBuff('player','light-command',1,effect({durationMs:2000,
      modifiers:[{attribute:'healthRecoveryPerPulse',operation:{kind:'add',amount:10}}]}));
    for(const delta of deltas)fixture.advance(delta);
    return {amounts,health:fixture.player.player.health,mana:fixture.player.player.mana,
      nextPulseIn:fixture.session.resourceRecoveryDelayMs,buffs:fixture.conditions.snapshot('player')};
  };
  const single=run([4000]);
  assert.deepEqual(single,{amounts:[109,99],health:209,mana:16,nextPulseIn:1580,buffs:[]});
  assert.deepEqual(run([2000,2000]),single);
  assert.deepEqual(run([1859,1,140,1720,280]),single);
});

test('the controlled skill slot reads the live mana cost after resource changes',()=>{
  let cost=38;
  const shown:{entry:unknown;enabled:boolean}[]=[];
  const configuration={draft:()=>({levels:{'dark-strike':1}}),shortcutPage:()=>0,activeSkills:()=>['dark-strike']};
  const member={classId:'dark-knight',player:{mana:50},skills:configuration};
  const bag={catalog:{startingShortcut:''},ensureShortcuts:(_owner:string,row:unknown)=>row};
  const scene={app:{session:{bag,skills:configuration},battleCatalog:battle},
    combat:{controlledId:'ally',controlledMember:member,
      skillShortcutState:(skill:string,level:number)=>{
        assert.deepEqual([skill,level],['dark-strike',1]);return {cost,enabled:true};}},
    worldHud:{ready:true,setShortcutPage:(slots:unknown[])=>shown.push(slots[0] as {entry:unknown;enabled:boolean})}};
  // 刷新会顺路问场景当前操控者是谁，所以桩要挂在 WorldScene 的原型上。
  Object.setPrototypeOf(scene,WorldScene.prototype);
  const refresh=Reflect.get(WorldScene.prototype,'refreshCombatHud');refresh.call(scene);
  member.player.mana=4;refresh.call(scene);
  // 每次都用当前这一帧的实时耗蓝重新判定：50 点蓝付得起 38，掉到 4 点就该置灰。
  assert.deepEqual(shown.map(slot=>({entry:slot.entry,enabled:slot.enabled})),
    [{entry:{kind:'skill',id:'dark-strike'},enabled:true},{entry:{kind:'skill',id:'dark-strike'},enabled:false}]);
});


test('each recovery pulse applies the resource ceiling after the current buff expiry',()=>{
  const run=recoveryFixture(),caps:number[][]=[];
  run.player.panel.maxHealth=100;run.player.panel.maxMana=10;
  run.conditions.applyBuff('player','light-command',1,effect({durationMs:2000,modifiers:[
    {attribute:'maxHealth',operation:{kind:'add',amount:50}},
    {attribute:'maxMana',operation:{kind:'add',amount:5}},
  ]}));
  const restore=run.host.restoreHealth;
  run.host.restoreHealth=(id,amount)=>{if(id==='player')caps.push([run.player.player.maxHealth,run.player.player.maxMana]);restore(id,amount);};
  run.advance(4000);
  assert.deepEqual(caps,[[150,15],[100,10]]);
  assert.equal(run.player.player.health,100);assert.equal(run.player.player.mana,10);
});
