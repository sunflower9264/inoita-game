import assert from 'node:assert/strict';
import test from 'node:test';
import {calculateCharacter,fighterBaseFromPanel,type BattleCharacter,type CharacterPanel} from '../src/domain/character-stats.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {calculateEffectiveDefense,type PhysicalFighter} from '../src/domain/physical-hit.ts';
import type {BattleBuffEffect} from '../src/domain/battle.ts';
import type {EnemySnapshot} from '../src/domain/enemy-stats.ts';
import type {ItemInstance} from '../src/domain/items.ts';
import type {PassiveModifier} from '../src/domain/passive-skills.ts';
import {characterCombatValues} from '../src/ui/character-values.ts';
import {createSimpleStatsPort,createTestMember,loadBattleCatalog,loadCharacterStatsCatalog,loadItemCatalog,type BattleStatKey} from './support/combat-test-harness.ts';

const stats=loadCharacterStatsCatalog(),items=loadItemCatalog(),battle=loadBattleCatalog();
const armor=Object.keys(stats.equipment).find(id=>stats.equipment[id].defense>0)!;
const zero={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};

function panel(baseDefense:number,defenseRate:number):CharacterPanel {
  const entry:ItemInstance={id:'test-armor',item:armor,quantity:1,enhancement:0,gems:[],numbers:{
    baseDefense:baseDefense-stats.classes['dark-knight'].vitality,
    modifiers:[{stat:'defenseRate',value:defenseRate}],gemModifiers:[],magicPercent:0,sockets:0,enhancementUses:0,
  }};
  return calculateCharacter(stats,items,'dark-knight',10,zero,{body:entry});
}

function buff(conditions:CombatConditions,id:string,modifiers:BattleBuffEffect['modifiers']):void {
  conditions.applyBuff(id,'monster-web-fire',1,{durationMs:1000,tickMs:0,modifiers,states:[],periodic:[]});
}

function host(memberPanel:CharacterPanel,conditions=new CombatConditions(),passives:PassiveModifier[]=[]){
  const member=createTestMember({id:'player',level:10,health:100,panel:memberPanel});
  const enemy:PhysicalFighter={level:15,physicalAttack:37,defense:80,defenseRate:250,
    hitBase:10,hitBonus:0,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,
    criticalDamage:1000,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0};
  const hero={level:99,get panel():never{throw new Error('Enemy defense must not read the hero panel');}} as unknown as BattleCharacter;
  const enemyDef=battle.enemies[0];
  const actorStats=createSimpleStatsPort({
    conditions,hero,
    memberOf:(id:string)=>id==='player'?member as never:undefined,
    enemyOf:(id:string)=>id==='enemy'?{key:'enemy',definition:enemyDef}:undefined,
    enemySnapshot:()=>enemy as unknown as EnemySnapshot,
    isEnemyPresent:(id:string)=>id==='enemy',
  });
  actorStats.partyPassives=()=>passives;
  return {conditions,enemy,actorStats,
    fighter:()=>conditions.fighter('player',fighterBaseFromPanel(memberPanel,10),passives,{offhandShield:memberPanel.offhandShield}),
    attribute:(id:string,key:string)=>actorStats.actorAttribute(id,key as BattleStatKey)};
}

test('equipment and buff defense rates add before one multiplication while the panel keeps its display value',()=>{
  for(const [raw,equipmentRate,buffRate,display,effective] of [[100,500,500,150,200],[101,333,333,134,168]]){
    const displayed=panel(raw,equipmentRate),run=host(displayed);
    assert.equal(displayed.baseDefense,raw);
    assert.equal(displayed.defense,display);
    assert.equal(characterCombatValues(displayed)[5],String(display));
    buff(run.conditions,'player',[{attribute:'defenseRate',operation:{kind:'add',amount:buffRate}}]);
    const fighter=run.fighter();
    assert.equal(fighter.defense,raw);
    assert.equal(fighter.defenseRate,equipmentRate+buffRate);
    assert.equal(calculateEffectiveDefense(fighter.defense!,fighter.defenseRate!),effective);
    assert.equal(fighter.physicalResistance,Math.trunc(1000*effective/(effective+20*13)));
    assert.equal(calculateEffectiveDefense(run.attribute('player','defense'),run.attribute('player','defenseRate')),effective);
    assert.equal(displayed.defense,display);
  }
});

test('negative equipment values remain available for later modifiers before the final native clamp',()=>{
  const displayed=panel(-20,-300),run=host(displayed);
  assert.deepEqual([displayed.baseDefense,displayed.defenseRate,displayed.defense],[-20,-300,0]);
  buff(run.conditions,'player',[
    {attribute:'defense',operation:{kind:'add',amount:50}},
    {attribute:'defenseRate',operation:{kind:'add',amount:500}},
  ]);
  const fighter=run.fighter();
  assert.deepEqual([fighter.defense,fighter.defenseRate],[30,200]);
  assert.equal(calculateEffectiveDefense(fighter.defense!,fighter.defenseRate!),36);
  assert.deepEqual([run.attribute('player','defense'),run.attribute('player','defenseRate')],[30,200]);
});

test('passives and buffs finish cancelling each other before raw defense and rate are separately clamped',()=>{
  const passives:PassiveModifier[]=[{attribute:'defense',operation:{kind:'subtract',amount:200}},
    {attribute:'defenseRate',operation:{kind:'subtract',amount:800}}];
  const run=host(panel(100,500),new CombatConditions(),passives);
  buff(run.conditions,'player',[
    {attribute:'defense',operation:{kind:'add',amount:150}},
    {attribute:'defenseRate',operation:{kind:'add',amount:100}},
  ]);
  assert.deepEqual([run.fighter().defense,run.fighter().defenseRate],[50,0]);
  assert.deepEqual([run.attribute('player','defense'),run.attribute('player','defenseRate')],[50,0]);
  run.conditions.removeBuff('player','monster-web-fire');
  assert.deepEqual([run.fighter().defense,run.fighter().defenseRate],[0,0]);
  assert.equal(run.fighter().physicalResistance,0);
  assert.equal(calculateEffectiveDefense(-10,500),0);
  assert.equal(calculateEffectiveDefense(100,-1500),100);
});

test('monster defense uses its own raw values and conditions independently of the hero',()=>{
  const run=host(panel(900,900),new CombatConditions(),[
    {attribute:'defenseRate',operation:{kind:'add',amount:900}},
  ]);
  buff(run.conditions,'player',[{attribute:'defense',operation:{kind:'add',amount:900}}]);
  buff(run.conditions,'enemy',[{attribute:'defenseRate',operation:{kind:'add',amount:750}}]);
  assert.deepEqual([run.attribute('enemy','defense'),run.attribute('enemy','defenseRate')],[80,1000]);
  const fighter=run.conditions.fighter('enemy',run.enemy);
  assert.deepEqual([fighter.defense,fighter.defenseRate],[80,1000]);
  assert.equal(calculateEffectiveDefense(fighter.defense!,fighter.defenseRate!),160);
  assert.equal(fighter.physicalResistance,Math.trunc(1000*160/(160+20*18)));
  run.conditions.remove('player');
  assert.deepEqual([run.attribute('enemy','defense'),run.attribute('enemy','defenseRate')],[80,1000]);
});
