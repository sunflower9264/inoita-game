import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

test('wrath of darkness uses each rank chance and immediately stacks on physical receipt even at zero damage',t=>{
  t.mock.method(Math,'random',()=>0);
  const conditions=new CombatConditions();let rank=1;
  const defender={classId:'dark-knight',skills:{draft:()=>({levels:{'wrath-of-darkness':rank}})},
    bag:{revision:0,equipmentFor:()=>({}),get:()=>undefined}};
  const host=Object.setPrototypeOf({app:{battleCatalog:catalog},conditions,arena:[],
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    memberOf:(id:string)=>id==='defender'?defender:undefined,equipmentRecovery:()=>({lifeDrainPerThousand:0}),
    actorAttribute:()=>0,attackProc:()=>{},syncCombatResourceLimits:()=>{},interruptDisabled:()=>{},applyStateConsequences:()=>{}},WorldCombat.prototype);
  const hit=(damageKind:'physical'|'magic',kind:'hit'|'miss'|'critical'|'weapon-block'|'shield-block')=>
    Reflect.get(WorldCombat.prototype,'resolveHitReactions').call(host,{casterId:'attacker',targetId:'defender'},
      {kind,damage:0},damageKind,'basic-attack',{});
  for(const [kind,outcome] of [['physical','miss'],['magic','hit'],['magic','shield-block']] as const)hit(kind,outcome);
  assert.equal(conditions.hasBuff('defender','wrath-of-darkness'),false);
  for(const outcome of ['hit','critical','weapon-block','shield-block'] as const)hit('physical',outcome);
  assert.equal(conditions.attribute('defender','attackSpeedRate',1000),1400);
  for(let i=0;i<7;i++)hit('physical','hit');
  assert.equal(conditions.attribute('defender','attackSpeedRate',1000),2000);
  assert.equal(conditions.snapshot('defender')[0].stackCount,10);
  assert.equal(conditions.snapshot('defender')[0].sourceId,'defender');
  conditions.update(3660);assert.equal(conditions.hasBuff('defender','wrath-of-darkness'),true);
  hit('physical','hit');conditions.update(3660);
  assert.equal(conditions.hasBuff('defender','wrath-of-darkness'),true);
  conditions.update(60);assert.equal(conditions.attribute('defender','attackSpeedRate',1000),1000);
  for(const [index,chance] of [120,180,220,240,260,280,300,320].entries()){
    rank=index+1;
    const reaction=catalog.skills['wrath-of-darkness'].reactionsByRank![index][0];
    assert.equal(reaction.kind,'wrath-of-darkness');if(reaction.kind!=='wrath-of-darkness')continue;
    assert.equal(reaction.chanceThreshold,chance);
    assert.deepEqual(reaction.buff.effect.simulationFrames,{lastActiveFrame:60});
    assert.equal(reaction.buff.effect.maxStacks,10);
    conditions.clear();hit('physical','hit');
    assert.equal(conditions.attribute('defender','attackSpeedRate',1000),1100);
  }
});
