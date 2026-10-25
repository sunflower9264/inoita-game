import { UI_EVENTS } from '../../application/ui-events.ts';
import Phaser from 'phaser';
import { readSafeArea } from '../viewport.ts';
import { loadSceneAssets, type PendingAsset } from '../../rendering/scene-assets.ts';
import type { AssetLease } from '../../application/assets.ts';
import { COMMON_BUTTON, COMMON_BUTTON_IMAGES } from '../common-button.ts';
import { UI_ICON_ATLAS_DATA, UI_ICON_ATLAS_FILE, UI_ICON_ATLAS_KEY, UI_ICON_FRAMES } from '../../generated/icon-atlas.ts';

export const GOLD = '#f3deb0';
import { FONT } from '../text-style.ts';
export const uiTexture = (file: string): string => `interface:${file}`;
/** 图标可能来自图集；非图集资源仍按文件路径作为纹理键。 */
export function uiImage(file: string): { key: string; frame?: string } {
  const frame = UI_ICON_FRAMES[file];
  return frame ? { key: UI_ICON_ATLAS_KEY, frame } : { key: uiTexture(file) };
}
/** 图集尚未加载（测试替身或异常路径）时退回单图纹理键，避免整页渲染中断。 */
export function uiImageFor(scene: Phaser.Scene, file: string): { key: string; frame?: string } {
  const ref = uiImage(file);
  if (!ref.frame) return ref;
  const texture = scene.textures.exists(ref.key) ? scene.textures.get(ref.key) : undefined;
  return texture?.has(ref.frame) ? ref : { key: uiTexture(file) };
}
const firstIconFrame = Object.values(UI_ICON_FRAMES)[0];
const uiIconAtlasAsset: PendingAsset = { kind: 'atlas', key: UI_ICON_ATLAS_KEY, file: UI_ICON_ATLAS_FILE,
  atlas: UI_ICON_ATLAS_DATA, ...(firstIconFrame ? { frame: firstIconFrame } : {}) };
const atlasImageFiles = new Set([UI_ICON_ATLAS_FILE, UI_ICON_ATLAS_DATA]);

export async function loadUiImages(scene: Phaser.Scene, files: string[], progress = (_value: number) => {}): Promise<AssetLease> {
  files = [...new Set([...files, ...COMMON_BUTTON_IMAGES])];
  const wantsAtlas = files.some(file => atlasImageFiles.has(file) || UI_ICON_FRAMES[file] !== undefined);
  const assets: PendingAsset[] = wantsAtlas ? [uiIconAtlasAsset] : [];
  for (const file of files) if (!atlasImageFiles.has(file) && UI_ICON_FRAMES[file] === undefined)
    assets.push({ kind: 'image', key: uiTexture(file), file });
  const lease = await loadSceneAssets(scene, assets, progress, true);
  const linear = Phaser.Textures.FilterMode.LINEAR;
  for (const asset of assets) {
    const texture = scene.textures.exists(asset.key) ? scene.textures.get(asset.key) : undefined;
    texture?.setFilter(linear);
  }
  return lease;
}

import { wrapText } from '../text-layout.ts';

export class UiSurface {
  readonly scene:Phaser.Scene; readonly width:number; readonly height:number; readonly depth:number;
  readonly root: Phaser.GameObjects.Container;
  readonly scrolls: ScrollArea[] = [];
  // 取消回调挂在按钮本身：虚拟滚动会反复销毁重建行，独立数组会留下已销毁按钮的闭包。
  private cancelInput=():void=>{this.buttons.forEach(button=>{if(button.active)button.getData('cancelPress')?.();});this.scrolls.forEach(scroll=>scroll.cancelGesture());};
  private buttons: Phaser.GameObjects.Container[] = [];
  private focusIndex = -1;
  enabled:()=>boolean=()=>true;
  constructor(scene: Phaser.Scene, width: number, height: number, depth = 100) {
    this.scene=scene;this.width=width;this.height=height;this.depth=depth;
    this.root = scene.add.container(0, 0).setDepth(depth);scene.game.events.on(UI_EVENTS.cancelInput,this.cancelInput);scene.input.on('pointerupoutside',this.cancelInput);
  }
  layout(padding = 12): void {
    const bounds = this.scene.game.canvas.getBoundingClientRect(), safe = readSafeArea();
    const unit = this.scene.scale.width / Math.max(1, bounds.width);
    const left = (safe.left + padding) * unit, right = (safe.right + padding) * unit;
    const top = (safe.top + padding) * unit, bottom = (safe.bottom + padding) * unit;
    const factor = Math.min((this.scene.scale.width-left-right)/this.width, (this.scene.scale.height-top-bottom)/this.height);
    this.root.setScale(Math.max(.01,factor)).setPosition(left+(this.scene.scale.width-left-right-this.width*factor)/2,top+(this.scene.scale.height-top-bottom-this.height*factor)/2);
    this.scrolls.forEach(scroll=>scroll.layout());
  }
  clear(): void {
    this.scrolls.splice(0).forEach(scroll=>scroll.destroy()); this.buttons=[]; this.focusIndex=-1; this.root.removeAll(true);
  }
  destroy(): void { this.scene.game.events.off(UI_EVENTS.cancelInput,this.cancelInput);this.scene.input.off('pointerupoutside',this.cancelInput);this.clear();this.root.destroy(); }
  visible(value: boolean): void { this.root.setVisible(value); this.scrolls.forEach(scroll=>scroll.layer.setVisible(value&&scroll.visible)); }
  image(file: string, x: number, y: number, width?: number, height?: number, parent=this.root): Phaser.GameObjects.Image {
    const ref=uiImageFor(this.scene,file);
    const result=this.scene.add.image(x,y,ref.key,ref.frame).setOrigin(0);
    if(width!==undefined||height!==undefined){const ratio=result.width/result.height;result.setDisplaySize(width??height!*ratio,height??width!/ratio);}
    parent.add(result); return result;
  }
  text(value: string, x: number, y: number, width=0, size=22, color=GOLD, parent=this.root): Phaser.GameObjects.Text {
    const result:Phaser.GameObjects.Text=this.scene.add.text(x,y,'',{fontFamily:FONT,fontSize:size,color,resolution:Math.min(3,Math.max(1,window.devicePixelRatio||1)),lineSpacing:5}).setOrigin(0);
    if(width)result.setWordWrapCallback((text:string):string=>wrapText(text,width,part=>result.context.measureText(part).width).join('\n'));
    result.setText(value);
    parent.add(result); return result;
  }
  rect(x:number,y:number,width:number,height:number,color=0x21190f,alpha=.95,parent=this.root):Phaser.GameObjects.Rectangle {
    const result=this.scene.add.rectangle(x,y,width,height,color,alpha).setOrigin(0);parent.add(result);return result;
  }
  button(label:string,x:number,y:number,width:number,height:number,action:()=>void,options:{image?:string;pressed?:string;fontSize?:number;disabled?:boolean;selected?:boolean;bare?:boolean;native?:boolean;pressedRect?:{x:number;y:number;width:number;height:number};pressedAdd?:boolean;parent?:Phaser.GameObjects.Container;guard?:()=>boolean}={}):Phaser.GameObjects.Container {
    const parent=options.parent??this.root, result=this.scene.add.container(x,y);parent.add(result);
    // native 让原版按钮图按原始尺寸居中盖在命中区上，命中区保持 w×h。
    const draw=(file:string):Phaser.GameObjects.Image=>{
      const plain=options.native?this.image(file,0,0,undefined,undefined,result):undefined;
      if(!plain)return this.image(file,0,0,width,height,result);
      return plain.setPosition(Math.floor((width-plain.width)/2),Math.floor((height-plain.height)/2));
    };
    const common=!options.image&&!options.bare;
    const face=options.image?draw(options.image):common?this.buttonSkin(COMMON_BUTTON.image,width,height,result):undefined;
    // 没有专用按下图、也不是共用按钮时不留按下层：按下改涂一层底色是网页式反馈，原版没有。
    const highlight=options.pressed?draw(options.pressed):common?this.buttonSkin(COMMON_BUTTON.pressed,width,height,result):undefined;
    if(common)highlight!.setBlendMode(Phaser.BlendModes.ADD);
    // 按下层可以比命中区大、落在别处；原版的按下叠层是 `glBlendFunc(SRC_ALPHA, ONE)`，即叠加混合。
    if(options.pressed&&options.pressedRect){const area=options.pressedRect;(highlight as Phaser.GameObjects.Image).setPosition(area.x,area.y).setDisplaySize(area.width,area.height);}
    if(options.pressed&&options.pressedAdd)(highlight as Phaser.GameObjects.Image).setBlendMode(Phaser.BlendModes.ADD);
    const text=label?this.text(label,width/2,height/2,width-12,options.fontSize??Math.min(22,height*.42),GOLD,result):undefined;
    if(text)text.setOrigin(.5);
    const selected=common&&!!options.selected;
    highlight?.setVisible(selected);result.setInteractive(new Phaser.Geom.Rectangle(0,0,width,height),(area:Phaser.Geom.Rectangle,px:number,py:number)=>this.enabled()&&this.root.visible&&Phaser.Geom.Rectangle.Contains(area,px,py)&&this.scrolls.filter(scroll=>scroll.content===parent).every(scroll=>scroll.contains(this.scene.input.activePointer)));
    result.setData('uiAction',true);
    result.setData('label',label).setData('action',action).setData('guard',options.guard)
      .setData('face',face).setData('highlight',highlight).setData('labelText',text).setData('selected',selected);
    if(options.disabled)result.disableInteractive().setAlpha(.4);
    let press:number|undefined;result.setData('cancelPress',()=>{press=undefined;highlight?.setVisible(selected);});
    result.on('pointerdown',(pointer:Phaser.Input.Pointer,_x:number,_y:number,_event:Phaser.Types.Input.EventData)=>{
      if(!this.enabled())return;press=pointer.id;highlight?.setVisible(true);
    });
    result.on('pointerout',()=>{press=undefined;highlight?.setVisible(selected);});
    result.on('pointerup',(pointer:Phaser.Input.Pointer,_x:number,_y:number,_event:Phaser.Types.Input.EventData)=>{
      highlight?.setVisible(selected);if(press!==pointer.id)return;press=undefined;
      if(this.enabled()&&(!options.guard||options.guard())&&this.scrollClickAllowed(parent)){this.scene.game.events.emit(UI_EVENTS.select);action();}
    });
    this.buttons.push(result);return result;
  }
  /**
   * 按钮的父容器是滚动区内容时，拖动过的滚动区不再触发抬手动作。
   * 滚动内容按 1:1 跟手，被按住的整行始终在手指下，不会触发 `pointerout`；
   * 命中区已在按下时按视口裁剪，这里补上同一层的拖动判定。
   */
  private scrollClickAllowed(parent:Phaser.GameObjects.Container):boolean{return this.scrolls.filter(scroll=>scroll.content===parent).every(scroll=>!scroll.moved);}
  /** Phaser ThreeSlice 保留两端比例，只延展按钮中段；Canvas 用同一纹理的三段。 */
  private buttonSkin(file:string,width:number,height:number,parent:Phaser.GameObjects.Container):Phaser.GameObjects.Container {
    const key=uiTexture(file),texture=this.scene.textures.get(key),source=texture.get(),cap=COMMON_BUTTON.cap;
    const scale=Math.min(height/source.height,width/(cap*2));
    const span=width/scale,group=this.scene.add.container(0,(height-source.height*scale)/2).setScale(scale);
    parent.add(group);
    if(this.scene.game.renderer.type===Phaser.WEBGL){
      group.add(this.scene.add.nineslice(0,0,key,undefined,span,source.height,cap,cap,0,0).setOrigin(0));
    }else{
      const parts=[[0,cap,0,cap],[cap,source.width-cap*2,cap,span-cap*2],[source.width-cap,cap,span-cap,cap]];
      parts.forEach(([x,sourceWidth,left,displayWidth],index)=>{
        const frame=`ui-button-${index}`;
        if(!texture.has(frame))texture.add(frame,0,x,0,sourceWidth,source.height);
        group.add(this.scene.add.image(left,0,key,frame).setOrigin(0).setDisplaySize(displayWidth,source.height));
      });
    }
    return group;
  }
  /** 滚动区重建可视行后，清掉已销毁按钮的键盘焦点引用。 */
  pruneButtons():void{this.buttons=this.buttons.filter(button=>button.active);}
  focusables():Phaser.GameObjects.Container[]{return this.enabled()&&this.root.visible?this.buttons.filter(button=>button.active&&button.input?.enabled&&button.visible):[];}
  focus(button:Phaser.GameObjects.Container):void{this.buttons.forEach(candidate=>candidate.getData('highlight')?.setVisible(candidate===button||candidate.getData('selected')));this.scrolls.find(scroll=>scroll.content===button.parentContainer)?.reveal(button);}
  key(event:KeyboardEvent):void {
    const candidates=this.focusables();
    if(event.key==='Tab'&&candidates.length){event.preventDefault();this.focusIndex=this.focusIndex<0?(event.shiftKey?candidates.length-1:0):(this.focusIndex+(event.shiftKey?-1:1)+candidates.length)%candidates.length;this.focus(candidates[this.focusIndex]);}
    if((event.key==='Enter'||event.key===' ')&&this.focusIndex>=0&&candidates[this.focusIndex]){event.preventDefault();this.scene.game.events.emit(UI_EVENTS.select);candidates[this.focusIndex].getData('action')();}
  }
  nineSlice(file:string,x:number,y:number,width:number,height:number,inset:number):void {
    const key=uiTexture(file);
    if(this.scene.game.renderer.type===Phaser.WEBGL){this.root.add(this.scene.add.nineslice(x,y,key,undefined,width,height,inset,inset,inset,inset).setOrigin(0));return;}
    const texture=this.scene.textures.get(key),source=texture.get(),xs=[0,inset,source.width-inset],ys=[0,inset,source.height-inset],sw=[inset,source.width-inset*2,inset],sh=[inset,source.height-inset*2,inset];
    const dx=[x,x+inset,x+width-inset],dy=[y,y+inset,y+height-inset],dw=[inset,width-inset*2,inset],dh=[inset,height-inset*2,inset];
    for(let row=0;row<3;row++)for(let column=0;column<3;column++){const frame=`ui-nine-${inset}-${row}-${column}`;if(!texture.has(frame))texture.add(frame,0,xs[column],ys[row],sw[column],sh[row]);this.root.add(this.scene.add.image(dx[column],dy[row],key,frame).setOrigin(0).setDisplaySize(dw[column],dh[row]));}
  }
  /** 原版文本底板：两端 9×34 端盖夹一段实色，中间色 RGB(105,80,49)、不透明度 0.8。见 UI_DrawTextBackground @0x143b30。 */
  textPlate(left:string,right:string,x:number,y:number,width:number,parent=this.root):void {
    this.image(left,x,y,9,34,parent);
    this.image(right,x+width-9,y,9,34,parent);
    this.rect(x+9,y,width-18,34,0x695031,.8,parent);
  }
  /**
   * 原版图框：四边各 24 像素、四角 24×24。只画框，不画底色——底色各面板自己决定
   * （内容栏用 `frame` 的暖黑底，说明面板用原版 60% 黑底，见 `desc-panel-2026-10-12.md`）。
   */
  border(assets:Record<string,string>,x:number,y:number,width:number,height:number):void {
    if(!assets['corner-nw'])return;
    this.image(assets['edge-horizontal'],x+24,y,width-48,24);
    this.image(assets['edge-horizontal'],x+24,y+height-24,width-48,24).setFlipY(true);
    this.image(assets['edge-vertical'],x,y+24,24,height-48);
    this.image(assets['edge-vertical'],x+width-24,y+24,24,height-48).setFlipX(true);
    for(const [part,dx,dy]of [['nw',0,0],['ne',width-24,0],['sw',0,height-24],['se',width-24,height-24]] as const)this.image(assets[`corner-${part}`],x+dx,y+dy,24,24);
  }
  frame(assets:Record<string,string>,x:number,y:number,width:number,height:number):void {
    this.rect(x,y,width,height,0x15100b,.96);
    this.border(assets,x,y,width,height);
  }
  /**
   * `bleed` 把裁剪矩形与命中区向四周放大这么多像素，内容原点不动。技能格的选中框画在格内
   * `(-14,-14)`，与原版一样要露出滚动区之外，第一列／第一行才不会被裁成缺边的圆环。
   */
  scroll(x:number,y:number,width:number,height:number,bleed=0):ScrollArea {const scroll=new ScrollArea(this,x,y,width,height,bleed);this.scrolls.push(scroll);return scroll;}
}

/**
 * 按钮内部的具名部件。
 *
 * 调用方按名字取，**不要按下标读 `list`**：`button` 里加一个部件或调整组装顺序，
 * 下标就指向别的对象，表现为按钮错位或变色，而且不报错。`face` 是专用底图或共用按钮容器
 * （`bare` 且没有 `image` 时为 undefined），`highlight` 只在传了 `pressed` 或走共用按钮时存在，
 * `text` 只在传了 label 时存在。
 */
export function buttonParts(button:Phaser.GameObjects.Container):{
  face?:Phaser.GameObjects.Image|Phaser.GameObjects.Rectangle|Phaser.GameObjects.Container;
  highlight?:Phaser.GameObjects.Image|Phaser.GameObjects.Rectangle|Phaser.GameObjects.Container;
  text?:Phaser.GameObjects.Text;
} {
  return {face:button.getData('face'),highlight:button.getData('highlight'),text:button.getData('labelText')};
}

const scrollAreas = new WeakMap<Phaser.Scene, Set<ScrollArea>>();
let scrollOrder = 0;

/** 裁剪只影响绘制；命中区另行检查视口，滚动时不会点击被裁掉的行。 */
export class ScrollArea {
  readonly surface:UiSurface; readonly x:number; readonly y:number; readonly width:number; readonly height:number;
  readonly bleed:number;
  readonly layer:Phaser.GameObjects.Layer;
  readonly content:Phaser.GameObjects.Container;
  private mask:Phaser.GameObjects.Rectangle;
  /** WebGL 遮罩的滤镜控制器；静态化后只在几何变化时重做遮罩纹理。 */
  private maskFilter?:{autoUpdate:boolean;needsUpdate:boolean};
  private zone:Phaser.GameObjects.Zone;
  private offset=0;
  private extent=0;
  private shown=true;
  private virtual?:{count:number;rowHeight:number;render:(first:number,last:number)=>void;range?:[number,number]};
  onScroll?:()=>void;
  private press?:{id:number;y:number;offset:number};
  private readonly order=++scrollOrder;
  moved=false;
  constructor(surface:UiSurface,x:number,y:number,width:number,height:number,bleed=0){
    this.surface=surface;this.x=x;this.y=y;this.width=width;this.height=height;this.bleed=bleed;
    const scene=surface.scene;this.layer=scene.add.layer().setDepth(surface.depth+1);this.content=scene.add.container(0,0);this.layer.add(this.content);
    this.mask=new Phaser.GameObjects.Rectangle(scene,0,0,1,1,0xffffff).setOrigin(0);
    if(scene.game.renderer.type===Phaser.WEBGL){
      this.layer.enableFilters();
      this.maskFilter=this.layer.filters!.external.addMask(this.mask,false,scene.cameras.main,'world');
      // FilterMask 默认每帧重做动态纹理；滚动区的遮罩只在缩放/安全区变化时改几何。
      this.maskFilter.autoUpdate=false;this.maskFilter.needsUpdate=true;
    }
    else this.layer.setMask(this.mask.createGeometryMask());
    this.zone=scene.add.zone(0,0,1,1).setOrigin(0).setDepth(surface.depth+.5).setInteractive();
    this.zone.on('pointerdown',(p:Phaser.Input.Pointer)=>{if(this.onTop(p))this.begin(p);});
    scene.input.on('pointerdown',this.down,this);scene.input.on('pointermove',this.move,this);scene.input.on('pointerup',this.up,this);scene.input.on('wheel',this.wheel,this);
    let areas=scrollAreas.get(scene);
    if(!areas){areas=new Set();scrollAreas.set(scene,areas);}
    areas.add(this);
    this.layout();
  }
  reveal(button:Phaser.GameObjects.Container):void{const height=button.input?.hitArea.height??0;if(button.y<this.offset)this.scrollTop=button.y;else if(button.y+height>this.offset+this.height)this.scrollTop=button.y+height-this.height;}
  cancelGesture():void{this.press=undefined;this.moved=true;}
  get visible():boolean{return this.shown;}
  set visible(value:boolean){this.shown=value;this.layer.setVisible(value&&this.surface.root.visible);}
  get scrollTop():number{return this.offset;}
  set scrollTop(value:number){this.offset=Phaser.Math.Clamp(value,0,Math.max(0,this.extent-this.height));this.layout();}
  setHeight(height:number):void{this.extent=height;this.scrollTop=this.offset;}
  /**
   * 长列表按可视窗口渲染：只画当前滚动位置附近的行，滚动时重建。
   * 全量渲染几千行会在移动端一次重画里创建几千张带纹理的对象，Safari 报
   * `Framebuffer Unsupported` 后直接丢失 WebGL 上下文。
   */
  setVirtual(count:number,rowHeight:number,render:(first:number,last:number)=>void):void{
    if(!(count>0)||!(rowHeight>0))return;
    this.virtual={count,rowHeight,render};
    this.renderVirtual();
  }
  private renderVirtual():void{
    const virtual=this.virtual;
    if(!virtual)return;
    const first=Math.max(0,Math.floor(this.offset/virtual.rowHeight)-2);
    const last=Math.min(virtual.count,Math.ceil((this.offset+this.height)/virtual.rowHeight)+2);
    if(virtual.range&&virtual.range[0]===first&&virtual.range[1]===last)return;
    virtual.range=[first,last];
    this.content.removeAll(true);this.surface.pruneButtons();
    virtual.render(first,last);
  }
  contains(pointer:Phaser.Input.Pointer):boolean{return this.surface.enabled()&&this.surface.root.visible&&this.layer.visible&&this.mask.getBounds().contains(pointer.x,pointer.y);}
  /** 多个滚动区叠在一起时，只让最上层接手拖动和滚轮；否则说明面板滑动会带着底下背包一起走。 */
  private onTop(pointer:Phaser.Input.Pointer):boolean{
    if(!this.contains(pointer))return false;
    const areas=scrollAreas.get(this.surface.scene);
    if(!areas)return true;
    for(const other of areas){
      if(other===this||!other.contains(pointer))continue;
      if(other.layer.depth>this.layer.depth||(other.layer.depth===this.layer.depth&&other.order>this.order))return false;
    }
    return true;
  }
  guard = ():boolean => !this.moved && this.contains(this.surface.scene.input.activePointer);
  private begin(pointer:Phaser.Input.Pointer):void{if(this.press&&this.press.id!==pointer.id)return;this.press={id:pointer.id,y:pointer.y,offset:this.offset};this.moved=false;}
  private down(pointer:Phaser.Input.Pointer):void{if(this.onTop(pointer))this.begin(pointer);}
  private move(pointer:Phaser.Input.Pointer):void{if(this.press?.id!==pointer.id||!pointer.isDown)return;if(!this.surface.enabled()||!this.surface.root.visible){this.cancelGesture();return;}const distance=(pointer.y-this.press.y)/this.surface.root.getWorldTransformMatrix().scaleY;if(Math.abs(distance)>8)this.moved=true;if(this.moved){this.scrollTop=this.press.offset-distance;this.onScroll?.();}}
  private up(pointer:Phaser.Input.Pointer):void{if(this.press?.id===pointer.id)this.press=undefined;}
  private wheel(pointer:Phaser.Input.Pointer,_objects:Phaser.GameObjects.GameObject[],_dx:number,dy:number):void{if(this.onTop(pointer)){const before=this.offset;this.scrollTop=this.offset+dy/this.surface.root.getWorldTransformMatrix().scaleY;if(this.offset!==before)this.onScroll?.();}}
  layout():void{
    const matrix=this.surface.root.getWorldTransformMatrix(),position=matrix.transformPoint(this.x,this.y),bleedX=this.bleed*matrix.scaleX,bleedY=this.bleed*matrix.scaleY;
    const maskX=position.x-bleedX,maskY=position.y-bleedY,maskWidth=(this.width+this.bleed*2)*matrix.scaleX,maskHeight=(this.height+this.bleed*2)*matrix.scaleY;
    const maskChanged=this.mask.x!==maskX||this.mask.y!==maskY||this.mask.width!==maskWidth||this.mask.height!==maskHeight;
    this.content.setPosition(position.x,position.y-this.offset*matrix.scaleY).setScale(matrix.scaleX,matrix.scaleY);
    this.mask.setPosition(maskX,maskY).setSize(maskWidth,maskHeight);
    if(maskChanged&&this.maskFilter)this.maskFilter.needsUpdate=true;
    this.zone.setPosition(this.mask.x,this.mask.y).setSize(this.mask.width,this.mask.height);
    if(this.zone.input)this.zone.input.hitArea.setSize(this.zone.width,this.zone.height);
    this.renderVirtual();
  }
  destroy():void{const scene=this.surface.scene;scrollAreas.get(scene)?.delete(this);scene.input.off('pointerdown',this.down,this);scene.input.off('pointermove',this.move,this);scene.input.off('pointerup',this.up,this);scene.input.off('wheel',this.wheel,this);this.zone.destroy();this.layer.destroy(true);this.mask.destroy();}
}
