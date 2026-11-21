import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import type {SkillReactionEvent} from '../src/domain/skill-reactions.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
phaser.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

test('host keeps physical block, attacker success and defender receipt in native order',()=>{
  const phases:string[]=[];
  const host={reactToBuff:()=>{},react:(event:SkillReactionEvent)=>phases.push(`${event.kind}:${event.ownerId}`),partySide:()=>false,summonOwnerReactions:()=>{},disturbanceReaction:()=>{},
    physicalSuccessEquipmentProcs:()=>{},instantRecoveryOnMiss:()=>{},
    holySacrificeTransfer:method('holySacrificeTransfer'),lightningOfHellReaction:method('lightningOfHellReaction'),
    app:{},memberOf:()=>undefined,
    actorAttribute:()=>0,attackProc:()=>phases.push('attribute-effects'),equipmentRecovery:()=>({lifeDrainPerThousand:0}),conditions:{activeBuffReactions:()=>[],hasBuff:()=>false,removeState:()=>phases.push('wake')}};
  for(const outcome of ['weapon-block','shield-block'] as const){
    phases.length=0;
    method('resolveHitReactions').call(host,{casterId:'ally',targetId:'enemy'},{kind:outcome,damage:12},'physical','basic-attack',{});
    // 普攻不发 skill-attack-success；技能才发（见下面那两条魔法用例）。
    assert.deepEqual(phases,['physical-block:enemy','attack-success:ally','physical-flare:ally','attack-effects:ally','physical-hit-received:enemy','wake','attribute-effects']);
  }
  for(const [damageKind,kind] of [['physical','miss'],['magic','shield-block']] as const){
    phases.length=0;
    method('resolveHitReactions').call(host,{casterId:'ally',targetId:'enemy'},{kind,damage:0},damageKind,'firestorm',{});
    assert.deepEqual(phases,[]);
  }
  method('resolveHitReactions').call(host,{casterId:'ally',targetId:'enemy'},{kind:'critical',damage:12},'magic','firestorm',{});
  assert.deepEqual(phases,['skill-attack-success:ally','attack-success:ally','attack-effects:ally','wake','attribute-effects']);
});

test('soul sword reuses dark strike strength and reads the casting companion loadout',()=>{
  const data=structuredClone(catalog),conditions=new CombatConditions(),effects:string[]=[];
  data.skills['soul-sword'].companion!.reactionsByRank=data.skills['soul-sword'].ranks.map(()=>[{kind:'soul-sword',chanceThreshold:1000,
    buffFromLearnedSkill:'dark-strike',physicalEffects:['soul-sword'],magicEffects:['soul-sword-magic','soul-sword']}]);
  let rank=1;
  const classId=data.classes.find(character=>character.skills.includes('soul-sword'))!.id;
  const companion={classId,skills:{get version(){return rank;},draft:()=>({levels:{'soul-sword':1,'dark-strike':rank}})}};
  const host=Object.setPrototypeOf({app:{battleCatalog:data},conditions,arena:[],memberOf:(id:string)=>id==='ally'?companion:undefined,
    presenterFor:()=>({showEffects:(_id:string,list:{effect:string}[])=>effects.push(...list.map(entry=>entry.effect))}),
    syncCombatResourceLimits:()=>{},interruptDisabled:()=>{},applyStateConsequences:()=>{}},WorldCombat.prototype);
  const event={kind:'attack-success',ownerId:'ally',opponentId:'enemy',damageKind:'physical',outcome:'hit',hitDamage:100,otherLifeDrainPerThousand:0};
  method('react').call(host,event);
  const unit=data.skills['dark-strike'].companion!.action!.combatUnits!.find(unit=>unit.effect==='buff')!;
  assert.equal(unit.effect,'buff');if(unit.effect!=='buff')return;
  // Buff 0 公式 1064：trunc((4000+(a+20*b)*10)/20)，佣兵 a=1，一级 b=2。
  assert.equal(conditions.attribute('ally','skillDamageBonus',0),220);
  rank=8;
  method('react').call(host,event);
  assert.equal(conditions.attribute('ally','skillDamageBonus',0),320,'佣兵八级 b=12');
  assert.equal(conditions.snapshot('ally').filter(condition=>condition.kind==='buff').length,1);
  assert.deepEqual(effects,['soul-sword','soul-sword']);
  assert.deepEqual(method('learnedReactionBuff').call(host,'ally','dark-strike'),{key:'dark-strike',rankPriority:unit.ranks[7].strength,effect:unit.ranks[7].effect});
});

test('basic attack resolves reaction healing before the fatal main damage is committed',()=>{
  const order:string[]=[];
  const fighter={level:1,physicalAttack:100,hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,
    criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0};
  const host={hero:{level:1},conditions:new CombatConditions(),arena:[],memberOf:()=>({}),partyFighter:()=>fighter,combatant:()=>({position:{x:0,y:0}}),actorAttribute:()=>0,rearPenetrationBonus:()=>0,
    isActorPresent:method('isActorPresent'),visualOf:()=>({actor:{}}),equipmentAttack:()=>catalog.basicAttacks[catalog.classes[0].basicAttack.profileId],
    actorAttributes:()=>({...fighter,magicAttack:0,maxHealth:1000,physicalDamageRate:0,magicDamageRate:0,stealthDamageRate:0,
      primaryAttributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}}),
    resolveHitReactions:()=>order.push('reactions'),settleHit:(_event:unknown,hit:PhysicalHit)=>{assert.ok(hit.damage>0);order.push('damage');},
    dropMana:()=>{},summonOwnerReactions:()=>{},scene:{events:{emit:()=>{}}},allies:[]};
  method('attackContact').call(host,{casterId:'player',targetId:'ally'});
  assert.deepEqual(order,['reactions','damage']);
});

test('blood sword combines the caster equipment rate and learned rank before healing',()=>{
  const data=structuredClone(catalog),classId=data.classes.find(character=>character.skills.includes('blood-sword'))!.id;
  const effects:string[]=[],conditions=new CombatConditions();
  const hero={classId,panel:{maxHealth:100,maxMana:0},player:{health:20,maxHealth:100,maxMana:0},setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number){this.player[key]=value;},setHealth(value:number){this.player.health=Math.min(value,100);},
    bag:{equipmentFor:()=>({'main-hand':'sword'}),get:()=>({numbers:{modifiers:[{stat:'lifeSteal',value:50}],gemModifiers:[]}})}};
  const host=Object.setPrototypeOf({app:{battleCatalog:data,session:{skills:{draft:()=>({levels:{'blood-sword':1}})}}},
    equipmentEffectsCache:new Map(),physicalSuccessEquipmentProcs:()=>{},
    memberOf:(id:string)=>id==='player'?hero:undefined,partyPassives:()=>[],conditions,hero,arena:[],
    presenterFor:()=>({showEffects:(_id:string,list:{effect:string}[])=>effects.push(...list.map(entry=>entry.effect))}),
    actorAttribute:()=>0,attackProc:()=>{},pendingDefeats:new Set()},WorldCombat.prototype);
  method('resolveHitReactions').call(host,{casterId:'player',targetId:'enemy'},{kind:'hit',damage:15},'physical','basic-attack',hero);
  const reaction=data.skills['blood-sword'].reactionsByRank![0].find(reaction=>reaction.kind==='blood-sword')!;
  assert.equal(reaction.kind,'blood-sword');if(reaction.kind!=='blood-sword')return;
  assert.equal(hero.player.health,20+Math.trunc(15*(50+reaction.lifeDrainPerThousand)/1000));
  assert.deepEqual(effects,['life-drain']);
  const before=hero.player.health;
  method('resolveHitReactions').call(host,{casterId:'player',targetId:'enemy'},{kind:'hit',damage:15},'magic','firestorm',hero);
  assert.equal(hero.player.health,before);assert.deepEqual(effects,['life-drain']);
});

test('attribute effects use the attacker class normal damage and require positive main damage',()=>{
  const damage:number[]=[],reads:string[]=[];
  let classId:string|null='warlock';
  const host={arena:[],memberOf:()=>classId?{classId}:undefined,partyPassives:()=>[],partyAttackProc:()=>{},
    actorAttributes:()=>({physicalAttack:100,magicAttack:200,physicalDamageRate:500,magicDamageRate:100,
      stealthDamageRate:0}),combatant:()=>({team:'party'}),
    actorAttribute:(_id:string,key:string)=>{reads.push(key);return key==='darknessStrikeChance'?1000:0;},
    app:{battleCatalog:{statusAttackBuffs:{}}},attackProcDamage:(_event:unknown,amount:number)=>damage.push(amount)};
  const event={casterId:'ally',targetId:'enemy'};
  for(const actorClass of ['warlock','priest','dark-knight',null]){
    classId=actorClass;
    method('attackProc').call(host,event,{kind:'hit',damage:1},{});
  }
  assert.deepEqual(damage,[660,660,450,450]);
  reads.length=0;damage.length=0;
  method('attackProc').call(host,event,{kind:'hit',damage:0},{});
  method('attackProc').call(host,event,{kind:'miss',damage:0},{});
  assert.deepEqual(damage,[]);assert.deepEqual(reads,[]);
});

test('contact uses the equipped attack formula and its physical or magical settlement',()=>{
  const wardrobe=JSON.parse(readFileSync(new URL('../public/content/wardrobe.json',import.meta.url),'utf8')) as WardrobeCatalog;
  const fighter={level:1,physicalAttack:150,magicAttack:200,physicalDamageRate:500,magicDamageRate:0,
    hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,
    criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0};
  let stance='longsword:empty';
  const hits:{kind:string,amount:number}[]=[];
  const host={hero:{level:1},conditions:new CombatConditions(),arena:[],memberOf:()=>({}),partyFighter:()=>fighter,actorAttribute:()=>0,rearPenetrationBonus:()=>0,
    isActorPresent:method('isActorPresent'),combatant:()=>({position:{x:0,y:0}}),visualOf:()=>({actor:{}}),
    equipmentAttack:()=>wardrobe.attacks[stance],
    actorAttributes:()=>({physicalAttack:100,magicAttack:200,physicalDamageRate:500,magicDamageRate:0,
      stealthDamageRate:0,maxHealth:1000,primaryAttributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}}),
    resolveHitReactions:(_event:unknown,hit:PhysicalHit,kind:string)=>hits.push({kind,amount:hit.damage}),
    settleHit:()=>{},dropMana:()=>{},summonOwnerReactions:()=>{},scene:{events:{emit:()=>{}}},allies:[]};
  method('attackContact').call(host,{casterId:'player',targetId:'ally'});
  stance='staff:empty';
  method('attackContact').call(host,{casterId:'player',targetId:'ally'});
  assert.deepEqual(hits,[{kind:'physical',amount:300},{kind:'magic',amount:200}]);
});

test('灵魂之刃的回蓝排在防守方黑暗之怒之后、属性攻击之前',()=>{
  const order:string[]=[];
  const manaReaction={kind:'mana-on-physical-success',amount:7,effect:'mana-recovery'} as const;
  const host={reactToBuff:(event:{kind:string;ownerId:string})=>{
      if(event.kind==='physical-success')order.push(`mana:${event.ownerId}`);},
    react:(event:{kind:string;ownerId:string})=>{
      if(event.kind==='physical-hit-received')order.push(`wrath:${event.ownerId}`);},
    summonOwnerReactions:()=>{},partySide:()=>false,disturbanceReaction:()=>{},holySacrificeTransfer:()=>{},
    physicalSuccessEquipmentProcs:()=>{},
    lightningOfHellReaction:()=>{},actorAttribute:()=>0,attackProc:()=>order.push('attribute-effects'),
    equipmentRecovery:()=>({lifeDrainPerThousand:0}),conditions:{activeBuffReactions:()=>[manaReaction],hasBuff:()=>false,removeState:()=>{}},
    app:{}};
  method('resolveHitReactions').call(host,{casterId:'attacker',targetId:'defender'},{kind:'hit',damage:12},'physical','basic-attack',{});
  assert.deepEqual(order,['wrath:defender','mana:attacker','attribute-effects'],
    '回蓝在黑暗之怒之后、正伤门与属性攻击之前');
});
