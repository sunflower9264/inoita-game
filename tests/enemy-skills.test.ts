import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { EnemyBehavior, EnemyPlayableSkill, ResolvedBasicAttack } from '../src/domain/battle.ts';
import type { ActionPlayback, Combatant } from '../src/domain/combat.ts';
import { EnemyController } from '../src/domain/enemy-ai.ts';
import { skillPlaybackEvents } from '../src/domain/skill-action.ts';
import type { EnemyPort } from '../src/domain/enemy-ai.ts';

const clips={north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'} as const;
const basic:ResolvedBasicAttack={frameDurationMs:60,cycleFrames:4,effectiveCycleFrames:4,
  damage:{effect:'physical',source:'bestNormalDamage',attributeWeights:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},ranks:[{fixedAddition:0,operation:{kind:'add',amount:0}}]},
  approachDistanceUnits:2,searchRadiusPx:100,strikeFrame:1,swingFrame:null,swings:[],impacts:[],projectile:null,
  clips,sequence:{north:[0,1,2,3],south:[0,1,2,3],east:[0,1,2,3],west:[0,1,2,3]}};
function skill(id:string,range=6,requiresTarget=true):EnemyPlayableSkill {
  return {id,name:id,clips,action:{requiresTarget,cooldownFrames:10,approachDistanceUnits:range,searchRadiusPx:100,transition:null,
    events:[{kind:'units',frame:1,cues:[]}]}};
}
function setup(skills:EnemyPlayableSkill[],attack:ResolvedBasicAttack|null=basic,random=()=>0,time={frame:0},id='enemy',cooldowns=new CombatCooldownStore(()=>time.frame)){
  const caster:Combatant={id,team:'enemy',position:{x:16,y:32},bounds:{x:-8,y:-8,width:16,height:16}};
  const target:Combatant={...caster,id:'player',team:'player',position:{x:32,y:32}};
  const plays:ActionPlayback[]=[];
  let finish=()=>{},move:{x:number;y:number}|undefined,clears=0;
  const behavior:EnemyBehavior={aggression:'active',awarenessRangeUnits:16,canMove:true,canTurn:true,moveSpeedPxPerSecond:100};
  const port:EnemyPort={cooldowns:cooldowns.forActor(caster.id),actor:id=>id===caster.id?caster:id===target.id?target:undefined,candidates:()=>[caster,target],facing:()=> 'south',
    home:()=>({x:16,y:32}),navigationBounds:()=>({x:0,y:0,width:192,height:96}),
    moveToward:point=>{move=point;},followPath:next=>{move=next();},stop:()=>{move=undefined;},canStand:point=>Math.abs(point.x-target.position.x)>=16||Math.abs(point.y-target.position.y)>=16,
    relocate:point=>{caster.position=point;},play:(action,_frame,complete)=>{plays.push(action);finish=complete;return ()=>{};},frame:()=>{},clearEffects:()=>{clears++;}};
  const ai=new EnemyController(caster.id,behavior,attack,port,skills,random);
  return {ai,caster,target,behavior,port,plays,time,cooldowns,advance:(frames=1)=>{for(let i=0;i<frames;i++){time.frame++;ai.step();}},finish:()=>finish(),move:()=>move,clears:()=>clears};
}

test('selection takes the last ready binding and completes the selected action before choosing again',()=>{
  const run=setup([skill('first'),skill('second')],basic);
  run.ai.update(60);assert.equal(run.plays[0].skill?.id,'second');
  run.ai.update(120);assert.equal(run.plays.length,1);
  run.finish();run.ai.update(60);assert.equal(run.plays[1].skill?.id,'first');
  run.finish();run.ai.update(60);assert.equal(run.plays[2].skill,undefined,'both skills cooling down falls back to basic attack');
  const other=setup([skill('second')]);other.ai.update(60);
  assert.equal(other.plays[0].skill?.id,'second','another monster has its own cooldown');
});

test('native release conditions gate skills on the caster health threshold',()=>{
  let health={current:100,maximum:100};
  const run=setup([{...skill('high'),releaseCondition:'hp-below-95'},{...skill('low'),releaseCondition:'hp-below-30'}]);
  run.port.health=()=>health;
  run.ai.update(60);
  assert.equal(run.plays[0].skill,undefined,'满血不满足任何阈值，回落普攻');
  run.finish();health={current:90,maximum:100};run.ai.update(60);
  assert.equal(run.plays[1].skill?.id,'high','90% 只满足 95% 档');
  run.finish();health={current:25,maximum:100};run.ai.update(60);
  assert.equal(run.plays[2].skill?.id,'low','25% 两档都满足，取列表最后一个');
});

test('a once-only skill drops out of the candidate list after it is cast',()=>{
  const run=setup([{...skill('once-only'),once:true}],basic);
  run.ai.update(60);assert.equal(run.plays[0].skill?.id,'once-only');
  run.finish();run.advance(12);
  assert.equal(run.plays.filter(play=>play.skill?.id==='once-only').length,1,'一次性技能冷却结束后不再入选');
});

test('a commanded summon action starts only when ordered and keeps its own cooldown',()=>{
  const run=setup([]),command=skill('hell-scream');
  assert.equal(run.ai.command(command,'player',3),true);
  assert.equal(run.plays[0].skill?.id,'hell-scream');
  assert.equal(run.ai.snapshot().state,'attacking');
  assert.equal(run.plays[0].skill?.level,3);
  assert.equal(run.ai.command(command,'player',3),false,'a running action is not restarted');
  run.finish();
  assert.equal(run.ai.snapshot().cooldowns['hell-scream'].remainingMs,600);
  assert.equal(run.ai.command(command,'player',3),false,'the commanded action obeys cooldown');
});

test('single-step AI reads the same shared frame and sees expired cooldowns before selection',()=>{
  const time={frame:100},store=new CombatCooldownStore(()=>time.frame),spell=skill('shared-spell');
  spell.action.cooldownFrames=2;
  const first=setup([spell],null,()=>0,time,'first',store),second=setup([spell],null,()=>0,time,'second',store);
  first.ai.step();second.ai.step();
  assert.equal(time.frame,100,'neither actor advances the shared clock');
  assert.deepEqual(first.ai.snapshot().cooldowns,second.ai.snapshot().cooldowns);
  assert.deepEqual(first.ai.snapshot().cooldowns[spell.id],{remainingMs:120,durationMs:120});
  first.finish();second.finish();time.frame=101;
  second.ai.step();first.ai.step();
  assert.equal(first.plays.length,1);assert.equal(second.plays.length,1);
  time.frame=102;
  assert.deepEqual(first.ai.snapshot().cooldowns,{},'deadline expiry needs no controller update');
  second.ai.step();first.ai.step();
  assert.equal(first.plays.length,2);assert.equal(second.plays.length,2);
  assert.deepEqual(first.ai.snapshot().cooldowns,second.ai.snapshot().cooldowns);
  first.ai.dispose();time.frame=104;first.ai.step();assert.equal(first.plays.length,2);
});

test('hell soldier command has its own four-way animation and eight ranked combat outcomes',()=>{
  const catalog=JSON.parse(fs.readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8'));
  const soldier=catalog.enemies.find((enemy:{id:string})=>enemy.id==='enemy-hell-s-pawn-1');
  const command=soldier.commandAction;
  assert.equal(command.id,'monster-hell-scream');
  assert.deepEqual(command.action.combatUnits.map((unit:{effect:string})=>unit.effect),['magic','state','taunt']);
  // 私有动作 110 自身 max_level=0，恒读 pointBase-1；主角 b=13、伙伴 b=12。
  assert.deepEqual(command.companionAction.combatUnits[0].ranks.map((rank:{operation:{ratePerThousand:number}})=>rank.operation.ratePerThousand),Array(8).fill(1920));
  assert.deepEqual(command.action.combatUnits[0].ranks.map((rank:{operation:{ratePerThousand:number}})=>rank.operation.ratePerThousand),Array(8).fill(1980));
  assert.deepEqual(command.action.combatUnits[1].ranks[0],{chanceThreshold:1000,durationMs:3660,
    stateDurationProfile:{normal:{lastActiveFrame:60},targetShortened:{lastActiveFrame:30}}});
  for(const clip of Object.values(command.clips) as string[])assert.equal(soldier.actor.clips[clip].frames,17);
  assert.equal((soldier.skills??[]).some((skill:{id:string})=>skill.id===command.id),false,'the command is not selected by autonomous AI');
});

test('skill-only monsters cast without a fabricated basic attack, and retain cooldown across cancellation',()=>{
  const run=setup([skill('thunder')],null);run.ai.update(60);
  assert.equal(run.plays[0].basicAttack,null);assert.equal(run.plays[0].skill?.id,'thunder');
  run.ai.cancel();assert.equal(run.clears(),1);assert.equal(run.ai.snapshot().cooldowns.thunder.remainingMs,600);
  run.advance();assert.equal(run.plays.length,1);assert.equal(run.move(),undefined);
  run.advance(9);assert.equal(run.plays.length,2);
});

test('A* approaches the usable skill range and does not consume cooldown before reaching it',()=>{
  const run=setup([skill('short',3),skill('long',6)],null);
  run.target.position.x=120;run.ai.update(60);
  assert.equal(run.plays.length,0);assert.ok(run.move());assert.deepEqual(run.ai.snapshot().cooldowns,{});
  for(let i=0;i<30&&!run.plays.length;i++){
    const point=run.move();if(point)run.caster.position={...point};run.ai.update(60);
  }
  assert.equal(run.plays[0].skill?.id,'long');
  assert.ok(run.caster.position.x<run.target.position.x-16,'does not walk to the occupied target center');
});

test('fixed monsters respect skill distance; self skills still require combat activation',()=>{
  const run=setup([skill('short',2)],null);run.behavior.canMove=false;run.behavior.canTurn=false;
  run.target.position.x=96;run.ai.update(60);assert.equal(run.plays.length,0);assert.equal(run.move(),undefined);
  run.target.position.x=32;run.ai.update(60);assert.equal(run.plays[0].facing,'south');
  const self=setup([skill('buff',0,false)],null);self.behavior.aggression='passive';
  self.ai.update(600);assert.equal(self.plays.length,0);
  self.ai.onContact({casterId:'player',targetId:'enemy'});self.ai.update(60);
  assert.equal(self.plays[0].skill?.id,'buff');assert.equal(self.plays[0].target,undefined);
});

test('a skill finishes before returning home, then its lingering visuals are cleared',()=>{
  const run=setup([skill('storm')]);run.ai.update(60);
  run.target.position.x=1000;run.ai.update(60);assert.equal(run.ai.snapshot().state,'attacking');
  run.finish();run.ai.update(60);assert.equal(run.ai.snapshot().state,'returning');assert.equal(run.clears(),1);
  run.ai.update(60);assert.equal(run.ai.snapshot().state,'idle');assert.equal(run.plays.length,1);
});

test('continuous effects emit on every logical frame in their interval',()=>{
  const action=skill('thunder').action;
  action.events=[{kind:'spawn',frame:2,until:6,effect:'lightning',placement:'above-characters',marginPx:16}];
  assert.deepEqual(Array.from({length:8},(_,frame)=>skillPlaybackEvents(action,frame).length),[0,0,1,1,1,1,0,0]);
});

test('capture events retain cast positions when the player moves and isolate each caster',async()=>{
  const {CombatController}=await import('../src/domain/combat.ts');
  const first=setup([]),second=setup([]);
  const action=skill('meteor',20).action;
  action.events=[{kind:'capture-targets',frame:0,target:'area',targetRangePx:100,limit:8},
    {kind:'captured-effect',frame:10,effect:'warning',placement:'ground'},{kind:'units',frame:40,cues:[]}];
  for(const run of [first,second]){
    const combat=new CombatController('enemy',null,run.port);
    assert.equal(combat.request({id:'meteor',action}),'started');
  }
  const original={...first.target.position};first.target.position.x+=50;
  assert.deepEqual(first.plays[0].capturedTargets,[{id:'player',position:original}]);
  assert.notEqual(first.plays[0].capturedTargets,second.plays[0].capturedTargets);
});

test('fixed-position flight terminates at its captured position even with a distant caster',async()=>{
  const {positionTransitionStep}=await import('../src/domain/skill-geometry.ts');
  const target={x:1000,y:1000};let position={x:0,y:0};let arrived=false;
  for(let steps=0;steps<=10;steps++){
    const next=positionTransitionStep(position,target,64,steps,10);position=next.position;arrived=next.arrived;
    if(steps<10)assert.equal(arrived,false);
  }
  assert.equal(arrived,true);assert.deepEqual(position,target);
  assert.deepEqual(positionTransitionStep({x:990,y:1000},target,64,0,10),{position:target,arrived:true});
});

test('summon search uses the caster boundary and tests other directions before falling back',async()=>{
  const {planSummonSpot}=await import('../src/domain/skill-geometry.ts');
  const position={x:200,y:200},box={x:-8,y:-16,width:16,height:16};
  const placement={searchGapPx:32,searchExtentPx:48,offsetChoices:[{x:0,y:0}],jitterPx:0};
  const seen:{x:number;y:number}[]=[];
  const found=planSummonSpot(position,box,'south',placement,p=>{seen.push(p);return p.x===160;});
  assert.deepEqual(seen[0],{x:152,y:232});assert.deepEqual(found,{x:160,y:232});
  const west=planSummonSpot(position,box,'south',placement,p=>p.x<152);
  assert.equal(west?.x,144);
});

test('落点搜不到就返回 undefined：不再拿主人坐标冒充落点',async()=>{
  const {planSummonSpot}=await import('../src/domain/skill-geometry.ts');
  const position={x:200,y:200},box={x:-8,y:-16,width:16,height:16};
  const placement={searchGapPx:32,searchExtentPx:48,offsetChoices:[{x:0,y:0}],jitterPx:0};
  assert.equal(planSummonSpot(position,box,'south',placement,()=>false),undefined);
});

test('召唤落点：近处搜索优先，兜底必须可达，整张地图都没有可达点就不出生',async()=>{
  const {CombatActionDispatcher}=await import('../src/domain/combat-action-dispatcher.ts');
  const {CombatRuntime}=await import('../src/domain/combat-runtime.ts');
  const battle=JSON.parse(fs.readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8'));
  const summoner=battle.enemies.find((enemy:{id:string})=>enemy.id==='enemy-dragon-alexander-1');
  const skill=summoner?.skills.find((entry:{id:string})=>entry.id==='monster-summon-bats');
  assert.ok(summoner&&skill,'原版「召唤蝙蝠」技能与施法者仍在战斗数据里');
  const run=(canSummonAt:()=>boolean,fallback:{x:number;y:number}|undefined)=>{
    const placed:{enemyId:string;position:{x:number;y:number}}[]=[];
    const caster:Combatant={id:'boss',team:'hostile',position:{x:200,y:200},bounds:summoner.actor.collision};
    const action:ActionPlayback={caster,facing:'south',skill:{id:skill.id,action:skill.action},basicAttack:null};
    let frame=0;const runtime=new CombatRuntime(()=>frame);
    const dispatcher=new CombatActionDispatcher({runtime,catalog:battle,actor:(id:string)=>id===caster.id?caster:undefined,candidates:()=>[],
      random:()=>0,viewport:()=>({width:800,height:480}),pose:()=>{},effect:()=>{},flight:()=>{},screen:()=>{},notify:()=>{},
      canSummonAt,nearestSummonSpot:(_position,_bounds,preferred)=>preferred??fallback,beginSummons:()=>{},
      summon:(_owner:string,enemyId:string,position:{x:number;y:number})=>{placed.push({enemyId,position});return 'summon';}});
    dispatcher.frame(action,5);
    return placed.map(entry=>entry.position);
  };
  // 随机数固定为 0 时取第一个位移 -48 与抖动 -10；搜索带给出的基准点是 {x:152,y:240}。
  assert.deepEqual(run(()=>true,{x:42,y:24}),[{x:94,y:230},{x:94,y:230}],'近处搜得到就优先用它');
  // preferred 不可用时的兜底点原样落地，不再套用位移与抖动。两只重合只是这里桩的返回值固定，
  // 真实端口按整盒判定避开已落位实体。
  assert.deepEqual(run(()=>false,{x:42,y:24}),[{x:42,y:24},{x:42,y:24}],'兜底点原样落地');
  assert.deepEqual(run(()=>false,undefined),[],'整张地图都没有落点就不出生');
});
