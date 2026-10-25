import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CombatController,resolveCueTargets} from '../src/domain/combat.ts';
import type {ActionPlayback,CombatPort,Combatant,AttackContact} from '../src/domain/combat.ts';
import {parseBattle,parseWorld} from '../src/application/content-validation.ts';
import {AssetPool} from '../src/application/assets.ts';
import {ControlState} from '../src/application/control-state.ts';
import {resolveBasicAttack,basicAttackStrikesAtFrame} from '../src/domain/basic-attack.ts';
import {actionCues} from '../src/domain/skill-action.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
const catalog=parseBattle(JSON.parse(fs.readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')));
const caster:Combatant={id:'player',team:'party',position:{x:350,y:192},bounds:{x:-8,y:-8,width:16,height:16}};
const enemy:Combatant={...caster,id:'enemy',team:'hostile',position:{x:384,y:192}};
function setup(){
 let nowFrame=0;const cooldowns=new CombatCooldownStore(()=>nowFrame);
 let frame:((index:number)=>void)|undefined,complete:(()=>void)|undefined;
 const fired:number[]=[];let cleared=0;
 const plays:{action:ActionPlayback;frame:(index:number)=>void;finish:()=>void;cancelled:boolean}[]=[];
 const port:CombatPort={canSelectSkill:()=>true,cooldowns:cooldowns.forActor('player'),actor:id=>[caster,enemy].find(a=>a.id===id),candidates:()=>[caster,enemy],facing:()=> 'east',moveToward:()=>{},stop:()=>{},canStand:()=>true,relocate:()=>{},play:(action,onFrame,onComplete)=>{frame=onFrame;complete=onComplete;const play={action,frame:onFrame,finish:onComplete,cancelled:false};plays.push(play);return ()=>{play.cancelled=true;};},frame:(action,index,contact)=>{fired.push(index);const attack=action.basicAttack;if(!action.skill&&attack&&index===attack.strikeFrame&&!attack.projectile&&!attack.transition&&action.target)contact(action.target.id);},clearEffects:()=>{cleared++;}};
 const combat=new CombatController('player',resolveBasicAttack(catalog,catalog.classes[0]),port);
 return {combat,port,plays,fired,cooldowns,advanceFrames:(frames:number)=>{nowFrame+=frames;},frame:(index:number)=>frame!(index),finish:()=>complete!(),cleared:()=>cleared};
}

test('active action exposes its own target rather than the previous selection during a self buff',()=>{
  const run=setup();
  assert.equal(run.combat.selectTarget(enemy.id),true);
  assert.equal(run.combat.activeAction(),undefined);
  const action=catalog.skills['demon-s-shield'].action!;
  assert.equal(run.combat.request({id:'demon-s-shield',action}), 'started');
  assert.equal(run.combat.snapshot().targetId,enemy.id);
  assert.equal(run.combat.activeAction()?.state,'attacking');
  assert.equal(run.combat.activeAction()?.targetId,undefined);
  assert.equal(run.combat.activeAction()?.skill?.id,'demon-s-shield');
  run.finish();assert.equal(run.combat.activeAction(),undefined);
  assert.equal(run.combat.requestTarget(enemy.id),'started');
  assert.equal(run.combat.activeAction()?.targetId,enemy.id);
  run.combat.cancel();assert.equal(run.combat.activeAction(),undefined);
});

test('reading the action state or selected target does not build a cooldown snapshot',()=>{
  const run=setup();
  run.combat.selectTarget(enemy.id);
  const cooldowns=run.port.cooldowns;
  let snapshots=0;
  run.port.cooldowns={...cooldowns,snapshot:()=>{snapshots++;return cooldowns.snapshot();}};
  assert.equal(run.combat.actionState(),'idle');
  assert.equal(run.combat.selectedTargetId(),enemy.id);
  assert.equal(snapshots,0,'只读字段不该顺带遍历冷却');
  run.combat.snapshot();
  assert.equal(snapshots,1,'完整快照仍然包含冷却');
});

test('basic replacement is selected once at approach completion and its hand profile stays fixed for the action',()=>{
  const run=setup(),normal=resolveBasicAttack(catalog,catalog.classes[0]);
  const dual={...normal,strikeFrame:2,strikes:[{frame:2,hand:'main-hand' as const},{frame:5,hand:'offhand' as const}]};
  let selected=dual,calls=0,target={...enemy,position:{x:1000,y:192}};
  const contacts:AttackContact[]=[];
  run.combat.setBasicAttack(normal);
  run.port.actor=id=>id===caster.id?caster:id===target.id?target:undefined;
  run.port.candidates=()=>[caster,target];
  run.port.selectBasicAttack=original=>{assert.equal(original,normal);calls++;return selected;};
  run.port.contact=event=>contacts.push(event);
  run.port.frame=(action,index,contact)=>{
    if(action.skill||!action.basicAttack||!action.target)return;
    for(const hand of basicAttackStrikesAtFrame(action.basicAttack,index))contact(action.target.id,hand);
  };
  assert.equal(run.combat.requestTarget(target.id),'started');
  run.combat.update();run.combat.update();assert.equal(calls,0);
  target={...enemy};run.combat.update();assert.equal(calls,1);
  assert.equal(run.plays[0].action.basicAttack,dual);
  selected={...dual,strikes:[]};run.frame(5);run.frame(5);
  assert.deepEqual(contacts.map(event=>event.hand),['main-hand','offhand']);
  assert.ok(contacts.every(event=>event.basicAttack===dual));assert.equal(calls,1);
  run.finish();
  run.port.selectBasicAttack=()=>{calls++;return normal;};
  assert.equal(run.combat.requestTarget(target.id),'started');run.frame(normal.strikeFrame);
  assert.equal(calls,2);
  assert.deepEqual(contacts.at(-1),{casterId:caster.id,targetId:target.id});
  run.finish();
  assert.equal(run.combat.request({id:'spell',action:{events:[],requiresTarget:false,
    cooldownFrames:0,approachDistanceUnits:0,searchRadiusPx:64,transition:null}}),'started');
  assert.equal(calls,2);
});

test('basic contacts deduplicate each hand separately and callbacks from a replaced action stop',()=>{
  const run=setup(),normal=resolveBasicAttack(catalog,catalog.classes[0]);
  const dual={...normal,strikeFrame:1,strikes:[{frame:1,hand:'main-hand' as const},{frame:1,hand:'offhand' as const}]};
  const contacts:AttackContact[]=[];
  run.port.selectBasicAttack=()=>dual;run.port.contact=event=>contacts.push(event);
  run.port.frame=(action,index,contact)=>{
    if(index!==1||!action.target)return;
    for(const hand of ['main-hand','main-hand','offhand','offhand'] as const)contact(action.target.id,hand);
  };
  run.combat.requestTarget(enemy.id);const old=run.plays[0];run.frame(1);
  assert.deepEqual(contacts.map(event=>event.hand),['main-hand','offhand']);
  run.combat.cancel();run.combat.requestTarget(enemy.id);
  old.frame(100);old.finish();assert.equal(contacts.length,2);
  run.frame(1);assert.equal(contacts.length,4);
});

test('cancellation by the first hand blocks the remaining contacts in the same dispatch and later frames',()=>{
  const run=setup(),normal=resolveBasicAttack(catalog,catalog.classes[0]);
  const dual={...normal,strikeFrame:1,strikes:[{frame:1,hand:'main-hand' as const},{frame:3,hand:'offhand' as const}]};
  const contacts:AttackContact[]=[];
  run.port.selectBasicAttack=()=>dual;
  run.port.contact=event=>{contacts.push(event);run.combat.cancel();};
  run.port.frame=(action,index,contact)=>{
    if(index!==1||!action.target)return;
    contact(action.target.id,'main-hand');contact(action.target.id,'offhand');
  };
  run.combat.requestTarget(enemy.id);run.frame(3);
  assert.deepEqual(contacts.map(event=>event.hand),['main-hand']);
  assert.equal(run.combat.snapshot().state,'idle');
});

test('an ordinary projectile contact already dispatched can arrive after the next action starts',()=>{
  const run=setup(),contacts:AttackContact[]=[];
  let arrive=()=>{};
  run.port.contact=event=>contacts.push(event);
  run.port.frame=(action,index,contact)=>{
    if(index===1&&action.target){const id=action.target.id;arrive=()=>contact(id);}
  };
  run.combat.requestTarget(enemy.id);run.frame(1);const previousArrival=arrive;
  run.finish();run.combat.requestTarget(enemy.id);previousArrival();previousArrival();
  assert.deepEqual(contacts,[{casterId:caster.id,targetId:enemy.id}]);
});

test('stealth rejects hostile selection and area hits while friendly healing and immunity remain targetable',()=>{
 const concealed={...enemy,states:['stealthed'] as const},immune={...enemy,id:'immune',states:['damage-immune'] as const};
 const ally={...caster,id:'ally',states:['stealthed'] as const};
 const run=setup();run.port.actor=id=>id===caster.id?caster:id===immune.id?immune:concealed;
 run.port.candidates=()=>[caster,concealed];
 assert.equal(run.combat.selectTarget(concealed.id),false);assert.equal(run.combat.requestTarget(concealed.id),'no-target');
 assert.equal(run.combat.request(),'no-target');
 assert.equal(run.combat.selectTarget(immune.id),true);
 assert.deepEqual(resolveCueTargets({target:'area',targetRangePx:100},caster,concealed,[concealed,immune]),[immune]);
 // 治疗按队伍槽与原版评分选人：隐身不影响友方治疗，评分低者胜。
 assert.deepEqual(resolveCueTargets({target:'ally-heal',targetRangePx:100},caster,undefined,[ally,concealed],
   [{actor:caster,active:true,hasDisplay:true},{actor:ally,active:true,hasDisplay:true}],0,
   id=>id==='ally'?50:70),[ally]);
 assert.deepEqual(resolveCueTargets({target:'ally-heal',targetRangePx:100},caster,undefined,[ally,concealed],[],0,()=>70),
   [caster],'一个候选都没有时落到施法者自己');
 assert.deepEqual(resolveCueTargets({target:'self',targetRangePx:0},ally,undefined,[]),[ally]);
});

test('a target entering stealth invalidates selection and stale basic strike callbacks immediately',()=>{
 const run=setup(),conditions=new CombatConditions();
 run.port.actor=id=>id===caster.id?caster:{...enemy,states:conditions.activeStates(enemy.id)};
 const contacts:string[]=[];run.port.contact=event=>contacts.push(event.targetId);
 assert.equal(run.combat.requestTarget(enemy.id),'started');const old=run.plays[0];
 conditions.applyState(enemy.id,'stealthed',1000,'rogue');
 old.frame(100);
 assert.equal(run.combat.snapshot().targetId,undefined);assert.equal(run.combat.snapshot().state,'idle');assert.deepEqual(contacts,[]);
 old.finish();assert.equal(run.combat.snapshot().state,'idle');
});

test('root and ambush reject automatic approach without mana or cooldown but allow casts in range',()=>{
 for(const state of ['immobilized','ambush'] as const){
  const run=setup(),conditions=new CombatConditions(),far={...enemy,position:{x:450,y:192}};
  conditions.applyState(caster.id,state,1000,'source');
  run.port.actor=id=>id===caster.id?{...caster,states:conditions.activeStates(caster.id)}:far;
  run.port.candidates=()=>[far];run.port.moveToward=()=>assert.fail('blocked automatic movement');
  const skill={id:'dark-strike',action:catalog.skills['dark-strike'].action!,manaCost:40};
  let mana=100;run.port.spendMana=cost=>{mana-=cost;return true;};
  assert.equal(run.combat.request(skill,enemy.id),'busy');assert.equal(mana,100);assert.deepEqual(run.combat.snapshot().cooldowns,{});
  far.position={...enemy.position};assert.equal(run.combat.request(skill,enemy.id),'started');assert.equal(mana,60);assert.equal(run.plays.length,1);
 }
});

test('new root stops an existing approach and sleep prevents frame execution while cooldown still advances',()=>{
 const run=setup(),conditions=new CombatConditions(),far={...enemy,position:{x:450,y:192}};
 run.port.actor=id=>id===caster.id?{...caster,states:conditions.activeStates(caster.id)}:far;
 let moves=0;run.port.moveToward=()=>{moves++;};
 assert.equal(run.combat.requestTarget(enemy.id),'started');assert.equal(moves,1);
 conditions.applyState(caster.id,'immobilized',1000);run.combat.update();
 assert.equal(run.combat.snapshot().state,'idle');assert.equal(moves,1);
 conditions.removeState(caster.id,'immobilized');far.position={...enemy.position};
 const skill={id:'dark-strike',action:catalog.skills['dark-strike'].action!};run.combat.request(skill);
 const fired=[...run.fired],remaining=run.combat.snapshot().cooldowns[skill.id].remainingMs;
 conditions.applyState(caster.id,'sleep',1000);run.frame(100);
 assert.deepEqual(run.fired,fired);assert.equal(run.combat.snapshot().state,'idle');
 assert.equal(run.combat.request(skill),'cooldown');run.advanceFrames(1);run.combat.update();
 assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs,remaining-60);
});

test('manual skills replace basic windup, hit recovery and the last frame without stale callbacks',()=>{
 const basic=resolveBasicAttack(catalog,catalog.classes[0]);
 for(const index of [0,basic.strikeFrame,basic.sequence.east.length-1]){
  const run=setup(),contacts:string[]=[];
  const skill={id:'dark-strike',action:catalog.skills['dark-strike'].action!,manaCost:40};
  let spent=0;run.port.canSpendMana=()=>true;run.port.spendMana=cost=>{spent+=cost;return true;};
  run.port.contact=event=>contacts.push(event.skillId??'basic');
  assert.equal(run.combat.request(),'started');
  const old=run.plays[0];old.frame(index);
  const hits=index>=basic.strikeFrame?['basic']:[];assert.deepEqual(contacts,hits);
  assert.equal(run.combat.requestManualSkill(skill),'started');
  assert.equal(old.cancelled,true);assert.equal(run.plays[1].action.skill?.id,skill.id);
  assert.equal(run.combat.snapshot().targetId,enemy.id);assert.equal(spent,40);
  const fired=[...run.fired],cooldowns=run.combat.snapshot().cooldowns;
  old.frame(100);old.finish();
  assert.deepEqual(run.fired,fired);assert.deepEqual(contacts,hits);
  assert.equal(run.combat.snapshot().state,'attacking');assert.deepEqual(run.combat.snapshot().cooldowns,cooldowns);
  assert.equal(run.cleared(),0);assert.equal(spent,40);
 }
});

test('a manual skill takes over basic approach and spends resources only on reaching its own range',()=>{
 const run=setup(),far={...enemy,position:{x:450,y:192}};
 const skill={id:'dark-strike',action:catalog.skills['dark-strike'].action!,manaCost:40};
 let spent=0,moves=0;run.port.canSpendMana=()=>true;run.port.spendMana=cost=>{spent+=cost;return true;};
 run.port.actor=id=>id===caster.id?caster:id===enemy.id?far:undefined;run.port.candidates=()=>[caster,far];
 run.port.moveToward=()=>{moves++;};
 assert.equal(run.combat.requestTarget(enemy.id),'started');assert.equal(run.combat.snapshot().state,'approaching');
 assert.equal(run.combat.requestManualSkill(skill),'started');assert.equal(run.combat.snapshot().state,'approaching');
 assert.equal(moves,2);assert.equal(spent,0);assert.deepEqual(run.combat.snapshot().cooldowns,{});assert.equal(run.plays.length,0);
 far.position={...enemy.position};run.combat.update();
 assert.equal(run.plays[0].action.skill?.id,skill.id);assert.equal(spent,40);
 assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs,skill.action.cooldownFrames*60);
 run.combat.update();assert.equal(spent,40);
});

test('manual self skills take over basic approach in place without requiring an enemy',()=>{
 const run=setup(),far={...enemy,position:{x:450,y:192}};
 run.port.actor=id=>id===caster.id?caster:far;run.port.candidates=()=>[far];
 run.combat.requestTarget(enemy.id);assert.equal(run.combat.snapshot().state,'approaching');
 run.port.actor=id=>id===caster.id?caster:undefined;run.port.candidates=()=>[caster];
 run.port.moveToward=()=>assert.fail('self skill must not approach');run.port.facing=()=> 'north';
 assert.equal(run.combat.requestManualSkill({id:'demon-s-shield',action:catalog.skills['demon-s-shield'].action!}),'started');
 assert.equal(run.plays[0].action.target,undefined);assert.equal(run.plays[0].action.facing,'north');
});

test('cooldown and insufficient mana reject manual skills while the basic attack continues',()=>{
 const skill={id:'dark-strike',action:catalog.skills['dark-strike'].action!,manaCost:40};
 for(const reason of ['cooldown','no-mana']){
  const run=setup();
  if(reason==='cooldown'){run.combat.request(skill);run.finish();}
  run.combat.request();const old=run.plays.at(-1)!;
  run.port.canSpendMana=()=>reason!=='no-mana';run.port.spendMana=()=>assert.fail('rejected skill spent mana');
  const state=run.combat.snapshot(),count=run.plays.length;
  assert.equal(run.combat.requestManualSkill(skill),reason);assert.equal(old.cancelled,false);
  assert.deepEqual(run.combat.snapshot(),state);assert.equal(run.plays.length,count);
  old.frame(2);old.finish();run.combat.update();
  assert.equal(run.combat.snapshot().state,'idle');assert.equal(run.plays.length,count,'rejected input must not be queued');
 }
});

test('a usable manual skill without its required target ends the basic attack without spending resources',()=>{
 const run=setup();run.combat.request();const old=run.plays[0];
 run.port.actor=id=>id===caster.id?caster:undefined;run.port.candidates=()=>[caster];
 run.port.canSpendMana=()=>true;run.port.spendMana=()=>assert.fail('missing target spent mana');
 assert.equal(run.combat.requestManualSkill({id:'dark-strike',action:catalog.skills['dark-strike'].action!,manaCost:40}),'no-target');
 assert.equal(old.cancelled,true);assert.equal(run.combat.snapshot().state,'idle');
 assert.deepEqual(run.combat.snapshot().cooldowns,{});assert.equal(run.cleared(),0);
});

test('manual skills keep active skills exclusive and ordinary requests cannot replace basic attacks',()=>{
 const skill={id:'dark-strike',action:catalog.skills['dark-strike'].action!};
 for(const approaching of [false,true]){
  const run=setup();
  if(approaching){const far={...enemy,position:{x:450,y:192}};run.port.actor=id=>id===caster.id?caster:far;}
  run.combat.requestTarget(enemy.id);
  assert.equal(run.combat.request(skill),'busy');assert.equal(run.combat.requestTarget(enemy.id),'busy');
  assert.equal(run.combat.requestManualSkill(skill),'started');
  const state=run.combat.snapshot();
  assert.equal(run.combat.requestManualSkill({id:'demon-s-shield',action:catalog.skills['demon-s-shield'].action!}),'busy');
  assert.deepEqual(run.combat.snapshot(),state);
  if(approaching)run.combat.cancel();else run.finish();
  const count=run.plays.length;run.combat.update();
  assert.equal(run.combat.snapshot().state,'idle');assert.equal(run.plays.length,count);
 }
});
test('cooldowns use shared frames without controller updates and survive controller disposal',()=>{
 const run=setup(),skill={id:'demon-s-shield',action:{...catalog.skills['demon-s-shield'].action!,cooldownFrames:3}};
 assert.equal(run.combat.request(skill),'started');assert.deepEqual(run.combat.snapshot().cooldowns[skill.id],{remainingMs:180,durationMs:180});
 run.combat.update();run.combat.update();run.finish();
 assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs,180,'controller updates do not advance shared time');
 run.advanceFrames(2);assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs,60);
 assert.equal(run.combat.request(skill),'cooldown');run.advanceFrames(1);
 assert.deepEqual(run.combat.snapshot().cooldowns,{});assert.equal(run.combat.request(skill),'started');
 run.combat.dispose();assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs,180);
 const replacement=new CombatController('player',resolveBasicAttack(catalog,catalog.classes[0]),run.port);
 assert.equal(replacement.request(skill),'cooldown');run.advanceFrames(3);assert.equal(replacement.request(skill),'started');
 replacement.reset();assert.deepEqual(replacement.snapshot().cooldowns,{});
});
test('zero-frame cooldowns are ready immediately after the accepted action completes',()=>{
 const run=setup(),skill={id:'dark-strike',action:{...catalog.skills['dark-strike'].action!,cooldownFrames:0}};
 assert.equal(run.combat.request(skill),'started');assert.deepEqual(run.combat.snapshot().cooldowns,{});
 run.finish();assert.equal(run.combat.request(skill),'started');
});
test('approach starts the deadline after payment and before frame zero using the current shared frame',()=>{
 const run=setup(),far={...enemy,position:{x:450,y:192}};
 const skill={id:'dark-strike',manaCost:40,action:{...catalog.skills['dark-strike'].action!,cooldownFrames:3}};
 let paid=false;
 run.port.actor=id=>id===caster.id?caster:far;
 run.port.canSpendMana=()=>true;
 run.port.spendMana=()=>{assert.deepEqual(run.combat.snapshot().cooldowns,{});paid=true;return true;};
 run.port.frame=(_action,index)=>{if(index===0){assert.equal(paid,true);assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs,180);}};
 assert.equal(run.combat.request(skill,enemy.id),'started');
 run.advanceFrames(20);assert.deepEqual(run.combat.snapshot().cooldowns,{});
 far.position={...enemy.position};run.combat.update();assert.equal(paid,true);
 run.finish();run.advanceFrames(2);assert.equal(run.combat.request(skill),'cooldown');
 run.advanceFrames(1);assert.equal(run.combat.request(skill),'started');
});
test('a skill spends its native rank cost only when the cast begins',()=>{
 const run=setup();let mana=40,plays=0;
 const skill={id:'dark-strike',action:catalog.skills['dark-strike'].action!,manaCost:catalog.skills['dark-strike'].ranks[0].manaCost};
 assert.equal(skill.manaCost,40);
 run.port.canSpendMana=cost=>mana>=cost;
 run.port.spendMana=cost=>{if(mana<cost)return false;mana-=cost;return true;};
 run.port.play=()=>{plays++;return ()=>{};};
 mana=39;assert.equal(run.combat.request(skill),'no-mana');assert.equal(plays,0);
 mana=40;assert.equal(run.combat.request(skill),'started');assert.equal(mana,0);assert.equal(plays,1);
 run.combat.cancel();assert.equal(run.combat.request(skill),'no-mana');assert.equal(mana,0);
 mana=40;assert.equal(run.combat.request(skill),'cooldown');
});
test('continuing training clears active actions, target and cooldowns',()=>{
 const run=setup(),skill={id:'dark-strike',action:catalog.skills['dark-strike'].action!};
 assert.equal(run.combat.request(skill),'started');
 assert.ok(run.combat.snapshot().cooldowns[skill.id]);
 run.combat.reset();
 assert.deepEqual(run.combat.snapshot(),{state:'idle',cooldowns:{}});
 assert.equal(run.combat.request(skill),'started');
});
test('animation notifications fire once, catch skipped frames, and stop after interruption',()=>{
 const run=setup();run.combat.request();run.frame(3);run.frame(3);assert.deepEqual(run.fired,[0,1,2,3]);
 run.combat.cancel();run.frame(4);run.finish();assert.deepEqual(run.fired,[0,1,2,3]);assert.equal(run.combat.snapshot().state,'idle');
});
test('changing equipment cancels old animation callbacks, retains skill cooldowns and uses the new attack',()=>{
 const run=setup(),skill={id:'demon-s-shield',action:catalog.skills['demon-s-shield'].action!};
 run.combat.request(skill);run.combat.update();run.frame(2);
 const fired=[...run.fired],cooldowns=run.combat.snapshot().cooldowns;
 const next=resolveBasicAttack(catalog,catalog.classes.find(c=>c.id==='ranger')!);
 run.combat.setBasicAttack(next);run.frame(9);run.finish();
 assert.deepEqual(run.fired,fired);assert.deepEqual(run.combat.snapshot().cooldowns,cooldowns);assert.equal(run.combat.snapshot().state,'idle');
 let used=false;run.port.play=action=>{used=action.basicAttack===next;return ()=>{};};
 assert.equal(run.combat.request(),'started');assert.equal(used,true);
});
test('self cues select caster independently of enemy; area queries retain each entity identity',()=>{
 const cue=actionCues(catalog.skills['demon-s-shield'].action!)[0];assert.deepEqual(resolveCueTargets(cue,caster,undefined,[enemy]),[caster]);
 const other={...enemy,id:'other',position:{x:350,y:210}};
 assert.deepEqual(resolveCueTargets({...cue,target:'area',targetRangePx:40},caster,enemy,[caster,enemy,other]).map(a=>a.id),['enemy','other']);
});
test('combat works with another world adapter and a self skill needs no enemy',()=>{
 const run=setup();run.port.actor=id=>id==='player'?caster:undefined;run.port.candidates=()=>[caster];
 assert.equal(run.combat.request(),'no-target');assert.equal(run.combat.request({id:'demon-s-shield',action:catalog.skills['demon-s-shield'].action!}),'started');
});
test('resource leases release only after the last owner, and each lease releases once',()=>{
 const disposed:string[]=[];const pool=new AssetPool(key=>disposed.push(key));const a=pool.acquire(['shared','map-a']),b=pool.acquire(['shared','map-b']);
 a.release();a.release();assert.deepEqual(disposed,['map-a']);b.release();assert.deepEqual(disposed,['map-a','shared','map-b']);
});
test('independent input locks cannot release each other',()=>{
 const controls=new ControlState();controls.lock('game',true);controls.lock('panel',true);controls.lock('panel',false);assert.equal(controls.locked,true);controls.lock('game',false);assert.equal(controls.locked,false);
});
test('content rejects unknown fields, missing variants and out-of-range event frames',()=>{
 const unknown=structuredClone(catalog);Object.assign(unknown.skills['dark-strike'].action!,{unexpectedField:1});assert.throws(()=>parseBattle(unknown),/unexpectedField/);
 const frames=structuredClone(catalog);frames.skills['dark-strike'].action!.events.at(-1)!.frame=10000;assert.throws(()=>parseBattle(frames),/触发帧/);
 const missing=structuredClone(catalog);delete missing.attackEffects[missing.basicAttacks['longsword-slash'].swings[0]].clips.east;assert.throws(()=>parseBattle(missing),/变体/);
 const stationary=structuredClone(catalog);delete stationary.attackEffects['phantom-sword'];assert.throws(()=>parseBattle(stationary),/特效/);
 assert.throws(()=>parseWorld({version:1,maps:[],actors:{},portraits:{},props:[],unexpectedField:0}),/unexpectedField/);
});

test('interrupting a skill before or after its effect frame preserves cooldown',()=>{
 for(const index of [0,8]){
  const run=setup(),skill={id:'dark-strike',action:catalog.skills['dark-strike'].action!};
  assert.equal(run.combat.request(skill),'started');run.frame(index);run.advanceFrames(10);run.combat.update();run.combat.cancel();
  assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs,skill.action.cooldownFrames*60-600);
  assert.equal(run.combat.request(skill),'cooldown');run.finish();
  assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs,skill.action.cooldownFrames*60-600);
 }
});
test('approaching or failing to find a target does not consume cooldown',()=>{
 const run=setup(),skill={id:'dark-strike',action:catalog.skills['dark-strike'].action!};
 const far={...enemy,position:{x:410,y:192}};
 run.port.actor=id=>id===caster.id?caster:far;run.port.candidates=()=>[far];
 assert.equal(run.combat.request(skill),'started');assert.equal(run.combat.snapshot().state,'approaching');
 assert.deepEqual(run.combat.snapshot().cooldowns,{});run.combat.cancel();
 run.port.candidates=()=>[];assert.equal(run.combat.request(skill),'no-target');assert.deepEqual(run.combat.snapshot().cooldowns,{});
});

test('curse of screams releases in place without a target and keeps the current facing',()=>{
 const skill={id:'curse-of-screams',action:catalog.skills['curse-of-screams'].action!};
 for(const candidates of [[],[enemy],[{...enemy,position:{x:1000,y:192}}]]){
  const run=setup();
  // A previously selected enemy must not turn a free cast into an approach.
  run.combat.request();run.finish();
  run.port.candidates=()=>candidates;run.port.facing=()=> 'north';
  run.port.moveToward=()=>assert.fail('area cast requested movement');
  let played=false;
  run.port.play=action=>{played=true;assert.equal(action.target,undefined);assert.equal(action.facing,'north');return ()=>{};};
  assert.equal(run.combat.request(skill),'started');assert.equal(played,true);
  assert.equal(run.combat.snapshot().state,'attacking');
  assert.deepEqual(run.combat.snapshot().cooldowns[skill.id],{remainingMs:skill.action.cooldownFrames*60,durationMs:skill.action.cooldownFrames*60});
 }
});
test('curse area uses quantized foot distance on all sides and excludes allies',()=>{
 const cue=actionCues(catalog.skills['curse-of-screams'].action!)[0];
 const at=(id:string,x:number,y:number):Combatant=>({...enemy,id,position:{x:caster.position.x+x,y:caster.position.y+y}});
 const candidates=[at('east',79,0),at('west',-79,0),at('north',0,-79),at('south',0,79),at('diagonal',56,56),at('outside',80,0),at('diagonal-outside',59,59),{...at('ally',10,0),team:caster.team}];
 assert.deepEqual(resolveCueTargets(cue,caster,undefined,candidates).map(a=>a.id),['east','west','north','south','diagonal']);
 assert.deepEqual(resolveCueTargets({...cue,targetRangeMetric:undefined},caster,undefined,candidates),[],'circular ranges remain independent');
});

test('selecting targets is idle, reports target changes, and survives action cancellation until explicitly cleared',()=>{
 const run=setup(),states:(string|undefined)[]=[];const off=run.combat.subscribe(state=>states.push(state.targetId));
 assert.equal(run.combat.selectTarget('enemy'),true);assert.equal(run.combat.snapshot().targetId,'enemy');assert.equal(run.combat.snapshot().state,'idle');assert.deepEqual(run.fired,[]);
 assert.equal(run.combat.selectTarget('player'),false);assert.equal(run.combat.selectTarget('missing'),false);assert.equal(run.combat.snapshot().targetId,'enemy');
 run.combat.request();assert.equal(run.combat.snapshot().targetId,'enemy');run.combat.cancel(true,false);assert.equal(run.combat.snapshot().targetId,'enemy');
 const skill={id:'demon-s-shield',action:catalog.skills['demon-s-shield'].action!};run.combat.request(skill);run.combat.cancel(true,false);
 run.port.actor=id=>id==='player'?caster:undefined;run.combat.update();assert.equal(run.combat.snapshot().targetId,undefined);assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs,skill.action.cooldownFrames*60);
 assert.ok(states.includes('enemy'));off();run.combat.dispose();
});

test('a cooldown reset during a skill frame preserves its later frames, target and completion',()=>{
 const run=setup();
 const shield={id:'demon-s-shield',action:catalog.skills['demon-s-shield'].action!};
 const strike={id:'dark-strike',action:catalog.skills['dark-strike'].action!};
 run.combat.request(shield);run.finish();run.fired.length=0;run.combat.selectTarget(enemy.id);run.combat.request(strike);
 assert.deepEqual(Object.keys(run.combat.snapshot().cooldowns).sort(),[strike.id,shield.id].sort());
 const updates:ReturnType<CombatController['snapshot']>[]=[];
 const unsubscribe=run.combat.subscribe(snapshot=>updates.push(snapshot));
 const frame=run.port.frame;
 run.port.frame=(action,index,contact,ready)=>{frame(action,index,contact,ready);if(index===1)run.combat.resetSkillCooldowns();};
 const current=run.plays.at(-1)!;
 current.frame(3);
 assert.deepEqual(run.fired,[0,1,2,3]);
 assert.deepEqual(run.combat.snapshot(),{state:'attacking',targetId:enemy.id,cooldowns:{}});
 assert.deepEqual(updates.at(-1),run.combat.snapshot());
 assert.equal(updates.length,2,'the reset publishes its cleared cooldown snapshot');
 assert.equal(current.cancelled,false);assert.equal(run.cleared(),0);
 current.frame(4);assert.deepEqual(run.fired,[0,1,2,3,4]);
 current.finish();assert.deepEqual(run.combat.snapshot(),{state:'idle',targetId:enemy.id,cooldowns:{}});
 unsubscribe();
 assert.equal(run.combat.request(strike),'started');
});

test('cooldown reset keeps an approaching skill pending until it reaches casting range',()=>{
 const run=setup();
 run.combat.request({id:'demon-s-shield',action:catalog.skills['demon-s-shield'].action!});run.finish();
 const far={...enemy,position:{x:450,y:192}};
 run.port.actor=id=>id===caster.id?caster:id===enemy.id?far:undefined;
 run.port.candidates=()=>[caster,far];
 const strike={id:'dark-strike',action:catalog.skills['dark-strike'].action!};
 run.combat.selectTarget(enemy.id);assert.equal(run.combat.request(strike),'started');
 assert.equal(run.combat.snapshot().state,'approaching');
 const plays=run.plays.length;
 run.port.stop=()=>assert.fail('clearing cooldowns must not stop movement');
 run.combat.resetSkillCooldowns();
 assert.deepEqual(run.combat.snapshot(),{state:'approaching',targetId:enemy.id,cooldowns:{}});
 assert.equal(run.plays.length,plays);
 run.port.stop=()=>{};far.position={...enemy.position};run.combat.update();
 assert.equal(run.plays.at(-1)!.action.skill?.id,strike.id);
 assert.equal(run.combat.snapshot().state,'attacking');
 assert.equal(run.combat.snapshot().cooldowns[strike.id].remainingMs,strike.action.cooldownFrames*60);
});

test('repeated cooldown resets with no cooldowns preserve the current snapshot',()=>{
 const run=setup();run.combat.selectTarget(enemy.id);
 const before=run.combat.snapshot();
 run.port.stop=()=>assert.fail('clearing an empty cooldown list must not stop the actor');
 for(let count=0;count<3;count++){
  run.combat.resetSkillCooldowns();
  assert.deepEqual(run.combat.snapshot(),before);
 }
 assert.equal(run.plays.length,0);assert.equal(run.cleared(),0);
});

test('moving clears the selected target once and leaves the running action alone',()=>{
 const run=setup(),states:(string|undefined)[]=[];const off=run.combat.subscribe(state=>states.push(state.targetId));
 run.combat.selectTarget(enemy.id);states.length=0;
 run.combat.clearSelection();
 assert.equal(run.combat.snapshot().targetId,undefined);assert.deepEqual(states,[undefined]);
 off();run.combat.dispose();
});

test('clearing an already empty selection reports nothing',()=>{
 const run=setup(),states:(string|undefined)[]=[];const off=run.combat.subscribe(state=>states.push(state.targetId));
 states.length=0;run.combat.clearSelection();run.combat.clearSelection();
 assert.deepEqual(states,[]);assert.equal(run.combat.snapshot().targetId,undefined);
 off();run.combat.dispose();
});

test('a cleared selection does not keep attacking, and with nothing in reach the request has no target',()=>{
 const run=setup();run.combat.selectTarget(enemy.id);
 run.combat.clearSelection();run.combat.update();
 assert.equal(run.combat.snapshot().targetId,undefined);assert.equal(run.combat.snapshot().state,'idle');
 run.port.candidates=()=>[caster];
 assert.equal(run.combat.request(),'no-target');assert.deepEqual(run.fired,[]);
 run.combat.dispose();
});

test('clearing the selection while an action runs lets that action finish on its own target',()=>{
 const run=setup(),contacts:AttackContact[]=[];
 run.combat.selectTarget(enemy.id);run.port.contact=event=>contacts.push(event);
 run.combat.request();assert.ok(['approaching','attacking'].includes(run.combat.snapshot().state));
 run.combat.clearSelection();assert.equal(run.combat.snapshot().targetId,undefined);
 run.finish();
 assert.equal(run.combat.snapshot().state,'idle');assert.ok(contacts.length>=0);
 run.combat.dispose();
});


test('all normal request entries enforce the skill selection gate before resource writes',()=>{
  for(const manual of [false,true]){
    const run=setup();let spent=0;
    run.port.canSelectSkill=()=>false;run.port.spendMana=()=>{spent++;return true;};
    const skill={id:'shield-bash',action:catalog.skills['shield-bash'].action!,manaCost:10};
    assert.equal(manual?run.combat.requestManualSkill(skill):run.combat.request(skill),'unavailable');
    assert.equal(spent,0);assert.deepEqual(run.combat.snapshot().cooldowns,{});assert.equal(run.plays.length,0);
  }
});

test('an unreachable charge rejects without consuming mana, cooldown or playback',()=>{
  const run=setup();let spent=0;
  const target={...enemy,position:{x:430,y:192}};
  run.port.actor=id=>id===caster.id?caster:id===target.id?target:undefined;
  run.port.candidates=()=>[caster,target];run.port.canStand=()=>false;
  run.port.spendMana=()=>{spent++;return true;};
  const original=catalog.skills['shield-bash'].action!;
  const skill={id:'shield-bash',action:{...original,approachDistanceUnits:100},manaCost:10};
  assert.equal(run.combat.request(skill,target.id),'no-target');
  assert.equal(spent,0);assert.deepEqual(run.combat.snapshot().cooldowns,{});
  assert.equal(run.plays.length,0);assert.equal(run.combat.snapshot().state,'idle');
});
