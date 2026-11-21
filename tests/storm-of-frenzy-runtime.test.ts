import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,ResolvedBasicAttack} from '../src/domain/battle.ts';
import type {ActorDefinition} from '../src/domain/content.ts';
import type {ItemCatalog,ItemInstance} from '../src/domain/items.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
import type {AttackContact} from '../src/domain/combat.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const read=(file:string)=>JSON.parse(readFileSync(new URL(`../public/content/${file}.json`,import.meta.url),'utf8'));
const catalog=read('battle') as BattleCatalog,items=read('items') as ItemCatalog,wardrobe=read('wardrobe') as WardrobeCatalog;
const action=catalog.skills['storm-of-frenzy'].action!;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
function fixture(){
  const conditions=new CombatConditions(),hitResolution=new CombatHitResolution(),order:string[]=[],hits:number[]=[];
  const item=(kind:string)=>Object.keys(items.items).find(key=>items.items[key].kind===kind&&items.items[key].equipment)!;
  const main=item('longsword'),offhand=item('dagger'),body=item('leather');
  const entries=new Map<string,ItemInstance>([
    ['main',{id:'main',item:main,enhancement:0,numbers:{baseAttack:60,modifiers:[],gemModifiers:[]}} as unknown as ItemInstance],
    ['offhand',{id:'offhand',item:offhand,enhancement:0,numbers:{baseAttack:40,modifiers:[],gemModifiers:[]}} as unknown as ItemInstance],
    ['body',{id:'body',item:body,enhancement:0} as ItemInstance],
  ]);
  const equipment:Record<string,string>={'main-hand':'main','off-hand':'offhand',body:'body'};
  const bag={revision:0,equipmentFor:()=>equipment,get:(id:string)=>entries.get(id),
    equipmentItems:(keys:Record<string,string>)=>Object.fromEntries(Object.entries(keys).map(([slot,id])=>[slot,entries.get(id)!.item]))};
  const base={level:10,physicalAttack:100,magicAttack:50,baseDefense:0,defense:0,defenseRate:0,maxHealth:1000,maxMana:100,
    hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,
    criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0,
    attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}};
  let learned=1;
  const skills={draft:()=>({levels:{'storm-of-frenzy':learned,'blood-thirst':1}})};
  const member=(classId='warrior')=>({classId,level:10,panel:{...base},catalog:read('character-stats'),bag,skills,player:{health:500,maxHealth:1000,mana:100,maxMana:100},
    setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number){this.player[key]=value;},
    setHealth(value:number){this.player.health=Math.min(1000,value);order.push(`heal:${value}`);},setMana:()=>{}});
  const player=member(),target=member('dark-knight'),near=member(),far=member(),fourth=member();
  const members=new Map([['player',player],['target',target],['near',near],['far',far],['fourth',fourth]]);
  const ids=['player','near','far','fourth'];
  const host=Object.setPrototypeOf({hero:player,app:{battleCatalog:catalog,items,wardrobe,characterStats:read('character-stats'),
    session:{skills,party:{activeIds:ids,controlledId:'player'}}},conditions,hitResolution,fallen:new Set(),pendingDefeats:new Set(),arena:[],allies:[],
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    roster:{isPresent:()=>true},
    scene:{events:{emit:()=>{}}},memberOf:(id:string)=>members.get(id),partyPassives:()=>[],syncCombatResourceLimits:()=>{},applyStateConsequences:()=>{},
    equipmentRecovery:()=>({lifeDrainPerThousand:0}),showBuffApplication:()=>assert.fail('these buffs have no application effect'),
    presenter:{showEffects:(_id:string,effects:{effect:string}[])=>effects.forEach(effect=>order.push(effect.effect))},
    settleHit:(_event:AttackContact,hit:PhysicalHit)=>{hits.push(hit.damage);order.push(`damage:${hit.damage}`);},
    showHit:()=>{},dropMana:()=>{},attackProc:()=>{},visualOf:()=>undefined,
    combatant:(id:string)=>members.has(id)?{id,team:id==='target'?'enemy':'party',position:{x:id==='far'?9999:0,y:0},bounds:{x:0,y:0,width:8,height:8}}:undefined,
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const cast=(level=1)=>call('skillUnit',{casterId:'player',targetId:'player',cueIndex:0,skill:{id:'storm-of-frenzy',action,level}});
  const contact=(kind:PhysicalHit['kind']='hit',damageKind:'physical'|'magic'='physical',damage=0)=>
    call('resolveHitReactions',{casterId:'player',targetId:'target'},{kind,damage},damageKind,'basic-attack',player);
  const stances=wardrobe.stances['longsword:dagger'];
  const actor={id:'test',clips:Object.fromEntries(Object.entries(stances).map(([name,key])=>[name,{frames:wardrobe.poses[key!].frames.length}]))} as unknown as ActorDefinition;
  const normal=resolveBasicAttack({basicAttacks:{normal:wardrobe.attacks['longsword:dagger']}},
    {actor,basicAttack:{profileId:'normal',clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'}}});
  const select=()=>call('selectBasicAttack','player',actor,normal) as ResolvedBasicAttack;
  return {host,conditions,hitResolution,player,target,near,far,ids,order,hits,equipment,entries,call,cast,contact,select,normal,actor,
    learn:(rank:number)=>{learned=rank;}};
}

test('the parent gives the first three active party slots independent children at any distance without requiring visuals',()=>{
  const f=fixture();f.cast(1);f.learn(8);f.host.visualOf=()=>undefined;f.contact();
  for(const id of ['player','near','far']){
    const buff=f.conditions.snapshot(id).find(buff=>buff.id==='storm-of-frenzy-power')!;
    assert.ok(buff,id);assert.equal(buff.sourceId,'player');assert.equal(buff.strength,4003);
    assert.equal(f.call('actorAttribute',id,'physicalDamageRate'),80);assert.equal(f.call('actorAttribute',id,'magicDamageRate'),80);
  }
  assert.equal(f.conditions.hasBuff('fourth','storm-of-frenzy-power'),false);
  assert.equal(f.conditions.hasBuff('target','storm-of-frenzy-power'),false);
});

test('only physical successes grant stacks and immediate repeated zero-damage hits reach the five-layer cap',()=>{
  for(const damageKind of ['physical','magic'] as const)for(const outcome of ['hit','critical','weapon-block','shield-block','miss'] as const){
    const f=fixture();f.cast();for(let hit=0;hit<7;hit++)f.contact(outcome,damageKind,0);
    assert.equal(f.call('actorAttribute','near','physicalDamageRate'),damageKind==='physical'&&outcome!=='miss'?400:0);
  }
});

test('party eligibility keeps pending zero-HP slots, excludes formal defeats, and does not replace them with later slots',()=>{
  const f=fixture();f.cast();f.near.player.health=0;f.far.player.health=0;
  f.host.fallen.add('far');f.hitResolution.run(()=>{
    f.hitResolution.deferDefeat('near',()=>{});f.contact();
    assert.equal(f.conditions.hasBuff('near','storm-of-frenzy-power'),true);
    assert.equal(f.conditions.hasBuff('far','storm-of-frenzy-power'),false);
    assert.equal(f.conditions.hasBuff('fourth','storm-of-frenzy-power'),false);
  });
});

test('Blood Thirst completes before the party reaction and reflection observes the newly added layer',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.cast();
  const blood=catalog.skills['blood-thirst'].action!;
  f.call('skillUnit',{casterId:'player',targetId:'player',cueIndex:0,skill:{id:'blood-thirst',level:1,action:blood}});
  const apply=f.host.applyActorBuff.bind(f.host);
  f.host.applyActorBuff=(...args:unknown[])=>{if(args[1]==='storm-of-frenzy-power')f.order.push(`stack:${args[0]}`);return apply(...args);};
  f.conditions.setTemporaryAttribute('target','moltenReflectionPerThousand',100);
  f.host.moltenReflection=()=>f.order.push(`reflection:${f.call('actorAttribute','player','physicalDamageRate')}`);
  f.contact('hit','physical',100);
  assert.deepEqual(f.order,['heal:522','life-drain','stack:player','stack:near','stack:far','reflection:80']);
});

test('offhand selection uses real offhand equipment plus the active parent and fixes the dedicated two-hit profile',t=>{
  const f=fixture();assert.equal(f.call('actorAttribute','player','offhandAttackChance'),190);
  f.cast();assert.equal(f.call('actorAttribute','player','offhandAttackChance'),340);
  const order:string[]=[];t.mock.method(Math,'random',()=>{order.push('roll');return 0;});
  const original=f.host.actorAttribute.bind(f.host);
  f.host.actorAttribute=(id:string,key:string)=>{if(key==='offhandAttackChance')order.push('chance');return original(id,key);};
  const selected=f.select();assert.deepEqual(order,['roll','chance']);
  assert.deepEqual(selected.strikes,[{frame:2,hand:'main-hand'},{frame:5,hand:'offhand'}]);
  assert.equal(selected.clips.east,'dual-attack-east');assert.equal(selected.strikeFrame,2);
  delete f.equipment['off-hand'];order.length=0;assert.equal(f.select(),f.normal);assert.deepEqual(order,[]);
});

test('main and offhand contacts use their live weapon powers and apply the damage multiplier once',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture(),profile=f.select();f.conditions.setTemporaryAttribute('player','physicalDamageRate',500);
  f.call('attackContact',{casterId:'player',targetId:'target',basicAttack:profile,hand:'main-hand'});
  f.call('attackContact',{casterId:'player',targetId:'target',basicAttack:profile,hand:'offhand'});
  assert.deepEqual(f.hits,[150,90]);
  f.entries.get('offhand')!.numbers!.baseAttack=50;
  f.call('attackContact',{casterId:'player',targetId:'target',basicAttack:profile,hand:'offhand'});
  assert.equal(f.hits.at(-1),105);
});

test('the first hit grants a damage layer for the offhand hit while preserving its already calculated damage',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.cast();const profile=f.select();
  f.call('attackContact',{casterId:'player',targetId:'target',basicAttack:profile,hand:'main-hand'});
  f.call('attackContact',{casterId:'player',targetId:'target',basicAttack:profile,hand:'offhand'});
  assert.deepEqual(f.hits,[100,64]);assert.equal(f.call('actorAttribute','player','physicalDamageRate'),160);
});

test('immune targets receive zero feedback before either basic hand can roll or grant physical success reactions',t=>{
  const f=fixture();f.cast();t.mock.method(Math,'random',()=>0);const profile=f.select();
  f.host.memberOf=(id:string)=>id==='player'?f.player:undefined;
  f.host.arena=[{key:'target',definition:catalog.enemies[0]}];
  f.conditions.applyBuff('target','guardian-of-darkness',1,{durationMs:1000,tickMs:0,states:['damage-immune'],modifiers:[],periodic:[]});
  const feedback:PhysicalHit[]=[];f.host.showHit=(_event:AttackContact,hit:PhysicalHit)=>feedback.push(hit);
  t.mock.method(Math,'random',()=>assert.fail('hit and reaction rolls must occur after the immunity gate'));
  for(const extra of [{},{basicAttack:profile,hand:'main-hand'},{basicAttack:profile,hand:'offhand'}])
    f.call('attackContact',{casterId:'player',targetId:'target',...extra});
  assert.deepEqual(feedback,Array.from({length:3},()=>({kind:'hit',damage:0})));
  assert.deepEqual(f.hits,[]);assert.equal(f.conditions.hasBuff('player','storm-of-frenzy-power'),false);
});

test('exported companion actors can select both real dual-wield variants without a costume renderer',t=>{
  t.mock.method(Math,'random',()=>0);
  const actors=Object.values(read('world').actors) as ActorDefinition[];
  const companions=actors.filter(actor=>actor.clips['dual-attack-north']);
  assert.ok(companions.length>0);
  const f=fixture(),dagger=Object.keys(items.items).find(key=>items.items[key].kind==='dagger'&&items.items[key].equipment)!;
  const sword=f.entries.get('main')!.item;
  for(const actor of companions)for(const [item,clip,frames] of [[sword,'dual-attack-north',7],[dagger,'dual-quick-attack-north',5]] as const){
    f.entries.get('main')!.item=item;
    const selected=f.call('selectBasicAttack','player',actor,f.normal) as ResolvedBasicAttack;
    assert.notEqual(selected,f.normal,actor.id);assert.equal(selected.clips.north,clip,actor.id);
    assert.equal(actor.clips[selected.clips.north]!.frames,frames,actor.id);
  }
});
