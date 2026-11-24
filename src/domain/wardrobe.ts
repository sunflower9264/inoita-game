import type { ClipName, Facing } from './content.ts';
import type { EquipmentSlot, ItemCatalog } from './items.ts';
import type { BasicAttackDefinition, SkillAction } from './battle.ts';
import { skillClips } from './skill-action.ts';

export interface CostumePiece {
  texture: string; x: number; y: number; width: number; height: number; anchorX: number; anchorY: number;
}
export interface CostumePart {
  part: string; piece: number; x: number; y: number; scaleX: number; scaleY: number; angle: number; alpha: number;
}
export interface CostumePose { mirrorX: boolean; frameRate: number; frames: CostumePart[][] }
export interface WardrobeCatalog {
  defaultShield?:boolean;
  companions?:Record<string,{variants:Record<string,string>;fixedParts:string[]}>;
  attacks: Record<string,BasicAttackDefinition>;
  frenzyWaitFrames?:Record<string,number>;
  frenzyAttacks?:Record<string,BasicAttackDefinition & {clips:Record<Facing,ClipName>}>;
  dualWieldAttacks?:Record<string,BasicAttackDefinition & {clips:Record<Facing,ClipName>}>;
  skills: Record<string,Partial<Record<ClipName,string>>>;
  skillStances: Record<string,Record<string,{poses:Partial<Record<ClipName,string>>;actions:Record<string,SkillAction|null>}>>;
  textures: {key:string;file:string}[];
  sprites: Record<string,CostumePiece>;
  variants: Record<string,(string|null)[]>;
  defaults: Record<string,string>;
  equipment: Record<string,{main:Record<string,string>;offHand:Record<string,string>}>;
  poses: Record<string,CostumePose>;
  stances: Record<string,Partial<Record<ClipName,string>>>;
  /** 与武器架势无关的共用姿态（如战斗阵亡 die）；按需读取，不自动混入默认战斗外观合成列表。 */
  sharedPoses?: Partial<Record<ClipName,string>>;
}
export function sharedWardrobePoses(catalog: WardrobeCatalog): Partial<Record<ClipName,string>> {
  return catalog.sharedPoses ? { ...catalog.sharedPoses } : {};
}
export function wardrobePoseRelativeFile(id: string): string {
  return `wardrobe/poses/${encodeURIComponent(id)}.json`;
}
export function wardrobePoseFile(id: string): string {
  return `content/${wardrobePoseRelativeFile(id)}`;
}
/** 只认真实副手物品的盾牌类别；`defaultShield` 表示这名角色的原始外观本身带盾。 */
export function hasOffhandShield(items:ItemCatalog,equipment:Partial<Record<EquipmentSlot,string>>,defaultShield=false):boolean {
  const offhand=equipment['off-hand'];
  return offhand!==undefined?items.items[offhand]?.kind==='shield':defaultShield;
}
/** 所有可换装角色在城镇共用的四向站立和行走动作。 */
export function townMovementPoses(catalog: WardrobeCatalog): Partial<Record<ClipName,string>> {
  const poses: Partial<Record<ClipName,string>> = {};
  for (const movement of ['idle','walk'] as const) for (const facing of ['south','west','north','east'] as const) {
    const name = `${movement}-${facing}` as const;
    const id = catalog.stances['unarmed:empty']?.[name];
    if (!id) throw new Error(`城镇动作缺失：${name}`);
    poses[name] = id;
  }
  return poses;
}
export function costumeRecipe(catalog: WardrobeCatalog, items: ItemCatalog, equipment: Partial<Record<EquipmentSlot,string>>, classId?:string,appearanceId?:string,learnedSkills?:ReadonlySet<string>,townPose=false) {
  const companion=appearanceId?catalog.companions?.[appearanceId]:undefined;
  const variants={...catalog.defaults,...companion?.variants};
  for(const [slot,id]of Object.entries(equipment)) {
    const appearance=catalog.equipment[id!];
    if(!appearance)throw new Error(`装备外观缺失：${id}`);
    const rule=items.items[id!].equipment!;
    for(const [part,variant]of Object.entries(slot==='off-hand'&&rule.dualWield?appearance.offHand:appearance.main))
      if(!companion?.fixedParts.includes(part))variants[part]=variant;
  }
  const main=equipment['main-hand']?items.items[equipment['main-hand']].kind:'unarmed';
  const off=equipment['off-hand']?items.items[equipment['off-hand']].kind:'empty';
  const weaponPoses=catalog.stances[`${main}:${off}`];
  const townPoses=townPose?townMovementPoses(catalog):{};
  const poses=weaponPoses?{...weaponPoses,...townPoses}:undefined;
  if(!poses)throw new Error('这组武器缺少人物动作');
  const skills=classId?catalog.skillStances[classId]?.[`${main}:${off}`]:undefined;
  // 只合成已学技能的姿态；未学技能不参与外观，学会后再补。姿态动作全部保留，
  // 因为 attack-2/3、frenzy 等名字不一定和 actor 的 clip 列表一一对应。
  const learnedPoses=learnedSkills?new Set<string>([...learnedSkills].flatMap(id=>Object.values(skillClips(id)))):undefined;
  const keepPose=(name:string)=>!learnedPoses||!name.startsWith('skill-')||learnedPoses.has(name);
  const classPoses=classId?catalog.skills[classId]:undefined;
  const filteredClassPoses=classPoses&&learnedPoses
    ?Object.fromEntries(Object.entries(classPoses).filter(([name])=>keepPose(name))) as Partial<Record<ClipName,string>>
    :classPoses;
  const filteredStancePoses=skills&&learnedPoses
    ?Object.fromEntries(Object.entries(skills.poses).filter(([name])=>keepPose(name))) as Partial<Record<ClipName,string>>
    :skills?.poses;
  return {variants,poses:classId?{...poses,...filteredClassPoses,...filteredStancePoses}:poses,
    actions:skills?.actions??{},attack:catalog.attacks[`${main}:${off}`],dualWieldAttack:catalog.dualWieldAttacks?.[`${main}:${off}`],frenzyAttack:catalog.frenzyAttacks?.[`${main}:${off}`],frenzyWaitFrames:catalog.frenzyWaitFrames?.[`${main}:${off}`]};
}
