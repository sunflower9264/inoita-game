import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatThreatSystem,type CombatThreatActor,type CombatThreatPort} from '../src/domain/combat-threat-system.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
function fixture(){
  const actors=new Map<string,CombatThreatActor>(['attacker','competitor','other-team','defender','other-owner'].map(id=>[id,{
    id,team:id==='attacker'||id==='competitor'?'party':'hostile',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8},
    active:true,level:10,sightRangeUnits:8,tracksThreat:id==='defender'||id==='other-owner',
  }]));
  const reductions=new Map<string,number>(),taunts=new Map<string,string>(),events:string[]=[];
  const port:CombatThreatPort={actor:id=>actors.get(id),actors:()=>[...actors.values()],currentTarget:()=>undefined,
    logicTick:()=>9,generationRate:()=>assert.fail('redistribution consulted generation rate'),
    reductionRate:id=>{events.push(`reduction:${id}`);return reductions.get(id)??0;},normalDamage:()=>({physical:0,magic:0}),
    tauntSource:id=>taunts.get(id),applyTaunt:()=>{},combatStarted:id=>events.push(`combat:${id}`)};
  const threat=new CombatThreatSystem(port);
  const seed=(entries:[string,string,number][])=>threat.restoreState({entries:entries.map(([ownerId,sourceId,score])=>({ownerId,sourceId,score,updatedTick:1}))});
  const score=(id:string)=>threat.captureState().entries.find(entry=>entry.ownerId==='defender'&&entry.sourceId===id)?.score;
  return {actors,reductions,taunts,events,port,threat,seed,score};
}

test('roar redistributes only existing scores of the attacker faction using additive signed amounts',()=>{
  const f=fixture();f.seed([['defender','attacker',100],['defender','competitor',81],['defender','other-team',70],['other-owner','attacker',60]]);
  f.actors.get('attacker')!.active=false;f.actors.get('competitor')!.states=['stealthed'];
  f.threat.redistributeAfterPhysicalHit('attacker','defender',10);
  assert.equal(f.score('attacker'),230);assert.equal(f.score('competitor'),41);assert.equal(f.score('other-team'),70);
  assert.deepEqual(f.threat.captureState().entries.map(entry=>entry.updatedTick),[9,9,1,1]);
  f.threat.redistributeAfterPhysicalHit('attacker','defender',0);assert.equal(f.score('attacker'),460);assert.equal(f.score('competitor'),21);
  f.seed([['defender','competitor',81]]);f.threat.redistributeAfterPhysicalHit('attacker','defender',10);
  assert.equal(f.score('attacker'),undefined);assert.equal(f.score('competitor'),41);
});

test('each score update independently applies its source reduction and the defender taunt gate',()=>{
  const f=fixture();const initial:[string,string,number][]=[['defender','attacker',100],['defender','competitor',80]];
  f.seed(initial);f.reductions.set('attacker',500);f.reductions.set('competitor',500);
  f.threat.redistributeAfterPhysicalHit('attacker','defender',10);assert.equal(f.score('attacker'),165);assert.equal(f.score('competitor'),60);
  f.seed(initial);f.taunts.set('defender','competitor');f.events.length=0;
  f.threat.redistributeAfterPhysicalHit('attacker','defender',10);
  assert.equal(f.score('attacker'),100);assert.equal(f.score('competitor'),60);
  assert.deepEqual(f.events,['reduction:competitor','combat:defender']);
  assert.deepEqual(f.threat.captureState().entries.map(entry=>entry.updatedTick),[1,9]);
});

test('redistribution preserves signed overflow and negative scores until normal ledger cleanup',()=>{
  const f=fixture();f.seed([['defender','attacker',2147483640],['defender','competitor',-3]]);
  f.threat.redistributeAfterPhysicalHit('attacker','defender',10);
  assert.equal(f.score('attacker'),14);assert.equal(f.score('competitor'),-2);
  f.seed([['defender','attacker',100],['defender','competitor',80]]);f.reductions.set('attacker',2000);f.reductions.set('competitor',2000);
  f.threat.redistributeAfterPhysicalHit('attacker','defender',10);
  assert.equal(f.score('attacker'),-30);assert.equal(f.score('competitor'),120);
});

function worldFixture(){
  const f=fixture(),conditions=new CombatConditions();
  const unit=catalog.skills['shouts-of-threat'].action!.combatUnits!.find(unit=>unit.effect==='buff')!;assert.equal(unit.effect,'buff');
  const rank=unit.ranks[0];
  const apply=(id:string)=>conditions.applyBuff(id,unit.buff,rank.strength,rank.effect,'roar-caster');
  const host=Object.setPrototypeOf({conditions,threat:f.threat,hero:{},app:{session:{skills:{draft:()=>({levels:{}})}}},
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    actorAttribute:(_id:string,key:string)=>key==='moltenReflectionPerThousand'?1:0,
    equipmentRecovery:()=>({lifeDrainPerThousand:0}),
    react:(event:{kind:string})=>f.events.push(event.kind),
    partySide:()=>false,
    summonOwnerReactions:()=>{},
    moltenReflection:()=>f.events.push('reflection'),attackProc:()=>f.events.push('elements'),
  },WorldCombat.prototype);
  const hit=(kind:PhysicalHit['kind']='hit',damageKind:'physical'|'magic'='physical',damage=10)=>
    method('resolveHitReactions').call(host,{casterId:'attacker',targetId:'defender'},{kind,damage},damageKind,'basic-attack',host.hero);
  return {...f,conditions,apply,host,hit};
}

test('real physical success reads the attacker active roar debuff after reflection and before later attack effects',()=>{
  const f=worldFixture();f.seed([['defender','attacker',100]]);f.apply('defender');f.hit();assert.equal(f.score('attacker'),100);
  f.apply('attacker');f.events.length=0;f.hit();assert.equal(f.score('attacker'),230);
  assert.ok(f.events.indexOf('reflection')<f.events.indexOf('reduction:attacker'));
  assert.ok(f.events.indexOf('reduction:attacker')<f.events.indexOf('attack-effects'));
  assert.ok(f.events.indexOf('attack-effects')<f.events.indexOf('elements'));
  f.host.moltenReflection=()=>f.conditions.removeBuff('attacker','shouts-of-threat');f.hit();assert.equal(f.score('attacker'),230);
});

test('the roar reaction accepts every physical success including zero damage and expires with the current buff',()=>{
  for(const damageKind of ['physical','magic'] as const)for(const kind of ['hit','critical','weapon-block','shield-block','miss'] as const){
    const f=worldFixture();f.seed([['defender','attacker',100]]);f.apply('attacker');f.hit(kind,damageKind,0);
    assert.equal(f.score('attacker'),damageKind==='physical'&&kind!=='miss'?200:100,`${damageKind}:${kind}`);
  }
  const f=worldFixture();f.seed([['defender','attacker',100]]);f.apply('attacker');
  f.conditions.update(91*60);f.hit('hit','physical',0);assert.equal(f.score('attacker'),200);
  f.conditions.update(60);f.hit('hit','physical',0);assert.equal(f.score('attacker'),200);
});
