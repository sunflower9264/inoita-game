import { domAssets } from '../ui/dom/assets.ts';
import { uiMount, type UiPointer } from '../ui/dom/node.ts';
import { UiNode, UiImage } from '../ui/dom/node.ts';
import { SCENE_KEYS } from '../application/scene-keys.ts';
import { UI_EVENTS } from '../application/ui-events.ts';
import Phaser from 'phaser';
import { createCharacter } from '../rendering/characters.ts';
import type { StoryApp } from '../app.ts';
import { uiOcclusion, type GameUI, type GameUiView } from '../ui/game-ui.ts';
import { UiSurface,loadUiImages,GOLD,type ScrollArea } from '../ui/phaser/widgets.ts';
import { FONT, TEXT_COLORS } from '../ui/text-style.ts';
import { dialoguePages, layoutDialogueText, layoutMarkupText, revealedRuns, type DialoguePage, type DialogueTextLayout } from '../ui/dialogue-text.ts';
import { instantMessagePoint } from '../ui/instant-message.ts';
import { layoutChoicePanel } from '../ui/choice-layout.ts';
import { SceneUiAssets } from '../ui/phaser/ui-asset-host.ts';
import { QuestPopup } from '../ui/phaser/quest-popup.ts';
import { screenCoverage } from '../ui/phaser/modal-placement.ts';
import { frameRect, readSafeArea } from '../ui/viewport.ts';
import type { AssetLease } from '../application/assets.ts';
import type { DomLabel } from '../ui/dom/dom-ui.ts';

/** 对白框的基础字色。`$B` 与未带色码的文字都用它——不是任务窗口的白色。 */
const DIALOGUE_TEXT_COLOR='#f5eedf';
/** 与 `UiSurface.text` 的 `lineSpacing: 5` 一致；DOM 行的位置也按这个间距排。 */
const UI_LINE_SPACING=5;
/** 选项里一段 DOM 文字的固定横向位置和滚动前的纵向位置，滚动时只改纵向偏移。 */
interface ChoiceDomPlacement{label:DomLabel;x:number;y:number}
interface ChoiceDomScroll{clip:DomLabel;labels:DomLabel[];placements:ChoiceDomPlacement[];scroll?:ScrollArea;top:number;scale:number}
/** 选项面板的 DOM 文字节点池；整个场景生命周期内复用，内容变化只改文本。 */
interface ChoiceDom{prompt:DomLabel[];description:ChoiceDomScroll;list:ChoiceDomScroll}

/** 正式界面使用独立相机；地图跟随、缩放与暂停不改变界面坐标。 */
export class FormalUiScene extends Phaser.Scene implements GameUiView {
  private readonly app:StoryApp;
  private surface!:UiSurface;
  private questPopup!:QuestPopup;
  private signature='';
  /** 当前画面是否是可增量的普通对白外壳（框、立绘、说话人不重建）。 */
  private dialogueShell=false;
  /** 对白正文（当前页文本）的签名；只变这里时只更新正文 Text。 */
  private dialogueBodySignature='';
  /** 对白正文按色段拆成多个 Text：原版控制码不显示，字色随 `$X` 变化。 */

  private dialogueLayout?:DialogueTextLayout;
  private progressBar?:UiNode;
  private baseLease?:AssetLease;
  /** 菜单图片与立绘的租约账，`prepareMenuCore` 通过 `app.uiAssets` 找到它。 */
  private readonly uiAssets=new SceneUiAssets(this);
  /** 场景注入完成前拿不到 this.events，销毁监听放到 create 里只挂一次。 */
  private uiAssetsBound=false;
  private background!:UiNode;
  private cover?:UiImage;
  private blocker!:UiNode;
  /** 原版 `INSTANTMSG` 的屏幕提示；不进 surface，因为它要逐帧淡出而 surface 每次 sync 整体重建。 */
  private domInstant?:DomLabel;
  private domToast?:DomLabel;
  private domSpeaker?:DomLabel;
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
  private dialogueDomRuns:DomLabel[]=[];
  /** 选项面板的 DOM 文字；提示、说明和每个选项各用一组复用的标签。 */
  private choiceDom?:ChoiceDom;
  /** 排版测量用的离屏画布；不进 Phaser 渲染，也不创建 Text。 */
  private measureCanvas?:HTMLCanvasElement;
  /** 场景键盘只做一次桥接：原始事件交给全局 router，自己不再按页面各订阅一份。 */
  private readonly bridgeKey=(event:KeyboardEvent):void=>{this.app.inputRouter.dispatch(event);};
  private readonly resizeView=():void=>{
    this.signature='';this.layoutDomText();this.sync(this.app.ui);this.app.ui.reflowDialogue();
  };
  private unregisterInput?:()=>void;
  constructor(app:StoryApp){super(SCENE_KEYS.formalUi);this.app=app;}
  create():void{
    if(!this.uiAssetsBound){this.uiAssetsBound=true;this.events.once(Phaser.Scenes.Events.DESTROY,()=>this.uiAssets.releaseResident());}
    this.background=new UiNode(this,uiMount(this,'overlay')).setSize(1,1).setFillStyle(0,1).setDepth(998);this.blocker=new UiNode(this,uiMount(this,'overlay')).setSize(1,1).setDepth(999).setInteractive();
    this.surface=new UiSurface(this,960,640,1000,'overlay');this.app.ui.view=this;this.app.uiAssets=this.uiAssets;
    const domUi=this.app.domUi;
    if(domUi){
      this.domInstant=domUi.label('screen','dom-instant',{x:.5,y:0});
      this.domToast=domUi.label('screen','dom-toast',{x:.5,y:0});
      this.domSpeaker=domUi.label('overlay','dom-speaker');
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
      this.layoutDomText();
    }
    this.questPopup=new QuestPopup(this,()=>this.app.ui.ready&&!this.app.ui.suspended,this.app.domUi);
    this.surface.enabled=()=>!this.app.ui.suspended;
    this.scale.on('resize',this.resizeView);
    // 场景里只保留这一份键盘监听：它只把原始事件交给 router，由作用域决定消费者。
    window.addEventListener('keydown',this.bridgeKey);
    this.unregisterInput=this.app.inputRouter.register('modal',this.routeKey,{
      active:()=>this.app.ui.mode==='game',
      // 弹层、加载、选项和挂起时独占键盘，菜单和世界不再重复消费。
      exclusive:()=>this.app.ui.suspended||this.app.ui.worldRebuildCover||this.app.ui.defeated
        ||!!this.app.ui.quest||!!this.app.ui.loadingState||!!this.app.ui.choices
    });
    this.game.canvas.addEventListener('pointercancel',this.cancelInput);this.game.events.once('destroy',()=>this.game.canvas.removeEventListener('pointercancel',this.cancelInput));
    this.events.once('shutdown',()=>{this.scale.off('resize',this.resizeView);this.unregisterInput?.();this.unregisterInput=undefined;window.removeEventListener('keydown',this.bridgeKey);this.uiAssets.releaseContent();this.surface.destroy();this.questPopup.destroy();this.baseLease?.release();this.domInstant?.remove();this.domInstant=undefined;this.domToast?.remove();this.domToast=undefined;this.domSpeaker?.remove();this.domSpeaker=undefined;for(const label of [this.domLoadingTitle,this.domLoading,this.domLoadingAction,this.domLoadingMenu,this.domPortraitIcon,this.domPortraitTitle,this.domPortraitHint,this.domDefeatTitle,this.domDefeatMessage,this.domDefeatCancel,this.domDefeatConfirm,this.domDefeatCheckpoint,this.domDefeatLoad])label?.remove();this.domLoadingTitle=undefined;this.domLoading=undefined;this.domLoadingAction=undefined;this.domLoadingMenu=undefined;this.domPortraitIcon=undefined;this.domPortraitTitle=undefined;this.domPortraitHint=undefined;this.domDefeatTitle=undefined;this.domDefeatMessage=undefined;this.domDefeatCancel=undefined;this.domDefeatConfirm=undefined;this.domDefeatCheckpoint=undefined;this.domDefeatLoad=undefined;for(const run of this.dialogueDomRuns)run.remove();this.dialogueDomRuns.length=0;this.removeChoiceDom();});
    void loadUiImages(this,['/assets/ui/loading-background.webp']).then(lease=>{this.baseLease=lease;this.signature='';this.sync(this.app.ui);}).catch(console.error);
    this.app.storyUI.attach(this,actor=>createCharacter(this,actor,{id:'menu-preview',actor:actor.id,x:0,y:0}));this.sync(this.app.ui);
  }
  /**
   * 正式界面的弹层键盘：守卫顺序保持原样。返回 `true` 表示这一层消费了按键；
   * 返回 `false` 时由 router 继续交给菜单或世界，只有独占状态会挡住它们。
   */
  private routeKey=(event:KeyboardEvent):boolean=>{
    if(this.app.ui.suspended||this.app.ui.worldRebuildCover)return false;
    // 键位捕获期间键盘归设置面板：Enter / 空格不能顺手触发菜单按钮。
    if(this.app.ui.keyBindingEditing)return false;
    // 游戏内菜单打开时由 StoryUI 的 menu 作用域接管，正式界面不抢先处理 Tab/Enter。
    if(this.app.storyUI?.menuOpen)return false;
    if(this.app.ui.defeated&&event.key==='Escape'){event.preventDefault();this.app.ui.cancelDefeatConfirmation();return true;}
    if(this.app.ui.quest){this.questPopup.key(event);return true;}
    if(event.key==='Enter'||event.key===' '){if(this.app.ui.canSkip){event.preventDefault();this.app.ui.advance();return true;}}
    return this.surface.key(event);
  };
  private cancelInput=():void=>this.app.ui.resetInput();
  resetInput():void{this.game.events.emit(UI_EVENTS.cancelInput);}
  override update(_time:number,delta:number):void{this.app.ui.tick(delta);this.syncInstantMessage();this.updateChoiceDomScroll();}
  /**
   * 原版 `INSTANTMSG_Draw`：水平居中、纵向三成屏高，同一段文字带 1px 深色描边，末段按台阶淡出。
   * 对白与弹窗期间不显示（原版这时画的是事件层界面）；菜单遮罩在 998 层，本来就压住它。
   */
  private syncInstantMessage():void{
    const ui=this.app.ui,message=ui.instant.text;
    const hidden=!message||!!ui.loadingState||ui.defeated||ui.suspended||ui.worldRebuildCover||!!ui.dialogueLine||!!ui.choices||!!ui.quest;
    if(!this.domInstant)return;
    this.domInstant.setVisible(!hidden);
    if(hidden)return;
    this.domInstant.setText(message!);this.domInstant.setStyle({opacity:String(ui.instant.alpha)});
  }
  private layoutDomText():void{
    const scale=this.surfacePoint(0,0).scale,frame=frameRect(),point=instantMessagePoint(frame.width,frame.height);
    this.domInstant?.setPosition(point.x,point.y);
    this.domInstant?.setStyle({fontSize:`${Math.max(12,24*scale)}px`,color:GOLD,textShadow:'0 1px 2px rgba(0,0,0,.7)'});
    this.domToast?.setStyle({fontSize:`${Math.max(12,24*scale)}px`,width:`${600*scale}px`,minHeight:`${90*scale}px`,
      padding:`${14*scale}px ${20*scale}px 0`,background:'rgba(16,29,36,.95)',color:'#f5f0df',textAlign:'center',whiteSpace:'pre-wrap'});
  }
  async preloadPortraits(files:string[],signal:AbortSignal,progress:(value:number)=>void):Promise<void>{
    const missing=[...new Set(files)].filter(file=>!domAssets.peek(file));
    if(!missing.length){progress(1);return;}
    await this.uiAssets.preloadFiles(missing,signal,progress);
  }
  async portrait(file:string,signal?:AbortSignal):Promise<void>{
    signal?.throwIfAborted();if(domAssets.peek(file))return;const lease=await loadUiImages(this,[file],undefined,signal);if(signal?.aborted){lease.release();signal.throwIfAborted();}this.uiAssets.retain(lease);
  }
  /**
   * 对白按物理屏幕满幅绘制，坐标以 `-offset`（物理左缘）为基准；姓名、正文与立绘
   * 改用安全区左右缘，避免刘海压住内容，背景本身仍满幅。
   */
  private dialogueSafeEdges():{left:number;right:number}{
    const frame=frameRect(),safe=readSafeArea(),scale=this.surface.root.scaleX||1;
    const physicalLeft=-this.surface.root.x/scale;
    return{left:physicalLeft+safe.left/scale,right:physicalLeft+(frame.width-safe.right)/scale};
  }
  private textBox(ui:GameUI):{x:number;y:number;width:number;lines:number;size:number}{
    const edges=this.dialogueSafeEdges(),usable=edges.right-edges.left;
    if(ui.dialogueLine?.presentation==='screen')return{x:edges.left+60,y:240,width:usable-120,lines:4,size:28};
    const left=ui.dialogueLine?.actor===ui.playerActor&&!!ui.portraitFile;
    return{x:edges.left+(left?452:30),y:478,width:usable-(ui.portraitFile?482:60),lines:3,size:24};
  }
  /**
   * 用真实 Text 的上下文量文字：与 Phaser 自己排版时的度量一致，分页和绘制才不会各切各的。
   * 行高取 `Text.height + lineSpacing`——`UiSurface.text` 固定 `lineSpacing: 5`，
   * 逐行画的间距要和它原来一次画整段时一样。探测用的 Text 用完即毁，不会留在画面上。
   */
  private dialogueMetrics<T>(size:number,use:(measure:(text:string)=>number,lineHeight:number)=>T):T{
    const probe=this.surface.text('测',0,0,0,size);
    try{return use(text=>probe.context.measureText(text).width,probe.height+5);}
    finally{probe.destroy();}
  }
  /** 选项等非对白文本：用浏览器字体度量排版，保留色码换色和显式换行。 */
  private uiTextMetrics<T>(size:number,use:(measure:(text:string)=>number,lineHeight:number)=>T):T{
    if(typeof document==='undefined')return use(text=>text.length*size,size+UI_LINE_SPACING);
    const canvas=this.measureCanvas??=document.createElement('canvas'),context=canvas.getContext('2d');
    if(!context)return use(text=>text.length*size,size+UI_LINE_SPACING);
    context.font=`${size}px ${FONT}`;
    // 与 Phaser Text 同口径：测试串的字体上下边界加行距。
    const metrics=context.measureText('|MÃ‰qgy');
    const lineHeight=(metrics.actualBoundingBoxAscent??size*.8)+(metrics.actualBoundingBoxDescent??size*.2)+UI_LINE_SPACING;
    return use(text=>context.measureText(text).width,lineHeight);
  }
  private markupLayout(value:string,size:number,width:number):DialogueTextLayout&{lineHeight:number}{
    return this.uiTextMetrics(size,(measure,lineHeight)=>({...layoutMarkupText(value,GOLD,width,measure),lineHeight}));
  }
  paginate(ui:GameUI,text:string):DialoguePage[]{
    const box=this.textBox(ui);
    return this.dialogueMetrics(box.size,measure=>dialoguePages(text,{width:box.width,lines:box.lines,measure}));
  }
  renderText(ui:GameUI):void{
    const layout=this.dialogueLayout;if(!layout)return;
    // 排版按整页算好，揭示只是把每个色段的文字截短——位置全程不动，不会随揭示重排。
    let index=0;
    for(const line of revealedRuns(layout,ui.revealed))
      for(const run of line.runs){const target=this.dialogueDomRuns[index++];if(target)target.setText(run.text);}
  }
  /**
   * 只重建对白正文：框、立绘、说话人和控件留在原地，正文 Text 按位置复用。
   * Phaser 的每个 Text 都有自己的画布纹理；翻页时销毁再新建几十个是演出卡顿的主因。
   */
  private surfacePoint(x:number,y:number):{x:number;y:number;scale:number}{
    const m=this.surface.root.getWorldTransformMatrix();
    return{x:(m.tx+x*m.scaleX),y:(m.ty+y*m.scaleY),scale:m.scaleX};
  }
  /**
   * 选项的 DOM 文字容器：滚动区各包一层 `overflow:hidden`，里面的标签只按
   * “排版位置 − 滚动量”移动。标签节点只建一次，之后反复改文本和位置。
   */
  private ensureChoiceDom():ChoiceDom|undefined{
    const domUi=this.app.domUi;if(!domUi)return undefined;
    if(this.choiceDom)return this.choiceDom;
    const clip=()=>domUi.label('overlay','dom-label dom-choice-clip').setStyle({overflow:'hidden',pointerEvents:'none'});
    this.choiceDom={prompt:[],
      description:{clip:clip(),labels:[],placements:[],top:0,scale:1},
      list:{clip:clip(),labels:[],placements:[],top:0,scale:1}};
    return this.choiceDom;
  }
  private hideChoiceDom():void{
    const state=this.choiceDom;if(!state)return;
    for(const label of state.prompt)label.setVisible(false);
    state.description.clip.setVisible(false);
    state.list.clip.setVisible(false);
  }
  /** 重建 Phaser 面板前先断开旧滚动区；节点池保留到下次选项出现。 */
  private resetChoiceDom():void{
    const state=this.choiceDom;if(!state)return;
    state.description.scroll=undefined;state.description.placements=[];
    state.list.scroll=undefined;state.list.placements=[];
    this.hideChoiceDom();
  }
  private removeChoiceDom():void{
    const state=this.choiceDom;if(!state)return;
    state.prompt.splice(0).forEach(label=>label.remove());
    state.description.labels.splice(0).forEach(label=>label.remove());
    state.list.labels.splice(0).forEach(label=>label.remove());
    state.description.clip.remove();state.list.clip.remove();
    this.choiceDom=undefined;
  }
  private placeChoiceLabel(pool:DomLabel[],index:number,parent:HTMLElement,text:string,
    x:number,y:number,size:number,color:string):DomLabel{
    const domUi=this.app.domUi!;
    let label=pool[index];
    if(!label){label=domUi.label('overlay','dom-label');pool.push(label);}
    if(label.element.parentElement!==parent)parent.appendChild(label.element);
    return label.setText(text).setStyle({fontSize:`${Math.max(10,size)}px`,color}).setPosition(x,y).setVisible(true);
  }
  private hideChoiceLabels(labels:DomLabel[],used:number):void{
    for(let index=used;index<labels.length;index++)labels[index]!.setVisible(false);
  }
  /** 滚动区拖动、滚轮或键盘聚焦后，只挪纵向偏移，不重排文字。 */
  private updateChoiceDomScroll():void{
    const state=this.choiceDom;if(!state)return;
    for(const group of [state.description,state.list]){
      const scroll=group.scroll;if(!scroll)continue;
      const top=scroll.scrollTop;if(top===group.top)continue;
      group.top=top;
      for(const placement of group.placements)placement.label.setPosition(placement.x,placement.y-top*group.scale);
    }
  }
  private hideDialogueDom():void{
    this.domSpeaker?.setVisible(false);
    for(const run of this.dialogueDomRuns)run.setVisible(false);
  }
  private renderDialogueBody(ui:GameUI):void {
    const domUi=this.app.domUi;if(!domUi)return;
    const box=this.textBox(ui),screen=ui.dialogueLine?.presentation==='screen';
    const next:{text:string;x:number;y:number;color:string}[]=[];
    this.dialogueMetrics(box.size,(measure,lineHeight)=>{
      const layout=layoutDialogueText(ui.page,DIALOGUE_TEXT_COLOR,box.width,measure);
      this.dialogueLayout=layout;
      const top=screen?320-layout.lines.length*lineHeight/2:box.y;
      layout.lines.forEach((line,index)=>{
        const offset=screen?(box.width-line.width)/2:0;
        for(const run of line.runs)next.push({text:run.text,x:box.x+offset+run.x,y:top+index*lineHeight,color:run.key});
      });
    });
    for(const [index,run] of next.entries()){
      let target=this.dialogueDomRuns[index];
      if(!target){target=domUi.label('overlay','dom-dialogue-run');this.dialogueDomRuns.push(target);}
      const point=this.surfacePoint(run.x,run.y);
      target.setText(run.text).setPosition(point.x,point.y);
      target.setStyle({fontSize:`${Math.max(10,box.size*point.scale)}px`,color:run.color});
      target.setVisible(true);
    }
    for(let index=next.length;index<this.dialogueDomRuns.length;index++)this.dialogueDomRuns[index].setVisible(false);
    this.renderText(ui);
  }
  sync(ui:GameUI):void{
    if(!this.surface)return;
    if(!ui.dialogueLine||uiOcclusion(ui)||ui.quest||ui.choices)this.hideDialogueDom();
    const portrait=window.innerHeight>window.innerWidth;
    const cover=ui.worldRebuildCover;
    const quest=ui.mode==='game'&&!portrait&&!cover&&!ui.loadingState&&!ui.defeated?ui.quest:undefined;
    this.questPopup.sync(quest,this.app.storyInterface?.assets??{},id=>ui.questItemName?.(id)??id);
    const progress=Phaser.Math.Clamp(ui.loadingState?.progress??0,0,1);
    const showSkip=ui.mode==='game'&&ui.ready&&!ui.suspended&&!portrait&&!cover&&!ui.loadingState&&!ui.defeated&&!ui.choices&&!ui.quest&&!!this.app.director?.canSkip;
    const defeat=ui.defeatState;
    // 全屏遮罩出现时统一收起 world/hud/screen 的文字；加载页文字在 overlay 层，不受影响。
    this.app.domUi?.setOccluded(uiOcclusion(ui));
    // 正文不进整屏签名：同一说话人的下一句只换正文，不重建框、立绘和控件。
    // 外壳只由说话人、演员、立绘和呈现方式决定；文本变化交给 bodySignature。
    const shell=ui.dialogueLine
      ?JSON.stringify([ui.dialogueLine.speaker,ui.dialogueLine.actor,ui.dialogueLine.portrait??null,ui.dialogueLine.presentation??'box'])
      :null;
    const bodySignature=JSON.stringify([ui.page,ui.dialogueLine?.presentation]);
    const signature=JSON.stringify([ui.mode,ui.loadingState?.label,!!ui.loadingState?.retry,ui.failed,ui.suspended,portrait,cover,defeat,ui.toastMessage,shell,ui.portraitFile,ui.canSkip,showSkip,ui.choices?.prompt,ui.choices?.description,ui.choices?.options,ui.quest?.definition.id,ui.quest?.kind]);
    if(signature===this.signature){
      if(this.dialogueShell&&!uiOcclusion(ui)&&bodySignature!==this.dialogueBodySignature){this.dialogueBodySignature=bodySignature;this.renderDialogueBody(ui);}
      this.progressBar?.setSize(560*progress,5);this.syncLoadingDom(ui,portrait);this.syncPortraitDom(portrait);this.syncDefeatDom(ui,portrait,cover);return;
    }
    this.signature=signature;this.dialogueShell=false;this.resetChoiceDom();
    const v=this.surface;v.clear();v.layout(0);this.dialogueLayout=undefined;this.progressBar=undefined;v.visible(true);
    const modal=portrait||!!ui.loadingState||!!defeat||cover,{width,height}=frameRect();
    this.background.setVisible(modal).setSize(width,height).setFillStyle(0x000000,!!defeat&&!portrait&&!ui.loadingState&&!cover ? .65:1);
    this.blocker.setVisible((modal||!!ui.quest||!!ui.dialogueLine||!!ui.choices)).setSize(width,height);if(this.blocker.input)this.blocker.input.hitArea.setSize(width,height);
    this.cover?.destroy();this.cover=undefined;
    const block=()=>{v.rect(0,0,960,640,0,0).setInteractive().on('pointerdown',(pointer:UiPointer)=>ui.pressDialogue(pointer.id)).on('pointerup',(pointer:UiPointer)=>ui.releaseDialogue(pointer.id)).on('pointerupoutside',()=>ui.resetInput());};
    if(portrait){v.rect(0,0,960,640,0x101d24,1);block();}
    else if(ui.loadingState){
      const file='/assets/ui/loading-background.webp';this.cover=new UiImage(this,uiMount(this,'overlay'),file).setDisplaySize(width,height).fitting().setDepth(998).setTint(0xaaaaaa);
      block();v.rect(200,531,560,5,0xeee2cc,.3);this.progressBar=v.rect(200,531,560*progress,5,0xe2c88d,1);
      if(ui.loadingState.retry){v.button('',380,552,200,48,ui.loadingState.retry);if(ui.canReturn)v.button('',26,20,180,48,()=>ui.onMenu?.());}
    }else if(defeat){
      block();v.frame(this.app.storyInterface?.assets??{},142,142,676,356);
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
    else if(!cover&&ui.choices&&!ui.quest){
      block();const choices=ui.choices;
      // 选项竖排：整行宽度、按钮高度按标签实际换行后的高度算，文字不会压在按钮框外。
      const left=30,width=900,optionFontSize=22;
      // 提示、说明和选项标签都按原版控制码排版：`$X` 换色、`&N` 换行；文字全部交给 DOM。
      const promptLayout=this.markupLayout(choices.prompt,24,width);
      const descriptionLayout=choices.description?this.markupLayout(choices.description,22,width):undefined;
      const optionLayouts=choices.options.map(option=>this.markupLayout(option.label,optionFontSize,width-12));
      // 行距只加在行与行之间，末行之后不再多算一截。
      const optionTextHeights=optionLayouts.map(option=>option.lines.length?option.lines.length*option.lineHeight-UI_LINE_SPACING:0);
      const layout=layoutChoicePanel({
        promptHeight:promptLayout.lines.length*promptLayout.lineHeight,
        descriptionHeight:descriptionLayout&&descriptionLayout.lines.length*descriptionLayout.lineHeight,
        optionTextHeights,
      });
      const panel=v.rect(0,layout.top,960,layout.panelHeight,0x000000,.86);v.root.sendToBack(panel);
      const dom=this.ensureChoiceDom(),domLayer=this.app.domUi?.layer('overlay');
      const scale=this.surfacePoint(0,0).scale;
      if(dom&&domLayer){
        let cursor=0;
        promptLayout.lines.forEach((line,index)=>line.runs.forEach(run=>{
          const point=this.surfacePoint(left+run.x,layout.promptY+index*promptLayout.lineHeight);
          this.placeChoiceLabel(dom.prompt,cursor++,domLayer,run.text,point.x,point.y,24*scale,run.key);
        }));
        this.hideChoiceLabels(dom.prompt,cursor);
      }
      if(descriptionLayout&&layout.descriptionY!==undefined&&layout.descriptionView!==undefined){
        const scroll=v.scroll(left,layout.descriptionY,width,layout.descriptionView);
        scroll.setHeight(descriptionLayout.lines.length*descriptionLayout.lineHeight);
        if(dom){
          const origin=this.surfacePoint(left,layout.descriptionY);
          dom.description.clip.setStyle({width:`${width*scale}px`,height:`${layout.descriptionView*scale}px`})
            .setPosition(origin.x,origin.y).setVisible(true);
          dom.description.scroll=scroll;dom.description.scale=scale;dom.description.top=scroll.scrollTop;
          dom.description.placements=[];
          let cursor=0;
          descriptionLayout.lines.forEach((line,index)=>line.runs.forEach(run=>{
            const x=run.x*scale,y=index*descriptionLayout.lineHeight*scale;
            const label=this.placeChoiceLabel(dom.description.labels,cursor++,dom.description.clip.element,
              run.text,x,y-scroll.scrollTop*scale,22*scale,run.key);
            dom.description.placements.push({label,x,y});
          }));
          this.hideChoiceLabels(dom.description.labels,cursor);
          scroll.onScroll=()=>this.updateChoiceDomScroll();
        }
      }
      const list=v.scroll(left,layout.listY,width,layout.listViewport);list.setHeight(layout.contentHeight);
      if(dom){
        const origin=this.surfacePoint(left,layout.listY);
        dom.list.clip.setStyle({width:`${width*scale}px`,height:`${layout.listViewport*scale}px`})
          .setPosition(origin.x,origin.y).setVisible(true);
        dom.list.scroll=list;dom.list.scale=scale;dom.list.top=list.scrollTop;dom.list.placements=[];
        list.onScroll=()=>this.updateChoiceDomScroll();
      }
      let optionCursor=0;
      choices.options.forEach((option,index)=>{
        const size=layout.options[index]!;
        v.button('',0,size.y,width,size.height,()=>choices.choose(option),{parent:list.content,guard:list.guard});
        if(!dom)return;
        const optionLayout=optionLayouts[index]!,textHeight=optionLayout.lines.length?optionLayout.lines.length*optionLayout.lineHeight-UI_LINE_SPACING:0;
        const top=size.y+(size.height-textHeight)/2;
        optionLayout.lines.forEach((line,lineIndex)=>line.runs.forEach(run=>{
          const x=((width-line.width)/2+run.x)*scale;
          const y=(top+lineIndex*optionLayout.lineHeight)*scale;
          const label=this.placeChoiceLabel(dom.list.labels,optionCursor++,dom.list.clip.element,
            run.text,x,y-list.scrollTop*scale,optionFontSize*scale,run.key);
          dom.list.placements.push({label,x,y});
        }));
      });
      if(dom)this.hideChoiceLabels(dom.list.labels,optionCursor);
    }else if(!cover&&ui.dialogueLine&&!ui.quest){
      block();const edges=this.dialogueSafeEdges(),box=this.textBox(ui);if(ui.dialogueLine.presentation!=='screen'){
        const screen=screenCoverage(v);v.rect(screen.left,399,screen.width,218,0x000000,.7);const edge=this.app.storyInterface?.assets['dialogue-edge'];if(edge){v.image(edge,screen.left,399,screen.width,17);v.image(edge,screen.left,600,screen.width,17);}
        if(ui.portraitFile){const left=ui.dialogueLine.actor===ui.playerActor;v.image(ui.portraitFile,left?edges.left:edges.right,606,undefined,516).setOrigin(left?0:1,1);}
        const point=this.surfacePoint(box.x,428),speaker=ui.dialogueLine.speaker??'';
        this.domSpeaker?.setText(speaker).setPosition(point.x,point.y).setStyle({fontSize:`${Math.max(10,25*point.scale)}px`,color:TEXT_COLORS.primary}).setVisible(!!speaker);
      }else this.domSpeaker?.setVisible(false);
      this.renderDialogueBody(ui);
      this.dialogueShell=true;
    }
    if(showSkip){const skin=this.app.controlSkin;v.button('',this.dialogueSafeEdges().right-168,16,136,62,()=>this.app.director?.skip(),{image:skin?.skip?skin.skip:undefined,pressed:skin?.['skip-pressed'],guard:()=>ui.ready&&!ui.suspended&&!!this.app.director?.canSkip}).setData('label','跳过');}
    const toastVisible=!!ui.toastMessage&&!portrait&&!cover&&!ui.loadingState&&!ui.defeated&&!ui.suspended;
    this.domToast?.setVisible(toastVisible);
    if(this.domToast&&toastVisible){
      const point=this.surfacePoint(480,164);
      this.domToast.setText(ui.toastMessage!);this.domToast.setPosition(point.x,point.y);
    }
    this.dialogueBodySignature=bodySignature;
    if(uiOcclusion(ui)){this.hideDialogueDom();this.hideChoiceDom();}
    this.syncDefeatDom(ui,portrait,cover);
    v.layout(0);
    this.syncLoadingDom(ui,portrait);this.syncPortraitDom(portrait);
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
  }
}
