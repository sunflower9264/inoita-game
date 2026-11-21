import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {bestNormalDamage} from '../src/domain/combat-damage-source.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

function fixture(){
  const conditions=new CombatConditions();let rank=1;
  const defender={classId:'dark-knight',player:{health:100},skills:{draft:()=>({levels:{'shield-of-rage':rank}})},
    bag:{revision:0,equipmentFor:()=>({}),get:()=>undefined}};
  const host=Object.setPrototypeOf({app:{battleCatalog:catalog,session:{skills:defender.skills}},conditions,arena:[],
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    memberOf:(id:string)=>id==='player'?defender:undefined,equipmentRecovery:()=>({lifeDrainPerThousand:0}),
    actorAttribute:()=>0,attackProc:()=>{},syncCombatResourceLimits:()=>{},interruptDisabled:()=>{},applyStateConsequences:()=>{}},WorldCombat.prototype);
  const hit=(damageKind:'physical'|'magic',kind:'hit'|'miss'|'weapon-block'|'shield-block')=>
    Reflect.get(WorldCombat.prototype,'resolveHitReactions').call(host,{casterId:'attacker',targetId:'player'},
      {kind,damage:0},damageKind,'basic-attack',{});
  return {conditions,hit,setRank:(value:number)=>rank=value};
}

test('rage shield is immediate on physical weapon or shield blocks and stacks to five',()=>{
  const {conditions,hit}=fixture();
  for(const [kind,outcome] of [['physical','miss'],['physical','hit'],['magic','shield-block'],['magic','hit']] as const)hit(kind,outcome);
  assert.equal(conditions.hasBuff('player','shield-of-rage'),false);
  for(let blocks=1;blocks<=6;blocks++){
    hit('physical',blocks%2?'weapon-block':'shield-block');
    const layers=Math.min(blocks,5);
    assert.equal(conditions.attribute('player','physicalDamageRate',0),65*layers);
    const active=conditions.snapshot('player')[0];
    assert.equal(active.stackCount,layers);assert.equal(active.sourceId,'player');
  }
  const rate=conditions.attribute('player','physicalDamageRate',0);
  assert.equal(bestNormalDamage({physicalAttack:100,magicAttack:0,physicalDamageRate:rate,
    magicDamageRate:0,stealthDamageRate:0}),132);
});

test('rage shield refresh keeps layer cap and expires only after its final active frame',()=>{
  const {conditions,hit}=fixture();
  for(let i=0;i<5;i++)hit('physical','weapon-block');
  conditions.update(4560);
  assert.equal(conditions.hasBuff('player','shield-of-rage'),true);
  hit('physical','shield-block');
  assert.equal(conditions.snapshot('player')[0].stackCount,5);
  conditions.update(4560);
  assert.equal(conditions.hasBuff('player','shield-of-rage'),true);
  conditions.update(60);
  assert.equal(conditions.hasBuff('player','shield-of-rage'),false);
  assert.equal(conditions.attribute('player','physicalDamageRate',0),0);
});

test('all eight rage shield ranks retain their researched per-layer rates',()=>{
  for(const [index,rate] of [65,85,105,125,135,145,155,165].entries()){
    const {conditions,hit,setRank}=fixture();setRank(index+1);hit('physical','weapon-block');
    assert.equal(conditions.attribute('player','physicalDamageRate',0),rate);
    const effect=catalog.skills['shield-of-rage'].reactionsByRank![index][0];
    assert.equal(effect.kind,'shield-of-rage');if(effect.kind!=='shield-of-rage')continue;
    assert.deepEqual(effect.buff.effect.simulationFrames,{lastActiveFrame:75});
    assert.equal(effect.buff.effect.maxStacks,5);
  }
});
