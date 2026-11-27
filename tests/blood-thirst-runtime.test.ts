import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {ActionDispatchDefinition,NumericCombatUnit,SkillVisualEffect} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {CombatController,type CombatPort,type Combatant,type AttackContact,type SkillUnitHit} from '../src/domain/combat.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import type {Point} from '../src/domain/navigation.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import {createCombatTestHarness,createTestEnemy,createTestMember,loadBattleCatalog,type TestEnemyState,type TestMemberFixture} from './support/combat-test-harness.ts';
import {createFakePhaserScene,installPhaserStubHooks} from './support/world-combat-fixture.ts';

const phaserHook=installPhaserStubHooks();
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');
phaserHook.deregister();

const catalog=loadBattleCatalog();
const action=catalog.skills['blood-thirst'].action!;
function fixture(){
  const conditions=new CombatConditions(),hitResolution=new CombatHitResolution(),order:string[]=[],effects:string[]=[];
  let lifeDrain=0;
  const config={version:1,resetVersion:0,draft:()=>({levels:{'blood-thirst':1,'armor-penetration':1}})};
  const base={level:10,physicalAttack:101,magicAttack:0,baseDefense:0,defense:0,defenseRate:0,
    maxHealth:1000,maxMana:100,hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,
    criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,
    physicalResistance:0,magicResistance:0,attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}};
  const makeMember=(id:string,classId:string,track:boolean)=>{
    const m=createTestMember({id,classId,level:10,health:500,maxHealth:1000,mana:50,maxMana:100,panel:{...base}});
    if(track){
      const setHealth=m.setHealth.bind(m),setMana=m.setMana.bind(m);
      m.setHealth=(value:number)=>{order.push(`health:${value-m.player.health}`);setHealth(value);};
      m.setMana=(value:number)=>{order.push(`mana:${value-m.player.mana}`);setMana(value);};
    }
    return m;
  };
  const player=makeMember('player','warrior',true),target=makeMember('target','dark-knight',false);
  const members=new Map<string,TestMemberFixture>([['player',player],['target',target]]);
  const enemies=new Map<string,TestEnemyState>();
  let position:Point={x:0,y:0};
  const box={x:-4,y:-4,width:8,height:8};
  const combatant=(id:string):Combatant|undefined=>{
    const m=members.get(id);
    if(m)return (m.player.health>0||hitResolution.isAwaitingDefeat(id))?{id,team:'party',position,bounds:box,states:conditions.activeStates(id),facing:'east'}:undefined;
    const e=enemies.get(id);
    return e&&e.present&&!e.pendingDefeat?{id,team:'hostile',position,bounds:box,states:conditions.activeStates(id),facing:'east'}:undefined;
  };
  let showEffects=(_target:string,entries:readonly SkillVisualEffect[])=>{
    for(const {effect} of entries){effects.push(effect);order.push(effect);}
  };
  let showBuffApplication=(_source:string,_target:string,effect:string)=>{order.push(effect);};
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hitResolution,hero:player,members,enemies,
    activeParty:()=>['player'],
    combatant,combatants:()=>[...members.keys(),...enemies.keys()].flatMap(id=>{const c=combatant(id);return c?[c]:[];}),
    statsOverrides:{skillConfiguration:()=>config as never},
    settlementOverrides:{
      onActionSound:(casterId,sound)=>{if(members.has(casterId))order.push(`sound:${sound}`);},
      onBuffApplication:(source,targetId,effect)=>showBuffApplication(source,targetId,effect),
      onShowEffects:(_actorId,targetId,entries)=>showEffects(targetId,entries),
      onShowHit:()=>{},onDropMana:()=>{},
    },
  });
  harness.stats.partyPassives=()=>[];
  harness.stats.equipmentRecovery=()=>({lifeDrainPerThousand:lifeDrain,manaRecoveryPerPulse:0,manaCostReductionRate:0});
  harness.settlement.attackProc=()=>{};
  harness.settlement.settleHit=(event:AttackContact,hit:PhysicalHit)=>{
    order.push(`damage:${event.targetId}:${hit.damage}`);
    const victim=members.get(event.targetId);
    if(victim)victim.player.health=Math.max(0,victim.player.health-hit.damage);
  };
  const cast=(level=1)=>harness.settlement.skillUnit({casterId:'player',targetId:'player',cueIndex:0,skill:{id:'blood-thirst',action,level}});
  const contact=(kind:PhysicalHit['kind']='hit',damageKind:'physical'|'magic'='physical',damage=101)=>
    harness.settlement.resolveHitReactions({casterId:'player',targetId:'target'},{kind,damage},damageKind,'basic-attack');
  const damage:NumericCombatUnit={effect:'physical',source:'physicalAttack',attributeWeights:base.attributes,ranks:[{fixedAddition:0,operation:{kind:'keep'}}]};
  const strike=()=>harness.settlement.skillUnit({casterId:'player',targetId:'target',cueIndex:0,skill:{id:'probe',level:1,action:{combatUnits:[damage]}}} as SkillUnitHit);
  return {harness,conditions,hitResolution,player,target,members,enemies,order,effects,cast,contact,strike,combatant,
    lifeDrain:(value:number)=>{lifeDrain=value;},
    setPosition:(next:Point)=>{position=next;},
    setShowEffects:(fn:typeof showEffects)=>{showEffects=fn;},
    setShowBuffApplication:(fn:typeof showBuffApplication)=>{showBuffApplication=fn;}};
}

test('Blood Thirst works without armor penetration and uses captured damage rather than actual target HP loss or healing bonuses',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.cast();f.target.player.health=1;
  f.conditions.setTemporaryAttribute('player','healingPowerRate',9000);f.strike();
  assert.equal(f.player.player.health,522);assert.equal(f.target.player.health,0);
  assert.deepEqual(f.order,['health:22','life-drain','damage:target:101']);
  assert.equal(f.player.player.mana,50);assert.equal(f.conditions.hasBuff('player','armor-penetration'),false);
});

test('zero damage physical outcomes still trigger the effect and positive mana attribute, while miss and magic do not',t=>{
  for(const damageKind of ['physical','magic'] as const)for(const outcome of ['hit','critical','weapon-block','shield-block','miss'] as const){
    const f=fixture();f.cast();f.conditions.setTemporaryAttribute('player','bloodThirstManaRecovery',7);
    let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return 0;});f.contact(outcome,damageKind,0);
    const accepts=damageKind==='physical'&&outcome!=='miss';
    assert.deepEqual(f.order,accepts?['health:0','life-drain','mana:7','mana-recovery']:[],`${damageKind}:${outcome}`);
    // 物理成功还会消耗残影那两次无条件抽签里的一次（另一支手别才抽第二次）。
    assert.equal(rolls,accepts?2:0);assert.equal(f.player.player.mana,accepts?57:50);
  }
});

test('armor application completes before chance is read, and healing and mana complete before reflection and main damage',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.cast();f.lifeDrain(100);
  const armor=catalog.skills['armor-penetration'].action!;
  f.harness.settlement.skillUnit({casterId:'player',targetId:'player',cueIndex:0,skill:{id:'armor-penetration',action:armor,level:1}});
  f.conditions.setTemporaryAttribute('player','bloodThirstChance',199);
  f.setShowBuffApplication(()=>{f.order.push('armor-break-impact');f.conditions.setTemporaryAttribute('player','bloodThirstChance',200);});
  const setHealth=f.player.setHealth.bind(f.player);
  f.player.setHealth=(value:number)=>{setHealth(value);f.conditions.setTemporaryAttribute('player','bloodThirstManaRecovery',7);};
  f.conditions.setTemporaryAttribute('target','moltenReflectionPerThousand',100);
  f.harness.settlement.moltenReflection=()=>f.order.push(`reflection:hp=${f.player.player.health}:mp=${f.player.player.mana}`);
  f.strike();
  assert.deepEqual(f.order,['health:10','life-drain','armor-break-impact','health:22','life-drain','mana:7','mana-recovery',
    'reflection:hp=532:mp=57','damage:target:101']);
});

test('full resources still emit both effects and the mana attribute is read after the life effect',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.cast();f.player.player.health=1000;f.player.player.mana=100;
  f.setShowEffects((_target,entries)=>{for(const {effect} of entries){
    f.order.push(effect);if(effect==='life-drain')f.conditions.setTemporaryAttribute('player','bloodThirstManaRecovery',9);
  }});
  f.contact();assert.deepEqual(f.order,['health:0','life-drain','mana:0','mana-recovery']);
  assert.equal(f.player.player.health,1000);assert.equal(f.player.player.mana,100);
});

test('pending death permits recovery within the same hit, including mana when rounded healing is zero',t=>{
  t.mock.method(Math,'random',()=>0);
  for(const damage of [0,101]){
    const f=fixture();f.cast();f.player.player.health=0;f.conditions.setTemporaryAttribute('player','bloodThirstManaRecovery',7);
    let defeated=false;
    f.hitResolution.run(()=>{
      f.hitResolution.deferDefeat('player',()=>{defeated=f.player.player.health===0;});
      f.contact('hit','physical',damage);assert.equal(defeated,false);assert.equal(f.player.player.mana,57);
    });
    assert.equal(defeated,damage===0);assert.equal(f.player.player.health,damage===0?0:22);
  }
});

test('a pending enemy can recover mana before defeat but a completed defeat cannot recover again',()=>{
  const f=fixture();
  const monster=createTestEnemy({key:'monster',definition:catalog.enemies[0],health:0,maxHealth:100,mana:10,maxMana:100});
  f.enemies.set('monster',monster);
  f.hitResolution.run(()=>{
    f.hitResolution.deferDefeat('monster',()=>{monster.pendingDefeat=true;});
    f.harness.settlement.restoreMana('monster',7);assert.equal(monster.mana,17);
  });
  f.harness.settlement.restoreMana('monster',7);assert.equal(monster.mana,17);
  f.player.player.health=0;f.harness.settlement.restoreMana('player',7);assert.equal(f.player.player.mana,50);
});

test('weak recasts preserve the old chance and rate, equal recasts refresh, and expiry removes both live attributes',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.cast(8);f.conditions.update(60);const before=f.conditions.snapshot('player');f.cast(1);
  assert.deepEqual(f.conditions.snapshot('player'),before);f.contact();assert.equal(f.player.player.health,548);
  f.cast(8);assert.ok(f.conditions.snapshot('player')[0].remainingMs>before[0].remainingMs);
  f.conditions.update(151*60);assert.equal(f.harness.stats.actorAttribute('player','bloodThirstChance'),200);
  f.conditions.update(60);assert.equal(f.harness.stats.actorAttribute('player','bloodThirstChance'),0);
  const healed=f.player.player.health;f.contact();assert.equal(f.player.player.health,healed);
});

test('the self cast uses frame two, pays once and preserves native caster effects and controlled sound order',()=>{
  for(const withFarTarget of [false,true]){
    const f=fixture(),caster:Combatant={id:'player',team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}},
      far:Combatant={...caster,id:'far',team:'hostile',position:{x:200,y:0}};
    const actors=withFarTarget?[caster,far]:[caster];let frame=(_index:number)=>{},spent=0;
    const presenter={pose:()=>{},visual:()=>({container:{active:true,x:0,y:0}}),
      visualEffect:(effect:{effect:string})=>f.order.push(effect.effect)};
    const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor('player'),actor:id=>actors.find(actor=>actor.id===id),
      candidates:()=>actors,facing:()=> 'east',moveToward:()=>assert.fail('self cast must not approach'),stop:()=>{},
      canStand:()=>true,relocate:()=>{},clearEffects:()=>{},canSpendMana:()=>true,spendMana:cost=>{spent+=cost;return true;},
      play:(_play,onFrame)=>{frame=onFrame;return ()=>{};},
      frame:(play,index,contact,ready)=>dispatchFrame(presenter,play,index,contact,ready,undefined,
        (definition:unknown,work:()=>void)=>f.harness.settlement.runActionDispatch(play,definition as ActionDispatchDefinition,work)),
      unit:event=>{f.order.push('parent');return f.harness.settlement.skillUnit(event);}};
    const combat=new CombatController('player',null,port);
    assert.equal(combat.requestManualSkill({id:'blood-thirst',level:1,action,manaCost:24},withFarTarget?'far':undefined),'started');
    frame(1);assert.equal(f.conditions.hasBuff('player','blood-thirst'),false);
    frame(2);assert.equal(f.conditions.hasBuff('player','blood-thirst'),true);
    assert.deepEqual(f.order,['parent','petal-scatter','demon-faces','sound:A_Skill_04']);
    frame(2);assert.equal(spent,24);assert.deepEqual(combat.snapshot().cooldowns['blood-thirst'],{remainingMs:27000,durationMs:27000});
  }
});

test('the real actor and presenter retain zero-HP recovery effects inside the hit chain with cached negative healing',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.cast();f.player.player.health=0;
  f.conditions.setTemporaryAttribute('player','bloodThirstLifeDrainPerThousand',-1);
  f.conditions.setTemporaryAttribute('player','bloodThirstManaRecovery',7);
  const collision={x:-4,y:-4,width:8,height:8},visual={actor:{collision},container:{active:true,x:12,y:24}} as never;
  f.setPosition({x:12,y:24});
  const placed:unknown[][]=[];
  const presenter=new CombatPresenter(createFakePhaserScene(),catalog,id=>id==='player'?visual:undefined,
    ()=>{const actor=f.combatant('player');return actor?[actor]:[];});
  t.mock.method(presenter as unknown as {placedEffect:(...args:unknown[])=>void},'placedEffect',(...args:unknown[])=>placed.push(args));
  f.setShowEffects((targetId,entries)=>presenter.showEffects(targetId,entries));
  f.hitResolution.run(()=>{
    f.hitResolution.deferDefeat('player',()=>{});f.contact();
    assert.equal(f.player.player.health,0);assert.equal(f.player.player.mana,57);
    assert.deepEqual(placed.map(args=>args.slice(0,4)),[
      ['life-drain','default',{x:12,y:24},'attached'],['mana-recovery','default',{x:12,y:24},'attached'],
    ]);
  });
  presenter.showEffects('player',[{effect:'life-drain',recipient:'target',placement:'attached'}]);
  assert.equal(placed.length,2);
});
