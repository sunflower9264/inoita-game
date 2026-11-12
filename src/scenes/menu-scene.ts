import { UiNode, UiImage, type UiText } from '../ui/dom/node.ts';
import { SCENE_KEYS } from '../application/scene-keys.ts';
import { notifyBootReady } from '../application/live-update.ts';
import { fullscreenActive, fullscreenStatus, onFullscreenChange, setFullscreen } from '../application/fullscreen.ts';
import Phaser from 'phaser';
import type { MenuContext } from '../application/ports.ts';
import { TITLE_MESSAGE_ASSETS, titleMenuImages } from '../application/menu-images.ts';
import { GOLD, UiSurface, type ScrollArea } from '../ui/phaser/widgets.ts';
import { SceneUiAssets } from '../ui/phaser/ui-asset-host.ts';
import { SAVE_BOARD, SAVE_BOARD_LAYOUT, drawSaveBoardRow, newestFirstSlots, saveBoardOrigin, saveRowTitle, setSaveBoardTextSink, type SaveBoardControl, type SaveBoardTextSpec } from '../ui/phaser/save-board.ts';
import { MenuTextLayer, type MenuTextClip, type MenuTextOcclude, type MenuTextPoint, type MenuTextSpec, type MenuTextWriter } from '../ui/dom/menu-text.ts';
import type { DomLabel, DomUi } from '../ui/dom/dom-ui.ts';
import { canvasCssScale, frameRect } from '../ui/viewport.ts';
import { drawNativeMessage, NATIVE_MESSAGE_EDGE, type NativeMessageBand } from '../ui/phaser/native-message.ts';
import { centerModal } from '../ui/phaser/modal-placement.ts';
import { CHANGELOG_LAYOUT, changelogMetrics, changelogVisibleRange } from '../ui/changelog-layout.ts';
import { TextPrompt } from '../ui/text-prompt.ts';
import { PasswordChangePrompt } from '../ui/password-change-prompt.ts';
import { CloudCredentialsInput, type CredentialInputRect } from '../ui/cloud-credentials-input.ts';
import { AUTO_SAVE_SLOT, MANUAL_SAVE_SLOT_COUNT, saveSlotLabel, type SaveSlotRef, type SlotSummaryReading } from '../domain/save-game.ts';
import { CLOUD_PAGE, type CloudPageActions, type CloudPageState, type CloudPageStatus } from '../ui/cloud-save-layout.ts';
import { drawCloudSavePage } from '../ui/phaser/cloud-save-panel.ts';
import {
  CLOUD_NEW_PASSWORD_SAME_MESSAGE,
  CLOUD_PASSWORD_CHANGED_MESSAGE,
  CLOUD_SESSION_RENEW_WINDOW_MS,
  cloudSlotLabel,
  normalizeCloudAccount,
  validateCloudAccount,
  validateCloudPassword,
} from '../domain/cloud-save.ts';
import { backupLocalSaves, restoreCloudSaves, type CloudSyncResult } from '../application/cloud-save-sync.ts';
import type { CloudSavePort } from '../application/cloud-save.ts';

const art=(name:string)=>`/assets/ui/title-menu/${name}.png`;
/** 标题页右下角展示的版本号；等用户要求时再改。 */
const GAME_VERSION='v1.0.4';
/** 版本号下方一行；说明作品性质，并提醒支持官方版本。 */
const FAN_WORK_NOTICE='同人作品 · 仅供个人学习研究 · 请支持官方正版';
const CLOSE_IMAGE='/assets/ui/menus/close.png';
const CLOSE_PRESSED='/assets/ui/menus/close-pressed.png';
/** DOM 文字不跟随 Phaser 容器的 alpha；禁用按钮的标签用同透明度的颜色变暗。 */
function fadeColor(color:string,alpha:number):string {
  const match=/^#([0-9a-f]{6})$/i.exec(color);
  if(!match)return color;
  const value=parseInt(match[1],16);
  return `rgba(${value>>16&255},${value>>8&255},${value&255},${Math.max(0,Math.min(1,alpha)).toFixed(2)})`;
}

interface ConfirmRequest {
  message:string;
  accept:()=>void;
  cancel:()=>void;
}

export class MenuScene extends Phaser.Scene {
  readonly app:MenuContext;
  /** 菜单作用域的注销函数；场景 shutdown 时摘掉，避免标题页退出后还抢按键。 */
  private unregisterInput?:()=>void;
  private surface?:UiSurface;
  /** 确认框画在它上面；底下的页面在确认期间不接受输入。 */
  private modal?:UiSurface;
  private backdrop?:UiImage;
  /** 确认框后面的黑色遮罩：弹层本身保持半透明。 */
  private popupMask?:UiNode;
  /** 更新日志弹窗：点按钮才加载，滚动时只输出可视条目。 */
  private changelogOpen=false;
  private changelogState:'idle'|'loading'|'ready'|'empty'|'error'='idle';
  private changelogEntries:string[]=[];
  private changelogHeights:number[]=[];
  private changelogOffsets:number[]=[];
  private changelogSpecs:MenuTextSpec[]=[];
  private changelogScroll?:ScrollArea;
  private confirmBand?:NativeMessageBand;
  private changelogScrollTop=0;
  private changelogRequest?:AbortController;
  private changelogError='';
  /** 标题图跟着场景实例活到销毁：回标题、暂停、重开都不再重新加载。 */
  private readonly titleAssets:SceneUiAssets;
  /** 构造函数里取不到 this.events（要等场景系统注入），销毁监听改到 create 里只挂一次。 */
  private titleAssetsBound=false;
  private page:'home'|'slots'|'settings'|'cloud'='home';
  private slotRequest?:AbortController;
  /** 挑战模式的隐藏入口：累计点击 5 次后进入压测，离开标题页或关闭场景时清零。 */
  private challengeClicks=0;
  /** 改名输入与通用确认：标题页的存档管理与云存档覆盖确认共用。 */
  private renameRef?:SaveSlotRef;
  private prompt?:TextPrompt;
  private passwordPrompt?:PasswordChangePrompt;
  /** 云存档登录的账号/密码输入框：直接盖在面板行上，不是独立弹层。 */
  private credentials?:CloudCredentialsInput;
  private confirmAction?:ConfirmRequest;
  private confirmResolve?:(value:boolean)=>void;
  /** 云存档请求：离开云页、回主页或场景关闭时 abort；代次防止旧结果覆盖新页面。 */
  private cloudRequest?:AbortController;
  private cloudSerial=0;
  private cloudBusy=false;
  private cloudAccountInput='';
  private cloudPassword='';
  private cloudStatus?:CloudPageStatus;
  private cloudCount?:number;
  /** 环境设置列表的滚动位置：开关后整页重画，位置要接着上次的来。 */
  private settingsScroll=0;
  /** 菜单文字走 DOM；图框、按钮、滚动和命中区仍由 Phaser 画。 */
  private menuText?:MenuTextLayer;
  private modalLabels:DomLabel[]=[];
  /** 本次重画收集到的文字规格；各页面的 DOM 渲染函数按它生成标签。 */
  private domSpecs:MenuTextSpec[]=[];
  /** 滚动区文字重算位置时读当前偏移；每次整页重画指向新的滚动区。 */
  private slotsScroll?:ScrollArea;
  private settingsList?:ScrollArea;
  private cloudScroll?:ScrollArea;
  private renderOnResume():void {
    if(this.surface&&this.sys.isActive())this.render();
  }
  private readonly hideCredentials=():void=>{this.credentials?.hide();};
  constructor(app:MenuContext){super(SCENE_KEYS.menu);this.app=app;this.titleAssets=new SceneUiAssets(this);}
  create(options:{page?:'home'|'slots'}={}):void {
    if(!this.titleAssetsBound){this.titleAssetsBound=true;this.events.once(Phaser.Scenes.Events.DESTROY,()=>this.titleAssets.releaseResident());}
    this.page='home';this.app.ui.setMode('menu');this.app.ui.loading('正在准备主菜单…');
    const controller=new AbortController();
    this.events.once('shutdown',()=>{this.resetChallengeClicks();this.unregisterInput?.();this.unregisterInput=undefined;controller.abort();this.cancelCloudRequest();this.settleConfirm(false,false);this.slotRequest?.abort();this.changelogRequest?.abort();this.changelogRequest=undefined;this.changelogOpen=false;this.app.releaseChangelog?.();this.prompt?.close();this.passwordPrompt?.close();this.credentials?.destroy();this.credentials=undefined;this.clearModalLabels();this.menuText?.destroy();this.menuText=undefined;this.domSpecs=[];this.slotsScroll=undefined;this.settingsList=undefined;this.cloudScroll=undefined;this.surface?.destroy();this.surface=undefined;this.modal?.destroy();this.modal=undefined;this.popupMask?.destroy();this.popupMask=undefined;this.events.off(Phaser.Scenes.Events.RESUME,this.renderOnResume,this);this.events.off(Phaser.Scenes.Events.PAUSE,this.hideCredentials);this.scale.off('resize',this.layout,this);});
    // 标题页整屏独占键盘；原始事件由正式界面场景那一处桥接进 router。
    this.unregisterInput?.();this.unregisterInput=this.app.inputRouter.register('menu',this.routeKey,{exclusive:()=>true});
    this.events.on(Phaser.Scenes.Events.RESUME,this.renderOnResume,this);
    this.events.on(Phaser.Scenes.Events.PAUSE,this.hideCredentials);
    this.scale.on('resize',this.layout,this);
    // 浏览器自身的退出（Esc、手势）不会走设置页的按钮，靠事件把开关状态同步回来。
    this.events.once('shutdown',onFullscreenChange(()=>{
      if(this.page==='settings'&&this.surface&&this.sys.isActive())this.render();
    }));
    void this.titleAssets.preloadResident(titleMenuImages,controller.signal,()=>{}).then(()=>{
      if(controller.signal.aborted)return;
      this.backdrop=new UiImage(this,undefined,art('background')).setOrigin(.5);
      // 遮罩同时拦掉底层输入；弹层在它上面，按钮仍然先命中。
      this.popupMask=new UiNode(this).setSize(1,1).setFillStyle(0,.65).setDepth(150).setVisible(false).setInteractive();
      this.surface=new UiSurface(this,1200,640);this.modal=new UiSurface(this,1024,640,200);this.prompt=new TextPrompt();this.passwordPrompt=new PasswordChangePrompt();
      const domUi=this.domUi;
      if(domUi){
        // 更新日志画在弹层画布上，文字定位跟着弹层根节点；其它页面仍用标题页画布。
        this.menuText=new MenuTextLayer(domUi,(x,y)=>this.menuTextPoint(x,y),(page)=>this.menuScrollTop(page),(x,y)=>this.modalTextPoint(x,y));
        for(const page of ['home','slots','settings','cloud'] as const){
          this.menuText.register(page,writer=>{
            // 确认框打开时页面文字整体压暗，只让出横带矩形；弹层文字另走 modalLabels。
            const occlude=this.confirmAction?this.confirmOcclusion():undefined;
            for(const spec of this.domSpecs)writer.add(occlude?{...spec,dim:true,occlude}:spec);
          });
        }
        this.menuText.register('changelog',writer=>{
          // 更新日志盖住页面时，页面文字整体压暗，只让出日志面板；日志文字用弹层坐标。
          const occlude=this.changelogOcclusion();
          for(const spec of this.domSpecs)writer.add({...spec,dim:true,occlude});
          for(const spec of this.changelogSpecs)writer.add(spec);
        });
      }
      this.credentials=new CloudCredentialsInput({
        onAccount:value=>{this.cloudAccountInput=value;},
        onPassword:value=>{this.cloudPassword=value;},
      });
      // 确认框打开时页面整块不响应，确认框自己也只在有确认时响应。
      this.modal.enabled=()=>this.app.ui.ready&&!this.app.ui.suspended&&this.sys.isActive()&&(this.confirmAction!==undefined||this.changelogOpen);
      this.app.ui.menuLoaded();if(options.page==='slots')this.openSlots();else this.render();this.app.syncLifecycle?.();notifyBootReady();this.app.prefetchCommon?.();
    },error=>{if(!controller.signal.aborted)this.app.ui.error(String(error),()=>this.scene.restart());});
  }
  /** 标题页键盘：输入框让路，确认框的 Escape 只关确认框，其余交给页面按钮。 */
  private routeKey=(event:KeyboardEvent):boolean=>{
    if(this.app.ui.suspended)return false;
    // 键盘事件来自 DOM 输入框时归输入框；即使输入框刚失焦，也不能让同一次回车/退出触发菜单按钮。
    const target=event.target as HTMLElement|null;
    if(target&&(target.tagName==='INPUT'||target.tagName==='TEXTAREA'||target.isContentEditable))return true;
    // 改名、修改密码表单或云存档账号/密码框有焦点时键盘归输入框，场景不再处理按键。
    if(this.renameRef!==undefined||this.prompt?.active||this.passwordPrompt?.active||this.credentials?.focused)return true;
    // 更新日志和确认框打开时 Escape 只关最上层，不退出页面。
    if(event.key==='Escape'&&this.changelogOpen){event.preventDefault();this.closeChangelog();return true;}
    if(event.key==='Escape'&&this.confirmAction!==undefined){event.preventDefault();this.confirmAction.cancel();return true;}
    if(event.key==='Escape'&&this.page!=='home'){event.preventDefault();this.back();return true;}
    return this.surface?.key(event)??false;
  };
  /** 挑战模式不显示可用状态，只叠一层透明热区接收连续点击。 */
  private countChallengeClick():void{
    if(!this.app.ui.ready||this.app.ui.suspended||!this.sys.isActive())return;
    if(this.page!=='home'||this.confirmAction!==undefined||this.changelogOpen||this.renameRef!==undefined
      ||this.prompt?.active||this.passwordPrompt?.active||this.credentials?.focused)return;
    this.challengeClicks++;
    globalThis.storyDiagnostics?.record('pressure-click',{clicks:this.challengeClicks});
    if(this.challengeClicks>=5){
      this.challengeClicks=0;
      globalThis.storyDiagnostics?.record('pressure-enter',{});
      void this.app.startPressureTest?.();
    }
  }
  private resetChallengeClicks():void{
    this.challengeClicks=0;
  }
  /**
   * 右下角版本号；点击它切换 GM 调试模式。
   *
   * 版本号用主菜单按钮的 36 号字，直接作为点击目标，不另铺热点——它本身就很小，
   * 不需要连点防误触。打开时左下角常驻一行「调试：开」——它是状态指示，不是操作结果提示。
   * 开关关闭时这一行不存在。
   */
  private addVersion(view:UiSurface,texts:MenuTextSpec[]):void {
    texts.push({key:'version',text:GAME_VERSION,x:1180,y:612,style:{size:36,anchorX:1,anchorY:1}});
    texts.push({key:'notice',text:FAN_WORK_NOTICE,x:1180,y:632,style:{size:14,color:'#b8ab92',anchorX:1,anchorY:1}});
    const gm=this.app.gmMode;if(!gm||!this.menuText)return;
    // DOM 文字不接收指针：版本号使用同层 DOM 透明热区切换 GM。
    const zone=view.rect(1055,565,125,50,0,0).setInteractive();
    view.root.add(zone);
    zone.on('pointerdown',()=>{
      if(!this.app.ui.ready||this.app.ui.suspended||!this.sys.isActive())return;
      // 开关状态先同步画出来；目录是可选依赖，没有它也不能让「调试：开」一直不出现。
      if(gm.toggle()){this.render();void this.app.loadDebugCatalog?.().then(()=>this.render(),error=>console.error(error));}
      else this.render();
    });
    if(gm.on)texts.push({key:'gm-on',text:'调试：开',x:8,y:610,style:{size:18}});
  }
  /** 打开更新日志：先画加载态，数据到了再重画；主菜单自身不会在启动时加载这份文件。 */
  private openChangelog():void{
    if(this.changelogOpen||this.page!=='home'||!this.app.ui.ready||this.app.ui.suspended)return;
    this.changelogOpen=true;this.changelogState='loading';this.changelogError='';
    this.changelogEntries=[];this.changelogHeights=[];this.changelogOffsets=[];
    this.changelogSpecs=[];this.changelogScrollTop=0;
    this.changelogRequest?.abort();
    const controller=this.changelogRequest=new AbortController();
    this.render();
    if(!this.app.loadChangelog){this.changelogState='error';this.changelogError='当前版本没有更新日志';this.render();return;}
    // 必须作为对象方法调用：解构出来会丢掉 this，生产环境里直接抛错并停在加载态。
    void this.app.loadChangelog(controller.signal).then(catalog=>{
      if(controller.signal.aborted||this.changelogRequest!==controller||!this.changelogOpen)return;
      this.changelogEntries=catalog.entries.slice();
      this.changelogState=this.changelogEntries.length?'ready':'empty';
      this.render();
    },error=>{
      if(controller.signal.aborted||this.changelogRequest!==controller||!this.changelogOpen)return;
      this.changelogState='error';
      this.changelogError=error instanceof Error?error.message:'未知原因';
      this.render();
    });
  }
  private closeChangelog():void{
    this.changelogRequest?.abort();this.changelogRequest=undefined;
    this.changelogOpen=false;this.changelogState='idle';this.changelogError='';
    this.changelogEntries=[];this.changelogHeights=[];this.changelogOffsets=[];
    this.changelogSpecs=[];this.changelogScroll=undefined;this.changelogScrollTop=0;
    this.app.releaseChangelog?.();
    this.render();
  }
  /** 更新日志弹窗：复用标题页设置页的 slot 图框，金线就是面板外沿，右上角圆形关闭。 */
  private drawChangelog(v:UiSurface):void{
    const {panel,scroll:area,close,textSize}=CHANGELOG_LAYOUT;
    // 标题页的面板都是 `slot` 图框：内部半透明，金线贴外沿，不会在边框和背景之间露出一圈黑色。
    v.image(art('slot'),panel.x,panel.y,panel.width,panel.height);
    const scroll=v.scroll(area.x,area.y,area.width,area.height);
    this.changelogScroll=scroll;
    scroll.onScroll=()=>{this.changelogScrollTop=scroll.scrollTop;this.rebuildChangelogSpecs();this.menuText?.renderPage('changelog');};
    v.button('',panel.x+panel.width-close.right-close.size,panel.y+close.top,close.size,close.size,
      ()=>this.closeChangelog(),{image:CLOSE_IMAGE,pressed:CLOSE_PRESSED}).setData('label','关闭更新日志');
    this.changelogSpecs=[];
    if(this.changelogState==='loading')this.changelogMessage('正在加载更新日志…');
    else if(this.changelogState==='error')this.changelogMessage(`更新日志加载失败：${this.changelogError}`);
    else if(this.changelogState!=='ready'||!this.changelogEntries.length)this.changelogMessage('暂无更新日志。');
    else this.renderChangelogEntries(v,scroll,textSize);
  }
  /** 弹层顶部居中的版本号与说明；不随日志条目滚动。 */
  private changelogTitleSpec():MenuTextSpec {
    const {panel,titleY}=CHANGELOG_LAYOUT;
    return {key:'changelog-title',text:`${GAME_VERSION} 更新说明`,x:panel.x+panel.width/2,y:titleY,
      style:{size:28,color:GOLD,anchorX:.5,anchorY:.5,align:'center'},space:'modal'};
  }
  private changelogEntryText(index:number):string {
    return `${index+1}. ${this.changelogEntries[index]!}`;
  }
  /** 加载中、空列表和失败都只显示一行居中文字。 */
  private changelogMessage(text:string):void{
    const area=CHANGELOG_LAYOUT.scroll;
    this.changelogSpecs=[this.changelogTitleSpec(),{key:'changelog-message',text,x:area.x+area.width/2,y:area.y+area.height/2,
      style:{size:CHANGELOG_LAYOUT.textSize,color:GOLD,anchorX:.5,anchorY:.5,
        width:area.width-40,align:'center',wrap:'word'},space:'modal'}];
  }
  /** 先量每条正文的实际高度，算出总高度；真正输出时只取可视范围。 */
  private renderChangelogEntries(v:UiSurface,scroll:ScrollArea,textSize:number):void{
    const area=CHANGELOG_LAYOUT.scroll;
    const heights=this.changelogEntries.map((_entry,index)=>{
      const probe=v.text(this.changelogEntryText(index),0,0,area.width,textSize,GOLD);
      const height=probe.height;
      probe.destroy();
      return height;
    });
    const metrics=changelogMetrics(heights);
    this.changelogHeights=heights;this.changelogOffsets=metrics.offsets;
    scroll.setHeight(metrics.total);
    scroll.scrollTop=this.changelogScrollTop;
    this.rebuildChangelogSpecs();
  }
  /** 滚动时只替换屏幕内（含缓冲）的条目，不重建整份日志。 */
  private rebuildChangelogSpecs():void{
    const scroll=this.changelogScroll;
    if(!scroll)return;
    const area=CHANGELOG_LAYOUT.scroll;
    const {first,last}=changelogVisibleRange(this.changelogOffsets,this.changelogHeights,scroll.scrollTop,area.height);
    const specs:MenuTextSpec[]=[this.changelogTitleSpec()];
    for(let index=first;index<=last;index++)specs.push({key:`changelog-${index}`,text:this.changelogEntryText(index),
      x:area.x,y:area.y+this.changelogOffsets[index]!,
      style:{size:CHANGELOG_LAYOUT.textSize,color:GOLD,width:area.width,wrap:'word'},
      scroll:'changelog',clip:{top:area.y,bottom:area.y+area.height},space:'modal'});
    this.changelogSpecs=specs;
  }

  /** DOM 文字层由启动装配注入；菜单接口没有它，运行时从应用实例取。 */
  private get domUi():DomUi|undefined {
    return (this.app as MenuContext&{readonly domUi?:DomUi}).domUi;
  }
  /** 页面坐标 → 画框 CSS 坐标；和 `UiSurface` 的根变换同一口径。 */
  private menuTextPoint(x:number,y:number):MenuTextPoint {
    const root=this.surface?.root;
    if(!root)return{x,y,scale:1};
    const matrix=root.getWorldTransformMatrix(),point=matrix.transformPoint(x,y),css=canvasCssScale(this);
    return{x:point.x*css,y:point.y*css,scale:matrix.scaleX*css};
  }
  /**
   * 弹层本地坐标 → 画框 CSS 坐标。弹层和页面是同一屏幕层上的两个根节点，
   * `centerModal` 已经按页面变换放好弹层；DOM 标签要的是最终屏幕坐标，
   * 不能再减页面原点或除以页面缩放。
   */
  private modalTextPoint(x:number,y:number):MenuTextPoint {
    const modal=this.modal;
    if(!modal)return this.menuTextPoint(x,y);
    const matrix=modal.root.getWorldTransformMatrix(),point=matrix.transformPoint(x,y),css=canvasCssScale(this);
    return{x:point.x*css,y:point.y*css,scale:matrix.scaleX*css};
  }
  /** 确认横带在标题页画布坐标里的矩形；页面文字按它裁剪。 */
  private confirmOcclusion():MenuTextOcclude|undefined {
    const modal=this.modal,surface=this.surface,band=this.confirmBand;
    if(!modal||!surface||!band)return undefined;
    const matrix=surface.root.getWorldTransformMatrix(),origin=matrix.transformPoint(0,0),
      point=(x:number,y:number)=>{const world=modal.root.getWorldTransformMatrix().transformPoint(x,y);
        return{x:(world.x-origin.x)/matrix.scaleX,y:(world.y-origin.y)/matrix.scaleY};},
      edge=NATIVE_MESSAGE_EDGE,
      start=point(band.left,band.top-edge),end=point(band.left+band.width,band.top+band.height+edge);
    return{left:start.x,top:start.y,right:end.x,bottom:end.y};
  }
  /** 更新日志面板在标题页画布坐标里的矩形；页面文字按它裁剪。 */
  private changelogOcclusion():MenuTextOcclude|undefined {
    const modal=this.modal,surface=this.surface;
    if(!modal||!surface||!this.changelogOpen)return undefined;
    const {panel}=CHANGELOG_LAYOUT;
    const matrix=surface.root.getWorldTransformMatrix(),origin=matrix.transformPoint(0,0),
      point=(x:number,y:number)=>{const world=modal.root.getWorldTransformMatrix().transformPoint(x,y);
        return{x:(world.x-origin.x)/matrix.scaleX,y:(world.y-origin.y)/matrix.scaleY};},
      start=point(panel.x,panel.y),end=point(panel.x+panel.width,panel.y+panel.height);
    return{left:start.x,top:start.y,right:end.x,bottom:end.y};
  }
  /** 滚动文字按当前偏移重算；每次整页重画后指向新的滚动区。 */
  private menuScrollTop(page:string):number|undefined {
    if(page==='slots')return this.slotsScroll?.scrollTop;
    if(page==='settings')return this.settingsList?.scrollTop;
    if(page==='cloud')return this.cloudScroll?.scrollTop;
    if(page==='changelog')return this.changelogScroll?.scrollTop;
    return undefined;
  }
  /** 存档槽绘制的文字规格转成菜单文字规格。 */
  private saveBoardSpec(spec:SaveBoardTextSpec):MenuTextSpec {
    return {key:spec.key,text:spec.text,x:spec.x,y:spec.y,scroll:spec.scroll,clip:spec.clip,
      style:{size:spec.size,color:spec.color,anchorX:spec.anchorX,anchorY:spec.anchorY,align:spec.align,
        width:spec.width,wrap:spec.width?'word':undefined}};
  }
  /**
   * 云存档页的文字由面板绘制函数产出。这里截下 `text` 的调用换成 DOM 规格，
   * 图框、按钮和滚动区仍照常画；面板没有文字接收器，所以只在菜单场景这一层适配。
   */
  private drawCloudPage(view:UiSurface):MenuTextSpec[] {
    const made:{spec:MenuTextSpec;parent:UiNode}[]=[];
    const target=view as unknown as {text:UiSurface['text']};
    const original=target.text;
    target.text=((value:string,x:number,y:number,width=0,size=22,color=GOLD,parent=view.root)=>{
      const spec:MenuTextSpec={key:`cloud-${made.length}`,text:value,x,y,
        style:{size,color,anchorX:0,anchorY:0,width:width||undefined,wrap:width?'word':undefined}};
      const fake:{
        height:number;
        setOrigin:(anchorX?:number,anchorY?:number)=>unknown;
        setAlign:(align:'left'|'center'|'right')=>unknown;
        setPosition:(x:number,y:number)=>unknown;
        setVisible:(visible?:boolean)=>unknown;
      }={
        height:size+5,
        setOrigin(anchorX=0,anchorY=anchorX){spec.style.anchorX=anchorX;spec.style.anchorY=anchorY;return fake;},
        setAlign(align){spec.style.align=align;return fake;},
        setPosition(nextX,nextY){spec.x=nextX;spec.y=nextY;return fake;},
        setVisible(){return fake;},
      };
      made.push({spec,parent});
      return fake as unknown as UiText;
    }) as UiSurface['text'];
    try{
      drawCloudSavePage(view,this.cloudState(),this.cloudActions(),{frame:art('slot'),close:CLOSE_IMAGE,closePressed:CLOSE_PRESSED});
    }finally{
      target.text=original;
    }
    // 云页只有说明和状态在一个滚动区里；按钮文字直接挂在画布根节点上。
    const note=view.scrolls.at(-1);
    this.cloudScroll=note;
    if(note)note.onScroll=()=>this.menuText?.refresh();
    const specs:MenuTextSpec[]=[];
    for(const {spec,parent} of made){
      if(note&&parent===note.content){
        spec.x+=note.x;spec.y+=note.y;spec.scroll='cloud-note';
        spec.clip={top:note.y,bottom:note.y+note.height};
      }else if(parent!==view.root){
        spec.x+=parent.x;spec.y+=parent.y;
        if(parent.alpha<1&&spec.style.color)spec.style.color=fadeColor(spec.style.color,parent.alpha);
      }
      // 按钮标签在原实现里以自身中心为原点；有换行宽度时也要居中对齐。
      if(spec.style.anchorX===.5)spec.style.align='center';
      specs.push(spec);
    }
    return specs;
  }
  private render():void {
    // 异步目录加载和指针回调可能在场景关闭后才回来；surface 此时已经销毁。
    if(!this.surface||!this.sys.isActive())return;
    const view=this.surface;view.clear();this.modal?.clear();
    // DOM 标签直接写屏幕坐标；先让根节点用当前窗口尺寸完成布局，避免首帧按旧变换闪一下。
    view.layout();
    const guard=()=>this.app.ui.ready&&!this.app.ui.suspended&&this.sys.isActive()&&this.confirmAction===undefined&&this.renameRef===undefined&&!this.changelogOpen;
    view.enabled=guard;
    const texts:MenuTextSpec[]=[];
    const buttonText=(key:string,label:string,x:number,y:number,width:number,height:number,size:number,
      color=GOLD,scroll?:string,clip?:MenuTextClip):void=>{
      texts.push({key,text:label,x:x+width/2,y:y+height/2,style:{size,color,anchorX:.5,anchorY:.5},
        ...(scroll?{scroll,clip}:{})});
    };
    if(this.page==='home'){
      view.image(art('logo'),291,52,617,353);view.image(art('subtitle-left'),305,385,undefined,122);view.image(art('subtitle-right'),601,385,undefined,122);
      const menuButton=(key:string,label:string,x:number,y:number,width:number,height:number,action:()=>void,disabled=false,fontSize=36):UiNode=>{
        const button=view.button('',x,y,width,height,action,{fontSize,disabled,guard}).setData('label',label);
        buttonText(key,label,x,y,width,height,fontSize,disabled?'rgba(243,222,176,.4)':GOLD);
        return button;
      };
      menuButton('home-start','开始游戏',416,457,369,124,()=>this.openSlots());
      menuButton('home-settings','环境设置',65,472,300,92,()=>{this.resetChallengeClicks();this.page='settings';this.render();});
      const challenge=menuButton('home-challenge','挑战模式',835,472,300,92,()=>{},true);
      // 按钮本身保持禁用外观和键盘不可聚焦；透明热区和按钮原生层都只用于隐藏的连续点击。
      const challengeElement=(challenge as {element?:HTMLElement}).element;
      if(challengeElement){
        challengeElement.style.pointerEvents='auto';
        challengeElement.addEventListener('pointerdown',()=>this.countChallengeClick());
      }
      const challengeZone=view.rect(835,472,300,92,0,0).setInteractive();
      view.root.add(challengeZone);
      challengeZone.on('pointerdown',()=>this.countChallengeClick());
      // 右上角：按钮贴住画面右上，右边和上边各留 8 像素，整块落在 logo 右侧的空白上。
      menuButton('home-changelog','更新日志',982,8,210,64,()=>this.openChangelog(),false,28);
      this.addVersion(view,texts);
    }else if(this.page==='cloud'){
      texts.push(...this.drawCloudPage(view));
    }else{
      view.button('',28,21,67,67,()=>this.showHome(),{image:CLOSE_IMAGE,pressed:CLOSE_PRESSED,guard}).setData('label','返回主菜单');
      if(this.page==='slots'){
        texts.push({key:'slots-title',text:'存档槽',x:600,y:20,style:{size:49,anchorX:.5,anchorY:0}});
        view.button('',CLOUD_PAGE.entry.x,CLOUD_PAGE.entry.y,CLOUD_PAGE.entry.width,CLOUD_PAGE.entry.height,()=>this.openCloud(),{fontSize:26,guard}).setData('label','云存档');
        buttonText('cloud-entry','云存档',CLOUD_PAGE.entry.x,CLOUD_PAGE.entry.y,CLOUD_PAGE.entry.width,CLOUD_PAGE.entry.height,26);
        const assets={frame:art('slot'),empty:art('slot-empty')};
        const origin=saveBoardOrigin(view.width);
        setSaveBoardTextSink(view,{add:spec=>texts.push(this.saveBoardSpec(spec))});
        try{
          // 自动存档固定一行置顶；它没有改名与删除。
          const auto=this.app.saves.peek(AUTO_SAVE_SLOT),autoTitle=saveRowTitle(AUTO_SAVE_SLOT,auto);
          drawSaveBoardRow(view,assets,origin,SAVE_BOARD_LAYOUT.autoTop,
            {reading:auto,action:auto.kind==='ok'?()=>this.resume(AUTO_SAVE_SLOT):undefined,label:autoTitle,title:autoTitle,auto:true});
          // 十个手动槽放进滚动区；按写入时间倒序，最新的排最前，空槽排在后面。
          const scroll=view.scroll(origin.x,SAVE_BOARD_LAYOUT.listTop,SAVE_BOARD.panelWidth,SAVE_BOARD_LAYOUT.listHeight);
          this.slotsScroll=scroll;scroll.onScroll=()=>this.menuText?.refresh();
          newestFirstSlots(slot=>this.app.saves.peek(slot)).forEach((slot,index)=>{
            const ref=slot,reading=this.app.saves.peek(ref),title=saveRowTitle(ref,reading);
            drawSaveBoardRow(view,assets,{x:0,y:0},index*SAVE_BOARD.rowStep,{
              reading,label:title,title,
              action:reading.kind==='ok'?()=>this.resume(ref):reading.kind==='empty'?()=>{void this.app.enterGame?.(slot);}:undefined,
              ...this.slotControls(ref,reading),
            },scroll.content);
          });
          scroll.setHeight((MANUAL_SAVE_SLOT_COUNT-1)*SAVE_BOARD.rowStep+SAVE_BOARD.frameHeight);
        }finally{setSaveBoardTextSink(view,undefined);}
      }else{
        texts.push({key:'settings-title',text:'环境设置',x:600,y:20,style:{size:49,anchorX:.5,anchorY:0}});
        // 边框固定在原版位置；选项排进金色边线内侧的滚动区，行数增加时只滚动，不会压到边线。
        // 边线在 slot.png 原图里内缩约 18×20 像素，按显示尺寸换算后水平约 28、垂直约 47。
        const panel={x:200,y:126,width:800,height:425};
        view.image(art('slot'),panel.x,panel.y,panel.width,panel.height);
        const list=view.scroll(panel.x+40,panel.y+64,panel.width-80,panel.height-128),content=list.content;
        this.settingsList=list;
        const clip={top:list.y,bottom:list.y+list.height};
        const rowText=(key:string,value:string,x:number,y:number,size:number,color=GOLD,anchorX=0,anchorY=0):void=>{
          texts.push({key,text:value,x:list.x+x,y:list.y+y,style:{size,color,anchorX,anchorY},scroll:'settings',clip});
        };
        // 音频用滑动条实时改音量，其余项仍是开关；整页重画，滚动位置由 settingsScroll 接续。
        let rowTop=20;
        for(const [channel,label]of ([['music','背景音乐'],['effects','音效']]as const)){
          rowText(`settings-label-${channel}`,label,38,rowTop+12,34);
          // 轨道伸到面板右侧，百分比留在轨道右端。
          view.slider(channel,270,rowTop+33,380,this.app.audio?.settings[channel]??1,
            value=>this.app.audio?.setVolume(channel,value),content);
          rowTop+=100;
        }
        const rows:{label:string;value:string;action:()=>void;disabled?:boolean}[]=[];
        // 全屏是浏览器能力；不支持的环境显示为不可用，APK 壳已经隐藏系统栏，显示为已全屏。
        const fullscreen=fullscreenStatus();
        if(fullscreen==='available'){
          const active=fullscreenActive();
          rows.push({label:'全屏',value:active?'开':'关',action:()=>setFullscreen(!active)});
        }else{
          rows.push({label:'全屏',value:fullscreen==='packaged'?'已全屏':'不支持',action:()=>{},disabled:true});
        }
        rows.forEach((row,index)=>{
          const top=rowTop+index*100,size=row.value.length>2?30:34;
          rowText(`settings-label-${index}`,row.label,38,top+12,34);
          view.button('',270,top,190,67,row.action,{fontSize:size,guard,parent:content})
            .setData('label',`${row.label}：${row.value}`);
          rowText(`settings-value-${index}`,row.value,270+95,top+33.5,size,GOLD,.5,.5);
        });
        list.setHeight(20+(2+rows.length-1)*100+67+20);
        list.onScroll=()=>{this.settingsScroll=list.scrollTop;this.menuText?.refresh();};
        list.scrollTop=this.settingsScroll;
      }
    }
    this.domSpecs=texts;
    // 确认框打开时页面文字继续输出并压暗，被横带盖住的部分让位；加载或挂起时整层收起。
    const modalOpen=this.confirmAction!==undefined||this.changelogOpen;
    const textVisible=this.app.ui.ready&&!this.app.ui.suspended;
    this.popupMask?.setVisible(modalOpen&&this.app.ui.ready&&!this.app.ui.suspended);
    if(!textVisible)for(const label of this.modalLabels)label.setVisible(false);
    this.clearModalLabels();
    this.confirmBand=undefined;
    if(this.confirmAction){
      const action=this.confirmAction,modal=this.modal!;
      // 先按父画布的缩放放好弹层，横带才能按实际可见范围铺满屏幕。
      centerModal(modal,view,1024,640);
      this.confirmBand=drawNativeMessage(modal,TITLE_MESSAGE_ASSETS,action.message,()=>action.accept(),()=>action.cancel(),this.modalTextWriter());
    }
    if(this.changelogOpen&&this.modal){
      centerModal(this.modal,view,1024,640);
      this.drawChangelog(this.modal);
    }
    this.menuText?.renderPage(this.changelogOpen?'changelog':this.page);
    this.menuText?.setVisible(textVisible);
    this.layout();
  }
  private clearModalLabels():void{
    for(const label of this.modalLabels)label.remove();
    this.modalLabels.length=0;
  }
  /** 确认框正文：DOM 标签独立于页面文字层，确认框关闭时一起移除。 */
  private modalTextWriter():MenuTextWriter|undefined{
    const domUi=this.domUi;if(!domUi)return{add:()=>{}};
    return{add:spec=>{
      const point=this.modalTextPoint(spec.x,spec.y),scale=point.scale;
      const anchorX=spec.style.anchorX??0,anchorY=spec.style.anchorY??0;
      const label=domUi.label('screen','dom-label dom-native-message',{x:anchorX,y:anchorY});
      // 标题页确认框的正文是固定短句；万一超过横带，至少按横带可视高度裁住，不让文字压到按钮。
      const maxHeight=spec.clip?Math.max(0,(spec.clip.bottom-spec.clip.top)*scale):undefined;
      label.setText(spec.text).setPosition(point.x,point.y).setStyle({
        fontSize:`${spec.style.size*scale}px`,color:spec.style.color??'#ffffff',textAlign:spec.style.align??'center',
        width:spec.style.width===undefined?undefined:`${spec.style.width*scale}px`,
        lineHeight:`${(spec.style.lineHeight??spec.style.size+5)*scale}px`,whiteSpace:'pre-wrap',
        maxHeight:maxHeight===undefined?undefined:`${maxHeight.toFixed(2)}px`,overflow:maxHeight===undefined?undefined:'hidden',
        zIndex:'2'
      });
      this.modalLabels.push(label);
    }};
  }
  private cloudState():CloudPageState {
    return {
      available:!!this.app.cloud,
      account:this.cloudAccountInput,
      loggedIn:!!this.app.cloud?.loggedIn,
      busy:this.cloudBusy,
      cloudCount:this.cloudCount,
      status:this.cloudStatus,
    };
  }
  private cloudActions():CloudPageActions {
    return {
      back:()=>this.openSlots(),
      login:()=>{void this.submitCloud('login');},
      register:()=>{void this.submitCloud('register');},
      upload:()=>{void this.backupCloud();},
      download:()=>{void this.restoreCloud();},
      changePassword:()=>this.changeCloudPassword(),
      logout:()=>{void this.logoutCloud();},
    };
  }
  /** 手动槽的行内控件：有效存档可改名与删除，坏档只能删；自动槽永远没有。 */
  private slotControls(ref:SaveSlotRef,reading:SlotSummaryReading):{controls?:SaveBoardControl[]}{
    if(ref===AUTO_SAVE_SLOT)return {};
    // 控件用固定的槽位名（改名后仍叫「存档槽 N 删除」），行本身的标题才用自定义名字。
    const slotLabel=saveSlotLabel(ref);
    if(reading.kind==='ok')return {controls:[
      {text:'改名',label:`${slotLabel} 改名`,action:()=>this.renameSlot(ref)},
      {text:'删除',label:`${slotLabel} 删除`,action:()=>this.requestDelete(ref)},
    ]};
    if(reading.kind==='unreadable')return {controls:[{text:'删除',label:`${slotLabel} 删除`,action:()=>this.requestDelete(ref)}]};
    return {};
  }
  private requestDelete(ref:SaveSlotRef):void{
    if(ref===AUTO_SAVE_SLOT||this.app.saves.peek(ref).kind==='empty')return;
    this.confirmAction={
      message:'删除后无法恢复，确定删除这个存档？',
      accept:()=>this.deleteSlot(ref),
      cancel:()=>this.settleConfirm(false),
    };
    this.render();
  }
  private deleteSlot(ref:SaveSlotRef):void{
    try{this.app.saves.erase(ref);this.app.audio?.ui('select');}
    catch(error){console.warn('删除存档失败',error);}
    this.settleConfirm(true);
  }
  /** 改名：手机系统键盘输入，只收中文、英文、数字；确认后只改摘要里的名字。 */
  private renameSlot(ref:SaveSlotRef):void{
    if(ref===AUTO_SAVE_SLOT)return;
    const reading=this.app.saves.peek(ref);
    if(reading.kind!=='ok')return;
    const apply=(value:string|undefined):void=>{
      if(value!==undefined){
        try{this.app.saves.rename(ref,value);}
        catch(error){console.warn('存档改名失败',error);}
      }
      this.renameRef=undefined;this.render();
    };
    // 测试没有 DOM 输入框，直接注入一个返回值。
    if(this.app.promptText){void this.app.promptText(reading.summary.name??'').then(apply,()=>{});return;}
    this.renameRef=ref;this.render();
    this.prompt?.show({title:'存档名称',initial:reading.summary.name??'',
      onConfirm:value=>apply(value),onCancel:()=>apply(undefined)});
  }
  private settleConfirm(value:boolean,render=true):void{
    const resolve=this.confirmResolve;
    this.confirmResolve=undefined;
    this.confirmAction=undefined;
    if(render&&this.surface&&this.sys.isActive())this.render();
    resolve?.(value);
  }
  /** 云存档覆盖确认：返回 Promise，取消、Escape、离开云页或场景关闭时都会落地为 false。 */
  private confirmCloud(message:string):Promise<boolean>{
    if(this.confirmResolve){const previous=this.confirmResolve;this.confirmResolve=undefined;previous(false);}
    return new Promise<boolean>(resolve=>{
      this.confirmResolve=resolve;
      this.confirmAction={
        message,
        accept:()=>this.settleConfirm(true),
        cancel:()=>this.settleConfirm(false),
      };
      this.render();
    });
  }
  private cancelCloudRequest():void{
    this.cloudRequest?.abort();
    this.cloudRequest=undefined;
    this.cloudSerial+=1;
    this.cloudBusy=false;
    this.cloudPassword='';
    this.cloudStatus=undefined;
  }
  private openCloud():void{
    this.resetChallengeClicks();
    this.closeDialogs();
    this.slotRequest?.abort();
    
    this.cancelCloudRequest();
    const request=new AbortController();this.cloudRequest=request;
    const serial=++this.cloudSerial;
    this.page='cloud';
    this.cloudCount=undefined;
    this.render();
    const cloud=this.app.cloud;
    if(!cloud){
      this.cloudStatus={kind:'error',text:'云存档暂不可用，本机存档不受影响。'};
      this.render();
      return;
    }
    if(cloud.account)this.cloudAccountInput=cloud.account;
    if(!cloud.loggedIn){this.render();return;}
    void this.refreshCloud(request,serial);
  }
  private async refreshCloud(request:AbortController,serial:number):Promise<void>{
    const cloud=this.app.cloud;if(!cloud)return;
    const account=cloud.account;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:'正在检查登录…'};
    this.render();
    if(!await this.renewCloudIfNeeded(cloud,request,serial)){
      if(request.signal.aborted||serial!==this.cloudSerial)return;
      this.cloudBusy=false;
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return;
    }
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudStatus={kind:'info',text:'正在读取云端存档…'};
    this.render();
    const result=await cloud.list(request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    if(result.ok){
      this.cloudCount=result.value.length;
      this.cloudStatus=undefined;
    }else{
      if(result.error.code==='unauthorized'){
        if(account)this.cloudAccountInput=account;
        this.cloudCount=undefined;
        cloud.forget();
      }
      this.cloudStatus={kind:'error',text:result.error.message};
    }
    if(this.page==='cloud'&&this.sys.isActive())this.render();
  }
  /**
   * 打开云页时懒续期：只在 token 剩余不足 7 天时换发新 token。
   * 不在游戏内定时、不后台轮询；网络失败保留旧 token，让后续请求给出具体错误。
   */
  private async renewCloudIfNeeded(cloud:CloudSavePort,request:AbortController,serial:number):Promise<boolean>{
    const expiresAt=cloud.expiresAt;
    if(expiresAt===undefined)return true;
    const nowMs=Date.now();
    if(expiresAt-nowMs>CLOUD_SESSION_RENEW_WINDOW_MS)return true;
    const absoluteExpiresAt=cloud.absoluteExpiresAt;
    if(absoluteExpiresAt!==undefined&&absoluteExpiresAt<=expiresAt)return true;
    this.cloudStatus={kind:'info',text:'登录即将过期，正在续期…'};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
    const result=await cloud.refresh(request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return false;
    if(result.ok)return true;
    if(result.error.code==='unauthorized'){
      this.cloudAccountInput=cloud.account??this.cloudAccountInput;
      this.cloudCount=undefined;
      cloud.forget();
      this.cloudStatus={kind:'error',text:'登录已到期，请重新登录。'};
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return false;
    }
    return true;
  }
  private changeCloudPassword():void{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    if(this.app.promptPasswordChange){
      void this.app.promptPasswordChange().then(values=>{
        if(values)void this.submitPasswordChange(values.currentPassword,values.newPassword);
      },()=>{});
      return;
    }
    this.passwordPrompt?.show({
      onConfirm:(currentPassword,newPassword)=>{void this.submitPasswordChange(currentPassword,newPassword);},
      onCancel:()=>{},
    });
  }
  private async submitPasswordChange(currentPassword:string,newPassword:string):Promise<void>{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    if(!currentPassword){this.cloudStatus={kind:'error',text:'请输入当前密码。'};this.render();return;}
    const problem=validateCloudPassword(newPassword);
    if(problem){this.cloudStatus={kind:'error',text:problem};this.render();return;}
    if(newPassword===currentPassword){
      this.cloudStatus={kind:'error',text:CLOUD_NEW_PASSWORD_SAME_MESSAGE};
      this.render();
      return;
    }
    const request=this.cloudRequest??(this.cloudRequest=new AbortController());
    const serial=++this.cloudSerial;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:'正在修改密码…'};
    this.render();
    const result=await cloud.changePassword(currentPassword,newPassword,request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    if(!result.ok){
      if(result.error.code==='unauthorized')this.cloudAccountInput=cloud.account??this.cloudAccountInput;
      this.cloudStatus={kind:'error',text:result.error.message};
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return;
    }
    this.cloudAccountInput=result.value.account;
    this.cloudStatus={kind:'success',text:CLOUD_PASSWORD_CHANGED_MESSAGE};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
  }
  private async submitCloud(mode:'login'|'register'):Promise<void>{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    this.credentials?.blur();
    const account=normalizeCloudAccount(this.cloudAccountInput);
    const problem=validateCloudAccount(account)??validateCloudPassword(this.cloudPassword);
    if(problem){
      this.cloudStatus={kind:'error',text:problem};
      this.render();
      return;
    }
    this.cloudAccountInput=account;
    const request=this.cloudRequest??(this.cloudRequest=new AbortController());
    const serial=++this.cloudSerial;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:mode==='login'?'正在登录…':'正在注册…'};
    this.render();
    const result=mode==='login'
      ? await cloud.login(account,this.cloudPassword,request.signal)
      : await cloud.register(account,this.cloudPassword,request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    if(!result.ok){
      this.cloudStatus={kind:'error',text:result.error.message};
      if(result.error.code==='unauthorized')this.cloudAccountInput=account;
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return;
    }
    this.cloudPassword='';
    this.cloudAccountInput=result.value.account;
    this.cloudStatus={kind:'success',text:mode==='login'?'登录成功。':'注册成功，已登录。'};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
    await this.refreshCloud(request,serial);
    if(serial===this.cloudSerial&&this.page==='cloud'&&this.sys.isActive()&&this.cloudStatus===undefined&&this.app.cloud?.loggedIn){
      this.cloudStatus={kind:'success',text:mode==='login'?'登录成功，云端存档已读取。':'注册成功，已登录。'};
      this.render();
    }
  }
  private async logoutCloud():Promise<void>{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    const request=this.cloudRequest??(this.cloudRequest=new AbortController());
    const serial=++this.cloudSerial;
    const account=cloud.account;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:'正在退出登录…'};
    this.render();
    await cloud.logout(request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    this.cloudPassword='';
    this.cloudCount=undefined;
    if(account)this.cloudAccountInput=account;
    this.cloudStatus={kind:'info',text:'已退出登录。'};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
  }
  private async backupCloud():Promise<void>{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    const request=this.cloudRequest??(this.cloudRequest=new AbortController());
    const serial=++this.cloudSerial;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:'正在读取本机存档…'};
    this.render();
    let result:CloudSyncResult;
    try{
      result=await backupLocalSaves({
        cloud,
        saves:this.app.saves,
        confirm:message=>this.confirmCloud(message),
        progress:message=>{
          if(serial!==this.cloudSerial)return;
          this.cloudStatus={kind:'info',text:message};
          if(this.page==='cloud'&&this.sys.isActive())this.render();
        },
        signal:request.signal,
      });
    }catch(error){
      if(request.signal.aborted||serial!==this.cloudSerial)return;
      this.cloudBusy=false;
      this.cloudStatus={kind:'error',text:error instanceof Error?error.message:'云存档操作失败。'};
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return;
    }
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    this.cloudStatus={kind:this.syncStatusKind(result),text:this.syncMessage(result,'导入')};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
    if(result.ok||result.completed>0)void this.refreshCloudCount(request,serial);
  }
  private async restoreCloud():Promise<void>{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    const request=this.cloudRequest??(this.cloudRequest=new AbortController());
    const serial=++this.cloudSerial;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:'正在读取云端存档…'};
    this.render();
    let result:CloudSyncResult;
    try{
      result=await restoreCloudSaves({
        cloud,
        saves:this.app.saves,
        confirm:message=>this.confirmCloud(message),
        progress:message=>{
          if(serial!==this.cloudSerial)return;
          this.cloudStatus={kind:'info',text:message};
          if(this.page==='cloud'&&this.sys.isActive())this.render();
        },
        signal:request.signal,
      });
    }catch(error){
      if(request.signal.aborted||serial!==this.cloudSerial)return;
      this.cloudBusy=false;
      this.cloudStatus={kind:'error',text:error instanceof Error?error.message:'云存档操作失败。'};
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return;
    }
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    this.cloudStatus={kind:this.syncStatusKind(result),text:this.syncMessage(result,'恢复')};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
    // 场景暂停期间完成时先留在云页；resume 会重绘，避免切到存档页却没有画出来。
    if(result.ok&&result.completed>0&&this.sys.isActive())this.openSlots();
  }
  private async refreshCloudCount(request:AbortController,serial:number):Promise<void>{
    const cloud=this.app.cloud;if(!cloud)return;
    const result=await cloud.list(request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    if(result.ok){this.cloudCount=result.value.length;if(this.page==='cloud'&&this.sys.isActive())this.render();}
    else if(result.error.code==='unauthorized'){
      this.cloudCount=undefined;
      cloud.forget();
      this.cloudStatus={kind:'error',text:result.error.message};
      if(this.page==='cloud'&&this.sys.isActive())this.render();
    }
  }
  private syncStatusKind(result:CloudSyncResult):CloudPageStatus['kind']{
    if(result.ok)return 'success';
    return result.cancelled||result.aborted?'info':'error';
  }
  private syncMessage(result:CloudSyncResult,verb:string):string{
    if(result.cancelled)return '已取消。';
    if(result.aborted)return '操作已取消。';
    if(result.error)return result.error;
    if(result.total===0)return '没有可处理的存档。';
    const details=result.failures.map(failure=>`${cloudSlotLabel(failure.slot)}：${failure.reason}`).join('；');
    const summary=`${verb}成功 ${result.completed} 个`;
    return details?`${summary}，${result.failures.length} 个失败（${details}）`:`${summary}。`;
  }
  /** 存档槽直接读摘要里的截图 data URL 绘制；没有截图的旧档左侧留空。 */
  private openSlots():void{
    this.resetChallengeClicks();
    this.slotRequest?.abort();
    this.cancelCloudRequest();
    this.closeDialogs();
    this.slotRequest=new AbortController();
    this.page='slots';this.render();
  }
  private resume(slot:SaveSlotRef):void{
    const resume=this.app.resumeSlot;if(!resume)return;
    const request=this.slotRequest;
    void resume(slot,request?.signal).catch(error=>{
      if(!this.sys.isActive()||this.slotRequest!==request||request?.signal.aborted||error instanceof DOMException&&error.name==='AbortError')return;
      console.error(error);
      this.app.ui.error(error instanceof Error?error.message:String(error),()=>{this.app.ui.menuLoaded();this.openSlots();});
    });
  }
  private back():void {if(this.page==='cloud')this.openSlots();else this.showHome();}
  private showHome():void {
    this.cancelCloudRequest();
    this.closeDialogs();this.slotRequest?.abort();
    this.page='home';this.render();
  }
  /** 离开页面或重进时收掉确认框、改名输入和密码输入，免得残留状态一直挡住输入。 */
  private closeDialogs():void {
    this.settleConfirm(false,false);
    this.renameRef=undefined;
    this.prompt?.close();
    this.passwordPrompt?.close();
  }
  private layout():void {
    if(this.backdrop){this.backdrop.setPosition(0,0).setOrigin(0).setScale(1).setDisplaySize(this.scale.width,this.scale.height).fitting();}
    this.popupMask?.setSize(this.scale.width,this.scale.height);
    this.surface?.layout();
    if(this.surface&&this.modal&&(this.confirmAction!==undefined||this.changelogOpen))centerModal(this.modal,this.surface,1024,640);
    // 弹层里的滚动区（更新日志、长提示）跟着弹层位置和缩放重排。
    this.modal?.scrolls.forEach(scroll=>scroll.layout());
    this.syncCredentials();
    // 画布缩放或安全区变化后，DOM 文字的 CSS 坐标和字号要跟着重算。
    this.menuText?.refresh();
  }

  /** 云页、确认框和输入弹层互斥；只有账号/密码真正可见时才让 DOM 覆盖层出现。 */
  private credentialsVisible():boolean {
    return this.page==='cloud'
      && !!this.surface
      && !!this.app.cloud
      && !this.app.cloud.loggedIn
      && this.app.ui.ready
      && !this.app.ui.suspended
      && this.sys.isActive()
      && this.confirmAction===undefined
      && this.renameRef===undefined
      && !this.prompt?.active
      && !this.passwordPrompt?.active;
  }

  /** 把面板里的两行矩形换算成画框 CSS 坐标；输入框挂在 `#game-frame` 内，画框移动时自动跟随。 */
  private credentialRects():{account:CredentialInputRect;password:CredentialInputRect}|undefined {
    if(!this.surface)return;
    const frame=frameRect();
    if(!frame.width||!frame.height)return;
    const matrix=this.surface.root.getWorldTransformMatrix(),css=canvasCssScale(this);
    const map=(local:{x:number;y:number;width:number;height:number;fontSize:number}):CredentialInputRect=>{
      const point=matrix.transformPoint(local.x,local.y);
      return {
        left:point.x*css,
        top:point.y*css,
        width:local.width*matrix.scaleX*css,
        height:local.height*matrix.scaleY*css,
        fontSize:local.fontSize*matrix.scaleY*css,
      };
    };
    return {account:map(CLOUD_PAGE.accountInput),password:map(CLOUD_PAGE.passwordInput)};
  }

  private syncCredentials():void {
    const credentials=this.credentials;
    if(!credentials)return;
    if(!this.credentialsVisible()){credentials.hide();return;}
    const rects=this.credentialRects();
    if(!rects){credentials.hide();return;}
    credentials.setRects(rects.account,rects.password);
    credentials.setValues(this.cloudAccountInput,this.cloudPassword);
    credentials.show();
  }
}
