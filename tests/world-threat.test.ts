import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import type {CombatThreatActor,CombatThreatSystem} from '../src/domain/combat-threat-system.ts';
import type {BattleStateKey,BattleStatKey} from '../src/domain/battle-semantics.ts';
import type {SkillUnitHit} from '../src/domain/combat.ts';
import {refreshCombatActors} from '../src/domain/combat-actor-lookup.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const invoke=(host:object,name:string,...args:unknown[])=>Reflect.get(WorldCombat.prototype,name).call(host,...args);
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const actor=(id:string,team:string):CombatThreatActor=>({id,team,active:true,level:10,sightRangeUnits:20,
  tracksThreat:team==='hostile',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}});

function fixture(){
  const conditions=new CombatConditions(),hitResolution=new CombatHitResolution(),events:string[]=[];
  const members=new Map(['caster','ally'].map(id=>[id,{level:10,skills:{draft:()=>({levels:{}})},panel:{maxHealth:100,maxMana:0,attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}},player:{health:80,maxHealth:100,maxMana:0,level:10},setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number){this.player[key]=value;},
    setHealth(value:number){this.player.health=Math.max(0,Math.min(100,value));events.push(`hp:${id}:${this.player.health}`);}}]));
  const actors=new Map([actor('caster','party'),actor('ally','party'),actor('enemy','hostile')].map(actor=>[actor.id,actor]));
  const enemyState={health:100,maxHealth:100,level:10};
  const enemy={key:'enemy',definition:{behavior:{awarenessRangeUnits:8,canMove:true,canTurn:true,moveSpeedPxPerSecond:0,aggression:'none'}},
    controller:{snapshot:()=>({targetId:'ally'}),currentTargetId:()=> 'ally',actionState:()=> 'idle',onThreatAdded:()=>events.push('threat')}};
  const attributes={physicalAttack:20,magicAttack:10,maxHealth:100,physicalDamageRate:0,magicDamageRate:0,stealthDamageRate:0,
    primaryAttributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}};
  const host=Object.setPrototypeOf({hero:members.get('caster'),arena:[enemy],activeParty:['caster','ally'],
    app:{battleCatalog:catalog,session:{combatTick:31,skills:{draft:()=>({levels:{}})},advanceRecoveryClock:()=>{}}},conditions,hitResolution,pendingDefeats:new Set(),summonOwnerReactions:()=>{},disturbanceReaction:()=>{},
    memberOf:(id:string)=>members.get(id),partyPassives:()=>[],partyFighter:()=>({}),actorAttributes:()=>attributes,
    actorAttribute:(_id:string,key:BattleStatKey)=>key==='physicalAttack'?attributes.physicalAttack:key==='threatGenerationRate'||key==='healingPowerRate'?1000:0,
    threatActor:(id:string)=>{const value=actors.get(id);return value&&{...value,states:conditions.activeStates(id)};},
    roster:{enemySnapshot:()=>enemyState,setEnemyHealth:(_id:string,value:number)=>{enemyState.health=Math.max(0,Math.min(100,value));}},
    stateApplicationRequest:(_source:string,_target:string,state:BattleStateKey)=>({state,sourceRelation:'hostile'}),
    applyStateConsequences:()=>{},showHit:()=>events.push('feedback'),
    memberDefeated:(id:string)=>events.push(`death:${id}`),
  },WorldCombat.prototype);
  host.threat=invoke(host,'createThreatSystem') as CombatThreatSystem;
  const skill=(unit:object,targetId='enemy')=>invoke(host,'skillUnit',{casterId:'caster',targetId,cueIndex:0,
    skill:{id:'probe',action:{combatUnits:[unit]}}} as SkillUnitHit);
  return {host,conditions,hitResolution,events,members,actors,enemyState,enemy,attributes,skill,threat:host.threat as CombatThreatSystem};
}

test('accepted damage updates HP, then full overkill threat, then feedback, before deferred defeat',()=>{
  const f=fixture();f.actors.get('ally')!.tracksThreat=true;
  f.conditions.applyState('ally','sleep',1000);
  f.host.arena.push({key:'ally',controller:{snapshot:()=>({}),currentTargetId:()=>undefined,actionState:()=> 'idle',onThreatAdded:()=>f.events.push('threat')}});
  f.hitResolution.run(()=>invoke(f.host,'settleHit',{casterId:'caster',targetId:'ally'},{kind:'hit',damage:500},f.host.hero));
  assert.deepEqual(f.events,['hp:ally:0','threat','feedback','death:ally']);
  assert.equal(f.conditions.hasState('ally','sleep'),false);
  assert.equal(f.threat.captureState().entries.find(entry=>entry.ownerId==='ally')?.score,500);
  f.events.length=0;f.conditions.applyState('ally','damage-immune',1000);
  invoke(f.host,'settleHit',{casterId:'caster',targetId:'ally'},{kind:'hit',damage:10},f.host.hero);
  assert.deepEqual(f.events,[]);
});

test('ordinary action healing submits actual HP delta and creates a zero entry at full health',()=>{
  const f=fixture(),heal={effect:'heal',source:'physicalAttack',attributeWeights:f.attributes.primaryAttributes,
    ranks:[{fixedAddition:0,operation:{kind:'multiply-thousandth',ratePerThousand:10000}}]};
  f.members.get('ally')!.player.health=1;
  assert.equal(f.skill(heal,'ally'),'success');
  assert.equal(f.members.get('ally')!.player.health,100);
  assert.equal(f.threat.captureState().entries[0].score,1);
  f.threat.clear();assert.equal(f.skill(heal,'ally'),'success');
  assert.equal(f.threat.captureState().entries[0].score,0);
  f.threat.clear();invoke(f.host,'restoreHealth','ally',100);
  assert.equal(f.threat.captureState().entries.length,0);
});

test('only successful direct action states create state threat',()=>{
  const f=fixture(),state={effect:'state',state:'stun',ranks:[{chanceThreshold:1000,durationMs:1000}]};
  assert.equal(f.skill(state),'success');assert.equal(f.threat.captureState().entries[0].score,20);
  f.threat.clear();f.host.stateApplicationRequest=()=>({state:'stun',sourceRelation:'hostile',rules:{immuneToAllStates:true}});
  assert.equal(f.skill(state),'failure');assert.equal(f.threat.captureState().entries.length,0);
});

test('healing threat follows a reaction-selected current target rather than the previous AI decision',()=>{
  const f=fixture();Object.assign(f.enemy.controller,{combatController:{snapshot:()=>({targetId:'caster'}),selectedTargetId:()=> 'caster',
    actionState:()=> 'idle'}});
  f.threat.heal('ally','ally',100);assert.equal(f.threat.captureState().entries.length,0);
  f.threat.heal('ally','caster',100);assert.equal(f.threat.captureState().entries[0].sourceId,'ally');
});

test('taunt adds normal physical plus magical damage, gates other sources, and leaves current AI target alone',()=>{
  const f=fixture();assert.equal(f.skill({effect:'taunt'}),'success');
  assert.equal(f.threat.captureState().entries[0].score,30);
  assert.equal(f.conditions.snapshot('enemy').find(state=>state.id==='taunted')?.sourceId,'caster');
  assert.equal(f.enemy.controller.snapshot().targetId,'ally');
  f.threat.damage('ally','enemy',100);assert.equal(f.threat.has('enemy','ally'),false);
  f.conditions.update(32*60);assert.equal(f.conditions.hasState('enemy','taunted'),false);
  f.threat.damage('ally','enemy',100);assert.equal(f.threat.has('enemy','ally'),true);
});

test('taunt state rejection retains its preceding numerical threat and successful Direct result',()=>{
  const f=fixture();f.host.stateApplicationRequest=()=>({state:'taunted',sourceRelation:'hostile',rules:{immuneToAllStates:true}});
  assert.equal(f.skill({effect:'taunt'}),'success');assert.equal(f.threat.captureState().entries[0].score,30);
  assert.equal(f.conditions.hasState('enemy','taunted'),false);
  f.host.stateApplicationRequest=()=>({state:'taunted',sourceRelation:'hostile',rules:{durationScale:0.5}});
  f.skill({effect:'taunt'});f.conditions.update(16*60);assert.equal(f.conditions.hasState('enemy','taunted'),true);
  f.conditions.update(60);assert.equal(f.conditions.hasState('enemy','taunted'),false);
});

test('hostile damage immunity rejects taunt before numerical threat and state application',()=>{
  const f=fixture();f.conditions.applyState('enemy','damage-immune',1000);
  assert.equal(f.skill({effect:'taunt'}),'failure');
  assert.deepEqual(f.threat.captureState().entries,[]);
  assert.equal(f.conditions.hasState('enemy','taunted'),false);
});

test('resource pulses decay threat once after all actors have recovered',()=>{
  const events:string[]=[],host={activeParty:[],arena:[],
    app:{session:{recoveryPulseDue:true,recoverCombatResources:()=>[{amounts:[{actorId:'a',healthAmount:1,manaAmount:2}]},{amounts:[]}],advanceRecoveryClock:()=>{}}},
    restoreHealth:()=>events.push('health'),restoreMana:()=>events.push('mana'),threat:{decay:()=>events.push('decay')}};
  invoke(host,'recoverResources');assert.deepEqual(events,['health','mana','decay','decay']);
});

test('world actor records retain inactive party sources and use the live combat eligibility for zero HP',()=>{
  const f=fixture(),bounds={x:-4,y:-4,width:8,height:8};
  f.host.visualOf=(id:string)=>f.actors.has(id)?{container:{active:true},actor:{collision:bounds}}:undefined;
  Object.defineProperty(f.host,'movement',{value:{position:()=>({x:10,y:20}),actor:()=>({shape:()=>({collision:bounds})})}});
  f.host.combatant=()=>undefined;
  f.members.get('ally')!.player.health=0;
  const inactive=invoke(f.host,'threatActor','ally') as CombatThreatActor;
  assert.equal(inactive.active,false);assert.equal(inactive.tracksThreat,false);assert.equal(inactive.team,'party');
  f.host.combatant=()=>f.actors.get('ally');
  assert.equal((invoke(f.host,'threatActor','ally') as CombatThreatActor).active,true);
  assert.equal(invoke(f.host,'threatActor','departed'),undefined);
});

test('world actor records classify player, member, summon and enemy roles',()=>{
  const f=fixture(),bounds={x:-4,y:-4,width:8,height:8};
  f.host.visualOf=(id:string)=>(f.actors.has(id)||id==='summon'||id==='player')?{container:{active:true},actor:{collision:bounds}}:undefined;
  Object.defineProperty(f.host,'movement',{value:{position:()=>({x:10,y:20}),actor:()=>({shape:()=>({collision:bounds})})}});
  f.host.memberOf=(id:string)=>id==='player'?{...f.members.get('caster'),id:'player'}:f.members.get(id);
  f.host.combatant=()=>f.actors.get('ally');
  assert.equal((invoke(f.host,'threatActor','player') as CombatThreatActor).role,'player');
  assert.equal((invoke(f.host,'threatActor','ally') as CombatThreatActor).role,'member');
  f.host.arena.push({key:'summon',definition:{behavior:{awarenessRangeUnits:8,canMove:true,canTurn:true,moveSpeedPxPerSecond:0,aggression:'none'}},
    controller:{snapshot:()=>({targetId:'player'})},summonedBy:'caster'});
  refreshCombatActors(f.host.arena);
  assert.equal((invoke(f.host,'threatActor','summon') as CombatThreatActor).role,'summon');
  assert.equal((invoke(f.host,'threatActor','enemy') as CombatThreatActor).role,'enemy');
});

test('positive physical and magical success wakes sleep while misses and nonpositive hits retain it',()=>{
  const conditions=new CombatConditions(),host={conditions,reactToBuff:()=>{},react:()=>{},partySide:()=>false,
    summonOwnerReactions:()=>{},disturbanceReaction:()=>{},equipmentRecovery:()=>({}),actorAttribute:()=>0,attackProc:()=>{},
    holySacrificeTransfer:Reflect.get(WorldCombat.prototype,'holySacrificeTransfer')};
  for(const kind of ['physical','magic'])for(const [outcome,damage,wakes]of [['hit',1,true],['miss',1,false],['hit',0,false]] as const){
    conditions.applyState('target','sleep',1000);
    invoke(host,'resolveHitReactions',{casterId:'caster',targetId:'target'},{kind:outcome,damage},kind,'probe',{});
    assert.equal(conditions.hasState('target','sleep'),!wakes);
  }
});
