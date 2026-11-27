import {resolveSkillUnitSequence} from '../src/domain/skill-unit-sequence.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {NumericCombatUnit,ResolvedBasicAttack,SkillAction} from '../src/domain/battle.ts';
import type {BattleStatKey} from '../src/domain/battle-semantics.ts';
import type {Combatant} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {createCombatTestHarness,createTestEnemy,createTestMember,defaultTestPanel,loadBattleCatalog,ZERO_PRIMARY_ATTRIBUTES} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();

test('nested hits finalize each actor once, in first lethal-hit order, after the outer chain',()=>{
  const resolution=new CombatHitResolution(),order:string[]=[];
  resolution.run(()=>{
    resolution.deferDefeat('source',()=>order.push('source-old'));
    resolution.run(()=>{
      resolution.deferDefeat('target',()=>order.push('target'));
      resolution.deferDefeat('source',()=>order.push('source-latest'));
      assert.equal(resolution.isAwaitingDefeat('source'),true);
    });
    assert.equal(order.length,0);order.push('main-damage');
  });
  assert.deepEqual(order,['main-damage','source-latest','target']);
  assert.equal(resolution.isAwaitingDefeat('source'),false);
  resolution.deferDefeat('outside',()=>order.push('outside'));
  assert.equal(order.at(-1),'outside');
});

test('an interrupted resolution still closes its pending health checks',()=>{
  const resolution=new CombatHitResolution();let finalized=0;
  assert.throws(()=>resolution.run(()=>{
    resolution.deferDefeat('actor',()=>finalized++);throw new Error('interrupted');
  }),/interrupted/);
  assert.equal(finalized,1);assert.equal(resolution.isAwaitingDefeat('actor'),false);
  resolution.run(()=>assert.equal(finalized,1));
});

const primary=ZERO_PRIMARY_ATTRIBUTES;
const unit:NumericCombatUnit={effect:'physical',source:'physicalAttack',attributeWeights:primary,
  ranks:[{fixedAddition:0,operation:{kind:'add',amount:0}}]};

function fixture(){
  const order:string[]=[],conditions=new CombatConditions(),fallen=new Set<string>(),hitResolution=new CombatHitResolution();
  const member=(id:string,health:number)=>createTestMember({id,level:1,health,maxHealth:1000,maxMana:0,
    panel:{attributes:primary,maxHealth:1000,maxMana:0}});
  const members=new Map([['player',member('player',30)],['ally',member('ally',500)]]);
  const enemy=createTestEnemy({key:'enemy',definition:catalog.enemies[0],health:100,maxHealth:100,level:1,elite:false});
  const enemies=new Map([['enemy',enemy]]);
  let react=()=>{},useRealReactions=false;
  let directorHealthChanged:((...values:unknown[])=>boolean)|undefined;
  let capture:unknown;
  const combatant=(id:string):Combatant|undefined=>{
    if(fallen.has(id))return undefined;
    const m=members.get(id);
    if(m)return m.player.health>0||hitResolution.isAwaitingDefeat(id)
      ?{id,team:'party',position:{x:0,y:0},bounds:{x:-8,y:-8,width:16,height:16},states:conditions.activeStates(id),facing:'south'}:undefined;
    const e=enemies.get(id);
    if(!e||!e.present||e.pendingDefeat)return undefined;
    return {id,team:'hostile',position:{x:0,y:0},bounds:e.bounds??{x:-8,y:-8,width:16,height:16},states:conditions.activeStates(id),facing:'south'};
  };
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hitResolution,hero:members.get('player'),members,enemies,
    activeParty:()=>['player','ally'],
    combatant,combatants:()=>[...members.keys(),...enemies.keys()].flatMap(id=>{const actor=combatant(id);return actor?[actor]:[];}),
    memberActorDefinition:()=>catalog.classes[0].actor,
    withThreat:false,
    settlementOverrides:{
      isFallen:id=>fallen.has(id),
      isOneHitKill:()=>false,
      onEnemyDamaged:(targetEnemy,before,proposed)=>{
        const interrupted=!!directorHealthChanged?.(targetEnemy.definition.id,before.health,proposed,before.maxHealth,
          {id:targetEnemy.key,map:'test',x:0,y:0});
        return {interrupted,captured:interrupted&&!!capture};
      },
      onEnemyZeroHealth:targetEnemy=>{
        order.push('enemy-controller-dispose');
        enemies.delete(targetEnemy.key);
        order.push('enemy-removed');
        order.push('enemy-death-sound');
      },
      removeEnemy:key=>{enemies.delete(key);order.push('enemy-removed');},
      onShowHit:event=>order.push(`hit:${event.targetId}`),
      onDropMana:()=>order.push('mana'),
      onMemberDefeated:id=>{fallen.add(id);conditions.remove(id);order.push(`defeat:${id}`);},
    },
  });
  harness.stats.equipmentAttack=()=>({damage:unit} as unknown as ResolvedBasicAttack);
  const baseReactions=harness.settlement.resolveHitReactions.bind(harness.settlement);
  harness.settlement.resolveHitReactions=(...args)=>useRealReactions?baseReactions(...args):react();
  const direct=(id:string,amount:number)=>harness.settlement.settleHit({casterId:'ally',targetId:id},
    {kind:'hit',damage:amount},id==='enemy'?enemies.get('enemy'):undefined);
  const hit=(kind:'basic'|'skill',targetId='ally')=>kind==='basic'
    ?harness.settlement.attackContact({casterId:'player',targetId})
    :harness.settlement.skillUnit({casterId:'player',targetId,cueIndex:0,skill:{id:'test-strike',action:{combatUnits:[unit]} as unknown as SkillAction}});
  return {harness,members,enemies,enemyState:enemy,order,conditions,fallen,direct,hit,
    onReaction:(callback:()=>void)=>{react=callback;},
    useRealReactions:()=>{useRealReactions=true;},
    setDirector:(fn:typeof directorHealthChanged,captureState?:unknown)=>{directorHealthChanged=fn;capture=captureState;},
    combatant};
}

test('圣徒之牺牲按敌人普攻的实际伤害分摊，保护者在本次命中结束后倒地',()=>{
  const run=fixture();
  run.useRealReactions();
  run.harness.stats.actorAttribute=(id:string,key:BattleStatKey)=>run.conditions.attribute(id,key,0);
  const buff=catalog.skills['holy-sacrifice'].action!.combatUnits![0];
  assert.equal(buff.effect,'buff');
  const firstRank=buff.ranks[0];
  run.conditions.applyBuff('ally',buff.buff,firstRank.strength,firstRank.effect,'player');

  const attack=()=>run.harness.settlement.attackContact({casterId:'enemy',targetId:'ally',basicAttack:{damage:unit} as unknown as ResolvedBasicAttack});
  attack();
  assert.equal(run.members.get('ally')!.player.health,427);
  assert.equal(run.members.get('player')!.player.health,3);
  attack();
  assert.equal(run.members.get('ally')!.player.health,354);
  assert.equal(run.members.get('player')!.player.health,0);
  assert.deepEqual(run.order.filter(event=>event.startsWith('hit:')||event.startsWith('defeat:')),
    ['hit:player','hit:ally','hit:player','hit:ally','defeat:player']);
});

test('a capture conversion removes the source enemy instead of leaving a one-HP corpse',()=>{
  const run=fixture();let healthWrites=0;
  run.setDirector(()=>true,{map:'test',visit:0});
  const baseSet=run.harness.settlement['port' as never] as {setEnemyHealth:()=>void};
  baseSet.setEnemyHealth=()=>{healthWrites++;};
  run.direct('enemy',500);
  assert.ok(run.order.includes('enemy-removed'),'捕捉后源怪立刻退场');
  assert.equal(healthWrites,0,'不再把源怪写成 1 点血留在场上');
});

test('a story event interruption still leaves the enemy at one HP for the cutscene',()=>{
  const run=fixture();const writes:number[]=[];
  run.setDirector(()=>true);
  const port=run.harness.settlement['port' as never] as {setEnemyHealth:(_id:string,value:number)=>void};
  port.setEnemyHealth=(_id:string,value:number)=>{writes.push(value);};
  run.direct('enemy',500);
  assert.deepEqual(writes,[1]);
  assert.equal(run.order.includes('enemy-removed'),false);
});

for(const kind of ['basic','skill'] as const){
  test(`${kind} host completes main damage after a nested hit reduces the attacker to zero`,()=>{
    const run=fixture();
    run.conditions.applyBuff('player','dark-strike',1,{durationMs:1000,tickMs:0,modifiers:[],states:[],periodic:[]});
    run.onReaction(()=>{
      run.direct('player',30);
      assert.equal(run.members.get('player')!.player.health,0);
      assert.equal(run.fallen.has('player'),false);
      assert.ok(run.combatant('player'));
      assert.equal(run.conditions.hasBuff('player','dark-strike'),true);
      run.order.push('remaining-reactions');
    });
    run.hit(kind);
    assert.equal(run.members.get('ally')!.player.health,400);
    assert.ok(run.order.indexOf('hit:ally')>run.order.indexOf('remaining-reactions'));
    assert.ok(run.order.indexOf('defeat:player')>run.order.indexOf('hit:ally'));
    assert.equal(run.fallen.has('player'),true);
    assert.equal(run.combatant('player'),undefined);
    assert.equal(run.conditions.hasBuff('player','dark-strike'),false);
  });

  test(`${kind} host lets later healing in the same chain save the zero-HP attacker`,()=>{
    const run=fixture();
    run.onReaction(()=>{run.direct('player',30);run.harness.settlement.restoreHealth('player',20);});
    run.hit(kind);
    assert.equal(run.members.get('player')!.player.health,20);
    assert.equal(run.members.get('ally')!.player.health,400);
    assert.equal(run.fallen.has('player'),false);
    assert.equal(run.order.some(value=>value.startsWith('defeat:')),false);
  });
}

test('a nested skill unit shares the outer basic-hit boundary',()=>{
  const run=fixture();let nested=false;
  run.onReaction(()=>{
    if(nested){run.direct('player',30);return;}
    nested=true;run.hit('skill');
    assert.equal(run.fallen.has('player'),false);
    run.harness.settlement.restoreHealth('player',10);
  });
  run.hit('basic');
  assert.equal(run.members.get('player')!.player.health,10);
  assert.equal(run.members.get('ally')!.player.health,300);
  assert.equal(run.fallen.has('player'),false);
});

test('enemy defeat effects wait for final HP, and healing can preserve the enemy',()=>{
  for(const rescue of [false,true]){
    const run=fixture();
    run.onReaction(()=>{
      run.direct('enemy',100);
      assert.equal(run.enemyState.health,0);
      assert.equal(run.enemyState.pendingDefeat,false);
      assert.ok(run.combatant('enemy'));
      assert.equal(run.order.includes('enemy-death-sound'),false);
      if(rescue)run.harness.settlement.restoreHealth('enemy',10);
    });
    run.hit('basic');
    assert.equal(run.enemyState.health,rescue?10:0);
    assert.equal(run.order.includes('enemy-controller-dispose'),!rescue);
    assert.equal(run.order.includes('enemy-removed'),!rescue);
    assert.equal(run.order.includes('enemy-death-sound'),!rescue);
  }
});

test('an independent asynchronous chain cannot heal or attack with the finalized dead source',async()=>{
  const run=fixture();run.onReaction(()=>run.direct('player',30));run.hit('basic');
  await Promise.resolve();
  run.harness.settlement.restoreHealth('player',50);
  run.onReaction(()=>assert.fail('finalized source entered another hit chain'));
  run.hit('basic');run.hit('skill');
  assert.equal(run.members.get('player')!.player.health,0);
  assert.equal(run.members.get('ally')!.player.health,400);
  assert.equal(run.order.filter(value=>value==='defeat:player').length,1);
});


test('a real party fighter remains available only inside the registered zero-HP hit chain',()=>{
  const run=fixture();let nested=false;
  const panel=defaultTestPanel({physicalAttack:100,baseDefense:0,defenseRate:0,magicAttack:0,maxHealth:1000,
    hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,
    criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0});
  for(const member of run.members.values())Object.assign(member,{panel});
  run.onReaction(()=>{
    if(nested)return;
    nested=true;run.direct('player',30);
    assert.equal(run.harness.stats.partyFighter('player')!.physicalAttack,100);
    run.hit('skill');
    run.harness.settlement.restoreHealth('player',10);
  });
  run.hit('basic');
  assert.equal(run.members.get('player')!.player.health,10);
  assert.equal(run.members.get('ally')!.player.health,300);
  assert.equal(run.fallen.has('player'),false);
  run.members.get('player')!.setHealth(0);
  assert.equal(run.harness.stats.partyFighter('player'),undefined);
});


test('one whole skill sequence preserves a zero-HP target until its later units finish',()=>{
  const f=fixture(),resolution=f.harness.hitResolution;
  const buff={effect:'buff' as const,buff:'dark-strike' as const,ranks:[{strength:1,chanceThreshold:1000,
    effect:{durationMs:1000,tickMs:0,modifiers:[],states:[],periodic:[]}}]};
  const units=[unit,buff],seen:string[]=[];
  resolution.run(()=>resolveSkillUnitSequence(units,{
    targets:()=>['enemy'],unit:(cueIndex,targetId)=>f.harness.settlement.skillUnit(
      {casterId:'player',targetId,cueIndex,skill:{id:'test',action:{combatUnits:units} as unknown as SkillAction}}),
    resolved:result=>{seen.push(result.outcome);assert.equal(f.order.includes('enemy-death-sound'),false);},
  }));
  assert.deepEqual(seen,['success','success']);assert.equal(f.enemyState.health,0);
  assert.ok(f.order.includes('enemy-death-sound'));
});

test('later ordinary healing still succeeds but cannot rescue the reflected zero-HP source',()=>{
  const f=fixture(),resolution=f.harness.hitResolution;
  f.onReaction(()=>f.direct('player',30));
  const units=[unit,{...unit,effect:'heal' as const}];
  const result=resolution.run(()=>resolveSkillUnitSequence(units,{
    targets:index=>[index===0?'ally':'player'],unit:(cueIndex,targetId)=>f.harness.settlement.skillUnit(
      {casterId:'player',targetId,cueIndex,skill:{id:'test',action:{combatUnits:units} as unknown as SkillAction}}),
  }));
  assert.deepEqual(result.map(row=>row.outcome),['success','success']);
  assert.equal(f.members.get('player')!.player.health,0);assert.equal(f.fallen.has('player'),true);
});

test('a native story threshold keeps a lethal hit at one HP until the story has taken control',()=>{
  const run=fixture();
  let observed:unknown;
  run.setDirector((...values:unknown[])=>{observed=values;return true;});
  run.direct('enemy',200);
  assert.deepEqual(observed,[run.enemyState.definition.id,100,0,100,{id:'enemy',map:'test',x:0,y:0}]);
  assert.equal(run.enemyState.health,1);
  assert.equal(run.order.includes('enemy-removed'),false);
  run.setDirector(()=>false);
  run.direct('enemy',1);
  assert.equal(run.enemyState.health,0);
  assert.equal(run.order.includes('enemy-removed'),true);
});


test('hits queued after a creature becomes an interaction target cannot kill it or grant death effects',()=>{
  const run=fixture();
  run.enemyState.present=false;
  run.direct('enemy',200);
  assert.equal(run.enemyState.health,100);
  assert.equal(run.order.includes('enemy-removed'),false);
  assert.equal(run.order.includes('enemy-death-sound'),false);
});
