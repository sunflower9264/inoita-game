import {equipmentPower} from '../../domain/character-stats.ts';
import {equipmentLevel} from '../../domain/chaos-equipment.ts';
import {itemDescriptionBody} from '../item-detail-lines.ts';
import type {ShopCatalog} from '../../domain/shop.ts';
import type Phaser from 'phaser';
import {EquipmentCrafting,CraftingError,type CraftingQuote} from '../../domain/crafting.ts';
import type {ChaosTier} from '../../domain/chaos-equipment.ts';
import type {MenuPanels} from '../../domain/menu-panels.ts';
import {inventoryView,INVENTORY_SIDE_FILTERS,INVENTORY_LABELS,type InventoryView} from '../../domain/inventory.ts';
import {bagLayout} from '../bag-layout.ts';
import {splitMoney} from '../money-display.ts';
import {drawNativeMessage} from './native-message.ts';
import type {UiSurface,ScrollArea} from './widgets.ts';

interface CraftingDrop {object:Phaser.GameObjects.Container|Phaser.GameObjects.Image;entry?:string;view?:InventoryView;cell?:number;craft?:boolean}

/** 原版融合器的装备合成两栏：左侧加工，右侧背包，消息沿用 UIPopupMsg。 */
export class CraftingPanel {
  readonly crafting:EquipmentCrafting;readonly panels:MenuPanels;private readonly grades:ShopCatalog['grades'];
  tier:ChaosTier='chaos';target?:string;
  filter:InventoryView='all';private offset=0;
  bagScroll?:ScrollArea;drops:CraftingDrop[]=[];
  private message?:string;private confirmation?:CraftingQuote;private committing=false;
  private readonly changed:()=>void;private readonly sound:()=>void;
  constructor(crafting:EquipmentCrafting,panels:MenuPanels,changed:()=>void,sound:()=>void,grades:ShopCatalog['grades']=[]){this.grades=grades;this.crafting=crafting;this.panels=panels;this.changed=changed;this.sound=sound;}
  get modalOpen():boolean{return !!this.message||!!this.confirmation;}
  captureScroll():void {this.offset=this.bagScroll?.scrollTop??this.offset;}
  close():void {this.message=undefined;this.confirmation=undefined;}
  cancel():void {this.message=undefined;this.confirmation=undefined;this.changed();}
  choose(tier:ChaosTier):void {this.tier=tier;this.target=undefined;this.cancel();}
  select(target:string):void {
    if(this.modalOpen||this.committing)return;
    const problem=this.crafting.targetProblem(this.tier,target);
    if(problem)this.message=this.panels.itemMessages[problem];else this.target=target;
    this.changed();
  }
  private begin():void {
    if(this.modalOpen||this.committing)return;
    try {this.confirmation=this.crafting.quote(this.tier,this.target);}
    catch(error){if(error instanceof CraftingError)this.message=this.panels.itemMessages[error.notice];else throw error;}
    this.changed();
  }
  private confirm():void {
    const quote=this.confirmation;if(!quote||this.committing)return;
    this.committing=true;this.confirmation=undefined;
    const target=this.target;this.target=undefined;
    let committed=false;
    try {this.crafting.commit(quote);this.sound();committed=true;}
    catch(error){this.target=target;if(error instanceof CraftingError)this.message=this.panels.itemMessages[error.notice];else throw error;}
    finally {this.committing=false;}
    // 成功时 session 通知已经用“目标已清空”的状态重画过；失败才本地重画显示错误。
    if(!committed)this.changed();
  }
  render(v:UiSurface,modal:UiSurface,placeModal:(width:number,height:number)=>void,startDrag:(pointer:Phaser.Input.Pointer,entry:string,scroll:ScrollArea)=>void):void {
    const {session,catalog}=this.crafting,bag=session.bag,assets=this.panels.assets,op=catalog.operations[this.tier];
    this.drops=[];
    if(this.target&&!bag.entries.some(entry=>entry.id===this.target))this.target=undefined;
    v.border(assets,10,0,462,431);v.border(assets,484,0,395,431);
    v.text(op.name,241,13,410,24,'#e2cb9e').setOrigin(.5,0);
    const target=this.target?bag.get(this.target):undefined,item=target?bag.catalog.items[target.item]:undefined;
    const slot=v.button('',204,48,74,74,()=>{this.target=undefined;this.changed();},{image:assets['inventory-slot']}).setData('label','合成装备');
    if(item)v.image(item.icon,5,5,64,64,slot);
    this.drops.push({object:slot,craft:true});
    if(item&&target){
      const numbers=session.hero?.catalog.equipment[target.item],body=session.hero?itemDescriptionBody({item,entry:target,numbers,catalog:session.hero.catalog,grades:this.grades}):undefined;
      v.text(body?.title??item.name,241,133,410,22,body?.color??'#e2cb9e').setOrigin(.5,0);
      if(numbers){const power=equipmentPower(numbers,target);v.text(`等级 ${equipmentLevel(item,target)}　${item.priceKind==='weapon'?`物理攻击 ${power.attack}　魔法攻击 ${power.magicAttack}`:`防御力 ${power.defense}`}`,241,162,410,18,'#e2cb9e').setOrigin(.5,0);}
    }
    for(const [index,material] of op.materials.entries()){
      const x=49+index*104,available=bag.count(material.item),definition=bag.catalog.items[material.item];
      v.image(assets['inventory-slot'],x,187,74,74);v.image(definition.icon,x+5,192,64,64);
      v.text(`${available}/${material.quantity}`,x+37,270,0,22,available<material.quantity?'#ff0000':'#e2cb9e').setOrigin(.5,0);
    }
    const coins=splitMoney(item?item.level*op.costPerLevel:0);
    for(const [index,unit] of (['gold','silver','copper'] as const).entries()){
      const x=82+index*103;v.image(assets[`craft-money-${unit}`],x,306,44,40);
      v.text(String(coins[unit]),x+44,312,0,20,'#ffffff');
    }
    v.button('',139,360,205,62,()=>this.begin(),{image:assets['craft-button'],pressed:assets['craft-button-pressed'],native:true,pressedAdd:true}).setData('label','组合');
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
    if(this.modalOpen){
      placeModal(1024,640);
      drawNativeMessage(modal,assets,this.message??this.panels.itemMessages['craft-confirm'],()=>this.message?this.cancel():this.confirm(),this.confirmation?()=>this.cancel():undefined);
    }
  }
}
