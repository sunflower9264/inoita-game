import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,BattleBuffEffect} from '../src/domain/battle.ts';
import type {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const action=catalog.skills.enrage.action!;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
function fixture(){
  const base={level:10,physicalAttack:100,magicAttack:50,baseDefense:0,defense:0,defenseRate:0,maxHealth:1000,maxMana:100,
    hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,
    criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0,
    attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}};
  const player={health:100,maxHealth:1000,mana:40,maxMana:100};
  const member={player,panel:base,level:10,classId:'warrior',
    setCombatResourceLimits(hp:number,mp:number){player.maxHealth=hp;player.maxMana=mp;},
    setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number){player[key]=value;const current=key==='maxHealth'?'health':'mana';player[current]=Math.min(player[current],value);},
    setHealth(value:number){player.health=Math.max(0,Math.min(player.maxHealth,value));},
    setMana(value:number){player.mana=Math.max(0,Math.min(player.maxMana,value));}};
  const hitResolution=new CombatHitResolution();
  const host=Object.setPrototypeOf({hero:member,app:{battleCatalog:catalog,session:{party:{activeIds:['player']},isInvincible:()=>false,isInfiniteMana:()=>false}},
    conditions:undefined as unknown as CombatConditions,hitResolution,arena:[],fallen:new Set<string>(),pendingDefeats:new Set<string>(),
    memberOf:(id:string)=>id==='player'?member:undefined,partyPassives:()=>[],combatProcs:()=>({zealotRate:0}),applyStateConsequences:()=>{},
    showBuffApplication:()=>assert.fail('enrage has no independent Buff application effect'),
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  host.conditions=call('createConditions');
  const cast=(level=1)=>call('skillUnit',{casterId:'player',targetId:'player',cueIndex:0,skill:{id:'enrage',action,level}});
  const read=(key:'maxHealth'|'maxMana'='maxHealth')=>call('actorAttribute','player',key) as number;
  const project=()=>call('syncCombatResourceLimits','player');
  return {host,player,base,hitResolution,conditions:host.conditions,call,cast,read,project};
}

test('valid pre-cast capacity gives 160 HP, same-rank refresh gives 185, and a projection warms a dirty cache',()=>{
  const f=fixture();assert.equal(f.read(),1000);f.cast();
  assert.equal(f.player.health,260);assert.equal(f.player.maxHealth,1160);
  f.cast();assert.equal(f.player.health,445);
  const dirty=fixture();dirty.project();dirty.cast();assert.equal(dirty.player.health,260);
});

test('a prior unrelated Buff warms a dirty capacity before Enrage links its own modifier',()=>{
  const f=fixture();f.call('applyActorBuff','player','armor-penetration',1,{durationMs:1000,tickMs:0,states:[],periodic:[],modifiers:[]} satisfies BattleBuffEffect,'player');
  f.cast();assert.equal(f.player.health,260);
});

test('weak rejected ranks neither heal nor change accepted source or expiration',()=>{
  const f=fixture();f.read();f.cast(2);assert.equal(f.player.health,340);
  f.conditions.update(60);const before=f.conditions.snapshot('player');
  f.cast(1);assert.equal(f.player.health,340);assert.deepEqual(f.conditions.snapshot('player'),before);
});

test('max-HP modifiers without on-application restoration never heal, and a projection clamps expiration',()=>{
  const f=fixture();f.read();f.call('applyActorBuff','player','enrage',1,
    {durationMs:60,tickMs:0,states:[],periodic:[],simulationFrames:{lastActiveFrame:0},maxStacks:1,modifiers:[{attribute:'maxHealth',operation:{kind:'increase-thousandth',ratePerThousand:160}}]} satisfies BattleBuffEffect,'player');
  assert.equal(f.player.health,100);assert.equal(f.player.maxHealth,1160);
  f.read();f.player.health=1160;f.conditions.update(120);f.project();
  assert.equal(f.player.maxHealth,1000);assert.equal(f.player.health,1000);
  assert.equal(f.read(),1000);assert.equal(f.player.health,1000);
});

test('direct restoration bypasses ordinary healing rates, preserves excess MP, and can rescue pending zero HP',()=>{
  const f=fixture();f.read();f.conditions.setTemporaryAttribute('player','healingPowerRate',0);
  f.read('maxMana');f.player.mana=150;f.player.health=0;
  f.hitResolution.run(()=>{f.hitResolution.deferDefeat('player',()=>{});f.cast();assert.equal(f.player.health,160);});
  assert.equal(f.player.mana,150);
  const inactive=fixture();inactive.player.health=0;inactive.host.fallen.add('player');
  assert.notEqual(inactive.cast(),'success');assert.equal(inactive.player.health,0);
});

test('equipment/base capacity changes invalidate old values while ordinary HP writes preserve valid capacity',()=>{
  const f=fixture();f.read();f.player.health=50;f.cast();assert.equal(f.player.health,210);
  const changed=fixture();changed.read();changed.base.maxHealth=2000;changed.project();changed.cast();
  assert.equal(changed.player.health,420);assert.equal(changed.player.maxHealth,2320);
});

test('checkpoint restore preserves whether Enrage will read a valid or dirty capacity',()=>{
  for(const valid of [false,true]){
    const f=fixture();if(valid)f.read();const saved=f.conditions.captureState();
    f.read();f.conditions.restoreState(saved);f.cast();assert.equal(f.player.health,valid?260:285);
  }
});


test('health and mana additions preserve their distinct dirty-capacity order, including zero recovery',()=>{
  const health=fixture();health.player.health=1200;health.call('restoreHealth','player',-100);
  assert.equal(health.player.health,900);
  const mana=fixture();mana.player.mana=150;mana.call('restoreMana','player',-80);
  assert.equal(mana.player.mana,70);
  const negative=fixture();negative.player.mana=20;negative.call('restoreMana','player',-30);
  assert.equal(negative.player.mana,0);assert.deepEqual(negative.conditions.captureState().resourceCapacities,[]);
  const zero=fixture();zero.player.health=1200;zero.call('restoreHealth','player',0);assert.equal(zero.player.health,1000);
  zero.cast();assert.equal(zero.player.health,1160);
});


test('positive incoming damage reads a dirty health capacity before subtracting, while zero and immunity leave it dirty',()=>{
  const damaged=fixture();damaged.player.health=1160;damaged.host.showHit=()=>{};
  damaged.call('settleHit',{casterId:'enemy',targetId:'player'},{kind:'hit',damage:100},damaged.host.hero);
  assert.equal(damaged.player.health,900);
  damaged.player.health=100;damaged.cast();assert.equal(damaged.player.health,260);
  const zero=fixture();zero.host.showHit=()=>{};
  zero.call('settleHit',{casterId:'enemy',targetId:'player'},{kind:'hit',damage:0},zero.host.hero);
  zero.cast();assert.equal(zero.player.health,285);
  const immune=fixture();immune.conditions.canReceiveDamage=()=>false;
  immune.call('settleHit',{casterId:'enemy',targetId:'player'},{kind:'hit',damage:100},immune.host.hero);
  immune.cast();assert.equal(immune.player.health,285);
});
