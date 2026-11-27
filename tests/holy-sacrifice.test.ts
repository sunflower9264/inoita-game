import assert from 'node:assert/strict';
import test from 'node:test';
import type {BattleBuffEffect} from '../src/domain/battle.ts';
import type {Combatant} from '../src/domain/combat.ts';
import {resolveCueTargets} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import {partyBuffTargets} from '../src/domain/party-buff-targets.ts';
import {
  createCombatTestHarness,
  createTestMember,
  defaultTestPanel,
  loadBattleCatalog,
  type TestMemberFixture,
} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const rates=[275,325,358,375,391,408,425,441];
const buffUnit=catalog.skills['holy-sacrifice'].action!.combatUnits![0] as
  {effect:'buff';buff:string;ranks:{strength:number;effect:{durationMs:number;tickMs:number;maxStacks:number;
    simulationFrames:{lastActiveFrame:number;pulseIntervalFrames:number;pulseAfterAgeIncrement?:boolean};
    modifiers:{attribute:string;operation:{kind:string;amount?:number}}[];
    periodic:{kind:string;effect?:string}[]}}[]};

test('eight ranks carry the transfer rate on the frame clock with a ten-frame pulse',()=>{
  buffUnit.ranks.forEach((rank,index)=>{
    const effect=rank.effect;
    assert.deepEqual(effect.modifiers,[{attribute:'damageTransferPerThousand',
      operation:{kind:'add',amount:rates[index]}}],`rank ${index+1}`);
    assert.deepEqual(effect.simulationFrames,{lastActiveFrame:150,pulseIntervalFrames:10,pulseAfterAgeIncrement:true},`rank ${index+1}`);
    assert.equal(effect.tickMs,600);
    assert.equal(effect.maxStacks,1);
    assert.deepEqual(effect.periodic.map(entry=>entry.effect),['starburst-gold','sacrifice-swoosh'],`rank ${index+1}`);
  });
});

test('companion ranks use the same post-increment visual pulse clock',()=>{
  const unit=catalog.skills['holy-sacrifice'].companion!.action!.combatUnits![0];
  assert.equal(unit.effect,'buff');
  if(unit.effect!=='buff')throw new Error('Holy Sacrifice buff missing');
  assert.equal(unit.ranks.length,8);
  for(const rank of unit.ranks)assert.deepEqual(rank.effect.simulationFrames,
    {lastActiveFrame:150,pulseIntervalFrames:10,pulseAfterAgeIncrement:true});
});

test('the cast targets the other party slots on the octagonal grid',()=>{
  const cue=catalog.skills['holy-sacrifice'].action!.events.find(event=>event.kind==='units')!.cues[0];
  assert.equal(cue.target,'party-ally');
  assert.equal(cue.targetRangePx,88);
  assert.equal(cue.targetRangeMetric,'octagonal-grid');
});

test('party-ally keeps the three-slot search but never returns the caster',()=>{
  const caster:Combatant={id:'caster',team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8},facing:'east'};
  const ally:Combatant={...caster,id:'ally',position:{x:32,y:0}};
  const slots=[{actor:caster,active:true,hasDisplay:true},{actor:ally,active:true,hasDisplay:true}];
  assert.deepEqual(partyBuffTargets(caster,slots,11).map(actor=>actor.id),['caster','ally']);
  assert.deepEqual(resolveCueTargets({target:'party-ally',targetRangePx:88},caster,undefined,[caster,ally],slots)
    .map(actor=>actor.id),['ally']);
});

/** 面板只给出一项物防，其余按默认值；保护者的有效防御由此算得。 */
function panel(baseDefense:number,defenseRate:number){
  return defaultTestPanel({
    physicalAttack:0,magicAttack:0,baseDefense,defenseRate,maxHealth:1000,maxMana:100,
    hitBase:0,hitBonus:0,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,
    criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,
    baseMagicResistance:0,offhandShield:false,
  });
}

function fixture({rate=275,protector=true,health=1000}={}){
  const conditions=new CombatConditions();
  const hits:{targetId:string;damage:number}[]=[];
  const members=new Map<string,TestMemberFixture>();
  const pendingDefeats=new Set<string>();
  const addMember=(id:string,defense:number,defenseRate:number)=>{
    const member=createTestMember({
      id,level:10,classId:'priest',health,maxHealth:1000,mana:0,maxMana:100,
      panel:panel(defense,defenseRate),
    });
    members.set(id,member);
    return member;
  };
  const target=addMember('target',0,0),guard=addMember('guard',100,0);
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hitResolution:new CombatHitResolution(),
    hero:target,members,
    activeParty:()=>['target','guard'],
    withThreat:false,
    settlementOverrides:{
      isPendingDefeat:id=>pendingDefeats.has(id),
    },
  });
  harness.stats.actorAttribute=(id,key)=>id==='target'&&key==='damageTransferPerThousand'?rate:0;
  harness.settlement.settleHit=(event,hit)=>{
    if(conditions.canReceiveDamage(event.targetId))hits.push({targetId:event.targetId,damage:hit.damage});
  };
  if(protector)conditions.applyBuff('target','holy-sacrifice',0,
    buffUnit.ranks[0]!.effect as unknown as BattleBuffEffect,'guard');
  const hit:PhysicalHit={kind:'hit',damage:100};
  const run=(damageKind:'physical'|'magic'='physical',damage=hit.damage,{casterId='attacker',targetId='target'}={})=>{
    hit.damage=damage;
    harness.settlement.holySacrificeTransfer({casterId,targetId},hit,damageKind);
    return hit.damage;
  };
  return {conditions,harness,pendingDefeats,members,guard,target,hits,run,hit};
}

test('physical transfer keeps the remainder on the victim and applies the protector defense',()=>{
  const f=fixture();
  assert.equal(f.run('physical'),73,'100 按 275‰ 转走 27，受击者留 73');
  // 保护者有效防御 100，10 级时物理减伤 trunc(1000*100/(100+20*13)) = 277‰，27 点实收 19。
  assert.deepEqual(f.hits,[{targetId:'guard',damage:19}]);
});

test('a damage-immune protector swallows the transfer while the victim still keeps the remainder',()=>{
  const f=fixture();
  f.conditions.applyState('guard','damage-immune',1000);
  assert.equal(f.run('physical'),73);
  assert.equal(f.hits.length,0);
});

test('physical needs a product of at least one thousand and a strictly smaller transfer',()=>{
  const small=fixture();
  assert.equal(small.run('physical',1),1,'1 点伤害乘 275 不足 1000，整次不转移');
  assert.equal(small.hits.length,0);
  const whole=fixture({rate:1000});
  assert.equal(whole.run('physical',100),100,'转移量等于主伤害时余量为 0，整次不转移');
  assert.equal(whole.hits.length,0);
});

test('magic allows a zero transfer and reads the magic resistance instead of the physical one',()=>{
  const zero=fixture();
  assert.equal(zero.run('magic',1),1,'0 点转移不改主伤');
  assert.equal(zero.hits.length,0);
  const f=fixture();
  f.members.get('guard')!.panel={...panel(100,0),baseMagicResistance:500};
  assert.equal(f.run('magic'),73);
  assert.deepEqual(f.hits,[{targetId:'guard',damage:13}],'trunc(27*(1000-500)/1000)');
  const negative=fixture();
  negative.members.get('guard')!.panel={...panel(100,0),baseMagicResistance:-1000};
  assert.equal(negative.run('magic'),73);
  assert.deepEqual(negative.hits,[{targetId:'guard',damage:54}],'负魔抗放大转移量');
});

test('no protector, a departed protector, or no buff leaves the main damage alone',()=>{
  for(const build of [()=>fixture({protector:false}),()=>{const f=fixture();f.harness.fallen.add('guard');return f;},
    ()=>{const f=fixture();f.pendingDefeats.add('guard');return f;}]){
    const f=build();
    assert.equal(f.run('physical'),100);
    assert.equal(f.hits.length,0);
  }
});

test('a protector at zero health still absorbs while it is awaiting defeat',()=>{
  const f=fixture();
  f.members.get('guard')!.player.health=0;
  f.members.get('guard')!.player.mana=0;
  f.harness.hitResolution.run(()=>{
    f.harness.hitResolution.deferDefeat('guard',()=>{});
    assert.equal(f.run('physical'),73);
  });
  assert.deepEqual(f.hits,[{targetId:'guard',damage:19}]);
});

test('the transfer never re-enters the success chain of the protector',()=>{
  const f=fixture();
  const reactions:string[]=[];
  f.harness.settlement.react=event=>reactions.push(`${event.kind}:${event.ownerId}`);
  f.harness.settlement.settleHit=event=>reactions.push(`settle:${event.targetId}`);
  assert.equal(f.run('physical'),73);
  assert.deepEqual(reactions,['settle:guard']);
});


function pulseFixture(){
  const conditions=new CombatConditions(),pulses:{step:number;effect:string}[]=[];
  const effect=buffUnit.ranks[0]!.effect as unknown as BattleBuffEffect;
  const apply=()=>conditions.applyBuff('ally','holy-sacrifice',1,effect,'guard');
  apply();
  const advance=(steps:number,step:number)=>conditions.update(steps*60,tick=>{
    if(tick.effect.kind==='visual')pulses.push({step,effect:tick.effect.effect});
  });
  return {conditions,pulses,apply,advance};
}

test('Holy Sacrifice pulses after each tenth age increment, exactly fifteen pairs before expiry',()=>{
  const run=pulseFixture();
  for(let step=1;step<=9;step++)run.advance(1,step);
  assert.equal(run.pulses.length,0);
  for(let step=10;step<=151;step++)run.advance(1,step);
  assert.deepEqual(run.pulses,Array.from({length:15},(_,i)=>(i+1)*10)
    .flatMap(step=>['starburst-gold','sacrifice-swoosh'].map(effect=>({step,effect}))));
  assert.equal(run.conditions.snapshot('ally').length,1,'寿命含年龄 150 这一处理步');
  run.advance(1,152);
  assert.equal(run.conditions.snapshot('ally').length,0);
  assert.equal(run.pulses.length,30,'到期步不再生成效果');
});

test('catch-up ticks and refreshing Holy Sacrifice preserve its delayed first pulse',()=>{
  const bulk=pulseFixture();bulk.advance(152,152);
  assert.equal(bulk.pulses.length,30);assert.equal(bulk.conditions.snapshot('ally').length,0);
  const run=pulseFixture();run.advance(9,9);assert.equal(run.apply(),true);
  run.advance(9,18);assert.equal(run.pulses.length,0,'刷新后重新等待十步');
  run.advance(1,19);assert.deepEqual(run.pulses.map(pulse=>pulse.effect),['starburst-gold','sacrifice-swoosh']);
});

test('ordinary periodic buffs retain their age-zero first pulse',()=>{
  const conditions=new CombatConditions(),steps:number[]=[];
  const {pulseAfterAgeIncrement:_,...timing}=buffUnit.ranks[0]!.effect.simulationFrames;
  const effect={...buffUnit.ranks[0]!.effect,simulationFrames:timing,
    periodic:[{kind:'fixed-damage',amount:1}]} as unknown as BattleBuffEffect;
  conditions.applyBuff('ally','holy-sacrifice',1,effect,'guard');
  for(let step=1;step<=152;step++)conditions.update(60,()=>steps.push(step));
  assert.deepEqual(steps,Array.from({length:16},(_,i)=>1+i*10));
});
