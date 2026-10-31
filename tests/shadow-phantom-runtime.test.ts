import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,ResolvedBasicAttack,SkillAction} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import type {AttackContact,Combatant} from '../src/domain/combat.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import {passiveModifiers} from '../src/domain/passive-skills.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const rates=[170,230,270,290,310,330,350,370];
const whist=catalog.skills.whist.action!.combatUnits![0];assert.ok(whist.effect==='buff');
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const base={level:10,physicalAttack:100,magicAttack:100,baseDefense:0,defense:0,defenseRate:0,
  maxHealth:10000,maxMana:100,hitBase:100,hitBonus:0,evasionBase:0,evasionBonus:0,
  criticalRate:11,criticalResistance:0,criticalDamage:1000,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,
  physicalResistance:0,magicResistance:0,baseMagicResistance:0,attributes:primary};
function fixture(){
  const ranks={player:1,ally:8};
  const configuration=(id:'player'|'ally')=>({draft:()=>({levels:{'shadow-phantom':ranks[id]}})});
  const member=(id:'player'|'ally')=>({classId:'assassin',level:10,panel:structuredClone(base),skills:configuration(id),
    player:{health:10000,maxHealth:10000,mana:100,maxMana:100},
    bag:{equipmentFor:()=>({}),equipmentItems:()=>({}),get:()=>undefined}});
  const player=member('player'),ally=member('ally'),members=new Map([['player',player],['ally',ally]]);
  const stats={...structuredClone(base),health:10000,mana:100};
  const actors=new Map(['player','ally','target'].map((id,index):[string,Combatant]=>[id,
    {id,team:id==='target'?'enemy':'party',position:{x:index*8,y:0},bounds:{x:-4,y:-4,width:8,height:8}}]));
  const conditions=new CombatConditions(),hits:PhysicalHit[]=[];
  const host=Object.setPrototypeOf({hero:player,conditions,hitResolution:new CombatHitResolution(),
    pendingDefeats:new Set<string>(),fallen:new Set<string>(),allies:[],arena:[{key:'target',definition:catalog.enemies[0]}],
    app:{battleCatalog:catalog,items:{items:{}},session:{skills:configuration('player'),party:{controlledId:'player',groupModifiers:()=>({})}},audio:{effect:()=>{}}},
    scene:{events:{emit:()=>{}}},memberOf:(id:string)=>members.get(id),
    roster:{enemySnapshot:()=>stats},combatant:(id:string)=>actors.get(id),visualOf:()=>undefined,
    resolveHitReactions:()=>{},dropMana:()=>{},react:()=>{},
    settleHit:(_event:AttackContact,hit:PhysicalHit)=>hits.push(hit),showHit:(_event:AttackContact,hit:PhysicalHit)=>hits.push(hit),
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const skill=(effect:'physical'|'magic'):SkillAction=>({usesSkillDamageBuff:true,events:[],cooldownFrames:0,
    approachDistanceUnits:4,searchRadiusPx:64,transition:null,
    combatUnits:[{effect,source:'none',attributeWeights:primary,ranks:[{fixedAddition:100,operation:{kind:'keep'}}]}]});
  const strike=(effect:'physical'|'magic',id='player')=>{
    call('skillUnit',{casterId:id,targetId:'target',cueIndex:0,skill:{id:'critical-consumer-probe',level:1,action:skill(effect)}});
    return hits.at(-1)!;
  };
  return {conditions,call,host,ranks,player,ally,stats,actors,hits,strike,skill,
    critical:(id='player')=>call('actorAttribute',id,'criticalRate') as number};
}

test('all eight Shadow Phantom ranks read the owner state and loadout across main-hand choices',()=>{
  const f=fixture();
  for(let rank=1;rank<=8;rank++){
    f.ranks.player=rank;assert.equal(f.critical(),11);
    f.conditions.applyState('player','stealthed',10000);
    assert.equal(f.critical(),11+rates[rank-1]);
    assert.equal(f.call('partyFighter','player').criticalRate,11+rates[rank-1]);
    assert.equal(f.critical('ally'),11);
    for(const weapon of ['unarmed','dagger','longsword','two-handed','staff']){
      const loadout={levels:{'shadow-phantom':rank}};
      assert.deepEqual(passiveModifiers(catalog,'assassin',loadout,weapon,true),[
        {attribute:'criticalRate',operation:{kind:'add',amount:rates[rank-1]}}]);
      assert.deepEqual(passiveModifiers(catalog,'assassin',loadout,weapon),[]);
    }
    f.conditions.removeState('player','stealthed');
  }
  f.conditions.applyState('ally','stealthed',10000);
  assert.equal(f.critical('ally'),11+Math.trunc((400+(50+20*12)*10)/10),'佣兵八级 b=12，加装备暴击 11');assert.equal(f.critical(),11);
  f.ranks.ally=0;assert.equal(f.critical('ally'),11,'an unlearned passive adds nothing to a hidden actor');
});

test('the real stealth state enables the passive independently of stealth damage attributes and visual appearance',()=>{
  const f=fixture();
  f.conditions.setTemporaryAttribute('player','stealthAttackEnabled',1);
  f.conditions.setTemporaryAttribute('player','stealthDamageRate',1603);
  assert.equal(f.critical(),11,'the attack attribute gate alone is not the passive condition');
  f.conditions.setTemporaryAttribute('player','stealthAttackEnabled',0);
  f.conditions.applyState('player','stealthed',10000);
  assert.equal(f.critical(),181,'a state without a Whist buff is sufficient');
  f.conditions.removeState('player','stealthed');
  f.host.visualOf=()=>({layers:[{alpha:0.5}]});
  assert.equal(f.critical(),11,'half-transparent rendering does not substitute for the state');
});

test('Whist refresh, owner removal and state expiry invalidate a cached critical value while preserving an independent attack source',()=>{
  const f=fixture();f.conditions.setTemporaryAttribute('player','criticalRate',999);
  f.conditions.applyBuff('player','whist',2,whist.ranks[0].effect);assert.equal(f.critical(),181);
  f.conditions.setTemporaryAttribute('player','criticalRate',481);
  assert.equal(f.critical(),481,'an action temporary cache already includes the learned bonus');
  f.conditions.applyBuff('player','whist',2,whist.ranks[0].effect);
  assert.equal(f.critical(),181,'accepted state refresh discards the cached action value');
  f.conditions.setTemporaryAttribute('player','criticalRate',481);
  f.conditions.removeState('player','stealthed');assert.equal(f.critical(),11);
  const shortState=structuredClone(whist.ranks[0].effect);
  shortState.stateDurationProfiles={stealthed:{normal:{lastActiveFrame:0}}};
  f.conditions.applyBuff('player','whist',2,shortState);assert.equal(f.critical(),181);
  f.conditions.setTemporaryAttribute('player','criticalRate',481);f.conditions.update(120);
  assert.equal(f.conditions.hasBuff('player','whist'),true);
  assert.equal(f.conditions.attribute('player','stealthAttackEnabled',0),1);
  assert.equal(f.critical(),11,'the remaining attack buff cannot keep the expired state condition true');
});

test('physical and magic skill consumers use the hidden attacker bonus and target resistance at the exact boundary',t=>{
  const f=fixture();let roll=0.18;t.mock.method(Math,'random',()=>roll);
  for(const kind of ['physical','magic'] as const){
    assert.deepEqual(f.strike(kind),{kind:'hit',damage:100});
    f.conditions.applyState('player','stealthed',10000);
    assert.deepEqual(f.strike(kind),{kind:'critical',damage:200});
    roll=0.181;assert.deepEqual(f.strike(kind),{kind:'hit',damage:100});
    roll=0.18;f.stats.criticalResistance=1;assert.deepEqual(f.strike(kind),{kind:'hit',damage:100});
    f.stats.criticalResistance=0;
    assert.deepEqual(f.strike(kind,'ally'),{kind:'hit',damage:100},'the visible companion does not borrow the player bonus');
    f.conditions.removeState('player','stealthed');
  }
});

test('a stealth-breaking action keeps the bonus through its hit and loses it before the next dispatch',t=>{
  t.mock.method(Math,'random',()=>0.18);const f=fixture();f.conditions.applyState('player','stealthed',10000);
  const playback={caster:f.actors.get('player')!,facing:'east',basicAttack:null,
    skill:{id:'critical-dispatch-probe',level:1,action:f.skill('physical')}};
  f.call('runActionDispatch',playback,{breaksStealth:true},()=>{
    assert.deepEqual(f.strike('physical'),{kind:'critical',damage:200});assert.equal(f.critical(),181);
  });
  assert.equal(f.critical(),11);assert.deepEqual(f.strike('physical'),{kind:'hit',damage:100});
});

test('ordinary attacks consume the same state-conditioned critical attribute',t=>{
  t.mock.method(Math,'random',()=>0.18);const f=fixture();const definition=catalog.basicAttacks['longsword-slash'];
  const basicAttack:ResolvedBasicAttack={...definition,effectiveCycleFrames:definition.cycleFrames,
    clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'},sequence:{north:[],south:[],east:[],west:[]}};
  f.conditions.applyState('player','stealthed',10000);
  f.call('attackContact',{casterId:'player',targetId:'target',basicAttack});assert.deepEqual(f.hits.at(-1),{kind:'critical',damage:200});
  f.conditions.removeState('player','stealthed');
  f.call('attackContact',{casterId:'player',targetId:'target',basicAttack});assert.deepEqual(f.hits.at(-1),{kind:'hit',damage:100});
});
