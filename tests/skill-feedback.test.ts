import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog,SkillAction,SkillFeedbackEvent} from '../src/domain/battle.ts';
import {BattleCharacter} from '../src/domain/character-stats.ts';
import type {CombatFeedbackSelection} from '../src/domain/combat-feedback.ts';
import {CombatSettlementEngine} from '../src/domain/combat-settlement.ts';
import type {ActorDefinition} from '../src/domain/content.ts';
import {Session} from '../src/domain/session.ts';
import {displaySettings} from '../src/application/display-settings.ts';
import {skillEffectNames,skillSoundNames} from '../src/domain/skill-action.ts';
import {CHARACTER_ATLAS_ALIASES} from '../tools/character-atlas-aliases.ts';
import {loadCampaignCatalog,loadCharacterStatsCatalog,loadCompanionCatalog,loadItemCatalog} from './support/combat-test-harness.ts';
import {createFakePhaserScene,createTestWorldCombat,installPhaserStubHooks} from './support/world-combat-fixture.ts';

const hook=installPhaserStubHooks();
const {CombatFeedback}=await import('../src/rendering/combat-feedback.ts');
const {CombatStatusVisuals}=await import('../src/rendering/combat-status-visuals.ts');
hook.deregister();

function fullPhaserScene(){
  const scene=createFakePhaserScene({
    cameras:{main:{width:640,height:360,zoomX:1,zoomY:1,worldView:undefined,followOffset:{x:0,y:0},setFollowOffset(){}}},
    tweens:{add:()=>({stop(){},pause(){},resume(){}}),getTweensOf:()=>[],killTweensOf:()=>{}},
  });
  const origSprite=scene.add.sprite.bind(scene.add) as unknown as (...args:unknown[])=>{scene:unknown;anims:Record<string,unknown>};
  scene.add.sprite=((...args:unknown[])=>{
    const sprite=origSprite(...args);
    sprite.scene=scene;
    sprite.anims={...sprite.anims,create:()=>({destroy(){}}),remove:()=>{}};
    return sprite as never;
  }) as never;
  return scene;
}

function normalizeActorClips(actor:ActorDefinition):void{
  for(const clip of Object.values(actor.clips)){
    for(const layer of clip?.layers??[]){
      if(layer.file)layer.file=CHARACTER_ATLAS_ALIASES[layer.file]??layer.file;
    }
  }
}

function normalizeBattleCatalog(raw:BattleCatalog):BattleCatalog{
  const copy=structuredClone(raw);
  for(const cls of copy.classes)normalizeActorClips(cls.actor);
  for(const enemy of copy.enemies)normalizeActorClips(enemy.actor);
  return copy;
}

const catalog=normalizeBattleCatalog(JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog);

test('the real party frame port plays explicit sound for the hero and mercenaries after units',async t=>{
  const order:string[]=[];
  const feedbackEvent:SkillFeedbackEvent={kind:'feedback',frame:10,shake:true,sound:'Bn_Hell_Sword'};
  const customCatalog=structuredClone(catalog);
  const baseSword=catalog.skills['sword-of-hell'];
  const customAction={
    ...baseSword.action!,
    cooldownFrames:0,
    approachDistanceUnits:0,
    requiresTarget:false,
    combatUnits:[{effect:'visual' as const}],
    events:[{kind:'units' as const,frame:10,cues:[{target:'self' as const,targetRangePx:0,targetSelection:'search' as const,effects:[]}]},feedbackEvent],
  };
  customCatalog.skills['sword-of-hell']={
    ...baseSword,
    action:customAction,
    ...(baseSword.companion?{companion:{...baseSword.companion,action:customAction}}:{}),
  };
  const items=loadItemCatalog();
  const statsCatalog=loadCharacterStatsCatalog();
  const campaign=loadCampaignCatalog();
  const companions=loadCompanionCatalog();
  const hero=new BattleCharacter('dark-knight',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,customCatalog,statsCatalog,companions);
  session.skills.maxAll();
  session.skills.bar().assign(0,0,{kind:'skill',id:'sword-of-hell'});
  session.bag.add('mercenary-emblem-black-knight');
  const ally=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  session.party!.deployFirstAvailable(ally.id);
  ally.skills.maxAll(customCatalog,ally.classId);
  const actor=customCatalog.classes.find(entry=>entry.id===ally.classId)!.actor;
  const phaserScene=fullPhaserScene();
  const world=await createTestWorldCombat({
    hero,session,phaserScene,battleCatalog:customCatalog,
    appOverrides:{
      world:{actors:{[ally.definition.actor]:actor,[actor.id]:actor}} as never,
      audio:{
        playerSkill:()=>order.push('automatic-sound'),
        effect:(name:string)=>order.push(name),
        prepareCombat:async()=>{},
      } as never,
    },
  });
  await world.combat.start();
  const origUnit=CombatSettlementEngine.prototype.skillUnit;
  t.mock.method(CombatSettlementEngine.prototype,'skillUnit',function(this:CombatSettlementEngine,...args:Parameters<CombatSettlementEngine['skillUnit']>){
    order.push('units');
    return origUnit.apply(this,args);
  });
  t.mock.method(CombatFeedback.prototype,'startShake',()=>order.push('shake'));

  world.combat.attack('sword-of-hell');
  for(let step=0;step<11;step++)world.combat.update(60,true);
  assert.deepEqual(order,['units','shake','Bn_Hell_Sword']);
  assert.deepEqual(skillEffectNames(customCatalog.skills['sword-of-hell'].action!),[]);

  order.length=0;
  assert.equal(world.combat.switchControl(ally.id),true);
  world.combat.attack('sword-of-hell');
  for(let step=0;step<11;step++)world.combat.update(60,true);
  assert.deepEqual(order,['units','shake','Bn_Hell_Sword']);
  world.combat.destroy();
});

test('the party tactics port reads a wounded summon from its combat snapshot',async()=>{
  const items=loadItemCatalog();
  const statsCatalog=loadCharacterStatsCatalog();
  const campaign=loadCampaignCatalog();
  const companions=loadCompanionCatalog();
  const hero=new BattleCharacter('warlock',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,catalog,statsCatalog,companions);
  session.skills.maxAll();
  session.skills.bar().assign(0,0,{kind:'skill',id:'hell-s-pawn'});
  session.bag.add('mercenary-emblem-priest');
  const priest=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!.id,()=>0).member;
  session.party!.deployFirstAvailable(priest.id);
  priest.skills.maxAll(catalog,priest.classId);
  const priestActor=catalog.classes.find(entry=>entry.id===priest.classId)!.actor;
  const map={
    id:'tactics-vitals-map',name:'tactics-vitals-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'foe',enemyId:'enemy-wolf-1',x:220,y:64}],
  };
  const phaserScene=fullPhaserScene();
  const world=await createTestWorldCombat({
    hero,session,map,phaserScene,battleCatalog:catalog,
    appOverrides:{world:{actors:{[priest.definition.actor]:priestActor,[priestActor.id]:priestActor}} as never},
  });
  await world.combat.start();
  world.combat.attack('hell-s-pawn');
  for(let step=0;step<7;step++)world.combat.update(60,true);
  const summon=world.roster.enemies.find(enemy=>enemy.summonedBy==='player')!;
  assert.ok(summon);
  const summonDef=catalog.enemies.find(enemy=>enemy.id===summon.enemyId)!;
  world.roster.setEnemyHealth(summon.key,9,summonDef);
  world.combat.focusTarget('foe');
  for(let step=0;step<15;step++)world.combat.update(60,true);
  const after=world.roster.enemySnapshot(summon.key,summonDef,hero.level)!;
  assert.ok(after.health>9,'牧师读到受伤召唤物快照并为其治疗');
  world.combat.destroy();
});

test('mercenary basic attacks use their own weapon sound instead of staying silent',async t=>{
  t.mock.method(Math,'random',()=>0.5);
  const items=loadItemCatalog();
  const statsCatalog=loadCharacterStatsCatalog();
  const campaign=loadCampaignCatalog();
  const companions=loadCompanionCatalog();
  const hero=new BattleCharacter('dark-knight',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,catalog,statsCatalog,companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  session.party!.deployFirstAvailable(ally.id);
  hero.bag.addEquipped('longsword','main-hand',ally.id,ally.classId);
  const actor=catalog.classes.find(entry=>entry.id===ally.classId)!.actor;
  const map={
    id:'ally-sound-map',name:'ally-sound-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'foe',enemyId:'enemy-wolf-1',x:64,y:64}],
  };
  const calls:unknown[][]=[];
  const phaserScene=fullPhaserScene();
  const world=await createTestWorldCombat({
    hero,session,map,phaserScene,battleCatalog:catalog,
    appOverrides:{
      world:{actors:{[ally.definition.actor]:actor,[actor.id]:actor}} as never,
      audio:{
        playerHit:(...args:unknown[])=>calls.push(args),
        monsterAttack:()=>{},
        shieldBlock:()=>{},
        periodicDamage:()=>{},
        prepareCombat:async()=>{},
      } as never,
    },
  });
  await world.combat.start();
  world.combat.focusTarget('foe');
  for(let step=0;step<25&&!calls.length;step++)world.combat.update(60,true);
  assert.deepEqual(calls,[['longsword','hit','enemy-wolf-1']]);
  world.combat.destroy();
});

test('world hit feedback follows the critical decoration preference',async t=>{
  t.mock.method(Math,'random',()=>0.1);
  displaySettings.setCriticalDecorations(false);
  t.after(()=>displaySettings.setCriticalDecorations(true));
  const map={
    id:'crit-pref-map',name:'crit-pref-map',width:320,height:320,tileSize:16,columns:20,rows:20,
    blocked:Array<boolean>(400).fill(false),ground:'',canopy:'',features:[],entities:[],exits:[],
    enemySpawns:[{id:'foe',enemyId:'enemy-wolf-1',x:72,y:64}],
  };
  const phaserScene=fullPhaserScene();
  const world=await createTestWorldCombat({map,phaserScene,battleCatalog:catalog});
  await world.combat.start();
  const shown:CombatFeedbackSelection[]=[];let flashes=0;
  t.mock.method(CombatFeedback.prototype,'show',(event:{casterControlled?:boolean},_target:unknown,selection:CombatFeedbackSelection)=>{
    if(event.casterControlled)shown.push(selection);
  });
  t.mock.method(CombatStatusVisuals.prototype,'flash',()=>{flashes++;});
  world.combat.selectEnemy('foe');
  const swingUntilHit=(expectedCount:number)=>{
    world.combat.attack();
    for(let step=0;step<30&&shown.length<expectedCount;step++)world.combat.update(60,true);
  };
  swingUntilHit(1);
  assert.equal(flashes,1);
  assert.deepEqual(shown[0]!.impacts,[{name:catalog.feedback.criticalImpact,attached:true}]);
  assert.equal(shown[0]!.digitEffect,catalog.feedback.digits.enemyCritical[0]);

  displaySettings.setCriticalDecorations(true);
  for(let step=0;step<20&&world.combat.attackState!=='idle';step++)world.combat.update(60,true);
  swingUntilHit(2);
  const names=shown[1]!.impacts.map(effect=>effect.name);
  assert.deepEqual(names.slice(0,2),[catalog.feedback.criticalImpact,catalog.feedback.criticalRing]);
  assert.equal(names.length,3);
  assert.ok(catalog.feedback.criticalBursts.includes(names[2]!));
  world.combat.destroy();
});

test('skill camera feedback reuses all six native world-pixel offsets and resets cleanly on restart',()=>{
  const offsets=catalog.feedback.shakeOffsets,values:{x:number;y:number}[]=[];
  const camera={followOffset:{x:2,y:3},setFollowOffset(x:number,y:number){this.followOffset={x,y};values.push({x,y});}};
  let tween:{targets:{step:number};step:number;duration:number;onUpdate:()=>void;onComplete:()=>void}|undefined,stops=0;
  const phaserScene=createFakePhaserScene({
    cameras:{main:camera},
    tweens:{add:(config:typeof tween)=>{tween=config;return{stop:()=>stops++,pause(){},resume(){}};},getTweensOf:()=>[],killTweensOf:()=>{}},
  });
  const feedback=new CombatFeedback(phaserScene,catalog);
  feedback.startShake();assert.equal(tween!.duration,360);
  for(let step=1;step<6;step++){tween!.targets.step=step;tween!.onUpdate();}
  assert.deepEqual(values,offsets.map(offset=>({x:2-offset.x,y:3-offset.y})));
  tween!.onComplete();assert.deepEqual(camera.followOffset,{x:2,y:3});
  feedback.startShake();feedback.startShake();assert.deepEqual(camera.followOffset,{x:8,y:9});
  feedback.cancelShake();assert.deepEqual(camera.followOffset,{x:2,y:3});assert.equal(stops,3);
});

test('技能动作音效遍历取到动作单元与派发收尾两类触发点',()=>{
  assert.deepEqual(skillSoundNames(catalog.skills['divine-strike'].action!),['A_Skill_Attack01','A_Skill_05']);
  assert.deepEqual(skillSoundNames(catalog.skills['dark-strike'].action!),['Wa_Titan_Attack']);
  const feedback:SkillAction={...catalog.skills['divine-strike'].action!,
    events:[{kind:'feedback',frame:4,sound:'Bn_Hell_Sword'}]};
  assert.deepEqual(skillSoundNames(feedback),['Bn_Hell_Sword']);
  assert.deepEqual(skillSoundNames({...feedback,events:[]}),[]);
});
