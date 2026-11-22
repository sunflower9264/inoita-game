import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleBuffEffect,BattleCatalog} from '../src/domain/battle.ts';
import {CombatController,resolveCueTargets,type Combatant} from '../src/domain/combat.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import type {SkillAction} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const ambush=[catalog.skills['ambush'].action!.combatUnits!.find(unit=>unit.effect==='buff')!] as const;
if(ambush[0].effect!=='buff')throw new Error('missing ambush buff');
const child=(rank:number)=>catalog.skills['sniping'].reactionsByRank![rank-1]![0] as
  {kind:string;buff:{key:string;rankPriority:number;effect:BattleBuffEffect}};
const crits=[170,230,270,290,310,330,350,370];
const ranges=[4,7,9,10,11,12,13,14];

test('eight ranks add critical rate and original distance units, capped at 180 frames',()=>{
  for(let rank=1;rank<=8;rank++){
    assert.equal(child(rank).kind,'sniping');
    assert.equal(child(rank).buff.key,'sniping');
    assert.deepEqual(child(rank).buff.effect.modifiers,[
      {attribute:'criticalRate',operation:{kind:'add',amount:crits[rank-1]!}},
      {attribute:'attackRangeBonusUnits',operation:{kind:'add',amount:ranges[rank-1]!}}],`rank ${rank}`);
    assert.deepEqual(child(rank).buff.effect.simulationFrames,{lastActiveFrame:180},`rank ${rank}`);
    assert.equal(child(rank).buff.effect.maxStacks,1);
  }
});

test('the ambush buff only builds the child after it is accepted',()=>{
  assert.deepEqual(ambush[0].ranks[0]!.effect.onAccepted,
    [{kind:'apply-learned-buff',skill:'sniping',target:'source'}]);
});

function fixture(rank=1,increment=0){
  const conditions=new CombatConditions(),log:string[]=[];
  const member={classId:'assassin',player:{health:100,maxHealth:100,mana:0,maxMana:0},
    bag:{equipmentFor:()=>({}),get:()=>undefined},
    skills:{draft:()=>({levels:rank?{'sniping':rank}:{}})}};
  const host=Object.setPrototypeOf({app:{battleCatalog:catalog,session:{skills:member.skills}},
    conditions,arena:[],activeParty:['player'],fallen:new Set(),pendingDefeats:new Set(),
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),aiSkillCostCache:new Map(),
    memberOf:(id:string)=>id==='player'?member:undefined,applyStateConsequences:()=>{},partyPassives:()=>[],
    syncCombatResourceLimits:()=>{},showBuffApplication:()=>{},actorAttribute:()=>increment,
    applyAcceptedEffects:(function(this:unknown,...args:unknown[]){
      const [,,effect]=args as [string,string,BattleBuffEffect];
      if(effect.onAccepted?.length)log.push('accepted');
      return method('applyAcceptedEffects').apply(this,args);
    } as unknown as (...args:unknown[])=>void)},
    WorldCombat.prototype);
  const apply=(effect:BattleBuffEffect=ambush[0].ranks[0]!.effect,strength=ambush[0].ranks[0]!.strength)=>
    method('applyActorBuff').call(host,'player','ambush',strength,effect,'player');
  return {conditions,log,apply};
}

test('an accepted ambush gives the caster the sniping buff with its own cap',()=>{
  const run=fixture(8);
  assert.equal(run.apply(),true);
  assert.equal(run.conditions.attribute('player','criticalRate',0),370);
  assert.equal(run.conditions.attribute('player','attackRangeBonusUnits',0),14);
  // 狙击没有「复制父上限」的规则：埋伏自己的上限也是 180，这里用子自己的公式。
  assert.equal(run.conditions.buffLifetimeFrames('player','sniping'),180);
  assert.equal(run.conditions.buffLifetimeFrames('player','ambush'),180);
  assert.deepEqual(run.log,['accepted']);
});

test('without the passive a refused ambush leaves no buff behind',()=>{
  const unlearned=fixture(0);
  assert.equal(unlearned.apply(),true);
  assert.equal(unlearned.conditions.buffLifetimeFrames('player','sniping'),undefined);
  const refused=fixture(8);
  assert.equal(refused.apply(ambush[0].ranks[1]!.effect,ambush[0].ranks[1]!.strength),true);
  const before=refused.conditions.buffLifetimeFrames('player','sniping');
  assert.equal(refused.apply(ambush[0].ranks[0]!.effect,ambush[0].ranks[0]!.strength),false,'更低等级被拒');
  assert.equal(refused.conditions.buffLifetimeFrames('player','sniping'),before);
  assert.deepEqual(refused.log,['accepted'],'被拒绝时不执行接受钩子');
});

test('the range bonus widens the searched area by eight pixels per original unit',()=>{
  const actor=(id:string,team:string,x:number):Combatant=>({id,team,position:{x,y:0},bounds:{x:-4,y:-4,width:8,height:8}});
  const caster=actor('player','party',0),near=actor('near','enemy',144),far=actor('far','enemy',176);
  const cue={target:'area' as const,targetRangePx:152,targetRangeMetric:'octagonal-grid' as const};
  const candidates=[caster,near,far];
  assert.deepEqual(resolveCueTargets(cue,caster,near,candidates).map(target=>target.id),['near']);
  // 三级狙击 +9 个原版单位 = 72 像素，152+72=224，正好够到 176 像素外的那个人。
  assert.deepEqual(resolveCueTargets(cue,caster,near,candidates,[],9).map(target=>target.id),['near','far']);
  // 自身目标与零加成都保持原样。
  assert.deepEqual(resolveCueTargets({...cue,target:'self'},caster,near,candidates,[],14).map(target=>target.id),['player']);
  assert.deepEqual(resolveCueTargets(cue,caster,near,candidates,[],0).map(target=>target.id),['near']);
});

test('射程加成同样放宽起手搜索与追近，不改变面积技能的单元半径',()=>{
  const actor=(id:string,team:string,x:number):Combatant=>({id,team,position:{x,y:0},bounds:{x:-4,y:-4,width:8,height:8}});
  const caster=actor('player','party',0),enemy=actor('enemy','hostile',160);
  let bonus=0,moves=0;
  const port={cooldowns:new CombatCooldownStore(()=>0).forActor('player'),actor:(id:string)=>[caster,enemy].find(entry=>entry.id===id),
    candidates:()=>[caster,enemy],facing:()=> 'east' as const,moveToward:()=>{moves++;},stop:()=>{},canStand:()=>true,relocate:()=>{},
    clearEffects:()=>{},play:()=>()=>{},frame:()=>{},canSpendMana:()=>true,spendMana:()=>true,rangeBonusUnits:()=>bonus};
  const action={events:[{kind:'units' as const,frame:0,cues:[{target:'current' as const,targetRangePx:88,effects:[]}]}],
    cooldownFrames:0,approachDistanceUnits:14,searchRadiusPx:112,transition:null} as unknown as SkillAction;
  // 相距 160 像素时攻击距离是 21 个单位：超出 14，落在 14+9 之内。
  const plain=new CombatController('player',null,port);
  assert.equal(plain.request({id:'aimed-shot',action,level:1},'enemy'),'started');
  assert.equal(plain.snapshot().state,'approaching','没有加成要先追近');
  assert.equal(moves,1);
  bonus=9;
  const boosted=new CombatController('player',null,port);
  assert.equal(boosted.request({id:'aimed-shot',action,level:1},'enemy'),'started');
  assert.equal(boosted.snapshot().state,'attacking','加成后原地起手');
  assert.equal(moves,1,'没有新的追近');
  bonus=0;
  const far=actor('far','hostile',200);
  const searching=(rangeBonus:number)=>new CombatController('player',null,
    {...port,actor:(id:string)=>[caster,far].find(entry=>entry.id===id),candidates:()=>[caster,far],moveToward:()=>{},rangeBonusUnits:()=>rangeBonus});
  assert.equal(searching(0).request({id:'aimed-shot',action,level:1}),'no-target','200 像素在 112 的起手搜索半径之外');
  assert.equal(searching(11).request({id:'aimed-shot',action,level:1}),'started','+11 单位把搜索半径放宽到 200 像素');
});
