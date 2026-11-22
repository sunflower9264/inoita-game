import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,BattleBuffEffect,CombatUnit,EnemyDefinition} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {ItemInstance} from '../src/domain/items.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const attackStun=catalog.statusAttackBuffs!['attack-stun']!;
const stateUnit:CombatUnit={effect:'state',state:'stun',ranks:[{chanceThreshold:1000,durationMs:1200,
  stateDurationProfile:{normal:{lastActiveFrame:19},targetShortened:{lastActiveFrame:9}}}]};

function fixture(){
  const equipment:ItemInstance[]=[];
  const member={level:1,player:{health:100},bag:{equipmentFor:()=>Object.fromEntries(equipment.map((_,i)=>[i,String(i)])),
    get:(id:string)=>equipment[Number(id)]}};
  const enemies:{key:string;definition:Pick<EnemyDefinition,'stateRules'|'acceptsBuffs'>}[]=[{key:'enemy',definition:{}}];
  const conditions=new CombatConditions(),consequences:string[][]=[];
  const host=Object.setPrototypeOf({hero:member,arena:enemies,conditions,pendingDefeats:new Set(),fallen:new Set(),
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),aiSkillCostCache:new Map(),
    roster:{isPresent:()=>true},
    app:{battleCatalog:catalog,session:{party:{groupModifiers:()=>({})}}},
    memberOf:(id:string)=>id==='player'?member:undefined,partyPassives:()=>[],partyFighter:()=>({}),enemyFighter:()=>({}),
    applyStateConsequences:(_id:string,states:string[])=>{if(states.length)consequences.push(states);},
    syncCombatResourceLimits:()=>{},showBuffApplication:()=>{},
  },WorldCombat.prototype);
  const apply=(effect:BattleBuffEffect=attackStun,priority=1,target='enemy',source='player')=>
    Reflect.get(WorldCombat.prototype,'applyActorBuff').call(host,target,'attack-stun',priority,effect,source);
  const direct=(target='enemy',source='player',unit=stateUnit)=>Reflect.get(WorldCombat.prototype,'skillUnit').call(host,
    {casterId:source,targetId:target,cueIndex:0,skill:{id:'state-test',level:1,action:{combatUnits:[unit]}}});
  return {host,conditions,consequences,equipment,enemies,apply,direct};
}

test('equipment positive immunity belongs to the recipient and rejects without a resistance roll',t=>{
  t.mock.method(Math,'random',()=>assert.fail('guaranteed state with immunity must not roll'));
  const f=fixture();f.equipment.push({numbers:{modifiers:[{stat:'stunResistance',value:1}],gemModifiers:[]}} as unknown as ItemInstance);
  assert.equal(f.direct('player','enemy'),'failure');
  assert.equal(f.conditions.hasState('player','stun'),false);
  assert.equal(f.direct(),'success');
  assert.equal(f.conditions.hasState('enemy','stun'),true);
  f.equipment[0].numbers!.modifiers[0].value=-5;
  f.conditions.setTemporaryAttribute('player','stunImmunity',-2);
  assert.equal(f.direct('player','enemy'),'success');
  f.conditions.setTemporaryAttribute('player','stunImmunity',1);
  assert.equal(f.direct('player','enemy'),'failure');
});

test('generic resistance draws once for an enemy, while friendly state application skips it',t=>{
  let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return 0;});
  const f=fixture();f.conditions.setTemporaryAttribute('enemy','stateResistance',1000);
  assert.equal(f.direct(),'failure');assert.equal(rolls,1);
  assert.equal(f.direct('enemy','enemy'),'success');assert.equal(rolls,1);
});

test('compiled monster rules let the state expire before its buff, reject boss stun and reject whole buffs separately',()=>{
  const normal=fixture(),short=fixture(),boss=fixture(),immune=fixture();
  short.enemies[0].definition.stateRules={buffDurationScaleByState:{stun:0.5}};
  boss.enemies[0].definition.stateRules={immuneStates:['stun'],durationScale:0.5};
  immune.enemies[0].definition.acceptsBuffs=false;
  for(const f of [normal,short,boss])assert.equal(f.apply(),true);
  assert.equal(immune.apply(),false);
  assert.equal(boss.conditions.hasState('enemy','stun'),false);
  assert.equal(boss.conditions.hasBuff('enemy','attack-stun'),true);
  normal.conditions.update(1440);short.conditions.update(1440);
  assert.equal(normal.conditions.hasState('enemy','stun'),true);
  assert.equal(short.conditions.hasState('enemy','stun'),false);
  assert.equal(short.conditions.hasBuff('enemy','attack-stun'),true);
  normal.conditions.update(480);assert.equal(normal.conditions.hasState('enemy','stun'),false);
});

test('weak buff rejection consumes no state roll; initialization sees the accepted new buff modifiers',t=>{
  const f=fixture();let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return 0.9;});
  f.conditions.setTemporaryAttribute('enemy','stateResistance',100);
  assert.equal(f.apply(attackStun,2),true);assert.equal(rolls,1);
  assert.equal(f.apply(attackStun,1),false);assert.equal(rolls,1);
  const effect={...attackStun,modifiers:[{attribute:'stunImmunity' as const,operation:{kind:'set' as const,amount:1}}]};
  assert.equal(f.apply(effect,3),true);assert.equal(rolls,1);
  assert.equal(f.conditions.hasState('enemy','stun'),false);
  assert.equal(f.conditions.hasBuff('enemy','attack-stun'),true);
});

test('node exhaustion fails direct state but keeps an accepted buff without firing state consequences',()=>{
  const f=fixture();for(let i=0;i<128;i++)assert.equal(f.conditions.applyStateFrames(`occupied-${i}`,'sleep',100),true);
  assert.equal(f.direct(),'failure');assert.equal(f.apply(),true);
  assert.equal(f.conditions.hasState('enemy','stun'),false);
  assert.equal(f.conditions.hasBuff('enemy','attack-stun'),true);
  assert.deepEqual(f.consequences,[]);
});

test('all exported direct states and state buffs carry independent frame profiles',()=>{
  let direct=0,buffs=0;
  function visit(value:unknown):void {
    if(!value||typeof value!=='object')return;
    const object=value as Record<string,unknown>;
    if(object.effect==='state'){
      const unit=value as Extract<CombatUnit,{effect:'state'}>;
      for(const rank of unit.ranks){assert.ok(rank.stateDurationProfile);assert.equal(rank.durationMs,(rank.stateDurationProfile.normal.lastActiveFrame+1)*60);direct++;}
    }
    if(Array.isArray(object.states)&&object.states.length){
      const effect=value as BattleBuffEffect;assert.ok(effect.simulationFrames);
      for(const state of effect.states)assert.ok(effect.stateDurationProfiles?.[state]);buffs++;
    }
    for(const entry of Object.values(object))visit(entry);
  }
  // 两种成长各有 40 个公共技能状态及 8 个召唤命令状态。
  // 状态增益：两种成长各 40 个技能定义，另有 51 个怪物定义和 6 个属性攻击定义。
  visit(catalog);assert.equal(direct,2*(40+8));assert.equal(buffs,2*40+51+6);
  assert.equal(catalog.enemies.filter(enemy=>enemy.acceptsBuffs===false).length,3);
  assert.equal(catalog.enemies.filter(enemy=>enemy.stateRules?.durationScale===0.5).length,31);
});
