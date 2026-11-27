import assert from 'node:assert/strict';
import test from 'node:test';
import {combatFollowUp} from '../src/domain/combat-follow-ups.ts';
import {CombatRuntime} from '../src/domain/combat-runtime.ts';
import type {Combatant} from '../src/domain/combatant.ts';
import {
  createCombatTestHarness,
  createTestMember,
  loadBattleCatalog,
  ZERO_PRIMARY_ATTRIBUTES,
} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const thresholds=[170,230,270,290,310,330,350,370];

test('eight ranks carry the trigger chance and no fallback action is exported',()=>{
  catalog.skills['god-of-justice'].reactionsByRank!.forEach((rank,index)=>
    assert.deepEqual(rank,[{kind:'god-of-justice',chanceThreshold:thresholds[index]}],`rank ${index+1}`));
  assert.deepEqual(catalog.skills['god-of-justice'].passiveUnits,[]);
  // 私有动作 188 的动作行 +8 是 0xff：ACTTRANSSYSTEM_Make 直接返回，既无过渡也无 Direct，
  // 所以未学天之怒雷时没有可执行的追加动作，内容里也不该再留这份导出。
  assert.equal(catalog.skills['god-of-justice'].followUpAction,undefined);
});

/** 只装配判定要用到的部分：已学等级、施法者与敌人、被替换的单元执行和定时器。 */
function fixture(level=1,{celestial}:{celestial?:number}={}){
  const levels:Record<string,number>={'god-of-justice':level};
  if(celestial!==undefined)levels['celestial-lightning']=celestial;
  const member=createTestMember({
    id:'player',classId:'priest',skillLevels:levels,
    panel:{attributes:{...ZERO_PRIMARY_ATTRIBUTES}},
  });
  const casts:{cueIndex:number;targetId:string;id:string;level:number}[]=[];
  const castRows=()=>casts.map(cast=>[cast.cueIndex,cast.targetId,cast.id,cast.level] as const);
  const strikes:{casterId:string;count:number}[]=[];
  const timers:{ms:number;callback:()=>void}[]=[];
  const actor=(id:string,x:number):Combatant=>({id,team:id==='player'?'party':'hostile',position:{x,y:0},bounds:{x:-4,y:-4,width:8,height:8}});
  let roster=[actor('player',0),actor('enemy',64)];
  const runtime=new CombatRuntime(()=>0);
  runtime.schedule=(_owner,frames,callback)=>{timers.push({ms:frames*60,callback});return ()=>{};};
  const harness=createCombatTestHarness({
    battleCatalog:catalog,hero:member,members:new Map([['player',member]]),
    activeParty:()=>['player'],
    combatant:id=>roster.find(entry=>entry.id===id),
    combatants:()=>roster,
    withThreat:false,
    settlementOverrides:{
      followUp:(kind,casterId,targetId)=>{
        combatFollowUp(kind,casterId,targetId,{
          catalog,
          runtime,
          loadout:id=>{
            const current=harness.stats.reactionSkills(id);
            return current?{classId:current.classId,skills:current.loadout}:undefined;
          },
          random:()=>Math.random(),
          active:()=>true,
          actor:id=>roster.find(entry=>entry.id===id),
          casterStrikes:(casterId,strikes0)=>strikes.push({casterId,count:strikes0.offsets.length}),
          flight:{actor:id=>roster.find(entry=>entry.id===id),emit:()=>{},effect:()=>{}},
          execute:(owner,target,skillId,skillLevel,action,origin)=>
            harness.settlement.runSkillUnitSequence({casterId:owner,skillId,level:skillLevel,action,origin,selectedTargetId:target}),
        });
      },
    },
  });
  harness.stats.actorAttribute=()=>0;
  harness.settlement.skillUnit=event=>{
    casts.push({cueIndex:event.cueIndex,targetId:event.targetId,id:event.skill.id,level:event.skill.level??1});
    return 'success';
  };
  const fire=(casterId='player')=>harness.settlement.godOfJusticeReaction(casterId,'enemy');
  const runTimers=()=>{const pending=[...timers];timers.length=0;for(const timer of pending)timer.callback();};
  const removeEnemy=()=>{roster=roster.filter(entry=>entry.id!=='enemy');};
  return {harness,fire,casts,castRows,strikes,timers,runTimers,removeEnemy};
}

/** 让判定抽到第 n 点（1…999）：原版掷整数 1…999，严格小于阈值才触发。 */
const roll=(point:number)=>()=>(point-0.5)/999;

test('the threshold gates the roll for every rank',()=>{
  const original=Math.random;
  try{
    for(const [index,threshold] of thresholds.entries()){
      const run=fixture(index+1,{celestial:1});
      Math.random=roll(threshold);
      run.fire();assert.equal(run.strikes.length,0,`${index+1} 级阈值 ${threshold}：抽到它本身不触发`);
      Math.random=roll(threshold-1);
      run.fire();assert.equal(run.strikes.length,1,`${index+1} 级差一点就触发`);
    }
  }finally{Math.random=original;}
});

test('an unlearned Celestial Lightning produces nothing, not even the private action',()=>{
  const original=Math.random;
  try{
    const unlearned=fixture(8);
    Math.random=roll(1);
    unlearned.fire();
    assert.deepEqual(unlearned.casts,[]);assert.deepEqual(unlearned.strikes,[]);assert.deepEqual(unlearned.timers,[]);
    const unranked=fixture(0,{celestial:5});
    unranked.fire();assert.deepEqual(unranked.casts,[],'没学被动就没有这一抽');
  }finally{Math.random=original;}
});

test('a learned Celestial Lightning strikes around the caster and settles on the enemy at the switch frame',()=>{
  const original=Math.random;
  try{
    const run=fixture(1,{celestial:5});
    Math.random=roll(1);
    run.fire();
    assert.deepEqual(run.strikes,[{casterId:'player',count:12}],'十二道雷击画在施法者周围');
    assert.equal(run.casts.length,0,'切换帧之前不结算');
    assert.deepEqual(run.timers.map(timer=>timer.ms),[8*60],'过渡第 8 帧执行 Direct');
    run.runTimers();
    assert.deepEqual(run.castRows(),
      [[0,'player','celestial-lightning',5],[1,'enemy','celestial-lightning',5],[2,'player','celestial-lightning',5]],
      '自身单元落在施法者，伤害中心留在原敌人；等级取已学等级');
  }finally{Math.random=original;}
});

test('a departed target keeps the caster units on the caster only',()=>{
  const original=Math.random;
  try{
    const run=fixture(1,{celestial:1});
    run.removeEnemy();
    Math.random=roll(1);
    run.fire();
    run.runTimers();
    assert.deepEqual(run.castRows().map(row=>row[1]),['player','player'],'敌人已离场时只剩自身两个单元');
  }finally{Math.random=original;}
});

test('only a critical from Divine Strike or Hammer of Wrath reaches the roll',()=>{
  const seen:string[]=[];
  const harness=createCombatTestHarness({battleCatalog:catalog,withThreat:false});
  harness.settlement.godOfJusticeReaction=(caster,target)=>seen.push(`${caster}:${target}`);
  harness.settlement.physicalSuccessEquipmentProcs=()=>{};
  harness.settlement.lightningOfHellReaction=()=>{};
  harness.settlement.holySacrificeTransfer=()=>{};
  harness.settlement.reactToBuff=()=>{};
  harness.settlement.react=()=>{};
  harness.settlement.summonOwnerReactions=()=>{};
  harness.settlement.disturbanceReaction=()=>{};
  harness.settlement.attackProc=()=>{};
  const cases=[['divine-strike','critical',1],['hammer-of-wrath','critical',1],['divine-strike','hit',0],
    ['firestorm','critical',0],['basic-attack','critical',0]] as const;
  for(const [actionId,kind,expected] of cases){
    seen.length=0;
    harness.settlement.resolveHitReactions({casterId:'priest',targetId:'enemy'},{kind,damage:10},'physical',actionId);
    assert.equal(seen.length,expected,`${actionId}/${kind}`);
  }
});

test('the passive keeps no castable action of its own',()=>{
  assert.equal(catalog.skills['god-of-justice'].action,null,'被动的主动作只有反应，没有单元');
});
