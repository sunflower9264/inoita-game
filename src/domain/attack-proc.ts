import {MAX_SKILL_TARGETS} from './skill-unit-sequence.ts';

/** 单次攻击的附加效果链最多执行 4096 个阶段，避免配置错误造成死循环。 */
const MAX_ATTACK_PROC_STAGES = 4096;

export type AttackProcChanceKey='windStrikeChance'|'fireSplashChance'|'frostStrikeChance'|
  'divineStrikeChance'|'darknessStrikeChance'|'poisonStrikeChance';
type AttackProcBuffKey='attack-stun'|'attack-slow'|'divine-defense-break'|'darkness-strike-impact'|'poisoned';

export interface AttackProcPort {
  readChance(key:AttackProcChanceKey):number;
  applyDamage(amount:number):void;
  applyBuff(key:AttackProcBuffKey):void;
  /** Resolve every collected target before returning its count, including targets that reject damage. */
  fireSplash(amount:number):number;
  random?:()=>number;
}
interface AttackProcResult {
  status:'completed'|'budget-exhausted'|'reentrant';
  stagesExecuted:number;
}

type Stage=
  | {chance:AttackProcChanceKey;kind:'damage';damageRate:number;buff:AttackProcBuffKey}
  | {chance:AttackProcChanceKey;kind:'fire';damageRate:number}
  | {chance:AttackProcChanceKey;kind:'buff';buff:AttackProcBuffKey};
const stages:readonly Stage[]=[
  {chance:'windStrikeChance',kind:'damage',damageRate:700,buff:'attack-stun'},
  {chance:'fireSplashChance',kind:'fire',damageRate:500},
  {chance:'frostStrikeChance',kind:'damage',damageRate:700,buff:'attack-slow'},
  {chance:'divineStrikeChance',kind:'damage',damageRate:700,buff:'divine-defense-break'},
  {chance:'darknessStrikeChance',kind:'damage',damageRate:3000,buff:'darkness-strike-impact'},
  {chance:'poisonStrikeChance',kind:'buff',buff:'poisoned'},
];

/** One executor spans a world's synchronous damage chain. Callbacks settle before the next chance is read. */
export class AttackProcExecutor {
  private running=false;

  execute(normalDamage:number,port:AttackProcPort,budget=MAX_ATTACK_PROC_STAGES):AttackProcResult {
    if(this.running)return {status:'reentrant',stagesExecuted:0};
    if(!Number.isSafeInteger(budget)||budget<0)throw new RangeError('Attack proc budget must be a nonnegative integer');
    this.running=true;
    let index=0,stagesExecuted=0;
    const random=port.random??Math.random;
    try {
      while(index<stages.length){
        if(stagesExecuted===budget)return {status:'budget-exhausted',stagesExecuted};
        const stage=stages[index]!;
        stagesExecuted++;
        const chance=port.readChance(stage.chance);
        if(chance<=0||Math.floor(random()*999)+1>=chance){index++;continue;}
        if(stage.kind==='fire'){
          const count=port.fireSplash(Math.trunc(normalDamage*stage.damageRate/1000));
          if(!Number.isInteger(count)||count<0||count>MAX_SKILL_TARGETS)throw new RangeError(`Fire splash target count must be between 0 and ${MAX_SKILL_TARGETS}`);
          // The collected count determines the next stage; an empty splash retries fire.
          index=count+1;
        }else{
          if(stage.kind==='damage')port.applyDamage(Math.trunc(normalDamage*stage.damageRate/1000));
          port.applyBuff(stage.buff);
          index++;
        }
      }
      return {status:'completed',stagesExecuted};
    } finally {
      this.running=false;
    }
  }
}
