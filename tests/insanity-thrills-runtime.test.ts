import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,ActionDispatchDefinition} from '../src/domain/battle.ts';
import type {ActorDefinition} from '../src/domain/content.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import type {ActionPlayback,AttackContact,Combatant} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const catalog=read('battle') as BattleCatalog,wardrobe=read('wardrobe') as WardrobeCatalog,items=read('items') as ItemCatalog;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
const base={level:10,physicalAttack:100,magicAttack:900,baseDefense:0,defense:0,defenseRate:0,maxHealth:10000,maxMana:100,
  hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,
  criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0,baseMagicResistance:0,
  attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}};
const actor=(id:string,x=8,y=0,team='enemy'):Combatant=>({id,team,position:{x,y},bounds:{x:-4,y:-4,width:8,height:8}});

function fixture(targets:Combatant[],stance='dagger:empty'){
  const conditions=new CombatConditions(),resolution=new CombatHitResolution(),order:string[]=[],fallen=new Set<string>();
  const actors=new Map([actor('player',0,0,'party'),...targets].map(actor=>[actor.id,actor]));
  const stats=new Map(targets.map(actor=>[actor.id,{...base,health:10000,mana:0}]));
  const skills={draft:()=>({levels:{}})};
  const member={classId:'warrior',level:10,panel:structuredClone(base),skills,player:{health:1000,maxHealth:10000,mana:100,maxMana:100},
    bag:{equipmentFor:()=>({}),equipmentItems:()=>({}),get:()=>undefined},
    setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number){this.player[key]=value;},
    setHealth(value:number){this.player.health=Math.max(0,Math.min(this.player.maxHealth,value));}};
  const definition=wardrobe.frenzyAttacks![stance];
  const appearance={id:'warrior',clips:Object.fromEntries(Object.entries(wardrobe.stances[stance]).map(([name,pose])=>[
    name,{frames:wardrobe.poses[pose!].frames.length},
  ]))} as unknown as ActorDefinition;
  const profile=resolveBasicAttack({basicAttacks:{frenzy:definition}},{actor:appearance,basicAttack:{profileId:'frenzy',clips:definition.clips}});
  const body={alpha:1,setAlpha(value:number){this.alpha=value;return this;}};
  const visual={actor:appearance,layers:[body],container:{active:true,x:0,y:0}};
  const hits:{event:AttackContact;hit:PhysicalHit}[]=[],drops:{id:string;damage:number}[]=[],styles:(string|undefined)[]=[];
  let afterHit:(event:AttackContact,hit:PhysicalHit)=>void=()=>{};
  const host=Object.setPrototypeOf({hero:member,conditions,hitResolution:resolution,fallen,pendingDefeats:new Set<string>(),
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    arena:targets.filter(actor=>actor.team==='enemy').map(actor=>({key:actor.id,definition:catalog.enemies[0]})),allies:[],
    app:{battleCatalog:catalog,items,wardrobe,session:{skills,isOneHitKill:()=>false,party:{activeIds:['player'],controlledId:'player'}}},
    scene:{events:{emit:()=>{}}},memberOf:(id:string)=>id==='player'?member:undefined,partyPassives:()=>[],
    combatant:(id:string)=>{const value=actors.get(id);return value&&!fallen.has(id)?{...value,states:conditions.activeStates(id)}:undefined;},
    visualOf:(id:string)=>id==='player'?visual:undefined,
    roster:{isPresent:()=>true,enemySnapshot:(id:string)=>stats.get(id),setEnemyHealth:(id:string,value:number)=>{stats.get(id)!.health=value;}},
    enemyFighter:(id:string)=>conditions.fighter(id,stats.get(id)!),
    equipmentRecovery:()=>({lifeDrainPerThousand:0,manaRecoveryPerPulse:0,manaCostReductionRate:0}),
    syncCombatResourceLimits:()=>{},applyStateConsequences:()=>{},showBuffApplication:()=>{},attackProc:()=>{},
    showHit:(event:AttackContact,hit:PhysicalHit,presentation:{style?:string}={})=>{hits.push({event,hit});styles.push(presentation.style);order.push(`hit:${event.targetId}:${hit.damage}`);afterHit(event,hit);},
    dropMana:(id:string,damage:number)=>drops.push({id,damage}),
    memberDefeated:(id:string)=>{order.push(`defeat:${id}`);fallen.add(id);visual.container.active=false;conditions.remove(id);},
  },WorldCombat.prototype);
  host.combatants=()=>[...actors.keys()].flatMap(id=>{const value=host.combatant(id);return value?[value]:[];});
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const applySkillBuff=(id:string)=>{
    const unit=catalog.skills[id].action!.combatUnits!.find(unit=>unit.effect==='buff')!;
    assert.equal(unit.effect,'buff');const rank=unit.ranks[0];
    return call('applyActorBuff','player',unit.buff,rank.strength,rank.effect,'player');
  };
  const area=()=>call('basicAreaContact',{casterId:'player',basicAttack:profile});
  return {host,call,profile,conditions,resolution,actors,stats,member,visual,hits,drops,styles,order,fallen,area,applySkillBuff,
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
  assert.equal(f.call('actorAttribute','player','physicalDamageRate'),400);
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
  f.host.moltenReflection=()=>{
    f.call('settleHit',{casterId:'first',targetId:'player'},{kind:'hit',damage:30},f.member);
    assert.equal(f.member.player.health,0);assert.equal(f.resolution.isAwaitingDefeat('player'),true);
    assert.equal(f.fallen.has('player'),false);
  };
  const remove=f.conditions.removeState.bind(f.conditions);
  f.conditions.removeState=(id,key)=>{if(id==='player'&&key==='stealthed')f.order.push('break-stealth');return remove(id,key);};
  const presenter=Object.setPrototypeOf({scene:f.host.scene,pose:()=>{},visual:(id:string)=>id==='player'?f.visual:undefined,
    placedEffect:()=>{assert.equal(f.conditions.hasState('player','stealthed'),false);assert.equal(f.visual.container.active,true);
      assert.equal(f.member.player.health,0);f.order.push('swing');}},CombatPresenter.prototype);
  const playback:ActionPlayback={caster:f.host.combatant('player'),target:f.host.combatant('first'),facing:'south',basicAttack:f.profile};
  dispatchFrame(presenter,playback,f.profile.strikeFrame,()=>assert.fail('single contact'),()=>[],undefined,(definition:ActionDispatchDefinition,work:()=>void,after?:()=>void)=>f.call('runActionDispatch',playback,definition,work,after),f.area);
  assert.deepEqual(f.order,['hit:player:30','hit:first:100','hit:second:100','break-stealth','swing','defeat:player']);
  assert.equal(f.stats.get('second')!.health,9900);assert.equal(f.visual.container.active,false);assert.equal(f.fallen.has('player'),true);
});
