import type { FormalUiContext } from '../application/ports.ts';
import type { GameUI } from './game-ui.ts';
import { UiSurface, GOLD } from './widgets.ts';
import { UiNode, UiImage, uiMount, type UiSceneHost } from './dom/node.ts';
import { surfaceScreenPoint } from './panels/modal-placement.ts';
import type { DomLabel } from './dom/dom-ui.ts';
import { frameRect } from './viewport.ts';

/** 加载、阵亡和横屏提示共用互斥显示层，持有自己的节点与文字。 */
export class FormalModalView {
  private readonly scene:UiSceneHost;
  private readonly app:FormalUiContext;
  private readonly surface:UiSurface;
  private signature='';
  private progressBar?:UiNode;
  private cover?:UiImage;
  /** 加载页的标题、状态行与两枚按钮文字；加载背景和进度条仍由 Phaser 画。 */
  private domLoadingTitle?:DomLabel;
  private domLoading?:DomLabel;
  private domLoadingAction?:DomLabel;
  private domLoadingMenu?:DomLabel;
  /** 竖屏提示也放 overlay 层；横屏后立刻隐藏。 */
  private domPortraitIcon?:DomLabel;
  private domPortraitTitle?:DomLabel;
  private domPortraitHint?:DomLabel;
  /** 阵亡面板是全屏遮罩，`uiOcclusion` 会收起 screen 层，所以文字固定放 overlay。 */
  private domDefeatTitle?:DomLabel;
  private domDefeatMessage?:DomLabel;
  private domDefeatCancel?:DomLabel;
  private domDefeatConfirm?:DomLabel;
  private domDefeatCheckpoint?:DomLabel;
  private domDefeatLoad?:DomLabel;

  constructor(scene:UiSceneHost,app:FormalModalView['app']){
    this.scene=scene;this.app=app;this.surface=new UiSurface(scene,960,640,1000,'overlay');this.surface.visible(false);
    const domUi=app.domUi;if(domUi){
      // 加载页文字放在 overlay 层：它要活过全局遮挡开关，其余文字一律收起。
      this.domLoadingTitle=domUi.label('overlay','dom-loading-title',{x:.5,y:0}).setVisible(false);
      this.domLoading=domUi.label('overlay','dom-loading',{x:.5,y:0}).setVisible(false);
      this.domLoadingAction=domUi.label('overlay','dom-loading-action',{x:.5,y:.5}).setVisible(false);
      this.domLoadingMenu=domUi.label('overlay','dom-loading-menu',{x:.5,y:.5}).setVisible(false);
      this.domPortraitIcon=domUi.label('overlay','dom-portrait-icon',{x:.5,y:0}).setVisible(false);
      this.domPortraitTitle=domUi.label('overlay','dom-portrait-title',{x:.5,y:0}).setVisible(false);
      this.domPortraitHint=domUi.label('overlay','dom-portrait-hint',{x:.5,y:0}).setVisible(false);
      this.domDefeatTitle=domUi.label('overlay','dom-defeat-title',{x:.5,y:0}).setVisible(false);
      this.domDefeatMessage=domUi.label('overlay','dom-defeat-message').setVisible(false);
      this.domDefeatCancel=domUi.label('overlay','dom-defeat-button',{x:.5,y:.5}).setVisible(false);
      this.domDefeatConfirm=domUi.label('overlay','dom-defeat-button',{x:.5,y:.5}).setVisible(false);
      this.domDefeatCheckpoint=domUi.label('overlay','dom-defeat-button',{x:.5,y:.5}).setVisible(false);
      this.domDefeatLoad=domUi.label('overlay','dom-defeat-button',{x:.5,y:.5}).setVisible(false);
    }
  }
  sync(ui:GameUI,portrait:boolean,cover:boolean):void{
    const visible=portrait||!!ui.loadingState||!!ui.defeatState;
    this.surface.enabled=()=>!ui.suspended;
    this.surface.visible(visible);
    const signature=JSON.stringify([portrait,cover,ui.loadingState?.label,!!ui.loadingState?.retry,ui.canReturn,ui.defeatState,!!this.app.checkpoint?.available,!!this.app.resumeSlot]);
    const progress=Math.max(0,Math.min(1,ui.loadingState?.progress??0));
    if(signature!==this.signature){
      this.signature=signature;this.surface.clear();this.surface.layout(0);this.progressBar=undefined;
      this.cover?.destroy();this.cover=undefined;
      const v=this.surface,defeat=ui.defeatState,{width,height}=frameRect();
    if(portrait){v.rect(0,0,960,640,0x101d24,1);}
    else if(ui.loadingState){
      const file='/assets/ui/loading-background.webp';this.cover=new UiImage(this.scene,uiMount(this.scene,'overlay'),file).setDisplaySize(width,height).fitting().setDepth(998).setTint(0xaaaaaa);
      v.rect(200,531,560,5,0xeee2cc,.3);this.progressBar=v.rect(200,531,560*progress,5,0xe2c88d,1);
      if(ui.loadingState.retry){v.button('',380,552,200,48,()=>ui.loadingState?.retry?.());if(ui.canReturn)v.button('',26,20,180,48,()=>ui.onMenu?.());}
    }else if(defeat){
      v.frame(this.app.storyInterface?.assets??{},142,142,676,356);
      const guard=()=>!ui.suspended&&!ui.defeatState?.busy;
      // 读档进入剧情战斗时可能还没有任何检查点；按钮直接禁用，避免点下去才发现回不去。
      const noCheckpoint=!this.app.checkpoint.available;
      if(defeat.confirmation){
        v.button('',235,397,220,60,()=>ui.cancelDefeatConfirmation(),{disabled:defeat.busy,guard}).setData('label','取消');
        v.button('',505,397,220,60,()=>{void ui.confirmDefeat();},{disabled:defeat.busy,guard})
          .setData('label',defeat.busy?'正在恢复…':'确认');
      }else{
        v.button('',225,301,510,60,()=>ui.selectDefeatAction('checkpoint'),{disabled:noCheckpoint,guard}).setData('label','返回检查点');
        v.button('',225,392,510,60,()=>ui.selectDefeatAction('load'),{disabled:!this.app.resumeSlot,guard}).setData('label','读取存档');
      }
    }

    }
    this.progressBar?.setSize(560*progress,5);
    this.syncLoadingDom(ui,portrait);this.syncPortraitDom(portrait);this.syncDefeatDom(ui,portrait,cover);
  }
  invalidate():void{this.signature='';}
  key(event:KeyboardEvent):boolean{return this.surface.key(event);}
  destroy():void{
    this.cover?.destroy();this.cover=undefined;this.surface.destroy();
    for(const label of [this.domLoadingTitle,this.domLoading,this.domLoadingAction,this.domLoadingMenu,this.domPortraitIcon,this.domPortraitTitle,this.domPortraitHint,this.domDefeatTitle,this.domDefeatMessage,this.domDefeatCancel,this.domDefeatConfirm,this.domDefeatCheckpoint,this.domDefeatLoad])label?.remove();
  }
  private surfacePoint(x:number,y:number):{x:number;y:number;scale:number}{
    return surfaceScreenPoint(this.surface,x,y);
  }
  /** 竖屏提示改为 DOM：画布 1 倍渲染时 Phaser 文字会发虚。 */
  private syncPortraitDom(portrait:boolean):void{
    this.domPortraitIcon?.setVisible(portrait);
    this.domPortraitTitle?.setVisible(portrait);
    this.domPortraitHint?.setVisible(portrait);
    if(!portrait)return;
    const scale=this.surfacePoint(0,0).scale;
    const icon=this.surfacePoint(480,160),title=this.surfacePoint(480,310),hint=this.surfacePoint(480,370);
    this.domPortraitIcon?.setText('↻').setPosition(icon.x,icon.y)
      .setStyle({fontSize:`${Math.max(16,90*scale)}px`,color:GOLD});
    this.domPortraitTitle?.setText('横过手机，进入游戏').setPosition(title.x,title.y)
      .setStyle({fontSize:`${Math.max(12,32*scale)}px`,color:GOLD});
    this.domPortraitHint?.setText('请使用横屏继续').setPosition(hint.x,hint.y)
      .setStyle({fontSize:`${Math.max(12,24*scale)}px`,color:GOLD});
  }
  /** 阵亡面板的文字；全屏遮罩收起 screen 层时，overlay 里的这一份仍然可见。 */
  private syncDefeatDom(ui:GameUI,portrait:boolean,cover:boolean):void{
    const defeat=ui.defeatState;
    const labels=[this.domDefeatTitle,this.domDefeatMessage,this.domDefeatCancel,this.domDefeatConfirm,
      this.domDefeatCheckpoint,this.domDefeatLoad];
    if(!defeat||portrait||cover||ui.loadingState){for(const label of labels)label?.setVisible(false);return;}
    const scale=this.surfacePoint(0,0).scale;
    const title=this.surfacePoint(480,172);
    this.domDefeatTitle?.setText('队伍全员阵亡').setPosition(title.x,title.y)
      .setStyle({fontSize:`${34*scale}px`,color:'#e4c58b'}).setVisible(true);
    if(defeat.confirmation){
      const message=this.surfacePoint(190,242);
      this.domDefeatMessage?.setAnchor(0,0)
        .setText('返回最近的检查点？此后的物品、经验、金钱和任务进度将回退。')
        .setPosition(message.x,message.y)
        .setStyle({fontSize:`${25*scale}px`,color:'#f5eedf',width:`${580*scale}px`,whiteSpace:'pre-wrap',
          overflowWrap:'break-word',lineHeight:`${30*scale}px`}).setVisible(true);
      this.placeDefeatButton(this.domDefeatCancel,'取消',this.surfacePoint(345,427),scale,defeat.busy);
      this.placeDefeatButton(this.domDefeatConfirm,defeat.busy?'正在恢复…':'确认',
        this.surfacePoint(615,427),scale,defeat.busy);
      this.domDefeatCheckpoint?.setVisible(false);
      this.domDefeatLoad?.setVisible(false);
    }else{
      const noCheckpoint=!this.app.checkpoint.available,message=this.surfacePoint(480,230);
      this.domDefeatMessage?.setAnchor(.5,0)
        .setText(defeat.error??(noCheckpoint?'没有可返回的检查点，请读取存档。':'选择处理方式'))
        .setPosition(message.x,message.y)
        .setStyle({fontSize:`${23*scale}px`,color:defeat.error?'#eb9587':'#f5eedf',width:`${570*scale}px`,
          whiteSpace:'pre-wrap',overflowWrap:'break-word',lineHeight:`${28*scale}px`}).setVisible(true);
      this.domDefeatCancel?.setVisible(false);
      this.domDefeatConfirm?.setVisible(false);
      this.placeDefeatButton(this.domDefeatCheckpoint,'返回检查点',this.surfacePoint(480,331),scale,noCheckpoint);
      this.placeDefeatButton(this.domDefeatLoad,'读取存档',this.surfacePoint(480,422),scale,!this.app.resumeSlot);
    }
  }
  /** 按钮标签和 Phaser 按钮禁用时一样淡显示；底图与命中区仍由按钮自己画。 */
  private placeDefeatButton(label:DomLabel|undefined,text:string,point:{x:number;y:number},
    scale:number,disabled:boolean):void{
    label?.setText(text).setAnchor(.5,.5).setPosition(point.x,point.y)
      .setStyle({fontSize:`${22*scale}px`,color:disabled?'rgba(243,222,176,.4)':GOLD}).setVisible(true);
  }
  /** 加载页文字改由 DOM 输出：背景、进度条和按钮皮肤仍留在画布上。 */
  private syncLoadingDom(ui:GameUI,portrait:boolean):void{
    const state=ui.loadingState,show=!!state&&!portrait;
    this.domLoadingTitle?.setVisible(show);
    this.domLoading?.setVisible(show);
    this.domLoadingAction?.setVisible(show&&!!state?.retry);
    this.domLoadingMenu?.setVisible(show&&!!state?.retry&&ui.canReturn);
    if(!show||!state)return;
    const scale=this.surfacePoint(0,0).scale,title=this.surfacePoint(480,410),label=this.surfacePoint(480,476);
    this.domLoadingTitle?.setText('艾诺迪亚').setPosition(title.x,title.y)
      .setStyle({fontSize:`${42*scale}px`,color:GOLD});
    this.domLoading?.setText(state.label).setPosition(label.x,label.y)
      .setStyle({fontSize:`${22*scale}px`,color:GOLD,width:`${820*scale}px`,whiteSpace:'pre-wrap',
        overflowWrap:'break-word',textAlign:'center',lineHeight:`${27*scale}px`});
    const action=this.surfacePoint(480,576);
    this.domLoadingAction?.setText(state.actionLabel??'重新加载').setPosition(action.x,action.y)
      .setStyle({fontSize:`${20*scale}px`,color:GOLD});
    const menu=this.surfacePoint(116,44);
    this.domLoadingMenu?.setText('返回主菜单').setPosition(menu.x,menu.y)
      .setStyle({fontSize:`${20*scale}px`,color:GOLD});
  }}
