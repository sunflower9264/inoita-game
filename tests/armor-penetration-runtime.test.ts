import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {BattleBuffEffect,NumericCombatUnit} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {CombatController,type CombatPort,type Combatant,type AttackContact,type SkillUnitHit} from '../src/domain/combat.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import type {SkillReactionEvent} from '../src/domain/skill-reactions.ts';
import {createCombatTestHarness,createTestEnemy,createTestMember,loadBattleCatalog,type TestEnemyState,type TestMemberFixture} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const action=catalog.skills['armor-penetration'].action!,parent=action.combatUnits!.find(unit=>unit.effect==='buff')!;
if(parent.effect!=='buff')throw new Error('missing armor penetration parent');
const empty=(modifiers:BattleBuffEffect['modifiers']):BattleBuffEffect=>({durationMs:10000,tickMs:0,states:[],periodic:[],modifiers});
function fixture(){
  const conditions=new CombatConditions(),hitResolution=new CombatHitResolution(),order:string[]=[],effects:string[]=[],hits:{event:AttackContact;hit:PhysicalHit}[]=[];
  let rank=1,lifeDrain=0;
  const config={get version(){return rank;},resetVersion:0,draft:()=>({levels:{'armor-penetration':rank}})};
  const base={level:10,physicalAttack:100,magicAttack:0,baseDefense:100,defense:150,defenseRate:500,
    maxHealth:1000,maxMana:100,hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,
    criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,
    physicalResistance:0,magicResistance:0,attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}};
  const player=createTestMember({id:'player',classId:'warrior',level:10,health:500,maxHealth:1000,mana:100,maxMana:100,panel:{...base}});
  player.skills=config;
  const target=createTestMember({id:'target',classId:'dark-knight',level:10,health:500,maxHealth:1000,mana:100,maxMana:100,panel:{...base}});
  const members=new Map<string,TestMemberFixture>([['player',player],['target',target]]);
  const enemies=new Map<string,TestEnemyState>();
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hitResolution,hero:player,members,enemies,
    activeParty:()=>['player'],
    combatant:id=>members.has(id)||enemies.has(id)?{id,team:id==='player'?'party':'hostile',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}}:undefined,
    statsOverrides:{skillConfiguration:(_id,m)=>(m as unknown as TestMemberFixture).skills as never},
    settlementOverrides:{
      onBuffApplication:(source,id,effect)=>{effects.push(`${source}:${id}:${effect}`);order.push('apply-child-effect');},
      onShowHit:()=>{},onDropMana:()=>{},
    },
  });
  harness.stats.partyPassives=()=>[];
  harness.stats.equipmentRecovery=()=>({lifeDrainPerThousand:lifeDrain,manaRecoveryPerPulse:0,manaCostReductionRate:0});
  harness.settlement.attackProc=()=>{};
  harness.settlement.restoreHealth=(id:string,amount:number)=>{order.push('heal');members.get(id)!.player.health+=amount;};
  harness.settlement.settleHit=(event:AttackContact,hit:PhysicalHit)=>{hits.push({event,hit});order.push(`damage:${event.targetId}:${hit.damage}`);};
  const cast=(level=rank)=>harness.settlement.skillUnit({casterId:'player',targetId:'player',cueIndex:0,skill:{id:'armor-penetration',action,level}});
  const contact=(kind:PhysicalHit['kind']='hit',damageKind:'physical'|'magic'='physical',damage=0)=>
    harness.settlement.resolveHitReactions({casterId:'player',targetId:'target'},{kind,damage},damageKind,'basic-attack');
  const phase=(ownerId='player')=>harness.settlement.react({kind:'physical-attack-effects',ownerId,opponentId:'target',damageKind:'physical',outcome:'hit',
    armorBreakChance:harness.stats.actorAttribute(ownerId,'armorBreakChance')} satisfies SkillReactionEvent);
  const damage:NumericCombatUnit={effect:'physical',source:'physicalAttack',attributeWeights:base.attributes,ranks:[{fixedAddition:0,operation:{kind:'keep'}}]};
  const strike=()=>harness.settlement.skillUnit({casterId:'player',targetId:'target',cueIndex:0,skill:{id:'probe',level:1,action:{combatUnits:[damage]}}} as SkillUnitHit);
  return {harness,conditions,player,target,members,enemies,order,effects,hits,cast,contact,phase,strike,
    learn:(value:number)=>{rank=value;},lifeDrain:(value:number)=>{lifeDrain=value;}};
}

test('the parent retains its cast chance while each successful hit uses the currently learned child rank',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();assert.equal(run.cast(1),'success');run.learn(8);
  assert.equal(run.harness.stats.actorAttribute('player','armorBreakChance'),260);run.contact();
  const child=run.conditions.snapshot('target').find(buff=>buff.id==='armor-break')!;
  assert.equal(child.strength,2013);assert.equal(child.sourceId,'player');
  assert.deepEqual(run.effects,['player:target:armor-break-impact']);
  run.conditions.update(60);run.learn(1);const before=run.conditions.snapshot('target');run.contact();
  assert.deepEqual(run.conditions.snapshot('target'),before);assert.equal(run.effects.length,1);
  run.learn(8);run.contact();assert.equal(run.effects.length,2);
  assert.ok(run.conditions.snapshot('target')[0].remainingMs>before[0].remainingMs);
});

test('the live skill lookup happens after a successful roll including unlearned and nonmember owners',t=>{
  const run=fixture();run.cast();run.learn(0);
  const order:string[]=[];t.mock.method(Math,'random',()=>{order.push('roll');return 0.2;});
  const original=run.harness.stats.learnedReactionBuff.bind(run.harness.stats);
  run.harness.stats.learnedReactionBuff=(id,skill)=>{order.push('lookup');return original(id,skill);};
  run.phase();assert.deepEqual(order,['roll','lookup']);assert.equal(run.effects.length,0);
  order.length=0;run.conditions.setTemporaryAttribute('monster','armorBreakChance',1000);run.phase('monster');
  assert.deepEqual(order,['roll','lookup']);assert.equal(run.effects.length,0);
});

test('only physical nonmiss outcomes trigger armor break, including zero damage',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const damageKind of ['physical','magic'] as const)for(const outcome of ['hit','critical','weapon-block','shield-block','miss'] as const){
    const run=fixture();run.cast();run.contact(outcome,damageKind,0);
    assert.equal(run.conditions.hasBuff('target','armor-break'),damageKind==='physical'&&outcome!=='miss',`${damageKind}:${outcome}`);
  }
});

test('healing finishes before armor chance is read, and armor break precedes reflection without changing the captured main damage',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.cast();run.lifeDrain(1000);
  run.conditions.setTemporaryAttribute('player','armorBreakChance',1);
  const restore=run.harness.settlement.restoreHealth;
  run.harness.settlement.restoreHealth=(id:string,amount:number)=>{restore(id,amount);run.conditions.setTemporaryAttribute('player','armorBreakChance',1000);};
  const molten=catalog.skills['molten-armor'].action!.combatUnits!.find(unit=>unit.effect==='buff')!;
  if(molten.effect!=='buff')throw new Error('missing molten armor');
  run.conditions.applyBuff('target',molten.buff,molten.ranks[0].strength,molten.ranks[0].effect,'target');
  assert.equal(run.strike(),'success');
  assert.deepEqual(run.order,['heal','apply-child-effect','damage:target:63']);
  assert.equal(run.player.player.health,563);assert.equal(run.hits.length,1);
  assert.equal(run.harness.stats.actorAttribute('target','defense'),0);
  run.strike();assert.equal(run.hits.at(-1)!.hit.damage,100);
});

test('armor break retains native newest-first modifier order instead of forcing final resistance to zero',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.cast();
  run.conditions.applyBuff('target','guardian-of-darkness',1,empty([{attribute:'physicalResistanceBonus',operation:{kind:'add',amount:400}}]));
  run.contact();assert.equal(run.harness.stats.partyFighter('target')!.physicalResistance,400);
  run.conditions.applyBuff('target','phantom-clash',1,empty([{attribute:'physicalResistanceBonus',operation:{kind:'add',amount:100}}]));
  assert.equal(run.harness.stats.partyFighter('target')!.physicalResistance,400);
  run.conditions.removeBuff('target','guardian-of-darkness');
  assert.equal(run.harness.stats.partyFighter('target')!.physicalResistance,0);
});

test('a late child survives independently after the parent expires and cannot trigger without the parent chance',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.cast();run.conditions.update(180*60);run.contact();
  run.conditions.update(2*60);assert.equal(run.conditions.hasBuff('player','armor-penetration'),false);
  assert.equal(run.conditions.hasBuff('target','armor-break'),true);
  const before=run.conditions.snapshot('target');run.contact();assert.deepEqual(run.conditions.snapshot('target'),before);
  run.conditions.update(59*60);assert.equal(run.conditions.hasBuff('target','armor-break'),true);
  run.conditions.update(60);assert.equal(run.conditions.hasBuff('target','armor-break'),false);
});

test('a broken monster still reflects from its raw attack rather than its defense',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.cast();run.members.delete('target');
  const enemyDef=catalog.enemies.find(entry=>entry.acceptsBuffs!==false)!;
  run.enemies.set('target',createTestEnemy({key:'target',definition:enemyDef,health:1000,maxHealth:1000,level:10}));
  const molten=catalog.skills['molten-armor'].action!.combatUnits!.find(unit=>unit.effect==='buff')!;
  if(molten.effect!=='buff')throw new Error('missing molten armor');
  run.conditions.applyBuff('target',molten.buff,molten.ranks[0].strength,molten.ranks[0].effect,'target');
  run.contact();assert.equal(run.conditions.hasBuff('target','armor-break'),true);
  assert.deepEqual(run.hits.map(({event,hit})=>[event.targetId,hit.damage]),[['player',32]]);
});

test('the real action casts without approaching and applies its parent on frame four before the two caster effects',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const withFarTarget of [false,true]){
    const run=fixture(),caster:Combatant={id:'player',team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}},
      far:Combatant={...caster,id:'far',team:'hostile',position:{x:200,y:0}};
    const actors=withFarTarget?[caster,far]:[caster],order:string[]=[];
    let frame=(_index:number)=>{},spent=0;
    const presenter={pose:()=>{},visual:()=>({container:{active:true,x:0,y:0}}),
      visualEffect:(effect:{effect:string})=>order.push(effect.effect)};
    const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor('player'),actor:id=>actors.find(actor=>actor.id===id),
      candidates:()=>actors,facing:()=> 'east',moveToward:()=>assert.fail('self cast must not approach'),stop:()=>{},
      canStand:()=>true,relocate:()=>{},clearEffects:()=>{},canSpendMana:()=>true,spendMana:cost=>{spent+=cost;return true;},
      play:(_play,onFrame)=>{frame=onFrame;return ()=>{};},
      frame:(play,index,contact,ready)=>dispatchFrame(presenter,play,index,contact,ready,undefined,(_dispatch:unknown,work:()=>void)=>{work();order.push('dispatch-tail');}),
      unit:event=>{order.push('parent');return run.harness.settlement.skillUnit(event);}};
    const combat=new CombatController('player',null,port);
    assert.equal(combat.requestManualSkill({id:'armor-penetration',level:1,action,manaCost:28},withFarTarget?'far':undefined),'started');
    frame(3);assert.equal(run.conditions.hasBuff('player','armor-penetration'),false);
    frame(4);assert.equal(run.conditions.hasBuff('player','armor-penetration'),true);
    assert.deepEqual(order,['parent','wrath-impact','green-leaves','dispatch-tail']);
    frame(4);assert.equal(spent,28);assert.deepEqual(combat.snapshot().cooldowns['armor-penetration'],{remainingMs:16200,durationMs:16200});
  }
});
