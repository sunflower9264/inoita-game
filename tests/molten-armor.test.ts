import {CombatRuntime} from '../src/domain/combat-runtime.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {selectAttackSplashCenter} from '../src/domain/attack-splash.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,NumericCombatUnit} from '../src/domain/battle.ts';
import type {BattleStatKey} from '../src/domain/battle-semantics.ts';
import {CombatController,type Combatant,type CombatPort,type AttackContact} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {PendingEnemyDefeats} from '../src/domain/combat-outcomes.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import type {SkillReactionEvent} from '../src/domain/skill-reactions.ts';
import {moltenReflectionDamage,rollMoltenSplash,moltenSplashTargets} from '../src/domain/molten-armor.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const actor=(id:string,x=0,y=0,team:'party'|'hostile'='hostile'):Combatant=>({id,team,position:{x,y},
  bounds:{x:-4,y:-4,width:8,height:8},facing:'east'});

test('reflection keeps native defense rounding and monster raw-attack basis',()=>{
  assert.equal(moltenReflectionDamage({kind:'character',defense:100,defenseRate:1000},320),64);
  assert.equal(moltenReflectionDamage({kind:'character',defense:101,defenseRate:666},320),53);
  assert.equal(moltenReflectionDamage({kind:'character',defense:-10,defenseRate:500},320),0);
  assert.equal(moltenReflectionDamage({kind:'monster',physicalAttack:100},320),32);
});

test('splash uses strict chance boundaries, consumes a zero-threshold roll, and preserves zero damage success',()=>{
  let rolls=0;
  assert.equal(rollMoltenSplash(65,0,()=>{rolls++;return 0;}),undefined);assert.equal(rolls,1);
  assert.equal(rollMoltenSplash(65,56,()=>54/999),32);
  assert.equal(rollMoltenSplash(65,56,()=>55/999),undefined);
  assert.equal(rollMoltenSplash(0,1000,()=>.99999),0);
});

test('center selection preserves current target, consumes gaze first, and searches by facing score',()=>{
  const source=actor('defender',0,0,'party'),behind=actor('behind',-6),forward=actor('forward',10),tie=actor('tie',10);
  assert.equal(selectAttackSplashCenter(source,[behind,forward,tie],4).targetId,'forward');
  assert.equal(selectAttackSplashCenter(source,[behind,forward],4,{currentTargetId:'behind'}).targetId,'behind');
  assert.deepEqual(selectAttackSplashCenter(source,[behind,forward],4,{currentTargetId:'behind',gazeTargetId:'forward'}),
    {center:forward.position,targetId:'forward',consumedGaze:true});
  assert.deepEqual(selectAttackSplashCenter(source,[behind,forward],4,{currentTargetId:'behind',gazeTargetId:'forward',retainCurrentTarget:true}),
    {center:behind.position,targetId:'behind',consumedGaze:false});
  const far=actor('far',100);
  assert.deepEqual(selectAttackSplashCenter(source,[far,forward],4,{currentTargetId:'far'}),{center:source.position,consumedGaze:false});
  assert.deepEqual(selectAttackSplashCenter(source,[far,forward],4,{currentTargetId:'forward',gazeTargetId:'far'}),
    {center:source.position,consumedGaze:true});
  assert.equal(selectAttackSplashCenter(source,[actor('edge',31)],4).targetId,'edge');
  assert.equal(selectAttackSplashCenter(source,[actor('outside',32)],4).targetId,undefined);
  assert.equal(selectAttackSplashCenter(source,[actor('zero-score',-32)],4).targetId,undefined);
});

test('center scoring uses native integer coordinates and preserves the selected world position',()=>{
  const source=actor('defender',.5,0,'party'),first=actor('first',.2),second=actor('second',.99);
  const selected=selectAttackSplashCenter(source,[first,second],4);
  assert.equal(selected.targetId,'first');
  assert.strictEqual(selected.center,first.position);
});

test('splash uses the native noncircular distance and excludes the attacker only after collecting 16',()=>{
  const source=actor('defender',0,0,'party');
  const near=[actor('axis-in',39),actor('axis-out',40),actor('diagonal-in',28,28),actor('diagonal-out',29,29),
    {...actor('hidden'),states:['stealthed'] as const},actor('friend',0,0,'party')];
  assert.deepEqual(moltenSplashTargets(source,source.position,near,'attacker').map(value=>value.id),['axis-in','diagonal-in']);
  const crowd=[actor('attacker'),...Array.from({length:17},(_,i)=>actor(`other-${i}`))];
  assert.deepEqual(moltenSplashTargets(source,source.position,crowd,'attacker').map(value=>value.id),
    Array.from({length:15},(_,i)=>`other-${i}`));
});

test('reaction retargeting preserves active playback while explicit selection still cancels it',()=>{
  const source=actor('player',0,0,'party'),first=actor('first',10),second=actor('second',12);
  let cancelled=0;
  const actors=[source,first,second];
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor('player'),actor:id=>actors.find(value=>value.id===id),candidates:()=>actors,facing:()=> 'east',
    moveToward:()=>{},stop:()=>{},canStand:()=>true,relocate:()=>{},play:()=>()=>{cancelled++;},frame:()=>{},clearEffects:()=>{}};
  const controller=new CombatController('player',resolveBasicAttack(catalog,catalog.classes[0]),port);
  assert.equal(controller.requestTarget('first'),'started');
  controller.setReactionTarget('second');
  assert.equal(controller.snapshot().targetId,'second');assert.equal(controller.snapshot().state,'attacking');assert.equal(cancelled,0);
  controller.selectTarget('first');assert.equal(cancelled,1);assert.equal(controller.snapshot().targetId,'first');
});

function fixture(){
  const conditions=new CombatConditions(),order:string[]=[],events:SkillReactionEvent[]=[],notifications:AttackContact[]=[];
  const fighter={level:1,physicalAttack:100,physicalDamageRate:0,magicDamageRate:0,hitBase:100,hitBonus:1000,
    evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,
    weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:750};
  const defender={classId:'dark-knight',level:1,bag:{equipmentFor:()=>({}),get:()=>undefined},panel:{...fighter,maxHealth:1000,maxMana:0,baseDefense:100,defense:150,defenseRate:500},
    player:{health:1000,maxHealth:1000,maxMana:0},setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number){this.player[key]=value;},setHealth(value:number){this.player.health=Math.max(0,Math.min(1000,value));}};
  const states=new Map<string,{health:number;maxHealth:number;level:number;elite:boolean;physicalAttack:number}>([
    ['attacker',{health:500,maxHealth:500,level:1,elite:false,physicalAttack:100}],
    ['nearby',{health:500,maxHealth:500,level:1,elite:false,physicalAttack:100}],
  ]);
  const actors=[actor('player',0,0,'party'),actor('attacker',8),actor('nearby',16)];
  const visual=(id:string)=>({actor:{collision:actors.find(value=>value.id===id)!.bounds},
    container:{active:true,x:0,y:0,disableInteractive:()=>{}}});
  const enemyDefinition={...catalog.enemies.find(value=>!!value.basicAttack)!,defeatPresentation:'vanish' as const};
  const enemies=[...states.keys()].map(key=>({key,definition:enemyDefinition,visual:visual(key),
    controller:{targetRemoved:()=>{},dispose:()=>order.push(`dispose:${key}`),onContact:(event:AttackContact)=>notifications.push(event)},presenter:{clear:()=>{}}}));
  const damage:NumericCombatUnit={effect:'physical',source:'physicalAttack',attributeWeights:primary,
    ranks:[{fixedAddition:0,operation:{kind:'add',amount:0}}]};
  let selected='attacker',reaction:((event:SkillReactionEvent)=>void)=()=>{};
  const controller={snapshot:()=>({targetId:selected}),selectedTargetId:()=>selected,actionState:()=> 'idle',
    targetRemoved:()=>{},setReactionTarget:(id:string)=>{selected=id;order.push(`select:${id}`);}};
  let frame=0;const runtime=new CombatRuntime(()=>frame);
  const host=Object.setPrototypeOf({runtime,
    hero:defender,app:{battleCatalog:{...catalog,basicAttacks:{...catalog.basicAttacks,
      [enemyDefinition.basicAttack!.profileId]:{...catalog.basicAttacks[enemyDefinition.basicAttack!.profileId],damage}}},
      audio:{monsterDeath:()=>order.push('death-sound')},session:{}},
    conditions,arena:enemies,allies:[],partyControllers:new Map([['player',controller]]),
    pendingDefeats:new PendingEnemyDefeats(),hitResolution:new CombatHitResolution(),
    memberOf:(id:string)=>id==='player'?defender:undefined,partyPassives:()=>[],equipmentRecovery:()=>({lifeDrainPerThousand:0}),
    enemyFighter:()=>fighter,visualOf:(id:string)=>visual(id),
    actorAttributes:()=>({physicalAttack:100,magicAttack:0,maxHealth:1000,physicalDamageRate:0,magicDamageRate:0,
      stealthDamageRate:0,primaryAttributes:primary}),
    combatants:()=>actors.filter(value=>!host.pendingDefeats.has(value.id)&&!removed.has(value.id)),
    combatant:(id:string)=>actors.find(value=>value.id===id&&!host.pendingDefeats.has(id)&&!removed.has(id)),
    roster:{enemySnapshot:(id:string)=>({...states.get(id)!}),setEnemyHealth:(id:string,health:number)=>{
      states.get(id)!.health=Math.max(0,Math.min(states.get(id)!.maxHealth,health));},source:()=>undefined},
    movement:{stop:()=>{},setEnabled:()=>{}},scene:{events:{emit:()=>order.push('contact')},map:{id:'test'},refreshCombatTarget:()=>{}},
    outcomes:{cancelDeath:()=>{},vanish:(_id:string,_visual:unknown,finish:()=>void)=>finish()},
    removeEnemy:(id:string)=>{removed.add(id);order.push(`removed:${id}`);},
    showHit:(event:{targetId:string},hit:PhysicalHit)=>order.push(`damage:${event.targetId}:${hit.damage}`),
    react:(event:SkillReactionEvent)=>{events.push(event);order.push(`react:${event.kind}:${event.ownerId}`);reaction(event);},
    attackProc:()=>order.push('weapon-procs'),dropMana:()=>{},
  },WorldCombat.prototype);
  const removed=new Set<string>();
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const set=(id:string,attribute:BattleStatKey,amount:number)=>conditions.setTemporaryAttribute(id,attribute,amount);
  const apply=(id='player',rank=1)=>{
    const buff=catalog.skills['molten-armor'].action!.combatUnits!.find(value=>value.effect==='buff')!;
    assert.equal(buff.effect,'buff');if(buff.effect!=='buff')throw new Error('missing armor buff');
    const data=buff.ranks[rank-1];conditions.applyBuff(id,buff.buff,data.strength,data.effect,id);
    return data;
  };
  const contact=(kind:PhysicalHit['kind']='hit',damageKind:'physical'|'magic'='physical',damage=0,targetId='player')=>
    host.hitResolution.run(()=>call('resolveHitReactions',{casterId:'attacker',targetId},{kind,damage},damageKind,'basic-attack',defender));
  return {host,conditions,defender,states,actors,order,events,notifications,call,set,apply,contact,advanceDeath:()=>{for(let index=0;index<11;index++)runtime.step(++frame);},
    select:(id:string)=>{selected=id;},onReaction:(callback:(event:SkillReactionEvent)=>void)=>{reaction=callback;}};
}

test('all physical successes including zero damage reflect; misses and magic do not',t=>{
  t.mock.method(Math,'random',()=>0);
  for(const kind of ['hit','critical','weapon-block','shield-block'] as const){
    const run=fixture();run.apply();run.set('player','fireSplashChance',0);run.contact(kind);
    assert.equal(run.states.get('attacker')!.health,452);
    assert.equal(run.states.get('nearby')!.health,500);
    assert.equal(run.events.filter(event=>event.kind==='molten-reflection-completed').length,1);
  }
  for(const [kind,damageKind] of [['miss','physical'],['hit','magic'],['critical','magic'],['shield-block','magic']] as const){
    const run=fixture();run.apply();run.contact(kind,damageKind);
    assert.equal(run.states.get('attacker')!.health,500);
    assert.equal(run.events.some(event=>event.kind==='molten-reflection-completed'),false);
  }
});

test('host reads defense after block reactions and preserves direct, splash, defender, attacker, wrath order',t=>{
  t.mock.method(Math,'random',()=>0);
  const run=fixture();run.apply();run.set('player','fireSplashChance',1000);
  run.onReaction(event=>{if(event.kind==='physical-block')run.conditions.applyBuff('player','guardian-of-darkness',1,
    {durationMs:1000,tickMs:0,modifiers:[{attribute:'defenseRate',operation:{kind:'add',amount:500}}],states:[],periodic:[]});});
  run.contact('shield-block');
  assert.equal(run.states.get('attacker')!.health,436);assert.equal(run.states.get('nearby')!.health,468);
  assert.deepEqual(run.order,[
    // 受击者是队伍阵营，所以血之复仇先给三个活动队伍槽各判一次自己的已学等级。
    'react:blood-revenge:player','react:physical-block:player','react:attack-success:attacker','react:physical-flare:attacker','damage:attacker:64','damage:nearby:32',
    'react:molten-reflection-completed:player','react:attack-effects:attacker','react:physical-hit-received:player','weapon-procs',
  ]);
});

test('zero reflection and immune direct recipients still consume splash and reach defender flares',t=>{
  let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return 0;});
  const zero=fixture();zero.apply();zero.set('player','defense',0);zero.set('player','fireSplashChance',0);zero.contact();
  assert.equal(rolls,1);assert.equal(zero.order.some(value=>value.startsWith('damage:')),false);
  assert.equal(zero.events.some(event=>event.kind==='molten-reflection-completed'),true);
  const immune=fixture();immune.apply();immune.set('player','fireSplashChance',1000);
  immune.conditions.applyState('attacker','damage-immune',1000);immune.contact();
  assert.equal(immune.states.get('attacker')!.health,500);assert.equal(immune.states.get('nearby')!.health,476);
  assert.equal(rolls,2);
  const selection=fixture();selection.apply();selection.set('player','defense',0);selection.set('player','fireSplashChance',1000);
  selection.select('missing');selection.contact();
  assert.ok(selection.order.includes('select:attacker'));
  assert.equal(selection.order.some(value=>value.startsWith('damage:')),false);
});

test('accepted reflection and splash notify monster AI without recursively entering hit reactions',t=>{
  t.mock.method(Math,'random',()=>0);
  const run=fixture();Reflect.set(run.host,'enemiesRunning',true);run.apply();run.set('player','fireSplashChance',1000);
  run.contact();
  assert.deepEqual(run.notifications,[{casterId:'player',targetId:'attacker'},{casterId:'player',targetId:'nearby'}]);
  assert.equal(run.events.filter(event=>event.kind==='attack-success').length,1);
  run.notifications.length=0;run.conditions.applyState('attacker','damage-immune',1000);run.contact();
  assert.deepEqual(run.notifications,[{casterId:'player',targetId:'nearby'}]);
  run.notifications.length=0;run.set('player','defense',0);run.contact();assert.equal(run.notifications.length,0);
});

test('positive direct armor damage reaches companion and uncontrolled hero reaction ports only when accepted',()=>{
  const run=fixture();Reflect.set(run.host,'enemiesRunning',true);
  Reflect.set(run.host,'memberOf',(id:string)=>id==='player'||id==='ally'?run.defender:undefined);
  Reflect.set(run.host,'allies',[{id:'ally',ai:{onContact:(event:AttackContact)=>run.notifications.push(event)}}]);
  Reflect.set(run.host,'heroAi',{onContact:(event:AttackContact)=>run.notifications.push(event)});
  for(const targetId of ['ally','player']){
    Reflect.set(run.host.app,'session',{party:{controlledId:targetId==='player'?'ally':'player'}});
    const event={casterId:'attacker',targetId};
    run.call('moltenDirectDamage',event,1,run.defender);
    assert.deepEqual(run.notifications.at(-1),event);
    const count=run.notifications.length;
    run.call('moltenDirectDamage',event,0,run.defender);
    run.conditions.applyState(targetId,'damage-immune',1000);run.call('moltenDirectDamage',event,1,run.defender);
    assert.equal(run.notifications.length,count);
  }
  assert.equal(run.events.length,0);
});

test('monster and summoned armor use raw physical attack, and attacker fire permission uses live reflection value',t=>{
  t.mock.method(Math,'random',()=>0);
  for(const summoned of [false,true]){
    const run=fixture();if(summoned)Object.assign(run.host.arena[1],{summonedBy:'player'});
    run.apply('nearby');run.set('nearby','fireSplashChance',0);run.set('nearby','physicalDamageRate',5000);
    run.set('nearby','defense',10000);run.set('nearby','defenseRate',5000);
    run.contact('hit','physical',0,'nearby');assert.equal(run.states.get('attacker')!.health,468);
    run.set('attacker','moltenReflectionPerThousand',1);run.contact('hit','magic');
    const event=[...run.events].reverse().find(event=>event.kind==='attack-effects');
    assert.equal(event?.kind,'attack-effects');if(event?.kind==='attack-effects')assert.equal(event.hasMoltenArmor,true);
    run.apply('attacker');run.set('attacker','moltenReflectionPerThousand',0);run.contact('hit','magic');
    const suppressed=[...run.events].reverse().find(event=>event.kind==='attack-effects');
    if(suppressed?.kind==='attack-effects')assert.equal(suppressed.hasMoltenArmor,false);
  }
});

test('a fatal reflection does not cancel splash or the real basic host main damage',t=>{
  t.mock.method(Math,'random',()=>0);
  const run=fixture();run.apply();run.set('player','fireSplashChance',1000);run.states.get('attacker')!.health=30;
  run.call('attackContact',{casterId:'attacker',targetId:'player'});
  assert.equal(run.states.get('attacker')!.health,0);assert.equal(run.states.get('nearby')!.health,476);
  assert.ok(run.defender.player.health<1000);
  run.advanceDeath();
  assert.ok(run.order.indexOf('removed:attacker')>run.order.findIndex(value=>value.startsWith('damage:player:')));
});

test('host center follows its current target, falls back to self when far, and keeps focus semantics',()=>{
  const run=fixture();const source=run.actors[0];
  run.select('nearby');Reflect.set(run.host,'focusTargetId','attacker');
  assert.deepEqual(run.call('attackSplashCenter',source,run.actors,4),run.actors[2].position);
  assert.equal(Reflect.get(run.host,'focusTargetId'),'attacker');
  run.actors[2].position={x:100,y:0};
  assert.deepEqual(run.call('attackSplashCenter',source,run.actors,4),source.position);
});

test('real catalog preserves all armor ranks, four native units and the final active frame',()=>{
  const run=fixture();
  for(const [index,rate] of [320,440,560,680,740,800,860,920].entries()){
    run.conditions.clear();const rank=run.apply('player',index+1);
    assert.equal(run.call('actorAttribute','player','moltenReflectionPerThousand'),rate);
    assert.equal(rank.effect.modifiers.length,3);assert.ok(rank.effect.appearanceColors?.length);
    assert.equal(rank.effect.applicationEffect,'molten-armor-aura');
    assert.deepEqual(rank.effect.simulationFrames,{lastActiveFrame:300});
    run.conditions.update(18060);assert.equal(run.conditions.hasBuff('player','molten-armor'),true);
    run.conditions.update(60);assert.equal(run.conditions.hasBuff('player','molten-armor'),false);
  }
});
