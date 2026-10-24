import type { CharacterVisual } from './characters.ts';

const hidden=new WeakSet<CharacterVisual>();
const originalAlpha=new WeakMap<CharacterVisual['layers'][number],number>();

/** 隐身只影响人物图层；容器上的死亡淡出和头顶状态保持各自的透明度。 */
export function setCharacterStealth(character:CharacterVisual,stealthed:boolean):void {
  if(hidden.has(character)===stealthed)return;
  if(stealthed)hidden.add(character);else hidden.delete(character);
  applyCharacterVisibility(character);
}

/** 动画或装备重建图层时同步当前隐身表现。 */
export function applyCharacterVisibility(character:CharacterVisual):void {
  for(const layer of character.layers){
    if(hidden.has(character)){
      if(!originalAlpha.has(layer)){originalAlpha.set(layer,layer.alpha);layer.setAlpha(layer.alpha*.5);}
    }else{
      const alpha=originalAlpha.get(layer);
      if(alpha!==undefined){layer.setAlpha(alpha);originalAlpha.delete(layer);}
    }
  }
}
