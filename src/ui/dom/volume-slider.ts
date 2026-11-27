import { UiNode, type UiPointer, type UiSceneHost } from './node.ts';
import { UI_EVENTS } from '../../application/ui-events.ts';
const clamp=(value:number)=>Math.min(1,Math.max(0,Number.isFinite(value)?value:0));
export class VolumeSlider {
  readonly root:UiNode;readonly label:string;private current:number;
  private readonly fill:UiNode;private readonly knob:UiNode;private readonly width:number;
  private readonly changed:(value:number)=>void;private readonly scene:UiSceneHost;
  private press?:number;
  constructor(scene:UiSceneHost,parent:UiNode,label:string,x:number,y:number,width:number,value:number,onChange:(value:number)=>void,enabled=()=>true){
    this.scene=scene;this.label=label;this.width=width;this.current=clamp(value);this.changed=onChange;
    this.root=new UiNode(scene,parent).setPosition(x,y);
    new UiNode(scene,this.root).setSize(width,10).setOrigin(0,.5).setFillStyle(0x4a3b28);
    this.fill=new UiNode(scene,this.root).setSize(width*this.current,10).setOrigin(0,.5).setFillStyle(0xc9ad78);
    this.knob=new UiNode(scene,this.root).setSize(18,26).setOrigin(.5).setFillStyle(0xf3deb0);
    const zone=new UiNode(scene,this.root).setPosition(-12,-20).setSize(width+24,40).setInteractive(undefined,enabled);
    const apply=(pointer:UiPointer)=>{const m=this.root.getWorldTransformMatrix();this.setValue((pointer.x-m.tx)/(m.scaleX*width));};
    zone.on('pointerdown',(pointer:UiPointer)=>{this.press=pointer.id;apply(pointer);});zone.on('pointermove',(pointer:UiPointer)=>{if(this.press===pointer.id&&enabled())apply(pointer);else this.cancel();});zone.on('pointerup',this.cancel).on('pointerupoutside',this.cancel);
    scene.game?.events?.on(UI_EVENTS.cancelInput,this.cancel);this.apply();
  }
  private cancel=()=>{this.press=undefined;};
  get value():number{return this.current;}
  setValue(value:number):void{const next=clamp(value);if(next===this.current)return;this.current=next;this.apply();this.changed(next);}
  private apply():void{this.fill.setSize(this.width*this.current,10);this.knob.setPosition(this.width*this.current,0);}
  destroy():void{this.scene.game?.events?.off(UI_EVENTS.cancelInput,this.cancel);this.root.destroy();}
}
