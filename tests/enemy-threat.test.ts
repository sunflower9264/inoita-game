import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EnemyController } from '../src/domain/enemy-ai.ts';
import type { EnemyPort } from '../src/domain/enemy-ai.ts';
import { CombatController } from '../src/domain/combat.ts';
import type { ActionPlayback, Combatant } from '../src/domain/combat.ts';
import type { EnemyBehavior, EnemyPlayableSkill, ResolvedBasicAttack } from '../src/domain/battle.ts';
import type { Point } from '../src/domain/navigation.ts';

const clips={north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'} as const;
const basic:ResolvedBasicAttack={profileId:'test',step:0,stepCount:1,frameDurationMs:60,cycleFrames:4,effectiveCycleFrames:4,
  damage:{effect:'physical',source:'bestNormalDamage',attributeWeights:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},ranks:[{fixedAddition:0,operation:{kind:'add',amount:0}}]},
  approachDistanceUnits:2,searchRadiusPx:100,strikeFrame:1,swingFrame:null,swings:[],impacts:[],projectile:null,
  clips,sequence:{north:[0,1,2,3],south:[0,1,2,3],east:[0,1,2,3],west:[0,1,2,3]}};
const skill:EnemyPlayableSkill={id:'spell',name:'spell',clips,manaCost:5,action:{requiresTarget:true,cooldownFrames:10,approachDistanceUnits:2,searchRadiusPx:100,transition:null,events:[]}};

test('immobile casting waits for its shared path budget and preserves an unfinished search',()=>{
  const run=setup([skill],'active',{canMove:false});
  run.scores.set('first',10);
  let grants=0;
  run.port.pathBudget={take:(_owner,limit)=>{assert.ok(limit<=128);grants++;return grants===1?0:1;}};
  run.ai.update(60);
  assert.equal(run.clears(),0);assert.equal(run.checks(),0,'没领到预算时不查询路径');
  for(let frame=0;frame<80;frame++)run.ai.update(60);
  assert.equal(run.clears(),0,'可达但需要多帧搜索的目标不会被误当成不可达');
  assert.equal(run.ai.snapshot().targetId,'first');
  assert.equal(run.spends(),0);assert.equal(run.plays.length,0);
});

test('immobile casting claims small budget slices and stops when it finds a reachable attack position',()=>{
  const run=setup([skill],'active',{canMove:false});run.scores.set('first',10);
  run.first.position.x=40;run.port.canStand=()=>true;
  const requests:number[]=[];
  run.port.pathBudget={take:(_owner,limit)=>{requests.push(limit);return limit;}};
  run.ai.update(60);
  assert.deepEqual(requests,[8],'近处找到攻击落点后不再领取剩余120个节点');
  assert.equal(run.clears(),0);assert.equal(run.ai.snapshot().targetId,'first');
  run.ai.update(60);assert.deepEqual(requests,[8],'可达缓存期间不领取新预算');
});

test('immobile casting keeps the per-decision expansion cap when every small slice is granted',()=>{
  const run=setup([skill],'active',{canMove:false});run.scores.set('first',10);
  run.first.position.x=400;run.port.canStand=point=>point.x<48;
  const requests:number[]=[];
  run.port.pathBudget={take:(_owner,limit)=>{requests.push(limit);return limit;}};
  run.ai.update(60);
  assert.ok(requests.length>1);assert.ok(requests.every(limit=>limit===8));
  assert.ok(requests.reduce((sum,limit)=>sum+limit,0)<=128);
});

test('immobile casting returns home only after an unreachable sliced search completes',()=>{
  const run=setup([skill],'active',{canMove:false});
  run.scores.set('first',10);
  run.port.navigationBounds=()=>({x:0,y:0,width:128,height:64});
  run.port.canStand=point=>point.x>=0&&point.y>=0&&point.x<48&&point.y<=64;
  let calls=0;run.port.pathBudget={take:()=>{calls++;return 1;}};
  run.ai.update(60);assert.equal(run.clears(),0);
  for(let frame=0;frame<100&&!run.clears();frame++)run.ai.update(60);
  assert.ok(calls>1);assert.equal(run.clears(),1);assert.equal(run.ai.snapshot().state,'returning');
});

test('an unreachable moving target cannot restart every slice of an immobile cast search',()=>{
  for(const movement of [.1,8]){
    const run=setup([skill],'active',{canMove:false});run.scores.set('first',10);
    run.port.navigationBounds=()=>({x:0,y:0,width:128,height:64});
    run.port.canStand=point=>point.x>=0&&point.y>=0&&point.x<48&&point.y<=64;
    let snapshots=0;
    run.port.navigationSnapshot=()=>{snapshots++;return {bounds:run.port.navigationBounds(),canStand:run.port.canStand};};
    run.port.pathBudget={take:()=>1};
    for(let frame=0;frame<100&&!run.clears();frame++){
      run.first.position.x=96+(frame%2)*movement;run.ai.update(60);
    }
    assert.equal(run.clears(),1);assert.equal(run.ai.snapshot().state,'returning');
    assert.equal(snapshots,1,'目标移动沿用同一份搜索前沿与地图快照');
  }
});

test('a moving target can become reachable from positions explored by earlier slices',()=>{
  const run=setup([skill],'active',{canMove:false});run.scores.set('first',10);
  run.port.navigationBounds=()=>({x:0,y:0,width:128,height:64});
  run.port.canStand=point=>point.x>=0&&point.y>=0&&point.x<48&&point.y<=64;
  let snapshots=0;
  run.port.navigationSnapshot=()=>{snapshots++;return {bounds:run.port.navigationBounds(),canStand:run.port.canStand};};
  let grants=0;run.port.pathBudget={take:()=>{grants++;return grants<=40?1:0;}};
  for(let frame=0;frame<40;frame++)run.ai.update(60);
  run.first.position={x:63,y:32};run.ai.update(60);
  assert.equal(run.clears(),0);assert.equal(run.ai.snapshot().targetId,'first');
  assert.equal(snapshots,1,'新的可攻击位置来自已探索区域，不丢弃前沿');
  run.first.position.x=64;run.port.pathBudget={take:()=>1};
  for(let frame=0;frame<100&&!run.clears();frame++)run.ai.update(60);
  assert.equal(run.clears(),1,'目标移出精确攻击范围后不会沿用旧的可达结论');
});

test('immobile cast searches release their frozen navigation on cancellation, restore and target loss',()=>{
  for(const reset of ['cancel','restore','disable','target-loss'] as const){
    const run=setup([skill],'active',{canMove:false});run.scores.set('first',10);
    let blocked=false,snapshots=0;
    run.port.navigationSnapshot=()=>{
      snapshots++;const capturedBlocked=blocked;
      return {bounds:run.port.navigationBounds(),canStand:point=>!capturedBlocked&&run.port.canStand(point)};
    };
    run.port.pathBudget={take:()=>1};run.ai.update(60);
    assert.equal(snapshots,1);assert.equal(run.clears(),0);
    const saved=run.ai.captureState();blocked=true;
    if(reset==='restore')run.ai.restoreState(saved);
    else if(reset==='target-loss')run.ai.targetRemoved('first');
    else run.ai[reset]();
    run.ai.update(60);
    assert.equal(snapshots,2,reset);assert.equal(run.clears(),1,reset);
  }
});

test('a reachable immobile cast refreshes its frozen navigation after the retry interval',()=>{
  const run=setup([skill],'active',{canMove:false});run.scores.set('first',10);
  let blocked=false,snapshots=0;
  run.port.navigationSnapshot=()=>{
    snapshots++;const capturedBlocked=blocked;
    return {bounds:run.port.navigationBounds(),canStand:point=>!capturedBlocked&&run.port.canStand(point)};
  };
  run.ai.update(60);assert.equal(run.clears(),0);assert.equal(snapshots,1);
  blocked=true;run.ai.update(120);assert.equal(snapshots,1);assert.equal(run.clears(),0);
  run.ai.update(60);assert.equal(snapshots,2);assert.equal(run.clears(),1);
});
function setup(skills:EnemyPlayableSkill[]=[],aggression:EnemyBehavior['aggression']='active',overrides:Partial<EnemyBehavior>={}){
  const actor:Combatant={id:'enemy',team:'enemy',position:{x:16,y:32},bounds:{x:-8,y:-8,width:16,height:16}};
  const first:Combatant={...actor,id:'first',team:'party',position:{x:96,y:32}};
  const second:Combatant={...actor,id:'second',team:'party',position:{x:40,y:32}};
  const selectedFrom:(string|undefined)[]=[];
  const actors=[actor,first,second],scores=new Map<string,number>(),plays:ActionPlayback[]=[],notices:string[]=[];
  let clears=0,selections=0,directMoves=0,spends=0,cancels=0,checks=0,affordable=true,finish=()=>{},waypoint:(()=>Point|undefined)|undefined;
  const port:EnemyPort={cooldowns:new CombatCooldownStore(()=>0).forActor(actor.id),actor:id=>actors.find(a=>a.id===id),candidates:()=>actors,facing:()=> 'east',home:()=>({x:16,y:32}),
    navigationBounds:()=>({x:0,y:0,width:512,height:128}),moveToward:()=>{directMoves++;},followPath:next=>{waypoint=next;},stop:()=>{waypoint=undefined;},
    canStand:point=>{checks++;return point.x>=0&&point.y>=0&&!(point.x>=48&&point.x<=56&&point.y<64);},relocate:position=>{actor.position=position;},
    play:(action,_frame,complete)=>{plays.push(action);finish=complete;return ()=>{cancels++;};},frame:()=>{},clearEffects:()=>{},
    canSpendMana:()=>affordable,spendMana:()=>{spends++;return affordable;},
    threat:{select:current=>{selections++;selectedFrom.push(current);return [...scores].filter(([id])=>port.actor(id)&&!port.actor(id)!.states?.includes('stealthed')).sort((a,b)=>b[1]-a[1])[0]?.[0]??current;},
      notice:id=>{notices.push(id);scores.set(id,10);},has:id=>scores.has(id),clear:()=>{clears++;scores.clear();}}};
  const behavior:EnemyBehavior={aggression,awarenessRangeUnits:12,canMove:true,canTurn:true,moveSpeedPxPerSecond:100,...overrides};
  const ai=new EnemyController(actor.id,behavior,basic,port,skills,()=>0);
  return {ai,actor,first,second,actors,scores,plays,notices,port,selectedFrom,finish:()=>finish(),waypoint:()=>waypoint?.(),
    clears:()=>clears,selections:()=>selections,directMoves:()=>directMoves,spends:()=>spends,cancels:()=>cancels,checks:()=>checks,
    affordable:(value:boolean)=>{affordable=value;}};
}

test('notice uses candidate order and starts an A* approach that retains its target until the action ends',()=>{
  const run=setup();run.ai.update(60);
  assert.deepEqual(run.notices,['first','second'],'同一决策点里视距内每个合法候选各 notice 一次');
  assert.equal(run.ai.combatController!.snapshot().state,'approaching');assert.ok(run.waypoint());assert.equal(run.directMoves(),0);
  const selections=run.selections();run.scores.set('second',100);run.ai.onThreatAdded();run.ai.update(60);
  assert.equal(run.ai.snapshot().targetId,'first');assert.equal(run.selections(),selections);
  const walked:Point[]=[];
  for(let i=0;i<60&&!run.plays.length;i++){const point=run.waypoint();if(point){walked.push(point);run.actor.position={...point};}run.ai.update(60);}
  assert.ok(walked.some(point=>point.y>=64),'the retained approach still routes around an obstacle');
  assert.equal(run.plays[0].target?.id,'first');
  run.ai.update(60);assert.equal(run.selections(),selections,'playing also keeps the old target');
  run.finish();run.ai.update(60);assert.equal(run.ai.snapshot().targetId,'second');
});

test('once-only skill remains available when its approach is interrupted',()=>{
  const run=setup([{...skill,once:true}]);run.scores.set('first',10);
  run.ai.update(60);
  assert.equal(run.ai.combatController!.actionState(),'approaching');
  assert.deepEqual(run.ai.captureState().spentOnce,[]);
  run.ai.disable();run.actor.position={x:80,y:32};run.ai.update(60);
  assert.equal(run.plays[0]?.skill?.id,'spell');
  assert.deepEqual(run.ai.captureState().spentOnce,['spell']);
});

test('approach completion requires the saved ledger entry before spending mana or setting cooldown',()=>{
  const run=setup([skill]);run.scores.set('first',10);run.ai.update(60);
  run.scores.delete('first');run.scores.set('second',20);run.actor.position={x:80,y:32};run.ai.update(60);
  assert.equal(run.ai.combatController!.snapshot().state,'idle');assert.equal(run.plays.length,0);
  assert.equal(run.spends(),0);assert.deepEqual(run.ai.snapshot().cooldowns,{});assert.equal(run.clears(),0);
  run.ai.update(60);assert.equal(run.ai.snapshot().targetId,'second');
});

test('an immediate forced cast does not require a ledger entry or repeat selection eligibility',()=>{
  const run=setup();run.second.position.x=32;const controller=new CombatController(run.actor.id,basic,{...run.port,canFinishApproach:()=>false,canSelectSkill:()=>false});
  assert.equal(controller.requestTriggeredAction(skill,'second'),'started');assert.equal(run.plays.length,1);assert.equal(run.spends(),1);
});

test('hidden targets retain their ledger entries while an inactive current target clears only its owner',()=>{
  const run=setup();run.scores.set('first',10);run.scores.set('second',1);run.ai.update(60);
  run.first.states=['stealthed'];run.ai.targetRemoved('first');
  assert.equal(run.ai.snapshot().targetId,undefined);assert.equal(run.waypoint(),undefined);assert.equal(run.clears(),0);assert.equal(run.scores.get('first'),10);
  run.ai.update(60);assert.equal(run.ai.snapshot().targetId,'second');run.ai.targetRemoved('first','inactive');assert.equal(run.clears(),0);
  run.ai.targetRemoved('second','inactive');assert.equal(run.clears(),1);assert.equal(run.scores.size,0);
});

test('contact uses existing threat and does not replace the target or invent a ledger entry',()=>{
  const run=setup([],'passive');run.ai.onContact({casterId:'first',targetId:'enemy'});run.ai.update(60);
  assert.equal(run.ai.snapshot().targetId,undefined);assert.equal(run.scores.size,0);
  run.scores.set('first',10);run.scores.set('second',20);run.ai.onContact({casterId:'first',targetId:'enemy'});
  assert.equal(run.ai.snapshot().targetId,undefined);run.ai.update(60);assert.equal(run.ai.snapshot().targetId,'second');
  run.ai.onContact({casterId:'first',targetId:'enemy'});assert.equal(run.ai.snapshot().targetId,'second');
});

test('tracked combat keeps a target outside sight and disable preserves its ledger',()=>{
  const run=setup();run.first.position.x=400;run.scores.set('first',10);run.ai.update(60);
  assert.equal(run.ai.snapshot().targetId,'first');assert.equal(run.ai.snapshot().state,'chasing');
  run.ai.disable();assert.equal(run.clears(),0);assert.equal(run.scores.get('first'),10);
  run.ai.update(60);assert.equal(run.ai.snapshot().targetId,'first');
});

test('a failed action clears owner threat and new threat interrupts return only at the next decision',()=>{
  const run=setup([skill]);run.actor.position={x:80,y:32};run.scores.set('first',10);run.affordable(false);run.ai.update(60);
  assert.equal(run.ai.snapshot().state,'returning');assert.equal(run.clears(),1);run.ai.update(60);const oldWaypoint=run.waypoint();
  run.affordable(true);run.scores.set('second',10);run.ai.onThreatAdded();
  assert.equal(run.ai.snapshot().state,'returning');assert.deepEqual(run.waypoint(),oldWaypoint);
  run.ai.update(60);assert.equal(run.ai.snapshot().targetId,'second');assert.notEqual(run.ai.snapshot().state,'returning');
});

test('an expired approach clears the old current target so the next decision cannot revive it',()=>{
  const run=setup([skill],'passive');run.scores.set('first',10);run.ai.update(60);
  run.scores.clear();run.actor.position={x:80,y:32};run.ai.update(60);
  assert.equal(run.ai.snapshot().targetId,undefined);assert.equal(run.ai.combatController!.snapshot().state,'idle');
  run.ai.update(120);assert.equal(run.plays.length,0);assert.equal(run.spends(),0);
});

test('an unengaged enemy still wanders, whereas losing all visible combat candidates clears threat on its next decision',()=>{
  const idle=setup([],'passive',{wander:{idleDurationMs:60}});idle.ai.update(60);
  assert.equal(idle.ai.snapshot().state,'wandering');assert.equal(idle.clears(),0);
  const run=setup();run.scores.set('first',10);run.ai.update(60);
  // 现在同一决策点会 notice 视距内所有候选；把两个候选都藏起来，才走「无可见目标就清账回家」。
  run.first.states=['stealthed'];run.second.states=['stealthed'];run.ai.targetRemoved('first');
  assert.equal(run.scores.size,2);assert.equal(run.clears(),0);
  run.ai.update(60);assert.equal(run.ai.snapshot().state,'returning');assert.equal(run.scores.size,0);assert.equal(run.clears(),1);
});

test('fixed and zero-speed enemies leave distant actions idle and reconsider targets without clearing threat',()=>{
  for(const overrides of [{canMove:false},{moveSpeedPxPerSecond:0}]){
    const run=setup([skill],'active',overrides);run.scores.set('first',10);run.ai.update(60);
    assert.equal(run.ai.combatController!.snapshot().state,'idle');assert.equal(run.ai.snapshot().state,'idle');
    assert.equal(run.ai.snapshot().targetId,'first');assert.equal(run.waypoint(),undefined);assert.equal(run.clears(),0);
    run.second.position.x=32;run.scores.set('second',100);run.ai.onThreatAdded();run.ai.update(60);
    assert.equal(run.plays[0].target?.id,'second');assert.equal(run.spends(),1);
  }
});

test('an unreachable tracked approach fails before resources are spent and clears owner threat',()=>{
  const run=setup([skill]);run.port.navigationBounds=()=>({x:0,y:0,width:24,height:48});
  run.scores.set('first',10);run.ai.update(60);
  assert.equal(run.ai.combatController!.snapshot().state,'idle');assert.equal(run.ai.snapshot().state,'returning');
  assert.equal(run.spends(),0);assert.equal(run.plays.length,0);assert.equal(run.clears(),1);assert.equal(run.scores.size,0);
});

test('fixed actors still fail and clear owner threat when the chosen action has no reachable position',()=>{
  const run=setup([skill],'active',{canMove:false});run.port.navigationBounds=()=>({x:0,y:0,width:24,height:48});
  run.scores.set('first',10);run.ai.update(60);
  assert.equal(run.ai.snapshot().state,'returning');assert.equal(run.clears(),1);assert.equal(run.scores.size,0);
  assert.equal(run.plays.length,0);assert.equal(run.spends(),0);assert.equal(run.waypoint(),undefined);
});

test('fixed actors take the last ready skill, so a self spell wins over a distant targeted one',()=>{
  const self:EnemyPlayableSkill={...skill,id:'self',action:{...skill.action,requiresTarget:false}};
  const run=setup([skill,self],'active',{canMove:false});run.scores.set('first',10);run.ai.update(60);
  assert.equal(run.plays.length,1,'自释放技能不做距离检查，遍历取最后一个时直接释放');
  assert.equal(run.plays[0].skill?.id,'self');
  assert.equal(run.clears(),0);
});

test('immobilization keeps a reachable action idle while ambush rejects the distant action and clears threat',()=>{
  const rooted=setup([skill]);rooted.actor.states=['immobilized'];rooted.scores.set('first',10);rooted.ai.update(60);
  assert.equal(rooted.ai.snapshot().state,'idle');assert.equal(rooted.clears(),0);assert.equal(rooted.scores.get('first'),10);
  const ambush=setup([skill]);ambush.actor.states=['ambush'];ambush.scores.set('first',10);ambush.ai.update(60);
  assert.equal(ambush.ai.snapshot().state,'returning');assert.equal(ambush.clears(),1);assert.equal(ambush.plays.length,0);
});

test('a reaction changes the current target used by the next decision without replacing the running action target',()=>{
  const run=setup();run.first.position.x=32;run.scores.set('first',20);run.scores.set('second',10);run.ai.update(60);
  assert.equal(run.plays[0].target?.id,'first');const selections=run.selections();
  run.ai.combatController!.setReactionTarget('second');run.ai.update(60);
  assert.equal(run.plays[0].target?.id,'first');assert.equal(run.selections(),selections);
  run.finish();run.ai.update(60);assert.equal(run.selectedFrom.at(-1),'second');
});

test('an inactive reaction-selected current target clears the owner even while the old action is playing',()=>{
  const run=setup();run.first.position.x=32;run.scores.set('first',20);run.scores.set('second',10);run.ai.update(60);
  run.ai.combatController!.setReactionTarget('second');run.actors.splice(run.actors.indexOf(run.second),1);run.ai.update(60);
  assert.equal(run.clears(),1);assert.equal(run.scores.size,0);
});
