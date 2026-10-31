import {displaySettings} from '../application/display-settings.ts';
import {applyStoryEnemyRemovals} from '../domain/world-enemies.ts';
import type {PreparedSceneVisit,SceneActorState} from '../domain/scene-snapshot.ts';
import {combatFollowUp,type CombatFollowUpPort} from '../domain/combat-follow-ups.ts';
import {combatActor,refreshCombatActors} from '../domain/combat-actor-lookup.ts';
import {prepareCombatRestore,type WorldCombatState} from '../domain/combat-snapshot.ts';
export type {WorldCombatState} from '../domain/combat-snapshot.ts';
import {resolveHitReactionPipeline} from '../domain/combat-reaction-pipeline.ts';
import {CombatEffectExecutor} from '../domain/combat-effect-executor.ts';
import {CombatRuntime} from '../domain/combat-runtime.ts';
import {CombatActionDispatcher} from '../domain/combat-action-dispatcher.ts';
import {executeSkillUnits} from '../domain/combat-unit-execution.ts';
import {runActionDispatch as executeActionDispatch} from '../domain/action-dispatch.ts';
import {MAX_SKILL_TARGETS,type SkillUnitOutcome} from '../domain/skill-unit-sequence.ts';
import {CombatThreatSystem,type CombatThreatActor,type CombatThreatRole} from '../domain/combat-threat-system.ts';
import {equipmentThreatReduction} from '../domain/equipment-threat.ts';
import {BuffLoopRenderer} from '../rendering/buff-loop-renderer.ts';
import {StunStars} from '../rendering/stun-stars.ts';
import { CombatFeedback } from '../rendering/combat-feedback.ts';
import { feedbackPlan, selectFeedbackAssets, type HitEffectStyle } from '../domain/combat-feedback.ts';
import {recoverManaPickup,rollManaGem} from '../domain/mana-gems.ts';
import type {ManaPickup} from '../domain/items.ts';
import {groundLootFor} from '../domain/ground-loot.ts';
import {calculateEffectiveDefense} from '../domain/physical-hit.ts';
import type { RecoveryResult } from '../domain/recovery-items.ts';
import Phaser from 'phaser';
import { LOGIC_FRAME_MS, enemySkills, skillManaCost, skillForMember, memberSkillGrowth, type ResolvedBasicAttack, type BattleBuffEffect, type SkillFeedbackEvent, type ActionDispatchDefinition, type EnemyDefinition, type BattleClass, type EnemyPlayableSkill, type PlacedEnemy, type SkillAction, type CombatUnit } from '../domain/battle.ts';
import { CombatController,canTargetCombatant,resolveCueTargets, type Combatant, type ActionPlayback, type AttackContact, type BasicAreaContact, type BasicAttackSelection, type SkillUnitHit, type SkillUnitStart } from '../domain/combat.ts';
import type { PartyBuffSlot } from '../domain/party-buff-targets.ts';
import { EnemyController, type EnemyPort } from '../domain/enemy-ai.ts';
import { enemyAwarenessRangeUnits } from '../domain/enemy-engagement.ts';
import { FriendlySummonController } from '../domain/friendly-summon-ai.ts';
import { SummonCombatAwareness } from '../domain/summon-tactics.ts';
import { canTraverse } from '../domain/pathfinding.ts';
import { choosePartyLanding, facingBackAngle, formationSlotOffset, partyBodyOverlaps, smoothFormationAngle } from '../domain/party-placement.ts';
import type { NavigationActor, NavigationShape } from '../domain/navigation-world.ts';
import { overlapsFootRect } from '../domain/navigation.ts';
import { PartyController, type PartyPort } from '../domain/party-ai.ts';
import { PathBudget } from '../domain/path-budget.ts';
import { memberCombatModifiers, partyProcSucceeds } from '../domain/party-combat.ts';
import { reviveAtHealer } from '../domain/party-revival.ts';
import type { ResourceCapacityKey, ResourceCapacities } from '../domain/combat-conditions.ts';
import type { ItemResult } from '../domain/items.ts';
import { calculateMagicResistance, rollMagicHit, rollPhysicalHit, type PhysicalFighter, type PhysicalHit } from '../domain/physical-hit.ts';
import {AttackProcExecutor} from '../domain/attack-proc.ts';
import {equipmentAttackProcs} from '../domain/equipment-attack-procs.ts';
import {equipmentCombatProcs} from '../domain/equipment-combat-procs.ts';
import {selectAttackSplashCenter,attackSplashTargets} from '../domain/attack-splash.ts';
import {applyCombatOperation} from '../domain/combat-operation.ts';
import { calculateEnemy } from '../domain/enemy-stats.ts';
import { actionDamage, prepareActionDamage, type PreparedActionDamage } from '../domain/action-damage.ts';
import { actionDamageSource,bestNormalDamage,normalDamageForClass,physicalNormalDamage,magicNormalDamage, type CombatActorAttributes } from '../domain/combat-damage-source.ts';
import { calculateManaCost,defaultResourceAttributes } from '../domain/combat-resources.ts';
import { equipmentRecoveryModifiers } from '../domain/equipment-recovery.ts';
import { learnedSkillReactions,resolveSkillReactions,executeBloodThirstReaction,type SkillReactionEvent,type SkillReactionBuff,type SkillReaction,type SkillReactionCommand,type LearnedReactionSkill } from '../domain/skill-reactions.ts';
import { resolveBuffReactions,type BuffReactionEvent } from '../domain/buff-reactions.ts';
import { resolvePeriodicEffect } from '../domain/combat-periodic.ts';
import { healTargetScore,type HealSlot } from '../domain/heal-target.ts';
import { stableSeed } from '../domain/stable-seed.ts';
import { ACTIVE_PARTY_SLOT_COUNT } from '../domain/party-slots.ts';
import type { StorySkillProgression } from '../domain/story-skills.ts';
import type { CompanionSkillProgression } from '../domain/companion-progression.ts';
import type { BattleBuffKey,BattleStatKey,BattleStateKey } from '../domain/battle-semantics.ts';
import { passesChanceThreshold } from '../domain/action-state.ts';
import {frameStateDurationProfile,resolveStateApplication,selectStateDurationProfile,type StateApplicationRequest} from '../domain/state-application.ts';
import {equipmentStateImmunity} from '../domain/equipment-state-immunity.ts';
import { CombatConditions, type PeriodicTick } from '../domain/combat-conditions.ts';
import type { PassiveModifier } from '../domain/passive-skills.ts';
import { disturbanceCandidate } from '../domain/disturbance.ts';
import { planSummonSpot } from '../domain/skill-geometry.ts';
import { scaledBuffEffect, summonLifetimeFrames, summonOwnerStats, withLifetimeFrames, type SummonStats } from '../domain/summon-stats.ts';
import { faceTarget, resolveBasicAttack } from '../domain/basic-attack.ts';
import { skillClipName, skillClips, skillPlaybackEvents, skillSoundNames } from '../domain/skill-action.ts';
import { costumeRecipe, hasOffhandShield } from '../domain/wardrobe.ts';
import type { ActorDefinition, ClipName, Facing } from '../domain/content.ts';
import type { BattleCharacter } from '../domain/character-stats.ts';
import { equipmentPower } from '../domain/character-stats.ts';
import { baseOffhandAttackChance,chooseDualWield,offhandPhysicalAttack } from '../domain/dual-wield.ts';
import { adjacentLivingMember, type CompanionMember } from '../domain/party.ts';
import type { Point } from '../domain/navigation.ts';
import type { AssetLease } from '../application/assets.ts';
import type { StoryContext } from '../application/ports.ts';
import { CombatPresenter } from '../rendering/combat-presenter.ts';
import { CombatEffects } from '../rendering/combat-effects.ts';
import { setCharacterStealth } from '../rendering/character-visibility.ts';
import { StatusColorRenderer } from '../rendering/status-color.ts';
import { OverheadStatus } from '../rendering/overhead-status.ts';
import { characterAnimationState, createCharacter, PLAYER_MOVE_SPEED, setCharacterClip, type CharacterVisual } from '../rendering/characters.ts';
import { isBodyWalking } from '../rendering/arcade-movement.ts';
import { effectAssets } from '../rendering/effects.ts';
import { loadSceneAssets, retainLoadedSceneAssets } from '../rendering/scene-assets.ts';
import { WorldEnemyRoster } from '../domain/world-enemies.ts';
import { breakableKindOf, firstBossGuarantee, rollBreakableLoot, rollEnemyLoot, rollQuestDrops, specialDropEligibility, type DropCatalog } from '../domain/drops.ts';
import { PendingEnemyDefeats } from '../domain/combat-outcomes.ts';
import { CombatHitResolution } from '../domain/combat-hit-resolution.ts';
import {moltenReflectionDamage,rollMoltenSplash,moltenSplashTargets} from '../domain/molten-armor.ts';
import { CombatOutcomes } from '../rendering/combat-outcomes.ts';
import { enemyCombatAssets, equipmentAttackFor, partyMemberCombatAssets, playerCombatAssets, sharedCombatAssets } from '../rendering/combat-assets.ts';
import type { WorldScene } from './world-scene.ts';

interface MapAlly {
  id:string;member:CompanionMember;visual:CharacterVisual;body:Phaser.Physics.Arcade.Body;facing:Facing;
  controller:CombatController;ai:PartyController;presenter:CombatPresenter;overhead:OverheadStatus;assets?:AssetLease;
}

interface MapEnemy {
  key:string;
  definition:EnemyDefinition;
  visual:CharacterVisual;
  body:Phaser.Physics.Arcade.Body;
  facing:Facing;
  controller?:EnemyController|FriendlySummonController;
  presenter:CombatPresenter;
  assets?:AssetLease;
  summonedBy?:string;
  summonRemainingMs?:number;
  summonTauntChance?:number;
  /** 召唤它的技能 id；命中时按主人当前等级重读阈值。 */
  summonedBySkill?:string;
}

const TAP_FACINGS:readonly Facing[]=['north','south','east','west'];

/**
 * 点击敌人的命中矩形，按待机动作的显示范围取并集；原点在脚底，所以范围要减去锚点偏移。
 * 只读动画帧的裁剪尺寸，不依赖 Phaser，可在没有场景的情况下测试。
 */
export function enemyTapRect(actor:ActorDefinition):{x:number;y:number;width:number;height:number}{
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const facing of TAP_FACINGS){
    const clip=actor.clips[`idle-${facing}`];
    if(!clip)continue;
    left=Math.min(left,-clip.frameWidth*clip.originX);
    top=Math.min(top,-clip.frameHeight*clip.originY);
    right=Math.max(right,clip.frameWidth*(1-clip.originX));
    bottom=Math.max(bottom,clip.frameHeight*(1-clip.originY));
  }
  // 缺少待机动作的目录（场怪物件）回落到碰撞框。
  if(!Number.isFinite(left)){const box=actor.collision!;return {x:box.x,y:box.y,width:box.width,height:box.height};}
  return {x:left,y:top,width:right-left,height:bottom-top};
}

/**
 * 一场战斗的完整快照。
 *
 * 战斗状态分散在若干子系统里，`captureState`／`restoreState` 逐个手工串联，所以**每个字段
 * 的持有者与同步责任人要写在字段上**：新增一类战斗状态时没有别的地方能查到它该挂在哪，
 * 漏接一个子系统的表现是「回读存档后状态静默丢失」，只在回读路径暴露。
 *
 * 回读顺序也是有讲究的：先单位名单（`roster`）与增益（`conditions`），再由名单生成敌人，
 * 然后才轮到各敌人的朝向与 AI——顺序反了会对着不存在的敌人写状态。
 */

/** 所有 AI 每渲染帧共享的寻路扩展预算；一次扩展约几微秒，512 约 2–4 ms。 */
const PATH_BUDGET_PER_RENDER_FRAME=512;

/** 正式地图的战斗结算与角色表现装配。 */
export class WorldCombat {
  private actionDispatchers?:WeakMap<CombatPresenter,CombatActionDispatcher>;
  private partyDefeatWork?:Map<string,()=>void>;
  readonly scene:WorldScene;
  readonly app:StoryContext;
  readonly roster:WorldEnemyRoster;
  readonly hero:BattleCharacter;
  readonly drops:DropCatalog;
  private combatRuntime?:CombatRuntime;
  private get runtime():CombatRuntime {return this.combatRuntime??=new CombatRuntime(()=>this.app.session.combatTick??0);}
  private arena:MapEnemy[]=[];
  private allies:MapAlly[]=[];
  private heroAi?:PartyController;
  private readonly fallen=new Set<string>();
  private readonly deathTweens=new Map<string,Phaser.Tweens.Tween>();
  /** 死亡表现当前是否被暂停；只在状态变化时逐角色应用。 */
  private deathVisualsPaused?:boolean;
  private readonly partyControllers=new Map<string,CombatController>();
  private readonly partySkills=new Map<string,EnemyPlayableSkill[]>();
  private readonly pendingAllies=new Set<string>();
  private readonly allyWaiters=new Set<()=>void>();
  private allyLoadFailure?:unknown;
  private partySignature='';
  private nextPartySyncAt=0;
  private syncedControlledId='player';
  private focusTargetId?:string;
  private readonly statusColors=new StatusColorRenderer();
  private readonly stunStars=new Map<string,{visual:CharacterVisual;stars:StunStars}>();
  private readonly summonGroups=new Map<string,Set<string>>();
  private summonAwareness?:SummonCombatAwareness;
  private get awareness():SummonCombatAwareness {
    return this.summonAwareness??=new SummonCombatAwareness((this.app.session.combatTick??0)*LOGIC_FRAME_MS);
  }
  private readonly conditions=this.createConditions();
  private readonly threat:CombatThreatSystem;
  private readonly pendingDefeats=new PendingEnemyDefeats();
  private hitResolution?:CombatHitResolution;
  private readonly outcomes:CombatOutcomes;
  private readonly buffLoops:BuffLoopRenderer;
  private readonly feedback:CombatFeedback;
  private combat?:CombatController;
  private presenter?:CombatPresenter;
  private readonly combatEffects:CombatEffects;
  private enemiesRunning=false;
  /** 上一次应用的暂停状态；同值时跳过逐角色动画/特效暂停。 */
  private pausedValue?:boolean;
  /** 敌人、队伍与召唤共享的寻路预算，在每个渲染帧开头重置。 */
  private readonly pathBudget=new PathBudget(PATH_BUDGET_PER_RENDER_FRAME);
  private partyActionsSuspended=false;
  private performanceHidden=false;
  private closed=false;
  private defeated=false;
  private wipeoutPosition?:Point;
  private generation=0;
  private playerAssets?:AssetLease;
  private restoredAssets?:AssetLease;
  private storyAssets?:AssetLease;
  private attackProcs=new AttackProcExecutor();
  private effectExecutor?:CombatEffectExecutor;
  private readonly soundedSkills=new WeakSet<object>();
  private unsubscribeHero?:()=>void;
  private unsubscribeSession?:()=>void;
  private lastSkillReset?:number;
  /** 整盒校验拒绝的强制位移落点；正常应为空，出现时说明技能落点被挡。 */
  private relocationFailures: { id: string; position: Point }[] = [];
  /** 跟随长时间没有进展、被收拢到队长身边的次数；用于上报排查。 */
  private followerCatchUps = 0;
  /** 全队共享的队形相位；两名佣兵永远相差两个槽位角，不会在平滑中重合。 */
  private formationFacing:Facing='south';
  private formationAngle=facingBackAngle('south');
  private formationLeaderId?:string;
  private formationLeaderPosition?:Point;
  private readonly followLandingCache = new Map<string,{key:string;point:Point}>();
  private readonly regroupAttempts = new Map<string,number>();
  private readonly regroupCooldowns = new Map<string,number>();
  constructor(scene:WorldScene,app:StoryContext,roster:WorldEnemyRoster,hero:BattleCharacter,drops:DropCatalog){
    this.scene=scene;this.app=app;this.roster=roster;this.hero=hero;this.drops=drops;
    this.threat=this.createThreatSystem();
    this.outcomes=new CombatOutcomes(scene,app.battleCatalog);
    this.buffLoops=new BuffLoopRenderer(scene,app.battleCatalog);
    this.feedback=new CombatFeedback(scene,app.battleCatalog);
    this.combatEffects=new CombatEffects(scene);
    app.useRecoveryItem=this.useRecoveryItem;
  }
  private createConditions():CombatConditions {
    return new CombatConditions({
      captureResourceCapacities:id=>({maxHealth:this.readResourceCapacity(id,'maxHealth'),maxMana:this.readResourceCapacity(id,'maxMana')}),
      onApply:(id,effect,entry)=>this.applyBuffResources(id,effect,entry),
    },{
      // `conditions` 是字段初始化器，此刻构造函数还没给 `this.app` 赋值；这里只捕获 this，
      // 真正读写会话要等到伤害结算时。
      has:id=>this.app.session.isInvincible(id),
      add:id=>this.app.session.setInvincible(id,true),
      delete:id=>this.app.session.setInvincible(id,false),
    });
  }
  private applyBuffResources(id:string,effect:BattleBuffEffect,entry:Readonly<ResourceCapacities>):void {
    for(const application of effect.onApply??[]){
      if(application.kind==='restore-health-from-max-health'){
        const amount=applyCombatOperation(entry.maxHealth,application.operation)-entry.maxHealth;
        if(amount>0)this.restoreHealth(id,amount);
      }else{
        // 立即给当前 MP 加这份定值；满蓝时按上限夹取，不改变结果的成功与否。
        const amount=Math.max(0,application.value);
        if(amount>0)this.restoreMana(id,amount);
      }
    }
  }
  readonly useRecoveryItem=(entry:string,userId=this.controlledId):RecoveryResult=>{
    if(this.closed||this.defeated||this.app.suspended||!this.player?.container.active)return {used:false,reason:'unavailable'};
    const members=this.activeParty.map(id=>{const member=this.memberOf(id)!;return {id,player:member.player,setHealth:(value:number)=>member.setHealth(value),setMana:(value:number)=>member.setMana(value)};});
    const result=this.app.session.recovery.use(this.hero.bag,entry,members,userId,{
      sleeping:this.conditions.hasState(userId,'sleep'),
      potionSickness:!this.conditions.canUseRecoveryItems(userId),
      weakened:this.conditions.hasState(userId,'potion-recovery-halved'),
      recoveryBonus:!!this.app.session.party?.groupModifiers()['potion-recovery'],
      cooldownReductionMs:this.app.session.party?.groupModifiers()['potion-cooldown-ms']});
    if(result.used){
      this.outcomes.setPaused(this.app.locked);
      for(const id of result.effects){const visual=this.visualOf(id);if(visual)this.outcomes.recover(visual);}
      this.app.audio?.ui('heal');
    }
    return result;
  };
  collectMana(pickup:ManaPickup):boolean {
    const members=this.activeParty.map(id=>{const member=this.memberOf(id)!;return {id,player:member.player,setMana:(value:number)=>member.setMana(value)};});
    // 操控者倒下的那一帧仍可能走到宝石上：改由第一个存活队员结算；全灭时把宝石留在原地。
    const collectorId=[this.controlledId,...this.activeParty].find(id=>(this.memberOf(id)?.player.health??0)>0);
    if(!collectorId)return false;
    const result=recoverManaPickup(pickup,members,collectorId);
    if(!result)return false;
    for(const id of result.effects){const visual=this.visualOf(id);if(visual)this.outcomes.recover(visual);}
    this.app.audio?.ui('heal');
    return true;
  }
  private dropMana(casterId:string,damage:number,target:Point|undefined,rule:'skill'|'weapon'='weapon'):void {
    const map=this.scene.map;if(!map||!target)return;
    const item='mana-gem',pickup=this.app.items.items[item].pickup!;
    const member=this.memberOf(casterId),bag=this.hero.bag;
    const equipment=member?bag.equipmentItems(bag.equipmentFor(casterId)):{};
    const weapon=equipment['main-hand']??equipment['off-hand'];
    const actor=this.movement.actor(this.controlledVisual);
    const landing=rollManaGem(pickup,damage,rule,weapon?this.app.items.items[weapon].kind:undefined,target,
      point=>this.movement.navigation.canStand(actor,point)&&this.movement.navigation.path(actor,point,256)!==null);
    if(!landing)return;
    const clip=pickup.hitDrop.directions[landing.direction].clip;
    groundLootFor(this.app.session).addFlying(map.id,target,landing,item,clip.frames*1000/clip.frameRate);
  }
  get player():CharacterVisual {return this.scene.player!;}
  get controlledId():string{return this.app.session.party?.controlledId??'player';}
  get controlledMember():BattleCharacter|CompanionMember{return this.memberOf(this.controlledId)!;}
  get controlledVisual():CharacterVisual{return this.visualOf(this.controlledId)??this.player;}
  get controlledState(){return this.controlledMember.player;}
  /** 状态面板读取的角色状态：增益与异常都在里面，用于图标行。 */
  activeConditions(id:string){return this.conditions.snapshot(id);}
  get activeParty(){return this.app.session?.party?.activeIds??['player'];}
  get movement(){return this.scene.movement!;}
  get facing():Facing{return this.controlledId==='player'?this.scene.facing:combatActor(this.allies,this.controlledId,actor=>actor.id)?.facing??'south';}
  set facing(value:Facing){if(this.controlledId==='player')this.scene.facing=value;else{const ally=combatActor(this.allies,this.controlledId,actor=>actor.id);if(ally)ally.facing=value;}}
  get attackState(){return this.combat?.actionState()??'idle';}
  /** 受控角色正在释放主动技能（含自动接近目标）。 */
  get castingSkill():boolean{return !!this.combat?.activeAction()?.skill;}
  get targetId(){return this.combat?.selectedTargetId();}
  get cooldowns(){return this.combat?.snapshot().cooldowns??{};}
  /**
   * 卡住排查的最小快照：谁被冻住、在放什么动作、身上挂着哪些状态、移动体是否还在推进。
   * 「不能移动」可能来自任何一层（流程锁、战斗暂停、buff、移动体固定），这里一次给全。
   */
  /**
   * 全量现场快照：每个出战队员的控制器、AI 寻路、移动体和状态，以及敌人和交战判定。
   * 「佣兵不动」「卡墙」「技能收不了尾」可能落在不同层，这里一次给全。
   */
  diagnostics() {
    // 关闭中的战斗不再读现场：场景 shutdown 时显示对象先被销毁、移动世界也注销了它们，
    // 这里再取位置会抛异常，而调用方是同步的界面刷新，异常会一路抛回游戏循环并卡住帧。
    if(this.closed)return {closed:true};
    const now = (this.app.session.combatTick ?? 0) * LOGIC_FRAME_MS;
    const conditions = this.conditions.captureState();
    const own = <T>(pairs: [string, T[]][], id: string): T[] => pairs.find(([actor]) => actor === id)?.[1] ?? [];
    const summarizePath = (path: readonly { x: number; y: number }[]) => path.length
      ? { length: path.length, first: path[0], last: path.at(-1) } : { length: 0 };
    const aiOf = (id: string) => id === 'player' ? this.heroAi : combatActor(this.allies, id, actor => actor.id)?.ai;
    const member = (id: string) => {
      const visual = this.visualOf(id), memberState = this.memberOf(id), aiState = aiOf(id)?.captureState();
      return {
        id, alive: (memberState?.player.health ?? 0) > 0,
        health: memberState?.player.health ?? null, mana: memberState?.player.mana ?? null,
        position: visual ? this.movement.position(visual) : null,
        facing: id === 'player' ? this.scene.facing : combatActor(this.allies, id, actor => actor.id)?.facing ?? null,
        visible: visual?.container.visible ?? false,
        controller: this.partyControllers.get(id)?.snapshot() ?? null,
        ai: aiState ? { ...aiState, path: summarizePath(aiState.path) } : null,
        move: visual ? this.movement.state(visual) ?? null : null,
        conditions: {
          buffs: own(conditions.buffs, id).map(buff => ({ id: buff.id, remainingMs: buff.remainingMs })),
          states: own(conditions.states, id).map(state => ({ id: state.id, remainingMs: state.remainingMs })),
          temporary: own(conditions.temporary, id).map(([key, value]) => ({ key, value })),
        },
        fallen: this.fallen.has(id), pendingLoad: this.pendingAllies.has(id),
      };
    };
    return {
      controlled: this.controlledId,
      attack: this.attackState,
      skill: this.combat?.activeAction()?.skill?.id ?? null,
      target: this.targetId ?? null,
      focusTarget: this.focusTargetId ?? null,
      inCombat: !!this.focusTargetId || this.awareness.inCombat(now),
      cannotMove: this.playerCannotMove(),
      cannotAct: this.playerCannotAct(),
      defeated: this.defeated,
      performanceHidden: this.performanceHidden,
      actionsSuspended: this.partyActionsSuspended,
      runtime: { paused: this.runtime.paused, pauseOwners: this.runtime.pauseOwners,
        idle: this.runtime.idle, pending: this.runtime.pendingCount },
      awareness: { quietForMs: this.awareness.quietFor(now),
        ...this.awareness.tactics(this.controlledId, this.activeParty, this.focusTargetId) },
      party: this.activeParty.map(member),
      enemies: this.arena.map(enemy => ({
        id: enemy.key, enemy: enemy.definition.id,
        // 与 `enemy` 不相等说明场上实例和名册身份已经错开，伤害与目标血条会一起失效。
        rosterEnemy: this.roster.enemies.find(candidate => candidate.key === enemy.key)?.enemyId ?? null,
        state: enemy.controller?.actionState() ?? null,
        position: this.movement.position(enemy.visual),
        health: this.roster.enemySnapshot(enemy.key, enemy.definition, this.hero.level)?.health ?? null,
        pendingDefeat: this.pendingDefeats.has(enemy.key),
        summonedBy: enemy.summonedBy ?? null,
        visible: enemy.visual.container.visible,
      })),
      relocationFailures: [...(this.relocationFailures ?? [])],
      followerCatchUps: this.followerCatchUps,
    };
  }
  get canCheckpoint():boolean {
    return this.runtime.idle&&!this.closed&&!this.defeated&&!this.deathTweens.size&&!this.pendingAllies.size&&
      this.activeParty.some(id=>this.memberOf(id)?.player.health)&&
      this.activeParty.every(id=>this.partyControllers.has(id)&&!!this.visualOf(id))&&
      [...this.partyControllers.values()].every(controller=>controller.actionState()==='idle')&&
      this.arena.every(enemy=>!this.pendingDefeats.has(enemy.key)&&(!enemy.controller||enemy.controller.actionState()==='idle'||enemy.controller.actionState()==='wandering'));
  }
adoptStoryPositions(actors:readonly SceneActorState[]):void {
    const placements:{visual:CharacterVisual;position:{x:number;y:number};enabled:boolean}[]=[];
    for(const actor of actors){
      // 舞台只是为了不画重复敌人而临时隐藏的演员，不代表正式战斗里的显隐/停用。
      if(actor.removed||actor.unpositioned||actor.stageHidden)continue;
      const ally=actor.memberId&&this.allies.find(ally=>ally.id===actor.memberId);
      const enemy=actor.enemyKey&&this.arena.find(enemy=>enemy.key===actor.enemyKey);
      const visual=ally?ally.visual:enemy?enemy.visual:undefined;
      if(!visual)continue;
      if(ally&&!ally.member.alive||enemy&&(!this.isActorAlive(enemy.key)||this.pendingDefeats.has(enemy.key)))continue;
      if(ally)ally.facing=actor.facing;if(enemy)enemy.facing=actor.facing;
      setCharacterClip(this.scene,visual,`idle-${actor.facing}`);
      placements.push({visual,position:{x:actor.x,y:actor.y},enabled:actor.visible&&!this.performanceHidden});
    }
    this.movement.placeAll(placements,{evictOccupied:true,displaceable:[this.player]});
  }

captureStoryVisit():Pick<PreparedSceneVisit,'roster'|'breakableRolls'> {
    const state=this.roster.capturePreparedState();
    for(const enemy of state.roster.enemies){
      const visual=this.visualOf(enemy.key);if(visual)Object.assign(enemy,this.movement.position(visual));
    }
    return state;
  }

captureStoryActors():SceneActorState[] {
    const allies:SceneActorState[]=this.allies.map(ally=>{
      const animation=characterAnimationState(ally.visual);
      return {id:`member:${ally.id}`,actor:ally.member.definition.actor,memberId:ally.id,followsPlayer:true,
        ...this.movement.position(ally.visual),facing:ally.facing,visible:ally.member.alive,
        flip:ally.visual.entity.flip,appearance:structuredClone(ally.visual.actor),
        clip:ally.visual.clipName??undefined,alpha:ally.visual.container.alpha,
        animationProgress:animation.progress,animationPlaying:animation.playing};
    });
    const enemies:SceneActorState[]=this.arena.map(enemy=>{
      const animation=characterAnimationState(enemy.visual);
      return {id:`enemy:${enemy.key}`,actor:enemy.definition.actor.id,enemyKey:enemy.key,enemyId:enemy.definition.id,
        summonedBy:enemy.summonedBy,...this.movement.position(enemy.visual),facing:enemy.facing,
        visible:this.isActorAlive(enemy.key)&&!this.pendingDefeats.has(enemy.key),
        flip:enemy.visual.entity.flip,appearance:structuredClone(enemy.visual.actor),
        clip:enemy.visual.clipName??undefined,alpha:enemy.visual.container.alpha,
        animationProgress:animation.progress,animationPlaying:animation.playing};
    });
    return [...allies,...enemies];
  }

  captureState():WorldCombatState {
    const roster=this.roster.captureState();
    for(const enemy of roster.enemies){const visual=this.visualOf(enemy.key);if(visual)Object.assign(enemy,this.movement.position(visual));}
    return {roster,conditions:this.conditions.captureState(),threat:this.threat.captureState(),
      party:this.activeParty.flatMap(id=>{const visual=this.visualOf(id),controller=this.partyControllers.get(id),ai=id==='player'?this.heroAi:combatActor(this.allies,id,actor=>actor.id)?.ai;return visual&&controller?[{id,position:this.movement.position(visual),facing:id==='player'?this.scene.facing:combatActor(this.allies,id,actor=>actor.id)!.facing,combat:controller.snapshot(),ai:ai?.captureState()}]:[];}),
      enemies:this.arena.map(enemy=>({id:enemy.key,facing:enemy.facing,ai:enemy.controller instanceof FriendlySummonController
        ?{kind:'friendly-summon' as const,state:enemy.controller.captureState()}
        :enemy.controller?{kind:'enemy' as const,state:enemy.controller.captureState()}:undefined,
        summonRemainingMs:enemy.summonRemainingMs,summonTauntChance:enemy.summonTauntChance})),
      summonGroups:[...this.summonGroups].map(([key,ids])=>[key,[...ids]]),focusTargetId:this.focusTargetId,
      damageCount:this.damageCount};
  }
  async restoreState(state:WorldCombatState,signal?:AbortSignal):Promise<void> {
    signal?.throwIfAborted();
    state=prepareCombatRestore(state,this.app.battleCatalog,this.app.session.party?.activeIds??[]);
    const definitions=[...new Set(state.roster.enemies.map(enemy=>enemy.enemyId))].map(id=>this.app.battleCatalog.enemies.find(enemy=>enemy.id===id)!);
    const lease=await loadSceneAssets(this.scene,definitions.flatMap(definition=>this.enemyAssets(definition)),()=>{});
    if(this.closed||signal?.aborted){lease.release();signal?.throwIfAborted();return;}
    this.restoredAssets?.release();this.restoredAssets=lease;
    this.runtime.reset();this.pendingDefeats.clear();this.partyDefeatWork?.clear();
    this.summonAwareness=new SummonCombatAwareness(this.app.session.combatTick*LOGIC_FRAME_MS);
    this.combatEffects.clear();this.buffLoops.clear();
    for(const id of this.activeParty)this.presenterFor(id)?.reset();
    for(const tween of this.deathTweens.values())tween.stop();this.deathTweens.clear();this.fallen.clear();
    this.defeated=false;
    this.clearEnemies(true);this.roster.restoreState(state.roster);this.conditions.restoreState(state.conditions);
    this.syncControlled();
    this.focusTargetId=state.focusTargetId;this.damageCount=state.damageCount??0;
    for(const saved of state.party){const visual=this.visualOf(saved.id);if(!visual)continue;
      const alive=!!this.memberOf(saved.id)?.player.health;
      visual.container.setAlpha(1).setVisible(alive&&!this.performanceHidden);this.movement.setEnabled(visual,alive);
      this.relocateVisual(visual,saved.position);this.partyControllers.get(saved.id)?.restoreState(saved.combat);
      if(saved.ai)(saved.id==='player'?this.heroAi:combatActor(this.allies,saved.id,actor=>actor.id)?.ai)?.restoreState(saved.ai);
      if(saved.id==='player')this.scene.facing=saved.facing;else combatActor(this.allies,saved.id,actor=>actor.id)!.facing=saved.facing;
      if(this.memberOf(saved.id)?.player.health)setCharacterClip(this.scene,visual,`idle-${saved.facing}`,true);else this.markAlreadyFallen(saved.id);
    }
    for(const placed of this.roster.enemies)this.spawnEnemy(placed);
    for(const saved of state.enemies){const enemy=combatActor(this.arena,saved.id,actor=>actor.key);if(!enemy)continue;
      enemy.facing=saved.facing;enemy.summonRemainingMs=saved.summonRemainingMs;enemy.summonTauntChance=saved.summonTauntChance;
      if(saved.ai?.kind==='friendly-summon'&&enemy.controller instanceof FriendlySummonController)enemy.controller.restoreState(saved.ai.state);
      else if(saved.ai?.kind==='enemy'&&enemy.controller instanceof EnemyController)enemy.controller.restoreState(saved.ai.state);
    }
    this.threat.restoreState(state.threat);
    this.summonGroups.clear();for(const [key,ids]of state.summonGroups)this.summonGroups.set(key,new Set(ids));
    // 回滚/读档会把角色瞬间搬到别处；队形相位必须重新对齐，不能把这段位移当成走路方向。
    this.resetFormationState(this.facingOfControlled());
  }

  private enemyAssets(definition: EnemyDefinition) {
    return enemyCombatAssets(this.app.battleCatalog,definition);
  }

  /** 主角与当前队员的职业定义；控制权可以切换，所以两者的技能音效都要提前加载。 */
  private controllableClasses():BattleClass[] {
    const classes=this.app.battleCatalog.classes;
    return this.activeParty.flatMap(id=>{
      const classId=id==='player'?this.hero.classId:this.app.session.party?.get(id)?.classId;
      const character=classId?classes.find(value=>value.id===classId):undefined;
      return character?[character]:[];
    });
  }

  /**
   * 参战职业的技能音效：技能自身的音效，加上技能动作自带的分支音效。
   *
   * 三类分支音效（动作单元、派发收尾、时间轴反馈）由玩家阵营的施法者触发，
   * 所以按可操控角色取；画面资源的范围另在 `enemyAssets` 里按出场敌人取。
   */
  private prepareCombatSounds(characters:Iterable<BattleClass|undefined>):void {
    const catalog=this.app.battleCatalog;
    const skillIds=new Set<string>(),actionSounds=new Set<string>();
    for(const character of characters){
      if(!character)continue;
      for(const id of character.skills){
        const skill=catalog.skills[id];
        if(!skill)continue;
        skillIds.add(id);
        if(skill.action)for(const name of skillSoundNames(skill.action))actionSounds.add(name);
      }
    }
    const prepared=this.app.audio?.prepareCombat(skillIds,actionSounds);
    void prepared?.catch(error=>console.warn('战斗音效准备失败',error));
  }

  /** 外观容器就是物理对象，移动、攻击定位与拖放读取同一个脚底位置。 */
  private buildEnemy(placed: PlacedEnemy, definition: EnemyDefinition, lease?: AssetLease, replacing?: MapEnemy): MapEnemy {
    const actor = definition.actor, box = actor.collision!;
    const ignore = replacing ? this.movement!.actor(replacing.visual) : undefined;
    // 出生优先整盒：地图自带的生成点若只满足窄足底，身体会压进相邻阻挡格。
    const position = this.movement!.navigation.nearestBody({ collision: box }, placed, ignore)
      ?? this.movement!.navigation.nearest({ collision: box }, placed, ignore);
    const visual = createCharacter(this.scene, actor, { id: placed.key, actor: actor.id, ...position });
    // 友方召唤物与队伍同属 party，彼此不占位；可移动的召唤物和主角、佣兵一样允许地形自愈，
    // 避免被物理分离推进墙里后只能等召回。
    const friendly = !!placed.summonedBy && !!this.memberOf(placed.summonedBy);
    const faction = friendly ? 'party' : 'hostile';
    const body = this.movement!.register(visual, definition.behavior.canMove, friendly && definition.behavior.canMove, faction);
    const presenter = new CombatPresenter(this.scene, this.app.battleCatalog, id => this.visualOf(id), () => this.combatants(), this.combatEffects);
    // 生成前就锁定这只敌人用到的全部纹理；缺任何一项都在这里失败，而不是等到播放动画时。
    const assets = lease ?? retainLoadedSceneAssets(this.scene, this.enemyAssets(definition));
    const enemy: MapEnemy = { key: placed.key, definition, visual, body, facing: 'south', presenter, assets,summonedBy:placed.summonedBy,
      summonTauntChance:placed.summonTauntChance,summonedBySkill:placed.summonedBySkill };
    if (position.x !== placed.x || position.y !== placed.y) this.roster.moveEnemy(placed.key, position.x, position.y);
    const skills=enemySkills(definition);
    if (definition.basicAttack || skills.length) {
      const attack = definition.basicAttack ? resolveBasicAttack(this.app.battleCatalog, { actor, basicAttack: definition.basicAttack }) : null;
      const behavior = placed.summonedBy ? { ...definition.behavior, wander: undefined } : definition.behavior;
      const port:EnemyPort = {
        isPaused:()=>this.runtime.paused,cooldowns:this.app.session.cooldowns.forActor(enemy.key),
        threat:placed.summonedBy&&this.memberOf(placed.summonedBy)?undefined:{
          select:current=>this.threat.select(enemy.key,current),
          notice:source=>this.threat.notice(enemy.key,source),
          has:source=>this.threat.has(enemy.key,source),
          clear:()=>this.threat.clearOwner(enemy.key),
        },
        canFinishApproach:target=>!!placed.summonedBy&&!!this.memberOf(placed.summonedBy)||this.threat.has(enemy.key,target),
        actor: id => this.combatant(id), candidates: () => this.combatants(), partySlots:()=>this.partyBuffSlots(),
        isAlive:id=>this.isActorAlive(id),health:id=>this.actorHealth(id),
      rangeBonusUnits:key=>this.actorAttribute(key,'attackRangeBonusUnits'), facing: () => enemy.facing,
        home: () => this.roster.enemies.find(item => item.key === enemy.key) ?? placed,
        navigationBounds: () => this.movement!.navigation.bounds,
        pathBudget: this.pathBudget,
        navigationSnapshot: () => this.movement!.navigation.captureStandability(this.movement!.actor(visual)),
        moveToward: position => { if(!this.conditions.canAutoApproach(enemy.key)){this.movement.stop(visual);return;} this.movement!.toward(visual, position, this.movementSpeed(enemy.key,definition.behavior.moveSpeedPxPerSecond)); if (definition.behavior.canTurn) enemy.facing = faceTarget(this.movement!.position(visual), position); },
        followPath: nextWaypoint => this.movement.followPath(visual, () => {
          if(!this.conditions.canMove(enemy.key))return undefined;
          const next = nextWaypoint();
          if (next && definition.behavior.canTurn) enemy.facing = faceTarget(this.movement.position(visual), next);
          return next;
        }, this.movementSpeed(enemy.key, definition.behavior.moveSpeedPxPerSecond)),
        stop: () => this.movement!.stop(visual),
        canStand: (position, clearanceActorId) => {
          const clearanceVisual = clearanceActorId ? this.visualOf(clearanceActorId) : visual;
          return !!clearanceVisual && this.movement!.canStand(clearanceVisual, position);
        },
        canPlaceBody: (position, clearanceActorId) => this.canPlaceBodyAt(visual, position, clearanceActorId),
        canReach: position => this.movement!.navigation.path(this.movement!.actor(visual), position, 512) !== null,
        relocate: (position, clearance) => this.relocateVisual(enemy.visual, position, clearance),
        face: direction => { enemy.facing = direction; },
        play: (action, frame, complete) => {
          enemy.facing = action.facing;
          action.getAttackSpeedRate=()=>this.conditions.attribute(enemy.key,'attackSpeedRate',1000);
          return this.playAction(presenter,action,frame,complete);
        },
        frame: (action, index, contact, unitsReady, areaContact) => this.presentActionFrame(presenter, action, index, contact, unitsReady,event=>this.skillFeedback(action,event),(definition,work,afterDispatch)=>this.runActionDispatch(action,definition,work,afterDispatch),areaContact),
        contact: event => this.attackContact(event),areaContact:event=>this.basicAreaContact(event),prepareUnit:event=>this.prepareSkillUnit(event),unit:event=>this.skillUnit(event),
        runUnitSequence:work=>(this.hitResolution??=new CombatHitResolution()).run(work),
        unitFeedback:(hit,outcome,cue)=>{
          presenter.showUnitFeedback(hit,outcome,cue);
          if(outcome==='success'&&hit.casterId===this.controlledId&&cue.sound)this.app.audio?.effect(cue.sound);
        },clearEffects: () => {this.runtime.cancel(enemy.key);presenter.clear();}
      };
      enemy.controller=placed.summonedBy&&this.memberOf(placed.summonedBy)
        ?new FriendlySummonController(enemy.key,placed.summonedBy,placed.summonedBySkill==='beast-companion'||definition.id==='enemy-beast-companion-1'?'beast':'hell-soldier',behavior,attack,{
          ...port,canReach:undefined,
          tactics:()=>this.awareness.tactics(placed.summonedBy!,this.activeParty,this.focusTargetId),
          navigationSnapshot:()=>this.movement.navigation.captureStandability(this.movement.actor(visual)),
          tryRecall:()=>this.tryRecallSummon(enemy),
          autonomousTarget:id=>{
            const target=combatActor(this.arena,id,actor=>actor.key);
            return !!target&&!target.definition.displayOnlyReason&&target.definition.behavior.aggression!=='none';
          },
        })
        :new EnemyController(enemy.key,behavior,attack,port,skills);
    }
    if(enemy.controller?.combatController)this.runtime.registerActor(enemy.key,enemy.controller.combatController);
    this.makeSelectable(enemy);
    return enemy;
  }
  private summonFactory(){
    return {
      // 原版清掉的是同一主人的全部活动召唤，不区分是哪一个召唤技能。
      begin:(casterId:string)=>{
        for(const key of [...this.summonGroups.get(casterId)??[]])this.removeEnemy(key);
        this.summonGroups.set(casterId,new Set<string>());
      },
      create:(casterId:string,enemyId:string,spot:Point,summonedStats?:SummonStats,summonTauntChance?:number,
        summonedBySkill?:string):CharacterVisual|undefined=>{
        if(this.closed||this.defeated||!this.movement)return;
        const definition=this.app.battleCatalog.enemies.find(enemy=>enemy.id===enemyId);
        if(!definition?.actor.collision)return;
        // 召唤落点一律按整个碰撞盒校验；不复刻原版「找位失败就复制主人坐标、允许重叠」那条分支。
        if(!this.movement.navigation.canPlaceBody({collision:definition.actor.collision},spot))return;
        const placed=this.roster.placeEnemy(enemyId,spot.x,spot.y);
        placed.summonedBy=casterId;
        placed.summonedStats=summonedStats;
        placed.summonTauntChance=summonTauntChance;
        placed.summonedBySkill=summonedBySkill;
        if(this.memberOf(casterId))placed.level=this.memberOf(casterId)!.level;
        const enemy=this.buildEnemy(placed,definition);
        this.arena.push(enemy);refreshCombatActors(this.arena);
        this.summonGroups.get(casterId)?.add(enemy.key);
        return enemy.visual;
      }
    };
  }
  private destroyEnemy(enemy: MapEnemy,preserveCooldown=false): void {
    if(!preserveCooldown)this.app.session.cooldowns.removeActor(enemy.key);
    this.threat?.removeActor(enemy.key);
    for(const actor of this.arena)actor.controller?.targetRemoved(enemy.key);
    this.combatRuntime?.removeActor(enemy.key);enemy.controller?.dispose(); enemy.presenter.clear();
    this.movement.remove(enemy.visual); enemy.visual.container.destroy(); enemy.assets?.release();
  }
  private clearEnemies(preserveCooldown=false): void {
    for (const enemy of this.arena) this.destroyEnemy(enemy,preserveCooldown);
    this.arena = [];this.threat?.clear();
  }
  /**
   * 技能强制位移的整盒落点。位移是瞬时的，不能像走路那样只检查脚点：
   * 身体压进墙里会让角色看起来卡在墙内。`clearanceActorId` 指定的角色不参与占位。
   */
  private canPlaceBodyAt(visual: CharacterVisual, position: Point, clearanceActorId?: string): boolean {
    if (!this.movement) return false;
    const actor = this.movement.actor(visual);
    const clearance = clearanceActorId ? this.visualOf(clearanceActorId) : undefined;
    const clearanceActor = clearance ? this.movement.actor(clearance) : undefined;
    const placements = clearanceActor
      ? [{ actor: clearanceActor, position: clearanceActor.position(), enabled: false }]
      : [];
    return this.movement.navigation.canPlaceBody(actor.shape(), position, actor, placements);
  }
  /**
   * 技能强制位移：落点按整个碰撞盒判定。失败时保持原位并记录，不迁就到别处——
   * 用目标点附近的 `nearestBody` 兜底可能跨墙瞬移，反而制造新的异常落点。
   * `movement.place` 的严格检查会抛错；它从战斗帧回调里冒出会停掉主循环，所以先自己复核。
   */
  private relocateVisual(visual: CharacterVisual, position: Point, clearanceActorId?: string): boolean {
    if (!this.movement) return false;
    if (this.canPlaceBodyAt(visual, position, clearanceActorId)) { this.movement.place(visual, position); return true; }
    const actor = this.movement.actor(visual), shape = actor.shape();
    if (this.movement.navigation.terrainFree(position) && this.movement.navigation.bodyTerrainFree(shape, position)) {
      this.movement.place(visual, position); return true;
    }
    this.relocationFailures ??= [];
    this.relocationFailures.push({ id: visual.entity.id, position: { ...position } });
    if (this.relocationFailures.length > 8) this.relocationFailures.shift();
    return false;
  }
  private recordSummonContact(sourceId:string,targetId:string):void {
    if(!this.summonAwareness)return;
    const source=this.combatant(sourceId),target=this.combatant(targetId);
    if(source&&target&&source.team!==target.team)this.summonAwareness.contact(source,target,(this.app.session.combatTick??0)*LOGIC_FRAME_MS);
  }
  private observeSummonCombat():void {
    // 直接按队伍和敌人两份名单收集，避免每逻辑帧先拼一份全员数组再 filter/map。
    const observations:{actor:Combatant;action?:ReturnType<CombatController['activeAction']>;chasingTargetId?:string}[]=[];
    for(const id of this.activeParty){
      if(!this.isActorAlive(id))continue;
      const actor=this.combatant(id);if(!actor)continue;
      observations.push({actor,action:this.partyControllers.get(id)?.activeAction()});
    }
    for(const enemy of this.arena){
      if(!this.isActorAlive(enemy.key))continue;
      const actor=this.combatant(enemy.key);if(!actor)continue;
      const controller=enemy.controller;
      observations.push({actor,action:controller?.combatController?.activeAction(),
        chasingTargetId:actor.team!=='party'&&controller?.actionState()==='chasing'?controller.currentTargetId():undefined});
    }
    this.awareness.observe((this.app.session.combatTick??0)*LOGIC_FRAME_MS,observations);
  }
  private tryRecallSummon(enemy:MapEnemy):boolean {
    const owner=enemy.summonedBy&&this.combatant(enemy.summonedBy),actor=this.combatant(enemy.key);
    if(!owner||!actor||!this.isActorAlive(owner.id)||!this.isActorAlive(actor.id)||this.runtime.paused||!this.runtime.idle||
      !this.conditions.canAct(enemy.key)||!this.conditions.canMove(enemy.key)||this.scene.performing||this.partyActionsSuspended)return false;
    const now=(this.app.session.combatTick??0)*LOGIC_FRAME_MS;
    if(this.awareness.quietFor(now)<3000)return false;
    // 警戒覆盖还要检查隐身敌人；旧仇恨记录本身不代表仍在追击。
    const hostile=this.arena.filter(value=>this.combatant(value.key)?.team==='hostile'&&this.isActorAlive(value.key));
    if(hostile.some(value=>{
      const snapshot=value.controller?.snapshot(),action=value.controller?.combatController?.activeAction();
      const target=(snapshot?.state==='chasing'?snapshot.targetId:action?.state==='attacking'?action.targetId:undefined);
      return target&&this.combatant(target)?.team==='party';
    }))return false;
    const safe=(point:Point)=>!hostile.some(value=>{
      const position=this.movement.position(value.visual);
      return Math.floor(Math.max(Math.abs(position.x-point.x),Math.abs(position.y-point.y)) /8)<=value.definition.behavior.awarenessRangeUnits;
    });
    if(!safe(owner.position)||!safe(actor.position))return false;
    const navigation=this.movement.navigation,body=this.movement.actor(enemy.visual),ownerVisual=this.visualOf(owner.id);
    if(!ownerVisual)return false;
    const ownerBody=this.movement.actor(ownerVisual);
    const localFree=(point:Point)=>navigation.terrainFree(point)&&navigation.canPlace(body.shape(),point,body,
      [{actor:ownerBody,position:owner.position,enabled:false}]);
    const seed=stableSeed(enemy.key);
    for(const radius of [24,32,40,48])for(let index=0;index<8;index++){
      const angle=((index+seed%8)%8)*Math.PI/4;
      const point={x:owner.position.x+Math.cos(angle)*radius,y:owner.position.y+Math.sin(angle)*radius};
      if(!this.canPlaceBodyAt(enemy.visual,point)||!safe(point)||
        this.scene.map?.exits.some(exit=>overlapsFootRect(point,exit))||
        this.scene.map?.entities.some(entity=>Math.hypot(point.x-entity.x,point.y-entity.y)<16)||
        !canTraverse(owner.position,point,localFree))continue;
      this.relocateVisual(enemy.visual,point);return true;
    }
    return false;
  }
  private combatants(): Combatant[] {
    return [...this.activeParty.map(id=>this.combatant(id)),...this.arena.map(enemy=>this.combatant(enemy.key))]
      .filter((actor):actor is Combatant=>!!actor);
  }
  private createThreatSystem():CombatThreatSystem {
    return new CombatThreatSystem({
      actor:id=>this.threatActor(id),
      actors:()=>[...this.activeParty,...this.arena.map(enemy=>enemy.key)]
        .flatMap(id=>{const actor=this.threatActor(id);return actor?[actor]:[];}),
      currentTarget:id=>this.enemyTarget(id),
      logicTick:()=>this.app.session.combatTick,
      generationRate:id=>this.actorAttribute(id,'threatGenerationRate'),
      reductionRate:id=>this.actorAttribute(id,'threatReductionRate'),
      normalDamage:id=>{const attributes=this.actorAttributes(id);return attributes
        ?{physical:physicalNormalDamage(attributes),magic:magicNormalDamage(attributes)}:{physical:0,magic:0};},
      tauntSource:id=>this.conditions.snapshot(id).find(state=>state.kind==='state'&&state.id==='taunted')?.sourceId,
      applyTaunt:(source,target)=>this.applyTaunt(source,target),
      combatStarted:id=>combatActor(this.arena,id,actor=>actor.key)?.controller?.onThreatAdded(),
    });
  }
  private threatActor(id:string):CombatThreatActor|undefined {
    const visual=this.visualOf(id);
    if(!visual?.container.active||!visual.actor.collision)return;
    const member=this.memberOf(id),enemy=combatActor(this.arena,id,actor=>actor.key);
    if(!member&&!enemy)return;
    const active=this.combatant(id),state=member?.player??(enemy&&this.roster.enemySnapshot(id,enemy.definition,this.hero.level));
    if(!state)return;
    const friendly=!!(member||this.memberOf(enemy?.summonedBy??''));
    // `player` 必须先判：`memberOf('player')` 也成立。
    const role:CombatThreatRole=id==='player'?'player':member?'member':friendly?'summon':'enemy';
    return {id,team:friendly?'party':'hostile',position:this.movement.position(visual),
      bounds:this.movement.actor(visual).shape().collision!,states:this.conditions.activeStates(id),
      active:!!active,level:state.level,role,tracksThreat:!friendly,
      sightRangeUnits:enemy?enemyAwarenessRangeUnits(enemy.definition.behavior,
        enemy.definition.behavior.engagement==='map-wide'?this.movement.navigation.bounds:undefined,this.actorAttribute(id,'sightBonusUnits')):this.actorAttribute(id,'sightBonusUnits')};
  }
  private applyTaunt(sourceId:string,targetId:string):void {
    const decision=resolveStateApplication({...this.stateApplicationRequest(sourceId,targetId,'taunted'),kind:'buff'});
    if(!decision.allowed)return;
    const lifetime=selectStateDurationProfile({normal:{lastActiveFrame:30},targetShortened:{lastActiveFrame:15}},decision);
    this.conditions.applyStateFrames(targetId,'taunted',lifetime.lastActiveFrame,sourceId);
  }
  /** 原版角色位 +0xc 的 bit2：打出过伤害后置位、初始化时清零，治疗选人据此降低优先级。 */
  private readonly dealtDamage=new Set<string>();
  /**
   * 原版 PLAYER_nDamageCount：队伍成员被敌对单位接战时累计，原版是一个跨全队共享的全局值。
   * 延迟档自动反击据此判断是否转入战斗，在场上阵成员全部打出过伤害后清零。
   */
  private damageCount=0;
  /** 原版 PARTY_IsCombatAll：在场上阵成员全部已进入战斗。 */
  private partyFullyEngaged():boolean {
    const living=this.activeParty.filter(id=>(this.memberOf(id)?.player.health??0)>0);
    return living.length>0&&living.every(id=>this.dealtDamage.has(id));
  }
  /**
   * 固定三槽接收者：按队伍槽顺序取前三名仍在战斗的成员。
   * 与给 cue 用的 partyBuffSlots 不同，这里不筛显示形态也不看距离——原版这两处都是直接遍历槽位。
   */
  private activePartySlots():string[] {
    return this.activeParty.slice(0,ACTIVE_PARTY_SLOT_COUNT).filter(id=>{
      const member=this.memberOf(id);
      return !!member&&!this.fallen?.has(id)&&!this.pendingDefeats?.has(id)&&
        (member.player.health>0||!!this.hitResolution?.isAwaitingDefeat(id));
    });
  }
  /** 治疗评分：生命百分比，打出过伤害的角色按 13/10 放大；召唤物用敌方快照读数。 */
  private healScoreFor(id:string):number|undefined {
    const member=this.memberOf(id);
    const enemy=member?undefined:combatActor(this.arena,id,actor=>actor.key);
    const health=member?.player.health??(enemy?this.roster.enemySnapshot(id,enemy.definition,this.hero.level)?.health:undefined);
    if(health===undefined)return undefined;
    return healTargetScore(health,this.readResourceCapacity(id,'maxHealth'),this.dealtDamage?.has(id)===true);
  }
  /** 原版 CHAR_SelectHealTarget 的角色池顺序：三队伍槽在前，之后是同阵营召唤物。 */
  private healCandidates():readonly HealSlot<Combatant>[] {
    const slots:HealSlot<Combatant>[]=[];
    for(const slot of this.partyBuffSlots()){
      if(!slot)continue;
      slots.push({...slot,score:this.healScoreFor(slot.actor.id)});
    }
    for(const enemy of this.arena){
      if(!enemy.summonedBy||!this.memberOf(enemy.summonedBy))continue;
      const actor=this.combatant(enemy.key);if(!actor)continue;
      const health=this.roster.enemySnapshot(enemy.key,enemy.definition,this.hero.level)?.health??0;
      slots.push({actor,active:!this.pendingDefeats.has(enemy.key)&&(health>0||!!this.hitResolution?.isAwaitingDefeat(enemy.key)),
        hasDisplay:enemy.visual.container.active,score:this.healScoreFor(enemy.key)});
    }
    return slots;
  }
  private partyBuffSlots():readonly (PartyBuffSlot<Combatant>|undefined)[] {
    return this.activeParty.slice(0,ACTIVE_PARTY_SLOT_COUNT).map(id=>{
      const actor=this.combatant(id);if(!actor)return undefined;
      return {actor,active:!this.fallen.has(id)&&((this.memberOf(id)?.player.health??0)>0||!!this.hitResolution?.isAwaitingDefeat(id)),
        hasDisplay:!!this.visualOf(id)?.container.active};
    });
  }
  private memberOf(id:string):BattleCharacter|CompanionMember|undefined{
    return id==='player'?this.hero:this.app.session.party?.get(id);
  }
  /** 主角的技能配置存放在会话里，佣兵自己持有。 */
  private skillConfiguration(id:string,member:BattleCharacter|CompanionMember):StorySkillProgression|CompanionSkillProgression{
    return id==='player'?this.app.session.skills:(member as CompanionMember).skills;
  }
  private isActorAlive(id:string):boolean {
    const member=this.memberOf(id),enemy=combatActor(this.arena,id,actor=>actor.key);
    return (member?.player.health??(enemy?this.roster.enemySnapshot(id,enemy.definition,this.hero.level)?.health:0)??0)>0;
  }
  /** 怪物释放条件用的当前生命与上限；生命按敌方快照读，上限走共用资源面板。 */
  private actorHealth(id:string):{current:number;maximum:number}|undefined {
    const member=this.memberOf(id);
    const enemy=member?undefined:combatActor(this.arena,id,actor=>actor.key);
    const current=member?.player.health??(enemy?this.roster.enemySnapshot(id,enemy.definition,this.hero.level)?.health:undefined);
    return current===undefined?undefined:{current,maximum:this.readResourceCapacity(id,'maxHealth')};
  }
  private presenterFor(id:string):CombatPresenter|undefined{return id==='player'?this.presenter:combatActor(this.allies,id,actor=>actor.id)?.presenter??combatActor(this.arena,id,actor=>actor.key)?.presenter;}
  private skillFeedback(action:ActionPlayback,event:SkillFeedbackEvent):void {
    if(event.shake)this.feedback.startShake();
    if(event.vibrationMs)this.feedback.vibrate(event.vibrationMs);
    // 佣兵和主角一样是玩家阵营；音效不能只给当前操控者，否则切到佣兵前他们出手全静音。
    if(event.sound&&this.memberOf(action.caster.id))this.app.audio?.effect(event.sound);
  }
  private dispatcherFor(presenter:CombatPresenter):CombatActionDispatcher {
    const cache=this.actionDispatchers??=new WeakMap();const existing=cache.get(presenter);if(existing)return existing;
    const dispatcher=new CombatActionDispatcher({runtime:this.runtime,catalog:this.app.battleCatalog,
      actor:id=>this.combatant(id),candidates:()=>this.combatants(),random:()=>Math.random(),
      viewport:()=>this.scene.cameras.main,pose:(action,index)=>presenter.projectFrame(action,index),
      effect:(name,variant,position,placement,id)=>presenter.renderEffect(name,variant,position,placement,id),
      flight:event=>presenter.renderFlight(event),screen:value=>presenter.screenFill(value),
      notify:(name,data)=>this.scene.events.emit(name,data),
      canSummonAt:(position,bounds)=>this.movement.navigation.canPlaceBody({collision:bounds},position),
      nearestSummonSpot:(position,bounds,preferred)=>this.movement.navigation.nearestReachableBody({collision:bounds},position,preferred),
      beginSummons:id=>this.summonFactory().begin(id),
      summon:(ownerId,enemyId,position)=>this.summonFactory().create(ownerId,enemyId,position)?.entity.id,
    });
    cache.set(presenter,dispatcher);return dispatcher;
  }
  private playAction(presenter:CombatPresenter,action:ActionPlayback,frame:(index:number)=>void,complete:()=>void):()=>void {
    this.awareness.action(action.caster,{state:'attacking',targetId:action.target?.id,skill:action.skill},action.target,(this.app.session.combatTick??0)*LOGIC_FRAME_MS);
    const visual=this.visualOf(action.caster.id)!;
    const name=action.skill?(action.skill.clips?.[action.facing]??skillClipName(action.skill.id,action.facing)):action.basicAttack?.clips[action.facing];
    const clip=name?visual.actor.clips[name as keyof typeof visual.actor.clips]:undefined;
    const clear=presenter.play(action),layers=visual.layers;
    const cancel=this.runtime.play(action,{sourceFrames:clip?.frames??1,frameDurationMs:action.basicAttack?.frameDurationMs??LOGIC_FRAME_MS},frame,complete);
    return ()=>{
      cancel();clear();
      // 取消或收尾时直接接回待机，不再依赖后续帧的 afterMovement；
      // 动作已经被别的表现接手时让接手者继续画。
      const idle=`idle-${action.facing}` as ClipName;
      if(visual.container.active&&visual.layers===layers&&visual.actor.clips[idle])setCharacterClip(this.scene,visual,idle,true);
    };
  }
  private presentActionFrame(presenter:CombatPresenter,...args:Parameters<CombatActionDispatcher['frame']>):void {
    (this.hitResolution??=new CombatHitResolution()).run(()=>this.dispatcherFor(presenter).frame(...args));
  }
  private runActionDispatch(action:ActionPlayback,definition:ActionDispatchDefinition,work:()=>void,afterDispatch?:()=>void):void {
    (this.hitResolution??=new CombatHitResolution()).run(()=>{executeActionDispatch(definition.breaksStealth,{
      isStealthed:()=>this.conditions.hasState(action.caster.id,'stealthed'),
      work:()=>{
        work();
        if(definition.shake)this.feedback.startShake();
        if(definition.vibrationMs)this.feedback.vibrate(definition.vibrationMs);
      },
      removeStealth:()=>{
        this.conditions.removeState(action.caster.id,'stealthed');
        const visual=this.visualOf(action.caster.id);if(visual)setCharacterStealth(visual,false);
      },
      afterStealthBreak:()=>this.react({kind:'action-stealth-break',ownerId:action.caster.id}),
      sound:()=>{if(definition.sound&&this.memberOf(action.caster.id))this.app.audio?.effect(definition.sound);},
    });afterDispatch?.();});
  }

  /** 数值单元的主人来源：私有命令动作读主人，其余读施法者自己。 */
  private unitValueSourceId(casterId:string,unit:CombatUnit):string {
    if(!('ownerValues' in unit)||!unit.ownerValues)return casterId;
    return combatActor(this.arena,casterId,actor=>actor.key)?.summonedBy??casterId;
  }
  private prepareSkillUnit(event:SkillUnitStart):PreparedActionDamage|undefined {
    const unit=event.skill.action.combatUnits?.[event.cueIndex];
    if(!unit||!('source' in unit))return;
    const sourceId=this.unitValueSourceId(event.casterId,unit);
    const member=this.memberOf(sourceId);
    if(!member&&!this.arena.some(actor=>actor.key===event.casterId))return;
    const attributes=member?.panel.attributes??{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
    return prepareActionDamage(unit,event.skill.level??1,attributes);
  }

  private commandOwnedSummons(event:SkillUnitHit):SkillUnitOutcome {
    if(!this.memberOf(event.casterId))return 'success';

    const caster=this.combatant(event.casterId);if(!caster)return 'failure';
    // 枚举自己拥有的活动召唤：没有距离限制，也没有模板限制，有受命动作的都会执行。
    const summons=this.arena.filter(enemy=>!this.pendingDefeats.has(enemy.key)&&
      enemy.summonedBy===event.casterId&&!!enemy.definition.commandAction);
    let commanded=false;
    for(const summon of summons){
      const definition=summon.definition.commandAction;if(!definition)continue;
      const command=memberSkillGrowth(event.casterId)==='companion'&&definition.companionAction?
        {...definition,action:definition.companionAction}:definition;
      // 命令是围绕召唤物自身的范围动作：沿它当前的目标，没有目标就原地施放，不强制追最近的敌人。
      const current=this.enemyTarget(summon.key);
      const target=current&&this.arena.some(enemy=>enemy.key===current&&canTargetCombatant(caster,this.combatant(current)!))?
        combatActor(this.arena,current,actor=>actor.key):undefined;
      summon.controller?.command(command,target?.key,event.skill.level??1);commanded=true;
    }
    // 没有可受命的召唤时这一步不成立，也就不会耗掉这次施放的资源。
    return commanded?'success':'failure';

  }
  private summonFromUnit(event:SkillUnitHit,unit:Extract<CombatUnit,{effect:'summon'}>,rank:number):SkillUnitOutcome {
    if(!unit.creature||!this.memberOf(event.casterId)||!this.movement)return 'success';

    const creature=this.app.battleCatalog.enemies.find(enemy=>enemy.id===unit.creature);
    if(!creature?.actor.collision)return 'success';
    const factory=this.summonFactory();factory.begin(event.casterId);
    const ownerLevel=this.memberOf(event.casterId)?.level??1;
    const rankValues=unit.ranks[rank];
    const derived=unit.ownerDerived?summonOwnerStats(unit.ownerDerived,rankValues,ownerLevel,
      this.memberOf(event.casterId)?.panel.attributes):undefined;
    const placement={searchGapPx:32,searchExtentPx:48,offsetChoices:[{x:0,y:0}],jitterPx:0};
    const casterVisual=this.visualOf(event.casterId)!;
    const casterPosition=this.movement.position(casterVisual);
    const casterFacing=this.combatant(event.casterId)?.facing??'south';
    const summonBounds=creature.actor.collision,navigation=this.movement.navigation;
    // 近处搜到的点必须能从主人处走到；走不到就在可达区域里找最近的整盒落点。
    const preferred=planSummonSpot(casterPosition,casterVisual.actor.collision!,casterFacing,placement,
      point=>navigation.canPlaceBody({collision:summonBounds},point));
    const spot=navigation.nearestReachableBody({collision:summonBounds},casterPosition,preferred);
    if(!spot)return 'failure';
    const visual=factory.create(event.casterId,unit.creature,spot,derived,rankValues.tauntChanceThreshold,event.skill.id);
    if(visual){
      const summon=this.arena.find(enemy=>enemy.visual===visual)!;
      this.presenterFor(event.casterId)?.showEffects(summon.key,unit.appearanceEffects??[]);
      // 有主人侧换算规则的召唤物（驯兽）寿命在施放时按主人属性算，否则用本等级帧寿命。
      const frames=unit.lifetimeFromOwner===undefined?undefined:summonLifetimeFrames(unit.lifetimeFromOwner,
        this.actorAttribute(event.casterId,unit.lifetimeFromOwner.attribute));
      summon.summonRemainingMs=frames===undefined?rankValues.durationMs:(frames+1)*60;
    }
    return 'success';

  }
  private skillUnit(event:SkillUnitHit):SkillUnitOutcome {
    this.recordSummonContact?.(event.casterId,event.targetId);
    return (this.effectExecutor??=new CombatEffectExecutor({conditions:this.conditions,threat:this.threat,random:()=>Math.random(),
      run:work=>(this.hitResolution??=new CombatHitResolution()).run(work),
      available:id=>!this.closed&&!this.defeated&&!this.pendingDefeats.has(id)&&!this.fallen?.has(id),
      partySide:id=>!!this.memberOf(id)||!!this.memberOf(combatActor(this.arena,id,actor=>actor.key)?.summonedBy??''),
      fighter:id=>{const enemy=combatActor(this.arena,id,actor=>actor.key);return this.memberOf(id)?this.partyFighter(id):enemy&&this.enemyFighter(enemy.key,enemy.definition,this.hero.level);},
      position:id=>this.combatant(id)?.position,
      vitals:id=>{const member=this.memberOf(id),enemy=combatActor(this.arena,id,actor=>actor.key);return member?.player??(enemy&&this.roster.enemySnapshot(id,enemy.definition,this.hero.level));},
      attribute:(id,key)=>this.actorAttribute(id,key),valueSourceId:(id,unit)=>this.unitValueSourceId(id,unit),prepare:hit=>this.prepareSkillUnit(hit),
      applyBuff:(id,key,strength,effect,source)=>this.applyActorBuff(id,key,strength,effect,source),
      stateRequest:(source,target,state)=>this.stateApplicationRequest(source,target,state),stateAccepted:(id,state)=>this.applyStateConsequences(id,[state]),
      commandSummons:hit=>this.commandOwnedSummons(hit),summon:(hit,unit,rank)=>this.summonFromUnit(hit,unit,rank),
      restoreHealth:(id,amount)=>this.restoreHealth(id,amount),
      setMana:(id,value)=>{const member=this.memberOf(id),enemy=combatActor(this.arena,id,actor=>actor.key);if(member)member.setMana(value);else if(enemy)this.roster.setEnemyMana(id,value,enemy.definition);},
      healAccepted:(ownerId,targetId)=>this.react({kind:'direct-heal-accepted',ownerId,targetId}),learnedBuff:(id,key)=>this.learnedReactionBuff(id,key),
      rearBonus:(source,target)=>this.rearPenetrationBonus(source,target),
      reactions:(hit,result,kind,position)=>this.resolveHitReactions(hit,result,kind,hit.skill.id,this.hero,position),
      hit:(hit,result,presentation)=>this.settleHit(hit,result,this.hero,combatActor(this.arena,hit.targetId,actor=>actor.key),presentation),
      dropMana:(id,damage,position,kind)=>this.dropMana(id,damage,position,kind),showHit:(hit,result,presentation)=>this.showHit(hit,result,presentation),
    })).execute(event);
  }

  private basicAreaContact(event:BasicAreaContact):void {
    (this.hitResolution??=new CombatHitResolution()).run(()=>{
      const caster=this.combatant(event.casterId),targeting=event.basicAttack.targeting;
      if(!caster||!targeting)return;
      const targets=resolveCueTargets(targeting,caster,undefined,this.combatants(),[],
        this.actorAttribute(event.casterId,'attackRangeBonusUnits')).slice(0,MAX_SKILL_TARGETS);
      for(const target of targets)this.attackContact({casterId:event.casterId,targetId:target.id,basicAttack:event.basicAttack});
    });
  }
  private attackContact(event: AttackContact): void {
    (this.hitResolution??=new CombatHitResolution()).run(()=>{
      if(this.defeated||this.closed||this.fallen?.has(event.casterId)||this.fallen?.has(event.targetId)||
        this.pendingDefeats?.has(event.casterId)||this.pendingDefeats?.has(event.targetId))return;
      this.recordSummonContact?.(event.casterId,event.targetId);
      // 计数在派发之前累加，第 3 次受击当帧就能满足延迟档的门槛。
      if(this.memberOf(event.targetId)&&!this.memberOf(event.casterId))this.damageCount++;
      if(event.skillId){
        this.scene.events.emit('attack-contact',event);
        if(this.enemiesRunning&&!this.pendingDefeats.has(event.targetId))combatActor(this.arena,event.targetId,actor=>actor.key)?.controller?.onContact(event);
        if(this.enemiesRunning&&event.targetId!==this.controlledId)combatActor(this.allies,event.targetId,actor=>actor.id)?.ai.onContact(event);
        if(this.enemiesRunning&&event.targetId==='player'&&this.controlledId!=='player')this.heroAi?.onContact(event);
        return;
      }
      if(!this.conditions.canLoseHealth(event.targetId)){
        this.showHit(event,{kind:'hit',damage:0},{style:event.basicAttack?.hitEffectStyle??'weapon',sound:true});
        return;
      }
      const hero=this.hero;
      const targetEnemy=combatActor(this.arena,event.targetId,actor=>actor.key);
      const sourceEnemy=combatActor(this.arena,event.casterId,actor=>actor.key);
      const source=this.memberOf(event.casterId)?this.partyFighter(event.casterId):sourceEnemy&&this.enemyFighter(sourceEnemy.key,sourceEnemy.definition,hero.level);
      const target=this.memberOf(event.targetId)?this.partyFighter(event.targetId):targetEnemy&&this.enemyFighter(targetEnemy.key,targetEnemy.definition,hero.level);
      if(!source||!target)return;
      const targetPosition=this.combatant(event.targetId)?.position;
      const sourceVisual=this.visualOf(event.casterId);
      const profile=event.basicAttack??(this.memberOf(event.casterId)&&sourceVisual?this.equipmentAttack(sourceVisual.actor,event.casterId):
        sourceEnemy?.definition.basicAttack?this.app.battleCatalog.basicAttacks[sourceEnemy.definition.basicAttack.profileId]:undefined);
      const attributes=this.actorAttributes(event.casterId);
      if(!profile||!attributes)return;
      const damageSource=actionDamageSource(attributes);
      // 背后渗透走物理伤害率那一项，先看目标当前在打谁；魔法不加。
      const rear=profile.damage.effect==='physical'?this.rearPenetrationBonus(event.casterId,event.targetId):0;
      if(event.hand==='offhand'&&profile.damage.effect==='physical'){
        const member=this.memberOf(event.casterId);
        if(!member)return;
        const equipped=member.bag.equipmentFor(event.casterId);
        const power=(slot:'main-hand'|'off-hand')=>{
          const key=equipped[slot],entry=key?member.bag.get(key):undefined;
          return entry?equipmentPower(this.hero.catalog.equipment[entry.item],entry).attack:0;
        };
        damageSource.physicalAttack=offhandPhysicalAttack(damageSource.physicalAttack,power('main-hand'),power('off-hand'));
      }
      const amount=actionDamage(profile.damage,1,damageSource);
      const hit=profile.damage.effect==='magic'?rollMagicHit(source,target,amount):rollPhysicalHit(source,target,Math.random,amount,rear);
      this.resolveHitReactions(event,hit,profile.damage.effect,'basic-attack',hero,targetPosition);
      this.settleHit(event,hit,hero,targetEnemy,{style:profile?.hitEffectStyle??'weapon',sound:true});
      this.dropMana(event.casterId,hit.damage,targetPosition);
      this.scene.events.emit('attack-contact', {...event,...hit});
      if(this.enemiesRunning&&targetEnemy&&!this.pendingDefeats.has(targetEnemy.key)&&this.arena.includes(targetEnemy))targetEnemy.controller?.onContact(event);
      if(this.enemiesRunning&&event.targetId!==this.controlledId)combatActor(this.allies,event.targetId,actor=>actor.id)?.ai.onContact(event);
      if(this.enemiesRunning&&event.targetId==='player'&&this.controlledId!=='player')this.heroAi?.onContact(event);
    });
  }
  /** 召唤物打中目标后的主人侧反应：先按固定值回魔，再按嘲讽机会拉走目标，最后判完美配合。 */
  private summonOwnerReactions(event:AttackContact,hit:PhysicalHit,damageKind:'physical'|'magic'):void {
    if(hit.kind==='miss')return;
    const summon=combatActor(this.arena,event.casterId,actor=>actor.key),ownerId=summon?.summonedBy;
    if(!summon||!ownerId)return;
    // 主人侧的反应按主人自己的已学等级结算；主人不在队伍里就不判断。
    if(this.memberOf(ownerId))this.react({kind:'summon-attack-success',ownerId,opponentId:event.targetId,
      damageKind,outcome:hit.kind});
    // 嘲讽阈值按主人当前已学等级读原表：召唤后改等级即时生效，忘掉技能就不再嘲讽。
    const chance=this.summonTauntChanceFor(summon,ownerId);
    if(this.threat&&chance>0&&this.enemyTarget(event.targetId)!==event.casterId&&passesChanceThreshold(chance))
      this.threat.taunt(event.casterId,event.targetId);
    if(this.memberOf(ownerId))this.react({kind:'summon-physical-success',ownerId,opponentId:event.targetId,
      damageKind,outcome:hit.kind});
  }
  /** 召唤物命中时读主人当前技能等级的嘲讽阈值；没有记录召唤技能时退回创建时的快照。 */
  private summonTauntChanceFor(summon:MapEnemy,ownerId:string):number {
    const skillId=summon.summonedBySkill;
    if(!skillId)return summon.summonTauntChance??0;
    const member=this.memberOf(ownerId);if(!member)return 0;
    const configuration=ownerId==='player'?this.app.session?.skills:(member as CompanionMember).skills;
    const level=configuration?.draft(this.app.battleCatalog,member.classId).levels[skillId];
    if(!level)return 0;
    const unit=skillForMember(this.app.battleCatalog,ownerId,skillId)?.action?.combatUnits?.find(entry=>entry.effect==='summon');
    if(unit?.effect!=='summon')return summon.summonTauntChance??0;
    return unit.ranks[Math.min(unit.ranks.length-1,level-1)]?.tauntChanceThreshold??0;
  }
  /** 敌人当前的动作目标；与仇恨系统的读取口径相同。 */
  /** 这个角色当前的动作目标；队伍成员与敌人都看各自的控制器。 */
  private currentTargetOf(id:string):string|undefined {
    const enemy=combatActor(this.arena,id,actor=>actor.key);
    if(enemy)return this.enemyTarget(id);
    return this.partyControllers.get(id)?.selectedTargetId();
  }
  /** 背后渗透：目标当前的动作目标不是攻击者时，按已学等级加物理伤害率；目标没有目标也满足。 */
  private rearPenetrationBonus(attackerId:string,targetId:string):number {
    const rate=this.actorAttribute(attackerId,'rearPenetrationRate');
    if(rate<=0)return 0;
    return this.currentTargetOf(targetId)===attackerId?0:rate;
  }
  private enemyTarget(id:string):string|undefined {
    const controller=combatActor(this.arena,id,actor=>actor.key)?.controller;
    return controller?.combatController?controller.combatController.selectedTargetId():controller?.currentTargetId();
  }
  private settleHit(event:AttackContact,hit:PhysicalHit,hero:BattleCharacter,targetEnemy?:MapEnemy,presentation:{style?:HitEffectStyle;periodic?:boolean;sound?:boolean}={}):void {
    if(this.pendingDefeats.has(event.targetId)||!this.conditions.canLoseHealth(event.targetId)
      ||targetEnemy&&this.app.session.storyWorld?.visible(targetEnemy.key)===false)return;
    this.recordSummonContact?.(event.casterId,event.targetId);
    if(hit.damage){
      if(hit.damage>0)this.conditions.removeState(event.targetId,'sleep');
      const recipient=this.memberOf(event.targetId);
      if(recipient){const wasAlive=recipient.player.health>0;
        if(hit.damage>0)this.readResourceCapacity(event.targetId,'maxHealth');
        recipient.setHealth(recipient.player.health-hit.damage);
        if(wasAlive&&recipient.player.health===0)(this.hitResolution??=new CombatHitResolution()).deferDefeat(event.targetId,()=>{
          if(recipient.player.health===0)this.memberDefeated(event.targetId);
        });}
      else if(targetEnemy){
        const before=this.roster.enemySnapshot(targetEnemy.key,targetEnemy.definition,hero.level)!;
        // GM 一击必杀：命中后按目标当前生命结算，跳过防御与减伤；未命中的攻击仍然落空。
        if(this.app.session.isOneHitKill(event.casterId))hit.damage=Math.max(hit.damage,before.health);
        const proposed=Math.max(0,before.health-hit.damage);
        const interrupted=hit.damage>0&&this.app.director?.healthChanged?.(targetEnemy.definition.id,before.health,proposed,before.maxHealth,{id:targetEnemy.key,map:this.scene.map!.id,x:targetEnemy.visual.container.x,y:targetEnemy.visual.container.y});
        // 捕捉已完成：这一槽已经变成同格 NPC。源怪要立刻退场，否则同一串多段伤害
        // 会接着打死只剩 1 点血的它，播死亡表现、结算击杀奖励和掉落。
        if(interrupted&&this.app.session.enemyVitals(targetEnemy.key).capture){this.removeEnemy(targetEnemy.key);return;}
        const remaining=interrupted?Math.max(1,proposed):proposed;
        this.roster.setEnemyHealth(targetEnemy.key,remaining,targetEnemy.definition);
        if(before.health>0&&remaining===0)(this.hitResolution??=new CombatHitResolution()).deferDefeat(targetEnemy.key,()=>{
          if(this.closed||this.pendingDefeats.has(targetEnemy.key)||
            (this.roster.enemySnapshot(targetEnemy.key,targetEnemy.definition,hero.level)?.health??0)>0)return;
          this.app.audio?.monsterDeath(targetEnemy.definition.id);
          const reward=calculateEnemy(targetEnemy.definition,{level:before.level,elite:before.elite,
            partySize:Math.max(1,this.app.session.party?.livingIds.length??1),playerLevel:hero.level}).experience;
          const spawn=this.roster.source(targetEnemy.key);
          const earnsExperience=!!(this.memberOf(event.casterId)||this.arena.some(enemy=>enemy.key===event.casterId&&this.memberOf(enemy.summonedBy??'')));
          const session=this.app.session,level=hero.level,map=this.scene.map!.id;
          const {x,y}=targetEnemy.visual.container,key=targetEnemy.key;
          this.pendingDefeats.add(key,render=>{
            this.runtime.cancel(`defeat:${key}`);this.outcomes.cancelDeath(key);
            if(spawn)session.enemyDefeated(spawn);
            const breakable=breakableKindOf(targetEnemy.definition.id);
            if(spawn){
              const enemyId=targetEnemy.definition.id;
              const rule=this.drops.enemies[enemyId];
              if(breakable){
                // 景物怪只掷一次：地图等级优先，地图没有有效等级时沿用玩家等级。
                const lootLevel=(this.scene.map?.lootLevel??0)>0?this.scene.map!.lootLevel!:level;
                const rolled=rollBreakableLoot(this.drops,this.app.characterStats,breakable,lootLevel,hero.level,Math.random,
                  session.party?.groupModifiers());
                this.scene.spawnLootOnMap(map,x,y,rolled.rewards,render&&!this.closed);
                session.chests.spawnBreakableEnemies(map,key,rolled.enemies,{x,y});
              }else if(rule&&!rule.noNormalDrops){
              // 没有掉落规则或原版标记「无普通掉落」的敌人不掷骰，也不消耗首杀/保底计数；
              // 任务掉落在同块之外，仍按原版 CHARSYSTEM_Die 的闸门后顺序执行。
                const chapterLevel=(this.scene.map?.lootLevel??0)>0?this.scene.map!.lootLevel!:(rule.level??level);
                const pity=this.drops.pity;
                const pityConfig=pity?{equipment:pity.equipment,unique:pity.unique,epic:pity.epic,levelWindow:pity.levelWindow}:undefined;
                const boss=rule.threat==='boss';
                const firstBoss=boss?session.lootPity.takeBossFirstDefeat(enemyId):false;
                const owners=session.party?.livingIds??['player'];
                const offsets=[0,5,-5];
                owners.forEach((ownerId,index)=>{
                  const member=ownerId==='player'?hero:session.party?.get(ownerId);
                  const memberLevel=member?.level??level;
                  const eligibility=specialDropEligibility(this.drops,memberLevel,rule.level??level,chapterLevel);
                  const guarantee=firstBossGuarantee(pity,firstBoss);
                  const equipmentBonus=guarantee.equipmentBonus||(pityConfig?session.lootPity.equipmentBonus(ownerId,pityConfig):0);
                  const uniqueBonus=eligibility.unique&&pityConfig?session.lootPity.uniqueBonus(ownerId,pityConfig):0;
                  const epicBonus=eligibility.epic&&pityConfig?session.lootPity.epicBonus(ownerId,pityConfig):0;
                  const uniqueGuarantee=eligibility.unique&&pityConfig?session.lootPity.uniqueGuaranteed(ownerId,pityConfig):false;
                  const epicGuarantee=eligibility.epic&&pityConfig?session.lootPity.epicGuaranteed(ownerId,pityConfig):false;
                  const minRarity=guarantee.minRarity;
                  const rolled=rollEnemyLoot(this.drops,this.app.characterStats,enemyId,memberLevel,chapterLevel,Math.random,
                    session.party?.groupModifiers(),{equipmentBonus,uniqueBonus,uniqueGuarantee,epicBonus,epicGuarantee,minRarity,itemChance:session.partyItemChance});
                  const equipment=rolled.rewards.filter(reward=>reward.kind==='item'&&!!reward.roll);
                  const bestRarity=equipment.reduce((best,reward)=>Math.max(best,reward.kind==='item'&&reward.roll?reward.roll.rarity:0),0);
                  session.lootPity.recordEnemy(ownerId,{equipment:equipment.length>0,bestRarity},eligibility);
                  const offset=offsets[index%offsets.length]!;
                  this.scene.spawnLootOnMap(map,x+offset,y,rolled.rewards,render&&!this.closed);
                });
              }
              // 任务掉落保持共享：每次击杀最多一件，不随队伍人数翻倍。
              // 已掉在地上还没捡的同类物品也要算进持有量，避免任务需求满了还继续产出。
              this.scene.spawnLootOnMap(map,x,y,rollQuestDrops(this.drops,enemyId,
                session.questDropRequirements(groundLootFor(session).pendingItemCounts())),render&&!this.closed);
            }
            this.removeEnemy(key);
            if(breakable)this.syncChestEnemies();
            if(!breakable&&earnsExperience&&reward>0){
              const members=(session.party?.livingIds??[]).map(id=>({id,member:this.memberOf(id)!}));
              const levels=members.map(({member})=>member.level);
              session.party?.addExperience(reward);
              if(render&&!this.closed)for(let index=0;index<members.length;index++){
                const {id,member}=members[index],visual=this.visualOf(id);
                if(member.level>levels[index]&&visual?.container.active){
                  this.outcomes.levelUp(visual);this.app.audio?.playerLevelUp();
                }
              }
            }
          });
          this.threat?.removeActor(key);
          for(const enemy of this.arena)enemy.controller?.targetRemoved(key);
          targetEnemy.controller?.dispose();targetEnemy.presenter.clear();
          this.conditions.remove(key);this.movement.stop(targetEnemy.visual);
          this.movement.setEnabled(targetEnemy.visual,false);targetEnemy.visual.container.disableInteractive();
          for(const controller of this.partyControllers.values())controller.targetRemoved(key);
          if(this.focusTargetId===key)this.focusTargetId=undefined;
          this.scene.refreshCombatTarget();
          if(targetEnemy.definition.defeatPresentation==='vanish'){
            this.outcomes.vanish(key,targetEnemy.visual,()=>{});
            this.runtime.schedule(`defeat:${key}`,11,()=>this.pendingDefeats.complete(key));
          }else this.pendingDefeats.complete(key);
        });
      }
      if(hit.damage>0){this.dealtDamage?.add(event.casterId);this.threat?.damage(event.casterId,event.targetId,hit.damage);}
    }
    this.showHit(event,hit,presentation);
  }
  private restoreHealth(id:string,amount:number):void {
    const member=this.memberOf(id);
    if(member){
      if(!this.fallen?.has(id)&&(member.player.health>0||this.hitResolution?.isAwaitingDefeat(id))){
        const capacity=this.readResourceCapacity(id,'maxHealth');
        member.setHealth(Math.min(capacity,member.player.health+amount));
      }
      return;
    }
    const enemy=combatActor(this.arena,id,actor=>actor.key);
    if(!enemy||this.pendingDefeats.has(id))return;
    const state=this.roster.enemySnapshot(id,enemy.definition,this.hero.level);
    if(state&&(state.health>0||this.hitResolution?.isAwaitingDefeat(id)))this.roster.setEnemyHealth(id,state.health+amount,enemy.definition);
  }
  private showBuffApplication(sourceId:string,targetId:string,effect:string):void {
    const member=this.memberOf(targetId),enemy=combatActor(this.arena,targetId,actor=>actor.key);
    const health=member?.player.health??(enemy?this.roster.enemySnapshot(targetId,enemy.definition,this.hero.level)?.health:0)??0;
    const follows=health>0&&!this.pendingDefeats.has(targetId)&&!this.fallen?.has(targetId);
    this.presenterFor(sourceId)?.showBuffApplication(targetId,effect,follows);
  }
  /** 清空一名角色的技能冷却；有控制器的走控制器，其余走冷却表。 */
  private resetActorCooldowns(id:string):void {
    const controller=this.partyControllers.get(id)??combatActor(this.arena,id,actor=>actor.key)?.controller?.combatController;
    if(controller)controller.resetSkillCooldowns();
    else this.app.session.cooldowns.resetActor(id);
  }
  private learnedReactionBuff(id:string,skillId:LearnedReactionSkill):SkillReactionBuff|undefined {
    const member=this.memberOf(id);if(!member)return;
    const configuration=this.skillConfiguration(id,member);
    const level=configuration.draft(this.app.battleCatalog,member.classId).levels[skillId];
    if(!level||level<1)return;
    if(skillId==='whist'){
      const unit=skillForMember(this.app.battleCatalog,id,'whist')?.action?.combatUnits?.find(value=>value.effect==='buff');
      if(unit?.effect!=='buff')return;
      const rank=unit.ranks[Math.min(level,unit.ranks.length)-1];
      return {key:unit.buff,rankPriority:rank.strength,effect:rank.effect};
    }
    // 这几项的「已学到的那一级」就是导出里的子增益定义本体；灵魂之刃走下面的动作单元。
    if(skillId==='armor-penetration'||skillId==='revenge-incarnate'||skillId==='bard-of-destruction'||
      skillId==='deep-breath'||skillId==='sniping'||skillId==='blood-revenge'){
      const ranks=skillForMember(this.app.battleCatalog,id,skillId)?.reactionsByRank;
      const reaction=ranks?.[Math.min(level,ranks.length)-1]?.find(reaction=>reaction.kind===skillId);
      return reaction&&'buff' in reaction?reaction.buff:undefined;
    }
    const unit=skillForMember(this.app.battleCatalog,id,skillId)?.action?.combatUnits?.find(unit=>unit.effect==='buff'&&unit.buff==='dark-strike');
    if(unit?.effect!=='buff')return;
    const rank=unit.ranks[Math.min(level,unit.ranks.length)-1];
    return {key:unit.buff,rankPriority:rank.strength,effect:rank.effect};
  }
  private react(event:SkillReactionEvent):void {
    const apply=(command:SkillReactionCommand)=>{
      if(command.kind==='restore-health')this.restoreHealth(command.targetId,command.amount);
      else if(command.kind==='restore-mana')this.restoreMana(command.targetId,command.amount);
      else if(command.kind==='play-effect')this.presenterFor(event.ownerId)?.showEffects(command.targetId,[{effect:command.effect,recipient:'target',placement:'attached'}]);
      else if(command.kind==='reset-skill-cooldowns')this.resetActorCooldowns(command.targetId);
      else if(command.kind==='apply-party-buff'){
        for(const id of this.activePartySlots())this.applyActorBuff(id,command.buff.key,command.buff.rankPriority,command.buff.effect,command.sourceId);
      }
      else this.applyActorBuff(command.targetId,command.buff.key,command.buff.rankPriority,command.buff.effect,command.sourceId);
    };
    if(event.kind==='blood-thirst'){
      executeBloodThirstReaction(event,{random:Math.random,
        lifeDrainPerThousand:()=>this.actorAttribute(event.ownerId,'bloodThirstLifeDrainPerThousand'),
        manaRecovery:()=>this.actorAttribute(event.ownerId,'bloodThirstManaRecovery'),apply});
      return;
    }
    let reactions:SkillReaction[]=[];
    if(event.kind!=='physical-attack-effects'&&event.kind!=='physical-revenge'&&event.kind!=='physical-instinct'&&event.kind!=='physical-defense-instinct'){
      const member=this.memberOf(event.ownerId);if(!member)return;
      const configuration=this.skillConfiguration(event.ownerId,member);
      reactions=learnedSkillReactions(this.app.battleCatalog,member.classId,configuration.draft(this.app.battleCatalog,member.classId),memberSkillGrowth(event.ownerId));
    }
    const commands=resolveSkillReactions(reactions,event,{random:Math.random,learnedBuff:(id,skill)=>this.learnedReactionBuff(id,skill)});
    for(const command of commands)apply(command);
  }
  private reactToBuff(event:BuffReactionEvent):void {
    const commands=resolveBuffReactions(this.conditions.buffReactions(event.ownerId),event);
    for(const command of commands){
      if(command.kind==='apply-buff')this.applyActorBuff(command.targetId,command.buff.key,command.buff.rankPriority,command.buff.effect,command.sourceId);
      else if(command.kind==='restore-mana')this.restoreMana(command.targetId,command.amount);
      else if(command.kind==='play-effect')this.presenterFor(event.ownerId)?.showEffects(command.targetId,[{effect:command.effect,recipient:'target',placement:'attached'}]);
      else if(command.kind==='apply-state')this.applyReactionState(command);
      else this.threat?.redistributeAfterPhysicalHit(command.sourceId,command.targetId,command.damage);
    }
  }
  /** 受击者是否属于队伍阵营：队员本人，或主人是队员的召唤物。 */
  private partySide(id:string):boolean {
    return !!this.memberOf(id)||!!this.memberOf(combatActor(this.arena,id,actor=>actor.key)?.summonedBy??'');
  }
  /**
   * 扰乱：受击方读自己的已学等级与阈值，抽一次；通过后在同阵营里挑候选（自己拥有的召唤物优先，
   * 其次有效防御严格更高且最高者），候选不是攻击者当前目标时才让它去嘲讽。
   */
  /**
   * 地狱之落雷：魔法暴击后按已学等级抽一次，抽中就对同一目标执行私有动作 111。
   * 私有动作没有技能标记，所以不吃技能伤害加成，但照常命中、暴击并再次进入本判定。
   */
  private followUpPort(casterId:string):CombatFollowUpPort {
    const view=()=>this.presenterFor(casterId);
    return {catalog:this.app.battleCatalog,runtime:this.runtime,random:()=>Math.random(),active:()=>!this.closed&&!this.defeated,
      actor:id=>this.combatant(id),loadout:id=>{
        const member=this.memberOf(id);if(!member||!this.app.session)return;
        const configuration=this.skillConfiguration(id,member);
        return configuration?{classId:member.classId,skills:configuration.draft(this.app.battleCatalog,member.classId)}:undefined;
      },casterStrikes:(id,strikes)=>{const presenter=view();if(presenter)this.dispatcherFor(presenter).casterStrikes(id,strikes);},
      flight:{actor:id=>this.combatant(id),emit:event=>view()?.renderFlight(event),effect:(name,position)=>view()?.renderEffect(name,'default',position)},
      execute:(owner,target,skillId,level,action,origin)=>this.runSkillUnitSequence({casterId:owner,skillId,level,action,origin,selectedTargetId:target,presenter:view()})};
  }
  private lightningOfHellReaction(casterId:string,targetId:string):void {if(!this.memberOf(casterId)||!this.app.session)return;combatFollowUp('lightning-of-hell',casterId,targetId,this.followUpPort(casterId));}
  private godOfJusticeReaction(casterId:string,targetId:string):void {if(!this.memberOf(casterId)||!this.app.session)return;combatFollowUp('god-of-justice',casterId,targetId,this.followUpPort(casterId));}

  private runSkillUnitSequence(request:{casterId:string;skillId:string;level:number;action:SkillAction;
      origin?:Point;selectedTargetId?:string;presenter?:CombatPresenter}):void {
    const {casterId,skillId,level,action,presenter}=request;
    const event=action.events.find(entry=>entry.kind==='units');
    executeSkillUnits({casterId,skill:{id:skillId,level,action},cues:event?.kind==='units'?event.cues:[],
      origin:request.origin,selectedTargetId:request.selectedTargetId},{
      actor:id=>this.combatant(id),candidates:()=>this.combatants(),partySlots:()=>this.partyBuffSlots(),
      rangeBonusUnits:id=>this.actorAttribute(id,'attackRangeBonusUnits'),healScore:id=>this.healScoreFor(id),
      healCandidates:()=>this.healCandidates(),currentTargetId:()=>this.currentTargetOf(casterId),
      prepareUnit:start=>this.prepareSkillUnit(start),unit:hit=>this.skillUnit(hit),
      runUnitSequence:work=>(this.hitResolution??=new CombatHitResolution()).run(work),
      unitFeedback:(hit,outcome,cue)=>presenter?.showUnitFeedback(hit,outcome,cue),
    });
  }
  private disturbanceReaction(attackerId:string,defenderId:string):void {
    // 队伍会话是这一项的前提：没有它就没有已学等级，也没有候选池。
    if(!this.app.session)return;
    const member=this.memberOf(defenderId);if(!member)return;
    // 没有技能配置就等于没学过这条被动（不入队的角色本来也没有已学等级）。
    const configuration=defenderId==='player'?this.app.session?.skills:(member as CompanionMember).skills;
    if(!configuration)return;
    const threshold=learnedSkillReactions(this.app.battleCatalog,member.classId,
      configuration.draft(this.app.battleCatalog,member.classId),memberSkillGrowth(defenderId))
      .find(reaction=>reaction.kind==='disturbance')?.chanceThreshold??0;
    if(!(threshold>0)||Math.floor(Math.random()*999)+1>=threshold)return;
    const self=this.combatant(defenderId);if(!self)return;
    const actors=this.combatants().flatMap(candidate=>{
      const actor=this.combatant(candidate.id);
      if(!actor)return [];
      const summon=combatActor(this.arena,candidate.id,actor=>actor.key)?.summonedBy;
      return [{id:candidate.id,sameCamp:actor.team===self.team,ownSummon:summon===defenderId,
        position:actor.position,bounds:actor.bounds,
        // 双方都取当前防御并按防御率换算：装备、增益与被动都要算进去。
        effectiveDefense:calculateEffectiveDefense(this.actorAttribute(candidate.id,'defense'),
          this.actorAttribute(candidate.id,'defenseRate'))}];
    });
    const candidateId=disturbanceCandidate({id:defenderId,sameCamp:true,ownSummon:false,position:self.position,
      bounds:self.bounds,effectiveDefense:calculateEffectiveDefense(this.actorAttribute(defenderId,'defense'),
        this.actorAttribute(defenderId,'defenseRate'))},actors);
    if(!candidateId||candidateId===this.currentTargetOf(attackerId))return;
    this.threat?.taunt(candidateId,attackerId);
  }
  /** 每个学过血之复仇的槽位各判一次自己的已学等级；来源就是该队员自己，所以不经过被攻击者。 */
  private partyRevengeReactions(attackerId:string,damageKind:'physical'|'magic',outcome:PhysicalHit['kind']):void {
    for(const id of this.activePartySlots())
      this.react({kind:'blood-revenge',ownerId:id,opponentId:attackerId,damageKind,outcome});
  }
  private equipmentRecovery(id:string):ReturnType<typeof equipmentRecoveryModifiers> {
    const member=this.memberOf(id);
    const equipped=member?Object.values(member.bag.equipmentFor(id)).flatMap(item=>{const entry=member.bag.get(item!);return entry?[entry]:[];}):[];
    return equipmentRecoveryModifiers(equipped);
  }
  private combatProcs(id:string):ReturnType<typeof equipmentCombatProcs> {
    const member=this.memberOf(id);
    const equipped=member?Object.values(member.bag.equipmentFor(id)).flatMap(item=>{const entry=member.bag.get(item!);return entry?[entry]:[];}):[];
    return equipmentCombatProcs(equipped);
  }
  /** 原版物理成功链：重力摆 -> 冰霜 -> 治愈气息，均在主伤害提交前结算。 */
  private physicalSuccessEquipmentProcs(event:AttackContact,_hit:PhysicalHit,random:()=>number=Math.random):void {
    const caster=this.combatProcs(event.casterId),target=this.combatProcs(event.targetId);
    if(caster.pendulumStunChance>0){
      const decision=resolveStateApplication({...this.stateApplicationRequest(event.casterId,event.targetId,'stun'),
        kind:'action',chanceThreshold:caster.pendulumStunChance},random);
      if(decision.allowed){
        const timing=selectStateDurationProfile(frameStateDurationProfile(30),decision);
        this.conditions.applyStateFrames(event.targetId,'stun',timing.lastActiveFrame,event.casterId);
        this.recordSummonContact?.(event.casterId,event.targetId);
        this.applyStateConsequences(event.targetId,['stun']);
      }
    }
    if(target.frostRetaliationChance>0&&passesChanceThreshold(target.frostRetaliationChance,random)){
      const effect=this.app.battleCatalog.statusAttackBuffs?.['attack-slow'];
      if(effect)this.applyActorBuff(event.casterId,'attack-slow',0,effect,event.targetId);
    }
    if(caster.healingEnergyChance>0&&passesChanceThreshold(caster.healingEnergyChance,random))
      this.restoreHealth(event.casterId,Math.trunc(this.readResourceCapacity(event.casterId,'maxHealth')/50));
  }
  /** 原版 CHAR_SuccessOnMiss：被落空者按 attr82 回复最大生命的千分比，不抽随机数。 */
  private instantRecoveryOnMiss(event:AttackContact):void {
    const rate=this.combatProcs(event.targetId).instantRecoveryPerThousand;
    if(rate<1)return;
    this.restoreHealth(event.targetId,Math.trunc(this.readResourceCapacity(event.targetId,'maxHealth')*rate/1000));
  }
  private resolveHitReactions(event:AttackContact,hit:PhysicalHit,damageKind:'physical'|'magic',actionId:string,
    hero:BattleCharacter,targetPosition?:Point):void {
    resolveHitReactionPipeline(event,hit,damageKind,actionId,{
      conditions:this.conditions,actorAttribute:(id,key)=>this.actorAttribute(id,key),react:event=>this.react(event),reactToBuff:event=>this.reactToBuff(event),
      lightningOfHellReaction:(caster,target)=>this.lightningOfHellReaction(caster,target),godOfJusticeReaction:(caster,target)=>this.godOfJusticeReaction(caster,target),
      summonOwnerReactions:(event,hit,kind)=>this.summonOwnerReactions(event,hit,kind),disturbanceReaction:(caster,target)=>this.disturbanceReaction(caster,target),
      activePartySlots:()=>this.activePartySlots(),partySide:id=>this.partySide(id),partyRevengeReactions:(caster,kind,outcome)=>this.partyRevengeReactions(caster,kind,outcome),
      equipmentRecovery:id=>this.equipmentRecovery(id),isTwoHanded:id=>{const member=this.memberOf(id),main=member?.bag.equipmentItems(member.bag.equipmentFor(id))['main-hand'];return !!(main&&this.app.items.items[main]?.equipment?.twoHanded);},
      moltenReflection:(event,rate)=>this.moltenReflection(event,hero,rate),holySacrificeTransfer:(event,hit,kind)=>this.holySacrificeTransfer(event,hit,kind),
      physicalSuccessEquipmentProcs:(event,hit,random)=>this.physicalSuccessEquipmentProcs(event,hit,random),
      instantRecoveryOnMiss:event=>this.instantRecoveryOnMiss(event),
      attackProc:(event,hit,position)=>this.attackProc(event,hit,hero,position),
    },targetPosition);
  }

  private moltenReflection(event:AttackContact,hero:BattleCharacter,ratePerThousand:number):void {
    const defenderId=event.targetId,attackerId=event.casterId;
    const monster=this.arena.some(actor=>actor.key===defenderId);
    const damage=moltenReflectionDamage(monster?{kind:'monster',physicalAttack:this.actorAttribute(defenderId,'physicalAttack')}:
      {kind:'character',defense:this.actorAttribute(defenderId,'defense'),defenseRate:this.actorAttribute(defenderId,'defenseRate')},ratePerThousand);
    this.moltenDirectDamage({casterId:defenderId,targetId:attackerId},damage,hero);
    const splash=rollMoltenSplash(damage,this.actorAttribute(defenderId,'fireSplashChance'));
    if(splash!==undefined){
      const source=this.combatant(defenderId);
      if(source){
        const targets=this.combatants(),center=this.attackSplashCenter(source,targets,4);
        for(const target of moltenSplashTargets(source,center,targets,attackerId)){
          if(splash<=0||!this.combatant(target.id))continue;
          this.moltenDirectDamage({casterId:defenderId,targetId:target.id},splash,hero);
        }
      }
    }
    this.react({kind:'molten-reflection-completed',ownerId:defenderId,opponentId:attackerId});
  }
  private moltenDirectDamage(event:AttackContact,damage:number,hero:BattleCharacter):void {
    if(damage<=0||this.pendingDefeats.has(event.targetId)||!this.conditions.canLoseHealth(event.targetId))return;
    const enemy=combatActor(this.arena,event.targetId,actor=>actor.key);
    this.settleHit(event,{kind:'hit',damage},hero,enemy,{style:'weapon',sound:true});
    if(!this.enemiesRunning)return;
    if(enemy&&!this.pendingDefeats.has(enemy.key)&&this.arena.includes(enemy))enemy.controller?.onContact(event);
    if(event.targetId!==this.controlledId)combatActor(this.allies,event.targetId,actor=>actor.id)?.ai.onContact(event);
    if(event.targetId==='player'&&this.controlledId!=='player')this.heroAi?.onContact(event);
  }
  private attackSplashCenter(source:Combatant,targets:readonly Combatant[],rangeUnits:number):Point {
    const controller=this.partyControllers.get(source.id)??combatActor(this.arena,source.id,actor=>actor.key)?.controller?.combatController;
    const selection=selectAttackSplashCenter(source,targets,rangeUnits,{currentTargetId:controller?.selectedTargetId()});
    if(selection.targetId&&selection.targetId!==controller?.selectedTargetId())controller?.setReactionTarget(selection.targetId);
    return selection.center;
  }
  private attackProc(event:AttackContact,hit:PhysicalHit,hero:BattleCharacter,_targetPosition?:Point):void {
    if(hit.kind==='miss')return;
    this.partyAttackProc(event,hit);
    if(hit.damage<=0)return;
    const attributes=this.actorAttributes(event.casterId);if(!attributes)return;
    const baseDamage=normalDamageForClass(attributes,this.memberOf(event.casterId)?.classId??null);
    (this.attackProcs??=new AttackProcExecutor()).execute(baseDamage,{
      readChance:key=>this.actorAttribute(event.casterId,key),
      applyDamage:amount=>this.attackProcDamage(event,amount,hero),
      applyBuff:key=>{
        const effect=this.app.battleCatalog.statusAttackBuffs?.[key];
        if(effect)this.applyActorBuff(event.targetId,key,0,effect,event.casterId);
      },
      fireSplash:amount=>{
        const source=this.combatant(event.casterId);if(!source)return 0;
        const candidates=this.combatants(),center=this.attackSplashCenter(source,candidates,3);
        const targets=attackSplashTargets(source,center,candidates,3);
        for(const target of targets)this.attackProcDamage({casterId:event.casterId,targetId:target.id},amount,hero);
        return targets.length;
      },
    });
  }
  private attackProcDamage(event:AttackContact,amount:number,hero:BattleCharacter):void {
    if(amount<=0||!this.combatant(event.targetId)||!this.conditions.canLoseHealth(event.targetId))return;
    const enemy=combatActor(this.arena,event.targetId,actor=>actor.key);
    this.settleHit(event,{kind:'hit',damage:amount},hero,enemy);
  }
  private stateApplicationRequest(casterId:string,targetId:string,state:BattleStateKey):
    Omit<Extract<StateApplicationRequest,{kind:'buff'}>,'kind'> {
    const member=this.memberOf(targetId),enemy=combatActor(this.arena,targetId,actor=>actor.key);
    const sourceEnemy=combatActor(this.arena,casterId,actor=>actor.key);
    const sourceMember=this.memberOf(casterId);
    const sourceParty=!!(sourceMember||this.memberOf(sourceEnemy?.summonedBy??''));
    const targetParty=!!(member||this.memberOf(enemy?.summonedBy??''));
    const equipped=member?Object.values(member.bag.equipmentFor(targetId)).flatMap(id=>{
      const item=member.bag.get(id!);return item?[item]:[];}):[];
    const immunity=equipmentStateImmunity(equipped,state);
    const immunityAttribute=state==='sleep'?'sleepImmunity':state==='stun'?'stunImmunity':undefined;
    const passives=member?this.partyPassives(targetId):[];
    return {state,sourceRelation:!sourceMember&&!sourceEnemy?'none':sourceParty===targetParty?'friendly':'hostile',
      rules:enemy?.definition.stateRules,
      specificImmunityValue:immunityAttribute?this.conditions.attribute(targetId,immunityAttribute,immunity,passives):0,
      resistanceThreshold:this.conditions.attribute(targetId,'stateResistance',
        member?this.app.session.party?.groupModifiers()['status-resistance']??0:0,passives)};
  }
  /** 反应施加的状态：走与动作状态相同的免疫、抵抗与目标缩时判定。 */
  private applyReactionState(command:{attributeOwner:string;targetId:string;state:BattleStateKey;durationAttribute:BattleStatKey}):void {
    const duration=this.actorAttribute(command.attributeOwner,command.durationAttribute);
    if(duration<=0)return;
    const decision=resolveStateApplication({...this.stateApplicationRequest(command.attributeOwner,command.targetId,command.state),
      kind:'action',chanceThreshold:1000});
    if(!decision.allowed)return;
    const timing=selectStateDurationProfile(frameStateDurationProfile(duration),decision);
    this.conditions.applyStateFrames(command.targetId,command.state,timing.lastActiveFrame,command.attributeOwner);
    this.recordSummonContact?.(command.attributeOwner,command.targetId);
    this.applyStateConsequences(command.targetId,[command.state]);
  }
  private applyActorBuff(targetId:string,key:BattleBuffKey,priority:number,effect:BattleBuffEffect,sourceId:string):boolean {
    if(combatActor(this.arena,targetId,actor=>actor.key)?.definition.acceptsBuffs===false)return false;
    const rule=effect.durationRateFromOwner;
    // 有主人侧寿命换算的 Buff（亲和精灵）在施放时用施法者的属性定上限，之后不再重算。
    let applied=rule===undefined?effect:scaledBuffEffect(effect,this.actorAttribute(sourceId,rule.attribute));
    // 深呼吸：施法者的增量按原版 15/10 换算成帧，加在本 Buff 自己的上限上。
    const bonus=applied.durationFramesFromOwner;
    if(bonus){
      const frames=Math.trunc(this.actorAttribute(sourceId,bonus.attribute)*15/10);
      applied=withLifetimeFrames(applied,applied.simulationFrames!.lastActiveFrame+frames);
    }
    const initialized:BattleStateKey[]=[];
    const accepted=this.conditions.applyBuff(targetId,key,priority,applied,sourceId,state=>{
      const decision=resolveStateApplication({...this.stateApplicationRequest(sourceId,targetId,state),kind:'buff'});
      if(!decision.allowed)return false;
      const profile=applied.stateDurationProfiles?.[state];
      if(!profile)throw new Error(`Missing state lifetime for ${key}/${state}`);
      initialized.push(state);
      return selectStateDurationProfile(profile,decision);
    });
    if(!accepted)return false;
    this.applyAcceptedEffects(sourceId,targetId,applied);
    if(applied.applicationEffect)this.showBuffApplication(sourceId,targetId,applied.applicationEffect);
    if(this.memberOf(targetId))this.syncCombatResourceLimits(targetId);
    this.applyStateConsequences(targetId,initialized.filter(state=>this.conditions.hasState(targetId,state)));
    return true;
  }
  /** 被接受之后才执行的动作：目前只有魔甲那一条，给施法者自己建破灭之魔甲。 */
  private applyAcceptedEffects(sourceId:string,targetId:string,effect:BattleBuffEffect):void {
    for(const accepted of effect.onAccepted??[]){
      const child=this.learnedReactionBuff(sourceId,accepted.skill);
      if(!child)continue;
      // 施法者自己带着父增益时，子增益复制父的总寿命上限（年龄归零），不是剩余时间也不加长。
      // 只有这两对父子有「复制父上限」的规则；狙击没有，直接用子自己的公式上限。
      const parent:Partial<Record<typeof accepted.skill,BattleBuffKey>>={
        'bard-of-destruction':'summon-bard','deep-breath':'energy-bodhi'};
      const parentKey=parent[accepted.skill];
      const parentCap=parentKey===undefined?undefined:this.conditions.buffLifetimeFrames(sourceId,parentKey);
      const inherited=parentCap===undefined?child.effect:withLifetimeFrames(child.effect,parentCap);
      const recipient=accepted.target==='source'?sourceId:targetId;
      this.applyActorBuff(recipient,child.key,child.rankPriority,inherited,sourceId);
    }
  }
  private partyAttackProc(event:AttackContact,hit:PhysicalHit):void {
    const member=this.memberOf(event.casterId);if(!member||!this.combatant(event.targetId))return;
    const effects=this.app.session.party?.groupModifiers()??{};
    const main=member.bag.equipmentItems(member.bag.equipmentFor(event.casterId))['main-hand'];
    const weapon=main?this.app.items.items[main].kind:'';
    for(const [buff,chance]of [
      ['critical-hit-stun',hit.kind==='critical'?effects['critical-stun-chance']??0:0],
      ['blunt-hit-stun',weapon==='mace'?effects['blunt-stun-chance']??0:0]
    ] as const)if(partyProcSucceeds(chance)){
      const effect=this.app.battleCatalog.statusAttackBuffs?.[buff];
      if(effect)this.applyActorBuff(event.targetId,buff,0,effect,event.casterId);
    }
  }
  /**
   * 圣徒之牺牲：受击者身上的转移增益按千分率切走一部分主伤害，交给 Buff 的来源保护者。
   * 保护者按自己的物防或魔抗再结算一次，直接扣血且不再进成功链，所以不会连锁转移、反伤或吸血。
   */
  private holySacrificeTransfer(event:AttackContact,hit:PhysicalHit,damageKind:'physical'|'magic'):void {
    const rate=this.actorAttribute(event.targetId,'damageTransferPerThousand');
    if(rate<=0)return;
    const protector=this.conditions.snapshot(event.targetId)
      .find(condition=>condition.kind==='buff'&&condition.id==='holy-sacrifice')?.sourceId;
    if(!protector||this.fallen?.has(protector)||this.pendingDefeats?.has(protector))return;
    const damage=hit.damage,transferred=Math.trunc(damage*rate/1000);
    // 物理多一条「乘积至少 1000」门槛；两类都要求转移量严格小于主伤害，余量为 0 就整次不转移。
    if(damageKind==='physical'&&damage*rate<1000)return;
    if(transferred>=damage)return;
    const target=this.fighterOf(protector);if(!target)return;
    const resistance=damageKind==='physical'?target.physicalResistance:(target.magicResistance??0);
    const damageToProtector=Math.trunc(transferred*(1000-resistance)/1000);
    hit.damage=damage-transferred;
    this.holySacrificeDamage(event.casterId,protector,damageToProtector);
  }
  /** 转移伤害的来源仍是原攻击者；保护者免伤时这次扣血被吞掉，受击者的余量照常结算。 */
  private holySacrificeDamage(attackerId:string,protectorId:string,damage:number):void {
    if(damage<=0||this.pendingDefeats.has(protectorId)||!this.conditions.canLoseHealth(protectorId))return;
    const enemy=combatActor(this.arena,protectorId,actor=>actor.key);
    this.settleHit({casterId:attackerId,targetId:protectorId},{kind:'hit',damage},this.hero,enemy,{style:'weapon',sound:true});
  }
  private fighterOf(id:string):PhysicalFighter|undefined {
    if(this.memberOf(id))return this.partyFighter(id);
    const enemy=combatActor(this.arena,id,actor=>actor.key);
    return enemy?this.enemyFighter(enemy.key,enemy.definition,this.hero.level):undefined;
  }
  private partyFighter(id:string):PhysicalFighter|undefined {
    const member=this.memberOf(id);if(!member||member.player.health<=0&&!this.hitResolution?.isAwaitingDefeat(id))return;
    const panel=member.panel,level=member.level,passives=this.partyPassives(id);
    return this.conditions.fighter(id,{level,physicalAttack:panel.physicalAttack,defense:panel.baseDefense,defenseRate:panel.defenseRate,magicAttack:panel.magicAttack,maxHealth:panel.maxHealth,hitBase:panel.hitBase,hitBonus:panel.hitBonus,
      evasionBase:panel.evasionBase,evasionBonus:panel.evasionBonus,criticalRate:panel.criticalRate,criticalResistance:panel.criticalResistance,
      criticalDamage:panel.criticalDamage,criticalDamageResistance:panel.criticalDamageResistance,
      weaponBlock:panel.weaponBlock,shieldBlock:panel.shieldBlock,physicalResistance:panel.physicalResistance,magicResistance:panel.baseMagicResistance,
      zealotRate:this.combatProcs(id).zealotRate},passives,
      {offhandShield:panel.offhandShield});
  }
  private actorAttributes(id:string):CombatActorAttributes|undefined {
    const member=this.memberOf(id),enemy=combatActor(this.arena,id,actor=>actor.key);
    const base=member?.panel??(enemy&&this.roster.enemySnapshot(id,enemy.definition,this.hero.level));
    if(!base)return;
    const passives=member?this.partyPassives(id):[];
    const attribute=(key:'physicalAttack'|'magicAttack'|'maxHealth'|'physicalDamageRate'|'magicDamageRate',original:number)=>
      Math.max(0,this.conditions.attribute(id,key,original,passives));
    return {
      physicalAttack:attribute('physicalAttack',base.physicalAttack),
      magicAttack:attribute('magicAttack',base.magicAttack),
      maxHealth:attribute('maxHealth',base.maxHealth),
      physicalDamageRate:attribute('physicalDamageRate',0),
      magicDamageRate:attribute('magicDamageRate',0),
      stealthDamageRate:this.conditions.attribute(id,'stealthAttackEnabled',0,passives)>0
        ?this.conditions.attribute(id,'stealthDamageRate',0,passives):0,
      primaryAttributes:member?.panel.attributes??{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},
    };
  }
  private partyPassives(id:string):PassiveModifier[] {
    const member=this.memberOf(id);if(!member)return [];
    const equipped=member.bag.equipmentItems(member.bag.equipmentFor(id));
    const main=equipped['main-hand'];
    const weapon=main?this.app.items.items[main]?.kind??'unarmed':'unarmed';
    const configuration=this.skillConfiguration(id,member);
    const armor=equipped.body?this.app.items.items[equipped.body].kind:'';
    return memberCombatModifiers({
      catalog:this.app.battleCatalog,classId:member.classId,loadout:configuration.draft(this.app.battleCatalog,member.classId),
      weaponKind:weapon,armorKind:armor,health:member.player.health,maxHealth:member.player.maxHealth,
      groupEffects:this.app.session.party?.groupModifiers()??{},stealthed:this.conditions.hasState(id,'stealthed'),growth:memberSkillGrowth(id)
    });
  }
  private enemyFighter(key:string,definition:EnemyDefinition,playerLevel:number):PhysicalFighter|undefined {
    if(this.pendingDefeats.has(key))return;
    const stats=this.roster.enemySnapshot(key,definition,playerLevel);
    if(!stats||stats.health<=0)return;
    return this.conditions.fighter(key,{level:stats.level,physicalAttack:stats.physicalAttack,defense:stats.defense,defenseRate:stats.defenseRate,physicalResistanceBonus:stats.physicalResistanceBonus,magicAttack:stats.magicAttack,maxHealth:stats.maxHealth,hitBase:stats.hitBase,hitBonus:stats.hitBonus,
      evasionBase:stats.evasionBase,evasionBonus:stats.evasionBonus,criticalRate:stats.criticalRate,criticalResistance:stats.criticalResistance,
      criticalDamage:stats.criticalDamage,criticalDamageResistance:stats.criticalDamageResistance,weaponBlock:stats.weaponBlock,
      shieldBlock:stats.shieldBlock,physicalResistance:stats.physicalResistance,magicResistance:stats.magicResistance});
  }
  skillManaCost(id:string,skillId:string,level:number|undefined):number|undefined {
    const base=skillManaCost(skillForMember(this.app.battleCatalog,id,skillId),level);
    return base===undefined?undefined:calculateManaCost(base,this.actorAttribute(id,'manaCostRate'),this.actorAttribute(id,'manaCostReductionRate'));
  }
  private restoreMana(id:string,amount:number):void {
    const member=this.memberOf(id);
    if(member){
      if(!this.fallen?.has(id)&&(member.player.health>0||this.hitResolution?.isAwaitingDefeat(id))){
        const value=member.player.mana+amount;
        member.setMana(value<0?0:Math.min(this.readResourceCapacity(id,'maxMana'),value));
      }
      return;
    }
    const enemy=combatActor(this.arena,id,actor=>actor.key);
    if(!enemy||this.pendingDefeats.has(id))return;
    const state=this.roster.enemySnapshot(id,enemy.definition,this.hero.level);
    if(state&&(state.health>0||this.hitResolution?.isAwaitingDefeat(id)))this.roster.setEnemyMana(id,state.mana+amount,enemy.definition);
  }
  private recoverResources():void {
    // 恢复脉冲约 1.86 秒一次；不在脉冲帧上就不必构建整队的恢复属性。
    if(!this.app.session.recoveryPulseDue){this.app.session.advanceRecoveryClock();return;}
    const actors=[...this.activeParty,...this.arena.map(enemy=>enemy.key)].flatMap(id=>{
      const member=this.memberOf(id),enemy=combatActor(this.arena,id,actor=>actor.key);
      const state=member?.player??(enemy&&this.roster.enemySnapshot(id,enemy.definition,this.hero.level));
      if(!state)return [];
      // 再生药水这类持续回复按「每脉冲额外恢复」生效，加在各人自己的恢复属性上。
      const regeneration=this.app.session.recovery.activeRegeneration;
      const bonus=(key:'healthRecoveryPerPulse'|'manaRecoveryPerPulse'):number=>member&&regeneration?regeneration[key]:0;
      return [{actorId:id,alive:state.health>0&&!this.pendingDefeats.has(id),level:state.level,
        healthRecoveryPerPulse:this.actorAttribute(id,'healthRecoveryPerPulse')+bonus('healthRecoveryPerPulse'),
        manaRecoveryPerPulse:this.actorAttribute(id,'manaRecoveryPerPulse')+bonus('manaRecoveryPerPulse'),
        emergencyRecovery:this.conditions.hasBuff(id,'monster-emergency-recovery')}];
    });
    for(const pulse of this.app.session.recoverCombatResources(actors)){
      for(const amount of pulse.amounts){
        this.restoreHealth(amount.actorId,amount.healthAmount);this.restoreMana(amount.actorId,amount.manaAmount);
      }
      this.threat?.decay();
    }
  }
  private actorAttribute(id:string,key:BattleStatKey):number {
    if(key==='maxHealth'||key==='maxMana')return this.readResourceCapacity(id,key);
    const cached=this.conditions.cachedAttribute(id,key);if(cached!==undefined)return cached;
    if(key==='bestNormalDamage'){const attributes=this.actorAttributes(id);return attributes?bestNormalDamage(attributes):0;}
    const member=this.memberOf(id),enemy=combatActor(this.arena,id,actor=>actor.key);
    const enemyState=enemy&&this.roster.enemySnapshot(id,enemy.definition,this.hero.level);
    const defaults=defaultResourceAttributes(member?'member':'monster',member?.level??enemyState?.level??0);
    let original:number;
    const attackProcAttribute=['windStrikeChance','fireSplashChance','frostStrikeChance','divineStrikeChance','darknessStrikeChance','poisonStrikeChance'].includes(key);
    const equipmentCombatAttribute=['pendulumStunChance','frostRetaliationChance','healingEnergyChance','zealotRate','instantRecoveryPerThousand'].includes(key);
    if(attackProcAttribute){
      const equipped=member?Object.values(member.bag.equipmentFor(id)).flatMap(item=>{const entry=member.bag.get(item!);return entry?[entry]:[];}):[];
      original=equipmentAttackProcs(equipped)[key as keyof ReturnType<typeof equipmentAttackProcs>];
    }else if(equipmentCombatAttribute){
      original=this.combatProcs(id)[key as keyof ReturnType<typeof equipmentCombatProcs>];
    }else if(key==='threatReductionRate'){
      const equipped=member?Object.values(member.bag.equipmentFor(id)).flatMap(item=>{const entry=member.bag.get(item!);return entry?[entry]:[];}):[];
      original=equipmentThreatReduction(equipped);
    }else if(key==='offhandAttackChance'){
      const equipped=member?.bag.equipmentItems(member.bag.equipmentFor(id));
      const offhand=equipped?.['off-hand'],armor=equipped?.body;
      original=baseOffhandAttackChance(member?.classId??'',offhand?this.app.items.items[offhand].kind:'empty',armor?this.app.items.items[armor].kind:'');
    }else if(key==='threatGenerationRate'){original=1000;
    }else if(key in defaults){
      original=defaults[key as keyof typeof defaults]+(key==='manaRecoveryPerPulse'?this.equipmentRecovery(id).manaRecoveryPerPulse:key==='manaCostReductionRate'?this.equipmentRecovery(id).manaCostReductionRate:0);
    }else{
      const base=member?.panel??enemyState;
      original=key==='defense'&&member?member.panel.baseDefense:
        key==='magicResistance'&&member?member.panel.baseMagicResistance:
        base&&key in base?Number(base[key as keyof typeof base]):key==='healingPowerRate'||key==='moveSpeed'?1000:0;
    }
    const value=this.conditions.attribute(id,key,original,member?this.partyPassives(id):[]);
    if(key==='magicResistance')return this.conditions.cachedAttribute(id,key)??calculateMagicResistance(value);
    return attackProcAttribute||equipmentCombatAttribute||key in defaults||key==='physicalAttack'||key==='magicAttack'||key==='defense'||key==='defenseRate'||key==='healingPowerRate'||key==='threatGenerationRate'||key==='threatReductionRate'||key==='sightBonusUnits'||key==='bloodThirstChance'||key==='bloodThirstLifeDrainPerThousand'||key==='bloodThirstManaRecovery'||key==='revengeChance'||key==='cooldownResetChance'||key==='defenseCooldownResetChance'||key==='offhandAttackChance'||key==='frenzyAttackChance'?Math.max(0,value):value;
  }
  private periodicTick(tick:PeriodicTick):void {
    if(this.defeated||this.closed||this.pendingDefeats.has(tick.targetId))return;
    const attributes=this.actorAttributes(tick.sourceId),effect=tick.effect;
    if(!attributes&&!['normal-damage','visual','fixed-damage'].includes(effect.kind))return;
    const commands=resolvePeriodicEffect(effect,{buffId:tick.buffId,stackCount:tick.stackCount,
      targetHealingRate:this.actorAttribute(tick.targetId,'healingPowerRate'),
      source:attributes?{classId:this.memberOf(tick.sourceId)?.classId??null,attributes,
        lifeFeastRate:this.actorAttribute(tick.sourceId,'lifeFeastRate'),
        attributeValue:key=>this.actorAttribute(tick.sourceId,key)}:null});
    const heal=(recipientId:string,amount:number,visual?:string)=>{
      this.restoreHealth(recipientId,amount);
      if(visual)this.presenterFor(recipientId)?.showEffects(recipientId,[{effect:visual,recipient:'target',placement:'attached'}]);
    };
    for(const command of commands){
      if(command.kind==='visual'){
        this.presenter?.showEffects(tick.targetId,[{effect:command.effect,recipient:'target',placement:'attached'}]);
      }else if(command.amount>0){
        if(command.kind==='heal-target')heal(tick.targetId,command.amount,command.effect);
        else if(command.kind==='heal-source')heal(tick.sourceId,command.amount,command.effect);
        // 血之盛宴：固定三个活动队伍槽各恢复整份，来源仍是血咒施法者。
        else if(command.kind==='heal-party')for(const id of this.activePartySlots())heal(id,command.amount,command.effect);
        else {
          const enemy=combatActor(this.arena,tick.targetId,actor=>actor.key);
          this.settleHit({casterId:tick.sourceId,targetId:tick.targetId},{kind:'hit',damage:command.amount},this.hero,enemy,{periodic:true});
        }
      }
    }
  }
  private movementSpeed(actorId:string,baseSpeed:number):number {
    const mult = (actorId === this.controlledId || this.activeParty.includes(actorId)) ? (this.app.gmSpeedMultiplier ?? 1) : 1;
    const visual=this.visualOf(actorId),enemy=combatActor(this.arena,actorId,actor=>actor.key);
    // 原版在水格上把最终移速减半；带涉水豁免位的飞行、浮空单位不受影响。
    const water=!!visual&&!enemy?.definition.waterImmune&&this.movement.navigation.isWater(this.movement.position(visual));
    return Math.max(0,Math.trunc(baseSpeed*mult*this.conditions.attribute(actorId,'moveSpeed',1000)/1000*(water?0.5:1)));
  }
  private resourceCapacityInputs(id:string):{base:{maxHealth:number;maxMana:number};passives:PassiveModifier[]}|undefined {
    const member=this.memberOf(id),enemy=combatActor(this.arena,id,actor=>actor.key);
    const base=member?.panel??(enemy&&this.roster.enemySnapshot(id,enemy.definition,this.hero.level));
    if(!base)return;
    const passives=member?this.partyPassives(id):[];
    for(const key of ['maxHealth','maxMana'] as const){
      let sig=String(base[key]);
      for(const modifier of passives)if(modifier.attribute===key){
        const op=modifier.operation;
        sig+=`|${op.kind}:${'amount' in op?op.amount:'ratePerThousand' in op?op.ratePerThousand:'factor' in op?op.factor:'divisor' in op?op.divisor:''}`;
      }
      this.conditions.setResourceCapacityInputs(id,key,sig);
    }
    return {base,passives};
  }
  private readResourceCapacity(id:string,key:ResourceCapacityKey):number {
    const inputs=this.resourceCapacityInputs(id);if(!inputs)return 0;
    return this.conditions.readResourceCapacity(id,key,()=>{
      const capacity=Math.max(0,this.conditions.attribute(id,key,inputs.base[key],inputs.passives));
      this.memberOf(id)?.setCombatResourceCapacity(key,capacity);
      return capacity;
    });
  }
  private syncCombatResourceLimits(id:string):void {
    const member=this.memberOf(id);if(!member)return;
    const inputs=this.resourceCapacityInputs(id);if(!inputs)return;
    member.setCombatResourceLimits(
      this.conditions.attribute(id,'maxHealth',inputs.base.maxHealth,inputs.passives),
      this.conditions.attribute(id,'maxMana',inputs.base.maxMana,inputs.passives));
  }
  private applyStateConsequences(id:string,states:readonly BattleStateKey[]):void {
    if(!states.some(state=>state==='immobilized'||state==='stealthed')){this.interruptDisabled(id);return;}
    this.conditions.clearTemporary(id);
    this.partyControllers.get(id)?.cancel(true);
    const visual=this.visualOf(id);if(visual)this.movement.stop(visual);
    if(id==='player')this.heroAi?.disable();else combatActor(this.allies,id,actor=>actor.id)?.ai.disable();
    combatActor(this.arena,id,actor=>actor.key)?.controller?.disable();
    if(states.includes('stealthed')){
      if(visual)setCharacterStealth(visual,true);
      const target=this.combatant(id);
      for(const actor of this.combatants())if(target&&actor.team!==target.team){
        this.partyControllers.get(actor.id)?.targetRemoved(id);
        if(actor.id==='player')this.heroAi?.targetRemoved(id);
        else combatActor(this.allies,actor.id,actor=>actor.id)?.ai.targetRemoved(id);
        combatActor(this.arena,actor.id,actor=>actor.key)?.controller?.targetRemoved(id);
      }
      if(this.focusTargetId===id){this.focusTargetId=undefined;this.scene.refreshCombatTarget();}
    }
  }
  private interruptDisabled(actorId:string):void {
    if(!this.conditions.cannotAct(actorId))return;
    this.conditions.clearTemporary(actorId);
    if(this.memberOf(actorId)){
      this.partyControllers.get(actorId)?.cancel(true);const visual=this.visualOf(actorId);if(visual)this.movement.stop(visual);
      if(actorId==='player')this.heroAi?.disable();else combatActor(this.allies,actorId,actor=>actor.id)?.ai.disable();
    }else combatActor(this.arena,actorId,actor=>actor.key)?.controller?.disable();
  }
  private showHit(event:AttackContact,hit:PhysicalHit,options:{style?:HitEffectStyle;periodic?:boolean;sound?:boolean}):void {
    const caster=combatActor(this.arena,event.casterId,actor=>actor.key),target=combatActor(this.arena,event.targetId,actor=>actor.key);
    const belongsToControlled=(id:string)=>id===this.controlledId||this.arena.some(enemy=>enemy.key===id&&enemy.summonedBy===this.controlledId);
    const feedback={hit,style:options.style??'weapon' as const,periodic:!!options.periodic,
      casterControlled:event.casterId===this.controlledId,targetParty:!!this.memberOf(event.targetId),
      targetFriendly:!!this.memberOf(event.targetId)||!!this.memberOf(target?.summonedBy??''),
      involvesControlled:belongsToControlled(event.casterId)||belongsToControlled(event.targetId)};
    const selection=selectFeedbackAssets(feedback,this.app.battleCatalog.feedback,Math.random,displaySettings.criticalDecorations);
    const visual=this.visualOf(event.targetId);if(!visual?.container.active)return;
    this.feedback.show(feedback,visual,selection);
    if(feedbackPlan(feedback).flash)this.statusColors.flash(visual,this.scene);
    if(options.sound){
      // 普攻命中音效对所有玩家阵营成员生效；武器类型按出手者自己的装备取。
      if(this.memberOf(event.casterId)){
        const equipment=this.hero.bag.equipmentItems(this.hero.bag.equipmentFor(event.casterId)),item=equipment['main-hand'];
        this.app.audio?.playerHit(item?this.app.items.items[item].kind:'unarmed',hit.kind,target?.definition.id);
      }
      if(hit.kind==='shield-block'&&this.memberOf(event.targetId))this.app.audio?.shieldBlock();
    }
    if(hit.damage>0){
      if(caster)this.app.audio?.monsterAttack(caster.definition.id);
      if(options.periodic&&target)this.app.audio?.periodicDamage();
    }
    this.scene.events.emit('combat-hit-feedback',{...event,...feedback});
  }

  private stopEnemies(): void {
    this.enemiesRunning = false;
    for (const enemy of this.arena) {
      if(this.pendingDefeats.has(enemy.key))continue;
      this.conditions.clearTemporary(enemy.key);
      enemy.controller?.cancel(); enemy.presenter.clear(); this.movement.stop(enemy.visual);
    }
  }
  private updateEnemies(enabled: boolean): void {
    if (!enabled) { if (this.enemiesRunning) this.stopEnemies(); return; }
    this.enemiesRunning = true;
    for (const enemy of this.arena) {
      if(this.pendingDefeats.has(enemy.key))continue;
      if(!(enemy.controller instanceof FriendlySummonController))enemy.controller?.step();
    }
    this.observeSummonCombat();
    for(const enemy of this.arena)if(!this.pendingDefeats.has(enemy.key)&&enemy.controller instanceof FriendlySummonController)enemy.controller.step();
  }


  /** 游戏行为驱动的移除：场景实例和名册条目一起删。 */
  removeEnemy(key: string): void {
    if(this.pendingDefeats.has(key)){this.pendingDefeats.complete(key,false);return;}
    for(const child of this.arena.filter(enemy=>enemy.summonedBy===key))this.removeEnemy(child.key);
    if(!this.removeEnemyVisual(key))return;
    this.roster.removeEnemy(key);
  }
  /**
   * 只销毁场上的场景实例，不动名册。
   *
   * `WorldEnemyRoster.refresh()` 返回的 diff 表示名册已经改完；消费端只能把场景
   * 投影同步过去。若这里再调 `roster.removeEnemy`，会把 refresh 刚换好的新条目删掉，
   * 下一帧名册和实例的 `key + enemyId` 就永久对不上。
   */
  private removeEnemyVisual(key:string):boolean{
    if(this.pendingDefeats.has(key)){this.pendingDefeats.complete(key,false);return false;}
    const index = this.arena.findIndex(enemy => enemy.key === key);
    if (index < 0) return false;
    const [enemy] = this.arena.splice(index, 1);refreshCombatActors(this.arena);
    this.destroyEnemy(enemy);
    this.conditions.remove(key);
    for(const group of this.summonGroups.values())group.delete(key);
    this.summonGroups.delete(key);
    for(const controller of this.partyControllers.values())controller.targetRemoved(key);
    if(this.focusTargetId===key)this.focusTargetId=undefined;
    this.scene.refreshCombatTarget();
    return true;
  }
  private consumeRosterChanges(changes:{added:PlacedEnemy[];removed:string[]}):void{
    for(const key of changes.removed)this.removeEnemyVisual(key);
    for(const placed of changes.added)this.spawnEnemy(placed);
  }

  /** 施法者自己的活动召唤（有受命动作的才算）。 */
  private activeSummonsOf(ownerId:string):MapEnemy[] {
    return this.arena.filter(enemy=>!this.pendingDefeats.has(enemy.key)&&enemy.summonedBy===ownerId&&!!enemy.definition.commandAction);
  }
  /** 快捷栏状态：起手资格对玩家入口与实际起手是同一判定，原版把失败结果显示成不可用。 */
  skillSlotAvailable(skillId:string):boolean {
    const skill=skillForMember(this.app.battleCatalog,this.controlledId,skillId);
    return !!skill?.action&&this.conditions.canUseSkillShortcuts(this.controlledId)
      &&this.canSelectSkill(this.controlledId,{id:skillId,action:skill.action});
  }
  private canSelectSkill(id:string,skill:NonNullable<ActionPlayback['skill']>):boolean {
    const gate=skillForMember(this.app.battleCatalog,id,skill.id)?.action?.minHealthRatePerThousand??skill.action.minHealthRatePerThousand;
    if(gate!==undefined){
      // 严格大于：等于门槛不可起手。也要求自己的生命上限缓存有效。
      const member=this.memberOf(id);
      const maxHealth=member?this.readResourceCapacity(id,'maxHealth'):0;
      const health=member?.player.health??0;
      if(!(maxHealth>0)||health<=Math.trunc(maxHealth*gate/1000))return false;
    }
    // 原版条件 37：没有自己的活动召唤就不能起手，判定放在扣蓝与冷却之前。
    if((skillForMember(this.app.battleCatalog,id,skill.id)?.action?.requiresActiveSummon??skill.action.requiresActiveSummon)
      &&!this.activeSummonsOf(id).length)return false;
    const requirement=skillForMember(this.app.battleCatalog,id,skill.id)?.action?.requiredOffhand??skill.action.requiredOffhand;
    if(requirement!=='shield')return true;
    const member=this.memberOf(id);if(!member)return false;
    const equipment=this.hero.bag.equipmentItems(this.hero.bag.equipmentFor(id));
    const defaultShield=member===this.hero?this.app.wardrobe.defaultShield:(member as CompanionMember).definition.defaultShield;
    return hasOffhandShield(this.app.items,equipment,defaultShield);
  }
  private partySkillsFor(id:string):EnemyPlayableSkill[]{
    const member=this.memberOf(id)!;
    const character=this.app.battleCatalog.classes.find(value=>value.id===member.classId)!;
    const configuration=this.skillConfiguration(id,member);
    const draft=configuration.draft(this.app.battleCatalog,member.classId);
    const actions=costumeRecipe(this.app.wardrobe,this.app.items,this.hero.bag.equipmentItems(this.hero.bag.equipmentFor(id)),member.classId).actions;
    return character.skills.flatMap(skillId=>{
      const skill=skillForMember(this.app.battleCatalog,id,skillId)!,level=draft.levels[skillId];
      const action=skillId in actions?actions[skillId]:skill.action;
      if(!action||!level)return [];
      return [{id:skillId,name:skill.name,action:skill.action?{...action,hitEffectStyle:skill.action.hitEffectStyle,usesSkillDamageBuff:skill.action.usesSkillDamageBuff,combatUnits:skill.action.combatUnits,repeat:skill.action.repeat?{...skill.action.repeat,restartAfterFrame:action.repeat?.restartAfterFrame??skill.action.repeat.restartAfterFrame}:undefined}:action,level,manaCost:this.skillManaCost(id,skillId,level),frequency:0,
        clips:skillClips(skillId)} as EnemyPlayableSkill];
    });
  }
  private createPartyController(id:string,visual:CharacterVisual,presenter:CombatPresenter,attack:ReturnType<WorldCombat['equipmentAttack']>):{controller:CombatController;port:PartyPort}{
    const facing=()=>id==='player'?this.scene.facing:combatActor(this.allies,id,actor=>actor.id)?.facing??'south';
    const setFacing=(value:Facing)=>{if(id==='player')this.scene.facing=value;else{const ally=combatActor(this.allies,id,actor=>actor.id);if(ally)ally.facing=value;}};
    const port:PartyPort={
      isPaused:()=>this.runtime.paused,cooldowns:this.app.session.cooldowns.forActor(id),
      selectBasicAttack:normal=>this.selectBasicAttack(id,visual.actor,normal),
      actor:key=>this.combatant(key),candidates:()=>this.combatants(),partySlots:()=>this.partyBuffSlots(),
      isAlive:key=>this.isActorAlive(key),
      rangeBonusUnits:key=>this.actorAttribute(key,'attackRangeBonusUnits'),
      healScore:key=>this.healScoreFor(key),
      healCandidates:()=>this.healCandidates(),
      facing,
      leader:()=>this.combatant(this.controlledId),followGoal:()=>this.partyFollowGoal(id),focusTarget:()=>this.focusTargetId,
      partyTarget:()=>this.currentTargetOf(this.controlledId),
      // 玩家指派了目标，或队伍最近与敌人真实交战过，都算整个队伍已进入战斗。
      inCombat:()=>!!this.focusTargetId||this.awareness.inCombat((this.app.session.combatTick??0)*LOGIC_FRAME_MS),
      skills:()=>this.partySkills.get(id)??[],
      skillKind:skill=>this.app.session.party?.catalog.autoSkills?.[skill]?.kind,
      vitals:key=>this.memberOf(key)?.player,
      attacking:key=>this.partyControllers.get(key)?.actionState()==='attacking',
      attackRange:()=>this.equipmentAttack(visual.actor,id).approachDistanceUnits+this.actorAttribute(id,'attackRangeBonusUnits'),
      counterattack:()=>this.app.session.party?.counterattack(id)??2,
      damageCount:()=>this.damageCount,
      navigationBounds:()=>this.movement.navigation.bounds,pathBudget:this.pathBudget,
      moveToward:position=>{if(!this.conditions.canAutoApproach(id)){this.movement.stop(visual);return;}setFacing(faceTarget(this.movement.position(visual),position));this.movement.toward(visual,position,this.movementSpeed(id,PLAYER_MOVE_SPEED));},
      followPath:nextWaypoint=>this.movement.followPath(visual,()=>{
        if(!this.conditions.canMove(id))return undefined;
        const next=nextWaypoint();if(next)setFacing(faceTarget(this.movement.position(visual),next));return next;
      },this.movementSpeed(id,PLAYER_MOVE_SPEED)),
      stop:()=>this.movement.stop(visual),canStand:(position,clearanceActorId)=>{
        const clearanceVisual=clearanceActorId?this.visualOf(clearanceActorId):visual;
        return !!clearanceVisual&&this.movement.canStand(clearanceVisual,position);
      },
      regroup:()=>this.catchUpFollower(id),
      canPlaceBody:(position,clearanceActorId)=>this.canPlaceBodyAt(visual,position,clearanceActorId),
      canReach:position=>this.movement.navigation.path(this.movement.actor(visual),position,512)!==null,
      relocate:(position,clearance)=>this.relocateVisual(visual,position,clearance),face:setFacing,
      play:(action,frame,complete)=>{setFacing(action.facing);action.getAttackSpeedRate=()=>this.conditions.attribute(id,'attackSpeedRate',1000,this.partyPassives(id));return this.playAction(presenter,action,frame,complete);},
      frame:(action,index,contact,unitsReady,areaContact)=>{if(this.memberOf(action.caster.id)&&action.skill&&!this.soundedSkills.has(action)&&
        !action.skill.action.events.some(event=>event.kind==='feedback'&&event.sound||(event.kind==='units'||event.kind==='summon')&&event.dispatch)&&
        skillPlaybackEvents(action.skill.action,index,action.skill.level).some(event=>event.kind==='units')){
        this.soundedSkills.add(action);this.app.audio?.playerSkill(action.skill.id);
      }this.presentActionFrame(presenter,action,index,contact,unitsReady,event=>this.skillFeedback(action,event),(definition,work,afterDispatch)=>this.runActionDispatch(action,definition,work,afterDispatch),areaContact);},
      canSelectSkill:skill=>this.canSelectSkill(id,skill),
      manaCost:skill=>this.skillManaCost(id,skill.id,skill.level),
      canSpendMana:cost=>this.conditions.isInvincible(id)||(this.memberOf(id)?.player.mana??0)>=cost,
      spendMana:cost=>{
        const member=this.memberOf(id);if(!member)return false;
        // GM 调试无敌期间技能免费：返回成功但不扣 MP。
        return this.conditions.isInvincible(id)?true:member.spendMana(cost);
      },
      contact:event=>this.attackContact(event),areaContact:event=>this.basicAreaContact(event),prepareUnit:event=>this.prepareSkillUnit(event),unit:event=>this.skillUnit(event),
        runUnitSequence:work=>(this.hitResolution??=new CombatHitResolution()).run(work),
        unitFeedback:(hit,outcome,cue)=>{
          presenter.showUnitFeedback(hit,outcome,cue);
          // 佣兵自己的技能单元命中也要出声；敌方单元保持原来的静音。
          if(outcome==='success'&&this.memberOf(hit.casterId)&&cue.sound)this.app.audio?.effect(cue.sound);
        },clearEffects:()=>{this.runtime.cancel(id);presenter.clear();}
    };
    const controller=new CombatController(id,attack,port);
    controller.subscribe(snapshot=>{if(this.controlledId===id){this.scene.refreshCombatTarget();this.scene.refreshSkillCooldowns(snapshot.cooldowns);}});
    this.partyControllers.set(id,controller);this.runtime.registerActor(id,controller);
    return {controller,port};
  }
  private syncAiSkills(id:string):void{
    const party=this.app.session.party,frequencies=party?.aiFrequency(id);
    const latest=this.partySkillsFor(id);this.partySkills.set(id,latest);
    const mana=this.memberOf(id)?.player.mana??0;
    for(const skill of latest)skill.frequency=mana>=(skill.manaCost??0)?frequencies?.get(skill.id)??1:0;
  }
  private async syncAllies():Promise<void>{
    const party=this.app.session.party;if(!party||this.closed)return;
    // 新加入的队友需要重新应用当前暂停状态。
    this.pausedValue=undefined;
    this.partySignature=party.activeIds.join('|');
    const active=new Set(party.activeIds.slice(1));
    for(const ally of [...this.allies])if(!active.has(ally.id)){
      this.deathTweens.get(ally.id)?.stop();this.deathTweens.delete(ally.id);this.fallen.delete(ally.id);
      ally.ai.dispose();ally.presenter.clear();ally.overhead.destroy();this.movement.remove(ally.visual);ally.visual.container.destroy();ally.assets?.release();
      this.combatRuntime?.removeActor(ally.id);this.partyControllers.delete(ally.id);this.partySkills.delete(ally.id);this.conditions.remove(ally.id);this.threat?.removeActor(ally.id);
      for(const enemy of this.arena)enemy.controller?.targetRemoved(ally.id);
      this.allies.splice(this.allies.indexOf(ally),1);refreshCombatActors(this.allies);
    }
    if(!this.allies.length)this.resetFormationState(this.facingOfControlled());
    this.roster.setPartySize(party.activeSize,this.app.battleCatalog.enemies);
    for(const id of active){
      if(this.allies.some(ally=>ally.id===id)||this.pendingAllies.has(id))continue;
      const member=party.get(id);let actor=member&&this.app.world.actors[member.definition.actor];if(!member||!actor?.collision)continue;
      const character=this.app.battleCatalog.classes.find(value=>value.id===member.classId)!;
      this.prepareCombatSounds([character]);
      this.pendingAllies.add(id);
      this.allyLoadFailure=undefined;
      let lease:AssetLease|undefined;
      try{
      lease=await loadSceneAssets(this.scene,partyMemberCombatAssets(this.app.battleCatalog,this.app.wardrobe,member.classId,actor),()=>{});
      if(this.closed||party.get(id)!==member||!party.activeIds.includes(id)){lease.release();continue;}
      await this.scene.preparePartyMember(id);
      if(this.closed||party.get(id)!==member||!party.activeIds.includes(id)){lease.release();continue;}
      actor=this.scene.equipmentAppearance(id)??actor;
      // 上阵落点以主角为锚点，与当前操控者是谁无关；整盒判定避免身体压进地形。
      // 整张图都没有整盒空位时退到主角脚点：队友之间不占位，移动体会在下一步自愈，
      // 不因为一个队员的落点中断剧情或战斗。
      const landing=this.partyLanding({collision:actor.collision});
      if(!landing)globalThis.storyDiagnostics?.record('party-landing-fallback',{map:this.scene.map?.id,id});
      const position=landing??this.movement.position(this.player);
      const visual=createCharacter(this.scene,actor,{id,actor:actor.id,...position});
      const body=this.movement.register(visual,true,true,'party');
      // 演出期间新加入的佣兵也要立刻隐藏；否则已经处于 performanceHidden 时不会再走一次显隐同步。
      if(this.performanceHidden){visual.container.setVisible(false);this.movement.setEnabled(visual,false);}
      const presenter=new CombatPresenter(this.scene,this.app.battleCatalog,key=>this.visualOf(key),()=>this.combatants(),
        this.combatEffects);
      const overhead=new OverheadStatus(this.scene,visual,this.app.statusHud,()=>member.player,listener=>this.app.session.subscribe(listener));
      overhead.setVisible(!this.performanceHidden);
      const attack=this.equipmentAttack(actor,id);
      const ally={} as MapAlly;ally.id=id;ally.member=member;ally.visual=visual;ally.body=body;ally.facing='south';ally.presenter=presenter;ally.overhead=overhead;ally.assets=lease;
      this.allies.push(ally);refreshCombatActors(this.allies);
      const shared=this.createPartyController(id,visual,presenter,attack);ally.controller=shared.controller;
      const skills=this.partySkillsFor(id);this.partySkills.set(id,skills);
      ally.ai=new PartyController(id,shared.port,shared.controller);
      if(!member.alive)this.markAlreadyFallen(id);
      }catch(error){lease?.release();this.allyLoadFailure=error;this.partySignature='';this.nextPartySyncAt=this.scene.time.now+1000;if(!this.closed)throw error;}
      finally{this.pendingAllies.delete(id);if(!this.pendingAllies.size)for(const notify of [...this.allyWaiters])notify();}
    }
    this.syncControlled();
  }
  /** 以队长脚点为锚，再按上阵槽位和朝向偏出该队员自己的队形位置。 */
  private partyLanding(shape:NavigationShape,ignore?:NavigationActor,id?:string,
    leader:CharacterVisual|undefined=this.scene.player):Point|undefined {
    if(!this.movement||!leader)return undefined;
    const anchor=this.movement.position(leader);
    const slot=id?this.app.session.party?.slotOf(id):undefined;
    const offset=slot===undefined?undefined:formationSlotOffset(this.formationAngle,slot);
    const origin=offset?{x:anchor.x+offset.x,y:anchor.y+offset.y}:anchor;
    const avoid=[anchor,...this.allies.filter(ally=>this.movement!.actor(ally.visual)!==ignore)
      .map(ally=>this.movement!.position(ally.visual))];
    return choosePartyLanding(this.movement.navigation,shape,origin,ignore,avoid);
  }
  private facingOfControlled():Facing {
    return this.controlledId==='player'?this.scene.facing
      :(combatActor(this.allies,this.controlledId,actor=>actor.id)?.facing??'south');
  }
  private resetFormationState(facing:Facing,anchor?:Point):void {
    this.formationFacing=facing;
    this.formationAngle=facingBackAngle(facing);
    this.formationLeaderId=this.controlledId;
    this.formationLeaderPosition=anchor?{...anchor}:undefined;
    this.followLandingCache.clear();
  }
  /**
   * 每逻辑帧推进一次队形相位。朝向跟实际移动方向，不跟瞬时面朝方向；
   * 剧情传送/读档跳点直接对齐，不把整段位移当成走路方向。
   */
  private advanceFormation():void {
    if(!this.movement)return;
    const leader=this.controlledVisual;
    if(!leader)return;
    const anchor=this.movement.position(leader);
    const facing=this.facingOfControlled();
    if(this.formationLeaderId!==this.controlledId){
      this.resetFormationState(facing,anchor);
      return;
    }
    const previous=this.formationLeaderPosition;
    this.formationLeaderPosition={...anchor};
    if(previous){
      const dx=anchor.x-previous.x,dy=anchor.y-previous.y;
      if(Math.hypot(dx,dy)>64){this.resetFormationState(facing,anchor);return;}
      if(Math.hypot(dx,dy)>=1)
        this.formationFacing=Math.abs(dx)>=Math.abs(dy)?(dx>0?'east':'west'):(dy>0?'south':'north');
    }
    // 约 350ms 沿最短圆弧完成换边，不会经过队长脚下。
    this.formationAngle=smoothFormationAngle(this.formationAngle,facingBackAngle(this.formationFacing),0.15);
  }
  /** 跟随 AI 的目标点：共享队形相位算出的槽位，再加一点远离同伴的分离力。 */
  private partyFollowGoal(id:string):Point|undefined {
    if(!this.movement)return undefined;
    const slot=this.app.session.party?.slotOf(id);
    if(slot===undefined)return undefined;
    const leader=this.controlledVisual;
    if(!leader)return undefined;
    const anchor=this.movement.position(leader);
    const offset=formationSlotOffset(this.formationAngle,slot);
    const preferred={x:anchor.x+offset.x,y:anchor.y+offset.y};
    const alive=this.allies.filter(other=>other.id!==id&&other.member.player.health>0&&!this.fallen.has(other.id)&&other.visual.container.active);
    // 分离力：即使某个佣兵短暂落后，目标点也不会和另一名同伴重合。
    const separation=24;
    for(const other of alive){
      const otherPosition=this.movement.position(other.visual);
      const dx=preferred.x-otherPosition.x,dy=preferred.y-otherPosition.y;
      const distance=Math.hypot(dx,dy);
      if(distance<=0||distance>=separation)continue;
      const push=(separation-distance)/separation*6;
      preferred.x+=dx/distance*push;preferred.y+=dy/distance*push;
    }
    const visual=this.visualOf(id);
    if(!visual)return preferred;
    const actor=this.movement.actor(visual),shape=actor.shape();
    const avoid=[anchor,...alive.map(other=>this.movement!.position(other.visual))];
    const occupied=avoid.some(other=>partyBodyOverlaps(preferred,other,shape));
    if(!occupied&&this.movement.navigation.terrainFree(preferred)
      &&this.movement.navigation.canPlaceBody(shape,preferred,actor))return preferred;
    // 槽位被墙/同伴挡住时才做落点扫描；按锚点、角度和同伴位置缓存，避免每逻辑帧全图扫描。
    const key=`${slot}|${Math.round(anchor.x/8)}|${Math.round(anchor.y/8)}|${Math.round(this.formationAngle*20)}|`
      +avoid.map(point=>`${Math.round(point.x/8)},${Math.round(point.y/8)}`).join(';');
    const cached=this.followLandingCache.get(id);
    if(cached?.key===key)return cached.point;
    const landing=choosePartyLanding(this.movement.navigation,shape,preferred,actor,avoid);
    if(landing)this.followLandingCache.set(id,{key,point:landing});
    return landing??cached?.point;
  }
  /**
   * 剧情把主角送到新位置后，把其余上阵队员收拢到主角身边。
   * 只移动队员视觉体，不改变操控者；倒下或找不到合法落点的队员保持原位。
   */
  regroupPartyAroundHero():void {
    if(this.closed||!this.movement||!this.scene.player)return;
    for(const id of this.activeParty){
      if(id==='player')continue;
      const ally=combatActor(this.allies,id,actor=>actor.id);
      if(!ally||!ally.member.player.health||this.fallen.has(id)||!ally.visual.container.active)continue;
      ally.ai.cancel();
      const actor=this.movement.actor(ally.visual);
      const landing=this.partyLanding(actor.shape(),actor,id);
      if(!landing)continue;
      this.movement.place(ally.visual,landing);
      setCharacterClip(this.scene,ally.visual,`idle-${ally.facing}`,true);
    }
  }
  /** 是否该在剧情收尾时把单位拉回主角身边：太远、整盒不合法，或已经和队友叠在一起。 */
  private shouldSettleFriendly(visual:CharacterVisual,actor:NavigationActor,id?:string):boolean {
    const position=this.movement!.position(visual),hero=this.movement!.position(this.player);
    // 与普通跟随的收拢阈值一致，避免剧情收尾时在玩家眼前做小幅瞬移。
    if(Math.hypot(position.x-hero.x,position.y-hero.y)>200)return true;
    const navigation=this.movement!.navigation;
    if(!navigation.terrainFree(position)||!navigation.canPlaceBody(actor.shape(),position,actor))return true;
    if(!id)return false;
    // 读档可能带进旧重叠；已经和主角或另一名存活队员站在同一个盒子里时也重新落位。
    const shape=actor.shape();
    return [this.player,...this.allies.filter(other=>other.id!==id&&other.member.player.health>0&&!this.fallen.has(other.id))
      .map(other=>other.visual)]
      .some(other=>partyBodyOverlaps(position,this.movement!.position(other),shape));
  }
  /**
   * 剧情正常结束后，把掉队或被剧情障碍困住的佣兵、友方召唤物收拢到主角身边。
   * 只处理远离或位置非法的单位；已经站好的队形和正在攻击/施法的单位不动。
   */
  settleFriendlyUnitsAroundHero():void {
    if(this.closed||!this.movement||!this.scene.player)return;
    // 剧情末节点 waitEncounter 会先把遭遇置为 active；这表示战斗即将开始，
    // 不表示佣兵已经交战。因此这里只挡玩家已指派的战斗目标，真正的追击、
    // 施法单位由下面的逐单位状态检查跳过。
    if(this.focusTargetId)return;
    for(const id of this.activeParty){
      if(id==='player')continue;
      const ally=combatActor(this.allies,id,actor=>actor.id);
      if(!ally||!ally.member.player.health||this.fallen.has(id)||!ally.visual.container.active)continue;
      const actor=this.movement.actor(ally.visual);
      if(ally.ai.actionState()!=='idle'||ally.ai.selectedTargetId()||!this.shouldSettleFriendly(ally.visual,actor,id))continue;
      const landing=this.partyLanding(actor.shape(),actor,id);
      if(!landing)continue;
      ally.ai.cancel();this.movement.place(ally.visual,landing);
      setCharacterClip(this.scene,ally.visual,`idle-${ally.facing}`,true);
    }
    for(const enemy of this.arena){
      if(!enemy.summonedBy||!this.memberOf(enemy.summonedBy)||this.pendingDefeats.has(enemy.key)
        ||!this.isActorAlive(enemy.key)||!enemy.visual.container.active)continue;
      if(enemy.summonRemainingMs!==undefined&&enemy.summonRemainingMs<=0)continue;
      if(enemy.controller&&'actionState' in enemy.controller&&enemy.controller.actionState()!=='idle')continue;
      const actor=this.movement.actor(enemy.visual);
      if(!this.shouldSettleFriendly(enemy.visual,actor))continue;
      const landing=this.partyLanding(actor.shape(),actor);
      if(!landing)continue;
      enemy.controller?.cancel();this.movement.place(enemy.visual,landing);
      setCharacterClip(this.scene,enemy.visual,`idle-${enemy.facing}`,true);
    }
  }
  /**
   * 单个佣兵跟随队长长时间没有进展时，把他收拢到队长旁边的合法落点。
   * 与剧情转场后的整队收拢共用落点规则，但只动这一名队员。
   */
  private catchUpFollower(id:string):void {
    if(this.closed||!this.movement||id==='player'||id===this.controlledId)return;
    const ally=combatActor(this.allies,id,actor=>actor.id);
    if(!ally||!ally.member.player.health||this.fallen.has(id)||!ally.visual.container.active)return;
    const leader=this.controlledVisual;
    if(!leader)return;
    const now=this.app.session.nowMs??0;
    if((this.regroupCooldowns.get(id)??0)>now)return;
    const actor=this.movement.actor(ally.visual);
    const landing=this.partyLanding(actor.shape(),actor,id,leader);
    if(!landing)return;
    ally.ai.cancel();
    const position=this.movement.position(ally.visual);
    const distance=Math.hypot(position.x-landing.x,position.y-landing.y);
    const attempts=(this.regroupAttempts.get(id)??0)+1;
    this.regroupAttempts.set(id,attempts);
    if(distance>200||this.performanceHidden||attempts>=3){
      this.movement.place(ally.visual,landing);
      this.regroupAttempts.delete(id);this.regroupCooldowns.delete(id);
    }else{
      // 先在附近重新找路，不在玩家眼前瞬移；连续三次都脱不了困才允许直接落位。
      this.regroupCooldowns.set(id,now+3000);
      this.movement.stop(ally.visual);
    }
    setCharacterClip(this.scene,ally.visual,`idle-${ally.facing}`,true);
    this.followerCatchUps++;
  }
  /**
   * 绑定当前操控者。`cancelActions=false` 只交接触发、相机和 HUD，不碰任何人的动作；
   * 玩家主动切人走这条，正在进行的普攻或技能由原角色自己收尾。
   */
  private syncControlled(cancelActions=true):void{
    const id=this.controlledId;
    this.feedback.cancelShake();
    this.combat=this.partyControllers.get(id);
    if(!this.combat&&id!=='player')return;
    this.syncedControlledId=id;
    if(cancelActions){for(const ally of this.allies)ally.ai.cancel();this.heroAi?.cancel();}
    this.scene.syncControlledCharacter();
  }
  switchControl(id:string):boolean{
    if(id===this.controlledId)return false;
    if(!this.partyControllers.has(id))return false;
    const previous=this.controlledVisual;
    if(!this.app.session.party?.switchControl(id))return false;
    this.movement.stop(previous);this.syncControlled(false);return true;
  }

  /**
   * Q/E 切人：只在存活、已出战且有战斗控制器的成员之间循环。
   * 目标不可用时静默返回 false；单人队伍、全灭或资源未加载完都不会有动作。
   */
  switchMember(direction: -1 | 1): boolean {
    const party = this.app.session.party;
    if (!party) return false;
    const candidates = party.livingIds.filter(id => this.partyControllers.has(id));
    if (candidates.length < 2) return false;
    const target = adjacentLivingMember(candidates, this.controlledId, direction);
    if (!target || target === this.controlledId) return false;
    return this.switchControl(target);
  }
  focusTarget(key:string|undefined):void{if(key&&this.pendingDefeats.has(key))return;this.focusTargetId=key;for(const ally of this.allies)if(ally.id!==this.controlledId)ally.ai.cancel();if(this.controlledId!=='player')this.heroAi?.cancel();}
  focusSelected():void{if(this.targetId)this.focusTarget(this.targetId);else this.followControlled();}
  followControlled():void{this.focusTarget(undefined);this.combat?.cancel(false);}

  async start():Promise<void>{
    const catalog=this.app.battleCatalog;
    const attack=this.equipmentAttack(this.player.actor);
    // 玩家侧素材已由入口常驻包持有，这里再取同一批是幂等的；敌人按进图预取的同一份超集加载，
    // 包含可破坏物掉落怪、剧情遭遇、泉水与宝箱怪，运行时刷怪不会再遇到未加载的纹理。
    const enemyIds=new Set([...this.scene.combatEnemyIds(),...this.roster.spawns.map(spawn=>spawn.enemyId),
      ...this.scene.entities.flatMap(entity=>{
        const kind=this.app.world.actors[entity.actor]?.chest;
        const spawn=kind?this.drops.chests[kind]?.spawn:undefined;
        return spawn?[spawn.enemyId]:[];
      })]);
    const needed=[...playerCombatAssets({catalog,wardrobe:this.app.wardrobe,items:this.app.items,hero:this.hero,actor:this.player.actor}),
      ...sharedCombatAssets(catalog,this.app.wardrobe),
      ...[...enemyIds].flatMap(id=>{
        const definition=catalog.enemies.find(enemy=>enemy.id===id);
        if(!definition)throw new Error(`敌人定义缺失：${id}`);
        return this.enemyAssets(definition);
      })];
    // 音效与画面并行准备，不参与战斗入口的等待：音频加载失败不该挡住战斗。
    this.prepareCombatSounds(this.controllableClasses());
    const generation=++this.generation;
    const lease=await loadSceneAssets(this.scene,needed,()=>{});
    if(this.closed||generation!==this.generation){lease.release();return;}
    this.playerAssets=lease;
    this.presenter=new CombatPresenter(this.scene,catalog,id=>this.visualOf(id),()=>this.combatants(),
      this.combatEffects);
    const heroController=this.createPartyController('player',this.player,this.presenter,attack);
    this.combat=heroController.controller;
    this.partySkills.set('player',this.partySkillsFor('player'));
    this.heroAi=new PartyController('player',heroController.port,heroController.controller);
    if(!this.hero.player.health)this.markAlreadyFallen('player');
    this.lastSkillReset=this.app.session.skills.resetVersion;
    this.unsubscribeHero=this.hero.subscribe(()=>this.onHeroChanged());
    this.unsubscribeSession=this.app.session.subscribe(()=>this.onPartyChanged());
    await this.syncAllies();
    for(const placed of [...this.roster.enemies])this.spawnEnemy(placed);
    this.setPerformanceActive(this.scene.performing);
    this.scene.refreshCombatTarget();
  }
  private equipmentAttack(actor:ActorDefinition,id='player'){
    return equipmentAttackFor(this.app.wardrobe,this.app.items,this.hero,actor,id);
  }
  private selectBasicAttack(id:string,actor:ActorDefinition,normal:ResolvedBasicAttack):BasicAttackSelection {
    const member=this.memberOf(id);if(!member)return normal;
    const equipment=member.bag.equipmentItems(member.bag.equipmentFor(id));
    const offhand=equipment['off-hand'];
    if(chooseDualWield(member.classId,!!offhand&&this.app.items.items[offhand].equipment?.slot==='main-hand',
      {random:Math.random,chance:()=>this.actorAttribute(id,'offhandAttackChance')})){
      const profile=costumeRecipe(this.app.wardrobe,this.app.items,equipment).dualWieldAttack;
      if(!profile)return normal;
      return resolveBasicAttack({basicAttacks:{'dual-wield':profile}},
        {actor,basicAttack:{profileId:'dual-wield',clips:profile.clips}});
    }
    if(this.actorAttribute(id,'frenzyAttackChance')<=0)return normal;
    const roll=Math.floor(Math.random()*999)+1;
    if(roll>=this.actorAttribute(id,'frenzyAttackChance'))return normal;
    const recipe=costumeRecipe(this.app.wardrobe,this.app.items,member.bag.equipmentItems(member.bag.equipmentFor(id)));
    if(!recipe.frenzyAttack&&recipe.frenzyWaitFrames===undefined)throw new Error('当前装备缺少战栗的狂气动作定义');
    const durationFrames=this.app.session.frenzyAnimations.select(id,recipe.frenzyAttack?.cycleFrames,
      recipe.frenzyWaitFrames??recipe.frenzyAttack!.cycleFrames);
    return recipe.frenzyAttack?resolveBasicAttack({basicAttacks:{frenzy:recipe.frenzyAttack}},
      {actor,basicAttack:{profileId:'frenzy',clips:recipe.frenzyAttack.clips}}):{kind:'animation-unavailable',durationFrames};
  }
  updateMemberAppearance(id:string,actor:ActorDefinition):void {
    const ally=combatActor(this.allies,id,actor=>actor.id);if(!ally)return;
    ally.controller.cancel(true);ally.visual.actor=actor;this.movement.refreshShape(ally.visual);
    setCharacterClip(this.scene,ally.visual,`idle-${ally.facing}`,true);
  }
  updateEquipment(id='player'):void{
    const member=this.memberOf(id);
    if(member){
      const recipe=costumeRecipe(this.app.wardrobe,this.app.items,member.bag.equipmentItems(member.bag.equipmentFor(id)));
      this.app.session.frenzyAnimations.updateEquipment(id,recipe.frenzyAttack?.cycleFrames);
    }
    const controller=this.partyControllers.get(id);if(!controller)return;
    controller.cancel(true);
    if(id==='player')controller.setBasicAttack(this.equipmentAttack(this.player.actor));
    else{const ally=combatActor(this.allies,id,actor=>actor.id),character=this.app.battleCatalog.classes.find(value=>value.id===ally?.member.classId);
      if(ally&&character)controller.setBasicAttack(this.equipmentAttack(ally.visual.actor,id));
    }
  }
  private spawnEnemy(placed:PlacedEnemy):void{
    if(this.closed||this.arena.some(enemy=>enemy.key===placed.key))return;
    // 新刷出的敌人/召唤物需要重新应用当前暂停状态。
    this.pausedValue=undefined;
    const definition=this.app.battleCatalog.enemies.find(enemy=>enemy.id===placed.enemyId);
    if(!definition?.actor.collision)throw new Error(`敌人外观缺少碰撞范围：${placed.enemyId}`);
    this.arena.push(this.buildEnemy(placed,definition));refreshCombatActors(this.arena);
  }
  syncChestEnemies():void {
    this.consumeRosterChanges(this.roster.refresh());
  }
  /** Load encounter resources before creating physical enemies in the formal map. */
  async projectStoryEnemies(signal:AbortSignal):Promise<void>{
    signal.throwIfAborted();
    const definitions=[...new Set(this.roster.spawns.map(spawn=>spawn.enemyId))].map(id=>{
      const definition=this.app.battleCatalog.enemies.find(enemy=>enemy.id===id);
      if(!definition)throw new Error(`剧情敌人缺少定义：${id}`);return definition;
    });
    const buffs=this.app.session.storyWorld.pendingPartyBuffs;
    const effects=Object.fromEntries(buffs.flatMap(value=>{const effect=this.app.battleCatalog.statusAttackBuffs?.[value.buff]?.applicationEffect;return effect?[[effect,this.app.battleCatalog.attackEffects[effect]]]:[];}));
    const lease=await loadSceneAssets(this.scene,[...definitions.flatMap(definition=>this.enemyAssets(definition)),...effectAssets(effects)],()=>{});
    if(this.closed||signal.aborted){lease.release();signal.throwIfAborted();return;}
    this.storyAssets?.release();this.storyAssets=lease;
    applyStoryEnemyRemovals(this.app.session,this.scene.map!.id,this.arena.map(enemy=>({key:enemy.key,enemyId:enemy.definition.id})),key=>{this.conditions.remove(key);this.removeEnemy(key);});
    this.syncChestEnemies();
    await this.syncAllies();
    signal.throwIfAborted();
    for(const value of buffs){
      const effect=this.app.battleCatalog.statusAttackBuffs?.[value.buff];
      if(!effect)throw new Error('剧情状态缺少定义：'+value.buff);
      for(const id of this.activePartySlots())this.applyActorBuff(id,value.buff,value.strength,effect,id);
    }
    this.app.session.storyWorld.consumePartyBuffs(buffs.length);
    for(const id of [...this.fallen])if(this.memberOf(id)?.player.health)this.reviveMember(id);
    const party=this.app.session.party;
    if(this.defeated&&(party?.livingIds.length??this.hero.player.health)>0){
      this.defeated=false;this.wipeoutPosition=undefined;this.focusTargetId=undefined;
      if(party&&!party.alive(party.controlledId))party.switchControl(party.livingIds[0]);
      this.syncControlled();
    }
  }
  async normalizeForStory(signal:AbortSignal):Promise<void> {
    signal.throwIfAborted();
    for(const finish of [...(this.partyDefeatWork?.values()??[])])finish();
    this.runtime.reset();this.suspendPartyActions();
    for(const enemy of this.arena){enemy.controller?.combatController?.cancel(true,false);enemy.controller?.targetRemoved(this.controlledId);this.movement.stop(enemy.visual);}
    // A death already confirmed by combat must settle before the story checkpoint.
    this.pendingDefeats.flush();
    if(this.pendingAllies.size){
      await new Promise<void>((resolve,reject)=>{
        const cleanup=()=>{this.allyWaiters.delete(done);signal.removeEventListener('abort',abort);};
        const done=()=>{if(this.pendingAllies.size&&!this.closed)return;cleanup();if(this.closed)reject(new DOMException('正式战斗已关闭','AbortError'));else resolve();};
        const abort=()=>{cleanup();reject(signal.reason??new DOMException('剧情已取消','AbortError'));};
        this.allyWaiters.add(done);signal.addEventListener('abort',abort,{once:true});
      });
      signal.throwIfAborted();
      if(this.allyLoadFailure)throw this.allyLoadFailure;
      this.partyActionsSuspended=false;this.suspendPartyActions();
    }
  }
  get completedStoryEncounters(){return this.roster.completedEncounters();}
  private makeSelectable(enemy:MapEnemy):void{
    if(enemy.summonedBy&&this.memberOf(enemy.summonedBy))return;
    const rect=enemyTapRect(enemy.definition.actor);
    // `enemy` 标记给世界级左键用：点到敌人时直接普攻，不会被旁边的交互物抢走。
    enemy.visual.container.setInteractive(new Phaser.Geom.Rectangle(rect.x,rect.y,rect.width,rect.height),Phaser.Geom.Rectangle.Contains)
      .setData('enemy',true);
    enemy.visual.container.on('pointerdown',()=>{if(this.scene.canCombatControl)this.selectEnemy(enemy.key);});
  }
  private visualOf(id:string):CharacterVisual|undefined{
    return id==='player'?this.scene.player:combatActor(this.allies,id,actor=>actor.id)?.visual??combatActor(this.arena,id,actor=>actor.key)?.visual;
  }
  private combatant(id:string):Combatant|undefined{
    if(this.pendingDefeats.has(id)||this.memberOf(id)&&!this.activeParty.includes(id))return;
    const visual=this.visualOf(id);
    if(!visual?.container.active||!visual.actor.collision)return;
    const enemy=combatActor(this.arena,id,actor=>actor.key);
    const ally=combatActor(this.allies,id,actor=>actor.id);
    if((id==='player'||ally)&&!this.memberOf(id)?.player.health&&!this.hitResolution?.isAwaitingDefeat(id))return;
    return {id,team:id==='player'||ally||(enemy?.summonedBy&&this.memberOf(enemy.summonedBy))?'party':'hostile',
      position:this.movement.position(visual),bounds:this.movement.actor(visual).shape().collision!,states:this.conditions.activeStates(id),
      facing:id==='player'?this.scene.facing:ally?.facing??enemy?.facing};
  }
  selectEnemy(key:string):void{if(this.pendingDefeats.has(key)||!this.combat?.selectTarget(key))return;this.focusTarget(key);this.scene.refreshCombatTarget();}
  targetStatus(){
    // 操作人有目标时用操作人的；操作人没动手时，队友正在打或正在交战的敌人也要显示在顶部。
    const enemy=this.targetOnMap(this.combat?.selectedTargetId())
      ??this.targetOnMap(this.partyTarget())??this.targetOnMap(this.engagedTarget());
    return enemy?this.roster.enemyStatus(enemy.key,enemy.definition):undefined;
  }
  private targetOnMap(id:string|undefined){
    return id?this.arena.find(item=>item.key===id&&!this.pendingDefeats.has(item.key)):undefined;
  }
  /** 队友控制器当前盯着的敌人；操作人的控制器不在这里重复算。 */
  private partyTarget():string|undefined{
    for(const [id,controller]of this.partyControllers){
      if(id===this.controlledId)continue;
      const target=controller.selectedTargetId();
      if(target)return target;
    }
    return undefined;
  }
  /** 最近交战的敌人：佣兵被攻击但没有还手时，控制器里还没有目标。 */
  private engagedTarget():string|undefined{
    return this.awareness.tactics(this.controlledId,this.activeParty,this.focusTargetId).engagedTargetIds[0];
  }
  hasHostileTarget():boolean{const source=this.combatant(this.controlledId);return !!source&&this.combatants().some(target=>source.team!==target.team&&canTargetCombatant(source,target));}
  attack(key?:string):void{
    if(!this.scene.canCombatControl||this.closed||this.defeated)return;
    // 主动技能动作期间不接受第二个技能；普攻输入仍由控制器按原规则处理。
    if(key&&this.castingSkill)return;
    // 药水病状态 17 只封快捷栏技能，普攻和 AI 直接起手不受影响。
    if(key&&!this.conditions.canUseSkillShortcuts(this.controlledId))return;
    if(this.conditions.cannotAct(this.controlledId))return;
    const skill=key?skillForMember(this.app.battleCatalog,this.controlledId,key):undefined;
    if(key&&!skill?.action)return;
    const member=this.controlledMember;
    if(key&&this.controlledId==='player'&&!this.app.session.skills.isEquipped(key))return;
    const overrides=costumeRecipe(this.app.wardrobe,this.app.items,this.hero.bag.equipmentItems(this.hero.bag.equipmentFor(this.controlledId)),member.classId,member===this.hero?undefined:(member as CompanionMember).definition.actor).actions;
    const selected=key&&key in overrides?overrides[key]:skill?.action;
    const action=selected&&skill?.action?{...selected,hitEffectStyle:skill.action.hitEffectStyle,usesSkillDamageBuff:skill.action.usesSkillDamageBuff,combatUnits:skill.action.combatUnits,repeat:skill.action.repeat?{...skill.action.repeat,restartAfterFrame:selected.repeat?.restartAfterFrame??skill.action.repeat.restartAfterFrame}:undefined}:selected;
    if(key&&!action){this.app.ui.showInstant('该技能需要装备对应武器');return;}
    const configuration=this.skillConfiguration(this.controlledId,member);
    const level=key?configuration.draft(this.app.battleCatalog,member.classId).levels[key]:undefined;
    if(key&&!level)return;
    const manaCost=key?this.skillManaCost(this.controlledId,key,level):undefined;
    const clips=this.controlledId==='player'||!key?undefined:skillClips(key);
    this.runtime.request({actorId:this.controlledId,mode:action?'manual':'normal',skill:action?{id:key!,action,level,manaCost,clips}:undefined});
  }
  cancelAttack(clearEffects=false):void{
    if(!clearEffects&&this.combatRuntime?.hasPendingBasicStrike(this.controlledId))return;
    this.combat?.cancel(clearEffects,false);this.conditions.clearTemporary(this.controlledId);
  }
  /** 摇杆真的移动时调用：原版移动会清当前目标，面板随之隐藏。 */
  clearTarget():void{
    if(this.combatRuntime?.hasPendingBasicStrike(this.controlledId))return;
    this.combat?.clearSelection();
  }
  get paused():boolean{return this.runtime.paused;}
  settleForSave():void{this.pendingDefeats.flush();for(const finish of [...(this.partyDefeatWork?.values()??[])])finish();}
  setPaused(paused:boolean):void {
    if(this.pausedValue===paused)return;
    this.pausedValue=paused;
    this.runtime.setPaused('control',paused);
    for(const id of [...this.activeParty,...this.arena.map(enemy=>enemy.key)]){
      const visual=this.visualOf(id);if(!visual)continue;
      this.movement.setPaused(visual,paused);
      for(const layer of visual.layers)if(paused)layer.anims.pause();else layer.anims.resume();
      this.presenterFor(id)?.setPaused(paused);
    }
    this.combatEffects.setPaused(paused);
  }
  suspendPartyActions():void {
    if(this.partyActionsSuspended)return;
    this.partyActionsSuspended=true;
    for(const id of this.activeParty){
      // 剧情导演接管主角的走位；只中止战斗拥有的路径和回调。
      if(id==='player'&&this.scene.performing)continue;
      if(id===this.controlledId)this.partyControllers.get(id)?.cancel(true,false);
      else if(id==='player')this.heroAi?.cancel();
      else combatActor(this.allies,id,actor=>actor.id)?.ai.cancel();
      this.conditions.clearTemporary(id);
      const visual=this.visualOf(id);if(visual)this.movement.stop(visual);
    }
  }
  stopMoving():void{this.movement.stop(this.controlledVisual);if(this.controlledMember.player.health&&this.attackState!=='attacking')setCharacterClip(this.scene,this.controlledVisual,`idle-${this.facing}`);}
  movementSpeedForPlayer():number{return this.movementSpeed(this.controlledId,PLAYER_MOVE_SPEED);}
  playerCannotMove():boolean{return !this.conditions.canMove(this.controlledId)||this.defeated||!this.controlledMember.player.health;}
  /** 玩家真正给出方向输入：先解除埋伏与狙击，再挂上逐段恢复的移动斜坡。 */
  cancelAmbushOnDirection():void {
    const id=this.controlledId;
    if(!this.conditions.hasBuff(id,'ambush'))return;
    this.conditions.removeBuff(id,'ambush');
    this.conditions.removeBuff(id,'sniping');
    const recovery=this.app.battleCatalog.statusAttackBuffs?.['ambush-recovery'];
    if(recovery)this.applyActorBuff(id,'ambush-recovery',0,recovery,id);
  }
  /** 喝泉水给的状态：原版 `CHAR_DrinkSpring` 的效果类型 4 直接建 buff，不经过技能或命中。 */
  applySpringBuff(key:BattleBuffKey):boolean {
    const id=this.controlledId,effect=this.app.battleCatalog.statusAttackBuffs?.[key];
    if(!effect)return false;
    return this.applyActorBuff(id,key,0,effect,id);
  }
  playerCannotAct():boolean{return this.conditions.cannotAct(this.controlledId)||this.defeated||!this.controlledMember.player.health;}
  private markAlreadyFallen(id:string):void {
    const visual=this.visualOf(id);if(!visual)return;
    this.fallen.add(id);this.movement.setEnabled(visual,false);visual.container.setVisible(false);
  }
  private onPartyChanged():void {
    if(this.closed)return;
    const revision=this.app.session.skills.resetVersion;
    if(this.lastSkillReset!==undefined&&revision!==this.lastSkillReset){this.partyControllers.get('player')?.cancel(true);this.runtime.cancel('player');this.conditions.clearTemporary('player');}
    this.lastSkillReset=revision;
    const active=new Set(this.activeParty);
    for(const [id,controller] of this.partyControllers)if(!active.has(id)){
      controller.cancel(true);this.runtime.removeActor(id);this.partyControllers.delete(id);this.conditions.remove(id);this.threat?.removeActor(id);
      for(const enemy of [...this.arena])if(enemy.summonedBy===id)this.removeEnemy(enemy.key);
      this.summonGroups.delete(id);
      const visual=this.visualOf(id);if(visual){this.movement.setEnabled(visual,false);visual.container.setVisible(false);}
    }
  }
  private onHeroChanged():void {
    this.scene.refreshCombatTarget();
    if(this.hero.player.health===0)(this.hitResolution??=new CombatHitResolution()).deferDefeat('player',()=>{
      if(this.hero.player.health===0)this.memberDefeated('player');
    });
  }
  private memberDefeated(id:string):void{
    if(this.closed||this.fallen.has(id))return;
    const visual=this.visualOf(id);if(!visual)return;
    this.fallen.add(id);
    if(!this.activeParty.some(member=>this.memberOf(member)?.player.health))this.wipeoutPosition=this.movement.position(visual);
    this.partyControllers.get(id)?.cancel(true);
    this.conditions.remove(id);this.memberOf(id)?.clearCombatResourceLimits();
    if(id==='player')this.heroAi?.disable();else combatActor(this.allies,id,actor=>actor.id)?.ai.disable();
    for(const controller of this.partyControllers.values())controller.targetRemoved(id);
    for(const enemy of [...this.arena]){
      enemy.controller?.targetRemoved(id,'inactive');
      if(enemy.summonedBy===id)this.removeEnemy(enemy.key);
    }
    this.movement.stop(visual);this.movement.setEnabled(visual,false);
    const finish=()=>{
      this.partyDefeatWork?.delete(id);this.runtime.cancel(`party-defeat:${id}`);
      this.deathTweens.get(id)?.stop();
      this.deathTweens.delete(id);
      if(this.closed||this.memberOf(id)?.player.health)return;
      visual.container.setVisible(false);
      if(this.app.session.party?.onDefeat(id)??!this.hero.player.health){if(!this.deathTweens.size)this.playerDefeated();}
      else this.syncControlled();
    };
    const facing=id==='player'?this.scene.facing:combatActor(this.allies,id,actor=>actor.id)!.facing;
    const deathClip=`die-${facing}` as const,clip=id==='player'?undefined:visual.actor.clips[deathClip];
    if(clip)setCharacterClip(this.scene,visual,deathClip,true);
    else for(const sprite of visual.layers)sprite.anims.stop();
    const deathTween=this.scene.tweens.add({targets:visual.container,alpha:0,
      delay:clip?clip.frames*1000/clip.frameRate:0,duration:10*LOGIC_FRAME_MS});
    this.deathTweens.set(id,deathTween);
    // 暂停期间新倒下的角色也要立刻停在首帧，不能等下一次暂停状态切换。
    if(this.deathVisualsPaused){deathTween.pause();for(const sprite of visual.layers)sprite.anims.pause();}
    (this.partyDefeatWork??=new Map()).set(id,finish);
    this.runtime.schedule(`party-defeat:${id}`,10+(clip?Math.ceil(clip.frames*1000/clip.frameRate/LOGIC_FRAME_MS):0),finish);
  }
  private playerDefeated():void{
    if(this.defeated||this.closed)return;
    this.defeated=true;this.outcomes.setPaused(true);this.runtime.setPaused('control',true);
    for(const controller of this.partyControllers.values())controller.cancel(true);
    this.stopEnemies();this.movement.stop(this.controlledVisual);
    this.scene.handleCombatDefeat();
  }
  reviveMember(id:string,origin=this.movement.position(this.controlledVisual)):void {
    const visual=this.visualOf(id),member=this.memberOf(id);if(!member?.player.health)return;
    this.app.session.reviveCombatActor(id);
    this.runtime.cancel(`party-defeat:${id}`);this.partyDefeatWork?.delete(id);
    if(!visual)return;
    this.deathTweens.get(id)?.stop();this.deathTweens.delete(id);this.fallen.delete(id);this.dealtDamage?.delete(id);
    this.conditions.remove(id);member.clearCombatResourceLimits();this.partyControllers.get(id)?.reset();
    if(id==='player')this.heroAi?.reset();else combatActor(this.allies,id,actor=>actor.id)?.ai.reset();
    const actor=this.movement.actor(visual);
    // 一次复活两名队员时不能让两人落在同一个 origin 上：避开复活点、主角和其余队员。
    const avoid=[origin,...this.allies.filter(other=>other.id!==id).map(other=>this.movement!.position(other.visual))];
    if(this.scene.player)avoid.push(this.movement.position(this.player));
    const landing=choosePartyLanding(this.movement.navigation,actor.shape(),origin,actor,avoid)
      ??this.movement.navigation.nearestBody(actor.shape(),origin,actor)
      ??this.movement.navigation.nearest(actor.shape(),origin,actor);
    this.relocateVisual(visual,landing);this.movement.setEnabled(visual,true);
    visual.container.setAlpha(1).setVisible(!this.performanceHidden);setCharacterClip(this.scene,visual,'idle-south',true);
    this.outcomes.recover(visual);
  }
  revive(id:string,item:string):ItemResult {
    if(this.closed)throw new Error('当前无法复活');
    const party=this.app.session.party;if(!party)throw new Error('队伍不可用');
    const dead=party.activeIds.filter(member=>!party.alive(member));
    const origin=this.wipeoutPosition??this.movement.position(this.controlledVisual);
    const result=party.revive(id,item);
    for(const member of dead)if(party.alive(member))this.reviveMember(member,origin);
    this.wipeoutPosition=undefined;
    this.defeated=false;this.focusTargetId=undefined;
    if(!party.alive(party.controlledId))party.switchControl(party.livingIds[0]);
    this.syncControlled();this.app.audio?.ui('heal');return result;
  }
  /** GM 复活：跳过复活道具与「全队阵亡」限制，其余表现收尾与正常复活一致。 */
  reviveForDebug(id:string):void {
    const party=this.app.session.party;if(!party)return;
    const origin=this.wipeoutPosition??this.movement.position(this.controlledVisual);
    this.reviveMember(id,origin);
    this.wipeoutPosition=undefined;this.defeated=false;this.focusTargetId=undefined;
    if(!party.alive(party.controlledId))party.switchControl(party.livingIds[0]);
    this.syncControlled();this.app.audio?.ui('heal');
  }
  reviveAtHealer():void {
    const origin=this.movement.position(this.controlledVisual);
    const result=reviveAtHealer(this.app.session);
    for(const id of result.memberIds)this.reviveMember(id,origin);
    this.syncControlled();this.app.audio?.ui('heal');
  }
  setPerformanceActive(active:boolean):void{
    if(this.performanceHidden===active||this.closed)return;
    this.performanceHidden=active;
    // 演出结束角色可能已经被传送到别处；先按当前面朝方向重新对齐队形。
    if(!active)this.resetFormationState(this.facingOfControlled());
    this.outcomes.setVisible(!active);
    this.feedback.setVisible(!active);
    this.feedback.setPaused(active||this.defeated||!this.scene.canCombatControl);
    this.outcomes.setPaused(active||this.defeated||!this.scene.canCombatControl);
    for(const ally of this.allies){ally.overhead.setVisible(!active);this.movement.stop(ally.visual);ally.visual.container.setVisible(!active&&ally.member.alive);this.movement.setEnabled(ally.visual,!active&&ally.member.alive);}
    for(const enemy of this.arena){
      if(this.pendingDefeats.has(enemy.key)){enemy.visual.container.setVisible(!active);continue;}
      if(active){
        this.movement.stop(enemy.visual);
        enemy.visual.container.setVisible(false);
        this.movement.setEnabled(enemy.visual,false);
      }else{
        const actor=this.movement.actor(enemy.visual);
        const position=this.movement.navigation.nearestBody({collision:enemy.definition.actor.collision},this.movement.position(enemy.visual),actor)
          ??this.movement.navigation.nearest(enemy.definition.actor,this.movement.position(enemy.visual),actor);
        this.relocateVisual(enemy.visual,position);
        this.movement.setEnabled(enemy.visual,true);
        enemy.visual.container.setVisible(true);
      }
    }
  }
  private syncBuffLoops():void {
    const ids=new Set<string>();
    for(const id of this.activeParty){
      ids.add(id);
      const active=(this.memberOf(id)?.player.health??0)>0||this.hitResolution?.isAwaitingDefeat(id);
      this.buffLoops.sync(id,this.visualOf(id),active?this.conditions.buffLoopFrames(id):[]);
    }
    for(const enemy of this.arena){
      ids.add(enemy.key);
      this.buffLoops.sync(enemy.key,enemy.visual,this.pendingDefeats.has(enemy.key)?[]:this.conditions.buffLoopFrames(enemy.key));
    }
    this.buffLoops.retainActors(ids);
  }
  update(delta:number,enabled:boolean):void{
    if(this.closed||!this.player?.container.active)return;
    this.pathBudget?.reset();
    this.outcomes.setPaused(!enabled||this.defeated);
    const deathPaused=!enabled||this.defeated;
    if(deathPaused!==this.deathVisualsPaused){
      this.deathVisualsPaused=deathPaused;
      for(const [id,tween]of this.deathTweens){
        if(deathPaused)tween.pause();else tween.resume();
        for(const sprite of this.visualOf(id)?.layers??[])if(deathPaused)sprite.anims.pause();else sprite.anims.resume();
      }
    }
    this.feedback.setPaused(!enabled||this.defeated);
    const colorFrame=this.app.session.combatTick;
    setCharacterStealth(this.player,this.conditions.hasState('player','stealthed'));
    for(const ally of this.allies)setCharacterStealth(ally.visual,this.conditions.hasState(ally.id,'stealthed'));
    for(const enemy of this.arena)setCharacterStealth(enemy.visual,this.conditions.hasState(enemy.key,'stealthed'));
    this.statusColors.paint(this.player,this.conditions.appearanceColors('player'),colorFrame);
    for(const ally of this.allies)this.statusColors.paint(ally.visual,this.conditions.appearanceColors(ally.id),colorFrame);
    for(const enemy of this.arena)if(!this.pendingDefeats.has(enemy.key))this.statusColors.paint(enemy.visual,this.conditions.appearanceColors(enemy.key),colorFrame);
    this.syncStunStars(enabled&&!this.performanceHidden&&!this.defeated);
    this.setPaused(!enabled||this.defeated);
    if(!enabled||this.defeated){
      this.syncBuffLoops();
      if(!this.defeated)for(const id of this.activeParty)this.syncCombatResourceLimits(id);
      return;
    }
    this.partyActionsSuspended=false;
    this.app.session.advanceGameTime(delta);
    this.consumeRosterChanges(this.roster.refresh());
    if(this.scene.time.now>=this.nextPartySyncAt&&this.app.session.party?.activeIds.join('|')!==this.partySignature)
      void this.syncAllies().catch(error=>this.app.ui.toast((error as Error).message));
    if(this.controlledId!==this.syncedControlledId&&this.partyControllers.has(this.controlledId))this.syncControlled(false);
    const tickBefore=this.app.session.combatTick;
    this.app.session.advanceCombatFrames(delta,()=>{
      this.advanceFormation();
      this.conditions.update(LOGIC_FRAME_MS,tick=>this.periodicTick(tick));
      this.scene.refreshShortcutPage();
      if(this.focusTargetId&&!this.conditions.canTarget(this.focusTargetId)){this.focusTargetId=undefined;this.scene.refreshCombatTarget();}
      for(const id of this.activeParty){
        if(this.memberOf(id)?.player.health){if(this.fallen.has(id))this.reviveMember(id);}
        else this.memberDefeated(id);
      }
      for(const id of this.activeParty)this.syncCombatResourceLimits(id);
      this.combat?.update();
      for(const id of this.activeParty){if(id===this.controlledId||!this.memberOf(id)?.player.health)continue;
        this.syncAiSkills(id);if(id==='player')this.heroAi?.step();else combatActor(this.allies,id,actor=>actor.id)?.ai.step();
      }
      if(this.partyFullyEngaged())this.damageCount=0;
      for(const enemy of [...this.arena])if(!this.pendingDefeats.has(enemy.key)&&enemy.summonRemainingMs!==undefined){
        enemy.summonRemainingMs-=LOGIC_FRAME_MS;if(enemy.summonRemainingMs<=0)this.removeEnemy(enemy.key);
      }
      this.updateEnemies(true);
      this.runtime.step(this.app.session.combatTick);
      if(this.defeated||this.closed||!this.scene.canCombatControl)return false;
      this.recoverResources();
    });
    // 冷却读数按战斗帧变化；这一渲染帧没推进逻辑帧时不必重新取快照、重算签名。
    if(tickBefore!==this.app.session.combatTick)this.scene.refreshSkillCooldowns(this.cooldowns);
    this.syncBuffLoops();
  }
  /** 眩晕是规则状态，原版没有动作或图标；这里补一个只读状态、不参与结算的头顶提示。 */
  private syncStunStars(visible:boolean):void{
    const combatants:[string,CharacterVisual][]=[['player',this.player]];
    for(const ally of this.allies)combatants.push([ally.id,ally.visual]);
    for(const enemy of this.arena)combatants.push([enemy.key,enemy.visual]);
    const seen=new Set<string>();
    for(const [id,visual] of combatants){
      seen.add(id);
      let entry=this.stunStars.get(id);
      if(!this.conditions.hasState(id,'stun')||!visual.container.active){
        if(entry){entry.stars.destroy();this.stunStars.delete(id);}
        continue;
      }
      if(entry?.visual!==visual){
        entry?.stars.destroy();
        entry={visual,stars:new StunStars(this.scene,visual)};
        this.stunStars.set(id,entry);
      }
      entry.stars.setVisible(visible);
    }
    for(const [id,entry] of this.stunStars){
      if(seen.has(id))continue;
      entry.stars.destroy();this.stunStars.delete(id);
    }
  }
  private readVisiblePartyResources():void {
    if(this.closed||this.performanceHidden)return;
    for(const id of this.activeParty.slice(0,ACTIVE_PARTY_SLOT_COUNT)){
      const visual=this.visualOf(id);
      if(!visual?.container.active||!visual.container.visible||this.fallen.has(id))continue;
      this.readResourceCapacity(id,'maxHealth');
      this.readResourceCapacity(id,'maxMana');
    }
  }
  afterMovement():void{
    this.readVisiblePartyResources();
    if(this.hero.player.health>0&&this.controlledId!=='player'&&this.partyControllers.get('player')?.actionState()!=='attacking'){
      const moving=isBodyWalking(this.movement.body(this.player));
      setCharacterClip(this.scene,this.player,`${moving?'walk':'idle'}-${this.scene.facing}`);
    }
    for(const ally of this.allies){if(!ally.member.alive||ally.id===this.controlledId||ally.controller.actionState()==='attacking')continue;
      const moving=isBodyWalking(ally.body);
      setCharacterClip(this.scene,ally.visual,`${moving?'walk':'idle'}-${ally.facing}`);
    }
    for(const enemy of this.arena){
      if(this.pendingDefeats.has(enemy.key))continue;
      if(enemy.controller?.actionState()==='attacking')continue;
      const moving=isBodyWalking(enemy.body);
      const clip=`${moving?'walk':'idle'}-${enemy.facing}` as const;
      setCharacterClip(this.scene,enemy.visual,enemy.definition.actor.clips[clip]?clip:'idle-south');
    }
  }
  destroy():void{
    if(this.closed)return;
    this.closed=true;this.generation++;this.combatRuntime?.dispose();this.partyDefeatWork?.clear();
    for(const notify of [...this.allyWaiters])notify();
    for(const tween of this.deathTweens.values())tween.stop();this.deathTweens.clear();this.fallen.clear();
    if(this.app.useRecoveryItem===this.useRecoveryItem)this.app.useRecoveryItem=undefined;
    this.pendingDefeats.flush();this.outcomes.destroy();this.feedback.destroy();
    this.hero.clearCombatResourceLimits();for(const ally of this.allies)ally.member.clearCombatResourceLimits();
    this.heroAi?.dispose();this.heroAi=undefined;
    for(const entry of this.stunStars.values())entry.stars.destroy();
    this.stunStars.clear();
    for(const ally of [...this.allies]){ally.ai.dispose();ally.overhead.destroy();this.movement.remove(ally.visual);ally.visual.container.destroy();ally.assets?.release();}
    this.allies=[];this.partyControllers.clear();this.partySkills.clear();this.combat=undefined;
    this.presenter?.clear();this.presenter=undefined;
    this.combatEffects.clear();
    this.unsubscribeHero?.();this.unsubscribeHero=undefined;this.unsubscribeSession?.();this.unsubscribeSession=undefined;
    this.buffLoops.clear();
    this.clearEnemies();this.conditions.clear();this.summonGroups.clear();
    this.playerAssets?.release();this.playerAssets=undefined;
    this.restoredAssets?.release();this.restoredAssets=undefined;
    this.storyAssets?.release();this.storyAssets=undefined;
  }

}
