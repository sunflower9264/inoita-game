import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {ActionDispatchDefinition,NumericCombatUnit,ResolvedBasicAttack,SkillAction,SkillEvent} from '../src/domain/battle.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
import {CombatController,type ActionPlayback,type CombatPort,type Combatant,type SkillUnitHit} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import type {Point} from '../src/domain/navigation.ts';
import type {PhysicalFighter} from '../src/domain/physical-hit.ts';
import {createCombatTestHarness,createTestEnemy,createTestMember,loadBattleCatalog,type TestMemberFixture} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const damage:NumericCombatUnit&{effect:'physical'}={effect:'physical',source:'physicalAttack',attributeWeights:primary,
  ranks:[{fixedAddition:0,operation:{kind:'keep'}}]};
const base:PhysicalFighter={level:1,physicalAttack:100,magicAttack:0,maxHealth:10000,
  hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,
  criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
const dispatch=(overrides:Partial<ActionDispatchDefinition>={}):ActionDispatchDefinition=>({
  breaksStealth:true,casterEffects:[{effect:'dispatch-tail',placement:'attached',recipient:'caster'}],
  shake:true,vibrationMs:150,sound:'dispatch-sound',...overrides,
});
function skillAction(definition=dispatch()):SkillAction {
  return {requiresTarget:true,cooldownFrames:0,approachDistanceUnits:4,searchRadiusPx:100,transition:null,
    combatUnits:[damage,{effect:'visual'}],events:[{kind:'units',frame:2,dispatch:definition,cues:[
      {target:'current',targetRangePx:100,targetSelection:'search',effects:[]},
      {target:'self',targetRangePx:0,targetSelection:'search',effects:[]},
    ]}]};
}

function fixture(action=skillAction(),basic?:ResolvedBasicAttack){
  const conditions=new CombatConditions(),resolution=new CombatHitResolution(),order:string[]=[],fallen=new Set<string>();
  const box={x:-4,y:-4,width:8,height:8};
  const visual=(x:number)=>({actor:{collision:box},container:{active:true,x,y:0},
    layers:[{alpha:1,setAlpha(value:number){this.alpha=value;return this;}}]});
  const visuals=new Map([['player',visual(0)],['enemy',visual(16)],['other',visual(24)]]);
  let learnedRank=0;
  const configuration={get version(){return learnedRank;},resetVersion:0,draft:()=>({levels:{'dark-sense':learnedRank}})};
  const member=createTestMember({id:'player',classId:'assassin',level:1,health:30,maxHealth:10000,mana:100,maxMana:100,
    panel:{...base,maxHealth:10000,maxMana:100,attributes:{...primary}}});
  member.skills=configuration;
  const members=new Map<string,TestMemberFixture>([['player',member]]);
  const enemies=new Map(['enemy','other'].map(key=>[key,createTestEnemy({key,definition:catalog.enemies[0],health:10000,maxHealth:10000})]));
  let controlledId='player';
  const buffApplications:{id:string;sourceId?:string;strength:number;health:number}[]=[];
  const applyBuff=conditions.applyBuff.bind(conditions);
  conditions.applyBuff=(...args)=>{
    const accepted=applyBuff(...args);
    if(accepted&&args[1]==='dark-sense'){
      order.push(`dark-sense:${args[0]}`);
      buffApplications.push({id:args[0],sourceId:args[4],strength:args[2],health:member.player.health});
    }
    return accepted;
  };
  const arrivals:((center?:Point)=>void)[]=[],attempts:SkillUnitHit[]=[],contacts:string[]=[],dispatches:ActionDispatchDefinition[]=[];
  const skill={id:'dispatch-test',action,level:1};
  let frame=(_index:number)=>{},complete=()=>{},playback:ActionPlayback|undefined;
  let react=()=>{},afterUnit:((hit:SkillUnitHit)=>void)=()=>{};
  const removeState=conditions.removeState.bind(conditions);
  conditions.removeState=(id,state)=>{if(state==='stealthed')order.push('remove-stealth');return removeState(id,state);};
  const combatant=(id:string):Combatant|undefined=>{
    if(fallen.has(id))return undefined;
    const m=members.get(id);
    if(m&&!m.alive&&!resolution.isAwaitingDefeat(id))return undefined;
    const e=enemies.get(id);
    if(e&&(!e.present||e.pendingDefeat))return undefined;
    const v=visuals.get(id);
    if(!v?.container.active)return undefined;
    return {id,team:m?'party':'hostile',position:{x:v.container.x,y:v.container.y},bounds:box,states:conditions.activeStates(id),facing:'east'};
  };
  const combatants=():Combatant[]=>[...visuals.keys()].flatMap(id=>{const actor=combatant(id);return actor?[actor]:[];});
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hitResolution:resolution,hero:member,members,enemies,
    activeParty:()=>[...members.keys()],controlledId:()=>controlledId,
    combatant,combatants,
    memberActorDefinition:()=>catalog.classes[0].actor,
    statsOverrides:{skillConfiguration:(_id,m)=>(m as unknown as TestMemberFixture).skills as never},
    settlementOverrides:{
      isFallen:id=>fallen.has(id),
      isOneHitKill:()=>false,
      onActionShake:()=>order.push('shake'),
      onActionSound:(casterId,sound)=>{if(members.has(casterId))order.push(`sound:${sound}`);},
      onShowHit:event=>order.push(`damage:${event.targetId}`),
      onDropMana:()=>{},
      onMemberDefeated:id=>{
        assert.equal(resolution.isAwaitingDefeat(id),false);
        order.push(`defeat:${id}`);fallen.add(id);conditions.remove(id);
        controlledId='survivor';
      },
    },
  });
  if(basic)harness.stats.equipmentAttack=()=>basic;
  harness.settlement.resolveHitReactions=()=>{react();};
  const baseDispatch=harness.settlement.runActionDispatch.bind(harness.settlement);
  const runActionDispatch=(play:{caster:Combatant;skill?:ActionPlayback['skill']},definition:ActionDispatchDefinition,work:()=>void,after?:()=>void)=>{
    dispatches.push(definition);return baseDispatch(play,definition,work,after);
  };
  const presenter={
    scene:{events:{emit:(name:string)=>{if(name.startsWith('basic-attack-'))order.push(name);}}},
    pose:()=>{},visual:(id:string)=>visuals.get(id),candidates:combatants,
    visualEffect:(effect:{effect:string})=>order.push(`effect:${effect.effect}`),placedEffect:()=>{},
    play:(play:ActionPlayback,onFrame:(index:number)=>void,onComplete:()=>void)=>{
      playback=play;frame=onFrame;complete=onComplete;return ()=>{};
    },
    clear:()=>{},
    transition:(_transition:unknown,_target:unknown,_position:unknown,_facing:unknown,arrive:(center?:Point)=>void)=>{
      order.push('launch');arrivals.push(arrive);
    },
    fly:(_effect:unknown,_position:unknown,_target:unknown,_facing:unknown,_x:unknown,_y:unknown,_step:unknown,_time:unknown,arrive:()=>void)=>{
      order.push('launch');arrivals.push(arrive);
    },
    summon:()=>order.push('summon'),
  };
  const port:CombatPort={
    cooldowns:new CombatCooldownStore(()=>0).forActor('player'),
    actor:combatant,candidates:combatants,facing:()=> 'east',
    moveToward:()=>{},stop:()=>{},canStand:()=>true,relocate:()=>{},clearEffects:()=>{},
    canSelectSkill:()=>true,manaCost:()=>0,canSpendMana:()=>true,spendMana:()=>true,
    play:(play,onFrame,onComplete)=>presenter.play(play,onFrame,onComplete),
    frame:(play,index,contactCb,unitsReady,areaContact)=>dispatchFrame(presenter,play,index,contactCb,unitsReady,undefined,
      (definition,work,after)=>runActionDispatch(play,definition,work,after),areaContact),
    prepareUnit:event=>harness.settlement.prepareSkillUnit(event),
    unit:hit=>{attempts.push(hit);order.push(`unit:${hit.cueIndex}:${hit.targetId}`);const result=harness.settlement.skillUnit(hit);afterUnit(hit);return result;},
    runUnitSequence:work=>resolution.run(work),
    contact:hit=>{if(!hit.skillId)contacts.push(hit.targetId);harness.settlement.attackContact(hit);},
  };
  const controller=new CombatController('player',basic??null,port);
  return {harness,conditions,resolution,order,fallen,member,members,enemyHealth:enemies,visuals,arrivals,attempts,contacts,dispatches,controller,
    controlledId:()=>controlledId,runActionDispatch,
    learn:(rank:number)=>{learnedRank=rank;},buffApplications,
    frame:(index:number)=>frame(index),complete:()=>complete(),playback:()=>playback!,
    start:()=>controller.request(basic?undefined:skill,'enemy'),
    stealth:()=>conditions.applyState('player','stealthed',10000,'player'),
    unhide:()=>removeState('player','stealthed'),
    react:(callback:()=>void)=>{react=callback;},afterUnit:(callback:typeof afterUnit)=>{afterUnit=callback;},
    reflect:()=>harness.settlement.settleHit({casterId:'enemy',targetId:'player'},{kind:'hit',damage:30}),
  };
}

test('the real dispatch captures stealth at the action event rather than at animation start or its tail',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const [atStart,atEntry,insideWork,expectedHidden] of [
    [false,true,undefined,false],[true,false,undefined,false],
    [true,true,true,false],[false,false,true,true],
  ] as const){
    const run=fixture();run.learn(3);if(atStart)run.stealth();assert.equal(run.start(),'started');
    assert.equal(run.conditions.hasState('player','stealthed'),atStart,'starting animation does not break stealth');
    if(atEntry)run.stealth();else run.unhide();
    run.afterUnit(hit=>{if(hit.cueIndex===0&&insideWork){run.unhide();run.stealth();}});
    run.frame(2);
    assert.equal(run.conditions.hasState('player','stealthed'),expectedHidden);
    assert.equal(run.order.filter(value=>value==='remove-stealth').length,atEntry?1:0);
    assert.equal(run.conditions.hasBuff('player','dark-sense'),atEntry);
    assert.equal(run.buffApplications.length,atEntry?1:0);
    assert.equal(run.order.filter(value=>value==='sound:dispatch-sound').length,1);
  }
});

test('failed and empty Direct targets still finish units and caster effects before feedback and stealth removal',()=>{
  for(const empty of [false,true]){
    const run=fixture();run.stealth();run.conditions.applyState('enemy','damage-immune',10000);
    assert.equal(run.start(),'started');
    if(empty){run.visuals.delete('enemy');run.controller.targetRemoved('enemy');}
    run.frame(2);
    const tail=['unit:1:player','effect:dispatch-tail','shake','remove-stealth','sound:dispatch-sound'];
    assert.deepEqual(run.order.slice(-tail.length),tail);
    assert.equal(run.enemyHealth.get('enemy')!.health,10000);
    run.frame(2);assert.equal(run.dispatches.length,1);
  }
});

test('a captured projectile batch breaks stealth once at launch and never again at its delayed arrivals',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const action=skillAction();action.transition={kind:'position',effect:'projectile',actionEffect:null,
    switchFrame:1,stepDistancePx:1,offsetX:0,offsetY:0};
  action.events.unshift({kind:'capture-targets',frame:0,target:'area',targetRangePx:100,limit:16});
  const run=fixture(action);run.learn(2);run.stealth();assert.equal(run.start(),'started');run.frame(2);
  assert.equal(run.arrivals.length,2);assert.equal(run.attempts.length,0);assert.equal(run.dispatches.length,1);
  assert.deepEqual(run.order,['launch','launch','effect:dispatch-tail','shake','remove-stealth','dark-sense:player','sound:dispatch-sound']);
  run.complete();run.stealth();run.conditions.update(60);
  const buffBefore=run.conditions.snapshot('player').find(value=>value.id==='dark-sense');
  run.arrivals[0]({x:16,y:0});run.arrivals[0]({x:16,y:0});run.arrivals[1]({x:24,y:0});
  assert.equal(run.attempts.length,4);assert.equal(run.dispatches.length,1);
  assert.equal(run.buffApplications.length,1);
  assert.deepEqual(run.conditions.snapshot('player').find(value=>value.id==='dark-sense'),buffBefore);
  assert.equal(run.conditions.hasState('player','stealthed'),true);
  assert.equal(run.order.filter(value=>value==='sound:dispatch-sound').length,1);
});

test('a lethal nested hit defers the real source death until the dispatch tail and controlled sound finish',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.learn(4);run.stealth();let reflected=false;
  run.react(()=>{
    if(reflected)return;reflected=true;run.reflect();
    assert.equal(run.member.player.health,0);assert.equal(run.fallen.has('player'),false);
    assert.equal(run.resolution.isAwaitingDefeat('player'),true);
  });
  assert.equal(run.start(),'started');run.frame(2);
  assert.equal(run.enemyHealth.get('enemy')!.health,9900);
  assert.deepEqual(run.order.slice(-7),['unit:1:player','effect:dispatch-tail','shake',
    'remove-stealth','dark-sense:player','sound:dispatch-sound','defeat:player']);
  assert.deepEqual(run.buffApplications,[{id:'player',sourceId:'player',strength:1009,health:0}]);
  assert.equal(run.conditions.hasBuff('player','dark-sense'),false);
  assert.equal(run.fallen.has('player'),true);assert.equal(run.member.player.health,0);
  assert.equal(run.controlledId(),'survivor');
});

test('basic direct contact happens inside Presenter dispatch and still works without dispatch metadata',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const hasDispatch of [true,false]){
    const basic=resolveBasicAttack(catalog,catalog.classes.find(value=>value.id==='dark-knight')!);
    basic.damage=damage;basic.swings=[];basic.targetEffects=[];
    if(hasDispatch)basic.dispatch=dispatch();else delete basic.dispatch;
    const run=fixture(skillAction(),basic);run.stealth();assert.equal(run.start(),'started');
    run.frame(basic.strikeFrame);
    assert.deepEqual(run.contacts,['enemy']);assert.equal(run.enemyHealth.get('enemy')!.health,9900);
    assert.equal(run.conditions.hasState('player','stealthed'),!hasDispatch);
    if(hasDispatch)assert.deepEqual(run.order.slice(-5),
      ['damage:enemy','effect:dispatch-tail','shake','remove-stealth','sound:dispatch-sound']);
    run.frame(basic.strikeFrame);assert.equal(run.contacts.length,1);
  }
});

test('summon-only events use the same dispatch boundary without creating damage units',()=>{
  const action=skillAction();
  const original=catalog.enemies.flatMap(enemy=>enemy.skills??[]).flatMap(skill=>'action' in skill?skill.action.events:[])
    .find((event):event is Extract<SkillEvent,{kind:'summon'}>=>event.kind==='summon');
  assert.ok(original,'native summon-only enemy event exists');
  action.combatUnits=[];action.events=[{...structuredClone(original),frame:2,dispatch:dispatch()}];
  const run=fixture(action);run.stealth();assert.equal(run.start(),'started');run.frame(2);
  assert.deepEqual(run.order,['summon','effect:dispatch-tail','shake','remove-stealth','sound:dispatch-sound']);
  assert.equal(run.attempts.length,0);assert.equal(run.dispatches.length,1);
});


test('Dark Sense reads its current learned rank after the action and remains absent when unlearned',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.learn(2);run.stealth();assert.equal(run.start(),'started');
  run.afterUnit(()=>{run.learn(6);run.unhide();});run.frame(2);
  assert.equal(run.playback().skill?.level,1);
  assert.deepEqual(run.buffApplications,[{id:'player',sourceId:'player',strength:1011,health:30}]);
  const unlearned=fixture();unlearned.stealth();assert.equal(unlearned.start(),'started');unlearned.frame(2);
  assert.equal(unlearned.conditions.hasState('player','stealthed'),false);
  assert.equal(unlearned.buffApplications.length,0);
});

test('a companion uses its own Dark Sense rank and a monster never borrows the controlled hero passive',()=>{
  const run=fixture();run.learn(8);
  const companion=createTestMember({id:'companion',classId:'assassin',level:1,health:30,maxHealth:10000,mana:100,maxMana:100,
    panel:{...base,maxHealth:10000,maxMana:100,attributes:{...primary}},skillLevels:{'dark-sense':3}});
  run.members.set('companion',companion);
  for(const ownerId of ['companion','enemy']){
    run.conditions.applyState(ownerId,'stealthed',10000,ownerId);
    const caster:Combatant={id:ownerId,team:ownerId==='enemy'?'hostile':'party',position:{x:0,y:0},bounds:{x:0,y:0,width:8,height:8}};
    run.runActionDispatch({caster},dispatch(),()=>{});
    assert.equal(run.conditions.hasState(ownerId,'stealthed'),false);
  }
  assert.deepEqual(run.buffApplications,[{id:'companion',sourceId:'companion',strength:1006,health:30}]);
  assert.equal(run.conditions.hasBuff('player','dark-sense'),false);
  assert.equal(run.conditions.hasBuff('enemy','dark-sense'),false);
  // 佣兵与主角同属玩家阵营，派发音效只响佣兵这一次；怪物仍然静音。
  assert.equal(run.order.filter(value=>value==='sound:dispatch-sound').length,1);
});

test('stealth expiration and external removal do not grant Dark Sense without an action dispatch',()=>{
  const run=fixture();run.learn(8);run.stealth();run.unhide();
  run.conditions.applyState('player','stealthed',60,'player');run.conditions.update(120);
  assert.equal(run.conditions.hasState('player','stealthed'),false);
  assert.equal(run.buffApplications.length,0);
});
