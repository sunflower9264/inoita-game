import type { EnemyPlayableSkill, SkillAction } from './battle.ts';
import type { BattleBuffKey } from './battle-semantics.ts';
import type { CombatQueryCircle } from './combat-spatial-index.ts';
import type { Combatant, CombatPort } from './combat.ts';
import type { Facing } from './content.ts';
import type { GameRectangle, Point } from './navigation.ts';
import type { PartySkillUse } from './party.ts';
import type { PathQuery } from './pathfinding.ts';

/** 队友 AI（策略选择与脱战跟随）共同依赖的宿主边界，避免三者形成导入环。 */
export interface PartyPort extends CombatPort {
  leader(): Combatant | undefined;
  /** 当前操控角色的朝向；跟随站位用它分前后。 */
  leaderFacing?(): Facing;
  /** 上阵槽位：0 左、1 右；主角被 AI 接管时没有槽位。 */
  followSlot?(): 0 | 1 | undefined;
  focusTarget(): string | undefined;
  /** 按脚点圆查询附近候选；结果去重并保持原候选顺序。省略时调用方回退全量扫描。 */
  nearbyCandidates?(circles: readonly CombatQueryCircle[]): Combatant[];
  /** 主操作角色当前的战斗目标；软集火，只影响优先级。 */
  partyTarget?(): string | undefined;
  /** 敌人当前正在打谁；用来找正在攻击玩家/队友的敌人。 */
  targetOf?(actorId: string): string | undefined;
  /** 整个队伍是否已进入战斗：有指派目标，或最近和敌人真实交战过。 */
  inCombat(): boolean;
  navigationBounds(): GameRectangle;
  navigationSnapshot?(): Pick<PathQuery, 'bounds' | 'canStand' | 'canStandXY'>;
  /** 每渲染帧共享的寻路扩展预算；缺省时按单次上限同步搜索（测试与无场景调用）。 */
  pathBudget?: { take(owner: string, limit: number): number };
  followPath(next: () => Point | undefined, speedScale?: number): void;
  followCanStand?(point: Point): boolean;
  followNavigationSnapshot?: PartyPort['navigationSnapshot'];
  /** 长时间没有位移或离得太远时，让宿主把佣兵放到队长身边；无场景调用可省略。 */
  regroup?(): boolean | void;
  skills(): readonly EnemyPlayableSkill[];
  skillUses(id: string): readonly PartySkillUse[];
  isBoss?(id: string): boolean;
  hasBuff?(id: string, buff: BattleBuffKey): boolean;
  ownedSummons?(id: string): readonly (Combatant & { commandAction?: SkillAction })[];
  hasCriticalAlly?(): boolean;
  vitals(id: string): { health: number; maxHealth: number; mana?: number; maxMana?: number } | undefined;
  attacking(id: string): boolean;
  attackRange(id?: string): number;
}
