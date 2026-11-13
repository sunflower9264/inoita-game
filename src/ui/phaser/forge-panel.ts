import { drawBagRail, drawBagRailSelection } from './bag-rail.ts';
import { equipmentPower, type CharacterPanel, type CharacterStatsCatalog, type Modifier } from '../../domain/character-stats.ts';
import { equipmentLevel } from '../../domain/chaos-equipment.ts';
import { ItemApplicationError } from '../../domain/item-application.ts';
import type { Bag } from '../../domain/bag.ts';
import type { ItemDefinition, ItemInstance } from '../../domain/items.ts';
import type { MenuPanels } from '../../domain/menu-panels.ts';
import { bagLayout } from '../bag-layout.ts';
import { TEXT_COLORS } from '../text-style.ts';
import { SLOT, SLOT_STRIDE } from '../item-layout.ts';
import { ENHANCEMENT_ODDS_ROW_STRIDE, ENHANCEMENT_ODDS_ROW_TOP, ENHANCEMENT_ODDS_TOP, enhancementOddsView, type EnhancementOutcomeTone } from '../enhancement-odds-lines.ts';
import { drawNativeMessage, type NativeMessageBand } from './native-message.ts';
import { MENU_CANVAS_HEIGHT, MENU_CANVAS_WIDTH } from './modal-placement.ts';
import type { UiSurface, ScrollArea } from './widgets.ts';
import { GOLD } from './widgets.ts';
import type { MenuTextSpec, MenuTextWriter } from '../dom/menu-text.ts';

/** 强化台文字落点：滚动区由宿主登记，刷新只重算 DOM 位置。 */
interface ForgeTextTarget {
  scroll(name:string,x:number,y:number,width:number,height:number,surface?:UiSurface):ScrollArea;
  refresh():void;
}
export type ForgeTab='enchant'|'socket'|'purify';
type Confirmation={kind:'unsocket';index:number}|{kind:'swap';index:number;gem:string};
const OUTCOME_COLORS:Record<EnhancementOutcomeTone,string>={loss:TEXT_COLORS.danger,single:TEXT_COLORS.secondary,double:'#ffd75e'};

/**
 * 装备强化台：和合成台同级的菜单页。
 *
 * 左框是装备摘要和当前选中项的详情，右框复用背包的四列格子；所有结算都走 `Bag` 的
 * 领域方法。页面本身不铺黑色遮罩，确认框才借用 `modal` 画一条原版提示横带。
 */
export class ForgePanel {
  readonly bag:Bag;readonly panels:MenuPanels;readonly stats:CharacterStatsCatalog;
  private readonly changed:()=>void;private readonly sound:()=>void;private readonly notify:(message:string)=>void;
  private readonly preview:(targetId:string,gemModifiers:Modifier[])=>CharacterPanel|undefined;
  targetId?:string;tab:ForgeTab='enchant';
  private selectedItem?:string;private socketIndex?:number;private replaceIndex?:number;
  private offset=0;private leftOffset=0;
  private confirmation?:Confirmation;private scroll?:ScrollArea;private leftScroll?:ScrollArea;
  private pageText:MenuTextSpec[]=[];private modalText:MenuTextSpec[]=[];private band?:NativeMessageBand;
  private text?:ForgeTextTarget;
  /** 左框可滚动区从 (0,0) 开始，正文坐标就是内容坐标。 */
  private static readonly LEFT_CLIP={top:0,bottom:431};
  constructor(bag:Bag,panels:MenuPanels,stats:CharacterStatsCatalog,
    changed:()=>void,sound:()=>void,notify:(message:string)=>void,
    preview:(targetId:string,gemModifiers:Modifier[])=>CharacterPanel|undefined){
    this.bag=bag;this.panels=panels;this.stats=stats;
    this.changed=changed;this.sound=sound;this.notify=notify;this.preview=preview;
  }
  get confirming():boolean{return !!this.confirmation;}
  /** 原生提示横带在弹层本地坐标里的上下边界；页面文字按它让位。 */
  get messageBand():NativeMessageBand|undefined{return this.band;}
  /** 强化台自己的显式状态，供页面签名使用。 */
  get viewModel():{targetId?:string;tab:ForgeTab;confirming:boolean}{return {targetId:this.targetId,tab:this.tab,confirming:this.confirming};}
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
  private addText(key:string,text:string,x:number,y:number,size:number,color?:string,anchorX=0,anchorY=0,
    style:Partial<MenuTextSpec['style']>={},extras:Pick<MenuTextSpec,'scroll'|'clip'>=ForgePanel.LEFT_EXTRAS):void {
    this.pageText.push({key,text,x,y,style:{size,color,anchorX,anchorY,...style},...extras});
  }
  private addGridText(key:string,text:string,x:number,y:number,size:number,color?:string,anchorX=0,anchorY=0,
    style:Partial<MenuTextSpec['style']>={}):void {
    this.addText(key,text,x,y,size,color,anchorX,anchorY,style,{scroll:'forge-grid',clip:this.gridClip});
  }
  private buttonText(key:string,label:string,x:number,y:number,width:number,height:number,size=Math.min(22,height*.42)):void {
    this.addText(key,label,x+width/2,y+height/2,size,GOLD,.5,.5);
  }
  /** 右栏格子的滚动视口；每次画格子前更新。 */
  private gridClip={top:0,bottom:0};
  private static readonly LEFT_EXTRAS={scroll:'forge-left',clip:ForgePanel.LEFT_CLIP} as const;
  private scrollAt(name:string,x:number,y:number,width:number,height:number):ScrollArea {
    return this.text?.scroll(name,x,y,width,height)??this.surface!.scroll(x,y,width,height);
  }
  private surface?:UiSurface;
  renderText(writer:MenuTextWriter):void {for(const spec of this.pageText)writer.add(spec);}
  renderModalText(writer:MenuTextWriter):void {for(const spec of this.modalText)writer.add(spec);}
  render(v:UiSurface,modal:UiSurface,placeModal:(width:number,height:number)=>void,text?:ForgeTextTarget):void {
    this.pageText=[];this.modalText=[];this.band=undefined;this.text=text;this.surface=v;
    const assets=this.panels.assets;
    v.staticLayer('forge',()=>{
      v.border(assets,10,0,462,431,v.staticRoot);
      drawBagRail(v,assets,496,v.staticRoot);
    });
    this.scroll=undefined;this.leftScroll=undefined;
    // 左框内容可能随强化概率、宝石孔和属性条数变长，统一放进可滚动区。
    const left=this.scrollAt('forge-left',0,0,458,431);this.leftScroll=left;
    left.onScroll=()=>this.text?.refresh();
    const target=this.targetId?this.bag.get(this.targetId):undefined,item=target?this.bag.catalog.items[target.item]:undefined;
    if(!target||!item?.equipment){
      this.addText('forge-missing','装备已不存在，点右上角关闭返回背包。',40,160,24,TEXT_COLORS.primary);
      left.setHeight(431);return;
    }
    this.validateState(target);
    const summaryBottom=this.renderSummary(v,target,item,left);
    this.renderTabs(v);
    this.renderGrid(v,target);
    const detailsBottom=this.renderDetails(v,target,item,left);
    left.setHeight(Math.max(431,summaryBottom,detailsBottom));
    left.scrollTop=this.leftOffset;
    left.onScroll=()=>{this.leftOffset=left.scrollTop;this.text?.refresh();};
    if(this.confirmation)this.renderConfirmation(modal,placeModal);
  }
  private renderTabs(v:UiSurface):void {
    const side=bagLayout().sideButtons;
    ([['enchant','强化'],['socket','镶嵌'],['purify','净化']] as const).forEach(([tab,label],index)=>{
      const y=side.y+side.offsets[index]!;
      if(this.tab===tab)drawBagRailSelection(v,side.x,y,side.width,side.height);
      v.button('',side.x,y,side.width,side.height,()=>this.setTab(tab),{bare:true}).setData('label',label);
      this.addText(`forge-tab-${tab}`,label,side.x+side.width/2,y+side.height/2,19,GOLD,.5,.5,
        {width:side.width-6,align:'center',wrap:'word'},{});
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
    this.addText('forge-summary-name',`${item.name}${target.enhancement?` +${target.enhancement}`:''}`,40,36,22,TEXT_COLORS.primary,0,0,
      {width:320,wrap:'word'});
    let y=64,lineIndex=0;
    const line=(text:string)=>{this.addText(`forge-summary-line-${lineIndex++}`,text,40,y,18,TEXT_COLORS.secondary,0,0,
      {width:320,wrap:'word'});y+=20;};
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
      this.addText('forge-grid-empty',message,681,180,20,TEXT_COLORS.secondary,.5,0,{},{});
      return;
    }
    const layout=bagLayout(),grid=layout.grid;
    // 右栏底部不再写宝石预览：网格一直排到框底边框内沿（431 − 24），多露一行格子且不被边框压住。
    const scroll=this.scrollAt('forge-grid',grid.x,grid.y,grid.width,431-24-grid.y);this.scroll=scroll;
    this.gridClip={top:grid.y,bottom:grid.y+scroll.height};
    scroll.onScroll=()=>this.text?.refresh();
    entries.forEach((entry,index)=>{
      const definition=this.bag.catalog.items[entry.item];
      const x=index%grid.columns*SLOT_STRIDE,y=Math.floor(index/grid.columns)*SLOT_STRIDE;
      const problem=this.tab==='enchant'?this.problemText(entry,target):undefined;
      const broken=this.tab==='socket'&&!entry.numbers?.modifiers?.length;
      const chaos=this.tab==='enchant'&&!!definition.use?.requiresEnhanced&&(target.numbers?.enhancementUses??0)===0&&!problem;
      const selected=this.selectedItem===entry.id;
      const button=v.button('',x,y,SLOT.size,SLOT.size,()=>this.selectGridEntry(entry),{image:assets['inventory-slot'],parent:scroll.content,guard:scroll.guard})
        .setData('label',this.gridLabel(entry));
      v.image(definition.icon,SLOT.icon.x,SLOT.icon.y,SLOT.icon.size,SLOT.icon.size,button);
      if(definition.stackable)this.addGridText(`forge-grid-badge-${index}`,String(entry.quantity),
        grid.x+x+layout.badge.x,grid.y+y+layout.badge.y,20,layout.badge.color,1,0);
      if(selected||chaos)v.image(assets['inventory-selected'],SLOT.selection.x,SLOT.selection.y,SLOT.selection.size,SLOT.selection.size,button)
        .setData('forge-highlight',chaos?'chaos':'selected');
      if(problem||broken)button.setAlpha(.45);
    });
    scroll.setHeight(Math.ceil(entries.length/grid.columns)*SLOT_STRIDE);scroll.scrollTop=this.offset;
    scroll.onScroll=()=>{this.offset=scroll.scrollTop;this.text?.refresh();};
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
    if(!item.equipment?.enchantable){this.addText('forge-enchant-unavailable','这件装备不能强化。',40,190,18,TEXT_COLORS.danger,0,0,{width:400,wrap:'word'});return 208;}
    const selected=this.selectedItem?this.bag.get(this.selectedItem):undefined;
    if(!selected){
      this.addText('forge-enchant-empty','选择一张强化卷轴。',40,190,18,TEXT_COLORS.secondary,0,0,{width:400,wrap:'word'});
      v.button('',139,342,205,55,()=>{}, {fontSize:20,disabled:true,parent:left.content,guard:left.guard}).setData('label','确定强化');
      this.buttonText('forge-enchant-confirm','确定强化',139,342,205,55,20);
      return 397;
    }
    const definition=this.bag.catalog.items[selected.item],problem=this.problemText(selected,target),odds=problem?undefined:this.bag.applicationOdds(selected.id,target.id);
    this.addText('forge-enchant-name',definition.name,40,190,18,TEXT_COLORS.primary,0,0,{width:400,wrap:'word'});
    let buttonY=342;
    if(problem)this.addText('forge-enchant-problem',problem,40,214,18,TEXT_COLORS.danger,0,0,{width:400,wrap:'word'});
    else if(odds){
      const view=enhancementOddsView(odds,target.enhancement,target.numbers?.enhancementUses);
      if(view.sentence)this.addText('forge-enchant-sentence',view.sentence,40,ENHANCEMENT_ODDS_TOP,18,TEXT_COLORS.secondary,0,0,{width:400,wrap:'word'});
      if(view.current)this.addText('forge-enchant-current',view.current,40,ENHANCEMENT_ODDS_TOP,18,TEXT_COLORS.secondary,0,0,{width:400,wrap:'word'});
      view.rows.forEach((row,index)=>{
        const y=ENHANCEMENT_ODDS_ROW_TOP+index*ENHANCEMENT_ODDS_ROW_STRIDE,color=OUTCOME_COLORS[row.tone];
        this.addText(`forge-enchant-result-${index}`,row.result,40,y,18,color,0,0,{width:360,wrap:'word'});
        this.addText(`forge-enchant-chance-${index}`,row.chance,440,y,18,color,1,0,{},{scroll:'forge-left',clip:ForgePanel.LEFT_CLIP});
      });
      this.addText('forge-enchant-cost',view.cost,40,view.costY,18,TEXT_COLORS.secondary,0,0,{width:400,wrap:'word'});
      // 概率行多时费用会往下走，按钮必须跟着下移，不能压住费用。
      buttonY=Math.max(342,view.costY+28);
    }
    v.button('',139,buttonY,205,55,()=>this.useScroll(selected.id),{fontSize:20,disabled:!!problem,parent:left.content,guard:left.guard}).setData('label','确定强化');
    this.buttonText('forge-enchant-confirm','确定强化',139,buttonY,205,55,20);
    return buttonY+55;
  }
  private renderSocketDetails(v:UiSurface,target:ItemInstance,item:ItemDefinition,left:ScrollArea):number {
    const equipment=item.equipment;
    if(!equipment)return 208;
    if(equipment.locked){this.addText('forge-socket-locked','这件装备已锁定，不能镶嵌。',40,190,18,TEXT_COLORS.danger,0,0,{width:400,wrap:'word'});return 208;}
    const sockets=target.numbers?.sockets??equipment.socketCapacity;
    if(sockets<=0){this.addText('forge-socket-none','这件装备没有宝石孔。',40,190,18,TEXT_COLORS.danger,0,0,{width:400,wrap:'word'});return 208;}
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
    if(!valid){this.addText('forge-socket-invalid','宝石数据不完整，无法修改宝石。',40,252,18,TEXT_COLORS.danger,0,0,{width:400,wrap:'word'});return 270;}
    // 每个孔固定占一行，任何时候都能看到已镶宝石带来的属性。
    for(let index=0;index<sockets;index++){
      const y=252+index*22,filled=index<target.gems.length;
      this.addText(`forge-socket-label-${index}`,`孔${index+1}`,40,y,18,TEXT_COLORS.secondary,0,0,{width:40,wrap:'word'});
      if(!filled){this.addText(`forge-socket-empty-${index}`,'空',84,y,18,TEXT_COLORS.secondary,0,0,{width:110,wrap:'word'});continue;}
      const gemItem=this.bag.catalog.items[target.gems[index]!],modifier=modifiers[index];
      this.addText(`forge-socket-gem-${index}`,gemItem?.name??'宝石',84,y,18,
        activeIndex===index?TEXT_COLORS.white:TEXT_COLORS.primary,0,0,{width:110,wrap:'word'});
      if(modifier)this.addText(`forge-socket-effect-${index}`,this.gemEffectText(modifier),198,y,18,TEXT_COLORS.gemModifier,0,0,
        {width:242,wrap:'word'});
    }
    const canAdd=target.gems.length<sockets;
    // 孔位越多，属性行越长；提示和操作按钮跟着属性行下移，避免和内容叠在一起。
    const rowsBottom=252+sockets*22;
    const hintY=Math.max(318,rowsBottom+4);
    const actionY=Math.max(342,hintY+24);
    if(this.socketIndex!==undefined){
      const index=this.socketIndex,gemItem=this.bag.catalog.items[target.gems[index]!],modifier=modifiers[index];
      if(!gemItem||!modifier){this.addText('forge-socket-invalid-hint','宝石数据不完整，无法修改宝石。',40,hintY,14,TEXT_COLORS.danger,0,0,{width:400,wrap:'word'});return hintY+18;}
      const outcome=this.socketOutcome(target.id,modifiers,modifiers.filter((_value,slot)=>slot!==index),'取出后');
      if(outcome)this.socketHint(outcome,TEXT_COLORS.primary,hintY);
      v.button('',40,actionY,195,55,()=>{this.confirmation={kind:'unsocket',index};this.changed();},{fontSize:20,parent:left.content,guard:left.guard}).setData('label','取出');
      this.buttonText('forge-socket-remove','取出',40,actionY,195,55,20);
      v.button('',245,actionY,195,55,()=>{this.replaceIndex=index;this.socketIndex=undefined;this.selectedItem=undefined;this.changed();},{fontSize:20,parent:left.content,guard:left.guard}).setData('label','替换');
      this.buttonText('forge-socket-replace','替换',245,actionY,195,55,20);
      return actionY+55;
    }
    if(!canAdd&&this.replaceIndex===undefined)this.socketHint('宝石孔已满',TEXT_COLORS.danger,hintY);
    else if(this.replaceIndex!==undefined&&!this.selectedItem)this.socketHint('从右侧选择要替换的宝石',TEXT_COLORS.secondary,hintY);
    else if(!this.selectedItem)this.socketHint('从右侧选择一颗宝石',TEXT_COLORS.secondary,hintY);
    // 宝石名称和效果放回左栏，右栏底部整块留给背包格子。
    let selectionBottom=hintY;
    if(this.selectedItem){
      const gem=this.bag.get(this.selectedItem),definition=gem?this.bag.catalog.items[gem.item]:undefined,modifier=gem?.numbers?.modifiers?.[0];
      if(!gem||!definition||!modifier){this.addText('forge-socket-gem-invalid','宝石数据不完整。',40,hintY,14,TEXT_COLORS.danger,0,0,{width:400,wrap:'word'});return hintY+18;}
      if(this.replaceIndex!==undefined){
        const index=this.replaceIndex,oldName=this.bag.catalog.items[target.gems[index]!]?.name??`孔${index+1}`;
        this.addText('forge-socket-swap-line',`替换 孔${index+1} ${oldName} → ${definition.name}`,40,hintY,14,TEXT_COLORS.primary,0,0,{width:400,wrap:'word'});
        this.addText('forge-socket-swap-effect',this.gemEffectText(modifier),40,hintY+20,14,TEXT_COLORS.gemModifier,0,0,{width:400,wrap:'word'});
        selectionBottom=hintY+40;
      }else{
        this.addText('forge-socket-picked',`${definition.name} · ${this.gemEffectText(modifier)}`,40,hintY,14,TEXT_COLORS.primary,0,0,{width:400,wrap:'word'});
        selectionBottom=hintY+20;
      }
    }
    const buttonY=Math.max(actionY,selectionBottom+4),confirmLabel=this.replaceIndex===undefined?'确认镶嵌':'确认替换';
    v.button('',139,buttonY,205,55,()=>this.confirmSocket(),{fontSize:20,
      disabled:!this.selectedItem||!this.bag.get(this.selectedItem)?.numbers?.modifiers?.length||(!canAdd&&this.replaceIndex===undefined),
      parent:left.content,guard:left.guard}).setData('label',confirmLabel);
    this.buttonText('forge-socket-confirm',confirmLabel,139,buttonY,205,55,20);
    return buttonY+55;
  }

  /** 左栏只留一句状态或结果，放在孔位效果列表下面。 */
  private socketHint(text:string,color:string,y:number):void {
    this.addText('forge-socket-hint',text,40,y,14,color,0,0,{width:400,wrap:'word'});
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
    if(!target.numbers?.chaos){this.addText('forge-purify-none','这件装备没有混沌属性。',40,190,18,TEXT_COLORS.danger,0,0,{width:400,wrap:'word'});return 208;}
    const selected=this.selectedItem?this.bag.get(this.selectedItem):undefined;
    if(!selected){
      this.addText('forge-purify-empty','选择净化之宝石。',40,190,18,TEXT_COLORS.secondary,0,0,{width:400,wrap:'word'});
      v.button('',139,342,205,55,()=>{}, {fontSize:20,disabled:true,parent:left.content,guard:left.guard}).setData('label','确定净化');
      this.buttonText('forge-purify-confirm','确定净化',139,342,205,55,20);
      return 397;
    }
    const definition=this.bag.catalog.items[selected.item];
    this.addText('forge-purify-name',definition.name,40,190,18,TEXT_COLORS.primary,0,0,{width:400,wrap:'word'});
    this.addText('forge-purify-explain','净化后清除混沌属性，保留强化、耐久和宝石。',40,214,18,TEXT_COLORS.secondary,0,0,{width:400,wrap:'word'});
    v.button('',139,342,205,55,()=>this.usePurify(selected.id),{fontSize:20,parent:left.content,guard:left.guard}).setData('label','确定净化');
    this.buttonText('forge-purify-confirm','确定净化',139,342,205,55,20);
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
    placeModal(MENU_CANVAS_WIDTH,MENU_CANVAS_HEIGHT);
    const writer:MenuTextWriter={add:spec=>this.modalText.push(spec)};
    this.band=drawNativeMessage(modal,this.panels.assets,message,()=>this.confirm(),()=>this.cancelConfirmation(),writer,
      this.text?{scroll:(name,x,y,width,height)=>this.text!.scroll(name,x,y,width,height,modal)}:undefined);
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
