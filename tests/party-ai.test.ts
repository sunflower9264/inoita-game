import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {PartyController,partySkillThreshold,
  type PartyPort,type PartySkillKind} from '../src/domain/party-ai.ts';
import {CombatController,type ActionPlayback,type Combatant} from '../src/domain/combat.ts';
import {attackDistance,resolveBasicAttack,targetDistance} from '../src/domain/basic-attack.ts';
import type {BattleCatalog,EnemyPlayableSkill} from '../src/domain/battle.ts';
import type {Point} from '../src/domain/navigation.ts';
import {followOffset} from '../src/domain/party-placement.ts';
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const box={x:-8,y:-8,width:16,height:16};

function setup(random=()=>0){
  const time={frame:0};
  const member:Combatant={id:'member',team:'party',position:{x:32,y:32},bounds:box};
  const leader:Combatant={id:'player',team:'party',position:{x:128,y:128},bounds:box};
  const enemy:Combatant={id:'enemy',team:'enemy',position:{x:360,y:360},bounds:box};
  const enemy2:Combatant={id:'enemy2',team:'enemy',position:{x:380,y:360},bounds:box};
  const actors=new Map([member,leader,enemy,enemy2].map(actor=>[actor.id,actor]));
  const targets=new Map<string,string>();
  const plays:ActionPlayback[]=[];let completed:(()=>void)|undefined,path:(()=>Point|undefined)|undefined;
  const vitals=new Map([[member.id,{health:100,maxHealth:100}],[leader.id,{health:100,maxHealth:100}]]);
  const attacking=new Set<string>();let focus:string|undefined,mana=1000,skills:EnemyPlayableSkill[]=[],fighting=false;
  let sharedTarget:string|undefined,sharedCalls=0,facing:'north'|'south'|'east'|'west'='east',slot:0|1=0,range=4;
  const kinds=new Map<string,PartySkillKind>();let boundsCalls=0;
  const port:PartyPort={cooldowns:new CombatCooldownStore(()=>time.frame).forActor(member.id),actor:id=>actors.get(id),candidates:()=>[...actors.values()],leader:()=>leader,
    leaderFacing:()=>facing,followSlot:()=>slot,
    focusTarget:()=>focus,partyTarget:()=>{sharedCalls++;return sharedTarget;},targetOf:id=>targets.get(id),inCombat:()=>fighting||!!focus,
    facing:()=> 'east',face:()=>{},
    navigationBounds:()=>{boundsCalls++;return {x:0,y:0,width:400,height:400};},canStand:p=>p.x>=0&&p.x<=400&&p.y>=0&&p.y<=400,
    followPath:next=>{path=next;},moveToward:()=>assert.fail('party movement must use its navigable path'),
    stop:()=>{path=undefined;},relocate:p=>{member.position={...p};},
    skills:()=>skills,skillKind:id=>kinds.get(id),vitals:id=>vitals.get(id),attacking:id=>attacking.has(id),attackRange:()=>range,
    canSpendMana:cost=>cost<=mana,spendMana:cost=>{if(cost>mana)return false;mana-=cost;return true;},
    play:(action,_frame,complete)=>{plays.push(action);completed=complete;return ()=>{};},frame:()=>{},clearEffects:()=>{}};
  const combat=new CombatController(member.id,resolveBasicAttack(catalog,catalog.classes[0]),port);
  const ai=new PartyController(member.id,port,combat,random);
  const installSkill=(id:string,kind:PartySkillKind,frequency=1)=>{
    const entry=catalog.skills[id];
    kinds.set(id,kind);skills=[...skills.filter(skill=>skill.id!==id),{id,name:entry.name,action:entry.action!,
      manaCost:entry.ranks[0].manaCost,frequency,clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'}}];
  };
  return {ai,combat,port,time,member,leader,enemy,enemy2,actors,plays,vitals,attacking,waypoint:()=>path?.(),boundsCalls:()=>boundsCalls,
    focus:(id:string|undefined)=>{focus=id;},shared:(id:string|undefined)=>{sharedTarget=id;},sharedCalls:()=>sharedCalls,
    fighting:(value=true)=>{fighting=value;},mana:(value:number)=>{mana=value;},setTarget:(actorId:string,targetId:string|undefined)=>{
      if(targetId===undefined)targets.delete(actorId);else targets.set(actorId,targetId);
    },
    setFacing:(value:'north'|'south'|'east'|'west')=>{facing=value;},setSlot:(value:0|1)=>{slot=value;},setAttackRange:(value:number)=>{range=value;},
    skill:installSkill,skills:(entries:[string,PartySkillKind,number?][])=>{skills=[];for(const [id,kind,frequency] of entries)installSkill(id,kind,frequency??1);},
    finish:()=>completed?.(),advance:(frames=1)=>{for(let i=0;i<frames;i++){const next=path?.();if(next)member.position={...next};ai.update(60);}}};
}

test('companions do not auto-acquire enemies that are only nearby',()=>{
  const run=setup();run.enemy.position={x:56,y:32};run.ai.update(60);
  assert.equal(run.ai.captureState().destinationTarget,'player','附近敌人不再自动接敌，回到跟随');
  assert.ok(run.waypoint(),'没有目标时继续跟随');
  assert.equal(run.plays.length,0,'不主动出手');
});

test('being attacked makes a companion retaliate',()=>{
  const run=setup();run.enemy.position={x:250,y:128};run.setTarget('enemy','member');run.ai.update(60);
  assert.equal(run.ai.captureState().destinationTarget,'enemy','被攻击时把攻击者当成目标');
});

test('explicit focus outranks the controlled character target',()=>{
  const run=setup();run.enemy.position={x:56,y:32};run.enemy2.position={x:48,y:48};
  run.shared('enemy');run.focus('enemy2');run.ai.update(60);
  assert.equal(run.plays.at(-1)?.target?.id,'enemy2');
});

test('the controlled character target is read immediately',()=>{
  const run=setup();run.enemy.position={x:200,y:128};run.shared('enemy');run.ai.update(60);
  assert.ok(run.sharedCalls()>0);assert.equal(run.ai.captureState().destinationTarget,'enemy');
});

test('a target beyond the leash is ignored',()=>{
  const run=setup();run.enemy.position={x:400,y:400};run.focus('enemy');run.ai.update(60);
  assert.equal(run.ai.captureState().destinationTarget,'player','目标离队长太远时回到跟随');
  assert.equal(run.plays.length,0);
});

test('target stickiness keeps the current enemy briefly after focus clears',()=>{
  const run=setup();run.enemy.position={x:56,y:32};run.enemy2.position={x:48,y:48};run.focus('enemy');run.ai.update(60);
  run.focus(undefined);run.ai.update(60);
  assert.equal(run.plays.at(-1)?.target?.id,'enemy','短时间内不因为另一个敌人更近就换目标');
});

test('follow stance uses the leader facing and companion role',()=>{
  const run=setup();run.ai.update(60);
  assert.deepEqual(run.ai.captureState().destination,{x:run.leader.position.x+followOffset('east','front',0).x,y:run.leader.position.y+followOffset('east','front',0).y});
  run.setAttackRange(8);run.ai.update(180);
  assert.deepEqual(run.ai.captureState().destination,{x:run.leader.position.x+followOffset('east','back',0).x,y:run.leader.position.y+followOffset('east','back',0).y});
  const support=setup();support.skill('prayer-of-recovery','heal');support.ai.update(60);
  assert.deepEqual(support.ai.captureState().destination,{x:support.leader.position.x+followOffset('east','support',0).x,y:support.leader.position.y+followOffset('east','support',0).y});
});

test('follow slots keep two companions on opposite sides',()=>{
  const left=setup();left.setSlot(0);left.ai.update(60);
  const right=setup();right.setSlot(1);right.ai.update(60);
  assert.notDeepEqual(left.ai.captureState().destination,right.ai.captureState().destination);
});

test('two companions in different slots attack a shared target from opposite sides',()=>{
  const approach=(slot:0|1)=>{
    const run=setup();run.setSlot(slot);run.member.position={x:60,y:128};
    run.enemy.position={x:240,y:128};run.focus('enemy');
    for(let frame=0;frame<400;frame++)run.advance();
    return run;
  };
  const left=approach(0),right=approach(1);
  // 两名伙伴都进入攻击距离，但落点在目标两侧，不再挤到同一个点。
  assert.ok(attackDistance(left.member.position,box,left.enemy.position,box)<=4,'左侧伙伴进入攻击范围');
  assert.ok(attackDistance(right.member.position,box,right.enemy.position,box)<=4,'右侧伙伴进入攻击范围');
  assert.ok(left.member.position.y<left.enemy.position.y,'槽位 0 落在目标一侧');
  assert.ok(right.member.position.y>right.enemy.position.y,'槽位 1 落在目标另一侧');
});

test('two companions stacked on one target separate to their own sides',()=>{
  const leader:Combatant={id:'player',team:'party',position:{x:128,y:128},bounds:box};
  const enemy:Combatant={id:'enemy',team:'enemy',position:{x:240,y:128},bounds:box};
  const members:Combatant[]=[0,1].map(index=>({id:`companion-${index}`,team:'party',
    position:{x:80,y:124+index*8},bounds:box}));
  const actors=new Map([leader,enemy,...members].map(actor=>[actor.id,actor]));
  const paths=new Map<string,()=>Point|undefined>();
  const ais=members.map((member,index)=>{
    const port:PartyPort={cooldowns:new CombatCooldownStore(()=>0).forActor(member.id),
      actor:id=>actors.get(id),candidates:()=>[...actors.values()],leader:()=>leader,
      leaderFacing:()=> 'east',followSlot:()=>index as 0|1,focusTarget:()=>'enemy',inCombat:()=>true,
      facing:()=> 'east',face:()=>{},navigationBounds:()=>({x:0,y:0,width:400,height:400}),
      canStand:point=>point.x>=0&&point.x<=400&&point.y>=0&&point.y<=400,
      followPath:next=>{paths.set(member.id,next);},moveToward:()=>assert.fail('party movement must use its navigable path'),
      stop:()=>{paths.delete(member.id);},relocate:point=>{member.position={...point};},
      skills:()=>[],skillKind:()=>undefined,vitals:id=>id==='player'?{health:100,maxHealth:100}:undefined,
      attacking:()=>false,attackRange:()=>4,play:()=>()=>{},frame:()=>{},clearEffects:()=>{}};
    return new PartyController(member.id,port,new CombatController(member.id,
      resolveBasicAttack(catalog,catalog.classes[0]),port));
  });
  for(let frame=0;frame<400;frame++){
    for(const [id,next] of paths){
      const point=next();if(!point)continue;
      const member=actors.get(id) as Combatant;member.position={...point};
    }
    for(const ai of ais)ai.update(60);
  }
  const [left,right]=members;
  assert.ok(attackDistance(left.position,box,enemy.position,box)<=4&&attackDistance(right.position,box,enemy.position,box)<=4,
    '两名伙伴都进入攻击范围');
  assert.ok(targetDistance(left.position,right.position)>16,'两名伙伴不再叠在同一个点');
  assert.ok(left.position.y<enemy.position.y&&right.position.y>enemy.position.y,'各自站在目标两侧');
});

test('an unreachable flank falls back to the normal attack approach',()=>{
  const run=setup();run.setSlot(0);run.member.position={x:60,y:128};
  run.enemy.position={x:240,y:128};run.focus('enemy');
  // 目标北侧的侧翼锚点整片不可站；西侧的普通接敌路线仍然可走。
  run.port.canStand=point=>point.x>=0&&point.x<=400&&point.y>=100&&point.y<=400;
  run.port.pathBudget={take:(_owner,limit)=>Math.min(limit,32)};
  // 有路的西侧只隔 180px；堵死的绕侧点不能让队友先花几十帧搜遍整张地图。
  for(let frame=0;frame<40&&!run.plays.length;frame++)run.advance();
  assert.ok(attackDistance(run.member.position,box,run.enemy.position,box)<=4,'退回普通追击后仍能接敌');
  assert.equal(run.plays.at(-1)?.target?.id,'enemy');
});

test('companions follow to their stance point when no enemy is nearby',()=>{
  const run=setup();run.ai.update(60);assert.ok(run.waypoint());
  run.advance(80);
  const goal={x:run.leader.position.x+followOffset('east','front',0).x,y:run.leader.position.y+followOffset('east','front',0).y};
  assert.ok(targetDistance(run.member.position,goal)<=12);
  assert.equal(run.waypoint(),undefined);
  assert.equal(run.plays.length,0);
});

test('combat without a target returns to following instead of holding position',()=>{
  const run=setup();run.fighting();run.leader.position={x:160,y:128};run.ai.update(60);
  assert.ok(run.waypoint(),'战斗中没目标也要回到跟随');
});

test('support skills are attempted before damage skills',()=>{
  const run=setup(()=>0);run.enemy.position={x:56,y:32};run.leader.position={x:72,y:32};run.vitals.set('player',{health:10,maxHealth:100});
  run.fighting();run.focus('enemy');run.skills([['dark-strike','chance'],['prayer-of-recovery','heal']]);run.ai.update(60);
  assert.equal(run.plays[0]?.skill?.id,'prayer-of-recovery','治疗优先于输出');
});

test('native AI thresholds distinguish regular and high frequency and following state',()=>{
  assert.equal(partySkillThreshold('chance',1,false),30);assert.equal(partySkillThreshold('chance',2,false),100);
  assert.equal(partySkillThreshold('combat-chance',1,false),30);assert.equal(partySkillThreshold('combat-chance',2,false),50);
  assert.equal(partySkillThreshold('combat-chance',1,true),50);assert.equal(partySkillThreshold('combat-chance',2,true),100);
  assert.equal(partySkillThreshold('heal',1,false),50);assert.equal(partySkillThreshold('heal',2,false),70);
  assert.equal(partySkillThreshold('emergency-heal',1,false),20);assert.equal(partySkillThreshold('emergency-heal',2,false),40);
  assert.equal(partySkillThreshold('ally-combat',1,false),60);assert.equal(partySkillThreshold('ally-combat',2,false),80);
});

test('chance sampling, frequency and mana checks stay unchanged',()=>{
  for(const [roll,frequency,mana,expected] of [[29,1,1000,'dark-strike'],[30,1,1000,undefined],[99,2,1000,'dark-strike'],[1,0,1000,undefined],[1,1,0,undefined]] as const){
    const run=setup(()=> (roll-.5)/99);run.enemy.position={x:56,y:32};run.focus('enemy');run.skill('dark-strike','chance',frequency);run.mana(mana);run.ai.update(60);
    assert.equal(run.plays[0]?.skill?.id,expected);assert.equal(run.plays.length,1);
  }
});

test('healing still checks living allies, health thresholds and skill radius',()=>{
  for(const [health,frequency,x,casts] of [[49,1,72,true],[50,1,72,false],[69,2,72,true],[70,2,72,false],[0,2,72,false],[1,1,160,false]] as const){
    const run=setup();run.leader.position={x,y:32};run.vitals.set('player',{health,maxHealth:100});run.fighting();
    run.skill('prayer-of-recovery','heal',frequency);run.ai.update(60);
    assert.equal(run.plays[0]?.skill?.id,casts?'prayer-of-recovery':undefined);
  }
});

test('ally-combat skills still require another attacking ally',()=>{
  for(const [attacker,roll,casts] of [['member',1,false],['enemy',1,false],['player',59,true],['player',60,false]] as const){
    const run=setup(()=> (roll-.5)/99);run.enemy.position={x:56,y:32};run.focus('enemy');run.attacking.add(attacker);
    run.skill('curse-of-screams','ally-combat');run.ai.update(60);
    assert.equal(run.plays[0]?.skill?.id,casts?'curse-of-screams':undefined);
  }
});

test('no party skills fire outside combat',()=>{
  const run=setup();run.skill('demon-s-shield','chance');run.ai.update(60);
  assert.equal(run.plays.length,0);assert.ok(run.waypoint());
  run.fighting();run.ai.update(60);
  assert.equal(run.plays[0]?.skill?.id,'demon-s-shield');
});

test('a follow search yields when the shared budget is exhausted and retries later',()=>{
  const run=setup();let grants=0;
  run.port.canStand=()=>false;
  run.port.pathBudget={take:()=>{grants++;return 0;}};
  run.ai.update(60);
  assert.ok(grants>0);assert.equal(run.boundsCalls(),1);
  run.port.pathBudget=undefined;run.ai.update(60);
  assert.equal(run.boundsCalls(),1);
});

test('a follow search resumes across frames instead of restarting',()=>{
  const run=setup();
  run.port.pathBudget={take:(_owner,limit)=>Math.min(2,limit)};
  let snapshots=0, blocked:Point|undefined={x:40,y:40};
  const free=run.port.canStand;
  run.port.navigationSnapshot=()=>{
    snapshots++;
    return {bounds:run.port.navigationBounds(),canStand:free};
  };
  run.port.canStand=point=>free(point)&&!(blocked&&Math.abs(point.x-blocked.x)<8&&Math.abs(point.y-blocked.y)<8);
  run.ai.update(60);
  assert.equal(run.boundsCalls(),1);assert.equal(run.waypoint(),undefined);
  blocked=undefined;
  for(let frame=0;frame<300&&!run.waypoint();frame++)run.ai.update(60);
  blocked=run.waypoint();assert.ok(blocked);assert.equal(snapshots,1);
  assert.equal(run.waypoint(),undefined,'路线算好之后，新挡住的下一步仍然不能走');
});

test('a stuck follower is placed beside the leader once and then waits for the cooldown',()=>{
  const run=setup();let regroups=0;
  run.port.regroup=()=>{regroups++;run.ai.cancel();run.member.position={...run.leader.position};return true;};
  for(let frame=0;frame<80;frame++)run.ai.update(60);
  assert.equal(regroups,1);
  for(let frame=0;frame<20;frame++)run.ai.update(60);
  assert.equal(regroups,1);
});

test('an unreachable combat target does not immediately teleport a companion',()=>{
  const run=setup();let regroups=0;
  run.enemy.position={x:200,y:128};run.focus('enemy');
  run.port.canStand=point=>point.x>=0&&point.x<=100&&point.y>=0&&point.y<=400;
  run.port.regroup=()=>{regroups++;run.ai.cancel();run.member.position={...run.leader.position};return true;};
  for(let frame=0;frame<70;frame++)run.ai.update(60);
  assert.equal(regroups,0);
  for(let frame=0;frame<20;frame++)run.ai.update(60);
  assert.equal(regroups,0);
});

test('a far follower starts walking instead of teleporting',()=>{
  const run=setup();let regroups=0;run.enemy.position={x:10,y:390};run.enemy2.position={x:30,y:390};
  run.member.position={x:0,y:0};run.leader.position={x:360,y:360};
  run.port.regroup=()=>{regroups++;run.ai.cancel();run.member.position={...run.leader.position};return true;};
  run.ai.update(60);
  assert.equal(regroups,0);assert.ok(run.waypoint());
});

test('removing a focused target clears the pursuit path',()=>{
  const run=setup();run.enemy.position={x:200,y:128};run.focus('enemy');
  for(let frame=0;frame<20&&!run.waypoint();frame++)run.ai.update(60);
  assert.ok(run.waypoint());
  run.enemy.states=['stealthed'];run.ai.targetRemoved(run.enemy.id);
  assert.equal(run.waypoint(),undefined);
});

test('party checkpoints keep the pending logic frame and cached path without sharing mutable points',()=>{
  const run=setup();run.enemy.position={x:200,y:128};run.focus('enemy');run.ai.update(85);const saved=run.ai.captureState(),expected=structuredClone(saved);
  assert.equal(saved.accumulator,25);assert.equal(saved.clock,60);assert.ok(saved.path.length);
  saved.path[0].x+=100;assert.deepEqual(run.ai.captureState(),expected);
  run.ai.cancel();run.ai.restoreState(expected);
  assert.deepEqual(run.ai.captureState(),expected);
});

test('single-step decisions read session cooldowns without advancing their shared frame',()=>{
  const run=setup();run.enemy.position={x:56,y:32};run.shared('enemy');run.fighting();run.skill('demon-s-shield','chance');
  run.ai.step();
  assert.equal(run.plays.length,1);assert.equal(run.time.frame,0);run.finish();
  const duration=catalog.skills['demon-s-shield'].action!.cooldownFrames;
  run.time.frame=duration-1;run.ai.step();
  assert.equal(run.plays.filter(play=>play.skill).length,1);
  assert.equal(run.plays.length,2);
  run.finish();run.time.frame=duration;run.ai.step();
  assert.equal(run.plays.filter(play=>play.skill).length,2);
});
