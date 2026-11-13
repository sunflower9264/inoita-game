import type Phaser from 'phaser';
import type { ActorDefinition } from '../../domain/content.ts';
import type { CharacterVisual } from '../../rendering/characters.ts';
import { characterFrameList } from '../../rendering/character-atlas.ts';
import type { UiSurface } from '../dom/surface.ts';
import { screenRectToCanvas } from '../viewport.ts';

export interface PreviewRect { x:number; y:number; width:number; height:number }

/** 菜单人物使用共享的角色纹理和待机动画，位置跟随 DOM 内容区。 */
export class LiveCharacterPreview {
  private readonly scene:Phaser.Scene;
  private readonly hole:(rect?:PreviewRect)=>void;
  private readonly create:(actor:ActorDefinition)=>CharacterVisual;
  private readonly backgroundAlpha:number|null;
  private visual?:CharacterVisual;
  private background?:Phaser.GameObjects.Rectangle;
  private target?:{surface:UiSurface;rect:PreviewRect};
  private shown=true;
  constructor(scene:Phaser.Scene,hole:(rect?:PreviewRect)=>void,create:(actor:ActorDefinition)=>CharacterVisual,backgroundAlpha:number|null=.65){this.scene=scene;this.hole=hole;this.create=create;this.backgroundAlpha=backgroundAlpha;}
  static available(scene:Phaser.Scene,actor:ActorDefinition):boolean{
    const clip=actor.clips['idle-south'];
    if(!scene.add||!scene.textures||!clip||clip.layers.length===0)return false;
    // 有文件的图层必须由角色图集页承载；只有动态外观（file 为空）才看图层键。
    return clip.layers.every(layer=>{
      if(!layer.file)return scene.textures.exists(layer.key);
      const frames=characterFrameList(layer.file,clip.frames);
      return frames.length===clip.frames&&frames.every(frame=>scene.textures.exists(frame.key));
    });
  }
  show(surface:UiSurface,actor:ActorDefinition,rect:PreviewRect):void{
    if(this.visual?.actor!==actor){
      this.visual?.container.destroy();
      this.visual=this.create(actor);
      this.visual.container.setDepth(2).setScrollFactor(0);
    }
    if(this.backgroundAlpha!==null)this.background??=this.scene.add.rectangle(0,0,1,1,0,this.backgroundAlpha).setOrigin(0).setScrollFactor(0).setDepth(1);
    this.target={surface,rect};this.visual.container.setVisible(this.shown);this.background?.setVisible(this.shown);this.layout();
  }
  visible(value:boolean):void{this.shown=value;this.visual?.container.setVisible(value&&!!this.target);this.background?.setVisible(value&&!!this.target);if(value)this.layout();else this.hole();}
  layout():void{
    if(!this.shown||!this.target||!this.visual)return;
    const {surface,rect}=this.target,matrix=surface.root.getWorldTransformMatrix(),point=matrix.transformPoint(rect.x,rect.y);
    const screenBox={x:point.x,y:point.y,width:rect.width*matrix.scaleX,height:rect.height*matrix.scaleY};
    const box=screenRectToCanvas(this.scene,screenBox);
    const clip=this.visual.actor.clips['idle-south']!,scale=Math.min(box.width/clip.frameWidth,box.height/clip.frameHeight);
    const left=box.x+(box.width-clip.frameWidth*scale)/2,top=box.y+(box.height-clip.frameHeight*scale)/2;
    const originX=clip.mirrorX?1-clip.originX:clip.originX;
    this.visual.container.setScale(scale).setPosition(left+originX*clip.frameWidth*scale,top+clip.originY*clip.frameHeight*scale);
    this.background?.setPosition(box.x,box.y).setSize(box.width,box.height);
    this.hole(screenBox);
  }
  detach():void{this.target=undefined;this.visual?.container.setVisible(false);this.background?.setVisible(false);this.hole();}
  destroy():void{this.detach();this.visual?.container.destroy();this.visual=undefined;this.background?.destroy();this.background=undefined;}
}
