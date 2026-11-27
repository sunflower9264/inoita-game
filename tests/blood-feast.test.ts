import assert from 'node:assert/strict';
import test from 'node:test';
import type {CombatActorAttributes} from '../src/domain/combat-damage-source.ts';
import {createCombatTestHarness,createTestMember,loadBattleCatalog} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const passive=catalog.skills['blood-feast'].passiveUnits![0] as {attribute:string;ranks:{kind:string;amount:number}[]};
const curseUnit=catalog.skills['blood-curse'].action!.combatUnits!.find(unit=>unit.effect==='buff')!;
if(curseUnit.effect!=='buff')throw new Error('missing blood curse buff');
const rates=[350,450,550,650,700,750,800,850];
const curseRates=[230,250,270,300,310,320,330,340];
const sourceAttributes=(magicAttack:number,intelligence=0,mentality=0):CombatActorAttributes=>({physicalAttack:0,
  magicAttack,maxHealth:1000,physicalDamageRate:0,magicDamageRate:9999,stealthDamageRate:0,
  primaryAttributes:{strength:0,dexterity:0,vitality:0,intelligence,mentality}});

test('eight ranks carry the life feast rate and the curse pulse names its own heal effect',()=>{
  assert.equal(passive.attribute,'lifeFeastRate');
  assert.deepEqual(passive.ranks,rates.map(amount=>({kind:'add',amount})));
  curseUnit.ranks.forEach((rank,index)=>{
    const tick=rank.effect.periodic.find(tick=>tick.kind==='magic-curse');
    assert.equal(tick?.kind==='magic-curse'&&tick.ratePerThousand,curseRates[index],`rank ${index+1}`);
    assert.equal(tick?.kind==='magic-curse'&&tick.healEffect,'life-drain',`rank ${index+1}`);
  });
});

function fixture(feastRate:number,attributes:CombatActorAttributes=sourceAttributes(100)){
  const commands:unknown[][]=[];
  const members=new Map(['source','ally','third','extra'].map(id=>[id,createTestMember({id,classId:'warlock',health:500,maxHealth:1000})]));
  const harness=createCombatTestHarness({
    battleCatalog:catalog,members,activeParty:()=>['source','ally','third','extra'],withThreat:false,
    settlementOverrides:{
      onShowEffects:(_actorId,target,[effect])=>commands.push(['visual',target,effect.effect]),
    },
  });
  harness.stats.actorAttributes=(id:string)=>id==='source'?attributes:undefined;
  harness.stats.actorAttribute=(_id:string,key:string):number=>key==='lifeFeastRate'?feastRate:key==='healingPowerRate'?1000:0;
  harness.settlement.restoreHealth=(id:string,amount:number)=>commands.push(['heal',id,amount]);
  harness.settlement.settleHit=(_event,hit)=>commands.push(['damage',hit.damage]);
  const run=(ratePerThousand:number,stackCount=1)=>harness.settlement.periodicTick({sourceId:'source',targetId:'target',
    buffId:'blood-curse',stackCount,effect:{kind:'magic-curse',ratePerThousand,healEffect:'life-drain'}});
  return {commands,run};
}

test('the feast gives every one of the three slots the whole amount, then damages the target',()=>{
  // 一级：Q = trunc(100×230/1000) = 23，再按 350‰ 增幅 trunc(23×1350/1000) = 31。
  const {commands,run}=fixture(rates[0]!);
  run(curseRates[0]!);
  assert.deepEqual(commands,[
    ['heal','source',31],['visual','source','life-drain'],
    ['heal','ally',31],['visual','ally','life-drain'],
    ['heal','third',31],['visual','third','life-drain'],
    ['damage',31]]);
  // 第四名成员与召唤物都不在固定三槽里，命令里没有他们。
  assert.deepEqual(commands.filter(command=>Array.isArray(command)&&command[1]==='extra'),[]);
});

test('without the passive only the caster is healed, by the unamplified amount',()=>{
  for(const rate of [0,-10]){
    const {commands,run}=fixture(rate);
    run(curseRates[7]!);
    assert.deepEqual(commands,[['heal','source',34],['visual','source','life-drain'],['damage',34]],`rate ${rate}`);
  }
});

test('the base amount is truncated before the feast amplifies it',()=>{
  // 魔攻 101＋智力 21＋trunc(精力 25×12/10)=30 共 152：Q=trunc(152×230/1000)=34。
  const {commands,run}=fixture(rates[0]!,sourceAttributes(101,21,25));
  run(curseRates[0]!);
  // 先取整再增幅：trunc(34×1350/1000)=45。若先增幅再取整会得到 trunc(34.96×1.35)=47。
  assert.equal(commands[0]![2],45);
  assert.deepEqual(commands.at(-1),['damage',45]);
});

test('stack count multiplies the curse rate before the feast amplification',()=>{
  const {commands,run}=fixture(rates[0]!);
  run(curseRates[0]!,2);
  // Q = trunc(100×230×2/1000) = 46，增幅后 trunc(46×1350/1000) = 62。
  assert.equal(commands[0]![2],62);
  assert.deepEqual(commands.at(-1),['damage',62]);
});
