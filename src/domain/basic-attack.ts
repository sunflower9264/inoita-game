import type { ActorDefinition, ClipName, CollisionBox, Facing } from './content.ts';
import type { BasicAttackBinding, BattleCatalog, ResolvedBasicAttack } from './battle.ts';

export interface Point { x: number; y: number; }
export type BasicAttackHand=NonNullable<ResolvedBasicAttack['strikes']>[number]['hand'];

/** 四种朝向的固定顺序，用于遍历四向动画。 */
export const FACINGS: readonly Facing[] = ['north', 'south', 'east', 'west'];

/**
 * 把源动画展开成逻辑帧序列：条目是素材帧号，下标是逻辑帧序号。
 * 周期比素材短就截取，比素材长就重复引用末帧。序列要覆盖整个周期，
 * 因为出手、命中这类事件按逻辑帧号触发，可能落在素材之外（弓在第 10 帧发箭，素材正好 10 帧）。
 */
export function attackSequence(sourceFrameCount: number, cycleFrames: number): number[] {
  if (!Number.isInteger(sourceFrameCount) || sourceFrameCount <= 0) throw new Error(`普攻源动画帧数无效：${sourceFrameCount}`);
  if (!Number.isInteger(cycleFrames) || cycleFrames <= 0) throw new Error(`普攻周期帧数无效：${cycleFrames}`);
  return Array.from({ length: cycleFrames }, (_, index) => Math.min(index, sourceFrameCount - 1));
}

/**
 * 素材播完后该画待机的哪一帧。原版 `CHAR_Draw @0x173e84` 在动作计数达到当前动作的源帧数时
 * 不再画这个动作，而是选出待机动作、按 `计数 % 待机源帧数` 取帧绘制
 * （选动作在 `0x173ec8..0x173f40`，取模在 `0x173fac..0x173fc0`）。
 * 返回 null 表示计数还在素材范围内，照常画当前动作。
 */
export function idlePoseFrame(index: number, sourceFrameCount: number, idleFrameCount: number): number | null {
  if (!Number.isInteger(idleFrameCount) || idleFrameCount <= 0) return null;
  return index < sourceFrameCount ? null : index % idleFrameCount;
}

/** 该逻辑帧上发生哪些普攻事件；表现层按动作的 swingOrder 排序。 */
export function basicAttackEvents(attack: Pick<ResolvedBasicAttack, 'swingFrame' | 'strikeFrame' | 'strikes'>, index: number): { swing: boolean; strike: boolean } {
  return { swing: attack.swingFrame === index, strike: basicAttackStrikesAtFrame(attack,index).length>0 };
}

/** 出手次序独立于动作周期；当前攻速可能使动作在下一次出手前完成。 */
export function basicAttackStrikesAtFrame(attack:Pick<ResolvedBasicAttack,'strikeFrame'|'strikes'>,index:number):BasicAttackHand[] {
  return attack.strikes?attack.strikes.filter(strike=>strike.frame===index).map(strike=>strike.hand):
    attack.strikeFrame===index?['main-hand']:[];
}

/**
 * 解析一名角色的普攻：规则按绑定取配置，动画按绑定取角色素材，
 * 逻辑帧序列按每个方向的源动画帧数展开。控制器、表现层和资源收集共用这一份结果。
 * `cycleFrames` 可覆盖普通攻击周期；固定动画始终使用配置的完整素材帧数。
 */
export function resolveBasicAttack(catalog: Pick<BattleCatalog,'basicAttacks'>, character: { actor: ActorDefinition; basicAttack: BasicAttackBinding | null }, cycleFrames?: number): ResolvedBasicAttack {
  if (!character.basicAttack) throw new Error(`角色没有普攻：${character.actor.id}`);
  const { profileId, clips } = character.basicAttack;
  const definition = catalog.basicAttacks[profileId];
  if (!definition) throw new Error(`普攻规则缺失：${profileId}`);
  const configured = definition.timing==='fixed-animation'?definition.cycleFrames:cycleFrames??definition.cycleFrames;
  const effectiveCycleFrames = Math.max(configured, definition.strikeFrame + 1);
  const resolvedClips = {} as Record<Facing, ClipName>;
  const sequence = {} as Record<Facing, number[]>;
  for (const facing of FACINGS) {
    const name = clips[facing];
    if (!name) throw new Error(`普攻动画绑定缺失：${facing}`);
    const clip = character.actor.clips[name];
    if (!clip) throw new Error(`普攻动画缺失：${name}`);
    if (!Number.isInteger(clip.frames) || clip.frames <= 0) throw new Error(`普攻源动画帧数无效：${name}`);
    if(definition.timing==='fixed-animation'&&clip.frames!==effectiveCycleFrames)
      throw new Error(`固定普攻周期与素材帧数不匹配：${name}`);
    resolvedClips[facing] = name;
    sequence[facing] = attackSequence(clip.frames, effectiveCycleFrames);
  }
  return { ...definition, effectiveCycleFrames, clips: resolvedClips, sequence };
}

/** 选敌使用的整数近似距离；用于选敌和投射物到达判断。 */
export function targetDistance(a: Point, b: Point): number {
  const x = Math.abs(Math.trunc(a.x) - Math.trunc(b.x)), y = Math.abs(Math.trunc(a.y) - Math.trunc(b.y));
  const small = Math.min(x, y);
  return x + y - Math.floor(small / 4) - Math.floor(small / 2) + Math.floor(small / 8);
}

export function targetScore(from: Point, to: Point, facing: Facing, radius: number): number {
  const distance = targetDistance(from, to);
  if (distance > radius) return 0;
  const dx = to.x - from.x, dy = to.y - from.y;
  const forward = facing === 'south' ? dy : facing === 'north' ? -dy : facing === 'east' ? dx : -dx;
  const side = facing === 'south' || facing === 'north' ? dx : dy;
  return radius - distance + (forward > 0 ? Math.abs(forward) > Math.abs(side) ? 8 : 4 : 0);
}

export function attackDistance(a: Point, box: CollisionBox, b: Point, target: CollisionBox): number {
  const dx = Math.max(0, Math.trunc(a.x)+box.x - Math.trunc(b.x)-target.x-target.width,
    Math.trunc(b.x)+target.x - Math.trunc(a.x)-box.x-box.width);
  const dy = Math.max(0, Math.trunc(a.y)+box.y - Math.trunc(b.y)-target.y-target.height,
    Math.trunc(b.y)+target.y - Math.trunc(a.y)-box.y-box.height);
  return Math.floor(dx / 8) + Math.floor(dy / 8) + 2;
}

export function faceTarget(from: Point, to: Point): Facing {
  const x = to.x-from.x, y = to.y-from.y;
  return Math.abs(x) > Math.abs(y) ? x < 0 ? 'west' : 'east' : y < 0 ? 'north' : 'south';
}

/** 投射物使用十六个方向的素材；零度朝右。 */
export function projectileHeading(from: Point, to: Point): number {
  const x=to.x-from.x, y=to.y-from.y;
  const slope=x ? Math.abs(Math.trunc(y*100/x)) : Infinity;
  const angle=slope<21?0:slope<68?23:slope<151?45:slope<504?68:90;
  return x>=0 ? y>=0?angle:(360-angle)%360 : y>=0?180-angle:180+angle;
}

/** 原版投射物前进一步；目标可在每一步重新查询。 */
export function projectileStep(start: Point, target: Point, step: number): { position: Point; arrived: boolean } {
  if (!Number.isFinite(step) || step <= 0) throw new Error('投射物步长必须大于零');
  const x=Math.trunc(start.x),y=Math.trunc(start.y);
  const end={x:Math.trunc(target.x),y:Math.trunc(target.y)};
  if (targetDistance({x,y},end)<step) return {position:end,arrived:true};
  const dx=end.x-x,dy=end.y-y;
  let mx=0,my=0;
  if (!dx) my=Math.sign(dy)*step;
  else if (!dy) mx=Math.sign(dx)*step;
  else if (Math.abs(dx)>Math.abs(dy)) {
    mx=Math.trunc(dx*dx*step*Math.sign(dx)/(dx*dx+dy*dy));
    my=dy+Math.trunc((-dx+mx)*Math.trunc(dy*100/dx)/100);
  } else {
    my=Math.trunc(dy*dy*step*Math.sign(dy)/(dx*dx+dy*dy));
    mx=dx+Math.trunc((-dy+my)*Math.trunc(dx*100/dy)/100);
  }
  return {position:{x:x+mx,y:y+my},arrived:false};
}
