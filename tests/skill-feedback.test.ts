import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {ActionPlayback} from '../src/domain/combat.ts';
import type {SkillFeedbackEvent,BattleCatalog,SkillAction} from '../src/domain/battle.ts';
import type {CombatFeedbackSelection} from '../src/domain/combat-feedback.ts';
import {displaySettings} from '../src/application/display-settings.ts';
import {skillEffectNames,skillSoundNames} from '../src/domain/skill-action.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatFeedback}=await import('../src/rendering/combat-feedback.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

test('the real party frame port plays explicit sound for the hero and mercenaries after units',()=>{
  const order:string[]=[],event:SkillFeedbackEvent={kind:'feedback',frame:10,shake:true,vibrationMs:300,sound:'Bn_Hell_Sword'};
  const action:ActionPlayback={caster:{id:'player',team:'party',position:{x:0,y:0},bounds:{x:0,y:0,width:8,height:8}},
    facing:'south',basicAttack:null,skill:{id:'sword-of-hell',action:{...catalog.skills['sword-of-hell'].action!,
      events:[{kind:'units',frame:10,cues:[]},event]}}};
  const host=Object.setPrototypeOf({presentActionFrame:(presenter:object,...args:Parameters<typeof dispatchFrame> extends [object,...infer Rest]?Rest:never)=>dispatchFrame(presenter,...args),scene:{refreshCombatTarget:()=>{},refreshSkillCooldowns:()=>{}},
    app:{session:{cooldowns:new CombatCooldownStore(()=>0)},audio:{playerSkill:()=>order.push('automatic-sound'),effect:(name:string)=>order.push(name)}},
    feedback:{startShake:()=>order.push('shake'),vibrate:(ms:number)=>order.push(`vibrate:${ms}`)},partyControllers:new Map(),soundedSkills:new WeakSet(),
    memberOf:(id:string)=>id==='player'||id==='companion'?{id}:undefined,
  },WorldCombat.prototype);
  const presenter={pose:()=>{}};
  const {port}=Reflect.get(WorldCombat.prototype,'createPartyController').call(host,'player',{},presenter,null);
  port.frame(action,10,()=>{},()=>{order.push('units');return [];});
  assert.deepEqual(order,['units','shake','vibrate:300','Bn_Hell_Sword']);
  assert.deepEqual(skillEffectNames(action.skill!.action),[]);
  order.length=0;action.caster.id='companion';port.frame(action,10,()=>{},()=>{order.push('units');return [];});
  assert.deepEqual(order,['units','shake','vibrate:300','Bn_Hell_Sword']);
});

test('mercenary basic attacks use their own weapon sound instead of staying silent',()=>{
  const calls:string[][]=[];
  const host=Object.setPrototypeOf({
    controlledId:'player',arena:[{key:'enemy-x',definition:{id:'enemy-x'}}],
    memberOf:(id:string)=>id==='player'||id==='companion'?{id}:undefined,
    hero:{bag:{equipmentFor:(owner:string)=>owner==='companion'?{'main-hand':'companion-weapon'}:{},
      equipmentItems:()=>({'main-hand':'companion-weapon'})}},
    app:{items:{items:{'companion-weapon':{kind:'sword'}}},battleCatalog:catalog,
      audio:{playerHit:(...args:string[])=>calls.push(args),monsterAttack:()=>calls.push(['monster'])}},
    visualOf:()=>({container:{active:true}}),feedback:{show:()=>{}},statusColors:{flash:()=>{}},
    scene:{events:{emit:()=>{}}},
  },WorldCombat.prototype);
  Reflect.get(WorldCombat.prototype,'showHit').call(host,
    {casterId:'companion',targetId:'enemy-x'},{kind:'hit',damage:1},{sound:true});
  assert.deepEqual(calls,[['sword','hit','enemy-x']]);
});

test('world hit feedback follows the critical decoration preference',t=>{
  displaySettings.setCriticalDecorations(false);
  t.after(()=>displaySettings.setCriticalDecorations(true));
  const shown:CombatFeedbackSelection[]=[];let flashes=0;
  const host=Object.setPrototypeOf({
    controlledId:'player',arena:[{key:'enemy-x',definition:{id:'enemy-x'}}],
    memberOf:(id:string)=>id==='player'?{id}:undefined,
    hero:{bag:{equipmentFor:()=>({}),equipmentItems:()=>({})}},
    app:{items:{items:{}},battleCatalog:catalog,audio:{playerHit:()=>{},monsterAttack:()=>{}}},
    visualOf:()=>({container:{active:true}}),
    feedback:{show:(_event:unknown,_target:unknown,selection:CombatFeedbackSelection)=>shown.push(selection)},
    statusColors:{flash:()=>{flashes++;}},
    scene:{events:{emit:()=>{}}},
  },WorldCombat.prototype);
  const hit={casterId:'player',targetId:'enemy-x'},show=()=>Reflect.get(WorldCombat.prototype,'showHit').call(host,hit,
    {kind:'critical',damage:10},{sound:true});
  show();
  assert.equal(flashes,1);
  assert.deepEqual(shown[0]!.impacts,[{name:catalog.feedback.criticalImpact,attached:true}]);
  assert.equal(shown[0]!.digitEffect,catalog.feedback.digits.enemyCritical[0]);
  displaySettings.setCriticalDecorations(true);
  show();
  const names=shown[1]!.impacts.map(effect=>effect.name);
  assert.deepEqual(names.slice(0,2),[catalog.feedback.criticalImpact,catalog.feedback.criticalRing]);
  assert.equal(names.length,3);
  assert.ok(catalog.feedback.criticalBursts.includes(names[2]!));
});

test('skill camera feedback reuses all six native world-pixel offsets and resets cleanly on restart',()=>{
  const offsets=catalog.feedback.shakeOffsets,values:{x:number;y:number}[]=[];
  const camera={followOffset:{x:2,y:3},setFollowOffset(x:number,y:number){this.followOffset={x,y};values.push({x,y});}};
  let tween:{targets:{step:number};step:number;duration:number;onUpdate:()=>void;onComplete:()=>void}|undefined,stops=0;
  const feedback=Object.setPrototypeOf({catalog,visible:true,paused:false,scene:{cameras:{main:camera},tweens:{add:(config:typeof tween)=>{
    tween=config;return {stop:()=>stops++};
  }}}},CombatFeedback.prototype);
  feedback.startShake();assert.equal(tween!.duration,360);
  for(let step=1;step<6;step++){tween!.targets.step=step;tween!.onUpdate();}
  assert.deepEqual(values,offsets.map(offset=>({x:2-offset.x,y:3-offset.y})));
  tween!.onComplete();assert.deepEqual(camera.followOffset,{x:2,y:3});
  feedback.startShake();feedback.startShake();assert.deepEqual(camera.followOffset,{x:8,y:9});
  feedback.cancelShake();assert.deepEqual(camera.followOffset,{x:2,y:3});assert.equal(stops,3);
});

test('device vibration respects the native disabled default and tolerates unsupported browsers',()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'navigator'),calls:number[]=[];
  try{
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{vibrate:(ms:number)=>{calls.push(ms);return true;}}});
    const feedback=Object.setPrototypeOf({visible:true,vibrationEnabled:false},CombatFeedback.prototype);
    feedback.vibrate(300);assert.deepEqual(calls,[]);
    feedback.vibrationEnabled=true;feedback.vibrate(300);assert.deepEqual(calls,[300]);
    feedback.visible=false;feedback.vibrate(300);assert.deepEqual(calls,[300]);
    feedback.visible=true;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
    assert.doesNotThrow(()=>feedback.vibrate(300));
  }finally{
    if(original)Object.defineProperty(globalThis,'navigator',original);else Reflect.deleteProperty(globalThis,'navigator');
  }
});

test('技能动作音效遍历取到动作单元与派发收尾两类触发点',()=>{
  assert.deepEqual(skillSoundNames(catalog.skills['divine-strike'].action!),['A_Skill_Attack01','A_Skill_05']);
  assert.deepEqual(skillSoundNames(catalog.skills['dark-strike'].action!),['Wa_Titan_Attack']);
  const feedback:SkillAction={...catalog.skills['divine-strike'].action!,
    events:[{kind:'feedback',frame:4,sound:'Bn_Hell_Sword'}]};
  assert.deepEqual(skillSoundNames(feedback),['Bn_Hell_Sword']);
  assert.deepEqual(skillSoundNames({...feedback,events:[]}),[]);
});
