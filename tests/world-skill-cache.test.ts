import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {playerCombatAssets} from '../src/rendering/combat-assets.ts';
import {loadSceneAssets,missingSceneAssets} from '../src/rendering/scene-assets.ts';
import {Session} from '../src/domain/session.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveHitReactionPipeline,type HitReactionPort} from '../src/domain/combat-reaction-pipeline.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {Campaign} from '../src/domain/campaign.ts';
import type {ItemCatalog} from '../src/domain/items.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
hook.deregister();

const read=<T>(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;

function fixture(){
  const battle=read<BattleCatalog>('battle'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(read<Campaign>('campaign'),undefined,undefined,items,hero,battle);
  const host=Object.assign(Object.create(WorldCombat.prototype),{
    app:{battleCatalog:battle,items,session},hero,
    passivesCache:new Map(),skillTableCache:new Map(),equipmentRecoveryCache:new Map(),combatProcsCache:new Map(),
    aiSkillCostCache:new Map(),
    closed:false,
    playerSkillSignature:'',playerSkillGate:'',allySkillSignatures:new Map(),allySkillGates:new Map(),
    skillAssetFailures:new Map(),skillAssetRefreshRunning:false,skillAssetRefreshQueued:false,
    scene:{player:{actor:{id:'hero'}},time:{now:0,delayedCall:()=>({remove(){}})}},
    memberOf:(id:string)=>id==='player'?hero:session.party?.get(id),
    skillConfiguration:(id:string,member:{skills:unknown})=>id==='player'?session.skills:member.skills,
    conditions:{hasState:()=>false},
  });
  const invoke=(name:string,...args:unknown[])=>Reflect.get(WorldCombat.prototype,name).call(host,...args);
  return {session,host,invoke};
}

test('party passives are reused until a real input changes',t=>{
  const {session,host,invoke}=fixture();
  const equipment=t.mock.method(host.hero.bag,'equipmentItems');
  const before=session.skills.draftCalls;
  const first=invoke('partyPassives','player') as unknown[];
  const afterFirst=session.skills.draftCalls;
  assert.equal(afterFirst,before+1,'第一次计算要读一次技能配置');
  assert.equal(equipment.mock.callCount(),1);

  const second=invoke('partyPassives','player') as unknown[];
  assert.equal(session.skills.draftCalls,afterFirst,'输入没变时不再克隆技能配置');
  assert.equal(second,first,'命中缓存时返回同一份只读结果');
  assert.equal(equipment.mock.callCount(),1,'缓存命中时不重新整理装备');

  host.conditions.hasState=()=>true;
  invoke('partyPassives','player');
  assert.equal(session.skills.draftCalls,afterFirst+1,'潜行状态变化会失效一次');
  assert.equal(equipment.mock.callCount(),2);
  host.hero.bag.add('healing-potion-s');invoke('partyPassives','player');
  assert.equal(equipment.mock.callCount(),3,'背包变化后重新检查装备');
});

test('ordinary hit reactions reuse one skill description without cloning buff snapshots',t=>{
  const {session,host,invoke}=fixture(),conditions=new CombatConditions();
  host.conditions=conditions;
  t.mock.method(conditions,'buffReactions',()=>assert.fail('命中结算只读内部视图，不生成隔离副本'));
  let draws=0;t.mock.method(Math,'random',()=>{draws++;return 0.999;});
  const no=()=>{};
  const port:HitReactionPort={conditions,actorAttribute:()=>0,react:event=>invoke('react',event),
    reactToBuff:event=>invoke('reactToBuff',event),lightningOfHellReaction:no,godOfJusticeReaction:no,
    summonOwnerReactions:no,disturbanceReaction:no,partySide:()=>false,activePartySlots:()=>['player'],
    partyRevengeReactions:no,equipmentRecovery:()=>({lifeDrainPerThousand:0}),physicalSuccessEquipmentProcs:no,
    instantRecoveryOnMiss:no,isTwoHanded:()=>false,moltenReflection:no,holySacrificeTransfer:no,attackProc:no};
  const before=session.skills.draftCalls;
  const hit=()=>resolveHitReactionPipeline({casterId:'player',targetId:'enemy'},{kind:'hit',damage:12},'physical','basic-attack',port);
  hit();assert.equal(session.skills.draftCalls,before+1,'一击的三个技能反应阶段共用一份配置');
  for(let index=0;index<10;index++)hit();
  assert.equal(session.skills.draftCalls,before+1,'后续命中没有配置变化时继续复用');
  assert.equal(draws,11,'未学残影的每次物理命中仍按原顺序消耗一次随机数');
});

test('reaction skill descriptions follow configuration and asset readiness rather than health or stealth',()=>{
  const {session,host,invoke}=fixture(),catalog=host.app.battleCatalog as BattleCatalog;
  const initial=session.skills.draft(catalog,'dark-knight');
  host.preparedSkillIds=new Map([['player',new Set(Object.keys(initial.levels))]]);
  const first=invoke('reactionSkills','player'),before=session.skills.draftCalls;
  host.hero.setHealth(Math.max(1,host.hero.player.health-1));host.conditions.hasState=()=>true;
  assert.equal(invoke('reactionSkills','player'),first);
  assert.equal(session.skills.draftCalls,before,'生命和潜行不会重建静态反应定义');

  const learned={levels:{...initial.levels,'soul-sword':1,'dark-strike':1}};
  host.preparedSkillIds.set('player',new Set(['guardian-of-darkness']));
  session.skills.restoreState({loadouts:[['dark-knight',learned]],pages:[]});
  const waiting=invoke('reactionSkills','player');
  assert.equal(waiting.loadout.levels['soul-sword'],0);
  assert.equal(waiting.reactions.some((reaction:{kind:string})=>reaction.kind==='soul-sword'),false);
  host.preparedSkillIds.set('player',new Set(Object.keys(learned.levels)));
  const ready=invoke('reactionSkills','player');
  assert.equal(ready.loadout.levels['soul-sword'],1);
  assert.ok(ready.reactions.some((reaction:{kind:string})=>reaction.kind==='soul-sword'));
  assert.equal(session.skills.draft(catalog,'dark-knight').levels['soul-sword'],1,'素材过滤没有改写真实技能进度');
  assert.equal(invoke('reactionSkills','player'),ready);

  session.skills.reset();
  assert.equal(invoke('reactionSkills','player').loadout.levels['soul-sword'],0);
  session.skills.restoreState({loadouts:[['dark-knight',learned]],pages:[]});
  assert.equal(invoke('reactionSkills','player').loadout.levels['soul-sword'],1);
  const old=invoke('reactionSkills','player');
  invoke('forgetMemberCaches','player');
  assert.notEqual(invoke('reactionSkills','player'),old,'成员离场清掉持有的定义');
});

test('cached reactions read a child buff rank after the probability draw',t=>{
  const {session,host,invoke}=fixture(),catalog=host.app.battleCatalog as BattleCatalog;
  const initial=session.skills.draft(catalog,'dark-knight');
  const levels={...initial.levels,'soul-sword':1,'dark-strike':1};
  session.skills.restoreState({loadouts:[['dark-knight',{levels}]],pages:[]});
  host.preparedSkillIds=new Map([['player',new Set(Object.keys(levels))]]);
  const applied:unknown[]=[];
  host.applyActorBuff=(_target:string,_key:string,priority:number,effect:unknown)=>{applied.push({priority,effect});return true;};
  host.presenterFor=()=>undefined;
  t.mock.method(Math,'random',()=>{
    session.skills.restoreState({loadouts:[['dark-knight',{levels:{...levels,'dark-strike':8}}]],pages:[]});
    return 0;
  });
  invoke('react',{kind:'attack-success',ownerId:'player',opponentId:'enemy',damageKind:'physical',outcome:'hit',hitDamage:10,otherLifeDrainPerThousand:0});
  const unit=catalog.skills['dark-strike'].action!.combatUnits!.find(unit=>unit.effect==='buff');
  assert.ok(unit?.effect==='buff');
  assert.deepEqual(applied,[{priority:unit.ranks[7].strength,effect:unit.ranks[7].effect}]);
});

test('skill asset refresh uses cheap gates and ignores health changes',async()=>{
  const {host,invoke}=fixture();
  const calls:unknown[][]=[];
  const anyHost=host as any;
  anyHost.refreshSkillAssets=(signature:string|undefined,gate:string,allies:unknown[])=>{
    calls.push([signature,gate,allies]);return Promise.resolve();
  };
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  const schedule=()=>invoke('scheduleSkillAssetRefresh');

  schedule();await settle();
  assert.equal(calls.length,1,'第一次发现签名变化时补载一次');

  anyHost.playerSkillSignature=invoke('playerSkillSignatureNow');
  anyHost.playerSkillGate=invoke('playerSkillGateNow');
  schedule();await settle();
  assert.equal(calls.length,1,'门控和签名都没变时不重复补载');

  host.hero.setMana(1);host.hero.setHealth(host.hero.player.maxHealth-1);
  schedule();await settle();
  assert.equal(calls.length,1,'掉血回蓝不触发补载');

  const ring=Object.entries(host.app.items.items as ItemCatalog['items']).find(([,item])=>item.equipment?.slot==='ring'&&!item.equipment.locked)![0];
  host.hero.bag.addEquipped(ring,'ring','player',host.hero.classId);
  schedule();await settle();
  assert.equal(calls.length,1,'饰品属性变化不重新准备技能贴图');

  host.hero.bag.addEquipped('basic-dagger','main-hand','player',host.hero.classId);
  schedule();await settle();
  assert.equal(calls.length,2,'换武器才补载');
});


test('learning guardian while a companion owns its textures survives companion departure',async()=>{
  const {host,session,invoke}=fixture();
  const catalog=host.app.battleCatalog;
  const actor=catalog.classes.find((entry:{id:string})=>entry.id==='dark-knight')!.actor;
  host.app.wardrobe=read<WardrobeCatalog>('wardrobe');
  host.scene.player.actor=actor;
  host.extraSkillLeases=new Map();
  host.allies=[];
  const learned=new Set(['dark-strike','guardian-of-darkness']);
  session.skills.draft=()=>({levels:Object.fromEntries([...learned].map(id=>[id,1]))});
  const plan=playerCombatAssets({catalog,wardrobe:host.app.wardrobe,items:host.app.items,hero:host.hero,actor,learnedSkills:learned});
  const textures=new Set(plan.map(asset=>asset.key));
  host.scene.events=new EventEmitter();
  host.scene.textures={exists:(key:string)=>textures.has(key),get:()=>({has:()=>true}),remove:(key:string)=>textures.delete(key)};
  host.scene.anims={exists:()=>false,remove(){}};
  host.scene.load={start(){throw new Error('cached textures must not download again');}};
  const companion=await loadSceneAssets(host.scene,plan,()=>{});
  host.preparedSkillIds=new Map([['player',new Set(['dark-strike'])]]);
  let finishAppearance!:()=>void;
  host.scene.preparePlayerAppearance=()=>new Promise<void>(resolve=>{finishAppearance=resolve;});
  const refreshing=invoke('refreshSkillAssets',invoke('playerSkillSignatureNow'),invoke('playerSkillGateNow'),[]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(host.preparedSkillIds.get('player').has('guardian-of-darkness'),false,'新动作合成完成前不能使用新技能');
  finishAppearance();await refreshing;
  assert.equal(host.preparedSkillIds.get('player').has('guardian-of-darkness'),true);
  companion.release();
  assert.equal(missingSceneAssets(host.scene,plan).length,0,'主角必须独立持有已由佣兵下载的完整素材');
  invoke('releaseSkillLeases','player');
  assert.equal(textures.size,0,'最后一名使用者释放后回收贴图');
});


test('pending new skills cannot start while previously prepared skills remain available',()=>{
  const {host,invoke}=fixture();
  host.preparedSkillIds=new Map([['player',new Set(['dark-strike'])]]);
  host.scheduleSkillAssetRefresh=()=>{};
  const action=host.app.battleCatalog.skills['dark-strike'].action!;
  const mana=host.hero.player.mana;
  assert.equal(invoke('canSelectSkill','player',{id:'guardian-of-darkness',action}),false);
  assert.equal(invoke('canSelectSkill','player',{id:'dark-strike',action}),true);
  assert.equal(host.hero.player.mana,mana);
  host.preparedSkillIds.get('player').add('guardian-of-darkness');
  assert.equal(invoke('canSelectSkill','player',{id:'guardian-of-darkness',action}),true);
});

test('combat sound preparation replaces the complete current learned skill and weapon range',()=>{
  const {host,session,invoke}=fixture();
  host.app.wardrobe=read<WardrobeCatalog>('wardrobe');
  host.roster={spawns:[]};host.scene.combatEnemyIds=()=>[];
  let prepared:{skills:string[];weapons:string[];enemies:string[]}|undefined;
  host.app.audio={prepareCombat:(skills:Iterable<string>,_sounds:Iterable<string>,options:{weaponKinds:Iterable<string>;enemyIds:Iterable<string>})=>{
    prepared={skills:[...skills],weapons:[...options.weaponKinds],enemies:[...options.enemyIds]};return Promise.resolve();
  }};
  session.skills.draft=()=>({levels:{'dark-strike':1}});
  invoke('prepareCombatSounds');
  assert.deepEqual(prepared!.skills,['dark-strike']);
  const equipped=host.hero.bag.equipmentItems(host.hero.bag.equipmentFor('player'));
  assert.ok(prepared!.weapons.includes(host.app.items.items[equipped['main-hand']!].kind));
  assert.deepEqual(prepared!.enemies,[]);
  session.skills.draft=()=>({levels:{'guardian-of-darkness':1}});
  invoke('prepareCombatSounds');
  assert.deepEqual(prepared!.skills,['guardian-of-darkness']);
});

test('departed owners clear failed retries even without a completed asset lease',()=>{
  const {host,invoke}=fixture();
  host.extraSkillLeases=new Map();host.preparedSkillIds=new Map([['departed',new Set(['heal'])]]);
  host.skillAssetFailures.set('departed',{signature:'old',attempts:1,nextAt:0});
  invoke('releaseSkillLeases','departed');
  assert.equal(host.preparedSkillIds.has('departed'),false);
  assert.equal(host.skillAssetFailures.size,0);
  let timers=0;host.scene.time.delayedCall=()=>{timers++;return {remove(){}};};
  host.skillAssetFailures.set('late-departure',{signature:'old',attempts:1,nextAt:0});
  invoke('scheduleSkillAssetRetry');
  assert.equal(timers,0,'离队的失败记录不会持续产生零延迟定时器');
  assert.equal(host.skillAssetFailures.size,0);
});

test('blood thirst waits for its reaction assets before applying recovery and effects',()=>{
  const {host,invoke}=fixture();
  host.preparedSkillIds=new Map([['player',new Set<string>()]]);
  const effects:string[]=[],healing:number[]=[];
  host.actorAttribute=()=>10;host.restoreHealth=(_id:string,value:number)=>healing.push(value);
  host.restoreMana=()=>{};host.presenterFor=()=>({showEffects:(_id:string,values:{effect:string}[])=>effects.push(...values.map(value=>value.effect))});
  const event={kind:'blood-thirst',ownerId:'player',opponentId:'enemy',damageKind:'physical',outcome:'hit',hitDamage:1000,chanceThreshold:1000};
  invoke('react',event);assert.deepEqual(effects,[]);assert.deepEqual(healing,[]);
  host.preparedSkillIds.get('player').add('blood-thirst');
  invoke('react',event);assert.deepEqual(effects,['life-drain','mana-recovery']);assert.deepEqual(healing,[10]);
});

function pendingAllyFixture(){
  const {host,invoke}=fixture();
  host.app.wardrobe=read<WardrobeCatalog>('wardrobe');
  const actor=host.app.battleCatalog.classes.find((value:{id:string})=>value.id==='dark-knight')!.actor;
  const member={id:'ally',classId:'dark-knight',definition:{actor:actor.id},skills:{draft:()=>({levels:{'dark-strike':1}})}};
  const activeIds=['player','ally'];
  host.app.session={party:{activeIds,activeSize:2,get:(id:string)=>id==='ally'?member:undefined}};
  host.app.world={actors:{[actor.id]:actor}};
  host.allies=[];host.pendingAllies=new Set();host.allyWaiters=new Set();host.extraSkillLeases=new Map();
  host.roster={setPartySize(){}};host.prepareCombatSounds=()=>{};host.syncControlled=()=>{};
  host.allySkillSignatureNow=()=> 'original';host.allySkillGateNow=()=> 'gate';
  host.visualOf=()=>undefined;
  host.scene.events=new EventEmitter();host.scene.anims={exists:()=>false,remove(){}};
  host.scene.textures={exists:()=>true,get:()=>({has:()=>true}),remove(){}};
  host.scene.preparePartyMember=async()=>{};
  return {host,invoke,member,activeIds};
}

test('ally new skills stay unavailable until the appearance recomposition completes',async()=>{
  const {host,invoke,member}=pendingAllyFixture();
  host.extraSkillLeases=new Map();
  host.preparedSkillIds=new Map([['ally',new Set(['dark-strike'])]]);
  (member as any).skills={draft:()=>({levels:{'dark-strike':1,'guardian-of-darkness':1}})};
  let finish!:()=>void;
  host.scene.preparePartyMember=()=>new Promise<void>(resolve=>{finish=resolve;});
  const refreshing=invoke('refreshSkillAssets',undefined,'',[{id:'ally',member,signature:'original',gate:'gate'}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(host.preparedSkillIds.get('ally').has('guardian-of-darkness'),false,'外观合成完成前不能使用新技能');
  finish();await refreshing;
  assert.equal(host.preparedSkillIds.get('ally').has('guardian-of-darkness'),true);
});

test('a failed ally request cannot revive retries after that ally leaves',async()=>{
  const {host,invoke,member,activeIds}=pendingAllyFixture();
  host.scene.textures.exists=()=>{activeIds.splice(1);throw new Error('late download failure');};
  await invoke('refreshSkillAssets',undefined,'',[{id:'ally',member,signature:'original',gate:'gate'}]);
  assert.equal(host.skillAssetFailures.size,0);
});

test('equipment changed during initial ally preparation defers spawning until a fresh plan',async()=>{
  const {host,invoke}=pendingAllyFixture();
  host.scene.preparePartyMember=async()=>{host.allySkillSignatureNow=()=> 'new-equipment';};
  await invoke('syncAllies');
  assert.equal(host.allies.length,0,'旧清单不能启动新装备的攻击控制器');
  assert.equal(host.pendingAllies.size,0);
  assert.equal(host.partySignature,'');
  assert.equal(host.nextPartySyncAt,100,'下次更新再重试，避免在同一轮不断补载');
});

test('redeployed ally without a controller replaces its stale hidden visual',async()=>{
  const {host,invoke}=pendingAllyFixture();
  let destroyed=0,prepared=0;
  host.deathTweens=new Map();host.fallen=new Set();host.partyControllers=new Map();host.partySkills=new Map();host.arena=[];
  host.conditions={remove(){}};host.threat={removeActor(){}};host.combatRuntime={removeActor(){}};
  host.scene.movement={remove(){}};host.releaseSkillLeases=()=>{};host.forgetMemberCaches=()=>{};
  host.allies=[{id:'ally',ai:{dispose(){}},presenter:{clear(){}},overhead:{destroy(){}},
    visual:{container:{destroy(){destroyed++;}}}}];
  host.scene.preparePartyMember=async()=>{prepared++;host.allySkillSignatureNow=()=> 'changed';};
  await invoke('syncAllies');
  assert.equal(destroyed,1);assert.equal(prepared,1);
  assert.equal(host.allies.length,0);
  assert.equal(host.partySignature,'');
});

test('restore waits for all current party skill leases and rejects incomplete preparation',async()=>{
  const {host,invoke}=fixture();
  host.extraSkillLeases=new Map();host.preparedSkillIds=new Map();
  let complete!:()=>void;
  host.refreshSkillAssets=async(signature:string)=>{
    await new Promise<void>(resolve=>{complete=resolve;});
    host.playerSkillSignature=signature;host.extraSkillLeases.set('player',[{release(){}}]);
    host.preparedSkillIds.set('player',new Set(['guardian-of-darkness']));
  };
  let finished=false;
  const pending=invoke('prepareRestoredSkills').then(()=>{finished=true;});
  await Promise.resolve();assert.equal(finished,false);
  complete();await pending;assert.equal(finished,true);
  assert.equal(host.preparedSkillIds.get('player').has('guardian-of-darkness'),true);
  host.extraSkillLeases.clear();host.refreshSkillAssets=async()=>{};
  await assert.rejects(invoke('prepareRestoredSkills'),/恢复技能素材失败/);
});

test('failed restored skill preparation leaves current combat state untouched',async()=>{
  const {host,invoke}=fixture();
  const snapshot={roster:{enemies:[],sequence:0,partySize:1},conditions:{buffs:[],states:[],temporary:[]},
    threat:{entries:[]},party:[{id:'player',position:{x:1,y:2},facing:'south',combat:{state:'idle',cooldowns:{}}}],enemies:[],summonGroups:[]};
  let mutations=0;host.combatRuntime={reset(){mutations++;}};host.prepareRestoredSkills=async()=>{throw new Error('asset failure');};
  await assert.rejects(invoke('restoreState',snapshot),/asset failure/);
  assert.equal(mutations,0);
});

test('restored allies must own their prepared skill assets before restore can finish',async()=>{
  const {host,invoke}=pendingAllyFixture();
  host.playerSkillSignatureNow=()=> 'player';host.playerSkillGateNow=()=> 'gate';
  host.refreshSkillAssets=async()=>{
    host.playerSkillSignature='player';host.extraSkillLeases.set('player',[{release(){}}]);
  };
  await assert.rejects(invoke('prepareRestoredSkills'),/恢复技能素材失败/);
  host.allySkillSignatures.set('ally','original');host.extraSkillLeases.set('ally',[{release(){}}]);
  await invoke('prepareRestoredSkills');
});

test('condition rendering skips unaffected actors and refreshes only changed states or layers',()=>{
  const {host,invoke}=fixture(),conditions=new CombatConditions();
  host.conditions=conditions;host.app.session={combatTick:0};host.pendingDefeats=new Set();
  let reads=0;const visuals=new Map(['one','two'].map(id=>[id,{layers:[],container:{active:true,visible:true}}]));
  host.visualOf=(id:string)=>{reads++;return visuals.get(id);};
  const markers:string[]=[],colors:string[]=[],removed:string[]=[];
  host.stateMarkers={sync:(id:string)=>markers.push(id),remove:(id:string)=>removed.push(id)};
  host.statusColors={paint:(visual:unknown)=>colors.push([...visuals].find(([,value])=>value===visual)?.[0]??'')};
  invoke('syncStateMarkers',true);invoke('syncStateMarkers',true);assert.equal(reads,0,'无表现角色不查外观');
  conditions.applyState('one','stun',1000);conditions.applyState('two','sleep',1000);
  invoke('syncStateMarkers',true);assert.deepEqual(markers,['one','two']);
  markers.length=0;colors.length=0;
  invoke('syncStateMarkers',true);assert.deepEqual(markers,[]);assert.deepEqual(colors,[]);
  conditions.applyState('one','stun',1200);invoke('syncStateMarkers',true);assert.deepEqual(markers,['one']);
  markers.length=0;visuals.get('two')!.container.visible=false;invoke('syncStateMarkers',true);assert.deepEqual(markers,['two']);
  markers.length=0;visuals.get('two')!.container.visible=true;invoke('syncStateMarkers',true);assert.deepEqual(markers,['two']);
  markers.length=0;visuals.get('one')!.layers=[];invoke('syncStateMarkers',true);assert.deepEqual(markers,['one']);
  conditions.clear();invoke('syncStateMarkers',true);assert.deepEqual(removed.sort(),['one','two']);
});

test('condition colors use the combat clock while pause, defeat and restore invalidate presentation',()=>{
  const {host,invoke}=fixture(),conditions=new CombatConditions();
  host.conditions=conditions;host.app.session={combatTick:0};host.pendingDefeats=new Set();
  const visual={layers:[],container:{active:true,visible:true}};host.visualOf=()=>visual;
  const frames:number[]=[],shown:boolean[]=[];
  host.statusColors={paint:(_visual:unknown,_colors:unknown,frame:number)=>frames.push(frame)};
  host.stateMarkers={sync:(_id:string,_visual:unknown,_states:unknown,visible:boolean)=>shown.push(visible),remove(){}};
  conditions.applyBuff('player','dark-strike',1,{durationMs:1000,tickMs:0,states:['stun'],modifiers:[],periodic:[],appearanceColors:[{red:10,green:0,blue:0}]});
  invoke('syncStateMarkers',true);invoke('syncStateMarkers',true);assert.deepEqual(frames,[0]);
  host.app.session.combatTick=1;invoke('syncStateMarkers',true);assert.deepEqual(frames,[0,1]);
  invoke('syncStateMarkers',false);const paused=frames.length;invoke('syncStateMarkers',false);assert.equal(frames.length,paused);
  assert.equal(shown.at(-1),false);
  host.pendingDefeats.add('player');invoke('syncStateMarkers',false);assert.equal(frames.length,paused);
  host.pendingDefeats.clear();invoke('syncStateMarkers',true);assert.equal(frames.length,paused+1);
  const saved=conditions.captureState();conditions.restoreState(saved);invoke('syncStateMarkers',true);
  assert.equal(frames.length,paused+2,'读档后即使逻辑帧相同仍重新应用颜色');
});

test('AI mana costs are reused until equipment, conditions or temporary attributes change',()=>{
  const {host,invoke}=fixture();
  host.conditions={
    hasState:()=>false,revision:0,
    cachedAttribute:(_id:string,key:string)=>key==='manaCostRate'&&(host.conditions as {temporary?:boolean}).temporary?1000:undefined,
    hasManaCostAttributeRamp:()=>false,
  };
  let computed=0;
  host.skillManaCost=(_id:string,_skillId:string,_level:number|undefined)=>{computed++;return 10;};
  const member=host.memberOf('player'),skills=[{id:'dark-strike',level:1}];
  const first=invoke('aiSkillCosts','player',member,skills) as Map<string,number|undefined>;
  assert.equal(invoke('cachedAiSkillCost',first,'player',skills[0]),10);
  assert.equal(invoke('cachedAiSkillCost',first,'player',skills[0]),10);
  assert.equal(computed,1,'同一组输入只算一次蓝耗');

  host.hero.bag.add('healing-potion-s');
  const afterBag=invoke('aiSkillCosts','player',member,skills) as Map<string,number|undefined>;
  invoke('cachedAiSkillCost',afterBag,'player',skills[0]);
  assert.equal(computed,2,'背包变化后重算');

  host.conditions.revision++;
  const afterState=invoke('aiSkillCosts','player',member,skills) as Map<string,number|undefined>;
  invoke('cachedAiSkillCost',afterState,'player',skills[0]);
  assert.equal(computed,3,'状态/增益变化后重算');

  host.conditions.temporary=true;
  assert.equal(invoke('aiSkillCosts','player',member,skills),undefined,'临时蓝耗属性存在时不做缓存');
});
