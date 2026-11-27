import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {ActionDispatchDefinition} from '../src/domain/battle.ts';
import type {ActorDefinition} from '../src/domain/content.ts';
import type {ActionPlayback,AttackContact,Combatant} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
  loadItemCatalog,
  loadWardrobeCatalog,
  ZERO_PRIMARY_ATTRIBUTES,
} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog(),wardrobe=loadWardrobeCatalog(),items=loadItemCatalog();
const base={level:10,physicalAttack:100,magicAttack:900,baseDefense:0,defense:0,defenseRate:0,maxHealth:10000,maxMana:100,
  hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,
  criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0,baseMagicResistance:0,
  attributes:ZERO_PRIMARY_ATTRIBUTES};
const actor=(id:string,x=8,y=0,team:'party'|'hostile'='hostile'):Combatant=>({id,team,position:{x,y},bounds:{x:-4,y:-4,width:8,height:8}});

function fixture(targets:Combatant[],stance='dagger:empty'){
  const conditions=new CombatConditions(),resolution=new CombatHitResolution(),order:string[]=[];
  const actors=new Map([actor('player',0,0,'party'),...targets].map(entry=>[entry.id,entry]));
  const stats=new Map(targets.map(entry=>[entry.id,{...base,health:10000,mana:0}]));
  const member=createTestMember({
    id:'player',classId:'warrior',level:10,health:1000,maxHealth:10000,mana:100,maxMana:100,
    panel:structuredClone(base),
  });
  const definition=wardrobe.frenzyAttacks![stance];
  const appearance={id:'warrior',clips:Object.fromEntries(Object.entries(wardrobe.stances[stance]).map(([name,pose])=>[
    name,{frames:wardrobe.poses[pose!].frames.length},
  ]))} as unknown as ActorDefinition;
  const profile=resolveBasicAttack({basicAttacks:{frenzy:definition}},{actor:appearance,basicAttack:{profileId:'frenzy',clips:definition.clips}});
  const body={alpha:1,setAlpha(value:number){this.alpha=value;return this;}};
  const visual={actor:appearance,layers:[body],container:{active:true,x:0,y:0}};
  const hits:{event:AttackContact;hit:PhysicalHit}[]=[],drops:{id:string;damage:number}[]=[],styles:(string|undefined)[]=[];
  let afterHit:(event:AttackContact,hit:PhysicalHit)=>void=()=>{};
  const enemies=new Map(targets.filter(entry=>entry.team==='hostile').map(entry=>[entry.id,createTestEnemy({key:entry.id,definition:catalog.enemies[0]})]));
  const combatant=(id:string)=>{
    const value=actors.get(id);
    return value&&!harness.fallen.has(id)?{...value,states:conditions.activeStates(id)}:undefined;
  };
  const combatants=()=>[...actors.keys()].flatMap(id=>{const value=combatant(id);return value?[value]:[];});
  const harness=createCombatTestHarness({
    battleCatalog:catalog,items,wardrobe,conditions,hitResolution:resolution,
    hero:member,members:new Map([['player',member]]),enemies,
    activeParty:()=>['player'],
    combatant,
    combatants,
    withThreat:false,
    settlementOverrides:{
      isEnemyPresent:()=>true,
      enemySnapshot:id=>stats.get(id) as never,
      setEnemyHealth:(id,value)=>{stats.get(id)!.health=value;},
      onStateConsequences:undefined,
      onBuffApplication:undefined,
      onEnemyZeroHealth:undefined,
      onShowHit:(event,hit,presentation)=>{hits.push({event,hit});styles.push(presentation.style);order.push(`hit:${event.targetId}:${hit.damage}`);afterHit(event,hit);},
      onDropMana:(id,damage)=>drops.push({id,damage}),
      onMemberDefeated:(id)=>{order.push(`defeat:${id}`);harness.fallen.add(id);visual.container.active=false;conditions.remove(id);},
    },
  });
  harness.stats.enemyFighter=(id:string)=>conditions.fighter(id,stats.get(id)!);
  harness.settlement.attackProc=()=>{};
  const applySkillBuff=(id:string)=>{
    const unit=catalog.skills[id].action!.combatUnits!.find(entry=>entry.effect==='buff')!;
    assert.equal(unit.effect,'buff');const rank=unit.ranks[0];
    return harness.settlement.applyActorBuff('player',unit.buff,rank.strength,rank.effect,'player');
  };
  const area=()=>harness.settlement.basicAreaContact({casterId:'player',basicAttack:profile});
  return {harness,combatant,profile,conditions,resolution,actors,stats,member,visual,hits,drops,styles,order,fallen:harness.fallen,area,applySkillBuff,
    afterHit:(callback:typeof afterHit)=>{afterHit=callback;}};
}

test('the real area host uses caster-centered integer octagonal boundaries and excludes allies and stealth',t=>{
  t.mock.method(Math,'random',()=>0.5);
  const f=fixture([actor('axis-in',39),actor('axis-out',40),actor('diagonal-in',28,28),actor('diagonal-out',29,29),
    actor('ally',8,0,'party'),actor('hidden')]);
  f.conditions.applyState('hidden','stealthed',10000);
  f.area();assert.deepEqual(f.hits.map(value=>value.event.targetId),['axis-in','diagonal-in']);
  assert.deepEqual(f.hits.map(value=>value.hit.damage),[100,100]);
  assert.equal(f.stats.get('axis-out')!.health,10000);assert.equal(f.stats.get('diagonal-out')!.health,10000);
  assert.equal(f.stats.get('ally')!.health,10000);assert.equal(f.stats.get('hidden')!.health,10000);
});

test('the first sixteen eligible slots include immunity while rejected allies and stealth do not consume slots',t=>{
  let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return 0.5;});
  const targets=Array.from({length:18},(_,index)=>actor(`enemy-${index}`));
  const f=fixture([actor('ally',8,0,'party'),actor('hidden'),...targets]);
  f.conditions.applyState('hidden','stealthed',10000);f.conditions.applyState('enemy-0','damage-immune',10000);
  f.area();assert.deepEqual(f.hits.map(value=>value.event.targetId),targets.slice(0,16).map(value=>value.id));
  assert.deepEqual(f.hits.map(value=>value.hit.damage),[0,...Array.from({length:15},()=>100)]);
  // 每个物理命中还会消耗残影的无条件抽签，因此抽签数是掉落数的两倍。
  assert.equal(rolls,30);assert.equal(f.drops.length,15);assert.equal(f.stats.get('enemy-16')!.health,10000);
  assert.equal(f.stats.get('enemy-17')!.health,10000);
});

test('each target re-reads live source damage after Storm of Frenzy adds a layer, with one multiplier application',t=>{
  t.mock.method(Math,'random',()=>0.5);
  const f=fixture(Array.from({length:7},(_,index)=>actor(`enemy-${index}`)));
  assert.equal(f.applySkillBuff('storm-of-frenzy'),true);f.area();
  assert.deepEqual(f.hits.map(value=>value.hit.damage),[100,108,116,124,132,140,140]);
  assert.equal(f.harness.stats.actorAttribute('player','physicalDamageRate'),400);
  assert.equal(f.conditions.snapshot('player').find(buff=>buff.id==='storm-of-frenzy-power')!.sourceId,'player');
  assert.deepEqual(f.drops.map(value=>value.damage),[100,108,116,124,132,140,140]);
});

test('the captured target list survives later stealth and movement without collecting newly entered targets',t=>{
  t.mock.method(Math,'random',()=>0.5);
  const f=fixture([actor('first'),actor('second'),actor('outside',40)]);
  f.afterHit(event=>{if(event.targetId==='first'){
    f.conditions.applyState('second','stealthed',10000);
    f.actors.get('second')!.position.x=1000;
    f.actors.get('outside')!.position.x=8;
  }});
  f.area();assert.deepEqual(f.hits.map(value=>value.event.targetId),['first','second']);
  assert.equal(f.conditions.hasState('second','stealthed'),true);
  assert.equal(f.stats.get('second')!.health,9900);assert.equal(f.stats.get('outside')!.health,10000);
});

test('replacement damage uses physical attack, preserves Dark Strike, and reads later source changes',t=>{
  t.mock.method(Math,'random',()=>0.5);
  const f=fixture([actor('first'),actor('second')]);assert.equal(f.applySkillBuff('dark-strike'),true);
  const before=f.conditions.snapshot('player').find(buff=>buff.id==='dark-strike');
  f.conditions.setTemporaryAttribute('player','skillDamageBonus',9000);
  f.afterHit(event=>{if(event.targetId==='first')f.conditions.setTemporaryAttribute('player','physicalAttack',123);});
  f.area();assert.deepEqual(f.hits.map(value=>value.hit.damage),[100,123]);
  assert.deepEqual(f.conditions.snapshot('player').find(buff=>buff.id==='dark-strike'),before);
  assert.equal(f.conditions.cachedAttribute('player','skillDamageBonus'),9000);
  assert.deepEqual(f.styles,['weapon','weapon']);assert.equal(f.profile.manaGemDrop,'weapon');
});

test('the real dispatch retains a reflected zero-HP caster through the whole area, stealth break and same-frame swing',t=>{
  t.mock.method(Math,'random',()=>0.5);
  const f=fixture([actor('first'),actor('second')]);f.member.player.health=30;
  f.conditions.applyState('player','stealthed',10000);f.conditions.setTemporaryAttribute('first','moltenReflectionPerThousand',100);
  f.harness.settlement.moltenReflection=()=>{
    f.harness.settlement.settleHit({casterId:'first',targetId:'player'},{kind:'hit',damage:30});
    assert.equal(f.member.player.health,0);assert.equal(f.resolution.isAwaitingDefeat('player'),true);
    assert.equal(f.fallen.has('player'),false);
  };
  const remove=f.conditions.removeState.bind(f.conditions);
  f.conditions.removeState=(id,key)=>{if(id==='player'&&key==='stealthed')f.order.push('break-stealth');return remove(id,key);};
  const presenter={scene:{events:{emit:()=>{}}},pose:()=>{},visual:(id:string)=>id==='player'?f.visual:undefined,
    placedEffect:()=>{assert.equal(f.conditions.hasState('player','stealthed'),false);assert.equal(f.visual.container.active,true);
      assert.equal(f.member.player.health,0);f.order.push('swing');}};
  const playback:ActionPlayback={caster:f.combatant('player')!,target:f.combatant('first'),facing:'south',basicAttack:f.profile};
  dispatchFrame(presenter,playback,f.profile.strikeFrame,()=>assert.fail('single contact'),()=>[],undefined,(definition:ActionDispatchDefinition,work:()=>void,after?:()=>void)=>f.harness.settlement.runActionDispatch(playback,definition,work,after),f.area);
  assert.deepEqual(f.order,['hit:player:30','hit:first:100','hit:second:100','break-stealth','swing','defeat:player']);
  assert.equal(f.stats.get('second')!.health,9900);assert.equal(f.visual.container.active,false);assert.equal(f.fallen.has('player'),true);
});
