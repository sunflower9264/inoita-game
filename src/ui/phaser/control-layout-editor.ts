import Phaser from 'phaser';
import { UI_EVENTS } from '../../application/ui-events.ts';
import type { ControlSkin } from '../../domain/control-skin.ts';
import { CONTROL_IDS, normalizeControlPosition, resolveControlLayout, type ControlId, type ControlPoint } from '../control-layout.ts';
import type { ControlLayoutPreferences } from '../control-layout.ts';
import type { ShortcutSlot } from './action-controls.ts';
import { controlViewport } from './control-layout-viewport.ts';
import { UiSurface } from './widgets.ts';

/** 编辑的是独立预览；实际战斗控件继续由菜单锁暂停。 */
export class ControlLayoutEditor {
  private readonly canvas: UiSurface;
  private readonly toolbar: UiSurface;
  private readonly controls = new Map<ControlId, Phaser.GameObjects.Container>();
  private readonly drags = new Map<ControlId, {pointer: Phaser.Input.Pointer; point?: ControlPoint}>();
  private active = false;
  private viewportKey = '';
  private readonly unsubscribe: () => void;
  private readonly scene: Phaser.Scene;
  private readonly preferences: ControlLayoutPreferences;
  private readonly skin: ControlSkin;
  constructor(scene: Phaser.Scene, preferences: ControlLayoutPreferences,
    skin: ControlSkin, assets: Record<string,string>, close: () => void) {
    this.scene=scene;this.preferences=preferences;this.skin=skin;
    this.canvas = new UiSurface(scene,960,640,350);
    this.toolbar = new UiSurface(scene,960,640,390);
    this.toolbar.enabled = () => this.active && this.toolbar.root.visible;
    this.toolbar.button('',12,12,51,51,close,{image:assets.close,pressed:assets['close-pressed']}).setData('label','关闭操作设置');
    this.toolbar.button('恢复默认',0,12,220,66,() => {this.cancel();this.preferences.reset();});
    this.unsubscribe = preferences.subscribe(() => this.layout());
    scene.game.events.on(UI_EVENTS.cancelInput,this.cancel,this);
    scene.input.on('pointerupoutside',this.cancel,this);
    scene.input.on('gameout',this.cancel,this);
    this.visible(false);
  }
  open(slots: readonly ShortcutSlot[]): void {
    this.cancel();this.canvas.clear();this.controls.clear();this.active=true;
    for (const id of CONTROL_IDS) {
      const object=this.scene.add.container(0,0).setData('uiAction',true).setData('controlId',id);
      this.canvas.root.add(object);this.controls.set(id,object);
      let width=94,height=94;
      const image=(file:string,w:number,h=w,x=-w/2,y=-h/2)=>this.canvas.image(file,x,y,w,h,object);
      if(id==='move') {width=height=210;image(this.skin['stick-base'],210);image(this.skin.button,70);}
      else if(id==='attack') {width=159;height=160;image(this.skin.button,width,height);}
      else if(id==='swap') {width=height=75;image(this.skin.swap,75);}
      else {
        image(this.skin['slot-shadow'],94);image(this.skin['slot-ring'],94);
        const slot=slots[Number(id.slice(5))],isItem=slot?.entry?.kind==='item',size=isItem?64:75;
        if(slot?.entry&&slot.icon)image(slot.icon,size);
        const cooldown=slot?.cooldown;
        if(cooldown&&cooldown.durationMs>0&&cooldown.remainingMs>0) {
          const progress=Phaser.Math.Clamp(1-cooldown.remainingMs/cooldown.durationMs,0,1);
          const fan=this.scene.add.graphics();object.add(fan);
          fan.fillStyle(0x000000,.45).slice(0,0,size/2,-Math.PI/2+progress*Math.PI*2,Math.PI*1.5,false).fillPath();
        }
        if(isItem) {
          image(this.skin['quantity-badge'],38,40,13,3);
          const quantity=this.canvas.text(String(slot!.quantity),32,23,0,18,'#ffffff',object).setOrigin(.5);
          quantity.setScale(Math.min(1,30/Math.max(1,quantity.width),30/Math.max(1,quantity.height)));
        }
      }
      // Container 的输入坐标会补上半宽、半高，命中区以图片左上角为原点。
      object.setSize(width,height).setInteractive(new Phaser.Geom.Rectangle(0,0,width,height),
        (area:Phaser.Geom.Rectangle,x:number,y:number)=>this.active&&this.canvas.root.visible&&Phaser.Geom.Rectangle.Contains(area,x,y));
      this.scene.input.setDraggable(object);
      object.on('dragstart',(pointer:Phaser.Input.Pointer)=>{
        if(this.active&&this.canvas.root.visible&&!this.drags.has(id))this.drags.set(id,{pointer});
      });
      object.on('drag',(pointer:Phaser.Input.Pointer,x:number,y:number)=>{
        const drag=this.drags.get(id);if(!drag||drag.pointer.id!==pointer.id)return;
        const viewport=controlViewport(this.scene),positions=this.preferences.snapshot();
        drag.point=normalizeControlPosition(viewport,id,{x,y},positions);
        const position=resolveControlLayout(viewport,{...positions,[id]:drag.point})[id];
        object.setPosition(position.x,position.y);
      });
      object.on('dragend',(pointer:Phaser.Input.Pointer)=>{
        const drag=this.drags.get(id);if(!drag||drag.pointer.id!==pointer.id)return;
        this.drags.delete(id);
        if(drag.point&&this.active&&this.canvas.root.visible)this.preferences.set(id,drag.point);
        else this.layout();
      });
    }
    this.visible(true);this.layout();
  }
  layout(): void {
    const viewport=controlViewport(this.scene),key=JSON.stringify(viewport);
    if(key!==this.viewportKey) {this.viewportKey=key;this.cancelDrags();}
    const positions=resolveControlLayout(viewport,this.preferences.snapshot());
    for(const [id,object]of this.controls) {
      if(this.drags.has(id))continue;
      const point=positions[id];object.setPosition(point.x,point.y).setScale(point.scale);
    }
    const {insets,width}=viewport,scale=positions.attack.scale;
    this.toolbar.root.setPosition(insets.left,insets.top).setScale(scale);
    (this.toolbar.root.list[1] as Phaser.GameObjects.Container).setPosition((width-insets.left-insets.right)/scale/2-110,12);
  }
  visible(value: boolean): void {
    if(!value)this.cancel();
    this.canvas.visible(value&&this.active);this.toolbar.visible(value&&this.active);
  }
  key(event: KeyboardEvent): void {this.toolbar.key(event);}
  private cancelDrags(): void {
    for(const [id,drag] of this.drags) {
      // disableInteractive 清掉 Phaser 的对象拖动状态和指针拖动列表，再恢复原命中区。
      const object=this.controls.get(id);object?.disableInteractive();object?.setInteractive();
      this.scene.input.setDragState(drag.pointer,0);
    }
    this.drags.clear();
  }
  private cancel(): void {this.cancelDrags();this.layout();}
  close(): void {this.active=false;this.visible(false);}
  destroy(): void {
    this.close();this.unsubscribe();
    this.scene.game.events.off(UI_EVENTS.cancelInput,this.cancel,this);
    this.scene.input.off('pointerupoutside',this.cancel,this);this.scene.input.off('gameout',this.cancel,this);
    this.canvas.destroy();this.toolbar.destroy();this.controls.clear();
  }
}
