import {skillForGrowth,type BattleCatalog,type SkillLoadout,type SkillGrowthProfile} from './battle.ts';
import type { CombatOperation } from './battle.ts';
import type { BattleStatKey } from './battle-semantics.ts';

export interface PassiveModifier { attribute:BattleStatKey;operation:CombatOperation }

/** 原版被动属性按职业技能顺序写入；装备条件读取当前主手类别。 */
export function passiveModifiers(catalog:BattleCatalog,classId:string,loadout:SkillLoadout,weaponKind:string,stealthed=false,growth:SkillGrowthProfile='hero'):PassiveModifier[] {
  const result:PassiveModifier[]=[];
  const character=catalog.classes.find(entry=>entry.id===classId);
  if(!character)return result;
  for(const id of character.skills){
    const skill=skillForGrowth(catalog.skills[id],growth);
    if(!skill.passiveUnits)continue;
    const rank=loadout.levels[id];
    if(!rank)continue;
    for(const unit of skill.passiveUnits){
      const allowed=unit.condition==='always'||
        unit.condition==='stealthed'&&stealthed||
        unit.condition==='weapon-two-handed'&&weaponKind==='two-handed'||
        unit.condition==='weapon-short-or-long-sword'&&['dagger','shortsword','longsword'].includes(weaponKind)||
        unit.condition==='weapon-mace'&&weaponKind==='mace'||
        unit.condition==='weapon-spear'&&weaponKind==='spear';
      if(allowed)result.push({attribute:unit.attribute,operation:unit.ranks[Math.min(unit.ranks.length-1,rank-1)]!});
    }
  }
  return result;
}
