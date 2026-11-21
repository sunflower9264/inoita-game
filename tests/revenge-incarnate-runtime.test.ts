import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const read=(file:string)=>JSON.parse(readFileSync(new URL(`../public/content/${file}.json`,import.meta.url),'utf8'));
const catalog=read('battle') as BattleCatalog,items=read('items') as ItemCatalog,stats=read('character-stats') as CharacterStatsCatalog;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
function fixture(){
  const hero=new BattleCharacter('warrior',stats,items),ally=new BattleCharacter('warrior',stats,items);
  let rank=0,allyRank=1;
  const configuration=(value:()=>number)=>({get version(){return value();},draft:()=>({levels:{'revenge-incarnate':value()}})});
  Object.assign(ally,{skills:configuration(()=>allyRank)});
  const conditions=new CombatConditions(),order:string[]=[];
  const host=Object.setPrototypeOf({hero,conditions,hitResolution:new CombatHitResolution(),arena:[],allies:[],
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    pendingDefeats:new Set(),fallen:new Set(),
    app:{battleCatalog:catalog,items,session:{skills:configuration(()=>rank),
      party:{activeIds:['player','ally'],groupModifiers:()=>({})}}},
    memberOf:(id:string)=>id==='player'?hero:id==='ally'?ally:undefined,
    attackProc:()=>{},applyStateConsequences:()=>{},showBuffApplication:()=>assert.fail('Revenge has no application effect'),
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const contact=(targetId='ally',kind:PhysicalHit['kind']='hit',damageKind:'physical'|'magic'='physical',damage=0)=>
    call('resolveHitReactions',{casterId:targetId==='player'?'ally':'player',targetId},{kind,damage},damageKind,'basic-attack',hero);
  const attribute=(key:string,id='ally')=>call('actorAttribute',id,key) as number;
  const buff=()=>conditions.snapshot('ally').find(entry=>entry.id==='revenge-incarnate');
  return {host,hero,ally,conditions,order,call,contact,attribute,buff,
    learn:(value:number)=>{rank=value;},learnAlly:(value:number)=>{allyRank=value;}};
}

test('each defender’s learned rank supplies the chance and its own five physical damage stacks',t=>{
  t.mock.method(Math,'random',()=>0);
  // Buff45 原式：trunc((400+(30+20*b)*10)/20)，b 取佣兵训练列。
  const companionRates=[2,4,6,8,9,10,11,12].map(b=>Math.trunc((400+(30+20*b)*10)/20));
  for(const [index,rate] of companionRates.entries()){
    const f=fixture();f.learnAlly(index+1);assert.equal(f.attribute('revengeChance'),100);
    for(let count=1;count<=7;count++){
      f.contact();assert.equal(f.attribute('physicalDamageRate'),Math.min(5,count)*rate);
      assert.equal(f.buff()!.sourceId,'ally');
    }
    assert.equal(f.attribute('physicalDamageRate','player'),0);
    assert.equal(f.attribute('magicDamageRate'),0);
    assert.equal(f.call('partyFighter','ally').physicalAttack,Math.trunc(f.ally.panel.physicalAttack*(1000+5*rate)/1000));
  }
  const f=fixture();f.learn(8);f.contact('player');f.contact('ally');
  assert.equal(f.attribute('physicalDamageRate','player'),165);assert.equal(f.attribute('physicalDamageRate'),55);
});

test('physical blocks and zero damage qualify while misses, magic and unlearned zero chance consume no revenge roll',t=>{
  for(const damageKind of ['physical','magic'] as const)for(const outcome of ['hit','critical','weapon-block','shield-block','miss'] as const){
    const f=fixture();let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return 0;});
    f.contact('ally',outcome,damageKind,0);const accepts=damageKind==='physical'&&outcome!=='miss';
    // 物理成功还会消耗残影的无条件抽签（没学也抽），所以接受时是两次。
    assert.equal(rolls,accepts?2:0,`${damageKind}:${outcome}`);assert.equal(!!f.buff(),accepts);
  }
  // 没学过时自己的概率判定不抽签；物理成功仍会消耗残影那一次无条件抽签。
  const f=fixture();f.learnAlly(0);let draws=0;t.mock.method(Math,'random',()=>{draws++;return 0;});
  assert.equal(f.attribute('revengeChance'),0);f.contact();
  assert.equal(draws,1,'只有残影的抽签');assert.equal(f.buff(),undefined);
});

test('the defender’s current learned rank is read only after a successful strict roll, including explicit cached chance',t=>{
  const f=fixture();let reads=0,rolls=0;
  const learned=f.host.learnedReactionBuff.bind(f.host);
  f.host.learnedReactionBuff=(...args:unknown[])=>{reads++;return learned(...args);};
  t.mock.method(Math,'random',()=>{rolls++;return (100-.5)/999;});f.contact();
  assert.equal(reads,0);assert.equal(rolls,2,'一次残影、一次复仇');assert.equal(f.buff(),undefined);
  t.mock.method(Math,'random',()=>{rolls++;f.learnAlly(8);return (99-.5)/999;});f.contact();
  assert.equal(reads,1);assert.equal(f.attribute('physicalDamageRate'),155);
  f.conditions.removeBuff('ally','revenge-incarnate');f.learnAlly(0);
  f.conditions.setTemporaryAttribute('ally','revengeChance',1000);
  t.mock.method(Math,'random',()=>{rolls++;return .999;});f.contact();
  assert.equal(rolls,6);assert.equal(reads,2);assert.equal(f.buff(),undefined);
  f.conditions.setTemporaryAttribute('ally','revengeChance',-1);f.contact();assert.equal(rolls,7,'负阈值只消耗残影那一次');
});

test('strong refresh reprices existing stacks, weak refresh preserves the node, and the last native frame stays active',t=>{
  t.mock.method(Math,'random',()=>0);const f=fixture();f.contact();f.contact();
  assert.equal(f.attribute('physicalDamageRate'),110);f.conditions.update(600);
  f.learnAlly(8);f.contact();assert.equal(f.attribute('physicalDamageRate'),465);
  f.conditions.update(600);const before=f.buff();f.learnAlly(1);f.contact();assert.deepEqual(f.buff(),before);
  f.learnAlly(8);f.contact();assert.equal(f.attribute('physicalDamageRate'),620);
  f.conditions.update(91*60);assert.ok(f.buff());assert.equal(f.attribute('physicalDamageRate'),620);
  f.conditions.update(60);assert.equal(f.buff(),undefined);assert.equal(f.attribute('physicalDamageRate'),0);
});

test('the party storm completes before the defender’s revenge roll and reflection observes the accepted node',t=>{
  const f=fixture(),unit=catalog.skills['storm-of-frenzy'].action!.combatUnits![0];
  assert.equal(unit.effect,'buff');if(unit.effect!=='buff')throw new Error('missing storm parent');
  f.conditions.applyBuff('player',unit.buff,unit.ranks[0].strength,unit.ranks[0].effect);
  f.conditions.setTemporaryAttribute('ally','moltenReflectionPerThousand',100);
  const apply=f.host.applyActorBuff.bind(f.host);
  f.host.applyActorBuff=(...args:unknown[])=>{f.order.push(`${args[1]}:${args[0]}`);return apply(...args);};
  t.mock.method(Math,'random',()=>{f.order.push('revenge-roll');return 0;});
  f.host.moltenReflection=()=>f.order.push(`reflection:${f.attribute('physicalDamageRate')}`);
  // 残影的抽样在剑之灵魂/吸血之剑之后、反伤与队伍暴风之前（原版 17c98c），
  // 所以这一条抽签排在队伍暴风前面；队伍的暴风仍在防守方复仇抽签之前完成。
  f.contact();assert.deepEqual(f.order,['revenge-roll','storm-of-frenzy-power:player','storm-of-frenzy-power:ally',
    'revenge-roll','revenge-incarnate:ally','reflection:135']);
});
