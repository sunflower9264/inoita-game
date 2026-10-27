import {resolveSkillUnitSequence} from '../src/domain/skill-unit-sequence.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,NumericCombatUnit} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {PendingEnemyDefeats} from '../src/domain/combat-outcomes.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

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

const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const unit:NumericCombatUnit={effect:'physical',source:'physicalAttack',attributeWeights:primary,
  ranks:[{fixedAddition:0,operation:{kind:'add',amount:0}}]};

function fixture(){
  const order:string[]=[],conditions=new CombatConditions(),fallen=new Set<string>();
  const member=(health:number)=>({level:1,panel:{attributes:primary,maxHealth:1000,maxMana:0},player:{health,maxHealth:1000,maxMana:0},setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number){this.player[key]=value;},setHealth(value:number){
    this.player.health=Math.max(0,Math.min(this.player.maxHealth,value));
  }});
  const members=new Map([['player',member(30)],['ally',member(500)]]);
  const visual={actor:{collision:{}},container:{active:true,x:0,y:0,disableInteractive:()=>{}}};
  const enemy={key:'enemy',definition:catalog.enemies[0],visual,
    controller:{targetRemoved:()=>{},dispose:()=>order.push('enemy-controller-dispose')},presenter:{clear:()=>{}}};
  const enemyState={health:100,maxHealth:100,level:1,elite:false};
  const fighter={level:1,physicalAttack:100,physicalDamageRate:0,magicDamageRate:0,
    hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,
    criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0};
  let react=()=>{};
  const host=Object.setPrototypeOf({
    hero:members.get('player')!,conditions,fallen,arena:[enemy],allies:[{id:'ally',facing:'south'}],
    pendingDefeats:new PendingEnemyDefeats(),partyControllers:new Map(),
    memberOf:(id:string)=>members.get(id),partyPassives:()=>[],partyFighter:()=>fighter,enemyFighter:()=>fighter,
    visualOf:()=>visual,equipmentAttack:()=>({damage:unit}),
    actorAttribute:(_id:string,key:string)=>key==='physicalAttack'?100:key==='rearPenetrationRate'?0:1000,
    actorAttributes:()=>({physicalAttack:100,magicAttack:0,maxHealth:1000,physicalDamageRate:0,
      magicDamageRate:0,stealthDamageRate:0,primaryAttributes:primary}),
    movement:{position:()=>({x:0,y:0}),actor:()=>({shape:()=>({collision:{}})}),stop:()=>{},setEnabled:()=>{}},
    scene:{facing:'south',events:{emit:()=>order.push('contact')},map:{id:'test'},refreshCombatTarget:()=>{}},
    app:{audio:{monsterDeath:()=>order.push('enemy-death-sound')},session:{enemyVitals:()=>({})}},
    roster:{enemySnapshot:()=>({...enemyState}),setEnemyHealth:(_id:string,value:number)=>{enemyState.health=Math.max(0,Math.min(100,value));},source:()=>undefined,
      refresh:()=>({added:[],removed:[]})},
    outcomes:{cancelDeath:()=>{},vanish:(_id:string,_visual:unknown,finish:()=>void)=>finish()},
    removeEnemy:()=>order.push('enemy-removed'),dropMana:()=>order.push('mana'),
    resolveHitReactions:()=>react(),
    showHit:(event:{targetId:string})=>order.push(`hit:${event.targetId}`),
    memberDefeated:(id:string)=>{fallen.add(id);conditions.remove(id);order.push(`defeat:${id}`);},
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const direct=(id:string,amount:number)=>call('settleHit',{casterId:'ally',targetId:id},
    {kind:'hit',damage:amount},host.hero,id==='enemy'?enemy:undefined);
  const hit=(kind:'basic'|'skill',targetId='ally')=>kind==='basic'
    ?call('attackContact',{casterId:'player',targetId})
    :call('skillUnit',{casterId:'player',targetId,cueIndex:0,skill:{id:'test-strike',action:{combatUnits:[unit]}}});
  return {host,members,enemyState,order,conditions,fallen,call,direct,hit,onReaction:(callback:()=>void)=>{react=callback;}};
}

test('a capture conversion removes the source enemy instead of leaving a one-HP corpse',()=>{
  const run=fixture();let healthWrites=0;
  Object.assign(run.host.app,{director:{healthChanged:()=>true},
    session:{enemyVitals:()=>({capture:{map:'test',visit:0}})}});
  run.host.roster.setEnemyHealth=()=>{healthWrites++;};
  run.direct('enemy',500);
  assert.ok(run.order.includes('enemy-removed'),'捕捉后源怪立刻退场');
  assert.equal(healthWrites,0,'不再把源怪写成 1 点血留在场上');
});

test('a story event interruption still leaves the enemy at one HP for the cutscene',()=>{
  const run=fixture();const writes:number[]=[];
  Object.assign(run.host.app,{director:{healthChanged:()=>true},session:{enemyVitals:()=>({})}});
  run.host.roster.setEnemyHealth=(_id:string,value:number)=>{writes.push(value);};
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
      assert.ok(run.call('combatant','player'));
      assert.equal(run.conditions.hasBuff('player','dark-strike'),true);
      run.order.push('remaining-reactions');
    });
    run.hit(kind);
    assert.equal(run.members.get('ally')!.player.health,400);
    assert.ok(run.order.indexOf('hit:ally')>run.order.indexOf('remaining-reactions'));
    assert.ok(run.order.indexOf('defeat:player')>run.order.indexOf('hit:ally'));
    assert.equal(run.fallen.has('player'),true);
    assert.equal(run.call('combatant','player'),undefined);
    assert.equal(run.conditions.hasBuff('player','dark-strike'),false);
  });

  test(`${kind} host lets later healing in the same chain save the zero-HP attacker`,()=>{
    const run=fixture();
    run.onReaction(()=>{run.direct('player',30);run.call('restoreHealth','player',20);});
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
    run.call('restoreHealth','player',10);
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
      assert.equal(run.host.pendingDefeats.has('enemy'),false);
      assert.ok(run.call('combatant','enemy'));
      assert.equal(run.order.includes('enemy-death-sound'),false);
      if(rescue)run.call('restoreHealth','enemy',10);
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
  run.call('restoreHealth','player',50);
  run.onReaction(()=>assert.fail('finalized source entered another hit chain'));
  run.hit('basic');run.hit('skill');
  assert.equal(run.members.get('player')!.player.health,0);
  assert.equal(run.members.get('ally')!.player.health,400);
  assert.equal(run.order.filter(value=>value==='defeat:player').length,1);
});


test('a real party fighter remains available only inside the registered zero-HP hit chain',()=>{
  const run=fixture();let nested=false;
  const panel={physicalAttack:100,baseDefense:0,defenseRate:0,magicAttack:0,maxHealth:1000,
    hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,
    criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
  for(const member of run.members.values())Object.assign(member,{panel});
  Reflect.deleteProperty(run.host,'partyFighter');
  Reflect.set(run.host,'partyPassives',()=>[]);
  run.onReaction(()=>{
    if(nested)return;
    nested=true;run.direct('player',30);
    assert.equal(run.call('partyFighter','player').physicalAttack,100);
    run.hit('skill');
    run.call('restoreHealth','player',10);
  });
  run.hit('basic');
  assert.equal(run.members.get('player')!.player.health,10);
  assert.equal(run.members.get('ally')!.player.health,300);
  assert.equal(run.fallen.has('player'),false);
  run.members.get('player')!.setHealth(0);
  assert.equal(run.call('partyFighter','player'),undefined);
});


test('one whole skill sequence preserves a zero-HP target until its later units finish',()=>{
  const f=fixture(),resolution=new CombatHitResolution();f.host.hitResolution=resolution;
  const buff={effect:'buff' as const,buff:'dark-strike' as const,ranks:[{strength:1,chanceThreshold:1000,
    effect:{durationMs:1000,tickMs:0,modifiers:[],states:[],periodic:[]}}]};
  f.host.applyStateConsequences=()=>{};
  const units=[unit,buff],seen:string[]=[];
  resolution.run(()=>resolveSkillUnitSequence(units,{
    targets:()=>['enemy'],unit:(cueIndex,targetId)=>f.call('skillUnit',
      {casterId:'player',targetId,cueIndex,skill:{id:'test',action:{combatUnits:units}}}),
    resolved:result=>{seen.push(result.outcome);assert.equal(f.order.includes('enemy-death-sound'),false);},
  }));
  assert.deepEqual(seen,['success','success']);assert.equal(f.enemyState.health,0);
  assert.ok(f.order.includes('enemy-death-sound'));
});

test('later ordinary healing still succeeds but cannot rescue the reflected zero-HP source',()=>{
  const f=fixture(),resolution=new CombatHitResolution();f.host.hitResolution=resolution;
  f.onReaction(()=>f.direct('player',30));
  const units=[unit,{...unit,effect:'heal' as const}];
  const result=resolution.run(()=>resolveSkillUnitSequence(units,{
    targets:index=>[index===0?'ally':'player'],unit:(cueIndex,targetId)=>f.call('skillUnit',
      {casterId:'player',targetId,cueIndex,skill:{id:'test',action:{combatUnits:units}}}),
  }));
  assert.deepEqual(result.map(row=>row.outcome),['success','success']);
  assert.equal(f.members.get('player')!.player.health,0);assert.equal(f.fallen.has('player'),true);
});

test('a native story threshold keeps a lethal hit at one HP until the story has taken control',()=>{
  const run=fixture();
  let observed:unknown;
  Reflect.set(run.host.app,'director',{healthChanged:(...values:unknown[])=>{observed=values;return true;}});
  run.direct('enemy',200);
  assert.deepEqual(observed,[run.host.arena[0].definition.id,100,0,100,{id:'enemy',map:'test',x:0,y:0}]);
  assert.equal(run.enemyState.health,1);
  assert.equal(run.order.includes('enemy-removed'),false);
  Reflect.set(run.host.app,'director',{healthChanged:()=>false});
  run.direct('enemy',1);
  assert.equal(run.enemyState.health,0);
  assert.equal(run.order.includes('enemy-removed'),true);
});


test('hits queued after a creature becomes an interaction target cannot kill it or grant death effects',()=>{
  const run=fixture();
  Reflect.set(run.host.app.session,'storyWorld',{visible:()=>false});
  run.direct('enemy',200);
  assert.equal(run.enemyState.health,100);
  assert.equal(run.order.includes('enemy-removed'),false);
  assert.equal(run.order.includes('enemy-death-sound'),false);
});
