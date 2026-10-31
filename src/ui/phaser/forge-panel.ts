import { equipmentPower, type CharacterPanel, type CharacterStatsCatalog, type Modifier } from '../../domain/character-stats.ts';
import { equipmentLevel } from '../../domain/chaos-equipment.ts';
import { ItemApplicationError } from '../../domain/item-application.ts';
import type { Bag } from '../../domain/bag.ts';
import type { ItemDefinition, ItemInstance } from '../../domain/items.ts';
import type { MenuPanels } from '../../domain/menu-panels.ts';
import { bagLayout } from '../bag-layout.ts';
import { SIDE_BUTTON_OFFSETS, SLOT, SLOT_STRIDE } from '../item-layout.ts';
import { ENHANCEMENT_ODDS_ROW_STRIDE, ENHANCEMENT_ODDS_ROW_TOP, ENHANCEMENT_ODDS_TOP, enhancementOddsView, type EnhancementOutcomeTone } from '../enhancement-odds-lines.ts';
import { drawNativeMessage } from './native-message.ts';
import type { UiSurface, ScrollArea } from './widgets.ts';

export type ForgeTab='enchant'|'socket'|'purify';
type Confirmation={kind:'unsocket';index:number}|{kind:'swap';index:number;gem:string};
const OUTCOME_COLORS:Record<EnhancementOutcomeTone,string>={loss:'#ff6b6b',single:'#c8b78f',double:'#ffd75e'};

/**
 * 装备强化台：和合成台同级的菜单页。
 *
 * 左框是装备摘要和当前选中项的详情，右框复用背包的四列格子；所有结算都走 `Bag` 的
 * 领域方法。页面本身不铺黑色遮罩，确认框才借用 `modal` 画一条原版提示横带。
 */
export class ForgePanel {
  readonly bag:Bag;readonly panels:MenuPanels;readonly stats:CharacterStatsCatalog;readonly memberId:string;
  private readonly changed:()=>void;private readonly sound:()=>void;private readonly notify:(message:string)=>void;
  private readonly preview:(targetId:string,gemModifiers:Modifier[])=>CharacterPanel|undefined;
  targetId?:string;tab:ForgeTab='enchant';
  private selectedItem?:string;private socketIndex?:number;private replaceIndex?:number;
  private offset=0;private leftOffset=0;
  private confirmation?:Confirmation;private scroll?:ScrollArea;private leftScroll?:ScrollArea;
  constructor(bag:Bag,panels:MenuPanels,stats:CharacterStatsCatalog,memberId:string,
    changed:()=>void,sound:()=>void,notify:(message:string)=>void,
    preview:(targetId:string,gemModifiers:Modifier[])=>CharacterPanel|undefined){
    this.bag=bag;this.panels=panels;this.stats=stats;this.memberId=memberId;
    this.changed=changed;this.sound=sound;this.notify=notify;this.preview=preview;
  }
  get modalOpen():boolean{return !!this.confirmation;}
  get confirming():boolean{return !!this.confirmation;}
  open(targetId:string,tab:ForgeTab='enchant'):void {
    this.targetId=targetId;this.tab=tab;
    this.selectedItem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;
    this.offset=0;this.leftOffset=0;this.confirmation=undefined;this.scroll=undefined;this.leftScroll=undefined;
  }
  captureScroll():void {
    this.offset=this.scroll?.scrollTop??this.offset;
    this.leftOffset=this.leftScroll?.scrollTop??this.leftOffset;
  }
  cancelConfirmation():void {this.confirmation=undefined;this.changed();}
  render(v:UiSurface,modal:UiSurface,placeModal:(width:number,height:number)=>void):void {
    const assets=this.panels.assets;
    v.border(assets,10,0,462,431);v.border(assets,496,0,395,431);
    this.scroll=undefined;this.leftScroll=undefined;
    // 左框内容可能随强化概率、宝石孔和属性条数变长，统一放进可滚动区。
    const left=v.scroll(0,0,458,431);this.leftScroll=left;
    const target=this.targetId?this.bag.get(this.targetId):undefined,item=target?this.bag.catalog.items[target.item]:undefined;
    if(!target||!item?.equipment){
      v.text('装备已不存在，点右上角关闭返回背包。',40,160,400,24,'#e2cb9e',left.content);
      left.setHeight(431);return;
    }
    this.validateState(target);
    const summaryBottom=this.renderSummary(v,target,item,left);
    this.renderTabs(v);
    this.renderGrid(v,target);
    const detailsBottom=this.renderDetails(v,target,item,left);
    left.setHeight(Math.max(431,summaryBottom,detailsBottom));
    left.scrollTop=this.leftOffset;
    left.onScroll=()=>{this.leftOffset=left.scrollTop;};
    if(this.confirmation)this.renderConfirmation(modal,placeModal);
  }
  private renderTabs(v:UiSurface):void {
    const assets=this.panels.assets;
    ([['enchant','强化'],['socket','镶嵌'],['purify','净化']] as const).forEach(([tab,label],index)=>{
      const button=v.button('',885,12+SIDE_BUTTON_OFFSETS[index]!,57,57,()=>this.setTab(tab),{bare:true}).setData('label',label);
      v.image(assets['page-button-frame'],-5,-12,undefined,undefined,button);
      if(this.tab===tab)v.image(assets['page-button-selected'],-5,-12,undefined,undefined,button);
      v.text(label,28.5,28.5,51,19,undefined,button).setOrigin(.5);
    });
  }
  private setTab(tab:ForgeTab):void {
    if(this.tab===tab)return;
    this.tab=tab;this.selectedItem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;
    this.offset=0;this.leftOffset=0;this.scroll=undefined;this.leftScroll=undefined;this.changed();
  }
  private validateState(target:ItemInstance):void {
    if(this.selectedItem&&!this.bag.get(this.selectedItem))this.selectedItem=undefined;
    const count=target.gems.length;
    if(this.socketIndex!==undefined&&(this.socketIndex<0||this.socketIndex>=count))this.socketIndex=undefined;
    if(this.replaceIndex!==undefined&&(this.replaceIndex<0||this.replaceIndex>=count))this.replaceIndex=undefined;
  }
  private renderSummary(v:UiSurface,target:ItemInstance,item:ItemDefinition,left:ScrollArea):number {
    const numbers=this.stats.equipment[target.item];
    v.image(item.icon,384,36,56,56,left.content);
    v.text(`${item.name}${target.enhancement?` +${target.enhancement}`:''}`,40,36,320,22,'#e2cb9e',left.content);
    let y=64;
    const line=(text:string)=>{v.text(text,40,y,320,18,'#c8b78f',left.content);y+=20;};
    line(`等级 ${equipmentLevel(item,target)}`);
    line(`强化耐久度 ${target.numbers?.enhancementUses??0}`);
    line(`宝石孔 ${target.gems.length}/${target.numbers?.sockets??item.equipment!.socketCapacity}`);
    if(numbers){
      const power=equipmentPower(numbers,target);
      if(item.priceKind==='weapon')line(`物理攻击 ${power.attack}　魔法攻击 ${power.magicAttack}`);
      else if(item.priceKind==='armor')line(`防御力 ${power.defense}`);
    }
    line(`混沌属性 ${target.numbers?.chaos?(target.numbers.chaos.tier==='epic-chaos'?'深渊混沌':'混沌'):'无'}`);
    return y;
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
  private renderDetails(v:UiSurface,target:ItemInstance,item:ItemDefinition,left:ScrollArea):number {
    if(this.tab==='enchant')return this.renderEnchantDetails(v,target,item,left);
    if(this.tab==='socket')return this.renderSocketDetails(v,target,item,left);
    return this.renderPurifyDetails(v,target,left);
  }
  private renderEnchantDetails(v:UiSurface,target:ItemInstance,item:ItemDefinition,left:ScrollArea):number {
    if(!item.equipment?.enchantable){v.text('这件装备不能强化。',40,190,400,18,'#ff6b6b',left.content);return 208;}
    const selected=this.selectedItem?this.bag.get(this.selectedItem):undefined;
    if(!selected){
      v.text('选择一张强化卷轴。',40,190,400,18,'#c8b78f',left.content);
      v.button('确定强化',139,342,205,55,()=>{}, {fontSize:20,disabled:true,parent:left.content,guard:left.guard});
      return 397;
    }
    const definition=this.bag.catalog.items[selected.item],problem=this.problemText(selected,target),odds=problem?undefined:this.bag.applicationOdds(selected.id,target.id);
    v.text(definition.name,40,190,400,18,'#e2cb9e',left.content);
    let buttonY=342;
    if(problem)v.text(problem,40,214,400,18,'#ff6b6b',left.content);
    else if(odds){
      const view=enhancementOddsView(odds,target.enhancement,target.numbers?.enhancementUses);
      if(view.sentence)v.text(view.sentence,40,ENHANCEMENT_ODDS_TOP,400,18,'#c8b78f',left.content);
      if(view.current)v.text(view.current,40,ENHANCEMENT_ODDS_TOP,400,18,'#c8b78f',left.content);
      view.rows.forEach((row,index)=>{
        const y=ENHANCEMENT_ODDS_ROW_TOP+index*ENHANCEMENT_ODDS_ROW_STRIDE,color=OUTCOME_COLORS[row.tone];
        v.text(row.result,40,y,360,18,color,left.content);
        v.text(row.chance,440,y,0,18,color,left.content).setOrigin(1,0);
      });
      v.text(view.cost,40,view.costY,400,18,'#c8b78f',left.content);
      // 概率行多时费用会往下走，按钮必须跟着下移，不能压住费用。
      buttonY=Math.max(342,view.costY+28);
    }
    v.button('确定强化',139,buttonY,205,55,()=>this.useScroll(selected.id),{fontSize:20,disabled:!!problem,parent:left.content,guard:left.guard});
    return buttonY+55;
  }
  private renderSocketDetails(v:UiSurface,target:ItemInstance,item:ItemDefinition,left:ScrollArea):number {
    const equipment=item.equipment;
    if(!equipment)return 208;
    if(equipment.locked){v.text('这件装备已锁定，不能镶嵌。',40,190,400,18,'#ff6b6b',left.content);return 208;}
    const sockets=target.numbers?.sockets??equipment.socketCapacity;
    if(sockets<=0){v.text('这件装备没有宝石孔。',40,190,400,18,'#ff6b6b',left.content);return 208;}
    const modifiers=target.numbers?.gemModifiers;
    const valid=!!target.numbers&&!!modifiers&&modifiers.length===target.gems.length;
    const activeIndex=this.socketIndex??this.replaceIndex;
    for(let index=0;index<sockets;index++){
      const x=40+index*60,y=190,filled=index<target.gems.length;
      const button=v.button('',x,y,54,54,()=>{if(!filled)return;this.socketIndex=index;this.replaceIndex=undefined;this.selectedItem=undefined;this.changed();},
        {image:this.panels.assets['inventory-slot'],disabled:!filled,parent:left.content,guard:left.guard}).setData('label',`孔位${index+1}`);
      if(filled){const gemItem=this.bag.catalog.items[target.gems[index]!];if(gemItem)v.image(gemItem.icon,5,5,44,44,button);}
      if(activeIndex===index)v.image(this.panels.assets['inventory-selected'],-5,-5,64,64,button).setData('forge-highlight','socket');
    }
    if(!valid){v.text('宝石数据不完整，无法修改宝石。',40,252,400,18,'#ff6b6b',left.content);return 270;}
    // 每个孔固定占一行，任何时候都能看到已镶宝石带来的属性。
    for(let index=0;index<sockets;index++){
      const y=252+index*22,filled=index<target.gems.length;
      v.text(`孔${index+1}`,40,y,40,18,'#c8b78f',left.content);
      if(!filled){v.text('空',84,y,110,18,'#c8b78f',left.content);continue;}
      const gemItem=this.bag.catalog.items[target.gems[index]!],modifier=modifiers[index];
      v.text(gemItem?.name??'宝石',84,y,110,18,activeIndex===index?'#ffffff':'#e2cb9e',left.content);
      if(modifier)v.text(this.gemEffectText(modifier),198,y,242,18,'#bf0000',left.content);
    }
    const canAdd=target.gems.length<sockets;
    // 孔位越多，属性行越长；提示和操作按钮跟着属性行下移，避免和内容叠在一起。
    const rowsBottom=252+sockets*22;
    const hintY=Math.max(318,rowsBottom+4);
    const actionY=Math.max(342,hintY+24);
    if(this.socketIndex!==undefined){
      const index=this.socketIndex,gemItem=this.bag.catalog.items[target.gems[index]!],modifier=modifiers[index];
      if(!gemItem||!modifier){v.text('宝石数据不完整，无法修改宝石。',40,hintY,400,14,'#ff6b6b',left.content);return hintY+18;}
      const outcome=this.socketOutcome(target.id,modifiers,modifiers.filter((_value,slot)=>slot!==index),'取出后');
      if(outcome)this.socketHint(v,outcome,'#e2cb9e',left,hintY);
      v.button('取出',40,actionY,195,55,()=>{this.confirmation={kind:'unsocket',index};this.changed();},{fontSize:20,parent:left.content,guard:left.guard});
      v.button('替换',245,actionY,195,55,()=>{this.replaceIndex=index;this.socketIndex=undefined;this.selectedItem=undefined;this.changed();},{fontSize:20,parent:left.content,guard:left.guard});
      return actionY+55;
    }
    if(!canAdd&&this.replaceIndex===undefined)this.socketHint(v,'宝石孔已满','#ff6b6b',left,hintY);
    else if(this.replaceIndex!==undefined&&!this.selectedItem)this.socketHint(v,'从右侧选择要替换的宝石','#c8b78f',left,hintY);
    else if(!this.selectedItem)this.socketHint(v,'从右侧选择一颗宝石','#c8b78f',left,hintY);
    if(this.selectedItem){
      const gem=this.bag.get(this.selectedItem),definition=gem?this.bag.catalog.items[gem.item]:undefined,modifier=gem?.numbers?.modifiers?.[0];
      if(!gem||!definition||!modifier){v.text('宝石数据不完整。',40,hintY,400,14,'#ff6b6b',left.content);return hintY+18;}
      if(this.replaceIndex!==undefined){
        const index=this.replaceIndex,oldName=this.bag.catalog.items[target.gems[index]!]?.name??`孔${index+1}`;
        v.text(`替换 孔${index+1} ${oldName} → ${definition.name}`,504,360,355,18,'#e2cb9e');
        const outcome=this.socketOutcome(target.id,modifiers,modifiers.map((value,slot)=>slot===index?{...modifier}:value),'替换后');
        if(outcome)v.text(outcome,504,384,355,18,'#e2cb9e');
      }else{
        v.text(`待镶 ${definition.name} · ${this.gemEffectText(modifier)}`,504,360,355,18,'#e2cb9e');
        const worn=Object.values(this.bag.equipmentFor(this.memberId)).includes(target.id);
        const outcome=this.socketOutcome(target.id,modifiers,[...modifiers,{...modifier}],worn?'镶嵌后':'装备后');
        if(outcome)v.text(outcome,504,384,355,18,'#e2cb9e');
      }
    }
    v.button(this.replaceIndex===undefined?'确认镶嵌':'确认替换',139,actionY,205,55,()=>this.confirmSocket(),{fontSize:20,
      disabled:!this.selectedItem||!this.bag.get(this.selectedItem)?.numbers?.modifiers?.length||(!canAdd&&this.replaceIndex===undefined),
      parent:left.content,guard:left.guard});
    return actionY+55;
  }

  /** 左栏只留一句状态或结果，放在孔位效果列表下面。 */
  private socketHint(v:UiSurface,text:string,color:string,left:ScrollArea,y:number):void {
    v.text(text,40,y,400,14,color,left.content);
  }

  /** 宝石词条的短写法：`暴击率 +2.5%`，用于孔位效果列表和镶嵌预览。 */
  private gemEffectText(modifier:Modifier):string {
    const descriptor=this.stats.modifiers[modifier.stat];
    const value=descriptor?.percent?`${(modifier.value/10).toFixed(1)}%`:`${modifier.value}`;
    return `${descriptor?.label??modifier.stat} ${modifier.value>=0?'+':''}${value}`;
  }

  /** 把一组宝石词条换成角色面板差值；目标未穿戴且没有空槽时不显示。 */
  private socketOutcome(targetId:string,current:Modifier[],next:Modifier[],label:string):string|undefined {
    const before=this.preview(targetId,current.map(value=>({...value})));
    const after=this.preview(targetId,next.map(value=>({...value})));
    if(!before||!after)return undefined;
    const diff=this.panelDiff(before,after);
    return `${label} ${diff.length?diff.slice(0,2).join('　'):'角色面板无变化'}`;
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
  private renderPurifyDetails(v:UiSurface,target:ItemInstance,left:ScrollArea):number {
    if(!target.numbers?.chaos){v.text('这件装备没有混沌属性。',40,190,400,18,'#ff6b6b',left.content);return 208;}
    const selected=this.selectedItem?this.bag.get(this.selectedItem):undefined;
    if(!selected){
      v.text('选择净化之宝石。',40,190,400,18,'#c8b78f',left.content);
      v.button('确定净化',139,342,205,55,()=>{}, {fontSize:20,disabled:true,parent:left.content,guard:left.guard});
      return 397;
    }
    const definition=this.bag.catalog.items[selected.item];
    v.text(definition.name,40,190,400,18,'#e2cb9e',left.content);
    v.text('净化后清除混沌属性，保留强化、耐久和宝石。',40,214,400,18,'#c8b78f',left.content);
    v.button('确定净化',139,342,205,55,()=>this.usePurify(selected.id),{fontSize:20,parent:left.content,guard:left.guard});
    return 397;
  }
  private useScroll(sourceId:string):void {
    const targetId=this.targetId;if(!targetId)return;
    try {this.bag.use(sourceId,targetId);this.sound();}
    catch(error) {this.notify(this.errorText(error));}
    this.changed();
  }
  private confirmSocket():void {
    const targetId=this.targetId,gemId=this.selectedItem;if(!targetId||!gemId)return;
    if(!this.bag.get(gemId)?.numbers?.modifiers?.length)return;
    const replacing=this.replaceIndex,target=this.bag.get(targetId),definition=target?this.bag.catalog.items[target.item]:undefined;
    if(replacing===undefined&&target&&definition?.equipment&&target.gems.length>=(target.numbers?.sockets??definition.equipment.socketCapacity))return;
    if(replacing!==undefined){this.confirmation={kind:'swap',index:replacing,gem:gemId};this.changed();return;}
    try {this.bag.use(gemId,targetId);this.sound();}
    catch(error) {this.notify(this.errorText(error));}
    this.selectedItem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;
    this.changed();
  }
  private usePurify(sourceId:string):void {
    const targetId=this.targetId;if(!targetId)return;
    try {this.bag.use(sourceId,targetId);this.sound();}
    catch(error){this.notify(this.errorText(error));}
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
      if(confirmation.kind==='unsocket')this.bag.unsocket(targetId,confirmation.index);
      else this.bag.swapGem(targetId,confirmation.index,confirmation.gem);
      this.selectedItem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;this.sound();
    } catch(error) {
      this.notify(this.errorText(error));
    }
    this.changed();
  }
  private errorText(error:unknown):string {
    if(error instanceof ItemApplicationError)return this.panels.itemMessages[error.notice]??error.message;
    return error instanceof Error?error.message:String(error);
  }
}
