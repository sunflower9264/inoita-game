import { ShortcutEditor } from './shortcut-editor.ts';
import { SystemPage } from './system-page.ts';
import { SettingsPage } from './settings-page.ts';
import { SkillsPage } from './skills-page.ts';
import { StatusPage } from './status-page.ts';
import { BagPage } from './bag-page.ts';
import { MenuItemDrag } from './menu-item-drag.ts';
import { UiNode, UiImage, uiPointer, type UiPointer, type UiText } from './dom/node.ts';
import { UI_EVENTS } from '../application/ui-events.ts';
import { displaySettings } from '../application/display-settings.ts';
import { fullscreenActive, fullscreenStatus, onFullscreenChange } from '../application/fullscreen.ts';
import { controlSettings } from '../application/control-settings.ts';
import { CraftingPanel } from './phaser/crafting-panel.ts';
import { ForgePanel, type ForgeTab } from './phaser/forge-panel.ts';
import { EquipmentCrafting } from '../domain/crafting.ts';

import type Phaser from 'phaser';
import { ShortcutBar, type ShortcutEntry } from '../domain/shortcut-bar.ts';
import { controlPlacement } from './phaser/action-controls.ts';

import { type Modifier } from '../domain/character-stats.ts';

import { memberArt as memberArtwork } from '../domain/menu-panels.ts';

import type { StoryUIContext } from '../application/ports.ts';
import type { Session } from '../domain/session.ts';
import type { WorldIndex } from '../domain/content.ts';
import type { StoryInterface } from '../domain/story-interface.ts';
import type { CompanionMember } from '../domain/party.ts';

import { ShopPanel } from './phaser/shop-panel.ts';

import { Storefront } from '../domain/shop.ts';
import { QuestPanel } from './phaser/quest-panel.ts';
import { PartyPanel } from './phaser/party-panel.ts';
import { type InventoryView } from '../domain/inventory.ts';
import { type EquipmentSlot, type ItemInstance } from '../domain/items.ts';
import { GmPanel } from './phaser/gm-panel.ts';
import type { QuestStartPlan } from '../debug/quest-jump.ts';
import type { GmActions } from '../debug/gm-actions.ts';
import { frameRect, readSafeArea, uiUnitScale } from './viewport.ts';
import { ControlLayoutEditor } from './phaser/control-layout-editor.ts';
import { KeyBindingEditor } from './phaser/key-binding-editor.ts';
import { HUD_SIDE_BUTTON_SIZE } from './control-layout.ts';
import { controlViewport } from './phaser/control-layout-viewport.ts';
import { GOLD, UiSurface, type ScrollArea } from './phaser/widgets.ts';
import { MenuTextLayer, type MenuTextOcclude, type MenuTextSpec, type MenuTextWriter } from './dom/menu-text.ts';
import type { DomLabel } from './dom/dom-ui.ts';
import { setSaveBoardTextSink, type SaveBoardTextSpec } from './phaser/save-board.ts';
import { descriptionTitleOverflow, drawDescriptionClose, drawDescriptionPanel, drawDescriptionRows, drawDescriptionTitle } from './phaser/description-panel.ts';
import { drawNativeMessage, NATIVE_MESSAGE_EDGE, type NativeMessageBand } from './phaser/native-message.ts';

import { SavePage } from './save-page.ts';

import { SkillBookPanel } from './phaser/skill-book-panel.ts';

import { MENU_CANVAS_HEIGHT, MENU_CANVAS_WIDTH, centerModal } from './phaser/modal-placement.ts';
import { ACTIVE_PARTY_SLOT_COUNT } from '../domain/party-slots.ts';

import { itemDescriptionBody } from './item-detail-lines.ts';

import { BAG_DESCRIPTION_WIDTH, descriptionPanel } from './bag-layout.ts';

import { POPUP_FRAME, tradeLayout } from './shop-layout.ts';

import { LiveCharacterPreview, type PreviewRect } from './phaser/live-character-preview.ts';
import type { CharacterVisual } from '../rendering/characters.ts';
import type { ActorDefinition } from '../domain/content.ts';
import { storyMenuSignature, type StoryMenuPage, type StoryMenuViewModelSource } from './story-ui-signature.ts';

type Page=StoryMenuPage;
const tabs:[Page,string][]=[['status','人物'],['bag','背包'],['skills','技能'],['party','队伍'],['quests','任务'],['system','系统']];
/** 菜单内容块的固定原点；说明层与内容块共用同一坐标。 */
const CONTENT_ORIGIN={x:32,y:172} as const;
/** 正式菜单读取 Session，操作仍由背包、技能、队伍和商店领域对象执行。 */
export class StoryUI {
  private readonly app:StoryUIContext;
  private bagPage?:BagPage;
  private statusPage?:StatusPage;
  private skillsPage?:SkillsPage;
  private get menuBusy():boolean{return this.busy||!!this.bagPage?.isBusy||!!this.statusPage?.isBusy||!!this.skillsPage?.isBusy||!!this.shortcutEditor?.isBusy||!!this.savePage?.isBusy;}
  /** GM 面板按当前的动作层实例缓存；换会话（动作层重建）时一起换掉。 */
  private gmPanel?:GmPanel;
  private gmPanelOwner?:GmActions;
  private minimapHeight=132;
  private scene?:Phaser.Scene;private surface?:UiSurface;private body?:UiSurface;private hudButtons?:UiSurface;private modal?:UiSurface;private description?:UiSurface;
  /** 菜单页文字走 DOM；图框、按钮、滑条热区和滚动仍由 Phaser 画。 */
  private menuText?:MenuTextLayer;
  /** 技能页这一轮绘制收集到的文字；右侧说明区会随滚动一起换位置。 */
    /** GM 调试页这一轮绘制收集到的文字。 */
  private gmTextSpecs:MenuTextSpec[]=[];
  /** 存档/读档页上一次绘制收集到的文字；确认框打开时改用它自己的那一份。 */
  private saveTextSpecs:MenuTextSpec[]=[];
  private saveModalTextSpecs:MenuTextSpec[]=[];
  /** 通用原生提示（`drawNativeMessage`）的 DOM 文字；弹层坐标已换成当前页坐标。 */
  private noticeTextSpecs:MenuTextSpec[]=[];
  /** 原生提示横带的弹层本地覆盖范围；用于裁剪和页面文字让位。 */
  private noticeBand?:NativeMessageBand;
      private gmDetailTextSpecs:MenuTextSpec[]=[];
  private gmDetailOpen=false;
  /** 弹层/说明下方的黑色遮罩；画在菜单之上、说明层之下。 */
  private popupMask?:UiNode;
  /** 技能初始化确认框的文字规格；仍是弹层本地坐标，输出时统一换算。 */
  /** 登记快捷键那一屏单独一层：它盖在遮罩上，菜单本体整块藏起来。 */
  private shortcutScreen?:UiSurface;
  /** 登记快捷键那一屏的顶部提示；菜单文字层此时整体让位，所以单独挂一个标签。 */
  private shortcutPrompt?:DomLabel;
  private controlEditor?:ControlLayoutEditor;
  private keyBindingEditor?:KeyBindingEditor;
  /** 左上角圆形关闭钮单独一层：不随 960 内容区居中，靠安全区左上角摆放。 */
  private backTab?:UiSurface;
  private shortcutEditor?:ShortcutEditor;
  private backdrop?:UiNode;
  private session?:Session;private world?:WorldIndex;private content?:StoryInterface;private unsubscribe?:()=>void;private unsubscribeFullscreen?:()=>void;
  /** 菜单作用域的注销函数；重新 attach 或场景 shutdown 时先摘掉旧的。 */
  private unregisterKeyboard?:()=>void;
  private pressurePicker?:UiSurface;
  private pressureBackdrop?:UiNode;
  private pressureClassId?:string;
  /** 菜单是否打开；诊断用，和 `locked` 里的 `story-menu` 对应。 */
  get menuOpen():boolean{return this.open;}
  private page:Page='bag';private open=false;/** 从阵亡面板打开的读档页：关掉时要回到阵亡面板。 */private loadReturnToDefeat=false;private selectedMemberId='player';private questPanel?:QuestPanel;

  private itemNotice?:string;private busy=false;private request=new AbortController();
  /** GM 任务页选好跳转后，等玩家在存档页保存当前进度再执行。 */
  private pendingStoryJump?:QuestStartPlan;
  /** 上次整页重绘时当前页依赖的数据签名；会话通知用它判断要不要重绘。 */
  private sessionSignature='';
    /** 预热时菜单还没打开，只允许这一次在关闭状态绘制。 */
  private prewarming=false;
  /** 当前弹层的框尺寸，由打开它的对话框声明；初值只是没有对话框时的兜底。 */
  private modalBox={width:tradeLayout.quantity.width,height:tradeLayout.quantity.height};
  private modalActive=false;
  private resizeViewport='';
  private readonly placeModal=(width:number,height:number):void=>this.beginModal(width,height);
  /** 存档/读档页：确认框、改名输入和读档请求都由它自己持有。 */
  private savePage!:SavePage;
  private craftingPanel?:CraftingPanel;private craftingActor?:string;private forge?:ForgePanel;private skillBook?:SkillBookPanel;
  private shopPanel?:ShopPanel;private partyPanel?:PartyPanel;private notice='';
  private keyboardFocus?:UiNode;
  /**
   * 背包页那颗合成立绘。它按当前角色和身上装备拼出来，换人、换装备才重做；
   * 翻物品、点格子引起的重画直接搬回来用——每次重建一批精灵正是背包卡顿的一大来源。
   */
  private bagPortrait?:LiveCharacterPreview;
  private backdropPieces:UiNode[]=[];

  private settingsPage?:SettingsPage;
  private systemPage?:SystemPage;

    private scrollOffsets=new Map<string,number>();private scrollNames=new Map<string,ScrollArea>();
  private readonly itemDrag=new MenuItemDrag({delay:(ms,callback)=>this.scene!.time.delayedCall(ms,callback),movementThreshold:()=>8*this.surface!.root.scaleX,suspended:()=>this.app.ui.suspended});
  private drops:{object:UiNode|UiImage;entry?:string;slot?:EquipmentSlot;view?:InventoryView;cell?:number;craft?:boolean}[]=[];
  constructor(app:StoryUIContext){this.app=app;}
  /** 菜单图标后台补载完成后重画，已经打开的页面不会一直停在缺图占位。 */
  refreshMenuAssets():void { if(this.open)this.render(); }
  /**
   * 面板内容按原版基准排布：原版是 960×640、960 宽的内容区水平居中
   * （`CalcResolutionWidth = (虚拟宽-960)/2`，见 `work/findings/05_render_resolution.md`）。
   * 本作菜单画布是 1024 宽（多出来的宽度放顶部标签行与关闭按钮这些自建控件），
   * 所以内容块按 (1024-960)/2 = 32 居中，内部一律使用原版 960 空间的绝对坐标。
   * 所有页共用同一个原点——商店页曾经单独上移 32 像素，那是没有依据的特例。
   */
  attach(scene:Phaser.Scene,createPreview?:(actor:ActorDefinition)=>CharacterVisual):void{
    this.resizeViewport=JSON.stringify(controlViewport());
    this.scene=scene;this.surface=new UiSurface(scene,MENU_CANVAS_WIDTH,MENU_CANVAS_HEIGHT,100);this.body=new UiSurface(scene,960,431,200);this.surface.root.add(this.body.root);this.body.root.setPosition(CONTENT_ORIGIN.x,CONTENT_ORIGIN.y);
    // 交易弹层的画布按原版数量框的 450×350 建立，确认框在其中垂直居中。
    this.modal=new UiSurface(scene,tradeLayout.quantity.width,tradeLayout.quantity.height,400);
    this.modal.root.setPosition((MENU_CANVAS_WIDTH-tradeLayout.quantity.width)/2,(MENU_CANVAS_HEIGHT-tradeLayout.quantity.height)/2);
    // 存档页自己管确认框、改名输入和读档请求；菜单只提供重绘、弹层和滚动区位置。
    this.savePage=new SavePage({
      app:this.app,
      session:()=>this.session,
      world:()=>this.world,
      contentAssets:()=>this.content?.assets??{},
      uiScale:()=>this.surface?.root.getWorldTransformMatrix().scaleX??1,
      render:()=>this.render(),
      updateSaveRows:specs=>{
        this.saveTextSpecs=this.saveTextSpecs.filter(spec=>!spec.key.startsWith('save-slot-')).concat(specs.map(spec=>this.saveBoardText(spec)));
        this.menuText?.renderPage(this.page);
      },
      updateSaveTitle:(key,title)=>{
        const spec=this.saveTextSpecs.find(value=>value.key===key);if(spec)spec.text=title;
        this.menuText?.renderPage(this.page);
      },
      updateConfirmation:()=>{
        this.modal?.clear();
        for(const [name,scroll] of this.scrollNames)if(scroll.surface===this.modal)this.scrollNames.delete(name);
        this.renderSaveConfirmations();
        if(!this.savePage.modalOpen)this.menuText?.renderPage(this.page);
        this.sync();
      },
      sync:()=>this.sync(),
      busy:()=>this.busy,
      setItemNotice:message=>{this.itemNotice=message;},
      updateNotice:()=>this.updateItemNotice(),
      afterManualSave:()=>this.completePendingStoryJump(),
      modal:()=>this.modal!,
      modalWriter:()=>this.saveModalWriter(),
      beginModal:(width,height)=>this.beginModal(width,height),
      scroll:(name,x,y,width,height,surface)=>this.scroll(name,x,y,width,height,surface),
      finishScroll:(name,scroll,height)=>this.finishScroll(name,scroll,height)
    });
    // 说明面板单独一层，深度高于内容块的滚动层（`ScrollArea` 的 Layer 取父画布深度 +1）。
    // 停在右栏时它压在背包格子上，画在内容块里会被那一层整个盖住，底色和边框都看不见。
    // 它不挂在 surface 下面，所以位置与缩放要跟着 surface 自己同步（见 `layout`）。
    this.description=new UiSurface(scene,960,431,300);
    this.settingsPage?.destroy();
    const settingsMenu=this;
    this.settingsPage=new SettingsPage(this.app,{
      get body(){return settingsMenu.body;},get menuText(){return settingsMenu.menuText;},
      scroll:(...args)=>settingsMenu.scroll(...args),finishScroll:(...args)=>settingsMenu.finishScroll(...args),
      openKeyBindingEditor:()=>settingsMenu.openKeyBindingEditor(),openControlEditor:()=>settingsMenu.openControlEditor()
    });
    this.systemPage=new SystemPage(this.app,{
      get body(){return settingsMenu.body!;},navigate:page=>settingsMenu.show(page),close:()=>settingsMenu.close(),
      scroll:(...args)=>settingsMenu.scroll(...args),finishScroll:(...args)=>settingsMenu.finishScroll(...args),refresh:()=>settingsMenu.menuText?.renderPage('system')
    });
    // 登记快捷键那一屏按原版的 960×640 全屏坐标摆控件，深度压在遮罩之上、菜单之下。
    this.shortcutScreen=new UiSurface(scene,960,640,150);this.backTab=new UiSurface(scene,960,640,160);
    // 菜单图片、文字和交互共用 DOM 层。
    // 页面按名字登记文字产出函数，后续迁移新页面只需再 register 一次。
    if(this.app.domUi){
      this.menuText=new MenuTextLayer(this.app.domUi,
        (x,y)=>this.menuTextPoint(x,y),
        (_page,name)=>this.scrollNames.get(name)?.scrollTop);
      this.shortcutPrompt=this.app.domUi.label('screen','dom-shortcut-prompt',{x:.5,y:0}).setVisible(false);
      this.menuText.register('settings',writer=>{this.renderTabsText(writer);this.settingsPage?.renderText(writer);this.renderNoticeText(writer);});
      this.menuText.register('system',writer=>this.renderSystemText(writer));
      this.menuText.register('save',writer=>this.renderSaveText(writer));
      this.menuText.register('load',writer=>this.renderSaveText(writer));
      this.menuText.register('status',writer=>{
        // 加点确认框打开时页面文字压暗，只让出弹层矩形；弹层文字单独输出。
        const page=this.statusPage?.confirming?this.dimPage(writer,this.modalOcclusion()):writer;
        this.renderTabsText(page);this.statusPage?.renderStatusText(page);this.renderNoticeText(page);
        if(this.statusPage?.confirming)this.statusPage?.renderStatusModalText(writer);
      });
      this.menuText.register('party',writer=>{
        const panel=this.partyPanel;if(!panel)return;
        const page=panel.modalOpen?this.dimPage(writer,this.modalOcclusion()):writer;
        this.renderTabsText(page);panel.renderText(page);this.renderNoticeText(page);
        if(panel.modalOpen)panel.renderModalText({add:spec=>writer.add(this.modalTextSpec(spec))});
      });
      this.menuText.register('quests',writer=>{
        this.renderTabsText(writer);this.questPanel?.renderText(writer);this.renderNoticeText(writer);
      });
      this.menuText.register('skills',writer=>{
        // 技能初始化确认框打开时页面文字压暗，只让出弹层矩形；弹层文字单独输出。
        const page=this.skillsPage?.confirming?this.dimPage(writer,this.modalOcclusion()):writer;
        this.renderTabsText(page);
        for(const spec of this.skillsPage?.textSpecs??[])page.add(spec);
        this.renderNoticeText(page);
        if(this.skillsPage?.confirming)for(const spec of this.skillsPage?.confirmationTextSpecs??[])writer.add(this.modalTextSpec(spec));
      });
      this.menuText.register('bag',writer=>this.bagPage?.renderBagText(writer));
      // 技能书页顶部标题画在菜单画布坐标里，换算到内容块坐标后和面板文字一起输出。
      this.menuText.register('learn',writer=>{
        writer.add({key:'learn-title',text:this.skillBook?.title??'使用技能书',x:512-CONTENT_ORIGIN.x,y:25-CONTENT_ORIGIN.y,
          style:{size:28,color:GOLD,anchorX:.5,anchorY:0}});
        this.skillBook?.renderText(writer);
      });
      // 商店、融合器与强化台：弹层打开时页面文字压暗，弹层文字单独输出。
      this.menuText.register('shop',writer=>{
        const panel=this.shopPanel;if(!panel)return;
        const page=panel.modalOpen?this.dimPage(writer,this.modalOcclusion(POPUP_FRAME.corner.outer)):writer;
        panel.renderText(page);
        if(panel.modalOpen)panel.renderModalText({add:spec=>writer.add(this.modalTextSpec(spec))});
      });
      this.menuText.register('crafting',writer=>{
        const actor=this.craftingActor?this.world?.actors[this.craftingActor]:undefined,
          panel=this.craftingPanel,band=panel?.modalOpen?panel.messageBand:undefined,
          page=panel?.modalOpen?this.dimPage(writer,this.bandOcclusion(band)):writer;
        if(actor)page.add({key:'crafting-title',text:actor.name,x:512-CONTENT_ORIGIN.x,y:25-CONTENT_ORIGIN.y,
          style:{size:28,color:GOLD,anchorX:.5,anchorY:0}});
        if(!panel)return;
        panel.renderText(page);
        if(panel.modalOpen)panel.renderModalText({add:spec=>writer.add(this.modalTextSpec(spec))});
      });
      this.menuText.register('forge',writer=>{
        const panel=this.forge,band=panel?.confirming?panel.messageBand:undefined,
          page=panel?.confirming?this.dimPage(writer,this.bandOcclusion(band)):writer;
        page.add({key:'forge-title',text:'装备强化',x:512-CONTENT_ORIGIN.x,y:25-CONTENT_ORIGIN.y,
          style:{size:28,color:GOLD,anchorX:.5,anchorY:0}});
        if(!panel)return;
        panel.renderText(page);
        if(panel.confirming)panel.renderModalText({add:spec=>writer.add(this.modalTextSpec(spec))});
      });
      // GM 调试页的文字由面板自己收集。
      this.menuText.register('debug',writer=>{
        this.renderTabsText(writer);
        // 物品详情只盖住左侧一块：矩形外的调试页文字继续显示。
        for(const spec of this.gmTextSpecs)if(!this.gmDetailOpen||!this.gmDescriptionCovers(spec))writer.add(spec);
        if(this.gmDetailOpen)for(const spec of this.gmDetailTextSpecs)writer.add(spec);
        this.renderNoticeText(writer);
      });
      // 原生提示盖在页面上：页面文字整体压暗，横带矩形里的部分让位；弹层文字不压暗。
      this.menuText.register('native-notice',writer=>{
        const occlude=this.bandSurfaceOcclusion(this.noticeBand);
        if(this.page==='bag')this.bagPage?.renderBagText(writer,{dim:true,occlude:this.bandOcclusion(this.noticeBand)});
        else if(this.page==='save'||this.page==='load'){
          for(const spec of this.saveTextSpecs)writer.add({...spec,dim:true,occlude});
          this.renderNoticeText({add:spec=>writer.add({...spec,dim:true,occlude})},true);
        }
        for(const spec of this.noticeTextSpecs)writer.add(spec);
      });
      // 物品使用/丢弃弹层：底下的背包页继续显示，只把被弹层盖住的文字裁掉。
      this.menuText.register('operation-notice',writer=>{
        if(this.page==='bag')this.bagPage?.renderBagText(writer,{dim:true,occlude:this.modalOcclusion(POPUP_FRAME.corner.outer)});
        for(const spec of this.bagPage!.operationTexts)writer.add(this.modalTextSpec(spec));
      });
    }
    this.shortcutScreen.enabled=()=>this.open&&!this.app.ui.suspended&&!this.menuBusy&&!!this.shortcutEditor?.active;
    this.backTab.enabled=()=>this.shortcutScreen!.enabled();
    this.hudButtons=new UiSurface(scene,960,640,50);this.backdrop=new UiNode(scene).setSize(1,1).setFillStyle(0,.65).setDepth(99).setInteractive();
    this.backdropPieces=[];this.bagPortrait=createPreview?new LiveCharacterPreview(scene,rect=>this.setBackdropHole(rect),createPreview,.65):undefined;
    // 说明/弹层用：压暗菜单页和说明层（300），只让弹层（400）保持原色。
    this.popupMask=new UiNode(scene).setSize(1,1).setFillStyle(0,.65).setDepth(399).setVisible(false);
    this.surface.enabled=()=>this.open&&!this.app.ui.suspended&&!this.menuBusy&&!this.app.ui.controlLayoutEditing&&!this.app.ui.keyBindingEditing&&!this.shortcutEditor?.active&&!this.bagPage?.operationOpen&&!this.itemNotice&&!this.statusPage?.confirming&&!this.skillsPage?.confirming&&!this.savePage.blocksPage&&!this.craftingPanel?.modalOpen&&!this.shopPanel?.modalOpen&&!this.partyPanel?.modalOpen&&!this.forge?.confirming;
    this.body.enabled=()=>this.surface!.enabled();this.description.enabled=()=>this.body!.enabled();
    this.modal.enabled=()=>this.open&&!this.app.ui.suspended&&!this.menuBusy&&(!!this.bagPage?.operationOpen||!!this.itemNotice||!!this.statusPage?.confirming||this.skillsPage?.confirming||this.savePage.modalOpen||!!this.craftingPanel?.modalOpen||!!this.shopPanel?.modalOpen||!!this.partyPanel?.modalOpen||!!this.forge?.confirming);
    this.hudButtons.enabled=()=>this.app.ui.mode==='game'&&this.app.ui.ready&&!this.app.ui.locked&&!this.app.ui.suspended;
    scene.scale.on('resize',this.resize,this);
    // 菜单只注册一个 menu 作用域；打开时独占键盘，关闭时把未消费的按键让给剧情和世界。
    this.unregisterKeyboard?.();this.unregisterKeyboard=this.app.inputRouter.register('menu',this.key,{
      exclusive:()=>!!this.pressurePicker||this.open||this.app.ui.keyBindingEditing||this.app.ui.controlLayoutEditing
    });
    // 浏览器自身的退出（Esc、手势）不会走设置页的按钮，靠事件把开关状态同步回来。
    this.unsubscribeFullscreen?.();
    this.unsubscribeFullscreen=onFullscreenChange(()=>{
      if(!this.open||this.page!=='settings')return;
      this.settingsPage?.syncFullscreen();
    });
    const nativeInput=new AbortController();
    window.addEventListener('pointermove',event=>this.moveDrag(uiPointer(scene,event)),{signal:nativeInput.signal,capture:true});
    window.addEventListener('pointerup',event=>{this.endDrag(uiPointer(scene,event));},{signal:nativeInput.signal,capture:true});
    window.addEventListener('pointercancel',event=>{uiPointer(scene,event);this.statusPage?.cancelPress();this.cancelDrag();},{signal:nativeInput.signal,capture:true});
    window.addEventListener('blur',()=>{this.statusPage?.cancelPress();this.cancelDrag();},{signal:nativeInput.signal});
    scene.events.once('shutdown',()=>nativeInput.abort());
    scene.game.events.on(UI_EVENTS.minimapLayout,this.onMinimap,this);scene.game.events.on(UI_EVENTS.cancelInput,this.cancelDrag,this);
    scene.events.once('shutdown',()=>{this.closePressurePicker();this.unregisterKeyboard?.();this.unregisterKeyboard=undefined;this.unsubscribe?.();this.unsubscribeFullscreen?.();this.statusPage?.destroy();this.skillsPage?.destroy();this.settingsPage?.destroy();this.menuText?.destroy();this.menuText=undefined;this.shortcutPrompt?.remove();this.shortcutPrompt=undefined;scene.scale.off('resize',this.resize,this);scene.game.events.off(UI_EVENTS.minimapLayout,this.onMinimap,this);scene.game.events.off(UI_EVENTS.cancelInput,this.cancelDrag,this);this.cancelOperation();this.bagPage?.destroy();this.savePage.destroy();this.surface!.root.remove(this.body!.root);this.surface?.destroy();this.body?.destroy();this.modal?.destroy();this.hudButtons?.destroy();this.description?.destroy();this.shortcutScreen?.destroy();this.backTab?.destroy();this.bagPortrait?.destroy();this.backdrop?.destroy();this.popupMask?.destroy();this.popupMask=undefined;this.controlEditor?.destroy();this.controlEditor=undefined;this.keyBindingEditor?.destroy();this.keyBindingEditor=undefined;});
    this.sync();
  }
  private openPressurePicker():void {
    if(!this.scene||!this.app.pressureMode||this.pressurePicker)return;
    this.pressureClassId=this.session?.hero?.classId ?? this.app.storyClasses.defaultClass;
    this.app.ui.resetInput();this.app.ui.lock(true,'pressure-class');this.app.pausePressure?.(true);
    this.pressureBackdrop=new UiNode(this.scene).setDepth(499).setSize(frameRect().width,frameRect().height).setFillStyle(0,.65).setInteractive();
    this.pressurePicker=new UiSurface(this.scene,720,400,500);
    this.pressurePicker.enabled=()=>!this.app.ui.suspended;
    this.drawPressurePicker();this.sync();
  }
  private drawPressurePicker():void {
    const view=this.pressurePicker;if(!view)return;
    view.clear();view.rect(0,0,720,400,0x21190f,1);
    view.text('选择职业',360,30,300,26).setOrigin(.5);
    this.app.storyClasses.classes.forEach((entry,index)=>{
      const x=45+index%3*220,y=60+Math.floor(index/3)*115;
      view.button(entry.name,x,y,200,95,()=>{this.pressureClassId=entry.id;this.drawPressurePicker();},{selected:entry.id===this.pressureClassId});
      view.image(entry.icon,x+8,y+8,58,58);
    });
    view.button('取消',150,320,180,55,()=>this.closePressurePicker());
    view.button('以 1 级重新挑战',370,320,220,55,()=>{
      const classId=this.pressureClassId;
      if(!classId)return;
      this.closePressurePicker(false);void this.app.changePressureClass?.(classId);
    },{fontSize:19,disabled:this.pressureClassId===this.session?.hero?.classId});
    view.layout();
  }
  private closePressurePicker(resume=true):void {
    if(!this.pressurePicker)return;
    this.pressurePicker.destroy();this.pressurePicker=undefined;this.pressureBackdrop?.destroy();this.pressureBackdrop=undefined;
    this.pressureClassId=undefined;this.app.ui.lock(false,'pressure-class');
    if(resume)this.app.pausePressure?.(false);
    this.sync();
  }
  private createBagPage(session:Session,world:WorldIndex,content:StoryInterface):void{
    const ui=this;
    this.bagPage=new BagPage(session,world,this.app,{
      get selectedMemberId(){return ui.selectedMemberId;},get page(){return ui.page;},
      get suppressClick(){return ui.itemDrag.suppressClick;},
      get notice(){return ui.notice;},set notice(value){ui.notice=value;},
      get itemNotice(){return ui.itemNotice;},set itemNotice(value){ui.itemNotice=value;},
      active:()=>ui.session===session&&ui.open&&ui.page==='bag'&&!ui.shortcutEditor?.active,
      render:rebuild=>{if(rebuild){ui.renderNow();const signature=ui.sessionDataSignature();if(signature!==undefined)ui.bagPage?.rememberSignature(signature);}else ui.render();},
      sync:()=>ui.sync(),cancelDrag:()=>ui.cancelDrag(),startDrag:(pointer,entry,scroll)=>ui.startDrag(pointer,entry,scroll!),
      view:{
        get body(){return ui.body;},get description(){return ui.description;},get modal(){return ui.modal;},
        get menuText(){return ui.menuText;},get scene(){return ui.scene;},get bagPortrait(){return ui.bagPortrait;},
        get drops(){return ui.drops;},set drops(value){ui.drops=value;},
        scroll:(name,x,y,w,h,surface,bleed,bar)=>ui.scroll(name,x,y,w,h,surface,bleed,bar),
        finishScroll:(name,scroll,height)=>ui.finishScroll(name,scroll,height),
        deleteScroll:name=>ui.scrollOffsets.delete('bag:'+name),removeScroll:name=>ui.scrollNames.delete(name),
        removeDescriptionScrolls:()=>ui.removeDescriptionScrolls(),drawPartyColumn:(v,nodes)=>ui.drawPartyColumn(v,nodes),
        beginModal:(w,h)=>ui.beginModal(w,h),renderTabsText:writer=>ui.renderTabsText(writer),renderNoticeText:writer=>ui.renderNoticeText(writer),
      },
      navigation:{openForge:entry=>ui.openForge(entry),openSkillBook:entry=>ui.openSkillBook(entry),
        openShortcutScreen:(kind,id)=>ui.openShortcutScreen(kind,id),clearShortcut:(kind,id)=>ui.clearShortcut(kind,id),shortcutBar:()=>ui.shortcutBar(),
        recruited:member=>{ui.page='party';ui.partyPanel!.select(member);},closeMenu:()=>ui.close(),
      },
    },content);
  }
  bind(session:Session,world:WorldIndex,content:StoryInterface):void{
    this.statusPage?.discardAllocation();
    this.loadReturnToDefeat=false;
    this.pendingStoryJump=undefined;
    this.close();this.discardBagPage();this.hudButtons?.clear();this.unsubscribe?.();this.bagPage?.destroy();this.session=session;this.world=world;this.content=content;this.page='bag';this.selectedMemberId='player';this.scrollOffsets.clear();this.sessionSignature='';
    this.createBagPage(session,world,content);
    const menu=this;
    this.statusPage?.destroy();
    this.statusPage=new StatusPage({
      app:this.app,session,world,
      get selectedMemberId(){return menu.selectedMemberId;},get page(){return menu.page;},
      get body(){return menu.body;},get modal(){return menu.modal;},get surface(){return menu.surface;},get menuText(){return menu.menuText;},
      get notice(){return menu.notice;},set notice(value){menu.notice=value;},
      get keyboardFocus(){return menu.keyboardFocus;},set keyboardFocus(value){menu.keyboardFocus=value;},
      drawPartyColumn:view=>menu.drawPartyColumn(view),modalTextSpec:spec=>menu.modalTextSpec(spec),beginModal:(w,h)=>menu.beginModal(w,h),
      sync:()=>menu.sync(),render:()=>menu.render(),isBusy:()=>menu.busy||!!menu.bagPage?.isBusy,
      acknowledge:()=>{menu.sessionSignature=menu.sessionDataSignature()??menu.sessionSignature;}
    });
    this.skillsPage?.destroy();
    this.skillsPage=new SkillsPage(this.app,session,world,{
      get selectedMemberId(){return menu.selectedMemberId;},get active(){return menu.session===session&&menu.open&&menu.page==='skills';},
      get body(){return menu.body;},get modal(){return menu.modal;},get menuText(){return menu.menuText;},
      get scrollNames(){return menu.scrollNames;},get scrollOffsets(){return menu.scrollOffsets;},
      get notice(){return menu.notice;},set notice(value){menu.notice=value;},
      isBusy:()=>menu.busy||!!menu.bagPage?.isBusy||!!menu.statusPage?.isBusy,
      acknowledge:()=>{menu.sessionSignature=menu.sessionDataSignature()??menu.sessionSignature;},
      clearKeyboardFocus:()=>{menu.keyboardFocus=undefined;},drawPartyColumn:view=>menu.drawPartyColumn(view),
      scroll:(...args)=>menu.scroll(...args),finishScroll:(...args)=>menu.finishScroll(...args),
      beginModal:(...args)=>menu.beginModal(...args),sync:()=>menu.sync(),
      openShortcut:(kind,id)=>menu.openShortcutScreen(kind,id),clearShortcut:(kind,id)=>menu.clearShortcut(kind,id)
    });
    this.shortcutEditor?.close();
    this.shortcutEditor=new ShortcutEditor(this.app,session,{
      get selectedMemberId(){return menu.selectedMemberId;},get screen(){return menu.shortcutScreen;},get prompt(){return menu.shortcutPrompt;},
      acknowledge:()=>{menu.sessionSignature=menu.sessionDataSignature()??menu.sessionSignature;}
    });
    this.questPanel=new QuestPanel(session,world,this.app.menuPanels,()=>this.render(),
      (view,name,x,y,width,height)=>this.scroll(name,x,y,width,height,view),
      ()=>this.menuText?.refresh(),()=>this.menuText?.renderPage('quests'));
    this.partyPanel?.close();this.partyPanel?.destroyPreview();
    this.partyPanel=new PartyPanel(session,world,this.app,()=>this.render(),(id,page)=>this.selectMember(id,page),
      (view,name,x,y,width,height)=>this.scroll(name,x,y,width,height,view),()=>this.menuText?.refresh(),this.bagPortrait,
      ()=>this.menuText?.renderPage('party'),scroll=>{for(const [name,value] of this.scrollNames)if(value===scroll)this.scrollNames.delete(name);scroll.destroy();const index=this.body!.scrolls.indexOf(scroll);if(index>=0)this.body!.scrolls.splice(index,1);},()=>this.updatePartyModal(),action=>{this.busy=true;try{action();}finally{this.busy=false;this.sessionSignature=this.sessionDataSignature()??this.sessionSignature;}});
    this.unsubscribe=session.subscribe(()=>{
      // 快捷键登记、控制布局编辑与强化台/技能书页打开时由各自的界面显式重绘；
      // 子页面的动作在完成后调 changed 统一重绘一次，避免会话通知再画一遍。
      if(!this.open||this.shortcutEditor?.active||this.app.ui.controlLayoutEditing||this.page==='forge'||this.page==='learn')return;
      const signature=this.sessionDataSignature();
      if(this.page==='bag'){this.bagPage?.refresh(signature??'',false);return;}
      if(this.menuBusy)return;
      if(signature===undefined||signature!==this.sessionSignature){
        if(this.page==='debug')this.updateDebugPanel();else this.render();
      }
    });this.sync();
  }
  sync():void{
    if(this.app.ui.suspended){this.cancelDrag();this.savePage?.closeInput();}
    this.pressurePicker?.visible(!this.app.ui.suspended);this.pressureBackdrop?.setVisible(!this.app.ui.suspended);
    const active=this.app.ui.mode==='game'&&this.app.ui.ready&&!!this.session;
    if(!active&&this.open&&!((this.busy||this.savePage?.isLoading)&&this.app.ui.mode==='game'&&this.session)){this.statusPage?.discardAllocation();this.close();}
    if(this.app.ui.mode!=='game')this.hudButtons?.clear();
    this.hudButtons?.visible(active&&(!this.app.ui.locked||this.app.ui.controlLayoutEditing)&&!this.app.ui.suspended);
    if(active&&this.hudButtons&&this.hudButtons.root.list.every(child=>child===this.hudButtons!.staticRoot)){const v=this.hudButtons;v.button('',0,0,HUD_SIDE_BUTTON_SIZE,HUD_SIDE_BUTTON_SIZE,()=>this.show('save'),{image:this.content!.assets.save}).setData('label','存档');v.button('',0,HUD_SIDE_BUTTON_SIZE+8,HUD_SIDE_BUTTON_SIZE,HUD_SIDE_BUTTON_SIZE,()=>this.show('bag'),{image:this.content!.assets.menu}).setData('label','菜单');if(this.app.pressureMode)v.button('换职',0,0,HUD_SIDE_BUTTON_SIZE,HUD_SIDE_BUTTON_SIZE,()=>this.openPressurePicker(),{fontSize:18}).setData('label','换职业');}
    // 登记快捷键时菜单本体整块让位，只留背后的遮罩与这一屏自己，画面里那层游戏背景就露出来了。
    const menu=this.open&&this.app.ui.ready&&!this.app.ui.suspended&&!this.shortcutEditor?.active&&!this.app.ui.controlLayoutEditing&&!this.app.ui.keyBindingEditing;
    this.surface?.visible(menu);this.body?.visible(menu);this.description?.visible(menu&&!this.forge);
    const modal=menu&&(!!this.bagPage?.operationOpen||!!this.itemNotice||!!this.statusPage?.confirming||this.skillsPage?.confirming||this.savePage?.modalOpen||!!this.craftingPanel?.modalOpen||!!this.shopPanel?.modalOpen||!!this.partyPanel?.modalOpen||!!this.forge?.confirming);
    if(modal&&!this.modalActive)this.app.ui.resetInput();
    this.modalActive=modal;this.modal?.visible(modal);
    // DOM 文字盖在画布之上；弹层和菜单隐藏时必须一起让位，否则会浮在弹层上面。
    // 存档确认框、人物加点确认框和队伍弹层的文字也在 DOM 里，它们打开时这一层继续显示，
    // 但页面渲染函数只产出弹层那一份文字。
    const textModal=this.savePage?.modalOpen||(this.page==='status'&&!!this.statusPage?.confirming)||(this.page==='party'&&!!this.partyPanel?.modalOpen)
      ||(this.page==='shop'&&!!this.shopPanel?.modalOpen)||(this.page==='crafting'&&!!this.craftingPanel?.modalOpen)
      ||(this.page==='forge'&&!!this.forge?.confirming)||this.skillsPage?.confirming||!!this.itemNotice||!!this.bagPage?.operationOpen;
    this.menuText?.setVisible(menu&&(!modal||!!textModal));
    this.shortcutScreen?.visible(this.open&&!this.app.ui.suspended&&!!this.shortcutEditor?.active);this.backTab?.visible(this.open&&!this.app.ui.suspended&&!!this.shortcutEditor?.active);
    this.shortcutPrompt?.setVisible(this.open&&!this.app.ui.suspended&&!!this.shortcutEditor?.active);
    this.backdrop?.setVisible(this.open&&!this.app.ui.suspended);
    this.popupMask?.setVisible(menu&&modal);this.bagPortrait?.visible(menu);
    this.controlEditor?.visible(this.open&&this.app.ui.controlLayoutEditing&&!this.app.ui.suspended);
    this.keyBindingEditor?.visible(this.open&&this.app.ui.keyBindingEditing&&!this.app.ui.suspended);this.layout();
  }
  /** 阵亡界面的「读取存档」：先让出阵亡面板，再打开已有的读档页；关掉后由 `close` 恢复面板。 */
  openDefeatLoad():boolean{
    if(!this.session||!this.app.ui.ready||this.app.ui.mode!=='game'||this.app.ui.suspended)return false;
    this.loadReturnToDefeat=true;
    this.show('load');
    if(!this.open||this.page!=='load'){this.loadReturnToDefeat=false;return false;}
    return true;
  }
  show(page:Page):void{
    if(!this.session||!this.app.ui.ready||this.app.ui.mode!=='game'||this.app.ui.suspended||(!this.open&&this.app.ui.locked))return;
    if(this.page!==page&&this.statusPage?.requestAllocationExit(()=>this.show(page)))return;
    if(page==='quests'&&(!this.open||this.page!==page))this.questPanel?.reset();
    const reopening=!this.open;
    if(!this.open){this.open=true;this.app.ui.lock(true,'story-menu');}
    const signature=this.sessionDataSignature();
    const reuseBag=reopening&&page==='bag'&&this.bagPage?.cached&&signature!==undefined&&signature===this.bagPage?.signature;
    const previousPage=this.page;
    if(this.page!==page){
      if(this.page==='party')this.app.releasePartyPreview?.();
      if(this.page==='debug')this.releaseDebugPanel();
      if(this.page==='bag')this.bagPage?.clearBagTransientState();
      this.statusPage?.closePrompt();
      this.bagPage?.clearResult();this.cancelOperation();this.notice='';
    }
    // 背包页的 DOM、静态图框和合成立绘都留着；数据没变时只把整层显示出来。
    this.page=page;
    // 背包的滚动位置只属于一次进入：切页回来或重新打开都从第一行开始。
    if(page==='bag'&&(reopening||previousPage!=='bag')){
      this.scrollOffsets.delete('bag:inventory');
      if(reuseBag)this.bagPage?.resetScroll();
    }
    if(reopening||previousPage!==page)globalThis.storyDiagnostics?.record('menu-page',{page,open:true},false);
    if(reuseBag){this.sync();return;}
    // render() 末尾已经 sync 过；这里再调一次会把整层再排版一遍。
    this.render();
  }
  /** 进图后先把背包页画好并藏起来；首次打开只恢复显示。 */
  prewarmBag():void{
    if(this.open||!this.session||!this.surface||!this.body)return;
    const signature=this.sessionDataSignature();
    if(this.bagPage?.cached&&signature!==undefined&&signature===this.bagPage?.signature)return;
    this.prewarming=true;
    try{this.page='bag';this.renderNow();}catch(error){globalThis.storyDiagnostics?.record('bag-prewarm-error',{error});}finally{this.prewarming=false;}
    const next=this.sessionDataSignature();if(next!==undefined)this.bagPage?.rememberSignature(next);
  }
  openCrafting(actorId:string):void {
    if(!this.session||!this.app.crafting||this.world?.actors[actorId]?.service!=='fusion-machine'||this.app.ui.mode!=='game')return;
    if(this.statusPage?.requestAllocationExit(()=>this.openCrafting(actorId)))return;
    this.close();this.craftingActor=actorId;
    this.craftingPanel=new CraftingPanel(new EquipmentCrafting(this.session,this.app.crafting),this.app.menuPanels,()=>this.render(),()=>this.app.audio?.ui('craft'),this.app.shops.grades,()=>this.updateCraftingModal());
    this.show('crafting');
  }
  /**
   * 装备表已在内容里时同步打开，保持原有点击链路；生产包第一次开商店才返回 Promise，
   * 调用方可以忽略，也可以等它完成后再读 `shopPanel`。
   */
  openShop(shopId:string,mapId:string):void|Promise<void>{
    if(!this.session||!this.app.shops.shops[shopId]||this.app.ui.mode!=='game')return;
    if(this.statusPage?.requestAllocationExit(()=>{void this.openShop(shopId,mapId);}))return;
    if(Object.keys(this.app.shops.equipment).length){this.showShop(shopId,mapId);return;}
    // 正常流程进游戏时已在后台预取；这里只在预取没赶上时短暂等一下。
    this.app.ui.toast('正在准备商店…');
    return this.ensureShopEquipment().then(()=>{
      if(!this.session||this.app.ui.mode!=='game')return;
      this.showShop(shopId,mapId);
    }).catch(error=>{
      this.app.ui.toast('商店准备失败');
      globalThis.storyDiagnostics?.record('shop-equipment-load-error',{error});
    });
  }
  private showShop(shopId:string,mapId:string):void{
    this.close();const store=new Storefront(this.app.shops,this.session!.bag.catalog,this.app.characterStats,this.session!,shopId,mapId);this.shopPanel=new ShopPanel(store,this.session!,this.app.shops,this.app.menuPanels.assets,()=>this.render(),()=>this.member(),this.classNames(),message=>this.app.ui.showInstant(message));this.show('shop');
  }
  /** 生产内容包把 shops.equipment 拆到独立文件；第一次开商店时合并。 */
  private async ensureShopEquipment():Promise<void>{
    if(Object.keys(this.app.shops.equipment).length)return;
    this.app.shops.equipment=await this.app.content.shopEquipment();
  }
  /** 测试入口：直接把面板摆到目标状态，跳过点击链路。`entry` 是会话背包里的物品实例 id。 */
  debugDescribe(entry:string,side:'left'|'right'='left'):void{
    if(!this.session?.bag.get(entry))return;
    // `selectItem` 对同一条是「再点一次就收起」，调试条连点两下会把面板关掉，所以先清空再选。
    this.bagPage?.clearSelection();this.forge=undefined;
    this.show('bag');this.bagPage?.selectItem(entry,side);
  }
  /** 测试入口：直接打开某件物品的使用弹层。`kind='discard'` 打开丢弃框。 */
  debugUse(entry:string,kind:'use'|'discard'='use'):void{
    if(!this.session?.bag.get(entry))return;
    this.forge=undefined;this.show('bag');this.bagPage?.beginOperation(entry,kind);
  }
  /** 测试入口：打开商店并停在该店的某个交易步骤；`shopId` 必须是 shops.json 里存在的键。 */
  debugShop(shopId:string,step:'browse'|'description'|'quantity'='browse',kind:'buy'|'sell'='buy',mapId=''):void|Promise<void>{
    const opened=this.openShop(shopId,mapId);
    const apply=()=>{if(step!=='browse')this.shopPanel?.debugTrade(step,kind);};
    if(opened)return opened.then(apply);
    apply();
  }
  close():void{
    if(this.open&&this.statusPage?.requestAllocationExit(()=>this.close()))return;
    if(this.open)globalThis.storyDiagnostics?.record('menu-page',{page:this.page,open:false},false);
    if(!this.open){
      // 关闭态也可能已经创建了商店/合成/强化等子面板（例如 show() 的早退路径），一并丢掉。
      this.shopPanel?.destroy();this.shopPanel=undefined;this.craftingPanel=undefined;this.craftingActor=undefined;this.forge=undefined;this.skillBook=undefined;
      this.partyPanel?.destroyPreview();this.app.releasePartyPreview?.();
      return;
    }
    if(this.page==='debug')this.releaseDebugPanel();this.controlEditor?.close();this.app.ui.setControlLayoutEditing(false);
    this.keyBindingEditor?.close();this.app.ui.setKeyBindingEditing(false);this.cancelOperation();this.statusPage?.closePrompt();this.modalActive=false;this.shortcutEditor?.close();this.backTab?.clear();
    // 背包的说明面板和使用结果不属于缓存页面；下次打开背包时应回到干净的列表。
    const hadBagDetail=this.page==='bag'&&(this.bagPage?.hasSelection||this.bagPage?.hasResult);
    if(this.page==='bag')this.bagPage?.clearBagTransientState();
    const keepBag=this.page==='bag'&&this.bagPage?.cached&&!hadBagDetail;
    this.shopPanel?.destroy();this.shopPanel=undefined;this.partyPanel?.destroyPreview();this.app.releasePartyPreview?.();this.craftingPanel=undefined;this.craftingActor=undefined;this.forge=undefined;this.skillBook=undefined;this.open=false;
    if(keepBag)this.bagPortrait?.visible(false);else this.bagPortrait?.destroy();
    if(keepBag)this.bagPage?.resetScroll();
    this.scrollNames.forEach((scroll,name)=>this.scrollOffsets.set(`${this.page}:${name}`,scroll.scrollTop));if(!keepBag)this.scrollNames.clear();
    if(!keepBag){
      this.body?.clear();this.description?.clear();
      if(this.surface&&this.body){this.surface.clear(this.body.root);}
    }
    if(!keepBag)this.bagPage?.resetView();this.keyboardFocus=undefined;this.surface?.visible(false);this.body?.visible(false);this.description?.visible(false);this.modal?.visible(false);this.shortcutScreen?.visible(false);this.backTab?.visible(false);this.backdrop?.setVisible(false);this.app.ui.resetInput();this.app.ui.lock(false,'story-menu');
    if(this.loadReturnToDefeat){this.loadReturnToDefeat=false;if(this.app.ui.defeated)this.app.ui.revealDefeat();}
  }
  /** GM 任务页选好任务起点后先打开存档页；保存成功才真正跳转。 */
  private requestStoryJump(plan:QuestStartPlan):void{
    this.show('save');
    if(this.page!=='save')return;
    this.pendingStoryJump=plan;
    this.notice='先保存当前进度；保存成功后自动开始剧情跳转。';
    this.render();
  }
  /** 存档页写入成功后消费待办；失败原因显示在存档页或地图提示中。 */
  private completePendingStoryJump():void{
    const pending=this.pendingStoryJump;
    if(!pending)return;
    this.pendingStoryJump=undefined;
    const gm=this.app.gm;
    if(!gm){this.notice='剧情跳转不可用';this.render();return;}
    void gm.startStoryJump(pending).then(result=>{
      if(result.ok||this.app.gm!==gm)return;
      const message=`跳转失败：${result.reason??'原因未记录'}`;
      if(this.open&&this.page==='save'){this.notice=message;this.render();}
      else this.app.ui.toast(message);
    });
  }
  private releaseDebugPanel():void{
    this.gmPanel?.dispose();this.gmPanel=undefined;this.gmPanelOwner=undefined;
    this.gmTextSpecs=[];this.gmDetailTextSpecs=[];this.gmDetailOpen=false;
    this.menuText?.beginPage('');
  }
  releaseSession(expected:Session|undefined):void{
    if(this.session!==expected)return;
    this.statusPage?.discardAllocation();this.close();this.discardBagPage();this.releaseDebugPanel();this.unsubscribe?.();this.unsubscribe=undefined;
    this.questPanel=undefined;this.partyPanel?.destroyPreview();this.partyPanel=undefined;
    // 页面节点已经随 close/discardBagPage 销毁，清掉包装引用，别让旧会话的 DOM 留到下一次渲染。
    this.bagPage?.destroy();this.bagPage=undefined;this.drops=[];
    // 遮罩片挂在常驻 backdrop 下，不随 body 清理；换会话时先销毁再丢引用。
    for(const piece of this.backdropPieces)piece.destroy();
    this.backdropPieces=[];
    this.statusPage?.destroy();this.statusPage=undefined;this.skillsPage?.destroy();this.skillsPage=undefined;this.shortcutEditor?.close();this.shortcutEditor=undefined;
    this.session=undefined;this.world=undefined;this.content=undefined;
  }
  /** 会话结束时丢掉缓存的背包页，避免下一位存档的角色和物品沿用旧页面。 */
  private discardBagPage():void{
    if(!this.bagPage?.cached)return;
    this.bagPage?.resetView();this.scrollNames.clear();this.bagPortrait?.detach();
    this.body?.clear();this.description?.clear();
    if(this.surface&&this.body){this.surface.clear(this.body.root);}
  }

    private cancelOperation():void{
    this.cancelDrag();this.request.abort();this.request=new AbortController();this.busy=false;
    if(this.page==='bag')this.bagPage?.cancel();
    if(this.page==='save'||this.page==='load'){this.savePage?.cancelPending();this.pendingStoryJump=undefined;}
    if(this.page==='party')this.partyPanel?.close();
    if(this.page==='crafting')this.craftingPanel?.close();
    if(this.page==='forge')this.forge=undefined;
    if(this.page==='learn')this.skillBook=undefined;
    this.itemNotice=undefined;this.skillsPage?.cancel();this.modal?.clear();this.modal?.visible(false);
  }
  /** 返回是否消费这次按键；菜单关闭时把未消费的按键让给剧情层和世界。 */
  private key=(event:KeyboardEvent):boolean=>{
    if(this.app.ui.suspended)return false;
    if(this.pressurePicker){if(event.key==='Escape'){event.preventDefault();this.closePressurePicker();return true;}this.pressurePicker.key(event);return true;}
    // 捕获按键时整块键盘归键位面板：Tab、Enter、空格不再操作菜单。
    if(this.app.ui.keyBindingEditing){this.keyBindingEditor?.key(event);return true;}
    if(!this.open){
      // 菜单键只在正式游戏里生效；`repeat` 按住不放也只开一次。
      if(!event.repeat&&this.session&&this.app.ui.mode==='game'&&this.app.ui.ready&&!this.app.ui.locked
        &&this.app.keyBindings.matches('menu',event)){
        event.preventDefault();this.show('bag');return true;
      }
      return false;
    }
    // 改名或数字输入框开着时键盘归系统输入法：Enter/Escape 由输入框自己处理。
    if(this.savePage.renaming||this.shopPanel?.prompting||this.statusPage?.prompting
      ||(this.page==='debug'&&!!this.gmPanel?.searchFocused))return true;
    if(this.app.ui.controlLayoutEditing){if(event.key==='Escape'){event.preventDefault();this.closeControlEditor();}else this.controlEditor?.key(event);return true;}
    if(event.key==='Escape'&&this.itemNotice){event.preventDefault();this.itemNotice=undefined;this.updateItemNotice();return true;}
    if(this.savePage.handleEscape(event))return true;
    if(event.key==='Escape'&&this.statusPage?.confirming){event.preventDefault();this.statusPage?.finishAllocation(false);return true;}
    if(event.key==='Escape'){event.preventDefault();if(this.menuBusy){this.close();return true;}if(this.page==='forge'){if(this.forge?.confirming)this.forge.cancelConfirmation();else this.closeForge();return true;}if(this.page==='learn'){this.closeSkillBook();return true;}if(this.shortcutEditor?.active){this.closeShortcutScreen();return true;}if(this.skillsPage?.confirming){this.skillsPage?.closeConfirmation();}else if(this.craftingPanel?.modalOpen){this.craftingPanel.cancel();}else if(this.shopPanel?.active){this.shopPanel.cancel();}else if(this.partyPanel?.modalOpen){this.partyPanel.cancel();}else if(this.bagPage?.operationOpen){this.bagPage?.closeOperation();}else if(this.page==='bag'&&this.bagPage?.hasSelection){this.bagPage?.clearSelection();this.render();}else this.close();return true;}
    const surfaces=this.bagPage?.operationOpen||this.itemNotice||this.statusPage?.confirming||this.skillsPage?.confirming||this.savePage.modalOpen||this.craftingPanel?.modalOpen||this.shopPanel?.modalOpen||this.partyPanel?.modalOpen||this.forge?.confirming
      ?[this.modal!]:this.shortcutEditor?.active?[this.shortcutScreen!,this.backTab!]:[this.surface!,this.body!,this.description!];
    const buttons=surfaces.flatMap(surface=>surface.focusables());
    if(this.keyboardFocus&&!buttons.includes(this.keyboardFocus))this.keyboardFocus=undefined;
    if(event.key==='Tab'&&buttons.length){event.preventDefault();const current=this.keyboardFocus?buttons.indexOf(this.keyboardFocus):-1,index=current<0?(event.shiftKey?buttons.length-1:0):(current+(event.shiftKey?-1:1)+buttons.length)%buttons.length;this.keyboardFocus=buttons[index];surfaces.forEach(surface=>surface.focus(this.keyboardFocus!));this.menuText?.refresh();return true;}
    if((event.key==='Enter'||event.key===' ')&&this.keyboardFocus&&buttons.includes(this.keyboardFocus)){event.preventDefault();this.scene!.game.events.emit(UI_EVENTS.select);this.keyboardFocus.getData('action')();return true;}
    return false;
  }
  private onMinimap(height:number):void{this.minimapHeight=height;this.layout();}
  /** 缩放时登记屏的圆槽要按新锚点重摆，所以不光是 `layout`。 */
  private resize():void{
    const viewport=JSON.stringify(controlViewport()),changed=viewport!==this.resizeViewport;
    this.resizeViewport=viewport;this.layout();
    if(changed&&this.open&&this.modalActive)this.render();
    if(this.open&&this.shortcutEditor?.active){this.shortcutEditor?.render();this.renderBackButton();}
  }
  /**
   * 弹层画布按当前对话框的尺寸在菜单里居中。对话框开局声明一次并立即生效；`layout()` 在缩放
   * 变化时按同一个尺寸重算，所以锚点始终跟得上当前打开的那一个。
   */
  private beginModal(width:number,height:number):void{this.modalBox={width,height};this.positionModal();}
  private positionModal():void{if(this.surface&&this.modal)centerModal(this.modal,this.surface,this.modalBox.width,this.modalBox.height);}
  private layout():void{
    const frame=frameRect();
    this.controlEditor?.layout();this.keyBindingEditor?.layout();
    this.pressurePicker?.layout();this.pressureBackdrop?.setSize(frame.width,frame.height);
    this.surface?.layout(12);this.positionModal();this.modal?.relayoutOverlay();
    if(this.open&&this.page==='debug'&&this.gmPanel&&this.body)this.gmPanel.layoutSearch(this.body);
    // 说明面板不在 surface 之下，位置与缩放按 surface 的世界变换同步，坐标系与内容块一致。
    if(this.surface&&this.description){const matrix=this.surface.root.getWorldTransformMatrix(),position=matrix.transformPoint(CONTENT_ORIGIN.x,CONTENT_ORIGIN.y);this.description.root.setPosition(position.x,position.y).setScale(matrix.scaleX,matrix.scaleY);}
    // 登记快捷键那一屏按原版的屏幕坐标摆：缩放取操作区的缩放，屏幕左上角为原点；
    // 圆形关闭钮再让开设备安全区，其余内容里的 HUD 锚点已经算过安全区。
    if(this.scene&&this.shortcutScreen&&this.backTab){
      const {scale}=controlPlacement(),safe=readSafeArea();
      // 登记屏的内容按整屏坐标摆，根节点也要铺满整屏：小于内容的根节点会把右侧按钮裁掉。
      this.shortcutScreen.root.setPosition(0,0).setScale(scale)
        .setSize(frame.width/scale,frame.height/scale);
      this.backTab.root.setPosition(safe.left,safe.top).setScale(scale);
    }
    this.body?.scrolls.forEach(scroll=>scroll.layout());this.description?.scrolls.forEach(scroll=>scroll.layout());this.modal?.scrolls.forEach(scroll=>scroll.layout());
    if(this.hudButtons&&this.scene){
      const v=this.hudButtons,viewport=controlViewport(),scale=uiUnitScale(viewport.width,viewport.height);
      v.root.setScale(scale).setPosition(viewport.insets.left+12,viewport.insets.top);
      let index=0;
      for(const button of v.root.list){
        if(button===v.staticRoot)continue;
        button.setPosition(0,this.minimapHeight+12+index++*(HUD_SIDE_BUTTON_SIZE+8));
      }
    }
    this.backdrop?.setSize(frame.width,frame.height);this.bagPortrait?.layout();
    this.popupMask?.setSize(frame.width,frame.height);
    // 屏幕尺寸变化后，文字和图框按同一份页面变换重排。
    this.menuText?.refresh();
    if(this.shortcutEditor?.active)this.shortcutEditor?.placePrompt();
  }
  /** 内容块页面坐标 → 画框 CSS 坐标；和 `FormalUiScene.surfacePoint` 同一口径。 */
  private menuTextPoint(x:number,y:number):{x:number;y:number;scale:number}{
    // 系统页和存档/读档页按整块菜单画布排布（标签行 + 内容块），其它页用内容块坐标。
    const fullPage=this.page==='system'||this.page==='save'||this.page==='load';
    const root=fullPage?this.surface?.root:this.body?.root;
    if(!root)return{x,y,scale:1};
    const matrix=root.getWorldTransformMatrix(),point=matrix.transformPoint(x,y);
    return{x:point.x,y:point.y,scale:matrix.scaleX};
  }
  /** 弹层本地坐标 → 内容块坐标；DOM 层统一按内容块根节点换算 CSS 位置。 */
  private modalToPagePoint(x:number,y:number):{x:number;y:number}{
    const modal=this.modal,body=this.body;
    if(!modal||!body)return{x,y};
    const world=modal.root.getWorldTransformMatrix().transformPoint(x,y);
    // 画布容器只有平移和缩放，没有旋转；用原点加比例反算，不依赖矩阵的 applyInverse。
    const matrix=body.root.getWorldTransformMatrix(),origin=matrix.transformPoint(0,0);
    return{x:(world.x-origin.x)/matrix.scaleX,y:(world.y-origin.y)/matrix.scaleY};
  }
  /** 三个内容页共用的顶部标签行；坐标从菜单画布换到内容块。 */
  private renderTabsText(writer:MenuTextWriter):void{
    tabs.forEach(([,label],index)=>writer.add({key:`tab-${index}`,text:label,
      x:35+index*149+51-CONTENT_ORIGIN.x,y:25+85-CONTENT_ORIGIN.y,
      style:{size:20,color:GOLD,anchorX:.5,anchorY:0,width:90,align:'center'}}));
  }

  /** 页面文字是否落在说明面板盖住的矩形里。 */
  private descriptionCovers(spec:MenuTextSpec,rect:{x:number;y:number;width:number;height:number}):boolean {
    return spec.x>=rect.x&&spec.x<=rect.x+rect.width&&spec.y>=rect.y&&spec.y<=rect.y+rect.height;
  }
      /** 弹层在内容块坐标里的覆盖矩形；`pad` 用于把 drawPopupPanel 的图框外沿一起让出。 */
  private modalOcclusion(pad=0):MenuTextOcclude|undefined {
    if(!this.modal||!this.body)return undefined;
    const start=this.modalToPagePoint(0,0),end=this.modalToPagePoint(this.modalBox.width,this.modalBox.height);
    return{left:start.x-pad,top:start.y-pad,right:end.x+pad,bottom:end.y+pad};
  }
  /** 原生提示横带在内容块坐标里的覆盖矩形；按横带实际左右范围让位。 */
  private bandOcclusion(band?:NativeMessageBand):MenuTextOcclude|undefined {
    if(!this.modal||!this.body||!band)return undefined;
    const edge=NATIVE_MESSAGE_EDGE,
      start=this.modalToPagePoint(band.left,band.top-edge),end=this.modalToPagePoint(band.left+band.width,band.top+band.height+edge);
    return{left:start.x,top:start.y,right:end.x,bottom:end.y};
  }
  /** 弹层在整页表面坐标里的覆盖矩形；存档/读档页的页面文字用这一份。 */
  private modalSurfaceOcclusion():MenuTextOcclude|undefined {
    if(!this.modal||!this.surface)return undefined;
    const matrix=this.surface.root.getWorldTransformMatrix(),origin=matrix.transformPoint(0,0),
      point=(x:number,y:number)=>{const world=this.modal!.root.getWorldTransformMatrix().transformPoint(x,y);
        return{x:(world.x-origin.x)/matrix.scaleX,y:(world.y-origin.y)/matrix.scaleY};},
      start=point(0,0),end=point(this.modalBox.width,this.modalBox.height);
    return{left:start.x,top:start.y,right:end.x,bottom:end.y};
  }
  private bandSurfaceOcclusion(band?:NativeMessageBand):MenuTextOcclude|undefined {
    if(!this.modal||!this.surface||!band)return undefined;
    const matrix=this.surface.root.getWorldTransformMatrix(),origin=matrix.transformPoint(0,0),
      point=(x:number,y:number)=>{const world=this.modal!.root.getWorldTransformMatrix().transformPoint(x,y);
        return{x:(world.x-origin.x)/matrix.scaleX,y:(world.y-origin.y)/matrix.scaleY};},
      edge=NATIVE_MESSAGE_EDGE,
      start=point(band.left,band.top-edge),end=point(band.left+band.width,band.top+band.height+edge);
    return{left:start.x,top:start.y,right:end.x,bottom:end.y};
  }
  /** 页面文字统一压暗，并让出弹层覆盖的矩形。 */
  private dimPage(writer:MenuTextWriter,occlude?:MenuTextOcclude):MenuTextWriter {
    return{add:spec=>writer.add({...spec,dim:true,occlude})};
  }
  /** GM 调试页的物品详情固定在左侧，高 392；只让出这块矩形里的文字。 */
  private gmDescriptionCovers(spec:MenuTextSpec):boolean {
    const panel=descriptionPanel(BAG_DESCRIPTION_WIDTH);
    return this.descriptionCovers(spec,{x:60,y:panel.y,width:panel.width,height:392});
  }
  /** 底部提示行；设置等页用内容块坐标，系统/存档页用整页菜单坐标。 */
  private renderNoticeText(writer:MenuTextWriter,fullPage=false):void{
    if(!this.notice)return;
    writer.add({key:'notice',text:this.notice,x:fullPage?512:512-CONTENT_ORIGIN.x,y:fullPage?614:614-CONTENT_ORIGIN.y,
      style:{size:18,color:GOLD,anchorX:.5,anchorY:0,width:880,align:'center'}});
  }
  /** 弹层文字规格换成内容块坐标；滚动裁剪边界和文字一起换算。 */
  private modalTextSpec(spec:MenuTextSpec):MenuTextSpec{
    const point=this.modalToPagePoint(spec.x,spec.y);
    const clip=spec.clip?{top:this.modalToPagePoint(0,spec.clip.top).y,
      bottom:this.modalToPagePoint(0,spec.clip.bottom).y}:undefined;
    return{...spec,x:point.x,y:point.y,clip};
  }
  private member(){return this.selectedMemberId==='player'?this.session!.hero:this.session!.party?.get(this.selectedMemberId);}
  private classNames(){return Object.fromEntries(this.app.storyClasses.classes.map(value=>[value.id,value.name]));}
  /**
   * 队员栏：104×340 的栏里放三个 104×113 的成员按钮（`Scene_Init_POPUP_SC_CHARACTER_INFO @0x1e5478`
   * 里 `SetRect(?, 0/0x71/0xe2, 104, 113)`），每个画成员头像 86×96、落在框内 +(9,9)，
   * 所以第一格的头像就在 (17,58)。人物页与背包页共用这一栏（`UIEquip_CreatePartyControl`），
   * 点哪一格就切到那位成员身上，页面不变。
   */
  private drawPartyColumn(v:UiSurface,nodes?:UiNode[]):void{
    const panels=this.app.menuPanels,party=this.session!.party,ids=party?.activeIds??['player'];
    for(let index=0;index<ACTIVE_PARTY_SLOT_COUNT;index++){
      const id=ids[index],top=49+index*113;
      nodes?.push(v.image(panels.assets['character-party-frame'],8,top,104,114));
      if(!id)continue;
      const name=id==='player'?this.world!.actors[this.session!.campaign.start.actor].name:party?.get(id)?.definition.name??`队员 ${index+1}`;
      const button=v.button('',8,top,104,113,()=>{if(id!==this.selectedMemberId)this.selectMember(id,this.page);},{bare:true}).setData('label',name);
      nodes?.push(button);
      // 头像相对按钮格子 (9,9)，即内容坐标的 (17, top+9)：`button` 是它的父容器，
      // 传绝对坐标会被再加一次按钮偏移，头像就会掉到格子外面。
      v.imageCover(this.memberPartyIcon(id),9,9,86,96,button,.5,.2);
    }
  }
  /** 某位成员在队员栏里的头像；佣兵用职业图，主角与剧情同伴用人物状态立绘的小图。 */
  private memberPartyIcon(id:string):string{
    const member=id==='player'?this.session!.hero:this.session!.party?.get(id);
    const source=id==='player'?undefined:(member as CompanionMember|undefined)?.source;
    const actor=this.world!.actors[id==='player'?this.session!.campaign.start.actor:(member as CompanionMember).definition.actor];
    return memberArtwork(this.app.menuPanels,actor,member!.classId,source).partyIcon;
  }
  private configuration(){return this.selectedMemberId==='player'?this.session!.skills:(this.member() as CompanionMember).skills;}

  private scroll(name:string,x:number,y:number,w:number,h:number,surface=this.body!,bleed=0,
    bar?:Parameters<UiSurface['scroll']>[5]):ScrollArea{
    const scroll=surface.scroll(x,y,w,h,bleed,bar);this.scrollNames.set(name,scroll);
    // DOM 文字浮在画布上，滚动位置变了必须重新换算坐标。建区时先放一个默认入口；
    // 面板设置自己的 `onScroll` 时会覆盖它，由面板回调保存偏移、收起详情并刷新文字。
    // 同一次滚动只走一个刷新入口，不再让监听器和面板回调各算一遍整页文字。
    scroll.onScroll=()=>this.menuText?.refresh();return scroll;
  }
  private finishScroll(name:string,scroll:ScrollArea,height:number):void{scroll.setHeight(height);scroll.scrollTop=this.scrollOffsets.get(`${this.page}:${name}`)??0;}
  /**
   * 会话每次通知都会走到这里；只有当前页真正依赖的数据变化时才整页重绘。
   * 界面操作仍然直接调 `render()`，不经过这道门。
   */
  private render():void{
    // 背包页已经画好时，普通数据变化只更新格子、装备和说明，不再把整页 DOM 拆掉。
    // 操作确认等弹层有独立更新路径，正常背包变化只更新受影响的节点。
    if(this.page==='bag'&&this.bagPage?.cached&&this.bagPage?.hasGrid&&!this.bagOverlayOpen()){
      this.bagPage?.updateBagPage();
      const signature=this.sessionDataSignature();
      if(signature!==undefined)this.bagPage?.rememberSignature(signature);
      return;
    }
    this.renderNow();
    const signature=this.sessionDataSignature();
    if(signature!==undefined){if(this.page==='bag')this.bagPage?.rememberSignature(signature);else this.sessionSignature=signature;}
  }
  private bagOverlayOpen():boolean{
    return !!this.bagPage?.operationOpen||!!this.itemNotice||!!this.statusPage?.confirming||!!this.skillsPage?.confirming
      ||!!this.shortcutEditor?.active||this.app.ui.controlLayoutEditing;
  }
  /** 当前页的显式签名；具体字段由 `story-ui-signature.ts` 按页面收口。 */
  private sessionDataSignature():string|undefined{
    return this.session?storyMenuSignature(this.signatureSource(this.session)):undefined;
  }
  private signatureSource(session:Session):StoryMenuViewModelSource{
    return {
      page:this.page,selectedMemberId:this.selectedMemberId,session,
      slotReading:ref=>this.app.saves.peek(ref),
      settings:()=>({
        music:this.app.audio?.settings.music??0,effects:this.app.audio?.settings.effects??0,
        fps:displaySettings.fps,frameRateLimit:displaySettings.frameRateLimit,renderScale:displaySettings.renderScale,textureBatching:displaySettings.textureBatching,criticalDecorations:displaySettings.criticalDecorations,
        fullscreen:fullscreenStatus(),fullscreenActive:fullscreenActive(),controlMode:controlSettings.mode
      }),
      learn:()=>this.skillBook?.viewModel??{entryId:'',message:''},
      forge:()=>this.forge?.viewModel??{tab:'enchant',confirming:false},
      debug:()=>({noclip:this.app.gm?.isNoclip()??false,doubleSpeed:this.app.gm?.isDoubleSpeed()??false})
    };
  }
  /** GM 上报用：列出菜单场景里不属于任何面板容器的可见显示对象。 */
  diagnosticState(): Record<string, unknown> {
    const scene = this.scene;
    if (!scene) return { attached: false };
    const owned = new Set<unknown>();
    const visit = (node: unknown) => {
      if (!node || owned.has(node)) return;
      owned.add(node);
      for (const child of ((node as { list?: unknown[] }).list ?? [])) visit(child);
    };
    for (const root of [this.surface?.root, this.body?.root, this.description?.root, this.modal?.root,
      this.shortcutScreen?.root, this.backTab?.root, this.hudButtons?.root]) if (root) visit(root);
    if (this.backdrop) owned.add(this.backdrop);
    type LooseNode = { visible?: boolean; texture?: { key?: string }; x?: number; y?: number; width?: number; height?: number; depth?: number; type?: string };
    const loose = ((scene as unknown as { children?: { list?: LooseNode[] } }).children?.list ?? [])
      .filter(node => !owned.has(node) && node.visible !== false)
      .slice(0, 20)
      .map(node => ({
        type: node.type ?? null,
        texture: node.texture?.key ?? null,
        x: Math.round(node.x ?? 0), y: Math.round(node.y ?? 0),
        width: Math.round(node.width ?? 0), height: Math.round(node.height ?? 0),
        depth: node.depth ?? null,
      }));
    return { attached: true, open: this.open, page: this.page, loose };
  }
  private renderNow():void{
    if((!this.open&&!this.prewarming)||!this.surface||!this.body||!this.session)return;
    this.bagPage?.resetView();
    this.forge?.captureScroll();this.skillBook?.captureScroll();this.craftingPanel?.captureScroll();this.shopPanel?.captureScroll();this.questPanel?.captureScroll();this.partyPanel?.captureScroll();this.scrollNames.forEach((scroll,name)=>this.scrollOffsets.set(`${this.page}:${name}`,scroll.scrollTop));this.scrollNames.clear();this.surface.clear(this.body.root);this.bagPortrait?.detach();this.partyPanel?.detachPreview();this.body.clear();this.description?.clear();this.modal!.clear();this.drops=[];this.keyboardFocus=undefined;
    if(!this.member()){this.statusPage?.discardAllocation();this.selectedMemberId='player';}const v=this.surface;
    this.body.root.setPosition(CONTENT_ORIGIN.x,CONTENT_ORIGIN.y);
    // 登记快捷键时菜单本体不画：只重画那一屏（它自己在 `sync` 里显示、菜单整块隐藏）。
    if(this.app.ui.controlLayoutEditing){this.surface.clearStatic();this.body.clearStatic();this.sync();return;}
    if(this.shortcutEditor?.active){this.surface.clearStatic();this.body.clearStatic();this.shortcutEditor?.render();this.renderBackButton();this.sync();return;}
    // 各面板的固定图框交给静态层，切换到其他页面时清除。
    if(!['bag','shop','crafting','forge','learn'].includes(this.page))this.body.clearStatic();
    const commonTabs=!['shop','crafting','forge','learn','save','load'].includes(this.page);
    const chromeKey=commonTabs?'chrome:tabs':`chrome:${this.page}${this.page==='crafting'?`:${this.craftingActor}`:''}`;
    v.staticLayer(chromeKey,()=>{
      if(this.page!=='shop'&&this.page!=='crafting'&&this.page!=='forge'&&this.page!=='learn'&&this.page!=='save'&&this.page!=='load'){
        // 页签只留底图和命中区，文字统一由当前页的 DOM 渲染器输出。
        tabs.forEach(([page,label],index)=>{const button=v.button('',35+index*149,25,102,116,()=>this.show(page),{bare:true,parent:v.staticRoot}).setData('label',label).setData('menuTab',page);v.image(this.content!.assets[`tab-${page}`],12,0,78,78,button);});
      }
      // 融合器与强化台的顶部标题由 DOM 输出，静态层只留关闭钮。
      // 技能书页标题同样由 DOM 输出。
      v.button('',947,24,51,51,()=>this.page==='forge'?this.closeForge():this.page==='learn'?this.closeSkillBook():this.close(),{image:this.content!.assets.close,pressed:this.content!.assets['close-pressed'],parent:v.staticRoot}).setData('label',this.page==='forge'?'关闭强化':this.page==='learn'?'关闭技能书':'关闭菜单');
    });
    if(commonTabs){
      for(const button of v.staticRoot.list){
        const page=button.getData('menuTab') as Page|undefined;
        if(page)button.setAlpha(this.page===page||(['settings','debug'] as Page[]).includes(this.page)&&page==='system'?1:.65);
      }
    }
    const textScroll=(name:string,x:number,y:number,width:number,height:number,surface?:UiSurface)=>this.scroll(name,x,y,width,height,surface??this.body!);
    const refreshText=()=>this.menuText?.refresh();
    if(this.page==='bag')this.bagPage?.renderBag();if(this.page==='status')this.statusPage?.renderStatus();if(this.page==='skills')this.skillsPage?.renderSkills();if(this.page==='party')this.renderParty();if(this.page==='quests')this.renderQuests();
    if(this.page==='shop')this.shopPanel?.render(this.body,this.modal!,this.placeModal,this.description!,{scroll:textScroll,refresh:refreshText,
      setText:(key,text)=>this.menuText?.setText('shop',key,text),updatePage:()=>this.menuText?.renderPage('shop'),
      runTrade:action=>{this.busy=true;try{action();}finally{this.busy=false;this.sessionSignature=this.sessionDataSignature()??this.sessionSignature;}},
      updateDescription:draw=>{this.description?.clear();this.removeDescriptionScrolls();draw();this.menuText?.renderPage('shop');},
      updateModal:draw=>{
        this.modal?.clear();
        for(const [name,scroll] of this.scrollNames)if(scroll.surface===this.modal)this.scrollNames.delete(name);
        draw();this.menuText?.renderPage('shop');this.sync();
      }});
    if(this.page==='crafting'&&this.craftingPanel){this.craftingPanel.render(this.body,this.modal!,this.placeModal,(pointer,entry,scroll)=>this.startDrag(pointer,entry,scroll),{scroll:textScroll,refresh:refreshText,updatePage:()=>this.menuText?.renderPage('crafting'),runCommit:action=>{this.busy=true;try{action();}finally{this.busy=false;this.sessionSignature=this.sessionDataSignature()??this.sessionSignature;}},removeScroll:scroll=>{for(const [name,value] of this.scrollNames)if(value===scroll)this.scrollNames.delete(name);}});this.drops=this.craftingPanel.drops;}
    if(this.page==='forge'&&this.forge)this.forge.render(this.body,this.modal!,this.placeModal,{scroll:textScroll,refresh:refreshText,updatePage:()=>this.menuText?.renderPage('forge')});
    if(this.page==='learn'&&this.skillBook)this.skillBook.render(this.body!);
    if(this.page==='system')this.systemPage?.render();
    if(this.page==='debug'&&this.app.gm){
      // 面板按当前动作层实例缓存：同一会话里保留过滤与选中，换会话就重建。
      if(this.gmPanelOwner!==this.app.gm){
        const gm=this.app.gm;
        this.gmPanel=new GmPanel(gm,this.session.campaign,{close:()=>this.close(),render:()=>{if(this.app.gm===gm&&this.gmPanelOwner===gm)this.updateDebugPanel();},runAction:action=>{this.busy=true;try{return action();}finally{this.busy=false;this.sessionSignature=this.sessionDataSignature()??this.sessionSignature;}},requestStoryJump:plan=>this.requestStoryJump(plan)},{
          itemSlot:this.app.menuPanels.assets['inventory-slot'],
          itemSelected:this.app.menuPanels.assets['inventory-selected'],
          assets:this.app.menuPanels.assets,
          questRow:this.app.menuPanels.assets['quest-row'],
          questRowSelected:this.app.menuPanels.assets['quest-row-selected'],
          questRowPressed:this.app.menuPanels.assets['quest-row-pressed'],
          questReady:this.app.menuPanels.assets['quest-ready'],
          questMain:this.app.menuPanels.assets['quest-main'],
          moveText:(key,text,y)=>{
            const spec=this.gmTextSpecs.find(value=>value.key===key);
            if(spec){spec.text=text;spec.y=y;}
            this.menuText?.setText('debug',key,text);
            this.menuText?.refresh();
          },
          itemDetail:(itemId,close)=>this.renderGmItemDetail(itemId,close),
          updateItemDetail:(itemId,close)=>{
            if(!this.open||this.page!=='debug'||this.gmPanelOwner!==gm)return;
            this.description?.clear();this.removeDescriptionScrolls();this.gmDetailTextSpecs=[];this.gmDetailOpen=false;
            if(itemId)this.renderGmItemDetail(itemId,close);this.menuText?.renderPage('debug');this.sync();
          },
          registerScroll:(name,scroll)=>this.scrollNames.set(name,scroll),
          removeScroll:scroll=>{for(const [name,value] of this.scrollNames)if(value===scroll)this.scrollNames.delete(name);},
          active:()=>this.open&&this.page==='debug'&&this.gmPanelOwner===gm,
          refresh:()=>this.menuText?.refresh(),
          setText:(key,text)=>{
            const spec=this.gmTextSpecs.find(spec=>spec.key===key);if(spec)spec.text=text;
            this.menuText?.setText('debug',key,text);
          },
        });
        this.gmPanelOwner=gm;
      }
      this.gmTextSpecs=[];this.gmDetailTextSpecs=[];this.gmDetailOpen=false;
      this.gmPanel?.render(this.body!,{add:spec=>this.gmTextSpecs.push(spec)});
    }
    if(this.page==='save'||this.page==='load')this.renderSavePage();
    if(this.page==='settings')this.settingsPage?.render();
    if(this.bagPage?.operationOpen)this.bagPage?.renderOperation();if(this.statusPage?.confirming)this.statusPage?.renderAllocationConfirmation();if(this.skillsPage?.confirming)this.skillsPage?.renderSkillResetConfirmation();
    this.noticeBand=undefined;
    if(this.itemNotice)this.drawItemNotice();
    if(this.page==='save'||this.page==='load')this.renderSaveConfirmations();else this.savePage.renderConfirmations();
    // 页面文字在各自绘制阶段收集完，等弹层位置也确定后再统一交给 DOM 层；原生提示盖在页面之上。
    if(this.bagPage?.operationOpen)this.menuText?.renderPage('operation-notice');
    else if(this.itemNotice)this.menuText?.renderPage('native-notice');
    else if(this.page==='bag'||this.page==='status'||this.page==='party'||this.page==='quests'||this.page==='skills'||this.page==='learn'||this.page==='shop'||this.page==='crafting'||this.page==='forge'||this.page==='debug')this.menuText?.renderPage(this.page);
    if(this.page==='bag')this.bagPage?.markCached();
    this.sync();
  }
  private openControlEditor():void {
    if(!this.scene||!this.content||!this.open)return;
    this.cancelDrag();
    this.controlEditor??=new ControlLayoutEditor(this.scene,this.app.controlLayout,this.app.controlSkin,this.app.menuPanels.assets,()=>this.closeControlEditor(),this.app.domUi);
    this.controlEditor.open(this.app.captureControlPreview?.()??[]);
    this.app.ui.setControlLayoutEditing(true);this.render();
  }
  private closeControlEditor():void {
    this.controlEditor?.close();this.page='settings';this.app.ui.setControlLayoutEditing(false);this.render();
  }
  private openKeyBindingEditor():void {
    if(!this.scene||!this.content||!this.open)return;
    this.cancelDrag();
    this.keyBindingEditor??=new KeyBindingEditor(this.scene,this.app.keyBindings,this.app.menuPanels.assets,()=>this.closeKeyBindingEditor(),this.app.domUi);
    this.keyBindingEditor.open();
    this.app.ui.setKeyBindingEditing(true);this.render();
  }
  private closeKeyBindingEditor():void {
    this.keyBindingEditor?.close();this.page='settings';this.app.ui.setKeyBindingEditing(false);this.render();
  }

  /** 系统页文字：顶部标签行 + 滚动区里的操作按钮。 */
  private renderSystemText(writer:MenuTextWriter):void{
    tabs.forEach(([,label],index)=>writer.add({key:`tab-${index}`,text:label,
      x:35+index*149+51,y:25+85,style:{size:20,color:GOLD,anchorX:.5,anchorY:0}}));
    this.systemPage?.renderText(writer);
    this.renderNoticeText(writer,true);
  }
  /** 存档/读档页的当前文字；确认框打开时只保留确认框那一份。 */
  private renderSaveText(writer:MenuTextWriter):void{
    if(this.savePage.modalOpen){
      const occlude=this.bandSurfaceOcclusion(this.savePage.band)??this.modalSurfaceOcclusion();
      for(const spec of this.saveTextSpecs)writer.add({...spec,dim:true,occlude});
      this.renderNoticeText({add:spec=>writer.add({...spec,dim:true,occlude})},true);
      for(const spec of this.saveModalTextSpecs)writer.add(spec);
      return;
    }
    for(const spec of this.saveTextSpecs)writer.add(spec);
    this.renderNoticeText(writer,true);
  }
  /**
   * 存档/读档页：槽位文字由 `save-board` 写进接收器，页标题仍由 controller 调用
   * `surface.text`，在这里截下来换成 DOM 文字。图框、点击行和滚动仍归 Phaser。
   */
  private renderSavePage():void{
    const surface=this.surface!,specs:MenuTextSpec[]=[];
    this.saveTextSpecs=specs;this.saveModalTextSpecs=[];
    setSaveBoardTextSink(surface,{add:spec=>specs.push(this.saveBoardText(spec))});
    const originalText=surface.text;
    const surfaceText=surface as unknown as {text:UiSurface['text']};
    surfaceText.text=((value:string,x:number,y:number,width=0,size=22,color=GOLD)=>{
      const spec:MenuTextSpec={key:'title',text:value,x,y,style:{size,color,width:width||undefined}};
      specs.push(spec);return this.captureText(spec);
    }) as UiSurface['text'];
    try{ this.savePage.render(surface,this.page==='load'); }
    finally{ surfaceText.text=originalText;setSaveBoardTextSink(surface,undefined); }
    // 确认框打开时，主页面文字让位给确认框那一份，由 `renderSaveConfirmations` 统一渲染。
    if(!this.savePage.modalOpen)this.menuText?.renderPage(this.page);
  }
  /** 存档确认框：横带和按钮留在 Phaser，正文与按钮文字由宿主提供的 writer 收集。 */
  private updateForgeModal():void{
    if(!this.modal||!this.forge||this.page!=='forge')return;
    this.modal.clear();
    for(const [name,scroll] of this.scrollNames)if(scroll.surface===this.modal)this.scrollNames.delete(name);
    this.forge.renderModal(this.modal,this.placeModal);
    this.menuText?.renderPage('forge');
    this.sync();
  }
  private drawItemNotice():void{
    this.beginModal(MENU_CANVAS_WIDTH,MENU_CANVAS_HEIGHT);this.noticeTextSpecs=[];
    const fullPage=this.page==='system'||this.page==='save'||this.page==='load';
    const writer:MenuTextWriter={add:spec=>this.noticeTextSpecs.push(fullPage?this.modalSurfaceTextSpec(spec):this.modalTextSpec(spec))};
    this.noticeBand=drawNativeMessage(this.modal!,this.app.menuPanels.assets,this.itemNotice!,
      ()=>{this.itemNotice=undefined;this.updateItemNotice();},undefined,writer,
      {scroll:(name,x,y,width,height)=>this.scroll(name,x,y,width,height,this.modal!)});
  }
  private updateItemNotice():void{
    if(!this.modal)return;this.modal.clear();
    for(const [name,scroll] of this.scrollNames)if(scroll.surface===this.modal)this.scrollNames.delete(name);
    this.noticeBand=undefined;this.noticeTextSpecs=[];if(this.itemNotice)this.drawItemNotice();
    this.menuText?.renderPage(this.itemNotice?'native-notice':this.page);this.sync();
  }
  private updateDebugPanel():void{
    if(!this.open||this.page!=='debug'||!this.gmPanel||!this.body)return;
    this.description?.clear();this.removeDescriptionScrolls();this.gmDetailOpen=false;this.gmDetailTextSpecs=[];this.gmTextSpecs=[];
    this.gmPanel.update(this.body,{add:spec=>this.gmTextSpecs.push(spec)});
    this.menuText?.renderPage('debug');this.sessionSignature=this.sessionDataSignature()??this.sessionSignature;this.sync();
  }
  private updatePartyModal():void{
    if(!this.modal||!this.partyPanel||this.page!=='party')return;
    this.modal.clear();
    for(const [name,scroll] of this.scrollNames)if(scroll.surface===this.modal)this.scrollNames.delete(name);
    this.partyPanel.renderModal(this.modal);
    this.menuText?.renderPage('party');
    this.sync();
  }
  private updateCraftingModal():void{
    if(!this.modal||!this.craftingPanel||this.page!=='crafting')return;
    this.modal.clear();
    for(const [name,scroll] of this.scrollNames)if(scroll.surface===this.modal)this.scrollNames.delete(name);
    this.craftingPanel.renderModal(this.modal,this.placeModal);
    this.menuText?.renderPage('crafting');
    this.sync();
  }
  private renderSaveConfirmations():void{
    if(!this.savePage.modalOpen){this.savePage.renderConfirmations();return;}
    this.saveModalTextSpecs=[];
    this.savePage.renderConfirmations();
    this.menuText?.renderPage(this.page);
  }
  private saveModalWriter():MenuTextWriter{
    return {add:spec=>this.saveModalTextSpecs.push(this.modalSurfaceTextSpec(spec))};
  }
  /** 弹层本地坐标 → 整页表面坐标；存档页按整块菜单画布排版。 */
  private modalSurfaceTextSpec(spec:MenuTextSpec):MenuTextSpec{
    const modal=this.modal,surface=this.surface;
    if(!modal||!surface)return spec;
    const matrix=surface.root.getWorldTransformMatrix(),origin=matrix.transformPoint(0,0),
      point=(x:number,y:number)=>{const world=modal.root.getWorldTransformMatrix().transformPoint(x,y);
        return{x:(world.x-origin.x)/matrix.scaleX,y:(world.y-origin.y)/matrix.scaleY};},
      start=point(spec.x,spec.y),
      clip=spec.clip?{top:point(0,spec.clip.top).y,bottom:point(0,spec.clip.bottom).y}:undefined;
    return{...spec,x:start.x,y:start.y,clip};
  }
  /** 槽位文字（页面坐标）→ DOM 文字；有换行宽度时按词断行。 */
  private saveBoardText(spec:SaveBoardTextSpec):MenuTextSpec{
    return {key:spec.key,text:spec.text,x:spec.x,y:spec.y,scroll:spec.scroll,clip:spec.clip,
      style:{size:spec.size,color:spec.color,anchorX:spec.anchorX,anchorY:spec.anchorY,
        width:spec.width,wrap:spec.width?'word':undefined}};
  }
  /** 一段只用于收集的文字：controller 的 `setOrigin/Align/Position` 改的是 DOM 规格。 */
  private captureText(spec:MenuTextSpec):UiText{
    const label={
      height:spec.style.size+5,originX:spec.style.anchorX??0,originY:spec.style.anchorY??0,
      setOrigin(anchorX=0,anchorY=0){spec.style.anchorX=anchorX;spec.style.anchorY=anchorY;label.originX=anchorX;label.originY=anchorY;return label;},
      setAlign(align:'left'|'center'|'right'){spec.style.align=align;return label;},
      setPosition(x:number,y:number){spec.x=x;spec.y=y;return label;},
      setVisible(){return label;},
      destroy(){}
    };
    return label as unknown as UiText;
  }


  /** 说明正文的色块统一落成 DOM 规格；技能页和背包说明只是收进不同的数组。 */
  /** 说明正文的断行和行高仍在布局阶段算完；测量用的 Phaser 文字当场销毁，不参与显示。 */
  /** 说明区由技能目录与 AI 设置共享；设置页与原版一样留空。 */

  /** 当前选中成员的快捷栏。默认内容按已学会的主动技能算，主角第一组第六格还带开局的消耗品。 */
  private shortcutBar():ShortcutBar {
    const bag=this.session!.bag;
    return ShortcutBar.for(bag,this.selectedMemberId,this.configuration().activeSkills(this.app.battleCatalog,this.member()!.classId),
      this.selectedMemberId==='player'?bag.catalog.startingShortcut:undefined);
  }
  /** 从技能说明面板或物品详情进这一屏。`id` 是要登记的对象，进来后固定停在第 1 组（原版 `i32Page` 归零）。 */
  private openShortcutScreen(kind:ShortcutEntry['kind'],id:string):void{
    this.cancelDrag();if(this.page==='bag')this.bagPage?.cancel();this.shortcutEditor?.open(kind,id);this.render();
  }
  private closeShortcutScreen():void{this.shortcutEditor?.close();this.backTab?.clear();this.render();}

  /** 另一处「取消快捷键」：把该对象从两组里一次清掉，对应 `PLAYER_RemoveShortcutAll`。 */
  private clearShortcut(kind:ShortcutEntry['kind'],id:string):void{this.shortcutBar().clearObject(kind,id);if(this.page==='skills')this.skillsPage?.refreshSkillAside(false);else this.render();}

  /**
   * 登记快捷键屏左上角的关闭钮。全菜单统一用菜单页右上角那枚圆形关闭图，
   * 这里只是需要更大的命中区，所以画成 67×67；不再用带边框的返回箭头。
   */
  private renderBackButton():void{
    const back=this.backTab,assets=this.app.menuPanels.assets;if(!back)return;
    back.clear();
    back.button('',12,12,67,67,()=>this.goBack(),{image:assets.close,pressed:assets['close-pressed']}).setData('label','返回');
  }
  /** 左上角关闭钮与 Escape 的去向：登记屏退回进来前的页面，其余情况由 `close` 关掉菜单。 */
  private goBack():void{
    if(this.shortcutEditor?.active)this.closeShortcutScreen();
  }

          private removeDescriptionScrolls():void{
    for(const [name,scroll] of this.scrollNames)if(scroll.surface===this.description)this.scrollNames.delete(name);
  }
      /**
   * GM 道具页的详情层：用背包同一套说明面板与正文生成器，画在独立的说明画布（深度 300）上，
   * 因此表现为盖在道具页右侧的弹出层。物品可能还没进背包，所以用一份基础实例预览。
   */
  private renderGmItemDetail(itemId:string,close:()=>void):void{
    const v=this.description!,catalog=this.session!.bag.catalog,item=catalog.items[itemId];
    if(!item)return;
    this.gmDetailOpen=true;
    // 未持有的物品没有掷出的实例数值；用目录默认值与最大孔数预览，避免详情里全是 0。
    const defaults=this.app.characterStats.equipment[itemId];
    const entry:ItemInstance={id:'gm-preview',item:itemId,quantity:1,enhancement:0,gems:[],
      ...(defaults?{numbers:{grade:defaults.defaultGrade??2,gradeName:defaults.gradeName,modifiers:[],gemModifiers:[],
        magicPercent:defaults.magicPercent[0]??0,sockets:item.equipment?.socketCapacity??0,
        enhancementUses:defaults.fixedEnhancementUses??defaults.enhancementUses[0]??0}}:{})};
    // 详情层停在左侧、底边抬到底部按钮之上：右侧数量/发放按钮与底部金币按钮始终可点。
    const panel=descriptionPanel(BAG_DESCRIPTION_WIDTH),left=60,top=panel.y,panelHeight=392;
    // 透明拦截层挡住被盖住的道具格，避免点到看不见的物品；右侧与底部不在它范围内。
    v.rect(left,top,panel.width,panelHeight,0x000000,0).setInteractive();
    drawDescriptionPanel(v,this.app.menuPanels.assets,left,top,panel.width,panelHeight);
    // 每次打开都从正文顶部开始，不沿用上一件物品的滚动位置。
    this.scrollOffsets.delete('debug:item');
    const body=itemDescriptionBody({item,entry,numbers:this.app.characterStats.equipment[entry.item],
      catalog:this.app.characterStats,grades:this.app.shops.grades,member:this.member(),
      classNames:this.classNames(),gemNames:entry.gems.map(id=>catalog.items[id]?.name),skill:entry.skill?catalog.skillDescriptions?.[entry.skill]:undefined});
    // 名字换行时正文区整体下移，底边仍停在原面板内。
    const titleOverflow=descriptionTitleOverflow(v,body.title,panel.width,panel.title.y,panel.scroll.y,panel.scroll.height),
      scrollX=left+panel.scroll.x,scrollY=top+panel.scroll.y+titleOverflow,
      scrollHeight=Math.max(60,panel.scroll.height-titleOverflow),
      clip={top:scrollY,bottom:scrollY+scrollHeight},
      writer={add:(spec:MenuTextSpec)=>this.gmDetailTextSpecs.push(spec)};
    const detail=this.scroll('item',left+panel.scroll.x,scrollY,panel.scroll.width,scrollHeight,v);
    drawDescriptionTitle(body.title,left,top,panel.width,body.color,{writer,keyPrefix:'gm-item-title'});
    const height=drawDescriptionRows(v,body.rows,panel.scroll.width,
      {writer,keyPrefix:'gm-item-row',x:scrollX,y:scrollY,scroll:'item',clip});
    this.finishScroll('item',detail,height);
    drawDescriptionClose(v,this.app.menuPanels.assets,panel,left,top,close);
  }
      private openForge(targetId:string):void {
    const bag=this.session?.bag,target=bag?.get(targetId),equipment=target&&bag?bag.catalog.items[target.item].equipment:undefined;
    if(!bag||!target||!equipment||this.menuBusy)return;
    this.cancelDrag();this.bagPage?.cancel();this.itemNotice=undefined;this.notice='';
    this.bagPage?.prepareChild(targetId);
    const sockets=target.numbers?.sockets??equipment.socketCapacity;
    const tab:ForgeTab=equipment.enchantable?'enchant':sockets>0?'socket':target.numbers?.chaos?'purify':'enchant';
    const member=this.member();
    const preview=(id:string,modifiers:Modifier[])=>member?.previewGemChange(id,modifiers);
    this.forge=new ForgePanel(bag,this.app.menuPanels,this.app.characterStats,
      ()=>this.render(),()=>this.app.audio?.ui('enchant'),(message)=>this.app.ui.showInstant(message),preview,()=>this.updateForgeModal());
    this.forge.open(targetId,tab);this.page='forge';this.render();
  }
  private closeForge():void {
    const targetId=this.forge?.targetId;
    this.forge=undefined;this.page='bag';this.bagPage?.resume(targetId);this.render();
  }
  /** 技能书走独立页：图标网格选技能，右栏看等级变化，确认后才消耗。 */
  private openSkillBook(entry:string):void {
    const bag=this.session?.bag,instance=bag?.get(entry);
    if(!bag||!instance||this.menuBusy)return;
    this.cancelDrag();this.bagPage?.cancel();this.itemNotice=undefined;this.notice='';
    this.skillBook=new SkillBookPanel(bag,this.session!.skills,this.app.battleCatalog,this.app.menuPanels,entry,
      ()=>this.render(),()=>this.app.audio?.ui('select'),(message)=>this.closeSkillBook(message),
      (view,name,x,y,width,height)=>this.scroll(name,x,y,width,height,view),()=>this.menuText?.refresh(),()=>this.menuText?.renderPage('learn'),
      scroll=>{for(const [name,value] of this.scrollNames)if(value===scroll)this.scrollNames.delete(name);},
      this.selectedMemberId==='player'?undefined:this.session!.party?.get(this.selectedMemberId));
    this.skillBook.open();this.page='learn';this.render();
  }
  private closeSkillBook(message?:string):void {
    this.skillBook=undefined;this.page='bag';this.bagPage?.clearSelection();this.notice=message??'';this.render();
  }

  private startDrag(pointer:UiPointer,entry:string,scroll:ScrollArea):void{
    if(this.menuBusy||this.bagPage?.operationOpen||this.itemNotice)return;
    this.itemDrag.start(pointer,{entry,scroll,activate:()=>{
      this.bagPage?.clearSelection();this.bagPage?.clearResult();this.render();
      const instance=this.session?.bag.get(entry);if(!instance)return;
      const item=this.session!.bag.catalog.items[instance.item];
      return new UiImage(this.scene!,undefined,item.icon).setPosition(pointer.x,pointer.y).setDisplaySize(72*this.surface!.root.scaleX,72*this.surface!.root.scaleY).setAlpha(.8).setDepth(800);
    },drop:(entry,pointer)=>this.handleItemDrop(entry,pointer)});
  }
  private moveDrag(pointer:UiPointer):void{this.itemDrag.move(pointer);}
  private endDrag(pointer:UiPointer):void{this.itemDrag.end(pointer);}
  private handleItemDrop(entryId:string,pointer:UiPointer):void{
    const target=this.drops.find(drop=>drop.object.getBounds().contains(pointer.x,pointer.y)&&drop.entry!==entryId&&(drop.slot||drop.craft||this.body!.scrolls.some(scroll=>scroll.contains(pointer))));
    if(!target)return;
    if(target.craft&&this.craftingPanel)this.craftingPanel.select(entryId);
    else if(this.page==='bag')this.bagPage?.handleDrop(entryId,target);
  }
    private cancelDrag():void{this.itemDrag.cancel();}
  private selectMember(id:string,page:Page):void{
    if(this.statusPage?.requestAllocationExit(()=>this.selectMember(id,page)))return;
    if(this.open&&page==='bag'&&this.page==='bag'){
      this.bagPage?.selectMember(id,value=>{this.selectedMemberId=value;});this.bagPage?.rememberSignature(this.sessionDataSignature()??'');return;
    }
    const updateStatus=this.open&&page==='status'&&this.page==='status'&&!!this.statusPage?.mounted;
    const updateSkills=this.open&&page==='skills'&&this.page==='skills'&&!!this.skillsPage?.mounted;
    this.cancelOperation();this.selectedMemberId=id;this.skillsPage?.resetMember();
    if(updateStatus||updateSkills){if(updateStatus)this.statusPage?.updateStatusMember();else this.skillsPage?.updateSkillsMember();this.sessionSignature=this.sessionDataSignature()??this.sessionSignature;}else this.show(page);
    const signal=this.request.signal;
    void this.app.preparePartyMember?.(id,signal).catch(error=>{if(!signal.aborted&&this.open&&this.selectedMemberId===id){this.notice=(error as Error).message;this.menuText?.renderPage(this.page);}});
  }

  private setBackdropHole(rect?:PreviewRect):void{
    const backdrop=this.backdrop;if(!backdrop||!this.scene)return;
    if(!rect){backdrop.setFillStyle(0,.65);for(const piece of this.backdropPieces)piece.setVisible(false);return;}
    if(!this.backdropPieces.length)this.backdropPieces=Array.from({length:4},()=>new UiNode(this.scene!,backdrop).setFillStyle(0,.65));
    backdrop.setFillStyle(0,0);
    const {width,height}=frameRect();
    const left=Math.max(0,Math.min(width,rect.x)),top=Math.max(0,Math.min(height,rect.y));
    const right=Math.max(left,Math.min(width,rect.x+rect.width)),bottom=Math.max(top,Math.min(height,rect.y+rect.height));
    const boxes=[[0,0,width,top],[0,bottom,width,height-bottom],[0,top,left,bottom-top],[right,top,width-right,bottom-top]];
    boxes.forEach(([x,y,w,h],index)=>this.backdropPieces[index]!.setPosition(x,y).setSize(w,h).setVisible(true));
  }
  private renderParty():void{
    this.partyPanel?.render(this.body!,this.modal!,this.placeModal);
  }
  private renderQuests():void{
    this.questPanel?.render(this.body!);
  }
}
