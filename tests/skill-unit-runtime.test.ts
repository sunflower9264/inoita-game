import {dispatchFrame} from './support/combat-driver.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,SkillAction,SkillEffectCue} from '../src/domain/battle.ts';
import {CombatController} from '../src/domain/combat.ts';
import type {ActionPlayback,Combatant,CombatPort,SkillUnitHit} from '../src/domain/combat.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {executeSkillUnits} from '../src/domain/combat-unit-execution.ts';
import type {SkillUnitOutcome} from '../src/domain/skill-unit-sequence.ts';
import type {Point} from '../src/domain/navigation.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{}}',shortCircuit:true}:next(specifier,context);
}});
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');phaser.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const clone=(id:string)=>structuredClone(catalog.skills[id].action!);
const cue=(target:SkillEffectCue['target'],selection:SkillEffectCue['targetSelection']='search'):SkillEffectCue=>({
  target,targetSelection:selection,targetRangePx:100,effects:[{effect:'unit-flash',placement:'attached',recipient:'target'}],
});
function simple(cues:SkillEffectCue[]):SkillAction {
  return {requiresTarget:cues.some(cue=>cue.target==='current'),cooldownFrames:0,approachDistanceUnits:4,searchRadiusPx:100,transition:null,
    combatUnits:cues.map(()=>({effect:'visual'})),events:[{kind:'units',frame:1,cues}]};
}

test('only healing target selection builds healing candidates',()=>{
  const caster:Combatant={id:'caster',team:'party',position:{x:0,y:0},bounds:{x:0,y:0,width:8,height:8}};
  const enemy:Combatant={...caster,id:'enemy',team:'enemy'};
  const cues=[cue('self'),cue('area'),cue('ally-heal')],action=simple(cues);
  let calls=0;
  executeSkillUnits({casterId:'caster',skill:{id:'test',action},cues,selectedTargetId:'enemy'},
    {actor:id=>id==='caster'?caster:enemy,candidates:()=>[caster,enemy],healCandidates:()=>{calls++;return [];},unit:()=> 'success'});
  assert.equal(calls,1);
});

function fixture(action:SkillAction){
  const caster:Combatant={id:'caster',team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}};
  const enemy:Combatant={...caster,id:'enemy',team:'enemy',position:{x:16,y:0}};
  const other:Combatant={...enemy,id:'other',position:{x:24,y:0}};
  const actors=new Map([caster,enemy,other].map(actor=>[actor.id,actor]));
  const order:string[]=[],attempts:SkillUnitHit[]=[],arrivals:((center?:Point)=>void)[]=[];
  let resolve:(hit:SkillUnitHit)=>SkillUnitOutcome=()=> 'success';
  let frame:(index:number)=>void=()=>{},finish=()=>{};
  let playback:ActionPlayback|undefined;
  const resolution=new CombatHitResolution();
  const presenter=Object.setPrototypeOf({
    pose:()=>{},candidates:()=>[...actors.values()],
    visual:(id:string)=>actors.has(id)?{container:{active:true,...actors.get(id)!.position}}:undefined,
    visualEffect:(effect:{effect:string},_variant:string,actor:Combatant)=>order.push(`fx:${effect.effect}:${actor.id}`),
    placedEffect:(name:string)=>order.push(`world-fx:${name}`),
    transition:(_transition:unknown,_target:unknown,_position:unknown,_facing:unknown,arrive:(center?:Point)=>void)=>arrivals.push(arrive),
  },CombatPresenter.prototype) as InstanceType<typeof CombatPresenter>;
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor(caster.id),
    actor:id=>actors.get(id),candidates:()=>[...actors.values()],facing:()=> 'east',
    moveToward:()=>{},stop:()=>{},canStand:()=>true,relocate:()=>{},clearEffects:()=>{},
    play:(current,onFrame,onFinish)=>{playback=current;frame=onFrame;finish=onFinish;return ()=>{};},
    frame:(current,index,contact,ready)=>dispatchFrame(presenter,current,index,contact,ready),
    unit:hit=>{attempts.push(hit);order.push(`unit:${hit.cueIndex}:${hit.targetId}`);return resolve(hit);},
    runUnitSequence:work=>resolution.run(work),
    unitFeedback:(hit,outcome,visual)=>presenter.showUnitFeedback(hit,outcome,visual),
    contact:hit=>order.push(`contact:${hit.targetId}`),
  };
  const combat=new CombatController(caster.id,null,port);
  return {combat,port,presenter,actors,order,attempts,arrivals,resolution,
    start:()=>combat.request({id:'tested-skill',action,level:1},enemy.id),frame:(index:number)=>frame(index),finish:()=>finish(),
    playback:()=>playback!,resolve:(fn:typeof resolve)=>{resolve=fn;}};
}

test('the real presenter dispatches direct units before their visuals and later caster effects',()=>{
  const action=simple([cue('current'),cue('self')]);
  action.events.push({kind:'caster',frame:1,effects:[{effect:'cast-ring',placement:'attached',recipient:'caster'}]});
  const run=fixture(action);assert.equal(run.start(),'started');run.frame(1);
  assert.deepEqual(run.order,[
    'unit:0:enemy','fx:unit-flash:enemy','contact:enemy',
    'unit:1:caster','fx:unit-flash:caster','fx:cast-ring:caster',
  ]);
});

test('dark strike failure suppresses enemy unit effects while its self buff still executes',()=>{
  const action=clone('dark-strike');const run=fixture(action);
  run.resolve(hit=>hit.cueIndex===0?'failure':'success');
  run.start();run.frame(action.events.find(event=>event.kind==='units')!.frame);
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'enemy'],[2,'caster']]);
  assert.equal(run.order.some(entry=>entry.startsWith('fx:')&&entry.endsWith(':enemy')),false);
});

test('a failed area target is skipped for later debuff and taunt while another target continues',()=>{
  const action=clone('curse-of-screams');const run=fixture(action);
  run.resolve(hit=>hit.cueIndex===0&&hit.targetId==='enemy'?'failure':'success');
  run.start();run.frame(action.events.find(event=>event.kind==='units')!.frame);
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[
    [0,'enemy'],[0,'other'],[1,'other'],[2,'other'],
  ]);
});

test('explicit target reuse survives invisibility until the next search cue',()=>{
  const run=fixture(simple([cue('current'),cue('current','reuse-previous'),cue('current')]));
  run.resolve(hit=>{if(hit.cueIndex===0)run.actors.get('enemy')!.states=['stealthed'];return 'success';});
  run.start();run.frame(1);
  assert.deepEqual(run.attempts.map(hit=>hit.cueIndex),[0,1]);
});

test('reuse follows the exported selection decision even when range or target labels change',()=>{
  const second={...cue('self','reuse-previous'),targetRangePx:0};
  const run=fixture(simple([cue('area'),second,cue('self')]));
  run.start();run.frame(1);
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[
    [0,'enemy'],[0,'other'],[1,'enemy'],[1,'other'],[2,'caster'],
  ]);
});

test('a cached target that leaves the battle is skipped before calling the unit host',()=>{
  const run=fixture(simple([cue('current'),cue('current','reuse-previous')]));
  run.resolve(()=>{run.actors.delete('enemy');return 'success';});
  run.start();run.frame(1);
  assert.deepEqual(run.attempts.map(hit=>hit.cueIndex),[0]);
});

test('stationary phantom arrival resolves all units together after the cast has ended',()=>{
  const action=clone('phantom-clash');const run=fixture(action);
  run.start();run.frame(action.events.find(event=>event.kind==='units')!.frame);
  assert.equal(run.arrivals.length,1);assert.equal(run.attempts.length,0);
  run.finish();run.arrivals[0]({x:16,y:0});run.arrivals[0]({x:16,y:0});
  assert.deepEqual(run.attempts.map(hit=>hit.cueIndex),[0,1,2]);
  assert.equal(run.order.filter(entry=>entry==='contact:enemy').length,3);
});

test('two captured arrivals in one frame have separate failure histories',()=>{
  const action=simple([cue('area'),cue('area','reuse-previous')]);
  action.transition={kind:'position',effect:'projectile',actionEffect:null,switchFrame:1,stepDistancePx:1,offsetX:0,offsetY:0};
  action.events.unshift({kind:'capture-targets',frame:0,target:'area',targetRangePx:100,limit:16});
  const run=fixture(action);run.start();run.frame(1);
  assert.equal(run.arrivals.length,2);
  run.resolve(()=> 'failure');run.arrivals[0]({x:16,y:0});
  assert.equal(run.attempts.length,2);
  run.resolve(()=> 'success');run.arrivals[1]({x:24,y:0});
  assert.equal(run.attempts.length,6);
});

test('failure visuals require the explicit policy and skipped units remain silent',()=>{
  const first={...cue('current'),unitFeedbackPolicy:'always' as const};
  const action=simple([first,{...first,targetSelection:'reuse-previous'}]);
  const run=fixture(action);run.resolve(()=> 'failure');run.start();run.frame(1);
  assert.equal(run.attempts.length,1);
  assert.deepEqual(run.order.filter(entry=>entry.startsWith('fx:')),['fx:unit-flash:enemy']);
});

test('empty transition targets retain the exported landing visual',()=>{
  const action=simple([cue('current')]);
  action.transition={kind:'position',effect:'projectile',actionEffect:null,switchFrame:1,stepDistancePx:1,
    offsetX:0,offsetY:0,missEffects:[{effect:'meteor-ground',placement:'ground',recipient:'target'}]};
  const run=fixture(action);run.start();run.frame(1);run.actors.delete('enemy');run.arrivals[0]({x:16,y:0});
  run.arrivals[0]({x:16,y:0});
  assert.deepEqual(run.order,['world-fx:meteor-ground']);
});

test('the controller wraps every unit and its feedback in one final health check',()=>{
  const run=fixture(simple([cue('self'),cue('self','reuse-previous')]));let health=10;
  run.resolve(hit=>{
    if(hit.cueIndex===0){
      health=0;run.resolution.deferDefeat('caster',()=>run.order.push(health>0?'saved':'defeated'));
    }else{
      assert.equal(run.resolution.isAwaitingDefeat('caster'),true);health=10;
    }
    return 'success';
  });
  run.start();run.frame(1);
  assert.deepEqual(run.order,['unit:0:caster','fx:unit-flash:caster','unit:1:caster','fx:unit-flash:caster','saved']);
});
