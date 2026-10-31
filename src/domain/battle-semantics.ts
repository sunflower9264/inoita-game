/** Gameplay concepts used by combat rules and exported battle content. */
export const BATTLE_STAT_KEYS = [
  'criticalRate','criticalResistance','criticalDamageResistance','criticalDamage',
  'physicalAttack','physicalDamageRate','physicalResistanceBonus','magicAttack',
  'magicDamageRate','conditionalMagicDamageRate','magicResistance','evasionBonus',
  'evasionBase','hitBonus','hitBase','defense','defenseRate','weaponBlock',
  'shieldBlock','attackSpeedRate','fireSplashChance','windStrikeChance','frostStrikeChance',
  'divineStrikeChance','darknessStrikeChance','poisonStrikeChance',
  'pendulumStunChance','frostRetaliationChance','healingEnergyChance','zealotRate','instantRecoveryPerThousand','maxHealth',
  'maxMana','skillDamageBonus','healingPowerRate','assassinSwordHitAdjustment',
  'stealthAttackEnabled','stealthDamageRate',
  'summonDurationBonus','moveSpeed','rearPenetrationRate','bestNormalDamage','lifeFeastRate','attackRangeBonusUnits',
  'damageTransferPerThousand',
  'healthRecoveryPerPulse','manaRecoveryPerPulse','manaCostRate','manaCostReductionRate',
  'moltenReflectionPerThousand','weaponBlockCounterStunDuration','sleepImmunity','stunImmunity','stateResistance',
  'threatGenerationRate','threatReductionRate','sightBonusUnits','armorBreakChance',
  'bloodThirstChance','bloodThirstLifeDrainPerThousand','bloodThirstManaRecovery',
  'offhandAttackChance','revengeChance','cooldownResetChance','frenzyAttackChance',
  'defenseCooldownResetChance','deepBreathDurationBonus',
] as const;
export type BattleStatKey = typeof BATTLE_STAT_KEYS[number];

export const BATTLE_STATE_KEYS = ['sleep','stun','immobilized','stealthed','ambush','damage-immune','taunted',
  'potion-sickness','potion-recovery-halved','shortcut-sealed'] as const;
export type BattleStateKey = typeof BATTLE_STATE_KEYS[number];

export const BATTLE_BUFF_KEYS = [
  'dark-strike','phantom-clash','curse-of-screams','demon-s-shield',
  'guardian-of-darkness','molten-armor','blood-curse','pain-overture',
  'spell-redemption','summon-bard','spiritual-blade','poison-touch',
  'whist','blade-deflection','blade-deflection-weaken','energy-bodhi','apostles-of-light',
  'light-command','celestial-armor','holy-sacrifice','aimed-shot',
  'ambush','ambush-recovery','net-shackles','spirit-of-nature','survival-instinct','sniping',
  'shouts-of-threat','armor-penetration','armor-break','weapon-hitback','blood-thirst',
  'storm-of-frenzy','storm-of-frenzy-power','enrage','rampage','attack-stun','attack-slow',
  'divine-defense-break','poisoned','darkness-strike-impact','monster-landshake-stun',
  'monster-strong-stun','monster-hammer-stun','monster-web-fire',
  'monster-haste','monster-sleep','monster-enrage',
  'monster-emergency-recovery','monster-recovery','monster-companion-attack',
  'monster-companion-blessing','monster-blazing-armor','freeze-extreme',
  'fire-offering','critical-hit-stun','blunt-hit-stun',
  'shield-of-rage','shield-of-trust','blood-revenge','bard-of-destruction','deep-breath','ordination-prayer','magic-insight','flares-of-pain','wrath-of-darkness','mana-recovery','dark-sense','revenge-incarnate',
  // 恢复泉水给的五个属性 buff，以及三条状态 buff：无法用药水、药效削弱、快捷栏封印。
  // 状态来源与消费者见 work/findings/257_equipment_attributes_78_82_and_potion_states_2026-10-31.md。
  'story-trap','spring-mana-recovery','spring-health-recovery','spring-mana-cost','spring-power-up','spring-frenzy',
  'spring-potion-sickness','spring-potion-weakened','spring-skill-seal',
] as const;
export type BattleBuffKey = typeof BATTLE_BUFF_KEYS[number];
