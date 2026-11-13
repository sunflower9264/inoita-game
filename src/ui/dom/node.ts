import type Phaser from 'phaser';
import { domAssets, type DomImageSource } from './assets.ts';
import type { AssetLease } from '../../application/assets.ts';
import { FONT } from '../text-style.ts';
import { wrapText } from '../text-layout.ts';
import { frameRect } from '../viewport.ts';

export interface UiPointer { id:number; x:number; y:number; isDown:boolean; event:PointerEvent }
type Listener = (...args:any[])=>void;
export interface UiMatrix { tx:number; ty:number; scaleX:number; scaleY:number; transformPoint(x:number,y:number):{x:number;y:number} }
export interface UiBounds { x:number;y:number;width:number;height:number;contains(x:number,y:number):boolean }
export interface UiHitArea {x:number;y:number;width:number;height:number;setSize(width:number,height:number):void}
const mounts=new WeakMap<Phaser.Scene,Map<string,HTMLElement>>();
const pointers=new WeakMap<Phaser.Scene,Map<number,UiPointer>>();
const interactiveNodes=new WeakMap<Phaser.Scene,Set<UiNode>>();

/** 屏幕节点直接使用画框内的 CSS 坐标；图片与控件在独立文字层下方排层。 */
export function uiMount(scene:Phaser.Scene,layer='screen'):HTMLElement {
  let layers=mounts.get(scene);if(!layers){layers=new Map();mounts.set(scene,layers);}
  const old=layers.get(layer);if(old)return old;
  const parent=document.getElementById(`ui-${layer}`);if(!parent)throw new Error(`DOM UI layer missing: ${layer}`);
  const element=document.createElement('div');
  Object.assign(element.style,{position:'absolute',inset:'0',zIndex:'0',pointerEvents:'none'});
  parent.appendChild(element);layers.set(layer,element);
  const hide=()=>{element.hidden=true;for(const pointer of pointers.get(scene)?.values()??[])pointer.isDown=false;for(const node of interactiveNodes.get(scene)??[])node.cancelPress();},show=()=>{element.hidden=false;};
  scene.events.on('pause',hide);scene.events.on('sleep',hide);scene.events.on('resume',show);scene.events.on('wake',show);
  const input=new AbortController();
  for(const name of ['pointermove','pointerup','pointercancel'])window.addEventListener(name,event=>uiPointer(scene,event as PointerEvent),{capture:true,signal:input.signal});
  window.addEventListener('blur',()=>{for(const pointer of pointers.get(scene)?.values()??[])pointer.isDown=false;pointers.get(scene)?.clear();
    for(const node of interactiveNodes.get(scene)??[])node.cancelPress();},{signal:input.signal});
  scene.events.once('shutdown',()=>{input.abort();pointers.delete(scene);for(const name of ['pause','sleep'])scene.events.off(name,hide);for(const name of ['resume','wake'])scene.events.off(name,show);element.remove();layers!.delete(layer);});
  return element;
}

// 触屏摇杆每秒会送来几十次 pointer 事件；每次量画框位置都会强制浏览器同步布局。
// 画框位置只在窗口尺寸变化时更新，其余时候直接用缓存。
const frameBoundsCache=new WeakMap<Phaser.Scene,{left:number;top:number;width:number;height:number}>();
function frameBounds(scene:Phaser.Scene):{left:number;top:number;width:number;height:number}{
  let cached=frameBoundsCache.get(scene);
  if(cached)return cached;
  const rect=frameRect();
  cached={left:rect.left,top:rect.top,width:rect.width,height:rect.height};
  frameBoundsCache.set(scene,cached);
  const invalidate=():void=>{frameBoundsCache.delete(scene);};
  scene.scale.once('resize',invalidate);
  window.addEventListener('resize',invalidate,{once:true,passive:true});
  window.addEventListener('scroll',invalidate,{once:true,passive:true});
  return cached;
}

export function uiPointer(scene:Phaser.Scene,event:PointerEvent):UiPointer {
  const bounds=frameBounds(scene);
  let table=pointers.get(scene);if(!table){table=new Map();pointers.set(scene,table);}
  let pointer=table.get(event.pointerId);if(!pointer){pointer={id:event.pointerId,x:0,y:0,isDown:false,event};table.set(event.pointerId,pointer);}
  Object.assign(pointer,{x:event.clientX-bounds.left,y:event.clientY-bounds.top,isDown:event.type!=='pointercancel'&&event.type!=='pointerup'&&event.buttons!==0,event});
  if(!pointer.isDown)table.delete(event.pointerId);
  return pointer;
}

/** 布局树只管理 DOM：局部坐标、显隐、资源和原生指针的成对清理。 */
export class UiNode {
  readonly element:HTMLElement;
  readonly scene:Phaser.Scene;
  readonly list:UiNode[]=[];
  parentContainer?:UiNode;
  x=0;y=0;width=0;height=0;scaleX=1;scaleY=1;depth=0;alpha=1;active=true;visible=true;
  originX=0;originY=0;flipX=false;flipY=false;
  input?:{enabled:boolean;hitArea:UiHitArea;draggable?:boolean;hitAreaCallback?:(area:UiHitArea,x:number,y:number)=>boolean};
  private data=new Map<string,any>();
  private listeners=new Map<string,Set<Listener>>();
  readonly controller=new AbortController();
  private press?:{id:number;x:number;y:number;startX:number;startY:number};
  private hit?:HTMLElement;
  private autoHit=false;
  constructor(scene:Phaser.Scene,parent:UiNode|HTMLElement=uiMount(scene),tag='div') {
    this.scene=scene;this.element=document.createElement(tag);
    Object.assign(this.element.style,{position:'absolute',pointerEvents:'none',transformOrigin:'0 0',touchAction:'none'});
    if(parent instanceof UiNode)parent.add(this);else parent.appendChild(this.element);
    const signal=this.controller.signal;
    this.element.addEventListener('pointerdown',event=>{
      if(!this.input?.enabled||!this.shown||event.button!==0)return;
      const p=uiPointer(scene,event),m=this.getWorldTransformMatrix(),lx=(p.x-m.tx)/m.scaleX+this.originX*this.width,ly=(p.y-m.ty)/m.scaleY+this.originY*this.height;
      if(!this.accepts(lx,ly))return;
      this.cancelPress();
      this.press={id:p.id,x:p.x,y:p.y,startX:this.x,startY:this.y};
      this.element.setPointerCapture(event.pointerId);
      this.emit('pointerdown',p,lx,ly,event);
      if(this.input.draggable)this.emit('dragstart',p);
      event.stopPropagation();event.preventDefault();
    },{signal});
    this.element.addEventListener('pointermove',event=>{
      const p=uiPointer(scene,event),press=this.press;if(press?.id!==p.id)return;
      if(!p.isDown||!this.shown||!this.input?.enabled){this.cancelPress();return;}
      const m=this.parentContainer?.getWorldTransformMatrix();
      if(this.input?.draggable)this.emit('drag',p,press.startX+(p.x-press.x)/(m?.scaleX??1),press.startY+(p.y-press.y)/(m?.scaleY??1));
      this.emit('pointermove',p);event.stopPropagation();
    },{signal});
    this.element.addEventListener('pointerup',event=>{
      const p=uiPointer(scene,event);if(this.press?.id!==p.id)return;
      this.press=undefined;
      if(this.input?.draggable)this.emit('dragend',p);
      const m=this.getWorldTransformMatrix(),lx=(p.x-m.tx)/m.scaleX+this.originX*this.width,ly=(p.y-m.ty)/m.scaleY+this.originY*this.height;this.emit(this.shown&&this.input?.enabled&&this.accepts(lx,ly)?'pointerup':'pointerupoutside',p,lx,ly,event);
      if(this.element.hasPointerCapture(p.id))this.element.releasePointerCapture(p.id);
      event.stopPropagation();event.preventDefault();
    },{signal});
    for(const name of ['pointercancel','lostpointercapture'])this.element.addEventListener(name,event=>{
      if(this.press?.id===(event as PointerEvent).pointerId)this.cancelPress();
    },{signal});
    this.element.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();},{signal});
    this.paint();
  }
  cancelPress():void{const id=this.press?.id;this.press=undefined;if(id!==undefined&&this.element.hasPointerCapture(id))this.element.releasePointerCapture(id);this.emit('pointerupoutside');this.getData('cancelPress')?.();}
  private accepts(x:number,y:number):boolean{const input=this.input;if(!input)return false;const area=input.hitArea;return x>=area.x&&x<=area.x+area.width&&y>=area.y&&y<=area.y+area.height&&(!input.hitAreaCallback||input.hitAreaCallback(area,x,y));}
  get shown():boolean{return this.active&&this.visible&&(!this.parentContainer||this.parentContainer.shown);}
  add(child:UiNode|UiNode[]):this {for(const node of Array.isArray(child)?child:[child]){node.parentContainer?.remove(node);node.parentContainer=this;this.list.push(node);this.element.appendChild(node.element);}return this;}
  addAt(child:UiNode,index:number):this{this.add(child);this.list.splice(this.list.indexOf(child),1);this.list.splice(index,0,child);this.element.insertBefore(child.element,this.element.children[index]??null);return this;}
  remove(child:UiNode,destroy=false):this{const index=this.list.indexOf(child);if(index>=0)this.list.splice(index,1);child.parentContainer=undefined;child.element.remove();if(destroy)child.destroy();return this;}
  removeAll(destroy=false):this{for(const node of [...this.list])this.remove(node,destroy);return this;}
  sendToBack(child:UiNode):this{return this.addAt(child,0);}
  get length():number{return this.list.length;}
  setPosition(x:number,y:number):this{this.x=x;this.y=y;this.paint();return this;}
  setX(x:number):this{return this.setPosition(x,this.y);}
  setY(y:number):this{return this.setPosition(this.x,y);}
  setScale(x:number,y=x):this{this.scaleX=x;this.scaleY=y;this.paint();return this;}
  setSize(width:number,height:number):this{this.width=width;this.height=height;this.paint();return this;}
  setDisplaySize(width:number,height:number):this{return this.setSize(width,height);}
  setOrigin(x:number,y=x):this{this.originX=x;this.originY=y;this.paint();return this;}
  setDepth(value:number):this{this.depth=value;this.element.style.zIndex=String(value);return this;}
  setAlpha(value:number):this{this.alpha=value;this.element.style.opacity=String(value);return this;}
  setVisible(value:boolean):this{this.visible=value;this.element.hidden=!value;if(!value){this.cancelPress();this.cancelDescendants();}return this;}
  private cancelDescendants():void{for(const child of this.list){child.cancelPress();child.cancelDescendants();}}
  setFlipX(value:boolean):this{this.flipX=value;this.paint();return this;}
  setFlipY(value:boolean):this{this.flipY=value;this.paint();return this;}
  setBlendMode(value:number|string):this{this.element.style.mixBlendMode=value===1||value==='add'?'plus-lighter':value==='multiply'||value==='screen'||value==='color-dodge'?value:'normal';return this;}
  setTint(value:number):this{this.element.style.filter=`brightness(${Math.max(value>>16&255,value>>8&255,value&255)/255})`;return this;}
  clearTint():this{this.element.style.filter='';return this;}
  setFillStyle(color:number,alpha=1):this{this.element.style.background=`rgba(${color>>16&255},${color>>8&255},${color&255},${alpha})`;return this;}
  setStrokeStyle(width:number,color:number,alpha=1):this{this.element.style.outline=`${width}px solid rgba(${color>>16&255},${color>>8&255},${color&255},${alpha})`;return this;}
  setData(key:string,value:any):this{this.data.set(key,value);return this;}
  getData(key:string):any{return this.data.get(key);}
  on(name:string,listener:Listener):this{let set=this.listeners.get(name);if(!set)this.listeners.set(name,set=new Set());set.add(listener);return this;}
  once(name:string,listener:Listener):this{const run:Listener=(...args)=>{this.off(name,run);listener(...args);};return this.on(name,run);}
  off(name:string,listener:Listener):this{this.listeners.get(name)?.delete(listener);return this;}
  emit(name:string,...args:any[]):this{for(const listener of this.listeners.get(name)??[])listener(...args);return this;}
  setInteractive(area?:{x?:number;y?:number;width:number;height:number}|object,test?:(area:UiHitArea,x:number,y:number)=>boolean):this{
    let nodes=interactiveNodes.get(this.scene);if(!nodes){nodes=new Set();interactiveNodes.set(this.scene,nodes);}nodes.add(this);
    const box=area&&'width'in area?area:undefined;
    if(!this.input)this.autoHit=!box;
    this.input??={enabled:true,hitArea:{x:box&&'x'in box?box.x??0:0,y:box&&'y'in box?box.y??0:0,width:box?.width??this.width,height:box?.height??this.height,setSize(w,h){this.width=w;this.height=h;}}};
    this.input.enabled=true;if(test)this.input.hitAreaCallback=test;
    if(!this.hit){this.hit=document.createElement('span');Object.assign(this.hit.style,{position:'absolute',pointerEvents:'auto',touchAction:'none'});this.element.insertBefore(this.hit,this.element.firstChild);}
    this.hit.hidden=false;this.paintHit();return this;
  }
  disableInteractive():this{if(this.input)this.input.enabled=false;if(this.hit)this.hit.hidden=true;this.cancelPress();return this;}
  draggable():this{this.setInteractive();this.input!.draggable=true;return this;}
  getWorldTransformMatrix():UiMatrix{
    const parent=this.parentContainer?.getWorldTransformMatrix(),sx=(parent?.scaleX??1)*this.scaleX,sy=(parent?.scaleY??1)*this.scaleY;
    const tx=(parent?.tx??0)+this.x*(parent?.scaleX??1),ty=(parent?.ty??0)+this.y*(parent?.scaleY??1);
    return{tx,ty,scaleX:sx,scaleY:sy,transformPoint:(x,y)=>({x:tx+x*sx,y:ty+y*sy})};
  }
  getBounds():UiBounds{
    const m=this.getWorldTransformMatrix(),area=this.input?.hitArea;
    let x=m.tx+((area?.x??0)-this.originX*this.width)*m.scaleX,y=m.ty+((area?.y??0)-this.originY*this.height)*m.scaleY;
    let width=(area?.width??this.width)*m.scaleX,height=(area?.height??this.height)*m.scaleY;
    if(!width&&!height&&this.list.length){const boxes=this.list.map(node=>node.getBounds());x=Math.min(...boxes.map(b=>b.x));y=Math.min(...boxes.map(b=>b.y));width=Math.max(...boxes.map(b=>b.x+b.width))-x;height=Math.max(...boxes.map(b=>b.y+b.height))-y;}
    return{x,y,width,height,contains:(px,py)=>px>=x&&px<=x+width&&py>=y&&py<=y+height};
  }
  /** 同一个属性写第二次时直接跳过：构造节点时位置、尺寸会被写两三遍，省下的是样式重算的时间。 */
  protected setStyle(property:string,value:string):void{
    const cached=this.styles.get(property);if(cached===value)return;this.styles.set(property,value);
    if(value)this.element.style.setProperty(property,value);else this.element.style.removeProperty(property);
  }
  private readonly styles=new Map<string,string>();
  protected paint():void{
    this.setStyle('left',`${this.x}px`);this.setStyle('top',`${this.y}px`);
    this.setStyle('width',`${this.width}px`);this.setStyle('height',`${this.height}px`);
    this.setStyle('transform',this.scaleX===1&&this.scaleY===1&&this.originX===0&&this.originY===0?'':`scale(${this.scaleX},${this.scaleY}) translate(${-this.originX*100}%,${-this.originY*100}%)`);
    this.paintHit();
  }
  private paintHit():void{if(!this.hit||!this.input)return;const area=this.input.hitArea;if(this.autoHit){area.width=this.width;area.height=this.height;}
    this.hit.style.setProperty('left',`${area.x}px`);this.hit.style.setProperty('top',`${area.y}px`);
    this.hit.style.setProperty('width',`${area.width}px`);this.hit.style.setProperty('height',`${area.height}px`);}
  destroy(_children=true):void{if(!this.active)return;this.cancelPress();this.emit('destroy');this.active=false;interactiveNodes.get(this.scene)?.delete(this);this.controller.abort();this.removeAll(true);this.parentContainer?.remove(this);this.element.remove();this.listeners.clear();this.data.clear();}
}

export class UiImage extends UiNode {
  private picture:HTMLImageElement;
  private lease?:AssetLease;
  private request?:AbortController;
  private source?:DomImageSource;
  private requestedWidth?:number;private requestedHeight?:number;
  private fit?:{x:number;y:number;mode:'cover'|'contain'};
  constructor(scene:Phaser.Scene,parent:UiNode|HTMLElement=uiMount(scene),file?:string){
    super(scene,parent);this.element.style.overflow='hidden';this.picture=document.createElement('img');this.picture.draggable=false;this.picture.alt='';
    Object.assign(this.picture.style,{position:'absolute',maxWidth:'none',pointerEvents:'none'});this.element.appendChild(this.picture);
    if(file)this.load(file);
  }
  load(file:string):this{this.setData('file',file);const cached=domAssets.peek(file);if(cached)this.applySource(cached);this.request?.abort();const request=this.request=new AbortController();void domAssets.acquire(file,request.signal).then(lease=>{if(!this.active||request!==this.request){lease.release();return;}this.lease?.release();this.lease=lease;this.applySource(lease.source);}).catch(error=>{if(request.signal.aborted)return;console.error(error);if(this.request===request)this.clearSource();});return this;}
  /** 加载失败时不能继续显示上一张图；释放旧租约并清掉画面。 */
  private clearSource():void{this.lease?.release();this.lease=undefined;this.source=undefined;this.picture.hidden=true;if(typeof this.picture.removeAttribute==='function')this.picture.removeAttribute('src');}
  private sizeFor(source:DomImageSource):{width:number;height:number}{
    const ratio=source.frame.width/source.frame.height;
    return {width:this.requestedWidth??(this.requestedHeight!==undefined?this.requestedHeight*ratio:source.frame.width),
      height:this.requestedHeight??(this.requestedWidth!==undefined?this.requestedWidth/ratio:source.frame.height)};
  }
  applySource(source:DomImageSource):this{this.source=source;this.picture.hidden=false;this.picture.src=source.url;const size=this.sizeFor(source);super.setSize(size.width,size.height);this.draw();this.emit('loaded');return this;}
  override setDisplaySize(width:number,height:number):this{this.requestedWidth=width;this.requestedHeight=height;super.setSize(width,height);this.draw();return this;}
  resize(width?:number,height?:number):this{this.requestedWidth=width;this.requestedHeight=height;
    if(this.source){const size=this.sizeFor(this.source);super.setSize(size.width,size.height);this.draw();}
    else super.setSize(width??this.width,height??this.height);return this;}
  fitting(x=.5,y=.5,mode:'cover'|'contain'='cover'):this{this.fit={x,y,mode};this.draw();return this;}
  override setFlipX(value:boolean):this{super.setFlipX(value);this.draw();return this;}
  override setFlipY(value:boolean):this{super.setFlipY(value);this.draw();return this;}
  setCrop(x:number,y:number,width:number,height:number):this{this.element.style.clipPath=`inset(${y}px ${Math.max(0,this.width-x-width)}px ${Math.max(0,this.height-y-height)}px ${x}px)`;return this;}
  private draw():void{if(!this.source)return;const source=this.source,frame=source.frame;let sx=this.width/frame.width,sy=this.height/frame.height,left=0,top=0;if(this.fit){sx=sy=this.fit.mode==='cover'?Math.max(sx,sy):Math.min(sx,sy);left=(this.width-frame.width*sx)*this.fit.x;top=(this.height-frame.height*sy)*this.fit.y;}
    const style=this.picture.style;style.setProperty('width',`${source.width*sx}px`);style.setProperty('height',`${source.height*sy}px`);
    style.setProperty('left',`${left-frame.x*sx}px`);style.setProperty('top',`${top-frame.y*sy}px`);
    const full=frame.x===0&&frame.y===0&&frame.width===source.width&&frame.height===source.height;
    style.clipPath=full?'':`inset(${frame.y*sy}px ${(source.width-frame.x-frame.width)*sx}px ${(source.height-frame.y-frame.height)*sy}px ${frame.x*sx}px)`;
    style.transformOrigin=this.flipX||this.flipY?`${this.width/2-left+frame.x*sx}px ${this.height/2-top+frame.y*sy}px`:'';
    style.transform=this.flipX||this.flipY?`scale(${this.flipX?-1:1},${this.flipY?-1:1})`:'';}
  override destroy():void{this.request?.abort();this.lease?.release();this.lease=undefined;super.destroy();}
}

let measureCanvas:HTMLCanvasElement|undefined;
export class UiText extends UiNode {
  readonly context:CanvasRenderingContext2D;
  private value='';private size:number;private wrapWidth:number;private align='left';
  constructor(scene:Phaser.Scene,parent:UiNode,value:string,x:number,y:number,width:number,size:number,color:string){
    super(scene,parent);this.size=size;this.wrapWidth=width;
    measureCanvas??=document.createElement('canvas');this.context=measureCanvas.getContext('2d')!;
    Object.assign(this.element.style,{fontFamily:FONT,fontSize:`${size}px`,color,whiteSpace:'pre',lineHeight:`${size+5}px`});this.setPosition(x,y);this.setText(value);
  }
  setText(value:string):this{this.value=value;this.context.font=`${this.size}px ${FONT}`;const lines=this.wrapWidth?wrapText(value,this.wrapWidth,text=>this.context.measureText(text).width):value.split('\n');this.element.textContent=lines.join('\n');const width=Math.max(0,...lines.map(line=>this.context.measureText(line).width));super.setSize(width,Math.max(1,lines.length)*(this.size+5)-5);this.element.style.textAlign=this.align;return this;}
  get text():string{return this.value;}
  setAlign(value:string):this{this.align=value;this.element.style.textAlign=value;return this;}
  setColor(value:string):this{this.element.style.color=value;return this;}
}
