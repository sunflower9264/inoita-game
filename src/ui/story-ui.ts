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
import { SLOT_ICON_SIZE, ITEM_ICON_SIZE, PENDING_OFFSET, controlPlacement } from './phaser/action-controls.ts';
import { AttributeAllocation } from '../domain/attribute-allocation.ts';
import { effectiveCharacterPanel, PRIMARY_STATS, type Modifier, type PrimaryStat } from '../domain/character-stats.ts';
import { memberCombatModifiers } from '../domain/party-combat.ts';
import { memberArt as memberArtwork } from '../domain/menu-panels.ts';
import { characterCombatValues } from './character-values.ts';
import type { StoryUIContext } from '../application/ports.ts';
import type { Session } from '../domain/session.ts';
import type { ActorDefinition, WorldIndex } from '../domain/content.ts';
import type { StoryInterface } from '../domain/story-interface.ts';
import type { CompanionMember } from '../domain/party.ts';
import type { BattleClass, SkillLoadout } from '../domain/battle.ts';
import type { StorySkillProgression } from '../domain/story-skills.ts';
import { COUNTERATTACK_MODES } from '../domain/party-ai.ts';
import { ShopPanel } from './phaser/shop-panel.ts';
import { Storefront } from '../domain/shop.ts';
import { QuestPanel } from './phaser/quest-panel.ts';
import { PartyPanel } from './phaser/party-panel.ts';
import { inventoryView,INVENTORY_LABELS,INVENTORY_SIDE_FILTERS,type InventoryView } from '../domain/inventory.ts';
import { EQUIPMENT_SLOTS,SKILL_POINT_ITEM,USE_LABELS,unimplementedItemUse,type EquipmentSlot,type ItemInstance,type ItemResult } from '../domain/items.ts';
import { GmPanel } from './phaser/gm-panel.ts';
import type { GmActions } from '../debug/gm-actions.ts';
import { readSafeArea, uiUnitScale } from './viewport.ts';
import { ControlLayoutEditor } from './phaser/control-layout-editor.ts';
import { KeyBindingEditor } from './phaser/key-binding-editor.ts';
import { HUD_SIDE_BUTTON_SIZE, resolveControlLayout, type ControlId } from './control-layout.ts';
import { controlViewport } from './phaser/control-layout-viewport.ts';
import { UiSurface, uiImageFor, type ScrollArea } from './phaser/widgets.ts';
import { drawDescriptionClose, drawDescriptionPanel, drawDescriptionRows, drawDescriptionSeparator, drawDescriptionTitle } from './phaser/description-panel.ts';
import { drawNativeMessage } from './phaser/native-message.ts';
import { AUTO_SAVE_SLOT, MANUAL_SAVE_SLOT_COUNT, captureSaveGame, saveSlotLabel, saveSummary, sessionClassId, type SaveGame, type SaveSlotRef } from '../domain/save-game.ts';
import { SAVE_BOARD, SAVE_BOARD_LAYOUT, drawSaveBoardRow, newestFirstSlots, saveBoardOrigin, saveRowTitle, type SaveBoardRow } from './phaser/save-board.ts';
import { TextPrompt } from './text-prompt.ts';
import type { SaveWorldReason, StoryWorldViewSnapshot } from '../scenes/world-scene.ts';
import { drawPopupPanel } from './phaser/popup-panel.ts';
import { drawRoundBand } from './phaser/round-band.ts';
import { drawSolidBorder } from './phaser/solid-border.ts';
import { centerModal } from './phaser/modal-placement.ts';
import { itemResultDetails } from './item-result-details.ts';
import { itemDescriptionBody } from './item-detail-lines.ts';
import { slotFrameImage } from './slot-frame.ts';
import { bagLayout, BAG_DESCRIPTION_WIDTH, DESCRIPTION_PANEL, descriptionPanel, SIDE_FILTER_TEXT_SIZE } from './bag-layout.ts';
import { skillDescriptionParts, skillLearningParts, skillNextLevelPreview } from './skill-detail-lines.ts';
import { drawDescriptionText } from './phaser/description-text.ts';
import { tradeLayout } from './shop-layout.ts';
import { splitMoney } from '../domain/money.ts';
import { createCharacter, type CharacterVisual } from '../rendering/characters.ts';

type Page='status'|'bag'|'skills'|'party'|'quests'|'system'|'save'|'load'|'settings'|'shop'|'crafting'|'forge'|'debug';
const tabs:[Page,string][]=[['status','人物'],['bag','背包'],['skills','技能'],['party','队伍'],['quests','任务'],['system','系统']];
/** 设置页「操作方式」一行上显示的当前选择。 */
const CONTROL_MODE_LABELS:Record<ControlMode,string>={stick:'虚拟摇杆',dpad:'十字按键',keyboard:'电脑模式'};
/** 原版按档位索引取 [9,8,7] 三张按钮图，0/1/2 依次对应。 */
/** 原版菜单里正文与数值的米色：进绘制前调 `GRPX_SetFontColorFromRGB(0xe2,0xcb,0x9e)`。 */
const AREA_TEXT='#e2cb9e';
const SKILL_LEVEL_ASSETS=['skill-level-none','skill-level-normal','skill-level-high'];
/** 自动反击三档的原版名称，用作焦点与读屏标签。 */
const COUNTERATTACK_LABELS=['未启用','延迟','启用'];
/** 登记快捷键那一屏顶部的提示，原版取文本表第 35462 条。 */
const SHORTCUT_PROMPT='请选择要设置的快捷键。';
/** 存档结果与「不能存取」的提示文本，原版取文本表 35331／35332／35342 条。 */
const SAVE_DONE='保存成功',SAVE_FAILED='保存失败',SAVE_UNAVAILABLE='在当前的地图中无法进行存档。';
const SAVE_UNAVAILABLE_DEBUG='调试现场不能存档，请先在调试面板点「结束本次调试」。';
const SAVE_UNAVAILABLE_LOADING='地图正在载入，请稍后再存档。';
const saveUnavailableNotice=(reason:SaveWorldReason):string=>reason==='debug'?SAVE_UNAVAILABLE_DEBUG
  :reason==='loading'?SAVE_UNAVAILABLE_LOADING:SAVE_UNAVAILABLE;
/** 菜单内容块的固定原点；说明层与内容块共用同一坐标。 */
const CONTENT_ORIGIN={x:32,y:172} as const;
/** 这些使用方式走独立操作面板，不出现在背包的「使用」菜单里。 */
const NON_MENU_USE_KINDS=new Set(['enchant','socket','purify']);
interface Operation {entry:string;kind:'use'|'discard';member?:string;skill?:string;quantity:number;confirmed?:boolean;error?:string}
interface BagMenuAction {label:string;run:()=>void;disabled?:boolean}
/** 正式菜单读取 Session，操作仍由背包、技能、队伍和商店领域对象执行。 */
export class StoryUI {
  private readonly app:StoryUIContext;
  /** GM 面板按当前的动作层实例缓存；换会话（动作层重建）时一起换掉。 */
  private gmPanel?:GmPanel;
  private gmPanelOwner?:GmActions;
  private minimapHeight=132;
  private scene?:Phaser.Scene;private surface?:UiSurface;private body?:UiSurface;private hudButtons?:UiSurface;private modal?:UiSurface;private description?:UiSurface;
  /** 登记快捷键那一屏单独一层：它盖在遮罩上，菜单本体整块藏起来。 */
  private shortcutScreen?:UiSurface;
  private controlEditor?:ControlLayoutEditor;
  private keyBindingEditor?:KeyBindingEditor;
  /** 左上角圆形关闭钮单独一层：不随 960 内容区居中，靠安全区左上角摆放。 */
  private backTab?:UiSurface;
  private shortcutEdit?:{kind:ShortcutEntry['kind'];id:string;page:number};
  private backdrop?:Phaser.GameObjects.Rectangle;
  private session?:Session;private world?:WorldIndex;private content?:StoryInterface;private unsubscribe?:()=>void;private unsubscribeFullscreen?:()=>void;
  /** 菜单是否打开；诊断用，和 `locked` 里的 `story-menu` 对应。 */
  get menuOpen():boolean{return this.open;}
  private page:Page='bag';private open=false;private selectedMemberId='player';private questPanel?:QuestPanel;
  private itemResult?:ItemResult;
  private filter:InventoryView='all';private selectedItem?:string;private descSide:'left'|'right'='left';private operation?:Operation;private itemNotice?:string;private busy=false;private request=new AbortController();
  /** 上次整页重绘时当前页依赖的数据签名；会话通知用它判断要不要重绘。 */
  private sessionSignature='';
  /** 当前弹层的框尺寸，由打开它的对话框声明；初值只是没有对话框时的兜底。 */
  private modalBox={width:450,height:350};
  private modalActive=false;
  private readonly placeModal=(width:number,height:number):void=>this.beginModal(width,height);
  private skill?:string;private skillSection:'directory'|'ai'|'settings'='directory';private skillReset=false;private adjusting=false;
  /** 覆盖已有存档的确认：停在哪个槽上。保存本身不可逆，所以先问一次。 */
  private saveConfirm?:SaveSlotRef;
  private loadConfirm?:SaveSlotRef;
  /** 删除存档的确认；删除不可撤销，所以走原版是／否横带。 */
  private deleteConfirm?:SaveSlotRef;
  /** 改名输入框打开时停在哪个槽上；开着的时候整个菜单不吃输入。 */
  private renameRef?:SaveSlotRef;
  private prompt?:TextPrompt;
  private allocation?:AttributeAllocation;private allocationExit?:()=>void;private allocationError='';
  /** 能力加点按钮的长按连发；每次重画都会换按钮，所以只记指针和这一步要加的属性。 */
  private allocationHold?:Phaser.Time.TimerEvent;
  private craftingPanel?:CraftingPanel;private craftingActor?:string;private forge?:ForgePanel;
  private shopPanel?:ShopPanel;private partyPanel?:PartyPanel;private notice='';
  private keyboardFocus?:Phaser.GameObjects.Container;
  /**
   * 背包页那颗合成立绘。它按当前角色和身上装备拼出来，换人、换装备才重做；
   * 翻物品、点格子引起的重画直接搬回来用——每次重建一批精灵正是背包卡顿的一大来源。
   */
  private bagPortrait?:{actor:ActorDefinition;visual:CharacterVisual};
  private scrollOffsets=new Map<string,number>();private scrollNames=new Map<string,ScrollArea>();
  private drag?:{entry:string;pointer:number;x:number;y:number;timer:Phaser.Time.TimerEvent;active:boolean;ghost?:Phaser.GameObjects.Image};private suppressClick=false;
  private drops:{object:Phaser.GameObjects.Container|Phaser.GameObjects.Image;entry?:string;slot?:EquipmentSlot;view?:InventoryView;cell?:number;craft?:boolean}[]=[];
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
  attach(scene:Phaser.Scene):void{
    this.scene=scene;this.surface=new UiSurface(scene,1024,640,100);this.body=new UiSurface(scene,960,431,200);this.surface.root.add(this.body.root);this.body.root.setPosition(CONTENT_ORIGIN.x,CONTENT_ORIGIN.y);
    // 交易弹层的画布按原版数量框的 450×350 建立，确认框在其中垂直居中。
    this.modal=new UiSurface(scene,450,350,400);this.modal.root.setPosition(287,145);
    // 改名用系统键盘：DOM 输入框盖在画布上，菜单这一层在它打开时整体让出输入。
    this.prompt=new TextPrompt();
    // 说明面板单独一层，深度高于内容块的滚动层（`ScrollArea` 的 Layer 取父画布深度 +1）。
    // 停在右栏时它压在背包格子上，画在内容块里会被那一层整个盖住，底色和边框都看不见。
    // 它不挂在 surface 下面，所以位置与缩放要跟着 surface 自己同步（见 `layout`）。
    this.description=new UiSurface(scene,960,431,300);
    // 登记快捷键那一屏按原版的 960×640 全屏坐标摆控件，深度压在遮罩之上、菜单之下。
    this.shortcutScreen=new UiSurface(scene,960,640,150);this.backTab=new UiSurface(scene,960,640,160);
    this.shortcutScreen.enabled=()=>this.open&&!this.app.ui.suspended&&!this.busy&&!!this.shortcutEdit;
    this.backTab.enabled=()=>this.shortcutScreen!.enabled();
    this.hudButtons=new UiSurface(scene,960,640,50);this.backdrop=scene.add.rectangle(0,0,1,1,0x000000,.65).setOrigin(0).setDepth(99).setInteractive();
    this.surface.enabled=()=>this.open&&!this.app.ui.suspended&&!this.busy&&!this.app.ui.controlLayoutEditing&&!this.app.ui.keyBindingEditing&&!this.shortcutEdit&&!this.operation&&!this.itemNotice&&!this.allocationExit&&!this.skillReset&&this.saveConfirm===undefined&&this.loadConfirm===undefined&&this.deleteConfirm===undefined&&this.renameRef===undefined&&!this.craftingPanel?.modalOpen&&!this.shopPanel?.modalOpen&&!this.partyPanel?.modalOpen&&!this.forge?.confirming;
    this.body.enabled=()=>this.surface!.enabled();this.description.enabled=()=>this.body!.enabled();
    this.modal.enabled=()=>this.open&&!this.app.ui.suspended&&!this.busy&&(!!this.operation||!!this.itemNotice||!!this.allocationExit||this.skillReset||this.saveConfirm!==undefined||this.loadConfirm!==undefined||this.deleteConfirm!==undefined||!!this.craftingPanel?.modalOpen||!!this.shopPanel?.modalOpen||!!this.partyPanel?.modalOpen||!!this.forge?.confirming);
    this.hudButtons.enabled=()=>this.app.ui.mode==='game'&&this.app.ui.ready&&!this.app.ui.locked&&!this.app.ui.suspended;
    scene.scale.on('resize',this.resize,this);scene.input.keyboard?.on('keydown',this.key,this);
    // 浏览器自身的退出（Esc、手势）不会走设置页的按钮，靠事件把开关状态同步回来。
    this.unsubscribeFullscreen?.();
    this.unsubscribeFullscreen=onFullscreenChange(()=>{if(this.open&&this.page==='settings')this.render();});
    scene.input.on('pointermove',this.moveDrag,this);scene.input.on('pointerup',this.endDrag,this);scene.input.on('pointerupoutside',this.cancelDrag,this);
    scene.game.events.on(UI_EVENTS.minimapLayout,this.onMinimap,this);scene.game.events.on(UI_EVENTS.cancelInput,this.cancelDrag,this);
    scene.events.once('shutdown',()=>{this.unsubscribe?.();this.unsubscribeFullscreen?.();this.discardAllocation();scene.scale.off('resize',this.resize,this);scene.game.events.off(UI_EVENTS.minimapLayout,this.onMinimap,this);scene.game.events.off(UI_EVENTS.cancelInput,this.cancelDrag,this);this.cancelOperation();this.prompt?.close();this.surface!.root.remove(this.body!.root);this.surface?.destroy();this.body?.destroy();this.modal?.destroy();this.hudButtons?.destroy();this.description?.destroy();this.shortcutScreen?.destroy();this.backTab?.destroy();this.backdrop?.destroy();this.controlEditor?.destroy();this.controlEditor=undefined;this.keyBindingEditor?.destroy();this.keyBindingEditor=undefined;});
    this.sync();
  }
  bind(session:Session,world:WorldIndex,content:StoryInterface):void{
    this.discardAllocation();
    this.close();this.hudButtons?.clear();this.unsubscribe?.();this.session=session;this.world=world;this.content=content;this.page='bag';this.selectedMemberId='player';this.filter='all';this.selectedItem=undefined;this.itemResult=undefined;this.scrollOffsets.clear();this.sessionSignature='';
    this.questPanel=new QuestPanel(session,world,this.app.menuPanels,()=>this.render());
    this.partyPanel=new PartyPanel(session,world,this.app,()=>this.render(),(id,page)=>this.selectMember(id,page));
    this.unsubscribe=session.subscribe(()=>{
      // 快捷键登记、控制布局编辑与强化台打开时由各自的界面显式重绘；
      // 强化台的动作在完成后调 changed 统一重绘一次，避免会话通知再画一遍。
      if(!this.open||this.busy||this.shortcutEdit||this.app.ui.controlLayoutEditing||this.page==='forge')return;
      const signature=this.sessionDataSignature();
      if(signature===undefined||signature!==this.sessionSignature)this.render();
    });this.sync();
  }
  sync():void{
    if(this.app.ui.suspended){this.cancelDrag();if(this.renameRef!==undefined){this.prompt?.close();this.renameRef=undefined;}}
    const active=this.app.ui.mode==='game'&&this.app.ui.ready&&!!this.session;
    if(!active&&this.open&&!(this.busy&&this.app.ui.mode==='game'&&this.session)){this.discardAllocation();this.close();}
    if(this.app.ui.mode!=='game')this.hudButtons?.clear();
    this.hudButtons?.visible(active&&(!this.app.ui.locked||this.app.ui.controlLayoutEditing)&&!this.app.ui.suspended);
    if(active&&this.hudButtons&&this.hudButtons.root.length===0){const v=this.hudButtons;v.button('',0,0,HUD_SIDE_BUTTON_SIZE,HUD_SIDE_BUTTON_SIZE,()=>this.show('save'),{image:this.content!.assets.save}).setData('label','存档');v.button('',0,HUD_SIDE_BUTTON_SIZE+8,HUD_SIDE_BUTTON_SIZE,HUD_SIDE_BUTTON_SIZE,()=>this.show('bag'),{image:this.content!.assets.menu}).setData('label','菜单');}
    // 登记快捷键时菜单本体整块让位，只留背后的遮罩与这一屏自己，画面里那层游戏背景就露出来了。
    const menu=this.open&&!this.app.ui.suspended&&!this.shortcutEdit&&!this.app.ui.controlLayoutEditing&&!this.app.ui.keyBindingEditing;
    this.surface?.visible(menu);this.body?.visible(menu);this.description?.visible(menu&&!this.forge);
    const modal=menu&&(!!this.operation||!!this.itemNotice||!!this.allocationExit||this.skillReset||this.saveConfirm!==undefined||this.loadConfirm!==undefined||this.deleteConfirm!==undefined||!!this.craftingPanel?.modalOpen||!!this.shopPanel?.modalOpen||!!this.partyPanel?.modalOpen||!!this.forge?.confirming);
    if(modal&&!this.modalActive)this.app.ui.resetInput();
    this.modalActive=modal;this.modal?.visible(modal);
    this.shortcutScreen?.visible(this.open&&!this.app.ui.suspended&&!!this.shortcutEdit);this.backTab?.visible(this.open&&!this.app.ui.suspended&&!!this.shortcutEdit);
    this.backdrop?.setVisible(this.open&&!this.app.ui.suspended);
    this.controlEditor?.visible(this.open&&this.app.ui.controlLayoutEditing&&!this.app.ui.suspended);
    this.keyBindingEditor?.visible(this.open&&this.app.ui.keyBindingEditing&&!this.app.ui.suspended);this.layout();
  }
  show(page:Page):void{
    if(!this.session||!this.app.ui.ready||this.app.ui.mode!=='game'||this.app.ui.suspended||(!this.open&&this.app.ui.locked))return;
    if(this.page!==page&&this.requestAllocationExit(()=>this.show(page)))return;
    if(page==='quests'&&(!this.open||this.page!==page))this.questPanel?.reset();
    if(!this.open){this.open=true;this.app.ui.lock(true,'story-menu');}
    if(this.page!==page){this.itemResult=undefined;this.cancelOperation();this.adjusting=false;this.notice='';}
    // render() 末尾已经 sync 过；这里再调一次会把整层再排版一遍。
    this.page=page;this.render();
  }
  /** 调试收尾后回到设置里的调试剧情页，保留面板原来的筛选与选中任务。 */
  openDebugStory():void{
    if(!this.app.gm)return;
    // 收尾可能刚好还在释放导演锁；菜单关着时稍后再试，避免这次回页被 quietly 丢掉。
    if(!this.open&&this.app.ui.locked){setTimeout(()=>this.openDebugStory(),100);return;}
    this.show('debug');
    this.gmPanel?.showStoryPage();
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
    this.close();const store=new Storefront(this.app.shops,this.session!.bag.catalog,this.app.characterStats,this.session!,shopId,mapId);this.shopPanel=new ShopPanel(store,this.session!,this.app.shops,this.app.menuPanels.assets,()=>this.render(),()=>this.member(),this.classNames());this.show('shop');
  }
  /** 生产内容包把 shops.equipment 拆到独立文件；第一次开商店时合并。 */
  private async ensureShopEquipment():Promise<void>{
    if(Object.keys(this.app.shops.equipment).length)return;
    this.app.shops.equipment=await this.app.content.shopEquipment();
  }
  /**
   * 面板调试入口，只给 `?ui-debug` 的调试场景调用：直接把面板摆到目标状态，跳过点击链路。
   * `entry` 是会话背包里的物品实例 id。商品说明与交易步骤由 `debugShop` 交给 `ShopPanel`。
   */
  debugDescribe(entry:string,side:'left'|'right'='left'):void{
    if(!this.session?.bag.get(entry))return;
    // `selectItem` 对同一条是「再点一次就收起」，调试条连点两下会把面板关掉，所以先清空再选。
    this.selectedItem=undefined;this.forge=undefined;
    this.show('bag');this.selectItem(entry,side);
  }
  /** 调试入口：直接打开某件物品的使用弹层。`kind='discard'` 打开丢弃框。 */
  debugUse(entry:string,kind:'use'|'discard'='use'):void{
    if(!this.session?.bag.get(entry))return;
    this.forge=undefined;this.show('bag');this.beginOperation(entry,kind);
  }
  /** 调试入口：打开商店并停在该店的某个交易步骤；`shopId` 必须是 shops.json 里存在的键。 */
  debugShop(shopId:string,step:'browse'|'description'|'quantity'|'confirm'|'notice'='browse',kind:'buy'|'sell'='buy',mapId=''):void|Promise<void>{
    const opened=this.openShop(shopId,mapId);
    const apply=()=>{if(step!=='browse')this.shopPanel?.debugTrade(step,kind);};
    if(opened)return opened.then(apply);
    apply();
  }
  close():void{
    if(this.open&&this.requestAllocationExit(()=>this.close()))return;
    if(!this.open)return;this.controlEditor?.close();this.app.ui.setControlLayoutEditing(false);
    this.keyBindingEditor?.close();this.app.ui.setKeyBindingEditing(false);this.cancelOperation();this.modalActive=false;this.shortcutEdit=undefined;this.shortcutScreen?.clear();this.backTab?.clear();this.shopPanel=undefined;this.bagPortrait?.visual.container.destroy();this.bagPortrait=undefined;this.craftingPanel=undefined;this.craftingActor=undefined;this.forge=undefined;this.open=false;this.scrollNames.forEach((scroll,name)=>this.scrollOffsets.set(`${this.page}:${name}`,scroll.scrollTop));this.scrollNames.clear();this.body?.clear();this.description?.clear();if(this.surface&&this.body){this.surface.root.remove(this.body.root);this.surface.clear();this.surface.root.add(this.body.root);}this.keyboardFocus=undefined;this.surface?.visible(false);this.body?.visible(false);this.description?.visible(false);this.modal?.visible(false);this.shortcutScreen?.visible(false);this.backTab?.visible(false);this.backdrop?.setVisible(false);this.app.ui.resetInput();this.app.ui.lock(false,'story-menu');
  }
  private cancelOperation():void{this.cancelDrag();this.request.abort();this.request=new AbortController();this.busy=false;this.operation=undefined;this.itemNotice=undefined;this.skillReset=false;this.saveConfirm=undefined;this.loadConfirm=undefined;this.deleteConfirm=undefined;this.renameRef=undefined;this.prompt?.close();this.partyPanel?.close();this.craftingPanel?.close();this.forge=undefined;this.modal?.clear();this.modal?.visible(false);}
  private key(event:KeyboardEvent):void{
    if(this.app.ui.suspended)return;
    // 捕获按键时整块键盘归键位面板：Tab、Enter、空格不再操作菜单。
    if(this.app.ui.keyBindingEditing){this.keyBindingEditor?.key(event);return;}
    if(!this.open){
      // 菜单键只在正式游戏里生效；`repeat` 按住不放也只开一次。
      if(!event.repeat&&this.session&&this.app.ui.mode==='game'&&this.app.ui.ready&&!this.app.ui.locked
        &&this.app.keyBindings.matches('menu',event)){
        event.preventDefault();this.show('bag');
      }
      return;
    }
    // 改名输入框开着时键盘归系统输入法：Enter/Escape 由输入框自己处理。
    if(this.renameRef!==undefined)return;
    if(this.app.ui.controlLayoutEditing){if(event.key==='Escape'){event.preventDefault();this.closeControlEditor();}else this.controlEditor?.key(event);return;}
    if(event.key==='Escape'&&this.itemNotice){event.preventDefault();this.itemNotice=undefined;this.render();return;}
    if(event.key==='Escape'&&this.deleteConfirm!==undefined){event.preventDefault();this.deleteConfirm=undefined;this.render();return;}
    if(event.key==='Escape'&&this.loadConfirm!==undefined){event.preventDefault();this.loadConfirm=undefined;this.render();return;}
    if(event.key==='Escape'&&this.saveConfirm!==undefined){event.preventDefault();this.saveConfirm=undefined;this.render();return;}
    if(event.key==='Escape'&&this.allocationExit){event.preventDefault();this.finishAllocation(false);return;}
    if(event.key==='Escape'){event.preventDefault();if(this.busy){this.close();return;}if(this.page==='forge'){if(this.forge?.confirming)this.forge.cancelConfirmation();else this.closeForge();return;}if(this.shortcutEdit){this.closeShortcutScreen();return;}if(this.skillReset){this.skillReset=false;this.render();}else if(this.craftingPanel?.modalOpen){this.craftingPanel.cancel();}else if(this.shopPanel?.active){this.shopPanel.cancel();}else if(this.partyPanel?.modalOpen){this.partyPanel.cancel();}else if(this.operation){this.operation=undefined;this.render();}else if(this.page==='bag'&&this.selectedItem){this.selectedItem=undefined;this.render();}else this.close();return;}
    const surfaces=this.operation||this.itemNotice||this.allocationExit||this.skillReset||this.saveConfirm!==undefined||this.loadConfirm!==undefined||this.deleteConfirm!==undefined||this.craftingPanel?.modalOpen||this.shopPanel?.modalOpen||this.partyPanel?.modalOpen||this.forge?.confirming
      ?[this.modal!]:this.shortcutEdit?[this.shortcutScreen!,this.backTab!]:[this.surface!,this.body!,this.description!];
    const buttons=surfaces.flatMap(surface=>surface.focusables());
    if(this.keyboardFocus&&!buttons.includes(this.keyboardFocus))this.keyboardFocus=undefined;
    if(event.key==='Tab'&&buttons.length){event.preventDefault();const current=this.keyboardFocus?buttons.indexOf(this.keyboardFocus):-1,index=current<0?(event.shiftKey?buttons.length-1:0):(current+(event.shiftKey?-1:1)+buttons.length)%buttons.length;this.keyboardFocus=buttons[index];surfaces.forEach(surface=>surface.focus(this.keyboardFocus!));}
    else if((event.key==='Enter'||event.key===' ')&&this.keyboardFocus&&buttons.includes(this.keyboardFocus)){event.preventDefault();this.scene!.game.events.emit(UI_EVENTS.select);this.keyboardFocus.getData('action')();}
  }
  private onMinimap(height:number):void{this.minimapHeight=height;this.layout();}
  /** 缩放时登记屏的圆槽要按新锚点重摆，所以不光是 `layout`。 */
  private resize():void{this.layout();if(this.open&&this.shortcutEdit){this.renderShortcutScreen();this.renderBackButton();}}
  /**
   * 弹层画布按当前对话框的尺寸在菜单里居中。对话框开局声明一次并立即生效；`layout()` 在缩放
   * 变化时按同一个尺寸重算，所以锚点始终跟得上当前打开的那一个。
   */
  private beginModal(width:number,height:number):void{this.modalBox={width,height};this.positionModal();}
  private positionModal():void{if(this.surface&&this.modal)centerModal(this.modal,this.surface,this.modalBox.width,this.modalBox.height);}
  private layout():void{
    this.controlEditor?.layout();this.keyBindingEditor?.layout();
    this.surface?.layout(12);this.positionModal();
    // 说明面板不在 surface 之下，位置与缩放按 surface 的世界变换同步，坐标系与内容块一致。
    if(this.surface&&this.description){const matrix=this.surface.root.getWorldTransformMatrix(),position=matrix.transformPoint(CONTENT_ORIGIN.x,CONTENT_ORIGIN.y);this.description.root.setPosition(position.x,position.y).setScale(matrix.scaleX,matrix.scaleY);}
    // 登记快捷键那一屏按原版的屏幕坐标摆：缩放取操作区的缩放，屏幕左上角为原点；
    // 圆形关闭钮再让开设备安全区，其余内容里的 HUD 锚点已经算过安全区。
    if(this.scene&&this.shortcutScreen&&this.backTab){
      const {scale}=controlPlacement(this.scene,this.scene.scale.width,this.scene.scale.height),bounds=this.scene.game.canvas.getBoundingClientRect(),safe=readSafeArea(),unit=this.scene.scale.width/Math.max(1,bounds.width);
      this.shortcutScreen.root.setPosition(0,0).setScale(scale);this.backTab.root.setPosition(safe.left*unit,safe.top*unit).setScale(scale);
    }
    this.body?.scrolls.forEach(scroll=>scroll.layout());this.description?.scrolls.forEach(scroll=>scroll.layout());this.modal?.scrolls.forEach(scroll=>scroll.layout());if(this.hudButtons&&this.scene){const bounds=this.scene.game.canvas.getBoundingClientRect(),safe=readSafeArea(),unit=this.scene.scale.width/Math.max(1,bounds.width),scale=uiUnitScale(this.scene.scale.width,this.scene.scale.height);this.hudButtons.root.setScale(scale).setPosition((safe.left+12)*unit,(safe.top+12)*unit);this.hudButtons.root.list.forEach((button,index)=>(button as Phaser.GameObjects.Container).setPosition(0,this.minimapHeight+12+index*(HUD_SIDE_BUTTON_SIZE+8)));}
    this.backdrop?.setSize(this.scene!.scale.width,this.scene!.scale.height);
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
  private drawPartyColumn(v:UiSurface):void{
    const panels=this.app.menuPanels,party=this.session!.party,ids=party?.activeIds??['player'];
    for(let index=0;index<3;index++){
      const id=ids[index],top=49+index*113;
      v.image(panels.assets['character-party-frame'],8,top,104,114);
      if(!id)continue;
      const name=id==='player'?this.world!.actors[this.session!.campaign.start.actor].name:party?.get(id)?.definition.name??`队员 ${index+1}`;
      const button=v.button('',8,top,104,113,()=>{if(id!==this.selectedMemberId)this.selectMember(id,this.page);},{bare:true}).setData('label',name);
      // 头像相对按钮格子 (9,9)，即内容坐标的 (17, top+9)：`button` 是它的父容器，
      // 传绝对坐标会被再加一次按钮偏移，头像就会掉到格子外面。
      v.image(this.memberPartyIcon(id),9,9,86,96,button);
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
  private scroll(name:string,x:number,y:number,w:number,h:number,surface=this.body!,bleed=0):ScrollArea{const scroll=surface.scroll(x,y,w,h,bleed);this.scrollNames.set(name,scroll);return scroll;}
  private finishScroll(name:string,scroll:ScrollArea,height:number):void{scroll.setHeight(height);scroll.scrollTop=this.scrollOffsets.get(`${this.page}:${name}`)??0;}
  /**
   * 会话每次通知都会走到这里；只有当前页真正依赖的数据变化时才整页重绘。
   * 界面操作仍然直接调 `render()`，不经过这道门。
   */
  private render():void{
    this.renderNow();
    const signature=this.sessionDataSignature();
    if(signature!==undefined)this.sessionSignature=signature;
  }
  /**
   * 当前页依赖的数据签名。返回 `undefined` 的页面（任务、调试）依赖条件求值等
   * 不易枚举的数据，保持每次通知都重绘，避免显示过期内容。
   */
  private sessionDataSignature():string|undefined{
    const session=this.session;
    if(!session)return undefined;
    const party=session.party;
    const partyShape=`${party?.activeIds.join('|')??''}|${party?.controlledId??''}`;
    const groupShape=JSON.stringify(Object.entries(party?.groupModifiers()??{}).sort());
    const member=this.member();
    const companion=this.selectedMemberId==='player'?undefined:party?.get(this.selectedMemberId);
    const bag=session.bag.revision,money=session.money;
    switch(this.page){
      case 'bag':return `bag|${this.selectedMemberId}|${bag}|${money}|${member?.level??0}|${partyShape}`;
      case 'status':return `status|${this.selectedMemberId}|${bag}|${member?.level??0}|${JSON.stringify(member?.player??null)}|${session.hero?.skillPoints??0}|${session.hero?.statPoints??0}|${partyShape}|${groupShape}`;
      case 'skills':return `skills|${this.selectedMemberId}|${bag}|${session.skills.version}|${companion?.skills.version??''}|${member?.level??0}|${session.hero?.skillPoints??0}|${partyShape}`;
      case 'party':{
        const detail=party?.activeIds.map(id=>{
          if(id==='player')return `player:${session.hero?.level??0}:${session.hero?.skillPoints??0}:${JSON.stringify(session.hero?.player??null)}`;
          const entry=party.get(id);
          return `${id}:${entry?.level??0}:${entry?.skills.version??0}:${JSON.stringify(entry?.player??null)}:${entry?.counterattack??0}:${JSON.stringify([...(entry?.aiFrequency??new Map())])}`;
        }).join('|')??'';
        return `party|${bag}|${partyShape}|${detail}`;
      }
      case 'shop':return `shop|${this.selectedMemberId}|${bag}|${money}|${partyShape}`;
      case 'crafting':return `crafting|${this.selectedMemberId}|${bag}|${money}|${member?.level??0}|${partyShape}`;
      case 'forge':return 'forge';
      case 'save':case 'load':case 'settings':case 'system':return this.page;
      default:return undefined;
    }
  }
  private renderNow():void{
    if(!this.open||!this.surface||!this.body||!this.session)return;
    this.forge?.captureScroll();this.craftingPanel?.captureScroll();this.shopPanel?.captureScroll();this.questPanel?.captureScroll();this.partyPanel?.captureScroll();this.scrollNames.forEach((scroll,name)=>this.scrollOffsets.set(`${this.page}:${name}`,scroll.scrollTop));this.scrollNames.clear();this.surface.root.remove(this.body.root);this.surface.clear();if(this.bagPortrait)this.body.root.remove(this.bagPortrait.visual.container);this.body.clear();this.description?.clear();this.modal!.clear();this.surface.root.add(this.body.root);this.drops=[];this.keyboardFocus=undefined;
    if(!this.member()){this.discardAllocation();this.selectedMemberId='player';}const v=this.surface;
    this.body.root.setPosition(CONTENT_ORIGIN.x,CONTENT_ORIGIN.y);
    // 登记快捷键时菜单本体不画：只重画那一屏（它自己在 `sync` 里显示、菜单整块隐藏）。
    if(this.app.ui.controlLayoutEditing){this.surface.clearStatic();this.body.clearStatic();this.sync();return;}
    if(this.shortcutEdit){this.surface.clearStatic();this.body.clearStatic();this.renderShortcutScreen();this.renderBackButton();this.sync();return;}
    // 静态图框只在背包/商店页保留；其它页先把上一页的静态层收掉，避免压在设置或任务列表下面。
    if(this.page!=='bag'&&this.page!=='shop')this.body.clearStatic();
    const chromeKey=`chrome:${this.page}${this.page==='crafting'?`:${this.craftingActor}`:''}`;
    v.staticLayer(chromeKey,()=>{
      if(this.page!=='shop'&&this.page!=='crafting'&&this.page!=='forge'&&this.page!=='save'&&this.page!=='load')tabs.forEach(([page,label],index)=>{const button=v.button('',35+index*149,25,102,116,()=>this.show(page),{bare:true,parent:v.staticRoot}).setData('label',label);v.image(this.content!.assets[`tab-${page}`],12,0,78,78,button);v.text(label,51,85,90,20,undefined,button).setOrigin(.5,0);button.setAlpha(this.page===page||(['settings','debug'] as Page[]).includes(this.page)&&page==='system'?1:.65);});
      if(this.page==='crafting'&&this.craftingPanel){
        v.text(this.world!.actors[this.craftingActor!].name,512,25,0,28,undefined,v.staticRoot).setOrigin(.5,0);
      }
      if(this.page==='forge')v.text('装备强化',512,25,0,28,undefined,v.staticRoot).setOrigin(.5,0);
      v.button('',947,24,51,51,()=>this.page==='forge'?this.closeForge():this.close(),{image:this.content!.assets.close,pressed:this.content!.assets['close-pressed'],parent:v.staticRoot}).setData('label',this.page==='forge'?'关闭强化':'关闭菜单');
    });
    if(this.page==='bag')this.renderBag();if(this.page==='status')this.renderStatus();if(this.page==='skills')this.renderSkills();if(this.page==='party')this.renderParty();if(this.page==='quests')this.renderQuests();if(this.page==='shop')this.shopPanel?.render(this.body,this.modal!,this.placeModal,this.description!);
    if(this.page==='crafting'&&this.craftingPanel){this.craftingPanel.render(this.body,this.modal!,this.placeModal,(pointer,entry,scroll)=>this.startDrag(pointer,entry,scroll));this.drops=this.craftingPanel.drops;}
    if(this.page==='forge'&&this.forge)this.forge.render(this.body,this.modal!,this.placeModal);
    if(this.page==='system'){
      const actions:[string,()=>void][]=[['保存游戏',()=>this.show('save')],['读取存档',()=>this.show('load')],['设置',()=>this.show('settings')]];
      // 「调试」只在 GM 打开时出现；关闭时这一项根本不存在，不需要靠权限判断挡住。
      if(this.app.gm)actions.push(['调试',()=>this.show('debug')]);
      actions.push(['返回主菜单',()=>{this.close();this.app.returnToMenu?.();}]);
      // 间距按条数收缩，多一项也不会顶出内容区。
      const gap=Math.min(95,Math.floor((398-66)/Math.max(1,actions.length-1)));
      actions.forEach(([label,action],index)=>this.body!.button(label,320,70+index*gap,300,66,action));
    }
    if(this.page==='debug'&&this.app.gm){
      // 面板按当前动作层实例缓存：同一会话里保留过滤与选中，换会话就重建。
      if(this.gmPanelOwner!==this.app.gm){
        const gm=this.app.gm;
        const mapNames=new Map((this.world?.maps??[]).map(map=>[map.id,map.name]));
        this.gmPanel=new GmPanel(gm,this.session.campaign,{close:()=>this.close(),render:()=>this.render(),reopen:()=>this.show('debug')},{
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
        });
        this.gmPanelOwner=gm;
      }
      this.gmPanel?.render(this.body!);
    }
    if(this.page==='save'||this.page==='load')this.renderSaveSlots();
    if(this.page==='settings')this.renderSettings();
    if(this.notice)this.surface.text(this.notice,512,614,880,18).setOrigin(.5,0);
    if(this.operation)this.renderOperation();if(this.allocationExit)this.renderAllocationConfirmation();if(this.skillReset)this.renderSkillResetConfirmation();
    if(this.itemNotice){this.beginModal(1024,640);drawNativeMessage(this.modal!,this.app.menuPanels.assets,this.itemNotice,()=>{this.itemNotice=undefined;this.render();});}
    if(this.loadConfirm!==undefined){const slot=this.loadConfirm;this.beginModal(1024,640);drawNativeMessage(this.modal!,this.app.menuPanels.assets,'读取存档将丢失当前未保存的进度，确定读取？',()=>{this.loadConfirm=undefined;void this.loadFromSlot(slot);},()=>{this.loadConfirm=undefined;this.render();});}
    if(this.saveConfirm!==undefined){const slot=this.saveConfirm;this.beginModal(1024,640);drawNativeMessage(this.modal!,this.app.menuPanels.assets,'这个存档槽里已经有存档，确定覆盖？',()=>{this.saveConfirm=undefined;this.saveToSlot(slot);},()=>{this.saveConfirm=undefined;this.render();});}
    if(this.deleteConfirm!==undefined){const slot=this.deleteConfirm;this.beginModal(1024,640);drawNativeMessage(this.modal!,this.app.menuPanels.assets,'删除后无法恢复，确定删除这个存档？',()=>this.deleteSlot(slot),()=>{this.deleteConfirm=undefined;this.render();});}
    this.sync();
  }
  private openControlEditor():void {
    if(!this.scene||!this.content||!this.open)return;
    this.cancelDrag();
    this.controlEditor??=new ControlLayoutEditor(this.scene,this.app.controlLayout,this.app.controlSkin,this.app.menuPanels.assets,()=>this.closeControlEditor());
    this.controlEditor.open(this.app.captureControlPreview?.()??[]);
    this.app.ui.setControlLayoutEditing(true);this.render();
  }
  private closeControlEditor():void {
    this.controlEditor?.close();this.page='settings';this.app.ui.setControlLayoutEditing(false);this.render();
  }
  private openKeyBindingEditor():void {
    if(!this.scene||!this.content||!this.open)return;
    this.cancelDrag();
    this.keyBindingEditor??=new KeyBindingEditor(this.scene,this.app.keyBindings,this.app.menuPanels.assets,()=>this.closeKeyBindingEditor());
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
    v.text('环境设置',473,15,0,29,undefined,content).setOrigin(.5,0);
    if(audio)for(const [index,[channel,label]]of [['music','音乐'],['effects','音效']].entries()){
      const key=channel as 'music'|'effects',top=80+index*90;
      v.text(label,260,top+15,0,25,undefined,content);
      // 最左边是静音；轨道一直伸到右侧面板边缘，百分比放在轨道右端。
      v.slider(key,485,top+33,400,audio.settings[key],value=>audio.setVolume(key,value),content);
    }
    // 帧率显示和音量一样是画面/声音偏好，放在同一个面板里；默认开启。
    v.text('帧率显示',260,275,0,25,undefined,content);
    const fps=displaySettings.fps;
    v.button(fps?'开启':'关闭',485,260,220,66,()=>{displaySettings.setFps(!fps);this.render();},{parent:content});
    // 暴击光环和爆闪只影响画面，默认开启；不影响暴击冲击、数字、震屏或音效。
    v.text('暴击光效',260,365,0,25,undefined,content);
    const decorations=displaySettings.criticalDecorations;
    v.button(decorations?'开启':'关闭',485,350,220,66,()=>{
      displaySettings.setCriticalDecorations(!decorations);
      this.render();
    },{parent:content});
    // 全屏是浏览器能力；不支持的环境显示为不可用，APK 壳已经隐藏系统栏，显示为已全屏。
    let rowTop=440;
    const fullscreen=fullscreenStatus();
    v.text('全屏',260,rowTop+15,0,25,undefined,content);
    if(fullscreen==='available'){
      const active=fullscreenActive();
      v.button(active?'开启':'关闭',485,rowTop,220,66,()=>setFullscreen(!active),{parent:content})
        .setData('label','全屏：' + (active?'开启':'关闭'));
    }else{
      const label=fullscreen==='packaged'?'已全屏':'不支持';
      v.button(label,485,rowTop,220,66,()=>{},{parent:content,disabled:true})
        .setData('label','全屏：'+label);
    }
    // 操作方式在本行点击轮换；触屏模式拖动控件位置，电脑模式改成键位映射。
    rowTop+=90;
    const modeLabel=CONTROL_MODE_LABELS[controlSettings.mode];
    v.text('操作方式',260,rowTop+15,0,25,undefined,content);
    v.button(modeLabel,485,rowTop,220,66,()=>{
      controlSettings.setMode(nextControlMode(controlSettings.mode));
      this.render();
    },{parent:content}).setData('label',`操作方式：${modeLabel}`);
    rowTop+=90;
    if(controlSettings.mode==='keyboard'){
      v.text('键位设置',260,rowTop+15,0,25,undefined,content);
      v.button('修改键位',485,rowTop,220,66,()=>this.openKeyBindingEditor(),{parent:content});
    }else{
      v.text('控件位置',260,rowTop+15,0,25,undefined,content);
      v.button('拖动调整',485,rowTop,220,66,()=>this.openControlEditor(),{parent:content});
    }
    this.finishScroll('settings',scroll,rowTop+80);
  }
  /**
   * 存档槽：原版 `Scene_Init_POPUP_SC_SAVESLOT @0x1eae4c` 的面板 668×530 居中、三行 634×150、
   * 行距 166，行框是 668×184 的原版图（版面和几何在 `ui/phaser/save-board.ts`）。
   * 面板不画底图，界面的样子全来自三张行框图，和原版一致。标题页开局与游戏内读档共用同一份版面。
   */
  private renderSaveSlots():void{
    const v=this.surface!;
    const loading=this.page==='load';v.text(loading?'读取存档':'存档槽',512,16,0,28).setOrigin(.5,0);
    const assets={frame:this.content!.assets['save-slot'],empty:this.content!.assets['save-empty']};
    const origin=saveBoardOrigin(v.width);
    // 自动存档固定一行置顶：读档页可读，存档页只展示；永远没有改名与删除。
    drawSaveBoardRow(v,assets,origin,SAVE_BOARD_LAYOUT.autoTop,this.saveRow(AUTO_SAVE_SLOT,loading));
    // 十个手动槽放进滚动区；按写入时间倒序，最新的排最前，空槽排在后面。
    const scroll=this.scroll('slots',origin.x,SAVE_BOARD_LAYOUT.listTop,SAVE_BOARD.panelWidth,SAVE_BOARD_LAYOUT.listHeight,v);
    newestFirstSlots(slot=>this.app.saves.peek(slot)).forEach((slot,index)=>
      drawSaveBoardRow(v,assets,{x:0,y:0},index*SAVE_BOARD.rowStep,this.saveRow(slot,loading),scroll.content));
    this.finishScroll('slots',scroll,(MANUAL_SAVE_SLOT_COUNT-1)*SAVE_BOARD.rowStep+SAVE_BOARD.frameHeight);
  }
  /** 一行存档的读数、动作与行内控件；自动槽在存档页没有动作。 */
  private saveRow(ref:SaveSlotRef,loading:boolean):SaveBoardRow{
    const reading=this.app.saves.peek(ref),title=saveRowTitle(ref,reading),auto=ref===AUTO_SAVE_SLOT;
    const action=loading
      ? reading.kind==='ok'&&this.app.resumeSlot?()=>this.requestLoad(ref):undefined
      : auto?undefined:()=>this.requestSave(ref);
    // 行内控件用固定的槽位名（改名后仍叫「存档槽 N 删除」），行本身的标题才用自定义名字。
    const slotLabel=saveSlotLabel(ref);
    const controls = !auto&&reading.kind==='ok' ? [
      {text:'改名',label:`${slotLabel} 改名`,action:()=>this.renameSlot(ref)},
      {text:'删除',label:`${slotLabel} 删除`,action:()=>this.requestDelete(ref)},
    ] : !auto&&reading.kind==='unreadable' ? [
      {text:'删除',label:`${slotLabel} 删除`,action:()=>this.requestDelete(ref)},
    ] : undefined;
    return {reading,action,label:title,title,auto,...(controls?{controls}:{})};
  }
  private requestLoad(ref:SaveSlotRef):void {
    if(this.busy||this.app.saves.peek(ref).kind!=='ok')return;
    this.loadConfirm=ref;this.render();
  }
  private async loadFromSlot(ref:SaveSlotRef):Promise<void> {
    const load=this.app.resumeSlot;if(!load||this.busy)return;
    const request=this.request,session=this.session;this.busy=true;this.render();this.sync();
    try{await load(ref,request.signal);}
    catch(error){if(!request.signal.aborted&&this.request===request&&this.session===session){this.itemNotice=error instanceof Error?error.message:String(error);}}
    finally{if(!request.signal.aborted&&this.request===request&&this.session===session){this.busy=false;this.render();this.sync();}}
  }
  /** 点一个手动槽：空槽直接存，已有存档先问一次再覆盖（原版对不可逆操作用是／否确认）。 */
  private requestSave(ref:SaveSlotRef):void{
    if(ref===AUTO_SAVE_SLOT)return;
    if(this.app.saves.peek(ref).kind==='empty'){this.saveToSlot(ref);return;}
    this.saveConfirm=ref;this.render();
  }
  private saveToSlot(ref:SaveSlotRef):void{
    if(ref===AUTO_SAVE_SLOT)return;
    const captured=this.captureSaveRecord();
    if(!captured.ok){this.itemNotice=saveUnavailableNotice(captured.reason);this.render();return;}
    try{
      this.app.saves.write(ref,captured.record);
      this.app.saveSlot=ref;
      this.app.audio?.ui('select');this.itemNotice=SAVE_DONE;
    }catch(error){
      console.warn('存档写入失败',error);this.itemNotice=SAVE_FAILED;
    }
    this.render();
  }
  /** 删除手动存档；删掉的正是当前槽时清空 `saveSlot`。 */
  private requestDelete(ref:SaveSlotRef):void{
    if(ref===AUTO_SAVE_SLOT)return;
    if(this.app.saves.peek(ref).kind==='empty')return;
    this.deleteConfirm=ref;this.render();
  }
  private deleteSlot(ref:SaveSlotRef):void{
    try{
      this.app.saves.erase(ref);
      if(this.app.saveSlot===ref)this.app.saveSlot=undefined;
      this.app.audio?.ui('select');
    }catch(error){
      console.warn('删除存档失败',error);this.itemNotice=SAVE_FAILED;
    }
    this.deleteConfirm=undefined;this.render();
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
      this.renameRef=undefined;this.render();this.sync();
    };
    // 测试没有 DOM 输入框，直接注入一个返回值。
    if(this.app.promptText){void this.app.promptText(reading.summary.name??'').then(apply);return;}
    this.renameRef=ref;this.render();this.sync();
    this.prompt?.show({title:'存档名称',initial:reading.summary.name??'',
      onConfirm:value=>apply(value),onCancel:()=>apply(undefined)});
    // 没有 DOM（测试或极端环境）时输入框起不来，别让菜单一直处于「让出输入」状态。
    if(!this.prompt?.active){this.renameRef=undefined;this.render();this.sync();}
  }
  /** 摘要与快照的唯一捕获口：手动保存与自动存档共用。 */
  captureSaveRecord():{ok:true;record:SaveGame<StoryWorldViewSnapshot>}|{ok:false;reason:SaveWorldReason}{
    if(!this.session)return {ok:false,reason:'not-ready'};
    const capture=this.app.captureSaveWorld?.();
    if(!capture||!capture.ok)return {ok:false,reason:capture?.reason??'not-ready'};
    return {ok:true,record:captureSaveGame(this.session,capture.world,this.saveSummaryOf(capture.map))};
  }
  /** 摘要里的职业名与立绘在存档时就展开，标题页读档不必再加载职业目录。 */
  private saveSummaryOf(map:{id:string;name:string}){
    const classId=sessionClassId(this.session!) ?? '';
    return saveSummary(this.session!,map,{name:this.app.storyClasses.classes.find(value=>value.id===classId)?.name??classId,portrait:this.playerPortrait().image});
  }
  /** 主角的立绘：存档槽里画的是他，与菜单当前选中的队员无关。 */
  private playerPortrait(){const actor=this.world!.actors[this.session!.campaign.start.actor],portraits=this.app.menuPanels.character.portraits;return portraits[actor.portrait??'kiyan']??portraits.kiyan;}
  private renderStatus():void{
    const v=this.body!,member=this.member()!,actor=this.actor(),panels=this.app.menuPanels,character=this.app.storyClasses.classes.find(value=>value.id===member.classId)!,art=this.memberArt();
    const hero=this.selectedMemberId==='player'?this.session!.hero:undefined,panel=member.panel;
    const statPoints=this.allocation?.remainingPoints??hero?.statPoints??0;
    const attributes=this.allocation?.attributes??panel.attributes;
    // 左框只有图框（`UI_DrawBorderRect`），四角 41×41 画在框外 2 像素处：`Scene_Draw_POPUP_SC_CHARACTER_INFO
    // @0x1e6b78` 把组 15 索引 48／49／53／54 画在 (83,−2)、(455,−2)、(83,392)、(455,392)，立绘在 (95,10)。
    v.border(panels.assets,85,0,409,431);
    for(const [corner,x,y]of [['nw',83,-2],['ne',455,-2],['sw',83,392],['se',455,392]] as const)v.image(panels.assets[`character-${corner}`],x,y,41,41);
    v.image(art.image,95,10,252,271);
    // 队员栏：原版这个 104×340 的栏里放三个 104×113 的成员按钮（`Scene_Init_POPUP_SC_CHARACTER_INFO
    // @0x1e5478` 里 `SetRect(?, 0/0x71/0xe2, 104, 113)`），每个画成员头像 86×96 落在框内 +(9,9)，
    // 所以第一格的头像就在 (17,58)；点哪一格就切到那位成员身上。
    this.drawPartyColumn(v);
    // 等级、职业、姓名三行都在 x=458 右对齐（`+0x1ca`），全部按上沿对齐：
    // 等级 `+0x5f`(95)、职业 `+0x78`(120)、姓名再让出字距落在 152。
    // 姓名不再以 150 为中线，否则更大的字号会压到职业行上。三行都是原版的米色 #e2cb9e。
    v.text(`等级 ${member.level}`,458,95,200,20,AREA_TEXT).setOrigin(1,0);
    v.text(character.name,458,120,200,20,AREA_TEXT).setOrigin(1,0);
    v.text(actor.name,458,152,200,26,AREA_TEXT).setOrigin(1,0);
    (['health','mana','experience'] as const).forEach((kind,index)=>{const player=member.player,value=player[kind],max=kind==='experience'?player.nextLevelExperience:kind==='health'?player.maxHealth:player.maxMana,y=258+index*44,ratio=kind==='experience'&&max===0?1:max>0?Math.max(0,Math.min(1,value/max)):0;
      v.image(panels.assets['character-gauge'],168,y+15,243,37);v.text(panels.character.labels[kind],118,y+21,46,19);v.text(max===0?'已满级':`${value} / ${max}`,290,y,223,17).setOrigin(.5,0);v.text(`${Math.floor(ratio*100)}%`,455,y+21,0,17).setOrigin(1,0);const width=223*ratio,fill=v.image(panels.assets[`character-${kind}-fill`],178,y+27,223,13);fill.setCrop(0,0,fill.width*ratio,fill.height).setVisible(width>0);if(width>0){v.image(panels.assets[`character-${kind}-start`],178,y+27,7,13);v.image(panels.assets[`character-${kind}-end`],178+Math.max(0,width-7),y+27,7,13);}
    });
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
    const allocated=this.session!.hero?.allocated;
    character.attributes.forEach((attribute,index)=>{
      const stat=PRIMARY_STATS[index],adjusting=this.adjusting;
      // 两档的行距与落点不同：加点视图 64 行距、名字 531、数值右对齐 751、圆角带 364 宽；
      // 总览视图 69 行距、名字 525、数值右对齐 684、圆角带 (513, 行顶+75, 190, 48)。
      if(adjusting)drawRoundBand(v,panels.assets,519,index*64+75,364,48,50);
      else drawRoundBand(v,panels.assets,513,index*69+75,190,48,50);
      const nameX=adjusting?531:525,nameY=adjusting?index*64+85:index*69+85;
      v.text(attribute.name,nameX,nameY,0,23);
      v.text(String(attributes[stat]),adjusting?751:684,adjusting?index*64+84:index*69+84,0,23).setOrigin(1,0);
      const added=(allocated?.[stat]??0)+(this.allocation?.pending[stat]??0);
      if(adjusting&&added>=1)v.text(`+${added}`,781,index*64+84,0,23,'#e1823b');
      if(adjusting&&this.allocation){
        // 原版减点使用左箭头，增点翻转同图；按下叠加对应亮图，透明处露出属性行底带。
        for(const [delta,x,label,disabled] of [[-1,630,'减少',this.allocation.pending[stat]===0],[1,822,'增加',statPoints<1]] as const){
          const button=v.button('',x,index*64+70,51,58,()=>this.action(()=>this.allocation!.change(stat,delta)),{
            image:panels.assets['character-step'],pressed:panels.assets['character-step-pressed'],native:true,pressedAdd:true,disabled,
          }).setData('label',`${label}${attribute.name}`);
          button.on('pointerdown',(pointer:Phaser.Input.Pointer)=>this.startAllocationHold(pointer,stat,delta));
          if(delta===1)for(const part of ['face','highlight']) (button.getData(part) as Phaser.GameObjects.Image).setFlipX(true);
        }
      }
    });
    v.button('',this.adjusting?846:661,0,67,67,()=>this.toggleAllocation(),{image:panels.assets[this.adjusting?'confirm':'character-adjust'],disabled:!hero}).setData('label',this.adjusting?'确认属性加点':'查看属性加点');
    if(!this.adjusting){
      const equipped=member.bag.equipmentItems(member.bag.equipmentFor(this.selectedMemberId));
      const items=this.session!.bag.catalog.items,main=equipped['main-hand'];
      const weapon=main?items[main]?.kind??'unarmed':'unarmed';
      const armor=equipped.body?items[equipped.body].kind:'';
      const modifiers=memberCombatModifiers({
        catalog:this.app.battleCatalog,classId:member.classId,loadout:this.configuration().draft(this.app.battleCatalog,member.classId),
        weaponKind:weapon,armorKind:armor,health:member.player.health,maxHealth:member.player.maxHealth,
        groupEffects:this.session!.party?.groupModifiers()??{},growth:memberSkillGrowth(this.selectedMemberId)
      });
      const values=characterCombatValues(effectiveCharacterPanel(panel,member.level,modifiers));
      v.border(panels.assets,722,0,224,431);panels.character.combatLabels.forEach((label,index)=>{v.text(label,738,24+index*35,110,19);v.text(values[index],928,24+index*35,0,19).setOrigin(1,0);});
    }else v.button('能力初始化',571,376,257,48,()=>this.action(()=>this.resetAttributes()));
    v.text(`${panels.character.labels.statPoints} ${statPoints}`,this.adjusting?534:522,14,0,20,AREA_TEXT);
  }
  private toggleAllocation():void{
    if(this.adjusting){if(this.requestAllocationExit(()=>this.render()))return;}
    else{const hero=this.session?.hero;if(this.selectedMemberId!=='player'||!hero)return;this.allocation=new AttributeAllocation(hero);this.adjusting=true;}
    this.render();
  }
  /** 能力初始化免费返还全部已分配点数；本轮还没确认的增量也一起作废。 */
  private resetAttributes():void{
    const hero=this.session?.hero;
    if(!hero||this.selectedMemberId!=='player')return;
    hero.resetAttributes();
    this.allocation=new AttributeAllocation(hero);
    this.allocationError='';
  }
  private discardAllocation():void{
    this.stopAllocationHold();
    this.allocation?.cancel();this.allocation=undefined;this.allocationExit=undefined;this.allocationError='';this.adjusting=false;
  }
  /** 长按加点：按住 400ms 后开始，每 90ms 加／减一点；松开或到达上下限就停。 */
  private startAllocationHold(pointer:Phaser.Input.Pointer,stat:PrimaryStat,delta:1|-1):void{
    this.stopAllocationHold();
    this.allocationHold=this.scene!.time.delayedCall(400,()=>this.stepAllocationHold(pointer,stat,delta));
  }
  private stepAllocationHold(pointer:Phaser.Input.Pointer,stat:PrimaryStat,delta:1|-1):void{
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
    this.allocationExit=next;this.keyboardFocus=undefined;this.render();return true;
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
    const v=this.modal!,character=this.app.storyClasses.classes.find(value=>value.id===this.session!.hero!.classId)!,pending=this.allocation!.pending;
    this.beginModal(718,415);v.frame(this.app.menuPanels.assets,0,0,718,415);v.text('确定按当前分配增加能力？',35,30,648,26);
    character.attributes.forEach((attribute,index)=>v.text(`${attribute.name}　＋${pending[PRIMARY_STATS[index]]}`,65,91+index*38,580,22));
    if(this.allocationError)v.text(this.allocationError,35,292,648,20);
    v.button('取消',270,350,170,48,()=>this.finishAllocation(false));v.button('确定',480,350,190,48,()=>this.finishAllocation(true));
  }
  private renderSkills():void{
    const v=this.body!,member=this.member()!,panels=this.app.menuPanels,configuration=this.configuration(),character=this.app.battleCatalog.classes.find(value=>value.id===member.classId)!;
    this.skill??=character.skills[0];if(!character.skills.includes(this.skill))this.skill=character.skills[0];
    const draft=configuration.draft(this.app.battleCatalog,member.classId),progression=this.selectedMemberId==='player'?this.session!.skills:undefined;
    // 原版技能页也只调 `UI_DrawBorderRect`（`UISkill_Draw @0x163e6c`），左栏与右栏的标题条、
    // 内容区各是一块图框；面板里露出的是黑色 65% 遮罩下的世界画面。
    v.border(panels.assets,85,0,409,431);drawSolidBorder(v,panels.assets,537,0,409,53);v.border(panels.assets,537,53,409,378);
    this.drawPartyColumn(v);
    if(this.skillSection==='directory')this.renderSkillDirectory(character,draft);
    else if(this.skillSection==='ai')this.renderSkillAi(character,draft);
    else this.renderSkillSettings();
    (['directory','ai','settings'] as const).forEach((section,index)=>v.button('',486,38+index*118,46,118,()=>{this.skillSection=section;this.scrollOffsets.delete('skills:description');this.render();},{image:panels.assets[`skill-tab-${section}`],disabled:section!=='directory'&&!this.session!.party}).setData('label',{directory:'技能目录',ai:'AI 设置',settings:'设置'}[section]));
    // 剧情伙伴的定义 id 也叫 mercenary-*，身份只能看 source。
    const companion=progression?undefined:this.session!.party?.get(this.selectedMemberId);
    v.text(progression?`${panels.character.labels.skillPoints} ${progression.points()}`:(companion?.source==='story'?'伙伴技能':'佣兵技能'),561,14,350,19);
    this.renderSkillAside(draft,progression);
  }
  /** 技能目录：原版三列技能格，左侧两列主动、第三列被动。 */
  private renderSkillDirectory(character:BattleClass,draft:SkillLoadout):void{
    const v=this.body!,panels=this.app.menuPanels;
    // 选中框画在格内 (-14,-14) 并要与格子一起滚动，所以留它一条 16 像素的裁剪外扩，
    // 否则第一列与第一行的圆环会被滚动区切成缺边的「C」形。
    // 可视区收进左框内沿：原版滚动区是 (21,18,374,394)，内容组再左内缩 10。这里把滚动原点
    // 移到 (116,24)（相对原可视区右移 10、下移 6），再用 16 的裁剪外扩；下沿正好停在底框上沿，
    // 内容不会盖住列标题和底框。
    const tree=this.scroll('directory',116,24,364,367,this.body!,16);panels.skillColumns.forEach((column,index)=>v.image(column.image,1+index*91,0,72,17,tree.content));
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
    panels.skillColumns.slice(0,2).forEach((column,index)=>v.image(column.image,1+index*182,0,72,17,list.content));
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
      v.button('',x+85,y+16,82,42,()=>this.action(()=>party.setAiFrequency(this.selectedMemberId,id,(frequency+1)%3)),
        {image:panels.assets[SKILL_LEVEL_ASSETS[frequency]!],pressed:panels.assets['skill-level-pressed'],native:true,parent:list.content,guard:list.guard})
        .setData('label',`${entry.name}自动使用频率 ${['不使用','一般','高'][frequency]}`);
    });
    this.finishScroll('ai',list,Math.max(20+5*89+75,20+2*178+75));
  }
  /** 设置：自动反击三档与技能点初始化，原版这一页只有这两项。 */
  private renderSkillSettings():void{
    const v=this.body!,panels=this.app.menuPanels,party=this.session!.party!,labels=panels.skillPanel.labels,mode=party.counterattack(this.selectedMemberId);
    v.text(labels.counterattackTitle,289,40,0,24).setOrigin(.5,0);
    for(const level of COUNTERATTACK_MODES){
      const button=v.button('',147+level*102,110,82,42,()=>this.action(()=>party.setCounterattack(this.selectedMemberId,level)),
        {image:panels.assets[SKILL_LEVEL_ASSETS[level]!],pressed:panels.assets['skill-level-pressed'],native:true}).setData('label',`自动反击 ${COUNTERATTACK_LABELS[level]}`);
      button.setAlpha(mode===level?1:.55);
    }
    if(this.selectedMemberId==='player')v.button(labels.resetButton,161,290,257,63,()=>{this.skillReset=true;this.render();});
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
    const detail=this.scroll('description',565,71,353,this.skillSection==='ai'?342:279);
    let y=drawDescriptionText(v,skillDescriptionParts(skill,level,companion?maximum:undefined),0,0,353,22,detail.content);
    if(this.skillSection==='ai'){this.finishScroll('description',detail,y);return;}
    if(level<maximum&&skill.ranks[level]){
      drawDescriptionSeparator(v,0,y+5,353,detail.content);y+=20;
      y+=drawDescriptionText(v,skillLearningParts(skill.name,level,progression?.learningRequirements(skill.id),
        companion?skill.ranks[level].requiredCharacterLevel:undefined),0,y,353,22,detail.content)+12;
      for(const row of skillNextLevelPreview(skill.ranks,level,skill.kind,maximum,skill.display)){
        const center=353/2,labelColor=row.kind==='mana'?'#0f7cf9':'#ffffff',valueColor=row.kind==='mana'?'#0f7cf9':'#ff0000';
        v.text(row.label,center,y,0,19,labelColor,detail.content).setOrigin(.5,0);
        const valuesY=y+26;
        v.text(row.from,center-12,valuesY,0,19,valueColor,detail.content).setOrigin(1,0);
        v.image(panels.assets['skill-compare-arrow'],center-10.5,valuesY-1,21,24,detail.content);
        v.text(row.to,center+12,valuesY,0,19,valueColor,detail.content);
        y+=52;
      }
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
    this.beginModal(718,415);v.visible(true);v.frame(panels.assets,0,0,718,415);
    v.text(`确定为${this.actor().name}初始化技能点？`,35,30,648,26);
    v.text('清空已学技能与快捷栏，返还正常加点的技能点。',35,91,648,22);
    v.button('取消',270,350,170,48,()=>{this.skillReset=false;this.render();});
    v.button('确定',480,350,190,48,()=>{
      if(this.busy)return;this.busy=true;
      try{this.session!.skills.reset();this.skillReset=false;}
      catch(error){this.notice=(error as Error).message;}
      finally{this.busy=false;}
      this.render();
    });
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
    screen.clear();const v=screen,{scale,anchor}=controlPlacement(scene,scene.scale.width,scene.scale.height),slots=this.shortcutBar().page(edit.page),positions=resolveControlLayout(controlViewport(scene),this.app.controlLayout.snapshot());
    // 顶部提示：原版 `GRPX_DrawStringWithFont(TEXTDATABASE[146], 屏宽/2, 110)`，白字居中。
    v.text(SHORTCUT_PROMPT,scene.scale.width/scale/2,110,0,26,'#ffffff').setOrigin(.5,0);
    // 六个圆槽：输入矩形 80×80，阴影与外圈是游戏 HUD 那两张 94×94（中心对齐），按下态叠加混合。
    for(let slot=0;slot<SHORTCUT_SLOT_COUNT;slot++){const point=positions[`slot-${slot}` as ControlId];
      const hit=v.button('',point.x/scale-40,point.y/scale-40,80,80,()=>this.assignShortcut(slot),
        {bare:true,pressed:skin['slot-pressed'],pressedRect:{x:-7,y:-7,width:94,height:94},pressedAdd:true}).setData('label',`快捷位 ${slot+1}`);
      hit.addAt(v.image(skin['slot-shadow'],-7,-7,94,94),0);hit.addAt(v.image(skin['slot-ring'],-7,-7,94,94),1);
      const entry=slots[slot];if(entry){const size=this.shortcutIconSize(entry),icon=this.shortcutIcon(entry);
        if(icon)hit.addAt(v.image(icon,(80-size)/2,(80-size)/2,size,size),2);}
    }
    // 换组按钮：75×75，动作是整组切换（`UIShortcutMenu_ButtonScrollExe @0x161368`）。
    const swap=v.button('',positions.swap.x/scale-37.5,positions.swap.y/scale-37.5,75,75,
      ()=>{this.shortcutEdit={...edit,page:(edit.page+1)%SHORTCUT_PAGE_COUNT};this.render();},
      {bare:true,pressed:skin['swap-pressed'],pressedAdd:true}).setData('label','切换技能组');
    swap.addAt(v.image(skin.swap,0,0,75,75),0);
    // 待登记的对象：原版把它画在一个单独的圆框容器里，位置见 `PENDING_OFFSET`。
    const size=this.shortcutIconSize(edit),icon=this.shortcutIcon(edit),pending={x:anchor.x+PENDING_OFFSET.x,y:anchor.y+PENDING_OFFSET.y};
    v.image(skin['slot-shadow'],pending.x-47,pending.y-47,94,94);
    v.image(skin['slot-ring'],pending.x-47,pending.y-47,94,94);
    if(icon)v.image(icon,pending.x-size/2,pending.y-size/2,size,size);
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
    const v=this.body!,bag=this.session!.bag,panels=this.app.menuPanels,member=this.member()!,equipment=bag.equipmentFor(this.selectedMemberId),art=this.memberArt();
    // 两栏背景照原版：`UIEquip_DrawEquipBackground @0x14a7cc` 给左栏画图框加四块黑色 60% 的区域
    // （`GRPX_FillRectAlpha(..., 0xff000000, 0x3c)`），中间 (129,110,157,157) 那块留空放人物预览；
    // 右栏只有图框——`UIEquip_DrawInvenBackground @0x14aed0` 不铺底，格子直接浮在背景上。
    v.staticLayer('bag',()=>{
      v.border(panels.assets,85,0,409,431,v.staticRoot);v.border(panels.assets,496,0,395,431,v.staticRoot);
      for(const [x,y,width,height] of [[24,24,361,86],[24,110,105,157],[286,110,99,157],[24,267,361,140]])
        v.rect(85+x,y,width,height,0x000000,.6,v.staticRoot);
      // 黑底之后叠四块 41×41 的角色图角（组 15 索引 48／49／53／54），画在框外 2 像素处。
      for(const [corner,x,y]of [['nw',83,-2],['ne',455,-2],['sw',83,392],['se',455,392]] as const)v.image(panels.assets[`character-${corner}`],x,y,41,41,v.staticRoot);
      // 等级／职业行的底板同样是固定装饰，文字在下面单独画。
      v.textPlate(panels.assets['text-plate-left'],panels.assets['text-plate-right'],131,368,323,v.staticRoot);
    });
    this.drawPartyColumn(v);
    const showingResult=itemResultDetails(this.itemResult,bag.catalog,id=>id,id=>id).length>0,
      describing=!showingResult&&!!this.selectedItem&&!!bag.get(this.selectedItem);
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
      const preview={x:214,y:110,width:157,height:157},appearance=this.app.equipmentAppearance?.(this.selectedMemberId),clip=appearance?.clips['idle-south'];
      if(appearance&&this.scene&&clip?.layers.every(layer=>this.scene!.textures.exists(layer.key))){
        // 合成立绘按预览洞缩放到刚好放得下、并在洞里居中：原版这个洞是 157×157（左框局部 129,110），
        // 立绘必须落在洞内，之前固定 3 倍放大、锚点 292,230 会让它探出洞外。
        // 立绘只在换人、换装备时重做：点格子、翻物品都会重画背包页，每次重建一批精灵会让背包明显卡顿。
        if(this.bagPortrait?.actor!==appearance){
          this.bagPortrait?.visual.container.destroy();
          const character=createCharacter(this.scene,appearance,{id:'equipment-preview',actor:appearance.id,x:0,y:0}),bounds=character.container.getBounds(),
            scale=Math.min(preview.width/Math.max(1,bounds.width),preview.height/Math.max(1,bounds.height));
          character.container.setScale(scale).setPosition(preview.x+(preview.width-bounds.width*scale)/2-bounds.x*scale,
            preview.y+(preview.height-bounds.height*scale)/2-bounds.y*scale);
          this.bagPortrait={actor:appearance,visual:character};
        }
        v.root.add(this.bagPortrait!.visual.container);
      }
      else v.image(this.selectedMemberId==='player'?panels.classes[member.classId].preview:art.partyIcon,214,110,157,157);
      for(const slot of panels.equipmentSlots){const entry=equipment[slot.id as EquipmentSlot],instance=entry?bag.get(entry):undefined,item=instance?bag.catalog.items[instance.item]:undefined;const button=v.button('',85+slot.x,slot.y,74,74,()=>{if(!entry)return;this.selectItem(entry,'right');},{image:slotFrameImage(this.app,this.session!,instance)});v.image(item?.icon??slot.emptyIcon,item?5:13,item?5:13,item?64:48,item?64:48,button);button.setData('label',slot.name);this.drops.push({object:button,entry,slot:slot.id as EquipmentSlot});}
      // 等级／职业行：`UIEquip_DrawEquip` 在左框内 (46,368) 画 323 宽的文本底板，文字居中于它、
      // 颜色 #e2cb9e、纵向上沿在底板顶边下 7 像素（`GRPX_DrawStringWithFont(..., y+375, 居中)`）。
      // 底板在静态层，这里只画会随成员变化的等级与职业文字。
      v.text(`Lv. ${member.level}　${this.app.storyClasses.classes.find(c=>c.id===member.classId)!.name}`,292,375,0,22,'#e2cb9e').setOrigin(.5,0);
    }
    if(showingResult){this.renderItemResult();}
    else if(describing)this.renderItemDetail(this.selectedItem!);
    const layout=bagLayout(),cells=layout.grid;
    const {slots,slotCount}=inventoryView({all:bag.allCells,...bag.pouchCells},this.filter),grid=this.scroll('inventory',cells.x,cells.y,cells.width,cells.height);
    for(let index=0;index<slotCount;index++){const slot=slots[index]!,x=index%cells.columns*cells.stride,y=Math.floor(index/cells.columns)*cells.stride;
      if(slot.kind==='cell'){
        this.drops.push({object:v.image(panels.assets['inventory-slot'],x,y,layout.slot.size,layout.slot.size,grid.content),view:slot.view,cell:slot.cell});
        continue;
      }const entry=slot.entry,item=bag.catalog.items[entry.item];
      const button=v.button('',x,y,layout.slot.size,layout.slot.size,()=>{if(this.suppressClick)return;this.selectItem(entry.id,'left');},{image:slotFrameImage(this.app,this.session!,entry),parent:grid.content,guard:grid.guard}).setData('label',item.name);v.image(item.icon,layout.slot.icon.x,layout.slot.icon.y,layout.slot.icon.size,layout.slot.icon.size,button);if(entry.id===this.selectedItem)v.image(panels.assets['inventory-selected'],layout.slot.selection.x,layout.slot.selection.y,layout.slot.selection.size,layout.slot.selection.size,button);this.drops.push({object:button,entry:entry.id,view:slot.view,cell:slot.cell});
      if(item.stackable)v.text(String(entry.quantity),layout.badge.x,layout.badge.y,0,20,layout.badge.color,button).setOrigin(1,0);if(entry.enhancement)v.text(`+${entry.enhancement}`,2,2,0,17,undefined,button);if(entry.gems.length)v.text('◆'.repeat(entry.gems.length),2,52,0,16,undefined,button);
      if(!panelCoversBag)button.on('pointerdown',(pointer:Phaser.Input.Pointer)=>this.startDrag(pointer,entry.id,grid));
    }
    this.finishScroll('inventory',grid,Math.ceil(slotCount/cells.columns)*cells.stride);
    // 原版金额先画币再画数字：金 530 / 银 633 / 铜 736，数字在币右侧 44、下移 6、白色。
    const money=splitMoney(this.session!.money);
    (['gold','silver','copper'] as const).forEach((unit,index)=>{
      v.image(this.content!.assets[`money-${unit}`],layout.money.x+index*layout.money.stride,layout.money.y,layout.money.coin.width,layout.money.coin.height);
      v.text(String(money[unit]),layout.money.x+index*layout.money.stride+layout.money.digit.x,layout.money.y+layout.money.digit.y,0,20,layout.money.color);
    });
    const organize=layout.organize;
    v.button('整理',organize.x,organize.y,organize.width,organize.height,()=>this.action(()=>bag.organize()));
    // 侧边按钮列：位置与尺寸按原版的按钮列（6 个 57×57，起点 885,12），次序见 INVENTORY_SIDE_FILTERS。
    // 每个按钮画法照 `UIEquip_DrawInvenBackground` + `UIEquip_DrawInvenBag`：常态外框是图组 15 索引 20、
    // 选中态在同一个位置叠索引 19，两者都是 72×84、落在按钮矩形 −(5,12)。原版按钮里是袋子图标加页号，
    // 本作这一列改成分类筛选，所以按钮里放分类名。
    const side=layout.sideButtons;
    // 说明面板盖背包栏时右缘停在 880（BAG_DESCRIPTION_WIDTH），正是这一列外框的左缘，两者不重叠，
    // 所以这一列始终照画、始终可点——装备详情盖过来时也不收起来。
    INVENTORY_SIDE_FILTERS.forEach((filter,index)=>{
      const button=v.button('',side.x,side.y+side.offsets[index],side.width,side.height,()=>{this.cancelDrag();this.filter=filter;this.itemResult=undefined;this.selectedItem=undefined;this.itemNotice=undefined;this.scrollOffsets.delete('bag:inventory');this.render();},{bare:true});
      v.image(panels.assets['page-button-frame'],-5,-12,undefined,undefined,button);
      if(this.filter===filter)v.image(panels.assets['page-button-selected'],-5,-12,undefined,undefined,button);
      v.text(INVENTORY_LABELS[filter],side.width/2,side.height/2,side.width-6,SIDE_FILTER_TEXT_SIZE,undefined,button).setOrigin(.5);
      button.setData('label',INVENTORY_LABELS[filter]);
    });
    // 原版在第一个／最后一个按钮被选中时，会在这一列的两端各补一块 21×34 的角件
    // （`UIEquip_DrawInvenBag 0x14b3d8`／`0x14b420`、`UIStore_DrawInvenBagGroup 0x1675b4`／`0x1675fc`），
    // 画在按钮矩形 (−19,−12) 与 (−19,+38) 上。
    if(this.filter===INVENTORY_SIDE_FILTERS[0])v.image(panels.assets['column-cap-top'],side.x-19,side.y-12,21,34);
    if(this.filter===INVENTORY_SIDE_FILTERS.at(-1))v.image(panels.assets['column-cap-bottom'],side.x-19,side.y+side.offsets.at(-1)!+38,21,34);
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
    drawDescriptionPanel(v,this.app.menuPanels.assets,left,top,panel.width);
    // 滚动区必须建在说明层上（末尾的 `v`）：面板底色、图框与物品名都画在这一层，
    // 滚动区若留在内容块那一层（默认值）会被面板自己的黑底压住，正文看起来就是灰的。
    const detail=this.scroll('item',left+panel.scroll.x,top+panel.scroll.y,panel.scroll.width,panel.scroll.height,v);
    // 标题、颜色与正文由同一个实例说明生成器提供；当前查看的成员决定职业与等级条件。
    const body=itemDescriptionBody({item,entry,numbers:this.app.characterStats.equipment[entry.item],catalog:this.app.characterStats,
      grades:this.app.shops.grades,member:this.member(),classNames:this.classNames(),gemNames:entry.gems.map(id=>bag.catalog.items[id]?.name),skill:entry.skill?bag.catalog.skillDescriptions?.[entry.skill]:undefined});
    drawDescriptionTitle(v,body.title,left,top,panel.width,body.color);
    let y=drawDescriptionRows(v,body.rows,panel.scroll.width,detail.content);
    this.finishScroll('item',detail,y);
    // 关闭按钮挂在面板右上角：那枚 67×67 的圆钮（原版矩形 349,−6，本作右移到贴边）。
    drawDescriptionClose(v,this.app.menuPanels.assets,panel,left,top,()=>{this.itemNotice=undefined;this.selectedItem=undefined;this.render();});
    // 底部操作行：常规 125×55、步长 126；4 个动作时整行改 92×55 文字按钮，避免 149×75 的图互相压住。
    const actions=this.bagMenu(entry,worn),rowY=top+panel.menu.y;
    if(actions.length){
      const dense=actions.length>3,width=dense?92:panel.menu.button.width,height=panel.menu.button.height,
        stride=dense?94:panel.menu.button.stride,rowX=left+panel.menu.x+(dense?0:panel.menu.offsets[Math.min(actions.length,3)]);
      actions.forEach((action,index)=>{
        v.button(action.label,rowX+index*stride,rowY,width,height,action.run,{fontSize:dense?14:18,disabled:action.disabled}).setData('label',action.label);
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
    drawDescriptionTitle(v,body.title,left,top,panel.width,body.color);
    const height=drawDescriptionRows(v,body.rows,panel.scroll.width,detail.content);
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
    if(item.use&&!NON_MENU_USE_KINDS.has(item.use.kind)&&!worn)actions.push({label:USE_LABELS[item.use.kind],run:()=>this.beginOperation(entry.id),disabled:!!this.itemUseProblem(entry)});
    // 快捷键：与技能页同一套文案与同一屏。已配到任一组的这枚按钮改成「取消快捷键」，点了直接清掉
    // （原版 `UIEquip_ButtonRemoveShortCutExe 0x14c514` → `PLAYER_RemoveShortcutAll(char, 2, 物品编号)`）。
    if(item.shortcut&&!worn){
      const assigned=this.shortcutBar().assigned('item',entry.item);
      actions.push({label:assigned?'取消快捷键':'快捷键',
        run:()=>assigned?this.clearShortcut('item',entry.item):this.openShortcutScreen('item',entry.item)});
    }
    if(item.discardable&&!worn)actions.push({label:'丢弃',run:()=>this.beginOperation(entry.id,'discard')});
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
    this.forge=new ForgePanel(bag,this.app.menuPanels,this.app.characterStats,this.selectedMemberId,
      ()=>this.render(),()=>this.app.audio?.ui('enchant'),(message)=>this.app.ui.showInstant(message),preview);
    this.forge.open(targetId,tab);this.page='forge';this.render();
  }
  private closeForge():void {
    const targetId=this.forge?.targetId;
    this.forge=undefined;this.page='bag';if(targetId)this.selectedItem=targetId;this.render();
  }
  private async changeEquipment(entry:string|undefined,slot:EquipmentSlot):Promise<void>{
    if(this.busy)return;this.busy=true;this.cancelDrag();const signal=this.request.signal;this.render();
    try{await this.app.changeEquipment!(entry,slot,signal,this.selectedMemberId);if(signal.aborted)return;this.selectedItem=undefined;this.notice='';}
    catch(error){if(!signal.aborted)this.notice=(error as Error).message;}finally{if(!signal.aborted){this.busy=false;this.render();}}
  }
  private beginOperation(entry:string,kind:'use'|'discard'='use'):void{
    this.cancelDrag();
    const instance=this.session!.bag.get(entry)!;
    if(kind==='use'&&this.itemUseProblem(instance))return;
    const use=this.session!.bag.catalog.items[instance.item].use;
    // 回血药水与再生药水都走队伍结算：全队生效、共用一个时钟。
    if(kind==='use'&&(use?.kind==='recover-health'||use?.kind==='regenerate')){this.app.useRecoveryItem?.(entry,this.selectedMemberId);this.render();return;}
    if(kind==='use'&&use&&NON_MENU_USE_KINDS.has(use.kind))return;
    this.operation={entry,kind,quantity:1};this.scrollOffsets.delete('bag:operation');this.render();
  }
  private renderOperation():void{
    // 弹层画布的锚点由这里的框尺寸决定，不再写死；框从左上角开始画。
    const v=this.modal!,box=tradeLayout.quantity,op=this.operation!,bag=this.session!.bag;this.beginModal(box.width,box.height);v.visible(true);
    // 与商店的数量框同一个原版弹层：同样的图组 19 外框，同样的内缩 35 黑底。
    drawPopupPanel(v,this.app.menuPanels.assets,box.width,box.height);
    // 正文与按钮都躲进黑底：黑底占 (35,35,380,280)，底部按钮行在第 275 行。
    const inner=box.plate,scroll=this.scroll('operation',inner.x,inner.y+37,inner.width,inner.height-80,v);let y=0;
    const line=(value:string,size=22)=>{const text=v.text(value,0,y,inner.width,size,undefined,scroll.content);y+=text.height+13;};
    const reward=(items:{item:string;quantity:number}[])=>items.forEach(entry=>{v.image(bag.catalog.items[entry.item].icon,0,y,44,44,scroll.content);v.text(`${bag.catalog.items[entry.item].name} × ${entry.quantity}`,60,y+6,inner.width-60,22,undefined,scroll.content);y+=57;});

    const entry=bag.get(op.entry);if(!entry){this.operation=undefined;v.visible(false);return;}const item=bag.catalog.items[entry.item],use=item.use;
    v.text(op.kind==='discard'?'丢弃物品':USE_LABELS[use!.kind],inner.x,inner.y+5,inner.width,26);line(item.name,25);line(item.description||'确认后执行本次操作。');
    if(op.kind==='discard'){line(`确定丢弃 ${item.name}？`);if(entry.quantity>1){v.button('−',0,y,80,48,()=>{op.quantity=Math.max(1,op.quantity-1);this.render();},{parent:scroll.content,guard:scroll.guard});v.text(String(op.quantity),108,y+8,0,24,undefined,scroll.content);v.button('＋',190,y,80,48,()=>{op.quantity=Math.min(entry.quantity,op.quantity+1);this.render();},{parent:scroll.content,guard:scroll.guard});v.button('全部',260,y,inner.width-260,48,()=>{op.quantity=entry.quantity;this.render();},{parent:scroll.content,guard:scroll.guard});y+=64;}}
    else if(use?.kind==='learn'){const classId=use.classId||this.member()!.classId,skills=this.app.battleCatalog.classes.find(c=>c.id===classId)!.skills;line('请选择技能');for(const id of entry.skill?skills.filter(id=>id===entry.skill):skills){v.button(this.app.battleCatalog.skills[id].name,0,y,inner.width,50,()=>{op.skill=id;this.render();},{selected:(entry.skill||op.skill)===id,disabled:!!this.bookProblem(id),parent:scroll.content,guard:scroll.guard});y+=62;}const selected=entry.skill||op.skill;if(selected)line(this.bookProblem(selected)||'技能提升 1 级，不消耗技能点。');}
    else if(use?.kind==='pack'||use?.kind==='box'){line(use.kind==='pack'?'礼盒内含以下物品：':'获得下列物品中的一种：');reward(use.rewards!);}
    else if(use?.kind==='recipe'){line('随机展开下列一种配方：');for(const id of use.recipes!)line(`${bag.catalog.recipes[id].name}${bag.learnedRecipes.includes(id)?' · 已收录':''}`);}
    else if(use?.kind==='recruit')line(`加入佣兵名册 · ${use.classId?this.app.storyClasses.classes.find(c=>c.id===use.classId)!.name:'随机职业'}`);
    else if(use?.kind==='revive'){
      if(entry.item==='resurrection-prayer')line('全队阵亡时，在阵亡界面使用。');
      else{
        const party=this.session!.party!,fallen=party.activeIds.filter(id=>!party.alive(id));
        op.member=fallen[0];
        const name=op.member==='player'?this.world!.actors[this.session!.campaign.start.actor].name:op.member?party.get(op.member)!.definition.name:undefined;
        line(name?`复活目标：${name}`:'当前没有阵亡的出战队员');
      }
    }
    else if(use?.kind==='reset-skills'){line(`确定为${this.world!.actors[this.session!.campaign.start.actor].name}初始化技能？`);line('清空已学技能与快捷栏，返还正常加点；卓越灵药增加的技能点会消失。');}
    else if(entry.item===SKILL_POINT_ITEM)line(`确定对${this.world!.actors[this.session!.campaign.start.actor].name}使用${item.name}？`);
    if(op.error)line(op.error);this.finishScroll('operation',scroll,y);
    const using=op.kind==='use',skill=entry.skill||op.skill||'';
    const learningBlocked=using&&use?.kind==='learn'&&(!bag.catalog.classSkills[this.member()!.classId]?.includes(skill)||!!this.bookProblem(skill));
    const revivalBlocked=using&&use?.kind==='revive'&&(entry.item==='resurrection-prayer'||!op.member);
    const disabled=op.confirmed||this.busy||(using&&!!this.itemUseProblem(entry))||learningBlocked||revivalBlocked;
    // 底部按钮沿用原版数量框的排布：确定在左、取消在右，125×55。
    v.button('取消',box.button.right,box.button.y,box.button.width,box.button.height,()=>{this.operation=undefined;this.render();});
    v.button('确定',box.button.left,box.button.y,box.button.width,box.button.height,()=>this.confirmOperation(),{disabled:!!disabled});
  }
  private itemUseProblem(entry:ItemInstance):string|undefined{
    const definition=this.session!.bag.catalog.items[entry.item];
    // 用途还没逆出来的物品不开使用菜单，免得点下去只是白丢一件。
    const unimplemented=unimplementedItemUse(entry.item,definition);
    if(unimplemented)return unimplemented;
    const kind=definition.use?.kind;
    if(this.selectedMemberId!=='player'&&(kind==='reset-skills'||kind==='learn'||entry.item===SKILL_POINT_ITEM))return '该道具仅能用于主角';
  }
  private bookProblem(id:string):string|undefined{return this.selectedMemberId==='player'?this.session!.skills.bookProblem(id):'主角技能书仅能用于主角';}
  private renderItemResult():void {
    // 与说明面板同一套矩形，免得看结果时又跳回旧位置。
    const v=this.description!,layout=bagLayout(),covered=this.descSide==='left'?layout.leftFrame:layout.bagFrame,
      panel=descriptionPanel(this.descSide==='left'?covered.width:BAG_DESCRIPTION_WIDTH),left=covered.x,top=panel.y;
    drawDescriptionPanel(v,this.app.menuPanels.assets,left,top,panel.width);
    // 同物品说明：滚动区也建在说明层上，否则正文会被面板底色压暗。
    const detail=this.scroll('item',left+panel.scroll.x,top+panel.scroll.y,panel.scroll.width,panel.scroll.height,v);let y=0;
    for(const line of itemResultDetails(this.itemResult,this.session!.bag.catalog,
      id=>this.app.battleCatalog.skills[id]?.name??id,id=>this.app.storyClasses.classes.find(c=>c.id===id)?.name??id)){
      const text=v.text(line,0,y,panel.scroll.width,22,undefined,detail.content);y+=text.height+13;
    }
    this.finishScroll('item',detail,y);
    drawDescriptionClose(v,this.app.menuPanels.assets,panel,left,top,()=>{this.itemResult=undefined;this.render();});
  }
  private confirmOperation():void{
    const op=this.operation;if(!op||op.confirmed||this.busy)return;const bag=this.session!.bag,entry=bag.get(op.entry);if(!entry)return;
    op.confirmed=true;this.busy=true;
    try{
      if(op.kind==='use'){const problem=this.itemUseProblem(entry);if(problem)throw new Error(problem);}
      const kind=bag.catalog.items[entry.item].use?.kind;
      this.itemResult=undefined;
      if(op.kind==='discard')bag.discard(op.entry,op.quantity);
      else if(kind==='recruit'){
        const {member}=this.session!.party!.recruit(op.entry);
        this.operation=undefined;this.selectedItem=undefined;this.page='party';this.partyPanel!.select(member.id);
      }else if(kind==='revive'){
        const target=op.member!;
        if(this.app.revivePartyMember)this.app.revivePartyMember(target,op.entry);else{
          const session=this.session!,party=session.party!,fallen=party.activeIds.filter(id=>!party.alive(id));
          party.revive(target,op.entry);
          for(const id of fallen)if(party.alive(id))session.reviveCombatActor(id);
        }
      }else this.itemResult=bag.use(op.entry,undefined,op.skill);
      this.selectedItem=bag.get(op.entry)?op.entry:undefined;
      this.operation=undefined;
      if(op.kind==='use'&&kind==='merchant'){this.busy=false;this.openShop(this.app.shops.lampShop,'');return;}
    }
    catch(error){op.error=(error as Error).message;op.confirmed=false;}finally{this.busy=false;}this.render();
  }
  private startDrag(pointer:Phaser.Input.Pointer,entry:string,scroll:ScrollArea):void{
    if(this.busy||this.operation||this.itemNotice||!scroll.contains(pointer))return;this.cancelDrag();this.suppressClick=false;
    const timer=this.scene!.time.delayedCall(350,()=>{
      if(!this.drag||this.app.ui.suspended)return;
      this.suppressClick=true;this.drag.active=true;scroll.cancelGesture();
      this.selectedItem=undefined;this.itemResult=undefined;this.render();
      const item=this.session!.bag.catalog.items[this.session!.bag.get(entry)!.item];
      const icon=uiImageFor(this.scene!,item.icon);this.drag.ghost=this.scene!.add.image(pointer.x,pointer.y,icon.key,icon.frame).setDisplaySize(72*this.surface!.root.scaleX,72*this.surface!.root.scaleY).setAlpha(.8).setDepth(800);
    });
    this.drag={entry,pointer:pointer.id,x:pointer.x,y:pointer.y,timer,active:false};
  }
  private moveDrag(pointer:Phaser.Input.Pointer):void{const drag=this.drag;if(!drag||drag.pointer!==pointer.id)return;if(!drag.active&&Math.hypot(pointer.x-drag.x,pointer.y-drag.y)>8*this.surface!.root.scaleX)this.cancelDrag();else if(drag.active)drag.ghost?.setPosition(pointer.x,pointer.y);}
  private endDrag(pointer:Phaser.Input.Pointer):void{
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
    this.cancelOperation();this.selectedMemberId=id;this.selectedItem=undefined;this.skill=undefined;this.skillSection='directory';this.show(page);
    const signal=this.request.signal;
    void this.app.preparePartyMember?.(id,signal).then(()=>{if(!signal.aborted&&this.selectedMemberId===id)this.render();})
      .catch(error=>{if(!signal.aborted){this.notice=(error as Error).message;this.render();}});
  }
  private action(action:()=>void):void{if(this.busy)return;this.busy=true;try{action();}catch(error){this.notice=(error as Error).message;}finally{this.busy=false;}if(this.open)this.render();}
  private renderParty():void{
    this.partyPanel?.render(this.body!,this.modal!,this.placeModal);
  }
  private renderQuests():void{
    this.questPanel?.render(this.body!);
  }
}
