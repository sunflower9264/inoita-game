import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {ActionDispatchDefinition,BattleCatalog,EnemyPlayableSkill} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {CombatController,type ActionPlayback,type Combatant,type CombatPort,type SkillUnitHit} from '../src/domain/combat.ts';
import type {EquipmentSlot,ItemCatalog} from '../src/domain/items.ts';
import type {PhysicalFighter,PhysicalHit} from '../src/domain/physical-hit.ts';
import {costumeRecipe,type WardrobeCatalog} from '../src/domain/wardrobe.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const wardrobe=JSON.parse(readFileSync(new URL('../public/content/wardrobe.json',import.meta.url),'utf8')) as WardrobeCatalog;
const items=JSON.parse(readFileSync(new URL('../public/content/items.json',import.meta.url),'utf8')) as ItemCatalog;
const skill=catalog.skills['rush-of-anger'];
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
const primary={strength:13,dexterity:0,vitality:0,intelligence:0,mentality:0};
const base:PhysicalFighter={level:10,physicalAttack:101,magicAttack:0,maxHealth:10000,hitBase:100,hitBonus:0,
  evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,
  weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
type Entry='manual'|'ai';
type Weapon='longsword'|'two-handed';
// ACT65 公式641：一级 a=1，主角 b=1、佣兵 b=2；STR权重先截断。
const firstRankDamage=(entry:Entry)=>Math.trunc((101+Math.trunc(13*12/10))
  *Math.trunc((4000+(1+20*(entry==='manual'?1:2))*10)/2)/1000);

function fixture(entry:Entry,weapon:Weapon,canStand:(position:{x:number;y:number})=>boolean=()=>true){
  const casterId=entry==='manual'?'player':'ally';
  const weaponId=Object.keys(items.items).find(id=>items.items[id].kind===weapon&&wardrobe.equipment[id]);
  assert.ok(weaponId,`missing ${weapon} equipment source`);
  const equipment:Partial<Record<EquipmentSlot,string>>={'main-hand':weaponId};
  const recipe=costumeRecipe(wardrobe,items,equipment,'warrior');
  const caster:Combatant={id:casterId,team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}};
  const target:Combatant={...caster,id:'enemy',team:'hostile',position:{x:16,y:0}};
  const actors=new Map([caster,target].map(actor=>[actor.id,actor]));
  const conditions=new CombatConditions(),resolution=new CombatHitResolution(),targetFighter={...base};
  const hits:PhysicalHit[]=[],attempts:SkillUnitHit[]=[],played:ActionPlayback[]=[],events:string[]=[],sounds:string[]=[];
  const relocations:{x:number;y:number}[]=[];
  const configuration={isEquipped:(id:string)=>id===skill.id,draft:()=>({levels:{[skill.id]:1}})};
  const bag={equipmentFor:()=>equipment,equipmentItems:(value:typeof equipment=equipment)=>value,get:(id:string)=>({id,item:id})};
  const member={classId:'warrior',level:10,skills:configuration,bag,
    panel:{...base,baseDefense:0,defenseRate:0,baseMagicResistance:0,attributes:primary},
    player:{health:10000,maxHealth:10000,mana:100,maxMana:100}};
  // The AI member owns its attributes; the controlled hero has deliberately different damage.
  const hero=entry==='manual'?member:{...member,panel:{...member.panel,physicalAttack:999,attributes:{...primary,strength:99}}};
  const host=Object.setPrototypeOf({hero,conditions,hitResolution:resolution,pendingDefeats:new Set(),fallen:new Set(),
    scene:{canCombatControl:true},app:{battleCatalog:catalog,wardrobe,items,
      session:{skills:configuration,party:{controlledId:'player',groupModifiers:()=>({})}},
      audio:{effect:(name:string)=>{sounds.push(name);events.push(`sound:${name}`);}},
      ui:{toast:()=>assert.fail('valid equipment rejected')}},
    feedback:{startShake:()=>events.push('shake'),vibrate:(duration:number)=>events.push(`vibration:${duration}`)},
    arena:[{key:'enemy',definition:{}}],memberOf:(id:string)=>id===casterId?member:id==='player'?hero:undefined,
    partyPassives:()=>[],enemyFighter:()=>targetFighter,roster:{enemySnapshot:()=>({...targetFighter,health:10000,mana:100,maxMana:100})},
    combatant:(id:string)=>actors.get(id),resolveHitReactions:()=>{},dropMana:()=>{},
    settleHit:(_hit:SkillUnitHit,value:PhysicalHit)=>{hits.push(value);events.push(`hit:${value.kind}:${value.damage}`);},
    applyStateConsequences:(id:string,states:string[])=>events.push(`state:${id}:${states.join(',')}`),
  },WorldCombat.prototype);
  const presenter=Object.setPrototypeOf({pose:()=>{},candidates:()=>[...actors.values()],
    visual:(id:string)=>{const actor=actors.get(id);return actor?{container:{active:true,...actor.position}}:undefined;},
    placedEffect:()=>{},scene:{events:{emit:(name:string,event:{name:string;recipientId:string})=>{
      if(name==='skill-effect')events.push(`effect:${event.name}:${event.recipientId}`);
    }}},
  },CombatPresenter.prototype);
  let frame=(_index:number)=>{},spent=0;
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor(casterId),
    actor:id=>actors.get(id),candidates:()=>[...actors.values()],facing:()=> 'east',
    moveToward:()=>assert.fail('nearby target should not require approach'),stop:()=>{},canStand,
    // 位移技能只认整盒判定；夹具把同一谓词当作整盒可站性。
    canPlaceBody:canStand,
    relocate:position=>{relocations.push({...position});caster.position={...position};},clearEffects:()=>{},
    canSpendMana:cost=>member.player.mana>=cost,spendMana:cost=>{spent+=cost;member.player.mana-=cost;return true;},
    play:(action,onFrame)=>{played.push(action);frame=onFrame;return ()=>{};},
    frame:(action,index,contact,ready,area)=>dispatchFrame(presenter,action,index,contact,ready,()=>{},(definition:ActionDispatchDefinition,work:()=>void,after?:()=>void)=>method('runActionDispatch').call(host,action,definition,work,after),area),
    prepareUnit:event=>method('prepareSkillUnit').call(host,event),
    runUnitSequence:work=>resolution.run(work),
    unit:hit=>{attempts.push(hit);return method('skillUnit').call(host,hit);},
    unitFeedback:(hit,outcome,cue)=>presenter.showUnitFeedback(hit,outcome,cue),
  };
  const combat=new CombatController(casterId,null,port);host.combat=combat;
  Reflect.get(host,'runtime').registerActor(casterId,combat);
  combat.selectTarget('enemy');
  const start=()=>{
    if(entry==='manual')method('attack').call(host,skill.id);
    else{
      const available=method('partySkillsFor').call(host,casterId) as EnemyPlayableSkill[];
      const selected=available.find(value=>value.id===skill.id);assert.ok(selected);
      assert.equal(combat.request(selected,'enemy'),'started');
    }
    assert.equal(combat.snapshot().state,'attacking');assert.equal(played.length,1);
  };
  return {entry,weapon,casterId,recipe,conditions,target,targetFighter,hits,attempts,played,events,sounds,relocations,combat,member,start,host,
    fire:()=>{frame(3);frame(3);},spent:()=>spent,
    injectSkillBonus:()=>{
      // Controlled assembly probe: this does not claim a warrior can normally learn Dark Strike.
      const unit=catalog.skills['dark-strike'].action!.combatUnits!.find(unit=>unit.effect==='buff');
      assert.ok(unit?.effect==='buff');const rank=unit.ranks[0];
      conditions.applyBuff(casterId,'dark-strike',rank.strength,rank.effect,'test-probe');
    }};
}

test('manual and AI equipment entries resolve Rush of Anger damage, target aura and stun through the real dispatch',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const entry of ['manual','ai'] as const)for(const weapon of ['longsword','two-handed'] as const){
    const f=fixture(entry,weapon);f.start();
    const action=f.played[0].skill!.action;assert.equal(action.usesSkillDamageBuff,true);
    if(entry==='manual')assert.deepEqual(action.events,(f.recipe.actions[skill.id]??skill.action!).events);
    assert.equal(f.spent(),40);assert.equal(f.member.player.mana,60);
    assert.equal(f.combat.snapshot().cooldowns[skill.id].remainingMs,3600);
    f.fire();assert.deepEqual(f.hits,[{kind:'hit',damage:firstRankDamage(entry)}],`${entry}/${weapon}`);
    assert.deepEqual(f.attempts.map(hit=>[hit.cueIndex,hit.casterId,hit.targetId]),[[0,f.casterId,'enemy'],[1,f.casterId,'enemy']]);
    assert.equal(f.conditions.hasState('enemy','stun'),true);assert.equal(f.conditions.hasState(f.casterId,'stun'),false);
    assert.deepEqual(f.events.slice(0,3),[`hit:hit:${firstRankDamage(entry)}`,'effect:rage-aura:enemy','state:enemy:stun']);
    // 佣兵和主角同属玩家阵营：技能派发音效不只给当前操控角色。
    assert.deepEqual(f.sounds,['Wa_Anger_Rush']);
  }
});

test('equipment merges retain and consume the skill bonus for both manual and AI paths',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const entry of ['manual','ai'] as const)for(const weapon of ['longsword','two-handed'] as const){
    const f=fixture(entry,weapon);f.injectSkillBonus();f.start();f.fire();
    assert.equal(f.played[0].skill!.action.usesSkillDamageBuff,true);
    assert.deepEqual(f.hits,[{kind:'hit',damage:Math.trunc(firstRankDamage(entry)*1210/1000)}],`${entry}/${weapon}: own growth then 210-per-thousand probe bonus`);
    assert.equal(f.conditions.hasBuff(f.casterId,'dark-strike'),false);
  }
});

test('misses and non-miss zero damage skip Rush of Anger aura and the later stun',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const entry of ['manual','ai'] as const)for(const outcome of ['miss','zero'] as const){
    const f=fixture(entry,entry==='manual'?'longsword':'two-handed');f.injectSkillBonus();
    if(outcome==='miss')f.targetFighter.evasionBonus=750;else f.targetFighter.physicalResistance=1000;
    f.start();f.fire();
    assert.deepEqual(f.hits,[{kind:outcome==='miss'?'miss':'hit',damage:0}]);
    assert.deepEqual(f.attempts.map(hit=>hit.cueIndex),[0]);
    assert.equal(f.conditions.hasState('enemy','stun'),false);
    assert.equal(f.events.some(event=>event.startsWith('effect:')),false);
    assert.equal(f.conditions.hasBuff(f.casterId,'dark-strike'),outcome==='miss');
    assert.ok(f.events.includes('shake'));assert.ok(f.events.includes('vibration:150'));
  }
});

test('positive weapon and shield blocks still emit the target aura and apply stun',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const block of ['weapon-block','shield-block'] as const){
    const f=fixture(block==='weapon-block'?'manual':'ai',block==='weapon-block'?'longsword':'two-handed');
    if(block==='weapon-block')f.targetFighter.weaponBlock=500;else f.targetFighter.shieldBlock=500;
    f.start();f.fire();
    // 佣兵基础 255，盾挡减伤 floor(1000*1000/1260)=793‰，得到 52。
    assert.deepEqual(f.hits,[{kind:block,damage:block==='weapon-block'?170:52}]);
    assert.deepEqual(f.attempts.map(hit=>hit.cueIndex),[0,1]);
    assert.equal(f.conditions.hasState('enemy','stun'),true);
    assert.ok(f.events.includes('effect:rage-aura:enemy'));
  }
});

test('a second active skill input is ignored before it reaches the runtime while the first is playing',t=>{
  const f=fixture('manual','longsword');f.start();
  const request=t.mock.method(f.combat,'requestManualSkill');
  method('attack').call(f.host,skill.id);
  assert.equal(request.mock.callCount(),0,'技能播放期间不再提交第二个技能请求');
  assert.equal(f.played.length,1);
});

test('a close charge advances to the farthest standable point before the obstacle',t=>{
  t.mock.method(Math,'random',()=>0.2);
  // 8px 冲刺的终点被挡住，但前方 5px 还能站：冲到 5px 停下，而不是整段跳过。
  const f=fixture('manual','longsword',position=>position.x<=5);
  assert.doesNotThrow(()=>{f.start();f.fire();});
  // 到达帧仍按原样落到保存的目的地 (0,0)。
  assert.deepEqual(f.relocations,[{x:5,y:0},{x:0,y:0}]);
  assert.deepEqual(f.hits,[{kind:'hit',damage:firstRankDamage('manual')}]);
  assert.ok(f.played.length===1);
});

test('a close charge whose whole lunge path is blocked stays in place instead of throwing',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const f=fixture('manual','longsword',position=>position.x===0&&position.y===0);
  assert.doesNotThrow(()=>{f.start();f.fire();});
  assert.deepEqual(f.relocations,[{x:0,y:0}]);
  assert.deepEqual(f.hits,[{kind:'hit',damage:firstRankDamage('manual')}]);
});

test('a skill relocation blocked for the whole body stays put instead of teleporting elsewhere',()=>{
  const placed:{x:number;y:number}[]=[];
  const visual={container:{visible:true},entity:{id:'hero'}};
  const actor={shape:()=>({})};
  const host=Object.setPrototypeOf({relocationFailures:[],movement:{
    place:(_visual:unknown,point:{x:number;y:number})=>placed.push({...point}),
    actor:()=>actor,
    navigation:{canPlaceBody:(_shape:unknown,point:{x:number;y:number})=>point.x===3&&point.y===4,
      terrainFree:()=>false,bodyTerrainFree:()=>false},
  }},WorldCombat.prototype);
  const relocate=method('relocateVisual');
  assert.equal(relocate.call(host,visual,{x:8,y:0}),false);
  assert.deepEqual(placed,[],'整盒站不下时保持原位，不到目标点附近迁就');
  assert.deepEqual(host.relocationFailures,[{id:'hero',position:{x:8,y:0}}]);
  assert.equal(relocate.call(host,visual,{x:3,y:4}),true);
  assert.deepEqual(placed,[{x:3,y:4}],'复核通过的保底落点仍然生效');
});

test('the current target remains the recipient when it moves beyond the cue range after charge starts',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const f=fixture('manual','longsword');f.start();f.target.position={x:1000,y:0};f.fire();
  assert.deepEqual(f.hits,[{kind:'hit',damage:244}]);
  assert.deepEqual(f.attempts.map(hit=>hit.targetId),['enemy','enemy']);
  assert.equal(f.conditions.hasState('enemy','stun'),true);
  assert.ok(f.events.includes('effect:rage-aura:enemy'));
});
