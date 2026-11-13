import { SCENE_KEYS } from '../application/scene-keys.ts';
import Phaser from 'phaser';
import type { StoryClassContext } from '../application/ports.ts';
import type { StoryClass } from '../domain/story-class.ts';
import { characterAssets, createCharacter } from '../rendering/characters.ts';
import { LiveCharacterPreview } from '../ui/phaser/live-character-preview.ts';
import type { UiImage } from '../ui/dom/node.ts';
import { loadSceneAssets } from '../rendering/scene-assets.ts';
import { UiSurface, loadUiImages } from '../ui/phaser/widgets.ts';
import type { ScrollArea } from '../ui/phaser/widgets.ts';
import type { DomLabel, DomUi } from '../ui/dom/dom-ui.ts';
import { screenRectToCanvas } from '../ui/viewport.ts';

/** 装配时传入的 StoryApp 比场景端口多一个 DOM 文字层；缺省时这一页不显示文字。 */
type StoryClassApp = StoryClassContext & { readonly domUi?: DomUi };

/** 职业选择页的 DOM 文字节点。 */
interface ClassDomText {
  title: DomLabel;
  descriptionClip: DomLabel;
  description: DomLabel;
  attributes: { name: DomLabel; value: DomLabel }[];
}

/** 960×640 页面坐标：说明滚动区和五行属性的位置。 */
const DESCRIPTION = { x: 80, y: 485, width: 622, height: 132 } as const;
const ATTRIBUTE = { nameX: 782, valueX: 894, top: 482, step: 28 } as const;
const GOLD = '#f3deb0';

export class StoryClassScene extends Phaser.Scene {
  private readonly app:StoryClassApp;
  private surface?:UiSurface;
  private preview?:LiveCharacterPreview;
  private background?:Phaser.GameObjects.Image;
  private selections:UiImage[]=[];
  private selected?:StoryClass;
  private request=new AbortController();
  /** DOM 是这一页唯一的文字路径：没有 DOM 文字层时宁可不显示文字，也不回退 Phaser 文字。 */
  private domText?:ClassDomText;
  /** 加载遮罩期间隐藏职业文案，避免 DOM 文字浮在加载页上。 */
  private domShown?:boolean;
  private descriptionScroll?:ScrollArea;
  /** 职业选择整屏独占键盘；场景关闭时注销，避免回到标题页后继续处理按键。 */
  private unregisterInput?:()=>void;
  constructor(app:StoryClassApp){super(SCENE_KEYS.classSelect);this.app=app;}
  create():void{
    this.request=new AbortController();this.selected=undefined;this.cameras.main.setBackgroundColor('#000000');
    this.scale.on('resize',this.layout,this);
    this.unregisterInput?.();this.unregisterInput=this.app.inputRouter.register('menu',this.routeKey,{exclusive:()=>true});
    this.events.once('shutdown',()=>{this.unregisterInput?.();this.unregisterInput=undefined;this.request.abort();this.scale.off('resize',this.layout,this);this.preview?.destroy();this.preview=undefined;this.background?.destroy();this.background=undefined;this.surface?.destroy();this.surface=undefined;this.selections=[];this.clearDomText();this.descriptionScroll=undefined;});
    const signal=this.request.signal;
    void this.open(signal).catch(error=>{if(!signal.aborted)this.app.ui.error((error as Error).message,()=>this.scene.restart());});
  }
  /** 加载开始/结束时同步隐藏或恢复职业文案；DOM 在画布之上，不主动让位会盖住加载页。 */
  override update():void{
    const shown=this.app.ui.ready&&!this.app.suspended;
    if(shown===this.domShown)return;
    this.domShown=shown;
    this.setDomVisible(shown);
    this.preview?.visible(shown);
  }
  private setDomVisible(shown:boolean):void{
    const dom=this.domText;if(!dom)return;
    dom.title.setVisible(shown);
    dom.descriptionClip.setVisible(shown);
    dom.description.setVisible(shown);
    this.selected?.attributes.forEach((_attribute,index)=>{
      const pair=dom.attributes[index];
      pair?.name.setVisible(shown);pair?.value.setVisible(shown);
    });
  }
  private routeKey=(event:KeyboardEvent):boolean=>{
    if(this.app.suspended)return false;
    if(event.key==='Escape'){this.app.returnToMenu?.();return true;}
    return this.surface?.key(event)??false;
  };
  private async open(signal:AbortSignal):Promise<void>{
    const catalog=this.app.storyClasses;
    // 预览角色可能由角色图集页承载，也可能仍是独立长条图；用同一份加载描述取真实纹理键。
    const previewAssets=catalog.classes.flatMap(entry=>characterAssets(entry.previewActor));
    await Promise.all([
      loadUiImages(this,[...Object.values(catalog.assets),...catalog.classes.map(entry=>entry.icon),'/assets/ui/menus/close.png','/assets/ui/menus/close-pressed.png'],value=>{if(!signal.aborted)this.app.ui.loading('正在准备职业…',value);}).then(lease=>{if(signal.aborted){lease.release();signal.throwIfAborted();}this.events.once('shutdown',()=>lease.release());}),
      loadSceneAssets(this,[{kind:'image',key:`class-background:${catalog.background}`,file:catalog.background},...previewAssets],()=>{})
    ]);
    signal.throwIfAborted();
    for(const key of new Set(previewAssets.map(asset=>asset.key)))this.textures.get(key).setFilter(Phaser.Textures.FilterMode.NEAREST);
    this.background=this.add.image(0,0,`class-background:${catalog.background}`).setOrigin(0).setScrollFactor(0).setDepth(0);
    this.surface=new UiSurface(this,960,640);
    this.preview=new LiveCharacterPreview(this,()=>{},actor=>createCharacter(this,actor,{id:'class-preview',actor:actor.id,x:0,y:0}),null);
    this.buildPage();this.choose(catalog.classes.find(entry=>entry.id===catalog.defaultClass)!);
    this.app.ui.loaded();this.app.syncLifecycle?.();this.app.prefetchStory?.();
  }
  private buildPage():void{
    const view=this.surface!,catalog=this.app.storyClasses;
    view.image(catalog.assets.title,263,20,434,56);
    const guard=()=>this.app.ui.ready&&!this.app.suspended;view.enabled=guard;
    view.button('',12,16,67,67,()=>this.app.returnToMenu?.(),{image:'/assets/ui/menus/close.png',pressed:'/assets/ui/menus/close-pressed.png',guard}).setData('label','返回主菜单');
    const positions=[[37,118],[70,251],[198,313],[648,313],[776,251],[809,118]];
    catalog.classes.forEach((character,index)=>{
      const [x,y]=positions[index];const button=view.button('',x,y,116,114,()=>this.choose(character),{image:character.icon,guard}).setData('label',character.name);
      this.selections.push(view.image(catalog.assets.selected,0,0,116,114,button).setBlendMode(Phaser.BlendModes.ADD).setVisible(false));
    });
    view.button('',334,388,292,77,()=>{
      // 加载页由正式界面场景画在画布上，DOM 文案要先让位，别浮到加载背景上面。
      this.domShown=false;this.setDomVisible(false);this.preview?.visible(false);
      this.app.startStory?.(this.selected!.id);
    },{image:catalog.assets.start,pressed:catalog.assets.startPressed,guard}).setData('label','开始游戏');
    view.rect(42,464,699,174,0x000000,.4);
    view.image(catalog.assets.descriptionTop,71,456);
    view.image(catalog.assets.panelLeft,32,455);view.image(catalog.assets.panelRight,712,455);
    const description=view.scroll(DESCRIPTION.x,DESCRIPTION.y,DESCRIPTION.width,DESCRIPTION.height);
    this.descriptionScroll=description;description.onScroll=()=>this.positionDescription();
    view.rect(767,464,151,174,0x000000,.4);
    view.image(catalog.assets.attributesTop,796,455);
    view.image(catalog.assets.panelLeft,757,454);view.image(catalog.assets.panelRight,888,454);
  }
  private choose(entry:StoryClass):void{
    if(this.selected===entry)return;
    this.selected=entry;
    this.selections.forEach((selection,index)=>{const shown=this.app.storyClasses.classes[index].id===entry.id;if(selection.visible!==shown)selection.setVisible(shown);});
    if(this.descriptionScroll)this.descriptionScroll.scrollTop=0;
    const clip=entry.previewActor.clips['idle-south']!;this.preview!.show(this.surface!,entry.previewActor,{x:480-clip.frameWidth*1.5,y:290-clip.originY*clip.frameHeight*3,width:clip.frameWidth*3,height:clip.frameHeight*3});
    this.preview!.visible(this.app.ui.ready&&!this.app.suspended);
    this.renderDomText(entry);this.layout();
  }
  private layout():void{
    this.surface?.layout(8);
    if(this.surface&&this.background){
      const matrix=this.surface.root.getWorldTransformMatrix(),point=matrix.transformPoint(80,0);
      const box=screenRectToCanvas(this,{x:point.x,y:point.y,width:800*matrix.scaleX,height:640*matrix.scaleY});
      this.background.setPosition(box.x,box.y).setDisplaySize(box.width,box.height);
    }
    this.preview?.layout();
    this.layoutDomText();
  }
  /** 页面坐标 → 画框内 CSS 坐标，图片与文字共用页面变换。 */
  private domMatrix():{scale:number;point:(x:number,y:number)=>{x:number;y:number}}{
    const matrix=this.surface?.root.getWorldTransformMatrix();
    if(!matrix)return{scale:1,point:(x,y)=>({x,y})};
    return{scale:matrix.scaleX,point:(x,y)=>{const point=matrix.transformPoint(x,y);return{x:point.x,y:point.y};}};
  }
  private ensureDomText():ClassDomText|undefined{
    const domUi=this.app.domUi;if(!domUi)return undefined;
    if(this.domText)return this.domText;
    const title=domUi.label('screen','dom-label dom-class-title',{x:.5,y:0}).setStyle({pointerEvents:'none'});
    const descriptionClip=domUi.label('screen','dom-label dom-class-description').setStyle({overflow:'hidden',pointerEvents:'none'});
    const description=domUi.label('screen','dom-label').setStyle({pointerEvents:'none'});
    descriptionClip.element.appendChild(description.element);
    this.domText={title,descriptionClip,description,attributes:[]};
    return this.domText;
  }
  private attributeLabels(index:number):{name:DomLabel;value:DomLabel}{
    const dom=this.domText!,domUi=this.app.domUi!;
    let pair=dom.attributes[index];
    if(!pair){
      pair={name:domUi.label('screen','dom-label dom-class-attribute-name'),value:domUi.label('screen','dom-label dom-class-attribute-value',{x:1,y:0})};
      dom.attributes[index]=pair;
    }
    return pair;
  }
  /** 职业名、说明和属性都只写 DOM；说明的换行宽度和行高按页面坐标乘当次缩放。 */
  private renderDomText(entry:StoryClass):void{
    const dom=this.ensureDomText();if(!dom)return;
    const shown=this.app.ui.ready&&!this.app.suspended;
    this.domShown=shown;
    dom.title.setText(entry.name).setVisible(shown);
    dom.description.setText(entry.description).setVisible(shown);
    dom.descriptionClip.setVisible(shown);
    dom.attributes.forEach(pair=>{pair.name.setVisible(false);pair.value.setVisible(false);});
    entry.attributes.forEach((attribute,index)=>{
      const pair=this.attributeLabels(index);
      pair.name.setText(attribute.name).setVisible(shown);
      pair.value.setText(String(attribute.value)).setVisible(shown);
    });
    this.layoutDomText();
  }
  private styleDomText(scale:number):void{
    const dom=this.domText;if(!dom)return;
    dom.title.setStyle({fontSize:`${28*scale}px`,lineHeight:`${28*scale}px`,color:GOLD});
    dom.description.setStyle({
      fontSize:`${23*scale}px`,lineHeight:`${28*scale}px`,color:'#ffffff',
      width:`${DESCRIPTION.width*scale}px`,whiteSpace:'pre-wrap',overflowWrap:'anywhere'
    });
    for(const pair of dom.attributes){
      pair.name.setStyle({fontSize:`${22*scale}px`,lineHeight:`${22*scale}px`,color:'#989898'});
      pair.value.setStyle({fontSize:`${22*scale}px`,lineHeight:`${22*scale}px`,color:'#ffffff'});
    }
  }
  private layoutDomText():void{
    const dom=this.domText,selected=this.selected;if(!dom||!selected)return;
    const {scale,point}=this.domMatrix();
    this.styleDomText(scale);
    const title=point(480,31);dom.title.setPosition(title.x,title.y);
    const origin=point(DESCRIPTION.x,DESCRIPTION.y);
    dom.descriptionClip.setStyle({width:`${DESCRIPTION.width*scale}px`,height:`${DESCRIPTION.height*scale}px`}).setPosition(origin.x,origin.y);
    const scroll=this.descriptionScroll;
    if(scroll){
      // 说明由浏览器按固定宽度换行；用实际排版高度决定滚动范围，避免文字被截在框外。
      const height=dom.description.element.getBoundingClientRect().height;
      scroll.setHeight(Math.max(1,height/Math.max(.0001,scale)));
    }
    this.positionDescription();
    selected.attributes.forEach((_attribute,index)=>{
      const pair=dom.attributes[index];if(!pair)return;
      const name=point(ATTRIBUTE.nameX,ATTRIBUTE.top+index*ATTRIBUTE.step);
      const value=point(ATTRIBUTE.valueX,ATTRIBUTE.top+index*ATTRIBUTE.step);
      pair.name.setPosition(name.x,name.y);
      pair.value.setPosition(value.x,value.y);
    });
  }
  private positionDescription():void{
    const dom=this.domText,scroll=this.descriptionScroll;if(!dom||!scroll)return;
    const {scale}=this.domMatrix();
    dom.description.setPosition(0,-scroll.scrollTop*scale);
  }
  private clearDomText():void{
    const dom=this.domText;if(!dom)return;
    dom.title.remove();dom.description.remove();dom.descriptionClip.remove();
    for(const pair of dom.attributes){pair.name.remove();pair.value.remove();}
    this.domText=undefined;
  }
}
