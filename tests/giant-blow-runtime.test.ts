import {dispatchFrame} from './support/combat-driver.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {ActionDispatchDefinition,SkillAction} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatController,type ActionPlayback,type Combatant,type CombatPort,type SkillUnitHit} from '../src/domain/combat.ts';
import type {PhysicalFighter,PhysicalHit} from '../src/domain/physical-hit.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
  loadWardrobeCatalog,
  ZERO_PRIMARY_ATTRIBUTES,
} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const skill=catalog.skills['giant-blow'],action=skill.action!;
const primary=ZERO_PRIMARY_ATTRIBUTES;
const base:PhysicalFighter={level:10,physicalAttack:201,magicAttack:303,maxHealth:10000,hitBase:100,hitBonus:1000,
  evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,
  weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
const actor=(id:string,x=16,y=0,team:'party'|'hostile'='hostile'):Combatant=>({id,team,position:{x,y},bounds:{x:-4,y:-4,width:8,height:8}});

function fixture(targets:Combatant[]=[],rank=1,plan:SkillAction=action){
  const caster=actor('caster',0,0,'party'),actors=new Map([caster,...targets].map(actor=>[actor.id,actor]));
  const stats=new Map(targets.map(actor=>[actor.id,{...base}]));
  const conditions=new CombatConditions(),hits:{event:SkillUnitHit;hit:PhysicalHit}[]=[],order:string[]=[],attempts:SkillUnitHit[]=[],feedback:ActionDispatchDefinition[]=[],prepared:number[]=[];
  const member=createTestMember({
    id:'caster',classId:'dark-knight',level:10,health:10000,maxHealth:10000,mana:100,maxMana:100,
    panel:{...base,attributes:{...primary}},
  });
  const enemies=new Map(targets.map(target=>[target.id,createTestEnemy({key:target.id,definition:{...catalog.enemies[0],acceptsBuffs:true,stateRules:undefined}})]));
  let afterHit:((event:SkillUnitHit)=>void)|undefined;
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hero:member,members:new Map([['caster',member]]),enemies,
    activeParty:()=>['caster'],
    combatant:id=>actors.get(id),
    combatants:()=>[...actors.values()],
    withThreat:false,
    settlementOverrides:{
      isEnemyPresent:()=>true,
      onStateConsequences:undefined,
      onShowHit:undefined,
      onDropMana:undefined,
      onEnemyZeroHealth:undefined,
    },
  });
  harness.stats.partyFighter=()=>conditions.fighter('caster',{...member.panel,level:member.level});
  harness.stats.enemyFighter=(id:string)=>conditions.fighter(id,stats.get(id)!);
  harness.settlement.resolveHitReactions=()=>{};
  harness.settlement.settleHit=(hitEvent,hit)=>{hits.push({event:hitEvent as SkillUnitHit,hit});afterHit?.(hitEvent as SkillUnitHit);};
  const presenter={pose:()=>{},visualEffect:(cue:{effect:string})=>order.push(`effect:${cue.effect}`),
    visual:(id:string)=>actors.has(id)?{container:{active:true,...actors.get(id)!.position}}:undefined};
  let affordable=true;
  let frame=(_index:number)=>{},spent=0,moves=0,turns=0,playback:ActionPlayback|undefined;
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor('caster'),actor:id=>actors.get(id),candidates:()=>[...actors.values()],facing:()=> 'east',face:()=>{turns++;},
    moveToward:()=>{moves++;},stop:()=>{},canStand:()=>true,relocate:()=>{moves++;},clearEffects:()=>{},
    canSpendMana:()=>affordable,spendMana:cost=>{spent+=cost;return true;},
    play:(value,onFrame)=>{playback=value;frame=onFrame;return ()=>{};},
    frame:(value,index,contact,ready)=>dispatchFrame(presenter,value,index,contact,ready,undefined,(value:ActionDispatchDefinition,work:()=>void)=>{work();feedback.push(value);order.push('feedback');}),
    prepareUnit:unitStart=>{prepared.push(unitStart.cueIndex);return harness.settlement.prepareSkillUnit(unitStart);},
    unit:hit=>{attempts.push(hit);order.push(`unit:${hit.cueIndex}:${hit.targetId}`);return harness.settlement.skillUnit(hit);}};
  const combat=new CombatController('caster',null,port);
  return {caster,stats,hits,order,attempts,feedback,combat,conditions,member,actors,harness,prepared,
    afterHit:(callback:(event:SkillUnitHit)=>void)=>{afterHit=callback;},
    start:(targetId?:string)=>combat.requestManualSkill({id:skill.id,action:plan,level:rank,manaCost:48},targetId),
    frame:(index:number)=>frame(index),affordable:(value:boolean)=>{affordable=value;},counts:()=>({spent,moves,turns}),playback:()=>playback};
}


test('Giant Blow uses the live current target at impact and retains the first target set after reactions change it',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture([actor('locked',16),actor('current',-32),actor('near-current',-60)]);
  assert.equal(run.start('locked'),'started');run.combat.setReactionTarget('current');
  run.afterHit(()=>run.combat.setReactionTarget('locked'));
  run.frame(15);assert.equal(run.attempts.length,0);run.frame(16);
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'current'],[0,'near-current'],[1,'current'],[1,'near-current']]);
  assert.equal(run.conditions.hasState('locked','stun'),false);assert.equal(run.conditions.hasState('current','stun'),true);
  assert.deepEqual(run.order.slice(-1),['feedback']);assert.equal(run.counts().spent,48);
});

test('a lost current target is selected again at impact and published back to the controller',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture([actor('lost'),actor('replacement',20)]);assert.equal(run.start('lost'),'started');
  run.actors.delete('lost');run.combat.targetRemoved('lost');run.frame(16);
  assert.equal(run.combat.snapshot().targetId,'replacement');
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'replacement'],[1,'replacement']]);
});

test('an existing out-of-reach current target falls back to caster feet without choosing another center',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const current=actor('current'),run=fixture([current,actor('near-caster',-40),actor('axis-out',48)]);
  assert.equal(run.start('current'),'started');current.position.x=200;run.frame(16);
  assert.equal(run.combat.snapshot().targetId,'current');
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'near-caster'],[1,'near-caster']]);
});

test('an empty replacement search still hits the caster-centered area and runs its feedback',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture([actor('lost'),actor('ring',40)]);assert.equal(run.start('lost'),'started');
  run.actors.delete('lost');run.combat.targetRemoved('lost');run.frame(16);
  assert.equal(run.combat.snapshot().targetId,undefined);
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'ring'],[1,'ring']]);
  assert.equal(run.feedback.length,1);
});

test('the first sixteen targets keep failed damage slots and only successful damage proceeds to stun',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const targets=Array.from({length:17},(_,index)=>actor(`enemy-${index}`)),run=fixture(targets);
  run.conditions.applyState('enemy-0','damage-immune',10000);
  run.stats.get('enemy-1')!.evasionBase=10000;run.stats.get('enemy-1')!.evasionBonus=750;
  assert.equal(run.start('enemy-2'),'started');run.frame(16);
  assert.deepEqual(run.attempts.filter(hit=>hit.cueIndex===0).map(hit=>hit.targetId),targets.slice(0,16).map(value=>value.id));
  assert.deepEqual(run.attempts.filter(hit=>hit.cueIndex===1).map(hit=>hit.targetId),targets.slice(2,16).map(value=>value.id));
  assert.equal(run.conditions.hasState('enemy-16','stun'),false);
  assert.deepEqual(run.feedback,[{breaksStealth:true,shake:true,vibrationMs:150,sound:'Wa_Titan_Attack'}]);
  run.frame(16);assert.equal(run.feedback.length,1);
});

test('all eight ranks apply normal and target-shortened stun lifetimes through the actual hit host',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const shortened of [false,true])for(const [index,lastFrame] of (shortened?[7,7,15,15,15,15,22,22]:[15,15,30,30,30,30,45,45]).entries()){
    const run=fixture([actor('enemy')],index+1);
    if(shortened)Reflect.set(run.harness.enemies.get('enemy')!.definition,'stateRules',{durationScale:0.5});
    assert.equal(run.start('enemy'),'started');run.frame(16);
    assert.ok(run.hits[0].hit.damage>0);assert.equal(run.conditions.hasState('enemy','stun'),true);
    run.conditions.update((lastFrame+1)*60);assert.equal(run.conditions.hasState('enemy','stun'),true);
    run.conditions.update(60);assert.equal(run.conditions.hasState('enemy','stun'),false);
  }
});

test('one-handed and two-handed action plans keep their own swing and hit frames with one mana charge',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const wardrobe=loadWardrobeCatalog();
  const single=wardrobe.skillStances.warrior['longsword:empty'].actions['giant-blow']!;
  for(const [plan,swingFrame,hitFrame,effect] of [[single,7,11,'giant-blow-swing'],[action,12,16,'giant-blow']] as const){
    const run=fixture([actor('enemy')],1,plan);assert.equal(run.start('enemy'),'started');
    run.frame(swingFrame-1);assert.equal(run.order.length,0);
    run.frame(swingFrame);assert.deepEqual(run.order,[`effect:${effect}`]);
    run.frame(hitFrame-1);assert.equal(run.attempts.length,0);
    run.frame(hitFrame);assert.deepEqual(run.attempts.map(hit=>hit.cueIndex),[0,1]);
    assert.equal(run.feedback.length,1);assert.equal(run.counts().spent,48);
  }
});
