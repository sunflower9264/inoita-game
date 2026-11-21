import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,BattleBuffEffect,NumericCombatUnit} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {CombatController,type CombatPort,type Combatant,type AttackContact,type SkillUnitHit} from '../src/domain/combat.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import type {SkillReactionEvent} from '../src/domain/skill-reactions.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const action=catalog.skills['armor-penetration'].action!,parent=action.combatUnits!.find(unit=>unit.effect==='buff')!;
if(parent.effect!=='buff')throw new Error('missing armor penetration parent');
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
const empty=(modifiers:BattleBuffEffect['modifiers']):BattleBuffEffect=>({durationMs:10000,tickMs:0,states:[],periodic:[],modifiers});
function fixture(){
  const conditions=new CombatConditions(),hitResolution=new CombatHitResolution(),order:string[]=[],effects:string[]=[],hits:{event:AttackContact;hit:PhysicalHit}[]=[];
  let rank=1,lifeDrain=0;
  const config={get version(){return rank;},draft:()=>({levels:{'armor-penetration':rank}})};
  const base={level:10,physicalAttack:100,magicAttack:0,baseDefense:100,defense:150,defenseRate:500,
    maxHealth:1000,maxMana:100,hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,
    criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,
    physicalResistance:0,magicResistance:0,attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}};
  const member=(classId:string)=>({classId,level:10,panel:{...base},player:{health:500,maxHealth:1000,mana:100,maxMana:100},
    bag:{revision:0,equipmentFor:()=>({}),get:()=>undefined},skills:{draft:()=>({levels:{}})}});
  const player=member('warrior'),target=member('dark-knight'),members=new Map([['player',player],['target',target]]);
  const host=Object.setPrototypeOf({hero:player,app:{battleCatalog:catalog,session:{skills:config}},
    conditions,hitResolution,pendingDefeats:new Set(),arena:[],allies:[],
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    memberOf:(id:string)=>members.get(id),partyPassives:()=>[],
    syncCombatResourceLimits:()=>{},applyStateConsequences:()=>{},
    equipmentRecovery:()=>({lifeDrainPerThousand:lifeDrain}),
    showBuffApplication:(source:string,id:string,effect:string)=>{effects.push(`${source}:${id}:${effect}`);order.push('apply-child-effect');},
    restoreHealth:(id:string,amount:number)=>{order.push('heal');members.get(id)!.player.health+=amount;},
    settleHit:(event:AttackContact,hit:PhysicalHit)=>{hits.push({event,hit});order.push(`damage:${event.targetId}:${hit.damage}`);},
    showHit:()=>{},dropMana:()=>{},attackProc:()=>{},
    combatant:(id:string)=>members.has(id)?{id,team:id==='player'?'party':'enemy',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}}:undefined,
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const cast=(level=rank)=>call('skillUnit',{casterId:'player',targetId:'player',cueIndex:0,skill:{id:'armor-penetration',action,level}});
  const contact=(kind:PhysicalHit['kind']='hit',damageKind:'physical'|'magic'='physical',damage=0)=>
    call('resolveHitReactions',{casterId:'player',targetId:'target'},{kind,damage},damageKind,'basic-attack',player);
  const phase=(ownerId='player')=>call('react',{kind:'physical-attack-effects',ownerId,opponentId:'target',damageKind:'physical',outcome:'hit',
    armorBreakChance:call('actorAttribute',ownerId,'armorBreakChance')} satisfies SkillReactionEvent);
  const damage:NumericCombatUnit={effect:'physical',source:'physicalAttack',attributeWeights:base.attributes,ranks:[{fixedAddition:0,operation:{kind:'keep'}}]};
  const strike=()=>call('skillUnit',{casterId:'player',targetId:'target',cueIndex:0,skill:{id:'probe',level:1,action:{combatUnits:[damage]}}} as SkillUnitHit);
  return {host,conditions,player,target,members,order,effects,hits,call,cast,contact,phase,strike,
    learn:(value:number)=>{rank=value;},lifeDrain:(value:number)=>{lifeDrain=value;}};
}

test('the parent retains its cast chance while each successful hit uses the currently learned child rank',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();assert.equal(run.cast(1),'success');run.learn(8);
  assert.equal(run.call('actorAttribute','player','armorBreakChance'),260);run.contact();
  const child=run.conditions.snapshot('target').find(buff=>buff.id==='armor-break')!;
  assert.equal(child.strength,2013);assert.equal(child.sourceId,'player');
  assert.deepEqual(run.effects,['player:target:armor-break-impact']);
  run.conditions.update(60);run.learn(1);const before=run.conditions.snapshot('target');run.contact();
  assert.deepEqual(run.conditions.snapshot('target'),before);assert.equal(run.effects.length,1);
  run.learn(8);run.contact();assert.equal(run.effects.length,2);
  assert.ok(run.conditions.snapshot('target')[0].remainingMs>before[0].remainingMs);
});

test('the live skill lookup happens after a successful roll including unlearned and nonmember owners',t=>{
  const run=fixture();run.cast();run.learn(0);
  const order:string[]=[];t.mock.method(Math,'random',()=>{order.push('roll');return 0.2;});
  hostLookup();
  function hostLookup(){
    const original=run.host.learnedReactionBuff.bind(run.host);
    run.host.learnedReactionBuff=(id:string,skill:string)=>{order.push('lookup');return original(id,skill);};
  }
  run.phase();assert.deepEqual(order,['roll','lookup']);assert.equal(run.effects.length,0);
  order.length=0;run.conditions.setTemporaryAttribute('monster','armorBreakChance',1000);run.phase('monster');
  assert.deepEqual(order,['roll','lookup']);assert.equal(run.effects.length,0);
});

test('only physical nonmiss outcomes trigger armor break, including zero damage',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const damageKind of ['physical','magic'] as const)for(const outcome of ['hit','critical','weapon-block','shield-block','miss'] as const){
    const run=fixture();run.cast();run.contact(outcome,damageKind,0);
    assert.equal(run.conditions.hasBuff('target','armor-break'),damageKind==='physical'&&outcome!=='miss',`${damageKind}:${outcome}`);
  }
});

test('healing finishes before armor chance is read, and armor break precedes reflection without changing the captured main damage',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.cast();run.lifeDrain(1000);
  run.conditions.setTemporaryAttribute('player','armorBreakChance',1);
  const restore=run.host.restoreHealth;
  run.host.restoreHealth=(id:string,amount:number)=>{restore(id,amount);run.conditions.setTemporaryAttribute('player','armorBreakChance',1000);};
  const molten=catalog.skills['molten-armor'].action!.combatUnits!.find(unit=>unit.effect==='buff')!;
  if(molten.effect!=='buff')throw new Error('missing molten armor');
  run.conditions.applyBuff('target',molten.buff,molten.ranks[0].strength,molten.ranks[0].effect,'target');
  assert.equal(run.strike(),'success');
  assert.deepEqual(run.order,['heal','apply-child-effect','damage:target:63']);
  assert.equal(run.player.player.health,563);assert.equal(run.hits.length,1);
  assert.equal(run.call('actorAttribute','target','defense'),0);
  run.strike();assert.equal(run.hits.at(-1)!.hit.damage,100);
});

test('armor break retains native newest-first modifier order instead of forcing final resistance to zero',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.cast();
  run.conditions.applyBuff('target','guardian-of-darkness',1,empty([{attribute:'physicalResistanceBonus',operation:{kind:'add',amount:400}}]));
  run.contact();assert.equal(run.call('partyFighter','target').physicalResistance,400);
  run.conditions.applyBuff('target','phantom-clash',1,empty([{attribute:'physicalResistanceBonus',operation:{kind:'add',amount:100}}]));
  assert.equal(run.call('partyFighter','target').physicalResistance,400);
  run.conditions.removeBuff('target','guardian-of-darkness');
  assert.equal(run.call('partyFighter','target').physicalResistance,0);
});

test('a late child survives independently after the parent expires and cannot trigger without the parent chance',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.cast();run.conditions.update(180*60);run.contact();
  run.conditions.update(2*60);assert.equal(run.conditions.hasBuff('player','armor-penetration'),false);
  assert.equal(run.conditions.hasBuff('target','armor-break'),true);
  const before=run.conditions.snapshot('target');run.contact();assert.deepEqual(run.conditions.snapshot('target'),before);
  run.conditions.update(59*60);assert.equal(run.conditions.hasBuff('target','armor-break'),true);
  run.conditions.update(60);assert.equal(run.conditions.hasBuff('target','armor-break'),false);
});

test('a broken monster still reflects from its raw attack rather than its defense',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.cast();run.members.delete('target');
  Reflect.set(run.host,'arena',[{key:'target',definition:{}}]);
  Reflect.set(run.host,'roster',{enemySnapshot:()=>({level:10,health:1000,physicalAttack:100})});
  const molten=catalog.skills['molten-armor'].action!.combatUnits!.find(unit=>unit.effect==='buff')!;
  if(molten.effect!=='buff')throw new Error('missing molten armor');
  run.conditions.applyBuff('target',molten.buff,molten.ranks[0].strength,molten.ranks[0].effect,'target');
  run.contact();assert.equal(run.conditions.hasBuff('target','armor-break'),true);
  assert.deepEqual(run.hits.map(({event,hit})=>[event.targetId,hit.damage]),[['player',32]]);
});

test('the real action casts without approaching and applies its parent on frame four before the two caster effects',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const withFarTarget of [false,true]){
    const run=fixture(),caster:Combatant={id:'player',team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}},
      far:Combatant={...caster,id:'far',team:'enemy',position:{x:200,y:0}};
    const actors=withFarTarget?[caster,far]:[caster],order:string[]=[];
    let frame=(_index:number)=>{},spent=0;
    const presenter=Object.setPrototypeOf({pose:()=>{},visual:()=>({container:{active:true,x:0,y:0}}),
      visualEffect:(effect:{effect:string})=>order.push(effect.effect)},CombatPresenter.prototype);
    const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor('player'),actor:id=>actors.find(actor=>actor.id===id),
      candidates:()=>actors,facing:()=> 'east',moveToward:()=>assert.fail('self cast must not approach'),stop:()=>{},
      canStand:()=>true,relocate:()=>{},clearEffects:()=>{},canSpendMana:()=>true,spendMana:cost=>{spent+=cost;return true;},
      play:(_play,onFrame)=>{frame=onFrame;return ()=>{};},
      frame:(play,index,contact,ready)=>dispatchFrame(presenter,play,index,contact,ready,undefined,(_dispatch:unknown,work:()=>void)=>{work();order.push('dispatch-tail');}),
      unit:event=>{order.push('parent');return run.call('skillUnit',event);}};
    const combat=new CombatController('player',null,port);
    assert.equal(combat.requestManualSkill({id:'armor-penetration',level:1,action,manaCost:28},withFarTarget?'far':undefined),'started');
    frame(3);assert.equal(run.conditions.hasBuff('player','armor-penetration'),false);
    frame(4);assert.equal(run.conditions.hasBuff('player','armor-penetration'),true);
    assert.deepEqual(order,['parent','wrath-impact','green-leaves','dispatch-tail']);
    frame(4);assert.equal(spent,28);assert.deepEqual(combat.snapshot().cooldowns['armor-penetration'],{remainingMs:16200,durationMs:16200});
  }
});
