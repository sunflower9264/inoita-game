import assert from 'node:assert/strict';
import test from 'node:test';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatClock} from '../src/domain/combat-clock.ts';
import {CombatResourceRecovery} from '../src/domain/combat-resources.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import type {SkillReactionEvent} from '../src/domain/skill-reactions.ts';
import {createCombatTestHarness,createTestMember,loadBattleCatalog} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
function shield(rank=1){
  const unit=catalog.skills['demon-s-shield'].action!.combatUnits!.find(value=>value.effect==='buff');
  assert.equal(unit?.effect,'buff');
  if(unit?.effect!=='buff')throw new Error('missing demon shield');
  return {unit,rank:unit.ranks[rank-1]};
}
function fixture(){
  const conditions=new CombatConditions(),clock=new CombatResourceRecovery(),frames=new CombatClock();
  const defender=createTestMember({id:'defender',level:1,health:1000,maxHealth:1000,mana:0,maxMana:100});
  const dead=createTestMember({id:'dead',level:1,health:0,maxHealth:1000,mana:0,maxMana:100});
  const members=new Map([['defender',defender],['dead',dead]]);
  const phases:string[]=[],effects:string[]=[];
  let equipmentManaRecovery=0;
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hero:defender,members,
    activeParty:()=>[...members.keys()],
    withThreat:false,
    settlementOverrides:{
      // 资源脉冲会读持续回复（再生药水）的剩余时间；没有它就当作没有生效中的持续回复。
      activeRegeneration:()=>undefined,
      recoveryPulseDue:()=>true,
      advanceRecoveryClock:()=>{},
      recoverCombatResources:actors=>clock.advanceToFrame(frames.currentFrame,actors),
      onBuffApplication:(_source,_target,effect)=>effects.push(effect),
    },
  });
  harness.stats.equipmentRecovery=()=>({manaRecoveryPerPulse:equipmentManaRecovery,manaCostReductionRate:0,lifeDrainPerThousand:0});
  harness.settlement.react=(event:SkillReactionEvent)=>{phases.push(`${event.kind}:${conditions.hasBuff('defender','mana-recovery')}`);};
  harness.settlement.attackProc=()=>{};
  const cast=(rank=1)=>harness.settlement.skillUnit({casterId:'defender',targetId:'defender',cueIndex:0,
    skill:{id:'demon-s-shield',level:rank,action:catalog.skills['demon-s-shield'].action!}});
  const contact=(outcome:PhysicalHit['kind']='miss',damageKind:'physical'|'magic'='physical',damage=0)=>
    harness.settlement.resolveHitReactions({casterId:'attacker',targetId:'defender'},{kind:outcome,damage},damageKind,'basic-attack');
  return {harness,conditions,clock,defender,dead,phases,effects,cast,contact,
    advance:(delta:number)=>frames.advance(delta,()=>harness.settlement.recoverResources()),
    equipment:(amount:number)=>{equipmentManaRecovery=amount;}};
}

test('all eight shield ranks carry native block rates and semantic independent recovery children',()=>{
  const block=[70,110,170,250,270,290,310,330],recovery=[1200,1800,2700,3900,4200,4500,4800,5100];
  for(let rank=1;rank<=8;rank++){
    const effect=shield(rank).rank.effect,child=effect.reactions?.[0];
    assert.deepEqual(effect.modifiers,[{attribute:'shieldBlock',operation:{kind:'add',amount:block[rank-1]}}]);
    assert.equal(child?.kind,'physical-avoidance');assert.equal(child?.buff.key,'mana-recovery');
    assert.equal(child?.buff.rankPriority,[101,103,106,110,111,112,113,114][rank-1]);
    assert.deepEqual(child?.buff.effect.modifiers,[{attribute:'manaRecoveryPerPulse',
      operation:{kind:'increase-thousandth',ratePerThousand:recovery[rank-1]}}]);
    for(const value of [effect,child!.buff.effect]){
      assert.deepEqual(value.simulationFrames,{lastActiveFrame:225});
      assert.equal(value.durationMs,13560);assert.equal(value.maxStacks,1);assert.equal(value.tickMs,0);
      assert.deepEqual(value.periodic,[]);assert.deepEqual(value.states,[]);assert.equal(value.applicationEffect,undefined);
    }
    assert.deepEqual(child!.buff.effect.reactions,undefined);
  }
});

test('the actual hit host grants recovery before success reactions only for three physical avoidance outcomes',t=>{
  t.mock.method(Math,'random',()=>assert.fail('shield avoidance adds no probability roll'));
  for(const damageKind of ['physical','magic'] as const)for(const outcome of ['miss','hit','critical','weapon-block','shield-block'] as const){
    const run=fixture();run.cast();
    assert.equal(run.conditions.hasBuff('defender','mana-recovery'),false);
    run.contact(outcome,damageKind);
    const applies=damageKind==='physical'&&['miss','weapon-block','shield-block'].includes(outcome);
    assert.equal(run.conditions.hasBuff('defender','mana-recovery'),applies,`${damageKind}:${outcome}`);
    if(applies){
      assert.equal(run.conditions.snapshot('defender').find(value=>value.id==='mana-recovery')?.sourceId,'defender');
      assert.equal(run.harness.stats.actorAttribute('defender','manaRecoveryPerPulse'),17);
      assert.ok(run.phases.every(phase=>phase.endsWith(':true')));
    }
    assert.equal(run.conditions.hasBuff('attacker','mana-recovery'),false);
    assert.equal(run.defender.player.mana,0);assert.equal(run.effects.length,0);
  }
  const absent=fixture();absent.contact();
  assert.equal(absent.conditions.hasBuff('defender','mana-recovery'),false);
});

test('the trigger uses the buff owner as source and survives separately after the parent expires',()=>{
  const run=fixture(),parent=shield().rank;
  run.conditions.applyBuff('defender','demon-s-shield',parent.strength,parent.effect,'another-caster');
  run.conditions.update(6000);run.contact();
  const child=()=>run.conditions.snapshot('defender').find(value=>value.id==='mana-recovery');
  assert.equal(child()?.sourceId,'defender');
  run.conditions.update(7620);
  assert.equal(run.conditions.hasBuff('defender','demon-s-shield'),false);
  assert.ok(child());assert.equal(run.conditions.attribute('defender','shieldBlock',0),0);
  const before=child();run.contact();assert.deepEqual(child(),before);
  run.conditions.update(5940);assert.ok(child());
  run.conditions.update(60);assert.equal(child(),undefined);
});

test('equal avoidance refreshes one child layer while a lower parent cannot replace or refresh a stronger child',()=>{
  const run=fixture();run.cast(8);run.contact();run.conditions.update(3000);
  const current=()=>run.conditions.snapshot('defender').find(value=>value.id==='mana-recovery')!;
  const before=current();
  run.conditions.removeBuff('defender','demon-s-shield');run.cast(1);run.contact();
  assert.deepEqual(current(),before);assert.equal(run.harness.stats.actorAttribute('defender','manaRecoveryPerPulse'),48);
  run.cast(8);assert.deepEqual(current(),before);
  run.contact('weapon-block');assert.equal(current().stackCount,1);
  assert.ok(current().remainingMs>before.remainingMs);assert.equal(current().sourceId,'defender');
  run.conditions.update(13560);assert.ok(current());
  run.conditions.update(60);assert.equal(current(),undefined);
});

test('recovery reads the child and equipment on the unchanged shared pulse, caps mana and does not revive the dead',()=>{
  const run=fixture();run.advance(1800);
  run.defender.player.mana=0;run.equipment(1);run.cast();
  const phase=run.clock.captureState();run.contact('shield-block');
  assert.deepEqual(run.clock.captureState(),phase);assert.equal(run.defender.player.mana,0);
  const reaction=shield().rank.effect.reactions![0];assert.ok('buff' in reaction);
  const child=reaction.buff;
  run.conditions.applyBuff('dead',child.key,child.rankPriority,child.effect,'dead');
  run.advance(59);assert.equal(run.defender.player.mana,0);
  run.advance(1);assert.equal(run.defender.player.mana,19);
  assert.equal(run.dead.player.mana,0);assert.equal(run.dead.player.health,0);
  run.defender.player.mana=99;run.advance(1860);assert.equal(run.defender.player.mana,100);
});
