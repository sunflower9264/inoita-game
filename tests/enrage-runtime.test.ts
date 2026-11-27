import assert from 'node:assert/strict';
import test from 'node:test';
import type {BattleBuffEffect} from '../src/domain/battle.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {createCombatTestHarness,createTestMember,loadBattleCatalog,ZERO_PRIMARY_ATTRIBUTES} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const action=catalog.skills.enrage.action!;
function fixture(){
  const member=createTestMember({
    id:'player',classId:'warrior',level:10,health:100,maxHealth:1000,mana:40,maxMana:100,
    panel:{
      attributes:{...ZERO_PRIMARY_ATTRIBUTES},
      physicalAttack:100,magicAttack:50,baseDefense:0,defense:0,defenseRate:0,maxHealth:1000,maxMana:100,
      hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,
      criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0,
    },
  });
  // 真实 BattleCharacter.setCombatResourceLimits 只改上限记录，不主动夹紧超出的现有法力。
  member.setCombatResourceLimits=(hp,mp)=>{member.player.maxHealth=hp;member.player.maxMana=mp;};
  const hitResolution=new CombatHitResolution();
  const harness=createCombatTestHarness({
    battleCatalog:catalog,hero:member,members:new Map([['player',member]]),hitResolution,
    activeParty:()=>['player'],
    settlementOverrides:{
      onStateConsequences:undefined,
      onBuffApplication:()=>assert.fail('enrage has no independent Buff application effect'),
    },
  });
  const cast=(level=1)=>harness.settlement.skillUnit({casterId:'player',targetId:'player',cueIndex:0,skill:{id:'enrage',action,level}});
  const read=(key:'maxHealth'|'maxMana'='maxHealth')=>harness.stats.actorAttribute('player',key);
  const project=()=>harness.stats.syncCombatResourceLimits('player');
  return {harness,player:member.player,base:member.panel,hitResolution,conditions:harness.conditions,cast,read,project};
}

test('valid pre-cast capacity gives 160 HP, same-rank refresh gives 185, and a projection warms a dirty cache',()=>{
  const f=fixture();assert.equal(f.read(),1000);f.cast();
  assert.equal(f.player.health,260);assert.equal(f.player.maxHealth,1160);
  f.cast();assert.equal(f.player.health,445);
  const dirty=fixture();dirty.project();dirty.cast();assert.equal(dirty.player.health,260);
});

test('a prior unrelated Buff warms a dirty capacity before Enrage links its own modifier',()=>{
  const f=fixture();f.harness.settlement.applyActorBuff('player','armor-penetration',1,{durationMs:1000,tickMs:0,states:[],periodic:[],modifiers:[]} satisfies BattleBuffEffect,'player');
  f.cast();assert.equal(f.player.health,260);
});

test('weak rejected ranks neither heal nor change accepted source or expiration',()=>{
  const f=fixture();f.read();f.cast(2);assert.equal(f.player.health,340);
  f.conditions.update(60);const before=f.conditions.snapshot('player');
  f.cast(1);assert.equal(f.player.health,340);assert.deepEqual(f.conditions.snapshot('player'),before);
});

test('max-HP modifiers without on-application restoration never heal, and a projection clamps expiration',()=>{
  const f=fixture();f.read();f.harness.settlement.applyActorBuff('player','enrage',1,
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
  const inactive=fixture();inactive.player.health=0;inactive.harness.fallen.add('player');
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
  const health=fixture();health.player.health=1200;health.harness.settlement.restoreHealth('player',-100);
  assert.equal(health.player.health,900);
  const mana=fixture();mana.player.mana=150;mana.harness.settlement.restoreMana('player',-80);
  assert.equal(mana.player.mana,70);
  const negative=fixture();negative.player.mana=20;negative.harness.settlement.restoreMana('player',-30);
  assert.equal(negative.player.mana,0);assert.equal((negative.conditions.captureState().resourceCapacities??[]).length,0);
  const zero=fixture();zero.player.health=1200;zero.harness.settlement.restoreHealth('player',0);assert.equal(zero.player.health,1000);
  zero.cast();assert.equal(zero.player.health,1160);
});


test('positive incoming damage reads a dirty health capacity before subtracting, while zero and immunity leave it dirty',()=>{
  const damaged=fixture();damaged.player.health=1160;
  damaged.harness.settlement.settleHit({casterId:'enemy',targetId:'player'},{kind:'hit',damage:100});
  assert.equal(damaged.player.health,900);
  damaged.player.health=100;damaged.cast();assert.equal(damaged.player.health,260);
  const zero=fixture();
  zero.harness.settlement.settleHit({casterId:'enemy',targetId:'player'},{kind:'hit',damage:0});
  zero.cast();assert.equal(zero.player.health,285);
  const immune=fixture();immune.conditions.canReceiveDamage=()=>false;
  immune.harness.settlement.settleHit({casterId:'enemy',targetId:'player'},{kind:'hit',damage:100});
  immune.cast();assert.equal(immune.player.health,285);
});
