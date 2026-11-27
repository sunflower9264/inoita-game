import {CombatRuntime} from '../src/domain/combat-runtime.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {selectAttackSplashCenter} from '../src/domain/attack-splash.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {BattleStatKey} from '../src/domain/battle-semantics.ts';
import {CombatController,type Combatant,type CombatPort,type AttackContact} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {PendingEnemyDefeats} from '../src/domain/combat-outcomes.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import type {SkillReactionEvent} from '../src/domain/skill-reactions.ts';
import {moltenReflectionDamage,rollMoltenSplash,moltenSplashTargets} from '../src/domain/molten-armor.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
  ZERO_PRIMARY_ATTRIBUTES,
} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const primary=ZERO_PRIMARY_ATTRIBUTES;
const actor=(id:string,x=0,y=0,team:'party'|'hostile'='hostile'):Combatant=>({id,team,position:{x,y},
  bounds:{x:-4,y:-4,width:8,height:8},facing:'east'});

test('reflection keeps native defense rounding and monster raw-attack basis',()=>{
  assert.equal(moltenReflectionDamage({kind:'character',defense:100,defenseRate:1000},320),64);
  assert.equal(moltenReflectionDamage({kind:'character',defense:101,defenseRate:666},320),53);
  assert.equal(moltenReflectionDamage({kind:'character',defense:-10,defenseRate:500},320),0);
  assert.equal(moltenReflectionDamage({kind:'monster',physicalAttack:100},320),32);
});

test('splash uses strict chance boundaries, consumes a zero-threshold roll, and preserves zero damage success',()=>{
  let rolls=0;
  assert.equal(rollMoltenSplash(65,0,()=>{rolls++;return 0;}),undefined);assert.equal(rolls,1);
  assert.equal(rollMoltenSplash(65,56,()=>54/999),32);
  assert.equal(rollMoltenSplash(65,56,()=>55/999),undefined);
  assert.equal(rollMoltenSplash(0,1000,()=>.99999),0);
});

test('center selection preserves current target and searches by facing score',()=>{
  const source=actor('defender',0,0,'party'),behind=actor('behind',-6),forward=actor('forward',10),tie=actor('tie',10);
  assert.equal(selectAttackSplashCenter(source,[behind,forward,tie],4).targetId,'forward');
  assert.equal(selectAttackSplashCenter(source,[behind,forward],4,{currentTargetId:'behind'}).targetId,'behind');
  const far=actor('far',100);
  assert.deepEqual(selectAttackSplashCenter(source,[far,forward],4,{currentTargetId:'far'}),{center:source.position});
  assert.equal(selectAttackSplashCenter(source,[actor('edge',31)],4).targetId,'edge');
  assert.equal(selectAttackSplashCenter(source,[actor('outside',32)],4).targetId,undefined);
  assert.equal(selectAttackSplashCenter(source,[actor('zero-score',-32)],4).targetId,undefined);
});

test('center scoring uses native integer coordinates and preserves the selected world position',()=>{
  const source=actor('defender',.5,0,'party'),first=actor('first',.2),second=actor('second',.99);
  const selected=selectAttackSplashCenter(source,[first,second],4);
  assert.equal(selected.targetId,'first');
  assert.strictEqual(selected.center,first.position);
});

test('splash uses the native noncircular distance and excludes the attacker only after collecting 16',()=>{
  const source=actor('defender',0,0,'party');
  const near=[actor('axis-in',39),actor('axis-out',40),actor('diagonal-in',28,28),actor('diagonal-out',29,29),
    {...actor('hidden'),states:['stealthed'] as const},actor('friend',0,0,'party')];
  assert.deepEqual(moltenSplashTargets(source,source.position,near,'attacker').map(value=>value.id),['axis-in','diagonal-in']);
  const crowd=[actor('attacker'),...Array.from({length:17},(_,i)=>actor(`other-${i}`))];
  assert.deepEqual(moltenSplashTargets(source,source.position,crowd,'attacker').map(value=>value.id),
    Array.from({length:15},(_,i)=>`other-${i}`));
});

test('reaction retargeting preserves active playback while explicit selection still cancels it',()=>{
  const source=actor('player',0,0,'party'),first=actor('first',10),second=actor('second',12);
  let cancelled=0;
  const actors=[source,first,second];
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor('player'),actor:id=>actors.find(value=>value.id===id),candidates:()=>actors,facing:()=> 'east',
    moveToward:()=>{},stop:()=>{},canStand:()=>true,relocate:()=>{},play:()=>()=>{cancelled++;},frame:()=>{},clearEffects:()=>{}};
  const controller=new CombatController('player',resolveBasicAttack(catalog,catalog.classes[0]),port);
  assert.equal(controller.requestTarget('first'),'started');
  controller.setReactionTarget('second');
  assert.equal(controller.snapshot().targetId,'second');assert.equal(controller.snapshot().state,'attacking');assert.equal(cancelled,0);
  controller.selectTarget('first');assert.equal(cancelled,1);assert.equal(controller.snapshot().targetId,'first');
});

function fixture(t:test.TestContext){
  const conditions=new CombatConditions(),order:string[]=[],events:SkillReactionEvent[]=[],notifications:AttackContact[]=[];
  const fighter={level:1,physicalAttack:100,physicalDamageRate:0,magicDamageRate:0,hitBase:100,hitBonus:1000,
    evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,
    weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:750};
  const defender=createTestMember({id:'player',classId:'dark-knight',maxHealth:1000,maxMana:0,
    panel:{...fighter,maxHealth:1000,maxMana:0,baseDefense:100,defense:150,defenseRate:500}});
  const members=new Map([['player',defender]]);
  const enemyDefinition={...catalog.enemies.find(value=>!!value.basicAttack)!,defeatPresentation:'vanish' as const};
  const enemies=new Map([
    ['attacker',createTestEnemy({key:'attacker',definition:enemyDefinition,health:500,maxHealth:500,level:1})],
    ['nearby',createTestEnemy({key:'nearby',definition:enemyDefinition,health:500,maxHealth:500,level:1})],
  ]);
  const actors=[actor('player',0,0,'party'),actor('attacker',8),actor('nearby',16)];
  const damage={effect:'physical' as const,source:'physicalAttack' as const,attributeWeights:primary,
    ranks:[{fixedAddition:0,operation:{kind:'add' as const,amount:0}}]};
  let selected='attacker',reaction:((event:SkillReactionEvent)=>void)=()=>{};
  let frame=0;const runtime=new CombatRuntime(()=>frame);
  const pendingDefeats=new PendingEnemyDefeats();
  const hitResolution=new CombatHitResolution();
  const removed=new Set<string>();
  const harness=createCombatTestHarness({
    battleCatalog:{...catalog,basicAttacks:{...catalog.basicAttacks,
      [enemyDefinition.basicAttack!.profileId]:{...catalog.basicAttacks[enemyDefinition.basicAttack!.profileId],damage}}},
    conditions,hitResolution,hero:defender,members,enemies,
    activeParty:()=>['player'],
    combatants:()=>actors.filter(value=>!pendingDefeats.has(value.id)&&!removed.has(value.id)),
    combatant:id=>actors.find(value=>value.id===id&&!pendingDefeats.has(id)&&!removed.has(id)),
    currentTargetOf:()=>selected,
    withThreat:false,
    settlementOverrides:{
      isPendingDefeat:id=>pendingDefeats.has(id),
      setReactionTarget:(_actorId,id)=>{selected=id;order.push(`select:${id}`);},
      onEnemyContact:(_enemy,event)=>notifications.push(event),
      onShowHit:(event,hit)=>order.push(`damage:${event.targetId}:${hit.damage}`),
      onEnemyZeroHealth:enemy=>{
        pendingDefeats.add(enemy.key,()=>{},()=>{
          runtime.cancel(`defeat:${enemy.key}`);
          removed.add(enemy.key);
          order.push(`removed:${enemy.key}`);
        });
        runtime.schedule(`defeat:${enemy.key}`,10,()=>pendingDefeats.complete(enemy.key));
      },
      removeEnemy:key=>{removed.add(key);order.push(`removed:${key}`);},
    },
  });
  t.mock.method(harness.stats,'partyPassives',()=>[]);
  t.mock.method(harness.stats,'equipmentRecovery',()=>({lifeDrainPerThousand:0,manaRecoveryPerThousand:0,manaCostPerThousand:0}));
  t.mock.method(harness.stats,'enemyFighter',()=>fighter);
  t.mock.method(harness.stats,'actorAttributes',()=>({physicalAttack:100,magicAttack:0,maxHealth:1000,physicalDamageRate:0,magicDamageRate:0,
    stealthDamageRate:0,primaryAttributes:primary}));
  const baseReact=harness.settlement.react.bind(harness.settlement);
  t.mock.method(harness.settlement,'react',(event:SkillReactionEvent)=>{
    events.push(event);order.push(`react:${event.kind}:${event.ownerId}`);reaction(event);
    return baseReact(event);
  });
  t.mock.method(harness.settlement,'attackProc',()=>order.push('weapon-procs'));
  const set=(id:string,attribute:BattleStatKey,amount:number)=>conditions.setTemporaryAttribute(id,attribute,amount);
  const apply=(id='player',rank=1)=>{
    const buff=catalog.skills['molten-armor'].action!.combatUnits!.find(value=>value.effect==='buff')!;
    assert.equal(buff.effect,'buff');if(buff.effect!=='buff')throw new Error('missing armor buff');
    const data=buff.ranks[rank-1];conditions.applyBuff(id,buff.buff,data.strength,data.effect,id);
    return data;
  };
  const contact=(kind:PhysicalHit['kind']='hit',damageKind:'physical'|'magic'='physical',amount=0,targetId='player')=>
    hitResolution.run(()=>harness.settlement.resolveHitReactions({casterId:'attacker',targetId},{kind,damage:amount},damageKind,'basic-attack'));
  return {harness,conditions,defender,enemies,members,actors,order,events,notifications,set,apply,contact,
    setFocus:(id:string)=>{void id;},
    advanceDeath:()=>{for(let index=0;index<11;index++)runtime.step(++frame);},
    select:(id:string)=>{selected=id;},onReaction:(callback:(event:SkillReactionEvent)=>void)=>{reaction=callback;}};
}

test('all physical successes including zero damage reflect; misses and magic do not',t=>{
  t.mock.method(Math,'random',()=>0);
  for(const kind of ['hit','critical','weapon-block','shield-block'] as const){
    const run=fixture(t);run.apply();run.set('player','fireSplashChance',0);run.contact(kind);
    assert.equal(run.enemies.get('attacker')!.health,452);
    assert.equal(run.enemies.get('nearby')!.health,500);
    assert.equal(run.events.filter(event=>event.kind==='molten-reflection-completed').length,1);
  }
  for(const [kind,damageKind] of [['miss','physical'],['hit','magic'],['critical','magic'],['shield-block','magic']] as const){
    const run=fixture(t);run.apply();run.contact(kind,damageKind);
    assert.equal(run.enemies.get('attacker')!.health,500);
    assert.equal(run.events.some(event=>event.kind==='molten-reflection-completed'),false);
  }
});

test('host reads defense after block reactions and preserves direct, splash, defender, attacker, wrath order',t=>{
  t.mock.method(Math,'random',()=>0);
  const run=fixture(t);run.apply();run.set('player','fireSplashChance',1000);
  run.onReaction(event=>{if(event.kind==='physical-block')run.conditions.applyBuff('player','guardian-of-darkness',1,
    {durationMs:1000,tickMs:0,modifiers:[{attribute:'defenseRate',operation:{kind:'add',amount:500}}],states:[],periodic:[]});});
  run.contact('shield-block');
  assert.equal(run.enemies.get('attacker')!.health,436);assert.equal(run.enemies.get('nearby')!.health,468);
  assert.deepEqual(run.order,[
    // 受击者是队伍阵营，所以血之复仇先给三个活动队伍槽各判一次自己的已学等级。
    'react:blood-revenge:player','react:physical-block:player','react:attack-success:attacker','react:physical-flare:attacker','damage:attacker:64','damage:nearby:32',
    'react:molten-reflection-completed:player','react:attack-effects:attacker','react:physical-hit-received:player','weapon-procs',
  ]);
});

test('zero reflection and immune direct recipients still consume splash and reach defender flares',t=>{
  let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return 0;});
  const zero=fixture(t);zero.apply();zero.set('player','defense',0);zero.set('player','fireSplashChance',0);zero.contact();
  assert.equal(rolls,1);assert.equal(zero.order.some(value=>value.startsWith('damage:')),false);
  assert.equal(zero.events.some(event=>event.kind==='molten-reflection-completed'),true);
  const immune=fixture(t);immune.apply();immune.set('player','fireSplashChance',1000);
  immune.conditions.applyState('attacker','damage-immune',1000);immune.contact();
  assert.equal(immune.enemies.get('attacker')!.health,500);assert.equal(immune.enemies.get('nearby')!.health,476);
  assert.equal(rolls,2);
  const selection=fixture(t);selection.apply();selection.set('player','defense',0);selection.set('player','fireSplashChance',1000);
  selection.select('missing');selection.contact();
  assert.ok(selection.order.includes('select:attacker'));
  assert.equal(selection.order.some(value=>value.startsWith('damage:')),false);
});

test('accepted reflection and splash notify monster AI without recursively entering hit reactions',t=>{
  t.mock.method(Math,'random',()=>0);
  const run=fixture(t);run.harness.setEnemiesRunning(true);run.apply();run.set('player','fireSplashChance',1000);
  run.contact();
  assert.deepEqual(run.notifications,[{casterId:'player',targetId:'attacker'},{casterId:'player',targetId:'nearby'}]);
  assert.equal(run.events.filter(event=>event.kind==='attack-success').length,1);
  run.notifications.length=0;run.conditions.applyState('attacker','damage-immune',1000);run.contact();
  assert.deepEqual(run.notifications,[{casterId:'player',targetId:'nearby'}]);
  run.notifications.length=0;run.set('player','defense',0);run.contact();assert.equal(run.notifications.length,0);
});

test('positive direct armor damage applies to party targets only when accepted',t=>{
  const run=fixture(t);run.harness.setEnemiesRunning(true);
  run.members.set('ally',run.defender);
  for(const targetId of ['ally','player']){
    const event={casterId:'attacker',targetId};
    run.defender.player.health=1000;
    run.harness.settlement.moltenDirectDamage(event,1);
    assert.equal(run.defender.player.health,999,targetId);
    const health=run.defender.player.health;
    run.harness.settlement.moltenDirectDamage(event,0);
    assert.equal(run.defender.player.health,health,'零伤害不结算');
    run.conditions.applyState(targetId,'damage-immune',1000);
    run.harness.settlement.moltenDirectDamage(event,1);
    assert.equal(run.defender.player.health,health,'免疫状态不结算');
    run.conditions.clear();
  }
  assert.equal(run.events.length,0);
});

test('monster and summoned armor use raw physical attack, and attacker fire permission uses live reflection value',t=>{
  t.mock.method(Math,'random',()=>0);
  for(const summoned of [false,true]){
    const run=fixture(t);if(summoned)Object.assign(run.enemies.get('nearby')!,{summonedBy:'player'});
    run.apply('nearby');run.set('nearby','fireSplashChance',0);run.set('nearby','physicalDamageRate',5000);
    run.set('nearby','defense',10000);run.set('nearby','defenseRate',5000);
    run.contact('hit','physical',0,'nearby');assert.equal(run.enemies.get('attacker')!.health,468);
    run.set('attacker','moltenReflectionPerThousand',1);run.contact('hit','magic');
    const event=[...run.events].reverse().find(entry=>entry.kind==='attack-effects');
    assert.equal(event?.kind,'attack-effects');if(event?.kind==='attack-effects')assert.equal(event.hasMoltenArmor,true);
    run.apply('attacker');run.set('attacker','moltenReflectionPerThousand',0);run.contact('hit','magic');
    const suppressed=[...run.events].reverse().find(entry=>entry.kind==='attack-effects');
    if(suppressed?.kind==='attack-effects')assert.equal(suppressed.hasMoltenArmor,false);
  }
});

test('a fatal reflection does not cancel splash or the real basic host main damage',t=>{
  t.mock.method(Math,'random',()=>0);
  const run=fixture(t);run.apply();run.set('player','fireSplashChance',1000);run.enemies.get('attacker')!.health=30;
  run.harness.settlement.attackContact({casterId:'attacker',targetId:'player'});
  assert.equal(run.enemies.get('attacker')!.health,0);assert.equal(run.enemies.get('nearby')!.health,476);
  assert.ok(run.defender.player.health<1000);
  run.advanceDeath();
  assert.ok(run.order.indexOf('removed:attacker')>run.order.findIndex(value=>value.startsWith('damage:player:')));
});

test('host center follows its current target, falls back to self when far, and keeps focus semantics',t=>{
  const run=fixture(t);const source=run.actors[0];
  run.select('nearby');
  assert.deepEqual(run.harness.settlement.attackSplashCenter(source,run.actors,4),run.actors[2].position);
  run.actors[2].position={x:100,y:0};
  assert.deepEqual(run.harness.settlement.attackSplashCenter(source,run.actors,4),source.position);
});

test('real catalog preserves all armor ranks, four native units and the final active frame',t=>{
  const run=fixture(t);
  for(const [index,rate] of [320,440,560,680,740,800,860,920].entries()){
    run.conditions.clear();const rank=run.apply('player',index+1);
    assert.equal(run.harness.stats.actorAttribute('player','moltenReflectionPerThousand'),rate);
    assert.equal(rank.effect.modifiers.length,3);assert.ok(rank.effect.appearanceColors?.length);
    assert.equal(rank.effect.applicationEffect,'molten-armor-aura');
    assert.deepEqual(rank.effect.simulationFrames,{lastActiveFrame:300});
    run.conditions.update(18060);assert.equal(run.conditions.hasBuff('player','molten-armor'),true);
    run.conditions.update(60);assert.equal(run.conditions.hasBuff('player','molten-armor'),false);
  }
});
