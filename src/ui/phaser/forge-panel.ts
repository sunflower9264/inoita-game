import { equipmentPower, type CharacterPanel, type CharacterStatsCatalog, type Modifier } from '../../domain/character-stats.ts';
import { equipmentLevel } from '../../domain/chaos-equipment.ts';
import type { EnhancementOdds } from '../../domain/enhancement.ts';
import { ItemApplicationError } from '../../domain/item-application.ts';
import type { Bag } from '../../domain/bag.ts';
import type { ItemDefinition, ItemInstance } from '../../domain/items.ts';
import type { MenuPanels } from '../../domain/menu-panels.ts';
import { drawNativeMessage } from './native-message.ts';
import type { UiSurface, ScrollArea } from './widgets.ts';

export type ForgeTab='enchant'|'socket'|'purify';
type ResultTone='normal'|'success'|'failure';
type Confirmation={kind:'unsocket';index:number}|{kind:'swap';index:number;gem:string};

/**
 * 装备强化台：从装备说明进入，左栏读装备，右栏在强化/镶嵌/净化三页之间切换。
 *
 * 所有结算都走 `Bag` 的领域方法；这一层只负责展示、确认和连续操作的结果行。
 */
export class ForgePanel {
  readonly bag:Bag;readonly panels:MenuPanels;readonly stats:CharacterStatsCatalog;readonly memberId:string;
  private readonly changed:()=>void;private readonly sound:()=>void;private readonly onClose:()=>void;
  private readonly preview:(targetId:string,gemModifiers:Modifier[])=>CharacterPanel|undefined;
  targetId?:string;tab:ForgeTab='enchant';
  private selectedGem?:string;private socketIndex?:number;private replaceIndex?:number;
  private result?:string;private resultTone:ResultTone='normal';private offset=0;
  private confirmation?:Confirmation;private scroll?:ScrollArea;
  constructor(bag:Bag,panels:MenuPanels,stats:CharacterStatsCatalog,memberId:string,
    changed:()=>void,sound:()=>void,onClose:()=>void,
    preview:(targetId:string,gemModifiers:Modifier[])=>CharacterPanel|undefined){
    this.bag=bag;this.panels=panels;this.stats=stats;this.memberId=memberId;
    this.changed=changed;this.sound=sound;this.onClose=onClose;this.preview=preview;
  }
  get modalOpen():boolean{return !!this.targetId;}
  get confirming():boolean{return !!this.confirmation;}
  open(targetId:string,tab:ForgeTab='enchant'):void {
    this.targetId=targetId;this.tab=tab;
    this.selectedGem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;
    this.result=undefined;this.resultTone='normal';this.offset=0;this.confirmation=undefined;this.scroll=undefined;
  }
  captureScroll():void {this.offset=this.scroll?.scrollTop??this.offset;}
  cancelConfirmation():void {this.confirmation=undefined;this.changed();}
  render(v:UiSurface,placeModal:(width:number,height:number)=>void):void {
    placeModal(1024,640);
    this.scroll=undefined;
    v.rect(0,0,1024,640,0x000000,.72);
    const target=this.targetId?this.bag.get(this.targetId):undefined,item=target?this.bag.catalog.items[target.item]:undefined;
    v.frame(this.panels.assets,32,32,960,576);
    if(!target||!item?.equipment){
      v.text('装备已不存在。',512,300,0,24,'#e2cb9e').setOrigin(.5,0);
      v.button('关闭',462,540,100,40,this.onClose,{fontSize:18});
      return;
    }
    this.validateState(target);
    v.text('装备强化',512,48,0,28,'#e2cb9e').setOrigin(.5,0);
    this.renderSummary(v,target,item);
    if(this.confirmation){this.renderConfirmation(v);return;}
    v.button('关闭',900,48,88,34,this.onClose,{fontSize:18});
    this.renderTabs(v);
    if(this.tab==='enchant')this.renderEnchant(v,target,item);
    else if(this.tab==='socket')this.renderSocket(v,target,item);
    else this.renderPurify(v,target);
  }
  private validateState(target:ItemInstance):void {
    if(this.selectedGem&&!this.bag.get(this.selectedGem))this.selectedGem=undefined;
    const count=target.gems.length;
    if(this.socketIndex!==undefined&&(this.socketIndex<0||this.socketIndex>=count))this.socketIndex=undefined;
    if(this.replaceIndex!==undefined&&(this.replaceIndex<0||this.replaceIndex>=count))this.replaceIndex=undefined;
  }
  private renderSummary(v:UiSurface,target:ItemInstance,item:ItemDefinition):void {
    const assets=this.panels.assets,numbers=this.stats.equipment[target.item];
    v.rect(64,100,360,440,0x000000,.55);v.border(assets,64,100,360,440);
    v.image(item.icon,84,120,64,64);
    v.text(`${item.name}${target.enhancement?` +${target.enhancement}`:''}`,160,122,240,24,'#e2cb9e');
    let y=200;
    const line=(text:string,color='#e2cb9e')=>{v.text(text,84,y,320,20,color);y+=28;};
    line(`等级 ${equipmentLevel(item,target)}`);
    line(`强化耐久度 ${target.numbers?.enhancementUses??0}`);
    line(`宝石孔 ${target.gems.length}/${target.numbers?.sockets??item.equipment!.socketCapacity}`);
    if(numbers){
      const power=equipmentPower(numbers,target);
      if(item.priceKind==='weapon')line(`物理攻击 ${power.attack}　魔法攻击 ${power.magicAttack}`);
      else if(item.priceKind==='armor')line(`防御力 ${power.defense}`);
    }
    line(`混沌属性 ${target.numbers?.chaos?(target.numbers.chaos.tier==='epic-chaos'?'深渊混沌':'混沌'):'无'}`);
    const color=this.resultTone==='success'?'#ffd75e':this.resultTone==='failure'?'#ff6b6b':'#e2cb9e';
    v.text(this.result??'',84,480,320,20,color);
  }
  private renderTabs(v:UiSurface):void {
    ([['enchant','强化'],['socket','镶嵌'],['purify','净化']] as const).forEach(([tab,label],index)=>{
      v.button(label,456+index*126,104,120,34,()=>this.setTab(tab),{selected:this.tab===tab,fontSize:18});
    });
  }
  private setTab(tab:ForgeTab):void {
    if(this.tab===tab)return;
    this.tab=tab;this.selectedGem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;
    this.offset=0;this.scroll=undefined;this.changed();
  }
  private problemText(source:ItemInstance,target:ItemInstance):string|undefined {
    if(!this.bag.canApply(source.id,target.id))return this.panels.itemMessages['socket-incompatible']??'该道具不适合。';
    const notice=this.bag.applicationProblem(source.id,target.id);
    return notice?this.panels.itemMessages[notice]??notice:undefined;
  }
  private enchantRank(entry:ItemInstance,target:ItemInstance):number {
    if(this.problemText(entry,target)!==undefined)return 10000;
    const use=this.bag.catalog.items[entry.item].use;
    if(!use)return 9999;
    if(use.requiresEnhanced&&(target.numbers?.enhancementUses??0)===0)return -1;
    return use.maxLevel||500;
  }
  private renderEnchant(v:UiSurface,target:ItemInstance,item:ItemDefinition):void {
    if(!item.equipment?.enchantable){v.text('这件装备不能强化。',692,200,0,20,'#e2cb9e').setOrigin(.5,0);return;}
    const rows=this.bag.entries.filter(entry=>this.bag.catalog.items[entry.item].use?.kind==='enchant');
    if(!rows.length){v.text('背包里没有强化卷轴。',692,200,0,20,'#e2cb9e').setOrigin(.5,0);return;}
    const sorted=[...rows].sort((left,right)=>this.enchantRank(left,target)-this.enchantRank(right,target)||left.item.localeCompare(right.item));
    const scroll=v.scroll(472,150,472,330);this.scroll=scroll;
    const rowHeight=68;
    sorted.forEach((entry,index)=>{
      const problem=this.problemText(entry,target),odds=problem?undefined:this.bag.applicationOdds(entry.id,target.id);
      const chaos=!!this.bag.catalog.items[entry.item].use?.requiresEnhanced;
      const highlight=!problem&&chaos&&(target.numbers?.enhancementUses??0)===0;
      const y=index*rowHeight;
      if(highlight)v.rect(0,y,464,rowHeight-4,0x8b6b2f,.28,scroll.content).setData('forge-highlight','chaos');
      const row=v.button('',0,y,464,rowHeight-4,()=>{if(!problem)this.useScroll(entry.id);},{bare:true,parent:scroll.content,guard:scroll.guard,disabled:!!problem})
        .setData('label',`卷轴:${this.bag.catalog.items[entry.item].name}`);
      v.image(this.bag.catalog.items[entry.item].icon,6,6,40,40,row);
      const color=problem?'#8a7a62':'#e2cb9e';
      v.text(this.bag.catalog.items[entry.item].name,54,6,300,18,color,row);
      if(entry.quantity>1)v.text(`× ${entry.quantity}`,410,6,50,16,'#c8b78f',row).setOrigin(1,0);
      v.text(problem??this.oddsText(odds),54,30,390,16,problem?'#8a7a62':'#c8b78f',row);
    });
    scroll.setHeight(sorted.length*rowHeight);scroll.scrollTop=this.offset;scroll.onScroll=()=>{this.offset=scroll.scrollTop;};
  }
  private oddsText(odds:EnhancementOdds|undefined):string {
    if(!odds)return '';
    const percent=(value:number)=>{const p=value*100;return `${p>=10?Math.round(p):Math.round(p*10)/10}%`;};
    return odds.losesLevel
      ?`不降级 ${percent(odds.success)}，降 1 级 ${percent(odds.failure)}；+2 ${percent(odds.double)}`
      :`+1 确定，+2 ${percent(odds.double)}`;
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
  private renderSocket(v:UiSurface,target:ItemInstance,item:ItemDefinition):void {
    const equipment=item.equipment;
    if(!equipment)return;
    if(equipment.locked){v.text('这件装备已锁定，不能镶嵌。',692,200,0,20,'#e2cb9e').setOrigin(.5,0);return;}
    const sockets=target.numbers?.sockets??equipment.socketCapacity;
    if(sockets<=0){v.text('这件装备没有宝石孔。',692,200,0,20,'#e2cb9e').setOrigin(.5,0);return;}
    const modifiers=target.numbers?.gemModifiers;
    if(!target.numbers||!modifiers||modifiers.length!==target.gems.length){
      v.text('宝石数据不完整，无法修改宝石。',692,200,0,20,'#ff6b6b').setOrigin(.5,0);return;
    }
    for(let index=0;index<sockets;index++){
      const x=472+index*76,y=150,filled=index<target.gems.length,next=!filled&&index===target.gems.length;
      const button=v.button('',x,y,64,64,()=>{if(!filled)return;this.socketIndex=index;this.replaceIndex=undefined;this.selectedGem=undefined;this.changed();},
        {image:this.panels.assets['inventory-slot'],disabled:!filled}).setData('label',`孔位${index+1}`);
      if(filled){const gemItem=this.bag.catalog.items[target.gems[index]!];if(gemItem)v.image(gemItem.icon,5,5,54,54,button);}
      if(this.socketIndex===index||next)v.image(this.panels.assets['inventory-selected'],-5,-5,74,74,button).setData('forge-highlight','socket');
    }
    if(this.socketIndex!==undefined&&this.replaceIndex===undefined){
      const index=this.socketIndex,gemItem=this.bag.catalog.items[target.gems[index]!],modifier=modifiers[index];
      if(!gemItem||!modifier){this.socketIndex=undefined;v.text('宝石数据不完整，无法修改宝石。',692,240,0,20,'#ff6b6b').setOrigin(.5,0);return;}
      v.text(`${gemItem.name}：${this.modifierText(modifier)}`,472,240,472,20,'#bf0000');
      v.button('取出',472,274,90,32,()=>{this.confirmation={kind:'unsocket',index};this.changed();},{fontSize:16});
      v.button('替换',572,274,90,32,()=>{this.replaceIndex=index;this.socketIndex=undefined;this.selectedGem=undefined;this.changed();},{fontSize:16});
      return;
    }
    const replacing=this.replaceIndex,canAdd=target.gems.length<sockets;
    if(!canAdd&&replacing===undefined){v.text('宝石孔已满。点已镶嵌的宝石可以取出或替换。',692,250,0,20,'#e2cb9e').setOrigin(.5,0);return;}
    const gems=this.bag.entries.filter(entry=>this.bag.catalog.items[entry.item].use?.kind==='socket');
    if(!gems.length){v.text('背包里没有宝石。',692,250,0,20,'#e2cb9e').setOrigin(.5,0);return;}
    if(replacing!==undefined)v.text(`替换第 ${replacing+1} 孔`,472,240,300,20,'#e2cb9e');
    this.renderGemPreview(v,target,modifiers);
    const scroll=v.scroll(472,330,472,150);this.scroll=scroll;
    const rowHeight=64;
    gems.forEach((entry,index)=>{
      const definition=this.bag.catalog.items[entry.item],modifier=entry.numbers?.modifiers?.[0],y=index*rowHeight;
      if(this.selectedGem===entry.id)v.rect(0,y,464,rowHeight-4,0x8b6b2f,.28,scroll.content).setData('forge-highlight','gem');
      const row=v.button('',0,y,464,rowHeight-4,()=>{if(!modifier)return;this.selectedGem=entry.id;this.socketIndex=undefined;this.changed();},
        {bare:true,parent:scroll.content,guard:scroll.guard,disabled:!modifier}).setData('label',`宝石:${entry.id}`);
      v.image(definition.icon,6,6,40,40,row);
      v.text(definition.name,54,6,250,18,'#e2cb9e',row);
      v.text(modifier?this.modifierText(modifier):'宝石数据不完整',54,30,390,16,modifier?'#bf0000':'#ff6b6b',row);
    });
    scroll.setHeight(gems.length*rowHeight);scroll.scrollTop=this.offset;scroll.onScroll=()=>{this.offset=scroll.scrollTop;};
    if(this.selectedGem)v.button(replacing===undefined?'确认镶嵌':'确认替换',760,500,160,34,()=>this.confirmSocket(),{fontSize:16});
  }
  private renderGemPreview(v:UiSurface,target:ItemInstance,modifiers:Modifier[]):void {
    const gemId=this.selectedGem;if(!gemId)return;
    const gem=this.bag.get(gemId),definition=gem?this.bag.catalog.items[gem.item]:undefined,modifier=gem?.numbers?.modifiers?.[0];
    if(!gem||!definition||!modifier){v.text('宝石数据不完整。',472,240,472,20,'#ff6b6b');return;}
    const current=modifiers.map(value=>({...value}));
    const next=this.replaceIndex===undefined?[...current,{...modifier}]:current.map((value,index)=>index===this.replaceIndex?{...modifier}:value);
    const after=this.preview(target.id,next);
    v.text(`${definition.name}：${this.modifierText(modifier)}`,472,240,472,20,'#bf0000');
    if(!after){v.text('替换装备后生效；当前装备槽位已占用，不做假设面板。',472,268,472,20,'#c8b78f');return;}
    const before=this.preview(target.id,current),diff=before?this.panelDiff(before,after):[];
    const worn=Object.values(this.bag.equipmentFor(this.memberId)).includes(target.id);
    v.text(`${worn?'镶嵌后':'装备后'}：${diff.length?diff.join('　'):'角色面板无变化'}`,472,268,472,20,'#e2cb9e');
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
  private confirmSocket():void {
    const targetId=this.targetId,gemId=this.selectedGem;if(!targetId||!gemId)return;
    const replacing=this.replaceIndex;
    if(replacing!==undefined){this.confirmation={kind:'swap',index:replacing,gem:gemId};this.changed();return;}
    try {const result=this.bag.use(gemId,targetId);this.result=result.message;this.resultTone='normal';this.sound();}
    catch(error) {this.result=this.errorText(error);this.resultTone='failure';}
    this.selectedGem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;
    this.changed();
  }
  private renderPurify(v:UiSurface,target:ItemInstance):void {
    if(!target.numbers?.chaos){v.text('这件装备没有混沌属性。',692,200,0,20,'#e2cb9e').setOrigin(.5,0);return;}
    const stones=this.bag.entries.filter(entry=>this.bag.catalog.items[entry.item].use?.kind==='purify');
    if(!stones.length){v.text('背包里没有净化之宝石。',692,200,0,20,'#e2cb9e').setOrigin(.5,0);return;}
    const scroll=v.scroll(472,150,472,330);this.scroll=scroll;
    const rowHeight=64;
    stones.forEach((entry,index)=>{
      const definition=this.bag.catalog.items[entry.item],y=index*rowHeight;
      const row=v.button('',0,y,464,rowHeight-4,()=>this.usePurify(entry.id),{bare:true,parent:scroll.content,guard:scroll.guard})
        .setData('label',`净化石:${definition.name}`);
      v.image(definition.icon,6,6,40,40,row);
      v.text(definition.name,54,6,250,18,'#e2cb9e',row);
      if(entry.quantity>1)v.text(`× ${entry.quantity}`,410,6,50,16,'#c8b78f',row).setOrigin(1,0);
    });
    scroll.setHeight(stones.length*rowHeight);scroll.scrollTop=this.offset;scroll.onScroll=()=>{this.offset=scroll.scrollTop;};
  }
  private usePurify(sourceId:string):void {
    const targetId=this.targetId;if(!targetId)return;
    try {const result=this.bag.use(sourceId,targetId);this.result=result.message;this.resultTone='normal';this.sound();}
    catch(error){this.result=this.errorText(error);this.resultTone='failure';}
    this.changed();
  }
  private renderConfirmation(v:UiSurface):void {
    const confirmation=this.confirmation;if(!confirmation)return;
    const message=confirmation.kind==='unsocket'
      ?'取出后这颗宝石会回到背包，装备上的这条属性会消失。确定取出？'
      :'替换后旧宝石会回到背包，装备上的属性会改为新宝石。确定替换？';
    drawNativeMessage(v,this.panels.assets,message,()=>this.confirm(),()=>this.cancelConfirmation());
  }
  private confirm():void {
    const confirmation=this.confirmation,targetId=this.targetId;
    if(!confirmation||!targetId)return;
    this.confirmation=undefined;
    try {
      if(confirmation.kind==='unsocket'){const result=this.bag.unsocket(targetId,confirmation.index);this.result=`已取出${result.name}`;}
      else {const result=this.bag.swapGem(targetId,confirmation.index,confirmation.gem);this.result=`已替换宝石，${result.name}已回到背包`;}
      this.resultTone='normal';this.selectedGem=undefined;this.socketIndex=undefined;this.replaceIndex=undefined;this.sound();
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
