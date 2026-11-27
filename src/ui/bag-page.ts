import { UiNode, UiImage, type UiPointer, type UiSceneHost } from './dom/node.ts';

import { ShortcutBar, type ShortcutEntry } from '../domain/shortcut-bar.ts';

import { memberArt as memberArtwork } from '../domain/menu-panels.ts';

import type { StoryUIContext } from '../application/ports.ts';
import type { Session } from '../domain/session.ts';
import type { WorldIndex } from '../domain/content.ts';
import type { StoryInterface } from '../domain/story-interface.ts';
import type { CompanionMember } from '../domain/party.ts';

import { inventoryView, INVENTORY_LABELS, INVENTORY_SIDE_FILTERS, type InventoryView } from '../domain/inventory.ts';
import { EQUIPMENT_SLOTS, SKILL_POINT_ITEM, USE_LABELS, unimplementedItemUse, type EquipmentSlot, type ItemInstance, type ItemResult } from '../domain/items.ts';

import { GOLD, UiSurface, type ScrollArea } from './widgets.ts';
import { MenuTextLayer, type MenuTextOcclude, type MenuTextSpec, type MenuTextWriter } from './dom/menu-text.ts';

import { descriptionTitleOverflow, drawDescriptionClose, drawDescriptionPanel, drawDescriptionRows, drawDescriptionTitle } from './panels/description-panel.ts';
import { layoutDescriptionTextForSurface } from './panels/description-text.ts';

import { drawBagRail } from './panels/bag-rail.ts';

import { drawPopupPanel } from './panels/popup-panel.ts';

import { itemResultDetails } from './item-result-details.ts';
import { itemDescriptionBody } from './item-detail-lines.ts';
import { slotFrameImage, updateEquipmentLock } from './slot-frame.ts';
import { bagLayout, BAG_DESCRIPTION_WIDTH, descriptionActionLayout, descriptionActionLabelSize, descriptionPanel, SIDE_FILTER_TEXT_SIZE } from './bag-layout.ts';

import type { DescriptionTextPart } from '../domain/description-text.ts';
import { tradeLayout } from './shop-layout.ts';
import { TEXT_COLORS } from './text-style.ts';
import { splitMoney } from '../domain/money.ts';
import type { LiveCharacterPreview } from './phaser/live-character-preview.ts';

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

export type BagPageContext=Pick<StoryUIContext,'menuPanels'|'storyClasses'|'characterStats'|'shops'|'battleCatalog'|'changeEquipment'|'previewAppearance'|'equipmentAppearance'|'useRecoveryItem'|'preparePartyMember'|'revivePartyMember'|'summonLampMerchant'|'audio'>;
export type BagDropTarget={object:UiNode|UiImage;entry?:string;slot?:EquipmentSlot;view?:InventoryView;cell?:number;craft?:boolean};
export interface BagPageHost {
 readonly selectedMemberId:string;
 active():boolean;
 readonly page:string;
 readonly suppressClick:boolean;
 notice:string;
 itemNotice:string|undefined;
 render(rebuild?:boolean):void;
 sync():void;
 cancelDrag():void;
 startDrag(pointer:UiPointer,entry:string,scroll?:ScrollArea):void;
 view:{
  readonly body:UiSurface|undefined;readonly description:UiSurface|undefined;readonly modal:UiSurface|undefined;
  readonly menuText:MenuTextLayer|undefined;readonly scene:UiSceneHost|undefined;readonly bagPortrait:LiveCharacterPreview|undefined;
  drops:BagDropTarget[];
  scroll(name:string,x:number,y:number,w:number,h:number,surface?:UiSurface,bleed?:number,bar?:Parameters<UiSurface['scroll']>[5]):ScrollArea;
  finishScroll(name:string,scroll:ScrollArea,height:number):void;
  deleteScroll(name:string):void;removeScroll(name:string):void;removeDescriptionScrolls():void;
  drawPartyColumn(v:UiSurface,nodes?:UiNode[]):void;
  beginModal(width:number,height:number):void;
  renderTabsText(writer:MenuTextWriter):void;renderNoticeText(writer:MenuTextWriter):void;
 };
 navigation:{
  openForge(entry:string):void;openSkillBook(entry:string):void;openShortcutScreen(kind:ShortcutEntry['kind'],id:string):void;
  clearShortcut(kind:ShortcutEntry['kind'],id:string):void;shortcutBar():ShortcutBar;
  recruited(member:string):void;closeMenu():void;
 };
}
export class BagPage {
 private readonly content:StoryInterface;private readonly session:Session;private readonly world:WorldIndex;private readonly app:BagPageContext;private readonly host:BagPageHost;
 private itemResult?:ItemResult;private filter:InventoryView='all';private selectedItem?:string;private descSide:'left'|'right'='left';
 private operation?:Operation;private busy=false;private request=new AbortController();private bagPageCached=false;
 private bagTextSpecs:MenuTextSpec[]=[];private operationTextSpecs:MenuTextSpec[]=[];private bagDetailTextSpecs:MenuTextSpec[]=[];private bagDetailOpen=false;
 private bagPreview?:UiNode;private bagSelection?:UiImage;private bagFilterHighlight?:UiNode;
 private bagEquipment=new Map<EquipmentSlot,{button:UiNode;icon:UiImage;drop:{object:UiNode;entry?:string;slot:EquipmentSlot}}>();
 private bagSlots:BagSlotView[]=[];private bagGrid?:ScrollArea;private bagMemberId='player';private bagFilterView:InventoryView='all';private bagPartyNodes:UiNode[]=[];private bagPartyKey='';
 private lastSignature='';private pendingSignature='';
 constructor(session:Session,world:WorldIndex,app:BagPageContext,host:BagPageHost,content:StoryInterface){this.content=content;this.session=session;this.world=world;this.app=app;this.host=host;}
 get signature():string{return this.lastSignature;}
 get isBusy():boolean{return this.busy;}
 get cached():boolean{return this.bagPageCached;}
 get hasGrid():boolean{return !!this.bagGrid;}
 get hasSelection():boolean{return !!this.selectedItem;}
 get hasResult():boolean{return !!this.itemResult;}
 get operationOpen():boolean{return !!this.operation;}
 get operationTexts():readonly MenuTextSpec[]{return this.operationTextSpecs;}
 refresh(signature:string,force=false):void{if(this.busy){this.pendingSignature=signature;return;}if(!force&&this.lastSignature===signature)return;this.host.render();this.lastSignature=signature;this.pendingSignature='';}
 rememberSignature(signature:string):void{this.lastSignature=signature;this.pendingSignature='';}
 resetView():void{this.bagPageCached=false;this.bagSlots=[];this.bagGrid=undefined;this.bagEquipment.clear();this.bagPreview=undefined;this.bagSelection=undefined;this.bagPartyNodes=[];}
 markCached():void{this.bagPageCached=true;}
 cancel():void{this.request.abort();this.request=new AbortController();this.busy=false;this.operation=undefined;this.pendingSignature='';}
 prepareChild(entry?:string):void{this.cancel();this.selectedItem=entry;this.itemResult=undefined;}
 resume(entry?:string):void{this.selectedItem=entry;}
 clearSelection():void{this.selectedItem=undefined;}
 clearResult():void{this.itemResult=undefined;}
 destroy():void{this.cancel();this.clearBagTransientState();this.resetView();}
 resetScroll():void{if(this.bagGrid)this.bagGrid.scrollTop=0;}
 selectMember(id:string,commit:(id:string)=>void):void{
  const restore=this.bagDetailOpen&&!!this.selectedItem&&!this.itemResult;
  const result=this.bagDetailOpen&&!!this.itemResult;
  const update=this.host.active()&&(restore||result||!this.bagDetailOpen&&this.bagEquipment.size>0);
  this.cancel();commit(id);this.selectedItem=undefined;
  if(update){
   if(restore)this.closeBagDetailForMember();
   if(result){this.bagSelection?.destroy();this.bagSelection=undefined;}
   this.updateBagMember();this.host.sync();
  }else this.host.render();
  const signal=this.request.signal;
  void this.app.preparePartyMember?.(id,signal).then(()=>{
   if(!signal.aborted&&this.host.active()&&this.host.selectedMemberId===id)this.renderBagPreview();
  }).catch(error=>{
   if(!signal.aborted&&this.host.active()&&this.host.selectedMemberId===id){this.host.notice=(error as Error).message;this.host.view.menuText?.renderPage('bag');}
  });
 }
 private member(){return this.host.selectedMemberId==='player'?this.session.hero:this.session.party?.get(this.host.selectedMemberId);}
 private memberArt(){const member=this.member()!;return memberArtwork(this.app.menuPanels,this.world.actors[this.host.selectedMemberId==='player'?this.session.campaign.start.actor:(member as CompanionMember).definition.actor],member.classId,this.host.selectedMemberId==='player'?undefined:(member as CompanionMember).source);}
 private action(action:()=>void):void{if(this.busy)return;this.busy=true;try{action();}catch(error){this.host.notice=(error as Error).message;}finally{this.busy=false;this.host.render();}}
clearBagTransientState():void{
    this.selectedItem=undefined;this.itemResult=undefined;this.bagDetailOpen=false;
    this.host.view.deleteScroll('inventory');this.host.view.deleteScroll('item');
  }
private descriptionCovers(spec:MenuTextSpec,rect:{x:number;y:number;width:number;height:number}):boolean {
    return spec.x>=rect.x&&spec.x<=rect.x+rect.width&&spec.y>=rect.y&&spec.y<=rect.y+rect.height;
  }
private bagDescriptionCovers(spec:MenuTextSpec):boolean {
    const layout=bagLayout(),covered=this.descSide==='left'?layout.leftFrame:layout.bagFrame,
      panel=descriptionPanel(this.descSide==='left'?covered.width:BAG_DESCRIPTION_WIDTH);
    return this.descriptionCovers(spec,{x:covered.x,y:panel.y,width:panel.width,height:panel.height});
  }
renderBagText(writer:MenuTextWriter,options?:{dim?:boolean;occlude?:MenuTextOcclude}):void {
    const page:MenuTextWriter={add:spec=>writer.add(
      options?.dim||options?.occlude?{...spec,dim:options.dim,occlude:options.occlude}:spec)};
    this.host.view.renderTabsText(page);
    for(const spec of this.bagTextSpecs)
      if(!this.bagDetailOpen||!this.bagDescriptionCovers(spec))page.add(spec);
    if(this.bagDetailOpen)for(const spec of this.bagDetailTextSpecs)page.add(spec);
    this.host.view.renderNoticeText(page);
  }
private classNames(){return Object.fromEntries(this.app.storyClasses.classes.map(value=>[value.id,value.name]));}
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
private descriptionLayout(view:UiSurface,parts:readonly DescriptionTextPart[],width:number,size:number):
    {lines:{runs:{text:string;color?:string;x:number}[]}[];lineHeight:number;height:number}{
    return layoutDescriptionTextForSurface(view,parts,width,size);
  }
renderBag():void{
    this.bagTextSpecs=[];this.bagDetailTextSpecs=[];this.bagDetailOpen=false;this.bagEquipment.clear();this.bagSelection=undefined;
    this.bagSlots=[];this.bagGrid=undefined;this.bagPreview=undefined;this.bagPartyNodes=[];
    const v=this.host.view.body!,bag=this.session!.bag,panels=this.app.menuPanels;
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
    this.host.view.drawPartyColumn(v,this.bagPartyNodes);
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
      grid=this.host.view.scroll('inventory',cells.x,cells.y,cells.width,cells.height,this.host.view.body!,0,
        {offset:10,insetY:4,width:4});
    this.bagGrid=grid;
    for(let index=0;index<slotCount;index++)this.bagSlots.push(this.createBagSlotView(slots[index]!,index,panelCoversBag));
    this.updateBagSelection();
    this.host.view.finishScroll('inventory',grid,Math.ceil(slotCount/cells.columns)*cells.stride);
    this.addBagMoneyTexts(panelCoversBag);
    this.bagMemberId=this.host.selectedMemberId;this.bagFilterView=this.filter;
    const organize=layout.organize;
    v.button('',organize.x,organize.y,organize.width,organize.height,()=>this.action(()=>bag.organize()))
      .setData('label','整理');
    this.bagTextSpecs.push({key:'bag-organize',text:'整理',x:organize.x+organize.width/2,y:organize.y+organize.height/2,
      style:{size:Math.min(22,organize.height*.42),anchorX:.5,anchorY:.5,width:organize.width-12,align:'center',wrap:'word'}});
    const side=layout.sideButtons;
    this.bagFilterHighlight=v.rect(side.x,side.y+side.offsets[INVENTORY_SIDE_FILTERS.indexOf(this.filter)],side.width,side.height,0xe2c88d,.10);
    INVENTORY_SIDE_FILTERS.forEach((filter,index)=>{
      const rowY=side.y+side.offsets[index];
      const button=v.button('',side.x,rowY,side.width,side.height,()=>{this.host.cancelDrag();this.filter=filter;this.itemResult=undefined;this.selectedItem=undefined;this.host.itemNotice=undefined;this.host.view.deleteScroll('inventory');this.host.render();},{bare:true});
      this.bagTextSpecs.push({key:`bag-filter-${filter}`,text:INVENTORY_LABELS[filter],
        x:side.x+side.width/2,y:rowY+side.height/2,
        style:{size:SIDE_FILTER_TEXT_SIZE,anchorX:.5,anchorY:.5,width:side.width-6,align:'center',wrap:'word'}});
      button.setData('label',INVENTORY_LABELS[filter]);
    });
  }
private bagPartyState():string{return (this.session!.party?.activeIds??['player']).join('|');}
private createBagSlotView(slot:BagDataSlot,index:number,panelCoversBag:boolean):BagSlotView{
    const v=this.host.view.body!,bag=this.session!.bag,layout=bagLayout(),grid=this.bagGrid!,
      x=index%layout.grid.columns*layout.grid.stride,y=Math.floor(index/layout.grid.columns)*layout.grid.stride;
    if(slot.kind==='cell'){
      const object=v.image(this.app.menuPanels.assets['inventory-slot'],x,y,layout.slot.size,layout.slot.size,grid.content);
      const drop={object,view:slot.view,cell:slot.cell};this.host.view.drops.push(drop);
      return {kind:'cell',object,view:slot.view,cell:slot.cell,drop};
    }
    const entry=slot.entry,item=bag.catalog.items[entry.item];
    const button=v.button('',x,y,layout.slot.size,layout.slot.size,()=>{if(this.host.suppressClick)return;this.selectItem(entry.id,'left');},
      {image:slotFrameImage(this.app,this.session!,entry),parent:grid.content,guard:grid.guard}).setData('label',item.name);
    const icon=v.image(item.icon,layout.slot.icon.x,layout.slot.icon.y,layout.slot.icon.size,layout.slot.icon.size,button);
    const drop={object:button,entry:entry.id,view:slot.view,cell:slot.cell};this.host.view.drops.push(drop);
    button.on('pointerdown',(pointer:UiPointer)=>{if(!this.bagDetailOpen||this.descSide!=='right')this.host.startDrag(pointer,entry.id,grid);});
    updateEquipmentLock(v,button,!!entry.locked);
    this.addBagSlotText(slot,x,y,panelCoversBag);
    return {kind:'item',button,icon,entryId:entry.id,view:slot.view,cell:slot.cell,drop};
  }
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
    updateEquipmentLock(this.host.view.body!,view.button,!!entry.locked);
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
    this.host.view.drops=this.host.view.drops.filter(drop=>drop!==view.drop);
  }
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
private addBagMoneyTexts(panelCoversBag:boolean):void{
    const v=this.host.view.body!,layout=bagLayout(),money=splitMoney(this.session!.money);
    (['gold','silver','copper'] as const).forEach((unit,index)=>{
      if(!this.bagPageCached)v.image(this.content.assets[`money-${unit}`],layout.money.x+index*layout.money.stride,layout.money.y,layout.money.coin.width,layout.money.coin.height);
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
    this.bagSelection=this.host.view.body!.image(this.app.menuPanels.assets['inventory-selected'],
      selection.x,selection.y,selection.size,selection.size,view.button);
  }
updateBagPage():void{
    // 队员栏在网格之前画、层级也压在网格下面；队伍人数或顺序变了就整页重画一次，
    // 避免为了几个头像把后来的节点盖到装备和格子上。
    if(this.bagPartyState()!==this.bagPartyKey){this.host.render(true);return;}
    const bag=this.session!.bag,grid=this.bagGrid!,layout=bagLayout(),cells=layout.grid;
    const filterChanged=this.bagFilterView!==this.filter;
    if(filterChanged){
      const side=layout.sideButtons;
      this.bagFilterHighlight?.setPosition(side.x,side.y+side.offsets[INVENTORY_SIDE_FILTERS.indexOf(this.filter)]);
      grid.scrollTop=0;
    }
    const {slots,slotCount}=inventoryView({all:bag.allCells,...bag.pouchCells},this.filter);
    const showingResult=itemResultDetails(this.itemResult,bag.catalog,id=>id,id=>id).length>0;
    const wasDetail=this.bagDetailOpen,describing=!showingResult&&!!this.selectedItem&&!!bag.get(this.selectedItem);
    this.bagDetailOpen=describing||showingResult;
    const panelCoversBag=(describing||showingResult)&&this.descSide==='right';
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
    this.host.view.body!.pruneDestroyed();
    this.bagSlots=next;
    this.addBagMoneyTexts(panelCoversBag);
    this.updateBagSelection();
    if(showingResult||describing){
      this.bagDetailTextSpecs=[];this.host.view.description!.clear();this.host.view.removeDescriptionScrolls();
      if(showingResult)this.renderItemResult();else this.renderItemDetail(this.selectedItem!);
    }else if(wasDetail){
      this.bagDetailTextSpecs=[];this.host.view.description!.clear();this.host.view.removeDescriptionScrolls();
    }
    if(this.bagEquipment.size===0){
      this.bagTextSpecs=this.bagTextSpecs.filter(spec=>spec.key!=='bag-level');
      this.renderBagEquipment();
    }
    const memberChanged=this.bagMemberId!==this.host.selectedMemberId,equipment=bag.equipmentFor(this.host.selectedMemberId);
    let equipmentChanged=memberChanged;
    if(!equipmentChanged)for(const slot of EQUIPMENT_SLOTS){
      const view=this.bagEquipment.get(slot);if(view&&view.drop.entry!==equipment[slot]){equipmentChanged=true;break;}
    }
    this.updateBagMember(memberChanged||equipmentChanged,false);
    this.bagMemberId=this.host.selectedMemberId;
    this.bagFilterView=this.filter;
    grid.setHeight(Math.ceil(slotCount/cells.columns)*cells.stride);
    this.host.view.menuText?.renderPage('bag');
    this.host.sync();
  }
selectItem(id:string,side:'left'|'right'):void{
    this.itemResult=undefined;
    this.descSide=side;this.selectedItem=this.selectedItem===id?undefined:id;this.host.view.deleteScroll('item');this.host.render();
  }
private renderItemDetail(id:string):void{
    const v=this.host.view.description!,bag=this.session!.bag,entry=bag.get(id)!,item=bag.catalog.items[entry.item],worn=EQUIPMENT_SLOTS.find(slot=>bag.equipmentFor(this.host.selectedMemberId)[slot]===id);
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
    // 标题、颜色与正文由同一个实例说明生成器提供；当前查看的成员决定职业与等级条件。
    const body=itemDescriptionBody({item,entry,numbers:this.app.characterStats.equipment[entry.item],catalog:this.app.characterStats,
      grades:this.app.shops.grades,member:this.member(),classNames:this.classNames(),gemNames:entry.gems.map(id=>bag.catalog.items[id]?.name),skill:entry.skill?bag.catalog.skillDescriptions?.[entry.skill]:undefined});
    // 名字换行时正文区整体下移，底部仍停在原动作行上方。
    const titleOverflow=descriptionTitleOverflow(v,body.title,panel.width,panel.title.y,panel.scroll.y,actionLayout.scrollHeight),
      scrollX=left+panel.scroll.x,scrollY=top+panel.scroll.y+titleOverflow,
      scrollHeight=Math.max(60,actionLayout.scrollHeight-titleOverflow),
      clip={top:scrollY,bottom:scrollY+scrollHeight},
      writer={add:(spec:MenuTextSpec)=>this.bagDetailTextSpecs.push(spec)};
    const detail=this.host.view.scroll('item',left+panel.scroll.x,scrollY,panel.scroll.width,scrollHeight,v);
    drawDescriptionTitle(body.title,left,top,panel.width,body.color,{writer,keyPrefix:'item-title'});
    let y=drawDescriptionRows(v,body.rows,panel.scroll.width,
      {writer,keyPrefix:'item-row',x:scrollX,y:scrollY,scroll:'item',clip});
    this.host.view.finishScroll('item',detail,y);
    // 关闭按钮挂在面板右上角：那枚 67×67 的圆钮（原版矩形 349,−6，本作右移到贴边）。
    drawDescriptionClose(v,this.app.menuPanels.assets,panel,left,top,()=>{this.host.itemNotice=undefined;this.selectedItem=undefined;this.host.render();});
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
private bagMenu(entry:ItemInstance,worn?:EquipmentSlot):BagMenuAction[]{
    const bag=this.session!.bag,item=bag.catalog.items[entry.item],actions:BagMenuAction[]=[];
    if(worn)actions.push({label:'卸下',disabled:!!bag.unequipProblem(worn,this.host.selectedMemberId),run:()=>void this.changeEquipment(undefined,worn)});
    else{
      const member=this.member()!;
      const slots=bag.equippableSlots(entry.id,this.host.selectedMemberId,member.classId,member.level);
      const empty=bag.emptyEquipSlot(entry.id,this.host.selectedMemberId,member.classId,member.level);
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
    if(forgeLabel)actions.push({label:forgeLabel,run:()=>this.host.navigation.openForge(entry.id)});
    if(item.use&&!NON_MENU_USE_KINDS.has(item.use.kind)&&!worn)actions.push({label:item.use.kind==='learn'?'使用':USE_LABELS[item.use.kind],run:()=>this.beginOperation(entry.id),disabled:!!this.itemUseProblem(entry)});
    // 快捷键：与技能页同一套文案与同一屏。已配到任一组的这枚按钮改成「取消快捷键」，点了直接清掉
    // （原版 `UIEquip_ButtonRemoveShortCutExe 0x14c514` → `PLAYER_RemoveShortcutAll(char, 2, 物品编号)`）。
    if(item.shortcut&&!worn){
      const assigned=this.host.navigation.shortcutBar().assigned('item',entry.item);
      actions.push({label:assigned?'取消快捷键':'快捷键',
        run:()=>assigned?this.host.navigation.clearShortcut('item',entry.item):this.host.navigation.openShortcutScreen('item',entry.item)});
    }
    if(item.equipment)actions.push({label:entry.locked?'解锁':'上锁',run:()=>{
      bag.setLocked(entry.id,!entry.locked);
    }});
    if(item.discardable&&!worn)actions.push({label:'丢弃',disabled:!!entry.locked,run:()=>this.beginOperation(entry.id,'discard')});
    return actions;
  }
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
async changeEquipment(entry:string|undefined,slot:EquipmentSlot):Promise<void>{
    if(this.busy)return;this.busy=true;this.host.cancelDrag();const signal=this.request.signal,memberId=this.host.selectedMemberId;const started=performance.now();
    const current=()=>!signal.aborted&&this.request.signal===signal&&this.host.selectedMemberId===memberId&&this.host.active()&&this.host.page==='bag';
    try{await this.app.changeEquipment!(entry,slot,signal,memberId);if(!current())return;this.selectedItem=undefined;this.host.notice='';}
    catch(error){if(current())this.host.notice=(error as Error).message;}finally{if(current()){this.busy=false;this.host.render();globalThis.storyDiagnostics?.record('equipment-change-summary',{slot,member:memberId,elapsedMs:Math.round(performance.now()-started)});}}
  }
beginOperation(entry:string,kind:'use'|'discard'='use'):void{
    this.host.cancelDrag();
    const instance=this.session!.bag.get(entry)!;
    if(kind==='use'&&this.itemUseProblem(instance))return;
    const use=this.session!.bag.catalog.items[instance.item].use;
    // 技能书不弹确认框：独立页本身就承担选择与确认。
    if(kind==='use'&&use?.kind==='learn'){this.host.navigation.openSkillBook(entry);return;}
    // 神灯的动作按钮直接召唤一名地图商人。
    if(kind==='use'&&use?.kind==='merchant'){
      this.operation={entry,kind,quantity:1};this.confirmOperation();return;
    }
    // 回血药水与再生药水都走队伍结算：全队生效、共用一个时钟。
    if(kind==='use'&&(use?.kind==='recover-health'||use?.kind==='regenerate')){this.action(()=>{this.app.useRecoveryItem?.(entry,this.host.selectedMemberId);});return;}
    if(kind==='use'&&use&&NON_MENU_USE_KINDS.has(use.kind))return;
    this.operation={entry,kind,quantity:1};this.host.view.deleteScroll('operation');
    this.host.view.modal?.clear();
    this.renderOperation();
    this.host.view.menuText?.renderPage('operation-notice');
    this.host.sync();
  }
closeOperation():void{
    this.cancel();
    this.host.view.modal?.clear();
    this.host.view.removeScroll('operation');
    this.host.view.menuText?.renderPage('bag');
    this.host.sync();
  }
renderOperation():void{
    const v=this.host.view.modal!,box=tradeLayout.quantity,op=this.operation!,bag=this.session!.bag;
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
    this.host.view.beginModal(box.width,height);v.visible(true);
    // 与商店的数量框同一个原版弹层：同样的图组 19 外框，同样的内缩 35 黑底。
    drawPopupPanel(v,this.app.menuPanels.assets,box.width,height);
    const buttonY=height-75,quantityTop=buttonY-12-48,textTop=inner.y+37,textBottom=(quantityRow?quantityTop:buttonY)-12;
    const scroll=this.host.view.scroll('operation',inner.x,textTop,inner.width,Math.max(0,textBottom-textTop),v);
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
    this.host.view.finishScroll('operation',scroll,textHeight);

    specs.push({key:'operation-title',text:op.kind==='discard'?'丢弃物品':USE_LABELS[use!.kind],
      x:inner.x,y:inner.y+5,style:{size:26,color:GOLD,width:inner.width,wrap:'word'}});
    if(quantityRow){
      const quantityButton=(label:string,x:number,width:number,action:()=>void)=>
        v.button('',x,quantityTop,width,48,action).setData('label',label);
      const setQuantity=(quantity:number)=>{
        op.quantity=Math.max(1,Math.min(entry.quantity,quantity));
        const value=String(op.quantity);
        const spec=specs.find(spec=>spec.key==='operation-quantity');
        if(spec)spec.text=value;
        this.host.view.menuText?.setText('operation-notice','operation-quantity',value);
      };
      quantityButton('减少数量',inner.x,80,()=>setQuantity(op.quantity-1));
      quantityButton('增加数量',inner.x+190,80,()=>setQuantity(op.quantity+1));
      quantityButton('全部',inner.x+260,inner.width-260,()=>setQuantity(entry.quantity));
      const centerY=quantityTop+24;
      specs.push({key:key(),text:'−',x:inner.x+40,y:centerY,
        style:{size:20,color:GOLD,width:68,align:'center',wrap:'word',anchorX:.5,anchorY:.5}});
      specs.push({key:'operation-quantity',text:String(op.quantity),x:inner.x+135,y:quantityTop+8,
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
    modalButton('取消',box.button.right,()=>this.closeOperation());
    modalButton('确定',box.button.left,()=>this.confirmOperation(),!!disabled);
  }
private itemUseProblem(entry:ItemInstance):string|undefined{
    const definition=this.session!.bag.catalog.items[entry.item];
    // 用途还没逆出来的物品不开使用菜单，免得点下去只是白丢一件。
    const unimplemented=unimplementedItemUse(entry.item,definition);
    if(unimplemented)return unimplemented;
    const kind=definition.use?.kind;
    if(this.host.selectedMemberId!=='player'&&(entry.item===SKILL_POINT_ITEM||
      kind==='learn'&&this.session!.party?.get(this.host.selectedMemberId)?.source!=='mercenary'))return '该道具仅能用于主角';
  }
private renderItemResult():void {
    // 与说明面板同一套矩形，免得看结果时又跳回旧位置。
    const v=this.host.view.description!,layout=bagLayout(),covered=this.descSide==='left'?layout.leftFrame:layout.bagFrame,
      panel=descriptionPanel(this.descSide==='left'?covered.width:BAG_DESCRIPTION_WIDTH),left=covered.x,top=panel.y;
    // 结果面板同样完全不透明：先铺整块透明拦截层，避免点击穿透到被盖住的格子。
    v.rect(left,top,panel.width,panel.height,0x000000,0).setInteractive();
    drawDescriptionPanel(v,this.app.menuPanels.assets,left,top,panel.width);
    // 同物品说明：滚动区也建在说明层上，否则正文会被面板底色压暗。
    const detail=this.host.view.scroll('item',left+panel.scroll.x,top+panel.scroll.y,panel.scroll.width,panel.scroll.height,v);let y=0;
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
    this.host.view.finishScroll('item',detail,y);
    drawDescriptionClose(v,this.app.menuPanels.assets,panel,left,top,()=>{this.itemResult=undefined;this.host.render();});
  }
async confirmOperation():Promise<void>{
    const op=this.operation;if(!op||op.confirmed||this.busy)return;const bag=this.session!.bag,entry=bag.get(op.entry);if(!entry)return;
    op.confirmed=true;this.busy=true;
    const signal=this.request.signal,memberId=this.host.selectedMemberId;
    let recruited=false;
    try{
      if(op.kind==='use'){const problem=this.itemUseProblem(entry);if(problem)throw new Error(problem);}
      const kind=bag.catalog.items[entry.item].use?.kind;
      this.itemResult=undefined;
      if(op.kind==='discard')bag.discard(op.entry,op.quantity);
      else if(kind==='recruit'){
        const {member}=this.session!.party!.recruit(op.entry);
        this.operation=undefined;this.selectedItem=undefined;recruited=true;this.host.navigation.recruited(member.id);
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
        signal.throwIfAborted();if(!this.host.active()||this.host.selectedMemberId!==memberId)return;this.busy=false;this.host.navigation.closeMenu();return;
      }else{
        this.itemResult=bag.use(op.entry);
      }
      this.selectedItem=bag.get(op.entry)?op.entry:undefined;
      this.operation=undefined;
    }
    catch(error){if(signal.aborted)return;op.error=(error as Error).message;op.confirmed=false;}finally{if(!signal.aborted&&this.request.signal===signal)this.busy=false;}
    if(signal.aborted||(!recruited&&!this.host.active()))return;
    if(this.pendingSignature){this.host.render();return;}
    if(this.host.page==='bag'&&this.bagPageCached){
      this.host.view.modal?.clear();this.host.view.removeScroll('operation');
      if(this.operation){this.renderOperation();this.host.view.menuText?.renderPage('operation-notice');this.host.sync();}
      else this.host.render();
    }else this.host.render();
  }
handleDrop(entryId:string,target:BagDropTarget):void{
    const bag=this.session.bag,entry=bag.get(entryId);if(!entry)return;
    if(target.view!==undefined&&target.cell!==undefined){this.dropOnCell(entryId,target.view,target.cell);return;}
    const member=this.member();
    if(target.slot&&bag.catalog.items[entry.item].equipment&&member&&bag.equipProblem(entryId,target.slot,this.host.selectedMemberId,member.classId,member.level)===undefined)
      void this.changeEquipment(entryId,target.slot);
  }
dropOnCell(id:string,view:InventoryView,cell:number):void{
    this.action(()=>{
      if(this.session!.bag.placeInCell(id,view,cell))this.app.audio?.ui('itemMove');   // 原版也是移动成功才出声
    });
  }
private clearBagEquipment():void{
    this.host.view.bagPortrait?.detach();
    const drops=new Set<unknown>([...this.bagEquipment.values()].map(view=>view.drop));
    for(const view of this.bagEquipment.values())view.button.destroy();
    this.host.view.drops=this.host.view.drops.filter(drop=>!drops.has(drop));
    this.bagEquipment.clear();this.bagPreview?.destroy();this.bagPreview=undefined;
    this.host.view.body?.pruneDestroyed();
  }
private renderBagEquipment():void{
    const v=this.host.view.body!,bag=this.session!.bag,panels=this.app.menuPanels,member=this.member()!,equipment=bag.equipmentFor(this.host.selectedMemberId);
    this.bagPreview=v.container(0,0);this.renderBagPreview();
    for(const slot of panels.equipmentSlots){
      const id=slot.id as EquipmentSlot,entry=equipment[id],instance=entry?bag.get(entry):undefined,item=instance?bag.catalog.items[instance.item]:undefined;
      const button=v.button('',85+slot.x,slot.y,74,74,()=>{const current=bag.equipmentFor(this.host.selectedMemberId)[id];if(current)this.selectItem(current,'right');},{image:slotFrameImage(this.app,this.session!,instance)});
      const icon=v.image(item?.icon??slot.emptyIcon,item?5:13,item?5:13,item?64:48,item?64:48,button);button.setData('label',slot.name);
      updateEquipmentLock(v,button,!!instance?.locked);
      const drop={object:button,entry,slot:id};this.host.view.drops.push(drop);this.bagEquipment.set(id,{button,icon,drop});
    }
    this.bagTextSpecs.push({key:'bag-level',text:`Lv. ${member.level}　${this.app.storyClasses.classes.find(c=>c.id===member.classId)!.name}`,
      x:292,y:375,style:{size:22,color:TEXT_COLORS.primary,anchorX:.5,anchorY:0}});
  }
private closeBagDetailForMember():void{
    const coversEquipment=this.descSide==='left';
    this.bagDetailOpen=false;this.bagDetailTextSpecs=[];this.bagSelection?.destroy();this.bagSelection=undefined;
    this.host.view.description?.clear();
    this.host.view.removeDescriptionScrolls();
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
updateBagMember(refreshPreview=true,renderText=true):void{
    const member=this.member()!,bag=this.session!.bag,equipment=bag.equipmentFor(this.host.selectedMemberId),panels=this.app.menuPanels;
    for(const slot of panels.equipmentSlots){
      const id=slot.id as EquipmentSlot,view=this.bagEquipment.get(id);if(!view)continue;
      const entry=equipment[id],instance=entry?bag.get(entry):undefined,item=instance?bag.catalog.items[instance.item]:undefined;
      const face=view.button.getData('face') as UiImage|undefined,frame=slotFrameImage(this.app,this.session!,instance),icon=item?.icon??slot.emptyIcon;
      if(face&&face.getData('file')!==frame)face.load(frame);
      if(view.icon.getData('file')!==icon)view.icon.load(icon);
      const offset=item?5:13,size=item?64:48;
      if(view.icon.x!==offset)view.icon.setPosition(offset,offset);
      if(view.icon.width!==size||view.icon.height!==size)view.icon.resize(size,size);
      updateEquipmentLock(this.host.view.body!,view.button,!!instance?.locked);
      view.drop.entry=entry;
    }
    const level=this.bagTextSpecs.find(spec=>spec.key==='bag-level');
    if(level)level.text=`Lv. ${member.level}　${this.app.storyClasses.classes.find(c=>c.id===member.classId)!.name}`;
    this.bagMemberId=this.host.selectedMemberId;
    if(refreshPreview)this.renderBagPreview();
    if(renderText)this.host.view.menuText?.renderPage('bag');
  }
renderBagPreview():void{
    const v=this.host.view.body, parent=this.bagPreview, member=this.member();
    if(!v||!parent?.active||!member||!this.host.view.scene)return;
    parent.removeAll(true);
    const preview=bagLayout().preview,appearance=this.app.previewAppearance?.(this.host.selectedMemberId)??this.app.equipmentAppearance?.(this.host.selectedMemberId);
    if(appearance&&this.host.view.bagPortrait?.available(appearance)){
      this.host.view.bagPortrait.show(v,appearance,preview);
    }else{
      this.host.view.bagPortrait?.detach();
      const art=this.memberArt(),panels=this.app.menuPanels;
      v.imageContain(this.host.selectedMemberId==='player'?panels.classes[member.classId].preview:art.partyIcon,preview.x,preview.y,preview.width,preview.height,parent);
    }
  }
}
