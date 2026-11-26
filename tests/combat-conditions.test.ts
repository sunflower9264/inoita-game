import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseBattle} from '../src/application/content-validation.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {applyCombatOperation} from '../src/domain/combat-operation.ts';
import {rollPhysicalHit,type PhysicalFighter} from '../src/domain/physical-hit.ts';
import {passiveModifiers} from '../src/domain/passive-skills.ts';
import {skillEffectNames} from '../src/domain/skill-action.ts';
import {attackCycleFrames} from '../src/domain/combat-tempo.ts';
import {statusColorMatrix} from '../src/domain/status-color.ts';
import type {BattleBuffEffect} from '../src/domain/battle.ts';

const catalog=parseBattle(JSON.parse(fs.readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')));

function conditionEffect(overrides:Partial<BattleBuffEffect>={}):BattleBuffEffect {
  return {durationMs:1000,tickMs:0,modifiers:[],states:[],periodic:[],...overrides};
}

test('same-name state refresh replaces its source while snapshots remain detached from later changes',()=>{
  const conditions=new CombatConditions();
  conditions.applyState('ally','stealthed',1000,'first');
  conditions.applyState('ally','stealthed',2000,'second');
  const states=conditions.activeStates('ally');assert.deepEqual(states,['stealthed']);
  assert.equal(conditions.snapshot('ally').length,1);
  assert.equal(conditions.snapshot('ally')[0].sourceId,'second');
  conditions.removeState('ally','stealthed','first');assert.deepEqual(conditions.activeStates('ally'),['stealthed']);
  conditions.removeState('ally','stealthed');assert.deepEqual(conditions.activeStates('ally'),[]);
  assert.deepEqual(states,['stealthed']);
});

test('unloading a buff clears its declared state even after another source refreshed that state',()=>{
  const conditions=new CombatConditions();
  conditions.applyBuff('ally','attack-stun',1,conditionEffect({states:['stun']}),'enemy-a');
  conditions.applyBuff('ally','critical-hit-stun',1,conditionEffect({durationMs:3000,states:['stun']}),'enemy-b');
  conditions.applyState('ally','stun',4000,'enemy-c');
  assert.deepEqual(conditions.snapshot('ally').filter(item=>item.kind==='state').map(item=>item.sourceId),['enemy-c']);
  conditions.removeBuff('ally','attack-stun');
  assert.equal(conditions.canAct('ally'),true);
  assert.equal(conditions.hasBuff('ally','critical-hit-stun'),true);
  conditions.applyState('ally','stun',4000,'enemy-c');
  conditions.update(3000);
  assert.equal(conditions.canAct('ally'),true);
});

test('direct state refresh detaches the current node from its old buff without removing the buff',()=>{
  const conditions=new CombatConditions();
  conditions.applyBuff('ally','whist',5,conditionEffect({states:['stealthed'],
    modifiers:[{attribute:'physicalDamageRate',operation:{kind:'add',amount:300}}]}),'caster');
  conditions.applyState('ally','stealthed',2000,'other');
  conditions.removeState('ally','stealthed','caster');
  assert.equal(conditions.attribute('ally','physicalDamageRate',0),300);
  assert.equal(conditions.hasState('ally','stealthed'),true);
  assert.deepEqual(conditions.snapshot('ally').filter(item=>item.kind==='state').map(item=>item.sourceId),['other']);
  conditions.removeState('ally','stealthed');
  assert.equal(conditions.hasState('ally','stealthed'),false);
  assert.equal(conditions.hasBuff('ally','whist'),true);
  conditions.update(1000);assert.equal(conditions.attribute('ally','physicalDamageRate',0),0);
});

test('equal or stronger buff refresh replaces its states and source while weaker application changes nothing',()=>{
  const conditions=new CombatConditions();
  const effect=conditionEffect({states:['stealthed'],maxStacks:3});
  conditions.applyBuff('ally','whist',5,effect,'first');
  conditions.update(250);
  const before=conditions.captureState();
  assert.equal(conditions.applyBuff('ally','whist',4,effect,'weak'),false);
  assert.deepEqual(conditions.captureState(),before);
  conditions.applyBuff('ally','whist',5,effect,'second');
  assert.equal(conditions.snapshot('ally').filter(item=>item.kind==='state').length,1);
  assert.ok(conditions.snapshot('ally').every(item=>item.sourceId==='second'&&item.remainingMs===1000));
  conditions.applyBuff('ally','whist',6,conditionEffect({states:['immobilized'],maxStacks:3}),'strong');
  assert.equal(conditions.hasState('ally','stealthed'),false);
  assert.equal(conditions.hasState('ally','immobilized'),true);
});

test('buff stacks scale an operation once, cap layers and survive capture and restore',()=>{
  const conditions=new CombatConditions();
  const effect=conditionEffect({durationMs:2000,maxStacks:5,states:['ambush'],
    modifiers:[{attribute:'physicalAttack',operation:{kind:'increase-thousandth',ratePerThousand:80}}]});
  conditions.applyBuff('ally','storm-of-frenzy',10,effect,'caster');
  conditions.applyBuff('ally','storm-of-frenzy',10,effect,'caster');
  assert.equal(conditions.attribute('ally','physicalAttack',1000),1160);
  for(let i=0;i<5;i++)conditions.applyBuff('ally','storm-of-frenzy',10,effect,'caster');
  assert.equal(conditions.snapshot('ally')[0].stackCount,5);
  assert.equal(conditions.attribute('ally','physicalAttack',1000),1400);
  conditions.update(500);
  const saved=conditions.captureState();
  conditions.clear();conditions.restoreState(saved);
  assert.equal(conditions.snapshot('ally')[0].stackCount,5);
  assert.equal(conditions.snapshot('ally')[0].sourceId,'caster');
  conditions.update(1500);
  assert.equal(conditions.attribute('ally','physicalAttack',1000),1000);
  assert.equal(conditions.hasState('ally','ambush'),false);
});

test('new and refreshed buffs apply their modifiers before older buffs',()=>{
  const conditions=new CombatConditions();
  const increase=conditionEffect({modifiers:[{attribute:'physicalAttack',operation:{kind:'add',amount:20}}]});
  const replace=conditionEffect({modifiers:[{attribute:'physicalAttack',operation:{kind:'set',amount:100}}]});
  conditions.applyBuff('ally','enrage',1,increase);
  conditions.applyBuff('ally','rampage',1,replace);
  assert.equal(conditions.attribute('ally','physicalAttack',50),120);
  conditions.applyBuff('ally','enrage',1,increase);
  assert.equal(conditions.attribute('ally','physicalAttack',50),100);
});

test('movement, actions, hostile targeting, damage immunity and automatic approach are independent',()=>{
  const conditions=new CombatConditions();
  conditions.applyState('actor','immobilized',1000);
  assert.equal(conditions.canMove('actor'),false);
  assert.equal(conditions.canAct('actor'),true);
  assert.equal(conditions.canTarget('actor'),true);
  conditions.removeState('actor','immobilized');
  conditions.applyState('actor','stealthed',1000);
  assert.equal(conditions.canTarget('actor'),false);
  assert.equal(conditions.canTarget('actor',{hostile:false}),true);
  assert.equal(conditions.canReceiveDamage('actor'),true);
  conditions.applyState('actor','damage-immune',1000);
  assert.equal(conditions.canReceiveDamage('actor'),false);
  conditions.removeState('actor','stealthed');
  assert.equal(conditions.canTarget('actor'),true);
  conditions.applyState('actor','ambush',1000);
  assert.equal(conditions.canMove('actor'),true);
  assert.equal(conditions.canAct('actor'),true);
  assert.equal(conditions.canAutoApproach('actor'),false);
  conditions.applyState('actor','sleep',1000);
  assert.equal(conditions.canAct('actor'),false);
  assert.equal(conditions.canMove('actor'),false);
});

test('a periodic callback that refreshes its buff starts a fresh lifetime without advancing it twice',()=>{
  const conditions=new CombatConditions();
  const effect=conditionEffect({tickMs:100,states:['stun'],periodic:[{kind:'fixed-damage',amount:1}]});
  conditions.applyBuff('enemy','blood-curse',1,effect,'first');
  let ticks=0;
  conditions.update(1000,()=>{
    ticks++;
    conditions.applyBuff('enemy','blood-curse',2,effect,'second');
  });
  assert.equal(ticks,1);
  assert.ok(conditions.snapshot('enemy').every(item=>item.remainingMs===1000&&item.sourceId==='second'));
});

test('removing an actor from a periodic callback stops remaining effects and pulses',()=>{
  const conditions=new CombatConditions();
  conditions.applyBuff('enemy','blood-curse',1,conditionEffect({tickMs:100,
    periodic:[{kind:'fixed-damage',amount:1},{kind:'visual',effect:'blood-curse-pulse'}]}),'caster');
  let ticks=0;
  conditions.update(1000,()=>{ticks++;conditions.remove('enemy');});
  assert.equal(ticks,1);
  assert.deepEqual(conditions.snapshot('enemy'),[]);
});

test('battle content accepts named effects and rejects source attribute numbers',()=>{
  const darkStrike=catalog.skills['dark-strike'].action!.combatUnits![2];
  assert.ok(darkStrike.effect==='buff');
  assert.equal(darkStrike.buff,'dark-strike');
  assert.equal(darkStrike.ranks[0].effect.modifiers[0].attribute,'skillDamageBonus');
  const invalid=structuredClone(catalog);
  const invalidUnit=invalid.skills['dark-strike'].action!.combatUnits![2];
  assert.ok(invalidUnit.effect==='buff');
  invalidUnit.ranks[0].effect.modifiers[0].attribute=34 as never;
  assert.throws(()=>parseBattle(invalid));
});

test('native buff strength refreshes only at equal or stronger power and expires at its own duration',()=>{
  const conditions=new CombatConditions();
  const unit=catalog.skills['dark-strike'].action!.combatUnits![2];
  assert.ok(unit.effect==='buff');
  const first=unit.ranks[0].effect,second=unit.ranks[1].effect;
  assert.equal(first.durationMs,4560);
  assert.deepEqual(first.modifiers.find(item=>item.attribute==='skillDamageBonus')?.operation,{kind:'add',amount:210});
  assert.equal(conditions.applyBuff('player',unit.buff!,unit.ranks[0].strength,first),true);
  conditions.update(1000);
  assert.equal(conditions.applyBuff('player',unit.buff!,unit.ranks[0].strength-1,second),false);
  assert.equal(conditions.snapshot('player')[0].remainingMs,3620);
  assert.equal(conditions.attribute('player','skillDamageBonus',0),210);
  assert.equal(conditions.applyBuff('player',unit.buff!,unit.ranks[1].strength,second),true);
  assert.equal(conditions.attribute('player','skillDamageBonus',0),230);
  conditions.update(5000);
  assert.equal(conditions.attribute('player','skillDamageBonus',0),0);
});

test('sleep and stun disable actions until their durations expire or training resets',()=>{
  const conditions=new CombatConditions();
  conditions.applyState('enemy','sleep',3000);
  assert.equal(conditions.cannotAct('enemy'),true);
  conditions.update(2999);assert.equal(conditions.cannotAct('enemy'),true);
  conditions.update(1);assert.equal(conditions.cannotAct('enemy'),false);
  conditions.applyState('player','stun',1000);conditions.clear();assert.equal(conditions.snapshot('player').length,0);
});

test('demon shield buff changes the next native hit roll, then expires',()=>{
  const conditions=new CombatConditions();
  const unit=catalog.skills['demon-s-shield'].action!.combatUnits![0];
  assert.ok(unit.effect==='buff');
  const base:PhysicalFighter={level:1,physicalAttack:100,hitBase:100,hitBonus:0,evasionBase:10,evasionBonus:0,
    criticalRate:100,criticalResistance:0,criticalDamage:1000,criticalDamageResistance:0,
    weaponBlock:0,shieldBlock:0,physicalResistance:0};
  const roll=()=>.05;
  assert.equal(rollPhysicalHit(base,base,roll).kind,'critical');
  conditions.applyBuff('defender',unit.buff!,unit.ranks[0].strength,unit.ranks[0].effect);
  assert.equal(conditions.fighter('defender',base).shieldBlock,70);
  assert.equal(rollPhysicalHit(base,conditions.fighter('defender',base),roll).kind,'shield-block');
  conditions.update(15000);
  assert.equal(rollPhysicalHit(base,conditions.fighter('defender',base),roll).kind,'critical');
});

test('an action-scoped critical boost changes its strike and clears after the action',()=>{
  const conditions=new CombatConditions();
  const boost=catalog.skills['continuous-slash'].action!.combatUnits![0];
  assert.ok(boost.effect==='set-attribute');
  const fighter:PhysicalFighter={level:1,physicalAttack:100,hitBase:100,hitBonus:0,evasionBase:10,evasionBonus:0,
    criticalRate:100,criticalResistance:0,criticalDamage:1000,criticalDamageResistance:0,
    weaponBlock:0,shieldBlock:0,physicalResistance:0};
  assert.equal(rollPhysicalHit(fighter,fighter,()=>.2).kind,'hit');
  conditions.setTemporaryAttribute('player',boost.attribute!,applyCombatOperation(conditions.attribute('player',boost.attribute!,fighter.criticalRate),boost.ranks[0]));
  assert.equal(rollPhysicalHit(conditions.fighter('player',fighter),fighter,()=>.2).kind,'critical');
  conditions.clearTemporaryAttribute('player',boost.attribute!);
  assert.equal(rollPhysicalHit(conditions.fighter('player',fighter),fighter,()=>.2).kind,'hit');
});

test('Assassin Sword subtracts its temporary hit rate only during its strike',()=>{
  const conditions=new CombatConditions();
  const penalty=catalog.skills['assassin-s-sword'].action!.combatUnits![1];
  assert.ok(penalty.effect==='set-attribute');
  const fighter:PhysicalFighter={level:1,physicalAttack:100,hitBase:100,hitBonus:0,evasionBase:10,evasionBonus:0,
    criticalRate:0,criticalResistance:0,criticalDamage:1000,criticalDamageResistance:0,
    weaponBlock:0,shieldBlock:0,physicalResistance:0};
  const strike=()=>rollPhysicalHit(fighter,fighter,()=>.3,100,0,conditions.attribute('player','assassinSwordHitAdjustment',0));
  assert.equal(strike().kind,'hit');
  conditions.setTemporaryAttribute('player',penalty.attribute!,applyCombatOperation(conditions.attribute('player',penalty.attribute!,0),penalty.ranks[0]));
  assert.equal(conditions.attribute('player','assassinSwordHitAdjustment',0),-400);
  assert.equal(strike().kind,'miss');
  conditions.clearTemporaryAttribute('player',penalty.attribute!);
  assert.equal(strike().kind,'hit');
});

test('buffed defense rate and flat resistance change damage after the native defense formula',()=>{
  const conditions=new CombatConditions();
  const fighter:PhysicalFighter={level:10,physicalAttack:100,defense:100,physicalResistanceBonus:120,
    hitBase:100,hitBonus:0,evasionBase:10,evasionBonus:0,criticalRate:0,criticalResistance:0,
    criticalDamage:1000,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:397};
  const before=conditions.fighter('enemy',fighter);
  assert.equal(before.physicalResistance,Math.trunc(1000*100/(100+20*13))+120);
  conditions.applyBuff('enemy','monster-web-fire',100,{durationMs:1000,tickMs:0,modifiers:[
    {attribute:'defenseRate',operation:{kind:'add',amount:500}},
    {attribute:'physicalResistanceBonus',operation:{kind:'subtract',amount:80}}],states:[],periodic:[]});
  const after=conditions.fighter('enemy',fighter);
  assert.equal(after.physicalResistance,Math.trunc(1000*150/(150+20*13))+40);
  assert.notEqual(rollPhysicalHit(fighter,before,()=>.5).damage,rollPhysicalHit(fighter,after,()=>.5).damage);
});

test('passive ranks and current weapon decide attribute writes',()=>{
  const levels=Object.fromEntries(catalog.classes.find(item=>item.id==='warrior')!.skills.map(id=>[id,1]));
  levels['weapon-specializing']=8;
  const loadout={levels};
  const twoHanded=passiveModifiers(catalog,'warrior',loadout,'two-handed');
  const sword=passiveModifiers(catalog,'warrior',loadout,'longsword');
  assert.deepEqual(twoHanded.find(item=>item.attribute==='physicalDamageRate')?.operation,{kind:'add',amount:160});
  for(const modifiers of [twoHanded,sword])
    assert.deepEqual(modifiers.find(item=>item.attribute==='offhandAttackChance')?.operation,{kind:'add',amount:321});
  assert.equal(sword.some(item=>item.attribute==='physicalDamageRate'),false);
});

test('blood curse ticks at native intervals and stops after expiration',()=>{
  const conditions=new CombatConditions();
  const unit=catalog.skills['blood-curse'].action!.combatUnits!.filter(item=>item.effect==='buff').find(item=>item.buff==='blood-curse')!;
  const effect=unit.ranks[0].effect;
  assert.deepEqual(effect.simulationFrames,{lastActiveFrame:90,pulseIntervalFrames:30});
  assert.equal(effect.durationMs,5460);assert.equal(effect.tickMs,1800);
  assert.deepEqual(effect.periodic.map(item=>item.kind),['magic-curse','visual']);
  assert.deepEqual(effect.periodic[1],{kind:'visual',effect:'blood-curse-pulse'});
  assert.ok(skillEffectNames(catalog.skills['blood-curse'].action!).includes('blood-curse-pulse'));
  // 逻辑步 60ms、脉冲每 30 帧一次：第 0 帧首跳，寿命上限是含端点的第 90 帧。
  const ticks:string[]=[],at:number[]=[];let now=0;
  conditions.applyBuff('enemy','blood-curse',unit.ranks[0].strength,effect,'player');
  for(let frame=0;frame<92;frame++){
    now+=60;
    conditions.update(60,tick=>{if(tick.effect.kind==='magic-curse'){ticks.push(`${tick.sourceId}:${tick.targetId}`);at.push(now);}});
  }
  assert.deepEqual(ticks,['player:enemy','player:enemy','player:enemy','player:enemy']);
  assert.deepEqual(at,[60,1860,3660,5460]);
  assert.equal(conditions.snapshot('enemy').length,0);
});

test('named movement and healing effects use their exported buff formulas',()=>{
  const conditions=new CombatConditions();
  const curse=catalog.skills['blood-curse'].action!.combatUnits!.filter(item=>item.effect==='buff').find(item=>item.buff==='blood-curse')!;
  conditions.applyBuff('enemy','blood-curse',curse.ranks[0].strength,curse.ranks[0].effect);
  assert.equal(conditions.attribute('enemy','moveSpeed',1000),300);
  const light=catalog.skills['light-command'].action!.combatUnits!.filter(item=>item.effect==='buff').find(item=>item.buff==='light-command')!;
  assert.deepEqual(light.ranks[0].effect.periodic.map(item=>item.kind),['healing']);
  assert.deepEqual(light.ranks[0].effect.periodic[0],{kind:'healing',attribute:'bestNormalDamage',operation:{kind:'multiply-thousandth',ratePerThousand:920}});
});

test('attack speed buffs change action tempo through the native thousandth rate',()=>{
  assert.equal(attackCycleFrames(10,1000,4),10);
  assert.equal(attackCycleFrames(10,500,4),15);
  const enrage=catalog.skills['enrage'].action!.combatUnits!.filter(item=>item.effect==='buff').find(item=>item.buff==='enrage')!;
  assert.deepEqual(enrage.ranks[0].effect.modifiers.map(item=>item.attribute),['attackSpeedRate','maxHealth']);
  const conditions=new CombatConditions();
  conditions.applyBuff('enemy','attack-slow',0,{durationMs:5000,tickMs:0,modifiers:[
    {attribute:'attackSpeedRate',operation:{kind:'multiply-thousandth',ratePerThousand:500}}],states:[],periodic:[]});
  assert.equal(attackCycleFrames(10,conditions.attribute('enemy','attackSpeedRate',1000),4),15);
});

test('buff color cycles decode to screen overlays and expire with the buff',()=>{
  const conditions=new CombatConditions();
  const enrage=catalog.skills['enrage'].action!.combatUnits!.filter(item=>item.effect==='buff').find(item=>item.buff==='enrage')!;
  const effect=enrage.ranks[0].effect;
  assert.equal(effect.appearanceColors?.length,7);
  assert.deepEqual(effect.appearanceColors?.[0],{red:100,green:0,blue:0});
  conditions.applyBuff('player','enrage',enrage.ranks[0].strength,effect);
  assert.deepEqual(statusColorMatrix(conditions.appearanceColors('player')!,0),
    [1-100/255,0,0,0,100,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0]);
  conditions.update(effect.durationMs);
  assert.deepEqual(conditions.appearanceColors('player'),effect.appearanceColors);
  conditions.update(60);
  assert.equal(conditions.appearanceColors('player'),undefined);
});

test('effect variants require their state, buff definition and summon creature',()=>{
  for(const [effect,field] of [['state','state'],['buff','effect'],['summon','creature']] as const){
    const invalid=structuredClone(catalog);
    const unit=Object.values(invalid.skills).flatMap(skill=>skill.action?.combatUnits??[]).find(unit=>unit.effect===effect)!;
    if(unit.effect==='buff')Reflect.deleteProperty(unit.ranks[0],field);
    else Reflect.deleteProperty(unit,field);
    assert.throws(()=>parseBattle(invalid),new RegExp(field));
  }
});

test('ranked combat effects reject missing rank data and misplaced operation operands',()=>{
  const missingRank=structuredClone(catalog);
  const state=missingRank.skills['shield-bash'].action!.combatUnits!.find(unit=>unit.effect==='state')!;
  state.ranks.pop();
  assert.throws(()=>parseBattle(missingRank),/全部技能等级/);
  const invalidOperand=structuredClone(catalog);
  const damage=invalidOperand.skills['dark-strike'].action!.combatUnits!.find(unit=>'source' in unit)!;
  damage.ranks[0].operation={kind:'multiply',amount:2} as never;
  assert.throws(()=>parseBattle(invalidOperand),/未定义字段/);
});


test('periodic events report the current capped stack count for every effect',()=>{
  const conditions=new CombatConditions();
  const effect=conditionEffect({maxStacks:3,tickMs:100,periodic:[
    {kind:'fixed-damage',amount:7},{kind:'visual',effect:'blood-curse-pulse'}]});
  conditions.applyBuff('enemy','blood-curse',1,effect,'caster');
  conditions.applyBuff('enemy','blood-curse',1,effect,'caster');
  const layers:number[]=[];
  conditions.update(1,tick=>layers.push(tick.stackCount));
  assert.deepEqual(layers,[2,2]);
  for(let i=0;i<3;i++)conditions.applyBuff('enemy','blood-curse',1,effect,'caster');
  layers.length=0;
  conditions.update(1,tick=>layers.push(tick.stackCount));
  assert.deepEqual(layers,[3,3]);
});

test('GM invincibility blocks HP damage without affecting mana loss or other capabilities',()=>{
  const conditions=new CombatConditions();
  conditions.setInvincible('ally',true);
  assert.equal(conditions.canLoseHealth('ally'),false);
  assert.equal(conditions.losesMana('ally'),true,'无敌与无限蓝分离，开启无敌仍允许扣除 MP');
  assert.equal(conditions.canReceiveDamage('ally'),true,'GM 无敌不是原版状态 14，不拦非伤害单元');
  assert.equal(conditions.canMove('ally'),true);
  assert.equal(conditions.canAct('ally'),true);
  assert.equal(conditions.canTarget('ally'),true);
  // 调试开关不是战斗状态：不写进快照，也不会被 clear 掉。
  assert.deepEqual(conditions.captureState().states,[]);
  conditions.clear();
  assert.equal(conditions.canLoseHealth('ally'),false);
  assert.equal(conditions.losesMana('ally'),true);
  conditions.setInvincible('ally',false);
  assert.equal(conditions.canLoseHealth('ally'),true);
  assert.equal(conditions.losesMana('ally'),true);
});

test('GM infinite mana blocks MP loss independently from invincibility',()=>{
  const conditions=new CombatConditions();
  conditions.setInfiniteMana('ally',true);
  assert.equal(conditions.isInfiniteMana('ally'),true);
  assert.equal(conditions.losesMana('ally'),false,'GM 无限蓝期间 MP 不扣除');
  assert.equal(conditions.canLoseHealth('ally'),true,'无限蓝不挡战斗 HP 伤害');
  assert.deepEqual(conditions.captureState().states,[]);
  conditions.clear();
  assert.equal(conditions.losesMana('ally'),false);
  conditions.setInfiniteMana('ally',false);
  assert.equal(conditions.isInfiniteMana('ally'),false);
  assert.equal(conditions.losesMana('ally'),true);
});

test('GM invincibility stays independent from the damage-immune state',()=>{
  const conditions=new CombatConditions();
  conditions.setInvincible('ally',true);
  assert.equal(conditions.canLoseHealth('ally'),false);
  assert.equal(conditions.canReceiveDamage('ally'),true);
  conditions.applyState('ally','damage-immune',1000);
  assert.equal(conditions.canLoseHealth('ally'),false);
  assert.equal(conditions.canReceiveDamage('ally'),false);
  conditions.setInvincible('ally',false);
  assert.equal(conditions.canReceiveDamage('ally'),false,'damage-immune 仍然挡住伤害');
  conditions.removeState('ally','damage-immune');
  assert.equal(conditions.canLoseHealth('ally'),true);
  assert.equal(conditions.canReceiveDamage('ally'),true);
});

test('the invincibility and infinite mana ports read and write their shared host sets independently',()=>{
  const invincibleHost=new Set<string>();
  const manaHost=new Set<string>();
  const conditions=new CombatConditions(undefined,{
    has:id=>invincibleHost.has(id),add:id=>invincibleHost.add(id),delete:id=>invincibleHost.delete(id),
  },{
    has:id=>manaHost.has(id),add:id=>manaHost.add(id),delete:id=>manaHost.delete(id),
  });
  conditions.setInvincible('ally',true);
  assert.equal(invincibleHost.has('ally'),true);
  assert.equal(manaHost.has('ally'),false);
  assert.equal(conditions.isInvincible('ally'),true);
  assert.equal(conditions.isInfiniteMana('ally'),false);
  conditions.setInfiniteMana('ally',true);
  assert.equal(manaHost.has('ally'),true);
  assert.equal(conditions.isInfiniteMana('ally'),true);
  assert.equal(conditions.losesMana('ally'),false);
  conditions.setInvincible('ally',false);
  assert.equal(invincibleHost.has('ally'),false);
  assert.equal(manaHost.has('ally'),true);
  conditions.setInfiniteMana('ally',false);
  assert.equal(manaHost.has('ally'),false);
});

test('condition appearance lists track only affected actors and reuse unchanged state reads',()=>{
  const conditions=new CombatConditions();
  assert.equal(conditions.activeStates('empty'),conditions.activeStates('other-empty'));
  conditions.applyState('one','stun',120);conditions.applyState('two','stealthed',1000);
  const appearances=conditions.activeAppearances(),two=appearances.get('two');
  const states=conditions.activeStates('two');
  assert.equal(conditions.activeStates('two'),states);
  conditions.update(60);assert.equal(conditions.activeAppearances().get('two'),two);
  conditions.update(60);assert.equal(conditions.activeAppearances().has('one'),false);
  assert.equal(conditions.activeAppearances().get('two'),two,'其他角色状态到期不重建这一角色');
  const saved=conditions.captureState();conditions.clear();assert.equal(conditions.activeAppearances().size,0);
  conditions.restoreState(saved);assert.ok(conditions.activeAppearances().has('two'));
  conditions.remove('two');assert.equal(conditions.activeAppearances().size,0);
  conditions.applyBuff('numeric','dark-strike',1,{durationMs:1000,tickMs:0,states:[],modifiers:[],periodic:[]});
  assert.equal(conditions.activeAppearances().size,0,'只有数值的增益不加入表现名单');
});
