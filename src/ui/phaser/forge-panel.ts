import { equipmentPower, type CharacterPanel, type CharacterStatsCatalog, type Modifier } from '../../domain/character-stats.ts';
import { equipmentLevel } from '../../domain/chaos-equipment.ts';
import type { EnhancementOdds } from '../../domain/enhancement.ts';
import { ItemApplicationError } from '../../domain/item-application.ts';
import type { Bag } from '../../domain/bag.ts';
import type { ItemDefinition, ItemInstance } from '../../domain/items.ts';
import type { MenuPanels } from '../../domain/menu-panels.ts';
import { bagLayout } from '../bag-layout.ts';
import { SLOT, SLOT_STRIDE } from '../item-layout.ts';
import { drawNativeMessage } from './native-message.ts';
import type { UiSurface, ScrollArea } from './widgets.ts';

export type ForgeTab='enchant'|'socket'|'purify';
type ResultTone='normal'|'success'|'failure';
type Confirmation={kind:'unsocket';index:number}|{kind:'swap';index:number;gem:string};

/**
 * 装备强化台：和合成台同级的菜单页。
 *
 * 左框是装备摘要和当前选中项的详情，右框复用背包的四列格子；所有结算都走 `Bag` 的
 * 领域方法。页面本身不铺黑色遮罩，确认框才借用 `modal` 画一条原版提示横带。
 */
export class ForgePanel {
  readonly bag:Bag;readonly panels:MenuPanels;readonly stats:CharacterStatsCatalog;readonly memberId:string;
  private readonly changed:()=>void;private readonly sound:()=>void;
  private readonly preview:(targetId:string,gemModifiers:Modifier[])=>CharacterPanel|undefined;
  targetId?:string;tab:ForgeTab='enchant';
  private selectedItem?:string;private socketIndex?:number;private replaceIndex?:number;
  private result?:string;private resultTone:ResultTone='normal';private offset=0;
  private confirmation?:Confirmation;private scroll?:ScrollArea;
  constructor(bag:Bag,panels:MenuPanels,stats:CharacterStatsCatalog,memberId:string,
    changed:()=>void,sound:()=>void,
    preview:(targetId:string,gemModifiers:Modifier[])=>CharacterPanel|undefined){
    this.bag=bag;this.panels=panels;this.stats=stats;this.memberId=memberId;
    this.changed=changed;this.sound=sound;this.preview=preview;
  }
  get modalOpen():boolean{return !!this.confirmation;}
  get confirming():boolean{return !!this.confirmation;}
  open(targetId:string,tab:ForgeTab='enchant'):void {
    this.targetId=targetId;this.tab=tab;
    this.selectedItem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;
    this.result=undefined;this.resultTone='normal';this.offset=0;this.confirmation=undefined;this.scroll=undefined;
  }
  captureScroll():void {this.offset=this.scroll?.scrollTop??this.offset;}
  cancelConfirmation():void {this.confirmation=undefined;this.changed();}
  render(v:UiSurface,modal:UiSurface,placeModal:(width:number,height:number)=>void):void {
    const assets=this.panels.assets;
    v.border(assets,10,0,462,431);v.border(assets,484,0,395,431);
    this.scroll=undefined;
    const target=this.targetId?this.bag.get(this.targetId):undefined,item=target?this.bag.catalog.items[target.item]:undefined;
    if(!target||!item?.equipment){
      v.text('装备已不存在，点右上角关闭返回背包。',30,160,420,24,'#e2cb9e');
      return;
    }
    this.validateState(target);
    this.renderNavigation(v);
    this.renderSummary(v,target,item);
    this.renderGrid(v,target);
    this.renderDetails(v,target,item);
    if(this.confirmation)this.renderConfirmation(modal,placeModal);
  }
  private renderNavigation(v:UiSurface):void {
    ([['enchant','强化'],['socket','镶嵌'],['purify','净化']] as const).forEach(([tab,label],index)=>{
      v.button(label,30+index*126,10,120,28,()=>this.setTab(tab),{selected:this.tab===tab,fontSize:16});
    });
  }
  private setTab(tab:ForgeTab):void {
    if(this.tab===tab)return;
    this.tab=tab;this.selectedItem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;
    this.offset=0;this.scroll=undefined;this.changed();
  }
  private validateState(target:ItemInstance):void {
    if(this.selectedItem&&!this.bag.get(this.selectedItem))this.selectedItem=undefined;
    const count=target.gems.length;
    if(this.socketIndex!==undefined&&(this.socketIndex<0||this.socketIndex>=count))this.socketIndex=undefined;
    if(this.replaceIndex!==undefined&&(this.replaceIndex<0||this.replaceIndex>=count))this.replaceIndex=undefined;
  }
  private renderSummary(v:UiSurface,target:ItemInstance,item:ItemDefinition):void {
    const numbers=this.stats.equipment[target.item];
    v.image(item.icon,30,52,56,56);
    v.text(`${item.name}${target.enhancement?` +${target.enhancement}`:''}`,94,54,350,22,'#e2cb9e');
    let y=88;
    const line=(text:string)=>{v.text(text,30,y,420,18,'#c8b78f');y+=20;};
    line(`等级 ${equipmentLevel(item,target)}`);
    line(`强化耐久度 ${target.numbers?.enhancementUses??0}`);
    line(`宝石孔 ${target.gems.length}/${target.numbers?.sockets??item.equipment!.socketCapacity}`);
    if(numbers){
      const power=equipmentPower(numbers,target);
      if(item.priceKind==='weapon')line(`物理攻击 ${power.attack}　魔法攻击 ${power.magicAttack}`);
      else if(item.priceKind==='armor')line(`防御力 ${power.defense}`);
    }
    line(`混沌属性 ${target.numbers?.chaos?(target.numbers.chaos.tier==='epic-chaos'?'深渊混沌':'混沌'):'无'}`);
  }
  private gridEntries():ItemInstance[] {
    const kind=this.tab==='enchant'?'enchant':this.tab==='socket'?'socket':'purify';
    return this.bag.entries.filter(entry=>this.bag.catalog.items[entry.item].use?.kind===kind);
  }
  private gridLabel(entry:ItemInstance):string {
    if(this.tab==='socket')return `宝石:${entry.id}`;
    return `${this.tab==='purify'?'净化石':'卷轴'}:${this.bag.catalog.items[entry.item].name}`;
  }
  private renderGrid(v:UiSurface,target:ItemInstance):void {
    const entries=this.gridEntries(),assets=this.panels.assets;
    if(!entries.length){
      const message=this.tab==='enchant'?'背包里没有强化卷轴。':this.tab==='socket'?'背包里没有宝石。':'背包里没有净化之宝石。';
      v.text(message,681,180,0,20,'#c8b78f').setOrigin(.5,0);return;
    }
    const layout=bagLayout(),grid=layout.grid,scroll=v.scroll(grid.x,grid.y,grid.width,grid.height);this.scroll=scroll;
    entries.forEach((entry,index)=>{
      const definition=this.bag.catalog.items[entry.item];
      const x=index%4*SLOT_STRIDE,y=Math.floor(index/4)*SLOT_STRIDE;
      const problem=this.tab==='enchant'?this.problemText(entry,target):undefined;
      const broken=this.tab==='socket'&&!entry.numbers?.modifiers?.length;
      const chaos=this.tab==='enchant'&&!!definition.use?.requiresEnhanced&&(target.numbers?.enhancementUses??0)===0&&!problem;
      const selected=this.selectedItem===entry.id;
      const button=v.button('',x,y,SLOT.size,SLOT.size,()=>this.selectGridEntry(entry),{image:assets['inventory-slot'],parent:scroll.content,guard:scroll.guard})
        .setData('label',this.gridLabel(entry));
      v.image(definition.icon,SLOT.icon.x,SLOT.icon.y,SLOT.icon.size,SLOT.icon.size,button);
      if(definition.stackable)v.text(String(entry.quantity),layout.badge.x,layout.badge.y,0,20,layout.badge.color,button).setOrigin(1,0);
      if(selected||chaos)v.image(assets['inventory-selected'],SLOT.selection.x,SLOT.selection.y,SLOT.selection.size,SLOT.selection.size,button)
        .setData('forge-highlight',chaos?'chaos':'selected');
      if(problem||broken)button.setAlpha(.45);
    });
    scroll.setHeight(Math.ceil(entries.length/4)*SLOT_STRIDE);scroll.scrollTop=this.offset;scroll.onScroll=()=>{this.offset=scroll.scrollTop;};
  }
  private selectGridEntry(entry:ItemInstance):void {
    this.selectedItem=entry.id;this.socketIndex=undefined;this.changed();
  }
  private problemText(source:ItemInstance,target:ItemInstance):string|undefined {
    if(!this.bag.canApply(source.id,target.id))return this.panels.itemMessages['socket-incompatible']??'该道具不适合。';
    const notice=this.bag.applicationProblem(source.id,target.id);
    return notice?this.panels.itemMessages[notice]??notice:undefined;
  }
  private oddsText(odds:EnhancementOdds|undefined):string {
    if(!odds)return '';
    const percent=(value:number)=>{const p=value*100;return `${p>=10?Math.round(p):Math.round(p*10)/10}%`;};
    return odds.losesLevel
      ?`不降级 ${percent(odds.success)}，降 1 级 ${percent(odds.failure)}；+2 ${percent(odds.double)}`
      :`+1 确定，+2 ${percent(odds.double)}`;
  }
  private renderDetails(v:UiSurface,target:ItemInstance,item:ItemDefinition):void {
    if(this.tab==='enchant')this.renderEnchantDetails(v,target,item);
    else if(this.tab==='socket')this.renderSocketDetails(v,target,item);
    else this.renderPurifyDetails(v,target);
    this.renderResult(v);
  }
  private renderEnchantDetails(v:UiSurface,target:ItemInstance,item:ItemDefinition):void {
    if(!item.equipment?.enchantable){v.text('这件装备不能强化。',30,210,420,18,'#ff6b6b');return;}
    const selected=this.selectedItem?this.bag.get(this.selectedItem):undefined;
    if(!selected){v.text('选择一张强化卷轴。',30,210,420,18,'#c8b78f');v.button('确定强化',139,342,205,55,()=>{}, {fontSize:20,disabled:true});return;}
    const definition=this.bag.catalog.items[selected.item],problem=this.problemText(selected,target),odds=problem?undefined:this.bag.applicationOdds(selected.id,target.id);
    v.text(definition.name,30,210,420,18,'#e2cb9e');
    v.text(problem??this.oddsText(odds),30,234,420,18,problem?'#ff6b6b':'#c8b78f');
    v.text(definition.use?.requiresEnhanced?'不消耗耐久':'消耗 1 点耐久',30,258,420,18,'#c8b78f');
    v.button('确定强化',139,342,205,55,()=>this.useScroll(selected.id),{fontSize:20,disabled:!!problem});
  }
  private renderSocketDetails(v:UiSurface,target:ItemInstance,item:ItemDefinition):void {
    const equipment=item.equipment;
    if(!equipment)return;
    if(equipment.locked){v.text('这件装备已锁定，不能镶嵌。',30,210,420,18,'#ff6b6b');return;}
    const sockets=target.numbers?.sockets??equipment.socketCapacity;
    if(sockets<=0){v.text('这件装备没有宝石孔。',30,210,420,18,'#ff6b6b');return;}
    const modifiers=target.numbers?.gemModifiers;
    const valid=!!target.numbers&&!!modifiers&&modifiers.length===target.gems.length;
    for(let index=0;index<sockets;index++){
      const x=30+index*60,y=200,filled=index<target.gems.length;
      const button=v.button('',x,y,54,54,()=>{if(!filled)return;this.socketIndex=index;this.replaceIndex=undefined;this.selectedItem=undefined;this.changed();},
        {image:this.panels.assets['inventory-slot'],disabled:!filled}).setData('label',`孔位${index+1}`);
      if(filled){const gemItem=this.bag.catalog.items[target.gems[index]!];if(gemItem)v.image(gemItem.icon,5,5,44,44,button);}
      if(this.socketIndex===index)v.image(this.panels.assets['inventory-selected'],-5,-5,64,64,button).setData('forge-highlight','socket');
    }
    if(!valid){v.text('宝石数据不完整，无法修改宝石。',30,278,420,18,'#ff6b6b');return;}
    if(this.socketIndex!==undefined){
      const index=this.socketIndex,gemItem=this.bag.catalog.items[target.gems[index]!],modifier=modifiers[index];
      if(!gemItem||!modifier){v.text('宝石数据不完整，无法修改宝石。',30,278,420,18,'#ff6b6b');return;}
      v.text(`${gemItem.name}：${this.modifierText(modifier)}`,30,278,430,18,'#bf0000');
      v.button('取出',30,304,90,32,()=>{this.confirmation={kind:'unsocket',index};this.changed();},{fontSize:16});
      v.button('替换',130,304,90,32,()=>{this.replaceIndex=index;this.socketIndex=undefined;this.selectedItem=undefined;this.changed();},{fontSize:16});
      return;
    }
    const canAdd=target.gems.length<sockets;
    if(this.replaceIndex!==undefined)v.text(`替换第 ${this.replaceIndex+1} 孔`,30,258,420,18,'#e2cb9e');
    else if(!canAdd)v.text('宝石孔已满。点已镶孔可以取出或替换。',30,258,420,18,'#ff6b6b');
    else if(!this.selectedItem)v.text('点已镶孔可以取出或替换；点下方宝石可以镶嵌。',30,258,430,18,'#c8b78f');
    if(this.selectedItem)this.renderGemPreview(v,target,modifiers);
    else if(this.replaceIndex!==undefined)v.text('选择一颗宝石。',30,278,420,18,'#c8b78f');
    v.button(this.replaceIndex===undefined?'确认镶嵌':'确认替换',139,342,205,55,()=>this.confirmSocket(),{fontSize:20,
      disabled:!this.selectedItem||!this.bag.get(this.selectedItem)?.numbers?.modifiers?.length||(!canAdd&&this.replaceIndex===undefined)});
  }
  private renderGemPreview(v:UiSurface,target:ItemInstance,modifiers:Modifier[]):void {
    const gemId=this.selectedItem;if(!gemId)return;
    const gem=this.bag.get(gemId),definition=gem?this.bag.catalog.items[gem.item]:undefined,modifier=gem?.numbers?.modifiers?.[0];
    if(!gem||!definition||!modifier){v.text('宝石数据不完整。',30,278,430,18,'#ff6b6b');return;}
    const current=modifiers.map(value=>({...value}));
    const next=this.replaceIndex===undefined?[...current,{...modifier}]:current.map((value,index)=>index===this.replaceIndex?{...modifier}:value);
    const after=this.preview(target.id,next);
    v.text(`${definition.name}：${this.modifierText(modifier)}`,30,278,430,18,'#bf0000');
    if(!after){v.text('替换装备后生效。',30,300,430,18,'#c8b78f');return;}
    const before=this.preview(target.id,current),diff=before?this.panelDiff(before,after):[];
    const worn=Object.values(this.bag.equipmentFor(this.memberId)).includes(target.id);
    v.text(`${worn?'镶嵌后':'装备后'}：${diff.length?diff.join('　'):'角色面板无变化'}`,30,300,430,18,'#e2cb9e');
  }
  private panelDiff(before:CharacterPanel,after:CharacterPanel):string[] {
    const lines:string[]=[];
    const add=(label:string,left:number,right:number)=>{if(left!==right)lines.push(`${label} ${right>left?'+':''}${right-left}`);};
    add('物理攻击',before.physicalAttack,after.physicalAttack);
    add('魔法攻击',before.magicAttack,after.magicAttack);
    add('防御',before.defense,after.defense);
    add('最大HP',before.maxHealth,after.maxHealth);
    add('最大MP',before.maxMana,after.maxMana);
    for(const stat of ['strength','dexterity','vitality','intelligence','mentality'] as const)
      add(this.stats.modifiers[stat]?.label??stat,before.attributes[stat],after.attributes[stat]);
    add('暴击率',before.criticalRate,after.criticalRate);
    add('命中率',before.hitRate,after.hitRate);
    add('魔法抵抗',before.magicResistance,after.magicResistance);
    add('回避率',before.evasionRate,after.evasionRate);
    add('盾牌格挡',before.shieldBlock,after.shieldBlock);
    return lines.slice(0,5);
  }
  private modifierText(modifier:Modifier):string {
    const descriptor=this.stats.modifiers[modifier.stat];
    const value=descriptor?.percent?`${(modifier.value/10).toFixed(1)}%`:String(modifier.value);
    return `${descriptor?.label??modifier.stat}: ${value}`;
  }
  private renderPurifyDetails(v:UiSurface,target:ItemInstance):void {
    if(!target.numbers?.chaos){v.text('这件装备没有混沌属性。',30,210,420,18,'#ff6b6b');return;}
    const selected=this.selectedItem?this.bag.get(this.selectedItem):undefined;
    if(!selected){v.text('选择净化之宝石。',30,210,420,18,'#c8b78f');v.button('确定净化',139,342,205,55,()=>{}, {fontSize:20,disabled:true});return;}
    const definition=this.bag.catalog.items[selected.item];
    v.text(definition.name,30,210,420,18,'#e2cb9e');
    v.text('净化后清除混沌属性，保留强化、耐久和宝石。',30,234,420,18,'#c8b78f');
    v.button('确定净化',139,342,205,55,()=>this.usePurify(selected.id),{fontSize:20});
  }
  private renderResult(v:UiSurface):void {
    if(!this.result)return;
    const color=this.resultTone==='success'?'#ffd75e':this.resultTone==='failure'?'#ff6b6b':'#e2cb9e';
    v.text(this.result,494,360,375,20,color);
  }
  private useScroll(sourceId:string):void {
    const targetId=this.targetId;if(!targetId)return;
    const before=this.bag.get(targetId)?.enhancement??0;
    try {
      const result=this.bag.use(sourceId,targetId),after=this.bag.get(targetId)?.enhancement??before;
      this.result=result.message;
      this.resultTone=after<before?'failure':result.notice==='enchant-double'?'success':'normal';
      this.sound();
    } catch(error) {
      this.result=this.errorText(error);this.resultTone='failure';
    }
    this.changed();
  }
  private confirmSocket():void {
    const targetId=this.targetId,gemId=this.selectedItem;if(!targetId||!gemId)return;
    if(!this.bag.get(gemId)?.numbers?.modifiers?.length)return;
    const replacing=this.replaceIndex,target=this.bag.get(targetId),definition=target?this.bag.catalog.items[target.item]:undefined;
    if(replacing===undefined&&target&&definition?.equipment&&target.gems.length>=(target.numbers?.sockets??definition.equipment.socketCapacity))return;
    if(replacing!==undefined){this.confirmation={kind:'swap',index:replacing,gem:gemId};this.changed();return;}
    try {const result=this.bag.use(gemId,targetId);this.result=result.message;this.resultTone='normal';this.sound();}
    catch(error) {this.result=this.errorText(error);this.resultTone='failure';}
    this.selectedItem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;
    this.changed();
  }
  private usePurify(sourceId:string):void {
    const targetId=this.targetId;if(!targetId)return;
    try {const result=this.bag.use(sourceId,targetId);this.result=result.message;this.resultTone='normal';this.sound();}
    catch(error){this.result=this.errorText(error);this.resultTone='failure';}
    this.changed();
  }
  private renderConfirmation(modal:UiSurface,placeModal:(width:number,height:number)=>void):void {
    const confirmation=this.confirmation;if(!confirmation)return;
    const message=confirmation.kind==='unsocket'
      ?'取出后这颗宝石会回到背包，装备上的这条属性会消失。确定取出？'
      :'替换后旧宝石会回到背包，装备上的属性会改为新宝石。确定替换？';
    placeModal(1024,640);
    drawNativeMessage(modal,this.panels.assets,message,()=>this.confirm(),()=>this.cancelConfirmation());
  }
  private confirm():void {
    const confirmation=this.confirmation,targetId=this.targetId;
    if(!confirmation||!targetId)return;
    this.confirmation=undefined;
    try {
      if(confirmation.kind==='unsocket'){const result=this.bag.unsocket(targetId,confirmation.index);this.result=`已取出${result.name}`;}
      else {const result=this.bag.swapGem(targetId,confirmation.index,confirmation.gem);this.result=`已替换宝石，${result.name}已回到背包`;}
      this.resultTone='normal';this.selectedItem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;this.sound();
    } catch(error) {
      this.result=this.errorText(error);this.resultTone='failure';
    }
    this.changed();
  }
  private errorText(error:unknown):string {
    if(error instanceof ItemApplicationError)return this.panels.itemMessages[error.notice]??error.message;
    return error instanceof Error?error.message:String(error);
  }
}
