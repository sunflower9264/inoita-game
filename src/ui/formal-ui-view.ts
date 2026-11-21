import { formalPresentation } from './formal-presentation.ts';
import { domAssets } from './dom/assets.ts';
import { uiMount, type UiPointer } from './dom/node.ts';
import { UiNode, UiImage } from './dom/node.ts';
import { UI_EVENTS } from '../application/ui-events.ts';
import type Phaser from 'phaser';
import type { StoryApp } from '../app.ts';
import { uiOcclusion, type GameUI, type GameUiView } from './game-ui.ts';
import { UiSurface,loadUiImages,GOLD } from './phaser/widgets.ts';
import { TEXT_COLORS } from './text-style.ts';
import { dialoguePages, layoutDialogueText, revealedRuns, type DialoguePage, type DialogueTextLayout } from './dialogue-text.ts';
import { instantMessagePoint } from './instant-message.ts';
import { FormalModalView } from './formal-modal-view.ts';
import { FormalChoiceView } from './formal-choice-view.ts';
import { SceneUiAssets } from './phaser/ui-asset-host.ts';
import { QuestPopup } from './phaser/quest-popup.ts';
import { screenCoverage } from './phaser/modal-placement.ts';
import { frameRect, readSafeArea } from './viewport.ts';
import type { AssetLease } from '../application/assets.ts';
import type { DomLabel } from './dom/dom-ui.ts';

/** 对白框的基础字色。`$B` 与未带色码的文字都用它——不是任务窗口的白色。 */
const DIALOGUE_TEXT_COLOR='#f5eedf';

/** 协调对白、选项和全屏提示；剧情动作的完成仍由 GameUI 负责。 */
export class FormalUiView implements GameUiView {
  private readonly app:Pick<StoryApp,'ui'|'domUi'|'storyInterface'|'director'|'storyUI'|'controlSkin'|'checkpoint'|'resumeSlot'>;
  private surface!:UiSurface;
  private questPopup!:QuestPopup;
  private signature='';
  /** 当前画面是否是可增量的普通对白外壳（框、立绘、说话人不重建）。 */
  private dialogueShell=false;
  private dialoguePortraitParent?:UiNode;
  private dialoguePortrait?:UiImage;
  private dialogueSpeakerSignature='';
  /** 对白正文（当前页文本）的签名；只变这里时只更新正文 Text。 */
  private dialogueBodySignature='';
  /** 对白正文按色段拆成多个 Text：原版控制码不显示，字色随 `$X` 变化。 */

  private dialogueLayout?:DialogueTextLayout;
  private baseLease?:AssetLease;
  /** 菜单图片与立绘的租约账，`prepareMenuCore` 通过 `app.uiAssets` 找到它。 */
  private readonly uiAssets:SceneUiAssets;
  private readonly scene:Phaser.Scene;
  private readonly request=new AbortController();
  private disposed=false;
  private background!:UiNode;
  private blocker!:UiNode;
  /** 原版 `INSTANTMSG` 的屏幕提示；不进 surface，因为它要逐帧淡出而 surface 每次 sync 整体重建。 */
  private domInstant?:DomLabel;
  /** 屏幕提示标签上次写入的文字与透明度；按标签缓存，标签重建后自然失效。 */
  private readonly instantStyle=new WeakMap<DomLabel,{text:string;alpha:string}>();
  private domToast?:DomLabel;
  private domSpeaker?:DomLabel;
  private modalView!:FormalModalView;
  private dialogueDomRuns:DomLabel[]=[];
  /** 选项面板的 DOM 文字；提示、说明和每个选项各用一组复用的标签。 */
  private choiceView!:FormalChoiceView;

  constructor(scene:Phaser.Scene,app:FormalUiView['app'],assets:SceneUiAssets){this.scene=scene;this.app=app;this.uiAssets=assets;}
  resize():void{this.modalView.invalidate();this.signature='';this.layoutDomText();this.sync(this.app.ui);this.app.ui.reflowDialogue();}
  create():void{
    this.background=new UiNode(this.scene,uiMount(this.scene,'overlay')).setSize(1,1).setFillStyle(0,1).setDepth(998);this.blocker=new UiNode(this.scene,uiMount(this.scene,'overlay')).setSize(1,1).setDepth(999).setInteractive();
    // 挡板本来就铺满整个画框，对白推进直接挂在它上面，宽屏两侧的黑边也能点。
    this.blocker.on('pointerdown',(pointer:UiPointer)=>this.app.ui.pressDialogue(pointer.id))
      .on('pointerup',(pointer:UiPointer)=>this.app.ui.releaseDialogue(pointer.id))
      .on('pointerupoutside',()=>this.app.ui.resetInput());
    this.surface=new UiSurface(this.scene,960,640,1000,'overlay');
    const domUi=this.app.domUi;
    if(domUi){
      this.domInstant=domUi.label('screen','dom-instant',{x:.5,y:0});
      this.domToast=domUi.label('screen','dom-toast',{x:.5,y:0});
      this.domSpeaker=domUi.label('overlay','dom-speaker');
      this.layoutDomText();
    }
    this.modalView=new FormalModalView(this.scene,this.app);
    this.choiceView=new FormalChoiceView(this.scene,this.app.domUi);
    this.questPopup=new QuestPopup(this.scene,()=>this.app.ui.ready&&!this.app.ui.suspended,this.app.domUi);
    this.surface.enabled=()=>!this.app.ui.suspended;
    void loadUiImages(this.scene,['/assets/ui/loading-background.webp'],undefined,this.request.signal).then(lease=>{if(this.disposed){lease.release();return;}this.baseLease=lease;this.signature='';this.sync(this.app.ui);}).catch(error=>{if(!this.request.signal.aborted)console.error(error);});
    this.sync(this.app.ui);
  }
  destroy():void{
    if(this.disposed)return;this.disposed=true;this.request.abort();
    this.uiAssets.releaseContent();this.surface?.destroy();this.questPopup?.destroy();this.baseLease?.release();this.domInstant?.remove();this.domInstant=undefined;this.domToast?.remove();this.domToast=undefined;this.domSpeaker?.remove();this.domSpeaker=undefined;for(const run of this.dialogueDomRuns)run.remove();this.dialogueDomRuns.length=0;this.choiceView?.destroy();this.modalView?.destroy();
    this.background?.destroy();this.blocker?.destroy();
  }
  /**
   * 正式界面的弹层键盘：守卫顺序保持原样。返回 `true` 表示这一层消费了按键；
   * 返回 `false` 时由 router 继续交给菜单或世界，只有独占状态会挡住它们。
   */
  key=(event:KeyboardEvent):boolean=>{
    if(this.app.ui.suspended||this.app.ui.worldRebuildCover)return false;
    // 键位捕获期间键盘归设置面板：Enter / 空格不能顺手触发菜单按钮。
    if(this.app.ui.keyBindingEditing)return false;
    // 游戏内菜单打开时由 StoryUI 的 menu 作用域接管，正式界面不抢先处理 Tab/Enter。
    if(this.app.storyUI?.menuOpen)return false;
    if(this.app.ui.defeated&&event.key==='Escape'){event.preventDefault();this.app.ui.cancelDefeatConfirmation();return true;}
    if(this.app.ui.quest){this.questPopup.key(event);return true;}
    if(event.key==='Enter'||event.key===' '){if(this.app.ui.canSkip){event.preventDefault();this.app.ui.advance();return true;}}
    if(this.app.ui.loadingState||this.app.ui.defeated||(typeof window!=='undefined'&&window.innerHeight>window.innerWidth))return this.modalView.key(event);
    return this.app.ui.choices?this.choiceView.key(event):this.surface.key(event);
  };
  resetInput():void{this.scene.game.events.emit(UI_EVENTS.cancelInput);}
  update():void{this.syncInstantMessage();this.choiceView?.update();}
  /**
   * 原版 `INSTANTMSG_Draw`：水平居中、纵向三成屏高，同一段文字带 1px 深色描边，末段按台阶淡出。
   * 对白与弹窗期间不显示（原版这时画的是事件层界面）；菜单遮罩在 998 层，本来就压住它。
   */
  private syncInstantMessage():void{
    const ui=this.app.ui,message=ui.instant.text;
    const hidden=!message||!!ui.loadingState||ui.defeated||ui.suspended||ui.worldRebuildCover||!!ui.dialogueLine||!!ui.choices||!!ui.quest;
    if(!this.domInstant)return;
    this.domInstant.setVisible(!hidden);
    // 隐藏后再显示时重新写一次透明度；新提示按文字变化失效，淡出按 alpha 变化失效。
    if(hidden){this.instantStyle.delete(this.domInstant);return;}
    this.domInstant.setText(message!);
    const alpha=String(ui.instant.alpha),cached=this.instantStyle.get(this.domInstant);
    if(cached?.text===message&&cached.alpha===alpha)return;
    this.instantStyle.set(this.domInstant,{text:message!,alpha});
    this.domInstant.setStyle({opacity:alpha});
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
    signal?.throwIfAborted();this.request.signal.throwIfAborted();if(domAssets.peek(file))return;
    const lease=await loadUiImages(this.scene,[file],undefined,signal??this.request.signal);
    if(this.disposed||signal?.aborted){lease.release();signal?.throwIfAborted();this.request.signal.throwIfAborted();}
    this.uiAssets.retain(lease);
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
  private hideDialogueDom():void{
    this.domSpeaker?.setVisible(false);
    for(const run of this.dialogueDomRuns)run.setVisible(false);
  }
  private renderDialogueBody(ui:GameUI):void {
    const domUi=this.app.domUi;if(!domUi)return;
    const box=this.textBox(ui),screen=ui.dialogueLine?.presentation==='screen';
    const next:{text:string;x:number;y:number;color:string}[]=[];
    this.dialogueMetrics(box.size,(measure,lineHeight)=>{
      const layout=layoutDialogueText(ui.dialoguePageMarkup,DIALOGUE_TEXT_COLOR,box.width,measure);
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
  private syncDialogueSpeaker(ui:GameUI,signature:string):void{
    this.dialogueSpeakerSignature=signature;
    const parent=this.dialoguePortraitParent,v=this.surface,line=ui.dialogueLine;if(!parent||!v||!line)return;
    const edges=this.dialogueSafeEdges(),left=line.actor===ui.playerActor;
    if(ui.portraitFile){
      if(!this.dialoguePortrait)this.dialoguePortrait=v.image(ui.portraitFile,left?edges.left:edges.right,606,undefined,516,parent);
      else if(this.dialoguePortrait.getData('file')!==ui.portraitFile)this.dialoguePortrait.load(ui.portraitFile);
      this.dialoguePortrait.setPosition(left?edges.left:edges.right,606).setOrigin(left?0:1,1).setVisible(true);
    }else this.dialoguePortrait?.setVisible(false);
    const point=this.surfacePoint(this.textBox(ui).x,428),speaker=line.speaker??'';
    this.domSpeaker?.setText(speaker).setPosition(point.x,point.y).setStyle({fontSize:`${Math.max(10,25*point.scale)}px`,color:TEXT_COLORS.primary}).setVisible(!!speaker);
  }

  sync(ui:GameUI):void{
    if(this.disposed||!this.surface)return;
    if(!ui.dialogueLine||uiOcclusion(ui)||ui.quest||ui.choices)this.hideDialogueDom();
    const portrait=window.innerHeight>window.innerWidth;
    const cover=ui.worldRebuildCover;
    const skipBackdrop=ui.skipBackdrop;
    const presentation=formalPresentation(ui,portrait,!!this.app.director?.canSkip);
    this.questPopup.sync(ui.quest,this.app.storyInterface?.assets??{},id=>ui.questItemName?.(id)??id,!!presentation.quest);
    this.modalView.sync(ui,portrait,cover);
    const showSkip=presentation.showSkip;
    const defeat=ui.defeatState;
    // 全屏遮罩出现时统一收起 world/hud/screen 的文字；加载页文字在 overlay 层，不受影响。
    this.app.domUi?.setOccluded(uiOcclusion(ui));
    // 翻页只更新文字。是否能接收本次点击由输入处理当场判断。
    const shell=ui.dialogueLine
      ?JSON.stringify([ui.dialogueLine.presentation??'box'])
      :null;
    const speakerSignature=JSON.stringify([ui.dialogueLine?.speaker,ui.dialogueLine?.actor,ui.portraitFile,ui.playerActor]);
    const bodySignature=JSON.stringify([ui.dialoguePageMarkup,ui.dialogueLine?.presentation,speakerSignature]);
    const signature=JSON.stringify([ui.mode,ui.loadingState?.label,!!ui.loadingState?.retry,ui.failed,ui.suspended,portrait,cover,skipBackdrop,defeat,shell,ui.dialogueLine?null:ui.portraitFile,showSkip,ui.choices?.prompt,ui.choices?.description,ui.choices?.options,ui.quest?.definition.id,ui.quest?.kind]);
    this.domToast?.setVisible(presentation.toastVisible);
    if(this.domToast&&presentation.toastVisible){const point=this.surfacePoint(480,164);this.domToast.setText(ui.toastMessage).setPosition(point.x,point.y);}
    if(signature===this.signature){
      if(this.dialogueShell&&!uiOcclusion(ui)&&bodySignature!==this.dialogueBodySignature){
        if(speakerSignature!==this.dialogueSpeakerSignature)this.syncDialogueSpeaker(ui,speakerSignature);
        this.dialogueBodySignature=bodySignature;this.renderDialogueBody(ui);
      }
      return;
    }
    this.signature=signature;this.dialogueShell=false;this.dialoguePortraitParent=undefined;this.dialoguePortrait=undefined;this.dialogueSpeakerSignature='';this.choiceView?.hide(ui.choices);
    const v=this.surface;v.clear();v.layout(0);this.dialogueLayout=undefined;v.visible(true);
    // 跳过补画黑底只盖画面，不隐藏任务窗和选择框；跨图重建黑幕（cover）仍然按原规则隐藏它们。
    const {width,height}=frameRect();
    this.background.setVisible(presentation.backgroundVisible).setSize(width,height)
      .setFillStyle(0x000000,presentation.backgroundAlpha);
    this.blocker.setVisible(presentation.blockInput).setSize(width,height);if(this.blocker.input)this.blocker.input.hitArea.setSize(width,height);
    if(presentation.panel==='choice'&&ui.choices){
      this.choiceView.render(ui.choices);
    }else if(presentation.panel==='dialogue'&&ui.dialogueLine){
      if(ui.dialogueLine.presentation!=='screen'){
        const screen=screenCoverage(v);v.rect(screen.left,399,screen.width,218,0x000000,.7);const edge=this.app.storyInterface?.assets['dialogue-edge'];if(edge){v.image(edge,screen.left,399,screen.width,17);v.image(edge,screen.left,600,screen.width,17);}
        this.dialoguePortraitParent=v.container(0,0);this.syncDialogueSpeaker(ui,speakerSignature);
      }else this.domSpeaker?.setVisible(false);
      this.renderDialogueBody(ui);
      this.dialogueShell=true;
    }
    if(showSkip){const skin=this.app.controlSkin;v.button('',this.dialogueSafeEdges().right-168,16,136,62,()=>this.app.director?.skip(),{image:skin?.skip?skin.skip:undefined,pressed:skin?.['skip-pressed'],guard:()=>ui.ready&&!ui.suspended&&!!this.app.director?.canSkip}).setData('label','跳过');}
    this.dialogueBodySignature=bodySignature;
    if(uiOcclusion(ui)){this.hideDialogueDom();this.choiceView?.hide(ui.choices);}
    v.layout(0);
  }
}
