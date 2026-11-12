import type Phaser from 'phaser';
import { UI_EVENTS } from '../../application/ui-events.ts';
import { frameRect, readSafeArea } from '../viewport.ts';
import { COMMON_BUTTON } from '../common-button.ts';
import { domAssets } from './assets.ts';
import { UiNode,UiImage,UiText,uiMount,uiPointer,type UiPointer } from './node.ts';
import { VolumeSlider } from './volume-slider.ts';

export interface ScrollBarOptions {offset?:number;insetY?:number;width?:number}
export class UiSurface {
  readonly scene:Phaser.Scene;readonly width:number;readonly height:number;readonly depth:number;
  readonly root:UiNode;readonly staticRoot:UiNode;
  readonly mount:HTMLElement;
  readonly scrolls:ScrollArea[]=[];readonly sliders:VolumeSlider[]=[];
  private buttons:UiNode[]=[];private focusIndex=-1;private staticKey?:string;
  enabled=()=>true;
  private cancelInput=()=>{for(const button of this.buttons)if(button.active)button.cancelPress();for(const scroll of this.scrolls)scroll.cancelGesture();};
  constructor(scene:Phaser.Scene,width:number,height:number,depth=100,layer='screen'){
    this.scene=scene;this.width=width;this.height=height;this.depth=depth;
    this.mount=uiMount(scene,layer);this.root=new UiNode(scene,this.mount).setDepth(depth).setSize(width,height);this.staticRoot=new UiNode(scene,this.root);
    scene.game.events.on(UI_EVENTS.cancelInput,this.cancelInput);
  }
  layout(padding=12):void{
    const frame=frameRect(),safe=readSafeArea(),unit=this.scene.scale.width/Math.max(1,frame.width);
    const left=(safe.left+padding)*unit,right=(safe.right+padding)*unit,top=(safe.top+padding)*unit,bottom=(safe.bottom+padding)*unit;
    const factor=Math.max(.01,Math.min((this.scene.scale.width-left-right)/this.width,(this.scene.scale.height-top-bottom)/this.height));
    this.root.setScale(factor).setPosition(left+(this.scene.scale.width-left-right-this.width*factor)/2,top+(this.scene.scale.height-top-bottom-this.height*factor)/2);
    this.scrolls.forEach(scroll=>scroll.layout());
  }
  clear():void{this.sliders.splice(0).forEach(slider=>slider.destroy());this.scrolls.splice(0).forEach(scroll=>scroll.destroy());this.focusIndex=-1;for(const child of [...this.root.list])if(child!==this.staticRoot)child.destroy();this.buttons=this.buttons.filter(button=>button.active);}
  pruneDestroyed():void{this.buttons=this.buttons.filter(button=>button.active);}
  clearStatic():void{this.staticKey=undefined;this.staticRoot.removeAll(true);}
  staticLayer(key:string,draw:()=>void):void{if(this.staticKey===key)return;this.clearStatic();this.staticKey=key;draw();}
  destroy():void{this.scene.game.events.off(UI_EVENTS.cancelInput,this.cancelInput);this.clear();this.clearStatic();this.root.destroy();}
  visible(value:boolean):void{this.root.setVisible(value);this.scrolls.forEach(scroll=>scroll.syncVisibility());}
  image(file:string,x:number,y:number,width?:number,height?:number,parent=this.root):UiImage{return new UiImage(this.scene,parent).setPosition(x,y).resize(width,height).load(file);}
  imageCover(file:string,x:number,y:number,width:number,height:number,parent=this.root,anchorX=.5,anchorY=.5):UiImage{return this.image(file,x,y,width,height,parent).fitting(anchorX,anchorY);}
  imageContain(file:string,x:number,y:number,width:number,height:number,parent=this.root):UiImage{return this.image(file,x,y,width,height,parent).fitting(.5,.5,'contain');}
  text(value:string,x:number,y:number,width=0,size=22,color='#f3deb0',parent=this.root):UiText{return new UiText(this.scene,parent,value,x,y,width,size,color);}
  rect(x:number,y:number,width:number,height:number,color=0x21190f,alpha=.95,parent=this.root):UiNode{return new UiNode(this.scene,parent).setPosition(x,y).setSize(width,height).setFillStyle(color,alpha);}
  container(x=0,y=0,parent=this.root):UiNode{return new UiNode(this.scene,parent).setPosition(x,y);}
  button(label:string,x:number,y:number,width:number,height:number,action:()=>void,options:{image?:string;pressed?:string;fontSize?:number;disabled?:boolean;selected?:boolean;bare?:boolean;native?:boolean;pressedRect?:{x:number;y:number;width:number;height:number};parent?:UiNode;guard?:()=>boolean;hold?:{delayMs?:number;intervalMs?:number}}={}):UiNode{
    const parent=options.parent??this.root,result=this.container(x,y,parent).setSize(width,height),common=!options.image&&!options.bare;
    const draw=(file:string):UiImage=>{const image=this.image(file,0,0,options.native?undefined:width,options.native?undefined:height,result);if(options.native){const center=()=>image.setPosition((width-image.width)/2,(height-image.height)/2);center();image.on('loaded',center);}return image;};
    const face=options.image?draw(options.image):common?this.buttonFace(COMMON_BUTTON.image,width,height,result):undefined;
    const highlight=options.pressed?draw(options.pressed):common?this.buttonFace(COMMON_BUTTON.pressed,width,height,result):undefined;
    if(options.pressedRect){const area=options.pressedRect;highlight?.setPosition(area.x,area.y).setDisplaySize(area.width,area.height);}
    const text=label?this.text(label,width/2,height/2,width-12,options.fontSize??Math.min(22,height*.42),'#f3deb0',result).setOrigin(.5):undefined;
    const selected=common&&!!options.selected;highlight?.setVisible(selected);
    result.setInteractive();result.setData('uiAction',true).setData('label',label).setData('action',action).setData('guard',options.guard).setData('face',face).setData('highlight',highlight).setData('labelText',text).setData('selected',selected);
    let press:number|undefined,held=false,timer:ReturnType<typeof setTimeout>|undefined;
    const stop=()=>{clearTimeout(timer);timer=undefined;};
    const cancel=()=>{press=undefined;held=false;stop();highlight?.setVisible(selected);};
    const permitted=()=>this.enabled()&&this.root.shown&&result.input?.enabled&&parent.shown;
    const allowed=()=>permitted()&&(!options.guard||options.guard())&&this.scrolls.filter(scroll=>scroll.content===parent).every(scroll=>!scroll.moved);
    result.setInteractive(undefined,()=>!!allowed());
    result.setData('cancelPress',cancel).setData('setEnabled',(value:boolean)=>{if(value)result.setInteractive().setAlpha(1);else{cancel();result.disableInteractive().setAlpha(.4);}});
    const repeat=()=>{if(press===undefined||!allowed()){cancel();return;}held=true;action();if(result.active&&press!==undefined&&allowed())timer=setTimeout(repeat,options.hold?.intervalMs??80);};
    result.on('pointerdown',(pointer:UiPointer)=>{if(!permitted())return;cancel();press=pointer.id;highlight?.setVisible(true);if(options.hold)timer=setTimeout(repeat,options.hold.delayMs??350);});
    result.on('pointerup',(pointer:UiPointer)=>{if(press!==pointer.id)return;const repeated=held,run=allowed();cancel();if(!repeated&&run){this.scene.game.events.emit(UI_EVENTS.select);action();}});
    result.on('pointerupoutside',cancel).once('destroy',cancel);
    if(options.disabled)result.getData('setEnabled')(false);this.buttons.push(result);return result;
  }
  private buttonFace(file:string,width:number,height:number,parent:UiNode):UiNode{
    const group=this.container(0,0,parent).setSize(width,height),controller=group.controller;
    const draw=(source:NonNullable<ReturnType<typeof domAssets.peek>>)=>{
      const frame=source.frame,scale=Math.min(height/frame.height,width/(COMMON_BUTTON.cap*2));
      const cap=COMMON_BUTTON.cap*scale,faceHeight=frame.height*scale;
      const face=this.container(0,(height-faceHeight)/2,group).setSize(width,faceHeight).setData('file',file);
      Object.assign(face.element.style,{boxSizing:'border-box',borderStyle:'solid',borderColor:'transparent',
        borderWidth:`0 ${cap}px`,borderImageSource:`url(${JSON.stringify(source.url)})`,
        borderImageSlice:`0 ${COMMON_BUTTON.cap} fill`,borderImageWidth:`0 ${cap}px`,borderImageRepeat:'stretch'});
    };
    const cached=domAssets.peek(file);if(cached)draw(cached);
    void domAssets.acquire(file,controller.signal).then(lease=>{
      if(!group.active){lease.release();return;}group.once('destroy',()=>lease.release());
      if(!cached)draw(lease.source);
    }).catch(error=>{if(!controller.signal.aborted)console.error(error);});return group;
  }
  focusables():UiNode[]{return this.enabled()&&this.root.shown?this.buttons.filter(button=>button.shown&&button.input?.enabled):[];}
  focus(button:UiNode):void{for(const candidate of this.buttons)candidate.getData('highlight')?.setVisible(candidate===button||candidate.getData('selected'));this.scrolls.find(scroll=>scroll.content===button.parentContainer)?.reveal(button);}
  key(event:KeyboardEvent):boolean{const candidates=this.focusables();if(event.key==='Tab'&&candidates.length){event.preventDefault();this.focusIndex=this.focusIndex<0?(event.shiftKey?candidates.length-1:0):(this.focusIndex+(event.shiftKey?-1:1)+candidates.length)%candidates.length;this.focus(candidates[this.focusIndex]!);return true;}if((event.key==='Enter'||event.key===' ')&&this.focusIndex>=0&&candidates[this.focusIndex]){const button=candidates[this.focusIndex]!;if(button.getData('guard')&&!button.getData('guard')())return true;event.preventDefault();this.scene.game.events.emit(UI_EVENTS.select);button.getData('action')();return true;}return false;}
  private sliced(file:string,x:number,y:number,width:number,height:number,insetX:number,insetY:number,parent=this.root):UiNode{
    const group=this.container(x,y,parent).setSize(width,height),controller=group.controller;
    const draw=(source:NonNullable<ReturnType<typeof domAssets.peek>>)=>{
      group.removeAll(true);
      const f=source.frame,scale=insetY?1:Math.min(height/f.height,width/(insetX*2));
      const left=Math.min(insetX*scale,width/2),top=Math.min(insetY,height/2),xs=[0,insetX,f.width-insetX],ys=insetY?[0,insetY,f.height-insetY]:[0],sw=[insetX,f.width-insetX*2,insetX],sh=insetY?[insetY,f.height-insetY*2,insetY]:[f.height];
      const dx=[0,left,width-left],dy=insetY?[0,top,height-top]:[(height-f.height*scale)/2],dw=[left,width-left*2,left],dh=insetY?[top,height-top*2,top]:[f.height*scale];
      for(let row=0;row<ys.length;row++)for(let col=0;col<3;col++)new UiImage(this.scene,group).setData('file',file).setPosition(dx[col]!,dy[row]!).setDisplaySize(dw[col]!,dh[row]!).applySource({...source,frame:{x:f.x+xs[col]!,y:f.y+ys[row]!,width:sw[col]!,height:sh[row]!}});
    };
    const cached=domAssets.peek(file);if(cached)draw(cached);
    void domAssets.acquire(file,controller.signal).then(lease=>{
      if(!group.active){lease.release();return;}group.once('destroy',()=>lease.release());
      if(!cached)draw(lease.source);
    }).catch(error=>{if(!controller.signal.aborted)console.error(error);});return group;
  }
  nineSlice(file:string,x:number,y:number,width:number,height:number,inset:number):void{this.sliced(file,x,y,width,height,inset,inset);}
  textPlate(left:string,right:string,x:number,y:number,width:number,parent=this.root):void{this.image(left,x,y,9,34,parent);this.image(right,x+width-9,y,9,34,parent);this.rect(x+9,y,width-18,34,0x695031,.8,parent);}
  border(assets:Record<string,string>,x:number,y:number,width:number,height:number,parent=this.root):void{if(!assets['corner-nw'])return;this.image(assets['edge-horizontal']!,x+24,y,width-48,24,parent);this.image(assets['edge-horizontal']!,x+24,y+height-24,width-48,24,parent).setFlipY(true);this.image(assets['edge-vertical']!,x,y+24,24,height-48,parent);this.image(assets['edge-vertical']!,x+width-24,y+24,24,height-48,parent).setFlipX(true);for(const[part,dx,dy]of [['nw',0,0],['ne',width-24,0],['sw',0,height-24],['se',width-24,height-24]]as const)this.image(assets[`corner-${part}`]!,x+dx,y+dy,24,24,parent);}
  frame(assets:Record<string,string>,x:number,y:number,width:number,height:number,alpha=.96):void{this.rect(x,y,width,height,0x15100b,alpha);this.border(assets,x,y,width,height);}
  scroll(x:number,y:number,width:number,height:number,bleed=0,bar?:ScrollBarOptions):ScrollArea{const scroll=new ScrollArea(this,x,y,width,height,bleed,bar);this.scrolls.push(scroll);return scroll;}
  slider(label:string,x:number,y:number,width:number,value:number,onChange:(value:number)=>void,parent=this.root):VolumeSlider{const slider=new VolumeSlider(this.scene,parent,label,x,y,width,value,onChange,()=>this.enabled()&&this.root.shown&&parent.shown);this.sliders.push(slider);return slider;}
}

/** 裁剪与滚动条均由浏览器绘制；内容只移动，面板无需重建。 */
export class ScrollArea {
  readonly surface:UiSurface;readonly x:number;readonly y:number;readonly width:number;readonly height:number;readonly bleed:number;
  readonly layer:UiNode;readonly content:UiNode;
  private readonly track:UiNode;private readonly thumb:UiNode;
  private readonly controller=new AbortController();
  private offset=0;private extent=0;private shown=true;
  private press?:{id:number;y:number;offset:number};
  private listeners=new Set<()=>void>();onScroll?:()=>void;moved=false;
  guard=():boolean=>!this.moved&&this.visible&&this.surface.enabled()&&this.surface.root.shown;
  constructor(surface:UiSurface,x:number,y:number,width:number,height:number,bleed=0,bar?:ScrollBarOptions){
    this.surface=surface;this.x=x;this.y=y;this.width=width;this.height=height;this.bleed=bleed;
    this.layer=new UiNode(surface.scene,surface.mount).setDepth(surface.depth+1);this.layer.element.style.overflow='hidden';this.layer.element.style.pointerEvents='auto';
    this.content=new UiNode(surface.scene,this.layer);
    this.track=new UiNode(surface.scene,surface.mount).setDepth(surface.depth+2).setFillStyle(0,.38);
    this.thumb=new UiNode(surface.scene,surface.mount).setDepth(surface.depth+3).setFillStyle(0xe2c88d,.8);
    const signal=this.controller.signal,scene=surface.scene;
    this.layer.element.addEventListener('pointerdown',event=>{if(!surface.enabled()||!surface.root.shown)return;const p=uiPointer(scene,event);this.press={id:p.id,y:p.y,offset:this.offset};this.moved=false;},{signal,capture:true});
    window.addEventListener('pointermove',event=>{const p=uiPointer(scene,event),press=this.press;if(press?.id!==p.id)return;if(!p.isDown||!surface.enabled()||!surface.root.shown){this.cancelGesture();return;}const distance=(p.y-press.y)/surface.root.getWorldTransformMatrix().scaleY;if(Math.abs(distance)>8)this.moved=true;if(this.moved){const cancel=(node:UiNode)=>{node.cancelPress();for(const child of node.list)cancel(child);};for(const child of this.content.list)cancel(child);this.scrollTop=press.offset-distance;this.scrolled();event.preventDefault();}},{signal,capture:true,passive:false});
    for(const name of ['pointerup','pointercancel'])window.addEventListener(name,event=>{if(this.press?.id===(event as PointerEvent).pointerId)this.press=undefined;},{signal,capture:true});
    this.layer.element.addEventListener('wheel',event=>{if(!this.guardVisible()){event.preventDefault();event.stopPropagation();return;}this.scrollTop+=event.deltaY/surface.root.getWorldTransformMatrix().scaleY;this.scrolled();event.preventDefault();event.stopPropagation();},{signal,passive:false});
    window.addEventListener('blur',()=>this.cancelGesture(),{signal});
    this.bar=bar;this.layout();
  }
  private readonly bar?:ScrollBarOptions;
  addScrollListener(listener:()=>void):void{this.listeners.add(listener);}
  private scrolled():void{this.onScroll?.();for(const listener of this.listeners)listener();}
  get visible():boolean{return this.shown;}set visible(value:boolean){this.shown=value;this.syncVisibility();}
  syncVisibility():void{const shown=this.shown&&this.surface.root.shown;this.layer.setVisible(shown);this.updateBar();if(!shown)this.cancelGesture();}
  get scrollTop():number{return this.offset;}set scrollTop(value:number){this.offset=Math.max(0,Math.min(value,Math.max(0,this.extent-this.height)));this.layout();}
  setHeight(height:number):void{this.extent=height;this.scrollTop=this.offset;}
  contains(pointer:{x:number;y:number}):boolean{return this.guardVisible()&&this.layer.getBounds().contains(pointer.x,pointer.y);}
  private guardVisible():boolean{return this.shown&&this.surface.enabled()&&this.surface.root.shown;}
  cancelGesture():void{this.press=undefined;this.moved=true;}
  reveal(button:UiNode):void{const height=button.input?.hitArea.height??button.height;if(button.y<this.offset)this.scrollTop=button.y;else if(button.y+height>this.offset+this.height)this.scrollTop=button.y+height-this.height;this.scrolled();}
  layout():void{const m=this.surface.root.getWorldTransformMatrix(),p=m.transformPoint(this.x-this.bleed,this.y-this.bleed);this.layer.setPosition(p.x,p.y).setScale(m.scaleX,m.scaleY).setSize(this.width+this.bleed*2,this.height+this.bleed*2);this.content.setPosition(this.bleed,this.bleed-this.offset);this.syncVisibility();}
  private updateBar():void{const shown=this.shown&&this.surface.root.shown&&this.extent>this.height+.5;this.track.setVisible(shown);this.thumb.setVisible(shown);if(!shown)return;const m=this.surface.root.getWorldTransformMatrix(),p=m.transformPoint(this.x,this.y),scale=m.scaleX,width=Math.max(2,(this.bar?.width??4)*scale),height=Math.max(0,this.height*scale-(this.bar?.insetY??0)*scale*2),thumb=Math.min(height,Math.max(18*scale,height*this.height/this.extent)),x=p.x+this.width*scale-width-scale+(this.bar?.offset??0)*scale,y=p.y+(this.bar?.insetY??0)*scale;this.track.setPosition(x,y).setSize(width,height);this.thumb.setPosition(x,y+(height-thumb)*this.offset/(this.extent-this.height)).setSize(width,thumb);}
  destroy():void{this.controller.abort();this.listeners.clear();this.layer.destroy();this.track.destroy();this.thumb.destroy();}
}
