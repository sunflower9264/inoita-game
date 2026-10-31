import type { Session } from '../../domain/session.ts';
import type { ItemInstance } from '../../domain/items.ts';
import type { ShopCatalog, Storefront } from '../../domain/shop.ts';
import { moneyText, splitMoney } from '../../domain/money.ts';
import { itemDescriptionBody } from '../item-detail-lines.ts';
import { INVENTORY_LABELS, INVENTORY_SIDE_FILTERS, matchesFilter, type InventoryFilter } from '../../domain/inventory.ts';

import { shopLayout, tradeLayout, tradeMessageLayout, type ShopLayout } from '../shop-layout.ts';
import { TEXT_COLORS } from '../text-style.ts';
import { BAG_DESCRIPTION_WIDTH, descriptionPanel, SIDE_FILTER_TEXT_SIZE } from '../bag-layout.ts';
import type { PlaceModal } from './modal-placement.ts';
import { drawDescriptionClose, drawDescriptionPanel, drawDescriptionRows, drawDescriptionTitle } from './description-panel.ts';
import { drawPopupPanel } from './popup-panel.ts';
import type { UiSurface, ScrollArea } from './widgets.ts';

type Selection = {kind:'buy'|'sell'; id:string; step:'description'|'quantity'|'confirm'|'notice'; quantity:number; error?:string};

const SHELF_SLOTS=16;
/** 金额的三个单位，顺序与金币那一行的横坐标一致。 */
const MONEY_UNITS=['gold','silver','copper'] as const;
const AREA_COLOR=TEXT_COLORS.primary;

/** The merchant and the player's bag remain visible throughout a trade. */
export class ShopPanel {
  private selection?:Selection;
  /** 批量出售模式：点背包格改为勾选，不弹说明面板。 */
  private batch=false;
  private readonly batchSelection=new Set<string>();
  private batchError?:string;
  private bagScroll?:ScrollArea;
  private categoryScroll?:ScrollArea;
  /**
   * 数量框里会变的三个东西：中间的数字、下面那行金额的每一位、左右两枚箭头。
   * 加减只改它们三个，不触发整页重画——玩家明确要求过数量变化不能重刷界面。
   */
  private quantityCount?:Phaser.GameObjects.Text;
  private quantityMoney?:Phaser.GameObjects.Text[];
  private quantityButtons?:{minus:Phaser.GameObjects.Container;plus:Phaser.GameObjects.Container};
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
  constructor(store:Storefront,session:Session,catalog:ShopCatalog,frames:Record<string,string>,changed:()=>void,
    viewedMember?:()=>{classId:string;level:number}|undefined,classNames?:Record<string,string>){
    this.store=store;this.session=session;this.catalog=catalog;this.frames=frames;this.changed=changed;
    this.viewedMember=viewedMember??(()=>session.party?.get(session.party.controlledId)??session.hero);
    this.classNames=classNames;
  }
  /**
   * 说明面板画在商店面板自己身上——原版它是主界面上的一个控件，只有数量框与确认框才占弹层画布。
   * 所以停在说明步时不算"弹层打开"，主画布照常收输入。
   */
  get modalOpen():boolean{return !!this.selection&&this.selection.step!=='description';}
  /** 有选中就存在，不管停在哪一步；批量模式同样算“在商店里”，关闭键据此逐级退回。 */
  get active():boolean{return !!this.selection||this.batch;}
  captureScroll():void{this.bagOffset=this.bagScroll?.scrollTop??this.bagOffset;this.categoryOffset=this.categoryScroll?.scrollTop??this.categoryOffset;}
  cancel():void{
    this.selection=undefined;
    this.batch=false;this.batchSelection.clear();this.batchError=undefined;
    this.changed();
  }
  /**
   * 面板调试入口：直接摆到某个交易步骤，跳过「点货架格买、点背包格卖」的点击链路。
   * 只给 `?ui-debug` 的调试场景用。可用堆叠商品的 `quantity` 步骤会自动挑一件能买多件的商品；
   * `notice` 则挑第一件不可出售的物品。
   */
  debugTrade(step:'description'|'quantity'|'confirm'|'notice',kind:'buy'|'sell'='buy'):void{
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
      const entries=this.session.bag.entries;
      const entry=step==='notice'
        ?entries.find(value=>this.store.sellPrice(value)===0)
        :entries.find(value=>this.store.sellPrice(value)>0);
      if(!entry)return;
      this.select('sell',entry.id);
    }
    if(this.selection&&(step==='quantity'||step==='confirm')){
      this.selection.step=step;
      if(step==='quantity')this.selection.quantity=Math.min(2,Math.max(1,this.maximum(this.selection.kind)));
    }
    this.changed();
  }
  /** 原版点货架格买、点背包格卖都先弹物品说明面板；只有不可出售才跳过它直接提示。 */
  private select(kind:'buy'|'sell',id:string):void{
    this.selection={kind,id,step:'description',quantity:1};
    const entry=kind==='sell'?this.session.bag.get(id):undefined;
    if(kind==='sell'&&(!entry||this.store.sellPrice(entry)===0))this.selection.step='notice';
    this.changed();
  }
  /** 说明面板底部那枚按钮：可一次买多件的进数量框，其余直接确认（原版 `UIStore_ButtonBuyExe` 同此）。 */
  private beginTrade():void{
    const selection=this.selection!;
    selection.step=this.maximum(selection.kind)>1?'quantity':'confirm';
    this.changed();
  }
  /** 普通堆叠商品可一次买 1–99；限量随机商品与不可堆叠商品一次一件；出售上限是持有数量。 */
  private maximum(kind:'buy'|'sell'):number{
    const selection=this.selection!;
    if(kind==='sell')return this.session.bag.get(selection.id)?.quantity??1;
    const offer=this.store.offers.find(offer=>offer.id===selection.id&&!offer.sold);
    const item=offer&&this.session.bag.catalog.items[offer.instance.item];
    return offer&&item&&!offer.limited&&item.stackable?99:1;
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
      if(!entry||price<=0){this.batchSelection.delete(id);continue;}
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
  /**
   * 原版先画币再画数字：单位间距 103，币 44×40，数字左对齐于币右侧 44、下移 6、白色。
   * 返回三个数字对象，加减数量时只改它们的文字。
   */
  private money(v:UiSurface,amount:number,x:number,y:number):Phaser.GameObjects.Text[]{
    const {stride,coin,digit,color}=this.layout.money,value=splitMoney(amount),digits:Phaser.GameObjects.Text[]=[];
    MONEY_UNITS.forEach((unit,index)=>{
      v.image(this.catalog.assets[unit],x+index*stride,y,coin.width,coin.height);
      digits.push(v.text(String(value[unit]),x+index*stride+digit.x,y+digit.y,0,21,color));
    });
    return digits;
  }
  render(v:UiSurface,modal:UiSurface,placeModal?:PlaceModal,description?:UiSurface):void{
    this.placeModal=placeModal;
    const {store,session,catalog}=this,classified=store.shop.categories.length>0;
    const layout=this.layout=shopLayout(classified),{leftFrame,bagFrame,title,shelf,bag,slot,category}=layout;
    // 两栏都只有图框：`UIStore_Draw` 与 `UIStore_DrawInvenBackground` 都只调 `UI_DrawBorderRect`，
    // 面板里看到的是黑色 65% 遮罩下的世界画面（见 `work/findings/menu-backdrop-2026-10-11.md`），
    // 所以这里不能用带填充的 `frame()`——那会把两栏刷成一块不透明的深棕，与背包页也对不上。
    // 两栏图框、店名和货架空格子不随筛选/选中变化，放进静态层只画一次。
    v.staticLayer(`shop:${store.shop.name}:${classified}`,()=>{
      v.border(this.frames,leftFrame.x,leftFrame.y,leftFrame.width,leftFrame.height,v.staticRoot);
      v.border(this.frames,bagFrame.x,bagFrame.y,bagFrame.width,bagFrame.height,v.staticRoot);
      v.image(catalog.assets['merchant-title'],title.x,title.y,title.width,title.height,v.staticRoot);
      v.text(store.shop.name,layout.titleName.x,layout.titleName.y,230,26,AREA_COLOR,v.staticRoot).setOrigin(.5);
      if(classified){
        const column=layout.categoryColumn;
        v.image(catalog.assets['category-cap-top'],column.cap.x,column.cap.y,column.cap.width,column.cap.height,v.staticRoot);
        v.image(catalog.assets['category-cap-bottom'],column.cap.x,column.cap.bottom,column.cap.width,column.cap.height,v.staticRoot);
        v.image(catalog.assets['category-divider'],column.divider.x,column.divider.y,column.divider.width,column.divider.height,v.staticRoot);
        v.textPlate(catalog.assets['text-plate-left'],catalog.assets['text-plate-right'],category.plate.x,category.plate.y,category.plate.width,v.staticRoot);
      }
      v.textPlate(catalog.assets['text-plate-left'],catalog.assets['text-plate-right'],layout.money.plate.x,layout.money.plate.y,layout.money.plate.width,v.staticRoot);
      for(let index=0;index<SHELF_SLOTS;index++){
        const x=shelf.x+index%4*slot.stride,y=shelf.y+Math.floor(index/4)*slot.stride;
        v.image(catalog.assets.slot,x,y,slot.size,slot.size,v.staticRoot);
      }
    });
    if(classified){
      // 分类列的滚动区与按钮随筛选重建；端盖和竖条已经在静态层。
      this.categoryScroll=v.scroll(category.scroll.x,category.scroll.y,category.scroll.width,category.scroll.height);
      store.shop.categories.forEach((name,index)=>v.button('',0,index*category.button.stride,category.button.width,category.button.height,
        ()=>{store.selectCategory(name);this.changed();},
        {image:catalog.assets[`${name}${store.category===name?'-selected':''}`],parent:this.categoryScroll!.content,guard:this.categoryScroll!.guard})
        .setData('label',catalog.categories[name].name));
      this.categoryScroll.setHeight(store.shop.categories.length*category.button.stride);this.categoryScroll.scrollTop=this.categoryOffset;
      v.text(catalog.categories[store.category!].name,category.name.x,category.name.y,290,22,AREA_COLOR).setOrigin(.5);
    }
    for(let index=0;index<SHELF_SLOTS;index++){
      const x=shelf.x+index%4*slot.stride,y=shelf.y+Math.floor(index/4)*slot.stride,offer=store.offers[index];
      if(!offer||offer.sold)continue;
      const item=session.bag.catalog.items[offer.instance.item];
      const button=v.button('',x,y,slot.size,slot.size,()=>this.select('buy',offer.id),{bare:true}).setData('label',`购买 ${item.name}`);
      v.image(item.icon,slot.icon.x,slot.icon.y,slot.icon.size,slot.icon.size,button);
      if(this.selection?.id===offer.id)v.image(catalog.assets.selection,slot.selection.x,slot.selection.y,slot.selection.size,slot.selection.size,button);
    }
    this.bagScroll=v.scroll(bag.x,bag.y,bag.width,bag.height);
    const entries=session.bag.entries.filter(entry=>matchesFilter(session.bag.catalog.items[entry.item],this.filter)
        &&(!this.batch||this.store.sellPrice(entry)>0)),
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
      // 角标挂在格子容器上，坐标相对格子左上角。
      if(entry.quantity>1)v.text(String(entry.quantity),layout.badge.x,layout.badge.y,0,20,layout.badge.color,button).setOrigin(1,0);
      if(this.selection?.id===entry.id||this.batchSelection.has(entry.id))v.image(catalog.assets.selection,slot.selection.x,slot.selection.y,slot.selection.size,slot.selection.size,button);
    }
    this.bagScroll.setHeight(Math.ceil(slots/bag.columns)*bag.stride);this.bagScroll.scrollTop=this.bagOffset;
    const batchItems=this.batch?this.batchEntries():[],
      batchTotal=batchItems.reduce((sum,{entry,price})=>sum+price*entry.quantity,0);
    if(this.batch){
      // 批量模式把金额栏临时改成“本次出售合计”，避免和当前持有金币混在一起。
      const plate=layout.money.plate,label=this.batchError??`合计 ${moneyText(batchTotal)}`;
      v.text(label,plate.x+plate.width/2,plate.y+2,plate.width,20,this.batchError?'#e9a08a':layout.money.color).setOrigin(.5,0);
    }else this.money(v,session.money,layout.money.x,layout.money.y);
    // 背包栏右侧那 6 个按钮与背包页是同一列、同一套画法：常态外框是图组 15 索引 20，
    // 选中的那一个在按钮矩形 −(5,12) 上再叠索引 19。原版 `UIStore_DrawInvenBagGroup`
    // 用它们切换背包分类，所以卖东西时看到的就是筛出来的那一类。
    // 说明面板与它盖住的那一栏同宽，所以这一列（在框外）不会被整列压住：照常画出来，
    // 玩家买进时仍然看得到、点得到分类。
    const side=layout.sideButtons;
    INVENTORY_SIDE_FILTERS.forEach((filter,index)=>{
        const button=v.button('',side.x,side.y+side.offsets[index],side.width,side.height,
          ()=>{this.filter=filter;this.bagOffset=0;if(this.bagScroll)this.bagScroll.scrollTop=0;
            this.batchSelection.clear();this.batchError=undefined;this.changed();},{bare:true});
        v.image(this.frames['page-button-frame'],-5,-12,undefined,undefined,button);
        if(this.filter===filter)v.image(this.frames['page-button-selected'],-5,-12,undefined,undefined,button);
        v.text(INVENTORY_LABELS[filter],side.width/2,side.height/2,side.width-6,SIDE_FILTER_TEXT_SIZE,undefined,button).setOrigin(.5);
      button.setData('label',INVENTORY_LABELS[filter]);
    });
    if(this.filter===INVENTORY_SIDE_FILTERS[0])v.image(this.frames['column-cap-top'],side.x-19,side.y-12,21,34);
    if(this.filter===INVENTORY_SIDE_FILTERS.at(-1))v.image(this.frames['column-cap-bottom'],side.x-19,side.y+side.offsets.at(-1)!+38,21,34);
    // 批量出售的入口与动作放在背包框上方那一条空带里（和标题框同一高度），不占格子。
    // 说明面板打开时先收起，避免和“出售”那一步抢同一块区域。
    if(!this.selection){
      const batchBar=this.layout.bagFrame;
      v.button(this.batch?'退出批量':'批量出售',batchBar.x,batchBar.y-42,150,40,()=>this.toggleBatch(),
        {fontSize:16,selected:this.batch}).setData('label',this.batch?'退出批量':'批量出售');
      if(this.batch)v.button(`出售选中（${batchItems.length}）`,batchBar.x+158,batchBar.y-42,batchBar.width-158,40,
        ()=>this.sellBatch(),{fontSize:16,disabled:!batchItems.length}).setData('label','出售选中');
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
    drawDescriptionPanel(v,this.frames,left,top,panel.width);
    const member=this.viewedMember();
    const body=itemDescriptionBody({item,entry,numbers:this.store.characterStats.equipment[entry.item],catalog:this.store.characterStats,
      grades:this.catalog.grades,member,classNames:this.classNames,gemNames:entry.gems.map(id=>this.session.bag.catalog.items[id]?.name),skill:entry.skill?this.session.bag.catalog.skillDescriptions?.[entry.skill]:undefined,concealed:offer?.concealed});
    drawDescriptionTitle(v,body.title,left,top,panel.width,body.color);
    const detail=v.scroll(left+panel.scroll.x,top+panel.scroll.y,panel.scroll.width,panel.scroll.height);
    let y=drawDescriptionRows(v,body.rows,panel.scroll.width,detail.content);
    detail.setHeight(y);
    drawDescriptionClose(v,this.frames,panel,left,top,()=>this.cancel());
    v.button(selection.kind==='buy'?'购买':'出售',left+panel.menu.x+panel.menu.offsets[1],top+panel.menu.y,
      panel.menu.button.width,panel.menu.button.height,()=>this.beginTrade());
  }
  private renderModal(v:UiSurface):void{
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
      {image:this.catalog.assets['count-left'],pressed:this.catalog.assets['count-left-pressed'],disabled:selection.quantity<=1});
    const plus=v.button('',field.x+step.right,field.y,step.width,step.height,()=>this.stepQuantity(1),
      {image:this.catalog.assets['count-right'],pressed:this.catalog.assets['count-right-pressed'],disabled:selection.quantity>=maximum});
    this.quantityCount=v.text(String(selection.quantity),box.count.x,box.count.y,0,30,box.count.color);
    v.textPlate(this.catalog.assets['text-plate-left'],this.catalog.assets['text-plate-right'],box.textPlate.x,box.textPlate.y,box.textPlate.width);
    this.quantityButtons={minus,plus};
    this.quantityMoney=this.money(v,total,box.money.x,box.money.y);
    // 重画时（比如买完之后会话又通知了一次）把箭头按当前数量重新摆好，不能沿用上一件的灰态。
    this.syncQuantity();
    v.button('确定',button.left,button.y,button.width,button.height,()=>{selection.step='confirm';this.changed();});
    v.button('取消',button.right,button.y,button.width,button.height,()=>this.cancel());
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
    const selection=this.selection,count=this.quantityCount,buttons=this.quantityButtons;
    if(!selection||!count||!buttons)return;
    const quantity=selection.quantity,maximum=this.maximum(selection.kind),value=splitMoney(this.price(selection)*quantity);
    count.setText(String(quantity));
    this.quantityMoney?.forEach((text,index)=>text.setText(String(value[MONEY_UNITS[index]])));
    this.enableButton(buttons.minus,quantity>1);
    this.enableButton(buttons.plus,quantity<maximum);
  }
  /** 按钮自己带着开关回调（见 widgets 的 `button`），这里只负责取出来按一下。 */
  private enableButton(button:Phaser.GameObjects.Container,enabled:boolean):void{
    (button.getData('setEnabled') as ((value:boolean)=>void)|undefined)?.(enabled);
  }
  /**
   * 确认框与原版一样只有文字、金额和按钮：框内铺黑底，金额带文本底板，
   * 有取消时两枚并排（确定在左、取消在右），没有取消时确定居中。
   * 高度按内容算，和原版一样随文字增减；画布锚点跟着这个高度走，所以框始终居中。
   */
  private renderBox(v:UiSurface,lines:(string|undefined)[],confirm:()=>void,
    {total=0,disabled=false,cancel=true}:{total?:number;disabled?:boolean;cancel?:boolean}={}):void{
    const shown=lines.filter(Boolean) as string[],box=tradeMessageLayout(shown.length,total>0),{button}=box;
    // 框从画布左上角开始画，居中交给锚点（按框高算），不再自己算垂直偏移。
    this.placeModal?.(box.width,box.height);
    drawPopupPanel(v,this.frames,box.width,box.height);
    shown.forEach((value,line)=>{
      const question=value.includes('？');
      // 纵轴原点取顶边：布局里的 text.y 是问题行的上沿，与黑底的上边同一行。
      v.text(value,box.text.x,box.text.y+line*box.text.step,410,question?26:22,question?undefined:'#e9a08a').setOrigin(.5,0);
    });
    if(total){
      v.textPlate(this.catalog.assets['text-plate-left'],this.catalog.assets['text-plate-right'],box.textPlate.x,box.textPlate.y,box.textPlate.width);
      this.money(v,total,box.money.x,box.money.y);
    }
    if(cancel)v.button('取消',button.right,button.y,button.width,button.height,()=>this.cancel());
    v.button('确定',cancel?button.left:(box.width-button.width)/2,button.y,button.width,button.height,confirm,{disabled});
  }
}
