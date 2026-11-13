import { drawBagRail } from './bag-rail.ts';
import type { UiPointer } from '../dom/node.ts';
import type { UiNode, UiImage } from '../dom/node.ts';
import {equipmentPower} from '../../domain/character-stats.ts';
import {equipmentLevel} from '../../domain/chaos-equipment.ts';
import {itemDescriptionBody} from '../item-detail-lines.ts';
import {equipmentSlotFrame} from '../item-name-color.ts';
import type {ShopCatalog} from '../../domain/shop.ts';
import {EquipmentCrafting,CraftingError,type CraftingQuote,type RecipeQuote,type SocketQuote} from '../../domain/crafting.ts';
import type {ChaosTier} from '../../domain/chaos-equipment.ts';
import type {MenuPanels} from '../../domain/menu-panels.ts';
import {inventoryView,INVENTORY_SIDE_FILTERS,INVENTORY_LABELS,type InventoryView} from '../../domain/inventory.ts';
import {bagLayout} from '../bag-layout.ts';
import {TEXT_COLORS} from '../text-style.ts';
import {moneyText,splitMoney} from '../../domain/money.ts';
import {drawNativeMessage, type NativeMessageBand} from './native-message.ts';
import type {UiSurface,ScrollArea} from './widgets.ts';
import {GOLD} from './widgets.ts';
import type {MenuTextSpec,MenuTextWriter} from '../dom/menu-text.ts';

/** 合成台文字落点：滚动区由宿主登记，刷新只重算 DOM 位置。 */
interface CraftingTextTarget {
  scroll(name:string,x:number,y:number,width:number,height:number,surface?:UiSurface):ScrollArea;
  refresh():void;
  updatePage?():void;
  removeScroll?(scroll:ScrollArea):void;
  runCommit?(action:()=>void):void;
}

interface CraftingDrop {object:UiNode|UiImage;entry?:string;view?:InventoryView;cell?:number;craft?:boolean}
type Confirmation={kind:'chaos';quote:CraftingQuote}|{kind:'recipe';quote:RecipeQuote}|{kind:'socket';quote:SocketQuote};

/** 原版融合器：配方列表和装备混沌合成共用左侧加工区，右侧背包，消息沿用 UIPopupMsg。 */
export class CraftingPanel {
  readonly crafting:EquipmentCrafting;readonly panels:MenuPanels;private readonly grades:ShopCatalog['grades'];
  mode:'recipes'|'chaos'|'socket'='recipes';tier:ChaosTier='chaos';target?:string;recipe?:string;
  filter:InventoryView='all';private offset=0;private recipeOffset=0;
  bagScroll?:ScrollArea;private recipeScroll?:ScrollArea;drops:CraftingDrop[]=[];
  private message?:string;private confirmation?:Confirmation;private committing=false;
  private pageText:MenuTextSpec[]=[];private modalText:MenuTextSpec[]=[];private text?:CraftingTextTarget;
  private band?:NativeMessageBand;
  private surface?:UiSurface;
  private workNodes:UiNode[]=[];
  private workKeys=new Set<string>();
  private bagButtons=new Map<string,UiNode>();
  private targetMarker?:UiImage;
  private bagHighlight?:UiNode;
  private startDrag?:(pointer:UiPointer,entry:string,scroll:ScrollArea)=>void;
  private modeTabs=new Map<'recipes'|ChaosTier|'socket',UiNode>();
  private readonly changed:()=>void;private readonly sound:()=>void;private readonly modalChanged:()=>void;
  constructor(crafting:EquipmentCrafting,panels:MenuPanels,changed:()=>void,sound:()=>void,grades:ShopCatalog['grades']=[],modalChanged:()=>void=changed){this.grades=grades;this.crafting=crafting;this.panels=panels;this.changed=changed;this.sound=sound;this.modalChanged=modalChanged;}
  get modalOpen():boolean{return !!this.message||!!this.confirmation;}
  /** 原生提示横带在弹层本地坐标里的上下边界；页面文字按它让位。 */
  get messageBand():NativeMessageBand|undefined{return this.band;}
  captureScroll():void {this.offset=this.bagScroll?.scrollTop??this.offset;this.recipeOffset=this.recipeScroll?.scrollTop??this.recipeOffset;}
  close():void {this.message=undefined;this.confirmation=undefined;}
  cancel():void {const hadModal=this.modalOpen;this.message=undefined;this.confirmation=undefined;if(hadModal)this.modalChanged();else this.changed();}
  chooseMode(mode:'recipes'|ChaosTier|'socket'):void {
    if(mode==='recipes'||mode==='socket'){this.mode=mode;this.recipe=undefined;this.target=undefined;}
    else {this.mode='chaos';this.tier=mode;this.target=undefined;}
    const hadModal=this.modalOpen;this.close();
    if(!this.updateWork())this.changed();else if(hadModal)this.modalChanged();
  }
  select(target:string):void {
    if(this.mode==='recipes'||this.modalOpen||this.committing)return;
    const problem=this.mode==='socket'?this.crafting.targetSocketProblem(target):this.crafting.targetProblem(this.tier,target);
    if(problem){this.message=this.panels.itemMessages[problem];this.modalChanged();}
    else{this.target=target;if(!this.updateWork())this.changed();}
  }
  private selectRecipe(recipe:string):void {
    if(this.modalOpen||this.committing)return;
    this.recipe=recipe;if(!this.updateWork())this.changed();
  }
  private backToRecipes():void {this.recipe=undefined;if(!this.updateWork())this.changed();}
  private begin():void {
    if(this.modalOpen||this.committing)return;
    try {
      if(this.mode==='socket')this.confirmation={kind:'socket',quote:this.crafting.socketQuote(this.target)};
      else if(this.mode==='chaos')this.confirmation={kind:'chaos',quote:this.crafting.quote(this.tier,this.target)};
      else return;
    }
    catch(error){if(error instanceof CraftingError)this.message=this.panels.itemMessages[error.notice];else throw error;}
    this.modalChanged();
  }
  private beginRecipe():void {
    if(this.modalOpen||this.committing||!this.recipe)return;
    try {this.confirmation={kind:'recipe',quote:this.crafting.recipeQuote(this.recipe)};}
    catch(error){if(error instanceof CraftingError)this.message=this.panels.itemMessages[error.notice];else throw error;}
    this.modalChanged();
  }
  private confirm():void {
    const confirmation=this.confirmation;if(!confirmation||this.committing)return;
    this.committing=true;this.confirmation=undefined;
    const target=this.target;this.target=undefined;
    let committed=false;
    try {
      const commit=()=>{
        if(confirmation.kind==='chaos')this.crafting.commit(confirmation.quote);
        else if(confirmation.kind==='socket')this.crafting.socketCommit(confirmation.quote);
        else this.crafting.recipeCommit(confirmation.quote);
      };
      if(this.text?.runCommit)this.text.runCommit(commit);else commit();
      this.sound();committed=true;
    }
    catch(error){if(confirmation.kind!=='recipe')this.target=target;if(error instanceof CraftingError)this.message=this.panels.itemMessages[error.notice];else throw error;}
    finally {this.committing=false;}
    if(committed&&this.text?.runCommit){
      if(!this.updateAfterCommit())this.changed();else this.modalChanged();
    }else if(!committed)this.modalChanged();
  }
  private addText(key:string,text:string,x:number,y:number,size:number,color?:string,anchorX=0,anchorY=0,
    style:Partial<MenuTextSpec['style']>={},extras:Pick<MenuTextSpec,'scroll'|'clip'>={}):void {
    this.pageText.push({key,text,x,y,style:{size,color,anchorX,anchorY,...style},...extras});
  }
  private buttonText(key:string,label:string,x:number,y:number,width:number,height:number,
    size=Math.min(22,height*.42)):void {
    this.addText(key,label,x+width/2,y+height/2,size,GOLD,.5,.5);
  }
  private scrollAt(name:string,x:number,y:number,width:number,height:number):ScrollArea {
    return this.text?.scroll(name,x,y,width,height)??this.surface!.scroll(x,y,width,height);
  }
  renderText(writer:MenuTextWriter):void {for(const spec of this.pageText)writer.add(spec);}
  renderModalText(writer:MenuTextWriter):void {for(const spec of this.modalText)writer.add(spec);}
  render(v:UiSurface,modal:UiSurface,placeModal:(width:number,height:number)=>void,startDrag:(pointer:UiPointer,entry:string,scroll:ScrollArea)=>void,text?:CraftingTextTarget):void {
    this.pageText=[];this.modalText=[];this.band=undefined;this.text=text;this.surface=v;this.startDrag=startDrag;
    const assets=this.panels.assets;
    this.drops=[];this.bagButtons.clear();this.modeTabs.clear();this.targetMarker=undefined;this.recipeScroll=undefined;
    v.staticLayer('crafting',()=>{
      v.border(assets,10,0,462,431,v.staticRoot);
      drawBagRail(v,assets,496,v.staticRoot);
    });
    this.renderModeStrip(v);
    const before=new Set(v.root.list),textStart=this.pageText.length;
    if(this.mode==='recipes')this.renderRecipes(v);
    else if(this.mode==='socket')this.renderSocket(v);
    else this.renderChaos(v);
    this.workNodes=v.root.list.filter(node=>!before.has(node));
    this.workKeys=new Set(this.pageText.slice(textStart).map(spec=>spec.key));
    this.renderBag(v,startDrag);
    this.renderModal(modal,placeModal);
  }
  private updateAfterCommit():boolean{
    const v=this.surface,scroll=this.bagScroll,startDrag=this.startDrag;
    if(!v||!scroll||!startDrag||!this.text?.updatePage)return false;
    this.renderBagCells(v,scroll,startDrag);
    const wallet=splitMoney(this.crafting.session.money);
    for(const unit of ['gold','silver','copper'] as const){
      const spec=this.pageText.find(value=>value.key===`craft-bag-money-${unit}`);if(spec)spec.text=String(wallet[unit]);
    }
    return this.updateWork();
  }
  private updateWork():boolean{
    const v=this.surface;
    if(!v||!this.text?.updatePage)return false;
    for(const [mode,button] of this.modeTabs){
      const selected=mode==='chaos'||mode==='epic-chaos'?this.mode==='chaos'&&this.tier===mode:this.mode===mode;
      (button.getData('setSelected') as (value:boolean)=>void)(selected);
    }
    this.targetMarker?.destroy();this.targetMarker=undefined;
    const button=this.target?this.bagButtons.get(this.target):undefined;
    if(button)this.targetMarker=v.image(this.panels.assets['inventory-selected'],-5,-5,84,84,button);
    if(this.recipeScroll){
      this.recipeOffset=this.recipeScroll.scrollTop;this.text.removeScroll?.(this.recipeScroll);
      this.recipeScroll.destroy();const index=v.scrolls.indexOf(this.recipeScroll);if(index>=0)v.scrolls.splice(index,1);this.recipeScroll=undefined;
    }
    for(const node of this.workNodes)node.destroy();
    this.pageText=this.pageText.filter(spec=>!this.workKeys.has(spec.key));
    for(let i=this.drops.length-1;i>=0;i--)if(this.drops[i]!.craft)this.drops.splice(i,1);
    const before=new Set(v.root.list),textStart=this.pageText.length;
    if(this.mode==='recipes')this.renderRecipes(v);else if(this.mode==='socket')this.renderSocket(v);else this.renderChaos(v);
    this.workNodes=v.root.list.filter(node=>!before.has(node));
    this.workKeys=new Set(this.pageText.slice(textStart).map(spec=>spec.key));
    v.pruneDestroyed();this.text.updatePage();
    return true;
  }
  renderModal(modal:UiSurface,placeModal:(width:number,height:number)=>void):void {
    this.modalText=[];this.band=undefined;
    if(!this.modalOpen)return;
    placeModal(1024,640);
    const writer:MenuTextWriter={add:spec=>this.modalText.push(spec)};
    this.band=drawNativeMessage(modal,this.panels.assets,this.message??this.panels.itemMessages['craft-confirm'],()=>this.message?this.cancel():this.confirm(),this.confirmation?()=>this.cancel():undefined,writer,
      this.text?{scroll:(name,x,y,width,height)=>this.text!.scroll(name,x,y,width,height,modal)}:undefined);
  }
  private renderModeStrip(v:UiSurface):void {
    // 模式切换放在左侧框上方，不再占用框内第一行；按钮同步放大，手机上也更好点。
    const tab=(label:string,data:string,x:number,width:number,selected:boolean,mode:'recipes'|ChaosTier|'socket')=>{
      const button=v.button('',x,-46,width,42,()=>this.chooseMode(mode),{selected,fontSize:18}).setData('label',data);this.modeTabs.set(mode,button);
      this.buttonText(`craft-tab-${mode}`,label,x,-46,width,42,18);
    };
    tab('配方','切换融合模式',8,104,this.mode==='recipes','recipes');
    tab('混沌','混沌合成',116,104,this.mode==='chaos'&&this.tier==='chaos','chaos');
    tab('深渊混沌','深渊混沌合成',224,132,this.mode==='chaos'&&this.tier==='epic-chaos','epic-chaos');
    tab('宝石孔','宝石孔生成',360,112,this.mode==='socket','socket');
  }
  private renderRecipes(v:UiSurface):void {
    const assets=this.panels.assets,bag=this.crafting.session.bag,recipe=this.recipe?this.crafting.recipe(this.recipe):undefined;
    if(!recipe){
      const recipes=this.crafting.availableRecipes();
      if(!recipes.length){
        this.addText('craft-recipes-empty','还没有学会任何装备配方。\n使用合成套装或在任务中获得配方。',241,58,20,TEXT_COLORS.primary,.5,0,
          {width:380,align:'center',wrap:'word'});
        return;
      }
      const scroll=this.scrollAt('craft-recipes',34,26,412,347);this.recipeScroll=scroll;
      const clip={top:26,bottom:26+347};
      for(const [index,entry] of recipes.entries()){
        const y=index*44,definition=bag.catalog.items[entry.recipe.result];
        const button=v.button('',0,y,390,40,()=>this.selectRecipe(entry.id),{bare:true,parent:scroll.content,guard:scroll.guard}).setData('label',entry.recipe.name);
        v.image(definition.icon,4,4,32,32,button);
        this.addText(`craft-recipe-name-${index}`,entry.recipe.name,34+44,26+y+9,18,undefined,0,0,
          {width:300,wrap:'word'},{scroll:'craft-recipes',clip});
        this.addText(`craft-recipe-cost-${index}`,String(entry.recipe.cost),34+380,26+y+9,16,TEXT_COLORS.white,1,0,
          {width:52,align:'right'},{scroll:'craft-recipes',clip});
      }
      scroll.setHeight(recipes.length*44);scroll.scrollTop=this.recipeOffset;
      scroll.onScroll=()=>{this.recipeOffset=scroll.scrollTop;this.text?.refresh();};
      return;
    }
    v.button('',34,26,94,34,()=>this.backToRecipes(),{fontSize:18}).setData('label','返回配方');
    this.buttonText('craft-recipe-back','返回',34,26,94,34,18);
    this.addText('craft-recipe-title',recipe.name,136,28,24,TEXT_COLORS.primary,0,0,{width:312,wrap:'word'});
    const result=bag.catalog.items[recipe.result];
    const slot=v.button('',204,58,74,74,()=>{}, {image:assets['inventory-slot']}).setData('label',result.name);
    v.image(result.icon,5,5,64,64,slot);
    this.addText('craft-recipe-result',result.name,241,142,22,TEXT_COLORS.primary,.5,0,{width:410,align:'center',wrap:'word'});
    for(const [index,material] of recipe.materials.entries()){
      const x=49+index*104,available=bag.count(material.item),definition=bag.catalog.items[material.item];
      v.image(assets['inventory-slot'],x,181,74,74);v.image(definition.icon,x+5,186,64,64);
      this.addText(`craft-recipe-material-count-${index}`,`${available}/${material.quantity}`,x+37,264,22,
        available<material.quantity?TEXT_COLORS.requirementUnmet:TEXT_COLORS.primary,.5,0);
      this.addText(`craft-recipe-material-name-${index}`,definition.name,x+37,286,13,TEXT_COLORS.secondary,.5,0,
        {width:96,align:'center',wrap:'word'});
    }
    this.addText('craft-recipe-cost',`合成费 ${moneyText(recipe.cost)}`,241,310,18,TEXT_COLORS.white,.5,0,
      {width:300,align:'center',wrap:'word'});
    v.button('',139,336,205,62,()=>this.beginRecipe()).setData('label','组合');
    this.buttonText('craft-recipe-confirm','组合',139,336,205,62);
  }
  private renderChaos(v:UiSurface):void {
    const {session,catalog}=this.crafting,bag=session.bag,assets=this.panels.assets,op=catalog.operations[this.tier];
    if(this.target&&!bag.entries.some(entry=>entry.id===this.target))this.target=undefined;
    const target=this.target?bag.get(this.target):undefined,item=target?bag.catalog.items[target.item]:undefined;
    const frame=item&&target&&session.hero?equipmentSlotFrame(item,target.numbers,session.hero.catalog.equipment[target.item],this.grades,this.tier):undefined;
    const slot=v.button('',204,26,74,74,()=>{this.target=undefined;if(!this.updateWork())this.changed();},{image:assets[frame??'inventory-slot']}).setData('label','合成装备');
    if(item)v.image(item.icon,5,5,64,64,slot);
    this.drops.push({object:slot,craft:true});
    if(item&&target){
      const numbers=session.hero?.catalog.equipment[target.item],body=session.hero?itemDescriptionBody({item,entry:target,numbers,catalog:session.hero.catalog,grades:this.grades,gemNames:target.gems.map(id=>bag.catalog.items[id]?.name),chaosTier:this.tier}):undefined;
      this.addText('craft-chaos-title',body?.title??item.name,241,111,22,body?.color??TEXT_COLORS.primary,.5,0,
        {width:410,align:'center',wrap:'word'});
      if(numbers){const power=equipmentPower(numbers,target);this.addText('craft-chaos-stats',
        `等级 ${equipmentLevel(item,target)}　${item.priceKind==='weapon'?`物理攻击 ${power.attack}　魔法攻击 ${power.magicAttack}`:`防御力 ${power.defense}`}`,
        241,140,18,TEXT_COLORS.primary,.5,0,{width:410,align:'center',wrap:'word'});}
    }
    for(const [index,material] of op.materials.entries()){
      const x=49+index*104,available=bag.count(material.item),definition=bag.catalog.items[material.item];
      v.image(assets['inventory-slot'],x,165,74,74);v.image(definition.icon,x+5,170,64,64);
      this.addText(`craft-chaos-material-${index}`,`${available}/${material.quantity}`,x+37,248,22,
        available<material.quantity?TEXT_COLORS.requirementUnmet:TEXT_COLORS.primary,.5,0);
    }
    const coins=splitMoney(item?item.level*op.costPerLevel:0);
    for(const [index,unit] of (['gold','silver','copper'] as const).entries()){
      const x=82+index*103;v.image(assets[`craft-money-${unit}`],x,284,44,40);
      this.addText(`craft-chaos-money-${unit}`,String(coins[unit]),x+44,290,20,TEXT_COLORS.white);
    }
    v.button('',139,338,205,62,()=>this.begin()).setData('label','组合');
    this.buttonText('craft-chaos-confirm','组合',139,338,205,62);
  }

  private renderSocket(v:UiSurface):void {
    const {session,catalog}=this.crafting,bag=session.bag,assets=this.panels.assets,op=catalog.operations.socket;
    if(this.target&&!bag.entries.some(entry=>entry.id===this.target))this.target=undefined;
    const target=this.target?bag.get(this.target):undefined,item=target?bag.catalog.items[target.item]:undefined;
    const slot=v.button('',204,26,74,74,()=>{this.target=undefined;if(!this.updateWork())this.changed();},{image:assets['inventory-slot']}).setData('label','合成装备');
    if(item)v.image(item.icon,5,5,64,64,slot);
    this.drops.push({object:slot,craft:true});
    if(item&&target){
      this.addText('craft-socket-title',item.name,241,111,22,TEXT_COLORS.primary,.5,0,{width:410,align:'center',wrap:'word'});
      this.addText('craft-socket-stats',`等级 ${equipmentLevel(item,target)}　宝石孔 ${target.numbers?.sockets??0}`,241,140,18,TEXT_COLORS.primary,.5,0,
        {width:410,align:'center',wrap:'word'});
      const range=this.crafting.socketRange(target.id);
      if(range)this.addText('craft-socket-range',range.min===range.max?`可生成 ${range.max} 个宝石孔`:`可生成 ${range.min}~${range.max} 个宝石孔`,
        241,162,16,TEXT_COLORS.secondary,.5,0,{width:410,align:'center',wrap:'word'});
    }
    for(const [index,material] of op.materials.entries()){
      const x=152+index*104,available=bag.count(material.item),definition=bag.catalog.items[material.item];
      v.image(assets['inventory-slot'],x,184,74,74);v.image(definition.icon,x+5,189,64,64);
      this.addText(`craft-socket-material-${index}`,`${available}/${material.quantity}`,x+37,262,22,
        available<material.quantity?TEXT_COLORS.requirementUnmet:TEXT_COLORS.primary,.5,0);
    }
    const coins=splitMoney(op.cost);
    for(const [index,unit] of (['gold','silver','copper'] as const).entries()){
      const x=82+index*103;v.image(assets[`craft-money-${unit}`],x,290,44,40);
      this.addText(`craft-socket-money-${unit}`,String(coins[unit]),x+44,296,20,TEXT_COLORS.white);
    }
    v.button('',139,338,205,62,()=>this.begin()).setData('label','组合');
    this.buttonText('craft-socket-confirm','组合',139,338,205,62);
  }
  private renderBagCells(v:UiSurface,scroll:ScrollArea,startDrag:(pointer:UiPointer,entry:string,scroll:ScrollArea)=>void):void{
    const bag=this.crafting.session.bag,assets=this.panels.assets,layout=bagLayout(),cells=layout.grid;
    const view=inventoryView({all:bag.allCells,...bag.pouchCells},this.filter),clip={top:cells.y,bottom:cells.y+cells.height};
    const old=new Map<string,CraftingDrop>();
    for(const drop of this.drops)if(!drop.craft)old.set(drop.entry?`item:${drop.entry}`:`cell:${drop.view}:${drop.cell}`,drop);
    this.targetMarker?.destroy();this.targetMarker=undefined;this.bagButtons.clear();
    this.pageText=this.pageText.filter(spec=>!spec.key.startsWith('craft-bag-badge-')&&!spec.key.startsWith('craft-bag-enhancement-'));
    const next:CraftingDrop[]=[];
    for(let index=0;index<view.slotCount;index++){
      const cell=view.slots[index]!,x=index%4*cells.stride,y=Math.floor(index/4)*cells.stride;
      const key=cell.kind==='item'?`item:${cell.entry.id}`:`cell:${cell.view}:${cell.cell}`;
      let drop=old.get(key);old.delete(key);
      if(!drop){
        if(cell.kind==='cell')drop={object:v.image(assets['inventory-slot'],x,y,74,74,scroll.content)};
        else{
          const entry=cell.entry,definition=bag.catalog.items[entry.item];
          const button=v.button('',x,y,74,74,()=>this.select(entry.id),{image:assets['inventory-slot'],parent:scroll.content,guard:scroll.guard}).setData('label',definition.name);
          v.image(definition.icon,5,5,64,64,button);
          button.on('pointerdown',(pointer:UiPointer)=>startDrag(pointer,entry.id,scroll));drop={object:button,entry:entry.id};
        }
      }
      drop.object.setPosition(x,y);drop.view=cell.view;drop.cell=cell.cell;next.push(drop);
      if(cell.kind==='item'){
        const entry=cell.entry,definition=bag.catalog.items[entry.item];this.bagButtons.set(entry.id,drop.object);
        if(entry.id===this.target)this.targetMarker=v.image(assets['inventory-selected'],-5,-5,84,84,drop.object);
        if(definition.stackable)this.addText(`craft-bag-badge-${index}`,String(entry.quantity),cells.x+x+layout.badge.x,cells.y+y+layout.badge.y,20,layout.badge.color,1,0,{},{scroll:'craft-bag',clip});
        if(entry.enhancement)this.addText(`craft-bag-enhancement-${index}`,`+${entry.enhancement}`,cells.x+x+2,cells.y+y+2,17,GOLD,0,0,{},{scroll:'craft-bag',clip});
      }
    }
    for(const drop of old.values())drop.object.destroy();
    const craftDrops=this.drops.filter(drop=>drop.craft);this.drops.splice(0,this.drops.length,...craftDrops,...next);
    v.pruneDestroyed();scroll.setHeight(Math.ceil(view.slotCount/4)*cells.stride);
  }
  private renderBag(v:UiSurface,startDrag:(pointer:UiPointer,entry:string,scroll:ScrollArea)=>void):void {
    const {session}=this.crafting,assets=this.panels.assets;
    const layout=bagLayout(),cells=layout.grid,
      scroll=this.scrollAt('craft-bag',cells.x,cells.y,cells.width,cells.height);
    this.bagScroll=scroll;
    this.renderBagCells(v,scroll,startDrag);scroll.scrollTop=this.offset;
    scroll.onScroll=()=>{this.offset=scroll.scrollTop;this.text?.refresh();};
    const wallet=splitMoney(session.money);
    for(const [index,unit] of (['gold','silver','copper'] as const).entries()){
      const x=layout.money.x+index*layout.money.stride;
      v.image(assets[`craft-money-${unit}`],x,layout.money.y,44,40);
      this.addText(`craft-bag-money-${unit}`,String(wallet[unit]),x+44,layout.money.y+6,20,TEXT_COLORS.white);
    }
    INVENTORY_SIDE_FILTERS.forEach((filter,index)=>{
      const side=layout.sideButtons,y=side.y+side.offsets[index];
      if(filter===this.filter)this.bagHighlight=v.rect(side.x,y,side.width,side.height,0xe2c88d,.10);
      v.button('',side.x,y,side.width,side.height,()=>{
        if(this.filter===filter)return;this.filter=filter;this.offset=0;scroll.scrollTop=0;
        this.bagHighlight?.setPosition(side.x,y);this.renderBagCells(v,scroll,startDrag);
        if(this.text?.updatePage)this.text.updatePage();else this.changed();
      },{bare:true}).setData('label',INVENTORY_LABELS[filter]);
      this.addText(`craft-bag-filter-${filter}`,INVENTORY_LABELS[filter],side.x+side.width/2,y+side.height/2,19,undefined,.5,.5,
        {width:side.width-6,align:'center',wrap:'word'});
    });
  }
}
