import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,NumericCombatUnit} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {CombatController,type CombatPort,type Combatant,type AttackContact,type SkillUnitHit} from '../src/domain/combat.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const action=catalog.skills['blood-thirst'].action!;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
function fixture(){
  const conditions=new CombatConditions(),hitResolution=new CombatHitResolution(),order:string[]=[],effects:string[]=[];
  let lifeDrain=0;
  const config={draft:()=>({levels:{'blood-thirst':1,'armor-penetration':1}})};
  const base={level:10,physicalAttack:101,magicAttack:0,baseDefense:0,defense:0,defenseRate:0,
    maxHealth:1000,maxMana:100,hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,
    criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,
    physicalResistance:0,magicResistance:0,attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}};
  const member=(classId:string)=>({classId,level:10,panel:{...base},player:{health:500,maxHealth:1000,mana:50,maxMana:100},
    bag:{revision:0,equipmentFor:()=>({}),get:()=>undefined},skills:{draft:()=>({levels:{}})},
    setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number){this.player[key]=value;},
    setHealth(value:number){order.push(`health:${value-this.player.health}`);this.player.health=Math.max(0,Math.min(this.player.maxHealth,value));},
    setMana(value:number){order.push(`mana:${value-this.player.mana}`);this.player.mana=Math.max(0,Math.min(this.player.maxMana,value));}});
  const player=member('warrior'),target=member('dark-knight'),members=new Map([['player',player],['target',target]]);
  const host=Object.setPrototypeOf({hero:player,app:{battleCatalog:catalog,session:{skills:config,party:{controlledId:'player'}},
    audio:{effect:(name:string)=>order.push(`sound:${name}`)}},conditions,hitResolution,pendingDefeats:new Set(),arena:[],allies:[],
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    memberOf:(id:string)=>members.get(id),partyPassives:()=>[],syncCombatResourceLimits:()=>{},applyStateConsequences:()=>{},
    equipmentRecovery:()=>({lifeDrainPerThousand:lifeDrain}),
    showBuffApplication:(_source:string,_target:string,effect:string)=>order.push(effect),
    presenter:{showEffects:(_target:string,entries:{effect:string}[])=>{for(const {effect} of entries){effects.push(effect);order.push(effect);}}},
    settleHit:(event:AttackContact,hit:PhysicalHit)=>{order.push(`damage:${event.targetId}:${hit.damage}`);
      const victim=members.get(event.targetId);if(victim)victim.player.health=Math.max(0,victim.player.health-hit.damage);},
    showHit:()=>{},dropMana:()=>{},attackProc:()=>{},
    combatant:(id:string)=>members.has(id)?{id,team:id==='player'?'party':'enemy',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}}:undefined,
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const cast=(level=1)=>call('skillUnit',{casterId:'player',targetId:'player',cueIndex:0,skill:{id:'blood-thirst',action,level}});
  const contact=(kind:PhysicalHit['kind']='hit',damageKind:'physical'|'magic'='physical',damage=101)=>
    call('resolveHitReactions',{casterId:'player',targetId:'target'},{kind,damage},damageKind,'basic-attack',player);
  const damage:NumericCombatUnit={effect:'physical',source:'physicalAttack',attributeWeights:base.attributes,ranks:[{fixedAddition:0,operation:{kind:'keep'}}]};
  const strike=()=>call('skillUnit',{casterId:'player',targetId:'target',cueIndex:0,skill:{id:'probe',level:1,action:{combatUnits:[damage]}}} as SkillUnitHit);
  return {host,conditions,hitResolution,player,target,members,order,effects,call,cast,contact,strike,lifeDrain:(value:number)=>{lifeDrain=value;}};
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
  f.call('skillUnit',{casterId:'player',targetId:'player',cueIndex:0,skill:{id:'armor-penetration',action:armor,level:1}});
  f.conditions.setTemporaryAttribute('player','bloodThirstChance',199);
  f.host.showBuffApplication=()=>{f.order.push('armor-break-impact');f.conditions.setTemporaryAttribute('player','bloodThirstChance',200);};
  const setHealth=f.player.setHealth.bind(f.player);
  f.player.setHealth=(value:number)=>{setHealth(value);f.conditions.setTemporaryAttribute('player','bloodThirstManaRecovery',7);};
  f.conditions.setTemporaryAttribute('target','moltenReflectionPerThousand',100);
  f.host.moltenReflection=()=>f.order.push(`reflection:hp=${f.player.player.health}:mp=${f.player.player.mana}`);
  f.strike();
  assert.deepEqual(f.order,['health:10','life-drain','armor-break-impact','health:22','life-drain','mana:7','mana-recovery',
    'reflection:hp=532:mp=57','damage:target:101']);
});

test('full resources still emit both effects and the mana attribute is read after the life effect',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.cast();f.player.player.health=1000;f.player.player.mana=100;
  f.host.presenter.showEffects=(_target:string,entries:{effect:string}[])=>{for(const {effect} of entries){
    f.order.push(effect);if(effect==='life-drain')f.conditions.setTemporaryAttribute('player','bloodThirstManaRecovery',9);
  }};
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
  const f=fixture();let mana=10;
  f.host.arena=[{key:'monster',definition:{}}];
  f.host.roster={enemySnapshot:()=>({health:0,mana,maxMana:100}),setEnemyMana:(_id:string,value:number)=>{mana=value;}};
  f.hitResolution.run(()=>{
    f.hitResolution.deferDefeat('monster',()=>f.host.pendingDefeats.add('monster'));
    f.call('restoreMana','monster',7);assert.equal(mana,17);
  });
  f.call('restoreMana','monster',7);assert.equal(mana,17);
  f.player.player.health=0;f.call('restoreMana','player',7);assert.equal(f.player.player.mana,50);
});

test('weak recasts preserve the old chance and rate, equal recasts refresh, and expiry removes both live attributes',t=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.cast(8);f.conditions.update(60);const before=f.conditions.snapshot('player');f.cast(1);
  assert.deepEqual(f.conditions.snapshot('player'),before);f.contact();assert.equal(f.player.player.health,548);
  f.cast(8);assert.ok(f.conditions.snapshot('player')[0].remainingMs>before[0].remainingMs);
  f.conditions.update(151*60);assert.equal(f.call('actorAttribute','player','bloodThirstChance'),200);
  f.conditions.update(60);assert.equal(f.call('actorAttribute','player','bloodThirstChance'),0);
  const healed=f.player.player.health;f.contact();assert.equal(f.player.player.health,healed);
});

test('the self cast uses frame two, pays once and preserves native caster effects and controlled sound order',()=>{
  for(const withFarTarget of [false,true]){
    const f=fixture(),caster:Combatant={id:'player',team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}},
      far:Combatant={...caster,id:'far',team:'enemy',position:{x:200,y:0}};
    const actors=withFarTarget?[caster,far]:[caster];let frame=(_index:number)=>{},spent=0;
    const presenter=Object.setPrototypeOf({pose:()=>{},visual:()=>({container:{active:true,x:0,y:0}}),
      visualEffect:(effect:{effect:string})=>f.order.push(effect.effect)},CombatPresenter.prototype);
    const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor('player'),actor:id=>actors.find(actor=>actor.id===id),
      candidates:()=>actors,facing:()=> 'east',moveToward:()=>assert.fail('self cast must not approach'),stop:()=>{},
      canStand:()=>true,relocate:()=>{},clearEffects:()=>{},canSpendMana:()=>true,spendMana:cost=>{spent+=cost;return true;},
      play:(_play,onFrame)=>{frame=onFrame;return ()=>{};},
      frame:(play,index,contact,ready)=>dispatchFrame(presenter,play,index,contact,ready,undefined,(definition:unknown,work:()=>void)=>f.call('runActionDispatch',play,definition,work)),
      unit:event=>{f.order.push('parent');return f.call('skillUnit',event);}};
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
  const collision={x:-4,y:-4,width:8,height:8},visual={actor:{collision},container:{active:true,x:12,y:24}};
  f.host.visualOf=(id:string)=>id==='player'?visual:undefined;
  Object.defineProperty(f.host,'movement',{value:{position:()=>({x:12,y:24}),actor:()=>({shape:()=>({collision})})}});
  f.host.scene={facing:'east'};
  const placed:unknown[][]=[];
  const presenter=Object.setPrototypeOf({candidates:()=>{const actor=f.call('combatant','player');return actor?[actor]:[];},
    visual:()=>visual,placedEffect:(...args:unknown[])=>placed.push(args),scene:{events:{emit:()=>{}}}},CombatPresenter.prototype);
  f.host.presenter=presenter;
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
