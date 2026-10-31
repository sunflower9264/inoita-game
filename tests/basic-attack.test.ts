import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { attackDistance, attackSequence, basicAttackEvents, basicAttackStrikesAtFrame, idlePoseFrame, projectileStep, projectileHeading, resolveBasicAttack, targetScore } from '../src/domain/basic-attack.ts';
import type { Point } from '../src/domain/basic-attack.ts';
import type { BattleCatalog, BattleClass } from '../src/domain/battle.ts';
import { CombatController } from '../src/domain/combat.ts';
import type { CombatPort, Combatant } from '../src/domain/combat.ts';
import { parseBattle } from '../src/application/content-validation.ts';
const publicRoot=new URL('../public/',import.meta.url);
const catalog:BattleCatalog=JSON.parse(readFileSync(new URL('content/battle.json',publicRoot),'utf8'));
const FACINGS=['north','south','east','west'] as const;
/** 原版六套初始武器的基线：源动画帧数、周期、出手帧、挥击帧、接近距离、搜索半径。 */
const baseline = {
  'dark-knight':{source:8,cycle:10,strike:4,swing:3,approach:4,search:64},
  'assassin':{source:5,cycle:8,strike:2,swing:2,approach:4,search:64},
  'warlock':{source:10,cycle:10,strike:1,swing:null,approach:12,search:96},
  'priest':{source:8,cycle:11,strike:4,swing:3,approach:4,search:64},
  'ranger':{source:10,cycle:12,strike:10,swing:null,approach:12,search:96},
  'warrior':{source:12,cycle:12,strike:4,swing:3,approach:4,search:64}
} as const;
const classOf=(id:string):BattleClass=>catalog.classes.find(character=>character.id===id)!;

test('six initial weapons keep their verified source frames, cycles, events and ranges',()=>{
  for(const [id,want] of Object.entries(baseline)){
    const character=classOf(id),attack=resolveBasicAttack(catalog,character);
    assert.equal(attack.strikeFrame,want.strike,id);
    assert.equal(attack.swingFrame,want.swing,id);
    assert.equal(attack.approachDistanceUnits,want.approach,id);
    assert.equal(attack.searchRadiusPx,want.search,id);
    assert.equal(attack.frameDurationMs,60,id);
    assert.equal(attack.cycleFrames,want.cycle,id);
    assert.equal(attack.effectiveCycleFrames,want.cycle,id);
    for(const facing of FACINGS){
      const clip=character.actor.clips[attack.clips[facing]]!;
      // 图集只保留源动画帧；周期由配置决定，末帧停留由序列展开。
      assert.equal(clip.frames,want.source,`${id}/${facing}`);
      assert.equal(attack.sequence[facing].length,want.cycle,`${id}/${facing}`);
      assert.deepEqual(attack.sequence[facing],Array.from({length:want.cycle},(_,i)=>Math.min(i,want.source-1)),`${id}/${facing}`);
    }
  }
});

test('extending, shortening and outrunning the source frames all keep events reachable',()=>{
  const knight=classOf('dark-knight');
  // 延长：素材播完重复引用末帧。
  assert.deepEqual(resolveBasicAttack(catalog,knight,14).sequence.south,[0,1,2,3,4,5,6,7,7,7,7,7,7,7]);
  // 缩短：截取源序列的前几帧。
  assert.deepEqual(resolveBasicAttack(catalog,knight,6).sequence.south,[0,1,2,3,4,5]);
  // 周期短于出手帧时按出手帧补足，弓箭第 10 帧仍然发射。
  const ranger=resolveBasicAttack(catalog,classOf('ranger'),3);
  assert.equal(ranger.effectiveCycleFrames,11);
  assert.equal(ranger.sequence.south.length,11);
  assert.equal(ranger.sequence.south[10],9);
  assert.equal(basicAttackEvents(ranger,10).strike,true);
  // 出手帧超出源图片帧数时，末帧停留在周期内继续占位。
  assert.deepEqual(attackSequence(3,5),[0,1,2,2,2]);
  assert.throws(()=>attackSequence(0,5),/源动画帧数无效/);
  assert.throws(()=>attackSequence(3,0),/周期帧数无效/);
});

test('素材播完后画待机，帧号按计数对待机源帧数取模',()=>{
  // 计数还在素材范围内：照常画当前动作。
  assert.equal(idlePoseFrame(3,4,15),null);
  // 计数达到源帧数时原版改画待机，仙人掌这类 20 帧周期只有 4 帧素材。
  assert.equal(idlePoseFrame(4,4,15),4);
  assert.equal(idlePoseFrame(19,4,15),4);
  assert.equal(idlePoseFrame(16,4,10),6);
  // 没有待机素材时保持当前动作（原版找不到待机动作也一样）。
  assert.equal(idlePoseFrame(9,4,0),null);
});

test('swing and strike events land on logical frames, swing first on the same frame',()=>{
  const assassin=resolveBasicAttack(catalog,classOf('assassin'));
  assert.deepEqual(basicAttackEvents(assassin,2),{swing:true,strike:true});
  assert.deepEqual(basicAttackEvents(assassin,1),{swing:false,strike:false});
  assert.deepEqual(basicAttackEvents({swingFrame:0,strikeFrame:0},0),{swing:true,strike:true});
  // 出手帧可以落在素材播完后的末帧停留期间。
  assert.deepEqual(basicAttackEvents(resolveBasicAttack(catalog,classOf('ranger')),10),{swing:false,strike:true});
  assert.deepEqual(basicAttackEvents(resolveBasicAttack(catalog,classOf('warlock')),10),{swing:false,strike:false});
});

test('dual attacks expose each hand while their shortest cycle protects only the first strike',()=>{
  for(const [first,second] of [[1,3],[2,5]]){
    const character=classOf('warrior');
    const definition={...catalog.basicAttacks[character.basicAttack!.profileId],strikeFrame:first,swingFrame:first-1,
      strikes:[{frame:first,hand:'main-hand' as const},{frame:second,hand:'offhand' as const}]};
    const attack=resolveBasicAttack({basicAttacks:{dual:definition}},
      {...character,basicAttack:{...character.basicAttack!,profileId:'dual'}},1);
    assert.equal(attack.effectiveCycleFrames,first+1);
    assert.equal(attack.sequence.east.length,first+1);
    assert.equal(basicAttackEvents(attack,first).strike,true);
    assert.equal(basicAttackEvents(attack,second).strike,true);
    assert.deepEqual(basicAttackStrikesAtFrame(attack,first),['main-hand']);
    assert.deepEqual(basicAttackStrikesAtFrame(attack,second),['offhand']);
    assert.deepEqual(basicAttackStrikesAtFrame(attack,first-1),[]);
  }
  assert.deepEqual(basicAttackStrikesAtFrame({strikeFrame:0},0),['main-hand']);
});

test('two characters sharing a profile keep their own images and cycles',()=>{
  const shared=structuredClone(catalog);
  const twin=structuredClone(shared.classes[0]);
  twin.id='knight-twin'; twin.actor=structuredClone(shared.classes[1].actor);
  shared.classes.push(twin);
  const first=resolveBasicAttack(shared,shared.classes[0]);
  const second=resolveBasicAttack(shared,shared.classes[6],6);
  assert.equal(first.clips.south,second.clips.south);
  assert.deepEqual(first.sequence.south,[0,1,2,3,4,5,6,7,7,7]);
  assert.deepEqual(second.sequence.south,[0,1,2,3,4,4]);
  assert.equal(first.effectiveCycleFrames,10);assert.equal(second.effectiveCycleFrames,6);
  // 解析结果各自独立，配置本身也不被改写。
  assert.notEqual(first.sequence.south,second.sequence.south);
  assert.equal(shared.basicAttacks['longsword-slash'].cycleFrames,10);
  assert.notEqual(resolveBasicAttack(shared,shared.classes[0],4).sequence.south,first.sequence.south);
});

test('every basic attack starts a fresh playback, including repeats in one direction',()=>{
  const caster:Combatant={id:'player',team:'party',position:{x:352,y:192},bounds:{x:-8,y:-8,width:16,height:16}};
  const enemy:Combatant={...caster,id:'enemy',team:'hostile',position:{x:384,y:192}};
  const played:number[]=[];let frame:((index:number)=>void)|undefined,complete:(()=>void)|undefined;
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor(caster.id),actor:id=>[caster,enemy].find(a=>a.id===id),candidates:()=>[caster,enemy],facing:()=> 'west',
    moveToward:()=>{},stop:()=>{},canStand:()=>true,relocate:()=>{},
    play:(_action,onFrame,onComplete)=>{played.push(0);frame=onFrame;complete=onComplete;return ()=>{};},
    frame:()=>{},clearEffects:()=>{}};
  const combat=new CombatController('player',resolveBasicAttack(catalog,classOf('dark-knight')),port);
  // 两次同方向攻击都要重新起手，而不是接着上一次的进度。
  assert.equal(combat.request(),'started');frame!(3);complete!();
  assert.equal(combat.request(),'started');frame!(0);
  assert.deepEqual(played,[0,0]);
  assert.equal(combat.snapshot().state,'attacking');
  combat.dispose();
});

test('basic attack references are resolved at load time and follow the binding',()=>{
  const content=structuredClone(catalog);
  for(const character of content.classes)character.skills=[];
  content.skills={};
  assert.doesNotThrow(()=>parseBattle(content));
  for(const character of content.classes){
    const profile=content.basicAttacks[character.basicAttack.profileId];
    const melee=['dark-knight','assassin','priest','warrior'].includes(character.id);
    assert.equal(profile.swingPlacement,melee?'above-characters':undefined);
    assert.equal(profile.impactPlacement,'attached');
    assert.equal(profile.projectilePlacement,['ranger','warlock'].includes(character.id)?'above-characters':undefined);
  }
  const missing=structuredClone(content);
  const target=missing.enemies.find(enemy=>enemy.basicAttack===null)!;
  assert.ok(target);delete target.actor.effectAnchor;
  assert.throws(()=>parseBattle(missing),/跟随特效需要人物锚点/);
  for(const character of missing.classes)delete missing.basicAttacks[character.basicAttack.profileId].impactPlacement;
  // 怪物自己的附着效果也需要目标锚点，去掉职业命中方式并不会解除这一要求。
  assert.throws(()=>parseBattle(missing),/跟随特效需要人物锚点/);
  // 只留下不会攻击的靶子后，独立核对职业普攻的锚点要求。
  missing.enemies=[target];
  assert.doesNotThrow(()=>parseBattle(missing));
  for(const field of ['swingPlacement','impactPlacement','projectilePlacement']){
    const invalid=structuredClone(content);Object.assign(invalid.basicAttacks['longsword-slash'],{[field]:'invalid'});
    assert.throws(()=>parseBattle(invalid),new RegExp(field));
  }
});

test('resources are collected from the same resolved binding, so rebinding changes what must load',()=>{
  // 挥击特效可由职业和人形怪物共用，缺了必须按实际绑定报错。
  const rebound=structuredClone(catalog);delete rebound.attackEffects['sword-swing'];
  assert.throws(()=>parseBattle(rebound),/sword-swing/);
  // 改绑职业后，人形怪物仍引用剑挥击，缺失资源仍必须失败。
  for(const character of rebound.classes)
    if(rebound.basicAttacks[character.basicAttack.profileId].swings.includes('sword-swing'))
      character.basicAttack={profileId:'dagger-slash',clips:structuredClone(character.basicAttack.clips)};
  assert.throws(()=>parseBattle(rebound),/sword-swing/);
  // 隔离职业资源收集，只保留无攻击的靶子，再检查新绑定的匕首挥击。
  const target=rebound.enemies.find(enemy=>enemy.basicAttack===null)!;
  assert.ok(target);rebound.enemies=[target,...catalog.enemies.filter(enemy=>['enemy-hell-s-pawn-1','enemy-beast-companion-1'].includes(enemy.id))];
  assert.doesNotThrow(()=>parseBattle(rebound));
  delete rebound.attackEffects['dagger-swing'];
  assert.throws(()=>parseBattle(rebound),/dagger-swing/);
});

test('missing profiles, animations and illegal timing are rejected at load time',()=>{
  const unknown=structuredClone(catalog);unknown.classes[0].basicAttack.profileId='unlisted';
  assert.throws(()=>parseBattle(unknown),/普攻规则缺失/);
  // 绑到黑暗骑士没有的动画（这个技能属于黑魔导）。
  const clip=structuredClone(catalog);clip.classes[0].basicAttack.clips.west='skill-touch-of-agony-west';
  assert.throws(()=>parseBattle(clip),/普攻动画缺失/);
  for(const [field,value] of [['frameDurationMs',0],['cycleFrames',0],['cycleFrames',9.5],['strikeFrame',-1]] as const){
    const invalid=structuredClone(catalog);Object.assign(invalid.basicAttacks['longsword-slash'],{[field]:value});
    assert.throws(()=>parseBattle(invalid),new RegExp(field),`${field}=${value}`);
  }
  const late=structuredClone(catalog);late.basicAttacks['longsword-slash'].swingFrame=10;
  assert.throws(()=>parseBattle(late),/挥击帧超出有效周期/);
  const empty=structuredClone(catalog);empty.basicAttacks['longsword-slash'].impacts=[];
  assert.throws(()=>parseBattle(empty),/命中特效不能为空/);
  // 出手帧超出配置周期时自动延长有效周期，属于合法配置。
  const long=structuredClone(catalog);long.basicAttacks['longsword-slash'].strikeFrame=14;
  assert.equal(resolveBasicAttack(parseBattle(long),classOf('dark-knight')).effectiveCycleFrames,15);
});

test('all classes have complete one-shot attacks with reachable event frames',()=>{
  for (const character of catalog.classes) {
    const attack=resolveBasicAttack(catalog,character);
    for (const direction of FACINGS) {
      const clip=character.actor.clips[attack.clips[direction]]!;
      assert.ok(clip && Number.isInteger(clip.frames) && clip.frames>0);
      assert.equal(clip.frameRate,1000/60);
      assert.equal(clip.mirrorX,direction==='east');
    }
    for(const index of [attack.strikeFrame,attack.swingFrame])
      assert.ok(index===null||index<attack.effectiveCycleFrames,`${character.id}: ${index}`);
    for (const key of [...attack.swings,...attack.impacts,...(attack.projectile?[attack.projectile.effect]:[])]) {
      for (const clip of Object.values(catalog.attackEffects[key].clips))
        for (const layer of clip.layers) assert.ok(existsSync(new URL(layer.file,publicRoot)));
    }
  }
});

test('attack range uses body edges, separate axis rounding and large target bounds',()=>{
  const p={x:0,y:0},box={x:-8,y:-8,width:16,height:16};
  assert.equal(attackDistance(p,box,{x:39,y:0},box),4);
  assert.equal(attackDistance(p,box,{x:40,y:0},box),5);
  assert.equal(attackDistance(p,box,{x:23,y:23},box),2);
  assert.equal(attackDistance(p,box,{x:40,y:0},{...box,x:-16,width:32}),4);
});

test('target search favors facing and rejects targets outside the radius',()=>{
  const p={x:0,y:0};
  assert.ok(targetScore(p,{x:64,y:0},'east',64)>0);
  assert.equal(targetScore(p,{x:64,y:0},'west',64),0);
  assert.equal(targetScore(p,{x:65,y:0},'east',64),0);
  assert.ok(targetScore(p,{x:-30,y:0},'east',64)>0);
});

test('projectiles converge on every side and use sixteen direction sectors',()=>{
  function projectilePath(start: Point, target: Point, step: number): Point[] {
    let position=start;
    const path: Point[]=[];
    for (let guard=0;guard<256;guard++) {
      const next=projectileStep(position,target,step);
      path.push(next.position);
      if (next.arrived) return path;
      position=next.position;
    }
    throw new Error('投射物轨迹无法到达目标');
  }
  assert.deepEqual(projectilePath({x:0,y:0},{x:32,y:0},16),[{x:16,y:0},{x:32,y:0},{x:32,y:0}]);
  for (const step of [12,16]) for (const x of [-99,-16,-1,0,1,16,99]) for (const y of [-99,-16,-1,0,1,16,99]) {
    const end={x,y};const path=projectilePath({x:0,y:0},end,step);
    assert.deepEqual(path.at(-1),end);assert.ok(path.length<40);
    assert.ok(Object.hasOwn(catalog.attackEffects.arrow.clips,`heading-${projectileHeading({x:0,y:0},end)}`));
  }
});
