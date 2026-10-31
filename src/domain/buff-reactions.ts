import type {BattleBuffEffect} from './battle.ts';
import type {BattleBuffKey,BattleStatKey,BattleStateKey} from './battle-semantics.ts';
import {ACTIVE_PARTY_SLOT_COUNT} from './party-slots.ts';

export interface BuffReactionBuff {
  key:BattleBuffKey;
  rankPriority:number;
  effect:BattleBuffEffect;
}

/** 当前生效的 Buff 可以创建独立子 Buff、恢复资源，或改变本次命中的仇恨分配。 */
export type BuffReaction=
  | {kind:'physical-avoidance'|'physical-success-party';buff:BuffReactionBuff}
  | {kind:'mana-on-physical-success';amount:number;effect:string}
  | {kind:'weapon-block-counter';buff:BuffReactionBuff}
  | {kind:'weapon-block-stun';state:BattleStateKey;durationAttribute:BattleStatKey}
  | {kind:'physical-success-threat'};

interface BuffReactionContact {
  ownerId:string;
  damageKind:'physical'|'magic';
  outcome:'miss'|'hit'|'critical'|'weapon-block'|'shield-block';
}
export type BuffReactionEvent=BuffReactionContact & (
  /** 防守方判定结果之后、命中反应链之前。 */
  | {kind:'physical-avoidance'}
  /** 攻击方本次物理命中成立之后；miss 不产生该事件，魔法不进入。 */
  | {kind:'physical-success'}
  /** 受击方以武器格挡住一次物理攻击；减益以受击者为来源施加给攻击方。 */
  | {kind:'weapon-block-counter';opponentId:string}
  /** 武器格挡时的反晕，排在武器格挡反制减益之前；时长取受击方自身属性。 */
  | {kind:'weapon-block-stun';opponentId:string}
  /** 攻击方吸血结算之后；宿主按队伍槽顺序提供仍在战斗中的成员。 */
  | {kind:'physical-success-party';partyIds:readonly string[]}
  /** 熔岩反应结束后，按本次物理伤害重新分配被击者的仇恨。 */
  | {kind:'physical-success-threat';opponentId:string;hitDamage:number}
);

interface ApplyBuffCommand {
  kind:'apply-buff';
  sourceId:string;
  targetId:string;
  buff:BuffReactionBuff;
}
type BuffReactionCommand=ApplyBuffCommand
  | {kind:'restore-mana';targetId:string;amount:number}
  | {kind:'play-effect';targetId:string;effect:string}
  | {kind:'redistribute-threat';sourceId:string;targetId:string;damage:number}
  /** 直接施加一个状态；时长取 attributeOwner 身上的该属性（原版状态时长参数）。 */
  | {kind:'apply-state';attributeOwner:string;targetId:string;state:BattleStateKey;durationAttribute:BattleStatKey};

/** 输入只包含当前生效的配置；不查询已学技能、不保留母子节点移除关系。 */
export function resolveBuffReactions(reactions:readonly BuffReaction[],event:Exclude<BuffReactionEvent,{kind:'physical-success-threat'}|{kind:'physical-success'}|{kind:'weapon-block-stun'}>):ApplyBuffCommand[];
export function resolveBuffReactions(reactions:readonly BuffReaction[],event:BuffReactionEvent):BuffReactionCommand[];
export function resolveBuffReactions(reactions:readonly BuffReaction[],event:BuffReactionEvent):BuffReactionCommand[] {
  if(event.damageKind!=='physical')return [];
  if(event.kind==='weapon-block-stun'){
    if(event.outcome!=='weapon-block')return [];
    return reactions.flatMap(reaction=>reaction.kind==='weapon-block-stun'
      ?[{kind:'apply-state' as const,attributeOwner:event.ownerId,targetId:event.opponentId,
         state:reaction.state,durationAttribute:reaction.durationAttribute}]:[]);
  }
  if(event.kind==='weapon-block-counter'){
    if(event.outcome!=='weapon-block')return [];
    return reactions.flatMap(reaction=>reaction.kind==='weapon-block-counter'
      ?[{kind:'apply-buff' as const,sourceId:event.ownerId,targetId:event.opponentId,buff:reaction.buff}]:[]);
  }
  if(event.kind==='physical-success'){
    if(event.outcome==='miss')return [];
    const commands:BuffReactionCommand[]=[];
    for(const reaction of reactions){
      if(reaction.kind!=='mana-on-physical-success')continue;
      commands.push({kind:'restore-mana',targetId:event.ownerId,amount:reaction.amount},
        {kind:'play-effect',targetId:event.ownerId,effect:reaction.effect});
    }
    return commands;
  }
  if(event.kind==='physical-success-threat')return event.outcome==='miss'?[]:
    reactions.filter(reaction=>reaction.kind===event.kind).map(()=>({kind:'redistribute-threat',
      sourceId:event.ownerId,targetId:event.opponentId,damage:event.hitDamage}));
  const targets=event.kind==='physical-avoidance'
    ?['miss','weapon-block','shield-block'].includes(event.outcome)?[event.ownerId]:[]
    :event.outcome!=='miss'?event.partyIds.slice(0,ACTIVE_PARTY_SLOT_COUNT):[];
  return reactions.flatMap(reaction=>
    reaction.kind===event.kind&&'buff' in reaction?targets.map(targetId=>({kind:'apply-buff' as const,sourceId:event.ownerId,
      targetId,buff:reaction.buff})):[]);
}
