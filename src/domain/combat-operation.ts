import type { CombatOperation } from './battle.ts';

/** 整数除法向零截断，与原版整数运算一致。 */
export interface AttributeModifier { attribute:string; operation:CombatOperation }

/** 按顺序叠加同一条属性的常驻修正；战斗和面板共用这一份运算顺序。 */
export function applyAttributeModifiers(attribute:string,base:number,modifiers:readonly AttributeModifier[]):number {
  let value=base;
  for(const modifier of modifiers)if(modifier.attribute===attribute)value=applyCombatOperation(value,modifier.operation);
  return value;
}

export function applyCombatOperation(current:number,operation:CombatOperation):number {
  switch(operation.kind){
    case 'keep':return current;
    case 'set':return operation.amount;
    case 'add':return current+operation.amount;
    case 'subtract':return current-operation.amount;
    case 'multiply':return current*operation.factor;
    case 'divide':return operation.divisor?Math.trunc(current/operation.divisor):0;
    case 'multiply-thousandth':return Math.trunc(current*operation.ratePerThousand/1000);
    case 'increase-thousandth':return Math.trunc(current*(1000+operation.ratePerThousand)/1000);
    case 'decrease-thousandth':return Math.trunc(current*(1000-operation.ratePerThousand)/1000);
  }
}
