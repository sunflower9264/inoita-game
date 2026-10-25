import { SCENE_KEYS } from '../application/scene-keys.ts';
import { UI_EVENTS } from '../application/ui-events.ts';
import Phaser from 'phaser';
import type { StoryApp } from '../app.ts';
import type { GameUI, GameUiView } from '../ui/game-ui.ts';
import { UiSurface,loadUiImages,uiTexture,GOLD } from '../ui/phaser/widgets.ts';
import { FONT } from '../ui/text-style.ts';
import { dialoguePages, layoutDialogueText, revealedRuns, type DialoguePage, type DialogueTextLayout } from '../ui/dialogue-text.ts';
import { instantMessagePoint } from '../ui/instant-message.ts';
import { layoutChoicePanel } from '../ui/choice-layout.ts';
import { SceneUiAssets } from '../ui/phaser/ui-asset-host.ts';
import { QuestPopup } from '../ui/phaser/quest-popup.ts';
import { screenCoverage } from '../ui/phaser/modal-placement.ts';
import { readSafeArea } from '../ui/viewport.ts';
import type { AssetLease } from '../application/assets.ts';

/** 对白框的基础字色。`$B` 与未带色码的文字都用它——不是任务窗口的白色。 */
const DIALOGUE_TEXT_COLOR='#f5eedf';

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
  private dialogueRuns:Phaser.GameObjects.Text[]=[];
  private dialogueLayout?:DialogueTextLayout;
  private progressBar?:Phaser.GameObjects.Rectangle;
  private baseLease?:AssetLease;
  /** 菜单图片与立绘的租约账，`prepareMenu` 通过 `app.uiAssets` 找到它。 */
  private readonly uiAssets=new SceneUiAssets(this);
  private background!:Phaser.GameObjects.Rectangle;
  private cover?:Phaser.GameObjects.Image;
  private blocker!:Phaser.GameObjects.Zone;
  /** 原版 `INSTANTMSG` 的屏幕提示；不进 surface，因为它要逐帧淡出而 surface 每次 sync 整体重建。 */
  private instantText?:Phaser.GameObjects.Text;
  constructor(app:StoryApp){super(SCENE_KEYS.formalUi);this.app=app;}
  create():void{
    this.background=this.add.rectangle(0,0,1,1,0x000000,1).setOrigin(0).setDepth(998);this.blocker=this.add.zone(0,0,1,1).setOrigin(0).setDepth(999).setInteractive();
    this.surface=new UiSurface(this,960,640,1000);this.app.ui.view=this;this.app.uiAssets=this.uiAssets;
    this.instantText=this.add.text(0,0,'',{fontFamily:FONT,fontSize:24,color:GOLD,
      resolution:Math.min(3,Math.max(1,window.devicePixelRatio||1))}).setOrigin(.5,0)
      .setShadow(1,1,'#000000',0).setDepth(997).setVisible(false);
    this.questPopup=new QuestPopup(this,()=>this.app.ui.ready&&!this.app.ui.suspended);
    this.surface.enabled=()=>!this.app.ui.suspended;
    this.scale.on('resize',()=>{this.signature='';this.sync(this.app.ui);this.app.ui.reflowDialogue();});
    this.input.keyboard?.on('keydown',(event:KeyboardEvent)=>{
      if(this.app.ui.suspended)return;
      if(this.app.ui.defeated&&event.key==='Escape'){event.preventDefault();this.app.ui.cancelDefeatConfirmation();return;}
      if(this.app.ui.quest){this.questPopup.key(event);return;}
      if(event.key==='Enter'||event.key===' '){if(this.app.ui.canSkip){event.preventDefault();this.app.ui.advance();return;}}
      this.surface.key(event);
    });
    this.input.on('pointerdown',(pointer:Phaser.Input.Pointer,objects:Phaser.GameObjects.GameObject[])=>{
      if(!this.app.ui.defeated&&!objects.some(object=>object.getData('uiAction')))this.app.ui.pressDialogue(pointer.id);
    });
    this.input.on('pointerup',(pointer:Phaser.Input.Pointer)=>{
      if(!this.app.ui.defeated)this.app.ui.releaseDialogue(pointer.id);
    });
    this.input.on('pointerupoutside',(pointer:Phaser.Input.Pointer)=>this.app.ui.cancelPress(pointer.id));
    this.game.canvas.addEventListener('pointercancel',this.cancelInput);this.game.events.once('destroy',()=>this.game.canvas.removeEventListener('pointercancel',this.cancelInput));
    this.events.once('shutdown',()=>{this.uiAssets.releaseContent();this.surface.destroy();this.questPopup.destroy();this.baseLease?.release();});
    void loadUiImages(this,['/assets/ui/loading-background.webp']).then(lease=>{this.baseLease=lease;this.signature='';this.sync(this.app.ui);}).catch(console.error);
    this.app.storyUI.attach(this);this.sync(this.app.ui);
  }
  private cancelInput=():void=>this.app.ui.resetInput();
  resetInput():void{this.game.events.emit(UI_EVENTS.cancelInput);}
  override update(_time:number,delta:number):void{this.app.ui.tick(delta);this.syncInstantMessage();}
  /**
   * 原版 `INSTANTMSG_Draw`：水平居中、纵向三成屏高，同一段文字带 1px 深色描边，末段按台阶淡出。
   * 对白与弹窗期间不显示（原版这时画的是事件层界面）；菜单遮罩在 998 层，本来就压住它。
   */
  private syncInstantMessage():void{
    const text=this.instantText,ui=this.app.ui;if(!text)return;
    const message=ui.instant.text;
    const hidden=!message||!!ui.loadingState||ui.defeated||!!ui.dialogueLine||!!ui.choices||!!ui.quest;
    text.setVisible(!hidden);if(hidden)return;
    const point=instantMessagePoint(this.scale.width,this.scale.height);
    text.setText(message).setFontSize(24*(this.surface.root.scaleX||1)).setPosition(point.x,point.y).setAlpha(ui.instant.alpha);
  }
  async preloadPortraits(files:string[],signal:AbortSignal,progress:(value:number)=>void):Promise<void>{
    const missing=[...new Set(files)].filter(file=>!this.textures.exists(uiTexture(file)));
    if(!missing.length){progress(1);return;}
    await this.uiAssets.preloadFiles(missing,signal,progress);
  }
  async portrait(file:string,signal?:AbortSignal):Promise<void>{
    signal?.throwIfAborted();if(this.textures.exists(uiTexture(file)))return;const lease=await loadUiImages(this,[file]);if(signal?.aborted){lease.release();signal.throwIfAborted();}this.uiAssets.retain(lease);
  }
  /**
   * 对白按物理屏幕满幅绘制，坐标以 `-offset`（物理左缘）为基准；姓名、正文与立绘
   * 改用安全区左右缘，避免刘海压住内容，背景本身仍满幅。
   */
  private dialogueSafeEdges():{left:number;right:number;span:number}{
    const bounds=this.game.canvas.getBoundingClientRect(),safe=readSafeArea(),scale=this.surface.root.scaleX||1;
    const perCss=this.scale.width/Math.max(1,bounds.width)/scale,physicalLeft=-this.surface.root.x/scale;
    return{left:physicalLeft+safe.left*perCss,right:physicalLeft+this.scale.width/scale-safe.right*perCss,
      span:this.scale.width/scale};
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
      for(const run of line.runs){const target=this.dialogueRuns[index++];if(target)target.setText(run.text);}
  }
  /**
   * 只重建对白正文：框、立绘、说话人和控件留在原地，正文 Text 按位置复用。
   * Phaser 的每个 Text 都有自己的画布纹理；翻页时销毁再新建几十个是演出卡顿的主因。
   */
  private renderDialogueBody(ui:GameUI):void {
    const v=this.surface,box=this.textBox(ui),screen=ui.dialogueLine?.presentation==='screen';
    const next:{text:string;x:number;y:number;color:string}[]=[];
    this.dialogueMetrics(box.size,(measure,lineHeight)=>{
      const layout=layoutDialogueText(ui.page,DIALOGUE_TEXT_COLOR,box.width,measure,lineHeight);
      this.dialogueLayout=layout;
      const top=screen?320-layout.lines.length*lineHeight/2:box.y;
      layout.lines.forEach((line,index)=>{
        const offset=screen?(box.width-line.width)/2:0;
        for(const run of line.runs)next.push({text:run.text,x:box.x+offset+run.x,y:top+index*lineHeight,color:run.key});
      });
    });
    const keep=Math.min(this.dialogueRuns.length,next.length);
    for(let index=0;index<keep;index++){
      const target=this.dialogueRuns[index]!,run=next[index]!;
      target.setText(run.text).setPosition(run.x,run.y).setColor(run.color);
    }
    for(let index=keep;index<this.dialogueRuns.length;index++)this.dialogueRuns[index]!.destroy();
    this.dialogueRuns.length=keep;
    for(let index=keep;index<next.length;index++){
      const run=next[index]!;
      this.dialogueRuns.push(v.text(run.text,run.x,run.y,0,box.size,run.color));
    }
    this.renderText(ui);
  }
  sync(ui:GameUI):void{
    if(!this.surface)return;
    const portrait=window.innerHeight>window.innerWidth;
    const quest=ui.mode==='game'&&!portrait&&!ui.loadingState&&!ui.defeated?ui.quest:undefined;
    this.questPopup.sync(quest,this.app.storyInterface?.assets??{},id=>ui.questItemName?.(id)??id);
    const progress=Phaser.Math.Clamp(ui.loadingState?.progress??0,0,1);
    const showSkip=ui.mode==='game'&&ui.ready&&!ui.suspended&&!portrait&&!ui.loadingState&&!ui.defeated&&!ui.choices&&!ui.quest&&!!this.app.director?.canSkip;
    const defeat=ui.defeatState;
    // 正文页不进整屏签名：同一句对白翻页时只换正文，不重建框、立绘和控件。
    const bodySignature=JSON.stringify([ui.page,ui.dialogueLine?.presentation]);
    const signature=JSON.stringify([ui.mode,ui.loadingState?.label,!!ui.loadingState?.retry,ui.failed,ui.suspended,portrait,defeat,ui.toastMessage,ui.dialogueLine,ui.portraitFile,ui.canSkip,showSkip,ui.choices?.prompt,ui.choices?.options,ui.quest?.definition.id,ui.quest?.kind]);
    if(signature===this.signature){
      if(this.dialogueShell&&bodySignature!==this.dialogueBodySignature){this.dialogueBodySignature=bodySignature;this.renderDialogueBody(ui);}
      this.progressBar?.setSize(560*progress,5);return;
    }
    this.signature=signature;this.dialogueShell=false;
    const v=this.surface;v.clear();v.layout(0);this.dialogueRuns=[];this.dialogueLayout=undefined;this.progressBar=undefined;v.visible(true);
    const modal=portrait||!!ui.loadingState||ui.defeated;
    this.background.setVisible(modal).setSize(this.scale.width,this.scale.height).setFillStyle(0x000000,ui.defeated&&!portrait&&!ui.loadingState ? .65:1);
    this.blocker.setVisible((modal||!!ui.quest||!!ui.dialogueLine||!!ui.choices)).setSize(this.scale.width,this.scale.height);if(this.blocker.input)this.blocker.input.hitArea.setSize(this.scale.width,this.scale.height);
    this.cover?.destroy();this.cover=undefined;
    const block=()=>{const zone=this.add.zone(0,0,960,640).setOrigin(0).setInteractive();v.root.add(zone);};
    if(portrait){v.rect(0,0,960,640,0x101d24,1);block();v.text('↻',480,160,0,90).setOrigin(.5,0);v.text('横过手机，进入游戏',480,310,0,32).setOrigin(.5,0);v.text('请使用横屏继续',480,370,0,24).setOrigin(.5,0);}
    else if(ui.loadingState){
      const file='/assets/ui/loading-background.webp';if(this.textures.exists(uiTexture(file))){this.cover=this.add.image(this.scale.width/2,this.scale.height/2,uiTexture(file)).setDepth(998.5);const factor=Math.max(this.scale.width/this.cover.width,this.scale.height/this.cover.height);this.cover.setScale(factor).setTint(0xaaaaaa);}
      block();v.text('艾诺迪亚',480,410,0,42).setOrigin(.5,0);
      v.text(ui.loadingState.label,480,476,820,22).setOrigin(.5,0);v.rect(200,531,560,5,0xeee2cc,.3);this.progressBar=v.rect(200,531,560*progress,5,0xe2c88d,1);
      if(ui.loadingState.retry){v.button(ui.loadingState.actionLabel??'重新加载',380,552,200,48,ui.loadingState.retry);if(ui.canReturn)v.button('返回主菜单',26,20,180,48,()=>ui.onMenu?.());}
    }else if(defeat){
      block();v.frame(this.app.storyInterface?.assets??{},142,142,676,356);
      v.text('队伍全员阵亡',480,172,0,34,'#e4c58b').setOrigin(.5,0);
      const guard=()=>!ui.suspended&&!ui.defeatState?.busy;
      if(defeat.confirmation){
        const prayer=defeat.confirmation==='prayer';
        v.text(prayer?'消耗 1 张复活圣文，在原地恢复全队生命与魔法？':'返回最近的检查点？此后的物品、经验、金钱和任务进度将回退。',190,242,580,25,'#f5eedf');
        v.button('取消',235,397,220,60,()=>ui.cancelDefeatConfirmation(),{disabled:defeat.busy,guard});
        v.button(defeat.busy?'正在恢复…':'确认',505,397,220,60,()=>{void ui.confirmDefeat();},{disabled:defeat.busy,guard});
      }else{
        v.text(defeat.error??'选择复活方式',480,230,570,23,defeat.error?'#eb9587':'#f5eedf').setOrigin(.5,0);
        v.button(`使用复活圣文（${defeat.prayerCount}）`,225,301,510,60,()=>ui.selectDefeatAction('prayer'),{disabled:defeat.prayerCount<1,guard});
        v.button('返回检查点',225,392,510,60,()=>ui.selectDefeatAction('checkpoint'),{guard});
      }
    }
    else if(ui.choices&&!ui.quest){
      block();const choices=ui.choices;
      // 选项竖排：整行宽度、按钮高度按标签实际换行后的高度算，文字不会压在按钮框外。
      const left=30,width=900,optionFontSize=22;
      const prompt=v.text(choices.prompt,left,0,width,24);
      const description=choices.description?v.text(choices.description,left,0,width,22):undefined;
      const optionTextHeights=choices.options.map(option=>{
        const probe=v.text(option.label,0,0,width-12,optionFontSize),height=probe.height;
        probe.destroy();return height;
      });
      const layout=layoutChoicePanel({promptHeight:prompt.height,descriptionHeight:description?.height,optionTextHeights});
      const panel=v.rect(0,layout.top,960,layout.panelHeight,0x000000,.86);v.root.sendToBack(panel);
      prompt.setPosition(left,layout.promptY);
      if(description&&layout.descriptionY!==undefined&&layout.descriptionView!==undefined){
        const scroll=v.scroll(left,layout.descriptionY,width,layout.descriptionView);
        v.root.remove(description);scroll.content.add(description);description.setPosition(0,0);scroll.setHeight(description.height);
      }
      const list=v.scroll(left,layout.listY,width,layout.listViewport);list.setHeight(layout.contentHeight);
      choices.options.forEach((option,index)=>{
        const size=layout.options[index]!;
        v.button(option.label,0,size.y,width,size.height,()=>choices.choose(option),{parent:list.content,guard:list.guard});
      });
    }else if(ui.dialogueLine&&!ui.quest){
      block();const edges=this.dialogueSafeEdges(),box=this.textBox(ui);if(ui.dialogueLine.presentation!=='screen'){
        const screen=screenCoverage(v);v.rect(screen.left,399,screen.width,218,0x000000,.7);const edge=this.app.storyInterface?.assets['dialogue-edge'];if(edge){v.image(edge,screen.left,399,screen.width,17);v.image(edge,screen.left,600,screen.width,17);}
        if(ui.portraitFile){const left=ui.dialogueLine.actor===ui.playerActor;v.image(ui.portraitFile,left?edges.left:edges.right,606,undefined,516).setOrigin(left?0:1,1);}
        v.text(ui.dialogueLine.speaker??'',box.x,428,box.width,25);
      }
      this.renderDialogueBody(ui);
      this.dialogueShell=true;
    }
    if(showSkip){const skin=this.app.controlSkin;v.button('',this.dialogueSafeEdges().right-168,16,136,62,()=>this.app.director?.skip(),{image:skin?.skip?skin.skip:undefined,pressed:skin?.['skip-pressed'],guard:()=>ui.ready&&!ui.suspended&&!!this.app.director?.canSkip}).setData('label','跳过');}
    if(ui.toastMessage&&!portrait&&!ui.loadingState&&!ui.defeated){v.rect(180,150,600,90,0x101d24,.95);v.text(ui.toastMessage,480,164,560,24).setOrigin(.5,0);}
    this.dialogueBodySignature=bodySignature;
    v.layout(0);
  }
}
