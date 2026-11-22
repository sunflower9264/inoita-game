import {dispatchFrame} from './support/combat-driver.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,ActionDispatchDefinition} from '../src/domain/battle.ts';
import {actionDamage} from '../src/domain/action-damage.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatController,resolveCueTargets,type ActionPlayback,type Combatant,type CombatPort,type SkillUnitHit} from '../src/domain/combat.ts';
import type {PhysicalFighter,PhysicalHit} from '../src/domain/physical-hit.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=catalog.skills['firestorm'],action=skill.action!,units=action.combatUnits!;
const damage=units[1],event=action.events.find(event=>event.kind==='units')!;
if(damage.effect!=='magic'||event.kind!=='units')throw new Error('Firestorm action missing');
const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const base:PhysicalFighter={level:10,physicalAttack:201,magicAttack:303,maxHealth:10000,hitBase:100,hitBonus:0,
  evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,
  weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
const actor=(id:string,x=16,y=0,team='enemy'):Combatant=>({id,team,position:{x,y},bounds:{x:-4,y:-4,width:8,height:8}});
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();

function fixture(targets:Combatant[]=[]){
  const caster=actor('caster',0,0,'party'),actors=new Map([caster,...targets].map(actor=>[actor.id,actor]));
  const stats=new Map(targets.map(actor=>[actor.id,{...base}]));
  const conditions=new CombatConditions(),hits:{event:SkillUnitHit;hit:PhysicalHit}[]=[],order:string[]=[],attempts:SkillUnitHit[]=[],feedback:ActionDispatchDefinition[]=[],prepared:number[]=[];
  const member={level:10,bag:{equipmentFor:()=>({}),get:()=>undefined},panel:{...base,attributes:{...primary}},player:{health:10000,maxHealth:10000,mana:100,maxMana:100}};
  let afterHit:((event:SkillUnitHit)=>void)|undefined;
  const host=Object.setPrototypeOf({hero:member,conditions,pendingDefeats:new Set(),
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),aiSkillCostCache:new Map(),
    arena:targets.map(actor=>({key:actor.id,definition:{}})),
    memberOf:(id:string)=>id==='caster'?member:undefined,partyPassives:()=>[],
    partyFighter:()=>conditions.fighter('caster',member.panel),enemyFighter:(id:string)=>conditions.fighter(id,stats.get(id)!),
    roster:{isPresent:()=>true,enemySnapshot:(id:string)=>stats.get(id)},combatant:(id:string)=>actors.get(id),
    resolveHitReactions:()=>{},showHit:()=>{},settleHit:(event:SkillUnitHit,hit:PhysicalHit)=>{hits.push({event,hit});afterHit?.(event);},dropMana:()=>{},
  },WorldCombat.prototype);
  const presenter=Object.setPrototypeOf({pose:()=>{},visualEffect:(cue:{effect:string})=>order.push(`effect:${cue.effect}`),
    visual:(id:string)=>actors.has(id)?{container:{active:true,...actors.get(id)!.position}}:undefined},CombatPresenter.prototype);
  let affordable=true;
  let frame=(_index:number)=>{},spent=0,moves=0,turns=0,playback:ActionPlayback|undefined;
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor('caster'),actor:id=>actors.get(id),candidates:()=>[...actors.values()],facing:()=> 'west',face:()=>{turns++;},
    moveToward:()=>{moves++;},stop:()=>{},canStand:()=>true,relocate:()=>{moves++;},clearEffects:()=>{},
    canSpendMana:()=>affordable,spendMana:cost=>{spent+=cost;return true;},
    play:(value,onFrame)=>{playback=value;frame=onFrame;return ()=>{};},
    frame:(value,index,contact,ready)=>dispatchFrame(presenter,value,index,contact,ready,undefined,(value:ActionDispatchDefinition,work:()=>void)=>{work();feedback.push(value);order.push('feedback');}),
    prepareUnit:event=>{prepared.push(event.cueIndex);return Reflect.get(WorldCombat.prototype,'prepareSkillUnit').call(host,event);},
    unit:hit=>{attempts.push(hit);order.push(`unit:${hit.cueIndex}:${hit.targetId}`);return Reflect.get(WorldCombat.prototype,'skillUnit').call(host,hit);}};
  const combat=new CombatController('caster',null,port);
  return {caster,stats,hits,order,attempts,feedback,combat,conditions,member,actors,host,prepared,
    afterHit:(callback:(event:SkillUnitHit)=>void)=>{afterHit=callback;},
    start:(targetId?:string)=>combat.requestManualSkill({id:skill.id,action,level:1,manaCost:52},targetId),
    frame:(index:number)=>frame(index),affordable:(value:boolean)=>{affordable=value;},counts:()=>({spent,moves,turns}),playback:()=>playback};
}


test('all eight Firestorm ranks retain their native main multiplier and temporary fire chance',()=>{
  assert.deepEqual(units.map(unit=>unit.effect),['set-attribute','magic','clear-attribute']);
  assert.equal(damage.source,'bestNormalDamage');
  assert.deepEqual(damage.attributeWeights,{strength:10,dexterity:0,vitality:0,intelligence:12,mentality:0});
  assert.deepEqual(damage.ranks.map(rank=>rank.operation),[2500,2700,2900,3100,3200,3300,3400,3500]
    .map(ratePerThousand=>({kind:'multiply-thousandth',ratePerThousand})));
  const boost=units[0];assert.equal(boost.effect,'set-attribute');if(boost.effect!=='set-attribute')throw new Error('missing fire preparation');
  assert.equal(boost.attribute,'fireSplashChance');
  assert.deepEqual(boost.ranks,[56,70,84,98,105,112,119,126].map(amount=>({kind:'add',amount})));
  assert.deepEqual(damage.ranks.map((_,i)=>actionDamage(damage,i+1,{physicalAttack:100,magicAttack:137,bestNormalDamage:137,
    maxHealth:1000,primaryAttributes:{...primary,strength:3,intelligence:4}})),[360,388,417,446,460,475,489,504]);
  assert.deepEqual(skill.ranks.map(rank=>rank.manaCost),Array(8).fill(52));
  const clips=catalog.classes.find(entry=>entry.id==='dark-knight')!.actor.clips;
  for(const direction of ['south','west','north','east'] as const)assert.equal(clips[`skill-firestorm-${direction}`]!.frames,19);
});

test('Firestorm needs a visible enemy and approaches before facing, spending mana, and playing',()=>{
  assert.equal(action.requiresTarget,true);assert.equal(action.approachDistanceUnits,4);
  const empty=fixture();assert.equal(empty.start(),'no-target');assert.deepEqual(empty.counts(),{spent:0,moves:0,turns:0});
  const far=actor('far',200),run=fixture([far]);assert.equal(run.start('far'),'started');
  assert.equal(run.combat.snapshot().state,'approaching');assert.equal(run.counts().spent,0);assert.equal(run.playback(),undefined);
  assert.ok(run.counts().moves>0);far.position.x=16;run.combat.update();
  assert.equal(run.combat.snapshot().state,'attacking');assert.equal(run.counts().spent,52);
  assert.equal(run.playback()!.facing,'east');assert.deepEqual(run.order,['effect:firestorm-swing']);
});

test('the main area uses octagonal foot distance at 47/48 and diagonal boundaries',()=>{
  const caster=actor('caster',0,0,'party'),targets=[actor('axis-in',47),actor('axis-out',48),actor('diagonal-in',34,34),actor('diagonal-out',35,34)];
  targets[1].bounds={x:-100,y:-100,width:200,height:200};
  assert.deepEqual(event.cues.map(cue=>cue.target),['self','area','self']);
  assert.equal(event.cues[1].targetRangeMetric,'octagonal-grid');assert.equal(event.cues[1].targetRangePx,40);
  assert.deepEqual(resolveCueTargets(event.cues[1],caster,targets[1],targets).map(target=>target.id),['axis-in','diagonal-in']);
});

test('sixteen main targets do not consume the separate caster set and clear slots',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const valid=Array.from({length:17},(_,index)=>actor(`enemy-${index}`));
  const run=fixture([actor('far',48),{...actor('hidden'),states:['stealthed']},actor('friendly',16,0,'party'),...valid]);
  assert.equal(run.start(valid[0].id),'started');run.frame(10);assert.equal(run.attempts.length,0);
  run.frame(11);
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'caster'],...valid.slice(0,16).map(target=>[1,target.id]),[2,'caster']]);
  assert.equal(run.conditions.cachedAttribute('caster','fireSplashChance'),undefined);
  assert.equal(run.feedback.length,1);assert.equal(run.order.at(-1),'feedback');
});

test('all failed or vanished targets still clear the temporary chance before the ordered feedback',()=>{
  for(const removed of [false,true]){
    const target=actor('immune'),run=fixture([target]);run.conditions.applyState('immune','damage-immune',1000);
    assert.equal(run.start('immune'),'started');
    if(removed){run.actors.delete('immune');run.combat.targetRemoved('immune');}
    run.frame(11);
    assert.deepEqual(run.prepared,[0,1,2]);assert.equal(run.hits.length,0);assert.deepEqual(run.attempts.filter(hit=>hit.targetId==='caster').map(hit=>hit.cueIndex),[0,2]);
    assert.equal(run.conditions.cachedAttribute('caster','fireSplashChance'),undefined);
    assert.deepEqual(run.feedback,[{breaksStealth:true,shake:true,vibrationMs:150,sound:'Bn_Flame_Storm'}]);
    assert.deepEqual(run.order.slice(-2),['unit:2:caster','feedback']);run.frame(11);run.frame(18);assert.equal(run.feedback.length,1);
  }
  const noMana=fixture([actor('enemy')]);noMana.affordable(false);assert.equal(noMana.start('enemy'),'no-mana');
  assert.equal(noMana.counts().spent,0);assert.deepEqual(noMana.order,[]);
});


test('the real dispatch freezes rank and weighted stats per unit while reading the changed damage source for later targets',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture([actor('first'),actor('second')]),chances:number[]=[];
  run.member.panel.attributes.strength=10;run.member.panel.attributes.intelligence=20;
  assert.equal(run.start('first'),'started');
  run.playback()!.skill!.level=2;
  run.afterHit(hit=>{
    chances.push(run.conditions.attribute('caster','fireSplashChance',0));
    if(hit.targetId!=='first')return;
    run.playback()!.skill!.level=8;
    run.member.panel.attributes.strength=100;run.member.panel.attributes.intelligence=100;
    run.conditions.applyBuff('caster','dark-strike',1,{durationMs:1000,tickMs:0,states:[],periodic:[],
      modifiers:[{attribute:'physicalAttack',operation:{kind:'add',amount:600}}]});
  });
  run.frame(11);
  assert.deepEqual(run.hits.map(({event,hit})=>[event.targetId,hit.damage]),[['first',909],['second',2254]]);
  assert.deepEqual(chances,[70,70]);
  assert.deepEqual(run.attempts.map(hit=>hit.skill.level),[2,2,2,2]);
  const mainHits=run.attempts.filter(hit=>hit.cueIndex===1);
  assert.equal(mainHits[0].preparedDamage?.weightedAddition,34);
  assert.strictEqual(mainHits[0].preparedDamage,mainHits[1].preparedDamage);
  assert.equal(run.conditions.cachedAttribute('caster','fireSplashChance'),undefined);
});
