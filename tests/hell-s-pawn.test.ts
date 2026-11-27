import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog,SummonOwnerDerivation} from '../src/domain/battle.ts';
import {BattleCharacter} from '../src/domain/character-stats.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {ActorDefinition} from '../src/domain/content.ts';
import {EnemyRoster} from '../src/domain/enemy-roster.ts';
import {Session} from '../src/domain/session.ts';
import {summonOwnerStats} from '../src/domain/summon-stats.ts';
import {CHARACTER_ATLAS_ALIASES} from '../tools/character-atlas-aliases.ts';
import {loadCampaignCatalog,loadCharacterStatsCatalog,loadCompanionCatalog,loadItemCatalog} from './support/combat-test-harness.ts';
import {createFakePhaserScene,createTestWorldCombat} from './support/world-combat-fixture.ts';

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
const unit=catalog.skills['hell-s-pawn'].action!.combatUnits![0] as {
  effect:'summon';creature:string;ownerDerived:SummonOwnerDerivation;
  appearanceEffects:{effect:string;recipient:string;placement:string}[];
  ranks:{durationMs:number;simulationFrames?:{lastActiveFrame:number};attackRatePerThousand?:number}[]};
const frames=[180,240,330,450,480,510,540,570];
const rates=[1052,1152,1302,1502,1552,1602,1652,1702];

test('eight ranks keep the native lifetime input as frames and their magic attack rate',()=>{
  unit.ranks.forEach((rank,index)=>{
    assert.equal(rank.simulationFrames?.lastActiveFrame,frames[index],`rank ${index+1}`);
    assert.equal(rank.durationMs,(frames[index]+1)*60);
    assert.equal(rank.attackRatePerThousand,rates[index]);
  });
  assert.deepEqual(unit.ownerDerived,{attack:{attribute:'magicAttack',perLevel:4,flat:12},
    health:{perLevel:90,flat:800},physicalResistanceBonus:70,magicResistance:180});
  assert.deepEqual(unit.appearanceEffects,[{effect:'smoke-puff',recipient:'target',placement:'attached'},
    {effect:'slash-arc',recipient:'target',placement:'attached'}]);
  assert.equal(unit.creature,'enemy-hell-s-pawn-1');
});

test('the pawn derives attack, health and resistances from its owner level',()=>{
  assert.deepEqual(summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:rates[0]},10),
    {magicAttack:54,maxHealth:1700,physicalResistanceBonus:70,magicResistance:180});
  assert.equal(summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:rates[7]},10).magicAttack,88);
  // 倍率本身不含 +1000：若按 2052 计算，10 级一级会得到 106 而不是 54。
  assert.notEqual(summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:1052},10).magicAttack,106);
  assert.equal(summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:rates[0]},1).magicAttack,16);
  assert.equal(summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:rates[0]},1).maxHealth,890);
});

test('a placed summon reports the derived stats over its own template',()=>{
  const definition=catalog.enemies.find(enemy=>enemy.id==='enemy-hell-s-pawn-1')!;
  const roster=new EnemyRoster(),placed=roster.placeEnemy(definition.id,0,0);
  placed.summonedBy='player';placed.level=10;
  const template=roster.enemySnapshot(placed.key,definition)!;
  placed.summonedStats=summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:rates[0]},10);
  const derived=roster.enemySnapshot(placed.key,definition)!;
  assert.equal(derived.maxHealth,1700);assert.equal(derived.health,1700);
  assert.equal(derived.magicAttack,54);assert.equal(derived.physicalResistanceBonus,70);
  assert.equal(derived.magicResistance,180);
  assert.notEqual(template.maxHealth,derived.maxHealth);
  assert.equal(derived.physicalAttack,template.physicalAttack);
});

test('summoning clears every active summon of the same owner, not just the same skill',async ()=>{
  const items=loadItemCatalog();
  const statsCatalog=loadCharacterStatsCatalog();
  const campaign=loadCampaignCatalog();
  const companions=loadCompanionCatalog();
  const hero=new BattleCharacter('warlock',statsCatalog,items);
  const session=new Session(campaign,undefined,undefined,items,hero,catalog,statsCatalog,companions);
  session.skills.maxAll();
  session.skills.bar().assign(0,0,{kind:'skill',id:'hell-s-pawn'});
  session.bag.add('mercenary-emblem-black-knight');
  const ally=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  session.party!.deployFirstAvailable(ally.id);
  const actor=catalog.classes.find(entry=>entry.id===ally.classId)!.actor;
  const phaserScene=createFakePhaserScene({
    cameras:{main:{width:640,height:360,zoomX:1,zoomY:1,worldView:undefined,followOffset:{x:0,y:0},setFollowOffset(){}}},
    tweens:{add:()=>({stop(){},pause(){},resume(){}}),getTweensOf:()=>[],killTweensOf:()=>{}},
  });
  const world=await createTestWorldCombat({
    hero,session,phaserScene,battleCatalog:catalog,
    appOverrides:{world:{actors:{[ally.definition.actor]:actor,[actor.id]:actor}} as never},
  });
  await world.combat.start();
  const base=world.combat.captureState();
  const summonState=(ownerId:string,role:'hell-soldier'|'beast')=>({
    kind:'friendly-summon' as const,
    state:{ownerId,role,state:'idle' as const,returning:false,clock:0,accumulator:0,
      nextDecisionAt:0,nextSearchAt:0,nextRecallAt:0,nextFollowSearchAt:0,targetSince:0,path:[],followActive:false,
      failedTargets:[],checkedTargets:[],fallbackTargets:[],farElapsed:0,stuckElapsed:0,followUnreachable:false,followSlot:0},
  });
  await world.combat.restoreState({
    ...base,
    roster:{
      enemies:[
        {key:'a',enemyId:'enemy-hell-s-pawn-1',x:96,y:64,summonedBy:'player',summonedBySkill:'hell-s-pawn'},
        {key:'b',enemyId:'enemy-beast-companion-1',x:112,y:64,summonedBy:'player',summonedBySkill:'beast-companion'},
        {key:'c',enemyId:'enemy-hell-s-pawn-1',x:128,y:64,summonedBy:ally.id,summonedBySkill:'hell-s-pawn'},
      ],
      sequence:3,partySize:2,
    },
    conditions:new CombatConditions().captureState(),
    enemies:[
      {id:'a',facing:'south',ai:summonState('player','hell-soldier'),summonRemainingMs:10000},
      {id:'b',facing:'south',ai:summonState('player','beast'),summonRemainingMs:10000},
      {id:'c',facing:'south',ai:summonState(ally.id,'hell-soldier'),summonRemainingMs:10000},
    ],
    summonGroups:[['player',['a','b']],[ally.id,['c']]],
  });
  world.combat.attack('hell-s-pawn');
  for(let step=0;step<7;step++)world.combat.update(60,true);
  const after=world.combat.captureState();
  const playerGroup=after.summonGroups.find(([owner])=>owner==='player')?.[1]??[];
  const allyGroup=after.summonGroups.find(([owner])=>owner===ally.id)?.[1]??[];
  assert.equal(playerGroup.length,1);
  assert.ok(!playerGroup.includes('a')&&!playerGroup.includes('b'));
  assert.deepEqual(allyGroup,['c']);
  assert.ok(!after.enemies.some(enemy=>enemy.id==='a'||enemy.id==='b'));
  assert.ok(after.enemies.some(enemy=>enemy.id==='c'));
  world.combat.destroy();
});
