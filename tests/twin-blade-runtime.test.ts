import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,ResolvedBasicAttack} from '../src/domain/battle.ts';
import type {CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import type {ActorDefinition} from '../src/domain/content.ts';
import type {ItemCatalog,ItemInstance} from '../src/domain/items.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import type {AttackContact} from '../src/domain/combat.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const catalog=read('battle') as BattleCatalog,items=read('items') as ItemCatalog;
const wardrobe=read('wardrobe') as WardrobeCatalog,stats=read('character-stats') as CharacterStatsCatalog;
const chanceBonuses=[30,50,80,120,130,140,150,160],criticalBonuses=[76,126,201,301,326,351,376,401];
// 原表 u03 各级 b；公式 563/565 分别 trunc((400+(1+20*b)*10)/20) 与 /8。
const companionScaling=[2,4,6,8,9,10,11,12];
const companionChanceBonuses=companionScaling.map(b=>Math.trunc((400+(1+20*b)*10)/20));
const companionCriticalBonuses=companionScaling.map(b=>Math.trunc((400+(1+20*b)*10)/8));
type MemberId='player'|'ally'|'target';
function fixture(){
  // Controlled panels isolate this passive; World computes attributes, selection and both hits.
  const conditions=new CombatConditions(),hits:{sourceId:string;hand:AttackContact['hand'];hit:PhysicalHit}[]=[];
  const ranks:Record<MemberId,number>={player:1,ally:8,target:0};
  const equipment:Record<MemberId,Record<string,string>>={player:{},ally:{},target:{}};
  const entries=new Map<string,ItemInstance>();
  let bagRevision=0;
  const item=(kind:string)=>Object.keys(items.items).find(id=>items.items[id].kind===kind&&items.items[id].equipment)!;
  const equip=(id:MemberId,slot:'main-hand'|'off-hand'|'body',kind:string|undefined,power=0)=>{
    bagRevision++;
    if(!kind){delete equipment[id][slot];return;}
    const key=`${id}:${slot}`;equipment[id][slot]=key;
    entries.set(key,{id:key,item:item(kind),enhancement:0,numbers:{baseAttack:power,modifiers:[],gemModifiers:[]}} as unknown as ItemInstance);
  };
  for(const id of ['player','ally'] as const){equip(id,'main-hand','longsword',60);equip(id,'off-hand','dagger',40);equip(id,'body','leather');}
  const bag={get revision(){return bagRevision;},equipmentFor:(id:MemberId)=>equipment[id],get:(id:string)=>entries.get(id),
    equipmentItems:(value:Record<string,string>)=>Object.fromEntries(Object.entries(value).map(([slot,id])=>[slot,entries.get(id)!.item]))};
  const configuration=(id:MemberId)=>({get version(){return ranks[id];},draft:()=>({levels:{'twin-blade':ranks[id]}})});
  const member=(id:MemberId)=>({classId:id==='target'?'dark-knight':'assassin',level:10,catalog:stats,bag,skills:configuration(id),
    panel:{level:10,physicalAttack:101,magicAttack:50,baseDefense:0,defense:0,defenseRate:0,maxHealth:1000,maxMana:100,
      hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:500,
      criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,baseMagicResistance:0,magicResistance:0,
      attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}},
    player:{health:1000,maxHealth:1000,mana:100,maxMana:100}});
  const members={player:member('player'),ally:member('ally'),target:member('target')};
  const host=Object.setPrototypeOf({hero:members.player,conditions,hitResolution:new CombatHitResolution(),arena:[],allies:[],
    fallen:new Set(),pendingDefeats:new Set(),passivesCache:new Map(),skillTableCache:new Map(),
    equipmentEffectsCache:new Map(),aiSkillCostCache:new Map(),
    app:{battleCatalog:catalog,items,wardrobe,characterStats:stats,
      session:{skills:configuration('player'),party:{activeIds:['player','ally'],controlledId:'player',groupModifiers:()=>({})}}},
    memberOf:(id:string)=>members[id as MemberId],visualOf:()=>undefined,
    combatant:(id:string)=>members[id as MemberId]?{id,team:id==='target'?'enemy':'party',position:{x:0,y:0},bounds:{x:0,y:0,width:8,height:8}}:undefined,
    equipmentRecovery:()=>({lifeDrainPerThousand:0,manaRecoveryPerPulse:0,manaCostReductionRate:0}),
    settleHit:(event:AttackContact,hit:PhysicalHit)=>hits.push({sourceId:event.casterId,hand:event.hand,hit}),
    scene:{events:{emit:()=>{}}},showHit:()=>{},dropMana:()=>{},attackProc:()=>{},
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>Reflect.get(WorldCombat.prototype,name).call(host,...args);
  const clips=Object.fromEntries(['dagger:dagger','longsword:dagger'].flatMap(stance=>
    Object.entries(wardrobe.stances[stance]).map(([name,key])=>[name,{frames:wardrobe.poses[key!].frames.length}])));
  const actor={id:'assassin-fixture',clips} as unknown as ActorDefinition;
  const normal=resolveBasicAttack({basicAttacks:{normal:wardrobe.attacks['longsword:dagger']}},
    {actor,basicAttack:{profileId:'normal',clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'}}});
  const select=(id:MemberId='player')=>call('selectBasicAttack',id,actor,normal) as ResolvedBasicAttack;
  const attribute=(id:MemberId,key:string)=>call('actorAttribute',id,key) as number;
  const contact=(sourceId:MemberId,profile:ResolvedBasicAttack,hand:'main-hand'|'offhand')=>
    call('attackContact',{casterId:sourceId,targetId:'target',basicAttack:profile,hand});
  return {host,conditions,hits,ranks,members,equipment,entries,equip,call,select,attribute,contact,normal};
}

test('all eight Twin Blade ranks use the owning member’s learned values in real party attributes',()=>{
  const f=fixture();
  for(const owner of ['player','ally'] as const){
    const other=owner==='player'?'ally':'player';f.ranks[other]=0;
    for(let rank=1;rank<=8;rank++){
      f.ranks[owner]=rank;
      assert.equal(f.attribute(owner,'offhandAttackChance'),190+(owner==='player'?chanceBonuses:companionChanceBonuses)[rank-1]);
      assert.equal(f.attribute(owner,'criticalDamage'),500+(owner==='player'?criticalBonuses:companionCriticalBonuses)[rank-1]);
      assert.equal(f.attribute(other,'offhandAttackChance'),190);
      assert.equal(f.attribute(other,'criticalDamage'),500);
    }
  }
});

test('the critical bonus follows only the main weapon while offhand chance remains unconditional',()=>{
  const f=fixture();f.ranks.player=8;
  for(const main of ['dagger','longsword','axe','mace',undefined]){
    f.equip('player','main-hand',main,60);
    for(const offhand of main?['dagger','longsword','shield',undefined]:[undefined]){
      f.equip('player','off-hand',offhand,40);
      assert.equal(f.attribute('player','criticalDamage'),500+(['dagger','longsword'].includes(main??'')?401:0));
      const weaponChance=offhand==='dagger'?140:offhand==='longsword'?100:0;
      assert.equal(f.attribute('player','offhandAttackChance'),weaponChance+50+160);
    }
  }
  f.equip('player','body',undefined);
  assert.equal(f.attribute('player','offhandAttackChance'),160);
  assert.equal(f.attribute('player','criticalDamage'),500,'empty main has no default sword fallback');
});

test('real dual selection rolls once before the live chance and rejects an equal threshold for every rank',t=>{
  const f=fixture(),order:string[]=[];let roll=1;
  t.mock.method(Math,'random',()=>{order.push('roll');return (roll-.5)/999;});
  const original=f.host.actorAttribute.bind(f.host);
  f.host.actorAttribute=(id:string,key:string)=>{if(key==='offhandAttackChance')order.push(`chance:${id}`);return original(id,key);};
  for(const owner of ['player','ally'] as const)for(let rank=1;rank<=8;rank++){
    f.ranks[owner]=rank;const threshold=190+(owner==='player'?chanceBonuses:companionChanceBonuses)[rank-1];
    roll=threshold;order.length=0;assert.equal(f.select(owner),f.normal);assert.deepEqual(order,['roll',`chance:${owner}`]);
    roll=threshold-1;order.length=0;const selected=f.select(owner);
    assert.deepEqual(selected.strikes,[{frame:2,hand:'main-hand'},{frame:5,hand:'offhand'}]);
    assert.deepEqual(order,['roll',`chance:${owner}`]);
  }
  f.ranks.player=1;order.length=0;
  t.mock.method(Math,'random',()=>{order.push('roll');f.ranks.player=8;return (300-.5)/999;});
  assert.notEqual(f.select(),f.normal,'the rank changed by the draw is read after that draw');
  assert.deepEqual(order,['roll','chance:player']);
});

test('positive learned chance cannot replace the requirement for a real offhand weapon',t=>{
  const f=fixture();f.ranks.player=8;
  t.mock.method(Math,'random',()=>assert.fail('no offhand weapon means no dual-wield roll'));
  for(const offhand of [undefined,'shield']){
    f.equip('player','off-hand',offhand);
    assert.equal(f.attribute('player','offhandAttackChance'),210);
    assert.equal(f.select(),f.normal);
  }
});

test('both selected hands apply their own raw attack and the additive critical bonus exactly once',t=>{
  const f=fixture();t.mock.method(Math,'random',()=>0);
  for(const owner of ['player','ally'] as const){
    f.members[owner].panel.criticalRate=1000;
    for(let rank=1;rank<=8;rank++){
      f.ranks[owner]=rank;const selected=f.select(owner);f.hits.length=0;
      f.contact(owner,selected,'main-hand');f.contact(owner,selected,'offhand');
      const criticalRate=1500+(owner==='player'?criticalBonuses:companionCriticalBonuses)[rank-1];
      assert.deepEqual(f.hits,[
        {sourceId:owner,hand:'main-hand',hit:{kind:'critical',damage:Math.trunc(101*criticalRate/1000)}},
        {sourceId:owner,hand:'offhand',hit:{kind:'critical',damage:Math.trunc(60*criticalRate/1000)}},
      ]);
    }
  }
  f.ranks.player=1;f.conditions.setTemporaryAttribute('player','physicalDamageRate',500);
  f.members.target.panel.criticalDamageResistance=125;f.hits.length=0;
  const selected=f.select();f.contact('player',selected,'main-hand');f.contact('player',selected,'offhand');
  assert.deepEqual(f.hits.map(entry=>entry.hit),[{kind:'critical',damage:207},{kind:'critical',damage:123}],
    'damage-rate truncation precedes critical bonus, then target critical resistance truncates again');
});

test('the second hand reads current learned critical damage and noncritical attacks do not consume the bonus',t=>{
  const f=fixture();t.mock.method(Math,'random',()=>0);f.members.player.panel.criticalRate=1000;
  const selected=f.select();f.contact('player',selected,'main-hand');f.ranks.player=8;f.contact('player',selected,'offhand');
  assert.deepEqual(f.hits.map(entry=>entry.hit),[{kind:'critical',damage:159},{kind:'critical',damage:114}]);
  f.members.player.panel.criticalRate=0;f.hits.length=0;
  f.contact('player',selected,'main-hand');f.contact('player',selected,'offhand');
  assert.deepEqual(f.hits.map(entry=>entry.hit),[{kind:'hit',damage:101},{kind:'hit',damage:60}]);
  assert.equal(f.attribute('player','criticalDamage'),901);
});
