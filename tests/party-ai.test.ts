import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {COUNTERATTACK_MODES,counterattackReady,DELAYED_COUNTERATTACK_HITS,PartyController,partySkillThreshold,
  type CounterattackMode,type PartyPort,type PartySkillKind} from '../src/domain/party-ai.ts';
import {CombatController,type ActionPlayback,type Combatant} from '../src/domain/combat.ts';
import {attackDistance,resolveBasicAttack,targetDistance} from '../src/domain/basic-attack.ts';
import type {BattleCatalog,EnemyPlayableSkill} from '../src/domain/battle.ts';
import type {Point} from '../src/domain/navigation.ts';
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const box={x:-8,y:-8,width:16,height:16};
function setup(random=()=>0){
  const time={frame:0};
  const member:Combatant={id:'member',team:'party',position:{x:32,y:32},bounds:box};
  const leader:Combatant={id:'player',team:'party',position:{x:128,y:32},bounds:box};
  const enemy:Combatant={id:'enemy',team:'enemy',position:{x:56,y:32},bounds:box};
  const enemy2:Combatant={id:'enemy2',team:'enemy',position:{x:48,y:48},bounds:box};
  const actors=new Map([member,leader,enemy,enemy2].map(actor=>[actor.id,actor]));
  const plays:ActionPlayback[]=[];let completed:(()=>void)|undefined,path:(()=>Point|undefined)|undefined;
  const vitals=new Map([[member.id,{health:100,maxHealth:100}],[leader.id,{health:100,maxHealth:100}]]);
  const attacking=new Set<string>();let focus:string|undefined,counterattack:CounterattackMode=2,damageCount=0,mana=1000,skills:EnemyPlayableSkill[]=[],fighting=false;
  let sharedTarget:string|undefined,sharedCalls=0;
  const kinds=new Map<string,PartySkillKind>();let boundsCalls=0;
  const port:PartyPort={cooldowns:new CombatCooldownStore(()=>time.frame).forActor(member.id),actor:id=>actors.get(id),candidates:()=>[...actors.values()],leader:()=>leader,
    focusTarget:()=>focus,partyTarget:()=>{sharedCalls++;return sharedTarget;},inCombat:()=>fighting||!!focus,counterattack:()=>counterattack,damageCount:()=>damageCount,facing:()=> 'east',face:()=>{},
    navigationBounds:()=>{boundsCalls++;return {x:8,y:8,width:176,height:80};},canStand:p=>p.x>=8&&p.x<=184&&p.y>=8&&p.y<=88,
    followPath:next=>{path=next;},moveToward:()=>assert.fail('party movement must use its navigable path'),
    stop:()=>{path=undefined;},relocate:p=>{member.position={...p};},
    skills:()=>skills,skillKind:id=>kinds.get(id),vitals:id=>vitals.get(id),attacking:id=>attacking.has(id),attackRange:()=>4,
    canSpendMana:cost=>cost<=mana,spendMana:cost=>{if(cost>mana)return false;mana-=cost;return true;},
    play:(action,_frame,complete)=>{plays.push(action);completed=complete;return ()=>{};},frame:()=>{},clearEffects:()=>{}};
  const combat=new CombatController(member.id,resolveBasicAttack(catalog,catalog.classes[0]),port);
  const ai=new PartyController(member.id,port,combat,random);
  return {ai,combat,port,time,member,leader,enemy,enemy2,actors,plays,vitals,attacking,waypoint:()=>path?.(),boundsCalls:()=>boundsCalls,
    focus:(id:string|undefined)=>{focus=id;},shared:(id:string|undefined)=>{sharedTarget=id;},sharedCalls:()=>sharedCalls,fighting:(value=true)=>{fighting=value;},counterattack:(mode:CounterattackMode)=>{counterattack=mode;},
    damage:(value:number)=>{damageCount=value;},mana:(value:number)=>{mana=value;},
    skill:(id:string,kind:PartySkillKind,frequency=1)=>{kinds.set(id,kind);skills=[{id,name:catalog.skills[id].name,action:catalog.skills[id].action!,manaCost:catalog.skills[id].ranks[0].manaCost,frequency,clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'}}];},
    finish:()=>completed?.(),advance:(frames=1)=>{for(let i=0;i<frames;i++){const next=path?.();if(next)member.position={...next};ai.update(60);}}};
}

test('party healers still heal stealthed allies while hidden enemies lose focus and retaliation',()=>{
 const run=setup();run.leader.states=['stealthed'];run.leader.position={x:56,y:32};
 run.vitals.set('player',{health:10,maxHealth:100});run.fighting();run.skill('prayer-of-recovery','heal');run.ai.update(60);
 assert.equal(run.plays[0]?.skill?.id,'prayer-of-recovery');
 const fighter=setup();fighter.enemy.states=['stealthed'];fighter.enemy2.states=['stealthed'];fighter.focus(fighter.enemy.id);
 fighter.ai.onContact({casterId:fighter.enemy.id,targetId:fighter.member.id});fighter.ai.update(60);
 assert.equal(fighter.plays.length,0);assert.equal(fighter.ai.captureState().retaliation,undefined);
});

test('immediate target removal clears party retaliation and an established pursuit path',()=>{
 const run=setup();run.enemy.position={...run.leader.position};
 run.ai.onContact({casterId:run.enemy.id,targetId:run.member.id});run.ai.update(60);assert.ok(run.waypoint());
 run.enemy.states=['stealthed'];run.ai.targetRemoved(run.enemy.id);
 assert.equal(run.ai.captureState().retaliation,undefined);assert.equal(run.waypoint(),undefined);
});

test('party root blocks following but retains nearby attacks and ambush allows following its ally leader',()=>{
 const run=setup();run.member.states=['immobilized'];run.ai.update(60);assert.equal(run.waypoint(),undefined);
 run.focus(run.enemy.id);run.ai.update(60);assert.equal(run.plays.length,1);
 const ambush=setup();ambush.member.states=['ambush'];ambush.enemy.position={...ambush.leader.position};
 ambush.focus(ambush.enemy.id);ambush.ai.update(60);assert.equal(ambush.waypoint(),undefined);
 ambush.focus(undefined);ambush.ai.update(60);assert.ok(ambush.waypoint());
});
test('followers navigate to the leader and stop within four native units without acquiring nearby enemies',()=>{
  const run=setup();run.ai.update(59);assert.equal(run.waypoint(),undefined);run.ai.update(1);assert.ok(run.waypoint());
  run.advance(40);assert.ok(attackDistance(run.member.position,box,run.leader.position,box)<4);
  assert.equal(run.waypoint(),undefined);assert.equal(run.plays.length,0);
  run.leader.position={x:32,y:72};run.advance();assert.ok(run.waypoint());
  run.ai.cancel();assert.equal(run.waypoint(),undefined);run.ai.dispose();run.advance(10);assert.equal(run.plays.length,0);
});
test('followers walk to their own formation slot instead of the leader position',()=>{
  const run=setup(),goal={x:128,y:48};
  run.port.followGoal=()=>goal;
  run.ai.update(60);run.ai.update(60);
  assert.deepEqual(run.ai.captureState().destination,goal);
  run.advance(60);
  assert.ok(targetDistance(run.member.position,goal)<=8);
  assert.equal(run.waypoint(),undefined);
});

test('once the party is fighting, followers engage an enemy through the default attack',()=>{
  const run=setup();run.fighting();run.ai.update(60);
  assert.equal(run.plays.at(-1)?.target?.id,'enemy','默认普攻由 CombatController 自动索敌');
});
test('a companion with no enemy in range follows the leader instead of standing still in combat',()=>{
  const run=setup();run.fighting();
  run.enemy.position={x:600,y:600};run.enemy2.position={x:600,y:600};
  run.ai.update(60);
  assert.equal(run.plays.length,0,'附近没有敌人时默认普攻不能凭空出手');
  assert.ok(run.waypoint(),'队伍在别处开战时，佣兵仍要跟向队长');
});

test('fighting companions pursue the controlled character target beyond their own search radius',()=>{
  const run=setup();run.enemy.position={x:160,y:32};run.fighting();run.shared('enemy');run.ai.update(60);
  assert.ok(run.waypoint(),'共享目标在自身索敌半径外时也要生成追击路径');
  assert.equal(run.plays.length,0,'尚未进入射程时不攻击');
  run.advance(60);
  assert.equal(run.plays.at(-1)?.target?.id,'enemy','进入射程后攻击共享目标');
});

test('shared party target is ignored until the party is fighting',()=>{
  const run=setup();run.enemy.position={x:160,y:32};run.shared('enemy');run.ai.update(60);
  assert.equal(run.sharedCalls(),0,'未开战时不应读取共享目标');
  assert.equal(run.plays.length,0);assert.ok(run.waypoint(),'未开战时仍然跟随队长');
});

test('explicit focus and retaliation outrank the shared party target',()=>{
  const focused=setup();focused.fighting();focused.shared('enemy');focused.focus('enemy2');focused.ai.update(60);
  assert.equal(focused.plays.at(-1)?.target?.id,'enemy2');
  const retaliating=setup();retaliating.fighting();retaliating.shared('enemy');
  retaliating.ai.onContact({casterId:'enemy2',targetId:'member'});retaliating.ai.update(60);
  assert.equal(retaliating.plays.at(-1)?.target?.id,'enemy2');
});

test('clearing the shared target returns companions to the leader',()=>{
  const run=setup();run.enemy.position={x:160,y:32};run.fighting();run.shared('enemy');run.ai.update(60);
  assert.ok(run.waypoint());
  run.shared(undefined);run.fighting(false);run.ai.cancel();run.ai.update(60);
  assert.ok(run.waypoint(),'共享目标清空且脱战后恢复跟随队长');
  assert.equal(run.plays.length,0);
});

test('only explicit focus or opposing contact starts attacks, and disabling counterattack clears retaliation',()=>{
  const run=setup();run.ai.onContact({casterId:'player',targetId:'member'});run.ai.update(60);assert.equal(run.plays.length,0);
  run.ai.onContact({casterId:'enemy',targetId:'player'});run.ai.update(60);assert.equal(run.plays.length,0);
  run.counterattack(0);run.ai.onContact({casterId:'enemy',targetId:'member'});run.ai.update(60);assert.equal(run.plays.length,0);
  run.counterattack(2);run.ai.onContact({casterId:'enemy',targetId:'member'});run.ai.update(60);assert.equal(run.plays.at(-1)?.target?.id,'enemy');
  run.ai.cancel();run.focus('enemy2');run.ai.update(60);assert.equal(run.plays.at(-1)?.target?.id,'enemy2');
  run.ai.cancel();run.focus(undefined);run.ai.onContact({casterId:'enemy',targetId:'member'});run.counterattack(0);run.ai.update(60);
  assert.equal(run.plays.length,2);assert.ok(run.waypoint());
});
test('counterattack modes follow the original three levels and the delayed gate needs three hits',()=>{
  assert.deepEqual(COUNTERATTACK_MODES,[0,1,2]);assert.equal(DELAYED_COUNTERATTACK_HITS,3);
  assert.equal(counterattackReady(0,9),false);
  assert.equal(counterattackReady(1,2),false);assert.equal(counterattackReady(1,3),true);
  assert.equal(counterattackReady(2,0),true);
  const run=setup();run.counterattack(1);run.damage(2);
  run.ai.onContact({casterId:'enemy',targetId:'member'});run.ai.update(60);assert.equal(run.plays.length,0);
  run.damage(3);run.ai.onContact({casterId:'enemy',targetId:'member'});run.ai.update(60);assert.equal(run.plays.at(-1)?.target?.id,'enemy');
  run.ai.cancel();run.ai.onContact({casterId:'enemy',targetId:'member'});run.ai.update(60);
  assert.equal(run.plays.length,2,'计数未回落时重新受击仍会转入战斗');
  run.counterattack(0);run.ai.onContact({casterId:'enemy',targetId:'member'});run.ai.update(60);assert.equal(run.plays.length,2);
});
test('native AI thresholds distinguish regular and high frequency and following state',()=>{
  assert.equal(partySkillThreshold('chance',1,false),30);assert.equal(partySkillThreshold('chance',2,false),100);
  assert.equal(partySkillThreshold('combat-chance',1,false),30);assert.equal(partySkillThreshold('combat-chance',2,false),50);
  assert.equal(partySkillThreshold('combat-chance',1,true),50);assert.equal(partySkillThreshold('combat-chance',2,true),100);
  assert.equal(partySkillThreshold('heal',1,false),50);assert.equal(partySkillThreshold('heal',2,false),70);
  assert.equal(partySkillThreshold('emergency-heal',1,false),20);assert.equal(partySkillThreshold('emergency-heal',2,false),40);
  assert.equal(partySkillThreshold('ally-combat',1,false),60);assert.equal(partySkillThreshold('ally-combat',2,false),80);
});
test('chance sampling is strict at thirty, disabled or unaffordable skills fall back to basic attack',()=>{
  for(const [roll,frequency,mana,expected] of [[29,1,1000,'dark-strike'],[30,1,1000,undefined],[99,2,1000,'dark-strike'],[1,0,1000,undefined],[1,1,0,undefined]] as const){
    const run=setup(()=> (roll-.5)/99);run.focus('enemy');run.skill('dark-strike','chance',frequency);run.mana(mana);run.ai.update(60);
    assert.equal(run.plays[0]?.skill?.id,expected);assert.equal(run.plays.length,1);
  }
});
test('healing checks living allies, original strict health thresholds and skill radius during combat',()=>{
  for(const [health,frequency,x,casts] of [[49,1,72,true],[50,1,72,false],[69,2,72,true],[70,2,72,false],[0,2,72,false],[1,1,160,false]] as const){
    const run=setup();run.leader.position={x,y:32};run.vitals.set('player',{health,maxHealth:100});run.fighting();run.skill('prayer-of-recovery','heal',frequency);run.ai.update(60);
    assert.equal(run.plays[0]?.skill?.id,casts?'prayer-of-recovery':undefined);
  }
});
test('ally-combat skills require another attacking ally and use the strict sixty threshold',()=>{
  for(const [attacker,roll,casts] of [['member',1,false],['enemy',1,false],['player',59,true],['player',60,false]] as const){
    const run=setup(()=> (roll-.5)/99);run.focus('enemy');run.attacking.add(attacker);run.skill('curse-of-screams','ally-combat');run.ai.update(60);
    assert.equal(run.plays[0]?.skill?.id,casts?'curse-of-screams':undefined);
  }
});

test('no party skills fire outside combat, including self buffs that need no hostile target',()=>{
  const run=setup();run.skill('demon-s-shield','chance');run.ai.update(60);
  assert.equal(run.plays.length,0);assert.ok(run.waypoint());
  run.fighting();run.ai.update(60);
  assert.equal(run.plays[0]?.skill?.id,'demon-s-shield');assert.equal(run.plays[0]?.target,undefined);
  const offensive=setup();offensive.skill('dark-strike','chance');offensive.fighting();offensive.ai.update(60);
  assert.equal(offensive.plays.length,1,'战斗中没有指派目标时先按默认普攻自动索敌');
  assert.equal(offensive.plays[0]?.target?.id,'enemy');
  assert.equal(offensive.plays[0]?.skill,undefined);
  offensive.finish();offensive.ai.update(60);
  assert.equal(offensive.plays.at(-1)?.skill?.id,'dark-strike','下一空闲帧用选中的目标释放技能');
});
test('disabling counterattack cancels an in-progress retaliation but preserves an explicit focus order',()=>{
  for(const explicit of [false,true]){
    const run=setup();run.ai.onContact({casterId:'enemy',targetId:'member'});if(explicit)run.focus('enemy');run.ai.update(60);
    assert.equal(run.ai.snapshot().state,'attacking');run.counterattack(0);run.ai.update(60);
    assert.equal(run.ai.snapshot().state,explicit?'attacking':'idle');
    if(!explicit){assert.ok(run.waypoint());run.finish();assert.equal(run.ai.snapshot().state,'idle');}
  }
});
test('changing pursuit target or required range invalidates the cached follow path even at the same destination',()=>{
  const run=setup();run.ai.update(60);assert.equal(run.boundsCalls(),1);
  run.enemy.position={...run.leader.position};run.focus('enemy');run.ai.update(60);assert.equal(run.boundsCalls(),2);
  run.port.attackRange=()=>1;run.ai.update(60);assert.equal(run.boundsCalls(),3);
  run.focus(undefined);run.ai.update(60);assert.equal(run.boundsCalls(),4);
});
test('followers re-path after the leader moves three grid steps, not on every step',()=>{
  const run=setup();run.ai.update(60);const base=run.boundsCalls();
  run.ai.update(180);
  run.leader.position={x:run.leader.position.x+8,y:32};run.ai.update(60);
  assert.equal(run.boundsCalls(),base,'队长只挪一格不重算');
  run.leader.position={x:run.leader.position.x+16,y:32};run.ai.update(60);
  assert.equal(run.boundsCalls(),base+1,'队长走远三格才重算');
});
test('a follow search yields when the shared budget is exhausted and retries later',()=>{
  const run=setup();let grants=0;
  run.port.pathBudget={take:()=>{grants++;return 0;}};
  run.ai.update(60);
  assert.ok(grants>0,'跟随者向共享预算申请扩展');
  assert.equal(run.boundsCalls(),0,'没有预算时这一帧不开搜索');
  run.port.pathBudget=undefined;run.ai.update(60);
  assert.equal(run.boundsCalls(),1,'预算恢复后再算');
});
test('a follow search resumes across frames instead of restarting from the beginning',()=>{
  const run=setup();
  run.port.pathBudget={take:limit=>Math.min(2,limit)};
  run.ai.update(60);
  assert.equal(run.boundsCalls(),1,'第一帧只开一次搜索');
  assert.equal(run.waypoint(),undefined,'两格预算还算不完');
  for(let frame=0;frame<300&&!run.waypoint();frame++)run.ai.update(60);
  assert.ok(run.waypoint(),'跨帧累计的预算最终算出路径');
  assert.equal(run.boundsCalls(),1,'算的过程中不能丢掉搜索重来');
});

test('a stale first waypoint is re-planned from the real feet instead of waiting for the next interval',()=>{
  // 上报现场：佣兵被水井边缘挤偏 0.16px，旧路线第一个点 (224,632) 从真实脚点走不过去。
  const run=setup();let plans=0;
  run.member.position={x:215.83710015815083,y:632.1628998418491};
  run.leader.position={x:464.36794334335286,y:637.9666840112111};
  run.port.navigationBounds=()=>{plans++;return {x:0,y:0,width:640,height:720};};
  run.port.canStand=point=>point.x>=8&&point.x<=632&&point.y>=8&&point.y<=712
    &&!(point.x+8>224&&point.x-8<240&&point.y+8>640&&point.y-8<656);
  run.ai.restoreState({accumulator:0,clock:0,nextPathAt:180,path:[{x:224,y:632},{x:232,y:632}],
    destination:{...run.leader.position},destinationTarget:'player',destinationRange:3});
  run.ai.update(60);
  assert.equal(plans,1,'第一步失效时这一帧就重算');
  for(let frame=0;frame<10&&!run.waypoint();frame++)run.ai.update(60);
  assert.deepEqual(run.waypoint(),{x:216,y:632},'从真实脚点重新对齐到网格，再继续跟随');
});
test('a follower with no progress for the watchdog window is pulled beside the leader once',()=>{
  const run=setup();let regroups=0;
  run.port.regroup=()=>{regroups++;run.ai.cancel();run.member.position={...run.leader.position};};
  run.ai.update(60);
  for(let frame=0;frame<40;frame++)run.ai.update(60);
  assert.equal(regroups,1,'一直站着不能干等寻路，应该收拢到队长身边');
  for(let frame=0;frame<20;frame++)run.ai.update(60);
  assert.equal(regroups,1,'收拢后恢复普通跟随，不能反复传送');
});

test('a companion chasing an unreachable focused enemy is pulled beside the leader once',()=>{
  const run=setup();let regroups=0;
  run.enemy.position={x:300,y:32};
  run.port.canStand=point=>point.x>=8&&point.x<=120&&point.y>=8&&point.y<=88;
  run.port.regroup=()=>{regroups++;run.ai.cancel();run.member.position={...run.leader.position};};
  run.focus('enemy');
  for(let frame=0;frame<70;frame++)run.ai.update(60);
  assert.equal(regroups,1,'路径被地形封死时，追击目标也要收拢到队长身边');
  for(let frame=0;frame<20;frame++)run.ai.update(60);
  assert.equal(regroups,1,'目标仍不可达时也不能每 1.5 秒反复瞬移');
});

test('a default basic-attack approach with no progress is cancelled and recovered once',()=>{
  const run=setup();let regroups=0;
  run.enemy.position={x:80,y:32};run.enemy2.position={x:-100,y:-100};
  run.port.moveToward=()=>{};
  run.port.regroup=()=>{regroups++;run.ai.cancel();run.member.position={...run.leader.position};};
  run.fighting();
  for(let frame=0;frame<70;frame++)run.ai.update(60);
  assert.equal(regroups,1,'默认普攻直线接近撞墙后也要取消接近并收拢');
});

test('a companion in combat without a target still recovers when the leader route is blocked',()=>{
  const run=setup();let regroups=0;
  run.enemy.position={x:300,y:32};run.enemy2.position={x:-100,y:-100};
  run.port.canStand=point=>point.x>=8&&point.x<=120&&point.y>=8&&point.y<=88;
  run.port.regroup=()=>{regroups++;run.ai.cancel();run.member.position={...run.leader.position};};
  run.fighting();
  for(let frame=0;frame<70;frame++)run.ai.update(60);
  assert.equal(regroups,1,'战斗中没有目标时跟队长也不能每帧清空掉队计时');
});

test('party checkpoints restore the pending logic frame and cached navigation without sharing mutable points',()=>{
  const run=setup();run.ai.update(85);const saved=run.ai.captureState(),expected=structuredClone(saved);
  assert.equal(saved.accumulator,25);assert.equal(saved.clock,60);assert.ok(saved.path.length);
  saved.path[0].x+=100;assert.deepEqual(run.ai.captureState(),expected);
  run.ai.cancel();run.ai.update(600);run.ai.cancel();run.ai.restoreState(expected);
  assert.deepEqual(run.ai.captureState(),expected);assert.equal(run.waypoint(),undefined);
  expected.path[0].x+=100;expected.destination!.x+=100;
  assert.notDeepEqual(run.ai.captureState(),expected);
  const bounds=run.boundsCalls();run.ai.update(34);assert.equal(run.waypoint(),undefined);
  run.ai.update(1);assert.ok(run.waypoint());assert.equal(run.boundsCalls(),bounds);
  assert.equal(run.ai.captureState().clock,120);
});
test('restoring a party decision keeps its pending retaliation and leaves combat restoration to its owner',()=>{
  const run=setup();run.ai.onContact({casterId:'enemy',targetId:'member'});run.ai.update(25);
  const saved=run.ai.captureState();run.ai.cancel();run.focus('enemy2');run.ai.update(60);
  const combat=run.combat.snapshot();run.ai.restoreState(saved);assert.deepEqual(run.combat.snapshot(),combat);
  run.combat.cancel(true);run.focus(undefined);run.ai.update(35);
  assert.equal(run.plays.at(-1)?.target?.id,'enemy');
});


test('party single-step decisions read session cooldowns without advancing their shared frame',()=>{
  const run=setup();run.fighting();run.skill('demon-s-shield','chance');run.ai.step();
  assert.equal(run.plays.length,1);assert.equal(run.time.frame,0);run.finish();
  const duration=catalog.skills['demon-s-shield'].action!.cooldownFrames;
  run.time.frame=duration-1;run.ai.step();
  assert.equal(run.plays.filter(play=>play.skill).length,1,'冷却中不再释放同一个技能');
  assert.equal(run.plays.length,2,'战斗中的空档用普攻迎战');
  assert.equal(run.ai.snapshot().cooldowns['demon-s-shield'].remainingMs,60);
  run.finish();
  run.time.frame=duration;assert.deepEqual(run.ai.snapshot().cooldowns,{});
  run.ai.step();assert.equal(run.plays.filter(play=>play.skill).length,2);
});
