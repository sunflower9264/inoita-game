import assert from 'node:assert/strict';
import test from 'node:test';
import type {CombatThreatSystem} from '../src/domain/combat-threat-system.ts';
import type {Combatant} from '../src/domain/combatant.ts';
import {disturbanceCandidate,type DisturbanceActor} from '../src/domain/disturbance.ts';
import {rectDistance} from '../src/domain/rect-distance.ts';
import {createCombatTestHarness,createTestMember,loadBattleCatalog} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const thresholds=[140,200,260,320,350,380,410,440];

test('eight ranks carry the defending side threshold and no passive modifier',()=>{
  const skill=catalog.skills['disturbance'];
  assert.deepEqual(skill.passiveUnits,[]);
  skill.reactionsByRank!.forEach((rank,index)=>
    assert.deepEqual(rank,[{kind:'disturbance',chanceThreshold:thresholds[index]}],`rank ${index+1}`));
});

const rect=(width=16,height=16)=>({x:-width/2,y:-height/2,width,height});
const actor=(id:string,x:number,defense:number,extra:Partial<DisturbanceActor>={}):DisturbanceActor=>
  ({id,sameCamp:true,ownSummon:false,position:{x,y:0},bounds:rect(),effectiveDefense:defense,...extra});
const self=actor('self',0,200);

test('the rectangular distance is the two axes floor-divided by eight and then added',()=>{
  // 两个 16 宽的对象：间隙 62 像素是 7 格，加 2 仍在 64 格以内。
  assert.equal(rectDistance(self,actor('far',78,900)),7);
  assert.equal(disturbanceCandidate(self,[actor('far',78,900)]),'far');
  // 间隙 503 像素是 62 格，加 2 正好 64；504 像素是 63 格，加 2 越界。
  const edge:DisturbanceActor={...actor('edge',519,900),position:{x:519,y:0}};
  assert.equal(rectDistance(self,edge),62);
  assert.equal(disturbanceCandidate(self,[edge]),'edge');
  const over:DisturbanceActor={...actor('over',520,900),position:{x:520,y:0}};
  assert.equal(rectDistance(self,over),63);
  assert.equal(disturbanceCandidate(self,[over]),undefined);
  // 纵向同样按格算。
  const above:DisturbanceActor={...actor('above',0,900),position:{x:0,y:519}};
  assert.equal(rectDistance(self,above),62);
  const corner:DisturbanceActor={...actor('corner',8,900),position:{x:8,y:8}};
  assert.equal(rectDistance(self,corner),0,'两个轴都重叠就是 0');
});

test('the highest effective defense wins regardless of distance, and ties keep the first',()=>{
  const near=actor('near',40,250),far=actor('far',70,400);
  assert.equal(disturbanceCandidate(self,[near,far]),'far','更远但更扛打的赢');
  const first=actor('first',30,400),second=actor('second',40,400);
  assert.equal(disturbanceCandidate(self,[first,second]),'first','相等保留先遇到的');
  assert.equal(disturbanceCandidate(self,[actor('weaker',30,150)]),undefined,'不比自己高就不算');
  assert.equal(disturbanceCandidate(self,[actor('equal',30,200)]),undefined,'相等不算严格更高');
  assert.equal(disturbanceCandidate(self,[]),undefined,'没有候选就不改变');
});

test('the defender own summon wins immediately, anyone else summon does not',()=>{
  const own=actor('own-summon',40,100,{ownSummon:true});
  const stronger=actor('stronger',50,900);
  assert.equal(disturbanceCandidate(self,[stronger,own]),'own-summon','自己拥有的召唤物立刻选中');
  const foreign=actor('foreign-summon',40,100);
  assert.equal(disturbanceCandidate(self,[foreign,stronger]),'stronger','别人的召唤物没有优先');
  // 自己与敌对阵营都不进候选。
  assert.equal(disturbanceCandidate(self,[actor('self',10,900)]),undefined);
  assert.equal(disturbanceCandidate(self,[actor('enemy',10,900,{sameCamp:false})]),undefined);
});

/** 场景侧读取：候选与守卫都用当前防御×防御率，不再只看面板基础防御。 */
test('世界侧按当前防御与防御率选候选，装备与增益都算进去',()=>{
  const nextThresholds=catalog.skills['disturbance'].reactionsByRank!.map(rank=>{
    const reaction=rank[0]!;
    return reaction.kind==='disturbance'?reaction.chanceThreshold:0;
  });
  const defenses:Record<string,{defense:number;rate:number}>={guard:{defense:100,rate:0},plate:{defense:60,rate:900},ally:{defense:100,rate:0}};
  const makeMember=(id:string)=>createTestMember({id,classId:'ranger',panel:{baseDefense:100},skillLevels:{disturbance:8}});
  const members=new Map([['guard',makeMember('guard')],['plate',makeMember('plate')],['ally',makeMember('ally')]]);
  const memberActor=(id:string,x:number,team:'party'|'hostile'='party'):Combatant=>({id,team,position:{x,y:0},bounds:{x:-4,y:-4,width:8,height:8}});
  const roster=[memberActor('guard',0),memberActor('plate',40),memberActor('ally',48),memberActor('enemy',200,'hostile')];
  const taunts:{candidate:string;attacker:string}[]=[];
  const harness=createCombatTestHarness({
    battleCatalog:catalog,members,
    combatant:id=>roster.find(entry=>entry.id===id),
    combatants:()=>roster,
    withThreat:false,
    settlementOverrides:{
      threat:{taunt:(candidate:string,attacker:string)=>taunts.push({candidate,attacker})} as unknown as CombatThreatSystem,
      currentTargetOf:()=>undefined,
    },
  });
  harness.stats.actorAttribute=(id,key)=>key==='defense'?(defenses[id]?.defense??0):key==='defenseRate'?(defenses[id]?.rate??0):0;
  const original=Math.random;Math.random=()=>0.5/999;
  try{
    harness.settlement.disturbanceReaction('enemy','guard');
  }finally{Math.random=original;}
  assert.equal(nextThresholds.length,8);
  assert.deepEqual(taunts,[{candidate:'plate',attacker:'enemy'}],'护甲 60×1.9 高于守卫的 100，护甲被选中');
});
