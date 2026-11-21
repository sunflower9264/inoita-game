import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatController,type CombatPort,type Combatant} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {CombatResourceRecovery} from '../src/domain/combat-resources.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const read=(file:string)=>JSON.parse(readFileSync(new URL(`../public/content/${file}.json`,import.meta.url),'utf8'));
const catalog=read('battle') as BattleCatalog,items=read('items') as ItemCatalog;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
function fixture(){
  let rank=1,allyRank=0,revengeRank=0,revision=0;
  const equipment:Record<string,string>={};
  const equip=(kind:string,slot='main-hand')=>{equipment[slot]=Object.keys(items.items).find(id=>items.items[id].kind===kind&&items.items[id].equipment)!;revision++;assert.ok(equipment[slot]);};
  equip('longsword');
  const configuration=(value:()=>number,revenge=()=>0)=>({get version(){return value()*100+revenge();},
    draft:()=>({levels:{'warrior-s-instinct':value(),'revenge-incarnate':revenge()}})});
  const member=(value:()=>number,revenge?:()=>number)=>({classId:'warrior',level:10,
    panel:{physicalAttack:100,magicAttack:50,maxHealth:1000,maxMana:100},
    player:{health:500,maxHealth:1000,mana:100,maxMana:100},skills:configuration(value,revenge),
    bag:{get revision(){return revision;},equipmentFor:()=>equipment,equipmentItems:(value:Record<string,string>)=>value,get:()=>undefined},
  });
  const hero=member(()=>rank),ally=member(()=>allyRank,()=>revengeRank);
  const conditions=new CombatConditions(),cooldowns=new CombatCooldownStore(()=>25),recovery=new CombatResourceRecovery();
  recovery.advanceToFrame(25,[]);
  const host=Object.setPrototypeOf({hero,conditions,hitResolution:new CombatHitResolution(),arena:[],allies:[],
    partyControllers:new Map<string,CombatController>(),pendingDefeats:new Set(),fallen:new Set(),
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    app:{battleCatalog:catalog,items,session:{skills:configuration(()=>rank),cooldowns,resourceRecovery:recovery,
      party:{groupModifiers:()=>({})}}},memberOf:(id:string)=>id==='player'?hero:id==='ally'?ally:undefined,
    attackProc:()=>{},syncCombatResourceLimits:()=>{},applyStateConsequences:()=>{},
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const contact=(source='player',kind:PhysicalHit['kind']='hit',damageKind:'physical'|'magic'='physical')=>
    call('resolveHitReactions',{casterId:source,targetId:source==='player'?'ally':'player'},{kind,damage:0},damageKind,'basic-attack',hero);
  const seed=(id='player')=>{cooldowns.forActor(id).start('armor-penetration',100);cooldowns.forActor(id).start('blood-thirst',200);};
  return {host,hero,ally,equipment,equip,conditions,cooldowns,recovery,call,contact,seed,
    learn:(value:number)=>{rank=value;},learnAlly:(value:number)=>{allyRank=value;},learnRevenge:(value:number)=>{revengeRank=value;}};
}

test('all learned ranks use live main-hand two-handed flags and preserve strict thresholds',t=>{
  const f=fixture();let roll=1,rolls=0;t.mock.method(Math,'random',()=>{rolls++;return (roll-.5)/999;});
  for(const [index,chance] of [10,20,30,40,50,50,60,60].entries()){
    f.learn(index+1);assert.equal(f.call('actorAttribute','player','cooldownResetChance'),chance);
    for(const kind of ['longsword','dagger','axe','mace','two-handed','bow','crossbow','staff','orb']){
      f.equip(kind);const twoHanded=items.items[f.equipment['main-hand']].equipment!.twoHanded;
      const threshold=twoHanded?Math.trunc(chance*15/10):chance;
      // 一次是本项自己的抽签，另一次是残影的无条件抽签。
      f.seed();roll=threshold;const before=rolls;f.contact();assert.equal(rolls,before+2);
      assert.equal(f.cooldowns.forActor('player').isReady('armor-penetration'),false,kind);
      roll=threshold-1;f.contact();assert.deepEqual(f.cooldowns.forActor('player').snapshot(),{},kind);
    }
  }
  f.learn(1);delete f.equipment['main-hand'];f.equip('two-handed','off-hand');
  f.seed();roll=10;f.contact();assert.equal(f.cooldowns.forActor('player').isReady('armor-penetration'),false);
  roll=9;f.contact();assert.deepEqual(f.cooldowns.forActor('player').snapshot(),{});
});

test('the physical success gate and current member attributes isolate cooldown resets',t=>{
  for(const damageKind of ['physical','magic'] as const)for(const outcome of ['hit','critical','weapon-block','shield-block','miss'] as const){
    const f=fixture();f.seed();f.seed('ally');let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return 0;});
    f.contact('player',outcome,damageKind);const accepts=damageKind==='physical'&&outcome!=='miss';
    // 物理成功还会消耗残影那一次无条件抽签。
    assert.equal(rolls,accepts?2:0);assert.equal(f.cooldowns.forActor('player').isReady('blood-thirst'),accepts);
    assert.equal(f.cooldowns.forActor('ally').isReady('blood-thirst'),false);
  }
  const f=fixture();f.learn(0);f.learnAlly(8);f.seed();f.seed('ally');
  t.mock.method(Math,'random',()=>0);f.contact();assert.equal(f.cooldowns.forActor('player').isReady('blood-thirst'),false);
  f.contact('ally');assert.deepEqual(f.cooldowns.forActor('ally').snapshot(),{});
  f.conditions.setTemporaryAttribute('player','cooldownResetChance',1000);f.contact();
  assert.deepEqual(f.cooldowns.forActor('player').snapshot(),{});
});

test('a real multi-hit controller continues its action and publishes cleared cooldowns without repaying mana or moving the recovery clock',t=>{
  const f=fixture();f.seed();f.seed('ally');t.mock.method(Math,'random',()=>0);
  const actors:Combatant[]=[{id:'player',team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}},
    {id:'ally',team:'enemy',position:{x:16,y:0},bounds:{x:-4,y:-4,width:8,height:8}}];
  let frame=(_index:number)=>{},finish=()=>{},cancelled=false,currentFrame=0,paid=0;
  const hits:number[]=[],updates:unknown[]=[];
  const port:CombatPort={cooldowns:f.cooldowns.forActor('player'),actor:id=>actors.find(actor=>actor.id===id),
    candidates:()=>actors,facing:()=> 'east',moveToward:()=>{},stop:()=>{},canStand:()=>true,relocate:()=>{},clearEffects:()=>{},
    canSpendMana:cost=>f.hero.player.mana>=cost,spendMana:cost=>{paid+=cost;f.hero.player.mana-=cost;return true;},
    play:(_play,onFrame,onFinish)=>{frame=onFrame;finish=onFinish;return ()=>{cancelled=true;};},
    frame:(play,index,_contact,ready)=>{currentFrame=index;for(const event of play.skill!.action.events){
      if(event.kind==='units'&&event.frame===index)ready({event});
    }},unit:()=>{hits.push(currentFrame);f.contact();return 'success';},
  };
  const controller=new CombatController('player',null,port);f.host.partyControllers.set('player',controller);
  controller.subscribe(snapshot=>updates.push(snapshot));
  const skill={id:'swirling-storm',level:1,manaCost:60,action:catalog.skills['swirling-storm'].action!};
  const recovery=f.recovery.captureState();
  assert.equal(controller.requestManualSkill(skill,'ally'),'started');assert.equal(paid,60);
  frame(3);assert.deepEqual(hits,[3]);
  assert.deepEqual(controller.snapshot(),{state:'attacking',targetId:'ally',cooldowns:{}});
  assert.deepEqual(updates.at(-1),controller.snapshot());
  assert.equal(controller.requestManualSkill(skill,'ally'),'busy');
  frame(15);assert.deepEqual(hits,[3,6,9,12,15]);assert.equal(cancelled,false);
  assert.equal(f.hero.player.mana,40);assert.equal(paid,60);assert.deepEqual(f.recovery.captureState(),recovery);
  assert.equal(f.cooldowns.forActor('ally').isReady('blood-thirst'),false);
  finish();assert.equal(controller.snapshot().state,'idle');assert.deepEqual(controller.snapshot().cooldowns,{});
});

test('revenge applies before the attacker reset and reflection sees the cleared cooldowns',t=>{
  const f=fixture();f.learnRevenge(1);f.seed();const order:string[]=[];
  f.conditions.setTemporaryAttribute('ally','moltenReflectionPerThousand',100);
  t.mock.method(Math,'random',()=>{order.push('roll');return 0;});
  const apply=f.host.applyActorBuff.bind(f.host);
  f.host.applyActorBuff=(...args:unknown[])=>{order.push(String(args[1]));return apply(...args);};
  const reset=f.cooldowns.resetActor.bind(f.cooldowns);
  f.cooldowns.resetActor=id=>{order.push(`reset:${id}`);reset(id);};
  f.host.moltenReflection=()=>{assert.deepEqual(f.cooldowns.forActor('player').snapshot(),{});order.push('reflection');};
  // 残影的抽签排在防守方复仇之前（原版 17c98c 早于复仇判定）。
  f.contact();assert.deepEqual(order,['roll','roll','revenge-incarnate','roll','reset:player','reflection']);
});
