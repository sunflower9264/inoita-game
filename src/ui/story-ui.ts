import { UiNode, UiImage, uiPointer, type UiPointer, type UiText } from './dom/node.ts';
import { UI_EVENTS } from '../application/ui-events.ts';
import { displaySettings } from '../application/display-settings.ts';
import { fullscreenActive, fullscreenStatus, onFullscreenChange, setFullscreen } from '../application/fullscreen.ts';
import { controlSettings, nextControlMode, type ControlMode } from '../application/control-settings.ts';
import {CraftingPanel} from './phaser/crafting-panel.ts';
import {ForgePanel, type ForgeTab} from './phaser/forge-panel.ts';
import {EquipmentCrafting} from '../domain/crafting.ts';
import {skillForGrowth,memberSkillGrowth} from '../domain/battle.ts';
import type Phaser from 'phaser';
import { SHORTCUT_PAGE_COUNT, SHORTCUT_SLOT_COUNT, ShortcutBar, type ShortcutEntry } from '../domain/shortcut-bar.ts';
import { SLOT_ICON_SIZE, ITEM_ICON_SIZE, controlPlacement } from './phaser/action-controls.ts';
import { AttributeAllocation } from '../domain/attribute-allocation.ts';
import { effectiveCharacterPanel, PRIMARY_STATS, type Modifier, type PrimaryStat } from '../domain/character-stats.ts';
import type { BattleStatKey } from '../domain/battle-semantics.ts';
import { memberCombatModifiers } from '../domain/party-combat.ts';
import { memberArt as memberArtwork } from '../domain/menu-panels.ts';
import { characterCombatValues } from './character-values.ts';
import type { StoryUIContext } from '../application/ports.ts';
import type { Session } from '../domain/session.ts';
import type { WorldIndex } from '../domain/content.ts';
import type { StoryInterface } from '../domain/story-interface.ts';
import type { CompanionMember } from '../domain/party.ts';
import type { BattleClass, SkillLoadout } from '../domain/battle.ts';
import type { StorySkillProgression } from '../domain/story-skills.ts';
import { ShopPanel } from './phaser/shop-panel.ts';
import { Storefront } from '../domain/shop.ts';
import { QuestPanel } from './phaser/quest-panel.ts';
import { PartyPanel } from './phaser/party-panel.ts';
import { inventoryView,INVENTORY_LABELS,INVENTORY_SIDE_FILTERS,type InventoryView } from '../domain/inventory.ts';
import { EQUIPMENT_SLOTS,SKILL_POINT_ITEM,USE_LABELS,unimplementedItemUse,type EquipmentSlot,type ItemInstance,type ItemResult } from '../domain/items.ts';
import { GmPanel } from './phaser/gm-panel.ts';
import type { GmActions } from '../debug/gm-actions.ts';
import { frameRect, readSafeArea, uiUnitScale } from './viewport.ts';
import { ControlLayoutEditor } from './phaser/control-layout-editor.ts';
import { KeyBindingEditor } from './phaser/key-binding-editor.ts';
import { CONTROL_SIZES, HUD_SIDE_BUTTON_SIZE, PENDING_OFFSET, resolveControlLayout, type ControlId } from './control-layout.ts';
import { controlViewport } from './phaser/control-layout-viewport.ts';
import { GOLD, UiSurface, type ScrollArea } from './phaser/widgets.ts';
import { MenuTextLayer, type MenuTextOcclude, type MenuTextSpec, type MenuTextWriter } from './dom/menu-text.ts';
import type { DomLabel } from './dom/dom-ui.ts';
import { setSaveBoardTextSink, type SaveBoardTextSpec } from './phaser/save-board.ts';
import { drawDescriptionClose, drawDescriptionPanel, drawDescriptionRows, drawDescriptionSeparator, drawDescriptionTitle } from './phaser/description-panel.ts';
import { drawNativeMessage, NATIVE_MESSAGE_EDGE, type NativeMessageBand } from './phaser/native-message.ts';
import { drawBagRail, drawBagRailSelection } from './phaser/bag-rail.ts';
import type { SaveGame } from '../domain/save-game.ts';
import { SavePage } from './save-page.ts';
import type { SaveWorldReason, StoryWorldViewSnapshot } from '../scenes/world-scene.ts';
import { drawPopupPanel } from './phaser/popup-panel.ts';
import { SkillBookPanel } from './phaser/skill-book-panel.ts';
import { drawRoundBand } from './phaser/round-band.ts';
import { drawSolidBorder } from './phaser/solid-border.ts';
import { MENU_CANVAS_HEIGHT, MENU_CANVAS_WIDTH, MENU_FRAME_MODAL_HEIGHT, MENU_FRAME_MODAL_WIDTH, centerModal } from './phaser/modal-placement.ts';
import { ACTIVE_PARTY_SLOT_COUNT } from '../domain/party-slots.ts';
import { itemResultDetails } from './item-result-details.ts';
import { itemDescriptionBody } from './item-detail-lines.ts';
import { slotFrameImage, updateEquipmentLock } from './slot-frame.ts';
import { bagLayout, BAG_DESCRIPTION_WIDTH, DESCRIPTION_PANEL, descriptionActionLayout, descriptionActionLabelSize, descriptionPanel, SIDE_FILTER_TEXT_SIZE } from './bag-layout.ts';
import { SKILL_PREVIEW_COLORS, skillDescriptionParts, skillLearningParts, skillNextLevelPreview } from './skill-detail-lines.ts';
import { layoutDescriptionText } from './description-text-layout.ts';
import type { DescriptionTextPart } from '../domain/description-text.ts';
import { POPUP_FRAME, tradeLayout } from './shop-layout.ts';
import { TEXT_COLORS } from './text-style.ts';
import { splitMoney } from '../domain/money.ts';
import { LiveCharacterPreview, type PreviewRect } from './phaser/live-character-preview.ts';
import type { CharacterVisual } from '../rendering/characters.ts';
import type { ActorDefinition } from '../domain/content.ts';
import { storyMenuSignature, type StoryMenuPage, type StoryMenuViewModelSource } from './story-ui-signature.ts';

type Page=StoryMenuPage;
const tabs:[Page,string][]=[['status','人物'],['bag','背包'],['skills','技能'],['party','队伍'],['quests','任务'],['system','系统']];
/** 设置页「操作方式」一行上显示的当前选择。 */
const CONTROL_MODE_LABELS:Record<ControlMode,string>={stick:'虚拟摇杆',dpad:'十字按键',keyboard:'电脑模式'};
/** 音量滑条的读数；最左边是静音。 */
const volumeText=(value:number):string=>value<=0?'关闭':`${Math.round(value*100)}%`;
/** 原版菜单里正文与数值的米色：进绘制前调 `GRPX_SetFontColorFromRGB(0xe2,0xcb,0x9e)`。 */
const AREA_TEXT=TEXT_COLORS.primary;
/** 佣兵技能自动使用频率的三个档位，顺序就是存档里的 0/1/2。 */
const AI_FREQUENCY_LABELS=['不使用','一般','高'] as const;
/** 原版按档位索引取 [9,8,7] 三张按钮图，与上面的频率标签一一对应。 */
const AI_FREQUENCY_ASSETS=['skill-level-none','skill-level-normal','skill-level-high'] as const;
/** 登记快捷键那一屏顶部的提示，原版取文本表第 35462 条。 */
const SHORTCUT_PROMPT='请选择要设置的快捷键。';
/** 菜单内容块的固定原点；说明层与内容块共用同一坐标。 */
const CONTENT_ORIGIN={x:32,y:172} as const;
/** 这些使用方式走独立操作面板，不出现在背包的「使用」菜单里。 */
const NON_MENU_USE_KINDS=new Set(['enchant','socket','purify']);
interface Operation {entry:string;kind:'use'|'discard';member?:string;quantity:number;confirmed?:boolean;error?:string}
interface BagMenuAction {label:string;run:()=>void;disabled?:boolean}
/** 背包网格里的一个格子：空格只画底图，物品格还要拿按钮、图标和拖动信息做原位更新。 */
type BagSlotView =
  | {kind:'cell';object:UiImage;view:InventoryView;cell:number;drop:{object:UiNode|UiImage;view:InventoryView;cell:number}}
  | {kind:'item';button:UiNode;icon:UiImage;entryId:string;view:InventoryView;cell:number;
    drop:{object:UiNode|UiImage;entry:string;view:InventoryView;cell:number}};
/** 一次背包绘制读到的格子；和上面的显示对象分开，数据变化时用来做对比。 */
type BagDataSlot =
  | {kind:'cell';view:InventoryView;cell:number}
  | {kind:'item';entry:ItemInstance;view:InventoryView;cell:number};
/** 正式菜单读取 Session，操作仍由背包、技能、队伍和商店领域对象执行。 */
export class StoryUI {
  private readonly app:StoryUIContext;
  /** GM 面板按当前的动作层实例缓存；换会话（动作层重建）时一起换掉。 */
  private gmPanel?:GmPanel;
  private gmPanelOwner?:GmActions;
  private debugCatalogRelease?:()=>void;
  private debugOpenToken=0;
  private debugStoryOnOpen=false;
  private debugStoryMessage='';
  /** 等菜单解锁后再打开调试页的重试定时器；关闭菜单或释放会话时要清掉。 */
  private debugStoryTimer?:ReturnType<typeof setTimeout>;
  private minimapHeight=132;
  private scene?:Phaser.Scene;private surface?:UiSurface;private body?:UiSurface;private hudButtons?:UiSurface;private modal?:UiSurface;private description?:UiSurface;
  /** 菜单页文字走 DOM；图框、按钮、滑条热区和滚动仍由 Phaser 画。 */
  private menuText?:MenuTextLayer;
  /** 人物页与人物加点确认框的文字；确认框打开时只保留后者。 */
  private statusTextSpecs:MenuTextSpec[]=[];
  private statusPortrait?:UiImage;
  private statusAdjustButton?:UiNode;
  private statusRightNodes:UiNode[]=[];
  private statusRightAdjusting=false;
  private statusResources=new Map<string,{fill:UiImage;start:UiImage;end:UiImage}>();
  private statusModalTextSpecs:MenuTextSpec[]=[];
  /** 技能页这一轮绘制收集到的文字；右侧说明区会随滚动一起换位置。 */
  private skillTextSpecs:MenuTextSpec[]=[];
  private skillContentNodes:UiNode[]=[];
  private skillTabs=new Map<string,UiNode>();
  /** 背包页与物品说明这一轮绘制收集到的文字；格子和说明正文都按滚动区跟随。 */
  private bagTextSpecs:MenuTextSpec[]=[];
  /** GM 调试页这一轮绘制收集到的文字。 */
  private gmTextSpecs:MenuTextSpec[]=[];
  /** 存档/读档页上一次绘制收集到的文字；确认框打开时改用它自己的那一份。 */
  private saveTextSpecs:MenuTextSpec[]=[];
  private saveModalTextSpecs:MenuTextSpec[]=[];
  /** 通用原生提示（`drawNativeMessage`）的 DOM 文字；弹层坐标已换成当前页坐标。 */
  private noticeTextSpecs:MenuTextSpec[]=[];
  /** 原生提示横带的弹层本地覆盖范围；用于裁剪和页面文字让位。 */
  private noticeBand?:NativeMessageBand;
  /** 物品使用/丢弃弹层的文字规格；仍是弹层本地坐标，输出时统一换算。 */
  private operationTextSpecs:MenuTextSpec[]=[];
  /** 背包说明层与 GM 物品详情打开时，页面文字让位，只留下说明自身。 */
  private bagDetailTextSpecs:MenuTextSpec[]=[];
  private bagDetailOpen=false;
  private gmDetailTextSpecs:MenuTextSpec[]=[];
  private gmDetailOpen=false;
  /** 弹层/说明下方的黑色遮罩；画在菜单之上、说明层之下。 */
  private popupMask?:UiNode;
  /** 技能初始化确认框的文字规格；仍是弹层本地坐标，输出时统一换算。 */
  private skillResetTextSpecs:MenuTextSpec[]=[];
  /** 登记快捷键那一屏单独一层：它盖在遮罩上，菜单本体整块藏起来。 */
  private shortcutScreen?:UiSurface;
  /** 登记快捷键那一屏的顶部提示；菜单文字层此时整体让位，所以单独挂一个标签。 */
  private shortcutPrompt?:DomLabel;
  private controlEditor?:ControlLayoutEditor;
  private keyBindingEditor?:KeyBindingEditor;
  /** 左上角圆形关闭钮单独一层：不随 960 内容区居中，靠安全区左上角摆放。 */
  private backTab?:UiSurface;
  private shortcutEdit?:{kind:ShortcutEntry['kind'];id:string;page:number};
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
  private itemResult?:ItemResult;
  private filter:InventoryView='all';private selectedItem?:string;private descSide:'left'|'right'='left';private operation?:Operation;private itemNotice?:string;private busy=false;private request=new AbortController();
  /** 上次整页重绘时当前页依赖的数据签名；会话通知用它判断要不要重绘。 */
  private sessionSignature='';
  /** 背包页关掉后仍保留整页 DOM 和立绘，重新打开同一版本数据时只恢复显示。 */
  private bagPageCached=false;
  /** 预热时菜单还没打开，只允许这一次在关闭状态绘制。 */
  private prewarming=false;
  /** 当前弹层的框尺寸，由打开它的对话框声明；初值只是没有对话框时的兜底。 */
  private modalBox={width:tradeLayout.quantity.width,height:tradeLayout.quantity.height};
  private modalActive=false;
  private resizeViewport='';
  private readonly placeModal=(width:number,height:number):void=>this.beginModal(width,height);
  private skill?:string;private skillSection:'directory'|'ai'|'settings'='directory';private skillReset=false;private adjusting=false;
  /** 存档/读档页：确认框、改名输入和读档请求都由它自己持有。 */
  private savePage!:SavePage;
  private allocation?:AttributeAllocation;private allocationExit?:()=>void;private allocationError='';
  /** 能力加点按钮的长按连发；每次重画都会换按钮，所以只记指针和这一步要加的属性。 */
  private allocationHold?:Phaser.Time.TimerEvent;
  private craftingPanel?:CraftingPanel;private craftingActor?:string;private forge?:ForgePanel;private skillBook?:SkillBookPanel;
  private shopPanel?:ShopPanel;private partyPanel?:PartyPanel;private notice='';
  private keyboardFocus?:UiNode;
  /**
   * 背包页那颗合成立绘。它按当前角色和身上装备拼出来，换人、换装备才重做；
   * 翻物品、点格子引起的重画直接搬回来用——每次重建一批精灵正是背包卡顿的一大来源。
   */
  private bagPortrait?:LiveCharacterPreview;
  private backdropPieces:UiNode[]=[];
  private bagPreview?:UiNode;
  private bagSelection?:UiImage;
  private bagEquipment=new Map<EquipmentSlot,{button:UiNode;icon:UiImage;drop:{object:UiNode;entry?:string;slot:EquipmentSlot}}>();
  /** 背包网格的显示对象，按格子/物品身份复用；数据变化时只动变化的格子。 */
  private bagSlots:BagSlotView[]=[];
  private bagGrid?:ScrollArea;
  private bagMemberId='player';
  private bagFilterView:InventoryView='all';
  private bagPartyNodes:UiNode[]=[];
  private bagPartyKey='';
  private scrollOffsets=new Map<string,number>();private scrollNames=new Map<string,ScrollArea>();
  private drag?:{entry:string;pointer:number;x:number;y:number;timer:Phaser.Time.TimerEvent;active:boolean;ghost?:UiImage};private suppressClick=false;
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
      render:()=>this.render(),
      sync:()=>this.sync(),
      busy:()=>this.busy,
      setBusy:value=>{this.busy=value;},
      activeRequest:()=>this.request,
      setItemNotice:message=>{this.itemNotice=message;},
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
    // 登记快捷键那一屏按原版的 960×640 全屏坐标摆控件，深度压在遮罩之上、菜单之下。
    this.shortcutScreen=new UiSurface(scene,960,640,150);this.backTab=new UiSurface(scene,960,640,160);
    // 菜单图片、文字和交互共用 DOM 层。
    // 页面按名字登记文字产出函数，后续迁移新页面只需再 register 一次。
    if(this.app.domUi){
      this.menuText=new MenuTextLayer(this.app.domUi,
        (x,y)=>this.menuTextPoint(x,y),
        (_page,name)=>this.scrollNames.get(name)?.scrollTop);
      this.shortcutPrompt=this.app.domUi.label('screen','dom-shortcut-prompt',{x:.5,y:0}).setVisible(false);
      this.menuText.register('settings',writer=>this.renderSettingsText(writer));
      this.menuText.register('system',writer=>this.renderSystemText(writer));
      this.menuText.register('save',writer=>this.renderSaveText(writer));
      this.menuText.register('load',writer=>this.renderSaveText(writer));
      this.menuText.register('status',writer=>{
        // 加点确认框打开时页面文字压暗，只让出弹层矩形；弹层文字单独输出。
        const page=this.allocationExit?this.dimPage(writer,this.modalOcclusion()):writer;
        this.renderTabsText(page);this.renderStatusText(page);this.renderNoticeText(page);
        if(this.allocationExit)this.renderStatusModalText(writer);
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
        const page=this.skillReset?this.dimPage(writer,this.modalOcclusion()):writer;
        this.renderTabsText(page);
        for(const spec of this.skillTextSpecs)page.add(spec);
        this.renderNoticeText(page);
        if(this.skillReset)for(const spec of this.skillResetTextSpecs)writer.add(this.modalTextSpec(spec));
      });
      this.menuText.register('bag',writer=>this.renderBagText(writer));
      // 技能书页顶部标题画在菜单画布坐标里，换算到内容块坐标后和面板文字一起输出。
      this.menuText.register('learn',writer=>{
        writer.add({key:'learn-title',text:'使用技能书',x:512-CONTENT_ORIGIN.x,y:25-CONTENT_ORIGIN.y,
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
        if(this.page==='bag')this.renderBagText(writer,{dim:true,occlude:this.bandOcclusion(this.noticeBand)});
        else if(this.page==='save'||this.page==='load'){
          for(const spec of this.saveTextSpecs)writer.add({...spec,dim:true,occlude});
          this.renderNoticeText({add:spec=>writer.add({...spec,dim:true,occlude})},true);
        }
        for(const spec of this.noticeTextSpecs)writer.add(spec);
      });
      // 物品使用/丢弃弹层：底下的背包页继续显示，只把被弹层盖住的文字裁掉。
      this.menuText.register('operation-notice',writer=>{
        if(this.page==='bag')this.renderBagText(writer,{dim:true,occlude:this.modalOcclusion(POPUP_FRAME.corner.outer)});
        for(const spec of this.operationTextSpecs)writer.add(this.modalTextSpec(spec));
      });
    }
    this.shortcutScreen.enabled=()=>this.open&&!this.app.ui.suspended&&!this.busy&&!!this.shortcutEdit;
    this.backTab.enabled=()=>this.shortcutScreen!.enabled();
    this.hudButtons=new UiSurface(scene,960,640,50);this.backdrop=new UiNode(scene).setSize(1,1).setFillStyle(0,.65).setDepth(99).setInteractive();
    this.backdropPieces=[];this.bagPortrait=createPreview?new LiveCharacterPreview(scene,rect=>this.setBackdropHole(rect),createPreview):undefined;
    // 说明/弹层用：压暗菜单页和说明层（300），只让弹层（400）保持原色。
    this.popupMask=new UiNode(scene).setSize(1,1).setFillStyle(0,.65).setDepth(399).setVisible(false);
    this.surface.enabled=()=>this.open&&!this.app.ui.suspended&&!this.busy&&!this.app.ui.controlLayoutEditing&&!this.app.ui.keyBindingEditing&&!this.shortcutEdit&&!this.operation&&!this.itemNotice&&!this.allocationExit&&!this.skillReset&&!this.savePage.blocksPage&&!this.craftingPanel?.modalOpen&&!this.shopPanel?.modalOpen&&!this.partyPanel?.modalOpen&&!this.forge?.confirming;
    this.body.enabled=()=>this.surface!.enabled();this.description.enabled=()=>this.body!.enabled();
    this.modal.enabled=()=>this.open&&!this.app.ui.suspended&&!this.busy&&(!!this.operation||!!this.itemNotice||!!this.allocationExit||this.skillReset||this.savePage.modalOpen||!!this.craftingPanel?.modalOpen||!!this.shopPanel?.modalOpen||!!this.partyPanel?.modalOpen||!!this.forge?.confirming);
    this.hudButtons.enabled=()=>this.app.ui.mode==='game'&&this.app.ui.ready&&!this.app.ui.locked&&!this.app.ui.suspended;
    scene.scale.on('resize',this.resize,this);
    // 菜单只注册一个 menu 作用域；打开时独占键盘，关闭时把未消费的按键让给剧情和世界。
    this.unregisterKeyboard?.();this.unregisterKeyboard=this.app.inputRouter.register('menu',this.key,{
      exclusive:()=>!!this.pressurePicker||this.open||this.app.ui.keyBindingEditing||this.app.ui.controlLayoutEditing
    });
    // 浏览器自身的退出（Esc、手势）不会走设置页的按钮，靠事件把开关状态同步回来。
    this.unsubscribeFullscreen?.();
    this.unsubscribeFullscreen=onFullscreenChange(()=>{if(this.open&&this.page==='settings')this.render();});
    const nativeInput=new AbortController();
    window.addEventListener('pointermove',event=>this.moveDrag(uiPointer(scene,event)),{signal:nativeInput.signal,capture:true});
    window.addEventListener('pointerup',event=>{this.stopAllocationHold();this.endDrag(uiPointer(scene,event));},{signal:nativeInput.signal,capture:true});
    window.addEventListener('pointercancel',event=>{uiPointer(scene,event);this.stopAllocationHold();this.cancelDrag();},{signal:nativeInput.signal,capture:true});
    window.addEventListener('blur',()=>{this.stopAllocationHold();this.cancelDrag();},{signal:nativeInput.signal});
    scene.events.once('shutdown',()=>nativeInput.abort());
    scene.game.events.on(UI_EVENTS.minimapLayout,this.onMinimap,this);scene.game.events.on(UI_EVENTS.cancelInput,this.cancelDrag,this);
    scene.events.once('shutdown',()=>{this.closePressurePicker();this.unregisterKeyboard?.();this.unregisterKeyboard=undefined;this.unsubscribe?.();this.unsubscribeFullscreen?.();this.discardAllocation();this.menuText?.destroy();this.menuText=undefined;this.shortcutPrompt?.remove();this.shortcutPrompt=undefined;scene.scale.off('resize',this.resize,this);scene.game.events.off(UI_EVENTS.minimapLayout,this.onMinimap,this);scene.game.events.off(UI_EVENTS.cancelInput,this.cancelDrag,this);this.cancelOperation();this.savePage.destroy();this.surface!.root.remove(this.body!.root);this.surface?.destroy();this.body?.destroy();this.modal?.destroy();this.hudButtons?.destroy();this.description?.destroy();this.shortcutScreen?.destroy();this.backTab?.destroy();this.bagPortrait?.destroy();this.backdrop?.destroy();this.popupMask?.destroy();this.popupMask=undefined;this.controlEditor?.destroy();this.controlEditor=undefined;this.keyBindingEditor?.destroy();this.keyBindingEditor=undefined;});
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
  bind(session:Session,world:WorldIndex,content:StoryInterface):void{
    this.discardAllocation();
    this.loadReturnToDefeat=false;
    this.close();this.discardBagPage();this.hudButtons?.clear();this.unsubscribe?.();this.session=session;this.world=world;this.content=content;this.page='bag';this.selectedMemberId='player';this.filter='all';this.selectedItem=undefined;this.itemResult=undefined;this.scrollOffsets.clear();this.sessionSignature='';
    this.questPanel=new QuestPanel(session,world,this.app.menuPanels,()=>this.render(),
      (view,name,x,y,width,height)=>this.scroll(name,x,y,width,height,view),
      ()=>this.menuText?.refresh(),()=>this.menuText?.renderPage('quests'));
    this.partyPanel?.close();this.partyPanel?.destroyPreview();
    this.partyPanel=new PartyPanel(session,world,this.app,()=>this.render(),(id,page)=>this.selectMember(id,page),
      (view,name,x,y,width,height)=>this.scroll(name,x,y,width,height,view),()=>this.menuText?.refresh(),this.bagPortrait,
      ()=>this.menuText?.renderPage('party'),scroll=>{for(const [name,value] of this.scrollNames)if(value===scroll)this.scrollNames.delete(name);scroll.destroy();const index=this.body!.scrolls.indexOf(scroll);if(index>=0)this.body!.scrolls.splice(index,1);});
    this.unsubscribe=session.subscribe(()=>{
      // 快捷键登记、控制布局编辑与强化台/技能书页打开时由各自的界面显式重绘；
      // 子页面的动作在完成后调 changed 统一重绘一次，避免会话通知再画一遍。
      if(!this.open||this.busy||this.shortcutEdit||this.app.ui.controlLayoutEditing||this.page==='forge'||this.page==='learn')return;
      const signature=this.sessionDataSignature();
      if(signature===undefined||signature!==this.sessionSignature)this.render();
    });this.sync();
  }
  sync():void{
    if(this.app.ui.suspended){this.cancelDrag();this.savePage?.closeInput();}
    this.pressurePicker?.visible(!this.app.ui.suspended);this.pressureBackdrop?.setVisible(!this.app.ui.suspended);
    const active=this.app.ui.mode==='game'&&this.app.ui.ready&&!!this.session;
    if(!active&&this.open&&!(this.busy&&this.app.ui.mode==='game'&&this.session)){this.discardAllocation();this.close();}
    if(this.app.ui.mode!=='game')this.hudButtons?.clear();
    this.hudButtons?.visible(active&&(!this.app.ui.locked||this.app.ui.controlLayoutEditing)&&!this.app.ui.suspended);
    if(active&&this.hudButtons&&this.hudButtons.root.list.every(child=>child===this.hudButtons!.staticRoot)){const v=this.hudButtons;v.button('',0,0,HUD_SIDE_BUTTON_SIZE,HUD_SIDE_BUTTON_SIZE,()=>this.show('save'),{image:this.content!.assets.save}).setData('label','存档');v.button('',0,HUD_SIDE_BUTTON_SIZE+8,HUD_SIDE_BUTTON_SIZE,HUD_SIDE_BUTTON_SIZE,()=>this.show('bag'),{image:this.content!.assets.menu}).setData('label','菜单');if(this.app.pressureMode)v.button('换职',0,0,HUD_SIDE_BUTTON_SIZE,HUD_SIDE_BUTTON_SIZE,()=>this.openPressurePicker(),{fontSize:18}).setData('label','换职业');}
    // 登记快捷键时菜单本体整块让位，只留背后的遮罩与这一屏自己，画面里那层游戏背景就露出来了。
    const menu=this.open&&this.app.ui.ready&&!this.app.ui.suspended&&!this.shortcutEdit&&!this.app.ui.controlLayoutEditing&&!this.app.ui.keyBindingEditing;
    this.surface?.visible(menu);this.body?.visible(menu);this.description?.visible(menu&&!this.forge);
    const modal=menu&&(!!this.operation||!!this.itemNotice||!!this.allocationExit||this.skillReset||this.savePage?.modalOpen||!!this.craftingPanel?.modalOpen||!!this.shopPanel?.modalOpen||!!this.partyPanel?.modalOpen||!!this.forge?.confirming);
    if(modal&&!this.modalActive)this.app.ui.resetInput();
    this.modalActive=modal;this.modal?.visible(modal);
    // DOM 文字盖在画布之上；弹层和菜单隐藏时必须一起让位，否则会浮在弹层上面。
    // 存档确认框、人物加点确认框和队伍弹层的文字也在 DOM 里，它们打开时这一层继续显示，
    // 但页面渲染函数只产出弹层那一份文字。
    const textModal=this.savePage?.modalOpen||(this.page==='status'&&!!this.allocationExit)||(this.page==='party'&&!!this.partyPanel?.modalOpen)
      ||(this.page==='shop'&&!!this.shopPanel?.modalOpen)||(this.page==='crafting'&&!!this.craftingPanel?.modalOpen)
      ||(this.page==='forge'&&!!this.forge?.confirming)||this.skillReset||!!this.itemNotice||!!this.operation;
    this.menuText?.setVisible(menu&&(!modal||!!textModal));
    this.shortcutScreen?.visible(this.open&&!this.app.ui.suspended&&!!this.shortcutEdit);this.backTab?.visible(this.open&&!this.app.ui.suspended&&!!this.shortcutEdit);
    this.shortcutPrompt?.setVisible(this.open&&!this.app.ui.suspended&&!!this.shortcutEdit);
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
    if(page!=='debug'){this.debugOpenToken++;this.debugStoryOnOpen=false;this.debugStoryMessage='';}
    if(page==='debug'&&!this.debugCatalogRelease&&this.app.acquireDebugCatalog){
      const token=++this.debugOpenToken,session=this.session;
      void this.app.acquireDebugCatalog().then(release=>{
        if(token!==this.debugOpenToken||this.session!==session){release();this.app.releaseDebugCatalog?.();return;}
        this.debugCatalogRelease=release;this.show('debug');
        if(this.debugStoryOnOpen){this.debugStoryOnOpen=false;this.gmPanel?.showStoryPage(this.debugStoryMessage);this.debugStoryMessage='';}
      },error=>{if(token===this.debugOpenToken)this.app.ui.toast(`调试数据加载失败：${error instanceof Error?error.message:String(error)}`);});
      return;
    }
    if(this.page!==page&&this.requestAllocationExit(()=>this.show(page)))return;
    if(page==='quests'&&(!this.open||this.page!==page))this.questPanel?.reset();
    const reopening=!this.open;
    if(!this.open){this.open=true;this.app.ui.lock(true,'story-menu');}
    const signature=this.sessionDataSignature();
    const reuseBag=reopening&&page==='bag'&&this.bagPageCached&&signature!==undefined&&signature===this.sessionSignature;
    if(this.page!==page){
      if(this.page==='party')this.app.releasePartyPreview?.();
      if(this.page==='debug')this.releaseDebugPanel();
      this.itemResult=undefined;this.cancelOperation();this.adjusting=false;this.notice='';
    }
    // 背包页的 DOM、静态图框和合成立绘都留着；数据没变时只把整层显示出来。
    this.page=page;
    if(reuseBag){this.sync();return;}
    // render() 末尾已经 sync 过；这里再调一次会把整层再排版一遍。
    this.render();
  }
  /** 进图后先把背包页画好并藏起来；首次打开只恢复显示。 */
  prewarmBag():void{
    if(this.open||!this.session||!this.surface||!this.body)return;
    const signature=this.sessionDataSignature();
    if(this.bagPageCached&&signature!==undefined&&signature===this.sessionSignature)return;
    this.prewarming=true;
    try{this.page='bag';this.renderNow();}catch(error){globalThis.storyDiagnostics?.record('bag-prewarm-error',{error});}finally{this.prewarming=false;}
    const next=this.sessionDataSignature();if(next!==undefined)this.sessionSignature=next;
  }
  /** 调试收尾后回到设置里的调试剧情页，保留面板原来的筛选与选中任务。 */
  openDebugStory():void{
    if(!this.app.gm)return;
    // 收尾可能刚好还在释放导演锁；菜单关着时稍后再试，避免这次回页被 quietly 丢掉。
    if(!this.open&&this.app.ui.locked){
      if(this.debugStoryTimer===undefined)
        this.debugStoryTimer=setTimeout(()=>{this.debugStoryTimer=undefined;this.openDebugStory();},100);
      return;
    }
    this.openDebugStoryWithMessage('');
  }
  private openDebugStoryWithMessage(message:string):void{
    if(this.debugStoryTimer){clearTimeout(this.debugStoryTimer);this.debugStoryTimer=undefined;}
    this.debugStoryOnOpen=true;this.debugStoryMessage=message;this.show('debug');
    if(this.gmPanel){this.debugStoryOnOpen=false;this.gmPanel.showStoryPage(message);this.debugStoryMessage='';}
  }
  openCrafting(actorId:string):void {
    if(!this.session||!this.app.crafting||this.world?.actors[actorId]?.service!=='fusion-machine'||this.app.ui.mode!=='game')return;
    if(this.requestAllocationExit(()=>this.openCrafting(actorId)))return;
    this.close();this.craftingActor=actorId;
    this.craftingPanel=new CraftingPanel(new EquipmentCrafting(this.session,this.app.crafting),this.app.menuPanels,()=>this.render(),()=>this.app.audio?.ui('craft'),this.app.shops.grades);
    this.show('crafting');
  }
  /**
   * 装备表已在内容里时同步打开，保持原有点击链路；生产包第一次开商店才返回 Promise，
   * 调用方可以忽略，也可以等它完成后再读 `shopPanel`。
   */
  openShop(shopId:string,mapId:string):void|Promise<void>{
    if(!this.session||!this.app.shops.shops[shopId]||this.app.ui.mode!=='game')return;
    if(this.requestAllocationExit(()=>{void this.openShop(shopId,mapId);}))return;
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
    this.selectedItem=undefined;this.forge=undefined;
    this.show('bag');this.selectItem(entry,side);
  }
  /** 测试入口：直接打开某件物品的使用弹层。`kind='discard'` 打开丢弃框。 */
  debugUse(entry:string,kind:'use'|'discard'='use'):void{
    if(!this.session?.bag.get(entry))return;
    this.forge=undefined;this.show('bag');this.beginOperation(entry,kind);
  }
  /** 测试入口：打开商店并停在该店的某个交易步骤；`shopId` 必须是 shops.json 里存在的键。 */
  debugShop(shopId:string,step:'browse'|'description'|'quantity'='browse',kind:'buy'|'sell'='buy',mapId=''):void|Promise<void>{
    const opened=this.openShop(shopId,mapId);
    const apply=()=>{if(step!=='browse')this.shopPanel?.debugTrade(step,kind);};
    if(opened)return opened.then(apply);
    apply();
  }
  close():void{
    if(this.open&&this.requestAllocationExit(()=>this.close()))return;
    if(this.debugStoryTimer){clearTimeout(this.debugStoryTimer);this.debugStoryTimer=undefined;}
    this.debugOpenToken++;this.debugStoryOnOpen=false;this.debugStoryMessage='';
    if(!this.open){
      // 关闭态也可能已经创建了商店/合成/强化等子面板（例如 show() 的早退路径），一并丢掉。
      this.shopPanel=undefined;this.craftingPanel=undefined;this.craftingActor=undefined;this.forge=undefined;this.skillBook=undefined;
      this.partyPanel?.destroyPreview();this.app.releasePartyPreview?.();
      return;
    }
    if(this.page==='debug')this.releaseDebugPanel();this.controlEditor?.close();this.app.ui.setControlLayoutEditing(false);
    this.keyBindingEditor?.close();this.app.ui.setKeyBindingEditing(false);this.cancelOperation();this.modalActive=false;this.shortcutEdit=undefined;this.shortcutScreen?.clear();this.backTab?.clear();
    const keepBag=this.page==='bag'&&this.bagPageCached;
    this.shopPanel=undefined;this.partyPanel?.destroyPreview();this.app.releasePartyPreview?.();this.craftingPanel=undefined;this.craftingActor=undefined;this.forge=undefined;this.skillBook=undefined;this.open=false;
    if(keepBag)this.bagPortrait?.visible(false);else this.bagPortrait?.destroy();
    this.scrollNames.forEach((scroll,name)=>this.scrollOffsets.set(`${this.page}:${name}`,scroll.scrollTop));if(!keepBag)this.scrollNames.clear();
    if(!keepBag){
      this.body?.clear();this.description?.clear();
      if(this.surface&&this.body){this.surface.clear(this.body.root);}
    }
    this.bagPageCached=keepBag;this.keyboardFocus=undefined;this.surface?.visible(false);this.body?.visible(false);this.description?.visible(false);this.modal?.visible(false);this.shortcutScreen?.visible(false);this.backTab?.visible(false);this.backdrop?.setVisible(false);this.app.ui.resetInput();this.app.ui.lock(false,'story-menu');
    if(this.loadReturnToDefeat){this.loadReturnToDefeat=false;if(this.app.ui.defeated)this.app.ui.revealDefeat();}
  }
  private releaseDebugPanel():void{
    this.gmPanel?.dispose();this.gmPanel=undefined;this.gmPanelOwner=undefined;
    this.gmTextSpecs=[];this.gmDetailTextSpecs=[];this.gmDetailOpen=false;
    this.menuText?.beginPage('');
    this.debugCatalogRelease?.();this.debugCatalogRelease=undefined;this.app.releaseDebugCatalog?.();
  }
  releaseSession(expected:Session|undefined):void{
    if(this.session!==expected)return;
    this.close();this.discardBagPage();this.releaseDebugPanel();this.unsubscribe?.();this.unsubscribe=undefined;
    this.questPanel=undefined;this.partyPanel?.destroyPreview();this.partyPanel=undefined;
    // 页面节点已经随 close/discardBagPage 销毁，清掉包装引用，别让旧会话的 DOM 留到下一次渲染。
    this.bagSlots=[];this.drops=[];this.bagEquipment.clear();this.bagPreview=undefined;this.bagSelection=undefined;
    this.bagPartyNodes=[];this.bagPartyKey='';
    // 遮罩片挂在常驻 backdrop 下，不随 body 清理；换会话时先销毁再丢引用。
    for(const piece of this.backdropPieces)piece.destroy();
    this.backdropPieces=[];
    this.statusRightNodes=[];this.statusResources.clear();this.skillContentNodes=[];this.skillTabs.clear();
    this.session=undefined;this.world=undefined;this.content=undefined;
  }
  /** 会话结束时丢掉缓存的背包页，避免下一位存档的角色和物品沿用旧页面。 */
  private discardBagPage():void{
    if(!this.bagPageCached)return;
    this.bagPageCached=false;this.scrollNames.clear();this.bagPortrait?.detach();
    this.body?.clear();this.description?.clear();
    if(this.surface&&this.body){this.surface.clear(this.body.root);}
  }
  private cancelOperation():void{this.cancelDrag();this.request.abort();this.request=new AbortController();this.busy=false;this.operation=undefined;this.itemNotice=undefined;this.skillReset=false;this.savePage?.cancelPending();this.partyPanel?.close();this.craftingPanel?.close();this.forge=undefined;this.skillBook=undefined;this.modal?.clear();this.modal?.visible(false);}
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
    // 改名输入框开着时键盘归系统输入法：Enter/Escape 由输入框自己处理。
    if(this.savePage.renaming)return true;
    if(this.app.ui.controlLayoutEditing){if(event.key==='Escape'){event.preventDefault();this.closeControlEditor();}else this.controlEditor?.key(event);return true;}
    if(event.key==='Escape'&&this.itemNotice){event.preventDefault();this.itemNotice=undefined;this.render();return true;}
    if(this.savePage.handleEscape(event))return true;
    if(event.key==='Escape'&&this.allocationExit){event.preventDefault();this.finishAllocation(false);return true;}
    if(event.key==='Escape'){event.preventDefault();if(this.busy){this.close();return true;}if(this.page==='forge'){if(this.forge?.confirming)this.forge.cancelConfirmation();else this.closeForge();return true;}if(this.page==='learn'){this.closeSkillBook();return true;}if(this.shortcutEdit){this.closeShortcutScreen();return true;}if(this.skillReset){this.skillReset=false;this.render();}else if(this.craftingPanel?.modalOpen){this.craftingPanel.cancel();}else if(this.shopPanel?.active){this.shopPanel.cancel();}else if(this.partyPanel?.modalOpen){this.partyPanel.cancel();}else if(this.operation){this.operation=undefined;this.render();}else if(this.page==='bag'&&this.selectedItem){this.selectedItem=undefined;this.render();}else this.close();return true;}
    const surfaces=this.operation||this.itemNotice||this.allocationExit||this.skillReset||this.savePage.modalOpen||this.craftingPanel?.modalOpen||this.shopPanel?.modalOpen||this.partyPanel?.modalOpen||this.forge?.confirming
      ?[this.modal!]:this.shortcutEdit?[this.shortcutScreen!,this.backTab!]:[this.surface!,this.body!,this.description!];
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
    if(this.open&&this.shortcutEdit){this.renderShortcutScreen();this.renderBackButton();}
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
    this.surface?.layout(12);this.positionModal();
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
    if(this.shortcutEdit)this.placeShortcutPrompt();
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
  /** 背包页说明面板盖住的那一栏：左栏或右栏；只让出这一块文字。 */
  private bagDescriptionCovers(spec:MenuTextSpec):boolean {
    const layout=bagLayout(),covered=this.descSide==='left'?layout.leftFrame:layout.bagFrame,
      panel=descriptionPanel(this.descSide==='left'?covered.width:BAG_DESCRIPTION_WIDTH);
    return this.descriptionCovers(spec,{x:covered.x,y:panel.y,width:panel.width,height:panel.height});
  }
  /** 背包页文字：说明面板盖住的那一栏先让位；弹层打开时其余文字压暗，被弹层盖住的部分裁掉。 */
  private renderBagText(writer:MenuTextWriter,options?:{dim?:boolean;occlude?:MenuTextOcclude}):void {
    const page:MenuTextWriter={add:spec=>writer.add(
      options?.dim||options?.occlude?{...spec,dim:options.dim,occlude:options.occlude}:spec)};
    this.renderTabsText(page);
    for(const spec of this.bagTextSpecs)
      if(!this.bagDetailOpen||!this.bagDescriptionCovers(spec))page.add(spec);
    if(this.bagDetailOpen)for(const spec of this.bagDetailTextSpecs)page.add(spec);
    this.renderNoticeText(page);
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
  private modalSurfaceOcclusion(pad=0):MenuTextOcclude|undefined {
    if(!this.modal||!this.surface)return undefined;
    const matrix=this.surface.root.getWorldTransformMatrix(),origin=matrix.transformPoint(0,0),
      point=(x:number,y:number)=>{const world=this.modal!.root.getWorldTransformMatrix().transformPoint(x,y);
        return{x:(world.x-origin.x)/matrix.scaleX,y:(world.y-origin.y)/matrix.scaleY};},
      start=point(-pad,-pad),end=point(this.modalBox.width+pad,this.modalBox.height+pad);
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
  /** 人物页文字；数值颜色和落点沿用 Phaser 版本的语义。 */
  private renderStatusText(writer:MenuTextWriter):void{
    for(const spec of this.statusTextSpecs)writer.add(spec);
  }
  /** 加点确认框文字；坐标先换到内容块，避免 DOM 按弹层本地坐标错位。 */
  private renderStatusModalText(writer:MenuTextWriter):void{
    for(const spec of this.statusModalTextSpecs)writer.add(this.modalTextSpec(spec));
  }
  private addStatusText(key:string,text:string,x:number,y:number,size:number,color=GOLD,anchorX=0,anchorY=0,
    style:Partial<MenuTextSpec['style']>={}):void{
    this.statusTextSpecs.push({key,text,x,y,style:{size,color,anchorX,anchorY,...style}});
  }
  private member(){return this.selectedMemberId==='player'?this.session!.hero:this.session!.party?.get(this.selectedMemberId);}
  private classNames(){return Object.fromEntries(this.app.storyClasses.classes.map(value=>[value.id,value.name]));}
  private actor(){const member=this.member();return this.world!.actors[this.selectedMemberId==='player'?this.session!.campaign.start.actor:(member as CompanionMember).definition.actor];}
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
  private memberArt(){
    const member=this.member()!;
    const source=this.selectedMemberId==='player'?undefined:(member as CompanionMember).source;
    return memberArtwork(this.app.menuPanels,this.actor(),member.classId,source);
  }
  private configuration(){return this.selectedMemberId==='player'?this.session!.skills:(this.member() as CompanionMember).skills;}
  private scroll(name:string,x:number,y:number,w:number,h:number,surface=this.body!,bleed=0,
    bar?:Parameters<UiSurface['scroll']>[5]):ScrollArea{
    const scroll=surface.scroll(x,y,w,h,bleed,bar);this.scrollNames.set(name,scroll);
    // DOM 文字浮在画布上，滚动位置变了必须重新换算坐标。登记放在统一的建区入口，
    // 每个面板都自动跟随，不再依赖某处记得写 `onScroll`。
    scroll.addScrollListener(()=>this.menuText?.refresh());return scroll;
  }
  private finishScroll(name:string,scroll:ScrollArea,height:number):void{scroll.setHeight(height);scroll.scrollTop=this.scrollOffsets.get(`${this.page}:${name}`)??0;}
  /**
   * 会话每次通知都会走到这里；只有当前页真正依赖的数据变化时才整页重绘。
   * 界面操作仍然直接调 `render()`，不经过这道门。
   */
  private render():void{
    // 背包页已经画好时，普通数据变化只更新格子、装备和说明，不再把整页 DOM 拆掉。
    // 物品结果、操作确认这类弹层仍走整页重画，保证弹层和背后的页面一起换。
    if(this.page==='bag'&&this.bagPageCached&&this.bagGrid&&!this.bagOverlayOpen()){
      this.updateBagPage();
      const signature=this.sessionDataSignature();
      if(signature!==undefined)this.sessionSignature=signature;
      return;
    }
    this.renderNow();
    const signature=this.sessionDataSignature();
    if(signature!==undefined)this.sessionSignature=signature;
  }
  private bagOverlayOpen():boolean{
    return !!this.itemResult||!!this.operation||!!this.itemNotice||!!this.allocationExit||!!this.skillReset
      ||!!this.shortcutEdit||this.app.ui.controlLayoutEditing;
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
    this.bagPageCached=false;
    this.bagSlots=[];this.bagGrid=undefined;
    // 换页先收掉上一页的 DOM 文字；当前页由各自的面板在绘制时重新登记。
    this.menuText?.beginPage(this.page);
    this.forge?.captureScroll();this.skillBook?.captureScroll();this.craftingPanel?.captureScroll();this.shopPanel?.captureScroll();this.questPanel?.captureScroll();this.partyPanel?.captureScroll();this.scrollNames.forEach((scroll,name)=>this.scrollOffsets.set(`${this.page}:${name}`,scroll.scrollTop));this.scrollNames.clear();this.surface.clear(this.body.root);this.bagPortrait?.detach();this.partyPanel?.detachPreview();this.body.clear();this.description?.clear();this.modal!.clear();this.drops=[];this.keyboardFocus=undefined;
    if(!this.member()){this.discardAllocation();this.selectedMemberId='player';}const v=this.surface;
    this.body.root.setPosition(CONTENT_ORIGIN.x,CONTENT_ORIGIN.y);
    // 登记快捷键时菜单本体不画：只重画那一屏（它自己在 `sync` 里显示、菜单整块隐藏）。
    if(this.app.ui.controlLayoutEditing){this.surface.clearStatic();this.body.clearStatic();this.sync();return;}
    if(this.shortcutEdit){this.surface.clearStatic();this.body.clearStatic();this.renderShortcutScreen();this.renderBackButton();this.sync();return;}
    // 静态图框只在背包/商店页保留；其它页先把上一页的静态层收掉，避免压在设置或任务列表下面。
    if(this.page!=='bag'&&this.page!=='shop')this.body.clearStatic();
    const chromeKey=`chrome:${this.page}${this.page==='crafting'?`:${this.craftingActor}`:''}`;
    v.staticLayer(chromeKey,()=>{
      if(this.page!=='shop'&&this.page!=='crafting'&&this.page!=='forge'&&this.page!=='learn'&&this.page!=='save'&&this.page!=='load'){
        // 页签只留底图和命中区，文字统一由当前页的 DOM 渲染器输出。
        tabs.forEach(([page,label],index)=>{const button=v.button('',35+index*149,25,102,116,()=>this.show(page),{bare:true,parent:v.staticRoot}).setData('label',label);v.image(this.content!.assets[`tab-${page}`],12,0,78,78,button);button.setAlpha(this.page===page||(['settings','debug'] as Page[]).includes(this.page)&&page==='system'?1:.65);});
      }
      // 融合器与强化台的顶部标题由 DOM 输出，静态层只留关闭钮。
      // 技能书页标题同样由 DOM 输出。
      v.button('',947,24,51,51,()=>this.page==='forge'?this.closeForge():this.page==='learn'?this.closeSkillBook():this.close(),{image:this.content!.assets.close,pressed:this.content!.assets['close-pressed'],parent:v.staticRoot}).setData('label',this.page==='forge'?'关闭强化':this.page==='learn'?'关闭技能书':'关闭菜单');
    });
    const textScroll=(name:string,x:number,y:number,width:number,height:number,surface?:UiSurface)=>this.scroll(name,x,y,width,height,surface??this.body!);
    const refreshText=()=>this.menuText?.refresh();
    if(this.page==='bag')this.renderBag();if(this.page==='status')this.renderStatus();if(this.page==='skills')this.renderSkills();if(this.page==='party')this.renderParty();if(this.page==='quests')this.renderQuests();
    if(this.page==='shop')this.shopPanel?.render(this.body,this.modal!,this.placeModal,this.description!,{scroll:textScroll,refresh:refreshText,
      setText:(key,text)=>this.menuText?.setText('shop',key,text)});
    if(this.page==='crafting'&&this.craftingPanel){this.craftingPanel.render(this.body,this.modal!,this.placeModal,(pointer,entry,scroll)=>this.startDrag(pointer,entry,scroll),{scroll:textScroll,refresh:refreshText});this.drops=this.craftingPanel.drops;}
    if(this.page==='forge'&&this.forge)this.forge.render(this.body,this.modal!,this.placeModal,{scroll:textScroll,refresh:refreshText});
    if(this.page==='learn'&&this.skillBook)this.skillBook.render(this.body!);
    if(this.page==='system'){
      const actions:[string,()=>void][]=[['保存游戏',()=>this.show('save')],['读取存档',()=>this.show('load')],['设置',()=>this.show('settings')],['脱离卡死',()=>{
        const result=this.app.rescuePlayer?.();
        if(!result)this.app.ui.showInstant('当前不在游戏中');
        else if(!result.ok)this.app.ui.showInstant(`脱离卡死失败：${result.reason??'未知原因'}`);
        else if(!result.moved)this.app.ui.showInstant('当前位置正常，不需要脱离卡死');
        else this.app.ui.showInstant('已脱离卡死');
      }]];
      // 「调试」只在 GM 打开时出现；关闭时这一项根本不存在，不需要靠权限判断挡住。
      if(this.app.gm)actions.push(['调试',()=>this.show('debug')]);
      actions.push(['返回主菜单',()=>{this.close();this.app.returnToMenu?.();}]);
      // 动作数量会随 GM 开关变化，放进滚动区，不再压缩按钮间距。
      const scroll=this.scroll('system',0,0,960,431),content=scroll.content,gap=80;
      // 按钮只留底图与命中区；文字统一由 DOM 层按 action 顺序生成。
      actions.forEach(([label,action],index)=>this.body!.button('',320,70+index*gap,300,66,action,{parent:content}).setData('label',label));
      this.finishScroll('system',scroll,70+(actions.length-1)*gap+66+20);
      this.menuText?.renderPage('system');
    }
    if(this.page==='debug'&&this.app.gm){
      // 面板按当前动作层实例缓存：同一会话里保留过滤与选中，换会话就重建。
      if(this.gmPanelOwner!==this.app.gm){
        const gm=this.app.gm;
        const mapNames=new Map((this.world?.maps??[]).map(map=>[map.id,map.name]));
        this.gmPanel=new GmPanel(gm,this.session.campaign,{close:()=>this.close(),render:()=>{if(this.app.gm===gm&&this.gmPanelOwner===gm)this.render();},reopen:message=>{if(this.app.gm===gm)this.openDebugStoryWithMessage(message);}},{
          mapName:id=>mapNames.get(id),
          actorName:id=>this.world?.actors[id]?.name,
          questGroup:id=>this.session?.campaign.questGroups.find(group=>group.questIds.includes(id))?.title,
          questProgress:id=>{
            const definition=this.session?.definition(id),state=this.session?.quests.get(id);
            if(!definition||!state)return undefined;
            const total=definition.goals.reduce((sum,goal)=>sum+goal.quantity,0);
            const done=definition.goals.reduce((sum,goal)=>sum+Math.min(goal.quantity,state.goals[goal.id]??0),0);
            return {status:state.status,done,total};
          },
          itemSlot:this.app.menuPanels.assets['inventory-slot'],
          itemSelected:this.app.menuPanels.assets['inventory-selected'],
          itemDetail:(itemId,close)=>this.renderGmItemDetail(itemId,close),
          registerScroll:(name,scroll)=>this.scrollNames.set(name,scroll),
          refresh:()=>this.menuText?.refresh(),
        });
        this.gmPanelOwner=gm;
      }
      this.gmTextSpecs=[];this.gmDetailTextSpecs=[];this.gmDetailOpen=false;
      this.gmPanel?.render(this.body!,{add:spec=>this.gmTextSpecs.push(spec)});
    }
    if(this.page==='save'||this.page==='load')this.renderSavePage();
    if(this.page==='settings')this.renderSettings();
    if(this.operation)this.renderOperation();if(this.allocationExit)this.renderAllocationConfirmation();if(this.skillReset)this.renderSkillResetConfirmation();
    this.noticeBand=undefined;
    if(this.itemNotice){
      this.beginModal(MENU_CANVAS_WIDTH,MENU_CANVAS_HEIGHT);this.noticeTextSpecs=[];
      // 系统页与存档页按整块菜单画布排版，换算到整页表面；其余页换算到内容块坐标。
      const fullPage=this.page==='system'||this.page==='save'||this.page==='load';
      const writer:MenuTextWriter={add:spec=>this.noticeTextSpecs.push(fullPage?this.modalSurfaceTextSpec(spec):this.modalTextSpec(spec))};
      this.noticeBand=drawNativeMessage(this.modal!,this.app.menuPanels.assets,this.itemNotice,
        ()=>{this.itemNotice=undefined;this.render();},undefined,writer,
        {scroll:(name,x,y,width,height)=>this.scroll(name,x,y,width,height,this.modal!)});
    }
    if(this.page==='save'||this.page==='load')this.renderSaveConfirmations();else this.savePage.renderConfirmations();
    // 页面文字在各自绘制阶段收集完，等弹层位置也确定后再统一交给 DOM 层；原生提示盖在页面之上。
    if(this.operation)this.menuText?.renderPage('operation-notice');
    else if(this.itemNotice)this.menuText?.renderPage('native-notice');
    else if(this.page==='bag'||this.page==='status'||this.page==='party'||this.page==='quests'||this.page==='skills'||this.page==='learn'||this.page==='shop'||this.page==='crafting'||this.page==='forge'||this.page==='debug')this.menuText?.renderPage(this.page);
    this.bagPageCached=this.page==='bag';
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
  /**
   * 设置页：声音、画面偏好与操作设置各占一行，行距 90。
   *
   * 条目挂在 `scroll.content` 上，`widgets` 的 `scrollClickAllowed` 负责拦住拖动后的
   * 抬手；行数变化时只调整末尾传给 `finishScroll` 的内容高度，不用重排其他页面。
   */
  private renderSettings():void{
    const v=this.body!,audio=this.app.audio;
    const scroll=this.scroll('settings',0,0,960,431),content=scroll.content;
    if(audio)for(const [index,[channel]]of [['music'],['effects']].entries()){
      const key=channel as 'music'|'effects',top=80+index*90;
      // 最左边是静音；轨道一直伸到右侧面板边缘，百分比放在轨道右端。
      // 数值文字走 DOM，拖动时直接改那一枚标签，不触发整页重绘。
      const slider=v.slider(key,485,top+33,400,audio.settings[key],value=>{
        audio.setVolume(key,value);
        this.menuText?.setText('settings',`${key}-value`,volumeText(value));
      },content);
      // 滑条自己的 Phaser 数值文字不再显示，只留轨道、滑块和热区。
      this.hideSliderValueText(slider);
    }
    // 帧率显示和音量一样是画面/声音偏好，放在同一个面板里；默认开启。
    const fps=displaySettings.fps;
    v.button('',485,260,220,66,()=>{displaySettings.setFps(!fps);this.render();},{parent:content})
      .setData('label',fps?'开启':'关闭');
    const frameRateLimit=displaySettings.frameRateLimit;
    for(const [index,limit] of ([30,60] as const).entries()){
      v.button('',485+index*230,350,220,66,()=>{
        displaySettings.setFrameRateLimit(limit);
        this.render();
      },{parent:content,selected:frameRateLimit===limit}).setData('label',`${limit} 帧`);
    }
    // 画面精度：实际倍率不会超过本机 DPR；默认 1×，高分屏可手动开 2×/3×。
    const renderScale=displaySettings.renderScale;
    for(const scale of ([1,2,3] as const)){
      v.button('',485+(scale-1)*140,440,120,66,()=>{
        displaySettings.setRenderScale(scale);
        this.render();
      },{parent:content,selected:renderScale===scale}).setData('label',`${scale}×`);
    }
    // 纹理批次：自动时安卓单纹理，iOS 和桌面多纹理；单纹理更保守。
    const batching=displaySettings.textureBatching;
    const batchingLabel={auto:'自动',multi:'多纹理',single:'单纹理'}[batching];
    v.button('',485,530,260,66,()=>{
      displaySettings.setTextureBatching(batching==='auto'?'multi':batching==='multi'?'single':'auto');
      this.render();
    },{parent:content}).setData('label',`纹理批次：${batchingLabel}`);
    // 暴击光环和爆闪只影响画面，默认开启；不影响暴击冲击、数字、震屏或音效。
    const decorations=displaySettings.criticalDecorations;
    v.button('',485,620,220,66,()=>{
      displaySettings.setCriticalDecorations(!decorations);
      this.render();
    },{parent:content}).setData('label',decorations?'开启':'关闭');
    // 全屏是浏览器能力；不支持的环境显示为不可用，APK 壳已经隐藏系统栏，显示为已全屏。
    let rowTop=710;
    const fullscreen=fullscreenStatus();
    if(fullscreen==='available'){
      const active=fullscreenActive();
      v.button('',485,rowTop,220,66,()=>setFullscreen(!active),{parent:content})
        .setData('label','全屏：' + (active?'开启':'关闭'));
    }else{
      const label=fullscreen==='packaged'?'已全屏':'不支持';
      v.button('',485,rowTop,220,66,()=>{},{parent:content,disabled:true})
        .setData('label','全屏：'+label);
    }
    // 操作方式在本行点击轮换；触屏模式拖动控件位置，电脑模式改成键位映射。
    rowTop+=90;
    const modeLabel=CONTROL_MODE_LABELS[controlSettings.mode];
    v.button('',485,rowTop,220,66,()=>{
      controlSettings.setMode(nextControlMode(controlSettings.mode));
      this.render();
    },{parent:content}).setData('label',`操作方式：${modeLabel}`);
    rowTop+=90;
    if(controlSettings.mode==='keyboard'){
      v.button('',485,rowTop,220,66,()=>this.openKeyBindingEditor(),{parent:content}).setData('label','修改键位');
    }else{
      v.button('',485,rowTop,220,66,()=>this.openControlEditor(),{parent:content}).setData('label','拖动调整');
    }
    this.finishScroll('settings',scroll,rowTop+80);
    // 滚动时 DOM 文字跟着内容移动，并裁掉视口外的行。
    this.menuText?.renderPage('settings');
  }
  /** 设置页的文字全部由 DOM 渲染；页面重绘时按 key 复用标签。 */
  private renderSettingsText(writer:MenuTextWriter):void{
    this.renderTabsText(writer);
    const audio=this.app.audio;
    const add=(key:string,value:string,x:number,y:number,size:number,anchorX=0,anchorY=0):void=>
      writer.add({key,text:value,x,y,style:{size,color:GOLD,anchorX,anchorY},scroll:'settings',clip:{top:0,bottom:431}});
    add('title','环境设置',473,15,29,.5,0);
    if(audio)for(const [index,[channel,label]]of [['music','音乐'],['effects','音效']].entries()){
      const key=channel as 'music'|'effects',top=80+index*90;
      add(`${key}-label`,label,260,top+15,25);
      add(`${key}-value`,volumeText(audio.settings[key]),903,top+33,18,0,.5);
    }
    add('fps-label','帧率显示',260,275,25);
    add('fps-toggle',displaySettings.fps?'开启':'关闭',595,293,22,.5,.5);
    add('frame-rate-label','帧率上限',260,365,25);
    add('frame-rate-30','30 帧',595,383,22,.5,.5);
    add('frame-rate-60','60 帧',825,383,22,.5,.5);
    add('render-scale-label','画面精度',260,455,25);
    for(const scale of ([1,2,3] as const))add(`render-scale-${scale}`,`${scale}×`,545+(scale-1)*140,473,22,.5,.5);
    add('render-scale-hint','数字越大越清晰，最高到屏幕',260,490,16);
    const batchingLabel={auto:'自动',multi:'多纹理',single:'单纹理'}[displaySettings.textureBatching];
    add('texture-batching-label','纹理批次',260,545,25);
    add('texture-batching-toggle',batchingLabel,615,563,22,.5,.5);
    add('critical-label','暴击光效',260,635,25);
    add('critical-toggle',displaySettings.criticalDecorations?'开启':'关闭',595,653,22,.5,.5);
    let rowTop=710;
    add('fullscreen-label','全屏',260,rowTop+15,25);
    const fullscreen=fullscreenStatus();
    add('fullscreen-toggle',fullscreen==='available'?(fullscreenActive()?'开启':'关闭'):(fullscreen==='packaged'?'已全屏':'不支持'),
      595,rowTop+33,22,.5,.5);
    rowTop+=90;
    add('control-mode-label','操作方式',260,rowTop+15,25);
    add('control-mode-toggle',CONTROL_MODE_LABELS[controlSettings.mode],595,rowTop+33,22,.5,.5);
    rowTop+=90;
    const keyboard=controlSettings.mode==='keyboard';
    add('control-action-label',keyboard?'键位设置':'控件位置',260,rowTop+15,25);
    add('control-action-toggle',keyboard?'修改键位':'拖动调整',595,rowTop+33,22,.5,.5);
    this.renderNoticeText(writer);
  }
  /** 滑条的数值文字已交给 DOM；隐藏 VolumeSlider 自己那枚 Phaser Text。 */
  private hideSliderValueText(slider:{root:UiNode}):void{
    for(const child of slider.root.list){
      if((child as {type?:string}).type==='Text')(child as unknown as {setVisible(value:boolean):void}).setVisible(false);
    }
  }
  /** 系统页文字：顶部标签行 + 滚动区里的操作按钮。 */
  private renderSystemText(writer:MenuTextWriter):void{
    tabs.forEach(([,label],index)=>writer.add({key:`system-tab-${index}`,text:label,
      x:35+index*149+51,y:25+85,style:{size:20,color:GOLD,anchorX:.5,anchorY:0}}));
    const labels=['保存游戏','读取存档','设置','脱离卡死',...(this.app.gm?['调试']:[]),'返回主菜单'];
    labels.forEach((label,index)=>writer.add({key:`system-action-${index}`,text:label,
      x:CONTENT_ORIGIN.x+470,y:CONTENT_ORIGIN.y+70+index*80+33,style:{size:22,color:GOLD,anchorX:.5,anchorY:.5},
      scroll:'system',clip:{top:CONTENT_ORIGIN.y,bottom:CONTENT_ORIGIN.y+431}}));
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
      style:{size:spec.size,color:spec.color,anchorX:spec.anchorX,anchorY:spec.anchorY,align:spec.align,
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
  /** 摘要与快照的唯一捕获口：手动保存与自动存档共用。 */
  captureSaveRecord(screenshot?:string):{ok:true;record:SaveGame<StoryWorldViewSnapshot>}|{ok:false;reason:SaveWorldReason}{
    return this.savePage.captureSaveRecord(screenshot);
  }
  private renderStatus():void{
    this.statusTextSpecs=[];this.statusResources.clear();
    const v=this.body!,member=this.member()!,actor=this.actor(),panels=this.app.menuPanels,character=this.app.storyClasses.classes.find(value=>value.id===member.classId)!,art=this.memberArt();
    // 左框只有图框（`UI_DrawBorderRect`），四角 41×41 画在框外 2 像素处：`Scene_Draw_POPUP_SC_CHARACTER_INFO
    // @0x1e6b78` 把组 15 索引 48／49／53／54 画在 (83,−2)、(455,−2)、(83,392)、(455,392)，立绘在 (95,10)。
    v.border(panels.assets,85,0,409,431);
    for(const [corner,x,y]of [['nw',83,-2],['ne',455,-2],['sw',83,392],['se',455,392]] as const)v.image(panels.assets[`character-${corner}`],x,y,41,41);
    this.statusPortrait=v.imageCover(art.image,95,10,252,271);
    // 队员栏：原版这个 104×340 的栏里放三个 104×113 的成员按钮（`Scene_Init_POPUP_SC_CHARACTER_INFO
    // @0x1e5478` 里 `SetRect(?, 0/0x71/0xe2, 104, 113)`），每个画成员头像 86×96 落在框内 +(9,9)，
    // 所以第一格的头像就在 (17,58)；点哪一格就切到那位成员身上。
    this.drawPartyColumn(v);
    // 等级、职业、姓名三行都在 x=458 右对齐（`+0x1ca`），全部按上沿对齐：
    // 等级 `+0x5f`(95)、职业 `+0x78`(120)、姓名再让出字距落在 152。
    // 姓名不再以 150 为中线，否则更大的字号会压到职业行上。三行都是原版的米色 #e2cb9e。
    this.addStatusText('level',`等级 ${member.level}`,458,95,20,AREA_TEXT,1,0,{width:200,align:'right'});
    this.addStatusText('class',character.name,458,120,20,AREA_TEXT,1,0,{width:200,align:'right'});
    this.addStatusText('name',actor.name,458,152,26,AREA_TEXT,1,0,{width:200,align:'right'});
    (['health','mana','experience'] as const).forEach((kind,index)=>{const player=member.player,value=player[kind],max=kind==='experience'?player.nextLevelExperience:kind==='health'?player.maxHealth:player.maxMana,y=290+index*44,ratio=kind==='experience'&&max===0?1:max>0?Math.max(0,Math.min(1,value/max)):0;
      v.image(panels.assets['character-gauge'],168,y,243,37);
      this.addStatusText(`resource-${kind}-label`,panels.character.labels[kind],118,y+18.5,19,GOLD,0,.5,{width:46,align:'right'});
      this.addStatusText(`resource-${kind}-value`,max===0?'已满级':`${value} / ${max}`,290,y+18.5,17,GOLD,.5,.5,{contrastBackground:true});
      this.addStatusText(`resource-${kind}-percent`,`${Math.floor(ratio*100)}%`,455,y+18.5,17,GOLD,1,.5);
      const width=223*ratio,fill=v.image(panels.assets[`character-${kind}-fill`],178,y+12,223,13);fill.setCrop(0,0,fill.width*ratio,fill.height).setVisible(width>0);const start=v.image(panels.assets[`character-${kind}-start`],178,y+12,7,13).setVisible(width>0),end=v.image(panels.assets[`character-${kind}-end`],178+Math.max(0,width-7),y+12,7,13).setVisible(width>0);this.statusResources.set(kind,{fill,start,end});
    });
    this.renderStatusRight();
  }
  private renderStatusRight():void{
    const v=this.body!,member=this.member()!,panels=this.app.menuPanels,character=this.app.storyClasses.classes.find(value=>value.id===member.classId)!;
    const hero='source' in member&&member.source!=='mercenary'?undefined:member,statPoints=this.allocation?.remainingPoints??hero?.statPoints??0,attributes=this.allocation?.attributes??member.panel.attributes;
    const before=new Set(v.root.list);
    // 右侧两块同样只有图框：原版 `Scene_Draw_...` 只对它们调 `UI_DrawBorderRect`，
    // 加点时属性栏宽 409（画到 x=905），常态宽 224，战斗指标栏固定在 `+0xe2`(226) 处、224 宽。
    // 两种视图都由 53 高的标题和 y=49 起的内容框相接，宽度分别为 224、409。
    const attributeWidth=this.adjusting?409:224;
    drawSolidBorder(v,panels.assets,496,0,attributeWidth,53);
    v.border(panels.assets,496,49,attributeWidth,382);
    // 加点视图那五行按原版排：行距 64（`Scene_Draw_... 0x1e761c` 的 `x21 += 0x40`），
    // 每行一条 (519, 行顶+75, 364, 48) 的压暗圆角带（强度 50），名字从 (531, 行顶+85) 起、
    // 数值右对齐于 751、行顶 +84；加减按钮是两个 51×58 的列，减在 630、加在 822（`Scene_Init`
    // 里两组 `UI_CreateGroupBaseControl(134/326, 70, 51, 314)`，按钮按 64 行距排）。
    // 加点视图每行右侧那串橙色「+N」是这项能力累计投入的点数：已确认的分配加上本轮
    // 还没确认的增量。没有投入时不画。
    const allocated=hero?.allocated;
    character.attributes.forEach((attribute,index)=>{
      const stat=PRIMARY_STATS[index],adjusting=this.adjusting;
      // 两档的行距与落点不同：加点视图 64 行距、名字 531、数值右对齐 751、圆角带 364 宽；
      // 总览视图 69 行距、名字 525、数值右对齐 684、圆角带 (513, 行顶+75, 190, 48)。
      if(adjusting)drawRoundBand(v,panels.assets,519,index*64+75,364,48,50);
      else drawRoundBand(v,panels.assets,513,index*69+75,190,48,50);
      const nameX=adjusting?531:525,nameY=adjusting?index*64+85:index*69+85;
      this.addStatusText(`attribute-${stat}-name`,attribute.name,nameX,nameY,23);
      this.addStatusText(`attribute-${stat}-value`,String(attributes[stat]),adjusting?751:684,adjusting?index*64+84:index*69+84,23,GOLD,1,0);
      const added=(allocated?.[stat]??0)+(this.allocation?.pending[stat]??0);
      if(adjusting&&added>=1)this.addStatusText(`attribute-${stat}-added`,`+${added}`,781,index*64+84,23,'#e1823b');
      if(adjusting&&this.allocation){
        // 原版减点使用左箭头，增点翻转同图；按下叠加对应亮图，透明处露出属性行底带。
        for(const [delta,x,label,disabled] of [[-1,630,'减少',this.allocation.pending[stat]===0],[1,822,'增加',statPoints<1]] as const){
          const button=v.button('',x,index*64+70,51,58,()=>this.action(()=>this.allocation!.change(stat,delta)),{
            image:panels.assets['character-step'],pressed:panels.assets['character-step-pressed'],native:true,disabled,
          }).setData('label',`${label}${attribute.name}`);
          button.on('pointerdown',(pointer:UiPointer)=>this.startAllocationHold(pointer,stat,delta));
          if(delta===1)for(const part of ['face','highlight']) (button.getData(part) as UiImage).setFlipX(true);
        }
      }
    });
    this.statusAdjustButton=v.button('',this.adjusting?846:661,0,67,67,()=>this.toggleAllocation(),{image:panels.assets[this.adjusting?'confirm':'character-adjust'],disabled:!hero}).setData('label',this.adjusting?'确认属性加点':'查看属性加点');
    if(!this.adjusting){
      const values=this.statusCombatValues(member);
      v.border(panels.assets,722,0,224,431);
      panels.character.combatLabels.forEach((label,index)=>{
        this.addStatusText(`combat-${index}-label`,label,738,24+index*35,19,GOLD,0,0,{width:110,align:'left'});
        this.addStatusText(`combat-${index}-value`,values[index],928,24+index*35,19,GOLD,1,0);
      });
    }else{
      v.button('',571,376,257,48,()=>this.action(()=>this.resetAttributes())).setData('label','能力初始化');
      this.addStatusText('reset-attributes','能力初始化',571+257/2,376+48/2,Math.min(22,48*.42),GOLD,.5,.5);
    }
    this.addStatusText('stat-points',`${panels.character.labels.statPoints} ${statPoints}`,this.adjusting?534:522,14,20,AREA_TEXT);
    this.statusRightNodes=v.root.list.filter(node=>!before.has(node));this.statusRightAdjusting=this.adjusting;
  }
  private toggleAllocation():void{
    if(this.adjusting){if(this.requestAllocationExit(()=>this.render()))return;}
    else{const hero=this.member();if(!hero||('source' in hero&&hero.source!=='mercenary'))return;this.allocation=new AttributeAllocation(hero);this.adjusting=true;}
    this.render();
  }
  /** 能力初始化免费返还全部已分配点数；本轮还没确认的增量也一起作废。 */
  private resetAttributes():void{
    const hero=this.member();
    if(!hero||('source' in hero&&hero.source!=='mercenary'))return;
    hero.resetAttributes();
    this.allocation=new AttributeAllocation(hero);
    this.allocationError='';
  }
  private discardAllocation():void{
    this.stopAllocationHold();
    this.allocation?.cancel();this.allocation=undefined;this.allocationExit=undefined;this.allocationError='';this.adjusting=false;
  }
  /** 长按加点：按住 400ms 后开始，每 90ms 加／减一点；松开或到达上下限就停。 */
  private startAllocationHold(pointer:UiPointer,stat:PrimaryStat,delta:1|-1):void{
    this.stopAllocationHold();
    this.allocationHold=this.scene!.time.delayedCall(400,()=>this.stepAllocationHold(pointer,stat,delta));
  }
  private stepAllocationHold(pointer:UiPointer,stat:PrimaryStat,delta:1|-1):void{
    const allocation=this.allocation;
    // 每一步都会重画并换掉按钮，所以继续的条件只看指针、分配视图和余额，不看按下时的那个按钮。
    if(!pointer.isDown||!this.adjusting||!allocation||!this.surface?.root.visible
      ||(delta===1?allocation.remainingPoints<1:allocation.pending[stat]===0)){this.stopAllocationHold();return;}
    this.action(()=>this.allocation!.change(stat,delta));
    this.allocationHold=this.scene!.time.delayedCall(90,()=>this.stepAllocationHold(pointer,stat,delta));
  }
  private stopAllocationHold():void{this.allocationHold?.remove();this.allocationHold=undefined;}
  private requestAllocationExit(next:()=>void):boolean{
    if(this.allocationExit)return true;
    if(!this.allocation?.hasChanges){this.discardAllocation();return false;}
    this.allocationExit=next;this.keyboardFocus=undefined;
    if(this.page==='status'&&this.modal){this.modal.clear();this.renderAllocationConfirmation();this.menuText?.renderPage('status');this.sync();}
    else this.render();
    return true;
  }
  private finishAllocation(commit:boolean):void{
    const next=this.allocationExit;if(!next||this.busy)return;
    this.busy=true;
    try{if(commit)this.allocation!.commit();this.discardAllocation();}
    catch(error){this.allocationError=(error as Error).message;}
    finally{this.busy=false;}
    if(this.allocationExit){this.render();return;}
    this.keyboardFocus=undefined;next();
  }
  private renderAllocationConfirmation():void{
    const v=this.modal!,character=this.app.storyClasses.classes.find(value=>value.id===this.member()!.classId)!,pending=this.allocation!.pending;
    this.statusModalTextSpecs=[];
    const add=(key:string,text:string,x:number,y:number,size:number,width:number):void=>{
      this.statusModalTextSpecs.push({key,text,x,y,style:{size,color:GOLD,width,wrap:'word'}});
    };
    const button=(key:string,text:string,x:number,y:number,width:number,height:number):void=>{
      this.statusModalTextSpecs.push({key,text,x:x+width/2,y:y+height/2,
        style:{size:Math.min(22,height*.42),color:GOLD,anchorX:.5,anchorY:.5}});
    };
    this.beginModal(MENU_FRAME_MODAL_WIDTH,MENU_FRAME_MODAL_HEIGHT);v.frame(this.app.menuPanels.assets,0,0,MENU_FRAME_MODAL_WIDTH,MENU_FRAME_MODAL_HEIGHT,1);
    add('alloc-title','确定按当前分配增加能力？',35,30,26,648);
    character.attributes.forEach((attribute,index)=>add(`alloc-${PRIMARY_STATS[index]}`,`${attribute.name}　＋${pending[PRIMARY_STATS[index]]}`,65,91+index*38,22,580));
    if(this.allocationError)add('alloc-error',this.allocationError,35,292,20,648);
    v.button('',270,350,170,48,()=>this.finishAllocation(false)).setData('label','取消');
    v.button('',480,350,190,48,()=>this.finishAllocation(true)).setData('label','确定');
    button('alloc-cancel','取消',270,350,170,48);button('alloc-confirm','确定',480,350,190,48);
  }
  /** 技能页的一段文字；页面重绘时按 key 复用 DOM 标签。 */
  private addSkillText(key:string,text:string,x:number,y:number,size:number,color=GOLD,anchorX=0,anchorY=0,
    style:Partial<MenuTextSpec['style']>={},extras:Pick<MenuTextSpec,'scroll'|'clip'>={}):void{
    this.skillTextSpecs.push({key,text,x,y,style:{size,color,anchorX,anchorY,...style},...extras});
  }
  /**
   * 说明正文先按现有断行算出每行高度和每个色块的横向位置；DOM 只负责按结果落字。
   * 每个色块带剩余宽度和行高，字号与换行口径跟 Phaser 版一致。
   */
  private addDescriptionText(keyPrefix:string,layout:{lines:{runs:{text:string;color?:string;x:number}[]}[];lineHeight:number},
    x:number,top:number,width:number,size:number,scroll:string,clip:{top:number;bottom:number},baseY=0):void{
    this.pushDescriptionText(this.skillTextSpecs,keyPrefix,layout,x,top,width,size,scroll,clip,baseY);
  }
  /** 说明正文的色块统一落成 DOM 规格；技能页和背包说明只是收进不同的数组。 */
  private pushDescriptionText(target:MenuTextSpec[],keyPrefix:string,
    layout:{lines:{runs:{text:string;color?:string;x:number}[]}[];lineHeight:number},
    x:number,top:number,width:number,size:number,scroll:string,clip:{top:number;bottom:number},baseY=0):void{
    layout.lines.forEach((line,lineIndex)=>line.runs.forEach((run,runIndex)=>{
      target.push({key:`${keyPrefix}-${lineIndex}-${runIndex}`,text:run.text,
        x:x+run.x,y:top+baseY+lineIndex*layout.lineHeight,
        style:{size,color:run.color??TEXT_COLORS.white,width,
          lineHeight:layout.lineHeight,wrap:'word'},scroll,clip});
    }));
  }
  /** 说明正文的断行和行高仍在布局阶段算完；测量用的 Phaser 文字当场销毁，不参与显示。 */
  private descriptionLayout(view:UiSurface,parts:readonly DescriptionTextPart[],width:number,size:number):
    {lines:{runs:{text:string;color?:string;x:number}[]}[];lineHeight:number;height:number}{
    if(!parts.length)return{lines:[],lineHeight:0,height:0};
    const probe=view.text('测',0,0,0,size,TEXT_COLORS.white);
    const lines=layoutDescriptionText(parts,width,text=>probe.context.measureText(text).width);
    const lineHeight=probe.height+5;
    probe.destroy();
    return{lines,lineHeight,height:Math.max(0,lines.length*lineHeight-5)};
  }
  private renderSkills():void{
    this.skillTextSpecs=[];this.skillTabs.clear();
    const v=this.body!,panels=this.app.menuPanels;
    // 原版技能页也只调 `UI_DrawBorderRect`（`UISkill_Draw @0x163e6c`），左栏与右栏的标题条、
    // 内容区各是一块图框；面板里露出的是黑色 65% 遮罩下的世界画面。
    v.border(panels.assets,85,0,409,431);drawSolidBorder(v,panels.assets,537,0,409,53);v.border(panels.assets,537,53,409,378);
    this.drawPartyColumn(v);
    (['directory','ai','settings'] as const).forEach((section,index)=>{const button=v.button('',486,38+index*118,46,118,()=>{this.skillSection=section;this.scrollOffsets.delete('skills:description');this.render();},{image:panels.assets[`skill-tab-${section}`],disabled:section!=='directory'&&(!this.session!.party||(section==='settings'&&this.selectedMemberId!=='player'))}).setData('label',{directory:'技能目录',ai:'AI 设置',settings:'设置'}[section]);this.skillTabs.set(section,button);});
    this.renderSkillContent();
  }
  private renderSkillContent():void{
    const v=this.body!,before=new Set(v.root.list),member=this.member()!,panels=this.app.menuPanels,configuration=this.configuration(),character=this.app.battleCatalog.classes.find(value=>value.id===member.classId)!;
    if(this.skillSection==='settings'&&this.selectedMemberId!=='player')this.skillSection='directory';
    this.skill??=character.skills[0];if(!character.skills.includes(this.skill))this.skill=character.skills[0];
    const draft=configuration.draft(this.app.battleCatalog,member.classId),progression=this.selectedMemberId==='player'?this.session!.skills:undefined;
    if(this.skillSection==='directory')this.renderSkillDirectory(character,draft);
    else if(this.skillSection==='ai')this.renderSkillAi(character,draft);
    else this.renderSkillSettings();
    // 剧情伙伴的定义 id 也叫 mercenary-*，身份只能看 source。
    const companion=progression?undefined:this.session!.party?.get(this.selectedMemberId);
    this.addSkillText('skills-header',progression?`${panels.character.labels.skillPoints} ${progression.points()}`
      :(companion?.source==='story'?'伙伴技能':'佣兵技能'),561,14,19,GOLD,0,0,
      {width:350,wrap:'word',lineHeight:24});
    this.renderSkillAside(draft,progression);
    this.skillContentNodes=v.root.list.filter(node=>!before.has(node));
  }
  /** 技能目录：原版三列技能格，左侧两列主动、第三列被动。 */
  private renderSkillDirectory(character:BattleClass,draft:SkillLoadout):void{
    const v=this.body!,panels=this.app.menuPanels;
    // 选中框画在格内 (-14,-14) 并要与格子一起滚动，所以留它一条 16 像素的裁剪外扩，
    // 否则第一列与第一行的圆环会被滚动区切成缺边的「C」形。
    // 可视区收进左框内沿：原版滚动区是 (21,18,374,394)，内容组再左内缩 10。这里把滚动原点
    // 移到 (116,24)（相对原可视区右移 10、下移 6），再用 16 的裁剪外扩；下沿正好停在底框上沿，
    // 内容不会盖住列标题和底框。
    const tree=this.scroll('directory',116,24,364,367,this.body!,16);
    // 列标题原来是 72×17 的烘焙文字图，改成 DOM 后不再发虚。
    panels.skillColumns.forEach((column,index)=>this.skillTextSpecs.push({
      key:`skill-column-${index}`,text:column.label,x:116+1+index*91+36,y:24+8.5,
      style:{size:14,color:'#9a9a9a',anchorX:.5,anchorY:.5},scroll:'directory',clip:{top:24,bottom:391}
    }));
    character.skills.forEach((id,index)=>{
      const entry=this.app.battleCatalog.skills[id],position=panels.skillPositions[index]!,level=draft.levels[id]??0;
      const button=v.button('',position.column*91,20+position.row*89,75,75,()=>{this.skill=id;this.scrollOffsets.delete('skills:description');this.render();},{image:entry.icon,parent:tree.content,guard:tree.guard}).setData('label',entry.name);
      button.addAt(v.image(panels.assets['skill-slot'],-9,-9,93,93,button),0);
      // 未学习：原版在图标之上叠一张 75×75 的黑色半透明椭圆（图组 17 索引 11，已导出为
      // `skill-locked`），既没有等级底图也没有数字；已学习才画 17/15 的底图与图组 15 的等级数字
      // （`UISkill_SkillDrawIcon @0x162a2c`：底图在格内 +(57,51)、数字在 +(63,57)）。
      if(!level)v.image(panels.assets['skill-locked'],0,0,75,75,button);
      else{v.image(panels.assets['skill-rank'],57,51,24,25,button);v.image(panels.assets[`skill-rank-${level}`],63,57,10,13,button);}
      // 选中框有两张：图组 17 索引 17 在大圆环之外还包住右下角的等级圈，索引 20 只有干净的大圆环。
      // 原版 `UISkill_DrawSkillGrid @0x1628e8` 按格子状态二选一，且与 `UISkill_SkillDrawIcon
      // @0x162c0c` 画等级底图读的是同一个动作记录位，所以两张图永远与格子一致——没有等级圈的
      // 格子用带角标的那张，右下角就会凭空多出一团亮斑。
      if(id===this.skill)v.image(panels.assets[level?'skill-selected':'skill-selected-ai'],-14,-14,106,102,button);
    });
    this.finishScroll('directory',tree,Math.max(...panels.skillPositions.map(p=>20+p.row*89+75)));
  }
  /**
   * AI 设置：职业的九个主动技能排成两列，每格右侧一个自动使用频率按钮。
   * 未学会的格子只画未掌握底图，也不出现频率按钮——与原版一致。
   */
  private renderSkillAi(character:BattleClass,draft:SkillLoadout):void{
    const v=this.body!,panels=this.app.menuPanels,party=this.session!.party!;
    const list=this.scroll('ai',116,24,364,367,this.body!,16);
    // AI 页只有两列主动技能；第三张是目录页的「被动技能」标题，原版这里只画前两个。
    panels.skillColumns.slice(0,2).forEach((column,index)=>this.skillTextSpecs.push({
      key:`skill-ai-column-${index}`,text:column.label,x:116+1+index*182+36,y:24+8.5,
      style:{size:14,color:'#9a9a9a',anchorX:.5,anchorY:.5},scroll:'ai',clip:{top:24,bottom:391}
    }));
    // 两列之间与右列外侧的压暗分隔条。颜色与原版压暗带相同（RGB 111,111,111），但**不是**
    // `phaser/round-band.ts` 那条：这里是没有圆角件的 37 宽直条，不透明度也直接按 0–255 给
    // （30/255），而 `drawRoundBand` 的强度是 0–100 且带四角图。别把它们当成同一元件合并。
    v.rect(19,39,37,487,0x6f6f6f,30/255,list.content);v.rect(201,39,37,397,0x6f6f6f,30/255,list.content);
    character.skills.slice(0,9).forEach((id,index)=>{
      const position=panels.skillPositions[index]!,entry=this.app.battleCatalog.skills[id]!,level=draft.levels[id]??0;
      const x=position.column*182,y=20+position.row*89;
      const cell=v.button('',x,y,75,75,()=>{this.skill=id;this.scrollOffsets.delete('skills:description');this.render();},{image:level?entry.icon:panels.assets['skill-locked'],parent:list.content,guard:list.guard}).setData('label',entry.name);
      cell.addAt(v.image(panels.assets['skill-slot'],-9,-9,93,93,cell),0);
      if(id===this.skill)v.image(panels.assets['skill-selected-ai'],-14,-14,106,102,cell);
      if(!level)return;
      const frequency=party.aiFrequency(this.selectedMemberId).get(id)??1;
      v.button('',x+85,y+16,82,42,()=>this.action(()=>party.setAiFrequency(this.selectedMemberId,id,(frequency+1)%AI_FREQUENCY_LABELS.length)),
        {image:panels.assets[AI_FREQUENCY_ASSETS[frequency]!],pressed:panels.assets['skill-level-pressed'],native:true,parent:list.content,guard:list.guard})
        .setData('label',`${entry.name}自动使用频率 ${AI_FREQUENCY_LABELS[frequency]}`);
    });
    this.finishScroll('ai',list,Math.max(20+5*89+75,20+2*178+75));
  }
  /** 设置：只剩主角的技能点初始化；佣兵没有独立设置项。 */
  private renderSkillSettings():void{
    const v=this.body!,labels=this.app.menuPanels.skillPanel.labels;
    v.button('',161,290,257,63,()=>{this.skillReset=true;this.render();}).setData('label',labels.resetButton);
    this.addSkillText('skills-reset',labels.resetButton,161+257/2,290+63/2,22,GOLD,.5,.5);
  }
  /** 说明区由技能目录与 AI 设置共享；设置页与原版一样留空。 */
  /**
   * 技能页右侧说明区。目录页按原版排：`技能名 (LV n)` → 介绍 → 主动技能的魔法消耗量 →
   * 当前等级的数值 → 浅蓝点线 → 下一级预览（只列会变的项，满级不画）；AI 设置页只列当前等级的数值。
   * 底部是原版说明面板的菜单行（只挂在目录页）：学习、快捷键两枚按钮。
   */
  private renderSkillAside(draft:SkillLoadout,progression:StorySkillProgression|undefined):void{
    if(this.skillSection==='settings')return;
    const v=this.body!,panels=this.app.menuPanels,
      skill=skillForGrowth(this.app.battleCatalog.skills[this.skill!]!,memberSkillGrowth(this.selectedMemberId)),
      level=draft.levels[skill.id]??0,
      companion=this.selectedMemberId==='player'?undefined:this.session!.party?.get(this.selectedMemberId),
      maximum=companion?(companion.snapshot().skillCaps[skill.id]??0):skill.normalMaxLevel;
    // AI 页未掌握的格子只保留选中状态，右侧说明区清空（原版 UISkill_AIMainExe 调 UIDesc_SetOff）。
    if(this.skillSection==='ai'&&level===0)return;
    const detailHeight=this.skillSection==='ai'?342:279;
    const detail=this.scroll('description',565,71,353,detailHeight);
    const clip={top:71,bottom:71+detailHeight};
    // 说明正文按现有断行结果落字；滚动时 DOM 层按 `description` 的偏移重算位置。
    const description=this.descriptionLayout(v,skillDescriptionParts(skill,level,companion?maximum:undefined),353,22);
    this.addDescriptionText('skill-desc',description,565,71,353,22,'description',clip);
    let y=description.height;
    if(this.skillSection==='ai'){this.finishScroll('description',detail,y);return;}
    if(level<maximum&&skill.ranks[level]){
      drawDescriptionSeparator(v,0,y+5,353,detail.content);y+=20;
      const learning=this.descriptionLayout(v,skillLearningParts(skill.name,level,progression?.learningRequirements(skill.id),
        companion?skill.ranks[level].requiredCharacterLevel:undefined),353,22);
      this.addDescriptionText('skill-learn',learning,565,71,353,22,'description',clip,y);
      y+=learning.height+12;
      skillNextLevelPreview(skill.ranks,level,skill.kind,maximum,skill.display).forEach((row,index)=>{
        const center=353/2,labelColor=row.kind==='mana'?SKILL_PREVIEW_COLORS.mana:TEXT_COLORS.white,valueColor=row.kind==='mana'?SKILL_PREVIEW_COLORS.mana:SKILL_PREVIEW_COLORS.changed;
        this.addSkillText(`skill-preview-${index}-label`,row.label,565+center,71+y,19,labelColor,.5,0,{}, {scroll:'description',clip});
        const valuesY=71+y+26;
        this.addSkillText(`skill-preview-${index}-from`,row.from,565+center-12,valuesY,19,valueColor,1,0,{}, {scroll:'description',clip});
        v.image(panels.assets['skill-compare-arrow'],center-10.5,y+25,21,24,detail.content);
        this.addSkillText(`skill-preview-${index}-to`,row.to,565+center+12,valuesY,19,valueColor,0,0,{}, {scroll:'description',clip});
        y+=52;
      });
    }
    this.finishScroll('description',detail,y);
    // 底部两枚按钮按原版：学习（学习就是升级，立即扣点，条件不足时禁用）与快捷键（主动技能才有，
    // 已学习才可用，已在当前快捷组里时换成「取消快捷键」）。三张图是 `UISkill_SetDescMenu @0x164488`
    // 的 subID 16／17／18，字已经印在图里，所以按钮不画文字，标签只留给键盘与调试。
    const menu=DESCRIPTION_PANEL.menu,rowX=537+menu.x,rowY=menu.y;
    const buttons:{image:string;label:string;disabled?:boolean;run:()=>void}[]=[];
    if(progression){
      const cost=skill.ranks[level]?.pointCost??0,problem=progression.learningProblem(skill.id);
      buttons.push({image:panels.assets['skill-learn'],label:cost?`学习 ${cost}`:'学习',disabled:!!problem,
        run:()=>this.action(()=>{progression.learn(skill.id);})});
    }
    // 「快捷键」进登记那一屏，「取消快捷键」直接把这门技能从两组里清掉——原版也是两枚按钮两个回调
    // （`UISkill_ButtonShortcutExe 0x164660` 与 `UISkill_ButtonRemoveShortcutExe 0x1645f8`）。
    if(skill.kind==='active'){
      const assigned=level>0&&this.shortcutBar().assigned('skill',skill.id);
      buttons.push({image:panels.assets[assigned?'skill-shortcut-cancel':'skill-shortcut'],
        label:assigned?'取消快捷键':'快捷键',disabled:level===0,
        run:()=>assigned?this.clearShortcut('skill',skill.id):this.openShortcutScreen('skill',skill.id)});
    }
    const start=menu.offsets[Math.min(buttons.length,3)]??0;
    buttons.forEach((button,index)=>{
      // 命中区是 125×55，但原图是 149×75、按原版落在 (x−12, y−9) 且不缩放，所以自己摆：
      // 常态图垫在最下面，按下层用 `pressedRect` 落到同一处。
      const hit=v.button('',rowX+start+index*menu.button.stride,rowY,menu.button.width,menu.button.height,button.run,
        {bare:true,pressed:panels.assets['skill-button-pressed'],pressedRect:{x:-12,y:-9,width:149,height:75},disabled:button.disabled}).setData('label',button.label);
      hit.addAt(v.image(button.image,-12,-9,149,75,hit),0);
    });
  }
  /** 初始化技能点是不可逆操作，沿用体验版对不可逆操作的模态确认，结果由面板更新呈现。 */
  private renderSkillResetConfirmation():void{
    const v=this.modal!,panels=this.app.menuPanels;
    this.skillResetTextSpecs=[];
    const add=(key:string,text:string,x:number,y:number,size:number,width:number):void=>{
      this.skillResetTextSpecs.push({key,text,x,y,style:{size,color:GOLD,width,wrap:'word'}});
    };
    const button=(key:string,text:string,x:number,y:number,width:number,height:number):void=>{
      this.skillResetTextSpecs.push({key,text,x:x+width/2,y:y+height/2,
        style:{size:Math.min(22,height*.42),color:GOLD,anchorX:.5,anchorY:.5}});
    };
    this.beginModal(MENU_FRAME_MODAL_WIDTH,MENU_FRAME_MODAL_HEIGHT);v.visible(true);v.frame(panels.assets,0,0,MENU_FRAME_MODAL_WIDTH,MENU_FRAME_MODAL_HEIGHT,1);
    add('skill-reset-title',`确定为${this.actor().name}初始化技能点？`,35,30,26,648);
    add('skill-reset-description','清空已学技能与快捷栏，返还正常加点的技能点。',35,91,22,648);
    v.button('',270,350,170,48,()=>{this.skillReset=false;this.render();}).setData('label','取消');
    button('skill-reset-cancel','取消',270,350,170,48);
    v.button('',480,350,190,48,()=>{
      if(this.busy)return;this.busy=true;
      try{this.session!.skills.reset();this.skillReset=false;}
      catch(error){this.notice=(error as Error).message;}
      finally{this.busy=false;}
      this.render();
    }).setData('label','确定');
    button('skill-reset-confirm','确定',480,350,190,48);
  }
  /** 当前选中成员的快捷栏。默认内容按已学会的主动技能算，主角第一组第六格还带开局的消耗品。 */
  private shortcutBar():ShortcutBar {
    const bag=this.session!.bag;
    return ShortcutBar.for(bag,this.selectedMemberId,this.configuration().activeSkills(this.app.battleCatalog,this.member()!.classId),
      this.selectedMemberId==='player'?bag.catalog.startingShortcut:undefined);
  }
  /** 从技能说明面板或物品详情进这一屏。`id` 是要登记的对象，进来后固定停在第 1 组（原版 `i32Page` 归零）。 */
  private openShortcutScreen(kind:ShortcutEntry['kind'],id:string):void{
    this.cancelDrag();this.shortcutEdit={kind,id,page:0};this.render();
  }
  private closeShortcutScreen():void{this.shortcutEdit=undefined;this.shortcutScreen?.clear();this.backTab?.clear();this.render();}
  /** 点某一格就落格，已占用即覆盖；落完留在这一屏继续登记。 */
  private assignShortcut(slot:number):void{
    const edit=this.shortcutEdit;if(!edit)return;
    const current=this.shortcutBar().page(edit.page)[slot];
    // 技能槽再点一次就是取消；物品沿用原版行为，点击只重新落格。
    const same=edit.kind==='skill'&&current?.kind==='skill'&&current.id===edit.id;
    this.shortcutBar().assign(edit.page,slot,same?null:{kind:edit.kind,id:edit.id});
    this.render();
  }
  /** 另一处「取消快捷键」：把该对象从两组里一次清掉，对应 `PLAYER_RemoveShortcutAll`。 */
  private clearShortcut(kind:ShortcutEntry['kind'],id:string):void{this.shortcutBar().clearObject(kind,id);this.render();}
  private shortcutIcon(entry:ShortcutEntry):string {
    return entry.kind==='skill'?this.app.battleCatalog.skills[entry.id]?.icon:this.session!.bag.catalog.items[entry.id]?.icon;
  }
  /** 物品内图比技能小一圈，原版消耗品位就是 64×64。 */
  private shortcutIconSize(entry:ShortcutEntry):number{return entry.kind==='item'?ITEM_ICON_SIZE:SLOT_ICON_SIZE;}
  /**
   * 登记快捷键这一屏，原版是 `UIShortcutMenu`（依据见 `work/findings/shortcut-screen-2026-10-13.md`）：
   * 菜单整块让位、露出背后的游戏画面与黑色遮罩；左上角一枚圆形关闭钮，顶部一行提示，
   * 右侧浮出与游戏里同一排的六个圆槽与换组按钮，待登记的对象画在屏幕中间偏右的圆框里。
   * 圆槽与换组钮的位置读设备键位配置，与游戏 HUD 共用坐标和缩放，
   * 所以进这一屏后它们与游戏画面里的那一排严丝合缝。这一层的原点是屏幕左上角。
   */
  private renderShortcutScreen():void{
    const edit=this.shortcutEdit,screen=this.shortcutScreen,skin=this.app.controlSkin,scene=this.scene;
    if(!edit||!screen||!scene)return;
    screen.clear();const v=screen,{scale,anchor}=controlPlacement(),slots=this.shortcutBar().page(edit.page),positions=resolveControlLayout(controlViewport(),this.app.controlLayout.snapshot());
    // 顶部提示：原版 `GRPX_DrawStringWithFont(TEXTDATABASE[146], 屏宽/2, 110)`，白字居中。
    this.placeShortcutPrompt();
    // 攻击按钮是轮盘的中心锚点，登记屏也要按当前布局画出来；只画槽位会让中间空一块。
    const attack=positions.attack,attackWidth=CONTROL_SIZES.attack.width*attack.userScale,attackHeight=CONTROL_SIZES.attack.height*attack.userScale;
    v.image(skin.button,attack.x/scale-attackWidth/2,attack.y/scale-attackHeight/2,attackWidth,attackHeight);
    // 六个圆槽：输入矩形与槽框都乘设备倍率，换组后沿用同一个槽位的尺寸。
    for(let slot=0;slot<SHORTCUT_SLOT_COUNT;slot++){const point=positions[`slot-${slot}` as ControlId],userScale=point.userScale;
      const slotFrame=CONTROL_SIZES.slot.width*userScale,input=80*userScale,slotBleed=(slotFrame-input)/2;
      const hit=v.button('',point.x/scale-input/2,point.y/scale-input/2,input,input,()=>this.assignShortcut(slot),
        {bare:true,pressed:skin['slot-pressed'],pressedRect:{x:-slotBleed,y:-slotBleed,width:slotFrame,height:slotFrame}}).setData('label',`快捷位 ${slot+1}`);
      hit.addAt(v.image(skin['slot-shadow'],-slotBleed,-slotBleed,slotFrame,slotFrame),0);hit.addAt(v.image(skin['slot-ring'],-slotBleed,-slotBleed,slotFrame,slotFrame),1);
      const entry=slots[slot];if(entry){const size=this.shortcutIconSize(entry)*userScale,icon=this.shortcutIcon(entry);
        if(icon)hit.addAt(v.image(icon,(input-size)/2,(input-size)/2,size,size),2);}
    }
    // 换组按钮：共享交换键尺寸，动作是整组切换（`UIShortcutMenu_ButtonScrollExe @0x161368`）。
    const swapUserScale=positions.swap.userScale,swapFrame=CONTROL_SIZES.swap.width*swapUserScale;
    const swap=v.button('',positions.swap.x/scale-swapFrame/2,positions.swap.y/scale-swapFrame/2,swapFrame,swapFrame,
      ()=>{this.shortcutEdit={...edit,page:(edit.page+1)%SHORTCUT_PAGE_COUNT};this.render();},
      {bare:true,pressed:skin['swap-pressed']}).setData('label','切换技能组');
    swap.addAt(v.image(skin.swap,0,0,swapFrame,swapFrame),0);
    // 待登记的对象：原版把它画在一个单独的圆框容器里，位置见 `PENDING_OFFSET`。
    const slotFrame=CONTROL_SIZES.slot.width,size=this.shortcutIconSize(edit),icon=this.shortcutIcon(edit),pending={x:anchor.x+PENDING_OFFSET.x,y:anchor.y+PENDING_OFFSET.y};
    v.image(skin['slot-shadow'],pending.x-slotFrame/2,pending.y-slotFrame/2,slotFrame,slotFrame);
    v.image(skin['slot-ring'],pending.x-slotFrame/2,pending.y-slotFrame/2,slotFrame,slotFrame);
    if(icon)v.image(icon,pending.x-size/2,pending.y-size/2,size,size);
  }
  /** 登记快捷键那一屏的顶部提示：位置按该屏画布的缩放换算，文字交给 DOM。 */
  private placeShortcutPrompt():void{
    const edit=this.shortcutEdit,screen=this.shortcutScreen,scene=this.scene,prompt=this.shortcutPrompt;
    if(!edit||!screen||!scene||!prompt)return;
    const {scale}=controlPlacement();
    const matrix=screen.root.getWorldTransformMatrix();
    const point=matrix.transformPoint(frameRect().width/scale/2,110);
    prompt.setText(SHORTCUT_PROMPT).setPosition(point.x,point.y)
      .setStyle({fontSize:`${26*matrix.scaleX}px`,color:TEXT_COLORS.white});
  }
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
    if(this.shortcutEdit)this.closeShortcutScreen();
  }
  private renderBag():void{
    this.bagTextSpecs=[];this.bagDetailTextSpecs=[];this.bagDetailOpen=false;this.bagEquipment.clear();this.bagSelection=undefined;
    this.bagSlots=[];this.bagGrid=undefined;this.bagPreview=undefined;this.bagPartyNodes=[];
    const v=this.body!,bag=this.session!.bag,panels=this.app.menuPanels;
    // 两栏背景照原版：`UIEquip_DrawEquipBackground @0x14a7cc` 给左栏画图框加四块黑色 60% 的区域
    // （`GRPX_FillRectAlpha(..., 0xff000000, 0x3c)`），中间 (129,110,157,157) 那块留空放人物预览；
    // 右栏只有图框——`UIEquip_DrawInvenBackground @0x14aed0` 不铺底，格子直接浮在背景上。
    v.staticLayer('bag',()=>{
      v.border(panels.assets,85,0,409,431,v.staticRoot);
      drawBagRail(v,panels.assets,496,v.staticRoot);
      for(const [x,y,width,height] of [[24,24,361,86],[24,110,105,157],[286,110,99,157],[24,267,361,140]])
        v.rect(85+x,y,width,height,0x000000,.6,v.staticRoot);
      // 黑底之后叠四块 41×41 的角色图角（组 15 索引 48／49／53／54），画在框外 2 像素处。
      for(const [corner,x,y]of [['nw',83,-2],['ne',455,-2],['sw',83,392],['se',455,392]] as const)v.image(panels.assets[`character-${corner}`],x,y,41,41,v.staticRoot);
      // 等级／职业行的底板同样是固定装饰，文字在下面单独画。
      v.textPlate(panels.assets['text-plate-left'],panels.assets['text-plate-right'],131,368,323,v.staticRoot);
    });
    this.drawPartyColumn(v,this.bagPartyNodes);
    this.bagPartyKey=this.bagPartyState();
    const showingResult=itemResultDetails(this.itemResult,bag.catalog,id=>id,id=>id).length>0,
      describing=!showingResult&&!!this.selectedItem&&!!bag.get(this.selectedItem);
    this.bagDetailOpen=describing||showingResult;
    // 说明面板盖住点选来源的对面那一栏：停在左栏（点背包物品）时右栏照常画背包网格，
    // 停在右栏（点身上装备）时左栏的人物与装备槽也必须照常画——否则那一块会整片空掉。
    // 只有面板盖住左栏时才省掉这一支——省掉的是被盖住的那一块，**不是把选中状态清掉**：
    // 清掉之后下面那句就画不出说明了。
    const covered=(describing||showingResult)&&this.descSide==='left';
    // 对称的另一半：面板停在右栏时盖的是背包栏，底下那些格子看不见，拖动就不该从它们身上起手
    // （面板自己的滚动区与按钮只挡住大部分区域，标题带和面板左缘的留白会漏出被盖住的格子）。
    const panelCoversBag=(describing||showingResult)&&this.descSide==='right';
    if(!covered){
      if(!describing)this.selectedItem=undefined;
      this.renderBagEquipment();
    }
    if(showingResult){this.renderItemResult();}
    else if(describing)this.renderItemDetail(this.selectedItem!);
    const layout=bagLayout(),cells=layout.grid;
    const {slots,slotCount}=inventoryView({all:bag.allCells,...bag.pouchCells},this.filter),
      // 滚动条放到格子右侧的栏间空档，不压最后一列；上下各留 4 像素。
      grid=this.scroll('inventory',cells.x,cells.y,cells.width,cells.height,this.body!,0,
        {offset:10,insetY:4,width:4});
    this.bagGrid=grid;
    for(let index=0;index<slotCount;index++)this.bagSlots.push(this.createBagSlotView(slots[index]!,index,panelCoversBag));
    this.updateBagSelection();
    this.finishScroll('inventory',grid,Math.ceil(slotCount/cells.columns)*cells.stride);
    this.addBagMoneyTexts(panelCoversBag);
    this.bagMemberId=this.selectedMemberId;this.bagFilterView=this.filter;
    const organize=layout.organize;
    v.button('',organize.x,organize.y,organize.width,organize.height,()=>this.action(()=>bag.organize()))
      .setData('label','整理');
    this.bagTextSpecs.push({key:'bag-organize',text:'整理',x:organize.x+organize.width/2,y:organize.y+organize.height/2,
      style:{size:Math.min(22,organize.height*.42),anchorX:.5,anchorY:.5,width:organize.width-12,align:'center',wrap:'word'}});
    const side=layout.sideButtons;
    INVENTORY_SIDE_FILTERS.forEach((filter,index)=>{
      const rowY=side.y+side.offsets[index];
      if(this.filter===filter)drawBagRailSelection(v,side.x,rowY,side.width,side.height);
      const button=v.button('',side.x,rowY,side.width,side.height,()=>{this.cancelDrag();this.filter=filter;this.itemResult=undefined;this.selectedItem=undefined;this.itemNotice=undefined;this.scrollOffsets.delete('bag:inventory');this.render();},{bare:true});
      this.bagTextSpecs.push({key:`bag-filter-${filter}`,text:INVENTORY_LABELS[filter],
        x:side.x+side.width/2,y:rowY+side.height/2,
        style:{size:SIDE_FILTER_TEXT_SIZE,anchorX:.5,anchorY:.5,width:side.width-6,align:'center',wrap:'word'}});
      button.setData('label',INVENTORY_LABELS[filter]);
    });
  }
  private bagPartyState():string{return (this.session!.party?.activeIds??['player']).join('|');}
  /** 背包网格的一格：空格画底图，物品格建按钮和图标，并把拖动信息挂进 `drops`。 */
  private createBagSlotView(slot:BagDataSlot,index:number,panelCoversBag:boolean):BagSlotView{
    const v=this.body!,bag=this.session!.bag,layout=bagLayout(),grid=this.bagGrid!,
      x=index%layout.grid.columns*layout.grid.stride,y=Math.floor(index/layout.grid.columns)*layout.grid.stride;
    if(slot.kind==='cell'){
      const object=v.image(this.app.menuPanels.assets['inventory-slot'],x,y,layout.slot.size,layout.slot.size,grid.content);
      const drop={object,view:slot.view,cell:slot.cell};this.drops.push(drop);
      return {kind:'cell',object,view:slot.view,cell:slot.cell,drop};
    }
    const entry=slot.entry,item=bag.catalog.items[entry.item];
    const button=v.button('',x,y,layout.slot.size,layout.slot.size,()=>{if(this.suppressClick)return;this.selectItem(entry.id,'left');},
      {image:slotFrameImage(this.app,this.session!,entry),parent:grid.content,guard:grid.guard}).setData('label',item.name);
    const icon=v.image(item.icon,layout.slot.icon.x,layout.slot.icon.y,layout.slot.icon.size,layout.slot.icon.size,button);
    const drop={object:button,entry:entry.id,view:slot.view,cell:slot.cell};this.drops.push(drop);
    button.on('pointerdown',(pointer:UiPointer)=>{if(!this.bagDetailOpen||this.descSide!=='right')this.startDrag(pointer,entry.id,grid);});
    updateEquipmentLock(v,button,!!entry.locked);
    this.addBagSlotText(slot,x,y,panelCoversBag);
    return {kind:'item',button,icon,entryId:entry.id,view:slot.view,cell:slot.cell,drop};
  }
  /** 同一个物品格只换位置、图标和角标；物品换掉了就由调用方销毁重建。 */
  private updateBagSlotView(view:BagSlotView,slot:BagDataSlot,index:number,panelCoversBag:boolean):void{
    const layout=bagLayout(),bag=this.session!.bag,
      x=index%layout.grid.columns*layout.grid.stride,y=Math.floor(index/layout.grid.columns)*layout.grid.stride;
    if(view.kind==='cell'){view.object.setPosition(x,y);return;}
    if(slot.kind!=='item')return;
    const entry=slot.entry,item=bag.catalog.items[entry.item],frame=slotFrameImage(this.app,this.session!,entry);
    const signature=JSON.stringify([index,slot.view,slot.cell,entry.id,entry.item,frame,entry.quantity,entry.enhancement,entry.gems.length,entry.locked,panelCoversBag]);
    if(view.button.getData('bag-state')===signature){
      this.bagTextSpecs.push(...(view.button.getData('bag-texts') as MenuTextSpec[]));return;
    }
    view.button.setData('bag-state',signature);
    updateEquipmentLock(this.body!,view.button,!!entry.locked);
    view.button.setPosition(x,y).setData('label',item.name);
    const face=view.button.getData('face') as UiImage|undefined;
    if(face&&face.getData('file')!==frame)face.load(frame);
    if(view.icon.getData('file')!==item.icon)view.icon.load(item.icon);
    view.icon.setPosition(layout.slot.icon.x,layout.slot.icon.y);
    if(view.icon.width!==layout.slot.icon.size||view.icon.height!==layout.slot.icon.size)view.icon.resize(layout.slot.icon.size,layout.slot.icon.size);
    view.drop.entry=entry.id;view.drop.view=slot.view;view.drop.cell=slot.cell;
    const textStart=this.bagTextSpecs.length;
    this.addBagSlotText(slot,x,y,panelCoversBag);
    view.button.setData('bag-texts',this.bagTextSpecs.slice(textStart));
  }
  private destroyBagSlotView(view:BagSlotView):void{
    (view.kind==='item'?view.button:view.object).destroy();
    this.drops=this.drops.filter(drop=>drop!==view.drop);
  }
  /** 格子角标和数量随网格一起滚动；key 用袋位+格号，翻物品时不新建标签。 */
  private addBagSlotText(slot:BagDataSlot,x:number,y:number,panelCoversBag:boolean):void{
    if(slot.kind!=='item'||panelCoversBag)return;
    const entry=slot.entry,item=this.session!.bag.catalog.items[entry.item],layout=bagLayout(),cells=layout.grid,
      slotKey=`bag-slot-${slot.view}-${slot.cell}`,clip={top:cells.y,bottom:cells.y+cells.height};
    if(item.stackable)this.bagTextSpecs.push({key:`${slotKey}-quantity`,text:String(entry.quantity),
      x:cells.x+x+layout.badge.x,y:cells.y+y+layout.badge.y,
      style:{size:20,color:layout.badge.color,anchorX:1,anchorY:0},scroll:'inventory',clip});
    if(entry.enhancement)this.bagTextSpecs.push({key:`${slotKey}-enhancement`,text:`+${entry.enhancement}`,
      x:cells.x+x+2,y:cells.y+y+2,style:{size:17,anchorX:0,anchorY:0},scroll:'inventory',clip});
    if(entry.gems.length)this.bagTextSpecs.push({key:`${slotKey}-gems`,text:'◆'.repeat(entry.gems.length),
      x:cells.x+x+2,y:cells.y+y+52,style:{size:16,anchorX:0,anchorY:0},scroll:'inventory',clip});
  }
  /** 金额图只在整页绘制时建一次；数据变化只换数字。 */
  private addBagMoneyTexts(panelCoversBag:boolean):void{
    const v=this.body!,layout=bagLayout(),money=splitMoney(this.session!.money);
    (['gold','silver','copper'] as const).forEach((unit,index)=>{
      if(!this.bagPageCached)v.image(this.content!.assets[`money-${unit}`],layout.money.x+index*layout.money.stride,layout.money.y,layout.money.coin.width,layout.money.coin.height);
      if(!panelCoversBag)this.bagTextSpecs.push({key:`bag-money-${unit}`,text:String(money[unit]),
        x:layout.money.x+index*layout.money.stride+layout.money.digit.x,y:layout.money.y+layout.money.digit.y,
        style:{size:20,color:layout.money.color,anchorX:0,anchorY:0}});
    });
  }
  private updateBagSelection():void{
    this.bagSelection?.destroy();this.bagSelection=undefined;
    if(!this.selectedItem)return;
    const view=this.bagSlots.find((slot):slot is Extract<BagSlotView,{kind:'item'}>=>slot.kind==='item'&&slot.entryId===this.selectedItem);
    if(!view)return;
    const selection=bagLayout().slot.selection;
    this.bagSelection=this.body!.image(this.app.menuPanels.assets['inventory-selected'],
      selection.x,selection.y,selection.size,selection.size,view.button);
  }
  private removeDescriptionScrolls():void{
    for(const [name,scroll] of this.scrollNames)if(scroll.surface===this.description)this.scrollNames.delete(name);
  }
  /**
   * 背包页已画好时，会话数据变了只改变化的部分：格子按物品实例复用，空格按袋位复用，
   * 装备槽只换图，说明面板单独重画。整页 DOM 不再拆掉。
   */
  private updateBagPage():void{
    // 队员栏在网格之前画、层级也压在网格下面；队伍人数或顺序变了就整页重画一次，
    // 避免为了几个头像把后来的节点盖到装备和格子上。
    if(this.bagPartyState()!==this.bagPartyKey||this.bagFilterView!==this.filter){this.renderNow();return;}
    const bag=this.session!.bag,grid=this.bagGrid!,layout=bagLayout(),cells=layout.grid;
    const {slots,slotCount}=inventoryView({all:bag.allCells,...bag.pouchCells},this.filter);
    const wasDetail=this.bagDetailOpen,describing=!!this.selectedItem&&!!bag.get(this.selectedItem);
    this.bagDetailOpen=describing;
    const panelCoversBag=describing&&this.descSide==='right';
    this.bagTextSpecs=this.bagTextSpecs.filter(spec=>!spec.key.startsWith('bag-slot-')&&!spec.key.startsWith('bag-money-'));
    const oldItems=new Map<string,BagSlotView>(),oldCells=new Map<string,BagSlotView>();
    for(const view of this.bagSlots){
      if(view.kind==='item')oldItems.set(view.entryId,view);
      else oldCells.set(`${view.view}:${view.cell}`,view);
    }
    const next:BagSlotView[]=[];
    for(let index=0;index<slotCount;index++){
      const slot=slots[index]!,key=slot.kind==='item'?slot.entry.id:`${slot.view}:${slot.cell}`;
      let view=slot.kind==='item'?oldItems.get(key):oldCells.get(key);
      if(view&&view.kind===slot.kind){
        this.updateBagSlotView(view,slot,index,panelCoversBag);
        if(view.kind==='item')oldItems.delete(key);else oldCells.delete(key);
      }else{
        view=this.createBagSlotView(slot,index,panelCoversBag);
      }
      next.push(view);
    }
    for(const view of oldItems.values())this.destroyBagSlotView(view);
    for(const view of oldCells.values())this.destroyBagSlotView(view);
    this.body!.pruneDestroyed();
    this.bagSlots=next;
    this.addBagMoneyTexts(panelCoversBag);
    this.updateBagSelection();
    if(describing){
      this.bagDetailTextSpecs=[];this.description!.clear();this.removeDescriptionScrolls();
      this.renderItemDetail(this.selectedItem!);
    }else if(wasDetail){
      this.bagDetailTextSpecs=[];this.description!.clear();this.removeDescriptionScrolls();
    }
    if(this.bagEquipment.size===0){
      this.bagTextSpecs=this.bagTextSpecs.filter(spec=>spec.key!=='bag-level');
      this.renderBagEquipment();
    }
    const memberChanged=this.bagMemberId!==this.selectedMemberId,equipment=bag.equipmentFor(this.selectedMemberId);
    let equipmentChanged=memberChanged;
    if(!equipmentChanged)for(const slot of EQUIPMENT_SLOTS){
      const view=this.bagEquipment.get(slot);if(view&&view.drop.entry!==equipment[slot]){equipmentChanged=true;break;}
    }
    this.updateBagMember(memberChanged||equipmentChanged,false);
    this.bagMemberId=this.selectedMemberId;
    this.bagFilterView=this.filter;
    grid.setHeight(Math.ceil(slotCount/cells.columns)*cells.stride);
    this.menuText?.renderPage('bag');
    this.sync();
  }
  /** 说明面板停在点选来源的对面栏：物品在左栏、身上装备在右栏，见 bag-layout 的说明。 */
  private selectItem(id:string,side:'left'|'right'):void{
    this.itemResult=undefined;
    this.descSide=side;this.selectedItem=this.selectedItem===id?undefined:id;this.scrollOffsets.delete('bag:item');this.render();
  }
  private renderItemDetail(id:string):void{
    const v=this.description!,bag=this.session!.bag,entry=bag.get(id)!,item=bag.catalog.items[entry.item],worn=EQUIPMENT_SLOTS.find(slot=>bag.equipmentFor(this.selectedMemberId)[slot]===id);
    // 面板盖住点选来源的对面那一栏，宽度就跟那一栏一样：物品落人物栏(409)、身上装备落背包栏(395)。
    const layout=bagLayout(),covered=this.descSide==='left'?layout.leftFrame:layout.bagFrame,
      // 盖背包栏时右边缘让开右侧那一列分类按钮（BAG_DESCRIPTION_WIDTH），盖人物栏时与原版一样与栏同宽。
      panel=descriptionPanel(this.descSide==='left'?covered.width:BAG_DESCRIPTION_WIDTH),left=covered.x,top=panel.y;
    // 面板现在完全不透明，整块先铺一层透明拦截层，避免点击穿透到被盖住的格子；
    // 关闭钮、动作按钮和正文滚动区随后绘制，仍在上层。
    v.rect(left,top,panel.width,panel.height,0x000000,0).setInteractive();
    drawDescriptionPanel(v,this.app.menuPanels.assets,left,top,panel.width);
    // 滚动区必须建在说明层上（末尾的 `v`）：面板底色、图框与物品名都画在这一层，
    // 滚动区若留在内容块那一层（默认值）会被面板自己的黑底压住，正文看起来就是灰的。
    const actions=this.bagMenu(entry,worn),actionLayout=descriptionActionLayout(panel.width,actions.length);
    const detail=this.scroll('item',left+panel.scroll.x,top+panel.scroll.y,panel.scroll.width,actionLayout.scrollHeight,v);
    // 标题、颜色与正文由同一个实例说明生成器提供；当前查看的成员决定职业与等级条件。
    const body=itemDescriptionBody({item,entry,numbers:this.app.characterStats.equipment[entry.item],catalog:this.app.characterStats,
      grades:this.app.shops.grades,member:this.member(),classNames:this.classNames(),gemNames:entry.gems.map(id=>bag.catalog.items[id]?.name),skill:entry.skill?bag.catalog.skillDescriptions?.[entry.skill]:undefined});
    // 说明正文走 DOM：断行和高度仍在布局阶段算完，滚动时由文字层扣掉滚动偏移。
    const scrollX=left+panel.scroll.x,scrollY=top+panel.scroll.y,
      clip={top:scrollY,bottom:scrollY+actionLayout.scrollHeight},
      writer={add:(spec:MenuTextSpec)=>this.bagDetailTextSpecs.push(spec)};
    drawDescriptionTitle(body.title,left,top,panel.width,body.color,{writer,keyPrefix:'item-title'});
    let y=drawDescriptionRows(v,body.rows,panel.scroll.width,
      {writer,keyPrefix:'item-row',x:scrollX,y:scrollY,scroll:'item',clip});
    this.finishScroll('item',detail,y);
    // 关闭按钮挂在面板右上角：那枚 67×67 的圆钮（原版矩形 349,−6，本作右移到贴边）。
    drawDescriptionClose(v,this.app.menuPanels.assets,panel,left,top,()=>{this.itemNotice=undefined;this.selectedItem=undefined;this.render();});
    // 底部操作行：1–3 个保持原版一横排；4 个改 2×2，5–6 个改 3×2，避免按钮被压得太小。
    if(actions.length){
      actions.forEach((action,index)=>{
        const button=actionLayout.buttons[index]!;
        const fontSize=descriptionActionLabelSize(action.label,button.width,button.fontSize);
        v.button('',left+button.x,top+button.y,button.width,button.height,action.run,
          {fontSize,disabled:action.disabled}).setData('label',action.label);
        this.bagDetailTextSpecs.push({key:`item-action-${index}`,text:action.label,
          x:left+button.x+button.width/2,y:top+button.y+button.height/2,
          style:{size:fontSize,anchorX:.5,anchorY:.5,width:button.width-40,align:'center',wrap:'none'}});
      });
    }
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
    const detail=this.scroll('item',left+panel.scroll.x,top+panel.scroll.y,panel.scroll.width,panel.scroll.height,v);
    const body=itemDescriptionBody({item,entry,numbers:this.app.characterStats.equipment[entry.item],
      catalog:this.app.characterStats,grades:this.app.shops.grades,member:this.member(),
      classNames:this.classNames(),gemNames:entry.gems.map(id=>catalog.items[id]?.name),skill:entry.skill?catalog.skillDescriptions?.[entry.skill]:undefined});
    // 说明层坐标与内容块一致；调试页的文字层按内容块坐标输出。
    const scrollX=left+panel.scroll.x,scrollY=top+panel.scroll.y,
      clip={top:scrollY,bottom:scrollY+panel.scroll.height},
      writer={add:(spec:MenuTextSpec)=>this.gmDetailTextSpecs.push(spec)};
    drawDescriptionTitle(body.title,left,top,panel.width,body.color,{writer,keyPrefix:'gm-item-title'});
    const height=drawDescriptionRows(v,body.rows,panel.scroll.width,
      {writer,keyPrefix:'gm-item-row',x:scrollX,y:scrollY,scroll:'item',clip});
    this.finishScroll('item',detail,height);
    drawDescriptionClose(v,this.app.menuPanels.assets,panel,left,top,close);
  }
  /** 底部操作行的内容与次序照原版 `UIEquip_SetDescMenu`：先装备态动作，再使用，最后丢弃。 */
  private bagMenu(entry:ItemInstance,worn?:EquipmentSlot):BagMenuAction[]{
    const bag=this.session!.bag,item=bag.catalog.items[entry.item],actions:BagMenuAction[]=[];
    if(worn)actions.push({label:'卸下',run:()=>void this.changeEquipment(undefined,worn)});
    else{
      const member=this.member()!;
      const slots=bag.equippableSlots(entry.id,this.selectedMemberId,member.classId,member.level);
      const empty=bag.emptyEquipSlot(entry.id,this.selectedMemberId,member.classId,member.level);
      const slotName=(slot:EquipmentSlot)=>this.app.menuPanels.equipmentSlots.find(value=>value.id===slot)?.name??slot;
      if(empty)actions.push({label:'装备',run:()=>void this.changeEquipment(entry.id,empty)});
      else if(slots.length===1)actions.push({label:'装备',run:()=>void this.changeEquipment(entry.id,slots[0]!)});
      else if(slots.length>1)for(const slot of slots)
        actions.push({label:`替换${slotName(slot)}`,run:()=>void this.changeEquipment(entry.id,slot)});
      else{
        const fallback=bag.slotsFor(entry.id,member.classId)[0];
        if(fallback)actions.push({label:'装备',run:()=>{},disabled:true});
      }
    }
    const forgeLabel=this.forgeLabel(entry);
    if(forgeLabel)actions.push({label:forgeLabel,run:()=>this.openForge(entry.id)});
    if(item.use&&!NON_MENU_USE_KINDS.has(item.use.kind)&&!worn)actions.push({label:item.use.kind==='learn'?'使用':USE_LABELS[item.use.kind],run:()=>this.beginOperation(entry.id),disabled:!!this.itemUseProblem(entry)});
    // 快捷键：与技能页同一套文案与同一屏。已配到任一组的这枚按钮改成「取消快捷键」，点了直接清掉
    // （原版 `UIEquip_ButtonRemoveShortCutExe 0x14c514` → `PLAYER_RemoveShortcutAll(char, 2, 物品编号)`）。
    if(item.shortcut&&!worn){
      const assigned=this.shortcutBar().assigned('item',entry.item);
      actions.push({label:assigned?'取消快捷键':'快捷键',
        run:()=>assigned?this.clearShortcut('item',entry.item):this.openShortcutScreen('item',entry.item)});
    }
    if(item.equipment)actions.push({label:entry.locked?'解锁':'上锁',run:()=>{
      bag.setLocked(entry.id,!entry.locked);
    }});
    if(item.discardable&&!worn)actions.push({label:'丢弃',disabled:!!entry.locked,run:()=>this.beginOperation(entry.id,'discard')});
    return actions;
  }
  /** 装备说明底部的入口文案：能力组合决定是强化、镶嵌还是净化。 */
  private forgeLabel(entry:ItemInstance):string|undefined {
    const equipment=this.session!.bag.catalog.items[entry.item].equipment;
    if(!equipment)return undefined;
    const sockets=entry.numbers?.sockets??equipment.socketCapacity;
    const canEnchant=equipment.enchantable,canSocket=sockets>0&&!equipment.locked,canPurify=!!entry.numbers?.chaos;
    if(canEnchant&&canSocket)return '强化/镶嵌';
    if(canEnchant)return '强化';
    if(canSocket)return '镶嵌';
    if(canPurify)return '净化';
    return undefined;
  }
  private openForge(targetId:string):void {
    const bag=this.session?.bag,target=bag?.get(targetId),equipment=target&&bag?bag.catalog.items[target.item].equipment:undefined;
    if(!bag||!target||!equipment||this.busy)return;
    this.cancelDrag();this.operation=undefined;this.itemNotice=undefined;this.notice='';
    this.selectedItem=targetId;
    const sockets=target.numbers?.sockets??equipment.socketCapacity;
    const tab:ForgeTab=equipment.enchantable?'enchant':sockets>0?'socket':target.numbers?.chaos?'purify':'enchant';
    const member=this.member();
    const preview=(id:string,modifiers:Modifier[])=>member?.previewGemChange(id,modifiers);
    this.forge=new ForgePanel(bag,this.app.menuPanels,this.app.characterStats,
      ()=>this.render(),()=>this.app.audio?.ui('enchant'),(message)=>this.app.ui.showInstant(message),preview);
    this.forge.open(targetId,tab);this.page='forge';this.render();
  }
  private closeForge():void {
    const targetId=this.forge?.targetId;
    this.forge=undefined;this.page='bag';if(targetId)this.selectedItem=targetId;this.render();
  }
  /** 技能书走独立页：图标网格选技能，右栏看等级变化，确认后才消耗。 */
  private openSkillBook(entry:string):void {
    const bag=this.session?.bag,instance=bag?.get(entry);
    if(!bag||!instance||this.busy)return;
    this.cancelDrag();this.operation=undefined;this.itemNotice=undefined;this.notice='';
    this.skillBook=new SkillBookPanel(bag,this.session!.skills,this.app.battleCatalog,this.app.menuPanels,entry,
      ()=>this.render(),()=>this.app.audio?.ui('select'),(message)=>this.closeSkillBook(message),
      (view,name,x,y,width,height)=>this.scroll(name,x,y,width,height,view),()=>this.menuText?.refresh());
    this.skillBook.open();this.page='learn';this.render();
  }
  private closeSkillBook(message?:string):void {
    this.skillBook=undefined;this.page='bag';this.selectedItem=undefined;this.notice=message??'';this.render();
  }
  private async changeEquipment(entry:string|undefined,slot:EquipmentSlot):Promise<void>{
    if(this.busy)return;this.busy=true;this.cancelDrag();const signal=this.request.signal;const started=performance.now();
    try{await this.app.changeEquipment!(entry,slot,signal,this.selectedMemberId);if(signal.aborted)return;this.selectedItem=undefined;this.notice='';}
    catch(error){if(!signal.aborted)this.notice=(error as Error).message;}finally{if(!signal.aborted){this.busy=false;this.render();globalThis.storyDiagnostics?.record('equipment-change-summary',{slot,member:this.selectedMemberId,elapsedMs:Math.round(performance.now()-started)});}}
  }
  private beginOperation(entry:string,kind:'use'|'discard'='use'):void{
    this.cancelDrag();
    const instance=this.session!.bag.get(entry)!;
    if(kind==='use'&&this.itemUseProblem(instance))return;
    const use=this.session!.bag.catalog.items[instance.item].use;
    // 技能书不弹确认框：独立页本身就承担选择与确认。
    if(kind==='use'&&use?.kind==='learn'){this.openSkillBook(entry);return;}
    // 神灯的动作按钮直接召唤一名地图商人。
    if(kind==='use'&&use?.kind==='merchant'){
      this.operation={entry,kind,quantity:1};this.confirmOperation();return;
    }
    // 回血药水与再生药水都走队伍结算：全队生效、共用一个时钟。
    if(kind==='use'&&(use?.kind==='recover-health'||use?.kind==='regenerate')){this.app.useRecoveryItem?.(entry,this.selectedMemberId);this.render();return;}
    if(kind==='use'&&use&&NON_MENU_USE_KINDS.has(use.kind))return;
    this.operation={entry,kind,quantity:1};this.scrollOffsets.delete('bag:operation');this.render();
  }
  private renderOperation():void{
    const v=this.modal!,box=tradeLayout.quantity,op=this.operation!,bag=this.session!.bag;
    const entry=bag.get(op.entry);if(!entry){this.operation=undefined;v.visible(false);return;}
    const item=bag.catalog.items[entry.item],use=item.use,inner=box.plate;
    // 先把正文排成内容块，量出真实高度；弹层高度因此跟着内容走，长说明不再被固定框裁掉。
    type Content={kind:'line';text:string;size:number}|{kind:'reward';item:string;quantity:number};
    const content:Content[]=[{kind:'line',text:item.name,size:25},{kind:'line',text:item.description||'确认后执行本次操作。',size:22}];
    let quantityRow=false;
    if(op.kind==='discard'){
      content.push({kind:'line',text:`确定丢弃 ${item.name}？`,size:22});
      quantityRow=entry.quantity>1;
    }
    else if(use?.kind==='pack'||use?.kind==='box'){
      content.push({kind:'line',text:use.kind==='pack'?'礼盒内含以下物品：':'获得下列物品中的一种：',size:22});
      for(const reward of use.rewards!)content.push({kind:'reward',...reward});
    }
    else if(use?.kind==='recipe'){
      content.push({kind:'line',text:'随机展开下列一种配方：',size:22});
      for(const id of use.recipes!)content.push({kind:'line',text:`${bag.catalog.recipes[id].name}${bag.learnedRecipes.includes(id)?' · 已收录':''}`,size:22});
    }
    else if(use?.kind==='recruit')content.push({kind:'line',text:`加入佣兵名册 · ${use.classId?this.app.storyClasses.classes.find(c=>c.id===use.classId)!.name:'随机职业'}`,size:22});
    else if(use?.kind==='revive'){
      const party=this.session!.party!;
      if(!party.livingIds.length){
        op.member=undefined;
        content.push({kind:'line',text:'全队阵亡时无法使用复活卷轴，请返回检查点或读取存档。',size:22});
      }else{
        const fallen=party.activeIds.filter(id=>!party.alive(id));
        op.member=fallen[0];
        const name=op.member==='player'?this.world!.actors[this.session!.campaign.start.actor].name:op.member?party.get(op.member)!.definition.name:undefined;
        content.push({kind:'line',text:name?`复活目标：${name}`:'当前没有阵亡的出战队员',size:22});
      }
    }
    else if(use?.kind==='reset-skills'){
      content.push({kind:'line',text:`确定为${this.world!.actors[this.session!.campaign.start.actor].name}初始化技能？`,size:22});
      content.push({kind:'line',text:'清空已学技能与快捷栏，返还正常加点；卓越灵药增加的技能点会消失。',size:22});
    }
    else if(entry.item===SKILL_POINT_ITEM)content.push({kind:'line',text:`确定对${this.world!.actors[this.session!.campaign.start.actor].name}使用${item.name}？`,size:22});
    if(op.error)content.push({kind:'line',text:op.error,size:22});

    // 仍用排版探针算换行高度，但不再创建可见的 Phaser 文字。
    const rewardText=(part:{item:string;quantity:number})=>`${bag.catalog.items[part.item].name} × ${part.quantity}`;
    const heights=content.map(part=>part.kind==='line'
      ?this.descriptionLayout(v,[{text:part.text,color:GOLD}],inner.width,part.size).height+13
      :Math.max(57,this.descriptionLayout(v,[{text:rewardText(part),color:GOLD}],inner.width-60,22).height+13));
    const textHeight=heights.reduce((sum,value)=>sum+value,0);
    // 内容区从黑底上沿再下 37 开始；数量行固定在底部按钮上方，正文只在它上面滚动。
    const quantitySpace=quantityRow?60:0;
    const height=Math.min(600,Math.max(box.height,inner.y+37+textHeight+quantitySpace+12+box.button.height+20));
    this.beginModal(box.width,height);v.visible(true);
    // 与商店的数量框同一个原版弹层：同样的图组 19 外框，同样的内缩 35 黑底。
    drawPopupPanel(v,this.app.menuPanels.assets,box.width,height);
    const buttonY=height-75,quantityTop=buttonY-12-48,textTop=inner.y+37,textBottom=(quantityRow?quantityTop:buttonY)-12;
    const scroll=this.scroll('operation',inner.x,textTop,inner.width,Math.max(0,textBottom-textTop),v);
    this.operationTextSpecs=[];const specs=this.operationTextSpecs;
    const clip={top:textTop,bottom:textBottom};
    let y=0,serial=0;
    const key=()=>`operation-${serial++}`;
    content.forEach((part,index)=>{
      if(part.kind==='line')specs.push({key:key(),text:part.text,x:inner.x,y:textTop+y,
        style:{size:part.size,color:GOLD,width:inner.width,wrap:'word'},scroll:'operation',clip});
      else{
        v.image(bag.catalog.items[part.item].icon,0,y,44,44,scroll.content);
        specs.push({key:key(),text:rewardText(part),x:inner.x+60,y:textTop+y+6,
          style:{size:22,color:GOLD,width:inner.width-60,wrap:'word'},scroll:'operation',clip});
      }
      y+=heights[index]!;
    });
    this.finishScroll('operation',scroll,textHeight);

    specs.push({key:'operation-title',text:op.kind==='discard'?'丢弃物品':USE_LABELS[use!.kind],
      x:inner.x,y:inner.y+5,style:{size:26,color:GOLD,width:inner.width,wrap:'word'}});
    if(quantityRow){
      const quantityButton=(label:string,x:number,width:number,action:()=>void)=>
        v.button('',x,quantityTop,width,48,action,{guard:scroll.guard}).setData('label',label);
      quantityButton('减少数量',inner.x,80,()=>{op.quantity=Math.max(1,op.quantity-1);this.render();});
      quantityButton('增加数量',inner.x+190,80,()=>{op.quantity=Math.min(entry.quantity,op.quantity+1);this.render();});
      quantityButton('全部',inner.x+260,inner.width-260,()=>{op.quantity=entry.quantity;this.render();});
      const centerY=quantityTop+24;
      specs.push({key:key(),text:'−',x:inner.x+40,y:centerY,
        style:{size:20,color:GOLD,width:68,align:'center',wrap:'word',anchorX:.5,anchorY:.5}});
      specs.push({key:key(),text:String(op.quantity),x:inner.x+135,y:quantityTop+8,
        style:{size:24,color:GOLD,anchorX:.5}});
      specs.push({key:key(),text:'＋',x:inner.x+230,y:centerY,
        style:{size:20,color:GOLD,width:68,align:'center',wrap:'word',anchorX:.5,anchorY:.5}});
      specs.push({key:key(),text:'全部',x:inner.x+260+(inner.width-260)/2,y:centerY,
        style:{size:20,color:GOLD,width:inner.width-272,align:'center',wrap:'word',anchorX:.5,anchorY:.5}});
    }

    const using=op.kind==='use',revivalBlocked=using&&use?.kind==='revive'&&!op.member;
    const disabled=op.confirmed||this.busy||(using&&!!this.itemUseProblem(entry))||revivalBlocked;
    // 底部按钮沿用原版数量框的排布：确定在左、取消在右，125×55。
    const modalButton=(label:string,x:number,action:()=>void,isDisabled=false)=>{
      v.button('',x,buttonY,box.button.width,box.button.height,action,{disabled:isDisabled}).setData('label',label);
      specs.push({key:key(),text:label,x:x+box.button.width/2,y:buttonY+box.button.height/2,
        style:{size:Math.min(22,box.button.height*.42),color:GOLD,anchorX:.5,anchorY:.5,
          width:box.button.width-12,align:'center',wrap:'word'}});
    };
    modalButton('取消',box.button.right,()=>{this.operation=undefined;this.render();});
    modalButton('确定',box.button.left,()=>this.confirmOperation(),!!disabled);
  }
  private itemUseProblem(entry:ItemInstance):string|undefined{
    const definition=this.session!.bag.catalog.items[entry.item];
    // 用途还没逆出来的物品不开使用菜单，免得点下去只是白丢一件。
    const unimplemented=unimplementedItemUse(entry.item,definition);
    if(unimplemented)return unimplemented;
    const kind=definition.use?.kind;
    if(this.selectedMemberId!=='player'&&(kind==='reset-skills'||kind==='learn'||entry.item===SKILL_POINT_ITEM))return '该道具仅能用于主角';
  }
  private renderItemResult():void {
    // 与说明面板同一套矩形，免得看结果时又跳回旧位置。
    const v=this.description!,layout=bagLayout(),covered=this.descSide==='left'?layout.leftFrame:layout.bagFrame,
      panel=descriptionPanel(this.descSide==='left'?covered.width:BAG_DESCRIPTION_WIDTH),left=covered.x,top=panel.y;
    // 结果面板同样完全不透明：先铺整块透明拦截层，避免点击穿透到被盖住的格子。
    v.rect(left,top,panel.width,panel.height,0x000000,0).setInteractive();
    drawDescriptionPanel(v,this.app.menuPanels.assets,left,top,panel.width);
    // 同物品说明：滚动区也建在说明层上，否则正文会被面板底色压暗。
    const detail=this.scroll('item',left+panel.scroll.x,top+panel.scroll.y,panel.scroll.width,panel.scroll.height,v);let y=0;
    const scrollX=left+panel.scroll.x,scrollY=top+panel.scroll.y,
      clip={top:scrollY,bottom:scrollY+panel.scroll.height};
    itemResultDetails(this.itemResult,this.session!.bag.catalog,
      id=>this.app.battleCatalog.skills[id]?.name??id,id=>this.app.storyClasses.classes.find(c=>c.id===id)?.name??id)
      .forEach((line,index)=>{
        const layout=this.descriptionLayout(v,[{text:line,color:GOLD}],panel.scroll.width,22);
        this.pushDescriptionText(this.bagDetailTextSpecs,`item-result-${index}`,layout,scrollX,scrollY,panel.scroll.width,22,
          'item',clip,y);
        y+=layout.height+5+13;
      });
    this.finishScroll('item',detail,y);
    drawDescriptionClose(v,this.app.menuPanels.assets,panel,left,top,()=>{this.itemResult=undefined;this.render();});
  }
  private async confirmOperation():Promise<void>{
    const op=this.operation;if(!op||op.confirmed||this.busy)return;const bag=this.session!.bag,entry=bag.get(op.entry);if(!entry)return;
    op.confirmed=true;this.busy=true;
    const signal=this.request.signal;
    try{
      if(op.kind==='use'){const problem=this.itemUseProblem(entry);if(problem)throw new Error(problem);}
      const kind=bag.catalog.items[entry.item].use?.kind;
      this.itemResult=undefined;
      if(op.kind==='discard')bag.discard(op.entry,op.quantity);
      else if(kind==='recruit'){
        const {member}=this.session!.party!.recruit(op.entry);
        this.operation=undefined;this.selectedItem=undefined;this.page='party';this.partyPanel!.select(member.id);
        // 招募后先把整套外观拼好；上阵时直接复用，失败则等战斗开场重试。
        void this.app.preparePartyMember?.(member.id,undefined,{full:true,pin:true}).catch(()=>{});
      }else if(kind==='revive'){
        const target=op.member!;
        if(this.app.revivePartyMember)this.app.revivePartyMember(target,op.entry);else{
          const session=this.session!,party=session.party!,fallen=party.activeIds.filter(id=>!party.alive(id));
          party.revive(target,op.entry);
          for(const id of fallen)if(party.alive(id))session.reviveCombatActor(id);
        }
      }else if(kind==='merchant'){
        if(!this.app.summonLampMerchant)throw new Error('当前地图无法召唤商人');
        await this.app.summonLampMerchant(op.entry,signal);
        signal.throwIfAborted();this.busy=false;this.close();return;
      }else{
        this.itemResult=bag.use(op.entry);
      }
      this.selectedItem=bag.get(op.entry)?op.entry:undefined;
      this.operation=undefined;
    }
    catch(error){if(signal.aborted)return;op.error=(error as Error).message;op.confirmed=false;}finally{if(!signal.aborted)this.busy=false;}this.render();
  }
  private startDrag(pointer:UiPointer,entry:string,scroll:ScrollArea):void{
    if(this.busy||this.operation||this.itemNotice||!scroll.contains(pointer))return;this.cancelDrag();this.suppressClick=false;
    const timer=this.scene!.time.delayedCall(350,()=>{
      if(!this.drag||this.app.ui.suspended)return;
      this.suppressClick=true;this.drag.active=true;scroll.cancelGesture();
      this.selectedItem=undefined;this.itemResult=undefined;this.render();
      const item=this.session!.bag.catalog.items[this.session!.bag.get(entry)!.item];
      this.drag.ghost=new UiImage(this.scene!,undefined,item.icon).setPosition(pointer.x,pointer.y).setDisplaySize(72*this.surface!.root.scaleX,72*this.surface!.root.scaleY).setAlpha(.8).setDepth(800);
    });
    this.drag={entry,pointer:pointer.id,x:pointer.x,y:pointer.y,timer,active:false};
  }
  private moveDrag(pointer:UiPointer):void{const drag=this.drag;if(!drag||drag.pointer!==pointer.id)return;if(!drag.active&&Math.hypot(pointer.x-drag.x,pointer.y-drag.y)>8*this.surface!.root.scaleX)this.cancelDrag();else if(drag.active)drag.ghost?.setPosition(pointer.x,pointer.y);}
  private endDrag(pointer:UiPointer):void{
    const drag=this.drag;if(!drag||drag.pointer!==pointer.id)return;
    if(!drag.active){this.cancelDrag();return;}
    const target=this.drops.find(drop=>drop.object.getBounds().contains(pointer.x,pointer.y)&&drop.entry!==drag.entry&&(drop.slot||drop.craft||this.body!.scrolls.some(scroll=>scroll.contains(pointer))));
    this.suppressClick=true;this.cancelDrag();if(!target)return;
    const bag=this.session!.bag,entry=bag.get(drag.entry);if(!entry)return;
    const item=bag.catalog.items[entry.item];
    if(target.craft&&this.craftingPanel)this.craftingPanel.select(drag.entry);
    else if(target.view!==undefined&&target.cell!==undefined)this.dropOnCell(drag.entry,target.view,target.cell);
    else if(item.equipment&&target.slot){
      // 不能穿的拖放直接作废：职业、锁定、等级与副手规则共用同一份判定，不再弹通用错误文案。
      const member=this.member();
      if(!member||bag.equipProblem(drag.entry,target.slot,this.selectedMemberId,member.classId,member.level)!==undefined)return;
      void this.changeEquipment(drag.entry,target.slot);
    }
  }
  /**
   * 拖到某个格子。原版 `UIEquip_InvenItemControlEventProc @0x149f28` 把来源格清空、目标格原有物品写回来源格：
   * 空格就是搬过去、原格留空，有物品就是交换，只改变当前页面的排列。
   */
  private dropOnCell(id:string,view:InventoryView,cell:number):void{
    this.action(()=>{
      if(this.session!.bag.placeInCell(id,view,cell))this.app.audio?.ui('itemMove');   // 原版也是移动成功才出声
    });
  }
  private cancelDrag():void{this.drag?.timer.remove();this.drag?.ghost?.destroy();this.drag=undefined;}
  private selectMember(id:string,page:Page):void{
    if(this.requestAllocationExit(()=>this.selectMember(id,page)))return;
    const restoreBag=this.bagDetailOpen&&!!this.selectedItem&&!this.itemResult;
    const resultBag=this.bagDetailOpen&&!!this.itemResult;
    const updateBag=this.open&&page==='bag'&&this.page==='bag'&&(restoreBag||resultBag||!this.bagDetailOpen&&this.bagEquipment.size>0);
    const updateStatus=this.open&&page==='status'&&this.page==='status'&&!!this.statusPortrait?.active;
    const updateSkills=this.open&&page==='skills'&&this.page==='skills'&&this.skillTabs.size>0;
    this.cancelOperation();this.selectedMemberId=id;this.selectedItem=undefined;this.skill=undefined;this.skillSection='directory';
    if(updateBag||updateStatus||updateSkills){if(updateBag){if(restoreBag)this.closeBagDetailForMember();if(resultBag){this.bagSelection?.destroy();this.bagSelection=undefined;}this.updateBagMember();}else if(updateStatus)this.updateStatusMember();else this.updateSkillsMember();this.sessionSignature=this.sessionDataSignature()??this.sessionSignature;}else this.show(page);
    const signal=this.request.signal;
    void this.app.preparePartyMember?.(id,signal).then(()=>{
      if(!signal.aborted&&this.open&&this.page==='bag'&&this.selectedMemberId===id)this.renderBagPreview();
    })
      .catch(error=>{if(!signal.aborted&&this.open&&this.selectedMemberId===id){this.notice=(error as Error).message;this.menuText?.renderPage(this.page);}});
  }
  private updateSkillsMember():void{
    const v=this.body!;
    for(const node of this.skillContentNodes)node.destroy();this.skillContentNodes=[];
    for(const [name,scroll] of this.scrollNames){
      this.scrollOffsets.set(`skills:${name}`,scroll.scrollTop);scroll.destroy();
      const index=v.scrolls.indexOf(scroll);if(index>=0)v.scrolls.splice(index,1);
    }
    this.scrollNames.clear();v.pruneDestroyed();this.keyboardFocus=undefined;this.skillTextSpecs=[];
    for(const [section,button] of this.skillTabs)button.getData('setEnabled')?.(section==='directory'||!!this.session!.party&&(section!=='settings'||this.selectedMemberId==='player'));
    this.renderSkillContent();this.menuText?.renderPage('skills');
  }
  private updateStatusMember():void{
    const member=this.member()!,actor=this.actor(),panels=this.app.menuPanels,character=this.app.storyClasses.classes.find(value=>value.id===member.classId)!;
    if(this.statusRightAdjusting!==this.adjusting){
      for(const node of this.statusRightNodes)node.destroy();this.body!.pruneDestroyed();
      this.statusTextSpecs=this.statusTextSpecs.filter(spec=>!spec.key.startsWith('attribute-')&&!spec.key.startsWith('combat-')&&spec.key!=='stat-points'&&spec.key!=='reset-attributes');
      this.renderStatusRight();
    }
    const text=(key:string,value:string)=>{const spec=this.statusTextSpecs.find(spec=>spec.key===key);if(spec)spec.text=value;};
    const art=this.memberArt().image;if(this.statusPortrait?.getData('file')!==art)this.statusPortrait?.load(art);
    text('level',`等级 ${member.level}`);text('class',character.name);text('name',actor.name);
    for(const kind of ['health','mana','experience'] as const){
      const player=member.player,value=player[kind],max=kind==='experience'?player.nextLevelExperience:kind==='health'?player.maxHealth:player.maxMana;
      const ratio=kind==='experience'&&max===0?1:max>0?Math.max(0,Math.min(1,value/max)):0,width=223*ratio,view=this.statusResources.get(kind);
      text(`resource-${kind}-value`,max===0?'已满级':`${value} / ${max}`);text(`resource-${kind}-percent`,`${Math.floor(ratio*100)}%`);
      if(view){view.fill.setCrop(0,0,view.fill.width*ratio,view.fill.height).setVisible(width>0);view.start.setVisible(width>0);view.end.setX(178+Math.max(0,width-7)).setVisible(width>0);}
    }
    character.attributes.forEach((attribute,index)=>{const stat=PRIMARY_STATS[index];text(`attribute-${stat}-name`,attribute.name);text(`attribute-${stat}-value`,String(member.panel.attributes[stat]));});
    const hero='source' in member&&member.source!=='mercenary'?undefined:member;
    text('stat-points',`${panels.character.labels.statPoints} ${hero?.statPoints??0}`);
    this.statusAdjustButton?.getData('setEnabled')?.(!!hero);
    this.statusCombatValues(member).forEach((value,index)=>text(`combat-${index}-value`,value));
    this.menuText?.renderPage('status');this.sync();
  }
  private statusCombatValues(member:NonNullable<ReturnType<StoryUI['member']>>):string[]{
    const equipped=member.bag.equipmentItems(member.bag.equipmentFor(this.selectedMemberId)),items=this.session!.bag.catalog.items,main=equipped['main-hand'];
    const modifiers=memberCombatModifiers({catalog:this.app.battleCatalog,classId:member.classId,loadout:this.configuration().draft(this.app.battleCatalog,member.classId),
      weaponKind:main?items[main]?.kind??'unarmed':'unarmed',armorKind:equipped.body?items[equipped.body].kind:'',health:member.player.health,maxHealth:member.player.maxHealth,
      groupEffects:this.session!.party?.groupModifiers()??{},growth:memberSkillGrowth(this.selectedMemberId),stealthed:this.app.combatStealthed?.(this.selectedMemberId)??false});
    const combatAttribute=this.app.combatAttribute,resolve=combatAttribute?(key:string,base:number)=>combatAttribute(this.selectedMemberId,key as BattleStatKey,base,modifiers):undefined;
    return characterCombatValues(effectiveCharacterPanel(member.panel,member.level,modifiers,resolve));
  }
  private clearBagEquipment():void{
    this.bagPortrait?.detach();
    const drops=new Set<unknown>([...this.bagEquipment.values()].map(view=>view.drop));
    for(const view of this.bagEquipment.values())view.button.destroy();
    this.drops=this.drops.filter(drop=>!drops.has(drop));
    this.bagEquipment.clear();this.bagPreview?.destroy();this.bagPreview=undefined;
    this.body?.pruneDestroyed();
  }
  private renderBagEquipment():void{
    const v=this.body!,bag=this.session!.bag,panels=this.app.menuPanels,member=this.member()!,equipment=bag.equipmentFor(this.selectedMemberId);
    this.bagPreview=v.container(0,0);this.renderBagPreview();
    for(const slot of panels.equipmentSlots){
      const id=slot.id as EquipmentSlot,entry=equipment[id],instance=entry?bag.get(entry):undefined,item=instance?bag.catalog.items[instance.item]:undefined;
      const button=v.button('',85+slot.x,slot.y,74,74,()=>{const current=bag.equipmentFor(this.selectedMemberId)[id];if(current)this.selectItem(current,'right');},{image:slotFrameImage(this.app,this.session!,instance)});
      const icon=v.image(item?.icon??slot.emptyIcon,item?5:13,item?5:13,item?64:48,item?64:48,button);button.setData('label',slot.name);
      updateEquipmentLock(v,button,!!instance?.locked);
      const drop={object:button,entry,slot:id};this.drops.push(drop);this.bagEquipment.set(id,{button,icon,drop});
    }
    this.bagTextSpecs.push({key:'bag-level',text:`Lv. ${member.level}　${this.app.storyClasses.classes.find(c=>c.id===member.classId)!.name}`,
      x:292,y:375,style:{size:22,color:TEXT_COLORS.primary,anchorX:.5,anchorY:0}});
  }
  private closeBagDetailForMember():void{
    const coversEquipment=this.descSide==='left';
    this.bagDetailOpen=false;this.bagDetailTextSpecs=[];this.bagSelection?.destroy();this.bagSelection=undefined;
    this.description?.clear();
    for(const [name,scroll] of this.scrollNames)if(scroll.surface===this.description)this.scrollNames.delete(name);
    if(coversEquipment){
      this.bagTextSpecs=this.bagTextSpecs.filter(spec=>spec.key!=='bag-level');
      this.clearBagEquipment();this.renderBagEquipment();return;
    }
    const bag=this.session!.bag,layout=bagLayout(),cells=layout.grid,clip={top:cells.y,bottom:cells.y+cells.height};
    const {slots}=inventoryView({all:bag.allCells,...bag.pouchCells},this.filter);
    slots.forEach((slot,index)=>{
      if(slot.kind!=='item')return;
      const entry=slot.entry,item=bag.catalog.items[entry.item],x=index%cells.columns*cells.stride,y=Math.floor(index/cells.columns)*cells.stride,key=`bag-slot-${slot.view}-${slot.cell}`;
      if(item.stackable)this.bagTextSpecs.push({key:`${key}-quantity`,text:String(entry.quantity),x:cells.x+x+layout.badge.x,y:cells.y+y+layout.badge.y,style:{size:20,color:layout.badge.color,anchorX:1,anchorY:0},scroll:'inventory',clip});
      if(entry.enhancement)this.bagTextSpecs.push({key:`${key}-enhancement`,text:`+${entry.enhancement}`,x:cells.x+x+2,y:cells.y+y+2,style:{size:17,anchorX:0,anchorY:0},scroll:'inventory',clip});
      if(entry.gems.length)this.bagTextSpecs.push({key:`${key}-gems`,text:'◆'.repeat(entry.gems.length),x:cells.x+x+2,y:cells.y+y+52,style:{size:16,anchorX:0,anchorY:0},scroll:'inventory',clip});
    });
    const money=splitMoney(this.session!.money);
    (['gold','silver','copper'] as const).forEach((unit,index)=>this.bagTextSpecs.push({key:`bag-money-${unit}`,text:String(money[unit]),x:layout.money.x+index*layout.money.stride+layout.money.digit.x,y:layout.money.y+layout.money.digit.y,style:{size:20,color:layout.money.color,anchorX:0,anchorY:0}}));
  }
  private updateBagMember(refreshPreview=true,renderText=true):void{
    const member=this.member()!,bag=this.session!.bag,equipment=bag.equipmentFor(this.selectedMemberId),panels=this.app.menuPanels;
    for(const slot of panels.equipmentSlots){
      const id=slot.id as EquipmentSlot,view=this.bagEquipment.get(id);if(!view)continue;
      const entry=equipment[id],instance=entry?bag.get(entry):undefined,item=instance?bag.catalog.items[instance.item]:undefined;
      const face=view.button.getData('face') as UiImage|undefined,frame=slotFrameImage(this.app,this.session!,instance),icon=item?.icon??slot.emptyIcon;
      if(face&&face.getData('file')!==frame)face.load(frame);
      if(view.icon.getData('file')!==icon)view.icon.load(icon);
      const offset=item?5:13,size=item?64:48;
      if(view.icon.x!==offset)view.icon.setPosition(offset,offset);
      if(view.icon.width!==size||view.icon.height!==size)view.icon.resize(size,size);
      updateEquipmentLock(this.body!,view.button,!!instance?.locked);
      view.drop.entry=entry;
    }
    const level=this.bagTextSpecs.find(spec=>spec.key==='bag-level');
    if(level)level.text=`Lv. ${member.level}　${this.app.storyClasses.classes.find(c=>c.id===member.classId)!.name}`;
    this.bagMemberId=this.selectedMemberId;
    if(refreshPreview)this.renderBagPreview();
    if(renderText)this.menuText?.renderPage('bag');
  }
  private renderBagPreview():void{
    const v=this.body, parent=this.bagPreview, member=this.member();
    if(!v||!parent?.active||!member||!this.scene)return;
    parent.removeAll(true);
    const preview=bagLayout().preview,appearance=this.app.equipmentAppearance?.(this.selectedMemberId);
    if(appearance&&this.bagPortrait&&LiveCharacterPreview.available(this.scene,appearance)){
      this.bagPortrait.show(v,appearance,preview);
    }else{
      this.bagPortrait?.detach();
      const art=this.memberArt(),panels=this.app.menuPanels;
      v.imageContain(this.selectedMemberId==='player'?panels.classes[member.classId].preview:art.partyIcon,preview.x,preview.y,preview.width,preview.height,parent);
    }
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
  private action(action:()=>void):void{if(this.busy)return;this.busy=true;try{action();}catch(error){this.notice=(error as Error).message;}finally{this.busy=false;}if(this.open)this.render();}
  private renderParty():void{
    this.partyPanel?.render(this.body!,this.modal!,this.placeModal);
  }
  private renderQuests():void{
    this.questPanel?.render(this.body!);
  }
}
