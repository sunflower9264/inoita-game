import type { ClipName, Facing } from './content.ts';
import type { EquipmentSlot, ItemCatalog } from './items.ts';
import type { BasicAttackDefinition, SkillAction } from './battle.ts';

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
export function costumeRecipe(catalog: WardrobeCatalog, items: ItemCatalog, equipment: Partial<Record<EquipmentSlot,string>>, classId?:string,appearanceId?:string) {
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
  const poses=catalog.stances[`${main}:${off}`];
  if(!poses)throw new Error('这组武器缺少人物动作');
  const skills=classId?catalog.skillStances[classId]?.[`${main}:${off}`]:undefined;
  return {variants,poses:classId?{...poses,...catalog.skills[classId],...skills?.poses}:poses,
    actions:skills?.actions??{},attack:catalog.attacks[`${main}:${off}`],dualWieldAttack:catalog.dualWieldAttacks?.[`${main}:${off}`],frenzyAttack:catalog.frenzyAttacks?.[`${main}:${off}`],frenzyWaitFrames:catalog.frenzyWaitFrames?.[`${main}:${off}`]};
}
