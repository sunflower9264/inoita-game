import {dispatchFrame} from './support/combat-driver.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {NumericCombatUnit} from '../src/domain/battle.ts';
import {actionDamage} from '../src/domain/action-damage.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatController,resolveCueTargets,type Combatant,type CombatPort,type SkillUnitHit} from '../src/domain/combat.ts';
import type {PhysicalFighter,PhysicalHit} from '../src/domain/physical-hit.ts';
import type {CombatActorAttributes} from '../src/domain/combat-damage-source.ts';
import type {CombatThreatSystem} from '../src/domain/combat-threat-system.ts';
import {createCombatTestHarness,createTestEnemy,createTestMember,loadBattleCatalog} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const skill=catalog.skills['curse-of-screams'],action=skill.action!,units=action.combatUnits!;
const damage=units[0],buff=units[1];
if(damage.effect!=='physical'||buff.effect!=='buff')throw new Error('Curse of Screams units missing');
const ranks=buff.ranks,event=action.events.find(event=>event.kind==='units')!;
if(event.kind!=='units')throw new Error('Curse of Screams event missing');
const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const base:PhysicalFighter={level:10,physicalAttack:201,magicAttack:303,maxHealth:10000,hitBase:100,hitBonus:0,
  evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,
  weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
const actor=(id:string,x=16,y=0,team:Combatant['team']='hostile'):Combatant=>({id,team,position:{x,y},bounds:{x:-4,y:-4,width:8,height:8}});

function fixture(targets:Combatant[]=[]){
  const caster=actor('caster',0,0,'party'),actors=new Map([caster,...targets].map(actor=>[actor.id,actor]));
  const stats=new Map(targets.map(actor=>[actor.id,{...base}]));
  const conditions=new CombatConditions(),hits:{event:SkillUnitHit;hit:PhysicalHit}[]=[],taunts:string[]=[],effects:string[]=[],attempts:SkillUnitHit[]=[];
  const member=createTestMember({id:'caster',level:10,health:10000,maxHealth:10000,mana:100,maxMana:100,panel:{...base,attributes:primary}});
  const enemyDef=catalog.enemies.find(enemy=>enemy.acceptsBuffs!==false)!;
  const enemies=new Map(targets.map(target=>[target.id,createTestEnemy({key:target.id,definition:enemyDef,health:10000,maxHealth:10000,level:10})]));
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hero:member,members:new Map([['caster',member]]),enemies,
    activeParty:()=>['caster'],
    combatant:id=>actors.get(id),combatants:()=>[...actors.values()],
    withThreat:false,
    statsOverrides:{
      enemySnapshot:id=>{
        const s=stats.get(id);
        return s?{...s,magicAttack:s.magicAttack??0,magicResistance:s.magicResistance??0,id:'enemy',name:'enemy',sceneLevel:false,elite:false,partySize:1,health:10000,maxHealth:s.maxHealth??10000,mana:0,maxMana:100,
          defense:0,defenseRate:1000,physicalResistanceBonus:s.physicalResistance,hitRate:100,evasionRate:0,baseExperience:0,experience:0}:undefined;
      },
    },
    settlementOverrides:{
      threat:{taunt:(_source:string,target:string)=>taunts.push(target)} as unknown as CombatThreatSystem,
      onDropMana:()=>{},
    },
  });
  harness.settlement.resolveHitReactions=()=>{};
  harness.settlement.settleHit=(event,hit)=>hits.push({event:event as SkillUnitHit,hit});
  const presenter={pose:()=>{},visualEffect:(cue:{effect:string})=>effects.push(cue.effect),
    visual:(id:string)=>actors.has(id)?{container:{active:true,...actors.get(id)!.position}}:undefined};
  let frame=(_index:number)=>{},spent=0,moves=0;
  const unit=(hit:SkillUnitHit)=>harness.settlement.skillUnit(hit);
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor('caster'),actor:id=>actors.get(id),candidates:()=>[...actors.values()],facing:()=> 'west',
    moveToward:()=>{moves++;},stop:()=>{},canStand:()=>true,relocate:()=>{},clearEffects:()=>{},
    canSpendMana:()=>true,spendMana:cost=>{spent+=cost;return true;},
    play:(_playback,onFrame)=>{frame=onFrame;return ()=>{};},
    frame:(playback,index,contact,ready)=>dispatchFrame(presenter,playback,index,contact,ready),
    unit:hit=>{attempts.push(hit);return unit(hit);}};
  const combat=new CombatController('caster',null,port);
  return {harness,member,stats,conditions,hits,taunts,effects,attempts,actors,unit,combat,
    start:()=>combat.requestManualSkill({id:skill.id,action,level:1,manaCost:40}),
    fire:()=>frame(event.frame),counts:()=>({spent,moves}),
    attributes:(id:string)=>harness.stats.actorAttributes(id) as CombatActorAttributes};
}

test('all eight curse ranks preserve weighted damage and reduce the two raw attack attributes',()=>{
  assert.deepEqual(units.map(unit=>unit.effect),['physical','buff','taunt']);assert.equal(damage.source,'bestNormalDamage');
  assert.deepEqual(damage.attributeWeights,{strength:10,dexterity:0,vitality:12,intelligence:0,mentality:0});
  assert.deepEqual(damage.ranks.map(rank=>rank.operation),[1380,1500,1620,1800,1860,1920,1980,2040]
    .map(ratePerThousand=>({kind:'multiply-thousandth',ratePerThousand})));
  assert.deepEqual(ranks.map(rank=>rank.strength),[2002,2004,2006,2009,2010,2011,2012,2013]);
  assert.deepEqual(damage.ranks.map((_,i)=>actionDamage(damage,i+1,{physicalAttack:100,magicAttack:137,bestNormalDamage:137,
    maxHealth:1000,primaryAttributes:{...primary,strength:3,vitality:4}})),[198,216,233,259,267,276,285,293]);
  for(const [index,rank]of ranks.entries()){
    assert.equal(rank.chanceThreshold,1000);assert.equal(rank.effect.maxStacks,1);
    assert.deepEqual(rank.effect.modifiers,['physicalAttack','magicAttack'].map(attribute=>({attribute,
      operation:{kind:'decrease-thousandth',ratePerThousand:[80,160,240,360,400,440,480,520][index]}})));
  }
});

test('a cursed enemy uses both reduced raw attacks in subsequent real physical and magic skill damage',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const expectedPhysical=[184,168,152,128,120,112,104,96],expectedMagic=[278,254,230,193,181,169,157,145];
  for(const [index,rank]of ranks.entries()){
    const run=fixture([actor('enemy')]);run.conditions.applyBuff('enemy','curse-of-screams',rank.strength,rank.effect,'caster');
    const attributes=run.attributes('enemy');assert.deepEqual([attributes.physicalAttack,attributes.magicAttack],[expectedPhysical[index],expectedMagic[index]]);
    assert.deepEqual(attributes.primaryAttributes,primary);
    for(const effect of ['physical','magic'] as const){
      const probe:NumericCombatUnit={effect,source:effect==='physical'?'physicalAttack':'magicAttack',attributeWeights:primary,
        ranks:[{fixedAddition:0,operation:{kind:'keep'}}]};
      assert.equal(run.unit({casterId:'enemy',targetId:'caster',cueIndex:0,skill:{id:'attack-probe',action:{...action,combatUnits:[probe]}}}),'success');
    }
    assert.deepEqual(run.hits.map(({hit})=>hit.damage),[expectedPhysical[index],expectedMagic[index]]);
    run.conditions.removeBuff('enemy','curse-of-screams');
    assert.deepEqual([run.attributes('enemy').physicalAttack,run.attributes('enemy').magicAttack],[201,303]);
  }
});

test('curse can be cast without enemies and still plays its two caster effects without moving',()=>{
  const run=fixture();assert.equal(action.requiresTarget,false);assert.equal(run.start(),'started');run.fire();
  assert.deepEqual(run.counts(),{spent:40,moves:0});assert.equal(run.attempts.length,0);
  assert.deepEqual(run.effects,['curse-wind-ring','curse-shockwave']);
  assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs,action.cooldownFrames*60);
});

test('the area uses integer octagonal distance from the caster feet, independent of collision boxes',()=>{
  const caster=actor('caster',0,0,'party'),targets=[actor('axis-in',79),actor('axis-out',80),actor('diagonal-in',56,56),actor('diagonal-out',59,59)];
  targets[1].bounds={x:-100,y:-100,width:200,height:200};
  for(const cue of event.cues){
    assert.equal(cue.targetRangeMetric,'octagonal-grid');assert.equal(cue.targetRangePx,72);
    assert.deepEqual(resolveCueTargets(cue,caster,targets[1],targets).map(target=>target.id),['axis-in','diagonal-in']);
  }
  assert.deepEqual(event.cues.map(cue=>cue.targetSelection),['search','reuse-previous','reuse-previous']);
});

test('actual controller and presenter keep the first sixteen eligible targets for all three units',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const valid=Array.from({length:17},(_,index)=>actor(`enemy-${index}`));
  const run=fixture([actor('far',80),{...actor('hidden'),states:['stealthed']},actor('friendly',16,0,'party'),...valid]);
  assert.equal(run.start(),'started');run.fire();
  const expected=valid.slice(0,16).map(target=>target.id);
  for(let cue=0;cue<3;cue++)assert.deepEqual(run.attempts.filter(hit=>hit.cueIndex===cue).map(hit=>hit.targetId),expected);
  assert.deepEqual(run.taunts,expected);assert.equal(run.conditions.hasBuff('enemy-16','curse-of-screams'),false);
  assert.deepEqual(run.effects,['curse-wind-ring','curse-shockwave']);
});

test('mixed hit, miss and non-miss zero damage skip only the failed targets later debuff and taunt',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture([actor('hit'),actor('miss'),actor('zero')]);
  run.stats.get('miss')!.evasionBonus=750;run.stats.get('zero')!.physicalResistance=1000;
  run.start();run.fire();
  assert.deepEqual(run.hits.map(({event,hit})=>[event.targetId,hit.kind,hit.damage]),[['hit','hit',418],['miss','miss',0],['zero','hit',0]]);
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'hit'],[0,'miss'],[0,'zero'],[1,'hit'],[2,'hit']]);
  assert.equal(run.conditions.hasBuff('hit','curse-of-screams'),true);
  for(const id of ['miss','zero'])assert.equal(run.conditions.hasBuff(id,'curse-of-screams'),false);
  assert.deepEqual(run.taunts,['hit']);
  assert.deepEqual(run.effects,['curse-wind-ring','curse-shockwave']);
});

test('all ranks retain age 75 through boundary 76 and expire on 77; weak rejection and accepted refresh preserve one layer',()=>{
  for(const rank of ranks){
    assert.equal(rank.effect.durationMs,4560);assert.deepEqual(rank.effect.simulationFrames,{lastActiveFrame:75});
    const c=new CombatConditions();c.applyBuff('enemy','curse-of-screams',rank.strength,rank.effect,'source');
    c.update(76*60);assert.equal(c.hasBuff('enemy','curse-of-screams'),true);
    c.update(59);assert.equal(c.hasBuff('enemy','curse-of-screams'),true);c.update(1);assert.equal(c.hasBuff('enemy','curse-of-screams'),false);
  }
  const c=new CombatConditions(),apply=(index:number,source:string)=>c.applyBuff('enemy','curse-of-screams',ranks[index].strength,ranks[index].effect,source);
  apply(3,'old');c.update(600);const before=c.captureState();assert.equal(apply(0,'weak'),false);assert.deepEqual(c.captureState(),before);
  assert.equal(apply(7,'strong'),true);c.update(76*60);assert.equal(c.hasBuff('enemy','curse-of-screams'),true);
  assert.equal(apply(7,'equal'),true);c.update(60);assert.equal(c.snapshot('enemy')[0].sourceId,'equal');assert.equal(c.snapshot('enemy')[0].stackCount,1);
  c.update(76*60);assert.equal(c.hasBuff('enemy','curse-of-screams'),false);
});
