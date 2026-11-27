import {buffEffectNames} from './buff-effects.ts';
import type {
  LearnedReactionSkillId,
  SkillGrowthProfile,
  SkillLoadout,
  SkillReaction,
  SkillReactionBuff,
} from './battle-buff-types.ts';

export type { SkillReaction, SkillReactionBuff } from './battle-buff-types.ts';

/** 已学反应查表所需的最小技能与目录结构；由 `SkillDefinition`/`BattleCatalog` 结构兼容，保持零环依赖。 */
export interface LearnedSkillReactionEntry {
  readonly id: string;
  readonly reactionsByRank?: readonly (readonly SkillReaction[])[];
  readonly companion?: { readonly reactionsByRank?: readonly (readonly SkillReaction[])[] };
}
export interface LearnedSkillReactionCatalog {
  readonly classes: readonly { readonly id: string; readonly skills: readonly string[] }[];
  readonly skills: Readonly<Record<string, LearnedSkillReactionEntry>>;
}

/** 概率阈值按千分制存放；掷 1..999 后严格小于阈值才命中。 */
const CHANCE_ROLL_MAX=999;
/** 吸血、伤害转化等比率字段以千分数存放（1000 = 100%）。 */
const PER_THOUSAND=1000;
/** 血之渴望只在概率阈值至少 200（千分制 20%）时参与判定。 */
const BLOOD_THIRST_MIN_CHANCE=200;

interface AttackReactionEvent {
  ownerId:string;
  opponentId:string;
  damageKind:'physical'|'magic';
  outcome:'miss'|'hit'|'critical'|'weapon-block'|'shield-block';
}

/** The caller emits these phases in attack order, before committing the main hit. */
export type SkillReactionEvent =
  | (AttackReactionEvent & {kind:'attack-success';hitDamage:number;otherLifeDrainPerThousand:number})
  | (AttackReactionEvent & {kind:'physical-attack-effects';armorBreakChance:number})
  | (AttackReactionEvent & {kind:'physical-revenge';chanceThreshold:number})
  | (AttackReactionEvent & {kind:'physical-instinct';chanceThreshold:number;mainHandTwoHanded:boolean})
  | (AttackReactionEvent & {kind:'physical-defense-instinct';chanceThreshold:number})
  | (AttackReactionEvent & {kind:'physical-flare';hand?:'main-hand'|'offhand'})
  | (AttackReactionEvent & {kind:'blood-thirst';hitDamage:number;chanceThreshold:number})
  | (AttackReactionEvent & {kind:'attack-effects';actionId:string;hasMoltenArmor:boolean})
  /** 主人的召唤物打中目标之后；主人侧的反应按它自己的已学等级结算。 */
  | (AttackReactionEvent & {kind:'summon-attack-success'})
  | (AttackReactionEvent & {kind:'summon-physical-success'})
  | {kind:'physical-block';ownerId:string}
  | {kind:'molten-reflection-completed';ownerId:string;opponentId:string}
  | {kind:'physical-hit-received';ownerId:string}
  | (AttackReactionEvent & {kind:'blood-revenge'})
  | {kind:'action-stealth-break';ownerId:string}
  /** 直接治疗被接受之后（满血也算）；零生命在治疗入口就被拒，不会走到这里。 */
  | {kind:'direct-heal-accepted';ownerId:string;targetId:string}
  /** 技能（不是普攻）的成功命中之后：物理与非盾挡魔法都进。 */
  | (AttackReactionEvent & {kind:'skill-attack-success'})

export type LearnedReactionSkill='dark-strike'|'armor-penetration'|'revenge-incarnate'|'whist'|LearnedReactionSkillId;

export interface SkillReactionPorts {
  random:()=>number;
  learnedBuff:(ownerId:string,skill:LearnedReactionSkill)=>SkillReactionBuff|undefined;
}

export type SkillReactionCommand =
  | {kind:'apply-buff';sourceId:string;targetId:string;buff:SkillReactionBuff}
  /** 接收者是固定三槽的一批角色，由宿主展开成逐个 apply-buff。 */
  | {kind:'apply-party-buff';sourceId:string;buff:SkillReactionBuff}
  | {kind:'restore-health';targetId:string;amount:number}
  | {kind:'restore-mana';targetId:string;amount:number}
  | {kind:'reset-skill-cooldowns';targetId:string}
  | {kind:'play-effect';targetId:string;effect:string};

interface BloodThirstReactionPorts {
  random:()=>number;
  lifeDrainPerThousand:()=>number;
  manaRecovery:()=>number;
  apply:(command:SkillReactionCommand)=>void;
}

export function learnedSkillReactions(catalog:LearnedSkillReactionCatalog,classId:string,loadout:SkillLoadout,growth:SkillGrowthProfile='hero'):SkillReaction[] {
  return (catalog.classes.find(character=>character.id===classId)?.skills??[]).flatMap(id=>{
    const level=loadout.levels[id],skill=catalog.skills[id];
    if(!skill)return [];
    const ranks=growth==='hero'?skill.reactionsByRank:skill.companion
      ?skill.companion.reactionsByRank:(()=>{throw new Error(`技能缺少伙伴成长配置：${skill.id}`);})();
    return level&&ranks?[...(ranks[Math.min(level,ranks.length)-1]??[])]:[];
  });
}

export function skillReactionEffects(skill:{readonly reactionsByRank?:readonly (readonly SkillReaction[])[]}):string[] {
  return [...new Set((skill.reactionsByRank??[]).flat().flatMap(reaction=>{
    if(reaction.kind==='soul-sword')return [...reaction.physicalEffects,...reaction.magicEffects];
    if(reaction.kind==='blood-sword')return ['life-drain'];
    if(reaction.kind==='blood-thirst')return [reaction.lifeEffect,reaction.manaEffect];
    if(reaction.kind==='flare')return [reaction.effect,...buffEffectNames(reaction.unlearnedStealth.effect)];
    if(reaction.kind==='clever-fellow')return [];
    if(reaction.kind==='owner-mana-restore')return [reaction.effect];
    if(reaction.kind==='disturbance'||reaction.kind==='lightning-of-hell'||reaction.kind==='god-of-justice')return [];
    return buffEffectNames(reaction.buff.effect);
  }))];
}

function succeeds(threshold:number,random:()=>number):boolean {
  return threshold>0 && Math.floor(random()*CHANCE_ROLL_MAX)+1<threshold;
}

function successfulAttack(event:AttackReactionEvent):boolean {
  return event.outcome!=='miss' && !(event.damageKind==='magic' && event.outcome==='shield-block');
}

/** Apply healing and its visual before reading the current mana recovery attribute. */
export function executeBloodThirstReaction(event:Extract<SkillReactionEvent,{kind:'blood-thirst'}>,ports:BloodThirstReactionPorts):void {
  if(event.damageKind!=='physical'||!successfulAttack(event)||event.chanceThreshold<BLOOD_THIRST_MIN_CHANCE||!succeeds(event.chanceThreshold,ports.random))return;
  const rate=Math.max(0,ports.lifeDrainPerThousand());
  ports.apply({kind:'restore-health',targetId:event.ownerId,amount:Math.trunc(event.hitDamage*rate/PER_THOUSAND)});
  ports.apply({kind:'play-effect',targetId:event.ownerId,effect:'life-drain'});
  const mana=ports.manaRecovery();
  if(mana>0){
    ports.apply({kind:'restore-mana',targetId:event.ownerId,amount:mana});
    ports.apply({kind:'play-effect',targetId:event.ownerId,effect:'mana-recovery'});
  }
}

/** Resolve only this phase; applying commands and scheduling buff expiry belong to the host. */
export function resolveSkillReactions(
  reactions:readonly SkillReaction[],event:SkillReactionEvent,ports:SkillReactionPorts,
):SkillReactionCommand[] {
  const commands:SkillReactionCommand[]=[];
  const apply=(buff:SkillReactionBuff,targetId:string)=>{
    commands.push({kind:'apply-buff',sourceId:event.ownerId,targetId,buff});
  };
  if(event.kind==='attack-success'){
    if(!successfulAttack(event))return commands;
    for(const reaction of reactions){
      if(reaction.kind!=='soul-sword'||!succeeds(reaction.chanceThreshold,ports.random))continue;
      const buff=ports.learnedBuff(event.ownerId,reaction.buffFromLearnedSkill);
      if(buff)apply(buff,event.ownerId);
      const effects=event.damageKind==='physical'?reaction.physicalEffects:reaction.magicEffects;
      for(const effect of effects)commands.push({kind:'play-effect',targetId:event.ownerId,effect});
    }
    if(event.damageKind==='physical'){
      const rate=reactions.reduce((sum,reaction)=>sum+(reaction.kind==='blood-sword'?reaction.lifeDrainPerThousand:0),
        event.otherLifeDrainPerThousand);
      if(rate>0){
        commands.push({kind:'restore-health',targetId:event.ownerId,amount:Math.trunc(event.hitDamage*rate/PER_THOUSAND)});
        commands.push({kind:'play-effect',targetId:event.ownerId,effect:'life-drain'});
      }
    }
  }else if(event.kind==='physical-attack-effects'){
    if(event.damageKind==='physical'&&successfulAttack(event)&&succeeds(event.armorBreakChance,ports.random)){
      const buff=ports.learnedBuff(event.ownerId,'armor-penetration');
      if(buff)apply(buff,event.opponentId);
    }
  }else if(event.kind==='physical-revenge'){
    if(event.damageKind==='physical'&&successfulAttack(event)&&succeeds(event.chanceThreshold,ports.random)){
      const buff=ports.learnedBuff(event.ownerId,'revenge-incarnate');
      if(buff)apply(buff,event.ownerId);
    }
  }else if(event.kind==='summon-attack-success'){
    // 吸血脚爪：物理或魔法成功（魔法盾挡不算）都按固定值给主人回魔，不抽概率、正值才执行。
    if(!successfulAttack(event))return commands;
    for(const reaction of reactions){
      if(reaction.kind!=='owner-mana-restore'||reaction.amount<=0)continue;
      commands.push({kind:'restore-mana',targetId:event.ownerId,amount:reaction.amount},
        {kind:'play-effect',targetId:event.ownerId,effect:reaction.effect});
    }
  }else if(event.kind==='summon-physical-success'){
    if(event.damageKind!=='physical'||!successfulAttack(event))return commands;
    for(const reaction of reactions){
      if(reaction.kind!=='clever-fellow'||reaction.chanceThreshold<=0)continue;
      if(succeeds(reaction.chanceThreshold,ports.random))commands.push({kind:'reset-skill-cooldowns',targetId:event.ownerId});
    }
  }else if(event.kind==='physical-instinct'){
    if(event.damageKind==='physical'&&successfulAttack(event)&&event.chanceThreshold>0){
      const threshold=event.mainHandTwoHanded?Math.trunc(event.chanceThreshold*15/10):event.chanceThreshold;
      if(succeeds(threshold,ports.random))commands.push({kind:'reset-skill-cooldowns',targetId:event.ownerId});
    }
  }else if(event.kind==='physical-flare'){
    // 副手先抽额外阈值、失败再抽一般阈值；两者为 0 也照抽，所以不经过 succeeds 的短路。
    if(event.damageKind==='physical'&&successfulAttack(event)){
      const draw=()=>Math.floor(ports.random()*CHANCE_ROLL_MAX)+1;
      const flares=reactions.filter(reaction=>reaction.kind==='flare');
      // 原版这一段无条件抽样（17c9f8 的普通概率、副手再先抽一次）：没学残影时阈值是 0，
      // 骰子照样消耗，后面的反伤扩散、痛苦火焰与黑暗之怒才会拿到同一序号。
      if(!flares.length){
        if(event.hand==='offhand')draw();
        draw();
        return commands;
      }
      for(const reaction of flares){
        const gained=event.hand==='offhand'
          ?draw()<reaction.offhandChanceThreshold||draw()<reaction.chanceThreshold
          :draw()<reaction.chanceThreshold;
        if(!gained)continue;
        const learned=ports.learnedBuff(event.ownerId,reaction.stealthFromLearnedSkill);
        commands.push({kind:'apply-buff',sourceId:event.ownerId,targetId:event.ownerId,buff:learned??reaction.unlearnedStealth},
          {kind:'play-effect',targetId:event.ownerId,effect:reaction.effect});
      }
    }
  }else if(event.kind==='physical-defense-instinct'){
    // 防御方的物理落空或武器格挡：阈值来自被动写入，非零才抽样，严格小于才触发。
    if(event.damageKind==='physical'&&(event.outcome==='miss'||event.outcome==='weapon-block')&&
      succeeds(event.chanceThreshold,ports.random))commands.push({kind:'reset-skill-cooldowns',targetId:event.ownerId});
  }else if(event.kind==='physical-block'){
    for(const reaction of reactions){
      if(reaction.kind==='shield-of-rage')apply(reaction.buff,event.ownerId);
      // 信念之盾发给固定三槽；具体是哪三个由宿主按队伍状态展开（见 apply-party-buff）。
      else if(reaction.kind==='shield-of-trust')commands.push({kind:'apply-party-buff',sourceId:event.ownerId,buff:reaction.buff});
    }
  }else if(event.kind==='attack-effects'){
    if(!successfulAttack(event))return commands;
    for(const reaction of reactions){
      if(reaction.kind!=='flares-of-pain'||!succeeds(reaction.chanceThreshold,ports.random))continue;
      // The chance is drawn before checking the action or Molten Armor.
      if(event.actionId==='firestorm'||event.hasMoltenArmor)apply(reaction.buff,event.opponentId);
    }
  }else if(event.kind==='molten-reflection-completed'){
    for(const reaction of reactions){
      if(reaction.kind==='flares-of-pain'&&succeeds(reaction.chanceThreshold,ports.random)){
        apply(reaction.buff,event.opponentId);
      }
    }
  }else if(event.kind==='action-stealth-break'){
    for(const reaction of reactions)if(reaction.kind==='dark-sense')apply(reaction.buff,event.ownerId);
  }else if(event.kind==='skill-attack-success'){
    if(!successfulAttack(event))return commands;
    for(const reaction of reactions)if(reaction.kind==='magic-insight')apply(reaction.buff,event.opponentId);
  }else if(event.kind==='direct-heal-accepted'){
    for(const reaction of reactions){
      if(reaction.kind==='ordination-prayer'&&succeeds(reaction.chanceThreshold,ports.random))
        apply(reaction.buff,event.targetId);
    }
  }else if(event.kind==='physical-hit-received'){
    for(const reaction of reactions){
      if(reaction.kind==='wrath-of-darkness'&&succeeds(reaction.chanceThreshold,ports.random)){
        apply(reaction.buff,event.ownerId);
      }
    }
  }else if(event.kind==='blood-revenge'){
    // 没有概率抽样：成功的物理或非盾挡魔法落在同阵营身上，学过的人各叠一层，来源就是自己。
    if(!successfulAttack(event))return commands;
    for(const reaction of reactions)if(reaction.kind==='blood-revenge')apply(reaction.buff,event.ownerId);
  }
  return commands;
}
