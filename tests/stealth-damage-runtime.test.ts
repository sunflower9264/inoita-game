import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BasicAttackDefinition,BattleBuffEffect,BattleCatalog,NumericCombatUnit,ResolvedBasicAttack,SkillAction} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import type {AttackContact,Combatant,SkillUnitHit} from '../src/domain/combat.ts';
import type {CombatActorAttributes} from '../src/domain/combat-damage-source.ts';
import type {PhysicalFighter,PhysicalHit} from '../src/domain/physical-hit.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const wardrobe=JSON.parse(readFileSync(new URL('../public/content/wardrobe.json',import.meta.url),'utf8')) as {
  dualWieldAttacks:Record<string,BasicAttackDefinition>;
};
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const base={level:10,physicalAttack:100,magicAttack:0,baseDefense:0,defense:0,defenseRate:0,
  maxHealth:10000,maxMana:100,hitBase:100,hitBonus:0,evasionBase:0,evasionBonus:0,
  criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,
  physicalResistance:0,physicalResistanceBonus:0,magicResistance:0,baseMagicResistance:0,attributes:primary};

// Complete controlled source, independent of the still-unreviewed Whist content.
const stealthEffect=(enabled=1,rate=736):BattleBuffEffect=>({
  durationMs:5460,tickMs:0,simulationFrames:{lastActiveFrame:90},maxStacks:1,
  states:['stealthed'],stateDurationProfiles:{stealthed:{normal:{lastActiveFrame:135}}},periodic:[],
  modifiers:[{attribute:'stealthAttackEnabled',operation:{kind:'set',amount:enabled}},
    {attribute:'stealthDamageRate',operation:{kind:'add',amount:rate}}],
});
function damageAction(effect:'physical'|'magic'='physical',source:NumericCombatUnit['source']='none',amount=100,skill=true):SkillAction {
  return {usesSkillDamageBuff:skill,events:[],cooldownFrames:0,approachDistanceUnits:4,searchRadiusPx:64,transition:null,
    combatUnits:[{effect,source,attributeWeights:{...primary},ranks:[{fixedAddition:amount,operation:{kind:'keep'}}]}]};
}
function resolved(definition:BasicAttackDefinition):ResolvedBasicAttack {
  return {...definition,effectiveCycleFrames:definition.cycleFrames,
    clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'},
    sequence:{north:[],south:[],east:[],west:[]}};
}
function fixture(){
  const member=(physicalAttack:number,magicAttack:number)=>({classId:'warrior',level:10,
    panel:{...structuredClone(base),physicalAttack,magicAttack},player:{health:10000,maxHealth:10000,mana:100,maxMana:100},
    bag:{equipmentFor:()=>({}),get:()=>undefined}});
  const player=member(100,0),ally=member(40,90),members=new Map([['player',player],['ally',ally]]);
  const stats=new Map([['monster',{...structuredClone(base),physicalAttack:70,magicAttack:60,health:10000,mana:100}],
    ['target',{...structuredClone(base),health:10000,mana:100}]]);
  const actors=new Map([...members.keys(),...stats.keys()].map((id,index):[string,Combatant]=>[id,
    {id,team:members.has(id)?'party':'enemy',position:{x:index*8,y:0},bounds:{x:-4,y:-4,width:8,height:8}}]));
  const conditions=new CombatConditions(),hits:{event:AttackContact;hit:PhysicalHit}[]=[],order:string[]=[];
  const host=Object.setPrototypeOf({hero:player,conditions,hitResolution:new CombatHitResolution(),
    pendingDefeats:new Set<string>(),fallen:new Set<string>(),allies:[],
    arena:[...stats.keys()].map(key=>({key,definition:catalog.enemies[0]})),
    app:{battleCatalog:catalog,session:{party:{controlledId:'player'}},audio:{effect:(name:string)=>order.push(`sound:${name}`)}},
    scene:{events:{emit:()=>{}}},memberOf:(id:string)=>members.get(id),partyPassives:()=>[],
    roster:{enemySnapshot:(id:string)=>stats.get(id)},combatant:(id:string)=>actors.get(id),visualOf:()=>undefined,
    resolveHitReactions:()=>{},dropMana:()=>{},react:()=>order.push('stealth-break'),
    settleHit:(event:AttackContact,hit:PhysicalHit)=>{hits.push({event,hit});order.push(`hit:${hit.damage}`);},
    showHit:(event:AttackContact,hit:PhysicalHit)=>{hits.push({event,hit});order.push(`immune:${hit.damage}`);},
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const event=(casterId='player',action=damageAction()):SkillUnitHit=>({casterId,targetId:casterId==='monster'?'player':'target',
    cueIndex:0,skill:{id:'stealth-consumer-probe',level:1,action}});
  const strike=(casterId='player',action=damageAction())=>{call('skillUnit',event(casterId,action));return hits.at(-1)!.hit;};
  const buff=(id='player',enabled=1,rate=736)=>conditions.applyBuff(id,'whist',1,stealthEffect(enabled,rate),id);
  const fighter=(id:string):PhysicalFighter=>members.has(id)?call('partyFighter',id):call('enemyFighter',id,catalog.enemies[0],10);
  return {host,call,conditions,hits,order,player,ally,stats,actors,event,strike,buff,fighter,
    attributes:(id:string)=>call('actorAttributes',id) as CombatActorAttributes};
}

test('member, companion and monster consumers use their own complete stealth source and raw attacks',t=>{
  t.mock.method(Math,'random',()=>0.8);const f=fixture();
  for(const [id,rate,rawPhysical,rawMagic,normalPhysical,skillDamage] of [
    ['player',736,100,0,173,190],['ally',500,40,90,60,75],['monster',1000,70,60,140,160],
  ] as const){
    f.buff(id,1,rate);const attributes=f.attributes(id),fighter=f.fighter(id);
    assert.equal(attributes.physicalAttack,rawPhysical,id);assert.equal(attributes.magicAttack,rawMagic,id);
    assert.equal(attributes.stealthDamageRate,rate,id);assert.equal(fighter.physicalAttack,normalPhysical,id);
    assert.equal(fighter.stealthAttackEnabled,true,id);assert.equal(fighter.stealthDamageRate,rate,id);
    assert.equal(f.strike(id,damageAction('physical','none',10)).damage,skillDamage,id);
  }
  assert.equal(f.call('actorAttribute','ally','bestNormalDamage'),90,'the companion keeps its stronger magic candidate');
  assert.equal(f.call('actorAttribute','monster','bestNormalDamage'),140);
});

test('the attribute gate is independent of state and rate, and skill terms truncate before either block',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const stateOnly=fixture();stateOnly.conditions.applyState('player','stealthed',10000);
  assert.equal(stateOnly.strike().damage,100);assert.equal(stateOnly.attributes('player').stealthDamageRate,0);
  const disabled=fixture();disabled.buff('player',0,736);
  assert.equal(disabled.strike().damage,100);assert.equal(disabled.attributes('player').stealthDamageRate,0);
  const zeroRate=fixture();zeroRate.buff('player',1,0);assert.equal(zeroRate.strike().damage,200);
  const stateExpired=fixture(),shortState=stealthEffect();
  shortState.stateDurationProfiles={stealthed:{normal:{lastActiveFrame:0}}};
  stateExpired.conditions.applyBuff('player','whist',1,shortState);stateExpired.conditions.update(120);
  assert.equal(stateExpired.conditions.hasState('player','stealthed'),false);
  assert.equal(stateExpired.conditions.hasBuff('player','whist'),true);
  assert.equal(stateExpired.strike().damage,346,'a natural state expiry does not negate the remaining attribute source');
  const f=fixture();f.player.panel.physicalAttack=101;f.buff();
  f.conditions.setTemporaryAttribute('player','physicalDamageRate',137);
  assert.equal(f.strike('player',damageAction('physical','none',104)).damage,369);
  f.stats.get('target')!.weaponBlock=300;
  assert.deepEqual(f.strike('player',damageAction('physical','none',104)),{kind:'weapon-block',damage:258});
  f.stats.get('target')!.weaponBlock=0;f.stats.get('target')!.shieldBlock=300;
  assert.deepEqual(f.strike('player',damageAction('physical','none',104)),{kind:'shield-block',damage:111});
});

test('MISS and damage immunity skip the extra raw-attack read, while a successful skill reads it after the hit die',t=>{
  let rolls=0;const f=fixture();f.buff();let reads=0;
  f.host.actorAttribute=(id:string,key:string)=>{if(id==='player'&&key==='physicalAttack')reads++;return f.call('actorAttribute',id,key);};
  t.mock.method(Math,'random',()=>{rolls++;f.conditions.setTemporaryAttribute('player','physicalAttack',200);return 0.2;});
  f.stats.get('target')!.evasionBonus=750;
  assert.deepEqual(f.strike(),{kind:'miss',damage:0});assert.equal(reads,0);assert.equal(rolls,1);
  f.conditions.applyState('target','damage-immune',10000);f.strike();assert.equal(reads,0);assert.equal(rolls,1);
  f.conditions.removeState('target','damage-immune');f.stats.get('target')!.evasionBonus=0;
  f.conditions.clearTemporaryAttribute('player','physicalAttack');
  assert.equal(f.strike().damage,520,'D1 uses its fixed 100 base; D2 reads 200 after the hit roll');
  assert.equal(reads,1);assert.equal(rolls,2);
});

test('actual normal and dual profiles receive ordinary stealth scaling without the extra skill term or skill-buff consumption',t=>{
  t.mock.method(Math,'random',()=>0.8);const f=fixture();f.buff();
  const bonus=catalog.skills['dark-strike'].action!.combatUnits!.find(unit=>unit.effect==='buff');assert.equal(bonus?.effect,'buff');
  if(bonus?.effect!=='buff')throw new Error('missing skill damage buff');
  f.conditions.applyBuff('player',bonus.buff,bonus.ranks[0].strength,bonus.ranks[0].effect);
  const ordinary=resolved(catalog.basicAttacks['longsword-slash']);
  const dual=resolved(wardrobe.dualWieldAttacks['dagger:dagger']);
  f.call('attackContact',{casterId:'player',targetId:'target',basicAttack:ordinary});
  f.call('attackContact',{casterId:'player',targetId:'target',basicAttack:dual,hand:'main-hand'});
  f.call('attackContact',{casterId:'player',targetId:'target',basicAttack:dual,hand:'offhand'});
  // With no weapon contributions in this fixture, the offhand uses half of raw P: 50 × 1736 / 1000.
  assert.deepEqual(f.hits.map(value=>value.hit.damage),[300,173,86]);
  assert.equal(f.conditions.hasBuff('player','dark-strike'),true);
});

test('magic sourced from best normal damage benefits indirectly while raw magic and the magic hit multiplier stay unchanged',t=>{
  t.mock.method(Math,'random',()=>0.8);const f=fixture();f.player.panel.magicAttack=160;
  assert.equal(f.strike('player',damageAction('magic','bestNormalDamage',0)).damage,160);
  f.buff();assert.equal(f.call('actorAttribute','player','bestNormalDamage'),173);
  assert.equal(f.strike('player',damageAction('magic','bestNormalDamage',0)).damage,173);
  assert.equal(f.strike('player',damageAction('magic','magicAttack',0)).damage,160);
  f.conditions.setTemporaryAttribute('player','magicDamageRate',100);
  assert.equal(f.strike('player',damageAction('magic','magicAttack',0)).damage,176);
});

test('each target reads its own current source attack, then dispatch removes the complete owner buff before the next dispatch',t=>{
  t.mock.method(Math,'random',()=>0.8);const f=fixture();f.buff();const action=damageAction(),event=f.event('player',action);
  const prepared=f.call('prepareSkillUnit',event);
  f.host.resolveHitReactions=()=>f.conditions.setTemporaryAttribute('player','physicalAttack',200);
  const playback={caster:f.actors.get('player')!,facing:'east',basicAttack:null,skill:event.skill};
  f.call('runActionDispatch',playback,{breaksStealth:true,sound:'dispatch-tail'},()=>{
    f.call('skillUnit',{...event,preparedDamage:prepared});
    f.call('skillUnit',{...event,targetId:'monster',preparedDamage:prepared});
    assert.equal(f.conditions.hasBuff('player','whist'),true);
  });
  assert.deepEqual(f.order,['hit:346','hit:520','stealth-break','sound:dispatch-tail']);
  assert.equal(f.conditions.hasState('player','stealthed'),false);assert.equal(f.conditions.hasBuff('player','whist'),false);
  assert.equal(f.attributes('player').stealthDamageRate,0);assert.equal(f.fighter('player').stealthAttackEnabled,false);
  f.conditions.clearTemporaryAttribute('player','physicalAttack');
  assert.equal(f.strike().damage,100);
  const expiry=fixture();expiry.buff();expiry.conditions.update(91*60);
  assert.equal(expiry.strike().damage,346);expiry.conditions.update(60);
  assert.equal(expiry.conditions.hasState('player','stealthed'),false);assert.equal(expiry.strike().damage,100);
});
