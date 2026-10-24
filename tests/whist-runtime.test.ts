import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {ActionDispatchDefinition,BattleCatalog,SkillAction} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {CombatController,type Combatant,type CombatPort,type SkillUnitHit} from '../src/domain/combat.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=catalog.skills.whist,action=skill.action!;
const unit=action.combatUnits!.find(value=>value.effect==='buff');
assert.ok(unit?.effect==='buff');
const buffUnit=unit;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
const base={level:10,physicalAttack:100,magicAttack:0,maxHealth:1000,maxMana:100,baseDefense:0,defense:0,defenseRate:0,
  physicalResistance:0,baseMagicResistance:0,magicResistance:0,hitBase:100,hitBonus:0,evasionBase:0,evasionBonus:0,
  criticalRate:11,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,
  attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}};

function fixture(id='player',rank=1){
  const conditions=new CombatConditions(),order:string[]=[],forgot:string[]=[],attempts:SkillUnitHit[]=[],outcomes:unknown[]=[];
  const ranks={player:rank,ally:rank},configuration=(owner:'player'|'ally')=>({draft:()=>({levels:{whist:ranks[owner]}})});
  const member=(owner:'player'|'ally')=>({classId:'assassin',level:10,panel:structuredClone(base),skills:configuration(owner),
    player:{health:1000,maxHealth:1000,mana:100,maxMana:100},
    bag:{equipmentFor:()=>({}),equipmentItems:()=>({}),get:()=>undefined}});
  const player=member('player'),ally=member('ally'),members=new Map([['player',player],['ally',ally]]);
  const actor=(key:string,team='party'):Combatant=>({id:key,team,position:{x:24,y:40},bounds:{x:-4,y:-4,width:8,height:8}});
  const actors=new Map([actor('player'),actor('ally')].map(value=>[value.id,value]));
  const visual=()=>({actor:{effectAnchor:{x:0,y:-4}},container:{active:true,x:24,y:40},
    layers:[{alpha:1,setAlpha(value:number){this.alpha=value;return this;}}]});
  const visuals=new Map([['player',visual()],['ally',visual()]]),controllers=new Map<string,CombatController>();
  const host=Object.setPrototypeOf({hero:player,conditions,hitResolution:new CombatHitResolution(),
    pendingDefeats:new Set<string>(),fallen:new Set<string>(),arena:[],allies:[{id:'ally',ai:{disable:()=>{},targetRemoved:()=>forgot.push('ally')}}],
    partyControllers:controllers,heroAi:{disable:()=>{},targetRemoved:()=>forgot.push('player')},
    app:{battleCatalog:catalog,items:{items:{}},session:{skills:configuration('player'),party:{controlledId:'player',groupModifiers:()=>({})}},
      audio:{effect:(name:string)=>order.push(`sound:${name}`)}},
    scene:{events:{emit:()=>{}},refreshCombatTarget:()=>{}},movement:{stop:()=>{}},
    memberOf:(key:string)=>members.get(key),visualOf:(key:string)=>visuals.get(key),combatant:(key:string)=>actors.get(key),
    combatants:()=>[...actors.values()],syncCombatResourceLimits:()=>{},react:()=>assert.fail('Whist must not trigger a stealth-break reaction'),
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const presenter=Object.setPrototypeOf({pose:()=>{},visual:(key:string)=>visuals.get(key),scene:host.scene,
    candidates:()=>[...actors.values()],placedEffect:(name:string)=>order.push(name),
  },CombatPresenter.prototype);
  let frame=(_index:number)=>{},spent=0;
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor(id),actor:key=>actors.get(key),candidates:()=>[...actors.values()],
    facing:()=> 'east',moveToward:()=>assert.fail('self cast must not approach'),stop:()=>{},canStand:()=>true,
    relocate:()=>assert.fail('self cast must not relocate'),clearEffects:()=>order.push('clear-action'),
    canSpendMana:cost=>members.get(id)!.player.mana>=cost,
    spendMana:cost=>{spent+=cost;members.get(id)!.player.mana-=cost;return true;},
    play:(_playback,onFrame)=>{frame=onFrame;return ()=>order.push('cancel-animation');},
    frame:(playback,index,contact,ready,area)=>call('presentActionFrame',presenter,playback,index,contact,ready,undefined,
      (definition:ActionDispatchDefinition,work:()=>void,after?:()=>void)=>call('runActionDispatch',playback,definition,work,after),area),
    unit:event=>{attempts.push(event);const result=call('skillUnit',event);outcomes.push(result);return result;},runUnitSequence:work=>host.hitResolution.run(work),
  };
  const combat=new CombatController(id,null,port);controllers.set(id,combat);
  const apply=(level:number)=>call('skillUnit',{casterId:id,targetId:id,cueIndex:0,skill:{id:'whist',action,level}});
  return {host,call,conditions,order,forgot,attempts,outcomes,ranks,player,ally,visuals,actors,combat,apply,
    spent:()=>spent,frame:(index:number)=>frame(index),
    start:(level=rank)=>combat.requestManualSkill({id:'whist',action,level,manaCost:skill.ranks[level-1].manaCost}),
    addEnemy:()=>{actors.set('enemy',actor('enemy','enemy'));host.arena.push({key:'enemy',controller:{targetRemoved:()=>forgot.push('enemy')}});},
  };
}

test('Whist starts without an enemy, charges once and completes smoke and sound after its state cancels the animation',t=>{
  t.mock.method(Math,'random',()=>assert.fail('self Buff chance 1000 must not roll'));
  const f=fixture();assert.equal(f.start(),'started');
  assert.equal(f.spent(),24);assert.equal(f.player.player.mana,76);
  assert.deepEqual(f.combat.snapshot().cooldowns.whist,{remainingMs:10800,durationMs:10800});
  f.frame(1);assert.equal(f.conditions.hasState('player','stealthed'),false);
  assert.deepEqual(f.order,[]);f.frame(2);
  assert.equal(f.conditions.hasState('player','stealthed'),true);assert.equal(f.combat.snapshot().state,'idle');
  assert.deepEqual(f.order,['cancel-animation','clear-action','smoke-puff','sound:A_Skill_05']);
  assert.equal(f.visuals.get('player')!.layers[0].alpha,0.5);
  assert.deepEqual(f.actors.get('player')!.position,{x:24,y:40});
  const completed=[...f.order];f.frame(15);assert.deepEqual(f.order,completed);assert.equal(f.attempts.length,1);
  assert.equal(f.spent(),24);assert.equal(f.conditions.hasBuff('player','dark-sense'),false);
});

test('cancellation before frame two preserves the charge, while companion success forgets only hostile targets and has no controlled sound',t=>{
  t.mock.method(Math,'random',()=>assert.fail('Whist must not roll'));
  const cancelled=fixture();cancelled.start();cancelled.frame(1);cancelled.combat.cancel(true);cancelled.frame(2);
  assert.equal(cancelled.spent(),24);assert.equal(cancelled.conditions.hasBuff('player','whist'),false);
  assert.equal(cancelled.order.includes('smoke-puff'),false);assert.ok(cancelled.combat.snapshot().cooldowns.whist);
  const companion=fixture('ally',2);companion.addEnemy();assert.equal(companion.start(),'started');companion.frame(2);
  assert.deepEqual(companion.forgot,['enemy']);assert.equal(companion.ally.player.mana,76);assert.equal(companion.player.player.mana,100);
  assert.deepEqual(companion.order,['cancel-animation','clear-action','smoke-puff','sound:A_Skill_05']);
  assert.equal(companion.call('actorAttribute','ally','stealthDamageRate'),870);
  assert.equal(companion.call('actorAttribute','player','stealthDamageRate'),0);
});

test('a weaker Whist still completes its successful unit and presentation without refreshing or cancelling the current cast',t=>{
  t.mock.method(Math,'random',()=>assert.fail('Whist must not roll'));
  const f=fixture();assert.equal(f.apply(8),'success');f.conditions.update(180);
  f.conditions.setTemporaryAttribute('player','criticalRate',777);
  f.conditions.setTemporaryAttribute('player','assassinSwordHitAdjustment',-400);
  const before=f.conditions.captureState();f.order.length=0;
  assert.equal(f.start(1),'started');f.frame(2);
  assert.deepEqual(f.conditions.captureState(),before);assert.equal(f.combat.snapshot().state,'attacking');
  assert.deepEqual(f.outcomes,['success']);
  assert.deepEqual(f.order,['smoke-puff','sound:A_Skill_05']);assert.equal(f.spent(),24);
  f.combat.cancel(true);f.order.length=0;
  assert.equal(f.apply(8),'success');
  assert.equal(f.conditions.captureState().buffs[0][1][0].nextFrameAge,0);
  assert.equal(f.conditions.snapshot('player').find(value=>value.kind==='buff')!.stackCount,1);
  assert.equal(f.call('actorAttribute','player','stealthDamageRate'),1603);
  assert.equal(f.conditions.cachedAttribute('player','criticalRate'),undefined);
  assert.equal(f.conditions.cachedAttribute('player','assassinSwordHitAdjustment'),undefined);
});

test('all learned ranks provide their own permanent Assassin Sword adjustment without accumulating on casts',()=>{
  const f=fixture(),rates=[736,870,1070,1336,1403,1470,1536,1603],hit=[230,290,380,500,530,560,590,620];
  for(let rank=1;rank<=8;rank++){
    f.ranks.player=rank;
    assert.equal(f.call('actorAttribute','player','assassinSwordHitAdjustment'),hit[rank-1]);
    assert.equal(f.call('actorAttribute','player','hitBonus'),0,'the learned value is not a universal hit bonus');
    f.apply(rank);f.apply(rank);
    assert.equal(f.call('actorAttribute','player','stealthDamageRate'),rates[rank-1]);
    assert.equal(f.call('actorAttribute','player','assassinSwordHitAdjustment'),hit[rank-1]);
    f.conditions.removeState('player','stealthed');
    assert.equal(f.call('actorAttribute','player','stealthDamageRate'),0);
    assert.equal(f.call('actorAttribute','player','assassinSwordHitAdjustment'),hit[rank-1]);
  }
  // 原式 (3*b+20)*10；佣兵一级 b=2。
  f.ranks.ally=1;assert.equal(f.call('actorAttribute','ally','assassinSwordHitAdjustment'),260);
  assert.equal(f.call('actorAttribute','player','assassinSwordHitAdjustment'),620);
});

test('Whist invalidates critical and Assassin Sword caches on creation and every removal path without clearing unrelated attributes',()=>{
  for(const removal of ['buff','state','expiry'] as const){
    const conditions=new CombatConditions(),definition=buffUnit.ranks[0];
    const dirty=()=>{conditions.setTemporaryAttribute('actor','criticalRate',999);
      conditions.setTemporaryAttribute('actor','assassinSwordHitAdjustment',-400);conditions.setTemporaryAttribute('actor','hitBonus',123);};
    dirty();conditions.applyBuff('actor','whist',definition.strength,definition.effect);
    assert.equal(conditions.cachedAttribute('actor','criticalRate'),undefined);assert.equal(conditions.cachedAttribute('actor','assassinSwordHitAdjustment'),undefined);
    assert.equal(conditions.cachedAttribute('actor','hitBonus'),123);dirty();
    if(removal==='buff')conditions.removeBuff('actor','whist');
    else if(removal==='state')conditions.removeState('actor','stealthed');
    else{conditions.update(91*60);assert.equal(conditions.hasBuff('actor','whist'),true);conditions.update(60);}
    assert.equal(conditions.hasBuff('actor','whist'),false);assert.equal(conditions.hasState('actor','stealthed'),false);
    assert.equal(conditions.cachedAttribute('actor','criticalRate'),undefined,removal);
    assert.equal(conditions.cachedAttribute('actor','assassinSwordHitAdjustment'),undefined,removal);
    assert.equal(conditions.cachedAttribute('actor','hitBonus'),123,removal);
  }
});

test('learned Whist feeds the Assassin Sword adjustment before its temporary subtraction without changing ordinary accuracy',t=>{
  t.mock.method(Math,'random',()=>0.1);const f=fixture();
  const sword=catalog.skills['assassin-s-sword'].action!;
  const index=sword.combatUnits!.findIndex(value=>value.effect==='set-attribute'&&value.attribute==='assassinSwordHitAdjustment');
  assert.ok(index>=0);assert.equal(f.call('actorAttribute','player','assassinSwordHitAdjustment'),230);
  f.call('skillUnit',{casterId:'player',targetId:'player',cueIndex:index,skill:{id:'assassin-s-sword',action:sword,level:1}});
  assert.equal(f.call('actorAttribute','player','assassinSwordHitAdjustment'),-170);
  // Probe only this shared accuracy consumer, not Assassin Sword's complete action contract.
  const probe:SkillAction={events:[],cooldownFrames:0,approachDistanceUnits:0,searchRadiusPx:64,transition:null,
    combatUnits:[{effect:'physical',source:'none',attributeWeights:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},
      ranks:[{fixedAddition:100,operation:{kind:'keep'}}]}]};
  const hits:{kind:string;damage:number}[]=[];
  f.host.settleHit=(_event:unknown,hit:{kind:string;damage:number})=>hits.push(hit);
  f.host.resolveHitReactions=()=>{};f.host.dropMana=()=>{};
  const strike=()=>f.call('skillUnit',{casterId:'player',targetId:'ally',cueIndex:0,skill:{id:'assassin-s-sword',action:probe,level:1}});
  strike();assert.deepEqual(hits.at(-1),{kind:'miss',damage:0});
  f.call('attackContact',{casterId:'player',targetId:'ally',basicAttack:catalog.basicAttacks['longsword-slash']});
  assert.deepEqual(hits.at(-1),{kind:'hit',damage:100});
  f.conditions.clearTemporaryAttribute('player','assassinSwordHitAdjustment');strike();
  assert.deepEqual(hits.at(-1),{kind:'hit',damage:100});
  assert.equal(f.call('actorAttribute','player','assassinSwordHitAdjustment'),230);
});

test('real Whist data supplies the shared damage consumer until age 91 and removes both state and damage source on visit 92',t=>{
  t.mock.method(Math,'random',()=>0.8);const f=fixture();f.apply(1);
  const target={...f.actors.get('ally')!,team:'enemy'};f.actors.set('ally',target);
  const physical:SkillAction={events:[],cooldownFrames:0,approachDistanceUnits:0,searchRadiusPx:64,transition:null,usesSkillDamageBuff:true,
    combatUnits:[{effect:'physical',source:'none',attributeWeights:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},
      ranks:[{fixedAddition:100,operation:{kind:'keep'}}]}]};
  let damage=0;f.host.settleHit=(_event:unknown,hit:{damage:number})=>{damage=hit.damage;};f.host.resolveHitReactions=()=>{};f.host.dropMana=()=>{};
  const strike=()=>{f.call('skillUnit',{casterId:'player',targetId:'ally',cueIndex:0,skill:{id:'whist-damage-probe',action:physical,level:1}});return damage;};
  assert.equal(strike(),346);f.conditions.update(91*60);assert.equal(strike(),346);
  f.conditions.update(60);assert.equal(strike(),100);assert.equal(f.conditions.hasState('player','stealthed'),false);
  assert.equal(f.call('actorAttribute','player','assassinSwordHitAdjustment'),230);
});
