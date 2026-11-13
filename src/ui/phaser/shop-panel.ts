import { updateEquipmentLock } from '../slot-frame.ts';
import { drawBagRail, drawBagRailSelection } from './bag-rail.ts';
import type { UiImage, UiNode } from '../dom/node.ts';
import type { Session } from '../../domain/session.ts';
import type { ItemInstance } from '../../domain/items.ts';
import type { ShopCatalog, Storefront, EquipmentSaleQuote } from '../../domain/shop.ts';
import { moneyText, splitMoney } from '../../domain/money.ts';
import { itemDescriptionBody } from '../item-detail-lines.ts';
import { INVENTORY_LABELS, INVENTORY_SIDE_FILTERS, matchesFilter, type InventoryFilter } from '../../domain/inventory.ts';

import { cleanupLayout, shopLayout, tradeLayout, tradeMessageLayout, tradeMessageScrollLayout, type ShopLayout } from '../shop-layout.ts';
import { TEXT_COLORS } from '../text-style.ts';
import { BAG_DESCRIPTION_WIDTH, DESCRIPTION_PANEL, descriptionPanel, descriptionActionLayout, SIDE_FILTER_TEXT_SIZE } from '../bag-layout.ts';
import type { PlaceModal } from './modal-placement.ts';
import { drawDescriptionClose, drawDescriptionPanel, drawDescriptionRows, drawDescriptionTitle } from './description-panel.ts';
import { drawPopupPanel } from './popup-panel.ts';
import type { MenuTextSpec, MenuTextWriter } from '../dom/menu-text.ts';
import type { UiSurface, ScrollArea } from './widgets.ts';

/** 商店页文字落点：页面文字与弹层文字分开收集，弹层坐标由 `StoryUI` 换算。 */
interface ShopTextTarget {
  scroll(name:string,x:number,y:number,width:number,height:number,surface?:UiSurface):ScrollArea;
  setText(key:string,text:string):void;
  refresh():void;
  updateDescription?(draw:()=>void):void;
  updateModal?(draw:()=>void):void;
}

type Selection = {kind:'buy'|'sell'; id:string; step:'description'|'quantity'|'confirm'|'notice'; quantity:number; error?:string};

/** 货架是 4×4 格，和背包网格同列数。 */
const SHELF_COLUMNS=4;
const SHELF_SLOTS=SHELF_COLUMNS*4;
/** 数量加减的长按节奏：按住 350ms 后开始，每 80ms 加减一次。 */
const QUANTITY_HOLD={delayMs:350,intervalMs:80} as const;
/** 金额的三个单位，顺序与金币那一行的横坐标一致。 */
const MONEY_UNITS=['gold','silver','copper'] as const;
const AREA_COLOR=TEXT_COLORS.primary;
/** 清理装备的五档品质；索引就是装备的品质值，名称和颜色一一对应。 */
const CLEANUP_RARITIES=[
  {name:'白装',color:'#ffffff'},
  {name:'绿装',color:'#4eff00'},
  {name:'蓝装',color:'#00b4ff'},
  {name:'黄装',color:'#ffe600'},
  {name:'紫装',color:'#b977ff'},
] as const;

/** The merchant and the player's bag remain visible throughout a trade. */
export class ShopPanel {
  private selection?:Selection;
  /** 批量出售模式：点背包格改为勾选，不弹说明面板。 */
  private batch=false;
  private cleaning=false;
  private cleanupLevel=0;
  private cleanupRarities=new Set<number>([0]);
  private cleanupQuote?:EquipmentSaleQuote;
  private normalBagOffset=0;
  private pendingBagOffset?:number;
  private cleanupSellButton?:UiNode;
  private cleanupMinus?:UiNode;
  private cleanupError?:string;
  private sellingCleanup=false;
  private readonly batchSelection=new Set<string>();
  private batchError?:string;
  private bagScroll?:ScrollArea;
  private categoryScroll?:ScrollArea;
  /**
   * 数量框里会变的三个东西：中间的数字、下面那行金额的每一位、左右两枚箭头。
   * 加减只改它们三个，不触发整页重画——玩家明确要求过数量变化不能重刷界面。
   */
  private quantityButtons?:{minus:UiNode;plus:UiNode};
  /** 这一轮绘制收集的文字；弹层打开时只输出后者。 */
  private pageText:MenuTextSpec[]=[];
  private modalText:MenuTextSpec[]=[];
  /** 说明面板自己的文字：面板打开时叠在页面文字之上，页面里被面板盖住的部分不输出。 */
  private detailText:MenuTextSpec[]=[];
  private text?:ShopTextTarget;
  private view?:UiSurface;
  private description?:UiSurface;
  private modal?:UiSurface;
  private selectionButtons=new Map<string,UiNode>();
  private categoryButtons=new Map<string,UiNode>();
  private selectionMarker?:UiImage;
  private batchControls:UiNode[]=[];
  private incrementalDescription=false;

  private bagOffset=0;
  private categoryOffset=0;
  /** 背包栏那 6 个按钮的筛选：卖东西时看的是背包的哪一类。 */
  private filter:InventoryFilter='all';
  private layout:ShopLayout=shopLayout(false);
  /** 弹层尺寸交给菜单保存，重绘和缩放共用该尺寸。 */
  private placeModal?:PlaceModal;
  private readonly store:Storefront;
  private readonly session:Session;
  private readonly catalog:ShopCatalog;
  private readonly frames:Record<string,string>;
  private readonly changed:()=>void;
  private readonly viewedMember:()=>{classId:string;level:number}|undefined;
  private readonly classNames?:Record<string,string>;
  private readonly notify?:(message:string)=>void;
  constructor(store:Storefront,session:Session,catalog:ShopCatalog,frames:Record<string,string>,changed:()=>void,
    viewedMember?:()=>{classId:string;level:number}|undefined,classNames?:Record<string,string>,notify?:(message:string)=>void){
    this.store=store;this.session=session;this.catalog=catalog;this.frames=frames;this.changed=changed;
    this.viewedMember=viewedMember??(()=>session.party?.get(session.party.controlledId)??session.hero);
    this.classNames=classNames;this.notify=notify;
  }
  /**
   * 说明面板画在商店面板自己身上——原版它是主界面上的一个控件，只有数量框与确认框才占弹层画布。
   * 所以停在说明步时不算"弹层打开"，主画布照常收输入。
   */
  get modalOpen():boolean{return !!this.selection&&this.selection.step!=='description';}
  /** 有选中就存在，不管停在哪一步；批量模式同样算“在商店里”，关闭键据此逐级退回。 */
  get active():boolean{return !!this.selection||this.batch||this.cleaning;}
  captureScroll():void{this.bagOffset=this.pendingBagOffset??this.bagScroll?.scrollTop??this.bagOffset;this.pendingBagOffset=undefined;this.categoryOffset=this.categoryScroll?.scrollTop??this.categoryOffset;}
  cancel():void{
    if(this.cleaning){if(this.selection){this.selection=undefined;this.changed();}else this.leaveCleanup();return;}
    const selection=this.selection;
    const incremental=this.incrementalDescription;
    this.selection=undefined;
    this.batch=false;this.batchSelection.clear();this.batchError=undefined;
    if(incremental&&selection){
      this.refreshDescription();
      if(selection.step!=='description')this.text?.updateModal?.(()=>{});
      return;
    }
    this.changed();
  }
  /**
   * 面板调试入口：直接摆到某个交易步骤，跳过「点货架格买、点背包格卖」的点击链路。
   * 可用堆叠商品的 `quantity` 步骤会自动挑一件能买多件的商品；`notice` 则挑第一件不可出售的物品。
   */
  debugTrade(step:'description'|'quantity',kind:'buy'|'sell'='buy'):void{
    if(kind==='buy'){
      const offers=this.store.offers.filter(offer=>!offer.sold);
      const stackable=offers.find(offer=>{
        const item=this.session.bag.catalog.items[offer.instance.item];
        return item&&!offer.limited&&item.stackable;
      });
      const offer=step==='quantity'?(stackable??offers[0]):offers[0];
      if(!offer)return;
      this.select('buy',offer.id);
    }else{
      const entry=this.session.bag.entries.find(value=>this.store.sellPrice(value)>0);
      if(!entry)return;
      this.select('sell',entry.id);
    }
    if(this.selection&&step==='quantity'){
      this.selection.step=step;
      this.selection.quantity=Math.min(2,Math.max(1,this.maximum(this.selection.kind)));
    }
    this.changed();
  }
  /** 原版点货架格买、点背包格卖都先弹物品说明面板；只有不可出售才跳过它直接提示。 */
  private select(kind:'buy'|'sell',id:string):void{
    this.selection={kind,id,step:'description',quantity:1};
    const entry=kind==='sell'?this.session.bag.get(id):undefined;
    if(kind==='sell'&&(!entry||this.store.sellPrice(entry)===0))this.selection.step='notice';
    if(this.selection.step==='description'&&!this.cleaning&&this.refreshDescription()){this.incrementalDescription=true;return;}
    this.changed();
  }
  private refreshDescription():boolean{
    const view=this.view,description=this.description,target=this.text;
    if(!view||!description||!target?.updateDescription)return false;
    this.selectionMarker?.destroy();this.selectionMarker=undefined;
    const selection=this.selection;
    if(selection){
      const button=this.selectionButtons.get(`${selection.kind}:${selection.id}`);
      if(button){const slot=this.layout.slot.selection;
        this.selectionMarker=view.image(this.catalog.assets.selection,slot.x,slot.y,slot.size,slot.size,button);}
    }
    for(const control of this.batchControls)control.setVisible(!selection);
    target.updateDescription(()=>{
      this.detailText=[];
      if(selection)this.renderDescription(description,selection);
    });
    return true;
  }
  /** 说明面板底部那枚按钮：可一次买多件的进数量框，其余直接确认（原版 `UIStore_ButtonBuyExe` 同此）。 */
  private beginTrade():void{
    const selection=this.selection!;
    selection.step=this.maximum(selection.kind)>1?'quantity':'confirm';
    if(this.incrementalDescription&&this.refreshModal())return;
    this.changed();
  }
  private refreshModal():boolean{
    const modal=this.modal,target=this.text;
    if(!modal||!target?.updateModal)return false;
    target.updateModal(()=>this.renderModal(modal));
    return true;
  }
  /** 普通堆叠商品可一次买 1–99；限量随机商品与不可堆叠商品一次一件；出售上限是持有数量。 */
  private maximum(kind:'buy'|'sell'):number{
    const selection=this.selection!;
    if(kind==='sell')return this.session.bag.get(selection.id)?.quantity??1;
    const offer=this.store.offers.find(offer=>offer.id===selection.id&&!offer.sold);
    const item=offer&&this.session.bag.catalog.items[offer.instance.item];
    return offer&&item&&!offer.limited&&item.stackable?99:1;
  }
  private cleanupSettings(){return {maximumLevel:this.cleanupLevel,rarities:[...this.cleanupRarities]};}
  private enterCleanup():void {
    this.normalBagOffset=this.bagScroll?.scrollTop??this.bagOffset;this.bagOffset=0;this.pendingBagOffset=0;
    this.cleaning=true;this.batch=false;this.batchSelection.clear();this.selection=undefined;
    this.cleanupLevel=this.viewedMember()?.level??1;this.cleanupRarities=new Set([0]);this.cleanupError=undefined;
    this.changed();
  }
  private leaveCleanup():void {
    this.cleaning=false;this.selection=undefined;this.cleanupQuote=undefined;this.cleanupError=undefined;
    this.bagOffset=this.normalBagOffset;this.pendingBagOffset=this.normalBagOffset;
    this.changed();
  }
  private sellCleanup():void {
    if(this.sellingCleanup||!this.cleanupQuote?.entries.length)return;
    this.sellingCleanup=true;
    try{
      const count=this.cleanupQuote.entries.length,total=this.store.sellCleanup(this.cleanupQuote,this.cleanupSettings());
      this.leaveCleanup();this.notify?.(`已出售 ${count} 件装备，获得 ${moneyText(total)}`);
    }catch(error){this.cleanupError=(error as Error).message;this.changed();}
    finally{this.sellingCleanup=false;}
  }
  private stepCleanupLevel(step:number):void {
    const value=Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,this.cleanupLevel+step));
    if(value===this.cleanupLevel)return;
    this.cleanupLevel=value;this.selection=undefined;this.cleanupError=undefined;this.changed();
  }
  private renderCleanupControls(v:UiSurface):void {
    const l=cleanupLayout;
    const button=(label:string,r:{x:number;y:number;width:number;height:number},run:()=>void,hold=false)=>
      v.button('',r.x,r.y,r.width,r.height,run,{parent:v.staticRoot,hold:hold?QUANTITY_HOLD:undefined}).setData('label',label);
    button('返回商店',l.back,()=>this.leaveCleanup());
    this.cleanupSellButton=button('全部出售',l.sell,()=>this.sellCleanup());
    this.cleanupMinus=button('降低等级上限',l.minus,()=>this.stepCleanupLevel(-1),true);
    button('提高等级上限',l.plus,()=>this.stepCleanupLevel(1),true);
  }
  private renderCleanupText(v:UiSurface):void {
    const l=cleanupLayout,q=l.qualities,quote=this.cleanupQuote!;
    this.cleanupSellButton?.getData('setEnabled')?.(quote.entries.length>0&&!this.sellingCleanup);
    this.cleanupMinus?.getData('setEnabled')?.(this.cleanupLevel>0);
    this.buttonText('cleanup-back','返回商店',l.back.x,l.back.y,l.back.width,l.back.height);
    this.buttonText('cleanup-sell','全部出售',l.sell.x,l.sell.y,l.sell.width,l.sell.height);
    this.addPage('cleanup-summary',this.cleanupError??`待售 ${quote.entries.length} 件 · ${moneyText(quote.total)}`,l.summary.x,l.summary.y,20,
      this.cleanupError?TEXT_COLORS.danger:AREA_COLOR,.5,.5,{width:l.summary.width,align:'center',wrap:'word'});
    this.addPage('cleanup-level-label','装备等级 ≤',l.level.x,l.level.y+22,22,AREA_COLOR,0,.5);
    this.addPage('cleanup-level',String(this.cleanupLevel),l.levelValue.x,l.levelValue.y,24,AREA_COLOR,.5,.5);
    this.buttonText('cleanup-minus','−',l.minus.x,l.minus.y,l.minus.width,l.minus.height);
    this.buttonText('cleanup-plus','＋',l.plus.x,l.plus.y,l.plus.width,l.plus.height);
    CLEANUP_RARITIES.forEach(({name,color},index)=>{
      const x=q.x+index*(q.width+q.gap);
      v.button('',x,q.y,q.width,q.height,()=>{
        if(this.cleanupRarities.has(index))this.cleanupRarities.delete(index);else this.cleanupRarities.add(index);
        this.selection=undefined;this.cleanupError=undefined;this.changed();
      },{selected:this.cleanupRarities.has(index)}).setData('label',name);
      this.addPage(`cleanup-quality-${index}`,name,x+q.width/2,q.y+q.height/2,18,color,.5,.5);
    });
  }
  private toggleBatch():void{
    this.batch=!this.batch;
    this.selection=undefined;this.batchSelection.clear();this.batchError=undefined;
    this.changed();
  }
  private toggleBatchEntry(id:string):void{
    if(this.batchSelection.has(id))this.batchSelection.delete(id);else this.batchSelection.add(id);
    this.batchError=undefined;
    this.changed();
  }
  /** 背包可能在批量模式开着时变化，顺手丢掉已经不存在或卖不掉的勾选。 */
  private batchEntries():{entry:ItemInstance;price:number}[]{
    const result:{entry:ItemInstance;price:number}[]=[];
    for(const id of [...this.batchSelection]){
      const entry=this.session.bag.get(id),price=entry?this.store.sellPrice(entry):0;
      if(!entry||entry.locked||price<=0){this.batchSelection.delete(id);continue;}
      result.push({entry,price});
    }
    return result;
  }
  /** 一次结算：金额先算完再整批扣物品；成功后由金币通知重画，失败保留勾选并显示原因。 */
  private sellBatch():void{
    const entries=this.batchEntries();
    if(!entries.length)return;
    const selected=[...this.batchSelection];
    this.batchSelection.clear();
    try{
      this.store.sellMany(entries.map(({entry})=>({id:entry.id,quantity:entry.quantity})));
      this.batchError=undefined;
    }catch(error){
      for(const id of selected)this.batchSelection.add(id);
      this.batchError=(error as Error).message;
      this.changed();
    }
  }
  /** 选中物品的单价：买入看货架标价，卖出看回收价。 */
  private price(selection:Selection):number{
    if(selection.kind==='buy')return this.store.buyPrice(selection.id);
    const entry=this.session.bag.get(selection.id);
    return entry?this.store.sellPrice(entry):0;
  }
  private pageTextSpec(key:string,text:string,x:number,y:number,size:number,color?:string,
    anchorX=0,anchorY=0,style:Partial<MenuTextSpec['style']>={},extras:Pick<MenuTextSpec,'scroll'|'clip'>={}):MenuTextSpec{
    return{key,text,x,y,style:{size,color,anchorX,anchorY,...style},...extras};
  }
  private addPage(key:string,text:string,x:number,y:number,size:number,color?:string,
    anchorX=0,anchorY=0,style:Partial<MenuTextSpec['style']>={},extras:Pick<MenuTextSpec,'scroll'|'clip'>={}):void{
    this.pageText.push(this.pageTextSpec(key,text,x,y,size,color,anchorX,anchorY,style,extras));
  }
  private addModal(key:string,text:string,x:number,y:number,size:number,color?:string,
    anchorX=0,anchorY=0,style:Partial<MenuTextSpec['style']>={}):void{
    this.modalText.push({key,text,x,y,style:{size,color,anchorX,anchorY,...style}});
  }
  private addDetail(key:string,text:string,x:number,y:number,size:number,color?:string,
    anchorX=0,anchorY=0,style:Partial<MenuTextSpec['style']>={},extras:Pick<MenuTextSpec,'scroll'|'clip'>={}):void{
    this.detailText.push(this.pageTextSpec(key,text,x,y,size,color,anchorX,anchorY,style,extras));
  }
  private buttonText(key:string,label:string,x:number,y:number,width:number,height:number,
    modal=false,size=Math.min(22,height*.42),extras:Pick<MenuTextSpec,'scroll'|'clip'>={}):void{
    if(modal)this.addModal(key,label,x+width/2,y+height/2,size,undefined,.5,.5);
    else this.addPage(key,label,x+width/2,y+height/2,size,undefined,.5,.5,{},extras);
  }
  private detailButtonText(key:string,label:string,x:number,y:number,width:number,height:number):void{
    this.addDetail(key,label,x+width/2,y+height/2,Math.min(22,height*.42),undefined,.5,.5);
  }
  /** 页面与弹层共用的金币数字；`prefix` 区分主界面、数量框和确认框三份。 */
  private money(v:UiSurface,amount:number,x:number,y:number,prefix:string,modal=false):void{
    const {stride,coin,digit,color}=this.layout.money,value=splitMoney(amount);
    MONEY_UNITS.forEach((unit,index)=>{
      v.image(this.catalog.assets[unit],x+index*stride,y,coin.width,coin.height);
      const key=`${prefix}-${unit}`;
      if(modal)this.addModal(key,String(value[unit]),x+index*stride+digit.x,y+digit.y,21,color);
      else this.addPage(key,String(value[unit]),x+index*stride+digit.x,y+digit.y,21,color);
    });
  }
  /** 说明面板在当前这一步盖住的矩形；面板没开时返回 undefined。 */
  private descriptionCovered():{x:number;y:number;width:number;height:number}|undefined{
    const selection=this.selection;
    if(!selection||selection.step!=='description')return;
    const covered=selection.kind==='buy'?this.layout.bagFrame:this.layout.leftFrame;
    const panel=descriptionPanel(selection.kind==='buy'?BAG_DESCRIPTION_WIDTH:covered.width);
    return{x:covered.x,y:panel.y,width:panel.width,height:panel.height};
  }
  /** 页面文字交给 `StoryUI` 的 DOM 层；弹层坐标仍是弹层本地坐标。 */
  renderText(writer:MenuTextWriter):void{
    // DOM 文字在画布之上，说明面板的黑底挡不住底下的金额和角标：面板矩形内的页面文字先让位，
    // 再换上面板自己的文字；店名、分类列这些面板外的东西照常显示。
    const covered=this.descriptionCovered();
    for(const spec of this.pageText)
      if(!(this.selection&&(spec.key==='shop-batch-toggle'||spec.key==='cleanup-entry'))&&(!covered||spec.x<covered.x||spec.x>covered.x+covered.width||spec.y<covered.y||spec.y>covered.y+covered.height))writer.add(spec);
    for(const spec of this.detailText)writer.add(spec);
  }
  renderModalText(writer:MenuTextWriter):void{for(const spec of this.modalText)writer.add(spec);}
  /**
   * 优先走菜单统一入口登记滚动区；没有 DOM 文字目标时退回 surface。
   * 回退模式只保证内容不重叠，DOM 文字不会跟随滚动（生产路径始终提供 `text`）。
   */
  private scrollAt(surface:UiSurface,name:string,x:number,y:number,width:number,height:number):ScrollArea{
    return this.text?.scroll(name,x,y,width,height,surface)??surface.scroll(x,y,width,height);
  }
  private selectCategory(name:string):void{
    if(this.cleaning||this.store.category===name)return;
    const previous=this.store.category;this.store.selectCategory(name);
    if(previous)(this.categoryButtons.get(previous)?.getData('face') as UiImage|undefined)?.load(this.catalog.assets[previous]);
    (this.categoryButtons.get(name)?.getData('face') as UiImage|undefined)?.load(this.catalog.assets[`${name}-selected`]);
    if(this.selection?.kind==='buy'){this.selection=undefined;this.refreshDescription();}
    const view=this.view;if(!view){this.changed();return;}
    for(const [key,button] of this.selectionButtons)if(key.startsWith('buy:')){button.destroy();this.selectionButtons.delete(key);}
    view.pruneDestroyed();this.renderShelf(view);
    const categoryText=this.catalog.categories[name].name;
    const spec=this.pageText.find(value=>value.key==='shop-category-name');if(spec)spec.text=categoryText;
    this.text?.setText('shop-category-name',categoryText);
  }
  private renderShelf(v:UiSurface):void{
    const {shelf,slot}=this.layout;
    for(let index=0;index<SHELF_SLOTS;index++){
      const x=shelf.x+index%SHELF_COLUMNS*slot.stride,y=shelf.y+Math.floor(index/SHELF_COLUMNS)*slot.stride,offer=this.store.offers[index];
      if(!offer||offer.sold)continue;
      const item=this.session.bag.catalog.items[offer.instance.item];
      const button=v.button('',x,y,slot.size,slot.size,()=>this.select('buy',offer.id),{bare:true,disabled:this.cleaning}).setData('label',`购买 ${item.name}`);
      v.image(item.icon,slot.icon.x,slot.icon.y,slot.icon.size,slot.icon.size,button);
      this.selectionButtons.set(`buy:${offer.id}`,button);
      if(this.selection?.id===offer.id)this.selectionMarker=v.image(this.catalog.assets.selection,slot.selection.x,slot.selection.y,slot.selection.size,slot.selection.size,button);
    }
  }
  render(v:UiSurface,modal:UiSurface,placeModal?:PlaceModal,description?:UiSurface,text?:ShopTextTarget):void{
    this.placeModal=placeModal;this.pageText=[];this.modalText=[];this.detailText=[];this.text=text;
    this.view=v;this.description=description;this.modal=modal;this.incrementalDescription=false;
    this.selectionButtons.clear();this.categoryButtons.clear();this.selectionMarker=undefined;this.batchControls=[];
    const {store,session,catalog}=this,classified=store.shop.categories.length>0;
    const layout=this.layout=shopLayout(classified),{leftFrame,bagFrame,title,shelf,bag,slot,category}=layout;
    // 两栏内容区保留透明背景，背包侧栏使用共用图框和底色。
    // 两栏图框、店名和货架空格子不随筛选/选中变化，放进静态层只画一次。
    if(this.cleaning)this.cleanupQuote=this.store.previewCleanup(this.cleanupSettings());
    v.staticLayer(`shop:${store.shop.name}:${classified}:${this.cleaning}`,()=>{
      if(this.cleaning)this.renderCleanupControls(v);
      v.border(this.frames,leftFrame.x,leftFrame.y,leftFrame.width,leftFrame.height,v.staticRoot);
      drawBagRail(v,this.frames,bagFrame.x,v.staticRoot);
      v.image(catalog.assets['merchant-title'],title.x,title.y,title.width,title.height,v.staticRoot);
      if(classified){
        const column=layout.categoryColumn;
        v.image(catalog.assets['category-cap-top'],column.cap.x,column.cap.y,column.cap.width,column.cap.height,v.staticRoot);
        v.image(catalog.assets['category-cap-bottom'],column.cap.x,column.cap.bottom,column.cap.width,column.cap.height,v.staticRoot);
        v.image(catalog.assets['category-divider'],column.divider.x,column.divider.y,column.divider.width,column.divider.height,v.staticRoot);
        v.textPlate(catalog.assets['text-plate-left'],catalog.assets['text-plate-right'],category.plate.x,category.plate.y,category.plate.width,v.staticRoot);
      }
      v.textPlate(catalog.assets['text-plate-left'],catalog.assets['text-plate-right'],layout.money.plate.x,layout.money.plate.y,layout.money.plate.width,v.staticRoot);
      for(let index=0;index<SHELF_SLOTS;index++){
        const x=shelf.x+index%SHELF_COLUMNS*slot.stride,y=shelf.y+Math.floor(index/SHELF_COLUMNS)*slot.stride;
        v.image(catalog.assets.slot,x,y,slot.size,slot.size,v.staticRoot);
      }
    });
    this.addPage('shop-title',store.shop.name,layout.titleName.x,layout.titleName.y,26,AREA_COLOR,.5,.5);
    if(classified){
      // 分类列的滚动区与按钮随筛选重建；端盖和竖条已经在静态层。
      this.categoryScroll=this.scrollAt(v,'shop-category',category.scroll.x,category.scroll.y,category.scroll.width,category.scroll.height);
      store.shop.categories.forEach((name,index)=>{
        const button=v.button('',0,index*category.button.stride,category.button.width,category.button.height,
          ()=>this.selectCategory(name),
          {image:catalog.assets[`${name}${store.category===name?'-selected':''}`],parent:this.categoryScroll!.content,guard:this.categoryScroll!.guard})
          .setData('label',catalog.categories[name].name);
        this.categoryButtons.set(name,button);
      });
      this.categoryScroll.setHeight(store.shop.categories.length*category.button.stride);this.categoryScroll.scrollTop=this.categoryOffset;
      this.addPage('shop-category-name',catalog.categories[store.category!].name,category.name.x,category.name.y,22,AREA_COLOR,.5,.5);
    }
    this.renderShelf(v);
    this.bagScroll=this.scrollAt(v,'shop-bag',bag.x,bag.y,bag.width,bag.height);
    const entries=this.cleaning?this.cleanupQuote!.entries.map(value=>value.entry):session.bag.entries.filter(entry=>matchesFilter(session.bag.catalog.items[entry.item],this.filter)
        &&(!this.batch||!entry.locked&&this.store.sellPrice(entry)>0)),
      slots=Math.max(SHELF_SLOTS,Math.ceil(entries.length/bag.columns)*bag.columns);
    for(let index=0;index<slots;index++){
      const x=index%bag.columns*bag.stride,y=Math.floor(index/bag.columns)*bag.stride,entry=entries[index];
      v.image(catalog.assets.slot,x,y,slot.size,slot.size,this.bagScroll.content);
      if(!entry)continue;
      const item=session.bag.catalog.items[entry.item];
      const button=v.button('',x,y,slot.size,slot.size,
        ()=>this.batch?this.toggleBatchEntry(entry.id):this.select('sell',entry.id),
        {bare:true,parent:this.bagScroll.content,guard:this.bagScroll.guard}).setData('label',`${this.batch?'选择':'出售'} ${item.name}`);
      v.image(item.icon,slot.icon.x,slot.icon.y,slot.icon.size,slot.icon.size,button);
      updateEquipmentLock(v,button,!!entry.locked);
      // 角标挂在格子容器上，坐标相对格子左上角；DOM 文字仍按滚动区内容坐标落点。
      if(entry.quantity>1)this.addPage(`shop-badge-${index}`,String(entry.quantity),bag.x+x+layout.badge.x,bag.y+y+layout.badge.y,
        20,layout.badge.color,1,0,{},{scroll:'shop-bag',clip:{top:bag.y,bottom:bag.y+bag.height}});
      this.selectionButtons.set(`sell:${entry.id}`,button);
      if(this.selection?.id===entry.id)this.selectionMarker=v.image(catalog.assets.selection,slot.selection.x,slot.selection.y,slot.selection.size,slot.selection.size,button);
      else if(this.batchSelection.has(entry.id))v.image(catalog.assets.selection,slot.selection.x,slot.selection.y,slot.selection.size,slot.selection.size,button);
    }
    this.bagScroll.setHeight(Math.ceil(slots/bag.columns)*bag.stride);this.bagScroll.scrollTop=this.bagOffset;
    const batchItems=this.batch?this.batchEntries():[],
      batchTotal=batchItems.reduce((sum,{entry,price})=>sum+price*entry.quantity,0);
    if(this.batch){
      // 批量模式把金额栏临时改成“本次出售合计”，避免和当前持有金币混在一起。
      const plate=layout.money.plate,label=this.batchError??`合计 ${moneyText(batchTotal)}`;
      this.addPage('shop-batch-label',label,plate.x+plate.width/2,plate.y+2,20,
        this.batchError?'#e9a08a':layout.money.color,.5,0,{width:plate.width,align:'center',wrap:'word'});
    }else this.money(v,session.money,layout.money.x,layout.money.y,'shop-money');
    // 背包栏右侧那 6 个按钮与背包页是同一列、同一套画法：常态外框是图组 15 索引 20，
    // 选中的那一个在按钮矩形 −(5,12) 上再叠索引 19。原版 `UIStore_DrawInvenBagGroup`
    // 用它们切换背包分类，所以卖东西时看到的就是筛出来的那一类。
    // 说明面板与它盖住的那一栏同宽，所以这一列（在框外）不会被整列压住：照常画出来，
    // 玩家买进时仍然看得到、点得到分类。
    const side=layout.sideButtons;
    if(!this.cleaning)INVENTORY_SIDE_FILTERS.forEach((filter,index)=>{
        if(this.filter===filter)drawBagRailSelection(v,side.x,side.y+side.offsets[index],side.width,side.height);
        const button=v.button('',side.x,side.y+side.offsets[index],side.width,side.height,
          ()=>{this.filter=filter;this.bagOffset=0;if(this.bagScroll)this.bagScroll.scrollTop=0;
            this.batchSelection.clear();this.batchError=undefined;this.changed();},{bare:true});
        this.addPage(`shop-filter-${filter}`,INVENTORY_LABELS[filter],side.x+side.width/2,
          side.y+side.offsets[index]+side.height/2,SIDE_FILTER_TEXT_SIZE,undefined,.5,.5,
          {width:side.width-6,align:'center',wrap:'word'});
      button.setData('label',INVENTORY_LABELS[filter]);
    });
    // 批量出售的入口与动作放在背包框上方那一条空带里（和标题框同一高度），不占格子。
    // 说明面板打开时先收起，避免和“出售”那一步抢同一块区域。
    if(this.cleaning)this.renderCleanupText(v);
    if(!this.selection&&!this.cleaning){
      const batchBar=this.layout.bagFrame,batchLabel=this.batch?'退出批量':'批量出售';
      this.batchControls.push(v.button('',batchBar.x,batchBar.y-42,150,40,()=>this.toggleBatch(),
        {fontSize:16,selected:this.batch}).setData('label',batchLabel));
      this.buttonText('shop-batch-toggle',batchLabel,batchBar.x,batchBar.y-42,150,40,false,16);
      if(!this.batch){
        this.batchControls.push(v.button('',batchBar.x+158,batchBar.y-42,200,40,()=>this.enterCleanup(),{}).setData('label','清理装备'));
        this.buttonText('cleanup-entry','清理装备',batchBar.x+158,batchBar.y-42,200,40);
      }
      if(this.batch){
        const pickLabel=`出售选中（${batchItems.length}）`,width=batchBar.width-158;
        v.button('',batchBar.x+158,batchBar.y-42,width,40,
          ()=>this.sellBatch(),{fontSize:16,disabled:!batchItems.length}).setData('label','出售选中');
        this.buttonText('shop-batch-sell',pickLabel,batchBar.x+158,batchBar.y-42,width,40,false,16);
      }
    }
    if(this.selection)this.selection.step==='description'?this.renderDescription(description??v,this.selection):this.renderModal(modal);
  }
  /**
   * 物品说明面板：图标、名称、类型与等级、说明文字，装备再补适用职业，底部一枚"购买／出售"、
   * 右上角一枚关闭。原版这一层的正文由 `UIDesc_MakeItem` 生成，买到手的东西与背包里看到的
   * 内容一样；落点见 `descriptionLayout`（买入落背包栏、卖出落货架栏）。
   */
  private renderDescription(v:UiSurface,selection:Selection):void{
    const offer=selection.kind==='buy'?this.store.offers.find(offer=>offer.id===selection.id&&!offer.sold):undefined;
    const entry:ItemInstance|undefined=selection.kind==='buy'?offer?.instance:this.session.bag.get(selection.id);
    if(!entry){this.selection=undefined;return;}
    const item=this.session.bag.catalog.items[entry.item];
    // 面板盖住点选来源的对面那一栏，宽度就跟那一栏一样：买入落背包栏、卖出落货架栏(462／395)。
    // 盖背包栏时右边缘让开右侧那一列分类按钮（BAG_DESCRIPTION_WIDTH），与背包页同一套规则。
    const covered=selection.kind==='buy'?this.layout.bagFrame:this.layout.leftFrame,
      panel=descriptionPanel(selection.kind==='buy'?BAG_DESCRIPTION_WIDTH:covered.width),left=covered.x,top=panel.y;
    // 说明侧栏与背包共用不透明内容区，页面压暗交给菜单遮罩。
    // 整块先铺透明拦截层，避免点击穿透到被盖住的货架/背包按钮。
    v.rect(left,top,panel.width,DESCRIPTION_PANEL.height,0x000000,0).setInteractive();
    drawDescriptionPanel(v,this.frames,left,top,panel.width,DESCRIPTION_PANEL.height);
    const member=this.viewedMember();
    const body=itemDescriptionBody({item,entry,numbers:this.store.characterStats.equipment[entry.item],catalog:this.store.characterStats,
      grades:this.catalog.grades,member,classNames:this.classNames,gemNames:entry.gems.map(id=>this.session.bag.catalog.items[id]?.name),skill:entry.skill?this.session.bag.catalog.skillDescriptions?.[entry.skill]:undefined,concealed:offer?.concealed});
    const writer:MenuTextWriter={add:spec=>this.detailText.push(spec)};
    drawDescriptionTitle(body.title,left,top,panel.width,body.color,{writer,keyPrefix:'shop-detail-title'});
    const ownEquipment=selection.kind==='sell'&&!!item.equipment;
    const actions:{label:string;run:()=>void;disabled?:boolean}[]=[];
    if(!this.cleaning)actions.push({label:selection.kind==='buy'?'购买':'出售',run:()=>this.beginTrade(),disabled:selection.kind==='sell'&&!!entry.locked});
    if(ownEquipment)actions.push({label:entry.locked?'解锁':'上锁',run:()=>{
      this.session.bag.setLocked(entry.id,!entry.locked);
      if(this.cleaning)this.selection=undefined;this.changed();
    }});
    const actionLayout=descriptionActionLayout(panel.width,actions.length),detailHeight=actionLayout.scrollHeight;
    const detail=this.scrollAt(v,'shop-detail',left+panel.scroll.x,top+panel.scroll.y,panel.scroll.width,detailHeight);
    detail.onScroll=()=>this.text?.refresh();
    let y=drawDescriptionRows(v,body.rows,panel.scroll.width,
      {writer,keyPrefix:'shop-detail-row',x:left+panel.scroll.x,y:top+panel.scroll.y,scroll:'shop-detail',
        clip:{top:top+panel.scroll.y,bottom:top+panel.scroll.y+detailHeight}});
    detail.setHeight(y);
    drawDescriptionClose(v,this.frames,panel,left,top,()=>this.cancel());
    // 面板盖住背包栏时，底下的金币行让位；单价改在滚动区与按钮之间的空带里重画，
    // 玩家开面板就能看到这件东西多少钱，不用先点「购买」再退回确认框。
    const priceY=top+panel.scroll.y+detailHeight+2,priceX=left+panel.scroll.x,
      coinX=priceX+46,coinValue=splitMoney(this.price(selection)),{stride,coin,digit,color}=this.layout.money;
    this.addDetail('shop-detail-price-label','价格',priceX,priceY+20,18,AREA_COLOR,0,.5);
    MONEY_UNITS.forEach((unit,index)=>{
      v.image(this.catalog.assets[unit],coinX+index*stride,priceY,coin.width,coin.height);
      this.addDetail(`shop-detail-price-${unit}`,String(coinValue[unit]),coinX+index*stride+digit.x,priceY+digit.y,21,color);
    });
    actions.forEach((action,index)=>{
      const r=actionLayout.buttons[index]!;
      v.button('',left+r.x,top+r.y,r.width,r.height,action.run,{disabled:action.disabled}).setData('label',action.label);
      this.detailButtonText(`shop-detail-action-${index}`,action.label,left+r.x,top+r.y,r.width,r.height);
    });
  }
  private renderModal(v:UiSurface):void{
    this.modalText=[];
    const selection=this.selection!;
    const offer=selection.kind==='buy'?this.store.offers.find(offer=>offer.id===selection.id&&!offer.sold):undefined;
    const entry:ItemInstance|undefined=selection.kind==='buy'?offer?.instance:this.session.bag.get(selection.id);
    if(!entry){this.selection=undefined;return;}
    const item=this.session.bag.catalog.items[entry.item],buying=selection.kind==='buy',verb=buying?'购买':'出售';
    v.visible(true);
    if(selection.step==='notice'){this.renderBox(v,['此物品无法出售'],()=>this.cancel(),{cancel:false});return;}
    const total=this.price(selection)*selection.quantity;
    if(selection.step==='quantity'){this.renderQuantity(v,selection,total,item.icon);return;}
    const insufficient=buying&&this.session.money<total;
    this.renderBox(v,
      [`确定${verb} ${item.name}${selection.quantity>1?` × ${selection.quantity}`:''}？`,selection.error??(insufficient?'金币不足':undefined)],
      ()=>{
        // Clear before the session notification renders the updated shelves and wallet.
        this.selection=undefined;
        let failed=true;
        try{if(buying)this.store.buy(selection.id,selection.quantity);else this.store.sell(selection.id,selection.quantity);failed=false;}
        catch(error){selection.error=(error as Error).message;this.selection=selection;}
        // 成功时 session 通知已经重画过；只有失败需要本地重画来显示错误。
        if(failed)this.changed();
      },{total,disabled:insufficient});
  }
  /**
   * 数量框：框内先铺黑底，计数区左边是物品图标、右边是数量，下方是带文本底板的金额，
   * 底部两枚按钮确定在左、取消在右。
   */
  private renderQuantity(v:UiSurface,selection:Selection,total:number,icon:string):void{
    const box=tradeLayout.quantity,{field,step,button}=box,maximum=this.maximum(selection.kind);
    this.placeModal?.(box.width,box.height);
    drawPopupPanel(v,this.frames,box.width,box.height);
    v.image(icon,box.icon.x,box.icon.y,box.icon.size,box.icon.size);
    const minus=v.button('',field.x,field.y,step.width,step.height,()=>this.stepQuantity(-1),
      {image:this.catalog.assets['count-left'],pressed:this.catalog.assets['count-left-pressed'],disabled:selection.quantity<=1,hold:QUANTITY_HOLD});
    const plus=v.button('',field.x+step.right,field.y,step.width,step.height,()=>this.stepQuantity(1),
      {image:this.catalog.assets['count-right'],pressed:this.catalog.assets['count-right-pressed'],disabled:selection.quantity>=maximum,hold:QUANTITY_HOLD});
    this.addModal('shop-quantity-count',String(selection.quantity),box.count.x,box.count.y,30,box.count.color);
    v.textPlate(this.catalog.assets['text-plate-left'],this.catalog.assets['text-plate-right'],box.textPlate.x,box.textPlate.y,box.textPlate.width);
    this.quantityButtons={minus,plus};
    this.money(v,total,box.money.x,box.money.y,'shop-quantity-money',true);
    // 重画时（比如买完之后会话又通知了一次）把箭头按当前数量重新摆好，不能沿用上一件的灰态。
    this.syncQuantity();
    v.button('',button.left,button.y,button.width,button.height,()=>{selection.step='confirm';if(!this.incrementalDescription||!this.refreshModal())this.changed();}).setData('label','确定');
    this.buttonText('shop-quantity-confirm','确定',button.left,button.y,button.width,button.height,true);
    v.button('',button.right,button.y,button.width,button.height,()=>this.cancel()).setData('label','取消');
    this.buttonText('shop-quantity-cancel','取消',button.right,button.y,button.width,button.height,true);
  }
  /**
   * 数量加减只改数量框里的数字、金额和两枚箭头的灰/亮，不通知菜单重画。
   * 玩家明确要求过：数量变化不允许整页重画。
   */
  private stepQuantity(delta:number):void{
    const selection=this.selection;
    if(!selection)return;
    const next=Math.min(this.maximum(selection.kind),Math.max(1,selection.quantity+delta));
    if(next===selection.quantity)return;
    selection.quantity=next;
    this.syncQuantity();
  }
  /** 把当前数量刷到已经画好的数量框上；数量框还没画出来时什么都不做。 */
  private syncQuantity():void{
    const selection=this.selection,buttons=this.quantityButtons;
    if(!selection||!buttons)return;
    const quantity=selection.quantity,maximum=this.maximum(selection.kind),value=splitMoney(this.price(selection)*quantity);
    // 数量框已经渲染过、DOM 层也应用过这一页时才存在这些标签；第一次绘制由规格直接带上当前值。
    this.text?.setText('shop-quantity-count',String(quantity));
    MONEY_UNITS.forEach(unit=>this.text?.setText(`shop-quantity-money-${unit}`,String(value[unit])));
    this.enableButton(buttons.minus,quantity>1);
    this.enableButton(buttons.plus,quantity<maximum);
  }
  /** 按钮自己带着开关回调（见 widgets 的 `button`），这里只负责取出来按一下。 */
  private enableButton(button:UiNode,enabled:boolean):void{
    (button.getData('setEnabled') as ((value:boolean)=>void)|undefined)?.(enabled);
  }
  /**
   * 确认框与原版一样只有文字、金额和按钮：框内铺黑底，金额带文本底板，
   * 有取消时两枚并排（确定在左、取消在右），没有取消时确定居中。
   * 高度按内容算，和原版一样随文字增减；画布锚点跟着这个高度走，所以框始终居中。
   */
  private renderBox(v:UiSurface,lines:(string|undefined)[],confirm:()=>void,
    {total=0,disabled=false,cancel=true}:{total?:number;disabled?:boolean;cancel?:boolean}={}):void{
    const shown=(lines.filter(Boolean) as string[]).map(value=>{
      const question=value.includes('？');
      return{value,size:question?26:22,color:question?undefined:'#e9a08a'};
    });
    // 正文按实际换行高度量；超过原版 200 像素正文区时改用滚动布局。
    const heights=shown.map(line=>{
      const probe=v.text(line.value,0,0,410,line.size,line.color??'#ffffff');
      const height=probe.height;probe.destroy();return height;
    });
    const contentHeight=heights.reduce((sum,height)=>sum+height,0)+Math.max(0,shown.length-1)*3;
    // 正文区固定 200 高；有金额时下面还要留 34 高底板和 12 的间隔，正文只能用到 162。
    const bodyCapacity=total>0?162:200;
    const scrollLayout=contentHeight>bodyCapacity?tradeMessageScrollLayout(contentHeight,total>0):undefined;
    const box=scrollLayout??tradeMessageLayout(shown.length,total>0,contentHeight),{button}=box;
    // 框从画布左上角开始画，居中交给锚点（按框高算），不再自己算垂直偏移。
    this.placeModal?.(box.width,box.height);
    drawPopupPanel(v,this.frames,box.width,box.height);
    if(scrollLayout){
      const scroll=this.scrollAt(v,'shop-confirm',scrollLayout.body.x,scrollLayout.body.y,
        scrollLayout.body.width,scrollLayout.body.height);
      scroll.setHeight(contentHeight);scroll.scrollTop=0;
      let y=scrollLayout.body.y;
      shown.forEach((line,index)=>{
        this.modalText.push({key:`shop-confirm-line-${index}`,text:line.value,x:scrollLayout.text.x,y,
          style:{size:line.size,color:line.color,anchorX:.5,anchorY:0,width:410,align:'center',wrap:'word'},
          scroll:'shop-confirm',clip:{top:scrollLayout.body.y,bottom:scrollLayout.body.y+scrollLayout.body.height}});
        y+=heights[index]!+3;
      });
    } else {
      let y=box.text.y;
      shown.forEach((line,index)=>{
        // 纵轴原点取顶边：布局里的 text.y 是问题行的上沿，与黑底的上边同一行。
        this.addModal(`shop-confirm-line-${index}`,line.value,box.text.x,y,
          line.size,line.color,.5,0,{width:410,align:'center',wrap:'word'});
        y+=heights[index]!+3;
      });
    }
    if(total){
      v.textPlate(this.catalog.assets['text-plate-left'],this.catalog.assets['text-plate-right'],box.textPlate.x,box.textPlate.y,box.textPlate.width);
      this.money(v,total,box.money.x,box.money.y,'shop-confirm-money',true);
    }
    if(cancel){
      v.button('',button.right,button.y,button.width,button.height,()=>this.cancel()).setData('label','取消');
      this.buttonText('shop-confirm-cancel','取消',button.right,button.y,button.width,button.height,true);
    }
    const confirmX=cancel?button.left:(box.width-button.width)/2;
    v.button('',confirmX,button.y,button.width,button.height,confirm,{disabled}).setData('label','确定');
    this.buttonText('shop-confirm-accept','确定',confirmX,button.y,button.width,button.height,true);
  }
}
