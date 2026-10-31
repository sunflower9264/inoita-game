import {equipmentPower} from '../../domain/character-stats.ts';
import {equipmentLevel} from '../../domain/chaos-equipment.ts';
import {itemDescriptionBody} from '../item-detail-lines.ts';
import type {ShopCatalog} from '../../domain/shop.ts';
import type Phaser from 'phaser';
import {EquipmentCrafting,CraftingError,type CraftingQuote,type RecipeQuote,type SocketQuote} from '../../domain/crafting.ts';
import type {ChaosTier} from '../../domain/chaos-equipment.ts';
import type {MenuPanels} from '../../domain/menu-panels.ts';
import {inventoryView,INVENTORY_SIDE_FILTERS,INVENTORY_LABELS,type InventoryView} from '../../domain/inventory.ts';
import {bagLayout} from '../bag-layout.ts';
import {moneyText,splitMoney} from '../../domain/money.ts';
import {drawNativeMessage} from './native-message.ts';
import type {UiSurface,ScrollArea} from './widgets.ts';

interface CraftingDrop {object:Phaser.GameObjects.Container|Phaser.GameObjects.Image;entry?:string;view?:InventoryView;cell?:number;craft?:boolean}
type Confirmation={kind:'chaos';quote:CraftingQuote}|{kind:'recipe';quote:RecipeQuote}|{kind:'socket';quote:SocketQuote};

/** 原版融合器：配方列表和装备混沌合成共用左侧加工区，右侧背包，消息沿用 UIPopupMsg。 */
export class CraftingPanel {
  readonly crafting:EquipmentCrafting;readonly panels:MenuPanels;private readonly grades:ShopCatalog['grades'];
  mode:'recipes'|'chaos'|'socket'='recipes';tier:ChaosTier='chaos';target?:string;recipe?:string;
  filter:InventoryView='all';private offset=0;private recipeOffset=0;
  bagScroll?:ScrollArea;private recipeScroll?:ScrollArea;drops:CraftingDrop[]=[];
  private message?:string;private confirmation?:Confirmation;private committing=false;
  private readonly changed:()=>void;private readonly sound:()=>void;
  constructor(crafting:EquipmentCrafting,panels:MenuPanels,changed:()=>void,sound:()=>void,grades:ShopCatalog['grades']=[]){this.grades=grades;this.crafting=crafting;this.panels=panels;this.changed=changed;this.sound=sound;}
  get modalOpen():boolean{return !!this.message||!!this.confirmation;}
  captureScroll():void {this.offset=this.bagScroll?.scrollTop??this.offset;this.recipeOffset=this.recipeScroll?.scrollTop??this.recipeOffset;}
  close():void {this.message=undefined;this.confirmation=undefined;}
  cancel():void {this.message=undefined;this.confirmation=undefined;this.changed();}
  chooseMode(mode:'recipes'|ChaosTier|'socket'):void {
    if(mode==='recipes'||mode==='socket'){this.mode=mode;this.recipe=undefined;this.target=undefined;}
    else {this.mode='chaos';this.tier=mode;this.target=undefined;}
    this.cancel();
  }
  select(target:string):void {
    if(this.mode==='recipes'||this.modalOpen||this.committing)return;
    const problem=this.mode==='socket'?this.crafting.targetSocketProblem(target):this.crafting.targetProblem(this.tier,target);
    if(problem)this.message=this.panels.itemMessages[problem];else this.target=target;
    this.changed();
  }
  private selectRecipe(recipe:string):void {
    if(this.modalOpen||this.committing)return;
    this.recipe=recipe;this.changed();
  }
  private backToRecipes():void {this.recipe=undefined;this.changed();}
  private begin():void {
    if(this.modalOpen||this.committing)return;
    try {
      if(this.mode==='socket')this.confirmation={kind:'socket',quote:this.crafting.socketQuote(this.target)};
      else if(this.mode==='chaos')this.confirmation={kind:'chaos',quote:this.crafting.quote(this.tier,this.target)};
      else return;
    }
    catch(error){if(error instanceof CraftingError)this.message=this.panels.itemMessages[error.notice];else throw error;}
    this.changed();
  }
  private beginRecipe():void {
    if(this.modalOpen||this.committing||!this.recipe)return;
    try {this.confirmation={kind:'recipe',quote:this.crafting.recipeQuote(this.recipe)};}
    catch(error){if(error instanceof CraftingError)this.message=this.panels.itemMessages[error.notice];else throw error;}
    this.changed();
  }
  private confirm():void {
    const confirmation=this.confirmation;if(!confirmation||this.committing)return;
    this.committing=true;this.confirmation=undefined;
    const target=this.target;this.target=undefined;
    let committed=false;
    try {
      if(confirmation.kind==='chaos')this.crafting.commit(confirmation.quote);
      else if(confirmation.kind==='socket')this.crafting.socketCommit(confirmation.quote);
      else {this.crafting.recipeCommit(confirmation.quote);this.recipe=undefined;}
      this.sound();committed=true;
    }
    catch(error){if(confirmation.kind!=='recipe')this.target=target;if(error instanceof CraftingError)this.message=this.panels.itemMessages[error.notice];else throw error;}
    finally {this.committing=false;}
    // 成功时 session 通知已经用“目标已清空”的状态重画过；失败才本地重画显示错误。
    if(!committed)this.changed();
  }
  render(v:UiSurface,modal:UiSurface,placeModal:(width:number,height:number)=>void,startDrag:(pointer:Phaser.Input.Pointer,entry:string,scroll:ScrollArea)=>void):void {
    const assets=this.panels.assets;
    this.drops=[];
    v.border(assets,10,0,462,431);v.border(assets,496,0,395,431);
    this.renderModeStrip(v);
    if(this.mode==='recipes')this.renderRecipes(v);
    else if(this.mode==='socket')this.renderSocket(v);
    else this.renderChaos(v);
    this.renderBag(v,startDrag);
    if(this.modalOpen){
      placeModal(1024,640);
      drawNativeMessage(modal,assets,this.message??this.panels.itemMessages['craft-confirm'],()=>this.message?this.cancel():this.confirm(),this.confirmation?()=>this.cancel():undefined);
    }
  }
  private renderModeStrip(v:UiSurface):void {
    // 模式切换放在左侧框上方，不再占用框内第一行；按钮同步放大，手机上也更好点。
    const tab=(label:string,data:string,x:number,width:number,selected:boolean,mode:'recipes'|ChaosTier|'socket')=>
      v.button(label,x,-46,width,42,()=>this.chooseMode(mode),{selected,fontSize:18}).setData('label',data);
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
        v.text('还没有学会任何装备配方。\n使用合成套装或在任务中获得配方。',241,58,380,20,'#e2cb9e').setOrigin(.5,0);
        return;
      }
      const scroll=v.scroll(34,26,412,347);this.recipeScroll=scroll;
      for(const [index,entry] of recipes.entries()){
        const y=index*44,definition=bag.catalog.items[entry.recipe.result];
        const button=v.button('',0,y,390,40,()=>this.selectRecipe(entry.id),{bare:true,parent:scroll.content,guard:scroll.guard}).setData('label',entry.recipe.name);
        v.image(definition.icon,4,4,32,32,button);
        v.text(entry.recipe.name,44,9,300,18,undefined,button);
        v.text(String(entry.recipe.cost),380,9,52,16,'#ffffff',button).setOrigin(1,0);
      }
      scroll.setHeight(recipes.length*44);scroll.scrollTop=this.recipeOffset;scroll.onScroll=()=>{this.recipeOffset=scroll.scrollTop;};
      return;
    }
    v.button('返回',34,26,94,34,()=>this.backToRecipes(),{fontSize:18}).setData('label','返回配方');
    v.text(recipe.name,136,28,312,24,'#e2cb9e').setOrigin(0,0);
    const result=bag.catalog.items[recipe.result];
    const slot=v.button('',204,58,74,74,()=>{}, {image:assets['inventory-slot']}).setData('label',result.name);
    v.image(result.icon,5,5,64,64,slot);
    v.text(result.name,241,142,410,22,'#e2cb9e').setOrigin(.5,0);
    for(const [index,material] of recipe.materials.entries()){
      const x=49+index*104,available=bag.count(material.item),definition=bag.catalog.items[material.item];
      v.image(assets['inventory-slot'],x,181,74,74);v.image(definition.icon,x+5,186,64,64);
      v.text(`${available}/${material.quantity}`,x+37,264,0,22,available<material.quantity?'#ff0000':'#e2cb9e').setOrigin(.5,0);
      v.text(definition.name,x+37,286,96,13,'#c8b78f').setOrigin(.5,0);
    }
    v.text(`合成费 ${moneyText(recipe.cost)}`,241,310,300,18,'#ffffff').setOrigin(.5,0);
    v.button('组合',139,336,205,62,()=>this.beginRecipe()).setData('label','组合');
  }
  private renderChaos(v:UiSurface):void {
    const {session,catalog}=this.crafting,bag=session.bag,assets=this.panels.assets,op=catalog.operations[this.tier];
    if(this.target&&!bag.entries.some(entry=>entry.id===this.target))this.target=undefined;
    const target=this.target?bag.get(this.target):undefined,item=target?bag.catalog.items[target.item]:undefined;
    const slot=v.button('',204,26,74,74,()=>{this.target=undefined;this.changed();},{image:assets['inventory-slot']}).setData('label','合成装备');
    if(item)v.image(item.icon,5,5,64,64,slot);
    this.drops.push({object:slot,craft:true});
    if(item&&target){
      const numbers=session.hero?.catalog.equipment[target.item],body=session.hero?itemDescriptionBody({item,entry:target,numbers,catalog:session.hero.catalog,grades:this.grades,gemNames:target.gems.map(id=>bag.catalog.items[id]?.name)}):undefined;
      v.text(body?.title??item.name,241,111,410,22,body?.color??'#e2cb9e').setOrigin(.5,0);
      if(numbers){const power=equipmentPower(numbers,target);v.text(`等级 ${equipmentLevel(item,target)}　${item.priceKind==='weapon'?`物理攻击 ${power.attack}　魔法攻击 ${power.magicAttack}`:`防御力 ${power.defense}`}`,241,140,410,18,'#e2cb9e').setOrigin(.5,0);}
    }
    for(const [index,material] of op.materials.entries()){
      const x=49+index*104,available=bag.count(material.item),definition=bag.catalog.items[material.item];
      v.image(assets['inventory-slot'],x,165,74,74);v.image(definition.icon,x+5,170,64,64);
      v.text(`${available}/${material.quantity}`,x+37,248,0,22,available<material.quantity?'#ff0000':'#e2cb9e').setOrigin(.5,0);
    }
    const coins=splitMoney(item?item.level*op.costPerLevel:0);
    for(const [index,unit] of (['gold','silver','copper'] as const).entries()){
      const x=82+index*103;v.image(assets[`craft-money-${unit}`],x,284,44,40);
      v.text(String(coins[unit]),x+44,290,0,20,'#ffffff');
    }
    v.button('组合',139,338,205,62,()=>this.begin()).setData('label','组合');
  }

  private renderSocket(v:UiSurface):void {
    const {session,catalog}=this.crafting,bag=session.bag,assets=this.panels.assets,op=catalog.operations.socket;
    if(this.target&&!bag.entries.some(entry=>entry.id===this.target))this.target=undefined;
    const target=this.target?bag.get(this.target):undefined,item=target?bag.catalog.items[target.item]:undefined;
    const slot=v.button('',204,26,74,74,()=>{this.target=undefined;this.changed();},{image:assets['inventory-slot']}).setData('label','合成装备');
    if(item)v.image(item.icon,5,5,64,64,slot);
    this.drops.push({object:slot,craft:true});
    if(item&&target){
      v.text(item.name,241,111,410,22,'#e2cb9e').setOrigin(.5,0);
      v.text(`等级 ${equipmentLevel(item,target)}　宝石孔 ${target.numbers?.sockets??0}`,241,140,410,18,'#e2cb9e').setOrigin(.5,0);
      const range=this.crafting.socketRange(target.id);
      if(range)v.text(range.min===range.max?`可生成 ${range.max} 个宝石孔`:`可生成 ${range.min}~${range.max} 个宝石孔`,241,162,410,16,'#c8b78f').setOrigin(.5,0);
    }
    for(const [index,material] of op.materials.entries()){
      const x=152+index*104,available=bag.count(material.item),definition=bag.catalog.items[material.item];
      v.image(assets['inventory-slot'],x,184,74,74);v.image(definition.icon,x+5,189,64,64);
      v.text(`${available}/${material.quantity}`,x+37,262,0,22,available<material.quantity?'#ff0000':'#e2cb9e').setOrigin(.5,0);
    }
    const coins=splitMoney(op.cost);
    for(const [index,unit] of (['gold','silver','copper'] as const).entries()){
      const x=82+index*103;v.image(assets[`craft-money-${unit}`],x,290,44,40);
      v.text(String(coins[unit]),x+44,296,0,20,'#ffffff');
    }
    v.button('组合',139,338,205,62,()=>this.begin()).setData('label','组合');
  }
  private renderBag(v:UiSurface,startDrag:(pointer:Phaser.Input.Pointer,entry:string,scroll:ScrollArea)=>void):void {
    const {session}=this.crafting,bag=session.bag,assets=this.panels.assets;
    const layout=bagLayout(),cells=layout.grid,view=inventoryView({all:bag.allCells,...bag.pouchCells},this.filter),scroll=v.scroll(cells.x,cells.y,cells.width,cells.height);
    this.bagScroll=scroll;
    for(let index=0;index<view.slotCount;index++){
      const cell=view.slots[index]!,x=index%4*cells.stride,y=Math.floor(index/4)*cells.stride;
      if(cell.kind==='cell'){this.drops.push({object:v.image(assets['inventory-slot'],x,y,74,74,scroll.content),view:cell.view,cell:cell.cell});continue;}
      const entry=cell.entry,definition=bag.catalog.items[entry.item];
      const button=v.button('',x,y,74,74,()=>this.select(entry.id),{image:assets['inventory-slot'],parent:scroll.content,guard:scroll.guard}).setData('label',definition.name);
      v.image(definition.icon,5,5,64,64,button);
      if(entry.id===this.target)v.image(assets['inventory-selected'],-5,-5,84,84,button);
      if(definition.stackable)v.text(String(entry.quantity),layout.badge.x,layout.badge.y,0,20,layout.badge.color,button).setOrigin(1,0);
      if(entry.enhancement)v.text(`+${entry.enhancement}`,2,2,0,17,undefined,button);
      this.drops.push({object:button,entry:entry.id,view:cell.view,cell:cell.cell});
      button.on('pointerdown',(pointer:Phaser.Input.Pointer)=>startDrag(pointer,entry.id,scroll));
    }
    scroll.setHeight(Math.ceil(view.slotCount/4)*cells.stride);scroll.scrollTop=this.offset;scroll.onScroll=()=>{this.offset=scroll.scrollTop;};
    const wallet=splitMoney(session.money);
    for(const [index,unit] of (['gold','silver','copper'] as const).entries()){
      const x=layout.money.x+index*layout.money.stride;
      v.image(assets[`craft-money-${unit}`],x,layout.money.y,44,40);
      v.text(String(wallet[unit]),x+44,layout.money.y+6,0,20,'#ffffff');
    }
    INVENTORY_SIDE_FILTERS.forEach((filter,index)=>{
      const side=layout.sideButtons,y=side.y+side.offsets[index];
      const button=v.button('',side.x,y,side.width,side.height,()=>{this.filter=filter;this.offset=0;this.changed();},{bare:true}).setData('label',INVENTORY_LABELS[filter]);
      v.image(assets['page-button-frame'],-5,-12,undefined,undefined,button);
      if(filter===this.filter)v.image(assets['page-button-selected'],-5,-12,undefined,undefined,button);
      v.text(INVENTORY_LABELS[filter],side.width/2,side.height/2,0,19,undefined,button).setOrigin(.5);
    });
  }
}
