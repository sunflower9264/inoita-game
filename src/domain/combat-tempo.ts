import type { BasicAttackSelection, ResolvedBasicAttack } from './battle.ts';

/** 攻速只调整普攻结束帧；出手帧和每帧时长不变。属性负数按原版读值夹到零。 */
export function attackCycleFrames(baseFrames:number,attackSpeedRate:number,strikeFrame:number):number {
  const adjusted=baseFrames+Math.trunc(baseFrames*(1000-Math.max(0,attackSpeedRate))/1000);
  return Math.max(adjusted,strikeFrame+1);
}

/** 一次已解析普攻在逻辑帧上的完整长度；固定动画不随攻速变化。 */
export function basicAttackFrames(attack:ResolvedBasicAttack,attackSpeedRate:number):number {
  return attack.timing==='fixed-animation'
    ? attack.effectiveCycleFrames
    : attackCycleFrames(attack.cycleFrames,attackSpeedRate,attack.strikeFrame);
}

/** 选中的普攻或“缺少动画时的等待”各占多少逻辑帧；动作推进和节奏锁共用。 */
export function basicSelectionFrames(selection:BasicAttackSelection,attackSpeedRate:number):number {
  return 'kind' in selection ? selection.durationFrames : basicAttackFrames(selection,attackSpeedRate);
}
