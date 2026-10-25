import Phaser from 'phaser';
import type { CharacterVisual } from './characters.ts';
import { statusColorMatrix, type StatusColor } from '../domain/status-color.ts';

/** 每个角色独立着色；动画换贴图后为新图层重新挂上同一颜色规则。 */
export class StatusColorRenderer {
  private filters=new WeakMap<Phaser.GameObjects.Sprite,Phaser.Filters.ColorMatrix>();
  private appearances=new WeakMap<CharacterVisual,{colors:readonly StatusColor[]|undefined;frame:number;layers:readonly Phaser.GameObjects.Sprite[]}>();
  private flashes=new WeakSet<CharacterVisual>();
  flash(character:CharacterVisual,scene:Phaser.Scene):void {
    if(this.flashes.has(character))return;
    this.flashes.add(character);
    const appearance=this.appearances.get(character);
    this.paint(character,appearance?.colors,appearance?.frame??0);
    scene.game.events.once(Phaser.Core.Events.POST_RENDER,()=>{
      this.flashes.delete(character);
      if(!character.container.active)return;
      const current=this.appearances.get(character);
      this.paint(character,current?.colors,current?.frame??0);
    });
  }
  paint(character:CharacterVisual,colors:readonly StatusColor[]|undefined,logicalFrame:number):void {
    const previous=this.appearances.get(character),flash=this.flashes.has(character);
    // 着色规则、逻辑帧和图层批次都没变时不必重设 color matrix；换动作会换新图层数组。
    if(previous&&!flash&&previous.colors===colors&&previous.frame===logicalFrame&&previous.layers===character.layers)return;
    this.appearances.set(character,{colors,frame:logicalFrame,layers:character.layers});
    for(const sprite of character.layers){
      let filter=this.filters.get(sprite);
      if(!colors?.length&&!flash){filter?.setActive(false);continue;}
      if(!filter){
        sprite.enableFilters();
        filter=sprite.filters?.internal.addColorMatrix();
        if(!filter)continue;
        this.filters.set(sprite,filter);
      }
      const blackBackdrop=sprite.blendMode===Phaser.BlendModes.ADD||sprite.blendMode===Phaser.BlendModes.SCREEN;
      filter.colorMatrix.set(statusColorMatrix(colors?.length?colors:[{red:0,green:0,blue:0}],logicalFrame,flash,
        blackBackdrop));
      filter.setActive(true);
    }
  }
}
