import { DomCooldown } from '../dom/cooldown.ts';
import type { UiPointer } from '../dom/node.ts';
import { UiNode } from '../dom/node.ts';
import type Phaser from 'phaser';
import { UI_EVENTS } from '../../application/ui-events.ts';
import type { ControlSkin } from '../../domain/control-skin.ts';
import { CONTROL_IDS, CONTROL_SCALE_MIN, CONTROL_SIZES, maxControlScale, normalizeControlPosition,
  resolveControlLayout, type ControlId, type ControlLayoutOverrides, type ControlPlacement, type ControlPoint } from '../control-layout.ts';
import type { ControlLayoutPreferences } from '../control-layout.ts';
import { ITEM_ICON_SIZE, QUANTITY_BADGE, SLOT_ICON_SIZE, type ShortcutSlot } from './action-controls.ts';
import { DPAD_ARROW_OFFSET, DPAD_ARROW_SCALE_NORM, DPAD_BASE_RADIUS, DPAD_RUNE_ALPHA, STICK_KNOB_RADIUS } from './move-stick.ts';
import { controlSettings } from '../../application/control-settings.ts';
import type { DomLabel, DomUi } from '../dom/dom-ui.ts';
import { controlViewport } from './control-layout-viewport.ts';
import { GOLD, UiSurface } from './widgets.ts';

/** 白色选中框离控件边缘的距离（屏幕像素）。 */
const SELECTION_BLEED = 4;
/** 四角把手只做视觉提示，拖动的含义由工具栏的移动/缩放模式决定。 */
const HANDLE_SIZE = 16;
const TOOLBAR_RESET_WIDTH = 220, TOOLBAR_MODE_WIDTH = 120, TOOLBAR_HEIGHT = 66, TOOLBAR_GAP = 12;
type EditMode = 'move' | 'scale';

interface ScaleDrag {
  pointer: UiPointer;
  id: ControlId;
  /** 缩放只改倍率，中心位置沿用拖动前的归一化坐标。 */
  point: ControlPoint;
  center: ControlPoint;
  /** 倍率为 1 时，控件中心到角的距离。 */
  radius: number;
  /** 控件完整留在安全区内允许的最大倍率。 */
  max: number;
}

/** 编辑的是独立预览；实际战斗控件继续由菜单锁暂停。 */
export class ControlLayoutEditor {
  private readonly canvas: UiSurface;
  private readonly toolbar: UiSurface;
  private readonly controls = new Map<ControlId, UiNode>();
  private readonly drags = new Map<ControlId, {pointer: UiPointer; point?: ControlPoint}>();
  private readonly handles: UiNode[] = [];
  private selectionFrame?: UiNode;
  private selected?: ControlId;
  private placements?: Record<ControlId, ControlPlacement>;
  private scaleDrag?: ScaleDrag;
  private preview?: {id: ControlId; point: ControlPoint; scale: number};
  private resetButton?: UiNode;
  private moveButton?: UiNode;
  private scaleButton?: UiNode;
  private mode: EditMode = 'move';
  private slots: readonly ShortcutSlot[] = [];
  private active = false;
  private viewportKey = '';
  private readonly unsubscribe: () => void;
  private readonly scene: Phaser.Scene;
  private readonly preferences: ControlLayoutPreferences;
  private readonly skin: ControlSkin;
  private readonly assets: Record<string,string>;
  private readonly closeEditor: () => void;
  private readonly dom?: Pick<DomUi,'label'>;
  /** 工具栏按钮文字和物品格数量文字的 DOM 标签；底图与命中区仍由 Phaser 画。 */
  private readonly toolbarLabels = new Map<string, DomLabel>();
  private readonly quantityLabels = new Map<ControlId, DomLabel>();
  private quantities: {id:ControlId;text:string;fit:number}[] = [];

  constructor(scene: Phaser.Scene, preferences: ControlLayoutPreferences,
    skin: ControlSkin, assets: Record<string,string>, close: () => void, dom?: Pick<DomUi,'label'>) {
    this.scene=scene;this.preferences=preferences;this.skin=skin;this.assets=assets;this.closeEditor=close;this.dom=dom;
    this.canvas = new UiSurface(scene,960,640,350);
    this.toolbar = new UiSurface(scene,960,640,390);
    this.toolbar.enabled = () => this.active && this.toolbar.root.visible;
    this.paintToolbar();

    this.unsubscribe = preferences.subscribe(() => this.layout());
    scene.game.events.on(UI_EVENTS.cancelInput,this.cancel,this);
    window.addEventListener('blur',this.cancelNative);
    window.addEventListener('pointercancel',this.cancelNative);
    this.visible(false);
  }

  open(slots: readonly ShortcutSlot[]): void {
    this.slots = slots; this.active = true;
    this.selected = undefined; this.preview = undefined; this.scaleDrag = undefined;
    this.mode = 'move'; this.paintToolbar();
    this.rebuild();
    this.visible(true);this.layout();
  }

  layout(): void {
    const viewport=controlViewport(),key=JSON.stringify(viewport);
    if(key!==this.viewportKey) {this.viewportKey=key;this.cancelDrags();}
    const positions=this.resolve(viewport);
    this.placements=positions;
    for(const [id,object]of this.controls) {
      if(this.drags.has(id))continue;
      const point=positions[id];object.setPosition(point.x,point.y).setScale(point.scale*point.userScale);
    }
    const {insets,width}=viewport,scale=positions.attack.scale;
    this.toolbar.root.setPosition(insets.left,insets.top).setScale(scale);
    const center=(width-insets.left-insets.right)/scale/2;
    const rowLeft=center-(TOOLBAR_RESET_WIDTH+TOOLBAR_MODE_WIDTH*2+TOOLBAR_GAP*2)/2;
    this.resetButton?.setPosition(rowLeft,12);
    this.moveButton?.setPosition(rowLeft+TOOLBAR_RESET_WIDTH+TOOLBAR_GAP,12);
    this.scaleButton?.setPosition(rowLeft+TOOLBAR_RESET_WIDTH+TOOLBAR_MODE_WIDTH+TOOLBAR_GAP*2,12);
    this.paintSelection();
    this.placeToolbarText();
    this.placeQuantityText();
  }

  visible(value: boolean): void {
    if(!value)this.cancel();
    this.canvas.visible(value&&this.active);this.toolbar.visible(value&&this.active);
    if(!value)this.drawSelection(undefined);
    this.placeToolbarText();
    this.placeQuantityText();
  }

  /** 预览框与实战一样按移动样式取尺寸：十字键 274，摇杆 210。 */
  private moveSize(): {width: number; height: number} {
    return controlSettings.moveStyle === 'dpad' ? CONTROL_SIZES.moveDpad : CONTROL_SIZES.move;
  }

  key(event: KeyboardEvent): void {this.toolbar.key(event);}

  close(): void {
    this.active=false;this.selected=undefined;this.scaleDrag=undefined;this.preview=undefined;
    this.visible(false);
  }

  destroy(): void {
    this.close();this.unsubscribe();
    this.scene.game.events.off(UI_EVENTS.cancelInput,this.cancel,this);
    window.removeEventListener('blur',this.cancelNative);window.removeEventListener('pointercancel',this.cancelNative);
    this.canvas.destroy();this.toolbar.destroy();this.controls.clear();
    for(const label of this.toolbarLabels.values())label.remove();
    this.toolbarLabels.clear();
    for(const label of this.quantityLabels.values())label.remove();
    this.quantityLabels.clear();
    this.quantities=[];
  }

  private resolve(viewport = controlViewport()): Record<ControlId, ControlPlacement> {
    return resolveControlLayout(viewport,this.previewOverrides(),this.moveSize());
  }

  /** 工具栏一次画出关闭、恢复默认和移动/缩放两个模式钮；选中的模式常驻高亮。 */
  private paintToolbar(): void {
    this.toolbar.clear();
    this.toolbar.button('',12,12,67,67,this.closeEditor,{image:this.assets.close,pressed:this.assets['close-pressed']}).setData('label','关闭控件位置');
    this.resetButton=this.toolbar.button('',0,12,TOOLBAR_RESET_WIDTH,TOOLBAR_HEIGHT,
      ()=>{this.cancel();this.preferences.reset();}).setData('label','恢复默认');
    this.moveButton=this.toolbar.button('',0,12,TOOLBAR_MODE_WIDTH,TOOLBAR_HEIGHT,
      ()=>this.setMode('move'),{selected:this.mode==='move'}).setData('label','移动');
    this.scaleButton=this.toolbar.button('',0,12,TOOLBAR_MODE_WIDTH,TOOLBAR_HEIGHT,
      ()=>this.setMode('scale'),{selected:this.mode==='scale'}).setData('label','缩放');
  }

  /** 工具栏文字、按钮底图与命中区共用画框内的 CSS 坐标。 */
  private placeToolbarText(): void {
    const dom=this.dom,shown=this.toolbar.root.visible,font=Math.min(22,TOOLBAR_HEIGHT*.42),seen=new Set<string>();
    const entries:[string,string,UiNode|undefined,number][] = [
      ['reset','恢复默认',this.resetButton,TOOLBAR_RESET_WIDTH],
      ['move','移动',this.moveButton,TOOLBAR_MODE_WIDTH],
      ['scale','缩放',this.scaleButton,TOOLBAR_MODE_WIDTH]
    ];
    for(const [key,text,button,width] of entries){
      if(!dom||!button)continue;
      seen.add(key);
      let label=this.toolbarLabels.get(key);
      if(!label){label=dom.label('screen','dom-control-toolbar',{x:.5,y:.5});this.toolbarLabels.set(key,label);}
      const matrix=button.getWorldTransformMatrix(),point=matrix.transformPoint(width/2,TOOLBAR_HEIGHT/2);
      label.setText(text).setPosition(point.x,point.y)
        .setStyle({fontSize:`${Math.max(1,font*matrix.scaleX)}px`,color:GOLD}).setVisible(shown);
    }
    for(const [key,label] of this.toolbarLabels){if(seen.has(key))continue;label.remove();this.toolbarLabels.delete(key);}
  }

  /** 物品格左上角数量文字：位置和字号取控件容器的世界变换。 */
  private placeQuantityText(): void {
    const dom=this.dom,shown=this.canvas.root.visible,seen=new Set<ControlId>();
    for(const quantity of this.quantities){
      const object=this.controls.get(quantity.id);
      if(!dom||!object)continue;
      seen.add(quantity.id);
      let label=this.quantityLabels.get(quantity.id);
      if(!label){label=dom.label('screen','dom-control-quantity',{x:.5,y:.5});this.quantityLabels.set(quantity.id,label);}
      const matrix=object.getWorldTransformMatrix(),point=matrix.transformPoint(QUANTITY_BADGE.centerX,QUANTITY_BADGE.centerY);
      label.setText(quantity.text).setAnchor(.5,.5).setPosition(point.x,point.y)
        .setStyle({fontSize:`${Math.max(1,QUANTITY_BADGE.fontSize*matrix.scaleX*quantity.fit)}px`,color:'#ffffff'}).setVisible(shown);
    }
    for(const [id,label] of this.quantityLabels){if(seen.has(id))continue;label.remove();this.quantityLabels.delete(id);}
  }

  private setMode(mode: EditMode): void {
    if(this.mode===mode)return;
    this.mode=mode;this.cancelDrags();this.paintToolbar();this.layout();
  }

  /** 缩放拖动期间用预览倍率参与解析，松手前不写存储。 */
  private previewOverrides(): ControlLayoutOverrides {
    const positions=this.preferences.snapshot(),preview=this.preview;
    return preview?{...positions,[preview.id]:{...preview.point,scale:preview.scale}}:positions;
  }

  private rebuild(): void {
    this.cancelDrags();
    this.canvas.clear();this.controls.clear();this.quantities=[];
    this.selectionFrame=undefined;this.handles.length=0;this.placements=undefined;
    // 点击空白处取消选中；这层透明底板垫在控件下面，不会抢控件的点击。
    const background=this.canvas.rect(-4000,-4000,8000,8000,0,0).setInteractive();
    background.on('pointerdown',()=>this.select(undefined));
    this.canvas.root.addAt(background,0);
    for (const id of CONTROL_IDS) {
      const object=this.canvas.container().setData('uiAction',true).setData('controlId',id);
      this.canvas.root.add(object);this.controls.set(id,object);
      let width:number=CONTROL_SIZES.slot.width,height:number=CONTROL_SIZES.slot.height;
      const image=(file:string,w:number,h:number=w,x=-w/2,y=-h/2)=>this.canvas.image(file,x,y,w,h,object);
      if(id==='move') {
        if (controlSettings.moveStyle === 'dpad') {
          width = height = DPAD_BASE_RADIUS * 2;
          const ring = this.canvas.image(this.skin['stick-base'],-DPAD_BASE_RADIUS,-DPAD_BASE_RADIUS,DPAD_BASE_RADIUS*2,DPAD_BASE_RADIUS*2,object)
            .setDisplaySize(DPAD_BASE_RADIUS * 2, DPAD_BASE_RADIUS * 2).setAlpha(DPAD_RUNE_ALPHA);
          const up = this.canvas.image(this.skin['arrow-up'],0,-DPAD_ARROW_OFFSET,undefined,undefined,object).setOrigin(.5).setScale(DPAD_ARROW_SCALE_NORM);
          const down = this.canvas.image(this.skin['arrow-down'],0,DPAD_ARROW_OFFSET,undefined,undefined,object).setOrigin(.5).setScale(DPAD_ARROW_SCALE_NORM);
          const left = this.canvas.image(this.skin['arrow-left'],-DPAD_ARROW_OFFSET,0,undefined,undefined,object).setOrigin(.5).setScale(DPAD_ARROW_SCALE_NORM);
          const right = this.canvas.image(this.skin['arrow-right'],DPAD_ARROW_OFFSET,0,undefined,undefined,object).setOrigin(.5).setScale(DPAD_ARROW_SCALE_NORM);
          object.add([ring, up, down, left, right]);
        } else {
          width = CONTROL_SIZES.move.width; height = CONTROL_SIZES.move.height;
          image(this.skin['stick-base'], CONTROL_SIZES.move.width); image(this.skin.button, STICK_KNOB_RADIUS * 2);
        }
      }
      else if(id==='attack') {width=CONTROL_SIZES.attack.width;height=CONTROL_SIZES.attack.height;image(this.skin.button,width,height);}
      else if(id==='swap') {width=CONTROL_SIZES.swap.width;height=CONTROL_SIZES.swap.height;image(this.skin.swap,CONTROL_SIZES.swap.width);}
      else {
        image(this.skin['slot-shadow'],CONTROL_SIZES.slot.width);image(this.skin['slot-ring'],CONTROL_SIZES.slot.width);
        const slot=this.slots[Number(id.slice(5))],isItem=slot?.entry?.kind==='item',size=isItem?ITEM_ICON_SIZE:SLOT_ICON_SIZE;
        if(slot?.entry&&slot.icon)image(slot.icon,size);
        const cooldown=slot?.cooldown;
        if(cooldown&&cooldown.durationMs>0&&cooldown.remainingMs>0) {
          const fan=new DomCooldown(object.element);fan.rect({x:-size/2,y:-size/2,width:size,height:size});fan.update(cooldown,size/2);object.once('destroy',()=>fan.destroy());
        }
        if(isItem) {
          image(this.skin['quantity-badge'],QUANTITY_BADGE.width,QUANTITY_BADGE.height,
            QUANTITY_BADGE.centerX-QUANTITY_BADGE.width/2,QUANTITY_BADGE.centerY-QUANTITY_BADGE.height/2);
          const text=String(slot!.quantity);
          // 文字交给 DOM；这里只留一个量字探针，量完立即销毁。
          const probe=this.canvas.text(text,0,0,0,QUANTITY_BADGE.fontSize,'#ffffff');
          const fit=Math.min(1,QUANTITY_BADGE.maxTextSize/Math.max(1,probe.width),QUANTITY_BADGE.maxTextSize/Math.max(1,probe.height));
          probe.destroy();
          this.quantities.push({id,text,fit});
        }
      }
      // 控件以中心定位，热区覆盖中心两侧的完整图片。
      object.setSize(width,height).setInteractive({x:-width/2,y:-height/2,width,height},
        (area:{x:number;y:number;width:number;height:number},x:number,y:number)=>this.active&&this.canvas.root.visible&&x>=area.x&&x<=area.x+area.width&&y>=area.y&&y<=area.y+area.height);
      object.draggable();
      object.on('pointerdown',()=>this.select(id));
      object.on('dragstart',(pointer:UiPointer)=>{
        if(!this.active||!this.canvas.root.visible)return;
        // 整次拖动做什么由工具栏当前模式决定，拖动中不会切换。
        if(this.mode==='scale'){
          const placement=this.placements?.[id];
          if(placement)this.beginScale(pointer,id,placement);
          return;
        }
        if(!this.drags.has(id))this.drags.set(id,{pointer});
      });
      object.on('drag',(pointer:UiPointer,x:number,y:number)=>{
        if(this.scaleDrag?.id===id){this.updateScale(pointer);return;}
        const drag=this.drags.get(id);if(!drag||drag.pointer.id!==pointer.id)return;
        const viewport=controlViewport(),positions=this.preferences.snapshot(),moveSize=this.moveSize();
        drag.point=normalizeControlPosition(viewport,id,{x,y},positions,moveSize);
        const position=resolveControlLayout(viewport,{...positions,[id]:drag.point},moveSize)[id];
        object.setPosition(position.x,position.y);
        this.placeQuantityText();
        if(this.selected===id)this.drawSelection(position);
      });
      object.on('dragend',(pointer:UiPointer)=>{
        if(this.scaleDrag?.id===id){this.endScale(pointer);return;}
        const drag=this.drags.get(id);if(!drag||drag.pointer.id!==pointer.id)return;
        this.drags.delete(id);
        if(drag.point&&this.active&&this.canvas.root.visible)this.preferences.set(id,drag.point);
        else this.layout();
      });
    }
    this.createSelectionLayer();
  }

  /** 白色空心框和四个角把手；把手只做视觉提示，拖动统一由控件本体按落点分派。 */
  private createSelectionLayer(): void {
    this.selectionFrame=this.canvas.rect(0,0,1,1,0,0).setVisible(false);
    this.canvas.root.add(this.selectionFrame);
    for(let index=0;index<4;index++) {
      const handle=this.canvas.rect(0,0,HANDLE_SIZE,HANDLE_SIZE,0xffffff,1).setOrigin(.5).setVisible(false).setData('uiAction',true);
      this.canvas.root.add(handle);
      this.handles.push(handle);
    }
  }

  private select(id?: ControlId): void {
    if(!this.active)return;
    this.selected=id;
    this.paintSelection();
  }

  private paintSelection(): void {
    const placement=this.selected&&this.placements?this.placements[this.selected]:undefined;
    this.drawSelection(placement);
  }

  private drawSelection(placement?: ControlPlacement): void {
    const frame=this.selectionFrame;
    if(!frame)return;
    // 白框和四角只在缩放模式出现；移动时直接拖控件，不需要选中提示。
    if(!this.active||!placement||this.mode!=='scale') {
      frame.setVisible(false);
      for(const handle of this.handles)handle.setVisible(false);
      return;
    }
    const halfWidth=placement.width/2+SELECTION_BLEED,halfHeight=placement.height/2+SELECTION_BLEED;
    const left=placement.x-halfWidth,top=placement.y-halfHeight,right=left+halfWidth*2,bottom=top+halfHeight*2;
    // 缩放模式下线加粗，明确告诉玩家现在拖动改的是大小。
    frame.setPosition(left,top).setSize(halfWidth*2,halfHeight*2).setStrokeStyle(3,0xffffff,1).setVisible(true);
    const corners=[[left,top],[right,top],[left,bottom],[right,bottom]];
    corners.forEach(([x,y],index)=>this.handles[index]?.setPosition(x,y).setVisible(true));
  }

  /** 记住当前中心和“1 倍时的中心到角距离”，拖动中只换算倍率。 */
  private beginScale(pointer: UiPointer, id: ControlId, placement: ControlPlacement): void {
    const viewport=controlViewport(),overrides=this.preferences.snapshot(),moveSize=this.moveSize();
    const point=normalizeControlPosition(viewport,id,{x:placement.x,y:placement.y},overrides,moveSize);
    const baseWidth=placement.width/placement.userScale,baseHeight=placement.height/placement.userScale;
    this.scaleDrag={pointer,id,point,center:{x:placement.x,y:placement.y},
      radius:Math.hypot(baseWidth/2,baseHeight/2),max:maxControlScale(viewport,id,overrides,moveSize)};
    this.preview={id,point,scale:placement.userScale};
    this.paintSelection();
  }

  private updateScale(pointer: UiPointer): void {
    const drag=this.scaleDrag;
    if(!drag||drag.pointer.id!==pointer.id)return;
    const distance=Math.hypot(pointer.x-drag.center.x,pointer.y-drag.center.y);
    const scale=Math.max(CONTROL_SCALE_MIN,Math.min(drag.max,distance/Math.max(1,drag.radius)));
    this.preview={id:drag.id,point:drag.point,scale};
    this.layout();
  }

  private endScale(pointer: UiPointer): void {
    const drag=this.scaleDrag;
    if(!drag||drag.pointer.id!==pointer.id)return;
    const scale=this.preview?.scale??1;
    this.scaleDrag=undefined;this.preview=undefined;
    if(this.active&&this.canvas.root.visible)this.preferences.set(drag.id,drag.point,scale);
    this.layout();
  }

  private cancelDrags(): void {
    for(const [id] of this.drags) {
      // 先释放原生指针捕获，再恢复控件的命中区。
      const object=this.controls.get(id);object?.disableInteractive();object?.setInteractive();
    }
    this.drags.clear();
    const scale=this.scaleDrag;
    if(scale) {
      const object=this.controls.get(scale.id);object?.disableInteractive();object?.setInteractive();
    }
    this.scaleDrag=undefined;this.preview=undefined;
  }
  private cancelNative=():void=>this.cancel();
  private cancel(): void {this.cancelDrags();this.layout();}
}
