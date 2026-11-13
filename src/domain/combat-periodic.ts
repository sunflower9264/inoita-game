import type { BattleBuffEffect, CombatOperation } from './battle.ts';
import type { BattleBuffKey, BattleStatKey } from './battle-semantics.ts';
import type { CombatActorAttributes } from './combat-damage-source.ts';
import { physicalNormalDamage,magicNormalDamage,normalDamageForClass } from './combat-damage-source.ts';
import { applyCombatOperation } from './combat-operation.ts';

/** 魔法诅咒基础量 = 魔攻 + 智力 + 精神×1.2（按百分比换算后向下取整）。 */
const MAGIC_CURSE_MENTALITY_PERCENT=120;
const PERCENT=100;
/** 圣光命令的周期治疗额外加 精神/10。 */
const LIGHT_COMMAND_MENTALITY_HEAL_DIVISOR=10;

export interface PeriodicSource {
  classId:string|null;
  attributes:CombatActorAttributes;
  lifeFeastRate:number;
  attributeValue:(attribute:BattleStatKey)=>number;
}

export interface PeriodicContext {
  buffId:BattleBuffKey;
  stackCount:number;
  source:PeriodicSource|null;
  targetHealingRate:number;
}

type PeriodicCommand =
  | {kind:'damage-target';amount:number}
  /** 恢复命令带表现时，施放者要为每名实际恢复到的角色各播一次。 */
  | {kind:'heal-target'|'heal-source'|'heal-party';amount:number;effect?:string}
  | {kind:'visual';effect:string};

/** 叠层乘操作数，再执行一次运算；百分比增加和除法也遵守相同顺序。 */
function stackedOperation(operation:CombatOperation,count:number):CombatOperation {
  switch(operation.kind){
    case 'keep':return operation;
    case 'set':case 'add':case 'subtract':return {...operation,amount:operation.amount*count};
    case 'multiply':return {...operation,factor:operation.factor*count};
    case 'divide':return {...operation,divisor:operation.divisor*count};
    case 'multiply-thousandth':case 'increase-thousandth':case 'decrease-thousandth':
      return {...operation,ratePerThousand:operation.ratePerThousand*count};
  }
}

function requiredSource(context:PeriodicContext):PeriodicSource {
  if(!context.source)throw new Error(`Periodic buff ${context.buffId} requires its source actor`);
  return context.source;
}

/** 返回按原版顺序执行的命令；来源死亡本身不改变公式，来源对象仍由调用方提供。 */
export function resolvePeriodicEffect(effect:BattleBuffEffect['periodic'][number],context:PeriodicContext):PeriodicCommand[] {
  if(effect.kind==='visual')return [{kind:'visual',effect:effect.effect}];
  if(effect.kind==='fixed-damage')return [{kind:'damage-target',amount:effect.amount*context.stackCount}];
  if(effect.kind==='magic-curse'){
    const source=requiredSource(context),attributes=source.attributes;
    const base=attributes.magicAttack+attributes.primaryAttributes.intelligence+Math.trunc(attributes.primaryAttributes.mentality*MAGIC_CURSE_MENTALITY_PERCENT/PERCENT);
    let amount=Math.trunc(base*effect.ratePerThousand*context.stackCount/1000);
    // 血之盛宴：先取整出血咒基础量，再按倍率整体增幅；正倍率时改为固定三个活动队伍槽各恢复整份。
    if(source.lifeFeastRate>0)amount=Math.trunc(amount*(1000+source.lifeFeastRate)/1000);
    const heal:PeriodicCommand={kind:source.lifeFeastRate>0?'heal-party':'heal-source',amount};
    if(effect.healEffect)heal.effect=effect.healEffect;
    return [heal,{kind:'damage-target',amount}];
  }
  let base:number;
  switch(effect.kind){
    case 'normal-damage':{
      const source=context.source;
      base=source?normalDamageForClass(source.attributes,source.classId):0;
      break;
    }
    case 'attack-damage':{
      const source=requiredSource(context);
      base=effect.source==='physical'?physicalNormalDamage(source.attributes):magicNormalDamage(source.attributes);
      break;
    }
    case 'attribute-damage':base=requiredSource(context).attributeValue(effect.attribute);break;
    case 'healing':{
      const source=requiredSource(context);
      base=Math.trunc(source.attributeValue(effect.attribute)*context.targetHealingRate/1000);
      if(context.buffId==='light-command')base+=Math.trunc(source.attributes.primaryAttributes.mentality/LIGHT_COMMAND_MENTALITY_HEAL_DIVISOR);
      break;
    }
  }
  const amount=applyCombatOperation(base,stackedOperation(effect.operation,context.stackCount));
  return [{kind:effect.kind==='healing'?'heal-target':'damage-target',amount}];
}
