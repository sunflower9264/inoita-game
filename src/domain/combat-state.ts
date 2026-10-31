import type { BattleStateKey } from './battle-semantics.ts';

interface CombatStateCapabilities {
  canMove:boolean;
  canAct:boolean;
  canTarget:boolean;
  canReceiveDamage:boolean;
  canAutoApproach:boolean;
  canUseRecoveryItems:boolean;
  canUseSkillShortcuts:boolean;
}

/** 状态限制彼此独立；敌对选取的隐身限制不影响盟友治疗。 */
export function combatStateCapabilities(states:Iterable<BattleStateKey>,hostile=true):CombatStateCapabilities {
  const active=new Set(states);
  const canAct=!active.has('sleep')&&!active.has('stun');
  const canMove=canAct&&!active.has('immobilized');
  return {canAct,canMove,canTarget:!hostile||!active.has('stealthed'),
    canReceiveDamage:!active.has('damage-immune'),canAutoApproach:canMove&&!active.has('ambush'),
    canUseRecoveryItems:!active.has('potion-sickness'),canUseSkillShortcuts:!active.has('shortcut-sealed')};
}
